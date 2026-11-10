# bench.py: two fixed benchmarks for nano_engine, so runs can be compared with each other and with vLLM.
#
# throughput  N requests of random token ids, prompt and output lengths each drawn uniformly from [min, max] with a
#             fixed seed, all submitted at once, generated to their full length (end-of-sequence ignored). Reports
#             output tokens per second. --engine vllm runs the same requests through vLLM; --engine hf runs them
#             through Hugging Face Transformers one at a time, which is what serving without an engine looks like.
# stall       --decoders requests are decoding when one long prompt arrives. Reports every step's time, so you can
#             see the gap a long prefill puts between two tokens of the running requests, with and without chunking.
#
#   python -m nano_engine.bench throughput --num-seqs 32 --max-len 256            # a Mac: about a minute
#   python -m nano_engine.bench throughput --engine vllm --model unsloth/Meta-Llama-3.1-8B-Instruct
#   python -m nano_engine.bench stall --long-prompt 3000 --max-num-batched-tokens 256
import argparse
import json
import os
import random
import time

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")   # see engine.py
import torch  # noqa: E402


def requests(n: int, lo: int, hi: int, vocab: int, seed: int):
    rng = random.Random(seed)
    return [([rng.randrange(vocab) for _ in range(rng.randint(lo, hi))], rng.randint(lo, hi)) for _ in range(n)]


def sync(device: str) -> None:
    if device.startswith("cuda"):
        torch.cuda.synchronize()
    elif device == "mps":
        torch.mps.synchronize()


