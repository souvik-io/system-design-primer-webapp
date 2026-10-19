<!-- One card per handbook topic, in curriculum order. Answer each in your own words before you flip it. -->

## Explain performance vs scalability, with an example.
<!-- /learn/performance-and-latency#performance-and-scalability-are-different-problems -->

You have a **performance problem** if the system is slow even for one user. You have a **scalability problem** if it is fast for one user but slow when many people use it at once.

- Performance: search takes three seconds at 4 a.m. because an index is missing. Adding servers won't help. Make each request do less work.
- Scalability: search takes 80 ms at 4 a.m. and four seconds at the dinner peak, because requests queue for connections, locks or CPU. Add more of what they wait for, or need less of it.

A service is **scalable** if adding resources raises performance in proportion: double the servers, roughly double the work. "More performance" can also mean handling bigger jobs as the data grows.

## Explain latency vs throughput, and which one you should aim for.
<!-- /learn/performance-and-latency#latency-and-throughput -->

- **Latency** is how long one action takes, such as one request from send to response.
- **Throughput** is how many actions finish per unit of time, such as requests per second.

A car factory that takes eight hours to build a car and finishes 120 cars a day has a latency of eight hours and a throughput of five cars an hour. **Bandwidth**, the most a link can carry, is a separate thing from latency: a round trip from California to the Netherlands takes about 150 ms however fast the link is.

The usual goal is maximal throughput with acceptable latency.

## Explain what C, A and P mean in the CAP theorem, and what choice is really left.
<!-- /learn/cap-and-consistency#what-c-a-and-p-actually-mean -->

- **Consistency:** every read sees the most recent write, as if there were only one copy of the data, or the request fails. (This is a different C from the one in ACID.)
- **Availability:** every request to a server that is still running gets a response, with no promise that it holds the latest data.
- **Partition tolerance:** the system keeps working even when the network loses messages between servers.

Networks do fail, so a distributed system can't opt out of partitions. The real choice is what to keep **during a partition**: consistency or availability. When the network is healthy, you can have both.

## During a network partition, what does a CP system do, and what does an AP system do?
<!-- /learn/cap-and-consistency#why-pick-two-of-three-misleads -->

- **CP** keeps consistency. It refuses or delays requests it can't answer correctly, so a request to the cut-off side may wait and then time out. Choose it when the business needs atomic reads and writes, such as bank balances.
- **AP** keeps availability. Each side keeps answering with the most recent data it has, which may be stale, and writes reach the other side once the link is back. Choose it when eventual consistency is acceptable, or the system must keep working despite outside failures.

Example: Amazon's Dynamo kept shopping carts writable during failures and merged the versions later. The cost was that deleted items could reappear.

## Compare weak, eventual and strong consistency, with an example of each.
<!-- /learn/cap-and-consistency#the-consistency-spectrum -->

| Level | After a write, reads... | How copies are updated | Fits |
| --- | --- | --- | --- |
| Weak | may or may not see it (best effort) | No promise | VoIP, video chat, multiplayer games, Memcached |
| Eventual | will see it eventually, with no deadline | In the background (asynchronously) | DNS, email, highly available systems |
| Strong | always see it | Before the write counts as done (synchronously) | File systems, relational databases, anything needing transactions |

On a call that drops for a few seconds, you never hear what was said in the gap. That is weak consistency.

## Explain active-passive fail-over.
<!-- /learn/availability#fail-over-active-passive -->

One server, the **active**, handles all traffic. A **passive** (standby) server waits. The two exchange **heartbeats**, small "I'm alive" messages. If the heartbeats stop, the passive server takes over the active's IP address and starts serving. It is also called master-slave failover.

Downtime depends on how ready the standby is: **hot** (running, with current data) takes seconds, **warm** takes minutes, and **cold** (must be started or restored) takes minutes to hours.

A missed heartbeat doesn't prove the active is dead. If both servers think they are active, you get **split brain**. **Fencing** (cutting off the old active) or a majority **quorum** prevents it.

## Explain active-active fail-over, and what it needs to work.
<!-- /learn/availability#fail-over-active-active -->

Every server handles traffic all the time, and the survivors take over a failed server's share. It is also called master-master failover.

Clients must be able to find every server. For public-facing servers, DNS has to know each server's public IP. For internal servers, the application code has to know every server. Many teams put a load balancer in front instead.

- Pros: no idle hardware, near-instant fail-over, and broken servers are noticed at once.
- Costs: capacity (two servers at 70% each leave the survivor at 140%, so plan N+1) and state (two databases writing the same rows can conflict).

## What are the disadvantages of fail-over?
<!-- /learn/availability#disadvantages-of-fail-over -->

