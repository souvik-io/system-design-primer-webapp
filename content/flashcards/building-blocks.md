<!-- chapter: dns-and-cdn -->

## You changed a DNS record but some users still reach the old IP. Why?
<!-- /learn/dns-and-cdn -->

Lower level DNS servers cache mappings, and your browser or OS can cache results too. Each cached answer lives for its **time to live (TTL)**. Until that runs out, clients may get the old mapping. The chapter calls this staleness from DNS propagation delays.

## What's the difference between an A record and a CNAME record?
<!-- /learn/dns-and-cdn -->

- **A record** points a name to an IP address.
- **CNAME** points a name to another name (for example example.com to www.example.com) or to an A record.

So an A record ends at an address, while a CNAME is an alias that still needs resolving.

## Which DNS record types tell the world where your mail servers and name servers are?
<!-- /learn/dns-and-cdn -->

- **MX record** (mail exchange) specifies the mail servers that accept messages.
- **NS record** (name server) specifies the DNS servers for your domain or subdomain.

## Besides name lookup, what traffic routing methods can some managed DNS services offer?
<!-- /learn/dns-and-cdn -->

Services such as CloudFlare and Route 53 can route traffic by:

- **Weighted round robin**: keep traffic off servers under maintenance, balance varying cluster sizes, run A/B tests
- **Latency-based** routing
- **Geolocation-based** routing

## What are the downsides of relying on DNS?
<!-- /learn/dns-and-cdn#the-costs-and-risks-of-dns -->

- Each lookup adds a slight delay, though caching softens it.
- DNS server management can be complex and is generally run by governments, ISPs and large companies.
- DNS services have come under DDoS attack, which kept users from reaching sites like Twitter without knowing its IP addresses.

<!-- chapter: dns-and-cdn#content-delivery-networks -->

## What are the two ways a CDN improves performance?
<!-- /learn/dns-and-cdn#content-delivery-networks -->

1. Users receive content from data centers close to them.
2. Your servers don't have to serve the requests the CDN fulfills.

A CDN is a globally distributed network of proxy servers, usually serving static files like HTML/CSS/JS, photos and videos.

## How does a client know which CDN server to contact?
<!-- /learn/dns-and-cdn#content-delivery-networks -->

The site's **DNS resolution** tells clients which server to contact. The CDN then serves content from locations closer to the user.

## Your site has little traffic and content that rarely changes. Push or pull CDN, and why?
<!-- /learn/dns-and-cdn#push-cdns -->

A **push CDN**. You upload content directly to the CDN when it changes and rewrite URLs to point at it. Content is placed on the CDN once instead of being re-pulled at intervals. Upload happens only for new or changed content, which minimizes traffic but maximizes storage.

## How does a pull CDN behave on the first request for a file, and when does it suit a site best?
<!-- /learn/dns-and-cdn#pull-cdns -->

The CDN grabs the file from your server when the first user asks for it, so that request is slower until the content is cached. A TTL sets how long it stays. Pull CDNs minimize CDN storage and suit **heavy-traffic sites**, since only recently requested content remains. Downside: files can be re-pulled after expiring even if they never changed.

## What are the disadvantages of using a CDN?
<!-- /learn/dns-and-cdn#the-downsides-of-a-cdn -->

- Costs can be significant depending on traffic (weigh against the costs of not using one).
- Content might be stale if it's updated before the TTL expires.
- You must change URLs for static content to point to the CDN.

<!-- chapter: load-balancing -->

## What three problems is a load balancer effective at solving?
<!-- /learn/load-balancing -->

- Preventing requests from going to **unhealthy servers**
- Preventing **overloading** resources
- Helping to eliminate a **single point of failure**

It distributes client requests to resources such as app servers and databases, then returns their responses to the right client.

## Your web app doesn't track sessions itself. What load balancer feature keeps a user on the same instance?
<!-- /learn/load-balancing -->

**Session persistence.** The load balancer issues cookies and routes a specific client's requests to the same instance. Related routing metrics the chapter lists include random, least loaded, session/cookies, round robin or weighted round robin, layer 4 and layer 7.

