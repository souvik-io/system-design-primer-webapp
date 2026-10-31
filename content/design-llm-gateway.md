# Design an LLM gateway (one API in front of many model providers for a whole company)

A company with 5,000 engineers has about 200 internal apps that call language models: a support bot, a code review assistant, a contract summarizer, nightly classification jobs and many small tools. Every app calls one internal service, the **LLM gateway**, which holds the provider keys, enforces each team's budget, picks a provider for each request and records what it cost. LiteLLM, Portkey and Cloudflare AI Gateway are products of this kind.

The [LLM gateways](/learn/llm-gateways) chapter explains the parts. This chapter applies them to one company with real volumes and makes the decisions an interviewer will probe. The [chat assistant](/learn/design-chat-assistant) is a typical caller of this gateway, and the [inference platform](/learn/design-inference-platform) is a typical self-hosted target behind it.

## Requirements and estimates

Functional requirements:

- **One API**, OpenAI-compatible (the request shape most client libraries already speak), with streaming and tool calls.
- **Several targets:** hosted providers A and B, and a self-hosted pool run by the inference team.
- **Virtual keys:** gateway-issued keys per app, tied to a team and its allowed aliases. Provider keys never leave the gateway.
- **Budgets:** a monthly dollar budget and per-minute token limits per team.
- **Routing:** aliases, weights, retries, fallbacks and canary rollouts of new model versions.
- **Hooks** for redaction and prompt-injection screening, plus audit logs and monthly chargeback.

Non-functional requirements: the gateway adds at most **20 ms at p99** (the value 99% of requests beat) between receiving a request and sending it upstream. It is 99.95% available, since no app can bypass it. No team overspends by more than a few dollars, and every token is charged to exactly one team.

**Traffic.** Assume 21.6 million requests a day, or 21,600,000 ÷ 86,400 s = **250 a second** on average. Working hours and nightly batch windows give a peak factor of 4, so **1,000 a second** at peak. An average request has a 2,500-token prompt and a 300-token reply, so the peak is 2.5 million input and 300,000 output tokens a second. Per day that is 54 billion input and 6.48 billion output tokens.

| Alias | Share | Requests a day | Peak a second | Served by |
|---|---|---|---|---|
| `chat-large` | 15% | 3.24 million | 150 | Provider A (70%), Provider B (30%) |
| `chat-small` | 55% | 11.88 million | 550 | Providers A and B |
| `open-70b` | 30% | 6.48 million | 300 | Self-hosted pool |

**Spend.** Assume `chat-large` costs $3 per million input tokens and $15 per million output tokens, and `chat-small` $0.25 and $1.25. Both prices are assumptions. Assume half of all input tokens are provider prompt-cache reads at 0.1 times the input price, so `chat-large` input averages 0.5 × $3 + 0.5 × $0.30 = $1.65 per million.

