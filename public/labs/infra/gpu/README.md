# GPU labs: run these on a rented NVIDIA GPU

These scripts need an NVIDIA GPU and vLLM, so they are kept apart from the Mac labs one folder up. Nothing in this folder has been run for the handbook yet, so the chapters show the method and what to expect, not measured numbers.

## Setup

1. Rent one H100 80 GB (an A100 80 GB also works; change `BANDWIDTH` in each script).
2. Install vLLM in a fresh environment: `pip install vllm`.
3. Accept Meta's licence on Hugging Face for Llama models, or keep the `unsloth/` mirrors the scripts use.
4. Check the flags of your vLLM release with `vllm bench latency --help`. The scripts use `--batch-size`, `--input-len`, `--output-len`, `--num-iters-warmup`, `--num-iters`, `--max-model-len` and `--output-json`.

## Scripts

| Script | Chapter | Time on an H100 | What it measures |
|---|---|---|---|
| `decode_sweep.py` | 1.2 The arithmetic of inference, lab part B | about 15 minutes | Llama 3.1 8B decode step time and MBU at batch 1, 8, 32 and 64 |
| `moe_decode_sweep.py` | 1.3 Mixture-of-experts models, lab part C | about 20 minutes | Qwen3-30B-A3B against Llama 3.1 8B, measured and predicted step time at batch 1 to 16 |

## What to send back

For each script, keep three things: the printed table, the JSON file it writes (if any), and the output of `nvidia-smi` and `pip show vllm torch`. The GPU model, driver and vLLM version decide whether two sets of numbers can be compared.
