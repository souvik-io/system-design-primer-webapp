# structured_bench.py: chapter 5.5's Mac lab, part B. Structured output and sampling in nano_engine.
#
#   python structured_bench.py engine     # about 2 minutes on an M2: one workload through nano_engine, seven ways
#   python structured_bench.py sampler    # about 1 minute: what each sampling step and the grammar mask cost here
#
# engine: 48 orders written as short paragraphs, which SmolLM2-135M-Instruct is asked to return as JSON with a
# fixed schema (a customer, an email, a list of items with a product, quantity and unit price, and an express flag).
# Each mode runs all 48 through nano_engine on the CPU and is scored three ways: does the output parse as JSON, does
# it match the schema, and are the values right. Timing is reported per mode: steps, output tokens, wall time, and
# for constrained modes the time spent compiling grammars, filling masks (per constrained sequence and step) and
# applying them to the logits. "canonical" counts the answers whose tokens are the ones the tokenizer itself would
# produce for the same text.
#
# sampler: times the sampler's steps (sampler.py) on random logits for SmolLM2's vocabulary (49,152) and Llama 3's
# (128,256) at batch sizes 1, 32 and 256, and xgrammar's mask for the order schema at several points in an output.
# These are CPU numbers; ../gpu/sampling_bench.py measures the same steps on a GPU.
#
# Needs: torch, transformers, xgrammar (pip install -r requirements.txt), and nano_engine/ beside this file.
import argparse
import json
import random
import statistics
import time

import torch

MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct"
LLAMA_TOKENIZER = "unsloth/Llama-3.2-1B-Instruct"       # Llama 3's 128,256-token vocabulary, without the gate

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
    """A paragraph describing an order, and the JSON that a correct answer contains."""
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


def prompt(tokenizer, text: str) -> list[int]:
    ask = ("Read the order below and return it as JSON with the keys customer, email, items (a list of objects with "
           "product, quantity and unit_price) and express (true or false). Return only the JSON.\n\nOrder: " + text)
    chat = tokenizer.apply_chat_template([{"role": "user", "content": ask}], add_generation_prompt=True, tokenize=False)
    return tokenizer.encode(chat, add_special_tokens=False)


def matches_schema(x) -> bool:
    """The order schema, checked by hand so the lab needs no JSON-schema library."""
    if not isinstance(x, dict) or set(x) != {"customer", "email", "items", "express"}:
        return False
    if not (isinstance(x["customer"], str) and isinstance(x["email"], str) and isinstance(x["express"], bool)):
        return False
    if not isinstance(x["items"], list) or not x["items"]:
        return False
    for it in x["items"]:
        if not isinstance(it, dict) or set(it) != {"product", "quantity", "unit_price"}:
            return False
        if not (isinstance(it["product"], str) and type(it["quantity"]) is int
                and type(it["unit_price"]) in (int, float)):
            return False
    return True


def score(text: str, truth: dict) -> dict:
    """Parses (strict JSON, after removing a ```json fence if there is one), matches the schema, and the share of the
    four top-level fields whose value is right (items: the same products, quantities and prices, in any order)."""
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


# ---------------------------------------------------------------------------------------------------- engine

MODES = [
    # name, engine options, sampling options
    ("free, greedy", {}, {"temperature": 0}),
    ("free, T=0.8", {}, {"temperature": 0.8}),
    ("any JSON object, greedy", {}, {"temperature": 0, "json_schema": "object"}),
    ("schema, greedy", {}, {"temperature": 0, "json_schema": ORDER_SCHEMA}),
    ("schema, T=0.8", {}, {"temperature": 0.8, "json_schema": ORDER_SCHEMA}),
    ("schema, any whitespace", {"json_any_whitespace": True}, {"temperature": 0, "json_schema": ORDER_SCHEMA}),
    ("schema, jump-forward", {"jump_forward": True}, {"temperature": 0, "json_schema": ORDER_SCHEMA}),
]


