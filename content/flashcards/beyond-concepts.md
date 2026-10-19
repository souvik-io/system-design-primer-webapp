<!-- chapter: estimation -->

## A service gets 500 million requests a day with a peak factor of 3. What are the average and peak QPS?
<!-- /learn/estimation#units-and-shortcuts -->

Use the shortcut of about 10^5 seconds per day: 500 × 10^6 ÷ 10^5 = **5,000 per second** on average, and **15,000** at peak. The exact average is about 5,790, so the shortcut runs about 14% low. That error is smaller than the uncertainty in the peak factor, so it rarely changes a decision. Just know which way you rounded.

## Why do you estimate reads and writes separately, and how do you get from average QPS to peak?
<!-- /learn/estimation#the-method-step-by-step -->

Reads and writes **scale differently**, so they drive different parts of the design. Average QPS is DAU × actions per user per day ÷ 10^5. Peak is average × a peak factor:

- Consumer traffic with a daily cycle: often 2 to 3 times average.
- Event-driven traffic (a sports final, a launch, a push to every user): 10 times or more.

The peak factor is an assumption. Say it out loud and label it.

## How do you size a cache without estimating the whole dataset?
<!-- /learn/estimation#the-method-step-by-step -->

Estimate the **hot set**, not everything. Two common ways:

- Cache a fraction of what's read each day, using the 80/20 assumption that a small share of items gets most reads.
- Cache everything created in a recent window, if reads skew towards new content.

In the photo example, a week of metadata (7 × 10 GB = 70 GB) fits in a couple of cache nodes, so you skip the eviction debate.

## In the photo app, egress comes out near 360 Gbps at peak. What does that one number tell you?
<!-- /learn/estimation#worked-example-a-photo-sharing-app -->

You need a **CDN**. No single origin serves 360 Gbps sensibly. Photo views ran about 20 times more often than feed API calls, and they are static bytes, so they belong on a CDN rather than your API servers. Response size multiplies directly into egress: serving 2 MB originals instead of 300 KB versions would push it to about 800 Gbps on average.

## The photo app stores about 45 PB of images and 18 TB of metadata over 5 years. What does each number push you toward?
<!-- /learn/estimation#worked-example-a-photo-sharing-app -->

- **45 PB of images** means object storage.
- **18 TB of metadata** (about 55 TB with three replicas, before indexes) is more than you'd want on one database node, so plan to shard it from the start.

Same app, two very different stores, and the estimate told you which before you designed anything.

## Why did the ride-hailing location estimate start from concurrent drivers instead of daily active users?
<!-- /learn/estimation#worked-example-a-ride-hailing-location-service -->

Drivers send location updates on a timer while online, so the write rate depends on how many are **online at the same moment**. A driver on a ten-hour shift sends 9,000 updates; one who opens the app for ten minutes sends 150. DAU hides that difference. 1 million drivers every 4 seconds gives 250,000 writes per second at peak.

## The ride-hailing location data is only about 200 MB but takes 250,000 writes per second. How should you scale it?
<!-- /learn/estimation#worked-example-a-ride-hailing-location-service -->

The hard part is the **write rate**, not capacity. It's around 40 writes per read, so "add read replicas and a cache" doesn't help. If one in-memory node handles about 100,000 writes per second, you need at least three, plus headroom. Shard by geography, such as city or map cell, so a "nearby drivers" query usually touches one shard. Send location history to a log like Kafka, not the live store.

## You round every number up by 50% across four multiplications. What happens to your estimate?
<!-- /learn/estimation#sanity-checking-the-result -->

It ends up about **five times too big**. Compounding errors add up fast. Round some numbers up and some down, or note the direction. Other sanity checks: recompute per user (25 TB a day ÷ 50 million users = 500 KB each), check units at every step, and compare against physical limits like a 10 to 25 Gbps network card.

## Your metadata estimate is 3 TB after five years, replicas included, at 500 writes per second. Do you shard on day one?
<!-- /learn/estimation#what-the-numbers-decide -->

Probably not. That's about 1 TB per copy, and 500 writes per second is well inside the low thousands one relational primary can usually take. Say what would change your mind: faster growth, or writes approaching a few thousand per second. Picking a **shard-friendly key** early keeps the later move cheap.

<!-- chapter: consistent-hashing -->

## A cache tier of 10 servers uses hash mod N. You add an eleventh at peak. What happens?
<!-- /learn/consistent-hashing#the-problem-with-hash-mod-n -->

About **10 of every 11 keys** move to a different server, so roughly 91% of lookups miss at once. Nearly all that traffic falls through to the database, which was sized for the old hit rate and may fall over. With a datastore instead of a cache, moving keys means copying data, which can take hours and saturate the network.

## On a consistent hashing ring, how do you find which server owns a key, and what does adding a server cost?
<!-- /learn/consistent-hashing#the-ring -->

Servers and keys hash into the same circular space. A key belongs to the **first server clockwise** from its position. Keep server positions in a sorted array and binary-search, O(log N). Adding or removing one of N servers moves only about **1/N of the keys**, all from or to one neighbor. That's the minimum possible.

