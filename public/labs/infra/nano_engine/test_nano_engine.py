# test_nano_engine.py: the engine's bookkeeping, then its outputs against Hugging Face Transformers.
#
#   python -m nano_engine.test_nano_engine      (from the folder that holds nano_engine/; about a minute on a Mac)
#   python -m pytest nano_engine                (the same tests, if you have pytest)
#
# The end-to-end tests run greedy decoding in float32 on the CPU, where the engine must reproduce Hugging Face's
# tokens exactly however it batches, chunks or preempts. On a GPU, test_flash_matches_torch also checks vLLM's
# FlashAttention kernel against the PyTorch reference path.
import math

import torch

from .kv_cache import BlockManager
from .model import AttnMeta, paged_attention_torch
from .scheduler import Scheduler, SchedulerConfig
from .sequence import SamplingParams, Sequence

MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct"
PROMPTS = ["The capital of France is", "def fibonacci(n):", "Once upon a time, in a small village, there lived",
           "The three primary colors are", "Water boils at"]
_cache = {}


def seq(n_prompt: int, **kw) -> Sequence:
    return Sequence("r", list(range(n_prompt)), SamplingParams(**kw))


def test_blocks_are_taken_as_tokens_arrive_and_returned():
    bm = BlockManager(num_blocks=8, block_size=4)
    s = seq(6)
    bm.append(s, 6)
    assert len(s.block_table) == 2 and bm.num_free == 6        # 6 tokens need ceil(6 / 4) = 2 blocks
    s.num_computed = 6
    bm.append(s, 2)
    assert len(s.block_table) == 2                             # positions 6 and 7 still fit in block 2
    s.num_computed = 8
    bm.append(s, 1)
    assert len(s.block_table) == 3                             # position 8 starts block 3
    assert bm.slot(s, 5) == s.block_table[1] * 4 + 1
    bm.free(s)
    assert bm.num_free == 8


def test_copy_on_write():
    bm = BlockManager(num_blocks=8, block_size=4)
    parent, child = seq(6), seq(6)
    bm.append(parent, 6)
    parent.num_computed = child.num_computed = 6
    bm.fork(parent, child)
    assert child.block_table == parent.block_table and bm.ref_count[parent.block_table[1]] == 2
    copies = bm.append(child, 1)                               # position 6 is in the shared, partly full block 2
    assert copies == [(parent.block_table[1], child.block_table[1])]
    assert child.block_table[0] == parent.block_table[0]       # the full block stays shared
    assert bm.ref_count[parent.block_table[1]] == 1 and bm.append(parent, 1) == []   # the parent writes in place


def test_running_first_then_chunked_prefill_within_budget():
    bm = BlockManager(num_blocks=64, block_size=4)
    sch = Scheduler(SchedulerConfig(max_num_batched_tokens=16), bm)
    a = seq(5)
    sch.add(a)
    sch.schedule()
    a.num_computed, a.token_ids = 5, a.token_ids + [99]       # a has its first output token: it now decodes
    b = seq(40)
    sch.add(b)
    batch = sch.schedule()
    assert batch.seqs == [a, b] and batch.num_tokens == [1, 15]   # the decode goes first; b gets the rest
    assert sum(batch.num_tokens) <= 16


def test_preempts_most_recent_and_requeues_it_first():
    bm = BlockManager(num_blocks=4, block_size=4)
    sch = Scheduler(SchedulerConfig(), bm)
    a, b = seq(8), seq(8)
    sch.add(a), sch.add(b)
    sch.schedule()                                             # both prompts fill all 4 blocks
    for s in (a, b):
        s.num_computed, s.token_ids = 8, s.token_ids + [1]
    batch = sch.schedule()                                     # a needs a 5th block: b is preempted
    assert batch.preempted == [b] and batch.seqs == [a]
    assert sch.waiting[0] is b and b.num_computed == 0 and b.block_table == []


