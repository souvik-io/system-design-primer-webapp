# modal_run.py: run any script in this folder on a rented GPU through Modal (https://modal.com).
#
#   pip install modal && modal setup            # once: install the client and sign in
#   modal run modal_run.py --script gpu_probe.py --gpu A10
#   modal run modal_run.py --script gpu_probe.py --gpu 'H100!'
#   modal run modal_run.py --script cuda_rmsnorm.py --gpu 'H100!' --toolkit   # needs nvcc to compile CUDA
#   modal run modal_run.py --script decode_runtime.py --gpu 'H100!' --cpu 4   # reserve 4 CPU cores
#   modal run modal_run.py --script decode_sweep.py --gpu 'H100!' --vllm   # the image with vLLM installed
#   modal run modal_run.py --script quantize_and_eval.py --gpu L4 --quant  # vLLM plus llm-compressor
#   modal run modal_run.py --script prefix_cache_bench.py --gpu 'H100!' --sglang   # the image with SGLang installed
#
# gcp_run.py runs the same scripts on a Google Cloud VM with the same options, and both build their containers
# from the Dockerfiles in images/, so a run on either platform uses the same software.
#
# A container is guaranteed only 0.125 CPU cores by default and borrows more when the host has spare capacity
# (https://modal.com/docs/guide/resources). Anything limited by kernel launches, such as a batch-1 decode step,
# then depends on how busy the host is; --cpu reserves cores for the run (a few tenths of a cent more per minute).
#
# The scripts themselves are plain Python and also run unchanged on any machine with an NVIDIA GPU:
#   python gpu_probe.py
#
# Modal bills per second while the container runs, not while a job waits for a free GPU. After each run
# this prints how long the script ran and an estimate of the GPU cost (container start-up is billed too), and
# appends both to modal_costs.jsonl next to this file, so you can keep a running total. Before each run,
# budget.py checks that the run's worst case (its time limit at the GPU's price) fits in what is left of this
# month's allowance (modal_monthly_cap_usd in credits.json, $25 by default) and stops it if not.
import json
import os
import shlex
import time
from pathlib import Path

# Modal's image builder 2024.10 and older installs its own pinned packages into the image with --no-deps, which
# replaces the newer typing_extensions PyTorch 2.15 needs ("cannot import name 'Format'"). From 2025.06 Modal
# supplies its packages when the container starts instead, so the image keeps exactly what the Dockerfile installed.
# Workspaces created before mid-2025 still default to the old builder, so this file asks for the newer one.
os.environ.setdefault("MODAL_IMAGE_BUILDER_VERSION", "2025.06")

import modal  # noqa: E402  (must come after the environment variable above)

HERE = Path(__file__).parent
# Dollars per GPU-second from https://modal.com/pricing (October 2026). CPU and memory add a little on top.
PRICE = {"T4": 0.000164, "L4": 0.000222, "A10": 0.000306, "A100-40GB": 0.000583, "A100-80GB": 0.000694,
         "L40S": 0.000542, "H100": 0.001097, "H200": 0.001261, "B200": 0.001736}
TIMEOUT = {"run": 30 * 60, "run_with_toolkit": 30 * 60, "run_with_vllm": 60 * 60, "run_with_quant": 3 * 60 * 60,
           "run_with_sglang": 60 * 60}      # seconds, per function

IGNORE = ["modal_costs.jsonl", "gcp_costs.jsonl", "credits.json", "runs", "images", "__pycache__"]
# The five images, built from images/*.Dockerfile; each file says what it holds and why.
# Each image also gets ../nano_engine, the engine chapter 5.1 builds, as /labs/nano_engine.
image, toolkit, vllm_image, quant_image, sglang_image = (
    modal.Image.from_dockerfile(HERE / "images" / f"{name}.Dockerfile").add_local_dir(HERE, "/labs", ignore=IGNORE)
    .add_local_dir(HERE.parent / "nano_engine", "/labs/nano_engine", ignore=["__pycache__"])
    for name in ("base", "toolkit", "vllm", "quant", "sglang")
)
app = modal.App("inference-handbook-labs")


