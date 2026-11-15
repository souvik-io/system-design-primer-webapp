# spec_decode_sim.py: chapter 5.4's lab without a GPU. Standard library only.
#
# 1. The acceptance rule of speculative sampling on small made-up distributions, with a draft that samples and with
#    a draft that always proposes its most likely token (what vLLM does by default), checked against sampling from
#    the target directly.
# 2. Tokens per target pass: the capped geometric formula against simulation.
# 3. A prompt-lookup (n-gram) proposer, replayed over real prompts and the real greedy answers of Llama 3.1 8B
#    (gpu/spec_decode_traces.json, written by gpu/spec_decode_bench.py). With greedy decoding a draft token is
#    accepted exactly when it equals the token the target went on to produce, so the replay needs no model.
# 4. The cost of a pass: from the benchmark's three "synthetic" rows, how much longer a target pass takes when it
#    also verifies draft tokens, and the acceptance length at which speculation breaks even at each concurrency.
#
#   python spec_decode_sim.py            # a few seconds
#   python spec_decode_sim.py --test     # only the self-checks
import argparse
import json
import random
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent


# ---------------------------------------------------------------------------------------- 1. the acceptance rule

def sample(dist: list[float], rng: random.Random) -> int:
    return rng.choices(range(len(dist)), weights=dist)[0]


def residual(p: list[float], q: list[float]) -> list[float]:
    """norm(max(0, p - q)): the distribution a rejected position is resampled from."""
    r = [max(0.0, a - b) for a, b in zip(p, q)]
    total = sum(r)
    return [x / total for x in r]


def speculative_token(p: list[float], q: list[float], rng: random.Random, greedy_draft: bool = False) -> tuple[int, bool]:
    """One position of speculative sampling. p is the target's distribution and q the draft's. Returns the token
    and whether the draft's proposal was accepted.

    With greedy_draft the draft proposes its argmax and q is replaced by a one-hot distribution on that token: the
    proposal is accepted with probability p(x), and a rejection resamples from p with x removed."""
    if greedy_draft:
        x = max(range(len(q)), key=q.__getitem__)
        q = [1.0 if i == x else 0.0 for i in range(len(q))]
    else:
        x = sample(q, rng)
    if rng.random() < min(1.0, p[x] / q[x]):
        return x, True
    return sample(residual(p, q), rng), False


def acceptance_probability(p: list[float], q: list[float], greedy_draft: bool = False) -> float:
    if greedy_draft:
        return p[max(range(len(q)), key=q.__getitem__)]
    return sum(min(a, b) for a, b in zip(p, q))


def speculative_generate(target, draft, length: int, k: int, rng: random.Random, greedy_draft: bool = False) -> tuple[list[int], int]:
    """Generate `length` tokens with k draft tokens per target pass. target(prefix) and draft(prefix) return a
    distribution over the next token. Returns the tokens and the number of target passes."""
    out: list[int] = []
    passes = 0
    while len(out) < length:
        passes += 1
        prefix = list(out)
        proposals = []
        for _ in range(k):                                  # the draft runs k times on its own proposals
            q = draft(prefix)
            x = max(range(len(q)), key=q.__getitem__) if greedy_draft else sample(q, rng)
            proposals.append((x, q))
            prefix.append(x)
        for x, q in proposals:                              # one target pass scores all k + 1 positions
            p = target(out)
            if greedy_draft:
                q = [1.0 if i == x else 0.0 for i in range(len(q))]
            if rng.random() < min(1.0, p[x] / q[x]):
                out.append(x)
            else:
                out.append(sample(residual(p, q), rng))
                break
        else:
            out.append(sample(target(out), rng))            # every draft token accepted: one more from the target
    return out[:length], passes


# ---------------------------------------------------------------------------------------- 2. tokens per pass

def expected_tokens(alpha: float, k: int) -> float:
    """Leviathan et al., Equation 1: each draft token accepted independently with probability alpha."""
    return k + 1.0 if alpha >= 1 else (1 - alpha ** (k + 1)) / (1 - alpha)


def simulate_tokens(alpha: float, k: int, passes: int, rng: random.Random) -> float:
    total = 0
    for _ in range(passes):
        accepted = 0
        while accepted < k and rng.random() < alpha:
            accepted += 1
        total += accepted + 1
    return total / passes


def paper_speedup(alpha: float, k: int, c: float) -> float:
    """Leviathan et al., Theorem 3.8: a draft step costs c target passes, and verifying is free."""
    return expected_tokens(alpha, k) / (k * c + 1)


# ---------------------------------------------------------------------------------------- 3. prompt lookup

def ngram_propose(context: list[int], k: int, min_n: int, max_n: int) -> list[int]:
    """vLLM's n-gram proposer in plain Python. Take the longest suffix of the context, between min_n and max_n
    tokens, that also occurs earlier in the context, and propose the k tokens that followed its earliest
    occurrence."""
    total = len(context)
    for n in range(min(max_n, total - 1), min_n - 1, -1):
        suffix = context[total - n:]
        for start in range(total - n):                      # earliest occurrence that is not the suffix itself
            if context[start:start + n] == suffix:
                return context[start + n:start + n + k]
    return []