- `chat-large` per day: 8.1 billion input × $1.65 + 0.972 billion output × $15 = $13,365 + $14,580 = $27,945, or **$838,350** over 30 days.
- `chat-small` per day: 29.7 billion × $0.1375 + 3.564 billion × $1.25 ≈ $4,084 + $4,455 = $8,539, or about **$256,160** a month.
- `open-70b`: with half of each 2,500-token prompt cached, the [inference platform's](/learn/design-inference-platform#how-many-requests-one-replica-takes) coupled model plans a 70B replica on four H100s at about 5.2 requests a second, so 300 a second needs 58 replicas plus a spare. The inference team bills 236 H100s × $3 × 730 hours = **$516,840** a month.

That is about **$1.61 million a month**, or about $2,200 an hour on average. An average `chat-large` request costs about $0.0086. The worst case, with no cache hits and a reply that runs to the gateway's default cap of 4,096 tokens, is 2,500 × $3 ÷ 10⁶ + 4,096 × $15 ÷ 10⁶ ≈ **$0.069**.

**Instances.** A request lasts about 6 seconds, mostly waiting for tokens, so by [Little's law](/learn/performance-and-latency#littles-law) 1,000 × 6 = **6,000 streams** are open at peak. Assume 1.5 ms of CPU per request for parsing, translation and logging, 10 µs for each of about 300 stream events (3 ms), and 2 ms of redaction on the 30% of traffic that asks for it (0.6 ms on average). That is 5.1 ms, or 5.1 cores at peak for a compiled proxy (a Python proxy can need several times more). At 40% CPU, 5.1 ÷ 0.4 ≈ 12.75 cores, or four 4-vCPU instances. Any two of three availability zones must hold four, so each zone needs two, plus one for rolling deploys: **9 instances**.

**Logs.** A 1 KB metadata row per request is **21.6 GB a day**. Bodies average 2,500 × 4 + 300 × 4 = 11,200 bytes, so logging every body would add about 242 GB a day, or 7.3 TB over 30 days, and the 10% of traffic whose owners opt in adds 24 GB a day.

## API design

Apps call the standard Chat Completions path with a gateway key, so any OpenAI-compatible client works by changing its base URL.

```http
POST /v1/chat/completions HTTP/1.1
Authorization: Bearer vk_search-prod_4f1c...
X-GW-Priority: interactive
X-GW-Data-Class: confidential
Content-Type: application/json

{"model": "chat-large", "stream": true, "max_tokens": 1024,
 "messages": [{"role": "user", "content": "Which plan includes SSO?"}]}
```

`model` is an **alias**, a name the gateway maps to a list of targets, and apps may pin a version such as `chat-large@2026-09`. Batch priority is shed first. The data class (`public`, `internal`, `confidential` or `restricted`) decides which targets are allowed and whether redaction runs. The response names the target in `X-GW-Target`, and the final stream chunk adds the cost in dollars.

| Status and type | Meaning | Retry? |
|---|---|---|
| 400 `unsupported_for_alias` | No target supports a requested feature | No |
| 429 `rate_limited` with `Retry-After` | The team's per-minute limit | After the wait |
| 429 `budget_exhausted`, no `Retry-After` | The monthly budget is spent | No |
| 503 `no_capacity` with `Retry-After` | Every target is failing or cooling down | Once |

The two 429s copy the providers' convention: a spend-cap 429 has no `Retry-After` (see [routing and fallbacks](/learn/llm-gateways#routing-and-fallbacks)), so a well-behaved client stops by itself. Keys, budgets and routes change through an admin API, and each change goes to the audit log with its author.

## High-level design

```diagram
title: Every app calls the gateway, and only the gateway holds provider keys
[apps:client] 200 internal\napps @ 0,1
[lb] Internal L4\nload balancer @ 1,1
[gw] Gateway\n9 instances\nin 3 zones @ 2,1
[gd] Guard service\nscreening @ 2,0
[pa:client] Provider A\nhosted @ 4,0
[pb:client] Provider B\nhosted @ 4,1
[sh:store] Self-hosted\n70B pool @ 4,2
[rd:store] Redis\ncounters, cache @ 0,2.5
[cp] Control plane\nkeys, routes,\nbudgets @ 2,2.5
[log:queue] Usage and\naudit log @ 4,3.5
apps -> lb : HTTPS, SSE
lb -> gw
gw <-> gd
gw -> pa
gw -> pb
gw -> sh
gw <-> rd : sync every 500 ms
cp --> gw
gw --> log : a row per request
```

1. A layer-4 load balancer (one that forwards TCP connections without reading HTTP) spreads connections by least connections, since streams last seconds.
2. The instance looks up the hashed virtual key locally, checks alias, data class and region rules, places a budget hold and checks the exact-match cache if the app opted in.
3. It picks a target, translates the request and sends it on a pooled TLS connection, with screening running alongside.
4. It relays the stream, settles the hold with the provider's token counts and writes one usage row.

Instances serve from a versioned snapshot of keys, routes and prices that the control plane pushes, so a control-plane outage only freezes configuration.

## The request path and where time goes

Provider time to first token (TTFT, the wait before the first token) is usually hundreds of milliseconds, but every app pays the gateway's share on every call, so each step gets a budget. The figures are assumptions to replace with measurements.

| Step | p99 budget |
|---|---|
| App to gateway, same region, reused HTTP/2 connection | 1.0 ms |
| Key lookup, alias, data class and region checks | 0.2 ms |
| Parse and validate the JSON body | 1.0 ms |
| Budget hold and limits on local counters | 0.2 ms |
| Exact-cache lookup in Redis (opted-in apps) | 1.5 ms |
| Regex redaction (opted-in apps) | 2.0 ms |
| Translate to the provider's format | 1.0 ms |
| Queue the usage row (asynchronous) | 0.5 ms |
| **Total** | **7.4 ms** |

Summing p99s overstates the combined p99, and the headroom covers pauses and very large prompts. Provider connections stay pooled, since a fresh TLS handshake to a distant provider costs tens of milliseconds.

```diagram
title: Screening runs beside the provider call and gates the first token
[app:client] App request @ 0,0
[auth] Key, alias,\ndata class @ 1,0
[adm] Budget hold,\nlimits @ 2,0
[rt] Route and\ntranslate @ 3,0
[pv:client] Provider @ 4,0
[gd] Injection\nscreen @ 2,1.5
[rel] Relay holds\nfirst token @ 4,1.5
[out:client] App sees\nfirst token @ 4,3
[led:store] Settle and\nlog usage @ 2,3
app -> auth
auth -> adm
adm -> rt
rt -> pv
rt --> gd : prompt copy
pv -> rel : tokens
gd -> rel : verdict
rel -> out
rel --> led : at stream end
```

An injection classifier does not fit the table: assume it takes 25 ms at p99. The gateway starts it alongside the provider call, and the relay holds back the first token until the verdict. TTFT almost always exceeds 25 ms, so users see no extra wait. A flagged request is cancelled before any output reaches the app, costing only its input tokens at an assumed flag rate of 0.3%. A classifier is one layer among several ([prompt injection](/learn/ai-security#prompt-injection)).

## Budgets across many instances

Take the search team: $20,000 a month on `chat-large`, with its key capped at 50 requests a second across nine instances. A Redis round trip per request would make Redis a dependency of every call, so each instance counts locally.

```diagram
title: Instances count locally and push changes every 500 ms
[g1] Gateway\nzone a @ 0,0
[g2] Gateway\nzone b @ 0,1
[g3] Gateway\nzone c @ 0,2
[rd:store] Redis\nteam totals @ 2,1
[led:store] Ledger\nsettled cost @ 4,1
g1 <-> rd : +pending, total
g2 <-> rd
g3 <-> rd
led --> rd : nightly true-up
```

Each instance keeps a **pending** amount: holds it has placed plus settlement adjustments since its last sync. Every 500 ms it adds pending to the shared total in Redis and reads back the new total in the same call. A hold is the worst case, and settlement returns the unused part, as in [token-based rate limits](/learn/llm-gateways#token-based-rate-limits).

```python
class TeamBudget:
    """One instance's view of a team's monthly budget, in dollars."""

    def __init__(self, store: dict, team: str, limit: float):
        self.store, self.team, self.limit = store, team, limit
        self.seen = store.get(team, 0.0)   # shared total at the last sync
        self.pending = 0.0                 # holds and settlements not yet pushed

    def reserve(self, worst: float) -> bool:
        if self.seen + self.pending + worst > self.limit:
            return False                   # 429 budget_exhausted
        self.pending += worst
        return True

    def settle(self, worst: float, actual: float) -> None:
        self.pending += actual - worst     # give back the unused part

    def sync(self) -> None:                # Redis: one INCRBYFLOAT returns the total
        self.store[self.team] = self.store.get(self.team, 0.0) + self.pending
        self.seen, self.pending = self.store[self.team], 0.0


store = {"search": 19_999.90}              # 10 cents left of $20,000
a, b = TeamBudget(store, "search", 20_000), TeamBudget(store, "search", 20_000)
print(a.reserve(0.069), b.reserve(0.069))  # True True: neither sees the other
print(a.reserve(0.069))                    # False: a's own hold counts
a.settle(0.069, 0.069); b.settle(0.069, 0.069)
a.sync(); b.sync()
print(round(store["search"] - 20_000, 3))  # 0.038: the overshoot
```

The overshoot has a ceiling. In one 500 ms interval, all instances together admit at most 50 × 0.5 = 25 requests the others cannot see. At the worst case of $0.069 each that is 25 × $0.069 ≈ **$1.72**, about 0.009% of the budget, and at the average of $0.0086 it is about $0.22.

Syncing holds along with settled spend keeps that window short. If only settled spend were synced, each request would stay invisible for its whole 5-second stream plus the interval, and the bound would grow to 50 × 5.5 = 275 requests × $0.069 ≈ $19.

Per-minute token limits use the same counters, reset each minute. When a provider quota is crossed, instances may admit for up to 500 ms more, and the provider answers the excess with 429s that the router handles. The [distributed counters](/learn/rate-limiting#distributed-counters-in-redis) section covers the atomic Redis operations. Each night the ledger recomputes month-to-date spend and corrects the Redis totals, so a lost sync drifts for at most a day.

## Routing, retries and fallbacks

Each alias lists targets with a weight, features (tools, JSON schema output, context length), a data-class ceiling and a region. The router drops targets that cannot serve the request or are cooling down, then chooses by weight.

Weighted random choice scatters an app's requests across providers, each with its own prompt cache. Assume an app sends a request every 4 minutes with the same 6,000-token system prompt to providers whose caches last 5 minutes and charge 1.25 times the input price to write. On one provider nearly every request hits, at 6,000 × $0.30 ÷ 10⁶ = $0.0018. Split 50/50, each provider sees the app every 8 minutes, so most requests miss and pay a write: 6,000 × $3.75 ÷ 10⁶ = $0.0225, 12.5 times as much.

The router therefore uses **weighted rendezvous hashing**: each target scores a hash of the app's key and the target's name, scaled by its weight (score = −weight ÷ ln(hash), with the hash mapped into (0, 1)), and the highest score wins. The same app always lands on the same target, traffic still splits by weight across apps (6,947 of 10,000 test keys chose a target weighted 70 against 30), and when a target cools down only its own apps move. The sticky key is the app plus a hash of its system prompt, and a hot key spills past a capped share to its next-best target.

**Health.** A 429 with `Retry-After: 60` cools that target (provider, model and key) down for 60 seconds, shared through Redis so all instances stop within one sync. A [circuit breaker](/learn/reliability-patterns#circuit-breakers) opens when 50% of at least 20 requests in 10 seconds fail, and lets probes through after 30 seconds. A spend-cap 429 takes the target out until a person clears it.

**Retry storms.** Provider A carries 70% of `chat-large` at peak, about 105 requests a second. If it fails and both the app's SDK and the gateway make three attempts, A receives up to 105 × 3 × 3 = 945 requests a second. Apps therefore disable SDK retries, leaving one retry layer ([retry storms and retry budgets](/learn/reliability-patterns#retry-storms-and-retry-budgets)), and each target gets a **retry budget**:

```python
class RetryBudget:
    """Allow retries worth `ratio` of first attempts, plus a small burst."""

    def __init__(self, ratio=0.1, burst=10):
        self.ratio, self.burst, self.tokens = ratio, burst, burst

    def first_attempt(self):
        self.tokens = min(self.burst, self.tokens + self.ratio)

    def may_retry(self):
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


budget, calls = RetryBudget(), 0
for _ in range(1_000):                     # the target fails every call
    budget.first_attempt()
    calls += 1
    for _ in range(2):                     # up to two retries each
        if not budget.may_retry():
            break
        calls += 1
print(calls)                               # 1109, against 3,000 without a budget
```

A request that may not retry goes straight to its fallback.

**Fallback capacity.** At peak, `chat-large` sends 150 × 2,500 × 60 = 22.5 million input tokens a minute. If the company's quota at Provider B is 8 million a minute (assumed), B can absorb 8,000,000 ÷ (2,500 × 60) ≈ 53 requests a second, about 36% of the alias. If a third of `chat-large` is interactive (50 a second), B can take all of it during an outage at A, while batch waits. Ramp the shift over a minute or two, since Anthropic warns that sharp usage increases can trigger acceleration limits.

## Streaming and failover

A streamed reply's status and headers go out once, before the first event, and the gateway delays them until the provider's first content event. The user sees nothing before the first token either way, so this costs nothing, and every failure before that point stays retryable on another target: 429s, 529 overloads, connection errors and stalled prefills. A **first-token deadline** catches stalls. Prefill grows with prompt length, so for `chat-large` assume 4 seconds plus 50 ms per 1,000 prompt tokens (about 4.1 seconds for 2,500 tokens, 9 seconds for 100,000), set above each target's measured p99.9.

After tokens have reached the app, a second provider would start the answer over while the user has read part of the first. The gateway ends the stream with an error event and closes it without the final `data: [DONE]` line, so clients can tell the reply is incomplete. Resuming from the partial text is possible (see [streaming through a gateway](/learn/llm-gateways#streaming-through-a-gateway)), but that choice belongs to apps that can tolerate a seam.

OpenAI-style streams report usage only in a final chunk, and only when `stream_options.include_usage` is set, so the gateway always sets it. If a stream breaks before that chunk, the gateway estimates output from the relayed text and marks the row for the daily reconciliation against the provider's usage export.

## Adapters: what differs between providers

The adapter layer translates requests and responses for each provider. Most of the work sits in a few differences:

- **System prompt and limits.** OpenAI puts the system prompt in the message list. Anthropic's Messages API takes a top-level `system` field and requires `max_tokens`, so the gateway sets a default of 4,096 per alias, which also bounds the budget hold.
- **Tool calls.** OpenAI returns `tool_calls` whose arguments are a JSON string. Anthropic returns `tool_use` blocks whose `input` is an object and expects `tool_result` blocks back. Both stream arguments as partial JSON, so the adapter assembles fragments per call. It keeps tool call IDs as opaque strings, since a conversation may switch provider between turns.
- **Tokenizers.** The same text gives different token counts on different models, so budgets are kept in dollars and per-minute limits in each target's own tokens.
- **Prompt caching.** OpenAI caches long prefixes automatically. Anthropic caches at `cache_control` breakpoints and charges to write, so the adapter marks one after long, stable system prompts. The gateway never inserts per-request text ahead of an app's prompt, since that breaks every prefix match.
- **Usage fields.** OpenAI's `prompt_tokens` includes cached tokens. Anthropic's `input_tokens` excludes cache reads and writes, which arrive in separate fields.

```python
def normalize(provider: str, u: dict) -> dict:
    """Map a provider's usage block to the ledger's four token kinds."""
    if provider == "openai":               # prompt_tokens includes cached tokens
        cached = u.get("prompt_tokens_details", {}).get("cached_tokens", 0)
        return {"uncached_in": u["prompt_tokens"] - cached, "cache_read": cached,
                "cache_write": 0, "out": u["completion_tokens"]}
    if provider == "anthropic":            # input_tokens excludes cache reads and writes
        return {"uncached_in": u["input_tokens"],
                "cache_read": u.get("cache_read_input_tokens", 0),
                "cache_write": u.get("cache_creation_input_tokens", 0),
                "out": u["output_tokens"]}
    raise ValueError(f"no adapter for {provider}")


print(normalize("openai", {"prompt_tokens": 2500, "completion_tokens": 300,
                           "prompt_tokens_details": {"cached_tokens": 1500}}))
print(normalize("anthropic", {"input_tokens": 1000, "cache_read_input_tokens": 1500,
                              "output_tokens": 300}))
# Both: {'uncached_in': 1000, 'cache_read': 1500, 'cache_write': 0, 'out': 300}
```

Reading Anthropic's `input_tokens` as the whole prompt would record 1,000 tokens for a 2,500-token prompt. Each adapter has contract tests on recorded responses and a nightly live test. Provider-only features go in a `provider_options` field, which pins the request to that provider and disables fallback.

## Caching

**Provider prompt caches** are the biggest lever, and the gateway helps by keeping prefixes stable and routing sticky. On `chat-large`, raising the hit rate from 20% to 50% of input tokens cuts daily input cost from 8,100 × (0.8 × $3 + 0.2 × $0.30) = $19,926 to $13,365, a saving of $6,561 a day, or about **$197,000 a month**.

**An exact-match cache** in the gateway is opt-in per app, with a TTL (time to live). Its key includes the team, the app, the resolved model version and every field that can change the reply (see [caching responses](/learn/llm-gateways#caching-responses)), so an old version's answers are never served after a rollout. Assume 8% of requests opt in (eval reruns, repeated classifications) and 40% of those hit, so 3.2% of requests come from Redis. A day of entries is about 1.73 million replies of 1.5 KB, or 2.6 GB.

**A semantic cache**, which matches questions by meaning, can return a confident answer to a different question. It is off by default, allowed only on narrow FAQ routes with a threshold tuned on labeled pairs, scoped to one app and never for personal data, since shared caches leak ([logs, traces and caches](/learn/ai-security#logs-traces-and-caches)).

## Aliases and safe rollouts

A new version behind `chat-large` must pass every registered team's eval set ([running evals before release](/learn/ai-evals-and-observability#running-evals-before-release)). It then takes 1% of traffic, sticky by conversation so one conversation never switches models between turns. At an average of 37.5 `chat-large` requests a second, 1% is 32,400 requests a day. If the error rate rose from 0.5% to 1%, the day would show 324 errors instead of 162, a clear signal. Traffic then moves to 5%, 25% and 100%, a day per step, comparing errors, refusals, output length (which drives cost), TTFT and sampled quality scores. Rollback is a route change.

## Security, residency and logging

**Keys.** Provider keys live in a secrets manager (see [secrets management](/learn/security#secrets-management)) and are never logged, with one provider workspace per business unit to limit what a leak exposes. Virtual keys are stored as SHA-256 hashes with an owner and an expiry, and one config push revokes them.

**Data classes and regions** are hard filters applied before weights. `restricted` goes only to the self-hosted pool. `confidential` goes only to targets under a zero-data-retention agreement, in which the provider keeps no copy after answering; check which endpoints and features each agreement covers. EU apps use only EU endpoints, and fallbacks never cross regions, so an outage returns 503 instead of sending data abroad.

**Redaction** protects personal data and can weaken answers: a model drafting a reply to `<PERSON_1>` writes a worse email than one that knows the name. The gateway uses reversible placeholders, keeps the mapping in memory for the request and restores names in the reply. A placeholder can arrive split across two stream events, so the relay holds back the last 16 characters until it knows they are not the start of one. Detectors miss some items and flag others, so redaction is opt-in.

**Logging.** Metadata is always logged. Bodies are off by default; when an owner turns them on, they are redacted, encrypted and kept 30 days, and every read is audited, following [content and privacy](/learn/ai-evals-and-observability#content-and-privacy).

## Keeping the gateway up

Every app depends on the gateway, so instances are stateless and span three zones, sized so two zones carry peak. Interactive and batch traffic run in separate deployments, so a batch flood or a bad batch config cannot touch customer-facing apps, the [bulkhead](/learn/reliability-patterns#bulkheads) pattern. A route change goes to one instance, then one zone, then all, and rolls back if errors rise. Replies are capped at 4,096 tokens, about 137 seconds at 30 tokens a second, so a deploy drains each instance for 180 seconds.

**Redis outage.** Instances cannot sync budgets. They can **fail closed**, rejecting what they cannot verify, or **fail open**, admitting anyway. Failing closed for half an hour stops 200 apps to prevent at most about $1,100 of extra spend. The gateway fails open with local caps: each instance lets each team spend at most twice its trailing-hour rate divided by the number of instances. Over 30 minutes the company spends at most 2 × $2,200 × 0.5 = $2,200, half of it ordinary traffic. Keys marked as hard caps fail closed. When Redis returns, instances push their local totals before admitting more.

## Observability and chargeback

The dashboard shows **gateway overhead** as its own histogram, alerting at 15 ms p99 before the 20 ms target is breached. Per target it shows error classes, TTFT, time per output token and breaker state. Per team it shows spend against budget (alerts at 50%, 80% and 100%, plus a burn-rate alert) and cache hit rates. Each request is one trace using the [GenAI attributes](/learn/ai-evals-and-observability#the-genai-attributes).

**Chargeback** comes from the ledger, one row per request with tokens by kind, team, target and `price_version` ([tracking cost](/learn/llm-gateways#tracking-cost)). Hosted requests are charged at provider prices. The self-hosted pool has a fixed cost, so it gets an internal price each quarter. It serves 194.4 million requests a month: 486 billion input and 58.32 billion output tokens. Weighting an output token as five input tokens, like the hosted prices, gives 486 + 5 × 58.32 = 777.6 billion units, so $516,840 works out to about $0.66 per million input tokens and $3.32 per million output tokens.

## Trade-offs to discuss

- **Build, run open source or buy.** LiteLLM covers most of this design, with some features behind its enterprise license. A managed gateway removes operations work and sends prompts through another company's network ([build or buy](/learn/llm-gateways#build-or-buy)).
- **Local counters or a central check.** Local counters keep Redis off the request path, at about $1.72 of overshoot per team per interval. A central check is exact and adds a dependency to every call.
- **Sticky or random routing.** Stickiness keeps prompt caches warm, worth about $197,000 a month here. Random routing balances load more evenly.
- **Parallel or serial screening.** Parallel hides the classifier's latency and pays for flagged prompts. Serial adds its latency to every call.

## Check yourself

<details>
<summary>Nine instances enforce a $20,000 budget, sync every 500 ms and hold $0.069 per request, and the team's key is capped at 50 requests a second. How far can the team overshoot? What if instances synced only settled spend?</summary>

In one interval the instances admit at most 50 × 0.5 = 25 requests the others cannot see, so at most 25 × $0.069 ≈ $1.72. Syncing only settled spend hides each request for its 5-second stream too, so the bound becomes 275 × $0.069 ≈ $19.

</details>

<details>
<summary>Provider A carries 105 requests a second and fails every call. App SDKs and the gateway each make three attempts. How much traffic reaches A, and what is the fix?</summary>

Up to 105 × 3 × 3 = 945 requests a second, nine times normal. Make the gateway the only retry layer and cap its retries at about 10% of first attempts. Then 1,000 failing requests cause about 1,109 calls instead of 3,000, and the rest go to the fallback.

</details>

<details>
<summary>A stream has sent 40 tokens when Provider A returns an overload error. Provider B is healthy. Should the gateway switch?</summary>

Not silently, because B would start the answer over. The gateway ends the stream with an error event and no `[DONE]` line, and the app decides. Failures before the first token are different: the gateway delays headers until the first content event, so those requests move to B unseen.

</details>

<details>
<summary>Redis is down for 30 minutes. What happens to budget checks?</summary>

Ordinary keys fail open with local caps of twice each team's trailing-hour rate divided by the instance count, so the company spends at most about $2,200 in that half hour, half of it normal traffic. Hard-cap keys fail closed.

</details>

<details>
<summary>The ledger shows Provider B's input tokens about 60% below the team's estimates, only for requests with long system prompts. What is a likely cause?</summary>

The adapter reads Anthropic-style `input_tokens` as the whole prompt, but that field excludes cache reads and writes, so a 2,500-token prompt with 1,500 cached tokens records 1,000. Normalize usage into the four token kinds and test on recorded responses.

</details>

## Further reading

- [LiteLLM routing](https://docs.litellm.ai/docs/routing) and [virtual keys and budgets](https://docs.litellm.ai/docs/proxy/users): fallbacks, cooldowns, keys and budgets.
- [Agent Router](https://theagentrouter.ai/): the Envoy-based gateway formerly called Envoy AI Gateway.
- [Rate limits](https://platform.claude.com/docs/en/api/rate-limits), [errors](https://platform.claude.com/docs/en/api/errors) and [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (Claude Platform docs): token and acceleration limits, 429 and 529, cache usage fields.
- [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits) and [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) (OpenAI developer docs): RPM, TPM and automatic prefix caching.
- [Google SRE book, Handling Overload](https://sre.google/sre-book/handling-overload/) and [Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/): retry budgets and load shedding.
- [AWS Builders' Library, Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/): how retries amplify load.
- [Microsoft Presidio](https://github.com/microsoft/presidio): open-source detection and anonymization of personal data.
- [OWASP LLM10: Unbounded Consumption (2025)](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/): runaway spending and its limits.
