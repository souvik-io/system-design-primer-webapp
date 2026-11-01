# flash_attention.py: a causal FlashAttention forward pass in Triton, tested and timed (chapter 2.4).
#
# Each program owns BLOCK_M query rows of one head. It loads them once, then walks the keys and values in blocks
# of BLOCK_N, keeping a running max, a running sum and an output accumulator (online softmax), so the N x N score
# matrix never exists in memory. Compared with:
#   naive:  scores = Q @ K^T, softmax, @ V, materialising the full N x N matrix (as plain PyTorch would)
#   SDPA:   torch.nn.functional.scaled_dot_product_attention, which picks a fused backend on its own
#
# Needs an NVIDIA GPU. Run: python flash_attention.py   or: modal run modal_run.py --script flash_attention.py --gpu H100
import math

import torch
import triton
import triton.language as tl


@triton.jit
def attn_fwd(Q, K, V, O, sm_scale, N, D: tl.constexpr, BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr):
    start_m = tl.program_id(0)
    bh = tl.program_id(1)                                   # which (batch, head)
    offs_m = start_m * BLOCK_M + tl.arange(0, BLOCK_M)
    offs_n = tl.arange(0, BLOCK_N)
    offs_d = tl.arange(0, D)
    base = bh.to(tl.int64) * N * D
    q = tl.load(Q + base + offs_m[:, None] * D + offs_d[None, :], mask=offs_m[:, None] < N, other=0.0)

    m_i = tl.full([BLOCK_M], -float("inf"), tl.float32)    # running max of each row's scores
    l_i = tl.zeros([BLOCK_M], tl.float32)                   # running sum of exp(score - max)
    acc = tl.zeros([BLOCK_M, D], tl.float32)                # running, unnormalised output
    qk_scale = sm_scale * 1.4426950408889634                # fold log2(e) in, so exp2 can replace exp

    hi = tl.minimum((start_m + 1) * BLOCK_M, N)             # causal: no key after the block's last query
    for start_n in range(0, hi, BLOCK_N):
        cols = start_n + offs_n
        k = tl.load(K + base + cols[None, :] * D + offs_d[:, None], mask=cols[None, :] < N, other=0.0)
        s = tl.dot(q, k) * qk_scale                         # [BLOCK_M, BLOCK_N] scores, in registers only
        s = tl.where((offs_m[:, None] >= cols[None, :]) & (cols[None, :] < N), s, -float("inf"))
        m_new = tl.maximum(m_i, tl.max(s, 1))
        alpha = tl.exp2(m_i - m_new)                        # rescales everything accumulated so far
        p = tl.exp2(s - m_new[:, None])
        l_i = l_i * alpha + tl.sum(p, 1)
        v = tl.load(V + base + cols[:, None] * D + offs_d[None, :], mask=cols[:, None] < N, other=0.0)
        acc = acc * alpha[:, None] + tl.dot(p.to(v.dtype), v)
        m_i = m_new

    acc = acc / l_i[:, None]
    tl.store(O + base + offs_m[:, None] * D + offs_d[None, :], acc.to(O.dtype.element_ty), mask=offs_m[:, None] < N)


def flash_attention(q, k, v, block_m=128, block_n=64):
    B, H, N, D = q.shape
    o = torch.empty_like(q)
    grid = (triton.cdiv(N, block_m), B * H)
    attn_fwd[grid](q, k, v, o, 1.0 / math.sqrt(D), N, D=D, BLOCK_M=block_m, BLOCK_N=block_n, num_warps=8, num_stages=3)
    return o


def naive_attention(q, k, v):
    N, D = q.shape[-2:]
    s = (q @ k.transpose(-1, -2)) / math.sqrt(D)            # the full B x H x N x N matrix, in HBM
    s = s.masked_fill(torch.ones(N, N, dtype=torch.bool, device=q.device).triu(1), float("-inf"))
    return torch.softmax(s.float(), dim=-1).to(q.dtype) @ v


if __name__ == "__main__":
    p = torch.cuda.get_device_properties(0)
    print(f"{p.name}, PyTorch {torch.__version__}, Triton {triton.__version__}")
    B, H, D = 4, 16, 128
    print(f"causal attention forward, BF16, batch {B}, {H} heads of {D}; TFLOP/s count only the unmasked half\n")
    print(f"{'N':>6} | {'Triton flash':>13} {'SDPA':>9} {'naive':>9} | {'max error vs SDPA':>17} | {'naive peak memory':>17}")
    torch.manual_seed(0)
    for N in (1024, 2048, 4096, 8192, 16384):
        q, k, v = (torch.randn(B, H, N, D, device="cuda", dtype=torch.bfloat16) for _ in range(3))
        flops = 4 * B * H * N * N * D / 2                   # QK^T and PV, causal half
        tf = lambda fn: flops / (triton.testing.do_bench(fn) * 1e-3) / 1e12
        ours, ref = flash_attention(q, k, v), torch.nn.functional.scaled_dot_product_attention(q, k, v, is_causal=True)
        err = (ours.float() - ref.float()).abs().max().item()
        t_flash = tf(lambda: flash_attention(q, k, v))
        t_sdpa = tf(lambda: torch.nn.functional.scaled_dot_product_attention(q, k, v, is_causal=True))
        if N <= 8192:
            torch.cuda.reset_peak_memory_stats()
            base_mem = torch.cuda.memory_allocated()
            naive_attention(q, k, v)
            peak = (torch.cuda.max_memory_allocated() - base_mem) / 2**30
            t_naive, mem = f"{tf(lambda: naive_attention(q, k, v)):9.1f}", f"{peak:14.1f} GiB"
        else:
            t_naive, mem = f"{'skipped':>9}", f"{'too large':>17}"
        print(f"{N:6d} | {t_flash:13.1f} {t_sdpa:9.1f} {t_naive} | {err:17.1e} | {mem}")
        del q, k, v, ours, ref
        torch.cuda.empty_cache()
