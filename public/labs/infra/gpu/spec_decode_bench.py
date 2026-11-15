# spec_decode_bench.py: chapter 5.4's GPU lab. One model, Llama 3.1 8B, served by vLLM 0.32.0 with speculative
# decoding off and with seven ways of drafting, on two workloads, from 1 request in flight to 128.
#
# configurations (each is one `vllm serve` with a different --speculative-config)
#   off              no speculation: the baseline every other row is divided by
#   ngram            prompt lookup: find the last 2 to 5 tokens earlier in the request and propose the 5 that followed
#   ngram gpu        the same lookup done on the GPU, which lets vLLM keep its asynchronous scheduling
#   suffix           suffix decoding (Arctic Inference): the same idea over this prompt and earlier responses
#   eagle3 k=3       a one-layer EAGLE-3 head that reads the target's hidden states, 3 draft tokens per step
#   eagle3 k=5       the same head asked for 5
#   draft 1B k=5     Llama 3.2 1B as a separate draft model, 5 tokens per step
#   eagle3 dynamic   the EAGLE-3 head with a draft length that depends on the batch size: 5, then 3, then 1
#   synthetic L      the EAGLE-3 head, but draft tokens are accepted by coin flips set to a mean acceptance
#                    length L, whatever the target thinks of them. L=1 accepts nothing, so it prices the overhead
#                    of speculating; L=4 accepts everything, so it is the ceiling for 3 draft tokens. The text
#                    these rows produce is not the target's, and only their timing is used.
# workloads (every prompt is different, so nothing is answered from the prefix cache)
#   chat             open questions, answers of up to 256 tokens
#   code             "return this file with one small change": the answer repeats most of the prompt
#   chat, T=1        the chat questions sampled at temperature 1 instead of greedily
#
# Each workload is run closed-loop at several concurrencies: N requests in flight until a fixed number have
# finished. Reported per run: output tokens per second for the whole server, the median decode speed of one request,
# and vLLM's own counters for drafts, drafted tokens and accepted tokens (from /metrics), from which come the mean
# acceptance length (tokens emitted per target pass) and the acceptance rate at each draft position.
#
#   modal run modal_run.py --script spec_decode_bench.py --gpu 'H100!' --vllm
#   modal run modal_run.py --script spec_decode_bench.py --gpu A10 --vllm --args "--quick"
#   python gcp_run.py --script spec_decode_bench.py --gpu L4 --vllm --args "--quick"
# Add --only 'off;eagle3 k=3' to run some configurations, and --tag NAME to choose the output file's name.
#
# Writes spec_decode_<gpu>.json (with --quick, spec_decode_<gpu>_quick.json), and spec_decode_traces.json, the token
# ids of 12 prompts and greedy answers per workload, which ../spec_decode_sim.py replays without a GPU.
import argparse
import asyncio
import json
import os
import random
import re
import signal
import subprocess
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
PORT = 8000
URL = f"http://127.0.0.1:{PORT}"
TARGET = "unsloth/Meta-Llama-3.1-8B-Instruct"
DRAFT = "unsloth/Llama-3.2-1B-Instruct"
EAGLE3 = "RedHatAI/Llama-3.1-8B-Instruct-speculator.eagle3"

TOPICS = ["a hash table", "a B-tree index", "TCP congestion control", "a write-ahead log", "garbage collection",
          "a bloom filter", "consistent hashing", "the Raft protocol", "virtual memory", "a load balancer",
          "public-key encryption", "a message queue", "database transactions", "a CPU cache", "DNS resolution",
          "a thread pool", "copy-on-write", "a rate limiter", "MapReduce", "a content delivery network",
          "optimistic locking", "an LRU cache", "a compiler's lexer", "two-phase commit"]
ANGLES = ["what problem it solves", "how it works, step by step", "its most common failure", "what it costs in memory",
          "what it costs in time", "when not to use it", "how to test it", "how to monitor it in production",
          "a mistake beginners make with it", "the history of the idea", "how it behaves under heavy load",
          "what to use in its place", "how to explain it to a manager", "one real system that uses it",
          "its hardest edge case", "how to size it"]
