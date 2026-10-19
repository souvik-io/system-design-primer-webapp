# Design search autocomplete (typeahead)

Autocomplete suggests whole queries while you type a prefix: type "how to bo" and you see "how to boil eggs", "how to boost wifi signal" and a few more. It saves keystrokes, steers people toward queries that return good results, and is one of the most latency-sensitive features a search product has, because it runs on nearly every keystroke.

In interviews it's a good test of whether you can separate an offline pipeline (turning query logs into ranked suggestions) from an online serving path (answering a prefix lookup in a few milliseconds), and whether you notice that the read path is so cacheable that most requests never reach your servers. It builds on the chapters on [caching](/learn/cache) and [CDNs](/learn/dns-and-cdn#content-delivery-networks), and its offline half looks a lot like the [sales rank](/learn/design-sales-rank) batch job.

## Requirements and estimates

Scope it first:

- **Functional:** given a prefix, return the top 8 completions ranked by popularity, with recent popularity weighted more. One language and region to begin with. Suggestions are filtered for offensive or unsafe content.
- **Non-functional:** results must feel instant; the service must be highly available (if it's down, the search box still works, just without suggestions); suggestions may be minutes to hours stale.
- **Extensions:** trending queries surfacing within minutes, personalization, spelling tolerance.

### Latency budget

Research on response times going back decades puts the limit for "feels instantaneous" at about 100 ms. Suggestions that arrive after the user typed two more characters are useless. A rough budget from keystroke to rendered list:

| Step | Budget |
|---|---|
| Client wait before sending (debounce) | 0–50 ms |
| Network round trip to the nearest edge | 20–50 ms |
| Server lookup, p99 | under 10 ms |
| Render | under 10 ms |

The network dominates, which tells you where to spend effort: serve from as close to the user as possible, and avoid the round trip entirely when you can. The server lookup has to be an in-memory read, not a query that ranks anything on the fly.

### Load

These numbers are assumptions, chosen for round arithmetic:

- 120 million daily users, 6 searches each: 720 million searches a day.
- A typical query is about 20 characters, but you don't send a request per character. After debouncing and the browser cache, assume 5 requests reach the network per search.
- 720M × 5 = 3.6 billion requests a day. 3.6 × 10⁹ ÷ 86,400 s ≈ 41,700 a second on average. With a 2× peak, plan for about **83,000 requests a second** before CDN caching.

### Index size

- Keep the 50 million most frequent distinct queries, averaging 20 characters.
- Each query contributes at most 20 prefixes, so 50M × 20 = 1 billion prefix occurrences is an upper bound. Shared prefixes collapse much of that. Assume 300 million distinct prefixes.
- Each prefix entry stores the prefix (~15 bytes), 8 query IDs (8 × 8 = 64 bytes) and some overhead: call it 100 bytes. 300M × 100 B = **30 GB**.
- The query strings and scores: 50M × ~30 B ≈ 1.5 GB.

About 32 GB fits in the memory of one large server. So you shard for throughput, fault isolation and multiple languages, not because the data is too big. That's worth saying out loud in an interview.

## API and data model

One read endpoint, designed to be cached:

```http
GET /suggest?q=how%20to%20bo&lang=en&region=us

200 OK
Cache-Control: public, max-age=900
["how to boil eggs", "how to boost wifi signal", "how to book a flight", ...]
```

Normalize the prefix before it becomes part of the URL (lowercase, collapse whitespace, Unicode normalization), so "How  To" and "how to" share one cache entry. There's no write API: suggestions come from the search logs, not from this endpoint.

The data model is a mapping from prefix to an ordered list of suggestions. The deep dive below compares two ways to store it. Offline, the pipeline also keeps a table of `(query, window, count)` aggregates that the index is built from.

## High-level design

```diagram
title: Online serving path (top) and offline build path (bottom)
[browser:client] Browser @ 0,0
[cdn] CDN edge @ 1,0
[svc] Suggest\nservice @ 2,0
[idx:store] Prefix index @ 3,0
[search] Search service @ 0,1
[logs:queue] Query log @ 1,1
[agg] Batch\naggregation @ 2,1
[build] Index builder @ 3,1
[trend] Trend detector @ 2,2
browser -> cdn : GET /suggest
cdn -> svc : cache miss
svc -> idx
browser -> search : submit
search --> logs
logs --> agg
agg -> build
build -> idx : new snapshot
logs --> trend
trend -> build : overlay
```

- **Online:** the browser asks the CDN edge, which answers most requests from cache. Misses go to the suggest service, which reads the prefix index in its own memory.
- **Offline:** submitted searches (not suggest requests, which are mostly half-typed noise) go to a log. A batch job aggregates counts, the builder ranks and filters suggestions per prefix, and publishes an immutable snapshot that suggest servers load.
- **Near real time:** a streaming job watches the same log for sudden spikes and feeds a small trending overlay into the index.

## Building suggestions offline

### Aggregation windows and decay

Raw logs are too large to rank from directly. Aggregate them in time windows, for example hourly counts per normalized query, with a batch or streaming job ([event streaming](/learn/event-streaming) covers the streaming side).

From the windowed counts, compute a score that favors recent activity. Exponential decay is a common choice: each window's count is weighted by `0.5 ^ (age / half_life)`. With a 7-day half-life, a search from a week ago counts half as much as one today, and one from four weeks ago counts 1/16. A long half-life gives stable, slowly changing suggestions. A short one reacts faster and is noisier. You can keep two scores and blend them.

Before ranking, filter. Collapse spelling variants and near-duplicates. Drop any query typed by fewer than some minimum number of distinct users: rare queries are mostly noise, and they can contain personal information like names, addresses or order numbers. Then apply the safety filters described below.

### Two ways to store prefix → top-k

**Option 1: a trie with the top-k cached at each node.** Each node is a character; a path from the root spells a prefix. A plain trie would make you walk the whole subtree under "how to bo" to find the best completions, which could be millions of nodes. So each node also stores its precomputed top 8. A lookup walks `len(prefix)` nodes and reads one list. Compact variants (radix trees, or the finite state transducers Lucene uses for its completion suggester) cut memory considerably.

**Option 2: a flat prefix → top-k table.** Precompute the answer for every prefix up to some maximum length and store it in a hash map or key-value store. A lookup is one key read.

| | Trie with cached top-k | Prefix → top-k table |
|---|---|---|
| Lookup | Walk ~20 nodes, read a list | One key read |
| Memory | Pointers per node; compact forms help a lot | Every prefix stored as a key; simple but larger |
| Sharding | By prefix range, so ranges must be balanced by traffic | Any key-based scheme, including hashing |
| Fits in a KV store or CDN | Needs a custom server | Naturally: key = prefix |
| Incremental updates | Change a count, fix lists up the path | Rewrite every affected prefix key |

Both store the top-k per prefix; they differ in how they're laid out and served. At this scale, rebuilding a snapshot offline and swapping it in makes the incremental-update column matter less. The flat table is often the easier interview answer because it's easy to shard, replicate and cache. The trie is the better answer when memory is tight or you want fuzzy matching, which walks neighboring branches.

Building the table is a straightforward batch job:

```python
import heapq
from collections import defaultdict

def build_index(scores, k=8, max_prefix=25):
    """scores: dict of normalized query -> decayed score."""
    heaps = defaultdict(list)            # prefix -> min-heap of (score, query)
    for query, score in scores.items():
        for i in range(1, min(len(query), max_prefix) + 1):
            h = heaps[query[:i]]
            if len(h) < k:
                heapq.heappush(h, (score, query))
            elif score > h[0][0]:
                heapq.heapreplace(h, (score, query))
    return {p: [q for _, q in sorted(h, reverse=True)] for p, h in heaps.items()}
```

At 50 million queries you'd run the same logic as a distributed job: emit `(prefix, query, score)` pairs, group by prefix, keep the top 8 per group.

Ship the result as a versioned, read-only snapshot. Suggest servers load the new version beside the old one and switch atomically, and rolling back is just loading the previous version.

### Filtering unsafe suggestions

Suggestions are the product putting words in the user's mouth, so the bar is higher than for search results. Most systems layer several defenses:

- Blocklists for slurs, sexual and violent terms, applied after normalization so spacing and character tricks don't slip through.
- Classifiers for hateful, harassing or dangerous suggestions, and extra care with queries that pair a person's name with a negative claim.
- Policy categories the product chooses to suppress entirely, such as certain medical or election-related phrasing.
- A manual removal list for legal and policy requests, applied at serve time so a removal takes effect without waiting for the next build. Remember the CDN purge.

Filtering offline keeps the serving path fast. The serve-time removal list exists only for urgency.

## Serving, caching and freshness

### Sharding

With 32 GB of index and 83,000 requests a second at peak, the simplest setup is **full replicas**: every suggest server holds the whole index, and a load balancer spreads requests. If one server handles 20,000 lookups a second (an assumption; in-memory lookups are cheap, and most of the cost is the HTTP handling), five servers carry the peak and a few more give headroom and zone redundancy.

When the index outgrows one machine, for example once you add many languages, shard it:

- **By language or region first.** It's a natural boundary, and queries rarely cross it.
- **Then by prefix.** Splitting by first letter sounds tidy but is badly skewed, and in a way that changes: during a big tournament, prefixes like "world c" can carry a large share of traffic for weeks, then fade. With the flat table, hash the prefix instead; every lookup is a single key, so any shard can own any prefix. With a trie, split by prefix ranges sized by measured traffic, and re-split as traffic shifts.

### Caching at three layers

The read path is ideal for caching: the same prefixes are requested constantly, responses are small, and they can be minutes stale.

- **In the browser.** Return `Cache-Control: max-age` of several minutes. When the user types "pyth", deletes the "h" and types it again, the second request never leaves the machine. See [client caching](/learn/cache#client-caching).
- **At the CDN.** Short prefixes ("a", "th", "how") are requested by everyone. Because the response depends only on the URL, the CDN can serve them with very high hit rates, and the long tail of longer prefixes falls through to your servers. See [CDN caching](/learn/cache#cdn-caching).
- **In the server.** The index itself is already in memory, so there's nothing to cache in front of it.

Cache lifetime is a trade-off between hit rate and freshness. A 15-minute TTL means a removed suggestion can survive at the edge for up to 15 minutes. Urgent removals need a CDN purge as well as an index change.

### On the client

The client does a lot to cut load and hide latency:

- **Debounce:** wait until typing pauses for a few tens of milliseconds before sending, so a fast typist doesn't fire a request per character.
- **Cancel or ignore stale responses.** Responses can arrive out of order. Tag each request with a sequence number and drop any response older than the latest one shown.
- **Filter locally.** If you already have suggestions for "pyth" and the user types "o", show the ones that still match "pytho" right away while the real request is in flight.

### Trending and freshness

A daily rebuild can't surface a news event that broke an hour ago. A streaming job counts queries in short windows (say 5 minutes) and flags queries whose rate is far above their usual baseline. Those go into a small trending overlay that the builder merges into affected prefixes, or that the suggest service merges at read time. Spikes are also where abuse shows up, since people try to push a phrase into suggestions with fake searches, so trending candidates need the same filters and some resistance to one source generating most of the volume ([rate limiting](/learn/rate-limiting) helps there).

### Personalization as an extension

Personal signals (your own recent searches, your location) improve relevance but break caching: a response that depends on the user can't be stored at the CDN under a shared key. A common split is to keep the shared suggestions fully cacheable and merge personal ones on the client, from local history or a small per-user call that runs in parallel.

## Scaling and bottlenecks

- **Peak read load** is mostly absorbed by the CDN and browser caches. The servers see the uncached tail.
- **Index build time** grows with the number of queries kept. Partition the build by prefix and run it in parallel, and keep the maximum indexed prefix length bounded.
- **Snapshot distribution.** Pushing a 30 GB snapshot to many servers at once can saturate the network. Stagger it and keep the old version loaded until the new one is verified.
- **Multi-region.** Build once, ship snapshots to each region, and serve locally. Regional query logs can feed regional indexes if suggestions should differ by region.

## Trade-offs to discuss

- **Trie vs flat table:** memory efficiency and fuzzy matching vs simplicity, easy sharding and a natural fit for key-value stores and CDNs.
- **Freshness vs cost:** a daily full build is simple and stable; a trending overlay adds a streaming pipeline and an abuse surface.
- **Cache TTL:** longer TTLs raise hit rates and lower cost, but slow down removals and new suggestions.
- **Debounce delay:** waiting longer saves requests but adds visible delay.
- **Personalization vs cacheability:** personal suggestions are more useful, but they move work from the edge to your servers unless you merge on the client.
- **Privacy:** the minimum-user threshold keeps personal data out of suggestions but also hides genuinely rare, useful completions.

## Check yourself

<details>
<summary>Your interviewer suggests sharding the index by the first letter of the prefix. What do you say?</summary>

It gives badly uneven shards, because first letters aren't equally common and traffic is even more skewed than the data. With a flat prefix table you can hash the full prefix instead, since every lookup is a single key and no range queries are needed. If you keep a trie, split it into prefix ranges sized by measured traffic rather than by letter, and be ready to re-split. Also question whether you need to shard at all: about 30 GB fits in memory, so replicas may be enough.

</details>

<details>
<summary>A suggestion containing a private person's phone number appears for some prefix. How did it get there, and which parts of the design should have stopped it?</summary>

Someone searched for a string containing it, and the pipeline kept it. A minimum count of distinct users per query should have dropped it, because a phone number is rarely searched by many different people; pattern filters for phone numbers and similar personal data are a second layer. To remove it now, add it to the serve-time removal list and purge the affected prefixes from the CDN, then make sure the next build excludes it.

</details>

<details>
<summary>Responses are cached for 15 minutes at the CDN. A celebrity's name starts trending. How long until "celebrity name" appears for the prefix "cele"?</summary>

The trend detector has to see the spike over at least one short window (say 5 minutes), then the overlay must reach the index. Even after the index changes, the CDN and browsers may keep serving the old response for "cele" for up to 15 minutes. So the worst case is roughly the detection window plus the overlay delay plus the TTL. If that's too slow, shorten the TTL for short, popular prefixes, or purge them when the overlay changes.

</details>

<details>
<summary>Why build suggestions from submitted searches rather than from the suggest requests your service receives?</summary>

Suggest requests are mostly partial strings like "how to bo", which aren't queries anyone wants suggested. Their counts also reflect your own suggestions: people click what you show, which would reinforce whatever is already ranked first. Submitted searches are complete, intentional queries. Even those have some feedback loop from accepted suggestions, which is worth mentioning.

</details>

<details>
<summary>You add "your recent searches" to the dropdown. What happens to your CDN hit rate, and how would you avoid that?</summary>

If the server merges personal history into the response, every response becomes unique to a user and can't be cached under a shared URL, so the hit rate collapses and the servers take the full load. Keep the shared suggestions endpoint unchanged and cacheable, and merge personal history on the client from local storage, or fetch it from a separate, uncached endpoint in parallel.

</details>

## Further reading

- [Response times: the 3 important limits](https://www.nngroup.com/articles/response-times-3-important-limits/) (Nielsen Norman Group): where the 0.1-second "feels instant" limit comes from.
- [How Google autocomplete predictions work](https://blog.google/products/search/how-google-autocomplete-predictions-work/): a production system's view of ranking, freshness and policy removals.
- [Elasticsearch suggesters](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-suggesters.html): the completion suggester, an in-memory prefix structure you can run yourself.
- [Using finite state transducers in Lucene](http://blog.mikemccandless.com/2010/12/using-finite-state-transducers-in.html): how a compact trie-like structure stores millions of terms.
- [Trie](https://en.wikipedia.org/wiki/Trie): the data structure and its compressed variants.
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111): what `Cache-Control` and `max-age` mean for browsers and shared caches.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design a search autocomplete system".
- [System Design School primer](https://systemdesignschool.io/primer): "Caching" and "CDN".
