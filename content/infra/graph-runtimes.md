# Compilers and graph runtimes

Chapter 3.1 compiled a model just in time: `torch.compile` traced the decode step inside the serving process, on its first call, and the process kept the result in memory. The other way to deploy a model is to compile it ahead of time. A build step turns the model into an artifact, such as an ONNX file, an AOTInductor package or a TensorRT engine, and a runtime loads that artifact in production, sometimes without Python at all. This chapter covers the main ahead-of-time paths, what each one fixes at build time, and what that rigidity costs. It ends with the trend that matters most for large language models: NVIDIA's own TensorRT-LLM has moved from prebuilt TensorRT engines to a PyTorch program that captures CUDA graphs, the approach of vLLM and SGLang. The lab runs one small transformer four ways on a CPU and compares build time, speed and flexibility.

Before this chapter, read [PyTorch execution for inference](/learn/pytorch-execution), which explains graph capture, compilation and CUDA graphs.

## Ahead of time or just in time

The two approaches differ in when the compiler runs and what it may assume. A just-in-time compiler such as `torch.compile` runs in the serving process, sees the real inputs, and can recompile when they change, falling back to Python for anything it cannot handle. An ahead-of-time compiler runs before deployment, must capture the whole model without falling back, and fixes in advance what the artifact will accept.

```diagram
title: Two ways from a PyTorch model to running code
[model:client] PyTorch model @ 0,1
[jit] torch.compile @ 1,0
[proc] Serving process @ 2,0
[exp] torch.export @ 1,2
[aoti] AOTInductor @ 2,1
[pkg:store] .pt2 package @ 3,1
[onnx:store] ONNX file @ 2,2
[ort] ONNX Runtime @ 3,2
[trt] TensorRT builder @ 2,3
[eng:store] TensorRT engine @ 3,3
model -> jit : first call
jit -> proc
model -> exp
exp -> aoti
aoti -> pkg
exp -> onnx
onnx -> ort
onnx -> trt
trt -> eng
```

The top path is chapter 3.1's. The others start from `torch.export`, which captures the whole model as one graph, and then compile it with AOTInductor, convert it to ONNX for ONNX Runtime, or build a TensorRT engine from the ONNX file.

## torch.export: one graph or an error

`torch.export.export` traces a model with example inputs and returns an `ExportedProgram`, a single graph that contains only PyTorch's ATen operators, plus any custom operators, together with the model's weights. Its documentation states the key difference from `torch.compile`: export aims for a full graph, so it raises an error when it reaches something it cannot trace, where `torch.compile` would insert a graph break and continue. Since PyTorch 2.8, export traces in non-strict mode by default, running the model's Python code normally and recording the tensor operations; `strict=True` traces through TorchDynamo instead.

Shapes are static unless declared otherwise. A dimension that should vary is marked with `torch.export.Dim`, with an optional range, and the exported program checks every input against those ranges at run time. Python control flow that depends on a tensor's values cannot be exported; it has to be rewritten with `torch.cond`, which keeps both branches in the graph and chooses between them at run time. `torch.cond` is still marked as a prototype feature. The lab's [export_runtimes.py](/labs/infra/export_runtimes.py) exported a 4-layer, 50-million-parameter decoder with a sequence length between 2 and 1,024, then tried the cases that fail:

```text
2. torch.export: 0.9 s, one graph of 84 operations, sequence length allowed from 2 to 1024
   The first operations: sym_size.int, embedding.default, rms_norm.default, linear.default, view.default, transpose.int
   A 2,000-token input is rejected: AssertionError: Guard failed: ids.size()[1] <= 1024
   Exported without dynamic_shapes, a 300-token input is rejected: Guard failed: ids.size()[1] == 128
   A branch on a tensor's value cannot be exported: GuardOnDataDependentSymNode
   Rewritten with torch.cond it exports, keeping both branches: ['cond']
```

Every limit is explicit: the exported program states the shapes it accepts and refuses others, instead of recompiling. An exported program can be saved with `torch.export.save` as a `.pt2` file, a zip archive in PyTorch's PT2 archive format.

## AOTInductor

