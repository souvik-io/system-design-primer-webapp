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
| 3.2 Native code and Python bindings | `native_sampler.py` | A top-k/top-p sampler in C++ bound with pybind11: zero-copy checks, correctness against NumPy, and 1 vs 4 threads with the GIL held or released | torch (as the build tool), numpy, ninja, and a C++ compiler |
| 3.3 Compilers and graph runtimes | `export_runtimes.py` | torch.export with dynamic shapes, then one small decoder run eagerly, with torch.compile, in ONNX Runtime and as an AOTInductor package | torch, onnx, onnxscript, onnxruntime, and a C++ compiler |
| 4.1 Number formats | `number_formats.py` | Every format decoded from its bit fields and checked against PyTorch, then a small model's weights quantized with per-tensor, MX and NVFP4 scales | torch, safetensors, huggingface_hub |
| 4.2 Quantization math | `quant_math.py` | Symmetric and asymmetric integer quantization at every granularity, clipping, a packed INT4 layer, activation outliers and their effect on perplexity | torch, transformers, pyarrow |
| 4.3 Post-training quantization algorithms | `ptq_algorithms.py` | GPTQ, AWQ and SmoothQuant from scratch on SmolLM2-135M, compared with round-to-nearest (imports `quant_math.py`) | torch, transformers, pyarrow |
| 4.4 Measuring quality loss | `quality_eval.py` | Perplexity, KL divergence, top-1 agreement, ARC-Easy accuracy and flips for each quantized version (imports the two files above) | torch, transformers, pyarrow |
| 4.5 Pruning and distillation | `pruning.py` | Magnitude and Wanda pruning, unstructured and 2:4, at 50% sparsity (imports the files above) | torch, transformers, pyarrow |
| 5.1 Build a mini inference engine | `nano_engine/` | A small engine: paged KV cache with copy-on-write, a scheduler with a token budget, chunked prefill and preemption, a Llama model over a flat batch, an OpenAI-compatible streaming server, tests against Hugging Face, and a benchmark. Run its files as modules from this folder, such as `python -m nano_engine.test_nano_engine` | torch, transformers, safetensors, huggingface_hub, fastapi, uvicorn |
| 5.3 SGLang and prefix caching | `prefix_cache_sim.py` | Two prefix caches from scratch, a radix tree with leaf eviction and hashed 16-token blocks with a free queue, replayed on chat, few-shot and multi-tenant traces at several pool sizes, then first-come-first-served against longest-prefix-first scheduling | none (standard library) |
| 2.1 to 2.5 | `gpu/gpu_probe.py`, `gpu/matmul_sizes.py`, `gpu/triton_kernels.py`, `gpu/cuda_rmsnorm.py`, `gpu/cuda_bug.py`, `gpu/flash_attention.py`, `gpu/profile_decode.py`, `gpu/nsys_decode.py`, `gpu/ncu_strided.py` | Part 2's GPU labs; see `gpu/README.md` | torch (plus transformers for `profile_decode.py` and `nsys_decode.py`, and the CUDA toolkit for `cuda_rmsnorm.py`, `cuda_bug.py`, `nsys_decode.py` and `ncu_strided.py`), on an NVIDIA GPU |
| 4.1 | `gpu/format_matmul.py` | Part 4's GPU lab: one matmul in every format the GPU supports, on H100, B200 and L4; see `gpu/README.md` | torch, on an NVIDIA GPU |
| 4.2 | `gpu/w4a16_matmul.py` | Weight-only INT4 (unfused, tinygemm, a Triton kernel, Marlin) against FP8 and INT8 W8A8 from batch 1 to 4,096 | torch, triton (vllm for Marlin), on an NVIDIA GPU |
| 4.3, 4.4 | `gpu/quantize_and_eval.py` | Llama 3.1 8B quantized with llm-compressor and served in vLLM: memory, speed, perplexity, GSM8K, ARC-Challenge and flips | the `quant` image, on an NVIDIA GPU |
| 4.5 | `gpu/sparse_matmul.py` | A 2:4 sparse matmul against the dense one | torch, on an NVIDIA GPU |
| 3.1 | `gpu/decode_runtime.py` | Part 3's GPU lab: a decode step with a static cache, CUDA graphs and torch.compile, and the caching allocator; see `gpu/README.md` | torch, transformers, on an NVIDIA GPU |
| 5.1 | `gpu/engine_bench.py`, `gpu/profile_engine.py` | nano_engine's tests on a GPU, then its throughput against vLLM's, and the chunked-prefill stall benchmark | the `vllm` image (which also provides the FlashAttention kernel nano_engine uses on CUDA), on an NVIDIA GPU |
| 5.2 | `gpu/inside_vllm.py` | One request traced through a vLLM server function by function, then throughput and latency for different `max_num_seqs`, `max_num_batched_tokens`, `gpu_memory_utilization` and prefix caching | the `vllm` image, on an NVIDIA GPU |
| 5.3 | `gpu/prefix_cache_bench.py` | vLLM and SGLang on a multi-turn chat workload and on a burst of requests with a shared prefix, with and without prefix caching and with a small KV pool | the `vllm` image for vLLM and the `sglang` image for SGLang, on an NVIDIA GPU |
| 1.2, 1.3 | `gpu/decode_sweep.py`, `gpu/moe_decode_sweep.py` | Measured decode step times with vLLM | vllm, on an NVIDIA GPU |

The chapters print the output each script gave, on an Apple M2 MacBook with 8 GB of memory for the Mac scripts and on Modal H100 and A10 GPUs for the GPU scripts, so you can compare your numbers with them.
