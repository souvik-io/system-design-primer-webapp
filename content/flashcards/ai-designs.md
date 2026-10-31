<!-- Decisions, numbers and 45-minute walkthroughs for the eight AI system design questions. -->

<!-- chapter: design-chat-assistant -->

## In the chat assistant design, why does the sizing assume only a quarter of history tokens hit the prefix cache at peak?
<!-- /learn/design-chat-assistant#requirements-and-estimates -->

A Large replica's 148 GB cache holds about 451,660 tokens, roughly 196 conversations of 2,300 tokens. At peak each replica takes about 8 new messages a second, so an idle conversation's cache lasts only about 24 seconds, and most users pause longer than that. The system prompt always hits, so a message has about 1,456 cached tokens and **829 uncached tokens to prefill**. That hit rate sizes the fleet: 171 H100s at 50% history hits, 216 at 25% and 261 at 0%.

## In the chat assistant design, how do the Idempotency-Key header and the parent_id field keep a conversation consistent?
<!-- /learn/design-chat-assistant#api-design -->

- **Idempotency-Key**: the server keeps the key with its message and generation IDs for 24 hours. A retried send rejoins the running generation or gets the stored reply, and never creates a second user message.
- **parent_id**: each message points to the one it answers, so a conversation is a tree. A send must name the **active leaf**. If it doesn't, the server returns `409 Conflict`, which stops two devices from interleaving writes without noticing.

## How does the chat assistant lay out its 32,768-token prompt, and why in that order?
<!-- /learn/design-chat-assistant#context-window-management -->

The reply reserves 1,024 tokens and the system prompt takes 1,200, which leaves 30,544 for memory, the summary and the turns. The order is system prompt, memory block, summary of old turns, recent turns, then the new message. **The parts that change least come first**, so each new message appends to a prefix the engine has already processed. An average conversation fits easily, since the budget holds about 74 exchanges. Longer ones drop old turns four at a time and fold them into a summary written on the Fast pool.

## In the chat assistant design, what happens when a user presses stop, and how does that differ from a dropped connection?
<!-- /learn/design-chat-assistant#streaming-and-cancellation -->

- **Stop**: the gateway aborts the engine request, the engine frees the sequence's KV blocks at its next step, and the partial reply is stored as `cancelled`. Tokens produced so far are billed, and later turns include the partial text, since the user already read it.
- **Dropped connection**: the edge keeps the generation running for a **10-second grace period** and buffers its tokens. A reconnect with `Last-Event-ID` replays what was missed. Without one, the edge cancels as if the user had pressed stop.

The grace period wastes at most about 320 tokens per dropped stream, and it avoids a fresh prefill and a reply that could read differently.

## In the chat assistant design, how does the gateway protect paid users when the pools can't keep up at peak?
<!-- /learn/design-chat-assistant#limits-tiers-and-admission-at-peak -->

Each message reserves its prompt plus `max_tokens` (1,024 for free, 4,096 for paid) and settles the unused part later, and no user has more than two generations in flight. The gateway estimates each pool's wait from its queue and completion rate. **When the free-tier wait passes two seconds, free requests get `429` with `Retry-After`** and paid requests move ahead. Overload also degrades in steps: free Large requests fall back to Fast with a notice, and free `max_tokens` drops to 1,024.

## What are the three parts of failover in the chat assistant design?
<!-- /learn/design-chat-assistant#multi-region-and-failover -->

1. **History.** Each user has a home region, and a second region keeps an asynchronous copy. The app sends its last known message ID so the server can find the gap, and the idempotency key keeps resends safe.
2. **Capacity.** Losing a region doubles the other's peak, so either size each region for the full peak, which doubles cost, or shed free traffic until the region returns.
3. **Model.** The Large alias can fall back to a hosted provider. An hour of peak Large traffic there costs about $15,900, against $528 for the pool, **about 30 times as much**, so a spend cap and an alert must exist before the first outage.

## Talk through a design for a chat assistant like ChatGPT or Claude.ai in 45 minutes. What are your four steps?
<!-- /learn/design-chat-assistant -->

1. **Use cases and numbers.** Multi-turn conversations with streamed replies, history and titles, stop and regenerate, a Large and a Fast model, free and paid tiers.
   - 2 million daily users send 26 million messages a day: about 301 a second on average and 903 at peak (365 Large, 538 Fast).
   - An average prompt of 2,285 tokens and a 350-token reply. About 316,000 output tokens a second at peak.
2. **High-level design.** An edge and API layer for auth and tier limits, a conversation service over a history store sharded by `user_id`, a context builder, an LLM gateway, and Large (70B, four H100s) and Fast (8B, one H100) pools. Replies stream back as server-sent events.
3. **Core components.**
   - A POST with an `Idempotency-Key`, streamed events whose IDs are token offsets, and a conversation tree with an active leaf.
   - A cache-friendly prompt layout. Old turns drop in blocks of four and go into a summary.
   - Stop cancels down to the engine. A dropped stream gets a 10-second grace period to resume.
