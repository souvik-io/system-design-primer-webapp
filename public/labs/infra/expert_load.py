# expert_load.py: how a trained MoE router really spreads tokens over experts, measured on real text.
#
# Model: IBM Granite 3.1 1B-A400M (Apache 2.0), 24 layers of 32 experts with 8 chosen per token,
# 1.33B parameters in total. It is small enough for an 8 GB Mac and uses the same top-k routing as the
# large models. The first run downloads about 2.7 GB from Hugging Face.
#
# Text: English prose from Python's own documentation (pydoc_data) and Python source code from the
# standard library, so the script needs no dataset download.
#
# It prints four measurements:
#   1. load imbalance: the busiest expert's share of tokens against the even share, per layer;
#   2. specialisation: how differently the router treats prose and code;
#   3. experts touched by a decode batch of B tokens, against the even-routing formula E * (1 - (1 - k/E)^B);
#   4. tokens dropped by a fixed expert capacity, the Switch Transformer scheme, for several capacity factors.
#
# Run: python expert_load.py        (needs torch and transformers; about a minute on an M2)
import inspect
import json
import textwrap

import pydoc_data.topics
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = "ibm-granite/granite-3.1-1b-a400m-instruct"
TOKENS, CHUNK = 4096, 512          # tokens per text, and the sequence length fed to the model at once
torch.manual_seed(0)

device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float32 if device == "cpu" else torch.bfloat16
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=dtype).to(device).eval()
E, K, LAYERS = model.config.num_local_experts, model.config.num_experts_per_tok, model.config.num_hidden_layers

texts = {
    "prose": "\n\n".join(pydoc_data.topics.topics[k] for k in sorted(pydoc_data.topics.topics)),
    "code": "\n\n".join(inspect.getsource(m) for m in (json.decoder, json.encoder, textwrap, inspect)),
}


def route(text):
    """Top-k expert ids for every token and layer: a tensor [layers, tokens, K]."""
    ids = tok(text, return_tensors="pt").input_ids[0, :TOKENS]
    picks = []
    with torch.no_grad():
        for start in range(0, len(ids), CHUNK):
            out = model(ids[None, start:start + CHUNK].to(device), output_router_logits=True)
            # One [tokens, E] logit tensor per layer. Top-k of the logits is the same choice as top-k of the
            # softmax probabilities, because softmax keeps the order.
            picks.append(torch.stack([r.float().topk(K, dim=-1).indices.cpu() for r in out.router_logits]))
    return torch.cat(picks, dim=1)


routes = {name: route(text) for name, text in texts.items()}
counts = {name: torch.stack([torch.bincount(r[l].flatten(), minlength=E) for l in range(LAYERS)]).float()
          for name, r in routes.items()}                                        # [layers, E]

print(f"{MODEL}: {LAYERS} layers, {E} experts, top-{K}, {TOKENS:,} tokens of each text on {device}\n")
print("1. Load imbalance: the busiest expert's tokens divided by the even share (1.00 = perfectly even)")
print(f"{'layer':>5} {'prose':>6} {'code':>6}   busiest experts, prose | code")
for l in range(0, LAYERS, 3):
    row = [f"{l:5d}"]
    for name in ("prose", "code"):
        c = counts[name][l]
        row.append(f"{(c.max() / c.mean()).item():6.2f}")
    top = {name: counts[name][l].topk(3).indices.tolist() for name in ("prose", "code")}
    print(" ".join(row), f"  {top['prose']} | {top['code']}")
for name in ("prose", "code"):
    ratio = counts[name].max(1).values / counts[name].mean(1)
    idle = (counts[name] == 0).sum().item()
    print(f"{name}: mean over layers {ratio.mean():.2f}, worst layer {ratio.max():.2f}; "
          f"experts never chosen: {idle} of {E * LAYERS}")

p = {name: c / c.sum(1, keepdim=True) for name, c in counts.items()}
tvd = 0.5 * (p["prose"] - p["code"]).abs().sum(1)                              # 0 = same, 1 = disjoint
print("\n2. Specialisation: share of routing that differs between prose and code (total variation distance)")
print(f"mean over layers {tvd.mean():.2f}, lowest {tvd.min():.2f} (layer {tvd.argmin().item()}), "
      f"highest {tvd.max():.2f} (layer {tvd.argmax().item()})")

print(f"\n3. Experts touched per layer by a decode batch of B tokens from different places in the text")
both = torch.cat([routes["prose"], routes["code"]], dim=1)                    # [layers, tokens, K]
print(f"{'B':>4} {'measured':>9} {'even routing':>13}")
for b in (1, 2, 4, 8, 16, 32, 64):
    trials = [len(torch.unique(both[l, torch.randperm(both.shape[1])[:b]]))
              for l in range(LAYERS) for _ in range(20)]
    even = E * (1 - (1 - K / E) ** b)
    print(f"{b:4d} {sum(trials) / len(trials):9.1f} {even:13.1f}")

print("\n4. Tokens dropped when each expert takes at most capacity = factor x (tokens x K / E) per 256-token batch")
for factor in (1.0, 1.25, 1.5, 2.0):
    cap = int(factor * 256 * K / E)
    dropped = total = 0
    for name, r in routes.items():
        for l in range(LAYERS):
            for s in range(0, r.shape[1] - 255, 256):
                c = torch.bincount(r[l, s:s + 256].flatten(), minlength=E)
                dropped += (c - cap).clamp(min=0).sum().item()
                total += 256 * K
    print(f"factor {factor:4.2f}: capacity {cap:3d} slots per expert, {dropped / total:6.2%} of token-expert pairs dropped")
