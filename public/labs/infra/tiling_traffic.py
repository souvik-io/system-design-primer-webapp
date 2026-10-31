# tiling_traffic.py: how tile size and tile order change the memory traffic of a matmul (chapter 2.2).
#
# C = A @ B with N x N BF16 matrices, computed in BM x BN output tiles. Each program (one output tile) reads
# a BM-row panel of A and a BN-column panel of B, slice by slice along K.
#
# Model 1, no reuse between programs: every program reads its whole panels from memory.
# Model 2, waves: the GPU runs one program per SM at a time, the programs of a wave move along K together,
#   and a panel slice that several programs of the wave need is read from HBM once and shared through L2.
#   This is a simplification of real hardware, where waves overlap and L2 also keeps data between waves.
#
# Pure Python, no packages. Run: python tiling_traffic.py
N, BYTES = 8192, 2
PEAK, BW = 989e12, 3.35e12          # H100 SXM, dense BF16 and HBM3, for the first table


def order(num_m, num_n, group):
    """Output tiles (m, n) in launch order; group = 1 is row-major, as in Triton's matmul tutorial."""
    tiles = []
    for pid in range(num_m * num_n):
        g = pid // (group * num_n)
        first = g * group
        size = min(num_m - first, group)
        tiles.append((first + (pid % (group * num_n)) % size, (pid % (group * num_n)) // size))
    return tiles


def traffic(bm, bn, group, sms):
    num_m, num_n = N // bm, N // bn
    tiles = order(num_m, num_n, group)
    no_reuse = len(tiles) * (bm + bn) * N * BYTES
    waves = 0
    for start in range(0, len(tiles), sms):
        wave = tiles[start:start + sms]
        rows = len({m for m, _ in wave})
        cols = len({n for _, n in wave})
        waves += (rows * bm + cols * bn) * N * BYTES
    return no_reuse, waves


flops = 2 * N**3
print(f"C = A @ B, N = {N:,}, BF16: {flops / 1e12:.2f} TFLOP, {flops / PEAK * 1e3:.2f} ms at the H100's dense peak\n")
print("Per-tile arithmetic intensity with no reuse between programs = BM x BN / (BM + BN) FLOPs per byte:")
for bm, bn in ((16, 16), (32, 32), (64, 64), (128, 128), (128, 256)):
    no_reuse, _ = traffic(bm, bn, 1, 132)
    print(f"  {bm:3d} x {bn:3d}: {bm * bn / (bm + bn):5.1f} FLOPs/byte, {no_reuse / 1e9:6.1f} GB read, "
          f"{no_reuse / BW * 1e3:6.2f} ms at 3.35 TB/s")

print("\nWave model: memory traffic when each wave shares the panels its programs need")
GPUS = (("H100", 132, 989e12, 3.35e12), ("A10", 72, 125e12, 600e9))   # name, SMs, dense BF16 peak, bandwidth
for name, sms, peak, bw in GPUS:
    print(f"  {name}: {sms} SMs, compute takes at least {flops / peak * 1e3:.2f} ms")
    for bm, bn in ((128, 128), (128, 256)):
        for group in (1, 8):
            _, waves = traffic(bm, bn, group, sms)
            label = f"{bm} x {bn}, " + ("row-major" if group == 1 else f"GROUP_M={group}")
            bound = "memory-bound" if waves / bw > flops / peak else "compute-bound"
            print(f"    {label:24s} {waves / 1e9:5.2f} GB, {waves / bw * 1e3:6.2f} ms of memory time, {bound}")