4. **Scale.** 44 Large and 40 Fast replicas, 216 H100s, about $473,040 a month. The prefix hit rate sizes the fleet, so route each conversation to the replica that holds it. Shed free traffic first, check output in 256-token moderation windows, and give each user a home region with a hosted model as a capped last resort.

<!-- chapter: design-inference-platform -->

## In the inference platform design, why plan a 70B replica at 4.1 requests a second when it breaks at 5.47?
<!-- /learn/design-inference-platform#how-many-requests-one-replica-takes -->

At 5.47 requests a second, prefill takes two-thirds of the replica's time and each user gets only 25 tokens a second, the edge of the target. Planning at **75% of the breaking rate** leaves room for bursts and one failure: 120 ÷ 4.1 needs 30 replicas plus a spare, 124 GPUs. If one fails, the other 30 each take 4.0 requests a second. The cost is about a third more GPUs (1 ÷ 0.75 ≈ 1.33) than running at the breaking point.

## In the inference platform design, how much does prefix caching save, and why is only boilerplate shared across tenants?
<!-- /learn/design-inference-platform#prefix-reuse -->

Assume 40% of prompt tokens are platform boilerplate and 15% a tenant's own repeated prefix. The 70B pool needs 30 replicas with no cache, 19 with boilerplate hits on any replica, and 15 with tenant affinity as well. That saves 60 GPUs, about $131,000 a month. **Customer prefixes are salted with the tenant ID** because a faster first token would reveal that someone recently sent that prefix. Little is lost, since customer prompts rarely repeat across customers.

## How does the inference platform's router score replicas, and how does it play out for a 1,700-token prompt?
<!-- /learn/design-inference-platform#choosing-a-replica -->

It predicts time to first token: queued prompt tokens plus this request's uncached tokens, each at 70.8 µs, plus a penalty if the cache lacks room. Replica `a` caches 93 of the prompt's 106 blocks and has 500 tokens queued, so it scores about 50 ms. Empty replica `b` scores 120 ms, so `a` wins. With 3,000 tokens queued, `a` scores 227 ms and `b` wins. **Least connections can't make this call**, because two requests can differ in prefill cost by a factor of 40.

## In the inference platform design, when does the gateway reject a priority request outright, and why cap priority prompts at 32,000 tokens?
<!-- /learn/design-inference-platform#budgets-and-shedding -->

A 2-second TTFT target allows about 28,000 queued prompt tokens per replica, about 16 prompts of 1,700 tokens. **A request that would join behind more than that has already missed its target**, so it gets an immediate 503 with `Retry-After` and uses no GPU time. A 128K-token prompt fills 42.9 GB, 29% of a 70B replica's cache, and its 9.3-second prefill stalls everything behind it. So priority prompts stop at 32,000 tokens, and longer ones use chunked prefill on the standard tier.

## Why is a batch token so much cheaper than an interactive one in the inference platform design?
<!-- /learn/design-inference-platform#batch-tier-on-idle-capacity -->

Each decode step reads the weights once for every sequence in the batch. At night the 70B pool needs only 6 of its 31 replicas, and the idle 25 run batch items at a batch of 225, where a token costs about 0.095 ms of replica time against 0.41 ms at an interactive batch of 29. Over 8 hours they make about 3.0 billion output tokens for the $2,400 they cost. **Batch takes a replica only when its priority queues are empty**, uses at most half its cache, and is evicted first when priority traffic returns.

## In the inference platform design, how long does a new 70B replica take to come up, and what does a warm node change?
<!-- /learn/design-inference-platform#cold-starts-and-weight-caching -->

Cold: about 3 s to pull the image, 45 s to download 141.1 GB of weights, 28 s to load them from NVMe and 60 s to start the engine, so **about 136 s**. Warm, with image and weights already on the node: 28 + 60 = **88 s**. So weights are kept on node NVMe and filled during deploys, images are pre-pulled, and readiness waits for a test generation. A warm pool of one idle node costs about $17,520 a month.

## Talk through a design for a model inference platform that serves many LLMs to many customers in 45 minutes. What are your four steps?
<!-- /learn/design-inference-platform -->

1. **Use cases and numbers.** An OpenAI-compatible API with streaming, about 45 base models from 8B to 405B, customer LoRA adapters, priority and standard tiers, a batch API and token billing.
   - 600 requests a second at peak: 450 to 8B, 120 to 70B, 30 to 405B. 1,700-token prompts, 300-token replies.
   - Priority p99 TTFT of 2 seconds or less, at least 25 tokens a second per user, 99.9% availability.
2. **High-level design.** A data plane of gateway (keys, budgets), prefix-aware router and replica pools per model size, serving from cached config. A control plane holds the catalog, keys, plans and autoscaler limits. Usage events go through a log to a ledger.
3. **Core components.**
   - Plan each replica at 75% of its breaking rate (4.1 requests a second for 70B).
   - Route by predicted TTFT from queued prompt tokens and prefix hits, with tenant affinity and salted customer prefixes.
   - Shed with 503 when the queue already exceeds the TTFT budget, and order requests with start-time fair queuing across tenants.
   - A ledger keyed on request ID, so every token is billed once.
