# Writing kernels in Triton

Triton is a language for writing GPU kernels in Python. Instead of describing what each of thousands of threads does, a Triton kernel describes what one program does to a block of data, and the compiler decides how threads, registers, shared memory and tensor cores carry it out. That makes it the fastest route from an idea to a kernel that runs near the hardware's limits, and it is what vLLM, PyTorch's compiler and many inference teams use for custom kernels. This chapter builds four kernels in order, a vector add, a softmax, an RMSNorm and a tiled matmul, and measures each one against PyTorch on a rented H100 and A10.

Before this chapter, read [how a GPU executes code](/learn/gpu-execution), especially [coalescing](/learn/gpu-execution#coalescing-how-a-warp-reads-memory) and [the memory hierarchy](/learn/gpu-execution#the-memory-hierarchy).

## Blocks, not threads

A CUDA kernel is written from the point of view of one thread: it computes its own index and handles one or a few elements. A Triton kernel is written from the point of view of one **program**, which handles a whole block of elements at once, written as vectors and small matrices. The Triton paper by Tillet, Kung and Cox (2019) introduced this block-level model so that the compiler, not the programmer, handles the details inside a block.

Five pieces of the language cover most kernels:

- `tl.program_id(0)` tells a program which block it owns, as `blockIdx.x` does in CUDA.
- `tl.arange(0, BLOCK)` creates a vector of offsets, and pointer arithmetic on it gives a vector of addresses.
- `tl.load` and `tl.store` read and write whole blocks, with a `mask` that switches off elements past the end of the data.
- Reductions such as `tl.sum` and `tl.max`, and `tl.dot` for matrix multiplication on tensor cores, work on the loaded blocks.
- Arguments marked `tl.constexpr`, such as the block size, are fixed when the kernel is compiled, so the compiler can unroll loops and size registers for them.

The compiler turns each program into one CUDA thread block. It spreads the block's elements over the threads so that loads are coalesced, keeps blocks in registers or shared memory as needed, and pipelines loads ahead of the arithmetic. The `num_warps` launch option sets how many warps each program gets.

## A first kernel: vector add

The smallest complete kernel adds two vectors. Each program takes a block of 1,024 elements:

```python
@triton.jit
def add_kernel(x_ptr, y_ptr, out_ptr, n, BLOCK: tl.constexpr):
    pid = tl.program_id(0)                       # which block of BLOCK elements this program owns
    offs = pid * BLOCK + tl.arange(0, BLOCK)     # the element indices of that block, as a vector
    mask = offs < n                              # the last block may run past the end
    x = tl.load(x_ptr + offs, mask=mask)
    y = tl.load(y_ptr + offs, mask=mask)
    tl.store(out_ptr + offs, x + y, mask=mask)


def add(x, y):
    out = torch.empty_like(x)
    n = x.numel()
    add_kernel[(triton.cdiv(n, 1024),)](x, y, out, n, BLOCK=1024)
    return out
```

The launch `add_kernel[(grid,)](...)` starts one program per block, so 64 million elements need 65,536 programs. On the H100 the kernel moved 2,985 GB/s, the same as PyTorch's own addition and 89% of the 3.35 TB/s on the spec sheet. An element-wise kernel can do no better than its memory traffic allows, so matching PyTorch here only shows that the kernel reads and writes each byte once.

## Fusion: softmax and RMSNorm

Gains come from **fusion**: doing in one kernel what would otherwise take several, so the data crosses the memory bus once. RMSNorm is a good example. Written as ordinary PyTorch operations, it runs as a chain of separate kernels (convert to FP32, square, mean, add epsilon, reciprocal square root, two multiplications, convert back), and each kernel reads its input from HBM and writes its output back. Counting the bytes per element shows the cost: the six kernels that touch the whole tensor move about 40 bytes for every element, while a fused kernel reads 2 bytes and writes 2. A fused kernel reads each row once, keeps it in registers, computes the mean of squares and the scaled output there, and writes the result once:

```python
@triton.jit
def rmsnorm_kernel(x_ptr, w_ptr, out_ptr, stride, n_cols, eps, BLOCK: tl.constexpr):
    row = tl.program_id(0)
    cols = tl.arange(0, BLOCK)
    mask = cols < n_cols
    x = tl.load(x_ptr + row * stride + cols, mask=mask, other=0.0).to(tl.float32)
    w = tl.load(w_ptr + cols, mask=mask, other=0.0).to(tl.float32)
    rstd = 1.0 / tl.sqrt(tl.sum(x * x, axis=0) / n_cols + eps)
    tl.store(out_ptr + row * stride + cols, (x * rstd * w).to(out_ptr.dtype.element_ty), mask=mask)
```

One program handles one row of 4,096 values, the hidden size of Llama 3.1 8B, and the whole row fits in the registers of its eight warps. The softmax kernel has the same shape, with a row maximum, an exponent and a row sum in place of the mean of squares.

On a batch of 16,384 rows in BF16, the kernels measured as follows, counting one read and one write of the tensor:

| Kernel | H100 | A10 |
|---|---|---|
| Copy bandwidth from chapter 2.1's probe | 3,021 GB/s | 485 GB/s |
| Triton RMSNorm | 2,860 GB/s | 485 GB/s |
| PyTorch `F.rms_norm` | 2,256 GB/s | 331 GB/s |
| RMSNorm as plain PyTorch operations | 266 GB/s | 48 GB/s |
| Triton softmax | 2,858 GB/s | 484 GB/s |
| `torch.softmax` | 1,259 GB/s | 351 GB/s |

The Triton RMSNorm runs at 95% of the H100's measured copy bandwidth and at 100% of the A10's, about ten times faster than the same operation written as separate PyTorch operations. It also beats PyTorch's own `F.rms_norm` on both GPUs, as the Triton softmax beats `torch.softmax`. The library functions are general: they handle every shape, layout and data type, while these kernels are specialised for rows that fit in registers.

The RMSNorm output differs from the PyTorch reference by at most 0.031, which is exactly one BF16 rounding step for values between 4 and 8. Both versions compute in FP32 and round the result to BF16, and a tiny difference in the order of the sum can round one value up instead of down. Kernel tests therefore compare against a reference with a tolerance chosen for the output's precision.

## Tiled matmul

A matmul C = A × B with N × N matrices is where tiling matters most. Each program computes one BM × BN tile of C. It walks along the shared dimension K in slices of BK, loads a BM × BK tile of A and a BK × BN tile of B, multiplies them on the tensor cores with `tl.dot`, and adds the result to an accumulator that stays in registers in FP32:

```python
    acc = tl.zeros((BM, BN), dtype=tl.float32)   # the output tile lives in registers, in FP32
    for k in range(0, tl.cdiv(K, BK)):
        a_tile = tl.load(a, mask=(rm[:, None] < M) & (rk[None, :] < K - k * BK), other=0.0)
        b_tile = tl.load(b, mask=(rk[:, None] < K - k * BK) & (rn[None, :] < N), other=0.0)
        acc = tl.dot(a_tile, b_tile, acc)        # tensor-core multiply-accumulate of one BK slice
        a += BK * sak
        b += BK * sbk
```

The tile size sets the kernel's arithmetic intensity. Over the whole K loop, a program reads BM × N values of A and N × BN of B and does 2 × BM × BN × N FLOPs, so with 2-byte values its intensity is BM × BN ÷ (BM + BN) FLOPs per byte. A 16 × 16 tile gives 8, far below the H100's ridge point of 295. A 128 × 256 tile gives 85, and the reuse between programs described next raises the effective figure much further. Larger tiles need more registers and shared memory, which is why kernels tune them per GPU.

## Tile order and the L2 cache

The order in which programs run decides how much they share. A GPU runs one wave of programs at a time, roughly one per SM, and programs in the same wave that need the same panel of A or B can share it through the L2 cache. In plain row-major order, a wave of 132 programs on an H100 covers a few rows of C and every column, so it reads only a few panels of A but all the panels of B. Triton's matmul tutorial instead walks the tiles in groups of `GROUP_M` rows, column by column within each group, so that each wave covers a squarer region and reads fewer panels in total. The tutorial reports that this lifts an A100 from 220 to 245 TFLOP/s.

The lab's script [tiling_traffic.py](/labs/infra/tiling_traffic.py) models this. It assumes the programs of one wave move along K together and share every panel they have in common, which simplifies what real hardware does:

```text
Wave model: memory traffic when each wave shares the panels its programs need
  H100: 132 SMs, compute takes at least 1.11 ms
    128 x 128, row-major      4.37 GB,   1.30 ms of memory time, memory-bound
    128 x 128, GROUP_M=8      1.75 GB,   0.52 ms of memory time, compute-bound
    128 x 256, row-major      2.31 GB,   0.69 ms of memory time, compute-bound
    128 x 256, GROUP_M=8      1.49 GB,   0.45 ms of memory time, compute-bound
  A10: 72 SMs, compute takes at least 8.80 ms
    128 x 128, row-major      7.89 GB,  13.15 ms of memory time, memory-bound
    128 x 128, GROUP_M=8      2.15 GB,   3.58 ms of memory time, compute-bound
    128 x 256, row-major      4.07 GB,   6.78 ms of memory time, compute-bound
    128 x 256, GROUP_M=8      1.68 GB,   2.80 ms of memory time, compute-bound
```

The model makes a prediction that the real GPUs confirmed. With the 128 × 256 tile that fits the H100's shared memory, both orders stay compute-bound, so grouping should matter little. The measured gain was 3%, from 604 to 620 TFLOP/s. On the A10 the test used a 128 × 128 tile, a size for which the model predicts that row-major order needs more memory time than compute time, so grouping should help a lot there. The measured gain was 25%, from 59.3 to 74.1 TFLOP/s.

The widget below shows the waves. Choose a GPU, a tile and an order, then step through the waves to see which panels of A and B each one reads:

- On the H100 with 128 × 256 tiles in row-major order, a wave of 132 tiles covers four full rows of 32 tiles and the start of a fifth, so it reads 5 panels of A and all 32 panels of B.
- Switch to grouped order. The wave now covers eight rows and 17 columns, so it reads 25 panels instead of 37.
- Switch to the A10 with 128 × 128 tiles. In row-major order the memory time exceeds the compute time, and grouped order brings it well below.

```widget
matmul-tiling
```

## Autotuning

No single tile size is best for every GPU and matrix shape. Triton's `@triton.autotune` decorator takes a list of configurations, times each one the first time the kernel runs with a new value of the `key` arguments, and caches the fastest:

```python
@triton.autotune(
    configs=[
        triton.Config({"BM": 128, "BN": 256, "BK": 64, "GROUP_M": 8}, num_stages=3, num_warps=8),
        triton.Config({"BM": 128, "BN": 128, "BK": 64, "GROUP_M": 8}, num_stages=4, num_warps=4),
        triton.Config({"BM": 128, "BN": 128, "BK": 32, "GROUP_M": 8}, num_stages=4, num_warps=4),
        triton.Config({"BM": 64, "BN": 128, "BK": 32, "GROUP_M": 8}, num_stages=4, num_warps=4),
    ],
    key=["M", "N", "K"],
)
```

`num_stages` sets the depth of the software pipeline: Triton's compiler keeps num_stages − 1 K slices loading into shared memory while the tensor cores work on an earlier one, which hides memory latency behind the arithmetic. Each extra stage needs another set of tiles in shared memory, so GPUs with less shared memory need fewer stages or smaller tiles. The 128 × 256 × 64 configuration with three stages needs two buffers of 48 KB, 96 KB in all, so it still fits in the 99 KB an A10 or L4 allows per block, while a fourth stage, at 144 KB, fits only on a GPU such as the H100 with its 227 KB. On both GPUs the autotuner chose different tiles for different sizes, so the right configuration depends on the problem as well as the hardware.

The table compares the autotuned kernel with cuBLAS, NVIDIA's matmul library, on square BF16 matmuls:

| N | H100 Triton | H100 cuBLAS | A10 Triton | A10 cuBLAS |
|---|---|---|---|---|
| 1,024 | 93 TFLOP/s | 206 | 74 | 72 |
| 2,048 | 557 | 612 | 84 | 88 |
| 4,096 | 617 | 718 | 72 | 67 |
| 8,192 | 584 | 678 | 78 | 78 |

On the A10, about 45 lines of Triton match cuBLAS. On the H100, the Triton kernel reaches 86% of cuBLAS at 8,192. The remaining gap is consistent with the Hopper features from chapter 2.1: NVIDIA's CUTLASS library builds its fastest Hopper matmuls as warp-specialized kernels fed by TMA, and the simple `tl.dot` loop in this chapter uses neither. Recent Triton versions can request both, through tensor descriptors for TMA and the `warp_specialize` option of `tl.range`, as Triton's persistent matmul tutorial shows. Both kernels show the same error, 0.17% relative to an FP32 matmul, which is the cost of rounding the output to BF16.

## When to write a kernel

Writing a kernel is worth it when an operation is memory-bound and runs as several separate kernels, as RMSNorm did, or when no library offers the operation in the shape you need, as with the MoE grouped matmul of [chapter 1.3](/learn/mixture-of-experts#how-engines-run-an-moe-layer). It is rarely worth it for a large, plain matmul, where cuBLAS and CUTLASS are already close to the hardware's limit.

Often you do not have to write the kernel by hand. PyTorch's compiler, `torch.compile`, generates Triton kernels for chains of element-wise and reduction operations, fusing them as this chapter did by hand, and [Part 3](/learn/pytorch-execution#torchcompile-dynamo-aotautograd-and-inductor) shows how far that goes. Hand-written Triton remains common where the compiler cannot see the whole pattern: vLLM's fused MoE kernel, its attention kernels for some backends, and libraries such as Liger Kernel, which provides fused Triton kernels for LLM training.

## Lab: four kernels against PyTorch

**Tier: [Mac] for part A, [1 GPU] for part B.** Part A runs on any laptop in a second. Part B needs an NVIDIA GPU for about 15 seconds, which costs about 1.5 cents on a Modal H100 and half a cent on an A10.

The scripts are ready to download:

- [tiling_traffic.py](/labs/infra/tiling_traffic.py) is the tiling model and needs no packages.
- [gpu/triton_kernels.py](/labs/infra/gpu/triton_kernels.py) holds the four kernels, their tests and their timings. It needs an NVIDIA GPU, and Triton comes with the Linux PyTorch wheels.
- [gpu/modal_run.py](/labs/infra/gpu/modal_run.py) runs it on Modal: `modal run modal_run.py --script triton_kernels.py --gpu H100`.

**Part A, the tiling model.** Write a model of a matmul's memory traffic for a given tile size and tile order, as described in the section on tile order. Use it to predict, for an H100 and an A10, which configurations are memory-bound. The part is done when your model reproduces the table above and you can explain why the A10 gains more from grouped order than the H100.

**Part B, four kernels.** Write the vector add, softmax, RMSNorm and matmul kernels in Triton. Test each against PyTorch, time each with `triton.testing.do_bench`, and report the RMSNorm in GB/s against the copy bandwidth from chapter 2.1 and the matmul in TFLOP/s against cuBLAS. Then run the matmul with `GROUP_M` set to 1 and to 8. The part is done when the RMSNorm reaches at least 90% of your GPU's measured copy bandwidth and the matmul is within 25% of cuBLAS at N = 4,096.

<details>
<summary>Reference solution</summary>

**Part A.** The model is in [tiling_traffic.py](/labs/infra/tiling_traffic.py). Its core is the tile order from Triton's tutorial and a loop that counts, for each wave of one program per SM, the distinct rows and columns of tiles it covers:

```python
def traffic(bm, bn, group, sms):
    num_m, num_n = N // bm, N // bn
    tiles = order(num_m, num_n, group)
    no_reuse = len(tiles) * (bm + bn) * N * BYTES
    waves = 0
    for start in range(0, len(tiles), sms):
        wave = tiles[start:start + sms]
        rows = len({m for m, _ in wave})
        cols = len({n for _, n in wave})
        waves += (rows * bm + cols * bn) * N * BYTES
    return no_reuse, waves
```

Its full output begins with the per-tile intensities, which show why tiles must be large:

```text
C = A @ B, N = 8,192, BF16: 1.10 TFLOP, 1.11 ms at the H100's dense peak

Per-tile arithmetic intensity with no reuse between programs = BM x BN / (BM + BN) FLOPs per byte:
   16 x  16:   8.0 FLOPs/byte,  137.4 GB read,  41.03 ms at 3.35 TB/s
   32 x  32:  16.0 FLOPs/byte,   68.7 GB read,  20.51 ms at 3.35 TB/s
   64 x  64:  32.0 FLOPs/byte,   34.4 GB read,  10.26 ms at 3.35 TB/s
  128 x 128:  64.0 FLOPs/byte,   17.2 GB read,   5.13 ms at 3.35 TB/s
  128 x 256:  85.3 FLOPs/byte,   12.9 GB read,   3.85 ms at 3.35 TB/s
```

The A10 gains more from grouping for two reasons, and lower bandwidth is not one of them: its ridge point, 125 TFLOP/s ÷ 600 GB/s ≈ 208 FLOPs per byte, is lower than the H100's 295, so for each FLOP it has more bandwidth, not less. The first reason is the tile. The A10 test used 128 × 128 tiles, which in row-major order the model puts at 1.49 times as much memory time as compute time, while the H100 test used 128 × 256 tiles, at 0.62 times. The second is the wave size. With 72 SMs instead of 132, each wave covers fewer tiles and shares fewer panels, so the same 128 × 128 tile in row-major order reads 7.89 GB on the A10 against 4.37 GB on the H100.

**Part B.** The full script is [triton_kernels.py](/labs/infra/gpu/triton_kernels.py). This is its output on a Modal H100 SXM, which used 13 seconds of GPU time, about 1.5 cents:

```text
NVIDIA H100 80GB HBM3, PyTorch 2.15.0+cu132, Triton 3.9.0

vector add, 64M float32:   Triton   2985 GB/s   PyTorch   2979 GB/s   (exact match)
softmax, 16384x4096 BF16: Triton   2858 GB/s   PyTorch   1259 GB/s   max error 6.1e-05
RMSNorm, 16384x4096 BF16: Triton   2860 GB/s   eager PyTorch    266 GB/s   F.rms_norm   2256 GB/s   max error 3.1e-02

matmul, BF16, square (errors are relative to an FP32 matmul of the same inputs):
  N= 1024: Triton   92.8 TFLOP/s (error 1.7e-03)   cuBLAS  205.9 TFLOP/s (error 1.7e-03)   best tile 128x128x64
  N= 2048: Triton  557.4 TFLOP/s (error 1.7e-03)   cuBLAS  611.9 TFLOP/s (error 1.7e-03)   best tile 128x128x32
  N= 4096: Triton  616.6 TFLOP/s (error 1.7e-03)   cuBLAS  718.1 TFLOP/s (error 1.7e-03)   best tile 128x256x64
  N= 8192: Triton  584.3 TFLOP/s (error 1.7e-03)   cuBLAS  677.7 TFLOP/s (error 1.7e-03)   best tile 128x128x64

matmul tile order, N=8192, tile 128x256x64 (GROUP_M=1 is plain row-major order):
  GROUP_M=1:  603.6 TFLOP/s
  GROUP_M=8:  620.2 TFLOP/s
```

This is the output on a Modal A10, which used 15 seconds, about half a cent:

```text
NVIDIA A10, PyTorch 2.15.0+cu132, Triton 3.9.0

vector add, 64M float32:   Triton    480 GB/s   PyTorch    480 GB/s   (exact match)
softmax, 16384x4096 BF16: Triton    484 GB/s   PyTorch    351 GB/s   max error 1.2e-04
RMSNorm, 16384x4096 BF16: Triton    485 GB/s   eager PyTorch     48 GB/s   F.rms_norm    331 GB/s   max error 3.1e-02

matmul, BF16, square (errors are relative to an FP32 matmul of the same inputs):
  N= 1024: Triton   73.5 TFLOP/s (error 1.7e-03)   cuBLAS   72.0 TFLOP/s (error 1.7e-03)   best tile 128x128x32
  N= 2048: Triton   83.6 TFLOP/s (error 1.7e-03)   cuBLAS   88.4 TFLOP/s (error 1.7e-03)   best tile 128x128x32
  N= 4096: Triton   72.4 TFLOP/s (error 1.7e-03)   cuBLAS   67.1 TFLOP/s (error 1.7e-03)   best tile 128x256x64
  N= 8192: Triton   77.8 TFLOP/s (error 1.7e-03)   cuBLAS   77.9 TFLOP/s (error 1.7e-03)   best tile 128x256x64

matmul tile order, N=8192, tile 128x128x32 (GROUP_M=1 is plain row-major order):
  GROUP_M=1:   59.3 TFLOP/s
  GROUP_M=8:   74.1 TFLOP/s
```

Five things in these results are worth noticing:

- Both acceptance targets are met. The RMSNorm reaches 95% of the H100's measured copy bandwidth and 100% of the A10's, and the matmul reaches 86% of cuBLAS at N = 4,096 on the H100 and 108% on the A10.
- At N = 1,024 on the H100, the Triton matmul reaches less than half of cuBLAS. A 1,024-wide matmul has only 64 tiles of 128 × 128, fewer than the 132 SMs, so half the GPU idles. cuBLAS reaches more than twice the speed, so it must divide small problems differently, for example into smaller tiles or by splitting the K dimension across SMs.
- The `best tile` column shows the autotuner choosing different tiles for different sizes, and the timings vary by a few percent between runs, as any benchmark does.
- The A10 reaches 62% of its 125 TFLOP/s dense BF16 peak even with cuBLAS, a smaller share than the H100's 69%. Both shares are lower than chapter 2.1's probe measured for the same matmul (66% and 81%), because the probe reported the best of 20 runs, while `triton.testing.do_bench` reports the mean of about 100 ms of runs with the L2 cache cleared before each one. Under a sustained run the H100 can also reach its power limit and lower its clock, as [chapter 2.5](/learn/profiling#benchmarking-without-fooling-yourself) shows. The timings alone do not show why; chapter 2.5's profiling tools are the way to find out.
- The vector add matches PyTorch exactly in value and to within 1% in speed, because both are limited only by memory.

</details>

## Interview angle

- **"How does Triton differ from CUDA?"** In CUDA you write the code for one thread and manage shared memory, synchronisation and coalescing yourself. In Triton you write the code for one program operating on blocks, and the compiler maps the blocks onto threads, shared memory and tensor cores. You give up some control, such as choosing exactly which warps load and which compute, in exchange for much shorter kernels that are portable across GPU generations.
- **"Why is a fused RMSNorm ten times faster than the PyTorch version?"** RMSNorm is memory-bound. Written as separate operations, it launches several kernels, and six of them read or write the whole tensor through HBM, about 40 bytes per element against 4 for the fused kernel. The fused kernel reads each row once, keeps it in registers for the reduction and the scaling, and writes it once.
- **"What sets the arithmetic intensity of a tiled matmul?"** The tile size. A BM × BN tile in BF16 does BM × BN ÷ (BM + BN) FLOPs per byte read if programs share nothing, so larger tiles raise intensity. Reuse through L2 between programs in the same wave raises it further, which is what grouped tile order improves.
- **"When would you not write a custom kernel?"** When the operation is a large standard matmul that cuBLAS or CUTLASS already runs near peak, or when `torch.compile` already fuses the operations well. Custom kernels pay off for memory-bound chains, unusual shapes and operations that no library provides.

## Check yourself

<details>
<summary>What do a Triton program, tl.arange and a mask correspond to in CUDA terms?</summary>

A Triton program becomes one CUDA thread block, and `tl.program_id` plays the role of `blockIdx`. `tl.arange` creates the vector of offsets that a CUDA kernel would compute from `threadIdx`, one per element. The mask replaces the bounds check that each CUDA thread would do with an `if`, switching off the elements past the end of the data.

</details>

<details>
<summary>What is the arithmetic intensity of a 128 × 128 matmul tile in BF16 with no reuse between programs, and how does it compare with an H100's ridge point?</summary>

BM × BN ÷ (BM + BN) = 128 × 128 ÷ 256 = 64 FLOPs per byte. The H100's ridge point is about 295, so a kernel that relied on this tile alone would be memory-bound. Reuse of panels through the L2 cache between programs of the same wave is what makes real matmuls compute-bound.

</details>

<details>
<summary>Grouped tile order sped up the Triton matmul by 25% on an A10 but by only 3% on an H100. Why?</summary>

Grouped order reduces the panels each wave reads from memory. On the H100, with 3.35 TB/s and a 128 × 256 tile, the memory time was already well below the compute time, so cutting it changed little. On the A10 the test used a 128 × 128 tile, and with only 72 SMs each wave shares fewer panels, so row-major order made the matmul memory-bound, and grouping brought the memory time back below the compute time.

</details>

<details>
<summary>What does num_stages control in a Triton matmul, and what limits it?</summary>

It sets the depth of the software pipeline: the kernel keeps num_stages − 1 K slices loading ahead of the one being multiplied, so that memory loads overlap tensor-core work. Each of those slices needs its own tiles of A and B in shared memory, so the stage count is limited by shared memory per block. Three stages of a 128 × 256 × 64 BF16 tile need 96 KB and just fit the 99 KB an A10 or L4 allows, while four stages need 144 KB and fit only on a GPU such as the H100.

</details>

<details>
<summary>The Triton RMSNorm differs from the PyTorch reference by 0.031 in one element. Is the kernel wrong?</summary>

No. Both compute in FP32 and round to BF16, and BF16 values between 4 and 8 are spaced 2^-5 = 0.031 apart. A slightly different order of summation can round one value to the neighbouring BF16 number. Tests for low-precision kernels compare with a tolerance of a few rounding steps rather than demanding exact equality.

</details>

## Further reading

- [Triton: an intermediate language and compiler for tiled neural network computations](https://www.eecs.harvard.edu/~htk/publication/2019-mapl-tillet-kung-cox.pdf) by Tillet, Kung and Cox is the paper that introduced Triton's block-level programming model.
- [Triton's tutorials](https://triton-lang.org/main/getting-started/tutorials/index.html) build the vector add, fused softmax, matmul and layer norm kernels step by step, and the [matrix multiplication tutorial](https://triton-lang.org/main/getting-started/tutorials/03-matrix-multiplication.html) explains grouped ordering and autotuning.
- [The triton.language reference](https://triton-lang.org/main/python-api/triton.language.html) documents `tl.load`, `tl.dot`, the reductions and the other operations used here.
- [How to optimize a CUDA matmul kernel for cuBLAS-like performance](https://siboehm.com/articles/22/CUDA-MMM) by Simon Boehm shows by hand, in CUDA, the tiling and pipelining that Triton's compiler does for you.
- [CUTLASS's guide to efficient GEMM](https://docs.nvidia.com/cutlass/latest/media/docs/cpp/efficient_gemm.html) describes the warp-specialized Hopper design, with producer warps loading tiles through TMA and consumer warps running the tensor cores.
- [Liger Kernel](https://github.com/linkedin/Liger-Kernel) is a collection of fused Triton kernels for LLM training, including RMSNorm, and a good source of production-quality examples.
- [vLLM's fused MoE kernel](https://github.com/vllm-project/vllm/blob/main/vllm/model_executor/layers/fused_moe/fused_moe.py) is a real inference kernel written in Triton, with the grouped matmul from chapter 1.3.
