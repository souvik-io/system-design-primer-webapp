# Build a mini inference engine

[Inference serving engines](/learn/inference-engines) described what an engine does: it batches requests at every step, keeps their KV caches in fixed-size blocks, splits long prompts into chunks, and preempts requests when memory runs out. This chapter builds one. The engine is called nano_engine, and its core is about 650 lines of Python in five files, plus an OpenAI-compatible HTTP server and a benchmark. It runs Llama-architecture models, reproduces Hugging Face's greedy outputs token for token however it batches, chunks or preempts, and on an H100 it is measured against vLLM on the same requests. It is also the first part of capstone A: later chapters add prefix caching (5.3), speculative decoding (5.4) and constrained decoding (5.5) to it.

Each section below explains one mechanism and shows the code that implements it, and the lab at the end runs all of it. Before this chapter, read [Inference serving engines](/learn/inference-engines). It also helps to have read [PyTorch execution](/learn/pytorch-execution), on kernel-launch overhead and CUDA graphs, which explain part of the difference between nano_engine and vLLM.

## The engine loop

An engine is a loop around one function, `step()`, that the server calls as long as any request is unfinished. Each step does six things. The scheduler picks which sequences run and how many of their tokens. The block manager makes sure each of them has KV cache blocks for those tokens. The model runner lays the chosen tokens end to end and runs the model once. The sampler picks a next token for every sequence that has run all its known tokens. The engine appends those tokens, finishes the sequences that hit a stop condition and frees their blocks. Finally, the server streams the new tokens to their clients.

```diagram
title: One step of nano_engine
[q:store] Waiting queue @ 0,0.5
[s] Scheduler\ntoken budget @ 1,0.5
[b:store] Block manager\nfree list, refs @ 1,1.8
[m] Model runner\none forward pass @ 2,0.5
[x] Sampler\nthen stop checks @ 3,0.5
[c:client] HTTP clients @ 4,0.5
q -> s : admit
s <-> b : blocks
s -> m : seqs, tokens
m -> x : logits
x -> c : new tokens
```

The key to keeping the loop simple is how a sequence is described. nano_engine stores, for each sequence, every token it has so far (prompt then output), the number of those whose keys and values are already in the KV cache (`num_computed`), and the list of cache blocks that hold them (`block_table`). Everything else follows from those three fields. A new request has computed nothing, so all its prompt tokens are uncomputed. A request partway through a long prompt has some uncomputed. A decoding request has exactly one, the token it sampled last step. A preempted request is set back to zero computed and recomputes everything. The scheduler never asks whether a sequence is "in prefill" or "in decode", only how many uncomputed tokens it has. vLLM's V1 engine made the same choice: its announcement says the scheduler "removes the traditional distinction between 'prefill' and 'decode' phases", and that a scheduling decision is "a simple dictionary, e.g., {request_id: num_tokens}".

Here is `step()`, from [engine.py](/labs/infra/nano_engine/engine.py), with the forking for parallel sampling left in:

```python
def step(self) -> list[StepOutput]:
    batch = self.scheduler.schedule()             # which sequences, how many tokens each
    if not batch.seqs:
        return []
    # A sequence samples when this step computes the last of its known tokens.
    samplers = [s for s, n in zip(batch.seqs, batch.num_tokens) if s.num_computed + n == s.num_tokens]
    logits = self._run(batch, samplers)           # one forward pass; logits only for the samplers
    for seq, n in zip(batch.seqs, batch.num_tokens):
        seq.num_computed += n
    outputs = []
    for seq, tokens in zip(samplers, self._sample(logits, samplers)):
        if not seq.forked:                        # first token of an n > 1 request: fork into n sequences
            seq.forked = True
            outputs += [self._append(child, [t]) for child, t in zip(self._fork(seq), tokens[1:])]
        outputs.append(self._append(seq, tokens[:1]))   # append, check stop conditions, free if finished
    return outputs
```

A sequence whose prompt is only partly done after this step does not sample: its last row of logits would predict a token that is already in the prompt. Its chunk still wrote keys and values into the cache, which is the point of running it.

## The paged KV cache

The cache is one tensor allocated when the engine starts, shaped `[layers, 2, blocks, block_size, kv_heads, head_dim]`: for every layer, keys and values, in blocks of `block_size` tokens. For Llama 3.1 8B in BF16 a token takes 2 × 32 layers × 8 KV heads × 128 dimensions × 2 bytes = 131,072 bytes, 128 KiB, so a block of 16 tokens takes 2 MiB. For SmolLM2-135M in FP32 on a Mac a token takes 2 × 30 × 3 × 64 × 4 = 46,080 bytes, and 1 GiB holds 1,456 blocks of 16.

