<!-- Flashcards for Part 3 of the AI Infrastructure Engineer Handbook: PyTorch execution, native code and bindings, and compilers and graph runtimes. -->

<!-- chapter: pytorch-execution -->

## What happens in eager PyTorch for every operation, and when does that cost show?
<!-- /learn/pytorch-execution#what-eager-mode-costs -->

Each operation passes through **Python, PyTorch's C++ dispatcher and the CUDA driver**, which queues the kernel asynchronously. The cost is hidden while the CPU queues kernels faster than the GPU finishes them. It shows when kernels are tiny, as in a **batch-1 decode step**, because the GPU finishes each kernel before the CPU has launched the next.

## What did the lab measure for 200 tiny kernels on an H100, launched one by one and replayed as a CUDA graph?
<!-- /learn/pytorch-execution#what-eager-mode-costs -->

The kernels did about **1.1 µs** of GPU work each. Launched one by one from Python they took **6.0 µs** per kernel, so the GPU waited about four fifths of the time. Replayed as a CUDA graph they took **1.1 µs** per kernel, **5.2 times** faster.

## What is a CUDA graph, and what are the three stages of submitting work through one?
<!-- /learn/pytorch-execution#cuda-graphs-record-once-replay-many-times -->

A CUDA graph is a series of operations, such as kernel launches and memory copies, **connected by dependencies**, which is defined once and launched repeatedly. The stages are **definition**, often by stream capture; **instantiation**, which validates the graph and does most of the setup in advance; and **execution**, launching the instantiated graph with little overhead each time.

## What rules must code follow to be captured in a CUDA graph in PyTorch?
<!-- /learn/pytorch-execution#cuda-graphs-record-once-replay-many-times -->

Every replay uses the **same memory addresses**, so inputs are copied into the captured tensors; **shapes cannot change**; nothing may **synchronize the CPU with the GPU** during capture, such as `.item()`; **CPU code in the captured region is not replayed**; and the workload is **warmed up on a side stream** first. Capture allocates from a private memory pool.

## Why can't Hugging Face's default decode step be captured in a CUDA graph, and what fixes it?
<!-- /learn/pytorch-execution#cuda-graphs-record-once-replay-many-times -->

Its default **dynamic KV cache** grows by concatenation, so every step allocates new tensors at new addresses and attention sees a longer sequence. A **static KV cache** (`cache_implementation="static"` or `StaticCache`) preallocates the maximum length and writes each token in place, so every step has the same shapes and addresses. In transformers 5.x it also keeps its write position as a GPU tensor.

## In the lab, why was the static-cache step slower than the default one in eager mode, and what did a CUDA graph do to it?
<!-- /learn/pytorch-execution#cuda-graphs-record-once-replay-many-times -->

Eager with a static cache took **12.52 ms** against **10.30 ms**, with 829 kernels instead of 694, because every layer also **writes its keys and values into the cache in place** and masks attention over all **1,024 slots**, small operations that each cost CPU time in a launch-bound step. Captured by hand in a CUDA graph, the same step took **2.80 ms**, 3.7 times faster than the original, with the GPU busy for 2.59 ms of it. Warming up and capturing the graph took 0.06 seconds.

## Why can a change of kernels change greedy output, and how should implementations be compared?
<!-- /learn/pytorch-execution#cuda-graphs-record-once-replay-many-times -->

Different kernels change the **order of floating-point operations**, which changes BF16 results slightly. When two tokens' logits almost tie, that can **flip a greedy choice**, and the sequences diverge from there; the lab's static versions B and C matched the original at 29 of the first 32 positions. Compare **logits within a tolerance**, or tokens up to the first near-tie, not identical text.

## How do serving engines use CUDA graphs when the batch size changes every step?
<!-- /learn/pytorch-execution#why-engines-capture-one-graph-per-batch-size -->

They **capture one graph per batch size** from a list before serving, and run each step with the graph for the **next captured size up**, padding the batch with dummy rows. A batch larger than the largest captured size runs **without a graph**. More sizes mean less padding but more memory and a longer start-up.

