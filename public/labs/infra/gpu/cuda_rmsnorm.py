# cuda_rmsnorm.py: RMSNorm written in CUDA C++, compiled from Python, compared with Triton and PyTorch (chapter 2.3).
#
# Two CUDA versions of the same kernel, one block of 512 threads per row:
#   naive:  each thread reads one BF16 value (2 bytes) per load, and reads the row a second time to write it;
#   vec:    each thread reads eight BF16 values (16 bytes) per load and keeps them in registers.
# Both reduce the sum of squares with warp shuffles, then across warps through shared memory.
#
# Needs an NVIDIA GPU and nvcc (the CUDA toolkit), because torch.utils.cpp_extension compiles the code.
# Run: python cuda_rmsnorm.py      or: modal run modal_run.py --script cuda_rmsnorm.py --gpu H100 --toolkit
import torch
import triton
from torch.utils.cpp_extension import load_inline

from triton_kernels import rmsnorm as triton_rmsnorm, rmsnorm_eager

CUDA_SRC = r"""
#include <torch/extension.h>
#include <ATen/cuda/CUDAContext.h>      // the current CUDA stream that PyTorch is using
#include <c10/cuda/CUDAException.h>     // C10_CUDA_KERNEL_LAUNCH_CHECK
#include <cuda_bf16.h>

// Sum a value across the 32 lanes of a warp: five butterfly steps, no shared memory.
__device__ float warp_sum(float v) {
    for (int offset = 16; offset > 0; offset /= 2) v += __shfl_xor_sync(0xffffffff, v, offset);
    return v;
}

// Sum a value across the whole block: each warp reduces itself, then warp 0 reduces the warps' results.
__device__ float block_sum(float v) {
    __shared__ float partial[32];
    int lane = threadIdx.x % 32, warp = threadIdx.x / 32;
    v = warp_sum(v);
    if (lane == 0) partial[warp] = v;
    __syncthreads();
    v = (threadIdx.x < blockDim.x / 32) ? partial[threadIdx.x] : 0.0f;
    if (warp == 0) v = warp_sum(v);
    if (threadIdx.x == 0) partial[0] = v;
    __syncthreads();
    return partial[0];
}

__global__ void rmsnorm_naive_kernel(const __nv_bfloat16* x, const __nv_bfloat16* w, __nv_bfloat16* out,
                                     int cols, float eps) {
    const __nv_bfloat16* row = x + (size_t)blockIdx.x * cols;
    __nv_bfloat16* orow = out + (size_t)blockIdx.x * cols;
    float ss = 0.0f;
    for (int i = threadIdx.x; i < cols; i += blockDim.x) {          // consecutive threads, consecutive values
        float v = __bfloat162float(row[i]);
        ss += v * v;
    }
    float rstd = rsqrtf(block_sum(ss) / cols + eps);
    for (int i = threadIdx.x; i < cols; i += blockDim.x)            // second pass reads the row again
        orow[i] = __float2bfloat16(__bfloat162float(row[i]) * rstd * __bfloat162float(w[i]));
}

__global__ void rmsnorm_vec_kernel(const __nv_bfloat16* x, const __nv_bfloat16* w, __nv_bfloat16* out,
                                   int cols, float eps) {
    const uint4* row = reinterpret_cast<const uint4*>(x + (size_t)blockIdx.x * cols);   // 16 bytes = 8 BF16
    const uint4* wv = reinterpret_cast<const uint4*>(w);
    uint4* orow = reinterpret_cast<uint4*>(out + (size_t)blockIdx.x * cols);
    int nvec = cols / 8;
    uint4 buf[4];                                                   // the thread's part of the row, in registers
    float ss = 0.0f;
    int k = 0;
    for (int i = threadIdx.x; i < nvec; i += blockDim.x, ++k) {
        buf[k] = row[i];
        const __nv_bfloat162* h = reinterpret_cast<const __nv_bfloat162*>(&buf[k]);
        for (int j = 0; j < 4; ++j) { float2 f = __bfloat1622float2(h[j]); ss += f.x * f.x + f.y * f.y; }
    }
    float rstd = rsqrtf(block_sum(ss) / cols + eps);
    k = 0;
    for (int i = threadIdx.x; i < nvec; i += blockDim.x, ++k) {
        uint4 wq = wv[i], o;
        const __nv_bfloat162* h = reinterpret_cast<const __nv_bfloat162*>(&buf[k]);
        const __nv_bfloat162* hw = reinterpret_cast<const __nv_bfloat162*>(&wq);
        __nv_bfloat162* ho = reinterpret_cast<__nv_bfloat162*>(&o);
        for (int j = 0; j < 4; ++j) {
            float2 f = __bfloat1622float2(h[j]), g = __bfloat1622float2(hw[j]);
            ho[j] = __floats2bfloat162_rn(f.x * rstd * g.x, f.y * rstd * g.y);
        }
        orow[i] = o;
    }
}

static void check(const torch::Tensor& x, const torch::Tensor& w) {
    TORCH_CHECK(x.is_cuda() && x.dtype() == torch::kBFloat16 && x.is_contiguous() && x.dim() == 2, "x: contiguous 2-D BF16 CUDA tensor");
    TORCH_CHECK(w.is_cuda() && w.dtype() == torch::kBFloat16 && w.is_contiguous() && w.numel() == x.size(1), "w: contiguous BF16 CUDA tensor of length cols");
}

torch::Tensor rmsnorm_naive(torch::Tensor x, torch::Tensor w, double eps) {
    check(x, w);
    auto out = torch::empty_like(x);
    rmsnorm_naive_kernel<<<x.size(0), 512, 0, at::cuda::getCurrentCUDAStream()>>>(reinterpret_cast<const __nv_bfloat16*>(x.data_ptr()),
        reinterpret_cast<const __nv_bfloat16*>(w.data_ptr()), reinterpret_cast<__nv_bfloat16*>(out.data_ptr()),
        x.size(1), (float)eps);
    C10_CUDA_KERNEL_LAUNCH_CHECK();
    return out;
}

torch::Tensor rmsnorm_vec(torch::Tensor x, torch::Tensor w, double eps) {
    check(x, w);
    TORCH_CHECK(x.size(1) % 8 == 0 && x.size(1) <= 8 * 4 * 512, "vec kernel: cols must be a multiple of 8, at most 16384");
    auto out = torch::empty_like(x);
    rmsnorm_vec_kernel<<<x.size(0), 512, 0, at::cuda::getCurrentCUDAStream()>>>(reinterpret_cast<const __nv_bfloat16*>(x.data_ptr()),
        reinterpret_cast<const __nv_bfloat16*>(w.data_ptr()), reinterpret_cast<__nv_bfloat16*>(out.data_ptr()),
        x.size(1), (float)eps);
    C10_CUDA_KERNEL_LAUNCH_CHECK();
    return out;
}
"""
CPP_SRC = """
torch::Tensor rmsnorm_naive(torch::Tensor x, torch::Tensor w, double eps);
torch::Tensor rmsnorm_vec(torch::Tensor x, torch::Tensor w, double eps);
"""

