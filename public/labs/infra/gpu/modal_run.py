# modal_run.py: run any script in this folder on a rented GPU through Modal (https://modal.com).
#
#   pip install modal && modal setup            # once: install the client and sign in
#   modal run modal_run.py --script gpu_probe.py --gpu A10
#   modal run modal_run.py --script gpu_probe.py --gpu H100
#   modal run modal_run.py --script cuda_rmsnorm.py --gpu H100 --toolkit   # needs nvcc to compile CUDA
#   modal run modal_run.py --script decode_runtime.py --gpu H100 --cpu 4   # reserve 4 CPU cores
#
# A container is guaranteed only 0.125 CPU cores by default and borrows more when the host has spare capacity
# (https://modal.com/docs/guide/resources). Anything limited by kernel launches, such as a batch-1 decode step,
# then depends on how busy the host is; --cpu reserves cores for the run (a few tenths of a cent more per minute).
#
# The scripts themselves are plain Python and also run unchanged on any machine with an NVIDIA GPU:
#   python gpu_probe.py
#
# Modal bills per second while the container runs, not while a job waits for a free GPU. After each run
# this prints how long the script ran and an estimate of the GPU cost (container start-up is billed too), and appends both to modal_costs.jsonl next to
# this file, so you can keep a running total.
import json
import time
from pathlib import Path

import modal

HERE = Path(__file__).parent
# Dollars per GPU-second from https://modal.com/pricing (October 2026). CPU and memory add a little on top.
PRICE = {"T4": 0.000164, "L4": 0.000222, "A10": 0.000306, "A100-40GB": 0.000583, "A100-80GB": 0.000694,
         "L40S": 0.000542, "H100": 0.001097, "H200": 0.001261, "B200": 0.001736}

IGNORE = ["modal_costs.jsonl", "__pycache__"]
# The default image: PyTorch's Linux wheels bring the CUDA runtime and Triton, but no compiler. Transformers is
# there for the labs that load a model.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.15.0", "numpy", "transformers")
    .add_local_dir(HERE, "/labs", ignore=IGNORE)
)
# The toolkit image adds nvcc and compute-sanitizer, for labs that compile CUDA. Its CUDA version (13.2) matches
# the one the pinned PyTorch 2.15.0 wheels were built with; change both together.
toolkit = (
    modal.Image.from_registry("nvidia/cuda:13.2.1-devel-ubuntu24.04", add_python="3.12")
    .pip_install("torch==2.15.0", "numpy", "ninja")
    .add_local_dir(HERE, "/labs", ignore=IGNORE)
)
app = modal.App("inference-handbook-labs")


def _run(script: str, args: list[str]) -> float:
    import subprocess
    start = time.time()
    subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"], check=True)
    subprocess.run(["python", f"/labs/{script}", *args], check=True, cwd="/labs")
    return time.time() - start


@app.function(image=image, gpu="A10", timeout=30 * 60)
def run(script: str, args: list[str]) -> float:
    return _run(script, args)


@app.function(image=toolkit, gpu="A10", timeout=30 * 60)
def run_with_toolkit(script: str, args: list[str]) -> float:
    return _run(script, args)


@app.local_entrypoint()
def main(script: str, gpu: str = "A10", args: str = "", toolkit: bool = False, cpu: float = 0.0) -> None:
    fn = run_with_toolkit if toolkit else run
    options = {"gpu": gpu, **({"cpu": cpu} if cpu else {})}
    seconds = fn.with_options(**options).remote(script, args.split())
    price = PRICE.get(gpu.split(":")[0].rstrip("!"))
    cost = seconds * price if price else None
    estimate = f"about ${cost:.3f} (GPU only)" if cost is not None else "price unknown; add it to PRICE"
    print(f"\n[modal_run] {script} on {gpu}: {seconds:.0f} s of GPU time, {estimate}")
    with open(HERE / "modal_costs.jsonl", "a") as f:
        f.write(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "script": script, "gpu": gpu,
                            **({"cpu": cpu} if cpu else {}), "seconds": round(seconds, 1), "usd": round(cost, 4) if cost is not None else None}) + "\n")
