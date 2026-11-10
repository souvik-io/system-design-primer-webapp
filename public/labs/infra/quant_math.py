# quant_math.py: the arithmetic of quantization from chapter 4.2, written from scratch and tried on a real model.
#
#   1. Quantizes eight numbers by hand, symmetric and asymmetric, and prints every intermediate value.
#   2. Quantizes every linear weight of SmolLM2-135M to INT8 and INT4 with one scale per tensor, per output
#      channel and per group of 256 to 32 weights, symmetric and asymmetric, and prints the error and the real
#      bits per weight, scales and zero-points included.
#   3. Clips: searches each group's range for the one with the least squared error.
#   4. Packs an INT4 layer two codes to a byte, writes the dequantize-then-multiply, and checks it.
#   5. Records the inputs of every linear layer on WikiText-2 text and measures how outliers in activations
#      affect INT8 activation quantization, with one scale per tensor, one per token, and with the outlier
#      columns kept in 16 bits as LLM.int8() does.
#   6. Runs the model with each scheme applied and prints its perplexity on WikiText-2.
#
# Chapters 4.3 and 4.4 import the helpers below, so keep this file next to theirs.
#
# Run: python quant_math.py     (needs torch, transformers, safetensors, huggingface_hub and pyarrow; about
#                                eight minutes on an M2 after a 270 MB model and a 1 MB dataset download)
import math

import torch

torch.manual_seed(0)
MODEL = "HuggingFaceTB/SmolLM2-135M"          # Apache 2.0, 135M parameters, 30 layers


# ---- The arithmetic -------------------------------------------------------------------------------------------
def quantize(w: torch.Tensor, bits: int, sym: bool = True, group: int | None = None, clip: float | torch.Tensor = 1.0):
    """Quantize a (rows, cols) matrix to `bits`-bit integers.

    group=None gives one scale per row (per output channel), group=-1 one scale for the whole tensor, and group=g
    one scale per run of g consecutive values along a row. Symmetric: the codes run from -2^(b-1) to 2^(b-1) - 1
    and the largest magnitude maps to 2^(b-1) - 1, so zero is exactly representable and no zero-point is stored.
    Asymmetric: the codes run from 0 to 2^b - 1, the group's minimum maps to 0 and its maximum to 2^b - 1, and
    an integer zero-point records which code means 0.0. `clip` shrinks the range before the scale is chosen.

    Returns (codes, scale, zero) with codes shaped (rows * cols / g, g) and one scale and zero per group."""
    if group == -1:
        g = w.numel()
    else:
        g = w.shape[1] if group is None else group
    x = w.reshape(-1, g).float()
    if sym:
        qmax = 2 ** (bits - 1) - 1
        scale = (x.abs().amax(dim=1, keepdim=True) * clip / qmax).clamp(min=1e-10)
        zero = torch.zeros_like(scale)
        codes = torch.clamp(torch.round(x / scale), -qmax - 1, qmax)
    else:
        qmax = 2**bits - 1
        lo = x.amin(dim=1, keepdim=True).clamp(max=0) * clip       # keep 0.0 inside the range
        hi = x.amax(dim=1, keepdim=True).clamp(min=0) * clip
        scale = ((hi - lo) / qmax).clamp(min=1e-10)
        zero = torch.round(-lo / scale)
        codes = torch.clamp(torch.round(x / scale) + zero, 0, qmax)
    return codes, scale, zero


def dequantize(codes: torch.Tensor, scale: torch.Tensor, zero: torch.Tensor, shape) -> torch.Tensor:
    return ((codes - zero) * scale).reshape(shape)


def fake_quant(w: torch.Tensor, bits: int, sym: bool = True, group: int | None = None, clip=1.0) -> torch.Tensor:
    """Quantize and dequantize: the weights the quantized model effectively uses, in floating point."""
    return dequantize(*quantize(w, bits, sym, group, clip), w.shape).to(w.dtype)


def bits_per_weight(bits: int, sym: bool, group: int | None, cols: int) -> float:
    """Storage cost including metadata: an FP16 scale per group, plus a `bits`-bit zero-point if asymmetric."""
    g = cols if group is None else group
    if group == -1:
        return float(bits)
    return bits + (16 + (0 if sym else bits)) / g


