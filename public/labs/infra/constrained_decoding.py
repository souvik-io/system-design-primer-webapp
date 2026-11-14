# constrained_decoding.py: chapter 5.5's Mac lab, part A. Constrained decoding from scratch, without a library.
#
#   python constrained_decoding.py          # about a minute on an M2
#   python constrained_decoding.py --test   # only the self-checks, a few seconds
#   python constrained_decoding.py --widget-data ../../../src/widgets/data   # the data behind the chapter's widgets
#
# What it does, in order:
#   1. compile_schema turns a small JSON schema (an object whose properties are strings, integers, booleans or
#      enums of strings) into a deterministic finite automaton over characters: every valid output is a path from
#      the start state to the final state, one character per transition.
#   2. mask_naive finds the tokens allowed in one state by walking every token of the vocabulary through the
#      automaton, character by character. That is the work an engine without an index does on every step.
#   3. build_index does that walk once for every state, ahead of time, and keeps a mask per state and a table of
#      where each allowed token leads. Decoding then costs one lookup per step. This is the approach of Outlines
#      (Willard and Louf, 2023), which turns a JSON schema into a regular expression and the expression into an
#      automaton like this one.
#   4. decode runs SmolLM2-135M-Instruct greedily on twelve short texts, asking for JSON, with no constraint and
#      with the index as the constraint, and scores the answers.
#
# The automaton works on characters, so a token that holds part of a multi-byte character (it decodes to '�')
# is never allowed. Real engines work on bytes for this reason: xgrammar's automaton is byte-level.
#
# Needs: torch, transformers. Downloads SmolLM2-135M-Instruct (about 270 MB) on first run.
import argparse
import json
import statistics
import time

import torch

MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct"

PERSON_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "age": {"type": "integer"},
        "city": {"type": "string", "enum": ["Paris", "London", "Tokyo", "Lagos", "Lima", "Oslo"]},
        "member": {"type": "boolean"},
    },
    "required": ["name", "age", "city", "member"],
}

STRING_CHAR = lambda c: c not in '"\\' and ord(c) >= 0x20      # any character a JSON string holds unescaped
DIGIT = lambda c: "0" <= c <= "9"
DIGIT_1_9 = lambda c: "1" <= c <= "9"


# ------------------------------------------------------------------------------------------- 1. the automaton

class DFA:
    """States are numbers. Each state has literal transitions (a dict from character to state) and class
    transitions (a predicate on the character, and a state), tried after the literal ones."""

    def __init__(self):
        self.lit: list[dict[str, int]] = []
        self.cls: list[list[tuple]] = []
        self.final: set[int] = set()
        self.start = 0

    def new(self) -> int:
        self.lit.append({})
        self.cls.append([])
        return len(self.lit) - 1

    def step(self, state: int, ch: str) -> int | None:
        nxt = self.lit[state].get(ch)
        if nxt is not None:
            return nxt
        for pred, target in self.cls[state]:
            if pred(ch):
                return target
        return None

    def walk(self, state: int, text: str) -> int | None:
        """The state after reading text from state, or None if the automaton rejects it on the way."""
        for ch in text:
            state = self.step(state, ch)
            if state is None:
                return None
        return state

    def literal(self, text: str, then: int) -> int:
        """States that read exactly `text` and arrive at `then`. Returns the first."""
        first = cur = self.new()
        for i, ch in enumerate(text):
            nxt = then if i == len(text) - 1 else self.new()
            self.lit[cur][ch] = nxt
            cur = nxt
        return first

    def choices(self, texts: list[str], then: int) -> int:
        """A trie that reads any one of `texts` and arrives at `then` (an enum, or true/false)."""
        root = self.new()
        for text in texts:
            cur = root
            for i, ch in enumerate(text):
                if i == len(text) - 1:
                    self.lit[cur][ch] = then
                elif ch in self.lit[cur]:
                    cur = self.lit[cur][ch]
                else:
                    self.lit[cur][ch] = cur = self.new()
        return root


