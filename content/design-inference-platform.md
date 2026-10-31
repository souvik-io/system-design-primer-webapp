# Design a model inference platform (serve many LLMs to many customers)

A model inference platform takes requests for language models and returns their replies. Customers name a model in one API call, and the platform decides which GPUs run it. Hosted services such as Together AI, Fireworks and Amazon Bedrock sell this to outside developers, and an internal platform team can run the same system for its own products. The question combines the GPU arithmetic from the AI chapters with the distributed-systems problems the rest of the handbook covers.

It builds on [how LLM inference works](/learn/llm-inference), [inference engines](/learn/inference-engines), [running inference at scale](/learn/inference-fleets) and [estimating AI workloads](/learn/ai-estimation). The [LLM gateways](/learn/llm-gateways) chapter is the other side of this design. There a company calls many providers, and here the company is the provider.

## Requirements and estimates

### Scope

- **Functional:** an OpenAI-compatible chat and completions API with streaming, about 45 base models from 8B to 405B parameters, and customer LoRA adapters (small fine-tuned weight changes on a shared base). Per-tenant keys with quotas, priority and standard tiers, a batch API at a lower price, and billing on input, cached and output tokens.
- **Non-functional:** at peak, p99 time to first token (TTFT) of 2 seconds or less for priority traffic, and at least 25 tokens a second per user (time per output token, TPOT, of 40 ms or less). 99.9% availability a month. Batch jobs finish within 24 hours. No tenant starves another, and every served token is billed once.
- **Out of scope:** fine-tuning, image and audio models, and the customer console.

### Traffic

These numbers are invented. Peak load is 600 requests a second against an average of 200, a peak factor of 3. At peak, 75% of requests go to 8B models (450 a second), 20% to 70B (120) and 5% to 405B (30). An average request has a 1,700-token prompt and a 300-token reply.

### Per-replica numbers

A replica is one copy of a model on its own GPUs. The running example is Llama 3.1 70B in BF16 on four H100s:

- The weights take 140 GB. Of the 320 GB installed, 90% (288 GB) is usable, which leaves 288 − 140 = 148 GB for the KV cache (the stored keys and values of earlier tokens). A cached token takes 327,680 bytes, so the cache holds 148 × 10^9 ÷ 327,680 ≈ 451,660 tokens, or 110 requests of 4,096 tokens.
- One stream decodes, producing one token per pass, at 140 GB ÷ 13.4 TB/s ≈ 10.4 ms per token, about 96 tokens a second.
- With 64 streams of 2,000 tokens, a step reads 140 GB plus 64 × 2,000 × 327,680 bytes ≈ 41.9 GB, or 181.9 GB in all. That takes 13.6 ms, so the replica makes about 4,700 tokens a second, about 74 per user.
- A 2,000-token prompt is 280 TFLOP. At 50% of the four GPUs' dense BF16 peak (3,956 TFLOPS), it takes about 142 ms.

These are ceilings for one stream and one step. Prefill, the single pass over a new prompt, takes time from decode, which the next estimate accounts for.

### How many requests one replica takes

