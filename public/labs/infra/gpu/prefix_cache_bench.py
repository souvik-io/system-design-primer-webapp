# prefix_cache_bench.py: chapter 5.3's GPU lab. The same two workloads against vLLM 0.32.0 and SGLang 0.5.23, with
# and without their prefix caches. One run tests one engine, because the two pin different PyTorch versions and
# live in different images.
#
# chat    48 conversations of 6 turns through /v1/chat/completions. Every conversation starts with the same system
#         prompt of about 2,000 tokens, and every turn resends the whole history, as chat clients do. A user "thinks"
#         for 1 to 4 seconds between turns, so most conversations are idle at any moment and their KV sits in the
#         cache. Reported per turn: prompt tokens, the tokens the server says it found in its cache, and time to
#         first token. The workload runs with the cache on, with it off, and with the KV pool cut to 32,768 and
#         then 16,384 tokens, which is less than the conversations need, so the cache has to evict.
# burst   64 requests that share a 3,000-token prefix, all sent at the same moment to a server that has never seen
#         the prefix. Nothing is in the cache when they arrive, so every hit comes from requests in the same burst.
#         SGLang runs this twice, with its default first-come-first-served order and with --schedule-policy lpm.
#
#   modal run modal_run.py --script prefix_cache_bench.py --gpu 'H100!' --vllm   --args "--engine vllm"
#   modal run modal_run.py --script prefix_cache_bench.py --gpu 'H100!' --sglang --args "--engine sglang"
#   modal run modal_run.py --script prefix_cache_bench.py --gpu A10 --sglang --args "--engine sglang --quick"
#   python gcp_run.py --script prefix_cache_bench.py --gpu A100-80GB --sglang --args "--engine sglang"
# Add --unique-system to start every conversation's system prompt with its customer number, which removes the
# shared prefix, and --only 'cache on' to run a single configuration.
#
# Writes prefix_cache_vllm.json or prefix_cache_sglang.json (with --quick, the name ends in _quick).
import argparse
import asyncio
import json
import os
import random
import re
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
PORT = 8000
URL = f"http://127.0.0.1:{PORT}"
CONTEXT = 8192
SMALL_POOLS = (32768, 16384)             # tokens of KV in the two "pool" configurations

TOPICS = ["refunds", "shipping times", "damaged items", "gift cards", "price matching", "order changes", "warranties",
          "store credit", "international duties", "returns by post", "loyalty points", "subscriptions",
          "account deletion", "invoices", "bulk orders", "pre-orders", "back-orders", "recalls", "installation",
          "trade-ins"]
SYSTEM_PROMPT = "You are the support assistant of an online shop. Follow these rules. " + " ".join(
    f"Rule {i}: when a customer asks about {topic}, answer in at most {2 + i % 3} sentences and cite policy {100 + i}."
    for i, topic in enumerate(TOPICS * 4))
SITUATIONS = ["the order was a gift", "the parcel arrived late", "the customer lives abroad", "the item was on sale",
              "the receipt is lost", "two items were ordered together", "the customer paid with store credit",
              "the box was opened", "it is a second request", "the item is out of stock"]


# ------------------------------------------------------------------------------------------------ the servers

