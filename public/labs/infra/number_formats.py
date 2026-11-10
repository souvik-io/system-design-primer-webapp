# number_formats.py: the number formats of chapter 4.1, built from their bit fields and checked against PyTorch.
#
#   1. Decodes every bit pattern of each format and prints its range and precision, checked against torch.finfo.
#   2. Rounds a million random values with this file's own round-to-nearest-even and compares the results with
#      PyTorch's casts, so the rest of the script can use either.
#   3. Sends a few numbers through each format, including ones too large or too small for it.
#   4. Quantizes the real weights of a small language model (SmolLM2-135M, Apache 2.0, a 270 MB download) with
#      one scale per tensor, with MX block scales and with NVFP4's two-level scales, and prints the error and the
#      bits per weight of each.
#
# Run: python number_formats.py      (needs torch, safetensors and huggingface_hub; about a minute on an M2
#                                     after the download)
import math

import torch

torch.manual_seed(0)


# ---- 1. Formats from their bit fields -------------------------------------------------------------------------
# A format is a sign bit, E exponent bits and M mantissa bits. "ieee" formats reserve the all-ones exponent for
# infinities and NaN. E4M3 as used for deep learning (OCP FP8, torch.float8_e4m3fn) keeps that exponent for
# numbers and gives up only one pattern, S.1111.111, for NaN. The MX element formats FP6 and FP4 have no special
# values at all.
FORMATS = {
    "FP32": (8, 23, "ieee"),
    "BF16": (8, 7, "ieee"),
    "FP16": (5, 10, "ieee"),
    "FP8 E5M2": (5, 2, "ieee"),
    "FP8 E4M3": (4, 3, "fn"),
    "FP6 E3M2": (3, 2, "none"),
    "FP6 E2M3": (2, 3, "none"),
    "FP4 E2M1": (2, 1, "none"),
}
TORCH = {"FP32": torch.float32, "BF16": torch.bfloat16, "FP16": torch.float16,
         "FP8 E5M2": torch.float8_e5m2, "FP8 E4M3": torch.float8_e4m3fn}


def decode(code: int, e: int, m: int, kind: str) -> float:
    """The value of one bit pattern: sign, then exponent, then mantissa, from the top bit down."""
    sign = -1.0 if code >> (e + m) & 1 else 1.0
    exp, man = code >> m & (2**e - 1), code & (2**m - 1)
    bias = 2 ** (e - 1) - 1
    if kind == "ieee" and exp == 2**e - 1:
        return sign * math.inf if man == 0 else math.nan
    if kind == "fn" and exp == 2**e - 1 and man == 2**m - 1:
        return math.nan
    if exp == 0:                                              # subnormal: no implicit leading 1
        return sign * 2.0 ** (1 - bias) * (man / 2**m)
    return sign * 2.0 ** (exp - bias) * (1 + man / 2**m)


def positive_grid(name: str) -> torch.Tensor:
    """Every non-negative finite value of a format of 16 bits or fewer, in increasing order."""
    e, m, kind = FORMATS[name]
    values = [decode(c, e, m, kind) for c in range(2 ** (e + m))]   # sign bit 0: the non-negative half
    return torch.tensor([v for v in values if math.isfinite(v)], dtype=torch.float64)


def properties(name: str) -> dict:
    e, m, kind = FORMATS[name]
    bias = 2 ** (e - 1) - 1
    top = 2**e - 1 if kind != "ieee" else 2**e - 2           # largest exponent field that holds numbers
    top_man = 2**m - 2 if kind == "fn" else 2**m - 1          # E4M3 loses its last mantissa pattern to NaN
    return {
        "bits": 1 + e + m,
        "max": 2.0 ** (top - bias) * (1 + top_man / 2**m),
        "min_normal": 2.0 ** (1 - bias),
        "min_subnormal": 2.0 ** (1 - bias - m),
        "step_at_1": 2.0**-m,                                 # gap between 1 and the next value up
        "finite": 2 * (len(positive_grid(name)) - 1) + 1 if e + m <= 15 else None,   # +x, -x and one zero
        "special": {"ieee": "Inf, NaN", "fn": "NaN only", "none": "none"}[kind],
    }


def part1() -> None:
    print("1. Every format decoded from its bit fields")
    print(f"   {'format':<10}{'bits':>5}{'largest':>12}{'smallest normal':>17}{'smallest subnormal':>20}"
          f"{'step at 1':>11}{'finite values':>15}  special values")
    for name in FORMATS:
        p = properties(name)
        finite = f"{p['finite']:,}" if p["finite"] else "about 4.3e9"
        print(f"   {name:<10}{p['bits']:>5}{p['max']:>12.6g}{p['min_normal']:>17.4g}{p['min_subnormal']:>20.4g}"
              f"{p['step_at_1']:>11.4g}{finite:>15}  {p['special']}")
        if name in TORCH:                                     # check the derivation against PyTorch's own numbers
            fi = torch.finfo(TORCH[name])
            assert (fi.max, fi.smallest_normal, fi.eps) == (p["max"], p["min_normal"], p["step_at_1"]), name
    print("   The largest, smallest-normal and step-at-1 values of the five formats PyTorch has match torch.finfo.\n")


