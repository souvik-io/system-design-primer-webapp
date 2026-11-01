# export_runtimes.py: one small transformer run four ways, eager, torch.compile, ONNX Runtime and AOTInductor
# (chapter 3.3).
#
#  1. Builds a 4-layer decoder in plain PyTorch with random weights (the shapes of a small model, not a trained one).
#  2. torch.export: captures the whole forward as one graph, with a dynamic sequence length; shows what happens
#     when a shape falls outside the exported range, and when the code branches on a tensor's value.
#  3. Runs the same model eagerly, with torch.compile, as an ONNX model in ONNX Runtime, and as an AOTInductor
#     package, and reports for each the time to build, the time per forward pass and the largest output difference.
#
# Runs on a CPU (a Mac or a Linux machine). Needs torch, onnx, onnxscript and onnxruntime, plus a C++ compiler for
# torch.compile and AOTInductor. Run: python export_runtimes.py
import logging
import os
import platform
import tempfile
import time

import torch
import torch.nn as nn
import torch.nn.functional as F

logging.getLogger("torch").setLevel(logging.ERROR)  # quiets warnings; the failing export below still prints its
#                                                     partial graph to stderr
torch.manual_seed(0)
torch.set_num_threads(4)
LAYERS, D, HEADS, VOCAB = 4, 512, 8, 32_000


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.norm1, self.norm2 = nn.RMSNorm(D), nn.RMSNorm(D)
        self.qkv, self.out = nn.Linear(D, 3 * D, bias=False), nn.Linear(D, D, bias=False)
        self.up, self.gate, self.down = (nn.Linear(D, 4 * D, bias=False), nn.Linear(D, 4 * D, bias=False),
                                         nn.Linear(4 * D, D, bias=False))

    def forward(self, x):
        b, s, _ = x.shape
        q, k, v = self.qkv(self.norm1(x)).view(b, s, 3, HEADS, D // HEADS).transpose(1, 3).unbind(2)
        a = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        x = x + self.out(a.transpose(1, 2).reshape(b, s, D))
        h = self.norm2(x)
        return x + self.down(F.silu(self.gate(h)) * self.up(h))


class TinyDecoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.embed = nn.Embedding(VOCAB, D)
        self.blocks = nn.ModuleList(Block() for _ in range(LAYERS))
        self.norm, self.head = nn.RMSNorm(D), nn.Linear(D, VOCAB, bias=False)

    def forward(self, ids):
        x = self.embed(ids)
        for block in self.blocks:
            x = block(x)
        return self.head(self.norm(x))


model = TinyDecoder().eval()
params = sum(p.numel() for p in model.parameters())
print(f"{platform.machine()}, {platform.system()}, PyTorch {torch.__version__}, 4 CPU threads; "
      f"a {LAYERS}-layer decoder with {params / 1e6:.0f}M parameters")
ids = torch.randint(0, VOCAB, (1, 128))
other = torch.randint(0, VOCAB, (1, 300))       # a different sequence length, to test dynamic shapes


def per_call(fn, x, iters=20, repeats=5):
    fn(x)
    means = []
    for _ in range(repeats):
        t0 = time.perf_counter()
        for _ in range(iters):
            fn(x)
        means.append((time.perf_counter() - t0) / iters * 1e3)
    return sorted(means)[repeats // 2]          # the median of five means of 20 calls, in ms


# ---------------------------------------------------------------------------------------------------------------
# 2. torch.export
seq = torch.export.Dim("seq", min=2, max=1024)
t0 = time.perf_counter()
exported = torch.export.export(model, (ids,), dynamic_shapes={"ids": {1: seq}})
export_s = time.perf_counter() - t0
ops = [n for n in exported.graph.nodes if n.op == "call_function"]
print(f"\n2. torch.export: {export_s:.1f} s, one graph of {len(ops)} operations, "
      f"sequence length allowed from 2 to 1024")
print("   The first operations: " + ", ".join(str(n.target).replace("aten.", "") for n in ops[:6]))
try:
    exported.module()(torch.randint(0, VOCAB, (1, 2000)))
except Exception as e:                          # the exported program checks its inputs against the ranges
    print(f"   A 2,000-token input is rejected: {type(e).__name__}: {str(e).splitlines()[0][:110]}")

static = torch.export.export(model, (ids,))      # no dynamic_shapes: every dimension is fixed at its example size
try:
    static.module()(other)
except Exception as e:
    print(f"   Exported without dynamic_shapes, a 300-token input is rejected: {str(e).splitlines()[0][:90]}")


class Branchy(nn.Module):
    def forward(self, x):
        if x.sum() > 0:                         # Python control flow on a tensor's value
            return x * 2
        return x - 1


try:
    torch.export.export(Branchy(), (torch.randn(4),))
except Exception as e:
    print(f"   A branch on a tensor's value cannot be exported: {type(e).__name__}")


class Cond(nn.Module):
    def forward(self, x):
        return torch.cond(x.sum() > 0, lambda x: x * 2, lambda x: x - 1, (x,))


cond_ops = [n for n in torch.export.export(Cond(), (torch.randn(4),)).graph.nodes if n.op == "call_function"]
print(f"   Rewritten with torch.cond it exports, keeping both branches: "
      f"{[str(n.target) for n in cond_ops if 'cond' in str(n.target)]}")

# ---------------------------------------------------------------------------------------------------------------
# 3. Four ways to run the same model.
rows = []
with torch.no_grad():
    reference = model(ids)
    reference_other = model(other)

    def add(name, build_s, fn, note=""):
        diff = (torch.as_tensor(fn(ids)) - reference).abs().max().item()
        diff_other = (torch.as_tensor(fn(other)) - reference_other).abs().max().item()
        rows.append((name, build_s, per_call(fn, ids), max(diff, diff_other), note))

    add("Eager PyTorch", 0.0, model)

    compiled = torch.compile(model)
    t0 = time.perf_counter()
    compiled(ids)
    compiled(other)                              # a new length: recompiles once, then treats the length as dynamic
    add("torch.compile", time.perf_counter() - t0, compiled, "compiled on first call, in the serving process")

    import onnxruntime as ort
    path = os.path.join(tempfile.mkdtemp(), "tiny.onnx")
    t0 = time.perf_counter()
    torch.onnx.export(model, (ids,), path, dynamic_shapes={"ids": {1: "seq"}}, dynamo=True, verbose=False)
    export_onnx = time.perf_counter() - t0
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    t0 = time.perf_counter()
    session = ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])
    session_s = time.perf_counter() - t0
    name = session.get_inputs()[0].name
    add("ONNX Runtime (CPU)", export_onnx + session_s, lambda x: session.run(None, {name: x.numpy()})[0],
        f"export {export_onnx:.1f} s + session {session_s:.1f} s; onnxruntime {ort.__version__}")

    package = os.path.join(tempfile.mkdtemp(), "tiny.pt2")
    t0 = time.perf_counter()
    torch._inductor.aoti_compile_and_package(exported, package_path=package)
    aoti_build = time.perf_counter() - t0
    t0 = time.perf_counter()
    aoti = torch._inductor.aoti_load_package(package)
    load_s = time.perf_counter() - t0
    add("AOTInductor package", export_s + aoti_build, aoti,
        f"export {export_s:.1f} s + compile {aoti_build:.1f} s; {os.path.getsize(package) / 1e6:.0f} MB file, "
        f"loads in {load_s:.1f} s")

print(f"\n3. A forward pass over 128 tokens (outputs also checked at 300 tokens)")
print(f"   {'':<22}{'build':>9}{'per pass':>11}{'max diff':>11}")
for name, build_s, ms, diff, note in rows:
    print(f"   {name:<22}{build_s:8.1f}s{ms:9.1f} ms{diff:11.1e}   {note}")
