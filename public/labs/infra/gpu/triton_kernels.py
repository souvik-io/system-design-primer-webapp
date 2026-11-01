# triton_kernels.py: four Triton kernels, each checked against PyTorch and timed (chapter 2.2).
#
#   1. vector add      the smallest complete kernel: one program per block of elements
#   2. softmax         one program per row, the row held in registers, three passes fused into one
#   3. RMSNorm         the same shape as softmax, with a weight; the lab's acceptance kernel
#   4. matmul          tiles of A and B through shared memory, tl.dot on tensor cores, grouped order for L2
#
# Needs an NVIDIA GPU; Triton ships inside the Linux PyTorch wheels.
# Run: python triton_kernels.py          or: modal run modal_run.py --script triton_kernels.py --gpu H100
import torch
import triton
import triton.language as tl

DEV = torch.device("cuda")


# 1. Vector add -----------------------------------------------------------------------------------------
@triton.jit
def add_kernel(x_ptr, y_ptr, out_ptr, n, BLOCK: tl.constexpr):
    pid = tl.program_id(0)                       # which block of BLOCK elements this program owns
    offs = pid * BLOCK + tl.arange(0, BLOCK)     # the element indices of that block, as a vector
    mask = offs < n                              # the last block may run past the end
    x = tl.load(x_ptr + offs, mask=mask)
    y = tl.load(y_ptr + offs, mask=mask)
    tl.store(out_ptr + offs, x + y, mask=mask)


def add(x, y):
    out = torch.empty_like(x)
    n = x.numel()
    add_kernel[(triton.cdiv(n, 1024),)](x, y, out, n, BLOCK=1024)
    return out


# 2. Softmax over the last dimension -------------------------------------------------------------------
@triton.jit
def softmax_kernel(x_ptr, out_ptr, stride, n_cols, BLOCK: tl.constexpr):
    row = tl.program_id(0)
    cols = tl.arange(0, BLOCK)
    mask = cols < n_cols
    x = tl.load(x_ptr + row * stride + cols, mask=mask, other=-float("inf")).to(tl.float32)
    x = x - tl.max(x, axis=0)                    # subtract the row max for numerical safety
    e = tl.exp(x)
    tl.store(out_ptr + row * stride + cols, (e / tl.sum(e, axis=0)).to(out_ptr.dtype.element_ty), mask=mask)


def softmax(x):
    rows, cols = x.shape
    out = torch.empty_like(x)
    softmax_kernel[(rows,)](x, out, x.stride(0), cols, BLOCK=triton.next_power_of_2(cols))
    return out


# 3. RMSNorm: y = x / sqrt(mean(x^2) + eps) * w ---------------------------------------------------------
@triton.jit
def rmsnorm_kernel(x_ptr, w_ptr, out_ptr, stride, n_cols, eps, BLOCK: tl.constexpr):
    row = tl.program_id(0)
    cols = tl.arange(0, BLOCK)
    mask = cols < n_cols
    x = tl.load(x_ptr + row * stride + cols, mask=mask, other=0.0).to(tl.float32)
    w = tl.load(w_ptr + cols, mask=mask, other=0.0).to(tl.float32)
    rstd = 1.0 / tl.sqrt(tl.sum(x * x, axis=0) / n_cols + eps)
    tl.store(out_ptr + row * stride + cols, (x * rstd * w).to(out_ptr.dtype.element_ty), mask=mask)


def rmsnorm(x, w, eps=1e-5):
    rows, cols = x.shape
    out = torch.empty_like(x)
    rmsnorm_kernel[(rows,)](x, w, out, x.stride(0), cols, eps, BLOCK=triton.next_power_of_2(cols), num_warps=8)
    return out


def rmsnorm_eager(x, w, eps=1e-5):
    """The textbook PyTorch version: a chain of separate kernels, six of which read or write the full tensor."""
    xf = x.float()
    return (xf * torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + eps) * w.float()).to(x.dtype)


