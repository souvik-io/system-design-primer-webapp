<!-- chapter: design-pastebin -->

## Talk through a design for a text-sharing service like Pastebin in 45 minutes. What are your four steps?
<!-- /learn/design-pastebin -->

1. **Use cases and numbers.** Paste text and get a random short link, view a paste, optional expiry, monthly view counts, cleanup of expired pastes. Users are anonymous.
   - 10 million new pastes and 100 million reads a month: about 4 writes and 40 reads a second.
   - About 1.27 KB a paste: 12.7 GB a month, about 450 GB and 360 million links over three years.
2. **High-level design.** A web server as reverse proxy, separate Write and Read APIs, a SQL `pastes` table for metadata, an object store for the text, and a log-analysis job feeding an analytics database.
3. **Core components.**
   - Text in the object store, one row per paste keyed by a 7-character Base62 code (62⁷ ≈ 3.52 trillion). Retry when the primary key rejects a duplicate.
   - Write the text first under a UUID key, then the row, so a crash leaves only a harmless orphan file.
   - Store and index `expires_at`, check it on every read, and delete expired rows and files in small batches.
4. **Scale.** The load is small, so scaling is about availability and skew: a CDN for raw pastes, a load balancer, a memory cache whose TTL never outlives the paste, and a SQL primary with read replicas and failover.

<!-- chapter: design-twitter -->

## You have 45 minutes to design the Twitter timeline and search. What do you cover in each of the four steps?
<!-- /learn/design-twitter -->

1. **Use cases and numbers.** Post a tweet (delivered to followers, with notifications), view the home and user timelines, search by keyword, stay highly available.
   - 100 million active users posting 500 million tweets a day: about 5,800 tweets and 58,000 fan-out deliveries a second.
   - About 96,000 reads and 3,900 searches a second. About 10 KB a tweet, 98% of it media.
2. **High-level design.** Write, read and search APIs; SQL for tweets, users and follows; an object store for media; a fan-out service, user graph service and memory cache of home timelines; timeline, tweet info and user info services; a search cluster; a notification service with a queue.
3. **Core components.**
   - Fan-out on write: push each tweet into every follower's home timeline, a Redis list of 17-byte entries (tweet_id, user_id, flags) capped at 800.
   - Read the id list, then hydrate it with multigets to the tweet info and user info services.
   - Search: an inverted index sharded by tweet, queried by scatter-gather with a deadline, then merged and ranked.
4. **Scale.** A hybrid: skip fan-out for accounts above a follower threshold (say 100,000) and merge their tweets at read time. Keep only active users' timelines, replicate the cache, and add federation or sharding by `user_id` to SQL.

<!-- chapter: design-web-crawler -->

## In 45 minutes, how would you walk through a web crawler design step by step?
<!-- /learn/design-web-crawler -->

1. **Use cases and numbers.** Crawl a list of URLs, build a reverse index and static titles and snippets, serve search results, never get stuck in a loop.
   - 1 billion links refreshed about weekly: 4 billion fetches a month, about 1,540 pages a second and 6.2 Gbit/s inbound.
   - 500 KB a page: 2 PB a month, 72 PB over three years if every copy is kept, 500 TB for the latest only.
   - 100 billion searches a month: about 38,600 a second.
2. **High-level design.** A crawler service; NoSQL tables `links_to_crawl` (the frontier, a Redis sorted set by priority) and `crawled_links` (signature and crawl time); job queues to a reverse index service and a document service; a Query API behind a web server.
3. **Core components.**
   - The loop: pop the top URL, check `robots.txt`, fetch, compute a signature. A copy of a known page is demoted; otherwise queue index jobs, record it and add its new links.
   - Duplicates: drop repeated URLs before fetching (MapReduce, Bloom filter) and near-duplicate content after (shingles with MinHash, or SimHash).
   - Politeness: one connection per host, waiting about ten times the last fetch time; per-host budgets against crawler traps.
4. **Scale.** Shard the frontier and the crawlers by host hash, keep a DNS cache and thousands of open fetches, cache popular queries, and shard and replicate the index and document services.

<!-- chapter: design-mint -->

## Outline a 45-minute design for a personal finance tracker like Mint, step by step.
<!-- /learn/design-mint -->

