# gcp_run.py: run any script in this folder on a Google Cloud GPU VM, the way modal_run.py runs it on Modal.
#
#   python gcp_run.py --script gpu_probe.py --gpu L4
#   python gcp_run.py --script cuda_rmsnorm.py --gpu L4 --toolkit       # nvcc, compute-sanitizer, Nsight
#   python gcp_run.py --script decode_sweep.py --gpu L4 --vllm          # the image with vLLM installed
#   python gcp_run.py --script decode_sweep.py --gpu L4 --vllm --args "--quick"
#   python gcp_run.py --script quantize_and_eval.py --gpu L4 --quant --max-hours 5
#   python gcp_run.py --gpu L4 --keep --max-hours 3                     # a VM to SSH into and work on
#   python gcp_run.py --list                                            # VMs this script started
#   python gcp_run.py --cleanup                                         # delete them all
#
# What one run does:
#   1. Checks the ledger in budget.py: the run's worst case (its time limit at the VM's hourly price) must fit in
#      the Google Cloud credit you have left, or the run does not start.
#   2. Creates a Spot VM with one GPU from Google's Deep Learning VM image, which comes with the NVIDIA driver.
#      If a zone has no free GPUs it tries the next one. The VM is created with a time limit (--max-hours, one
#      hour by default) after which Google deletes it, so a VM cannot keep billing if this script or your laptop
#      dies halfway.
#   3. Copies this folder to the VM, builds the container from images/<name>.Dockerfile (the same file Modal
#      builds from), and runs the script inside it with the GPU attached. Output streams to your terminal.
#   4. Copies back the printed output and any file the script wrote into runs/<script>-<gpu>-<time>/, then
#      deletes the VM, even when the script failed or you pressed Ctrl-C.
#   5. Appends the VM's lifetime and estimated cost to gcp_costs.jsonl, which budget.py reads.
#
# Spot VMs cost about 40% of the normal price, but Google can reclaim one at any moment; the script then says so
# and you run it again. Pass --on-demand to pay the normal price for a VM that is not reclaimed.
#
# Setup, once: install the Google Cloud CLI, `gcloud auth login`, pick a project with billing and GPU quota
# (put it in credits.json as "gcp_project", or pass --project), and request quota for GPUS_ALL_REGIONS and the
# GPU type in us-central1 (IAM & Admin > Quotas). New projects start with no GPU quota.
import argparse
import json
import os
import shlex
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

import budget

HERE = Path(__file__).parent
COSTS = HERE / "gcp_costs.jsonl"
LABEL = "handbook-lab"
REGION = "us-central1"
IMAGE_FAMILY, IMAGE_PROJECT = "common-cu129-ubuntu-2404-nvidia-580", "deeplearning-platform-release"

# One machine type per GPU, with the zones in REGION that have that GPU and the hourly price of the whole
# machine (GPU, vCPUs and memory) in US dollars. Prices are for us-central1 from Google's Cloud Billing Catalog
# on 2026-11-08; Spot prices can change up to once a month. g2-standard-8 (8 vCPUs, 32 GB) rather than the
# smaller g2-standard-4, because vLLM loads weights through host memory.
MACHINES = {
    "L4":        {"type": "g2-standard-8",  "zones": ["a", "b", "c"],      "spot": 0.5112, "on-demand": 0.8537},
    "L4:2":      {"type": "g2-standard-24", "zones": ["a", "b", "c"],      "spot": 1.1972, "on-demand": 2.0011},
    "A100":      {"type": "a2-highgpu-1g",  "zones": ["a", "b", "c", "f"], "spot": 1.9888, "on-demand": 3.6736},
    "A100-80GB": {"type": "a2-ultragpu-1g", "zones": ["a", "c"],           "spot": 2.9515, "on-demand": 5.0282},
}
DISK_GB = 200                                  # room for the CUDA images, the vLLM image and model weights
DISK_PER_HOUR = DISK_GB * 0.10 / 730           # Balanced persistent disk, $0.10 per GB-month
NO_CAPACITY = ("ZONE_RESOURCE_POOL_EXHAUSTED", "does not have enough resources", "resource pool exhausted", "STOCKOUT")
SKIP = {"modal_costs.jsonl", "gcp_costs.jsonl", "credits.json", "runs", "__pycache__"}

