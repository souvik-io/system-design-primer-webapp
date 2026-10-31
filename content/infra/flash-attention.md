# FlashAttention from the ground up

Attention is the one part of a transformer whose cost grows with the square of the sequence. Computed the obvious way, it writes an N × N matrix of scores to GPU memory, reads it back for the softmax, writes the probabilities, and reads them again, so at long contexts the memory traffic and the memory itself run out long before the arithmetic does. FlashAttention computes the same result without ever storing that matrix. This chapter derives the trick it rests on, the online softmax, builds a working FlashAttention kernel in Triton, and measures it against plain PyTorch and PyTorch's built-in fused attention on an H100.

Before this chapter, read [writing kernels in Triton](/learn/triton-kernels), especially [the tiled matmul](/learn/triton-kernels#tiled-matmul), and [where the FLOPs go](/learn/transformer-as-workload#where-the-flops-go) for attention's cost.

## The memory problem in ordinary attention

For one head, attention computes S = Q Kᵀ ÷ √d, applies the causal mask, takes P = softmax(S) along each row, and returns O = P V. With N tokens and head width d, Q, K, V and O are N × d each, but S and P are N × N. At N = 8,192 that is 67 million scores per head.

Written as ordinary PyTorch operations, each step is a separate kernel that reads its input from HBM and writes its output back. The lab's model of the plain PyTorch version used in the measurements below counts 32 bytes of traffic per score: the matmul writes S, the scaling, the mask, the conversion to FP32, the softmax and the conversion back each read and write it, and the final matmul reads it. For a batch of 4 sequences with 16 heads of 128, the lab's [online_softmax.py](/labs/infra/online_softmax.py) prints:

```text
3. HBM traffic of causal attention, BF16, d = 128, batch 4 x 16 heads (bytes to and from GPU memory)
      N     tiled  ordinary, minimum  plain PyTorch  PyTorch at 3.0 TB/s
   1024   0.18 GB            0.60 GB         2.2 GB               0.7 ms
   4096   2.35 GB            8.86 GB        34.6 GB              11.5 ms
   8192   8.99 GB           34.90 GB       138.0 GB              46.0 ms
  16384  35.17 GB          138.51 GB       550.8 GB             183.6 ms
```

The "ordinary, minimum" column is the least any attention that stores S and P must move: write S, read it, write P, read it. The "tiled" column is the FlashAttention approach described below. At N = 8,192 the plain PyTorch version moves 138 GB, which takes 46 ms at the H100's measured 3.0 TB/s, while the arithmetic of the causal half takes about 1.1 ms at the dense BF16 peak. Ordinary attention at long context is a memory-bound operation dressed up as two matmuls.

Memory capacity fails too. The measurement below found that the plain version needed 40 GiB of GPU memory for its intermediate matrices at N = 8,192, and at 16,384 it would need four times that, more than an H100 has.

## Online softmax

A softmax over a row seems to need the whole row at once: first the maximum, for numerical safety, then the sum of exponentials, then each probability. Milakov and Gimelshein showed in 2018 that the maximum and the sum can be computed in one pass over the row, block by block. The trick is to keep a running maximum m and a running sum l of exp(s − m), and to rescale l whenever a new block raises the maximum:

- Start with m = −∞ and l = 0.
- For each block of scores, compute m_new = max(m, the block's maximum).
- Multiply the old sum by alpha = exp(m − m_new), which converts it to the new reference point, then add the block's exp(s − m_new).
- Set m = m_new and move on.

At the end, l is exactly the sum of exp(s − max) over the whole row. Attention needs one more running quantity: the output accumulator acc = Σ exp(s_j − m) v_j, which is rescaled by the same alpha. After the last block, acc ÷ l is the softmax-weighted sum of the values, equal to the exact result, without the row of probabilities ever existing in full.

The lab checks this on a CPU. Over a row of 1,000 scores in blocks of 128, the online result differs from the exact softmax by 5.6 × 10⁻¹⁷, which is double-precision rounding. The widget below runs the same algorithm on one row of 16 scores. Step through the blocks and watch alpha: it is 1 when a block brings no new maximum and below 1 when it does.

```widget
online-softmax
```

## Tiling attention through SRAM

FlashAttention, by Dao and others (2022), applies the online softmax to attention with tiling. Its abstract describes the goal as making attention IO-aware, accounting for reads and writes between HBM and on-chip SRAM, and reports that it needs fewer HBM accesses than standard attention. The algorithm, in the form the lab implements:

1. Each program takes a block of BLOCK_M query rows of one head and loads them into registers once.
2. It walks over the keys and values in blocks of BLOCK_N. For each block it computes the BLOCK_M × BLOCK_N scores with a tensor-core matmul, applies the mask, and updates the running maximum, sum and output with the online softmax.
3. With a causal mask, it stops after the block that contains its last query, since later keys are masked anyway.
4. It divides the output by the running sum and writes BLOCK_M rows of O.

The scores live only in registers, one block at a time. Each program reads Q once and writes O once, and reads the K and V rows its queries can see, which is why the "tiled" column above is about four times smaller than even the minimum for ordinary attention, and 15 times smaller than plain PyTorch.

The core of the Triton kernel is the loop, which is the online softmax from the previous section written over blocks:

```python
    hi = tl.minimum((start_m + 1) * BLOCK_M, N)             # causal: no key after the block's last query
    for start_n in range(0, hi, BLOCK_N):
        cols = start_n + offs_n
        k = tl.load(K + base + cols[None, :] * D + offs_d[:, None], mask=cols[None, :] < N, other=0.0)
        s = tl.dot(q, k) * qk_scale                         # [BLOCK_M, BLOCK_N] scores, in registers only
        s = tl.where((offs_m[:, None] >= cols[None, :]) & (cols[None, :] < N), s, -float("inf"))
        m_new = tl.maximum(m_i, tl.max(s, 1))
        alpha = tl.exp2(m_i - m_new)                        # rescales everything accumulated so far
        p = tl.exp2(s - m_new[:, None])
        l_i = l_i * alpha + tl.sum(p, 1)
        v = tl.load(V + base + cols[:, None] * D + offs_d[None, :], mask=cols[:, None] < N, other=0.0)
        acc = acc * alpha[:, None] + tl.dot(p.to(v.dtype), v)
        m_i = m_new
```

Two details are worth noticing. The scale 1 ÷ √d is multiplied by log₂(e) once, so the kernel can use `exp2`. The GPU's special function unit computes powers of 2 directly, and `exp` is compiled as a multiplication by log₂(e) followed by that instruction, so folding the constant into the scale saves one multiplication per score. And the probabilities are converted to BF16 before the second matmul, so both matmuls run on tensor cores while the running statistics stay in FP32.

## Measured on an H100

The lab ran the Triton kernel, plain PyTorch attention and PyTorch's `scaled_dot_product_attention` (SDPA), which chooses a fused attention backend by itself, on a batch of 4 sequences with 16 heads of 128 in BF16, causal:

```text
NVIDIA H100 80GB HBM3, PyTorch 2.15.0+cu132, Triton 3.9.0
causal attention forward, BF16, batch 4, 16 heads of 128; TFLOP/s count only the unmasked half

     N |  Triton flash      SDPA     naive | max error vs SDPA | naive peak memory
  1024 |         197.1     332.5      17.5 |           7.8e-03 |            0.6 GiB
  2048 |         270.6     469.6      18.2 |           3.9e-03 |            2.5 GiB
  4096 |         320.5     548.1      17.2 |           3.9e-03 |           10.0 GiB
  8192 |         350.1     572.7      16.1 |           3.9e-03 |           40.0 GiB
 16384 |         364.3     586.0   skipped |           3.9e-03 |         too large
```

Four results stand out:

- **Plain attention is 11 to 22 times slower than the Triton kernel and runs out of memory.** It reaches 16 to 18 TFLOP/s at every length, because it is memory-bound throughout. At N = 8,192 it took about 68 ms, against the traffic model's 46 ms, so moving the N × N matrices explains most of its time. Its intermediate matrices need 40 GiB at that length, and the lab skips it at 16,384.
- **The 50-line Triton kernel reaches 364 TFLOP/s**, 37% of the H100's dense BF16 peak and 62% of SDPA's speed, and its efficiency rises with N as the fixed costs of each program are spread over more keys.
- **SDPA reaches 586 TFLOP/s**, 59% of the dense peak. The FlashAttention-3 paper reports up to 740 TFLOP/s in FP16 on H100, 75% of the peak, using the Hopper features this simple kernel does not use.
- **The outputs agree** with SDPA to within 0.0078 at 1,024 tokens and 0.0039 above, which is one BF16 rounding step for outputs between 1 and 2 and between 0.5 and 1 respectively.

## FlashAttention 1, 2 and 3

The three versions keep the same algorithm and change how the work is organised on the GPU:

| Version | Main change, from each paper's abstract | Reported result |
|---|---|---|
| FlashAttention (2022) | Tiling to reduce reads and writes between HBM and on-chip SRAM | 3× faster GPT-2 training at sequence length 1K |
| FlashAttention-2 (2023) | Fewer non-matmul FLOPs, parallelism across the sequence for a single head, and work split between warps to cut shared-memory traffic | 50% to 73% of the A100's peak |
| FlashAttention-3 (2024) | Warp specialization with TMA to overlap memory and compute, interleaved matmul and softmax, and FP8 with block quantization | Up to 740 TFLOP/s in FP16 on H100 (75%), and close to 1.2 PFLOP/s in FP8 |

The lab's kernel corresponds roughly to the FlashAttention-2 plan: one program per block of queries, iterating over keys. On this H100, SDPA dispatches to cuDNN's fused attention, as the trace in [chapter 2.5](/learn/profiling#profiling-a-decode-step-with-the-pytorch-profiler) also shows, and cuDNN's Hopper kernels use the same kind of techniques as FlashAttention-3. That work, which needs control a plain `tl.dot` loop does not give, accounts for most of the remaining gap.

## Attention during decode

Decode is a different shape. Each sequence adds one query, which attends to the whole KV cache, so there is no block of queries to share loads across, and attention is memory-bound at an intensity set by the grouped-query ratio, as [chapter 1.1](/learn/transformer-as-workload#where-the-bytes-go) showed. Two techniques adapt FlashAttention to it:

- **Flash-Decoding.** With one query per sequence and a small batch, a kernel that parallelises over queries leaves most SMs idle. Flash-Decoding, published by Tri Dao and colleagues in 2023, splits the keys and values into chunks along the sequence, computes attention for each chunk in parallel, saves one log-sum-exp value per row and chunk, and combines the chunks in a final step that rescales each one, which is the online softmax applied across chunks. The authors report up to 8 times faster decoding for very long sequences.
- **Paged attention.** Serving engines store the KV cache in fixed-size blocks scattered through memory, as described in the vLLM paper, so that sequences can grow without large contiguous allocations. A paged attention kernel reads each sequence's blocks through a block table that maps logical positions to physical blocks. Each block is contiguous, so reads within a block stay coalesced, and Part 5 builds the allocator that fills these tables.

## Lab: FlashAttention in Triton

**Tier: [Mac] for part A, [1 GPU] for part B.** Part A runs on any laptop with NumPy in a second. Part B ran in 10 seconds on a Modal H100, about one cent.

The scripts are ready to download:

- [online_softmax.py](/labs/infra/online_softmax.py) checks the online softmax and tiled attention in NumPy and prints the traffic model.
- [gpu/flash_attention.py](/labs/infra/gpu/flash_attention.py) holds the Triton kernel, the plain PyTorch version and the benchmark. Run it with `modal run modal_run.py --script flash_attention.py --gpu H100`.

**Part A, the algorithm on a CPU.** Implement the online softmax over blocks and check it against an ordinary softmax. Then implement causal attention tiled over query blocks and key blocks, without forming the N × N matrix, and check it against ordinary attention. The part is done when both agree to within 10⁻¹² in double precision.

**Part B, the kernel.** Write a causal FlashAttention forward kernel in Triton for inputs of shape batch × heads × N × d in BF16. Test it against `scaled_dot_product_attention` and benchmark it against plain PyTorch attention and SDPA for N from 1,024 to 16,384. The part is done when the maximum error is within a few BF16 rounding steps, your kernel is at least ten times faster than plain PyTorch at N = 8,192, and you can explain where plain PyTorch's time goes.

**Extensions.** Add the backward pass, which recomputes the scores from Q and K instead of storing them; support grouped-query attention by letting several query heads share one key/value head; or write a decode kernel with one query per sequence that splits the keys across programs as Flash-Decoding does.

<details>
<summary>Reference solution</summary>

**Part A.** This is the output of `online_softmax.py` on an M2 MacBook:

```text
1. Online softmax over one row of 1,000 scores, in blocks of 128
   max |online - exact| = 5.6e-17, final max 9.198 = row max 9.198

2. Tiled causal attention against ordinary attention, N = 1,000, d = 64
   max |tiled - ordinary| = 7.8e-16
```

The third part of its output is the traffic table at the top of this chapter. The tiled function in the script has the same structure as the Triton kernel, with NumPy arrays in place of registers.

**Part B.** The kernel is in `flash_attention.py`, and its output is the table in the measurement section above. Three points decide whether a solution is correct and fast:

- **The causal limit.** Each program stops its key loop after the block containing its last query, and masks within the diagonal block. Skipping the masked blocks halves the work; masking alone would give correct results at half the speed.
- **The rescaling.** Both the running sum and the output accumulator must be multiplied by alpha whenever the maximum changes. Forgetting the accumulator gives outputs that are wrong only when a later block holds a larger score, which random tests may not catch, so test with inputs where the largest score falls late in the row.
- **Precision.** The running statistics and the accumulator stay in FP32, and only the probabilities are cast to BF16 for the second matmul.

The time of plain PyTorch attention is explained in the first section: at N = 8,192 it moves about 138 GB through seven kernels over the full N × N matrix (the first matmul writes it, five element-wise steps each read and write it, and the second matmul reads it), about 46 ms at 3.0 TB/s, against a measured 68 ms.

</details>

## Interview angle

- **"Explain FlashAttention in two minutes."** Ordinary attention writes the N × N scores and probabilities to HBM, so it is memory-bound and needs memory quadratic in N. FlashAttention processes keys in blocks, keeps a running maximum, sum and output per query with the online softmax, and rescales them when the maximum changes, so the scores only ever exist in SRAM. The result is exact, the memory is linear in N, and the HBM traffic drops several times.
- **"Is FlashAttention an approximation?"** No. The online softmax computes exactly the same maximum, sum and weighted output as the ordinary softmax, up to floating-point rounding.
- **"What changed in FlashAttention-2 and 3?"** FlashAttention-2 reduced the non-matmul work, parallelised over the sequence even for a single head, and split work between warps to cut shared-memory traffic. FlashAttention-3 uses Hopper's TMA and warp specialization to overlap loading with computing, interleaves the softmax with the matmuls, and adds FP8.
- **"Why does decode need a different attention kernel?"** There is one query per sequence, so a kernel that parallelises over query blocks leaves most SMs idle at small batch sizes. Flash-Decoding splits the KV cache along the sequence and combines the partial results with their log-sum-exp values; paged attention adds reading the cache through a block table.

## Check yourself

<details>
<summary>The running maximum rises from 2.0 to 5.0 when a new block arrives. What happens to the running sum and the output accumulator?</summary>

Both are multiplied by alpha = exp(2.0 − 5.0) = exp(−3) ≈ 0.050 before the new block's terms are added. The old terms were computed relative to a maximum of 2.0, and multiplying by alpha re-expresses them relative to 5.0, so all terms share one reference point.

</details>

<details>
<summary>At N = 8,192 the plain PyTorch attention in the lab needed 40 GiB. Where did that memory go?</summary>

To the N × N intermediates for all 64 heads. One BF16 copy of the scores is 64 × 8,192² × 2 bytes, about 8.6 GB, and the FP32 copy and the FP32 softmax output are about 17.2 GB each. During the softmax, the BF16 scores, their FP32 copy and the FP32 output are all alive at once: 8.6 + 17.2 + 17.2 = 43.0 GB, which is the 40.0 GiB the lab measured. FlashAttention never allocates any of them.

</details>

<details>
<summary>Why does the causal Triton kernel stop its key loop at the block containing its last query instead of looping over all keys?</summary>

Every key after a query's position is masked out, so its probability is zero and its block contributes nothing. Stopping early skips about half of all key blocks for causal attention, which halves the work without changing the result. Only the diagonal block, which mixes visible and masked keys, needs the element-wise mask.

</details>

<details>
<summary>The lab's kernel reached 364 TFLOP/s and SDPA 586 on the same H100. What does SDPA's backend do that the lab's kernel does not?</summary>

On this setup SDPA used cuDNN's attention kernels. Production kernels for Hopper, such as these and the ones described in the FlashAttention-3 paper, use TMA for asynchronous loads, warp specialization so that some warps load while others compute, and interleaving of the softmax with the matmuls to keep the tensor cores busy. The lab's kernel loads and computes in the same warps and relies on Triton's general pipelining.

</details>

<details>
<summary>How does Flash-Decoding combine the results of different chunks of the KV cache into one exact attention output?</summary>

Each chunk produces a partial output normalised by its own sum, plus its log-sum-exp. The final step rescales each chunk's output by exp(chunk log-sum-exp − overall log-sum-exp) and adds them, which is the online softmax's rescaling applied to whole chunks rather than blocks within one program. The result equals attention over the full cache.

</details>

## Further reading

- [Online normalizer calculation for softmax](https://arxiv.org/abs/1805.02867) by Milakov and Gimelshein introduced the one-pass softmax this chapter builds on.
- [FlashAttention](https://arxiv.org/abs/2205.14135), [FlashAttention-2](https://arxiv.org/abs/2307.08691) and [FlashAttention-3](https://arxiv.org/abs/2407.08608) by Tri Dao and colleagues are the three papers summarised in the table above.
- [Flash-Decoding for long-context inference](https://crfm.stanford.edu/2023/10/12/flashdecoding.html) explains the split-KV decode kernel and its log-sum-exp reduction.
- [Efficient memory management for large language model serving with PagedAttention](https://arxiv.org/abs/2309.06180) is the vLLM paper that introduced the paged KV cache and its attention kernel.
- [Triton's fused attention tutorial](https://triton-lang.org/main/getting-started/tutorials/06-fused-attention.html) is a full FlashAttention implementation with the backward pass, written by the Triton developers.
- [The flash-attention repository](https://github.com/Dao-AILab/flash-attention) holds the production CUDA kernels for all three versions.