The block manager, [kv_cache.py](/labs/infra/nano_engine/kv_cache.py), never touches that tensor. It only decides which block each token goes in. It keeps a free list of block numbers and a reference count for each block, takes a block from the free list when a sequence's last block is full, and returns a sequence's blocks when it finishes or is preempted. Because blocks are taken one at a time from wherever the free list points, a sequence's blocks are scattered over the pool, and its block table records their order. The cache position of token p of a sequence is then one line:

```python
def slot(self, seq: Sequence, position: int) -> int:
    return seq.block_table[position // self.block_size] * self.block_size + position % self.block_size
```

The model runner computes this slot for every token it runs in a step and passes the list to the model as `slot_mapping`. Each layer writes its new keys and values with one scatter, `k_cache.view(-1, kv_heads, head_dim)[slot_mapping] = k`, and then attends over the whole context by reading the sequence's blocks through its block table.

### Reading the cache in attention

nano_engine has two attention paths. The reference path, in plain PyTorch, runs anywhere: it gathers each sequence's blocks into a contiguous tensor, `k_cache[block_table].flatten(0, 1)[:context_len]`, and calls `scaled_dot_product_attention`. Decoding sequences, which have one query each, are padded to the longest context and done in one call per layer, with a mask hiding the padding; sequences with several new tokens are done one at a time, with a causal mask offset by the tokens already in the cache. Gathering copies every key and value of the context once per layer, which is what a real paged-attention kernel avoids.

On CUDA, nano_engine calls the build of FlashAttention that ships inside vLLM, `vllm.vllm_flash_attn.flash_attn_varlen_func`, once per layer for the whole step: FlashAttention 3 on Hopper GPUs, as vLLM does, and FlashAttention 2 on others. It takes the step's queries laid end to end, `cu_seqlens_q` to say where each sequence's queries start, each sequence's context length, and the block tables, and reads keys and values straight from the blocks. One call handles a mixed batch of prefill chunks and decodes, which is how vLLM's own FlashAttention backend works. The upstream FlashAttention 2 package also accepts block tables, but its documentation says that "page_block_size must be a multiple of 256", which is why nano-vllm, a similar small engine built on it, uses blocks of 256 tokens. The test suite runs both paths on the same batches on a GPU and checks that they agree to BF16 rounding.

### Copy-on-write for parallel sampling