class Server:
    """One engine's OpenAI-compatible server in a child process, with its log in a file."""

    def __init__(self, engine: str, model: str, flags: list[str]):
        self.engine = engine
        self.log = Path(f"/tmp/{engine}_server_{int(time.time() * 1000)}.log")
        if engine == "vllm":
            cmd = ["vllm", "serve", model, "--port", str(PORT), "--max-model-len", str(CONTEXT),
                   "--enable-prompt-tokens-details", *flags]
        else:
            cmd = [sys.executable, "-m", "sglang.launch_server", "--model-path", model, "--host", "127.0.0.1",
                   "--port", str(PORT), "--context-length", str(CONTEXT), "--enable-cache-report", *flags]
        print("\n$", " ".join(cmd), flush=True)
        self.started = time.time()
        self.proc = subprocess.Popen(cmd, stdout=self.log.open("w"), stderr=subprocess.STDOUT, start_new_session=True)

    def __enter__(self):
        while True:
            if self.proc.poll() is not None or time.time() - self.started > 1200:
                print(self.log.read_text()[-8000:])
                raise SystemExit(f"the {self.engine} server did not start")
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
        time.sleep(5)                           # let the driver release the GPU's memory

    def log_lines(self, pattern: str, limit: int = 40) -> list[str]:
        out = []
        for line in self.log.read_text(errors="replace").splitlines():
            if re.search(pattern, line, re.I) and "it/s]" not in line and "server_args=" not in line:
                out.append(re.sub(r"\x1b\[[0-9;]*m", "", line)[:400])
        return out[:limit]

    def prefill_batches(self, skip: int = 0) -> list[dict]:
        """SGLang logs one line per prefill batch: how many requests it admitted, how many tokens it computed and
        how many it took from the cache. `skip` leaves out the batches logged before a workload began."""
        found = re.findall(r"Prefill batch.*?#new-seq: (\d+), #new-token: (\d+), #cached-token: (\d+)",
                           self.log.read_text(errors="replace"))
        return [{"requests": int(a), "computed": int(b), "cached": int(c)} for a, b, c in found[skip:]]

    def vllm_metrics(self) -> dict[str, float]:
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

    def pool_tokens(self) -> int | None:
        """How many tokens of KV the server says it can hold."""
        if self.engine == "vllm":
            m = self.vllm_metrics()
            return int(m.get("num_gpu_blocks", 0) * m.get("block_size", 0))
        for path in ("/server_info", "/get_server_info"):
            try:
                info = json.loads(urllib.request.urlopen(f"{URL}{path}", timeout=10).read())
            except Exception:
                continue
            found = re.search(r'"max_total_num_tokens":\s*(\d+)', json.dumps(info))
            if found:
                return int(found.group(1))
        found = re.search(r"max_total_num_tokens=(\d+)", self.log.read_text(errors="replace"))
        return int(found.group(1)) if found else None

    def preemptions(self) -> int:
        """Requests whose KV was thrown away because the pool was full: vLLM preempts, SGLang retracts."""
        if self.engine == "vllm":
            return int(self.vllm_metrics().get("num_preemptions", 0))
        total = 0
        for found in re.findall(r"#retracted_reqs: (\d+)", self.log.read_text(errors="replace")):
            total += int(found)
        return total


# ------------------------------------------------------------------------------------------------- the client

async def stream(session, path: str, body: dict) -> dict:
    """Send one streamed request. Returns the time to the first chunk with text, the text, and the usage."""
    t_send = time.perf_counter()
    first, usage, text = None, None, []
    async with session.post(f"{URL}{path}", json={**body, "stream": True, "stream_options": {"include_usage": True}}) as resp:
        if resp.status != 200:
            raise RuntimeError(f"{resp.status}: {(await resp.text())[:300]}")
        async for raw in resp.content:
            if not raw.startswith(b"data: ") or raw.startswith(b"data: [DONE]"):
                continue
            chunk = json.loads(raw[6:])
            usage = chunk.get("usage") or usage
            for choice in chunk.get("choices") or []:
                piece = choice.get("text") or (choice.get("delta") or {}).get("content") or ""
                if piece and first is None:
                    first = time.perf_counter()
                text.append(piece)
    done = time.perf_counter()
    details = (usage or {}).get("prompt_tokens_details") or {}
    return {"ttft_ms": ((first or done) - t_send) * 1e3, "total_ms": (done - t_send) * 1e3, "text": "".join(text),
            "prompt_tokens": usage["prompt_tokens"], "completion_tokens": usage["completion_tokens"],
            "cached_tokens": details.get("cached_tokens") or 0}


def session():
    import aiohttp
    return aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=0), timeout=aiohttp.ClientTimeout(total=1800))


def pct(values: list[float], q: float) -> float:
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))]


def question(conv: int, turn: int) -> str:
    rng = random.Random(conv * 100 + turn)
    return (f"Customer {conv + 1}, question {turn + 1}. In about 100 words, explain what I should do about "
            f"{rng.choice(TOPICS)} when {rng.choice(SITUATIONS)}, and which rule applies.")


