# Cache 101: failure modes, topologies and consistency

Putting an in-memory cache in front of a database is usually the first fix anyone suggests when queries get slow. The idea fits in one sentence: check Redis, and if the key isn't there, query the database and store the result in Redis with a one-hour TTL.

Most of the trouble comes later, in production. When a service takes 50,000 requests a second, one hot key expiring can send thousands of identical queries to the database at once (a **thundering herd**). A cache restart, or a batch of keys that all expire together, can do the same thing across the whole key space (a **cache avalanche**). Requests for IDs that don't exist skip the cache every time and land on the database (**cache penetration**). And two writers updating the cache and the database in different orders can leave the cache holding a stale value until its TTL runs out.

This chapter covers those three failure modes and their standard fixes, where caches sit in a system, how Redis is built and how it compares with Memcached, Redis Sentinel and Redis Cluster with its 16,384 hash slots, and how to keep a cache consistent with the database, ending with invalidation driven by change data capture (CDC). It's a companion to the primer's [cache](/learn/cache) chapter and builds on [reliability patterns](/learn/reliability-patterns).

## Failure modes and how to prevent them

All three failure modes end the same way: requests the cache was supposed to absorb reach the database instead, faster than it can serve them.

```diagram
title: Three ways load gets past the cache
[stampede] Stampede\none hot key\nexpires @ 0,0
[avalanche] Avalanche\nmany keys expire\nor cache restarts @ 1.5,0
[penetration] Penetration\nkeys that\ndon't exist @ 3,0
[db:store] Database\noverloaded @ 1.5,1.5
stampede --> db : same query × N
avalanche --> db : misses on every key
penetration --> db : every lookup
```

### Cache stampede (thundering herd)

A **cache stampede** happens when a very popular key, such as the front-page story on a news site, expires or is evicted. Every request that arrives before someone puts the value back is a miss, and every miss runs the same query.

Some numbers, as an illustration. Say the key gets 10,000 reads a second and takes 200 ms to rebuild from the database:

- While the key is missing, 10,000 × 0.2 s = **2,000 requests** miss it.
- Each of them runs the same expensive query.
- The database's connection pool fills up, queries queue, and the 200 ms rebuild gets slower, which keeps the key missing for longer and lets even more requests through. Without a fix this feeds on itself.

There are three common fixes.

#### Fix 1: a lock, so only one request rebuilds

On a miss, a request tries to take a short-lived lock for that key before going to the database. In Redis that's one command, `SET lock:<key> <random-token> NX PX 5000`, which succeeds only if the lock doesn't exist yet and expires on its own after 5 seconds in case the holder dies.

- **The request that gets the lock** queries the database, writes the value into the cache, and releases the lock. Release it with a small Lua script that deletes the lock only if it still holds your token, so you never delete a lock that expired and was taken by someone else.
- **Every other request** waits briefly (say 50 ms) and reads the cache again, or serves a slightly stale copy if you keep one around.

This costs a lock round trip on every miss and makes waiting requests slower, but the database sees one query instead of 2,000. Facebook's memcache paper describes a similar idea called **leases**: the cache itself hands out a token to the first missing client and tells the others to retry shortly.

#### Fix 2: probabilistic early expiration (XFetch)

The 2015 paper *Optimal Probabilistic Cache Stampede Prevention* by Andrea Vattani, Flavio Chierichetti and Keegan Lowenstein describes an algorithm called **XFetch**. Instead of waiting for the key to expire, each reader decides at random whether to refresh it early, and the chance of refreshing goes up as expiry gets closer.

Store two extra things with the value: `delta`, how long the last rebuild took, and `expiry`, the time the value expires. On every read:

```text
if now − delta × beta × ln(rand()) ≥ expiry:
    recompute the value, store it with a new expiry and a new delta
else:
    return the cached value
```

- `rand()` is a uniform random number in (0, 1]. Its natural log is zero or negative, so `−delta × beta × ln(rand())` is a positive amount of time. That amount follows an exponential distribution with mean `delta × beta`.
- In words: refresh early if a random "head start" is larger than the time left before expiry (`expiry − now`).
- `beta` defaults to 1. Larger values refresh earlier; smaller values refresh later.

