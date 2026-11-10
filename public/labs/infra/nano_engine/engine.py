# engine.py: the engine loop. Each call to step() schedules a batch, builds the flat inputs for it, runs the model
# once, samples a token for every sequence that has reached the end of its known tokens, and finishes sequences that
# hit a stop condition. LLM.generate() is the offline interface; server.py drives the same loop for HTTP clients.
import os
import time
from dataclasses import dataclass, field

# The KV cache leaves little GPU memory free, and the step's activations change shape every step. PyTorch's default
# caching allocator then fragments what is left until an allocation fails, frees its whole cache and retries (once
# in the H100 benchmark). Expandable segments let it grow and reuse memory without fragmenting. PyTorch reads the
# setting when CUDA first allocates, so a program that uses CUDA before importing nano_engine must set it itself.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import torch  # noqa: E402

from .kv_cache import BlockManager
from .model import AttnMeta, load
from .scheduler import Batch, Scheduler, SchedulerConfig
from .sequence import SamplingParams, Sequence, Status


@dataclass
class EngineConfig:
    model: str = "HuggingFaceTB/SmolLM2-135M-Instruct"
    device: str = "cuda" if torch.cuda.is_available() else "cpu"
    dtype: str = "auto"                   # bfloat16 on CUDA, float32 elsewhere
    attention: str = "auto"               # "flash" (vLLM's FlashAttention, CUDA only) or "torch"
    block_size: int = 16                  # tokens per KV block
    num_blocks: int | None = None         # KV blocks; None: fill gpu_memory_utilization of the GPU, or kv_cache_gib
    kv_cache_gib: float = 1.0             # KV cache size when not on CUDA
    gpu_memory_utilization: float = 0.9
    max_model_len: int = 4096
    scheduler: SchedulerConfig = field(default_factory=SchedulerConfig)
    seed: int = 0


@dataclass
class StepOutput:
    seq: Sequence
    new_token_ids: list[int]
    finished: bool


