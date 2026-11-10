# prefix_cache_sim.py: chapter 5.3's Mac lab. Two prefix caches written from scratch, with no model and no GPU.
#
#   RadixCache   the design of SGLang's RadixAttention: a radix tree over token ids. Each node holds a run of tokens
#                and stands for the KV slots of those tokens. A lookup walks the tree and splits a node if the match
#                ends inside it. Eviction removes the least recently used leaf that no running request has locked.
#   BlockCache   the design of vLLM's block pool (chapter 5.2): 16-token blocks, a table from a chained hash to a
#                block, and a free queue in which freed blocks keep their hash until they are handed out again.
#
# Both manage a pool of the same number of token slots and are driven by the same request traces, so the only thing
# that differs is the bookkeeping. The script replays three workloads through both at several pool sizes and prints
# the cache hit rate (prompt tokens found in the cache / prompt tokens), then compares scheduling orders on a
# waiting queue. It checks itself first: `python prefix_cache_sim.py --test` runs only the checks.
#
#   python prefix_cache_sim.py            # about 15 seconds on an M2, standard library only
import argparse
import heapq
import random
from collections import OrderedDict, deque

BLOCK = 16


class Full(Exception):
    """Every slot is held by a running request, so nothing can be evicted."""


# ------------------------------------------------------------------------------------------------ radix tree

class Node:
    __slots__ = ("key", "children", "parent", "lock", "last")

    def __init__(self, key=(), parent=None):
        self.key = key              # the run of token ids on the edge into this node
        self.children = {}          # first token of a child's key -> child
        self.parent = parent
        self.lock = 0               # how many running requests use this node
        self.last = 0               # logical time of the last lookup or insert that passed through


class RadixCache:
    name = "radix tree"

    def __init__(self, capacity: int):
        self.capacity, self.used, self.clock = capacity, 0, 0
        self.root = Node()
        self.root.lock = 1          # the root is never evicted
        self.evicted = 0

    # -- the tree ------------------------------------------------------------------------------------------
    def _split(self, child: Node, at: int) -> Node:
        """Cut child's key at `at`: a new node takes the first part and child keeps the rest."""
        top = Node(child.key[:at], child.parent)
        top.lock, top.last = child.lock, child.last
        child.parent.children[child.key[0]] = top
        child.key, child.parent = child.key[at:], top
        top.children[child.key[0]] = child
        return top

    def _walk(self, tokens, touch: bool, split: bool):
        """Follow tokens from the root. Returns (tokens matched, last node, tokens matched inside the next node)."""
        node, i = self.root, 0
        if touch:
            self.clock += 1
        while i < len(tokens) and tokens[i] in node.children:
            child = node.children[tokens[i]]
            k = 0
            while k < len(child.key) and i + k < len(tokens) and child.key[k] == tokens[i + k]:
                k += 1
            if touch:
                child.last = self.clock
            if k < len(child.key):                       # the match ends inside this node
                if not split:
                    return i + k, node, k
                node = self._split(child, k)
                return i + k, node, 0
            node, i = child, i + k
        return i, node, 0

    def match(self, tokens) -> tuple[int, Node]:
        n, node, _ = self._walk(tokens, touch=True, split=True)
        return n, node

    def peek(self, tokens) -> int:
        """Length of the cached prefix, without changing the tree. The scheduler uses this to sort its queue."""
        return self._walk(tokens, touch=False, split=False)[0]

    def insert(self, tokens) -> tuple[int, Node]:
        """Add tokens to the tree. Returns how many were there already and the node where they end."""
        n, node = self.match(tokens)
        if n < len(tokens):
            leaf = Node(tuple(tokens[n:]), node)
            leaf.last = self.clock
            node.children[leaf.key[0]] = leaf
            node = leaf
        return n, node

    def _lock(self, node: Node, by: int) -> None:
        while node is not self.root:                     # a request protects its whole path to the root
            node.lock += by
            node = node.parent

    # -- memory --------------------------------------------------------------------------------------------
    def _evict(self, need: int) -> None:
        heap, stack = [], [self.root]
        while stack:
            node = stack.pop()
            stack.extend(node.children.values())
            if not node.children and node.lock == 0:
                heap.append((node.last, id(node), node))
        heapq.heapify(heap)
        while need > 0 and heap:
            _, _, leaf = heapq.heappop(heap)             # the least recently used unlocked leaf
            del leaf.parent.children[leaf.key[0]]
            need -= len(leaf.key)
            self.used -= len(leaf.key)
            self.evicted += len(leaf.key)
            parent = leaf.parent
            if not parent.children and parent.lock == 0:
                heapq.heappush(heap, (parent.last, id(parent), parent))      # its parent may be a leaf now
        if need > 0:
            raise Full

    def _alloc(self, n: int) -> None:
        if self.capacity - self.used < n:
            self._evict(n - (self.capacity - self.used))
        self.used += n

    # -- a request's life ----------------------------------------------------------------------------------
    def start(self, prompt, out_len: int):
        hit, node = self.match(prompt[:-1])              # the last token must be run to produce logits
        self._lock(node, +1)                             # the matched path cannot be evicted to make room
        try:
            self._alloc(len(prompt) - hit + out_len)
        except Full:
            self._lock(node, -1)
            raise
        had, end = self.insert(prompt)                   # after the prefill, the prompt is in the tree
        self.used -= had - hit                           # slots another request filled in the meantime
        self._lock(end, +1), self._lock(node, -1)
        return hit, (end, prompt, out_len)

    def finish(self, handle, output) -> None:
        end, prompt, out_len = handle
        had, new_end = self.insert(tuple(prompt) + tuple(output))
        self.used -= had - len(prompt)
        self._lock(end, -1)

    def cached_tokens(self) -> int:
        total, stack = 0, [self.root]
        while stack:
            node = stack.pop()
            total += len(node.key)
            stack.extend(node.children.values())
        return total


