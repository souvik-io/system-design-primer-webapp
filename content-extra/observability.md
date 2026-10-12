# Monitoring, logging and tracing

A system you can't see into is a system you can't run. When checkout gets slow at 2 a.m., someone needs to answer three questions fast: is it actually broken for users, where is it broken, and why. Observability is the practice of building systems so those questions have answers. You emit the right signals, keep them affordable, and alert people only when users are hurting.

In interviews, monitoring usually shows up near the end ("how would you know this is working?") or as a dedicated question like "design a metrics and alerting system". A strong answer is specific. It names the few numbers that define health for this product, explains how alerts fire, and shows you know what it costs to collect everything.

## Metrics, logs and traces

The three classic signals each answer a different question.

| Signal | What it is | Question it answers | Cost profile |
|---|---|---|---|
| **Metrics** | Numbers aggregated over time: counters, gauges, histograms, each with a few labels | Is something wrong? How much? Since when? | Cheap per event, since you store aggregates. Cost grows with the number of distinct label combinations. |
| **Logs** | One record per event, with whatever detail you choose | What exactly happened to this request or this user? | Expensive, since cost grows with traffic. |
| **Traces** | A tree of timed spans for one request as it crosses services | Where did the time go, and which hop failed? | Expensive per request, so usually sampled. |

They work as a funnel. A metric tells you the error rate on the payments service jumped at 02:10. A trace of a failing request shows the time going into a call to the fraud-check service. That service's logs, filtered by the trace id, show it timing out against a database replica. Connecting the three, mostly by putting the same trace id in logs and traces, is what turns them from three tools into one investigation.

Continuous profiling (sampled CPU and memory profiles from production) is increasingly treated as a fourth signal. It answers "which code is burning the CPU?", which none of the other three can.

```diagram
title: A typical telemetry pipeline. Services emit all three signals through a collector to separate stores
[svc] Services\n+ OTel SDK @ 0,1
[col] Collector\n(batch, sample) @ 1,1
[m:store] Metrics store @ 2,0
[l:store] Log store @ 2,1
[t:store] Trace store @ 2,2
[al] Alert rules\n(SLO burn) @ 3,0
[pg:client] On-call @ 4,0
[ui] Dashboards,\nsearch @ 3,1
svc -> col : OTLP
col -> m
col -> l
col -> t
m -> al
al -> pg : page
ui -> m
ui -> l
ui -> t
```

## What to measure: RED, USE and SLOs

### RED and USE

You can't graph everything usefully, so start from two checklists.

The **RED method** (from Tom Wilkie) is for anything that serves requests. For every service, track:

- **Rate**: requests per second.
- **Errors**: failed requests per second, or the fraction that fail.
- **Duration**: the latency distribution, as percentiles.

The **USE method** (from Brendan Gregg) is for resources: CPUs, disks, network links, connection pools, queues. For each one, track:

- **Utilization**: how busy it is, as a percentage of time or capacity.
- **Saturation**: work waiting that it can't serve yet, such as run-queue length, queue depth or pool waiters.
- **Errors**: device or resource errors.

RED tells you users are affected. USE tells you which resource is the bottleneck. Google's SRE book uses a similar list called the four golden signals: latency, traffic, errors and saturation. For asynchronous pipelines (see [message queues](/learn/asynchronism#message-queues)), add queue depth and especially **the age of the oldest unprocessed message**, which shows user-visible delay in a way depth alone doesn't.

### SLIs, SLOs and error budgets

- An **SLI** (service level indicator) is a measured ratio of good events to total events. Example: the fraction of checkout requests that succeed in under 400 ms.
- An **SLO** (objective) is the target for that SLI over a window. Example: 99.9% over 30 days.
- An **SLA** is a contract with consequences if you miss, usually set looser than the SLO.

The gap between the SLO and 100% is the **error budget**. At 99.9% over 30 days:

- In time: 30 days × 24 h × 60 min = 43,200 minutes, and 0.1% of that is 43.2 minutes of full outage.
- In requests: at 500 million requests a month, 0.1% is 500,000 requests allowed to be slow or fail.

The budget turns reliability arguments into a number. If the budget is mostly unspent, ship faster and take risks. If it's gone, slow down and fix reliability. It also stops teams from chasing 100%, which no system reaches, and which costs a lot more than users notice. The [availability numbers](/learn/availability-patterns#availability-in-numbers) table in the primer shows how quickly each extra nine shrinks the allowed downtime.

### Percentiles, not averages

Averages hide exactly the users you care about. Suppose 100 requests take these times: 95 take 50 ms and 5 take 2,000 ms.

- Mean: (95 × 50 + 5 × 2,000) / 100 = (4,750 + 10,000) / 100 = 147.5 ms. Not a single request took that long.
- Median (p50): 50 ms.
- p99: 2,000 ms. One in twenty users waited 2 seconds, and the mean barely hints at it.

So report p50, p95 and p99 (and p99.9 for high-volume paths). Two practical rules follow.