4. **Scale.** 387 GPUs at peak, about $847,530 a month if held all month. Autoscale on waiting requests and p95 TTFT, keep weights on node NVMe (88 s warm, 136 s cold), run batch on idle capacity, and drain replicas for 240 seconds on deploys.

<!-- chapter: design-llm-gateway -->

## In the LLM gateway design, why do instances sync budget holds every 500 ms instead of checking Redis per request, and how big can the overshoot get?
<!-- /learn/design-llm-gateway#budgets-across-many-instances -->

A Redis round trip per request would put Redis on the path of every call. Instead each instance counts locally and every 500 ms adds its pending holds to the shared total and reads back the new total. With a key capped at 50 requests a second, the instances together admit at most 25 requests per interval that the others can't see. At the worst case of $0.069 each, **the overshoot is about $1.72**, roughly 0.009% of a $20,000 budget. Syncing only settled spend would hide each request for its whole stream, raising the bound to about $19.

## Why does the LLM gateway route with weighted rendezvous hashing instead of weighted random choice?
<!-- /learn/design-llm-gateway#routing-retries-and-fallbacks -->

Random choice scatters an app's requests across providers, each with its own prompt cache. For an app sending a 6,000-token system prompt every 4 minutes to caches that last 5 minutes, one provider gives a hit at about $0.0018 a request. Split 50/50, most requests miss and pay a cache write at $0.0225, **12.5 times as much**. Rendezvous hashing sends the same app to the same target while still splitting traffic by weight across apps, and when a target cools down only its own apps move.

## In the LLM gateway design, how much of chat-large can Provider B absorb if Provider A fails, and what keeps retries from making things worse?
<!-- /learn/design-llm-gateway#routing-retries-and-fallbacks -->

At peak `chat-large` sends 22.5 million input tokens a minute. With an assumed 8-million-a-minute quota, B can take about 53 requests a second, roughly 36% of the alias, which covers the interactive third while batch waits. **Apps disable SDK retries so the gateway is the only retry layer**, and each target has a retry budget of about 10% of first attempts. Without that, a failing A could see 105 × 3 × 3 = 945 requests a second. Ramp the shift to B over a minute or two to avoid acceleration limits.

## Why does the LLM gateway hold back response headers until the provider's first content event?
<!-- /learn/design-llm-gateway#streaming-and-failover -->

The user sees nothing before the first token anyway, so the delay costs nothing. **Until headers go out, every failure stays retryable on another target**: 429s, 529 overloads, connection errors and stalled prefills. A first-token deadline catches stalls, set at 4 seconds plus 50 ms per 1,000 prompt tokens for `chat-large` (about 4.1 seconds for 2,500 tokens). Once tokens reach the app, the gateway won't switch providers silently. It ends the stream with an error event and no `[DONE]` line.

## How does the LLM gateway run a 25 ms injection classifier without adding latency?
<!-- /learn/design-llm-gateway#the-request-path-and-where-time-goes -->

It starts the classifier at the same time as the provider call, and **the relay holds back the first token until the verdict arrives**. Provider time to first token almost always exceeds 25 ms, so users see no extra wait. A flagged request is cancelled before any output reaches the app, and it costs only its input tokens, at an assumed flag rate of 0.3%. Running the check serially would add its latency to every call.

## How does the LLM gateway design arrive at 9 instances?
<!-- /learn/design-llm-gateway#requirements-and-estimates -->

Each request costs about 5.1 ms of CPU: 1.5 ms for parsing, translation and logging, 3 ms for about 300 stream events, and 0.6 ms of redaction on average. At 1,000 requests a second that is 5.1 cores, or 12.75 at 40% CPU, so four 4-vCPU instances. **Any two of three zones must carry the peak**, so each zone needs two, plus one more per zone for rolling deploys: 9 instances. By Little's law they hold about 6,000 open streams at peak.

## Talk through a design for a company-wide LLM gateway in 45 minutes. What are your four steps?
<!-- /learn/design-llm-gateway -->

1. **Use cases and numbers.** One OpenAI-compatible API for about 200 internal apps, virtual keys, team budgets, routing with fallbacks and canaries, redaction and screening hooks, audit logs and chargeback.
   - 250 requests a second on average, 1,000 at peak. 2,500-token prompts, 300-token replies.
   - About $1.61 million a month of model spend. At most 20 ms of added p99 latency, 99.95% available.
2. **High-level design.** A layer-4 load balancer, 9 stateless gateway instances in three zones, a guard service for screening, Redis for counters and cache, a control plane pushing versioned config, two hosted providers and a self-hosted pool, and a usage and audit log.
3. **Core components.**
   - A per-step latency budget of about 7.4 ms, with injection screening running beside the provider call.
   - Budget holds counted locally and synced every 500 ms, about $1.72 of overshoot at most.
   - Weighted rendezvous hashing for sticky routing, plus cooldowns, circuit breakers and a retry budget.
   - Headers held until the first token, so failures before it fail over unseen. Adapters normalize tool calls and usage fields.
4. **Scale and operations.** Sticky routing keeps prompt caches warm (about $197,000 a month), canaries step from 1% to 100%, data classes and regions are hard filters, batch runs in its own deployment, and a Redis outage fails open with local caps.

