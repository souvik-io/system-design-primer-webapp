# sparse_matmul.py: how much faster a 2:4 sparse weight matrix multiplies than a dense one (chapter 4.5).
#
# The weight matrix of one Llama 3 70B MLP projection (K = 8192 inputs, N = 28,672 outputs) is pruned to the 2:4
# pattern, two nonzeros in every four consecutive weights, and converted with
# torch.sparse.to_sparse_semi_structured, which stores the nonzero half plus 2-bit indices and multiplies on the
# sparse tensor cores through cuSPARSELt (or CUTLASS). It is timed against the dense BF16 matmul for M rows of
# activations, from a decode step (M = 16) to a prefill chunk (M = 8192).
#
#   modal run modal_run.py --script sparse_matmul.py --gpu 'H100!'
#   python gcp_run.py --script sparse_matmul.py --gpu L4
#   python sparse_matmul.py                     # any NVIDIA GPU with compute capability 8.0 or later
import statistics

import torch
import torch.nn.functional as F
from torch.sparse import SparseSemiStructuredTensor, to_sparse_semi_structured

K, N = 8192, 28672
MS = [16, 64, 256, 1024, 4096, 8192]


def time_us(fn, reps=20):
    for _ in range(3):
        fn()
    times = []
    for _ in range(5):
        start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
        start.record()
        for _ in range(reps):
            fn()
        end.record()
        torch.cuda.synchronize()
        times.append(start.elapsed_time(end) * 1000 / reps)
    return statistics.median(times)


def main() -> None:
    name = torch.cuda.get_device_name()
    print(f"{name}, PyTorch {torch.__version__}, CUDA {torch.version.cuda}")
    torch.manual_seed(0)
    w = torch.randn(N, K, device="cuda", dtype=torch.bfloat16)
    # Keep the 2 largest of every 4 consecutive weights along the input dimension.
    g = w.view(N, -1, 4)
    keep = g.abs().argsort(dim=2, descending=True)[:, :, :2]
    w24 = torch.zeros_like(g).scatter(2, keep, g.gather(2, keep)).view(N, K)
    results = {}
    for backend in ("cusparselt", "cutlass"):
        SparseSemiStructuredTensor._FORCE_CUTLASS = backend == "cutlass"
        try:
            ws = to_sparse_semi_structured(w24)
        except Exception as e:
            print(f"{backend}: not available: {str(e).splitlines()[0][:100]}")
            continue
        print(f"\n{backend}: dense BF16 weights {N * K * 2 / 2**20:.0f} MiB; 2:4 values + indices {N * K * (1 + 1 / 8) / 2**20:.0f} MiB")
        print(f"   {'M':>6}{'dense':>11}{'2:4 sparse':>12}{'speedup':>9}{'max diff':>10}")
        for m in MS:
            x = torch.randn(m, K, device="cuda", dtype=torch.bfloat16)
            try:
                ref = F.linear(x, w24)
                out = F.linear(x, ws)
                diff = (out.float() - ref.float()).abs().max().item() / ref.float().abs().max().item()
                td = time_us(lambda: F.linear(x, w24))
                ts = time_us(lambda: F.linear(x, ws))
            except Exception as e:
                print(f"   {m:>6}  not run: {str(e).splitlines()[0][:90]}")
                continue
            results[(backend, m)] = td / ts
            print(f"   {m:>6}{td:>9.1f}us{ts:>10.1f}us{td / ts:>8.2f}x{diff:>10.1e}", flush=True)
    print("\nspeedup = dense time / sparse time for the same pruned matrix; max diff is relative to the largest output.")


if __name__ == "__main__":
    main()
