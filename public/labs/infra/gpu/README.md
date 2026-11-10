# GPU labs: run these on an NVIDIA GPU

These scripts need an NVIDIA GPU, so they are kept apart from the Mac labs one folder up. They are plain Python and run unchanged on any machine with an NVIDIA GPU (`python <script>`). Two launchers rent a GPU for you: `modal_run.py` on Modal and `gcp_run.py` on Google Cloud. Both build their containers from the same Dockerfiles in `images/`, so a lab gives the same software on either platform:

| Image | Dockerfile | Holds | Launcher flag |
|---|---|---|---|
| base | `images/base.Dockerfile` | Python 3.12, gcc (Triton compiles its kernel launchers with it), PyTorch 2.15.0 (CUDA 13.2 runtime, Triton), NumPy, Transformers | none |
| toolkit | `images/toolkit.Dockerfile` | the base packages on NVIDIA's CUDA 13.2 development image: `nvcc`, `compute-sanitizer`, Nsight Compute and Nsight Systems | `--toolkit` |
| vllm | `images/vllm.Dockerfile` | vLLM 0.32.0 on NVIDIA's CUDA 13.0 development image | `--vllm` |
| quant | `images/quant.Dockerfile` | vLLM 0.32.0 in `/opt/venv` and llm-compressor 0.15.0 in `/opt/llmc`, two environments because they pin different PyTorch versions | `--quant` |

Without either launcher, build and run an image yourself on any machine with an NVIDIA GPU and the NVIDIA Container Toolkit:

```bash
docker build -t lab-base -f images/base.Dockerfile images
docker run --rm --gpus all --ipc=host -v "$PWD":/labs -w /labs lab-base python gpu_probe.py
```

## Keeping it inside free credit

Modal's Starter plan includes $30 of credit a month, and Google Cloud accounts often carry promotional credits. `budget.py` keeps a ledger so the labs stay inside them. Copy `credits.example.json` to `credits.json` (git ignores it), enter your Google Cloud credits and their expiry months, and set your project. Before every run, each launcher prints what is left and refuses to start a run whose worst case (its time limit at the hourly price) does not fit; `--allow-over-budget` overrides that. `python budget.py` prints the balance at any time. The ledger only sees runs made through the launchers, so also set a billing alert on each account.

## Running on Modal

1. `pip install modal`, then `modal setup` to sign in. Modal needs a payment method on the account before it starts any GPU; its Starter plan includes $30 of free credit a month.
2. Run a script: `modal run modal_run.py --script gpu_probe.py --gpu 'H100!'`. GPU types include `T4`, `L4`, `A10` and `H100`. Modal's `A10` type may give an A10 or the closely related A10G, and Modal may run an `H100` request on an H200 at the same price, which changes timings and memory. The benchmark commands in the chapters therefore ask for `'H100!'`, which forbids the substitution; quote it, because `!` is special to the shell. The GPU each run got is the first line of its output.
3. The vLLM labs (`decode_sweep.py`, `moe_decode_sweep.py`) need `--vllm`, which uses an image with vLLM installed, and `quantize_and_eval.py` needs `--quant`, which adds llm-compressor.
4. Scripts that compile CUDA code (`cuda_rmsnorm.py`, `cuda_bug.py`, `ncu_strided.py`) need the CUDA toolkit: add `--toolkit` to use NVIDIA's CUDA 13.2 development image, which includes `nvcc`, `compute-sanitizer`, Nsight Compute and Nsight Systems (with the `libdw1` package its trace importer needs).
5. A container is guaranteed only 0.125 CPU cores by default and borrows more when the host has spare capacity, so launch-bound measurements, such as a batch-1 decode step, vary from host to host. Add `--cpu 4` to reserve four cores; it adds a fraction of a cent per minute.
6. Files the script writes next to itself, such as `quant_results.json`, are copied back into this folder when it finishes, even if it fails partway.
7. Each run prints how long the script ran on the GPU and an estimated cost, and appends them to `modal_costs.jsonl`. The estimate covers GPU time only. It leaves out container start-up and the CPU and memory charges, including cores reserved with `--cpu`, which Modal also bills, so the real cost is a little higher. Modal bills while a container runs, not while a job waits for a free GPU; in October 2026 L4s were sometimes unavailable for an hour, while H100s and A10s started within a minute.

## Running on Google Cloud

