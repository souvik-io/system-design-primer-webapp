# sampling_bench.py: chapter 5.5's GPU lab. What sampling settings and structured output cost on a GPU, in three
# parts, with Llama 3.1 8B served by vLLM 0.32.0.
#
#   kernels     the sampling steps on random logits of Llama 3's vocabulary (128,256), timed with CUDA events at
#               batch sizes 1 to 512: argmax, a categorical draw three ways, min-p, top-k and top-p by sorting, vLLM's
#               own top-k/top-p kernel (Triton), FlashInfer's sorting-free top-k/top-p sampler, and xgrammar's
#               bitmask applied to the logits
#   sampling    one `vllm serve` with the model's generation_config.json ignored (--generation-config vllm); the same
#               chat workload with seven sampling settings, every answer 256 tokens long (ignore_eos), at 1, 64 and
#               256 requests in flight; output tokens per second for the server
#   structured  one `vllm serve` per structured-output backend (xgrammar, guidance, outlines). An order-extraction
#               workload, as in ../structured_bench.py, in four modes: no constraint, any JSON object, one schema
#               shared by every request, and a schema of its own for every request (so every request compiles a
#               grammar); at 1, 64 and 256 requests in flight. Throughput, time to first token, time per output
#               token, and how many answers parse, match the schema and have the right values. Plus the first
#               request with a new schema against a repeat of it, on an idle server.
#
#   modal run modal_run.py --script sampling_bench.py --gpu 'H100!' --vllm
#   modal run modal_run.py --script sampling_bench.py --gpu A10 --vllm --args "--quick"
#   python gcp_run.py --script sampling_bench.py --gpu L4 --vllm --args "--quick" --max-hours 2   (the image build on a
#       fresh VM takes about 20 minutes, and the default --max-hours 1 deletes the VM before the run ends)
# --parts kernels,sampling,structured chooses parts; --quick uses fewer requests and concurrency 1 and 32;
# --settings 'greedy;T=1' runs some of the sampling settings.
# The vLLM function in modal_run.py reserves 4 CPU cores; grammar masks are computed on the CPU, so this matters.
#
# Writes sampling_bench_<gpu>.json (with --quick, sampling_bench_<gpu>_quick.json).
import argparse
import asyncio
import json
import os
import random
import re
import signal
import statistics
import subprocess
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
PORT = 8000
URL = f"http://127.0.0.1:{PORT}"
MODEL = "unsloth/Meta-Llama-3.1-8B-Instruct"

# ------------------------------------------------------------------------------------------------ workloads

TOPICS = ["a hash table", "a B-tree index", "TCP congestion control", "a write-ahead log", "garbage collection",
          "a bloom filter", "consistent hashing", "the Raft protocol", "virtual memory", "a load balancer",
          "public-key encryption", "a message queue", "database transactions", "a CPU cache", "DNS resolution",
          "a thread pool"]
ANGLES = ["what problem it solves", "how it works, step by step", "its most common failure", "what it costs",
          "when not to use it", "how to test it", "how it behaves under load", "a mistake beginners make with it"]


def chat_prompt(i: int) -> str:
    return (f"Write about 200 words on {TOPICS[i % len(TOPICS)]}: {ANGLES[(i // len(TOPICS)) % len(ANGLES)]}. "
            f"Write plain paragraphs. (Request {i}.)")


ORDER_SCHEMA = {
    "type": "object",
    "properties": {
        "customer": {"type": "string"},
        "email": {"type": "string"},
        "items": {"type": "array", "minItems": 1, "items": {
            "type": "object",
            "properties": {"product": {"type": "string"}, "quantity": {"type": "integer"},
                           "unit_price": {"type": "number"}},
            "required": ["product", "quantity", "unit_price"], "additionalProperties": False}},
        "express": {"type": "boolean"},
    },
    "required": ["customer", "email", "items", "express"],
    "additionalProperties": False,
}
FIRST = ["Dana", "Kwame", "Sofia", "Hiro", "Amara", "Lukas", "Priya", "Mateo", "Ingrid", "Tunde", "Chloe", "Ravi"]
LAST = ["Whitfield", "Mensah", "Rossi", "Tanaka", "Okafor", "Berg", "Nair", "Silva", "Holm", "Adeyemi", "Moreau", "Iyer"]
PRODUCTS = ["notebook", "pen", "stapler", "desk lamp", "mouse pad", "folder", "marker", "ruler", "calculator", "tape"]