## What are vLLM's default CUDA graph capture sizes in v0.32.0?
<!-- /learn/pytorch-execution#why-engines-capture-one-graph-per-batch-size -->

The default sizes are **1, 2 and 4**, then every multiple of **8 up to 248**, then every multiple of **16** up to a maximum of twice the maximum number of sequences, **capped at 512** (1,024 on data-centre Blackwell GPUs).

## What does vLLM's default cudagraph_mode, FULL_AND_PIECEWISE, do, and why is attention the hard part?
<!-- /learn/pytorch-execution#why-engines-capture-one-graph-per-batch-size -->

Attention's work depends on every sequence's length, which changes each step. The mode captures the **whole step in one graph** for batches where every sequence decodes a single token, and otherwise uses **piecewise graphs** covering everything between the attention operations, which run outside the graphs. In v0.32.0, `enforce_eager` disables both CUDA graphs and `torch.compile`.

## What are the three parts of torch.compile, and what does each do?
<!-- /learn/pytorch-execution#torchcompile-dynamo-aotautograd-and-inductor -->

**TorchDynamo** hooks into CPython's frame evaluation API (PEP 523) and extracts PyTorch operations from Python bytecode into an FX graph. **AOTAutograd** traces the graph to ATen operations and captures the backward pass ahead of time for training. **TorchInductor** fuses operations and generates the code: Triton kernels for GPUs, and C++ with OpenMP for CPUs.

## What do torch.compile's modes default, reduce-overhead and max-autotune do?
<!-- /learn/pytorch-execution#torchcompile-dynamo-aotautograd-and-inductor -->

**default** balances compile time against speed. **reduce-overhead** also wraps the compiled code in **CUDA graphs**, which helps small batches and may use more memory. **max-autotune** benchmarks Triton and template matmul kernels to pick the fastest and enables CUDA graphs, at the cost of a much longer compile; **max-autotune-no-cudagraphs** skips the graphs.

## What did torch.compile do to the decode step in the lab, with and without CUDA graphs?
<!-- /learn/pytorch-execution#torchcompile-dynamo-aotautograd-and-inductor -->

Fusion cut the kernels from **829 to 323** and the GPU work from **2.67 to 1.72 ms**. In default mode the step still took **4.18 ms**, because its kernels were still launched from Python. With `reduce-overhead` it took **1.84 ms**, **5.6 times** faster than the original 10.30 ms, with the GPU busy 94% of the time. Compilation took 30.7 seconds for default mode and 21.5 seconds for `reduce-overhead`.

## What is a graph break, what causes one, and how do you find them?
<!-- /learn/pytorch-execution#graph-breaks-guards-and-recompiles -->

Where Dynamo cannot trace, it **compiles the graph so far, runs the code in Python and starts a new graph**. Causes include control flow on a tensor's values, `.item()`, and printing or logging. `fullgraph=True` turns breaks into errors; `TORCH_LOGS="graph_breaks"` logs them with reasons; `torch._dynamo.explain` and `tlparse` summarize them.

## What are guards, and what happens when a function recompiles too often?
<!-- /learn/pytorch-execution#graph-breaks-guards-and-recompiles -->

Guards are **runtime checks of the assumptions** made while tracing, such as shapes, types, devices and Python constants. If no compiled version's guards pass, Dynamo recompiles. After **`torch._dynamo.config.recompile_limit`** versions, **8 by default**, the function **falls back to eager**, often with an easily missed warning.

## How does torch.compile handle a shape that changes between calls?
<!-- /learn/pytorch-execution#graph-breaks-guards-and-recompiles -->

By default it first compiles for the **exact shapes**, then on a change **recompiles once with that dimension dynamic**. `dynamic=False` forbids dynamic kernels, `dynamic=True` requests them up front, and `torch._dynamo.mark_dynamic` marks a dimension before the first call. Sizes **0 and 1 are always specialized**. CUDA graph trees still record a **separate graph per input shape**.

## Why was the first pass of the default decode step five times slower than the second in the lab?
<!-- /learn/pytorch-execution#graph-breaks-guards-and-recompiles -->