## What information does a layer 4 load balancer use to route, and what does it ignore?
<!-- /learn/load-balancing#layer-4 -->

It looks at the transport layer: generally source and destination IP addresses and ports in the header, **not the contents of the packet**. It forwards network packets to and from the upstream server, performing Network Address Translation (NAT).

## You want video traffic on video servers and billing traffic on security-hardened servers. Which kind of load balancing?
<!-- /learn/load-balancing#layer-7 -->

**Layer 7.** It looks at the application layer: header, message and cookies. It terminates the traffic, reads the message, decides, then opens a connection to the chosen server. Layer 4 can't do this because it never reads the message contents.

## What's the trade-off between layer 4 and layer 7 load balancing?
<!-- /learn/load-balancing#layer-7 -->

Layer 4 needs less time and computing resources, but you give up flexibility. Layer 7 can route on message content but does more work per request. The chapter notes the performance impact can be minimal on modern commodity hardware.

## Why must servers be stateless when you scale out behind a load balancer, and where do sessions go?
<!-- /learn/load-balancing#horizontal-scaling-and-what-it-costs -->

Scaling horizontally involves cloning servers, so no server should hold user-related data like sessions or profile pictures. Store sessions in a centralized data store such as a database (SQL, NoSQL) or a persistent cache (Redis, Memcached). Also, downstream caches and databases must handle more simultaneous connections as you add servers.

## How can a load balancer itself become a problem?
<!-- /learn/load-balancing#when-the-load-balancer-is-the-problem -->

- It can become a **performance bottleneck** if under-resourced or misconfigured.
- It adds complexity.
- A single load balancer is a **single point of failure**. Running multiple (active-passive or active-active) fixes that but adds more complexity.

<!-- chapter: reverse-proxy-and-api-gateway -->

## How does a reverse proxy improve security?
<!-- /learn/reverse-proxy-and-api-gateway -->

It hides information about backend servers, can blacklist IPs, and can limit the number of connections per client. Clients only see the reverse proxy's IP, which also lets you scale or reconfigure backend servers freely.

## Besides security, what work can a reverse proxy take off your backend servers?
<!-- /learn/reverse-proxy-and-api-gateway -->

- **SSL termination** (no X.509 certificates on each server)
- **Compression** of server responses
- **Caching**: return responses for cached requests
- **Static content**: serve HTML/CSS/JS, photos and videos directly

## You have only one web server. Is a load balancer or a reverse proxy more useful, and why?
<!-- /learn/reverse-proxy-and-api-gateway#load-balancer-vs-reverse-proxy -->

A **reverse proxy**. Load balancers are useful when you have multiple servers, usually serving the same function. A reverse proxy brings its benefits (security, SSL termination, compression, caching) even with one server. Tools like NGINX and HAProxy support both layer 7 reverse proxying and load balancing.

## What's the downside of adding a reverse proxy?
<!-- /learn/reverse-proxy-and-api-gateway#disadvantages-of-a-reverse-proxy -->

It increases complexity. A single reverse proxy is a single point of failure, and configuring multiple reverse proxies (a failover) adds even more complexity.

<!-- chapter: reverse-proxy-and-api-gateway -->

## Why separate the web layer from the application layer?
<!-- /learn/reverse-proxy-and-api-gateway -->

So you can scale and configure each layer independently. Adding a new API means adding application servers without necessarily adding web servers. Workers in the application layer also help enable asynchronism.

## What is a microservice, according to the chapter?
<!-- /learn/reverse-proxy-and-api-gateway#microservices -->

One of a suite of **independently deployable, small, modular services**. Each runs a unique process and communicates through a well-defined, lightweight mechanism to serve a business goal. Pinterest, for example, could have user profile, follower, feed, search and photo upload services.

## How do services find each other in a microservice system?
<!-- /learn/reverse-proxy-and-api-gateway#service-discovery -->

With service discovery tools such as **Consul, Etcd and Zookeeper**. They track registered names, addresses and ports. Health checks, often over an HTTP endpoint, verify service integrity. Consul and Etcd also have a built-in key-value store for config values and other shared data.