def replay(prompt: list[int], output: list[int], propose) -> dict:
    """Decode `output` again with a proposer, as greedy speculative decoding would. The first pass is the prefill
    and emits one token. After each pass the proposer sees everything so far and drafts for the next pass, which
    emits the accepted draft tokens and one more."""
    done, passes, drafts, drafted, accepted = 1, 1, 0, 0, 0
    while done < len(output):
        draft = propose(prompt + output[:done])
        n = 0
        while n < len(draft) and done + n < len(output) and draft[n] == output[done + n]:
            n += 1
        if draft:
            drafts, drafted, accepted = drafts + 1, drafted + len(draft), accepted + n
        done += min(n + 1, len(output) - done)
        passes += 1
    return {"tokens": len(output), "passes": passes, "drafts": drafts, "drafted": drafted, "accepted": accepted}


def replay_all(traces: list[dict], k: int, min_n: int, max_n: int) -> dict:
    tot = Counter()
    for t in traces:
        tot.update(replay(t["prompt"], t["output"], lambda ctx: ngram_propose(ctx, k, min_n, max_n)))
    return {"tokens_per_pass": tot["tokens"] / tot["passes"],
            "acceptance_length": 1 + tot["accepted"] / max(tot["drafts"], 1),      # what vLLM reports
            "acceptance_rate": tot["accepted"] / max(tot["drafted"], 1),
            "passes_with_draft": tot["drafts"] / tot["passes"]}


# ---------------------------------------------------------------------------------------- self-checks

def distance(counts: Counter, dist: dict, n: int) -> float:
    keys = set(counts) | set(dist)
    return max(abs(counts.get(key, 0) / n - dist.get(key, 0.0)) for key in keys)


def self_checks() -> None:
    rng = random.Random(0)
    p = [0.50, 0.20, 0.15, 0.10, 0.05]
    q = [0.25, 0.45, 0.10, 0.05, 0.15]
    n = 200_000
    for greedy in (False, True):
        tokens, accepted = Counter(), 0
        for _ in range(n):
            x, ok = speculative_token(p, q, rng, greedy)
            tokens[x] += 1
            accepted += ok
        assert distance(tokens, dict(enumerate(p)), n) < 0.005, "the output must follow the target's distribution"
        assert abs(accepted / n - acceptance_probability(p, q, greedy)) < 0.005

    # Sequences: a target and a draft whose next-token distributions depend on the previous token.
    table = random.Random(1)
    rows = lambda: [[w / sum(ws) for w in ws] for ws in ([table.random() for _ in range(4)] for _ in range(5))]
    tp, tq = rows(), rows()
    target = lambda prefix: tp[prefix[-1] + 1 if prefix else 0]
    draft = lambda prefix: tq[prefix[-1] + 1 if prefix else 0]
    exact: dict = {}
    for a in range(4):
        for b in range(4):
            for c in range(4):
                exact[(a, b, c)] = tp[0][a] * tp[a + 1][b] * tp[b + 1][c]
    for greedy in (False, True):
        seen = Counter(tuple(speculative_generate(target, draft, 3, 3, rng, greedy)[0]) for _ in range(n))
        assert distance(seen, exact, n) < 0.005, "three-token sequences must follow the target's distribution"

    for alpha, k in [(0.8, 4), (0.6, 5), (0.3, 3)]:
        assert abs(simulate_tokens(alpha, k, n, rng) - expected_tokens(alpha, k)) < 0.02
    assert abs(paper_speedup(0.8, 5, 0.0) - 3.69) < 0.005          # a row of the paper's Table 1

    assert ngram_propose([1, 2, 3, 4, 5, 9, 2, 3], 3, 2, 5) == [4, 5, 9]
    assert ngram_propose([1, 2, 3, 4, 7, 2, 3, 8, 2, 3], 2, 2, 5) == [4, 7]       # the earliest occurrence wins
    assert ngram_propose([7, 2, 3, 4, 9, 1, 2, 3, 4], 2, 2, 5) == [9, 1]           # the longest match wins
    assert ngram_propose([1, 2, 3, 4], 3, 2, 5) == []
    assert ngram_propose([5, 5, 5], 4, 1, 2) == [5]                                # a match may overlap the suffix
    r = replay([1, 2, 3, 4, 5, 6], [2, 3, 4, 5, 6, 7], lambda ctx: ngram_propose(ctx, 3, 1, 3))
    assert r == {"tokens": 6, "passes": 3, "drafts": 2, "drafted": 6, "accepted": 3}, r
    print("all checks passed")


# ---------------------------------------------------------------------------------------- the report

def report_rule() -> None:
    p = [0.50, 0.20, 0.15, 0.10, 0.05]
    q = [0.25, 0.45, 0.10, 0.05, 0.15]
    rng = random.Random(2)
    n = 200_000
    print("\nOne position, target p = %s, draft q = %s" % (p, q))
    print("    draft proposes          accepted, predicted  accepted, measured   output distribution, measured")
    for greedy, name in ((False, "a sample from q"), (True, "its most likely token")):
        tokens, accepted = Counter(), 0
        for _ in range(n):
            x, ok = speculative_token(p, q, rng, greedy)
            tokens[x] += 1
            accepted += ok
        measured = " ".join(f"{tokens[i] / n:.3f}" for i in range(len(p)))
        print(f"    {name:<22}  {acceptance_probability(p, q, greedy):>19.3f}  {accepted / n:>18.3f}   {measured}")


