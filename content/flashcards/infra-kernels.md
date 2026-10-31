<!-- Flashcards for Part 2 of the AI Infrastructure Engineer Handbook: how a GPU executes code, Triton, CUDA, FlashAttention, and profiling. -->

<!-- chapter: gpu-execution -->

## What is a warp, and what happens when the threads of a warp take different branches?
<!-- /learn/gpu-execution#from-a-kernel-launch-to-warps -->

A warp is a group of **32 threads** that the hardware schedules together: one instruction is issued for all of them, each applying it to its own data (SIMT). When threads of a warp take different branches of an `if`, the warp runs **both paths one after the other**, with the threads of the other path switched off, so divergent branches cost time.

## How does a GPU hide memory latency, and what is occupancy?
<!-- /learn/gpu-execution#hiding-latency-with-many-warps -->

Each SM keeps many warps resident and issues an instruction from a ready warp every cycle, so while one warp waits for memory others compute. Each warp's context stays on the chip, so switching costs nothing. **Occupancy** is active warps per SM divided by the maximum the SM supports, and it is limited by warp slots, block slots, registers and shared memory. Higher occupancy does not always mean higher performance.

## A kernel uses blocks of 256 threads at 64 registers per thread on an H100. What is its occupancy?
<!-- /learn/gpu-execution#hiding-latency-with-many-warps -->

One block needs 256 × 64 = 16,384 registers, and an SM has 65,536, so **four blocks** fit. Four blocks of 8 warps are 32 of the 64 warp slots, so occupancy is **50%**, limited by registers.

## What is memory coalescing, and what does a stride of 2 do to it?
<!-- /learn/gpu-execution#coalescing-how-a-warp-reads-memory -->

On compute capability 6.0 and newer, a warp's loads are served in **32-byte sectors**, and each needed sector is fetched once. If thread k reads the k-th 4-byte word of an aligned array, the warp's 128 bytes arrive in four sectors with nothing wasted. With a **stride of 2**, half of every sector is unused, and the CUDA Best Practices Guide gives the load efficiency as **50%**. Misaligned reads touch five sectors instead of four.

## What did the lab measure for strided and random reads on an H100?
<!-- /learn/gpu-execution#coalescing-how-a-warp-reads-memory -->

Reading 16M float32 values contiguously delivered **2,717 GB/s** of useful data. The rate fell by about half with each doubling of the stride, to 676 GB/s at a stride of 8 and 240 GB/s at 32. **Random** reads delivered 199 GB/s, **7%** of the contiguous rate.

## What is a shared memory bank conflict, and how does padding a 32 × 32 tile fix the column read?
<!-- /learn/gpu-execution#shared-memory-and-bank-conflicts -->

Shared memory has **32 banks** of 4-byte words. Threads of a warp that read different words in the same bank are serialised; the same word is broadcast. A column of a 32 × 32 float32 tile puts every element in one bank, a **32-way conflict**. Padding each row to **33 words** spreads the column over all 32 banks, so it reads in one pass.

## What share of the H100's dense peak did large matmuls reach, and why must you halve NVIDIA's printed figures?
<!-- /learn/gpu-execution#tensor-cores-and-the-matmul-peak -->

NVIDIA lists H100 tensor-core figures **with sparsity**, which doubles them, so the dense BF16 peak is about 989 TFLOP/s, not 1,979. The lab measured **803 TFLOP/s in BF16 (81%)**, 1,411 in FP8 (71%), 417 in TF32 (84%) and 52 in FP32 without tensor cores (78%). A 1,024-square matmul reached only about a tenth of the peak, because it is too small to fill all 132 SMs.

## Name four Hopper or Blackwell features that fast inference kernels rely on, and what each does.
<!-- /learn/gpu-execution#hopper-and-blackwell-features-worth-knowing -->

**TMA** copies tensors between global and shared memory asynchronously. **Thread block clusters** let blocks on nearby SMs share their shared memory (distributed shared memory). **Warp specialization** splits warps into loaders and computers, as FlashAttention-3 does. **FP8 tensor cores** double the BF16 rate. Blackwell adds **Tensor Memory** for matmul accumulators and FP4 tensor cores.

<!-- chapter: triton-kernels -->

## How does Triton's programming model differ from CUDA's?
<!-- /learn/triton-kernels#blocks-not-threads -->

A CUDA kernel is written for **one thread**. A Triton kernel is written for **one program that handles a block** of data as vectors and small matrices, using `tl.program_id`, `tl.arange`, masked `tl.load` and `tl.store`, reductions and `tl.dot`. The compiler maps each program onto a thread block and handles coalescing, shared memory, tensor cores and pipelining.