A request can ask for several completions of one prompt (OpenAI's `n` parameter). Computing the prompt's keys and values once and sharing them is the obvious saving, and paging makes it cheap: after the prompt, nano_engine forks the sequence into n sequences whose block tables point to the same blocks, and raises each block's reference count. Full blocks stay shared for the rest of the request, because no sequence ever writes to them again. The last prompt block is usually only partly full, and each fork's first output token goes into it. So before a sequence writes into a block whose reference count is above one, the block manager gives it a fresh block, the model runner copies the shared block's contents into it, and the old block's count drops by one. The last fork to write finds a count of one and writes in place. This is the copy-on-write the PagedAttention paper describes, "at the block granularity", with "a reference count for each physical block".

```python
def append(self, seq: Sequence, num_new_tokens: int) -> list[tuple[int, int]]:
    copies = []
    if self._needs_copy(seq):                  # writing into a partly full block that others share
        shared = seq.block_table[-1]
        own = self._take()
        self._release(shared)
        seq.block_table[-1] = own
        copies.append((shared, own))           # the model runner copies these before the forward pass
    total = math.ceil((seq.num_computed + num_new_tokens) / self.block_size)
    while len(seq.block_table) < total:
        seq.block_table.append(self._take())
    return copies
```

With a 5-token prompt, 4-token blocks and n = 3, the prompt fills one block and one slot of a second. The three completions share both, and two copies are made, of the second block only; the test suite checks exactly this.

### Choosing a block size

A sequence wastes at most block_size − 1 slots in its last block, so smaller blocks waste less memory. Larger blocks mean shorter block tables, fewer allocations and longer contiguous reads in the attention kernel. The PagedAttention paper measured this trade-off and concluded that a block size of 16 is "large enough to efficiently utilize the GPU and small enough to avoid significant internal fragmentation"; vLLM's releases through 0.32 (and the 0.33 release candidate) default to 16, and its main branch moved the default to 64 in November 2026. nano_engine uses 16.

```widget
paged-kv-allocator
```

Start with **Reserve max length** and press Play. Each sequence reserves its prompt plus 24 slots, so only three or four run at a time, about half of every reservation sits empty, and at times a request waits even though enough slots are free, because they are not contiguous. Switch to **Paged** with 4-slot blocks: the same requests finish in about half the steps, with nearly 90% of allocated slots in use, but the pool now fills up and the scheduler preempts sequences, whose tokens are later recomputed. Raise the block size to 16 and watch the pale, allocated-but-empty slots grow. Finally set two samples per request: the prompt blocks marked ×2 are shared, a copy appears when a sample writes into a shared partly full block, and the extra sequences push the pool into heavy preemption.

## Scheduling with a token budget

The scheduler, [scheduler.py](/labs/infra/nano_engine/scheduler.py), builds each step under two limits: at most `max_num_seqs` sequences and at most `max_num_batched_tokens` tokens, the token budget. It fills the step in a fixed order.

First come the running sequences, oldest first. Each gets all its uncomputed tokens or what is left of the budget, whichever is smaller: one token for a decode, the next chunk for a prompt that is partway through. Then waiting sequences are admitted in arrival order, each getting a chunk of what is left, until the budget, the sequence limit or the free blocks run out. A waiting sequence that does not fit stops admission for this step, so a long prompt at the head of the queue is never overtaken by short ones behind it.

Putting running sequences first is what keeps streaming smooth. Sarathi-Serve, the OSDI 2024 paper that introduced this kind of scheduling as stall-free batching, says "we first pack all the running decodes in the next batch", then partly done prefills, and only then admits new requests, sizing their chunks to the "leftover token budget". vLLM's V1 scheduler follows the same order; its code schedules "the RUNNING requests" first and "the WAITING requests" next.

```python
for seq in list(self.running):                     # 1. running sequences, oldest first
    n = min(seq.num_uncomputed, budget)            # a decode's one token, or a prompt's next chunk
    while not self.blocks.can_append(seq, n):
        self._preempt(self.running[-1], batch)     # out of blocks: preempt the newest
    batch.add(seq, n, self.blocks.append(seq, n))
    budget -= n
while self.waiting and budget > 0 and not batch.preempted and len(self.running) < self.config.max_num_seqs:
    seq = self.waiting[0]                          # 2. admit waiting sequences in arrival order
    n = min(seq.num_uncomputed, budget)
    if not self.blocks.can_append(seq, n):
        break
    ...
```

(The listing leaves out the checks for a sequence preempted earlier in the same loop and for chunking turned off; the file has them.)

### Chunked prefill

Chunking is a side effect of the budget. When a 3,000-token prompt arrives and the budget is 512, the prompt gets whatever is left after the decodes in its first step, then up to 512 tokens a step until it is done, and the decodes keep producing a token every step meanwhile. Without chunking, the whole prompt must run in one step, and that step takes as long as a 3,000-token prefill, which every running sequence feels as a pause between two tokens. The budget sets the trade-off. Sarathi-Serve notes that "a smaller token budget is preferable because iterations with fewer prefill tokens have lower latency", but each chunk re-reads the weights and the earlier chunks' keys and values, so small budgets cost prefill efficiency: the paper reports "at most ∼25%" overhead at a budget of 512 and uses 512 and 2,048 in its experiments. In vLLM the budget is `max_num_batched_tokens`.

The stall benchmark in [bench.py](/labs/infra/nano_engine/bench.py) measures this. Thirty-two sequences are decoding when an 8,000-token prompt arrives; it records how long each step takes and how long the long prompt waits for its first token.

On an H100 with Llama 3.1 8B, while 32 sequences decode at about 17 ms a step:

| Token budget | Longest step after the prompt arrives | Steps until its first token | Its time to first token |
|---|---|---|---|
| 512 | 24.9 ms | 17 | 389 ms |
| 2,048 | 76.0 ms | 4 | 285 ms |
| No chunking (one 8,032-token step) | 265.0 ms | 1 | 265 ms |

Without chunking, the 32 running users see one 265 ms gap in their stream, fifteen times their usual token interval. A budget of 2,048 splits that into four steps of 65 to 76 ms and delays the long prompt's first token by only 20 ms. A budget of 512 keeps every step under 25 ms, at the price of a first token 47% later than without chunking. The chunked steps also grow slowly, from 21.0 to 24.9 ms at a budget of 512, because each later chunk attends to all the earlier ones. Which budget is right depends on the service's latency targets, which is why it is a setting.

### Preemption

Paging lets the engine admit requests without knowing how long they will run, so it can run out of blocks. When a running sequence needs a block and none is free, nano_engine preempts the most recently admitted sequence: it frees all of that sequence's blocks at once (the paper's "all-or-nothing eviction policy"), sets its computed count to zero and puts it back at the front of the queue. When it is admitted again, its prompt and its output so far are simply a longer prompt, and the ordinary prefill path recomputes their keys and values. The PagedAttention paper describes two ways to get preempted blocks back, swapping them to CPU memory or recomputing them, and observes that recomputation is cheaper than it sounds because the generated tokens "can be concatenated with the original user prompt as a new prompt" and run as one parallel prefill. vLLM's current V1 engine only recomputes: its preemption code frees the blocks, sets the request's `num_computed_tokens` to 0 and puts it back at the head of the waiting queue, and its documentation describes recomputation as the default. Like vLLM, nano_engine admits no new sequences in a step that had to preempt, because memory is evidently short.

