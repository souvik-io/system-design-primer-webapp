# Native code and Python bindings

Every major inference engine is a Python program on top of native code. Python holds the parts that change often, such as the scheduler's policy, the API server and the model definitions, while C++, CUDA and Rust hold the parts that run millions of times: kernels, tokenizers, request routers and, in some engines, the batching loop itself. An inference engineer has to cross that boundary in both directions, reading native code when it misbehaves and writing a small piece of it when a profile points to Python. This chapter covers when native code is worth it, how C++ is bound to Python with pybind11 and nanobind, how arrays cross the boundary without being copied, why the global interpreter lock decides whether threads help, how to register an operator that `torch.compile` understands, and the handful of C++ ideas that this code relies on. The lab writes a top-k and top-p sampler in C++, binds it to Python and measures it against NumPy on 4 threads.

Before this chapter, read [PyTorch execution for inference](/learn/pytorch-execution) and the [CUDA chapter](/learn/cuda-basics), which built a CUDA kernel from Python the same way this chapter builds C++.

## When native code is worth it

Native code already does most of the work in an inference engine. vLLM keeps its custom CUDA and C++ kernels in its `csrc` directory, for operations such as activations, layer normalization, KV cache writes and all-reduce. Hugging Face's tokenizers library is written in Rust, and its documentation says it tokenizes a gigabyte of text in under 20 seconds on a server's CPU. SGLang's router is a Rust program. llama.cpp is written in C and C++ from top to bottom. TensorRT-LLM long had a C++ executor that batched and ran requests, although the project now centres on PyTorch and a Python API.

Writing new native code has costs: a build step, a second language to maintain, and crashes that take the whole process down instead of raising an exception. It pays off in a few situations:

- **A tight loop on the CPU that runs for every token or request**, such as sampling on the CPU, detokenization, matching tokens against a grammar for structured output, or a scheduler's bookkeeping, when a profile shows that Python's per-iteration overhead dominates.
- **Work that must run on several threads at once.** Pure Python code runs on one thread at a time, as explained below; native code that releases the global interpreter lock does not.
- **A GPU kernel that PyTorch does not provide**, as in chapters 2.2 to 2.4.

It is rarely worth it for array arithmetic that NumPy or PyTorch already performs in native code, unless the operation can be fused or restructured as well. Measure first. In GPU engines, sampling usually runs on the GPU: vLLM v0.32.0 uses FlashInfer's sampling kernels by default when the hardware supports them, and otherwise a Triton or PyTorch implementation. The lab samples on the CPU, where the same algorithm shows every part of the binding.

## Binding C++ to Python

A Python extension module is a shared library that the interpreter loads like any other module. Writing one against CPython's C API by hand is laborious, so most projects use a binding library. **pybind11** is a header-only C++ library: a function becomes callable from Python with one line in a `PYBIND11_MODULE` block, and pybind11 converts the arguments and return values between Python and C++ types. In outline, the lab's module looks like this; the full version also binds a variant that holds the GIL and two helpers that report the address C++ sees:

```cpp
PYBIND11_MODULE(native_sampler_ext, m) {
  m.def("sample", &sample, "Top-k/top-p sampling, one token per row, with the GIL released.");
  m.def("filtered_probs", &filtered_probs);
}
```

**nanobind** comes from the author of pybind11, Wenzel Jakob, and covers much of the same ground with a smaller core. Its documentation reports up to about 4 times faster compilation, 5 times smaller binaries and 10 times lower runtime overhead than pybind11. Its `nb::ndarray` type accepts arrays from NumPy, PyTorch, JAX, CuPy and other frameworks through both the buffer protocol and DLPack, described below. For Rust, **PyO3** provides the bindings and **maturin** builds and packages them, and the `numpy` crate lets Rust code borrow a NumPy array's data in place, read-only or writable.

Building is the other half. A package uses setuptools, scikit-build or maturin to compile its extension when it is installed. For experiments, PyTorch's `torch.utils.cpp_extension.load_inline` takes C++ source as a string, writes a Ninja build file, compiles the module and imports it, all from a running Python program. The lab uses it as a build tool even though its C++ code uses only pybind11 and the standard library: the first build took 8.1 seconds on an M2 MacBook, and later runs reload the cached library in a fraction of a second.

