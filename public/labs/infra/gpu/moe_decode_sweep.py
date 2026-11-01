# moe_decode_sweep.py: the measured decode step time of an MoE model and a dense model on one GPU, next to the
# roofline prediction from moe_arithmetic.py (chapter 1.3, lab part C).
#
# It isolates decode the same way as decode_sweep.py (chapter 1.2): for each batch size it times a run that
# generates 1 token and a run that generates STEPS + 1 tokens from the same prompts; the difference divided by
# STEPS is one decode step without the prefill. Each model is loaded once, in its own child process, because a
# vLLM engine does not reliably give its GPU memory back inside one process.
#
# Needs one 80 GB GPU (H100 or A100) and vLLM (written against v0.32.0). Qwen3-30B-A3B in BF16 is 61 GB, so it
# leaves room for only a modest KV cache. On Modal:
#   modal run modal_run.py --script moe_decode_sweep.py --gpu H100 --vllm
# Elsewhere: pip install vllm, then python moe_decode_sweep.py
import json
import subprocess
import sys
import time

PROMPT, STEPS = 1000, 128
BATCHES = [1, 2, 4, 8, 16]
SPEC_BW = (("H200", 4.8e12), ("H100", 3.35e12), ("A100", 2.0e12))

# Parameters each step must read, in BF16, plus the KV cache bytes per token.
MOE = {"model": "Qwen/Qwen3-30B-A3B", "always": 1.229e9, "expert": 48 * 3 * 2048 * 768,
       "experts": 128, "top_k": 8, "kv": 98_304}
DENSE = {"model": "unsloth/Meta-Llama-3.1-8B-Instruct", "weights": 7.50e9, "kv": 131_072}


def predicted_step(spec, batch, bandwidth):
    if "experts" in spec:   # experts touched per layer with even routing: E * (1 - (1 - k/E)^B)
        touched = spec["experts"] * (1 - (1 - spec["top_k"] / spec["experts"]) ** batch)
        params = spec["always"] + touched * spec["expert"]
    else:
        params = spec["weights"]
    context = PROMPT + STEPS / 2
    return (params * 2 + batch * context * spec["kv"]) / bandwidth


def measure(model: str) -> None:
    import numpy as np
    import torch
    import vllm
    from vllm import LLM, SamplingParams
    from vllm.inputs import TokensPrompt

    t0 = time.perf_counter()
    llm = LLM(model=model, max_model_len=2048, enable_prefix_caching=False)
    load_s = time.perf_counter() - t0

    def run_seconds(prompts, output_len, warmup=3, iters=8):
        params = SamplingParams(temperature=1.0, top_p=1.0, ignore_eos=True, max_tokens=output_len)
        for _ in range(warmup):
            llm.generate(prompts, sampling_params=params, use_tqdm=False)
        times = []
        for _ in range(iters):
            start = time.perf_counter()
            llm.generate(prompts, sampling_params=params, use_tqdm=False)
            times.append(time.perf_counter() - start)
        return float(np.median(times))

    rows = []
    for batch in BATCHES:
        ids = np.random.default_rng(batch).integers(0, 10_000, (batch, PROMPT)).tolist()
        prompts = [TokensPrompt(prompt_token_ids=p) for p in ids]
        rows.append({"batch": batch, "step_s": (run_seconds(prompts, STEPS + 1) - run_seconds(prompts, 1)) / STEPS})
    print("RESULT " + json.dumps({"model": model, "load_s": load_s, "rows": rows, "vllm": vllm.__version__,
                                  "torch": torch.__version__, "gpu": torch.cuda.get_device_name()}), flush=True)


if len(sys.argv) > 2 and sys.argv[1] == "--child":
    measure(sys.argv[2])
    sys.exit()

results = {}
for spec in (MOE, DENSE):
    child = subprocess.run([sys.executable, __file__, "--child", spec["model"]], stdout=subprocess.PIPE, text=True)
    if child.returncode:                       # vLLM's log goes to stdout; show its end if the run failed
        sys.exit(child.stdout[-5000:])
    for line in child.stdout.splitlines():     # a few of vLLM's own start-up lines: load, compile, KV cache size
        if any(k in line for k in ("Loading weights took", "torch.compile took", "Graph capturing finished",
                                   "Available KV cache memory", "GPU KV cache size")):
            print(f"[{spec['model'].split('/')[1]}] {line.split('] ', 1)[-1]}")
    results[spec["model"]] = json.loads(next(l for l in child.stdout.splitlines() if l.startswith("RESULT "))[7:])

info = next(iter(results.values()))
bandwidth = next((b for k, b in SPEC_BW if k in info["gpu"]), 3.35e12)
print(f"{info['gpu']}, vLLM {info['vllm']}, PyTorch {info['torch']}; prediction at {bandwidth / 1e12:.2f} TB/s")
print(f"BF16, {PROMPT}-token prompts, {STEPS} decode steps timed (median of 8 runs)\n")
print(f"{'model':36s} {'batch':>5} {'measured':>10} {'predicted':>10} {'ratio':>6} {'tok/s':>7}")
rows = []
for spec in (MOE, DENSE):
    for row in results[spec["model"]]["rows"]:
        batch, step = row["batch"], row["step_s"]
        pred = predicted_step(spec, batch, bandwidth)
        rows.append({"model": spec["model"], "batch": batch, "step_s": step, "predicted_s": pred})
        print(f"{spec['model']:36s} {batch:5d} {step * 1e3:7.2f} ms {pred * 1e3:7.2f} ms {step / pred:6.2f} "
              f"{batch / step:7.0f}")
print("\nLoad time, including torch.compile and CUDA graph capture: "
      + ", ".join(f"{m} {r['load_s']:.0f} s" for m, r in results.items()))
with open("moe_decode_sweep.json", "w") as f:
    json.dump(rows, f, indent=2)
