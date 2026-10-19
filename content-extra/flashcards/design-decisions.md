<!-- chapter: design-pastebin -->

## What usage numbers does the Pastebin design assume, and what do they work out to?
<!-- /learn/design-pastebin#calculate-usage -->

- **10 million** users, 10 million paste writes and 100 million paste reads per month (10:1 reads to writes).
- About 1.27 KB per paste, so 12.7 GB of new content per month and about 450 GB in 3 years.
- 360 million shortlinks in 3 years.
- About **4 writes per second** and **40 reads per second** on average.

## In the Pastebin design, how is the short link generated and why Base 62?
<!-- /learn/design-pastebin#generating-the-short-code -->

Take an **MD5** hash of the client's IP address, the current time and some random bytes. Reduce the number modulo 62^7, then Base 62 encode it to 7 characters. Base 62 uses only 0-9, a-z and A-Z, which are all safe in a URL. Base 64 adds + and /, which have special meanings in URLs. Seven characters give 62^7 ≈ 3.52 trillion codes, so 360 million links in 3 years use about 0.01% of them.

Two details matter. Cutting the first 7 characters of a full 128-bit encoding would use only about 450 billion codes, which is why you reduce modulo 62^7 first. And the random bytes stop two people behind one IP address, pasting in the same millisecond, from getting the same code on every retry.

## In the Pastebin design, what happens if the generated short link already exists?
<!-- /learn/design-pastebin#generating-the-short-code -->

The Write API just inserts the row. `shortlink` is the primary key, which creates an index the database uses to enforce uniqueness, so a duplicate insert fails and the API retries with a new code. With 360 million pastes stored, a new code collides about once in 9,800 tries, so the retry is cheap. A custom alias, if the product adds one, goes through the same insert and the same check.

## Where does the Pastebin design keep the paste text, and where does it keep the metadata?
<!-- /learn/design-pastebin#where-the-text-lives -->

The `pastes` table in a SQL database acts as a large hash table: shortlink, expiry settings, created_at and a `paste_path`. The paste text goes to a managed **object store** such as Amazon S3, so you don't run file servers. A read looks up the shortlink in SQL, then fetches the text from the object store.

Over three years that keeps about 98 GB of metadata in the database and 360 GB of text out of it. The cost is a second, slower read on a cache miss and two writes with no shared transaction, so the text is written first. A NoSQL key-value store is the named alternative to SQL for the table.

## How does the Pastebin design handle monthly analytics and expired pastes?
<!-- /learn/design-pastebin#use-case-service-tracks-analytics-of-pages -->

- **Analytics**: real-time counts aren't required, so a daily MapReduce job over the web server access logs counts views per paste per month. Once a CDN serves raw pastes, the job must read the CDN's logs too.
- **Expiry**: the Read API checks `expires_at` on every read, so an expired paste looks gone at once. A cleanup job then uses an index on `expires_at` to delete expired rows and files in small batches, or marks the rows expired.

## At Pastebin's 40 reads and 4 writes per second, what handles the load when scaling?
<!-- /learn/design-pastebin#step-4-scale-the-design -->

One server could handle the average load, so scaling is about availability and uneven traffic:
- A **CDN** serves raw pastes, so a viral paste becomes a few requests to your servers.
- A load balancer and more web servers remove the single point of failure.
- A **memory cache** serves popular pastes and absorbs spikes. Its TTL never outlives the paste.
- A SQL **primary with read replicas** and failover. Replicas handle cache misses, and four writes a second is well within one primary.

S3 comfortably handles 12.7 GB of new text a month, and an analytics database could use Redshift or BigQuery.

<!-- chapter: design-twitter -->

## What usage numbers does the Twitter design assume, and what do they work out to?
<!-- /learn/design-twitter#calculate-usage -->

- 100 million active users, 500 million tweets a day, each delivered to 10 followers on average.
- About 10 KB per tweet, almost all of it media: 150 TB of new content a month, 5.4 PB in 3 years.
- About **5,800 tweets a second** and **58,000 fan-out deliveries a second** on average.
- About **96,000 reads a second** and 3,900 searches a second on average.

## In the Twitter design, why fan out tweets on write into a memory cache instead of a SQL database?
<!-- /learn/design-twitter#use-case-user-posts-a-tweet -->

