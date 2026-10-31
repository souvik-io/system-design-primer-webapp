# AI Infrastructure Engineer Handbook: syllabus

Working title: **AI Infrastructure Engineer Handbook: inference, from kernels to clusters.**

This is the plan for the second handbook on the site, published at `/infra`. Chapters in this folder are published once they are listed in a `PARTS` entry with `handbook: 'infra'` and `dir: 'infra'` in `scripts/build-content.mjs`; this file never is.

Target role: **AI Systems Engineer / Inference Engineer** (also posted as ML Infrastructure Engineer, AI Platform Engineer, LLM Deployment Engineer, Inference Optimization Engineer). The job is to serve existing models to many users within latency, memory and cost limits, not to train new ones.

Target date: applying from about **May 2027**, interviewing through the summer.

---

## How this handbook relates to the system design handbook

The site already has an "AI systems" part (`llm-inference`, `gpus-for-ai`, `inference-engines`, `ai-estimation`, `inference-fleets`, `training-infrastructure`) and an "AI system design questions" part (`design-inference-platform` and others). Those chapters explain **what** each technique is and **why** a design uses it, at system-design-interview depth.

This handbook goes one level down: **how it works, with your hands on it.** Each chapter here:

1. Lists the existing chapters it assumes as prerequisites and links to them instead of re-explaining (for example, the roofline intro is in `/learn/gpus-for-ai#compute-versus-memory-bandwidth`; here we measure a real one).
2. Has at least one **interactive simulation** (a widget) where you change a knob and watch the system respond.
3. Has a **lab**: a practical assignment with a stated deliverable, a hardware tier, and a reference solution that ships with the chapter (collapsed, so you try first).
4. Ends with "Check yourself" and "Further reading", like every other chapter.
5. Feeds one **flashcard deck** per part.

### Hardware tiers for labs

You are on a Mac, so every lab is tagged:

- **[Mac]** runs on Apple silicon (llama.cpp with Metal, MLX, PyTorch MPS, plain Python).
- **[1 GPU]** needs one NVIDIA GPU. Rent by the hour (RunPod, Lambda, Modal, Vast, Colab Pro). An L4 or A10G is enough for most; H100 only where FP8 matters.
- **[multi-GPU]** needs 2 to 8 GPUs on one node, rented for a few hours. Few labs need this; plan them in batches to keep the bill small.

Rough budget for the whole course: most labs are [Mac] or a few hours of [1 GPU]. Keep a running cost log; it doubles as interview material ("I benchmarked X for $Y").

### Chapter template (for when we write them)

```markdown
# Chapter title

Overview: what you will be able to do after this chapter, and which interview questions it answers.
Prerequisites: links to /learn/... chapters.

## Concept sections (3 to 7)
## Simulation        <- the widget, with "try this" prompts
## Lab               <- task, hardware tier, acceptance criteria, then <details> reference solution
## Interview angle   <- 3 to 5 questions you will be asked, and what a strong answer contains
## Check yourself
## Further reading
```

---

## Changes to the original plan

I compared your six pillars against current postings (Together AI, Nebius, Intel, Hedra, Uniphore and others list vLLM/SGLang/TensorRT-LLM, CUDA or Triton kernels, Nsight profiling, KV cache management, speculative decoding and quantization) and against what the open-source serving stack shipped in 2025-2026. The result:

### Added

| Addition | Why |
| --- | --- |
| **The transformer as a workload** (attention variants GQA/MQA/MLA, RoPE, MoE, where FLOPs and bytes go) | Every serving decision comes from these numbers. Interviews open with "walk me through a forward pass on a GPU". |
| **Writing kernels in Triton, plus CUDA basics** (upgraded from "basic concepts") | Inference-optimization postings ask you to read, debug and write kernels. Triton is the fastest way to a real, fast kernel. |
| **Profiling and benchmarking methodology** (Nsight Systems/Compute, PyTorch profiler, load generators, goodput) | Postings ask for "measurable speedups on real workloads". You cannot show those without a sound benchmark. |
| **PyTorch execution layer** (eager vs `torch.compile`, CUDA graphs, the caching allocator, custom ops) | Most engines are PyTorch plus custom kernels. CUDA graphs and compile explain a lot of decode-time wins. |
| **Speculative decoding** (draft models, EAGLE-3, multi-token prediction) and **structured output** | Standard in every engine; a common deep-dive question. |
| **SGLang and RadixAttention**, alongside vLLM; **TensorRT-LLM** | Postings name all three. Knowing two engine architectures lets you compare designs, which is what interviews probe. |
| **MoE serving and expert parallelism** (DeepEP, wide-EP, load balancing) | Most frontier open-weight models are now mixture-of-experts. Serving them is a different problem from dense models. |
| **Disaggregated prefill/decode and KV cache tiers** (NVIDIA Dynamo, llm-d, LMCache, NIXL) | The main architectural shift in large-scale serving in 2025-2026. |
| **Kubernetes inference stack** (Gateway API Inference Extension, llm-d, KServe, LeaderWorkerSet, KEDA) | Replaces "generic K8s": this is what platform teams actually deploy. |
| **FP4 formats** (NVFP4, MXFP4) and **KV cache quantization** | Blackwell made 4-bit floating point a serving format, not a research topic. |
| **Quality evaluation beyond perplexity** (KL divergence vs the base model, task evals with lm-eval-harness) | Perplexity alone misses damage that shows up on reasoning and chat tasks. |
| **Multi-LoRA serving** (S-LoRA/Punica style) | Connects fine-tuning to serving, which is where an inference engineer meets LoRA. |
| **Cost modelling** ($ per million tokens, GPU-hour math) | Interviewers ask you to compute this live. |
| **Interview and portfolio part** | The goal is a job, so the last part is about converting the work into offers. |