The preemption test in [test_nano_engine.py](/labs/infra/nano_engine/test_nano_engine.py) gives the engine 10 blocks of 4 tokens for five sequences that each grow to about 30 tokens. The engine preempts repeatedly, and the outputs are still identical to Hugging Face's.

## Running a ragged batch

The model runner turns the scheduler's choice into tensors. There is no padding and no batch dimension: the step's tokens from every sequence are laid end to end, a prefill chunk contributing hundreds and a decode one, and every matmul in the model treats them as a single `[tokens, hidden]` matrix. For each token the runner also lists its position (for RoPE) and its cache slot; for each sequence, where its tokens start (`cu_seqlens_q`), its context length after this step, and its block table. Only attention looks at the per-sequence data.

Two more details matter for speed. Logits are computed only for the last token of each sequence that samples. Llama 3.1 8B's output layer multiplies by a 128,256 × 4,096 matrix, about 1.05 GFLOP per row, and a step with an 8,192-token prompt chunk would otherwise compute 8.6 TFLOP of logits and hold 4.2 GB of them in FP32, almost all for positions whose next token is already known. And the model concatenates the query, key and value projections into one weight matrix, and the MLP's gate and up projections into another, when it loads, so each layer runs two large matmuls where it would run five smaller ones.

Sampling happens on the logits of those rows only: greedy where the temperature is 0, otherwise softmax with temperature, then top-p, then a random draw. Top-p needs each row's probabilities sorted, which is costly over a vocabulary of 128,256 tokens, so nano_engine sorts only when some sequence in the step asks for top-p.

### Sizing the cache

On a GPU, the KV cache should take all the memory the weights and the activations do not. nano_engine does what vLLM's workers do: after loading the weights, it runs one forward pass of the largest step the scheduler allows, a full token budget, on dummy inputs, reads the peak memory PyTorch allocated, and gives the KV cache the rest of `gpu_memory_utilization` of the GPU (0.9 by default). vLLM 0.32 sizes its cache from the same kind of profiling run and defaults to 0.92 of the GPU; its main branch now sizes the cache from the memory that is actually free after it captures its CUDA graphs. On a Mac, nano_engine takes a fixed size, 1 GiB by default.

## Streaming over HTTP

[server.py](/labs/infra/nano_engine/server.py) puts an OpenAI-compatible API in front of the engine, with `/v1/completions`, `/v1/chat/completions` and `/v1/models`, using FastAPI. The engine loop runs in its own thread and the HTTP server in the main thread's asyncio event loop. A new request goes to the engine through a thread-safe queue, and the engine thread pushes each step's tokens to the owning request's asyncio queue with `call_soon_threadsafe`. vLLM splits the same work across processes, an API server and an engine core, for the same reason: tokenizing, detokenizing and HTTP handling should not delay the GPU.

Streaming uses server-sent events, as OpenAI's API does: each chunk is one `data: {json}` line, a `chat.completion.chunk` object whose choices carry a `delta` with the new text, and the stream ends with `data: [DONE]`. With `stream_options: {"include_usage": true}`, one more chunk before `[DONE]` carries the token counts and an empty list of choices. A detokenizer per completion decodes the whole output so far and sends what is new, holding text back while it ends in an incomplete UTF-8 character, which byte-level tokenizers produce when one character spans several tokens. When a client disconnects, the request is aborted and its blocks are freed at once.