Twitter is read heavy, so you optimize for fast timeline reads by precomputing each follower's home timeline. The **fan-out service** inserts the tweet into every follower's timeline. At 58,000 deliveries a second on average and 175,000 at peak, a relational database would be overloaded, because every insert updates indexes and writes a log to disk. So it writes to a store with very fast writes, like a memory cache or NoSQL. The author's own tweets still go to SQL, as the user timeline.

## In the Twitter design, what does the Fan Out Service do when a user posts a tweet?
<!-- /learn/design-twitter#use-case-user-posts-a-tweet -->

- Asks the user graph service for the author's followers.
- Adds the tweet to each follower's home timeline in the memory cache (1,000 followers means 1,000 lookups and inserts), in pipelined batches.
- Adds the tweet to the search index.
- Asks the notification service to send push notifications and emails, which it does through a queue.

Media isn't its job: the write API stores photos and videos in the object store before handing the tweet to fan-out.

## In the Twitter design, what is stored in each home timeline entry in Redis, and how is a timeline read served?
<!-- /learn/design-twitter#use-case-user-views-the-home-timeline -->

Each entry in a Redis list is 17 bytes: tweet_id (8 bytes), user_id (8 bytes) and 1 byte of flags. To serve a timeline, the timeline service reads the ids from the memory cache with `LRANGE`, whose cost depends only on the entries read, not on how many people the user follows. It then does a **multiget** to the tweet info service and another to the user info service, each O(n) in the tweets on the page.

## In the Twitter design, what's the problem with users who have millions of followers, and how do you fix it?
<!-- /learn/design-twitter#the-fan-out-service-and-users-with-many-followers -->

Their tweets can take minutes to fan out, which causes race conditions: a reply can be delivered before the tweet it answers. You can re-order tweets at serve time by `tweet_id`. The better fix is to skip fan-out for highly followed users, above a threshold such as 100,000 followers. On a read, fetch their recent tweets (by search or from their cached user timelines), merge them into the user's home timeline, then re-order at serve time.

## How does the Twitter design keep the home timeline cache small?
<!-- /learn/design-twitter#keeping-the-memory-cache-small -->

- Keep only several hundred tweets per home timeline (800, about 13.6 KB per user).
- Keep only active users' timelines in the cache.
- If a user wasn't active in the past 30 days, rebuild the timeline from SQL: ask the user graph service who they follow, fetch those tweets, add them to the cache.
- Store only a month of tweets in the tweet info service and only active users in the user info service.
- Replicate each timeline, so losing a cache server doesn't force millions of rebuilds at once.

<!-- chapter: design-web-crawler -->

## What usage numbers does the web crawler design assume, and what do they work out to?
<!-- /learn/design-web-crawler#calculate-usage -->

- 1 billion links, refreshed about weekly, so about 4 billion fetches a month.
- 500 KB per page: **2 PB** of stored content a month, 72 PB in 3 years if every copy is kept (500 TB for the latest copy only).
- 100 billion searches a month.
- About **1,540 pages fetched a second** (6.2 Gbit/s inbound) and **38,600 searches a second** on average.

## In the web crawler design, where are links_to_crawl and crawled_links stored, and why Redis sorted sets?
<!-- /learn/design-web-crawler#the-seed-list-and-the-two-tables -->

Both tables live in a key-value NoSQL database, since every access is by one URL and a billion rows must be split across machines. `crawled_links` holds fetched pages with their signatures and crawl times. `links_to_crawl` is the frontier, ranked by priority (initially overall site popularity), so a Redis **sorted set** keeps the ranking. `ZADD` adds a URL and `ZPOPMAX` takes the top-ranked one, each in O(log N).

## In the web crawler design, what does the Crawler Service do on each pass of its loop?
<!-- /learn/design-web-crawler#the-crawler-loop -->

1. Take the highest-priority URL from links_to_crawl.
2. Check that the site's robots.txt allows it, then fetch the page.
3. Compute the page's signature and look in crawled_links for the same or a very similar one. If found, the page is a copy: put the URL back with a lower priority and continue.
4. Otherwise queue jobs for the reverse index service and the document service, and record the URL and signature in crawled_links.
5. Extract the page's links, normalize them, and add the new ones to links_to_crawl.

## How does the web crawler design avoid getting stuck in an infinite loop?
<!-- /learn/design-web-crawler#handling-duplicates -->

