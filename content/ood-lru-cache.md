# Design an LRU cache

A **cache** keeps copies of recent answers in fast memory so that repeated requests don't have to redo slow work. A search engine is a good example. Computing the results for "weather paris" means querying an index spread over many machines, but thousands of people type that same query every hour. If the search service keeps the last few thousand queries and their results in memory, most of those people get an answer straight from memory.

Memory is limited, so the cache has a fixed **capacity**. When it's full and a new query arrives, something has to go. An **LRU (least recently used) cache** throws out the entry that has gone longest without being read or written. The bet is that a query nobody has asked for in an hour is less likely to be asked next than one asked a minute ago. Python's `functools.lru_cache` decorator works this way, and Redis offers an `allkeys-lru` eviction policy, which its documentation calls "a good default option if you have no reason to prefer any others."

This chapter is an **object-oriented design** question. In this kind of interview question you're asked to model something in code: you clarify the scope with the interviewer, name the classes and say what each one is responsible for, write working code, and then discuss how the design would change under new requirements. For an LRU cache, the interviewer is mostly checking one thing: can you make every operation run in constant time?

## Constraints and assumptions

Ask these questions first. Each answer rules out work you'd otherwise have to do.

- **What are we caching?** The results of web queries. The key is the query string and the value is its results. *Why it matters:* it tells you what the keys look like (strings, which Python can hash) and suggests the access pattern: a few popular queries asked over and over, which is exactly where LRU does well.
- **Can we assume inputs are valid, or do we have to validate them?** Assume they're valid. *Why it matters:* no checks for empty or malformed queries, so the code can focus on the data structure.
- **Can we assume this fits in memory?** Yes. *Why it matters:* the whole cache lives in one process. Splitting it across machines is an extension.

A few more answers we assume, because the code depends on them. State them out loud in an interview:

- **How is capacity measured?** In entries: the cache holds at most `capacity` queries, whatever the size of their results. Measuring in bytes is a follow-up.
- **What does `get` return on a miss?** `None`. The caller then computes the results and calls `set`.
- **Does a `get` count as a use?** Yes. A hit moves the entry to the most recently used position. That's what makes it LRU, as opposed to evicting the oldest insertion, which is called first in, first out (FIFO).
- **What does `set` do for a query that's already cached?** It replaces the results and marks the entry as most recently used. It never evicts anything, since the number of entries doesn't change.
- **What if `set` adds a new query when the cache is full?** It first removes the least recently used entry, then adds the new one.
- **Do we need thread safety or expiry times?** Not for now. Both come up as follow-ups.

## Class design

The cache needs two things at once: find any query's entry in O(1), and know which entry is least recently used in O(1). No single built-in structure does both, so we combine a hash map (a Python `dict`) with a doubly linked list. A **doubly linked list** is a chain of nodes where each node points to both the node before it and the node after it.

```diagram
title: LRUCache finds nodes through its dict and orders them with its RecencyList
[cache] LRUCache\nget, set @ 0,0
[dict:store] dict\nquery → Node @ 2,0
[list] RecencyList\nmost → least\nrecent @ 0,1.5
[node] Node\nquery, results,\nprev, next @ 2,1.5
cache -> dict : looks up
cache -> list : reorders, evicts
list -> node : links
dict -> node : points to
```

- **`Node`** holds one cache entry: the query, its results, and links to its neighbors in recency order.
- **`RecencyList`** keeps nodes ordered from most to least recently used. It can add a node at the front, move a node to the front, and remove the last node, each in O(1). It knows nothing about queries or capacity.
- **`LRUCache`** is the public interface. It enforces the capacity, decides when an entry counts as used, and keeps the dict and the list in step.

Keeping the list separate from the cache gives each class one job. You could test `RecencyList` on its own, or reuse it for a different eviction policy.

## Solution

