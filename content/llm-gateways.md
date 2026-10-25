# LLM gateways

A **model provider** sells access to a language model through an HTTP API. A **gateway** sits between your applications and those providers. Each application calls one internal endpoint, and the gateway chooses which provider or model answers. An LLM gateway is a specialized [API gateway](/learn/reverse-proxy-and-api-gateway#reverse-proxy-vs-api-gateway). That chapter covers TLS, authentication and per-key limits, so this one covers what changes for model traffic:

- Answers **stream for many seconds**, so connections stay open far longer than typical web requests.
- Cost is counted in **tokens**, the pieces of text a model reads and writes (see [Tokens](/learn/llm-inference#tokens)), and the output count is known only at the end.
- Providers set **their own limits** in requests and tokens per minute.
- Models are **not interchangeable**. A fallback can change the answer, its format, or whether the request is accepted at all.

This chapter answers five questions:

- What does a gateway add beyond calling a provider directly?
- How should a gateway choose a model, and when should it fall back?
- Why reserve tokens before the answer exists, and settle them afterward?
- What can a gateway cache, and how can a cache return a wrong answer?
- How do streams pass through a gateway, and how do you track cost per team?

We'll follow **Crumb**, the recipe site from earlier chapters. Its recipe helper answers cooking questions with a hosted model. The search team wants a second provider as a backup, and the data team runs a small **open-weight** model (one whose weights are published for download) on its own GPUs. Without a gateway, each service would need its own keys, retries, token counts and logs. The [LLM gateway design question](/learn/design-llm-gateway) sizes the same parts for a company with 200 apps.

## What a gateway adds

Without a gateway, each Crumb service calls a provider directly, holds its own key, retries in its own way and writes its own logs. Rotating a key means changing every service. With a gateway, each service makes one kind of call to one internal address:

```diagram
title: One gateway sits between every app and every model endpoint
[a1:client] Recipe helper @ 0,0
[a2:client] Search team @ 0,1
[a3:client] Nightly job @ 0,2
[gw] LLM gateway\nkeys, limits, logs @ 1.5,1
[p1] Provider A\nhosted model @ 3.5,0
[p2] Provider B\nhosted model @ 3.5,1
[sh:store] Self-hosted\nopen-weight model @ 3.5,2
a1 -> gw : one API
a2 -> gw
a3 -> gw
gw -> p1
gw -> p2
gw -> sh
```

The gateway does three jobs:

- **One request format.** vLLM, a serving engine that runs models on GPUs, lists a Chat Completions endpoint at `/v1/chat/completions` for text models with a chat template. Agent Router, formerly Envoy AI Gateway, describes its aim as "a stable, OpenAI-compatible interface to models." The gateway translates to a provider's native format when it must.
- **Keys.** Applications authenticate to the gateway with a key the gateway issues, so provider keys never leave it. LiteLLM calls these virtual keys, and each can belong to a person or a team.
- **Routing, limits, caching and logs,** covered below.

The gateway adds a network hop and some processing time, which you should measure. It cannot make a weak model answer well or stop a malicious prompt on its own. It is one layer among several.

## Routing and fallbacks

**Routing** chooses a **target** (a provider, a model and a key) for each request. A **fallback** is the next target to try. Apps request an **alias** such as `chat-large`, a name the gateway maps to a list of targets, so moving traffic off a provider means editing that list.

Let the status code decide how to react:

1. **429** means a limit was reached. Wait the seconds in `Retry-After` if present. Anthropic's rate-limit page says to "wait that many seconds before retrying." Without the header, OpenAI's error page recommends exponential backoff with jitter. If the 429 persists, fall back.
2. **500, 502, 503, 504 and 529** mean the provider is failing or busy. Retry briefly, then fall back. Anthropic describes 529 as "The API is temporarily overloaded."
3. **Timeouts and connection failures** justify a fallback.
4. **400** means the request is wrong for that target. Anthropic's error page lists many model-specific rules, such as several recent models rejecting forced tool use. Check a target's features before routing to it, so fallbacks do not become a chain of 400s.

Three retry rules matter most:

- **Never retry a spend-cap 429,** which signals a limit on total spending. Anthropic's errors page says a spend-cap 429 has no `retry-after` header and that retrying "fails until access resumes." OpenAI's page says "Retrying billing, spend, or quota errors won't restore API access." Mark that account unavailable and alert its owner.
- **Don't stack retries.** Anthropic's SDK retries transient failures "twice by default." Three gateway attempts, each with three SDK attempts, can reach a provider nine times: 3 × 3 = 9.
- **Cool down failing targets.** LiteLLM can cool down one deployment right after a 429 and route around it.

The first block is a fallback loop. It retries transient errors with backoff, honors `Retry-After`, and moves on when retrying cannot help.

```python
import random
import time

RETRYABLE = {429, 500, 502, 503, 504, 529}   # limits, overload, server errors


class ProviderError(Exception):
    def __init__(self, status: int, retry_after: float = 0.0,
                 spend_cap: bool = False):
        super().__init__(f"HTTP {status}")
        self.status = status
        self.retry_after = retry_after   # seconds, from the Retry-After header
        self.spend_cap = spend_cap       # an account budget stop


def call_with_fallback(targets, request, base_delay=0.5, max_tries=3):
    """Try (name, call) pairs in order. Retry transient errors on each one."""
    for name, call in targets:
        for attempt in range(max_tries):
            try:
                return name, call(request)
            except ProviderError as err:
                if err.status not in RETRYABLE or err.spend_cap:
                    break                # 400, 401 and spend caps: move on
                if attempt + 1 < max_tries:
                    jitter = random.uniform(0.5, 1)
                    wait = err.retry_after or base_delay * 2**attempt * jitter
                    time.sleep(wait)
    raise RuntimeError("every target failed")
```

The second block runs the loop on fake targets, so the output is fixed.

```python
def fake_provider(statuses, answer):
    """A fake target that fails with each status in turn, then answers."""
    pending = list(statuses)

    def call(request):
        if pending:
            raise ProviderError(pending.pop(0))
        return f"{answer}: {request}"

    return call


spare = fake_provider([], "spare")
overloaded = fake_provider([503, 503, 503], "primary")   # fails on every try
chain = [("big", overloaded), ("small", spare)]
print(call_with_fallback(chain, "hi", base_delay=0.01))
limited = fake_provider([429], "limited")                # one 429, then fine
print(call_with_fallback([("big", limited)], "hi", base_delay=0.01))
strict = fake_provider([400], "strict")                  # rejects this shape
chain = [("strict", strict), ("flexible", spare)]
print(call_with_fallback(chain, "hi", base_delay=0.01))
only = [("only", fake_provider([401], "x"))]
try:
    call_with_fallback(only, "hi", base_delay=0.01)
except RuntimeError as err:
    print(err)

# Output:
# ('small', 'spare: hi')
# ('big', 'limited: hi')
# ('flexible', 'spare: hi')
# every target failed
```

A different model is not a drop-in replacement, since context windows, tool calling, JSON rules and tone differ. Keep a capability table per target, route only to targets that support the request, and run the evaluation set on each fallback first (see [running evals before release](/learn/ai-evals-and-observability#running-evals-before-release)). Ramp fallback traffic up gradually too: Anthropic warns that a sharp rise in usage can cause 429 errors from "acceleration limits."

## Token-based rate limits

Providers limit traffic per minute in requests and in tokens. OpenAI measures requests (RPM) and tokens (TPM). Anthropic measures requests, input tokens (ITPM) and output tokens (OTPM). OpenAI's rate-limit page warns that "Rate limits can be hit across any of the options depending on what occurs first."

Requests alone miss the point, because a 20-token question and a 4,000-token document both count as one request. Anthropic says its API uses "the token bucket algorithm," which refills capacity continuously. The [rate limiting chapter](/learn/rate-limiting#token-bucket) explains the algorithm, and the gateway uses the same idea with tokens.

The hard part is timing. When a request arrives, the gateway knows the prompt size but not the reply length, which is capped only by `max_tokens` if the app sets one. So the gateway works in two steps:

1. **Reserve** an estimate at admission: the prompt plus `max_tokens` (the worst case), or plus an expected reply.
2. **Settle** when the response ends: replace the reservation with the provider's real count, returning unused tokens or charging the extra.

Providers count differently, so the gateway must match each rule. OpenAI's rate-limit page says a request counts the larger of `max_tokens` and an estimate from its characters, so the provider already counts the full `max_tokens`. Anthropic estimates input at the start and adjusts it during the request. It counts output "in real time as output tokens are produced," and says `max_tokens` does not factor into its output limit. A gateway that uses one rule for both will either exceed a limit and collect 429s, or refuse work the provider would accept.

Reservation size is a trade-off. Assume a key allows 100,000 tokens a minute, for this example only. Each request has a 2,000-token prompt and `max_tokens` of 2,000, and replies average 800 tokens.

- A worst-case reservation of 2,000 + 2,000 = 4,000 tokens admits 100,000 ÷ 4,000 = 25 requests a minute. Real use is 25 × 2,800 = 70,000 tokens, so 30,000 go unused.
- A prompt-only reservation of 2,000 admits 50 requests a minute. Real use would be 50 × 2,800 = 140,000 tokens, which is over the limit. The key runs out after about 100,000 ÷ 2,800 ≈ 35 requests, and 429s follow.

The next block is a single-process token budget. `_refill` adds tokens in proportion to elapsed time, so no timer is needed.

```python
import threading
import time


class TokenBudget:
    """A token bucket that holds estimated tokens and settles them later."""

    def __init__(self, tokens_per_minute: float, capacity: float):
        self.rate = tokens_per_minute / 60   # tokens refilled per second
        self.capacity = capacity             # the largest burst allowed
        self.level = capacity                # tokens available right now
        self.updated = time.monotonic()
        self.lock = threading.Lock()

    def _refill(self) -> None:
        now = time.monotonic()
        refilled = self.level + (now - self.updated) * self.rate
        self.level = min(self.capacity, refilled)
        self.updated = now

    def reserve(self, estimate: int) -> float:
        """Hold `estimate` tokens. Return 0.0 if held, else seconds to wait."""
        if estimate > self.capacity:
            raise ValueError("estimate exceeds the bucket capacity")
        with self.lock:
            self._refill()
            if self.level >= estimate:
                self.level -= estimate
                return 0.0
            return (estimate - self.level) / self.rate

    def settle(self, reserved: int, actual: int) -> None:
        """Swap the reservation for the real count. The level can go negative."""
        with self.lock:
            self._refill()
            self.level += reserved - actual
```

```python
bucket = TokenBudget(tokens_per_minute=60_000, capacity=6_000)

# Request 1 reserves 4,000: a 2,000-token prompt plus max_tokens of 2,000.
print(bucket.reserve(4_000))                  # 0.0
bucket.settle(reserved=4_000, actual=2_200)   # the reply was 200 tokens
print(round(bucket.level))                    # 3800

# Request 2 reserves 2,500: the prompt plus an expected reply of 500.
bucket.reserve(2_500)
bucket.settle(reserved=2_500, actual=6_000)   # the reply ran to 4,000 tokens
print(round(bucket.level))                    # -2200: the bucket is in debt

# Request 3 waits for the debt to clear, at 1,000 tokens a second.
print(round(bucket.reserve(2_500), 1))        # 4.7
```

The demo shows three cases. A short reply returns tokens. A long reply drives the level below zero, which the code calls debt, and the next request waits for the debt to clear. That wait is the value to send in `Retry-After`. An estimate larger than the bucket can never fit, so it is rejected at once.

Three more rules matter in production:

- **Take both measures together.** Reserve a request slot and a token allowance, and return the first if the second fails.
- **Share the counters.** Per-instance counters let a client get N times the limit across N instances. Redis, a shared fast data store, is the usual fix. LiteLLM's docs say that without Redis, the proxy "keeps enforcing limits per instance." The [distributed counters section](/learn/rate-limiting#distributed-counters-in-redis) covers the atomic updates. LiteLLM can return 503 when it cannot verify its counters, the fail-closed choice.
- **Spread limits across keys and workspaces.** One team's key can run dry while another's has room. Anthropic's workspace limits sit under the organization's limit, which divides one account's capacity between teams.

## Caching responses

A gateway can save work at three levels, each with its own risks.

**An exact-match cache** stores full replies. The key must include everything that can change the answer, plus the **tenant** (the customer or team that owns the data), so one customer never receives another's reply. LiteLLM's docs show a custom key built from the model, messages, temperature and `logit_bias`.

```python
import hashlib
import json


def cache_key(tenant: str, request: dict) -> str:
    """Exact-match key: every field that can change the reply goes in."""
    fields = {k: request.get(k) for k in
              ("model", "messages", "temperature", "max_tokens", "tools")}
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode()).hexdigest()
    return f"{tenant}:{digest}"


base = {"model": "small-chat", "temperature": 0,
        "messages": [{"role": "user", "content": "Store hours?"}]}
hotter = {**base, "temperature": 0.9}
print(cache_key("team-a", base) == cache_key("team-a", dict(base)))  # True
print(cache_key("team-a", base) == cache_key("team-b", base))        # False: tenant
print(cache_key("team-a", base) == cache_key("team-a", hotter))      # False: temperature
```

Set lifetimes per use case: opening hours can be cached for an hour, but one customer's order status should never be. LiteLLM's per-call controls include `ttl`, `no-cache` and `no-store`.

```diagram
title: Two caches with different owners: the gateway's and the provider's
[app:client] Application @ 0,0.5
[gw] Gateway\nexact-match cache @ 1.5,0.5
[rc:store] Redis or memory @ 1.5,2
[pv] Provider\nprompt cache @ 3.5,0.5
app -> gw : request
gw <-> rc : lookup, store
gw -> pv : on a miss
```

**A provider prompt cache** reuses the processed state of a prompt's start, called the **prefix**. Its rules are stricter than most people expect.

- **Matching is by prefix.** Anthropic's docs require "100% identical prompt segments" up to the marked block, and changing any block at or before it "produces a different hash." OpenAI's docs say "Cache reuse requires the entire rendered prefix to match." Put stable content first, and put per-request values such as timestamps last.
- **Short prompts are skipped silently.** Anthropic's minimum runs from 512 to 4,096 tokens depending on the model. Shorter prompts "will be processed without caching, and no error is returned." Log cached-token counts so the misses show up.
- **Lifetimes and prices differ.** Anthropic's default lifetime is 5 minutes, refreshed on each use. OpenAI's newest models keep a prefix eligible for reuse for 30 minutes after its last write or reuse. As of October 2026, Anthropic lists cache reads at 0.1 times the base input price for most models and 5-minute cache writes at 1.25 times. OpenAI says cached input is "discounted up to 95%." These are ratios from the docs at the time of writing, so check the current pages before you forecast.
- **Scope caches per customer.** Anthropic isolates caches per workspace and never shares them across organizations. OpenAI's docs say separate cache keys "help prevent cache-hit probing across users," since a faster response can reveal that someone recently sent the same prefix.

The gateway's job is to keep prompts stable and to report cache hit rates for each team.

**A semantic cache** matches on meaning. It turns the question into an **embedding**, a list of numbers that represents the text's meaning (see [vector search](/learn/vector-search)), and returns a stored reply when a similar question clears a threshold. Hit rates can be high, and so can wrong answers. In a November 2025 InfoQ article, a production system matched "I don't want this business account anymore" to automatic payment cancellation steps at 84.9% confidence. The team reported a 99% false-positive rate for some models at a threshold of 0.7. Start with exact matches. Add semantic caching only for narrow, frequent questions, tuned on labeled pairs (see [building an eval set](/learn/ai-evals-and-observability#building-an-eval-set)) and scoped per tenant.

## Streaming through a gateway

Most chat products stream: the provider sends small events over server-sent events (SSE). OpenAI's streaming guide describes "HTTP streaming (stream=true) over server-sent events (SSE)," and Anthropic's docs use `"stream": true`. Users feel the **time to first token**, the wait before the first word appears, and then read as the rest arrives (see [latency and throughput metrics](/learn/llm-inference#latency-and-throughput-metrics) and [SSE](/learn/realtime#server-sent-events-sse)).

```diagram
title: The gateway forwards each event as it arrives and settles at the end
[p:client] Provider\nstreams events @ 0,0.5
[gw] Gateway\nforwards, counts @ 2,0.5
[c:client] Browser\nshows text @ 4,0.5
[l:store] Token ledger @ 2,2
p -> gw : SSE events
gw -> c : as they arrive
gw --> l : settle when done
```

Streaming creates three problems for a proxy:

- **Buffering.** NGINX buffers responses by default. With `proxy_buffering off`, its docs say the response "is passed to a client synchronously, immediately as it is received." Otherwise users see nothing, then everything at once. A provider can also send `X-Accel-Buffering: no` for one response.
- **Idle timeouts.** An idle timeout caps how long a connection may stay silent. NGINX's `proxy_read_timeout` defaults to 60 seconds "between two successive read operations," not for the whole response, so a steady stream is safe. Envoy's route timeout defaults to 15 seconds, which its docs call "typically a problem for streaming responses," so streaming routes need an idle timeout instead. Forward the `ping` events some providers send during long pauses, since they count as activity.
- **Errors after the first byte.** Once the first event is out, the status is fixed at 200, yet Anthropic's errors page says an error "can occur after the API returns a 200 response." The gateway can end the stream with its own error event, retry on another target only if nothing reached the user, or resume from the partial text, as Anthropic's recovery guidance describes. Resuming can repeat or contradict text already read, so use it only where the product tolerates that.

Usage arrives inside the stream too. Anthropic's `message_start` carries the input token count, and each `message_delta` carries a cumulative output count. The relay below forwards events as they arrive and settles in a `finally` block, so a client that disconnects still releases its budget.

```python
def relay(events, budget, reserved, send):
    """Forward streamed events as they arrive, then settle the reservation."""
    actual = reserved                  # cut short: charge all of it
    tokens_in = 0
    try:
        for event in events:
            if event["type"] == "message_start":
                tokens_in = event["message"]["usage"]["input_tokens"]
            elif event["type"] == "message_delta":
                # The output count is cumulative, so the last one wins.
                actual = tokens_in + event["usage"]["output_tokens"]
            send(event)                # no buffering: the client sees it now
    finally:
        budget.settle(reserved=reserved, actual=actual)


events = [
    {"type": "message_start", "message": {"usage": {"input_tokens": 500}}},
    {"type": "content_block_delta", "delta": {"text": "Hello"}},
    {"type": "message_delta", "usage": {"output_tokens": 15}},
    {"type": "message_stop"},
]
budget = TokenBudget(tokens_per_minute=60_000, capacity=20_000)

budget.reserve(2_500)                  # 500 prompt tokens plus max_tokens of 2,000
relay(events, budget, 2_500, send=lambda e: print(e["type"]))  # prints four names
print(round(budget.level))             # 19485

budget.reserve(2_500)
relay(events[:2], budget, 2_500, send=lambda e: None)   # cut off before message_delta
print(round(budget.level))             # 16985: the whole reservation is kept
```

The relay must pass unknown event types along, since Anthropic says code "should handle unknown event types gracefully." Streams also hold connections open. By [Little's law](/learn/performance-and-latency#littles-law), 100 new streams a second that each last 20 seconds keep 100 × 20 = 2,000 streams open at once, so size the gateway's connection limits for that.

## Tracking cost

Cost comes from the provider's usage report. The gateway's estimate only drives admission. The formula is:

```text
cost = uncached input × input price + cache reads × read price
     + cache writes × write price + output × output price
```

Assume $3.00 per million input tokens and $15.00 per million output tokens. These are assumptions, not quotes, and real prices vary by provider, model and commitment. A cache read costs 0.1 times the input price, or $0.30 per million. A request with 1,000 uncached input tokens, 5,000 cache-read tokens and 500 output tokens costs:

- Uncached input: 1,000 × $3.00 ÷ 1,000,000 = $0.0030
- Cache reads: 5,000 × $0.30 ÷ 1,000,000 = $0.0015
- Output: 500 × $15.00 ÷ 1,000,000 = $0.0075
- Total: $0.0120

Without the cache, the 6,000 input tokens would cost $0.0180, so the cache cut the input cost by 75%.

Write one ledger row per request, with tokens by kind, team, target, status and a `price_version`, so old reports can be reproduced after prices change.

Budgets need reservations too. Without one, 50 requests in flight can overshoot a team's budget by the cost of 50 requests. LiteLLM supports budgets per key, user and team, reset by a `budget_duration`. Its docs warn that the default `max_budget` is null and "is not checked for keys," so test that setting before you rely on it. Charging each team from the ledger every month is **chargeback**: billing each team for what it used.

## Logging and guardrails

A gateway sees every prompt and reply, which makes its logs sensitive. Log what you need to operate it: the gateway's request ID and the provider's (Anthropic's errors page says every response carries a `request-id` header), plus team, alias, target, fallback path, token counts, cache hits, time to first token and error type. Do not log full prompts by default. If you must keep them, encrypt them, keep them briefly and redact them first.

**Redaction** removes personal data before a prompt leaves your network. Names, email addresses, card numbers and phone numbers become placeholders. Microsoft Presidio is an MIT-licensed, open-source SDK whose README describes "fast identification and anonymization modules for private entities in text." Detectors miss some items and flag others, so test on your own traffic. The [security chapter](/learn/ai-security#leaking-data) covers the risk.

**Guardrails** check both directions: size limits, injection screening and policy (which teams may use which models) on the way in, and moderation and format checks on the way out. OWASP's entry on unbounded consumption recommends input size limits, rate limits, quotas and timeouts. Run cheap checks first, and measure their latency apart from the model's time to first token (see [abuse and content safety](/learn/ai-security#abuse-and-content-safety)).

## Build or buy

- **Build a thin layer:** auth, virtual keys, token budgets, one adapter per provider and a ledger. You get control, but you own every provider change, so each adapter needs tests against the live API.
- **Run an open-source proxy:** LiteLLM provides virtual keys, budgets, per-minute limits, routing, fallbacks and caching. It needs Redis for shared counters, and some features, such as per-model budgets, need a commercial enterprise license.
- **Run Agent Router:** formerly Envoy AI Gateway, it joined the Agentic AI Foundation in September 2026. Its site calls it "powered by Envoy," and version 1.2 is the first release under the new name. Check its documentation for token-based limits and cost tracking in the version you adopt.
- **Buy a managed gateway:** Cloudflare's AI Gateway reports requests, tokens and cost, and offers caching, rate limiting, retries and fallbacks. Cloudflare hosts it, so prompts pass through its network. Check the data terms first.

A rough rule: build when you have one or two providers and a small team. Adopt an open-source proxy with several providers, budgeted teams and people who can run Redis. Buy when the data rules allow it and nobody wants to run a proxy. Either way, keep the interface the apps call stable, so the gateway can change later.

## Check yourself

<details>
<summary>Your key allows 100,000 tokens a minute (assumed). Requests have a 2,000-token prompt and max_tokens of 2,000, and replies average 800 tokens. How many requests a minute does a worst-case reservation admit, and how many does a prompt-only reservation admit? Which is safe?</summary>

A worst-case reservation holds 4,000 tokens, so the key admits 100,000 ÷ 4,000 = 25 requests a minute. A prompt-only reservation admits 50, but each request really uses about 2,800 tokens, so 50 × 2,800 = 140,000 is over the limit. The worst case is the safe one, and settlement returns its unused part.

</details>

<details>
<summary>A provider returns 429 with error type rate_limit_error and no retry-after header. The gateway retries three times with backoff, then fails the request. What went wrong?</summary>

The 429 is probably a spend cap. Anthropic's errors page says a spend-cap 429 has no retry-after header and that retrying fails until access resumes. OpenAI's error page says billing and quota errors are not fixed by retrying. The gateway should recognize the cap, stop sending to that account, alert its owner and fall back.

</details>

<details>
<summary>A streamed answer has already shown 40 tokens when the provider sends an overloaded error event, and a fallback target exists. What are the options, and what does each cost?</summary>

The status is already 200, so it cannot signal the error. The gateway can end the stream with its own error event, which leaves a partial answer. It can restart on the fallback, which repeats text the user already saw. Or it can resume from the partial text, which risks repeating or contradicting it. For structured output such as JSON, ending the stream and letting the client retry is usually safer.

</details>

<details>
<summary>Assume $3.00 per million input tokens, $15.00 per million output tokens, and cache reads at 0.1 times the input price. A request has 1,000 uncached input tokens, 5,000 cache-read tokens and 500 output tokens. What does it cost?</summary>

Uncached input: 1,000 × $3.00 ÷ 1,000,000 = $0.0030. Cache reads: 5,000 × $0.30 ÷ 1,000,000 = $0.0015. Output: 500 × $15.00 ÷ 1,000,000 = $0.0075. Total: $0.0120.

</details>

<details>
<summary>A semantic cache with a threshold of 0.7 sends "I don't want this business account anymore" to the steps for cancelling automatic payments. What happened, and what would you change?</summary>

Embedding similarity measures closeness of wording and topic, not intent, so the two questions cleared the threshold. Tune the threshold on labeled pairs that should and should not match, scope the cache per tenant, and use exact matches alone where a wrong answer is costly.

</details>

## Further reading

- [Rate limits (Claude Platform docs)](https://platform.claude.com/docs/en/api/rate-limits): the token bucket, input and output token limits, and spend-cap 429s, as of October 2026.
- [Prompt caching (Claude Platform docs)](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): breakpoints, lifetimes, minimum lengths, price ratios and workspace isolation.
- [Streaming messages (Claude Platform docs)](https://platform.claude.com/docs/en/build-with-claude/streaming): event order, cumulative usage, ping and error events, and recovery.
- [Errors (Claude Platform docs)](https://platform.claude.com/docs/en/api/errors): which status codes to retry, and the SDK's retry defaults.
- [Rate limits (OpenAI developer docs)](https://developers.openai.com/api/docs/guides/rate-limits): RPM and TPM, and how a request's token count is estimated.
- [Prompt caching (OpenAI developer docs)](https://developers.openai.com/api/docs/guides/prompt-caching): minimum lengths, prefix matching, lifetimes and cache-hit probing.
- [Error codes (OpenAI developer docs)](https://developers.openai.com/api/docs/guides/error-codes): what 429 and 503 mean, and which errors retrying cannot fix.
- [Streaming responses (OpenAI developer docs)](https://developers.openai.com/api/docs/guides/streaming-responses): HTTP streaming over server-sent events.
- [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/online_serving/): the Chat Completions endpoint.
- [LiteLLM routing](https://docs.litellm.ai/docs/routing) and [virtual keys and budgets](https://docs.litellm.ai/docs/proxy/users): routing, fallbacks, cooldowns and budgets.
- [LiteLLM caching](https://docs.litellm.ai/docs/caching/all_caches): cache backends, per-call controls and similarity thresholds.
- [Agent Router](https://theagentrouter.ai/) and [the foundation's announcement](https://aaif.io/blog/agent-router-joins-aaif): the rename and its first release under the new name.
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/): a managed gateway's analytics, caching and fallbacks.
- [Envoy timeouts](https://www.envoyproxy.io/docs/envoy/latest/faq/configuration/timeouts) and [NGINX proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html): timeouts and buffering for streams.
- [OWASP LLM10: Unbounded Consumption (2025)](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/): denial of wallet, meaning runaway spending, and its mitigations.
- [Microsoft Presidio](https://github.com/microsoft/presidio): an open-source, MIT-licensed SDK for finding and anonymizing private data.
- [InfoQ on false positives in retrieval (November 2025)](https://www.infoq.com/articles/reducing-false-positives-retrieval-augmented-generation/): confident wrong matches from similarity search.
