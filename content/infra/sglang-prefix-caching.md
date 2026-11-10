# SGLang and prefix caching

[Chapter 5.2](/learn/inside-vllm) ended with one measurement of prefix caching: 63 requests that shared a 3,000-token prefix finished 12.7 times sooner when vLLM could reuse the prefix's keys and values. That experiment was the easy case, with one prefix, sent in advance, on an idle server. This chapter is about the general problem. A server holds the KV of thousands of earlier requests, a new prompt arrives, and the engine must find the longest stored prefix of it, keep that prefix alive while it is in use, decide what to throw away when memory runs out, and, if it is clever, choose which waiting request to run next so that the cache is used well.

SGLang is the engine that was designed around this problem. Its paper calls the technique RadixAttention: the KV cache of every request, finished or running, is indexed by a radix tree over token ids. vLLM solves the same problem with hashed blocks. The chapter reads SGLang's design against vLLM's, implements both in a few hundred lines to see where they differ, and then measures the two engines on a multi-turn chat workload on an H100.

Everything about SGLang refers to **SGLang 0.5.23** (commit `297e54f`, 28 October 2026), and everything about vLLM to 0.32.0, the version of chapter 5.2. Paths for SGLang are under `python/sglang/srt/`. Before this chapter, read [Inside vLLM](/learn/inside-vllm), whose section on the block pool this chapter builds on.

## Where prefixes repeat

The keys and values of a token depend on that token and on every token before it, and on nothing after it. This is a property of causal attention ([The transformer, seen by the hardware](/learn/transformer-as-workload)), and it is the whole basis of prefix caching: if two prompts agree on their first n tokens, the KV of those n tokens is identical in both, and the second prompt can use the first one's. The reuse is exact. The model produces the same logits it would have produced by computing everything again.

The same property sets the limit. Only a prefix can be reused. If two prompts share a 2,000-token document but one of them has a different first sentence, every token of the document sees a different past, and nothing can be shared.

Four kinds of traffic have long shared prefixes.

- **System prompts.** Every request of an application starts with the same instructions, tool definitions and policies, often thousands of tokens of them.
- **Multi-turn chat.** Chat APIs are stateless, so each turn resends the whole conversation. Turn 6 of a conversation is turn 5's prompt, turn 5's answer and one new message.
- **Agents.** An agent loop is a chat in which the turns are tool calls and their results. Each step resends everything so far, and the history grows by a tool result at a time.
- **Few-shot prompts and shared documents.** A batch of questions is asked against the same examples, or many questions against one long document.

What the cache saves is prefill. In chapter 5.2's trace, a 2,022-token prompt took 85.8 ms to its first token when nearly everything was computed, and a second prompt of 2,021 tokens, whose first 2,000 tokens were found in the cache, took 31.1 ms. Decoding is not affected, so the saving shows in time to first token and in the GPU time that prefill would have taken from other requests, and it grows with the ratio of prompt length to output length. For an agent that sends 20,000 tokens of history to receive a 100-token tool call, prefill is nearly all of the work.

What the cache costs is memory. The KV of one token of Llama 3.1 8B takes 131,072 bytes, so a cached 2,000-token system prompt holds 262 MB of the KV pool for as long as it stays. Neither engine reserves separate memory for this. Cached tokens live in the same pool as the tokens of running requests, and are given up when running requests need the space.

Because a hit requires the tokens to match from position 0, small things in a prompt decide whether the cache works at all. A timestamp or a request id at the top of a system prompt changes the first tokens of every request and makes every one of them a miss. So does serializing tool definitions in a different order from one request to the next. The rule for writing prompts follows directly: put what never changes first, what changes per user next, and what changes per request last.

## A radix tree over token ids

A trie stores sequences so that sequences with a common prefix share a path from the root. A radix tree is a trie in which a chain of nodes with one child each is merged into a single node, so each node holds a run of tokens. SGLang's tree stores token sequences, and each node stands for the KV of the tokens in its run.

```diagram
title: Five requests in a radix tree. Each box is a node: a run of tokens and the KV slots that hold them
[r:note] root @ 0,1
[s] System prompt\n2,000 tokens @ 1,0.5
[a1] Chat A, turn 1\n180 tokens @ 2,0
[a2] Chat A, turn 2\n210 tokens @ 3,0
[b1] Chat B, turn 1\n150 tokens @ 2,1
[f] Examples\n1,200 tokens @ 1,2.5
[q1] Question 1\n40 tokens @ 2,2
[q2] Question 2\n35 tokens @ 2,3
r -> s
r -> f
s -> a1
s -> b1
a1 -> a2
f -> q1
f -> q2
```

A node (`TreeNode` in `mem_cache/radix_cache.py`) has four things that matter here.

| Field | What it holds |
|---|---|
| `key` | The token ids of this node's run |
| `value` | One KV slot index per token of the key: where in the pool that token's keys and values are |
| `children` | A dictionary from the first token of each child's key to the child |
| `lock_ref`, `last_access_time` | How many running requests use this node, and when it was last matched |