async def run_chat(a, server: Server) -> dict:
    """Closed loop: each conversation waits for its answer, thinks for 1 to 4 seconds, and sends the next turn
    with the whole history. One conversation is run first so the system prompt is in the cache, as it would be on
    a server that has been up for a while."""
    rows: list[dict] = []

    async def conversation(s, conv: int, record: bool) -> None:
        rng = random.Random(1000 + conv)
        # --unique-system puts the customer's number first, so no two conversations share a prefix.
        messages = [{"role": "system", "content": (f"Customer {conv + 1}. " if a.unique_system else "") + SYSTEM_PROMPT}]
        for turn in range(a.turns if record else 1):
            if record:
                await asyncio.sleep(rng.uniform(1.0, 4.0))
            messages.append({"role": "user", "content": question(conv, turn)})
            r = await stream(s, "/v1/chat/completions", {"model": a.model, "messages": messages, "max_tokens": 150,
                                                         "temperature": 0})
            messages.append({"role": "assistant", "content": r.pop("text")})
            if record:
                rows.append({"conv": conv, "turn": turn + 1, **r})

    async with session() as s:
        await conversation(s, 9999, record=False)
        before = server.preemptions()
        t = time.perf_counter()
        await asyncio.gather(*(conversation(s, c, True) for c in range(a.conversations)))
        seconds = time.perf_counter() - t
    by_turn = []
    for turn in range(1, a.turns + 1):
        rs = [r for r in rows if r["turn"] == turn]
        by_turn.append({"turn": turn, "prompt_tokens_p50": round(pct([r["prompt_tokens"] for r in rs], 0.5)),
                        "cached_tokens_p50": round(pct([r["cached_tokens"] for r in rs], 0.5)),
                        "hit_rate": round(sum(r["cached_tokens"] for r in rs) / sum(r["prompt_tokens"] for r in rs), 4),
                        "ttft_ms_p50": round(pct([r["ttft_ms"] for r in rs], 0.5), 1),
                        "ttft_ms_p99": round(pct([r["ttft_ms"] for r in rs], 0.99), 1)})
    prompt, cached = sum(r["prompt_tokens"] for r in rows), sum(r["cached_tokens"] for r in rows)
    return {"requests": len(rows), "seconds": round(seconds, 1), "prompt_tokens": prompt, "cached_tokens": cached,
            "hit_rate": round(cached / prompt, 4), "completion_tokens": sum(r["completion_tokens"] for r in rows),
            "ttft_ms_p50": round(pct([r["ttft_ms"] for r in rows], 0.5), 1),
            "ttft_ms_p99": round(pct([r["ttft_ms"] for r in rows], 0.99), 1),
            "preemptions": server.preemptions() - before, "by_turn": by_turn}


async def run_burst(a, server: Server) -> dict:
    """64 prompts of token ids: the same 3,000 tokens, then 50 that differ. All are sent at once to a cold cache."""
    rng = random.Random(1)
    prefix = [rng.randrange(1000, 32000) for _ in range(3000)]
    prompts = [prefix + [rng.randrange(1000, 32000) for _ in range(50)] for _ in range(64)]
    body = lambda p: {"model": a.model, "prompt": p, "max_tokens": 16, "temperature": 0, "ignore_eos": True}
    logged = len(server.prefill_batches()) if server.engine == "sglang" else 0
    async with session() as s:
        t = time.perf_counter()
        rs = await asyncio.gather(*(stream(s, "/v1/completions", body(p)) for p in prompts))
        seconds = time.perf_counter() - t
    prompt, cached = sum(r["prompt_tokens"] for r in rs), sum(r["cached_tokens"] for r in rs)
    return {"requests": len(rs), "seconds": round(seconds, 2), "prompt_tokens": prompt, "cached_tokens": cached,
            "hit_rate": round(cached / prompt, 4), "requests_with_no_hit": sum(r["cached_tokens"] == 0 for r in rs),
            "ttft_ms_p50": round(pct([r["ttft_ms"] for r in rs], 0.5), 1),
            "ttft_ms_max": round(max(r["ttft_ms"] for r in rs), 1),
            **({"prefill_batches": server.prefill_batches(logged)} if server.engine == "sglang" else {})}


