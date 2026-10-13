# Design a web search engine

A web search engine takes a few words and, in a couple of hundred milliseconds, returns the ten most useful pages out of tens of billions. Behind that are three systems that run at very different speeds: a crawler that fetches the web continuously, an indexing pipeline that turns pages into a searchable structure, and a serving tier that answers a query by asking hundreds of machines at once.

The primer's [web crawler](/learn/design-web-crawler) and [query cache](/learn/design-query-cache) exercises cover two pieces. This chapter puts the whole thing together: how pages become an **inverted index**, how a crawler stays fast without hammering any one site, why large engines split the index by document rather than by term, and how BM25, PageRank and learned ranking combine to score results quickly. It builds on [database 101](/learn/database-101), [cache 101](/learn/cache-101) and [batch processing](/learn/batch-processing).

## Requirements and scale

Agree on scope first. A reasonable set:

- **Functional:** given a text query such as `distributed consensus raft`, return the 10 most relevant pages with a title, URL and a two-line snippet that highlights the query terms. Crawl the public web continuously, finding new pages and changes to known ones. Build and update the index from the crawl.
- **Non-functional:** p99 query latency under 200 ms; 99.99% availability on the query path (partial results beat an error); freshness in minutes to hours for news and fast-changing sites, days for the long tail.
- **Out of scope for now:** autocomplete (see [design autocomplete](/learn/design-autocomplete)), image and video search, ads, personalization.

Then size it. These numbers are assumptions for an interview, not figures from any real engine:

- **Corpus:** 50 billion pages in the index.
- **Page size:** about 100 KB of raw HTML, which shrinks to about 20 KB of useful text after removing markup, scripts and boilerplate.
- **Text storage:** 50 × 10⁹ × 20 KB = 10¹⁵ bytes, or **1 PB of text**. Keeping the raw HTML too is 5 PB before compression.
- **Index size:** 20 KB of text is roughly 3,000 words. Storing every word position is 50 × 10⁹ × 3,000 = 1.5 × 10¹⁴ positions; at 4 bytes each that's 600 TB uncompressed, plus document IDs and counts. Compression (covered below) brings a positional index to something like a quarter to a third of the text size, so assume **about 300 TB of index**.
- **Queries:** 50,000 a second on average, with a peak of about 2×: **100,000 queries a second**.
- **Shards:** split the index into 500 shards of 100 million pages each. That's 300 TB ÷ 500 = 600 GB of index per shard, which fits on one machine's SSD with the hot parts in RAM.
- **Fan-out:** every query goes to every shard (the next sections explain why), so peak load is 100,000 × 500 = **50 million shard queries a second**. If the query cache answers 30% of queries, that drops to 35 million. If one replica of a shard handles about 1,000 queries a second, each shard needs around 70 replicas at peak: roughly **35,000 shard servers**. The query rate, not the data size, decides how big the serving fleet is.

See [estimation](/learn/estimation) for more on this kind of arithmetic.

## High-level architecture

```diagram
title: Query path: cache, then scatter-gather over index shards
[client:client] User @ 0,0
[fe] Query frontend @ 1,0
[qu] Query\nunderstanding @ 0,1
[cache:store] Query cache @ 1,1
[agg] Aggregator\n(merge, re-rank) @ 2,0
[shards:store] Index shards\n(500 × replicas) @ 3,0
[docs:store] Document store\n(titles, text) @ 2,1
client <-> fe : query
fe -> qu : parse
fe -> cache : lookup
fe -> agg : on miss
agg <-> shards : scatter / gather
agg -> docs : snippets
```

An [interactive version of this diagram](/diagrams/search-engine.html) lets you pan, zoom and trace the request paths.

The path of one query:

1. The frontend normalizes the query (lowercase, Unicode normalization) and checks the [query cache](/learn/design-query-cache). Query popularity is very skewed, so a cache keyed by normalized query answers a large share of traffic for a few minutes at a time.
2. On a miss, query understanding runs: tokenizing the same way the indexer did, spelling correction, synonym expansion, detecting phrases and language.
3. The aggregator sends the query to one replica of every shard in parallel.
4. Each shard finds and scores matching documents in its own index and returns its best ~100 with their scores and ranking features.
5. The aggregator merges the 500 × 100 = 50,000 results, re-ranks the top few hundred with a heavier model, and keeps the best 10.
6. It fetches titles and stored text for those 10 from the document store, builds query-specific snippets, and returns the page.

If a shard replica is slow, the aggregator retries on another replica, or after a deadline returns results from the shards that answered. Missing 1 shard out of 500 drops 0.2% of the index for one query, which users rarely notice.

## The crawling subsystem

The crawler has two goals that pull against each other: **freshness** (fetch as much as possible, as often as useful) and **politeness** (never send one site more traffic than it can comfortably handle).

```diagram
title: Crawl loop with a Mercator-style frontier
[links] Discovered\nURLs @ 0,0
[seen:store] URL seen?\n(dedup) @ 1,0
[front:queue] Front queues\n(by priority) @ 2,0
[back:queue] Back queues\n(one host each) @ 3,0
[heap] Host ready-time\nheap @ 3,1
[fetch] Fetchers\n(DNS cache) @ 2,1
[parse] Parse and\nSimHash dedup @ 1,1
[store:store] Page store @ 0,1
links -> seen
seen -> front : new URLs
front -> back : refill
heap -> fetch : next host
back -> fetch : URL
fetch -> parse
parse -> store
```

### The crawl frontier: priority and politeness

The frontier is the set of URLs waiting to be fetched. The design popularized by the Mercator crawler, and described in detail in *Introduction to Information Retrieval*, has two layers of FIFO queues:

- **Front queues handle priority.** A prioritizer gives each URL a priority from signals such as the page's estimated importance (for example its PageRank), how often it has changed in the past, and whether it's a known news source. There's one front queue per priority level, and higher-priority queues are drained more often.
- **Back queues handle politeness.** Each back queue holds URLs from exactly one host, and a small table maps each host to its back queue. When a back queue empties, it's refilled from the front queues, so priority still shapes what each host's queue contains.
- **A heap orders hosts by the earliest time each may be contacted again.** A fetcher thread takes the host at the top of the heap, waits if that time hasn't arrived, fetches one URL from its back queue, and then pushes the host back with a new ready time. A common rule is to wait a multiple of how long the last fetch took (the textbook suggests about 10×), and never less than the site's `Crawl-delay` in `robots.txt` if it sets one.

Because each host is only ever in one back queue and one heap slot, at most one fetch per host is in flight. A slow site only slows itself; the fetchers meanwhile work through thousands of other hosts. That's how a crawler can make tens of thousands of requests a second overall while each site sees a trickle.

A few other pieces matter at scale. Fetchers keep their own DNS cache, because DNS lookups are slow and the crawler would otherwise flood resolvers. Each host's `robots.txt` is fetched, cached and checked before any URL from that host. The "URL seen?" check uses a large hash set or Bloom filter over normalized URLs, so the same page isn't queued twice from different links.

### Near-duplicate detection with SimHash

A large share of the web is near-duplicate: mirrors, syndicated articles, printer-friendly copies, pages that differ only in a date or a tracking parameter. Early studies of large crawls put it at around 30% of pages. Indexing them wastes space and fills result pages with copies.

An exact hash like SHA-256 can't detect near-duplicates. Change one character and about half of the output bits flip, so the hash says nothing about how similar two pages are. **SimHash** is built so that similar documents get fingerprints that differ in only a few bits (a small **Hamming distance**):

1. Extract features from the text, usually words or short word sequences, each with a weight such as its frequency.
2. Hash each feature to 64 bits.
3. Keep 64 running totals, one per bit position. For each feature, add its weight to position i if bit i of its hash is 1, and subtract its weight if bit i is 0.
4. The fingerprint has bit i set to 1 if total i is positive, and 0 otherwise.

