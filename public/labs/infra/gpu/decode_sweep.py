# decode_sweep.py: the decode step time of Llama 3.1 8B in vLLM at batch 1 to 64, next to the step time that the
# bandwidth model of chapter 1.2 predicts (lab part B).
#
# For each batch it times a run that generates 1 token and a run that generates STEPS + 1 tokens from the same
# prompts. The difference divided by STEPS is one decode step without the prefill. `vllm bench latency` measures
# the same two runs, but it loads the model again for every run; this script loads it once and calls the same
# LLM.generate with the same settings (random prompt tokens, ignore_eos, temperature 1.0).
#
# It then repeats batches 1 and 8 with enforce_eager=True, which turns off CUDA graphs and torch.compile, to show
# what they save. Each configuration runs in its own child process, because a vLLM engine does not reliably give
# its GPU memory back inside one process.
#
# Needs one 80 GB GPU and vLLM (written against v0.32.0). On Modal:
#   modal run modal_run.py --script decode_sweep.py --gpu H100 --vllm
# Elsewhere: pip install vllm, then python decode_sweep.py
import json
import subprocess
import sys
import time

MODEL = "unsloth/Meta-Llama-3.1-8B-Instruct"     # an ungated copy of Meta's weights
PROMPT, STEPS = 2000, 256
WEIGHT_BYTES = 15.0e9      # BF16 weights read per step: 8.03B parameters less the embedding table, of which a step
#                            reads only one row per sequence
KV_PER_TOKEN = 131_072     # 32 layers x 2 (K and V) x 8 KV heads x 128 dims x 2 bytes
SPEC_BW = (("H200", 4.8e12), ("H100", 3.35e12), ("A100", 2.0e12), ("L40S", 864e9), ("A10", 600e9), ("L4", 300e9))


def measure(eager: bool, batches: list[int]) -> None:
    import numpy as np
    import torch
    import vllm
    from vllm import LLM, SamplingParams
    from vllm.inputs import TokensPrompt

    t0 = time.perf_counter()
    llm = LLM(model=MODEL, max_model_len=4096, enforce_eager=eager, enable_prefix_caching=False)
    load_s = time.perf_counter() - t0

    def run_seconds(prompts, output_len, warmup=3, iters=10):
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
    for batch in batches:
        ids = np.random.default_rng(batch).integers(0, 10_000, (batch, PROMPT)).tolist()
        prompts = [TokensPrompt(prompt_token_ids=p) for p in ids]
        step = (run_seconds(prompts, STEPS + 1) - run_seconds(prompts, 1)) / STEPS
        rows.append({"batch": batch, "step_s": step})
    print("RESULT " + json.dumps({"eager": eager, "load_s": load_s, "rows": rows, "vllm": vllm.__version__,
                                  "torch": torch.__version__, "gpu": torch.cuda.get_device_name()}), flush=True)


if len(sys.argv) > 2 and sys.argv[1] == "--child":
    config = json.loads(sys.argv[2])
    measure(config["eager"], config["batches"])
    sys.exit()

results = []
for eager, batches in ((False, [1, 8, 32, 64]), (True, [1, 8])):
    child = subprocess.run([sys.executable, __file__, "--child", json.dumps({"eager": eager, "batches": batches})],
                           stdout=subprocess.PIPE, text=True)  # vLLM's log goes to stdout; keep it for errors
    if child.returncode:
        sys.exit(child.stdout[-5000:])
    results.append(json.loads(next(line for line in child.stdout.splitlines() if line.startswith("RESULT "))[7:]))

info = results[0]
bandwidth = next((b for k, b in SPEC_BW if k in info["gpu"]), None)
print(f"{info['gpu']}, vLLM {info['vllm']}, PyTorch {info['torch']}")
print(f"{MODEL}, BF16, {PROMPT}-token prompts, {STEPS} decode steps timed (median of 10 runs)")
print(f"Model loaded and ready in {info['load_s']:.0f} s with CUDA graphs and torch.compile, "
      f"{results[1]['load_s']:.0f} s with enforce_eager\n")
print(f"{'':16}{'batch':>6}{'step':>10}{'model':>10}{'MBU':>6}{'tok/s per user':>16}{'tok/s total':>13}")
for r in results:
    label = "enforce_eager" if r["eager"] else "default"
    for row in r["rows"]:
        batch, step = row["batch"], row["step_s"]
        context = PROMPT + STEPS / 2                       # average context length during the timed steps
        step_bytes = WEIGHT_BYTES + batch * context * KV_PER_TOKEN
        model = f"{step_bytes / bandwidth * 1e3:7.2f} ms" if bandwidth else "      ?"
        mbu = f"{step_bytes / step / bandwidth:5.0%}" if bandwidth else "    ?"
        print(f"{label:16}{batch:6d}{step * 1e3:7.2f} ms{model:>10}{mbu:>6}{1 / step:16.0f}{batch / step:13.0f}")
with open("decode_sweep.json", "w") as f:
    json.dump(results, f, indent=2)