For λ (lambda) requests a second, the coupled model from [estimating AI workloads](/learn/ai-estimation#how-many-gpus) gives:

```text
prefill share      p = λ × 1,700 × 70.8 µs
output tokens/s    D = λ × 300
decode batch       B = D × 140 ÷ ((1 − p) × 13,400 − D × 0.655)
step time          s = (140 + B × 0.655) ÷ 13,400 seconds
tokens/s per user  u = (1 − p) ÷ s
```

The constants are the prefill cost per prompt token at 50% of peak, the group's bandwidth in GB/s, and one 2,000-token sequence's cache (0.655 GB). The batch is continuous, so a finished sequence leaves and a new one joins at the next step, as [continuous batching](/learn/inference-engines#continuous-batching) describes. At λ = 4.1, prefill takes 49% of the time, the batch is about 29 sequences, and each user gets about 43 tokens a second.

| Requests a second | Prefill share | Output tokens a second | Decode batch | Tokens a second per user |
|---|---|---|---|---|
| 2.0 | 24% | 600 | 9 | 70 |
| 4.1 | 49% | 1,230 | 29 | 43 |
| 5.47, the breaking point | 66% | 1,641 | 66 | 25 |

At the breaking point, prefill takes two-thirds of the time, so each user gets 25 tokens a second instead of 74. Plan each replica at 75% of its breaking rate, about 4.1 requests a second, which leaves room for bursts and one failure. At peak, 120 ÷ 4.1 = 29.3, so the pool needs 30 replicas, plus one spare (124 GPUs). If one fails, the other 30 each take 4.0 requests a second, still within plan. Mean TTFT is about 190 ms: 58 ms of queue, 120 ms of prefill and 12 ms for the first decode step.

### Prefix reuse

Assume 40% of prompt tokens are platform boilerplate, such as the chat template and tool schemas, which any replica can cache. Assume 15% are a customer's own repeated prefix, which is cached only where that tenant's earlier requests landed.

| Routing | Prompt tokens from cache | Planned rate per replica | Replicas for 120 a second |
|---|---|---|---|
| No prefix cache | 0% | 4.1 | 30 |
| Boilerplate hits on any replica | 40% | 6.4 | 19 |
| Boilerplate plus tenant affinity | 55% | 8.1 | 15 |

Cached tokens leave the time budget, so the breaking rate rises to 8.5 and then 10.7 requests a second. The full cache saves 15 replicas, or 60 GPUs, about $131,000 a month at $3 an hour per GPU.

## API and data plane split

### The API

Synchronous calls follow the OpenAI shape, so client libraries work with a new base URL.

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat/completions` | Chat. `"stream": true` returns server-sent events. |
| `POST /v1/completions` | A raw prompt. |
| `GET /v1/models` | The base models and adapters this key may call. |
| `POST /v1/files`, `POST /v1/batches`, `GET /v1/batches/{id}` | Batch input, job creation and status. |

Chat requests add one field, `service_tier` (`priority` or `standard`). Batch jobs have no tier, because they always run on idle capacity.

```json
{
  "model": "my-org/support-v3",
  "messages": [{"role": "user", "content": "Where is my order?"}],
  "max_tokens": 300,
  "stream": true,
  "service_tier": "priority"
}
```

`my-org/support-v3` is a LoRA adapter on the 8B base. Every response carries an `x-request-id` that appears in logs, usage events and support tickets. Errors are 400 (invalid input, or prompt plus `max_tokens` over the window), 401 and 404 (bad key, or a model this key cannot see), 429 (budget spent) and 503 (the tier's latency target cannot be met now). Both 429 and 503 carry `Retry-After`.

### Control plane and data plane

- **The data plane** is the gateway, the router and the replicas. It serves every request, so it stays fast and never calls a database on the request path. Keys, quotas and routes live in local caches refreshed every 30 seconds.
- **The control plane** holds tenants, keys, plans, the catalog, reservations, deployments and autoscaler targets. Writes are rare.

If the control plane goes down, the data plane keeps serving from its last configuration, and only new keys and plan changes wait.

## High-level design

```diagram
title: Data plane serves requests. Control plane configures it and sizes the fleet.
[c:client] Customers @ 0,1
[gw] Gateway\nkeys, budgets @ 1,1
[rt] Router\nprefix-aware @ 2,1
[pools:box] Replica pools\n8B, 70B, 405B @ 3,1
[use:queue] Usage log\nat least once @ 4,1
[led:store] Ledger and\ninvoices @ 4,2.5
[as] Autoscaler\nqueue, KV, TTFT @ 3,3.5
[cp:box] Control plane\ncatalog, keys\nand plans @ 1,3.5
c <-> gw : HTTPS, SSE
gw -> rt : admitted
rt -> pools : by model
pools --> use : usage
use --> led : dedupe
as --> pools : scale
cp --> gw : config
cp --> as : limits
```

A request moves through five steps:

1. The gateway checks the key in its cache and reserves the prompt length plus `max_tokens` from the tenant's budget, as the [LLM gateway chapter](/learn/llm-gateways#token-based-rate-limits) describes. If the budget is spent, it returns 429.
2. It maps the model to a pool and the tier to a queue class.
3. The router predicts each replica's time to first token and picks one.
4. The replica decodes, and the gateway forwards each event as it arrives.
5. When the stream ends, the gateway settles the budget and writes one usage event. The event follows the reply, so it never adds to TTFT.

## Routing requests

### Model to pool

A control-plane table maps model names to pools. Aliases such as `llama-70b-latest` point at the current pool, so an upgrade changes one row. Unknown names get a 404 before any queue is touched.

### Choosing a replica

Least connections is weak here, because two requests can differ in prefill cost by a factor of 40. The router predicts the time to first token instead: the work queued ahead, plus this request's uncached prefill. Least-loaded breaks ties.

```python
from dataclasses import dataclass, field

BLOCK = 16                        # tokens per prefix-cache block
PREFILL_MS_PER_TOKEN = 0.0708     # 70B on 4 H100s at 50% of peak: 70.8 microseconds
EVICT_PENALTY_MS = 500            # tunable cost of a replica that must preempt someone


@dataclass
class Replica:
    name: str
    queued_prompt_tokens: int     # prompt tokens waiting ahead of a new request
    free_kv_tokens: int           # cache room left, in tokens
    prefix_blocks: set = field(default_factory=set)  # hashes of cached prefix blocks


@dataclass
class Request:
    prompt_tokens: int
    max_tokens: int
    block_hashes: list            # hash of each full block of the prompt, in order


def leading_hit_tokens(r: Replica, req: Request) -> int:
    """Tokens at the start of the prompt that r already caches. Stops at the first miss."""
    hits = 0
    for h in req.block_hashes:
        if h not in r.prefix_blocks:
            break
        hits += BLOCK
    return hits


def predicted_ttft_ms(r: Replica, req: Request) -> float:
    uncached = req.prompt_tokens - leading_hit_tokens(r, req)
    wait = r.queued_prompt_tokens * PREFILL_MS_PER_TOKEN
    compute = uncached * PREFILL_MS_PER_TOKEN
    fits = r.free_kv_tokens >= req.prompt_tokens + req.max_tokens
    return wait + compute + (0 if fits else EVICT_PENALTY_MS)


def route(replicas, req: Request) -> Replica:
    return min(replicas, key=lambda r: predicted_ttft_ms(r, req))
```

Take a 1,700-token prompt with 106 full blocks. Replica `a` holds 93 of them and has 500 prompt tokens queued, so it scores about 50 ms. Replica `b` is empty and scores 120 ms, so `a` wins. If `a` has 3,000 tokens queued, it scores 227 ms, and `b` wins. The score counts queued prompt tokens, since prefill time scales with prompt length: twenty queued 200-token prompts (4,000 tokens, about 283 ms of prefill) are far less work than two queued 8,000-token prompts (about 1.13 seconds).

### Affinity and isolation

A multi-turn chat resends its history each turn, so the replica that served the last turn holds most of the prompt. Hash each conversation ID onto a ring of replicas to send the next turn there. Hash only customer prefixes: boilerplate is in nearly every request, and hashing it would overload one replica, the hot-key problem from the [consistent hashing chapter](/learn/consistent-hashing#hot-keys).

A cache hit answers faster than a miss, so timing can reveal that someone recently sent a prefix, as the [LLM gateway chapter](/learn/llm-gateways#caching-responses) notes. The platform therefore salts customer prefixes with the tenant ID, as vLLM's `cache_salt` option does, and shares only boilerplate. For the wider risk, see [security for AI systems](/learn/ai-security#leaking-data).

## Admission control and fairness

### Budgets and shedding

Each tenant has a token bucket per model class, a budget that refills at a steady rate in tokens a minute, plus a cap on concurrent streams. Budgets are per class because a 405B token costs about 50 times the GPU time of an 8B token. The [rate limiting chapter](/learn/rate-limiting#token-bucket) covers the bucket itself.

At 70.8 µs per prompt token, the 2-second TTFT target allows about 28,000 queued prompt tokens per replica, or 16 prompts of 1,700 tokens. A request that joins behind more than that misses its target before its own prefill starts. The gateway rejects it at once with a 503 and `Retry-After`, and the rejected request uses no GPU time. Requests that wait past their deadline are dropped, since the client has probably gone. Batch requests never get a 503 for this reason.

A 128K-token prompt fills 42.9 GB, which is 29% of a 70B replica's cache, and its 9.3-second prefill holds up everything behind it. The priority tier therefore caps prompts at 32,000 tokens, and longer prompts use [chunked prefill](/learn/inference-engines#chunked-prefill) on the standard tier.

### Priority and fairness

Priority requests run ahead of standard ones. Within a tier, start-time fair queuing orders requests by a virtual start time, so a burst waits behind other tenants' smaller requests. Each tenant also holds at most 40% of a replica's decode batch.

```python
import heapq
import itertools


class FairQueue:
    """Start-time fair queuing across tenants: order by virtual start time."""

    def __init__(self):
        self.heap = []
        self.clock = 0.0                  # virtual time: start tag of the last dispatch
        self.last_finish = {}             # tenant -> finish tag of its newest request
        self.order = itertools.count()    # ties keep arrival order

    def push(self, tenant, weight, tokens, request):
        start = max(self.clock, self.last_finish.get(tenant, 0.0))
        self.last_finish[tenant] = start + tokens / weight
        heapq.heappush(self.heap, (start, next(self.order), request))

    def pop(self):
        start, _, request = heapq.heappop(self.heap)
        self.clock = start
        return request


q = FairQueue()
for i in range(3):
    q.push("tenant-A", 1, 4000, f"A{i + 1} (4,000 tokens)")   # a burst of big requests
for i in range(3):
    q.push("tenant-B", 1, 500, f"B{i + 1} (500 tokens)")      # small requests, same weight
print([q.pop() for _ in range(6)])
```

```text
['A1 (4,000 tokens)', 'B1 (500 tokens)', 'B2 (500 tokens)', 'B3 (500 tokens)', 'A2 (4,000 tokens)', 'A3 (4,000 tokens)']
```

Tenant A's first request goes first, but its second waits until all three of tenant B's small requests are served.

## Placing models on GPUs

Memory sets the minimum GPU count, with about 10% kept back for activations. An 8B model (16 GB of weights) fits one H100 with 56 GB left for cache. A 70B model needs four H100s, because two leave only 4 GB. With FP8 (8-bit) weights, 70B weights take 70 GB and fit two H100s, but only after a quality eval, as the [number formats section](/learn/gpus-for-ai#number-formats-and-quantization) explains. A 405B model (810 GB) exceeds one 8-GPU node (640 GB), so it takes 16 GPUs across two nodes, with tensor parallelism (each layer's matrices split across GPUs) inside each node and pipeline parallelism (each GPU holds a run of layers) between them.

| Pool | GPUs per replica | Planned rate per replica | Tokens a second per user | Replicas at peak | GPUs at peak |
|---|---|---|---|---|---|
| 8B | 1 H100 | 8.4 | 71 | 450 ÷ 8.4 → 54 | 54 |
| 70B | 4 H100 | 4.1 | 43 | 120 ÷ 4.1 → 30 | 120 |
| 405B | 16 H100, two nodes | 2.6 | 35 | 30 ÷ 2.6 → 12 | 192 |

A 405B request uses about 52 times the GPU time of an 8B request (16 ÷ 2.6 ≈ 6.2 GPU-seconds, against 1 ÷ 8.4 ≈ 0.12). One spare replica per pool brings the peak fleet to 387 GPUs, which costs 387 × $3 × 730 = $847,530 a month if it runs all month. Demand averages a third of peak, so autoscaling should hold the average near 129 GPUs.

### Bin-packing

Mixing shapes on one node strands GPUs, so each pool gets its own nodes. The 8B pool needs 55 replicas on 7 nodes, which strands one GPU. The 70B pool needs 31 replicas, two per node, on 16 nodes, which strands four. The 405B pool needs 13 replicas of two nodes each, on 26 nodes, with none stranded. That is 49 nodes, or 392 GPUs, for the 387 planned. Spread each pool across nodes and zones. One node failure removes eight 8B replicas, which is 67 requests a second, about 15% of that pool.

### Adapters on a shared base

A rank-16 LoRA adapter on the query and value projections of Llama 3.1 8B is about 13.6 MB in BF16, as [running inference at scale](/learn/inference-fleets#serving-many-models) works out. Six thousand adapters take 81.6 GB. Six thousand full 8B fine-tunes would take 96 TB, about 1,200 times as much. Keep a hot set on each replica (200 adapters take 2.7 GB) and the rest in host memory. The engine batches sequences that use different adapters on one base model, as the Punica and S-LoRA papers describe, so the batch does not split by adapter.

## Autoscaling

Scale on what users feel. CPU stays low on a saturated GPU host, and GPU utilization does not show whether requests are waiting. Use waiting requests per replica and TTFT at p95 over the last minute. Add KV cache utilization, which binds mainly for long-context tenants, because at 2,000-token contexts and batch 29 the cache is only about 13% full.

Apply the [Kubernetes HPA](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/) rule to waiting requests: desired = ceil(current × observed ÷ target). With 30 replicas, 3 waiting each and a target of 2, the result is ceil(30 × 3 ÷ 2) = 45. Scale out after 60 seconds above target. Scale in only after 15 minutes below target, draining each replica first. A jump of 30 requests a second needs about 8 more 70B replicas (30 ÷ 4.1 ≈ 7.3), and the queue and shedding cover the wait for them.

## Cold starts and weight caching

The 70B checkpoint is 141.1 GB, the exact size behind the 140 GB used above. The numbers use the [fleet chapter's cold-start estimate](/learn/inference-fleets#loading-models-quickly) (a 10 GB image, a 5 GB/s read from the node's local NVMe disk into GPU memory and a 60-second engine start, which is an assumption to measure), on a faster 25 Gbps regional link (3.125 GB/s). A cold replica pulls its image for 10 ÷ 3.125 ≈ 3 s, downloads weights for 141.1 ÷ 3.125 ≈ 45 s, loads them for 141.1 ÷ 5 ≈ 28 s and starts its engine for 60 s, so it is ready after about 136 s. A warm replica, whose image and weights are already on the node, is ready after 28 + 60 = 88 s.

```diagram
title: A new 70B replica. The warm path skips the download.
[t:client] Scale-up\nsignal @ 0,1
[st:store] Regional store\nfetch: 45 s @ 1,0
[nv:store] Node NVMe\nlocal copy @ 2,1
[gpu] GPUs load\nshards in parallel @ 3,1
[ok:note] Engine starts,\nprobes pass @ 4,1
t --> st : download
st --> nv : copy
t --> nv : warm: no download
nv -> gpu : load 28 s
gpu -> ok : start 60 s
```

Keep weights on node NVMe for the models each node serves, and fill nodes during deploys rather than on demand. Pre-pull images, load shards in parallel and gate readiness on a test generation. A warm pool of one idle node costs 8 × $3 × 730 ≈ $17,520 a month, and it brings the first replicas up in 88 seconds instead of 136.

## Batch tier on idle capacity

Batch covers evaluations, nightly summaries and bulk classification. A customer uploads a JSONL file with a `custom_id` per request and gets results within 24 hours, at a lower price. The [offline batch section](/learn/inference-fleets#offline-batch-inference) covers this trade from the provider's side.

Batch items use their own queue, and a replica takes one only when its priority queues are empty and its cache has room, up to half of it. When priority traffic arrives, the engine evicts batch sequences first, frees their [paged](/learn/inference-engines#paging) blocks and recomputes them later. Each item is independent, so an evicted item restarts alone.

At the quietest hour, traffic falls to a fifth of peak, so the 70B pool needs 0.2 × 30 = 6 replicas and 25 of its 31 are idle. At batch 225, the cache limit for 2,000-token sequences, a step takes 21.5 ms. An item with a 1,000-token prompt and a 500-token output costs about 71 ms of prefill and 48 ms of decode, so a replica produces about 4,220 output tokens a second. Over 8 hours, 25 replicas make about 3.0 billion output tokens, for the $2,400 they cost to keep on overnight. Batch is cheaper per token because each step reads the weights once for every sequence in it. A decode token costs about 0.095 ms at batch 225, against 0.41 ms at batch 29.

## Multi-region and reservations

Each region runs its own gateways, routers, replicas and caches under a global control plane. Weights are copied into each region's store during deploys, so a scale-out never fetches across an ocean. Tenants pinned to a region by data residency stay there. Standard traffic may spill to another region above its plan, at a cost of about 100 ms of extra round trip. Priority traffic does not spill.

Large customers can reserve dedicated replicas for a term. A reservation costs the same whether it is used or not: two 70B replicas are $17,520 a month. In return, that tenant's TTFT stays predictable.

## Failure handling

Probe each replica with a short generation every 10 seconds, and watch passive error rates too, since a process can answer pings while its GPU has faulted. One failed GPU removes a whole 70B or 405B replica, so the router takes it out of rotation and the autoscaler replaces it.

The platform retries only when a retry is safe:

1. **No token has reached the client.** Retry once on another replica, and bill only the attempt that produced output.
2. **Some tokens have reached the client.** Resume on another replica with the partial reply if the product accepts a different continuation. Otherwise end the stream with an error event.
3. **Tool calls.** The platform returns tool calls and never runs them, so its own retries are safe. A customer's side effects need their own [idempotency keys](/learn/reliability-patterns#idempotency-keys).

Client SDKs also retry, which is why billing keys on the request ID and not on attempts.

A deploy stops new admissions to a replica and waits for its streams to finish. Replies are capped at 4,096 tokens. At the 25-tokens-a-second target the longest stream takes about 164 seconds, and under overload it can slow to 20 tokens a second, which takes about 205. The drain window is therefore 240 seconds. Replace at most 10% of a pool at a time, which a Kubernetes [pod disruption budget](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/) can enforce.

## Metering and billing

Input tokens are split into uncached and cached tokens, which are priced differently. Output tokens are every token generated and sent. A client that disconnects mid-stream is billed for the tokens generated so far, because the GPU did that work. Attempts that produced no output are not billed.

```json
{
  "request_id": "req_7Hk2Qm9xV1",
  "attempt": 1,
  "tenant": "t_1042",
  "model": "llama-3.1-70b",
  "tier": "priority",
  "input_tokens": 1700,
  "cached_input_tokens": 1020,
  "output_tokens": 302,
  "finish": "stop",
  "price_version": "2026-10-01"
}
```

The network can deliver an event twice, and no protocol guarantees exactly-once delivery. The platform gets exactly-once effects from at-least-once delivery and an idempotent write. The ledger has a unique key on the request ID, so a second insert changes nothing. For non-streamed calls, the gateway keeps the reply for 24 hours, so a client that retries with an `Idempotency-Key` header is not billed twice.

At 200 requests a second, the platform writes 17.3 million events a day, about 4.3 GB at 250 bytes each. At peak it writes 600 a second. A gateway spools events to local disk if the log is unreachable, and one hour at peak is 2.16 million events, about 540 MB. Each hour, every replica's engine token counts are compared with its ledger rows, and a gap above 0.1% raises an alarm.

```diagram
title: Usage events leave the request path and reach the ledger once.
[r:box] Replica\ncounts tokens @ 0,0
[g:box] Gateway\nadds tenant\nand price @ 1,0
[log:queue] Event log\nkeyed by\nrequest ID @ 2,0
[led:store] Ledger\none row per ID @ 3,0
[inv:note] Invoices\nfrom hourly\nrollups @ 4,0
[rec:note] Reconciliation\nengine vs ledger @ 2,1.5
r -> g : final counts
g --> log : one event
log -> led : dedupe
led -> inv : roll up
r --> rec : engine totals
led --> rec : ledger totals
```

## Observability and goodput

Track TTFT and TPOT at p50 and p99 per model and tier, with TTFT split into queue wait, prefill and the first decode step. Add tokens a second per replica, decode batch size, KV utilization, preemptions, prefix hit rate, and 429, 503 and 5xx counts by cause. Per-tenant p99 helps catch a noisy neighbor early.

The 99.9% SLO allows 43.2 minutes of breach in a 30-day month, so alert on how fast that budget is burning, as the [observability chapter](/learn/observability#alerting-on-symptoms) describes. Report goodput beside throughput. Goodput is the output tokens a second from requests that met both their TTFT and TPOT targets. Past the breaking point, throughput can stay flat while goodput falls.

## Cost and utilization trade-offs

- **Headroom costs GPUs.** Planning at 75% of the breaking rate uses about a third more GPUs than planning at the breaking point (1 ÷ 0.75 ≈ 1.33). The spare buys room for bursts and failures.
- **Idle capacity multiplies cost per token.** At a third of the planned load, the 70B cost per token triples. Autoscaling, the warm pool and the spares control how much idle capacity the platform pays for.
- **Commitments.** Reserved capacity suits steady traffic and on-demand suits bursts. Batch can run on preemptible GPUs where a provider offers them, because each item restarts cleanly.

## Trade-offs to discuss

- **Shed early or queue.** Rejecting early keeps admitted requests fast, but customers see 503s at peak. Queuing hides rejections while every request slows down.
- **Cache hits or isolation.** Sharing prefixes across tenants saves prefill and leaks timing. Salting keeps isolation and gives up hits that rarely happen anyway.
- **Affinity or balance.** Routing a tenant to the replica that holds its prefix saves prefill, but a busy tenant can overload that replica, so the router needs an imbalance cap.
- **Split prefill.** At the breaking point, prefill takes two-thirds of each replica's time. A separate prefill pool can pay off, but each request then moves its KV cache across the network, as [separating prefill and decode](/learn/inference-fleets#separating-prefill-and-decode) describes.
- **Async billing.** Usage events written after the reply keep the request path fast, at the cost of balances that lag by a few seconds. The ledger stays exact.

## Check yourself

<details>
<summary>The 70B pool must serve 120 requests a second at peak. How many replicas do you run, and what happens if one fails?</summary>

120 ÷ 4.1 = 29.3, so 30 replicas, plus one spare (124 GPUs). If one fails, the other 30 each take 4.0 requests a second, still within plan.

</details>

<details>
<summary>Why does the router count queued prompt tokens instead of queued requests?</summary>

Prefill cost scales with prompt length. Twenty queued 200-token prompts (4,000 tokens, about 283 ms) are less work than two queued 8,000-token prompts (16,000 tokens, about 1.13 seconds), even though a request count would call the first queue busier.

</details>

<details>
<summary>A team wants to share prefix cache entries across all tenants. What could go wrong, and what would you share instead?</summary>

A faster first token reveals that someone recently sent a prefix, so one customer could probe for another's prompts. Share only platform boilerplate with no customer data, and salt customer prefixes with the tenant ID. Little is lost, because customer prompts rarely repeat across customers.

</details>

<details>
<summary>A node holding eight 8B replicas fails at peak. How much capacity is lost, and how should the pool be laid out?</summary>

Eight replicas at 8.4 requests a second each is about 67 requests a second, roughly 15% of the pool. Spread the replicas over at least seven nodes, so no node carries more than about 15%. The rest of the pool absorbs the loss until a warm node replaces them, about 88 seconds later.

</details>

<details>
<summary>A usage event arrives twice at the ledger. How is the customer billed, and how do you know the books are right?</summary>

The ledger's unique key on the request ID makes the second insert a no-op, so the charge counts once. Each hour, compare every replica's engine token counts with its ledger rows, and alarm on a gap above 0.1%.

</details>

<details>
<summary>A deploy gives each replica a 60-second drain window, and a 4,096-token reply stops at 40 seconds. Why, and what window is right?</summary>

At 25 tokens a second, a 4,096-token reply takes about 164 seconds, and under overload it can take 205, so 60 seconds is too short. The drain must cover the longest reply the platform allows, so 240 seconds is the right order. Replacing at most 10% of a pool at once keeps capacity up meanwhile.

</details>

<details>
<summary>Why is a batch decode token about four times cheaper than an interactive one on the same GPUs?</summary>

Every sequence in a decode step shares one read of the weights. At about 225 sequences, a token costs 21.5 ms ÷ 225 ≈ 0.095 ms of replica time. At about 29 sequences, it costs about 0.41 ms.

</details>

## Further reading

- [Kwon et al., PagedAttention (SOSP 2023)](https://arxiv.org/abs/2309.06180): block tables, prefix sharing and preemption, the basis of vLLM's cache.
- [Zhong et al., DistServe (OSDI 2024)](https://arxiv.org/abs/2401.09670): separating prefill from decode, and measuring SLO attainment.
- [Sheng et al., S-LoRA](https://arxiv.org/abs/2311.03285): thousands of LoRA adapters served from one base model.
- [Chen et al., Punica](https://arxiv.org/abs/2310.18547): batching requests for different LoRA models in one kernel.
- [Dean and Barroso, The Tail at Scale (CACM 2013)](https://research.google/pubs/the-tail-at-scale/): why tail latency dominates at scale.
- [Google SRE book, Handling Overload](https://sre.google/sre-book/handling-overload/): load shedding, criticality and client-side throttling.
- [vLLM prefix caching design](https://docs.vllm.ai/en/latest/design/prefix_caching.html): how block hashes chain and how blocks are evicted.
- [NVIDIA Dynamo](https://github.com/ai-dynamo/dynamo): a distributed inference framework with disaggregated serving and KV-aware routing.
- [OpenAI Batch API guide](https://developers.openai.com/api/docs/guides/batch): the 24-hour completion window and the batch file format.