async def warm_up(a) -> None:
    """A few short requests, so that kernels compiled on first use are not charged to the first measurement."""
    async with session() as s:
        for _ in range(3):
            await stream(s, "/v1/completions", {"model": a.model, "prompt": "Hello, my name is", "max_tokens": 8,
                                                "temperature": 0})


# ----------------------------------------------------------------------------------------------------- main

def kv_bytes_per_token(model: str) -> int:
    """Keys and values for one token in every layer, in the model's 16-bit dtype."""
    from huggingface_hub import hf_hub_download
    cfg = json.loads(Path(hf_hub_download(model, "config.json")).read_text())
    head_dim = cfg.get("head_dim") or cfg["hidden_size"] // cfg["num_attention_heads"]
    return cfg["num_hidden_layers"] * 2 * cfg["num_key_value_heads"] * head_dim * 2


def gpu_name() -> str:
    return subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True,
                          text=True).stdout.strip().splitlines()[0]


LOG_PATTERN = {"vllm": r"kv cache|maximum concurrency|max_num_batched_tokens|prefix",
               "sglang": r"max_total_num_tokens|attention backend|Retract|page_size|KV cache|mem usage"}


async def bench(a) -> None:
    from importlib.metadata import version
    per_token = kv_bytes_per_token(a.model)
    if a.engine == "vllm":
        configs = [("cache on", [], ["burst", "chat"]),
                   ("cache off", ["--no-enable-prefix-caching"], ["burst", "chat"]),
                   *((f"pool {n}", ["--kv-cache-memory-bytes", str(n * per_token)], ["chat"]) for n in SMALL_POOLS)]
    else:
        configs = [("cache on", [], ["burst", "chat"]),
                   ("cache off", ["--disable-radix-cache"], ["burst", "chat"]),
                   *((f"pool {n}", ["--max-total-tokens", str(n)], ["chat"]) for n in SMALL_POOLS),
                   ("cache on, lpm", ["--schedule-policy", "lpm"], ["burst"])]
    out = {"engine": a.engine, "version": version(a.engine), "model": a.model, "gpu": gpu_name(),
           "kv_bytes_per_token": per_token, "unique_system": a.unique_system, "conversations": a.conversations, "turns": a.turns, "configs": []}
    name = f"prefix_cache_{a.engine}{'_quick' if a.quick else ''}{'_unique_system' if a.unique_system else ''}.json"
    for label, flags, workloads in configs:
        if a.only and not any(o == label for o in a.only.split(";")):
            continue
        with Server(a.engine, a.model, flags) as server:
            row = {"config": label, "flags": flags, "startup_s": server.startup_s, "pool_tokens": server.pool_tokens()}
            await warm_up(a)
            for w in workloads:
                row[w] = await (run_burst if w == "burst" else run_chat)(a, server)
                print(json.dumps({"config": label, w: {k: v for k, v in row[w].items()
                                                       if k not in ("by_turn", "prefill_batches")}}), flush=True)
            row["server_log"] = server.log_lines(LOG_PATTERN[a.engine])
        out["configs"].append(row)
        (HERE / name).write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["vllm", "sglang"], required=True)
    ap.add_argument("--quick", action="store_true", help="Llama 3.2 1B, 16 conversations of 4 turns")
    ap.add_argument("--only", default="", help="configurations to run, separated by semicolons, such as 'cache on;pool 32768'")
    ap.add_argument("--unique-system", action="store_true",
                    help="start every conversation's system prompt with its customer number (the lab's last task)")
    a = ap.parse_args()
    a.model = "unsloth/Llama-3.2-1B-Instruct" if a.quick else "unsloth/Meta-Llama-3.1-8B-Instruct"
    a.conversations, a.turns = (16, 4) if a.quick else (48, 6)
    from importlib.metadata import version
    print(f"{gpu_name()}, {a.engine} {version(a.engine)}", flush=True)
    asyncio.run(bench(a))


if __name__ == "__main__":
    main()