## Why was the fused Triton RMSNorm about ten times faster than RMSNorm written as plain PyTorch operations?
<!-- /learn/triton-kernels#fusion-softmax-and-rmsnorm -->

RMSNorm is **memory-bound**. As plain operations it runs a chain of kernels, each reading and writing the whole tensor through HBM. The fused kernel reads each row **once**, keeps it in registers for the reduction and scaling, and writes it once. On the H100 it reached **2,860 GB/s**, 95% of the measured copy bandwidth, against 266 GB/s for the plain version and 2,256 for `F.rms_norm`.

## What is the arithmetic intensity of a BM × BN matmul tile with no reuse between programs, and what does it give for 16 × 16 and 128 × 256?
<!-- /learn/triton-kernels#tiled-matmul -->

In BF16 it is **BM × BN ÷ (BM + BN)** FLOPs per byte. A 16 × 16 tile gives **8**, far below the H100's ridge point of 295. A 128 × 256 tile gives about **85**, and reuse of panels through L2 between programs of a wave raises the effective figure further.

## What does grouped tile order do in a Triton matmul, and why did it help an A10 far more than an H100?
<!-- /learn/triton-kernels#tile-order-and-the-l2-cache -->

Grouped order walks tiles in groups of `GROUP_M` rows, column by column, so each wave of programs covers a squarer region and reads **fewer panels** of A and B. With 128 × 256 tiles on the H100, the model predicted the matmul stays compute-bound in either order, and grouping gained **3%**. On the A10 (600 GB/s, 128 × 128 tiles), the model predicted row-major order is memory-bound, and grouping gained **25%**, from 59 to 74 TFLOP/s.

## What does num_stages control in a Triton matmul, and what limits it?
<!-- /learn/triton-kernels#autotuning -->

It sets how many K slices are loaded **ahead** of the one being multiplied (software pipelining), hiding memory latency behind tensor-core work. Each stage needs its own tiles in **shared memory**: three stages of a 128 × 256 × 64 BF16 tile need **96 KB** and just fit the 99 KB an A10 allows per block, while four stages need 144 KB and fit only on a GPU such as the H100.

## When is writing a custom kernel worth it, and when is it not?
<!-- /learn/triton-kernels#when-to-write-a-kernel -->

It pays for **memory-bound chains** of operations that run as separate kernels, for unusual shapes, and for operations no library provides, such as an MoE grouped matmul. It rarely pays for a **large plain matmul**, where cuBLAS and CUTLASS are already near the hardware's limit, or where `torch.compile` already fuses the operations.

<!-- chapter: cuda-basics -->

## How do the five steps of __shfl_xor_sync sum a value across a warp?
<!-- /learn/cuda-basics#threads-cooperating-shuffles-and-shared-memory -->

Each step, every lane adds the value held by the lane whose index is its own **XOR the offset**, with offsets 16, 8, 4, 2 and 1. The number of values in each lane's sum doubles every step, so after **five steps** (2⁵ = 32) every lane holds the total. The exchange is between registers, with no shared memory or `__syncthreads()`. `__shfl_down_sync` leaves the total only in lane 0.

## Why did 16-byte loads make the CUDA RMSNorm 1.8 times faster?
<!-- /learn/cuda-basics#rmsnorm-in-cuda -->

The kernel is memory-bound. Reading one 2-byte BF16 value per load makes each thread issue **eight times as many memory instructions** for the same data. Reinterpreting the row as `uint4` loads eight values per instruction and keeps them in registers for the second pass. On the H100 it went from **1,411 to 2,514 GB/s**.

## Which tool finds an out-of-bounds kernel access, and why must PyTorch's caching allocator be turned off when using it?
<!-- /learn/cuda-basics#debugging-kernels -->

**compute-sanitizer** with its **memcheck** tool reports invalid accesses with the kernel, the thread and the distance from the allocation. PyTorch's caching allocator places tensors inside larger allocations, so an access just past one tensor can land in valid memory and go unseen. **PYTORCH_NO_CUDA_MEMORY_CACHING=1** gives each tensor its own allocation. Its other tools are racecheck, initcheck and synccheck.

## What breaks most often when a CUDA kernel is ported to AMD GPUs?
<!-- /learn/cuda-basics#cutlass-cute-thunderkittens-and-hip -->

The **warp size**. AMD documents **64 threads per wavefront** on CDNA Instinct GPUs and 32 on RDNA, while NVIDIA warps are always 32. Code that assumes 32 lanes, such as the five-step shuffle reduction, needs care. HIP's runtime API plays the same role as CUDA's, and AMD's HIPIFY tools translate CUDA source into HIP.