<!-- chapter: design-rag-qa -->

## Why does the RAG question-answering design call a hosted model when a self-hosted pool costs about the same?
<!-- /learn/design-rag-qa#requirements-and-estimates -->

At about 4,180 input and 300 output tokens, a question costs about $0.0171 on the assumed hosted prices, or **$45,200 a month** for 2.64 million questions. Serving 10 questions a second on 70B replicas would need 5 replicas plus a spare, 24 H100s, **$52,560 a month**, and they would sit idle at night since traffic falls in a 9-hour working day. Data residency rules or higher volume could reverse the choice.

## In the RAG design, why are chunks split by document section instead of fixed 400-token windows?
<!-- /learn/design-rag-qa#parsing-and-chunking -->

A fixed window shifts every later boundary when a word is inserted, so a one-line edit changes every later chunk and they all need new embeddings. A chunk ID built from the document ID, heading path and part number stays put, and each chunk stores a hash of its text. **An edit to one section changes one hash, so only that chunk is embedded again.** Sections over 400 tokens split into parts with 50 tokens of overlap, and the heading path is embedded with the text so the chunk keeps its context.

## How does the RAG design's ingestion notice changes, and what catches lost deletes?
<!-- /learn/design-rag-qa#connectors-and-change-detection -->

- **Webhooks** arrive in seconds but can be lost or reordered, so one only means "fetch document X now".
- **Change feeds** are read every 30 seconds from a saved cursor.
- **Polling** every 2 minutes covers sources with neither.

**A nightly reconciliation** compares every document ID and version in the source with the index, which catches lost webhooks and lost deletes. Events go to a log partitioned by document ID, so one worker applies a document's changes in order. An alert fires when the oldest waiting event is 3 minutes old, inside the 5-minute freshness target.

## In the RAG design, how much GPU does reranking 50 candidates take at 10 questions a second?
<!-- /learn/design-rag-qa#reranking -->

Fifty candidates of 400 tokens plus a 30-token query are 21,500 tokens. An assumed 0.5-billion-parameter cross-encoder at 2 FLOPs per parameter per token needs 21.5 TFLOP, about **43 ms on one H100** at 50% of peak. At 10 questions a second that GPU is 43% busy, so the design runs two to keep queues short and survive a failure. Reranking 150 candidates would triple the cost, so measure recall@8 at 50 and 100 first.

## In the RAG design, how does a sharing change on a 50,000-file folder take effect, and what covers the gap?
<!-- /learn/design-rag-qa#revocation -->

Every chunk of every file needs new principals, a metadata update with no new embedding. The folder's 350,000 chunks update at an assumed 5,000 a second, so **the index catches up in about 70 seconds**. The ACL store updates within seconds, and the answer service rechecks the 8 chosen chunks' documents against it before building the prompt, which covers the window. Two policies keep sync safe: a document whose ACL can't be read gets no principals, and "anyone with the link" files are indexed only for their owner and named principals.

## Why does the RAG design use HNSW over int8 instead of IVF-PQ, and how is it sharded?
<!-- /learn/design-rag-qa#the-index -->

IVF-PQ would fit 46.8 million chunks in 3.0 GB, but its clusters and codebooks drift as content changes and it loses recall without rescoring. **HNSW over int8 takes 53.9 GB and accepts inserts one at a time**, which suits 260,500 changed chunks a day. Chunks are spread over 6 shards by a hash of the document ID, so a delete touches one shard. Each shard holds 7.8 million chunks (about 9 GB of graph), and two replicas per shard make 12 nodes of 64 GB, there for failures more than load.

## Talk through a design for a question-answering system over company documents in 45 minutes. What are your four steps?
<!-- /learn/design-rag-qa -->

1. **Use cases and numbers.** Cited answers from the wiki, tickets, drives and chat, using only documents the asker can open, with "I don't know" and follow-ups.
   - Edits answerable within 5 minutes, revocations within 2, first token within 2 seconds.
   - 40,000 employees, 120,000 questions a day, planned at 10 a second. 46.8 million chunks.
   - About 4,180 input tokens and $0.0171 a question, $45,200 a month.
2. **High-level design.** Connectors feed a change log keyed by document to parse, chunk and embed workers, which write search shards holding BM25, vectors and ACL principals. On the query side, an answer service, a retriever that fuses and reranks, a directory and ACL store, and an LLM gateway to a hosted model.
3. **Core components.**
   - Section-based chunks with hashes, so an edit re-embeds only what changed.
   - Hybrid BM25 and vector search with the permission filter inside both, RRF fusion, and a cross-encoder reranking 50 down to 8.
   - Abstain below a rerank threshold, verify citations after streaming, and recheck ACLs on the final 8.
4. **Scale and operations.** HNSW over int8 on 6 shards with two replicas each, tombstones for deletes, blue/green rebuilds for a new embedding model, an answer cache keyed with a permission fingerprint, and a golden set with permission probes as a release blocker.

<!-- chapter: design-coding-assistant -->

## In the coding assistant design, why does the completion pool's capacity depend on prefill rather than decode?
<!-- /learn/design-coding-assistant#sizing-the-completion-pool -->

