# matmul_sizes.py: how much of the tensor-core peak a square matmul reaches as its size grows (chapter 2.1).
# Small matmuls cannot fill every SM with work, so they reach a smaller share of the peak.
#
# Run on an NVIDIA GPU:  python matmul_sizes.py
# Or on Modal:           modal run modal_run.py --script matmul_sizes.py --gpu H100
import torch

dev = torch.device("cuda")
p = torch.cuda.get_device_properties(dev)
fp8_ok = (p.major, p.minor) >= (8, 9)


def timed(fn, iters=20, warmup=5):
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


print(f"{p.name}, {p.multi_processor_count} SMs, PyTorch {torch.__version__}")
print(f"{'N':>6} {'BF16 TFLOP/s':>13} {'FP8 TFLOP/s':>12}")
for n in (1024, 2048, 4096, 8192, 16384):
    a = torch.randn(n, n, device=dev, dtype=torch.bfloat16)
    b = torch.randn(n, n, device=dev, dtype=torch.bfloat16)
    flops = 2 * n**3
    bf16 = flops / timed(lambda: a @ b) / 1e12
    fp8 = float("nan")
    if fp8_ok:
        a8, b8 = a.to(torch.float8_e4m3fn), b.to(torch.float8_e4m3fn).t().contiguous().t()
        one = torch.tensor(1.0, device=dev)
        fp8 = flops / timed(lambda: torch._scaled_mm(a8, b8, scale_a=one, scale_b=one, out_dtype=torch.bfloat16)) / 1e12
    print(f"{n:6d} {bf16:13.1f} {fp8:12.1f}")
