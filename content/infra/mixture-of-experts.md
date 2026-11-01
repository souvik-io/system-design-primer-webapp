# Mixture-of-experts models

A mixture-of-experts (MoE) model replaces each layer's MLP with many smaller MLPs, called experts, and a router that sends each token to a few of them. The model stores far more parameters than any one token uses, so it can know more while computing as much as a much smaller dense model. That split between parameters stored and parameters used changes almost every serving number from the previous chapter. This chapter explains how routing works, works out what it does to memory, bytes per decode step and batch size, and measures a real router on your own machine.

Before this chapter, read [counting parameters](/learn/models-and-machines#counting-parameters) for how Qwen3-30B-A3B's 30.5B stored and 3.0B active parameters are counted, and [a decode step, part by part](/learn/inference-arithmetic#a-decode-step-part-by-part) for the step-time model this chapter extends.

## What an MoE layer does

In an MoE transformer, attention is unchanged. Only the MLP after it is different: instead of one gate, up and down projection, the layer holds E experts with those three projections each, plus a router. For each token, the layer does four things:

1. The router, a single d × E matrix, turns the token's vector into one score per expert.
2. The top k scores pick the token's experts, and a softmax over those k scores gives each chosen expert a weight that sums to 1 across them.
3. Each chosen expert runs its MLP on the token.
4. The layer adds the experts' outputs, each multiplied by its weight, and passes the sum on to the residual connection.

```diagram
title: One MoE layer for one token. The router picks 2 of 8 experts and the other six do no work.
[x] Token vector\nafter attention @ 0,1
[r] Router\nscores 8 experts @ 1,1
[e1] Expert 3\nweight 0.7 @ 2,0
[skip:note] 6 experts\nnot used @ 2,1
[e2] Expert 6\nweight 0.3 @ 2,2
[sum] Weighted sum @ 3,1
[out] Residual add @ 4,1
x -> r
r -> e1 : top-2
r -> e2
e1 -> sum
e2 -> sum
sum -> out
```

Models differ in how they compute the weights, but the common forms give the same result. Qwen3's code takes a softmax over all experts, keeps the top k and divides them by their sum, which its config calls `norm_topk_prob`. Granite's code takes the top k raw scores first and applies a softmax to those k. Both produce the same weights, because dividing softmax values by their sum cancels every term that involves the experts left out.

The idea is older than the transformer era of language models. Shazeer and others introduced the sparsely gated MoE layer in 2017, GShard (2020) used top-2 routing to scale translation models across thousands of accelerator cores, and the Switch Transformer (2021) showed that sending each token to a single expert works as well and costs less. Mixtral 8x7B (2024) was one of the first widely used open MoE language models, and DeepSeek's and Qwen's models since then use many small experts.

## Total and active parameters

An MoE model has two parameter counts. The total is everything that must be stored, and the active count is what one token multiplies through. The model's name usually gives both, as in "30B-A3B" for 30B total and 3B active.

| Model | Experts per layer | Chosen per token | Shared experts | Total | Active per token |
|---|---|---|---|---|---|
| Mixtral 8x7B | 8 | 2 | 0 | 47B | 13B |
| Granite 3.1 1B-A400M | 32 | 8 | 0 | 1.3B | 400M |
| Qwen3-30B-A3B | 128 | 8 | 0 | 30.5B | 3.3B |
| DeepSeek-V3 | 256 | 8 | 1 | 671B | 37B |

The figures come from the Mixtral paper, the Granite and Qwen3 model cards, and the DeepSeek-V3 paper.

Two design choices separate the newer models from Mixtral, and both come from the DeepSeekMoE paper (2024):

- **Fine-grained experts.** Instead of 8 large experts, the model has many narrow ones and picks more of them. Qwen3-30B-A3B's experts are 768 wide, and 8 of them together are 6,144 wide, so each token does the same MLP arithmetic as a dense MLP of width 6,144. Choosing 8 of 128 experts gives the router far more combinations to specialise with than choosing 2 of 8.
- **Shared experts.** A shared expert runs for every token, and the routed experts can then specialise in what the shared one does not cover. DeepSeek-V3 has one shared expert and 256 routed ones in each MoE layer. The Qwen3 technical report says its MoE models leave shared experts out.

For serving, the two counts set different resources. **Memory follows the total.** Qwen3-30B-A3B needs 61.1 GB for its BF16 weights, four times what Llama 3.1 8B needs. **Compute follows the active count.** Each token costs about 6.1 GFLOP, against 15.0 for the 8B model. The bytes read per decode step follow neither count exactly, and the next section shows why.

## Which experts a decode step reads

A dense model reads every weight once per decode step, whatever the batch size, which is why batching made decode cheaper in [chapter 1.2](/learn/inference-arithmetic#a-decode-step-part-by-part). An MoE model reads its attention weights, routers and output head on every step, but it reads an expert only if at least one token in the batch chose it.

If the router spread its choices evenly and independently, one token would skip a given expert with probability 1 − k/E. All B tokens in a batch skip it with probability (1 − k/E) to the power B, so the expected number of experts a layer must read is:

experts read per layer = E × (1 − (1 − k/E)^B)

For Qwen3-30B-A3B, with E = 128 and k = 8, one token reads 8 experts, 4 tokens read about 29, 16 tokens read about 82, and 64 tokens read nearly all 128. The script [moe_arithmetic.py](/labs/infra/moe_arithmetic.py) puts this formula into the step-time model from chapter 1.2 for one H100, with 2,000-token contexts in BF16:

```text
batch | experts/layer weights read     step   tok/s | 8B: weights     step   tok/s
    1 |           8.0       6.1 GB  1.87 ms     533 |     15.0 GB  4.56 ms     219
    2 |          15.5       9.5 GB  2.95 ms     679 |     15.0 GB  4.63 ms     432
    4 |          29.1      15.7 GB  4.91 ms     815 |     15.0 GB  4.79 ms     835
    8 |          51.6      25.8 GB  8.18 ms     978 |     15.0 GB  5.10 ms    1568
   16 |          82.4      39.8 GB 12.82 ms    1248 |     15.0 GB  5.73 ms    2792
   32 |         111.8      53.1 GB 17.73 ms    1805 |     15.0 GB  6.98 ms    4583
   64 |         125.9      59.5 GB 21.52 ms    2974 |     15.0 GB  9.49 ms    6747
  128 |         128.0      60.4 GB 25.55 ms    5010 |     15.0 GB 14.49 ms    8831
  256 |         128.0      60.4 GB 33.07 ms    7742 |     15.0 GB 24.51 ms   10445
  512 |         128.0      60.4 GB 48.09 ms   10646 |     15.0 GB 47.83 ms   10704
```

The table has three lessons.

1. **At batch 1 the MoE model is the fast one.** It reads 6.1 GB per step against the 8B model's 15.0 GB, so a single user gets 533 tokens a second instead of 219. This is the case MoE models are often praised for.
2. **Batching is no longer nearly free.** Each extra token pulls in experts that nobody else in the batch chose, so the bytes per step grow until every expert is read. From batch 8 to batch 256 the MoE model is slower per step than the dense 8B model, because it reads up to 60 GB per step where the 8B reads 15 GB.
3. **The MoE model needs far larger batches to become compute-bound.** Once every expert is read, each expert serves on average B × k ÷ E tokens, which is B ÷ 16 for Qwen3-30B-A3B. A BF16 weight is 2 bytes and does 2 FLOPs per token, so an expert's matmul does about as many FLOPs per byte as it has tokens. The script finds that the 8B model's weight matmuls reach the H100's ridge point at about 295 sequences and Qwen3-30B-A3B's only at about 2,900.

The DeepSeek-V3 paper describes the same effect at a much larger scale. It reports that during decoding each expert usually sees a batch of at most 256 tokens and that the bottleneck is memory access, not computation. Its decode deployment therefore spreads the experts over 320 GPUs, with one expert on most of them, so that a very large total batch gives each expert enough tokens. That technique is called expert parallelism, and Part 6 of this handbook covers it.

Memory makes the problem worse on one GPU. After its 61.1 GB of BF16 weights, Qwen3-30B-A3B leaves 10.9 GB of an H100's usable 72 GB for the KV cache, which holds 55 sequences of 2,000 tokens. The 8B model leaves room for 213. With FP8 weights, which Qwen publishes as Qwen3-30B-A3B-FP8, the weights take 30.5 GB and about 210 sequences fit. This is why MoE models are almost always served in FP8 or across several GPUs.

The roofline explorer from chapter 1.2 now includes Qwen3-30B-A3B, labelled 30B-A3B. Try these settings:

- Pick 30B-A3B and 8B in turn on the H100 at batch 1, then at batch 16, and compare the step times.
- With 30B-A3B selected, move the batch slider from 1 to 64 and watch the weight-matmul point. It moves right much more slowly than it does for the 8B model, because the bytes grow with the batch.
- Switch the weights to FP8 and see how many sequences the memory now allows.

```widget
roofline-explorer
```

## Routing in practice

The formula above assumes an even router, and real routers are not even. The lab script [expert_load.py](/labs/infra/expert_load.py) runs IBM's Granite 3.1 1B-A400M, a small MoE model with 32 experts and top-8 routing, over 4,096 tokens of English prose and 4,096 tokens of Python code, and records every routing decision. On an M2 MacBook it found three things.

**The load is very uneven.** In the average layer, the busiest expert received 3.0 times the even share of tokens. With top-8 routing over 32 experts, the largest possible ratio is 4, which means every single token chose that expert, and the most uneven layer reached exactly 4.00. In that layer one expert behaves like a shared expert that the router selects every time.

**Experts specialise only a little by content.** The routing for prose and for code differed by 14% on average, measured as the share of routing decisions that would have to move to turn one distribution into the other. The same few experts were the busiest for both texts in most layers.

**Fewer experts are read than the even formula predicts.** Because the router favours some experts, a batch of 4 tokens read 18.4 experts per layer instead of 21.9, and a batch of 16 read 27.0 instead of 31.7. Uneven routing therefore saves some bytes per step, but it costs time in another way.

Imbalance matters most when experts sit on different GPUs. A layer finishes only when its busiest GPU finishes, so a GPU that holds two popular experts slows the whole step. Models are trained to limit this, and engines correct what remains:

- **Auxiliary balancing loss.** The Switch Transformer adds α × N × the sum over experts of f_i × P_i to the training loss, where f_i is the fraction of tokens sent to expert i and P_i is the average router probability given to it. The loss is smallest when both are even, and the paper uses α = 0.01. Too large a coefficient hurts model quality.
- **Bias-based balancing.** DeepSeek-V3 adds a bias to each expert's score that is used only for choosing experts, not for weighting them. After each training step, it lowers the bias of overloaded experts and raises the bias of underloaded ones. The paper reports better quality than a pure auxiliary loss, and it calls the method auxiliary-loss-free.
- **Global-batch balancing.** The Qwen3 technical report balances expert load over the whole global batch rather than each small batch, which leaves the router freer to specialise.
- **Redundant experts at serving time.** DeepSeek-V3's prefill deployment copies its most loaded experts onto extra GPUs and re-chooses which experts to copy from live statistics about every ten minutes. vLLM offers the same idea as its expert parallelism load balancer, turned on with `--enable-eplb`.

Use the widget below to see the effect of routing on one layer. Set the router to "Like a trained router", which copies the unevenness measured on Granite above, and compare it with "Even". The calibration comes from Granite's 32 experts. With 128 or 256 experts, the same unevenness makes the busiest expert stand out much further, and nobody has measured those larger routers in this handbook yet, so treat their busiest-expert numbers as an illustration rather than a measurement.

- At batch 4, compare the number of experts touched with the dashed even-routing curve.
- At batch 256, look at the busiest expert against the even share.
- Choose 4 or 8 GPUs to see how the busiest GPU's share grows when experts sit on different devices.

```widget
expert-router
```

## Capacity and dropped tokens

Training systems for MoE models often need fixed tensor shapes, so they give every expert a fixed capacity. The Switch Transformer sets each expert's capacity to the batch's tokens divided by the number of experts, multiplied by a capacity factor. A token that arrives at a full expert is dropped from that expert, and its vector passes to the next layer through the residual connection unchanged. The Switch paper reports that its auxiliary loss kept dropped tokens typically below 1%.

A router that was not trained against a capacity limit drops far more. The lab measured what Switch-style capacity would do to Granite's routing in batches of 256 tokens:

| Capacity factor | Slots per expert | Token-expert pairs dropped |
|---|---|---|
| 1.0 | 64 | 33.2% |
| 1.25 | 80 | 23.3% |
| 1.5 | 96 | 16.0% |
| 2.0 | 128 | 7.4% |

Inference systems avoid dropping because it changes the model's output. DeepSeek-V3 drops no tokens in training or in inference, and vLLM's MoE kernels compute every routed token. In serving, an uneven load therefore costs time rather than quality: the busiest expert takes longer, and everyone waits for it.

## How engines run an MoE layer

The simplest implementation loops over the experts, gathers the tokens that chose each one, runs its MLP and adds the results back. Recent versions of Hugging Face transformers keep this loop as their plain reference implementation, next to a faster one built on PyTorch's grouped matrix multiply. The loop launches separate small matmuls for every expert that has tokens, so with 48 layers and up to 128 experts each, one decode step can launch thousands of small kernels.

Serving engines group the work instead. They sort the (token, expert) pairs by expert, so that each expert's tokens sit in one contiguous block, and then run every expert's matmul in one grouped matmul kernel. They finish by putting the rows back in token order and summing each token's k results. vLLM's `moe_align_block_size` function does the sorting, padding each expert's block to the kernel's tile size, and its Triton kernel `fused_moe_kernel` runs the grouped matmul. Part A of the lab below writes both versions in plain PyTorch and checks that they agree.

When experts are spread over GPUs, two communication steps surround that kernel. A dispatch step sends each token's vector to the GPUs that hold its chosen experts, and a combine step brings the results back. Both are all-to-all exchanges, and DeepEP, which vLLM can use as a backend, provides kernels tuned for each phase. Part 6 covers expert parallelism in detail.

## Lab: an MoE layer and a real router

**Tier: [Mac] for parts A and B, [1 GPU] for part C.** Parts A and B run on an 8 GB M2 MacBook in about a minute each. Part C needs a rented 80 GB GPU, which costs well under a dollar on Modal.

The scripts are ready to download, and they also sit in the site's repository at `public/labs/infra/`:

- [moe_layer.py](/labs/infra/moe_layer.py) for part A;
- [expert_load.py](/labs/infra/expert_load.py) for part B, which downloads about 2.7 GB of model weights on its first run;
- [moe_arithmetic.py](/labs/infra/moe_arithmetic.py), the calculation behind this chapter's table, which needs no packages;
- [gpu/moe_decode_sweep.py](/labs/infra/gpu/moe_decode_sweep.py) for part C.

Try parts A and B yourself before you open the scripts or the reference solution.

**Part A, an MoE layer from scratch.** Build a tiny `Qwen3MoeForCausalLM` from `transformers` with 16 experts and top-4 routing, and take its first layer's MoE block. Write the same layer twice in plain PyTorch: once as a loop over experts, and once in the grouped form that sorts tokens by expert. Both must match the Hugging Face block to float32 rounding on 512 random tokens. Then print how many tokens each expert received, and the FLOPs per token against a dense MLP that runs every expert.

**Part B, a real router.** Run Granite 3.1 1B-A400M over a few thousand tokens of prose and of code with `output_router_logits=True`, and record the top-8 experts that every token chose in every layer. From those choices, report four results: the busiest expert's load against the even share per layer, how differently prose and code are routed, the number of experts a decode batch of B tokens touches compared with the even formula, and how many tokens a capacity factor of 1.0 to 2.0 would drop.

**Part C, measured against predicted (GPU).** Serve Qwen3-30B-A3B and Llama 3.1 8B with vLLM on one H100, measure the decode step time at batch 1 to 16, and put the results next to `moe_arithmetic.py`'s predictions. The GPU folder's [README](/labs/infra/gpu/README.md) lists what to record and send back.

The lab is done when parts A and B run, when you can explain each number they print, and when your notes say at which batch size Qwen3-30B-A3B stops being faster than the 8B model on one H100, and why.

<details>
<summary>Reference solution</summary>

**Part A.** The grouped version is the heart of the exercise. It flattens the router's choices into T × k (token, expert) pairs, sorts them by expert with a stable `argsort`, runs each expert on its contiguous slice, scales each row by its routing weight, and uses `index_add_` to sum each token's k rows back into place:

```python
def moe_grouped(x):
    weights, experts = route(x)
    flat = experts.reshape(-1)                                    # T*K (token, expert) pairs
    order = flat.argsort(stable=True)                             # group the pairs by expert
    token = order // K                                            # pair index -> token index
    counts = torch.bincount(flat, minlength=E).tolist()           # tokens per expert: the group sizes
    rows = x[token]                                               # the "permute" step: [T*K, D]
    outs, start = [], 0
    for e, n in enumerate(counts):                                # one grouped GEMM in a real engine
        outs.append(expert_mlp(e, rows[start:start + n]))
        start += n
    y = torch.cat(outs) * weights.reshape(-1)[order, None]        # scale each row by its routing weight
    return torch.zeros_like(x).index_add_(0, token, y), counts    # "unpermute" and sum the K rows per token
```

The full script, with the router, the loop version and the checks, is [moe_layer.py](/labs/infra/moe_layer.py). This is its output with PyTorch 2.15 and transformers 5.22 on an M2 CPU:

```text
loop    vs HF: max error 3.7e-09 (outputs reach 3.0e-02)
grouped vs HF: max error 3.7e-09

512 tokens x top-4 = 2048 expert slots over 16 experts, 128 per expert if even
tokens per expert: [134, 117, 123, 119, 127, 136, 135, 119, 128, 126, 123, 143, 119, 154, 142, 103]
busiest expert: 154 tokens = 1.20 x the mean; quietest: 103

per token: 0.79 MFLOP active, against 3.15 MFLOP if every expert ran (25%); weights stored: 6.3 MB in FP32
```

**Part B.** The key step collects the router's logits from every layer and takes the top k of each. Top-k of the logits gives the same experts as top-k of the probabilities, because softmax keeps the order:

```python
out = model(ids[None, start:start + CHUNK].to(device), output_router_logits=True)
picks.append(torch.stack([r.float().topk(K, dim=-1).indices.cpu() for r in out.router_logits]))
```

The full script is [expert_load.py](/labs/infra/expert_load.py). It uses English prose from Python's own documentation and Python source code from the standard library, so it needs no dataset download. This is its output on an M2 MacBook with 8 GB of memory, which took 51 seconds including loading the model:

```text
ibm-granite/granite-3.1-1b-a400m-instruct: 24 layers, 32 experts, top-8, 4,096 tokens of each text on mps

1. Load imbalance: the busiest expert's tokens divided by the even share (1.00 = perfectly even)
layer  prose   code   busiest experts, prose | code
    0   2.24   2.04   [31, 13, 3] | [31, 13, 9]
    3   3.31   3.09   [2, 13, 30] | [2, 13, 26]
    6   3.07   2.96   [21, 12, 0] | [21, 13, 0]
    9   2.99   3.35   [19, 30, 17] | [30, 17, 19]
   12   2.35   2.32   [7, 6, 19] | [6, 13, 7]
   15   2.51   2.78   [10, 8, 22] | [10, 22, 18]
   18   1.98   2.40   [8, 17, 31] | [9, 13, 22]
   21   3.46   3.70   [3, 19, 2] | [19, 13, 29]
prose: mean over layers 3.01, worst layer 4.00; experts never chosen: 0 of 768
code: mean over layers 3.11, worst layer 4.00; experts never chosen: 1 of 768

2. Specialisation: share of routing that differs between prose and code (total variation distance)
mean over layers 0.14, lowest 0.04 (layer 1), highest 0.22 (layer 18)

3. Experts touched per layer by a decode batch of B tokens from different places in the text
   B  measured  even routing
   1       8.0           8.0
   2      12.8          14.0
   4      18.4          21.9
   8      23.4          28.8
  16      27.0          31.7
  32      29.0          32.0
  64      30.3          32.0

4. Tokens dropped when each expert takes at most capacity = factor x (tokens x K / E) per 256-token batch
factor 1.00: capacity  64 slots per expert, 33.18% of token-expert pairs dropped
factor 1.25: capacity  80 slots per expert, 23.32% of token-expert pairs dropped
factor 1.50: capacity  96 slots per expert, 15.96% of token-expert pairs dropped
factor 2.00: capacity 128 slots per expert,  7.39% of token-expert pairs dropped
```

Four things in the output are worth noticing:

- The random router in part A spreads tokens almost evenly, with the busiest expert at 1.20 times the mean. The trained router in part B is far more uneven, so balance is something training produces, not something routing gives for free.
- A ratio of 4.00 is the ceiling for top-8 of 32 experts, and it means that one expert was chosen by every token in that layer.
- The measured count of experts touched stays below the even formula at every batch size, which is good for the bytes a step reads. The busiest expert's share is the cost that comes with it.
- Dropping tokens at a capacity factor of 1.25 would remove almost a quarter of the expert computations in this model, which is why serving engines run every routed token.

**Part C.** The script [gpu/moe_decode_sweep.py](/labs/infra/gpu/moe_decode_sweep.py) loads each model in vLLM once and isolates decode the same way as chapter 1.2's lab: for each batch it subtracts a run that generates 1 token from a run that generates 129, and divides by the 128 decode steps. It also prints a few of vLLM's own start-up lines. Run on Modal with `modal run modal_run.py --script moe_decode_sweep.py --gpu H100 --vllm`, its output was:

```text
[Qwen3-30B-A3B] Loading weights took 12.61 seconds
[Qwen3-30B-A3B] [backbone] torch.compile took 33.95 s in total
[Qwen3-30B-A3B] Available KV cache memory: 12.18 GiB
[Qwen3-30B-A3B] GPU KV cache size: 133,072 tokens, Maximum concurrency for 2,048 tokens per request: 64.98x
[Meta-Llama-3.1-8B-Instruct] Loading weights took 2.09 seconds
[Meta-Llama-3.1-8B-Instruct] [backbone] torch.compile took 13.26 s in total
[Meta-Llama-3.1-8B-Instruct] Available KV cache memory: 54.44 GiB
[Meta-Llama-3.1-8B-Instruct] GPU KV cache size: 445,968 tokens, Maximum concurrency for 2,048 tokens per request: 217.76x
NVIDIA H100 80GB HBM3, vLLM 0.32.0, PyTorch 2.13.0+cu130; prediction at 3.35 TB/s
BF16, 1000-token prompts, 128 decode steps timed (median of 8 runs)

model                                batch   measured  predicted  ratio   tok/s
Qwen/Qwen3-30B-A3B                       1    4.58 ms    1.85 ms   2.48     218
Qwen/Qwen3-30B-A3B                       2    5.51 ms    2.89 ms   1.90     363
Qwen/Qwen3-30B-A3B                       4    7.81 ms    4.80 ms   1.63     512
Qwen/Qwen3-30B-A3B                       8    9.36 ms    7.96 ms   1.18     855
Qwen/Qwen3-30B-A3B                      16   12.24 ms   12.38 ms   0.99    1308
unsloth/Meta-Llama-3.1-8B-Instruct       1    6.30 ms    4.52 ms   1.39     159
unsloth/Meta-Llama-3.1-8B-Instruct       2    6.32 ms    4.56 ms   1.39     317
unsloth/Meta-Llama-3.1-8B-Instruct       4    6.47 ms    4.64 ms   1.39     618
unsloth/Meta-Llama-3.1-8B-Instruct       8    6.66 ms    4.81 ms   1.38    1201
unsloth/Meta-Llama-3.1-8B-Instruct      16    7.00 ms    5.14 ms   1.36    2286
```

The predictions differ slightly from the table earlier in this chapter because these runs use 1,000-token prompts and 128 steps, so the average context is 1,064 tokens instead of 2,000. Four things stand out:

- **The crossover came earlier than predicted.** The model said the MoE model would be faster at batch 1 and 2 and about even at batch 4. It was faster at batch 1, 4.58 ms against 6.30 ms, and at batch 2, but already 21% slower at batch 4, 7.81 ms against 6.47 ms, and 75% slower at batch 16.
- **The MoE model's fixed cost is large.** At batch 1 it took 2.48 times its prediction, against 1.39 times for the dense model. A step of Qwen3-30B-A3B runs 48 layers instead of 32, and each layer adds routing, sorting the tokens by expert and a grouped matmul over small expert matrices, so it has more small kernels and more matmuls too small to reach full bandwidth. Those costs barely depend on the batch, so the ratio falls as the batch grows and the bytes read dominate.
- **At batch 16 the measured step matched the prediction, which means the prediction counted too many bytes.** A ratio of 0.99 would be 100% of the spec bandwidth, which no real step reaches; chapter 2.1 measured 3.0 TB/s, 90% of the spec, as the practical ceiling. The prediction assumes even routing, under which 16 tokens touch about 82 experts per layer. Part B showed Granite's trained router touching fewer experts than the even formula at every batch size; if Qwen3's router does the same with this lab's random prompt tokens, the real step reads fewer bytes than predicted. The dense model, whose bytes are known exactly, stayed at 1.36 to 1.39 times its prediction throughout.
- **Memory limits the MoE model's batch.** After its 61 GB of weights, Qwen3-30B-A3B left 12.18 GiB for the KV cache, enough for 65 requests of 2,048 tokens, against 218 for the 8B model. On one GPU, the dense model can serve a batch more than three times larger, which is the regime where it is also faster per step. MoE models pay off when the batch is spread over several GPUs that together hold the experts, the subject of Part 6.

</details>

## Interview angle

- **"Why can an MoE model be faster than a dense model with fewer parameters?"** At small batch sizes decode time follows the bytes read, and an MoE model reads only the experts its tokens chose. Qwen3-30B-A3B reads about 6 GB per step at batch 1, while Llama 3.1 8B reads 15 GB, so the larger model is about 2.4 times faster for one user on the same GPU.
- **"What happens to an MoE model's decode cost as the batch grows?"** Each extra token pulls in experts that the others did not choose, so the bytes per step grow until every expert is read. A strong answer gives the formula E × (1 − (1 − k/E)^B) and the consequence: the model needs batches about E ÷ k times larger than a dense model to become compute-bound.
- **"How would you serve a 600B-parameter MoE model?"** Memory follows the total, so the weights need many GPUs, usually in FP8. Expert parallelism places different experts on different GPUs and uses all-to-all exchanges to send tokens to their experts. A very large total batch gives each expert enough tokens, and redundant copies of popular experts keep the GPUs evenly loaded.
- **"What is a capacity factor, and would you use one in serving?"** It caps how many tokens an expert accepts per batch, which gives fixed shapes during training at the cost of dropping overflow tokens. In serving you would avoid it, because dropping changes the output, and engines such as vLLM compute every routed token.

## Check yourself

<details>
<summary>Qwen3-30B-A3B stores 30.5B parameters and uses about 3B per token. Which number sets the GPU memory it needs, and which sets its FLOPs per token?</summary>

The total sets the memory, because every expert must be in GPU memory in case a token chooses it: 61.1 GB in BF16. The active count sets the FLOPs, because each token runs only its 8 chosen experts plus attention, the routers and the output head: about 6.1 GFLOP per token.

</details>

<details>
<summary>With 128 experts and top-8 routing spread evenly, how many experts does one layer read for a decode batch of 4 tokens?</summary>

E × (1 − (1 − k/E)^B) = 128 × (1 − (120/128)^4) = 128 × (1 − 0.772) ≈ 29.1 experts. That is nearly four times the 8 experts that one token reads, which is why the MoE model's step time grows quickly with the batch.

</details>

<details>
<summary>Why does an expert's matmul in BF16 do about as many FLOPs per byte as the number of tokens it received?</summary>

Each weight is 2 bytes and does one multiply and one add, 2 FLOPs, for each token that passes through it. With n tokens, every 2 bytes read support 2 × n FLOPs, which is n FLOPs per byte. An expert that receives 4 tokens therefore runs at about 4 FLOPs per byte, far below an H100's ridge point of about 295.

</details>

<details>
<summary>On one H100 with 2,000-token sequences, why does Qwen3-30B-A3B in BF16 fit only 55 sequences when Llama 3.1 8B fits 213, even though the MoE model's KV cache per token is smaller?</summary>

The KV cache only gets what the weights leave over. The MoE model's 61.1 GB of weights leave 10.9 GB of the usable 72 GB, while the 8B model's 16.1 GB leave 55.9 GB. At 98,304 bytes per token, a 2,000-token sequence needs about 197 MB, so 10.9 GB holds 55 of them. FP8 weights halve the weight memory and raise the count to about 210.

</details>

<details>
<summary>A model with 32 experts and top-8 routing processes a batch of 256 tokens with a capacity factor of 1.25. What is each expert's capacity, and what happens to the tokens beyond it?</summary>

The even share is 256 × 8 ÷ 32 = 64 token slots per expert, so the capacity is 1.25 × 64 = 80. A token that arrives at an expert that already holds 80 tokens skips that expert, and its vector reaches the next layer through the residual connection without that expert's contribution.

</details>

<details>
<summary>What problem does DeepSeek-V3's auxiliary-loss-free balancing solve, and how does it work?</summary>

An auxiliary balancing loss evens out the expert load, but a coefficient large enough to balance well also hurts the model's quality. DeepSeek-V3 instead adds a bias to each expert's routing score, used only to choose experts and not to weight their outputs. After each training step it lowers the bias of experts that were overloaded and raises the bias of those that were underloaded, which balances the load without adding a term to the loss.

</details>

## Further reading

- [Outrageously large neural networks: the sparsely-gated mixture-of-experts layer](https://arxiv.org/abs/1701.06538) by Shazeer and others introduced top-k routing over many experts in a language model.
- [GShard](https://arxiv.org/abs/2006.16668) scaled top-2 MoE translation models across thousands of TPU cores and introduced the expert capacity used in later work.
- [Switch Transformers](https://arxiv.org/abs/2101.03961) showed that routing each token to one expert works, and it defines the capacity factor and the auxiliary load-balancing loss used in this chapter.
- [Mixtral of experts](https://arxiv.org/abs/2401.04088) describes the 8-expert, top-2 model that made MoE common among open models.
- [DeepSeekMoE](https://arxiv.org/abs/2401.06066) introduced fine-grained experts and shared experts.
- [The DeepSeek-V3 technical report](https://arxiv.org/abs/2412.19437) covers auxiliary-loss-free balancing, node-limited routing and its prefill and decode deployments with redundant experts.
- [The Qwen3 technical report](https://arxiv.org/abs/2505.09388) describes the 128-expert, top-8 design without shared experts, trained with a global-batch balancing loss.
- [Qwen3-30B-A3B's config.json](https://huggingface.co/Qwen/Qwen3-30B-A3B/blob/main/config.json) and [the Granite 3.1 1B-A400M model card](https://huggingface.co/ibm-granite/granite-3.1-1b-a400m-instruct) give the shapes used in the lab.
- [vLLM's expert parallel deployment guide](https://docs.vllm.ai/en/latest/serving/expert_parallel_deployment.html) explains its expert load balancer and its all-to-all backends, including DeepEP.
- [vLLM's fused MoE layer](https://github.com/vllm-project/vllm/tree/main/vllm/model_executor/layers/fused_moe) contains the token sorting (`moe_align_block_size.py`) and the Triton grouped-matmul kernel (`fused_moe.py`) described above.