A suggestion averages only 21.6 output tokens, so the decode batch stays tiny (about 2.5 sequences at the plan). **A decode step reads the 16 GB of weights once however many sequences share it**, so extra output tokens ride along almost free, while prefill time grows with every request. A replica breaks at 20 requests a second and is planned at 15, so 6,000 a second needs 400 H100s. Stopping cancelled requests early saves only 10 GPUs, while losing the prefix cache would push the pool to 921.

## Why does the coding assistant build its completion prompt in suffix-prefix-middle order with a stable snippet set?
<!-- /learn/design-coding-assistant#building-the-completion-prompt -->

In prefix-suffix-middle order, the suffix sits after the prefix, so every keystroke, which extends the prefix, invalidates the cached suffix. **In suffix-prefix-middle order, typing only appends to the end of the prompt**, so the cached part keeps matching. The snippets from other files change only when the cursor moves to another function or file. If they changed on every keystroke, every block after them would miss the cache and the pool would need more than twice the GPUs.

## How does speculative decoding help the coding assistant's completions, and what doesn't it change?
<!-- /learn/design-coding-assistant#making-completions-fast -->

With a decode batch of about 2.5, most of the GPU's arithmetic sits idle. A cheap drafter proposes tokens and the 8B model checks them in one pass. Code repeats itself, so **n-gram lookup from the prompt is a nearly free drafter**. If each drafted token is accepted with probability 0.7 and the drafter proposes 4, a pass yields about 2.77 tokens, so the first line arrives in about 34 ms instead of 94. The 0.7 needs measuring, and speculation leaves prefill, which sets capacity, unchanged.

## In the coding assistant design, what limits the chat and agent pool, and how many replicas does it need?
<!-- /learn/design-coding-assistant#sizing-the-chat-and-agent-pool -->

**Memory binds first.** An agent sequence holds about 25,000 tokens, 8.2 GB of cache, so a 70B replica's 148 GB fits only 18. The batch reaches 18 at about 1.27 requests a second per replica. Planning at 75% gives about 0.96 a second, with 46 tokens a second per stream, so 105 calls a second at peak need 110 replicas, 440 H100s. The sizing assumes 90% cache hits on agent steps. At 50% the pool needs 234 replicas, while an FP8 cache would cut it to 83 if a quality eval passes.

## Why does the coding assistant run its own completion model but treat hosting agent mode as a closer call?
<!-- /learn/design-coding-assistant#cost-per-developer -->

At $3 and $15 per million input and output tokens, completions would cost about $34.6 million a month at list price, **about forty times the $876,000 completion pool**. Chat and agent traffic would cost about $8.6 million a month at list price, or $2.6 million with cached input at a tenth, against $963,600 for the 70B pool. That gap is smaller, and a hosted frontier model may win on quality. The two owned pools together cost about $9.20 per seat a month before autoscaling.

## In the coding assistant design, why isn't accept rate enough to judge a new completion model, and how big must an A/B test be?
<!-- /learn/design-coding-assistant#accept-rate-and-experiments -->

A model that shows only near-certain suggestions raises its accept rate while helping less. So report **accepted characters per hour and retention**, the share of accepted text still there 30 seconds and 5 minutes later. Randomize by developer, since one developer's requests share habits and code. With an 8-point standard deviation in per-developer accept rate, detecting a 1-point change at 5% significance and 80% power needs about 1,004 developers per arm. Watch latency in both arms too.

## Talk through a design for an AI coding assistant with inline completions and an agent mode in 45 minutes. What are your four steps?
<!-- /learn/design-coding-assistant -->

1. **Use cases and numbers.** Inline completions in the editor, chat about the repository, and an agent mode that edits in a sandbox, runs tests and waits for approval.
   - First line within 300 ms at p50 and 600 ms at p90. Code is never retained or used for training.
   - 120,000 daily developers, 600 requests per active hour after a 75 ms debounce and a client cache: 288 million a day, 6,000 a second at peak.
   - 1,800-token prompts (760 uncached on average) and 21.6 output tokens.
2. **High-level design.** Editor plugin, regional edge for auth and policy, a completion router in front of an 8B pool (one GPU each), and an orchestrator for chat and agents over a 70B pool, a code index and a per-task sandbox. Telemetry carries no code.
3. **Core components.**
   - The client builds a fill-in-the-middle prompt in suffix-prefix-middle order from local context only.
   - Session affinity by consistent hashing, cancels that reach the GPU, and post-processing that trims and syntax-checks suggestions.
   - An agent loop with step and token limits, a sandbox with no network or secrets, allowlisted commands, and one combined diff to approve.
4. **Scale.** 400 H100s for completions and 440 for chat and agents, about $1.84 million a month. Watch the prefix hit ratio first, offload idle agent caches to host memory, run completion pools in every major region, and judge models by accepted characters and retention in A/B tests.

<!-- chapter: design-agent-platform -->

## In the agent platform design, why does prompt caching save more on long runs than on short ones?
<!-- /learn/design-agent-platform#requirements-and-estimates -->

