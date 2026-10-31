# The transformer, seen by the hardware

To a GPU, a transformer is a list of matrix multiplies with some element-wise work in between. Which of those operations takes the time depends on how many tokens go through at once, and that number is very different in prefill and decode. This chapter walks one decoder layer of Llama 3.1 8B operation by operation, counts the FLOPs and bytes each one costs, and shows how attention variants and positional encoding change those costs. The lab has you write the layer yourself and check it against Hugging Face to six decimal places.

Prerequisites: [from prompt to answer](/learn/llm-inference#from-prompt-to-answer), [prefill and decode](/learn/llm-inference#prefill-and-decode), and the shapes in [models and machines](/learn/models-and-machines#reading-configjson).

## One layer as a list of operations

Every token enters a layer as a vector of d = 4,096 numbers and leaves as a vector of the same size. In between, Llama 3.1 8B does this:

```diagram
title: One Llama decoder layer. The layer adds its results to the input twice, so the vector keeps its size.
[x] Layer input\n4,096 per token @ 0,0
[n1] RMSNorm @ 1,0
[qkv] QKV projection\n4,096 to 6,144 @ 2,0
[rope] RoPE on Q, K @ 3,0
[kv:store] KV cache\nall past K, V @ 4,0
[attn] Attention\n32 query heads @ 4,1
[o] Output projection @ 3,1
[n2] Add, RMSNorm @ 2,1
[gu] Gate and up\n4,096 to 28,672 @ 1,1
[act] SiLU(gate) × up @ 0,1
[down] Down projection\n14,336 to 4,096 @ 0,2
[out] Add, next layer @ 1,2
x -> n1
n1 -> qkv
qkv -> rope
rope -> kv : append K, V
kv -> attn : read K, V
attn -> o
o -> n2
n2 -> gu
gu -> act
act -> down
down -> out
```

| Step | What it does | Weights |
|---|---|---|
| RMSNorm | Scales the vector to a standard size | 4,096 |
| QKV projection | One matmul produces 32 query heads, 8 key heads and 8 value heads, each 128 wide: 4,096 → 6,144 | 25.2M |
| RoPE | Rotates queries and keys by an angle that depends on the token's position | none |
| Attention | Each query head scores every cached key in its group, softmaxes the scores and averages the values | none |
| Output projection | 4,096 → 4,096, then added to the layer input (the residual) | 16.8M |
| RMSNorm | Same as before, on the new vector | 4,096 |
| Gate and up projections | Two matmuls, 4,096 → 14,336 each, usually run as one 4,096 → 28,672 | 117.4M |
| SiLU × up | SiLU of the gate, multiplied element-wise by the up output | none |
| Down projection | 14,336 → 4,096, then added to the residual | 58.7M |

Only the four matmuls have weights worth counting, 218M per layer. Attention has none of its own, but it reads the KV cache, which grows with every token. Everything else is element-wise: cheap arithmetic, but it reads and writes the whole activation.

## Prefill and decode shapes

Each matmul multiplies a T × d matrix of token vectors by a d × d_out weight matrix, where T is the number of tokens in this step.

- **Prefill** processes the whole prompt at once, so T is the prompt length: 2,000 tokens means a 2,000 × 4,096 matrix times each weight. This is a matrix-matrix multiply (GEMM), and each weight that is read is used 2,000 times.
- **Decode** adds one token per sequence, so T is the batch size. At batch 1, each matmul is a vector times a matrix (GEMV): every weight is read once and used once.

The same weights, the same code, and a different T. That one number moves the work from one end of the roofline to the other.

Attention has a second size: the context length c, the number of tokens already in the cache. In prefill, the prompt attends to itself, so the scores form a T × T square, half of it masked by causality. In decode, one new query per sequence attends to c cached keys.

## Where the FLOPs go

A matmul with T tokens, d_in inputs and d_out outputs costs 2 × T × d_in × d_out FLOPs: one multiply and one add per weight per token. Summed over a layer's matmuls, that is the 2 × parameters rule from [models and machines](/learn/models-and-machines#counting-parameters): 15.0 GFLOP per token for the whole 8B model.

Attention adds work that the parameter count misses. For each new token, each query head computes a dot product with every cached key (2 × head_dim FLOPs each) and a weighted sum of every cached value (another 2 × head_dim). Per token at context c:

attention FLOPs = 2 matmuls × 2 × layers × query heads × head_dim × c = 4 × 32 × 32 × 128 × c = 524,288 × c

At c = 2,000 that is 1.05 GFLOP, 7% of the matmul work. At c ≈ 28,600 it equals the matmuls' 15.0 GFLOP. So the 2 × parameters rule holds well for short contexts and undercounts long ones.

## Where the bytes go

A FLOP count alone says nothing about time. What decides it is whether the GPU spends longer computing or longer moving data. The script below lists every operation in one 8B layer with its FLOPs, the bytes it moves, its arithmetic intensity (FLOPs per byte), and the roofline time on an H100 (989 TFLOPS dense BF16, 3.35 TB/s). Each operation takes the longer of its compute time and its memory time.

```python
# layer_ops.py: FLOPs, bytes and roofline time for each operation in one Llama 3.1 8B layer (BF16, H100).
D, I, H, KV, HD, B2 = 4096, 14336, 32, 8, 128, 2     # B2: bytes per BF16 value
PEAK, BW = 989e12, 3.35e12


def linear(tokens, d_in, d_out):
    return 2 * tokens * d_in * d_out, B2 * (d_in * d_out + tokens * (d_in + d_out))


def ops(seqs, new, context):
    """seqs sequences, each adding `new` tokens on top of `context` tokens already cached."""
    t = seqs * new
    attn_flops = seqs * 4 * H * HD * new * context * (0.5 if new > 1 else 1)   # causal half in prefill
    kv_read = seqs * context * KV * HD * 2 * B2                                 # K and V
    qo = seqs * new * H * HD * 2 * B2                                           # read Q, write output
    return {
        "RMSNorm x2 + residuals": (t * D * 10, B2 * t * D * 8),   # rough: a few FLOPs, read and write x
        "QKV projection": linear(t, D, (H + 2 * KV) * HD),
        "RoPE": (t * (H + KV) * HD * 3, B2 * t * (H + KV) * HD * 2),
        "attention (QK, softmax, PV)": (attn_flops, kv_read + qo),
        "output projection": linear(t, H * HD, D),
        "gate + up projection": linear(t, D, 2 * I),
        "SiLU x up": (t * I * 5, B2 * t * I * 3),
        "down projection": linear(t, I, D),
    }


for title, seqs, new, ctx in (("decode, batch 1, 2K context", 1, 1, 2000),
                              ("decode, batch 64, 2K context", 64, 1, 2000),
                              ("prefill, one 2K prompt", 1, 2000, 2000)):
    rows = ops(seqs, new, ctx)
    times = {k: max(f / PEAK, b / BW) for k, (f, b) in rows.items()}
    total = sum(times.values())
    print(f"{title}: {total * 1e6:.0f} us per layer, x32 layers = {total * 32 * 1e3:.2f} ms")
    for k, (f, b) in rows.items():
        bound = "compute" if f / b > PEAK / BW else "memory"
        print(f"  {k:28s} {f / 1e9:8.2f} GFLOP {b / 1e6:8.1f} MB {f / b:7.1f} F/B  "
              f"{bound:7s} {times[k] / total:4.0%}")
```

```text
decode, batch 1, 2K context: 133 us per layer, x32 layers = 4.25 ms
  RMSNorm x2 + residuals           0.00 GFLOP      0.1 MB     0.6 F/B  memory    0%
  QKV projection                   0.05 GFLOP     50.4 MB     1.0 F/B  memory   11%
  RoPE                             0.00 GFLOP      0.0 MB     0.8 F/B  memory    0%
  attention (QK, softmax, PV)      0.03 GFLOP      8.2 MB     4.0 F/B  memory    2%
  output projection                0.03 GFLOP     33.6 MB     1.0 F/B  memory    8%
  gate + up projection             0.23 GFLOP    234.9 MB     1.0 F/B  memory   53%
  SiLU x up                        0.00 GFLOP      0.1 MB     0.8 F/B  memory    0%
  down projection                  0.12 GFLOP    117.5 MB     1.0 F/B  memory   26%
decode, batch 64, 2K context: 293 us per layer, x32 layers = 9.38 ms
  RMSNorm x2 + residuals           0.00 GFLOP      4.2 MB     0.6 F/B  memory    0%
  QKV projection                   3.22 GFLOP     51.6 MB    62.4 F/B  memory    5%
  RoPE                             0.00 GFLOP      1.3 MB     0.8 F/B  memory    0%
  attention (QK, softmax, PV)      2.10 GFLOP    525.3 MB     4.0 F/B  memory   54%
  output projection                2.15 GFLOP     34.6 MB    62.1 F/B  memory    4%
  gate + up projection            15.03 GFLOP    239.1 MB    62.9 F/B  memory   24%
  SiLU x up                        0.00 GFLOP      5.5 MB     0.8 F/B  memory    1%
  down projection                  7.52 GFLOP    119.8 MB    62.7 F/B  memory   12%
prefill, one 2K prompt: 1018 us per layer, x32 layers = 32.57 ms
  RMSNorm x2 + residuals           0.08 GFLOP    131.1 MB     0.6 F/B  memory    4%
  QKV projection                 100.66 GFLOP     91.3 MB  1102.7 F/B  compute  10%
  RoPE                             0.03 GFLOP     41.0 MB     0.8 F/B  memory    1%
  attention (QK, softmax, PV)     32.77 GFLOP     41.0 MB   800.0 F/B  compute   3%
  output projection               67.11 GFLOP     66.3 MB  1011.9 F/B  compute   7%
  gate + up projection           469.76 GFLOP    366.0 MB  1283.7 F/B  compute  47%
  SiLU x up                        0.14 GFLOP    172.0 MB     0.8 F/B  memory    5%
  down projection                234.88 GFLOP    191.2 MB  1228.7 F/B  compute  23%
```

The element-wise byte counts are rough (each op is assumed to read and write its activations a few times), and the prefill attention row assumes a fused kernel such as FlashAttention that reads K and V once. The times are ideal: real kernels reach a fraction of peak. The pattern is what matters, and it has four lessons.

1. **At batch 1, the matmuls' intensity is 1 FLOP per byte.** Each weight (2 bytes) is used for 2 FLOPs. The H100's ridge point is 295, so the step runs at a third of a percent of peak compute, and the time is just the time to read the weights. The MLP holds 80% of the weights, so it takes about 80% of the time.
2. **Batching raises the matmuls' intensity, but not attention's.** At batch 64, the same weights serve 64 tokens, so the matmuls' intensity rises to about 62. Attention stays at 4: each sequence reads its own keys and values, and nothing is shared. At batch 64 with 2K contexts, attention is over half the step.
3. **Attention's intensity in decode is the group size.** Each cached key and value (2 bytes per number) is used by the 4 query heads that share it, for 2 FLOPs each, so the intensity is H ÷ KV = 32 ÷ 8 = 4. Batch size does not change it. Only the attention layout does, which is why the next section matters.
4. **In prefill, the matmuls are compute-bound and the element-wise ops show up.** With 2,000 tokens per weight read, the matmuls run at over 1,000 FLOPs per byte. The norms, RoPE and SiLU do 0.03% of the FLOPs but take about 10% of the ideal time, because each one reads and writes the full activation. Fusing them into neighbouring kernels removes those trips, and engines ship fused kernels for exactly these operations (Part 2 writes one).

## Attention variants

The attention layout sets two things: how many bytes of KV cache each token costs, and how many FLOPs each byte of cache feeds in decode. The table assumes the 8B shape (32 layers, 32 query heads of 128).

| Variant | Key/value heads | KV bytes per token (BF16) | Decode attention intensity | Used in |
|---|---|---|---|---|
| Multi-head (MHA) | 32, one per query head | 524,288 | 1 FLOP per byte | The original transformer, Llama 2 7B |
| Grouped-query (GQA) | 8, each shared by 4 query heads | 131,072 | 4 | Llama 3, Qwen3, Mistral |
| Multi-query (MQA) | 1, shared by all | 16,384 | 32 | PaLM, Falcon 7B |
| Multi-head latent (MLA) | none; a compressed latent per token | depends on the latent size | high | DeepSeek-V2 and V3 |

- **Multi-query attention** (Shazeer, 2019) shares one key and one value head across all query heads. The cache shrinks by the head count, but quality can drop.
- **Grouped-query attention** (Ainslie et al., 2023) is the middle ground: a few KV heads, each shared by a group. The GQA paper reports quality close to multi-head attention at speed close to multi-query. Most open models now use it.
- **Multi-head latent attention** (DeepSeek-V2, 2024) caches one small latent vector per token and layer, and projects it back up to per-head keys and values when needed. The DeepSeek-V2 paper reports a 93.3% smaller KV cache than its earlier 67B dense model. The cost is extra matmuls to expand the latent, which engines often fold into the query and output projections.
- **Sliding-window attention** limits each token to the last W tokens, so a layer's cache stops growing at W. Mistral 7B used a 4,096-token window. Gemma 3 mixes the two: five local sliding-window layers (1,024 tokens) for each global layer, which keeps most of the cache short.

For serving, fewer KV bytes per token means more sequences fit in memory, and higher intensity means decode attention wastes less of each byte read. Both raise throughput.

## Positions and RoPE

Attention by itself ignores order: shuffle the keys and the scores shuffle with them. Rotary position embedding (RoPE) fixes that by rotating each query and key, pair of dimensions by pair of dimensions, through an angle proportional to the token's position. The dot product between a rotated query and a rotated key then depends on the distance between their positions.

Three consequences for serving:

- **The cache stores rotated keys.** A token's key is rotated once, at its position, then cached. That works because a token's position never changes once generated.
- **Prefix caching relies on equal positions.** Two requests that share the same first 1,000 tokens produce identical rotated keys for them, so one can reuse the other's cache. The same text at a different offset would not match.
- **Long context is a RoPE setting.** Llama 3.1's config sets `rope_scaling` to type `llama3` with factor 8, which stretches the low-frequency rotations so that positions up to 131,072 stay within the range seen in training. The engine must apply the same scaling, or quality drops beyond the original 8,192 tokens.

## Lab: a decoder layer from scratch

**Tier: [any].** Runs on a laptop CPU in seconds.

Task: write a Llama-style decoder in plain PyTorch tensor operations (`F.linear`, `einsum`, `softmax`; no `nn.MultiheadAttention`, no Hugging Face modules) that:

1. builds a tiny random `LlamaForCausalLM` from `transformers` (2 layers, d = 256, 8 query heads and 2 KV heads of 32, vocabulary 1,000) and borrows its weights;
2. runs a 128-token prompt (prefill) and then one more token using a KV cache (decode);
3. matches Hugging Face's logits to within 1e-4 in both phases;
4. counts FLOPs with `torch.utils.flop_counter.FlopCounterMode` and matches them to a formula you write: 2 × matmul parameters per token, plus attention.

Done when both errors are below 1e-4 and both FLOP counts match your formula exactly.

Hints: RMSNorm is x × rsqrt(mean(x²) + ε) × weight. RoPE in Hugging Face's layout rotates the first half of each head against the second half. Grouped-query attention can be written by repeating each KV head H ÷ KV times. The decode step's query sits at position 128, so the causal mask compares positions, not indexes.

<details>
<summary>Reference solution</summary>

```python
# decoder_from_scratch.py: a Llama-style decoder written with plain tensor ops, checked against
# Hugging Face transformers, with a KV cache for decode and a FLOP count for each phase.
import torch
import torch.nn.functional as F
from torch.utils.flop_counter import FlopCounterMode
from transformers import LlamaConfig, LlamaForCausalLM

torch.manual_seed(0)
cfg = LlamaConfig(vocab_size=1000, hidden_size=256, intermediate_size=688, num_hidden_layers=2,
                  num_attention_heads=8, num_key_value_heads=2, head_dim=32, rope_theta=500000.0,
                  attn_implementation="eager")
ref = LlamaForCausalLM(cfg).eval()
W = {k: v.detach() for k, v in ref.state_dict().items()}
H, KV, HD, EPS = cfg.num_attention_heads, cfg.num_key_value_heads, cfg.head_dim, cfg.rms_norm_eps
THETA = 500000.0  # RoPE base, as in Llama 3 (which also rescales long-range frequencies)


def rms_norm(x, w):
    return w * x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + EPS)


def rope(x, pos):
    """Rotate pairs of dimensions by an angle that grows with position. x: [T, heads, HD]."""
    inv_freq = 1.0 / THETA ** (torch.arange(0, HD, 2).float() / HD)
    angles = pos[:, None].float() * inv_freq[None, :]          # [T, HD/2]
    cos, sin = torch.cat([angles, angles], -1).cos(), torch.cat([angles, angles], -1).sin()
    x1, x2 = x[..., : HD // 2], x[..., HD // 2:]
    rotated = torch.cat([-x2, x1], -1)
    return x * cos[:, None, :] + rotated * sin[:, None, :]


def layer(x, i, pos, cache):
    """One decoder layer. x: [T, d] for the new tokens; cache holds K and V of earlier tokens."""
    p = f"model.layers.{i}."
    h = rms_norm(x, W[p + "input_layernorm.weight"])
    q = F.linear(h, W[p + "self_attn.q_proj.weight"]).view(-1, H, HD)
    k = F.linear(h, W[p + "self_attn.k_proj.weight"]).view(-1, KV, HD)
    v = F.linear(h, W[p + "self_attn.v_proj.weight"]).view(-1, KV, HD)
    q, k = rope(q, pos), rope(k, pos)
    if i in cache:                                              # decode: append to the cache
        k = torch.cat([cache[i][0], k]); v = torch.cat([cache[i][1], v])
    cache[i] = (k, v)
    k, v = k.repeat_interleave(H // KV, 1), v.repeat_interleave(H // KV, 1)   # GQA: share KV heads
    scores = torch.einsum("qhd,khd->hqk", q, k) / HD ** 0.5    # [H, new tokens, all tokens]
    q_pos, k_pos = pos[:, None], torch.arange(k.shape[0])[None, :]
    scores = scores.masked_fill(k_pos > q_pos, float("-inf"))  # causal mask
    out = torch.einsum("hqk,khd->qhd", scores.softmax(-1), v).reshape(-1, H * HD)
    x = x + F.linear(out, W[p + "self_attn.o_proj.weight"])
    h = rms_norm(x, W[p + "post_attention_layernorm.weight"])
    gate = F.linear(h, W[p + "mlp.gate_proj.weight"])
    up = F.linear(h, W[p + "mlp.up_proj.weight"])
    return x + F.linear(F.silu(gate) * up, W[p + "mlp.down_proj.weight"])


def forward(ids, start, cache):
    pos = torch.arange(start, start + len(ids))
    x = W["model.embed_tokens.weight"][ids]
    for i in range(cfg.num_hidden_layers):
        x = layer(x, i, pos, cache)
    return F.linear(rms_norm(x, W["model.norm.weight"]), W["lm_head.weight"])


ids = torch.randint(0, cfg.vocab_size, (129,))
prompt, nxt = ids[:128], ids[128:]
with torch.no_grad():
    want = ref(ids[None]).logits[0]
    cache = {}
    got_prefill = forward(prompt, 0, cache)
    got_decode = forward(nxt, 128, cache)
print(f"prefill max error vs HF: {(got_prefill - want[:128]).abs().max():.2e}")
print(f"decode  max error vs HF: {(got_decode - want[128:]).abs().max():.2e}")

# FLOPs: the counter sees every matmul. Compare with 2 x matmul params per token + attention scores.
L, d, I, V = cfg.num_hidden_layers, cfg.hidden_size, cfg.intermediate_size, cfg.vocab_size
matmul_params = L * (2 * d * H * HD + 2 * d * KV * HD + 3 * d * I) + V * d


def predicted(new, context):
    # QK^T and scores x V: 2 FLOPs x new x context x HD per head, twice. The naive code scores
    # masked positions too, so prefill counts the full T x T square.
    return 2 * new * matmul_params + L * 2 * 2 * new * context * H * HD


def count(fn):
    with FlopCounterMode(display=False) as fc, torch.no_grad():
        fn()
    return fc.get_total_flops()


prefill = count(lambda: forward(prompt, 0, {}))
cache = {}
with torch.no_grad():
    forward(prompt, 0, cache)                   # fill the cache, then count one decode step
decode = count(lambda: forward(nxt, 128, cache))
print(f"prefill, 128 tokens:  counted {prefill / 1e6:6.2f} MFLOP, formula {predicted(128, 128) / 1e6:6.2f}")
print(f"decode, 1 token @129: counted {decode / 1e6:6.2f} MFLOP, formula {predicted(1, 129) / 1e6:6.2f}")
```

Output with PyTorch 2.15 and transformers 5.22 on a laptop CPU:

```text
prefill max error vs HF: 1.04e-06
decode  max error vs HF: 8.20e-07
prefill, 128 tokens:  counted 453.51 MFLOP, formula 453.51
decode, 1 token @129: counted   3.55 MFLOP, formula   3.55
```

What to notice:

- Prefill costs 128 times the matmul FLOPs of decode, plus attention, but runs as a handful of large matmuls. Decode is the same matmuls with one row each.
- The decode step with the cache gives the same logits as recomputing all 129 tokens. The cache is purely a way to skip work.
- The naive attention computes the masked half of the prefill score square and throws it away. Fused kernels skip those blocks, which is one reason the prefill row in the table above uses half the square.
- Errors of about 1e-6 are float32 rounding. In BF16 expect about 1e-2, which is why numerical tests for kernels compare against a reference with a tolerance chosen per precision.

Extensions, in rising difficulty: run two sequences of different lengths in one batch with padding and a mask; replace the einsums with `F.scaled_dot_product_attention` and check the FLOP count; add Llama 3's `rope_scaling` and match a config that uses it.

</details>

## Interview angle

- **"Walk me through a forward pass of a decoder on a GPU."** Embedding lookup; per layer: RMSNorm, fused QKV matmul, RoPE, attention over the KV cache, output matmul and residual add, RMSNorm, gate and up matmuls, SiLU and multiply, down matmul and residual add; final norm and LM head; sampling. Then say what limits each phase: in decode, reading weights and KV cache; in prefill, the matmuls' arithmetic.
- **"Why does batching help decode throughput so much?"** Each step reads every weight once, whatever the batch size, so more sequences share the same read. The KV cache is the exception: each sequence reads its own, so batching does nothing for attention's intensity.
- **"What does GQA buy you in serving?"** A KV cache smaller by the group size, so more concurrent sequences, and fewer bytes per decode step. Its decode attention intensity equals the group size.
- **"Which operations would you fuse first, and why?"** The element-wise ones next to matmuls or each other: residual add with RMSNorm, SiLU with the multiply, RoPE with the QKV output. They do almost no arithmetic but each reads and writes the full activation.

## Check yourself

<details>
<summary>At batch 1, roughly what share of Llama 3.1 8B's decode step goes to the MLP, and why?</summary>

About 80%. At batch 1 every matmul is memory-bound, so time follows bytes read, which follows weight count. The MLP's three matrices hold 176M of each layer's 218M weights, about 81%.

</details>

<details>
<summary>Why does attention's arithmetic intensity in decode stay at 4 FLOPs per byte for Llama 3.1 8B however large the batch?</summary>

Each sequence reads its own keys and values; nothing is shared between sequences. Each cached number (2 bytes) is used by the 4 query heads that share its KV head, for 2 FLOPs each: 8 FLOPs per 2 bytes, or 4. The intensity equals query heads divided by KV heads.

</details>

<details>
<summary>At what context length do attention's FLOPs per token equal the matmuls' for Llama 3.1 8B?</summary>

Attention costs 4 × 32 layers × 32 heads × 128 × c = 524,288 × c FLOPs per token. Setting that equal to 15.0 GFLOP gives c ≈ 28,600 tokens. Beyond that, the 2 × parameters rule undercounts by more than half.

</details>

<details>
<summary>A model switches from MHA to GQA with 8 KV heads and 32 query heads. Name two effects on serving.</summary>

The KV cache per token shrinks 4 times, so about 4 times as many tokens of context fit in the same memory, which allows larger batches or longer contexts. Decode attention reads 4 times fewer bytes per step, and its intensity rises from 1 to 4 FLOPs per byte.

</details>

<details>
<summary>Why can a cached prefix be reused only when it sits at the same positions in the new request?</summary>

Keys are cached after RoPE has rotated them by their positions. The same tokens at a different offset would have different rotations, so their cached keys would be wrong for the new request. A shared system prompt at the start of every request has the same positions each time, which is why prefix caching works for it.

</details>

<details>
<summary>In the prefill table, the norms, RoPE and SiLU do almost none of the FLOPs. Why do they take about 10% of the ideal time?</summary>

They are memory-bound at under 1 FLOP per byte: each reads and writes the whole 2,000 × 4,096 (or × 14,336) activation, while the matmuls next to them are compute-bound. Their time is set by bytes, not arithmetic. Fusing them into the neighbouring kernels removes most of those reads and writes.

</details>

## Further reading

- [Attention is all you need](https://arxiv.org/abs/1706.03762): the original transformer and multi-head attention.
- [Fast transformer decoding: one write-head is all you need](https://arxiv.org/abs/1911.02150): multi-query attention, motivated by decode's memory bandwidth.
- [GQA](https://arxiv.org/abs/2305.13245): grouped-query attention and how to convert a multi-head checkpoint to it.
- [DeepSeek-V2](https://arxiv.org/abs/2405.04434): multi-head latent attention and the 93.3% KV cache reduction.
- [Mistral 7B](https://arxiv.org/abs/2310.06825) and the [Gemma 3 technical report](https://arxiv.org/abs/2503.19786): sliding-window attention, alone and interleaved with global layers.
- [RoFormer](https://arxiv.org/abs/2104.09864): rotary position embedding.
- [The Llama 3 paper](https://arxiv.org/abs/2407.21783): the architecture this chapter walks through.
- [Hugging Face's Llama implementation](https://github.com/huggingface/transformers/blob/main/src/transformers/models/llama/modeling_llama.py): the reference the lab checks against; short and readable.
- [PyTorch FlopCounterMode](https://docs.pytorch.org/docs/stable/generated/torch.utils.flop_counter.FlopCounterMode.html): counting FLOPs of any PyTorch code.
- [Making deep learning go brrrr from first principles](https://horace.io/brrr_intro.html) by Horace He: compute, memory and overhead as the three limits, with the case for fusion.