def order(i: int) -> tuple[str, dict]:
    """The same generator as ../structured_bench.py: a paragraph describing an order, and the right answer."""
    rng = random.Random(i)
    first, last = rng.choice(FIRST), rng.choice(LAST)
    items = [{"product": p, "quantity": rng.randint(1, 9), "unit_price": round(rng.randint(50, 4000) / 100, 2)}
             for p in rng.sample(PRODUCTS, rng.choice([1, 2, 2, 3]))]
    express = rng.random() < 0.5
    email = f"{first.lower()}.{last.lower()}@example.com"
    listed = " and ".join(f"{it['quantity']} {it['product']}{'s' if it['quantity'] > 1 else ''} at "
                          f"${it['unit_price']:.2f} each" for it in items)
    text = (f"Hello, this is {first} {last} ({email}). Please send me {listed}. "
            + ("I need it quickly, so please use express shipping." if express else "Standard shipping is fine."))
    return text, {"customer": f"{first} {last}", "email": email, "items": items, "express": express}


def order_messages(text: str) -> list[dict]:
    ask = ("Read the order below and return it as JSON with the keys customer, email, items (a list of objects with "
           "product, quantity and unit_price) and express (true or false). Return only the JSON.\n\nOrder: " + text)
    return [{"role": "user", "content": ask}]


def matches_schema(x) -> bool:
    if not isinstance(x, dict) or set(x) != {"customer", "email", "items", "express"}:
        return False
    if not (isinstance(x["customer"], str) and isinstance(x["email"], str) and isinstance(x["express"], bool)):
        return False
    if not isinstance(x["items"], list) or not x["items"]:
        return False
    return all(isinstance(it, dict) and set(it) == {"product", "quantity", "unit_price"} and isinstance(it["product"], str)
               and type(it["quantity"]) is int and type(it["unit_price"]) in (int, float) for it in x["items"])


def score(text: str, truth: dict) -> dict:
    body = text.strip()
    if body.startswith("```"):
        body = body.strip("`").removeprefix("json").strip()
    try:
        x = json.loads(body)
    except json.JSONDecodeError:
        return {"parses": False, "schema": False, "fields": 0.0}
    if not matches_schema(x):
        return {"parses": True, "schema": False, "fields": 0.0}
    norm = lambda items: sorted((i["product"].strip().lower().rstrip("s"), i["quantity"], round(float(i["unit_price"]), 2))
                                for i in items)
    right = [x["customer"] == truth["customer"], x["email"] == truth["email"],
             norm(x["items"]) == norm(truth["items"]), x["express"] == truth["express"]]
    return {"parses": True, "schema": True, "fields": sum(right) / 4}


# --------------------------------------------------------------------------------------------- 1. kernels

def gpu_name() -> str:
    return subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True,
                          text=True).stdout.strip().splitlines()[0]


