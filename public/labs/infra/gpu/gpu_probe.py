# gpu_probe.py: what one NVIDIA GPU really delivers, measured against its spec sheet (chapter 2.1).
#
#  1. The device's shape: SMs, warp size, registers, shared memory, L2 cache, memory.
#  2. Bandwidth by working-set size: small buffers stay in L2, large ones go to HBM or GDDR.
#  3. Access patterns: reading every element, every 2nd, 4th ... 32nd, and random elements.
#  4. Matmul peak in FP32, TF32, BF16 and (on Ada, Hopper and newer) FP8.
#
# Run on any NVIDIA GPU with PyTorch:  python gpu_probe.py
# Or on Modal:                         modal run modal_run.py --script gpu_probe.py --gpu L4
import torch

assert torch.cuda.is_available(), "this script needs an NVIDIA GPU"
dev = torch.device("cuda")
p = torch.cuda.get_device_properties(dev)


def timed(fn, iters=20, warmup=3):
    """Best time of `iters` runs in seconds, measured with CUDA events."""
    for _ in range(warmup):
        fn()
    best = float("inf")
    for _ in range(iters):
        start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
        start.record()
        fn()
        end.record()
        torch.cuda.synchronize()
        best = min(best, start.elapsed_time(end) / 1e3)
    return best


print(f"== 1. {p.name}, compute capability {p.major}.{p.minor}, PyTorch {torch.__version__}, CUDA {torch.version.cuda}")
fields = [("SMs", "multi_processor_count"), ("warp size", "warp_size"),
          ("max threads per SM", "max_threads_per_multi_processor"), ("registers per SM", "regs_per_multiprocessor"),
          ("shared memory per SM (bytes)", "shared_memory_per_multiprocessor"),
          ("shared memory per block, opt-in (bytes)", "shared_memory_per_block_optin"),
          ("L2 cache (bytes)", "L2_cache_size"), ("global memory (bytes)", "total_memory")]
for label, attr in fields:
    value = getattr(p, attr, None)
    print(f"  {label:42s} {value:,}" if isinstance(value, int) else f"  {label:42s} n/a")

print("\n== 2. Copy bandwidth by working set (read + write counted)")
l2 = getattr(p, "L2_cache_size", 0)
for mb in (2, 8, 16, 32, 64, 128, 512, 2048):
    n = mb * 2**20 // 4 // 2                       # two float32 buffers that together take `mb` MiB
    src, dst = torch.randn(n, device=dev), torch.empty(n, device=dev)
    reps = max(1, 2048 // mb)                      # repeat small copies so each timing is long enough
    t = timed(lambda: [dst.copy_(src) for _ in range(reps)])
    where = "fits in L2" if mb * 2**20 <= l2 else "beyond L2"
    print(f"  {mb:5d} MiB working set: {2 * n * 4 * reps / t / 1e9:8.0f} GB/s   ({where})")
    del src, dst

print("\n== 3. Reading 16M useful float32 values with different access patterns")
n_useful = 16 * 2**20
for stride in (1, 2, 4, 8, 16, 32):
    x = torch.randn(n_useful * stride, device=dev)
    view = x.view(n_useful, stride)[:, 0]          # every `stride`-th element
    out = torch.empty(n_useful, device=dev)
    t = timed(lambda: out.copy_(view))
    useful = n_useful * 4 * 2                      # useful bytes read plus bytes written
    print(f"  stride {stride:2d} ({stride * 4:3d} bytes apart): {useful / t / 1e9:7.0f} GB/s of useful data")
    del x, view, out
x = torch.randn(n_useful * 8, device=dev)
idx = torch.randint(0, x.numel(), (n_useful,), device=dev)
out = torch.empty(n_useful, device=dev)
t = timed(lambda: torch.index_select(x, 0, idx, out=out))
print(f"  random gather:              {n_useful * 4 * 2 / t / 1e9:7.0f} GB/s of useful data (index reads not counted)")
del x, idx, out

print("\n== 4. Matmul throughput, 8192 x 8192 x 8192")
N = 8192
flops = 2 * N**3
a32, b32 = torch.randn(N, N, device=dev), torch.randn(N, N, device=dev)
torch.backends.cuda.matmul.allow_tf32 = False
print(f"  FP32 (no tensor cores): {flops / timed(lambda: a32 @ b32, iters=5) / 1e12:7.1f} TFLOP/s")
torch.backends.cuda.matmul.allow_tf32 = True
print(f"  TF32 (tensor cores):    {flops / timed(lambda: a32 @ b32, iters=5) / 1e12:7.1f} TFLOP/s")
a16, b16 = a32.bfloat16(), b32.bfloat16()
del a32, b32
print(f"  BF16 (tensor cores):    {flops / timed(lambda: a16 @ b16) / 1e12:7.1f} TFLOP/s")
if (p.major, p.minor) >= (8, 9):                   # FP8 tensor cores: Ada (8.9), Hopper (9.0) and newer
    a8 = a16.to(torch.float8_e4m3fn)
    b8 = b16.to(torch.float8_e4m3fn).t().contiguous().t()    # _scaled_mm wants the second operand column-major
    one = torch.tensor(1.0, device=dev)
    fp8 = lambda: torch._scaled_mm(a8, b8, scale_a=one, scale_b=one, out_dtype=torch.bfloat16)
    print(f"  FP8 E4M3 (tensor cores):{flops / timed(fp8) / 1e12:7.1f} TFLOP/s")
else:
    print("  FP8: no FP8 tensor cores on this GPU")