## What are the two problems with a plain consistent hashing ring that has one position per server?
<!-- /learn/consistent-hashing#the-ring -->

- **Uneven arcs.** Random positions don't split a circle evenly. With 10 servers, the largest arc averages about 29% of the ring, nearly three times the fair 10%.
- **Load dumps onto one neighbor.** When a server fails, its whole range goes to the next server clockwise, which may then overload too.

## How do virtual nodes fix the plain ring, and what do they cost?
<!-- /learn/consistent-hashing#virtual-nodes -->

Each physical server gets many ring positions ("A#0", "A#1", ...). Balance improves roughly as 1/√V, a failed server's small ranges spread over many successors, and a bigger machine can get more vnodes. The cost: the table grows to N × V entries and each vnode is a separate range to stream and repair. Cassandra cut its default from 256 tokens per node to 16 in version 4.0 for that reason.

## When placing three replicas by walking clockwise on the ring, why must you skip positions you've already seen?
<!-- /learn/consistent-hashing#replication-along-the-ring -->

With virtual nodes, the next few positions clockwise can belong to the **same physical machine**. Without the skip, "three replicas" could be three copies on one server, and losing it loses the data. Dynamo calls the resulting list of distinct servers the key's **preference list**. Real systems go further and spread replicas across racks or data centers.

## One product page key gets 50 times the traffic of any other. Will more virtual nodes or more servers help?
<!-- /learn/consistent-hashing#hot-keys -->

No. Consistent hashing balances **keys, not load**, and that one key still maps to one server. Instead:

- Put a short-lived in-process cache on each app server (costs staleness).
- Spread reads across the key's replicas.
- For a write-heavy key like a counter, split it into sub-keys and sum on read.
- Bound per-server load so overflow moves clockwise.

## How does rendezvous hashing pick a server, and what is its main drawback?
<!-- /learn/consistent-hashing#alternatives-and-a-comparison -->

For each key, compute hash(key, server) for **every server** and pick the highest score. Removing a server only moves the keys it scored highest for. Balance is good without virtual nodes, and the top few scores give replica placement for free. The catch is O(N) work per lookup: fine for tens of servers, wasteful for thousands.

## When would you pick jump consistent hash over a ring?
<!-- /learn/consistent-hashing#alternatives-and-a-comparison -->

When your buckets are **numbered logical shards** that never vanish individually, because each one is replicated, and you only grow by adding at the end. Jump hash needs no memory, runs in O(log N) and balances almost perfectly. It's a poor fit for a pool of cache servers where any one can die, since you can't remove bucket 3 of 10.

<!-- chapter: rate-limiting -->

## How does a rate limiter differ from back pressure?
<!-- /learn/rate-limiting -->

**Back pressure** reacts to how loaded the server is. A **rate limiter** enforces a policy per client, whether or not the server is busy. Rate limiters protect shared capacity from one noisy client, blunt abuse like credential stuffing and scraping, keep per-request costs predictable (SMS, GPU time), and make pricing tiers enforceable.

## Why do most production systems put rate limits at several layers instead of one?
<!-- /learn/rate-limiting#where-the-limiter-lives -->

Each layer sees different information:

- **Edge or CDN:** cheapest rejection, but knows only IP, path and headers. Good for coarse per-IP flood limits.
- **API gateway:** has authenticated the caller, so it knows identity and tier. The usual home for per-key quotas.
- **Service:** only it knows true cost ("export 10,000 rows" versus "fetch one row"), so cost-based limits live there.

## Why is a strict per-IP limit risky, and when is it still your only option?
<!-- /learn/rate-limiting#choosing-the-key -->

Many innocent users can share one IP behind corporate proxies and carrier-grade NAT, while botnets have many IPs. With IPv6, limit by prefix (often the /64). But per-IP works **before authentication**, so it's the only choice for login pages, sign-up forms and anonymous endpoints. Real rules combine keys: say, 5 failed logins per username per 15 minutes and 100 per IP per hour.

## A fixed-window limiter allows 100 requests a minute. How many can a client get through in about one second?
<!-- /learn/rate-limiting#fixed-window-counter -->

Up to **200**: 100 at 12:00:59 and 100 more at 12:01:00, across the window boundary. Rejected clients also tend to retry together when the window resets, causing a spike. A sliding window log prevents this exactly, and a sliding window counter prevents most of it with just two counters.

## Limit 50/min. Last minute had 48; 40 s into this one there have been 31. Does a sliding window counter allow the next request?
<!-- /learn/rate-limiting#sliding-window-counter -->

Yes. The estimate is current + previous × (1 − elapsed fraction) = 31 + 48 × ⅓ = **47**, under 50. The next two are allowed too, then rejection. It assumes the previous window's requests were evenly spread, so it can be slightly off, but it needs only two counters and removes most of the boundary burst.

## A token bucket refills 10 tokens a second and holds 50. An idle client sends 80 requests at once. How many succeed?
<!-- /learn/rate-limiting#token-bucket -->

