# Post-training quantization algorithms

Rounding every weight to its nearest grid point, the method chapter 4.2 used, is called round-to-nearest (RTN). It works well at 8 bits and poorly at 4: on SmolLM2-135M, INT4 with group-128 scales raised the perplexity by 35%. Post-training quantization (PTQ) algorithms close most of that gap without retraining the model. They run a few hundred calibration samples through it and use what they see to decide how to round, which channels to protect, or how to reshape the weights and activations before quantizing. This chapter covers the algorithms behind most quantized checkpoints served today (GPTQ, AWQ and SmoothQuant), the rotation methods that push activations down to 4 bits, the GGUF formats llama.cpp uses, and how FP8, NVFP4 and FP8 KV caches are produced in practice. The lab implements GPTQ, AWQ and SmoothQuant from scratch, then uses llm-compressor to quantize Llama 3.1 8B seven ways and serves each version in vLLM.

Before this chapter, read [Quantization math](/learn/quantization-math), which defines scales, groups and the weight-only and weight-and-activation schemes these algorithms produce.

## The objective: the layer's output, not its weights

Every algorithm here starts from the same observation, which the clipping experiment in chapter 4.2 illustrated: what matters is the error in each layer's output, not the error in its weights. For a linear layer with weights W and a batch of calibration inputs X, the goal is a quantized Q that minimizes

```text
|| X W^T - X Q^T ||^2
```

summed over the calibration tokens. A weight that only ever meets small inputs can be rounded coarsely; a weight that meets large inputs cannot. The algorithms differ in how they use X. GPTQ changes how weights are rounded, so that the errors of some cancel the errors of others. AWQ rescales channels, so that the important ones lose less to rounding. SmoothQuant rescales channels too, but to help the activations rather than the weights. All of them work one layer at a time, which is what makes them cheap: an 8B model is quantized in minutes to an hour on one GPU.

## GPTQ: rounding with error feedback

GPTQ, published by Frantar and others in 2022, builds on Optimal Brain Quantization. For the objective above, with X holding one calibration token per row, the Hessian with respect to one row of weights is H = 2 X^T X, a matrix over the input channels that records how strongly the inputs vary and how they correlate. (The GPTQ paper stores the tokens as columns and writes the same matrix as 2XX^T.) GPTQ quantizes the columns of W, the input channels, one at a time. After rounding a column, it computes the rounding error and spreads it over the columns not yet quantized, weighted by the inverse Hessian, so that the remaining weights shift to cancel the error in the output. Correlated inputs are what make this work: if channels 5 and 9 carry similar values, an error in a channel-5 weight can be offset by a change to the matching channel-9 weight.

Three implementation choices made it fast enough for large models. The update order is the same for every row, so the inverse Hessian is computed once per layer. The updates are applied in lazy batches of 128 columns, so most of the work is large matrix multiplications instead of many small updates. And the inverse Hessian is replaced by its Cholesky factor, with a small dampening, 1% of the mean diagonal, added to H for numerical stability. The paper calibrated on 128 random segments of 2,048 tokens from C4 and quantized OPT-175B and BLOOM-176B to 3 or 4 bits in about four hours each on a single A100. With group scales, a scale is fixed when the loop reaches the first column of each group, from the weights as updated so far. A heuristic added to the GPTQ code after the paper, called act-order or `desc_act`, quantizes the columns with the largest Hessian diagonal, the largest inputs, first, while the most columns remain to absorb their error.

The lab's version is about 60 lines. On one layer of SmolLM2-135M at INT4 with groups of 128, it shows the trade GPTQ makes:

| Method | Weight error | Output error |
|---|---|---|
| RTN | 11.05% | 10.92% |
| GPTQ | 13.67% | 8.08% |
| GPTQ, act-order | 14.58% | 7.37% |
| AWQ | 11.50% | 10.39% |

GPTQ moves the weights further from their original values, by design, and the layer's output closer.

## AWQ: protect the channels that matter

