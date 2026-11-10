# inside_vllm.py: chapter 5.2's GPU lab. Two experiments on a real vLLM server (vLLM 0.32.0).
#
# trace   Starts `vllm serve` with timing wrappers around the functions a request passes through (the HTTP handler,
#         AsyncLLM, the engine core's loop, the scheduler, the KV cache manager, the model runner, the output
#         processor), sends one streamed chat request, then a second one that shares its long system prompt, and
#         prints where each request was at each moment: which process, which thread, which function, for how long.
#         Writes inside_vllm_trace.json (the report) and vllm_trace.json, which opens in https://ui.perfetto.dev.
# knobs   Starts the server once per configuration and sends the fixed burst of chapter 5.1's benchmark (256
#         requests, prompt and output lengths uniform in [100, 1024]) as streamed HTTP requests. Reports output
#         tokens per second, time to first token, the gap between tokens and the preemption count for different
#         max_num_seqs, max_num_batched_tokens and gpu_memory_utilization, then a shared-prefix workload with and
#         without prefix caching. Writes inside_vllm_knobs.json.
#
#   modal run modal_run.py --script inside_vllm.py --gpu 'H100!' --vllm --args "trace"     # about 4.5 minutes, $0.30
#   modal run modal_run.py --script inside_vllm.py --gpu 'H100!' --vllm --args "knobs"     # about 12 minutes, $0.80
#   python gcp_run.py --script inside_vllm.py --gpu A100-80GB --vllm --args "trace"
#   python inside_vllm.py trace --quick      # any NVIDIA GPU with vLLM 0.32 installed: Llama 3.2 1B
#
# How the tracing works: `inside_vllm.py serve ...` replaces each traced method with a wrapper and then calls
# vLLM's own command-line entry point. vLLM starts its engine core as a forked child process (the default start
# method when CUDA has not been initialised in the parent), so the child inherits the wrappers. Each wrapper appends
# one line to a shared file with the start time, duration, process id and thread name. time.perf_counter_ns() reads
# CLOCK_MONOTONIC on Linux, which is one clock for the whole machine, so times from the client, the API server and
# the engine core can be put on one axis.
import argparse
import asyncio
import functools
import inspect
import json
import os
import random
import re
import signal
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
PORT = 8000
URL = f"http://127.0.0.1:{PORT}"
TRACE_FILE = "/tmp/vllm_trace.jsonl"