A loop happens when the link graph has a cycle. The crawler checks for repeats twice:
- **Before fetching, by URL.** URLs already queued or crawled aren't added again, which stops most cycles. Repeats are removed from large URL lists with `sort -u` on one machine or a MapReduce job for 1 billion links, and a Bloom filter gives a fast "seen?" check in between.
- **After fetching, by content.** A page whose signature matches one already crawled is demoted, not indexed. Near-duplicates are caught with shingles and the Jaccard index (estimated with MinHash), cosine similarity, or SimHash.

Crawler traps that generate endless distinct pages need limits too: per-host page budgets and caps on URL length and depth.

## In the web crawler design, how do you decide when to re-crawl a page?
<!-- /learn/design-web-crawler#determining-when-to-update-the-crawl-results -->

Each row in crawled_links has the time of its last crawl. After a default period, say one week, every page is due again, and popular or frequently updated sites sooner. A better policy learns each page's rate of change from whether its signature changed, and sets the interval from it, within a floor and a ceiling. Don't recrawl purely in proportion to change rate: Cho and Garcia-Molina found that kept pages less fresh. Conditional requests (`304 Not Modified`) and sitemap `<lastmod>` dates make recrawling cheaper.

## What optimizations does the web crawler design suggest for the crawling service itself?
<!-- /learn/design-web-crawler#scaling-the-crawler-service -->

- Partition crawlers by host hash, matching the frontier shards, so each enforces politeness for its own hosts.
- Keep its own DNS cache, refreshed periodically, since DNS lookups can become the bottleneck.
- Keep thousands of fetches open with asynchronous I/O, and reuse connections to the same host (**connection pooling**).
- UDP helps only where it applies: DNS queries already use it, and HTTP/3 runs over QUIC on UDP. Page fetches otherwise use TCP.
- Provision enough bandwidth (6.2 Gbit/s around the clock) and put raw pages in object storage.

<!-- chapter: design-mint -->

## What usage numbers does the Mint design assume, and which way does the read/write ratio lean?
<!-- /learn/design-mint#calculate-usage -->

It's **write heavy**: 10:1 writes to reads, since users transact daily but few visit daily.
- 10 million users, 30 million accounts, 5 billion transactions a month.
- About 50 bytes per transaction: 250 GB a month, 9 TB in 3 years.
- **2,000 transactions per second**, 200 reads per second.

## In the Mint design, why extract transactions through a queue?
<!-- /learn/design-mint#use-case-service-extracts-transactions-from-the-account -->

Extracting transactions could take a while, so the Accounts API puts a job on a queue (SQS or RabbitMQ) and the Transaction Extraction Service works asynchronously. This adds complexity. Extraction runs when the account is first linked, on manual refresh, and daily for users active in the past 30 days.

## In the Mint design, what does the Transaction Extraction Service do with each job?
<!-- /learn/design-mint#use-case-service-extracts-transactions-from-the-account -->

- Pulls transactions from the financial institution and stores them as raw log files in the Object Store.
- Categorizes each one with the Category Service.
- Aggregates monthly spending by category with the Budget Service, which notifies users near or over budget.
- Updates the transactions and monthly_spending tables, then notifies the user.

## In the Mint design, how does the Category Service map a transaction to a category?
<!-- /learn/design-mint#category-service -->

First normalize the messy seller string from the bank, then look it up in order:
1. The user's own rule, such as "always put Costco under Food".
2. A **seed map** from popular sellers to categories. 50,000 sellers at under 255 bytes each is only about 12.75 MB, small enough for every extractor's memory.
3. **Crowd votes** from users' manual overrides. Keep a counter per seller and remember the current leader, so both a vote and a lookup are O(1). A heap would make each vote cost O(log n). A minimum number of votes stops one user's odd choice from changing it for everyone.
4. Otherwise "Uncategorized".

## Why doesn't the Mint design store all 100 million budget items?
<!-- /learn/design-mint#use-case-service-recommends-a-budget -->

It starts every user on a generic **budget template** that allocates category amounts by income tier. Only categories the user overrides are stored, in a budget_overrides table. So you store the exceptions, not every user's 10 categories.

## In the Mint design, how is monthly spending by category computed without loading the database?
<!-- /learn/design-mint#computing-monthly-spending -->