def best_clip(w: torch.Tensor, bits: int, sym: bool, group: int | None, ratios=None) -> torch.Tensor:
    """For each group, the clip ratio (from 1.0 down to 0.5) whose quantized group has the least squared error."""
    ratios = ratios if ratios is not None else torch.linspace(1.0, 0.5, 21)
    g = w.shape[1] if group is None else group
    x = w.reshape(-1, g).float()
    best_err = torch.full((x.shape[0], 1), float("inf"))
    best = torch.ones(x.shape[0], 1)
    for r in ratios:
        err = (dequantize(*quantize(x, bits, sym, g, float(r)), x.shape) - x).pow(2).sum(1, keepdim=True)
        better = err < best_err
        best_err = torch.where(better, err, best_err)
        best = torch.where(better, r, best)
    return best


# ---- Loading the model and text -------------------------------------------------------------------------------
def load_model(name: str = MODEL):
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(name)
    model = AutoModelForCausalLM.from_pretrained(name, dtype=torch.float32).eval()
    return model, tok


def wikitext_windows(tok, split: str = "test", n: int = 40, length: int = 1024) -> torch.Tensor:
    """The first n windows of `length` tokens of WikiText-2 (raw), joined the way most perplexity scripts do."""
    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download

    path = hf_hub_download("Salesforce/wikitext", f"wikitext-2-raw-v1/{split}-00000-of-00001.parquet",
                           repo_type="dataset")
    text = "\n\n".join(pq.read_table(path).column("text").to_pylist())
    ids = tok(text, return_tensors="pt").input_ids[0]
    n = min(n, ids.numel() // length)
    return ids[: n * length].view(n, length)


def linear_layers(model) -> dict:
    """Every nn.Linear inside the decoder layers (the tied embedding / LM head is left in full precision)."""
    return {name: m for name, m in model.named_modules() if isinstance(m, torch.nn.Linear) and "lm_head" not in name}


@torch.no_grad()
def perplexity(model, windows: torch.Tensor, batch: int = 4) -> float:
    nll, count = 0.0, 0
    for i in range(0, len(windows), batch):
        ids = windows[i : i + batch]
        logits = model(ids).logits[:, :-1].float()
        nll += torch.nn.functional.cross_entropy(logits.reshape(-1, logits.shape[-1]), ids[:, 1:].reshape(-1),
                                                 reduction="sum").item()
        count += ids[:, 1:].numel()
    return math.exp(nll / count)


class quantized_weights:
    """Context manager: replace every linear weight with fn(weight) and restore the originals on exit."""

    def __init__(self, model, fn):
        self.layers, self.fn, self.saved = linear_layers(model), fn, {}

    def __enter__(self):
        for name, m in self.layers.items():
            self.saved[name] = m.weight.data
            m.weight.data = self.fn(name, m.weight.data)

    def __exit__(self, *exc):
        for name, m in self.layers.items():
            m.weight.data = self.saved[name]


# ---- Activation quantization ----------------------------------------------------------------------------------
def quant_act(x: torch.Tensor, mode: str, threshold: float = 6.0) -> torch.Tensor:
    """Fake-quantize activations (tokens, features) to INT8, symmetric.
    per-tensor: one scale for the whole matrix, set by its largest value (dynamic, recomputed for every input).
    per-token: one scale per row, so one token's outlier does not coarsen the others.
    decomposed: LLM.int8(): feature columns with any value of magnitude >= threshold stay in 16-bit; the rest
                are quantized per token."""
    if mode == "per-tensor":
        return fake_quant(x, 8, True, -1)
    if mode == "per-token":
        return fake_quant(x, 8, True, None)
    if mode == "decomposed":
        outlier = (x.abs() >= threshold).any(dim=0)
        q = fake_quant(x * ~outlier, 8, True, None)
        return torch.where(outlier, x, q)
    raise ValueError(mode)


# ---- The parts of the lab -------------------------------------------------------------------------------------
def part1() -> None:
    w = torch.tensor([[-0.31, 0.05, 0.12, -0.02, 0.44, 0.09, -0.15, 0.27]])
    print("1. Eight weights quantized to INT4 by hand")
    print(f"   weights      {[round(v, 2) for v in w[0].tolist()]}")
    for sym in (True, False):
        codes, scale, zero = quantize(w, 4, sym, -1)
        back = dequantize(codes, scale, zero, w.shape)
        kind = "symmetric " if sym else "asymmetric"
        print(f"   {kind}   scale {scale.item():.4f}  zero-point {int(zero.item()):>2}  codes {[int(c) for c in codes[0]]}")
        print(f"                dequantized {[round(v, 3) for v in back[0].tolist()]}"
              f"  RMS error {(back - w).pow(2).mean().sqrt().item():.4f}")
    print("   Symmetric spends codes on [-0.50, -0.31], where no weight is; asymmetric fits about [-0.30, 0.45], the range shifted by rounding the zero-point.\n")


def part2_3(weights: dict) -> None:
    count = sum(v.numel() for v in weights.values())
    print(f"2. SmolLM2-135M: {len(weights)} linear weight matrices, {count / 1e6:.1f}M weights")
    print(f"   {'scheme':<40}{'bits/weight':>12}{'error':>9}{'zeroed':>9}")

    def report(label, fn, bpw):
        err2 = ref2 = zeroed = 0.0
        for w in weights.values():
            q = fn(w)
            err2 += (w - q).double().pow(2).sum().item()
            ref2 += w.double().pow(2).sum().item()
            zeroed += ((q == 0) & (w != 0)).sum().item()
        print(f"   {label:<40}{bpw:>12.3f}{math.sqrt(err2 / ref2):>9.2%}{zeroed / count:>9.1%}")

    cols = 576          # most matrices have 576 inputs; down_proj has 1536, so per-channel costs a bit less there
    for bits in (8, 4):
        for group, gname in [(-1, "per tensor"), (None, "per channel"), (256, "group 256"), (128, "group 128"),
                             (64, "group 64"), (32, "group 32")]:
            if bits == 8 and group not in (-1, None):
                continue
            for sym in (True, False):
                label = f"INT{bits} {gname}, {'symmetric' if sym else 'asymmetric'}"
                report(label, lambda w: fake_quant(w, bits, sym, group), bits_per_weight(bits, sym, group, cols))
    print("   error = RMS error / RMS weight; bits/weight counts an FP16 scale per group and, for asymmetric, a")
    print("   zero-point of the same width as the codes (per channel assumes 576 inputs, the common case).\n")

    print("3. Clipping: each group's range shrunk to the ratio (1.0 to 0.5) that minimizes its squared error")
    print(f"   {'scheme':<40}{'no clip':>9}{'clipped':>9}{'mean ratio':>12}")
    for bits, group, gname in [(4, None, "per channel"), (4, 128, "group 128"), (3, 128, "group 128")]:
        e0 = e1 = ref = 0.0
        ratios = []
        for w in weights.values():
            r = best_clip(w, bits, True, group)
            ratios.append(r.flatten())
            e0 += (fake_quant(w, bits, True, group) - w).double().pow(2).sum().item()
            e1 += (fake_quant(w, bits, True, group, r) - w).double().pow(2).sum().item()
            ref += w.double().pow(2).sum().item()
        mean_r = torch.cat(ratios).mean().item()
        print(f"   {f'INT{bits} {gname}, symmetric':<40}{math.sqrt(e0 / ref):>9.2%}{math.sqrt(e1 / ref):>9.2%}{mean_r:>12.2f}")
    print("   Clipping rounds the few largest weights badly so that every other weight gets a finer grid.\n")


def pack_int4(codes: torch.Tensor) -> torch.Tensor:
    """Two unsigned 4-bit codes per byte along the last dimension: even index in the low nibble."""
    c = codes.to(torch.uint8)
    return c[..., 0::2] | (c[..., 1::2] << 4)


def unpack_int4(packed: torch.Tensor) -> torch.Tensor:
    lo, hi = packed & 0x0F, packed >> 4
    return torch.stack((lo, hi), dim=-1).flatten(-2)


def int4_linear(x: torch.Tensor, packed: torch.Tensor, scale: torch.Tensor, zero: torch.Tensor, group: int):
    """y = x @ W.T for a weight stored as packed asymmetric INT4 codes with one FP16 scale and one zero-point per
    group: unpack, subtract the zero-point, multiply by the scale, then do an ordinary matmul. A real W4A16
    kernel does the same per tile in registers, so the full-size weight never exists in memory."""
    rows = packed.shape[0]
    codes = unpack_int4(packed).view(rows, -1, group).float()
    w = (codes - zero.view(rows, -1, 1)) * scale.view(rows, -1, 1).float()
    return x @ w.view(rows, -1).T


def part4(model, weights: dict) -> None:
    name = "model.layers.15.mlp.down_proj.weight"
    w, group = weights[name], 128
    codes, scale, zero = quantize(w, 4, sym=False, group=group)
    packed = pack_int4(codes.view(w.shape[0], -1))
    scale16 = scale.view(w.shape[0], -1).half()
    zero8 = zero.view(w.shape[0], -1).to(torch.uint8)
    x = torch.randn(16, w.shape[1])
    y = int4_linear(x, packed, scale16, zero8, group)
    y_ref = x @ fake_quant(w, 4, False, group).T          # same codes, FP32 scales
    y_full = x @ w.T
    stored = packed.numel() + scale16.numel() * 2 + zero8.numel()
    print(f"4. A packed INT4 layer: {name[6:-7]}, {tuple(w.shape)}, group {group}, asymmetric")
    print(f"   bytes: FP32 {w.numel() * 4:,}, BF16 {w.numel() * 2:,}, packed INT4 + FP16 scales + 8-bit zeros "
          f"{stored:,} ({stored * 8 / w.numel():.2f} bits/weight)")
    print(f"   int4_linear vs dequantize-then-matmul: max difference {(y - y_ref).abs().max().item():.2e} "
          "(only the FP16 rounding of the scales)")
    print(f"   int4_linear vs the original FP32 layer: relative error {((y - y_full).norm() / y_full.norm()).item():.2%}\n")


@torch.no_grad()
def part5(model, windows: torch.Tensor) -> None:
    layers = linear_layers(model)
    stats = {}

    def hook(name):
        def fn(mod, inputs):
            x = inputs[0].reshape(-1, inputs[0].shape[-1]).float()
            w = mod.weight.float()
            ref = x @ w.T
            w8 = fake_quant(w, 8, True, None)                  # INT8 per output channel
            s = stats.setdefault(name, {"absmax": 0.0, "chmax": torch.zeros(x.shape[1]), "ref2": 0.0,
                                        "n_outlier": 0, "n": 0, "err": {}})
            s["absmax"] = max(s["absmax"], x.abs().max().item())
            s["chmax"] = torch.maximum(s["chmax"], x.abs().amax(0))
            s["n_outlier"] += (x.abs() >= 6).sum().item()
            s["n"] += x.numel()
            s["ref2"] += ref.double().pow(2).sum().item()
            for mode in ("per-tensor", "per-token", "decomposed"):
                e = (quant_act(x, mode) @ w8.T - ref).double().pow(2).sum().item()
                s["err"][mode] = s["err"].get(mode, 0.0) + e
            s["err"]["W8A16"] = s["err"].get("W8A16", 0.0) + (x @ w8.T - ref).double().pow(2).sum().item()
        return fn

    handles = [m.register_forward_pre_hook(hook(n)) for n, m in layers.items()]
    for i in range(0, len(windows), 4):
        model(windows[i : i + 4])
    for h in handles:
        h.remove()

    total = sum(s["n"] for s in stats.values())
    outl = sum(s["n_outlier"] for s in stats.values())
    print(f"5. Inputs to the {len(stats)} linear layers over {windows.numel():,} WikiText-2 tokens")
    print(f"   values with magnitude >= 6: {outl / total:.3%} of all inputs")
    print(f"   {'layer input':<34}{'largest':>9}{'median channel max':>20}{'ratio':>8}{'W8A8 per tensor':>17}"
          f"{'per token':>11}{'decomposed':>12}{'W8A16':>8}")
    kinds = {}
    for name, s in stats.items():
        kinds.setdefault(name.split(".")[-1], []).append(name)
    for kind, names in kinds.items():
        # the layer of this kind whose input has the largest value
        name = max(names, key=lambda n: stats[n]["absmax"])
        s = stats[name]
        med = s["chmax"].median().item()
        errs = [math.sqrt(s["err"][m] / s["ref2"]) for m in ("per-tensor", "per-token", "decomposed", "W8A16")]
        print(f"   {name[6:]:<34}{s['absmax']:>9.1f}{med:>20.2f}{s['absmax'] / med:>8.0f}"
              f"{errs[0]:>17.2%}{errs[1]:>11.2%}{errs[2]:>12.2%}{errs[3]:>8.2%}")
    agg = {m: math.sqrt(sum(s["err"][m] for s in stats.values()) / sum(s["ref2"] for s in stats.values()))
           for m in ("per-tensor", "per-token", "decomposed", "W8A16")}
    print(f"   {'all layers':<34}{'':>9}{'':>20}{'':>8}{agg['per-tensor']:>17.2%}{agg['per-token']:>11.2%}"
          f"{agg['decomposed']:>12.2%}{agg['W8A16']:>8.2%}")
    print("   Rows: for each kind of layer, the one whose input had the largest value. The errors are of the layer's")
    print("   output, with INT8 per-channel weights; W8A16 leaves the activations in full precision.\n")


def fmt_ppl(p: float, base: float) -> str:
    if p < 1e4:
        return f"{p:>11.2f}{p / base - 1:>+9.1%}"
    return f"{p:>11.2e}{p / base:>8.0f}x"


@torch.no_grad()
def part6(model, windows: torch.Tensor) -> None:
    print(f"6. Perplexity of SmolLM2-135M on WikiText-2 ({windows.shape[0]} windows of {windows.shape[1]} tokens)")
    base = perplexity(model, windows)
    print(f"   {'scheme':<44}{'perplexity':>11}{'change':>9}")
    print(f"   {'FP32 (the checkpoint is BF16)':<44}{base:>11.2f}")
    weight_schemes = [
        ("W8A16, INT8 per channel", lambda n, w: fake_quant(w, 8, True, None)),
        ("W4A16, INT4 per tensor", lambda n, w: fake_quant(w, 4, True, -1)),
        ("W4A16, INT4 per channel", lambda n, w: fake_quant(w, 4, True, None)),
        ("W4A16, INT4 per channel, clipped", lambda n, w: fake_quant(w, 4, True, None, best_clip(w, 4, True, None))),
        ("W4A16, INT4 group 128", lambda n, w: fake_quant(w, 4, True, 128)),
        ("W4A16, INT4 group 128, asymmetric", lambda n, w: fake_quant(w, 4, False, 128)),
        ("W4A16, INT4 group 32", lambda n, w: fake_quant(w, 4, True, 32)),
        ("W3A16, INT3 group 128", lambda n, w: fake_quant(w, 3, True, 128)),
    ]
    for label, fn in weight_schemes:
        with quantized_weights(model, fn):
            p = perplexity(model, windows)
        print(f"   {label:<44}{fmt_ppl(p, base)}")
    layers = linear_layers(model)
    for mode in ("per-tensor", "per-token", "decomposed"):
        handles = [m.register_forward_pre_hook(lambda mod, inp, mode=mode: (quant_act(inp[0], mode),))
                   for m in layers.values()]
        with quantized_weights(model, lambda n, w: fake_quant(w, 8, True, None)):
            p = perplexity(model, windows)
        for h in handles:
            h.remove()
        print(f"   {f'W8A8, activations INT8 {mode}':<44}{fmt_ppl(p, base)}")


if __name__ == "__main__":
    from transformers import __version__ as tv

    print(f"PyTorch {torch.__version__}, Transformers {tv}\n")
    part1()
    model, tok = load_model()
    weights = {n + ".weight": m.weight.data.float() for n, m in linear_layers(model).items()}
    part2_3(weights)
    part4(model, weights)
    windows = wikitext_windows(tok, n=40, length=1024)
    part5(model, windows[:8])
    part6(model, windows)