# (module, class, method, label, function that turns (args, kwargs, return value) into a short note)
TARGETS = [
    # The API server process.
    ("vllm.entrypoints.openai.chat_completion.serving", "OpenAIServingChat", "create_chat_completion", "HTTP handler: create_chat_completion", None),
    ("vllm.entrypoints.openai.chat_completion.serving", "OpenAIServingChat", "render_chat_request", "render: chat template and tokenize", None),
    ("vllm.v1.engine.async_llm", "AsyncLLM", "_add_request", "AsyncLLM._add_request", None),
    ("vllm.v1.engine.core_client", "AsyncMPClient", "add_request_async", "client: send request over ZeroMQ", None),
    ("vllm.v1.serial_utils", "MsgpackEncoder", "encode", "msgpack encode", None),
    ("vllm.v1.serial_utils", "MsgpackDecoder", "decode", "msgpack decode", None),
    ("vllm.v1.engine.output_processor", "OutputProcessor", "process_outputs", "OutputProcessor.process_outputs: detokenize",
     lambda a, k, r: f"{len(a[1])} request outputs"),
    # The engine core process.
    ("vllm.v1.serial_utils", "MsgpackEncoder", "encode_into", "msgpack encode", None),
    ("vllm.v1.engine.core", "EngineCore", "preprocess_add_request", "core: preprocess_add_request (block hashes)", None),
    ("vllm.v1.engine.core", "EngineCoreProc", "_handle_client_request", "core: _handle_client_request",
     lambda a, k, r: getattr(a[1], "name", str(a[1]))),
    ("vllm.v1.core.sched.scheduler", "Scheduler", "add_request", "Scheduler.add_request", None),
    ("vllm.v1.engine.core", "EngineCore", "step", "EngineCore.step", None),
    ("vllm.v1.engine.core", "EngineCore", "step_with_batch_queue", "EngineCore.step_with_batch_queue", None),
    ("vllm.v1.core.sched.scheduler", "Scheduler", "schedule", "Scheduler.schedule",
     lambda a, k, r: f"{r.total_num_scheduled_tokens} tokens for {len(r.num_scheduled_tokens)} requests"),
    ("vllm.v1.core.kv_cache_manager", "KVCacheManager", "get_computed_blocks", "KVCacheManager.get_computed_blocks",
     lambda a, k, r: f"prefix cache hit: {r[1]} of {a[1].num_tokens} tokens"),
    ("vllm.v1.core.kv_cache_manager", "KVCacheManager", "allocate_slots", "KVCacheManager.allocate_slots",
     lambda a, k, r: f"{a[2] if len(a) > 2 else k.get('num_new_tokens')} new tokens, "
                     + ("no room" if r is None else f"{sum(len(g) for g in r.blocks)} new blocks")),
    ("vllm.v1.worker.gpu.model_runner", "GPUModelRunner", "execute_model", "GPUModelRunner.execute_model (V2)",
     lambda a, k, r: f"{a[1].total_num_scheduled_tokens} tokens"),
    ("vllm.v1.worker.gpu.model_runner", "GPUModelRunner", "sample_tokens", "GPUModelRunner.sample_tokens (V2)", None),
    ("vllm.v1.worker.gpu.model_runner", "GPUModelRunner", "prepare_inputs", "runner: prepare_inputs", None),
    ("vllm.v1.worker.gpu.model_runner", "GPUModelRunner", "prepare_attn", "runner: prepare_attn", None),
    ("vllm.v1.worker.gpu.cudagraph_utils", "ModelCudaGraphManager", "run_fullgraph", "runner: replay full CUDA graph", None),
    ("vllm.v1.worker.gpu.cudagraph_utils", "CudaGraphManager", "run_pw_graph", "runner: run piecewise CUDA graphs", None),
    ("vllm.v1.worker.gpu.async_utils", "AsyncOutput", "get_output", "AsyncOutput.get_output: wait for the GPU", None),
    ("vllm.v1.worker.gpu_model_runner", "GPUModelRunner", "execute_model", "GPUModelRunner.execute_model (V1)",
     lambda a, k, r: f"{a[1].total_num_scheduled_tokens} tokens"),
    ("vllm.v1.worker.gpu_model_runner", "GPUModelRunner", "sample_tokens", "GPUModelRunner.sample_tokens (V1)", None),
    ("vllm.v1.core.sched.scheduler", "Scheduler", "update_from_output", "Scheduler.update_from_output",
     lambda a, k, r: f"outputs for {sum(len(v.outputs) for v in r.values())} requests"),
]


# ---------------------------------------------------------------------------------------------- inside the server

def install_tracing() -> None:
    """Wrap every method in TARGETS. Runs in the API server process before vLLM starts."""
    import importlib
    fd = os.open(TRACE_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND)

    def emit(label, start, end, note):
        line = json.dumps({"name": label, "t": start, "dur": end - start, "pid": os.getpid(),
                           "thread": threading.current_thread().name, "note": note}) + "\n"
        os.write(fd, line.encode())            # one short write to an O_APPEND file is atomic

    def describe(note_fn, args, kwargs, result):
        try:
            return note_fn(args, kwargs, result) if note_fn else ""
        except Exception as e:                 # a note must never break the server
            return f"(note failed: {type(e).__name__})"

    for module, cls, method, label, note_fn in TARGETS:
        try:
            owner = getattr(importlib.import_module(module), cls)
            original = owner.__dict__[method]
        except Exception as e:
            emit(f"NOT TRACED {cls}.{method}", time.perf_counter_ns(), time.perf_counter_ns(), repr(e))
            continue

        if inspect.iscoroutinefunction(original):
            @functools.wraps(original)
            async def wrapper(*args, __f=original, __l=label, __n=note_fn, **kwargs):
                start = time.perf_counter_ns()
                result = await __f(*args, **kwargs)
                emit(__l, start, time.perf_counter_ns(), describe(__n, args, kwargs, result))
                return result
        else:
            @functools.wraps(original)
            def wrapper(*args, __f=original, __l=label, __n=note_fn, **kwargs):
                start = time.perf_counter_ns()
                result = __f(*args, **kwargs)
                emit(__l, start, time.perf_counter_ns(), describe(__n, args, kwargs, result))
                return result
        setattr(owner, method, wrapper)


def serve(vllm_args: list[str]) -> None:
    if os.environ.get("VLLM_LAB_TRACE"):
        install_tracing()
    from vllm.entrypoints.cli.main import main as vllm_main
    sys.argv = ["vllm", "serve", *vllm_args]
    vllm_main()