# ---- 2. Rounding ------------------------------------------------------------------------------------------------

def round_to(x: torch.Tensor, name: str, overflow: str) -> torch.Tensor:
    """Round to the nearest value of the format, ties to the even bit pattern. overflow: 'inf', 'nan' or 'saturate'."""
    grid = positive_grid(name)
    a = x.abs().double()
    hi = torch.searchsorted(grid, a).clamp(max=len(grid) - 1)            # first grid value >= a
    lo = (hi - 1).clamp(min=0)
    d_lo, d_hi = a - grid[lo], grid[hi] - a
    # Consecutive patterns alternate between an even and an odd last bit, so "even pattern" means even index.
    pick = torch.where((d_hi < d_lo) | ((d_hi == d_lo) & (hi % 2 == 0)), hi, lo)
    out = grid[pick]
    # Past the largest value: IEEE rounding overflows to infinity once a value is half a step beyond it.
    top = grid[-1].item()
    _, m, _ = FORMATS[name]
    half_step = 2.0 ** (math.floor(math.log2(top)) - m - 1)
    too_big = a >= top + half_step if overflow != "saturate" else a > top
    out = torch.where(too_big, {"inf": math.inf, "nan": math.nan, "saturate": top}[overflow], out)
    return torch.copysign(out, x.double())


OVERFLOW = {"BF16": "inf", "FP16": "inf", "FP8 E5M2": "inf", "FP8 E4M3": "nan",
            "FP6 E3M2": "saturate", "FP6 E2M3": "saturate", "FP4 E2M1": "saturate"}


def part2() -> None:
    print("2. This file's rounding against PyTorch's casts, on 1,000,000 values spread over each format's range")
    for name, dtype in TORCH.items():
        if name == "FP32":
            continue
        p = properties(name)
        # Log-uniform magnitudes from below the smallest subnormal to the largest value, with random signs.
        lo, hi = math.log2(p["min_subnormal"]) - 2, math.log2(p["max"])
        x = torch.exp2(torch.empty(1_000_000, dtype=torch.float64).uniform_(lo, hi)) * torch.randn(1_000_000).sign()
        x = x.float().double()                                # PyTorch casts from FP32, so start from FP32 values
        ours = round_to(x, name, OVERFLOW[name])
        theirs = x.float().to(dtype).double()
        print(f"   {name:<9} {(ours != theirs).sum().item()} differences")
    print()


# ---- 3. A few numbers through each format -----------------------------------------------------------------------

def part3() -> None:
    numbers = [0.1, 3.14159, 300.0, 1000.7, 70000.0, 1e-5]
    names = [n for n in FORMATS if n != "FP32"]
    print("3. A few numbers stored in each format (overflow: Inf for IEEE formats, NaN for E4M3, saturate for FP6/FP4)")
    print("   " + f"{'value':>9}" + "".join(f"{n:>11}" for n in names))
    for v in numbers:
        row = [round_to(torch.tensor([v], dtype=torch.float64), n, OVERFLOW[n]).item() for n in names]
        print("   " + f"{v:>9g}" + "".join(f"{r:>11.5g}" for r in row))
    print()


# ---- 4. Real weights with per-tensor, MX and NVFP4 scaling ------------------------------------------------------

FP4_MAX, E4M3_MAX = 6.0, 448.0


def fp4(x: torch.Tensor) -> torch.Tensor:
    """Round already-scaled values to FP4 E2M1, saturating at 6. FP4 has only 15 values, so this is fast."""
    return round_to(x, "FP4 E2M1", "saturate").to(x.dtype)


def e4m3(x: torch.Tensor) -> torch.Tensor:
    return x.clamp(-E4M3_MAX, E4M3_MAX).to(torch.float8_e4m3fn).to(x.dtype)


def per_tensor(w: torch.Tensor, kind: str) -> torch.Tensor:
    """One FP32 scale for the whole tensor, chosen so the largest weight lands on the format's largest value."""
    top = {"fp8": E4M3_MAX, "fp4": FP4_MAX, "int8": 127, "int4": 7}[kind]
    s = w.abs().max() / top
    q = {"fp8": e4m3, "fp4": fp4, "int8": torch.round, "int4": torch.round}[kind](w / s)
    return q * s


def blocks(w: torch.Tensor, k: int) -> torch.Tensor:
    return w.reshape(-1, k)                                   # each row of the result is one block of k weights