def run_engine(a) -> None:
    from nano_engine import LLM, SamplingParams

    orders = [order(i) for i in range(a.requests)]
    rows, texts = [], {}
    for name, engine_opts, sp in MODES:
        llm = LLM(MODEL, seed=0, **engine_opts)
        tok = llm.tokenizer
        prompts = [prompt(tok, text) for text, _ in orders]
        params = SamplingParams(max_tokens=a.max_tokens, **sp)
        start = time.perf_counter()
        outs = llm.generate(prompts, params)
        seconds = time.perf_counter() - start
        decoded = [tok.decode(o[0], skip_special_tokens=True) for o in outs]
        texts[name] = decoded
        scores = [score(t, truth) for t, (_, truth) in zip(decoded, orders)]
        n_out = sum(len(o[0]) for o in outs)
        # Would the tokenizer split the same text into the same tokens? A model trained on tokenized text has only
        # ever seen the tokenizer's split; a grammar that forces a different one moves it off what it knows.
        canonical = sum(tok.encode(t, add_special_tokens=False) == [i for i in o[0] if i not in llm.engine.eos_ids]
                        for t, o in zip(decoded, outs))
        e = llm.engine
        row = {"mode": name, "parses": sum(s["parses"] for s in scores), "schema": sum(s["schema"] for s in scores),
               "fields_right": round(100 * statistics.mean(s["fields"] for s in scores), 1),
               "hit_max_tokens": sum(len(o[0]) >= a.max_tokens for o in outs),
               "canonical_tokens": canonical,
               "output_tokens": n_out, "steps": e.stats["steps"], "seconds": round(seconds, 2),
               "tok_s": round(n_out / seconds, 1), "sample_ms_per_step": round(1e3 * e.stats["sample_s"] / e.stats["steps"], 2)}
        if e._structured is not None:
            st = e._structured.stats
            row.update(compile_ms_total=round(1e3 * st["compile_s"], 1), compiles=st["compiles"],
                       fill_us_per_token=round(1e6 * st["fill_s"] / max(st["masks"], 1), 1),
                       apply_us_per_token=round(1e6 * st["apply_s"] / max(st["masks"], 1), 1),
                       jump_forward_tokens=st["jump_forward_tokens"])
        rows.append(row)
        print(json.dumps(row), flush=True)

    print(f"\n{a.requests} orders, SmolLM2-135M-Instruct on the CPU, max_tokens {a.max_tokens}")
    head = f"{'mode':<26}{'parses':>7}{'schema':>8}{'fields right':>14}{'at max':>8}{'tokens':>8}{'steps':>7}{'tok/s':>7}{'fill us':>9}{'apply us':>10}{'canonical':>11}"
    print(head)
    for r in rows:
        fill = f"{r['fill_us_per_token']:.0f}" if "fill_us_per_token" in r else ""
        apply = f"{r['apply_us_per_token']:.0f}" if "apply_us_per_token" in r else ""
        print(f"{r['mode']:<26}{r['parses']:>7}{r['schema']:>8}{r['fields_right']:>13.1f}%{r['hit_max_tokens']:>8}"
              f"{r['output_tokens']:>8}{r['steps']:>7}{r['tok_s']:>7.0f}{fill:>9}{apply:>10}{r['canonical_tokens']:>11}")
    for r in rows:
        if r.get("jump_forward_tokens"):
            print(f"\n{r['mode']}: {r['jump_forward_tokens']} of {r['output_tokens']} output tokens were forced by the "
                  f"grammar and appended without sampling")
    same = sum(x == y for x, y in zip(texts["schema, greedy"], texts["schema, jump-forward"]))
    print(f"jump-forward and plain constrained decoding gave identical text for {same} of {a.requests} orders")
    print("\nThe first answer in each mode:")
    for name, _, _ in MODES:
        print(f"  {name}: {texts[name][0]!r}")
    if a.out:
        with open(a.out, "w") as f:
            json.dump({"model": MODEL, "requests": a.requests, "max_tokens": a.max_tokens, "rows": rows,
                       "examples": {k: v[:3] for k, v in texts.items()}}, f, indent=1)


# --------------------------------------------------------------------------------------------------- sampler

def timed(fn, repeat: int) -> float:
    """Median milliseconds of fn() over `repeat` runs, after one warm-up run."""
    fn()
    times = []
    for _ in range(repeat):
        t = time.perf_counter()
        fn()
        times.append(time.perf_counter() - t)
    return 1e3 * statistics.median(times)


