# nsys_decode.py: the decode step of profile_decode.py seen through Nsight Systems (chapter 2.5).
#
# The script runs itself under `nsys profile`. The child loads Llama 3.2 1B in BF16, prefills a 512-token prompt and
# runs 25 decode steps, then does the same again with the last 20 steps between cudaProfilerStart and
# cudaProfilerStop, each step inside an NVTX range. Recording the second pass keeps out the one-time cost of cuDNN
# building an attention plan for each new cache length (chapter 3.1). The parent then runs `nsys stats` on the
# report and prints three summaries: the NVTX ranges (one per step), the GPU kernels, and the CUDA API calls made on the CPU.
#
# Needs Nsight Systems and an NVIDIA GPU. On Modal: modal run modal_run.py --script nsys_decode.py --gpu H100 --toolkit
# Elsewhere: python nsys_decode.py (with nsys on the PATH). The .nsys-rep file can be opened in the Nsight Systems GUI.
import csv
import io
import subprocess
import sys

STEPS = 20

if len(sys.argv) > 1 and sys.argv[1] == "--child":
    import torch
    from transformers import AutoModelForCausalLM

    model = AutoModelForCausalLM.from_pretrained("unsloth/Llama-3.2-1B-Instruct", dtype=torch.bfloat16).cuda().eval()
    torch.manual_seed(0)
    ids = torch.randint(0, model.config.vocab_size, (1, 512), device="cuda")

    def run(record):
        out = model(input_ids=ids, use_cache=True)
        cache, tok = out.past_key_values, out.logits[:, -1:].argmax(-1)
        for i in range(5 + STEPS):
            if record and i == 5:                        # record only the last STEPS steps
                torch.cuda.synchronize()
                torch.cuda.cudart().cudaProfilerStart()
            torch.cuda.nvtx.range_push(f"decode step {i - 5}" if i >= 5 else "warm-up")
            out = model(input_ids=tok, past_key_values=cache, use_cache=True)
            cache, tok = out.past_key_values, out.logits[:, -1:].argmax(-1)
            torch.cuda.nvtx.range_pop()
        torch.cuda.synchronize()
        if record:
            torch.cuda.cudart().cudaProfilerStop()

    with torch.no_grad():
        run(record=False)   # every cache length here is new, so cuDNN builds an attention plan at each step
        run(record=True)    # the same lengths again, now served from cuDNN's plan cache
    print(f"{torch.cuda.get_device_name()}, PyTorch {torch.__version__}: recorded {STEPS} decode steps")
    sys.exit()

version = subprocess.run(["nsys", "--version"], capture_output=True, text=True).stdout.strip()
print(version)
subprocess.run(["nsys", "profile", "--trace", "cuda,nvtx,osrt", "--capture-range", "cudaProfilerApi",
                "--capture-range-end", "stop", "--force-overwrite", "true", "-o", "/tmp/decode",
                sys.executable, __file__, "--child"], check=True)


def report(name):
    out = subprocess.run(["nsys", "stats", "--report", name, "--format", "csv", "--force-export", "true",
                          "/tmp/decode.nsys-rep"], capture_output=True, text=True, check=True).stdout
    start = out.find("Time (%)")                         # skip nsys's own messages before the CSV header
    return list(csv.DictReader(io.StringIO(out[start:])))


steps = [r for r in report("nvtx_sum") if "decode step" in r["Range"]]
total_steps = sum(int(r["Instances"]) for r in steps)
mean_ns = sum(float(r["Total Time (ns)"]) for r in steps) / total_steps
print(f"\nNVTX ranges: {total_steps} decode steps, {mean_ns / 1e6:.2f} ms each on average (CPU time inside the range)")

kernels = report("cuda_gpu_kern_sum")
launches = sum(int(r["Instances"]) for r in kernels)
busy_ns = sum(float(r["Total Time (ns)"]) for r in kernels)
print(f"\nGPU kernels: {launches} launches ({launches / STEPS:.0f} per step), "
      f"{busy_ns / STEPS / 1e6:.2f} ms of kernel time per step")
print(f"   {'share':>6} {'count':>6} {'mean':>9}   kernel")
for r in kernels[:8]:
    print(f"   {float(r['Time (%)']):5.1f}% {int(r['Instances']):6d} {float(r['Avg (ns)']) / 1e3:6.1f} us   {r['Name'][:70]}")

api = report("cuda_api_sum")
print(f"\nCUDA API calls on the CPU, by total time:")
print(f"   {'share':>6} {'count':>6} {'mean':>9}   call")
for r in api[:6]:
    print(f"   {float(r['Time (%)']):5.1f}% {int(r['Num Calls']):6d} {float(r['Avg (ns)']) / 1e3:6.1f} us   {r['Name']}")