def mx(w: torch.Tensor, kind: str, scale_rule: str = "ocp") -> tuple[torch.Tensor, float]:
    """MX: blocks of 32 weights sharing one power-of-two scale (E8M0). Returns the dequantized weights and the
    share of weights clamped because they came out above the element's largest value.

    The OCP rule (MX v1.0, section 6.3) sets the scale to the largest power of two at or below the block's largest
    magnitude, divided by the largest power of two the element format holds (4 for E2M1, 256 for E4M3). The block's
    largest weight then lands in [4, 8) for FP4, and anything above 6 is clamped. The 'up' rule rounds the scale up
    instead, so nothing is clamped, but the block uses less of the grid."""
    b = blocks(w, 32)
    amax = b.abs().amax(dim=1, keepdim=True).clamp(min=2.0**-127)
    elem_max, elem_emax = (FP4_MAX, 2) if kind == "fp4" else (E4M3_MAX, 8)
    if scale_rule == "ocp":
        exp = torch.floor(torch.log2(amax)) - elem_emax
    else:
        exp = torch.ceil(torch.log2(amax / elem_max))
    scale = torch.exp2(exp.clamp(-127, 127))
    scaled = b / scale
    clamped = (scaled.abs() > elem_max).float().mean().item()
    q = fp4(scaled) if kind == "fp4" else e4m3(scaled)
    return (q * scale).reshape(w.shape), clamped


def nvfp4(w: torch.Tensor) -> torch.Tensor:
    """NVFP4: blocks of 16 FP4 weights, each block with an FP8 E4M3 scale, and one FP32 scale for the tensor.

    The tensor scale is chosen so that the largest block scale needed, amax / 6, fits E4M3's largest value, 448;
    each block's scale is then its own amax / 6, stored in E4M3 relative to the tensor scale. Because E4M3 has
    three mantissa bits, a block scale need not be a power of two, and the block's largest weight lands close to 6."""
    g = w.abs().max() / (FP4_MAX * E4M3_MAX)                  # the FP32 second-level scale
    b = blocks(w, 16)
    s = e4m3(b.abs().amax(dim=1, keepdim=True) / FP4_MAX / g)  # the per-block scale, stored in E4M3
    s = torch.where(s == 0, torch.ones_like(s), s)            # an all-zero block keeps zeros whatever its scale
    q = fp4(b / (s * g))
    return (q * s * g).reshape(w.shape)


def part4() -> None:
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file

    path = hf_hub_download("HuggingFaceTB/SmolLM2-135M", "model.safetensors")
    weights = {k: v for k, v in load_file(path).items() if v.ndim == 2 and "embed" not in k}
    stored = {v.dtype for v in weights.values()}
    count = sum(v.numel() for v in weights.values())
    print(f"4. SmolLM2-135M: {len(weights)} linear weight matrices, {count / 1e6:.1f}M weights, stored as {stored}")

    schemes = [
        ("INT8, one scale per tensor", 8, lambda w: (per_tensor(w, "int8"), 0.0)),
        ("FP8 E4M3, one scale per tensor", 8, lambda w: (per_tensor(w, "fp8"), 0.0)),
        ("MXFP8 E4M3 (32 per E8M0 scale)", 8.25, lambda w: mx(w, "fp8")),
        ("INT4, one scale per tensor", 4, lambda w: (per_tensor(w, "int4"), 0.0)),
        ("FP4 E2M1, one scale per tensor", 4, lambda w: (per_tensor(w, "fp4"), 0.0)),
        ("MXFP4, OCP scale rule", 4.25, lambda w: mx(w, "fp4", "ocp")),
        ("MXFP4, scale rounded up", 4.25, lambda w: mx(w, "fp4", "up")),
        ("NVFP4 (16 per E4M3 scale + FP32)", 4.5, lambda w: (nvfp4(w), 0.0)),
    ]
    print(f"   {'scheme':<34}{'bits/weight':>12}{'error':>8}{'SQNR':>9}{'zeroed':>9}{'clamped':>9}")
    for label, bits, fn in schemes:
        err2 = ref2 = zeroed = clamped = 0.0
        for v in weights.values():
            w = v.float()
            q, c = fn(w)
            err2 += (w - q).double().pow(2).sum().item()
            ref2 += w.double().pow(2).sum().item()
            zeroed += ((q == 0) & (w != 0)).sum().item()
            clamped += c * w.numel()
        rel = math.sqrt(err2 / ref2)
        print(f"   {label:<34}{bits:>12}{rel:>8.2%}{-20 * math.log10(rel):>7.1f}dB{zeroed / count:>9.1%}{clamped / count:>9.2%}")
    print("   error = RMS error / RMS weight over all matrices; SQNR = signal-to-quantization-noise ratio;")
    print("   zeroed = nonzero weights stored as 0; clamped = weights cut down to the element's largest value.")


if __name__ == "__main__":
    print(f"PyTorch {torch.__version__}\n")
    part1()
    part2()
    part3()
    part4()