**50** succeed and 30 are rejected, because the bucket was full after the idle period. It then refills one token every 0.1 seconds. Retry-After takes whole seconds, so you'd round up and send 1. The two knobs, burst capacity and sustained rate, are why token bucket is the most common choice for public APIs.

## When would you use a leaky bucket queue instead of a token bucket?
<!-- /learn/rate-limiting#leaky-bucket -->

When the backend **can't handle bursts**. The queue form holds requests in a fixed-size FIFO and releases them at a constant rate, dropping new ones when full. It smooths traffic into a steady stream at the price of added latency. NGINX's limit_req works this way; its burst setting sizes the queue, and nodelay makes it behave much like a token bucket.

## Two gateways share a Redis counter using GET, compare, then SET. What goes wrong, and how do you fix it?
<!-- /learn/rate-limiting#distributed-counters-in-redis -->

Both can read 99, both decide it's under 100, and both write 100. Requests slip past and the count is too low. Fixes:

- Use **INCR** and check the value it returns. For a fixed window, send INCR and EXPIRE together in MULTI/EXEC.
- For a token bucket or sliding log, put the read-decide-write in a **Lua script**, which Redis runs atomically.

## Your rate-limit Redis goes down. Should a public read API fail open or closed? What about an SMS verification endpoint?
<!-- /learn/rate-limiting#distributed-counters-in-redis -->

- **Read API: fail open**, ideally falling back to a looser per-instance limit. Rejecting everything turns a limiter outage into a full outage.
- **SMS endpoint: fail closed.** Each request costs money, and attackers abuse unprotected SMS endpoints for toll fraud.

It depends on whether the limit protects capacity or protects money and security.

## What's the difference between returning 429 and 503 to a client?
<!-- /learn/rate-limiting#telling-the-client -->

**429 Too Many Requests** means "you slow down": this client exceeded its limit. **503 Service Unavailable** means "everyone wait": the whole system is overloaded. Pair either with **Retry-After**, preferably in seconds rather than a date, since seconds don't depend on the client's clock being right.

<!-- chapter: unique-ids -->

## Why do time-sortable IDs make database inserts cheaper?
<!-- /learn/unique-ids#what-a-good-id-needs -->

New IDs land at the **right-hand end of the B-tree index**, so inserts append instead of touching random pages. You can also paginate with WHERE id < ? and sort without a separate timestamp. Across machines you usually get only rough order, what Twitter called **k-sorted**, and that's normally fine.

## How does range allocation cut load on a central ID counter, and what does it cost?
<!-- /learn/unique-ids#auto-increment-ticket-servers-and-ranges -->

Each app server reserves a **block** of, say, 1,000 IDs with one atomic update and hands them out from memory. Database load drops by a factor of 1,000, and a short database outage doesn't stop ID generation until the block runs out. The cost: a crashed server leaves a gap of unused IDs, and IDs from different servers interleave out of time order.

## Why do random UUID v4 primary keys hurt database performance, and what fixes it?
<!-- /learn/unique-ids#uuids-v4-and-v7 -->

Random keys land all over the **B-tree index**, so each insert touches a random page. Once the index outgrows memory, inserts cause disk reads and page splits. In InnoDB, rows are stored in primary-key order, so it hurts the whole table. **UUID v7** starts with a 48-bit millisecond timestamp, so inserts append to the end while still needing no coordination. The trade-off: anyone holding it can read its creation time.

## Can you use a UUID as a password-reset token?
<!-- /learn/unique-ids#uuids-v4-and-v7 -->

No. RFC 9562 says implementations should **not assume UUIDs are hard to guess**. For password-reset links or API secrets, use a dedicated random token of 128 bits or more from a cryptographic generator. Real UUID v4 collisions also come from bad randomness, such as cloned VMs, not from the math.

## How are the 64 bits of a Snowflake ID laid out, and what limits follow?
<!-- /learn/unique-ids#snowflake-style-ids -->

| Bits | Field | Limit |
|---|---|---|
| 1 | sign, always 0 | keeps it positive |
| 41 | ms since a custom epoch | about 69.7 years |
| 10 | machine ID | 1,024 generators |
| 12 | sequence | 4,096 IDs per ms per machine |

Pick a recent epoch, since counting from 1970 wastes decades of range.

## What can make a Snowflake generator produce duplicate IDs?
<!-- /learn/unique-ids#snowflake-style-ids -->

- **Clock going backwards** (NTP step, VM migration) can repeat a timestamp and sequence. Refuse to generate, keep counting from the last timestamp, or take the node out of service. Slewing the clock avoids most of it.
- **Two processes with the same machine ID.** Assign IDs reliably: static config, a ZooKeeper or etcd lease that must expire before reuse, or a StatefulSet index.

## You shard rows by snowflake_id % 16 and nearly everything lands on shard 0. Why?
<!-- /learn/unique-ids#snowflake-style-ids -->

Under light traffic, most IDs are the **first in their millisecond**, so the low sequence bits are usually 0. Taking the modulus of the raw ID then picks the same shard. Hash the ID before taking the modulus, or shard on something else. A related gotcha: JavaScript loses precision above 2^53, so APIs send Snowflake IDs as strings.