AOTInductor is TorchInductor run ahead of time. `torch._inductor.aoti_compile_and_package` takes an exported program and produces a `.pt2` package of compiled shared libraries, which its documentation describes as crafted for deployment in non-Python environments. The package can be loaded back in Python with `torch._inductor.aoti_load_package`, or in a C++ program with `torch::inductor::AOTIModelPackageLoader`, so a C++ service can run the model with no Python interpreter, although it still links libtorch, PyTorch's C++ library. Like a TensorRT engine, the package holds native code compiled for the kind of processor it was built on. At run time, inputs must have the same sizes, types and strides as at export, except for dimensions exported as dynamic.

The kernels are the same kind `torch.compile` generates, so the speed is similar; what changes is when the compile happens. In the lab, AOTInductor compiled the exported decoder in 4.3 seconds into a 200 MB package that contains the weights, and the package ran a 128-token forward pass in 18.0 ms, against 17.8 ms for `torch.compile` and 19.2 ms in eager mode. Loading the package took 2.3 seconds, which is part of every start-up.

## ONNX and ONNX Runtime

ONNX is an open format for machine learning models: a graph of operators from a common, versioned set. Every ONNX graph records an opset version, which fixes the definition of every operator in it, so a runtime knows exactly what the file means. PyTorch's exporter, `torch.onnx.export`, has used `torch.export` underneath by default since PyTorch 2.9 (the `dynamo=True` option), and takes the same kind of `dynamic_shapes` argument.

ONNX Runtime runs ONNX files through execution providers, the back ends for particular hardware: the default CPU provider, CUDA, TensorRT, OpenVINO, Core ML, DirectML and others. A session is given a list of providers in priority order, and each node of the graph runs on the first provider that supports it. When a session is created, ONNX Runtime applies graph optimizations, such as fusing operators and removing redundant ones, at basic, extended and layout levels, all enabled by default; setting `optimized_model_filepath` saves the optimized graph to disk, and later sessions can load that file with optimizations disabled, so that the work is not repeated at every start-up. The saved file is valid only for the execution providers and hardware it was optimized for. For language models, the separate onnxruntime-genai library adds the generation loop around ONNX Runtime: tokenization, the KV cache, sampling and search.

In the lab, exporting the decoder to ONNX took 2.7 seconds and creating an optimized CPU session 0.1 seconds, but ONNX Runtime ran the forward pass in 25.7 ms, about a third slower than eager PyTorch's 19.2 ms on the same 4 threads. A different runtime is not automatically a faster one. For this model on an Apple M2, ONNX Runtime's default CPU provider was simply slower than PyTorch's own CPU kernels; on other hardware, or with another execution provider, the result can reverse. That is why every change of runtime needs its own measurement.

## TensorRT

TensorRT is NVIDIA's ahead-of-time compiler and runtime for its GPUs. Its builder takes a network, usually from an ONNX file, and produces an engine. During the build it fuses layers and selects the fastest available kernel for each layer on the target GPU by timing the candidates, which NVIDIA calls tactics. Because the choice is made by measurement, its documentation notes that when two implementations take similar time, system noise can decide which one is chosen. The build is meant to be an offline step. NVIDIA's documentation says it can take from seconds for small networks to tens of minutes or more for large models, and offers a timing cache, reusable across builds on the same device and versions, to shorten it.

An engine is tied to where it was built. In the words of TensorRT's API documentation, serialized engines are not cross-platform portable and are specific to the exact GPU model on which they were built. By default an engine also runs only with the TensorRT version that built it. Builds can opt into hardware compatibility, for example across all GPUs from the Ampere generation on, and into version compatibility, at some cost in speed.

Dynamic shapes must be planned too. A network with dimensions that vary at run time needs at least one optimization profile, which gives each dynamic dimension a minimum, an optimal and a maximum size; TensorRT tunes the engine for the optimal size, and some operations have fast kernels only when all three are equal. Weights can be replaced without a full rebuild only if the engine was built as refittable. Since TensorRT 11.0, every network must also be strongly typed, with the precision of every tensor stated explicitly rather than chosen by the builder.

Torch-TensorRT connects TensorRT to PyTorch. It compiles a model just in time as a `torch.compile` backend, `backend="tensorrt"`, or ahead of time from a `torch.export` program. Its options choose operations to keep running in PyTorch, `torch_executed_ops`, and whether TensorRT must compile the whole graph, `require_full_compilation`.

## TensorRT-LLM and the return to PyTorch

