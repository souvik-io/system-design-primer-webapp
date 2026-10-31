# roofline_probe.py: measure your machine's bandwidth and matmul peak, then sweep the batch size of a
# decode-shaped matmul (one weight matrix, B token vectors) and compare the times with the roofline.
import statistics
import time

import torch

dev = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
dtype = {"cuda": torch.bfloat16, "mps": torch.float16, "cpu": torch.float32}[dev]
elem = torch.tensor([], dtype=dtype).element_size()


def sync():
    if dev == "cuda":
        torch.cuda.synchronize()
    elif dev == "mps":
        torch.mps.synchronize()


def timed(fn, reps=20):
    """Median wall time of fn in seconds, after warmup, with the device synchronized."""
    for _ in range(3):
        fn()
    sync()
    times = []
    for _ in range(reps):
        t0 = time.perf_counter()
        fn()
        sync()
        times.append(time.perf_counter() - t0)
    return statistics.median(times)


# 1. Bandwidth: copy 256 MB. A copy reads and writes every byte.
src = torch.empty(256 * 2**20 // elem, dtype=dtype, device=dev)
dst = torch.empty_like(src)
bandwidth = 2 * src.numel() * elem / timed(lambda: dst.copy_(src))

# 2. Compute: a large square matmul has plenty of reuse, so it runs near the arithmetic peak.
n = 4096
a = torch.randn(n, n, dtype=dtype, device=dev)
b = torch.randn(n, n, dtype=dtype, device=dev)
peak = 2 * n**3 / timed(lambda: a @ b, reps=10)
ridge = peak / bandwidth
print(f"{dev}, {dtype}: copy bandwidth {bandwidth / 1e9:.0f} GB/s, matmul {peak / 1e12:.2f} TFLOP/s, "
      f"ridge {ridge:.0f} FLOPs/byte")

# 3. A decode-shaped matmul: one 4096 x 14336 weight (Llama 3.1 8B's up projection), B tokens.
d_in, d_out = 4096, 14336
w = torch.randn(d_out, d_in, dtype=dtype, device=dev)
print(f"{'batch':>6} {'time ms':>8} {'model ms':>8} {'TFLOP/s':>8} {'GB/s':>6} {'FLOPs/byte':>10}")
for batch in (1, 4, 16, 64, 128, 256, 512, 1024, 2048):
    x = torch.randn(batch, d_in, dtype=dtype, device=dev)
    t = timed(lambda: x @ w.T)
    flops = 2 * batch * d_in * d_out
    bytes_moved = (d_out * d_in + batch * d_in + batch * d_out) * elem
    model = max(flops / peak, bytes_moved / bandwidth)  # the roofline's prediction
    print(f"{batch:6d} {t * 1e3:8.3f} {model * 1e3:8.3f} {flops / t / 1e12:8.2f} "
          f"{bytes_moved / t / 1e9:6.0f} {flops / bytes_moved:10.1f}")