When expiry is far away, the head start almost never covers the time left, so nobody refreshes. In the last few multiples of `delta` before expiry, the probability climbs quickly. With many readers, one of them is very likely to refresh before the key expires, so most readers never see a miss. Scaling by `delta` matters: a value that takes 2 seconds to rebuild starts refreshing much earlier than one that takes 20 ms.

It's probabilistic, so it doesn't guarantee a single refresh. Two readers can both win the draw at nearly the same moment, which just means two queries instead of one. A key read only rarely may still expire before anyone refreshes it, but a rarely read key can't cause a stampede anyway. The paper shows this exponential rule is the best trade-off between refreshing too early (wasted work) and too late (a stampede). No locks or coordination are needed. Teams often combine it with a lock as a backstop.

#### Fix 3: refresh in the background

For a handful of known hot keys, don't let them expire at all. A background job rebuilds them on a schedule and overwrites the cache entry. Readers never miss. This works well for a small, known set of keys and doesn't scale to millions of them.

### Cache avalanche

A **cache avalanche** is the same problem across many keys: a large share of the key space misses at the same time. Two common causes:

- **Keys that expire together.** A batch job warms the cache at 02:00 and sets every key with the same TTL, for example `redis.set(key, value, ex=3600)`. At 03:00 every one of those keys expires within the same second, and all their traffic hits the database.
- **A cache node restarting empty.** If a Redis node holding a third of the keys dies and comes back with no data, every request for those keys misses until they're rebuilt.

#### Fix: add jitter to TTLs

Don't give a batch of keys the same TTL. Add a random amount (**jitter**) to each:

```python
import random

def cache_set_with_jitter(redis, key, value, base_ttl=3600, jitter_pct=0.15):
    # ±15% of one hour: somewhere between 3,060 and 4,140 seconds
    spread = base_ttl * jitter_pct
    ttl = base_ttl + random.uniform(-spread, spread)
    redis.set(key, value, ex=int(ttl))
```

The keys now expire spread over about 18 minutes instead of in one second, and the database sees a steady trickle of rebuilds.

For the restart case, jitter doesn't help. What helps is replicas that can take over with their data intact (see Sentinel and Cluster below), warming a new node before it takes traffic, and putting a [circuit breaker or rate limit](/learn/reliability-patterns) in front of the database so a burst of misses gets shed instead of taking it down.

### Cache penetration

**Cache penetration** happens when clients ask for keys that don't exist in the database at all, for example `GET /users/-9999`, or a scanner trying random IDs. The usual cache-aside code does this:

1. The request misses the cache.
2. It queries the database and finds no row.
3. There's nothing to cache, so nothing is cached.
4. The next request for the same ID does exactly the same thing.

The cache never helps. Someone sending 20,000 made-up IDs a second sends 20,000 queries a second straight to the database.

#### Fix 1: cache the "not found"

When the database returns nothing, cache a marker for that key with a short TTL:

```python
redis.set("user:-9999", "__none__", ex=60)
```

For the next 60 seconds, requests for that ID get a 404 from the cache. Keep the TTL short, because the ID might be created later. This works well for repeated misses on the same IDs. It does little against random IDs, since each new ID is a new miss, and it fills the cache with markers.

#### Fix 2: a Bloom filter in front of the cache

A **Bloom filter** is a compact data structure that answers "is this key in the set?" with either "definitely not" or "probably yes". It's an array of m bits and k hash functions:

- To add a key, hash it k times and set those k bits to 1.
- To check a key, hash it k times. If any of those bits is 0, the key was never added. If all are 1, it was probably added, though other keys might have set those bits (a false positive).

You size it for the false positive rate you want. About 9.6 bits per key gives a 1% false positive rate, so 100 million keys fit in roughly 120 MB.

To use it against penetration, add every ID to the filter when the row is created, and check the filter before the cache:

- **"Definitely not"**: return 404 without touching the cache or the database.
- **"Probably yes"**: go on to the cache and then the database as usual. About 1% of requests for missing IDs still get through, which is fine.