1. **Use cases and numbers.** Link financial accounts; extract and categorize transactions daily for users active in the past 30 days, with manual overrides; track monthly spending by category; recommend budgets and alert near or over them.
   - Write-heavy, 10 to 1: 5 billion transactions a month, about 2,000 writes a second (about 7,700 in a 6-hour nightly window) against 200 reads.
   - About 50 bytes a transaction: 250 GB a month, 9 TB of payload over three years.
2. **High-level design.** The Accounts API queues extraction jobs. An extractor fetches through an aggregator, keeps raw files in an object store, calls the category and budget services and writes to SQL. A notification service sends alerts.
3. **Core components.**
   - Link through an aggregator with OAuth and store only an encrypted access token, never the bank password.
   - Make extraction idempotent with a unique `(account_id, external_id)` and insert-or-update.
   - Categorize by the user's rule, then a seed map of 50,000 sellers (about 12.75 MB), then crowd votes. Budgets come from an income-tier template plus stored overrides.
4. **Scale.** A memory cache and read replicas for reads, monthly totals in an analytics database, only recent months in SQL, transactions sharded by `user_id` or moved to a wide-column store, and extraction spread over the night.

<!-- chapter: design-social-graph -->

## Talk through the data structures for a social network's "how you're connected" search in 45 minutes. What are the four steps?
<!-- /learn/design-social-graph -->

1. **Use cases and numbers.** Show the shortest path from the searcher to another person, with high availability and no graph database.
   - 100 million users with 50 friends each: 5 billion friend-list entries (2.5 billion friendships), about 40 GB of ids.
   - 1 billion searches a month: about 400 a second.
   - A one-sided BFS to a target 4 steps away reads 127,551 friend lists.
2. **High-level design.** Web server, search API, a user graph service that runs the search, a lookup service that says which person server holds whom, and sharded person servers holding friend lists.
3. **Core components.** Breadth-first search with a parent map, checking for the target when a person is discovered. Each expansion asks the lookup service, then a person server.
4. **Scale.**
   - Bidirectional BFS: about 102 friend-list reads instead of 127,551.
   - Compute the shard from the id, batch reads by server and send them in parallel: one round of calls per ring.
   - Hop or time limits, cached friend lists and results, and optionally precomputed 2-step neighborhoods.

<!-- chapter: design-query-cache -->

## How would you spend 45 minutes designing a cache for a search engine's query results?
<!-- /learn/design-query-cache -->

1. **Use cases and numbers.** A request that hits the cache, one that misses, and high availability.
   - 10 billion queries a month: about 3,860 a second, 11,600 at peak.
   - About 3 KB an entry (ten results with URL, title and snippet). The 100 million most popular queries need about 315 GB.
   - At an 80% hit rate, about 770 misses a second reach the search backend.
2. **High-level design.** Web server, Query API, memory cache, and behind it the reverse index service and document service.
3. **Core components.**
   - Normalize the query (remove markup, split terms, lowercase, fix typos, boolean form) and add locale and page to the key.
   - LRU from a hash map plus a doubly linked list, so get and set are both O(1).
   - Cache-aside with TTLs by query type, versioned keys for index rebuilds, and a blocklist for urgent removals.
4. **Scale.** Shard the cache over about six machines with consistent hashing (mod-N would move about 86% of keys when one is added), handle hot queries with small local caches or copied keys, and add shard replicas if the backend can't absorb a lost shard.

<!-- chapter: design-sales-rank -->

## In 45 minutes, walk through Amazon's sales rank by category in four steps.
<!-- /learn/design-sales-rank -->

1. **Use cases and numbers.** Compute each category's best sellers over the past week, show them, and keep serving a slightly old ranking if something fails.
   - 1 billion sales a month: about 400 a second. 100 billion reads a month: about 40,000 a second, 120,000 at peak.
   - About 42 bytes a sale: about 40 GB a month and 1.5 TB over three years. One weekly run reads about 10 GB.
2. **High-level design.** A Sales API appends sales to hourly log files in an object store. An hourly Sales Rank Service job writes a `sales_rank` table in SQL, and a Read API serves it.
3. **Core components.**
   - Two MapReduce passes: sum units per (category, product) inside the window, then a secondary sort on (category, −total, product), partitioned by category, keeping the top N.
   - Each run writes rows under a new `run_id`, and one update to `sales_rank_current` publishes it all at once.
