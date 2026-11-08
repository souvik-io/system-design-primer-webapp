# ptq_algorithms.py: GPTQ, AWQ and SmoothQuant written from scratch and applied to a real model (chapter 4.3).
#
#   1. Runs SmolLM2-135M on calibration text (WikiText-2's training split) and records, for every linear layer,
#      the Hessian of its output error, H = 2 X^T X / n, the mean and largest magnitude of each input channel,
#      and a sample of its inputs.
#   2. On one layer, compares round-to-nearest (RTN), GPTQ and AWQ by the error of the weights and the error
#      of the layer's output. The algorithms trade the first for the second.
#   3. Quantizes the whole model's weights to INT4 and INT3 with each algorithm and prints the perplexity on
#      WikiText-2's test split.
#   4. Quantizes weights and activations to INT8 (W8A8) with and without SmoothQuant's smoothing.
#
# Needs quant_math.py (chapter 4.2) in the same folder. Chapter 4.4's quality_eval.py imports this file.
# Run: python ptq_algorithms.py     (about ten minutes on an M2)
import math

import torch

from quant_math import (fake_quant, linear_layers, load_model, perplexity, quant_act, quantize, quantized_weights,
                        wikitext_windows)

torch.manual_seed(0)
SAMPLE = 512          # input rows kept per layer for AWQ's search


