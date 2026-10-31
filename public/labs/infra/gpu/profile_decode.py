# profile_decode.py: where the time of one decode step goes, measured with the PyTorch profiler (chapter 2.5).
#
#  1. Llama 3.2 1B in BF16, batch 1, a 512-token prompt, then decode steps with Hugging Face's model forward.
#     The profiler records every CPU-side operation and every GPU kernel of one decode step.
#  2. It prints the step's wall time, the GPU's busy time, the number of kernels, and the top kernels.
#  3. It writes the step's kernel timeline as compact JSON (decode_trace.json) for the chapter's widget.
#  4. It samples the GPU's SM clock, power and temperature with nvidia-smi while a long run of matmuls is in flight.
#
# Needs an NVIDIA GPU, and downloads about 2.5 GB of weights from Hugging Face on the first run.
# Run: python profile_decode.py      or: modal run modal_run.py --script profile_decode.py --gpu H100
import json
import subprocess
import time

import torch
from torch.profiler import ProfilerActivity, profile
from transformers import AutoModelForCausalLM

MODEL = "unsloth/Llama-3.2-1B-Instruct"     # a public mirror of Meta's Llama 3.2 1B Instruct
dev = "cuda"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16).to(dev).eval()
weights = sum(p.numel() * p.element_size() for p in model.parameters())
gpu = torch.cuda.get_device_name()
print(f"{gpu}, PyTorch {torch.__version__}; {MODEL}: {weights / 1e9:.2f} GB of weights\n")

torch.manual_seed(0)
ids = torch.randint(0, model.config.vocab_size, (1, 512), device=dev)


@torch.no_grad()
def decode_steps(n):
    out = model(input_ids=ids, use_cache=True)
    cache, tok = out.past_key_values, out.logits[:, -1:].argmax(-1)
    for _ in range(n):
        out = model(input_ids=tok, past_key_values=cache, use_cache=True)
        cache, tok = out.past_key_values, out.logits[:, -1:].argmax(-1)
    return cache, tok


decode_steps(5)                                     # warm up kernels and allocator
torch.cuda.synchronize()
start = time.perf_counter()
decode_steps(50)
torch.cuda.synchronize()
prefill_and_50 = time.perf_counter() - start
cache, tok = decode_steps(1)
torch.cuda.synchronize()
t0 = time.perf_counter()
with torch.no_grad():
    for _ in range(50):
        out = model(input_ids=tok, past_key_values=cache, use_cache=True)
        tok = out.logits[:, -1:].argmax(-1)
torch.cuda.synchronize()
step = (time.perf_counter() - t0) / 50
ideal = weights / {"H100": 3.35e12, "A10": 600e9}.get(next((k for k in ("H100", "A10") if k in gpu), "H100"))
print(f"1. Decode step at batch 1: {step * 1e3:.2f} ms wall time ({1 / step:.0f} tokens/s); "
      f"reading the weights once at the spec bandwidth would take {ideal * 1e3:.2f} ms")

with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA]) as prof, torch.no_grad():
    out = model(input_ids=tok, past_key_values=cache, use_cache=True)
    tok = out.logits[:, -1:].argmax(-1)
    torch.cuda.synchronize()
prof.export_chrome_trace("/tmp/trace.json")
events = json.load(open("/tmp/trace.json"))["traceEvents"]
kernels = sorted((e for e in events if e.get("cat") == "kernel"), key=lambda e: e["ts"])
launches = [e for e in events if e.get("cat") == "cuda_runtime" and "LaunchKernel" in e.get("name", "")]
t_first, t_last = kernels[0]["ts"], max(e["ts"] + e["dur"] for e in kernels)
busy = sum(e["dur"] for e in kernels)
span = t_last - t_first
print(f"2. One profiled step: {len(kernels)} GPU kernels, {len(launches)} kernel launches from the CPU; "
      f"GPU busy {busy / 1e3:.2f} ms of a {span / 1e3:.2f} ms span ({busy / span:.0%})")

print("\n   Top kernels by total GPU time in the step:")
print(prof.key_averages().table(sort_by="cuda_time_total", row_limit=8, max_name_column_width=60))

# Compact timeline for the widget: kernels and CPU launch calls, times in microseconds from the first launch.
t_cpu0 = min(e["ts"] for e in launches)
trace = {
    "gpu": gpu, "model": MODEL, "step_ms": round(step * 1e3, 3),
    "kernels": [[round(e["ts"] - t_cpu0, 1), round(e["dur"], 1), e["name"][:80]] for e in kernels],
    "launches": [[round(e["ts"] - t_cpu0, 1), round(e["dur"], 1)] for e in launches],
}
with open("decode_trace.json", "w") as f:
    json.dump(trace, f)
print("TRACE_JSON_BEGIN")
print(json.dumps(trace))
print("TRACE_JSON_END")

print("\n4. SM clock and power while 3,000 BF16 8192-square matmuls run back to back (about 4 s on an H100)")
a = torch.randn(8192, 8192, device=dev, dtype=torch.bfloat16)
query = ["nvidia-smi", "--query-gpu=clocks.sm,clocks.max.sm,power.draw,power.limit,temperature.gpu", "--format=csv,noheader"]
print(f"   idle:   {subprocess.run(query, capture_output=True, text=True).stdout.strip()}")
for _ in range(3000):
    b = a @ a                                           # queued asynchronously; the GPU stays busy for a while
for i in range(6):
    time.sleep(0.3)
    print(f"   busy {i + 1}: {subprocess.run(query, capture_output=True, text=True).stdout.strip()}")
torch.cuda.synchronize()