4. **Scale.** Reads ask for one of only 1,000 small lists, so a memory cache filled by the job and a CDN answer nearly all of them, with read replicas for misses. Sales never touch the serving database. A data warehouse handles analytics.

<!-- chapter: design-scaling-aws -->

## Talk through growing a site to 10 million users on AWS in 45 minutes. What are your four steps?
<!-- /learn/design-scaling-aws -->

1. **Use cases and numbers.** Users read and write; the service grows from one user to millions and stays available.
   - At full size, 1 billion writes and 100 billion reads a month: about 400 writes and 40,000 reads a second.
   - 1 KB a write: 1 TB a month, 36 TB over three years.
2. **High-level design.** One EC2 instance running the app and MySQL, an Elastic IP, Route 53 and CloudWatch.
3. **Core components.** Scale vertically at first, watch CPU, memory, disk and network, and open only ports 80, 443 and SSH from your own network.
4. **Scale in stages,** each fixing a measured bottleneck:
   - 100 users: S3 for files, RDS for MySQL, a VPC.
   - 1,000: a load balancer, two Availability Zones with RDS Multi-AZ, separate web and app tiers, CloudFront.
   - 100,000: ElastiCache for hot data and sessions, MySQL read replicas.
   - 500,000: Auto Scaling, automation, deeper monitoring.
   - 10 million: archiving to Redshift, federation and sharding, DynamoDB, SQS and workers.

<!-- chapter: design-url-shortener -->

## You have 45 minutes to design a URL shortener. Outline your four steps.
<!-- /learn/design-url-shortener -->

1. **Requirements and numbers.** Shorten, redirect, optional custom alias and expiry, click stats. Redirects must be fast and highly available.
   - 100 million new links a month (about 39 a second) and 100 redirects per link: about 3,860 redirects a second, 11,600 at peak.
   - 6 billion links over five years at about 500 bytes: 3 TB. Caching 20% of a day's requests takes about 33 GB.
2. **High-level design.** Load balancer, stateless API servers, Redis cache, a sharded URL database, an ID range allocator, and click events through Kafka to analytics workers and ClickHouse.
3. **Core components.**
   - Base62-encode a unique counter handed out in ranges: 7 characters, about 3.52 trillion codes, no collisions to check.
   - Redirect with 302 to count clicks and disable bad links fast, or 301 to cut load.
   - The redirect only reads and publishes a click event; it never writes a counter.
4. **Scale.** Shard by a hash of the short code, cache-aside with LRU and a TTL, check expiry on read plus batched cleanup, scramble the counter against enumeration, and rate limit link creation.

<!-- chapter: design-social-news-feed -->

## In 45 minutes, how would you design a social media news feed?
<!-- /learn/design-social-news-feed -->

1. **Requirements and numbers.** Publish, view the feed, follow, and scroll without repeats or gaps. First page under 200 ms at p99; a few seconds' delay is fine.
   - 300 million daily users following 300 accounts each; 100 million posts a day, about 3,500 a second at peak.
   - About 100,000 feed loads a second at peak. Pure push would mean about 1 million timeline inserts a second at peak.
   - Timelines of 500 post ids in Redis sorted sets: about 10 TB.
2. **High-level design.** Post service, posts database sharded by `user_id`, Kafka post events, fan-out workers, follow graph, timeline cache, feed service and ranking service.
3. **Core components.**
   - Hybrid fan-out: push ordinary authors' posts; pull celebrities' recent posts (above say 100,000 followers) at read time; skip inactive followers.
   - Keyset (cursor) pagination on `(created_at, post_id)` instead of `OFFSET`.
4. **Ranking and scale.** Gather a few hundred candidates, score them with a model (affinity, content type, freshness decay, early engagement), and replicate celebrities' post lists as hot keys.

<!-- chapter: design-gaming-leaderboard -->

## Walk through a real-time gaming leaderboard design in 45 minutes. What goes in each step?
<!-- /learn/design-gaming-leaderboard -->

