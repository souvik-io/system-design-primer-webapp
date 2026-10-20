# Inference serving engines

A model server can answer one user with a few lines of code: load the weights, call the model, return the text. That design breaks down when many users share the same GPUs. Each token needs one full read of the weights, and every active conversation needs its own memory for past tokens. An inference serving engine decides which requests share each pass over the weights, where each request's memory lives, and how new tokens reach the right user. This chapter covers the mechanisms that the common engines share: vLLM, SGLang, NVIDIA's TensorRT-LLM, Hugging Face's Text Generation Inference (TGI), llama.cpp and Ollama.

The examples use the handbook's running example: a 70B model in BF16 on four H100 GPUs. Each H100 has 80 GB and 3.35 TB/s of memory bandwidth, per [NVIDIA's H100 page](https://www.nvidia.com/en-us/data-center/h100/). At batch size 1, a token needs one read of all 140 GB of weights. Four GPUs read 4 × 3.35 TB/s = 13.4 TB/s, so a token takes at least 140 ÷ 13,400 s ≈ 10.4 ms, which caps one user at about 96 tokens a second. The arithmetic for that token takes about 0.035 ms at peak (140 GFLOP ÷ (4 × 989 TFLOPS)). The 989 figure is the dense BF16 rate, half of the 1,979 that NVIDIA lists with sparsity. Most of each step waits on memory, so the engine's main job is to let one weight read serve more users.

## What a serving engine does

Every engine has five jobs. It accepts requests over HTTP and turns text into tokens. It keeps a queue of waiting requests. At each step, it chooses which requests run and makes sure each has the memory it needs. It runs the model on the chosen tokens, then streams each new token to its user and records timing.

vLLM's developer documentation, as of October 2026, splits this work across processes. An API server takes HTTP requests, tokenizes them and streams output. An engine core hosts the scheduler, oversees the KV cache and coordinates the GPU workers in a continuous loop. Each GPU has one worker process, which loads the weights and runs the forward pass. Other engines use other names. TensorRT-LLM's documentation describes a cache manager that tracks sequences, takes blocks from a pool and returns them when they are no longer needed.

```diagram
title: Inside an engine: three processes and a memory pool
[c:client] Client @ 0,0.5
[api] API server\ntokenize, stream @ 1,0.5
[core] Engine core\nscheduler @ 2,0.5
[kv:store] KV cache\nblock pool @ 2,1.8
[gpu] GPU workers\nrun the model @ 3,0.5
c <-> api : HTTP stream
api <-> core : requests, tokens
core <-> gpu : batch, outputs
core <-> kv : allocate, free
```

In these terms, the scheduler chooses the work for each iteration, which is one pass of the model over a batch (the term the Orca paper uses). The KV cache manager decides where each request's memory lives. The model executor, which in vLLM is the worker processes and their model runners, turns the chosen tokens into outputs.

Most engines copy the shape of OpenAI's HTTP API, so client code written for that API can often point at the new server. After `vllm serve <model>`, vLLM serves `/v1/chat/completions`, `/v1/completions`, `/v1/models` and `/v1/embeddings`, among others. SGLang's documentation says it is compatible with the Hugging Face and OpenAI APIs. llama.cpp's server offers chat, completion, model and embedding routes, but its README makes no strong claim of full OpenAI compatibility. Common calls work. Options and edge cases can differ.

## Batching requests

A decode step reads the same weights for one request or for sixty-four, so batching puts several requests into one step. Engines differ in when a request may join a batch and when it must leave.

### Static batching

The engine runs a batch until every request in it has finished, then starts the next batch. Take four slots and requests that need 12, 2, 6 and 3 output tokens. The batch runs for 12 steps, and the 2-token request sits idle for 10 of them. Newly arrived requests wait in the queue. The Orca paper (OSDI 2022) describes this for request-level scheduling: a request that finishes early "cannot return to the client," and newly arrived requests "have to wait until the current batch completely finishes."

### Dynamic batching

Dynamic batching adds a short wait. The server holds new requests for a few milliseconds so more can join, then sends the batch to the model. NVIDIA's Triton Inference Server calls this its dynamic batcher, and `max_queue_delay_microseconds` caps the wait. The backend usually completes the batch in one execution, so a short request still waits for the longest in its batch. The name is overloaded: llama.cpp's `-cb` flag turns on continuous batching and calls it "dynamic batching."

### Continuous batching

Continuous batching schedules each iteration separately. A request that finishes leaves at once, and the next waiting request takes its slot at the next step. The Orca paper introduced this as iteration-level scheduling, along with selective batching, which batches only a chosen set of operations. For GPT-3 175B, the paper reports 36.9 times the throughput of NVIDIA's FasterTransformer at the same latency, in its own setup. TGI and llama.cpp use the name continuous batching. TensorRT-LLM calls it in-flight batching, and its documentation says sequences in the context phase can run together with sequences in the generation phase.

Run both modes on the same requests and compare how many finish and how busy the slots stay.

```widget
batching-simulator
```

With the simulator's default requests, static batching finishes all 12 in 29 steps, with the slots busy 58% of the time and an average wait of 11.3 steps before a request starts. Continuous batching finishes them in 19 steps, keeps the slots busy 88% of the time, and cuts the average wait to 5.2 steps. The sketch below runs the same rules in 39 lines of Python. It leaves out prefill and memory limits, which the next sections add.

```python
# scheduler_sketch.py: static versus continuous batching, one token per busy slot per step.
# Matches the batching simulator: 4 slots, 12 requests waiting at step 0, prefill left out.
from collections import deque
from dataclasses import dataclass

@dataclass
class Request:
    name: str
    tokens: int          # output tokens still to generate
    start: int = -1      # step at which the request got a slot
    end: int = -1        # step after its last token

def run(requests: list[Request], slots: int, mode: str) -> dict[str, float]:
    queue, active, step, busy = deque(requests), [], 0, 0
    while queue or active:
        # Static batching refills only when the old batch has fully drained.
        if mode == "continuous" or not active:
            while queue and len(active) < slots:
                r = queue.popleft()
                r.start = step
                active.append(r)
        step += 1
        busy += len(active)                 # each active request makes one token
        for r in active:
            r.tokens -= 1
            if r.tokens == 0:
                r.end = step
        active = [r for r in active if r.tokens > 0]
    return {"steps": step, "slots_busy": round(busy / (slots * step), 2),
            "avg_wait": round(sum(r.start for r in requests) / len(requests), 1)}

LENGTHS = [12, 2, 6, 3, 9, 4, 2, 10, 5, 3, 7, 4]    # the simulator's default requests

if __name__ == "__main__":
    for mode in ("static", "continuous"):
        requests = [Request(f"r{i}", n) for i, n in enumerate(LENGTHS)]
        print(mode, run(requests, slots=4, mode=mode))
    # static {'steps': 29, 'slots_busy': 0.58, 'avg_wait': 11.3}
    # continuous {'steps': 19, 'slots_busy': 0.88, 'avg_wait': 5.2}
```

## Managing KV cache memory

Each token of each active conversation stores a key and a value in every layer, as [how LLM inference works](/learn/llm-inference#the-kv-cache) explains. Table 3 of the Llama 3 paper gives the 70B model 80 layers, 8 key/value heads, a model dimension of 8,192 and 64 attention heads. The paper does not list the head dimension. It is 8,192 ÷ 64 = 128. Per token, the cache takes 2 × 80 × 8 × 128 × 2 = 327,680 bytes, about 0.33 MB. Of the four GPUs' 320 GB, about 10% (32 GB) stays free for activations and runtime, and the weights take 140 GB. The remaining 148 GB holds 148 × 10^9 ÷ 327,680 ≈ 450,000 tokens across all requests (451,660 exactly). The budget moves with the memory fraction the engine may use. vLLM's current default for `gpu_memory_utilization` is 0.92, which would leave 4 × 80 × 0.92 − 140 = 154.4 GB. This chapter keeps the running example's 148 GB.

### Why fixed reservations waste memory

Older designs reserve memory for each request up front. The PagedAttention paper (SOSP 2023), which introduced vLLM's design, reports that the systems it studied used only 20.4% to 38.2% of their KV cache memory for actual token states. Those systems "pre-allocate a contiguous chunk of memory with the request's maximum length." Suppose the maximum context is 8,192 tokens. Reserving 8,192 slots per request fits 450,000 ÷ 8,192 = 54.9, so 54 requests. Allocating as tokens arrive, with an average reply of 2,000 tokens, fits about 450,000 ÷ 2,000 = 225 requests, before block rounding. The paper's share describes its own systems, so measure your own.

### Paging

PagedAttention borrows paging from operating systems. The cache is split into fixed-size blocks. Each request has a block table that maps its logical blocks to physical blocks, and it takes a new block only when its last block fills. Blocks return to the pool on finish and need not be adjacent. The paper says vLLM's default block size is 16 tokens, which it calls small enough "to avoid significant internal fragmentation in most workloads." For the 70B model, a 16-token block holds 16 × 327,680 = 5,242,880 bytes, about 5.2 MB, and a request wastes at most 15 slots, about 4.9 MB.

```diagram
title: Paged KV cache: a request's blocks can sit anywhere in the pool
[a:note] Request A\nblocks 9, 7, 5 @ 0,0
[b:note] Request B\nblocks 8, 6 @ 0,1.5
[pool:store] Block pool\n10 blocks @ 2,0.75
a -> pool : 40 tokens
b -> pool : 20 tokens
```

Blocks can also be shared. Parallel sampling and beam search share prompt blocks, and a shared block is copied only when a request must write to it (copy-on-write). In the paper's OPT-13B experiments on the Alpaca trace, sharing saved 6.1% to 9.8% of blocks for parallel sampling and 37.6% to 55.2% for beam search.

The allocator below takes blocks one at a time and returns them on finish.

```python
# paged_kv_sketch.py: KV blocks are taken as tokens arrive and returned when a request finishes.
BLOCK_TOKENS = 16

class BlockPool:
    def __init__(self, num_blocks: int) -> None:
        self.free = list(range(num_blocks))

    def allocate(self) -> int:
        if not self.free:
            raise MemoryError("no free blocks: preempt a sequence")
        return self.free.pop()

class Sequence:
    def __init__(self, pool: BlockPool) -> None:
        self.pool, self.block_table, self.num_tokens = pool, [], 0

    def append_token(self) -> None:
        if self.num_tokens % BLOCK_TOKENS == 0:      # no block yet, or the last one is full
            self.block_table.append(self.pool.allocate())
        self.num_tokens += 1

    def wasted_slots(self) -> int:
        return len(self.block_table) * BLOCK_TOKENS - self.num_tokens

    def finish(self) -> None:
        self.pool.free.extend(self.block_table)

if __name__ == "__main__":
    pool = BlockPool(num_blocks=10)
    a, b = Sequence(pool), Sequence(pool)
    for step in range(40):                           # A makes 40 tokens, B the first 20
        a.append_token()
        if step < 20:
            b.append_token()
    print("A:", a.block_table, "wasted", a.wasted_slots())
    print("B:", b.block_table, "wasted", b.wasted_slots())
    a.finish()
    print("free blocks after A finishes:", len(pool.free))
    # A: [9, 7, 5] wasted 8
    # B: [8, 6] wasted 12
    # free blocks after A finishes: 8
```

Request A's 40 tokens use three blocks, 9, 7 and 5, and waste 8 slots. Request B's blocks interleave with A's, because blocks are taken as tokens arrive.

### Preemption when memory runs out

Paging does not remove the limit. When the pool is empty, the scheduler must free blocks before a running request can write its next token. vLLM evicts all the blocks of one sequence together, and under first-come, first-served scheduling the latest requests are preempted first. The paper describes two ways to recover the memory: swap the blocks to CPU memory, or drop them and recompute the cache later. vLLM's current docs say its V1 engine defaults to recomputation, because that has lower overhead there. Recomputing a 2,000-token context is a full prefill, 2,000 × 140 GFLOP = 280 TFLOP, about 71 ms at peak on four H100s and about 140 ms at 50%. The docs warn that preemption can raise end-to-end latency, and they expose preemption counts as Prometheus metrics.

## Prefix caching

Two prompts that start with the same tokens produce the same keys and values for those tokens, so an engine can compute them once and reuse the blocks. vLLM's design notes describe the scheme. Each block's hash covers that block's tokens, every token before it, and the previous block's hash. A request reuses a block only when the whole prefix up to it matches. Only full blocks are cached, and matching stops at the first block that differs. Freed blocks keep their contents until the pool needs the space, and the least recently used block goes first.

Take a 1,500-token system prompt that every request shares. With 16-token blocks, 93 full blocks cover 1,488 tokens. Each request that hits them skips 1,488 × 140 GFLOP = 208 TFLOP of prefill, about 53 ms at peak on four H100s and about 105 ms at 50%. The last 12 tokens are still computed.

Stable prompts are rewarded. One changed token early in the prompt breaks every later block, so put fixed content first, such as the system prompt, tool definitions and examples. Put per-request content last. A timestamp at the top changes on every request, so no block after it can match.

Hit rates depend on the workload. SGLang's RadixAttention stores the cache as a radix tree of token sequences and evicts least recently used leaves first. The paper reports hit rates from 50% to 99% on its benchmarks, and 52.4% and 74.1% for two models in a Chatbot Arena deployment. Measure your own. vLLM's docs add that prefix caching speeds up only the prefill phase, so a long reply gains little.

Sharing has boundaries. vLLM's `cache_salt` is mixed into the first block's hash, so only requests with the same salt can share blocks. Read [security for AI systems](/learn/ai-security#leaking-data) before you share caches between customers.

## Chunked prefill

Prefill reads the whole prompt in one large pass, and its cost grows with the prompt. Without chunking, one long prefill can fill an iteration, and every other request gets no decode token during it. An 8,000-token prompt costs 8,000 × 140 GFLOP = 1,120 TFLOP, about 283 ms at peak on four H100s and about 566 ms at 50%. Sarathi-Serve (OSDI 2024) calls these pauses generation stalls. It notes that "an iteration that computes one or more prefills can take several seconds depending on the lengths of input prompts."

Chunked prefill splits a new prompt into fixed-size chunks, and each iteration carries all ongoing decode steps plus one chunk. Sarathi-Serve calls this stall-free batching. A 512-token chunk costs 512 × 140 GFLOP = 72 TFLOP, about 18 ms at peak, and every running request still gets its token in that iteration. The long prompt needs more iterations, so its own time to first token grows. That is the trade.

vLLM's docs say chunked prefill is on by default in V1 whenever possible, and that decode requests get priority while it is on. The per-iteration budget is `max_num_batched_tokens`. Smaller budgets, such as the docs' 2,048 example, give better inter-token latency, and larger budgets give better time to first token. SGLang's `--chunked-prefill-size` sets the chunk size, and -1 disables chunking. TensorRT-LLM calls it chunked context, and every chunk except the last must be a multiple of the KV block size.

## Speculative decoding

A decode step produces one token per request. Speculative decoding lets a cheap model guess ahead. A small draft model proposes several tokens, and the large target model scores all of them in one forward pass. That pass costs about as much as one decode step, because the weights are still the bottleneck. The engine keeps the longest prefix the target agrees with, then takes one more token from the target.

```diagram
title: One speculative round with four drafted tokens
[d:note] Draft model\nproposes t1 to t4 @ 0,0.5
[t] Target model\none forward pass\nchecks all four @ 1.5,0.5
[o:note] Result\naccept t1 to t3\nplus one token @ 3,0.5
d -> t : 4 drafted tokens
t -> o : accepted prefix
```

The acceptance rule preserves the output. Leviathan, Kalman and Matias (ICML 2023) accept each drafted token with probability min(1, p ÷ q), where p is the target's probability and q is the draft's. On the first rejection, the engine samples from the target distribution minus the draft distribution, clipped at zero and renormalized. The paper shows the output has the same distribution as sampling from the target alone. Chen and colleagues (arXiv, February 2023) use the same idea and state that it preserves the target's distribution within hardware numerics.

If each drafted token is accepted with probability α and the draft proposes γ tokens, the Leviathan paper's Equation 1 gives the expected tokens per target pass: (1 − α^(γ+1)) ÷ (1 − α). The paper assumes the acceptance rates are independent and identically distributed, a simplification. With α = 0.8 and γ = 4, the formula gives (1 − 0.8^5) ÷ 0.2 = (1 − 0.32768) ÷ 0.2 ≈ 3.36 tokens per pass, instead of one. The sketch below checks the formula by simulation.

Assume one draft step costs 10% of a target step. A round then costs 4 × 0.1 + 1 = 1.4 target steps, so 3.36 ÷ 1.4 ≈ 2.4 tokens per target step of time. Verification is cheap at batch size 1. Five tokens take 5 × 140 GFLOP = 0.7 TFLOP, about 0.18 ms at peak, against about 10.4 ms of weight reads, so the pass stays memory-bound.

```python
# spec_math.py: tokens per target-model pass in speculative decoding, formula versus simulation.
import random

def expected_tokens(alpha: float, gamma: int) -> float:
    # Leviathan et al., Equation 1: the expected tokens per target pass.
    return (1 - alpha ** (gamma + 1)) / (1 - alpha)

def simulate(alpha: float, gamma: int, rounds: int = 200_000) -> float:
    rng = random.Random(0)
    total = 0
    for _ in range(rounds):
        accepted = 0
        while accepted < gamma and rng.random() < alpha:
            accepted += 1                   # the target accepts this drafted token
        total += accepted + 1               # plus one token from the target itself
    return total / rounds

if __name__ == "__main__":
    for alpha, gamma in [(0.8, 4), (0.6, 5)]:
        print(f"alpha={alpha} gamma={gamma} formula={expected_tokens(alpha, gamma):.3f} "
              f"simulated={simulate(alpha, gamma):.3f}")
    draft_cost = 0.1                        # assumption: one draft step costs 10% of a target step
    round_cost = 4 * draft_cost + 1         # four draft steps, then one target pass
    print(f"tokens per unit time at alpha=0.8, gamma=4: {expected_tokens(0.8, 4) / round_cost:.2f}")
    # alpha=0.8 gamma=4 formula=3.362 simulated=3.358
    # alpha=0.6 gamma=5 formula=2.383 simulated=2.384
    # tokens per unit time at alpha=0.8, gamma=4: 2.40
```

Leviathan and colleagues ran T5-XXL at batch size 1 on one TPU v4, with a 77-million-parameter draft. They reported 2.6× (translation) and 2.3× (summarization) at temperature 1, and 3.4× and 3.1× at temperature 0. Chen and colleagues report a 2 to 2.5 times speedup for Chinchilla 70B in a distributed setup. Speculation helps most when the GPU has spare capacity, which usually means small batches. At large batches, the step is already doing useful work for many requests, so the drafted tokens compete with them for the same arithmetic and the gain shrinks. Measure it at the batch sizes you actually run.

vLLM's docs list draft models, EAGLE, multi-token prediction, n-gram and suffix methods. A draft model is set in a speculative config such as `"method": "draft_model"` with `"num_speculative_tokens": 5`. llama.cpp takes a draft model with `-md` and drafts up to `--spec-draft-n-max` tokens, which defaults to 3. vLLM's docs describe one option as deliberately relaxing verification and not distribution preserving, so read each option before enabling it.

## Structured output

A model asked for JSON usually produces it, but sometimes it adds a comment, forgets a bracket or invents a key. Constrained decoding prevents these errors token by token. At each step, the engine works out which tokens keep the output valid under the grammar or schema, sets the logits of every other token to negative infinity so they cannot be sampled, and samples from what remains.

Done naively, this is slow, since a Llama 3 vocabulary has about 128,000 tokens. XGrammar (MLSys 2025) precomputes which tokens are accepted or rejected for most positions in the grammar, so only the rest need a runtime check. For Llama 3.1 with a JSON grammar, those are under 1% of the vocabulary, 1,134 of 128k. The paper reports mask generation under 40 µs per token for JSON Schema in its setup, and up to an 80 times end-to-end speedup on an H100 compared with vLLM using Outlines.

vLLM takes a `structured_outputs` field with a JSON schema, or a `response_format` of type `json_schema`, and xgrammar and guidance are among its backends. llama.cpp takes a BNF-like grammar with `--grammar` or `--grammar-file`. TGI's docs list guidance, which forces output to follow your schemas. A schema controls the shape of the output. A valid object can still hold wrong values, so validate them in your application.

## Popular engines

The status below comes from each project's own pages, checked in October 2026.

| Engine | Status, October 2026 | Good fit |
|---|---|---|
| vLLM | Active, with frequent releases. Its docs describe the V1 engine. | General GPU serving with paging, prefix caching, chunked prefill, speculative decoding and structured output. |
| SGLang | Active, Apache 2.0 licensed. Docs name RadixAttention, prefix caching and multi-GPU parallelism. Docs moved to docs.sglang.io. | Heavy prefix reuse and multi-call programs. |
| TensorRT-LLM | Active, maintained by NVIDIA. | NVIDIA GPUs, with NVIDIA's runtime. |
| TGI (Hugging Face) | Maintenance mode, accepting only minor fixes, and its repository has been archived (read-only) since March 2026. Its README recommends vLLM and SGLang, and llama.cpp or MLX for local use. | Existing deployments only. Plan a migration. |
| llama.cpp | Active, MIT licensed. Its server runs continuous batching by default. | Local use and small deployments. |
| Ollama | Active. Its README credits llama.cpp. A May 2025 post introduced its own engine for multimodal models and noted that llama.cpp has first-class support for text-only models. | Local development with a simple REST API. |

For a new GPU deployment, most teams compare vLLM with SGLang. Both document an OpenAI-compatible API and prefix caching. Measure both on your prompts and hardware, because the paper numbers above come from other setups.

Ollama's FAQ gives these defaults: one parallel request per model (`OLLAMA_NUM_PARALLEL`), three models per GPU (`OLLAMA_MAX_LOADED_MODELS`), and a queue of 512 requests (`OLLAMA_MAX_QUEUE`) before it returns 503 errors. Parallel requests also enlarge context memory. Its example: a 2K context with four parallel requests gets an 8K allocation. Models stay loaded for five minutes after their last request.

## Tuning for latency or throughput

Each engine exposes the same few levers under different names.

- **Concurrency.** vLLM's `max_num_seqs` caps the sequences in one iteration. SGLang uses `--max-running-requests`, llama.cpp uses `-np` for parallel slots, and Ollama uses `OLLAMA_NUM_PARALLEL`.
- **Work per iteration.** vLLM's `max_num_batched_tokens` caps the tokens in one iteration, and SGLang's `--chunked-prefill-size` caps each chunk.
- **Memory fraction.** vLLM's `gpu_memory_utilization` sets how much of each GPU the engine may use. SGLang's `--mem-fraction-static` covers the weights and cache pool, and its docs advise a smaller value if you see out-of-memory errors.
- **Pool and context.** SGLang's `--max-total-tokens` caps its memory pool. vLLM's `max_model_len` and llama.cpp's `-c` set the context length.

The main trade-off is concurrency against each user's speed. Take the running example with 2,000 tokens of context per user. Each step reads the 140 GB of weights plus 327,680 bytes × 2,000 × users of cache, at 13.4 TB/s:

| Users at once | Bytes read per step | Time per step | Tokens/s per user | Tokens/s in total |
|---|---|---|---|---|
| 1 | 140.7 GB | 10.5 ms | 95 | 95 |
| 64 | 182 GB | 13.6 ms | 74 | 4,700 |
| 128 | 224 GB | 16.7 ms | 60 | 7,700 |
| 225 | 287 GB | 21.5 ms | 47 | 10,500 |

One user gets about 95 tokens a second. At 64 users, each gets about 74, and the total is about 50 times higher. Going from 64 to 225 users adds about 2.2 times more total throughput, while each user drops to about 47 tokens a second. The 225 row fills the whole 450,000-token budget, so it marks the memory ceiling. The numbers ignore prefill and scheduler overhead, so treat them as upper bounds and measure your engine before setting a target.

The table suggests a few rules:

- For latency, keep concurrency within your per-user target, and cap the work per iteration so long prompts do not stall decodes.
- For throughput, raise concurrency until memory or your latency target stops you. Watch preemption counts, since each preemption adds a recomputation.
- A higher memory fraction gives more cache and less room for activations and load spikes.
- Some settings cost memory you cannot see. Ollama's parallel requests enlarge each context, and speculative decoding loads a second model.

The knobs interact. More memory helps only if concurrency can use it, and a higher concurrency limit helps only if memory and the token budget let those requests run.

## Check yourself

<details>
<summary>A 70B model on four H100s has about 148 GB for the KV cache. The engine reserves 8,192 tokens per request, but the average reply uses 2,000. How many requests fit at once under each policy?</summary>

With full reservations, 450,000 ÷ 8,192 = 54.9, so 54 requests fit. With allocation as tokens arrive, 450,000 ÷ 2,000 = 225 requests fit, before block rounding and before replies grow. The gap is the waste that paging recovers.

</details>

<details>
<summary>A chat product sends the same 3,000-token system prompt before every user message. Which feature helps, and what should the team check about the layout?</summary>

Prefix caching. With 16-token blocks, 187 full blocks (2,992 tokens) can be reused. Skipping that prefill saves 2,992 × 140 GFLOP ≈ 419 TFLOP, about 106 ms at peak on four H100s. The team should keep the system prompt identical and first, and move per-request content such as user IDs and timestamps to the end.

</details>

<details>
<summary>A team's prefix cache hit rate fell from 80% to almost zero after one change: a timestamp was added to the top of the system prompt. Why, and what should they change?</summary>

Each block's hash covers every token before it, so the first block changes on every request, and no later block can match. Move the timestamp to the end of the prompt, or take it out of the shared prefix.

</details>

<details>
<summary>Users report one-second freezes in streaming whenever someone pastes a long document. Which settings address this, and what does the fix cost?</summary>

Chunked prefill. In vLLM it is on by default in V1 whenever possible, and `max_num_batched_tokens` sets the budget. In SGLang, check that `--chunked-prefill-size` has a positive value, since -1 disables chunking. The cost is that the long document's own time to first token grows, because its prefill spreads over more iterations.

</details>

<details>
<summary>A draft model has acceptance rate α = 0.6 and proposes γ = 5 tokens. What is the expected tokens per target pass? Why might a team see little speedup at a batch of 64?</summary>

(1 − 0.6^6) ÷ (1 − 0.6) = (1 − 0.046656) ÷ 0.4 ≈ 2.38 tokens per pass. At a batch of 64, each step already does useful work for 64 requests, so there is less spare capacity for checking drafted tokens, and the gain shrinks. Measure it at your real batch size.

</details>

<details>
<summary>A team plans a JSON-returning endpoint for a 70B model on TGI. What would you recommend?</summary>

A different engine for new work. TGI is in maintenance mode, its repository has been read-only since March 2026, and its README points to vLLM and SGLang. vLLM documents structured output through `structured_outputs` or `response_format`. Confirm that SGLang has the features you need, then benchmark both on your own schemas.

</details>

## Further reading

- [Kwon et al., PagedAttention (SOSP 2023)](https://arxiv.org/abs/2309.06180): block tables, the 20.4% to 38.2% measurement and preemption.
- [Yu et al., Orca (OSDI 2022)](https://www.usenix.org/conference/osdi22/presentation/yu): iteration-level scheduling and selective batching.
- [Agrawal et al., Sarathi-Serve (OSDI 2024)](https://usenix.org/conference/osdi24/presentation/agrawal): generation stalls and chunked prefill.
- [Leviathan et al., Speculative Decoding (ICML 2023)](https://proceedings.mlr.press/v202/leviathan23a): Equation 1 and the accept-or-resample rule.
- [Chen et al., Speculative Sampling (arXiv, 2023)](https://arxiv.org/html/2302.01318): the accept-reject step and the Chinchilla speedups.
- [Zheng et al., SGLang (NeurIPS 2024)](https://proceedings.neurips.cc/paper_files/paper/2024/hash/724be4472168f31ba1c9ac630f15dec8-Abstract.html): RadixAttention and cache hit rates.
- [Dong et al., XGrammar (MLSys 2025)](https://arxiv.org/html/2411.15100): precomputed token masks and overhead figures.
- [vLLM optimization and tuning](https://docs.vllm.ai/en/latest/configuration/optimization.html): chunked prefill defaults, preemption and token-budget advice.
- [vLLM prefix caching design](https://docs.vllm.ai/en/latest/design/prefix_caching.html): how block hashes chain and how blocks are evicted.
- [vLLM architecture overview](https://docs.vllm.ai/en/latest/design/arch_overview.html): the API server, engine core and GPU worker processes.
- [vLLM engine arguments](https://docs.vllm.ai/en/latest/configuration/engine_args.html): the memory fraction default and sequence settings.
- [vLLM speculative decoding](https://docs.vllm.ai/en/latest/features/speculative_decoding/) and [structured outputs](https://docs.vllm.ai/en/latest/features/structured_outputs.html): methods and request formats.
- [vLLM online serving](https://docs.vllm.ai/en/latest/serving/online_serving/): the OpenAI-compatible endpoints.
- [SGLang server arguments](https://docs.sglang.io/advanced_features/server_arguments.html): flag names and defaults.
- [TensorRT-LLM paged KV cache and in-flight batching](https://nvidia.github.io/TensorRT-LLM/features/paged-attention-ifb-scheduler.html): the same mechanisms under NVIDIA's names.
- [NVIDIA Triton dynamic batcher](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/batcher.html): the queue delay behind dynamic batching.
- [Text Generation Inference README](https://github.com/huggingface/text-generation-inference): the maintenance notice and recommended engines.
- [llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md): slots, continuous batching, grammars and draft models.
- [Ollama FAQ](https://docs.ollama.com/faq) and [Ollama's multimodal engine post](https://ollama.com/blog/multimodal-models): concurrency defaults and the May 2025 engine change.
- [NVIDIA H100](https://www.nvidia.com/en-us/data-center/h100/) and [H200](https://www.nvidia.com/en-us/data-center/h200/) specifications: memory and bandwidth figures.
- [NVIDIA, Hopper Architecture In-Depth](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/): sparsity doubles Tensor Core throughput, so 989 TFLOPS is the dense figure.
- [Grattafiori et al., The Llama 3 Herd of Models](https://arxiv.org/abs/2407.21783): Table 3, the architecture numbers for the 8B, 70B and 405B models.
