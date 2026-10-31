# How a GPU executes code

Part 1 treated a GPU as two numbers, peak FLOPs and memory bandwidth, and that was enough to predict how fast a model runs. Writing or fixing a kernel needs a closer look. This chapter explains how a GPU runs thousands of threads at once, why it groups them into warps, how its memory is layered from registers to HBM, and why the order in which threads read memory can change a kernel's speed by ten times. Every measurement in the chapter was taken with the lab's scripts on a rented H100 or A10, or on an M2 MacBook, and every specification is from NVIDIA's documentation.

Before this chapter, read [GPUs and accelerators](/learn/gpus-for-ai) for what a GPU is for, and [the step-time model](/learn/inference-arithmetic#the-step-time-model) for how the roofline predicts an operation's time.

## From a kernel launch to warps

A **kernel** is a function that runs on the GPU. When a program launches one, it asks for a **grid** of **thread blocks**, and every thread in every block runs the same function on different data. A kernel that adds two vectors of a million numbers might use a grid of 4,096 blocks of 256 threads, one thread per number.

The hardware runs blocks on **streaming multiprocessors (SMs)**. The H100 in this chapter's lab reported 132 of them. The GPU assigns each block to one SM, where the block stays until it finishes, so threads in a block can share fast on-chip memory and wait for each other. An SM can hold several blocks at once, and a grid usually has many more blocks than the GPU has SMs, so blocks queue for a free SM.

Inside an SM, each block is split into **warps** of 32 threads. The warp is the unit the hardware schedules: one instruction is issued for all 32 threads of a warp together, each applying it to its own data. NVIDIA calls this single-instruction, multiple-thread (SIMT) execution. When the threads of a warp take different branches of an `if`, the warp runs both paths one after the other, with the threads of the other path switched off, so branches that split warps cost time.

```diagram
title: A kernel launch: the grid's blocks are spread over the SMs, and each block runs as warps of 32 threads.
[grid] Grid of blocks\none kernel launch @ 0,1
[sm0] SM 0\nholds a few blocks @ 1,0
[sm1] SM 1\nholds a few blocks @ 1,1
[smn] SM 131\nholds a few blocks @ 1,2
[warps] Warps of 32\nthreads each @ 2,1
[units] Execution units\nand tensor cores @ 3,1
grid -> sm0
grid -> sm1
grid -> smn
sm1 -> warps : split into warps
warps -> units : scheduler issues
```

## Hiding latency with many warps

A read from HBM takes hundreds of clock cycles to come back. A CPU core hides that delay with large caches and by reordering instructions. A GPU hides it with numbers instead: each SM keeps many warps resident at once and, every cycle, issues an instruction from a warp that is ready. While one warp waits for memory, others compute. The CUDA programming guide explains that each warp's execution context, its program counter and registers, stays on the chip for the warp's whole life, so switching between warps costs nothing.

That only works if enough warps are resident. **Occupancy** is the number of active warps on an SM divided by the maximum the SM supports, as NVIDIA's CUDA Best Practices Guide defines it. Four resources limit how many blocks fit on one SM at a time:

| Resource per SM | H100 (compute capability 9.0) | L4 (compute capability 8.9) |
|---|---|---|
| Warp slots | 64 (2,048 threads) | 48 (1,536 threads) |
| Block slots | 32 | 24 |
| 32-bit registers | 65,536 | 65,536 |
| Shared memory | 228 KB, at most 227 KB per block | 100 KB, at most 99 KB per block |

The figures come from NVIDIA's Hopper and Ada tuning guides, and the lab's probe printed the same register and shared memory sizes on a real H100. Registers are usually the limit that bites. A block of 256 threads that uses 64 registers per thread needs 16,384 registers, so at most four such blocks fit on an SM, which is 32 of the H100's 64 warp slots and 50% occupancy.

High occupancy is not a goal in itself. The Best Practices Guide states that higher occupancy does not always mean higher performance. Memory-bound kernels such as element-wise operations need many warps in flight to keep the memory system busy. Matmul kernels often run best at low occupancy, because each warp keeps many independent loads and tensor-core operations in flight, and the registers that limit occupancy are what hold its tile of the output.

The widget below computes occupancy for one kernel configuration. Try these settings:

- Start at 256 threads, 32 registers and no shared memory. Everything fits, and occupancy is 100% on both GPUs.
- Raise the registers to 64, then to 128. The register file becomes the limit: on the H100 occupancy halves each time, to 50% and then 25%, and on the L4 it falls to 67% and then 33%.
- Set shared memory to 64 KB per block on the L4. Only one block fits, because the L4 has 100 KB of shared memory per SM and CUDA reserves another 1 KB for each block.

```widget
occupancy
```

## The memory hierarchy

A GPU's memory comes in layers. Each layer down is larger and slower, and a fast kernel keeps the data it reuses as high in the stack as it can.

| Layer | H100 SXM | L4 | Who controls it |
|---|---|---|---|
| Registers | 64K × 4 bytes = 256 KB per SM | 256 KB per SM | The compiler, per thread |
| L1 cache and shared memory | 256 KB per SM combined, up to 228 KB as shared memory | 128 KB per SM combined, up to 100 KB as shared memory | Shared memory is managed by the kernel; L1 by the hardware |
| L2 cache | 50 MB for the whole GPU | 48 MB for the whole GPU | The hardware |
| HBM or GDDR | 80 GB of HBM3 at 3.35 TB/s | 24 GB of GDDR6 at 300 GB/s | The program, through allocations |

The H100 rows come from the Hopper tuning guide and NVIDIA's H100 specifications, and the L4 rows from the Ada tuning guide, NVIDIA's L4 specifications and the Ada architecture whitepaper, whose L4 table lists 58 SMs and 49,152 KB of L2. The probe confirmed the H100's 50 MB of L2 on real hardware, as 52,428,800 bytes, exactly 50 MiB.

**Shared memory** is the layer that kernel writers manage by hand. It is fast scratch space on the SM, visible to all threads of one block. A matmul kernel loads a tile of each input from HBM into shared memory once and then lets every thread in the block reuse it many times. FlashAttention, covered in chapter 2.4, is built around exactly that idea.

The lab measured how copy bandwidth changes as the working set grows past the L2 cache on an H100:

```text
== 2. Copy bandwidth by working set (read + write counted)
      2 MiB working set:      479 GB/s   (fits in L2)
      8 MiB working set:     1901 GB/s   (fits in L2)
     16 MiB working set:     3657 GB/s   (fits in L2)
     32 MiB working set:     3736 GB/s   (fits in L2)
     64 MiB working set:     2642 GB/s   (beyond L2)
    128 MiB working set:     2823 GB/s   (beyond L2)
    512 MiB working set:     2992 GB/s   (beyond L2)
   2048 MiB working set:     3021 GB/s   (beyond L2)
```

Three things stand out. The 16 and 32 MiB copies, which fit in L2, run faster than any copy from HBM, at about 3.7 TB/s. Copies far larger than L2 settle at 3.0 TB/s, 90% of the 3.35 TB/s on the spec sheet, which is the realistic ceiling for a memory-bound kernel on this GPU. The smallest copies are slow for a different reason: a 2 MiB copy at L2 speed finishes in about half a microsecond, which is shorter than the fixed cost of launching a kernel, so launch overhead dominates. The measurements show it: the 2 MiB and 8 MiB copies both take about 4.4 µs each, although one moves four times as much data. Part 3 returns to that overhead, because a decode step at batch 1 is made of many small kernels.

## Coalescing: how a warp reads memory

When the 32 threads of a warp each load a value, the hardware does not fetch 32 separate values. On every GPU of compute capability 6.0 or newer, it combines the warp's loads into transactions of 32-byte **sectors** and fetches each sector it needs once. The CUDA Best Practices Guide calls this coalescing, and it gives the rules that matter:

- If thread k reads the k-th 4-byte word of an aligned array, the warp's 128 bytes arrive in exactly four sectors, and every byte fetched is used.
- If the same reads are shifted so that they do not start on a 32-byte boundary, they touch five sectors instead of four.
- If each thread reads every second word, a stride of 2, half of every sector is wasted, and the guide states that the load efficiency drops to 50%.
- As the stride grows, the efficiency keeps falling until every thread's value sits in its own sector, at which point the warp fetches 32 sectors for 128 useful bytes.

The widget below counts sectors for one warp. Try the patterns in order:

- "Thread t reads t" uses four sectors, all bytes useful.
- "Shifted by 3" uses five sectors, 80% useful.
- "Stride 2" and "Stride 8" use 8 and 32 sectors, 50% and 12.5% useful.
- Switch the element size to 2 bytes, as for BF16 weights. A coalesced read now needs only two sectors.

```widget
warp-access
```

The lab measured the same effect on real hardware. It copies 16 million float32 values to a contiguous output, reading them with a growing stride, and reports the useful data moved per second on an H100:

```text
== 3. Reading 16M useful float32 values with different access patterns
  stride  1 (  4 bytes apart):    2717 GB/s of useful data
  stride  2 (  8 bytes apart):    1817 GB/s of useful data
  stride  4 ( 16 bytes apart):    1195 GB/s of useful data
  stride  8 ( 32 bytes apart):     676 GB/s of useful data
  stride 16 ( 64 bytes apart):     358 GB/s of useful data
  stride 32 (128 bytes apart):     240 GB/s of useful data
  random gather:                  199 GB/s of useful data (index reads not counted)
```

The useful bandwidth falls with each doubling of the stride, as the sector rule predicts, but by less than half per step, because the output side of the copy stays contiguous at every stride. At stride 2 each element costs 8 bytes of read sectors plus 4 bytes of write, against 4 plus 4 at stride 1, which predicts two thirds of the bandwidth; the measurement is 1,817 against 2,717 GB/s. Random reads deliver 199 GB/s, 7% of the contiguous rate, so a kernel that gathers scattered values gives up more than 90% of the GPU's bandwidth. The fall continues beyond a stride of 8, where each value already has its own sector, which suggests the memory system fetches in larger units than one sector. CUDA exposes such a unit as a device limit, `cudaLimitMaxL2FetchGranularity`, that can be set between 0 and 128 bytes.

Coalescing explains several design choices in inference engines. Weights are stored so that the threads of a warp read consecutive elements of a row. Paged KV caches keep each block of keys contiguous, so that attention kernels read whole sectors even though the blocks themselves are scattered. When a kernel has to read a matrix by columns, it first loads a tile into shared memory with coalesced reads and then reads the columns from there.

## Shared memory and bank conflicts

Shared memory has its own access rule. It is divided into 32 **banks**, each 4 bytes wide, and consecutive 4-byte words sit in consecutive banks. All 32 threads of a warp can read in one pass if each reads a different bank. If several threads read different words in the same bank, the CUDA Best Practices Guide explains that the accesses are serialised: a two-way conflict takes two passes, and a 32-way conflict takes 32. Threads that read the same word do not conflict, because the value is broadcast to all of them.

The classic case is a 32 × 32 tile of float32 values stored row by row. Reading a row is conflict-free. Reading a column puts every element in the same bank, because consecutive rows are 32 words apart, so the warp needs 32 passes. The standard fix is to pad each row to 33 words. Elements of a column are then 33 words apart and fall in 32 different banks.

Switch the widget above to "Shared memory" to see this. "Stride 32" shows the column read with its 32-way conflict, and "Stride 33" shows the padded version with none.

## Tensor cores and the matmul peak

Most of an H100's arithmetic comes from **tensor cores**, units that multiply small matrices in one instruction rather than one number at a time. The ordinary CUDA cores still do element-wise work and FP32 arithmetic, but the figures on the spec sheet that matter for inference are tensor-core figures. The lab ran an 8,192 × 8,192 × 8,192 matmul in each number format on an H100:

```text
== 4. Matmul throughput, 8192 x 8192 x 8192
  FP32 (no tensor cores):    52.0 TFLOP/s
  TF32 (tensor cores):      417.2 TFLOP/s
  BF16 (tensor cores):      803.4 TFLOP/s
  FP8 E4M3 (tensor cores): 1410.8 TFLOP/s
```

| Format | Measured | NVIDIA's dense peak | Share of peak |
|---|---|---|---|
| FP32 without tensor cores | 52.0 TFLOP/s | 67 | 78% |
| TF32 on tensor cores | 417 | 495 | 84% |
| BF16 on tensor cores | 803 | 989 | 81% |
| FP8 on tensor cores | 1,411 | 1,979 | 71% |

NVIDIA's H100 specification page lists the tensor-core figures with sparsity, which doubles them, so the dense peaks in the table are half of the printed numbers. Moving from FP32 to TF32 on tensor cores raises the peak more than sevenfold, each further step from TF32 to BF16 to FP8 doubles it, and a large matmul in PyTorch reaches about 70% to 85% of it. Part 1's roofline estimates used the full peak, so real compute-bound times are about a quarter longer.

The share of peak also depends on the size of the problem. The lab's [matmul_sizes.py](/labs/infra/gpu/matmul_sizes.py) ran square matmuls of growing size on the same H100:

```text
NVIDIA H100 80GB HBM3, 132 SMs, PyTorch 2.15.0+cu132
     N  BF16 TFLOP/s  FP8 TFLOP/s
  1024         104.7         96.8
  2048         496.2        577.9
  4096         786.6       1330.1
  8192         801.4       1454.7
 16384         752.1       1418.7
```

A 1,024 × 1,024 matmul reaches about a tenth of the BF16 peak and a twentieth of the FP8 peak, because it has too few output tiles to give all 132 SMs enough work, and the fixed cost of a launch is large next to its runtime. From 4,096 up, BF16 holds at 76% to 81% of its peak and FP8 at 67% to 74%. Making the problem larger does not close the remaining gap, so it comes from the kernel and the hardware rather than from a lack of work. This matters for inference: a decode step multiplies weights by only a few rows of activations, so its matmuls are far smaller in one dimension than these squares, which is one more reason decode reaches a small share of the peak.

## Hopper and Blackwell features worth knowing

Interviewers expect you to recognise the newer hardware features by name and say what each one is for. These are the ones that the fastest inference kernels rely on:

- **Tensor Memory Accelerator (TMA).** The Hopper tuning guide describes TMA as a unit that copies one- to five-dimensional tensors between global memory and shared memory in either direction. One thread can start a large asynchronous copy, which frees the other threads from computing addresses.
- **Thread block clusters and distributed shared memory.** Hopper added a level between the block and the grid. Blocks in one cluster run at the same time on nearby SMs and can read, write and perform atomic operations on each other's shared memory. The portable maximum cluster size is 8 blocks, and 16 is available by opting in.
- **Warp specialization.** Instead of every warp doing the same work, some warps only load data, often through TMA, while others only compute. FlashAttention-3 uses this producer and consumer split, together with TMA, to overlap memory transfers with tensor-core work on H100s.
- **FP8 tensor cores.** Hopper and Ada run FP8 matmuls at twice the BF16 rate, which is why FP8 serving became common with these GPUs.
- **Blackwell additions.** Blackwell's fifth-generation tensor cores add Tensor Memory, a dedicated store for matmul accumulators of 128 lanes by 512 columns of 32-bit cells per thread block, according to NVIDIA's PTX documentation. They also run 4-bit floating-point formats, and NVIDIA's CUTLASS documentation lists block-scaled FP4 matmuls among the Blackwell kernels. The Blackwell tuning guide gives the B200 the same 228 KB of shared memory per SM as the H100 and the GB200 126 MB of L2 cache.

## Lab: measure a GPU against its spec sheet

**Tier: [Mac] for part A, [1 GPU] for part B.** Part A runs on your laptop in under a minute. Part B needs an NVIDIA GPU for a few seconds of work, which costs less than a cent on Modal.

The scripts are ready to download:

- [access_patterns.py](/labs/infra/access_patterns.py) runs on Apple silicon, an NVIDIA GPU or a CPU.
- [gpu/gpu_probe.py](/labs/infra/gpu/gpu_probe.py) needs an NVIDIA GPU.
- [gpu/modal_run.py](/labs/infra/gpu/modal_run.py) runs any of the GPU scripts on a rented GPU through Modal and logs the cost of each run.

**Part A, access patterns on your Mac.** Measure copy bandwidth for working sets from 2 MiB to 1 GiB, then the useful bandwidth of reading every element, every second, fourth and so on up to every 32nd, and random elements. The part is done when you can say at what working-set size your machine's caches stop helping, and how much a stride of 8 costs compared with a stride of 1.

**Part B, an NVIDIA GPU against its spec sheet.** Print the device's SM count, registers, shared memory and L2 size. Measure copy bandwidth across working sets that fit in L2 and that do not, useful bandwidth for strided and random reads, and matmul throughput in FP32, TF32, BF16 and FP8. Put each measurement next to the figure on NVIDIA's specification page. The part is done when you have a table of measured against specified numbers and a sentence explaining each gap. Run it with `modal run modal_run.py --script gpu_probe.py --gpu H100`, or with `python gpu_probe.py` on any machine that has an NVIDIA GPU.

<details>
<summary>Reference solution</summary>

**Part A.** This is the output of `access_patterns.py` on an M2 MacBook with an 8-core GPU and 8 GB of memory, using PyTorch 2.15's MPS backend:

```text
device: mps, PyTorch 2.15.0

1. Copy bandwidth by working set (bytes read + bytes written)
      2 MiB:   251.8 GB/s
      8 MiB:    87.7 GB/s
     32 MiB:    84.8 GB/s
    128 MiB:    90.1 GB/s
    512 MiB:    88.5 GB/s
   1024 MiB:    86.8 GB/s

2. Reading 8M useful float32 values with different access patterns
  stride  1 (  4 bytes apart):   70.2 GB/s of useful data
  stride  2 (  8 bytes apart):   50.1 GB/s of useful data
  stride  4 ( 16 bytes apart):   30.8 GB/s of useful data
  stride  8 ( 32 bytes apart):   17.9 GB/s of useful data
  stride 16 ( 64 bytes apart):   10.5 GB/s of useful data
  stride 32 (128 bytes apart):   10.5 GB/s of useful data
  random gather:                 2.4 GB/s of useful data (index reads not counted)
```

Four things in this output are worth noticing:

- A 2 MiB working set copies at 252 GB/s, three times the rate of larger ones, because it stays in the chip's caches. From 8 MiB up, the copy runs at about 87 GB/s, the rate of the M2's unified memory, against the 100 GB/s Apple specifies.
- The useful bandwidth falls by roughly half with each doubling of the stride up to 64 bytes apart, the same shape as on the H100.
- The curve stops falling between 64 and 128 bytes apart. Apple does not publish its GPU's memory transaction size, but this shape suggests that each read fetches about 64 bytes.
- Random reads deliver 2.4 GB/s, about 3% of the contiguous rate.

**Part B.** This is the output of `gpu_probe.py` on a Modal H100 SXM, with PyTorch 2.15 and CUDA 13.2. It used 4 seconds of GPU time, about half a cent:

```text
== 1. NVIDIA H100 80GB HBM3, compute capability 9.0, PyTorch 2.15.0+cu132, CUDA 13.2
  SMs                                        132
  warp size                                  32
  max threads per SM                         2,048
  registers per SM                           65,536
  shared memory per SM (bytes)               233,472
  shared memory per block, opt-in (bytes)    232,448
  L2 cache (bytes)                           52,428,800
  global memory (bytes)                      85,009,367,040
```

Sections 2, 3 and 4 of the output are printed in full earlier in this chapter. The shared memory figures are 228 KB and 227 KB, matching the Hopper tuning guide, and the L2 is exactly 50 MiB. The table of measured against specified numbers comes out as follows:

| Quantity | Measured | Specified | Share |
|---|---|---|---|
| HBM bandwidth (2 GiB copy) | 3.02 TB/s | 3.35 TB/s | 90% |
| FP32 matmul | 52.0 TFLOP/s | 67 | 78% |
| TF32 matmul | 417 | 495 | 84% |
| BF16 matmul | 803 | 989 | 81% |
| FP8 matmul | 1,411 | 1,979 | 71% |

No real kernel reaches a spec sheet's peak, and these shares are typical for a well-tuned library. The size sweep in the chapter shows that a larger problem does not raise them: FP8 levels off at about 70% of its peak and BF16 at about 80%. The BF16 rate even dips at 16,384. [Chapter 2.5](/learn/profiling#benchmarking-without-fooling-yourself) measured the reason: under a long run of large matmuls, the H100 reached its 700 W power limit and lowered its SM clock from 1,980 MHz to about 1,410 MHz.

The same script on a Modal A10, an older Ampere GPU with 24 GB of GDDR6, gives a useful contrast for about a fifth of a cent. It reported 72 SMs and an L2 cache of only 6 MiB, so even the 8 MiB working set no longer fits in L2. Large copies ran at 485 GB/s, 81% of the 600 GB/s NVIDIA specifies, and BF16 matmuls at 82 TFLOP/s, 66% of the 125 TFLOP/s dense peak. The A10 has no FP8 tensor cores, and the script says so instead of measuring them. The strided reads fell from 478 GB/s at stride 1 to 113 GB/s at stride 8, about a sixth of the H100's rates, and random reads to 43 GB/s. Beyond stride 8 the A10's curve almost flattens, at 104 and 89 GB/s, as the 32-byte sector rule predicts, while the H100's keeps falling. That suggests the H100's HBM is fetched in larger units than the A10's GDDR6.

</details>

## Interview angle

- **"Walk me through what happens when a kernel launches."** The program asks for a grid of thread blocks. Each block is assigned to one SM and stays there, and the SM splits it into warps of 32 threads that execute one instruction at a time together. The SM keeps many warps resident and switches between them every cycle to hide memory latency.
- **"What is memory coalescing, and how would you spot a kernel that lacks it?"** The hardware serves a warp's loads in 32-byte sectors, so consecutive threads should read consecutive addresses. A profiler shows the symptom as many more sectors per request than the data needs; Nsight Compute reports it directly, and chapter 2.5 shows how.
- **"Why might a kernel with 25% occupancy beat one with 100%?"** Occupancy only matters as a way to keep enough independent work in flight. A matmul kernel that gives each warp a large tile in registers can keep the tensor cores busy with few warps, while extra occupancy would force smaller tiles and more memory traffic.
- **"What does shared memory give you that L1 does not?"** Control. The kernel decides what goes into shared memory and when, so it can load a tile once with coalesced reads and reuse it many times, which is the basis of tiled matmul and FlashAttention.
- **"What changed in Hopper that matters for attention kernels?"** TMA for asynchronous bulk copies into shared memory, warp specialization to overlap loading with computing, thread block clusters with distributed shared memory, and FP8 tensor cores. FlashAttention-3 combines the first two.

## Check yourself

<details>
<summary>A kernel uses blocks of 256 threads at 64 registers per thread on an H100. How many blocks fit on one SM, and what is the occupancy?</summary>

One block needs 256 × 64 = 16,384 registers, and an SM has 65,536, so four blocks fit. Four blocks of 8 warps are 32 warps, half of the 64 warp slots, so the occupancy is 50%. Warp slots, block slots and shared memory would all allow more, so registers are the limit.

</details>

<details>
<summary>A warp reads 32 consecutive float32 values starting 12 bytes past a 32-byte boundary. How many sectors does it fetch, and what share of the bytes is used?</summary>

The values span bytes 12 to 139, which touch sectors 0 to 4, so five sectors or 160 bytes are fetched for 128 useful bytes. The useful share is 80%. This is the sequential but misaligned access of the CUDA Best Practices Guide, which it says requests five 32-byte segments.

</details>

<details>
<summary>On the H100, copying a 32 MiB working set ran at 3.7 TB/s and a 2 GiB one at 3.0 TB/s. What explains the difference?</summary>

The H100 has 50 MB of L2 cache. A 32 MiB working set stays in L2 after the first copy, so later copies are served from the cache rather than HBM. A 2 GiB working set cannot fit, so every copy reads and writes HBM, which delivers about 90% of its specified 3.35 TB/s.

</details>

<details>
<summary>Why does reading a column of a 32 × 32 float32 tile from shared memory take 32 passes, and how does padding fix it?</summary>

Shared memory has 32 banks of 4-byte words, and consecutive rows of the tile are 32 words apart, so every element of a column falls in the same bank and the reads are serialised. Padding each row to 33 words puts consecutive column elements 33 words apart, which places them in 32 different banks, so the warp reads the column in one pass.

</details>

<details>
<summary>NVIDIA lists 1,979 BF16 teraFLOPS for the H100 SXM, and the lab measured 803. Is the GPU underperforming by 60%?</summary>

No. NVIDIA's figure includes sparsity, which doubles the dense rate, so the dense BF16 peak is about 989 TFLOP/s. The measured 803 is 81% of that, which is normal for a large matmul in a well-tuned library. Estimates should use the dense peak and assume a real kernel reaches about 70% to 85% of it.

</details>

## Further reading

- [The CUDA C++ Best Practices Guide](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html) explains coalesced access to global memory, shared memory banks and occupancy, with the examples this chapter uses.
- [The CUDA programming guide](https://docs.nvidia.com/cuda/cuda-programming-guide/index.html) describes the thread hierarchy and hardware multithreading, and its appendix on [compute capabilities](https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/compute-capabilities.html) lists the per-SM limits for every GPU generation.
- [The Hopper tuning guide](https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html), [the Ada tuning guide](https://docs.nvidia.com/cuda/ada-tuning-guide/index.html) and [the Blackwell tuning guide](https://docs.nvidia.com/cuda/blackwell-tuning-guide/index.html) give the shared memory, register, L2, TMA and cluster figures quoted here.
- NVIDIA's [H100](https://www.nvidia.com/en-us/data-center/h100/) and [L4](https://www.nvidia.com/en-us/data-center/l4/) specification pages give the peak figures, with the sparsity footnotes that halve them.
- [The NVIDIA Ada GPU architecture whitepaper](https://images.nvidia.com/aem-dam/Solutions/geforce/ada/nvidia-ada-gpu-architecture.pdf) gives the L4's full specifications in its appendix, including its SM count and L2 cache size.
- [The PTX ISA documentation](https://docs.nvidia.com/cuda/parallel-thread-execution/index.html) defines Blackwell's Tensor Memory and the tcgen05 instructions, and the CUTLASS page on [Blackwell SM100 GEMMs](https://docs.nvidia.com/cutlass/latest/media/docs/cpp/blackwell_functionality.html) lists the block-scaled FP4 and FP8 matmuls those instructions enable.
- [FlashAttention-3](https://arxiv.org/abs/2407.08608) shows TMA, warp specialization and FP8 tensor cores working together in an attention kernel for H100s.
- [How to optimize a CUDA matmul kernel for cuBLAS-like performance](https://siboehm.com/articles/22/CUDA-MMM) by Simon Boehm walks through coalescing, shared memory tiling and occupancy step by step, with measurements at each stage.
- *Programming Massively Parallel Processors* by Hwu, Kirk and El Hajj is the standard textbook on CUDA's execution and memory model.
