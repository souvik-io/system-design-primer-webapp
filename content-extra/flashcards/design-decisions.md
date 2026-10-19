<!-- chapter: design-pastebin -->

## What usage numbers does the Pastebin design assume, and what do they work out to?
<!-- /learn/design-pastebin#calculate-usage -->

- **10 million** users, 10 million paste writes and 100 million paste reads per month (10:1 reads to writes).
- About 1.27 KB per paste, so 12.7 GB of new content per month and about 450 GB in 3 years.
- 360 million shortlinks in 3 years.
- About **4 writes per second** and **40 reads per second** on average.

## In the Pastebin design, how is the short link generated and why Base 62?
<!-- /learn/design-pastebin#use-case-user-enters-a-block-of-text-and-gets-a-randomly-generated-link -->

Take the **MD5** hash of the user's IP address plus a timestamp (or of random data), Base 62 encode it, and keep the first 7 characters. Base 62 uses only [a-zA-Z0-9], so the link needs no escaping in a URL. Base 64 adds + and /, which cause problems in URLs. Seven characters give 62^7 values, enough for 360 million links in 3 years.

## In the Pastebin design, what happens if the generated short link already exists?
<!-- /learn/design-pastebin#use-case-user-enters-a-block-of-text-and-gets-a-randomly-generated-link -->

The Write API checks the SQL database for a duplicate. If the URL isn't unique, it generates another one. Making shortlink the primary key creates an index the database uses to enforce uniqueness. A custom URL, if supported, would go through the same duplicate check.

## Where does the Pastebin design keep the paste text, and where does it keep the metadata?
<!-- /learn/design-pastebin#use-case-user-enters-a-block-of-text-and-gets-a-randomly-generated-link -->

The `pastes` table in a SQL database acts as a large hash table: shortlink, expiration, created_at and a `paste_path`. The paste contents go to a managed **Object Store** such as Amazon S3, so you don't run a file server. A read looks up the shortlink in SQL, then fetches the contents from the Object Store. A NoSQL key-value store is the named alternative to SQL.

## How does the Pastebin design handle monthly analytics and expired pastes?
<!-- /learn/design-pastebin#use-case-service-tracks-analytics-of-pages -->

- **Analytics**: realtime isn't required, so a MapReduce job over the web server logs counts hits per URL per month.
- **Expiry**: scan the SQL database for entries whose expiration timestamp is older than now, then delete them or mark them expired.

## At Pastebin's 40 reads and 4 writes per second, what handles the load when scaling?
<!-- /learn/design-pastebin#step-4-scale-the-design -->

A **Memory Cache** serves popular content and absorbs uneven traffic and spikes. SQL read replicas handle cache misses, as long as they aren't bogged down replicating writes. Four writes per second should be doable for a single SQL write master-slave. S3 comfortably handles 12.7 GB of new content a month, and an analytics database could use Redshift or BigQuery.

<!-- chapter: design-twitter -->

## What usage numbers does the Twitter design assume, and what do they work out to?
<!-- /learn/design-twitter#calculate-usage -->

- 100 million active users, 500 million tweets a day, average fanout of 10.
- About 10 KB per tweet: 150 TB of new content a month, 5.4 PB in 3 years.
- **6,000 tweets per second**, **60 thousand fanout deliveries per second**.
- **100 thousand reads per second**, 4,000 searches per second.

## In the Twitter design, why fan out tweets on write into a memory cache instead of a SQL database?
<!-- /learn/design-twitter#use-case-user-posts-a-tweet -->

Twitter is read heavy, so you optimize for fast timeline reads by precomputing each follower's home timeline. The **Fan Out Service** inserts the tweet into every follower's timeline. At 60 thousand deliveries per second, that would overload a traditional relational database, so it writes to a store with fast writes, like a Memory Cache or NoSQL. The user's own tweets still go to SQL.

## In the Twitter design, what does the Fan Out Service do when a user posts a tweet?
<!-- /learn/design-twitter#use-case-user-posts-a-tweet -->

- Queries the User Graph Service for the user's followers.
- Stores the tweet in each follower's home timeline in the Memory Cache (1,000 followers means 1,000 lookups and inserts).
- Stores the tweet in the Search Index Service.
- Stores media in the Object Store.
- Sends push notifications through the Notification Service, using a queue.

## In the Twitter design, what is stored in each home timeline entry in Redis, and how is a timeline read served?
<!-- /learn/design-twitter#use-case-user-views-the-home-timeline -->

Each entry in a native Redis list is a tweet_id (8 bytes), user_id (8 bytes) and 1 byte of meta. To serve a timeline, the Timeline Service gets these ids from the Memory Cache in O(1), then does a **multiget** to the Tweet Info Service and the User Info Service for the details, each O(n).

## In the Twitter design, what's the problem with users who have millions of followers, and how do you fix it?
<!-- /learn/design-twitter#step-4-scale-the-design -->