READERS = ["a new engineer", "a student", "an interviewer", "an operations team"]
NOUNS = ["order", "invoice", "shipment", "account", "sensor", "ticket", "session", "payment", "booking", "device",
         "report", "batch"]
FIELDS = ["price", "quantity", "weight", "discount", "balance", "score", "latency", "distance", "duration", "rating",
          "volume", "height"]


# ------------------------------------------------------------------------------------------------ the workloads

def chat_prompt(i: int) -> str:
    topic, angle = TOPICS[i % len(TOPICS)], ANGLES[(i // len(TOPICS)) % len(ANGLES)]
    reader = READERS[(i // (len(TOPICS) * len(ANGLES))) % len(READERS)]
    return f"Write about 200 words for {reader} on {topic}: {angle}. Write plain paragraphs without headings or lists."


def code_prompt(i: int) -> str:
    """A small Python file, different for every i, and a request for the same file with one change."""
    rng = random.Random(5000 + i)
    noun = rng.choice(NOUNS)
    a, b, c, d = rng.sample(FIELDS, 4)
    low, high = rng.randrange(1, 9), rng.randrange(20, 900)
    src = f'''class {noun.title()}Store:
    """Keeps {noun} records in memory and answers simple questions about them."""

    def __init__(self):
        self.records = []
        self.next_id = {rng.randrange(1, 500)}

    def add(self, {a}, {b}, {c}, {d}):
        record = {{"id": self.next_id, "{a}": {a}, "{b}": {b}, "{c}": {c}, "{d}": {d}}}
        self.records.append(record)
        self.next_id += 1
        return record["id"]

    def find(self, record_id):
        for record in self.records:
            if record["id"] == record_id:
                return record
        return None

    def total_{a}(self):
        total = 0
        for record in self.records:
            total += record["{a}"]
        return total

    def average_{b}(self):
        if not self.records:
            return 0.0
        return sum(record["{b}"] for record in self.records) / len(self.records)

    def filter_by_{c}(self, lowest={low}, highest={high}):
        matches = []
        for record in self.records:
            if lowest <= record["{c}"] <= highest:
                matches.append(record)
        return matches

    def largest_{d}(self):
        best = None
        for record in self.records:
            if best is None or record["{d}"] > best["{d}"]:
                best = record
        return best
'''
    change = rng.choice([
        f"Rename the method total_{a} to sum_{a}.",
        f"Make add raise ValueError when {b} is negative.",
        f"Change the default of lowest in filter_by_{c} to {low + 1}.",
        f"Add a method count that returns the number of records.",
        f"Make find raise KeyError when no record has the id, and never return None.",
    ])
    return (f"Here is a Python file.\n\n```python\n{src}```\n\n{change} Return the complete updated file in one "
            f"Python code block, with no explanation before or after it.")


WORKLOADS = {
    "chat": {"prompt": chat_prompt, "max_tokens": 256, "temperature": 0.0},
    "code": {"prompt": code_prompt, "max_tokens": 512, "temperature": 0.0},
    "chat_t1": {"prompt": chat_prompt, "max_tokens": 256, "temperature": 1.0},
}


# --------------------------------------------------------------------------------------------------- the server

class Server:
    """`vllm serve` in a child process, with its log in a file."""

    def __init__(self, model: str, spec: dict | None, context: int):
        self.log = Path(f"/tmp/vllm_server_{int(time.time() * 1000)}.log")
        cmd = ["vllm", "serve", model, "--port", str(PORT), "--max-model-len", str(context)]
        if spec:
            cmd += ["--speculative-config", json.dumps(spec)]
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
        time.sleep(5)                           # let the driver release the GPU's memory

    def log_lines(self, pattern: str, limit: int = 12) -> list[str]:
        out = []
        for line in self.log.read_text(errors="replace").splitlines():
            if re.search(pattern, line, re.I) and "it/s]" not in line and "non-default args" not in line:
                out.append(re.sub(r"\x1b\[[0-9;]*m", "", line)[:300])
        return out[-limit:]

    def metrics(self) -> dict:
        """vLLM's Prometheus counters. The speculative ones are spec_decode_num_drafts (target passes that verified
        a draft), spec_decode_num_draft_tokens, spec_decode_num_accepted_tokens, and the accepted count at each
        draft position."""
        text = urllib.request.urlopen(f"{URL}/metrics", timeout=10).read().decode()
        out: dict = {"per_pos": {}}
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
            elif name == "spec_decode_num_accepted_tokens_per_pos":
                pos = int(re.search(r'position="(\d+)"', labels).group(1))
                out["per_pos"][pos] = out["per_pos"].get(pos, 0.0) + float(value)
            elif not name.endswith(("_bucket", "_created")):
                out[name] = out.get(name, 0.0) + float(value)
        return out

    def pool_tokens(self) -> int:
        m = self.metrics()
        return int(m.get("num_gpu_blocks", 0) * m.get("block_size", 0))


def spec_delta(before: dict, after: dict) -> dict:
    """What the speculative counters say happened between two readings of /metrics."""
    d = {k: after.get(f"spec_decode_num_{k}", 0.0) - before.get(f"spec_decode_num_{k}", 0.0)
         for k in ("drafts", "draft_tokens", "accepted_tokens")}
    if not d["drafts"]:
        return {}
    per_pos = [after["per_pos"].get(p, 0.0) - before["per_pos"].get(p, 0.0) for p in sorted(after["per_pos"])]
    return {"drafts": int(d["drafts"]), "draft_tokens": int(d["draft_tokens"]), "accepted_tokens": int(d["accepted_tokens"]),
            "mean_acceptance_length": round(1 + d["accepted_tokens"] / d["drafts"], 3),
            "draft_acceptance_rate": round(d["accepted_tokens"] / max(d["draft_tokens"], 1), 4),
            "draft_tokens_per_draft": round(d["draft_tokens"] / d["drafts"], 3),
            # the share of target passes whose first i+1 draft tokens were all accepted
            "accepted_through_position": [round(x / d["drafts"], 4) for x in per_pos]}


# --------------------------------------------------------------------------------------------------- the client

async def stream(session, body: dict) -> dict:
    """Send one streamed chat request. Returns the time to the first chunk with text, the text, and the usage."""
    t_send = time.perf_counter()
    first, usage, text = None, None, []
    async with session.post(f"{URL}/v1/chat/completions",
                            json={**body, "stream": True, "stream_options": {"include_usage": True}}) as resp:
        if resp.status != 200:
            raise RuntimeError(f"{resp.status}: {(await resp.text())[:300]}")
        async for raw in resp.content:
            if not raw.startswith(b"data: ") or raw.startswith(b"data: [DONE]"):
                continue
            chunk = json.loads(raw[6:])
            usage = chunk.get("usage") or usage
            for choice in chunk.get("choices") or []:
                piece = (choice.get("delta") or {}).get("content") or ""
                if piece and first is None:
                    first = time.perf_counter()
                text.append(piece)
    done = time.perf_counter()
    first = first or done
    n = usage["completion_tokens"]
    return {"ttft_ms": (first - t_send) * 1e3, "total_s": done - t_send, "text": "".join(text), "completion_tokens": n,
            "prompt_tokens": usage["prompt_tokens"],
            # the decode speed this one request saw, after its first token
            "decode_tok_s": (n - 1) / (done - first) if n > 1 and done > first else 0.0}


def session():
    import aiohttp
    return aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=0), timeout=aiohttp.ClientTimeout(total=1800))


def pct(values: list[float], q: float) -> float:
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))]