<!-- chapter: flash-attention -->

## Explain the online softmax.
<!-- /learn/flash-attention#online-softmax -->

Process a row in blocks, keeping a running maximum **m** and a running sum **l** of exp(s − m). For each block, compute m_new, multiply the old sum by **alpha = exp(m − m_new)**, then add the block's exp(s − m_new). For attention, an output accumulator is rescaled by the same alpha. At the end acc ÷ l equals the exact softmax-weighted output, without the whole row ever existing at once.

## How does FlashAttention avoid storing the N × N matrix?
<!-- /learn/flash-attention#tiling-attention-through-sram -->

Each program loads a **block of queries** once, then walks the keys and values in blocks, computing that block's scores with a tensor-core matmul in registers and updating the running maximum, sum and output with the online softmax. With a causal mask it stops after the block containing its last query. The scores never reach HBM, so the traffic is about four times smaller than even the minimum for ordinary attention, and about 15 times smaller than plain PyTorch.

## What did the lab measure for plain PyTorch attention, the Triton FlashAttention kernel and SDPA on an H100?
<!-- /learn/flash-attention#measured-on-an-h100 -->

For causal BF16 attention at batch 4 with 16 heads of 128, plain PyTorch ran at **16 to 18 TFLOP/s**, because it is memory-bound at every length, and its intermediate N × N matrices needed **40 GiB** at 8,192 tokens. The 50-line Triton kernel reached **364 TFLOP/s** at 16,384 tokens, and SDPA reached **586**. The outputs agreed to one BF16 rounding step.

## What did FlashAttention-2 and FlashAttention-3 each change?
<!-- /learn/flash-attention#flashattention-1-2-and-3 -->

**FlashAttention-2** reduced non-matmul FLOPs, parallelised across the sequence even for one head, and split work between warps to cut shared-memory traffic, reaching 50% to 73% of an A100's peak. **FlashAttention-3** used TMA and warp specialization to overlap memory and compute, interleaved softmax with the matmuls, and added FP8, reaching up to 740 TFLOP/s in FP16 on H100.

## Why does decode need Flash-Decoding, and how does it combine its chunks?
<!-- /learn/flash-attention#attention-during-decode -->

In decode each sequence has **one query**, so a kernel that parallelises over query blocks leaves most SMs idle at small batch. Flash-Decoding **splits the KV cache into chunks** along the sequence, computes each in parallel, saves a log-sum-exp per row and chunk, and combines the chunks by rescaling each with its log-sum-exp, which is the online softmax applied across chunks.

<!-- chapter: profiling -->

## Two measurements of the same BF16 matmul on two H100s gave 803 and 678 TFLOP/s. How can the method explain that?
<!-- /learn/profiling#benchmarking-without-fooling-yourself -->

One script reported the **fastest of 20** back-to-back runs. Triton's `do_bench` returns the **mean** and **clears the L2 cache** before every run. Neither number is wrong, and neither means anything without its method.

## What did nvidia-smi show during a long run of matmuls on an H100, and what does it mean for benchmarks?
<!-- /learn/profiling#benchmarking-without-fooling-yourself -->

Power reached the **700 W limit** and the SM clock fell from 1,980 MHz to about **1,410 MHz**. A short benchmark that ends before the GPU reaches its power limit reports a higher rate than a long production run. Record the clocks and power with every benchmark result, and run long enough to reach a steady state.

## What did the profile of a batch-1 decode step of Llama 3.2 1B on an H100 show?
<!-- /learn/profiling#profiling-a-decode-step-with-the-pytorch-profiler -->

The step took **7.49 ms** against a roofline estimate of 0.74 ms. It ran **694 kernels** totalling **2.21 ms** of GPU work, so the GPU was idle about **70%** of the time, with a median kernel of 1.7 µs. The step is limited by **CPU launch overhead**; CUDA graphs and kernel fusion are the fix. An earlier run of the same script on another Modal host took 15.68 ms, twice as long, because the host CPU limits the launch rate.

## What do sectors per request and DRAM throughput from Nsight Compute tell you about a memory-bound kernel?
<!-- /learn/profiling#nsight-compute-inside-one-kernel -->

**Sectors per request** shows coalescing: the lab's contiguous read loaded 16 sectors per warp request (16-byte loads) and the stride-8 read 32, the worst case. **DRAM throughput** counts every byte moved, so the strided kernel kept DRAM 95% busy yet ran 4.3 times slower, moving eight times as many sectors for the same useful data. High DRAM throughput alone does not mean an efficient kernel.
