# Inside vLLM

[Chapter 5.1](/learn/mini-inference-engine) built an engine in about 650 lines. vLLM is the same loop with three years of production requirements attached: the `vllm/v1` folder alone holds about 186,000 lines of Python at version 0.32.0, the scheduler's `schedule()` method is close to a thousand lines, and there are two model runners. This chapter is a map of that code. It follows one real request through a running server with a timer on every function it passes through, reads the engine loop, the scheduler and the block pool against the versions you wrote in nano_engine, shows where `torch.compile` and CUDA graphs enter, and measures what five settings do on an H100.

Everything here refers to one pinned version, **vLLM 0.32.0** (commit `5df63a7`, 17 October 2026), because vLLM changes quickly and a file path that is right today may be wrong next month. Every function name and default below was read from that source, and every number comes from a run you can repeat with [inside_vllm.py](/labs/infra/gpu/inside_vllm.py). Before this chapter, read [Build a mini inference engine](/learn/mini-inference-engine); it also helps to have read [PyTorch execution](/learn/pytorch-execution) for CUDA graphs and `torch.compile`.

## Two processes and three threads

nano_engine ran everything in one Python process, with the engine in a thread. vLLM's server splits the work across two processes, and the reason is Python's global interpreter lock. Parsing HTTP, applying a chat template, tokenizing and detokenizing are all Python work that holds the lock, and so is the scheduler. If they shared a process, a burst of long prompts being tokenized would delay the loop that feeds the GPU. vLLM therefore gives that loop a process of its own, called the engine core, and leaves everything that touches text in the API server process.

```diagram
title: One request through vLLM on a single GPU
[c:client] HTTP client @ 0,1
[a] API server\nAsyncLLM @ 1,1
[i] Input thread\ndecode, hash @ 2,0
[o] Output thread\nencode @ 2,2
[m] Main loop\nschedule, run @ 3,1
[g:store] GPU\nweights, KV cache @ 4,1
c <-> a : HTTP, SSE
a -> i
i -> m
m -> o
o -> a
m <-> g : kernels
```

In the diagram, the arrows between the API server and the two threads are ZeroMQ sockets, and the arrows between the threads and the main loop are in-process queues. The table lists the parts in the order a request meets them, with the file that holds each one (paths are under `vllm/`) and the part of nano_engine that does the same job.

| Part | File | What it does | In nano_engine |
|---|---|---|---|
| OpenAI endpoints | `entrypoints/openai/chat_completion/serving.py` | Validates the request, renders the chat template, tokenizes, streams the response as server-sent events | `server.py` |
| `AsyncLLM` | `v1/engine/async_llm.py` | The engine as the API server sees it: `generate()` returns an async generator of outputs for one request | `AsyncEngine` |
| `OutputProcessor` | `v1/engine/output_processor.py` | Detokenizes incrementally, checks stop strings, puts each result on its request's queue | `Detokenizer` |
| `AsyncMPClient` | `v1/engine/core_client.py` | Sends requests to the engine core and receives outputs over ZeroMQ sockets, serialized as msgpack | the two `asyncio` queues |
| `EngineCoreProc` | `v1/engine/core.py` | The engine core process: an input thread, an output thread and the main loop that calls `step` | `LLMEngine.step` |
| `Scheduler` | `v1/core/sched/scheduler.py` | Chooses the requests and token counts for each step, preempts, and applies the model's output | `scheduler.py` |
| `KVCacheManager`, `BlockPool` | `v1/core/kv_cache_manager.py`, `v1/core/block_pool.py` | Block tables, the free queue, reference counts and the prefix cache | `kv_cache.py` |
| Executor and `Worker` | `v1/executor/`, `v1/worker/gpu_worker.py` | Run the model runner: in the engine core's own process for one GPU, in one process per GPU for tensor parallelism, or on Ray | none |
| `GPUModelRunner` | `v1/worker/gpu/model_runner.py` | Builds the batch's tensors, runs the forward pass through a CUDA graph, samples | `engine._run`, `model.py` |

Three details in this table are easy to get wrong. First, with one GPU there are two processes, not three: the executor is `UniProcExecutor`, and the worker and model runner live inside the engine core process. A separate worker process per GPU appears only with tensor or pipeline parallelism (`MultiprocExecutor`). Second, 0.32.0 contains two model runners. The file `v1/worker/gpu_model_runner.py` (7,255 lines) is the original, and the folder `v1/worker/gpu/` holds Model Runner V2, whose README still calls it experimental but which is the one a default server uses: the server in this chapter logs `Using V2 Model Runner`. Setting `VLLM_USE_V2_MODEL_RUNNER=0` selects the old one. Third, the offline `LLM` class used in chapter 5.1's benchmark goes through the same engine core, with a synchronous client in place of `AsyncMPClient`.

## One request, traced

Reading code tells you what can happen. A trace tells you what did. The lab's script starts `vllm serve` with a timing wrapper around about twenty functions, sends a streamed chat request whose system prompt is about 2,000 tokens long, and then sends a second request with the same system prompt and a different question. vLLM starts its engine core by forking, so the child process inherits the wrappers, and because Linux's monotonic clock is shared by every process on the machine, the client's, the API server's and the engine core's times fit on one axis.

```widget
request-trace
```

The model is Llama 3.1 8B Instruct in BF16 on one H100. The first request has 2,022 prompt tokens. Its first streamed chunk reached the client 85.8 ms after the client sent it, and the time divides as follows.

