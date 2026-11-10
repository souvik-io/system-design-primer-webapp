# engine_bench.py: chapter 5.1's GPU lab. Tests nano_engine on the GPU (including vLLM's FlashAttention kernel
# against the PyTorch attention path), then runs the fixed throughput benchmark through nano_engine and through vLLM
# with and without CUDA graphs, and the chunked-prefill stall benchmark with and without chunking. Every run is a
# separate process, so each engine gets the whole GPU. Results go to engine_bench.json next to this file.
#
#   modal run modal_run.py --script engine_bench.py --gpu 'H100!' --vllm        # about 25 minutes, about $2
#   python gcp_run.py --script engine_bench.py --gpu A100-80GB --vllm
#   python engine_bench.py --quick       # on any NVIDIA GPU with vLLM installed: a 1B model, 64 requests
#
# The launchers put the nano_engine folder (one level up, ../nano_engine) next to this script.
import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "engine_bench.json"


def run(args: list[str]) -> dict | None:
    cmd = [sys.executable, "-m", "nano_engine.bench", *args]
    print("\n$", " ".join(cmd[1:]), flush=True)
    p = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
    lines = [l for l in p.stdout.splitlines() if l.startswith("{")]
    if p.returncode or not lines:
        print(p.stdout[-3000:], p.stderr[-3000:], sep="\n")
        return None
    result = json.loads(lines[-1])
    print(json.dumps(result), flush=True)
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="Llama 3.2 1B and 64 requests instead of 8B and 256")
    ap.add_argument("--only", default="nano,vllm-eager,vllm,stall", help="comma-separated parts to run")
    a = ap.parse_args()
    parts = a.only.split(",")
    import torch
    import vllm
    print(f"{torch.cuda.get_device_name()}, PyTorch {torch.__version__}, vLLM {vllm.__version__}", flush=True)

    tests = subprocess.run([sys.executable, "-m", "nano_engine.test_nano_engine"], cwd=HERE)
    if tests.returncode:
        raise SystemExit("nano_engine's tests failed on this GPU; not benchmarking")

    model = "unsloth/Llama-3.2-1B-Instruct" if a.quick else "unsloth/Meta-Llama-3.1-8B-Instruct"
    n = "64" if a.quick else "256"
    common = ["--model", model, "--num-seqs", n, "--min-len", "100", "--max-len", "1024", "--max-model-len", "4096",
              "--max-num-seqs", "256", "--max-num-batched-tokens", "8192"]
    results = []
    for part, extra in (("nano", ["--engine", "nano"]), ("vllm-eager", ["--engine", "vllm", "--eager"]),
                        ("vllm", ["--engine", "vllm"])):
        results.append(run(["throughput", *common, *extra]) if part in parts else None)
    stall = ["--model", model, "--max-model-len", "16384", "--decoders", "32", "--long-prompt", "8000"]
    for extra in (["--max-num-batched-tokens", "512"], ["--max-num-batched-tokens", "2048"], ["--no-chunking"]):
        if "stall" in parts:
            results.append(run(["stall", *stall, *extra]))
    OUT.write_text(json.dumps([r for r in results if r], indent=1) + "\n")

    nano, eager, graphs = results[:3]
    if nano and graphs:
        print(f"\nnano_engine: {nano['output_tok_s']:.0f} output tok/s; vLLM eager: "
              f"{eager['output_tok_s'] if eager else float('nan'):.0f}; vLLM with CUDA graphs: {graphs['output_tok_s']:.0f}. "
              f"vLLM is {graphs['output_tok_s'] / nano['output_tok_s']:.2f}x nano_engine (acceptance: under 3x).")


if __name__ == "__main__":
    main()