### Demoted to electives (still in the syllabus, off the critical path)

| Topic | Why demoted |
| --- | --- |
| **Android NDK/JNI, Qualcomm QNN, CoreML** | On-device roles are a separate market. Keep only if you decide to target edge AI. llama.cpp/GGUF and Metal stay in the core because they double as your Mac lab platform. |
| **Rust and PyO3** | Useful (several routers and Dynamo are Rust), but C++ extensions and Triton are asked about far more. Elective. |
| **DeepSpeed ZeRO and FSDP in depth** | Already covered at the right depth in `/learn/training-infrastructure`. Here they get one section inside the fine-tuning chapter. |
| **Generic modern C++ concurrency** | Narrowed to what inference code uses: RAII for GPU resources, a thread-safe request queue, a PyTorch C++ extension. |
| **Triton Inference Server** | Still deployed, but for LLMs NVIDIA now positions it under the Dynamo platform and most teams run vLLM/SGLang directly. One section, not a chapter. Watch the name clash: **Triton the kernel language** (OpenAI) and **Triton Inference Server** (NVIDIA) are unrelated. |
| **Ray Serve** | One section in the orchestration chapter. Kubernetes-native stacks are more common in postings; Ray matters mostly for multi-node vLLM and batch jobs. |

### Removed

Nothing removed outright. "Perplexity on WikiText-2 as the quality metric" is replaced by a fuller evaluation chapter (Part 4).

---

## Study plan at a glance

About 10 to 12 hours a week. Each part ends with a flashcard deck and one portfolio artifact.

| Weeks | Dates (approx.) | Part | Portfolio artifact |
| --- | --- | --- | --- |
| 1 | Nov 2026 | 0. Orientation and lab setup | Lab repo, benchmark harness skeleton |
| 2-4 | Nov-Dec 2026 | 1. The model as a workload | Byte/FLOP calculator notebook |
| 5-9 | Dec 2026-Jan 2027 | 2. GPUs and kernels | Triton kernels with roofline plots |
| 10-11 | Jan 2027 | 3. Runtime layer | C++ extension + CUDA-graph speedup writeup |
| 12-14 | Feb 2027 | 4. Compression | Quantization report on one model |
| 15-19 | Feb-Mar 2027 | 5. Serving engines | **Capstone A: mini inference engine** |
| 20-22 | Apr 2027 | 6. Distributed inference | Parallelism/disaggregation benchmark |
| 23-24 | Apr 2027 | 7. Fine-tuning for serving | QLoRA adapter served multi-LoRA |
| 25-28 | Apr-May 2027 | 8. Production | **Capstone B: deployed, observed, autoscaled service** |
| 29-32 | May-Jun 2027 | 10. Interviews | Mock loops, resume, blog posts |
| any time | | 9. Edge (elective) | llama.cpp/Metal benchmark |

Start applying around week 26 to 28; interview prep (Part 10) runs alongside the last parts.

---

## Drafted so far

| Syllabus | File | Status |
| --- | --- | --- |
| 0.1 | `inference-engineer-role.md` | Drafted 2026-10-31 |
| 0.2 | `models-and-machines.md` | Drafted 2026-10-31. Running example is now three models: Llama 3.2 1B for [Mac] labs (an 8 GB M2 cannot hold 8B), Llama 3.1 8B, Qwen3-30B-A3B |
| 1.1 | `transformer-as-workload.md` | Drafted 2026-10-31 |
| 1.2 | `inference-arithmetic.md` | Drafted 2026-10-31. Lab part B (vLLM on a rented GPU) has no measured reference output yet |

All four are published at `/infra` (two parts in `PARTS` with `handbook: 'infra'`), pass `lint-diagrams` and `verify-content`. The roofline-explorer widget is marked with an HTML comment in 1.2 and is not built yet.

## Part 0: Orientation