## What do you give up by moving from a monolith to loosely coupled services?
<!-- /learn/reverse-proxy-and-api-gateway#disadvantages-of-the-application-layer-and-microservices -->

It needs a different approach to architecture, operations and process than a monolithic system. Microservices can add complexity in deployments and operations.

<!-- chapter: relational-databases -->

## What does each letter of ACID guarantee?
<!-- /learn/relational-databases#what-a-relational-database-is -->

- **Atomicity**: each transaction is all or nothing.
- **Consistency**: a transaction moves the database from one valid state to another.
- **Isolation**: concurrent transactions give the same results as running them serially.
- **Durability**: once committed, a transaction stays committed.

## In master-slave replication, what happens when the master goes offline?
<!-- /learn/relational-databases#primary-replica-replication -->

The system can keep running in **read-only mode** until a slave is promoted to master or a new master is provisioned. Slaves only serve reads. The downside: you need extra logic to promote a slave.

## Your app must keep accepting writes even if one database node dies. Master-slave or master-master?
<!-- /learn/relational-databases#primary-primary-replication -->

**Master-master.** Both masters serve reads and writes and coordinate on writes, so if either goes down the system keeps both reads and writes. With master-slave, losing the master leaves you read-only until a promotion.

## What are the downsides of master-master replication?
<!-- /learn/relational-databases#primary-primary-replication -->

- You need a load balancer or app logic to decide where to write.
- Most setups are either **loosely consistent** (violating ACID) or have **higher write latency** from synchronization.
- Conflict resolution matters more as you add write nodes and as latency grows.

## How can replication lose data you already wrote?
<!-- /learn/relational-databases#primary-primary-replication -->

If the master fails before newly written data is replicated to other nodes, that data can be lost. This applies to both master-slave and master-master replication.

## You keep adding read replicas but reads aren't getting faster under a heavy write load. Why?
<!-- /learn/relational-databases#primary-primary-replication -->

Writes are replayed on every replica. With many writes, replicas get bogged down replaying them and can't serve as many reads. More slaves also means more to replicate, so **replication lag** grows. On some systems the master writes with multiple threads while replicas apply writes sequentially on one thread.

## What does federation do, and why does it help with caching?
<!-- /learn/relational-databases#federation-one-database-per-feature -->

Federation (functional partitioning) splits databases **by function**, for example forums, users and products. Each database gets less traffic and less replication lag. Smaller databases mean more data fits in memory, which gives more cache hits through better cache locality. With no single central master, you can also write in parallel.

## When is federation a poor fit, and what else does it cost?
<!-- /learn/relational-databases#federation-one-database-per-feature -->

It's not effective if your schema needs huge functions or tables. You must also add app logic to choose which database to read and write, joining across two databases is more complex (needs a server link), and it adds hardware and complexity.

## How is sharding different from federation?
<!-- /learn/relational-databases#sharding-splitting-one-table-across-databases -->

Federation splits data **by function** (users, products, forums). Sharding splits the **same kind of data** across databases, so each manages a subset, for example adding more user shards as users grow. Both cut traffic and replication, raise cache hits and allow parallel writes. Sharding also shrinks index size.

## You shard users by last name initial and one shard gets overloaded. What went wrong, and what helps?
<!-- /learn/relational-databases#sharding-splitting-one-table-across-databases -->

**Lopsided data distribution.** A set of power users on one shard can put more load on it than others. Rebalancing fixes it but adds complexity. A sharding function based on **consistent hashing** can reduce the amount of data transferred when you rebalance.

## Why would you denormalize, and when can it backfire?
<!-- /learn/relational-databases#denormalization -->

You write redundant copies of data into multiple tables to **avoid expensive joins**, trading some write performance for read performance. Reads often outnumber writes 100:1 or even 1000:1, so this usually pays off. But data is duplicated, keeping copies in sync complicates the design, and under **heavy write load** a denormalized database might perform worse than a normalized one.

## Which RDBMS feature can keep denormalized copies consistent for you?
<!-- /learn/relational-databases#denormalization -->

**Materialized views**, supported by some RDBMSs such as PostgreSQL and Oracle. They handle storing the redundant information and keeping the copies consistent.

