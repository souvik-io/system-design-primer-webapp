# w4a16_matmul.py: weight-only against weight-and-activation quantization, timed on one GPU (chapter 4.2).
#
# One weight matrix, the same Llama 3 70B MLP projection as chapter 4.1 (K = 8192 inputs, N = 28,672 outputs),
# multiplied by M rows of activations for M from 1 (one decode step of one sequence) to 4096 (a prefill chunk):
#
#   BF16                 cuBLAS, the baseline.
#   W4A16, unfused       INT4 weights with one scale and zero per 128 inputs, turned back into a BF16 matrix by
#                        ordinary PyTorch operations on every call, then multiplied. Saves memory, not time.
#   W4A16, tinygemm      The same INT4 weights multiplied by tinygemm, the fused kernel built into PyTorch
#                        (torch.ops.aten._weight_int4pack_mm, used by torchao for decoding).
#   W4A16, Triton        The same INT4 weights multiplied by the fused kernel in this file: each tile of packed
#                        weights is loaded, dequantized in registers and fed to the tensor cores, so the kernel
#                        reads a quarter of BF16's bytes and never writes a BF16 copy of the weights.
#   W4A16, Marlin        vLLM's Marlin kernel (Frantar et al., 2024), the W4A16 kernel vLLM serves GPTQ and AWQ
#                        checkpoints with; only when vLLM is installed (--vllm), with symmetric INT4 codes.
#   W8A8 INT8            INT8 weights per channel, activations quantized per token on every call, then the
#                        INT8 tensor-core matmul (torch._int_mm, which needs more than 16 rows, so smaller
#                        batches are padded to 32) and the rescale. The time includes quantizing the activations
#                        and rescaling the int32 result, as a real layer must.
#   W8A8 FP8             The same with FP8 E4M3 and per-row scales through scaled_mm (Ada, Hopper, Blackwell).
#
# Each row prints the time per matmul and its speedup over BF16, and the last column the error against an FP32
# product. Formats this GPU or PyTorch build cannot run print the reason and are skipped.
#
#   modal run modal_run.py --script w4a16_matmul.py --gpu 'H100!'
#   modal run modal_run.py --script w4a16_matmul.py --gpu 'H100!' --vllm # adds the Marlin row
#   python gcp_run.py --script w4a16_matmul.py --gpu L4
#   python w4a16_matmul.py                       # on any machine with an NVIDIA GPU (compute capability 8.0+)
import statistics

import torch
import torch.nn.functional as F
import triton
import triton.language as tl

K, N, GROUP = 8192, 28672, 128
MS = [1, 16, 64, 256, 1024, 4096]


