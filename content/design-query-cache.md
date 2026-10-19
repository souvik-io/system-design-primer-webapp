# Design a key-value cache for a search engine's query results

When you type `cheap flights to paris` into a search engine, a lot of work happens before the results page comes back. The engine looks up every word in its index, finds the pages that contain all of them, ranks those pages, and then fetches a title and a short snippet of text for each of the top ten. Thousands of other people typed the same words today. If the engine keeps the finished results page for a popular query in memory, it can answer the next person who asks with one lookup and skip all of that work.

That stored copy is a **query cache**. It is a key-value store: the key is the search query, and the value is the list of results. This chapter designs one that sits in front of a search engine and serves popular queries from memory.

The problem looks small, and it still makes you decide real things. Two queries that look different, such as `Paris Flights` and `paris flights`, should probably share one entry, so you need rules for turning a query into a key. Memory is limited, so you need a policy for what to throw away and a data structure that does it in constant time. Web pages change, so cached results go stale, and you need to decide how stale is acceptable. And a cache big enough for a real search engine doesn't fit on one machine, so you need to decide how to spread it across many.

The chapter follows the four steps from [The system design interview, step by step](/learn/system-design-interview). It covers the cache in depth. For the search engine behind it, see [Design a web search engine](/learn/design-search-engine).

## Step 1: Outline use cases, constraints and assumptions

Start by agreeing on what the cache has to do and how big it is.

### Use cases

In scope:

- **A user sends a search request that results in a cache hit.** The results for this query are already in the cache, so the service returns them without asking the search backend.
- **A user sends a search request that results in a cache miss.** The results aren't in the cache. The service asks the search backend, returns the results, and stores them in the cache for the next request.
- **The service is highly available.** If a cache machine fails, users should still get results, perhaps a little more slowly.

### Out of scope