if __name__ == "__main__":
    ext = load_inline("rmsnorm_cuda", cpp_sources=CPP_SRC, cuda_sources=CUDA_SRC,
                      functions=["rmsnorm_naive", "rmsnorm_vec"], extra_cuda_cflags=["-O3"], verbose=False)
    p = torch.cuda.get_device_properties(0)
    print(f"{p.name}, PyTorch {torch.__version__}, CUDA {torch.version.cuda}\n")
    torch.manual_seed(0)
    rows, cols = 16384, 4096
    x = torch.randn(rows, cols, device="cuda", dtype=torch.bfloat16)
    w = torch.randn(cols, device="cuda", dtype=torch.bfloat16)
    ref = rmsnorm_eager(x, w).float()
    gbs = lambda ms: (2 * x.numel() + cols) * 2 / (ms * 1e-3) / 1e9
    candidates = {
        "CUDA, one value per load": lambda: ext.rmsnorm_naive(x, w, 1e-5),
        "CUDA, 16-byte loads": lambda: ext.rmsnorm_vec(x, w, 1e-5),
        "Triton (chapter 2.2)": lambda: triton_rmsnorm(x, w),
        "PyTorch F.rms_norm": lambda: torch.nn.functional.rms_norm(x, (cols,), w, 1e-5),
    }
    print(f"RMSNorm, {rows} x {cols} BF16")
    for name, fn in candidates.items():
        err = (fn().float() - ref).abs().max().item()
        print(f"  {name:26s} {gbs(triton.testing.do_bench(fn)):6.0f} GB/s   max error {err:.1e}")