## Before tuning SQL, what two activities should you do first, and with what tools?
<!-- /learn/relational-databases#sql-tuning -->

- **Benchmark**: simulate high-load situations with tools such as ab.
- **Profile**: enable tools such as the slow query log to track performance issues.

These point you to the optimizations worth making.

## Why use CHAR over VARCHAR for fixed-length fields, and DECIMAL for currency?
<!-- /learn/relational-databases#sql-tuning -->

- **CHAR** allows fast, random access. With VARCHAR you must find the end of a string before moving to the next one.
- **DECIMAL** avoids floating point representation errors for money.

## What's the cost of adding an index, and what's a trick for bulk loads?
<!-- /learn/relational-databases#sql-tuning -->

Indices (usually self-balancing B-trees) speed up columns you SELECT, GROUP BY, ORDER BY or JOIN on. But they take more space and **slow writes**, since the index must also be updated. When loading lots of data, it can be faster to disable indices, load, then rebuild them.

## What do the letters in BASE stand for?
<!-- /learn/nosql-databases#what-nosql-means -->

- **Basically available**: the system guarantees availability.
- **Soft state**: the state may change over time, even without input.
- **Eventual consistency**: the system becomes consistent over time, given no input during that period.

Compared with CAP, BASE chooses availability over consistency.

## You need very fast lookups for a simple, rapidly changing data model like a cache layer. Which NoSQL type?
<!-- /learn/nosql-databases#key-value-stores -->

A **key-value store** (abstraction: hash table). It generally allows O(1) reads and writes, is often backed by memory or SSD, and gives high performance. The catch: it offers a limited set of operations, so extra complexity shifts to the application layer.

## What makes a document store different from a key-value store?
<!-- /learn/nosql-databases#document-stores -->

Documents (XML, JSON, binary) are the values, and each holds all information for an object. Document stores give APIs or a query language to query on the **internal structure** of the document. Documents can have completely different fields. The line blurs because many key-value stores support value metadata.

## How is data organized in a wide column store, and what is it used for?
<!-- /learn/nosql-databases#wide-column-stores -->

The basic unit is a **column** (name/value pair). Columns group into column families (like a SQL table), and super column families group those. Columns with the same row key form a row. Each value has a timestamp for versioning and conflict resolution. Examples: Bigtable, HBase, Cassandra. Used for **very large data sets** needing high availability and scalability.

## When would you reach for a graph database, and what's the catch?
<!-- /learn/nosql-databases#graph-databases -->

When your data has **complex relationships**: many foreign keys or many-to-many links, such as a social network. Each node is a record and each arc a relationship. The catch: they're relatively new and not widely used, so tools and resources are harder to find, and many can only be accessed with REST APIs.

## Your data is relational, needs complex joins and transactions. SQL or NoSQL?
<!-- /learn/nosql-databases#sql-or-nosql-making-the-choice -->

**SQL.** Reasons for SQL include structured data, strict schema, relational data, complex joins, transactions, clear scaling patterns, a more established ecosystem, and very fast lookups by index.

## Which kinds of data does the chapter call well suited to NoSQL?
<!-- /learn/nosql-databases#sql-or-nosql-making-the-choice -->

- Rapid ingest of clickstream and log data
- Leaderboard or scoring data
- Temporary data, such as a shopping cart
- Frequently accessed ("hot") tables
- Metadata/lookup tables

## What reasons point you toward NoSQL instead of SQL?
<!-- /learn/nosql-databases#sql-or-nosql-making-the-choice -->

Semi-structured data, a dynamic or flexible schema, non-relational data, no need for complex joins, storing many TB (or PB), a very data intensive workload, and very high throughput for IOPS.

<!-- chapter: cache -->

## How does a cache help when popular items skew load on your database?
<!-- /learn/cache -->

Databases benefit from a uniform spread of reads and writes across partitions. Popular items skew that and cause bottlenecks. A cache in front of the database **absorbs uneven loads and spikes** in traffic.

## Where can a cache live in a system? Name the layers.
<!-- /learn/cache#client-caching -->