- **More hardware and more complexity.** You pay for extra servers and run software that watches heartbeats and moves traffic. That software can have bugs, and a bad fail-over can cause a bigger outage than the fault it reacted to.
- **Recent writes can be lost.** The active usually confirms a write before copying it to the passive. If it dies in that gap, the passive takes over without the write. Waiting for the standby before confirming prevents this, at the cost of slower writes.

## How do you calculate the availability of parts in sequence and in parallel?
<!-- /learn/availability#availability-in-sequence-and-in-parallel -->

- **In sequence** (a request needs every part): multiply. Two parts at 99.9% give 0.999 × 0.999 ≈ 99.8%.
- **In parallel** (a request needs any one part): multiply the failure chances and subtract from 1. Two parts at 99.9% give 1 − (0.001 × 0.001) = 99.9999%.

Allowed downtime = (1 − availability) × period. Over a year, 99.9% allows about 8 hours 46 minutes, and 99.99% about 52.6 minutes, or 4 minutes 23 seconds a month.

## Walk through a DNS lookup. What do caching and the TTL do, and what does DNS cost you?
<!-- /learn/dns-and-cdn#how-dns-works -->

DNS translates a name such as `www.example.com` into an IP address. It is a hierarchy: root servers, then top-level domain servers (`.com`), then each domain's authoritative servers. Your device asks a **recursive resolver**, which your router or ISP names. On a miss, the resolver follows referrals from the root down to the authoritative server.

Each answer carries a **TTL**, the seconds it may be cached. The browser, the OS and the resolver all cache it, so a changed record lingers until old copies expire.

Costs: an uncached lookup adds delay; running DNS servers is complex, and a few large organizations run the core; and DNS providers are attack targets. The 2016 DDoS attack on Dyn made sites such as Twitter unreachable.

## What do the A, CNAME, NS and MX DNS records do?
<!-- /learn/dns-and-cdn#dns-record-types-youll-actually-use -->

| Record | What it does | Example |
| --- | --- | --- |
| A (address) | Points a name to an IPv4 address (AAAA for IPv6) | `www.crumb.example → 203.0.113.10` |
| CNAME (canonical name) | Points a name to another name, followed until an A record. Not allowed at the bare domain. | `www.crumb.example → crumb.example` |
| NS (name server) | Names the authoritative DNS servers for a domain or subdomain | `crumb.example → ns1.dns-host.net` |
| MX (mail exchange) | Names the mail servers that accept email, with a priority | `crumb.example → 10 mail.crumb.example` |

## Name three ways a managed DNS service can route traffic, and when you'd use each.
<!-- /learn/dns-and-cdn#dns-routing-policies -->

Managed DNS services such as Route 53 and Cloudflare can answer different users differently.

- **Weighted round robin:** each answer gets a share of lookups by weight. Use it to drain servers for maintenance (weight 0), balance clusters of different sizes, or A/B test a new version on a small slice.
- **Latency-based:** answer with the region that is fastest for the user.
- **Geolocation-based:** answer by the user's apparent location, for language, distribution rights or keeping data in a region.

Health checks remove failed endpoints, but cached answers make DNS fail-over slow.

## Explain what a CDN is and how it makes a site faster.
<!-- /learn/dns-and-cdn#content-delivery-networks -->

A **content delivery network** is a worldwide network of caching proxy servers that serve content from locations near the user. It mostly serves static files (HTML, CSS, JavaScript, photos, video), and some CDNs, such as CloudFront, also carry dynamic content. The site's DNS tells each client which CDN server to contact.

It speeds things up in two ways: users get content from a nearby data center, and your servers don't handle the requests the CDN answers.

Downsides: cost grows with traffic, content can be stale until its TTL runs out, and static URLs must change to point at the CDN.

## Compare push CDNs and pull CDNs.
<!-- /learn/dns-and-cdn#push-vs-pull-compared -->

- **Push:** you upload content to the CDN whenever it changes and rewrite URLs to point there. You control expiry and updates. Content is uploaded only when new or changed, so traffic is low but storage is high. Good for low-traffic sites and content that rarely changes.
- **Pull:** you leave content on your server and rewrite URLs. The CDN fetches a file the first time someone asks for it, so the first request is slower, then caches it for its TTL. Storage stays small, but an expired file may be fetched again unchanged. Good for heavy-traffic sites, since only recently requested content stays.

Most sites use pull.

## Explain what a load balancer does and why you'd add one.
<!-- /learn/load-balancing#what-a-load-balancer-does -->

Clients connect to the load balancer's address. For each request, it picks a server from the pool behind it, forwards the request and returns the server's response to the client.

It has four jobs: spread the work so you can add servers, stop sending requests to unhealthy servers, avoid overloading any one server, and remove a single point of failure.

Load balancers come as hardware appliances (fast but expensive), software such as HAProxy, NGINX or Envoy, or managed cloud services. They also sit in front of database replicas, caches and internal services.

