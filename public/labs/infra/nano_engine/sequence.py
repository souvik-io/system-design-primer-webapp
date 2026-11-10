# sequence.py: what the engine knows about one sequence of tokens.
#
# A request asks for n completions of one prompt; each completion is a Sequence. A sequence holds every token so
# far (prompt, then output), how many of them already have keys and values in the KV cache (num_computed), and the
# KV cache blocks that hold them (block_table). The scheduler moves sequences between WAITING and RUNNING; the
# engine finishes them.
from dataclasses import dataclass
from enum import Enum
from itertools import count


@dataclass
class SamplingParams:
    temperature: float = 1.0      # 0 means greedy: always the most likely token
    top_p: float = 1.0            # sample only from the smallest set of tokens whose probabilities sum to top_p
    max_tokens: int = 64
    n: int = 1                    # completions per prompt; they share the prompt's KV blocks (copy-on-write)
    ignore_eos: bool = False      # keep generating after the end-of-sequence token (for benchmarks)


class Status(Enum):
    WAITING = "waiting"
    RUNNING = "running"
    FINISHED = "finished"


_ids = count()


class Sequence:
    def __init__(self, request_id: str, prompt: list[int], params: SamplingParams, index: int = 0):
        self.seq_id = next(_ids)           # also the arrival order, which the scheduler uses for fairness
        self.request_id = request_id
        self.index = index                 # which of the request's n completions this is
        self.token_ids = list(prompt)
        self.num_prompt_tokens = len(prompt)
        self.num_computed = 0              # tokens whose keys and values are in the KV cache
        self.block_table: list[int] = []   # physical KV blocks, in token order
        self.params = params
        self.status = Status.WAITING
        self.finish_reason: str | None = None
        self.num_preemptions = 0
        self.forked = params.n == 1        # a request with n > 1 forks into n sequences after its prompt

    @property
    def num_tokens(self) -> int:
        return len(self.token_ids)

    @property
    def output_ids(self) -> list[int]:
        return self.token_ids[self.num_prompt_tokens :]

    @property
    def num_uncomputed(self) -> int:
        """Tokens still to run through the model: the whole prompt at first, a prompt's remainder after a prefill
        chunk, one token while decoding, or everything again after preemption."""
        return self.num_tokens - self.num_computed
