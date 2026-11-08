# Quantization math

Chapter 4.1 showed what the small number formats can hold. This chapter covers how a model's weights and activations are mapped onto them: the scale and zero-point that turn integers back into real numbers, how many values should share one scale, how the range is chosen, and which tensors to quantize at all. Those choices decide whether a 4-bit model is usable, and whether quantizing it makes inference faster or only smaller. The answer to the second question differs between decode and prefill, and the chapter measures it with real kernels on an H100 and an L4. The last section covers outliers in activations, the reason INT8 activations were hard for large models, and the reason for most of the algorithms in chapter 4.3.

Before this chapter, read [Number formats](/learn/number-formats) for the formats themselves and [Number formats and quantization](/learn/gpus-for-ai#number-formats-and-quantization) for why quantization matters to serving.

## Scale and zero-point

Integer quantization maps each real value x to an integer code q with a scale s, a positive real number, and sometimes a zero-point z, an integer:

```text
quantize:    q = clamp(round(x / s) + z, qmin, qmax)
dequantize:  x̂ = s × (q - z)
```

The difference between x and x̂ is the quantization error. Rounding contributes at most half a step, s / 2, for values inside the range, and clamping contributes whatever lies beyond the range.

There are two common ways to choose s and z. **Symmetric** quantization fixes z at 0 and uses codes from -2^(b-1) to 2^(b-1) - 1 for b bits, so -8 to 7 for INT4. The scale is the largest magnitude in the data divided by 2^(b-1) - 1, so the largest value maps to code 7 and the grid is centred on zero. **Asymmetric** quantization, also called affine, uses codes from 0 to 2^b - 1 and maps the data's minimum to code 0 and its maximum to the top code, up to the rounding of the zero-point. The scale is (max - min) / (2^b - 1), and the zero-point is the code that represents 0.0, round(-min / s). Both keep 0.0 exactly representable, which matters because zero padding and zero-valued activations must stay zero.

The lab quantizes eight weights by hand both ways. The weights run from -0.31 to 0.44, so the symmetric grid, which spans -0.50 (code -8) to 0.44, wastes the codes below -0.31, while the asymmetric grid has a step of 0.05 and spans -0.30 to 0.45, the data's range shifted slightly by rounding the zero-point to an integer, and has a lower error, 0.0137 against 0.0169. The price is a zero-point to store and a subtraction in every dequantization. Weights are usually close to symmetric around zero, so the gain is modest on large groups, but it grows when groups are small and their ranges lopsided. Activations after a ReLU or a SiLU are skewed, which made asymmetric quantization the norm for activations in older INT8 pipelines.

## How many values share a scale

A scale is chosen for some set of values, and the smaller the set, the more closely the scale fits it. The common choices for a weight matrix of shape (out_features, in_features) are one scale for the whole tensor, one per output channel (a row), and one per group of g consecutive weights along a row, typically 32, 64 or 128. Each scale costs storage, usually 16 bits, plus the zero-point's bits if the quantization is asymmetric. The lab quantized the 106 million linear-layer weights of SmolLM2-135M every way:

| Scheme | Bits per weight | Weight error | Weights rounded to 0 |
|---|---|---|---|
| INT8, per tensor | 8.00 | 3.64% | 5.2% |
| INT8, per channel | 8.03 | 0.85% | 1.2% |
| INT4, per tensor | 4.00 | 58.3% | 68.8% |
| INT4, per channel | 4.03 | 15.5% | 21.8% |
| INT4, group 128 | 4.13 | 12.5% | 17.7% |
| INT4, group 128, asymmetric | 4.16 | 10.5% | 15.0% |
| INT4, group 32 | 4.50 | 10.1% | 14.3% |
| INT4, group 32, asymmetric | 4.63 | 8.3% | 11.6% |

The error is the RMS error divided by the RMS weight, and the schemes are symmetric unless marked. Per-channel scales cost almost nothing and cut INT8's error fourfold; at 4 bits, one scale per tensor destroys the model, and the finer the groups, the lower the error. Group 128 is the usual compromise, and the default in GPTQ and AWQ checkpoints: it adds an eighth of a bit per weight. What the errors do to the model shows in its perplexity on WikiText-2, which was 17.10 before quantization:

| Weights | Perplexity | Change |
|---|---|---|
| INT8, per channel | 17.17 | +0.4% |
| INT4, per tensor | 4.0 million | unusable |
| INT4, per channel | 37.82 | +121% |
| INT4, group 128 | 27.05 | +58% |
| INT4, group 128, asymmetric | 23.01 | +35% |
| INT4, group 32 | 22.43 | +31% |
| INT3, group 128 | 731.4 | unusable |

Eight-bit weights with per-channel scales are nearly free. Four-bit weights rounded to nearest damage this small model badly at every group size, and chapter 4.3's algorithms exist to close that gap. Small models suffer more from quantization than large ones, so these percentages overstate what INT4 does to an 8B model, which chapter 4.3 measures.

```widget
quantization-playground
```

Start with INT4 and one scale for all 64 weights, then add the outlier: the step between levels grows until most weights sit on zero or one step from it. Shrink the group to 16 and the outlier only spoils its own group. Switch to asymmetric with groups of 8 to see each grid fit its group's range. Then lower the bits to INT2, where only four levels are left per group.

## Clipping and calibration

The largest value in a group need not set its range. Clipping chooses a smaller range, so the few values beyond it are cut to the edge and every other value gets a finer grid. The lab searched each group for the clip ratio, between 100% and 50% of the largest magnitude, that minimized the group's squared error. For INT4 with per-channel scales, the best ratio averaged 0.71 and cut the weight error from 15.5% to 11.7%; for group 128 it averaged 0.83 and cut the error from 12.5% to 10.8%. Yet the clipped per-channel model's perplexity was slightly worse, 38.11 against 37.82, because the error that matters is the error in each layer's output, and the largest weights tend to be the ones that matter most to it. That gap between weight error and output error is the reason chapter 4.3's algorithms look at activations.

Activations need ranges too, and they change with every input. **Dynamic** quantization computes the scale from each input at run time, for instance one scale per token from that token's largest value; it fits every input but costs a reduction over the activations before each matmul. **Static** quantization fixes the scales in advance from a **calibration** set, a few hundred representative inputs run through the model while observers record each tensor's range. Calibration methods differ in how they turn the recorded values into a range: the minimum and maximum, a percentile such as 99.99% that ignores rare extremes, or the range that minimizes the mean squared error or a divergence between the original and quantized distributions. The calibration data should resemble the traffic the model will serve; a model calibrated on English prose can clip the activations of code or of another language.

## Weight-only or weights and activations

Two families of quantized inference look alike on paper and behave differently on a GPU.

**Weight-only** quantization, written W4A16 or W8A16 for 4- or 8-bit weights with 16-bit activations, stores the weights small and converts them back to BF16 or FP16 inside the matmul kernel, tile by tile, in registers. The tensor cores still multiply in 16 bits. The saving is in memory and in bytes read: a 4-bit weight matrix is a quarter of the size. A decode step, which part 1 showed is limited by reading the weights, gets faster roughly in proportion; a prefill, which is limited by tensor-core arithmetic, gets no faster, and the dequantization adds work.

**Weight-and-activation** quantization, such as W8A8 in INT8 or FP8, quantizes the activations too, usually dynamically per token, so that both inputs of the matmul are 8-bit and the tensor cores run at their 8-bit rate, twice the 16-bit rate on an H100. It speeds up both phases: decode by halving the weight bytes, and prefill by doubling the arithmetic rate.

The lab's [w4a16_matmul.py](/labs/infra/gpu/w4a16_matmul.py) measures both on the weight matrix of one Llama 3 70B MLP projection, 8,192 by 28,672, against M rows of activations, from M = 1, a decode step for one sequence, to M = 4,096, a chunk of prefill. On an H100, speedup over BF16:

| Kernel | M = 1 | M = 16 | M = 64 | M = 256 | M = 1,024 | M = 4,096 |
|---|---|---|---|---|---|---|
| W4A16, dequantize to BF16 then matmul | 0.07× | 0.07× | 0.07× | 0.09× | 0.24× | 0.55× |
| W4A16, tinygemm (in PyTorch) | 2.60× | 0.63× | 0.17× | 0.05× | 0.04× | 0.04× |
| W4A16, the lab's Triton kernel | 1.30× | 1.26× | 0.86× | 0.35× | 0.33× | 0.35× |
| W4A16, Marlin (in vLLM) | 3.06× | 2.89× | 1.92× | 0.60× | 0.49× | 0.50× |
| W8A8 FP8, per-token activations | 1.33× | 1.27× | 1.37× | 1.24× | 1.31× | 1.36× |

Four things stand out. First, weight-only quantization needs a fused kernel: dequantizing the whole matrix to BF16 and then multiplying reads and writes the full-size matrix on every call, so it is slower than BF16 at every batch size. Second, the fused kernels win at small batches, where reading the weights is the cost: Marlin, the W4A16 kernel vLLM uses for GPTQ and AWQ checkpoints on Ampere and Ada GPUs (on Hopper it now prefers a newer kernel, Machete), ran at 3.1 times BF16's speed for one row, close to the 4 times the bytes allow, and stayed near 3 times up to 16 rows, as its authors report for batches up to 16 to 32. Third, from about 256 rows the matmul is compute-bound and every W4A16 kernel is slower than BF16, Marlin at half its speed, because the tensor cores do the same 16-bit arithmetic plus the dequantization. Fourth, FP8 W8A8 was faster than BF16 at every size, by 1.24 to 1.37 times, including the time to quantize the activations. PyTorch's tinygemm kernel, built for single-sequence decoding, shows how narrow a kernel's sweet spot can be: it was fast for one row and 25 times slower than BF16 at 4,096.

The lab's own Triton kernel is about 50 lines: it loads a tile of packed 4-bit weights, unpacks and dequantizes it in registers, and feeds it to the tensor cores with `tl.dot`. It beat BF16 for small batches without any of Marlin's tuning, which arranges the weights so that each load feeds the tensor cores directly and overlaps the dequantization with memory traffic.

The practical rule follows from the table. Weight-only INT4 suits latency-sensitive serving at small batches and models that would not otherwise fit, while a server running large batches, where most time goes to compute-bound prefill and batched decode, gains more from FP8 W8A8 on GPUs that support it. The lab's INT8 W8A8 uses PyTorch's general `torch._int_mm` with separate quantize and rescale kernels, and on the H100 it was slower than BF16, so it is not a fair test of INT8 there; vLLM's INT8 kernels apply both scales inside the matmul instead. On the L4 the same code ran faster than BF16 at every size.

## Outliers in activations

Weights are well behaved: roughly bell-shaped, with few values far from the rest. Activations of large language models are not. Dettmers and others, in the LLM.int8() paper of 2022, found feature dimensions whose values were up to 20 times larger than in other dimensions. They appeared in a few fixed dimensions of the hidden state, and in the models the authors studied, up to 13 billion parameters, they spread suddenly with scale: at around 6.7 billion parameters, values of magnitude 6 or more appeared in all layers and in 75% of the tokens of a sequence. Measured against perplexity instead of size, the emergence was smooth, so the authors concluded that the model's quality, not its size alone, decides when outliers appear. A matrix of activations quantized to INT8 with one scale per tensor, or even one per token, then has its scale set by the outlier, and every ordinary activation falls within a few steps of zero.

The problem cannot be fixed with per-channel scales, because of where scales can go in a matmul. In Y = X W^T, a scale per row of X (per token) and a scale per column of W^T (per output channel) can both be applied to the result after the integer matmul, but a scale per column of X, per input channel, sits inside the sum over that dimension and cannot be factored out. LLM.int8()'s answer was a mixed-precision decomposition: every feature column of X containing a value of magnitude 6 or more is multiplied in 16 bits, and the rest in INT8 with per-token and per-channel scales. The outlier columns were about 0.1% of the feature dimensions, so more than 99.9% of the values were still multiplied in 8 bits. Chapter 4.3's SmoothQuant takes a different route, moving the outliers' range from the activations into the weights before quantizing.

Even a 135-million-parameter model shows the pattern. The lab recorded the inputs to every linear layer of SmolLM2-135M on 8,192 tokens of WikiText-2. Only 0.066% of the values had magnitude 6 or more, but they were concentrated: the input to one layer's `down_proj` reached 2,643, while the median channel's largest value was 8.5. With INT8 per-channel weights, the error of the layers' outputs and the model's perplexity were:

| Activations | Output error, all layers | Perplexity | Change |
|---|---|---|---|
| 16-bit (W8A16) | 0.79% | 17.17 | +0.4% |
| INT8, one scale per tensor | 15.75% | 32.33 | +89% |
| INT8, one scale per token | 2.54% | 17.78 | +4.0% |
| INT8 per token, outlier columns in 16-bit | 1.09% | 17.35 | +1.4% |

One scale per tensor nearly doubled the perplexity. A scale per token helped most here, because SmolLM2's largest values sit in a few tokens as well as a few channels, and keeping the outlier columns in 16 bits recovered most of the rest. Switch the widget to "Activations" to see the two kinds of outlier: an outlier channel present in every token defeats per-token scales, and an outlier token does not.

## Lab: quantization from scratch, then on a GPU

**Tier: [Mac] then [1 GPU].** Part A runs on a CPU in about eight minutes after a 270 MB model download and needs torch, transformers, safetensors, huggingface_hub and pyarrow. Part B needs an NVIDIA GPU of compute capability 8.0 or later.

Download [quant_math.py](/labs/infra/quant_math.py) and [gpu/w4a16_matmul.py](/labs/infra/gpu/w4a16_matmul.py). Run the first with `python quant_math.py`. Run the second from the `gpu/` folder with one of these commands:

```bash
modal run modal_run.py --script w4a16_matmul.py --gpu 'H100!'        # about 30 s of GPU time, $0.03
modal run modal_run.py --script w4a16_matmul.py --gpu 'H100!' --vllm # adds vLLM's Marlin kernel; about $0.06
python gcp_run.py --script w4a16_matmul.py --gpu L4                  # about 12 min of VM time: $0.10 Spot, $0.17 on-demand
```

**Part A, from scratch.** Write `quantize` and `dequantize` for symmetric and asymmetric integers at any bit width and any granularity, from one scale per tensor to groups of 32, and report the error and the true bits per weight of each scheme on SmolLM2-135M's weights. Add a clip search. Pack an INT4 layer two codes to a byte with FP16 scales, write the function that multiplies activations by it, and check it against dequantize-then-multiply. Then record the inputs of every linear layer on real text and compare per-tensor, per-token and decomposed INT8 activations by the layers' output error and the model's perplexity.

**Part B, on a GPU.** Time a BF16 matmul against weight-only INT4 (unfused, tinygemm, your own Triton kernel and Marlin) and FP8 W8A8 for 1 to 4,096 rows of activations. Find the number of rows at which each W4A16 kernel stops beating BF16, and explain it with the roofline from chapter 1.2.

**Part C, a decision.** A team serves Llama 3.1 8B on H100s for a chat product whose median batch is about 8 sequences, and the same model for an offline batch job that runs prefill-heavy batches of 256. In a few sentences, say which quantization each workload should use and why.

<details>
<summary>Reference solution</summary>

`quant_math.py` on an Apple M2 MacBook with 8 GB of memory, parts 1, 3, 4 and 5 (part 2 and part 6 are the tables in the chapter, and two rows of part 5 are left out):

```text
PyTorch 2.15.0, Transformers 5.22.2

1. Eight weights quantized to INT4 by hand
   weights      [-0.31, 0.05, 0.12, -0.02, 0.44, 0.09, -0.15, 0.27]
   symmetric    scale 0.0629  zero-point  0  codes [-5, 1, 2, 0, 7, 1, -2, 4]
                dequantized [-0.314, 0.063, 0.126, -0.0, 0.44, 0.063, -0.126, 0.251]  RMS error 0.0169
   asymmetric   scale 0.0500  zero-point  6  codes [0, 7, 8, 6, 15, 8, 3, 11]
                dequantized [-0.3, 0.05, 0.1, 0.0, 0.45, 0.1, -0.15, 0.25]  RMS error 0.0137

3. Clipping: each group's range shrunk to the ratio (1.0 to 0.5) that minimizes its squared error
   scheme                                    no clip  clipped  mean ratio
   INT4 per channel, symmetric                15.47%   11.68%        0.71
   INT4 group 128, symmetric                  12.50%   10.75%        0.83
   INT3 group 128, symmetric                  29.01%   20.56%        0.64

4. A packed INT4 layer: layers.15.mlp.down_proj, (576, 1536), group 128, asymmetric
   bytes: FP32 3,538,944, BF16 1,769,472, packed INT4 + FP16 scales + 8-bit zeros 463,104 (4.19 bits/weight)
   int4_linear vs dequantize-then-matmul: max difference 7.54e-03 (only the FP16 rounding of the scales)
   int4_linear vs the original FP32 layer: relative error 11.10%

5. Inputs to the 210 linear layers over 8,192 WikiText-2 tokens
   values with magnitude >= 6: 0.066% of all inputs
   layer input                         largest  median channel max   ratio  W8A8 per tensor  per token  decomposed   W8A16
   layers.12.self_attn.q_proj             11.9                0.54      22            7.54%      5.24%       1.37%   0.85%
   layers.12.self_attn.v_proj             11.9                0.54      22           17.89%     12.47%       3.25%   2.00%
   layers.29.self_attn.o_proj             13.7                4.13       3            3.44%      1.29%       1.04%   0.69%
   layers.29.mlp.up_proj                  29.0                0.87      34           17.73%      4.51%       1.59%   0.84%
   layers.28.mlp.down_proj              2642.8                8.53     310           26.93%      3.07%       0.82%   0.81%
   all layers                                                                        15.75%      2.54%       1.09%   0.79%
```

*Part A.* The packed layer stores 4.19 bits per weight, a quarter of BF16's bytes plus the scales and zeros, and the multiply that unpacks it matches dequantize-then-multiply up to the FP16 rounding of the scales. In part 5, the layer whose input had the largest value, `down_proj` of layer 28, shows the worst per-tensor error, 27%, which per-token scales cut to 3.1% and the decomposition to 0.8%, the same as leaving the activations in 16 bits. The `v_proj` row shows that per-token scales are not always enough: its input's outliers sit in fixed channels, so every token's scale is inflated, and only the decomposition helps.

`w4a16_matmul.py` on Modal's H100 with `--vllm`, the M = 1 and M = 4,096 blocks (the summary table is in the chapter):

```text
NVIDIA H100 80GB HBM3, compute capability 9.0, PyTorch 2.13.0+cu130, CUDA 13.0
weight (28672 x 8192): BF16 448 MiB, INT4 + scales 119 MiB, INT8 224 MiB
M = 1
   scheme                   time  vs BF16  weights GB/s  TFLOP/s   error
   BF16                  162.1us    1.00x          2899      2.9   0.23%
   W4A16, unfused       2297.6us    0.07x           204      0.2   9.96%
   W4A16, tinygemm        62.2us    2.60x          2005      7.5   9.96%
   W4A16, Triton         124.9us    1.30x           999      3.8   9.95%
   W4A16, Marlin          53.0us    3.06x          2286      8.9  11.10%
   W8A8 INT8             208.2us    0.78x          1128      2.3   1.29%
   W8A8 FP8              122.0us    1.33x          1926      3.9   3.72%
M = 4096
   scheme                   time  vs BF16  weights GB/s  TFLOP/s   error
   BF16                 2674.3us    1.00x           176    719.5   0.23%
   W4A16, unfused       4826.0us    0.55x            97    398.7   9.98%
   W4A16, tinygemm     63679.1us    0.04x             2     30.2   9.98%
   W4A16, Triton        7749.5us    0.35x            16    248.3   9.98%
   W4A16, Marlin        5394.8us    0.50x            22    356.7  11.16%
   W8A8 INT8            4045.9us    0.66x            58    475.6   1.29%
   W8A8 FP8             1959.6us    1.36x           120    981.9   3.75%
```

`w4a16_matmul.py` on a Google Cloud L4 (g2-standard-8, on-demand; no Spot L4 was free that day), summary only:

```text
NVIDIA L4, compute capability 8.9, PyTorch 2.15.0+cu132, CUDA 13.2
Speedup over BF16 by batch size (rows of activations)
   scheme                  M=1     M=16     M=64    M=256   M=1024   M=4096
   W4A16, unfused        0.11x    0.11x    0.12x    0.16x    0.42x    0.73x
   W4A16, tinygemm       3.74x    1.71x    0.47x    0.17x    0.13x    0.12x
   W4A16, Triton         3.23x    3.21x    2.18x    1.14x    0.89x    0.81x
   W8A8 INT8             1.61x    1.69x    1.72x    1.44x    1.17x    1.01x
   W8A8 FP8              1.75x    1.82x    1.96x    0.75x    0.67x    0.59x
```

The L4 has a tenth of the H100's bandwidth, 300 GB/s, and its BF16 matmul for one row took 1.80 ms, so weight-only quantization pays more and for longer: the lab's simple Triton kernel ran at 3.2 times BF16's speed up to 16 rows and still beat it at 256. FP8 W8A8 with per-token scales was fast at small batches but slower than BF16 from 256 rows, the same weak spot chapter 4.1 found for row-scaled FP8 on this GPU, while INT8 W8A8 held up. A kernel's speedup depends on the GPU, so measure on the one you will serve with.

*Part B.* At one row, the BF16 matmul reads 448 MiB in 0.16 ms, about 2.9 TB/s, close to the H100's 3.35 TB/s, so it is memory-bound and a kernel that reads a quarter of the bytes can be up to four times faster; Marlin reached 3.1 times. Each extra row adds arithmetic but no weight bytes, so the arithmetic intensity grows with M, and by a few hundred rows the matmul is compute-bound. From there, a W4A16 kernel does BF16's arithmetic plus the dequantization and cannot be faster than BF16, while FP8 W8A8 runs on tensor cores with twice the BF16 peak.

*Part C.* The chat workload decodes small batches, where the matmuls are memory-bound, so weight-only INT4 with a fused kernel such as Marlin or Machete (from a GPTQ or AWQ checkpoint) gives the largest decode speedup, close to three times per matmul at 8 rows, and frees memory for the KV cache; FP8 is the alternative if INT4's quality loss is too large. The batch job is dominated by prefill and large-batch decode, which are compute-bound, so W4A16 would slow it down, and FP8 W8A8 is the better choice: it was about 1.3 times faster than BF16 at every batch size in the lab and halves the weight memory. Both choices need the quality checks of chapter 4.4 before going live.

</details>

## Interview angle

- **"Explain scale and zero-point."** A quantized value is an integer code q; the real value is s × (q - z), where the scale s sets the step between representable values and the zero-point z is the code that means 0.0. Symmetric quantization fixes z at 0 and centres the grid on zero; asymmetric quantization fits the grid between the data's minimum and maximum, which helps skewed data such as activations after an activation function.
- **"Why do 4-bit weights use group-wise scales?"** With 15 or 16 levels, one scale per tensor or per row lets the largest weight set a step so large that most weights round to zero. A scale per group of 128 (or 64, or 32) fits each group's own range for an extra eighth of a bit per weight with FP16 scales; in the lab it cut INT4's error from 58% per tensor and 15% per channel to 12.5%.
- **"Does INT4 weight-only quantization speed up inference?"** It speeds up the memory-bound part: decode at small batches, where a fused kernel like Marlin reads a quarter of the bytes and ran about three times faster than BF16 on an H100. It slows down compute-bound work, such as prefill and large batches, because the tensor cores still compute in 16 bits and the kernel must also dequantize. For throughput-oriented serving on Hopper or newer, FP8 W8A8 speeds up both.
- **"Why is INT8 activation quantization hard for LLMs?"** Large models have activation outliers in a few fixed channels, up to about 20 times larger than the rest according to LLM.int8(); a per-tensor or per-token scale is set by them, which leaves the other values with few levels. Per-channel scales would fix it but cannot be applied to the input dimension of a matmul. LLM.int8() keeps the outlier channels in 16 bits; SmoothQuant migrates their range into the weights.
- **"Static or dynamic activation scales?"** Dynamic scales are computed from each input at run time, fit it exactly and need no calibration, at the cost of a reduction before each matmul. Static scales come from a calibration set, cost nothing at run time, and can clip inputs unlike the calibration data. FP8 W8A8 in vLLM commonly uses dynamic per-token scales; static scales suit hardware or engines that need fixed ranges.

## Check yourself

<details>
<summary>Weights between -0.2 and 0.6 are quantized to INT4 symmetrically and asymmetrically. Which grid wastes codes, and how many?</summary>

The symmetric scale is 0.6 / 7, so the grid runs from -8 × 0.6 / 7, about -0.69, to 0.6, and the codes from -8 to -3 represent values below -0.2 that no weight takes: 6 of the 16 codes are wasted. The asymmetric grid has a step of 0.8 / 15 and a zero-point of round(0.2 / step) = 4, so it spans about -0.21 to 0.59, and every code is within one step of the data.

</details>

<details>
<summary>What does INT4 with one FP16 scale per group of 64 and a 4-bit zero-point cost per weight?</summary>

Four bits for the code plus (16 + 4) / 64 bits of metadata, about 4.31 bits per weight. With a group of 128 it would be about 4.16, and with symmetric quantization, which stores no zero-point, 4.25 and 4.125.

</details>

<details>
<summary>The lab's clipped per-channel INT4 weights had a lower weight error than the unclipped ones but a slightly worse perplexity. How can that be?</summary>

Clipping minimized each row's squared weight error, treating every weight as equally important. The model's output depends on each weight times its input, and the weights that clipping cuts, the largest ones, often meet large inputs, so a smaller total weight error can still give a larger output error. Methods that weigh the error by the inputs, such as GPTQ and AWQ, avoid this.

</details>

<details>
<summary>Why can a matmul apply a scale per token of X and per output channel of W, but not per input channel?</summary>

In Y[i, j] = Σ_k X[i, k] W[j, k], a scale for row i of X or for row j of W is a constant across the sum over k, so it can multiply the integer result afterwards. A scale per input channel k differs for each term of the sum, so the sum cannot be computed in integers and rescaled once.

</details>

<details>
<summary>On an H100, why was Marlin's W4A16 about three times faster than BF16 at one row of activations but half as fast at 4,096 rows?</summary>

At one row the matmul is memory-bound: its time is reading the weight matrix, and 4-bit weights are about a quarter of the bytes. At 4,096 rows each weight is used 4,096 times, the matmul is compute-bound, and W4A16 still computes in BF16 on the tensor cores while also unpacking and scaling every weight, so it cannot beat BF16 there.

</details>

## Further reading

- [LLM.int8(): 8-bit Matrix Multiplication for Transformers at Scale](https://arxiv.org/abs/2208.07339), by Dettmers and others, measures outlier features, their emergence around 6.7B parameters, and the mixed-precision decomposition.
- [SmoothQuant](https://arxiv.org/abs/2211.10438) shows that activation outliers persist in fixed channels, which motivates moving them into the weights (chapter 4.3).
- [MARLIN: Mixed-Precision Auto-Regressive Parallel Inference on Large Language Models](https://arxiv.org/abs/2408.11743), by Frantar and others, describes the W4A16 kernel vLLM uses and its near-4× speedup at batch sizes up to 16 to 32.
- [A White Paper on Neural Network Quantization](https://arxiv.org/abs/2106.08295), by Nagel and others at Qualcomm, covers scale and zero-point, granularity, and calibration in detail.
- [Integer Quantization for Deep Learning Inference: Principles and Empirical Evaluation](https://arxiv.org/abs/2004.09602), by Wu and others at NVIDIA, compares calibration methods (max, entropy and percentile).
- [Massive Activations in Large Language Models](https://arxiv.org/abs/2402.17762), by Sun and others, studies the very large activations that appear in a few dimensions and tokens.