The memory underneath is simpler than vLLM's. With SGLang's defaults on an NVIDIA GPU, the page size is 1: the pool is an array of token slots, the allocator (`TokenToKVPoolAllocator`) hands out individual slot indices, and a table with one row per running request (`req_to_token`) maps each position of the request to its slot. Where vLLM's block table has one entry per 16 tokens, SGLang's has one per token. A cache hit therefore has no block boundary to round down to, and a request that reuses a prefix simply copies the prefix's slot indices into its own row.

Looking up a prompt is a walk from the root. This is the lookup in the Python class, shortened.

```python
def _match_prefix_helper(self, node, key):
    access_time = time.monotonic()
    child_key = key.child_key(self.page_size)          # the first token of what is left
    value = []
    while len(key) > 0 and child_key in node.children.keys():
        child = node.children[child_key]
        child.last_access_time = access_time
        prefix_len = child.key.match(key)              # how many tokens of this node's run agree
        if prefix_len < len(child.key):                # the prompt leaves the run partway through
            new_node = self._split_node(child.key, child, prefix_len)
            value.append(new_node.value)
            node = new_node
            break
        value.append(child.value)                      # the whole run matched: take its slots, go deeper
        node = child
        key = key[prefix_len:]
        if len(key):
            child_key = key.child_key(self.page_size)
    return value, node
```

At each node the walk does one dictionary lookup on the next token, then compares the node's run with the prompt. `RadixKey.match` does the comparison with slices of an integer array, doubling the window until it finds a difference and then halving it to find the exact token, so a 2,000-token run that matches completely is compared in eleven C-level comparisons and not in a Python loop over tokens. The cost of a lookup is proportional to the number of nodes on the path, and a path has one node per point where earlier prompts diverged, which is far fewer than its tokens.

When the prompt agrees with only the first part of a node's run, the node is **split**: a new node takes the part that matched and becomes the parent of the old node, which keeps the rest. The slot indices are divided the same way and no KV moves. Splitting is what keeps the invariant that makes the tree useful: every point where two stored sequences diverge is a node boundary, so "the longest cached prefix of this prompt" is always "the path to some node".

In 0.5.23 the tree a default server uses is no longer this Python class. `mem_cache/registry.py` builds a `UnifiedRadixCache`, whose tree is implemented in Rust (`rust/sglang-radix-tree/`), with a Python implementation of the same contract as the fallback. The structure and the operations are the ones described here: nodes with a key, a value and children, a match that splits, and eviction from the leaves. The Python class is still in the source, is still used for the scheduler's own small tree described below, and is the right file to read first.

## A request's life in the tree

Five moments in a request's life touch the tree. Each has a counterpart in vLLM, and the table after the list puts them side by side.

1. **Admission: match and lock.** When the scheduler considers a waiting request it matches the prompt against the tree. The match may cover at most the prompt minus its last token (`_compute_max_prefix_len` in `managers/schedule_batch.py`), because the last token has to be run to produce the logits of the first output token. The request then locks the node where the match ended: `lock_ref` is incremented on that node and on every ancestor up to the root. A node with a nonzero `lock_ref` cannot be evicted, so the prefix stays in place while the request uses it.
2. **Allocation, with eviction on demand.** The request needs slots for the tokens that were not matched. If the free list is short, the allocator asks the tree to evict enough leaves to cover the shortfall (`evict_to_free_tokens` in `mem_cache/allocator/base.py`). Nothing is evicted before that moment. When the scheduler decides whether a request fits, it counts evictable cache as available memory.
3. **After the prefill: publish the prompt.** As soon as the request's prefill result is processed, `checkpoint_kv_cache` inserts the prompt into the tree and moves the request's lock to the new node. From then on a second request with the same prefix shares it, while the first is still decoding. A prompt that is prefilled in chunks is published after each chunk.
4. **At the end: publish the answer.** When the request finishes, the prompt and the generated tokens are inserted, and the lock is released. This is what makes multi-turn chat work: the next turn's prompt begins with this turn's prompt and answer, and both are in the tree. The insert splits the new node at the end of the prompt, so that eviction can later drop the answer and keep the prompt.
5. **Eviction.** The tree keeps the set of leaves with `lock_ref` 0. To evict, it puts them in a heap ordered by the eviction policy, removes the first, frees its slots, and if the removed leaf's parent has now become an unlocked leaf, adds the parent to the heap. The default policy, `--radix-eviction-policy lru`, orders leaves by `last_access_time`; `lfu`, `slru`, `priority` and `tlru` are the other choices. Leaves go first because a leaf is a suffix that only one stored sequence needs, and evicting an inner node would orphan everything below it.

The pool can still fill up with running requests, which no eviction can help. SGLang then **retracts** some of them (`retract_decode` in `managers/schedule_batch.py`), which is vLLM's preemption by recomputation under another name. The requests with the fewest output tokens go first, their KV is freed without being put in the tree, and they return to the waiting queue with the output they have so far.