## Explain the main load balancing algorithms and when each one fits.
<!-- /learn/load-balancing#choosing-a-server-routing-methods -->

- **Round robin:** each server in turn. Fits similar servers and similar requests.
- **Weighted round robin:** bigger servers get more turns.
- **Random:** needs no shared state, so several load balancers can pick independently.
- **Least loaded** (least connections or least outstanding requests): fits requests of very different cost. Use slow start so a new server isn't flooded.
- **Power of two choices:** pick two servers at random and use the less busy one.
- **Hashing** (client IP or URL): the same key always reaches the same server, which helps caches. Consistent hashing limits how many keys move when servers change.
- **Session cookie:** send a user back to the server that holds their session.

## Explain layer 4 vs layer 7 load balancing.
<!-- /learn/load-balancing#layer-4-and-layer-7-load-balancing -->

- **Layer 4** (transport) looks only at source and destination IP addresses and ports, never at the contents. It picks a server once per connection and forwards the packets, usually by rewriting their addresses (NAT). It works for any TCP or UDP traffic and costs less per request.
- **Layer 7** (application) accepts the connection, reads the request (method, path, headers, cookies) and picks a server per request. It can send `/search` to one pool and `/upload` to another, or keep payment pages on a locked-down pool. It must decrypt TLS and uses more CPU.

Large sites often put a layer 4 tier in front of a layer 7 tier.

## What are TLS termination and session persistence on a load balancer?
<!-- /learn/load-balancing#tls-termination -->

**TLS (SSL) termination:** the load balancer decrypts incoming requests and encrypts responses. App servers skip that expensive work, the X.509 certificate and private key live only on the load balancer, and the load balancer can read requests for layer 7 routing.

**Session persistence (sticky sessions):** the load balancer sets a cookie, or hashes the client's IP, so one user's requests keep reaching the same server. It exists for apps that keep sessions in server memory. The costs are uneven load and lost sessions when that server fails, which is why it's better to keep servers stateless and store sessions in something like Redis.

## What can go wrong with a load balancer, and what does scaling out cost?
<!-- /learn/load-balancing#horizontal-scaling-and-what-it-costs -->

A single load balancer is a single point of failure, can become a bottleneck, and adds complexity. Run them in pairs, active-passive (a shared virtual IP and heartbeats) or active-active.

Scaling out with many ordinary servers is usually cheaper and more available than one big server. It has three costs:

- You need a reliable way to build and deploy identical servers.
- Servers must be stateless: sessions go to a shared store, files to object storage.
- Downstream servers see more connections. 50 app servers × 20 database connections is 1,000, against PostgreSQL's default limit of about 100, so you need connection pooling.

## Explain what a reverse proxy does for you, and its downsides.
<!-- /learn/reverse-proxy-and-api-gateway#what-a-reverse-proxy-does-for-you -->

A reverse proxy is a web server in front of your own servers. It gives them one public address, forwards each request to a server that can answer it, and returns the response.

- **Security:** hides backend details, blocks bad IPs, limits connections per client.
- **Scalability and flexibility:** clients only see the proxy's IP, so servers can change freely.
- **SSL termination, compression and caching.**
- **Static content:** serves HTML, CSS, JavaScript, photos and videos directly.

Downsides: more complexity, and a single proxy is a single point of failure. Fixing that with fail-over adds still more complexity.

## How does a reverse proxy differ from a load balancer?
<!-- /learn/reverse-proxy-and-api-gateway#load-balancer-vs-reverse-proxy -->

- A **load balancer** is useful when you have several servers, usually doing the same job. It spreads requests across them and routes around failed ones.
- A **reverse proxy** is useful even with one web or application server. Security, a stable address, SSL termination, compression, caching and static files all still apply.

The two roles blur in practice. NGINX and HAProxy can each act as a layer 7 reverse proxy and a load balancer at the same time.

## Why split the web layer from the application layer?
<!-- /learn/reverse-proxy-and-api-gateway#separating-the-web-and-application-layers -->

The **web layer** renders pages. The **application layer** (or platform layer) holds the business logic and talks to the databases.

- Each layer scales and is configured on its own.
- A new API means adding application servers, without necessarily adding web servers.
- One platform can serve the website, the API and the mobile app.
- Workers in the application layer make asynchronous jobs possible.

Taken further, the single responsibility principle argues for small, autonomous services. Small teams with small services can plan more aggressively for rapid growth.

## Explain microservices, and how services find each other.
<!-- /learn/reverse-proxy-and-api-gateway#microservices -->

**Microservices** are small services that are each deployed independently, run as their own process, talk through a lightweight mechanism (HTTP, gRPC or a queue) and serve one business goal. Pinterest, for example, could have user profile, follower, feed, search and photo upload services. Each service owns its data.