class LLMEngine:
    def __init__(self, config: EngineConfig):
        from transformers import AutoTokenizer

        c = self.config = config
        self.device = torch.device(c.device)
        on_cuda = self.device.type == "cuda"
        self.dtype = {"auto": torch.bfloat16 if on_cuda else torch.float32, "bfloat16": torch.bfloat16,
                      "float16": torch.float16, "float32": torch.float32}[c.dtype]
        attention = c.attention if c.attention != "auto" else ("flash" if on_cuda else "torch")
        self.model, cfg, path = load(c.model, c.device, self.dtype, c.max_model_len, attention)
        self.tokenizer = AutoTokenizer.from_pretrained(path)
        self.eos_ids = set(cfg["eos_token_id"] if isinstance(cfg["eos_token_id"], list) else [cfg["eos_token_id"]])
        if self.tokenizer.eos_token_id is not None:
            self.eos_ids.add(self.tokenizer.eos_token_id)

        # One tensor holds every layer's keys and values: [layers, K or V, blocks, block_size, kv_heads, head_dim].
        m = self.model
        bytes_per_block = m.n_layers * 2 * c.block_size * m.n_kv * m.head_dim * self.dtype.itemsize
        num_blocks = c.num_blocks or self._blocks_that_fit(bytes_per_block)
        self.kv_cache = torch.zeros(m.n_layers, 2, num_blocks, c.block_size, m.n_kv, m.head_dim,
                                    dtype=self.dtype, device=self.device)
        if c.max_model_len > num_blocks * c.block_size:
            raise ValueError(f"{num_blocks} KV blocks hold {num_blocks * c.block_size} tokens, less than "
                             f"max_model_len {c.max_model_len}: one long sequence could never run")
        self.blocks = BlockManager(num_blocks, c.block_size)
        self.scheduler = Scheduler(c.scheduler, self.blocks)
        self.generator = torch.Generator(device=self.device).manual_seed(c.seed)
        self.requests: dict[str, list[Sequence]] = {}
        self.stats = {"steps": 0, "preemptions": 0, "cow_copies": 0, "tokens_run": 0}

    def _blocks_that_fit(self, bytes_per_block: int) -> int:
        """On CUDA, like vLLM: run the largest batch the scheduler allows on dummy inputs, measure the peak memory,
        and give the KV cache what is left of gpu_memory_utilization of the GPU. Elsewhere, a fixed size."""
        if self.device.type != "cuda":
            return int(self.config.kv_cache_gib * 2**30 // bytes_per_block)
        n, bs = self.config.scheduler.max_num_batched_tokens, self.config.block_size
        rows = min(n, self.config.scheduler.max_num_seqs)
        nb = -(-n // bs)
        torch.cuda.reset_peak_memory_stats()
        cache = torch.zeros(self.model.n_layers, 2, nb, bs, self.model.n_kv, self.model.head_dim,
                            dtype=self.dtype, device=self.device)
        i32 = lambda x: torch.as_tensor(x, dtype=torch.int32, device=self.device)
        # One sequence of n tokens: the largest step the scheduler can send, with logits for max_num_seqs rows.
        meta = AttnMeta(torch.arange(n, device=self.device), i32([0, n]), i32([n]), i32(range(nb))[None], n, n, [n], [n])
        tokens = torch.zeros(n, dtype=torch.long, device=self.device)
        positions = torch.arange(n, device=self.device) % self.config.max_model_len   # stay inside the RoPE table
        self.model(tokens, positions, cache, meta, torch.arange(rows, device=self.device))
        peak = torch.cuda.max_memory_allocated()
        del cache
        total = torch.cuda.get_device_properties(self.device).total_memory
        return int((total * self.config.gpu_memory_utilization - peak) // bytes_per_block)

    # ---- requests in, tokens out --------------------------------------------------------------------------------

    def add_request(self, request_id: str, prompt: list[int], params: SamplingParams) -> None:
        if len(prompt) + params.max_tokens > self.config.max_model_len:
            raise ValueError(f"prompt ({len(prompt)}) + max_tokens ({params.max_tokens}) exceeds max_model_len")
        seq = Sequence(request_id, prompt, params)
        self.requests[request_id] = [seq]
        self.scheduler.add(seq)

    def abort(self, request_id: str) -> None:
        for seq in self.requests.pop(request_id, []):
            if seq.status is not Status.FINISHED:
                self.scheduler.finish(seq, "abort")

    def has_work(self) -> bool:
        return self.scheduler.has_work()

    def step(self) -> list[StepOutput]:
        batch = self.scheduler.schedule()
        self.stats["preemptions"] += len(batch.preempted)
        if not batch.seqs:
            return []
        samplers = [s for s, n in zip(batch.seqs, batch.num_tokens) if s.num_computed + n == s.num_tokens]
        logits = self._run(batch, samplers)
        for seq, n in zip(batch.seqs, batch.num_tokens):
            seq.num_computed += n
        outputs = []
        for seq, tokens in zip(samplers, self._sample(logits, samplers)):
            if not seq.forked:                    # first token of an n > 1 request: fork into n sequences
                seq.forked = True
                outputs += [self._append(child, [t]) for child, t in zip(self._fork(seq), tokens[1:])]
            outputs.append(self._append(seq, tokens[:1]))
        self.stats["steps"] += 1
        self.stats["tokens_run"] += sum(batch.num_tokens)
        return outputs

    def _fork(self, parent: Sequence) -> list[Sequence]:
        children = []
        for i in range(1, parent.params.n):
            child = Sequence(parent.request_id, parent.token_ids, parent.params, index=i)
            child.num_prompt_tokens, child.num_computed, child.forked = parent.num_prompt_tokens, parent.num_computed, True
            child.status = Status.RUNNING
            self.blocks.fork(parent, child)        # share every block; copy-on-write later
            self.scheduler.running.append(child)
            self.requests[parent.request_id].append(child)
            children.append(child)
        return children

    def _append(self, seq: Sequence, tokens: list[int]) -> StepOutput:
        seq.token_ids += tokens
        reason = None
        if not seq.params.ignore_eos and tokens[-1] in self.eos_ids:
            reason = "stop"
        elif len(seq.output_ids) >= seq.params.max_tokens:
            reason = "length"
        if reason:
            self.scheduler.finish(seq, reason)
        return StepOutput(seq, tokens, reason is not None)

    # ---- one forward pass ---------------------------------------------------------------------------------------

    def _run(self, batch: Batch, samplers: list[Sequence]) -> torch.Tensor:
        if batch.copies:                           # copy-on-write: duplicate shared blocks before anyone writes
            src, dst = zip(*batch.copies)
            self.kv_cache[:, :, list(dst)] = self.kv_cache[:, :, list(src)]
            self.stats["cow_copies"] += len(batch.copies)
        ids, positions, slots, q_lens, k_lens, logits_rows = [], [], [], [], [], []
        sampling = set(id(s) for s in samplers)
        for seq, n in zip(batch.seqs, batch.num_tokens):
            start = seq.num_computed
            ids += seq.token_ids[start : start + n]
            positions += range(start, start + n)
            slots += [self.blocks.slot(seq, p) for p in range(start, start + n)]
            q_lens.append(n)
            k_lens.append(start + n)
            if id(seq) in sampling:
                logits_rows.append(len(ids) - 1)
        width = max(len(s.block_table) for s in batch.seqs)
        tables = [s.block_table + [0] * (width - len(s.block_table)) for s in batch.seqs]
        dev = self.device
        i32 = lambda x: torch.tensor(x, dtype=torch.int32, device=dev)
        cu = [0]
        for n in q_lens:
            cu.append(cu[-1] + n)
        meta = AttnMeta(torch.tensor(slots, dtype=torch.long, device=dev), i32(cu), i32(k_lens), i32(tables),
                        max(q_lens), max(k_lens), q_lens, k_lens)
        return self.model(torch.tensor(ids, device=dev), torch.tensor(positions, device=dev), self.kv_cache, meta,
                          torch.tensor(logits_rows, dtype=torch.long, device=dev))

    def _sample(self, logits: torch.Tensor, seqs: list[Sequence]) -> list[list[int]]:
        """One token per sequence, or n for a sequence about to fork. Greedy where temperature is 0; otherwise
        temperature, then top-p, then a random draw."""
        if not seqs:
            return []
        draws = max(1 if s.forked else s.params.n for s in seqs)
        temps = [s.params.temperature for s in seqs]
        greedy = logits.argmax(-1, keepdim=True).expand(-1, draws)
        if max(temps) == 0:
            tokens = greedy.tolist()
        else:
            temp = torch.tensor(temps, device=logits.device)[:, None]
            probs = torch.softmax(logits / temp.clamp(min=1e-5), dim=-1)
            if min(s.params.top_p for s in seqs) < 1:                 # sorting the vocabulary is the slow part
                top_p = torch.tensor([s.params.top_p for s in seqs], device=logits.device)[:, None]
                sorted_p, order = probs.sort(dim=-1, descending=True)
                sorted_p[(sorted_p.cumsum(-1) - sorted_p) > top_p] = 0   # keep the smallest set reaching top_p
                drawn = order.gather(-1, torch.multinomial(sorted_p, draws, replacement=True, generator=self.generator))
            else:
                drawn = torch.multinomial(probs, draws, replacement=True, generator=self.generator)
            tokens = torch.where(temp == 0, greedy, drawn).tolist()
        return [row[: 1 if s.forked else s.params.n] for s, row in zip(seqs, tokens)]


class LLM:
    """Offline batch generation: add every prompt, run steps until all are done."""

    def __init__(self, model: str | None = None, **kwargs):
        sched = {k: kwargs.pop(k) for k in list(kwargs) if k in SchedulerConfig.__dataclass_fields__}
        self.engine = LLMEngine(EngineConfig(**({"model": model} if model else {}), **kwargs,
                                             scheduler=SchedulerConfig(**sched)))
        self.tokenizer = self.engine.tokenizer

    def generate(self, prompts: list[list[int]] | list[str], params: SamplingParams | list[SamplingParams],
                 progress: bool = False) -> list[list[list[int]]]:
        """Returns, for each prompt, the output token ids of each of its n completions."""
        params = params if isinstance(params, list) else [params] * len(prompts)
        for i, (p, sp) in enumerate(zip(prompts, params)):
            self.engine.add_request(str(i), self.tokenizer.encode(p) if isinstance(p, str) else p, sp)
        groups = [self.engine.requests[str(i)] for i in range(len(prompts))]   # forks are appended to these lists
        start, done = time.time(), 0
        while self.engine.has_work():
            for out in self.engine.step():
                done += out.finished
            if progress and self.engine.stats["steps"] % 50 == 0:
                print(f"  step {self.engine.stats['steps']}: {done} sequences done, {time.time() - start:.0f} s", flush=True)
        self.engine.requests.clear()
        return [[s.output_ids for s in sorted(g, key=lambda s: s.index)] for g in groups]