async def run_level(server: Server, workload: str, concurrency: int, requests: int, offset: int) -> tuple[dict, list[str]]:
    """Closed loop: `concurrency` requests in flight until `requests` have finished. Prompts offset..offset+requests
    of the workload are used, so no two runs against one server send the same prompt."""
    w = WORKLOADS[workload]
    gate = asyncio.Semaphore(concurrency)

    async def one(s, i: int) -> dict:
        async with gate:
            return await stream(s, {"model": TARGET, "messages": [{"role": "user", "content": w["prompt"](offset + i)}],
                                    "max_tokens": w["max_tokens"], "temperature": w["temperature"], "seed": offset + i})

    before = server.metrics()
    async with session() as s:
        t = time.perf_counter()
        rows = await asyncio.gather(*(one(s, i) for i in range(requests)))
        seconds = time.perf_counter() - t
    await asyncio.sleep(1.5)                    # the counters reach /metrics a moment after the last token
    out_tokens = sum(r["completion_tokens"] for r in rows)
    result = {"workload": workload, "concurrency": concurrency, "requests": requests, "seconds": round(seconds, 2),
              "output_tokens": out_tokens, "output_tok_s": round(out_tokens / seconds, 1),
              "prompt_tokens_p50": round(pct([r["prompt_tokens"] for r in rows], 0.5)),
              "completion_tokens_p50": round(pct([r["completion_tokens"] for r in rows], 0.5)),
              "request_decode_tok_s_p50": round(pct([r["decode_tok_s"] for r in rows], 0.5), 1),
              "ttft_ms_p50": round(pct([r["ttft_ms"] for r in rows], 0.5), 1),
              "spec": spec_delta(before, server.metrics())}
    return result, [r["text"] for r in rows]


