# Design a URL shortener (like TinyURL or Bitly)

A URL shortener takes a long web address, such as `https://en.wikipedia.org/wiki/Representational_state_transfer#Architectural_constraints`, and gives back a short alias such as `https://tiny.cc/r7k2x9`. When someone opens the short link, the service redirects them to the original address.

It's a classic interview question because the product is simple and the design still makes you decide real things: how to generate short codes that never collide, which HTTP redirect status to send, how to shard a table with billions of rows, how big the cache needs to be, and how to count clicks without slowing down redirects.

It builds on the primer's [database](/learn/database), [cache](/learn/cache) and [asynchronism](/learn/asynchronism) chapters, and on the extra chapters on [unique IDs](/learn/unique-ids) and [rate limiting](/learn/rate-limiting).

## Requirements and estimates

### Functional requirements

1. **Shorten:** given a valid long URL, return a unique short link.
2. **Redirect:** opening the short link sends the browser to the original URL.
3. **Custom alias (optional):** a user can ask for a specific code, such as `https://tiny.cc/my-portfolio`.
4. **Expiry (optional):** a link can have an expiry time. After it, the link returns `404 Not Found` or `410 Gone`.
5. **Stats:** the link's owner can see how many times it was clicked.

### Non-functional requirements

1. **Fast redirects.** A redirect should spend only a few milliseconds inside our system; aim for under 20 ms at the 99th percentile, measured at the server. The user is waiting to get somewhere else.
2. **High availability.** Short links get printed, emailed and posted everywhere. If the redirect service is down, all of them break at once, so redirects matter more than link creation.
3. **Read-heavy.** Links are created once and opened many times. Assume 100 redirects for every new link.
4. **Short codes.** Codes should be as short as practical, and not guessable in sequence.

### Out of scope

Click-fraud detection, marketing campaign tools, billing tiers and link categorization.

### Capacity estimates

These are assumptions for a popular public service, not figures from any real one:

- **Writes:** 100 million new links a month. 100,000,000 ÷ (30 × 86,400 s) ≈ **39 writes a second** on average, or about **120 a second** at a 3× peak.
- **Reads:** at 100:1, that's 10 billion redirects a month. 10,000,000,000 ÷ (30 × 86,400 s) ≈ **3,860 redirects a second** on average, or about **11,600 a second** at a 3× peak.
- **Records:** 100M a month × 12 × 5 years = **6 billion links** over five years.
- **Record size:** an 8-byte ID, a code of up to 8 bytes, a long URL averaging about 100 bytes, two 8-byte timestamps and an owner ID come to roughly 150 bytes of data. Indexes, row headers and free space in pages add a lot on top, so budget **500 bytes per link**.
- **Storage:** 6 billion × 500 bytes = **3 TB** over five years, before replication. That's not much disk. The challenge is serving the read rate with low latency, which is a job for a cache.
- **Cache:** 10 billion ÷ 30 ≈ 333 million redirects a day. Clicks on links are very uneven: a small share of links gets most of the traffic. A common rule of thumb is to cache enough for 20% of a day's requests. Even in the worst case, where every one of the 333 million requests is for a different link, 20% of that is 67 million entries × 500 bytes ≈ **33 GB**. That fits in memory on one large cache server; in practice you run a small replicated cluster for availability.

See [estimation](/learn/estimation) for more on this kind of arithmetic.

## API design and HTTP redirects

### REST API

Creating a link:

```http
POST /api/v1/urls
Content-Type: application/json

{
  "long_url": "https://example.com/very/long/article?id=49281",
  "custom_alias": "cool-article",
  "expires_at": 1735689600
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "short_code": "cool-article",
  "short_url": "https://tiny.cc/cool-article",
  "created_at": 1704067200
}
```

`custom_alias` and `expires_at` are optional. `expires_at` is a Unix timestamp in seconds.

Following a link:

```http
GET /cool-article HTTP/1.1
Host: tiny.cc
```

```http
HTTP/1.1 302 Found
Location: https://example.com/very/long/article?id=49281
```

Reading stats:

```http
GET /api/v1/urls/cool-article/stats HTTP/1.1
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "short_code": "cool-article",
  "clicks": 14205,
  "created_at": 1704067200
}
```

### 301 vs 302 (and 307, 308)

The status code you redirect with decides whether browsers come back to you on the next click.

