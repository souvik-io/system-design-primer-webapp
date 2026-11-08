# quality_eval.py: measure what quantization did to a model, four ways (chapter 4.4).
#
# Makes several quantized versions of SmolLM2-135M with chapter 4.3's algorithms and compares each with the
# original on:
#   perplexity     WikiText-2 test, 40 windows of 1,024 tokens
#   KL divergence  mean KL(original || quantized) of the next-token distributions over the full vocabulary,
#                  on 20 of those windows
#   top-1 agree    share of positions where both models' most likely next token is the same
#   ARC-Easy       accuracy on the first 1,000 test questions (the answer with the highest log-likelihood per
#                  character, like lm-evaluation-harness's acc_norm), and "flips": questions answered correctly
#                  by one model and wrongly by the other, which an unchanged accuracy can hide
#
# Needs quant_math.py and ptq_algorithms.py in the same folder.
# Run: python quality_eval.py      (about 25 minutes on an M2)
import copy
import math

import torch
import torch.nn.functional as F

from ptq_algorithms import calibrate, quantize_model
from quant_math import fake_quant, linear_layers, load_model, quant_act, wikitext_windows

torch.manual_seed(0)


def arc_easy(tok, n: int = 1000):
    """ARC-Easy test questions as (context ids, [choice ids], answer index)."""
    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download

    rows = pq.read_table(hf_hub_download("allenai/ai2_arc", "ARC-Easy/test-00000-of-00001.parquet",
                                         repo_type="dataset")).to_pylist()[:n]
    out = []
    for r in rows:
        ctx = f"Question: {r['question']}\nAnswer:"
        n_ctx = len(tok(ctx).input_ids)
        choices = [tok(ctx + " " + c).input_ids for c in r["choices"]["text"]]
        out.append((n_ctx, choices, [len(c) + 1 for c in r["choices"]["text"]],
                    r["choices"]["label"].index(r["answerKey"])))
    return out


@torch.no_grad()
def arc_correct(model, questions, batch: int = 16) -> list[bool]:
    seqs = [(qi, ci, ids, n_ctx, chars) for qi, (n_ctx, choices, lens, _) in enumerate(questions)
            for ci, (ids, chars) in enumerate(zip(choices, lens))]
    scores = {}
    for i in range(0, len(seqs), batch):
        chunk = seqs[i : i + batch]
        width = max(len(s[2]) for s in chunk)
        ids = torch.zeros(len(chunk), width, dtype=torch.long)
        mask = torch.zeros(len(chunk), width, dtype=torch.long)
        for j, s in enumerate(chunk):
            ids[j, : len(s[2])] = torch.tensor(s[2])
            mask[j, : len(s[2])] = 1
        logp = F.log_softmax(model(ids, attention_mask=mask).logits.float(), dim=-1)
        for j, (qi, ci, seq, n_ctx, chars) in enumerate(chunk):
            target = torch.tensor(seq[n_ctx:])
            ll = logp[j, n_ctx - 1 : len(seq) - 1].gather(1, target[:, None]).sum().item()
            scores.setdefault(qi, {})[ci] = ll / chars
    return [max(scores[qi], key=scores[qi].get) == q[3] for qi, q in enumerate(questions)]


@torch.no_grad()
def compare(base, model, windows, kl_windows: int = 20, batch: int = 1):
    """Perplexity of `model`, and KL(base || model) and top-1 agreement over the first kl_windows windows.
    One window at a time: each full-vocabulary log-probability tensor of a 1,024-token window is 200 MB, and
    the KL needs several at once, so larger batches need several GB of memory."""
    nll = count = kl = agree = positions = 0.0
    for i in range(0, len(windows), batch):
        ids = windows[i : i + batch]
        lq = F.log_softmax(model(ids).logits[:, :-1].float(), dim=-1)
        nll -= lq.gather(2, ids[:, 1:, None]).sum().item()
        count += ids[:, 1:].numel()
        if i < kl_windows:
            lp = F.log_softmax(base(ids).logits[:, :-1].float(), dim=-1)
            kl += (lp.exp() * (lp - lq)).sum().item()
            agree += (lp.argmax(-1) == lq.argmax(-1)).sum().item()
            positions += lp.shape[0] * lp.shape[1]
    return math.exp(nll / count), kl / positions, agree / positions


def main() -> None:
    from transformers import __version__ as tv

    print(f"PyTorch {torch.__version__}, Transformers {tv}\n")
    base, tok = load_model()
    model = copy.deepcopy(base)
    layers = linear_layers(model)
    originals = {n: m.weight.data.clone() for n, m in layers.items()}
    stats = calibrate(base, wikitext_windows(tok, split="train", n=32, length=512))
    test = wikitext_windows(tok, split="test", n=40, length=1024)
    questions = arc_easy(tok)

    def set_weights(q: dict | None, act_mode: str | None = None):
        for n, m in layers.items():
            m.weight.data = originals[n] if q is None else q[n].to(originals[n].dtype)
        for m in layers.values():
            for h in getattr(m, "_lab_hooks", []):
                h.remove()
            m._lab_hooks = []
            if act_mode:
                m._lab_hooks.append(m.register_forward_pre_hook(lambda mod, inp: (quant_act(inp[0], act_mode),)))

    versions = [
        ("original (FP32 from BF16)", lambda: None, None),
        ("W8A16 INT8 per channel, RTN", lambda: {n: fake_quant(w, 8, True, None) for n, w in originals.items()}, None),
        ("W8A8 INT8, per-token activations", lambda: {n: fake_quant(w, 8, True, None) for n, w in originals.items()}, "per-token"),
        ("W4A16 g128, RTN", lambda: quantize_model(layers_view, stats, "rtn", 4), None),
        ("W4A16 g128, AWQ", lambda: quantize_model(layers_view, stats, "awq", 4), None),
        ("W4A16 g128, GPTQ", lambda: quantize_model(layers_view, stats, "gptq", 4), None),
        ("W3A16 g128, GPTQ", lambda: quantize_model(layers_view, stats, "gptq", 3), None),
    ]
    layers_view = linear_layers(base)          # the algorithms read the original weights from the base model

    base_correct = arc_correct(base, questions)
    print(f"{'version':<36}{'perplexity':>11}{'KL (nats)':>11}{'top-1 agree':>13}{'ARC-Easy':>10}{'flips':>8}{'net':>6}")
    for label, make, act in versions:
        set_weights(make(), act)
        ppl, kl, agree = compare(base, model, test)
        correct = base_correct if label.startswith("original") else arc_correct(model, questions)
        flips = sum(a != b for a, b in zip(correct, base_correct))
        net = sum(correct) - sum(base_correct)
        print(f"{label:<36}{ppl:>11.2f}{kl:>11.4f}{agree:>13.1%}{sum(correct) / len(correct):>10.1%}"
              f"{flips / len(correct):>8.1%}{net:>+6d}", flush=True)
    set_weights(None)
    print(f"\nARC-Easy: first {len(questions)} test questions. flips: share of questions whose right/wrong outcome")
    print("changed; net: change in the number answered correctly. KL and top-1 agreement over 20,460 positions.")


if __name__ == "__main__":
    main()
