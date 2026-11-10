# scheduler.py: continuous batching with a token budget, chunked prefill and preemption by recomputation.
#
# Each step the scheduler decides how many tokens of which sequences the model runs, like vLLM's V1 scheduler: there
# are no prefill and decode phases, only sequences with tokens not yet in the KV cache. Running sequences go first,
# in the order they were admitted, so every decode gets its token; then waiting sequences are admitted while the
# budget, the sequence limit and free blocks last. A prompt longer than what is left of the budget is cut into
# chunks and finished over several steps (chunked prefill). When a running sequence needs a block and none is
# free, the most recently admitted sequence is preempted: its blocks are freed and it goes back to the front of
# the queue, to be recomputed from its tokens later.
from collections import deque
from dataclasses import dataclass, field

from .kv_cache import BlockManager
from .sequence import Sequence, Status


@dataclass
class SchedulerConfig:
    max_num_seqs: int = 256              # sequences in one step
    max_num_batched_tokens: int = 2048   # tokens in one step: the token budget
    chunked_prefill: bool = True         # otherwise a prompt must fit in one step's budget


@dataclass
class Batch:
    seqs: list[Sequence] = field(default_factory=list)
    num_tokens: list[int] = field(default_factory=list)          # tokens each sequence runs this step
    copies: list[tuple[int, int]] = field(default_factory=list)  # copy-on-write block copies to make first
    preempted: list[Sequence] = field(default_factory=list)

    def add(self, seq: Sequence, n: int, copies: list[tuple[int, int]]) -> None:
        self.seqs.append(seq)
        self.num_tokens.append(n)
        self.copies += copies


class Scheduler:
    def __init__(self, config: SchedulerConfig, blocks: BlockManager):
        self.config = config
        self.blocks = blocks
        self.waiting: deque[Sequence] = deque()
        self.running: list[Sequence] = []

    def add(self, seq: Sequence) -> None:
        self.waiting.append(seq)

    def has_work(self) -> bool:
        return bool(self.waiting or self.running)

    def _chunk(self, seq: Sequence, budget: int) -> int:
        """How many of the sequence's uncomputed tokens to run this step; 0 if it cannot run."""
        n = min(seq.num_uncomputed, budget)
        if n < seq.num_uncomputed and not self.config.chunked_prefill:
            return 0
        return n

    def _preempt(self, seq: Sequence, batch: Batch) -> None:
        self.running.remove(seq)
        self.blocks.free(seq)
        seq.num_computed = 0               # recompute: the prompt and the output so far become one new prompt
        seq.status = Status.WAITING
        seq.num_preemptions += 1
        self.waiting.appendleft(seq)
        batch.preempted.append(seq)

    def schedule(self) -> Batch:
        batch = Batch()
        budget = self.config.max_num_batched_tokens

        # 1. Running sequences, oldest first: decodes, and prompts that are partway through a chunked prefill.
        for seq in list(self.running):
            if seq.status is not Status.RUNNING:
                continue                    # preempted earlier in this loop
            n = self._chunk(seq, budget)
            if n == 0:
                continue
            while not self.blocks.can_append(seq, n):
                victim = self.running[-1]   # the most recently admitted sequence
                self._preempt(victim, batch)
                if victim is seq:
                    break
            if seq.status is not Status.RUNNING:
                continue
            batch.add(seq, n, self.blocks.append(seq, n))
            budget -= n

        # 2. Waiting sequences, in arrival order, unless this step had to preempt (memory is short).
        while self.waiting and budget > 0 and not batch.preempted and len(self.running) < self.config.max_num_seqs:
            seq = self.waiting[0]
            n = self._chunk(seq, budget)
            if n == 0 or not self.blocks.can_append(seq, n):
                break                       # first come, first served: do not let later requests overtake it
            self.waiting.popleft()
            seq.status = Status.RUNNING
            self.running.append(seq)
            batch.add(seq, n, self.blocks.append(seq, n))
            budget -= n
        return batch

    def finish(self, seq: Sequence, reason: str) -> None:
        seq.status = Status.FINISHED
        seq.finish_reason = reason
        if seq in self.running:
            self.running.remove(seq)
        elif seq in self.waiting:
            self.waiting.remove(seq)
        self.blocks.free(seq)