| | SGLang 0.5.23 | vLLM 0.32.0 |
|---|---|---|
| Index | A radix tree over token ids | A hash table from chained block hashes to blocks |
| Unit of memory | 1 token (page size 1 by default) | A block of 16 tokens |
| Longest possible hit | Prompt length minus 1 | The whole blocks within prompt length minus 1 |
| Lookup cost | One step per tree node on the path, each a slice comparison | One SHA-256 per block when the request arrives, then one table lookup per block |
| What protects a prefix in use | `lock_ref` on every node of the path | A reference count on every block |
| When a prompt becomes shareable | After its prefill step has run | When its blocks are allocated, before the step runs |
| Is the answer cached | Yes, at the end of the request | Yes, block by block as the output fills blocks |
| What is evicted | The least recently used unlocked leaf, whole | The block at the front of the free queue |
| When | When an allocation is short | When the block is handed out again |
| Order within one request | Answer before prompt, later turns before earlier | Tail blocks before head blocks |
| Pool full of running requests | Retract the requests with the fewest output tokens | Preempt the request that started running last |

Two of these rows describe real differences in behaviour, and the rest describe two implementations of the same policy.

The first is granularity. A vLLM hit is rounded down to a multiple of 16 tokens, so each request recomputes up to 15 tokens that a token-level cache would have found. Against prompts of thousands of tokens this is under one percent.

The second is the moment of publication, and it matters when many requests with the same new prefix arrive together. vLLM enters a block in its table when the block is allocated, so a request scheduled one step after another can already share the first one's blocks, even though the first has not finished computing them. That is safe because the step that fills them is already ahead in the queue. SGLang publishes after the prefill, so requests admitted in the same batch as the first each compute the prefix for themselves, unless the scheduler holds them back, which is the subject of the section on scheduling.

Everything else in the table is the same idea twice. Both engines keep cached KV in the pool that running requests use, both give it no size setting of its own, both evict in least-recently-used order from the ends of sequences inward, and both protect what a running request reads by counting references. A chained hash is a way of naming a path in a trie without storing the trie: the hash of block k identifies the same thing as the tree node reached after 16k tokens.

## Measuring the two designs without a GPU

The claim that the two designs behave alike is easy to test, because neither needs a model. [prefix_cache_sim.py](/labs/infra/prefix_cache_sim.py) implements both from scratch, in about 120 and 80 lines: `RadixCache`, with match, split, locks and leaf eviction, and `BlockCache`, with chained hashes, the free queue and vLLM's rule that freed blocks with a hash go to the back and blocks without one to the front. Both manage a pool of the same number of token slots and are driven by the same traces, with four requests in flight at a time.

```text
$ python prefix_cache_sim.py
all checks passed

Hit rate (cached prompt tokens / prompt tokens), 4 requests in flight, first come first served

multi-turn chat: 24 conversations of 8 turns, one 800-token system prompt
  192 requests, 307,374 prompt tokens, 42,183 distinct tokens to hold; a cache that never evicts reaches 95.7%
    pool, tokens   radix tree  hashed blocks  evicted, tree  evicted, blocks
           4,096        51.5%          51.5%        173,785          172,400
           8,192        55.5%          55.6%        158,500          155,792
          16,384        78.8%          79.4%         79,501           74,608
          32,768        95.0%          94.6%         11,610           11,344
          65,536        95.6%          95.2%              0                0

few-shot: 200 questions after the same 2,000 tokens of examples
  200 requests, 407,941 prompt tokens, 12,436 distinct tokens to hold; a cache that never evicts reaches 97.6%
    pool, tokens   radix tree  hashed blocks  evicted, tree  evicted, blocks
           4,096        97.6%          97.6%          8,393            6,960
           8,192        97.6%          97.6%          4,256            2,864
          16,384        97.6%          97.6%              0                0

12 tenants, each with its own system prompt of 1,000 to 2,000 tokens
  300 requests, 534,941 prompt tokens, 66,234 distinct tokens to hold; a cache that never evicts reaches 93.0%
    pool, tokens   radix tree  hashed blocks  evicted, tree  evicted, blocks
           4,096        25.1%          27.9%        425,798          408,528
           8,192        49.6%          52.8%        291,107          271,280
          16,384        76.7%          78.0%        137,396          128,480
          32,768        92.8%          92.4%         34,780           35,040
```

Three things can be read from these tables.

The two designs are within a few points of each other everywhere. With a pool large enough to hold everything, the tree is ahead by 0.4 points on the chat workload, 95.6% against 95.2%, which is the 16-token rounding. With a small pool the blocks are slightly ahead, 27.9% against 25.1% for the tenants at 4,096 tokens, because the tree evicts a whole leaf when it needs a few slots, and a leaf can be a system prompt of more than a thousand tokens, while the block cache gives up 16 tokens at a time and keeps the head of what it was evicting.

