# Models and machines

Numbers only make sense against a fixed model and a fixed machine. This handbook uses three models and three machines throughout, so a figure in Part 5 can be checked against one in Part 1. This chapter introduces them, shows how to read a model's shape from its `config.json`, and derives the three numbers every later chapter needs: parameter count, weight bytes, and KV cache bytes per token.

Prerequisites: [the KV cache](/learn/llm-inference#the-kv-cache) and [GPU memory](/learn/gpus-for-ai#gpu-memory).

## The three models

| Model | Why it is here | Where its labs run |
|---|---|---|
| **Llama 3.2 1B** | Small enough for a laptop, same architecture as its larger siblings | [Mac] |
| **Llama 3.1 8B** | The main running example: the size many teams serve, and it fits one GPU | [1 GPU] |
| **Qwen3-30B-A3B** | A mixture-of-experts (MoE) model: 30B parameters stored, about 3B used per token | [1 GPU], H100 |

All three are decoder-only transformers with grouped-query attention, SwiGLU MLPs and rotary position embeddings, so one set of formulas covers them, with one change for the MoE layers. The system design chapters use Llama 3.1 70B. This handbook moves to 8B because it fits one rented GPU, which makes the labs cheap.

## Reading config.json

Every model on Hugging Face ships a `config.json` that states its shape. These are the fields that matter for serving, with Llama 3.1 8B's values:

| Field | 8B value | Meaning |
|---|---|---|
| `hidden_size` | 4,096 | Width d of the vector that carries each token between layers |
| `num_hidden_layers` | 32 | Number of decoder layers, L |
| `num_attention_heads` | 32 | Query heads, H |
| `num_key_value_heads` | 8 | Key/value heads, KV. Fewer than H means grouped-query attention |
| `head_dim` | 128 | Width of each head. Often d ÷ H, but not always |
| `intermediate_size` | 14,336 | Width of the MLP's hidden layer, I |
| `vocab_size` | 128,256 | Number of tokens the model knows, V |
| `tie_word_embeddings` | false | Whether the output layer reuses the input embedding matrix |
| `max_position_embeddings` | 131,072 | Longest context the model was built for |
| `rope_scaling` | llama3, factor 8 | How rotary positions were stretched for long context |
| `torch_dtype` | bfloat16 | The precision the weights ship in |

The MoE model adds `num_experts` (128), `num_experts_per_tok` (8) and `moe_intermediate_size` (768): each layer holds 128 small MLPs and sends each token through 8 of them.

Configs vary by family. Some omit `head_dim`, some name fields differently, and models with other attention schemes (DeepSeek's latent attention, sliding windows) add fields the formulas below do not cover. Read the config before trusting any calculator, including the one in this chapter's lab.

## Counting parameters

A Llama-style layer has four attention matrices and three MLP matrices. With the 8B values:

| Piece | Shape | Parameters |
|---|---|---|
| Q projection | d × (H × head_dim) = 4,096 × 4,096 | 16.8M |
| K projection | d × (KV × head_dim) = 4,096 × 1,024 | 4.2M |
| V projection | 4,096 × 1,024 | 4.2M |
| Output projection | 4,096 × 4,096 | 16.8M |
| MLP gate, up, down | 3 × 4,096 × 14,336 | 176.2M |
| Two RMSNorm weights | 2 × 4,096 | 8K |
| **One layer** | | **218.1M** |

Thirty-two layers hold 6.98B parameters. The input embedding (V × d = 525.3M) and the separate output layer, the LM head (another 525.3M), bring the total to 8.03B.

Two counts matter, and they differ:

- **Stored parameters** decide memory: 8.03B.
- **Parameters in matmuls per token** decide compute: 7.50B. The input embedding is a table lookup, which copies one row per token instead of multiplying, so it is left out.

Each matmul parameter costs one multiply and one add per token, so a token costs about 2 × 7.50B = 15.0 GFLOP, before attention scores (the next chapter adds those).

**Tied embeddings.** Llama 3.2 1B sets `tie_word_embeddings` to true, so the LM head reuses the embedding matrix. The 262.7M-parameter table is stored once but used in a matmul at the output, so stored and per-token counts are both 1.24B.

**Mixture of experts.** In Qwen3-30B-A3B each layer's MLP is 128 experts of 3 × 2,048 × 768 = 4.7M parameters, plus a 2,048 × 128 router that scores the experts. Stored: 48 layers × (18.9M attention + 604M experts + 0.26M router) plus embeddings = 30.53B. Per token, only 8 experts run: 3.04B parameters in matmuls. Qwen's model card says 3.3B activated; the gap is the 0.31B input embedding, which this chapter counts as a lookup. Memory is sized by the 30.5B, compute by the 3B. Part 1's MoE chapter returns to what that does to serving.

## Weights in bytes

Weight memory is stored parameters times bytes per parameter:

| Model | BF16 (2 bytes) | FP8 (1 byte) | INT4 (0.5 bytes) |
|---|---|---|---|
| Llama 3.2 1B | 2.5 GB | 1.2 GB | 0.6 GB |
| Llama 3.1 8B | 16.1 GB | 8.0 GB | 4.0 GB |
| Qwen3-30B-A3B | 61.1 GB | 30.5 GB | 15.3 GB |

The INT4 column is a floor. Real 4-bit formats store a scale for each small group of weights. One 16-bit scale per 128 weights adds 16 ÷ 128 = 0.125 bits per weight, and many tools leave the embeddings and LM head in 16 bits, so a "4-bit" checkpoint is usually larger than half a byte per parameter. Part 4 covers the formats.

## KV cache per token

Each layer stores one key and one value vector per KV head for every token in the context:

KV bytes per token = 2 (K and V) × layers × KV heads × head_dim × bytes per value

| Model | Calculation in BF16 | Bytes per token | One 8K-token sequence |
|---|---|---|---|
| Llama 3.2 1B | 2 × 16 × 8 × 64 × 2 | 32,768 | 0.27 GB |
| Llama 3.1 8B | 2 × 32 × 8 × 128 × 2 | 131,072 | 1.07 GB |
| Qwen3-30B-A3B | 2 × 48 × 4 × 128 × 2 | 98,304 | 0.81 GB |

Grouped-query attention is why these are small. If the 8B model had 32 KV heads, one per query head, its cache would be 524,288 bytes per token, four times larger. The MoE model is 3.8 times bigger than the 8B on disk but needs less cache per token, because it has only 4 KV heads. The cache depends on the attention layout, not the parameter count.

Try it with the larger Llama models: pick a model, a GPU and a context length, and see how many requests fit.

```widget
kv-cache-calculator
```

## The three machines

| Machine | Memory | Bandwidth | Dense BF16 or FP16 | Ridge point | Role here |
|---|---|---|---|---|---|
| NVIDIA H100 SXM | 80 GB HBM3 | 3.35 TB/s | 989 TFLOPS | 295 FLOPs/byte | The reference numbers, and the FP8 labs |
| NVIDIA L4 | 24 GB GDDR6 | 300 GB/s | 121 TFLOPS | 403 FLOPs/byte | The cheap rental for most [1 GPU] labs |
| Apple M2, 8-core GPU, 8 GB | 8 GB unified, 5.7 GB usable by the GPU | 100 GB/s | 2.5 TFLOPS FP16, measured | about 30 FLOPs/byte | The laptop for [Mac] labs |

Sources and notes:

- The H100 figures and their sparsity footnote are explained in [GPUs and accelerators](/learn/gpus-for-ai#gpu-memory).
- NVIDIA's L4 datasheet prints 242 BF16 teraFLOPS "with sparsity" and says dense figures are half, so 121 dense.
- Apple gives the M2 100 GB/s of unified memory bandwidth. Apple does not publish an FP16 matmul figure for the 8-core GPU, so the 2.5 TFLOPS is measured with the probe in [the arithmetic of inference](/learn/inference-arithmetic#measuring-your-own-roofline), which also measured 84 GB/s for a large copy. The 5.7 GB is what `torch.mps.recommended_max_memory()` reported on that machine; macOS keeps the rest for itself.

The ridge point is peak FLOPs divided by bandwidth: the arithmetic intensity at which an operation stops being limited by memory. [Compute versus memory bandwidth](/learn/gpus-for-ai#compute-versus-memory-bandwidth) explains it, and Part 1 uses it constantly. Note the L4: it has less bandwidth per FLOP than an H100, so decode, which is bandwidth-bound, is relatively slower on it.

## What fits where

Usable memory is 90% of GPU memory, keeping 10% for activations and the runtime, as the system design chapters do, and 5.7 GB on the M2. KV cache gets what the weights leave.

| Model and format | M2 (5.7 GB) | L4 (21.6 GB) | H100 (72 GB) |
|---|---|---|---|
| 1B, BF16 (2.5 GB) | fits, 3.2 GB for cache, about 98K tokens | fits, 584K tokens | fits |
| 8B, BF16 (16.1 GB) | no | fits, 5.5 GB for cache, about 42K tokens | fits, 55.9 GB, about 427K tokens |
| 8B, FP8 (8.0 GB) | no | fits, about 104K tokens | fits, about 488K tokens |
| 8B, INT4 (4.0 GB and up) | barely; little room for cache | fits | fits |
| 30B-A3B, BF16 (61.1 GB) | no | no | fits, 10.9 GB, about 111K tokens |
| 30B-A3B, FP8 (30.5 GB) | no | no | fits, about 422K tokens |
| 30B-A3B, INT4 (15.3 GB and up) | no | fits, about 64K tokens | fits |

Three things to take from the table:

- **Cache room, not weights, decides how many users fit.** The 8B model fits an L4 in BF16, but 42K tokens of cache is about 20 conversations of 2,000 tokens.
- **Quantizing weights buys cache.** FP8 weights on the L4 leave room for about 2.5 times as many cached tokens as BF16.
- **MoE models are memory-hungry.** Qwen3-30B-A3B computes like a 3B model but needs a big GPU, or heavy quantization, just to load.

## Lab: a model calculator

**Tier: [any].** Write the tool that later labs use to size models.

Task: write `labs/model_stats.py`. Given one or more paths to `config.json` files, print for each model:

1. layers, hidden size, query heads, KV heads and head dimension;
2. stored parameters and parameters in matmuls per token;
3. weight bytes in BF16, FP8 and INT4;
4. FLOPs per token, ignoring attention scores;
5. KV cache bytes per token, and for one 8K-token sequence.

Download the configs with `curl -L https://huggingface.co/<repo>/raw/main/config.json`. Meta's own Llama repositories need you to accept a licence first; mirrors such as `unsloth/Llama-3.2-1B-Instruct` and `unsloth/Meta-Llama-3.1-8B-Instruct` publish the same configs. Qwen's is at `Qwen/Qwen3-30B-A3B`.

Done when your parameter counts are within 1% of the model cards (1.23B, 8.03B, 30.5B total) and the KV numbers match the table above.

Stretch: run it on `deepseek-ai/DeepSeek-V3`'s config. Its KV numbers will come out wrong, because DeepSeek's multi-head latent attention caches a compressed vector instead of per-head keys and values. Read the config fields `kv_lora_rank` and `qk_rope_head_dim` and work out what it really caches per token per layer; [the next chapter](/learn/transformer-as-workload#attention-variants) describes the scheme.

<details>
<summary>Reference solution</summary>

```python
# model_stats.py: parameter count, weight bytes and KV cache bytes from a Hugging Face config.json.
# Handles Llama-style dense models and Qwen3-style mixture-of-experts models.
import json
import sys

BYTES = {"BF16": 2, "FP8": 1, "INT4": 0.5}


def stats(cfg: dict) -> dict:
    d = cfg["hidden_size"]
    layers = cfg["num_hidden_layers"]
    heads = cfg["num_attention_heads"]
    kv_heads = cfg.get("num_key_value_heads", heads)
    head_dim = cfg.get("head_dim") or d // heads
    vocab = cfg["vocab_size"]

    # Attention: Q and O are heads x head_dim wide, K and V are kv_heads x head_dim wide.
    attn = d * heads * head_dim + 2 * d * kv_heads * head_dim + heads * head_dim * d
    if cfg["model_type"].startswith("qwen3"):
        attn += 2 * head_dim  # Qwen3 normalizes each query and key head (q_norm, k_norm)

    # MLP: gate, up and down projections. An MoE layer has one set per expert plus a router.
    if "num_experts" in cfg:
        experts, top_k = cfg["num_experts"], cfg["num_experts_per_tok"]
        expert = 3 * d * cfg["moe_intermediate_size"]
        router = d * experts
        mlp_total, mlp_active = experts * expert + router, top_k * expert + router
    else:
        mlp_total = mlp_active = 3 * d * cfg["intermediate_size"]

    norms = 2 * d  # two RMSNorms per layer
    embed = vocab * d
    head = 0 if cfg.get("tie_word_embeddings") else vocab * d
    total = embed + head + layers * (attn + mlp_total + norms) + d
    # Matmul weights one token multiplies through (the embedding lookup is a copy, not a matmul).
    active_matmul = layers * (attn + mlp_active) + vocab * d
    return {
        "layers": layers, "d": d, "heads": heads, "kv_heads": kv_heads, "head_dim": head_dim,
        "total": total, "active_matmul": active_matmul,
        "kv_bytes_per_token": 2 * layers * kv_heads * head_dim * 2,  # K and V, BF16
    }


def report(path: str) -> None:
    cfg = json.load(open(path))
    s = stats(cfg)
    print(f"{path.split('/')[-1]}: {s['layers']} layers, d={s['d']}, "
          f"{s['heads']} heads / {s['kv_heads']} KV heads of {s['head_dim']}")
    print(f"  parameters: {s['total'] / 1e9:.2f}B stored, "
          f"{s['active_matmul'] / 1e9:.2f}B in matmuls per token")
    print("  weights: " + ", ".join(f"{k} {s['total'] * b / 1e9:.1f} GB" for k, b in BYTES.items()))
    print(f"  FLOPs per token (matmuls, no attention scores): {2 * s['active_matmul'] / 1e9:.1f} GFLOP")
    kv = s["kv_bytes_per_token"]
    print(f"  KV cache: {kv:,} bytes per token, {kv * 8192 / 1e9:.2f} GB for one 8K-token sequence")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p)
```

```text
Llama-3.2-1B-Instruct.json: 16 layers, d=2048, 32 heads / 8 KV heads of 64
  parameters: 1.24B stored, 1.24B in matmuls per token
  weights: BF16 2.5 GB, FP8 1.2 GB, INT4 0.6 GB
  FLOPs per token (matmuls, no attention scores): 2.5 GFLOP
  KV cache: 32,768 bytes per token, 0.27 GB for one 8K-token sequence
Meta-Llama-3.1-8B-Instruct.json: 32 layers, d=4096, 32 heads / 8 KV heads of 128
  parameters: 8.03B stored, 7.50B in matmuls per token
  weights: BF16 16.1 GB, FP8 8.0 GB, INT4 4.0 GB
  FLOPs per token (matmuls, no attention scores): 15.0 GFLOP
  KV cache: 131,072 bytes per token, 1.07 GB for one 8K-token sequence
Qwen3-30B-A3B.json: 48 layers, d=2048, 32 heads / 4 KV heads of 128
  parameters: 30.53B stored, 3.04B in matmuls per token
  weights: BF16 61.1 GB, FP8 30.5 GB, INT4 15.3 GB
  FLOPs per token (matmuls, no attention scores): 6.1 GFLOP
  KV cache: 98,304 bytes per token, 0.81 GB for one 8K-token sequence
```

All three totals are within 1% of the model cards (Llama 3.2 1B's card says 1.23B, which rounds the same 1.236B down). Things the solution handles that are easy to miss: `head_dim` is not always d ÷ H (Qwen3-30B-A3B has d = 2,048 but 32 heads of 128), tied embeddings are stored once, and Qwen3 adds a small norm on each query and key head.

</details>

## Interview angle

- **"How much GPU memory do you need to serve model X to N users at context C?"** Weights (parameters × bytes), plus KV cache (N × C × bytes per token, from the config), plus about 10% for activations and the runtime. Then divide by GPU memory and round up to a GPU count the parallelism allows. State the precision you assumed.
- **"Why does this MoE model need more GPUs than a dense model with the same per-token compute?"** Memory holds every expert, even though each token uses a few. Compute follows active parameters, memory follows total parameters.
- **"Why do newer models have so few KV heads?"** Grouped-query attention shares each key and value head across several query heads. It shrinks the cache, and the bytes decode reads per sequence, by the group size, with little quality loss according to the GQA paper.

## Check yourself

<details>
<summary>Llama 3.1 8B has 8.03B parameters, but a token's matmuls use 7.50B. Where do the other 0.53B go?</summary>

They are the input embedding table, V × d = 128,256 × 4,096 ≈ 525M parameters. Looking up a token's row is a copy, not a matrix multiply, so it costs memory but almost no compute. The LM head at the output is a separate matrix of the same size, and it is a real matmul, so it counts.

</details>

<details>
<summary>Work out the KV cache for one 32K-token conversation on Llama 3.1 8B in BF16, and how many such conversations fit on one H100 beside the weights.</summary>

131,072 bytes × 32,768 tokens ≈ 4.3 GB per conversation. The H100 leaves about 72 − 16.1 = 55.9 GB for cache, so about 13 conversations fit.

</details>

<details>
<summary>Qwen3-30B-A3B costs about 6 GFLOP per token and Llama 3.1 8B about 15. Why can the 8B model still be the cheaper one to serve?</summary>

The MoE model must hold all 30.5B parameters in memory: 61 GB in BF16, so it needs an H100-class GPU, or quantization, where the 8B fits an L4. Every decode step also reads the experts that the batch's tokens choose, and with large batches that approaches all of them. Fewer FLOPs per token help only if the memory and bandwidth costs do not dominate.

</details>

<details>
<summary>Why does the INT4 column say "and up"?</summary>

Four-bit formats store extra numbers: a scale, sometimes a zero point, per small group of weights. One 16-bit scale per 128 weights adds 0.125 bits per weight, and tools often keep the embedding and output layers in 16 bits. The real checkpoint is larger than half a byte per parameter.

</details>

<details>
<summary>Which is relatively worse for decode compared with prefill, the L4 or the H100? Use the ridge points.</summary>

The L4. Its ridge point is about 403 FLOPs per byte against the H100's 295, so it has less bandwidth for each FLOP it can do. Decode is limited by bandwidth: the L4 has 9% of the H100's bandwidth but 12% of its compute, so decode suffers more than prefill on it.

</details>

## Further reading

- Model configs and cards on Hugging Face: [Llama 3.2 1B Instruct (mirror)](https://huggingface.co/unsloth/Llama-3.2-1B-Instruct/blob/main/config.json), [Llama 3.1 8B Instruct (mirror)](https://huggingface.co/unsloth/Meta-Llama-3.1-8B-Instruct/blob/main/config.json), [Meta's Llama 3.2 1B card](https://huggingface.co/meta-llama/Llama-3.2-1B) and [Qwen3-30B-A3B](https://huggingface.co/Qwen/Qwen3-30B-A3B): the shapes used here and the published parameter counts.
- [The Llama 3 paper](https://arxiv.org/abs/2407.21783): the architecture and why grouped-query attention was used.
- [GQA: training generalized multi-query transformer models](https://arxiv.org/abs/2305.13245): grouped-query attention and its quality compared with multi-head attention.
- [NVIDIA L4](https://www.nvidia.com/en-us/data-center/l4/) and [NVIDIA H100](https://www.nvidia.com/en-us/data-center/h100/) product pages: memory, bandwidth and the sparsity footnotes.
- [Apple's M2 announcement](https://www.apple.com/newsroom/2022/06/apple-unveils-m2-with-breakthrough-performance-and-capabilities/): the 100 GB/s unified memory bandwidth.
- [PyTorch MPS backend](https://docs.pytorch.org/docs/stable/mps.html): `recommended_max_memory` and the other MPS memory functions.
