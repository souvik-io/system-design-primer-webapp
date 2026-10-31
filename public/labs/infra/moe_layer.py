# moe_layer.py: a mixture-of-experts layer written two ways, checked against Hugging Face's Qwen3-MoE block.
#
# 1. moe_loop:    for each expert, gather its tokens, run its MLP, scatter the results back.
# 2. moe_grouped: sort the (token, expert) pairs by expert, run each expert on one contiguous slice,
#                 then unsort. Serving engines do this, with one grouped-GEMM kernel for all experts.
#
# Both must match transformers' Qwen3MoeSparseMoeBlock to float32 rounding. The script then prints how
# the tokens were spread over the experts, and the FLOPs of the layer against a dense MLP of equal size.
#
# Run: python moe_layer.py        (CPU, a few seconds; needs torch and transformers)
import torch
import torch.nn.functional as F
from transformers import Qwen3MoeConfig, Qwen3MoeForCausalLM

torch.manual_seed(0)
cfg = Qwen3MoeConfig(vocab_size=1000, hidden_size=256, intermediate_size=512, moe_intermediate_size=128,
                     num_experts=16, num_experts_per_tok=4, norm_topk_prob=True, num_hidden_layers=1,
                     num_attention_heads=4, num_key_value_heads=2, head_dim=64)
block = Qwen3MoeForCausalLM(cfg).model.layers[0].mlp.eval()   # a randomly initialised MoE block
E, K, D, I = cfg.num_experts, cfg.num_experts_per_tok, cfg.hidden_size, cfg.moe_intermediate_size


def expert_weights(block):
    """Router [E, D], gate_up [E, 2I, D] and down [E, D, I], for both weight layouts transformers has used."""
    experts = block.experts
    if hasattr(experts, "gate_up_proj"):                          # transformers 5: experts stored as 3-D tensors
        return block.gate.weight, experts.gate_up_proj, experts.down_proj
    gate_up = torch.stack([torch.cat([e.gate_proj.weight, e.up_proj.weight]) for e in experts])
    down = torch.stack([e.down_proj.weight for e in experts])     # transformers 4: one module per expert
    return block.gate.weight, gate_up, down


ROUTER, GATE_UP, DOWN = (w.detach() for w in expert_weights(block))


def route(x):
    """Softmax over all experts, keep the top K, renormalise them to sum to 1 (norm_topk_prob=True)."""
    probs = F.linear(x, ROUTER).softmax(-1)                       # [T, E]
    weights, experts = probs.topk(K, dim=-1)                      # [T, K] each
    return weights / weights.sum(-1, keepdim=True), experts


def expert_mlp(e, x):
    gate, up = F.linear(x, GATE_UP[e]).chunk(2, dim=-1)
    return F.linear(F.silu(gate) * up, DOWN[e])


def moe_loop(x):
    weights, experts = route(x)
    out = torch.zeros_like(x)
    for e in range(E):
        token, slot = torch.where(experts == e)                   # which tokens chose e, and in which slot
        if len(token):
            out.index_add_(0, token, weights[token, slot, None] * expert_mlp(e, x[token]))
    return out


def moe_grouped(x):
    weights, experts = route(x)
    flat = experts.reshape(-1)                                    # T*K (token, expert) pairs
    order = flat.argsort(stable=True)                             # group the pairs by expert
    token = order // K                                            # pair index -> token index
    counts = torch.bincount(flat, minlength=E).tolist()           # tokens per expert: the group sizes
    rows = x[token]                                               # the "permute" step: [T*K, D]
    outs, start = [], 0
    for e, n in enumerate(counts):                                # one grouped GEMM in a real engine
        outs.append(expert_mlp(e, rows[start:start + n]))
        start += n
    y = torch.cat(outs) * weights.reshape(-1)[order, None]        # scale each row by its routing weight
    return torch.zeros_like(x).index_add_(0, token, y), counts    # "unpermute" and sum the K rows per token


x = torch.randn(512, D)
with torch.no_grad():
    want = block(x[None])
    want = (want[0] if isinstance(want, tuple) else want)[0]     # some versions also return router logits
    got_loop = moe_loop(x)
    got_grouped, counts = moe_grouped(x)
scale = want.abs().max()
print(f"loop    vs HF: max error {(got_loop - want).abs().max():.1e} (outputs reach {scale:.1e})")
print(f"grouped vs HF: max error {(got_grouped - want).abs().max():.1e}")

mean = len(x) * K / E
print(f"\n{len(x)} tokens x top-{K} = {len(x) * K} expert slots over {E} experts, {mean:.0f} per expert if even")
print("tokens per expert:", counts)
print(f"busiest expert: {max(counts)} tokens = {max(counts) / mean:.2f} x the mean; quietest: {min(counts)}")

expert_params = 3 * D * I
active = K * expert_params + E * D                                # K experts plus the router
dense = E * expert_params                                         # what a dense MLP holding every expert would cost
print(f"\nper token: {2 * active / 1e6:.2f} MFLOP active, against {2 * dense / 1e6:.2f} MFLOP if every expert ran "
      f"({active / dense:.0%}); weights stored: {E * expert_params * 4 / 1e6:.1f} MB in FP32")