# -------------------------------------------------------------------------------------------------- the driver

class Server:
    """`vllm serve` in a child process, with its log in a file."""

    def __init__(self, model: str, flags: list[str], trace: bool = False):
        self.log = Path(f"/tmp/vllm_server_{int(time.time() * 1000)}.log")
        env = {**os.environ, "VLLM_WORKER_MULTIPROC_METHOD": "fork", **({"VLLM_LAB_TRACE": "1"} if trace else {})}
        cmd = [sys.executable, __file__, "serve", model, "--port", str(PORT), "--max-model-len", "4096", *flags]
        print("\n$ vllm serve", " ".join(cmd[3:]), flush=True)
        self.started = time.time()
        self.proc = subprocess.Popen(cmd, env=env, stdout=self.log.open("w"), stderr=subprocess.STDOUT,
                                     start_new_session=True)

    def __enter__(self):
        while True:
            if self.proc.poll() is not None or time.time() - self.started > 1200:
                print(self.log.read_text()[-6000:])
                raise SystemExit("the vLLM server did not start")
            try:
                urllib.request.urlopen(f"{URL}/health", timeout=2)
                break
            except Exception:
                time.sleep(2)
        self.startup_s = round(time.time() - self.started, 1)
        print(f"server ready after {self.startup_s} s", flush=True)
        return self

    def __exit__(self, *exc):
        os.killpg(self.proc.pid, signal.SIGTERM)
        try:
            self.proc.wait(60)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
        time.sleep(3)                           # let the driver release the GPU's memory

    def log_lines(self, pattern: str) -> list[str]:
        """Lines of the server log that match a pattern, without the timestamp and file prefix."""
        out = []
        for line in self.log.read_text().splitlines():
            if re.search(pattern, line, re.I) and "it/s]" not in line:       # not the progress bars
                out.append(re.sub(r"^.*?\[[\w./]+:\d+\]\s*", "", re.sub(r"\x1b\[[0-9;]*m", "", line))[:400])
        return out

    def metrics(self) -> dict[str, float]:
        """Counters and gauges from /metrics, summed over labels; the cache config's labels as numbers."""
        text = urllib.request.urlopen(f"{URL}/metrics", timeout=10).read().decode()
        out: dict[str, float] = {}
        for line in text.splitlines():
            m = re.match(r"vllm:(\w+?)(?:_total)?(\{[^}]*\})? ([0-9.e+-]+)$", line)
            if not m:
                continue
            name, labels, value = m.groups()
            if name == "cache_config_info":
                for key in ("num_gpu_blocks", "block_size"):
                    found = re.search(rf'{key}="(\d+)"', labels or "")
                    if found:
                        out[key] = float(found.group(1))
            elif not name.endswith(("_bucket", "_created")):
                out[name] = out.get(name, 0.0) + float(value)
        return out


STARTUP_PATTERN = (r"model runner|kv cache|cudagraph|cuda graph|maximum concurrency|chunked prefill|async.* scheduling"
                   r"|took .* seconds|multiproc|memory profiling|max_num_batched_tokens|compil")


async def stream(session, path: str, body: dict) -> dict:
    """Send one streamed request; return send time, the arrival time of every chunk, and the usage chunk."""
    t_send = time.perf_counter_ns()
    arrivals, usage, text = [], None, []
    async with session.post(f"{URL}{path}", json=body) as resp:
        resp.raise_for_status()
        async for raw in resp.content:
            if not raw.startswith(b"data: ") or raw.startswith(b"data: [DONE]"):
                continue
            if b'"usage":{' in raw or b'"usage": {' in raw:
                usage = json.loads(raw[6:]).get("usage") or usage
            if b'"choices":[]' not in raw and b'"choices": []' not in raw:
                arrivals.append(time.perf_counter_ns())
                if body.get("_keep_text"):
                    choice = json.loads(raw[6:])["choices"][0]
                    text.append(choice.get("text") or choice.get("delta", {}).get("content") or "")
    return {"t_send": t_send, "arrivals": arrivals, "t_done": time.perf_counter_ns(), "usage": usage,
            "text": "".join(text)}


def session():
    import aiohttp
    return aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=0), timeout=aiohttp.ClientTimeout(total=1800))


def pct(values: list[float], q: float) -> float:
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))]


# ---------------------------------------------------------------------------------------------------- trace