def kernels(quick: bool) -> list[dict]:
    import flashinfer
    import torch
    import xgrammar as xgr
    from vllm.v1.sample.ops.topk_topp_sampler import apply_top_k_top_p

    vocab, dev = 128256, "cuda"
    out = []

    def timed(fn, repeat=50) -> float:
        for _ in range(3):
            fn()
        start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
        times = []
        for _ in range(repeat):
            start.record()
            fn()
            end.record()
            torch.cuda.synchronize()
            times.append(start.elapsed_time(end))
        return round(1e3 * statistics.median(times), 1)            # microseconds

    def sort_top_p(logits, p):
        sorted_logits, order = logits.sort(dim=-1, descending=True)
        sorted_p = sorted_logits.softmax(-1)
        drop = (sorted_p.cumsum(-1) - sorted_p) >= p[:, None]
        return torch.empty_like(logits).scatter_(-1, order, sorted_logits.masked_fill(drop, float("-inf")))

    def topk_mask(logits, k):
        kth = logits.topk(k, dim=-1).values[:, -1:]
        return logits.masked_fill(logits < kth, float("-inf"))

    def min_p_mask(logits, m):
        probs = logits.softmax(-1)
        return logits.masked_fill(probs < m * probs.max(-1, keepdim=True).values, float("-inf"))

    for batch in ((1, 64) if quick else (1, 8, 64, 256, 512)):
        torch.manual_seed(0)
        logits = torch.randn(batch, vocab, device=dev) * 3
        k = torch.full((batch,), 50, device=dev, dtype=torch.int32)
        p = torch.full((batch,), 0.9, device=dev)
        bitmask = torch.randint(-2**31, 2**31 - 1, (batch, (vocab + 31) // 32), dtype=torch.int32, device=dev)
        row = {"batch": batch, "us": {
            "argmax (greedy)": timed(lambda: logits.argmax(-1)),
            "softmax + torch.multinomial": timed(lambda: torch.multinomial(logits.softmax(-1), 1)),
            "softmax + exponential race": timed(lambda: (logits.softmax(-1) / torch.empty_like(logits).exponential_()).argmax(-1)),
            "Gumbel-max": timed(lambda: (logits - torch.empty_like(logits).exponential_().log()).argmax(-1)),
            "min-p 0.1 mask": timed(lambda: min_p_mask(logits, 0.1)),
            "top-k 50 mask (torch.topk)": timed(lambda: topk_mask(logits, 50)),
            "top-p 0.9 mask (full sort)": timed(lambda: sort_top_p(logits, p)),
            "top-p 0.9 mask (vLLM Triton)": timed(lambda: apply_top_k_top_p(logits.clone(), None, p)),
            "top-k 50 + top-p 0.9 mask (vLLM Triton)": timed(lambda: apply_top_k_top_p(logits.clone(), k, p)),
            "top-p 0.9 sample (FlashInfer)": timed(lambda: flashinfer.sampling.top_p_sampling_from_probs(
                logits.softmax(-1), p, deterministic=True)),
            "top-k 50 + top-p 0.9 sample (FlashInfer)": timed(lambda: flashinfer.sampling.top_k_top_p_sampling_from_logits(
                logits, k, p, deterministic=True)),
            "clone of the logits (for scale)": timed(lambda: logits.clone()),
            "grammar bitmask applied (xgrammar)": timed(lambda: xgr.apply_token_bitmask_inplace(logits.clone(), bitmask)),
        }}
        out.append(row)
        print(json.dumps(row), flush=True)
        del logits
    return out


# ---------------------------------------------------------------------------------------------- the server

class Server:
    """`vllm serve` in a child process, with its log in a file."""

    def __init__(self, extra: list[str]):
        self.log = Path(f"/tmp/vllm_server_{int(time.time() * 1000)}.log")
        cmd = ["vllm", "serve", MODEL, "--port", str(PORT), "--max-model-len", "4096", "--generation-config", "vllm",
               *extra]
        print("\n$", " ".join(cmd), flush=True)
        self.started = time.time()
        self.proc = subprocess.Popen(cmd, stdout=self.log.open("w"), stderr=subprocess.STDOUT, start_new_session=True)

    def __enter__(self):
        while True:
            if self.proc.poll() is not None or time.time() - self.started > 1500:
                print(self.log.read_text(errors="replace")[-8000:])
                raise RuntimeError("the vLLM server did not start")
            try:
                urllib.request.urlopen(f"{URL}/health", timeout=2)
                break
            except Exception:
                time.sleep(2)
        self.startup_s = round(time.time() - self.started, 1)
        print(f"server ready after {self.startup_s} s", flush=True)
        return self

    def __exit__(self, *exc):
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
            self.proc.wait(60)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        time.sleep(5)

    def log_lines(self, pattern: str, limit: int = 12) -> list[str]:
        out = []
        for line in self.log.read_text(errors="replace").splitlines():
            if re.search(pattern, line, re.I) and "it/s]" not in line:
                out.append(re.sub(r"\x1b\[[0-9;]*m", "", line)[:400])
        return out[-limit:]


def session():
    import aiohttp
    return aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=0), timeout=aiohttp.ClientTimeout(total=1800))