TensorRT-LLM applied the TensorRT approach to language models. Its classic workflow had three steps: convert a Hugging Face checkpoint into TensorRT-LLM's format, build an engine with `trtllm-build`, and run it. The build fixed the limits the engine would serve: `max_batch_size`, the most requests it can schedule at once; `max_input_len`, the longest prompt; `max_seq_len`, the longest prompt plus output; and `max_num_tokens`, the most tokens in one batch after padding is removed. Its documentation notes that once an engine is built, the size of its activation memory cannot be changed. A new model, a new GPU type, a longer context limit or a new TensorRT-LLM version meant a new build.

That workflow is now history. TensorRT-LLM 1.0, released in September 2025, made a PyTorch backend the default for its Python LLM API and for `trtllm-serve`. In July 2026, starting with the pre-release 1.3.0rc21, the TensorRT engine backend was removed entirely, along with `trtllm-build`, and PyTorch became the only execution backend; the latest stable release, 1.2.1, still includes the old path. The PyTorch backend loads Hugging Face checkpoints directly, runs NVIDIA's custom kernels from a PyTorch program, and by default captures CUDA graphs for batches in which every request is decoding. Using `torch.compile` for lightweight fusion, and piecewise CUDA graphs for batches that include prefill, are optional settings that its documentation still marks as prototypes; vLLM turns both on by default. Both serve requests with in-flight batching, also called continuous batching, over a paged KV cache.

The reasons are visible in this part of the handbook. A language model's shapes change at every step, with the batch size, the prompt lengths and the KV cache length, so an engine built for fixed shapes needs wide profiles or many builds. Models change quickly, and a team that must rebuild an engine for every model, GPU and library version spends its time building. Meanwhile, chapter 3.1 showed that the largest win for decoding, removing launch overhead, comes from CUDA graphs, which a PyTorch-based engine gets without an ahead-of-time build. NVIDIA's custom kernels still matter, but they now plug into a PyTorch program instead of a prebuilt engine.

## Other compilers and runtimes

A few more names come up in interviews and in deployment work:

- **OpenVINO** is Intel's toolkit for converting, optimizing and running models on Intel hardware.
- **Apache TVM** is a compiler that turns trained models into deployable modules for many kinds of hardware, and **MLC LLM**, built on it, is a compiler and deployment engine for language models.
- **XLA** is the compiler behind JAX, and all code that runs on Google's TPUs must be compiled by it.
- **Core ML** is Apple's framework for running models on the CPU, GPU and Neural Engine of Apple devices, and **MLX** is Apple's NumPy-like array framework for machine learning on Apple silicon, which evaluates lazily.
- **llama.cpp** runs language models in C and C++ on top of the GGML tensor library, which builds a computation graph from each model's operations and runs it on CPUs and GPUs.

## When an ahead-of-time engine wins

An ahead-of-time artifact is the better choice when its rigidity costs little or is itself a requirement:

- **No Python in production**, such as a C++ service, a mobile app or an embedded device. AOTInductor packages, ONNX Runtime, TensorRT and Core ML all run without a Python interpreter.
- **Fixed or narrow shapes**, as in image classifiers, embedding models with bounded inputs, rerankers and speech models with fixed windows. One profile, or a few, covers all traffic.
- **Start-up time matters**, for example when containers scale from zero, and a just-in-time compile of 20 or 30 seconds per process is unacceptable. A compile cache shortens it, as chapter 3.1 described, but a prebuilt artifact removes it.
- **A vendor's runtime has faster kernels for the target hardware**, which only a measurement can show.

An ahead-of-time artifact costs build time, an artifact per GPU type and library version, a fixed envelope of shapes and limits, debugging at a distance from the source code, and a lag before new model architectures are supported. For large language models on data-centre GPUs, the major engines have chosen PyTorch programs with CUDA graphs captured at start-up, compiled just in time in vLLM's case, as the better trade.

## Lab: one model, four runtimes

**Tier: [Mac].** The lab runs on a CPU in a few minutes and needs torch, onnx, onnxscript and onnxruntime, plus a C++ compiler for `torch.compile` and AOTInductor.

The script is ready to download: [export_runtimes.py](/labs/infra/export_runtimes.py). Run it with `python export_runtimes.py`. It prints the partial graph of the failing export to standard error, which is expected.

**Part A, export.** Export the decoder with a dynamic sequence length. Show what the exported program does with an input outside its range, what happens without `dynamic_shapes`, and how to export a branch on a tensor's value.

**Part B, four runtimes.** Run the model in eager mode, with `torch.compile`, in ONNX Runtime and as an AOTInductor package. For each, report the build time, the time per forward pass and the largest difference from eager outputs, at two sequence lengths.

