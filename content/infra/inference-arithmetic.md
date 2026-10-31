# The arithmetic of inference

Before touching a profiler, an inference engineer should be able to say roughly how fast a model will run: how long one decode step takes, how many users fit, how long a long prompt makes the first token wait, and what a million tokens cost. These estimates take a few lines of arithmetic, they are usually within a factor of two of reality, and when a measurement disagrees with them the gap tells you where to look.

This chapter builds that arithmetic into a small model of one decode step and one prefill for Llama 3.1 8B, checks the roofline idea against a real machine, and ends with a lab that measures a serving engine against the model.

Prerequisites: [compute versus memory bandwidth](/learn/gpus-for-ai#compute-versus-memory-bandwidth) for the roofline itself, [where the bytes go](/learn/transformer-as-workload#where-the-bytes-go) for the per-operation view, and [the numbers in models and machines](/learn/models-and-machines#the-three-machines).

## The step-time model

The roofline says an operation takes at least the longer of two times: its FLOPs divided by peak compute, and its bytes divided by memory bandwidth. A model step is a sequence of operations, so its ideal time is the sum over operations:

step time ≈ sum over operations of max(FLOPs ÷ peak, bytes ÷ bandwidth)

Applying the roofline to the whole step at once can mislead, because one part can be compute-bound while another is memory-bound. For a decode step, two groups are enough:

- **Weight matmuls.** FLOPs = batch × 2 × 7.50B. Bytes = the 15.0 GB of matmul weights, read once whatever the batch.
- **Attention.** FLOPs = batch × context × 524,288. Bytes = batch × context × 131,072, since each sequence reads its own KV cache.

Element-wise operations are small enough to leave out of a first estimate, and the [previous chapter's table](/learn/transformer-as-workload#where-the-bytes-go) shows they are under 2% of a decode step.

## Measuring your own roofline

The roofline's two numbers, peak FLOPs and bandwidth, come from spec sheets, and real hardware reaches only part of them. Measure them first. The probe below times a large copy (pure bandwidth) and a large square matmul (near-peak compute), then sweeps the batch size of a decode-shaped matmul: one 4,096 × 14,336 weight, Llama 3.1 8B's up projection, multiplied by B token vectors. For each B it prints the measured time next to the roofline's prediction from the two measured numbers.

```python
# roofline_probe.py: measure your machine's bandwidth and matmul peak, then sweep the batch size of a
# decode-shaped matmul (one weight matrix, B token vectors) and compare the times with the roofline.
import statistics
import time

import torch

dev = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
dtype = {"cuda": torch.bfloat16, "mps": torch.float16, "cpu": torch.float32}[dev]
elem = torch.tensor([], dtype=dtype).element_size()


def sync():
    if dev == "cuda":
        torch.cuda.synchronize()
    elif dev == "mps":
        torch.mps.synchronize()


def timed(fn, reps=20):
    """Median wall time of fn in seconds, after warmup, with the device synchronized."""
    for _ in range(3):
        fn()
    sync()
    times = []
    for _ in range(reps):
        t0 = time.perf_counter()
        fn()
        sync()
        times.append(time.perf_counter() - t0)
    return statistics.median(times)


# 1. Bandwidth: copy 256 MB. A copy reads and writes every byte.
src = torch.empty(256 * 2**20 // elem, dtype=dtype, device=dev)
dst = torch.empty_like(src)
bandwidth = 2 * src.numel() * elem / timed(lambda: dst.copy_(src))

# 2. Compute: a large square matmul has plenty of reuse, so it runs near the arithmetic peak.
n = 4096
a = torch.randn(n, n, dtype=dtype, device=dev)
b = torch.randn(n, n, dtype=dtype, device=dev)
peak = 2 * n**3 / timed(lambda: a @ b, reps=10)
ridge = peak / bandwidth
print(f"{dev}, {dtype}: copy bandwidth {bandwidth / 1e9:.0f} GB/s, matmul {peak / 1e12:.2f} TFLOP/s, "
      f"ridge {ridge:.0f} FLOPs/byte")

# 3. A decode-shaped matmul: one 4096 x 14336 weight (Llama 3.1 8B's up projection), B tokens.
d_in, d_out = 4096, 14336
w = torch.randn(d_out, d_in, dtype=dtype, device=dev)
print(f"{'batch':>6} {'time ms':>8} {'model ms':>8} {'TFLOP/s':>8} {'GB/s':>6} {'FLOPs/byte':>10}")
for batch in (1, 4, 16, 64, 128, 256, 512, 1024, 2048):
    x = torch.randn(batch, d_in, dtype=dtype, device=dev)
    t = timed(lambda: x @ w.T)
    flops = 2 * batch * d_in * d_out
    bytes_moved = (d_out * d_in + batch * d_in + batch * d_out) * elem
    model = max(flops / peak, bytes_moved / bandwidth)  # the roofline's prediction
    print(f"{batch:6d} {t * 1e3:8.3f} {model * 1e3:8.3f} {flops / t / 1e12:8.2f} "
          f"{bytes_moved / t / 1e9:6.0f} {flops / bytes_moved:10.1f}")
```

Output on an Apple M2 laptop (8-core GPU, FP16 through PyTorch's MPS backend):

```text
mps, torch.float16: copy bandwidth 84 GB/s, matmul 2.53 TFLOP/s, ridge 30 FLOPs/byte
 batch  time ms model ms  TFLOP/s   GB/s FLOPs/byte
     1    1.527    1.404     0.08     77        1.0
     4    1.585    1.405     0.30     74        4.0
    16    2.174    1.411     0.86     54       15.9
    64    3.328    2.970     2.26     36       62.7
   128    6.156    5.940     2.44     20      123.1
   256   11.912   11.879     2.52     11      237.0
   512   23.612   23.759     2.55      6      441.1
  1024   48.197   47.518     2.50      3      774.9
  2048   95.353   95.036     2.52      2     1246.6
```

How to read it:

- **The copy reached 84 of the M2's 100 GB/s.** Measured bandwidth below the spec sheet is normal; use the measured number in estimates.
- **From batch 1 to 4, the time barely moves.** The matmul is memory-bound: the time is the time to read the 117 MB weight, and the extra tokens ride along for free. Four tokens cost what one costs.
- **From batch 128 up, time doubles with batch.** The matmul is compute-bound at about 2.5 TFLOP/s, and the model matches the measurement to within 4%.
- **Near the ridge point, the model is optimistic.** At batch 16 (intensity 16, ridge 30) the model predicts 1.41 ms and the measurement is 2.17 ms. Real kernels do not switch sharply from one limit to the other; the curve rounds the corner, and the GEMM library may pick a tile shape that suits neither regime well. Treat the roofline as a lower bound on time, tight far from the ridge and loose near it.

Run the probe on any machine you rent. On an H100 the shape is the same, with the corner at a far larger batch.

## A decode step, part by part

The next script applies the step-time model to Llama 3.1 8B in BF16 on an H100 and on an L4, at 2,000-token and 32,000-token contexts. It caps the batch at what memory holds after the weights and a 10% reserve, and reports the step time, how it splits between weights and KV cache, and the speed per user and in total. It also estimates prefill and the cost per token, which later sections use.

```python
# step_model.py: a roofline model of one decode step and one prefill for Llama 3.1 8B in BF16.
# The weight matmuls and the attention reads are timed separately, because batching shares the
# weights across sequences but every sequence reads its own KV cache.
GPUS = {  # name: (memory bytes, bandwidth bytes/s, dense BF16 FLOP/s)
    "H100 SXM": (80e9, 3.35e12, 989e12),
    "L4": (24e9, 300e9, 121e12),
}
MATMUL_PARAMS = 7.50e9         # weights one token multiplies through (model_stats.py)
WEIGHT_BYTES = 2 * MATMUL_PARAMS
KV_PER_TOKEN = 131_072         # bytes: 2 (K, V) x 32 layers x 8 KV heads x 128 x 2 bytes
ATTN_FLOPS_PER_CTX = 4 * 32 * 32 * 128   # 2 matmuls x 2 FLOPs x layers x query heads x head dim
RESERVE = 0.10                 # memory kept back for activations and the runtime


def decode_step(gpu, batch, context):
    """Seconds for one decode step: each part takes the longer of its compute and memory time."""
    _, bw, peak = GPUS[gpu]
    weights = max(batch * 2 * MATMUL_PARAMS / peak, WEIGHT_BYTES / bw)
    attention = max(batch * context * ATTN_FLOPS_PER_CTX / peak, batch * context * KV_PER_TOKEN / bw)
    return weights, attention


def max_batch(gpu, context):
    mem = GPUS[gpu][0]
    return int((mem * (1 - RESERVE) - 16.06e9) // (context * KV_PER_TOKEN))  # all 8.03B stored


def prefill_seconds(gpu, prompt, mfu=0.5):
    """Prefill is compute-bound; causal attention scores about half of the prompt x prompt square."""
    flops = 2 * prompt * MATMUL_PARAMS + ATTN_FLOPS_PER_CTX * prompt * prompt / 2
    return flops / (GPUS[gpu][2] * mfu)


if __name__ == "__main__":
    for gpu in GPUS:
        for context in (2_000, 32_000):
            cap = max_batch(gpu, context)
            print(f"{gpu}, {context:,}-token contexts (memory fits batch {cap}):")
            for batch in (1, 8, 32, 64, 128, 256):
                if batch > cap:
                    break
                w, a = decode_step(gpu, batch, context)
                step = w + a
                print(f"  batch {batch:3d}: step {step * 1e3:6.2f} ms (weights {w / step:4.0%}, "
                      f"KV {a / step:4.0%}), {1 / step:5.0f} tok/s per user, {batch / step:6.0f} total")
    for gpu in GPUS:
        for prompt in (1_000, 8_000, 32_000):
            print(f"{gpu}: prefill {prompt:6,} tokens at 50% MFU = {prefill_seconds(gpu, prompt) * 1e3:7.1f} ms")
    # Price per million tokens on one H100 at an assumed $3.00 an hour.
    hour = 3.00
    prefill_tok_s = 8_000 / prefill_seconds("H100 SXM", 8_000)
    w, a = decode_step("H100 SXM", 64, 2_000)
    decode_tok_s = 64 / (w + a)
    for name, rate in (("input (prefill, 8K prompts)", prefill_tok_s), ("output (decode, batch 64)", decode_tok_s)):
        print(f"{name}: {rate:9,.0f} tok/s -> ${hour / 3600 / rate * 1e6:.3f} per million tokens")
```

```text
H100 SXM, 2,000-token contexts (memory fits batch 213):
  batch   1: step   4.56 ms (weights  98%, KV   2%),   219 tok/s per user,    219 total
  batch   8: step   5.10 ms (weights  88%, KV  12%),   196 tok/s per user,   1568 total
  batch  32: step   6.98 ms (weights  64%, KV  36%),   143 tok/s per user,   4583 total
  batch  64: step   9.49 ms (weights  47%, KV  53%),   105 tok/s per user,   6747 total
  batch 128: step  14.49 ms (weights  31%, KV  69%),    69 tok/s per user,   8831 total
H100 SXM, 32,000-token contexts (memory fits batch 13):
  batch   1: step   5.73 ms (weights  78%, KV  22%),   175 tok/s per user,    175 total
  batch   8: step  14.49 ms (weights  31%, KV  69%),    69 tok/s per user,    552 total
L4, 2,000-token contexts (memory fits batch 21):
  batch   1: step  50.87 ms (weights  98%, KV   2%),    20 tok/s per user,     20 total
  batch   8: step  56.99 ms (weights  88%, KV  12%),    18 tok/s per user,    140 total
L4, 32,000-token contexts (memory fits batch 1):
  batch   1: step  63.98 ms (weights  78%, KV  22%),    16 tok/s per user,     16 total
H100 SXM: prefill  1,000 tokens at 50% MFU =    30.9 ms
H100 SXM: prefill  8,000 tokens at 50% MFU =   276.6 ms
H100 SXM: prefill 32,000 tokens at 50% MFU =  1513.5 ms
L4: prefill  1,000 tokens at 50% MFU =   252.3 ms
L4: prefill  8,000 tokens at 50% MFU =  2260.8 ms
L4: prefill 32,000 tokens at 50% MFU = 12370.8 ms
input (prefill, 8K prompts):    28,923 tok/s -> $0.029 per million tokens
output (decode, batch 64):     6,747 tok/s -> $0.124 per million tokens
```

Four lessons come out of the decode rows.

1. **One user wastes the GPU.** At batch 1 on the H100, the step is 4.56 ms, almost all of it reading weights. The 219 tokens a second is a ceiling no engine can beat at this precision, and the GPU's arithmetic is idle over 99% of the time.
2. **Batching is nearly free until the KV cache takes over.** Going from batch 1 to 8 multiplies total throughput by 7 and costs each user 11% of their speed. By batch 64, the KV cache reads exceed the weight reads, and from there each added user slows everyone down.
3. **Memory, not compute, caps throughput here.** The weight matmuls would turn compute-bound at batch 295 (the H100's ridge point), but memory runs out at batch 213 for 2,000-token contexts. At 32,000-token contexts, only 13 sequences fit. For this model on this GPU, decode is memory-bound at every batch it can run; the way to more throughput is fewer bytes (FP8 weights, FP8 KV cache) or more memory, not more FLOPS.
4. **The L4 is about 11 times slower per step.** Its bandwidth is 300 GB/s against 3,350, and decode follows bandwidth. It is still useful for labs, and for low-traffic models where the H100 would sit idle.

The explorer below runs the same model for six chips and three Llama sizes. Things to try:

- **Slide the batch from 1 to 512 on the H100 with the 8B model.** The weight matmuls move right along the slanted roof, while attention stays put at 4 FLOPs per byte. Memory runs out at batch 213, well before the weights reach the ridge point.
- **Switch the KV cache to FP8.** Attention's intensity doubles to 8 and the batch memory allows roughly doubles, which is often the cheapest throughput gain available.
- **Switch the weights to FP8.** The roof rises (FP8 Tensor Cores double the peak), the weight bytes halve, and the batch-1 step gets almost twice as fast.
- **Choose Prefill and a 2,000-token prompt.** Both points jump far to the right, past the ridge: prefill is the compute-bound phase. Raise the prompt to 128K and watch attention's share grow.
- **Choose the Apple M2 and the 1B model.** A laptop's ridge point is about 30, so it turns compute-bound at small batches, as the probe above measured.

```widget
roofline-explorer
```

## Latency against throughput

Every decode step emits one token for each sequence in the batch, so the inter-token latency (ITL) a user sees is the step time, and total throughput is batch ÷ step time. Raising the batch raises throughput and ITL together. The product decides where to stop.

A latency target turns that into a maximum batch. Suppose users need at least 50 tokens a second, an ITL of 20 ms. From the model, at 2,000-token contexts on an H100 the step reaches 20 ms at about batch 200 (4.5 ms of weights plus 200 × 2,000 × 131,072 bytes ÷ 3.35 TB/s ≈ 15.6 ms of cache). The batch the target allows, and the batch memory allows (213), happen to be close here. With longer contexts, memory runs out first; with a stricter target, latency does.

This is the trade-off continuous batching manages step by step ([batching requests](/learn/inference-engines#batching-requests)), and it is why a serving benchmark must report throughput at a stated latency, never alone.

## Prefill and time to first token

Prefill is compute-bound, so its time is FLOPs ÷ (peak × MFU), where MFU (model FLOPs utilization) is the share of peak a real kernel sustains. The script assumes 50%, a deliberately round guess; measure your own in the lab.

Time to first token = time waiting in the queue + prefill of the prompt + the first decode step.

The prefill rows show two things:

- **Prompt length grows the cost faster than linearly.** A 32,000-token prompt takes 1.5 s on an H100, about 49 times the 1,000-token prompt's 31 ms for 32 times the tokens. The extra is attention, whose score matrix grows with the square of the prompt.
- **One long prefill can stall everyone.** While a GPU runs a 1.5 s prefill, the sequences in its decode batch get no tokens, unless the engine splits the prompt into chunks and interleaves them with decode steps. That is [chunked prefill](/learn/inference-engines#chunked-prefill), and the size of the chunk trades the new request's TTFT against everyone else's ITL.

## Cost per input and output token

At an assumed $3.00 per H100-hour (the same assumption as [GPUs and accelerators](/learn/gpus-for-ai#choosing-hardware)), the model gives about $0.03 per million input tokens (prefill of 8K-token prompts) and $0.12 per million output tokens (decode at batch 64), at full utilization. Output costs about 4 times as much as input, because a prefill reads the weights once for thousands of tokens and a decode step reads them once for each token of the batch.

This is also why many hosted model APIs price output tokens several times higher than input tokens: the hardware cost really is asymmetric. Real prices also cover idle capacity, redundancy and margin. At 30% average utilization, every figure above roughly triples.

## Efficiency: MBU and MFU

Two ratios say how close a real system comes to the model:

- **Model FLOPs utilization (MFU)**, from the PaLM paper: achieved FLOP/s ÷ peak FLOP/s, counting only the FLOPs the model needs. Use it for compute-bound work: prefill and training.
- **Model bandwidth utilization (MBU)**, from Databricks' inference performance guide: achieved bytes/s ÷ peak bandwidth, where achieved bytes/s = (weight bytes + KV cache bytes read per step) ÷ step time. Use it for decode.

An example with made-up numbers: if an engine serves Llama 3.1 8B at batch 1 on an H100 at 150 tokens a second, each 6.7 ms step reads about 15.0 GB plus a little cache, so MBU = 15.0 GB × 150 ÷ 3.35 TB/s ≈ 67%. The model's 219 tokens a second is MBU 100%. Measured MBU tells you how much there is left to gain, and the lab measures a real one.

## Why real numbers fall short

When a measurement lands below the model, these are the usual reasons, roughly in order of how often they matter for decode:

- **Achievable bandwidth is below the spec.** The probe's copy reached 84% of the M2's spec. Expect a similar gap on data-center GPUs.
- **Overhead between kernels.** A decode step launches hundreds of small kernels. At batch 1 on a fast GPU, the CPU work of launching them and running the Python scheduler can rival the GPU time. CUDA graphs and compiled models exist to remove it (Part 3).
- **Kernel efficiency on awkward shapes.** A matmul with 1 to 16 rows, or attention over very short or very uneven contexts, reaches a smaller share of the hardware's limits than the large shapes on spec sheets.
- **Work the model leaves out.** Sampling, the LM head's large output (128,256 values per token), detokenization, streaming, and the element-wise operations.
- **The workload is not the one modeled.** Real batches mix prefill and decode, contexts vary, and the batch is rarely full.

## Lab: measure a serving engine against the model

**Tier: [any] for part A, [1 GPU] for part B.**

**Part A, your machine's roofline.** Run `roofline_probe.py` above on your laptop and, during your next GPU rental, on an L4 or H100. Record both with `bench/record.py`. Plot measured time against batch on log-log axes with the model's line on top, and mark the ridge point. Done when you can say, for each machine, at what batch the decode-shaped matmul stops being free, and where the model and measurement disagree most.

**Part B, a real engine.** On one rented GPU, serve Llama 3.1 8B in BF16 with vLLM and measure decode step time at batch 1, 8, 32 and 64, with 2,000-token prompts. Then:

1. compute the measured tokens a second per user and in total;
2. compute MBU at each batch, counting weight bytes and the KV cache read;
3. put measured and modeled step times side by side and explain the gap at batch 1 and at batch 64.

The trick for isolating decode: time a run that generates 1 token and a run that generates 257 tokens from the same prompts. The difference is 256 decode steps, without the prefill.

Done when the table and a paragraph of explanation are in `notes/` and the raw results are in `results.jsonl`.

<details>
<summary>Reference solution</summary>

Part A has no single right answer; your laptop's numbers are the answer. Check that the flat region at small batches matches your copy bandwidth, and that the large-batch region matches your square-matmul peak.

For part B, this script drives vLLM's latency benchmark. It needs `pip install vllm` on the GPU machine and access to the model (accept Meta's licence on Hugging Face, or use a mirror such as `unsloth/Meta-Llama-3.1-8B-Instruct`). Command flags change between vLLM releases, so check `vllm bench latency --help` on yours.

```python
# decode_sweep.py: decode step time per batch size, from two vLLM latency runs per batch.
import json
import subprocess
import tempfile

MODEL = "unsloth/Meta-Llama-3.1-8B-Instruct"
PROMPT, STEPS = 2000, 256
WEIGHT_BYTES, KV_PER_TOKEN, BANDWIDTH = 15.0e9, 131_072, 3.35e12   # H100 SXM; use 300e9 on an L4


def avg_latency(batch: int, output_len: int) -> float:
    with tempfile.NamedTemporaryFile(suffix=".json") as f:
        subprocess.run(["vllm", "bench", "latency", "--model", MODEL, "--batch-size", str(batch),
                        "--input-len", str(PROMPT), "--output-len", str(output_len),
                        "--num-iters-warmup", "3", "--num-iters", "10",
                        "--max-model-len", "4096", "--output-json", f.name], check=True)
        return json.load(open(f.name))["avg_latency"]


for batch in (1, 8, 32, 64):
    step = (avg_latency(batch, STEPS + 1) - avg_latency(batch, 1)) / STEPS
    context = PROMPT + STEPS / 2                   # average context during the 256 steps
    bytes_per_step = WEIGHT_BYTES + batch * context * KV_PER_TOKEN
    mbu = bytes_per_step / step / BANDWIDTH
    print(f"batch {batch:3d}: step {step * 1e3:6.2f} ms, {1 / step:5.0f} tok/s per user, "
          f"{batch / step:6.0f} total, MBU {mbu:4.0%}")
```

This chapter's author has not run part B on an H100, so there is no reference output to copy; your numbers are the result. What to expect, and how to explain it:

- **Measured steps are slower than the model at every batch.** MBU somewhere between half and most of the bandwidth is typical for a well-tuned engine at moderate batch sizes. An MBU above 100% means the byte count is wrong, for example a KV cache in FP8 when you assumed BF16.
- **At batch 1 the gap is mostly overhead.** The weights are read in a few milliseconds, so fixed costs per step (sampling, scheduling, kernel launches not covered by CUDA graphs) are a large share. Running once with `--enforce-eager`, which turns off CUDA graphs, shows how much of the step they save.
- **At batch 64 the gap is mostly attention efficiency.** The KV cache reads are over half the bytes, and paged attention kernels reading scattered blocks rarely reach full bandwidth.
- **The shape should match the model.** Total throughput rising steeply from batch 1 to 8, then more slowly, and per-user speed falling once the cache dominates. If the shape differs, look for a configuration limit: `max_num_seqs` or `max_num_batched_tokens` capping the real batch, or `gpu_memory_utilization` leaving too little cache.

</details>

## Interview angle

- **"Estimate decode speed for model X on GPU Y."** Weight bytes ÷ bandwidth for batch 1; add KV bytes per sequence for larger batches; check memory caps the batch; say what you ignored. For a 70B model in FP8 on 8 H100s with tensor parallelism: 70 GB ÷ (8 × 3.35 TB/s) ≈ 2.6 ms per step, a ceiling near 380 tokens a second for one user, before the all-reduce cost between GPUs.
- **"Why does output cost more than input?"** Prefill reads the weights once for the whole prompt and is compute-bound; decode reads them once per step for a batch of one token per sequence and is memory-bound. Per token, decode moves far more bytes.
- **"We doubled the batch size and throughput rose only 30%. Why?"** The KV cache now dominates the step's bytes, and batching shares weights but not cache. Check the split between weight and cache bytes, then reduce cache bytes (FP8 KV cache, shorter contexts, prefix sharing) or accept the latency.
- **"Is this workload compute-bound or memory-bound?"** Compute its arithmetic intensity and compare it with the hardware's ridge point, operation by operation. Decode matmuls at small batch, decode attention at any batch, and element-wise operations are memory-bound. Prefill matmuls are compute-bound.

## Check yourself

<details>
<summary>Using the bandwidth ceiling, how many tokens a second can one user get from Llama 3.1 8B in FP8 on one H100?</summary>

The matmul weights take about 7.5 GB in FP8. 7.5 GB ÷ 3.35 TB/s ≈ 2.24 ms per step, so about 450 tokens a second, twice the BF16 ceiling, before overheads and KV cache reads.

</details>

<details>
<summary>On the M2 probe, batch 1 and batch 4 took almost the same time. Why, and at roughly what batch does that stop?</summary>

The matmul is memory-bound: its time is the time to read the weight matrix, and extra token vectors add almost no bytes. It stops near the ridge point, where the intensity (about equal to the batch for this shape) reaches peak FLOPs ÷ bandwidth, about 30 on the M2. The measurement shows the time already rising at batch 16 and clearly compute-bound by 128.

</details>

<details>
<summary>On one H100 with 2,000-token contexts, the weight matmuls never become compute-bound for Llama 3.1 8B in BF16. Why not?</summary>

They would at batch 295, the ridge point. Memory runs out first: after the 16 GB of weights and a 10% reserve, about 56 GB of cache holds 213 sequences of 2,000 tokens. The KV cache, not compute, caps the batch.

</details>

<details>
<summary>A user complains that a 30,000-token prompt makes everyone else's stream stutter. What is happening, and what fixes it?</summary>

The prompt's prefill takes over a second on an H100, and if the engine runs it as one piece, the decode batch gets no steps meanwhile, so every stream pauses. Chunked prefill splits the prompt into pieces that run alongside decode steps, trading a slightly later first token for the long prompt against smooth ITL for everyone else. Separating prefill and decode onto different GPUs is the larger-scale fix.

</details>

<details>
<summary>Compute MBU: an engine runs Llama 3.1 8B in BF16 on an H100 at batch 32, contexts averaging 2,000 tokens, and measures a 10 ms step.</summary>

Bytes per step = 15.0 GB of weights + 32 × 2,000 × 131,072 ≈ 8.4 GB of cache = 23.4 GB. Achieved bandwidth = 23.4 GB ÷ 0.010 s = 2.34 TB/s. MBU = 2.34 ÷ 3.35 ≈ 70%.

</details>

<details>
<summary>Why is the step-time model a sum of per-operation rooflines rather than one roofline for the whole step?</summary>

Different parts of a step sit on different sides of the ridge point. At large batch, the weight matmuls may be compute-bound while attention, at an intensity of 4, is memory-bound. One roofline on the totals would average them and predict a shorter step than either part allows. Summing per-part times keeps each part on its own limit.

</details>

## Further reading

- [LLM inference performance engineering: best practices](https://www.databricks.com/blog/llm-inference-performance-engineering-best-practices) (Databricks): defines MBU, and walks through latency, throughput and batching trade-offs with measurements.
- [PaLM](https://arxiv.org/abs/2204.02311): section on training efficiency, where model FLOPs utilization is defined.
- [Roofline: an insightful visual performance model](https://dl.acm.org/doi/10.1145/1498765.1498785) (Williams, Waterman and Patterson, 2009): the original roofline paper.
- [Making deep learning go brrrr from first principles](https://horace.io/brrr_intro.html) by Horace He: compute, bandwidth and overhead, with the overhead case that explains batch-1 gaps.
- [Transformer inference arithmetic](https://kipp.ly/transformer-inference-arithmetic/) by Kipply Chen: the same back-of-envelope approach for larger models and multi-GPU setups.
- [How to scale your model](https://jax-ml.github.io/scaling-book/) (Google DeepMind): rooflines and inference for TPUs and GPUs, in depth.
- [vLLM benchmarking CLI](https://docs.vllm.ai/en/latest/contributing/benchmarks.html): `vllm bench latency`, `throughput` and `serve`, used in this chapter's lab and in Part 8.