| | 301 Moved Permanently | 302 Found / 307 Temporary Redirect |
|---|---|---|
| Browser caching | Browsers may cache it, and without a `Cache-Control` header they often keep it for a long time. Later clicks can go straight to the target. | Not cached unless you add caching headers. Every click comes back to the shortener. |
| Load on your servers | Lower: repeat visits from the same browser skip you. | Higher: every click is a request. |
| Click counts | Undercounted: cached repeat visits are invisible. | Accurate: every click can be logged. |
| Changing or disabling a link | Slow: browsers that cached the redirect keep using it. | Immediate. |

307 and 308 are the strict versions of 302 and 301: they require the browser to repeat the request with the same method and body. For links people click, which are always `GET`, 302 and 307 behave the same, and so do 301 and 308.

A reasonable answer: use **302** if the product sells click analytics or needs to disable bad links quickly, which is the case for most commercial shorteners. Use **301** if you mainly want to reduce load and don't need per-click data. With a 301 you can still send `Cache-Control: max-age=…` to limit how long browsers keep it.

## Generating the short code

Short codes use the characters `0-9`, `a-z` and `A-Z`: 62 symbols, so this is called **Base62**. How long do codes need to be?

- 6 characters: 62⁶ ≈ 56.8 billion codes.
- 7 characters: 62⁷ ≈ 3.52 trillion codes.

We expect 6 billion links in five years. Six characters would technically be enough, but seven gives about **590 times** the needed space. That headroom matters because it also makes codes hard to guess: a random 7-character code hits an existing link only about once in 590 tries.

There are two main ways to produce a code.

### Approach A: hash the long URL

1. Hash the long URL, for example with MD5: `MD5("https://example.com") = c984d06aafbecf6bc55569f964148ea3`.
2. Turn the first bits of the hash into a number, take it modulo 62⁷, and Base62-encode it to get 7 characters. Don't just take the first 7 hex characters: hex has only 16 symbols, so 7 of them give 16⁷ ≈ 268 million codes, far too few.
3. Insert the code with a unique constraint. Because you've thrown away most of the hash, two different URLs will sometimes get the same code. The [birthday problem](https://en.wikipedia.org/wiki/Birthday_problem) says this starts happening long before the space is full: with 3.52 trillion codes, there's a 50% chance of at least one collision after only about 2.2 million links.
4. On a collision, the insert fails. Append a counter or salt to the URL, hash again, and retry until the insert succeeds.

The upside is that the same long URL always maps to the same code, so you can deduplicate if you want to. The downside is that every create is a check-and-retry against the database, and the retries grow as the table fills.

### Approach B: unique counter plus Base62

Split the problem in two: first produce an integer that's guaranteed to be unique, then write that integer in Base62.

```python
CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

def id_to_base62(num: int) -> str:
    if num == 0:
        return CHARS[0]
    result = []
    while num > 0:
        result.append(CHARS[num % 62])
        num //= 62
    return "".join(reversed(result))
```

With this alphabet, ID 11,157,117,118 encodes to `cb47PU` and ID 100,000,000,000 to `1L9zO9O`. Different integers always produce different strings, and you can decode a string back to its integer, so there are **no collisions to check for**.

The integers should come from a counter, not from a Snowflake-style 64-bit ID. A Snowflake ID packs a timestamp into the high bits, so the numbers are huge from day one and encode to 11 characters. A counter starting at 1 stays within 7 characters until it passes 62⁷ − 1, about 3.52 trillion.

Custom aliases share the same namespace, so a user could claim a code the counter will produce later. Either check generated codes against the unique constraint too, or keep the two apart, for example by requiring custom aliases to be at least 8 characters or to contain a `-`.

#### Generating unique integers across servers

A single database sequence would work at 120 writes a second, but it's a single point of failure. Two common ways to spread the work:

1. **Range allocation.** A small coordinator (a ZooKeeper node, a row in a strongly consistent database, or a Redis key with persistence) holds the next free range. Each API server claims a block, say 1,000,000 IDs, and hands them out from memory. When the block runs out, it claims another. If a server crashes, the unused part of its block is lost, but no ID is ever issued twice.
2. **Key generation service (KGS).** A separate service generates random 7-character codes ahead of time, filters out offensive words, and stores them as unused. API servers fetch batches of codes and use them directly. This spends extra storage on unused keys, and the KGS must make sure no two servers get the same batch, but it gives random-looking codes with no math at request time.

The [unique IDs](/learn/unique-ids) chapter compares these and other schemes in more detail.

## High-level architecture