async def stream(s, body: dict) -> dict:
    t_send = time.perf_counter()
    first, usage, text = None, None, []
    async with s.post(f"{URL}/v1/chat/completions",
                      json={"model": MODEL, **body, "stream": True, "stream_options": {"include_usage": True}}) as resp:
        if resp.status != 200:
            return {"error": f"{resp.status}: {(await resp.text())[:300]}"}
        async for raw in resp.content:
            if not raw.startswith(b"data: ") or raw.startswith(b"data: [DONE]"):
                continue
            chunk = json.loads(raw[6:])
            if "error" in chunk:
                return {"error": str(chunk["error"])[:300]}
            usage = chunk.get("usage") or usage
            for choice in chunk.get("choices") or []:
                piece = (choice.get("delta") or {}).get("content") or ""
                if piece and first is None:
                    first = time.perf_counter()
                text.append(piece)
    done = time.perf_counter()
    first = first or done
    n = usage["completion_tokens"] if usage else 0
    return {"ttft_ms": (first - t_send) * 1e3, "total_s": done - t_send, "text": "".join(text), "completion_tokens": n,
            "tpot_ms": 1e3 * (done - first) / (n - 1) if n > 1 else 0.0}


def pct(values: list[float], q: float) -> float:
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))] if values else 0.0


async def closed_loop(bodies: list[dict], concurrency: int) -> tuple[list[dict], float]:
    gate = asyncio.Semaphore(concurrency)

    async def one(s, body):
        async with gate:
            return await stream(s, body)

    async with session() as s:
        t = time.perf_counter()
        rows = await asyncio.gather(*(one(s, b) for b in bodies))
        return rows, time.perf_counter() - t


def summary(rows: list[dict], seconds: float) -> dict:
    ok = [r for r in rows if "error" not in r]
    tokens = sum(r["completion_tokens"] for r in ok)
    return {"requests": len(rows), "errors": len(rows) - len(ok), "seconds": round(seconds, 2), "output_tokens": tokens,
            "output_tok_s": round(tokens / seconds, 1), "ttft_ms_p50": round(pct([r["ttft_ms"] for r in ok], 0.5), 1),
            "ttft_ms_p99": round(pct([r["ttft_ms"] for r in ok], 0.99), 1),
            "tpot_ms_p50": round(pct([r["tpot_ms"] for r in ok], 0.5), 2),
            "first_error": next((r["error"] for r in rows if "error" in r), None)}


# --------------------------------------------------------------------------------------------- 2. sampling

SAMPLING = {
    "greedy": {"temperature": 0},
    "T=1": {"temperature": 1.0},
    "T=1, top-p 0.9": {"temperature": 1.0, "top_p": 0.9},
    "T=1, top-k 50": {"temperature": 1.0, "top_k": 50},
    "T=1, top-k 50, top-p 0.9": {"temperature": 1.0, "top_k": 50, "top_p": 0.9},
    "T=1, min-p 0.1": {"temperature": 1.0, "min_p": 0.1},
    "T=1, top-p 0.9, seeded": {"temperature": 1.0, "top_p": 0.9, "seed": 1},       # a seed per request
    # The same again on the same server: the first seeded requests paid a one-time cost (see the chapter).
    "T=1, top-p 0.9, seeded, again": {"temperature": 1.0, "top_p": 0.9, "seed": 1},
    "T=1, penalties": {"temperature": 1.0, "repetition_penalty": 1.1, "frequency_penalty": 0.5, "presence_penalty": 0.5},
}


async def sampling_part(quick: bool, only: str) -> dict:
    levels = [(1, 3), (32, 64)] if quick else [(1, 4), (64, 128), (256, 512)]
    out = {"runs": []}
    with Server([]) as server:
        out["startup_s"] = server.startup_s
        await closed_loop([{"messages": [{"role": "user", "content": chat_prompt(9000)}], "max_tokens": 32}], 1)
        offset = 0
        for name, params in SAMPLING.items():
            if only and name not in only.split(";"):
                continue
            for concurrency, n in levels:
                bodies = [{"messages": [{"role": "user", "content": chat_prompt(offset + i)}], "max_tokens": 256,
                           "ignore_eos": True, **params, **({"seed": offset + i} if "seed" in params else {})}
                          for i in range(n)]
                offset += n
                rows, seconds = await closed_loop(bodies, concurrency)
                result = {"setting": name, "params": params, "concurrency": concurrency, **summary(rows, seconds)}
                out["runs"].append(result)
                print(json.dumps(result), flush=True)
        out["server_log"] = server.log_lines(r"sampl|flashinfer|generation config|top-p|top-k")
    return out


# ------------------------------------------------------------------------------------------- 3. structured