Attention ran NVIDIA's **cuDNN** kernels, and PyTorch's cuDNN integration **builds and caches a cuDNN graph for each new combination of sequence lengths**. A growing KV cache presents a **new key length every step**, so the first pass paid for a build at each step: **52.84 ms** against 10.30 ms. The static cache's fixed 1,024 slots showed no difference (12.48 against 12.52 ms).

## Why does PyTorch use a caching allocator, and what does it mean for nvidia-smi?
<!-- /learn/pytorch-execution#the-cuda-caching-allocator -->

`cudaMalloc` and `cudaFree` are slow, and the cache **allows fast deallocation without device synchronizations**: a freed block stays cached for reuse. Cached but unused memory **still shows as used in nvidia-smi**. `memory_allocated()` counts memory held by tensors, `memory_reserved()` everything the allocator holds, and `empty_cache()` returns unused cached memory to the driver.

## How does the caching allocator size and pool its blocks?
<!-- /learn/pytorch-execution#the-cuda-caching-allocator -->

Every size is rounded up to a multiple of **512 bytes**. Allocations of **1 MiB or less** come from a small pool packed into **2 MiB** segments, requests **between 1 and 10 MiB** split **20 MB** segments, and larger requests get their own segments, rounded up to **2 MiB**. Blocks in different segments cannot be joined, which causes fragmentation.

## What did the lab's growing-batch allocation pattern reserve, with and without expandable segments?
<!-- /learn/pytorch-execution#the-cuda-caching-allocator -->

Sixteen tensors from 256 to 736 MiB, each freed before the next: with default settings each tensor was too large for every cached block, so the allocator reserved **7,936 MiB**, the sum of all sizes. With **`expandable_segments:True`**, one segment grew as needed and only **740 MiB** was reserved.

## What is PYTORCH_ALLOC_CONF, and what are its main options?
<!-- /learn/pytorch-execution#the-cuda-caching-allocator -->

It is the environment variable that configures the allocator, and it must be set **before the first CUDA use**; `PYTORCH_CUDA_ALLOC_CONF` is its older alias. Options include **`expandable_segments`** (experimental, off by default), **`max_split_size_mb`** (a last resort against fragmentation), **`garbage_collection_threshold`**, **`roundup_power2_divisions`**, and **`backend:cudaMallocAsync`**.

<!-- chapter: native-code -->

## Where do inference engines already use native code?
<!-- /learn/native-code#when-native-code-is-worth-it -->

**vLLM** keeps custom CUDA and C++ kernels in its `csrc` directory. Hugging Face's **tokenizers** library is written in **Rust**. **SGLang's router** is a Rust program. **llama.cpp** is C and C++ throughout. **TensorRT-LLM** long had a C++ executor, though it now centres on PyTorch and a Python API.

## When is writing new native code worth it?
<!-- /learn/native-code#when-native-code-is-worth-it -->

It is worth it for a **tight CPU loop that runs per token or request**, such as sampling on the CPU, detokenization, grammar matching or scheduling, when a profile shows Python overhead dominates; for **work that must run on several threads**, which the GIL prevents in Python; and for **GPU kernels** PyTorch lacks. It is rarely worth it for array arithmetic that NumPy or PyTorch already does natively.

## What does nanobind claim over pybind11?
<!-- /learn/native-code#binding-c-to-python -->

nanobind, by pybind11's author **Wenzel Jakob**, reports up to about **4 times faster compilation, 5 times smaller binaries and 10 times lower runtime overhead** than pybind11. Its `nb::ndarray` exchanges arrays with NumPy, PyTorch, JAX, CuPy and others through both the **buffer protocol and DLPack**.

## A pybind11 function takes py::array_t<float, py::array::c_style>. What does it do with a float64 array and with a strided float32 view?
<!-- /learn/native-code#zero-copy-the-buffer-protocol-and-dlpack -->

