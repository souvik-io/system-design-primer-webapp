# model.py: a Llama-architecture model (SmolLM2, Llama 3.x) that runs on a flat batch of tokens from many
# sequences at once and reads and writes a paged KV cache.
#
# There is no padding and no batch dimension: the step's tokens from every sequence are laid end to end, a prefill
# chunk contributing many and a decode one. Every matmul treats them as one [tokens, hidden] matrix. Only attention
# needs to know where each sequence starts and which cache blocks hold its earlier tokens; that is the AttnMeta.
import json
import math
from dataclasses import dataclass, field

import torch
import torch.nn.functional as F


@dataclass
class AttnMeta:
    slot_mapping: torch.Tensor   # [tokens] int64: where each new token's K and V go, in token slots of the cache
    cu_seqlens_q: torch.Tensor   # [seqs + 1] int32: where each sequence's new tokens start in the flat batch
    seqlens_k: torch.Tensor      # [seqs] int32: tokens of context per sequence after this step
    block_tables: torch.Tensor   # [seqs, max blocks] int32, padded with 0
    max_seqlen_q: int
    max_seqlen_k: int
    # Plain Python copies for the PyTorch attention path, which loops over sequences.
    q_lens: list[int]
    k_lens: list[int]
    scratch: dict = field(default_factory=dict)   # tensors derived once per step and reused by every layer


def paged_attention_torch(q, k_cache, v_cache, meta: AttnMeta, scale: float):
    """Reference paged attention in plain PyTorch: gather each sequence's keys and values from its blocks, then run
    ordinary attention. q: [tokens, heads, dim]; k_cache, v_cache: [blocks, block_size, kv_heads, dim].
    Sequences with one new token (decodes) are padded to the longest context and done in one call; sequences with
    several (prefill chunks) are done one at a time, since padding them to each other would waste more."""
    out = torch.empty_like(q)
    block_size = k_cache.shape[1]
    starts = [0]
    for n in meta.q_lens:
        starts.append(starts[-1] + n)
    decodes = [i for i, n in enumerate(meta.q_lens) if n == 1]
    if decodes:
        if "decode" not in meta.scratch:                         # the same for every layer: build it once
            idx = torch.tensor(decodes, device=q.device)
            width = math.ceil(max(meta.k_lens[i] for i in decodes) / block_size)
            positions = torch.arange(width * block_size, device=q.device)[None, :]
            meta.scratch["decode"] = (torch.tensor([starts[i] for i in decodes], device=q.device),
                                      meta.block_tables[idx, :width],                 # [decodes, blocks]
                                      (positions < meta.seqlens_k[idx][:, None])[:, None, None, :])  # hide padding
        rows, tables, mask = meta.scratch["decode"]
        k = k_cache[tables].flatten(1, 2)                         # [decodes, context, kv_heads, dim]
        v = v_cache[tables].flatten(1, 2)
        o = F.scaled_dot_product_attention(q[rows][:, :, None], k.transpose(1, 2), v.transpose(1, 2),
                                           attn_mask=mask, scale=scale, enable_gqa=True)
        out[rows] = o[:, :, 0]
    for i, (n_q, n_k) in enumerate(zip(meta.q_lens, meta.k_lens)):
        if n_q == 1:
            continue
        blocks = meta.block_tables[i, : math.ceil(n_k / block_size)]
        k = k_cache[blocks].flatten(0, 1)[:n_k]                  # [context, kv_heads, dim], in token order
        v = v_cache[blocks].flatten(0, 1)[:n_k]
        # The new tokens are the last n_q of the context; token j may see context positions up to n_k - n_q + j.
        q_pos = torch.arange(n_k - n_q, n_k, device=q.device)[:, None]
        mask = torch.arange(n_k, device=q.device)[None, :] <= q_pos
        o = F.scaled_dot_product_attention(q[starts[i] : starts[i + 1]].transpose(0, 1), k.transpose(0, 1),
                                           v.transpose(0, 1), attn_mask=mask, scale=scale, enable_gqa=True)
        out[starts[i] : starts[i + 1]] = o.transpose(0, 1)
    return out


def paged_attention_flash(q, k_cache, v_cache, meta: AttnMeta, scale: float):
    """One kernel call for the whole mixed batch: vLLM's build of FlashAttention reads K and V straight from the
    blocks through the block table (the upstream FlashAttention 2 needs blocks of a multiple of 256 tokens).
    On Hopper it uses FlashAttention 3, as vLLM does; elsewhere FlashAttention 2."""
    from vllm.vllm_flash_attn import flash_attn_varlen_func
    version = 3 if torch.cuda.get_device_capability(q.device)[0] == 9 else 2
    return flash_attn_varlen_func(q, k_cache, v_cache, max_seqlen_q=meta.max_seqlen_q, cu_seqlens_q=meta.cu_seqlens_q,
                                  max_seqlen_k=meta.max_seqlen_k, seqused_k=meta.seqlens_k, softmax_scale=scale,
                                  causal=True, block_table=meta.block_tables, fa_version=version)