## Zero copy: the buffer protocol and DLPack

A binding is only fast if large arrays cross it without being copied. Python's buffer protocol, defined in PEP 3118, lets an object expose a pointer to its memory together with its shape, strides and element type, so that another library can read and write the same memory. NumPy arrays support it. pybind11 binds the protocol itself as `py::buffer`, and offers `py::array_t<T>` for NumPy arrays, which it reads through NumPy's C API. Either way, a C++ function that receives a matching array gets a view of the caller's memory, not a copy.

The details of when pybind11 copies matter, and the lab checks them. The sampler's argument type is `py::array_t<float, py::array::c_style>`, a C-contiguous array of 32-bit floats, without pybind11's `forcecast` flag:

```text
2. Address seen by C++ equals the NumPy buffer's address: True
   A float64 array is refused with a TypeError rather than silently converted into a copy
   A strided view is accepted, but C++ sees a different address, so pybind11 made a contiguous copy: True
   With the argument marked noconvert(), the same view is refused with a TypeError
```

A contiguous float32 array is read in place, at the same address as the NumPy buffer. A float64 array is refused, because without `forcecast` pybind11 converts only when the cast is safe, and float64 to float32 can lose precision. A float16 or int16 array would be accepted and silently copied into a new float32 array, and so would a Python list. A float32 view that is not contiguous, such as every second column, is still accepted, but pybind11 copies it into a new contiguous array first, and the copy happens silently. Marking the argument with `py::arg("logits").noconvert()` makes pybind11 refuse anything that would need converting, so that every accepted call is a zero-copy call. For code on a hot path, that is the safer contract.

The buffer protocol covers only CPU memory. DLPack is the common format for sharing arrays between frameworks, GPU memory included. An object that supports it provides a `__dlpack__` method, which exports the array, and a `__dlpack_device__` method, which reports the device it lives on. `torch.from_dlpack` returns a tensor that shares memory with its input, and NumPy has offered `numpy.from_dlpack` since version 1.23. The Python array API standard asks for zero-copy exchange where possible and a copy only when needed. A CuPy array, a JAX array and a PyTorch tensor on the same GPU can therefore be passed between libraries without moving their data. The same call works between NumPy and PyTorch on the CPU:

```python
import numpy as np, torch
x = np.arange(6, dtype=np.float32)
t = torch.from_dlpack(x)         # no copy: t and x share one buffer
t[0] = 100
print(x[0])                      # 100.0
```

## The GIL and threads

CPython's global interpreter lock, the GIL, lets only one thread execute Python code at a time. pybind11's documentation states the rule for native code: the GIL must be held by the current thread to safely access Python objects, and pybind11 never releases it on its own. A C++ function called from Python therefore holds the GIL for its whole run, and no other thread can run Python, or call into another GIL-holding function, until it returns.

A function that does long work on plain C++ data can release the GIL for that part. In pybind11, constructing a `py::gil_scoped_release` object releases the GIL and destroying it takes the GIL back, and `py::call_guard<py::gil_scoped_release>()` does the same for a whole bound function. In outline, the lab's sampler reads the array's pointer and shape with the GIL held, releases it for the sampling loop, and takes it back to build the result array:

```cpp
const float* data = logits.data();          // the NumPy buffer, read in place
std::vector<int64_t> out(rows);
{
  py::gil_scoped_release no_gil;             // other Python threads may run from here...
  for (int64_t r = 0; r < rows; ++r) out[r] = sample_row(data + r * vocab, vocab, ...);
}                                            // ...until here, where the GIL is taken back
py::array_t<int64_t> result(rows);           // creating a Python object needs the GIL
```

Inside the released region the code must not touch any Python object, and the caller must not modify the array from another thread while it is being read; nothing checks either rule for you. The lab measured what releasing the GIL is worth, sampling batches of 32 rows over Llama 3's 128,256-token vocabulary, with top-k 50, top-p 0.9 and temperature 0.8, on an M2 MacBook. The one-thread run samples the same four batches that the four threads share:

| Version | 1 thread | 4 threads | Throughput on 4 threads |
|---|---|---|---|
| NumPy | 58.20 ms per call | 25.70 ms per call | 2.3 times one thread |
| C++ holding the GIL | 25.29 ms per call | 25.45 ms per call | 1.0 times |
| C++ releasing the GIL | 25.30 ms per call | 7.28 ms per call | 3.5 times |

