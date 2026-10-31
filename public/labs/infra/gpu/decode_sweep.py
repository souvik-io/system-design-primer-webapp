# decode_sweep.py: decode step time per batch size, from two vLLM latency runs per batch.
import json
import subprocess
import tempfile

MODEL = "unsloth/Meta-Llama-3.1-8B-Instruct"
PROMPT, STEPS = 2000, 256
WEIGHT_BYTES, KV_PER_TOKEN, BANDWIDTH = 15.0e9, 131_072, 3.35e12   # H100 SXM; use 300e9 on an L4


def avg_latency(batch: int, output_len: int) -> float:
    with tempfile.NamedTemporaryFile(suffix=".json") as f:
        subprocess.run(["vllm", "bench", "latency", "--model", MODEL, "--batch-size", str(batch),
                        "--input-len", str(PROMPT), "--output-len", str(output_len),
                        "--num-iters-warmup", "3", "--num-iters", "10",
                        "--max-model-len", "4096", "--output-json", f.name], check=True)
        return json.load(open(f.name))["avg_latency"]


for batch in (1, 8, 32, 64):
    step = (avg_latency(batch, STEPS + 1) - avg_latency(batch, 1)) / STEPS
    context = PROMPT + STEPS / 2                   # average context during the 256 steps
    bytes_per_step = WEIGHT_BYTES + batch * context * KV_PER_TOKEN
    mbu = bytes_per_step / step / BANDWIDTH
    print(f"batch {batch:3d}: step {step * 1e3:6.2f} ms, {1 / step:5.0f} tok/s per user, "
          f"{batch / step:6.0f} total, MBU {mbu:4.0%}")