def test_paged_attention_matches_dense():
    torch.manual_seed(0)
    bs, kv_heads, heads, dim = 4, 2, 4, 8
    k_cache, v_cache = torch.randn(10, bs, kv_heads, dim), torch.randn(10, bs, kv_heads, dim)
    table = [7, 2, 9]                                          # 10 tokens of context, scattered over three blocks
    n_k, n_q = 10, 3
    q = torch.randn(n_q, heads, dim)
    meta = AttnMeta(None, None, torch.tensor([n_k]), torch.tensor([table]), n_q, n_k, [n_q], [n_k])
    got = paged_attention_torch(q, k_cache, v_cache, meta, dim ** -0.5)
    k = k_cache[table].flatten(0, 1)[:n_k].repeat_interleave(heads // kv_heads, 1)
    v = v_cache[table].flatten(0, 1)[:n_k].repeat_interleave(heads // kv_heads, 1)
    scores = torch.einsum("qhd,khd->hqk", q, k) * dim ** -0.5
    causal = torch.arange(n_k)[None, :] > torch.arange(n_k - n_q, n_k)[:, None]
    want = torch.einsum("hqk,khd->qhd", scores.masked_fill(causal, -math.inf).softmax(-1), v)
    assert torch.allclose(got, want, atol=1e-5)


def reference() -> tuple[list[list[int]], list[list[int]]]:
    """Prompt token ids and Hugging Face's greedy continuations, one prompt at a time."""
    if "ref" not in _cache:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        tok = AutoTokenizer.from_pretrained(MODEL)
        hf = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32).eval()
        ids = [tok.encode(p) for p in PROMPTS]
        outs = [hf.generate(torch.tensor([p]), max_new_tokens=24, do_sample=False)[0, len(p):].tolist() for p in ids]
        _cache["ref"] = ids, outs
    return _cache["ref"]


def run_engine(**kw):
    from .engine import LLM
    ids, _ = reference()
    llm = LLM(MODEL, device="cpu", **{"max_model_len": 512, **kw})
    out = llm.generate(ids, SamplingParams(temperature=0, max_tokens=24, ignore_eos=True))
    return out, llm.engine.stats


def test_matches_huggingface_batched():
    out, _ = run_engine(kv_cache_gib=0.1)
    assert [o[0] for o in out] == reference()[1]


def test_matches_huggingface_with_chunked_prefill():
    out, stats = run_engine(kv_cache_gib=0.1, max_num_batched_tokens=8)   # prompts of 5 to 11 tokens: chunked
    assert [o[0] for o in out] == reference()[1]


def test_matches_huggingface_under_preemption():
    # 10 blocks of 4 tokens hold 40 tokens, but five sequences reach 29 to 35 tokens each: the engine must preempt.
    out, stats = run_engine(num_blocks=10, block_size=4, max_model_len=40)
    assert stats["preemptions"] > 0
    assert [o[0] for o in out] == reference()[1]


def test_parallel_sampling_shares_prompt_blocks():
    from .engine import LLM
    ids, want = reference()
    llm = LLM(MODEL, device="cpu", kv_cache_gib=0.1, block_size=4, max_model_len=512)
    out = llm.generate(ids[:1], SamplingParams(temperature=0, max_tokens=24, ignore_eos=True, n=3))
    assert out[0] == [want[0]] * 3                             # greedy, so all three completions agree
    # The 5-token prompt fills block 1 and one slot of block 2; the two forks copy block 2 when they write to it.
    assert llm.engine.stats["cow_copies"] == 2


def test_flash_matches_torch():
    if not torch.cuda.is_available():
        return
    from .engine import LLM
    from .model import paged_attention_flash
    ids, _ = reference()
    llm = LLM(MODEL, device="cuda", num_blocks=256, max_num_batched_tokens=8, max_model_len=512)   # BF16; steps mix chunks and decodes
    errors = []

    def both(q, k_cache, v_cache, meta, scale):
        flash = paged_attention_flash(q, k_cache, v_cache, meta, scale)
        ref = paged_attention_torch(q, k_cache, v_cache, meta, scale)
        errors.append(((flash - ref).abs().max() / ref.abs().max()).item())
        return flash

    llm.engine.model.attend = both
    llm.generate(ids, SamplingParams(temperature=0, max_tokens=24, ignore_eos=True))
    print(f"    FlashAttention against the PyTorch path: largest relative difference {max(errors):.1e}")
    assert max(errors) < 2e-2                                  # BF16 rounding, not a wrong block or mask


if __name__ == "__main__":
    import sys
    tests = [(name, fn) for name, fn in globals().items() if name.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"ok  {name}", flush=True)
    print(f"{len(tests)} tests passed")
    sys.exit(0)