```diagram
title: URL shortener components
[client:client] Browser @ 0,0
[lb] Load balancer @ 1,0
[app] API servers @ 2,0
[cache:store] Redis cache @ 3,0
[db:store] URL database\n(sharded) @ 3,1
[ids] ID range\nallocator @ 0,1
[q:queue] Click events\n(Kafka) @ 1.5,1.5
[worker] Analytics\nworkers @ 1.5,2.5
[olap:store] ClickHouse\n(click stats) @ 3,2.5
client -> lb : GET /code, POST /urls
lb -> app
app -> cache : 1. lookup
app -> db : 2. on miss
app -> ids : claim range
app --> q : 3. click event
q --> worker
worker -> olap : aggregate
```

An [interactive version of this diagram](/diagrams/url-shortener.html) lets you pan, zoom and trace the request paths.

### Redirect path

1. The browser requests `GET /r7k2x9`.
2. The load balancer sends it to any API server. The servers are stateless.
3. The server looks up `r7k2x9` in Redis.
4. **Cache hit:** it returns `302 Found` with `Location: <long_url>`. Inside the data center this takes a millisecond or two.
5. **Cache miss:** it reads the URL database. If the row exists and hasn't expired, it writes it into Redis and returns the redirect. Otherwise it returns `404` (or `410` for an expired link). It's worth caching "not found" briefly too, so a burst of requests for a bad code doesn't hit the database each time.
6. **Click event:** the server publishes `{short_code, timestamp, ip, user_agent, referrer}` to a Kafka topic without waiting for analytics to process it. The redirect never blocks on analytics.

### Create path

1. The client sends `POST /api/v1/urls`.
2. The server validates the URL and checks it against the abuse rules below.
3. **Custom alias:** it inserts the row; the unique constraint on `short_code` rejects a taken alias, and the server returns `409 Conflict`.
4. **Generated code:** it takes the next ID from its in-memory range, encodes it, and inserts the row.
5. Optionally it writes the new mapping into Redis. New links are often clicked right after they're shared.
6. It returns `201 Created` with the short URL.

## Data storage and sharding

### Schema

```sql
CREATE TABLE urls (
    short_code  VARCHAR(16)   NOT NULL PRIMARY KEY,
    id          BIGINT        UNIQUE,
    long_url    VARCHAR(2048) NOT NULL,
    user_id     BIGINT,
    created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at  TIMESTAMP     NULL,
    INDEX idx_user (user_id),
    INDEX idx_expires (expires_at)
);
```

The redirect path only ever looks up by `short_code`, so that's the primary key. `id` is null for custom aliases. `idx_user` serves "list my links", and `idx_expires` serves the cleanup job.

There are no joins and no multi-row transactions on the hot path, so a key-value or wide-column store (DynamoDB, Cassandra) works as well as a relational one. Pick whichever your team runs well.

### Sharding

3 TB fits on one machine's disks, but splitting the table across shards spreads the cache-miss reads and writes, keeps each shard's indexes small enough to stay in memory, and limits what a single failure takes out.

- **By user ID: a poor fit.** One account that creates millions of links makes a hot shard, and a redirect only knows the code, not the user, so it would have to ask every shard.
- **By hash of the short code: the usual choice.** `shard = hash(short_code) mod N`. Every redirect knows the code, so it goes straight to one shard, and hashing spreads codes evenly. Use [consistent hashing](/learn/consistent-hashing) or a fixed number of logical shards mapped to machines, so adding a machine moves only a fraction of the data.

Each shard has replicas. Reads that miss the cache can go to replicas; a link created a moment ago might not be on a replica yet, so fall back to the primary on a miss for very new codes.

## Caching and expiry

### Cache-aside with LRU eviction

- The API server checks Redis first. On a miss it reads the database and writes the result to Redis. This is **cache-aside**; the [cache](/learn/cache) chapter covers it and the other strategies.
- Set Redis to evict with an **LRU** policy (`allkeys-lru`) when memory is full. Links nobody clicks fall out; popular ones stay.
- Give entries a TTL too, so a disabled or edited link stops being served from cache within a bounded time even if nobody explicitly deletes it.
- A link that goes viral can make one Redis key very hot. An in-process cache of a few thousand of the hottest codes on each API server takes that load off Redis.

### Removing expired links

