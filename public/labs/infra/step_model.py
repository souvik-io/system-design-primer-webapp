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