- Client (OS or browser)
- CDN
- Web server (reverse proxies, Varnish)
- Database (built-in caching)
- Application (Memcached, Redis)

## How can a web server layer cache save work for app servers?
<!-- /learn/cache#web-server-caching -->

Reverse proxies and caches such as Varnish can serve static and dynamic content directly. Web servers can cache requests and return responses **without contacting application servers**.

## Why are Memcached and Redis faster than a database, and how do they handle limited space?
<!-- /learn/cache#application-caching -->

They hold data in **RAM** instead of on disk. RAM is more limited than disk, so invalidation algorithms like **least recently used (LRU)** evict "cold" entries and keep "hot" data in memory. Redis adds a persistence option and data structures like sorted sets and lists.

## Why should you avoid file-based caching?
<!-- /learn/cache#application-caching -->

The chapter says file-based caching makes **cloning and auto-scaling** more difficult. Prefer an in-memory cache layer such as Memcached or Redis, which sits between your application and your data storage.

## What's the main problem with caching at the database query level?
<!-- /learn/cache#caching-at-the-database-query-level -->

You hash the query as the key and cache the result, but **expiration is hard**. Complex queries are hard to delete from the cache, and if one table cell changes you must delete every cached query that might include it.

## Why is caching at the object level easier to keep fresh than query-level caching?
<!-- /learn/cache#caching-at-the-object-level -->

Your app assembles data into an object, and you **remove that object** when its underlying data changes. No hunting for every query that touched a cell. It also allows async workers to build objects from the latest cached version. Good candidates: user sessions, rendered pages, activity streams, user graph data.

## Walk through a read in cache-aside. Who talks to the database?
<!-- /learn/cache#cache-aside -->

The **application** does. On a cache miss it loads the entry from the database, adds it to the cache, and returns it. The cache never touches storage directly. Also called lazy loading: only requested data gets cached. Memcached is generally used this way.

## What are the drawbacks of cache-aside?
<!-- /learn/cache#cache-aside -->

- Each miss costs **three trips**, which can cause a noticeable delay.
- Data can go stale if updated in the database (mitigate with a TTL or write-through).
- A failed node is replaced by an empty one, increasing latency.

## Writes are rare, reads of fresh data must be fast and never stale. Which cache update strategy fits?
<!-- /learn/cache#write-through -->

**Write-through.** The app writes to the cache, which synchronously writes to the database. Writes are slower, but subsequent reads are fast and cache data isn't stale. Users are generally more tolerant of latency on updates than on reads.

## What are the downsides of write-through, and how do you soften them?
<!-- /learn/cache#write-through -->

- A new node (from failure or scaling) won't cache entries until they're updated in the database. Combining with cache-aside helps.
- Most data written might never be read. A TTL minimizes this.

## Write-behind makes writes faster. What's the risk?
<!-- /learn/cache#write-behind-write-back -->

The cache writes to the data store **asynchronously**, so writes are faster. But if the cache goes down before its contents reach the data store, you **lose data**. It's also more complex to implement than cache-aside or write-through.

## When does refresh-ahead help, and when does it hurt?
<!-- /learn/cache#refresh-ahead -->

The cache refreshes recently accessed entries before they expire. If it **accurately predicts** which items will be needed, latency drops compared with read-through. If it predicts badly, performance can be worse than without refresh-ahead.

## What general costs come with adding any cache?
<!-- /learn/cache#the-costs-of-caching -->

- You must keep caches consistent with the source of truth through **cache invalidation**, a difficult problem.
- Deciding when to update the cache adds complexity.
- You need application changes, such as adding Redis or memcached.

<!-- chapter: queues-and-async -->

## What two kinds of help do asynchronous workflows give you?
<!-- /learn/queues-and-async -->

- They cut request times for expensive operations that would otherwise run in-line.
- They do time-consuming work in advance, such as periodic aggregation of data.

## A user posts a tweet. How does a message queue keep them from waiting for delivery to all followers?
<!-- /learn/queues-and-async#how-a-message-queue-works -->

