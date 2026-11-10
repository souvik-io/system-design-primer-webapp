# format_matmul.py: how fast one GPU multiplies matrices in each number format its tensor cores support, and how far
# each result lands from an FP32 reference (chapter 4.1).
#
# Two shapes, both with the weight matrix of one MLP projection in Llama 3 70B (K = 8192 in, N = 28,672 out):
#   prefill-like, M = 8192 rows of activations: compute-bound, so the time measures the tensor cores' rate;
#   decode-like,  M = 32 rows: memory-bound, so the time is mostly reading the weight matrix, and a smaller format
#                 helps by having fewer bytes to read.
#
# Formats tried: BF16, FP16, INT8 (torch._int_mm), FP8 E4M3 with one scale per tensor and with one per row
# (torch.nn.functional.scaled_mm), and on Blackwell (compute capability 10.x) MXFP8, MXFP4 and NVFP4 with block
# scales. A format the GPU or this PyTorch build does not support prints the reason and is skipped.
#
#   modal run modal_run.py --script format_matmul.py --gpu 'H100!'
#   modal run modal_run.py --script format_matmul.py --gpu B200
#   python gcp_run.py --script format_matmul.py --gpu L4
#   python format_matmul.py                      # on any machine with an NVIDIA GPU
import statistics

import torch
import torch.nn.functional as F
from torch.nn.functional import ScalingType, SwizzleType

K, N = 8192, 28672
SHAPES = {"prefill-like (M=8192)": 8192, "decode-like (M=32)": 32}
FP4_MAX, E4M3_MAX = 6.0, 448.0
FP4_GRID = torch.tensor([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0])

# Dense tensor-core peaks in TFLOP/s (TOP/s for INT8) from NVIDIA's product pages, which print figures with
# sparsity; dense is half. B200 figures are the HGX B200 eight-GPU totals divided by eight.
PEAKS = {
    "L4": {"BF16": 121, "FP16": 121, "FP8": 242.5, "INT8": 242.5},
    "H100": {"BF16": 989.5, "FP16": 989.5, "FP8": 1979, "INT8": 1979},
    "B200": {"BF16": 2250, "FP16": 2250, "FP8": 4500, "INT8": 4500, "FP4": 9000},
}


def fp4_codes(x: torch.Tensor) -> torch.Tensor:
    """Round already-scaled values to FP4 E2M1 (round to nearest, ties to even, saturating at 6) and return the
    4-bit codes: sign in bit 3, then the index of the magnitude in FP4_GRID."""
    grid = FP4_GRID.to(x.device)
    a = x.abs().clamp(max=FP4_MAX)
    hi = torch.searchsorted(grid, a.contiguous()).clamp(max=7)
    lo = (hi - 1).clamp(min=0)
    d_lo, d_hi = a - grid[lo], grid[hi] - a
    idx = torch.where((d_hi < d_lo) | ((d_hi == d_lo) & (hi % 2 == 0)), hi, lo)
    return (idx | ((x < 0) & (idx > 0)).long() << 3).to(torch.uint8)


def pack_fp4(codes: torch.Tensor) -> torch.Tensor:
    """Two FP4 codes per byte along the last dimension, the first in the low nibble (PyTorch's float4_e2m1fn_x2)."""
    return (codes[..., 1::2] << 4 | codes[..., ::2]).view(torch.float4_e2m1fn_x2)


