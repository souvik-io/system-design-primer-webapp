# Design a vector database (a managed service for storing and searching embeddings)

A developer creates an index called `support-docs` with 1,536 dimensions and cosine similarity, then upserts 200,000 vectors with metadata such as `{"lang": "de", "product": "billing"}`. Their app then asks for the 10 vectors nearest to a query among German billing documents, and expects an answer in milliseconds that includes the document written a second ago. The same service hosts a retailer with two billion image vectors and 50,000 customers whose indexes nobody queried this month. Pinecone, Weaviate Cloud, Qdrant Cloud and Turbopuffer sell services of this kind.

[Embeddings and vector search](/learn/vector-search) explains the indexes used here, and the storage engine borrows from [LSM-trees](/learn/database-internals#lsm-trees-built-for-heavy-writes). The [RAG question-answering design](/learn/design-rag-qa) is a typical customer: it needs filtered top-k search over 46.8 million chunks.

## Requirements and estimates

Functional requirements:

- **Indexes** with a fixed dimension (up to 4,096) and a metric: cosine, dot product or Euclidean.
- **Writes:** upsert (insert or replace) and delete vectors by ID, each with up to 4 KB of JSON metadata.
- **Queries:** top-k nearest neighbours with metadata filters, optionally fused with a sparse keyword vector (hybrid search).
- **Namespaces:** an index is split into namespaces, usually one per end customer of our customer, and a query searches one namespace.
- Backups, point-in-time restore, and usage-based billing.

Non-functional requirements: a write is visible to queries within 1 second at p99, and a client can ask to read its own writes. For a 10-million-vector, 1,536-dimension index, queries take under 50 ms at p99 (the value 99% of queries beat) at recall@10 of at least 0.95, where recall@10 is the share of the exact 10 nearest neighbours returned ([recall, speed and memory](/learn/vector-search#recall-speed-and-memory)). An acknowledged write survives the loss of a node or a zone, and no tenant can push another past its latency target.

**Tenants.** These figures are invented. Most indexes are tiny and a few are enormous.

| Index size | Indexes | Typical vectors | Total vectors |
|---|---|---|---|
| Tiny, under 100,000 | 54,000 | 10,000 | 0.54 billion |
| Small, 100,000 to 10 million | 5,700 | 1 million | 5.7 billion |
| Large, 10 million to 1 billion | 295 | 40 million | 11.8 billion |
| Huge, over 1 billion | 5 | 2 billion | 10 billion |
| **Total** | **60,000** | | **28.04 billion** |

Assume the huge indexes use 768 dimensions, the other 18.04 billion vectors are half 768 and half 1,536, and each vector carries 256 bytes of ID and metadata.

**Bytes per vector.** int8 scalar quantization stores each number in one byte. [Product quantization](/learn/vector-search#product-quantization) (PQ) uses one byte per 12 dimensions here. HNSW rows use the FAISS formula from [HNSW](/learn/vector-search#hnsw), d × 4 + M × 2 × 4 bytes, so at M = 16 the links add 128 bytes.

| Form | 768 dims | 1,536 dims |
|---|---|---|
| float32 vector | 3,072 B | 6,144 B |
| int8 vector | 768 B | 1,536 B |
| PQ code | 64 B | 128 B |
| HNSW over float32 | 3,200 B | 6,272 B |
| HNSW over int8 | 896 B | 1,664 B |

**Logical size.** The huge indexes hold 10 billion × (3,072 + 256) = 33.3 TB. The rest average (3,072 + 6,144) ÷ 2 = 4,608 bytes of float32, so 18.04 billion × 4,864 = 87.7 TB. Customers store **121 TB**.

**Where the bytes live.** Assume allocated costs per GB-month of $3.50 for RAM, $0.10 for local NVMe SSD and $0.023 for object storage, all invented. HNSW over float32 for everything, in RAM with two replicas, needs (10 billion × 3,200 + 18.04 billion × 4,736) × 2 = 234.9 TB, about **$822,000 a month**. A tiered layout:

| Tier | Holds | Size | Monthly |
|---|---|---|---|
| Object storage | Every segment, the source of truth | 121.0 TB | $2,784 |
| RAM, shared pool | int8 HNSW for the warm 20% of non-huge vectors (3.61 billion × 1,280 B), two replicas | 9.24 TB | $32,328 |
| RAM, huge pools | 64-byte PQ codes for 10 billion vectors, two replicas | 1.28 TB | $4,480 |
| NVMe, shared pool | float32 and metadata of warm vectors, two replicas | 35.1 TB | $3,510 |
| NVMe, huge pools | Vectors, 256-byte graph rows and metadata, two replicas | 71.7 TB | $7,168 |
| **Total** | | | **about $50,300** |

That is 16 times cheaper, and it rests on an assumption to state aloud: on a given day only about 20% of the non-huge vectors are queried at all. Check it against access logs.

**Traffic.** Assume 20,000 queries a second on average and 50,000 at peak, 5% of them to the huge indexes. Writes average 10,000 vectors a second (864 million a day, 3.1% of all vectors) and bulk imports reach 60,000. At 4,864 bytes each, the write log carries 48.6 MB/s on average and 292 MB/s at peak.

**Nodes.** Assume a node with 512 GB of RAM (400 GB usable for index data), 7.5 TB of NVMe and 64 vCPUs.

- The shared pool needs 9.24 TB ÷ 400 GB = 23.1, so **24 nodes**, eight per zone. NVMe would need only 4.7, so RAM decides.
- CPU check: at an assumed 3 ms of core time per query, 47,500 queries a second use 142.5 cores, or 285 at 50% utilization, well inside 24 × 64 vCPUs.
- A huge index is 2 billion × (3,072 + 256 + 256) = 7.17 TB per replica, in 16 shards of 125 million vectors (448 GB of NVMe and 8 GB of PQ codes each). Two nodes per replica, two replicas: **4 nodes per huge index**, 20 in all.
- Plus a 6-node write log across three zones and an autoscaled builder pool.

## API design

| Call | Purpose |
|---|---|
| `POST /v1/indexes` | Create an index: dimension, metric, optional sparse support. |
| `POST /v1/indexes/{ix}/namespaces/{ns}/upsert` | Up to 1,000 vectors with IDs and metadata. Returns a write token. |
| `POST /v1/indexes/{ix}/namespaces/{ns}/delete` | Delete by IDs or by filter. |
| `POST /v1/indexes/{ix}/namespaces/{ns}/query` | Top-k with a filter, optional sparse vector, optional write token. |
| `POST /v1/indexes/{ix}/restore` | Restore to a point in time, into a new index. |

```json
{"vector": [0.012, -0.044, ...], "top_k": 10,
 "filter": {"lang": {"$eq": "de"}, "product": {"$in": ["billing", "invoices"]}},
 "include_metadata": true, "after_write": "wt_7:184022"}
```

The write token `wt_7:184022` means shard 7, log sequence number 184,022. Passing it as `after_write` asks for [read-your-writes](#consistency-and-read-your-writes).

## High-level design

```diagram
title: Writes go through a log, and queries read cached segments
[app:client] Customer app @ 0,1
[rt] Router\nauth, limits,\nshard map @ 1,1
[log:queue] Write log\n3 zones @ 2,0
[bld] Segment\nbuilders @ 3,0
[obj:store] Object storage\nsegments,\nmanifests @ 4,0
[qn] Query nodes\nRAM + NVMe @ 3,1.5
[cp:note] Control plane\nplacement @ 1,2.5
app <-> rt : HTTPS
rt -> log : upserts
log -> bld : sealed ranges
bld -> obj : segment files
log --> qn : tail
rt <-> qn : queries
qn <-> obj : fetch on miss
cp --> rt
```

1. The router checks the API key and the tenant's limits and finds the shard for the namespace, or for each vector ID in a large namespace.
2. The shard's log leader assigns sequence numbers, replicates the batch to two other zones, and acknowledges once two of three replicas hold it.
3. Query nodes tail the log into an in-memory mutable segment, where queries find new vectors within a few hundred milliseconds.
4. Builders turn sealed log ranges into indexed segment files in object storage and publish a new manifest.

A query goes to one replica of each shard involved, which searches its cached segments and mutable segment and returns its best results. A node missing a segment fetches it from object storage.

## Storage: a log and immutable segments

### Segments and merging

A namespace is stored like an [LSM-tree](/learn/database-internals#lsm-trees-built-for-heavy-writes): recent writes in a small mutable segment, older data in **immutable segments**, files written once and later replaced by merged files.

```diagram
title: A vector's path from the log to a merged segment
[w:client] Upsert batch @ 0,0
[wal:queue] Log record\nseq 184022 @ 1,0
[mut] Mutable segment\nbrute force @ 2,0
[seal] Sealed range\nawaiting build @ 3,0
[seg:store] Indexed segment\nHNSW + clusters @ 3,1.5
[big:store] Merged segment\nfewer, larger @ 1,1.5
[man:note] Manifest\nnew version @ 0,2.5
w -> wal : ack at 2 of 3
wal -> mut : apply
mut -> seal : 5,000 rows
seal -> seg : build index
seg -> big : tiered merge
big -> man : swap in
```

The mutable segment seals at 5,000 vectors or 10 seconds. A builder reads that log range and writes a segment file with four parts: an HNSW graph over int8 vectors, float32 vectors for rescoring, metadata with an inverted index (each value mapped to the rows that have it), and the vectors grouped by centroid in an [IVF](/learn/vector-search#ivf) layout for reads straight from object storage. It then writes a new **manifest**, the small file listing the namespace's segments and the highest log sequence number they cover, with a conditional write that fails if another builder got there first.

Each segment is searched separately, so ten 1-million-vector segments cost about ten times one 10-million-vector segment. A **tiered merge** combines eight segments of similar size, giving tiers of about 5,000, 40,000, 320,000 and 2.5 million vectors, up to a cap of 25 million. From a 5,000-vector flush to the cap takes log₈(25,000,000 ÷ 5,000) ≈ 4.1 merges, so each vector is built about four times. Assuming a core inserts 2,000 vectors a second into HNSW, 10,000 writes a second need 10,000 × 4 ÷ 2,000 = 20 builder cores, and 120 at the import peak, in a pool separate from queries.

### Deletes and updates

A delete writes a **tombstone**, a log record saying "ID x is deleted as of sequence 184,050", and an upsert of an existing ID is a tombstone plus a new row. Each node keeps a map from ID to the sequence number of its newest write and skips older rows.

Tombstones hurt HNSW. A deleted node stays in the graph, since removing it would cut the paths through it, so the walk passes through but can't return it. With 30% deleted, collecting 10 live results takes about 10 ÷ 0.7 ≈ 14 candidates, and some regions become reachable only through dead nodes. Builders rewrite a segment once 20% of its rows are deleted, a threshold to tune against measured recall, as in [compaction and deletes](/learn/design-key-value-store#compaction-and-deletes).

### Freshness

A query searches each immutable segment with its index and the mutable segment by brute force, then keeps the best k. Without the newest-sequence check below, the deleted `a` and the old copy of `b` would come back.

```python
import heapq


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def search_segment(query, rows, latest, k):
    """Exact for clarity; a built segment walks its HNSW graph instead."""
    live = ((dot(query, vec), vid) for vid, seq, vec in rows
            if latest.get(vid) == seq)          # skip deleted and overwritten rows
    return heapq.nlargest(k, live)


def search_namespace(query, segments, mutable, latest, k):
    partial = [search_segment(query, seg, latest, k) for seg in segments + [mutable]]
    return heapq.nlargest(k, (hit for hits in partial for hit in hits))


# Rows are (id, sequence number, vector); latest holds each live id's newest write.
built = [[("a", 1, [0.9, 0.1]), ("b", 2, [0.8, 0.3]), ("c", 3, [0.1, 0.9])]]
mutable = [("b", 7, [0.0, 1.0]), ("d", 8, [0.95, 0.05])]   # b rewritten, d new
latest = {"b": 7, "c": 3, "d": 8}                           # a deleted at seq 6

print(search_namespace([1.0, 0.0], built, mutable, latest, k=2))
# [(0.95, 'd'), (0.1, 'c')]
```

The 5,000-vector cap keeps the scan cheap: 5,000 × 6,144 bytes = 30.7 MB, about 3 ms if a core scans an assumed 10 GB/s. Sealed ranges waiting for a builder are scanned the same way, so a builder backlog shows up as query latency.

## Separating storage and compute

Object storage, replicated across zones by its provider, holds every segment, manifest and log range older than a few seconds. Query nodes are caches: int8 graphs in RAM, float32 vectors and metadata on NVMe.

**A lost node loses nothing.** Its replacement downloads its shards' segments, 400 GB in about 200 seconds at an assumed 2 GB/s, while the other replica serves.

**Cold namespaces cost almost nothing.** A namespace of 1 million 1,536-dimension vectors is 6.4 GB, $0.15 a month in object storage. Warm, its 1.66 GB of int8 graph on two replicas costs 3.33 GB × $3.50 = $11.65, about 80 times more. Nodes evict namespaces by recency ([when the cache is full](/learn/cache#when-the-cache-is-full)).

**The first query to a cold namespace is slow.** An HNSW walk over object storage would need a round trip per hop, so the cold path uses the cluster layout. With an assumed 50 ms to first byte and 1 GB/s:

1. Read 1,000 centroids × 1,536 × 4 bytes = 6.1 MB: about 56 ms.
2. Read the 20 nearest clusters by byte range in parallel, 20 × 1,000 × 1,536 bytes = 30.7 MB of int8: about 81 ms.
3. Read float32 vectors for the best 40 candidates and rescore: about 50 ms.

About 190 ms, which misses the warm target but answers. Meanwhile the node downloads the 1.66 GB graph in about 2 seconds, and later queries are warm. Customers can pay to pin a namespace in memory.

## Choosing an index for each segment

| Segment | Structure | Why |
|---|---|---|
| Mutable, or under 5,000 vectors | Brute force | Under 31 MB to scan, no build, recall 1.0 |
| Up to 25 million vectors | HNSW over int8 in RAM, float32 rescoring from NVMe | High recall, any filter, 41.6 GB at the cap |
| Huge-index shards of 125 million | DiskANN-style graph on NVMe, PQ codes in RAM | 8 GB of RAM per shard instead of 208 GB |

**Rescoring** corrects compression error: compressed distances pick about 40 candidates, the node reads their float32 vectors, recomputes exact distances and keeps the top 10, the step [DiskANN](/learn/vector-search#diskann) also uses.

**Latency budget** for a warm query on a 10-million-vector, 1,536-dimension namespace in one shard (p99 figures assumed):

| Step | p99 |
|---|---|
| Client to router, reused connection | 3 ms |
| Auth, shard lookup, admission, hop to the node | 2 ms |
| Evaluate the filter on each segment | 3 ms |
| HNSW over int8, ef_search 128, one large and three small segments | 15 ms |
| Brute force over the mutable segment | 3 ms |
| Rescore 40 candidates from NVMe | 2 ms |
| Merge, read top-10 metadata, reply | 3 ms |
| **Total** | **31 ms** |

The other 19 ms absorbs queueing and pauses. The namespace takes 16.6 GB of RAM and 61.4 GB of NVMe, so it fits one shard, and replicas add throughput.

**Hybrid search.** With sparse support on, each segment also holds an inverted index of sparse vectors. A hybrid query runs both searches under the same filter and fuses the lists with reciprocal rank fusion ([hybrid search](/learn/vector-search#hybrid-search)).

## Filtered search

[Filtering](/learn/vector-search#filtering) describes filtering after the search, before it, or during the graph walk. A shared service can't pick one, because filters range from "every row" to "12 rows". Each segment's inverted index returns a bitmap of matching rows, so the node knows the exact match count before searching and chooses per segment:

```python
def plan(matching: int, total: int, k: int = 10, scan_limit: int = 50_000) -> str:
    """Pick a search strategy for one segment from the filter's exact match count."""
    if matching == 0:
        return "skip segment"
    if matching <= scan_limit:
        return f"exact scan of {matching:,} vectors"
    selectivity = matching / total
    if selectivity >= 0.5:
        return f"graph search, then filter {round(k / selectivity * 2)} candidates"
    return f"filtered graph walk, ef raised to {min(1000, round(128 / selectivity ** 0.5))}"


for matching in (0, 4_000, 40_000, 9_000_000, 300_000):   # in a 10M-vector segment
    print(f"{matching / 10_000_000:>7.2%}", plan(matching, 10_000_000))
#   0.00% skip segment
#   0.04% exact scan of 4,000 vectors
#   0.40% exact scan of 40,000 vectors
#  90.00% graph search, then filter 22 candidates
#   3.00% filtered graph walk, ef raised to 739
```

50,000 int8 vectors at 1,536 dimensions are 76.8 MB, about 8 ms of one core, for an exact answer. In the middle range the walk follows non-matching nodes as stepping stones but never returns them. The square-root rule for ef is a heuristic to tune on measured filtered recall. Qdrant's indexing documentation describes the same approach: payload indexes estimate filter cardinality so the planner can choose a strategy.

A filter every query carries, such as `tenant_id`, belongs in the namespace instead, since a namespace is its own set of segments. A customer can also declare a **partition key**, and builders group rows by it inside each segment so a filter on it reads one group.

## Sharding and replication

### Placement

A **shard** is a unit of placement with its own log partition and replicas.

- **Small namespaces** stay whole. The control plane places each by hashing its ID onto a ring with [virtual nodes](/learn/consistent-hashing#virtual-nodes), and a query touches one shard.
- **Namespaces over 25 million vectors** are split by a hash of the vector ID, so every shard holds a random slice and a query asks them all. This is partitioning by document, as in the [search engine design](/learn/design-search-engine#partitioning-the-index-by-document-or-by-term). A 400-million-vector, 1,536-dimension namespace needs 665.6 GB of int8 HNSW, so it gets 16 shards of 41.6 GB.

```diagram
title: A query to a 16-shard namespace asks every shard for k results
[q:client] Query\ntop_k 10 @ 0,1
[rt] Router\nmerge 160 to 10 @ 1,1
[s1:store] Shard 1\nreplica a @ 3,0
[s2:store] Shard 2\nreplica a @ 3,1
[s16:store] Shard 16\nreplica b @ 3,2
[h:store] Shard 2\nreplica b @ 2,2.5
q <-> rt : results
rt <-> s1
rt <-> s2 : top 10 each
rt <-> s16
rt --> h : hedge
```

Each shard returns its own top k, because the nearest vectors may all sit on one shard:

```python
import heapq


def gather(shard_results, k):
    """Each shard returns its own top k, best first; keep the best k overall."""
    return heapq.nlargest(k, (hit for hits in shard_results for hit in hits))


shard_hits = [[(0.97, "p17"), (0.95, "p03"), (0.94, "p88")],   # shard 0 holds the best three
              [(0.91, "q40"), (0.80, "q02"), (0.79, "q11")],
              [(0.89, "r09"), (0.85, "r61"), (0.70, "r30")]]

print(gather(shard_hits, k=3))                    # p17, p03, p88
print(gather([h[:1] for h in shard_hits], k=3))   # k / 3 per shard: p17, q40, r09
```

### Tail latency of fan-out

A query is as slow as its slowest shard. If each shard beats 25 ms 99% of the time, a 16-shard query beats it only 0.99¹⁶ = 85.1% of the time. Holding the query's p99 at 25 ms needs each shard to meet it at the 99.937th percentile (0.99^(1/16)), and with 64 shards 47% of queries would wait on a slow one ([the tail at scale](/learn/performance-and-latency#the-tail-at-scale)). Three measures help:

- **Fewer, larger shards.** The 25-million cap means a 10-million-vector namespace never fans out.
- **Hedged requests.** If a shard hasn't answered by its p95, the router asks another replica and takes the first reply, for about 5% more shard requests. Dean and Barroso report a Google test where hedging after 10 ms cut the 99.9th-percentile latency from 1,800 ms to 74 ms with 2% more requests.
- **Partial results**, if the customer opts in: reply after 15 of 16 shards, marked `partial: true`.

### Replicas and the write leader

Each shard has two query replicas in different zones, more when hot, and the router picks the one with fewest queries in flight. Writes don't go through replicas. Each log partition has one **leader**, elected by [Raft](/learn/consensus#raft-at-the-intuition-level) among three log replicas, so every replica applies the same writes in the same order and "the newest write to ID x" means the same thing everywhere. Writes continue while two of the three log replicas are reachable.

### Consistency and read-your-writes

Replicas tail the log independently, so one may lag another by 300 ms, and a customer who upserts and then queries can miss their own write. A query with `after_write: "wt_7:184022"` goes to a replica of shard 7 that has applied sequence 184,022, or waits up to a second for one, then fails with a retryable error. That is read-your-writes from [guarantees for one user](/learn/cap-and-consistency#guarantees-for-one-user). Queries without a token take any replica and may be a second stale, the latency side of [PACELC](/learn/cap-and-consistency#pacelc-the-trade-off-when-nothing-is-broken).

## Noisy neighbours and isolation

A filter matching 60% of a 10-million-vector namespace on an unindexed field would force a full scan of 15.4 GB of int8, about 1.5 seconds of one core, the CPU of 500 ordinary queries. Defences:

- **Cost-based admission:** a [token bucket](/learn/rate-limiting#token-bucket) of read units per tenant and a cap of 32 concurrent queries per namespace.
- **Scan caps:** brute force stops at 50,000 vectors per segment, and filters on unindexed fields are rejected with an error naming the field.
- **[Bulkheads](/learn/reliability-patterns#bulkheads):** separate thread pools for queries, segment downloads and log apply, so cold-namespace loads can't starve warm queries.
- **Dedicated pools** for the huge indexes and any tenant over an agreed size or rate. A 16-shard fan-out on every query would otherwise touch most of the shared pool.
- **Moving hot namespaces**, which only costs a segment download.

## Measuring recall in production

Recall falls without errors: deletes pile up, data drifts, a new filter is very selective. For each warm namespace, a job samples up to 1,000 queries a day with their filters, pins the manifest version they ran on, and recomputes the exact top 10 on a separate pool. For 10 million 1,536-dimension vectors, one exact query reads 61.4 GB, 6.1 core-seconds at 10 GB/s, so 1,000 samples cost about 1.7 core-hours a day, less when 50 samples share one pass ([exact search](/learn/vector-search#exact-search)).

Recall@10 is reported per namespace and per filter selectivity band, since unfiltered queries hide filtered ones, with an alert when the 7-day figure drops below 0.93. Freshness lag, builder backlog and cold-query rate get their own [SLOs](/learn/observability#slis-slos-and-error-budgets).

## Changing the embedding model

Vectors from two models can't be compared ([changing the embedding model](/learn/vector-search#changing-the-embedding-model)), and dimensions often differ, so a new model means a new index. An **alias**, a name that points at one index, makes the switch atomic: the customer creates `support-docs-v2`, writes every change to both indexes, backfills v2, compares them on a test set, repoints the alias, and deletes v1 after a rollback window. They pay for both during the overlap. The [RAG design](/learn/design-rag-qa#freshness-deletes-and-model-changes) shows these steps from the customer's side.

## Backups and point-in-time restore

A backup is a copy of a manifest, since the files it names never change. Restoring to 14:03:20 takes the last manifest before then and replays the log up to that moment, into a new index so a mistake can't overwrite live data.

Garbage collection keeps any segment a retained manifest names. A segment stores about 6,144 bytes per vector (float32, int8, links, metadata), and merging rebuilds each write about four times, so 864 million writes a day produce 864 million × 4 × 6,144 ≈ 21.2 TB of segment files a day, 149 TB over 7 days. That more than doubles object storage bytes but adds only about $3,400 a month, under 7% of the tiers' cost.

## Metering and billing

- **Storage** in logical GB-months: dimension × 4 bytes plus metadata per row, however it is compressed. An hourly job sums live rows from each manifest, and the month is the hourly sum ÷ 730.
- **Write units:** one per started kilobyte, so a 1,536-dimension vector with 256 bytes of metadata (6,400 bytes) is 7 units.
- **Read units:** one per query plus one per 10,000 vectors visited or scanned. An HNSW query touching about 3,000 vectors costs 1.3, and an exact scan of 40,000 filtered vectors costs 5, so expensive queries show up on the bill of whoever sends them.

Nodes write a usage record per request to a stream, and an aggregator rolls them up per tenant and hour, deduplicating by request ID, as in the [inference platform](/learn/design-inference-platform#metering-and-billing). Warm memory is the hard part to price: the 1-million-vector namespace costs $0.15 cold and $11.65 warm, yet storage bills by logical size, so the storage price must cover the blended cost, and pinning a namespace in memory is sold separately.

## Trade-offs to discuss

- **Object storage as the source of truth vs replicated local disks.** Disposable nodes, near-free cold data and cheap backups, against slow cold queries. Local disks give steady latency and pay RAM or NVMe for data nobody reads.
- **A replicated log vs writing straight to object storage.** The log acknowledges in milliseconds. Direct writes remove a cluster but make each acknowledgement wait tens to hundreds of milliseconds for an object write.
- **HNSW vs clusters in a segment.** HNSW gives the best warm latency and filtering, and is costly to build and hurt by deletes. Cluster layouts build cheaply and serve cold reads, and need more probes for the same recall. This design stores both.
- **Few large shards vs many small ones.** Large shards cut fan-out and tail latency. Small shards move, rebuild and balance faster.
- **Opt-in read-your-writes.** Making every query wait for the newest write slows all queries to help the few that just wrote.

## Check yourself

<details>
<summary>Larkfield, from the RAG design, stores 46.8 million chunks of 1,024 dimensions and queries them 10 times a second all day. At this chapter's assumed prices, what does keeping it warm cost compared with leaving it cold?</summary>

Warm, its int8 HNSW is 46.8 million × (1,024 + 128) = 53.9 GB, or 107.8 GB with two replicas, about $377 a month at $3.50 per GB. Cold, its 46.8 million × (4,096 + 256) bytes = 203.7 GB costs about $4.68 in object storage. At 10 queries a second it never goes cold, so $377 is the real cost.

</details>

<details>
<summary>A customer has 80 million vectors of 1,536 dimensions. How much int8 HNSW memory does one replica need, how is it sharded, and how often does a query meet a slow shard?</summary>

80,000,000 × 1,664 bytes = 133.1 GB. Over the 25-million cap, so 4 shards of 20 million (33.3 GB each), and every query asks all 4. The chance at least one exceeds its own p99 is 1 − 0.99⁴ ≈ 3.9%.

</details>

<details>
<summary>A customer upserts an article and queries for it 200 ms later, and about one time in five it is missing. Why, and what should they change?</summary>

The query reached a replica that hadn't applied that log position yet. Passing the upsert's write token as `after_write` routes the query to a replica that has, or waits for one.

</details>

<details>
<summary>A 10-million-vector segment has had 35% of its rows deleted, and filtered recall slipped from 0.96 to 0.91. Why, and what is the fix?</summary>

Deleted nodes remain in the graph as paths but can't be returned, so the walk needs more visits to find k live results and some regions are reachable only through dead nodes. Rewrite the segment without them. The 20% threshold should have done so already, so check the builder backlog.

</details>

<details>
<summary>A filter matches 0.4% of a 10-million-vector segment. A teammate proposes post-filtering the top 100 HNSW results. What happens, and what does the design do?</summary>

About 100 × 0.004 = 0.4 results survive on average, so most queries return nothing. The bitmap shows 40,000 matches, under the 50,000 limit, so the node scans them exactly: 61 MB of int8, about 6 ms, recall 1.0.

</details>

<details>
<summary>A huge index has 64 shards, each with a 20 ms p99, yet the query p99 is far above 20 ms. Explain, and give two fixes.</summary>

1 − 0.99⁶⁴ ≈ 47% of queries wait on at least one shard beyond its p99, so the query p99 is set by the shards' 99.98th percentile. Use fewer, larger shards and hedge to a second replica after a shard's p95.

</details>

## Further reading

- [Malkov and Yashunin, the HNSW paper (arXiv 1603.09320)](https://arxiv.org/abs/1603.09320): the graph index for warm segments.
- [Subramanya et al., DiskANN (NeurIPS 2019)](https://papers.nips.cc/paper/2019/hash/09853c7fb1d3f8ee67a61b6bf4a7f8e6-Abstract.html): an SSD-resident graph with compressed vectors in RAM.
- [Singh et al., "FreshDiskANN" (arXiv 2105.09613)](https://arxiv.org/abs/2105.09613): a graph index that takes inserts and deletes without full rebuilds.
- [Jégou, Douze and Schmid, "Product quantization for nearest neighbor search" (IEEE TPAMI, 2011)](https://hal.univ-grenoble-alpes.fr/inria-00514462v1): PQ codes and the inverted-file variant.
- [Douze et al., "The Faiss library" (arXiv 2401.08281)](https://arxiv.org/abs/2401.08281) and the [FAISS index guidelines](https://github.com/facebookresearch/faiss/wiki/Guidelines-to-choose-an-index): index families and memory per vector.
- [O'Neil et al., "The Log-Structured Merge-Tree" (1996)](https://www.cs.umb.edu/~poneil/lsmtree.pdf): the structure the segments follow.
- [Dean and Barroso, "The Tail at Scale" (CACM, 2013)](https://www.barroso.org/publications/TheTailAtScale.pdf): fan-out latency and hedged requests.
- [Milvus architecture overview](https://milvus.io/docs/architecture_overview.md): disaggregated storage and compute, a write-ahead log, sealed segments and object storage.
- [Qdrant, distributed deployment](https://qdrant.tech/documentation/scaling/distributed_deployment/) and [indexing](https://qdrant.tech/documentation/concepts/indexing/): shards, replicas, and filter cardinality for query planning.