def value_states(d: DFA, spec: dict, then: int) -> int:
    """States that read one JSON value of the given type and arrive at `then`, whose transitions read whatever
    follows the value. Returns the first state."""
    if "enum" in spec:
        return d.choices([json.dumps(v) for v in spec["enum"]], then)
    kind = spec["type"]
    if kind == "boolean":
        return d.choices(["true", "false"], then)
    if kind == "string":
        start, body, escape = d.new(), d.new(), d.new()
        d.lit[start]['"'] = body
        d.lit[body]['"'] = then
        d.lit[body]["\\"] = escape
        d.cls[body].append((STRING_CHAR, body))
        for ch in '"\\/bfnrt':
            d.lit[escape][ch] = body
        return start
    if kind == "integer":
        # -?(0|[1-9][0-9]*). An integer has no closing character, so its last states also take the transitions of
        # `then`: after "34" the automaton reads either another digit or the ',' that starts the next field.
        start, minus, zero, digits = d.new(), d.new(), d.new(), d.new()
        d.lit[start]["-"] = minus
        for s in (start, minus):
            d.lit[s]["0"] = zero
            d.cls[s].append((DIGIT_1_9, digits))
        d.cls[digits].append((DIGIT, digits))
        for s in (zero, digits):
            d.lit[s].update(d.lit[then])
            d.cls[s] += d.cls[then]
        return start
    raise ValueError(f"compile_schema does not support {spec}")


def compile_schema(schema: dict) -> DFA:
    """An automaton for json.dumps(x) of an object with every property of the schema, in the schema's order: the
    layout is fixed to '{"a": 1, "b": "x"}', one space after each colon and comma, no other whitespace. It is built
    from the end backwards, so that each value knows the state that reads what comes after it."""
    d = DFA()
    end = d.new()
    d.final.add(end)
    then = d.literal("}", end)
    props = list(schema["properties"].items())
    for i in reversed(range(len(props))):
        key, spec = props[i]
        then = value_states(d, spec, then)
        then = d.literal(("{" if i == 0 else ", ") + json.dumps(key) + ": ", then)
    d.start = then
    return d


# ------------------------------------------------------------------------------------- 2 and 3. the mask

def vocabulary(tokenizer) -> list[str | None]:
    """The text of every token, or None for special tokens and pieces of multi-byte characters."""
    special = set(tokenizer.all_special_ids)
    out = []
    for i in range(len(tokenizer)):
        text = None if i in special else tokenizer.convert_tokens_to_string([tokenizer.convert_ids_to_tokens(i)])
        out.append(None if not text or "�" in text else text)
    return out


def mask_naive(d: DFA, state: int, vocab: list[str | None], eos: int) -> torch.Tensor:
    """Allowed tokens in `state`: walk each token through the automaton. The end-of-sequence token is allowed only
    in the final state."""
    allowed = torch.zeros(len(vocab), dtype=torch.bool)
    for tid, text in enumerate(vocab):
        if text is not None and d.walk(state, text) is not None:
            allowed[tid] = True
    allowed[eos] = state in d.final
    return allowed


class Index:
    """For every state, the mask of allowed tokens and the state each allowed token leads to."""

    def __init__(self, d: DFA, vocab: list[str | None], eos: int):
        self.d, self.eos = d, eos
        self.masks: list[torch.Tensor] = []
        self.next: list[dict[int, int]] = []
        for state in range(len(d.lit)):
            nxt = {}
            for tid, text in enumerate(vocab):
                if text is not None:
                    target = d.walk(state, text)
                    if target is not None:
                        nxt[tid] = target
            mask = torch.zeros(len(vocab), dtype=torch.bool)
            mask[list(nxt)] = True
            mask[eos] = state in d.final
            self.masks.append(mask)
            self.next.append(nxt)

    def mask(self, state: int) -> torch.Tensor:
        return self.masks[state]

    def advance(self, state: int, token: int) -> int:
        return self.next[state][token]