```bash
python -m nano_engine.server --model HuggingFaceTB/SmolLM2-135M-Instruct --device cpu
curl -N localhost:8000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages": [{"role": "user", "content": "Name three rivers."}], "max_tokens": 30, "stream": true}'
```

```text
data: {"id": "chatcmpl-dbdf…", "object": "chat.completion.chunk", "created": 1794293146, "model": "HuggingFaceTB/SmolLM2-135M-Instruct", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Here"}, "finish_reason": null}]}

data: {"id": "chatcmpl-dbdf…", "object": "chat.completion.chunk", "created": 1794293146, "model": "HuggingFaceTB/SmolLM2-135M-Instruct", "choices": [{"index": 0, "delta": {"role": "assistant", "content": " are"}, "finish_reason": null}]}
…
data: [DONE]
```

The official `openai` Python client works against it unchanged with `base_url="http://localhost:8000/v1"`. On the Mac, 16 clients sending at once got 203 output tokens a second in total, against 57 for one client alone, because the engine batched them.

## Measured: nano_engine against vLLM

The fixed benchmark sends 256 requests at once, with prompt and output lengths drawn uniformly from 100 to 1,024 tokens (145,789 prompt tokens and 137,547 output tokens in all), and generates every output to its full length. It is the same shape as nano-vllm's benchmark. On one H100 with Llama 3.1 8B Instruct in BF16, each engine in its own process, with up to 256 sequences and 8,192 tokens per step:

| Engine | Time | Output tokens/s | Relative |
|---|---|---|---|
| nano_engine | 27.5 s | 4,997 | 1.00 |
| vLLM 0.32.0, eager | 18.7 s | 7,340 | 1.47 |
| vLLM 0.32.0, with CUDA graphs and torch.compile (its default) | 16.8 s | 8,189 | 1.64 |

vLLM is 1.64 times faster, inside the lab's acceptance bar of 3. On an A10 with Llama 3.2 1B and 64 requests, the gap was 1.46 times (2,194 against 3,203 output tokens a second).

### Where the difference goes

A profile of nano_engine with all 256 sequences decoding ([gpu/profile_engine.py](/labs/infra/gpu/profile_engine.py)) shows a 24.6 ms step, of which the GPU is busy for about 20.3 ms. FlashAttention takes 7.6 ms, reading about 20 GB of keys and values (256 sequences of about 600 tokens, at 128 KiB a token), close to what the H100's bandwidth allows. The matmuls take 7.2 ms, against 4.8 ms to read the 16 GB of weights once. About 4 ms goes to some 500 small element-wise kernels a step: the multiplications, casts and reductions of RMSNorm, RoPE and SiLU, and the residual additions. vLLM's layers do the same work in a few fused kernels (RMSNorm fused with the residual add, a rotary-embedding kernel, a fused SiLU-and-multiply). The other 4 ms of the step is the GPU waiting on the CPU: nano_engine launches about 1,470 kernels a step from Python and builds the next batch's inputs between steps. Together those are about 8 ms a step, close to the 8.5 ms a step by which nano_engine's run is longer than vLLM's eager run (8.8 s over 1,029 steps). CUDA graphs remove most launch overhead, which is the further 11% vLLM gains over its own eager mode here, and what [chapter 3.1](/learn/pytorch-execution) measured for a single decode step.

### Two bugs the benchmark found

The first H100 run did not pass: nano_engine produced 1,376 tokens a second, against vLLM's 8,134. Timing every step showed why. Nearly every step took about 24 ms, but one of the 1,029 took 67 seconds. Watching for steps longer than 3 seconds and dumping the Python stack put the time inside the FlashAttention call, which allocated no new GPU memory, at a step where only 26 sequences were left. Timing the call itself found a second slow one, the warm-up request decoding alone. Both were decodes of a small batch, for which FlashAttention splits each sequence's keys across several thread blocks to keep the GPU busy, so they most likely ran kernel variants that the large batches before them had not used. `cuobjdump` on the library showed the cause: vLLM's FlashAttention 2 library contains machine code only for compute capability 8.0 (A100), plus PTX, and machine code for 8.x does not run on a 9.0 GPU. So the first use of each kernel variant on the H100 made the driver compile it from PTX, which took between 33 and 70 seconds each time. The A10, compute capability 8.6, runs the 8.0 machine code directly, which is why the quick run never showed it. vLLM itself uses FlashAttention 3 on Hopper, whose library contains machine code for 9.0a; switching to it made the whole run 3.5 times faster (95.8 s to 27.5 s). The driver caches compiled kernels on disk, so a second run in the same container would not have shown the problem either, and a fresh container is the case that matters in production.