The app publishes a job to the queue and tells the user its status. A worker picks it up, processes it and signals completion. The user isn't blocked. The client can show the tweet on your timeline instantly, while delivery to followers takes longer in the background.

## Compare Redis, RabbitMQ and Amazon SQS as message brokers.
<!-- /learn/queues-and-async#how-a-message-queue-works -->

- **Redis**: simple, but messages can be lost.
- **RabbitMQ**: popular, but you adapt to AMQP and manage your own nodes.
- **Amazon SQS**: hosted, but can have high latency and may deliver messages twice.

## How is a task queue different from a message queue?
<!-- /learn/queues-and-async#message-queues-and-task-queues -->

A message queue receives, holds and delivers messages. A **task queue** receives tasks and their data, **runs them**, and delivers results. Task queues can support scheduling and run computationally intensive background jobs. Celery is an example, with scheduling and mainly Python support.

## Your queue keeps growing past memory and everything slows down. What fixes it, and what do clients see?
<!-- /learn/queues-and-async#back-pressure-when-the-queue-keeps-growing -->

**Back pressure**: limit the queue size to keep high throughput and good response times for jobs already queued. Once full, clients get a server busy or **HTTP 503** and retry later, perhaps with **exponential backoff**. Note: async isn't always right; cheap calculations and realtime workflows may suit synchronous calls better.

<!-- chapter: protocols-and-apis -->

## Which HTTP verbs are idempotent, and what does idempotent mean?
<!-- /learn/protocols-and-apis#http-requests-and-responses -->

Idempotent means you can call it many times without different outcomes. **GET, PUT and DELETE** are idempotent. POST and PATCH are not.

## What's the difference between PUT and PATCH?
<!-- /learn/protocols-and-apis#http-requests-and-responses -->

- **PUT** creates or replaces a resource. It's idempotent and not cacheable.
- **PATCH** partially updates a resource. It's not idempotent, and is cacheable only if the response contains freshness info.

## How does TCP guarantee packets arrive intact and in order?
<!-- /learn/protocols-and-apis#tcp-reliable-delivery-with-a-price -->

- Sequence numbers and checksums on each packet
- Acknowledgement packets and automatic retransmission

If the sender gets no correct response it resends. After multiple timeouts the connection drops. TCP also does flow control and congestion control. Connections open and close with a handshake.

## Your web servers hold many open TCP connections to memcached and memory use is high. What helps?
<!-- /learn/protocols-and-apis#tcp-reliable-delivery-with-a-price -->

**Connection pooling**, and switching to **UDP** where applicable. Keeping many TCP connections open gives high throughput but uses lots of memory, and many open connections between web server threads and a memcached server can be expensive.

## You're building realtime multiplayer game state updates where late data is useless. TCP or UDP?
<!-- /learn/protocols-and-apis#udp-fast-with-no-promises -->

**UDP.** Use it when you need the lowest latency, late data is worse than lost data, or you want your own error correction. It's connectionless, has no congestion control, and is generally more efficient. It suits VoIP, video chat, streaming and realtime games.

## When should you pick TCP over UDP?
<!-- /learn/protocols-and-apis#tcp-reliable-delivery-with-a-price -->

When you need all data to arrive intact and want automatic best-estimate use of network throughput. TCP suits apps needing high reliability that are less time critical: web servers, database info, SMTP, FTP and SSH.

## Why does DHCP use UDP rather than TCP?
<!-- /learn/protocols-and-apis#udp-fast-with-no-promises -->

UDP can **broadcast** datagrams to all devices on the subnet. A DHCP client hasn't yet received an IP address, so TCP has no way to stream without one.

## What are the steps of an RPC call on the client side?
<!-- /learn/protocols-and-apis#rpc-calling-a-function-on-another-machine -->

1. Client program calls the client stub, pushing parameters onto the stack like a local call.
2. Client stub **marshals** the procedure id and arguments into a request message.
3. Client communication module: the OS sends the message to the server.

The server unmarshals and calls the matching procedure; the response retraces the steps in reverse.

## What's the core difference in focus between RPC and REST?
<!-- /learn/protocols-and-apis#rest-resources-and-representations -->