The 4-thread column is the wall-clock time divided by all the calls the four threads made, so it measures throughput; with the GIL held, each individual call took about four times as long from start to return, because it waited for the other threads' turns. Holding the GIL, four threads did no better than one, because they took turns. Releasing it, the four threads ran at the same time and delivered 3.5 times the throughput. NumPy also gained, 2.3 times, because, as its documentation says, it releases the GIL for many low-level operations; the Python code between those operations still needs the lock. The widget shows the mechanism. Add threads with the GIL held, then release it, then raise the share of each call that runs Python:

```widget
gil-threads
```

The last setting shows a limit that is easy to forget: the parts of each call that run Python still take turns, so if a quarter of each call is Python, no number of threads gives more than four times the throughput of one.

The GIL itself is becoming optional. PEP 703 added a build of CPython without it. In Python 3.13 that free-threaded build was experimental, with its own executable, `python3.13t`. From Python 3.14, under PEP 779, it is officially supported but still optional, and its documentation puts the cost to single-threaded code at roughly 5 to 10%. Extension modules must declare that they are safe without the GIL, as pybind11 modules do by passing `py::mod_gil_not_used()` to `PYBIND11_MODULE`, and importing a module that does not declare it turns the GIL back on for the whole process, with a warning; until the libraries an engine depends on support it, releasing the GIL in native code remains the practical way to use several cores from one process.

## PyTorch custom operators

The sampler above is a plain Python function to PyTorch. That is fine in eager mode, but `torch.compile` cannot see inside it. PyTorch's documentation shows exactly this case: a function built with `load_inline` and called inside a compiled function causes a graph break, the problem chapter 3.1 described. The fix is to register the function as a PyTorch operator, which `torch.compile` treats as a single opaque step whose output shapes it can still work out.

In C++, `TORCH_LIBRARY` declares an operator's schema, its name and typed signature, and `TORCH_LIBRARY_IMPL` registers an implementation for one backend, such as CPU or CUDA. PyTorch's custom operator tutorial uses this example:

```cpp
TORCH_LIBRARY(extension_cpp, m) {
  m.def("mymuladd(Tensor a, Tensor b, float c) -> Tensor");
}

TORCH_LIBRARY_IMPL(extension_cpp, CPU, m) {
  m.impl("mymuladd", &mymuladd_cpu);
}
```

The operator is then callable as `torch.ops.extension_cpp.mymuladd`. For `torch.compile`, it also needs a fake kernel, sometimes called a meta kernel: a function that computes the output's shape, type and device from the inputs' without touching any data, registered from Python with `torch.library.register_fake`:

```python
@torch.library.register_fake("extension_cpp::mymuladd")
def _(a, b, c):
    return torch.empty_like(a)
```

An operator written in Python can be registered the same way with `torch.library.custom_op`, which is useful when an operation should stay opaque to tracing, for example because it calls a library that Dynamo cannot follow.

A compiled extension normally works only with the PyTorch version it was built against, so projects build a separate wheel for each version they support. PyTorch's LibTorch stable ABI addresses that: an extension written against its limited, stable interface, with operators registered through `STABLE_TORCH_LIBRARY`, keeps working across PyTorch versions. The stable ABI is still being extended, PyTorch 2.10 was the first release to enforce its versioning rules, and the custom operator tutorial recommends it from PyTorch 2.10 on. vLLM v0.32.0 already registers its CUDA kernels this way.

## The C++ you need

Native code in inference engines leans on a small set of modern C++ ideas. Each is about who owns a resource and when it is released, which matters more than usual when the resources are GPU memory, CUDA streams and the GIL.

**RAII**, resource acquisition is initialization, ties a resource to an object's lifetime: the constructor acquires it and the destructor releases it, so the resource is released on every path out of a scope, including exceptions. The lab's `py::gil_scoped_release` is RAII applied to the GIL. PyTorch's `c10::cuda::CUDAGuard` and `c10::cuda::CUDAStreamGuard` set the current CUDA device or stream and restore the previous one when the guard goes out of scope. A buffer of GPU memory follows the same pattern:

```cpp
class DeviceBuffer {                         // owns one cudaMalloc allocation
 public:
  explicit DeviceBuffer(size_t bytes) { CHECK_CUDA(cudaMalloc(&ptr_, bytes)); }
  ~DeviceBuffer() { if (ptr_) cudaFree(ptr_); }
  DeviceBuffer(const DeviceBuffer&) = delete;             // no copies: two owners would free twice
  DeviceBuffer& operator=(const DeviceBuffer&) = delete;
  DeviceBuffer(DeviceBuffer&& other) noexcept : ptr_(std::exchange(other.ptr_, nullptr)) {}  // movable; move assignment omitted for brevity
  void* get() const { return ptr_; }
 private:
  void* ptr_ = nullptr;
};
```

**Smart pointers** express ownership in the type. `std::unique_ptr` owns an object alone and deletes it when the pointer goes out of scope; it can be moved but not copied. `std::shared_ptr` shares ownership among several pointers and deletes the object when the last of them is destroyed, at the cost of a reference count.

**Move semantics** transfer a resource instead of copying it. `std::move` marks an object as one that may be moved from, and a move constructor, like `DeviceBuffer`'s above, takes over the other object's resource and leaves it empty. Moving a `std::vector` of a million tokens hands over its buffer without copying a single element.

**`std::span`**, from C++20, refers to a contiguous sequence of objects that someone else owns, as a pointer and a length. The lab passes each row of logits to its filtering function as a `std::span<const float>`, which reads the NumPy buffer directly and carries its length with it.

**A thread-safe queue** connects threads that produce work with threads that consume it, such as a scheduler handing batches to a GPU worker or a tokenizer thread feeding requests to the scheduler. A mutex protects the queue and a condition variable lets consumers sleep until an item arrives:

```cpp
template <typename T>
class BlockingQueue {
 public:
  void push(T item) {
    { std::lock_guard<std::mutex> lock(mu_); items_.push(std::move(item)); }
    ready_.notify_one();
  }
  T pop() {
    std::unique_lock<std::mutex> lock(mu_);
    ready_.wait(lock, [&] { return !items_.empty(); });  // the predicate handles spurious wakeups
    T item = std::move(items_.front());
    items_.pop();
    return item;
  }
 private:
  std::mutex mu_;
  std::condition_variable ready_;
  std::queue<T> items_;
};
```

The predicate passed to `wait` matters: a condition variable may wake a thread spuriously, without any notification, and the predicate form re-checks the condition and goes back to sleep in that case. Note also that `push` releases the mutex before notifying, so the woken thread does not immediately block on the lock.

## Lab: a C++ sampler

**Tier: [Mac].** The lab runs on any machine with a C++ compiler, such as a Mac with Xcode's command line tools or Linux with g++, and needs torch, numpy and ninja. No GPU is needed.

The script is ready to download: [native_sampler.py](/labs/infra/native_sampler.py). It contains the C++ source as a string, builds it with `load_inline`, and runs every part below. Run it with `python native_sampler.py`.

**Part A, the sampler.** Write a function that takes a batch of logits and returns one token per row, applying temperature, then top-k, then top-p, the order in which Hugging Face's `generate` applies them. Top-p, or nucleus sampling, keeps the smallest set of most likely tokens whose probabilities add up to at least p, as defined by Holtzman and colleagues. Bind it with pybind11 so that it reads a NumPy array without copying it.

**Part B, correctness.** Check the filtered distribution against a NumPy implementation, and check that sampled frequencies match the filtered probabilities.

**Part C, threads.** Time NumPy and the C++ sampler on one thread and on 4 threads, with the C++ code holding and releasing the GIL. The lab is done when you can explain each of the six numbers.

<details>
<summary>Reference solution</summary>

The script's output on an Apple M2 MacBook with 8 GB of memory:

```text
arm64, Darwin, Python 3.12.10, NumPy 2.5.4, 8 CPU cores
1. Built (or loaded) the extension in 8.1 s

2. Address seen by C++ equals the NumPy buffer's address: True
   A float64 array is refused with a TypeError rather than silently converted into a copy
   A strided view is accepted, but C++ sees a different address, so pybind11 made a contiguous copy: True
   With the argument marked noconvert(), the same view is refused with a TypeError

3. Filtered distributions, C++ against NumPy: largest difference 2.1e-07; tokens kept per row 16 to 39 of the top 50
   Sampling one row 20,000 times: sample frequencies differ from the probabilities by at most 0.002; tokens outside the filtered set drawn: 0

4. Sampling a batch of 32 rows of 128,256 logits (top-k 50, top-p 0.9, temperature 0.8), 40 calls per thread
   NumPy                  1 thread:  58.20 ms per call   4 threads:  25.70 ms per call (2.3x the throughput)
   C++ holding the GIL    1 thread:  25.29 ms per call   4 threads:  25.45 ms per call (1.0x the throughput)
   C++ releasing the GIL  1 thread:  25.30 ms per call   4 threads:   7.28 ms per call (3.5x the throughput)
```

*Part A.* For each row, the C++ code finds the 50 largest logits with `std::nth_element`, which takes time proportional to the vocabulary, sorts only those 50, computes their probabilities at temperature 0.8, keeps the shortest prefix whose probability reaches 0.9, renormalizes, and draws a token with a seeded random number generator.

*Part B.* The C++ and NumPy distributions agree to 2.1 × 10⁻⁷, which is float32 rounding. Top-p kept between 16 and 39 of the 50 candidates per row, so it did real work on these logits. Over 20,000 draws, every token's frequency was within 0.002 of its probability, and no token outside the filtered set was ever drawn.

*Part C.* On one thread, C++ is 2.3 times faster than NumPy: NumPy makes several full passes over each 128,256-element row and allocates a temporary array for each, while the C++ code makes one selection pass and then works on 50 numbers. Holding the GIL, 4 threads take turns, so throughput stays the same as on one thread (1.0 times). Releasing it, they run in parallel (3.5 times). The shortfall from 4 means that each call took about 15% longer on average with four cores busy, 4 × 7.28 = 29.1 ms against 25.30 ms alone, partly because the run lasts as long as its slowest thread. Memory bandwidth is not the limit: four threads reading 16 MB per call every 29 ms read about 2 GB/s, a small fraction of what the M2 provides. NumPy gets 2.3 times because it releases the GIL inside its own loops but needs it between them.

*Taking it further.* Port the sampler to Rust with PyO3 and maturin. Read the logits through the `numpy` crate's `PyReadonlyArray2`, and release the GIL with `Python::detach`, which PyO3 0.26 introduced as the new name for `Python::allow_threads`; the old name was removed in PyO3 0.28.

</details>

## Interview angle

- **"When would you rewrite part of an inference stack in C++ or Rust?"** When a profile shows a CPU-side loop, such as sampling, detokenization, grammar matching or scheduling, taking a real share of each step, or when work must run in parallel threads and the GIL prevents it. Not for array arithmetic that NumPy or PyTorch already does natively. And on a GPU, moving the work into a kernel is often better still.
- **"How do you pass a large array from Python to C++ without copying it?"** Through the buffer protocol on the CPU, with pybind11's `py::array_t` or nanobind's `nb::ndarray`, or through DLPack for GPU memory and between frameworks. Make the binding refuse arrays it would have to convert, with `noconvert()`, so that a copy can never happen silently.
- **"Your C++ extension doesn't get faster with more threads. Why?"** It probably holds the GIL. Release it with `gil_scoped_release` around the work that touches no Python objects. If it already does, look for the Python part of each call, a lock inside the C++ code, or cores competing for shared memory bandwidth and caches.
- **"Why register a custom op instead of calling a pybind11 function?"** Because `torch.compile` cannot trace into an opaque Python-bound function, which causes a graph break. A registered operator with a fake kernel is one step in the compiled graph whose output shapes the compiler knows.
- **"What is RAII, and where does an inference engine use it?"** Tying a resource to an object's lifetime so the destructor releases it on every exit path. Engines use it for GPU memory buffers, CUDA device and stream guards, locks, and releasing and reacquiring the GIL.

## Check yourself

<details>
<summary>A pybind11 function takes a py::array_t&lt;float, py::array::c_style&gt;. What happens when it is called with a contiguous float32 array, a float64 array, and a float32 array sliced as x[:, ::2]?</summary>