## When would you pick ULID over UUID v7?
<!-- /learn/unique-ids#ulid-and-other-formats -->

They have nearly the same layout: a 48-bit millisecond timestamp plus randomness, fitting a 16-byte column. Pick **ULID** if a shorter, URL-friendly string matters (26 Crockford base32 characters versus 36 for a UUID) and you're happy to depend on a library, since it's a community spec, not an IETF standard. Pick **v7** if your database and tooling already handle UUIDs.

## Many services write events at high volume into existing BIGINT columns. Which ID scheme fits?
<!-- /learn/unique-ids#choosing-between-them -->

**Snowflake-style** 64-bit IDs. They're compact and sorted to the millisecond with no per-ID coordination. Budget time for machine ID assignment and clock handling. If 128-bit keys were acceptable, UUID v7 would need nothing deployed. Either way, time-based IDs give only rough order across machines; for strict order in one conversation, assign a per-scope sequence at the place that owns it.

<!-- chapter: event-streaming -->

## What is the core difference between a queue like SQS and a log like Kafka?
<!-- /learn/event-streaming#queues-and-logs -->

A **queue** hands each message to one consumer and deletes it once acknowledged. A **log** appends messages to a durable sequence and keeps them until retention expires, while many readers walk through at their own pace. So a log gives you replay and cheap fan-out; a queue gives easy work-sharing but nothing to replay.

## You add consumers to a Kafka consumer group but throughput stops improving. Why?
<!-- /learn/event-streaming#the-log-model -->

Within a group, each partition goes to **exactly one consumer**, so parallelism is capped by the partition count. Consumers beyond that sit idle. Other consequences of the log model: ordering holds per partition only, replay is just resetting an offset, and a new consumer group adds read load but needs no copy of the data.

## How do you work out the minimum partition count for a Kafka topic?
<!-- /learn/event-streaming#sizing-a-log-a-worked-example -->

Divide event rate by what one consumer handles. In the example, 50,000 pings per second ÷ 2,000 per consumer = 25 consumers, so at least **25 partitions**. Round up (say to 48) for growth, because adding partitions later changes which partition a key lands in. Throughput gives bandwidth, retention gives storage, consumer speed gives partitions.

## What's the difference between at-most-once and at-least-once consumption?
<!-- /learn/event-streaming#delivery-semantics -->

It's about **when you acknowledge**:

- **At-most-once:** ack before processing. A crash after the ack loses the message.
- **At-least-once:** process, then ack. A crash before the ack causes redelivery, so the work runs twice.

Assume at-least-once for SQS, RabbitMQ with manual acks, and Kafka consumers that commit after processing. Duplicates follow crashes, rebalances and expired visibility timeouts.

## Kafka offers exactly-once semantics. Does that stop your consumer from sending a duplicate email?
<!-- /learn/event-streaming#what-exactly-once-really-means -->

No. Kafka transactions make output records and offset commits visible together, but only **within Kafka**. An email or payment call is outside that edge. True exactly-once delivery isn't achievable over an unreliable network; what you can get is exactly-once **processing**. The usual answer: at-least-once delivery with **idempotent consumers** that record applied message IDs in the same transaction as the side effect.

## What does a dead-letter queue protect against, and what makes it useless?
<!-- /learn/event-streaming#dead-letter-queues -->

It catches **poison messages** that will never succeed, moving them aside after a set number of failures. Otherwise at-least-once delivery redelivers them forever, and in a log they block everything behind them in the partition. It's useless if nobody looks: alert on its depth and have a way to redrive. Also check whether skipping a message breaks per-entity ordering.

## Why is consumer lag the main health metric for a log, and how should you alert on it?
<!-- /learn/event-streaming#back-pressure -->

Lag is the gap between the newest offset and a group's committed offset. If it grows past the **retention period**, unread records are deleted before the consumer reaches them, and that data is lost. Monitor lag in time ("40 minutes behind") as well as records, and alert well before retention. A buffer absorbs bursts, not a producer that's permanently faster.

## How should you choose a partition key for order events in Kafka?
<!-- /learn/event-streaming#choosing-a-partition-key -->

Key by **order_id**, the entity whose events must stay ordered, so "created", "paid", "shipped" arrive in sequence while different orders interleave. Avoid hot keys (one giant tenant); use a finer key or a suffix. Keep cardinality high: country with 30 values can't spread over 48 partitions. And plan the partition count up front, since hash(key) mod N moves most keys when N changes.

## Several services must react to the same events, and you want to backfill a new service later. Queue or log?
<!-- /learn/event-streaming#when-to-pick-which -->

A **log** (Kafka, Kinesis, Pulsar), with retention sized for the replay window. A queue that deletes messages on read means you can't replay or add a consumer without copying data around. The reverse mistake also happens: using Kafka for a simple background job queue adds partition counts, rebalances and head-of-line blocking a work queue wouldn't have.

<!-- chapter: reliability-patterns -->

## Why is a slow dependency often more dangerous than a dead one?
<!-- /learn/reliability-patterns -->

