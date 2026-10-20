# Embeddings and vector search

A keyword search finds the documents that contain the query's words, so a search for "get my money back" misses a page titled "Refund policy" unless that page also says "money back". Vector search matches meaning instead. An embedding model turns each text into a list of numbers, called a vector, so that similar meanings get vectors that point in similar directions. The query becomes a vector too, and the system looks for the stored vectors nearest to it.

This chapter covers how vectors are compared, why exact search slows down at scale, the three families of index that trade a little accuracy for speed, how filters and keyword search combine with vectors, where vectors can live, and why changing the embedding model means rebuilding the index. One running size appears throughout: 100 million text chunks, each embedded as a 768-number vector. Keyword search and BM25 ranking are covered in the [search engine design](/learn/design-search-engine). The [retrieval-augmented generation chapter](/learn/rag) shows how retrieved text reaches a language model.

## What an embedding is

Take three short texts and a toy model that gives each one three numbers. The numbers are invented for illustration:

- "get my money back" → [0.9, 0.1, 0.1]
- "refund policy" → [0.8, 0.2, 0.0]
- "parcel tracking" → [0.1, 0.1, 0.9]

The list of numbers is a **vector**, and its length (three here) is its **dimension**. An **embedding** is the vector a model computes for an input. The model is trained so that similar meanings get similar vectors. The first two vectors point in nearly the same direction, so their meanings are close. The third points elsewhere.

```diagram
title: One model embeds documents and queries, and the index holds the document vectors
[doc] Document chunk\n"Refunds take\n5 days" @ 0,0
[model:note] Embedding model\nshared by both @ 1,0
[index:store] Vector index\nall doc vectors @ 2,0
[q] Query\n"get my money\nback" @ 0,2
[res] Top k results\nnearest vectors @ 2,2
doc -> model : embed
model -> index : store vectors
q -> model : embed query
q -> index : search
index -> res : nearest
```

Real models use hundreds or thousands of numbers. The sentence model `all-mpnet-base-v2` maps each sentence or paragraph to 768 numbers. It averages its token vectors into one (mean pooling), and by default it reads at most 384 word pieces, according to its model card.

Each number is a **float32**, a 32-bit floating-point value of 4 bytes, so one 768-dimension vector takes 768 × 4 = 3,072 bytes. You compute embeddings twice, once for each stored item and once for each query, and both must come from the same model. The embedding model is a neural network, separate from the large language model that writes answers.

Embeddings also make comparison cheap. The Sentence-BERT paper reports about 50 million inference computations (roughly 65 hours) to find the most similar pair among 10,000 sentences with BERT, which reads every pair. With Sentence-BERT, which embeds each sentence once, the same search takes about 5 seconds.

## Measuring similarity

Three measures are common. For vectors a and b with n numbers each:

- The **dot product** multiplies matching numbers and adds the results: a1 × b1 + a2 × b2 + … + an × bn.
- **Cosine similarity** divides the dot product by both lengths: dot(a, b) ÷ (length(a) × length(b)). It compares direction and ignores length. Values run from −1 (opposite) to 1 (same direction).
- **Euclidean distance** is the straight-line distance: the square root of (a1 − b1)² + … + (an − bn)². Smaller means closer.

Use the measure the model was trained for. The HNSW paper used cosine similarity for GloVe word vectors, which the authors call "equivalent to L2 after vector normalization."

**Normalizing** divides each vector by its length, so every vector has length 1. Then the dot product equals the cosine similarity, and the squared Euclidean distance equals 2 − 2 × cosine. All three rank neighbors in the same order. Many systems normalize once, when they write a vector, and use the cheaper dot product at query time. pgvector's SQL follows the same pattern: `<->` is Euclidean distance, `<=>` is cosine distance (one minus cosine similarity), and `<#>` is the negative inner product, negated so that smaller always means closer.

The sketch below computes the measures on the toy vectors and checks the unit-vector identities.