AWQ, by Lin and others (2023), starts from a measurement: keeping just 1% of the weights in FP16 greatly reduces the error of low-bit quantization (the paper's test used INT3 with groups of 128), provided those weights are chosen by the size of their input activations rather than by their own size. Mixed precision is awkward for kernels, so AWQ protects the salient channels by scaling instead. Multiplying input channel j of the weights by s_j > 1 and dividing the matching activations by s_j leaves the product unchanged, but the scaled weights now use more of the group's grid, so their relative rounding error shrinks. The division of the activations is folded into the previous operation, a normalization layer or another linear layer, so it costs nothing at run time.

AWQ sets s = s_X^α, where s_X is each channel's average activation magnitude on the calibration set, and picks α for each layer by a grid search over 0 to 1 that minimizes the layer's output error on calibration inputs. The original implementation tries 20 values, 0, 0.05 and so on up to 0.95, and then searches a clipping range for each layer's weights in the same way. It quantizes with groups of 128 and needs no backpropagation and no weight reconstruction, so it is fast and, the authors argue, less prone to overfitting the calibration set than GPTQ. Layers that read the same input, such as the query, key and value projections, share one s, because one normalization layer absorbs the division. AWQ won the best paper award at MLSys 2024, and its TinyChat inference system reported more than 3 times the speed of Hugging Face's FP16 implementation for 4-bit models.

The lab's AWQ chose α between 0 and 0.95 depending on the layer, averaging about 0.3. On the single layer above its output error was smaller than RTN's but larger than GPTQ's; across the whole model, AWQ beat GPTQ without act-order, as the next table shows.

## SmoothQuant: move the outliers into the weights

SmoothQuant, by Xiao and others (2022), addresses W8A8 rather than weight-only quantization. Its starting point is that activation outliers persist in fixed channels, so a per-channel scale would fix them, if a matmul could apply one to its input dimension; chapter 4.2 explained why it cannot. SmoothQuant applies the same rescaling trick as AWQ, but chooses the scales to flatten the activations:

```text
s_j = max(|X_j|)^α / max(|W_j|)^(1 - α)
X' = X / s,   W' = W × s,   so X' W'^T = X W^T
```

With α = 1 the activations become perfectly flat and the weights absorb all of the outliers' range; with α = 0 the reverse happens, s only evens out the weights, and the activations keep their outliers. The paper found α = 0.5 a good balance for OPT and BLOOM, used 0.75 for GLM-130B, whose activations are harder, and later used 0.8 to 0.9 for Llama models. The smoothed model is then quantized to INT8. The paper used one scale per tensor for the weights and per-tensor or per-token scales for the activations; later recipes, including llm-compressor's and this chapter's lab, use per-channel weight scales. SmoothQuant reported up to 1.56 times faster inference and half the memory of FP16 for models up to 530 billion parameters. llm-compressor's standard INT8 W8A8 recipe applies SmoothQuant with strength 0.8 and then GPTQ.

```widget
outlier-migration
```

Start at α = 0 with one scale per tensor: the four outlier channels set the activation scale, and the output error is about as high as the unsmoothed layer's, the dashed line. Raise α and watch the activation spikes shrink while the weight spikes grow; the error falls to its lowest around 0.5 to 0.65, then rises again as the weights' outliers become the problem. Switch to one scale per token: without smoothing it helps, but less than smoothing does, because the outliers sit in the same channels of every token.

## Results on a whole model

The lab ran the three algorithms on every linear layer of SmolLM2-135M, calibrated on 16,384 tokens of WikiText-2's training split and tested on its test split, where the unquantized model's perplexity is 17.10:

| Weights, group 128, asymmetric | INT4 | INT3 |
|---|---|---|
| RTN | 23.01 (+35%) | 148.5 (+768%) |
| GPTQ | 22.22 (+30%) | 97.6 (+471%) |
| GPTQ, act-order | 20.09 (+17%) | 40.5 (+137%) |
| AWQ | 20.45 (+20%) | 48.2 (+182%) |

AWQ and GPTQ with act-order roughly halve RTN's damage at 4 bits, and at 3 bits they turn an unusable model into a damaged but working one. GPTQ in its natural column order barely beat RTN: act-order mattered more than anything else for GPTQ on this model. The W8A8 results show SmoothQuant's effect:

| W8A8, INT8 per-channel weights | Per-tensor activations | Per-token activations |
|---|---|---|
| No smoothing | 32.33 (+89%) | 17.78 (+4.0%) |
| SmoothQuant, α = 0.5 | 21.11 (+23%) | 17.30 (+1.2%) |
| SmoothQuant, α = 0.8 | 18.21 (+6.5%) | 17.29 (+1.1%) |

Smoothing cut per-tensor INT8's damage from 89% to 6%, which is what makes static per-tensor activation scales, the cheapest kind, usable.

## Rotations: QuaRot and SpinQuant

Scaling channels only redistributes an outlier between two tensors. Rotation methods remove it. If H is an orthogonal matrix, then X W^T = (X H)(W H)^T, and when H is a Hadamard matrix, a structured rotation that mixes every channel with every other one with equal weight, an outlier in one channel of X is spread evenly across all channels of X H. Both X H and W H are then close to Gaussian and quantize well. Many of the rotations can be folded into the weights in advance, and the rest, applied online, are cheap fast Hadamard transforms.

QuaRot (Ashkboos and others, 2024) uses randomized Hadamard rotations to quantize weights, activations and the KV cache all to 4 bits; on Llama 2 70B it lost at most 0.47 WikiText-2 perplexity and kept 99% of the zero-shot accuracy. SpinQuant (Liu and others, 2024) learns the rotations instead and narrowed the gap to full precision on zero-shot reasoning to 2.9 points for W4A4KV4 Llama 2 7B. These methods matter for W4A4 on GPUs with 4-bit tensor cores; for W4A16 and W8A8, GPTQ, AWQ and SmoothQuant remain the common choices.

## GGUF and llama.cpp's k-quants

llama.cpp, the engine most people use to run models on laptops and phones, stores models in its GGUF file format with its own block-quantized types. The older ones are simple: Q8_0 stores blocks of 32 INT8 values with one FP16 scale, 8.5 bits per weight, and Q4_0 blocks of 32 4-bit values with one FP16 scale, 4.5 bits per weight. The k-quants, added in 2023, use two levels of scales like NVFP4, in super-blocks of 256 weights. In Q4_K, for example, a super-block holds 8 blocks of 32 weights, each block's scale and minimum are quantized to 6 bits, and the super-block stores two FP16 values that scale those. The other k-quants vary the block size and the bits of the block scales: Q6_K uses 16 blocks of 16 with 8-bit scales and no minimum. Q4_K comes to 4.5 bits per weight, Q5_K to 5.5, Q6_K to 6.5625, and Q2_K to 2.625.

The names users see, such as Q4_K_M, are mixes. Q4_K_M stores most tensors in Q4_K but gives some of the attention value projections and feed-forward down projections Q6_K, because those suffer most. llama.cpp's quantize tool lists each mix's size and perplexity change for Llama 3 8B: Q4_K_M is 4.58 GB with perplexity 0.18 higher than the 16-bit model, Q5_K_M 5.33 GB and +0.06, Q6_K 6.14 GB and +0.02, and Q8_0 7.96 GB and +0.003. Without calibration data, the k-quants search each block's scale and minimum for the lowest squared error and round each weight to nearest; llama.cpp can also weight that search by an "importance matrix" computed from calibration text, which plays the role of AWQ's and GPTQ's activation statistics.

## FP8, NVFP4 and the KV cache in practice

FP8 W8A8 needs no algorithm beyond choosing scales. With per-channel weight scales and dynamic per-token activation scales, the FP8_DYNAMIC scheme in llm-compressor, a model is converted without calibration data in a few minutes, and FP8 E4M3's floating-point grid keeps the error low enough that it is usually the first thing to try on Hopper and newer GPUs. Static activation scales need calibration but save the per-token reduction.

NVFP4 does need calibration for its activations: the per-tensor FP32 scale of each activation tensor is fixed in advance from calibration data, while the E4M3 block scales are computed on the fly. Two tools produce NVFP4 and FP8 checkpoints that serving engines load. llm-compressor, from the vLLM project, writes the compressed-tensors format that vLLM reads directly. NVIDIA's Model Optimizer (ModelOpt) writes checkpoints for TensorRT-LLM, vLLM and SGLang. Both also run GPTQ, AWQ and SmoothQuant.

The KV cache can be quantized independently of the weights. In vLLM, `kv_cache_dtype="fp8"`, which means E4M3 on NVIDIA GPUs, stores keys and values in 8 bits, so the same memory holds twice as many tokens as a BF16 cache. Without calibration the scales default to 1.0, which works when keys and values stay within E4M3's range; calibrated per-tensor or per-head scales, which llm-compressor can produce, are safer. Attention reads the whole cache at every decode step, so an FP8 cache also halves that traffic, which matters most for long contexts.

## Measured: Llama 3.1 8B, quantized seven ways

The lab's [quantize_and_eval.py](/labs/infra/gpu/quantize_and_eval.py) quantizes Llama 3.1 8B Instruct with llm-compressor 0.15.0, using 256 calibration samples where a method needs them, and serves every version in vLLM 0.32.0 on an H100. Chapter 4.4 covers the quality of each version; here are the costs:

| Version | Weights | KV cache | Decode step, batch 1 | Decode step, batch 32 | Prefill | Time to quantize |
|---|---|---|---|---|---|---|
| BF16 | 15.0 GiB | 433,000 tokens | 6.33 ms | 7.23 ms | 42,000 tok/s | |
| FP8 W8A8 | 8.5 GiB | 486,000 | 4.30 ms | 5.44 ms | 60,500 | 4 s |
| INT8 W8A8, SmoothQuant then GPTQ | 8.5 GiB | 485,000 | 4.35 ms | 5.39 ms | 63,300 | 172 s |
| INT4 W4A16, RTN | 5.4 GiB | 512,000 | 4.05 ms | 5.05 ms | 39,500 | 3 s |
| INT4 W4A16, GPTQ, perfectblend calibration | 5.4 GiB | 512,000 | 4.04 ms | 4.97 ms | 39,300 | 116 s |
| INT4 W4A16, GPTQ, WikiText calibration | 5.4 GiB | 512,000 | 4.09 ms | 5.04 ms | 39,200 | 295 s |
| INT4 W4A16, AWQ | 5.5 GiB | 511,000 | 4.18 ms | 5.21 ms | 38,600 | 212 s |
| NVFP4, run weight-only on the H100 | 5.7 GiB | 509,000 | 3.83 ms | 4.92 ms | 40,200 | 51 s |
| BF16, FP8 KV cache | 15.0 GiB | 866,000 | 6.44 ms | 6.96 ms | 41,600 | |
| INT4 AWQ, FP8 KV cache | 5.5 GiB | 1,022,000 | 4.28 ms | 5.05 ms | 38,400 | |

The KV cache column is the capacity vLLM reserved with 90% of the GPU's memory, and prefill is the throughput for 16 prompts of 2,048 tokens. Every method took under five minutes on the H100; GPTQ with WikiText took longest because its calibration samples are full 2,048-token windows, longer than the conversations of the other calibration set.

**Memory.** FP8 and INT8 cut the weights from 15.0 to 8.5 GiB, and INT4 to 5.4 GiB rather than the quarter that 4 bits suggest: the embedding table and the output head, each 128,256 by 4,096, stay in BF16 and are 2 GiB of the 5.4. On an 80 GB H100 the freed memory adds only 18% to the KV cache, while an FP8 KV cache doubles it. The balance is different on a small GPU. Each token of Llama 3.1 8B's cache takes 128 KiB in BF16 (32 layers × 8 key-value heads × 128 values × 2 for keys and values × 2 bytes). On the H100, vLLM's budget of 71.7 GiB held 15.0 GiB of weights, 52.9 GiB of cache and about 3.8 GiB of other memory. If the other memory were the same on a 24 GB L4, whose budget is 19.8 GiB, BF16 would leave about 1 GiB for the cache, about 8,000 tokens, and INT4 about 10.7 GiB, about 87,000 tokens: ten times as many. That estimate, not the H100's 18%, is why INT4 matters on small GPUs.

**Speed.** Every version with quantized weights decoded 1.45 to 1.65 times faster than BF16 at batch 1, far less than the ratio of bytes. At 3.35 TB/s, reading BF16's 15 GiB takes 4.8 ms of the measured 6.3, and reading the INT4 version's 4.3 GiB per step, its linear layers plus the BF16 output head, takes 1.4 ms of the measured 4.0. The rest of a decode step, attention, sampling, kernel launches and vLLM's scheduling, does not shrink with the weights, so at batch 1 on an H100 an 8B model hits that floor. Prefill shows chapter 4.2's kernel results at model scale: FP8 and INT8 W8A8 were 1.44 and 1.51 times faster than BF16, and every weight-only version was 4 to 8% slower.

**NVFP4.** vLLM runs NVFP4 natively only on Blackwell; on the H100 it ran the checkpoint as weight-only FP4, converting the weights to BF16 inside the matmul and leaving the activations in 16 bits, so this row measures FP4 weights, not W4A4. The lab's cross-check shows the difference: the same checkpoint loaded in Transformers, which also simulates the 4-bit activations, had a perplexity of 7.34 on the check's 8 windows against vLLM's 6.98. For every weight-only version, the two perplexities agreed within 0.03%, which confirms that vLLM reads the checkpoints as llm-compressor wrote them.

## Calibration data matters

The two GPTQ versions differ only in their calibration data. One used the first 256 conversations of open-perfectblend, an instruction dataset llm-compressor loads by name, which mixes chat, code, reasoning and math; 89 of those 256 are math word problems, most of them from MetaMathQA, which rewrites the problems of GSM8K's and MATH's training sets. The other used 256 random 2,048-token windows of WikiText-2's training split. The other calibrated versions, INT8, AWQ and NVFP4, used the same perfectblend samples.

On WikiText-2's test split, the WikiText-calibrated version had the lowest perplexity of every 4-bit version, 7.22 against 7.48 for the perfectblend one. On GSM8K's test problems it scored 66.6%, no better than rounding to nearest, while the perfectblend version kept 73.4%; head to head, the perfectblend version solved 185 problems the other missed, against 95 the other way. Each version kept the domain it was calibrated on. GPTQ minimizes each layer's output error on the calibration inputs and adjusts the weights to do so, so it fits those inputs closely: calibrated on Wikipedia prose, it fitted the activations prose produces, and the model's arithmetic drifted.

Two lessons follow. Calibrate on data like the traffic the model will serve. And do not judge a quantized model only on data like its calibration set, because that is where it looks best: WikiText perplexity flatters the WikiText-calibrated version, and by the same logic GSM8K flatters the perfectblend versions, whose calibration set contains GSM8K-style problems. Chapter 4.4 shows how to measure quality more broadly.

## Lab: three algorithms from scratch, then a real model

**Tier: [Mac] then [1 GPU].** Part A runs on a CPU in about 20 minutes and needs [quant_math.py](/labs/infra/quant_math.py) from chapter 4.2 in the same folder. Part B quantizes and serves an 8B model; the reference run used an H100 on Modal.

Download [ptq_algorithms.py](/labs/infra/ptq_algorithms.py) and [gpu/quantize_and_eval.py](/labs/infra/gpu/quantize_and_eval.py). Run the first with `python ptq_algorithms.py`. Run the second from the `gpu/` folder; both launchers use `images/quant.Dockerfile`, which holds vLLM and llm-compressor in separate virtual environments because they pin different versions of PyTorch:

```bash
modal run modal_run.py --script quantize_and_eval.py --gpu 'H100!' --quant  # 37 min of GPU time, about $2.40 plus CPU and memory
modal run modal_run.py --script quantize_and_eval.py --gpu A10 --quant \
    --args "--model unsloth/Llama-3.2-1B-Instruct --quick"                       # a 15-minute trial on a 1B model
```

**Part A, from scratch.** Calibrate SmolLM2-135M on WikiText-2's training split, recording each linear layer's Hessian, its input channels' mean and largest magnitudes, and a sample of its inputs. Implement RTN, GPTQ (with blocks, the Cholesky form and act-order), AWQ (with the α search and shared scales for layers that read the same input) and SmoothQuant. Compare them on one layer by weight and output error, then on the whole model by perplexity at INT4 and INT3, and W8A8 with and without smoothing.

**Part B, a real model.** Quantize Llama 3.1 8B Instruct with llm-compressor to FP8 W8A8, INT8 W8A8 (SmoothQuant then GPTQ), INT4 W4A16 by rounding to nearest, with GPTQ calibrated on an instruction mix and on WikiText, and with AWQ, and NVFP4. Check each checkpoint's perplexity in Transformers against vLLM's, to confirm the engine reads it correctly. Serve each in vLLM and record its weight memory, KV cache capacity, decode step time at batches of 1 and 32, prefill throughput and quantization time. Add an FP8 KV cache to the BF16 and AWQ versions.

**Part C, explain a result.** In Part A, GPTQ without act-order barely beat RTN on the whole model while GPTQ with act-order beat AWQ. Give one reason the column order matters so much for GPTQ.

<details>
<summary>Reference solution</summary>

`ptq_algorithms.py` on an Apple M2 MacBook with 8 GB of memory:

```text
PyTorch 2.15.0, Transformers 5.22.2

1. Calibrated on 16,384 tokens of WikiText-2 train: 210 layers, Hessians up to 1536 x 1536

2. One layer: layers.15.mlp.down_proj, (576, 1536), INT4 group 128, judged on 512 of its calibration inputs
   method                  weight error  output error
   RTN                           11.05%        10.92%
   GPTQ                          13.67%         8.08%
   GPTQ, act-order               14.58%         7.37%
   AWQ (alpha 0.25)              11.50%        10.39%
   GPTQ accepts more weight error to cancel the output error; AWQ leaves the important channels finer.

3. Weight-only quantization of every linear layer, group 128, asymmetric; WikiText-2 test perplexity
   method                                  INT4              INT3
   none (FP32)                            17.10
   rtn                             23.01 (+35%)    148.49 (+768%)
   gptq                            22.22 (+30%)     97.63 (+471%)
   gptq-act-order                  20.09 (+17%)     40.50 (+137%)
      AWQ alpha chosen per layer group: mean 0.33, range 0.00 to 0.75
      AWQ alpha chosen per layer group: mean 0.34, range 0.10 to 0.95
   awq                             20.45 (+20%)     48.19 (+182%)

4. W8A8: INT8 per-channel weights and INT8 activations; WikiText-2 test perplexity
   smoothing                    per-tensor acts    per-token acts
   none                            32.33 (+89%)       17.78 (+4%)
   SmoothQuant alpha 0.5           21.11 (+23%)       17.30 (+1%)
   SmoothQuant alpha 0.8            18.21 (+6%)       17.29 (+1%)
```

*Part A.* GPTQ and AWQ both beat RTN everywhere. On one layer GPTQ gave the lowest output error by accepting a higher weight error, as its objective says it should. AWQ's α varied widely between layers, which is why it is searched per layer rather than fixed. SmoothQuant made per-tensor INT8 activations usable, and with per-token activations both smoothed versions were within about 1% of the original perplexity, against 4% without smoothing.

`quantize_and_eval.py` on Modal with `--gpu H100 --quant`, the summary it prints at the end (the progress lines for each version are left out), with vLLM 0.32.0 and llm-compressor 0.15.0:

```text
NVIDIA H100 80GB HBM3, 610.57.04, 81559 MiB

version                                       weights  KV tokens  decode b1  decode b32   prefill     ppl   GSM8K  flips   ARC-C  flips
BF16                                          15.00Gi    433,008     6.33ms      7.23ms    41,954   6.927   76.8%   0.0%   55.9%   0.0%
FP8 W8A8                                       8.52Gi    485,984     4.30ms      5.44ms    60,533   6.974   76.7%  10.4%   56.1%   3.2%
INT8 W8A8 (SmoothQuant + GPTQ)                 8.52Gi    484,752     4.35ms      5.39ms    63,271   7.027   76.3%  10.2%   56.0%   3.5%
INT4 W4A16 (RTN)                               5.36Gi    512,144     4.05ms      5.05ms    39,455   7.655   66.4%  21.9%   51.0%  10.8%
INT4 W4A16 (GPTQ, perfectblend calibration)    5.36Gi    512,144     4.04ms      4.97ms    39,302   7.479   73.4%  15.1%   53.8%   8.1%
INT4 W4A16 (GPTQ, WikiText calibration)        5.36Gi    512,144     4.09ms      5.04ms    39,153   7.221   66.6%  21.2%   54.7%   8.2%
INT4 W4A16 (AWQ)                               5.47Gi    511,184     4.18ms      5.21ms    38,616   7.298   72.4%  16.2%   54.4%   8.3%
NVFP4 W4A4                                     5.68Gi    508,704     3.83ms      4.92ms    40,169   7.248   70.7%  18.8%   54.3%   7.3%
BF16, FP8 KV cache                            15.00Gi    866,048     6.44ms      6.96ms    41,604   6.979   75.4%  11.4%   55.9%   3.2%
INT4 W4A16 (AWQ), FP8 KV cache                 5.47Gi  1,022,400     4.28ms      5.05ms    38,390   7.349   71.0%  18.4%   54.4%   8.3%
BF16 again                                    15.00Gi    879,952     4.93ms      5.66ms    41,251   6.927   76.9%   0.2%   55.9%   0.0%
BF16 again, at most 32 sequences at a time    15.00Gi    890,656     4.98ms      5.75ms    41,669   6.927   76.5%   2.4%   55.9%   0.2%

weights: GPU memory for the weights; KV tokens: KV cache capacity at gpu_memory_utilization 0.90;
prefill: tokens/s for 16 prompts of 2,048 tokens; flips: questions whose right/wrong outcome differs from BF16.
```

The last two rows are the control versions chapter 4.4 uses, added in a second run with `--args "--only 'BF16 again;BF16 again, at most 32 sequences at a time'"`. Modal ran that one on an H200, which it may substitute for an H100 at the same price, so their memory and speed columns are not comparable with the rest; `--gpu 'H100!'` forbids the substitution.

*Part B.* Every quantized version decoded faster than BF16 at batch 1, by 1.45 to 1.65 times, but the 4-bit versions barely beat FP8, because at batch 1 on an H100 a decode step's fixed costs are a large part of its 4 ms. Prefill sorted the versions by their matmul kernels: the two W8A8 versions ran on 8-bit tensor cores and were about 1.5 times faster than BF16, and every weight-only version was slower. The Transformers cross-check agreed with vLLM within 0.03% for every weight-only checkpoint; NVFP4's mismatch, 7.34 against 6.98 on the check's 8 windows, comes from vLLM running it weight-only on Hopper. The FP8 KV cache doubled the cache, to 866,000 tokens for BF16 and over a million for AWQ.

*Part C.* GPTQ can only push a column's rounding error onto columns that have not been quantized yet. In natural order, the large-input columns that matter most may come late, when few columns remain to absorb their error, and their own error was already distorted by the updates from earlier columns. Act-order quantizes the columns with the largest Hessian diagonal first, while every other column is still free to compensate. SmolLM2's activations have a few very large channels, as chapter 4.2 measured, so the order matters more for it than for a model with evenly spread inputs.

</details>

## Interview angle

- **"How does GPTQ work?"** It quantizes a layer's weights one input column at a time and, after each, updates the remaining columns to cancel the rounding error in the layer's output, using the inverse of the Hessian H = 2X^T X from calibration inputs. Lazy batch updates over blocks of 128 columns and a Cholesky formulation make it fast: OPT-175B took about four hours on one A100.
- **"GPTQ or AWQ?"** Both produce INT4 W4A16 checkpoints with group-128 scales, served by the same kernels, such as Marlin. GPTQ reconstructs weights with second-order error feedback and is often slightly more accurate; AWQ only scales channels by activation statistics and searches a clipping range, is faster to run, and depends less on the calibration set. Measure both on the model and tasks you care about. In this chapter's lab, on Llama 3.1 8B with the same calibration data, they were within a point of each other on GSM8K, 73.4% and 72.4%, while GPTQ calibrated on WikiText fell to 66.6%: the calibration data mattered more than the algorithm.
- **"What does SmoothQuant do, and what is alpha?"** It divides each activation channel by s_j and multiplies the matching weight channel by s_j, which leaves the product unchanged but moves the outliers' range from the activations, which are hard to quantize, into the weights, which are easy. Alpha sets how much moves: s_j = max|X_j|^α / max|W_j|^(1-α), with 0.5 typical and up to 0.9 for models with harder activations.
- **"Why do QuaRot and SpinQuant rotate the model?"** An orthogonal rotation leaves each matmul's result unchanged but spreads an outlier channel's energy over all channels, so activations, weights and KV cache become easy to quantize to 4 bits. QuaRot uses random Hadamard matrices; SpinQuant learns the rotations.
- **"What does an FP8 KV cache buy you?"** It halves the bytes of every cached token, so the same memory holds twice as many tokens, which means longer contexts or larger batches, and it halves the cache traffic of each decode step. In vLLM it is one setting, `kv_cache_dtype="fp8"`; calibrated scales are safer than the default of 1.0.

## Check yourself

<details>
<summary>GPTQ's quantized weights are further from the original weights than round-to-nearest's. Why is that not a problem?</summary>

GPTQ minimizes the error of the layer's output on the calibration inputs, not the error of the weights. It deliberately moves weights not yet quantized to cancel the output error of those already rounded, which increases the weight error and decreases the output error, and the output is what the next layer sees.

</details>

<details>
<summary>AWQ multiplies weight channels by s and divides activations by s. Where does the division go at run time?</summary>

It is folded into the operation that produces the activations: the weights of the preceding RMSNorm for the query, key, value, gate and up projections, the value projection for the output projection, and the up projection for the down projection. Layers that share an input must share s for this to work. With grouped-query attention, as in Llama 3, the value projection has fewer outputs than the output projection has inputs, because each key-value head serves several query heads, so AWQ implementations leave the output projection unscaled.

</details>

<details>
<summary>With SmoothQuant at α = 1, the activations are perfectly flat. Why is that not the best setting?</summary>

All of the outliers' range then lands on the weights: the weight columns for the outlier channels are multiplied by a large factor, and each output channel's weight scale is set by them, so the other weights in that row lose precision. The best α balances the two difficulties, which is why it is searched or chosen per model.

</details>

<details>
<summary>How many bits per weight does llama.cpp's Q4_K use, and where do the extra half-bit come from?</summary>

4.5 bits. Each weight has a 4-bit code; each block of 32 weights has a 6-bit scale and a 6-bit minimum, 12 bits per 32 weights; and each super-block of 256 weights has two FP16 values, 32 bits per 256 weights. That is 4 + 12/32 + 32/256 = 4.5.

</details>

<details>
<summary>A team wants W4A4 on Hopper GPUs. Why would rotations help, and why might they still not get a speedup?</summary>

At 4-bit activations, outliers make per-token scales useless, and rotations such as QuaRot's Hadamard transforms spread them out so that 4-bit activations keep the model's quality. But Hopper's tensor cores have no 4-bit floating-point or INT4 inputs, so W4A4 would have to be computed in 8 or 16 bits, and the online rotations add work. On Blackwell, whose tensor cores take FP4, W4A4 formats such as NVFP4 run natively.

</details>

<details>
<summary>Two GPTQ checkpoints of the same model differ only in calibration data. The one calibrated on Wikipedia has the lower WikiText perplexity. Which should a math tutoring product serve?</summary>

Neither choice follows from that perplexity. GPTQ fits the layers to the calibration inputs, so each checkpoint looks best on text like its own calibration set, and WikiText perplexity favours the Wikipedia-calibrated one by construction. In the lab, that version matched rounding to nearest on GSM8K while the one calibrated on a mix containing math problems lost only 3.4 points. Calibrate on data like the product's traffic, here math problems and tutoring dialogue, and choose by an evaluation on held-out tasks of that kind.

</details>

## Further reading

- [GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers](https://arxiv.org/abs/2210.17323), by Frantar and others.
- [AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration](https://arxiv.org/abs/2306.00978), by Lin and others.
- [SmoothQuant: Accurate and Efficient Post-Training Quantization for Large Language Models](https://arxiv.org/abs/2211.10438), by Xiao and others.
- [QuaRot: Outlier-Free 4-Bit Inference in Rotated LLMs](https://arxiv.org/abs/2404.00456) and [SpinQuant: LLM Quantization with Learned Rotations](https://arxiv.org/abs/2405.16406).
- llama.cpp's [k-quants pull request](https://github.com/ggml-org/llama.cpp/pull/1684) and the block definitions in [ggml-common.h](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-common.h).
- [llm-compressor](https://github.com/vllm-project/llm-compressor), whose examples folder has the recipes used in the lab, and NVIDIA's [Model Optimizer](https://github.com/NVIDIA/Model-Optimizer).
- vLLM's [quantized KV cache](https://docs.vllm.ai/en/latest/features/quantization/quantized_kvcache/) documentation.