Two pages that share most of their features end up with the same sign in almost every position. Manku, Jain and Das Sarma at Google reported that for 8 billion pages, 64-bit fingerprints treated as near-duplicates at a Hamming distance of 3 or less worked well, and showed how to find all fingerprints within 3 bits of a new one quickly using several permuted, sorted tables.

## The inverted index pipeline

An **inverted index** maps each term to the list of documents that contain it, the opposite direction from a document that lists its words. It's what lets a shard find every page containing `consensus` without reading every page.

```diagram
title: Looking up one term in the index
[term] Term\n"consensus" @ 0,0
[dict:store] Dictionary\n(df, offset) @ 1.5,0
[plist:store] Posting list\n(on disk or RAM) @ 3,0
term -> dict : lookup
dict -> plist : offset
```

The dictionary holds every term with its document frequency (how many documents contain it) and where its posting list starts. The posting list holds one entry per document:

```text
"consensus"  df = 3
  doc 12   tf = 4   positions 4, 18, 92, 140
  doc 45   tf = 1   positions 12
  doc 89   tf = 8   positions 1, 9, 34, …
```

Here tf is the term frequency: how many times the term occurs in that document.

### Document processing

When a fetched page reaches the indexer:

1. **Parse.** Strip tags, scripts and styles. Keep the title, headings and other fields separately, because a match in the title counts for more than a match in a footer.
2. **Tokenize.** Split text into terms and normalize them: lowercase, Unicode normalization, and language-specific rules (some languages don't put spaces between words).
3. **Handle stop words carefully.** Classic systems dropped very common words like `the` and `of`. Web engines mostly keep them, because queries such as `to be or not to be` or `The Who` need them, and compression makes their long posting lists affordable.
4. **Stem or lemmatize.** A stemmer such as Porter's strips suffixes by rule, so `running` and `runs` both become `run`. Rules can't handle irregular forms, so `ran` stays `ran`; mapping it to `run` needs a lemmatizer with a dictionary. Engines often index both the original and the stemmed form so exact matches can still score higher.
5. **Add anchor text.** The text of links pointing to a page is indexed as part of that page. Other people's descriptions are often better than the page's own words. The well-known example: Adobe's Acrobat Reader download page ranked for "click here" because so many sites linked to it with "click here to download Acrobat".

The index itself is built in batch: mappers emit (term, doc, positions) records, the shuffle groups them by term, and reducers write sorted posting lists. That's the original use case for MapReduce (see [batch processing](/learn/batch-processing)). To keep news fresh without rebuilding everything, engines also run a small, frequently updated index for recent pages, query it alongside the main one, and merge the results.

### Why positions are stored

Positions make two things possible:

- **Phrase queries.** For `"system design"`, a document matches only if some position of `design` is exactly one more than a position of `system`.
- **Proximity scoring.** Pages where the query terms appear close together usually deserve a higher score than pages where they're 500 words apart.

### Compressing posting lists

Uncompressed, the positions alone would be about 600 TB, as estimated above. Posting lists compress very well because they're sorted:

- **Gaps instead of IDs.** Document IDs `104, 108, 115, 120` are stored as `104, 4, 7, 5`, the difference from the previous ID. Positions within a document are gap-encoded the same way. Gaps are small numbers, especially for common terms.
- **Variable-byte encoding.** Each byte carries 7 bits of the number and 1 bit saying whether more bytes follow. Any gap below 128 takes 1 byte instead of 4.
- **Block bit-packing.** Schemes such as frame of reference and PForDelta take a block of, say, 128 gaps and store each in just enough bits for the largest one (with the rare large values handled separately). Decoding a block uses fast SIMD instructions, and blocks can be skipped without decoding.

Together these typically cut posting lists to a quarter or less of their uncompressed size, which is where the ~300 TB estimate comes from. For sets of document IDs used as filters (pages in a language, pages from a site), many engines use compressed bitmaps such as Roaring bitmaps instead.

## Partitioning the index: by document or by term

No single machine holds 300 TB of index and answers 100,000 queries a second, so the index is split. There are two ways to do it.

**Term partitioning (a global index).** Each machine holds complete posting lists for a subset of terms, say every term from `a` to `c` on one node.

- A one-word query touches one machine.
- A query like `system design interview` needs posting lists from three machines. Intersecting them means shipping long lists of document IDs across the network, and posting lists for common terms are huge.
- Popular terms make their machines hot spots, and load follows whatever people happen to search for today.

**Document partitioning (a local index).** Each machine holds a complete inverted index for a subset of documents, here 100 million pages per shard, assigned by a hash of the document ID or URL.

```diagram
title: Document partitioning: every query goes to every shard
[agg] Aggregator @ 1.5,0
[s1:store] Shard 1\n100M docs @ 0,1
[s2:store] Shard 2\n100M docs @ 1,1
[s3:store] Shard 3\n100M docs @ 2,1
[s500:store] Shard 500\n100M docs @ 3,1
agg <-> s1
agg <-> s2
agg <-> s3
agg <-> s500
```

- Every query goes to all 500 shards in parallel. Each intersects and scores its own posting lists locally, and returns only its top ~100 results: a few kilobytes, not posting lists.
- Load is even, because every shard does a similar share of every query.
- A failed or slow shard costs a small fraction of the results instead of whole terms, and replicas cover it.
- The cost is fan-out. Every query does work on every shard, and the query is as slow as the slowest shard it waits for, so tail latency matters a lot. Replicas, hedged requests (send to a second replica if the first is slow) and deadlines keep it in check; see [reliability patterns](/learn/reliability-patterns).

| | Term partitioning | Document partitioning |
|---|---|---|
| Machines per query | one per query term | all shards |
| Network traffic | posting lists | top-k results only |
| Load balance | skewed by popular terms | even |
| Effect of a lost node | some terms missing entirely | a fraction of documents missing |
| Adding documents | touches many nodes | touches one shard |

Large web engines use document partitioning in practice, adding replicas of each shard to handle query volume. Term partitioning shows up in research and in some specialized systems, but the network cost of multi-term queries makes it a poor fit here.

## Relevance and ranking

Scoring is another funnel. Cheap scores run over many documents inside each shard, and expensive ones run over a few hundred at the aggregator.

```diagram
title: Ranking funnel for one query
[idx:store] Shard index\n100M docs @ 0,0
[ret] WAND top-k\n~1,000 per shard @ 1,0
[light] Light ranker\n~100 per shard @ 2,0
[heavy] Heavy ranker\ntop few hundred @ 3,0
idx -> ret : BM25
ret -> light : features
light -> heavy : merge
```

1. **Retrieval** inside each shard finds the ~1,000 best documents by a cheap score (BM25 plus static signals like PageRank), using WAND to avoid scoring most matches.
2. **Light ranking** inside each shard re-scores those with more features (proximity, title matches, freshness, link signals) using a fast model such as gradient-boosted trees, and returns the top ~100.
3. **Heavy ranking** at the aggregator merges the 50,000 results and re-scores the top few hundred with an expensive model, for example a transformer that reads the query and the page text together.

### Text relevance: from TF-IDF to BM25

The starting idea is **TF-IDF**: a term matters more in a document the more often it appears there (term frequency) and the rarer it is across the collection (inverse document frequency):

```text
tf-idf(t, D) = tf(t, D) × log(N ÷ df(t))
```

N is the number of documents and df(t) is how many contain t. In a shard of 100 million pages, a term found in 100,000 of them gets log₁₀(10⁸ ÷ 10⁵) = 3, and one found in 10 million gets log₁₀(10) = 1. IDF grows with the logarithm of rarity, so a term 100 times rarer gets 3 times the weight, not 100 times.

TF-IDF has two flaws: a page that repeats a word 100 times scores 100 times higher, and long pages win simply by containing more words. **BM25** (Okapi BM25, from Robertson and colleagues' probabilistic retrieval work) fixes both:

```text
score(D, Q) = sum over each query term q of
              IDF(q) × tf(q, D) × (k₁ + 1) ÷ ( tf(q, D) + k₁ × (1 − b + b × |D| ÷ avgdl) )

IDF(q) = ln( 1 + (N − n(q) + 0.5) ÷ (n(q) + 0.5) )
```

- tf(q, D) is how often q appears in document D, and n(q) is how many documents contain q.
- |D| is D's length in words and avgdl is the average length across the collection.
- **k₁** (usually 1.2 to 2.0) controls **term frequency saturation**. Each extra occurrence helps less. With k₁ = 1.2 and ignoring length, the term's factor is 1.0 at tf = 1, about 1.96 at tf = 10 and about 2.17 at tf = 100, and it never exceeds k₁ + 1 = 2.2. Repeating a keyword a hundred times barely helps.
- **b** (usually 0.75) controls **length normalization**: at b = 1 a term's weight is fully scaled by the page's length relative to average, at b = 0 length is ignored.

The IDF shown is the variant Lucene uses; the `1 +` inside the log keeps IDF positive for terms that appear in more than half the documents.

### Link authority: PageRank

PageRank, introduced by Brin and Page in 1998, treats a link as a vote, weighted by the importance of the page casting it. It models a "random surfer" who follows a random link on the current page with probability d, and otherwise jumps to a random page anywhere:

```text
PR(u) = (1 − d) ÷ N  +  d × sum over pages v that link to u of  PR(v) ÷ L(v)
```

- N is the total number of pages, and L(v) is the number of outgoing links on page v, so v splits its rank evenly among the pages it links to.
- d is the **damping factor**, usually 0.85.
- With the ÷ N term, the ranks across all pages sum to 1. The 1998 paper wrote the first term as just (1 − d), which scales every rank by N without changing the order.
- Pages with no outgoing links would leak rank out of the system, so implementations treat them as linking to every page.

A page ranks high if many pages link to it, or if a few high-ranked pages do. PageRank is computed offline by power iteration: start with every page at 1 ÷ N, apply the formula to every page, and repeat until the values stop changing, typically after a few dozen rounds. Each round is a pass over the link graph, a natural fit for MapReduce or Spark. The result is stored as a static, per-document score that shards read at query time. Today it's one signal among hundreds, not the main ranking factor it was in 1998.

### Early termination with WAND

A shard with 100 million pages may have millions containing `computer`. Fully scoring every match for every query would waste most of the CPU, since only the top 1,000 matter.

**WAND** ("weak AND", Broder et al., 2003) skips documents that can't make the top k:

- For each query term, the index stores an upper bound: the highest BM25 contribution that term gives any document.
- The shard keeps a threshold θ, the score of the current k-th best document.
- It keeps one cursor per query term, each at some document ID, and sorts the terms by those IDs. Walking through them in order, it adds up their upper bounds until the sum exceeds θ. The document ID where that happens is the **pivot**. Any document before the pivot appears only in terms whose bounds add up to θ or less, so it can't beat θ. Every cursor jumps straight to the pivot.
- Only then is the pivot scored fully, and θ rises as better documents are found, so skipping gets more aggressive as the query runs.

**Block-Max WAND** (Ding and Suel, 2011) stores an upper bound for each block of about 128 postings as well as for the whole list. The block bounds are much tighter, so whole blocks can be skipped without being decompressed. Published experiments show several-fold speedups over plain WAND, and Lucene, which Elasticsearch and OpenSearch are built on, uses a block-max approach for top-k queries.

## Check yourself

<details>
<summary>Why do large web search engines partition their index by document instead of by term?</summary>

With term partitioning, a multi-word query like `distributed system design` needs posting lists from three machines, and intersecting them means sending long lists of document IDs over the network. Popular terms also turn their machines into hot spots.

With document partitioning, each shard has a complete index for its 100 million pages. The query goes to all shards at once, each intersects and scores locally, and each sends back only its top ~100 results, a few kilobytes. Load is spread evenly, and losing a shard costs a small slice of documents rather than whole terms. The price is that every query touches every shard and waits for the slowest one, which is why shards are replicated and the aggregator uses deadlines and hedged requests.

</details>

<details>
<summary>How does a Mercator-style frontier keep the crawler fast while sending each site at most one request at a time?</summary>

It separates priority from politeness. Front queues order URLs by importance. Back queues each hold URLs from exactly one host, and a heap records the earliest time each host may be contacted again. A fetcher takes the host at the top of the heap, fetches one URL from that host's queue, then puts the host back with a new ready time, a multiple of how long the last fetch took and never less than the site's `Crawl-delay`.

Since each host appears once in the heap, only one fetch per host is in flight. While one site is in its cool-down, fetchers are busy with thousands of others, so total throughput stays high and no single site sees more than a trickle.

</details>

<details>
<summary>How does SimHash find near-duplicate pages, and why doesn't SHA-256 work for this?</summary>

SHA-256 is designed so that changing one character flips about half the output bits. Two pages that differ only in a timestamp get unrelated hashes, so the hash tells you nothing about similarity.

SimHash hashes each feature (word or word sequence) to 64 bits and keeps 64 running totals: for each feature, add its weight where its hash has a 1 bit and subtract where it has a 0. The fingerprint's bit i is 1 if total i is positive. Pages that share most features end up with the same signs in almost every position, so their fingerprints differ in only a few bits. Google's crawler work treated 64-bit fingerprints within a Hamming distance of 3 as near-duplicates.

</details>

<details>
<summary>A page repeats "cheap flights" 200 times in hidden text. Why doesn't BM25 rank it first?</summary>

Term frequency saturates. With k₁ = 1.2 a term's factor approaches k₁ + 1 = 2.2 no matter how many times it appears; at tf = 10 it's already about 1.96, so 200 repetitions add very little over 10. Length normalization (b) also lowers the score of a page bloated with extra words. And BM25 is only the first filter: the light and heavy rankers use link signals, spam classifiers and many other features that keyword stuffing doesn't improve.

</details>

<details>
<summary>Your query cache answers 30% of queries. Roughly how many shard servers does the peak need, and what would change if the hit rate doubled?</summary>

At 100,000 queries a second, 70,000 miss the cache. Each goes to all 500 shards, so that's 35 million shard queries a second. At an assumed 1,000 queries a second per replica, that's 35,000 shard servers, about 70 replicas per shard.

With a 60% hit rate, 40,000 queries miss, so 20 million shard queries a second and about 20,000 servers. Because of the fan-out, every point of cache hit rate saves 500 shard queries per avoided query, which is why search engines invest heavily in the query cache.

</details>

## Further reading

- [The Anatomy of a Large-Scale Hypertextual Web Search Engine](http://infolab.stanford.edu/~backrub/google.html) (Sergey Brin and Lawrence Page, 1998): the original Google architecture, including PageRank, anchor text and the early index design.
- [Introduction to Information Retrieval](https://nlp.stanford.edu/IR-book/) (Manning, Raghavan and Schütze): the standard textbook. Chapters 1–5 cover inverted indexes and compression, chapter 11 covers BM25, and chapter 20 covers crawling.
- [The URL frontier](https://nlp.stanford.edu/IR-book/html/htmledition/the-url-frontier-1.html), from the same book: the front-queue and back-queue frontier design described in this chapter.
- [Detecting near-duplicates for web crawling](https://dl.acm.org/doi/10.1145/1242572.1242592) (Manku, Jain and Das Sarma, WWW 2007): SimHash at the scale of billions of pages.
- [Efficient query evaluation using a two-level retrieval process](https://dl.acm.org/doi/10.1145/956863.956944) (Broder, Carmel, Herscovici, Soffer and Zien, CIKM 2003): the WAND paper.
- [Faster top-k document retrieval using block-max indexes](https://dl.acm.org/doi/10.1145/2009916.2010048) (Ding and Suel, SIGIR 2011): Block-Max WAND.
- Allan Heydon and Marc Najork, "Mercator: A scalable, extensible Web crawler", *World Wide Web* 2(4), 1999: the crawler the frontier design is named after.