# ------------------------------------------------------------------------------------------- hashed blocks

class BlockCache:
    name = "hashed blocks"

    def __init__(self, capacity: int):
        self.num_blocks = capacity // BLOCK
        self.free = OrderedDict((b, None) for b in range(self.num_blocks))     # the front is evicted first
        self.ref = [0] * self.num_blocks
        self.hash_of = [None] * self.num_blocks
        self.table = {}                                                         # chained hash -> block
        self.evicted = 0

    @staticmethod
    def hashes(tokens) -> list[int]:
        """One hash per full block; each covers its 16 tokens and the hash of the block before it."""
        out, parent = [], 0
        for i in range(0, len(tokens) - BLOCK + 1, BLOCK):
            parent = hash((parent, tuple(tokens[i:i + BLOCK])))
            out.append(parent)
        return out

    def _lookup(self, prompt) -> list[int]:
        found = []
        for h in self.hashes(prompt)[:(len(prompt) - 1) // BLOCK]:               # at most the prompt minus a token
            if h not in self.table:
                break
            found.append(self.table[h])
        return found

    def peek(self, prompt) -> int:
        return len(self._lookup(prompt)) * BLOCK

    def _publish(self, blocks, tokens) -> None:
        for block, h in zip(blocks, self.hashes(tokens)):
            if self.hash_of[block] is None and h not in self.table:
                self.table[h], self.hash_of[block] = block, h

    def start(self, prompt, out_len: int):
        found = self._lookup(prompt)
        for b in found:                                  # touch: a block in use leaves the free queue
            if self.ref[b] == 0:
                del self.free[b]
            self.ref[b] += 1
        need = -(-(len(prompt) + out_len) // BLOCK) - len(found)
        if need > len(self.free):
            for b in found:                              # undo, so the caller can retry later
                self.ref[b] -= 1
                if self.ref[b] == 0:
                    self.free[b] = None
            raise Full
        new = []
        for _ in range(need):
            b, _ = self.free.popitem(last=False)         # take from the front
            if self.hash_of[b] is not None:              # eviction is nothing more than this
                del self.table[self.hash_of[b]]
                self.hash_of[b] = None
                self.evicted += BLOCK
            self.ref[b] = 1
            new.append(b)
        blocks = found + new
        self._publish(blocks, prompt)
        return len(found) * BLOCK, (blocks, prompt)

    def finish(self, handle, output) -> None:
        blocks, prompt = handle
        self._publish(blocks, tuple(prompt) + tuple(output))
        for b in reversed(blocks):                       # the tail of the request is freed, and evicted, first
            self.ref[b] -= 1
            if self.ref[b] == 0:
                self.free[b] = None                      # a block with a hash goes to the back
                if self.hash_of[b] is None:
                    self.free.move_to_end(b, last=False)     # one without goes to the front

    def cached_tokens(self) -> int:
        return len(self.table) * BLOCK


class NoCache:
    name = "no cache"
    evicted = 0

    def __init__(self, capacity: int):
        pass

    def start(self, prompt, out_len):
        return 0, None

    def finish(self, handle, output):
        pass

    def peek(self, prompt):
        return 0


# ----------------------------------------------------------------------------------------------- workloads

def toks(rng: random.Random, n: int) -> tuple:
    return tuple(rng.randrange(32000) for _ in range(n))


def chat(conversations=24, turns=8, system=800, user=(20, 100), answer=(50, 250), gap=6, seed=0):
    """Multi-turn chat. Every conversation starts with the same system prompt, and each turn resends the whole
    history: the previous prompt, the model's answer, and a new user message. Turns of different conversations
    are interleaved at random, as they are on a server. A conversation waits for at least `gap` other requests
    before its next turn, because a user cannot reply to an answer that has not arrived."""
    rng = random.Random(seed)
    sys_prompt = toks(rng, system)
    history = [sys_prompt] * conversations
    left = [turns] * conversations
    out, recent = [], deque(maxlen=gap)
    while any(left):
        ready = [i for i, n in enumerate(left) if n and i not in recent] or [i for i, n in enumerate(left) if n]
        c = rng.choice(ready)
        recent.append(c)
        prompt = history[c] + toks(rng, rng.randint(*user))
        output = toks(rng, rng.randint(*answer))
        out.append((prompt, output))
        history[c] = prompt + output
        left[c] -= 1
    return out


def few_shot(requests=200, examples=2000, question=(20, 60), answer=(5, 20), seed=1):
    """One block of worked examples, then a different question each time."""
    rng = random.Random(seed)
    shots = toks(rng, examples)
    return [(shots + toks(rng, rng.randint(*question)), toks(rng, rng.randint(*answer))) for _ in range(requests)]


def tenants(requests=300, count=12, system=(1000, 2000), user=(20, 100), answer=(50, 150), seed=2):
    """Twelve applications share a server. Each has its own system prompt, and a few are much busier than the rest."""
    rng = random.Random(seed)
    prompts = [toks(rng, rng.randint(*system)) for _ in range(count)]
    weights = [1 / (i + 1) for i in range(count)]                    # Zipf: tenant 1 is twice as busy as tenant 2
    return [(rng.choices(prompts, weights)[0] + toks(rng, rng.randint(*user)), toks(rng, rng.randint(*answer)))
            for _ in range(requests)]


# ------------------------------------------------------------------------------------------------- replay

def replay(cache, trace, concurrency=4, order="fcfs"):
    """Run a trace through a cache with `concurrency` requests in flight; the oldest finishes when a slot is needed.
    order: fcfs takes requests as they come; lpm takes the waiting request with the longest cached prefix."""
    waiting, running = list(trace), deque()
    hit_tokens = prompt_tokens = 0
    while waiting:
        if order == "lpm":
            i = max(range(len(waiting)), key=lambda j: (cache.peek(waiting[j][0]), -j))
        else:
            i = 0
        prompt, output = waiting.pop(i)
        while True:
            if len(running) >= concurrency:
                cache.finish(*running.popleft())
            try:
                hit, handle = cache.start(prompt, len(output))
                break
            except Full:
                if not running:
                    raise SystemExit(f"a pool of this size cannot hold one request of {len(prompt) + len(output)} tokens")
                cache.finish(*running.popleft())
        running.append((handle, output))
        hit_tokens += hit
        prompt_tokens += len(prompt)
    while running:
        cache.finish(*running.popleft())
    return hit_tokens / prompt_tokens, prompt_tokens


def best_possible(trace) -> float:
    """The hit rate of a cache that never evicts: every token a request shares with any earlier request."""
    cache = RadixCache(10 ** 12)
    return replay(cache, trace, concurrency=1)[0]


# -------------------------------------------------------------------------------------------------- checks

def test() -> None:
    a = tuple(range(100, 140))                    # 40 tokens
    # The tree: three prompts that share 24 tokens become one node of 24 and three leaves.
    tree = RadixCache(1000)
    for tail in ((1, 2, 3), (4, 5), (6,)):
        hit, handle = tree.start(a[:24] + tail, 0)
        tree.finish(handle, ())
    assert len(tree.root.children) == 1 and len(next(iter(tree.root.children.values())).children) == 3
    assert tree.used == tree.cached_tokens() == 24 + 3 + 2 + 1
    assert tree.peek(a[:24] + (4, 9)) == 25 and tree.peek(a[:10] + (0,)) == 10
    # A match never covers the last token of the prompt.
    assert tree.start(a[:24] + (4, 5), 0)[0] == 25

    # Eviction takes the least recently used leaf and leaves the shared parent alone.
    tree = RadixCache(30)
    for tail in ((1, 2, 3), (4, 5, 6)):
        tree.finish(tree.start(a[:20] + tail, 0)[1], ())
    assert tree.used == 26
    tree.finish(tree.start(a[:20] + (7,) * 6, 0)[1], ())            # needs 6 slots, 4 are free: evicts (1, 2, 3)
    assert tree.peek(a[:20] + (1, 2, 3)) == 20 and tree.peek(a[:20] + (4, 5, 6)) == 23 and tree.used == 29

    # A locked path is not evicted, and a pool full of running requests raises Full.
    tree = RadixCache(30)
    _, running = tree.start(a[:25], 0)
    try:
        tree.start(tuple(range(900, 910)), 0)
        raise AssertionError("expected Full")
    except Full:
        pass
    tree.finish(running, ())
    assert tree.start(tuple(range(900, 910)), 0)[0] == 0 and tree.peek(a[:25]) < 25

    # Blocks: a hit is whole blocks, at most the prompt minus one token.
    blocks = BlockCache(160)
    hit, handle = blocks.start(a, 0)                               # 40 tokens: 2 full blocks and 8 tokens
    assert hit == 0
    blocks.finish(handle, ())
    assert blocks.start(a, 0)[0] == 32 and blocks.peek(a[:32]) == 16 and blocks.peek(a[:20] + (0,) * 20) == 16
    # A freed block keeps its hash; taking it for something else is what evicts it. The tail goes first.
    blocks = BlockCache(64)                                        # 4 blocks
    blocks.finish(blocks.start(a[:32], 0)[1], ())                  # blocks 0 and 1 cached; 2 and 3 never used
    assert blocks.cached_tokens() == 32
    blocks.finish(blocks.start(tuple(range(500, 548)), 0)[1], ())  # 3 blocks: the two unused ones, then a's tail
    assert blocks.peek(a[:32] + (0,)) == 16 and blocks.evicted == 16

    # Both designs find the same prefixes when nothing is evicted, to within a block per request.
    trace = chat(conversations=6, turns=5)
    r, _ = replay(RadixCache(10 ** 9), trace)
    b, _ = replay(BlockCache(10 ** 9 // BLOCK * BLOCK), trace)
    assert 0 < r - b < BLOCK * len(trace) / sum(len(p) for p, _ in trace), (r, b)
    assert replay(NoCache(0), trace)[0] == 0
    print("all checks passed")


# ---------------------------------------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true", help="run only the self-checks")
    a = ap.parse_args()
    test()
    if a.test:
        return

    print("\nHit rate (cached prompt tokens / prompt tokens), 4 requests in flight, first come first served")
    for label, trace, sizes in (
            ("multi-turn chat: 24 conversations of 8 turns, one 800-token system prompt", chat(), (4096, 8192, 16384, 32768, 65536)),
            ("few-shot: 200 questions after the same 2,000 tokens of examples", few_shot(), (4096, 8192, 16384)),
            ("12 tenants, each with its own system prompt of 1,000 to 2,000 tokens", tenants(), (4096, 8192, 16384, 32768))):
        total = sum(len(p) for p, _ in trace)
        unique = RadixCache(10 ** 12)
        replay(unique, trace, concurrency=1)
        print(f"\n{label}\n  {len(trace)} requests, {total:,} prompt tokens, {unique.cached_tokens():,} distinct tokens to hold; "
              f"a cache that never evicts reaches {best_possible(trace):.1%}")
        print(f"  {'pool, tokens':>14} {'radix tree':>12} {'hashed blocks':>14} {'evicted, tree':>14} {'evicted, blocks':>16}")
        for size in sizes:
            tree, blocks = RadixCache(size), BlockCache(size)
            r, _ = replay(tree, trace)
            b, _ = replay(blocks, trace)
            print(f"  {size:>14,} {r:>12.1%} {b:>14.1%} {tree.evicted:>14,} {blocks.evicted:>16,}")

    print("\nScheduling order: 120 waiting requests from 6 few-shot tasks of 2,000 tokens each, shuffled,")
    print("one request in flight")
    rng = random.Random(3)
    queue = [r for task in range(6) for r in few_shot(requests=20, seed=10 + task)]
    rng.shuffle(queue)
    print(f"  {'pool, tokens':>14} {'first come first served':>24} {'longest prefix first':>21}")
    for size in (2560, 4608, 6656, 12800):
        fcfs, _ = replay(RadixCache(size), queue, concurrency=1)
        lpm, _ = replay(RadixCache(size), queue, concurrency=1, order="lpm")
        print(f"  {size:>14,} {fcfs:>24.1%} {lpm:>21.1%}")


if __name__ == "__main__":
    main()
