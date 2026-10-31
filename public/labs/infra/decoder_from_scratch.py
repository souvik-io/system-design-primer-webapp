# decoder_from_scratch.py: a Llama-style decoder written with plain tensor ops, checked against
# Hugging Face transformers, with a KV cache for decode and a FLOP count for each phase.
import torch
import torch.nn.functional as F
from torch.utils.flop_counter import FlopCounterMode
from transformers import LlamaConfig, LlamaForCausalLM

torch.manual_seed(0)
cfg = LlamaConfig(vocab_size=1000, hidden_size=256, intermediate_size=688, num_hidden_layers=2,
                  num_attention_heads=8, num_key_value_heads=2, head_dim=32, rope_theta=500000.0,
                  attn_implementation="eager")
ref = LlamaForCausalLM(cfg).eval()
W = {k: v.detach() for k, v in ref.state_dict().items()}
H, KV, HD, EPS = cfg.num_attention_heads, cfg.num_key_value_heads, cfg.head_dim, cfg.rms_norm_eps
THETA = 500000.0  # RoPE base, as in Llama 3 (which also rescales long-range frequencies)


def rms_norm(x, w):
    return w * x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + EPS)


def rope(x, pos):
    """Rotate pairs of dimensions by an angle that grows with position. x: [T, heads, HD]."""
    inv_freq = 1.0 / THETA ** (torch.arange(0, HD, 2).float() / HD)
    angles = pos[:, None].float() * inv_freq[None, :]          # [T, HD/2]
    cos, sin = torch.cat([angles, angles], -1).cos(), torch.cat([angles, angles], -1).sin()
    x1, x2 = x[..., : HD // 2], x[..., HD // 2:]
    rotated = torch.cat([-x2, x1], -1)
    return x * cos[:, None, :] + rotated * sin[:, None, :]


def layer(x, i, pos, cache):
    """One decoder layer. x: [T, d] for the new tokens; cache holds K and V of earlier tokens."""
    p = f"model.layers.{i}."
    h = rms_norm(x, W[p + "input_layernorm.weight"])
    q = F.linear(h, W[p + "self_attn.q_proj.weight"]).view(-1, H, HD)
    k = F.linear(h, W[p + "self_attn.k_proj.weight"]).view(-1, KV, HD)
    v = F.linear(h, W[p + "self_attn.v_proj.weight"]).view(-1, KV, HD)
    q, k = rope(q, pos), rope(k, pos)
    if i in cache:                                              # decode: append to the cache
        k = torch.cat([cache[i][0], k]); v = torch.cat([cache[i][1], v])
    cache[i] = (k, v)
    k, v = k.repeat_interleave(H // KV, 1), v.repeat_interleave(H // KV, 1)   # GQA: share KV heads
    scores = torch.einsum("qhd,khd->hqk", q, k) / HD ** 0.5    # [H, new tokens, all tokens]
    q_pos, k_pos = pos[:, None], torch.arange(k.shape[0])[None, :]
    scores = scores.masked_fill(k_pos > q_pos, float("-inf"))  # causal mask
    out = torch.einsum("hqk,khd->qhd", scores.softmax(-1), v).reshape(-1, H * HD)
    x = x + F.linear(out, W[p + "self_attn.o_proj.weight"])
    h = rms_norm(x, W[p + "post_attention_layernorm.weight"])
    gate = F.linear(h, W[p + "mlp.gate_proj.weight"])
    up = F.linear(h, W[p + "mlp.up_proj.weight"])
    return x + F.linear(F.silu(gate) * up, W[p + "mlp.down_proj.weight"])


def forward(ids, start, cache):
    pos = torch.arange(start, start + len(ids))
    x = W["model.embed_tokens.weight"][ids]
    for i in range(cfg.num_hidden_layers):
        x = layer(x, i, pos, cache)
    return F.linear(rms_norm(x, W["model.norm.weight"]), W["lm_head.weight"])


ids = torch.randint(0, cfg.vocab_size, (129,))
prompt, nxt = ids[:128], ids[128:]
with torch.no_grad():
    want = ref(ids[None]).logits[0]
    cache = {}
    got_prefill = forward(prompt, 0, cache)
    got_decode = forward(nxt, 128, cache)
print(f"prefill max error vs HF: {(got_prefill - want[:128]).abs().max():.2e}")
print(f"decode  max error vs HF: {(got_decode - want[128:]).abs().max():.2e}")

# FLOPs: the counter sees every matmul. Compare with 2 x matmul params per token + attention scores.
L, d, I, V = cfg.num_hidden_layers, cfg.hidden_size, cfg.intermediate_size, cfg.vocab_size
matmul_params = L * (2 * d * H * HD + 2 * d * KV * HD + 3 * d * I) + V * d


def predicted(new, context):
    # QK^T and scores x V: 2 FLOPs x new x context x HD per head, twice. The naive code scores
    # masked positions too, so prefill counts the full T x T square.
    return 2 * new * matmul_params + L * 2 * 2 * new * context * H * HD


def count(fn):
    with FlopCounterMode(display=False) as fc, torch.no_grad():
        fn()
    return fc.get_total_flops()


prefill = count(lambda: forward(prompt, 0, {}))
cache = {}
with torch.no_grad():
    forward(prompt, 0, cache)                   # fill the cache, then count one decode step
decode = count(lambda: forward(nxt, 128, cache))
print(f"prefill, 128 tokens:  counted {prefill / 1e6:6.2f} MFLOP, formula {predicted(128, 128) / 1e6:6.2f}")
print(f"decode, 1 token @129: counted {decode / 1e6:6.2f} MFLOP, formula {predicted(1, 129) / 1e6:6.2f}")