def to_blocked(scales: torch.Tensor) -> torch.Tensor:
    """Rearrange a (rows, K / block) scale matrix into the tiled layout cuBLAS reads for block-scaled matmuls
    (https://docs.nvidia.com/cuda/cublas/#d-block-scaling-factors-layout): 128-row by 4-column tiles, each
    stored as 32 x 16. Rows are padded to a multiple of 128 and columns to a multiple of 4."""
    rows, cols = scales.shape
    r, c = -(-rows // 128), -(-cols // 4)
    padded = torch.zeros((r * 128, c * 4), dtype=scales.dtype, device=scales.device)
    padded[:rows, :cols] = scales
    tiles = padded.view(r, 128, c, 4).permute(0, 2, 1, 3)
    return tiles.reshape(-1, 4, 32, 4).transpose(1, 2).reshape(-1, 32, 16).flatten()


def quantize(x: torch.Tensor, fmt: str):
    """Quantize a (rows, K) FP32 matrix along K. Returns the stored matrix, its scale tensors and their recipes."""
    if fmt == "FP8 per tensor":
        s = x.abs().max() / E4M3_MAX
        return (x / s).to(torch.float8_e4m3fn), [s.float()], [ScalingType.TensorWise], [SwizzleType.NO_SWIZZLE]
    if fmt == "FP8 per row":
        s = x.abs().amax(dim=1, keepdim=True) / E4M3_MAX
        return (x / s).to(torch.float8_e4m3fn), [s.float()], [ScalingType.RowWise], [SwizzleType.NO_SWIZZLE]
    rows = x.shape[0]
    if fmt in ("MXFP8", "MXFP4"):              # OCP MX v1.0: 32 values per power-of-two (E8M0) scale
        b = x.view(rows, -1, 32)
        emax = 8 if fmt == "MXFP8" else 2      # exponent of the element format's largest power of two
        exp = torch.floor(torch.log2(b.abs().amax(dim=2, keepdim=True).clamp(min=2.0**-120))) - emax
        scaled = b / torch.exp2(exp)
        scale = to_blocked(torch.exp2(exp).squeeze(2).to(torch.float8_e8m0fnu))
        if fmt == "MXFP8":
            data = scaled.clamp(-E4M3_MAX, E4M3_MAX).view(rows, -1).to(torch.float8_e4m3fn)
        else:
            data = pack_fp4(fp4_codes(scaled.view(rows, -1)))
        return data, [scale], [ScalingType.BlockWise1x32], [SwizzleType.SWIZZLE_32_4_4]
    if fmt == "NVFP4":                         # 16 values per E4M3 scale, plus one FP32 scale per tensor
        g = x.abs().max() / (FP4_MAX * E4M3_MAX)
        b = x.view(rows, -1, 16)
        s = (b.abs().amax(dim=2, keepdim=True) / FP4_MAX / g).to(torch.float8_e4m3fn)
        data = pack_fp4(fp4_codes((b / (s.float() * g)).view(rows, -1)))
        return (data, [to_blocked(s.squeeze(2)), g.float()], [ScalingType.BlockWise1x16, ScalingType.TensorWise],
                [SwizzleType.SWIZZLE_32_4_4, SwizzleType.NO_SWIZZLE])
    raise ValueError(fmt)


def make_runner(fmt: str, a: torch.Tensor, w: torch.Tensor):
    """Return a function computing a @ w.T in the given format, with the inputs already converted, and a function
    turning its output back into FP32 values (only INT8 needs one: its int32 result is rescaled afterwards)."""
    if fmt in ("BF16", "FP16"):
        dt = torch.bfloat16 if fmt == "BF16" else torch.float16
        a2, wt = a.to(dt), w.to(dt).t()
        return (lambda: a2 @ wt), (lambda out: out.float())
    if fmt == "INT8":                          # symmetric, one scale per row of each input; int32 accumulation
        sa, sw = a.abs().amax(1, keepdim=True) / 127, w.abs().amax(1, keepdim=True) / 127
        a8, w8t = (a / sa).round().to(torch.int8), (w / sw).round().to(torch.int8).t()
        return (lambda: torch._int_mm(a8, w8t)), (lambda out: out.float() * sa * sw.t())
    qa, sa, ra, za = quantize(a, fmt)
    qw, sw, rw, zw = quantize(w, fmt)
    if fmt == "FP8 per row":
        sw = [sw[0].t()]                       # one scale per output column of w.T: shape (1, N)
    # scaled_mm wants the second matrix in column-major order: w is (N, K) row-major, so w.T is (K, N) column-major.
    return (lambda: F.scaled_mm(qa, qw.t(), sa, ra, sw, rw, za, zw, output_dtype=torch.bfloat16)), (lambda out: out.float())


def time_ms(fn, reps: int) -> float:
    for _ in range(3):
        fn()
    times = []
    for _ in range(5):
        start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
        start.record()
        for _ in range(reps):
            fn()
        end.record()
        torch.cuda.synchronize()
        times.append(start.elapsed_time(end) / reps)
    return statistics.median(times)


def main() -> None:
    name = torch.cuda.get_device_name()
    cc = torch.cuda.get_device_capability()
    peaks = next((v for k, v in PEAKS.items() if k in name), {})
    print(f"{name}, compute capability {cc[0]}.{cc[1]}, PyTorch {torch.__version__}, CUDA {torch.version.cuda}")
    torch.backends.cuda.matmul.allow_tf32 = False             # keep the FP32 reference in FP32
    formats = ["BF16", "FP16", "INT8", "FP8 per tensor", "FP8 per row", "MXFP8", "MXFP4", "NVFP4"]
    bytes_per = {"BF16": 2, "FP16": 2, "INT8": 1, "FP8 per tensor": 1, "FP8 per row": 1, "MXFP8": 1 + 1 / 32,
                 "MXFP4": 0.5 + 1 / 32, "NVFP4": 0.5 + 1 / 16}
    torch.manual_seed(0)
    w = torch.randn(N, K, device="cuda")                      # the "weights", one row per output feature
    for label, m in SHAPES.items():
        a = torch.randn(m, K, device="cuda")
        ref = a @ w.t()
        print(f"\n{label}: ({m} x {K}) times ({K} x {N})")
        print(f"   {'format':<16}{'time':>10}{'TFLOP/s':>10}{'of peak':>9}{'weights GB/s':>14}{'error':>9}")
        for fmt in formats:
            try:
                run, post = make_runner(fmt, a, w)
                out = post(run())
                ms = time_ms(run, 20 if m > 1000 else 200)
            except Exception as e:                            # unsupported on this GPU or PyTorch build
                print(f"   {fmt:<16}  not run: {str(e).splitlines()[0][:90]}")
                continue
            tflops = 2 * m * N * K / ms / 1e9
            family = {"MXFP8": "FP8", "MXFP4": "FP4", "NVFP4": "FP4"}.get(fmt, fmt.split()[0])
            peak = peaks.get(family)
            share = f"{tflops / peak:>8.0%}" if peak else f"{'':>8}"
            gbps = N * K * bytes_per[fmt] / ms / 1e6
            err = ((out - ref).norm() / ref.norm()).item()
            print(f"   {fmt:<16}{ms:>8.3f}ms{tflops:>10.1f}{share} {gbps:>13.0f}{err:>9.2%}")
    print("\nerror = relative RMS distance from the FP32 product; it includes rounding the inputs to the format.")
    print("of peak = against the dense tensor-core peak NVIDIA lists for this format family, where known.")


if __name__ == "__main__":
    main()
