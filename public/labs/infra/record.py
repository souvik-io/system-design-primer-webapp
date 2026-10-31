# bench/record.py: append one benchmark result, with the machine and software it ran on, to a log.
import datetime
import json
import platform
import subprocess
import sys


def environment() -> dict:
    env = {"python": platform.python_version(), "os": platform.platform(), "machine": platform.machine()}
    try:
        import torch
        env["torch"] = torch.__version__
        if torch.cuda.is_available():
            env["device"] = torch.cuda.get_device_name(0)
            env["cuda"] = torch.version.cuda
            env["gpu_count"] = torch.cuda.device_count()
        elif torch.backends.mps.is_available():
            env["device"] = "mps"
    except ImportError:
        pass
    if platform.system() == "Darwin":
        env["cpu"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"],
                                    capture_output=True, text=True).stdout.strip()
    try:  # NVIDIA driver version, if nvidia-smi exists
        env["driver"] = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, check=True).stdout.split("\n")[0]
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    try:
        env["git_commit"] = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                                           capture_output=True, text=True, check=True).stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    return env


def record(name: str, result: dict, path: str = "results/results.jsonl") -> dict:
    row = {"name": name, "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
           "env": environment(), "result": result}
    with open(path, "a") as f:
        f.write(json.dumps(row) + "\n")
    return row


if __name__ == "__main__":
    row = record("smoke-test", {"note": sys.argv[1] if len(sys.argv) > 1 else "setup works"})
    print(json.dumps(row, indent=2))