First, **you can't average percentiles.** The p99 of a fleet isn't the mean of each host's p99. Record latency as a histogram with fixed buckets, which you can add up across hosts and then read percentiles from. Prometheus histograms work this way. Precomputed per-host quantiles (Prometheus "summaries") can't be combined correctly.

Second, **tails compound under fan-out.** If a page makes 100 backend calls in parallel and waits for all of them, and each call is slow 1% of the time, the chance that at least one is slow is 1 − 0.99¹⁰⁰ ≈ 1 − 0.366 ≈ 63%. The backend's p99 becomes the page's typical case. That's why per-hop p99 matters even when it looks rare.

## Alerting on symptoms

Every page should mean "users are hurting, or soon will be, and a human must act now". Anything else trains people to ignore pages.

- **Page on symptoms**: SLO violations, error rates and latency that users feel. Users don't care that CPU is at 90% if requests are fast.
- **Use causes for diagnosis**: CPU, memory, disk and replica lag belong on dashboards, or in low-urgency tickets when they predict trouble (a disk will be full in four days).
- **Alert on burn rate, not raw thresholds.** Burn rate is how fast you're spending the error budget relative to plan. A burn rate of 1 uses exactly the 30-day budget in 30 days. For a 99.9% SLO, a burn rate of 14.4 means an error rate of 14.4 × 0.1% = 1.44%. Sustained for one hour, it spends 14.4 × 1 h / 720 h = 2% of the monthly budget. That's worth a page. A burn rate of 1 sustained for days is worth a ticket. The Google SRE workbook recommends pairing a long window with a short one (say 1 hour and 5 minutes), so alerts fire fast and also clear quickly once the problem stops.
- **Every alert needs an owner and a runbook.** If nobody knows what to do when it fires, it isn't ready to page anyone.

## Logs and traces in practice

### Structured logs

Write logs as key-value records, usually JSON, instead of free-form sentences. Then you can filter and aggregate them without fragile regexes.

```json
{"ts":"2026-03-04T02:10:41.512Z","level":"error","service":"payments",
 "msg":"fraud check timed out","order_id":"o_88213","timeout_ms":800,
 "trace_id":"7d3f9a12c4e85b60a1f2d3c4b5a69788"}
```

Always include the trace id. It's the join key between a log line and the request that produced it. Never log secrets, full card numbers or passwords, and treat personal data in logs as personal data, since logs get copied everywhere.

### Sampling

Logs and traces scale with traffic, so volume adds up quickly. Take a service at 20,000 requests per second that writes about 1 KB of logs per request:

- 20,000 × 1 KB = 20 MB/s.
- 20 MB/s × 86,400 s/day ≈ 1.7 TB per day, before replication and indexing.

Traces are worse. At 15 spans per request and roughly 500 bytes per span, 20,000 × 15 × 500 B = 150 MB/s, or about 13 TB per day. You sample:

- **Head sampling** decides at the start of a request, for example "keep 1% of traces", and passes the decision downstream so every service agrees. It's cheap, but it decides before anyone knows whether the request will be interesting.
- **Tail sampling** buffers all spans of a trace in a collector until the trace finishes, then keeps it if it was slow or failed, plus a small random share of normal traces. You keep the interesting traces, but the collectors must hold every span briefly, and all spans of a trace must reach the same collector.
- For logs, keep every warning and error, and sample or aggregate routine success lines.

### Distributed tracing

A **trace** is one request's journey through the system. It's made of **spans**, one per unit of work (an HTTP handler, a database query, a queue publish). Each span records a start time, a duration, a trace id, its own span id and its parent's span id. The parent links let the trace view rebuild the tree and draw the familiar waterfall. Google's Dapper paper described this model, and most tracing systems since have followed it.

For this to work across services, the context has to travel with the request. The **W3C Trace Context** standard defines a `traceparent` HTTP header:

```text
traceparent: 00-7d3f9a12c4e85b60a1f2d3c4b5a69788-3e1f0a9b8c7d6e5f-01
```

The four dash-separated fields are the version (`00`), the trace id (16 bytes as 32 hex characters, shared by every span in the trace), the parent span id (8 bytes as 16 hex characters) and flags (`01` means sampled). Each service reads the incoming header, creates a child span and sends a new `traceparent` downstream with its own span id as the parent. A companion `tracestate` header carries vendor-specific data. For asynchronous hops, put the same context in message headers or metadata, so a trace can follow a request through a queue to the consumer that processes it.

**OpenTelemetry** is the vendor-neutral way to do all of this. It provides APIs and SDKs for most languages, automatic instrumentation for common frameworks, a wire protocol (OTLP) and the Collector, a service that receives, batches, samples and forwards telemetry to whatever backends you use. Instrumenting with OpenTelemetry means you can switch backends without touching application code.

## Cardinality and cost

In a metrics system, every unique combination of metric name and label values is a separate **time series**, with its own storage and index entries. The number of series is the product of each label's distinct values. Take `http_requests_total` labelled by:

- method (5) × status code (10) × endpoint (50) × instance (200) = 500,000 series.

