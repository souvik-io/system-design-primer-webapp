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