A dead dependency **fails fast**. A slow one ties up your threads, connections and memory until your service falls over too, and its callers follow. That chain is a **cascading failure**. Timeouts, retries, circuit breakers and load shedding are the tools for breaking it.

## How should you set a request timeout for a dependency?
<!-- /learn/reliability-patterns#timeouts-and-deadlines -->

From **measured latency**: pick a percentile such as p99.9 and add a margin. Too tight and you abort requests that would have succeeded, then probably retry them, adding load. Too loose and you hold resources for requests that are already lost. Connect timeouts can be shorter, since a healthy server accepts connections quickly. Never leave it unset: many client libraries default to no timeout, so a slow dependency becomes a stuck thread.

## The gateway gives up after 3 s, but the order service calls inventory with a 1 s timeout and 3 retries. What's wrong, and what fixes it?
<!-- /learn/reliability-patterns#timeouts-add-up-across-hops -->

Worst case is 4 × 1 s = 4 s plus backoff, for a caller that left after 3 s. The last attempts do work nobody sees. Use a **deadline**: the edge sets an absolute finish time and each service passes the remaining time downstream, failing immediately if not enough is left. gRPC builds this in.

## Why isn't exponential backoff alone enough when a thousand clients fail at once?
<!-- /learn/reliability-patterns#exponential-backoff-with-jitter -->

They all wait 100 ms, retry together, wait 200 ms, retry together. The load arrives in **synchronized spikes**. **Jitter** randomizes each wait so retries spread out. "Full jitter" sleeps a random time between zero and the exponential bound, which doubles each attempt up to a cap.

## A service sends 1,000 requests a second to a failing dependency with 3 retries each. How does a 10% retry budget change the load?
<!-- /learn/reliability-patterns#retry-storms-and-retry-budgets -->

Without a budget the dependency sees up to 1,000 × 4 = **4,000** requests a second. With a 10% budget it sees at most 1,000 + 100 = **1,100**. Retries also multiply across layers: three tiers with 3 attempts each can turn one request into 27. Retry at one layer and let inner layers fail fast.

## A retry arrives with an idempotency key the server already has. What should the server do?
<!-- /learn/reliability-patterns#how-the-server-stores-and-replays-results -->

Check the existing row:

- **request_hash differs:** the key was reused for a different request. Reject it.
- **in_progress:** another attempt is running. Return 409 and let the client retry.
- **completed:** return the stored status code and body unchanged.

Claiming the key is an insert on a primary key, so only one concurrent attempt wins.

## Your server crashes after charging the card processor but before recording the result. How do you avoid a double charge?
<!-- /learn/reliability-patterns#how-the-server-stores-and-replays-results -->

The key is stuck **in_progress** and you don't know whether the charge happened. Pass an idempotency key **downstream** to the processor too, so retrying the charge is safe there. And treat a stale in_progress row as "resume or reconcile", not "start fresh". Where possible, write the business change and mark the key completed in one transaction.

## How does a circuit breaker move between closed, open and half-open?
<!-- /learn/reliability-patterns#circuit-breakers -->

- **Closed:** calls pass and failures are counted. Opens when the failure rate crosses a threshold.
- **Open:** calls fail immediately without touching the dependency. After a cool-down, goes half-open.
- **Half-open:** a few trial calls go through. Success closes it; failure reopens it.

Keep one breaker per dependency so a failing recommendations service doesn't trip calls to payments.

## A service has 200 threads and sends 60 requests a second to reviews, which slows from 50 ms to 4 s. What happens, and what limits it?
<!-- /learn/reliability-patterns#bulkheads -->

By Little's law, reviews now needs 60 × 4 = **240 threads**, more than the service has, so every endpoint stalls, even ones that never call reviews. A **bulkhead** gives reviews its own limited pool, say 40 concurrent calls. Excess reviews calls fail fast and the other 160 threads keep serving everything else.

## When a service is overloaded, what does good load shedding look like?
<!-- /learn/reliability-patterns#load-shedding -->

- **Reject cheaply and early**, before parsing bodies or touching the database. A fast 503 or 429 beats a slow timeout.
- Use a **real overload signal**: in-flight requests, queue wait time or CPU, not just request rate.
- **Drop work whose deadline has passed.**
- **Shed by priority**: checkout before image prefetch.

## What does graceful degradation require beyond the technical fallback?
<!-- /learn/reliability-patterns#graceful-degradation -->

Decide **in advance** what reduced service looks like: stale cached data, a hidden recommendations panel, read-only mode during failover. Each is a product decision too, and needs a switch you can flip quickly. These code paths rarely run, so test them, or they'll fail on the day you need them.

<!-- chapter: distributed-transactions -->

## Why can't you just wrap an order, inventory and payment update across three services in one transaction?
<!-- /learn/distributed-transactions#why-one-transaction-cant-span-services -->

- Each service **owns its data**, so no shared engine holds locks across all of it.
- The stores may differ, and a card processor has no notion of your transaction.
- Holding locks while waiting on another service makes every concurrent request wait.
- **Availability multiplies**: three services at 99.9% give about 99.7% for the operation.