- Building or updating the search index itself. The cache sits in front of an existing **reverse index service** (a service that maps each word to the documents containing it, also called an inverted index) and an existing **document service** (a service that returns a page's title and text).
- Ranking. The reverse index service decides the order of results.
- Personalized results. Every user who sends the same query, in the same language and region, gets the same results.
- Autocomplete, ads, and image or video search.

### Assumptions

- **Traffic is uneven.** A small number of queries are very popular, and most queries are rare. The popular ones should almost always be in the cache.
- **Results go stale.** Pages change, appear and disappear, and their rankings move. We need a rule for when cached results expire or get refreshed.
- **Lookups must be fast.** Serving from the cache should take about as long as one network round trip inside the data center.
- **The network between machines is fast.** The cache machines, API servers and search services are in the same data center.
- **Memory is limited.** The cache can't hold the results of every query ever asked, so we need to decide what to keep and what to remove. It still needs to hold millions of queries.
- **10 million users.**
- **10 billion queries a month.**
- **Each cached entry stores the query and its results.** The query averages 50 bytes. Each result has a title of 20 bytes and a snippet of 200 bytes. We'll add a URL of about 80 bytes per result, since a result needs a link, and a results page shows **10 results**.

### Calculate usage

Check with your interviewer whether they want these numbers before you work them out. The [estimation](/learn/estimation) chapter explains the method.

**Requests per second.** A 30-day month has 30 × 86,400 = 2,592,000 seconds, about 2.5 million.

- 10,000,000,000 queries ÷ 2,592,000 s ≈ **3,860 queries a second** on average. Rounding the month to 2.5 million seconds gives the handy figure of **about 4,000 a second**.
- Traffic peaks in the evening. Assume a peak of 3× the average: 3,860 × 3 ≈ **11,600 queries a second**.
- Per user: 10 billion ÷ 10 million = 1,000 queries a month, or about 33 a day. That's a heavy user, which is fine for an exercise.

A conversion guide worth memorizing, using 2.5 million seconds a month:

- 1 request a second ≈ 2.5 million requests a month
- 40 requests a second ≈ 100 million requests a month
- 400 requests a second ≈ 1 billion requests a month

**Size of one entry.**

- With one result per query: 50 (query) + 20 (title) + 200 (snippet) = **270 bytes**.
- With a full page of 10 results and a URL for each: 50 + 10 × (80 + 20 + 200) = 50 + 3,000 = **3,050 bytes**, about 3 KB.

The rest of the chapter uses 3,050 bytes, because a results page has ten results and each needs a link.

**Storage if we kept everything.**

- One result per query: 270 bytes × 10 billion = 2.7 TB a month.
- Ten results per query: 3,050 bytes × 10 billion = 30.5 TB a month.
- Over 3 years at ten results: 30.5 TB × 36 = 1,098 TB, about **1.1 PB**.

These are worst cases, where every one of the 10 billion queries is different. Many queries repeat, so the number of distinct entries is lower. Even so, the numbers show we can't keep everything in memory. We have to choose what to keep.

**Memory for the popular queries.** Assume that the 100 million most popular distinct queries cover most of the traffic. You'd check this against real query logs.

- 100,000,000 × 3,050 bytes = 305 GB of entries.
- The hash table, list pointers and allocator overhead add something like 100 bytes per entry: 100,000,000 × 100 bytes = 10 GB more.
- Total: about **315 GB**.

**Bandwidth out of the cache.** Every query reads one entry.

- Average: 3,860 × 3,050 bytes ≈ 11.8 MB a second ≈ 94 Mbps.
- Peak: 11,600 × 3,050 bytes ≈ 35.4 MB a second ≈ 283 Mbps.

**Load on the search backend.** Assume 80% of queries hit the cache. You'd measure the real hit rate once the cache runs.

- Misses: 20% × 3,860 ≈ 770 a second on average, and 20% × 11,600 ≈ 2,320 a second at peak.
- Without the cache, the backend would take all 3,860 (11,600 at peak). An 80% hit rate cuts its load by 5×.
- Every miss also writes one entry into the cache, so the cache takes about 770 writes a second on average.

**What these numbers tell us.** The cache is read-heavy: about four reads for every write at an 80% hit rate, and more as the hit rate rises. The bandwidth is small for a data center network. Each request is a single key lookup, so the request rate is manageable. The hard number is memory: about 315 GB won't fit comfortably in one machine's RAM, so the cache has to be split across machines, which is the main decision in step 4. The second-hardest number is the miss load: if the cache empties, the backend suddenly sees 5× its normal traffic.

## Step 2: Create a high-level design

```diagram
title: The Query API checks the memory cache before doing any search work
[c:client] Client @ 0,1
[web] Web server\n(reverse proxy) @ 1,1
[api] Query API @ 2,1
[cache:store] Memory cache @ 3.5,0
[idx] Reverse index\nservice @ 3.5,1
[doc] Document\nservice @ 3.5,2
c -> web : search request
web -> api
api -> cache : 1. get(key)
api -> idx : 2. on miss
api -> doc : 3. titles, snippets
```

- **Client.** A browser or app that sends the user's query.
- **Web server.** A reverse proxy, a server that receives requests from the internet and forwards them to the servers behind it. It terminates TLS and forwards the request to the Query API. The [reverse proxy chapter](/learn/reverse-proxy-and-api-gateway#what-a-reverse-proxy-is) explains what else it does.
- **Query API.** Turns the raw query into a cache key, checks the cache, and on a miss gathers results from the two search services.
- **Memory cache.** Holds recent query results in RAM, keyed by the normalized query. Redis or Memcached are common choices. It evicts the least recently used entries when it fills up.
- **Reverse index service.** On a miss, finds the documents that match the query terms, ranks them, and returns the IDs of the top ones.
- **Document service.** On a miss, returns the title, URL and a snippet for each document ID.

Why keep results in memory at all? Memory is much faster than storage. A widely shared table of latency figures, labelled as numbers from about 2012, puts reading 1 MB sequentially from memory at 250 µs, from an SSD at 1,000 µs (4× slower), and from a spinning disk at 20,000 µs (80× slower). Our entries are about 3 KB, so reading one from memory takes under a microsecond. The same table lists a round trip within a data center at 500 µs. A cache hit therefore costs about one network round trip. A miss costs several round trips to the search services, plus the work of reading posting lists and ranking, so it is many times slower.

## Step 3: Design core components

### Use case: User sends a request resulting in a cache hit

Here is what happens when someone searches for something popular:

1. The **client** sends the request to the **web server**.
2. The web server forwards it to the **Query API**.
3. The Query API **parses the query** into a normalized form and builds a cache key from it.
4. It asks the **memory cache** for that key.
5. The cache finds the entry. It moves the entry to the front of its "most recently used" order and returns the stored results.
6. The Query API returns the results to the client.

Steps 3 and 5 hold the interesting decisions.

**Parsing the query into a cache key.** Users type the same question in many ways. If every spelling got its own cache entry, the hit rate would drop and memory would fill with duplicates. So the Query API normalizes the query first. Take the raw query `<b>Cheap</b> Flihgts to  PAIRS`:

1. **Remove markup.** Strip HTML tags and other formatting that came along with pasted text: `Cheap Flihgts to  PAIRS`.
2. **Break the text into terms.** Split on spaces and punctuation: `Cheap`, `Flihgts`, `to`, `PAIRS`.
3. **Normalize capitalization.** Lowercase every term, and normalize Unicode so the same character always has the same bytes: `cheap`, `flihgts`, `to`, `pairs`.
4. **Fix typos.** Replace misspelled terms with the likely intended word: `cheap`, `flights`, `to`, `paris`.
5. **Convert to boolean operations.** Write the query the way the index will run it. Here every term must appear, so the terms are joined with `AND`: `cheap AND flights AND to AND paris`. A term written as `-car` becomes `NOT car`.

Both `<b>Cheap</b> Flihgts to  PAIRS` and `cheap flights to paris` now produce the same string, so they share one cache entry.

The key must also include **everything else that changes the results**. Two people who type the same words but search in different languages, or ask for page 2 instead of page 1, must not share an entry. So the key is built from the locale, the page number and the normalized query: `en-US|1|cheap AND flights AND to AND paris`. If the engine has a safe-search setting or a region filter, those go in the key too. Long keys can be replaced by a hash of the string, such as SHA-256, which gives every key the same size.

Here is a small sketch of the normalization and the key. A real spelling corrector is a system of its own; a two-word table stands in for it here.

```python
import re
import unicodedata

TAG = re.compile(r"<[^>]+>")
SPELLING_FIXES = {"flihgts": "flights", "pairs": "paris"}  # stand-in for a real corrector


def normalize(raw_query):
    """Turn a raw query into the canonical form used as the cache key."""
    text = TAG.sub(" ", raw_query)                             # remove markup
    text = unicodedata.normalize("NFKC", text).casefold()      # normalize capitalization
    parts = []
    for token in re.findall(r"-?\w+", text):                   # break into terms
        negated = token.startswith("-")
        term = SPELLING_FIXES.get(token.lstrip("-"), token.lstrip("-"))  # fix typos
        parts.append(f"NOT {term}" if negated else term)
    return " AND ".join(parts)                                 # boolean form


def cache_key(raw_query, locale, page):
    return f"{locale}|{page}|{normalize(raw_query)}"


cache_key("<b>Cheap</b> Flihgts to  PAIRS", "en-US", 1)
# 'en-US|1|cheap AND flights AND to AND paris'
```

The sketch keeps short words such as `to`, and keeps the terms in the order the user typed them. Sorting the terms would let `paris flights` and `flights paris` share an entry. But if the index uses word order when it ranks, the two queries return different results, and one of them would get the other's page. Only apply a normalization rule if it never changes what the index returns.

**What's stored.** Each entry maps the key to a finished results page:

```python
# key
"en-US|1|cheap AND flights AND to AND paris"
# value
[
    {"url": "https://example.com/flights/paris", "title": "Cheap flights to Paris",
     "snippet": "Compare fares from 300 airlines to Paris and book ..."},
    # ... 9 more results
]
```

We store whole pages with snippets because snippets depend on the query: the document service picks the part of each page that contains the query terms.

#### Cache implementation

The cache has limited memory, so when it's full it has to throw something away to make room. We'll remove the **least recently used (LRU)** entry: the one that has gone longest without being read. LRU fits query traffic well, because a query that was popular a minute ago is likely to be asked again soon, and a query nobody has asked for hours probably won't be.

The cache needs two operations, and both should take constant time, written **O(1)**, however many entries the cache holds:

- `get(key)`: return the value if the key is present, and mark it as the most recently used.
- `set(key, value)`: add or update an entry and mark it as most recently used. If the cache is full, first remove the least recently used entry.

No single data structure does both, so we combine two:

- A **hash map** (a Python `dict`) from key to entry. It finds any entry in O(1).
- A **doubly linked list** of entries in recency order. Each node points to the node before it and the node after it. New and newly used entries go to the **head** of the list. The least recently used entry is always at the **tail**, so eviction removes the tail.

The list must be doubly linked. When a `get` hits an entry in the middle of the list, we move it to the head. To take a node out of the middle, we have to update its neighbor on each side. With a pointer back to the previous node, that's two pointer updates. With only forward pointers, finding the previous node would mean walking the list from the start, which is O(n).

The sketch below uses two **sentinel** nodes, empty placeholder nodes that sit permanently at each end of the list. With sentinels, every real node always has a neighbor on both sides, so no operation needs a special case for an empty list or for the first and last node. Each node also stores its own key, so that when we evict the tail we know which key to delete from the hash map.

```python
import time


class Node:
    """One cache entry, linked to its neighbors in recency order."""

    __slots__ = ("key", "value", "expires_at", "prev", "next")

    def __init__(self, key=None, value=None, expires_at=None):
        self.key = key
        self.value = value
        self.expires_at = expires_at   # used for TTLs, explained below
        self.prev = None
        self.next = None


class LRUCache:
    """A fixed-size cache that evicts the least recently used entry."""

    def __init__(self, capacity, ttl_seconds=None, clock=time.monotonic):
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self.capacity = capacity
        self.ttl_seconds = ttl_seconds
        self.clock = clock
        self.nodes = {}                # key -> Node
        self.head = Node()             # sentinel: head.next is the most recent entry
        self.tail = Node()             # sentinel: tail.prev is the least recent entry
        self.head.next = self.tail
        self.tail.prev = self.head

    def _unlink(self, node):
        node.prev.next = node.next
        node.next.prev = node.prev

    def _push_front(self, node):
        node.prev = self.head
        node.next = self.head.next
        self.head.next.prev = node
        self.head.next = node

    def get(self, key):
        node = self.nodes.get(key)
        if node is None:
            return None                                # miss
        if node.expires_at is not None and node.expires_at <= self.clock():
            self._unlink(node)                         # expired: drop it, report a miss
            del self.nodes[key]
            return None
        self._unlink(node)                             # hit: move to the front
        self._push_front(node)
        return node.value

    def set(self, key, value):
        expires_at = None
        if self.ttl_seconds is not None:
            expires_at = self.clock() + self.ttl_seconds
        node = self.nodes.get(key)
        if node is not None:                           # existing key: update, move to front
            node.value = value
            node.expires_at = expires_at
            self._unlink(node)
            self._push_front(node)
            return
        if len(self.nodes) >= self.capacity:           # full: evict the tail
            oldest = self.tail.prev
            self._unlink(oldest)
            del self.nodes[oldest.key]
        node = Node(key, value, expires_at)
        self.nodes[key] = node
        self._push_front(node)

    def delete(self, key):
        node = self.nodes.pop(key, None)
        if node is not None:
            self._unlink(node)
```

Every method does a dict lookup and a fixed number of pointer changes, so each runs in O(1). A quick check with a capacity of 2:

```python
cache = LRUCache(capacity=2)
cache.set("a", 1)
cache.set("b", 2)
cache.get("a")      # returns 1; "a" is now the most recent, "b" the least
cache.set("c", 3)   # cache is full, so "b" is evicted
cache.get("b")      # returns None
```

A few things the sketch leaves out, which a real cache has to handle:

- **Capacity in bytes.** The sketch counts entries. Results pages vary in size, so a real cache tracks the bytes it holds and evicts until it's under its memory limit.
- **Concurrency.** Even a `get` changes the list. If many threads share the cache, every operation needs a lock, or the cache needs to be split into independent segments, each with its own lock.
- **Python's shortcut.** The standard library's `collections.OrderedDict` has `move_to_end()` and `popitem(last=False)`, and its documentation says these make it "suitable for implementing various kinds of LRU caches." Writing the list yourself, as above, is what an interviewer usually wants to see.

**Real caches approximate LRU.** An exact LRU list costs two pointers per entry and a list update on every read. Redis saves that memory. Its [eviction documentation](https://redis.io/docs/latest/develop/reference/eviction/) explains that it samples a small number of keys at random (5 by default, set with `maxmemory-samples`) and evicts the one unused for longest. Since Redis 3.0 it also keeps a pool of good candidates between evictions. The docs describe the result as "virtually equivalent" to true LRU for applications. On 64-bit systems Redis has no memory limit by default, so for this cache you'd set `maxmemory` and the `allkeys-lru` policy, which the docs call "a good default option if you have no reason to prefer any others." [Memcached](https://docs.memcached.org/) is "by default, a Least Recently Used cache." [Caching](/learn/cache#when-the-cache-is-full) compares LRU with the other eviction policies.

#### When to update the cache

A cached results page is a copy of what the search backend would say right now. It goes stale when:

- **A page's content changes.** The snippet or title in the cache no longer matches the page.
- **A page is removed or a new page is added.** The cache may list a page that's gone, or miss a new page that should rank highly.
- **A page's rank changes.** The order in the cache no longer matches what the index would return.

There's no cheap way to find every cached query that a changed page appears in. A popular page can appear in the results of millions of queries, and the cache is keyed by query. A second index from each page to the cached queries that contain it would have to be updated on every cache write and eviction.

The simplest fix is a **time to live (TTL)**: a maximum time an entry may stay in the cache. When the TTL runs out, the entry counts as a miss, and the next request fetches fresh results. The `LRUCache` above supports this through `ttl_seconds`: `set` stamps each entry with an expiry time, and `get` treats an expired entry as a miss and removes it. Redis and Memcached both let you set an expiry time on each key.

How long should the TTL be? It's a trade-off between freshness and hit rate:

- A short TTL, such as a few minutes, keeps results fresh. It also expires popular entries that are still useful, so the backend repeats work it just did.
- A long TTL, such as a day, gives a high hit rate. It also means a page that changed this morning can show its old snippet until tonight.

Most engines use different TTLs for different queries. News-like queries, where results change by the minute, get a short TTL. Stable reference queries, like `boiling point of water`, get a long one. So an entry leaves the cache in one of two ways: its TTL runs out, or LRU evicts it.

Three refinements are worth mentioning in an interview:

- **Version the keys when the index is rebuilt.** If the index is rebuilt in batches, put the index version in the key: `v812|en-US|1|cheap AND flights AND to AND paris`. When version 813 goes live, every lookup uses a new key and misses. The old entries are never read again, and LRU evicts them. This invalidates everything at once without deleting anything. The cost is a burst of misses right after each switch.
- **Refresh popular entries before they expire.** For the few thousand most popular queries, a background job can fetch fresh results shortly before the TTL runs out. Users never see a miss for them. This is called refresh-ahead.
- **Remove pages that must disappear now.** Some changes can't wait for a TTL, such as a page taken down for legal reasons. Keep a small blocklist of removed document IDs, and have the Query API filter cached results against it before returning them.

This read pattern, where the application checks the cache, reads the source on a miss, and writes the result back, is called **cache-aside**. [Caching](/learn/cache#when-to-update-the-cache) compares it with read-through, write-through, write-behind and [refresh-ahead](/learn/cache#refresh-ahead).

### Use case: User sends a request resulting in a cache miss

Now someone searches for something rare, or something whose entry just expired:

1. The client sends the request through the web server to the Query API.
2. The Query API normalizes the query, builds the key and asks the memory cache. The cache returns nothing.
3. The Query API sends the query terms to the **reverse index service**. That service finds the documents that contain the terms, ranks them, and returns the IDs of the top results.
4. The Query API sends those IDs and the query terms to the **document service**, which returns a URL, a title and a query-specific snippet for each.
5. The Query API **writes the results into the cache** under the key. The cache places the new entry at the front of its LRU list, evicting the tail entry if it's full.
6. The Query API returns the results to the client.

The Query API in Python, using the cache from the previous section:

```python
class QueryApi:

    def __init__(self, cache, reverse_index, documents, results_per_page=10):
        self.cache = cache
        self.reverse_index = reverse_index
        self.documents = documents
        self.results_per_page = results_per_page

    def search(self, raw_query, locale="en-US", page=1):
        key = cache_key(raw_query, locale, page)
        results = self.cache.get(key)
        if results is not None:
            return results                                     # hit

        query = normalize(raw_query)                           # miss
        doc_ids = self.reverse_index.top_documents(
            query, locale=locale,
            limit=self.results_per_page,
            offset=(page - 1) * self.results_per_page,
        )
        results = self.documents.summaries(doc_ids, query)     # url, title, snippet
        self.cache.set(key, results)
        return results
```

**The public API.** The client sends one request:

```http
GET /api/v1/search?q=Cheap+Flihgts+to+PAIRS&page=1 HTTP/1.1
Host: search.example.com
Accept-Language: en-US
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "query": "Cheap Flihgts to PAIRS",
  "showing_results_for": "cheap flights to paris",
  "page": 1,
  "results": [
    {
      "url": "https://example.com/flights/paris",
      "title": "Cheap flights to Paris",
      "snippet": "Compare fares from 300 airlines to Paris and book ..."
    }
  ]
}
```

The response has the same shape on a hit and on a miss.

**The internal calls.** On a miss, the Query API makes two calls. These are inside the data center, so they would typically use RPC (a remote procedure call, where one service calls a function on another over the network) rather than public REST endpoints. The [protocols chapter](/learn/protocols-and-apis) compares the two.

```python
# Reverse index service
top_documents(query="cheap AND flights AND to AND paris", locale="en-US", limit=10, offset=0)
# -> [48213, 99102, 5521, ...]           ten document IDs, best first

# Document service
summaries(doc_ids=[48213, 99102, ...], query="cheap AND flights AND to AND paris")
# -> [{"url": ..., "title": ..., "snippet": ...}, ...]
```

The reverse index is a big system of its own. It's usually split into many shards, and each query asks all of them and merges the answers. [Design a web search engine](/learn/design-search-engine#the-inverted-index-pipeline) explains how it's built and [how it's partitioned](/learn/design-search-engine#partitioning-the-index-by-document-or-by-term). That fan-out is exactly why a miss is expensive and why the cache pays off.

**Three details of the miss path:**

- **Cache empty results too.** If a query matches nothing, store the empty list with a short TTL. Otherwise every repeat of a nonsense query goes all the way to the index. [Caching](/learn/cache#cache-penetration) calls this cache penetration.
- **Don't let a popular miss stampede the backend.** When the entry for a popular query expires, hundreds of requests can miss at the same moment, and every one of them asks the index. Let one request rebuild the entry while the others wait for it, or serve the stale entry briefly while one request refreshes it. [Caching](/learn/cache#cache-stampede-thundering-herd) shows both fixes.
- **The write to the cache shouldn't slow the user down.** If the `set` fails or times out, return the results anyway. The cache is an optimization, and the next request will try again.

## Step 4: Scale the design

```diagram
title: The scaled design. The memory cache is sharded across machines with consistent hashing
[c:client] Client @ 0,0
[dns] DNS @ 0,1.5
[lb] Load balancer @ 1,0
[web] Web servers @ 2,0
[api] Query API\nservers @ 3,0
[cache:store] Memory cache\nshards + replicas @ 4,0
[idx] Reverse index\nservice @ 3,1.5
[doc] Document\nservice @ 4,1.5
[ix:store] Index shards @ 3,2.5
[ds:store] Document store @ 4,2.5
c -> dns : resolve
c -> lb
lb -> web
web -> api
api -> cache : consistent hash
api -> idx : on miss
api -> doc : on miss
idx -> ix
doc -> ds
```

Don't jump straight to this picture. Scaling is a loop: load-test the current design, profile it to find what breaks first, fix that one thing while weighing the alternatives, and repeat. The numbers from step 1 tell us where to look:

- **About 315 GB of hot entries.** That's too much for one cache machine. This is the main bottleneck.
- **3,860 queries a second on average, 11,600 at peak.** That's too many for one web server and one Query API server to handle safely, and one of each would be a single point of failure.
- **770 misses a second on average, 2,320 at peak**, at an 80% hit rate. Any drop in the hit rate lands on the reverse index, which is the most expensive part of the system.
- **About 283 Mbps of results at peak.** That's modest, and not a bottleneck.

[Scalability](/learn/scalability) walks through the usual fixes in the order systems tend to need them. Here they are for this design.

### DNS, a load balancer, and more web and API servers

**DNS** turns the search engine's hostname into the address of the load balancer. It can also send users to the nearest data center if the engine runs in several. See [DNS and CDNs](/learn/dns-and-cdn).

A **load balancer** spreads requests across a pool of **web servers**, which forward them to a pool of **Query API servers**. Running many identical copies of a server like this is called **horizontal scaling**. The pool handles 11,600 queries a second at peak, and losing one server reduces capacity instead of taking the service down. The [load balancing chapter](/learn/load-balancing) covers health checks and routing methods.

This works because the web and Query API servers are **stateless**: they keep nothing between requests, so any server can handle any request. Keeping the two layers separate lets each scale on its own, with internal load balancers between them (left out of the diagram to keep it readable).

### Expanding the memory cache to many machines

The cache needs about 315 GB of RAM for the hot entries, plus room to grow. Assume each cache machine gives 64 GB to the cache. Then we need 315 ÷ 64 ≈ 5 machines, so 6 with some headroom. The question is how to arrange the data on them. There are three options.

**Option 1: Each machine in the cache cluster has its own cache.** Each Query API server keeps its own independent cache, or sends each request to a cache machine picked at random. This is simple: there's nothing to coordinate. Its problem is the hit rate. Each machine sees only part of the traffic, so a query has to be asked on every machine before every machine has it cached.

Here's an example. Say 10 machines each have their own cache, and a query is asked 10 times an hour, each time on a random machine. With one shared cache, the first request misses and the other 9 hit: a 90% hit rate. With 10 separate caches, each request misses whenever it lands on a machine that hasn't seen the query yet. The expected number of different machines that 10 random requests reach is 10 × (1 − 0.9^10) ≈ 10 × 0.65 = 6.5. That's 6.5 misses and 3.5 hits: a hit rate of about 35%. The same popular entries are also stored on many machines, so the cluster holds far fewer distinct queries than its total memory suggests.

**Option 2: Each machine in the cache cluster has a copy of the cache.** Every machine holds every entry. Every write goes to all machines, and any machine can answer any read. This keeps the hit rate high, and any machine can fail without losing data. Its problem is memory. The cluster can only hold as much as one machine: 64 GB ÷ 3,050 bytes ≈ 21 million entries, far short of the 100 million we wanted. Each miss also turns into a write on every machine. This option suits a small, very hot set of keys. A 315 GB cache is far too big for it.

**Option 3: The cache is sharded across all machines in the cache cluster.** Sharding means splitting the data so that each machine holds a different part. Each key belongs to exactly one machine. The Query API computes which one from the key itself, something like `machine = hash(key) mod N`, where N is the number of machines. Every request for a query goes to the same machine, so the hit rate is the same as one big cache. The memory of all machines adds up: 6 machines × 64 GB = 384 GB, enough for our 315 GB. Reads and writes spread evenly across the machines.

This is the best option, and it's more complex. The complexity is in what happens when N changes. With `hash(key) mod N`, going from 6 machines to 7 changes the machine for most keys. A key keeps its machine only if `hash mod 6` and `hash mod 7` happen to agree, which is true for about 1 key in 7. So about 6/7 ≈ 86% of keys move, and those lookups miss. With an 86% miss rate the backend sees roughly 4× its normal load at once: 0.86 × 3,860 ≈ 3,320 misses a second against the usual 770.

**Consistent hashing** fixes this. It places both machines and keys on a circle of hash values, called a ring, and each key belongs to the next machine clockwise from it. Adding a seventh machine takes over only the keys between it and its neighbor, about 1/7 ≈ 14% of the total. Every other key stays where it was. Each machine is usually placed at many points on the ring, called virtual nodes, so the keys spread evenly. [Consistent hashing](/learn/consistent-hashing#the-ring) explains the ring and [virtual nodes](/learn/consistent-hashing#virtual-nodes) in detail.

How real systems do it:

- **Memcached** leaves distribution to the client. Its [documentation](https://docs.memcached.org/) says the servers "are unaware of each other," with "no crosstalk, no synchronization, no broadcasting, no replication." The client library uses a hashing algorithm to choose a server from the key. In 2007, Richard Jones of Last.fm described [ketama](https://metabrew.com/article/libketama-consistent-hashing-algo-memcached-clients), a consistent hashing library for Memcached clients. He wrote it because changing the server list under mod-N hashing "effectively wiped the entire cache." Ketama gives each server 100 to 200 points on the ring.
- **Redis Cluster** uses a different scheme. Its [scaling documentation](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/) says it "does not use consistent hashing." Each key belongs to one of 16,384 **hash slots**, computed as the CRC16 of the key modulo 16,384, and each node owns a range of slots. Adding a node means moving some slots to it, which the docs say can happen without downtime. This gets the same property as a ring, where adding a machine moves only part of the data, with a fixed number of slots.

The cost of sharding is more moving parts. Every Query API server needs the current list of cache machines, and they all need to agree on it, or two servers will look for the same key in different places. Usually a small configuration service or the cache cluster itself publishes the list.

For a general-purpose distributed key-value store, with replication, quorums and durable storage, see [Design a key-value store](/learn/design-key-value-store). A query cache needs much less, because every entry can be rebuilt from the search backend.

### Hot queries

Sharding puts each key on one machine. When a query suddenly becomes very popular, such as a breaking news story, all its requests go to the same shard. Say a single query gets 3,000 requests a second at peak. That's about a quarter of all traffic landing on one of 6 machines.

Two common fixes:

- **A small local cache on each Query API server.** Each server keeps the few thousand hottest entries in its own memory, in an `LRUCache` like the one above, with a TTL of a few seconds. Most requests for the hot query never leave the API server. The short TTL limits how stale the copies get. This is option 1 from the previous section, used deliberately for a small set of keys where it works well.
- **Replicate hot keys.** Store a hot key on several shards under suffixed keys, such as `key#1` to `key#4`, and have readers pick one at random. This spreads the load, and the cost is that an update has to reach every copy.

[Consistent hashing](/learn/consistent-hashing#hot-keys) discusses hot keys further.

### Keeping the service available

The third use case asks for high availability. Here is what happens when each part fails:

- **A web or Query API server fails.** The load balancer's health checks notice, and it stops sending traffic there. The other servers absorb the load.
- **A cache shard fails.** All of its keys miss at once. With 6 shards, that's about 1/6 of the traffic, or 3,860 ÷ 6 ≈ 640 extra misses a second on top of the usual 770. The Query API should treat a cache error as a miss and keep serving. To avoid the extra load, give each shard a **replica**, a second machine with a copy of its data that takes over when the primary fails: 12 cache machines in all. Because every entry can be rebuilt from the backend, you can skip replicas if the backend has room for the burst.
- **The reverse index slows down or fails.** Cached queries keep working, which is a form of graceful degradation. For misses, the Query API should time out, retry once, and then return an error. If a cache entry has just expired, serving the stale results is often better than an error.
- **Many entries expire at once.** If entries were written together with the same TTL, they also expire together and the backend gets a spike. Adding a few random seconds or minutes to each TTL spreads the expiries out. [Caching](/learn/cache#cache-avalanche) calls this a cache avalanche.

**Consistency.** The cache is eventually consistent with the index: an entry can be out of date for up to its TTL. For search results that's acceptable, since nobody can tell whether results are five minutes old. The exceptions are the removals that must take effect at once, which the blocklist handles. [CAP and consistency](/learn/cap-and-consistency) explains the consistency models, and [availability](/learn/availability#fail-over-and-replication) covers fail-over and replication.

Keep measuring after the design ships. Track the hit rate, eviction rate, latency at the 99th percentile and the backend's miss load. Redis's `INFO stats` reports `keyspace_hits`, `keyspace_misses` and `evicted_keys`. A falling hit rate with many evictions means the cache is too small for the working set. See [observability](/learn/observability).

## Trade-offs and follow-up questions

**LRU or something smarter?** LRU suits traffic where recent popularity predicts future popularity. Its weakness is the long tail of one-off queries: each one enters at the head of the list and pushes useful entries toward eviction, though it will never be asked again. **LFU** (least frequently used, `allkeys-lfu` in Redis) keeps entries that are asked often over a longer period. **Second-hit admission** stores a result only once its query has been seen twice; the Python documentation's `MultiHitLRUCache` recipe does this "to avoid flushing the LRU cache with one-time requests." Start with LRU, measure, and add second-hit admission if one-off queries are evicting popular ones. [Caching](/learn/cache#when-the-cache-is-full) compares the policies.

**How long a TTL?** Shorter TTLs mean fresher results and a lower hit rate. TTLs by query type (minutes for news, hours or days for stable topics) beat a single TTL, at the cost of classifying queries. If the index is rebuilt in batches, versioned keys handle bulk invalidation, and TTLs only need to cover changes between builds.

**How aggressive should normalization be?** Each rule that maps more queries to one key raises the hit rate, and each rule that maps queries with different results to one key serves someone the wrong page. Lowercasing and stripping markup are safe. Spelling correction is safe if the response says "showing results for." Sorting or dropping terms is only safe if the index ignores word order.

**Whole pages or document IDs?** Full pages make a hit one lookup, at about 3 KB each. Ten document IDs take roughly 50 + 10 × 8 = 130 bytes, so about 23× more queries fit, but every hit then calls the document service. At 315 GB across six machines, full pages are affordable, so cache them.

**How to distribute the cache?** Per-machine caches have a low hit rate. Full copies waste memory. Sharding with [consistent hashing](/learn/consistent-hashing) is the right default, with a small local cache on each API server for hot keys.

**Redis, Memcached, or your own?** Memcached is a plain cache whose clients do the sharding. Redis adds replication and Redis Cluster, whose failover and slot migration you'd otherwise build yourself. For opaque results pages either works; [Caching](/learn/cache#redis-vs-memcached) compares them. Writing your own only makes sense for the in-process local cache.

**Replicas for the cache, or not?** Replicas double the memory bill. Without them, a shard failure sends about 1/N of the traffic to the backend as extra misses until the shard is replaced. If the backend can absorb that, skip replicas. If it's near its limit, add them.

## Check yourself

<details>
<summary>You want to cache the 50 million most popular queries, with a full results page of about 3 KB each, and keep one replica of every shard. Each cache machine gives 64 GB to the cache. How many machines do you need?</summary>

50,000,000 × 3,050 bytes ≈ 153 GB of entries. Add about 100 bytes of overhead per entry, which is 5 GB, for roughly 158 GB. 158 ÷ 64 ≈ 2.5, so 3 shards, or 4 with headroom for growth and uneven distribution. With one replica per shard, that's 6 to 8 machines.

Then check the request rate. At 11,600 queries a second at peak spread over 3 or 4 primaries, each handles about 3,000 to 4,000 lookups a second, which an in-memory cache handles easily. Here memory sets the machine count, and throughput has plenty of room.

</details>

<details>
<summary>The team adds a seventh cache machine to six, using `hash(key) mod N`. Right after, the reverse index service's load jumps more than fourfold. Why, and how do you prevent it next time?</summary>

Changing N from 6 to 7 changes the machine for almost every key. A key stays put only if `hash mod 6` equals `hash mod 7`, which is true for about 1 key in 7. So about 86% of lookups go to a machine that doesn't have the entry, and they miss. With roughly 86% misses instead of 20%, the index sees about 0.86 ÷ 0.20 ≈ 4.3 times its normal miss load, which matches what you saw.

Use consistent hashing, or a fixed number of slots like Redis Cluster's 16,384. Adding a seventh machine then moves only about 1/7 of the keys. You can also add capacity during quiet hours and warm the new machine before it takes traffic.

</details>

<details>
<summary>Why does the LRU cache use a doubly linked list, and why does each node store its own key?</summary>

A `get` that hits an entry in the middle of the list has to move it to the head. Removing a node from the middle means pointing its previous neighbor at its next one. With a `prev` pointer that's O(1). In a singly linked list you'd have to walk from the head to find the previous node, which is O(n).

The node stores its key for eviction. When the cache is full, we take the node at the tail, and we also have to delete its entry from the hash map. The hash map is indexed by key, so without the key on the node we couldn't find which entry to delete.

</details>

<details>
<summary>A court orders a page removed from results. Your TTL is 24 hours, and the page appears in thousands of cached queries. What do you do?</summary>

You can't wait 24 hours, and you can't find every cached query that includes the page, because the cache is keyed by query. Add the document ID to a removal blocklist that every Query API server loads. Before returning results, from the cache or from the backend, filter out blocklisted documents. The fix takes effect as soon as the blocklist reaches the servers.

Then remove the page from the index, so that new results don't include it. Cached entries will age out within the TTL, and after that you can drop the ID from the blocklist. Filtering may leave nine results on a page instead of ten, which is usually acceptable. Otherwise, treat a page with a removed result as a miss and rebuild it.

</details>

<details>
<summary>Your cache has a 60% hit rate, but you expected 85%. The eviction count is very high and most evicted entries were read only once. What's going on, and what would you change?</summary>

The long tail of one-off queries is churning the cache. Every rare query gets inserted at the head of the LRU list and pushes older entries toward the tail. Popular queries that haven't been asked in the last few minutes get evicted to make room for queries that will never be asked again.

Options, roughly in order of effort: add memory, if the working set is just a bit bigger than the cache. Cache a result only the second time its query is seen, so one-off queries never enter the cache. Or switch to LFU, which keeps entries that are asked often over a longer window. Measure the hit rate after each change.

</details>

<details>
<summary>A breaking-news query takes a quarter of all traffic, and the cache shard that owns its key is at 100% CPU. The rest of the cluster is idle. What do you do right now, and what do you change for next time?</summary>

Right now, enable a small local cache on the Query API servers for the hottest keys, with a TTL of a few seconds. Each API server then asks the shard for that key at most once every few seconds, instead of thousands of times a second.

For next time, make the local cache permanent and detect hot keys automatically, for example by counting requests per key on each API server and promoting the top few. For keys that are too big or too frequently updated for local caching, store copies on several shards under suffixed keys, and have readers pick one at random.

</details>

## Further reading

- [Redis: Key eviction](https://redis.io/docs/latest/develop/reference/eviction/): the `maxmemory` setting, every eviction policy, and how Redis approximates LRU and LFU by sampling. Read it before choosing a policy.
- [Redis: Scale with Redis Cluster](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/): how Redis Cluster splits keys into 16,384 hash slots, moves slots between nodes, and uses replicas for failover.
- [Memcached documentation](https://docs.memcached.org/): the overview explains why Memcached servers don't talk to each other and leave the choice of server to the client.
- [libketama: consistent hashing for memcached clients](https://metabrew.com/article/libketama-consistent-hashing-algo-memcached-clients): Richard Jones's 2007 post from Last.fm on why mod-N hashing wiped their cache when they changed servers, and the ring they built to fix it.
- [Python collections: OrderedDict](https://docs.python.org/3/library/collections.html#ordereddict-objects): `move_to_end` and `popitem` make a short LRU cache, and the recipes include a time-bounded LRU and a cache that only admits repeated requests.
- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832): Jonas Bonér's table of memory, SSD, disk and network latencies, labelled as numbers from about 2012. It's where the memory, SSD and disk comparison in this chapter comes from.