SYSTEM_PROMPT = " ".join(
    f"Rule {i}: when a customer asks about {topic}, answer in at most {2 + i % 3} sentences and cite policy {100 + i}."
    for i, topic in enumerate(["refunds", "shipping times", "damaged items", "gift cards", "price matching",
                               "order changes", "warranties", "store credit", "international duties", "returns by post",
                               "loyalty points", "subscriptions", "account deletion", "invoices", "bulk orders",
                               "pre-orders", "back-orders", "recalls", "installation", "trade-ins"] * 4))


def read_trace() -> list[dict]:
    return [json.loads(line) for line in Path(TRACE_FILE).read_text().splitlines()]


def report(events: list[dict], result: dict, roles: dict[int, str], title: str) -> dict:
    """Print one request's timeline: every traced call between the moment the client sent the request and the
    moment the last chunk arrived, with times in milliseconds after the send."""
    t0, t_first, t_done = result["t_send"], result["arrivals"][0], result["t_done"]
    window = sorted((e for e in events if t0 <= e["t"] <= t_done), key=lambda e: e["t"])
    ms = lambda ns: ns / 1e6
    print(f"\n=== {title}: first token after {ms(t_first - t0):.1f} ms, {len(result['arrivals'])} chunks, "
          f"done after {ms(t_done - t0):.1f} ms ===")
    print(f"{'start':>8} {'took':>8}  {'process / thread':<28} function")
    rows, steps_seen, first_token_printed = [], 0, False
    for e in window:
        if e["name"].startswith("EngineCore.step"):
            steps_seen += 1
        row = {"start_ms": round(ms(e["t"] - t0), 3), "dur_ms": round(ms(e["dur"]), 3),
               "where": f"{roles[e['pid']]} / {e['thread']}", "name": e["name"], "note": e["note"]}
        rows.append(row)
        if not first_token_printed and e["t"] > t_first:
            print(f"{ms(t_first - t0):8.2f} {'':>8}  {'client':<28} first streamed chunk arrives")
            first_token_printed = True
        if e["t"] <= t_first or steps_seen <= 0:
            print(f"{row['start_ms']:8.2f} {row['dur_ms']:8.3f}  {row['where']:<28} {e['name']}"
                  + (f"   [{e['note']}]" if e["note"] else ""))
    after = [r for r in rows if r["start_ms"] > ms(t_first - t0)]
    print(f"   ... {len(after)} more traced calls while the remaining tokens are generated; medians:")
    medians = {}
    for name in dict.fromkeys(r["name"] for r in after):
        durs = [r["dur_ms"] for r in after if r["name"] == name]
        medians[name] = {"calls": len(durs), "median_ms": round(statistics.median(durs), 3)}
        print(f"       {name:<52} {len(durs):4d} calls, median {medians[name]['median_ms']:.3f} ms")
    gaps = [ms(b - a) for a, b in zip(result["arrivals"], result["arrivals"][1:])]
    return {"title": title, "ttft_ms": round(ms(t_first - t0), 2), "total_ms": round(ms(t_done - t0), 2),
            "chunks": len(result["arrivals"]), "median_chunk_gap_ms": round(statistics.median(gaps), 2) if gaps else None,
            "usage": result["usage"], "text": result["text"],
            "until_first_token": [r for r in rows if r["start_ms"] <= ms(t_first - t0)], "decode_medians": medians}


def chrome_trace(events: list[dict], roles: dict[int, str], marks: list[tuple[str, int]]) -> dict:
    tids: dict[tuple[int, str], int] = {}
    out = [{"name": "process_name", "ph": "M", "pid": pid, "args": {"name": role}} for pid, role in roles.items()]
    for e in events:
        tid = tids.setdefault((e["pid"], e["thread"]), len(tids) + 1)
        out.append({"name": e["name"], "ph": "X", "ts": e["t"] / 1e3, "dur": e["dur"] / 1e3, "pid": e["pid"],
                    "tid": tid, "args": {"note": e["note"]}})
    for (pid, thread), tid in tids.items():
        out.append({"name": "thread_name", "ph": "M", "pid": pid, "tid": tid, "args": {"name": thread}})
    for name, t in marks:
        out.append({"name": name, "ph": "i", "s": "g", "ts": t / 1e3, "pid": 0, "tid": 0})
    return {"traceEvents": out}