```diagram
title: A Bloom filter turns away IDs that don't exist
[client:client] Client\nGET /users/:id @ 0,0
[bloom] Bloom filter @ 1.5,0
[cache:store] Redis cache @ 3,0
[db:store] Database @ 3,1.2
client <-> bloom : "definitely not": 404
bloom -> cache : "probably yes"
cache -> db : cache miss
```

Two caveats. A plain Bloom filter can't remove keys, so deleted IDs stay "probably yes" until you rebuild it periodically (or use a variant such as a counting Bloom filter or cuckoo filter). And the filter must learn about a new ID before anyone asks for it, so add to it in the same code path that creates the row, or a new user can briefly get a 404.

## Where caches sit

Caches appear at several layers. The two you design for most often in a back end are a cache inside each application process and a shared cache on the network.

```diagram
title: A two-tier cache
[client:client] Client @ 0,0.5
[svc1] App server 1\nL1 local cache @ 1.5,0
[svc2] App server 2\nL1 local cache @ 1.5,1
[l2:store] L2: Redis\ncluster @ 3,0.5
[db:store] Database @ 3,1.7
client -> svc1
client -> svc2
svc1 -> l2 : L1 miss
svc2 -> l2 : L1 miss
l2 -> db : L2 miss
```

### Local (L1) vs distributed (L2) caches

| | Local, in-process (Caffeine, Guava, a plain LRU map) | Distributed (Redis, Memcached) |
|---|---|---|
| Where it lives | In the application's own memory | Separate servers, reached over the network |
| Read latency | Well under a microsecond: a hash lookup in memory | Typically a few hundred microseconds to about a millisecond, mostly network round trip |
| Throughput | Limited by the app's CPU, often millions of lookups a second | Roughly 100,000 or more simple operations a second per Redis node |
| Consistency | Each server has its own copy, and copies can disagree | One copy per key, shared by every app server |
| Size | Limited by the process's memory, usually a few GB | Can grow to terabytes by adding nodes |
| Survives a deploy | No, it's empty after a restart | Yes |

Large systems often use both, as a **two-tier cache**:

- Each app server keeps a small L1 with a very short TTL, a few seconds. That bounds how stale it can get.
- On an L1 miss, it reads the shared L2.
- When an entity changes, a message on Redis pub/sub or Kafka tells every app server to drop its L1 copy. The short TTL covers any message that gets lost.

The L1 takes the hottest keys off the network entirely, which also protects the L2 from a single hot key overloading one Redis node.

## Redis internals and Memcached

A single Redis process commonly handles more than 100,000 simple operations a second. Keeping data in RAM is part of the reason, but there are three others.

### A single thread for commands

Redis runs every command on **one thread**.

- There are no locks inside Redis and no contention between threads. Each command runs to completion before the next starts, so every single command is atomic. `INCR` from two clients can't lose an update.
- One thread serves thousands of connections using I/O multiplexing (**epoll** on Linux, **kqueue** on macOS and BSD): the kernel reports which sockets have data, and Redis handles each in turn.
- Since Redis 6.0, reading and writing sockets can be spread over extra I/O threads, but commands themselves still execute on the main thread.

The cost is that one slow command blocks everyone. `KEYS *` on a large database, or deleting a set with millions of members, stalls every client for its duration. Use `SCAN` and `UNLINK` (which frees memory in the background) instead.

### Data structures built for memory

Redis stores typed values, and picks a compact encoding when a value is small:

- **Strings**: binary-safe, with length stored so `STRLEN` is O(1).
- **Hashes, lists and small sorted sets**: stored as a compact **listpack** (one contiguous block of memory) while small, and converted to a real hash table, list or skip list once they pass a configurable size. For hashes the default limit is 128 entries.
- **Sets of integers**: stored as a sorted integer array (intset) up to 512 members by default.
- **Sorted sets**: a **skip list** plus a hash table, giving O(log N) inserts and rank and range queries. This is why Redis is popular for [leaderboards](/learn/design-gaming-leaderboard).
- **HyperLogLog**: estimates the number of distinct items in a set using at most 12 KB, with a standard error of 0.81%.
- **Bitmaps**: one bit per user ID, for things like daily active user flags.

### Redis vs Memcached

