# moe_arithmetic.py: bytes, FLOPs and ideal decode step time for Qwen3-30B-A3B against Llama 3.1 8B on one H100.
#
# A dense model reads every weight once per decode step, whatever the batch. An MoE model reads its attention
# weights and router every step, but only the experts that at least one token in the batch chose. With E
# experts, top-k routing and B tokens routed independently and evenly, an expert is skipped by one token with
# probability (1 - k/E), so the expected number of experts touched per layer is E * (1 - (1 - k/E)^B).
# Real routers are uneven, which lowers that count a little; expert_load.py measures it.
#
# Each part of the step takes max(FLOPs / peak, bytes / bandwidth), as in step_model.py (chapter 1.2).
# Run: python moe_arithmetic.py      (plain Python, no packages needed)

PEAK, BW, USABLE = 989e12, 3.35e12, 80e9 * 0.9          # H100 SXM: dense BF16, HBM3, 90% of memory usable
BYTES, CONTEXT = 2, 2000                                 # BF16 weights and KV cache; 2,000 tokens per sequence

# Qwen3-30B-A3B, from its config.json: 48 layers, d = 2048, 32 query and 4 KV heads of 128,
# 128 experts of width 768 per layer, 8 chosen per token, vocabulary 151,936, untied embeddings.
L, D, HQ, HKV, HD, E, K, I, V = 48, 2048, 32, 4, 128, 128, 8, 768, 151_936
attn = D * HQ * HD * 2 + D * HKV * HD * 2                # q and o projections, k and v projections
router = D * E
expert = 3 * D * I                                       # gate, up and down
always = L * (attn + router) + V * D                     # read every step: attention, routers, LM head
moe = {"name": "Qwen3-30B-A3B", "stored": L * (attn + router + E * expert) + 2 * V * D,
       "kv": 2 * L * HKV * HD * BYTES, "attn_flops": 4 * L * HQ * HD}

# Llama 3.1 8B: 7.50B parameters in matmuls (8.03B stored, counting the input embedding).
dense = {"name": "Llama 3.1 8B", "stored": 8.03e9, "kv": 2 * 32 * 8 * 128 * BYTES, "attn_flops": 4 * 32 * 32 * 128}


def experts_touched(batch):
    return E * (1 - (1 - K / E) ** batch)


def step(model, batch):
    """Ideal decode step: (seconds, weight bytes read, experts touched per layer or None)."""
    if model is moe:
        touched = experts_touched(batch)
        w_bytes = (always + L * touched * expert) * BYTES
        w_flops = batch * 2 * (always + L * K * expert)
    else:
        touched, w_bytes, w_flops = None, 7.50e9 * BYTES, batch * 2 * 7.50e9
    a_flops = batch * CONTEXT * model["attn_flops"]
    a_bytes = batch * CONTEXT * model["kv"]
    seconds = max(w_flops / PEAK, w_bytes / BW) + max(a_flops / PEAK, a_bytes / BW)
    return seconds, w_bytes, touched


print(f"Qwen3-30B-A3B: {moe['stored'] / 1e9:.2f}B parameters stored, "
      f"{(always + L * K * expert) / 1e9:.2f}B in matmuls per token; one expert is {expert / 1e6:.2f}M\n")
print(f"{'batch':>5} | {'experts/layer':>13} {'weights read':>12} {'step':>8} {'tok/s':>7} | "
      f"{'8B: weights':>11} {'step':>8} {'tok/s':>7}")
for batch in (1, 2, 4, 8, 16, 32, 64, 128, 256, 512):
    s_moe, b_moe, touched = step(moe, batch)
    s_dense, b_dense, _ = step(dense, batch)
    print(f"{batch:5d} | {touched:13.1f} {b_moe / 1e9:9.1f} GB {s_moe * 1e3:5.2f} ms {batch / s_moe:7.0f} | "
          f"{b_dense / 1e9:8.1f} GB {s_dense * 1e3:5.2f} ms {batch / s_dense:7.0f}")

print("\nMemory on one H100 (72 GB usable), BF16 weights:")
for model in (moe, dense):
    free = USABLE - model["stored"] * BYTES
    print(f"  {model['name']:14s} weights {model['stored'] * BYTES / 1e9:5.1f} GB, KV room {max(free, 0) / 1e9:5.1f} GB, "
          f"{int(max(free, 0) // (CONTEXT * model['kv'])):4d} sequences of {CONTEXT:,} tokens")

ridge = PEAK / BW
print(f"\nBatch where the weight matmuls reach the ridge point ({ridge:.0f} FLOPs per byte), all experts touched:")
print(f"  {dense['name']:14s} {ridge * 7.50e9 * BYTES / (2 * 7.50e9):5.0f} sequences")
print(f"  {moe['name']:14s} {ridge * (always + L * E * expert) * BYTES / (2 * (always + L * K * expert)):5.0f} sequences")