# --------------------------------------------------------------------------------------------- 4. decoding

FIRST = ["Maria", "Kwame", "Sofia", "Hiro", "Amara", "Lukas", "Priya", "Mateo", "Ingrid", "Tunde", "Chloe", "Ravi"]
LAST = ["Lopez", "Mensah", "Rossi", "Tanaka", "Okafor", "Berg", "Nair", "Silva", "Holm", "Adeyemi", "Moreau", "Iyer"]
CITIES = PERSON_SCHEMA["properties"]["city"]["enum"]


def person(i: int) -> tuple[str, dict]:
    name, age, city, member = f"{FIRST[i % 12]} {LAST[(5 * i + 3) % 12]}", 19 + (i * 7) % 60, CITIES[i % 6], i % 3 != 0
    club = "is a member of the chess club" if member else "is not a member of the chess club"
    return f"{name} is {age} years old, lives in {city} and {club}.", {"name": name, "age": age, "city": city, "member": member}


def ask(tokenizer, text: str) -> list[int]:
    msg = ("Return the person's name, age, city and whether they are a member, as JSON with the keys name, age, "
           f"city and member. Return only the JSON.\n\nText: {text}")
    chat = tokenizer.apply_chat_template([{"role": "user", "content": msg}], add_generation_prompt=True, tokenize=False)
    return tokenizer.encode(chat, add_special_tokens=False)


@torch.no_grad()
def decode(model, prompt: list[int], eos: int, constraint=None, max_new: int = 60) -> tuple[list[int], list[float]]:
    """Greedy decoding with a KV cache. `constraint` is (mask_of_state, advance, start) or None. Returns the tokens
    and the time each step spent on the mask, in seconds."""
    ids, past, out, mask_times = torch.tensor([prompt]), None, [], []
    state = constraint[2] if constraint else None
    for _ in range(max_new):
        o = model(input_ids=ids, past_key_values=past, use_cache=True)
        past, logits = o.past_key_values, o.logits[0, -1]
        if constraint:
            t = time.perf_counter()
            logits = logits.masked_fill(~constraint[0](state), float("-inf"))
            mask_times.append(time.perf_counter() - t)
        token = int(logits.argmax())
        if token == eos:
            break
        out.append(token)
        if constraint:
            state = constraint[1](state, token)
        ids = torch.tensor([[token]])
    return out, mask_times


def score(text: str, truth: dict) -> tuple[bool, bool, float]:
    """Parses as JSON; has exactly the schema's keys with the right types; share of values that are right."""
    try:
        x = json.loads(text)
    except json.JSONDecodeError:
        return False, False, 0.0
    types = {"name": str, "age": int, "city": str, "member": bool}
    if not isinstance(x, dict) or set(x) != set(types) or not all(type(x[k]) is t for k, t in types.items()):
        return True, False, 0.0
    return True, True, sum(x[k] == truth[k] for k in truth) / len(truth)


# ------------------------------------------------------------------------------------------- widget data

def forced_text(d: DFA, state: int) -> str:
    """The characters the automaton forces from `state`: while a state has one literal transition and nothing else,
    there is nothing to choose. Jump-forward decoding appends this text without asking the model."""
    out = ""
    while len(d.lit[state]) == 1 and not d.cls[state] and state not in d.final:
        ch, state = next(iter(d.lit[state].items()))
        out += ch
    return out