- Gains: independent deploys and scaling, smaller failures, team ownership.
- Costs: a different approach to architecture, operations and process; more to deploy and run; network calls that can be slow or fail.

**Service discovery:** a registry such as Consul, etcd or ZooKeeper tracks each service's live instances with their names, addresses and ports, and health checks remove dead ones.

## Explain the four ACID properties using one transaction.
<!-- /learn/relational-databases#transactions-and-acid -->

A user rates a recipe: insert a row into `ratings` and add to the recipe's `rating_sum` and `rating_count`, in one transaction.

- **Atomicity:** both steps happen or neither does. A crash between them undoes the insert.
- **Consistency:** the transaction takes the database from one valid state to another. A 7-star rating breaks a constraint and is rejected.
- **Isolation:** concurrent transactions give the same result as running them one after another, so two simultaneous ratings don't lose a count.
- **Durability:** once committed, the change survives a crash, usually thanks to a write-ahead log.

## Explain primary-replica replication, and what happens when the primary fails.
<!-- /learn/relational-databases#primary-replica-replication -->

The **primary** takes all writes and can serve reads. It sends every change to **replicas**, which serve reads only. Replicas can pass changes on to more replicas in a tree. The older name is master-slave replication.

If the primary fails, the replicas keep serving reads, so the site runs in read-only mode until a replica is promoted or a new primary is set up. Promotion needs extra logic: confirm the primary is dead, pick the most up-to-date replica, repoint writes, and keep the old primary from coming back.

Costs: asynchronous replication can lose recent writes, replicas lag behind, every replica replays every write, and there's more hardware to run.

## Explain primary-primary replication and its drawbacks.
<!-- /learn/relational-databases#primary-primary-replication -->

Two servers both accept reads and writes and send each other their changes. If one fails, the other keeps handling both, so there is no read-only period. The older name is master-master replication.

- You need a load balancer or application logic to decide where each write goes.
- Most setups are either loosely consistent, which breaks ACID, or coordinate on every commit, which makes writes slower.
- Two servers can change the same row at once, and conflicts grow with more servers and more latency. Even auto-increment IDs collide unless each server uses its own offset.

## Explain database federation, with its benefits and drawbacks.
<!-- /learn/relational-databases#federation-one-database-per-feature -->

**Federation** (functional partitioning) splits the database by feature. Instead of one monolithic database you might run three: users, products and forums.

- Benefits: less read and write traffic per database and so less replication lag; more data fits in memory, so more cache hits; writes go to several primaries in parallel, raising throughput.
- Drawbacks: it doesn't help when one feature or table is huge; the app must know which database to use; joins across databases are hard (app-side joins or a server link); more hardware and complexity.

## Explain sharding, and what can go wrong with it.
<!-- /learn/relational-databases#sharding-splitting-one-table-across-databases -->

**Sharding** splits the rows of one table across several databases, called shards. A **shard key** decides where each row goes: a user's last-name initial, their region, or (most evenly) a hash of their ID.

- Benefits: those of federation, plus smaller indexes and faster queries. A failed shard affects only its own users, so each shard still needs replicas.
- Problems: the app must be shard-aware and queries get more complex; shards become lopsided (a few power users make a **hot shard**); rebalancing is hard, and consistent hashing reduces the data moved; joins across shards are hard; more hardware and complexity.

## Explain denormalization, and when it pays off.
<!-- /learn/relational-databases#denormalization -->

**Denormalization** stores redundant copies of data so that common reads skip joins. It speeds up reads at some cost to writes. Example: store `author_name` and `comment_count` on the recipe row.

It pays off because reads often outnumber writes 100 to 1 or even 1,000 to 1, and because after federation or sharding a join may span servers. **Materialized views** (in PostgreSQL and Oracle) store a query's results and can maintain the copy for you.

Drawbacks: duplicated data, extra rules to keep copies in sync, and under heavy writes a denormalized database can perform worse than a normalized one.

## How do you find and fix slow SQL queries?
<!-- /learn/relational-databases#sql-tuning -->