Step k reads the prefix plus every earlier step, so input tokens grow with the square of the step count. A 30-step research run reads 1,327,500 input tokens, costing about $4.16 uncached. With caching, each step reads the previous prompt at 0.1 times the input price and writes only its new tokens, so the run costs about $0.83. **The longer the run, the more of each prompt is history already sent**: triage saves 3.4 times, research 5.0 and sandbox 6.1. Across the platform that is about $19.7 million a month against $100 million.

## How does the agent platform make a run survive worker crashes without a stale worker corrupting it?
<!-- /learn/design-agent-platform#the-run-loop-as-a-durable-workflow -->

Each run is an **event-sourced log**, and the state is rebuilt by replaying it. The model's reply is appended before any tool it asked for runs, so a crash never forces a second model call that could answer differently. Each append names the sequence number it expects, and the store rejects it if the log has moved on, which acts as a **fencing token**. Workers hold a 30-second lease renewed every 10 seconds, and after three missed heartbeats the run moves to another worker.

## In the agent platform design, a worker dies between a tool's action and recording its result. How does the next worker decide whether to call the tool again?
<!-- /learn/design-agent-platform#tool-calls-and-idempotency -->

The log shows `tool_started` with no result. Every call carries the key `run_id:tool_use_id`, built from IDs already in the log, so each attempt sends the same key.

- **Retry-safe tools** (built-in tools, and HTTP tools that declare they honour `Idempotency-Key`) are resent with that key and return the first result.
- **Everything else**, including MCP tools by default since MCP has no standard idempotency field, gets an **"outcome unknown"** error result, so the model can check before acting again.

## In the agent platform design, one tenant schedules 50,000 runs for 09:00. How do the others stay unaffected?
<!-- /learn/design-agent-platform#scheduling-and-fairness -->

- **Admission:** each tenant has a cap on active runs, say 500, so the batch takes 50,000 × 90 ÷ 500 seconds, **about 2.5 hours**. Schedules can accept a start window that spreads starts out.
- **Step dispatch:** runs compete one step at a time through a weighted fair queue across tenants. Steps of runs in progress go first, then new interactive runs, then scheduled ones.
- **Provider backpressure:** on 429s the scheduler halves that model's dispatch rate, then raises it steadily while calls succeed (AIMD). If queues keep growing, new scheduled runs are refused first.

## How does the agent platform size its sandbox fleet and warm pool?
<!-- /learn/design-agent-platform#tool-execution-and-sandboxes -->

About 6,250 sandbox runs are active at peak, each in its own **microVM** destroyed after the run. A 128-vCPU host fits about 298 by memory but 256 by CPU (2 vCPUs each, overcommitted 4 to 1), so CPU binds. 6,250 plus a warm pool of 100 needs 25 hosts, and with two of three zones carrying the peak that is 39 hosts, about $142,350 a month or $0.047 per sandbox run. **The warm pool scales with the start rate**: 3.47 starts a second over a 10-second refill is about 35, doubled for bursts.

## How does the agent platform's run guard stop runaway cost and loops?
<!-- /learn/design-agent-platform#cost-controls-and-runaway-loops -->

Default limits are 100 steps, $5, 4 hours and 3 million input tokens. **The guard checks before each model call and assumes the worst case**: no cache hits and a full 4,096-token reply, about $0.30 at 80,000 tokens of context. For loops it hashes each tool call together with the result that call last returned. Three identical pairs in the last six calls add a note telling the model to change approach, and five stop the run as `loop_detected`. The result is part of the hash so that polling a build until it changes doesn't count as a loop.

## Talk through a design for a platform that runs AI agents for many customers in 45 minutes. What are your four steps?
<!-- /learn/design-agent-platform -->

1. **Use cases and numbers.** Versioned agents, runs started by API, schedule or webhook, streamed progress, human approvals, built-in and customer tools (HTTP and MCP), and per-run limits. A run resumes after a crash without repeating side effects, and tenants stay isolated.
   - 4,000 tenants, 2 million runs a day (about 69 a second at peak), 30 million steps, about 17,600 active runs.
   - Input tokens grow with the square of the step count. About $19.7 million a month of model spend with caching, $100 million without.
2. **High-level design.** A run API with an agent registry, a scheduler of fair step queues, stateless run workers, a run store holding an event log, an LLM gateway, a tool runtime (sandboxes, fetch, MCP, HTTP), and event-stream servers that tail the log.
3. **Core components.**
   - An event-sourced log per run, model replies recorded before tools run, sequence-checked appends and 30-second leases.
   - Tool idempotency keys from `run_id:tool_use_id`, and "outcome unknown" for calls that aren't retry-safe.
   - A byte-stable prefix, truncated tool results and compaction for long runs.
   - A microVM per sandbox run, an egress proxy with an allowlist, and secrets held in a vault.
4. **Scale and safety.** Per-tenant run caps and fair step dispatch with AIMD on 429s, a warm sandbox pool, run guards and loop detection, approvals that release the worker, taint-based limits against the lethal trifecta, and a home region per tenant.

<!-- chapter: design-vector-database -->

## In the vector database design, how does tiered storage cut the monthly bill from about $822,000 to about $50,300?
<!-- /learn/design-vector-database#requirements-and-estimates -->