| | Redis | Memcached |
|---|---|---|
| Values | Strings, hashes, lists, sets, sorted sets, streams and more, with server-side operations on them | Opaque byte strings |
| Threads | One thread runs commands (I/O can use more) | Multi-threaded, so one process uses all cores |
| Persistence | Optional snapshots (RDB) and append-only log (AOF) | None, memory only |
| Replication and failover | Built in, plus Sentinel and Cluster | None; clients spread keys across servers with consistent hashing |
| Typical use | Cache plus counters, queues, rate limits, leaderboards, locks | A large, simple, fast key-value cache |

If all you need is a big cache of serialized objects, Memcached is simple and scales well on many-core machines. Most teams choose Redis because the data structures, replication and persistence let one system cover several jobs.

## Redis Sentinel vs Redis Cluster

Redis offers two ways to run more than one node. They solve different problems: Sentinel keeps one dataset available, and Cluster splits the dataset across nodes.

```diagram
title: Sentinel (failover) and Cluster (sharding)
[m1:store] Primary @ 0,0
[r1:store] Replica @ 0,1.2
[sent] Sentinels\n(3 processes) @ 1.5,0.6
[n1:store] Node A\nslots 0–5460 @ 2.9,0
[n2:store] Node B\nslots\n5461–10922 @ 3.9,0.6
[n3:store] Node C\nslots\n10923–16383 @ 2.9,1.2
m1 -> r1 : replicates
sent --> m1 : monitor
sent --> r1 : promote
```

### Redis Sentinel

- You run one primary and one or more replicas, all holding the full dataset.
- A group of Sentinel processes (at least three, on separate machines) checks them with heartbeats.
- When enough Sentinels to reach the configured quorum agree the primary is down, they elect a leader among themselves, which promotes a replica and tells clients where the new primary is.
- Sentinel gives you **high availability, not more write capacity**. Every write still goes to one primary, and the dataset must still fit on one machine.

Replication is asynchronous, so writes acknowledged by the old primary just before it failed can be lost in a failover.

### Redis Cluster

Redis Cluster splits the key space across several primaries, each with its own replicas.

- The key space is divided into **16,384 hash slots**. Each key belongs to one slot:

  ```text
  slot = CRC16(key) mod 16384
  ```

- Each primary owns a set of slots. With three primaries, a default setup gives node A slots 0–5,460, node B slots 5,461–10,922 and node C slots 10,923–16,383.
- Moving data between nodes means moving slots. Adding a node is a matter of handing it some slots from the others; keys never need to be rehashed.
- **Hash tags** keep related keys together. If a key contains `{...}`, only the part inside the braces is hashed. `{user:100}:profile` and `{user:100}:orders` both hash `user:100`, so they land in the same slot. That matters because multi-key commands (`MGET`, `MULTI`/`EXEC` transactions, Lua scripts) only work when all their keys are in one slot; otherwise Redis returns a `CROSSSLOT` error.
- **Clients route requests themselves.** A cluster-aware client keeps a copy of the slot-to-node map and sends each command straight to the right node. If the slot has moved, the node replies with a redirect such as `-MOVED 3999 10.0.0.2:6379`, and the client updates its map and retries there. While a slot is mid-migration, a node can answer `-ASK` instead, which redirects just that one request.

Why 16,384? The Redis author's explanation is about message size: nodes gossip a bitmap of the slots they own, and 16,384 bits is 2 KB, which keeps heartbeat messages small while still allowing far more slots than any realistic cluster has nodes (the recommended maximum is about 1,000 nodes).

## Keeping the cache consistent with the database

When data changes, two questions come up: update the cache or delete the key? And touch the database first or the cache first? The wrong answers leave a stale value in the cache that nothing will correct until the TTL expires.

### Why "update the database, then update the cache" goes wrong

Two writers change the same user at nearly the same time:

1. Writer A sets the name to "Ann" in the database.
2. Writer B sets the name to "Bea" in the database. The database now says "Bea".
3. Writer B writes "Bea" into the cache.
4. Writer A, delayed by a slow network or a GC pause, writes "Ann" into the cache.

The database says "Bea" and the cache says "Ann", and every reader sees "Ann" until the TTL expires. The two writes reached the two systems in different orders, and nothing ties them together.

### Cache-aside with delete after commit