async def collect_traces(count: int = 12) -> dict:
    """The token ids of some prompts and of the target's greedy answers to them, for spec_decode_sim.py, which
    replays them through its own prompt-lookup proposer without a GPU."""
    traces: dict[str, list[dict]] = {}
    async with session() as s:
        for name in ("chat", "code"):
            w = WORKLOADS[name]
            traces[name] = []
            for i in range(count):
                body = {"model": TARGET, "messages": [{"role": "user", "content": w["prompt"](i)}],
                        "max_tokens": w["max_tokens"], "temperature": 0, "return_token_ids": True}
                async with s.post(f"{URL}/v1/chat/completions", json=body) as resp:
                    data = await resp.json()
                traces[name].append({"prompt": data["prompt_token_ids"], "output": data["choices"][0]["token_ids"]})
    return traces


async def warm_up() -> None:
    """One request of each kind, so kernels compiled on first use are not charged to the first measurement."""
    async with session() as s:
        for name in ("chat", "code", "chat_t1"):
            w = WORKLOADS[name]
            await stream(s, {"model": TARGET, "messages": [{"role": "user", "content": w["prompt"](9000)}],
                             "max_tokens": 48, "temperature": w["temperature"]})


# -------------------------------------------------------------------------------------------------------- main

def shared_prefix(a: str, b: str) -> int:
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n


def gpu_name() -> str:
    return subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True,
                          text=True).stdout.strip().splitlines()[0]


def configurations() -> list[tuple[str, dict | None, list[str]]]:
    eagle = {"method": "eagle3", "model": EAGLE3}
    real = ["chat", "code", "chat_t1"]
    configs = [
        ("off", None, real),
        ("ngram", {"method": "ngram", "num_speculative_tokens": 5, "prompt_lookup_min": 2, "prompt_lookup_max": 5}, real),
        ("ngram gpu", {"method": "ngram_gpu", "num_speculative_tokens": 5, "prompt_lookup_min": 2, "prompt_lookup_max": 5}, real),
        ("suffix", {"method": "suffix", "num_speculative_tokens": 16}, real),
        ("eagle3 k=3", {**eagle, "num_speculative_tokens": 3}, real),
        ("eagle3 k=5", {**eagle, "num_speculative_tokens": 5}, real),
        ("draft 1B k=5", {"method": "draft_model", "model": DRAFT, "num_speculative_tokens": 5}, real),
        # the draft length follows the number of requests in the step: 5 up to 16, 3 up to 64, 1 above that
        ("eagle3 dynamic", {**eagle, "num_speculative_tokens": 5,
                            "num_speculative_tokens_per_batch_size": [[1, 16, 5], [17, 64, 3], [65, 1024, 1]]}, real),
    ]
    for length in (1.0, 2.5, 4.0):
        configs.append((f"synthetic {length}", {**eagle, "num_speculative_tokens": 3, "rejection_sample_method": "synthetic",
                                                "synthetic_acceptance_length": length}, ["chat"]))
    return configs