Their tweets could take several minutes to fan out, which can cause race conditions with @replies. You can re-order tweets at serve time. Or skip fanout for highly-followed users: search for their tweets, merge the results into the user's home timeline, then re-order at serve time.

## How does the Twitter design keep the home timeline cache small?
<!-- /learn/design-twitter#step-4-scale-the-design -->

- Keep only several hundred tweets per home timeline.
- Keep only active users' timelines in the cache.
- If a user wasn't active in the past 30 days, rebuild the timeline from SQL: ask the User Graph Service who they follow, fetch those tweets, add them to the cache.
- Store only a month of tweets in the Tweet Info Service and only active users in the User Info Service.

<!-- chapter: design-web-crawler -->

## What usage numbers does the web crawler design assume, and what do they work out to?
<!-- /learn/design-web-crawler#calculate-usage -->

- 1 billion links, refreshed about weekly, so 4 billion links crawled a month.
- 500 KB per page: **2 PB** of stored content a month, 72 PB in 3 years.
- 100 billion searches a month.
- About **1,600 writes per second** and **40,000 searches per second**.

## In the web crawler design, where are links_to_crawl and crawled_links stored, and why Redis sorted sets?
<!-- /learn/design-web-crawler#use-case-service-crawls-a-list-of-urls -->

Both tables can live in a key-value NoSQL database. `crawled_links` holds processed links with their page signatures. `links_to_crawl` is ranked, initially by overall site popularity, so Redis **sorted sets** keep the ranking and let the crawler take the top-ranked link each time.

## In the web crawler design, what does the Crawler Service do on each pass of its loop?
<!-- /learn/design-web-crawler#use-case-service-crawls-a-list-of-urls -->

1. Take the top-ranked link.
2. Check crawled_links for a similar page signature. If found, lower the link's priority and continue.
3. Otherwise crawl it, queue jobs for the Reverse Index Service and the Document Service.
4. Generate the page signature, remove the link from links_to_crawl, insert link and signature into crawled_links.

## How does the web crawler design avoid getting stuck in an infinite loop?
<!-- /learn/design-web-crawler#handling-duplicates -->

A loop happens when the link graph has a cycle. The crawler compares page signatures and **reduces the priority** of a link whose page looks like one already crawled. Duplicate URLs are removed up front: `sort | unique` for small lists, or a MapReduce job for 1 billion links. Duplicate content is caught by comparing content signatures with Jaccard index or cosine similarity.

## In the web crawler design, how do you decide when to re-crawl a page?
<!-- /learn/design-web-crawler#determining-when-to-update-the-crawl-results -->

Each result has a timestamp of its last crawl. After a default period, say one week, refresh all pages. Refresh popular or frequently updated sites more often. You could mine data for the mean time before a page changes and use that to set its re-crawl rate. Supporting Robots.txt gives webmasters control over crawl frequency.

## What optimizations does the web crawler design suggest for the crawling service itself?
<!-- /learn/design-web-crawler#step-4-scale-the-design -->

- Keep its own DNS lookup, refreshed periodically, since DNS can bottleneck.
- Use **connection pooling**: many open connections at once.
- Switching to UDP could boost performance.
- Make sure there's enough bandwidth.
- Shard and federate the Reverse Index and Document services, and cache popular queries.

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

Seed a **seller-to-category dictionary** with popular sellers. 50,000 sellers at under 255 bytes each is only about 12 MB of memory. For sellers not in the map, crowdsource from users' manual category overrides, using a heap to look up the top override per seller in O(1).

## Why doesn't the Mint design store all 100 million budget items?
<!-- /learn/design-mint#use-case-service-recommends-a-budget -->

It starts every user on a generic **budget template** that allocates category amounts by income tier. Only categories the user overrides are stored, in a budget_overrides table. So you store the exceptions, not every user's 10 categories.

## In the Mint design, how is monthly spending by category computed without loading the database?
<!-- /learn/design-mint#use-case-service-recommends-a-budget -->

Run MapReduce jobs on the raw transaction files in the Object Store to categorize each transaction and sum spending per user, month and category. This could significantly reduce database load compared to SQL queries on the transactions table. If a user changes a category, call the Budget Service to re-run the analysis.

## At 2,000 writes per second, what does the Mint design change when scaling?
<!-- /learn/design-mint#step-4-scale-the-design -->

2,000 writes per second might be tough for a single SQL write master-slave, so consider federation, sharding, denormalization, SQL tuning or NoSQL. Keep only a month of transactions in the database and the rest in a data warehouse or Object Store. Move monthly_spending to an analytics database like Redshift. Cache sessions, stats and recent transactions with cache-aside.

<!-- chapter: design-social-graph -->

## What usage numbers does the social graph design assume?
<!-- /learn/design-social-graph#calculate-usage -->