def report_tokens() -> None:
    rng = random.Random(3)
    print("\nTokens per target pass, (1 - a^(k+1)) / (1 - a), and in brackets a simulation of 100,000 passes")
    ks = (1, 3, 5, 8)
    print("    acceptance a   " + "".join(f"k = {k:<14}" for k in ks))
    for alpha in (0.3, 0.5, 0.7, 0.8, 0.9):
        cells = "".join(f"{expected_tokens(alpha, k):.2f} ({simulate_tokens(alpha, k, 100_000, rng):.2f})     " for k in ks)
        print(f"    {alpha:<14} {cells}")
    print("\nThe paper's speed-up, tokens per pass / (k c + 1), for a draft that costs c target passes per token")
    print("    a = 0.7        " + "".join(f"k = {k:<8}" for k in ks))
    for c in (0.0, 0.05, 0.15, 0.3):
        print(f"    c = {c:<10} " + "".join(f"{paper_speedup(0.7, k, c):<12.2f}" for k in ks))


def measured_ngram() -> dict:
    """vLLM's own acceptance length for its n-gram proposer at concurrency 1, if the benchmark's results are here."""
    path = HERE / "gpu" / "spec_decode_h100.json"
    if not path.exists():
        return {}
    for config in json.loads(path.read_text())["configs"]:
        if config["config"] == "ngram":
            return {r["workload"]: r["spec"] for r in config.get("runs", []) if r["concurrency"] == 1 and r["spec"]}
    return {}


def report_lookup() -> None:
    path = HERE / "gpu" / "spec_decode_traces.json"
    if not path.exists():
        print(f"\n{path.name} is missing: run gpu/spec_decode_bench.py, or download the file from the chapter")
        return
    traces = json.loads(path.read_text())
    measured = measured_ngram()
    for name, title in (("chat", "chat: open questions"), ("code", "code: return the file with one change")):
        ts = traces[name]
        tokens = sum(len(t["output"]) for t in ts)
        print(f"\nPrompt lookup replayed on {len(ts)} answers of Llama 3.1 8B, {title} ({tokens:,} output tokens)")
        print("    draft tokens k  match length  tokens per pass  passes with a draft  acceptance length  drafted tokens accepted")
        for k, lo, hi in ((5, 2, 5), (5, 1, 5), (5, 5, 5), (3, 2, 5), (10, 2, 5), (20, 2, 5), (20, 5, 5)):
            r = replay_all(ts, k, lo, hi)
            print(f"    {k:>14}  {f'{lo} to {hi}':>12}  {r['tokens_per_pass']:>15.2f}  {r['passes_with_draft']:>18.0%}"
                  f"  {r['acceptance_length']:>17.2f}  {r['acceptance_rate']:>22.0%}")
        if name in measured:
            m = measured[name]
            print(f"    vLLM measured, k = 5 and match length 2 to 5, on its own {name} run at concurrency 1: "
                  f"acceptance length {m['mean_acceptance_length']:.2f}, {m['draft_acceptance_rate']:.0%} of drafted tokens accepted")


def report_cost() -> None:
    path = HERE / "gpu" / "spec_decode_h100.json"
    if not path.exists():
        return
    data = json.loads(path.read_text())
    runs = {c["config"]: {(r["workload"], r["concurrency"]): r for r in c.get("runs", [])} for c in data["configs"]}
    if "off" not in runs or "synthetic 2.5" not in runs:
        return
    print(f"\nWhat a pass costs with 3 draft tokens from the EAGLE-3 head ({data['gpu']}, chat workload)")
    print("    The synthetic rows fix the acceptance length L, so (pass with speculation) / (plain pass) = L / speed-up.")
    print("    concurrency  plain tok/s  " + "".join(f"L = {L}: speed-up, cost   " for L in (1.0, 2.5, 4.0)) + "break-even L")
    for b in sorted({key[1] for key in runs["off"] if key[0] == "chat"}):
        base = runs["off"][("chat", b)]["output_tok_s"]
        cells, costs = "", []
        for L in (1.0, 2.5, 4.0):
            r = runs.get(f"synthetic {L}", {}).get(("chat", b))
            if not r:
                continue
            actual = r["spec"]["mean_acceptance_length"]
            speedup = r["output_tok_s"] / base
            costs.append(actual / speedup)
            cells += f"{speedup:>10.2f}x, {actual / speedup:>5.2f}       "
        print(f"    {b:>11}  {base:>11,.0f}  {cells}{sum(costs) / len(costs):>8.2f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true", help="run only the self-checks")
    a = ap.parse_args()
    self_checks()
    if a.test:
        return
    report_rule()
    report_tokens()
    report_lookup()
    report_cost()


if __name__ == "__main__":
    main()
