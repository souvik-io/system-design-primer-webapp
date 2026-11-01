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
