# PyTorch execution for inference

Chapter 2.5 profiled one decode step of Llama 3.2 1B on an H100 and found the GPU idle for most of it: hundreds of tiny kernels, each launched separately by Python, and a GPU that finishes each one before the CPU has launched the next. This chapter is about the layer between the model's code and the GPU that causes that idleness and removes it. It covers what eager PyTorch does for every operation, how CUDA graphs record a whole step and replay it with one call, what `torch.compile` adds by fusing kernels, why shapes that change every step defeat both, and how PyTorch's caching allocator manages GPU memory underneath. The lab applies each technique to the same decode step and measures it: the step goes from 9.44 ms to 1.82 ms on an H100.

Before this chapter, read [profiling and benchmarking](/learn/profiling), whose decode-step profile is the starting point here, and [how a GPU executes code](/learn/gpu-execution).

## What eager mode costs

In eager mode, the default, PyTorch runs a model the way Python runs any program: one operation at a time, in the order the code calls them. Each operation passes through Python, then PyTorch's C++ dispatcher, which picks the implementation for the tensors' device and type, and finally the CUDA driver, which queues the kernel on the GPU. The launch is asynchronous, so Python moves on to the next operation while the GPU works. As long as the CPU queues kernels faster than the GPU finishes them, the GPU stays busy and the CPU's cost is hidden.

A batch-1 decode step breaks that assumption. Most of its kernels are tiny: an RMSNorm over 2,048 numbers, a rotary embedding on one token's queries, an addition of two vectors. The lab's [decode_runtime.py](/labs/infra/gpu/decode_runtime.py) measured the cost directly on an H100 by launching 200 kernels that each add 1 to a 1,024-element tensor:

```text
1. 200 tiny kernels
   launched one by one: 1,036 us (5.2 us per kernel)
   replayed as a graph: 238 us (1.2 us per kernel), 4.4 times faster
```

The GPU's work for all 200 kernels, measured by the profiler, was 218 µs, about 1.1 µs each, while launching them one by one from Python took 5.2 µs each. The GPU therefore spent about four fifths of the time waiting. The second line is the subject of the next section. NVIDIA's own introduction to CUDA graphs reports similar orders of magnitude on older hardware: on a V100, a 2.9 µs kernel took 3.8 µs per kernel when launched back to back from C++, with no Python involved.

The decode step from chapter 2.5 behaves the same way at scale. In this chapter's lab, Hugging Face's standard forward pass for Llama 3.2 1B launched 695 kernels per step, which added up to 2.20 ms of GPU work, while the step took 9.44 ms. The roofline estimate from Part 1, the time to read the model's 2.47 GB of weights once at the H100's 3.35 TB/s, is 0.74 ms. The widget below models the effect. Set the CPU time per launch above the GPU time per kernel to see a launch-bound workload, then raise the kernel time to see the GPU take over as the limit:

```widget
launch-overhead
```

There are three ways to shrink the gap: launch the same kernels more cheaply, launch fewer and larger kernels, or give each kernel more work, for example with a larger batch. CUDA graphs do the first, `torch.compile` does the second, and the batching in a serving engine, the subject of Part 5, does the third.

## CUDA graphs: record once, replay many times

NVIDIA's CUDA Programming Guide defines a CUDA graph as a series of operations, such as kernel launches and memory copies, connected by dependencies, which can be defined once and then launched repeatedly. Work submitted through a graph goes through three stages. Definition describes the operations, instantiation validates the graph and does most of the setup that a launch would otherwise repeat, and execution launches the instantiated graph, as often as needed, with little overhead per launch. The easiest way to define a graph is stream capture: the program calls `cudaStreamBeginCapture`, issues its kernels as usual, and calls `cudaStreamEndCapture`, and the kernels are recorded into a graph instead of being run.

PyTorch exposes graphs through `torch.cuda.CUDAGraph` and the convenience wrappers `torch.cuda.graph` and `torch.cuda.make_graphed_callables`. A replay, in the words of PyTorch's CUDA documentation, skips all layers of argument setup and kernel dispatch, including Python, C++ and CUDA driver overheads, and submits the whole graph's work with a single call to `cudaGraphLaunch`. The lab captures 200 kernels like this:

```python
side = torch.cuda.Stream()                  # warm up on a side stream, as PyTorch's docs require
side.wait_stream(torch.cuda.current_stream())
with torch.cuda.stream(side):
    tiny_kernels()
torch.cuda.current_stream().wait_stream(side)

tiny_graph = torch.cuda.CUDAGraph()
with torch.cuda.graph(tiny_graph):
    tiny_kernels()                          # recorded, not run
tiny_graph.replay()                         # runs all 200 kernels with one launch
```

The replay ran the same 200 kernels in 238 µs, 1.2 µs per kernel, close to the GPU's own 1.1 µs of work per kernel. That is 4.4 times faster than launching them from Python.

A graph's speed comes from freezing everything about the work, and the rules for capture follow from that. PyTorch's documentation lists them:

- **Every replay uses the same memory addresses.** A graph records pointers, not tensors, so new inputs must be copied into the tensors that were captured, and outputs are read from the captured output tensors. The program must keep those tensors alive.
- **Shapes cannot change.** A kernel's grid size and arguments are fixed at capture, so dynamic shapes are prohibited. Different shapes need different graphs.
- **Nothing may synchronize the CPU with the GPU during capture.** Calls such as `.item()` or `torch.cuda.synchronize()` are prohibited, and so is control flow that depends on GPU data, unless it is written with `torch.cond`.
- **CPU work is not recorded.** Python code inside the captured region runs once, during capture, and is skipped on every replay.
- **Warm up first, on a side stream.** One-time work, such as allocating a cuBLAS workspace, should happen before capture. Memory allocated during capture comes from a private memory pool that belongs to the graph.

The rule about addresses is why a CUDA graph alone cannot capture Hugging Face's default decode step. Its default KV cache, a dynamic cache, grows by concatenation: every step allocates new, longer key and value tensors at new addresses, and the attention kernels see a longer sequence each time. A static KV cache, which transformers enables with `cache_implementation="static"` or a `StaticCache` object, preallocates every layer's keys and values for a maximum length and writes each new token in place. In transformers 5.22 the static cache also keeps its own write position as a tensor on the GPU, so a decode step has the same shapes, the same addresses and no Python-side state that changes. The lab sets one up for 1,024 positions:

```python
cache = StaticCache(config=model.config, max_cache_len=1024)
tok = torch.zeros(1, 1, dtype=torch.long, device="cuda")   # the captured input

def step():
    logits = model(input_ids=tok, past_key_values=cache, use_cache=True).logits
    tok.copy_(logits[:, -1:].argmax(-1))                     # write the next input in place
```

Switching to the static cache made the eager step slower, 11.62 ms against 9.44 ms, with 831 kernels instead of 695. Every layer now writes its new key and value into the cache in place and advances the cache's position counter, and attention runs over all 1,024 slots under a mask. Those operations add little GPU work, 2.67 ms against 2.20 ms, but in a step limited by launches each one adds CPU time. Capturing that step in a graph by hand then cut it to 2.79 ms, 3.4 times faster than the original, with the GPU busy for 2.58 ms of it. Warming up and capturing the graph took 0.07 seconds.

B and C matched the original at 29 of the first 32 greedy positions. A change of kernels changes the order of floating-point operations, which changes BF16 results slightly; when two tokens' logits almost tie, that is enough to flip a greedy choice, and the sequences diverge from there. Comparisons between inference implementations therefore check logits within a tolerance, or tokens up to the first near-tie, rather than demanding identical text.

## Why engines capture one graph per batch size

A serving engine decodes a batch of sequences at each step, and the batch size changes from step to step as requests arrive and finish. Because a graph's shapes are fixed, an engine captures a separate graph for each of a list of batch sizes before it starts serving, and runs each step with the graph for the next captured size up, padding the batch with dummy rows. vLLM's default list, in its v0.32.0 source, is 1, 2 and 4, then every multiple of 8 up to 248 and every multiple of 16 from 256, with the whole list stopping at a maximum of twice the configured maximum number of sequences, capped at 512 (1,024 on data-centre Blackwell GPUs). A batch larger than the largest captured size runs without a graph.

