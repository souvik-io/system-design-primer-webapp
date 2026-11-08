# Number formats

Every weight, activation and cache entry a model touches is stored in some number format, and the format decides three things at once: how many bytes the hardware must move, which tensor-core instructions can do the arithmetic, and how much of the original value survives. Part 1 showed that decode is limited by the bytes it reads, so a smaller format is the most direct way to make a memory-bound step faster and to fit a larger model or more cache on a GPU. This chapter covers the formats an inference engineer meets, from FP32 down to the 4-bit block-scaled formats of NVIDIA's Blackwell GPUs: how each one spends its bits, why the smallest ones need scale factors shared by a block of values, and which GPUs run which formats in hardware. The next chapters build on it: 4.2 covers the arithmetic of quantizing a model, and 4.3 the algorithms that do it well.

Before this chapter, read [Number formats and quantization](/learn/gpus-for-ai#number-formats-and-quantization), which introduces BF16, FP8 and INT4 and what quantization does to weights.

## Sign, exponent and mantissa

A floating-point format splits its bits into three fields. One bit is the sign. The exponent field holds an unsigned integer E, from which a fixed bias is subtracted to give the power of two. The mantissa field holds M, the fraction bits after an implicit leading 1. With m mantissa bits, a normal number's value is

```text
value = (-1)^sign × 2^(E - bias) × (1 + M / 2^m)
```

and the bias is 2^(e - 1) - 1 for e exponent bits, so the exponents are spread roughly evenly around zero. When the exponent field is zero, the number is subnormal: the leading 1 is dropped and the exponent is fixed at 1 - bias, which lets the format hold values smaller than its smallest normal number, with fewer significant bits. IEEE 754 formats reserve the all-ones exponent for infinities and NaN.

The two fields divide the work cleanly. The exponent bits set the range, from the smallest to the largest value. The mantissa bits set the precision: between two powers of two there are 2^m evenly spaced values, so the gap between neighbours is a fixed fraction, 2^-m, of the number's size, and rounding to the nearest value is off by at most half of that. A float's relative error is therefore about the same everywhere in its normal range, which is what makes floats suit data whose magnitudes vary a lot.

The lab's [number_formats.py](/labs/infra/number_formats.py) decodes every bit pattern of each format from these rules and checks the result against `torch.finfo`:

| Format | Bits (sign/exponent/mantissa) | Largest value | Smallest normal | Smallest subnormal | Gap after 1 | Finite values | Special values |
|---|---|---|---|---|---|---|---|
| FP32 | 1 / 8 / 23 | 3.40 × 10^38 | 1.18 × 10^-38 | 1.40 × 10^-45 | 1.19 × 10^-7 | about 4.3 billion | Inf, NaN |
| BF16 | 1 / 8 / 7 | 3.39 × 10^38 | 1.18 × 10^-38 | 9.18 × 10^-41 | 0.0078 | 65,279 | Inf, NaN |
| FP16 | 1 / 5 / 10 | 65,504 | 6.10 × 10^-5 | 5.96 × 10^-8 | 0.00098 | 63,487 | Inf, NaN |
| FP8 E5M2 | 1 / 5 / 2 | 57,344 | 6.10 × 10^-5 | 1.53 × 10^-5 | 0.25 | 247 | Inf, NaN |
| FP8 E4M3 | 1 / 4 / 3 | 448 | 0.0156 | 0.00195 | 0.125 | 253 | NaN only |
| FP6 E3M2 | 1 / 3 / 2 | 28 | 0.25 | 0.0625 | 0.25 | 63 | none |
| FP6 E2M3 | 1 / 2 / 3 | 7.5 | 1 | 0.125 | 0.125 | 63 | none |
| FP4 E2M1 | 1 / 2 / 1 | 6 | 1 | 0.5 | 0.5 | 15 | none |

The finite-value counts treat +0 and -0 as one value. One more format appears in tensor cores but never in memory. TF32, introduced with NVIDIA's Ampere generation, has FP32's 8 exponent bits and 10 mantissa bits; when TF32 is enabled, tensor cores round FP32 matmul inputs to it, multiply, and accumulate in FP32, while every stored tensor stays in FP32.

```widget
bit-explorer
```

Try 1000.7 in BF16 and FP16: BF16 stores 1000, because 7 mantissa bits leave gaps of 4 between 512 and 1,024, while FP16 stores 1000.5. Then try 70000: FP16 overflows to infinity, and BF16 still holds it, as 70,144. Try 300 in FP8 E4M3 and E5M2 to see a 3-bit and a 2-bit mantissa round the same number differently, and 0.00001 in E4M3 to see a value too small for the format round to zero.

## FP16 and BF16

Both 16-bit formats halve FP32's bytes, and they spend the saving differently. FP16 keeps 10 mantissa bits, about three decimal digits, but its 5 exponent bits stop at 65,504, and gradients in training can underflow below its smallest subnormal, which is why FP16 training needs loss scaling. BF16 keeps FP32's 8 exponent bits, so any FP32 value is in range, and gives up precision instead: it has 7 mantissa bits, about two decimal digits. Converting FP32 to BF16 is just rounding away the low 16 bits.

Range turned out to matter more for deep learning than precision, and BF16 became the default format for training and serving large models. Model checkpoints on Hugging Face are mostly stored in BF16, and every format in the rest of this chapter is usually measured against the BF16 model. FP16 is still used, mainly on older GPUs without BF16 tensor cores, such as the V100 and the T4, and FP16 inference is safe when the activations stay well inside its range.

## FP8: E4M3 and E5M2

FP8 halves the bytes again, and with 8 bits there is no longer one good split. The 2022 paper by NVIDIA, Arm and Intel that proposed today's FP8, later published as the OCP 8-bit floating-point specification, defined two encodings. E4M3 has 4 exponent and 3 mantissa bits and is meant for weights and activations. To gain range, it breaks with IEEE 754: it has no infinities, and only one pattern per sign, S.1111.111, is NaN, so the all-ones exponent holds numbers and the largest value is 448 instead of 240. E5M2 has 5 exponent and 2 mantissa bits, follows the IEEE conventions, and reaches 57,344; it is meant for gradients, which span a wider range and tolerate less precision. PyTorch calls them `torch.float8_e4m3fn` and `torch.float8_e5m2`, where "fn" means finite with NaN.

Even E4M3's range is narrow. Its values run from 0.002 to 448, and a layer's weights or activations can sit anywhere in FP32's range, so FP8 always travels with a scale factor: the tensor is divided by a scale before it is cast, so that its largest value lands near 448, and the scale is kept in FP32 to multiply back. The scale can be one per tensor, one per row or per output channel, or one per block. DeepSeek-V3, trained in FP8, used E4M3 for every input of its FP8 matrix multiplications, with one scale per 1 × 128 tile of activations and one per 128 × 128 block of weights, and kept the embeddings, normalization, attention and output head in BF16 or FP32. The lab shows that the cast itself is exact to specification: rounding a million values with the field rules above gave the same result as PyTorch's cast for every value, in all four 8- and 16-bit formats.

The FP8 that AMD's MI300 series runs is slightly different. Its E4M3FNUZ and E5M2FNUZ variants, whose names stand for finite, no negative zero, have a single NaN in the pattern that would be -0 and an exponent bias one higher, so E4M3FNUZ tops out at 240 instead of 448. A checkpoint quantized with OCP E4M3 scales has to be rescaled before an MI300 can run it. AMD's MI350 series moved to the OCP encodings.

## Integers: INT8 and INT4

An integer format with a scale is the other way to use 8 or 4 bits. INT8 holds the integers from -128 to 127 and INT4 those from -8 to 7, and a scale maps them onto the data, so the stored values are evenly spaced: 256 or 16 levels, the same gap everywhere. A float of the same size places its values densely near zero and sparsely near its largest value.

Which grid fits better depends on the data. Weights are roughly bell-shaped: most of them are small and a few are large. With one scale for a whole tensor, the largest weight sets the scale, and an evenly spaced grid then has few levels left for the small weights that are most of the tensor. The lab quantized all 106 million linear-layer weights of SmolLM2-135M this way. INT8 rounded 5.2% of the nonzero weights to zero and had a relative error of 3.6%, against 2.6% for FP8 E4M3 with no weights lost to zero. At 4 bits the gap was large: INT4 with one scale per tensor zeroed 69% of the weights, with an error of 58%, and FP4 zeroed 48%, with an error of 37%. Neither is usable, which is the point of the next section.

Integers are not worse in general. With one scale for each small group of weights, the subject of chapter 4.2, INT4 works well, and it is the format of most 4-bit checkpoints made with GPTQ and AWQ, the algorithms of chapter 4.3. INT8 with per-channel scales is the long-standing format for weight-and-activation quantization on GPUs without FP8.

## FP4 and block scaling

FP4 E2M1 has 15 values: zero and plus or minus 0.5, 1, 1.5, 2, 3, 4 and 6. A single scale cannot fit a whole tensor onto so few levels, as the lab showed, so the 4-bit formats that hardware supports attach a scale to every small block of values. The block's largest value then lands near the top of the grid, and the others use the levels below it. The smaller the block, the more closely each scale fits its values, and the more bytes the scales add.

The Open Compute Project's Microscaling (MX) specification, version 1.0 of September 2023, was written by AMD, Arm, Intel, Meta, Microsoft, NVIDIA and Qualcomm. It defines a block of k = 32 elements sharing one 8-bit scale in a format called E8M0, which is just an exponent: an unsigned 8-bit field with bias 127, so each scale is a power of two from 2^-127 to 2^127, and one pattern is NaN. The concrete formats are MXFP8 (E4M3 or E5M2 elements), MXFP6 (E2M3 or E3M2), MXFP4 (E2M1) and MXINT8. Each block of 32 MXFP4 values takes 32 × 4 + 8 bits, 4.25 bits per value.

The specification gives a minimal rule for choosing the scale: the largest power of two at or below the block's largest magnitude, divided by the largest power of two the element format holds, which is 4 for E2M1. The block's largest value then lands between 4 and 8, and any value above 6 is clamped to 6. On SmolLM2-135M, this rule clamped 2.6% of the weights and gave an error of 11.8%. Rounding the scale up instead clamps nothing but leaves each block less of the grid, and it gave a similar 11.9%. Either way, block scales cut FP4's error from 37% to about 12% for a quarter of a bit per weight.

NVIDIA's NVFP4 makes two changes. Its blocks are 16 values, and each block's scale is an FP8 E4M3 number instead of a power of two, so the scale can match the block's largest value closely, with 3 bits of fraction. E4M3's range is too small to cover a whole tensor's scales, so NVFP4 adds a second, FP32 scale per tensor. In NVIDIA's recipe, the tensor's decode scale is its largest magnitude divided by 6 × 448, and each block's E4M3 scale is the block's largest magnitude divided by 6, divided by the tensor scale. A stored weight is then its 4-bit value times its block's scale times the tensor's scale.

```diagram
title: How NVFP4 stores a weight
[t:store] FP32, per tensor @ 0,0
[b:store] E4M3, one per 16 @ 1,0
[q:store] 16 FP4 values @ 2,0
[w] Dequantized weight @ 1,1
t -> w
b -> w
q -> w
```

NVFP4 costs 4.5 bits per value, and on SmolLM2-135M it gave the lowest 4-bit error, 9.5%, with no weights clamped. NVIDIA reports that NVFP4 reduces a model's memory by about 3.5 times against FP16 and 1.8 times against FP8, and that DeepSeek-R1-0528 quantized to NVFP4 lost at most 1 point against its FP8 version on seven benchmarks, from MMLU-Pro to AIME 2024. MXFP4 is in production too: OpenAI's gpt-oss models were post-trained with their mixture-of-experts weights in MXFP4, which lets gpt-oss-120b fit on a single 80 GB GPU. Switch the widget above to "A block of weights" to watch the three scaling methods handle the same 32 weights, with and without an outlier.

## What each GPU runs natively

A format is native on a GPU when its tensor cores take that format as input. Any GPU can store weights in a smaller format and convert them to BF16 inside the kernel before multiplying, which saves memory and bandwidth but not compute; chapter 4.2 calls this weight-only quantization. The formats each generation's tensor cores accept, from the vendors' product pages and documentation:

| GPU | Architecture | Tensor-core input formats | Dense peak, BF16 / FP8 / FP4 (TFLOP/s) |
|---|---|---|---|
| NVIDIA A100 | Ampere | TF32, BF16, FP16, INT8, INT4 | 312 / none / none |
| NVIDIA L4, L40S | Ada | TF32, BF16, FP16, FP8, INT8, INT4 | L4: 121 / 242 / none |
| NVIDIA H100 SXM | Hopper | TF32, BF16, FP16, FP8, INT8 | 989 / 1,979 / none |
| NVIDIA B200 | Blackwell | TF32, BF16, FP16, FP8, FP6, FP4, INT8, with MX and NVFP4 block scales | 2,250 / 4,500 / 9,000 |
| AMD MI300X | CDNA 3 | TF32, BF16, FP16, FP8 (FNUZ), INT8 | |
| AMD MI350X, MI355X | CDNA 4 | BF16, FP16, FP8 (OCP), FP6, FP4, INT8 | |

NVIDIA prints most peaks "with sparsity", a 2:4 structured-sparsity mode, and the dense peak is half; the table gives dense figures. The B200's are NVIDIA's HGX B200 figures for eight GPUs, divided by eight. Each step from 16 to 8 to 4 bits doubles the peak, because a tensor core of the same size handles twice as many narrower multiplications; FP6 runs at the FP8 rate, and Ada's INT4 at its INT8 rate. The H100's product page lists no INT4, and FP8 first appeared in Ada and Hopper, so an A100 can store FP8 weights but must convert them before multiplying.

## Measured: one matmul in each format

The lab's [format_matmul.py](/labs/infra/gpu/format_matmul.py) multiplies activations by the weight matrix of one MLP projection in Llama 3 70B, 8,192 inputs by 28,672 outputs, in every format the GPU accepts. It does this at two shapes. With 8,192 rows of activations, as in a prefill, the matmul is compute-bound and its time measures the tensor cores. With 32 rows, as in a decode step for 32 sequences, it is memory-bound and its time is mostly reading the 235 million weights. The error column compares each result with an FP32 product of the original matrices, so it includes the rounding of both inputs.

| Format | H100 prefill | B200 prefill | H100 decode | B200 decode | Error |
|---|---|---|---|---|---|
| BF16 | 748 TFLOP/s (76%) | 1,426 (63%) | 0.165 ms | 0.077 ms | 0.29% |
| INT8 | 892 (45%) | 3,230 (72%) | 0.092 ms | 0.054 ms | 1.3% |
| FP8 E4M3, per tensor | 1,277 (65%) | 2,765 (61%) | 0.086 ms | 0.040 ms | 3.8% |
| MXFP8 | not supported | 2,907 (65%) | | 0.047 ms | 4.2% |
| MXFP4 | not supported | 5,428 (60%) | | 0.033 ms | 16.2% |
| NVFP4 | not supported | 6,214 (69%) | | 0.031 ms | 13.4% |

The percentages are against the dense peak for the format's family. Three results stand out. First, in the compute-bound shape each format step roughly doubles the throughput on the GPU that supports it: FP8 ran at 1.7 to 1.9 times BF16, and NVFP4 at 4.4 times BF16 on the B200. Second, in the memory-bound shape the time follows the bytes. FP8 halved BF16's time on both GPUs, because the weights are half the size, and the 4-bit formats cut it further on the B200, though not to a quarter: at 0.03 ms, the scales and the kernel's fixed costs are a large part of the time. Third, every halving of bits costs accuracy. The errors here are for random matrices with both inputs quantized; what that does to a model's answers is the subject of chapter 4.4.

The L4, an Ada GPU rented on Google Cloud for the lab, also runs FP8. In the prefill shape its FP8 ran at 1.6 times BF16, 91 against 58 TFLOP/s, and in the decode shape FP8 halved BF16's time, from 2.03 to 1.03 ms. Its full results are in the lab's reference solution.

## Lab: formats from their bits, then on three GPUs

**Tier: [Mac] then [1 GPU].** Part A runs on a CPU in about a minute after a 270 MB download, and needs torch, safetensors and huggingface_hub. Parts B and C run on NVIDIA GPUs: an H100 and a B200 through Modal, and an L4 through Google Cloud.

The scripts are ready to download: [number_formats.py](/labs/infra/number_formats.py) and [gpu/format_matmul.py](/labs/infra/gpu/format_matmul.py). Run the first with `python number_formats.py`. Run the second with any of these commands from the `gpu/` folder, which build the same container from `images/base.Dockerfile` on either platform:

```bash
modal run modal_run.py --script format_matmul.py --gpu 'H100!'  # about 10 s of GPU time, under $0.01
modal run modal_run.py --script format_matmul.py --gpu B200     # the only GPU here with FP4; about $0.02
python gcp_run.py --script format_matmul.py --gpu L4            # a spot VM; about $0.13, mostly image build time
```

**Part A, formats from their bits.** Write a decoder that turns any bit pattern of an ExMy format into its value, and use it to tabulate each format's range and precision. Write a round-to-nearest-even function from the same tables and compare it with PyTorch's casts. Then quantize a real model's weights with one scale per tensor in INT8, FP8, INT4 and FP4, with MXFP8 and MXFP4 block scales, and with NVFP4, and report each scheme's error, the share of weights rounded to zero, and the bits per weight.

**Part B, matmul speed by format.** Time the prefill-shaped and decode-shaped matmuls in every format the GPU supports, and compare each with the datasheet peak. Explain why the decode shape's time tracks the bytes of the weight matrix.

**Part C, choosing a format.** A team serves a 70B model on H100s in BF16 and is moving to B200s. In a few sentences, say which format you would try first on each GPU for the weights, what the lab's numbers suggest each would gain, and what you would measure before switching.

<details>
<summary>Reference solution</summary>

`number_formats.py` on an Apple M2 MacBook with 8 GB of memory:

```text
PyTorch 2.15.0

1. Every format decoded from its bit fields
   format     bits     largest  smallest normal  smallest subnormal  step at 1  finite values  special values
   FP32         32 3.40282e+38        1.175e-38           1.401e-45  1.192e-07    about 4.3e9  Inf, NaN
   BF16         16 3.38953e+38        1.175e-38           9.184e-41   0.007812         65,279  Inf, NaN
   FP16         16       65504        6.104e-05            5.96e-08  0.0009766         63,487  Inf, NaN
   FP8 E5M2      8       57344        6.104e-05           1.526e-05       0.25            247  Inf, NaN
   FP8 E4M3      8         448          0.01562            0.001953      0.125            253  NaN only
   FP6 E3M2      6          28             0.25              0.0625       0.25             63  none
   FP6 E2M3      6         7.5                1               0.125      0.125             63  none
   FP4 E2M1      4           6                1                 0.5        0.5             15  none
   The largest, smallest-normal and step-at-1 values of the five formats PyTorch has match torch.finfo.

2. This file's rounding against PyTorch's casts, on 1,000,000 values spread over each format's range
   BF16      0 differences
   FP16      0 differences
   FP8 E5M2  0 differences
   FP8 E4M3  0 differences

3. A few numbers stored in each format (overflow: Inf for IEEE formats, NaN for E4M3, saturate for FP6/FP4)
       value       BF16       FP16   FP8 E5M2   FP8 E4M3   FP6 E3M2   FP6 E2M3   FP4 E2M1
         0.1     0.1001   0.099976    0.09375    0.10156      0.125      0.125          0
     3.14159     3.1406     3.1406          3       3.25          3       3.25          3
         300        300        300        320        288         28        7.5          6
      1000.7       1000     1000.5       1024        nan         28        7.5          6
       70000      70144        inf        inf        nan         28        7.5          6
       1e-05 1.0014e-05 1.0014e-05 1.5259e-05          0          0          0          0

4. SmolLM2-135M: 210 linear weight matrices, 106.2M weights, stored as {torch.bfloat16}
   scheme                             bits/weight   error     SQNR   zeroed  clamped
   INT8, one scale per tensor                   8   3.64%   28.8dB     5.2%    0.00%
   FP8 E4M3, one scale per tensor               8   2.65%   31.5dB     0.0%    0.00%
   MXFP8 E4M3 (32 per E8M0 scale)            8.25   3.05%   30.3dB     0.0%    0.84%
   INT4, one scale per tensor                   4  58.32%    4.7dB    68.8%    0.00%
   FP4 E2M1, one scale per tensor               4  37.40%    8.5dB    47.5%    0.00%
   MXFP4, OCP scale rule                     4.25  11.76%   18.6dB     9.0%    2.58%
   MXFP4, scale rounded up                   4.25  11.90%   18.5dB    12.3%    0.00%
   NVFP4 (16 per E4M3 scale + FP32)           4.5   9.47%   20.5dB     7.3%    0.00%
   error = RMS error / RMS weight over all matrices; SQNR = signal-to-quantization-noise ratio;
   zeroed = nonzero weights stored as 0; clamped = weights cut down to the element's largest value.
```

*Part A.* The decoded tables match `torch.finfo` for the five formats PyTorch has, and the rounding matches PyTorch's casts on every one of a million values per format, so the field rules are the whole definition. Among the 8-bit schemes, FP8 with one scale per tensor beat INT8, because its levels are densest near zero where most weights are; MXFP8 did slightly worse than per-tensor FP8 because the OCP scale rule clamps the 0.8% of weights that land between 448 and 512, and FP8's exponent already gives each weight its own range, so a block scale adds little at 8 bits. At 4 bits, block scaling is what makes the format usable, cutting the error from 37% to 12% with MXFP4 and to 9.5% with NVFP4, whose smaller blocks and finer E4M3 scales are worth their quarter bit.

`format_matmul.py` on Modal, H100 and B200 (prefill-like rows only; the decode-like rows follow the same layout):

```text
NVIDIA H100 80GB HBM3, compute capability 9.0, PyTorch 2.15.0+cu132, CUDA 13.2

prefill-like (M=8192): (8192 x 8192) times (8192 x 28672)
   format                time   TFLOP/s  of peak  weights GB/s    error
   BF16               5.146ms     747.8     76%            91    0.29%
   FP16               5.346ms     719.9     73%            88    0.04%
   INT8               4.315ms     891.8     45%            54    1.28%
   FP8 per tensor     3.013ms    1277.4     65%            78    3.76%
   FP8 per row        3.513ms    1095.6     55%            67    3.75%
   MXFP8             not run: CUDA error: CUBLAS_STATUS_NOT_SUPPORTED when calling `cublasLtMatmulAlgoGetHeuristic( ltHa
   MXFP4             not run: MXFP4 scaling only supported in CUDA for B200/B300
   NVFP4             not run: CUDA error: CUBLAS_STATUS_NOT_SUPPORTED when calling `cublasLtMatmulAlgoGetHeuristic( ltHa

decode-like (M=32): (32 x 8192) times (8192 x 28672)
   format                time   TFLOP/s  of peak  weights GB/s    error
   BF16               0.165ms      91.2      9%          2851    0.29%
   FP16               0.172ms      87.5      9%          2735    0.04%
   INT8               0.092ms     163.0      8%          2546    1.29%
   FP8 per tensor     0.086ms     175.2      9%          2737    3.75%
   FP8 per row        0.093ms     161.8      8%          2529    3.74%

NVIDIA B200, compute capability 10.0, PyTorch 2.15.0+cu132, CUDA 13.2

prefill-like (M=8192): (8192 x 8192) times (8192 x 28672)
   format                time   TFLOP/s  of peak  weights GB/s    error
   BF16               2.699ms    1425.8     63%           174    0.29%
   FP16               2.889ms    1332.2     59%           163    0.04%
   INT8               1.191ms    3229.9     72%           197    1.28%
   FP8 per tensor     1.392ms    2765.3     61%           169    3.75%
   FP8 per row        1.919ms    2005.4     45%           122    3.75%
   MXFP8              1.324ms    2907.1     65%           183    4.16%
   MXFP4              0.709ms    5427.7     60%           176   16.23%
   NVFP4              0.619ms    6213.8     69%           213   13.44%

decode-like (M=32): (32 x 8192) times (8192 x 28672)
   format                time   TFLOP/s  of peak  weights GB/s    error
   BF16               0.077ms     195.9      9%          6121    0.29%
   FP16               0.076ms     197.0      9%          6155    0.04%
   INT8               0.054ms     276.8      6%          4325    1.27%
   FP8 per tensor     0.040ms     373.2      8%          5831    3.75%
   FP8 per row        0.048ms     312.7      7%          4886    3.74%
   MXFP8              0.047ms     319.4      7%          5146    4.18%
   MXFP4              0.033ms     451.9      5%          3751   16.25%
   NVFP4              0.031ms     490.5      5%          4311   13.46%
```

`format_matmul.py` on a Google Cloud spot L4 (g2-standard-8):

```text
NVIDIA L4, compute capability 8.9, PyTorch 2.15.0+cu132, CUDA 13.2

prefill-like (M=8192): (8192 x 8192) times (8192 x 28672)
   format                time   TFLOP/s  of peak  weights GB/s    error
   BF16              66.049ms      58.3     48%             7    0.29%
   FP16              70.401ms      54.7     45%             7    0.04%
   INT8              30.934ms     124.4     51%             8    1.28%
   FP8 per tensor    42.159ms      91.3     38%             6    3.76%
   FP8 per row      105.890ms      36.3     15%             2    3.75%

decode-like (M=32): (32 x 8192) times (8192 x 28672)
   format                time   TFLOP/s  of peak  weights GB/s    error
   BF16               2.028ms       7.4      6%           232    0.29%
   FP16               2.041ms       7.4      6%           230    0.04%
   INT8               1.029ms      14.6      6%           228    1.27%
   FP8 per tensor     1.030ms      14.6      6%           228    3.75%
   FP8 per row        0.992ms      15.2      6%           237    3.74%
```

The L4 reaches less of its datasheet peak than the data-centre GPUs: it is a 72-watt card, and a long matmul holds it at its power limit, which lowers its clock. Its FP8 ran at only 1.6 times BF16 in the prefill shape, and FP8 with one scale per row ran at 36 TFLOP/s, slower than BF16, which suggests the library has no tuned kernel for that case on this GPU. In the decode shape, every 8-bit format halved BF16's time exactly, because there the L4's 300 GB/s of bandwidth sets the time.

*Part B.* In the prefill shape, throughput rises with each narrower format the GPU supports, and the block-scaled formats fail cleanly on the H100, whose tensor cores lack them. In the decode shape, the "weights GB/s" column, the weight matrix's bytes divided by the time, stays near each GPU's memory bandwidth for BF16 and FP8, which is what a memory-bound operation looks like: the time is the bytes divided by the bandwidth, so halving the bytes halves the time. The 4-bit formats on the B200 read at a lower rate, because at about 30 microseconds the cost of reading the scales and of launching and finishing the kernel is no longer small next to reading the weights.

*Part C.* On H100s, FP8 E4M3 with per-channel or per-tensor scales is the natural first step: in the lab it nearly halved the decode-shaped matmul and ran 1.7 times faster in the prefill shape, and it halves the weight memory, leaving more room for the KV cache. On B200s, NVFP4 is the format to try next, with about 4.4 times BF16's prefill throughput and a further cut in decode time and memory, and MXFP4 is the alternative when a checkpoint already uses it. Before switching, measure the model's quality on its own tasks against the BF16 model, as chapter 4.4 describes, and measure end-to-end throughput and latency in the serving engine at production batch sizes, because a single matmul leaves out attention, the KV cache and the engine's overheads.

</details>

## Interview angle

- **"Why does BF16 work for training when FP16 needs loss scaling?"** BF16 has FP32's 8 exponent bits, so it covers FP32's whole range and small gradients do not underflow, while FP16's 5 exponent bits stop at 65,504 and lose values below about 6 × 10^-8. BF16 pays with precision, 7 mantissa bits against FP16's 10, and training tolerates that.
- **"What is the difference between E4M3 and E5M2, and where is each used?"** E4M3 has one more mantissa bit and less range, up to 448, so it suits weights and activations; E5M2 has more range, up to 57,344, and suits gradients. E4M3 also gives up infinities and keeps a single NaN pattern per sign to reach 448.
- **"What are MXFP4 and NVFP4, and how do they differ?"** Both store FP4 E2M1 values with a scale per block. MXFP4, from the OCP MX specification, uses blocks of 32 and a power-of-two E8M0 scale, 4.25 bits per value. NVFP4 uses blocks of 16 with an FP8 E4M3 scale plus one FP32 scale per tensor, 4.5 bits per value, and fits each block more closely.
- **"Will FP8 speed up decode on an A100?"** Only by saving bandwidth. The A100's tensor cores have no FP8 inputs, so FP8 weights must be converted to BF16 in the kernel, which still halves the bytes read, and a memory-bound decode step benefits from that, but the multiplications run at BF16 speed.
- **"Why do 4-bit formats need block scales when FP8 can often use one scale per tensor?"** FP8 has 253 values spread over a range of more than 10^5, so a single scale leaves most weights well represented. FP4 has 15 values, so with one scale for a whole tensor the largest weight pushes most weights below FP4's smallest step and they round to zero; a scale per block of 16 or 32 lets each block use the whole grid.

## Check yourself

<details>
<summary>Why does a floating-point format have roughly the same relative error everywhere in its normal range, and an integer format not?</summary>

Between consecutive powers of two, a float has the same number of evenly spaced values, 2^m, so the gap between neighbours grows in proportion to the numbers themselves, and rounding error stays a fixed fraction of the value. An integer format with a scale has one gap everywhere, so small values are rounded with the same absolute error as large ones, which is a much larger relative error.

</details>

<details>
<summary>The MX specification's scale rule clamps some values. Why, and what is the alternative?</summary>

The rule chooses the largest power of two at or below the block's largest magnitude and divides it by the element format's largest power of two, 4 for E2M1. The block's largest value then lands between 4 and 8, and FP4's largest value is 6, so values between 6 and 8 are clamped to 6. Rounding the scale up instead puts the largest value at or below 6, so nothing is clamped, but each block then uses less of the grid. In the lab both gave about the same error.

</details>

<details>
<summary>NVFP4 stores block scales in E4M3. Why does it also need an FP32 scale per tensor?</summary>

A block's scale is its largest magnitude divided by 6, and across a tensor those scales can span a wider range than E4M3's, from 0.002 to 448. The FP32 tensor scale shifts all the block scales into E4M3's range, so each block's scale can be stored with E4M3's 3 bits of precision.

</details>

<details>
<summary>In the lab's decode-shaped matmul, FP8 halved BF16's time but NVFP4 on the B200 did not reach a quarter. Why?</summary>

The decode-shaped matmul is memory-bound, so its time is roughly the bytes read divided by the bandwidth, and FP8 halves the bytes. NVFP4 cuts the weights to about 4.5 bits each, but at about 30 microseconds the fixed costs of the kernel and the reading of the scales are a large part of the total, so the time falls less than the bytes.

</details>

<details>
<summary>A checkpoint in OCP FP8 E4M3 is loaded on an AMD MI300X. What has to happen?</summary>

The MI300X's tensor cores use the FNUZ variant of E4M3, whose exponent bias is one higher and whose largest value is 240 instead of 448. The usual conversion keeps each weight's bit pattern and reads it as FNUZ, which halves every value, so OCP E4M3's largest value, 448, becomes 224 and still fits; each scale is doubled to compensate. The one pattern that must change is 1.0000.000, which is -0 in OCP E4M3 but NaN in FNUZ, so it is replaced with 0.

</details>

## Further reading

- [FP8 Formats for Deep Learning](https://arxiv.org/abs/2209.05433), by Micikevicius and others, defines E4M3 and E5M2 and shows FP8 training and inference results.
- The [OCP Microscaling Formats (MX) v1.0 specification](https://www.opencompute.org/documents/ocp-microscaling-formats-mx-v1-0-spec-final-pdf) defines MXFP8, MXFP6, MXFP4 and MXINT8, the E8M0 scale and the scale rule, and [Microscaling Data Formats for Deep Learning](https://arxiv.org/abs/2310.10537) gives the experiments behind it.
- NVIDIA's [Introducing NVFP4 for Efficient and Accurate Low-Precision Inference](https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/) explains NVFP4's two-level scaling and its accuracy, and [Pretraining Large Language Models with NVFP4](https://arxiv.org/abs/2509.25149) gives the exact scale formulas in its appendix.
- [Accelerating AI Training with NVIDIA TF32 Tensor Cores](https://developer.nvidia.com/blog/accelerating-ai-training-with-tf32-tensor-cores/) explains TF32 and how tensor cores use it.
- The [DeepSeek-V3 technical report](https://arxiv.org/abs/2412.19437), section 3.3, describes FP8 training with fine-grained tile and block scales.
- AMD's [ROCm precision support](https://rocm.docs.amd.com/en/latest/reference/precision-support.html) page lists the formats of each Instinct generation, including the FNUZ FP8 variants.
- PyTorch's [torch.finfo](https://docs.pytorch.org/docs/2.15/type_info.html) documents the numeric properties of its floating-point dtypes; the page lists the 16-, 32- and 64-bit ones, and `torch.finfo` also accepts the FP8 dtypes, as the lab does.