def _run(script: str, args: list[str]) -> tuple[float, int, dict[str, bytes]]:
    """Run a script and return its run time, its exit code, and the small files it wrote next to itself (such as
    quant_results.json), which main() copies back into this folder. Files are returned even when the script fails,
    so the versions that finished before a failure are kept."""
    import subprocess
    start = time.time()
    subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"], check=True)
    code = subprocess.run(["python", "-u", f"/labs/{script}", *args], cwd="/labs").returncode   # -u: stream output
    written = {f.name: f.read_bytes() for f in Path("/labs").iterdir()
               if f.is_file() and f.stat().st_mtime > start and f.stat().st_size < 50_000_000}
    return time.time() - start, code, written


@app.function(image=image, gpu="A10", timeout=TIMEOUT["run"])
def run(script: str, args: list[str]) -> tuple[float, int, dict[str, bytes]]:
    return _run(script, args)


@app.function(image=toolkit, gpu="A10", timeout=TIMEOUT["run_with_toolkit"])
def run_with_toolkit(script: str, args: list[str]) -> tuple[float, int, dict[str, bytes]]:
    return _run(script, args)


# The vLLM function reserves 4 CPU cores and 32 GiB of memory, because vLLM's scheduler runs on the CPU and
# loading a model's weights goes through host memory.
@app.function(image=vllm_image, gpu="H100", cpu=4.0, memory=32 * 1024, timeout=TIMEOUT["run_with_vllm"])
def run_with_vllm(script: str, args: list[str]) -> tuple[float, int, dict[str, bytes]]:
    return _run(script, args)


# The quantization function holds a whole BF16 model in host memory while llm-compressor quantizes it layer by
# layer on the GPU, so it reserves 8 CPU cores and 64 GiB.
@app.function(image=quant_image, gpu="L4", cpu=8.0, memory=64 * 1024, timeout=TIMEOUT["run_with_quant"])
def run_with_quant(script: str, args: list[str]) -> tuple[float, int, dict[str, bytes]]:
    return _run(script, args)


# SGLang gets the same resources as vLLM, so the two engines are compared on equal terms.
@app.function(image=sglang_image, gpu="H100", cpu=4.0, memory=32 * 1024, timeout=TIMEOUT["run_with_sglang"])
def run_with_sglang(script: str, args: list[str]) -> tuple[float, int, dict[str, bytes]]:
    return _run(script, args)


@app.local_entrypoint()
def main(script: str, gpu: str = "A10", args: str = "", toolkit: bool = False, vllm: bool = False, quant: bool = False,
         sglang: bool = False, cpu: float = 0.0, allow_over_budget: bool = False) -> None:
    import sys
    sys.path.insert(0, str(HERE))
    import budget          # imported here so that only the local side needs it

    name = "run_with_sglang" if sglang else "run_with_quant" if quant else "run_with_vllm" if vllm else "run_with_toolkit" if toolkit else "run"
    fn = {"run": run, "run_with_toolkit": run_with_toolkit, "run_with_vllm": run_with_vllm,
          "run_with_quant": run_with_quant, "run_with_sglang": run_with_sglang}[name]
    price = PRICE.get(gpu.split(":")[0].rstrip("!"))
    count = int(gpu.split(":")[1]) if ":" in gpu else 1
    worst = TIMEOUT[name] * price * count if price else 0.0
    budget.check("modal", worst, allow_over_budget)

    options = {"gpu": gpu, **({"cpu": cpu} if cpu else {})}
    seconds, code, written = fn.with_options(**options).remote(script, shlex.split(args))   # quotes group words
    for name, data in written.items():
        (HERE / name).write_bytes(data)
        print(f"[modal_run] copied back {name}")
    cost = seconds * price * count if price else None
    estimate = f"about ${cost:.3f} (GPU only)" if cost is not None else "price unknown; add it to PRICE"
    print(f"\n[modal_run] {script} on {gpu}: {seconds:.0f} s of GPU time, {estimate}")
    with open(HERE / "modal_costs.jsonl", "a") as f:
        f.write(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "script": script, "gpu": gpu,
                            **({"cpu": cpu} if cpu else {}), "seconds": round(seconds, 1), "usd": round(cost, 4) if cost is not None else None}) + "\n")
    if code:
        raise SystemExit(f"[modal_run] {script} exited with code {code}")
