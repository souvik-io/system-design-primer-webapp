# Design a chat assistant (like ChatGPT or Claude.ai)

A chat assistant answers each message with a reply that appears word by word. The first words should arrive within about a second, and the rest keep coming while the reader follows along. The interface looks like a messaging app, but each reply needs a large model to read the whole conversation and generate new tokens, and the GPUs that run the model are the scarce, expensive resource.

The chapter builds on the handbook's AI part: [how LLM inference works](/learn/llm-inference), [inference serving engines](/learn/inference-engines), [running inference at scale](/learn/inference-fleets) and [LLM gateways](/learn/llm-gateways). For history, devices and sync, see the [chat system](/learn/design-chat-system) chapter.

## Requirements and estimates

Functional requirements:

- **Multi-turn conversations.** Each reply sees the earlier turns.
- **Streamed replies.** Text appears as the model generates it.
- **History and titles.** Users list, open, rename and delete conversations from any signed-in device.
- **Stop and regenerate.** A user can stop a reply part way, or ask for another reply to the same message.
- **Model choice.** Users pick a Large model for hard questions or a Fast model for quick ones.
- **Attachments (optional).** Files and images can be attached to a message.
- **Free and paid tiers,** with different limits and default models.

Non-functional requirements:

- The first token of a Large reply arrives within about a second at the 99th percentile (p99, the value that 99% of requests beat).
- Each stream keeps at least 30 tokens a second at peak, even with one replica lost.
- A retried send never creates a second message or reply.
- Out of scope: voice, tool use, agents and team workspaces.

These invented assumptions describe a large consumer app:

- 2 million daily active users (DAU), 10% of them paid. Free users send 10 messages a day, and paid users send 40.
- A conversation has six user messages on average. A user message averages 60 tokens, a reply 350, and the system prompt 1,200.
- Peak traffic is three times the daily average.

**Messages.** Free users send 18 million messages a day and paid users send 8 million, 26 million in all. That is 26,000,000 ÷ 86,400 s ≈ **301 messages a second** on average and about **903 at peak**. At six messages per conversation, there are about 4.3 million conversations a day.

**Model mix.** Paid users send 75% of their messages to the Large model, and free users send 25%. Large gets 6 million + 4.5 million = 10.5 million messages a day, and Fast gets 15.5 million. At peak, Large takes 3 × 10.5 million ÷ 86,400 ≈ **365 messages a second**, and Fast takes **538**.

**Prompt size.** For the k-th message in a conversation, the earlier turns are k − 1 exchanges of 60 + 350 = 410 tokens. Averaged over six messages, the history is 2.5 × 410 = 1,025 tokens, so the average prompt is 1,200 + 1,025 + 60 = **2,285 tokens**.

**Token rates at peak.** Large generates 365 × 350 ≈ 128,000 tokens a second and Fast generates 538 × 350 ≈ 188,000, about **316,000 output tokens a second** in all. Without caching, prefill would need 903 × 2,285 ≈ **2.06 million prompt tokens a second**.