**RPC exposes behaviors**: endpoints like POST /signup or POST /removeItem. **REST exposes data**: resources at URIs, acted on with verbs, like DELETE /items/456. RPC is often used for internal communication for performance. REST minimizes client/server coupling and is common for public HTTP APIs.

## What are the drawbacks of RPC?
<!-- /learn/protocols-and-apis#disadvantages-of-rpc -->

- Clients become tightly coupled to the service implementation.
- Every new operation or use case needs a new API.
- RPC can be hard to debug.
- Existing tech may not work out of the box, e.g. extra effort to cache RPC calls on servers like Squid.

## What are the four qualities of a RESTful interface?
<!-- /learn/protocols-and-apis#rest-resources-and-representations -->

1. **Identify resources** (URI): same URI regardless of operation.
2. **Change with representations** (verbs, headers, body).
3. **Self-descriptive error messages** (status codes).
4. **HATEOAS**: the service should be fully accessible in a browser.

Communication must also be stateless and cacheable.

## Your mobile app needs a blog post and its comments in one screen. Why might REST hurt here?
<!-- /learn/protocols-and-apis#disadvantages-of-rest -->

Fetching nested resources takes **multiple round trips** to render one view, which is highly undesirable on variable mobile networks. Other REST pain points: queries that aren't a simple hierarchy, actions that don't fit the few verbs, and payloads that bloat as fields are added.

<!-- chapter: security -->

## How do you prevent SQL injection?
<!-- /learn/security -->

Use **parameterized queries**. Also sanitize all user inputs, and any input parameters exposed to users, which protects against both XSS and SQL injection.

## What basic security practices should you know for an interview without a security background?
<!-- /learn/security -->

- Encrypt in transit and at rest.
- Sanitize all user inputs to prevent XSS and SQL injection.
- Use parameterized queries.
- Follow the principle of least privilege.

<!-- chapter: numbers-to-know -->

## Roughly how much is 2^10, 2^20, 2^30 and 2^40 in bytes?
<!-- /learn/numbers-to-know#powers-of-two -->

| Power | Approx | Bytes |
|---|---|---|
| 2^10 | 1 thousand | 1 KB |
| 2^20 | 1 million | 1 MB |
| 2^30 | 1 billion | 1 GB |
| 2^40 | 1 trillion | 1 TB |

## What is 2^32 exactly, and roughly how many bytes is it?
<!-- /learn/numbers-to-know#powers-of-two -->

2^32 is exactly 4,294,967,296, which the table rounds to **4 GB**. Compare 2^30 (1,073,741,824), about 1 GB.

## Roughly how long does a round trip within the same datacenter take?
<!-- /learn/numbers-to-know#latency-numbers-every-programmer-should-know -->

About **500 us** (500,000 ns). That works out to about 2,000 round trips per second within a data center. An HDD seek (10 ms) is 20x longer.

## How long does a main memory reference take compared with L1 and L2 cache?
<!-- /learn/numbers-to-know#latency-numbers-every-programmer-should-know -->

Main memory reference: **100 ns**. That's 20x an L2 cache reference (7 ns) and 200x an L1 cache reference (0.5 ns).

## How long does it take to read 1 MB sequentially from memory, SSD and HDD?
<!-- /learn/numbers-to-know#latency-numbers-every-programmer-should-know -->

| Source | Time |
|---|---|
| Memory | 250 us |
| SSD | 1 ms |
| 1 Gbps network | 10 ms |
| HDD | 20 ms |

HDD is 80x memory and 20x SSD. (An older version of the table says 30 ms.)

## How long is a packet round trip from California to the Netherlands and back?
<!-- /learn/numbers-to-know#latency-numbers-every-programmer-should-know -->

About **150 ms**. That's why only 6-7 world-wide round trips fit in a second, compared with 2,000 within a data center.

## What sequential read throughput should you assume for HDD, 1 Gbps Ethernet, SSD and main memory?
<!-- /learn/numbers-to-know#latency-numbers-every-programmer-should-know -->

- HDD: 50 MB/s
- 1 Gbps Ethernet: 100 MB/s
- SSD: 1 GB/s
- Main memory: 4 GB/s
