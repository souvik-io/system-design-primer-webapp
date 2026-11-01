# decode_runtime.py: how much a decode step gains from a static KV cache, CUDA graphs and torch.compile (chapter 3.1).
#
#  1. Launch overhead: 200 tiny kernels launched one by one from Python, then replayed as one CUDA graph.
#  2. Llama 3.2 1B in BF16, batch 1, a 512-token prompt, then decode steps in five versions:
#       A. Hugging Face's default forward with its dynamic KV cache (the chapter 2.5 baseline)
#       B. the same forward with a static KV cache, so every decode step has the same shapes
#       C. B captured by hand in one CUDA graph with torch.cuda.graph and replayed every step
#       D. B compiled with torch.compile (mode="default"): Inductor fuses kernels, no CUDA graphs
#       E. B compiled with torch.compile (mode="reduce-overhead"): fused kernels replayed as CUDA graphs
#     For each it times 100 steps twice over the same sequence lengths (the first pass also pays for anything
#     done once per new shape), checks the greedy tokens against version A's, and then profiles one step for
#     its kernel count and the GPU's busy time.
#  3. The caching allocator: a "growing batch" pattern of allocations with and without expandable segments.
#
# Needs an NVIDIA GPU, and downloads about 2.5 GB of weights from Hugging Face on the first run.
# Run: python decode_runtime.py      or: modal run modal_run.py --script decode_runtime.py --gpu H100 --cpu 4
import json
import os
import subprocess
import sys
import time

import torch

dev = "cuda"


def timed(fn, iters):
    """Average wall time per call in seconds, measured on the CPU after a synchronize at each end."""
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    for _ in range(iters):
        fn()
    torch.cuda.synchronize()
    return (time.perf_counter() - t0) / iters


def gpu_profile(fn):
    """Kernels launched and the GPU's busy time (ms) for one call of fn, from the PyTorch profiler."""
    from torch.profiler import ProfilerActivity, profile
    with profile(activities=[ProfilerActivity.CUDA]) as prof:
        fn()
        torch.cuda.synchronize()
    kernels = [e for e in prof.events() if e.device_type == torch.autograd.DeviceType.CUDA and e.device_time > 0]
    return len(kernels), sum(e.device_time for e in kernels) / 1e3


# ---------------------------------------------------------------------------------------------------------------
# 3. The caching allocator. This part runs in a child process, because the allocator's settings are read from
# PYTORCH_ALLOC_CONF when CUDA first starts, and a fresh process gives each run an empty cache.
if len(sys.argv) > 1 and sys.argv[1] == "--allocator":
    sizes = [256 + 32 * i for i in range(16)]       # MiB: a batch that grows a little every step, 256 to 736 MiB
    for mib in sizes:
        x = torch.empty(mib * 2**20, dtype=torch.uint8, device=dev)
        del x                                       # freed to the allocator's cache, not to the driver
    reserved = torch.cuda.memory_reserved() / 2**20
    print(f"   {os.environ.get('PYTORCH_ALLOC_CONF') or 'default settings':<26} largest tensor {sizes[-1]} MiB, "
          f"allocated now {torch.cuda.memory_allocated() / 2**20:.0f} MiB, reserved {reserved:,.0f} MiB")
    sys.exit()

gpu = torch.cuda.get_device_name()
print(f"{gpu}, PyTorch {torch.__version__}")
# Every timing comes before any profiling: in our runs, eager decode steps stayed about 20 to 30% slower after a
# torch.profiler session had ended.

# ---------------------------------------------------------------------------------------------------------------
# 1. Launch overhead: the same 200 tiny kernels, launched from Python and replayed from a CUDA graph.
x = torch.zeros(1024, device=dev)


def tiny_kernels():
    for _ in range(200):
        x.add_(1.0)                                 # one small element-wise kernel, about 1 to 2 microseconds of work


for _ in range(3):
    tiny_kernels()                                  # warm up