Run MapReduce jobs on the raw transaction files in the Object Store to categorize each transaction and sum spending per user, month and category. This could significantly reduce database load compared to SQL queries on the transactions table. If a user changes a category, call the Budget Service to re-run the analysis.

## At 2,000 writes per second, what does the Mint design change when scaling?
<!-- /learn/design-mint#scaling-the-writes -->

2,000 writes a second on average, and about 7,700 during the nightly update, might be too much for a single SQL primary, so consider federation, sharding `transactions` by `user_id`, denormalization, SQL tuning (batch inserts, monthly partitions) or a wide-column NoSQL store. Keep only recent months of transactions in the database and the rest in a data warehouse or object store. Move monthly_spending to an analytics database like Redshift. Cache sessions, per-category totals and recent transactions with cache-aside, and serve misses from read replicas.

<!-- chapter: design-social-graph -->

## What usage numbers does the social graph design assume?
<!-- /learn/design-social-graph#calculate-usage -->

- 100 million users with 50 friends each on average: **5 billion** friend-list entries. Each friendship appears in both lists, so that's 2.5 billion friendships, about 40 GB of 8-byte ids.
- 1 billion friend searches a month, about **400 searches per second**.
- Edges are unweighted, and the graph won't fit on a single machine.
- No graph databases allowed: use traditional systems.

## In the social graph design, why is shortest path a BFS, and what makes it hard at this scale?
<!-- /learn/design-social-graph#use-case-user-searches-for-someone-and-sees-the-shortest-path-to-the-searched-person -->

Edges are unweighted, so a general **BFS** from the current user finds the shortest path. The problem is that the graph won't fit on one machine. Users are sharded across Person Servers, so each hop to an adjacent node may need a lookup to find which server holds that person.

## In the social graph design, what do the Lookup Service and Person Servers do?
<!-- /learn/design-social-graph#use-case-user-searches-for-someone-and-sees-the-shortest-path-to-the-searched-person -->

- **Lookup Service**: maps person_id to the Person Server that stores that person.
- **Person Server**: holds people by id, each with a list of friend_ids.
- **User Graph Service**: runs the BFS and holds its state (the queue and parent map of ids). For each person it expands, it asks the Lookup Service which server holds them, then fetches their record from that Person Server.

## How can the social graph design reduce machine jumps during a BFS?
<!-- /learn/design-social-graph#cut-the-cost-of-each-cross-server-hop -->

- Compute the shard from the person id, such as `hash(person_id) mod 4096`, so a small shard-to-server table replaces most lookup calls.
- Batch the friend lookups of one BFS ring by Person Server, and send the batches in parallel: one round of calls per ring.
- Shard Person Servers by location, since friends tend to live near each other. The gain is limited in a tightly connected graph, so measure it.
- Cache friend lists and complete or partial BFS traversals in a memory cache, or batch compute 2-step neighborhoods offline into NoSQL.

## What search tricks does the social graph design suggest to make each BFS finish faster?
<!-- /learn/design-social-graph#step-4-scale-the-design -->

- Run **two BFS searches** at once, from source and destination, and join the paths where they meet. For a target 4 steps away that's about 102 friend-list reads instead of 127,551. Expand whichever side has the smaller frontier.
- Expand people with many friends first, since they likely cut the degrees of separation. This finds a short path sooner, but no longer guarantees the shortest one.
- Set a hop limit (3rd degree, as LinkedIn does) or a time limit, then ask the user whether to keep searching.

<!-- chapter: design-query-cache -->

## What usage numbers does the query cache design assume, and why can't it cache everything?
<!-- /learn/design-query-cache#calculate-usage -->

10 million users and 10 billion queries a month, about **3,860 requests per second** (roughly 4,000), with about 11,600 at peak. With one result, an entry (query, title, snippet) is about 270 bytes. A full page of 10 results with URLs is about 3 KB. If every query were unique and stored, that's 2.7 TB a month with one result and **30.5 TB** a month with ten. Even the 100 million most popular queries need about 315 GB. Memory is limited, so you need to decide what to expire.

## In the query cache design, which eviction policy is used and what happens on a hit?
<!-- /learn/design-query-cache#use-case-user-sends-a-request-resulting-in-a-cache-hit -->