The contiguous float32 array is passed as a view of the caller's memory, with no copy. Without the `forcecast` flag, the float64 array is refused with a `TypeError`. The sliced array is float32 but not contiguous, so pybind11 silently copies it into a new contiguous array and passes the copy. Marking the argument `noconvert()` turns that copy into an error.

</details>

<details>
<summary>Why did 4 threads give the C++ sampler that holds the GIL no more throughput than one thread?</summary>

While a thread holds the GIL, no other thread can run the sampler, so the 4 threads take turns and finish the same total work in the same total time. Releasing the GIL around the loop, which touches no Python objects, lets the threads run on separate cores at the same time.

</details>

<details>
<summary>Each call of a native function spends 10% of its time in Python and releases the GIL for the rest. What is the most throughput 16 threads can get, relative to one thread?</summary>

At most 10 times. The Python part of every call needs the GIL, so those parts run one at a time; once the GIL is busy all the time, which happens at 10 threads, adding threads cannot increase throughput. The C++ parts would allow more, but they are not the bottleneck.

</details>

<details>
<summary>A custom kernel bound with pybind11 is called inside a function compiled with torch.compile(fullgraph=True), and compilation fails. Why, and what is the fix?</summary>

Dynamo cannot trace into a function bound with pybind11, so it would need a graph break there, and `fullgraph=True` turns graph breaks into errors. Register the function as a PyTorch operator, with `TORCH_LIBRARY` in C++ or `torch.library.custom_op` in Python, and give it a fake kernel with `torch.library.register_fake` so the compiler can work out its output shapes without running it.

</details>

<details>
<summary>Why does BlockingQueue::pop pass a predicate to condition_variable::wait instead of calling wait(lock) once?</summary>

A condition variable can wake a waiting thread spuriously, without any notification, and another consumer may have taken the item before this thread runs. The predicate form re-checks that the queue is not empty after every wake-up and waits again if it is, which is equivalent to a loop around `wait`.

</details>

## Further reading

- [pybind11's NumPy documentation](https://pybind11.readthedocs.io/en/stable/advanced/pycpp/numpy.html) covers `py::array_t`, the buffer protocol and the array flags, and its [miscellaneous notes](https://pybind11.readthedocs.io/en/stable/advanced/misc.html) cover the GIL.
- [nanobind's documentation](https://nanobind.readthedocs.io/en/latest/) explains how it differs from pybind11, with benchmarks, and how [nb::ndarray](https://nanobind.readthedocs.io/en/latest/ndarray.html) exchanges arrays.
- [PyTorch's custom C++ and CUDA operators tutorial](https://docs.pytorch.org/tutorials/advanced/cpp_custom_ops.html) walks through `TORCH_LIBRARY`, fake kernels and the stable ABI, and [the torch.library reference](https://docs.pytorch.org/docs/2.15/library.html) documents the Python side.
- [The LibTorch stable ABI notes](https://docs.pytorch.org/docs/2.15/notes/libtorch_stable_abi.html) describe what an extension can use to keep working across PyTorch versions.
- [DLPack](https://dmlc.github.io/dlpack/latest/) and [the array API standard's data interchange page](https://data-apis.org/array-api/latest/design_topics/data_interchange.html) explain how arrays move between frameworks without copies.
- [PEP 703](https://peps.python.org/pep-0703/) explains the free-threaded build of CPython, and [What's new in Python 3.14](https://docs.python.org/3.14/whatsnew/3.14.html) its current status.
- [NumPy's thread safety notes](https://numpy.org/doc/stable/reference/thread_safety.html) explain when NumPy releases the GIL.
- [The Curious Case of Neural Text Degeneration](https://arxiv.org/abs/1904.09751) by Holtzman and colleagues introduces nucleus (top-p) sampling.
- [cppreference.com](https://en.cppreference.com/w/cpp/language/raii) documents RAII, [std::unique_ptr](https://en.cppreference.com/w/cpp/memory/unique_ptr), [std::span](https://en.cppreference.com/w/cpp/container/span) and [std::condition_variable](https://en.cppreference.com/w/cpp/thread/condition_variable).
- [PyO3's parallelism guide](https://pyo3.rs/latest/parallelism.html) shows how Rust extensions release the GIL.