**Part C, a recommendation.** In a few sentences, recommend a runtime for a CPU embedding service that must start in under two seconds and run without Python, and explain what you would measure on the production hardware before deciding.

<details>
<summary>Reference solution</summary>

The script's output on an Apple M2 MacBook with 8 GB of memory, on its first run with an empty compile cache:

```text
arm64, Darwin, PyTorch 2.15.0, 4 CPU threads; a 4-layer decoder with 50M parameters

2. torch.export: 0.9 s, one graph of 84 operations, sequence length allowed from 2 to 1024
   The first operations: sym_size.int, embedding.default, rms_norm.default, linear.default, view.default, transpose.int
   A 2,000-token input is rejected: AssertionError: Guard failed: ids.size()[1] <= 1024
   Exported without dynamic_shapes, a 300-token input is rejected: Guard failed: ids.size()[1] == 128
   A branch on a tensor's value cannot be exported: GuardOnDataDependentSymNode
   Rewritten with torch.cond it exports, keeping both branches: ['cond']

3. A forward pass over 128 tokens (outputs also checked at 300 tokens)
                             build   per pass   max diff
   Eager PyTorch              0.0s     19.2 ms    0.0e+00
   torch.compile             19.6s     17.8 ms    1.9e-06   compiled on first call, in the serving process
   ONNX Runtime (CPU)         2.8s     25.7 ms    3.6e-06   export 2.7 s + session 0.1 s; onnxruntime 1.31.1
   AOTInductor package        5.2s     18.0 ms    1.9e-06   export 0.9 s + compile 4.3 s; 200 MB file, loads in 2.3 s
```

*Part A.* The exported program enforces its declared range: a 2,000-token input fails a guard, and a program exported without `dynamic_shapes` accepts only its example's 128 tokens. A Python `if` on a tensor's sum cannot be exported, because the branch depends on data that does not exist at export time; `torch.cond` exports, with both branches in the graph.

*Part B.* All three alternatives match eager outputs to within about 4 × 10⁻⁶ at both lengths, which is float32 rounding. `torch.compile` and AOTInductor generate similar kernels and take 6 to 7% less time than eager, a difference between them of 0.2 ms that is within run-to-run noise; a second run of the script gave 18.2 ms and 17.4 ms. Their real difference is when compilation happens. `torch.compile`'s 19.6 seconds are paid in the serving process, on the first call and again when a second sequence length makes it recompile with a dynamic dimension; the second run compiled in 4.7 seconds, thanks to PyTorch's on-disk compile caches, kept in a `torchinductor_<user>` folder in the system's temporary directory. AOTInductor's 5.2 seconds are paid once, before deployment. ONNX Runtime built fastest but ran slowest here.

*Part C.* Both AOTInductor and ONNX Runtime can run without Python and do no compilation at start-up, and the lab's numbers pull in opposite directions. AOTInductor matched `torch.compile`'s speed, but loading its 200 MB package took 2.3 seconds, already over the two-second budget. ONNX Runtime created its session in 0.1 seconds but ran each pass about a third slower than eager PyTorch. ONNX Runtime is the safer recommendation for the start-up requirement, with AOTInductor worth trying if a C++ service can load its package faster than this Python measurement did. Before deciding, measure the start-up time of the real service, from process start to the first answer, the latency and throughput at the real input lengths, and the outputs against eager PyTorch, on the production CPU, because the ranking of runtimes changes from one CPU to another.

</details>

## Interview angle

- **"When would you use TensorRT or another ahead-of-time engine instead of vLLM?"** Use one for models with fixed or narrow shapes, such as vision, embedding or speech models, for deployments without Python, or when a measurement shows the vendor's engine is faster on the target hardware. For large language models on data-centre GPUs, engines built on PyTorch with CUDA graphs are the norm, and TensorRT-LLM itself moved to that design.
- **"What is fixed when you build a TensorRT engine?"** A build fixes the GPU model, the TensorRT version, the weights, the range of every dynamic dimension through optimization profiles, the kernels chosen for each layer, and, for TensorRT-LLM's classic engines, limits such as the maximum batch size, input length, sequence length and tokens per batch. Changing any of them means a rebuild, unless the engine was built with the matching compatibility or refit options.
- **"How is torch.export different from torch.compile?"** Export captures the whole model ahead of time as one graph of ATen operators and fails on anything it cannot capture, with shapes and their ranges declared up front. `torch.compile` compiles just in time inside the process, tolerates graph breaks by falling back to Python, and recompiles when shapes change.
- **"A colleague switched a model to ONNX Runtime and it got slower. Is that a bug?"** Not necessarily. Each runtime's kernels, fusions and execution providers suit some hardware and shapes better than others, and the lab found ONNX Runtime's default CPU provider slower than eager PyTorch on an M2. Check the execution provider in use, the optimization level, the thread settings and the shapes, then measure again.