# 4. Matmul ------------------------------------------------------------------------------------------------
@triton.autotune(
    configs=[
        triton.Config({"BM": 128, "BN": 256, "BK": 64, "GROUP_M": 8}, num_stages=3, num_warps=8),
        triton.Config({"BM": 128, "BN": 128, "BK": 64, "GROUP_M": 8}, num_stages=4, num_warps=4),
        triton.Config({"BM": 128, "BN": 128, "BK": 32, "GROUP_M": 8}, num_stages=4, num_warps=4),
        triton.Config({"BM": 64, "BN": 128, "BK": 32, "GROUP_M": 8}, num_stages=4, num_warps=4),
    ],
    key=["M", "N", "K"],
)
@triton.jit
def matmul_kernel(a_ptr, b_ptr, c_ptr, M, N, K, sam, sak, sbk, sbn, scm, scn,
                  BM: tl.constexpr, BN: tl.constexpr, BK: tl.constexpr, GROUP_M: tl.constexpr):
    # Map the program id to an output tile in grouped order: GROUP_M rows of tiles are walked column by
    # column, so programs running at the same time reuse the same panels of A and B from L2.
    pid = tl.program_id(0)
    num_m, num_n = tl.cdiv(M, BM), tl.cdiv(N, BN)
    group = pid // (GROUP_M * num_n)
    first_m = group * GROUP_M
    size_m = min(num_m - first_m, GROUP_M)
    pid_m = first_m + (pid % (GROUP_M * num_n)) % size_m
    pid_n = (pid % (GROUP_M * num_n)) // size_m

    rm = pid_m * BM + tl.arange(0, BM)
    rn = pid_n * BN + tl.arange(0, BN)
    rk = tl.arange(0, BK)
    a = a_ptr + rm[:, None] * sam + rk[None, :] * sak
    b = b_ptr + rk[:, None] * sbk + rn[None, :] * sbn
    acc = tl.zeros((BM, BN), dtype=tl.float32)   # the output tile lives in registers, in FP32
    for k in range(0, tl.cdiv(K, BK)):
        a_tile = tl.load(a, mask=(rm[:, None] < M) & (rk[None, :] < K - k * BK), other=0.0)
        b_tile = tl.load(b, mask=(rk[:, None] < K - k * BK) & (rn[None, :] < N), other=0.0)
        acc = tl.dot(a_tile, b_tile, acc)        # tensor-core multiply-accumulate of one BK slice
        a += BK * sak
        b += BK * sbk
    c = c_ptr + rm[:, None] * scm + rn[None, :] * scn
    tl.store(c, acc.to(c_ptr.dtype.element_ty), mask=(rm[:, None] < M) & (rn[None, :] < N))


def matmul(a, b):
    M, K = a.shape
    _, N = b.shape
    c = torch.empty((M, N), device=a.device, dtype=a.dtype)
    grid = lambda meta: (triton.cdiv(M, meta["BM"]) * triton.cdiv(N, meta["BN"]),)
    matmul_kernel[grid](a, b, c, M, N, K, a.stride(0), a.stride(1), b.stride(0), b.stride(1), c.stride(0), c.stride(1))
    return c


# Tests and timings ---------------------------------------------------------------------------------------
def ms(fn):
    return triton.testing.do_bench(fn)          # mean time in milliseconds; clears the L2 cache before each run


