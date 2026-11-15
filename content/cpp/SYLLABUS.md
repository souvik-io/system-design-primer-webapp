# C++ for AI Infrastructure Engineers: syllabus

Working title: **C++ for AI Infrastructure Engineers: from your first CMake build to CUDA kernels.**

This is the plan for the third course on the site, published at `/cpp`. Chapters in this folder are published once they are listed in a `PARTS` entry with `handbook: 'cpp'` and `dir: 'cpp'` in `scripts/build-content.mjs`; this file never is. The part ids must match `PLANNED` in `src/pages/CppHomePage.tsx`, which shows the parts that are not published yet under "Still to come".

The reader already programs, most likely in Python, and wants to work on the systems that run models. The course teaches C++ in the order those systems need it, and ends with an LLM inference engine the reader writes from scratch.

---

## How this course relates to the other two

The [AI Infrastructure Engineer Handbook](/infra) explains what inference engines do and measures them: the roofline, GPU execution, Triton kernels, FlashAttention, bindings and the GIL, and a serving engine written in Python. This course teaches the language underneath. Where the two overlap, a chapter here links to the infra chapter for the idea and spends its own words on the C++:

| This course | Already explained in the infra handbook |
|---|---|
| Ch. 13, how hardware runs code | `/learn/inference-arithmetic` (roofline, memory-bound decode) |
| Ch. 22, interop with Python | `/learn/native-code` (bindings, zero copy, the GIL) |
| Ch. 23 to 25, GPU model and memory | `/learn/gpu-execution` (warps, occupancy, coalescing, bank conflicts) |
| Ch. 24 and 27, first kernels and reductions | `/learn/cuda-basics` (kernel launch, shuffles, RMSNorm in CUDA) |
| Ch. 27, online softmax | `/learn/flash-attention#online-softmax` |
| Ch. 28, profiling and CUDA graphs | `/learn/profiling`, `/learn/pytorch-execution` |
| Ch. 29, PyTorch ops and Triton | `/learn/native-code#pytorch-custom-operators`, `/learn/triton-kernels` |
| Capstone | `/learn/mini-inference-engine` (the same ideas, in Python, at serving scale) |

## Conventions for every chapter

Each chapter follows the same rules as the infra handbook:

1. Every factual claim is checked against a primary source (the C++ standard or cppreference, compiler and CUDA documentation, papers, project source code).
2. The chapters are written without running the labs. A number that needs a real machine comes from a published source (a paper, vendor documentation, a well-known benchmark article) and is cited. If no trustworthy published number exists, the chapter explains what to expect and why, and gives no output. It never shows invented output.
3. The author runs the labs while studying and reports the results, what they noticed, and what failed. Those measurements are then added to the chapter with the machine they came from. Each place waiting for a measurement is marked with an HTML comment `<!-- measure: what to run and what to record -->`, which the content build strips, so it never reaches the published page, and `grep -rn "measure:" content/cpp` lists what is still open.
4. The prose is complete sentences. Each topic opens with why it matters before how it works, ideally with a small story or a bug the reader will recognise.
5. Code ships twice: inline in the chapter and as downloadable files under `public/labs/cpp/<chapter-id>/`, linked as `/labs/cpp/<chapter-id>/<file>`, each folder with a `CMakeLists.txt` and the exact build and run commands.
6. A chapter has an interactive widget when one teaches the idea better than text (a cache simulator, a race-condition stepper, a warp-access visualiser), with "try these settings" prompts.
7. It ends with "Check yourself" (`<details>` Q&A) and "Further reading" with sources.
8. Each part gets one flashcard deck with `handbook: 'cpp'`.
9. Chapter ids start with `cpp-`, because ids share the `/learn/<id>` namespace with the other two courses.

## Where the labs run