That's manageable. Now add a `customer_id` label with 10,000 customers. In the worst case that's 500,000 × 10,000 = 5 billion series. Even if only a fraction of those combinations ever occur, it's enough to make queries slow, run up a large bill or knock over the metrics backend. The Prometheus documentation warns against exactly this: don't put user ids, email addresses or other unbounded values in labels.

Rules of thumb:

- Labels should have small, bounded sets of values: region, status class, endpoint template (`/orders/{id}`, never `/orders/88213`).
- High-cardinality detail (user id, order id, request id) belongs in logs and trace attributes, where you pay per event, not per series.
- Watch the series count itself as a metric, and set limits per team or per service.
- Retention is a cost lever too. Keep raw data for days, and downsampled rollups for months.

## Monitoring in an interview

You rarely have more than a few minutes for this, so be concrete:

1. **Name the SLIs for this product.** For a URL shortener: redirect success rate and p99 redirect latency. For a chat app: the share of messages delivered within 1 second. For a payments flow: the checkout success rate. One or two user-centred numbers beat a list of twenty.
2. **State the SLO and what pages.** "99.9% of redirects succeed in under 100 ms over 30 days. We page on fast burn of the error budget."
3. **Give each component its dashboard.** RED for every service, USE for databases, caches and queues, plus consumer lag and the age of the oldest message for every async pipeline.
4. **Mention tracing and correlation.** OpenTelemetry instrumentation, `traceparent` propagated through HTTP and queue messages, and trace ids in structured logs.
5. **Show you know the costs.** Sample traces, keep labels low-cardinality, and set retention tiers.

If the question is "design a metrics system" itself, the deep dives are a write-heavy time-series store (append-only, compressed, partitioned by time), the collection model (agents pushing versus a server pulling, as Prometheus does), the rule evaluator that turns queries into alerts, and the cardinality limits that keep it alive.

## Check yourself

<details>
<summary>Your service's mean latency is flat at 80 ms, but support tickets about slowness doubled this week. What could explain it, and what would you look at?</summary>

The mean hides the tail. A small fraction of requests could have become very slow while most got slightly faster, leaving the mean unchanged. Look at p95, p99 and p99.9 from a latency histogram, broken down by endpoint and region, then pull traces of slow requests to see which hop the time goes to.

</details>

<details>
<summary>An engineer proposes paging on-call whenever any database host's CPU goes above 85%. What's wrong with that, and what would you suggest?</summary>

CPU is a cause, not a symptom. High CPU might not hurt users at all, and users can be hurting while CPU is fine, so the alert will be noisy and miss real problems. Page on user-facing SLIs such as error rate and latency against an SLO, preferably on error-budget burn rate. Put database CPU on a dashboard for diagnosis, and maybe raise a ticket if it trends toward saturation.

</details>

<details>
<summary>Your SLO is 99.95% of requests succeed over 30 days, and you serve 200 million requests a month. How many failed requests is your error budget, and roughly what error rate would spend it in 3 days?</summary>

The budget is 0.05% of 200 million: 200,000,000 × 0.0005 = 100,000 failed requests. Spending all of it in 3 days instead of 30 is a burn rate of 10, so the error rate would be about 10 × 0.05% = 0.5%, assuming traffic is evenly spread.

</details>

<details>
<summary>A team adds a `user_id` label to their request-latency histogram so they can debug individual customers. Six hours later the metrics backend is struggling. Why, and how should they get per-user visibility instead?</summary>

Each distinct user id creates a new series for every histogram bucket and every other label combination, so the series count multiplies by the number of active users. That explodes memory and index size. Remove the label, and record the user id as an attribute on traces and in structured logs instead, where cost scales with events, not with distinct combinations. Then find a user's slow requests by searching logs or traces.

</details>

<details>
<summary>A request goes from the API to an order service, which publishes to a queue, and a worker later charges the card. The trace stops at the queue. What's missing?</summary>

The trace context isn't propagated across the asynchronous hop. The publisher must write the `traceparent` (and `tracestate`) into the message headers, and the worker must extract it and start its span as a child of, or linked to, the publishing span. OpenTelemetry instrumentation for many messaging clients does this, but custom queue code has to do it by hand.

</details>

## Further reading

- [Google SRE book: Monitoring distributed systems](https://sre.google/sre-book/monitoring-distributed-systems/): the four golden signals and symptom-based alerting.
- [Google SRE workbook: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/): burn rates and multiwindow alerts, worked through step by step.
- [Brendan Gregg: The USE method](https://www.brendangregg.com/usemethod.html): the original description, with checklists per resource.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/): the `traceparent` and `tracestate` headers.
- [OpenTelemetry documentation](https://opentelemetry.io/docs/): concepts, SDKs and the Collector.
- [Prometheus: Metric and label naming](https://prometheus.io/docs/practices/naming/): includes the warning about high-cardinality labels.
- [Prometheus: Histograms and summaries](https://prometheus.io/docs/practices/histograms/): why histograms can be aggregated and summaries can't.
- [Dapper, a large-scale distributed systems tracing infrastructure](https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/): Google's 2010 paper behind modern tracing.
- Alex Xu, *System Design Interview – An Insider's Guide, Volume 2* (2022), with Sahn Lam, "Metrics monitoring and alerting system".