if __name__ == "__main__":
    torch.manual_seed(0)
    p = torch.cuda.get_device_properties(DEV)
    print(f"{p.name}, PyTorch {torch.__version__}, Triton {triton.__version__}\n")

    x, y = torch.randn(2**26, device=DEV), torch.randn(2**26, device=DEV)
    assert torch.equal(add(x, y), x + y)
    t_tri, t_torch = ms(lambda: add(x, y)), ms(lambda: x + y)
    gbs = lambda t: 3 * x.numel() * 4 / (t * 1e-3) / 1e9
    print(f"vector add, 64M float32:   Triton {gbs(t_tri):6.0f} GB/s   PyTorch {gbs(t_torch):6.0f} GB/s   (exact match)")

    rows, cols = 16384, 4096
    x = torch.randn(rows, cols, device=DEV, dtype=torch.bfloat16)
    err = (softmax(x).float() - torch.softmax(x.float(), -1)).abs().max().item()
    t_tri, t_torch = ms(lambda: softmax(x)), ms(lambda: torch.softmax(x, -1))
    gbs = lambda t: 2 * x.numel() * 2 / (t * 1e-3) / 1e9
    print(f"softmax, {rows}x{cols} BF16: Triton {gbs(t_tri):6.0f} GB/s   PyTorch {gbs(t_torch):6.0f} GB/s   max error {err:.1e}")

    w = torch.randn(cols, device=DEV, dtype=torch.bfloat16)
    ref = rmsnorm_eager(x, w)
    err = (rmsnorm(x, w).float() - ref.float()).abs().max().item()
    t_tri, t_eager = ms(lambda: rmsnorm(x, w)), ms(lambda: rmsnorm_eager(x, w))
    t_fn = ms(lambda: torch.nn.functional.rms_norm(x, (cols,), w, 1e-5))
    gbs = lambda t: (2 * x.numel() + cols) * 2 / (t * 1e-3) / 1e9
    print(f"RMSNorm, {rows}x{cols} BF16: Triton {gbs(t_tri):6.0f} GB/s   eager PyTorch {gbs(t_eager):6.0f} GB/s   "
          f"F.rms_norm {gbs(t_fn):6.0f} GB/s   max error {err:.1e}")

    print("\nmatmul, BF16, square (errors are relative to an FP32 matmul of the same inputs):")
    for n in (1024, 2048, 4096, 8192):
        a = torch.randn(n, n, device=DEV, dtype=torch.bfloat16)
        b = torch.randn(n, n, device=DEV, dtype=torch.bfloat16)
        ref = a.float() @ b.float()
        rel = lambda c: ((c.float() - ref).norm() / ref.norm()).item()
        tf = lambda t: 2 * n**3 / (t * 1e-3) / 1e12
        t_tri, t_cublas = ms(lambda: matmul(a, b)), ms(lambda: a @ b)
        best = matmul_kernel.best_config.kwargs
        print(f"  N={n:5d}: Triton {tf(t_tri):6.1f} TFLOP/s (error {rel(matmul(a, b)):.1e})   "
              f"cuBLAS {tf(t_cublas):6.1f} TFLOP/s (error {rel(a @ b):.1e})   best tile {best['BM']}x{best['BN']}x{best['BK']}")

    # Tile order: the same kernel and tile with GROUP_M = 1 (plain row-major order) and GROUP_M = 8. On a GPU with
    # less shared memory per block (the A10 and L4 have about 100 KB) the test uses 128 x 128, which the tiling
    # model predicts is memory-bound in row-major order.
    big = p.shared_memory_per_block_optin >= 150 * 1024
    tile = dict(BM=128, BN=256, BK=64, num_stages=3, num_warps=8) if big else dict(BM=128, BN=128, BK=32, num_stages=4, num_warps=4)
    n = 8192
    print(f"\nmatmul tile order, N={n}, tile {tile['BM']}x{tile['BN']}x{tile['BK']} (GROUP_M=1 is plain row-major order):")
    a = torch.randn(n, n, device=DEV, dtype=torch.bfloat16)
    b = torch.randn(n, n, device=DEV, dtype=torch.bfloat16)
    c = torch.empty_like(a)
    grid = (triton.cdiv(n, tile["BM"]) * triton.cdiv(n, tile["BN"]),)
    for g in (1, 8):
        run = lambda: matmul_kernel.fn[grid](a, b, c, n, n, n, a.stride(0), a.stride(1), b.stride(0), b.stride(1),
                                             c.stride(0), c.stride(1), GROUP_M=g, **tile)
        print(f"  GROUP_M={g}: {2 * n**3 / (ms(run) * 1e-3) / 1e12:6.1f} TFLOP/s")