```python
from typing import Any, Optional


class Node:
    """One cached query and its results, linked into the recency list."""

    __slots__ = ("query", "results", "prev", "next")

    def __init__(self, query: Any = None, results: Any = None) -> None:
        self.query = query        # kept so eviction knows which key to delete
        self.results = results
        self.prev: Optional["Node"] = None
        self.next: Optional["Node"] = None


class RecencyList:
    """A doubly linked list ordered from most to least recently used."""

    def __init__(self) -> None:
        self._head = Node()       # sentinel before the most recent node
        self._tail = Node()       # sentinel after the least recent node
        self._head.next = self._tail
        self._tail.prev = self._head

    def add_to_front(self, node: Node) -> None:
        node.prev = self._head
        node.next = self._head.next
        self._head.next.prev = node
        self._head.next = node

    def unlink(self, node: Node) -> None:
        node.prev.next = node.next
        node.next.prev = node.prev
        node.prev = node.next = None

    def move_to_front(self, node: Node) -> None:
        self.unlink(node)
        self.add_to_front(node)

    def remove_last(self) -> Node:
        node = self._tail.prev
        if node is self._head:
            raise IndexError("remove_last from an empty list")
        self.unlink(node)
        return node


class LRUCache:
    """Caches query results and evicts the least recently used query."""

    def __init__(self, capacity: int) -> None:
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self.capacity = capacity
        self._nodes: dict[Any, Node] = {}   # query -> its node in the list
        self._recency = RecencyList()

    def get(self, query: Any) -> Any:
        """Return the cached results, or None on a miss. A hit counts as a use."""
        node = self._nodes.get(query)
        if node is None:
            return None
        self._recency.move_to_front(node)
        return node.results

    def set(self, query: Any, results: Any) -> None:
        """Store results for the query, evicting the oldest entry if full."""
        node = self._nodes.get(query)
        if node is not None:
            node.results = results
            self._recency.move_to_front(node)
            return
        if len(self._nodes) == self.capacity:
            oldest = self._recency.remove_last()
            del self._nodes[oldest.query]
        node = Node(query, results)
        self._recency.add_to_front(node)
        self._nodes[query] = node

    def __len__(self) -> int:
        return len(self._nodes)
```

The key parts:

- **The dict maps a query to its node**, not to its results. A `get` finds the node in O(1), and because the node is also a link in the list, the cache can move it to the front without searching the list.
- **Each node stores its own query.** When `set` evicts the last node, it needs to delete that node's entry from the dict too, and the node is the only place that knows which query it belongs to. Forgetting this field is the most common bug in this exercise.
- **Sentinel nodes.** `_head` and `_tail` are empty placeholder nodes that never hold data and never move. Every real node always has a node on each side, so `add_to_front` and `unlink` are four and two pointer assignments with no `if` statements. Without sentinels, you'd need special cases for an empty list, a one-node list, and removing the first or last node, and those special cases are where linked-list bugs live.
- **`get` reorders the list.** A hit calls `move_to_front`, so reading an entry protects it from eviction. A miss returns `None` and changes nothing.
- **`set` handles two cases.** For a query that's already cached, it replaces the results and moves the node to the front. For a new query, it evicts first if the cache is full, then adds the node at the front and records it in the dict. Evicting before inserting keeps the cache from ever holding `capacity + 1` entries.
- **`len(self._nodes)` is the size.** The dict already knows how many entries there are, so a separate counter would be one more thing to keep in step.
- **`unlink` clears the removed node's pointers.** Correctness doesn't depend on it. It means a stale node can't accidentally walk back into the list, and it drops references to neighbors that may themselves have been evicted.
- **`capacity < 1` is rejected.** A cache with no room would try to evict from an empty list on its first `set`. `RecencyList.remove_last` also raises `IndexError` on an empty list, so a misuse fails loudly instead of corrupting the links.

## Walking through an example

Take `LRUCache(capacity=3)`. The list column shows the entries from most to least recently used.

