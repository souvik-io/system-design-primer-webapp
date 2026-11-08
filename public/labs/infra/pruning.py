# pruning.py: prune half of a model's weights, unstructured and in the 2:4 pattern, and measure the damage
# (chapter 4.5).
#
# Prunes every linear layer of SmolLM2-135M to 50% sparsity in four ways and prints the WikiText-2 perplexity:
#   magnitude, unstructured   zero the half of each row's weights with the smallest |W|
#   Wanda, unstructured       zero the half with the smallest |W| x ||X_j||, the weight's magnitude times the
#                             norm of its input channel over calibration tokens (Sun et al., 2023)
#   magnitude, 2:4            in every group of 4 consecutive weights along a row, zero the 2 smallest |W|,
#                             the pattern NVIDIA's sparse tensor cores accelerate
#   Wanda, 2:4                the same with Wanda's score
# then compares the best of them with chapter 4.3's INT4 results, which also halve the bytes or better.
#
# Needs quant_math.py and ptq_algorithms.py in the same folder.
# Run: python pruning.py      (about seven minutes on an M2)
import torch

from ptq_algorithms import calibrate
from quant_math import linear_layers, load_model, perplexity, quantized_weights, wikitext_windows

torch.manual_seed(0)


def prune(w: torch.Tensor, score: torch.Tensor, pattern: str) -> torch.Tensor:
    """Zero half of w: the lowest-scoring half of each row, or the 2 lowest of every 4 consecutive weights."""
    if pattern == "unstructured":
        k = w.shape[1] // 2
        drop = score.argsort(dim=1)[:, :k]
        return w.scatter(1, drop, 0.0)
    if pattern == "2:4":
        s = score.view(w.shape[0], -1, 4)
        drop = s.argsort(dim=2)[:, :, :2]
        mask = torch.ones_like(s, dtype=torch.bool).scatter(2, drop, False)
        return w * mask.view(w.shape)
    raise ValueError(pattern)


def is_2_4(w: torch.Tensor) -> bool:
    return bool(((w.view(w.shape[0], -1, 4) != 0).sum(2) <= 2).all())


def main() -> None:
    from transformers import __version__ as tv

    print(f"PyTorch {torch.__version__}, Transformers {tv}\n")
    model, tok = load_model()
    stats = calibrate(model, wikitext_windows(tok, split="train", n=32, length=512))
    # ||X_j||_2 over the calibration tokens is proportional to sqrt(H_jj), since H = 2 X^T X / n.
    xnorm = {n: s["H"].diag().clamp(min=0).sqrt() for n, s in stats.items()}
    test = wikitext_windows(tok, split="test", n=40, length=1024)
    base = perplexity(model, test)
    print(f"WikiText-2 test perplexity, every linear layer pruned to 50% sparsity ({sum(m.weight.numel() for m in linear_layers(model).values()) / 1e6:.1f}M weights)")
    print(f"   {'method':<30}{'perplexity':>12}{'change':>9}")
    print(f"   {'dense':<30}{base:>12.2f}")
    for label, use_x, pattern in [("magnitude, unstructured", False, "unstructured"), ("Wanda, unstructured", True, "unstructured"),
                                  ("magnitude, 2:4", False, "2:4"), ("Wanda, 2:4", True, "2:4")]:
        def fn(name, w):
            score = w.abs() * xnorm[name][None, :] if use_x else w.abs()
            q = prune(w, score, pattern)
            assert pattern != "2:4" or is_2_4(q)
            return q
        with quantized_weights(model, fn):
            p = perplexity(model, test)
        print(f"   {label:<30}{p:>12.2f}{p / base - 1:>+9.0%}", flush=True)
    print("\n   For comparison, chapter 4.3: INT4 group 128 with GPTQ (act-order) 20.09 (+17%), with RTN 23.01 (+35%).")
    print("   2:4 sparse BF16 stores 9 bits per original weight (two 16-bit values and two 2-bit indices per four);")
    print("   INT4 with group-128 scales stores about 4.2.")


if __name__ == "__main__":
    main()
