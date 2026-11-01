# GPU labs: run these on an NVIDIA GPU

These scripts need an NVIDIA GPU, so they are kept apart from the Mac labs one folder up. They are plain Python and run unchanged on any machine with an NVIDIA GPU (`python <script>`), or on a rented GPU through Modal with `modal_run.py`.

## Running on Modal

1. `pip install modal`, then `modal setup` to sign in. Modal needs a payment method on the account before it starts any GPU; its Starter plan includes $30 of free credit a month.
2. Run a script: `modal run modal_run.py --script gpu_probe.py --gpu H100`. GPU types include `T4`, `L4`, `A10` and `H100`. Modal's `A10` type may give an A10 or the closely related A10G.
3. The vLLM labs (`decode_sweep.py`, `moe_decode_sweep.py`) need `--vllm`, which uses an image with vLLM installed.
4. Scripts that compile CUDA code (`cuda_rmsnorm.py`, `cuda_bug.py`, `ncu_strided.py`) need the CUDA toolkit: add `--toolkit` to use NVIDIA's CUDA 13.2 development image, which includes `nvcc`, `compute-sanitizer`, Nsight Compute and Nsight Systems (with the `libdw1` package its trace importer needs).
5. A container is guaranteed only 0.125 CPU cores by default and borrows more when the host has spare capacity, so launch-bound measurements, such as a batch-1 decode step, vary from host to host. Add `--cpu 4` to reserve four cores; it adds a fraction of a cent per minute.
6. Each successful run prints how long the script ran on the GPU and an estimated cost, and appends them to `modal_costs.jsonl`. The estimate covers GPU time only. It leaves out container start-up and the CPU and memory charges, including cores reserved with `--cpu`, which Modal also bills, so the real cost is a little higher. Modal bills while a container runs, not while a job waits for a free GPU; in October 2026 L4s were sometimes unavailable for an hour, while H100s and A10s started within a minute.

## Scripts

| Script | Chapter | GPU used for the chapter | What it measures |
|---|---|---|---|
| `gpu_probe.py` | 2.1 | H100, A10, L4 | SMs, caches, copy bandwidth by working set, strided reads, matmul peaks |
| `matmul_sizes.py` | 2.1 | H100 | Share of the tensor-core peak by matmul size |
| `triton_kernels.py` | 2.2 | H100, A10 | Vector add, softmax, RMSNorm and matmul in Triton against PyTorch and cuBLAS |
| `cuda_rmsnorm.py` | 2.3 | H100 (`--toolkit`) | RMSNorm in CUDA, with one-value and 16-byte loads |
| `cuda_bug.py` | 2.3 | A10 (`--toolkit`) | An off-by-one kernel caught by compute-sanitizer |
| `flash_attention.py` | 2.4 | H100 | A causal FlashAttention kernel in Triton against plain attention and SDPA |
| `profile_decode.py` | 2.5 | H100 (`--cpu 4`) | A decode step of Llama 3.2 1B under the PyTorch profiler, and clocks under load |
| `ncu_strided.py` | 2.5 | A10 (`--toolkit`) | Nsight Compute counters for a contiguous and a strided read |
| `nsys_decode.py` | 2.5 | H100 (`--toolkit --cpu 4`) | Nsight Systems summaries of 20 decode steps of Llama 3.2 1B: NVTX ranges, kernels and CUDA API calls |
| `decode_runtime.py` | 3.1 | H100 (`--cpu 4`) | Launch overhead, a decode step with a static cache, a CUDA graph and torch.compile, and the caching allocator |
| `decode_sweep.py` | 1.2, lab part B | H100 (`--vllm`) | Llama 3.1 8B decode step time and MBU at batch 1 to 64 with vLLM, with and without CUDA graphs |
| `moe_decode_sweep.py` | 1.3, lab part C | H100 (`--vllm`) | Qwen3-30B-A3B against Llama 3.1 8B with vLLM, next to the roofline prediction |

The two vLLM scripts call vLLM's Python API and were written against vLLM 0.32.0. On Modal, add `--vllm` to run them in an image with vLLM installed, built on NVIDIA's CUDA 13.0 development image because FlashInfer, vLLM's default sampler, compiles some kernels with `nvcc` on first use; that function also reserves 4 CPU cores and 32 GiB of memory. Elsewhere, `pip install vllm` on the GPU machine. Each run took about 10 minutes of H100 time, about $0.65, most of it downloading the weights and compiling the models.

## What to keep from each run

Keep the printed output, any JSON file the script writes, and the GPU, driver, CUDA and library versions. `modal_run.py` prints the GPU and driver, and most scripts print their library versions at the top; on your own machine, run `nvidia-smi` for the driver. Two runs can only be compared when these match; chapter 2.5 shows a decode step that took twice as long on a different Modal host.
