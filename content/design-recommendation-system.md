# Design a personalized recommendation system

Open the home screen of YouTube, Netflix, Spotify or TikTok and you get a ranked list built for you, from a catalog of hundreds of millions of items, using your long-term taste, what you tapped in the last few minutes and the time of day. It has to come back in about a tenth of a second.

In an interview it's tempting to treat this as a black box: "train a model on user data and predict what they like". The trouble is the arithmetic. A good ranking model is expensive per item, and you can't run it on a billion items for every request. The design question is how to get from a billion items to twenty without ever doing a billion expensive things.

Production systems answer it with a funnel of stages, each cheaper per item than the next: **candidate retrieval** (embeddings and approximate nearest neighbor search, plus a few simpler sources), **ranking** (a heavier multi-task model fed from a feature store), and **re-ranking** (diversity rules and exploration for new items). This chapter walks through each stage and the infrastructure behind it. It builds on [database internals](/learn/database-internals), [caching](/learn/cache) and [event streaming](/learn/event-streaming).

## Requirements and scale

Agree on scope first. A reasonable set:

- **Functional:** `GET /api/v1/feed` returns the top 20 items for the user who asked. The feed reacts to what the user does in the current session: after two cooking videos, cooking should show up within seconds, not tomorrow. It mixes familiar interests with new or trending items, so new uploads get a chance and the feed doesn't collapse onto one topic. It balances several signals (clicks, watch time, likes, shares), not one.
- **Non-functional:** p99 latency under 100 ms for the feed request; 99.99% availability on the serving path (a degraded feed beats an error page); training and indexing can lag by hours.
- **Out of scope for now:** search, ads ranking, notifications.

Then size it. These are assumptions for a large consumer app, not figures from any real product:

- 500 million daily active users, each refreshing the feed 10 times a day.
- Requests: 500M × 10 = 5 billion a day. 5 × 10⁹ ÷ 86,400 s ≈ 58,000 a second on average. With a peak of about 2× average, plan for roughly **116,000 feed requests a second**.
- Catalog: 1 billion items. With one 256-dimension float32 embedding per item, that's 10⁹ × 256 × 4 B ≈ **1 TB of vectors**, before any index overhead. That does not fit on one machine, so the vector index is sharded or compressed (more on this in stage 1).
- Ranking load: if the ranker scores 1,000 candidates per request, that's 116,000 × 1,000 ≈ **116 million model evaluations a second** at peak. That number sizes the ranking fleet, and it's why the ranker never sees more than about a thousand items.

A latency budget for the 100 ms keeps each stage honest. These numbers are a starting point to negotiate, not measurements:

| Step | Budget |
|---|---|
| Gateway and auth | 5 ms |
| Stage 1: candidate retrieval | 25 ms |
| Feature lookup (feature store) | 10 ms |
| Stage 2: ranking | 35 ms |
| Stage 3: re-ranking | 10 ms |
| Network and serialization | 15 ms |
| **Total** | **100 ms** |

See [estimation](/learn/estimation) for more on this kind of arithmetic.

## The three-stage funnel

Scoring a billion items with a deep model on every request doesn't fit in 100 ms on any realistic amount of hardware. So serving is split into stages, each working on fewer items with a more expensive model. YouTube's 2016 paper describes the two-stage version (candidate generation, then ranking), and most large feeds add a third stage for diversity and business rules.

```diagram
title: Each stage works on fewer items with a costlier model
[catalog:store] Catalog\n1B items @ 0,0
[s1] 1. Retrieval\n~1,000 items @ 1,0
[s2] 2. Ranking\n~100 items @ 2,0
[s3] 3. Re-ranking\n20 items @ 3,0
catalog -> s1 : ANN
s1 -> s2 : score
s2 -> s3 : diversify
```

- **Retrieval** must be cheap per item and only needs good recall: it's fine if a few of its 1,000 picks are poor, as long as the good ones are in there.
- **Ranking** needs precision. It can afford hundreds of features per item because it only sees about 1,000 items.
- **Re-ranking** works on the ranked list as a whole: it spreads out topics and creators, mixes in exploration items, and applies rules (already watched, blocked creators, policy filters).

## End-to-end architecture