def order_body(i: int, mode: str) -> dict:
    text, _ = order(i)
    body = {"messages": order_messages(text), "max_tokens": 200, "temperature": 0}
    if mode == "json_object":
        body["response_format"] = {"type": "json_object"}
    elif mode == "schema":
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "order", "schema": ORDER_SCHEMA}}
    elif mode == "schema, new per request":
        # The same constraint, but a different schema text, so the server cannot reuse a compiled grammar.
        schema = {**ORDER_SCHEMA, "title": f"Order {i}"}
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": f"order_{i}", "schema": schema}}
    return body


async def first_vs_repeat(tag: str) -> dict:
    """On an idle server: the first request with a schema it has not seen, then the same request again."""
    schema = {**ORDER_SCHEMA, "title": f"Cold {tag}"}
    body = {**order_body(70000, "none"), "max_tokens": 1,
            "response_format": {"type": "json_schema", "json_schema": {"name": "cold", "schema": schema}}}
    out = {}
    for name in ("first", "repeat"):
        rows, _ = await closed_loop([body], 1)
        out[f"{name}_ttft_ms"] = round(rows[0].get("ttft_ms", -1), 1)
    return out


async def structured_part(quick: bool) -> dict:
    levels = [(1, 6), (32, 64)] if quick else [(1, 8), (64, 128), (256, 256)]
    out = {"backends": []}
    for backend in ("xgrammar", "guidance", "outlines"):
        row = {"backend": backend, "runs": []}
        try:
            with Server(["--structured-outputs-config", json.dumps({"backend": backend})]) as server:
                row["startup_s"] = server.startup_s
                await closed_loop([order_body(99000, "none")], 1)
                row["cold_schema"] = await first_vs_repeat(backend)
                offset = 1000
                modes = ["none", "json_object", "schema", "schema, new per request"] if backend == "xgrammar" else \
                        ["schema", "schema, new per request"]
                for mode in modes:
                    for concurrency, n in levels:
                        if mode == "schema, new per request" and backend != "xgrammar":
                            n = min(n, 64)      # compiles can take seconds on these backends; keep the run bounded
                        ids = list(range(offset, offset + n))
                        offset += n
                        rows, seconds = await closed_loop([order_body(i, mode) for i in ids], concurrency)
                        scores = [score(r.get("text", ""), order(i)[1]) for r, i in zip(rows, ids)]
                        result = {"backend": backend, "mode": mode, "concurrency": concurrency, **summary(rows, seconds),
                                  "parses": sum(s["parses"] for s in scores), "schema": sum(s["schema"] for s in scores),
                                  "fields_right_pct": round(100 * statistics.mean(s["fields"] for s in scores), 1),
                                  "example": rows[0].get("text", rows[0].get("error", ""))[:300]}
                        row["runs"].append(result)
                        print(json.dumps(result), flush=True)
                row["server_log"] = server.log_lines(r"structured|grammar|xgrammar|guidance|outlines")
        except Exception as e:
            row["error"] = f"{type(e).__name__}: {e}"[:500]
            print(f"{backend}: {e}", flush=True)
        out["backends"].append(row)
    return out


# -------------------------------------------------------------------------------------------------- main

async def bench(a) -> None:
    from importlib.metadata import version
    tag = a.tag or gpu_name().replace("NVIDIA", "").split()[0].lower()
    name = f"sampling_bench_{tag}{'_quick' if a.quick else ''}.json"
    out = {"vllm": version("vllm"), "xgrammar": version("xgrammar"), "flashinfer": version("flashinfer-python"),
           "model": MODEL, "gpu": gpu_name(), "cpus": os.cpu_count()}
    parts = a.parts.split(",")
    if "kernels" in parts:
        out["kernels"] = kernels(a.quick)
        (HERE / name).write_text(json.dumps(out, indent=1) + "\n")
    if "sampling" in parts:
        out["sampling"] = await sampling_part(a.quick, a.settings)
        (HERE / name).write_text(json.dumps(out, indent=1) + "\n")
    if "structured" in parts:
        out["structured"] = await structured_part(a.quick)
        (HERE / name).write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="fewer requests, concurrency 1 and 32")
    ap.add_argument("--parts", default="kernels,sampling,structured")
    ap.add_argument("--tag", default="", help="name for the output file; the default comes from the GPU's name")
    ap.add_argument("--settings", default="", help="sampling part: settings to run, separated by semicolons")
    a = ap.parse_args()
    print(f"{gpu_name()}", flush=True)
    asyncio.run(bench(a))


if __name__ == "__main__":
    main()