The size of the pool matters far more than the index. The chat workload has 42,183 distinct tokens to hold. A pool of 32,768 tokens reaches 95%, and a pool of 4,096 reaches 51.5%, with either design. The hit rate of a real server is decided by how much of the pool its running requests leave free, which is to say by load.

What the cache needs depends on the shape of the traffic. The few-shot workload has one hot prefix, and any pool that holds it reaches the maximum. The chat workload needs room for the conversations that are idle between turns as well as for the ones that are running: at 8,192 tokens the cache keeps little more than the 800-token system prompt, which is half of an average prompt of 1,600 tokens, and the hit rate is 55%. The tenant workload needs room for twelve system prompts at once, and below that it thrashes.

## Cache-aware scheduling

A cache only helps a request whose prefix is still in it when the request runs. With a queue of waiting requests, the order in which they are run changes how often that is true, and this is the second idea of the SGLang paper. Suppose 120 requests from six few-shot tasks are waiting, shuffled together, and the pool has room for the examples of one or two tasks. In arrival order, nearly every request belongs to a different task from the one before it, so its examples have just been evicted to make room for someone else's. If the scheduler instead runs all the requests of one task before starting the next, each task's examples are computed once.

The paper proves the general statement. For a batch of requests, visiting them in depth-first order of the radix tree they form achieves the best possible cache hit rate, provided the cache is at least as large as the longest request, and running the request with the longest cached prefix first produces that order. The simulator's last table is this experiment, with one request in flight.

```text
Scheduling order: 120 waiting requests from 6 few-shot tasks of 2,000 tokens each, shuffled,
one request in flight
    pool, tokens  first come first served  longest prefix first
           2,560                    21.2%                 93.2%
           4,608                    39.2%                 93.2%
           6,656                    49.8%                 93.2%
          12,800                    87.4%                 93.2%
```

With a pool that holds one task's examples, first-come-first-served finds 21% of prompt tokens in the cache and longest-prefix-first finds 93%, which is the most this queue allows, since each of six tasks must be computed once. The order stops mattering once the pool holds all six tasks.

In SGLang the order is set by `--schedule-policy`, and `SchedulePolicy.calc_priority` (`managers/schedule_policy.py`) sorts the waiting queue before each round of admissions.

| Policy | Order of the waiting queue |
|---|---|
| `fcfs` (the default) | Arrival order |
| `lpm` | Longest matched prefix first |
| `dfs-weight` | Depth-first through the tree, entering the subtree with the most waiting requests first |
| `lof`, `random`, `routing-key`, `hrrn`, `shortest-prefill-first` | Longest output first, random order, and three more specialized orders |

Request priorities are a separate switch, `--enable-priority-scheduling`, which sorts by priority before applying the policy. The default is first come, first served. Cache-aware order is something you turn on, and the code shows why it is not free. Longest-prefix-first has no notion of waiting time, so a request with an unusual prompt can be overtaken for as long as better-matching requests keep arriving. Matching and sorting the whole queue on every scheduling round also costs CPU time in the loop that feeds the GPU, so when more than 128 requests are waiting, `lpm` (and `hrrn`) falls back to arrival order (`_determine_active_policy`).

The `lpm` policy does one more thing, as do `hrrn` and `shortest-prefill-first` but not `dfs-weight` or any cache-agnostic order. Under the heading of in-batch prefix caching, `_compute_prefix_matches` builds a second, temporary radix tree out of the waiting queue itself. A request that matches little of the real cache (32 tokens or fewer) is looked up in this tree. If an earlier waiting request shares at least 32 tokens with it, the later one is moved to the back of the queue for this round. The effect is that when many requests with the same new prefix arrive together, one of them is run first, its prompt is published, and the others then find it. Without this, the requests admitted in the same batch each compute the shared prefix, since SGLang publishes a prompt only after its prefill.

## Simulation

The widget is a radix-tree cache over a pool of a few dozen token slots. Each button sends one request, which runs to completion before the next. Chats A, B and C start with the same 12-token system prompt, and each turn adds a 3-token message and a 5-token answer to that chat's history. A few-shot question is 16 tokens of examples and a 3-token question.

```widget
radix-tree
```

Try these, in order.

1. Send a turn of chat A and then a turn of chat B. The tree had one node of 20 tokens, and the second request matched only its first 12, so the node was split into the system prompt and chat A's turn.
2. Send two more turns of chat A. Each finds its whole history, including the previous answer, and adds one node. Compare "cached" with the prompt length: only the new message is computed.
3. Press "Same prompt again". The whole prompt is in the tree, and the match is still one token short of it.
4. Reset, choose a pool of 32, and send one turn each of chats A, B and C. The third request needs 8 slots and only 4 are free, and the leaf that was used longest ago, chat A's turn, is evicted. The system prompt survives because it is not a leaf, and because the request being served has locked it.
5. With a pool of 48, alternate few-shot questions with chat turns until something is evicted, and predict which node it will be from the "used" numbers before you press.
6. Watch the hit rate for 4-token hashed blocks beside the tree's. Find a request where the two differ, and say which block boundary caused it.

