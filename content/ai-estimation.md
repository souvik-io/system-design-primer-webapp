# Estimating AI workloads

A web estimate asks how many requests a second you need and how many bytes they move. An AI estimate adds two questions. Does the model fit in GPU memory, with room left for the requests that run at the same time? And how many tokens a second can those GPUs produce? The answers decide how many GPUs you rent. GPUs are billed by the hour, so the count sets the bill.

This chapter uses the method from [estimation](/learn/estimation#the-method-step-by-step): fix the inputs, work out per-second rates, size the memory, and check the answer a second way. It builds on the [AI numbers in the reference tables](/learn/numbers-to-know#numbers-for-ai-systems). The running example is Llama 3.1 70B, served on NVIDIA H100 and H200 GPUs. Hardware figures come from NVIDIA's spec pages and the papers cited at the end, as checked on 19 October 2026. Prices are assumptions, and you should replace them with the prices you can get.

## The numbers you need

Every estimate starts from a short list of inputs: the model's layout and number format, the GPU's memory, bandwidth and speed, and the traffic. The model and GPU inputs come from published specs. The traffic inputs are assumptions you choose.

Two model terms need defining. **Parameters** are the learned numbers in a model, so "70B" means about 70 billion of them. **KV heads** are the groups of keys and values that each attention layer keeps for every token. Llama 3 has more attention heads than KV heads, because several query heads share one KV head. That design is called grouped-query attention, and it keeps the cache small. The [KV cache](/learn/llm-inference#the-kv-cache) is covered in more depth in the inference chapter.

Table 3 of the Llama 3 paper gives the architecture of the 8B, 70B and 405B models. The Llama 3.1 model card does not list these values, so this chapter takes them from the paper, as the running example does. The table leaves out the head dimension. It equals the model dimension divided by the attention heads: 4,096 ÷ 32 = 128 for the 8B, and the same division gives 128 for the other two sizes.

| Model | Layers | Attention heads | KV heads | Head dimension | Weights in BF16 |
|---|---|---|---|---|---|
| Llama 3.1 8B | 32 | 32 | 8 | 128 | 16 GB |
| Llama 3.1 70B | 80 | 64 | 8 | 128 | 140 GB |
| Llama 3.1 405B | 126 | 128 | 8 | 128 | 810 GB |

The Llama 3.1 models accept 128K tokens of context. This chapter counts 128K as 131,072 tokens (128 × 1,024).

| GPU | Memory | Bandwidth | BF16 math, dense |
|---|---|---|---|
| A100 80 GB | 80 GB HBM2e | 2.04 TB/s | 312 TFLOPS |
| H100 SXM | 80 GB HBM3 | 3.35 TB/s | 989 TFLOPS |
| H200 | 141 GB HBM3e | 4.8 TB/s | 989 TFLOPS |

HBM is the stacked memory that sits beside the GPU chip. Bandwidth is how many bytes a second the GPU can read from it. TFLOPS are trillions of floating-point operations a second. NVIDIA's H100 and H200 pages list BF16 at 1,979 TFLOPS "with sparsity." NVIDIA's developer blog says sparsity doubles throughput, so the dense figure is half of that, about 989. The H200 page marks its figures as preliminary. This chapter writes GB for 10^9 bytes, the way these specs are quoted.

## Memory for the weights

The weights take the parameter count times the bytes each parameter needs:

```text
weight bytes = parameters × bytes per parameter
```

BF16 (16-bit floating point) uses 2 bytes. FP8 uses 1 byte, and NVIDIA's developer blog says FP8 halves the data storage of FP16 or BF16. A 4-bit format uses half a byte. So 70 billion parameters take 140 GB in BF16, 70 GB in FP8 and 35 GB in 4-bit. Lower precision saves memory and can cost quality. [GPUs for AI](/learn/gpus-for-ai#number-formats-and-quantization) covers that trade-off.

The name says 70B, but the model card's file metadata reports 71 billion parameters. At 2 bytes each, that is about 142 GB. This chapter keeps the round 140 GB, which is 1.4% lower.

The weights are only part of what must fit. Whatever they leave is the room for activations (temporary values during a forward pass), runtime overhead and the KV cache. This chapter reserves 10% of each GPU, so 90% is usable. vLLM's documented default is 92%, so the 10% used here is slightly conservative and keeps the arithmetic round.

| Setup | Usable memory | Weights | Left for KV cache |
|---|---|---|---|
| 1 × H100, Llama 3.1 8B in BF16 | 72 GB | 16 GB | 56 GB |
| 1 × H200, 70B in BF16 | 126.9 GB | 140 GB | does not fit |
| 2 × H100, 70B in BF16 | 144 GB | 140 GB | 4 GB |
| 1 × H100, 70B in FP8 | 72 GB | 70 GB | 2 GB |
| 8 × H100, 405B in BF16 | 576 GB | 810 GB | does not fit |
| 8 × H100, 405B in FP8 | 576 GB | 405 GB | 171 GB |
| 8 × H200, 405B in BF16 | 1,015 GB | 810 GB | 205 GB |

One H200 has 141 GB installed, but its 126.9 GB usable is less than the 140 GB of weights. Two H100s hold the 70B model in BF16 with 4 GB to spare, which is enough for only two requests of 4,096 tokens.

## Memory for the KV cache

The KV cache keeps the keys and values of every token a request has seen, for every layer. The model reuses them for each new token instead of recomputing them. The cache grows with each token, and each request has its own. Its size per token is:

```text
KV bytes per token = 2 × layers × KV heads × head dimension × bytes per value
```

The 2 is for keys and values. For Llama 3.1 70B in BF16, that is 2 × 80 × 8 × 128 × 2 = 327,680 bytes per token, about 0.33 MB (320 KiB). A request of 4,096 tokens holds 4,096 × 327,680 = 1,342,177,280 bytes, or 1.34 GB. At the full 128K context, one request holds 131,072 × 327,680 = 42.9 GB.

Now the question the GPUs answer: how many requests fit at once? Four H100s give 288 GB usable. The weights take 140 GB, which leaves 288 − 140 = 148 GB for the cache. 148 × 10^9 ÷ 327,680 ≈ 451,660 tokens. Divide by 4,096 tokens per request and you get 110.3. Round down to 110, because a partial request cannot run.

```diagram
title: Four H100s: 320 GB installed, 148 GB left for the cache
[g] 4 × H100\n320 GB @ 0,0
[u] Usable at 90%\n288 GB @ 1,0
[f:note] Held back\n32 GB @ 1,1
[w] Weights\n140 GB @ 2,0
[kv:store] KV cache\n148 GB @ 2,1
[c] About 110\nrequests @ 3,1
g -> u : 90%
g -> f : 10%
u -> w : minus weights
u -> kv : left over
kv -> c : ÷ 1.34 GB each
```

Try the calculator below before you read on. Switch from 70B on four H100s to the same model on two H200s, or double the context length, and watch how many requests fit.

```widget
kv-cache-calculator
```

Three results are worth checking by hand:

- Two H200s hold fewer requests than four H100s: 84 against 110. Each H200 has more memory, but the two cards give 282 GB installed against 320 GB for the four H100s.
- Doubling the context from 4,096 to 8,192 tokens halves the count, to 55.
- An FP8 cache halves the bytes per token, so the count doubles to 220. As of October 2026, vLLM accepts `fp8` as its KV-cache data type.

Two more facts shape the cache. Without grouped-query attention, the 70B model would keep 64 KV heads, and its cache would be eight times larger, at 2,621,440 bytes per token. And the cache can outgrow the weights. Pope et al. estimate a KV cache of 3 TB at batch size 512 and context length 2,048, which is three times the size of the model's parameters.

Here is the same arithmetic as a function. It prints the bytes per token and the request counts from above.

```python
from dataclasses import dataclass


@dataclass
class Model:
    params: float    # parameters, e.g. 70e9
    layers: int
    kv_heads: int
    head_dim: int


def kv_bytes_per_token(m: Model, bytes_per_value: int = 2) -> int:
    """Keys and values (the 2) for every layer, KV head and head dimension."""
    return 2 * m.layers * m.kv_heads * m.head_dim * bytes_per_value


def requests_that_fit(m: Model, gpu_gb: float, gpus: int, context: int,
                      bytes_per_weight: float = 2, bytes_per_kv_value: int = 2,
                      usable: float = 0.9) -> int:
    """Whole requests of `context` tokens that fit beside the weights."""
    budget = gpus * gpu_gb * 1e9 * usable
    kv_room = budget - m.params * bytes_per_weight
    if kv_room <= 0:
        return 0
    per_request = kv_bytes_per_token(m, bytes_per_kv_value) * context
    return int(kv_room // per_request)


llama_70b = Model(params=70e9, layers=80, kv_heads=8, head_dim=128)
print(kv_bytes_per_token(llama_70b))                  # 327680
print(requests_that_fit(llama_70b, 80, 4, 4096))      # 110
print(requests_that_fit(llama_70b, 141, 2, 4096))     # 84
```

## How fast it can run

Two limits set the speed, and each applies to a different phase of a request. **Prefill** processes the whole prompt in one pass of large matrix arithmetic, so it is limited by compute. **Decode** makes one token per step, and each step reads the weights from memory, so it is limited by bandwidth. [GPUs for AI](/learn/gpus-for-ai#compute-versus-memory-bandwidth) explains the comparison in depth.

The dividing line is the ridge point: 989 TFLOPS ÷ 3.35 TB/s ≈ 295 FLOPs per byte. Work that does fewer FLOPs per byte than that is limited by memory.

**Decode for one user.** Each token reads all 140 GB of weights. Four H100s read 4 × 3.35 = 13.4 TB/s together, so one step takes at least 140 ÷ 13,400 s = 10.4 ms. That caps one user at about 96 tokens a second (1 ÷ 10.45 ms = 95.7). This work does about 1 FLOP per byte read, far below 295.

**Decode for a batch of 64.** Suppose 64 requests share each step, each with an average context of 2,000 tokens. Each request's cache is 2,000 × 327,680 bytes = 0.66 GB, so the 64 caches add 41.9 GB to the weights. The step reads 140 + 41.9 = 181.9 GB and takes 181.9 ÷ 13,400 = 13.6 ms. That is 64 tokens every 13.6 ms: about 4,700 tokens a second in total, or about 74 for each user. Total throughput rises 49 times, while each user drops from 96 to 74. The math in that step is 64 × 140 GFLOP = 8.96 TFLOP, which takes 2.3 ms at 4 × 989 TFLOPS. So the step is limited by memory, and it does about 49 FLOPs per byte read.

**Prefill.** A 2,000-token prompt needs 2,000 × 140 GFLOP = 280 TFLOP. At 100% of 4 × 989 TFLOPS that takes 70.8 ms. This chapter assumes 50% of peak, which gives 141.6 ms, or about 142 ms, to first token on an idle system.

These are ceilings. They assume the full bandwidth and the full math rate, with no overhead. Real engines fall short, and the sanity checks at the end show how far.

```python
def decode_ceiling(weight_gb: float, gpus: int, tb_per_s: float,
                   batch: int = 1, kv_gb_per_seq: float = 0.0) -> tuple[float, float]:
    """Best-case (tokens/s for one user, total tokens/s) for one decode step."""
    step_gb = weight_gb + batch * kv_gb_per_seq   # GB read in one step
    step_s = step_gb / (gpus * tb_per_s * 1000)   # GB ÷ (GB/s)
    return 1 / step_s, batch / step_s


print(decode_ceiling(140, 4, 3.35))                                  # (95.7, 95.7)
print(decode_ceiling(140, 4, 3.35, 64, 2000 * 327_680 / 1e9))        # (73.6, 4713.6)
```

## How many GPUs

Three checks set the count. The largest one decides it, and spare capacity is added on top.

**Memory for the requests you need.** Multiply the requests that run at once by their cache size, then add the weights. 110 requests of 4,096 tokens need 110 × 1.34 GB = 147.6 GB of cache. Add 140 GB of weights to get 287.6 GB. Each H100 gives 72 GB usable, so 287.6 ÷ 72 = 3.99, and four GPUs is the answer. The table shows the other setups for the same request size.

| Setup | Usable memory | Left for KV cache | Requests of 4,096 tokens |
|---|---|---|---|
| 2 × H100 | 144 GB | 4 GB | 2 |
| 4 × H100 | 288 GB | 148 GB | 110 |
| 2 × H200 | 253.8 GB | 113.8 GB | 84 |
| 4 × H200 | 507.6 GB | 367.6 GB | 273 |

**Throughput at peak.** The GPUs split their time between prefill and decode. Prefill takes a share of time that grows with the prompt tokens a second, and decode steps use the rest. At peak, the batch grows until its decode steps produce the tokens the traffic asks for. For one replica (one copy of the model on four GPUs), the working is:

```text
prefill share        p = (requests/s per replica) × 2,000 prompt tokens × 70.8 µs
step time            s(B) = (140 GB + B × 0.72 GB) ÷ 13,400 GB/s
batch that keeps up  B = (output tokens/s per replica) × 140
                         ÷ ((1 − p) × 13,400 − (output tokens/s per replica) × 0.72)
tokens/s per user    = (1 − p) ÷ s(B)
```

The 0.72 GB is one request's cache at an average context of 2,200 tokens (the 2,000-token prompt plus half of the 400-token answer). The 70.8 µs is the prefill time per prompt token at 50% of peak math. Solve the batch line, then divide the decode share by the step time to get each user's speed. The worked example runs these numbers.

**Headroom.** Choose the speed you need, and check that the fleet still reaches it with one replica down. A fleet that only just keeps up at peak fails as soon as one of its machines does.

```diagram
title: Three checks set the fleet. The largest count wins, then spares are added.
[m] Memory\nrequests in flight @ 0,0
[t] Throughput\nat peak @ 0,1
[h] Failures\none replica down @ 0,2
[n:note] Largest count\nplus spares @ 1,1
[r:store] Replicas\n4 GPUs each @ 2,1
m -> n
t -> n
h -> n
n -> r
```

A 70B model on four GPUs is split across them with tensor parallelism, which needs fast links between the GPUs. [GPUs for AI](/learn/gpus-for-ai#splitting-a-model-across-gpus) covers that cost.

## Cost per million tokens

The cost of a token is the hourly cost divided by the tokens produced per hour:

```text
cost per million tokens = hourly cost ÷ tokens per hour × 1,000,000
```

Assume an H100 costs $3.00 an hour. That is an assumption, not a quote, and real prices vary widely by provider, region and commitment. AWS's Savings Plans page, for example, lists savings of up to 66% for Compute Savings Plans and up to 72% for EC2 Instance Savings Plans, against on-demand prices. Those figures are for AWS's general compute, and they still show how much a commitment can move a price.

Four H100s cost $12.00 an hour. At the batch-64 ceiling of about 4,714 tokens a second, they produce 16.97 million tokens an hour. So the cost is 12.00 ÷ 16.97 = $0.71 per million output tokens. At half that throughput, the cost doubles to $1.41.

These are ceilings for output tokens. The worked example below shows a more realistic cost, which is higher, because small batches share each weight read across fewer tokens.

A pay-per-token API charges separately for input and output tokens. This chapter assumes $1.00 per million input tokens and $3.00 per million output tokens. These are invented rates, not quotes. Model quality also differs, so compare the same task, not only the price per token.

## Worked example: a support assistant

A software company wants an assistant that answers customers' questions from its help articles. The product and its numbers are invented. The assumptions are:

1. 40,000 daily active users, each starting one conversation a day.
2. Five requests per conversation, so 200,000 requests a day.
3. Each request sends 2,000 input tokens (the system prompt, the retrieved articles and the chat so far) and gets 400 output tokens back.
4. The busiest hours carry three times the average load, a peak factor of 3.
5. The model is Llama 3.1 70B in BF16, served by replicas of four H100s. Prefill runs at 50% of dense BF16 math.
6. Users need at least 30 tokens a second.
7. The fleet must still meet assumption 6 at peak with one replica down.
8. An H100 costs $3.00 an hour. A month has 30 days and 730 hours.
9. The API comparison uses $1.00 per million input tokens and $3.00 per million output tokens.

**Traffic.** 200,000 requests ÷ 86,400 seconds = 2.3148 requests a second on average, and three times that, 6.944, at peak. Input tokens are 200,000 × 2,000 ÷ 86,400 = 4,630 a second on average and 13,889 at peak. Output tokens are 200,000 × 400 ÷ 86,400 = 926 a second on average and 2,778 at peak. Each prompt is five times the length of its answer, so prefill is the first constraint to check.

**Prefill at peak.** One replica prefills 1,978 TFLOPS ÷ 140 GFLOP per token = 14,129 prompt tokens a second. At peak the traffic needs 13,889 of them, which is 98% of one replica's time. Decode gets only what prefill leaves, so the replica count depends on how the batches run. The table works the model through each replica count at peak, using the batch equation above.

| Replicas | Share of time on prefill | Requests in each batch | Tokens a second per user |
|---|---|---|---|
| 1 | 98% | none: cannot keep up | none |
| 2 | 49% | 33 | 42 |
| 3 | 33% | 16 | 60 |
| 4 | 25% | 10 | 69 |

A single replica cannot keep up, so its queue would grow without limit. Two replicas give each user 42 tokens a second, but losing one of them leaves a single replica that cannot keep up. Three replicas give 60 tokens a second. If one fails, two remain at 42, still above the 30 we need. So three replicas is the smallest fleet that survives a failure at peak.

[Little's law](/learn/performance-and-latency#littles-law) gives the same answer. At 6.94 requests a second, each taking about 6.7 seconds of decoding (400 tokens at 60 a second) plus 0.14 seconds of prefill, about 47 requests are in flight across three replicas. That is about 16 per replica, which matches the batch.

**Memory check.** At about 15.5 requests per replica, each 2,400 tokens long (2,000 in, 400 out), the cache takes 15.5 × 2,400 × 327,680 bytes = 12.2 GB. A replica has 148 GB free for its cache, so memory is not the constraint.

**Fleet and bill.** Three replicas of four H100s is 12 GPUs. At $3.00 an hour for 730 hours, the fleet costs 12 × $3.00 × 730 = $26,280 a month. That bill is fixed, and it covers the peak. Average prefill load is only about 11% of the fleet's capacity (4,630 ÷ 3 = 1,543 tokens a second per replica, against 14,129), so most of the time the fleet has spare capacity.

**Cost per token.** The month holds 200,000 × 30 = 6,000,000 requests, with 12,000 million input tokens and 2,400 million output tokens, or 14,400 million in all. The fleet costs $26,280 ÷ 14,400 million tokens ≈ $1.83 per million tokens.

**The API comparison.** The same traffic costs 12,000 × $1.00 + 2,400 × $3.00 = $12,000 + $7,200 = $19,200 a month at the assumed rates, so the fleet costs 37% more (26,280 ÷ 19,200 = 1.37). It breaks even at about 274,000 requests a day, 1.37 times today's volume, or at an H100 price of $2.19 an hour (19,200 ÷ (12 × 730) = $2.19). Check those prices before you choose.

**What would change the answer.** Autoscaling could shrink the off-peak fleet, but a [new replica must load its weights before it can serve](/learn/inference-fleets#autoscaling). Shorter prompts would also cut the prefill load, which is the first constraint here.

## Sanity checks

- **Recompute per user.** 200,000 requests ÷ 40,000 users = 5 requests a user a day, or 5 × 2,400 = 12,000 tokens a user a day. If the per-user figure looks absurd, one of the inputs is wrong.
- **Check the KV formula against the architecture.** Llama 3.1 70B has 8 KV heads. If your estimate uses the 64 attention heads instead, the cache is 2,621,440 bytes per token, eight times too large.
- **Check units.** An 80 GiB GPU has 85.9 GB of memory, which is 7% more than the 80 GB that vendors quote. Mixing the two overstates the memory by that much.
- **Check speed against the ridge point.** One user's decode does about 1 FLOP per byte, and the H100 becomes math-limited only above about 295. If your small-batch decode looks compute-bound, something is wrong.
- **Check the engine's memory budget.** vLLM's default of 92% leaves about 6.4 GB more per four H100s than the 90% used here. Use the engine's real setting when you know it.
- **Measure.** Load-test with your real prompt lengths. Compare time to first token with the 142 ms idle figure, and tokens a second per user with the 60 in the worked example. Expect lower numbers: prefill steals decode time, prompts run longer than planned, and the GPUs spend time on communication.
- **Test the price.** The decision flips at $2.19 an hour. If the price you can get is close to that, the estimate cannot settle the choice, and you need measured utilization.

## Check yourself

<details>
<summary>A 13B model has 40 layers, 8 KV heads and a head dimension of 128, and its BF16 weights take 26 GB. How many requests of 8,192 tokens fit on two H100s?</summary>

The cache is 2 × 40 × 8 × 128 × 2 = 163,840 bytes per token. One 8,192-token request therefore takes 8,192 × 163,840 = 1,342,177,280 bytes, or 1.34 GB. Two H100s have 144 GB usable, and 144 − 26 = 118 GB is left for the cache. 118 ÷ 1.34 = 87.9, so 87 requests fit.

</details>

<details>
<summary>Your 70B model runs on four H100s today, and you can move to two H200s. Which setup holds more requests of 4,096 tokens?</summary>

Four H100s hold 110 requests, and two H200s hold 84. Four H100s have 320 GB installed and two H200s have 282 GB. Each H200 has more memory than each H100, but the reserve and the weights come out of the total, and the total is what holds the cache.

</details>

<details>
<summary>A 70B model in FP8 runs on one H100. With a BF16 cache, the second of two 4,096-token requests runs out of memory. Why, and what would help?</summary>

FP8 weights take 70 GB. Usable memory is 72 GB, so only 2 GB is left. A BF16 request needs 1.34 GB, so only one fits. An FP8 cache halves the cost per request to 0.67 GB, and two requests then fit in the 2 GB. That margin is thin, because activations also need memory. A second GPU, or a shorter context, would leave room to spare.

</details>

<details>
<summary>A product gets 500,000 requests a day, each with 1,000 input tokens and 300 output tokens, and a peak factor of 3. What are the peak prompt tokens and output tokens a second?</summary>

500,000 ÷ 86,400 = 5.79 requests a second on average, and 17.36 at peak. Peak prompt tokens are 17.36 × 1,000 = 17,361 a second, and peak output tokens are 17.36 × 300 = 5,208 a second. Prompt tokens are the bigger load, so prefill sets the replica count first.

</details>

<details>
<summary>In the worked example, the three-replica fleet costs $26,280 a month, and the API bill is $19,200 at today's traffic. How much traffic makes them equal, and what H100 price would make them equal at today's traffic?</summary>

The fleet costs 1.37 times the API bill, so traffic must rise to about 1.37 times today's, or about 274,000 requests a day, before the two match. At that volume the same three replicas still keep up, since prefill would then take about 45% of each replica at peak. At today's traffic, the two costs match at an H100 price of $2.19 an hour instead of $3.00.

</details>

<details>
<summary>A 70B deployment on four H100s gives each user 40 tokens a second with 64 requests in flight. The estimate said 74. Name three things to check before you blame the GPUs.</summary>

First, prefill. New prompts take GPU time that the estimate gave to decode, and at peak that can be a third or more of the time. Second, context. The estimate assumed 2,000 tokens, and longer prompts or histories raise the bytes read in every step. Third, overhead. The estimate assumes the full 3.35 TB/s of each GPU and no gaps between steps, but communication between GPUs and scheduling take part of every step. Measure each one to find which matters.

</details>

## Further reading

- [The Llama 3 Herd of Models](https://arxiv.org/html/2407.21783): Table 3 gives the layer, attention-head and KV-head counts used in this chapter.
- [Llama 3.1 70B model card](https://huggingface.co/meta-llama/Llama-3.1-70B): the 128K context length, the BF16 weights, and the parameter count in the file metadata.
- [Introducing Llama 3.1](https://ai.meta.com/blog/meta-llama-3-1/): Meta's July 2024 post on the 128K context and on running the 405B model within one server node after FP8 quantization.
- [NVIDIA H100 for data centers](https://www.nvidia.com/en-us/data-center/h100/): memory, bandwidth, and the sparsity footnote behind the 1,979 TFLOPS figure.
- [NVIDIA H200](https://www.nvidia.com/en-us/data-center/h200/): 141 GB of HBM3e at 4.8 TB/s, with its preliminary-specifications note.
- [NVIDIA A100](https://www.nvidia.com/en-us/data-center/a100/): the 80 GB of HBM2e, the 2,039 GB/s SXM bandwidth, and 312 TFLOPS of dense BF16.
- [NVIDIA Hopper Architecture In-Depth](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/): why sparsity doubles throughput, why FP8 halves storage, and the bit layouts of the two FP8 formats.
- [Kaplan et al., Scaling Laws for Neural Language Models](https://arxiv.org/html/2001.08361v1): Section 2.1, where a forward pass costs about 2 FLOPs per parameter per token, plus a term that grows with context.
- [Pope et al., Efficiently Scaling Transformer Inference](https://arxiv.org/html/2211.05102): the 3 TB KV-cache example, and the point that low-batch generation is dominated by loading the weights.
- [vLLM engine arguments](https://docs.vllm.ai/en/stable/configuration/engine_args.html): the 0.92 default memory fraction, and the accepted `kv_cache_dtype` values, including `fp8`.
- [Kwon et al., PagedAttention](https://arxiv.org/abs/2309.06180): why fragmentation and duplication waste KV-cache memory when it is managed badly.
- [AWS Savings Plans for compute](https://aws.amazon.com/savingsplans/compute-pricing/): the savings of up to 66% and 72% against on-demand prices, which show how commitments change prices.