```diagram
title: Serving path for one feed request
[client:client] Client app @ 0,1
[orch] Feed service @ 1,1
[sess:store] Session store\n(recent clicks) @ 0,2
[ret] Candidate\nretrieval @ 2,0
[vdb:store] Vector index\n(sharded ANN) @ 3,0
[rank] Ranker fleet @ 2,1
[fstore:store] Online\nfeature store @ 3,1
[rerank] Re-ranker @ 2,2
client <-> orch : GET /feed
orch -> sess : recent clicks
orch -> ret : 1. retrieve
ret -> vdb : ANN query
orch -> rank : 2. rank
rank -> fstore : features
orch -> rerank : 3. re-rank
```

An [interactive version of this diagram](/diagrams/recommendation-system.html) lets you pan, zoom and trace the request paths.

The path of one request:

1. The client calls `GET /feed`. The feed service (an orchestrator with no state of its own) loads the user's last few in-session interactions from a fast session store, usually Redis.
2. It calls candidate retrieval with the user's ID and those recent clicks. Retrieval computes a user vector, queries the vector index, merges results from the other retrieval sources, filters out items the user has already seen, and returns about 1,000 item IDs.
3. It sends those candidates to the ranker. The ranker fetches features for the user and every candidate from the online feature store, scores each candidate, and returns the list sorted by score.
4. It passes the top 100 to the re-ranker, which builds the final 20 with diversity and exploration rules, and returns them to the client.

Each stage has a fallback. If retrieval times out, serve a cached copy of the user's last feed or a popular-items list for their region. If the ranker is overloaded, skip it and order by retrieval score. A slightly worse feed is far better than an error, which is how the availability target is met.

## Stage 1: candidate retrieval

Retrieval cuts 1 billion items to about 1,000 in roughly 25 ms. The main tool is an embedding model plus approximate nearest neighbor search.

### From matrix factorization to two towers

The classic approach is **collaborative filtering by matrix factorization**. Picture a huge, mostly empty matrix with a row per user and a column per item, holding interactions (watched, rated, clicked). Factorization learns a short vector pᵤ for each user and qᵢ for each item so that their dot product predicts the matrix entry:

```text
predicted affinity(u, i) = pᵤ · qᵢ = pᵤ₁·qᵢ₁ + pᵤ₂·qᵢ₂ + … + pᵤd·qᵢd
```

Users who liked the same things end up with similar vectors, and so do items liked by the same people. This is the model popularized by the Netflix Prize. Its weakness is that a vector exists only for users and items seen in training, and it ignores everything else you know about them, such as an item's title or a user's country.

A **two-tower model** generalizes it. Two neural networks map features into the same d-dimensional space, typically d = 64 to 256:

```diagram
title: Two-tower model: both towers output vectors in one space
[u_feat] User features\n(history, country) @ 0,0
[u_tower] User tower @ 1,0
[u_vec] User vector u @ 2,0
[i_feat] Item features\n(tags, creator) @ 0,1
[i_tower] Item tower @ 1,1
[i_vec] Item vector v @ 2,1
[dot] Score = u · v @ 3,0.5
u_feat -> u_tower
u_tower -> u_vec
i_feat -> i_tower
i_tower -> i_vec
u_vec -> dot
i_vec -> dot
```

- **The item tower runs offline.** Item vectors don't depend on the request, so a batch job computes all billion of them (every few hours, or when an item is uploaded) and loads them into the vector index.
- **The user tower runs online, once per request.** It takes the user's profile and their last few watched items and produces one query vector u.
- **The score is a dot product:** score(u, v) = u · v = u₁v₁ + u₂v₂ + … + u_d·v_d. If both vectors are normalized to length 1, the dot product equals their **cosine similarity**, cos θ = (u · v) ÷ (‖u‖ × ‖v‖), and many systems normalize for exactly that reason.

The towers are trained on logged interactions: a (user, item they engaged with) pair is a positive, and other items in the same training batch serve as negatives. Because new items get a vector from their features alone, an upload with zero views can still be retrieved, which matrix factorization can't do.

Separating the towers is the whole trick. The expensive part, scoring an item, is done ahead of time. At request time you run one small network and then a search.

### Approximate nearest neighbor search

