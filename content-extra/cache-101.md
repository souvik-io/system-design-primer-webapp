# Caching

This chapter answers eight questions:

- What is a cache, and why does it make pages faster and databases less busy?
- Where can a cache live, from the user's browser down to the database?
- What should you cache, and why are whole objects easier to keep correct than query results?
- When does data get into the cache and back out of it? The common strategies are cache-aside, read-through, write-through, write-behind and refresh-ahead.
- What happens when the cache runs out of memory?
- How do caches fail under heavy load, and how do you stop that from happening?
- How do Redis and Memcached work, and how do you run Redis on more than one machine?
- How do you keep the cache consistent with the database?

We'll keep using **Crumb**, the recipe site from [Scalability 101](/learn/scalability-101). Crumb already runs several app servers behind a load balancer, with a Redis cache in front of its database. [Scalability 101's caching section](/learn/scalability-101#caching) explained why Crumb added that cache. This chapter covers how to run one well.

## What a cache is

A **cache** is a store that keeps copies of results you have already computed or fetched. When the same request comes again, you return the saved copy instead of doing the work a second time. A few terms come up constantly:

- A **cache hit** is a request the cache can answer from a saved copy.
- A **cache miss** is a request the cache can't answer, so the work has to be done the slow way.
- The **hit ratio** is the share of requests that are hits. A cache with a 95% hit ratio sends only 5 requests in 100 to the slow system behind it.
- An **entry** is one saved copy, stored under a **key** such as `recipe:812`.

Ricky Ho's [2010 catalog of scalable design patterns](http://horicky.blogspot.com/2010/10/scalable-system-design-patterns.html) calls this the **result cache** pattern. A dispatcher receives each request. It "will first lookup if the request has been made before and try to find the previous result to return," which saves running the request again.

**Crumb's recipe page.** Showing recipe 812 takes five database queries: the recipe, its ingredients, its photos, its ratings and its author. Together they take about 40 ms. If Crumb stores the finished result under `recipe:812`, the next visitor gets it from memory in about a millisecond, and the database does no work at all.

So a cache does two things. **Pages load faster**, because a hit skips the slow work. And **servers and databases do less work**, because hits never reach them.

### Caches smooth out uneven load

Databases work best when reads and writes are spread evenly across their partitions. (A **partition** is one slice of the data, often on its own machine. [Relational databases](/learn/relational-databases#sharding-splitting-one-table-across-databases) covers how data gets split this way.) Popular items break that balance. If one item gets most of the traffic, the partition that holds it becomes a bottleneck while the others sit idle.

Crumb sees this when a food influencer posts a link to recipe 812, and that one recipe gets thousands of views a second. Without a cache, all of them land on the one database shard that stores it. With a cache in front, almost all of them are hits, and the shard sees about one query each time the cached copy expires. The cache absorbs the uneven load and the spike.

## Where caches live

A request can be answered from a cache at several points on its way to the database. Each layer catches some requests so the layers behind it see fewer.

```diagram
title: A request passes several caches before it reaches the database
[client:client] Browser\ncache @ 0,0
[cdn] CDN edge @ 1,0
[proxy] Reverse proxy\ncache @ 2,0
[app] App server @ 3,0
[redis:store] Redis or\nMemcached @ 3,1.3
[db:store] Database\nbuffer cache @ 4,0
client -> cdn
cdn -> proxy
proxy -> app
app -> redis : 1. check
app -> db : 2. on a miss
```

### Client caching

Caches can live on the client side, on the server side (for example inside a reverse proxy), or in a separate cache layer. The first one is on the user's own device. The browser keeps copies of images, scripts and pages, and the operating system keeps recent DNS answers. A request answered there never crosses the network. The server controls what the browser may keep, and for how long, with HTTP headers such as `Cache-Control`, which [DNS and CDN 101](/learn/dns-and-cdn-101#http-caching-headers) explains.

### CDN caching

A **content delivery network (CDN)** is a set of servers spread around the world that keep copies of your content close to users. That makes a CDN a kind of cache. Crumb's recipe photos and JavaScript come from a CDN server near each user. [DNS and CDN 101](/learn/dns-and-cdn-101#content-delivery-networks) covers how CDNs work.

### Web server caching

A **reverse proxy** is a server that sits in front of your app servers and receives requests on their behalf ([Reverse proxy and API gateway 101](/learn/reverse-proxy-and-api-gateway-101#forward-proxy-vs-reverse-proxy) explains them). Reverse proxies and dedicated HTTP caches can store responses and serve both static and dynamic content directly. Varnish Cache is a well-known example: "a caching HTTP reverse proxy", in its project's words. It was [renamed Vinyl Cache](https://vinyl-cache.org/intro/index.html) between its September 2025 and March 2026 releases. Web servers can also cache responses, so a repeated request is answered without contacting an application server.

At Crumb, the logged-out version of a recipe page is the same for everyone. If the reverse proxy keeps it for 60 seconds, the app servers build that page at most once a minute.

### Database caching

Your database already caches. It keeps recently used data pages in memory so it doesn't have to read them from disk every time. The default settings suit a generic workload, and tuning them for your own usage pattern can make a real difference.

PostgreSQL is a good example. Its main cache setting, `shared_buffers`, defaults to "typically 128 megabytes". The [PostgreSQL documentation](https://www.postgresql.org/docs/current/runtime-config-resource.html) says that on a dedicated database server with 1 GB or more of RAM, "a reasonable starting value for `shared_buffers` is 25% of the memory in your system." It adds that PostgreSQL "also relies on the operating system cache", so going above about 40% of RAM is unlikely to help.

Not every built-in cache worked out. [Relational databases](/learn/relational-databases#the-query-cache-and-why-its-gone) tells how MySQL removed its query cache because it didn't scale on many-core machines.

### Application caching

**Application caching** means your code stores results in a cache that you control. The usual tools are **Memcached** and **Redis**. Both are **in-memory key-value stores**: you store a value under a key, and you fetch it back by the same key. They sit between your application and your database.

They are fast because they keep data in RAM. A typical database stores its data on disk, and reading memory is much faster than reading disk. Will Larson's [introduction to architecting systems for scale](https://lethain.com/introduction-to-architecting-systems-for-scale/) puts it this way: "accesses to RAM are orders of magnitude faster than those to disk."

RAM is also much smaller and more expensive than disk, so a cache can't hold everything. It needs a rule for what to remove when it is full. The most common rule is **least recently used (LRU)**: throw out the entry that has gone longest without being read. This removes "cold" entries that nobody is asking for and keeps "hot" entries in memory. [When the cache is full](#when-the-cache-is-full) covers these rules in detail.

Redis does more than Memcached. It has:

- **A persistence option**, so it can save its data to disk and reload it after a restart.
- **Built-in data structures** such as lists, sets and sorted sets, with commands that work on them inside the server.

[Redis internals and Memcached](#redis-internals-and-memcached) compares the two in depth.

## What to cache

Application caches usually hold one of two kinds of thing: the results of **database queries**, or **objects** your code has assembled. Within those, you can cache at four levels:

| Level | What you store | Crumb example |
| --- | --- | --- |
| Row | One row from one table | The `recipes` row for recipe 812 |
| Query | The full result of one query | The 20 rows returned by "top Thai recipes" |
| Object | A complete, serializable object built from several queries | Recipe 812 with its ingredients, photos, ratings and author |
| Rendered HTML | A finished page or page fragment | The HTML for the recipe 812 page |

(A **serializable** object is one you can turn into bytes, for example as JSON, and turn back into the same object later.)

Avoid caching in files on each app server's disk. If one server writes `recipe-812.html` to its own disk, the other servers can't see it, and a new server starts with nothing. That makes [cloning servers](/learn/scalability-101#scaling-out-clones-behind-a-load-balancer) and autoscaling harder. Keep the cache in a shared store such as Redis or Memcached.

### Caching at the database query level

The simplest approach is to cache every query result. Hash the SQL text to make a key, and store the result under it. The next time the same query runs, look up the hash first.

This is easy to add, but hard to keep correct, because you can't easily tell which cached results to delete when data changes:

- **Complex queries are hard to delete.** A query that joins four tables could be affected by a change to any of them.
- **One small change can affect many entries.** If a single recipe's rating changes, every cached query that might include it is now wrong: "top Thai recipes", "top-rated this week", and hundreds more. You can't cheaply find them all, so you either delete too much or leave stale results behind.

### Caching at the object level

The other approach treats your data as objects, the way your application code already does. Your application runs the queries, assembles the results into a class instance or data structure, and caches that whole object. Crumb caches recipe 812 as one object under `recipe:812`.

This has two advantages:

- **When the underlying data changes, you delete one key.** If someone edits or rates recipe 812, Crumb deletes `recipe:812`, and the next request rebuilds it.
- **It allows asynchronous processing.** Background workers can assemble objects ahead of time, and other workers can consume the latest cached object instead of querying the database. [Queues and async](/learn/queues-and-async) covers background workers.

Good candidates for object caching include:

- user sessions,
- fully rendered web pages,
- activity streams, such as "recent recipes from people you follow",
- user graph data, such as who follows whom.

## When to update the cache

A cache holds a limited amount of data, and that data has to stay close to what the database says. So every cache needs answers to two questions: how does data get into the cache, and what happens to the cached copy when the data changes? The common strategies answer those questions differently.

We'll call the code that talks to the cache "the application" and the system of record "the database". (The **system of record** is the store whose copy counts as the truth.)

### Cache-aside

In **cache-aside**, the application does all the work. The cache never talks to the database. To read, the application:

1. looks for the entry in the cache, and gets a miss,
2. loads the entry from the database,
3. adds the entry to the cache,
4. returns the entry.

```python
def get_recipe(recipe_id):
    key = f"recipe:{recipe_id}"
    cached = cache.get(key)                  # trip 1: check the cache
    if cached is not None:
        return json.loads(cached)            # hit: done
    recipe = db.load_recipe(recipe_id)       # trip 2: read the database
    if recipe is not None:
        cache.set(key, json.dumps(recipe), ex=3600)  # trip 3: fill the cache
    return recipe
```

To write, the application updates the database and then deletes the cached copy, so the next read loads the new value. [Keeping the cache consistent with the database](#keeping-the-cache-consistent-with-the-database) explains why deleting is safer than updating.

Memcached is generally used this way. Cache-aside is also called **lazy loading**, because data enters the cache only when someone asks for it. The [AWS ElastiCache caching strategies guide](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Strategies.html) lists its benefits. Only requested data is cached, so the cache doesn't fill up with data nobody reads. Reads after the first miss are fast. And a failed cache node isn't fatal: the application keeps working, more slowly, and refills the new node as requests arrive.

Its disadvantages:

- **Each miss costs three trips:** the cache check, the database query and the cache write. That can add a noticeable delay to the first request.
- **Data can go stale.** If the database changes and nobody deletes the cached copy, for example because another program wrote to the database, readers keep getting the old value. A **time to live (TTL)** limits the damage. It is an expiry time on each entry, after which the next read fetches a fresh copy. Write-through, below, is another fix.
- **A replaced node starts empty.** When a cache node fails, every request to its replacement misses until it warms up, so latency goes up in the meantime.

### Read-through

**Read-through** moves the loading step into the cache itself. The application only ever asks the cache. On a miss, the cache loads the entry from the database, keeps a copy and returns it, as Oracle's [Coherence documentation](https://docs.oracle.com/en/middleware/standalone/coherence/14.1.1.2206/develop-applications/caching-data-sources.html) describes. Reads behave like cache-aside, and a miss costs the same. The difference is where the code lives: one loader inside the caching layer instead of lookup logic repeated across the application. Plain Redis and Memcached don't load from your database on their own, so read-through usually comes from a caching library or a data grid product.

### Write-through

In **write-through**, the application treats the cache as its main data store. It reads from the cache and writes to the cache, and the cache is responsible for reading from and writing to the database. A write goes like this:

1. The application adds or updates the entry in the cache.
2. The cache writes the entry to the database, and waits for the write to finish.
3. The write returns.

```python
# Inside the caching layer. The application just calls save_recipe(812, {...}).
def save_recipe(recipe_id, fields):
    recipe = db.update_recipe(recipe_id, fields)          # synchronous database write
    cache.set(f"recipe:{recipe_id}", json.dumps(recipe))  # cache now matches the database
    return recipe
```

Each write is slower, because it waits for the database. Reads of just-written data are fast, because it's already in the cache. The AWS guide notes that "end users are generally more tolerant of latency when updating data than when retrieving data", so a Crumb user saving a recipe won't mind an extra 15 ms. And the cached data doesn't go stale, as long as every write goes through the cache.

Its disadvantages:

- **A new node starts empty and stays that way.** A node added after a failure or to scale out holds nothing until each entry is written again, so a recipe nobody edits never gets in. Combining write-through with cache-aside fixes this: reads fill in anything missing.
- **Most data written may never be read.** AWS calls this "cache churn". A TTL limits the wasted memory, because unread entries expire.

### Write-behind (write-back)

**Write-behind**, also called **write-back**, makes writes fast by delaying the database write:

1. The application adds or updates the entry in the cache, and the write returns at once.
2. The cache writes the entry to the database later, asynchronously (in the background, without the application waiting for it).

This improves write performance. It can also save database work, because, in the Coherence documentation's words, "multiple changes to the same object within the write-behind interval are 'coalesced' and only written once". If Crumb counts views and recipe 812 gets 5,000 in ten seconds, write-behind turns them into one database write of the final count.

Its disadvantages:

- **Data can be lost.** If the cache goes down before its queued writes reach the database, those writes are gone, even though the application was told they succeeded. Until then the cache is effectively the system of record.
- **It is more complex** than cache-aside or write-through. You need a reliable queue of pending writes, retries, and a plan for writes that arrive out of order. If another program writes the same rows directly, a queued write can later overwrite its newer value.

### Refresh-ahead

**Refresh-ahead** reloads popular entries before they expire. You configure the cache to refresh any recently accessed entry automatically when it gets close to its expiry time, while readers keep getting the current copy.

The Coherence documentation gives an example. Entries expire after 60 seconds, and the refresh-ahead factor is 0.5. A read of an entry between 30 and 60 seconds old returns the cached value at once and schedules a background reload. A read after 60 seconds waits for a normal load.

Refresh-ahead can give lower latency than read-through, because readers of popular entries never wait for a miss. The [Coherence documentation](https://docs.oracle.com/en/middleware/standalone/coherence/14.1.1.2206/develop-applications/caching-data-sources.html) says this holds "only if the cache can accurately predict which cache items are likely to be needed in the future."

Its disadvantage: wrong predictions reload entries nobody will read. That sends extra queries to the database, and performance can end up worse than with no refresh-ahead at all. [XFetch](#fix-2-probabilistic-early-expiration-xfetch), later in this chapter, is a refresh-ahead method that uses probability to decide when to refresh.

### Trying the strategies

The diagram below holds one record, `user:42`, with a cache in front of a database. Pick cache-aside, write-through or write-behind, then read and write it. In write-through mode, reads also go through the cache, as in read-through. The timings are illustrative: 1 ms for the cache, 10 ms for a database read and 15 ms for a database write.

```widget
cache-strategies
```

Some things to try:

- **Cache-aside:** read, then press *Another service writes the database*. Reads stay stale until you press *Entry expires*.
- **Write-behind:** write twice quickly, and the two writes become one database write. Then write again and press *Cache node restarts* before the queued write runs. That write is lost.

| Strategy | Who loads data on a miss | When the database is written | Main risk |
| --- | --- | --- | --- |
| Cache-aside | The application | By the application, before deleting the cached copy | Stale data, slow first read |
| Read-through | The cache | Depends on the write strategy paired with it | Slow first read |
| Write-through | The cache (usually paired with read-through) | By the cache, before the write returns | Slower writes, cache full of unread data |
| Write-behind | The cache | By the cache, later | Lost writes if the cache fails |
| Refresh-ahead | The cache, before expiry | Depends on the write strategy paired with it | Wasted reloads if it guesses wrong |

## When the cache is full

Entries leave a cache in two ways. With **expiry**, an entry's TTL runs out. With **eviction**, the cache is out of memory and removes entries to make room. The **eviction policy** decides which entries go:

- **Least recently used (LRU):** remove the entry that has gone longest without being read.
- **Least frequently used (LFU):** remove the entry that is read least often.
- **Random:** remove any entry.

LRU suits most caches, because a small set of hot keys usually gets most of the reads. At Crumb, this week's popular recipes stay in memory, and recipes nobody has opened for months get evicted.

**Redis.** By default, Redis on a 64-bit system has no memory limit, so it doesn't evict anything. To use it as a cache, you set `maxmemory` and choose a `maxmemory-policy`. The [Redis eviction documentation](https://redis.io/docs/latest/develop/reference/eviction/) lists the options. A few of them:

- `noeviction` keeps every key and returns an error when a command tries to add more data.
- `allkeys-lru` evicts the least recently used keys. The docs call it "a good default option if you have no reason to prefer any others."
- `allkeys-lfu` evicts the least frequently used keys (since Redis 4.0).
- `volatile-lru` and the other `volatile-` policies only evict keys that have a TTL, which suits an instance that also holds data you must keep.

Redis approximates LRU to save memory. It samples a few keys at random (5 by default, set with `maxmemory-samples`) and evicts the one unused for longest. The docs call this "virtually equivalent" to true LRU for applications.

**Memcached.** Memcached divides memory into slab classes by item size, and [each class has "its own LRU"](https://github.com/memcached/memcached/wiki/UserInternals). When a class needs room, Memcached looks at the tail of that LRU for an already expired item, and evicts an unexpired one only if it finds none.

Redis's `INFO stats` reports `keyspace_hits`, `keyspace_misses` and `evicted_keys`. A low hit ratio with many evictions means the cache is too small or the policy is evicting the wrong keys.

## The costs of caching

A cache isn't free. Before adding one, weigh three costs:

- **You have to keep it consistent with the database.** The database is the source of truth. When data changes there, cached copies have to be updated or removed. This is called **cache invalidation**.
- **Invalidation is hard.** Deciding when to update the cache, on every path that changes data, adds real complexity. Stale data, races between writers and lost deletes all come from this.
- **You have to change the application.** You add Redis or Memcached, run and monitor it, and write code that uses it.

A cache also becomes a dependency. If the database copes only because the cache absorbs most reads, a cache failure can take the database down too. [Scalability 101](/learn/scalability-101#caching) tells how this happened to Facebook in 2010.

## Failure modes and how to prevent them

At 50,000 requests a second, small cache problems become large database problems. Three failure modes come up again and again. All of them end with requests the cache was meant to absorb reaching the database faster than it can serve them.

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

A **cache stampede**, also called a **thundering herd**, starts when a very popular key expires or is evicted. Every request before someone puts the value back is a miss, and every miss runs the same query. As an illustration, say recipe 812's key gets 10,000 reads a second and takes 200 ms to rebuild:

- While the key is missing, 10,000 × 0.2 s = **2,000 requests** miss it.
- Each of them runs the same expensive query.
- The database's connection pool fills up and queries queue. The rebuild now takes longer than 200 ms, so the key stays missing longer and even more requests miss. Without a fix, this feeds on itself.

#### Fix 1: a lock, so only one request rebuilds

On a miss, a request first tries to take a short-lived lock for that key. In Redis that is one command: `SET lock:<key> <random-token> NX PX 5000`. It succeeds only if the lock doesn't exist yet, and the lock expires after 5 seconds in case its holder dies.

- **The request that gets the lock** queries the database, writes the value into the cache and releases the lock. It releases it with a small Lua script that deletes the lock only if it still holds that request's token, so it never deletes a lock that another request has since taken.
- **Every other request** waits briefly, say 50 ms, and reads the cache again, or serves a slightly stale copy if you keep one.

Each miss now costs a lock round trip, but the database sees one query instead of 2,000. Facebook's memcache paper describes a similar idea called **leases**: the cache gives a token to the first client that misses and tells the others to retry shortly.

#### Fix 2: probabilistic early expiration (XFetch)

The 2015 paper *Optimal Probabilistic Cache Stampede Prevention*, by Andrea Vattani, Flavio Chierichetti and Keegan Lowenstein, describes an algorithm called **XFetch**. Each reader decides at random whether to refresh the key early. The chance of refreshing rises as the expiry time gets closer.

Store two extra values with each entry: `delta`, how long the last rebuild took, and `expiry`, when the entry expires. On every read:

```text
if now − delta × beta × ln(rand()) ≥ expiry:
    recompute the value, store it with a new expiry and a new delta
else:
    return the cached value
```

`rand()` is a uniform random number in (0, 1], so `−delta × beta × ln(rand())` is a positive, random "head start" that averages `delta × beta`. In words: refresh early if the head start is larger than the time left before expiry. `beta` defaults to 1, and larger values refresh earlier.

Far from expiry, the head start almost never covers the time left, so nobody refreshes. In the last few multiples of `delta`, the chance climbs quickly, and with many readers one of them very likely refreshes before the key expires. Scaling by `delta` means a value that takes 2 seconds to rebuild starts refreshing much earlier than one that takes 20 ms.

XFetch needs no locks. It doesn't guarantee a single refresh, since two readers can win the draw at nearly the same moment. The paper shows that this exponential rule is the best balance between refreshing too early, which wastes work, and too late, which allows a stampede. Teams often add a lock as a backstop.

#### Fix 3: refresh in the background

For a handful of known hot keys, don't let them expire. A background job rebuilds them on a schedule, so readers never miss. This is refresh-ahead run by your own code. It works for a small, known set of keys and doesn't scale to millions.

### Cache avalanche

A **cache avalanche** is the same problem across many keys: a large share of the key space misses at once. It has two common causes:

- **Keys that expire together.** A batch job warms the cache at 02:00 and gives every key a TTL of exactly one hour. At 03:00 they all expire within the same second.
- **A cache node restarting empty.** If a Redis node holding a third of the keys comes back with no data, every request for those keys misses until they are rebuilt.

#### Fix: add jitter to TTLs

Add a random amount, called **jitter**, to each key's TTL:

```python
import random

def cache_set_with_jitter(redis, key, value, base_ttl=3600, jitter_pct=0.15):
    # ±15% of one hour: somewhere between 3,060 and 4,140 seconds
    spread = base_ttl * jitter_pct
    ttl = base_ttl + random.uniform(-spread, spread)
    redis.set(key, value, ex=int(ttl))
```

The keys now expire over about 18 minutes, and the database sees a steady trickle of rebuilds.

Jitter doesn't help with a restart. For that, use replicas that keep their data ([Sentinel and Cluster](#redis-sentinel-vs-redis-cluster) below), warm a new node before it takes traffic, and put a [circuit breaker or load shedding](/learn/reliability-patterns#circuit-breakers-bulkheads-and-load-shedding) in front of the database to turn away a burst of misses.

### Cache penetration

**Cache penetration** happens when clients ask for keys that don't exist in the database, such as `GET /users/-9999` or a scanner trying random IDs. With plain cache-aside, each request misses, finds no row in the database, and caches nothing, so the next request for the same ID does the same. A client sending 20,000 made-up IDs a second sends 20,000 queries a second straight to the database.

#### Fix 1: cache the "not found"

When the database returns nothing, cache a marker such as `redis.set("user:-9999", "__none__", ex=60)`. For the next 60 seconds, requests for that ID get a 404 from the cache. Keep the TTL short, because the ID might be created later. This helps when the same missing IDs are requested again and again. It does little against random IDs, and it fills the cache with markers.

#### Fix 2: a Bloom filter in front of the cache

A **Bloom filter** is a compact data structure that answers "is this key in the set?" with either "definitely not" or "probably yes". It is an array of m bits and k hash functions. To add a key, hash it k times and set those k bits to 1. To check a key, hash it k times. If any of those bits is 0, the key was never added. If all are 1, it was probably added, though other keys might have set those bits (a **false positive**). About 9.6 bits per key gives a 1% false positive rate, so 100 million keys fit in roughly 120 MB.

To use it against penetration, add every ID to the filter when its row is created, and check the filter before the cache. On "definitely not", return 404 without touching the cache or the database. On "probably yes", carry on as usual. About 1% of requests for missing IDs still get through, which is fine.

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

There are two caveats. A plain Bloom filter can't remove keys, so deleted IDs stay "probably yes" until you rebuild it (counting Bloom filters and cuckoo filters support deletes). And the filter must learn about a new ID in the same code path that creates the row, or a new user can briefly get a 404.

## Local and distributed caches

So far, "the cache" has meant a shared server such as Redis. A cache can also live inside each application process. Large systems often use both.

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

| | Local, in-process (Caffeine, Guava, a plain LRU map) | Distributed (Redis, Memcached) |
|---|---|---|
| Where it lives | In the application's own memory | On separate servers, reached over the network |
| Read latency | Well under a microsecond: a hash lookup in memory | Typically a few hundred microseconds to about a millisecond, mostly network round trip |
| Throughput | Limited by the app's CPU, often millions of lookups a second | Roughly 100,000 or more simple operations a second per Redis node |
| Consistency | Each server has its own copy, and copies can disagree | One copy per key, shared by every app server |
| Size | Limited by the process's memory, usually a few GB | Can grow to terabytes by adding nodes |
| Survives a deploy | No, it's empty after a restart | Yes |

Using both is called a **two-tier cache**. Each app server keeps a small local cache (L1) with a TTL of a few seconds, which limits how stale it can get. On an L1 miss, it reads the shared cache (L2). When an entity changes, a message on Redis pub/sub or Kafka tells every app server to drop its L1 copy, and the short TTL covers any lost message. The L1 takes the hottest keys off the network, which also stops one hot key from overloading a single Redis node. [Consistent hashing](/learn/consistent-hashing#hot-keys) covers other ways to handle hot keys.

## Redis internals and Memcached

A single Redis process commonly handles more than 100,000 simple operations a second. Keeping data in RAM is part of the reason. Two design choices explain the rest.

### A single thread for commands

Redis runs every command on **one thread**.

- There are no locks and no contention between threads. Each command runs to completion before the next starts, so every single command is atomic. Two clients running `INCR` at once can't lose an update.
- One thread serves thousands of connections using I/O multiplexing (**epoll** on Linux, **kqueue** on macOS and BSD): the kernel reports which sockets have data, and Redis handles each in turn.
- Since Redis 6.0, socket reads and writes can use extra I/O threads, but commands still run on the main thread.

The cost is that one slow command blocks everyone. `KEYS *` on a large database, or deleting a set with millions of members, stalls every client. Use `SCAN` instead of `KEYS`, and `UNLINK`, which frees memory in the background, instead of `DEL`.

### Data structures built for memory

Redis stores typed values, and it picks a compact encoding when a value is small:

- **Strings** are binary-safe and store their length, so `STRLEN` is O(1).
- **Hashes, lists and small sorted sets** are stored as a compact **listpack** (one contiguous block of memory) while small, and switch to a real hash table, list or skip list past a configurable size (128 entries by default for hashes).
- **Sets of integers** are stored as a sorted integer array (an intset) up to 512 members by default.
- **Sorted sets** use a **skip list** plus a hash table, giving O(log N) inserts, rank lookups and range queries. That makes Redis popular for [leaderboards](/learn/design-gaming-leaderboard).
- **HyperLogLog** estimates how many distinct items a set has in at most 12 KB, with a standard error of 0.81%.
- **Bitmaps** store one bit per user ID, for things like daily active user flags.

### Redis vs Memcached

| | Redis | Memcached |
|---|---|---|
| Values | Strings, hashes, lists, sets, sorted sets, streams and more, with server-side operations on them | Opaque byte strings |
| Threads | One thread runs commands (I/O can use more) | Multi-threaded, so one process uses all cores |
| Persistence | Optional snapshots (RDB) and append-only log (AOF) | None, memory only |
| Replication and failover | Built in, plus Sentinel and Cluster | None. Clients spread keys across servers with [consistent hashing](/learn/consistent-hashing) |
| Eviction | Configurable policy (LRU, LFU, random, TTL-based, or none) | LRU within each slab class |
| Typical use | Cache plus counters, queues, rate limits, leaderboards, locks | A large, simple, fast key-value cache |

If all you need is a big cache of serialized objects, Memcached is simple and scales well on machines with many cores. Most teams choose Redis, because its data structures, replication and persistence let one system do several jobs.

## Redis Sentinel vs Redis Cluster

Redis offers two ways to run more than one node, and they solve different problems. Sentinel keeps one dataset available when a server fails. Cluster splits the dataset across several servers.

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

- You run one primary and one or more replicas, each holding the full dataset.
- At least three Sentinel processes, on separate machines, check them with heartbeats.
- When enough Sentinels to reach the configured quorum agree that the primary is down, they elect a leader, which promotes a replica and tells clients where the new primary is.
- Sentinel gives you **high availability**. It doesn't add write capacity: every write still goes to one primary, and the dataset must fit on one machine.
- Replication is asynchronous, so writes the old primary acknowledged just before it failed can be lost in a failover.

### Redis Cluster

Redis Cluster splits the key space across several primaries, each with its own replicas.

- The key space is divided into **16,384 hash slots**. Each key belongs to one slot:

  ```text
  slot = CRC16(key) mod 16384
  ```

- Each primary owns a set of slots. With three primaries, a default setup gives node A slots 0–5,460, node B slots 5,461–10,922 and node C slots 10,923–16,383.
- To move data between nodes, you move slots. Adding a node means handing it some slots from the others, and keys never need to be rehashed.
- **Hash tags** keep related keys together. If a key contains `{...}`, only the part inside the braces is hashed. `{user:100}:profile` and `{user:100}:orders` both hash `user:100`, so they land in the same slot. This matters because multi-key commands (`MGET`, `MULTI`/`EXEC` transactions, Lua scripts) only work when all their keys are in one slot. Otherwise Redis returns a `CROSSSLOT` error.
- **Clients route requests themselves.** A cluster-aware client keeps a copy of the slot-to-node map and sends each command straight to the right node. If a slot has moved, the node replies with a redirect such as `-MOVED 3999 10.0.0.2:6379`, and the client updates its map and retries. During a slot migration, a node can answer `-ASK`, which redirects just that one request.

Why 16,384 slots? The Redis author's explanation is about message size. Nodes gossip a bitmap of the slots they own, and 16,384 bits is 2 KB. That keeps heartbeats small while allowing far more slots than the recommended maximum of about 1,000 nodes.

## Keeping the cache consistent with the database

When data changes, two questions come up. Should you update the cached copy or delete it? And should you change the database first or the cache first? The wrong answers leave a stale value in the cache that nothing corrects until its TTL runs out.

### Why "update the database, then update the cache" goes wrong

Two writers change the same user at nearly the same time:

1. Writer A sets the name to "Ann" in the database.
2. Writer B sets the name to "Bea" in the database. The database now says "Bea".
3. Writer B writes "Bea" into the cache.
4. Writer A, delayed by a slow network or a garbage collection pause, writes "Ann" into the cache.

The database says "Bea" and the cache says "Ann". Every reader sees "Ann" until the TTL expires. The two writes reached the two systems in different orders, and nothing ties them together. A homemade write-through layer that runs several writers in parallel has the same problem, because it makes the same two separate writes.

### Cache-aside with delete after commit

The usual fix is the write rule from [cache-aside](#cache-aside): update the database, and after the transaction **commits**, delete the key instead of updating it. Deletes have no ordering problem between writers. Two deletes in either order leave the same result, no entry, and the next read loads whatever the database holds at that moment.

```diagram
title: Cache-aside: reads fill the cache, writes delete from it
[app] App server @ 0,0.5
[db:store] Database @ 2.2,0
[cache:store] Cache @ 2.2,1
app -> db : 1. write, commit
app -> cache : 2. DEL key
```

### Why not delete the cache first?

Deleting before the database write leaves a wide window for a race:

1. Writer A deletes `user:1` from the cache, then starts a database transaction to change "Alice" to "Bob".
2. Before A commits, reader B gets a miss on `user:1`.
3. B reads the database and gets the old value, "Alice", because A hasn't committed.
4. B writes "Alice" into the cache.
5. A commits "Bob".

The database says "Bob", the cache says "Alice", and nothing fixes it before the TTL. The window lasts as long as A's whole transaction, so this happens regularly under load.

Delete-after-commit still has a race, but a much narrower one. A reader misses, reads the old value from the database, and stalls. Meanwhile a writer commits and deletes the key. Then the reader wakes up and writes the old value into the cache. The reader had to be slower than the entire write, so this is rare, but it does happen at scale. Common defenses:

- **Always set a TTL**, so a stale value can only last so long.
- **Delayed double delete:** delete the key again a second or so after the write, to catch a late stale fill.
- **Leases or versioned writes:** let the cache reject a fill that started before the most recent delete. Facebook's memcache leases do this.

### Invalidation with change data capture

Delete-after-commit has one more gap. If the app server crashes or loses its connection to Redis between the commit and the `DEL`, the key is never deleted, and a crash loses any retry too.

**Change data capture (CDC)** moves invalidation out of the application. The database already records every committed change in its log (the write-ahead log, or WAL, in PostgreSQL; the binlog in MySQL). A CDC tool reads that log and turns each change into an event.

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

1. The application runs ordinary SQL transactions, with no cache invalidation code.
2. **Debezium**, usually running as a Kafka Connect connector, reads the log through the database's replication interface (logical decoding in PostgreSQL, the binlog in MySQL). It emits events only for committed transactions, so a rolled-back write never causes an invalidation.
3. Each change becomes an event on a **Kafka** topic, one topic per table, named like `<prefix>.<schema>.<table>`. The event carries the row's key and its values before and after the change.
4. An invalidation worker reads the topic and runs `DEL user:42` in Redis.

What you get:

- **No coupling in the write path.** A Redis outage can't fail or slow down a database transaction.
- **No lost invalidations.** The worker commits its Kafka offset only after the `DEL` succeeds. After a crash it replays from the last committed offset. Deleting a key twice is harmless, so the duplicates don't matter.
- **Every writer is covered,** including batch jobs, admin scripts and other services that know nothing about the cache.

What it costs: Kafka, Kafka Connect and Debezium all need running and monitoring. Invalidation also lags the commit by the pipeline's delay, usually milliseconds to a second or two, and readers can see the old value in that time. So CDC gives eventual consistency. It doesn't close the stale-fill race above either, so keep TTLs. [Event streaming](/learn/event-streaming) covers Kafka in more depth.

## Check yourself

<details>
<summary>Crumb caches the results of "top Thai recipes" by hashing the SQL. Then one recipe's rating changes. What goes wrong, and how does caching objects avoid it?</summary>

The changed rating might affect "top Thai recipes", "top-rated this week" and many other cached queries. Crumb has no cheap way to find them all, so it either deletes far too much or leaves stale results behind. With object caching, the recipe lives under one key, `recipe:812`, and Crumb deletes that one key when the rating changes.

</details>

<details>
<summary>A cache node fails and is replaced by an empty one. How does a cache-aside system recover, and how does a write-through system recover?</summary>

With cache-aside, requests to the new node miss, load from the database and fill the cache, so the node warms up by itself while latency is higher. With pure write-through, entries only enter the cache when written, so a recipe nobody edits never reaches the new node. The usual fix is to combine them: writes go through the cache, and reads fill in anything missing.

</details>

<details>
<summary>Crumb wants to count recipe views. Why might write-behind suit this, and what does Crumb risk by using it?</summary>

Popular recipes get thousands of views a second. Write-behind lets each increment return as soon as the cache has it, and it combines many updates to the same counter into one database write. The risk is data loss: if the cache fails before its queued writes reach the database, those increments are gone. For a view counter, losing a few seconds of counts is usually acceptable. For a payment, it isn't.

</details>

<details>
<summary>How does refresh-ahead lower latency compared with read-through, and when can it make things worse?</summary>

With read-through, the first read after an entry expires waits for the database. Refresh-ahead reloads a recently read entry in the background before it expires, so readers of popular entries never wait. It only helps if the cache predicts correctly which entries will be read again. If it reloads entries nobody reads, it sends extra queries to the database, and performance can end up worse than with no refresh-ahead.

</details>

<details>
<summary>How does XFetch avoid a stampede without any locks, and why is the early-refresh window scaled by how long the value takes to compute?</summary>

Each reader draws a random head start that averages `delta × beta`, where `delta` is how long the last rebuild took. If the head start reaches past the expiry time, that reader refreshes early. Far from expiry the chance is close to zero, and in the last few multiples of `delta` it rises quickly. A hot key has many readers drawing every second, so one of them very likely refreshes before expiry and the rest never miss.

Scaling by `delta` matters because the refresh has to finish before the key expires. A value that takes 2 seconds to build must start refreshing seconds ahead. One that takes 20 ms needs only a few tens of milliseconds.

</details>

<details>
<summary>A batch job warms 5 million keys at 02:00 with a TTL of exactly one hour. What happens at 03:00, and what one-line change fixes it?</summary>

At 03:00 all 5 million keys expire within about a second, and the database gets the whole read load the cache was absorbing: a cache avalanche. The fix is jitter. Set each TTL to the base value plus a random offset, such as 3,600 s ± 15%, so the expirations spread over about 18 minutes.

</details>

<details>
<summary>Why is "delete the cache, then update the database" worse than "update the database, then delete the cache"?</summary>

If you delete first, any reader that arrives while the write transaction is open misses, reads the old committed value, and puts it back in the cache. After the commit, the cache holds the old value until the TTL. The window is the whole transaction, so this happens often.

If you delete after the commit, the only race needs a reader that read the old value before the commit and wrote it to the cache after the delete. That reader was slower than the entire write, which is much rarer. TTLs, a delayed second delete, or leases handle the rest.

</details>

<details>
<summary>How does Redis Cluster decide which node holds a key, and how do you make sure `user:42`'s profile and orders can be read in one `MGET`?</summary>

Redis Cluster computes `CRC16(key) mod 16384` to get one of 16,384 hash slots, and each primary owns a set of slots. `user:42:profile` and `user:42:orders` probably hash to slots on different nodes, so an `MGET` across them fails with a `CROSSSLOT` error. Name them `{user:42}:profile` and `{user:42}:orders` instead. Only the text inside the braces is hashed, so both land in the same slot.

</details>

<details>
<summary>Your service caches users, but a nightly batch job and a second service also write to the users table. Why is CDC a better fit here than delete-after-commit in your code?</summary>

Delete-after-commit only covers writes that go through your code. The batch job and the other service never trigger a delete, so the cache serves stale users until their TTLs expire. CDC reads the database's own log, so every committed change produces an invalidation, whoever made it. It also survives crashes, because the worker resumes from its last Kafka offset and repeating a `DEL` is harmless. The cost is running the pipeline and a short lag before each invalidation.

</details>

## Further reading

- [Scalable System Design Patterns](http://horicky.blogspot.com/2010/10/scalable-system-design-patterns.html) (Ricky Ho, 2010): a short catalog of eight patterns, including the result cache, each with a diagram.
- [Introduction to Architecting Systems for Scale](https://lethain.com/introduction-to-architecting-systems-for-scale/) (Will Larson, 2011): a readable overview of application caching, database caching, in-memory caches, CDNs and cache invalidation.
- [Scalability for Dummies, part 3: Cache](https://web.archive.org/web/20230126233752/https://www.lecloud.net/post/9246290032/scalability-for-dummies-part-3-cache) (Sebastian Kreutzberger, 2011, archived): the short case for caching objects instead of query results.
- [Caching strategies for Memcached](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Strategies.html) (AWS ElastiCache guide): lazy loading, write-through and TTLs, with the advantages and disadvantages of each and pseudocode.
- [Caching Data Sources](https://docs.oracle.com/en/middleware/standalone/coherence/14.1.1.2206/develop-applications/caching-data-sources.html) (Oracle Coherence documentation): precise definitions of read-through, write-through, write-behind and refresh-ahead, including write coalescing and the refresh-ahead factor.
- [From Cache to In-Memory Data Grid](https://www.slideshare.net/tmatyashovsky/from-cache-to-in-memory-data-grid-introduction-to-hazelcast) (Taras Matyashovsky): slides covering eviction policies, the cache access patterns, and local, replicated, distributed and near caches, with Hazelcast as the example.
- [Scalability, Availability & Stability Patterns](https://www.slideshare.net/jboner/scalability-availability-stability-patterns/) (Jonas Bonér, 2010): a long slide deck whose caching section covers HTTP caching, write-through and write-behind, and eviction policies. Best used as a checklist.
- [Key eviction](https://redis.io/docs/latest/develop/reference/eviction/) (Redis documentation): every `maxmemory-policy`, how to pick one, and how Redis approximates LRU and LFU.
- [Cache (computing)](https://en.wikipedia.org/wiki/Cache_(computing)) (Wikipedia): background on caches in hardware and software, and on write policies.
- [Optimal Probabilistic Cache Stampede Prevention](https://www.vldb.org/pvldb/vol8/p886-vattani.pdf) (Vattani, Chierichetti and Lowenstein, VLDB 2015): the XFetch algorithm and why the exponential rule is the right one.
- [Scaling Memcache at Facebook](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala) (Nishtala et al., NSDI 2013): leases against stampedes and stale sets, and invalidation across regions.
- [Redis cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/): hash slots, hash tags, gossip, and `MOVED` and `ASK` redirects.
- [Debezium architecture](https://debezium.io/documentation/reference/stable/architecture.html): how Debezium reads database logs and publishes change events through Kafka Connect.
- [Space/Time Trade-offs in Hash Coding with Allowable Errors](https://dl.acm.org/doi/10.1145/362686.362692) (Burton H. Bloom, 1970): the paper that introduced Bloom filters.