def run_sampler(a) -> None:
    from nano_engine.sampler import apply_penalties, filter_tail, sample
    from nano_engine.sequence import SamplingParams, Sequence

    torch.manual_seed(0)
    gen = torch.Generator().manual_seed(0)
    print(f"Sampling steps on the CPU ({torch.get_num_threads()} threads), median ms per call")
    print(f"{'vocab':>8}{'batch':>7}{'argmax':>9}{'draw':>9}{'min-p':>9}{'top-k 50':>10}{'top-p 0.9':>11}{'penalties':>11}")
    for vocab in (49152, 128256):
        for batch in (1, 32, 256):
            logits = torch.randn(batch, vocab) * 3
            mk = lambda **kw: [Sequence("r", list(range(200)), SamplingParams(**kw)) for _ in range(batch)]
            seqs_pen = mk(repetition_penalty=1.1, frequency_penalty=0.5, presence_penalty=0.5)
            for s in seqs_pen:
                s.token_ids += [random.randrange(vocab) for _ in range(256)]     # 256 tokens of output so far
            race = lambda: (torch.softmax(logits, -1) / torch.empty_like(logits).exponential_(generator=gen)).argmax(-1)
            cols = [timed(lambda: logits.argmax(-1), a.repeat), timed(race, a.repeat),
                    timed(lambda: filter_tail(logits, mk(min_p=0.1)), a.repeat),
                    timed(lambda: filter_tail(logits, mk(top_k=50)), a.repeat),
                    timed(lambda: filter_tail(logits, mk(top_p=0.9)), a.repeat),
                    timed(lambda: apply_penalties(logits.clone(), seqs_pen), a.repeat)]
            print(f"{vocab:>8}{batch:>7}" + "".join(f"{c:>{w}.3f}" for c, w in zip(cols, (9, 9, 9, 10, 11, 11))), flush=True)

    import xgrammar as xgr
    from transformers import AutoTokenizer
    answer = json.dumps(order(0)[1])
    from importlib.metadata import version
    print(f"\nxgrammar {version('xgrammar')} mask for the order schema, one sequence, microseconds per mask, at points in the answer"
          f"\n  {answer}")
    for name in (MODEL, LLAMA_TOKENIZER):
        tok = AutoTokenizer.from_pretrained(name)
        info = xgr.TokenizerInfo.from_huggingface(tok, vocab_size=len(tok))
        t = time.perf_counter()
        compiled = xgr.GrammarCompiler(info, cache_enabled=False).compile_json_schema(json.dumps(ORDER_SCHEMA), any_whitespace=False)
        compile_ms = 1e3 * (time.perf_counter() - t)
        ids = tok.encode(answer, add_special_tokens=False)
        matcher = xgr.GrammarMatcher(compiled)
        bitmask = xgr.allocate_token_bitmask(1, info.vocab_size)
        per_token = []
        for tid in ids:
            t = time.perf_counter()
            matcher.fill_next_token_bitmask(bitmask)
            per_token.append((1e6 * (time.perf_counter() - t), tok.decode([tid]), int(bitmask.ne(0).sum())))
            assert matcher.accept_token(tid), tok.decode([tid])
        us = [p[0] for p in per_token]
        slow = sorted(per_token, reverse=True)[:3]
        print(f"  {name} ({info.vocab_size:,} tokens): compile {compile_ms:.0f} ms; mask median {statistics.median(us):.0f} us, "
              f"max {max(us):.0f} us over {len(ids)} tokens; slowest before " + ", ".join(f"{p[1]!r} ({p[0]:.0f} us)" for p in slow))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("part", choices=["engine", "sampler"])
    ap.add_argument("--requests", type=int, default=48)
    ap.add_argument("--max-tokens", type=int, default=160)
    ap.add_argument("--repeat", type=int, default=20)
    ap.add_argument("--out", default="", help="write the engine results to this JSON file")
    a = ap.parse_args()
    run_engine(a) if a.part == "engine" else run_sampler(a)


if __name__ == "__main__":
    main()