eager = timed(tiny_kernels, 50)

side = torch.cuda.Stream()                          # PyTorch's docs warm up and capture on a side stream
side.wait_stream(torch.cuda.current_stream())
with torch.cuda.stream(side):
    tiny_kernels()
torch.cuda.current_stream().wait_stream(side)
tiny_graph = torch.cuda.CUDAGraph()
with torch.cuda.graph(tiny_graph):
    tiny_kernels()                                  # recorded, not run
replay = timed(tiny_graph.replay, 50)
print(f"\n1. 200 tiny kernels\n"
      f"   launched one by one: {eager * 1e6:,.0f} us ({eager / 200 * 1e6:.1f} us per kernel)\n"
      f"   replayed as a graph: {replay * 1e6:,.0f} us ({replay / 200 * 1e6:.1f} us per kernel), "
      f"{eager / replay:.1f} times faster")

# ---------------------------------------------------------------------------------------------------------------
# 2. A decode step in five versions.
import transformers
from transformers import AutoModelForCausalLM, StaticCache

MODEL = "unsloth/Llama-3.2-1B-Instruct"             # a public mirror of Meta's Llama 3.2 1B Instruct
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16).to(dev).eval()
weights = sum(p.numel() * p.element_size() for p in model.parameters())
print(f"\n2. {MODEL}, transformers {transformers.__version__}: {weights / 1e9:.2f} GB of weights; "
      f"batch 1, 512-token prompt, 100 timed steps")

PROMPT, STEPS, MAX_LEN = 512, 100, 1024
torch.manual_seed(0)
ids = torch.randint(0, model.config.vocab_size, (1, PROMPT), device=dev)
results, steps = {}, {}


def dynamic_version():
    """Version A: the default dynamic cache, which grows by concatenation every step."""
    state = {}

    def reset():
        out = model(input_ids=ids, use_cache=True)
        state["cache"], state["tok"] = out.past_key_values, out.logits[:, -1:].argmax(-1)

    def step():
        out = model(input_ids=state["tok"], past_key_values=state["cache"], use_cache=True)
        state["cache"], state["tok"] = out.past_key_values, out.logits[:, -1:].argmax(-1)
        return state["tok"]
    reset()
    return step, reset


def static_version(forward):
    """Versions B to E: a static cache of MAX_LEN positions, preallocated and written in place. In transformers 5.x
    the cache keeps its own write position as a GPU tensor, so a decode step has no Python-side state that changes."""
    cache = StaticCache(config=model.config, max_cache_len=MAX_LEN)
    tok = torch.zeros(1, 1, dtype=torch.long, device=dev)  # static input: the token fed to the next step

    def reset():
        """Empty the cache in place and run the prompt again with the uncompiled forward."""
        cache.reset()
        out = model(input_ids=ids, past_key_values=cache, use_cache=True)
        tok.copy_(out.logits[:, -1:].argmax(-1))

    def step():
        logits = forward(input_ids=tok, past_key_values=cache, use_cache=True).logits
        tok.copy_(logits[:, -1:].argmax(-1))                # update the input in place, so its address stays fixed
        return tok
    reset()
    return step, reset, tok


def measure(name, step, reset, setup_seconds=0.0):
    """Time STEPS decode steps twice over the same sequence lengths: the first pass meets each length for the first
    time, the second repeats them. The first 32 greedy tokens are kept to compare the versions."""
    passes = []
    for _ in range(2):
        reset()
        tokens = [step().item() for _ in range(32)]
        passes.append(timed(step, STEPS) * 1e3)
    steps[name] = (step, reset)
    results[name] = {"first_ms": passes[0], "ms": passes[1], "tokens": tokens, "setup_s": setup_seconds}
    match = sum(a == b for a, b in zip(tokens, results.get("A", results[name])["tokens"]))
    setup = f", setup {setup_seconds:4.1f} s" if setup_seconds else ""
    print(f"   {name}: {passes[1]:6.2f} ms per step (first pass {passes[0]:6.2f} ms), "
          f"first 32 tokens match A: {match}/32{setup}")