- 100 million users with 50 friends each on average: **5 billion** friend relationships.
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
- **User Graph Service**: runs the BFS, asking the Lookup Service for each adjacent node's server, then fetching the person from it.

## How can the social graph design reduce machine jumps during a BFS?
<!-- /learn/design-social-graph#step-4-scale-the-design -->

- Batch friend lookups that live on the same Person Server.
- Shard Person Servers by location, since friends generally live closer to each other.
- Cache person data and complete or partial BFS traversals in a Memory Cache, or batch compute them offline into NoSQL.

## What search tricks does the social graph design suggest to make each BFS finish faster?
<!-- /learn/design-social-graph#step-4-scale-the-design -->

- Run **two BFS searches** at once, from source and destination, and merge the paths.
- Start from people with many friends, since they likely cut the degrees of separation.
- Set a time or hop limit, then ask the user whether to keep searching.

<!-- chapter: design-query-cache -->

## What usage numbers does the query cache design assume, and why can't it cache everything?
<!-- /learn/design-query-cache#calculate-usage -->

10 million users and 10 billion queries a month, about **4,000 requests per second**. Each entry (query, title, snippet) is about 270 bytes. If every query were unique and stored, that's **2.7 TB** a month. Memory is limited, so you need to decide what to expire.

## In the query cache design, which eviction policy is used and what happens on a hit?
<!-- /learn/design-query-cache#use-case-user-sends-a-request-resulting-in-a-cache-hit -->

The cache has limited capacity, so it uses **least recently used (LRU)** to expire older entries. On a hit, the cached entry moves to the front of the LRU list and its contents are returned. On a miss, the Query API asks the Reverse Index Service and Document Service, then puts the result at the front of the list.

## How is the query cache built so lookups and evictions are both fast?
<!-- /learn/design-query-cache#cache-implementation -->

A **doubly linked list** keeps recency order: new items go at the head, items to expire come off the tail. A **hash table** maps each query to its linked list node, giving fast lookups to any node.

## In the query cache design, when should cached results be updated, and what's the simple way to do it?
<!-- /learn/design-query-cache#when-to-update-the-cache -->

Update when page contents change, a page is removed or added, or page rank changes. The most straightforward approach is a **TTL**: a max time an entry can stay in the cache before it's updated. The overall pattern is cache-aside.

## You need to spread the query cache across many machines. Which of the three options does the design pick, and why?
<!-- /learn/design-query-cache#expanding-the-memory-cache-to-many-machines -->

- Each machine has its own cache: simple, but a low hit rate.
- Each machine has a full copy: simple, but wastes memory.
- **Shard the cache** across machines: more complex, but likely the best. Pick the machine with `hash(query)`, ideally with consistent hashing.

<!-- chapter: design-sales-rank -->

## What usage numbers does the sales rank design assume, and what do they work out to?
<!-- /learn/design-sales-rank#calculate-usage -->

- 10 million products, 1,000 categories.
- 1 billion transactions and 100 billion reads a month (100:1 reads to writes).
- About 40 bytes per transaction: 40 GB a month, 1.44 TB in 3 years.
- **400 transactions per second**, **40,000 reads per second**.
- Results must update hourly.

## In the sales rank design, how is the past week's ranking computed?
<!-- /learn/design-sales-rank#use-case-service-calculates-the-past-weeks-most-popular-products-by-category -->

Raw Sales API logs sit in an Object Store like S3. The Sales Rank Service runs a **multi-step MapReduce**: step 1 keeps transactions from the past week and sums quantity per (category, product_id). Step 2 does a distributed sort. The sorted results go into a `sales_rank` table in SQL.

## In the sales rank design, why is the ranking precomputed instead of calculated per request?
<!-- /learn/design-sales-rank#use-case-user-views-the-past-weeks-most-popular-products-by-category -->

Reads are 100 times writes and only need hourly freshness. So a batch job writes an aggregate sales_rank table, indexed on id, category_id and product_id, and the Read API just reads from it. Popular content and its rank go in a Memory Cache to absorb 40,000 reads per second.

## What strains SQL in the sales rank design at scale, and what are the options?
<!-- /learn/design-sales-rank#step-4-scale-the-design -->

With so many reads, read replicas might not handle the cache misses, and 400 writes per second might be tough for one SQL write master-slave. Options: federation, sharding, denormalization, SQL tuning, or moving some data to NoSQL. Keep only a limited time period in the database and the rest in a warehouse like Redshift or BigQuery, or in an Object Store.

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

- An **Elastic IP** gives a public IP that doesn't change on reboot, which helps failover.
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

**Autoscaling**: one group per web server and per application server type, spread across availability zones, with min and max instance counts. CloudWatch triggers scaling on time of day or on CPU load, latency, network traffic or a custom metric. The catch: added complexity, and scaling up or down can lag behind demand.

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