### 0.1 The inference engineer role
- What the job is day to day: a request's life from load balancer to kernel, who owns which layer.
- Role map: inference engineer vs ML platform vs MLOps vs research engineer vs kernel engineer, with skills each one is hired for.
- How interviews are structured: coding (Python, sometimes C++/CUDA), ML-systems deep dive, system design, behavioural, sometimes a take-home benchmark.
- **Simulation:** "Request journey" clickable diagram: click a layer (gateway, router, scheduler, model runner, kernel, HBM) to see what it does and which chapter covers it.
- **Lab [Mac]:** set up the lab repo: `uv` Python env, PyTorch (MPS), llama.cpp built with Metal, a cloud GPU account, and a `bench/` folder with a script that records hardware, versions and results as JSON. Reference solution: the repo layout and the recording script.
- Prereqs: `/learn/llm-inference`.

### 0.2 The running example
- Fix one model family used across chapters (a small dense model, e.g. an 8B Llama-class model, plus one MoE such as a Qwen- or DeepSeek-class model) and one GPU (H100 for numbers, L4 for cheap labs), so every chapter's numbers connect.
- How to read a model card and `config.json`: hidden size, layers, heads, KV heads, vocab, context length, expert counts.
- **Lab [Mac]:** write `model_stats.py` that reads any Hugging Face `config.json` and prints parameter count, weight bytes per precision, KV bytes per token. Reference solution included. (Reused in Parts 1, 4, 5, 6.)

---

## Part 1: The model as a workload