Finding the 1,000 item vectors with the highest dot product by brute force means 10⁹ dot products of 256 dimensions each: about 2.6 × 10¹¹ multiply-adds per request. That's on the order of seconds of CPU time per request, and you have 116,000 requests a second. Exact search is out.

**Approximate nearest neighbor (ANN)** indexes trade a little recall for orders of magnitude less work. Libraries and databases such as Faiss, ScaNN, Milvus and Vespa implement several kinds. The most common is **HNSW** (Hierarchical Navigable Small World):

- Every vector is a node in a graph, linked to a few of its close neighbors.
- The graph has layers, like a skip list. The top layer holds a small random sample of nodes with long links; each layer below holds more nodes, and the bottom layer holds all of them.
- A search starts at the top, greedily walks to the neighbor closest to the query until no neighbor is closer, then drops a layer and repeats from there. On the bottom layer it keeps a short list of the best candidates found so far (the `ef` parameter) to improve recall.
- The number of steps grows roughly logarithmically with the number of vectors in practice. Typical configurations reach 90–99% recall, tuned by `ef` and the number of links per node.

At a billion items, memory is the real constraint. Raw vectors are about 1 TB, and the graph links add more: with 32 links per node at 4 bytes each, another 10⁹ × 32 × 4 B ≈ 128 GB. Two common responses:

- **Shard the index** across machines (for example 16 shards of about 70 GB each), query all shards in parallel, and merge their top results. This is the same scatter-gather shape as a document-partitioned search index.
- **Compress the vectors.** 8-bit quantization cuts 1 TB to about 256 GB; product quantization can store a 256-dimension vector in 32 to 64 bytes, at some cost in accuracy. A common pattern is to search compressed vectors, then re-score the top few thousand with the full ones.

Most inner-product search is done this way too: normalize the vectors so maximum dot product and nearest neighbor by cosine are the same thing, or apply a small transform that turns one into the other.

### Several retrieval sources

One embedding model has blind spots, so production systems merge candidates from several sources. An example split, as an assumption:

1. **Embedding ANN:** about 500 items from the two-tower model.
2. **Item-to-item collaborative filtering:** about 200 items that people who engaged with the user's recent items also engaged with.
3. **Topic and trending:** about 200 popular or rising items in the user's favorite categories and region.
4. **Social or subscriptions:** about 100 new items from creators the user follows.

The sources overlap, so after removing duplicates and already-watched items the union is somewhat under 1,000 candidates. Each source can be dropped if it's slow, which also helps availability.

## Stage 2: ranking with multiple objectives

With about 1,000 candidates, the ranker can afford a much richer model: hundreds of features per (user, item) pair, including cross features such as "how often this user finishes videos from this creator".

### Why one objective is not enough

A ranker trained only on click-through rate learns to promote **clickbait**: a sensational thumbnail gets the click, the viewer leaves after a few seconds, and over time people trust the feed less. So rankers predict several outcomes at once:

- P(click): will the user tap the item?
- P(long watch): will they watch at least 30 seconds?
- P(completion): will they finish it?
- P(like) and P(share)
- P(dislike or "not interested")

The final score combines them with weights the product team tunes through A/B tests:

```text
score = w₁ × P(click) + w₂ × P(long watch) + w₃ × P(like) − w₄ × P(dislike)
```

The weights encode what the product values, and changing them is a product decision as much as a modeling one.

### Multi-gate mixture of experts

Training one network per objective wastes data, because the objectives share most of what they need to learn. Training one network with several output heads works, but objectives that conflict (clicks vs long watches) pull the shared layers in different directions. **Multi-gate Mixture-of-Experts (MMoE)**, from Google (Ma et al., 2018), sits in between:

```diagram
title: MMoE: shared experts, one gate and one head per task
[feat] Features for\neach candidate @ 1.5,0
[experts] Shared experts\n(small MLPs) @ 1.5,1
[t_click] P(click) @ 0,2
[t_watch] P(long watch) @ 1,2
[t_like] P(like) @ 2,2
[t_dis] P(dislike) @ 3,2
[score] Weighted score @ 1.5,3
feat -> experts
experts -> t_click
experts -> t_watch
experts -> t_like
experts -> t_dis
t_click -> score
t_watch -> score
t_like -> score
t_dis -> score
```