```python
import math


def dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def length(a: list[float]) -> float:
    return math.sqrt(dot(a, a))


def normalize(a: list[float]) -> list[float]:
    n = length(a)
    return [x / n for x in a]


def cosine(a: list[float], b: list[float]) -> float:
    return dot(a, b) / (length(a) * length(b))


def euclidean(a: list[float], b: list[float]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


# Toy 3-dimension embeddings. The numbers are invented for illustration.
query = [0.9, 0.1, 0.1]            # "get my money back"
refund_policy = [0.8, 0.2, 0.0]    # "refund policy"
parcel_tracking = [0.1, 0.1, 0.9]  # "parcel tracking"

print(round(cosine(query, refund_policy), 3))    # 0.985
print(round(cosine(query, parcel_tracking), 3))  # 0.229

# For unit vectors, dot = cosine and squared Euclidean distance = 2 - 2 * cosine.
a, b = normalize(query), normalize(refund_policy)
print(round(dot(a, b), 6), round(cosine(query, refund_policy), 6))  # 0.985005 0.985005
print(round(euclidean(a, b) ** 2, 6), round(2 - 2 * dot(a, b), 6))  # 0.029991 0.029991
```

## Exact search

Exact search, or brute force, compares the query with every stored vector and keeps the k best. Here k is how many results you want, and the k best are the **top-k**. For one query over 100 million vectors of 768 dimensions:

- One dot product takes 768 multiplications and 767 additions. Counting each multiply and add as one floating-point operation (FLOP), the query does 2 × 768 × 100,000,000 = 153,600,000,000 FLOPs, about 154 GFLOP.
- Every vector is read from memory once: 100,000,000 × 3,072 bytes = 307,200,000,000 bytes, or 307.2 GB (about 286 GiB).

An H100 is a data-center GPU (graphics processing unit). As of October 2026, NVIDIA's specification page lists the SXM version with 80 GB of memory, 3.35 TB/s of memory bandwidth, and 67 teraFLOPS of FP32 arithmetic. The memory and bandwidth match [numbers to know](/learn/numbers-to-know#numbers-for-ai-systems). FP32 is the right rate here, because these vectors are stored as 32-bit numbers. The raw vectors need at least four cards (307.2 ÷ 80 = 3.84, rounded up).