def quantize_int4(w: torch.Tensor):
    """Asymmetric INT4 with one scale and one zero per GROUP inputs, in tinygemm's convention: codes 0..15,
    w ~= (code - 8) * scale + zero, where zero is a floating-point value (the group's midpoint), not an integer."""
    g = w.float().view(N, K // GROUP, GROUP)
    lo, hi = g.amin(2, keepdim=True), g.amax(2, keepdim=True)
    scale = ((hi - lo) / 15).clamp(min=1e-6)
    codes = torch.clamp(torch.round((g - lo) / scale), 0, 15).to(torch.uint8).view(N, K)
    zero = lo + 8 * scale
    return codes, scale.squeeze(2), zero.squeeze(2)          # (N, K) codes, (N, K/GROUP) scales and zeros


def dequant_int4(codes, scale, zero, dtype=torch.bfloat16):
    g = codes.view(N, K // GROUP, GROUP).to(dtype)
    return ((g - 8) * scale.unsqueeze(2).to(dtype) + zero.unsqueeze(2).to(dtype)).view(N, K)


# ---- A fused W4A16 kernel in Triton ---------------------------------------------------------------------------
# Packed layout: the K inputs are cut into blocks of 64; byte j of a block holds input j in its low nibble and
# input j + 32 in its high nibble, and the bytes are stored (K / 2, N), so a tile of 32 bytes by BLOCK_N outputs
# is one coalesced load that unpacks into two (32, BLOCK_N) halves with a mask and a shift.
def pack_for_triton(codes: torch.Tensor) -> torch.Tensor:
    c = codes.view(N, K // 64, 2, 32)
    return (c[:, :, 0, :] | (c[:, :, 1, :] << 4)).reshape(N, K // 2).t().contiguous()


@triton.autotune(
    configs=[triton.Config({"BLOCK_M": bm, "BLOCK_N": bn}, num_warps=w, num_stages=s)
             for bm, bn, w, s in [(16, 64, 4, 4), (16, 128, 4, 4), (32, 128, 4, 4), (64, 128, 4, 4),
                                  (128, 128, 8, 3), (128, 256, 8, 3)]],
    key=["M"])
@triton.jit
def w4a16_kernel(x_ptr, w_ptr, s_ptr, z_ptr, y_ptr, M, N, K, GROUP: tl.constexpr, BLOCK_M: tl.constexpr,
                 BLOCK_N: tl.constexpr):
    offs_m = tl.program_id(1) * BLOCK_M + tl.arange(0, BLOCK_M)
    offs_n = tl.program_id(0) * BLOCK_N + tl.arange(0, BLOCK_N)
    offs_j = tl.arange(0, 32)
    row_ok = offs_m[:, None] < M
    acc = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.float32)
    for k0 in range(0, K, 64):
        xa = tl.load(x_ptr + offs_m[:, None] * K + (k0 + offs_j)[None, :], mask=row_ok, other=0.0)
        xb = tl.load(x_ptr + offs_m[:, None] * K + (k0 + 32 + offs_j)[None, :], mask=row_ok, other=0.0)
        b = tl.load(w_ptr + (k0 // 2 + offs_j)[:, None] * N + offs_n[None, :])      # (32, BLOCK_N) bytes
        g = k0 // GROUP
        s = tl.load(s_ptr + g * N + offs_n)[None, :]
        z = tl.load(z_ptr + g * N + offs_n)[None, :]
        w_lo = (((b & 0xF).to(tl.float32) - 8) * s + z).to(tl.bfloat16)           # dequantize in registers
        w_hi = (((b >> 4).to(tl.float32) - 8) * s + z).to(tl.bfloat16)
        acc += tl.dot(xa, w_lo)
        acc += tl.dot(xb, w_hi)
    tl.store(y_ptr + offs_m[:, None] * N + offs_n[None, :], acc.to(tl.bfloat16), mask=row_ok)


def w4a16_triton(x, packed, scale_t, zero_t):
    m = x.shape[0]
    y = torch.empty((m, N), device=x.device, dtype=torch.bfloat16)
    grid = lambda meta: (N // meta["BLOCK_N"], triton.cdiv(m, meta["BLOCK_M"]))
    w4a16_kernel[grid](x, packed, scale_t, zero_t, y, m, N, K, GROUP)
    return y


def marlin_runner(w: torch.Tensor):
    """vLLM's Marlin W4A16 kernel, set up the way vLLM's own kernel tests do. Its argument list has changed
    between vLLM versions, so the call is assembled from the function's signature."""
    import inspect

    from vllm import _custom_ops as ops
    from vllm.model_executor.layers.quantization.utils.marlin_utils import marlin_make_workspace_new
    from vllm.model_executor.layers.quantization.utils.marlin_utils_test import marlin_quantize
    from vllm.scalar_type import scalar_types

    qtype = scalar_types.uint4b8                         # symmetric INT4 stored as code + 8, as GPTQ does
    res = marlin_quantize(w.t().contiguous().to(torch.bfloat16), qtype, GROUP)   # (w_ref, q_w, s, ...)
    q_w, s = res[1], res[2]
    gemm = getattr(ops, "marlin_gemm", None) or ops.gptq_marlin_gemm   # renamed in vLLM 0.3x
    params = inspect.signature(gemm).parameters
    empty = torch.empty(0, dtype=torch.int, device=w.device)
    fixed = {"c": None, "b_q_weight": q_w, "b_bias": None, "b_scales": s, "a_scales": None, "global_scale": None,
             "b_zeros": None, "g_idx": empty, "perm": empty, "workspace": marlin_make_workspace_new(w.device),
             "b_q_type": qtype, "size_n": N, "size_k": K, "is_k_full": True, "use_atomic_add": False,
             "use_fp32_reduce": True, "is_zp_float": False}
    missing = [n for n, p in params.items() if n not in fixed and n not in ("a", "size_m")
               and p.default is inspect.Parameter.empty]
    if missing:
        raise RuntimeError(f"unknown Marlin arguments {missing}; signature {list(params)}")
    kwargs = {k: v for k, v in fixed.items() if k in params}
    return lambda x: gemm(a=x, size_m=x.shape[0], **kwargs)


def make_runners(w: torch.Tensor):
    runners = {}
    wb = w.to(torch.bfloat16)
    runners["BF16"] = lambda x: x @ wb.t()

    codes, scale, zero = quantize_int4(w)
    runners["W4A16, unfused"] = lambda x: x @ dequant_int4(codes, scale, zero).t()
    # tinygemm takes two codes per byte, (N, K/2), even index in the high nibble (the layout PyTorch's own tests
    # pass to _convert_weight_to_int4pack, which rearranges it into tinygemm's tiled layout).
    packed = (codes[:, ::2] << 4 | codes[:, 1::2]).contiguous()
    w_tiny = torch.ops.aten._convert_weight_to_int4pack(packed, 8)  # 8 inner k-tiles
    sz = torch.stack([scale, zero], dim=2).transpose(0, 1).contiguous().to(torch.bfloat16)   # (K/GROUP, N, 2)
    runners["W4A16, tinygemm"] = lambda x: torch.ops.aten._weight_int4pack_mm(x, w_tiny, GROUP, sz)
    w_tri = pack_for_triton(codes)
    s_t, z_t = scale.t().contiguous().float(), zero.t().contiguous().float()       # (K/GROUP, N)
    runners["W4A16, Triton"] = lambda x: w4a16_triton(x, w_tri, s_t, z_t)
    try:
        runners["W4A16, Marlin"] = marlin_runner(w)
    except ImportError:
        pass                                                      # vLLM not installed: no Marlin row
    except Exception as e:
        print(f"Marlin not set up: {str(e).splitlines()[0][:200]}")

    s8 = w.abs().amax(1, keepdim=True) / 127                      # INT8 per output channel
    w8t = torch.round(w / s8).to(torch.int8).t()

    def w8a8_int8(x):
        m = x.shape[0]
        if m <= 16:
            x = F.pad(x, (0, 0, 0, 32 - m))
        sx = x.abs().amax(1, keepdim=True).float().clamp(min=1e-8) / 127
        x8 = torch.round(x.float() / sx).to(torch.int8)
        return (torch._int_mm(x8, w8t).float() * sx * s8.t()).to(torch.bfloat16)[:m]
    runners["W8A8 INT8"] = w8a8_int8

    sf = w.abs().amax(1, keepdim=True) / 448
    wf = (w / sf).to(torch.float8_e4m3fn)
    sft = sf.t().float().contiguous()                             # (1, N)

    def w8a8_fp8(x):
        sx = x.abs().amax(1, keepdim=True).float() / 448
        xf = (x.float() / sx).to(torch.float8_e4m3fn)
        return torch._scaled_mm(xf, wf.t(), sx, sft, out_dtype=torch.bfloat16)
    runners["W8A8 FP8"] = w8a8_fp8
    w4 = 0.5 + 4 / GROUP                                          # 4-bit codes plus an FP16 scale and zero per 128
    bytes_per = {"BF16": 2, "W4A16, unfused": 2, "W4A16, tinygemm": w4, "W4A16, Triton": w4, "W4A16, Marlin": 0.5 + 2 / GROUP, "W8A8 INT8": 1,
                 "W8A8 FP8": 1}
    return runners, bytes_per


def time_us(fn, x, reps):
    """Median over 5 timings of `reps` calls each, with fewer calls for a slow kernel so that no format takes
    more than about a second to time."""
    fn(x)
    torch.cuda.synchronize()
    start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
    start.record()
    fn(x)
    end.record()
    torch.cuda.synchronize()
    reps = max(1, min(reps, int(200 / max(start.elapsed_time(end), 1e-3))))
    times = []
    for _ in range(5):
        start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
        start.record()
        for _ in range(reps):
            fn(x)
        end.record()
        torch.cuda.synchronize()
        times.append(start.elapsed_time(end) * 1000 / reps)
    return statistics.median(times)


def main() -> None:
    name = torch.cuda.get_device_name()
    cc = torch.cuda.get_device_capability()
    print(f"{name}, compute capability {cc[0]}.{cc[1]}, PyTorch {torch.__version__}, CUDA {torch.version.cuda}")
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.manual_seed(0)
    w = torch.randn(N, K, device="cuda") * 0.02
    runners, bytes_per = make_runners(w)
    print(f"weight ({N} x {K}): BF16 {N * K * 2 / 2**20:.0f} MiB, INT4 + scales {N * K * bytes_per['W4A16, Triton'] / 2**20:.0f} MiB, "
          f"INT8 {N * K / 2**20:.0f} MiB\n")
    results = {}
    for m in MS:
        x = torch.randn(m, K, device="cuda", dtype=torch.bfloat16)
        ref = x.float() @ w.t()
        print(f"M = {m}", flush=True)
        print(f"   {'scheme':<18}{'time':>11}{'vs BF16':>9}{'weights GB/s':>14}{'TFLOP/s':>9}{'error':>8}")
        base = None
        for label, fn in runners.items():
            try:
                out = fn(x).float()
                us = time_us(fn, x, 200 if m <= 256 else 20)
            except Exception as e:                                # unsupported on this GPU or build
                print(f"   {label:<18} not run: {str(e).splitlines()[0][:90]}")
                continue
            base = base or us
            err = ((out - ref).norm() / ref.norm()).item()
            gbps = N * K * bytes_per[label] / us / 1e3
            tflops = 2 * m * N * K / us / 1e6
            results[(m, label)] = us
            print(f"   {label:<18}{us:>9.1f}us{base / us:>8.2f}x{gbps:>14.0f}{tflops:>9.1f}{err:>8.2%}", flush=True)
        print()
    labels = list(runners)
    print("Speedup over BF16 by batch size (rows of activations)")
    print(f"   {'scheme':<18}" + "".join(f"{f'M={m}':>9}" for m in MS))
    for label in labels[1:]:
        cells = []
        for m in MS:
            if (m, label) in results and (m, "BF16") in results:
                cells.append(f"{results[(m, 'BF16')] / results[(m, label)]:>8.2f}x")
            else:
                cells.append(f"{'':>9}")
        print(f"   {label:<18}" + "".join(cells))
    print("\nweights GB/s = bytes of the stored weight matrix / time, the bandwidth the read would need if it were all;")
    print("error = relative RMS distance from an FP32 product of the original matrices.")


if __name__ == "__main__":
    main()