async def bench(a) -> None:
    from importlib.metadata import version
    levels = [(1, 4), (16, 32)] if a.quick else [(1, 6), (8, 16), (32, 64), (128, 256)]
    t1_levels = [(1, 4)] if a.quick else [(1, 6), (32, 64)]
    tag = a.tag or gpu_name().replace("NVIDIA", "").split()[0].lower()      # "NVIDIA H100 80GB HBM3" becomes "h100"
    name = f"spec_decode_{tag}{'_quick' if a.quick else ''}.json"
    out = {"vllm": version("vllm"), "target": TARGET, "gpu": gpu_name(), "configs": []}
    reference: dict[str, list[str]] = {}        # the baseline's answers at concurrency 1, to compare the others with
    for label, spec, workloads in configurations():
        if a.only and label not in a.only.split(";"):
            continue
        row = {"config": label, "speculative_config": spec, "runs": []}
        try:
            with Server(TARGET, spec, a.context) as server:
                row.update(startup_s=server.startup_s, kv_pool_tokens=server.pool_tokens())
                await warm_up()
                for w in workloads:
                    offset = 400 if w == "chat_t1" else 0       # the sampled runs get questions of their own
                    for concurrency, requests in (t1_levels if w == "chat_t1" else levels):
                        result, texts = await run_level(server, w, concurrency, requests, offset)
                        offset += requests
                        if concurrency == 1 and WORKLOADS[w]["temperature"] == 0:
                            if label == "off":
                                reference[w] = texts
                            elif w in reference and not label.startswith("synthetic"):
                                result["answers_identical_to_off"] = sum(x == y for x, y in zip(texts, reference[w]))
                                # how far into each answer, as a share of its characters, the two runs agree
                                result["answers_shared_prefix"] = [round(shared_prefix(x, y) / max(len(y), 1), 3)
                                                                   for x, y in zip(texts, reference[w])]
                        row["runs"].append(result)
                        print(json.dumps({"config": label, **result}), flush=True)
                if label == "off" and not a.only:
                    try:
                        traces = await collect_traces(4 if a.quick else 12)
                        (HERE / f"spec_decode_traces{'_quick' if a.quick else ''}.json").write_text(json.dumps(
                            {"target": TARGET, "note": "token ids of prompts and of the target's greedy answers", **traces}) + "\n")
                    except Exception as e:      # the traces are an extra; the measurements above are kept
                        print(f"traces not collected: {type(e).__name__}: {e}", flush=True)
                row["server_log"] = server.log_lines(r"SpecDecoding metrics|speculative|draft|eagle|ngram|suffix")
        except Exception as e:                  # a configuration that fails keeps the runs it finished
            row["error"] = f"{type(e).__name__}: {e}"[:500]
            print(f"{label}: {e}", flush=True)
        out["configs"].append(row)
        (HERE / name).write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="fewer requests, and concurrency 1 and 16 only")
    ap.add_argument("--only", default="", help="configurations to run, separated by semicolons, such as 'off;ngram'")
    ap.add_argument("--tag", default="", help="name for the output file; the default comes from the GPU's name")
    ap.add_argument("--context", type=int, default=8192, help="the server's --max-model-len")
    a = ap.parse_args()
    from importlib.metadata import version
    print(f"{gpu_name()}, vllm {version('vllm')}", flush=True)
    asyncio.run(bench(a))


if __name__ == "__main__":
    main()
