# profile_engine.py: where a nano_engine decode step spends its time (chapter 5.1). Fills the engine with the
# throughput benchmark's 256 requests, runs until every prompt is in the cache, times 20 decode steps one by one,
# reports the caching allocator's retries, then profiles 5 steps with the PyTorch profiler.
#
#   modal run modal_run.py --script profile_engine.py --gpu 'H100!' --vllm      # about 2 minutes, about $0.10
#   modal run modal_run.py --script profile_engine.py --gpu 'H100!' --vllm --args "--default-allocator --no-profile"
import argparse
import os
import sys
import time
from pathlib import Path

# nano_engine turns on expandable segments (see nano_engine/engine.py); --default-allocator keeps PyTorch's default.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "" if "--default-allocator" in sys.argv else "expandable_segments:True")
import torch  # noqa: E402
from torch.profiler import ProfilerActivity, profile

sys.path.insert(0, str(Path(__file__).parent))
from nano_engine import LLM, SamplingParams  # noqa: E402
from nano_engine.bench import requests  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="unsloth/Meta-Llama-3.1-8B-Instruct")
ap.add_argument("--util", type=float, default=0.9)
ap.add_argument("--no-profile", action="store_true")
ap.add_argument("--default-allocator", action="store_true", help="without expandable segments")
a = ap.parse_args()
llm = LLM(a.model, max_model_len=4096, max_num_seqs=256, max_num_batched_tokens=8192, gpu_memory_utilization=a.util)
eng = llm.engine
for i, (prompt, n) in enumerate(requests(256, 100, 1024, 32000, 0)):
    eng.add_request(str(i), prompt, SamplingParams(temperature=0.6, max_tokens=n, ignore_eos=True))
while any(s.num_computed < s.num_prompt_tokens for s in eng.scheduler.running) or eng.scheduler.waiting:
    eng.step()
print(f"{torch.cuda.get_device_name()}: {len(eng.scheduler.running)} sequences decoding")


def timed(n: int) -> float:
    torch.cuda.synchronize()
    t = time.perf_counter()
    for _ in range(n):
        eng.step()
    torch.cuda.synchronize()
    return (time.perf_counter() - t) / n * 1e3


steps = [round(timed(1), 1) for _ in range(20)]
st = torch.cuda.memory_stats()
print(f"decode steps (ms): {steps}")
print(f"allocator: {st['num_alloc_retries']} retries, {st['num_ooms']} OOMs, "
      f"{torch.cuda.memory_reserved() / 2**30:.1f} GiB reserved, {torch.cuda.memory_allocated() / 2**30:.1f} GiB allocated")
if a.no_profile:
    sys.exit()
with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA]) as prof:
    timed(5)
print(prof.key_averages().table(sort_by="self_cuda_time_total", row_limit=15, max_name_column_width=60))
print(prof.key_averages().table(sort_by="self_cpu_time_total", row_limit=15, max_name_column_width=60))