The second finding was smaller. The KV cache leaves only about 10% of the GPU's memory free, and with PyTorch's default caching allocator, the varying shapes of each step's activations fragmented it until an allocation failed and the allocator had to release its cache and retry. Turning on expandable segments (`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`) removed the retry. For a while the retry looked guilty of the 33-second step too. Run first with the default allocator and then with expandable segments in the same container, only the first run had the slow step; but the second had found the compiled kernel in the driver's cache. Repeated in fresh containers, the default allocator still retried once, and every step was normal. When two changes can explain a result, test each alone.

## Lab: build and benchmark nano_engine

**Tier: [Mac] then [1 GPU].** Parts A and B run on a Mac in a few minutes; Part C needs an NVIDIA GPU and vLLM.

The reference solution is nano_engine itself, nine files in a folder called `nano_engine`: [sequence.py](/labs/infra/nano_engine/sequence.py), [kv_cache.py](/labs/infra/nano_engine/kv_cache.py), [scheduler.py](/labs/infra/nano_engine/scheduler.py), [model.py](/labs/infra/nano_engine/model.py), [engine.py](/labs/infra/nano_engine/engine.py), [server.py](/labs/infra/nano_engine/server.py), [bench.py](/labs/infra/nano_engine/bench.py), [test_nano_engine.py](/labs/infra/nano_engine/test_nano_engine.py) and [\_\_init\_\_.py](/labs/infra/nano_engine/__init__.py), plus [gpu/engine_bench.py](/labs/infra/gpu/engine_bench.py) for the GPU run. Try to write your own before reading them. Put the folder next to the other lab files, install the packages in [requirements.txt](/labs/infra/requirements.txt), and run everything from the folder that holds `nano_engine/`:

```bash
python -m nano_engine.test_nano_engine                                    # about 20 s on an M2
python -m nano_engine.server --device cpu                                 # then send requests with curl or openai
python -m nano_engine.bench throughput --device mps --num-seqs 32 --min-len 32 --max-len 256                  # about 20 s
python -m nano_engine.bench throughput --device mps --num-seqs 32 --min-len 32 --max-len 256 --max-num-seqs 1  # about 80 s
python -m nano_engine.bench throughput --device mps --num-seqs 32 --min-len 32 --max-len 256 --engine hf       # about 40 s
cd gpu && modal run modal_run.py --script engine_bench.py --gpu 'H100!' --vllm    # about 6 min of GPU time, about $0.40
cd gpu && modal run modal_run.py --script engine_bench.py --gpu A10 --vllm --args "--quick"   # 1B model: 5 min, about $0.08
```

**Part A, the engine.** Write a block manager with a free list and reference counts, a scheduler that runs sequences first and admits waiting ones under a token budget with chunked prefill and preemption by recomputation, and a model runner that runs a Llama model on a flat batch with a paged KV cache and PyTorch attention. Acceptance: with greedy decoding in FP32 on the CPU, your engine's outputs for five prompts equal Hugging Face's `generate` token for token, with all prompts in one batch, with a token budget small enough to chunk every prompt, and with a cache so small that the engine must preempt. Then add n > 1 with copy-on-write and check that greedy forks agree and that the number of block copies is what you predict.

**Part B, serving.** Put an OpenAI-compatible server with streaming in front of the engine, and check it with curl and with the official `openai` client. Compare throughput on the Mac three ways: Hugging Face Transformers serving one request at a time, your engine with one sequence at a time, and your engine batching. Explain each gap.