1. Install the Google Cloud CLI and sign in with `gcloud auth login`. Use a project with billing turned on, and put its ID in `credits.json` as `gcp_project` (or pass `--project`).
2. Request GPU quota (IAM & Admin > Quotas): `GPUS_ALL_REGIONS` of at least 1, plus the GPU type in `us-central1`, such as `PREEMPTIBLE_NVIDIA_L4_GPUS`. New projects start with none, and Google may refuse a request for a project with no billing history; a request on an older project of the same account is more likely to pass.
3. Run a script: `python gcp_run.py --script gpu_probe.py --gpu L4`. GPU types are `L4` (g2-standard-8), `L4:2` (two L4s), `A100` (40 GB) and `A100-80GB`, all in `us-central1`. `--toolkit` and `--vllm` choose the image, as on Modal.
4. Each run creates a Spot VM from Google's Deep Learning VM image, copies this folder to it, builds the image from `images/`, runs the script, copies the output and any files the script wrote to `runs/<script>-<gpu>-<time>/`, and deletes the VM, even after an error or Ctrl-C. Every VM also gets a time limit (`--max-hours`, one hour by default) after which Google deletes it, so nothing keeps billing if your laptop disconnects. The script runs detached on the VM and the launcher follows its log every 20 seconds, so a dropped SSH connection or a laptop that sleeps for a few minutes does not stop a long run; the launcher picks up where the log left off.
5. Spot VMs cost about 40% of the normal price but can be reclaimed at any moment; the launcher says so when it happens, and you run again or add `--on-demand`.
6. `--keep --max-hours 3` (with or without `--script`) leaves a VM running for you to SSH into, which suits long sessions such as building the Part 5 engine. `--list` shows the VMs the launcher started and `--cleanup` deletes them.
7. Each run appends the VM's lifetime and estimated cost to `gcp_costs.jsonl`. The hourly prices in `gcp_run.py` come from Google's Cloud Billing Catalog for us-central1 (November 2026): an L4 Spot VM costs about $0.51 an hour, an A100 40 GB Spot VM about $1.99.

Which platform to use: Modal starts in seconds, bills per second and has H100s without a quota request, so H100 labs and short benchmarks run there. Google Cloud is cheaper for L4s, gives you a whole VM (root access, GPU clock control, long sessions), and runs the Kubernetes labs in Part 8.

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
| `format_matmul.py` | 4.1 | H100, B200 (Modal), L4 (Google Cloud) | Matmul speed and error in BF16, FP16, INT8, FP8, and on Blackwell MXFP8, MXFP4 and NVFP4, at a prefill and a decode shape |
| `w4a16_matmul.py` | 4.2 | H100 (Modal, with and without `--vllm`), L4 (Google Cloud) | W4A16 kernels (unfused, tinygemm, Triton, Marlin with `--vllm`) against FP8 and INT8 W8A8, batch 1 to 4,096 |
| `quantize_and_eval.py` | 4.3, 4.4 | H100 (Modal, `--quant`) | Llama 3.1 8B quantized seven ways with llm-compressor, each served in vLLM: memory, speed and quality |
| `sparse_matmul.py` | 4.5 | H100 (Modal), L4 (Google Cloud) | A 2:4 sparse matmul (cuSPARSELt and CUTLASS) against dense BF16 |
| `engine_bench.py` | 5.1 | H100 (Modal, `--vllm`), A10 with `--args "--quick"` | nano_engine's tests on the GPU, its throughput against vLLM with and without CUDA graphs, and the chunked-prefill stall benchmark; imports `../nano_engine`, which both launchers copy next to the scripts |
| `profile_engine.py` | 5.1 | H100 (Modal, `--vllm`) | nano_engine's decode step with 256 sequences: step times, caching-allocator retries (`--default-allocator` to compare) and a PyTorch profile |

The two vLLM scripts call vLLM's Python API and were written against vLLM 0.32.0. On Modal, add `--vllm` to run them in an image with vLLM installed, built on NVIDIA's CUDA 13.0 development image because FlashInfer, vLLM's default sampler, compiles some kernels with `nvcc` on first use; that function also reserves 4 CPU cores and 32 GiB of memory. Elsewhere, `pip install vllm` on the GPU machine. Each run took about 10 minutes of H100 time, about $0.65, most of it downloading the weights and compiling the models.

## What to keep from each run

Keep the printed output, any JSON file the script writes, and the GPU, driver, CUDA and library versions. `modal_run.py` prints the GPU and driver, and most scripts print their library versions at the top; on your own machine, run `nvidia-smi` for the driver. Two runs can only be compared when these match; chapter 2.5 shows a decode step that took twice as long on a different Modal host.