A reader needs only a laptop for Parts I to V and any NVIDIA GPU for Part VI (Google Colab's free T4 is enough, or a rented cloud GPU). A few topics are easier on Linux: `perf` is Linux-only (Instruments is the macOS equivalent), and AVX2 and AVX-512 need an x86 processor, while Apple silicon has NEON. Each chapter says what its lab needs. Toolchain differences that a chapter must mention:

- Apple clang ships without OpenMP, so Chapter 20 uses Homebrew's `libomp` or Homebrew's g++.
- Apple clang rejects `std::execution::par` unless you pass `-fexperimental-library`, which turns on libc++'s experimental parallel algorithms. With g++, libstdc++ needs Intel TBB for them.

---

## How the units work

A **unit** is a relative measure of focus. A 4-unit chapter deserves twice the attention of a 2-unit one. The whole syllabus is **134 units**, so divide your available time by 134 to see what one unit means for you.

| Part | Focus | Units |
|---|---|---|
| I | The ground rules | 16 |
| II | Ownership and abstraction | 24 |
| III | Performance | 16 |
| IV | Concurrency | 28 |
| V | Systems glue | 9 |
| VI | CUDA | 29 |
| Capstone | Tiny LLM inference engine | 12 |

The weighting is deliberate. Syntax gets very little, because the reader already programs. Concurrency and CUDA get the most, because they are what AI infrastructure roles test and use.

---

## Part I: The ground rules (16 units)

Part id `cpp-ground-rules`. **Goal:** understand how C++ turns code into a program and how it handles memory, which are the two things Python hides completely.

### Chapter 1: Toolchain and compilation model (2 units)

**Topics:** the preprocessor, compiler and linker; headers and source files; declarations and definitions; translation units and the one-definition rule; include guards and `#pragma once`; a minimal `CMakeLists.txt`; Debug and Release builds; compiler flags (`-std`, `-Wall -Wextra`, `-O0/-O2/-O3`, `-g`, sanitizers).

**Why:** Most early C++ frustration comes from linker errors and header confusion, not from logic bugs. Once you know which stage is complaining, you can fix the error yourself.

**Why it matters for AI infra:** PyTorch, llama.cpp, vLLM's kernels and ONNX Runtime all live inside large CMake builds. You will build them from source, add files to them and fix their build errors.

### Chapter 2: Syntax speedrun (1 unit)

**Topics:** variables, `auto`, `const` and `constexpr`, loops, conditions, `switch`, functions, overloading, default arguments, `enum class`, namespaces, structured bindings, `static_cast`, fixed-width types (`int8_t`, `uint32_t`), integer division, and mixing signed and unsigned values.

**Why:** You know control flow already, so only the differences matter: a stricter type system, and operations that silently give the wrong answer (integer division, overflow, unsigned comparisons).

**Why it matters for AI infra:** Exact-width integer types are the basis of quantization (int8, and int4 packed two to a byte), and a dtype enum appears in every tensor library.

### Chapter 3: Memory: stack, heap and lifetime (3 units)

**Topics:** the stack and the heap, scope, object lifetime and destruction order, `new`/`delete` and `new[]`/`delete[]`, `sizeof`, `alignof`, struct padding, and stack size limits.

**Why:** This is the biggest change from Python. In C++ you decide where data lives and how long it lives.

**Why it matters for AI infra:** Tensors, KV caches, activation buffers and memory pools are all decisions about allocation and lifetime. An inference engine is largely a memory-management system.

### Chapter 4: Pointers, references and const (4 units)

**Topics:** `&` and `*`, `nullptr`, references, pointer arithmetic, raw arrays and how they decay to pointers, passing by value, by reference, by const reference and by pointer, `const` in every position, row-major flat indexing (`A[i * cols + j]`), and a naive matmul written with pointers.

**Why:** Every low-level API speaks in pointers and lengths. Const-correctness tells you from a function's signature what it may modify.

**Why it matters for AI infra:** A tensor is a pointer plus a shape and strides. CUDA kernels, BLAS calls and custom ops take `const float*` inputs and `float*` outputs. The rest of the course builds on this chapter.

### Chapter 5: Undefined behavior (2 units)

**Topics:** out-of-bounds access, use-after-free, double free, dangling references, reading uninitialized memory, signed overflow, why turning on optimization exposes hidden bugs, AddressSanitizer and UndefinedBehaviorSanitizer, and `.at()` versus `[]`.

**Why:** Python raises an exception. C++ may silently produce a wrong result or crash somewhere unrelated. Sanitizers find the real cause in seconds.

**Why it matters for AI infra:** A kernel that outputs plausible but wrong numbers is the worst kind of bug in ML systems, and you need to recognise its symptoms quickly.

### Project A: Log analyzer CLI (4 units)

**Build:** a tool that reads a five-million-line server log (generated with Python) and reports requests per status code, the slowest endpoints, and p50, p95 and p99 latency. Write the Python version first, then the C++ version, then compare their speed.

**Why:** It is your first real multi-file C++ program, built with CMake, run clean under sanitizers and benchmarked against Python.

**Why it matters for AI infra:** Latency percentiles are the language of serving systems. You will measure them again in Project E.

---

## Part II: Ownership and abstraction (24 units)

Part id `cpp-ownership`. **Goal:** write safe, modern C++ in which resources clean themselves up and large data is never copied by accident.

### Chapter 6: Classes and RAII (3 units)

**Topics:** classes and structs, constructors, member initializer lists, `explicit`, destructors, non-copyable types (`= delete`), const member functions, and a reusable `ScopedTimer`.

**Why:** RAII (tie a resource to an object and release it in the destructor) is the most important idea in C++.

**Why it matters for AI infra:** GPU buffers, file handles, mutex locks, CUDA streams and model sessions are all managed through RAII wrappers. Your thread pool and tensor class depend on it.

### Chapter 7: Copy and move semantics (4 units)

**Topics:** the copy constructor and copy assignment, lvalues and rvalues, what `std::move` really does, the move constructor and move assignment, `noexcept`, the rules of zero, three and five, copy elision, and copy-and-swap.

**Why:** It is the core of performance thinking in C++, and a favourite interview topic.

**Why it matters for AI infra:** Accidentally copying a large weight buffer is a classic performance bug. Moves let you hand tensors between functions and threads without copying their data.

### Chapter 8: Smart pointers and ownership (2 units)

**Topics:** `unique_ptr`, `shared_ptr`, `weak_ptr`, `make_unique` and `make_shared`, custom deleters, reference cycles, and when a plain reference is the right way to give non-owning access.

**Why:** Modern C++ code almost never calls `delete`. The real skill is designing who owns what.

**Why it matters for AI infra:** Models, sessions, caches and requests all have different lifetimes. Clear ownership prevents leaks in long-running servers, where even a small leak eventually kills the process.

### Chapter 9: STL containers and algorithms (3 units)

**Topics:** how `vector` grows and what `reserve` does, `emplace_back`, iterator invalidation, `array`, `unordered_map`, `deque`, `queue`, `string` versus `string_view`, `span`, `<algorithm>`, `<numeric>`, `partial_sort` and `nth_element`.

**Why:** The standard library replaces raw loops and raw memory with tested, fast building blocks.

**Why it matters for AI infra:** `vector<float>` is your first tensor storage. `span` and `string_view` teach the "view without copying" idea behind tensor views. Top-k sampling is a `partial_sort` or `nth_element`, and a tokenizer's vocabulary is a hash map.

### Chapter 10: Lambdas (2 units)

**Topics:** lambda syntax, capture by value and by reference, `[this]`, init captures, `mutable`, generic lambdas, and `std::function` and its cost.

**Why:** Lambdas are everywhere in modern C++, and a capture mistake becomes a dangling reference.

**Why it matters for AI infra:** Every thread you start and every task you submit to a thread pool is a lambda. Getting captures right here prevents concurrency bugs in Part IV.

### Chapter 11: Templates (3 units)

**Topics:** function templates, class templates, type deduction, non-type template parameters, why templates live in headers, C++20 concepts, `if constexpr`, and reading template error messages.

**Why:** Generic code is the norm in C++ libraries, and you need to read it fluently.

**Why it matters for AI infra:** Kernels are written once for many dtypes (fp32, fp16, bf16, int8). Eigen, CUTLASS and PyTorch's internals are heavily templated.

### Chapter 12: Error handling (1 unit)

**Topics:** exceptions, `try`/`catch`, `noexcept`, exception safety, `std::optional`, `std::expected` (C++23), and C-style error codes such as `cudaError_t`.

**Why:** Each style fits different situations, and you should choose one deliberately.

**Why it matters for AI infra:** Model loaders return errors, hot loops avoid exceptions, CUDA uses error codes, and Python bindings turn C++ errors into Python exceptions.

### Project B: Tensor library (6 units)

**Build:** `Tensor<T>` with contiguous storage, shape, strides, storage shared between views, zero-copy `transpose` and `slice`, `contiguous()`, elementwise ops and matmul, with tests against values computed by NumPy.

**Why:** It combines RAII, moves, ownership, templates and error handling in one real design.

**Why it matters for AI infra:** This is how PyTorch tensors work inside (storage, offset, shape and strides). It becomes the data structure of the capstone.

---

## Part III: Performance (16 units)

Part id `cpp-performance`. **Goal:** understand why code is fast or slow at the hardware level, and measure it honestly.

### Chapter 13: How hardware runs code (4 units)

**Topics:** registers, the L1, L2 and L3 caches and DRAM, and their latencies; cache lines; spatial and temporal locality; prefetching; loop order and row-major access; arrays of structs versus structs of arrays; branch prediction; arithmetic intensity; and the roofline model.

**Why:** Big-O notation ignores memory. Two O(n³) matmul loops that differ only in loop order can run many times apart in speed, and the chapter measures by how much.

**Why it matters for AI infra:** This is the central idea of the field. At small batch sizes, each decode step of an LLM reads every weight once, so decoding is limited by memory bandwidth. Batching, quantization, tiling, KV-cache layout and FlashAttention all exist to move less data.

### Chapter 14: Measuring performance (3 units)

**Topics:** `std::chrono::steady_clock`, warmup runs, repetitions and medians, dead-code elimination, computing GFLOPS and GB/s, `perf stat` and `perf record` on Linux (Instruments on macOS), and reading assembly on Compiler Explorer.

**Why:** Optimization without measurement is guessing, and a broken benchmark lies convincingly.

**Why it matters for AI infra:** The job is to make claims like "this kernel reaches 80% of memory bandwidth" and back them up. Profiling is daily work.

### Chapter 15: Vectorization and SIMD (3 units)

**Topics:** SSE, AVX2 and AVX-512 on x86 and NEON on ARM; auto-vectorization and compiler reports; what blocks vectorization (aliasing, loop-carried dependencies, branches); `__restrict`; alignment; `-ffast-math`; and intrinsics (load, fused multiply-add, horizontal sum, handling the tail).

**Why:** One instruction that processes 8 or 16 numbers is where CPU speed comes from.

**Why it matters for AI infra:** llama.cpp, oneDNN and other fast CPU inference paths are built on SIMD. GPUs use a similar way of thinking, so this chapter also prepares you for Part VI.

### Project C: Matmul optimization ladder (6 units)

**Build:** a single-threaded matmul taken from naive i-j-k, to i-k-j, to a transposed B, to cache tiling (with a sweep of tile sizes), to a SIMD micro-kernel, with GFLOPS recorded at each step and compared with NumPy.

**Why:** It teaches every Part III idea on one problem, with measurable results.

**Why it matters for AI infra:** Matmul is most of a transformer's compute. "Walk me through optimizing a matmul" is a common AI infra interview question, and you will have real numbers to talk about.

---

## Part IV: Concurrency (28 units)

Part id `cpp-concurrency`. **Goal:** write correct and fast multithreaded code, and understand why "correct" and "fast" are separate problems.

### Chapter 16: Threads and data races (3 units)

**Topics:** `std::thread`, `std::jthread`, join and detach, passing arguments (`std::ref`), `hardware_concurrency()`, what a data race is, ThreadSanitizer, and per-thread partial results.

**Why:** These are the foundations, and you need to watch a race happen and watch the tool catch it.

**Why it matters for AI infra:** Request handling, data loading, CPU kernels and tokenization all run on many threads.

### Chapter 17: Mutexes and condition variables (3 units)

**Topics:** `mutex`, `lock_guard`, `unique_lock`, `scoped_lock`, deadlock and lock ordering, `condition_variable`, spurious wakeups, and a blocking producer-consumer queue that shuts down cleanly.

**Why:** These are the building blocks of every queue and coordination pattern.

**Why it matters for AI infra:** An inference server is a set of queues: requests arrive, a scheduler batches them and workers run them. Condition variables let idle workers sleep instead of burning CPU.

### Chapter 18: Atomics and the memory model (3 units)

**Topics:** `std::atomic`, `fetch_add`, compare-exchange loops, memory orderings (relaxed, acquire, release), publishing data from one thread to another, atomics versus locks, and why spinlocks are usually a bad idea.

**Why:** It is the layer under every lock and lock-free structure. It is hard, so the basics must be learned correctly.

**Why it matters for AI infra:** Work counters, ready flags, reference counts and lock-free queues appear in high-performance runtimes, and the same ideas return as GPU atomics in Part VI.

### Chapter 19: Futures and thread pools (4 units)

**Topics:** `std::async`, `future`, `promise`, `packaged_task`, exception propagation, designing a thread pool (task queue, workers, shutdown), and `parallel_for`.

**Why:** Creating a thread per task is expensive, so real systems reuse a pool. Building one combines Chapters 6, 10, 16 and 17.

**Why it matters for AI infra:** Runtimes keep thread pools at their core: ONNX Runtime has its own, PyTorch runs intra-op parallelism on a pool of threads, and llama.cpp's ggml has a thread pool. You will reuse yours in Projects D and E and in the capstone.

### Chapter 20: Parallel patterns and pitfalls (3 units)

**Topics:** static and dynamic scheduling, load imbalance, false sharing and cache-line padding, Amdahl's law, speedup curves, OpenMP (`parallel for`, `schedule`), and the parallel STL algorithms.

**Why:** Correct parallel code can still be slow. This chapter explains why 8 threads can give a 4× speedup and how to find the missing 4×.

**Why it matters for AI infra:** Scheduling and load balancing are central to batching and serving. Uneven sequence lengths in a batch are a load-imbalance problem.

### Project D: Parallel fractal renderer (6 units)

**Build:** a Mandelbrot renderer that writes PPM images, in both languages. In Python: naive, then `threading` (to see the GIL), then `multiprocessing`, then NumPy, then the free-threaded build of Python 3.14 (`python3.14t`). In C++: one thread, then a static split by rows, then interleaved rows, then dynamic scheduling with an atomic counter, then the thread pool, then OpenMP. Benchmark every step.

**Why:** It is visual and fun, and it hides a real lesson: some rows cost far more than others, so a naive split leaves threads unbalanced.

**Why it matters for AI infra:** It shows the GIL next to native threads, which is why Python orchestrates and C++ executes in AI systems, and it teaches load balancing and how to benchmark parallel speedup.

### Project E: Mini inference-server simulator (6 units)

**Build:** a request queue, a pool of worker threads and a dynamic batcher (wait for up to B requests or T milliseconds, whichever comes first). The "model" is a matmul. Measure throughput and p50 and p99 latency as the batch size and timeout change.

**Why:** It applies every concurrency idea to a realistic system design problem.

**Why it matters for AI infra:** It is a scaled-down version of the batching in vLLM, SGLang and Triton Inference Server. The throughput-versus-latency trade-off of batching is the central idea of model serving, and a strong system design interview topic.

---

## Part V: Systems glue (9 units)

Part id `cpp-systems-glue`. **Goal:** load real model files efficiently and connect your C++ to Python.

### Chapter 21: Files, binary formats and mmap (2 units)

**Topics:** binary file I/O, reading raw bytes into structs, endianness, memory-mapping with `mmap`, lazy page loading, and parsing a safetensors header (an 8-byte length, then JSON, then raw tensor bytes).

**Why:** Models are just big binary files, and reading them efficiently is a systems skill.

**Why it matters for AI infra:** llama.cpp memory-maps model files by default, and the safetensors library uses mmap too, which is why a multi-gigabyte model can start almost instantly. Loading weights is the first milestone of the capstone.

### Chapter 22: Interop with Python (3 units)

**Topics:** `extern "C"` and name mangling, the ABI, shared libraries, `ctypes`, pybind11 functions and classes, NumPy arrays without copies, releasing the GIL, and building extensions with CMake.

**Why:** It connects your two languages.

**Why it matters for AI infra:** This is the defining pattern of the field: Python orchestrates and C++ or CUDA does the work. PyTorch itself is a C++ core exposed through bindings.

### Project F: fastkernels Python module (4 units)

**Build:** a Python package that exposes your threaded matmul, softmax and RMSNorm from C++, without copying inputs and with the GIL released, tested against NumPy with `np.allclose` and benchmarked.

**Why:** It turns earlier work into something usable from Python.

**Why it matters for AI infra:** It is how custom operators get added to ML frameworks, and it is a strong portfolio piece.

---

## Part VI: CUDA (29 units)

Part id `cpp-cuda`. **Goal:** write, optimize and profile GPU kernels for the operations transformers actually use.

CUDA needs an NVIDIA GPU. Readers on a Mac can use Google Colab's free T4 or a rented cloud GPU.

### Chapter 23: The GPU mental model (2 units)

**Topics:** how CPUs and GPUs are designed differently, SIMT, streaming multiprocessors, warps of 32 threads, grids, blocks and threads, host and device code, hiding latency through occupancy, your first `__global__` kernel, and querying device properties.

**Why:** A GPU needs a different way of thinking: thousands of lightweight threads instead of a few heavy ones.

**Why it matters for AI infra:** Nearly all training and inference runs on GPUs, and every GPU optimization conversation assumes this model.

### Chapter 24: First real kernels (3 units)

**Topics:** `cudaMalloc`, `cudaMemcpy` and `cudaFree`, an error-checking macro, the global thread index and bounds guards, choosing block and grid sizes, grid-stride loops, timing with CUDA events, the cost of host-device transfers, and an RAII device-buffer class.

**Why:** It is the whole workflow of a GPU program, end to end.

**Why it matters for AI infra:** Transfers often dominate small workloads. Knowing this explains why frameworks keep data on the GPU and watch every CPU-GPU copy.

### Chapter 25: The memory hierarchy and coalescing (4 units)

**Topics:** global memory, shared memory, registers and L2; coalesced and strided access; shared-memory tiling; `__syncthreads`; bank conflicts and padding; naive and tiled transpose; and measuring effective bandwidth.

**Why:** It is the lesson of Chapter 13 again, on a GPU and with bigger consequences.

**Why it matters for AI infra:** Most transformer ops besides matmul (norms, activations, softmax, RoPE) are memory-bound on GPUs, and coalescing and shared memory decide whether they are fast.

### Chapter 26: Tiled matmul on the GPU (4 units)

**Topics:** a naive matmul kernel, a shared-memory tiled matmul, why the second `__syncthreads` is needed, choosing a tile size, comparing with cuBLAS (and its column-major layout), register tiling, and an introduction to Tensor Cores and CUTLASS.

**Why:** It is the GPU version of Project C, and the most important kernel in deep learning.

**Why it matters for AI infra:** Matmul is most of a model's FLOPs. Knowing why cuBLAS is fast, and how close a hand-written kernel can get, is core GPU knowledge.

### Chapter 27: Reductions and softmax (4 units)

**Topics:** reduction with atomics, with a shared-memory tree and with warp shuffles (`__shfl_down_sync`); row-wise softmax with one warp per row; numerical stability (subtracting the maximum); an RMSNorm kernel; and online softmax.

**Why:** Reduction is a fundamental GPU pattern that appears everywhere.

**Why it matters for AI infra:** Softmax and normalization appear in every transformer layer, and online softmax is the key idea behind FlashAttention.

### Chapter 28: Streams, async work and profiling (3 units)

**Topics:** pinned host memory, `cudaMemcpyAsync`, streams, overlapping copies with compute, Nsight Systems (the timeline) and Nsight Compute (inside one kernel), and an introduction to CUDA Graphs.

**Why:** Real GPU programs pipeline work so the GPU never waits.

**Why it matters for AI infra:** Overlapping transfers, cutting launch overhead (vLLM captures CUDA graphs for decoding) and profiling with Nsight are daily skills in GPU infrastructure roles.

### Chapter 29: CUDA from Python and PyTorch (3 units)

**Topics:** custom CUDA ops for PyTorch with `torch.utils.cpp_extension`, input checks, launching on PyTorch's current stream, fusing several operations into one kernel, and an overview of Triton.

**Why:** It connects GPU work to the ecosystem where it is used.

**Why it matters for AI infra:** Custom fused kernels are how teams make models faster than stock PyTorch, and Triton is increasingly common for writing them.

### Project G: CUDA transformer ops kit (6 units)

**Build:** CUDA kernels for RMSNorm, softmax, RoPE, tiled matmul and fused SiLU-multiply, each tested against PyTorch and reported in GB/s or GFLOPS.

**Why:** It applies all of Part VI to real transformer operations.

**Why it matters for AI infra:** These are the kernels inside every LLM inference engine, and they become the GPU backend of the capstone.

---

## Capstone: Tiny LLM inference engine (12 units)

Part id `cpp-capstone`. **Build:** run Karpathy's `stories15M` model (the llama2.c weights) in your own C++ engine:

1. Load the checkpoint with mmap into your tensor structs.
2. Implement RMSNorm, matmul, RoPE, attention with a KV cache, SwiGLU and softmax.
3. Add the tokenizer and sampling (greedy, temperature, top-p).
4. Parallelize matmul with your thread pool and measure tokens per second.
5. Stretch goals: int8 weight quantization, a CUDA backend built from the Project G kernels, and a pybind11 `generate()` callable from Python.

**Why:** It brings every part of the course together in one working system.

**Why it matters for AI infra:** It is clear evidence for an AI infra role: "I built an inference engine from scratch, parallelized it on the CPU, ported its kernels to CUDA, and measured every step." It also gives first-hand understanding of what vLLM, llama.cpp and TensorRT-LLM do inside.

**If short on time:** an MNIST MLP inference engine with a threaded matmul and int8 weights uses the same skills on a smaller model.

---

## Writing stages

The course is written one stage at a time. Each stage is reviewed and committed before the next one starts, and measurements from the author's own runs are added later as they come in, and a part is added to `PARTS` (and its deck to `DECKS`) when its first chapter is written.

| Stage | Contents | Units |
|---|---|---|
| 0 | Site wiring for `/cpp`, this syllabus | – |
| 1 | Ch. 1 toolchain and Ch. 2 syntax speedrun | 3 |
| 2 | Ch. 3 memory | 3 |
| 3 | Ch. 4 pointers, references and const | 4 |
| 4 | Ch. 5 undefined behavior | 2 |
| 5 | Project A, then the Part I deck | 4 |
| 6 | Ch. 6 classes and RAII | 3 |
| 7 | Ch. 7 copy and move | 4 |
| 8 | Ch. 8 smart pointers and Ch. 9 STL | 5 |
| 9 | Ch. 10 lambdas | 2 |
| 10 | Ch. 11 templates and Ch. 12 error handling | 4 |
| 11 | Project B, then the Part II deck | 6 |
| 12 | Ch. 13 how hardware runs code | 4 |
| 13 | Ch. 14 measuring performance | 3 |
| 14 | Ch. 15 SIMD | 3 |
| 15 | Project C, then the Part III deck | 6 |
| 16 | Ch. 16 threads and data races | 3 |
| 17 | Ch. 17 mutexes and condition variables | 3 |
| 18 | Ch. 18 atomics | 3 |
| 19 | Ch. 19 futures and thread pools | 4 |
| 20 | Ch. 20 parallel patterns | 3 |
| 21 | Project D | 6 |
| 22 | Project E, then the Part IV deck | 6 |
| 23 | Ch. 21 files and mmap and Ch. 22 Python interop | 5 |
| 24 | Project F, then the Part V deck | 4 |
| 25 | Ch. 23 GPU mental model and Ch. 24 first kernels | 5 |
| 26 | Ch. 25 memory hierarchy and coalescing | 4 |
| 27 | Ch. 26 tiled matmul | 4 |
| 28 | Ch. 27 reductions and softmax | 4 |
| 29 | Ch. 28 streams and profiling | 3 |
| 30 | Ch. 29 CUDA from PyTorch | 3 |
| 31 | Project G, then the Part VI deck | 6 |
| 32 | Capstone steps 1 to 3: a working CPU engine | 7 |
| 33 | Capstone steps 4 and 5: threads, int8, CUDA and Python, then the capstone deck | 5 |