The usual pattern is **cache-aside** (also called lazy loading), with deletes instead of updates:

1. **Reads:** check the cache. On a miss, read the database and put the result in the cache.
2. **Writes:** update the database. After the transaction **commits**, delete the key from the cache.

Deleting has no ordering problem between writers: two deletes in any order leave the same result, an empty slot. The next read loads whatever the database holds at that moment.

```diagram
title: Cache-aside: reads fill the cache, writes delete from it
[app] App server @ 0,0.5
[db:store] Database @ 2.2,0
[cache:store] Cache @ 2.2,1
app -> db : 1. write, commit
app -> cache : 2. DEL key
```

### Why not delete the cache first?

Deleting before the database write has a wide race window:

1. Writer A deletes `user:1` from the cache, then starts its database transaction to change "Alice" to "Bob".
2. Before A commits, reader B gets a miss on `user:1`.
3. B reads the database and gets the old value, "Alice", because A hasn't committed.
4. B writes "Alice" into the cache.
5. A commits "Bob".

The database says "Bob", the cache says "Alice", and nothing will fix it before the TTL. The window is the whole length of A's transaction, which can be many milliseconds, so this happens regularly under load.

Delete-after-commit still has a race, just a much narrower one. A reader misses, reads the old value from the database, and then stalls. Meanwhile a writer commits and deletes the key. Then the reader wakes up and writes the old value into the cache. For this to happen, the reader's database read has to happen before the commit and its cache write after the delete, which means the reader was slower than the whole write. It's rare, but it does happen at scale. Common defenses:

- **Always set a TTL**, so any stale value has a limit on how long it lasts.
- **Delayed double delete**: delete again a second or so after the write, catching a late stale fill.
- **Leases or versioned writes**: let the cache reject a fill that started before the most recent delete. Facebook's memcache leases do this.

### Invalidation with change data capture

Delete-after-commit has one more gap. If the app server crashes, or loses its connection to Redis, after the commit but before the `DEL`, the key is never deleted. You can retry, but a crash loses the retry too.

**Change data capture (CDC)** moves invalidation out of the application. The database already records every committed change in its log (the PostgreSQL write-ahead log or the MySQL binlog). A CDC tool reads that log and turns each change into an event.

```diagram
title: Cache invalidation driven by the database log
[app] App server @ 0,0
[db:store] Database\nWAL / binlog @ 1.5,0
[cdc] Debezium\n(CDC) @ 3,0
[kafka:queue] Kafka topic @ 3,1.2
[worker] Invalidation\nworker @ 1.5,1.2
[cache:store] Redis @ 0,1.2
app -> db : SQL writes only
db --> cdc : reads the log
cdc --> kafka : change event
kafka --> worker
worker -> cache : DEL user:42
```

How it works:

1. The application runs ordinary SQL transactions. It has no cache invalidation code.
2. The database writes each change to its log as part of committing.
3. **Debezium** (usually running as a Kafka Connect connector) reads the log through the database's replication interface: logical decoding in PostgreSQL, the binlog in MySQL. It emits events only for transactions that committed, so a rolled-back write never causes an invalidation.
4. Each change becomes an event on a **Kafka** topic, one topic per table, named like `<prefix>.<schema>.<table>`. The event carries the row's key, and the before and after values.
5. An invalidation worker consumes the topic and runs `DEL user:42` in Redis.

What you get:

- **No coupling in the write path.** A Redis outage can't fail or slow down a database transaction.
- **No lost invalidations.** The worker commits its Kafka offset only after the `DEL` succeeds. If it crashes, it restarts from the last committed offset and replays some events. Delivery is at least once, and since deleting a key twice is harmless, the duplicates don't matter.
- **Every writer is covered**, including batch jobs, admin scripts and other services that write to the same tables and know nothing about the cache.

What it costs: a pipeline (Kafka, Kafka Connect, Debezium) you have to run and monitor, and invalidation that lags the commit by the pipeline's delay, usually milliseconds to a second or two. During that lag readers can see the old value, so CDC gives you eventual consistency, not read-your-writes. It also doesn't close the stale-fill race described above, so keep TTLs. The [event streaming](/learn/event-streaming) chapter covers Kafka in more depth.

