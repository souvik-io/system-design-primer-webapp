# moe_decode_sweep.py: measured decode step time of an MoE model and a dense model on one GPU, next to the
# roofline prediction from moe_arithmetic.py (chapter 1.3). Needs one 80 GB GPU (H100 or A100) and vLLM.
#
# It isolates decode the same way as decode_sweep.py (chapter 1.2): for each batch size it times a run that
# generates 1 token and a run that generates STEPS + 1 tokens from the same prompts; the difference divided
# by STEPS is one decode step without the prefill.
#
# Run: pip install vllm, then python moe_decode_sweep.py. It takes about 20 minutes on an H100, most of it
# loading the two models. Flags of `vllm bench latency` change between releases; check --help on yours.
import json
import subprocess
import tempfile

PROMPT, STEPS = 1000, 128
BANDWIDTH = 3.35e12                       # H100 SXM; use 2.039e12 for an A100 80 GB
BATCHES = (1, 2, 4, 8, 16)                # Qwen3-30B-A3B in BF16 leaves room for about 25 sequences here

# Bytes each step must read in BF16: the weights it touches plus the batch's KV cache.
MOE = {"model": "Qwen/Qwen3-30B-A3B", "always": 1.229e9, "expert": 48 * 3 * 2048 * 768,
       "experts": 128, "top_k": 8, "kv": 98_304}
DENSE = {"model": "unsloth/Meta-Llama-3.1-8B-Instruct", "weights": 7.50e9, "kv": 131_072}


def predicted_step(spec, batch):
    if "experts" in spec:   # experts touched per layer with even routing: E * (1 - (1 - k/E)^B)
        touched = spec["experts"] * (1 - (1 - spec["top_k"] / spec["experts"]) ** batch)
        params = spec["always"] + touched * spec["expert"]
    else:
        params = spec["weights"]
    context = PROMPT + STEPS / 2
    return (params * 2 + batch * context * spec["kv"]) / BANDWIDTH


def avg_latency(model, batch, output_len):
    with tempfile.NamedTemporaryFile(suffix=".json") as f:
        subprocess.run(["vllm", "bench", "latency", "--model", model, "--batch-size", str(batch),
                        "--input-len", str(PROMPT), "--output-len", str(output_len),
                        "--num-iters-warmup", "3", "--num-iters", "8", "--max-model-len", "2048",
                        "--output-json", f.name], check=True)
        return json.load(open(f.name))["avg_latency"]


rows = []
for spec in (MOE, DENSE):
    for batch in BATCHES:
        step = (avg_latency(spec["model"], batch, STEPS + 1) - avg_latency(spec["model"], batch, 1)) / STEPS
        rows.append((spec["model"], batch, step, predicted_step(spec, batch)))

print(f"{'model':38s} {'batch':>5} {'measured':>10} {'predicted':>10} {'ratio':>6} {'tok/s':>7}")
for model, batch, step, pred in rows:
    print(f"{model:38s} {batch:5d} {step * 1e3:7.2f} ms {pred * 1e3:7.2f} ms {step / pred:6.2f} {batch / step:7.0f}")
with open("moe_decode_sweep.json", "w") as f:
    json.dump([dict(zip(("model", "batch", "step_s", "predicted_s"), r)) for r in rows], f, indent=2)
print("Saved moe_decode_sweep.json")