| Step | Call | What happens | List afterwards |
| --- | --- | --- | --- |
| 1 | `set("weather", W1)` | New query, cache has room. Add at front. | weather |
| 2 | `set("python", P1)` | New query, add at front. | python, weather |
| 3 | `set("maps", M1)` | New query, add at front. The cache is now full. | maps, python, weather |
| 4 | `get("weather")` | Hit. Return W1 and move "weather" to the front. | weather, maps, python |
| 5 | `set("news", N1)` | New query and the cache is full. Evict the last node, "python", and delete it from the dict. Add "news" at front. | news, weather, maps |
| 6 | `get("python")` | Miss. Return `None`. Nothing moves. | news, weather, maps |
| 7 | `set("maps", M2)` | Existing query. Replace M1 with M2 and move to front. No eviction. | maps, news, weather |
| 8 | `set("sports", S1)` | New query, cache full. Evict "weather". | sports, maps, news |

Step 4 is the one that separates LRU from a FIFO queue. "weather" was the oldest insertion, but reading it at step 4 made it recent, so at step 5 the cache evicted "python" instead.

Here's the structure after step 8. The dict points into the middle of the list, which is what makes every operation O(1).

```diagram
title: After step 8. The dict finds any node directly; the list order decides who is evicted next.
[h:note] head\nsentinel @ 0,0
[s] sports @ 1,0
[m] maps @ 2,0
[n] news @ 3,0
[t:note] tail\nsentinel @ 4,0
[d:store] dict: sports,\nmaps, news @ 2,1.5
h <-> s
s <-> m
m <-> n
n <-> t
d -> m : one pointer per key
```

## Complexity and trade-offs

| Operation | Time | Why |
| --- | --- | --- |
| `get` hit | O(1) | One dict lookup, then a fixed number of pointer updates to move the node. |
| `get` miss | O(1) | One dict lookup. |
| `set` update | O(1) | Dict lookup, replace results, move to front. |
| `set` insert with eviction | O(1) | Unlink the tail's neighbor, one dict delete, one link at front, one dict insert. |

Space is O(capacity). Each entry costs one dict slot plus one node with two pointers, on top of the query and results themselves.

### Why a hash map plus a doubly linked list

It helps to show the interviewer the alternatives you rejected:

- **A dict plus a "last used" timestamp in each entry.** `get` and `set` are O(1), but eviction has to scan every entry to find the oldest timestamp: O(n).
- **A dict plus a min-heap ordered by timestamp.** Eviction becomes O(log n), but every `get` changes a timestamp, and updating an element's position inside a heap is O(log n) too.
- **A dict plus a singly linked list.** Moving a node to the front requires unlinking it, and unlinking needs the node before it. With only forward pointers, finding that node means walking from the start of the list: O(n). The back pointer is what makes removal from the middle O(1).

With a doubly linked list, each node knows both neighbors, and the dict gives you the node directly. Every operation is a lookup plus a constant number of pointer changes.

### Python's shortcut: `OrderedDict`

Python's `collections.OrderedDict` already combines a hash map with an ordering it can change cheaply. Its documentation says it "can handle frequent reordering operations better than `dict`" and that "this makes it suitable for implementing various kinds of LRU caches." `move_to_end(key)` marks a key as most recent, and `popitem(last=False)` removes the oldest. The same behavior in a dozen lines:

```python
from collections import OrderedDict
from typing import Any


class OrderedDictLRUCache:
    """The same behavior as LRUCache, built on OrderedDict."""

    def __init__(self, capacity: int) -> None:
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self.capacity = capacity
        self._entries: OrderedDict[Any, Any] = OrderedDict()  # oldest first

    def get(self, query: Any) -> Any:
        if query not in self._entries:
            return None
        self._entries.move_to_end(query)
        return self._entries[query]

    def set(self, query: Any, results: Any) -> None:
        if query in self._entries:
            self._entries.move_to_end(query)
        elif len(self._entries) == self.capacity:
            self._entries.popitem(last=False)
        self._entries[query] = results
```

In production Python, use this or `functools.lru_cache`. In an interview, mention it, and then expect to be asked to write the linked list yourself, because that's the part being tested.