# ---- 1. Calibration -------------------------------------------------------------------------------------------
@torch.no_grad()
def calibrate(model, windows: torch.Tensor) -> dict:
    """Run the model on calibration windows and collect, per linear layer: H = 2 X^T X / n, the mean |x| and
    the max |x| of each input channel, and SAMPLE random input rows."""
    stats = {}

    def hook(name):
        def fn(mod, inputs):
            x = inputs[0].reshape(-1, inputs[0].shape[-1]).float()
            s = stats.setdefault(name, {"H": torch.zeros(x.shape[1], x.shape[1]), "n": 0,
                                        "absmean": torch.zeros(x.shape[1]), "absmax": torch.zeros(x.shape[1]),
                                        "sample": []})
            s["H"] += 2 * x.T @ x
            s["absmean"] += x.abs().sum(0)
            s["absmax"] = torch.maximum(s["absmax"], x.abs().amax(0))
            s["n"] += x.shape[0]
            s["sample"].append(x[torch.randperm(x.shape[0])[: SAMPLE // 4]])
        return fn

    handles = [m.register_forward_pre_hook(hook(n)) for n, m in linear_layers(model).items()]
    for i in range(0, len(windows), 4):
        model(windows[i : i + 4])
    for h in handles:
        h.remove()
    for s in stats.values():
        s["H"] /= s["n"]
        s["absmean"] /= s["n"]
        s["sample"] = torch.cat(s["sample"])[:SAMPLE]
    return stats


# ---- 2. The algorithms ----------------------------------------------------------------------------------------
def rtn(w: torch.Tensor, bits: int, group: int) -> torch.Tensor:
    """Round to nearest: every weight independently, asymmetric, one scale and zero per group."""
    return fake_quant(w, bits, False, group)


def gptq(w: torch.Tensor, H: torch.Tensor, bits: int, group: int, act_order: bool = False, block: int = 128,
         damp: float = 0.01) -> torch.Tensor:
    """GPTQ (Frantar et al., 2022). Quantize the columns of W (the input dimension) one at a time, and after each,
    spread its rounding error over the columns not yet quantized, weighted by the inverse Hessian, so that the
    layer's output X W^T changes as little as possible. Works on blocks of 128 columns at a time and uses the
    Cholesky factor of H^-1, as the paper does. Group scales are set from the already-updated weights when the
    loop reaches the first column of each group."""
    W = w.clone().float()
    H = H.clone()
    cols = W.shape[1]
    dead = torch.diag(H) == 0                  # inputs that were always zero: their weights do not matter
    H[dead, dead] = 1
    W[:, dead] = 0
    if act_order:                              # quantize the columns with the largest inputs first
        perm = torch.argsort(torch.diag(H), descending=True)
        W, H = W[:, perm], H[perm][:, perm]
    H += damp * torch.mean(torch.diag(H)) * torch.eye(cols)     # dampening: 1% of the mean diagonal
    Hinv = torch.linalg.cholesky(torch.cholesky_inverse(torch.linalg.cholesky(H)), upper=True)

    Q = torch.zeros_like(W)
    scale = zero = None
    group_of = (perm if act_order else torch.arange(cols)) // group   # each column's group in the original order
    params = {}
    for i1 in range(0, cols, block):
        i2 = min(i1 + block, cols)
        W1, Hinv1 = W[:, i1:i2].clone(), Hinv[i1:i2, i1:i2]
        Err1 = torch.zeros_like(W1)
        for i in range(i2 - i1):
            col = i1 + i
            g = int(group_of[col])
            if g not in params:                # first column of this group reached: fix its scale and zero
                if act_order:
                    members = (group_of == g).nonzero().flatten()
                    current = torch.cat([W[:, :i1], W1, W[:, i2:]], dim=1)[:, members]
                else:
                    current = torch.cat([W1[:, i:], W[:, i2:]], dim=1)[:, :group]
                _, scale, zero = quantize(current, bits, False, current.shape[1])
                params[g] = (scale, zero)
            scale, zero = params[g]
            qmax = 2**bits - 1
            q = (torch.clamp(torch.round(W1[:, i : i + 1] / scale) + zero, 0, qmax) - zero) * scale
            Q[:, col] = q.flatten()
            err = (W1[:, i] - q.flatten()) / Hinv1[i, i]
            W1[:, i:] -= err.unsqueeze(1) @ Hinv1[i, i:].unsqueeze(0)
            Err1[:, i] = err
        W[:, i2:] -= Err1 @ Hinv[i1:i2, i2:]
    if act_order:
        Q = Q[:, torch.argsort(perm)]
    return Q


def awq_scales(ws: list, x: torch.Tensor, absmean: torch.Tensor, bits: int, group: int, grid: int = 20):
    """AWQ (Lin et al., 2023). Scale input channel j of the weights up by s_j = mean|x_j|^alpha (and its input
    down by s_j, folded into the previous operation), so that the channels with large activations, whose
    weights matter most, lose less to rounding. alpha is chosen by grid search over 0, 0.05, ..., 0.95 to
    minimize the output error on a sample of real inputs. Layers that read the same input share one s."""
    ref = torch.cat([x @ w.T for w in ws], dim=1)
    best = (float("inf"), None, None)
    for i in range(grid):
        alpha = i / grid
        s = absmean.clamp(min=1e-4).pow(alpha)
        s = s / (s.max() * s.min()).sqrt()                 # keep the scales centred on 1
        out = torch.cat([(x / s) @ rtn(w * s, bits, group).T for w in ws], dim=1)
        err = (out - ref).pow(2).mean().item()
        if err < best[0]:
            best = (err, alpha, s)
    return best[2], best[1]


# Layers that read the same input share AWQ and SmoothQuant scales, since one previous operation
# (a norm, v_proj or up_proj) absorbs the division.
SIBLINGS = [("self_attn.q_proj", "self_attn.k_proj", "self_attn.v_proj"), ("self_attn.o_proj",),
            ("mlp.gate_proj", "mlp.up_proj"), ("mlp.down_proj",)]


def can_scale(layers: dict, names: list[str]) -> bool:
    """Whether a group's input channels can be rescaled for free. The norms before q/k/v and gate/up, and up_proj
    before down_proj, can always absorb the division. v_proj can absorb o_proj's scales only if it has as many
    outputs as o_proj has inputs; with grouped-query attention, as in SmolLM2 and Llama 3, it has fewer, because
    each key-value head serves several query heads. AutoAWQ and llm-compressor then leave o_proj unscaled."""
    if not names[0].endswith("self_attn.o_proj"):
        return True
    return layers[names[0].replace("o_proj", "v_proj")].out_features == layers[names[0]].in_features


def groups_of(layers: dict):
    prefixes = sorted({n.rsplit(".", 2)[0] for n in layers}, key=lambda p: int(p.split(".")[-1]))
    for p in prefixes:
        for sib in SIBLINGS:
            yield [f"{p}.{s}" for s in sib]


def quantize_model(layers: dict, stats: dict, method: str, bits: int, group: int = 128) -> dict:
    """Return {layer name: fake-quantized weight} for the whole model with one method. For AWQ, the stored
    weight is Q(W s) / s: the quantized scaled weight with the scale folded back, which is what the model
    computes once X / s is folded into the previous operation."""
    out, alphas = {}, []
    for names in groups_of(layers):
        ws = [layers[n].weight.data.float() for n in names]
        if method == "rtn":
            qs = [rtn(w, bits, group) for w in ws]
        elif method in ("gptq", "gptq-act-order"):
            H = stats[names[0]]["H"]
            qs = [gptq(w, H, bits, group, act_order=method == "gptq-act-order") for w in ws]
        elif method == "awq" and not can_scale(layers, names):
            qs = [rtn(w, bits, group) for w in ws]
        elif method == "awq":
            st = stats[names[0]]
            s, alpha = awq_scales(ws, st["sample"], st["absmean"], bits, group)
            alphas.append(alpha)
            qs = [rtn(w * s, bits, group) / s for w in ws]
        else:
            raise ValueError(method)
        out.update(dict(zip(names, qs)))
    if alphas:
        print(f"      AWQ alpha chosen per layer group: mean {sum(alphas) / len(alphas):.2f}, "
              f"range {min(alphas):.2f} to {max(alphas):.2f}")
    return out


# ---- 3. SmoothQuant ---------------------------------------------------------------------------------------------
def smooth_scales(layers: dict, stats: dict, alpha: float) -> dict:
    """SmoothQuant (Xiao et al., 2022): s_j = max|X_j|^alpha / max|W_j|^(1 - alpha), per input channel j, with
    max|W_j| taken over every layer that reads that input. Dividing X by s and multiplying W by s leaves X W^T
    unchanged but moves the outliers' range from the activations into the weights."""
    scales = {}
    for names in groups_of(layers):
        if not can_scale(layers, names):
            continue
        xmax = stats[names[0]]["absmax"].clamp(min=1e-5)
        wmax = torch.stack([layers[n].weight.data.float().abs().amax(0) for n in names]).amax(0).clamp(min=1e-5)
        s = (xmax.pow(alpha) / wmax.pow(1 - alpha)).clamp(min=1e-5)
        for n in names:
            scales[n] = s
    return scales


@torch.no_grad()
def w8a8_perplexity(model, windows, act_mode: str, scales: dict | None = None) -> float:
    """Perplexity with INT8 per-channel weights and INT8 activations, optionally smoothed first."""
    layers = linear_layers(model)
    handles = []
    scales = scales or {}                      # layers without a scale (o_proj, see can_scale) are not smoothed
    for n, m in layers.items():
        s = scales.get(n)
        handles.append(m.register_forward_pre_hook(
            lambda mod, inp, s=s: (quant_act(inp[0] / s if s is not None else inp[0], act_mode),)))
    fn = lambda n, w: fake_quant(w * scales[n] if n in scales else w, 8, True, None)
    with quantized_weights(model, fn):
        p = perplexity(model, windows)
    for h in handles:
        h.remove()
    return p


# ---- The lab ----------------------------------------------------------------------------------------------------
def one_layer(layers: dict, stats: dict, name: str) -> None:
    w = layers[name].weight.data.float()
    st = stats[name]
    x = st["sample"]
    ref = x @ w.T
    print(f"2. One layer: {name[6:]}, {tuple(w.shape)}, INT4 group 128, judged on {len(x)} of its calibration inputs")
    print(f"   {'method':<22}{'weight error':>14}{'output error':>14}")
    s, alpha = awq_scales([w], x, st["absmean"], 4, 128)
    for label, q, xin in [("RTN", rtn(w, 4, 128), x),
                          ("GPTQ", gptq(w, st["H"], 4, 128), x),
                          ("GPTQ, act-order", gptq(w, st["H"], 4, 128, act_order=True), x),
                          (f"AWQ (alpha {alpha:.2f})", rtn(w * s, 4, 128) / s, x)]:
        we = ((q - w).norm() / w.norm()).item()
        oe = ((xin @ q.T - ref).norm() / ref.norm()).item()
        print(f"   {label:<22}{we:>14.2%}{oe:>14.2%}")
    print("   GPTQ accepts more weight error to cancel the output error; AWQ leaves the important channels finer.\n")


if __name__ == "__main__":
    from transformers import __version__ as tv

    print(f"PyTorch {torch.__version__}, Transformers {tv}\n")
    model, tok = load_model()
    layers = linear_layers(model)
    calib = wikitext_windows(tok, split="train", n=32, length=512)
    stats = calibrate(model, calib)
    print(f"1. Calibrated on {calib.numel():,} tokens of WikiText-2 train: {len(stats)} layers, Hessians up to "
          f"{max(s['H'].shape[0] for s in stats.values())} x {max(s['H'].shape[0] for s in stats.values())}\n")
    one_layer(layers, stats, "model.layers.15.mlp.down_proj")

    test = wikitext_windows(tok, split="test", n=40, length=1024)
    base = perplexity(model, test)
    print(f"3. Weight-only quantization of every linear layer, group 128, asymmetric; WikiText-2 test perplexity")
    print(f"   {'method':<26}{'INT4':>18}{'INT3':>18}")
    print(f"   {'none (FP32)':<26}{base:>18.2f}")
    for method in ("rtn", "gptq", "gptq-act-order", "awq"):
        cells = []
        for bits in (4, 3):
            q = quantize_model(layers, stats, method, bits)
            with quantized_weights(model, lambda n, w: q[n].to(w.dtype)):
                p = perplexity(model, test)
            cells.append(f"{p:>9.2f} ({p / base - 1:+.0%})")
        print(f"   {method:<26}{cells[0]:>18}{cells[1]:>18}")

    print("\n4. W8A8: INT8 per-channel weights and INT8 activations; WikiText-2 test perplexity")
    print(f"   {'smoothing':<26}{'per-tensor acts':>18}{'per-token acts':>18}")
    for label, alpha in [("none", None), ("SmoothQuant alpha 0.5", 0.5), ("SmoothQuant alpha 0.8", 0.8)]:
        scales = smooth_scales(layers, stats, alpha) if alpha is not None else None
        cells = [w8a8_perplexity(model, test, mode, scales) for mode in ("per-tensor", "per-token")]
        print(f"   {label:<26}" + "".join(f"{f'{p:.2f} ({p / base - 1:+.0%})':>18}" for p in cells))