The cache has limited capacity, so it uses **least recently used (LRU)** to expire older entries. On a hit, the cached entry moves to the front of the LRU list and its contents are returned. On a miss, the Query API asks the Reverse Index Service and Document Service, then puts the result at the front of the list.

## How is the query cache built so lookups and evictions are both fast?
<!-- /learn/design-query-cache#cache-implementation -->

A **doubly linked list** keeps recency order: new and newly used items go at the head, items to expire come off the tail. A **hash table** maps each query to its linked list node, giving fast lookups to any node. Both get and set are O(1). The list must be doubly linked so a node can be unlinked from the middle in O(1), and each node stores its key so eviction can delete it from the hash table.

## In the query cache design, when should cached results be updated, and what's the simple way to do it?
<!-- /learn/design-query-cache#when-to-update-the-cache -->

Update when page contents change, a page is removed or added, or page rank changes. The cache is keyed by query, so there's no cheap way to find every entry a changed page appears in. The most straightforward approach is a **TTL**: a max time an entry can stay in the cache before it's refreshed, shorter for news-like queries and longer for stable ones. Versioned keys handle index rebuilds, and a blocklist handles removals that can't wait. The overall pattern is cache-aside.

## You need to spread the query cache across many machines. Which of the three options does the design pick, and why?
<!-- /learn/design-query-cache#expanding-the-memory-cache-to-many-machines -->

- Each machine has its own cache: simple, but a low hit rate.
- Each machine has a full copy: simple, but wastes memory.
- **Shard the cache** across machines: more complex, but the best. Pick the machine from a hash of the key. Use consistent hashing: with `hash mod N`, going from 6 machines to 7 moves about 86% of keys, while a ring moves about 1/7.

<!-- chapter: design-sales-rank -->

## What usage numbers does the sales rank design assume, and what do they work out to?
<!-- /learn/design-sales-rank#calculate-usage -->

- 10 million products, 1,000 categories.
- 1 billion transactions and 100 billion reads a month (100:1 reads to writes).
- About 42 bytes per transaction, call it 40: about 40 GB a month, about 1.5 TB in 3 years.
- About **400 transactions per second** and **40,000 reads per second** on average, about three times that at peak.
- Results must update at least hourly. One run over the past week reads about 10 GB.

## In the sales rank design, how is the past week's ranking computed?
<!-- /learn/design-sales-rank#the-ranking-job-two-passes-of-mapreduce -->

The Sales API appends each sale to log files in an object store like S3, under hourly prefixes, so a run reads exactly the past week's 168 hours. Every hour the Sales Rank Service runs **two MapReduce passes**:
1. **Count:** keep sales inside the window and sum quantity per (category_id, product_id).
2. **Sort:** key each total as (category_id, −total, product_id), partition by category only, and let the shuffle do a distributed sort. The reducer assigns ranks and keeps the top N per category.

The results go into a `sales_rank` table in SQL under a new run_id, which is published with one update.

## In the sales rank design, why is the ranking precomputed instead of calculated per request?
<!-- /learn/design-sales-rank#use-case-user-views-the-past-weeks-most-popular-products-by-category -->

Reads are 100 times writes, every read asks for one of only 1,000 lists, and the lists only need hourly freshness. So an hourly batch job writes the `sales_rank` table, with an index on (run_id, category_id, rank_in_category) for "top N in this category" and one on (run_id, product_id) for a product's ranks. The Read API just reads it. A memory cache filled by the job, plus a CDN, absorbs the 40,000 reads a second.

## What strains SQL in the sales rank design at scale, and what are the options?
<!-- /learn/design-sales-rank#step-4-scale-the-design -->

Less than you'd expect. The serving database takes one bulk load an hour plus a one-row publish, because the 400 sales a second go to logs in the object store, never to SQL. The cache and CDN take nearly all reads, and a few read replicas handle the misses. A primary with a standby keeps publishing available.

SQL scaling patterns (federation, sharding `sales_rank` by category_id, denormalization, SQL tuning) or a key-value store matter only if the scope grows, for example to raw transactions in SQL. Keep raw history in the object store and load a limited period into a warehouse like Redshift or BigQuery for analytics.

<!-- chapter: design-scaling-aws -->

## What target numbers does the scaling on AWS exercise grow toward?
<!-- /learn/design-scaling-aws#calculate-usage -->