async def trace(a) -> None:
    Path(TRACE_FILE).unlink(missing_ok=True)
    with Server(a.model, [], trace=True) as server:
        startup = server.log_lines(STARTUP_PATTERN)
        print("\n--- what the server logged while starting ---")
        print("\n".join(startup))

        def chat(question: str) -> dict:
            return {"model": a.model, "stream": True, "stream_options": {"include_usage": True}, "max_tokens": 24,
                    "temperature": 0, "_keep_text": True,
                    "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": question}]}

        async with session() as s:
            # A different prompt first, so that one-time costs (lazy imports, the tokenizer's first call, kernels
            # running a new shape) do not land on the traced request.
            await stream(s, "/v1/chat/completions", {"model": a.model, "stream": True, "max_tokens": 8,
                                                     "messages": [{"role": "user", "content": "Say hello. " * 300}]})
            await asyncio.sleep(0.5)
            first = await stream(s, "/v1/chat/completions", chat("Can I return a gift card?"))
            await asyncio.sleep(0.5)
            second = await stream(s, "/v1/chat/completions", chat("How long does shipping take?"))
            await asyncio.sleep(0.5)
        metrics = server.metrics()

    events = read_trace()
    missing = [e for e in events if e["name"].startswith("NOT TRACED")]
    for e in missing:
        print("warning:", e["name"], e["note"])
    events = [e for e in events if not e["name"].startswith("NOT TRACED")]
    api_pid = next(e["pid"] for e in events if e["name"].startswith("HTTP handler"))
    roles = {pid: ("API server" if pid == api_pid else "engine core") for pid in {e["pid"] for e in events}}
    if len(roles) < 2:
        print("warning: only one process was traced; the engine core did not inherit the wrappers")
    reports = [report(events, first, roles, "request 1 (cold prefix)"),
               report(events, second, roles, "request 2 (same system prompt)")]
    (HERE / "vllm_trace.json").write_text(json.dumps(chrome_trace(
        events, roles, [("request 1 sent", first["t_send"]), ("request 2 sent", second["t_send"])])))
    (HERE / "inside_vllm_trace.json").write_text(json.dumps(
        {"model": a.model, "gpu": gpu_name(), "vllm": vllm_version(), "startup_s": server.startup_s,
         "startup_log": startup, "kv_blocks": metrics.get("num_gpu_blocks"), "block_size": metrics.get("block_size"),
         "requests": reports}, indent=1) + "\n")


# ---------------------------------------------------------------------------------------------------- knobs

def burst_requests(n: int, lo: int, hi: int, seed: int = 0) -> list[tuple[list[int], int]]:
    """The same requests as nano_engine/bench.py: random token ids, prompt and output lengths uniform in [lo, hi]."""
    rng = random.Random(seed)
    return [([rng.randrange(32000) for _ in range(rng.randint(lo, hi))], rng.randint(lo, hi)) for _ in range(n)]


def completion(model: str, prompt: list[int], max_tokens: int) -> dict:
    return {"model": model, "prompt": prompt, "max_tokens": max_tokens, "temperature": 0.6, "ignore_eos": True,
            "stream": True, "stream_options": {"include_usage": True}}


def summarize(results: list[dict], seconds: float) -> dict:
    ms = lambda ns: ns / 1e6
    out_tokens = sum(r["usage"]["completion_tokens"] for r in results)
    ttft = [ms(r["arrivals"][0] - r["t_send"]) for r in results]
    gaps = [ms(b - a) for r in results for a, b in zip(r["arrivals"], r["arrivals"][1:])]
    per_token = [ms(r["arrivals"][-1] - r["arrivals"][0]) / max(1, r["usage"]["completion_tokens"] - 1) for r in results]
    return {"seconds": round(seconds, 2), "output_tokens": out_tokens, "output_tok_s": round(out_tokens / seconds, 1),
            "ttft_ms_p50": round(pct(ttft, 0.5)), "ttft_ms_p99": round(pct(ttft, 0.99)),
            "ms_per_token_p50": round(pct(per_token, 0.5), 1),
            "chunk_gap_ms_p99": round(pct(gaps, 0.99), 1) if gaps else None,
            "chunk_gap_ms_max": round(max(gaps), 1) if gaps else None}


async def run_burst(a, server: Server) -> dict:
    reqs = burst_requests(a.num_seqs, 100, 1024)
    async with session() as s:
        await stream(s, "/v1/completions", completion(a.model, [1, 2, 3], 4))        # warm up
        before = server.metrics()
        t = time.perf_counter()
        results = await asyncio.gather(*(stream(s, "/v1/completions", completion(a.model, p, n)) for p, n in reqs))
        seconds = time.perf_counter() - t
    after = server.metrics()
    return {**summarize(results, seconds), "preemptions": int(after.get("num_preemptions", 0) - before.get("num_preemptions", 0))}