def throughput(a) -> dict:
    vocab = 32000                                    # every model here has at least this many tokens
    reqs = requests(a.num_seqs, a.min_len, a.max_len, vocab, a.seed)
    total_out = sum(n for _, n in reqs)
    if a.engine == "nano":
        from nano_engine import LLM, SamplingParams
        llm = LLM(a.model, device=a.device, max_model_len=a.max_model_len, kv_cache_gib=a.kv_cache_gib,
                  max_num_seqs=a.max_num_seqs, max_num_batched_tokens=a.max_num_batched_tokens)
        llm.generate([[1, 2, 3]], SamplingParams(max_tokens=4))          # warm up
        llm.engine.stats = dict.fromkeys(llm.engine.stats, 0)
        params = [SamplingParams(temperature=0.6, max_tokens=n, ignore_eos=True) for _, n in reqs]
        step, step_ms = llm.engine.step, []

        def timed_step():                            # step() already waits for the GPU when it reads the tokens
            t0 = time.perf_counter()
            out = step()
            step_ms.append(1e3 * (time.perf_counter() - t0))
            return out

        llm.engine.step = timed_step
        sync(a.device)
        t = time.perf_counter()
        out = llm.generate([p for p, _ in reqs], params, progress=a.progress)
        sync(a.device)
        seconds = time.perf_counter() - t
        assert sum(len(o[0]) for o in out) == total_out
        step_ms.sort()
        extra = {**llm.engine.stats, "kv_blocks": llm.engine.blocks.num_blocks,
                 "median_step_ms": round(step_ms[len(step_ms) // 2], 1),
                 "slowest_steps_ms": [round(x, 1) for x in step_ms[-5:]]}
        if a.device.startswith("cuda"):
            extra["alloc_retries"] = torch.cuda.memory_stats()["num_alloc_retries"]
    elif a.engine == "vllm":
        from vllm import LLM, SamplingParams
        llm = LLM(a.model, max_model_len=a.max_model_len, max_num_seqs=a.max_num_seqs, enforce_eager=a.eager,
                  max_num_batched_tokens=a.max_num_batched_tokens, enable_prefix_caching=False,
                  gpu_memory_utilization=0.9)
        llm.generate([{"prompt_token_ids": [1, 2, 3]}], SamplingParams(max_tokens=4), use_tqdm=False)
        params = [SamplingParams(temperature=0.6, max_tokens=n, ignore_eos=True) for _, n in reqs]
        t = time.perf_counter()
        out = llm.generate([{"prompt_token_ids": p} for p, _ in reqs], params, use_tqdm=False)
        seconds = time.perf_counter() - t
        assert sum(len(o.outputs[0].token_ids) for o in out) == total_out
        extra = {"eager": a.eager}
    else:                                            # Hugging Face, one request at a time
        from transformers import AutoModelForCausalLM
        dtype = torch.bfloat16 if a.device.startswith("cuda") else torch.float32
        model = AutoModelForCausalLM.from_pretrained(a.model, dtype=dtype).to(a.device).eval()
        gen = lambda p, n: model.generate(torch.tensor([p], device=a.device), max_new_tokens=n, min_new_tokens=n,
                                          do_sample=True, temperature=0.6, top_p=1.0, top_k=0)
        gen([1, 2, 3], 4)
        sync(a.device)
        t = time.perf_counter()
        for p, n in reqs:
            gen(p, n)
        sync(a.device)
        seconds = time.perf_counter() - t
        extra = {}
    return {"benchmark": "throughput", "engine": a.engine, "model": a.model, "device": a.device, "num_seqs": a.num_seqs,
            "lengths": [a.min_len, a.max_len], "prompt_tokens": sum(len(p) for p, _ in reqs),
            "output_tokens": total_out, "seconds": round(seconds, 2), "output_tok_s": round(total_out / seconds, 1),
            **extra}


def stall(a) -> dict:
    """Decoding requests, then one long prompt arrives: how long is the longest step, and how soon does the long
    prompt get its first token?"""
    from nano_engine import LLM, SamplingParams
    budget = a.max_num_batched_tokens if a.chunked else max(a.max_num_batched_tokens, a.long_prompt + a.decoders)
    llm = LLM(a.model, device=a.device, max_model_len=a.max_model_len, kv_cache_gib=a.kv_cache_gib,
              max_num_batched_tokens=budget, chunked_prefill=a.chunked)
    eng = llm.engine
    rng = random.Random(a.seed)
    decode = SamplingParams(temperature=0, max_tokens=a.max_model_len - 64, ignore_eos=True)   # never finish
    for i in range(a.decoders):
        eng.add_request(f"d{i}", [rng.randrange(32000) for _ in range(64)], decode)
    times = []

    def step() -> list:
        sync(a.device)
        t = time.perf_counter()
        out = eng.step()
        sync(a.device)
        times.append(1e3 * (time.perf_counter() - t))
        return out

    for _ in range(20):                              # the decoders' prompts, then steady decoding
        step()
    # Two long prompts, one after the other; only the second is reported, so first-use costs (the allocator
    # growing its pool, kernels running a shape for the first time) do not count.
    for name in ("warm-up", "long"):
        eng.add_request(name, [rng.randrange(32000) for _ in range(a.long_prompt)], SamplingParams(max_tokens=1))
        arrived, ttft = len(times), None
        while ttft is None:
            if any(o.seq.request_id == name for o in step()):
                ttft = sum(times[arrived:])
        for _ in range(10):
            step()
    after = times[arrived:]
    steady = sorted(times[10:20])[5]
    return {"benchmark": "stall", "model": a.model, "device": a.device, "decoders": a.decoders,
            "long_prompt": a.long_prompt, "chunked": a.chunked, "token_budget": budget,
            "steady_step_ms": round(steady, 1), "longest_step_ms": round(max(after), 1),
            "steps_to_first_token": len(after) - 10, "long_prompt_ttft_ms": round(ttft, 1),
            "step_ms_after_arrival": [round(x, 1) for x in after]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("benchmark", choices=["throughput", "stall"])
    ap.add_argument("--engine", choices=["nano", "vllm", "hf"], default="nano")
    ap.add_argument("--model", default="HuggingFaceTB/SmolLM2-135M-Instruct")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--num-seqs", type=int, default=256)
    ap.add_argument("--min-len", type=int, default=100)
    ap.add_argument("--max-len", type=int, default=1024)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-model-len", type=int, default=4096)
    ap.add_argument("--kv-cache-gib", type=float, default=1.0, help="KV cache size off CUDA")
    ap.add_argument("--max-num-seqs", type=int, default=256)
    ap.add_argument("--max-num-batched-tokens", type=int, default=2048)
    ap.add_argument("--eager", action="store_true", help="vLLM without CUDA graphs or torch.compile")
    ap.add_argument("--decoders", type=int, default=32)
    ap.add_argument("--long-prompt", type=int, default=3000)
    ap.add_argument("--no-chunking", dest="chunked", action="store_false")
    ap.add_argument("--progress", action="store_true")
    ap.add_argument("--out", help="append the result as one JSON line to this file")
    a = ap.parse_args()
    result = throughput(a) if a.benchmark == "throughput" else stall(a)
    if a.device.startswith("cuda"):
        result["gpu"] = torch.cuda.get_device_name()
    print(json.dumps(result))
    if a.out:
        with open(a.out, "a") as f:
            f.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
