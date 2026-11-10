# kv_cache.py: the paged KV cache's bookkeeping. The keys and values themselves live in one big tensor that the
# model runner owns ([layers, 2, num_blocks, block_size, kv_heads, head_dim]); this class only decides which block
# each token goes in.
#
# Blocks are handed out one at a time as a sequence grows, from a free list, and come back when it finishes or is
# preempted. Each block has a reference count, so sequences forked from one prompt (parallel sampling) can share
# the prompt's blocks. A sequence about to write into a block that another sequence still uses gets its own copy
# first: copy-on-write.
import math
from collections import deque

from .sequence import Sequence


class BlockManager:
    def __init__(self, num_blocks: int, block_size: int):
        self.num_blocks = num_blocks
        self.block_size = block_size
        self.free_blocks = deque(range(num_blocks))
        self.ref_count = [0] * num_blocks

    @property
    def num_free(self) -> int:
        return len(self.free_blocks)

    def _take(self) -> int:
        block = self.free_blocks.popleft()
        self.ref_count[block] = 1
        return block

    def _release(self, block: int) -> None:
        self.ref_count[block] -= 1
        if self.ref_count[block] == 0:
            self.free_blocks.append(block)

    def blocks_needed(self, seq: Sequence, num_new_tokens: int) -> int:
        """Free blocks the sequence needs before it can write num_new_tokens more tokens into the cache: new blocks
        for positions past its last block, plus one if its last block is shared and must be copied first."""
        total = math.ceil((seq.num_computed + num_new_tokens) / self.block_size)
        new = max(0, total - len(seq.block_table))
        return new + (1 if self._needs_copy(seq) else 0)

    def _needs_copy(self, seq: Sequence) -> bool:
        # The first new token goes into the last block when that block is only partly full.
        partly_full = seq.num_computed % self.block_size != 0
        return partly_full and seq.num_computed > 0 and self.ref_count[seq.block_table[-1]] > 1

    def can_append(self, seq: Sequence, num_new_tokens: int) -> bool:
        return self.blocks_needed(seq, num_new_tokens) <= self.num_free

    def append(self, seq: Sequence, num_new_tokens: int) -> list[tuple[int, int]]:
        """Give the sequence room for num_new_tokens more tokens. Returns the (source, destination) block copies the
        model runner must make before writing, which is non-empty only for copy-on-write."""
        copies = []
        if self._needs_copy(seq):
            shared = seq.block_table[-1]
            own = self._take()
            self._release(shared)
            seq.block_table[-1] = own
            copies.append((shared, own))
        total = math.ceil((seq.num_computed + num_new_tokens) / self.block_size)
        while len(seq.block_table) < total:
            seq.block_table.append(self._take())
        return copies

    def fork(self, parent: Sequence, child: Sequence) -> None:
        """The child shares every block of the parent; each block's reference count goes up by one."""
        child.block_table = list(parent.block_table)
        for block in child.block_table:
            self.ref_count[block] += 1

    def free(self, seq: Sequence) -> None:
        for block in seq.block_table:
            self._release(block)
        seq.block_table = []

    def slot(self, seq: Sequence, position: int) -> int:
        """Where the token at this position lives in the cache, counted in tokens from the start of block 0."""
        return seq.block_table[position // self.block_size] * self.block_size + position % self.block_size
