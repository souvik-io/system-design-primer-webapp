# GPUs and accelerators

The hardware under a model decides how large a model you can serve, how fast one user gets tokens, how many users one machine can carry, and what each token costs. This chapter covers the parts of a GPU or other accelerator that matter for serving, how to read the numbers vendors publish, and how to choose hardware. If prefill and decode are new terms, read [how LLM inference works](/learn/llm-inference) first.

The running example is Llama 3.1 70B, a model with 70 billion parameters stored in BF16 (16-bit floating point, 2 bytes per number). Its shape comes from Table 3 of the Llama 3 paper: 80 layers, a model dimension of 8,192, 64 attention heads, and 8 key/value heads. Each head therefore has dimension 8,192 ÷ 64 = 128 ([Llama 3 paper](https://arxiv.org/html/2407.21783)). Product figures are as of October 2026, and each table names its sources.

## What a GPU is good at

A graphics processing unit (GPU) runs the same arithmetic on many numbers at once. NVIDIA's H100 SXM, the data-center GPU this chapter uses most, has 132 streaming multiprocessors (SMs). Each SM has 128 FP32 CUDA cores and four fourth-generation Tensor Cores, so the chip has 16,896 CUDA cores and 528 Tensor Cores ([Hopper architecture article](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/)).

A Tensor Core performs matrix multiply-accumulate operations, multiplying blocks of two matrices and adding the result to a third. Serving a transformer is mostly this work. Each parameter takes part in one multiplication and one addition per token, or 2 floating-point operations (FLOPs). For the 70B model, one token costs 140 GFLOP.

A GPU is fast only with enough independent work, such as many tokens or requests, to keep its Tensor Cores busy. Arithmetic is also only half the story, since every multiplication needs weights from memory.

## GPU memory

The memory that matters most is high-bandwidth memory (HBM), a stack of DRAM chips beside the GPU die, linked by a very wide bus. The H100 SXM has 80 GB of HBM3 ([Hopper article](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/)), read at 3.35 TB/s ([H100 page](https://www.nvidia.com/en-us/data-center/h100/)). The H200 keeps the same Tensor Core figures and raises memory to 141 GB of HBM3e at 4.8 TB/s ([H200 page](https://www.nvidia.com/en-us/data-center/h200/)).

On-chip memory is far smaller and faster to reach. The H100 has a 50 MB L2 cache, and each SM has up to 228 KB of shared memory ([Hopper article](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/)). Across 132 SMs, shared memory totals about 30 MB, so the chip holds roughly 80 MB on chip, about one thousandth of its HBM. Reusing data on chip avoids trips to HBM. FlashAttention, for example, tiles attention so that it reads and writes HBM less often ([arXiv 2205.14135](https://arxiv.org/abs/2205.14135)).

Host memory, the system DRAM attached to the CPU, is the third level, reached over PCIe. NVIDIA lists the H100's PCIe Gen5 link at 128 GB/s in total, or 64 GB/s each way ([Hopper article](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/)). That is about 50 times slower than HBM (3,350 ÷ 64 ≈ 52). Weights or cache that spill into host memory slow every step that reads them.

```diagram
title: The H100's memory. Bandwidth drops as the pool gets bigger.
[gpu:box] GPU die\n132 SMs, 50 MB L2 @ 0,0.5
[hbm:store] HBM3, on package\n80 GB @ 2,0
[host:store] Host memory\nin the server @ 2,1.5
gpu -> hbm : 3.35 TB/s
gpu <-> host : PCIe, 64 GB/s each way
```

The table gives the NVIDIA numbers this chapter uses, each with its source.

| GPU | Launch | Memory | Bandwidth | Dense BF16 TFLOPS (sparse) | NVLink per GPU | Sources |
|---|---|---|---|---|---|---|
| A100 80 GB SXM | Announced May 14, 2020 | 80 GB HBM2e | 2,039 GB/s | 312 (624) | 600 GB/s | [A100 page](https://www.nvidia.com/en-us/data-center/a100/), [Ampere article](https://developer.nvidia.com/blog/nvidia-ampere-architecture-in-depth/) |
| H100 SXM | Announced March 2022, available from Q3 2022 | 80 GB HBM3 | 3.35 TB/s | 989 (1,979) | 900 GB/s | [H100 page](https://www.nvidia.com/en-us/data-center/h100/), [2022 announcement](https://nvidianews.nvidia.com/news/nvidia-announces-hopper-architecture-the-next-generation-of-accelerated-computing) |
| H200 SXM | Announced Nov 13, 2023, available from Q2 2024 | 141 GB HBM3e | 4.8 TB/s | 989 (1,979) | 900 GB/s | [H200 page](https://www.nvidia.com/en-us/data-center/h200/), [2023 announcement](https://nvidianews.nvidia.com/news/nvidia-supercharges-hopper-the-worlds-leading-ai-computing-platform) |
| B200 (per GPU) | Announced March 18, 2024 | 180 GB HBM3e | 8 TB/s | 2,250 (4,500) | 1.8 TB/s | [DGX B200 page](https://www.nvidia.com/en-us/data-center/dgx-b200/), [HGX page](https://www.nvidia.com/en-us/data-center/hgx/), [2024 announcement](https://nvidianews.nvidia.com/news/nvidia-blackwell-platform-arrives-to-power-a-new-era-of-computing) |

The figures in parentheses assume 2:4 sparsity, the label NVIDIA's pages use, so each dense figure is half the sparse one. The H100 page prints only the sparse 1,979 teraFLOPS, and 989 is half of it. The Hopper article's 2022 preliminary table rounded dense BF16 to 1,000, and the H200 page still carries a "preliminary specifications" footnote. The B200 pages print system totals, so the per-GPU values divide them by eight: 1,440 GB ÷ 8 = 180 GB, 64 TB/s ÷ 8 = 8 TB/s, and the HGX page's 36 PFLOPS of BF16 with sparsity ÷ 8 = 4.5 PFLOPS per GPU, or 2.25 PFLOPS dense.

## Compute versus memory bandwidth

Two numbers decide how long a step takes: how much arithmetic it does and how many bytes it reads. Their ratio is the **arithmetic intensity**, in FLOPs per byte.

The **roofline model** caps a workload at the lower of two lines: peak compute, or memory bandwidth times arithmetic intensity. As a formula, attainable performance = min(peak compute, bandwidth × intensity) ([Wikipedia's roofline article](https://en.wikipedia.org/wiki/Roofline_model), which summarizes Williams, Waterman and Patterson's 2009 paper). The point where the lines meet is the **ridge point**. Below it, a workload is **memory-bound**, and bandwidth sets its speed. Above it, the workload is **compute-bound**.

For the H100 SXM, dense BF16 peak is 989 teraFLOPS and bandwidth is 3.35 TB/s. The ridge point is 989 × 10^12 ÷ 3.35 × 10^12 ≈ 295 FLOPs per byte.

**Decode.** Each decode step reads all 140 GB of weights once and does 140 GFLOP for each sequence in the batch. For a batch of B sequences, the intensity is B × 140 GFLOP ÷ 140 GB = B FLOPs per byte, because the two FLOPs and two bytes per parameter cancel. On the H100:

- At batch 1, the intensity is 1 FLOP per byte. The roofline caps the chip at 3.35 TFLOP/s, which is 0.34% of its 989 TFLOP/s peak.
- Ignoring the KV cache, decode reaches the ridge point at a batch of about 295 sequences.

The KV cache changes the picture. Each sequence also reads its own cache: 2,000 × 327,680 bytes ≈ 655 MB per sequence at 2,000 tokens. The intensity becomes B × 140 ÷ (140 + 0.655 × B), which is 49 at batch 64 and approaches 140 ÷ 0.655 ≈ 214 as B grows. That is below the ridge point of 295, so one H100 at peak compute stays memory-bound at every batch size for this model at 2,000-token contexts. A kernel that reaches only half of peak has an effective ridge point near 148, so large batches would then be compute-bound.

This sketch computes those numbers:

```python
# Roofline numbers for one H100 SXM, using the dense BF16 peak and HBM bandwidth.
PEAK_FLOPS = 989e12       # FLOP/s, dense BF16 (the spec page's 1,979 assumes sparsity)
BANDWIDTH = 3.35e12       # bytes/s, HBM3
PARAMS = 70e9             # Llama 3.1 70B
WEIGHT_BYTES = 2          # BF16
KV_PER_TOKEN = 327_680    # bytes of KV cache per token (running example)
CONTEXT = 2_000           # tokens per sequence


def ridge_point() -> float:
    """FLOPs per byte where a step stops being memory-bound."""
    return PEAK_FLOPS / BANDWIDTH


def intensity(batch: int, context: int = 0) -> float:
    """FLOPs per byte read during one decode step."""
    flops = batch * 2 * PARAMS                  # 2 FLOPs per parameter per token
    weight_bytes = PARAMS * WEIGHT_BYTES        # all weights are read once per step
    kv_bytes = batch * context * KV_PER_TOKEN   # each sequence reads its own cache
    return flops / (weight_bytes + kv_bytes)


def attainable(i: float) -> float:
    """Roofline: the lower of the compute ceiling and bandwidth times intensity."""
    return min(PEAK_FLOPS, BANDWIDTH * i)


if __name__ == "__main__":
    print(f"ridge point: {ridge_point():.1f} FLOPs per byte")
    for b in (1, 295, 296):
        i = intensity(b)
        kind = "compute" if i >= ridge_point() else "memory"
        print(f"batch {b:3d}: {i:6.1f} FLOPs/byte, {kind}-bound, "
              f"{attainable(i) / 1e12:6.1f} TFLOP/s")
    print(f"batch 64, 2,000-token contexts: {intensity(64, CONTEXT):.1f}")
    print(f"limit as batch grows, 2,000-token contexts: "
          f"{2 * PARAMS / (CONTEXT * KV_PER_TOKEN):.1f}")
```

```text
ridge point: 295.2 FLOPs per byte
batch   1:    1.0 FLOPs/byte, memory-bound,    3.4 TFLOP/s
batch 295:  295.0 FLOPs/byte, memory-bound,  988.2 TFLOP/s
batch 296:  296.0 FLOPs/byte, compute-bound,  989.0 TFLOP/s
batch 64, 2,000-token contexts: 49.2
limit as batch grows, 2,000-token contexts: 213.6
```

**Prefill.** Prefill sends the whole prompt through in one pass, so the weights are read once for all its tokens. A 2,000-token prompt needs 280 TFLOP for that one read, an intensity of 2,000. On four H100s at dense peak (3,956 TFLOPS), the prompt takes about 71 ms, or about 142 ms at half of peak. This is the split [the inference chapter](/learn/llm-inference#prefill-and-decode) describes: prefill is limited by arithmetic, and decode by memory.

Two consequences follow:

- **Decode speed follows bandwidth.** The H200's 4.8 TB/s is 1.43 times the H100's 3.35 TB/s, so at the same GPU count the decode ceiling rises by that factor.
- **Prefill speed follows dense FLOPS.** The H200 has the same Tensor Core figures as the H100, so its prefill is no faster.

## Number formats and quantization

A number format sets how many bits store each value. The exponent bits set the range, and the mantissa (fraction) bits set the precision.

| Format | Bytes | Sign / exponent / mantissa bits | Source |
|---|---|---|---|
| FP32 | 4 | 1 / 8 / 23 | Derived from the BF16 row |
| BF16 | 2 | 1 / 8 / 7 | [Google, bfloat16](https://docs.cloud.google.com/tpu/docs/bfloat16) |
| FP16 | 2 | 1 / 5 / 10 | [Wikipedia, binary16](https://en.wikipedia.org/wiki/Half-precision_floating-point_format) |
| FP8 E4M3 | 1 | 1 / 4 / 3 | [FP8 formats paper](https://arxiv.org/abs/2209.05433) |
| FP8 E5M2 | 1 | 1 / 5 / 2 | [FP8 formats paper](https://arxiv.org/abs/2209.05433) |
| INT8 | 1 | integer, 256 values | arithmetic |
| INT4 | 0.5 | integer, 16 values | arithmetic |

Google's bfloat16 description gives BF16 one sign bit, eight exponent bits and seven mantissa bits, and says it "has the same exponent size as FP32," so FP32 has 8 exponent bits and 23 mantissa bits. Google's blog gives the reason for the trade: "neural networks are far more sensitive to the size of the exponent than that of the mantissa." The next sketch rounds FP32 values to BF16 and prints the largest value each format holds:

```python
# Number formats: how BF16 keeps FP32's range, and how much precision it gives up.
import struct


def to_bf16(x: float) -> float:
    """Round an FP32 value to BF16 by keeping the top 16 bits (round to nearest even)."""
    bits = struct.unpack(">I", struct.pack(">f", x))[0]
    bits += 0x7FFF + ((bits >> 16) & 1)     # rounding; NaN and Inf are not handled
    kept = (bits >> 16) << 16               # drop the low 16 mantissa bits
    return struct.unpack(">f", struct.pack(">I", kept))[0]


def max_finite(exp_bits: int, man_bits: int) -> float:
    """Largest finite value of an IEEE-style format with these field widths."""
    bias = 2 ** (exp_bits - 1) - 1
    top = 2 ** exp_bits - 2 - bias          # the all-ones exponent is reserved
    return (2 - 2.0 ** -man_bits) * 2.0 ** top


if __name__ == "__main__":
    for x in (3.14159, 0.1, 1000.7):
        print(f"{x:>9} stored as BF16: {to_bf16(x):.6g}")
    print(f"FP16 largest value: {max_finite(5, 10):.1f}")
    print(f"BF16 largest value: {max_finite(8, 7):.4e}")
    print(f"FP32 largest value: {max_finite(8, 23):.4e}")
```

```text
  3.14159 stored as BF16: 3.14062
      0.1 stored as BF16: 0.100098
   1000.7 stored as BF16: 1000
FP16 largest value: 65504.0
BF16 largest value: 3.3895e+38
FP32 largest value: 3.4028e+38
```

BF16 keeps only about two decimal digits, but its largest value, 3.39 × 10^38, is close to FP32's 3.40 × 10^38. FP16 tops out at 65,504.

**Quantization** stores each weight in fewer bits. The 70B weights take 140 GB in BF16, 70 GB in FP8 or INT8, and 35 GB in INT4. Decode reads every weight each step, so halving the bytes halves the time of a memory-bound step. Quantizing also rounds each weight to the nearest level the format can express. The next sketch quantizes 100,000 random weights with one scale, then adds one outlier, 0.9, which widens the grid for every weight:

```python
# What quantization does to weights: fewer levels, and one outlier stretches the grid.
import random


def quantize_dequantize(values: list[float], bits: int) -> list[float]:
    """Symmetric round-to-nearest quantization with one scale for the whole tensor."""
    qmax = 2 ** (bits - 1) - 1                    # 127 for INT8, 7 for INT4
    scale = max(abs(v) for v in values) / qmax    # the largest value sets the grid
    return [max(-qmax, min(qmax, round(v / scale))) * scale for v in values]


def mean_abs_error(values: list[float], bits: int) -> float:
    restored = quantize_dequantize(values, bits)
    return sum(abs(a - b) for a, b in zip(values, restored)) / len(values)


if __name__ == "__main__":
    random.seed(0)
    weights = [random.gauss(0.0, 0.02) for _ in range(100_000)]   # typical spread
    with_outlier = weights + [0.9]                                # one large value
    for bits in (8, 4):
        print(f"INT{bits} ({2 ** bits - 1} symmetric levels): "
              f"error {mean_abs_error(weights, bits):.6f}, "
              f"with one outlier {mean_abs_error(with_outlier, bits):.6f}")
```

```text
INT8 (255 symmetric levels): error 0.000167, with one outlier 0.001776
INT4 (15 symmetric levels): error 0.003032, with one outlier 0.015937
```

The outlier makes the error about 10 times larger at INT8 and about 5 times larger at INT4. Published results matter more than a toy:

- GPTQ quantized a 175-billion-parameter GPT model to 3 or 4 bits per weight in about four GPU hours, with "negligible accuracy degradation relative to the uncompressed baseline." Its end-to-end speedups over FP16 were about 3.25 times on an A100 and 4.5 times on an A6000 ([arXiv 2210.17323](https://arxiv.org/abs/2210.17323)).
- LLM.int8() keeps the few outlier feature dimensions of large models in 16 bits and runs over 99.9% of values in 8 bits. The authors report halved inference memory with no performance degradation up to 175 billion parameters ([arXiv 2208.07339](https://arxiv.org/abs/2208.07339)).
- A 2024 study found "non-negligible degradation" in low-bit Llama 3 models, especially at ultra-low bit widths ([arXiv 2404.14047](https://arxiv.org/abs/2404.14047)). Test on your own tasks.

Sparsity is a separate speedup. NVIDIA's pages print a sparse peak, double the dense peak, for 2:4 sparse weights, where two of every four values are zero. Keeping accuracy needs pruning and retraining. In NVIDIA's own benchmark of a sparse ResNeXt-101 model on an A100, the gain was up to 20% at large batch sizes, far short of 2 times ([NVIDIA's sparsity article](https://developer.nvidia.com/blog/accelerating-inference-with-sparsity-using-ampere-and-tensorrt/)), so treat the sparse peak as a ceiling. The A100 has no FP8 row, since FP8 arrived with the H100.

## Connecting GPUs

Several GPUs need links between them. The table gives each link's speed per GPU.

| Link | Connects | Speed | Source |
|---|---|---|---|
| PCIe Gen5 (H100) | GPU to host memory | 128 GB/s total, 64 GB/s each way | Hopper article |
| NVLink, A100 | GPUs in one node | 600 GB/s | [A100 page](https://www.nvidia.com/en-us/data-center/a100/) |
| NVLink, H100 and H200 | GPUs in one node | 900 GB/s total, 450 GB/s each way | [H100 page](https://www.nvidia.com/en-us/data-center/h100/), [H200 page](https://www.nvidia.com/en-us/data-center/h200/) |
| NVLink, B200 | GPUs in one node | 1.8 TB/s | [HGX page](https://www.nvidia.com/en-us/data-center/hgx/) |
| InfiniBand adapter | Nodes | up to 400 Gb/s per port (50 GB/s) | [DGX H100 guide](https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html) |
| NVLink domain, GB200 NVL72 | 72 GPUs in one rack | 130 TB/s aggregate | [GB200 NVL72 page](https://www.nvidia.com/en-us/data-center/gb200-nvl72/) |

A DGX H100 node has eight H100 GPUs, 640 GB of GPU memory, and 900 GB/s of GPU-to-GPU bandwidth. Each GPU has its own InfiniBand adapter, up to 400 Gb/s or 50 GB/s, so NVLink inside the node is 18 times faster than the network path out (900 ÷ 50).

```diagram
title: Inside a node, GPUs use NVLink. Between nodes, they use InfiniBand.
[n1:box] Node 1\n8 H100 GPUs\nNVLink 900 GB/s @ 0,0
[n2:box] Node 2\n8 H100 GPUs\nNVLink 900 GB/s @ 2,0
[ib:store] InfiniBand fabric\n400 Gb/s per GPU @ 1,1.5
n1 -> ib : 50 GB/s
ib -> n2 : 50 GB/s
```

Take the 70B model split across four GPUs with tensor parallelism (described below), serving 64 sequences in one step. Assume, as a layout assumption, two combines of activations per layer. Each combine moves 64 tokens × 8,192 values × 2 bytes = 1 MiB. A ring all-reduce moves 2 × (4 − 1) ÷ 4 = 1.5 times that per GPU, about 1.57 MB. Over 80 layers with two combines each, that is about 252 MB per GPU per step. NVLink, at 450 GB/s each way, moves it in about 0.56 ms, roughly 4% of the 13.6 ms step. PCIe, at 64 GB/s each way, takes about 3.9 ms, roughly 29%. These figures ignore latency and overlap, but they show why tensor parallelism belongs inside a node.

## Splitting a model across GPUs

A model too big for one GPU must be spread over several. Replicas copy the whole model, and the other three split it.

**Replicas** run complete copies, each on its own GPUs, and send each request to one copy. Replicas in different groups never talk while a token is generated, so they add throughput cheaply, as long as the whole model and its cache fit in one copy.

**Tensor parallelism (TP)** splits the matrices inside each layer across GPUs, which Megatron-LM calls an "intra-layer model parallel approach" ([arXiv 1909.08053](https://arxiv.org/abs/1909.08053)). Each GPU reads a share of every layer, so weight traffic per GPU falls roughly with the GPU count. The cost is one combine per layer, which needs fast links. vLLM recommends it for a model too large for one GPU but small enough for one node, and warns that multi-node tensor parallelism "requires fast internode communication, preferably through high-speed network adapters such as InfiniBand" ([vLLM docs](https://docs.vllm.ai/en/latest/serving/parallelism_scaling/)).

**Pipeline parallelism (PP)** gives each GPU a run of consecutive layers. GPipe pipelines "different sub-sequences of layers on separate accelerators" ([arXiv 1811.06965](https://arxiv.org/abs/1811.06965)). Only one activation tensor crosses each stage boundary per token, far less traffic than a combine per layer. The cost is latency: with one sequence, the stages take turns. vLLM suggests it across nodes, and for GPUs without NVLink.

**Expert parallelism (EP)** applies to mixture-of-experts models, which store many expert networks but send each token through only a few. The Switch Transformer paper calls the result "a sparsely-activated model ... with outrageous numbers of parameters but a constant computational cost" ([arXiv 2101.03961](https://arxiv.org/abs/2101.03961)). Experts can sit on different GPUs, and vLLM's documentation describes this layout for MoE layers.

| Strategy | What it splits | Traffic between GPUs | Main cost |
|---|---|---|---|
| Replicas | Nothing, since each copy is whole | None while generating | Each copy needs the whole model |
| Tensor | Matrices inside each layer | One combine per layer | Needs fast links |
| Pipeline | Consecutive layers | One activation hop per stage | Stages take turns for one sequence |
| Expert | Experts in MoE layers | Tokens sent to their expert | Only for MoE models |

For the running example, four H100s with tensor parallelism hold 35 GB of weights each, leaving 288 − 140 = 148 GB of cache across the group, about 450,000 tokens. Llama 3.1 405B is harder. Its BF16 weights take 405 × 10^9 × 2 = 810 GB, more than one 8-GPU node holds (640 GB). Following vLLM's multi-node rule, use a tensor size of 8 inside each node and a pipeline size of 2 across two nodes. Each of the 16 GPUs then holds 50.6 GB of weights and has about 21 GB left for cache (0.9 × 80 − 50.6 ≈ 21.4).

## Other accelerators

Google's TPUs, AWS's Trainium and Inferentia chips, and AMD's Instinct line are the other families a team meets. Each has its own software stack, and the serving engine has to run on it.

| Chip | Status | Memory per chip | Bandwidth per chip | Compute per chip | Chip-to-chip link | Source |
|---|---|---|---|---|---|---|
| TPU v6e (Trillium) | Generally available Dec 16, 2024 | 32 GB HBM | 1,638 GB/s | 918 TFLOPS BF16, 1,836 TOPS INT8 | 800 GB/s ICI, pods of 256 | [TPU v6e docs](https://docs.cloud.google.com/tpu/docs/v6e), [release notes](https://docs.cloud.google.com/tpu/docs/release-notes) |
| TPU7x (Ironwood) | Generally available Mar 31, 2026 | 192 GiB HBM | 7,380 GB/s | 2,307 TFLOPS BF16, 4,614 TFLOPS FP8 | 1,200 GB/s ICI, pods of 9,216 | [TPU7x docs](https://docs.cloud.google.com/tpu/docs/tpu7x), [release notes](https://docs.cloud.google.com/tpu/docs/release-notes) |
| AWS Trainium2 | Generally available Dec 3, 2024 | 96 GB | about 2.9 TB/s (46 TB/s ÷ 16 chips) | up to 20.8 PFLOPS FP8 per 16-chip instance | NeuronLink, not quantified | [AWS press release](https://press.aboutamazon.com/2024/12/aws-trainium2-instances-now-generally-available), [Trn2 page](https://aws.amazon.com/ec2/instance-types/trn2/) |
| AWS Trainium3 | No date on AWS's page | 144 GB HBM3e | 4.9 TB/s | not given per chip | NeuronLink, not quantified | [Trainium page](https://aws.amazon.com/ai/machine-learning/trainium/) |
| AWS Inferentia2 | Generally available Apr 13, 2023 | 32 GB HBM | about 0.8 TB/s (9.8 TB/s ÷ 12 chips) | up to 2.3 PFLOPS per 12-chip instance, precision not stated | not printed | [Inf2 page](https://aws.amazon.com/ec2/instance-types/inf2/), [What's New](https://aws.amazon.com/about-aws/whats-new/2023/04/amazon-ec2-inf2-instances-generative-ai-generally-available) |
| AMD Instinct MI300X | Launched Dec 6, 2023 | 192 GB HBM3 | 5.3 TB/s | 1,307 TFLOPS BF16 (2,615 with sparsity) | 8 Infinity Fabric links, 128 GB/s each | [AMD MI300X page](https://www.amd.com/en/products/accelerators/instinct/mi300/mi300x.html) |

Google's documentation says TPUs multiply BF16 values by default ([TPU bfloat16 docs](https://docs.cloud.google.com/tpu/docs/bfloat16)). AWS's Trn2 instance combines 16 Trainium2 chips over NeuronLink. AMD's MI300X has more memory and bandwidth per chip than an H100, so a 70B model in BF16 fits on one with room for cache (192 − 140 = 52 GB before the reserve). AMD's newer MI355X has 288 GiB of memory, according to AMD's ROCm documentation.

## Choosing hardware

Start from the model and the load, then compare each candidate on four numbers:

1. **Memory per GPU** sets how many GPUs one replica needs: the weights, plus cache for your users and context, plus about 10% for activations and runtime.
2. **Bandwidth per GPU** sets the decode ceiling, since a memory-bound step takes bytes read ÷ bandwidth.
3. **Dense FLOPS at your precision** set prefill speed and the batch size where compute becomes the limit.
4. **Interconnect** decides how far tensor parallelism can stretch.

Then price the result. Cost per token is GPUs × price per GPU-hour, divided by tokens per hour. The price below is an assumption: $3.00 per H100-hour. Real prices vary widely by provider and commitment.

```python
# Decode step time and cost for the running example: 70B in BF16 on 4 x H100.
GPUS = 4
BANDWIDTH = 3.35e12                  # bytes/s per H100
PRICE_PER_GPU_HOUR = 3.00            # an assumption, not a quote
WEIGHTS = 140e9                      # 70B parameters x 2 bytes
KV_64_USERS = 64 * 2_000 * 327_680   # 64 sequences of 2,000 tokens each


def step_seconds(bytes_read: float) -> float:
    """Decode is memory-bound, so a step takes bytes read / aggregate bandwidth."""
    return bytes_read / (GPUS * BANDWIDTH)


def dollars_per_million_tokens(batch: int, bytes_read: float) -> float:
    tokens_per_second = batch / step_seconds(bytes_read)
    cost_per_second = GPUS * PRICE_PER_GPU_HOUR / 3600
    return cost_per_second / tokens_per_second * 1e6


if __name__ == "__main__":
    for batch, bytes_read in ((1, WEIGHTS), (64, WEIGHTS + KV_64_USERS)):
        ms = step_seconds(bytes_read) * 1000
        tps = batch / step_seconds(bytes_read)
        cost = dollars_per_million_tokens(batch, bytes_read)
        print(f"batch {batch:2d}: step {ms:5.2f} ms, {tps:7.1f} tokens/s, "
              f"${cost:.2f} per million tokens")
```

```text
batch  1: step 10.45 ms,    95.7 tokens/s, $34.83 per million tokens
batch 64: step 13.58 ms,  4713.6 tokens/s, $0.71 per million tokens
```

One user, at about 96 tokens a second, pays about $35 per million tokens. Sixty-four users in the same step each get about 74 tokens a second, about 4,700 in total, and pay $0.71 per million tokens. The weights are read once per step however many users share them, so the cost per token falls by about 49 times. These are ceilings at full utilization. They ignore prefill, idle time and scheduling overhead, so a real service costs more. At 30% average utilization, $0.71 becomes about $2.37.

The same reasoning compares generations. The H200 raises the decode ceiling by 1.43 times over the H100 at the same GPU count, with no prefill gain. Its 141 GB lets two GPUs hold the BF16 weights with about 114 GB of cache left (2 × 141 × 0.9 − 140). A two-GPU H200 replica reaches about 69 tokens a second at batch 1, against 96 for the four-GPU H100 replica, or about 34 per GPU against 24. Price per GPU-hour decides which wins.

As of October 2026, NVIDIA's HGX page lists B200 and B300 as shipping and Vera Rubin as ramping into full production ([NVIDIA HGX](https://www.nvidia.com/en-us/data-center/hgx/)). The tables above will age. Check current spec pages before buying, and compare TFLOPS only at the same precision and sparsity.

## Check yourself

<details>
<summary>How fast can one user decode from an 8B model in BF16 on one H100 at batch 1, using the bandwidth ceiling?</summary>

The weights take 8 × 10^9 × 2 bytes = 16 GB, and each token reads all of them. A step takes at least 16 GB ÷ 3,350 GB/s ≈ 4.8 ms, so the ceiling is about 209 tokens a second. Real speed is lower.

</details>

<details>
<summary>A team wants 70B weights in FP8 on one GPU, with a BF16 cache and a 10% reserve. Compare an H100 (80 GB) and an H200 (141 GB) for cache room.</summary>

The weights take 70 GB. On an H100, 80 − 70 − 8 = 2 GB remains, about 6,000 tokens, which is effectively no room. On an H200, 141 − 70 − 14.1 ≈ 57 GB remains, about 174,000 tokens, or roughly 87 sequences of 2,000 tokens. Two H100s would leave about 37 GB per GPU for cache.

</details>

<details>
<summary>A service moved from H100 to H200 and expects about 43% faster decoding, but sees 5%. Name two causes to check.</summary>

The 43% assumes decode is memory-bound and that the extra bandwidth is used. Check how much time goes to prefill, which has the same dense BF16 figure on both chips, and whether the new memory is used. If the cache pool or batch limit still reflects 80 GB, batches stay small and scheduling or host overhead can dominate.

</details>

<details>
<summary>You serve Llama 3.1 405B across two 8-GPU H100 nodes linked by InfiniBand. Choose the tensor and pipeline sizes and explain why.</summary>

Use a tensor size of 8 inside each node and a pipeline size of 2 across them. Tensor parallelism combines results after every layer, so it belongs on NVLink. Pipeline parallelism sends one activation hop per stage boundary per token, which InfiniBand can carry. The 810 GB of weights over 16 GPUs leave about 21 GB per GPU for cache.

</details>

<details>
<summary>You quantize to INT4. Throughput doubles, but a quality eval drops 3 points. What do you check before shipping?</summary>

Check per-task results, because an average can hide a drop in one task. Find which layers or outlier features are hurt, since LLM.int8() keeps outliers in 16 bits for this reason. Try INT8 or FP8 first, since the Llama 3 study reports most of its loss at ultra-low bit widths. Then measure on your own eval set.

</details>

<details>
<summary>Four H100s at $3.00 per GPU-hour serve 64 users in one step, about 74 tokens a second each. What is the cost per million tokens at full utilization and at 30%? Why does one user cost so much more?</summary>

At full utilization it is $0.71 per million tokens, and at 30% about $2.37. One user at about 96 tokens a second pays for the same weight reads for each token: $34.83 per million tokens at the ceiling, or about $116 at 30%. The batch spreads those reads across everyone in it.

</details>

## Further reading

- [NVIDIA H100](https://www.nvidia.com/en-us/data-center/h100/), [H200](https://www.nvidia.com/en-us/data-center/h200/) and [A100](https://www.nvidia.com/en-us/data-center/a100/) spec pages: the spec tables and sparsity footnotes. The H200 page marks its figures preliminary.
- [NVIDIA Hopper architecture](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/) and [Ampere architecture](https://developer.nvidia.com/blog/nvidia-ampere-architecture-in-depth/) articles: SM counts, cache sizes, link speeds, the A100 date and the 2:4 sparsity definition.
- [NVIDIA's Hopper](https://nvidianews.nvidia.com/news/nvidia-announces-hopper-architecture-the-next-generation-of-accelerated-computing), [H200](https://nvidianews.nvidia.com/news/nvidia-supercharges-hopper-the-worlds-leading-ai-computing-platform) and [Blackwell](https://nvidianews.nvidia.com/news/nvidia-blackwell-platform-arrives-to-power-a-new-era-of-computing) announcements: launch dates.
- [NVIDIA HGX](https://www.nvidia.com/en-us/data-center/hgx/), [DGX B200](https://www.nvidia.com/en-us/data-center/dgx-b200/), [DGX H100 guide](https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html) and [GB200 NVL72](https://www.nvidia.com/en-us/data-center/gb200-nvl72/): node totals, link speeds and the 72-GPU NVLink domain.
- [NVIDIA's 2:4 sparsity article](https://developer.nvidia.com/blog/accelerating-inference-with-sparsity-using-ampere-and-tensorrt/): the pattern, the retraining need and a measured gain well below 2 times.
- [TPU v6e](https://docs.cloud.google.com/tpu/docs/v6e), [TPU7x](https://docs.cloud.google.com/tpu/docs/tpu7x) docs, [release notes](https://docs.cloud.google.com/tpu/docs/release-notes) and the [Ironwood post](https://cloud.google.com/blog/products/compute/ironwood-tpus-and-new-axion-based-vms-for-your-ai-workloads): per-chip specs and availability dates.
- [Google's bfloat16 docs](https://docs.cloud.google.com/tpu/docs/bfloat16) and [bfloat16 post](https://cloud.google.com/blog/products/ai-machine-learning/bfloat16-the-secret-to-high-performance-on-cloud-tpus): the BF16 layout and why exponent bits matter more.
- [AWS Trainium2 availability](https://press.aboutamazon.com/2024/12/aws-trainium2-instances-now-generally-available), [Trainium](https://aws.amazon.com/ai/machine-learning/trainium/), [Trn2](https://aws.amazon.com/ec2/instance-types/trn2/) and [Inf2](https://aws.amazon.com/ec2/instance-types/inf2/): AWS chip specs and dates.
- [AMD Instinct MI300X](https://www.amd.com/en/products/accelerators/instinct/mi300/mi300x.html) and [AMD ROCm GPU architecture specs](https://rocm.docs.amd.com/en/latest/reference/gpu-arch-specs.html): AMD's specifications and memory sizes.
- [Roofline model](https://en.wikipedia.org/wiki/Roofline_model) and [half-precision format](https://en.wikipedia.org/wiki/Half-precision_floating-point_format) (Wikipedia): secondary summaries of the roofline formula and the FP16 layout.
- [vLLM parallelism and scaling](https://docs.vllm.ai/en/latest/serving/parallelism_scaling/): tensor and pipeline sizes and the multi-node rule.
- [Megatron-LM](https://arxiv.org/abs/1909.08053), [GPipe](https://arxiv.org/abs/1811.06965) and [Switch Transformer](https://arxiv.org/abs/2101.03961): the splitting strategies in the original papers.
- [GPTQ](https://arxiv.org/abs/2210.17323), [LLM.int8()](https://arxiv.org/abs/2208.07339), [a low-bit Llama 3 study](https://arxiv.org/abs/2404.14047) and [FP8 formats](https://arxiv.org/abs/2209.05433): quantization results and the FP8 layouts.
- [FlashAttention](https://arxiv.org/abs/2205.14135): tiling to cut trips between HBM and on-chip SRAM.
- [The Llama 3 paper](https://arxiv.org/html/2407.21783): Table 3, the model shapes behind the running example.