## In two-phase commit, what happens if the coordinator crashes after every participant votes yes?
<!-- /learn/distributed-transactions#two-phase-commit-and-its-blocking-problem -->

Participants are **in doubt**. They can't commit, since another participant might have voted no, and can't abort, since the coordinator might have decided commit. So they wait, **holding their locks**, until the coordinator recovers, and any transaction needing those rows waits too. That's why 2PC is a blocking protocol.

## What is a saga, and how does it handle a failure partway through?
<!-- /learn/distributed-transactions#sagas -->

A saga is a **sequence of local transactions**, one per service. Each step commits on its own and triggers the next. If a step fails, the saga runs **compensating transactions** for the steps already committed, in reverse order. It trades atomic isolation for not needing a cross-service commit.

## In a ticket-booking saga, why hold seats and authorize the card before capturing payment?
<!-- /learn/distributed-transactions#example-booking-concert-tickets -->

Cheap, invisible steps go first: releasing a hold costs nothing and voiding an authorization never shows as a charge. **Capture is the pivot**, the point after which the saga commits to finishing. Before it, everything can be compensated. After it, steps like issuing tickets must be **retried until they succeed**, so they must be idempotent.

## How is a compensating transaction different from a rollback?
<!-- /learn/distributed-transactions#example-booking-concert-tickets -->

A **rollback** makes it as if the transaction never happened. A **compensation** is a new action that semantically reverses an old one, and others may already have seen the intermediate state. If a confirmation email went out, the compensation is a second "your order was cancelled" email. Compensations must be idempotent and must not fail for business reasons.

## When would you pick saga orchestration over choreography?
<!-- /learn/distributed-transactions#orchestration-and-choreography -->

**Orchestration** suits many steps, branching and careful compensations. The flow lives in one place, it persists saga state, and "where is order 991?" has one answer. The risk is a god service. **Choreography** suits short flows of two or three steps: services just react to events, but the flow is spread out and hard to debug. Teams often start with choreography and move to orchestration as flows grow.

## A report counts seats as sold while a booking saga is still running. How do you prevent that?
<!-- /learn/distributed-transactions#the-missing-isolation -->

Sagas have **no isolation**, so use **semantic locks**: make intermediate states explicit, like an order PENDING and seats HELD rather than SOLD. Reports count only SOLD seats, and a cancel on a PENDING order is rejected or queued. Other countermeasures: reread a version before writing, and prefer commutative updates ("add 2") over "set to 7".

## A service writes an order to its database, then publishes OrderCreated to Kafka. What can go wrong, and how does an outbox fix it?
<!-- /learn/distributed-transactions#the-dual-write-problem-and-the-transactional-outbox -->

If it crashes between the two, the order exists but nobody hears about it: the **dual-write problem**. The **transactional outbox** writes the event to an outbox table in the same local transaction as the order. A relay (polling or CDC like Debezium) then publishes it. The relay may publish twice, so consumers deduplicate by event ID.

## Why use an outbox table instead of running CDC directly on the orders table?
<!-- /learn/distributed-transactions#the-dual-write-problem-and-the-transactional-outbox -->

CDC on the orders table works, but then consumers depend on your **internal table layout**, and every schema change risks breaking them. The outbox gives you an **explicit event format you control**. Key the topic by the aggregate ID, such as the order ID, so one order's events stay in order, and delete or archive outbox rows after publishing.

<!-- chapter: consensus -->

## What is split brain, and why can't a heartbeat timeout prevent it?
<!-- /learn/consensus#why-consensus-is-needed-split-brain -->

The network between an active-passive pair fails while both stay up. The passive node sees no heartbeat and promotes itself, and the old active keeps accepting writes: **two primaries** with conflicting histories. A node can't tell "the other is dead" from "I can't reach it", and timeouts can't distinguish them. So no node should decide alone that it's leader; it needs agreement from a group.

## Why are consensus clusters almost always 3 or 5 nodes and not 4?
<!-- /learn/consensus#quorums-and-majorities -->

A decision needs a **majority**, floor(N/2) + 1, and a cluster of 2f + 1 nodes survives f failures. 4 nodes tolerate the same single failure as 3 but need one more vote per write. Any two majorities share a node, so two candidates can't both win. More nodes add fault tolerance but make every write wait for more acknowledgments.

## A 5-node cluster spans three regions as 2 + 2 + 1, leader in region A. Roughly what sets commit latency?
<!-- /learn/consensus#quorums-and-majorities -->

The leader needs 2 follower acks (3 of 5 with itself). With round trips of 1 ms to its region A peer, 30 ms to region B and 70 ms to region C, the majority completes at the **first region B ack**. Commits take about **30 ms** plus disk writes, and losing all of region C doesn't change that.

## How does Raft make sure a newly elected leader doesn't lose committed entries?
<!-- /learn/consensus#terms-and-leader-election -->

A node only votes for a candidate whose **log is at least as up to date** as its own. A committed entry is on a majority, and a winner needs votes from a majority, so some voter has the entry and refuses any candidate missing it. Each node votes once per term, and randomized election timeouts mean one node usually times out first and wins.