`functools.lru_cache` is the decorator form, for caching a function's return values by its arguments. Its documentation says the default `maxsize` is 128, and setting `maxsize=None` disables the LRU feature so the cache grows without bound (`functools.cache`, added in Python 3.9, is that unbounded version). Since a dictionary holds the results, the arguments must be hashable. The wrapped function gains `cache_info()`, which reports hits, misses, maxsize and current size, and `cache_clear()`. The documentation also gives the reasoning for LRU in one line: it "works best when the most recent calls are the best predictors of upcoming calls."

### Thread safety

Our cache isn't safe to share between threads. Even `get` writes, since it moves a node. If two threads move nodes at the same moment, their pointer updates can interleave and leave the list corrupted, with nodes pointing to neighbors that no longer point back. The fix is in the extensions below. For comparison, `functools.lru_cache` is documented as threadsafe in the sense that its data structure "will remain coherent during concurrent updates", though the wrapped function may run more than once if a second thread calls it before the first call's result is cached.

### Exact LRU vs approximate LRU

Exact LRU costs two pointers per entry and a list update on every read. Large caches often trade a little accuracy for less memory. Redis is the standard example. Its eviction documentation explains that it "samples a small number of keys at random and then evicts the ones with the longest time since last access". The sample size is set by `maxmemory-samples`, which defaults to 5. Since Redis 3.0 it also keeps a pool of good eviction candidates between evictions. The docs say Redis avoids true LRU "because it costs more memory", and that the approximation "is virtually equivalent for an application using Redis." [Caching](/learn/cache#when-the-cache-is-full) compares LRU with the other eviction policies.

## Extensions and follow-up questions

**"Entries should expire after a while."** Add a **time to live (TTL)**: store an expiry time in each node when it's set. In `get`, if the node's time has passed, unlink it, delete it from the dict, and report a miss. Pass the clock into the constructor so tests can control time. Expired entries that nobody reads stay in memory until LRU evicts them; if that matters, add a background sweep. [Design a query cache](/learn/design-query-cache#when-to-update-the-cache) builds this into a cache for search results and discusses how to choose TTLs.

**"Make it safe for several threads."** Put one lock around both methods:

```python
import threading
from typing import Any

from lru_cache import LRUCache   # the LRUCache class from the solution


class ThreadSafeLRUCache:
    """Wraps LRUCache so only one thread changes it at a time."""

    def __init__(self, capacity: int) -> None:
        self._cache = LRUCache(capacity)
        self._lock = threading.Lock()

    def get(self, query: Any) -> Any:
        with self._lock:      # a get moves a node, so it needs the lock too
            return self._cache.get(query)

    def set(self, query: Any, results: Any) -> None:
        with self._lock:
            self._cache.set(query, results)
```

A read-write lock doesn't help here, since every `get` writes to the list. If one lock becomes a bottleneck, split the cache into several independent shards by hashing the key, each with its own lock and its own LRU list. Eviction is then LRU within each shard, which is close enough in practice. Another option is to record reads in a buffer and apply the reordering in batches.

**"What about LFU?"** **Least frequently used (LFU)** evicts the entry read the fewest times. It keeps long-term favorites that LRU might drop after a short quiet spell. An O(1) LFU keeps a dict from key to node and a second dict from each access count to a doubly linked list of nodes with that count, plus the current minimum count. A hit moves the node from the count-k list to the count-(k + 1) list. Eviction removes the least recent node from the minimum-count list. LFU's weakness is the reverse of LRU's: an entry that was popular last week keeps a high count and lingers. Redis's LFU mode, available since Redis 4.0, handles this with a small probabilistic counter per key that decays over time, by default once a minute.

**"One crawler-style burst of one-off queries flushes the whole cache."** That's a known weakness of LRU: a scan of many keys, each used once, pushes out the popular ones. One fix is to admit an entry only on its second request. Python's `collections` documentation includes a recipe that does this, a cache that, in its words, avoids "flushing the LRU cache with one-time requests" by not caching "until a request has been made more than once."

**"Limit the cache by memory instead of entry count."** Store each entry's size in its node and keep a running total. On `set`, evict from the tail in a loop until the new entry fits. Decide what happens to a single entry larger than the whole budget (usually: don't cache it).

**"The cache must serve many servers."** Run the cache as its own service on several machines and decide which machine owns each key with [consistent hashing](/learn/consistent-hashing), so adding a cache node moves only a small share of keys. Each node runs its own LRU over the keys it owns. You also have to decide how the cache stays fresh when the underlying data changes, and how to protect the database when many entries miss at once. [Design a query cache](/learn/design-query-cache) works through this whole system, with an LRU cache at its core.

## Check yourself

<details>
<summary>Your LRU cache works until the first eviction, then a later <code>get</code> returns results for a query that was supposedly evicted. What's the likely bug?</summary>

Eviction removed the node from the linked list but didn't delete its key from the dict, so the dict still points at the evicted node. Usually the node doesn't store its own key, so the code can't tell which dict entry to delete. Store the key in each node and delete `nodes[oldest.key]` whenever the tail is evicted.

</details>

<details>
<summary>Why must the list be doubly linked? Wouldn't a singly linked list with a dict work?</summary>

Moving a node to the front means unlinking it from wherever it is, and unlinking means pointing its predecessor at its successor. In a singly linked list, a node doesn't know its predecessor, so you'd walk from the head to find it, which is O(n). The back pointer makes the predecessor available in O(1).

</details>

<details>
<summary>With capacity 2, run <code>set(a)</code>, <code>set(b)</code>, <code>get(a)</code>, <code>set(c)</code>, <code>set(b)</code>. Which keys are cached at the end, in order from most to least recent?</summary>

After `set(a)`, `set(b)`: b, a. The `get(a)` makes it: a, b. `set(c)` evicts b: c, a. `set(b)` is a new key again, so it evicts a: b, c. A FIFO cache would have evicted a at the `set(c)` step instead.

</details>

<details>
<summary>What do sentinel nodes buy you, and what do they cost?</summary>

They make every real node have a neighbor on each side, so inserting and unlinking need no checks for an empty list or for the first and last node. That removes the special cases where linked-list bugs usually hide. The cost is two extra nodes per cache, which is nothing.

</details>

<details>
<summary>A teammate wraps <code>set</code> in a lock but leaves <code>get</code> unlocked, reasoning that reads are safe. What can go wrong?</summary>

In an LRU cache, `get` is a write: a hit moves the node to the front, which changes several pointers. A `get` running at the same time as a `set` or another `get` can interleave those updates and leave nodes whose `prev` and `next` don't agree, which loses entries or creates loops. Every method that touches the list needs the lock.

</details>

<details>
<summary>Redis doesn't keep an exact LRU list. Why, and when would you choose LFU over LRU?</summary>

An exact list costs two pointers per key and list work on every read, which adds up across millions of keys. Redis samples a few keys (5 by default) and evicts the least recently used among them, which its documentation describes as virtually equivalent for applications. Choose LFU when some keys stay popular over long periods but have quiet spells, since LRU would evict them during the lull; LFU keeps them because their count stays high.

</details>

## Further reading

- [`functools.lru_cache`](https://docs.python.org/3/library/functools.html#functools.lru_cache) (Python documentation): the standard-library LRU decorator, including `maxsize`, `typed`, `cache_info()` and its thread-safety guarantee.
- [`collections.OrderedDict`](https://docs.python.org/3/library/collections.html#collections.OrderedDict) (Python documentation): `move_to_end` and `popitem(last=False)`, plus recipes for a time-bounded LRU cache and one that only caches repeated requests.
- [Key eviction](https://redis.io/docs/latest/develop/reference/eviction/) (Redis documentation): every eviction policy, how Redis approximates LRU by sampling, and how its LFU counters decay.
- [Caching](/learn/cache): where caches sit in a system, how they're kept up to date, and how eviction policies compare.
- [Design a query cache](/learn/design-query-cache): an LRU cache with TTLs as the core of a search results cache, scaled across many machines.
- [Design a hash map](/learn/ood-hash-table): how the dict inside this cache works.