Graphs are not free. They hold GPU memory, for the graphs themselves and for the private pool their intermediate tensors live in (vLLM captures the largest size first so that the smaller graphs can share its pool), and capture takes time at start-up; vLLM logs how many seconds and GiB its capture took, and its documentation suggests capturing fewer sizes, or none with `enforce_eager`, when memory is short. In v0.32.0, `enforce_eager` turns off `torch.compile` as well as CUDA graphs. Attention is the awkward part to capture, because its work depends on every sequence's length, which changes each step. vLLM's default mode, `FULL_AND_PIECEWISE`, captures the whole step in one graph for batches where every sequence is decoding a single token, and otherwise uses piecewise graphs that cover everything between the attention operations, which then run outside the graphs. SGLang has similar settings, such as `--cuda-graph-max-bs-decode` for the largest decode batch it captures.

The widget compares capture plans. A finer list wastes less work on padding but needs more graphs, more memory and a longer start-up:

```widget
graph-padding
```

At decode, padding costs less than its share of rows suggests. A decode step at small batch is memory-bound: it reads all the weights whatever the batch size, so a few extra rows add little time until the batch is large enough to make the matmuls compute-bound.

## torch.compile: Dynamo, AOTAutograd and Inductor

A CUDA graph replays the kernels it was given, including every tiny element-wise kernel. `torch.compile` changes the kernels themselves. It has three parts:

- **TorchDynamo** hooks into CPython's frame evaluation API, defined in PEP 523, and rewrites a function's Python bytecode just before it runs. It extracts the sequence of PyTorch operations into an FX graph, PyTorch's Python-level record of tensor operations, and leaves the rest of the Python code to run normally.
- **AOTAutograd** traces the graph down to PyTorch's lower-level ATen operations and, for training, also captures the backward pass ahead of time.
- **TorchInductor**, the default backend, generates code for the graph: Triton kernels for NVIDIA, AMD and Intel GPUs, and C++ with OpenMP for CPUs. Its main optimization is fusion, which merges chains of element-wise operations and reductions into single kernels that read and write memory once, as chapter 2.2 did by hand for RMSNorm.

`torch.compile` takes a `mode` argument. The default mode balances compile time against speed. `"reduce-overhead"` also wraps the compiled code in CUDA graphs, which helps small batches most and may use more memory. `"max-autotune"` additionally benchmarks Triton and template-based matmul kernels to pick the fastest, and enables CUDA graphs, at the cost of a much longer compilation; `"max-autotune-no-cudagraphs"` does the same without the graphs.

The lab compiled the static-cache decode step in two modes, compiling only the decode forward so that it always sees the same shapes:

```python
compiled = torch.compile(model.forward, mode="reduce-overhead", fullgraph=True)
```

The step writes into the cache in place, and the `torch.compile` documentation warns that `reduce-overhead` skips CUDA graphs for code that changes its inputs. It works here because transformers marks the static cache's tensors with `torch._dynamo.mark_static_address`, which promises that their addresses never change, so the graph can write into them directly. The results, with the earlier versions for comparison:

| Version | Step time | Kernels | GPU busy | Setup |
|---|---|---|---|---|
| A. Eager, dynamic cache (default) | 9.44 ms | 695 | 2.20 ms | none |
| B. Eager, static cache | 11.62 ms | 831 | 2.67 ms | none |
| C. B captured in a CUDA graph | 2.79 ms | 831 | 2.58 ms | 0.07 s |
| D. `torch.compile`, default mode | 3.94 ms | 325 | 1.74 ms | 33.5 s |
| E. `torch.compile`, `reduce-overhead` | 1.82 ms | 326 | 1.72 ms | 24.3 s |