## When is a Raft log entry committed, and what happens to an old leader stuck in a minority partition?
<!-- /learn/consensus#log-replication-and-the-commit-index -->

An entry is **committed** once a majority of nodes, counting the leader, have stored it. It will never be lost. An old leader in a minority **can't commit anything**. When it reconnects and sees a higher term, it steps down and its uncommitted entries are overwritten. Reads need care too: etcd's default reads confirm leadership with a majority first.

## Worker A's lease expired while its write was delayed, and worker B now owns the shard. How do you stop A's stale write?
<!-- /learn/consensus#leases-and-fencing-tokens -->

Use a **fencing token**: a number that increases each time the lock is granted. Each write carries it, and storage rejects anything lower than the highest it's seen. B's token 118 is accepted, so A's late write with 117 is rejected. Fencing needs the resource to cooperate, for example via a conditional write; an external API that ignores tokens can't be protected this way.

## How do you do leader election with ZooKeeper without waking every candidate when the leader dies?
<!-- /learn/consensus#zookeeper-and-etcd-in-practice -->

Each candidate creates an **ephemeral sequential znode** under /election. The lowest number is leader. Every other candidate watches **only the node just below its own**, so a leader's death wakes one successor instead of the whole group. The ephemeral node vanishes when the holder's session ends. Note that sessions take seconds to expire, so failover isn't instant; fencing covers the gap.

## A nightly idempotent cleanup job occasionally runs twice. Do you need a consensus-backed lock?
<!-- /learn/consensus#when-you-dont-need-consensus -->

No. **Duplicate work is harmless** here, so a simple lock with an expiry in Redis is fine. Consensus costs extra round trips per write, a cluster to run and unavailability on the minority side. Skip it too when your managed database already does failover, when data can merge (CRDTs), or when leaderless quorums (R + W > N) are enough.

<!-- chapter: realtime -->

## A million clients poll every 5 seconds for updates. What does that cost you?
<!-- /learn/realtime#short-polling -->

About **200,000 requests per second** just to say "nothing new", each with full HTTP headers and passing your auth and routing. An update also waits on average **half the interval** before anyone sees it. Short polling is fine when updates are rare, a few seconds of lag is acceptable and the client count is modest.

## With long polling, how do you avoid losing messages produced between one response and the next request?
<!-- /learn/realtime#long-polling -->

**Buffer them on the server**, and have the client send a **cursor** with each request ("everything after message 1841"), so nothing is lost or repeated. Other catches: each held request ties up a connection (and a thread on some servers), and proxy and load balancer timeouts must be longer than your hold time.

## What does server-sent events give you for free that you'd build yourself on WebSockets?
<!-- /learn/realtime#server-sent-events-sse -->

**Automatic reconnection** and **resume**: the browser sends the last id it saw in a Last-Event-ID header so the server picks up in the right place, and the server can set the retry delay. The limits: server-to-client only, UTF-8 text only, EventSource can't set custom headers, and about six connections per host over HTTP/1.1.

## What do WebSockets not give you, which every serious WebSocket app has to add?
<!-- /learn/realtime#websockets -->

Everything above the frame layer: **no automatic reconnection, no resume-from-message-id, no request/response correlation, no delivery acknowledgement**. You build a small protocol on top with message ids, acks, heartbeats and a reconnect-and-catch-up routine. In return you get full-duplex text or binary frames with 2 to 14 bytes of framing.

## You expect 8 million concurrent users and each gateway holds 100,000 connections. How many gateways do you plan for?
<!-- /learn/realtime#how-many-connections-per-server -->

8,000,000 ÷ 100,000 = 80 at full load. Run at about 70% so some can fail or drain for deploys: 80 ÷ 0.7 ≈ **115 servers**. Message rate matters as much: one message a minute per connection is about 1,700 per second per server, but 20 updates a second each would be 2 million.

## A backend produces a message for user 42, who is connected to one of 200 gateways. How does it reach them?
<!-- /learn/realtime#getting-a-message-to-the-right-server -->

- **Pub/sub layer:** each gateway subscribes to channels for users it holds; producers publish. Handles group fan-out naturally.
- **Connection registry:** gateways record "user 42 is on gateway 17"; producers look it up and call directly. Must be cleaned up when a gateway dies.

Either way, **persist the message first**, then push, so a reconnecting client can catch up.

## Why do realtime connections need heartbeats every 20 to 30 seconds?
<!-- /learn/realtime#heartbeats -->

TCP doesn't reliably tell you the other side vanished, so a phone dropping off Wi-Fi leaves a **half-open connection**. NAT gateways, carriers and load balancers also silently drop idle connections; AWS's ALB defaults to 60 seconds. A ping with a pong timeout keeps the connection active and detects death quickly. The cost is mobile battery and bandwidth.

## A gateway holding 100,000 connections crashes. How do you stop the reconnect wave from taking down the rest?
<!-- /learn/realtime#reconnect-storms -->