## Both engines on a chat workload

The lab script, [prefix_cache_bench.py](/labs/infra/gpu/prefix_cache_bench.py), sends the same two workloads to vLLM 0.32.0 and to SGLang 0.5.23, each serving Llama 3.1 8B on an H100 with default settings. The two engines pin different versions of PyTorch, so each has its own image and its own run.

The chat workload is 48 conversations of 6 turns through `/v1/chat/completions`. Every conversation starts with the same system prompt of about 2,000 tokens, every turn resends the whole history, and answers are limited to 150 tokens. Each simulated user waits between 1 and 4 seconds after an answer before sending the next message, so at any moment most conversations are idle and their KV is in the cache and not in use. Each engine reports the cached part of every prompt in the response's `usage.prompt_tokens_details.cached_tokens`, which vLLM fills in when started with `--enable-prompt-tokens-details` and SGLang with `--enable-cache-report`.

| Configuration | Engine | KV pool, tokens | Prompt tokens found in the cache | First token, median | First token, p99 |
|---|---|---|---|---|---|
| Prefix cache on (default) | SGLang | 410,558 | 98.3% | 25.1 ms | 34.8 ms |
| | vLLM | 451,056 | 97.9% | 34.9 ms | 77.0 ms |
| Prefix cache off | SGLang | 410,558 | 0 | 243.4 ms | 505.4 ms |
| | vLLM | 452,928 | 0 | 198.7 ms | 569.5 ms |
| Pool cut to 32,768 tokens | SGLang | 32,768 | 95.8% | 25.6 ms | 47.5 ms |
| | vLLM | 32,768 | 95.6% | 31.8 ms | 54.3 ms |
| Pool cut to 16,384 tokens | SGLang | 16,384 | 85.9% | 30.0 ms | 328.8 ms |
| | vLLM | 16,384 | 85.1% | 38.1 ms | 219.1 ms |

The 288 requests carried about 699,000 prompt tokens in every run. The flags that produce the rows are `--disable-radix-cache` and `--max-total-tokens` for SGLang, and `--no-enable-prefix-caching` and `--kv-cache-memory-bytes` for vLLM, where 32,768 tokens are 4 GiB at 131,072 bytes a token.

**The cache removes nearly all of the prefill.** With the cache on, each engine computes about 2% of the prompt tokens it receives. A median first-turn prompt is 2,063 tokens, of which SGLang finds 2,026 and computes 37, the user's question. The median time to first token falls from 243 ms to 25 ms on SGLang and from 199 ms to 35 ms on vLLM. The times without a cache are much longer than one 2,000-token prefill takes on an idle server, because the prefills of concurrent requests queue behind one another and share steps with decoding. The whole workload, which is mostly users thinking, also finishes sooner: 25.6 seconds against 32.1 on SGLang and 25.5 against 31.3 on vLLM.

**The two indexes find the same prefixes.** The hit rates differ by 0.4 points with a full-size pool, 0.2 with 32,768 tokens and 0.8 with 16,384. The first of these is the block rounding and nothing else. On a first turn vLLM finds 2,016 tokens where SGLang finds 2,026, and 2,016 is 126 blocks of 16. Over the run, SGLang found 2,497 more tokens than vLLM in 288 requests, which is 8.7 tokens per request, about what rounding down to a multiple of 16 costs on average. This is the simulator's result on real engines.

**Under memory pressure both degrade the same way.** By the last turn the conversations hold about 43,000 distinct tokens: the system prompt once, and roughly 860 tokens of history for each of the 48 conversations. A pool of 32,768 tokens cannot keep all of that, and a pool of 16,384 keeps less than half. The per-turn numbers show what is given up.

| Turn | Median prompt, tokens | Cached with a full pool (SGLang, vLLM) | Cached with 16,384 tokens (SGLang, vLLM) |
|---|---|---|---|
| 1 | 2,063 | 2,026, 2,016 | 2,026, 2,016 |
| 2 | about 2,210 | 2,169, 2,160 | 2,166, 2,160 |
| 3 | about 2,355 | 2,315, 2,304 | 2,026, 2,016 |
| 4 | about 2,500 | 2,450, 2,448 | 2,026, 2,016 |
| 5 | about 2,645 | 2,603, 2,592 | 2,026, 2,016 |
| 6 | about 2,785 | 2,744, 2,720 | 2,026, 2,016 |

With the small pool, from the third turn on, the median request finds exactly the system prompt and nothing of its own conversation. While a user was thinking, other conversations needed slots, and the idle conversation's history was the least recently used leaf in SGLang and the front of the free queue in vLLM. The system prompt survives in both, because some running request is nearly always holding it. That is the behaviour to expect from a loaded server. Shared prefixes stay cached under almost any pressure, and per-conversation history is cached only while the pool has room to spare. It is also why the hit rate stays at 85% and does not collapse: the system prompt is most of every prompt. In neither engine did the small pool cause requests to be thrown out. SGLang retracted none and vLLM preempted one.