Without `forcecast`, the **float64 array is refused** with a `TypeError`. The **strided view is accepted but silently copied** into a contiguous array, as the lab showed with a different data address. Marking the argument **`noconvert()`** refuses anything that needs converting, so every accepted call is zero-copy.

## What is DLPack, and how does it differ from the buffer protocol?
<!-- /learn/native-code#zero-copy-the-buffer-protocol-and-dlpack -->

DLPack is the common format for **sharing arrays between frameworks, GPU memory included**, through the `__dlpack__` and `__dlpack_device__` methods. The buffer protocol (PEP 3118) covers **CPU memory only**. `torch.from_dlpack` returns a tensor that **shares memory** with its input; NumPy has had `numpy.from_dlpack` since version 1.23.

## What does the GIL mean for a C++ function called from Python, and how does pybind11 release it?
<!-- /learn/native-code#the-gil-and-threads -->

The GIL must be held to access Python objects, and **pybind11 never releases it on its own**, so a bound function holds it for its whole run and other threads wait. A **`py::gil_scoped_release`** object releases it until it goes out of scope, or **`py::call_guard<py::gil_scoped_release>()`** does so for a whole function. Code without the GIL must not touch Python objects.

## What did the lab measure for the sampler on 4 threads?
<!-- /learn/native-code#the-gil-and-threads -->

On an M2: C++ **holding the GIL** gave **1.0 times** the one-thread throughput, because threads took turns; C++ **releasing it** gave **3.5 times**; **NumPy** gave **2.3 times**, because it releases the GIL inside many low-level operations but needs it between them. On one thread C++ took 25 ms per call against NumPy's 58 ms.

## What is the status of free-threaded Python?
<!-- /learn/native-code#the-gil-and-threads -->

**PEP 703** added a CPython build without the GIL. It was **experimental in Python 3.13** (`python3.13t`) and is **officially supported but optional from 3.14** under PEP 779, with roughly **5 to 10%** cost to single-threaded code. Extension modules must declare they are safe without the GIL, as pybind11 modules do with `py::mod_gil_not_used()`.

## Why register a custom op with TORCH_LIBRARY instead of calling a pybind11 function, and what else does torch.compile need?
<!-- /learn/native-code#pytorch-custom-operators -->

`torch.compile` **cannot trace into a pybind11-bound function**, so calling one causes a **graph break**. A registered operator, with its schema from `TORCH_LIBRARY` and per-backend kernels from `TORCH_LIBRARY_IMPL`, is one opaque step in the graph. It also needs a **fake (meta) kernel**, registered with `torch.library.register_fake`, that computes output shapes without data.

## What is the LibTorch stable ABI?
<!-- /learn/native-code#pytorch-custom-operators -->

It is a limited, stable interface for extensions, with operators registered through **`STABLE_TORCH_LIBRARY`**, so that one build **keeps working across PyTorch versions** instead of needing a wheel per version. It is still being extended; **PyTorch 2.10** was the first release to enforce its versioning rules, and vLLM v0.32.0 registers its kernels this way.

## What is RAII, and give two examples from inference code.
<!-- /learn/native-code#the-c-you-need -->

RAII, **resource acquisition is initialization**, means that the constructor acquires a resource and the destructor releases it, so it is released on every exit path, including exceptions. Examples are **`py::gil_scoped_release`** for the GIL, **`c10::cuda::CUDAGuard`** and **`CUDAStreamGuard`** for the current device and stream, and a GPU buffer class that calls `cudaFree` in its destructor.

## Why does a condition variable wait take a predicate?
<!-- /learn/native-code#the-c-you-need -->

A condition variable may wake a thread **spuriously**, without any notification. The predicate form **re-checks the condition after every wake-up** and goes back to sleep if it is false. In a thread-safe queue, `pop` waits with `[&] { return !items_.empty(); }`.

<!-- chapter: graph-runtimes -->

## How does ahead-of-time compilation differ from just-in-time compilation for deployment?
<!-- /learn/graph-runtimes#ahead-of-time-or-just-in-time -->

