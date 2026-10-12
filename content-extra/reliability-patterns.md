# Timeouts, retries and idempotency

Once a request crosses a network, three outcomes are possible: it succeeds, it fails, or you don't know. The third case is the hard one. The server may never have received the request, or it may have done the work and lost the reply. Almost every reliability pattern in this chapter is a way of handling that uncertainty without making things worse.

These ideas come up in two ways in interviews. Directly, when you design anything that moves money or sends messages ("what if the client retries a payment?"). Indirectly, when an interviewer asks what happens if a dependency gets slow. A slow dependency is often more dangerous than a dead one, because a dead dependency fails fast while a slow one ties up your threads, connections and memory until your service falls over too. That chain is a **cascading failure**, and timeouts, retries, circuit breakers and load shedding are the tools for breaking it.

## Timeouts and deadlines

Every network call needs a timeout. Many client libraries default to none or to a very long one; Python's `requests`, for example, waits indefinitely unless you pass a timeout. A call without a timeout turns a slow dependency into a stuck thread.

Most clients distinguish a **connect timeout** (how long to wait for a TCP connection) from a **request timeout** (how long to wait for the whole response). Connect timeouts can be short, since a healthy server accepts connections quickly. Request timeouts should come from measured latency. A common approach is to pick a percentile of the dependency's latency, such as p99.9, and add a margin. Too tight and you abort requests that would have succeeded, and probably retry them, adding load. Too loose and you hold resources for requests that are already lost.

### Timeouts add up across hops

Suppose a checkout request passes through a gateway, an order service and an inventory service. The gateway gives up after 3 seconds. The order service calls inventory with a 1-second timeout and 3 retries, so 4 attempts. In the worst case that is 4 × 1 s = 4 s of waiting, plus backoff, for a caller that left after 3 seconds. The last attempts do work nobody will see.

A **deadline** fixes this. Instead of each hop choosing its own timeout, the edge sets an absolute deadline ("this request must finish by 12:00:03.000") and each service passes the remaining time downstream. gRPC builds this in: clients set a deadline rather than a timeout, and servers can read the remaining time and pass it on to their own calls. Before starting expensive work, a service checks how much time is left and fails immediately if there isn't enough.

```diagram
title: A 3-second deadline set at the edge shrinks at each hop
[c:client] Client @ 0,0
[gw] Gateway\ndeadline 3 s @ 1,0
[ord] Orders\n2.6 s left @ 2,0
[inv] Inventory\n1.9 s left @ 3,0
[db:store] Stock DB @ 4,0
c -> gw
gw -> ord
ord -> inv
inv -> db
```

## Retries, backoff and retry storms

Retries fix transient failures: a dropped connection, a node restarting, a brief overload. They make persistent failures worse, because every retry is extra load on a system that is already struggling. Three rules keep retries useful.

1. **Retry only what is retryable.** Timeouts, connection errors, 503 and 429 are candidates. A 400 or 404 will fail the same way every time.
2. **Retry only what is safe to repeat.** Reads are safe. A write is safe only if it is idempotent, either naturally or through an idempotency key (next section).
3. **Wait between attempts, with randomness.** Immediate retries hit the server while it is still overloaded.

### Exponential backoff with jitter

Exponential backoff doubles the wait after each failure, up to a cap. On its own it has a flaw: if a thousand clients fail at the same moment, they all wait 100 ms, then all retry together, then all wait 200 ms, and so on. The load arrives in synchronized spikes. **Jitter** randomizes each wait so retries spread out. A widely used form, "full jitter", sleeps a random time between zero and the exponential bound:

```python
import random
import time

class TransientError(Exception):
    """Raised by `op` for failures worth retrying: timeouts, 503s, dropped connections."""

def call_with_retries(op, max_attempts=4, base=0.1, cap=2.0):
    for attempt in range(max_attempts):
        try:
            return op()
        except TransientError:
            if attempt == max_attempts - 1:
                raise
            # Bounds: 0.1 s, 0.2 s, 0.4 s ... never above cap
            bound = min(cap, base * 2 ** attempt)
            time.sleep(random.uniform(0, bound))
```

### Retry storms and retry budgets

Retries multiply across layers. If a web tier, an API tier and a data tier each make up to 3 attempts, one user request can turn into 3 × 3 × 3 = 27 requests at the bottom when that layer is failing. That is how a brief database hiccup turns into a long outage: the retries keep it overloaded after the original cause is gone. This is a **retry storm**.

Two defenses:

- **Retry at one layer.** Usually the layer closest to the user, or the one with the most context. Inner layers fail fast and report the error upward.
- **Use a retry budget.** Cap retries as a fraction of normal traffic, for example 10% of requests over the last minute. Assume a service sends 1,000 requests per second to a dependency that starts failing. With 3 retries per request and no budget, the dependency sees up to 1,000 × 4 = 4,000 requests per second. With a 10% budget it sees at most 1,000 + 100 = 1,100. Google's SRE book describes this pattern, and gRPC's retry policy supports a similar token-based throttle.

## Idempotency keys

An operation is **idempotent** if doing it twice has the same effect as doing it once. `PUT /users/42/email` with a fixed value is idempotent. `POST /payments` is not: retry it after a lost reply and the customer may be charged twice.

An **idempotency key** makes a non-idempotent request safe to retry. The client generates a unique value, typically a UUID, once per logical operation, and sends it with every attempt of that operation, often in an `Idempotency-Key` header. The server remembers what it did for each key and, on a repeat, returns the saved result instead of doing the work again. Stripe's API popularized this; the IETF has a draft standardizing the header.

```diagram
title: The API claims the key before charging, and replays the stored result on a retry
[c:client] Mobile app @ 0,0
[api] Payments API @ 2,0
[k:store] Idempotency\nkeys table @ 2,1.3
[psp] Card processor @ 4,0
c -> api : POST + key
api <-> k : claim or replay
api -> psp : charge
```

### How the server stores and replays results

A table like this, in the same database as the payments themselves, is enough to start:

```sql
CREATE TABLE idempotency_keys (
  account_id    bigint      NOT NULL,
  key           text        NOT NULL,
  request_hash  text        NOT NULL,  -- hash of method, path and body
  status        text        NOT NULL,  -- 'in_progress' or 'completed'
  response_code int,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
```

The request handler then does this:

1. **Claim the key.** Insert a row with status `in_progress`. The primary key makes this atomic: if two attempts arrive at once, only one insert succeeds. Scoping the key to the account stops one client's key from colliding with another's.
2. **If the insert conflicts, look at the existing row.** If its `request_hash` differs, the client reused a key for a different request; reject it with an error. If the status is `in_progress`, another attempt is still running; return a 409 and let the client retry later. If it is `completed`, return the stored status code and body unchanged.
3. **Do the work and record the result.** Where possible, write the business change and mark the key `completed` with its response in one database transaction, so neither can exist without the other.
4. **Expire old keys.** Keys only need to live as long as clients might retry. Stripe, for example, may remove keys once they are at least 24 hours old.

The hard part is a side effect outside your database, like the call to the card processor. If your server crashes after charging but before recording the result, the key is stuck `in_progress` and you don't know whether the charge happened. Two things help. Pass an idempotency key downstream too, so retrying the charge is safe at the processor. And treat a stale `in_progress` row as "resume or reconcile", not "start fresh". Brandur Leach's write-up (linked below) shows how to split a request into recovery points for this.

Consumers of [message queues and event streams](/learn/event-streaming) use the same idea with message IDs instead of client-supplied keys.

## Circuit breakers, bulkheads and load shedding

### Circuit breakers

A **circuit breaker** wraps calls to a dependency and stops making them when the dependency is clearly failing. Failing fast saves your threads, gives callers a quick error or fallback, and gives the dependency room to recover.

| State | Behavior | Moves to |
| --- | --- | --- |
| Closed | Calls pass through; failures are counted over a sliding window | Open, when the failure rate crosses a threshold (say over 50% of the last 20 calls) |
| Open | Calls fail immediately without touching the dependency | Half-open, after a cool-down (say 30 s) |
| Half-open | A few trial calls are allowed through | Closed if they succeed; open again if they fail |

The thresholds above are illustrative; tune them per dependency. Keep one breaker per dependency (or per dependency and endpoint), so a failing recommendations service doesn't trip calls to payments.

### Bulkheads

A ship's bulkheads stop one flooded compartment from sinking the ship. In software, a **bulkhead** gives each dependency its own limited pool of threads, connections or concurrent requests, so one slow dependency can't take all of them.

Little's law (concurrency = arrival rate × time in system) shows why this matters. Say a service has 200 worker threads and sends 60 requests per second to a reviews service. Normally reviews answers in 50 ms, so 60 × 0.05 = 3 threads are busy with it. If reviews slows to 4 seconds, 60 × 4 = 240 threads would be needed. That is more than the service has, so every endpoint stalls, including ones that never touch reviews. With a bulkhead capping reviews at 40 concurrent calls, the excess reviews calls fail fast and the other 160 threads keep serving everything else.

