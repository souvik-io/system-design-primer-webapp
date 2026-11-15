# structured.py: structured output with xgrammar (chapter 5.5).
#
# A request may carry a JSON schema, a regular expression or a grammar. The engine compiles it once into a grammar
# over the model's vocabulary, gives the sequence a matcher, the grammar's state for that sequence, and then on
# every step:
#   1. fills a bitmask with one bit per vocabulary token: 1 if the grammar allows the token next, 0 if not
#   2. sets the logits of the forbidden tokens to -inf, before any sampling setting is applied
#   3. after sampling, moves the matcher forward by the chosen token
# A sequence whose grammar has reached its end is allowed only the end-of-sequence token, so it stops there.
#
# Jump-forward decoding (from SGLang): when the grammar allows exactly one continuation, such as the text
# '", "age": ' between two fields of a fixed schema, there is nothing for the model to choose. The engine can append
# those tokens without sampling them. They still go through the model, so that their keys and values are in the KV
# cache, but all of them in one step, the way a chunk of a prompt does, instead of one per step.
import time

import torch
import xgrammar as xgr

from .sequence import Sequence


class StructuredOutput:
    def __init__(self, tokenizer, vocab_size: int, stop_token_ids: list[int], jump_forward: bool = False,
                 any_whitespace: bool = False):
        # The model's output layer can be wider than the tokenizer's vocabulary (padded to a multiple of 64 or 128);
        # the bitmask covers every logit, and the padding tokens are always forbidden.
        self.info = xgr.TokenizerInfo.from_huggingface(tokenizer, vocab_size=vocab_size, stop_token_ids=stop_token_ids)
        self.compiler = xgr.GrammarCompiler(self.info, max_threads=8)     # keeps compiled grammars in a cache
        self.tokenizer = tokenizer
        self.vocab_size = vocab_size
        self.jump_forward = jump_forward
        # Whether a JSON schema allows whitespace between tokens of JSON. If it does, a model can lay the JSON out as
        # it learned to, and a small one can also emit whitespace until max_tokens. If not, the layout is fixed to
        # '{"a": 1, "b": 2}', which is what the model must then write, whether or not it would have.
        self.any_whitespace = any_whitespace
        self.stats = {"compile_s": 0.0, "compiles": 0, "fill_s": 0.0, "apply_s": 0.0, "masks": 0,
                      "jump_forward_tokens": 0}

    def compile(self, kind: str, text: str) -> xgr.CompiledGrammar:
        t = time.perf_counter()
        if kind == "json":
            compiled = (self.compiler.compile_builtin_json_grammar() if text in ("{}", '"object"', "object")
                        else self.compiler.compile_json_schema(text, any_whitespace=self.any_whitespace))
        elif kind == "regex":
            compiled = self.compiler.compile_regex(text)
        else:
            compiled = self.compiler.compile_grammar(text)
        self.stats["compile_s"] += time.perf_counter() - t
        self.stats["compiles"] += 1
        return compiled

    def attach(self, seq: Sequence) -> None:
        """Give a new sequence its matcher. vLLM compiles in a thread pool and keeps the request waiting until the
        grammar is ready, so a slow compile does not hold up the batch; here it is done in line, and timed."""
        constraint = seq.params.constraint
        if constraint:
            try:
                seq.matcher = xgr.GrammarMatcher(self.compile(*constraint))
            except Exception as e:                    # an invalid schema is the client's error, not the engine's
                raise ValueError(f"cannot compile the {constraint[0]} constraint: {e}") from e

    def mask(self, logits: torch.Tensor, seqs: list[Sequence]) -> None:
        """Set the logits of the tokens each constrained sequence's grammar forbids to -inf, in place."""
        rows = [i for i, s in enumerate(seqs) if s.matcher is not None]
        if not rows:
            return
        t = time.perf_counter()
        bitmask = xgr.allocate_token_bitmask(len(seqs), self.vocab_size)   # int32, 32 tokens per word, all 1s
        for i in rows:
            seqs[i].matcher.fill_next_token_bitmask(bitmask, i)
        t2 = time.perf_counter()
        xgr.apply_token_bitmask_inplace(logits, bitmask.to(logits.device, non_blocking=True), indices=rows)
        self.stats["fill_s"] += t2 - t
        self.stats["apply_s"] += time.perf_counter() - t2
        self.stats["masks"] += len(rows)

    def accept(self, seq: Sequence, token: int) -> None:
        if seq.matcher is not None and not seq.matcher.accept_token(token):
            raise RuntimeError(f"the grammar rejected token {token}, which its own mask allowed")

    def forced_tokens(self, seq: Sequence, room: int) -> list[int]:
        """Jump-forward: the tokens of the text the grammar forces next, already accepted by the matcher. At most
        `room` of them, so that max_tokens still holds."""
        if not (self.jump_forward and seq.matcher is not None) or seq.matcher.is_terminated() or room <= 0:
            return []
        text = seq.matcher.find_jump_forward_string()
        if not text:
            return []
        # The forced text has to become tokens, and the tokenizer's split of it on its own may not be how the model
        # would have split it in context. The last token is the risky one: '": "' could be followed by a word that
        # merges with the quote into one token. Dropping it leaves the boundary for the model to choose.
        ids = self.tokenizer.encode(text, add_special_tokens=False)[:-1][:room]
        accepted = []
        for t in ids:
            if not seq.matcher.accept_token(t):
                break
            accepted.append(t)
        self.stats["jump_forward_tokens"] += len(accepted)
        return accepted