Holding HNSW over float32 for all 28 billion vectors in RAM, with two replicas, needs about 235 TB, about $822,000 a month. The tiered layout keeps every segment in object storage as the source of truth, int8 HNSW in RAM only for the warm 20% of non-huge vectors, 64-byte PQ codes in RAM for the huge indexes, and float32 vectors and metadata on NVMe. That is **about 16 times cheaper**, and it rests on one assumption to state aloud: only about 20% of non-huge vectors are queried on a given day. Check it against access logs.

## In the vector database design, why does the mutable segment seal at 5,000 vectors, and how many builder cores do merges need?
<!-- /learn/design-vector-database#segments-and-merging -->

The mutable segment and sealed ranges awaiting a build are searched by brute force. At 5,000 vectors of 1,536 dimensions that is 30.7 MB, about 3 ms of one core, so **a builder backlog shows up as query latency**. A tiered merge combines eight segments of similar size up to a 25-million cap, about 4.1 merges, so each vector is built about four times. At an assumed 2,000 HNSW inserts a second per core, 10,000 writes a second need 20 builder cores and the 60,000-a-second import peak needs 120, in a pool kept apart from queries.

## How does the vector database answer the first query to a cold namespace, and what does keeping it warm cost?
<!-- /learn/design-vector-database#separating-storage-and-compute -->

An HNSW walk over object storage would need a round trip per hop, so the cold path uses the segment's cluster layout: read the 1,000 centroids (about 56 ms), the 20 nearest clusters in parallel (about 81 ms), then float32 vectors for the best 40 to rescore (about 50 ms). **About 190 ms**, slower than the warm target but answered, while the node downloads the 1.66 GB graph in about 2 seconds. A 1-million-vector namespace costs $0.15 a month cold and $11.65 warm, about 80 times more.

## How does the vector database pick a search strategy for a filtered query on each segment?
<!-- /learn/design-vector-database#filtered-search -->

Each segment's inverted index returns a bitmap of matching rows, so **the node knows the exact match count before searching**:

- No matches: skip the segment.
- Up to 50,000 matches: scan them exactly (50,000 int8 vectors take about 8 ms) for recall 1.0.
- Half the rows or more: run the normal graph search and filter a few extra candidates.
- In between: a filtered graph walk with `ef` raised, using non-matching nodes as stepping stones.

A filter every query carries, such as `tenant_id`, belongs in the namespace instead.

## In the vector database design, why does fan-out hurt tail latency, and how does the design limit it?
<!-- /learn/design-vector-database#tail-latency-of-fan-out -->

A query is as slow as its slowest shard. If each shard meets 25 ms 99% of the time, a 16-shard query meets it only 0.99¹⁶ ≈ 85.1% of the time, so each shard would need to hit 25 ms at the 99.937th percentile. The design uses **fewer, larger shards** (a 25-million-vector cap, so a 10-million-vector namespace never fans out), **hedged requests** to another replica after a shard's p95 for about 5% more shard requests, and opt-in partial results. Each shard still returns its own top k, since the best vectors may all sit on one shard.

## In the vector database design, how does one tenant's expensive query get kept from hurting everyone else?
<!-- /learn/design-vector-database#noisy-neighbours-and-isolation -->

A filter on an unindexed field matching 60% of a 10-million-vector namespace would scan 15.4 GB of int8, about 1.5 seconds of one core, the CPU of 500 ordinary queries. Defences:

- **Cost-based admission**: a token bucket of read units per tenant and at most 32 concurrent queries per namespace.
- **Scan caps**: brute force stops at 50,000 vectors per segment, and unindexed filters are rejected.
- **Bulkheads**: separate thread pools for queries, segment downloads and log apply.
- **Dedicated pools** for huge indexes, and hot namespaces moved, which costs only a segment download.

## Talk through a design for a managed vector database in 45 minutes. What are your four steps?
<!-- /learn/design-vector-database -->

1. **Use cases and numbers.** Indexes with a fixed dimension and metric, upserts and deletes with metadata, filtered top-k, hybrid search, namespaces, backups and usage billing.
   - Writes visible within 1 second, read-your-writes on request, under 50 ms p99 at recall@10 of 0.95 for 10 million 1,536-dimension vectors.
   - 60,000 indexes holding 28.04 billion vectors, 121 TB. 50,000 queries a second at peak, 10,000 vector writes a second on average.
2. **High-level design.** A router (auth, limits, shard map), a write log replicated across three zones, segment builders, object storage holding segments and manifests, query nodes caching data in RAM and NVMe, and a control plane for placement.
3. **Core components.**
   - LSM-style storage: a brute-force mutable segment sealed at 5,000 vectors or 10 seconds, then immutable segments with int8 HNSW, float32 for rescoring, an inverted metadata index and a cluster layout.
   - Tiered merges, and tombstones checked against each ID's newest sequence number, with segments rewritten at 20% deleted.
   - A per-segment filter planner driven by exact match counts.
4. **Scale.** Tiered storage at about $50,300 a month, small namespaces kept whole and large ones split by vector-ID hash, hedged requests, a Raft-led log per partition with write tokens for read-your-writes, cost-based admission, sampled recall checks, and backups as manifest copies.