The query does 154 GFLOP for every 307.2 GB it reads, which is 0.5 FLOP per byte. An H100 balances arithmetic against bandwidth at 67 ÷ 3.35 = 20 FLOPs per byte, so this query is limited by memory. Reading everything once takes 307.2 ÷ 3,350 ≈ 92 ms, while the arithmetic takes about 2.3 ms. Even with four cards reading in parallel, the floor is about 23 ms per query. For the background, see [GPUs and accelerators](/learn/gpus-for-ai#compute-versus-memory-bandwidth).

Batching helps. If 40 queries share one pass over the vectors, each byte supports 40 × 0.5 = 20 FLOPs, the balance point, and arithmetic becomes the limit. Exact search therefore suits offline batches more than one query at a time over a large collection. It also has perfect recall by definition, so it serves as ground truth for approximate indexes.

The sketch below runs exact top-k on 10,000 random 32-dimension vectors. Then it pretends that an index saw only half of them.

```python
import heapq
import math
import random


def dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def top_k(query: list[float], vectors: list[list[float]], k: int) -> list[tuple[float, int]]:
    """Exact search. Vectors must be unit length, so the dot product is the cosine."""
    scored = ((dot(query, v), i) for i, v in enumerate(vectors))
    return heapq.nlargest(k, scored)


def recall_at_k(approx_ids: list[int], exact_ids: list[int]) -> float:
    return len(set(approx_ids) & set(exact_ids)) / len(exact_ids)


def random_unit(dims: int) -> list[float]:
    v = [random.gauss(0, 1) for _ in range(dims)]
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v]


random.seed(7)
dims, n = 32, 10_000
vectors = [random_unit(dims) for _ in range(n)]
query = random_unit(dims)

exact = top_k(query, vectors, 3)
print([(i, round(s, 3)) for s, i in exact])  # [(4106, 0.605), (9519, 0.534), (3730, 0.52)]
print("multiply-adds per query:", n * dims)  # 320000

# A pretend approximate search that only looks at the first 5,000 vectors.
half = top_k(query, vectors[:5000], 3)
print("recall@3:", round(recall_at_k([i for _, i in half], [i for _, i in exact]), 3))  # 0.667
```

## Approximate nearest neighbor indexes

Exact search reads everything. An **approximate nearest neighbor (ANN) index** is built ahead of time so that a query skips most vectors and may miss some true neighbors. Three families dominate:

- **Graphs** link each vector to nearby vectors and walk the links. HNSW is the best-known example, and DiskANN uses a graph too.
- **Clusters** group vectors around centroids (cluster centers) and search only the nearest groups. IVF does this.
- **Compression** stores a short code for each vector, so scans read fewer bytes. Product quantization does this.

pgvector offers HNSW and IVFFlat indexes. FAISS, a library, describes itself as "dedicated to vector similarity search, a core functionality of vector databases."

### HNSW

HNSW stands for Hierarchical Navigable Small World, from Malkov and Yashunin's 2016 arXiv preprint. The index is a stack of graphs. Every vector is a node on layer 0, and a random subset also appears on higher layers, which have fewer nodes and longer links. Each node's top layer comes from an exponentially decaying distribution scaled by a constant mL. The paper suggests mL = 1/ln(M), which gives each node about a 1-in-M chance of reaching layer 1 or higher. That matches the skip-list parameter p = 1/M that the paper cites.

A search starts at an entry point on the top layer and moves greedily toward the query, dropping a layer whenever no neighbor is closer. On layer 0 it keeps a list of the ef best candidates and expands them until the list stops improving. A larger ef gives better recall and more work. pgvector's defaults are 16 links per node and layer (m), an ef_construction of 64 while building, and hnsw.ef_search = 40 at query time. The authors argue that search cost grows logarithmically with the number of vectors, and the index accepts inserts one at a time.

```diagram
title: One search: step along a layer, then drop to the layer below
[e:store] Entry point\nlayer 2 @ 0,0
[f2] Node F\nlayer 2 @ 2,0
[f1] Node F\nlayer 1 @ 2,1
[k1] Node K\nlayer 1 @ 4,1
[k0] Node K\nlayer 0 @ 4,2
e -> f2 : greedy hop
f2 -> f1 : drop a layer
f1 -> k1 : greedy hop
k1 -> k0 : drop a layer
```

Memory is the price. The paper notes that memory use is proportional to M. FAISS's guidelines give the index size as d × 4 + M × 2 × 4 bytes per vector, where d is the dimension. For 768 dimensions and M = 16, that is 768 × 4 + 16 × 2 × 4 = 3,200 bytes per vector, or 320 GB for 100 million vectors. The index needs at least four H100s just to hold it. The same guidelines say that FAISS's HNSW index "does not support removing vectors from the index," which matters when documents change often.

### IVF

IVF stands for inverted file. A clustering step groups the vectors around nlist centroids, and each vector is stored in the list of its nearest centroid. A query compares itself with the centroids, then scans only the nprobe nearest lists. The PQ paper pairs this structure with compression and calls the result IVFADC.

Clustering needs training data. For datasets under one million vectors, FAISS's guidelines suggest 4√N to 16√N centroids, trained on 30 to 256 vectors per centroid.

At 100 million rows, pgvector's rule gives √100,000,000 = 10,000 lists, so each list holds about 10,000 vectors. Its suggested starting point of √lists = 100 probes scans 100 × 10,000 = 1,000,000 vectors, 1% of the table, about 3.07 GB of raw data. The centroid check costs 2 × 768 × 10,000 = 15,360,000 FLOPs. Recall depends on nprobe. A neighbor near a cluster boundary can sit in a list the query never probes, so a larger nprobe finds more neighbors and does more work.

```diagram
title: A query scans only the lists whose centroids are nearest
[q] Query @ 0,1
[c:note] Compare with\n10,000 centroids @ 1,1
[l1:store] List 17\nscanned @ 2,0
[l2:store] List 402\nscanned @ 2,1
[l3:store] Other lists\nskipped @ 2,2
[top] Top k @ 3,1
q -> c
c -> l1 : probe
c -> l2 : probe
c --> l3 : not probed
l1 -> top
l2 -> top
```

### Product quantization

Product quantization (PQ) shrinks each vector to a short code. Split a 768-number vector into m sub-vectors. For each sub-vector position, learn a codebook of k* centroids from data, and replace each sub-vector with the index of its nearest centroid. With k* = 256, each index fits in one byte, so the code is m bytes.

The PQ paper's example uses 128-dimension SIFT image descriptors with m = 8 and k* = 256, which gives 64-bit codes. The paper says that "using k* = 256 and m = 8 is often a reasonable choice." For 768 dimensions, m = 64 gives 12 numbers per sub-vector and 64-byte codes. FAISS's guidelines describe its PQ codes as "M-byte codes," with M "typically <= 64."

For 100 million vectors, the codes take 100,000,000 × 64 bytes = 6.4 GB. That is 48 times smaller than the raw 307.2 GB (3,072 ÷ 64 = 48). The codebooks take 64 × 256 × 12 × 4 = 786,432 bytes, about 0.8 MB.

Search uses **asymmetric distance computation (ADC)**. The query stays uncompressed, and the stored vectors are compressed. For each query, the search computes the distance from each of the 64 query sub-vectors to its 256 centroids. That table holds 16,384 values, or 65,536 bytes. Scoring a stored code adds 64 table entries, one per sub-vector: 64 lookups and 63 additions, against 1,535 operations for a raw 768-dimension dot product. The PQ paper's abstract says the asymmetric version "increases precision, as it computes the approximate distance between a vector and a code."

The cost is accuracy. PQ is lossy, so its approximate distances can reorder neighbors. A full scan of the 6.4 GB reads for at least 1.9 ms on one H100's bandwidth. That is a floor, not a benchmark. In practice PQ is paired with an inverted file, so a query scans few lists, or with reranking that rescores the best candidates from full-precision vectors.

### DiskANN

DiskANN, from Subramanya and colleagues at NeurIPS 2019, builds a graph called Vamana and keeps most of the index on SSD. The paper says: "The graph index along with the full-precision vectors of the dataset are stored on the disk, while compressed vectors are cached in memory." A query walks the graph using the compressed vectors in RAM, then reranks the final candidates with full-precision vectors from disk, which corrects the error that PQ introduces.

The paper reports a billion vectors (SIFT1B) on a workstation with 64 GB of RAM and an inexpensive SSD, more than 5,000 queries a second, under 3 ms mean latency, and 95%+ 1-recall@1 on a 16-core machine. In the same test, FAISS and IVFOADC+G+P plateau near 50% 1-recall@1. Your own numbers will differ. For our 100 million vectors, 64-byte codes take 6.4 GB of RAM, while the 307.2 GB of full vectors and the graph stay on SSD.

## Recall, speed and memory

**Recall@k** is the share of the exact top-k that the approximate search also returns. If exact search returns ten vectors and the index returns seven of them, recall@10 is 0.7. Measure it on sample queries, with exact search as the ground truth.

Each index sits at a different point in a **trade-off triangle** of **recall**, **speed** (latency and throughput), and **memory** (including build time). Raising recall costs speed or memory. The knobs are ef_search for HNSW, nprobe for IVF, the bytes in a PQ code, and the number of candidates you rerank. Measure recall and latency at a few settings, then choose the cheapest one that meets your target.

The table uses the running example: 100 million vectors of 768 dimensions. These are sizes from the sections above, not benchmarks.

| Index | Memory the search needs | Work per query | Recall |
|---|---|---|---|
| Exact (brute force) | 307.2 GB of raw vectors | every vector | 1.0 by definition |
| IVF-Flat, 10,000 lists, 100 probes | 307.2 GB plus 30.7 MB of centroids | about 1% of vectors | set by nprobe |
| HNSW, M = 16 | about 320 GB of vectors and links | a graph walk | set by ef_search |
| PQ, 64-byte codes | 6.4 GB of codes | every code, 48 times fewer bytes | lower; reranking helps |
| DiskANN style | 6.4 GB of codes in RAM; vectors and graph on SSD | a graph walk in RAM, then SSD reads | high in the paper's test |

Exact search and HNSW need hundreds of gigabytes, so compressed codes are the first option to test on a single machine.

## Filtering

Most queries carry a filter, such as "this team's documents," "in stock," or "published after 2025." There are two ways to combine a filter with vector search.

**Post-filtering** runs the vector search first, then drops the candidates that fail the filter. It works when most rows pass, and it fails when the filter is selective. pgvector's README gives an example: a filter that matches 10% of rows, with HNSW's default ef_search of 40, leaves about 4 matches on average. Elastic's documentation warns that post-filtering can return fewer than k results, even when enough documents match.

**Pre-filtering** restricts the search before it runs. If the matching set is small, scan it exactly. A catalog of 10 million products with 1% matching has 100,000 vectors, or 100,000 × 384 × 4 = 153.6 MB per query at 384 dimensions. Otherwise, apply the filter inside the approximate search, so the search keeps going until it finds k matches. Elastic applies its kNN filter during the search, and it warns that filters can slow HNSW searches. pgvector's iterative index scans, from version 0.8.0, keep scanning until enough rows pass, up to a limit set by hnsw.max_scan_tuples, which defaults to 20,000.

Measure how selective your common filters are. Scan small matching sets exactly, and post-filter with a larger candidate pool when most rows match. Test recall on filtered queries, since a test on unfiltered queries can hide the problem. Partitioning helps as well: Qdrant sends an operation without a shard key to every shard, so a query that names its shard key reads fewer of them.

## Hybrid search

Vector search can miss exact strings such as an error code, a part number, or a rare name. BM25 finds those terms but misses synonyms, so most production search uses both. The [search engine design](/learn/design-search-engine#text-relevance-from-tf-idf-to-bm25) explains how BM25 scores documents.

BM25 scores and cosine scores live on different scales, so a weighted sum needs tuning for each collection. **Reciprocal rank fusion (RRF)** uses only ranks instead. Each ranked list adds 1 ÷ (k + rank) for every document it contains, with rank starting at 1, and the contributions are summed. Cormack and colleagues (SIGIR 2009) fixed k at 60 in a pilot and did not change it afterward. They report that RRF "consistently yields better results than any individual system" in their TREC experiments, and that k "mitigates the impact of high rankings by outlier systems." Elastic's RRF retriever uses the same formula, with a rank_constant default of 60.

```diagram
title: Hybrid search fuses a keyword ranking and a vector ranking
[q] Query @ 0,1
[kw:store] Keyword index\nBM25 ranking @ 1,0
[vec:store] Vector index\nembedding ranking @ 1,2
[rrf] Reciprocal rank\nfusion (RRF) @ 2,1
[out] Results @ 3,1
q -> kw : keywords
q -> vec : embedding
kw -> rrf : ranked list
vec -> rrf : ranked list
rrf -> out : top k
```

The sketch applies RRF to two rankings. BM25 ranks doc7 first and doc2 second, and vector search ranks doc2 first and doc7 third. doc2 scores 1/62 + 1/61 = 0.03252, and doc7 scores 1/61 + 1/63 = 0.03227. doc2 wins narrowly because it sits near the top of both lists.

```python
def rrf(rankings: list[list[str]], k: int = 60) -> list[tuple[str, float]]:
    """Reciprocal rank fusion: each list adds 1 / (k + rank) to every document it holds."""
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda item: item[1], reverse=True)


bm25 = ["doc7", "doc2", "doc9", "doc4"]     # keyword ranking, best first
vector = ["doc2", "doc5", "doc7", "doc1"]  # embedding ranking, best first

for doc_id, score in rrf([bm25, vector]):
    print(doc_id, round(score, 5))
# doc2 0.03252, doc7 0.03227, doc5 0.01613, doc9 0.01587, doc4 0.01562, doc1 0.01562

# A document found by one retriever only still gets that retriever's share.
for doc_id, score in rrf([["doc8"]]):
    print(doc_id, round(score, 5))  # doc8 0.01639
```

## Where to store vectors

Three kinds of system store vectors in production. Your existing stack usually decides between them.

**pgvector inside PostgreSQL.** Vectors sit in a column beside the rest of the row, filters are ordinary SQL, and replication and point-in-time recovery work through the write-ahead log. As of October 2026, the README allows up to 16,000 dimensions for a vector column, but indexes only up to 2,000 dimensions for the `vector` type (4,000 for `halfvec`). A 768-dimension column can be indexed. HNSW is stronger on speed and recall, but it is heavier on memory and slower to build than IVFFlat. pgvector is a sound first choice when the vectors belong with rows you already keep in Postgres.

**Dedicated vector databases**, such as Qdrant. A collection is split into shards spread across nodes, each shard can be replicated, and a search fans out to the relevant shards and merges their results. You gain scale and redundancy. The costs are another system to run, a second copy of the data to keep in step with your primary database, and joins done in application code.

**Search engines with vector support**, such as Elasticsearch. Elasticsearch stores each segment's dense vectors as an HNSW graph, and one request can combine a kNN clause with a keyword query. This fits a team that already runs search and wants keyword and vector results in one ranking.

FAISS is a library. It gives you the indexes, and you build persistence, replication, filters and updates around them. Choose by what you already run.

## Changing the embedding model

Vectors from two models are not comparable. Each model arranges its space differently, so a distance between a query vector from one model and a stored vector from another means nothing, and matching dimension counts do not help. As of October 2026, MongoDB's guide to migrating its Voyage AI embeddings says that comparing new query embeddings with older stored embeddings "degrades retrieval quality." The same guide recommends regenerating the corpus even between models that can be compared.

The self-managed migration has four steps:

1. Re-embed the whole corpus into a new field, leaving the old field and index in place.
2. Build a new index on the new field with the new dimension count, and wait until it is ready.
3. Switch queries to the new model and index, and compare results on a test set.
4. Delete the old index and field once the new one checks out.

Re-embedding dominates the cost. Assume a new model embeds 1,000 chunks a second on one GPU, an assumption to replace with your own measurement. Then 100,000,000 chunks take 100,000,000 ÷ 1,000 = 100,000 GPU-seconds, about 27.8 GPU-hours, or about 1.4 hours on 20 GPUs. MongoDB notes that a model change adds embedding costs, and it warns that re-embedding a large corpus can exhaust rate limits. Prices vary by provider, so use the current rate card.

Plan ahead. Store the model name and version with each vector, so a mixed index is visible. Keep chunking and preprocessing identical on the write and query paths. Keep the old index serving until the new one is verified.

## Check yourself

<details>
<summary>A team stores 50 million chunks as 1,024-number float32 vectors. How much raw vector data is that, and how many 80 GB H100s would hold it?</summary>

50,000,000 × 1,024 × 4 bytes = 204,800,000,000 bytes, or 204.8 GB. 204.8 ÷ 80 = 2.56, so three H100s, before any index.

</details>

<details>
<summary>An exact search scans 10 million vectors of 384 float32 dimensions on one H100 with 3.35 TB/s of bandwidth. Estimate the memory time for one query, and say whether memory or arithmetic dominates.</summary>

10,000,000 × 384 × 4 = 15.36 GB, and 15.36 ÷ 3,350 ≈ 4.6 ms. The arithmetic is 2 × 384 × 10,000,000 = 7.68 GFLOP, which takes about 0.1 ms at 67 teraFLOPS. Memory dominates by roughly 40 times, the same ratio as in the 100 million case.

</details>

<details>
<summary>A product catalog of 10 million items uses HNSW with ef_search 40 and post-filtering. The filter "in stock, size M" matches 1% of items. What goes wrong, and what would you change?</summary>

Post-filtering keeps only the matching candidates among the roughly 40 the search returns. At 1%, 40 × 0.01 = 0.4 matches survive on average, so most queries return nothing useful. Pre-filter instead. The 100,000 matching items can be scanned exactly, about 154 MB of 384-dimension float32 vectors per query, or you can use a filter-aware approximate search and test recall on filtered queries.

</details>

<details>
<summary>Two weeks after you switch embedding models, search quality collapses, even though the new query embeddings look fine. The index still holds vectors from the old model. What happened, and how do you fix it?</summary>

The query vectors and the stored vectors come from different models, so their distances mean nothing. Re-embed the whole corpus into a new field, build a new index, verify queries against it, switch over, and then delete the old index and field.

</details>

<details>
<summary>You must search 100 million 768-dimension vectors on a machine with 64 GB of RAM and an SSD. Compare HNSW (M = 16) with a DiskANN-style design. Which would you try first?</summary>

HNSW needs about 320 GB for the vectors and links, far beyond 64 GB. A DiskANN-style design keeps 6.4 GB of 64-byte PQ codes in RAM and leaves the full vectors and the graph on SSD. Try the DiskANN-style design first, and measure recall@10 on your own queries. The paper's 95% figure is for SIFT1B on its own setup.

</details>

<details>
<summary>Keyword search ranks document A first and document B second. Vector search ranks B first and A fourth. Using RRF with k = 60, which document ranks higher, and by how much?</summary>

A scores 1/61 + 1/64 = 0.032018, and B scores 1/62 + 1/61 = 0.032522. B ranks higher, by about 0.0005. B wins because it sits near the top of both lists, while A is top in only one.

</details>

<details>
<summary>An approximate index returns 7 of the exact top 10 for a typical query. What is recall@10, which knob do you turn first, and what does it cost?</summary>

Recall@10 is 7 ÷ 10 = 0.7. For HNSW, raise ef_search (pgvector's default is 40). For IVF, raise nprobe. Each increase examines more vectors, so latency rises and throughput falls. Measure recall again after each change.

</details>

## Further reading

- [Malkov and Yashunin, the HNSW paper (arXiv 1603.09320)](https://arxiv.org/abs/1603.09320): the layers, the parameters M, mL and ef, and the complexity claim.
- [Jégou, Douze and Schmid, "Product quantization for nearest neighbor search" (IEEE TPAMI, 2011)](https://hal.univ-grenoble-alpes.fr/inria-00514462v1): sub-vector codes, asymmetric distance, and the inverted-file variant.
- [Subramanya et al., DiskANN (NeurIPS 2019)](https://papers.nips.cc/paper/2019/hash/09853c7fb1d3f8ee67a61b6bf4a7f8e6-Abstract.html): the SSD design and the headline numbers. The [full PDF](https://proceedings.neurips.cc/paper/2019/file/09853c7fb1d3f8ee67a61b6bf4a7f8e6-Paper.pdf) explains the reranking step.
- [Douze et al., "The Faiss library" (arXiv 2401.08281, 2024)](https://arxiv.org/abs/2401.08281): what FAISS is for.
- [FAISS wiki, "Guidelines to choose an index"](https://github.com/facebookresearch/faiss/wiki/Guidelines-to-choose-an-index): cluster counts, training sizes, and memory per vector for HNSW, IVF and PQ.
- [pgvector README](https://github.com/pgvector/pgvector): distance operators, dimension limits, and index parameters.
- [Cormack, Clarke and Büttcher, "Reciprocal rank fusion outperforms Condorcet and individual rank learning methods" (SIGIR 2009)](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf): the RRF formula and the choice of k = 60.
- [Reimers and Gurevych, "Sentence-BERT" (arXiv 1908.10084)](https://arxiv.org/abs/1908.10084): why embeddings make pairwise comparison cheap.
- [sentence-transformers/all-mpnet-base-v2 model card](https://huggingface.co/sentence-transformers/all-mpnet-base-v2): a real 768-dimension embedding model, with its pooling and input limit.
- [Elasticsearch kNN search, 8.5 docs](https://www.elastic.co/guide/en/elasticsearch/reference/8.5/knn-search.html): filters in approximate search and HNSW storage. Elastic no longer maintains this version.
- [Elasticsearch RRF reference, 8.19](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/rrf.html): the RRF formula and the rank_constant default of 60.
- [Qdrant, distributed deployment](https://qdrant.tech/documentation/scaling/distributed_deployment/): shards, replicas, and search fan-out.
- [MongoDB, migrating Voyage AI embedding models](https://www.mongodb.com/docs/voyageai/tutorials/migrate-embedding-model/): why models cannot be mixed, and the re-embedding steps.
- [NVIDIA H100 specifications](https://www.nvidia.com/en-us/data-center/h100/): the memory and FP32 figures used here.