## Check yourself

<details>
<summary>Why does torch.export raise an error on a Python if over a tensor's value, when torch.compile would only insert a graph break?</summary>

`torch.compile` runs in the live process, so it can run the `if` in Python with the real value and continue in a new graph. Export must produce a single graph that will later run without the original Python code, and the branch depends on data that does not exist at export time. Rewriting it with `torch.cond` puts both branches and the choice between them into the graph.

</details>

<details>
<summary>A TensorRT engine was built on an H100 and is copied to a server with an L40S and the same TensorRT version. What happens, and what could have been done differently?</summary>

By default the engine will not run: serialized engines are specific to the GPU model they were built on. The options are to build a separate engine on the L40S, or to build with hardware compatibility enabled, which makes an engine usable across GPUs from the Ampere generation on, at some cost in speed.

</details>

<details>
<summary>In the lab, torch.compile and AOTInductor ran at almost the same speed. What actually differs between them?</summary>

They differ in when and where compilation happens, and in what the result depends on. `torch.compile` compiles inside the serving process on the first call, recompiles if shapes or other guarded assumptions change, and needs Python. AOTInductor compiles once before deployment into a package whose accepted shapes are fixed at export, and the package can be loaded by a C++ program without Python.

</details>

<details>
<summary>Why did TensorRT-LLM make PyTorch its default backend and later remove the TensorRT engine backend?</summary>

Language model serving has shapes that change at every step and models that change every few weeks, so engines built for fixed limits needed frequent rebuilds per model, GPU and version. A PyTorch backend loads checkpoints directly and gets most of its speed from NVIDIA's custom kernels and from CUDA graphs captured at start-up, with `torch.compile` fusion and piecewise CUDA graphs available as options, all without a separate build step. It is the design vLLM and SGLang already used.

</details>

## Further reading

- [torch.export](https://docs.pytorch.org/docs/2.15/user_guide/torch_compiler/export.html) explains exported programs, dynamic shapes and the IR, and [torch.cond](https://docs.pytorch.org/docs/2.15/higher_order_ops/cond.html) documents data-dependent control flow.
- [AOTInductor](https://docs.pytorch.org/docs/2.15/user_guide/torch_compiler/torch.compiler_aot_inductor.html) shows how to compile and package an exported program and load it from Python or C++.
- [torch.onnx](https://docs.pytorch.org/docs/2.15/onnx_export.html) documents the exporter, and the [ONNX concepts page](https://onnx.ai/onnx/intro/concepts.html) explains graphs, operators and opsets.
- [ONNX Runtime's execution providers](https://onnxruntime.ai/docs/execution-providers/) and [graph optimizations](https://onnxruntime.ai/docs/performance/model-optimizations/graph-optimizations.html) explain how a session chooses kernels and transforms the graph.
- [How TensorRT works](https://docs.nvidia.com/deeplearning/tensorrt/latest/architecture/how-trt-works.html), [engine compatibility](https://docs.nvidia.com/deeplearning/tensorrt/latest/inference-library/engine-compatibility.html) and [dynamic shapes](https://docs.nvidia.com/deeplearning/tensorrt/latest/inference-library/dynamic-shapes-basics.html), from NVIDIA's TensorRT documentation, cover the builder, portability and optimization profiles.
- [TensorRT-LLM's note on the removal of the TensorRT backend](https://nvidia.github.io/TensorRT-LLM/legacy/tensorrt-backend-removal.html) and its page on [torch.compile and piecewise CUDA graphs](https://nvidia.github.io/TensorRT-LLM/features/torch_compile_and_piecewise_cuda_graph.html) describe the current design.
- [Torch-TensorRT](https://docs.pytorch.org/TensorRT/) explains both its just-in-time and ahead-of-time paths.
- [vLLM's torch.compile integration](https://docs.vllm.ai/en/stable/design/torch_compile.html) explains how a just-in-time engine compiles before serving and caches the result.
