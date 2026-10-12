# Rate limiting

A rate limiter caps how many requests a client can make in a period of time and turns away the rest. It protects shared capacity from one noisy client, blunts abuse like credential stuffing and scraping, keeps costs predictable when each request costs you money (SMS, third-party APIs, GPU time), and turns API pricing tiers into something you can enforce.

Interviews use it two ways. "Design a rate limiter" is a classic standalone question, and it tests whether you can pick an algorithm, keep counters correct across many servers, and decide what happens when the limiter itself fails. Rate limiting also comes up as a component inside bigger designs: any public API, login flow or notification system should have one.

It's related to [back pressure](/learn/asynchronism#back-pressure) in the primer, but the focus differs. Back pressure reacts to how loaded the server is. A rate limiter enforces a policy per client, whether or not the server is busy.

## Where the limiter lives

You can enforce limits at several layers, and each one sees different information.

- **In the client.** Polite SDKs throttle themselves, which cuts wasted requests. You can't rely on it, since an abusive client won't run your SDK.
- **At the edge** (CDN, WAF, [reverse proxy](/learn/reverse-proxy-web-server#overview)). Rejecting here is cheapest, because the request never reaches your servers. But the edge usually knows only the IP address, path and headers, not who the user is or what plan they pay for.
- **At the API gateway.** This is the most common home for per-user and per-API-key limits. The gateway has authenticated the caller, so it knows their identity and tier, and the limit is applied in one place for every service behind it.
- **In the service.** Only the service knows how expensive an operation really is ("export 10,000 rows" versus "fetch one row"), so cost-based limits live here. The request has already used some resources by the time it's rejected.
- **In front of a shared dependency.** Per-tenant connection pools or queue quotas stop one customer from monopolizing a database.

Most production systems layer these: a coarse per-IP limit at the edge to absorb floods, per-key quotas at the gateway, and a few cost-based limits inside expensive services.

```diagram
title: Limits are layered. Cheap checks happen early, detailed ones later.
[c:client] Clients @ 0,1
[edge] Edge or CDN\nper-IP limit @ 1,1
[gw] API gateway\nper-key limit @ 2,1
[redis:store] Redis\ncounters @ 2,0
[svc] Services\ncost limits @ 3,1
[db:store] Database @ 4,1
c -> edge
edge -> gw
gw <-> redis : check
gw -> svc
svc -> db
```

## Choosing the key

The limiter counts requests per key, and the key you choose decides who gets hurt by a false positive.

- **Per IP address.** This works before authentication, so it's the only option for login pages, sign-up forms and anonymous endpoints. But many people can share one IP behind corporate proxies and carrier-grade NAT, so a strict per-IP limit blocks innocent users. Attackers with botnets have many IPs. With IPv6, a single host can rotate through a huge range of addresses, so limit by prefix (often the /64) rather than by full address.
- **Per user or account.** This is fair and accurate for authenticated traffic, and it follows the user across devices. It doesn't help before login, and it doesn't stop one person creating many accounts.
- **Per API key or tenant.** This maps directly to billing tiers ("free: 60 requests a minute, pro: 1,000"). One key may serve thousands of end users of a customer's app, so set the limit with that in mind.
- **Per endpoint or by cost.** A search might cost 10 tokens and a profile read 1. That protects expensive operations without starving cheap ones.
- **Global.** A ceiling on total traffic to a fragile backend, regardless of who sends it.

Real rules combine these, and a request must pass all of them. A login endpoint, for example, might allow 5 failed attempts per username per 15 minutes (to stop password guessing against one account) and 100 per IP per hour (to slow credential stuffing across many accounts).

## The algorithms

The five common algorithms are easiest to understand as a progression. Each one fixes a weakness of the one before it, and the last two take a different view: instead of counting requests in a window, they model a rate directly.

| Algorithm | State per key | Bursts | Accuracy |
|---|---|---|---|
| Fixed window counter | one counter | up to 2× the limit across a boundary | coarse |
| Sliding window log | one timestamp per request | none past the limit | exact |
| Sliding window counter | two counters | small overshoot possible | approximate |
| Token bucket | token count + last refill time | allows bursts up to bucket size | exact for its rule |
| Leaky bucket (queue) | a bounded queue | smoothed to a fixed output rate | exact; adds delay |

### Fixed window counter

Keep one counter per key per window (per minute, say), increment it on each request and reject once it passes the limit. It's the cheapest option and easy to reason about. The flaw is at the boundary. With a limit of 100 a minute, a client can send 100 requests at 12:00:59 and 100 more at 12:01:00, which is 200 in about a second. Clients that were rejected also tend to retry together when the window resets, causing a spike.

### Sliding window log

Store a timestamp for every accepted request. On each new request, drop timestamps older than the window, count what's left and allow the request if the count is under the limit. It's exact, but memory grows with the limit: a limit of 10,000 an hour means storing up to 10,000 timestamps per key. It suits small limits where precision matters.

### Sliding window counter

Keep fixed-window counters for the current and previous windows, and weight the previous one by how much of it still overlaps the sliding window:

```text
estimate = current + previous × (1 − elapsed fraction of current window)
```

Say the limit is 50 a minute. The previous minute saw 48 requests, and 40 seconds into this minute there have been 31. Two-thirds of the window has elapsed, so a third of the previous minute still counts: 31 + 48 × ⅓ = 47. The request is allowed, and so are the next two; the one after that is rejected. This assumes the previous window's requests were spread evenly, so it can be slightly off. It costs two counters per key, and it removes most of the boundary burst. Cloudflare described using this approach and found the error small in practice.

### Token bucket

Each key has a bucket that holds up to `capacity` tokens and refills at `rate` tokens per second. A request takes one token, or more if it's expensive. No token, no service. A client that's been quiet can burst up to the full capacity, while the long-run average can't exceed the refill rate. Two knobs, burst and sustained rate, map well onto how people actually use APIs, which is why it's the most common choice for public APIs (Stripe describes its token-bucket limiters in the post under Further reading).

You don't need a timer to refill. Store the time of the last update and add the tokens owed whenever a request arrives:

```python
import time

class TokenBucket:
    def __init__(self, rate: float, capacity: float):
        self.rate = rate              # tokens added per second
        self.capacity = capacity      # largest burst allowed
        self.tokens = capacity        # start full
        self.updated = time.monotonic()

    def try_acquire(self, cost: float = 1.0) -> float:
        """Return 0 if allowed, otherwise the seconds to wait before retrying."""
        now = time.monotonic()
        # Refill lazily from the elapsed time.
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now
        if self.tokens >= cost:
            self.tokens -= cost
            return 0.0
        return (cost - self.tokens) / self.rate
```

The wait time it returns is exactly what you'd put in a `Retry-After` header. This version is single-process and not thread-safe; the distributed version comes later.

### Leaky bucket

There are two versions of the name. As a meter, it's the token bucket viewed from the other side: a bucket that fills with each request and drains at a fixed rate, rejecting when full. As a queue, requests wait in a fixed-size FIFO and are released at a constant rate, and new requests are dropped when the queue is full. The queue form smooths traffic into a steady stream, which protects a backend that can't handle bursts, at the price of added latency. NGINX's `limit_req` uses this method. Its `burst` setting sizes the queue, and `nodelay` passes queued requests through immediately, which makes it behave much like a token bucket.

## Distributed counters in Redis

With one gateway instance, the counters can live in memory. With twenty, they can't: each instance would see a twentieth of a client's traffic and enforce a limit twenty times too loose. The usual fix is a shared, fast store, most often Redis.

**The race.** The naive version reads the count, checks it and writes it back. Two gateways can both read 99, both decide the request is under the limit of 100, and both write 100. Both requests get through, and the counter is now wrong. Under real concurrency this happens constantly.

**Atomic increments fix the simple case.** `INCR` increments and returns the new value in one step, so check the result *after* incrementing: if `INCR` returns 101, reject. For a fixed window, put the window number in the key name (for example `rl:user42:28732150`) and send `INCR` and `EXPIRE` together in a `MULTI`/`EXEC` transaction so the key can't be left without an expiry if the client crashes between the two commands. Because the window is part of the name, refreshing the expiry on every request is harmless.

**Lua scripts fix the rest.** A token bucket or sliding log needs to read state, decide and write several fields. Redis runs a Lua script atomically: no other command runs while it executes. Here is a sliding-window log as one script:

```lua
-- KEYS[1]: the limit key. ARGV: now_ms, window_ms, limit, unique request id
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], window)
  return 1
end
return 0
```

The request ID must be unique, because a sorted set holds each member once, and two requests in the same millisecond with the same member would count as one. The time comes from the caller here, so gateway clocks need to agree. Alternatively, read Redis's own clock with `TIME` inside the script, which Redis 5 and later allow.

Other things to plan for:

- **Latency.** Every request now makes a round trip to Redis, around half a millisecond inside a data center. Keep Redis close to the gateways.
- **Sharding.** In Redis Cluster, every key a script touches must live in the same hash slot. One key per limit avoids the problem; use hash tags like `{user42}` if you need several.
- **Hot keys.** One huge tenant's counter lives on one Redis shard (see [consistent hashing](/learn/consistent-hashing)). If that's a problem, let each gateway take a batch of tokens locally and sync with Redis periodically. You accept a small overshoot in exchange for far fewer round trips. Envoy's design is similar in spirit: a local rate limit filter in each proxy, plus an optional call to a global rate limit service backed by Redis.
- **Read from the primary.** Reading counts from a lagging replica undercounts.
- **When Redis is down.** You must choose. **Fail open** (allow everything) keeps the product up but drops protection; many user-facing APIs do this, often falling back to a looser per-instance limit. **Fail closed** (reject everything) is right when each request costs real money or the limit is a security control, such as sending SMS codes.

## Telling the client

**Status code.** Use `429 Too Many Requests`, defined in RFC 6585, when a client exceeds its limit. Some services use `503 Service Unavailable` when the whole system is overloaded rather than one client. The distinction helps clients: a 429 means "you slow down", a 503 means "everyone wait".

**When to retry.** `Retry-After` (defined in HTTP semantics, RFC 9110) gives either a number of seconds or a date. Seconds are safer, because they don't depend on the client's clock being right.

**Remaining quota.** There's no finished standard yet. Many APIs use unofficial `X-RateLimit-*` headers. GitHub, for example, sends `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-used` and `x-ratelimit-reset` (a Unix timestamp). The IETF HTTP APIs working group is standardizing this in draft-ietf-httpapi-ratelimit-headers. Early versions of the draft defined separate `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` fields. Recent versions use two structured fields: `RateLimit-Policy` describes the quota, and `RateLimit` reports what's left. Since it's still a draft, check the current version before copying the syntax.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 7
RateLimit-Policy: "per-key";q=100;w=60
RateLimit: "per-key";r=0;t=7
Content-Type: application/json

{"error": "rate_limited", "message": "Limit of 100 requests per minute exceeded."}
```

A few habits make limits easier to live with:

- **Send quota headers on successful responses too,** so well-behaved clients can pace themselves before they hit the wall.
- **Expect clients to back off with jitter,** so they don't all retry at the same instant (see [reliability patterns](/learn/reliability-patterns)).
- **Roll out new limits in shadow mode first.** Log what would have been rejected, check that real customers aren't caught, then enforce.
- **Consider alternatives to rejecting.** You can queue and delay (the leaky bucket), serve a cached or reduced response, or limit concurrency instead of rate. Stripe, for example, describes a limiter on in-flight requests per user alongside its request-rate limiter, and separate load shedders that drop low-priority traffic first when the whole fleet is under pressure.

## Check yourself

<details>
<summary>A fixed-window limiter allows 100 requests per minute. What's the most a client can get through in any 2-second span, and which algorithm would prevent it?</summary>

Up to 200: 100 at the very end of one window and 100 at the very start of the next. A sliding window log prevents it exactly. A sliding window counter prevents most of it, at the cost of two counters. A token bucket with a capacity of 100 still allows a 100-request burst, but not 200, because the bucket can't refill instantly.

</details>

<details>
<summary>A token bucket refills at 10 tokens per second and holds 50. A client that's been idle sends 80 requests at once. How many succeed, and what Retry-After should the next rejected request get?</summary>

The bucket is full after the idle period, so 50 succeed and 30 are rejected. The bucket is then empty and refills one token every 0.1 seconds. `Retry-After` takes whole seconds, so you'd round up and send 1.

</details>

<details>
<summary>Two gateway instances share a Redis counter, using GET, then compare, then SET. What goes wrong under load, and how do you fix it?</summary>

Both instances can read the same value, both decide the request is allowed, and both write the same incremented value. Requests slip past the limit and the count is too low. Use `INCR` and check the value it returns, or move the whole read-decide-write into a Lua script so Redis runs it atomically.

</details>

<details>
<summary>Your rate-limit Redis cluster goes down. Should a public read API fail open or fail closed? What about an endpoint that sends SMS verification codes?</summary>

The read API should usually fail open, ideally falling back to a looser per-instance limit, since rejecting every request turns a limiter outage into a full outage. The SMS endpoint should fail closed: each request costs money, and attackers abuse unprotected SMS endpoints for toll fraud. The answer depends on whether the limit protects capacity or protects money and security.

</details>

<details>
<summary>A B2B customer complains that their users get 429s even though each user sends only a few requests. All their traffic comes from their own backend. What's likely happening?</summary>

They're probably being limited per IP or per API key, and their backend sends all their end users' traffic through one IP and one key. Every user shares a single quota. You could raise that customer's tier, offer per-end-user limits (letting them pass a user identifier you trust), or document the limit so they can queue on their side.

</details>

## Further reading

- [Stripe, "Scaling your API with rate limiters"](https://stripe.com/blog/rate-limiters): four kinds of limiter and load shedder in production, with a token bucket in Redis.
- [Cloudflare, "How we built rate limiting capable of scaling to millions of domains"](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/): the sliding window counter at very large scale, with an accuracy analysis.
- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585): defines the 429 status code.
- [RFC 9110, HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110): includes `Retry-After` and `503`.
- [IETF draft: RateLimit header fields for HTTP](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/): the proposed standard headers, with history of each version.
- [Redis INCR documentation](https://redis.io/docs/latest/commands/incr/): includes rate limiter patterns built on `INCR`.
- [NGINX limit_req module](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html): a leaky bucket limiter with `burst` and `nodelay`.
- [Google SRE book, "Handling Overload"](https://sre.google/sre-book/handling-overload/): per-client quotas, client-side throttling and request criticality.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design a rate limiter".