## Check yourself

<details>
<summary>How does XFetch avoid a stampede without any locks, and why is the early-refresh window scaled by how long the value takes to compute?</summary>

Every reader runs the check `now − delta × beta × ln(rand()) ≥ expiry`. Because `−ln(rand())` is exponentially distributed, each reader draws a random head start whose average is `delta × beta`, where `delta` is how long the last rebuild took. If the head start reaches past the expiry time, that reader refreshes the value early and resets the expiry. Far from expiry the chance is close to zero; in the last few multiples of `delta` it rises quickly. With a hot key, many readers draw every second, so one is very likely to refresh before the key expires, and the rest never see a miss. No coordination is needed, though two readers occasionally refresh at once.

Scaling by `delta` matters because the refresh has to finish before the key expires. A value that takes 2 seconds to build needs to start refreshing seconds ahead; one that takes 20 ms only needs a few tens of milliseconds.

</details>

<details>
<summary>A batch job warms 5 million keys at 02:00 with a TTL of exactly one hour. What happens at 03:00, and what one-line change fixes it?</summary>

At 03:00 all 5 million keys expire within about a second. Every request for any of them misses at once, and the database gets the whole read load the cache was absorbing: a cache avalanche. The fix is jitter: set each key's TTL to the base value plus a random offset, for example 3,600 s ± 15%, so the expirations spread over about 18 minutes and the database sees a steady stream of rebuilds instead of a wall.

</details>

<details>
<summary>Why is "delete the cache, then update the database" worse than "update the database, then delete the cache"?</summary>

If you delete first, any reader that arrives while the write transaction is still open misses the cache, reads the old committed value from the database, and puts it back in the cache. When the writer commits, the cache holds the old value and nothing will remove it before the TTL. The window is the whole transaction, so this happens often.

If you update first and delete after the commit, the only race needs a reader that read the old value before the commit and then wrote it into the cache after the delete, meaning the reader was slower than the entire write. That's much rarer. TTLs, a delayed second delete, or leases handle what's left.

</details>

<details>
<summary>How does Redis Cluster decide which node holds a key, and how do you make sure `user:42`'s profile and orders can be read in one `MGET`?</summary>

Redis Cluster computes `CRC16(key) mod 16384` to get one of 16,384 hash slots, and each primary owns a set of slots. Clients cache the slot map and follow `MOVED` redirects when it changes. By default, `user:42:profile` and `user:42:orders` hash to unrelated slots, probably on different nodes, and a multi-key command across them fails with a `CROSSSLOT` error. Name them `{user:42}:profile` and `{user:42}:orders`: when a key contains braces, only the text inside is hashed, so both keys land in the slot for `user:42` and `MGET` works.

</details>

<details>
<summary>Your service caches users, but a nightly batch job and a second service also write to the users table. Why is CDC a better fit here than delete-after-commit in your code?</summary>

Delete-after-commit only works for writes that go through your code. The batch job and the other service don't know about your cache, so their changes never trigger a delete, and the cache serves stale users until TTLs expire. CDC reads the database's own log, so every committed change produces an invalidation event no matter who wrote it. It also survives crashes: the worker resumes from its last Kafka offset, and repeating a `DEL` is harmless. The cost is running the pipeline and accepting a short lag before invalidation.

</details>

## Further reading

- [Optimal Probabilistic Cache Stampede Prevention](https://www.vldb.org/pvldb/vol8/p886-vattani.pdf) (Vattani, Chierichetti and Lowenstein, VLDB 2015): the XFetch algorithm and why the exponential rule is the right one.
- [Scaling Memcache at Facebook](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala) (Nishtala et al., NSDI 2013): leases against stampedes and stale sets, and invalidation across regions.
- [Redis cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/): hash slots, hash tags, gossip, and `MOVED` and `ASK` redirects.
- [Debezium architecture](https://debezium.io/documentation/reference/stable/architecture.html): how Debezium reads database logs and publishes change events through Kafka Connect.
- [Space/Time Trade-offs in Hash Coding with Allowable Errors](https://dl.acm.org/doi/10.1145/362686.362692) (Burton H. Bloom, 1970): the paper that introduced Bloom filters.