<!-- chapter: design-image-generation -->

## In the image generation design, where do the 4.57 GPU-seconds per request come from?
<!-- /learn/design-image-generation#gpu-time-per-image -->

Four images with classifier-free guidance are 8 denoiser evaluations per step. At an assumed 8 ms of overhead plus 17 ms per evaluation, a step takes 144 ms, and 30 steps take 4,320 ms. Four VAE decodes add 240 ms and the text encoder 10 ms, so **4.57 GPU-seconds a request, 1.14 an image**, about $0.00095 an image at $3 an hour with no idle time. An edit at strength 0.6 takes about 2.88 and an upscale 2.40, so the average job is about 4.18. A 4-step distilled model without guidance needs only about 0.55.

## Why does fast mode in the image generation design run only one request per batch?
<!-- /learn/design-image-generation#batching-jobs-of-the-same-shape -->

At 1024×1024, one request's 8 evaluations already keep the GPU busy. Adding a second request lifts throughput from 0.875 to 0.899 images per GPU-second, **under 3%, while latency nearly doubles** to 8.9 seconds. So fast mode runs one request per batch and relaxed mode may pair two. A request's own four images always share a batch, since running them one at a time takes 5,280 ms against 4,570. At 512×512 the fixed overhead matters more, so drafts are batched across many requests.

## How does the image generation design order its tiered queues so relaxed jobs aren't starved?
<!-- /learn/design-image-generation#tiered-queues-and-scheduling -->

Each job gets a deadline at submission: 15 seconds for fast, 600 for paid relaxed and 1,800 for free. Workers pop in strict tier order, **except that a paid relaxed job within 60 seconds of its deadline jumps ahead of fast work**, so a busy evening can't starve it. Running batches are never preempted, so a fast job on a shared worker waits at most one batch, about 4.6 seconds. Dedicated fast workers never run relaxed batches.

## In the image generation design, when does the free tier get refused, and why refuse instead of queuing?
<!-- /learn/design-image-generation#tiered-queues-and-scheduling -->

At peak, paid relaxed work needs about 182 busy GPUs and free work about 436. With the relaxed fleet capped at 450 GPUs, free work gets 268, so its backlog grows by about 168 GPU-hours in the peak hour. **When the estimated free wait passes 30 minutes, new free submissions get `429`** with a suggested time. Refusing at the door costs nothing, while dropping a job that was already accepted breaks a promise.

## Why does the image generation design run relaxed mode on spot GPUs but keep fast mode on demand?
<!-- /learn/design-image-generation#autoscaling-and-spot-gpus -->

Relaxed jobs are short and restartable and can wait. At an assumed $1.20 an hour instead of $3, relaxed mode's 6,586 GPU-hours save about $11,860 a day. A reclaim warning of 30 seconds to 2 minutes is longer than a batch, so the worker stops leasing and finishes, and an unwarned loss costs about half a job before expired leases send its jobs elsewhere. **Fast mode stays on demand because a reclaim wave at peak would break its 15-second target.** Per image, fast costs about $0.0013 and relaxed about $0.0004.

## In the image generation design, why does every GPU worker carry every model variant, and how are styles placed?
<!-- /learn/design-image-generation#memory-on-one-gpu -->

Four 7 GB model variants, an upscaler, activations for 8 evaluations, a VAE decode and 50 style adapters take about 59.5 GB of an H100's 72 GB usable. **One GPU holds five image models, so compute is the scarce resource**, and every worker can serve every variant. Styles are LoRA adapters of about 150 MB. The top 50, assumed to cover 80% of styled jobs, stay on every worker, and a rare style is mapped by consistent hashing onto 8 workers, where it stays warm.

## Talk through a design for a text-to-image generation service in 45 minutes. What are your four steps?
<!-- /learn/design-image-generation -->

1. **Use cases and numbers.** Text to image (four images at about one megapixel) with previews, edits and inpainting, 2× upscale, styles, a gallery and an API with webhooks. Prompt and image safety checks, C2PA and a watermark on every output.
   - Fast mode within 15 seconds at p95, paid relaxed within 10 minutes, free best effort.
   - 8 million jobs a day, about 231 a second at peak: 2.9 million fast, 5.1 million relaxed. About 4.18 GPU-seconds per job.
2. **High-level design.** A job API that checks auth, credits and the prompt, a jobs database holding the full recipe, tiered queues, GPU workers that batch and denoise, an image check after decode, progress fan-out, object storage and a CDN.
3. **Core components.**
   - Asynchronous jobs: `202` with a job ID, leases with retries, writes keyed by job and image index, previews every 5 steps.
   - Batches only of matching shape, one request per batch in fast mode.
   - Deadline-ordered tier queues, free work shed with `429` past a 30-minute estimated wait.
4. **Scale.** 469 on-demand H100s at the fast peak, autoscaled on queue wait, relaxed mode on spot GPUs (about $640,000 a month in all). Distilled drafts, compiled shapes, content-addressed storage with immutable CDN caching, and a retention policy that keeps the store at about 7.8 PB after a year.
