# CUDA for reading and debugging

Most inference engineers write more Triton than CUDA, but they read CUDA every week. The fastest kernels in vLLM, SGLang, FlashAttention and TensorRT-LLM are CUDA C++, and when one of them misbehaves you need to follow its code and test a fix. This chapter teaches enough CUDA to do that: how a kernel is written and launched, how threads cooperate through shuffles and shared memory, how a kernel is compiled from Python, and how to find memory bugs with NVIDIA's sanitizer. The lab rewrites the RMSNorm from chapter 2.2 in CUDA, measures two versions on an H100, and makes a bug that only the sanitizer catches.

Before this chapter, read [how a GPU executes code](/learn/gpu-execution) and the [fusion section of the Triton chapter](/learn/triton-kernels#fusion-softmax-and-rmsnorm).

## A kernel and its launch

A CUDA kernel is a C++ function marked `__global__`. Every thread runs the same function and works out which data it owns from built-in variables: `threadIdx.x` is its index within the block, `blockIdx.x` is the block's index in the grid, and `blockDim.x` is the number of threads per block. The host code launches the kernel with the grid and block sizes in triple angle brackets:

```cpp
__global__ void scale_kernel(const float* x, float* out, int n, float a) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;   // this thread's element
    if (i < n) out[i] = a * x[i];                    // threads past the end do nothing
}

// on the host: enough blocks of 256 threads to cover n elements, on PyTorch's current stream
scale_kernel<<<(n + 255) / 256, 256, 0, stream>>>(x, out, n, 2.0f);
```

The third launch argument is the bytes of dynamic shared memory per block, and the fourth is the **stream**. A stream is a queue of GPU work that runs in order; work in different streams may overlap. PyTorch keeps a current stream per device, and a kernel launched from a PyTorch extension should use `at::cuda::getCurrentCUDAStream()` so that it runs in order with PyTorch's own operations. Kernel launches return immediately, so an error inside a kernel only surfaces at the next operation that waits for the GPU, which is why setting `CUDA_LAUNCH_BLOCKING=1` makes every launch synchronous while debugging.

Compared with Triton, the thread is now the unit. The Triton vector add from chapter 2.2 handled a block of 1,024 elements in one program; the CUDA version runs 1,024 threads that each handle one element, and coalescing comes from consecutive threads reading consecutive addresses.

## Threads cooperating: shuffles and shared memory

A reduction, such as the sum of squares in RMSNorm, needs threads to combine their values. CUDA offers two tools for that.

**Warp shuffles** let the 32 threads of a warp read each other's registers directly. `__shfl_xor_sync(0xffffffff, v, offset)` returns the value of `v` held by the lane whose index is this lane's index XOR `offset`. Five shuffles with offsets 16, 8, 4, 2 and 1 add up all 32 values, and every lane ends with the total:

```cpp
__device__ float warp_sum(float v) {
    for (int offset = 16; offset > 0; offset /= 2) v += __shfl_xor_sync(0xffffffff, v, offset);
    return v;
}
```

The first argument is a mask of the lanes taking part, which must all reach the call. The widget below steps through the five shuffles. Compare the XOR version with `__shfl_down_sync`, which sends values one way and leaves the total only in lane 0:

```widget
warp-reduce
```

**Shared memory** combines values across warps. Each warp reduces its own values with shuffles, one lane of each warp writes the warp's result to a small `__shared__` array, and after a `__syncthreads()` barrier the first warp reduces those results:

```cpp
__device__ float block_sum(float v) {
    __shared__ float partial[32];
    int lane = threadIdx.x % 32, warp = threadIdx.x / 32;
    v = warp_sum(v);
    if (lane == 0) partial[warp] = v;
    __syncthreads();                                           // every warp's result is now written
    v = (threadIdx.x < blockDim.x / 32) ? partial[threadIdx.x] : 0.0f;
    if (warp == 0) v = warp_sum(v);
    if (threadIdx.x == 0) partial[0] = v;
    __syncthreads();                                           // the total is visible to every thread
    return partial[0];
}
```

`__syncthreads()` makes every thread of the block wait until all have reached it, and it must be reached by all of them: a barrier inside a branch that only some threads take can hang the kernel. NVIDIA's CUB library provides tested versions of these patterns, and production kernels often use its `cub::BlockReduce` instead of writing their own.

## RMSNorm in CUDA

The lab's RMSNorm runs one block of 512 threads per row. The first version mirrors the Triton kernel in the simplest way: each thread walks the row in steps of 512, reading one BF16 value at a time, adds up squares, reduces them with `block_sum`, then walks the row again to write the scaled output.

```cpp
__global__ void rmsnorm_naive_kernel(const __nv_bfloat16* x, const __nv_bfloat16* w, __nv_bfloat16* out,
                                     int cols, float eps) {
    const __nv_bfloat16* row = x + (size_t)blockIdx.x * cols;
    __nv_bfloat16* orow = out + (size_t)blockIdx.x * cols;
    float ss = 0.0f;
    for (int i = threadIdx.x; i < cols; i += blockDim.x) {          // consecutive threads, consecutive values
        float v = __bfloat162float(row[i]);
        ss += v * v;
    }
    float rstd = rsqrtf(block_sum(ss) / cols + eps);
    for (int i = threadIdx.x; i < cols; i += blockDim.x)            // second pass reads the row again
        orow[i] = __float2bfloat16(__bfloat162float(row[i]) * rstd * __bfloat162float(w[i]));
}
```

The accesses are coalesced, but each load moves only 2 bytes per thread, so the kernel issues many small memory instructions. The second version reinterprets the row as `uint4`, a 16-byte type, so each thread loads eight BF16 values in one instruction and keeps them in a small per-thread array for the second pass, which then reads nothing from memory but the weights. The full kernel is in the lab script. On an H100, with 16,384 rows of 4,096 values, the four implementations measured as follows:

```text
NVIDIA H100 80GB HBM3, PyTorch 2.15.0+cu132, CUDA 13.2

RMSNorm, 16384 x 4096 BF16
  CUDA, one value per load     1411 GB/s   max error 3.1e-02
  CUDA, 16-byte loads          2514 GB/s   max error 1.6e-02
  Triton (chapter 2.2)         2831 GB/s   max error 3.1e-02
  PyTorch F.rms_norm           2118 GB/s   max error 3.1e-02
```

Wider loads made the kernel 1.8 times faster, which is the main lesson: a memory-bound kernel needs few, wide memory instructions as well as coalesced addresses. The Triton kernel is still about 13% faster than the vectorized CUDA version, because its compiler made choices this kernel does not, and closing that gap is the lab's extension. All the errors are one or half a BF16 rounding step, as in chapter 2.2.

## Reading a production kernel

vLLM's RMSNorm kernels in [`csrc/layernorm_kernels.cu`](https://github.com/vllm-project/vllm/blob/main/csrc/layernorm_kernels.cu) follow the same plan with more generality, and reading them is good practice. Four things to look for:

- **Templates over the element type and vector width.** The kernel is written once as `template <typename scalar_t, int VEC_SIZE, ...>`, and the host code picks an instantiation for BF16, FP16 or FP32 at run time.
- **Vectorized reads with an alignment fallback.** A helper reads the row in vectors of `VEC_SIZE` elements and falls back to single elements when the row's address or length does not allow it. The lab's kernel instead refuses rows whose length is not a multiple of 8 and assumes each tensor starts on a 16-byte boundary, which holds for tensors PyTorch has just allocated but not for every view.
- **A library reduction.** The sum of squares goes through `cub::BlockReduce` with shared `TempStorage`, the tested version of the `block_sum` above.
- **Fusion with the residual add.** A second kernel, `fused_add_rms_norm_kernel`, adds the residual and normalises in one kernel launch, writing the sum back into the residual buffer and the normalised output in place over the input, because a decoder layer always does the two together, as [chapter 1.1](/learn/transformer-as-workload#one-layer-as-a-list-of-operations) showed.

The same reading strategy works for larger kernels: find the launch configuration in the host code, work out what one block and one thread own, then follow the loads, the reductions and the stores. FlashAttention's kernels add tiles in shared memory and tensor-core instructions on top of these patterns, and chapter 2.4 builds one in Triton.

## Debugging kernels

Kernel bugs are hard to see because a wrong memory access rarely crashes. An out-of-bounds write usually lands in memory the program owns and corrupts something else, and the visible symptom appears later and far away. NVIDIA's `compute-sanitizer` runs a program under instrumentation and checks every access. Its documentation lists four tools:

- **memcheck** finds out-of-bounds and misaligned memory accesses and, with `--leak-check full`, memory leaks;
- **racecheck** finds data races on shared memory, such as a missing `__syncthreads()`;
- **initcheck** finds reads of device memory that was never written;
- **synccheck** finds invalid uses of synchronization, such as a barrier that only some threads reach.

The lab's `cuda_bug.py` makes the classic mistake, a bounds check written as `i <= n` instead of `i < n`, so the thread whose index equals n, the first one past the data, touches one element past the end. Run normally, the result is correct, because the stray access lands harmlessly. Run under memcheck, the error is reported at once, with the kernel, the thread and the distance from the allocation. The first line below comes from the normal run; the lines that start with `=========` come from the run under the sanitizer, which never prints its own result because the kernel is stopped:

```text
result looks right: True  (under the sanitizer: False)
========= COMPUTE-SANITIZER
========= Invalid __global__ read of size 4 bytes
=========     at scale_kernel(const float *, float *, int, float)+0x90
=========     by thread (232,0,0) in block (3,0,0)
=========     Access to 0x2ac5f0c00fa0 is out of bounds
=========     and is 1 bytes after the nearest allocation at 0x2ac5f0c00000 of size 4000 bytes
=========
========= Program hit cudaErrorLaunchFailure (error 719) due to "unspecified launch failure" on CUDA API call to cudaDeviceSynchronize.
=========
========= Program hit cudaErrorLaunchFailure (error 719) due to "unspecified launch failure" on CUDA API call to cudaGetLastError.
=========
========= CUDA API Error: Sticky error detected
```

Thread 232 of block 3 is element 3 × 256 + 232 = 1,000, one past the last of 1,000 elements. The read of `x[1000]` is caught first, before the write that would follow it. The sanitizer then stops the kernel, so the next CUDA calls report a launch failure (error 719), which is "sticky": once a kernel has faulted, every later CUDA call in the process fails until it restarts. That is also what a real out-of-bounds fault looks like in production. One detail matters with PyTorch: its caching allocator hands out pieces of larger blocks, so an access just past one tensor may land inside memory the allocator owns, and the sanitizer cannot tell. Setting `PYTORCH_NO_CUDA_MEMORY_CACHING=1` gives every tensor its own allocation, as the lab's script does.

## CUTLASS, CuTe, ThunderKittens and HIP

You will meet a few other names in kernel code, and it helps to know what each one is:

- **CUTLASS** is NVIDIA's open-source C++ template library for matmuls and convolutions, and **CuTe** is its layer for describing tensor layouts and how threads map onto them. Many fast kernels, including FlashAttention-3, are built on them.
- **ThunderKittens**, from Stanford's Hazy Research lab, is a smaller C++ library that expresses kernels in terms of tiles held in registers and shared memory.
- **HIP** is AMD's equivalent of CUDA for ROCm. Its runtime API plays the same role as the CUDA runtime, and AMD's HIPIFY tools translate CUDA source into HIP. The difference that most often breaks ported code is the warp size: AMD's documentation gives 64 threads per wavefront on its CDNA Instinct GPUs and 32 on RDNA, so code that assumes 32 lanes, such as the five-step shuffle above, needs care.

## Lab: RMSNorm in CUDA

**Tier: [1 GPU].** The lab needs an NVIDIA GPU and the CUDA toolkit, because PyTorch compiles the CUDA code with `nvcc` when the script starts. On Modal, the `--toolkit` option of the runner uses NVIDIA's CUDA 13.2 development image, which includes `nvcc` and `compute-sanitizer`. The H100 run cost about 5 cents, most of it compile time, and the sanitizer demo on an A10 about 2 cents.

The scripts are ready to download:

- [gpu/cuda_rmsnorm.py](/labs/infra/gpu/cuda_rmsnorm.py) holds both CUDA kernels, compiles them with `torch.utils.cpp_extension.load_inline`, and compares them with the Triton kernel and PyTorch.
- [gpu/cuda_bug.py](/labs/infra/gpu/cuda_bug.py) holds the off-by-one kernel and runs itself under `compute-sanitizer`.
- Run them with `modal run modal_run.py --script cuda_rmsnorm.py --gpu H100 --toolkit`, or with `python cuda_rmsnorm.py` on a machine with an NVIDIA GPU and the CUDA toolkit.

**Part A, a CUDA RMSNorm.** Write an RMSNorm kernel for BF16 rows in CUDA, with one block per row, a warp-shuffle reduction and a shared-memory reduction across warps. Expose it to Python with `load_inline` and check it against a PyTorch reference. Then write a second version with 16-byte loads and measure both in GB/s. The part is done when both versions are within one BF16 rounding step of the reference and the vectorized version is at least 1.5 times faster than the first.

**Part B, a bug the sanitizer finds.** Write a kernel with an off-by-one bounds check, show that its result looks correct, then run it under `compute-sanitizer --tool memcheck` and explain each line of the report.

**Extension.** Close the gap between your vectorized kernel and the Triton one. Try 256 threads per block with two vectors per thread, or more rows per block, and use Nsight Compute in chapter 2.5 to see what changes.

<details>
<summary>Reference solution</summary>

The scripts above are the reference solution. Their outputs are printed in the sections on RMSNorm in CUDA and on debugging kernels. These are the points a strong solution gets right:

- **Correctness first.** Both kernels check with `TORCH_CHECK` that their inputs are contiguous BF16 CUDA tensors of the right shape, and the vectorized kernel refuses rows whose length is not a multiple of 8, so a bad input fails loudly rather than reading out of bounds.
- **The stream.** Both launches use `at::cuda::getCurrentCUDAStream()`. A kernel launched on the default stream instead can run out of order with PyTorch's own work and be timed wrongly by `triton.testing.do_bench`.
- **The reduction.** `block_sum` writes one partial sum per warp and synchronizes twice, once before the first warp reads the partial sums and once before every thread reads the total.
- **Launch errors.** `C10_CUDA_KERNEL_LAUNCH_CHECK()` after each launch turns a failed launch, such as an invalid block size, into a Python exception at the right line.

For Part B, the four lines of the report say what happened (an invalid read of 4 bytes), where (in `scale_kernel`, at an instruction offset), who did it (thread 232 of block 3, which is element 1,000) and how far out of bounds it was (the access starts at byte 4,000, immediately after the end of a 4,000-byte allocation that holds exactly 1,000 floats; the sanitizer counts this as 1 byte past the allocation's last byte).

</details>

## Interview angle

- **"Write a kernel that sums a vector."** Give each block a slice, have each thread accumulate a strided part of the slice, reduce within warps with `__shfl_xor_sync`, reduce across warps through shared memory, and combine the blocks' results with a second kernel or an atomic add. Mention coalescing and wide loads.
- **"Your kernel returns correct results but a later operation crashes. How do you debug it?"** Set `CUDA_LAUNCH_BLOCKING=1` to make the failure appear at the kernel that caused it, then run under `compute-sanitizer` with memcheck, and with racecheck if shared memory is involved. With PyTorch, disable the caching allocator so the sanitizer sees exact allocation bounds.
- **"Why did 16-byte loads speed up your RMSNorm?"** The kernel is memory-bound, and with 2-byte loads each thread issues eight times as many memory instructions for the same data. Wider loads cut the instruction count and let each request move a full 16 bytes per thread.
- **"What breaks when you port a CUDA kernel to AMD?"** The warp size: CDNA GPUs run 64-thread wavefronts, so shuffle reductions, masks and anything sized for 32 lanes must change. The APIs themselves map closely, and HIPIFY translates most of the source.

## Check yourself

<details>
<summary>In scale_kernel launched with 256 threads per block, which element does thread 232 of block 3 handle?</summary>

Element blockIdx.x × blockDim.x + threadIdx.x = 3 × 256 + 232 = 1,000. With 1,000 elements, indexes run from 0 to 999, so this thread is one past the end and must do nothing, which the buggy `i <= n` check fails to ensure.

</details>

<details>
<summary>After five __shfl_xor_sync steps with offsets 16, 8, 4, 2 and 1, what does each lane hold, and why five steps?</summary>

Every lane holds the sum of all 32 lanes' values. Each step adds the value from a lane at a distance that halves each time, so the number of values in each lane's sum doubles: 2, 4, 8, 16, then 32. Since 2 to the power 5 is 32, five steps cover the warp.

</details>

<details>
<summary>Why does block_sum call __syncthreads() twice?</summary>

The first barrier makes sure every warp has written its partial sum to shared memory before warp 0 reads them. The second makes sure warp 0 has written the total before the other threads read it. Without either barrier, some threads could read shared memory before it holds the value they need.

</details>

<details>
<summary>A memcheck run under PyTorch reports nothing, although you are sure the kernel writes past the end of a tensor. What might hide the error?</summary>

PyTorch's caching allocator places tensors inside larger allocations, so a write just past one tensor can land in memory that is still part of a valid allocation, and the sanitizer sees nothing wrong. Setting `PYTORCH_NO_CUDA_MEMORY_CACHING=1` gives each tensor its own allocation, so its exact end is visible to the sanitizer.

</details>

<details>
<summary>What is the difference between a CUDA warp and an AMD wavefront, and why does it matter?</summary>

Both are the group of threads that execute one instruction together, but AMD documents 64 threads per wavefront on CDNA GPUs such as the Instinct line and 32 on RDNA, while NVIDIA warps are always 32. Code that hard-codes 32 lanes, in shuffle reductions or lane masks, gives wrong results or wastes half the wavefront on CDNA.

</details>

## Further reading

- [The CUDA programming guide](https://docs.nvidia.com/cuda/cuda-programming-guide/index.html) covers kernels, the thread hierarchy, shared memory, streams and the warp shuffle functions used here.
- [The Compute Sanitizer documentation](https://docs.nvidia.com/compute-sanitizer/ComputeSanitizer/index.html) describes memcheck, racecheck, initcheck and synccheck and how to read their reports.
- [PyTorch's torch.utils.cpp_extension reference](https://docs.pytorch.org/docs/stable/cpp_extension.html) documents `load_inline` and the build tools used in the lab, and the [custom C++ and CUDA operators tutorial](https://docs.pytorch.org/tutorials/advanced/cpp_custom_ops.html) shows how to register such code as a PyTorch operator.
- [vLLM's layernorm kernels](https://github.com/vllm-project/vllm/blob/main/csrc/layernorm_kernels.cu) are the production RMSNorm discussed above.
- [CUB, part of NVIDIA's CCCL libraries](https://nvidia.github.io/cccl/), provides block- and warp-level reductions, scans and sorts, including `cub::BlockReduce`.
- [CUTLASS and CuTe](https://github.com/NVIDIA/cutlass) and [ThunderKittens](https://github.com/HazyResearch/ThunderKittens) are the libraries most fast attention and matmul kernels are built on.
- [AMD's HIP programming model](https://rocm.docs.amd.com/projects/HIP/en/latest/understand/programming_model.html) and the [HIPIFY tools](https://rocm.docs.amd.com/projects/HIPIFY/en/latest/) cover what changes on AMD GPUs.
