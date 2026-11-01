# The arithmetic of inference

Before touching a profiler, an inference engineer should be able to say roughly how fast a model will run: how long one decode step takes, how many users fit, how long a long prompt makes the first token wait, and what a million tokens cost. These estimates take a few lines of arithmetic, they are usually within a factor of two of reality, and when a measurement disagrees with them the gap tells you where to look.

This chapter builds that arithmetic into a small model of one decode step and one prefill for Llama 3.1 8B, checks the roofline idea against a real machine, and ends with a lab that measures a serving engine against the model.

Before this chapter, read [compute versus memory bandwidth](/learn/gpus-for-ai#compute-versus-memory-bandwidth) for the roofline itself, [where the bytes go](/learn/transformer-as-workload#where-the-bytes-go) for the per-operation view, and [the numbers in models and machines](/learn/models-and-machines#the-three-machines).

## The step-time model

The roofline says an operation takes at least the longer of two times: its FLOPs divided by peak compute, and its bytes divided by memory bandwidth. A model step is a sequence of operations, so its ideal time is the sum over operations:

step time ≈ sum over operations of max(FLOPs ÷ peak, bytes ÷ bandwidth)

Applying the roofline to the whole step at once can mislead, because one part can be compute-bound while another is memory-bound. For a decode step, two groups are enough:

- **Weight matmuls.** They cost batch × 2 × 7.50B FLOPs and read the 15.0 GB of matmul weights once, whatever the batch.
- **Attention.** It costs batch × context × 524,288 FLOPs and reads batch × context × 131,072 bytes, since each sequence reads its own KV cache.

Element-wise operations are small enough to leave out of a first estimate, and the [previous chapter's table](/learn/transformer-as-workload#where-the-bytes-go) shows they are under 2% of a decode step.

## Measuring your own roofline

The roofline's two numbers, peak FLOPs and bandwidth, come from spec sheets, and real hardware reaches only part of them. Measure them first. The probe below times a large copy (pure bandwidth) and a large square matmul (near-peak compute), then sweeps the batch size of a decode-shaped matmul: one 4,096 × 14,336 weight, Llama 3.1 8B's up projection, multiplied by B token vectors. For each B it prints the measured time next to the roofline's prediction from the two measured numbers. You can download it as [roofline_probe.py](/labs/infra/roofline_probe.py); it runs on Apple silicon, on an NVIDIA GPU or on a CPU.

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

This is the output on an Apple M2 laptop with the 8-core GPU, running FP16 through PyTorch's MPS backend:

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

Four things stand out in the output:

- **The copy reached 84 of the M2's 100 GB/s.** Measured bandwidth below the spec sheet is normal; use the measured number in estimates.
- **From batch 1 to 4, the time barely moves.** The matmul is memory-bound: the time is the time to read the 117 MB weight, and the extra tokens ride along for free. Four tokens cost what one costs.
- **From batch 128 up, time doubles with batch.** The matmul is compute-bound at about 2.5 TFLOP/s, and the model matches the measurement to within 4%.
- **Near the ridge point, the model is optimistic.** At batch 16 (intensity 16, ridge 30) the model predicts 1.41 ms and the measurement is 2.17 ms. Real kernels do not switch sharply from one limit to the other; the curve rounds the corner, and the GEMM library may pick a tile shape that suits neither regime well. Treat the roofline as a lower bound on time, tight far from the ridge and loose near it.

Run the probe on any machine you rent. On an H100 the shape is the same, with the corner at a far larger batch.

## A decode step, part by part

The next script applies the step-time model to Llama 3.1 8B in BF16 on an H100 and on an L4, at 2,000-token and 32,000-token contexts. It caps the batch at what memory holds after the weights and a 10% reserve, and reports the step time, how it splits between weights and KV cache, and the speed per user and in total. It also estimates prefill and the cost per token, which later sections use. The script needs no packages, and you can download it as [step_model.py](/labs/infra/step_model.py) to change the GPU, the model or the context.

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

The explorer below runs the same model for six chips and three Llama sizes. Try these experiments:

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

- **Model FLOPs utilization (MFU)**, defined in the PaLM paper, is achieved FLOP/s ÷ peak FLOP/s, counting only the FLOPs the model needs. Use it for compute-bound work such as prefill and training.
- **Model bandwidth utilization (MBU)**, defined in Databricks' inference performance guide, is achieved bytes/s ÷ peak bandwidth, where achieved bytes/s = (weight bytes + KV cache bytes read per step) ÷ step time. Use it for decode.

For example, the lab below measured vLLM serving Llama 3.1 8B at batch 1 on an H100 at 152 tokens a second. Each 6.56 ms step reads about 15.0 GB of weights plus 0.3 GB of cache, so MBU = 15.3 GB ÷ 6.56 ms ÷ 3.35 TB/s ≈ 69%. The model's 219 tokens a second would be MBU 100%. Measured MBU tells you how much there is left to gain.

## Why real numbers fall short

When a measurement lands below the model, these are the usual reasons, roughly in order of how often they matter for decode:

- **Achievable bandwidth is below the spec.** The probe's copy reached 84% of the M2's spec. Expect a similar gap on data-center GPUs.
- **Overhead between kernels.** A decode step launches hundreds of small kernels. At batch 1 on a fast GPU, the CPU work of launching them and running the Python scheduler can rival the GPU time. CUDA graphs and compiled models exist to remove it ([Part 3](/learn/pytorch-execution)).
- **Kernel efficiency on awkward shapes.** A matmul with 1 to 16 rows, or attention over very short or very uneven contexts, reaches a smaller share of the hardware's limits than the large shapes on spec sheets.
- **Work the model leaves out.** The model ignores sampling, the LM head's large output (128,256 values per token), detokenization, streaming and the element-wise operations.
- **The workload is not the one modeled.** Real batches mix prefill and decode, contexts vary, and the batch is rarely full.

## Lab: measure a serving engine against the model

**Tier: [any] for part A, [1 GPU] for part B.** Part A runs on your own machine, and part B needs one rented NVIDIA GPU.

**Part A, your machine's roofline.** Run `roofline_probe.py` above on your laptop and, during your next GPU rental, on an L4 or H100. Record both with `bench/record.py`. Plot measured time against batch on log-log axes with the model's line on top, and mark the ridge point. Part A is done when you can say, for each machine, at what batch the decode-shaped matmul stops being free, and where the model and measurement disagree most.

**Part B, a real engine.** On one rented GPU, serve Llama 3.1 8B in BF16 with vLLM and measure decode step time at batch 1, 8, 32 and 64, with 2,000-token prompts. Then complete these steps:

1. compute the measured tokens a second per user and in total;
2. compute MBU at each batch, counting weight bytes and the KV cache read;
3. put measured and modeled step times side by side and explain the gap at batch 1 and at batch 64.

To isolate decode, time a run that generates 1 token and a run that generates 257 tokens from the same prompts. The difference is 256 decode steps, without the prefill.

Part B is done when the table and a paragraph of explanation are in `notes/` and the raw results are in `results.jsonl`.

<details>
<summary>Reference solution</summary>

Part A has no single right answer; your laptop's numbers are the answer. Check that the flat region at small batches matches your copy bandwidth, and that the large-batch region matches your square-matmul peak.

For part B, the script [gpu/decode_sweep.py](/labs/infra/gpu/decode_sweep.py) loads the model in vLLM once and times the two runs per batch with vLLM's own `generate`, using the same settings as `vllm bench latency`: random prompt tokens, `ignore_eos` so that every run generates exactly the requested number of tokens, and the median of 10 timed runs. It uses `unsloth/Meta-Llama-3.1-8B-Instruct`, an ungated copy of Meta's weights, and then repeats batches 1 and 8 with `enforce_eager=True`. The heart of it is the subtraction:

```python
def run_seconds(prompts, output_len, warmup=3, iters=10):
    params = SamplingParams(temperature=1.0, top_p=1.0, ignore_eos=True, max_tokens=output_len)
    ...                                            # warm up, then return the median of `iters` timed runs

step = (run_seconds(prompts, STEPS + 1) - run_seconds(prompts, 1)) / STEPS   # STEPS = 256
context = PROMPT + STEPS / 2                       # average context during the 256 steps
bytes_per_step = WEIGHT_BYTES + batch * context * KV_PER_TOKEN
mbu = bytes_per_step / step / BANDWIDTH
```

On Modal it runs with `modal run modal_run.py --script decode_sweep.py --gpu H100 --vllm`. Its output on an H100:

```text
NVIDIA H100 80GB HBM3, vLLM 0.32.0, PyTorch 2.13.0+cu130
unsloth/Meta-Llama-3.1-8B-Instruct, BF16, 2000-token prompts, 256 decode steps timed (median of 10 runs)
Model loaded and ready in 195 s with CUDA graphs and torch.compile, 18 s with enforce_eager

                 batch      step     model   MBU  tok/s per user  tok/s total
default              1   6.56 ms   4.56 ms   69%             152          152
default              8   7.27 ms   5.14 ms   71%             138         1101
default             32   9.67 ms   7.14 ms   74%             103         3310
default             64  12.87 ms   9.81 ms   76%              78         4971
enforce_eager        1  14.90 ms   4.56 ms   31%              67           67
enforce_eager        8  14.69 ms   5.14 ms   35%              68          545
```

The 195 seconds of the first load include downloading the 16 GB of weights, compiling the model with `torch.compile` and capturing its CUDA graphs; the second load found the weights already on disk and compiled nothing. How to read the table:

- **The measured steps are slower than the model at every batch, but the shape matches.** MBU runs from 69% at batch 1 to 76% at batch 64. Chapter 2.1's probe measured 3.0 TB/s, 90% of the spec, as the realistic ceiling for reading this GPU's memory, so vLLM reaches roughly 77 to 85% of what the memory can deliver. Total throughput rises 7.2 times from batch 1 to 8 and 4.5 times more from 8 to 64, while each user's speed falls from 152 to 78 tokens a second as the cache grows to more than half of the bytes read.
- **At batch 1, the gap is a fixed cost per step.** The step took 2.0 ms longer than the model. Reading 15 GB at the probe's 3.0 TB/s would take 5.0 ms, so roughly 1.5 ms of each 6.56 ms step goes to work the model leaves out: sampling, scheduling, the small kernels between the matmuls, and matmuls with one row that read the weights below copy speed.
- **At batch 64, the cache is read efficiently.** From batch 1 to 64, the step grew by 6.31 ms while the bytes read grew by about 17.6 GB of KV cache, an effective 2.8 TB/s, close to the copy ceiling. The gap at batch 64, 3.1 ms, is mostly the same fixed cost as at batch 1, plus the extra rows in every matmul. The lab's contexts were long and all the same length, which suits vLLM's attention kernels; mixed or very short contexts may be read less efficiently.
- **CUDA graphs and compilation more than double the speed at small batch.** With `enforce_eager=True`, which in vLLM 0.32 turns off both, batch 1 took 14.90 ms instead of 6.56 ms, and batch 8 took no longer than batch 1, the signature of a step limited by launching kernels from the CPU rather than by the GPU's work. This is the effect that [chapter 3.1](/learn/pytorch-execution) measures kernel by kernel.
- **If your shape differs, look for a configuration limit.** `max_num_seqs` or `max_num_batched_tokens` can cap the real batch, and `gpu_memory_utilization` can leave too little room for the cache. An MBU above 100% means the byte count is wrong, for example a KV cache in FP8 when you assumed BF16.

</details>

## Interview angle

- **"Estimate decode speed for model X on GPU Y."** For batch 1, divide the weight bytes by the bandwidth. For larger batches, add the KV bytes each sequence reads, check whether memory caps the batch, and say what you ignored. For a 70B model in FP8 on 8 H100s with tensor parallelism, 70 GB ÷ (8 × 3.35 TB/s) ≈ 2.6 ms per step, which gives a ceiling near 380 tokens a second for one user before the all-reduce cost between GPUs.
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

- [LLM inference performance engineering: best practices](https://www.databricks.com/blog/llm-inference-performance-engineering-best-practices) from Databricks defines MBU and walks through latency, throughput and batching trade-offs with measurements.
- [PaLM](https://arxiv.org/abs/2204.02311) defines model FLOPs utilization in its section on training efficiency.
- [Roofline: an insightful visual performance model](https://dl.acm.org/doi/10.1145/1498765.1498785) by Williams, Waterman and Patterson (2009) is the original roofline paper.
- [Making deep learning go brrrr from first principles](https://horace.io/brrr_intro.html) by Horace He covers compute, bandwidth and overhead, and its section on overhead explains the gaps at batch 1.
- [Transformer inference arithmetic](https://kipp.ly/transformer-inference-arithmetic/) by Kipply Chen applies the same back-of-envelope approach to larger models and multi-GPU setups.
- [How to scale your model](https://jax-ml.github.io/scaling-book/) from Google DeepMind covers rooflines and inference for TPUs and GPUs in depth.
- vLLM's [`vllm bench latency` reference](https://docs.vllm.ai/en/latest/cli/bench/latency/) documents the flags this chapter's lab uses, and its [benchmarking CLI guide](https://docs.vllm.ai/en/latest/benchmarking/cli/) covers `vllm bench serve` and the other benchmark commands that Part 8 uses.