with torch.no_grad():
    measure("A", *dynamic_version())

    step_b, reset_b, _ = static_version(model.forward)
    measure("B", step_b, reset_b)

    # C. Capture one static-cache step in a CUDA graph by hand. Warm up on a side stream first, as PyTorch's docs
    # advise, so that one-time work such as cuBLAS workspace allocation happens outside the capture.
    step_c, reset_c, tok_c = static_version(model.forward)
    t0 = time.perf_counter()
    side = torch.cuda.Stream()
    side.wait_stream(torch.cuda.current_stream())
    with torch.cuda.stream(side):
        for _ in range(3):
            step_c()
    torch.cuda.current_stream().wait_stream(side)
    graph = torch.cuda.CUDAGraph()
    with torch.cuda.graph(graph):
        step_c()                                            # recorded, not run: kernels and their pointers only
    torch.cuda.synchronize()
    measure("C", lambda: (graph.replay(), tok_c)[1], reset_c, time.perf_counter() - t0)

    # D and E. torch.compile on the decode forward only; the 512-token prefill keeps the uncompiled forward, so the
    # compiled function always sees the same shapes and compiles once.
    for name, mode in (("D", "default"), ("E", "reduce-overhead")):
        compiled = torch.compile(model.forward, mode=mode, fullgraph=True)
        step, reset, _ = static_version(compiled)
        t0 = time.perf_counter()
        for _ in range(3):
            step()                                          # compile, and for E also record the CUDA graph
        torch.cuda.synchronize()
        measure(name, step, reset, time.perf_counter() - t0)

    # Profile one step of each version, after all the timing.
    print("\n   Kernels per step and the GPU's busy time, from the PyTorch profiler:")
    for name, (step, reset) in steps.items():
        reset()
        for _ in range(8):
            step()
        kernels, busy = gpu_profile(step)
        results[name].update(kernels=kernels, busy_ms=busy)
        print(f"   {name}: {kernels:4d} kernels, GPU busy {busy:5.2f} ms of a {results[name]['ms']:5.2f} ms step")
    kernels, busy = gpu_profile(tiny_kernels)
    print(f"   The 200 tiny kernels of part 1: {kernels} kernels, GPU busy {busy * 1e3:.0f} us")

base = results["A"]["ms"]
print("\n   Speed-up over A: " + ", ".join(f"{k} {base / v['ms']:.1f}x" for k, v in results.items()))
SPEC_BW = (("H200", 4.8e12), ("H100", 3.35e12), ("A100", 2.0e12), ("L40S", 864e9), ("A10", 600e9), ("L4", 300e9))
bw = next((b for k, b in SPEC_BW if k in gpu), None)    # longest names first, so an A100 is not read as an A10
if bw:
    print(f"   Reading the weights once at the spec bandwidth would take {weights / bw * 1e3:.2f} ms")
else:
    print(f"   Unknown GPU ({gpu}): add its spec bandwidth to SPEC_BW for the roofline")
print("RESULTS_JSON " + json.dumps({k: {f: (round(v, 3) if isinstance(v, float) else v) for f, v in r.items() if f != "tokens"}
                                    for k, r in results.items()}))

# ---------------------------------------------------------------------------------------------------------------
# 3. The caching allocator, in child processes with and without expandable segments.
print("\n3. Sixteen tensors allocated and freed one after another, each 32 MiB larger than the last")
sys.stdout.flush()                                          # print in order with the child processes' output
for conf in ("", "expandable_segments:True"):
    env = {**os.environ, "PYTORCH_ALLOC_CONF": conf}
    env.pop("PYTORCH_CUDA_ALLOC_CONF", None)                # the old name is still read, so remove it too
    subprocess.run([sys.executable, __file__, "--allocator"], env=env, check=True)
