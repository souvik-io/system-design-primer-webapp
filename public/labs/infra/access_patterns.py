# access_patterns.py: how the order of memory reads changes a GPU's useful bandwidth (chapter 2.1).
#
# Runs on Apple silicon (MPS), on an NVIDIA GPU (CUDA) or on a CPU. It measures two things:
#   1. copy bandwidth for working sets from 2 MiB to 1 GiB, to show where caches stop helping;
#   2. the useful bandwidth of reading every element, every 2nd, 4th ... 32nd element, and random elements.
# A GPU moves memory in fixed-size chunks (32-byte sectors on NVIDIA GPUs), so a read that uses one
# 4-byte value from each chunk wastes the rest of the chunk.
#
# Run: python access_patterns.py
import time

import torch

dev = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"


def sync():
    if dev == "cuda":
        torch.cuda.synchronize()
    elif dev == "mps":
        torch.mps.synchronize()


def timed(fn, iters=10, warmup=3):
    """Best wall-clock time of `iters` runs, in seconds, with the device synchronised around each run."""
    for _ in range(warmup):
        fn()
    sync()
    best = float("inf")
    for _ in range(iters):
        start = time.perf_counter()
        fn()
        sync()
        best = min(best, time.perf_counter() - start)
    return best


name = torch.cuda.get_device_name() if dev == "cuda" else dev
print(f"device: {name}, PyTorch {torch.__version__}\n")

print("1. Copy bandwidth by working set (bytes read + bytes written)")
for mb in (2, 8, 32, 128, 512, 1024):
    n = mb * 2**20 // 4 // 2                       # two float32 buffers that together take `mb` MiB
    src, dst = torch.randn(n, device=dev), torch.empty(n, device=dev)
    reps = max(1, 1024 // mb)                      # repeat small copies so each timing is long enough
    t = timed(lambda: [dst.copy_(src) for _ in range(reps)])
    print(f"  {mb:5d} MiB: {2 * n * 4 * reps / t / 1e9:7.1f} GB/s")
    del src, dst

print("\n2. Reading 8M useful float32 values with different access patterns")
n_useful = 8 * 2**20
for stride in (1, 2, 4, 8, 16, 32):
    x = torch.randn(n_useful * stride, device=dev)
    view = x.view(n_useful, stride)[:, 0]          # every `stride`-th element
    out = torch.empty(n_useful, device=dev)
    t = timed(lambda: out.copy_(view))
    print(f"  stride {stride:2d} ({stride * 4:3d} bytes apart): {n_useful * 4 * 2 / t / 1e9:6.1f} GB/s of useful data")
    del x, view, out
x = torch.randn(n_useful * 8, device=dev)
idx = torch.randint(0, x.numel(), (n_useful,), device=dev)
t = timed(lambda: torch.index_select(x, 0, idx))
print(f"  random gather:              {n_useful * 4 * 2 / t / 1e9:6.1f} GB/s of useful data (index reads not counted)")