- 10 million users, 1 billion writes and 100 billion reads a month (100:1 reads to writes).
- 1 KB per write: 1 TB of new content a month, 36 TB in 3 years.
- **400 writes per second** and **40,000 reads per second** on average.

## In the scaling on AWS exercise, what does the starting setup look like and what's wrong with it?
<!-- /learn/design-scaling-aws#start-with-a-single-box -->

One box: a web server on EC2 with MySQL for user data. You scale vertically by choosing a bigger box and use basic monitoring (CPU, memory, IO, network) to find bottlenecks. The downsides: vertical scaling gets very expensive, and there's no redundancy or failover.

## How does the scaling on AWS exercise make the first single box reachable and safe?
<!-- /learn/design-scaling-aws#assign-a-public-static-ip -->

- An **Elastic IP** gives a static public IP. An automatic public IP is lost when the instance stops and starts, as it does for a resize; an Elastic IP stays the same and can move to a replacement server, which helps failover.
- **Route 53** DNS maps the domain to that IP.
- Open only ports 80 (HTTP), 443 (HTTPS) and 22 (SSH, whitelisted IPs only).
- Stop the web server from initiating outbound connections.

## At about 100 users in the scaling on AWS exercise, what two moves lighten the single box?
<!-- /learn/design-scaling-aws#stage-1-100-users-move-the-database-and-files-off-the-web-server -->

Vertical scaling got expensive and didn't let the database and web server scale independently. So:
- Move static content (user files, JS, CSS, images, videos) to an **Object Store** like S3.
- Move MySQL to its own box, using a managed service like **RDS**.
Then lock it down with a VPC: a public subnet for the web server, a private subnet for everything else.

## At about 1,000 users in the scaling on AWS exercise, the web server bottlenecks at peak. What do you add?
<!-- /learn/design-scaling-aws#stage-2-1000-users-add-a-load-balancer-and-a-second-availability-zone -->

- A **load balancer** (ELB or HAProxy) that terminates SSL.
- Multiple web servers across availability zones.
- The database in RDS Multi-AZ, with a standby in another zone that takes over on failure.
- Separate web servers from application servers so each layer scales on its own.
- A CDN like CloudFront for static content.

## At about 100,000 users the database suffers from heavy reads. What does the scaling on AWS exercise try, and in what order?
<!-- /learn/design-scaling-aws#stage-3-100000-users-add-a-cache-and-read-replicas -->

First, give MySQL more memory for its own cache (the InnoDB buffer pool). If that's not enough, move frequently accessed content to a **memory cache** like ElastiCache. Add **MySQL read replicas**, with web server logic to split reads from writes. Add more web and application servers.

## In the scaling on AWS exercise, why move session data into a memory cache?
<!-- /learn/design-scaling-aws#stage-3-100000-users-add-a-cache-and-read-replicas -->

With sessions in a Memory Cache instead of on the web servers, the web servers become **stateless**. Any server can handle any request, which is what makes autoscaling possible.

## Your traffic spikes during US business hours and drops at night. What does the scaling on AWS exercise add, and what's the catch?
<!-- /learn/design-scaling-aws#add-autoscaling -->

**Autoscaling**: one group per web server and per application server type, spread across availability zones, with min and max instance counts. Scheduled or predictive scaling handles the time-of-day pattern. Target tracking on a metric such as CPU, network traffic, requests per instance or a custom metric handles load you can't predict. Latency is a poor target, since it doesn't fall in proportion as servers are added. The catch: added complexity, and scaling lags behind demand while metrics arrive and new instances boot.

## At about 10 million users in the scaling on AWS exercise, how is slow, non-realtime work like thumbnail creation handled?
<!-- /learn/design-scaling-aws#stage-5-10-million-users-split-the-data-and-go-asynchronous -->

Run it asynchronously with **queues and workers**. The client uploads a photo, the application server puts a job on a queue like SQS, and a worker on EC2 or Lambda pulls it, creates the thumbnail, updates the database and stores the thumbnail in the Object Store. The same stage adds a data warehouse, SQL scaling patterns and NoSQL like DynamoDB.

<!-- chapter: ood-hash-table -->

## In the hash table OOD solution, how are collisions handled and how is the bucket chosen?
<!-- /learn/ood-hash-table#solution -->

The keys are integers, so the hash function is `key % size`. Collisions use **chaining**: each slot in the table is a list of `Item(key, value)` objects. `set`, `get` and `remove` hash to a slot, then scan its list for the matching key.