1. **Requirements and numbers.** Update scores, top K, my rank, players around me, seasons. A result shows within about a second and a confirmed score is never lost.
   - 10 million daily players × 10 matches: about 1,160 updates a second, about 6,000 at peak, and about 20,000 reads a second.
   - About 100 bytes a player in a sorted set: 10 GB for 100 million players.
2. **High-level design.** Game servers report results to API servers, which publish to Kafka keyed by player. Score workers record the match in PostgreSQL, then update a Redis primary. Reads go to Redis replicas.
3. **Core components.**
   - Rank by SQL `COUNT(*)` walks millions of index entries. A Redis sorted set (hash table plus skip list with spans) gives rank in O(log N).
   - A unique `match_id` in PostgreSQL turns a redelivered event into a no-op before `ZINCRBY`.
   - Ties: pack points and (2²⁴ − 1 − elapsed seconds) into one score, so whoever got there first ranks higher.
4. **Scale.** One primary plus read replicas, with the top 100 cached for a second or two. Shard by player ID if needed (score-range shards get skewed). One key per season, archived at close.

<!-- chapter: design-payment-system -->

## How would you spend 45 minutes designing a payment system?
<!-- /learn/design-payment-system -->

1. **Requirements and numbers.** Charge through a PSP, retry safely, support authorize, capture, void and refund, keep a double-entry ledger, reconcile daily. Correctness comes before availability, and PCI DSS applies.
   - 10 million payments a day: about 116 a second, about 1,200 at a 10× sales peak.
   - About 1 KB each: 10 GB a day, about 18 TB over five years. A replicated relational database is enough.
2. **High-level design.** Payment service, payments database (state and idempotency keys), PSP gateway, ledger database, webhook receiver, reconciliation job.
3. **Core components.**
   - Idempotency keys: claim the key with a unique insert, return the stored reply on a retry, and pass a derived key to the PSP.
   - A state machine (INITIATED, AUTHORIZED, CAPTURED, FAILED, VOIDED, EXPIRED, REFUNDED) with updates guarded by the current state.
   - An append-only double-entry ledger where debits equal credits, with amounts as integers in minor units.
4. **Reliability and compliance.** Reconcile PSP settlement reports against the database and ledger, joined on the PSP transaction ID. Card fields in the PSP's iframe keep card numbers off your servers.

<!-- chapter: design-collaborative-document -->

## Talk through a collaborative document editor like Google Docs in 45 minutes. What are the four steps?
<!-- /learn/design-collaborative-document -->

1. **Requirements and numbers.** Real-time multiplayer editing, presence and cursors, revision history, offline editing. Local typing is instant, remote edits arrive within about 100 ms, all copies converge, and acked edits are durable.
   - 100,000 open documents × 3 people: 300,000 WebSocket connections.
   - About 500,000 operations a second in and 1 million messages a second out; the operation log grows about 1.1 TB a day before compaction.