@torch.no_grad()
def widget_data(folder: str) -> None:
    """The data behind the chapter's two widgets: next-token distributions of SmolLM2-135M (the base model) for
    three prompts, and a step-by-step record of one constrained answer of the instruct model."""
    from pathlib import Path
    from transformers import AutoModelForCausalLM, AutoTokenizer

    out = Path(folder)
    tok = AutoTokenizer.from_pretrained("HuggingFaceTB/SmolLM2-135M")
    model = AutoModelForCausalLM.from_pretrained("HuggingFaceTB/SmolLM2-135M", dtype=torch.float32).eval()
    dists = []
    for context in ["The Eiffel Tower is in the city of", "for i in range(", "My favourite food is"]:
        logits = model(torch.tensor([tok.encode(context)])).logits[0, -1]
        vals, idx = logits.sort(descending=True)
        rest, width = vals[300:], 0.25          # the 300 highest logits, then a histogram of the others
        counts = torch.bincount(torch.floor((rest - rest.min()) / width).long()).tolist()
        dists.append({"context": context, "vocab": len(logits),
                      "top": [[tok.decode([int(i)]), round(float(v), 3)] for v, i in zip(vals[:300], idx[:300])],
                      "rest": [[round(float(rest.min()) + (b + 0.5) * width, 3), n] for b, n in enumerate(counts) if n]})
    (out / "sampling-distributions.json").write_text(json.dumps(
        {"model": "HuggingFaceTB/SmolLM2-135M", "note": "300 highest logits; the rest as a histogram of logit values in "
         "0.25-wide bins [center, count]", "contexts": dists}, separators=(",", ":")))

    tok = AutoTokenizer.from_pretrained(MODEL)
    eos = tok.convert_tokens_to_ids("<|im_end|>")
    d, vocab = compile_schema(PERSON_SCHEMA), vocabulary(tok)
    index = Index(d, vocab, eos)
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32).eval()
    text, _ = person(1)
    prompt = ask(tok, text)
    steps, ids, past, state = [], torch.tensor([prompt]), None, d.start
    for _ in range(60):
        o = model(input_ids=ids, past_key_values=past, use_cache=True)
        past, logits = o.past_key_values, o.logits[0, -1]
        probs, mask = torch.softmax(logits, -1), index.mask(state)
        token = int(logits.masked_fill(~mask, float("-inf")).argmax())
        top = probs.topk(6)
        steps.append({"allowed": int(mask.sum()), "forced": forced_text(d, state), "allowed_mass": round(float(probs[mask].sum()), 4),
                      "top": [[tok.decode([int(i)]), round(float(p), 4), bool(mask[int(i)])] for p, i in zip(top.values, top.indices)],
                      "chosen": tok.decode([token]) if token != eos else "<end>", "chosen_p_before": round(float(probs[token]), 4)})
        if token == eos:
            break
        state, ids = index.advance(state, token), torch.tensor([[token]])
    free, _ = decode(model, prompt, eos)
    (out / "grammar-steps.json").write_text(json.dumps(
        {"model": MODEL, "schema": PERSON_SCHEMA, "input": text, "states": len(d.lit), "vocab": len(vocab),
         "free_answer": tok.decode(free), "steps": steps}, separators=(",", ":")))
    print(f"wrote {out / 'sampling-distributions.json'} and {out / 'grammar-steps.json'}")


# ------------------------------------------------------------------------------------------------- checks