Inductor's fusion cut the kernels per step from 831 to 325 and the GPU's work from 2.67 ms to 1.74 ms, a third less, because fused kernels move each intermediate result through memory once instead of several times. Without CUDA graphs, the compiled step still took 3.94 ms, because its 325 kernels, though fewer, were still launched one by one from Python. With both, the step took 1.82 ms, 5.2 times faster than the original, and the GPU was busy for 1.72 ms of it, 94% of the step. The remaining gap to the 0.74 ms roofline is now inside the kernels, where Part 2's tools apply: the step's matmuls read the weights at well under the peak bandwidth (about 61% in chapter 2.5's profile), and each of the 200 or so remaining small kernels takes a microsecond or two however little it does. Attention over the unused cache slots costs little here: the whole 1,024-slot cache is 32 MiB, about 10 µs of reading.

The compiled versions, D and E, matched all 32 greedy tokens of the original, unlike B and C. As explained above, that is a property of these particular kernels rather than a guarantee.

Compilation is paid once per process, and it is not small: 33.5 seconds for D in a fresh container, and 24.3 seconds for E, which ran next in the same process and could probably reuse some of the Triton kernels D had compiled. PyTorch keeps on-disk caches of compiled graphs and Triton kernels, by default in a `torchinductor_<user>` folder in the system's temporary directory (`/tmp` on Linux), or wherever `TORCHINDUCTOR_CACHE_DIR` points, so a second process on the same machine compiles much faster; the CPU lab in chapter 3.3 saw a 20-second compile fall to under 5 seconds on its second run. Serving engines rely on the same idea. vLLM compiles its model before it accepts any request and keeps the results in `~/.cache/vllm/torch_compile_cache`, which can be copied to new machines to save the compile time. Hugging Face transformers applies the recipe automatically: with `cache_implementation="static"`, its `generate` compiles the decoding stage for greedy and sampled decoding.

The gains are well documented beyond this lab. PyTorch's "GPT, Fast" blog post took a 7B Llama model at batch 1 on an A100 from 25.5 tokens a second in eager mode to 107.0 with `torch.compile` and a static KV cache, more than four times faster, before quantization and speculative decoding raised it further.

## Graph breaks, guards and recompiles

Dynamo can only put into a graph what it can trace. When it meets code it cannot handle, it causes a graph break: it compiles the graph it has so far, runs the unsupported code in ordinary Python, and starts a new graph after it. Common causes, from PyTorch's documentation, are control flow that depends on a tensor's values (an `if` on a tensor), reading a tensor's data on the CPU with `.item()`, and printing or logging. Each break splits the step into more, smaller graphs, which loses fusion across the break and, with `reduce-overhead`, adds a separate CUDA graph launch per piece.

Several tools find them. `fullgraph=True`, which the lab uses, turns any graph break into an error, so a decode step either compiles whole or fails loudly. The environment variable `TORCH_LOGS="graph_breaks"` logs every break with its reason and source line, `TORCH_LOGS="recompiles"` logs every recompilation with the guard that failed, and `torch._dynamo.explain` summarizes the breaks in a function. For a full report, set `TORCH_TRACE` to a directory and open it with the `tlparse` tool.

A compiled graph is only valid under assumptions made while tracing, such as the input shapes, data types and devices, and the values of Python constants. Dynamo records these assumptions as guards, which it checks on every call. If no compiled version's guards pass, it recompiles. The number of compiled versions per function is limited by `torch._dynamo.config.recompile_limit`, 8 by default (it was called `cache_size_limit` before PyTorch 2.7); once the limit is reached, the function falls back to eager execution, usually with a warning that is easy to miss.

Shapes are the most common source of recompiles. By default, `torch.compile` first compiles for the exact shapes it sees. When a later call changes a dimension, it recompiles once with that dimension marked dynamic, so that one kernel serves all sizes. `dynamic=False` forbids dynamic kernels, `dynamic=True` asks for them from the start, and `torch._dynamo.mark_dynamic` marks a chosen dimension before the first call. Sizes 0 and 1 are always specialized: a dimension of that size gets its own compiled version. Even a dynamic compiled kernel cannot be replayed from a CUDA graph at a new size, though: CUDA graph trees, the part of PyTorch that records and replays graphs for `reduce-overhead`, record a separate graph for every distinct input shape.

Per-shape costs are not limited to compilers. The lab timed every version twice over the same sequence lengths. The first pass of the default dynamic-cache step took 46.73 ms per step, five times the 9.44 ms of the second pass. In the default forward pass on the H100, `scaled_dot_product_attention` chose NVIDIA's cuDNN attention kernels, and PyTorch's cuDNN integration, in `aten/src/ATen/native/cudnn/MHA.cpp`, builds a cuDNN graph for each new combination of query and key lengths and caches it. A growing cache presents a new key length at every step, so the first time through, every step paid for a build. A follow-up run confirmed the cause: with cuDNN attention disabled, steps at new lengths cost no more than repeated ones. The static-cache versions, whose attention always covers 1,024 slots, showed no such difference: 11.85 ms on the first pass against 11.62 ms on the second. A serving engine meets new combinations of sequence lengths at almost every step, so a cost paid per new length would be paid all the time. Engines use attention kernels that take the lengths as arguments at run time, and keep every other shape fixed.

## The CUDA caching allocator

Allocating GPU memory with `cudaMalloc` and freeing it with `cudaFree` is slow, and freeing can synchronize the device. PyTorch's documentation states the remedy: it uses a caching memory allocator, which allows fast memory deallocation without device synchronizations. When a tensor is freed, its block stays in PyTorch's cache, ready for the next tensor of a suitable size, instead of going back to the driver.

Two consequences follow. First, memory that PyTorch has cached but not used still shows as used in `nvidia-smi`. `torch.cuda.memory_allocated()` reports the memory held by tensors, and `torch.cuda.memory_reserved()` the memory the allocator holds in total, which, with the CUDA context's few hundred MiB, is what `nvidia-smi` shows. `torch.cuda.empty_cache()` returns unused cached memory to the driver, at the price of slower allocations afterwards. Second, the cache can fragment. The allocator gets memory from the driver in segments, each the result of one `cudaMalloc` call, and hands out blocks carved from them. In the allocator's source, every size is rounded up to a multiple of 512 bytes. Allocations of 1 MiB or less come from a small pool packed into 2 MiB segments, requests between 1 and 10 MiB split 20 MiB segments, and larger requests get segments of their own, rounded up to 2 MiB. A cached block can be split for a smaller request, but blocks in different segments cannot be joined. When nothing cached fits, the allocator asks the driver for a new segment. If that fails, it returns every completely free segment to the driver and tries again. What it cannot recover is free space inside segments that still hold a live tensor, so a large request can fail even when plenty of memory is reserved but unused.

Part C of the lab shows how much memory that design can hold on to when a batch grows a little at a time. It allocated 16 tensors, from 256 MiB to 736 MiB in steps of 32 MiB, freeing each before allocating the next:

```text
3. Sixteen tensors allocated and freed one after another, each 32 MiB larger than the last
   default settings           largest tensor 736 MiB, allocated now 0 MiB, reserved 7,936 MiB
   expandable_segments:True   largest tensor 736 MiB, allocated now 0 MiB, reserved 740 MiB
```

With default settings, every new tensor was larger than every cached block, so each one got a new segment, and the allocator ended up holding 7,936 MiB, the sum of all 16 sizes, for tensors of at most 736 MiB. With the `expandable_segments:True` option, the allocator keeps one segment per stream that grows as necessary, mapping more memory onto its end in pages of 20 MiB, so it reserved only 740 MiB: the largest tensor, 736 MiB, rounded up to whole pages. None of the 7,936 MiB is lost: every one of those segments is entirely free, so the allocator would hand them back before failing a request. The danger comes when segments also hold live tensors. Step through both in the widget:

```widget
caching-allocator
```

The allocator is configured through the `PYTORCH_ALLOC_CONF` environment variable, which must be set before the program first uses CUDA. Its older name, `PYTORCH_CUDA_ALLOC_CONF`, still works as an alias. Its main options are:

- **`expandable_segments:True`**, as above, which PyTorch's documentation recommends for jobs whose allocation sizes keep changing, such as a changing batch size. It is still marked experimental and is off by default.
- **`max_split_size_mb`**, which stops the allocator from splitting blocks above a given size, so that large blocks stay available for large requests. The documentation calls it a last resort for out-of-memory errors caused by fragmentation.
- **`garbage_collection_threshold`**, which makes the allocator release old, unused cached blocks once usage passes a fraction, such as 0.8, of the memory the process may use. This avoids a stall that releases everything when an allocation fails. In the allocator's source it takes effect only when that limit has been set with `torch.cuda.set_per_process_memory_fraction`.
- **`roundup_power2_divisions`**, which rounds requests to coarser steps so that freed blocks are more often reusable.
- **`backend:cudaMallocAsync`**, which replaces PyTorch's allocator with CUDA's own stream-ordered allocator.

To see where memory goes, PyTorch records allocation history with `torch.cuda.memory._record_memory_history()` and saves a snapshot with `torch.cuda.memory._dump_snapshot()`; the viewer at pytorch.org/memory_viz draws it as a timeline, running entirely in the browser. CUDA graphs interact with all of this, because a graph's memory comes from a private pool that the graph keeps for its lifetime. PyTorch's CUDA graph trees, used by `reduce-overhead`, share one pool across a function's graphs to limit the cost. Serving engines take the simplest approach of all: they measure the memory the model and its graphs need at start-up and allocate the KV cache once, as Part 5 describes, so that steady-state decoding allocates almost nothing.

## Lab: speed up the decode step

**Tier: [1 GPU].** The run took 102 seconds of H100 time on Modal, about 11 cents, plus a 2.5 GB model download.

The script is ready to download: [gpu/decode_runtime.py](/labs/infra/gpu/decode_runtime.py). Run it with `modal run modal_run.py --script decode_runtime.py --gpu H100 --cpu 4`, or with `python decode_runtime.py` on your own NVIDIA GPU. The `--cpu 4` option reserves four CPU cores: a Modal container is guaranteed only 0.125 cores by default and borrows more when the host has spare capacity, and a launch-bound step is exactly the kind of workload whose speed then depends on how busy the host is.

**Part A, the launch floor.** Time 200 tiny kernels launched one by one and replayed as a CUDA graph, and compute the CPU cost per launch on your machine.

**Part B, five versions of the decode step.** Starting from the chapter 2.5 baseline, measure the step with a static KV cache, captured by hand in a CUDA graph, compiled with `torch.compile`, and compiled with `mode="reduce-overhead"`. For each, report the step time, the kernels per step, the GPU's busy time, and whether the first 32 greedy tokens match the baseline. Explain each step's gain with those numbers.

**Part C, the allocator.** Allocate a growing sequence of tensors with and without `expandable_segments:True`, and explain the reserved memory in each case.

The lab is done when you can state how much of the remaining step time is GPU work and what you would try next.

<details>
<summary>Reference solution</summary>

The full output from the H100 run:

```text
NVIDIA H100 80GB HBM3, PyTorch 2.15.0+cu132

1. 200 tiny kernels
   launched one by one: 1,036 us (5.2 us per kernel)
   replayed as a graph: 238 us (1.2 us per kernel), 4.4 times faster

2. unsloth/Llama-3.2-1B-Instruct, transformers 5.22.1: 2.47 GB of weights; batch 1, 512-token prompt, 100 timed steps
   A:   9.44 ms per step (first pass  46.73 ms), first 32 tokens match A: 32/32
   B:  11.62 ms per step (first pass  11.85 ms), first 32 tokens match A: 29/32
   C:   2.79 ms per step (first pass   2.81 ms), first 32 tokens match A: 29/32, setup  0.1 s
   D:   3.94 ms per step (first pass   4.12 ms), first 32 tokens match A: 32/32, setup 33.5 s
   E:   1.82 ms per step (first pass   1.83 ms), first 32 tokens match A: 32/32, setup 24.3 s

   Kernels per step and the GPU's busy time, from the PyTorch profiler:
   A:  695 kernels, GPU busy  2.20 ms of a  9.44 ms step
   B:  831 kernels, GPU busy  2.67 ms of a 11.62 ms step
   C:  831 kernels, GPU busy  2.58 ms of a  2.79 ms step
   D:  325 kernels, GPU busy  1.74 ms of a  3.94 ms step
   E:  326 kernels, GPU busy  1.72 ms of a  1.82 ms step
   The 200 tiny kernels of part 1: 200 kernels, GPU busy 218 us

   Speed-up over A: A 1.0x, B 0.8x, C 3.4x, D 2.4x, E 5.2x
   Reading the weights once at the spec bandwidth would take 0.74 ms

3. Sixteen tensors allocated and freed one after another, each 32 MiB larger than the last
   default settings           largest tensor 736 MiB, allocated now 0 MiB, reserved 7,936 MiB
   expandable_segments:True   largest tensor 736 MiB, allocated now 0 MiB, reserved 740 MiB
```

*Part A.* Launching from Python cost 5.2 µs per kernel against 1.1 µs of GPU work, so a stream of tiny kernels keeps the GPU busy only about a fifth of the time. A graph replay costs 1.2 µs per kernel, almost exactly the GPU's work.

*Part B.* The static cache alone is slower (B, 11.62 ms), because its in-place cache updates and the mask over all 1,024 slots add 136 kernels to a launch-bound step, but it makes the step capturable. Capturing it (C) removes the launch overhead: 2.79 ms, with the GPU busy 92% of the time. Compiling without graphs (D) removes a third of the GPU work through fusion, 1.74 ms against 2.67 ms, but still launches 325 kernels from Python. Both together (E) give 1.82 ms, 5.2 times faster than A, with the GPU busy 94% of the time. B and C match A at 29 of 32 positions, most likely because their kernels round differently near a tie between two logits; D and E happen to match all 32.

*What remains.* E's step is now almost all GPU work, 1.72 ms against a 0.74 ms roofline. The next steps are inside the kernels: matmuls that read the weights closer to the peak bandwidth, and fewer of the small kernels that each cost a microsecond or two. Attention over unused cache slots matters little at this size, since the whole cache is 32 MiB; it matters at large batches and long contexts, where serving engines' paged attention kernels, the subject of Part 5, pay off.

*Part C.* Each tensor was larger than every cached block, so the default allocator created a new segment each time and reserved the sum of all sizes, 7,936 MiB. Expandable segments grew one segment instead and reserved 740 MiB, about the size of the largest tensor.

*Two things to watch for in your own runs.* First, time before you profile. In our runs, eager decode steps stayed about 20 to 30% slower after a `torch.profiler` session had ended, which is why the script profiles only after all the timing. Second, the first pass of A depends on whether cuDNN attention is selected on your GPU; on a GPU where PyTorch picks a different attention kernel, the two passes may be equal.

</details>

## Interview angle

- **"A model runs at batch 1 far below its roofline. What do you check first?"** Whether the GPU is busy. If a profile shows short kernels with gaps between them, the step is launch-bound, and the fixes are CUDA graphs, kernel fusion with `torch.compile`, and larger batches. If the GPU is busy, the problem is in the kernels.
- **"Why does a CUDA graph need a static KV cache?"** A graph replays the same kernels with the same arguments, including memory addresses and grid sizes. A cache that grows by concatenation changes both every step. A static cache preallocates the maximum length and writes each token in place, so every step looks the same.
- **"Why do serving engines capture many CUDA graphs?"** Each graph has fixed shapes, and the batch size changes every step. The engine captures graphs for a list of batch sizes, pads each batch up to the next one, and runs batches beyond the largest size without a graph. More sizes mean less padding but more memory and a longer start-up.
- **"What is a graph break, and how do you find one?"** A point where Dynamo cannot trace the code, so it ends the graph, runs that code in Python and starts a new graph. Set `fullgraph=True` to turn breaks into errors, or use `TORCH_LOGS="graph_breaks"` and `tlparse` to list them with their reasons.
- **"nvidia-smi says the GPU is almost full, but your tensors are small. Why?"** PyTorch's caching allocator keeps freed memory reserved for reuse, and nvidia-smi counts it as used. Compare `memory_allocated()` with `memory_reserved()`, look for fragmentation with a memory snapshot, and consider `expandable_segments:True` if allocation sizes keep changing.

## Check yourself

<details>
<summary>Launching a tiny kernel from Python costs 5.2 µs of CPU time and its work takes 1.1 µs on the GPU. Roughly what share of the time is the GPU busy, and what changes if each kernel does 10 µs of work?</summary>

With 1.1 µs of work every 5.2 µs, the GPU is busy about a fifth of the time, because it waits for each launch. If each kernel does 10 µs of work, the CPU launches faster than the GPU finishes, the launches queue up ahead of the GPU, and it is busy almost all the time. Launch overhead matters only when kernels are shorter than the launch cost.

</details>

<details>
<summary>The static-cache step was slower than the default one in eager mode (11.62 ms against 9.44 ms). Why use it at all?</summary>

Because it makes the step capturable. In eager mode it is slower because every layer does more small operations: it writes into the cache in place, advances its position counter and masks attention over all 1,024 slots. In a launch-bound step, each extra operation costs CPU time. But it keeps every shape and address fixed, and with a CUDA graph the step fell to 2.79 ms, and to 1.82 ms with `torch.compile` as well. The slower eager step is the price of a step that can be replayed.

</details>

<details>
<summary>torch.compile in its default mode cut the GPU's work from 2.67 ms to 1.74 ms, but the step took 3.94 ms. Where did the rest go, and which mode fixes it?</summary>

The compiled step still launched 325 kernels one by one from Python, plus the compiled code's own overhead for checking guards, so the GPU still waited between kernels. `mode="reduce-overhead"` adds CUDA graphs on top of the fused kernels, and the step fell to 1.82 ms with the GPU busy for 1.72 ms of it.

</details>

<details>
<summary>The first pass of the default decode step took 46.73 ms per step and the second 9.44 ms, over the same sequence lengths. What happened, and why did the static-cache step show no such difference?</summary>

PyTorch's cuDNN attention builds and caches a cuDNN graph for each new combination of sequence lengths. A dynamic cache presents a new key length at every step, so on the first pass every step paid for a build, and on the second the builds were cached. The static cache's decode steps all have the same shapes, so at most one build serves all of them. A server meets new combinations of lengths at almost every step, so a cost that is paid per new shape is paid all the time.

</details>

<details>
<summary>A vLLM server is configured so its largest captured CUDA graph is for 64 sequences. What happens to a decode step with 13 sequences, and one with 100?</summary>

The step with 13 sequences is padded to the next captured size, 16 in vLLM's default list, and replays that graph; three rows of work are wasted, which costs little in a memory-bound decode step. The step with 100 sequences is larger than any captured size, so it runs without a CUDA graph and pays the launch overhead.

</details>

<details>
<summary>A job allocates a slightly larger activation buffer at every step and runs out of GPU memory, although its largest tensor is a small fraction of the GPU. What is likely happening, and what would you try?</summary>

Fragmentation in the caching allocator. A freed buffer stays cached, and a new, larger buffer that fits no cached block gets a new segment. Before reporting out of memory, the allocator returns every completely free segment to the driver and retries. The memory it cannot recover is the free space left inside segments that still hold live tensors, and the error message reports it as memory reserved by PyTorch but unallocated. Confirm it by comparing `memory_reserved()` with `memory_allocated()`, or with a memory snapshot, then set `PYTORCH_ALLOC_CONF=expandable_segments:True`, or allocate the buffer once at its maximum size and reuse it.

</details>

## Further reading

- [CUDA graphs in the CUDA Programming Guide](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/cuda-graphs.html) defines graphs, stream capture, instantiation and the rules for capture.
- [Getting Started with CUDA Graphs](https://developer.nvidia.com/blog/cuda-graphs/), from NVIDIA's developer blog, measures launch overhead and graph launches on a V100.
- [PyTorch's CUDA semantics notes](https://docs.pytorch.org/docs/2.15/notes/cuda.html) cover CUDA graphs in PyTorch, the caching allocator and every `PYTORCH_ALLOC_CONF` option.
- [Accelerating PyTorch with CUDA Graphs](https://pytorch.org/blog/accelerating-pytorch-with-cuda-graphs/), from the PyTorch blog, introduces the PyTorch API with examples and measured speed-ups.
- [The torch.compile documentation](https://docs.pytorch.org/docs/2.15/generated/torch.compile.html) describes the modes, and its [programming model pages](https://docs.pytorch.org/docs/2.15/user_guide/torch_compiler/compile/programming_model.dynamo_core_concepts.html) explain graph breaks, guards and recompilation.
- [Dynamic shapes in torch.compile](https://docs.pytorch.org/docs/2.15/user_guide/torch_compiler/torch.compiler_dynamic_shapes.html) and [CUDA graph trees](https://docs.pytorch.org/docs/2.15/user_guide/torch_compiler/torch.compiler_cudagraph_trees.html) explain how compiled code handles changing shapes and how `reduce-overhead` records graphs.
- [Compile time caching in torch.compile](https://docs.pytorch.org/tutorials/recipes/torch_compile_caching_tutorial.html) lists the on-disk caches that make a second compilation faster.
- [vLLM's CUDA graphs design document](https://docs.vllm.ai/en/latest/design/cuda_graphs/) and its [torch.compile integration](https://docs.vllm.ai/en/latest/design/torch_compile/) explain the capture modes, piecewise graphs and the compile cache.
- [Accelerating Generative AI with PyTorch II: GPT, Fast](https://pytorch.org/blog/accelerating-generative-ai-2/), from the PyTorch blog, takes a 7B model from 25.5 to over 240 tokens a second in pure PyTorch.
- [A guide to PyTorch's CUDA caching allocator](https://zdevito.github.io/2022/08/04/cuda-caching-allocator.html) by Zachary DeVito explains the allocator's design, as of 2022, and [Understanding GPU memory](https://pytorch.org/blog/understanding-gpu-memory-1/) shows how to use memory snapshots.