**Part C, against vLLM.** On a GPU, switch attention to a paged-attention kernel (the reference uses vLLM's FlashAttention), check it against your PyTorch path, and run the fixed benchmark through your engine and through vLLM: Llama 3.1 8B Instruct, 256 requests of random tokens with prompt and output lengths drawn from 100 to 1,024, all submitted at once, end-of-sequence ignored. Acceptance: vLLM's output tokens per second are less than 3 times yours. Then run the stall benchmark with token budgets of 512 and 2,048 and with chunking off, and explain the numbers.

<details>
<summary>Reference solution</summary>

`python -m nano_engine.test_nano_engine` on an Apple M2 MacBook with 8 GB of memory (PyTorch 2.15.0, Transformers 5.22.2):

```text
ok  test_blocks_are_taken_as_tokens_arrive_and_returned
ok  test_copy_on_write
ok  test_running_first_then_chunked_prefill_within_budget
ok  test_preempts_most_recent_and_requeues_it_first
ok  test_paged_attention_matches_dense
ok  test_matches_huggingface_batched
ok  test_matches_huggingface_with_chunked_prefill
ok  test_matches_huggingface_under_preemption
ok  test_parallel_sampling_shares_prompt_blocks
ok  test_flash_matches_torch
10 tests passed
```

On a Mac, `test_flash_matches_torch` returns at once, because it needs CUDA. On Modal's A10 (PyTorch 2.13.0, vLLM 0.32.0) all ten run, and the last prints `FlashAttention against the PyTorch path: largest relative difference 7.6e-03`, which is BF16 rounding: a wrong block table or mask gives differences of order 1.

*Part A.* Matching Hugging Face exactly is a strong test because greedy decoding amplifies any difference: one wrong key in one layer changes a logit slightly, eventually flips an argmax, and every later token differs. Three things had to be right for it to pass. RoPE's angles are computed in FP32 as Hugging Face does. A chunk's causal mask is offset by the tokens already in the cache, so query j of a chunk that starts at position s sees keys up to s + j. A preempted sequence's output so far is treated as part of its prompt when it is recomputed. With a 5-token prompt, blocks of 4 and n = 3, the prompt occupies one full block and one slot of a second, and two copies are made.

*Part B.* SmolLM2-135M-Instruct on the M2's GPU (MPS), 32 requests with prompt and output lengths from 32 to 256:

| Serving | Output tokens/s | Steps |
|---|---|---|
| Hugging Face `generate`, one request at a time | 107 | |
| nano_engine, one sequence at a time | 55 | 4,497 |
| nano_engine, batching all 32 | 270 | 255 |

Batching makes nano_engine 4.9 times faster than itself one at a time, and 2.5 times faster than Hugging Face. One at a time it is half as fast as Hugging Face: each of its steps rebuilds the batch's inputs in Python, gathers keys and values out of the blocks in every layer, and launches more small operations, and a 135M model's step is so short that this overhead decides its speed. Batching amortizes the overhead over 32 sequences. On a GPU, the same overhead is what CUDA graphs remove, as chapter 3.1 measured.

*Part C.* On Modal's H100 (`engine_bench.py`; PyTorch 2.13.0 and vLLM 0.32.0 from the vLLM image), the tests pass with `FlashAttention against the PyTorch path: largest relative difference 6.8e-03`, and the benchmark prints:

```text
nano_engine: 4997 output tok/s; vLLM eager: 7340; vLLM with CUDA graphs: 8189. vLLM is 1.64x nano_engine (acceptance: under 3x).
```

The whole output, including every step time of the stall runs, is in [gpu/engine_bench.json](/labs/infra/gpu/engine_bench.json), and the A10 run in [gpu/engine_bench_a10_quick.json](/labs/infra/gpu/engine_bench_a10_quick.json). nano_engine's median step was 22.7 ms and its slowest were the 8,192-token prefill steps, at about 260 ms each; it never preempted, because the 8B model on an 80 GB GPU leaves room for 27,662 blocks, 442,592 tokens, and all 256 requests together, every prompt and output token, come to 283,336. The gap to vLLM is explained in the section on where the difference goes: fused element-wise kernels and CUDA graphs. Your engine passes if it is within 3 times; if it is far slower, time every step before optimizing anything, since one pathological step can dominate a run, as the FlashAttention 2 compile did here.

In the stall runs, the longest step falls from 265 ms without chunking to 76 ms with a budget of 2,048 and 24.9 ms with 512, while the long prompt's time to first token rises from 265 to 285 and 389 ms. Chunking moves latency from everyone else onto the long prompt, and the budget decides how much.

</details>

## Interview angle

- **"Walk me through what an inference engine does in one step."** The scheduler picks sequences and token counts under a token budget, running sequences first; the block manager allocates KV blocks for those tokens, copying shared blocks on write and preempting when the pool is empty; the model runner lays the tokens end to end with their positions, cache slots and block tables and runs one forward pass; the sampler picks next tokens for sequences that finished their known tokens; finished sequences free their blocks and new tokens stream out.
- **"How does a paged KV cache find a token's keys?"** Through the sequence's block table: logical block p ÷ block_size maps to a physical block, and the slot is that block × block_size + p mod block_size. The attention kernel reads blocks through the same table, so a sequence's blocks need not be adjacent.
- **"What happens when the KV cache is full?"** The scheduler preempts the most recently admitted sequence, freeing all its blocks, and puts it back at the head of the queue; later its prompt and output so far are recomputed as one prefill. vLLM V1 only recomputes; older designs could also swap blocks to CPU memory. Preemption shows up as latency, so engines expose preemption counts.
- **"What does chunked prefill trade?"** A smaller token budget bounds how long any step takes, so decoding requests do not stall when a long prompt arrives, but the long prompt's own time to first token grows and each chunk costs some efficiency. Running decodes first and filling the rest of the budget with prompt chunks is Sarathi-Serve's stall-free batching, and vLLM's default.
- **"How would you make your engine faster?"** Measure first, with the profiler. Then the usual steps are CUDA graphs for decode steps (to remove launch overhead), building the next step's inputs while the GPU runs the current one, fused kernels for the cache write and the sampler, and prefix caching for repeated prompts.

## Check yourself

<details>
<summary>A sequence has 37 tokens in the cache and blocks of 16. Which block and slot does its next token go to, if its block table is [12, 3, 40]?</summary>

The next token is at position 37. Its logical block is 37 ÷ 16 = 2 (integer division), which the table maps to physical block 40, and its offset is 37 mod 16 = 5. The slot is 40 × 16 + 5 = 645. The block has room, because 37 tokens fill two blocks and 5 slots of the third.

</details>

<details>
<summary>Why does nano_engine not sample a token for a sequence whose prompt chunk ended this step?</summary>

The last row of a chunk predicts the token after the chunk, which is the next prompt token, already known. Sampling there would be wasted work and, if used, wrong. The sequence samples in the step that computes the last of its known tokens.

</details>

<details>
<summary>Three completions of a 21-token prompt share its blocks, with blocks of 16. How many blocks do they share, and how many copies are made when they start writing?</summary>

The prompt fills one block and 5 slots of a second, so the three share two blocks. The first block is full and stays shared. Each completion's first token goes into the second block: the first two to write get their own copies, and the third finds a reference count of one and writes in place. Two copies are made.

</details>

<details>
<summary>The token budget is 2,048 and 300 sequences are decoding. A 6,000-token prompt arrives. How long until its first token, roughly, and what would happen with a budget of 512?</summary>

Each step gives the decodes 300 tokens and the prompt the remaining 1,748, so the prompt needs four steps (1,748 × 3 = 5,244, then 756 more) and samples in the fourth. With a budget of 512, the prompt gets only 212 tokens a step and needs 29 steps, so its time to first token is much longer, though each step is shorter. With 512 or more decoding sequences and a budget of 512, it would never be admitted at all, which is why engines keep the budget well above the number of sequences.

</details>

<details>
<summary>Why does nano_engine's reference attention path gather each sequence's blocks into a contiguous tensor, and why do real engines avoid that?</summary>

`scaled_dot_product_attention` needs contiguous keys and values per sequence, so the reference path copies them out of the blocks first. That copy reads and writes the whole context in every layer, adding memory traffic to a step that is already memory-bound. A paged-attention kernel reads keys and values directly from the blocks through the block table.

</details>

## Further reading

- Kwon and others, [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180) (SOSP 2023): block tables, copy-on-write, all-or-nothing eviction, swapping and recomputation, and the block-size study.
- Agrawal and others, [Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve](https://www.usenix.org/conference/osdi24/presentation/agrawal) (OSDI 2024): chunked prefill, stall-free batching and the token budget.
- Yu and others, [Orca](https://www.usenix.org/conference/osdi22/presentation/yu) (OSDI 2022): iteration-level scheduling, which continuous batching comes from.
- The vLLM team, [vLLM V1: A Major Upgrade to vLLM's Core Architecture](https://blog.vllm.ai/2025/01/27/v1-alpha-release.html): the unified scheduler and the process split.
- vLLM's [scheduler](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py), [optimization and tuning guide](https://docs.vllm.ai/en/latest/configuration/optimization/) and [prefix caching design](https://docs.vllm.ai/en/latest/design/prefix_caching/): the production versions of this chapter's scheduler and block manager.
- [nano-vllm](https://github.com/GeeeekExplorer/nano-vllm): a small engine of about 1,200 lines that adds prefix caching, CUDA graphs and tensor parallelism, and is a good next read.
- FlashAttention's [interface](https://github.com/Dao-AILab/flash-attention/blob/main/flash_attn/flash_attn_interface.py), for the paged `block_table` arguments and their block-size rule.
- OpenAI's [chat completion streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events): the chunk format the server reproduces.