2. **High-level design.** WebSocket gateways, exactly one collaboration worker per document, an append-only operation log, a snapshot worker writing to object storage, Redis for presence.
3. **Core components.**
   - Merge concurrent edits with OT (transform index operations against the server's order) or a CRDT (permanent character IDs and tombstones).
   - Ack an edit only after its log append is durable; clients resend unacked operations.
4. **Edge cases and scale.** Presence is ephemeral and throttled to about 20 updates a second. A version is a snapshot plus later operations. Offline edits are transformed (OT) or merged by exchanging state vectors (CRDT).

<!-- chapter: design-search-engine -->

## In 45 minutes, how would you walk through the design of a web search engine?
<!-- /learn/design-search-engine -->

1. **Requirements and numbers.** Return the 10 best pages with snippets under 200 ms at p99, crawl continuously, and keep the query path 99.99% available.
   - 50 billion pages: about 1 PB of text and about 300 TB of compressed positional index.
   - 100,000 queries a second at peak over 500 shards: 50 million shard queries a second.
2. **High-level design.** A crawler with a frontier, an indexing pipeline, a document store, and a query path of frontend, query cache, aggregator and replicated index shards.
3. **Core components.**
   - Frontier: front queues for priority, per-host back queues and a heap for politeness. SimHash for near-duplicates.
   - An inverted index with positions, compressed with gaps, variable-byte or block encoding.
   - Partition by document: every query goes to every shard, and each returns its top ~100.
4. **Ranking and scale.** BM25 plus PageRank with WAND inside each shard, then light and heavy re-ranking. Replicas, hedged requests and deadlines contain tail latency.

<!-- chapter: design-recommendation-system -->

## How would you design a personalized recommendation system in 45 minutes?
<!-- /learn/design-recommendation-system -->

1. **Requirements and numbers.** Return 20 items for the user, react to this session, mix in new items. p99 under 100 ms; a degraded feed beats an error.
   - 500 million daily users × 10 refreshes: about 116,000 requests a second at peak.
   - 1 billion items: about 1 TB of 256-dimension embeddings. Ranking 1,000 candidates means about 116 million model evaluations a second.
2. **High-level design.** A stateless feed service with a session store, candidate retrieval with a vector index, a ranker fed by an online feature store, and a re-ranker. Each stage has a fallback.
3. **Core components,** a three-stage funnel:
   - Retrieval: two-tower embeddings with ANN search (HNSW), sharded or compressed, plus item-to-item, trending and subscription sources: about 1,000 candidates.
   - Ranking: a multi-task model (MMoE) predicting click, long watch, completion, like and dislike, with a feature store to avoid training-serving skew.
   - Re-ranking: MMR for diversity and bandits (UCB, Thompson sampling) for exploration.
4. **Latency budget.** Retrieval 25 ms, features 10, ranking 35, re-ranking 10, inside 100 ms in total.

<!-- chapter: design-key-value-store -->

## Talk through a distributed key-value store design in 45 minutes. What are the four steps?
<!-- /learn/design-key-value-store -->

1. **Requirements and numbers.** Put, get, delete and optional TTL. Always writable, tunable consistency, single-digit ms p99, survives losing a zone.
   - 5 billion keys × 2 KB = 10 TB, or 30 TB with 3 replicas.
   - 300,000 reads and 60,000 writes a second at peak. Storage needs 15 nodes; read throughput sets 24 (8 per zone).
2. **High-level design.** Leaderless Dynamo-style nodes, consistent hashing with virtual nodes, zone-aware preference lists of N = 3, any node as coordinator, gossip membership, an LSM engine per node.
3. **Core components.**
   - Quorums: R + W > N, with N = 3, W = 2, R = 2 as the usual default.
   - Conflicts: last-writer-wins, or vector clocks that return siblings for the app to merge.
   - Sloppy quorum with hinted handoff; read repair and Merkle-tree anti-entropy.
   - LSM: commit log, memtable, SSTables with Bloom filters, compaction, tombstones.
4. **Scale.** Add nodes by streaming token ranges; handle hot keys, cap values at 1 MB, and use speculative retry for tail latency.

<!-- chapter: design-notification-system -->

## How would you design a notification system in 45 minutes?
<!-- /learn/design-notification-system -->

1. **Requirements and numbers.** Send to a user or an audience over push, email, SMS and in-app; respect preferences; templates; sends scheduled in local time; status tracking.
   - 136.5 million a day: about 1,600 a second on average.
   - A presale to 8 million followers by push and email in 15 minutes: about 17,800 a second. Campaigns set the capacity.
2. **High-level design.** A notification service (validates, checks the idempotency key, returns 202), a per-user router (preferences, rate limits, quiet hours), a queue and worker pool per channel, and a tracking service.
3. **Core components.**
   - Queues split by priority as well as channel, so bulk campaigns never delay login codes.
   - Retry transient errors with backoff and jitter, never permanent ones, and send exhausted messages to a dead-letter queue.
   - Dedupe with idempotency keys and a conditional queued-to-sending write. Exactly-once delivery to a phone isn't possible.
4. **Scale.** Batched, checkpointed campaign fan-out; cached preferences with short TTLs; workers sized to provider quotas; deliveries partitioned by `user_id`; IANA time zones for scheduling.

<!-- chapter: design-chat-system -->

## Walk through a chat system design in 45 minutes. What goes in each of the four steps?
<!-- /learn/design-chat-system -->

1. **Requirements and numbers.** 1:1 and group chats, presence, sent, delivered and read receipts, history on every device, push for offline users. Nothing lost after "sent", and one order for everyone.
   - 200 million daily users × 40 messages: about 92,600 a second, about 300,000 at peak.
   - 200 bytes a message: 1.6 TB a day. 50 million connections at peak need about 200 connection servers.
2. **High-level design.** WebSocket connection servers, a chat service, a message store, a session registry mapping users to devices and servers, and a push service.
3. **Core components.**
   - A server-assigned per-conversation `seq` for order and gap detection, a unique `msg_id`, and `client_msg_id` to drop resent duplicates.
   - A wide-column store partitioned by `(conv_id, bucket)` and sorted by `seq`.
   - Read receipts as a high-water mark per member; a sync cursor per device.
4. **Scale.** Store once, then fan out through a queue partitioned by `conv_id`. Large groups drop receipts and live delivery. Each conversation has a home region.

<!-- chapter: design-autocomplete -->

## How would you design search autocomplete in 45 minutes?
<!-- /learn/design-autocomplete -->

1. **Requirements and numbers.** The top 8 completions for a prefix, ranked by recent popularity and filtered for unsafe content. It must feel instant: about 100 ms end to end, under 10 ms on the server.
   - 720 million searches a day × 5 requests: about 83,000 requests a second at peak before caching.
   - About 300 million prefixes × 100 bytes ≈ 30 GB, about 32 GB in all, which fits on one large server.
2. **High-level design.** Online: browser, CDN, then a suggest service reading an in-memory index. Offline: search logs, aggregation, a builder and versioned snapshots. A streaming job adds trending queries.
3. **Core components.**
   - Score queries by exponentially decayed window counts, and drop queries typed by too few distinct users.
   - Store prefix to top-k as a trie with cached lists or as a flat prefix table (easier to shard and cache).
4. **Scale.** Full replicas first, then shard by language and hashed prefix. Browser and CDN caching, client debounce and stale-response dropping, and a serve-time removal list plus CDN purge.

<!-- chapter: design-video-streaming -->

## Talk through a video streaming platform design in 45 minutes. What are the four steps?
<!-- /learn/design-video-streaming -->

1. **Requirements and numbers.** Upload, transcode and publish; playback that starts fast and switches quality smoothly; view counts; resumable uploads.
   - 40 million viewers × 45 minutes at 3 Mbps: 1.25 million concurrent, about 9 Tbps at peak, about 40 PB a day out.
   - 500,000 uploads a day at about 600 MB: 300 TB a day in. Egress is over 100 times ingress.
2. **High-level design.** API servers, sharded SQL metadata, object storage for sources and segments, a transcoding workflow, and a CDN.
3. **Core components.**
   - Pre-signed multipart uploads straight to object storage.
   - A task DAG: probe, split at keyframes, encode every rung in parallel, package, publish the low rungs first. Tasks are idempotent.
   - Adaptive bitrate (HLS or DASH, CMAF segments of 2 to 6 seconds): the player picks a rung per segment.
4. **Scale.** The CDN serves almost all playback. Spend extra encoding on popular videos, use tiered caches and request collapsing, and count views in batches.

<!-- chapter: design-file-sync -->

## How would you design a file sync service like Dropbox in 45 minutes?
<!-- /learn/design-file-sync -->

1. **Requirements and numbers.** Sync files across devices, edit offline, share folders, keep versions, and never lose an acknowledged file.
   - 200 million users × 8 GB: 1.6 EB of content. Metadata is about 120 TB.
   - About 15,600 metadata commits a second at peak, and 18 million clients waiting for changes.
2. **High-level design.** A strongly consistent metadata service with an append-only journal per namespace, a block service on object storage, and a notification tier.
3. **Core components.**
   - Content-addressed blocks: hash each block and upload only missing ones, which gives dedup, integrity checks and resumable uploads. Fixed-size or content-defined chunks.
   - Commit with `base_rev` as a compare-and-set. A mismatch returns 409 and the client saves a conflicted copy.
   - Write blocks first, metadata second.
4. **Scale.** Shard metadata by namespace and the block index by hash, long-poll `changes/wait`, cache popular blocks in a CDN, and keep versions cheaply as old journal entries.