- Several **expert** networks all see the same input.
- Each task has its own **gate**, a small network that outputs a weighting over the experts for this input. The task's head sees a weighted mix of expert outputs.
- Each task has its own **tower** (head) that produces its probability.

Tasks that agree end up using the same experts; tasks that conflict can lean on different ones. YouTube described using MMoE for multiple ranking objectives in its 2019 RecSys paper.

### The feature store

A ranking model is only as good as its features, and those features come from very different places:

| Feature kind | Examples | Computed by | Served from |
|---|---|---|---|
| User profile (changes rarely) | country, language, account age | daily batch job | online feature store |
| Item metadata and counters (slow) | duration, category, creator, 30-day views | hourly or daily batch job | online feature store |
| Real-time (fast) | topics the user clicked in the last 10 minutes, an item's CTR in the last hour | stream processor (Flink or similar) | online feature store, updated within seconds |

```diagram
title: Real-time and batch features feed one store
[app:client] Client events @ 0,0
[kafka:queue] Event stream\n(Kafka) @ 1,0
[flink] Stream jobs\n(Flink) @ 2,0
[online:store] Online store\n(Redis) @ 3,0
[offline:store] Offline store\n(S3, warehouse) @ 2,1
[ranker] Ranker fleet @ 3,1
[train] Training jobs @ 2,2
app -> kafka : clicks, views
kafka -> flink
flink -> online : windowed counts
flink --> offline : event log
online -> ranker : batch get
offline --> train
train --> ranker : new model
```

- The **online store** is a key-value store (Redis, Cassandra or a managed equivalent) holding only the latest value of each feature, keyed by user ID or item ID. For a request, the ranker fetches the user's features once and the item features for all ~1,000 candidates in batched multi-key gets, sent to the store's shards in parallel. Keeping that within the 10 ms budget is realistic when the data is in memory.
- The **offline store** (object storage plus a warehouse like Snowflake or BigQuery) keeps the full history. Training jobs read it to build examples: "at the moment we showed item X, the user's features were these, and they did or didn't watch it".

A feature store framework such as Feast keeps one definition of each feature and fills both stores from it. That prevents **training-serving skew**, where the value a model saw in training is computed differently from the value it sees in production, so a model that looked good offline underperforms live.

## Stage 3: re-ranking, diversity and exploration

The ranker sorts the candidates and passes the top 100 to the re-ranker. Two problems remain. If you just take the top 20, you may get 20 clips of the same match from the same channel, because similar items get similar scores. And new items, which have no engagement history, rarely score high enough to be shown, so they never collect the history they'd need. That second one is the **cold-start problem**.

### Maximal marginal relevance for diversity

**Maximal Marginal Relevance (MMR)** builds the feed one slot at a time. At each step it picks, from the candidates not yet chosen, the one with the best balance of relevance and novelty:

```text
next item = the candidate d, not yet selected, that maximizes
    λ × relevance(d) − (1 − λ) × max similarity(d, s) over selected items s
```

- relevance(d) is the ranker's score for d.
- similarity(d, s) is usually the cosine similarity of the two items' embeddings, so the penalty is set by the already-chosen item that d most resembles.
- λ is between 0 and 1. With λ = 1 the formula is pure relevance and MMR returns the ranker's order. Lower λ trades relevance for variety.

With 100 candidates and 20 slots, MMR does at most 20 × 100 × 20 = 40,000 similarity checks, which is trivial. Production systems often add simple hard rules on top: no more than two items from one creator in the first ten slots, for example.

### Bandits for exploration

To give new items a fair chance, the re-ranker treats some slots as an experiment. This is the **multi-armed bandit** problem: each item is an arm, and you balance showing what you know works (exploitation) against learning about what you don't (exploration). Two common methods:

- **Upper confidence bound (UCB1).** Score each item by its observed engagement rate plus a bonus that shrinks as it's shown more:

  ```text
  UCB score(i) = μ̂ᵢ + c × √(ln N ÷ nᵢ)
  ```

  Here μ̂ᵢ is item i's observed engagement rate, nᵢ is how many times it has been shown, N is the total number of impressions across the items being compared, and c sets how much to explore. An item with few impressions gets a large bonus; as nᵢ grows the bonus fades and the item stands on its measured rate.