Measure first. **Benchmark** by simulating heavy load (`ab`, `pgbench`). **Profile** to find slow queries (MySQL's slow query log, then `EXPLAIN`).

Then the usual fixes:

- **Index** columns used in `WHERE`, `JOIN`, `ORDER BY` and `GROUP BY`. Most indexes are B-trees with logarithmic lookups. They cost memory and slow writes, so for a bulk load you can drop them and rebuild afterwards.
- **Avoid expensive joins** by denormalizing or caching.
- **Partition tables:** move hot columns to a small table, or split a table by month.
- **Pool connections**, and cache results in the application. MySQL's query cache is gone.

## Which schema choices make a relational table faster?
<!-- /learn/relational-databases#tighten-up-the-schema -->

Smaller rows mean more rows per disk page and more of the table in memory.

- `CHAR` for fixed-length values: the database can jump straight to a value.
- `TEXT` for long text: stored off the row behind a pointer, with full-text (boolean) search.
- `INT` for whole numbers up to about 4 billion (2^32 − 1 unsigned). Use `BIGINT` beyond that.
- `DECIMAL` for money: floats are approximate (0.1 + 0.2 = 0.30000000000000004).
- Keep large BLOBs out: store the file elsewhere and keep its location.
- `VARCHAR(255)` is the longest that fits a one-byte length prefix in some databases.
- `NOT NULL` where possible, to help indexes.

## Explain what NoSQL means and how BASE differs from ACID.
<!-- /learn/nosql-databases#base-versus-acid -->

**NoSQL** covers key-value stores, document stores, wide column stores and graph databases. Data is denormalized, joins usually happen in application code, and most stores lack full ACID transactions and favor eventual consistency.

**BASE** describes that looser promise:

- **Basically available:** the system answers even when parts have failed.
- **Soft state:** a replica's data can change with no new input, as updates arrive in the background.
- **Eventual consistency:** if writes stop, all replicas converge over time.

In CAP terms, BASE chooses availability over consistency. One system can use ACID for some data and BASE for the rest.

## Explain a key-value store and when to use one.
<!-- /learn/nosql-databases#key-value-stores -->

The model is a **hash table**: a key goes in, a value comes out. Reads and writes usually take O(1) time, and data lives in memory or on SSD. Some stores keep keys in lexicographic (sorted) order, which makes key-range scans cheap. Many let you attach metadata, such as an expiry time, to a value.

They suit simple data models and rapidly changing data: sessions, carts, counters, feature flags and in-memory caches (Redis, Memcached).

The operations are few, so anything more (such as "every recipe with garlic") falls on the application. Key-value stores also sit underneath richer systems such as document stores.

## Explain a document store and when to use one.
<!-- /learn/nosql-databases#document-stores -->

A document store is a key-value store whose values are **documents** (JSON, XML or a binary format), each holding everything about one object. The database understands the document's structure, so you can query and index fields inside it.

Documents are grouped into collections, or by tags, metadata or directories, and documents in one group can have completely different fields. MongoDB and CouchDB offer query languages for complex queries, and DynamoDB supports both key-values and documents.

They suit data that changes occasionally and is read as a whole object: product catalogs, profiles, content pages.

## Explain a wide column store and when to use one.
<!-- /learn/nosql-databases#wide-column-stores -->

The model is a nested map: `ColumnFamily<RowKey, Columns<ColKey, Value, Timestamp>>`.

- A **column** (name, value, timestamp) is the basic unit. **Column families** group columns, roughly like SQL tables, and early Cassandra's super column families grouped families. Columns sharing a row key form a row, and you can read any single column by row key.
- The timestamp gives versioning and conflict resolution (last write wins).
- Google's Bigtable introduced the model. HBase (Hadoop) and Cassandra (built at Facebook) followed. Bigtable and HBase keep row keys sorted, so key-range reads are efficient.

They offer high availability and scale, handle heavy writes, and suit very large data sets.

## Explain a graph database and when to use one.
<!-- /learn/nosql-databases#graph-databases -->

Each **node** is a record and each **edge** (arc) is a relationship between two nodes. Both can carry properties. Following an edge doesn't mean searching a join table, so graph databases are fast for data with many-to-many relationships and long chains of foreign keys, such as a social network. Example: "recipes saved by cooks I follow" is a short Cypher query in Neo4j.

They used to be rare, with few tools and often only REST access. Today there is a standard query language (GQL), official drivers and managed services such as Amazon Neptune. They are still a specialist tool, usually run beside a main database.

## How do you choose between a relational database and NoSQL?
<!-- /learn/nosql-databases#sql-or-nosql-making-the-choice -->

Start relational unless you have a specific reason not to.

- **Relational:** structured data, a strict schema, relational data, complex joins, transactions, clear scaling patterns, a mature ecosystem, fast indexed lookups.
- **NoSQL:** semi-structured data, a flexible schema, non-relational data, no complex joins, terabytes or petabytes of data, very data-intensive work, very high IOPS.

Data that suits NoSQL well: fast-arriving clickstream and logs, leaderboards and scores, temporary data such as a shopping cart, frequently read ("hot") tables, and metadata or lookup tables.

## Explain what a cache does for a system, and what it costs you.
<!-- /learn/cache#what-a-cache-is -->

A cache keeps copies of results already computed or fetched, so a repeat request returns the copy (a **hit**) instead of redoing the work (a **miss**). Pages load faster and servers and databases do less work.

It also smooths uneven load. Databases work best when traffic spreads evenly across partitions, and a viral item would hammer one partition. A cache in front absorbs the spike.

Costs: copies must be kept consistent with the source of truth (**cache invalidation**), deciding when to update them is genuinely hard, and you have to change the app to add and run Redis or Memcached.

## Where can caches live between a user and the database?
<!-- /learn/cache#where-caches-live -->

- **Client:** the browser and the OS.
- **CDN:** copies near users.
- **Web server:** reverse proxies and caches such as Varnish serve static and dynamic responses without reaching the app servers.
- **Database:** its own memory cache. Tune the defaults for your workload.
- **Application:** in-memory key-value stores (Memcached, Redis) between the app and the database. RAM is fast but small, so an eviction rule such as **least recently used (LRU)** drops cold entries and keeps hot ones. Redis also offers persistence and data structures such as lists and sorted sets.

## Compare caching database queries with caching objects. What is worth caching?
<!-- /learn/cache#what-to-cache -->

You can cache at four levels: row, query, fully formed serializable object, or fully rendered HTML. Avoid file-based caching on each server, because it makes cloning and autoscaling harder.

- **Query level:** hash the query as the key and store the result. It's hard to invalidate: complex queries are hard to delete, and one changed cell can stale many cached queries.
- **Object level:** assemble the data into an object and cache it under one key. When the data changes, delete that key. Workers can also build objects asynchronously.

Good candidates: user sessions, fully rendered pages, activity streams and user graph data.

## Explain the cache-aside pattern and its drawbacks.
<!-- /learn/cache#cache-aside -->

The application does all the work, and the cache never talks to the database. To read, the app:

1. looks in the cache and gets a miss,
2. loads the entry from the database,
3. adds it to the cache,
4. returns it.

It is also called **lazy loading**, since only requested data gets cached. Memcached is usually used this way.

Drawbacks: each miss costs three trips; data can go stale if the database changes (limit it with a TTL or write-through); and a replacement node starts empty, which raises latency until it warms up.

## Explain the write-through pattern and its drawbacks.
<!-- /learn/cache#write-through -->

The application treats the cache as its main data store. A write updates the cache, the cache writes the entry to the database **synchronously**, and then the call returns.

Writes are slower, but reads of just-written data are fast and the cache isn't stale. Users tolerate latency on updates more than on reads.

Drawbacks: a new node (after a failure or scale-out) holds nothing until entries are written again, which combining with cache-aside fixes; and much of the data written may never be read, which a TTL limits.

## Explain write-behind (write-back) caching and its risks.
<!-- /learn/cache#write-behind-write-back -->

The application writes to the cache and returns at once. The cache writes the entry to the database later, **asynchronously**. Writes get faster, and repeated changes to one entry can be combined: 5,000 view-count updates in ten seconds become one database write.

Risks:

- If the cache goes down before its queued writes reach the database, those writes are lost, although the app was told they succeeded.
- It's more complex to build than cache-aside or write-through.

## Explain refresh-ahead caching and when it backfires.
<!-- /learn/cache#refresh-ahead -->

The cache automatically reloads any recently accessed entry shortly before it expires, while readers keep getting the current copy. With a 60-second TTL and a refresh factor of 0.5, a read of an entry older than 30 seconds returns it at once and triggers a background reload.

It can give lower latency than read-through, because readers of popular entries never wait for a miss.

It backfires when the cache predicts badly: it reloads entries nobody reads, adds database load, and can perform worse than having no refresh-ahead at all.

## Explain how a message queue moves slow work out of the request.
<!-- /learn/queues-and-async#how-a-message-queue-works -->

A message queue receives, holds and delivers messages.

1. The app publishes a job to the queue and tells the user the job's status.
2. A worker takes the job, processes it, and signals that it's done.

The user isn't blocked, and the queue absorbs bursts. The client can make the work feel instant: a posted tweet appears on your own timeline at once, though delivery to all your followers takes longer.

Expensive work can also be done in advance on a schedule, such as periodically aggregating data.

## How does a task queue differ from a message queue? Name some tools.
<!-- /learn/queues-and-async#message-queues-and-task-queues -->

A **message queue** moves messages without caring what's inside. A **task queue** is a framework on top: it receives a task (a function and its arguments), runs it in a worker and delivers the result. It usually adds retries and scheduling, and suits computationally intensive background jobs.

- Redis: a simple broker. Pub/Sub loses messages if a subscriber disconnects.
- RabbitMQ: popular, built around AMQP, and you run its nodes yourself.
- Amazon SQS: hosted, with more latency, and a message can be delivered twice.
- Celery (Python), Sidekiq (Ruby), BullMQ (Node.js): task queues.

Because duplicates happen, make workers idempotent.

## What is back pressure, and why does a queue need it?
<!-- /learn/queues-and-async#back-pressure-when-the-queue-keeps-growing -->

If work arrives faster than workers finish it for long, the queue only grows. Every job waits longer, the broker runs out of memory, and recovery takes longer. Slack's in-memory Redis job queue filled up this way and stopped accepting jobs.

**Back pressure** means pushing back on producers instead of accepting more than you can handle. Bound the queue: limit = drain rate × longest acceptable wait, e.g. 30 jobs/s × 600 s = 18,000 messages. When it's full, reply **503** with `Retry-After` (or **429** for one client over its limit), and clients retry with exponential backoff and jitter.

## Explain the OSI model's layers, and which ones come up in system design.
<!-- /learn/protocols-and-apis#layers-how-one-request-is-built -->

Data is wrapped layer by layer on the way out and unwrapped in reverse, like a letter inside several envelopes.

| # | Layer | Examples |
| --- | --- | --- |
| 7 | Application | HTTP, DNS, SMTP, SSH |
| 6 | Presentation | JSON, gzip, TLS (partly) |
| 5 | Session | Sockets, RPC |
| 4 | Transport | TCP, UDP, QUIC |
| 3 | Network | IP |
| 2 | Data link | Ethernet, Wi-Fi |
| 1 | Physical | Copper, fiber, radio |

The internet itself uses a simpler four-layer model. In design talk, "layer 4" and "layer 7" mostly describe load balancers.

## Explain HTTP and which methods are safe, idempotent and cacheable.
<!-- /learn/protocols-and-apis#methods-and-their-properties -->

HTTP is a request/response protocol for carrying data between client and server. A request has a method (verb) and a resource (endpoint). It is stateless, so intermediaries such as load balancers, caches and proxies can act on each message. It runs over TCP, or over QUIC on UDP for HTTP/3.

| Method | Does | Idempotent | Safe | Cacheable |
| --- | --- | --- | --- | --- |
| GET | Reads a resource | Yes | Yes | Yes |
| POST | Creates a resource or starts a process | No | No | Only with freshness info |
| PUT | Creates or replaces a resource | Yes | No | No |
| PATCH | Partly updates a resource | No | No | Only with freshness info |
| DELETE | Deletes a resource | Yes | No | No |

Idempotent means repeating the request has the same effect as sending it once.

## Explain how TCP delivers data reliably, and what that costs.
<!-- /learn/protocols-and-apis#tcp-reliable-delivery-with-a-price -->

TCP is a connection-oriented protocol over IP. A **handshake** opens and closes each connection. Data arrives complete and in order thanks to sequence numbers, checksums, acknowledgements and retransmission. After repeated timeouts the connection is dropped. Flow control and congestion control adjust the sending rate.

Costs: a round trip for the handshake, waiting for lost data (head-of-line blocking), and memory for every open connection. That memory is why web servers use **connection pooling** for caches and databases.

Use TCP when all the data must arrive intact and you want the protocol to use the network's capacity well: web servers, databases, SMTP, FTP, SSH.

## Explain UDP, and when you'd choose it over TCP.
<!-- /learn/protocols-and-apis#udp-fast-with-no-promises -->

UDP is connectionless. It sends **datagrams**, and the only promise is per datagram: one that arrives is whole. Datagrams may arrive out of order or not at all, and there is no congestion control. With less work and no waiting, UDP is generally more efficient.

UDP can **broadcast** to every device on the subnet. DHCP relies on this, because a new device has no IP address yet and can't open a TCP connection.

Choose UDP when you need the lowest latency, late data is worse than lost data, and you'll handle errors yourself: VoIP, video chat, streaming, multiplayer games.

## Explain RPC, and how a remote call travels.
<!-- /learn/protocols-and-apis#rpc-calling-a-function-on-another-machine -->

In a **remote procedure call**, a client makes a procedure run in another address space, usually a remote server, using code that looks like a local call.

Client program → client stub marshals the procedure ID and arguments → client OS sends → server OS → server stub unmarshals and calls the procedure. The reply travels back the same way.

Remote calls are slower and less reliable than local ones, so keep them easy to tell apart. RPC exposes **behaviors** and is common for internal traffic, where hand-tuned calls perform well. Frameworks include Protobuf (with gRPC), Thrift and Avro. Drawbacks: clients are tightly coupled to the service, new operations need new methods, and calls are harder to debug and to cache.

## Explain REST and its four qualities.
<!-- /learn/protocols-and-apis#rest-resources-and-representations -->

REST is an architectural style. A client acts on **resources** managed by a server, which returns **representations** of them. All communication is stateless and cacheable.

1. **Identify resources** with URIs: one URI per resource, whatever the operation.
2. **Change them through representations:** methods, headers and body.
3. **Self-descriptive messages:** use the standard status codes.
4. **HATEOAS:** responses link to what the client can do next.

REST exposes **data**, keeps client and server loosely coupled, suits public APIs, and scales horizontally because requests are stateless. Drawbacks: queries that don't fit a resource path, few verbs, many round trips for nested data, and responses that grow.

## What is HATEOAS? Give an example.
<!-- /learn/protocols-and-apis#the-four-qualities-of-a-restful-interface -->

**HATEOAS** (hypermedia as the engine of application state) means each response contains links to the actions the client may take next. The client needs no knowledge beyond the first URI, the way you use a website by following links.

Example: `GET /accounts/12345` for an account with a positive balance returns links to deposit, withdraw, transfer and close. For an overdrawn account it returns only the deposit link. The links tell the client what the current state allows.

Most APIs that call themselves REST skip this part.

## Write the same API operations in RPC style and in REST style.
<!-- /learn/protocols-and-apis#rpc-and-rest-side-by-side -->

| Operation | RPC | REST |
| --- | --- | --- |
| Sign up | `POST /signup` | `POST /users` |
| Close an account | `POST /closeAccount {"userId": "1234"}` | `DELETE /users/1234` |
| Read a user | `GET /getUser?userId=1234` | `GET /users/1234` |
| Read their saved recipes | `GET /getSavedRecipes?userId=1234` | `GET /users/1234/saved-recipes` |
| Save a recipe | `POST /saveRecipe {"userId": "1234", "recipeId": "456"}` | `POST /users/1234/saved-recipes {"recipeId": "456"}` |
| Update a saved recipe's note | `POST /updateSavedRecipe {...}` | `PUT /users/1234/saved-recipes/456` |
| Remove a saved recipe | `POST /unsaveRecipe {...}` | `DELETE /users/1234/saved-recipes/456` |

RPC names an action per endpoint. REST keeps a few resource URLs and lets the method say what to do.

## What are the four security basics you should know for a design interview?
<!-- /learn/security -->

1. **Encrypt data in transit and at rest:** TLS on the wire, encrypted storage on disk.
2. **Sanitize all user input,** including every parameter a user can reach: validate it on the way in and escape it on the way out, to prevent cross-site scripting (XSS) and SQL injection.
3. **Use parameterized queries,** so input is passed as data and can never change what the SQL means.
4. **Use the principle of least privilege:** give every user, program and service only the access its job needs, which limits the damage when something is compromised.

## Recite the powers of two you need for estimates.
<!-- /learn/numbers-to-know -->

| Power | Exact value | Approximately | Bytes |
| --- | --- | --- | --- |
| 2^7 | 128 | | |
| 2^8 | 256 | | |
| 2^10 | 1,024 | 1 thousand | 1 KB |
| 2^16 | 65,536 | | 64 KB |
| 2^20 | 1,048,576 | 1 million | 1 MB |
| 2^30 | 1,073,741,824 | 1 billion | 1 GB |
| 2^32 | 4,294,967,296 | | 4 GB |
| 2^40 | 1,099,511,627,776 | 1 trillion | 1 TB |

## Give rough latencies for memory, SSD, disk and network operations.
<!-- /learn/numbers-to-know -->

| Operation | Time |
| --- | --- |
| L1 cache reference | 0.5 ns |
| Branch mispredict | 5 ns |
| L2 cache reference | 7 ns |
| Mutex lock/unlock | 25 ns |
| Main memory reference | 100 ns |
| Compress 1 KB with a fast compressor (Zippy) | 3 µs |
| Send 1 KB over a 1 Gbps network | 10 µs |
| Read 4 KB randomly from SSD | 150 µs |
| Read 1 MB sequentially from memory | 250 µs |
| Round trip within one data center | 500 µs |
| Read 1 MB sequentially from SSD | 1 ms |
| Disk seek | 10 ms |
| Read 1 MB over a 1 Gbps network | about 10 ms |
| Read 1 MB sequentially from disk | about 20 ms |
| Round trip California → Netherlands → California | 150 ms |

These are classic figures from about 2012. Sequential reads run at roughly 4 GB/s from memory, 1 GB/s from SSD, 100 MB/s over 1 Gbps and 50 MB/s from disk. About 2,000 round trips a second fit within a data center, and only 6 or 7 across the world.

## How do MD5 and Base62 work together to make a short URL code?
<!-- /learn/design-pastebin#generating-the-short-code -->

- **MD5** is a widely used hash function. It turns any input into a 128-bit number spread evenly (uniformly) across its range. Hashing the client's IP and the time gives a large random-looking number.
- **Base62** writes that number with the 62 characters `0-9`, `a-z` and `A-Z`, which are all safe in URLs, so nothing needs escaping. Base64 adds `+` and `/`, which mean something in URLs.
- Encoding is deterministic: the same input always gives the same output, with no randomness.

Reduce the number modulo 62^7 and encode it: seven characters give about 3.52 trillion codes.