def rope_frequencies(cfg: dict) -> torch.Tensor:
    """RoPE's inverse frequencies, with Llama 3's long-context rescaling when the config asks for it."""
    dim = cfg.get("head_dim") or cfg["hidden_size"] // cfg["num_attention_heads"]
    inv = 1.0 / cfg["rope_theta"] ** (torch.arange(0, dim, 2, dtype=torch.float32) / dim)
    s = cfg.get("rope_scaling") or {}
    if s.get("rope_type") == "llama3":
        low_wavelen = s["original_max_position_embeddings"] / s["low_freq_factor"]
        high_wavelen = s["original_max_position_embeddings"] / s["high_freq_factor"]
        wavelen = 2 * math.pi / inv
        smooth = (s["original_max_position_embeddings"] / wavelen - s["low_freq_factor"]) / (
            s["high_freq_factor"] - s["low_freq_factor"])
        scaled = torch.where(wavelen > low_wavelen, inv / s["factor"], inv)
        middle = (wavelen <= low_wavelen) & (wavelen >= high_wavelen)
        inv = torch.where(middle, (1 - smooth) * inv / s["factor"] + smooth * inv, scaled)
    elif s:
        raise NotImplementedError(f"RoPE scaling {s}")
    return inv


class Llama(torch.nn.Module):
    def __init__(self, cfg: dict, weights: dict[str, torch.Tensor], max_len: int, attention: str):
        super().__init__()
        self.cfg = cfg
        self.n_layers = cfg["num_hidden_layers"]
        self.n_heads = cfg["num_attention_heads"]
        self.n_kv = cfg["num_key_value_heads"]
        self.head_dim = cfg.get("head_dim") or cfg["hidden_size"] // self.n_heads
        self.eps = cfg["rms_norm_eps"]
        self.attend = paged_attention_flash if attention == "flash" else paged_attention_torch
        w = weights
        self.embed = w["model.embed_tokens.weight"]
        self.lm_head = w.get("lm_head.weight", self.embed)            # small models tie the two
        self.norm = w["model.norm.weight"]
        self.layers = []
        for i in range(self.n_layers):
            p = f"model.layers.{i}."
            self.layers.append({
                "ln1": w[p + "input_layernorm.weight"], "ln2": w[p + "post_attention_layernorm.weight"],
                # Q, K and V as one matmul, and gate and up as another: fewer, larger kernels.
                # pop: drop each separate matrix once it is copied, so the model is never in memory twice.
                "qkv": torch.cat([w.pop(p + f"self_attn.{x}_proj.weight") for x in "qkv"]),
                "o": w[p + "self_attn.o_proj.weight"],
                "gate_up": torch.cat([w.pop(p + "mlp.gate_proj.weight"), w.pop(p + "mlp.up_proj.weight")]),
                "down": w[p + "mlp.down_proj.weight"],
            })
        # Computed in float32, as Hugging Face does, so that greedy outputs match it token for token.
        angles = torch.arange(max_len, dtype=torch.float32)[:, None] * rope_frequencies(cfg)[None, :]
        self.cos = angles.cos().to(self.embed.device)   # [max_len, head_dim / 2]
        self.sin = angles.sin().to(self.embed.device)

    def rms_norm(self, x, w):
        x32 = x.float()
        return (x32 * torch.rsqrt(x32.pow(2).mean(-1, keepdim=True) + self.eps)).to(x.dtype) * w

    def rope(self, x, positions):
        cos, sin = self.cos[positions][:, None, :], self.sin[positions][:, None, :]
        x1, x2 = x.float().chunk(2, dim=-1)
        return torch.cat([x1 * cos - x2 * sin, x2 * cos + x1 * sin], -1).to(x.dtype)

    @torch.inference_mode()
    def forward(self, input_ids, positions, kv_cache, meta: AttnMeta, logits_indices):
        """input_ids, positions: [tokens]. kv_cache: [layers, 2, blocks, block_size, kv_heads, dim]. Returns logits
        only for the rows in logits_indices, the last token of each sequence that samples this step."""
        H, KV, D = self.n_heads, self.n_kv, self.head_dim
        x = F.embedding(input_ids, self.embed)
        for i, L in enumerate(self.layers):
            h = self.rms_norm(x, L["ln1"])
            q, k, v = F.linear(h, L["qkv"]).split([H * D, KV * D, KV * D], dim=-1)
            q = self.rope(q.view(-1, H, D), positions)
            k = self.rope(k.view(-1, KV, D), positions)
            k_cache, v_cache = kv_cache[i, 0], kv_cache[i, 1]
            # Write this step's keys and values into their slots, then attend over the whole context from the cache.
            k_cache.view(-1, KV, D)[meta.slot_mapping] = k
            v_cache.view(-1, KV, D)[meta.slot_mapping] = v.view(-1, KV, D)
            attn = self.attend(q, k_cache, v_cache, meta, D ** -0.5)
            x = x + F.linear(attn.reshape(-1, H * D), L["o"])
            h = self.rms_norm(x, L["ln2"])
            gate, up = F.linear(h, L["gate_up"]).chunk(2, dim=-1)
            x = x + F.linear(F.silu(gate) * up, L["down"])
        x = self.rms_norm(x[logits_indices], self.norm)
        return F.linear(x, self.lm_head).float()


def load(model_id: str, device: str, dtype: torch.dtype, max_len: int, attention: str):
    """Download the checkpoint from the Hugging Face Hub (or use the local cache) and build the model."""
    from huggingface_hub import snapshot_download
    from safetensors import safe_open
    from pathlib import Path

    path = Path(snapshot_download(model_id, allow_patterns=["*.json", "*.safetensors", "tokenizer*"]))
    cfg = json.loads((path / "config.json").read_text())
    if cfg.get("model_type") != "llama":
        raise ValueError(f"nano_engine runs Llama-architecture models; {model_id} is {cfg.get('model_type')}")
    weights = {}
    for file in sorted(path.glob("*.safetensors")):
        with safe_open(file, framework="pt", device="cpu") as f:
            for name in f.keys():
                weights[name] = f.get_tensor(name).to(device=device, dtype=dtype)
    return Llama(cfg, weights, max_len, attention), cfg, path