| Milliseconds after the send | Where | What happened |
|---|---|---|
| 0 to 2.1 | API server | uvicorn and FastAPI read and parsed the request |
| 2.1 to 8.2 | API server | `create_chat_completion` ran for 6.1 ms, of which 5.7 ms was the chat template and the tokenizer |
| 9.1 to 9.4 | API server | `AsyncLLM._add_request` registered the request with the output processor and wrote it to the ZeroMQ socket (0.06 ms to encode it as msgpack) |
| 9.8 to 10.4 | Engine core, input thread | Decoded the message (0.12 ms) and built the scheduler's `Request`, hashing the prompt's 126 full blocks (0.45 ms) |
| 10.6 | Engine core, main loop | Took the request from its queue and appended it to the scheduler's waiting queue |
| 10.7 to 63.7 | Main loop, step 1 | `schedule()` took 0.59 ms: the prefix cache held 16 of the 2,022 tokens, and `allocate_slots` took 126 blocks for the other 2,006. `execute_model` then ran for 51.0 ms and `sample_tokens` for 1.1 ms |
| 63.7 to 82.7 | Main loop, step 2 | Scheduled the request's next token before the first one was known, launched that step in 1.3 ms, then waited 16.3 ms for the GPU to finish step 1. `update_from_output` (0.13 ms) appended the first token |
| 83.1 | Engine core, output thread | Encoded the output (0.016 ms) and sent it |
| 83.6 to 84.8 | API server | Decoded it (0.04 ms) and detokenized it in `process_outputs` (0.9 ms the first time, 0.06 ms afterwards) |
| 85.8 | Client | The first chunk arrived |

Of the 85.8 ms, about 72 ms is the engine core computing the prefill of 2,006 tokens and the first token, 8 ms is HTTP and tokenization, 2.5 ms is the hand-off from one process to the other, and 3.3 ms is the first token's way back. The 16 cached tokens are worth a note: the script sends a short warm-up request first, and Llama 3.1's chat template begins every conversation with the same header, so the first block of the traced request was already in the cache.