# Run on the VM before the first build: wait for the driver, and make sure Docker can hand the GPU to a container.
SETUP = r"""
set -e
for i in $(seq 1 60); do nvidia-smi -L >/dev/null 2>&1 && break; sleep 5; done
nvidia-smi -L
APT="sudo apt-get -o DPkg::Lock::Timeout=600 -qq"
if ! command -v docker >/dev/null; then $APT update && $APT install -y docker.io >/dev/null; fi
if ! command -v nvidia-ctk >/dev/null; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
  $APT update && $APT install -y nvidia-container-toolkit >/dev/null
fi
if ! sudo docker info 2>/dev/null | grep -qi 'runtimes:.*nvidia'; then
  sudo nvidia-ctk runtime configure --runtime=docker >/dev/null && sudo systemctl restart docker
fi
echo "docker $(sudo docker version --format '{{.Server.Version}}'), $(nvidia-ctk --version | head -1)"
"""


def gcloud(*args: str, project: str, capture: bool = True, check: bool = True) -> subprocess.CompletedProcess:
    cmd = ["gcloud", *args, f"--project={project}"]
    return subprocess.run(cmd, capture_output=capture, text=True, check=check)


def ssh(vm: dict, command: str, project: str, log=None, check: bool = True) -> int:
    """Run a command on the VM, streaming its output (and copying it to log, if given)."""
    cmd = ["gcloud", "compute", "ssh", vm["name"], f"--zone={vm['zone']}", f"--project={project}", "--quiet",
           "--strict-host-key-checking=no", f"--command={command}", "--", "-o", "ServerAliveInterval=30"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in proc.stdout:
        sys.stdout.write(line)
        if log:
            log.write(line)
    code = proc.wait()
    if check and code != 0:
        raise RuntimeError(f"command on the VM failed with exit code {code}")
    return code


def run_detached(vm: dict, command: str, project: str, log) -> int:
    """Start a long command on the VM in the background and follow its output by polling, so that a dropped SSH
    connection (a laptop going to sleep, a flaky network) does not kill a run that takes hours. Returns the
    command's exit code."""
    start = (f"rm -f ~/run.log ~/run.exit; nohup bash -c {shlex.quote(command + '; echo $? > ~/run.exit')} "
             "> ~/run.log 2>&1 < /dev/null &")
    ssh(vm, start, project)
    offset, failures = 0, 0
    while True:
        time.sleep(20)
        cmd = ["gcloud", "compute", "ssh", vm["name"], f"--zone={vm['zone']}", f"--project={project}", "--quiet",
               "--strict-host-key-checking=no",
               # The exit file is read before the log: if it exists, the log is already complete.
               f"--command=E=$(cat ~/run.exit 2>/dev/null); tail -c +{offset + 1} ~/run.log; printf '\\n__EXIT__%s' \"$E\"",
               "--",
               "-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=30"]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0 or b"__EXIT__" not in r.stdout:
            failures += 1
            if failures >= 30:                    # about 10 minutes without a connection
                raise RuntimeError("lost contact with the VM")
            continue
        failures = 0
        body, _, code = r.stdout.rpartition(b"\n__EXIT__")
        if body:
            text = body.decode(errors="replace")
            sys.stdout.write(text)
            sys.stdout.flush()
            log.write(text)
            log.flush()
            offset += len(body)
        if code.strip():
            return int(code.strip())


def create_vm(name: str, gpu: str, spot: bool, max_hours: float, project: str) -> dict:
    m = MACHINES[gpu]
    for z in m["zones"]:
        zone = f"{REGION}-{z}"
        print(f"[gcp_run] creating {name} ({m['type']}, {'Spot' if spot else 'on-demand'}) in {zone}")
        r = gcloud("compute", "instances", "create", name, f"--zone={zone}", f"--machine-type={m['type']}",
                   f"--provisioning-model={'SPOT' if spot else 'STANDARD'}", "--instance-termination-action=DELETE",
                   f"--max-run-duration={int(max_hours * 3600)}s", "--maintenance-policy=TERMINATE",
                   f"--image-family={IMAGE_FAMILY}", f"--image-project={IMAGE_PROJECT}",
                   f"--boot-disk-size={DISK_GB}GB", "--boot-disk-type=pd-balanced",
                   # Keep SSH keys on this VM rather than in the project's shared metadata.
                   "--metadata=install-nvidia-driver=True,block-project-ssh-keys=TRUE",
                   f"--labels={LABEL}=1", project=project, check=False)
        if r.returncode == 0:
            return {"name": name, "zone": zone}
        if any(s in r.stderr for s in NO_CAPACITY):
            print(f"[gcp_run] no free {gpu} in {zone}; trying the next zone")
            continue
        raise SystemExit(f"[gcp_run] could not create the VM:\n{r.stderr.strip()}")
    raise SystemExit(f"[gcp_run] no zone in {REGION} had a free {gpu}. Try again later, try --on-demand, or use modal_run.py.")


def delete_vm(vm: dict, project: str) -> None:
    print(f"[gcp_run] deleting {vm['name']}")
    gcloud("compute", "instances", "delete", vm["name"], f"--zone={vm['zone']}", "--quiet", project=project, check=False)


def wait_for_ssh(vm: dict, project: str) -> None:
    for _ in range(40):                               # the first boot takes a minute or two
        r = subprocess.run(["gcloud", "compute", "ssh", vm["name"], f"--zone={vm['zone']}", f"--project={project}",
                            "--quiet", "--strict-host-key-checking=no", "--command=true"], capture_output=True, text=True)
        if r.returncode == 0:
            return
        time.sleep(10)
    raise RuntimeError("the VM did not accept SSH within about seven minutes")


def upload(vm: dict, project: str, workdir: Path) -> None:
    bundle = workdir / "labs.tgz"
    with tarfile.open(bundle, "w:gz") as tar:
        for p in HERE.iterdir():
            if p.name not in SKIP:
                tar.add(p, arcname=p.name)
        # The engine chapter 5.1 builds lives one folder up; the GPU labs import it from here.
        tar.add(HERE.parent / "nano_engine", arcname="nano_engine", filter=lambda t: None if "__pycache__" in t.name else t)
    gcloud("compute", "scp", str(bundle), f"{vm['name']}:labs.tgz", f"--zone={vm['zone']}", "--quiet",
           "--strict-host-key-checking=no", project=project)
    bundle.unlink()
    ssh(vm, "rm -rf ~/labs && mkdir -p ~/labs && tar xzf ~/labs.tgz -C ~/labs && rm ~/labs.tgz", project)


def fetch_outputs(vm: dict, project: str, workdir: Path) -> list[str]:
    """Copy back every file the run created or changed in the lab folder."""
    code = ssh(vm, "cd ~/labs && sudo find . -newer .start -type f ! -path './__pycache__/*' ! -name '*.pyc' "
                   "| sed 's#^./##' > /tmp/new.txt; test -s /tmp/new.txt && sudo tar czf /tmp/out.tgz -T /tmp/new.txt "
                   "&& sudo chmod 644 /tmp/out.tgz", project, check=False)
    if code != 0:
        return []
    gcloud("compute", "scp", f"{vm['name']}:/tmp/out.tgz", str(workdir / "out.tgz"), f"--zone={vm['zone']}", "--quiet",
           "--strict-host-key-checking=no", project=project)
    with tarfile.open(workdir / "out.tgz") as tar:
        names = tar.getnames()
        tar.extractall(workdir, filter="data")
    (workdir / "out.tgz").unlink()
    return names


def vm_exists(vm: dict, project: str) -> bool:
    r = gcloud("compute", "instances", "describe", vm["name"], f"--zone={vm['zone']}", "--format=value(status)",
               project=project, check=False)
    return r.returncode == 0 and r.stdout.strip() not in ("", "TERMINATED")


def hourly(gpu: str, spot: bool) -> float:
    return MACHINES[gpu]["spot" if spot else "on-demand"] + DISK_PER_HOUR


def log_cost(entry: dict) -> None:
    with open(COSTS, "a") as f:
        f.write(json.dumps(entry) + "\n")


def settle(name: str, seconds: float) -> None:
    """Replace a kept VM's worst-case entry in the cost log with what its lifetime actually cost."""
    if not COSTS.exists():
        return
    rows = [json.loads(line) for line in COSTS.read_text().splitlines() if line.strip()]
    for r in rows:
        if r.get("vm") == name and r.get("reserved"):
            r["usd"] = round(seconds / 3600 * r["usd_per_hour"], 4)
            r["seconds"] = round(seconds)
            r.pop("reserved")
    COSTS.write_text("".join(json.dumps(r) + "\n" for r in rows))


def labelled_vms(project: str) -> list[dict]:
    r = gcloud("compute", "instances", "list", f"--filter=labels.{LABEL}=1",
               "--format=json(name,zone.basename(),status,creationTimestamp)", project=project)
    return json.loads(r.stdout or "[]")


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)       # show progress as it happens, even when piped to a file
    ap = argparse.ArgumentParser(description="Run a lab script on a Google Cloud GPU VM.")
    ap.add_argument("--script", help="script in this folder to run")
    ap.add_argument("--args", default="", help="arguments for the script, as one string")
    ap.add_argument("--gpu", default="L4", choices=MACHINES)
    ap.add_argument("--toolkit", action="store_true", help="use images/toolkit.Dockerfile (nvcc, Nsight)")
    ap.add_argument("--vllm", action="store_true", help="use images/vllm.Dockerfile")
    ap.add_argument("--quant", action="store_true", help="use images/quant.Dockerfile (vLLM and llm-compressor)")
    ap.add_argument("--sglang", action="store_true", help="use images/sglang.Dockerfile")
    ap.add_argument("--on-demand", action="store_true", help="normal price instead of Spot; cannot be reclaimed")
    ap.add_argument("--max-hours", type=float, default=1.0, help="Google deletes the VM after this long (default 1)")
    ap.add_argument("--keep", action="store_true", help="leave the VM running for SSH until --max-hours or --cleanup")
    ap.add_argument("--project", help="Google Cloud project (default: gcp_project in credits.json, then gcloud's)")
    ap.add_argument("--list", action="store_true", help="list VMs started by this script")
    ap.add_argument("--cleanup", action="store_true", help="delete every VM started by this script")
    ap.add_argument("--allow-over-budget", action="store_true")
    a = ap.parse_args()

    project = a.project or budget.load_credits().get("gcp_project") or \
        subprocess.run(["gcloud", "config", "get-value", "project"], capture_output=True, text=True).stdout.strip()
    if not project:
        raise SystemExit("[gcp_run] no project: pass --project or set gcp_project in credits.json")

    if a.list or a.cleanup:
        vms = labelled_vms(project)
        for v in vms:
            print(f"{v['name']:45} {v['zone']:16} {v['status']:12} created {v['creationTimestamp']}")
        if not vms:
            print(f"[gcp_run] no VMs labelled {LABEL} in {project}")
        if a.cleanup:
            for v in vms:
                created = datetime.fromisoformat(v["creationTimestamp"])
                delete_vm({"name": v["name"], "zone": v["zone"]}, project)
                settle(v["name"], (datetime.now(timezone.utc) - created).total_seconds())
        return
    if not a.script and not a.keep:
        ap.error("--script is required unless you pass --keep")
    if a.script and not (HERE / a.script).exists():
        ap.error(f"{a.script} is not in {HERE}")

    spot = not a.on_demand
    rate = hourly(a.gpu, spot)
    budget.check("gcp", rate * a.max_hours, a.allow_over_budget)

    kind = "sglang" if a.sglang else "quant" if a.quant else "vllm" if a.vllm else "toolkit" if a.toolkit else "base"
    stem = Path(a.script).stem if a.script else "session"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"lab-{stem}-{a.gpu}-{stamp}".lower().replace("_", "-").replace(":", "x")[:63]
    workdir = HERE / "runs" / f"{stem}-{a.gpu.replace(':', 'x')}-{stamp}"
    workdir.mkdir(parents=True)
    entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "script": a.script, "gpu": a.gpu, "machine": MACHINES[a.gpu]["type"],
             "project": project, "provisioning": "spot" if spot else "on-demand", "image": kind, "vm": name, "usd_per_hour": round(rate, 4)}

    started = time.time()
    vm = create_vm(name, a.gpu, spot, a.max_hours, project)
    entry["zone"] = vm["zone"]
    code, script_seconds = None, None
    try:
        with open(workdir / "output.log", "w") as log:
            wait_for_ssh(vm, project)
            ssh(vm, SETUP, project, log)
            upload(vm, project, workdir)
            t = time.time()
            ssh(vm, f"cd ~/labs && touch .start && sudo docker build -q -t lab-{kind} -f images/{kind}.Dockerfile images", project, log)
            print(f"[gcp_run] built lab-{kind} in {time.time() - t:.0f} s")
            if a.keep:
                print(f"\n[gcp_run] VM ready. Google deletes it after {a.max_hours} h; delete it sooner with --cleanup.")
                print(f"  gcloud compute ssh {name} --zone={vm['zone']} --project={project}")
                print(f"  then: cd ~/labs && sudo docker run --rm -it --gpus all --ipc=host -v ~/labs:/labs lab-{kind} bash")
                entry.update(usd=round(rate * a.max_hours, 4), reserved=True)    # worst case until --cleanup settles it
                log_cost(entry)
                return
            env = f"-e HF_TOKEN={shlex.quote(os.environ['HF_TOKEN'])} " if os.environ.get("HF_TOKEN") else ""
            inner = ("nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader && "
                     f"python -u {shlex.quote(a.script)} {a.args}")
            t = time.time()
            # Detached and polled, so the run survives a dropped SSH connection.
            code = run_detached(vm, f"cd ~/labs && sudo docker run --rm --gpus all --ipc=host -v ~/labs:/labs "
                                    f"-v ~/hf-cache:/root/.cache/huggingface -w /labs {env}lab-{kind} "
                                    f"bash -c {shlex.quote(inner)}", project, log)
            script_seconds = time.time() - t
        files = fetch_outputs(vm, project, workdir)
        if files:
            print(f"[gcp_run] copied back: {', '.join(files)}")
    except (RuntimeError, subprocess.CalledProcessError) as e:
        code = code or 1
        if not vm_exists(vm, project):
            print("[gcp_run] the VM is gone: Google reclaimed the Spot VM or it hit its time limit. Run again, or add --on-demand.")
        else:
            print(f"[gcp_run] {e}")
    except KeyboardInterrupt:
        code = 130
        print("\n[gcp_run] interrupted")
    finally:
        # Delete the VM and log what it cost, whatever happened above; only a kept, ready VM is left running.
        if not entry.get("reserved"):
            delete_vm(vm, project)
            seconds = time.time() - started
            entry.update(seconds=round(seconds), script_seconds=round(script_seconds) if script_seconds else None,
                         exit=code, usd=round(seconds / 3600 * rate, 4))
            log_cost(entry)
            print(f"\n[gcp_run] {a.script or 'session'} on {a.gpu} ({entry['provisioning']}): VM lived {seconds:.0f} s, "
                  f"about ${entry['usd']:.3f}; output in {workdir.relative_to(HERE)}")
    if code:
        sys.exit(code)


if __name__ == "__main__":
    main()