## In the hash table OOD solution, what happens when you set a key that already exists, or get one that doesn't?
<!-- /learn/ood-hash-table#solution -->

`set` scans the slot's list. If it finds the key, it updates that item's value in place. Otherwise it appends a new Item. `get` and `remove` raise a `KeyError` if the key isn't in the slot's list.

<!-- chapter: ood-lru-cache -->

## What two data structures make up the LRU cache OOD solution, and what does each do?
<!-- /learn/ood-lru-cache#solution -->

- A **hash map** (`lookup`) from query to linked list node, for fast access to any entry.
- A **doubly linked list** of nodes with prev and next pointers, ordered by recency. The most recent is at the front, the oldest at the tail.

## In the LRU cache OOD solution, what happens on get and on set when the cache is full?
<!-- /learn/ood-lru-cache#solution -->

- **get**: look up the node. If it exists, move it to the front and return its results.
- **set** on an existing key: update the results and move it to the front.
- **set** on a new key when size equals MAX_SIZE: remove the tail node from the list and the lookup, then add the new node at the front.

<!-- chapter: ood-call-center -->

## In the call center OOD problem, how does a call get routed through the employee levels?
<!-- /learn/ood-call-center -->

Operators always get the first call. If no operator is free or one can't handle it, the call goes to supervisors, then directors. Directors can handle all calls. If nobody can answer, the call is queued. VIP calls that jump the line are out of scope.

## What are the key classes in the call center OOD solution, and how is escalation modeled?
<!-- /learn/ood-call-center#solution -->

An abstract `Employee` with subclasses `Operator`, `Supervisor` and `Director`, each with a `Rank`. Each subclass overrides `escalate_call` to raise the call's level to the next rank. Directors raise an error instead. `CallCenter` dispatches a call to the first free employee at its rank or above, otherwise appends it to a `deque` of queued calls.

<!-- chapter: ood-deck-of-cards -->

## How does the deck of cards OOD solution stay generic but support blackjack?
<!-- /learn/ood-deck-of-cards#solution -->

Generic base classes `Card`, `Hand` and `Deck`, plus a `Suit` enum. Blackjack extends them: `BlackJackCard` overrides value so face cards (Jack, Queen, King) count 10 and an ace is 1. `BlackJackHand` overrides score.

## In the deck of cards OOD solution, how does BlackJackHand pick a score when aces make several possible?
<!-- /learn/ood-deck-of-cards#solution -->

It looks at every possible score, taking aces into account. It returns the highest score that is at or under 21. If every score is over 21, it returns the lowest one over 21.

<!-- chapter: ood-parking-lot -->

## In the parking lot OOD problem, which vehicles fit which spots?
<!-- /learn/ood-parking-lot -->

- Motorcycle spot: motorcycle only.
- Compact spot: motorcycle or car.
- Large spot: motorcycle or car.
- A bus needs **5 consecutive large spots**.
The lot also has multiple levels.

## What are the key classes in the parking lot OOD solution, and where does the fit logic live?
<!-- /learn/ood-parking-lot#solution -->

An abstract `Vehicle` with `Motorcycle`, `Car` and `Bus` subclasses, each with a spot_size (bus is 5) and its own `can_fit_in_spot`. `ParkingLot` holds `Level`s and tries each level in turn. A `Level` finds an available `ParkingSpot`. The spot checks it's empty, then asks the vehicle whether it fits.

<!-- chapter: ood-online-chat -->

## What are the key classes in the online chat OOD solution?
<!-- /learn/ood-online-chat#solution -->

- `UserService`: users by id, plus adding users and handling friend requests.
- `User`: friends, private chats by friend id, group chats, and sent and received friend requests.
- Abstract `Chat` (users and messages), with `PrivateChat` for two users and `GroupChat`, which can add and remove users.
- `Message`, and `AddRequest` with a `RequestStatus`.

## In the online chat OOD solution, how are friend requests modeled?
<!-- /learn/ood-online-chat#solution -->

As an `AddRequest` with from_user_id, to_user_id, a timestamp and a `RequestStatus`: UNREAD, READ, ACCEPTED or REJECTED. Each `User` keeps sent and received requests in dictionaries keyed by friend id, with methods to send, receive, approve and reject.