def self_test(d: DFA, vocab, eos: int, tokenizer, index: Index | None = None) -> None:
    for _, truth in (person(i) for i in range(12)):
        assert d.walk(d.start, json.dumps(truth)) in d.final, json.dumps(truth)
    truth = person(1)[1]
    good = json.dumps(truth)
    for bad in (good.replace(": ", ":"), good.replace('"age": ', '"age": 0'), good.replace(truth["city"], "Kyoto"),
                good.replace("true", "True"), good[:-1] + ", }"):
        assert bad != good
        assert d.walk(d.start, bad) not in d.final, bad
    # The tokenizer's own tokens for a valid answer must each be allowed at their step.
    state = d.start
    for tid in tokenizer.encode(good, add_special_tokens=False):
        assert mask_naive(d, state, vocab, eos)[tid], tokenizer.decode([tid])
        state = d.walk(state, vocab[tid])
    assert state in d.final and mask_naive(d, state, vocab, eos)[eos]
    if index is not None:
        for state in (d.start, d.walk(d.start, '{"name": "Ma'), d.walk(d.start, '{"name": "Maria Lopez", "age": 3')):
            assert torch.equal(index.mask(state), mask_naive(d, state, vocab, eos))
    print("self-checks passed")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true", help="run the self-checks only")
    ap.add_argument("--widget-data", metavar="FOLDER", help="write the chapter's widget data to FOLDER and stop")
    a = ap.parse_args()
    if a.widget_data:
        widget_data(a.widget_data)
        return
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(MODEL)
    eos = tok.convert_tokens_to_ids("<|im_end|>")
    d = compile_schema(PERSON_SCHEMA)
    vocab = vocabulary(tok)
    if a.test:
        self_test(d, vocab, eos, tok)
        return

    print(f"Schema: {json.dumps(PERSON_SCHEMA)}")
    print(f"Automaton: {len(d.lit)} states. Vocabulary: {len(vocab):,} tokens, {sum(v is not None for v in vocab):,} usable")

    # The cost of one mask without an index, in a few states.
    example = json.dumps(person(1)[1])
    print(f"\nWalking the whole vocabulary in one state (no index), along {example}")
    for prefix in ("", '{"name": ', '{"name": "Ma', example[: example.index('"age": ') + 7], example[: example.index(person(1)[1]["city"])]):
        state = d.walk(d.start, prefix)
        t = time.perf_counter()
        allowed = mask_naive(d, state, vocab, eos)
        ms = 1e3 * (time.perf_counter() - t)
        sample = [vocab[i] for i in allowed.nonzero().flatten()[:6].tolist()]
        print(f"  after {prefix[-24:]!r:<28} {int(allowed.sum()):>6,} tokens allowed, {ms:6.1f} ms   e.g. {sample}")

    t = time.perf_counter()
    index = Index(d, vocab, eos)
    build_s = time.perf_counter() - t
    sizes = [int(m.sum()) for m in index.masks]
    entries = sum(len(n) for n in index.next)
    print(f"\nIndex: built in {build_s:.1f} s for {len(d.lit)} states; allowed tokens per state: median "
          f"{statistics.median(sizes):,.0f}, max {max(sizes):,}; {entries:,} (state, token) entries in the tables")
    self_test(d, vocab, eos, tok, index)

    print("\nLoading the model")
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32).eval()
    rows = {"free": [], "index": []}
    canonical, mask_ms = 0, []
    for i in range(12):
        text, truth = person(i)
        prompt = ask(tok, text)
        free, _ = decode(model, prompt, eos)
        forced, times = decode(model, prompt, eos, (index.mask, index.advance, d.start))
        mask_ms += [1e3 * x for x in times]
        rows["free"].append((tok.decode(free), truth))
        rows["index"].append((tok.decode(forced), truth))
        canonical += tok.encode(tok.decode(forced), add_special_tokens=False) == forced
    print(f"\n12 people, SmolLM2-135M-Instruct, greedy")
    print(f"{'':<14}{'parses':>8}{'schema':>8}{'values right':>14}")
    for name, results in rows.items():
        s = [score(t, truth) for t, truth in results]
        print(f"{name:<14}{sum(x[0] for x in s):>8}{sum(x[1] for x in s):>8}{100 * statistics.mean(x[2] for x in s):>13.0f}%")
    print(f"Masking with the index took {statistics.median(mask_ms):.3f} ms per step (median); without it, the walk "
          f"above takes tens of milliseconds per step")
    print(f"Constrained answers whose tokens are the tokenizer's own split of the text: {canonical} of 12")
    for name in rows:
        print(f"\nFirst three answers, {name}:")
        for t, _ in rows[name][:3]:
            print(f"  {t!r}")


if __name__ == "__main__":
    main()