1. **Check on read.** When a link is looked up, compare `expires_at` with the current time. If it has passed, return `410 Gone` and remove it from the cache. This alone is enough for correctness.
2. **Background cleanup.** A periodic job deletes expired rows to reclaim space. It uses the `expires_at` index and deletes in small batches, such as `DELETE FROM urls WHERE expires_at < NOW() LIMIT 5000`, repeated with short pauses. Big deletes hold locks for a long time and cause replication lag.

Decide whether an expired code can ever be reused. Reusing it means an old printed link silently points somewhere new, which is usually a bad surprise. With 3.5 trillion codes available, it's simplest never to reuse them.

## Security, rate limiting, and malicious links

1. **Phishing and malware.** Spammers use shorteners to hide where a link goes. When a link is created, check the destination against Google Safe Browsing and similar threat feeds, either before activating it or right after with a quick takedown path. Re-scan popular links periodically, because a harmless page can turn malicious later. This is another reason to prefer 302: you can disable a bad link and every browser sees the change.
2. **Enumeration.** If codes come from a plain counter, `r7k2x9` is followed by `r7k2xa`, and anyone can crawl every link in order, including ones their owners thought were private. Pass the counter through a reversible scrambling function before encoding it, such as a small Feistel network over the range 0 to 62⁷ − 1. Each input still maps to a distinct output in the same range, so codes stay unique and 7 characters long, but consecutive IDs come out looking random. Combined with a mostly empty code space, guessing becomes expensive. Links that must stay private still need access control, not just an obscure code.
3. **Abuse of the create API.** Apply per-IP and per-account [rate limits](/learn/rate-limiting), for example a token bucket at the API gateway, so one client can't create millions of links.

## Check yourself

<details>
<summary>Why is encoding a unique counter in Base62 usually preferred over truncating an MD5 hash of the URL?</summary>

Truncating the hash throws away most of its bits, so different URLs collide, and the birthday problem means it starts early: with 62⁷ possible codes, a collision is more likely than not after only a couple of million links. Each create then needs an insert that might fail and a retry loop, and retries get more frequent as the table grows.

Encoding a unique counter can't collide, because different integers always have different Base62 strings. The create is a single insert with no retry loop. The cost is that you need a way to hand out unique integers across servers, such as range allocation, and you lose the property that the same URL always gets the same code.

</details>

<details>
<summary>Why shouldn't the redirect handler increment a click counter in the URL database?</summary>

It would turn every redirect, about 11,600 a second at peak, into a database write. Worse, a viral link sends thousands of requests a second to update the same row, and those updates queue up behind the row lock. Redirect latency climbs and database connections run out.

Instead, the redirect path only reads, mostly from cache, and publishes a click event to Kafka without waiting. Workers consume the events in batches and write aggregated counts to an analytics store such as ClickHouse. The stats page shows numbers that are a few seconds behind, which is fine.

</details>

<details>
<summary>An API server using range allocation crashes halfway through its block of one million IDs. What happens to the unused IDs, and is that a problem?</summary>

They're never issued. Say the server held 1,000,001 to 2,000,000 and had used up to 1,050,000: the remaining 950,000 are skipped, and the next block the coordinator hands out starts at 2,000,001. Nothing is issued twice, so uniqueness holds. Losing 950,000 IDs out of about 3.5 trillion 7-character codes is negligible. The only visible effect is a gap in the sequence, which nobody depends on.

</details>

<details>
<summary>The product team wants to disable a phishing link that's being shared widely. Which redirect status makes this possible, and what else needs to happen?</summary>

With 302, every click comes back to the shortener, so marking the link disabled in the database takes effect as soon as the cache stops serving the old entry. Delete the key from Redis (and from any in-process caches) when you disable it, and keep TTLs short enough to bound the delay if a delete is missed. With 301, browsers that already cached the redirect keep following it, and there's nothing the server can do about that.

</details>

## Further reading

- [RFC 9110: HTTP Semantics, section 15.4 (Redirection 3xx)](https://www.rfc-editor.org/rfc/rfc9110#section-15.4): the current definitions of 301, 302, 307 and 308. It replaced RFC 7231 in 2022.
- [Base62 (Wikipedia)](https://en.wikipedia.org/wiki/Base62): the alphabet and how numbers are encoded in it.
- [Birthday problem (Wikipedia)](https://en.wikipedia.org/wiki/Birthday_problem): why truncated hashes collide much sooner than intuition suggests.
- [Google Safe Browsing](https://developers.google.com/safe-browsing): the API for checking URLs against Google's lists of phishing and malware sites.
- [ClickHouse documentation](https://clickhouse.com/docs): the column-oriented database used here for click analytics.