### 1.1 The transformer, seen by the hardware
- One decoder layer as a list of matmuls and element-wise ops; shapes at prefill (many tokens) vs decode (one token per sequence).
- Where the FLOPs are (projections, MLP, attention scores) and where the bytes are (weights, KV cache, activations).
- Attention variants and what they do to the KV cache: MHA, MQA, GQA, MLA (DeepSeek's latent attention). Sliding-window and hybrid attention.
- RoPE and why position handling matters for cache reuse.
- **Simulation:** "Layer explorer": pick a model and phase (prefill/decode) and batch size; each op shows FLOPs, bytes moved and arithmetic intensity as bars.
- **Lab [Mac]:** implement a decoder layer in ~150 lines of PyTorch (no `nn.MultiheadAttention`), check it against Hugging Face output to 1e-3. Count FLOPs with your formulas and compare to `torch.utils.flop_counter`. Reference: annotated implementation.
- Prereqs: `/learn/llm-inference#the-kv-cache`.

### 1.2 The arithmetic of inference
- FLOPs per token (about 2 x parameters) and bytes per decode step (all weights + the batch's KV cache).
- Arithmetic intensity of prefill vs decode; why decode is memory-bandwidth bound until batch size gets large.
- The batch size where decode turns compute bound, per GPU and precision.
- Latency floor for a decode step = bytes / bandwidth; throughput ceiling = FLOPs / peak.
- Cost: tokens per second per GPU to $ per million tokens.
- **Simulation:** "Roofline explorer" (new widget): pick GPU (A100, H100, H200, B200, L4, M-series), precision, batch, context length; a point moves along the roofline and the panel shows step time, tokens/s and $/M tokens.
- **Lab [Mac + 1 GPU]:** measure real decode tokens/s at batch 1, 8, 32, 128 for the running model; plot measured vs predicted on the roofline. Explain the gap. Reference: notebook and expected plot shape.
- Prereqs: `/learn/gpus-for-ai`, `/learn/ai-estimation`.

### 1.3 Mixture-of-experts models
- Router, top-k experts, shared experts; active vs total parameters.
- Why MoE changes the math: weights to read per token depend on which experts get hit; memory is sized by total params, compute by active.
- Load imbalance and capacity factors.
- **Simulation:** "Expert router": send a batch of tokens through a router, watch expert loads, toggle top-k and expert count, see the hottest expert set the step time.
- **Lab [Mac]:** implement a tiny MoE layer with top-2 routing; measure expert load on real text using a small open MoE model's router logits. Reference included.

**Deck: "The model as a workload"** (FLOP/byte formulas, intensity, attention variants, MoE terms).

---

## Part 2: GPUs and kernels

### 2.1 How a GPU executes code
- SMs, warps, threads, blocks, grids; occupancy; tensor cores.
- Memory hierarchy: registers, shared memory/L1 (SRAM), L2, HBM; bandwidth and capacity at each level.
- Coalesced access, bank conflicts, and why the same math can be 10x apart in speed.
- Hopper/Blackwell features worth knowing by name: TMA, warp specialization, thread-block clusters, FP8/FP4 tensor cores.
- **Simulation:** "Warp memory access": 32 threads issue addresses; see how many memory transactions result for coalesced, strided and random patterns.
- **Lab [1 GPU]:** `deviceQuery`-style script plus a bandwidth test (copy kernel) and a FLOP test (large matmul); compare against the spec sheet. Reference included.

### 2.2 Writing kernels in Triton
- Triton's block programming model vs CUDA's thread model.
- Kernels in order: vector add, fused softmax, layer norm, tiled matmul. Autotuning.
- Fusion: why fusing element-wise ops into a matmul epilogue saves HBM trips.
- **Simulation:** "Tiling animator": a matmul tiled into blocks; watch tiles move from HBM into SRAM and count bytes read for different tile sizes.
- **Lab [1 GPU]:** write a fused RMSNorm and a tiled matmul in Triton; benchmark vs PyTorch; put both on the roofline. Acceptance: RMSNorm within 10% of bandwidth limit. Reference: kernels and benchmark script.

### 2.3 CUDA for reading and debugging
- CUDA C++ basics: kernels, launch config, shared memory, synchronization, streams, events.
- Reading production kernels: a FlashAttention or vLLM paged-attention kernel, line by line.
- CUTLASS/CuTe and ThunderKittens by name; ROCm/HIP differences in one section (AMD postings ask for HIP).
- **Lab [1 GPU]:** port your Triton RMSNorm to CUDA, load it with `torch.utils.cpp_extension.load_inline`, compare. Reference included.

### 2.4 FlashAttention from the ground up
- Standard attention's memory traffic; online softmax; tiling Q, K, V through SRAM.
- FlashAttention 1/2/3 differences in one table; decode-time variants (FlashDecoding, split-K).
- Paged attention kernels: reading K/V through a block table.
- **Simulation:** "Online softmax stepper": step through blocks of scores, watch the running max, sum and output being rescaled.
- **Lab [1 GPU]:** implement FlashAttention forward in Triton (causal), test against PyTorch SDPA, benchmark across sequence lengths. Reference included. (This is a common take-home.)

### 2.5 Profiling and benchmarking
- Nsight Systems (timeline: kernel gaps, CPU launch overhead, syncs) and Nsight Compute (per-kernel: achieved bandwidth, occupancy, stall reasons).
- PyTorch profiler and trace viewing.
- Benchmark hygiene: warmup, clocks, variance, reporting percentiles, recording versions.
- **Simulation:** "Read the timeline": a fake Nsight timeline with planted problems (launch gaps, host sync, small kernels); click to diagnose.
- **Lab [1 GPU]:** profile one decode step of the running model under Hugging Face `generate`; find the top three time sinks; write a one-page findings memo. Reference: an example memo.

**Deck: "GPUs and kernels"**.

---

## Part 3: The runtime layer

### 3.1 PyTorch execution for inference
- Eager mode overhead; `torch.compile` (Dynamo, Inductor), graph breaks, dynamic shapes.
- CUDA graphs: capture and replay; why engines capture one graph per batch size; padding batches to captured sizes.
- The CUDA caching allocator, fragmentation, `PYTORCH_CUDA_ALLOC_CONF`.
- **Simulation:** "Launch overhead": a timeline of 200 tiny kernels launched one by one vs replayed as a graph.
- **Lab [1 GPU]:** take your Part 1 decoder and get decode latency down using `torch.compile` and CUDA graphs; report each step's gain. Reference included.

### 3.2 Native code and Python bindings
- When to drop to C++: tight loops on the CPU side (schedulers, tokenizers, samplers), custom ops.
- PyTorch C++ extensions and custom ops (`TORCH_LIBRARY`), pybind11 and nanobind; zero-copy via DLPack and the buffer protocol; releasing the GIL.
- The C++ you need: RAII for GPU memory and streams, `unique_ptr`/`shared_ptr`, move semantics, `std::span`; a thread-safe queue with a condition variable.
- **Lab [Mac]:** write a C++ top-k/top-p sampler exposed to Python with pybind11 (zero-copy from NumPy), releasing the GIL; compare with a NumPy version under 4 threads. Reference included.
- **Elective 3.2b:** the same with Rust and PyO3.

### 3.3 Compilers and graph runtimes
- ONNX and ONNX Runtime, TensorRT and TensorRT-LLM engine builds, `torch.export`; when an ahead-of-time engine wins and what it costs (build times, rigid shapes).
- **Lab [1 GPU], optional:** export the running model to a TensorRT-LLM engine and compare with vLLM at two batch sizes.

**Deck: "Runtime layer"**.

---

## Part 4: Compression

### 4.1 Number formats
- FP32, BF16, FP16, FP8 (E4M3, E5M2), INT8, INT4, FP4 (E2M1); block-scaled formats MXFP4/MXFP8 and NVFP4.
- Range vs precision, scales, and what each GPU generation runs natively.
- **Simulation:** "Bit explorer" (new widget): type a number, see its bits and rounding in each format; switch block size and scale type for MX/NV formats.
- Prereqs: `/learn/gpus-for-ai#number-formats-and-quantization`.

### 4.2 Quantization math
- Symmetric vs asymmetric, scale and zero-point, per-tensor/per-channel/per-group, clipping and calibration.
- Weight-only (W4A16, W8A16) vs weight-and-activation (W8A8, FP8): which one helps a memory-bound decode and which one helps compute-bound prefill.
- Outliers in activations and why they break naive INT8.
- **Simulation:** "Quantization playground" (new widget): a weight histogram with an outlier; change bits, group size, symmetric/asymmetric; see the grid, the error and the outlier's effect.
- **Lab [Mac]:** quantize a linear layer to INT4 with per-group scales from scratch; write the dequantize-matmul; measure error vs group size. Reference included.

### 4.3 Post-training quantization algorithms
- GPTQ (second-order, column by column), AWQ (protect salient channels by scaling), SmoothQuant (move outliers from activations to weights), and newer rotation-based methods (QuaRot/SpinQuant) in brief.
- GGUF and k-quants for llama.cpp.
- FP8 and NVFP4 in practice: llm-compressor and NVIDIA Model Optimizer producing checkpoints vLLM loads.
- KV cache quantization (FP8 KV) and what it does to capacity.
- **Lab [1 GPU]:** quantize the running model with AWQ, GPTQ and FP8 using llm-compressor; serve each in vLLM; record memory, tokens/s and quality (next chapter). Reference: commands and an expected results table.

### 4.4 Measuring quality loss
- Perplexity on WikiText-2 and its limits; KL divergence of output distributions vs the BF16 model; task evals with lm-eval-harness (MMLU-style, GSM8K-style); spot checks on long context and code.
- Building a "quality vs memory vs speed" table you can defend.
- **Simulation:** "Pareto picker": points for each quantized variant on memory/speed/quality axes; pick a budget, see which variants qualify.
- **Lab:** produce the report from 4.3's runs. Reference: report template.

### 4.5 Other compression (short)
- Distillation, pruning (2:4 sparsity), and when they are worth it compared with quantization.

**Deck: "Compression"**.

---

## Part 5: Serving engines

### 5.1 Build a mini inference engine (capstone A starts here)
- The engine loop: admit requests, schedule, run prefill or decode, sample, stream, free.
- Paged KV cache: block allocator, block tables, copy-on-write for parallel sampling.
- Continuous batching and chunked prefill; preemption by recompute or swap.
- **Simulation:** "Paged KV allocator" (extends the existing `kv-cache-calculator` and `batching-simulator`): requests arrive, blocks are allocated in a grid, fragmentation and preemption are visible.
- **Lab [Mac → 1 GPU]:** build `nano-engine`: a Python engine with paged KV (using your Part 2 or a library paged-attention kernel), continuous batching, chunked prefill, streaming over an OpenAI-compatible HTTP endpoint. Acceptance: within 3x of vLLM throughput on a fixed benchmark. Reference: a minimal solution with tests (nano-vLLM-style projects show this fits in ~1,500 lines).
- Prereqs: `/learn/inference-engines`.

### 5.2 Inside vLLM
- Architecture walk: API server, engine core, scheduler, KV cache manager, model runner, workers; the V1 engine's design.
- Reading the scheduler and block manager code; where CUDA graphs and `torch.compile` fit.
- Config knobs that matter: `max_num_seqs`, `max_num_batched_tokens`, `gpu_memory_utilization`, prefix caching, chunked prefill.
- **Lab [1 GPU]:** trace one request through vLLM with logging; then make a small, real contribution (doc fix, test, small bug) or a written design note of one subsystem. Reference: a guided code-reading map.

### 5.3 SGLang and prefix caching
- RadixAttention: KV cache as a radix tree over token prefixes; eviction; cache-aware scheduling.
- Where prefix reuse pays: system prompts, multi-turn chat, agents, few-shot.
- **Simulation:** "Radix tree cache": send prompts with shared prefixes; watch the tree grow, hit rates, and LRU eviction.
- **Lab [1 GPU]:** benchmark vLLM vs SGLang on a multi-turn chat trace with and without prefix caching; explain differences. Reference included.

### 5.4 Speculative decoding
- Draft-then-verify; acceptance rate; expected tokens per target pass; when it hurts (large batches, compute-bound).
- Draft models, n-gram/prompt lookup, Medusa, EAGLE (EAGLE-3), multi-token prediction heads.
- **Simulation:** "Speculation simulator": set acceptance rate, draft length, draft cost, batch size; see speedup and where it goes negative.
- **Lab [1 GPU]:** run vLLM with an EAGLE-style draft and with n-gram lookup on code and chat traces; report speedup at batch 1 and 32. Reference included.
- Prereqs: `/learn/inference-engines#speculative-decoding`.

### 5.5 Structured output and sampling
- Sampling kernels (top-k, top-p, min-p, penalties) and their cost; constrained decoding with grammars (xgrammar, Outlines) and its overhead.
- **Lab [Mac]:** add JSON-schema-constrained decoding to `nano-engine` using a grammar library.

### 5.6 TensorRT-LLM and Triton Inference Server (short)
- In-flight batching, engine builds, plugins; when teams pick it; how Triton Inference Server fits under NVIDIA Dynamo.

**Deck: "Serving engines"**.

---

## Part 6: Distributed inference

### 6.1 Collectives and interconnects
- All-reduce, all-gather, reduce-scatter, all-to-all; ring and tree algorithms; NCCL.
- PCIe vs NVLink/NVSwitch vs InfiniBand/RoCE; NVL72-style racks.
- **Simulation:** "Ring all-reduce": step through chunks moving around a ring; change GPU count and link bandwidth; see time.
- **Lab [multi-GPU]:** run `nccl-tests` on 2/4/8 GPUs over NVLink and PCIe; compare bus bandwidth. Reference included.
- Prereqs: `/learn/gpus-for-ai#connecting-gpus`.

### 6.2 Parallelism for inference
- Tensor parallelism (column/row splits, one all-reduce per block), pipeline parallelism (bubbles, micro-batches), data parallelism, context/sequence parallelism for long prompts.
- Choosing TP vs PP vs replicas for latency or throughput; memory per GPU.
- **Simulation:** "Parallelism planner" (new widget): pick model, GPUs, TP/PP/DP; see memory per GPU, KV capacity, communication per token, and whether it fits.
- **Lab [multi-GPU]:** serve the running model at TP=1, 2, 4 and with 2 replicas of TP=2; plot latency vs throughput. Reference included.
- Prereqs: `/learn/gpus-for-ai#splitting-a-model-across-gpus`.

### 6.3 Serving MoE models
- Expert parallelism; dispatch and combine all-to-all; DeepEP's two modes (throughput for prefill, low latency for decode); wide-EP across nodes; expert load balancing (EPLB); dual-batch overlap.
- **Simulation:** extends the 1.3 expert router with GPUs: experts placed on GPUs, all-to-all traffic drawn per step, hot experts replicated.
- **Lab [multi-GPU], optional:** serve a small MoE with EP in vLLM or SGLang; compare with TP. Reference: configs and expected trends.

### 6.4 Disaggregated prefill and decode
- Why prefill and decode interfere; splitting them into pools; KV transfer (NIXL, RDMA); xPyD ratios; when it does not pay.
- NVIDIA Dynamo, llm-d, SGLang PD disaggregation, Mooncake: what each provides.
- **Simulation:** "Disaggregation timeline": aggregated vs disaggregated GPUs on a timeline; change prompt/output lengths and pool ratios; watch TTFT and ITL distributions.
- **Lab [multi-GPU]:** run a 1P1D setup with vLLM + a KV connector; compare TTFT and ITL with an aggregated baseline on a long-prompt trace. Reference included.
- Prereqs: `/learn/inference-fleets#separating-prefill-and-decode`.

### 6.5 KV cache beyond one GPU
- Offloading KV to CPU memory and SSD (LMCache, Dynamo KVBM); cross-instance prefix reuse; KV-aware routing.
- Long-context serving: sliding window, attention sinks, KV compression and eviction in brief.
- **Lab [1 GPU]:** enable CPU offload with LMCache on a multi-turn trace; measure TTFT on returning conversations. Reference included.

**Deck: "Distributed inference"**.

---

## Part 7: Fine-tuning for serving

### 7.1 LoRA and QLoRA mechanics
- Delta W = B x A, rank r, alpha scaling, which projections to target, parameter and memory counts.
- QLoRA: NF4, double quantization, paged optimizers; when merging adapters is right and when it is not.
- **Simulation:** "LoRA rank explorer": choose layer sizes, rank and targets; see trainable params, adapter size, and memory for training.
- **Lab [1 GPU]:** QLoRA-fine-tune the running 8B model on a small instruction dataset with PEFT/TRL; evaluate before/after. Reference: script, hyperparameters, and expected loss curve.

### 7.2 Training infrastructure you need to know
- Sequence packing, activation checkpointing, FlashAttention in training, mixed precision.
- FSDP and DeepSpeed ZeRO stages in one comparison table (links to `/learn/training-infrastructure` for depth).
- **Lab:** add packing to the 7.1 run; report tokens/s and padding waste before and after.

### 7.3 Serving many adapters
- Multi-LoRA batching (S-LoRA/Punica ideas): one base model, many adapters per batch, adapter paging.
- **Lab [1 GPU]:** serve your adapter plus 10 random ones in vLLM multi-LoRA; measure throughput as adapter count grows. Reference included.
- Prereqs: `/learn/design-inference-platform#adapters-on-a-shared-base`.

**Deck: "Fine-tuning for serving"**.

---

## Part 8: Production

### 8.1 Containers and the CUDA stack
- Driver vs CUDA runtime vs toolkit, compatibility rules; NVIDIA Container Toolkit; slim inference images; weight loading (safetensors, local NVMe cache, streaming loaders) and cold-start time.
- **Lab [1 GPU]:** build a vLLM image, mount weights from a cache volume, measure cold start, then cut it. Reference: Dockerfile and timings.

### 8.2 Kubernetes for GPU inference
- GPU operator, device plugin, MIG/time-slicing; node pools, taints, affinity; LeaderWorkerSet for multi-node models.
- Gateway API Inference Extension (model-aware routing), llm-d, KServe; where Ray Serve fits.
- **Simulation:** "Cluster placement": drag models onto GPU nodes with memory and NVLink constraints.
- **Lab [1 GPU, kind/k3s or a small cloud cluster]:** deploy vLLM behind the inference gateway with two replicas; route by KV-cache-aware scoring. Reference: manifests.

### 8.3 Autoscaling and routing
- Scale on queue depth, KV cache usage, or in-flight tokens, not CPU; scale-to-zero vs warm pools; cold start budgets.
- Load balancing policies: round robin vs least-load vs prefix-affinity.
- **Simulation:** "Autoscaler sim": a traffic curve hits a fleet; change the metric, thresholds and cold-start time; watch queueing and SLO misses.
- **Lab:** KEDA scaling on vLLM's queue metric; replay a burst; record SLO attainment. Reference included.
- Prereqs: `/learn/inference-fleets#autoscaling`.

### 8.4 Observability and SLOs
- Metrics: TTFT, ITL/TPOT, end-to-end latency percentiles, tokens/s, goodput, KV cache usage, queue depth, preemptions, GPU utilization vs SM activity (DCGM).
- Prometheus and Grafana for vLLM; request tracing with OpenTelemetry.
- **Lab:** a Grafana dashboard for your Capstone B service with alerts on TTFT p99 and KV saturation. Reference: dashboard JSON.

### 8.5 Load testing and capacity planning
- Workload traces (prompt/output length distributions), open vs closed loop load, the latency-throughput curve, finding the knee; tools (`vllm bench`, GuideLLM, genai-perf).
- From the curve to GPU count and $ per million tokens.
- **Simulation:** "Latency-throughput curve": vary request rate and see p50/p99 TTFT and ITL; mark the SLO line and the max goodput point.
- **Lab:** produce a capacity plan for "10M requests a day at p99 TTFT under 1 s". Reference included.

### 8.6 Reliability and incidents
- GPU failures (Xid errors, ECC, NVLink faults), health checks, draining, request retries and idempotency for streaming; version rollouts and canaries for models.
- **Exercise:** five incident write-ups (symptom → diagnosis → fix) to practise for behavioural and debugging interviews.

**Capstone B:** the Part 5 engine or vLLM, containerized, on Kubernetes, autoscaled, with dashboards, a load test report and a cost per million tokens. This is your main portfolio piece.

**Deck: "Production"**.

---

## Part 9 (elective): Edge and on-device inference

- **9.1 llama.cpp and GGUF internals**: ggml graphs, quant types, Metal backend, KV cache on unified memory. Lab [Mac]: benchmark k-quants on your Mac; plot tokens/s vs quality.
- **9.2 Apple: MLX, Metal, Core ML**: unified memory and why Macs serve big models slowly but cheaply. Lab [Mac]: same model in MLX vs llama.cpp.
- **9.3 Mobile**: ONNX Runtime Mobile, Android NNAPI/QNN delegates, JNI/NDK bridging, ExecuTorch. Only if you target on-device roles.

---

## Part 10: Interviews and portfolio

### 10.1 The interview loop
- Formats by company type (labs, inference startups, cloud providers, enterprises), what each round tests, and how to prepare.

### 10.2 Coding rounds for inference roles
Short, self-checking problems in Python/PyTorch, each with a reference solution:
- implement causal self-attention with a KV cache; GQA
- top-k / top-p sampling with temperature
- a paged block allocator with free list and ref counts
- a continuous-batching scheduler step
- online softmax; a blocked matmul
- a token-bucket admission controller for tokens/s budgets
- a C++ thread-safe bounded queue

### 10.3 ML-systems deep dives
Question bank with model answers: "why is decode memory bound", "size the KV cache for X", "FP8 vs AWQ for this workload", "when does speculative decoding hurt", "TP=8 or two TP=4 replicas", "design prefix caching across replicas".

### 10.4 System design rounds
Point to the existing `/learn/design-inference-platform`, `/learn/design-llm-gateway`, `/learn/design-chat-assistant` and add two: "serve a 600B MoE model at 50k req/min" and "multi-tenant fine-tuning and serving service".

### 10.5 Portfolio and resume
- Three artifacts: Capstone A (engine), Capstone B (deployed service), one kernel or quantization report with numbers.
- Two or three blog posts from your lab reports. One small upstream contribution to vLLM, SGLang or llama.cpp.
- Resume bullets with measured results.

**Deck: "Inference interview"**.

---

## New interactive simulations to build

Existing widgets to reuse: `kv-cache-calculator`, `batching-simulator`.

| Widget | Chapter | Priority |
| --- | --- | --- |
| Roofline explorer | 1.2, 2.x | 1 |
| Layer explorer (FLOPs/bytes per op) | 1.1 | 1 |
| Tiling animator | 2.2 | 1 |
| Online softmax stepper | 2.4 | 1 |
| Quantization playground | 4.2 | 1 |
| Bit/format explorer | 4.1 | 2 |
| Paged KV allocator (extends existing) | 5.1 | 1 |
| Radix tree prefix cache | 5.3 | 2 |
| Speculative decoding simulator | 5.4 | 2 |
| Ring all-reduce | 6.1 | 2 |
| Parallelism planner | 6.2 | 1 |
| Expert router / EP traffic | 1.3, 6.3 | 2 |
| Disaggregation timeline | 6.4 | 2 |
| LoRA rank explorer | 7.1 | 3 |
| Autoscaler sim | 8.3 | 2 |
| Latency-throughput curve | 8.5 | 1 |
| Warp memory access | 2.1 | 3 |
| Nsight timeline reader | 2.5 | 3 |

---

## Hosting

Recommendation: **same site, separate handbook.** Keep one domain and one app, add a second curriculum next to the system design one (for example `/infra` with its own landing page, progress bar and decks).

- Reuses everything already built: diagrams, widgets, flashcards with SM-2, notes, study plans, sync, llms.txt, prerendering.
- Cross-links both ways: this handbook's prerequisites are the AI systems chapters, and the AI chapters can point down to the deep dives.
- One site with both handbooks reads stronger on a resume than two thin ones.

What it needs (later, once two chapters exist): a "handbook" level above `PARTS` in `scripts/build-content.mjs`, chapter ids that cannot clash (an `infra-` prefix or a `/infra/<id>` route), separate progress totals, and the new widgets. A separate site would duplicate all of that for little gain.

---

## Suggested first two chapters

1. **1.2 The arithmetic of inference**, with the roofline explorer widget. Everything later refers back to its numbers.
2. **5.1 Build a mini inference engine** (concepts and the first half of the lab). It is the best portfolio piece and gives every later part something concrete to plug into.

If you prefer to go in order, write **0.2 + 1.1** first instead.

---

## Sources consulted for this syllabus

- Job postings: [Together AI, LLM inference frameworks and optimization](https://jobs.generalcatalyst.com/companies/together-ai-2/jobs/72517179-llm-inference-frameworks-and-optimization-engineer), [Uniphore, senior inference engineer](https://www.dice.com/job-detail/736b5e4b-8610-411b-88bc-5b79f3d5607c), [Hedra, inference optimization](https://builtin.com/job/inference-optimization-engineer/11572766), [Nebius, LLM inference optimization](https://jobpilot.suxrobgm.net/jobs/senior-machine-learning-engineer-llm-inference-optimization-at-nebius-group-05fe1a), [Intel, AI infrastructure engineer](https://intel.wd1.myworkdayjobs.com/en-US/External/job/AI-Infrastructure-Engineer_JR0286233).
- Interview prep: [AI inference infrastructure interview prep 2026](https://www.techinterview.org/post/3233475331/ai-inference-infrastructure-interview-prep-2026-vllm-triton/), [InterviewCoder LLM engineer questions](https://www.interviewcoder.co/blog/llm-engineer-interview-questions).
- Disaggregation and KV tiers: [NVIDIA Dynamo disaggregated serving](https://docs.nvidia.com/dynamo/latest/design-docs/disaggregated-serving), [Dynamo KV cache offloading](https://docs.nvidia.com/dynamo/v1.0.0/additional-resources/v-llm-details/kv-cache-offloading).
- MoE serving: [vLLM wide-EP large-scale serving](https://vllm.ai/blog/large-scale-serving), [SGLang large-scale EP on 96 H100s](https://lmsys.org/blog/2025-05-05-large-scale-ep/), [vLLM expert parallel deployment docs](https://docs.vllm.ai/en/latest/serving/expert_parallel_deployment.html).
- FP4: [NVIDIA, pushing intelligence to 4-bit](https://research.nvidia.com/labs/eai/blogs/pushing-intelligence-to-4-bit/).
- Kubernetes: [Gateway API Inference Extension](https://github.com/kubernetes-sigs/gateway-api-inference-extension).
- Learning resources to cite in chapters: [Stanford CS336](https://cs336.stanford.edu/spring2025), [GPU performance engineering curriculum](https://www.beri.net/learning/gpu-perf-engineering-resources-curriculum), GPU MODE lectures, "How to Scale Your Model" (Google DeepMind), Simon Boehm's "How to optimize a CUDA matmul kernel", Horace He's "Making deep learning go brrrr", CMU 10-414/714 Deep Learning Systems, *Programming Massively Parallel Processors*.