- Clients reconnect with **exponential backoff plus jitter**, spreading the wave over tens of seconds.
- For deploys, **drain gradually**: stop new connections, close old ones in small batches.
- Make **catch-up cheap**: serve "messages after id X" from an index or cache, and cap how far back a reconnect can ask.
- Keep **spare capacity** on the survivors.

## Which realtime transport fits a "refresh order status" screen, and which fits multiplayer collaborative editing?
<!-- /learn/realtime#how-to-choose -->

- **Order status:** updates are rare and a few seconds of lag is fine, so **short polling**. It's cheapest to build and run.
- **Collaborative editing:** both sides send frequently, so **WebSockets**, plus the reconnect, ack and heartbeat protocol you'll build on top.

Then say how messages reach the right server, how clients catch up and how you survive a mass reconnect.

<!-- chapter: observability -->

## Checkout errors spiked at 02:10. How do metrics, traces and logs each help you find the cause?
<!-- /learn/observability#metrics-logs-and-traces -->

They work as a funnel:

- **Metrics** show the error rate on payments jumped at 02:10.
- A **trace** of a failing request shows time going into the fraud-check call.
- That service's **logs**, filtered by trace id, show it timing out against a database replica.

The shared **trace id** in logs and traces is what joins them into one investigation.

## What's the difference between the RED and USE methods?
<!-- /learn/observability#red-and-use -->

**RED** is for anything serving requests: Rate, Errors, Duration (as percentiles). It tells you users are affected. **USE** is for resources like CPUs, disks, pools and queues: Utilization, Saturation, Errors. It tells you which resource is the bottleneck. For async pipelines, add queue depth and the **age of the oldest unprocessed message**.

## Your SLO is 99.9% over 30 days. How big is the error budget, and how should teams use it?
<!-- /learn/observability#slis-slos-and-error-budgets -->

0.1% of 43,200 minutes is about **43.2 minutes** of full outage. At 500 million requests a month, it's **500,000 requests** allowed to be slow or fail. If the budget is mostly unspent, ship faster and take risks. If it's gone, slow down and fix reliability. It also stops teams chasing 100%, which no system reaches.

## 95 requests take 50 ms and 5 take 2,000 ms. Why is the mean a misleading summary?
<!-- /learn/observability#percentiles-not-averages -->

The mean is **147.5 ms**, and not a single request took that long. The median is 50 ms and the **p99 is 2,000 ms**: one in twenty users waited 2 seconds. Report p50, p95 and p99. Also, you can't average per-host p99s; record latency as fixed-bucket **histograms**, which you can add across hosts and then read percentiles from.

## A page makes 100 parallel backend calls, each slow 1% of the time. How often is the page slow?
<!-- /learn/observability#percentiles-not-averages -->

About **63%** of the time: 1 − 0.99^100 ≈ 1 − 0.366. Tails **compound under fan-out**, so the backend's p99 becomes the page's typical case. That's why per-hop p99 matters even when it looks rare.

## CPU is at 90% but requests are fast. Should that page someone?
<!-- /learn/observability#alerting-on-symptoms -->

No. **Page on symptoms** users feel: SLO violations, error rates, latency. Causes like CPU, memory, disk and replica lag belong on dashboards, or in low-urgency tickets when they predict trouble (a disk full in four days). Every page should mean users are hurting and a human must act now, and every alert needs an owner and a runbook.

## What does a burn rate of 14.4 mean for a 99.9% SLO, and why alert on burn rate?
<!-- /learn/observability#alerting-on-symptoms -->

It's an error rate of 14.4 × 0.1% = **1.44%**. Sustained for an hour it spends 14.4 ÷ 720 = **2% of the monthly budget**, which is worth a page. A burn rate of 1 for days is worth a ticket. Pair a long window with a short one (say 1 hour and 5 minutes) so alerts fire fast and clear quickly once the problem stops.

## When would you choose tail sampling over head sampling for traces?
<!-- /learn/observability#sampling -->

When you want to **keep the interesting traces**. **Head sampling** decides at the start ("keep 1%") and passes the decision downstream: cheap, but it decides before knowing if the request will be slow or fail. **Tail sampling** buffers all spans until the trace finishes, then keeps slow or failed ones plus a small random share. The cost: collectors hold every span briefly, and a trace's spans must reach the same collector.

## How does a trace follow one request across several services?
<!-- /learn/observability#distributed-tracing -->

Each span records a trace id, its own span id and its parent's span id. Context travels in the W3C **traceparent** header: version, trace id, parent span id and flags. Each service reads it, creates a child span and sends a new traceparent with its own span id as parent. For async hops, put the same context in **message headers** so the trace follows through the queue.

## Why shouldn't you add a customer_id label to an HTTP request metric?
<!-- /learn/observability#cardinality-and-cost -->

Every unique label combination is a separate **time series**, and the count is the product of each label's values. 500,000 series times 10,000 customers is up to **5 billion**, enough to slow queries, run up the bill or knock over the backend. Keep labels small and bounded (endpoint templates like /orders/{id}). Put user and order ids in logs and trace attributes, where you pay per event.