**Differences in latency between the engines are not explained by the cache.** With the cache on, SGLang's median first token arrived in 25 ms and vLLM's in 35 ms, and without it vLLM was ahead, 199 ms against 243 ms. Both engines computed the same number of tokens in each case, so these gaps come from elsewhere: how each schedules a prefill among running decodes, the cost of each engine's request path on the CPU, and the fact that the two runs were on different hosts. Chapter 5.2 measured 60 ms and 86 ms for the same request on two H100 hosts. A fair comparison of the engines' speed needs repeated runs on one machine at a controlled arrival rate, which is the subject of the load-testing chapter in Part 8. What this experiment establishes is the part that does not depend on the host: which tokens each engine found in its cache.

The second workload is the burst of chapter 5.2 with one change: all 64 requests, which share a 3,000-token prefix, are sent at the same moment to a server that has never seen the prefix. Any hit must come from another request in the same burst.

| | Burst finished in | Requests with no hit | Prompt tokens found in the cache |
|---|---|---|---|
| vLLM, cache on | 0.55 s | 1 | 188,496 of 195,200 |
| SGLang, cache on, `fcfs` | 0.54 s | 1 | 189,000 of 195,200 |
| SGLang, cache on, `lpm` | 0.40 s | 1 | 189,000 of 195,200 |
| vLLM, cache off | 5.17 s | 64 | 0 |
| SGLang, cache off | 5.09 s | 64 | 0 |

A cold cache costs one request. In every run with a cache, exactly one request computed the prefix and the other 63 reused it, 2,992 tokens each in vLLM (187 blocks) and 3,000 each in SGLang. SGLang's log shows how: its first prefill batch held one request and computed 3,050 tokens, and its second held the other 63, computed 3,150 tokens between them and took 189,000 from the cache.

This run does not show the in-batch problem that `lpm` exists to solve, and the reason is worth understanding. "At the same moment" for an HTTP client still means one request reaches the scheduler first. On an idle server it is admitted alone, and by the time its prefill has run, the rest are waiting and find its prompt in the tree. The default order therefore did as well as `lpm`. The two runs computed exactly the same tokens, so the difference between 0.54 and 0.40 seconds is not the cache's doing; each figure is a single run on a freshly started server, and the gap is too small to read anything into. In a trial on an A10 with Llama 3.2 1B, two requests were admitted before the prefix was published and both computed it, under `fcfs`, where `lpm` again had one. The case where the order matters is a busy server, where requests with the same new prefix accumulate in the waiting queue during a long step and are then admitted together.

## Lab: two caches and two engines

**Tier: [Mac] for Part A, [1 GPU] for Part B.**

**Part A, the simulator.** [prefix_cache_sim.py](/labs/infra/prefix_cache_sim.py) needs only Python's standard library.

```bash
python prefix_cache_sim.py           # about 17 seconds on an M2
python prefix_cache_sim.py --test    # only the self-checks
```

Read `RadixCache` and `BlockCache`, then do three things. First, before running, predict for each workload which design has the higher hit rate at the smallest pool and why, then check. Second, change `BlockCache.finish` to free a request's blocks from head to tail instead of tail to head, and measure what vLLM's reversed order is worth. Third, add an `order="dfs"` option to `replay` that visits the waiting queue in depth-first order of the tree its prompts form, and compare it with `lpm` on the scheduling experiment.

**Part B, the engines.** The script is [prefix_cache_bench.py](/labs/infra/gpu/prefix_cache_bench.py). It tests one engine per run, each in its own image.

```bash
cd gpu
modal run modal_run.py --script prefix_cache_bench.py --gpu 'H100!' --vllm   --args "--engine vllm"     # 10 to 20 min, $0.65 to $1.30
modal run modal_run.py --script prefix_cache_bench.py --gpu 'H100!' --sglang --args "--engine sglang"   # about 9.5 min, $0.61
modal run modal_run.py --script prefix_cache_bench.py --gpu A10 --vllm   --args "--engine vllm --quick"     # Llama 3.2 1B: 5.5 min, $0.10
modal run modal_run.py --script prefix_cache_bench.py --gpu A10 --sglang --args "--engine sglang --quick"   # 6.5 min, $0.12
modal run modal_run.py --script prefix_cache_bench.py --gpu A10 --sglang --args "--engine sglang --quick --unique-system --only 'cache on'"   # 2.5 min, $0.05
python gcp_run.py --script prefix_cache_bench.py --gpu A100-80GB --sglang --args "--engine sglang"
```

The first time `--sglang` is used, the launcher builds the SGLang image, which takes several minutes and is not billed as GPU time. The vLLM run's time depends mostly on how fast its host downloads the model: the reference run waited 14 minutes for the first server to start.