A **just-in-time** compiler such as `torch.compile` runs **in the serving process**, sees real inputs, recompiles when they change and falls back to Python where it must. An **ahead-of-time** compiler runs **before deployment**, must capture the whole model, and fixes in advance what the **artifact** will accept.

## What does torch.export produce, and how does it treat code it cannot trace?
<!-- /learn/graph-runtimes#torchexport-one-graph-or-an-error -->

An **ExportedProgram**: one graph of **ATen operators** plus custom operators, with the weights. Unlike `torch.compile`, it **raises an error** instead of inserting a graph break. Non-strict tracing is the **default since PyTorch 2.8**. Shapes are static unless marked with `torch.export.Dim`, and control flow on tensor values must use **`torch.cond`**.

## What is AOTInductor?
<!-- /learn/graph-runtimes#aotinductor -->

AOTInductor is TorchInductor run **ahead of time**: `aoti_compile_and_package` turns an exported program into a **`.pt2` package of compiled shared libraries** for deployment, loadable from Python with `aoti_load_package` or from **C++ without Python** with `AOTIModelPackageLoader`. Inputs must match the exported sizes, types and strides, except dynamic dimensions.

## How does ONNX Runtime decide where each node runs, and when does it optimize the graph?
<!-- /learn/graph-runtimes#onnx-and-onnx-runtime -->

A session gets a list of **execution providers in priority order**, such as CUDA, TensorRT or CPU, and each node runs on the **first provider that supports it**. **Graph optimizations**, at basic, extended and layout levels, all on by default, run **when the session is created**; `optimized_model_filepath` saves the result.

## What did the lab find when it ran a small decoder in four ways on an M2?
<!-- /learn/graph-runtimes#lab-one-model-four-runtimes -->

Per 128-token forward pass: **eager 19.2 ms**, **torch.compile 17.8 ms** (19.6 s to compile, in process), **AOTInductor 18.0 ms** (5.2 s to export and compile, before deployment, a 200 MB package that took 2.3 s to load) and **ONNX Runtime 25.7 ms** on its default CPU provider. All matched eager within about 4 × 10⁻⁶. ONNX Runtime built fastest but ran slowest.

## What does the TensorRT builder do, and how portable is the engine?
<!-- /learn/graph-runtimes#tensorrt -->

It **fuses layers** and picks the fastest kernel, or **tactic**, for each layer **by timing candidates** on the target GPU, offline, in seconds to tens of minutes or more. Serialized engines are **specific to the exact GPU model** they were built on and, by default, to the **TensorRT version**; hardware and version compatibility are opt-in, at some cost in speed.

## What is a TensorRT optimization profile?
<!-- /learn/graph-runtimes#tensorrt -->

For a network with dimensions that vary at run time, at least one profile must give each dynamic dimension a **minimum, optimal and maximum** size. TensorRT tunes for the optimal size, and **some operations have fast kernels only when all three are equal**. Since TensorRT 11.0, networks must also be **strongly typed**.

## What did TensorRT-LLM's classic engine build fix, and what has replaced it?
<!-- /learn/graph-runtimes#tensorrt-llm-and-the-return-to-pytorch -->

`trtllm-build` fixed **`max_batch_size`, `max_input_len`, `max_seq_len` and `max_num_tokens`**, and the engine's activation memory. **TensorRT-LLM 1.0** (September 2025) made a **PyTorch backend the default**, and from the pre-release **1.3.0rc21** (July 2026) the **TensorRT engine backend is removed**. The PyTorch backend captures **CUDA graphs for decode-only batches** by default; `torch.compile` and piecewise CUDA graphs are optional prototypes there, while vLLM turns both on by default.

## When does an ahead-of-time engine win over just-in-time compilation?
<!-- /learn/graph-runtimes#when-an-ahead-of-time-engine-wins -->

When there is **no Python in production**, when shapes are **fixed or narrow** (vision, embedding, rerankers, speech), when **start-up time** rules out compiling in each process, or when a vendor's runtime is measurably faster on the target hardware. It costs **build time, an artifact per GPU and version, a fixed shape envelope**, harder debugging and slower support for new architectures.
