# online_softmax.py: the maths behind FlashAttention, checked on a CPU (chapter 2.4).
#
#  1. Online softmax: one pass over a row in blocks, keeping a running max and a running sum, equals softmax.
#  2. Tiled attention: queries in blocks, keys and values streamed in blocks, never forming the N x N matrix,
#     equals ordinary causal attention.
#  3. Memory traffic: bytes moved to and from HBM by ordinary attention and by the tiled version.
#
# Needs only NumPy. Run: python online_softmax.py
import numpy as np

rng = np.random.default_rng(0)

print("1. Online softmax over one row of 1,000 scores, in blocks of 128")
x = rng.normal(0, 3, 1000)
m, l = -np.inf, 0.0                                   # running max and running sum of exp(x - m)
for start in range(0, len(x), 128):
    block = x[start:start + 128]
    m_new = max(m, block.max())
    l = l * np.exp(m - m_new) + np.exp(block - m_new).sum()   # rescale the old sum to the new max
    m = m_new
online = np.exp(x - m) / l
exact = np.exp(x - x.max()) / np.exp(x - x.max()).sum()
print(f"   max |online - exact| = {np.abs(online - exact).max():.1e}, final max {m:.3f} = row max {x.max():.3f}")


def attention(q, k, v):
    n, d = q.shape
    s = q @ k.T / np.sqrt(d)
    s[np.triu_indices(n, 1)] = -np.inf                # causal mask
    p = np.exp(s - s.max(1, keepdims=True))
    return (p / p.sum(1, keepdims=True)) @ v


def tiled_attention(q, k, v, bm=64, bn=32):
    n, d = q.shape
    out = np.empty_like(q)
    for i in range(0, n, bm):                         # one "program" per block of queries
        qi = q[i:i + bm]
        rows = np.arange(i, min(i + bm, n))
        m = np.full(len(qi), -np.inf)
        l = np.zeros(len(qi))
        acc = np.zeros((len(qi), d))
        for j in range(0, min(i + bm, n), bn):        # causal: stop after the block's last query
            s = qi @ k[j:j + bn].T / np.sqrt(d)
            cols = np.arange(j, min(j + bn, n))
            s[rows[:, None] < cols[None, :]] = -np.inf
            m_new = np.maximum(m, s.max(1))
            alpha = np.exp(m - m_new)
            p = np.exp(s - m_new[:, None])
            l = l * alpha + p.sum(1)
            acc = acc * alpha[:, None] + p @ v[j:j + bn]
            m = m_new
        out[i:i + bm] = acc / l[:, None]
    return out


print("\n2. Tiled causal attention against ordinary attention, N = 1,000, d = 64")
q, k, v = (rng.normal(size=(1000, 64)) for _ in range(3))
print(f"   max |tiled - ordinary| = {np.abs(tiled_attention(q, k, v) - attention(q, k, v)).max():.1e}")

print("\n3. HBM traffic of causal attention, BF16, d = 128, batch 4 x 16 heads (bytes to and from GPU memory)")
# Ordinary attention, at least: write the N x N scores S, read them for softmax, write P, read P for P @ V.
# As written in plain PyTorch (naive_attention in gpu/flash_attention.py) every step is its own kernel over the
# N x N matrix: Q @ K^T writes S (2 bytes per entry), the scaling reads and writes it (4), the mask reads and
# writes it (4), .float() reads 2 and writes 4, softmax reads 4 and writes 4, .to(bf16) reads 4 and writes 2,
# and P @ V reads 2: 32 bytes per entry.
d, b, heads = 128, 2, 4 * 16
print(f"{'N':>7} {'tiled':>9} {'ordinary, minimum':>18} {'plain PyTorch':>14} {'PyTorch at 3.0 TB/s':>20}")
for n in (1024, 4096, 8192, 16384):
    qkvo = 4 * n * d * b
    minimum = qkvo + 4 * n * n * b
    plain = qkvo + 32 * n * n
    blocks = -(-n // 128)                        # tiled: Q and O once, K and V up to each block's last query
    tiled = 2 * n * d * b + sum(min((i + 1) * 128, n) for i in range(blocks)) * d * b * 2
    print(f"{n:7d} {heads * tiled / 1e9:6.2f} GB {heads * minimum / 1e9:15.2f} GB {heads * plain / 1e9:11.1f} GB "
          f"{heads * plain / 3.0e12 * 1e3:17.1f} ms")
