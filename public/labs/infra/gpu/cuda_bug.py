# cuda_bug.py: a kernel with an off-by-one bug that runs "fine", and compute-sanitizer finding it (chapter 2.3).
#
# The kernel scales n values, but its bounds check uses <= instead of <, so the thread whose index equals n reads
# and writes one value past the end. Run normally, nothing visibly goes wrong. Run under compute-sanitizer's memcheck
# tool, the out-of-bounds read is reported first, with the kernel, the thread and the address.
#
# PyTorch's caching allocator hands out pieces of larger memory blocks, so a write just past one tensor can land
# inside memory the allocator owns and go unnoticed even by the sanitizer. PYTORCH_NO_CUDA_MEMORY_CACHING=1 makes
# every tensor its own allocation, which lets the sanitizer see exact bounds.
#
# Needs an NVIDIA GPU and the CUDA toolkit. Run: python cuda_bug.py
#   or: modal run modal_run.py --script cuda_bug.py --gpu A10 --toolkit
import os
import subprocess
import sys

import torch
from torch.utils.cpp_extension import load_inline

CUDA_SRC = r"""
#include <torch/extension.h>
#include <ATen/cuda/CUDAContext.h>

__global__ void scale_kernel(const float* x, float* out, int n, float a) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i <= n) out[i] = a * x[i];          // BUG: should be i < n
}

torch::Tensor scale(torch::Tensor x, double a) {
    auto out = torch::empty_like(x);
    int n = x.numel();
    scale_kernel<<<(n + 255) / 256, 256, 0, at::cuda::getCurrentCUDAStream()>>>(
        x.data_ptr<float>(), out.data_ptr<float>(), n, (float)a);
    return out;
}
"""

ext = load_inline("scale_bug", cpp_sources="torch::Tensor scale(torch::Tensor x, double a);",
                  cuda_sources=CUDA_SRC, functions=["scale"], verbose=False)
x = torch.arange(1000, device="cuda", dtype=torch.float32)
y = ext.scale(x, 2.0)
torch.cuda.synchronize()
print(f"result looks right: {torch.equal(y, 2 * x)}  (under the sanitizer: {bool(os.environ.get('UNDER_SANITIZER'))})")

if not os.environ.get("UNDER_SANITIZER"):
    env = dict(os.environ, UNDER_SANITIZER="1", PYTORCH_NO_CUDA_MEMORY_CACHING="1")
    run = subprocess.run(["compute-sanitizer", "--tool", "memcheck", sys.executable, __file__],
                         env=env, capture_output=True, text=True)
    lines = [l for l in (run.stdout + run.stderr).splitlines()
             if (l.startswith("=========") or "result" in l) and "Host Frame" not in l and "backtrace" not in l]
    print("\n".join(lines[:12]))