async def run_prefix(a, server: Server) -> dict:
    """64 requests that share a 3,000-token prefix and differ in their last 50 tokens. The first is sent alone, so
    its prefix is in the cache (if there is one) before the other 63 arrive together."""
    rng = random.Random(1)
    prefix = [rng.randrange(32000) for _ in range(3000)]
    prompts = [prefix + [rng.randrange(32000) for _ in range(50)] for _ in range(64)]
    async with session() as s:
        before = server.metrics()
        first = await stream(s, "/v1/completions", completion(a.model, prompts[0], 16))
        t = time.perf_counter()
        rest = await asyncio.gather(*(stream(s, "/v1/completions", completion(a.model, p, 16)) for p in prompts[1:]))
        seconds = time.perf_counter() - t
    after = server.metrics()
    delta = lambda k: int(after.get(k, 0) - before.get(k, 0))
    return {"first_request_ttft_ms": round((first["arrivals"][0] - first["t_send"]) / 1e6),
            "other_63": summarize(rest, seconds), "prefix_cache_queries_tokens": delta("prefix_cache_queries"),
            "prefix_cache_hits_tokens": delta("prefix_cache_hits")}


async def knobs(a) -> None:
    tight = ["--gpu-memory-utilization", str(a.tight_util)]
    configs = [("defaults", [], True), ("max_num_seqs=16", ["--max-num-seqs", "16"], False),
               ("max_num_seqs=64", ["--max-num-seqs", "64"], False),
               ("max_num_batched_tokens=1024", ["--max-num-batched-tokens", "1024"], False),
               ("max_num_batched_tokens=16384", ["--max-num-batched-tokens", "16384"], False),
               (f"gpu_memory_utilization={a.tight_util}", tight, False),
               (f"gpu_memory_utilization={a.tight_util}, max_num_seqs=64", [*tight, "--max-num-seqs", "64"], False),
               ("prefix caching off", ["--no-enable-prefix-caching"], True)]
    out = []
    for name, flags, with_prefix in configs:
        if a.only and not any(o in name for o in a.only.split(",")):
            continue
        with Server(a.model, flags) as server:
            m = server.metrics()
            row = {"config": name, "flags": flags, "startup_s": server.startup_s,
                   "kv_blocks": int(m.get("num_gpu_blocks", 0)), "block_size": int(m.get("block_size", 0)),
                   "kv_capacity_tokens": int(m.get("num_gpu_blocks", 0) * m.get("block_size", 0)),
                   "startup_log": server.log_lines(r"max_num_batched_tokens|maximum concurrency|kv cache")}
            if name != "prefix caching off":
                row["burst"] = await run_burst(a, server)
            if with_prefix:
                row["shared_prefix"] = await run_prefix(a, server)
        print(json.dumps({k: v for k, v in row.items() if k != "startup_log"}), flush=True)
        out.append(row)
        (HERE / "inside_vllm_knobs.json").write_text(json.dumps(
            {"model": a.model, "gpu": gpu_name(), "vllm": vllm_version(), "num_seqs": a.num_seqs, "configs": out},
            indent=1) + "\n")


def gpu_name() -> str:
    return subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True,
                          text=True).stdout.strip().splitlines()[0]


def vllm_version() -> str:
    from importlib.metadata import version
    return version("vllm")


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        return serve(sys.argv[2:])
    ap = argparse.ArgumentParser()
    ap.add_argument("experiment", choices=["trace", "knobs"])
    ap.add_argument("--quick", action="store_true", help="Llama 3.2 1B and 64 requests instead of Llama 3.1 8B and 256")
    ap.add_argument("--only", default="", help="knobs: comma-separated substrings of the configurations to run")
    ap.add_argument("--tight-util", type=float, help="the small gpu_memory_utilization (default 0.3, or 0.2 with --quick)")
    a = ap.parse_args()
    a.model = "unsloth/Llama-3.2-1B-Instruct" if a.quick else "unsloth/Meta-Llama-3.1-8B-Instruct"
    a.num_seqs = 64 if a.quick else 256
    a.tight_util = a.tight_util or (0.2 if a.quick else 0.3)
    print(f"{gpu_name()}, vLLM {vllm_version()}", flush=True)
    asyncio.run(trace(a) if a.experiment == "trace" else knobs(a))


if __name__ == "__main__":
    main()