**Cache hits at peak.** [Prefix caching](/learn/inference-engines#prefix-caching) skips the prefill for a prompt's start when the replica still holds it. The running example's 148 GB cache holds 148 × 10⁹ ÷ 327,680 ≈ 451,660 tokens, about 196 conversations of 2,300 tokens. At peak each Large replica takes about 8 new messages a second, so an idle conversation's cache survives about 196 ÷ 8 ≈ 24 seconds. Assume most users pause longer than that, so only a quarter of history tokens hit at peak, while the system prompt always hits. That gives 1,200 + 0.25 × 1,025 ≈ 1,456 cached tokens (64% of the prompt) and **829 uncached tokens** to prefill.

**Replicas.** A **replica** is one copy of a model on its own GPUs, and a **pool** is a group of identical replicas. A Large replica runs the 70B model on four H100s. Its 140 GB of 16-bit weights leave 148 GB for the cache. A Fast replica runs the 8B model on one H100, leaving 56 GB of its 72 GB usable. A stream averages about 2,500 tokens of context while decoding, so it costs 0.82 GB of cache on Large and 0.33 GB on Fast. Memory caps a replica at 180 Large streams and 170 Fast streams, but at peak decode time and prefill are the tighter limits.

At 50% of peak math, prefill takes 140 GFLOP ÷ (4 × 989 TFLOPS × 0.5) = 70.8 µs per token on Large and 32.4 µs on Fast, so the 829 uncached tokens take about 59 ms and 27 ms. A decode step with B streams reads the weights and every stream's cache, which takes (140 + 0.82B) ÷ 13,400 s on Large and (16 + 0.33B) ÷ 3,350 s on Fast. If prefill takes a share p of a replica's time, decode must produce the rest of the output: (1 − p) × B ÷ step(B) tokens a second. Solving that for the smallest pool that keeps 30 tokens a second per stream at peak gives this:

| Pool | Replicas provisioned | Share of time on prefill | Streams per replica | Tokens/s per stream | Tokens/s per stream with one replica lost |
|---|---|---|---|---|---|
| Large (70B, 4 H100s each) | 44 | 49% | 90 | 32 | 31 (43 replicas) |
| Fast (8B, 1 H100 each) | 40 | 36% | 126 | 37 | 33 (39 replicas) |

Each provisioned count is one more than the smallest pool that meets the target, so losing a replica still leaves enough. The design needs 44 × 4 + 40 = **216 H100s**. [Little's law](/learn/performance-and-latency#littles-law) agrees with the solver: 365 × (0.3 s + 350 ÷ 32.2) ≈ 4,070 Large streams, about 92 per replica, and 538 × (0.15 s + 350 ÷ 37.4) ≈ 5,120 Fast streams, about 128 per replica. Both are within 3% of the solver.

The cache assumption dominates, so here is the sizing at two other peak hit rates:

| History hits at peak | Uncached prompt tokens per message | Large replicas | Fast replicas | H100s |
|---|---|---|---|---|
| 50% | about 570 | 34 | 35 | 171 |
| 25% (this design) | 829 | 44 | 40 | 216 |
| 0% | 1,085 | 54 | 45 | 261 |

**Cost and storage.** 216 H100s at an assumed $3 an hour cost 216 × $3 × 730 hours = **$473,040 a month**. Over 780 million messages a month, that is about $0.0006 a message, or $0.0036 for a six-message conversation. Average load is about a third of peak, and [cold starts](/learn/inference-fleets#loading-models-quickly) limit how closely a fleet can follow the daily curve. An exchange takes about 2 KB, so history grows by about 52 GB a day, or 19 TB a year (57 TB with three copies). The [chat system](/learn/design-chat-system) chapter sized 300,000 writes a second, while this design writes 903 at peak, so the GPUs set the size of this system. Titles come from one short Fast call per conversation, about 4.3 million calls a day of roughly 400 prompt tokens each, which adds about 5% to the Fast pool's prompt volume.

## API design

Sending a message is a POST whose response is a [server-sent event](/learn/realtime#server-sent-events-sse) (SSE) stream, one HTTP response carrying text events from server to client. A browser's `EventSource` object only issues GET requests, so the app reads the POST response with `fetch`. A reconnect is a GET with a `Last-Event-ID` header. Stopping a reply is an ordinary request.

| Call | Purpose |
|---|---|
| `POST /v1/conversations/{id}/messages` | Send a message and stream the reply. The body names the model, the parent message and any attachments. |
| `GET /v1/generations/{gid}/stream` | Resume a stream after a dropped connection, from the last event ID the client saw. |
| `POST /v1/generations/{gid}/cancel` | Stop a reply. A second call has no further effect. |
| `POST /v1/conversations/{id}/messages` with `regenerate_of` | Make a new reply to the same user message. |
| `GET /v1/conversations`, `PATCH` and `DELETE` on `/v1/conversations/{id}` | List (with a cursor), rename and delete conversations. |

A send, abridged. Each event's `id` is a token offset, so a resume can pick up where the stream stopped.

```http
POST /v1/conversations/c_8f2d/messages HTTP/1.1
Authorization: Bearer <session token>
Idempotency-Key: 7b1e0c52-3a9f-4d1e-9c0b-2f6a8e41d5b7
Accept: text/event-stream
Content-Type: application/json

{"content": "Summarize this contract in five bullets.",
 "model": "large", "parent_id": "m_1042", "attachments": ["f_93a1"]}
```

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream

event: start
data: {"message_id": "m_1043", "generation_id": "g_5530"}

event: delta
id: 17
data: {"text": "Five points"}

event: end
data: {"finish_reason": "end_turn", "input_tokens": 2310, "cached_tokens": 1880, "output_tokens": 298}
```

The `Idempotency-Key` header makes a send safe to retry, as the [idempotency keys](/learn/reliability-patterns#idempotency-keys) section describes. The server keeps the key with its message and generation IDs for 24 hours. A retry rejoins the running generation or receives the stored reply, and it never creates a second user message.

A normal send names the **active leaf** as its `parent_id`. Each message points to the message it answers, so a conversation is a tree, and the active leaf is the last message on the branch the user is viewing. Regenerating adds a sibling reply and moves the active leaf to it. A send whose parent is no longer the active leaf gets `409 Conflict`, which stops two devices from interleaving writes unnoticed.

## Data model and storage

Every query reads one user's data, so the data is sharded by `user_id`, and a user's conversations and messages share one shard.

```sql
CREATE TABLE messages (
  user_id       BIGINT       NOT NULL,   -- shard key
  conv_id       UUID         NOT NULL,
  msg_id        BIGINT       NOT NULL,   -- time-ordered, see unique IDs
  parent_id     BIGINT,                  -- the message this one answers
  role          VARCHAR(9)   NOT NULL,   -- 'user' or 'assistant'
  content       TEXT         NOT NULL,
  model         VARCHAR(16),             -- 'large' or 'fast' on replies
  finish_reason VARCHAR(16),             -- end_turn, max_tokens, cancelled, error
  input_tokens  INT,
  cached_tokens INT,
  output_tokens INT,
  created_at    TIMESTAMP    NOT NULL,
  PRIMARY KEY (user_id, conv_id, msg_id)
);
```

A `conversations` row holds the title, model preference, active leaf, rolling summary and the last message that summary covers. A new message and its conversation update commit in one transaction on that shard. The [unique IDs](/learn/unique-ids) chapter covers `msg_id`.

Attachments go to object storage, and the context builder extracts their text later. Image attachments need a model that accepts images, which the sizing above leaves out. Generation records hold a stream's state and token offset, expire within minutes, and live in a fast key-value store. The gateway writes one usage row per request to an append-only log for billing.

## High-level design

```diagram
title: One message, from the browser to a replica and back
[c:client] Browser or app @ 0,1
[edge] Edge and API\nauth, tier limits @ 1,1
[conv] Conversation\nservice @ 2,1
[hist:store] History store\nper user shard @ 2,0
[ctx] Context builder\nfits the budget @ 3,1
[gw] LLM gateway\nroutes, budgets @ 4,1
[large] Large pool\n70B, 4 GPUs each @ 4,0
[fast] Fast pool\n8B, 1 GPU each @ 4,2
c <-> edge : HTTPS, SSE
edge -> conv : send
conv <-> hist : read, write
conv -> ctx : history
ctx -> gw : prompt
gw <-> large : prompt, tokens
gw <-> fast : prompt, tokens
```

Step by step:

1. The app posts the message with an idempotency key. The edge terminates TLS, checks the session and forwards the request, and the API layer applies the tier's limits.
2. The conversation service checks ownership and that `parent_id` is the active leaf. It writes the user message and a generation record, then starts the stream.
3. The context builder reads the active path, the summary and any memory, and fits them into the window. It renders the model's chat template, which wraps each turn in control tokens, and counts tokens with the served tokenizer.
4. The gateway maps the model name to a pool, reserves tokens against the user's budget and forwards the prompt. The router prefers the replica that already holds the conversation's history, if it has room.
5. The replica prefills and decodes, and each token passes back through the gateway and the edge as an SSE event.
6. The gateway settles the reservation and writes the usage row. The conversation service stores the reply with its token counts and finish reason.

## Context window management

The window is 32,768 tokens, and each request reserves 1,024 for the reply. The system prompt takes 1,200 of the remaining 31,744, which leaves 30,544 for memory, the summary and the turns. Each prompt has a fixed layout:

```text
[ system prompt          1,200 tokens   shared by every request       ]
[ memory block           up to 500      per user, changes rarely      ]
[ summary of old turns   up to 800      per conversation, changes     ]
[ recent turns           oldest first   a new exchange is appended    ]
[ new user message       about 60       always uncached               ]
```

The layout is chosen for the cache. The system prompt and memory come first, so they match for every message from a user. The summary changes only when turns move into it, and recent turns change only when turns are dropped, so a new message appends to a prefix the engine has already processed.

An average conversation never reaches the limit, since the budget holds about 30,544 ÷ 410 ≈ 74 exchanges. Longer ones need two rules. Drop old turns in blocks of four, because dropping one per message changes the start of the history on every request, and the cache for those turns never hits. Summarize what leaves: a background job on the Fast pool reads the old summary plus four turns (about 2,440 tokens) and writes at most 400, so the cost is paid once per four turns.

The function below keeps the newest whole turns that fit.

```python
def fit_history(turns, room, count):
    """Return (kept, dropped): the newest whole turns that fit in `room` tokens.

    Old turns leave in blocks of four, so the cached prefix changes once every
    four messages instead of on every message.
    """
    kept, used = [], 0
    for turn in reversed(turns):            # newest first
        size = count(turn)
        if used + size > room:
            break
        kept.append(turn)
        used += size
    dropped = len(turns) - len(kept)
    if dropped:
        dropped = -(-dropped // 4) * 4      # round up to a whole block of four
    return turns[dropped:], dropped


turns = [f"turn {i}" for i in range(10)]    # ten exchanges, 100 tokens each
kept, dropped = fit_history(turns, room=550, count=lambda t: 100)
print(len(kept), dropped, kept[0])          # 2 8 turn 8
```

The caller passes `room` as the 30,544-token budget minus the memory, the summary and the new message. It passes `count` as the served tokenizer run on the rendered template, since counting four characters per token misses badly on code and on many languages.

## Streaming and cancellation

Each hop (engine, gateway, edge and app) must forward events as they arrive, or a buffering proxy hides the stream (see [streaming through a gateway](/learn/llm-gateways#streaming-through-a-gateway)). The edge sends a ping every 10 seconds when no tokens are flowing, so a long prefill does not look like a dead connection.

```diagram
title: A reply streams through four hops. A stop reaches the replica, and a dropped connection waits 10 seconds.
[c:client] Browser or app @ 0,1
[e] Edge relay\nSSE, pings @ 1,1
[g] LLM gateway\nforwards, settles @ 2,1
[p] Replica\nprefill, decode @ 3,1
[rec:store] Generation\nrecord @ 2,2.5
c <-> e : POST, SSE
e <-> g : events, cancel
g <-> p : prompt, tokens
g --> rec : offset, state
```

A reply ends in one of three ways:

1. **Finished.** The model emits its stop token or reaches the reply limit. The gateway settles the reservation and stores the reply with its finish reason.
2. **Stopped.** The app calls the cancel endpoint. The gateway aborts the engine request, the engine drops the sequence at its next step and returns its KV blocks to the pool, and the partial reply is stored with the finish reason `cancelled`. Tokens produced so far are billed, and later turns include the partial text, so the model sees what the user already read.
3. **Dropped.** The connection closes without a stop. The edge keeps the generation for a 10-second grace period and buffers its tokens. A reconnect with `Last-Event-ID` inside that window replays the missed events, and the reply continues from the same token. Otherwise the edge cancels, as in the second case.

Mobile connections often drop for a few seconds, and a restarted reply would prefill again and could read differently, since sampling is random. At 32 tokens a second, the grace period wastes at most about 320 tokens per dropped stream.

## Limits, tiers and admission at peak

Product limits describe the plan. Free users get 10 Large messages a day and paid users get 200. Fast messages are capped at 40 per three hours for free users and 400 for paid users. Token limits protect the GPUs, and the gateway enforces them with the reserve-then-settle method from [token-based rate limits](/learn/llm-gateways#token-based-rate-limits). Each message reserves its prompt plus `max_tokens` (1,024 for free users, 4,096 for paid), and the unused part is settled afterwards. No user may have more than two generations in flight.

At peak a Large replica holds about 90 streams, and demand the pools cannot absorb waits in a queue. The gateway estimates each pool's wait from its waiting requests and completion rate, as the [fleet chapter](/learn/inference-fleets#routing-requests) describes. When the free-tier estimate passes two seconds, free requests get `429 Too Many Requests` with `Retry-After`, and paid requests move ahead, following the [priorities and fairness](/learn/inference-fleets#priorities-and-fairness) rules. Overload also degrades in steps: free Large requests fall back to Fast with a notice, and free `max_tokens` drops to 1,024.

## Safety and moderation in the stream

Input checks run before any pool sees a request: size limits, tier policy, and screening of text extracted from uploads, which can carry [prompt injection](/learn/ai-security#prompt-injection). The reply is harder to check. OpenAI's [moderation guide](https://developers.openai.com/api/docs/guides/moderation) notes that for a streamed reply, classifier scores arrive only once the full output exists.

This design checks the stream in windows. Each window of 256 generated tokens, about 8 seconds of text, goes to a classifier that runs beside the stream. A flagged window makes the relay send an error event with a replacement notice, cancel the generation and keep the text for review. A final check covers the whole reply. The trade-off is that one window can show before a flag lands. Waiting for the whole reply would delay the first visible token by its full length, about 11 seconds for a 350-token reply. The classifier reads every output token, so its pool is sized from the peak rate of about 316,000 tokens a second.

## Multi-region and failover

Each user has a home region, chosen at sign-up, where their conversations are written. A second region keeps an asynchronous copy within seconds, and each region runs its own pools.

```diagram
title: Each user has a home region. The other region holds a copy, and a hosted model is the last resort.
[u:client] Browser or app @ 0,1
[dns] Global routing\nhome region @ 1,1
[ra] Region A (home)\nfleet and history @ 2,0
[rb] Region B\nhistory copy @ 2,2
[hp:store] Hosted API\nfallback model @ 4,1
u -> dns : HTTPS
dns -> ra : home users
dns --> rb : failover
ra <-> rb : replicates history
ra --> hp : pool down
```

Failover has three parts. If the home region is unreachable, the second region serves the user from its copy. Messages sent in the seconds before the failure may be missing from that copy, so the app sends its last known message ID, and the server works out the gap. The idempotency key keeps any resend safe.

Capacity is the second part. If each region carries half the users, losing one doubles the other's peak. Either each region is sized for the full peak, which doubles the cost, or the survivor sheds free traffic until the failed region returns.

The third part is model failover. The Large alias can list a hosted provider after the pool, under the [routing and fallbacks](/learn/llm-gateways#routing-and-fallbacks) rules. An hour of peak Large traffic is about 1.31 million messages. At the assumed $3 and $15 per million input and output tokens, with 2,300 input and 350 output tokens each, that hour costs about $15,900. The Large pool costs $528 an hour (176 H100s at $3), so the fallback costs about 30 times as much. A spend cap and an alert belong in the design before the first outage.

## Observability and cost per conversation

Track four groups of numbers for each pool and tier. **Speed:** time to first token (TTFT, the wait before the first token) and time per output token (TPOT, the average gap between later tokens), both at p50 and p99, plus queue wait. Alert when TPOT rises above its healthy baseline, as the [metrics to watch](/learn/ai-evals-and-observability#metrics-to-watch) section advises. **Load:** the prefix hit ratio (cached input tokens over input tokens), the prefill share and preemptions. The hit ratio matters most, since the sizing depends on it. **Quality and safety:** finish reasons, cancels per 1,000 streams and moderation flags. **Cost:** spend per tier and per conversation.

Each message is one trace, with child spans for the history load, the context build (tokens in, cached tokens, whether a summary was used), routing, the engine call, moderation and storage. The engine span carries the [GenAI attributes](/learn/ai-evals-and-observability#the-genai-attributes), such as `gen_ai.usage.cache_read.input_tokens`. Message text stays out of traces by default, under the [content and privacy](/learn/ai-evals-and-observability#content-and-privacy) rules.

Cost per conversation comes from the ledger. Each usage row records tokens by kind and the pool that served it, and each pool's hourly cost is spread over the messages it served. At this volume that is about $0.0036 for a six-message conversation.

## Memory and personalization (optional deep dive)

Some products remember facts across conversations. Keep that memory apart from the history, and keep it small.

- **Storage.** Short facts the user asked the assistant to keep, such as "prefers metric units", each with its source message ID and an expiry. The user can view, edit and delete them.
- **Writing.** A background job on the Fast pool proposes facts from finished conversations, and the user confirms each one. Writing in the reply path would add latency and could store something the user never meant to keep.
- **Reading.** A short list is injected whole after the system prompt. A long list is stored as [embeddings](/learn/vector-search), and the closest facts are retrieved. The user-ID filter applies before the model sees anything, as the [permissions at retrieval time](/learn/rag#permissions-at-retrieval-time) rule requires.
- **Cost.** Memory is cached per user, so the eviction problem applies to it too. Five facts of about 30 tokens add 150 tokens, while a 500-token block would add 60% to the uncached prefill at peak (500 ÷ 829).
- **Deletion and sharing.** Deleting a fact also removes it from any summary built from it. The system prompt holds no user data, so sharing its cache is defensible, but everything after it stays per user, as the [leaking data](/learn/ai-security#leaking-data) section explains.

## Trade-offs to discuss

- **Summaries vs truncation.** Truncation is cheap but silently forgets. Summaries keep the gist, but each is a model call, and a wrong summary carries into later replies. The design does both.
- **Server-side vs device-side history.** Server storage gives every device the same history and makes memory and billing possible, but the service then holds private conversations for a year.
- **Grace period vs immediate cancel.** The grace period wastes up to about 320 tokens per dropped stream. Cancelling at once saves that, but each network blip then restarts a reply that may read differently.
- **Shared vs salted system-prompt cache.** Sharing saves about 1,200 tokens of prefill on each cold replica. Salting every cache by user closes the cross-user timing channel, at the cost of more prefill.
- **Peak-sized fleet vs autoscaling.** A fleet sized for peak runs at about a third of capacity on average. A new replica needs about 88 seconds on a warm node and 209 on a cold one (the fleet chapter's estimates), so autoscaling needs a warm pool and admission control.
- **Own pools vs hosted models.** Own pools cost $473,040 a month at this volume. Hosted models cost many times more per hour of peak traffic, but own pools bring engine upgrades, GPU failures and capacity planning.
- **Large vs Fast for free users.** Fast saves most of the cost, but the answers differ in quality. The model picker should show which model replied.

## Check yourself

<details>
<summary>The Large pool is sized with 25% of history tokens hitting the cache at peak. If that rate fell to zero, how many H100s would the design need?</summary>

Each message would need 2,285 − 1,200 = 1,085 uncached tokens, up from 829. The pools would need 54 Large and 45 Fast replicas, including the spares, or 261 H100s instead of 216. The hit rate sizes the fleet, so measure it first after launch.

</details>

<details>
<summary>A Wi-Fi drop cuts a reply off, and the app reconnects with a Last-Event-ID of 212. What happens? What changes if the app returns 40 seconds later?</summary>

Within the 10-second grace period, the edge replays the events after token 212, and the reply continues from the same token with no new prefill and no new sample. After 40 seconds the generation has been cancelled, so the resume call returns `410 Gone`. The app loads the stored partial reply, saved with the finish reason `cancelled`, and offers to continue or regenerate.

</details>

<details>
<summary>Why does the context builder drop old turns in blocks of four instead of one per message?</summary>

A cached prefix stops matching at the first block that changes, so everything after a dropped turn must be processed again. Dropping one turn per message changes the start of the history on every request, so those turns never hit the cache. Dropping four at a time moves the prefix every fourth message, and the cache works for the three messages in between.

</details>

<details>
<summary>At peak, p99 time to first token on the Large pool rises from 1 second to 6 seconds, but TPOT has not moved. What do you check first?</summary>

Unchanged TPOT means decoding is healthy, so the wait is before the first token. Check the prefix hit ratio first. A falling ratio raises the uncached prefill per message and pushes the prefill share above its designed 49%. Restoring the ratio helps most, by keeping histories short and routing each conversation to the replica that holds it. Chunked prefill, more replicas and a separate prefill pool come after that.

</details>

<details>
<summary>The Large pool is down for an hour at peak, and the gateway sends its traffic to a hosted model at $3 per million input tokens and $15 per million output tokens. What does that hour cost, compared with the pool?</summary>

The hour carries about 1.31 million messages. Input costs 1.31 million × 2,300 × $3 ÷ 1,000,000 ≈ $9,040, and output costs 1.31 million × 350 × $15 ÷ 1,000,000 ≈ $6,880. The total is about $15,900, against $528 an hour for the pool, so a spend cap on the fallback route should exist before the first outage.

</details>

<details>
<summary>Why check moderation on windows of 256 tokens rather than waiting for the whole reply?</summary>

Waiting for the whole reply delays the first visible token by its full length, about 11 seconds for a 350-token reply at 32 tokens a second. Windows keep text flowing, at the cost that one flagged window, about 8 seconds of text, can show before the stream stops. Smaller windows shrink that exposure and add classifier calls, so the window size is a product decision to test on real traffic.

</details>

## Further reading

- [Kwon et al., PagedAttention (SOSP 2023)](https://arxiv.org/abs/2309.06180): block-based KV cache memory, and how much fixed reservations waste.
- [Yu et al., Orca (OSDI 2022)](https://www.usenix.org/conference/osdi22/presentation/yu): iteration-level scheduling, so a finished stream leaves the batch at once.
- [Mooncake (arXiv 2407.00079)](https://arxiv.org/abs/2407.00079): pooling KV cache across CPU memory and SSDs.
- [vLLM prefix caching design](https://docs.vllm.ai/en/latest/design/prefix_caching.html): how block hashes chain together and how blocks are evicted.
- [Anthropic, Streaming Messages](https://platform.claude.com/docs/en/api/messages-streaming): a real event stream, with ping and error events.
- [OpenAI, Moderation](https://developers.openai.com/api/docs/guides/moderation): the categories, and the caveat about streamed replies.
- [HTML Standard: Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html): the event format, reconnection and `Last-Event-ID`.
