# Lab code for the AI Infrastructure Engineer Handbook

Every Python file the handbook's labs use is in this folder. The files in this folder run on a Mac with Apple silicon, on a Linux machine with an NVIDIA GPU, or on a plain CPU. The files in `gpu/` need an NVIDIA GPU (two of them also need vLLM), and `gpu/README.md` explains how to run them.

## Setup

```bash
uv venv --python 3.12 && source .venv/bin/activate
uv pip install -r requirements.txt
```

## Files by chapter

| Chapter | File | What it does | Packages |
|---|---|---|---|
| 0.1 The inference engineer role | `record.py` | Appends a benchmark result, with the machine and software versions, to `results/results.jsonl` | none (uses torch if present) |
| 0.2 Models and machines | `model_stats.py`, `configs/*.json` | Parameter count, weight bytes and KV cache bytes from a Hugging Face `config.json` | none |
| 1.1 The transformer, seen by the hardware | `layer_ops.py` | FLOPs, bytes and roofline time for each operation in one Llama 3.1 8B layer | none |
| 1.1 | `decoder_from_scratch.py` | A Llama decoder in plain tensor operations, checked against Hugging Face, with a FLOP count | torch, transformers |
| 1.2 The arithmetic of inference | `roofline_probe.py` | Measures your machine's bandwidth and matmul peak, then sweeps a decode-shaped matmul | torch |
| 1.2 | `step_model.py` | The roofline model of a decode step and a prefill for Llama 3.1 8B on an H100 and an L4 | none |
| 1.3 Mixture-of-experts models | `moe_layer.py` | An MoE layer written as a loop and in grouped form, checked against Hugging Face | torch, transformers |
| 1.3 | `expert_load.py` | Measures a real router's load, specialisation and dropped tokens on Granite 3.1 1B-A400M | torch, transformers |
| 1.3 | `moe_arithmetic.py` | Bytes, FLOPs and step time of Qwen3-30B-A3B against Llama 3.1 8B on one H100 | none |
| 2.1 How a GPU executes code | `access_patterns.py` | Copy bandwidth by working set and the cost of strided and random reads, on your own machine | torch |
| 2.2 Writing kernels in Triton | `tiling_traffic.py` | A model of a tiled matmul's memory traffic by tile size, tile order and GPU | none |
| 2.4 FlashAttention | `online_softmax.py` | The online softmax and tiled attention checked in NumPy, and attention's memory traffic | numpy |
| 2.1 to 2.5 | `gpu/gpu_probe.py`, `gpu/matmul_sizes.py`, `gpu/triton_kernels.py`, `gpu/cuda_rmsnorm.py`, `gpu/cuda_bug.py`, `gpu/flash_attention.py`, `gpu/profile_decode.py`, `gpu/ncu_strided.py` | Part 2's GPU labs; see `gpu/README.md` | torch (plus transformers for `profile_decode.py`, and the CUDA toolkit for `cuda_rmsnorm.py`, `cuda_bug.py` and `ncu_strided.py`), on an NVIDIA GPU |
| 1.2, 1.3 | `gpu/decode_sweep.py`, `gpu/moe_decode_sweep.py` | Measured decode step times with vLLM | vllm, on an NVIDIA GPU |

The chapters print the output each script gave, on an Apple M2 MacBook with 8 GB of memory for the Mac scripts and on Modal H100 and A10 GPUs for the GPU scripts, so you can compare your numbers with them.