After the first token, the engine settles into steps of 6.6 ms, which is 151 tokens per second for this lone request. In a median step the main loop spends 0.11 ms in `schedule()`, 1.4 ms in `execute_model` (of which 0.42 ms copies the batch's token ids and positions into buffers on the GPU, and 0.03 ms replays the CUDA graph), 0.65 ms in `sample_tokens`, 0.06 ms in `update_from_output`, and 4.0 ms waiting for the GPU. The output thread encodes each message in 0.01 ms, and the API server spends 0.07 ms decoding and detokenizing it. With one request, vLLM's own Python costs about 2.5 ms per step, and the next section shows why that does not add to the step time.

The second request shows what the prefix cache does to the same prompt. `get_computed_blocks` found 2,000 of its 2,021 tokens, so the scheduler gave it 21 tokens and 2 new blocks instead of 2,006 and 126, and its first chunk arrived after 31.1 ms. The hit is 2,000 and not 2,016 for two reasons. The cache works in whole blocks of 16 tokens. And the two prompts differ only in the question, which begins inside the 126th block, so the first 125 blocks, 2,000 tokens, are identical.

## The engine core's loop

The main loop is `EngineCoreProc.run_busy_loop` in `v1/engine/core.py`, and it is four lines long.

```python
def run_busy_loop(self):
    while self._handle_shutdown():
        self._process_input_queue()     # block here while there is nothing to do
        self._process_engine_step()     # one call to self.step_fn(), outputs to the output queue
```

Two threads keep that loop away from sockets. `process_input_sockets` reads ZeroMQ messages, decodes them, turns each new request into a `Request` object with its block hashes already computed, and puts it on a `queue.Queue`. `process_output_sockets` takes finished outputs from another queue, encodes them and sends them. Both spend most of their time blocked on a socket or a queue, which releases the interpreter lock, so they rarely hold up the main loop.

`step_fn` is one of two functions. The plain one, `EngineCore.step`, is the loop of chapter 5.1 almost word for word:

```python
def step(self):                                    # abridged from v1/engine/core.py
    if not self.scheduler.has_requests():
        return {}, False
    scheduler_output = self.scheduler.schedule()
    future = self.model_executor.execute_model(scheduler_output, non_block=True)
    grammar_output = self.scheduler.get_grammar_bitmask(scheduler_output)
    model_output = future.result()
    if model_output is None:
        model_output = self.model_executor.sample_tokens(grammar_output)
    self._process_aborts_queue()
    engine_core_outputs = self.scheduler.update_from_output(scheduler_output, model_output)
    return engine_core_outputs, scheduler_output.total_num_scheduled_tokens > 0
```

The forward pass and sampling are separate calls so that a grammar's token mask for structured output can be computed on the CPU while the GPU runs the forward pass.

A default server does not use `step`. It uses `step_with_batch_queue`, because **asynchronous scheduling** is on by default for text generation. The idea is that the CPU work for step N+1 can be done while the GPU is still running step N. The function schedules a batch, launches it, and if the queue of launched batches is not yet full it returns at once to schedule the next one. Only when nothing more can be scheduled does it block on the oldest batch and apply its output. The queue holds 2 batches when there is no pipeline parallelism (`max_concurrent_batches` in `config/vllm.py`), so under load one batch is always in flight behind the one being waited for.

The trace shows this plainly. Step 2 was scheduled at 63.7 ms, when the request's first token did not exist yet: the scheduler counted it as an output placeholder (`num_output_placeholders`), and the model runner, which keeps each request's last sampled token on the GPU, fed it to the next step without the CPU ever seeing it. The main loop then waited in `AsyncOutput.get_output`, which blocks on a CUDA event recorded after a non-blocking copy of the sampled tokens to the CPU.

This is where the 2.5 ms of Python per decode step goes. The loop does its scheduling and input preparation for the next batch while the GPU is busy with the current one, and then waits 4.0 ms for the GPU. The step takes 6.6 ms because that is how long the GPU needs, and the Python is hidden inside it. In nano_engine the same work came between two GPU runs and added to every step.

Asynchronous scheduling has one cost. The scheduler learns that a request has finished one step late, so a request that stops on an end-of-sequence token may already have one more step in flight, and `update_from_output` skips that step's output for it. For a stop by `max_tokens` the scheduler can count ahead, and the code skips that extra step.

## The scheduler

`Scheduler.schedule()` in `v1/core/sched/scheduler.py` opens with a comment by Woosuk Kwon that states the model chapter 5.1 used: there is no decoding phase and no prefill phase, each request has a count of computed tokens and a count of tokens it has, and each step the scheduler assigns tokens so that the first can catch up with the second. The method then does what `nano_engine/scheduler.py` does, in the same order. With multimodal inputs, speculative decoding, LoRA limits, KV connectors and Mamba layers removed, the core reads like this.

```python
token_budget = self.max_num_scheduled_tokens          # max_num_batched_tokens unless speculative decoding

# First, the RUNNING requests.
req_index = 0
while req_index < len(self.running) and token_budget > 0:
    request = self.running[req_index]
    num_new_tokens = request.num_tokens_with_spec + request.num_output_placeholders - request.num_computed_tokens
    if 0 < long_prefill_token_threshold < num_new_tokens:
        num_new_tokens = long_prefill_token_threshold
    num_new_tokens = min(num_new_tokens, token_budget)
    while True:
        new_blocks = self.kv_cache_manager.allocate_slots(request, num_new_tokens)
        if new_blocks is not None:
            break                                      # it fits
        preempted_req = self.running.pop()             # FCFS: the request that started running last
        self._preempt_request(preempted_req, scheduled_timestamp)
        preempted_reqs.append(preempted_req)
        if preempted_req == request:
            break                                      # it preempted itself: nothing left to take from
    if new_blocks is None:
        break
    num_scheduled_tokens[request.request_id] = num_new_tokens
    token_budget -= num_new_tokens
    req_index += 1

# Next, the WAITING requests, but only if nothing was preempted in this step.
if not preempted_reqs:
    while self.waiting and token_budget > 0:
        if len(self.running) >= self.max_num_active_reqs:
            break
        request = self.waiting.peek_request()
        if request.num_computed_tokens == 0:           # a new request: look for a cached prefix
            new_computed_blocks, num_new_local_computed_tokens, _ = self.kv_cache_manager.get_computed_blocks(request)
        num_new_tokens = request.num_tokens - num_computed_tokens
        if not self.scheduler_config.enable_chunked_prefill and num_new_tokens > token_budget:
            break
        num_new_tokens = min(num_new_tokens, token_budget)
        new_blocks = self.kv_cache_manager.allocate_slots(request, num_new_tokens, ..., new_computed_blocks)
        if new_blocks is None:
            break                                      # no room: stop admitting
        self.waiting.pop_request()
        self.running.append(request)
        token_budget -= num_new_tokens
```

You have written every line of this already. What vLLM adds is worth knowing, because each addition answers a problem found in production.

Preemption is by recomputation only. `_preempt_request` frees the request's blocks, sets `num_computed_tokens` to 0, increments its preemption count and puts it at the front of the waiting queue. With the default first-come-first-served policy the victim is `self.running.pop()`, the request that entered the running list last. With `--scheduling-policy priority` it is the request with the worst priority, and among equals the latest arrival.

A waiting request must fit whole. `scheduler_reserve_full_isl` is on by default, and with it `allocate_slots` admits a new request only if the cache has room for its whole prompt and not just its first chunk. Without that check, chunked prefill lets in more long prompts than the cache can hold, and they preempt each other halfway through. A second setting, `watermark`, keeps a fraction of the blocks free at admission time so that running requests have room to grow; its default is 0.

A running request that cannot use its tokens does not block the ones behind it. Where nano_engine's loop would stop, vLLM's `continue`s to the next running request, and a comment says so plainly: the loop does not strictly follow first-come-first-served order.

Chunked prefill has an optional second limit. `max_num_batched_tokens` bounds a whole step. `long_prefill_token_threshold`, 0 by default, bounds how many prompt tokens a single request may take in one step, so that one long prompt cannot use the whole budget while other requests wait. The code skips the limit when the request is the only one.

The other half of the scheduler is `update_from_output`, which runs after the model. It appends each request's sampled tokens, checks the stop conditions that need only token ids (end of sequence, stop token ids and the length limits), frees finished requests, and builds one `EngineCoreOutput` per request that produced something. Stop strings are checked later, in the API server, because they need text: when the output processor sees one, it tells the engine core to abort the request.

## The block pool and the prefix cache

nano_engine's `BlockManager` was a deque of free block ids and a list of reference counts. vLLM's `BlockPool` (`v1/core/block_pool.py`) has the same two things and one more: a table from a block's content hash to the block, which turns the free list into a cache.

Each `KVCacheBlock` holds its id, a reference count, an optional hash, and two pointers, `prev_free_block` and `next_free_block`. The pointers make the free blocks a doubly linked list, `FreeKVCacheBlockQueue`. vLLM does not use a `deque` here because a prefix-cache hit has to remove a block from the middle of the free list, and a linked list does that in constant time.

The hash of a block covers its 16 token ids and the hash of the block before it (`hash_block_tokens` in `kv_cache_utils.py`), so a block's hash identifies the whole prompt up to and including that block. Two requests with the same first 2,000 tokens have the same first 125 hashes, whatever follows. The hashes use SHA-256 by default, and they are computed once per request, on the input thread.

The design rests on one decision: **a freed block keeps its hash and its contents**. When a request finishes, its blocks' reference counts drop to 0 and they go back on the free queue, but they stay in the hash table. From then on each of them is two things at once, a free block that any request may take and a cached prefix that a later request may reuse. Four functions implement this.

- `get_computed_blocks(request)` walks the request's hashes in order and collects blocks from the table until one is missing. It stops at most one token short of the whole prompt, because the last token must be run to produce logits.
- `touch(blocks)` claims the blocks that were found. It adds 1 to each reference count, and if the count was 0 it unlinks the block from the free queue. Two running requests with the same prefix therefore share blocks, each holding a reference.
- `get_new_blocks(n)` pops n blocks from the front of the free queue. If a popped block still has a hash, the hash is removed from the table at that moment. Eviction is nothing more than this: a cached block is evicted when it is handed out again.
- `free_blocks(blocks)` puts blocks whose reference count has reached 0 back on the queue. Blocks with a hash go to the back, so the least recently used cached block is the next to be evicted. Blocks without a hash, such as a partly filled last block, go to the front, because they are worth nothing as cache and should be reused first. A request's blocks are freed in reverse order, so the end of a prompt is evicted before its beginning, and a prefix stays reusable for as long as possible.

The consequence is that the prefix cache has no size setting and costs no memory. It lives in whatever part of the KV cache is not in use, and it shrinks to nothing under load, when running requests need every block.

A block is entered in the table only when it is full, and a block with a hash is never written again, so sharing needs no copy-on-write for full blocks. Block 0 is reserved as a null block that pads block tables.

## Where torch.compile and CUDA graphs fit

A server that takes two minutes to start is doing three things that nano_engine did not. The log of the traced server shows each of them.

```text
Model loading took 15.0 GiB memory and 51.716951 seconds
[backbone] Compiling a graph for compile range (1, 8192) takes 6.78 s
[backbone] torch.compile took 17.70 s in total
Available KV cache memory: 55.06 GiB
GPU KV cache size: 451,056 tokens, Maximum concurrency for 4,096 tokens per request: 110.12x
CUDA graph pool memory: 0.45 GiB (actual), 0.9 GiB (estimated), difference: 0.45 GiB (100.4%).
Free memory on device (78.66/79.17 GiB) on startup. Desired GPU memory utilization is (0.92, 72.84 GiB). Actual usage
is 15.81 GiB for consumed memory (weights + non-torch), 1.97 GiB for peak activation, and 0.45 GiB for CUDAGraph memory.
init engine (profile, create kv cache, warmup model) took 111.60 s (compilation: 17.70 s)
```

First it compiles the model. vLLM's compilation mode (`CompilationMode.VLLM_COMPILE`, in `config/compilation.py`) traces the model once with `torch.compile` for any batch from 1 to `max_num_batched_tokens` tokens and splits the traced graph at each attention operation. The pieces between two attention calls contain only operations with fixed shapes for a given number of tokens, which is what a CUDA graph needs. Attention is left outside the pieces because its work depends on how long each request's context is.

Then it sizes the KV cache, the way chapter 5.1 did: it runs a profile pass at the full token budget, reads the peak, and gives the cache what is left of `gpu_memory_utilization`. Here 0.92 of 79.17 GiB is 72.84 GiB, the weights and other fixed memory take 15.81 GiB and the peak of activations 1.97 GiB, and the remaining 55.06 GiB holds 451,056 tokens at 131,072 bytes each.

Then it captures CUDA graphs, in the default mode `FULL_AND_PIECEWISE`, for a fixed list of batch sizes. There are two kinds of graph. A **full** graph records the whole forward pass, attention included, and is valid only for a batch in which every request runs exactly one token, which is a pure decode step. A **piecewise** graph is one small graph per compiled piece, with attention called normally between them, and is valid for any batch of that many tokens, prefill chunks included. The list of sizes is 1, 2, 4, then every multiple of 8 up to 248, then every multiple of 16 from 256 up to a maximum that defaults to 512, which makes 51 sizes. A piecewise graph is captured for every size, and a full graph for every size a batch of decodes can have: on the A10 run of this lab, where `max_num_seqs` defaulted to 256, the log shows 51 piecewise captures and 35 full ones. A batch is padded up to the next size in the list, as in the graph-padding widget of [PyTorch execution](/learn/pytorch-execution).

At each step `CudagraphDispatcher.dispatch` (`v1/cudagraph_dispatcher.py`) picks one of three paths: the full graph if the batch is all decodes and its size was captured, otherwise the piecewise graph if the token count is at most the largest captured size, and otherwise the compiled model with no graph at all. The trace caught all three.

| Step in the trace | Tokens | Path | Time inside `execute_model` |
|---|---|---|---|
| A decode step | 1 | Full graph, replayed in 0.03 ms | 1.4 ms |
| Request 2's prefill | 21 | Piecewise graphs, 10.9 ms | 14.2 ms |
| Request 1's prefill | 2,006 | No graph, because 2,006 is more than 512 | 51.0 ms |

A decode step costs the main loop about a millisecond however many layers the model has, because replaying a graph is one call. This is the mechanism behind chapter 5.1's result that vLLM with graphs was 1.12 times faster than vLLM without them on the benchmark, and it is why the full graph is reserved for decode steps, where the GPU's work is short and the launch overhead would otherwise be a large part of it. A prefill of thousands of tokens keeps the GPU busy for tens of milliseconds whichever way it is launched.

## Five settings, measured

Most of vLLM's flags do not change performance. Five do, and they are the ones an interviewer or an on-call page will ask you about. Their defaults are not where you might look for them: `SchedulerConfig` declares 2,048 tokens and 128 sequences, with a comment that those values are for tests, and the real defaults are chosen at startup from the GPU's memory in `EngineArgs.get_batch_defaults` (`engine/arg_utils.py`).

| Setting | Default in 0.32.0 | What it bounds |
|---|---|---|
| `max_num_seqs` | 1,024 on a GPU with at least 70 GiB that is not an A100, otherwise 256 | Requests in the running list at once. It also sizes the model runner's buffers and the CUDA graphs |
| `max_num_batched_tokens` | For the server, 8,192 on those large GPUs and 2,048 on others. For the offline `LLM` class, 16,384 and 8,192 | Tokens in one step, which is the chunked-prefill budget |
| `gpu_memory_utilization` | 0.92 | The share of the GPU's memory this server may use. The KV cache gets what the weights, activations and CUDA graphs leave |
| `enable_prefix_caching` | On | Whether freed blocks stay findable by hash |
| `enable_chunked_prefill` | On | Whether a prompt longer than the remaining budget is split across steps |

A GPU with 160 GiB or more, such as a B200, gets 16,384 tokens and 1,024 sequences in both modes, and `--performance-mode throughput` doubles whichever of the two limits you did not set yourself.

The lab measures these with the workload of chapter 5.1 sent over HTTP: 256 streamed requests to Llama 3.1 8B on an H100, prompt and output lengths each drawn between 100 and 1,024 tokens, all sent at the same moment. It reports output tokens per second over the whole burst, the time to the first token, the time per token once a request is decoding, and the 99th-percentile gap between two chunks of one stream.

| Configuration | KV cache, tokens | Output tokens/s | First token, median | First token, p99 | Per token, median | Longest gap in a stream | Preemptions |
|---|---|---|---|---|---|---|---|
| Defaults (1,024 sequences, 8,192 tokens, 0.92) | 451,056 | 8,332 | 2.2 s | 3.6 s | 17.1 ms | 376 ms | 0 |
| `max_num_seqs=16` | 461,824 | 2,029 | 30.7 s | 61.9 s | 7.5 ms | 189 ms | 0 |
| `max_num_seqs=64` | 460,864 | 5,221 | 8.7 s | 19.3 s | 10.2 ms | 189 ms | 0 |
| `max_num_batched_tokens=1024` | 451,952 | 8,191 | 2.4 s | 4.8 s | 17.0 ms | 70 ms | 0 |
| `max_num_batched_tokens=16384` | 445,968 | 8,319 | 2.3 s | 3.5 s | 17.1 ms | 394 ms | 0 |
| `gpu_memory_utilization=0.3` | 50,816 | 4,713 | 9.9 s | 22.2 s | 10.5 ms | 3,481 ms | 172 |
| `gpu_memory_utilization=0.3`, `max_num_seqs=64` | 60,624 | 5,130 | 9.5 s | 19.8 s | 10.2 ms | 629 ms | 41 |

The default server reaches 8,332 output tokens per second over HTTP. Chapter 5.1 measured 8,189 for the same requests through the offline `LLM` class, so on this workload the API server, its sockets and 256 open streams cost nothing measurable.

**`max_num_seqs` trades time per token against time in the queue.** With 16 requests running, each one receives a token every 7.5 ms, more than twice as often as with all 256 running (17.1 ms). But a step with 256 requests takes only a little over twice as long as a step with 16, because every decode step reads all of the model's weights once whatever the batch size ([Inference arithmetic](/learn/inference-arithmetic)). So the server limited to 16 produces a quarter of the tokens per second, and the other 240 requests wait: the median request saw its first token after 30.7 seconds. Lower it only when you have a per-token latency target that the full batch misses, and expect to pay for it in queueing.

**`max_num_batched_tokens` moves stalls around and leaves throughput alone.** From 1,024 to 16,384 tokens per step the throughput stays within 2%. What changes is the shape of the latency. With a budget of 1,024, no stream ever waited more than 70 ms between two chunks, because no step can hold more than 1,024 tokens, but prompts are absorbed more slowly and the 99th-percentile time to first token rises from 3.6 to 4.8 seconds. With 8,192 or 16,384, a step full of prefill takes a few hundred milliseconds, and every running stream waits for it: the longest gap is 376 and 394 ms. This is the stall of chapter 5.1 on a real server. A chat service that streams text to people wants the smaller budget, and a batch job that only counts total time wants the larger one.

**`gpu_memory_utilization` sets the size of the KV cache, and a cache that is too small appears as preemptions.** At 0.3 the server may use 23.8 GiB. The weights and activations still take about 17.6 GiB, so the cache falls from 451,056 tokens to 50,816, a factor of nine for a factor of three in the setting. The workload's requests reach about 1,100 tokens of context on average, so that cache holds fewer than 50 of them, while `max_num_seqs` still allows 1,024. The scheduler admits requests while their prompts fit, their outputs grow, and the cache fills: 172 preemptions, each of which throws away a request's computed tokens, and one stream that stopped for 3.5 seconds while it waited to be run again. Throughput is 4,713 tokens per second, below even the 5,221 of the full-memory server limited to 64 sequences. Capping `max_num_seqs` at 64 on the small cache cuts the preemptions to 41 and the longest gap to 0.6 seconds, and throughput rises to 5,130. When memory is short, the right concurrency limit is the one the cache can hold. The table also shows a smaller effect: the cache's size depends a little on `max_num_seqs`, because fewer sequences mean smaller buffers and fewer CUDA graphs, and at 0.3 that difference is 9,808 tokens, or 19%.

**Prefix caching removes the shared part of a prompt.** The last experiment sends 64 requests that share a 3,000-token prefix and differ in their final 50 tokens. The first goes alone, and the other 63 follow together once it has finished.

| | The 63 requests, total | First token, median | First token, p99 | Prompt tokens found in the cache |
|---|---|---|---|---|
| Prefix caching on (default) | 0.38 s | 282 ms | 289 ms | 188,496 of 195,200 |
| `--no-enable-prefix-caching` | 4.81 s | 2,463 ms | 4,661 ms | 0 |

With the cache, each of the 63 requests finds 187 full blocks, 2,992 tokens, and computes only its last 58. The burst finishes 12.7 times sooner and the median first token arrives 8.7 times sooner. This is the case the cache is for: a long system prompt, a shared document, or a conversation that resends its history every turn. The first request's time to first token is the same either way, about 80 ms, because somebody has to compute the prefix once. The next chapter compares this block-hash cache with SGLang's radix tree.

One caution about all of these numbers. A burst of 256 simultaneous requests is the worst case for time to first token, and a real service sees requests arrive over time. The directions of the effects hold, but the right values for your service come from a load test at your own arrival rate and length distribution, watching `vllm:num_preemptions`, `vllm:kv_cache_usage_perc`, `vllm:num_requests_waiting` and the time-to-first-token and inter-token latency histograms that the server exports at `/metrics`.

## Lab: trace a request and read the code

**Tier: [1 GPU].** The lab needs an NVIDIA GPU with vLLM 0.32.0, and Part C needs only a checkout of the source.

The script is [inside_vllm.py](/labs/infra/gpu/inside_vllm.py). It runs through the same launchers as the other GPU labs, on the image that has vLLM installed.

```bash
cd gpu
modal run modal_run.py --script inside_vllm.py --gpu 'H100!' --vllm --args "trace"     # about 4.5 min of GPU time, $0.30
modal run modal_run.py --script inside_vllm.py --gpu 'H100!' --vllm --args "knobs"     # about 12 min of GPU time, $0.80
modal run modal_run.py --script inside_vllm.py --gpu A10 --vllm --args "trace --quick" # Llama 3.2 1B: 2.5 min, $0.05
modal run modal_run.py --script inside_vllm.py --gpu A10 --vllm --args "knobs --quick" # 10 min, $0.19
python gcp_run.py --script inside_vllm.py --gpu A100-80GB --vllm --args "trace"
git clone --depth 1 --branch v0.32.0 https://github.com/vllm-project/vllm.git           # for Part C
```

**Part A, the trace.** Run the `trace` experiment and open `vllm_trace.json` in [Perfetto](https://ui.perfetto.dev), which shows the two processes and their threads as lanes. From your own run, write down how the first request's time to first token divides between the API server, the hand-off, the prefill and the way back, and what changed for the second request. Then add one function of your choice to the script's `TARGETS` list, run it again, and say what you learned from it.

**Part B, the settings.** Run the `knobs` experiment. For each configuration, predict before you look whether throughput, time to first token and time per token will go up or down against the defaults, then explain each result from the scheduler's code.

**Part C, read and contribute.** Follow the reading map in the reference solution through a checkout of v0.32.0, answering its question at each stop from the code. Then do one of two things. Either make a small real contribution to vLLM: a documentation fix, a missing test, or a small bug, following the project's contributing guide. Or write a one-page design note on one subsystem, such as the block pool, for a reader who has not seen the code: what it stores, its invariants, the one decision that the rest follows from, and what you would measure before changing it.

<details>
<summary>Reference solution</summary>

*Part A.* The trace and its breakdown are in the section "One request, traced" above; the report is [inside_vllm_trace.json](/labs/infra/gpu/inside_vllm_trace.json) and the Perfetto file is [vllm_trace.json](/labs/infra/gpu/vllm_trace.json). Two runs of the same script on different H100 hosts gave 60.1 ms and 85.8 ms to the first token of the first request and 23.6 ms and 31.1 ms for the second. The decode step was 6.5 to 6.6 ms in both. The difference between hosts was in the prefill step and in the CPU-side functions, which is a reminder that a single latency measurement of a server is one sample.

The reference run added four functions inside the model runner to the first version of the script: `prepare_inputs`, `prepare_attn`, `run_fullgraph` and `run_pw_graph`. They are what showed that a decode step replays a full graph in 0.03 ms, that the 21-token prefill went through piecewise graphs, and that the 2,006-token prefill ran neither.

If the report prints `warning: only one process was traced`, the engine core was started with `spawn` and did not inherit the wrappers. That happens if something initializes CUDA in the API server process before the engine starts.

*Part B.* The measurements and their explanations are in the section "Five settings, measured". The A10 run with Llama 3.2 1B is in [inside_vllm_knobs_a10_quick.json](/labs/infra/gpu/inside_vllm_knobs_a10_quick.json).

*Part C.* The reading map follows a request, so each stop explains the next. Paths are under `vllm/` at v0.32.0.

| Stop | Open | Question to answer from the code |
|---|---|---|
| 1 | `entrypoints/openai/chat_completion/serving.py`, `create_chat_completion` | Where does tokenization happen, and what does the handler return for a streamed request? |
| 2 | `v1/engine/async_llm.py`, `generate`, `_add_request` and `_run_output_handler` | Which object does a request's generator read from, and which task fills it? |
| 3 | `v1/engine/core_client.py`, `EngineCoreClient.make_client` | Which three clients exist, and which entry point uses each? |
| 4 | `v1/engine/core.py`, `process_input_sockets` and `preprocess_add_request` | What work is done on the input thread, and why there? |
| 5 | `v1/engine/core.py`, `run_busy_loop`, `step`, `step_with_batch_queue` | When does `step_with_batch_queue` return without waiting for the GPU? |
| 6 | `v1/core/sched/scheduler.py`, `schedule` | Under which condition are waiting requests not considered at all in a step? |
| 7 | `v1/core/sched/scheduler.py`, `_preempt_request` | What state does a preempted request keep, and where in the waiting queue does it go? |
| 8 | `v1/core/kv_cache_manager.py`, `get_computed_blocks` and `allocate_slots` | Why can a cache hit never cover the whole prompt? |
| 9 | `v1/core/block_pool.py`, `get_new_blocks`, `touch`, `free_blocks`; `v1/core/kv_cache_utils.py`, `FreeKVCacheBlockQueue` | In what order are blocks evicted, and which blocks jump the queue? |
| 10 | `v1/worker/gpu/model_runner.py`, `execute_model` and `sample_tokens` | Which three ways can the forward pass be launched? |
| 11 | `v1/cudagraph_dispatcher.py`, `dispatch`; `config/compilation.py`, `CUDAGraphMode` | What makes a batch eligible for a full graph? |
| 12 | `v1/core/sched/scheduler.py`, `update_from_output`; `v1/engine/output_processor.py`, `process_outputs` | Which stop conditions are checked in the engine core, and which in the API server? |
| 13 | `engine/arg_utils.py`, `get_batch_defaults`; `config/scheduler.py`; `config/cache.py` | What are the default token and sequence limits on your GPU? |

The answers, in order. (1) `render_chat_request` applies the template and tokenizes in the API server; the handler returns an async generator, `chat_completion_stream_generator`, that the response iterates. (2) A `RequestOutputCollector` per request, filled by the single `output_handler` task, which pulls from the engine core and calls `process_outputs` on up to `VLLM_V1_OUTPUT_PROC_CHUNK_SIZE` outputs at a time, yielding to the event loop between chunks. (3) `AsyncMPClient` for the server, `SyncMPClient` for the offline `LLM` class, and `InprocClient`, with no second process, when `VLLM_ENABLE_V1_MULTIPROCESSING=0`. (4) Decoding, building the `Request` with its block hashes, and starting grammar compilation for structured output, so that they overlap with the main loop's GPU work instead of delaying it. (5) When it has just scheduled and launched a batch, the batch queue is not full, and there is still something to schedule. (6) When a request was preempted in the same step, or the scheduler is paused. (7) Its token ids, including the output so far, and its preemption count; its computed-token count returns to 0 and it goes to the front. (8) `max_cache_hit_length` is the prompt length minus one, because the last token must be run to produce logits, and hits are whole blocks. (9) From the front of the free queue: unhashed blocks first, then cached blocks from least to most recently freed, and within one request the tail of the prompt before its head. (10) `run_fullgraph`, `run_pw_graph`, or a direct call of the compiled model. (11) Every request in it runs exactly one token, and a full graph was captured for its padded size. (12) End of sequence, stop token ids and the length limits in `update_from_output`; stop strings in the output processor, which then aborts the request. (13) On an H100 the server defaults to 8,192 tokens and 1,024 sequences.

For the contribution, small documentation fixes are a fair start, and reading with a specific question is how you find them. Three that this chapter's reading turned up at v0.32.0, which you should check against `main` before proposing anything, since they may be fixed already: the `README.md` in `v1/worker/gpu/` calls Model Runner V2 experimental although it is the default; the docstring of `cudagraph_mode` says the mode "is only used for the v1 engine", which is now the only engine; and `SchedulerConfig`'s field defaults (2,048 and 128) differ from the values a server actually starts with, which the field docstrings mention only as "for convenience when testing". A design note on the block pool can follow the section above: state the invariant that a hashed block is never written, and the decision that a freed block keeps its hash.

</details>

## Interview angle

"Walk me through what happens to a request in vLLM" is a common opening question for inference roles, and the answer that lands is the one with processes and threads in it: the API server tokenizes, a ZeroMQ message crosses to the engine core, an input thread hashes the prompt, the main loop schedules, launches and waits, an output thread sends tokens back, and the API server detokenizes. Say why the split exists (the interpreter lock) and what asynchronous scheduling buys (the CPU work overlaps the GPU's).

Expect follow-ups on the scheduler: what happens when the KV cache is full (the newest running request is preempted and recomputed later, and no new request is admitted in that step), why a long prompt does not stall other streams (the token budget, and optionally the per-request prefill limit), and how the prefix cache evicts (it does not need to: cached blocks sit in the free queue and are overwritten in least-recently-used order).

For tuning questions, tie each setting to the quantity it bounds. `max_num_seqs` trades time per token against queueing time. `max_num_batched_tokens` trades the longest gap in a running stream against how fast prompts are absorbed. `gpu_memory_utilization` sets the KV cache's size, and a cache that is too small for the admitted requests shows up as preemptions, which the `vllm:num_preemptions` counter reports. Quote a number from a run of your own if you have one.

## Check yourself

<details>
<summary>Why does vLLM's server run the engine core in a separate process from the API server?</summary>

Tokenizing, detokenizing and serving HTTP are Python work that holds the global interpreter lock, and so are the scheduler and the code that launches each step. In one process they would take turns, and a burst of long prompts being tokenized would delay the loop that feeds the GPU. With two processes, each has its own interpreter lock, and requests and outputs cross between them as msgpack messages over ZeroMQ, which the trace measured at about 0.01 to 0.1 ms each.

</details>

<details>
<summary>In the trace, the scheduler scheduled the request's second step before its first token was known. How can that work?</summary>

With asynchronous scheduling the scheduler counts a token that is being generated as an output placeholder, and schedules the next step on the assumption that it will exist. The model runner keeps each request's last sampled token on the GPU and uses it as the next step's input, so the CPU does not need the token's value to launch the step. The main loop reads the value later, when it processes the first step's output.

</details>

<details>
<summary>A request's prompt is 2,021 tokens and all of it was sent before. Why did the prefix cache return 2,000 tokens and not 2,021?</summary>

A cache hit is made of whole blocks of 16 tokens, and it may cover at most the prompt minus its last token, because that token has to be run to produce the logits for the first output token. In the traced request the two prompts also differed from the 126th block on, so the hit was 125 blocks, 2,000 tokens. Even for an identical prompt of 2,021 tokens the hit would be 2,016 tokens, 126 blocks.

</details>

<details>
<summary>How does vLLM decide which cached prefix to evict when the KV cache fills up?</summary>

It does not decide separately. A freed block that has a hash goes to the back of the free queue and stays in the hash table. New allocations take blocks from the front of the queue, and when a taken block still has a hash, the hash is removed. So cached blocks are overwritten in least-recently-freed order, after all blocks without a hash, and a request's blocks are queued tail first so that the start of a prompt outlives its end.

</details>

<details>
<summary>Which batches can replay a full CUDA graph, and what do the others use?</summary>

A batch in which every request runs exactly one token, whose padded size was captured at startup, replays a full graph that includes attention. A batch that contains a prefill chunk uses piecewise graphs, one per compiled piece between attention calls, if its token count is at most the largest captured size (512 by default). A larger batch calls the compiled model without a graph.

</details>

<details>
<summary>You start vLLM on an H100 with no flags. How many tokens can one step hold, and how many requests can run at once?</summary>

The server defaults are chosen from the GPU's memory in `get_batch_defaults`: with at least 70 GiB on a GPU that is not an A100, 8,192 tokens per step and 1,024 running requests. The values 2,048 and 128 in `SchedulerConfig` are placeholders for tests.

</details>

## Further reading

- [vLLM source at v0.32.0](https://github.com/vllm-project/vllm/tree/v0.32.0), especially [scheduler.py](https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/v1/core/sched/scheduler.py), [core.py](https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/v1/engine/core.py) and [block_pool.py](https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/v1/core/block_pool.py). Every function name and default in this chapter was read from this tag.
- [vLLM V1: a major upgrade to vLLM's core architecture](https://blog.vllm.ai/2025/01/27/v1-alpha-release.html), the vLLM team's account of why the engine core became its own process.
- [Inside vLLM: anatomy of a high-throughput LLM inference system](https://blog.vllm.ai/2025/09/05/anatomy-of-vllm.html), by Aleksa Gordić, a long walk through an earlier version of the same code.
- vLLM documentation: [architecture overview](https://docs.vllm.ai/en/latest/design/arch_overview.html), [automatic prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html), [CUDA graphs](https://docs.vllm.ai/en/latest/design/cuda_graphs.html) and [optimization and tuning](https://docs.vllm.ai/en/latest/configuration/optimization.html).
- Kwon et al., [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180) (SOSP 2023), the paper vLLM began with.
- Agrawal et al., [Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve](https://arxiv.org/abs/2403.02310) (OSDI 2024), the source of the token budget and chunked prefill.