From your own runs, fill in the tables of the previous section. Then explain three things from the source of each engine: why the two hit rates differ by a fraction of a percent, which tokens each engine gave up when the pool was cut to 16,384 tokens, and how one request's prefill served 63 others in the burst. Last, change one thing about the workload that you expect to lower the hit rate, such as putting the customer's number at the start of the system prompt (the script's `--unique-system` option does this), predict the new hit rate, and measure it with `--quick`.

<details>
<summary>Reference solution</summary>

*Part A.* The output of the unmodified script is in the sections "Measuring the two designs without a GPU" and "Cache-aware scheduling". At the smallest pool the block cache is level or ahead, because it evicts 16 tokens at a time and the tree evicts whole leaves.

Freeing blocks head first means replacing `reversed(blocks)` with `blocks` in `BlockCache.finish`. The first block of a prompt then reaches the front of the free queue before the rest, and once it is taken, every later block of that prompt is unreachable, since a lookup stops at the first missing hash, yet those blocks still occupy the pool until they are taken too.

| Workload | Pool, tokens | Tail first (vLLM) | Head first |
|---|---|---|---|
| Chat | 8,192 | 55.6% | 55.4% |
| Chat | 16,384 | 79.4% | 77.9% |
| Chat | 32,768 | 94.6% | 94.6% |
| Tenants | 8,192 | 52.8% | 48.6% |
| Tenants | 16,384 | 78.0% | 76.3% |
| Tenants | 32,768 | 92.4% | 92.3% |

The order is worth up to 4 points when the pool is tight and nothing when it is not. It matters most for the tenants, whose prompts are a long shared head and a short private tail: tail first gives up the private part and keeps the system prompt.

For the depth-first order, build a `RadixCache` with a very large pool, insert every waiting prompt, then walk it depth first and emit each request when the walk reaches the node where its prompt ends. On the scheduling experiment it gives the same 93.2% as `lpm` at every pool size, which is the paper's theorem: with a cache at least as large as one request, longest-prefix-first produces a depth-first order.

*Part B.* The reference results are [prefix_cache_vllm.json](/labs/infra/gpu/prefix_cache_vllm.json) and [prefix_cache_sglang.json](/labs/infra/gpu/prefix_cache_sglang.json), and the section above explains them. The hit rates differ because vLLM's hit is a whole number of 16-token blocks. With the small pool both engines gave up the histories of idle conversations and kept the system prompt. In the burst, the first request to arrive was scheduled alone, and its prompt was shareable by the time the others were admitted: in vLLM because blocks enter the hash table when they are allocated, and in SGLang because the prompt is inserted into the tree when the prefill's result is processed.

Putting anything that differs between conversations at the start of the system prompt makes every conversation's first turn a miss on the whole system prompt, while later turns still hit their own history. The script has this change as `--unique-system`, and the reference run used it with `--quick` on an A10 (Llama 3.2 1B, 16 conversations of 4 turns, SGLang, [prefix_cache_sglang_quick_unique_system.json](/labs/infra/gpu/prefix_cache_sglang_quick_unique_system.json)).

| | Hit rate, all turns | Turn 1, median cached of prompt | Turn 1, median first token | Turn 2, median cached of prompt |
|---|---|---|---|---|
| Shared system prompt | 98.2% | 2,026 of 2,063 | 26.0 ms | 2,162 of 2,206 |
| Customer number first | 76.2% | 27 of 2,067 | 103.9 ms | 2,175 of 2,216 |

The 27 tokens that still match are the chat template's header, which comes before the system prompt's text. With 4 turns, one turn in four pays for the whole prompt, so the hit rate falls by about a quarter. With a small pool it would fall much further, because there is no longer a shared prefix that survives eviction.

</details>

## Interview angle

"How does prefix caching work, and how would you implement it?" is asked for inference roles both as a design question and as a coding question, since a radix tree with reference counts and eviction is a reasonable hour of work. A complete answer starts from why it is exact (a token's KV depends only on the tokens before it), states the constraint that follows (only prefixes, matched from position 0), and then describes the index, the protection of prefixes in use, and eviction. Be ready to describe both indexes and say what each costs: a radix tree gives token-level hits and a natural leaf-first eviction order, and hashed blocks give a flat table with constant-time lookups per block and hits rounded to the block size.

Expect to be asked what decides the hit rate in production. The useful answer is that the index is the least of it. The measurements here put the two designs within a point of each other, while cutting the pool to 16,384 tokens cost each of them 12 to 13 points. What matters is how much of the KV pool running requests leave free, whether prompts are laid out with the stable part first, and, across several replicas, whether a conversation's next turn reaches the replica that holds its history, which is a routing problem that Part 6 of this handbook takes up.

A common follow-up is scheduling: why would an engine not run requests in arrival order? Give the few-shot example, state the paper's result that longest-prefix-first is a depth-first walk and is optimal for a batch when the cache holds a request, and then give the costs that keep SGLang's default at first come, first served: starvation of requests with unusual prompts, and the CPU time of matching the whole queue.

A good closing question to expect is about safety. A shared prefix cache leaks timing: a request that hits is faster, so one tenant can learn whether another tenant recently sent a given prefix. Both engines let a request name a separate cache namespace for this reason, `cache_salt` in vLLM and in SGLang.

## Check yourself

<details>
<summary>Why can a server reuse the KV of a shared prefix but not of a shared document that appears in the middle of two different prompts?</summary>

Under causal attention the keys and values of a token depend on that token and every token before it. Two prompts with the same first n tokens therefore have identical KV for those tokens. A document in the middle of a prompt is preceded by different tokens in the two prompts, so every one of its tokens attends to a different past and has different KV, even though the document's text is the same.

</details>

<details>
<summary>What happens in SGLang's radix tree when a new prompt agrees with the first 12 tokens of a node that holds 20?</summary>

The node is split. A new node takes the first 12 tokens and their 12 slot indices and becomes the parent of the old node, which keeps the other 8. No keys or values move, since nodes hold slot indices. The new request's match ends at the new node, which it locks, and its remaining tokens are later inserted as a second child of that node.

</details>

<details>
<summary>How does SGLang decide what to evict, and why does it start from the leaves?</summary>

Eviction happens only when an allocation finds too few free slots, and it stops once the shortfall is covered. The candidates are leaves whose `lock_ref` is 0, taken in order of the eviction policy, by default least recently accessed first. When a leaf is removed and its parent becomes an unlocked leaf, the parent becomes a candidate. A leaf is the end of one stored sequence, so removing it loses only that suffix, while removing an inner node would make everything beneath it unreachable.

</details>

<details>
<summary>On the chat workload, vLLM found 97.9% of prompt tokens in its cache and SGLang 98.3%. Where does the difference come from?</summary>

vLLM's cache works in blocks of 16 tokens, so a hit is rounded down to a multiple of 16, while SGLang's default page size is 1 and a hit can end at any token. On a first turn vLLM found 2,016 tokens, which is 126 blocks, where SGLang found 2,026. Over the run the difference was 8.7 tokens per request.

</details>

<details>
<summary>With the KV pool cut to 16,384 tokens, the median request from turn 3 on found only the system prompt in both engines. Why that, and why not less?</summary>

The conversations needed about 43,000 tokens of KV in all, so most of it had to be evicted. Each conversation's own history is used by one request every few seconds and is idle in between, which makes it the least recently used data when other requests need slots. The system prompt is the prefix of every request, so it is in use by some running request almost all the time, and a prefix in use is locked in SGLang and reference-counted in vLLM.

</details>

<details>
<summary>What does `--schedule-policy lpm` change in SGLang, and why is it not the default?</summary>

It sorts the waiting queue so that the request with the longest cached prefix is admitted first, and it holds back a request that shares a new prefix with an earlier waiting request, so that the prefix is computed once and then reused. This raises the hit rate when the cache cannot hold every waiting request's prefix. It is not the default because it can starve requests whose prompts match nothing, and because matching every waiting request against the tree on each scheduling round costs CPU time. When more than 128 requests are waiting, it falls back to arrival order.

</details>

## Further reading

- Zheng et al., [SGLang: Efficient Execution of Structured Language Model Programs](https://arxiv.org/abs/2312.07104) (2023). Section 3 describes RadixAttention, leaf-first LRU eviction and cache-aware scheduling, and states the theorem on depth-first order.
- [SGLang source at v0.5.23](https://github.com/sgl-project/sglang/tree/v0.5.23): [radix_cache.py](https://github.com/sgl-project/sglang/blob/v0.5.23/python/sglang/srt/mem_cache/radix_cache.py) for the tree in Python, [schedule_policy.py](https://github.com/sgl-project/sglang/blob/v0.5.23/python/sglang/srt/managers/schedule_policy.py) for the scheduling orders and in-batch prefix caching, and [evict_policy.py](https://github.com/sgl-project/sglang/blob/v0.5.23/python/sglang/srt/mem_cache/evict_policy.py) for the eviction policies.
- [Fast and Expressive LLM Inference with RadixAttention and SGLang](https://www.lmsys.org/blog/2024-01-17-sglang/), the project's first announcement, with diagrams of the tree under several workloads.
- SGLang documentation: [server arguments](https://docs.sglang.io/docs/advanced_features/server_arguments) and [hyperparameter tuning](https://docs.sglang.io/docs/advanced_features/hyperparameter_tuning).
- vLLM documentation: [automatic prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching/), the design of the hashed blocks this chapter compares against.
- Zhang, Li, Moallemi and Peng, [Tail-Optimized Caching for LLM Inference](https://arxiv.org/abs/2510.15152) (2025), the source of SGLang's `tlru` eviction policy, which evicts the part of a conversation's history that cannot affect tail latency first.
