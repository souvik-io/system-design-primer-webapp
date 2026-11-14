# sampler.py: from a batch of logits to the next token of each sequence (chapter 5.5).
#
# The steps, in the order vLLM 0.32.0's sampler takes them (vllm/v1/worker/gpu/sample/sampler.py):
#   1. penalties, on the raw logits: repetition (tokens in the prompt or the output), frequency and presence
#      (tokens in the output only)
#   2. greedy rows (temperature 0) take the argmax here, so nothing below can change them
#   3. temperature: divide the logits by T
#   4. min-p, then top-k and top-p: remove the unlikely tail of the distribution
#   5. a random draw from what is left
# The grammar mask of structured output (structured.py) is applied before all of this, by the engine, so that a
# token the grammar forbids can never be chosen, whatever the settings.
#
# Every step works on the whole batch at once, with one row per sequence and each sequence's own settings in a
# column tensor, because a server's batch mixes requests with different settings. A step that no sequence in the
# batch uses is skipped, which matters for top-p: it is the only step that sorts the vocabulary.
import torch

from .sequence import SamplingParams, Sequence


def uses_penalties(p: SamplingParams) -> bool:
    return p.repetition_penalty != 1.0 or p.frequency_penalty != 0.0 or p.presence_penalty != 0.0


def apply_penalties(logits: torch.Tensor, seqs: list[Sequence]) -> None:
    """In place. Repetition penalty (Keskar et al., 2019, as Hugging Face and vLLM implement it): a token already seen
    in the prompt or the output has a positive logit divided by the penalty and a negative one multiplied by it, so
    either way it becomes less likely. Frequency and presence penalties (OpenAI's definition) count the output only:
    logit -= frequency_penalty * count + presence_penalty * (count > 0)."""
    rows = [i for i, s in enumerate(seqs) if uses_penalties(s.params)]
    if not rows:
        return
    dev, vocab = logits.device, logits.shape[-1]
    counts = torch.zeros(len(rows), vocab, device=dev)              # how often each token is in the output
    in_prompt = torch.zeros(len(rows), vocab, dtype=torch.bool, device=dev)
    for j, i in enumerate(rows):
        s = seqs[i]
        out = torch.tensor(s.output_ids, dtype=torch.long, device=dev)
        counts[j].index_add_(0, out, torch.ones(len(out), device=dev))
        in_prompt[j, torch.tensor(s.token_ids[: s.num_prompt_tokens], dtype=torch.long, device=dev)] = True
    col = lambda name: torch.tensor([getattr(seqs[i].params, name) for i in rows], device=dev)[:, None]
    sub = logits[rows].float()
    rep = col("repetition_penalty")
    seen = in_prompt | (counts > 0)
    sub = torch.where(seen, torch.where(sub > 0, sub / rep, sub * rep), sub)
    sub -= col("frequency_penalty") * counts + col("presence_penalty") * (counts > 0)
    logits[rows] = sub.to(logits.dtype)


def filter_tail(logits: torch.Tensor, seqs: list[Sequence]) -> torch.Tensor:
    """Returns logits with the tokens removed by min-p, top-k and top-p set to -inf. Expects temperature applied."""
    dev = logits.device
    col = lambda name: torch.tensor([getattr(s.params, name) for s in seqs], device=dev)[:, None]
    if any(s.params.min_p > 0 for s in seqs):
        # min-p (Nguyen et al., 2024): keep tokens at least min_p times as likely as the most likely one. It needs the
        # probabilities but no sort: one max per row.
        probs = torch.softmax(logits, dim=-1)
        logits = logits.masked_fill(probs < col("min_p") * probs.max(dim=-1, keepdim=True).values, float("-inf"))
    if any(s.params.top_k > 0 for s in seqs):
        # top-k: torch.topk finds the k largest without sorting the rest. Rows with top_k = 0 keep everything.
        k = col("top_k").clamp(min=0)
        kmax = int(k.max())
        kth = logits.topk(min(kmax, logits.shape[-1]), dim=-1).values.gather(-1, (k - 1).clamp(min=0))
        logits = logits.masked_fill((logits < kth) & (k > 0), float("-inf"))
    if any(s.params.top_p < 1.0 for s in seqs):
        # top-p, nucleus sampling (Holtzman et al., 2019): keep the smallest set of most likely tokens whose
        # probabilities add up to top_p. Finding that set takes a sort of the whole vocabulary, the slow part.
        sorted_logits, order = logits.sort(dim=-1, descending=True)
        sorted_p = torch.softmax(sorted_logits, dim=-1)
        drop = (sorted_p.cumsum(-1) - sorted_p) >= col("top_p")    # the mass before this token already reaches p
        sorted_logits = sorted_logits.masked_fill(drop, float("-inf"))
        logits = torch.empty_like(logits).scatter_(-1, order, sorted_logits)
    return logits


def sample(logits: torch.Tensor, seqs: list[Sequence], generator: torch.Generator, draws: int = 1) -> torch.Tensor:
    """Returns [len(seqs), draws] token ids. Rows with temperature 0 repeat their argmax in every column.

    The random draw uses the exponential race: with E_i drawn independently from Exp(1), argmax_i p_i / E_i is
    token i with probability p_i, the same distribution as a categorical draw. It needs one random number per token
    and an argmax, with no cumulative sum, no search and no copy back to the CPU. vLLM's V1 sampler draws this way;
    its V2 sampler adds Gumbel noise to the logits and takes the argmax, which is the same trick in log space."""
    apply_penalties(logits, seqs)
    logits = logits.float()
    greedy = logits.argmax(-1, keepdim=True).expand(-1, draws)
    temps = torch.tensor([s.params.temperature for s in seqs], device=logits.device)[:, None]
    if not (temps > 0).any():
        return greedy
    logits = filter_tail(logits / temps.clamp(min=1e-5), seqs)
    probs = torch.softmax(logits, dim=-1)
    race = torch.empty(len(seqs), draws, probs.shape[-1], device=probs.device).exponential_(generator=generator)
    drawn = (probs[:, None, :] / race).argmax(-1)
    return torch.where(temps == 0, greedy, drawn)