### Load shedding

When a service receives more work than it can handle, trying to serve everything usually means serving nobody well: queues grow, latency climbs past client timeouts, and the server spends its time on requests whose callers have already given up. **Load shedding** means rejecting some work early, so the rest succeeds.

- **Reject cheaply and early**, before parsing large bodies or touching the database. A fast 503 or 429 costs far less than a slow timeout.
- **Use a real overload signal**: in-flight requests, time spent waiting in a queue, or CPU. Not just request rate.
- **Drop work whose deadline has passed.** If the caller's deadline expired while the request sat in a queue, processing it is pure waste.
- **Shed by priority.** Classify requests (checkout over product-image prefetch) and shed the least important first.

This is the server-side counterpart of [rate limiting](/learn/rate-limiting), which caps how much each client may send.

### Graceful degradation

**Graceful degradation** means deciding in advance what a reduced service looks like, so that a partial failure gives users a worse experience instead of an error page. Examples: serve slightly stale data from [cache](/learn/cache) when the database is slow, hide the recommendations panel when its service is down, switch to read-only mode during a failover, or show a static default instead of a personalized one. Each of these is a product decision as much as a technical one, and each needs a switch you can flip quickly. The trade-off is extra code paths that rarely run, so test them, or they will fail on the day you need them.

## Check yourself

<details>
<summary>A mobile app calls POST /transfers. The request times out on the client. The user taps "retry". What could go wrong, and what do you change on the client and the server?</summary>

The first request may have succeeded and only the reply was lost, so the retry could move the money twice. The client should generate an idempotency key when the user starts the transfer and send the same key on every retry. The server claims the key before doing the work, stores the result with it, and returns the stored result for a repeat.

</details>

<details>
<summary>Your service has a 2-second budget from the gateway. It calls a dependency with a 1.5-second timeout and 2 retries. Is that configuration sensible?</summary>

No. Three attempts at 1.5 s each could take 4.5 s, far beyond the 2 s the caller will wait. Either propagate a deadline and only retry if enough time remains, or shorten the per-attempt timeout and limit retries so the worst case fits inside the budget. Most of the time, one retry at most fits.

</details>

<details>
<summary>After a 30-second database outage, the database keeps falling over every time it comes back. Error rates show huge request spikes at regular intervals. What is likely happening?</summary>

Clients are retrying in sync: they all failed at the same moment and are using backoff without jitter, so they return together in waves, and several layers may be multiplying the retries. Add jitter, retry at one layer only, and enforce a retry budget. A circuit breaker in front of the database also stops callers from hammering it while it recovers.

</details>

<details>
<summary>A product page calls price, inventory, reviews and recommendations services. Reviews starts taking 10 seconds per call. Which patterns stop this from taking the product page down, and what does the user see?</summary>

A timeout on the reviews call caps how long each request waits, a bulkhead stops reviews calls from taking all the worker threads, and a circuit breaker stops calling reviews at all once it is clearly failing. Graceful degradation decides what the user sees: the page renders with price and inventory and a "reviews unavailable" placeholder, or cached reviews.

</details>

<details>
<summary>Why is it a bad idea to store idempotency keys in a separate cache, like Redis, while payments are written to Postgres?</summary>

The key and the payment can't be updated atomically. If the server crashes after writing the payment but before marking the key completed, a retry will charge again; if it marks the key first, a crash can leave a "completed" key with no payment. Keeping both in one database lets one transaction cover them. A separate store can work, but then you need extra reconciliation logic for these gaps.

</details>

## Further reading

- [Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) (Amazon Builders' Library): how Amazon picks timeouts and limits retries.
- [Exponential backoff and jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) (AWS Architecture Blog): simulations comparing jitter strategies.
- [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) (Amazon Builders' Library).
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests) (Stripe API reference): a production idempotency key contract.
- [Implementing Stripe-like idempotency keys in Postgres](https://brandur.org/idempotency-keys) by Brandur Leach: recovery points and crash handling in detail.
- [Handling overload](https://sre.google/sre-book/handling-overload/) and [Addressing cascading failures](https://sre.google/sre-book/addressing-cascading-failures/) (Google SRE book): retry budgets, load shedding and deadline propagation.
- [Circuit breaker](https://martinfowler.com/bliki/CircuitBreaker.html) by Martin Fowler.
- Alex Xu, *System Design Interview – An Insider's Guide, Volume 2* (2022), with Sahn Lam, "Payment system".