- **Thompson sampling.** Keep a probability distribution over each item's true engagement rate (for example a Beta distribution updated with clicks and non-clicks), draw one sample per item, and rank by the samples. Uncertain items sometimes draw high values and get shown.

In practice exploration is budgeted: for example, one or two of the 20 slots, or a small share of traffic, go to exploration candidates. That fraction is a product choice, not a law. If people engage, the item's counters rise and it competes in normal ranking; if they don't, its bonus shrinks and it drops out.

## Check yourself

<details>
<summary>Why not run the ranking model over the whole catalog instead of using a two-tower retrieval stage first?</summary>

Cost. Suppose the ranking model takes 0.1 ms per item. Scoring 10⁹ items is 10⁹ × 0.1 ms = 100,000 seconds, about 28 hours, for one request. Batching on accelerators cuts the per-item cost a lot, but you'd still be doing 116,000 × 10⁹ scorings a second at peak.

The two-tower model moves item scoring offline. Item vectors are computed in batch and indexed. At request time you run the user tower once and do an approximate nearest neighbor search, which visits a tiny fraction of the vectors. That cuts the pool to about 1,000, which the ranker can score with hundreds of features within its 35 ms budget.

</details>

<details>
<summary>How does a two-tower model handle a video uploaded five minutes ago, and why can't plain matrix factorization?</summary>

Matrix factorization learns one vector per item ID from that item's interactions, so a brand-new item has no vector until it has history and the model is retrained. The item tower builds the vector from features (title, tags, creator, duration), so the new item gets a reasonable vector as soon as it's processed and can be retrieved right away. Its engagement-based features are still empty, so the ranker will score it cautiously; that's where bandit exploration in re-ranking gives it impressions to learn from.

</details>

<details>
<summary>What is the difference between the online feature store and the offline store, and why do you need both?</summary>

The offline store keeps the full history of features and events, often terabytes or more, in object storage and a warehouse. It's built for big scans when training models, and queries take seconds to minutes. The online store keeps only the latest value of each feature, keyed by user or item ID, in memory, so a batched lookup for a thousand items takes a few milliseconds. It can't answer questions about history.

Training needs the history, and serving needs the speed. Defining each feature once and filling both stores from that definition prevents training-serving skew: the model is served the same features it was trained on, computed the same way.

</details>

<details>
<summary>How does MMR stop the feed from being 20 versions of the same thing, and what does λ control?</summary>

MMR picks items one at a time. The first pick is the highest-scoring item. For each later slot, every remaining candidate's relevance is reduced by its similarity to the most similar item already picked. A second clip of the same tennis match has high similarity to the first, so it takes a large penalty, and a slightly less relevant item on another topic can beat it.

λ sets the balance. At λ = 1 there's no penalty and you get the ranker's order. As λ falls, similarity costs more and the feed gets more varied. Teams tune it with A/B tests against engagement and retention.

</details>

<details>
<summary>The ranker fleet falls behind during a traffic spike. What should the feed service do?</summary>

Degrade instead of failing. Set a deadline on the ranking call; if it misses, return the candidates ordered by their retrieval scores, or a cached recent feed for the user, after a light re-rank. Shed ranking load further by scoring fewer candidates per request (say 300 instead of 1,000). Then scale the fleet. Users notice a slightly less relevant feed far less than they notice an error.

</details>

## Further reading

- [Deep Neural Networks for YouTube Recommendations](https://research.google/pubs/pub45530/) (Covington, Adams and Sargin, RecSys 2016): the candidate generation and ranking split, and many practical details about training data.
- [Modeling Task Relationships in Multi-task Learning with Multi-gate Mixture-of-Experts](https://dl.acm.org/doi/10.1145/3219819.3220007) (Ma et al., KDD 2018): the MMoE paper.
- [Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs](https://arxiv.org/abs/1603.09320) (Malkov and Yashunin): the HNSW paper, later published in IEEE TPAMI.
- [The use of MMR, diversity-based reranking for reordering documents and producing summaries](https://dl.acm.org/doi/10.1145/290941.291025) (Carbonell and Goldstein, SIGIR 1998): the original MMR formulation, written for search results and summaries.
- [Feast documentation](https://docs.feast.dev/): an open-source feature store, with its model of offline and online stores.
