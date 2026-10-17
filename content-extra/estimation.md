# Back-of-the-envelope estimation

Before you draw boxes, you need a rough idea of how big the problem is. Is it 50 requests per second or 500,000? Gigabytes or petabytes? The answer decides whether one database will do, whether you need a CDN, and whether the whole working set fits in memory. Back-of-the-envelope estimation is the habit of getting those numbers in a couple of minutes, with round figures and stated assumptions.

In an interview, this usually happens right after you clarify requirements, in the first of [the four interview steps](/learn/system-design-interview#step-1-outline-use-cases-constraints-and-assumptions). Nobody expects precision. Interviewers want to see that you can turn a vague product description into numbers, keep the units straight, and then let those numbers drive design choices.

Two reference tables help: the [powers of two table](/learn/appendix#powers-of-two-table) and [latency numbers every programmer should know](/learn/appendix#latency-numbers-every-programmer-should-know). This chapter is about the method that uses them.

## Units and shortcuts

Most estimation mistakes are unit mistakes. A few conversions do most of the work.

| Quantity | Exact | Shortcut |
|---|---|---|
| Seconds per day | 86,400 | ~10^5 |
| Seconds per month | ~2.6 million | ~2.5 × 10^6 |
| Seconds per year | ~31.5 million | ~3 × 10^7 |
| 1 million requests per day | ~11.6 per second | ~10 per second |
| 1 billion requests per day | ~11,600 per second | ~10^4 per second |
| 1 Gbps link | 125 MB/s | ~100 MB/s usable |
| KB, MB, GB, TB, PB | 2^10, 2^20, … | 10^3, 10^6, 10^9, 10^12, 10^15 |

Some habits that keep the arithmetic easy:

- **Work in powers of ten.** Keep the leading digit and the exponent apart: 5 × 10^7 users × 2 × 10^3 bytes = 10 × 10^10 = 10^11 bytes = 100 GB.
- **Use decimal units.** Treating a KB as 1,000 bytes instead of 1,024 is off by 2.4%, and by about 10% at the terabyte scale. That's well inside the error of your assumptions.
- **Watch bits and bytes.** Network links are quoted in bits per second, storage in bytes. Divide by 8 to go from Gbps to GB/s.
- **Know which way you rounded.** Dividing by 10^5 instead of 86,400 makes QPS about 14% too low. Multiplying a per-second rate by 10^5 makes a daily total about 16% too high. Neither matters much, but know the direction.

## The method, step by step

Work through the same steps every time, and write each assumption on the board as you make it. If the interviewer disagrees with one, you change one line instead of starting over.

1. **Fix the inputs.** Daily active users (DAU), actions per user per day, the read-to-write ratio, the size of each object, how long you keep data, and how spiky the traffic is. If the interviewer doesn't give you a number, propose one and say it out loud.
2. **Average QPS.** DAU × actions per user per day ÷ 10^5. Do reads and writes separately, because they scale differently.
3. **Peak QPS.** Average × a peak factor. Consumer traffic with a daily cycle is often 2–3 times the average at peak. Event-driven traffic (a sports final, a product launch, a push notification to every user) can be 10 times or more. This is an assumption; label it.
4. **Storage.** New objects per day × object size × retention period. Then multiply by the replication factor if you run the storage yourself (three copies is common). Add something for indexes and metadata.
5. **Bandwidth.** Ingress is write QPS × upload size. Egress is read QPS × response size. Convert to Gbps at the end, since that's what network capacity is sold in.
6. **Cache memory.** Estimate the hot set, not the whole dataset. Two common ways: cache a fraction of what's read each day (the "80/20" assumption that a small share of items gets most reads), or cache everything created in a recent window if reads skew towards new content.
7. **Servers.** Peak QPS ÷ the throughput one server sustains, then add headroom so you can lose a machine or a zone and still cope.

```diagram
title: Assumptions turn into four numbers, and each number drives a design decision
[in:note] Assumptions\nusers, sizes, peak @ 0,1.5
[qps] QPS\navg and peak @ 1,0
[sto] Storage @ 1,1
[bw] Bandwidth @ 1,2
[mem] Hot set @ 1,3
[srv] Server count @ 2,0
[shard] Shard or not @ 2,1
[cdn] CDN or not @ 2,2
[cache] Cache size @ 2,3
in -> qps
in -> sto
in -> bw
in -> mem
qps -> srv : ÷ per-server
sto -> shard : vs node size
bw -> cdn : vs one link
mem -> cache
```

## Worked example: a photo-sharing app

Say you're asked to design a photo-sharing app where people post photos and scroll a feed of photos from people they follow. Here are the assumptions, all invented for this example:

- 50 million DAU.
- Each user posts 0.2 photos a day on average, so 10 million uploads a day.
- Each user views 100 photos a day in the feed. A feed page shows 20 photos.
- Each upload is stored as an original (2 MB after compression), a medium size for the feed (300 KB) and a thumbnail (30 KB). That's about 2.33 MB; call it 2.5 MB with some headroom.
- Each photo has about 1 KB of metadata: IDs, caption, location, timestamps.
- Peak factor of 3. Keep everything for 5 years.

**QPS.**

- Uploads: 10^7 per day ÷ 10^5 = 100 per second on average, 300 at peak.
- Photo views: 50 × 10^6 × 100 = 5 × 10^9 per day ÷ 10^5 = 50,000 per second on average, 150,000 at peak.
- Feed API calls: 5 × 10^9 ÷ 20 photos per page = 2.5 × 10^8 per day ÷ 10^5 = 2,500 per second on average, 7,500 at peak.

The split between the last two matters. Image fetches are 20 times more frequent than feed calls, and they are static bytes, so they belong on a [CDN](/learn/content-delivery-network#overview) rather than your API servers.

**Storage.**

- Photos: 10^7 per day × 2.5 MB = 2.5 × 10^13 bytes = 25 TB a day. Over a year, 25 TB × 365 ≈ 9 PB. Over 5 years, about 45 PB.
- Metadata: 10^7 × 1 KB = 10 GB a day, about 3.65 TB a year, about 18 TB over 5 years. With three replicas, about 55 TB, before indexes.

45 PB of images means object storage. 18 TB of metadata is more than you'd want on one database node, so plan to [shard](/learn/database#sharding) it from the start.

**Bandwidth.**

- Ingress: 100 uploads per second × 2 MB = 200 MB/s, or 1.6 Gbps on average and about 4.8 Gbps at peak. Only the original comes in. The resized versions are made on the server side.
- Egress: 50,000 views per second × 300 KB = 1.5 × 10^10 bytes per second = 15 GB/s, or 120 Gbps on average and about 360 Gbps at peak.

No single origin serves 360 Gbps sensibly. That one number justifies the CDN.

**Cache.** Suppose most feed views are of photos posted in the last week. Seven days × 10 GB of metadata a day = 70 GB. That fits in the memory of a couple of cache nodes (plus replicas), so you can cache all recent metadata and skip the eviction-policy debate.

**Servers.** Assume one API server handles about 1,000 feed requests per second, since each call is mostly cache lookups. This is an assumption you would measure. 7,500 ÷ 1,000 ≈ 8 servers at peak; run around 12 so you can lose some and still deploy safely.

## Worked example: a ride-hailing location service

Now a different shape of problem: the part of a ride-hailing app that tracks where drivers are and answers "which drivers are near this rider?" Assumptions, again invented:

- At the busiest hour, 1 million drivers are online. Over a day, the average is 400,000.
- Each online driver's app sends a location update every 4 seconds.
- An update holds a driver ID (8 bytes), latitude and longitude (8 bytes each), a timestamp (8 bytes) and about 8 bytes of heading, speed and status. That's 40 bytes. With protocol framing on the wire, call it 200 bytes.
- 20 million rider sessions a day. While a rider waits, the app asks for nearby drivers every 5 seconds, for about a minute.

Notice that the input is concurrent users, not DAU. Location updates are driven by how many drivers are online at once, so that's the number to ask for.

**Write QPS.** 1,000,000 drivers ÷ 4 seconds = 250,000 updates per second at peak. On average, 400,000 ÷ 4 = 100,000 per second.

**Read QPS.** 20 × 10^6 sessions × 12 queries = 2.4 × 10^8 a day ÷ 10^5 = 2,400 per second on average, and about 7,200 at peak with a peak factor of 3.

This system is write-heavy: around 40 writes for every read. That turns the usual "add read replicas and a cache" advice on its head.

**Ingress.** 250,000 × 200 bytes = 5 × 10^7 bytes per second = 50 MB/s, about 400 Mbps. Modest.

**Memory for current locations.** 1,000,000 drivers × 40 bytes = 40 MB of raw data. Per-key overhead in an in-memory store and a geospatial index can multiply that several times; call it 200 bytes per driver, so 200 MB. It fits easily on one machine.

So the dataset is tiny, and the hard part is the write rate. If you assume one in-memory store node handles on the order of 100,000 simple writes per second (another assumption to verify), 250,000 per second needs at least three nodes, and you'd want more for headroom. Shard by geography, such as city or map cell. You're sharding for write throughput and locality, not capacity, and a "nearby drivers" query then usually touches one shard.

**Location history.** If you keep every update for trip records and analytics: 100,000 per second × 40 bytes = 4 MB/s. Multiplied by 10^5 seconds, that's about 400 GB a day (the exact figure is 4 MB × 86,400 ≈ 346 GB). Over a year, roughly 126–146 TB depending on which figure you use. That doesn't belong in the database serving live lookups. Append it to a log such as Kafka (see [event streaming](/learn/event-streaming)) and write it out in batches to cheaper storage.

## Sanity-checking the result

An estimate with a misplaced exponent is worse than none, because you'll defend it. Before moving on, check it a second way.

- **Recompute per user.** 25 TB a day ÷ 50 million users = 500 KB per user per day, which matches 0.2 photos × 2.5 MB. If the per-user figure looks absurd (gigabytes a day for a messaging user), something upstream is wrong.
- **Check the units at every step.** Write them next to each number. "15 GB/s" and "15 Gbps" differ by a factor of 8.
- **Compare with physical limits.** A typical server has a 10–25 Gbps network card and tens to hundreds of GB of RAM, with a few TB on the largest machines. One SSD reads sequentially at 1 GB/s or more (see the [latency table](/learn/appendix#latency-numbers-every-programmer-should-know)); a current NVMe drive manages several GB/s. If one component would need to exceed these, you've found a scaling decision, not a typo.
- **Watch compounding.** Rounding every number up by 50% across four multiplications makes the result five times too big. Round some up and some down, or note the direction.
- **Only compute what changes the design.** If storage is 2 GB, don't spend three minutes refining it to 2.3 GB. Move on to the number that matters.

## What the numbers decide

Estimates are only useful if they change a decision. These per-node figures are rough starting points that vary a lot with hardware and workload. State them as assumptions, then compare.

| If you find… | Rough threshold (assumption) | It suggests… |
|---|---|---|
| Peak QPS for stateless servers | ~1,000–10,000 simple requests/s per server | Server count behind a [load balancer](/learn/load-balancer#horizontal-scaling) |
| Many more reads than writes | Read:write of 10:1 or more | [Read replicas](/learn/database#master-slave-replication) and [caching](/learn/cache#application-caching) |
| Write rate above one primary | Low thousands of writes/s is a safe assumption for one relational primary | [Sharding](/learn/database#sharding) or a write-optimized store |
| Data beyond one node | More than a few TB per database node | Sharding; blobs go to object storage |
| Egress in tens of Gbps | More than a few servers' network cards | A CDN |
| Hot set fits in RAM | Tens to hundreds of GB | Cache all of it, or use an in-memory store as the primary |
| Latency budget | ~0.5 ms per round trip inside a data center | How many sequential calls one request can make |

The two examples above came out quite differently. The photo app is dominated by bytes: storage and egress. The location service is dominated by small, frequent writes. The estimation step told you that before you designed anything.

## Check yourself

<details>
<summary>A service handles 500 million requests a day with a peak factor of 3. What are the average and peak QPS, and how far off is the 10^5 shortcut?</summary>

500 × 10^6 ÷ 10^5 = 5,000 per second on average, and 15,000 at peak. The exact average is 500,000,000 ÷ 86,400 ≈ 5,790, so the shortcut is about 14% low. That's smaller than the uncertainty in the peak factor itself, so it rarely changes a decision.

</details>

<details>
<summary>In the photo app, someone suggests serving the 2 MB originals in the feed instead of the 300 KB versions. What happens to egress?</summary>

50,000 views per second × 2 MB = 100 GB/s, or about 800 Gbps on average instead of 120 Gbps. That's nearly seven times the bandwidth bill and slower loads for users. Response size multiplies directly into egress, which is why image resizing is usually worth its storage cost.

</details>

<details>
<summary>Why did the ride-hailing estimate start from concurrent drivers instead of daily active users?</summary>

Location updates are sent on a timer while a driver is online, so the write rate depends on how many are online at the same moment, not how many use the app in a day. A driver who works a ten-hour shift sends 9,000 updates. One who opens the app for ten minutes sends 150. DAU would hide that difference.

</details>

<details>
<summary>The interviewer adds that 10% of uploads to the photo app are videos averaging 50 MB. How does daily storage change?</summary>

1 million videos × 50 MB = 50 TB a day, plus 9 million photos × 2.5 MB = 22.5 TB, for about 72.5 TB a day, nearly three times the photo-only figure. Videos are a tenth of uploads but about 70% of the bytes. Call that out, because it suggests separate storage tiers, transcoding work and a different CDN profile for video (see [video streaming](/learn/design-video-streaming)).

</details>

<details>
<summary>Your metadata estimate comes out at 3 TB after five years, including replicas, at 500 writes per second. Do you need to shard on day one?</summary>

Probably not. 3 TB across three replicas is about 1 TB per copy, and 500 writes per second is well within what a single relational primary usually handles. You'd say so, and say what would change your mind: faster growth than assumed, or a write rate approaching a few thousand per second. Choosing a shard-friendly key early keeps that move cheap later.

</details>

## Further reading

- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832): Jonas Bonér's widely shared table of latency figures, credited to Jeff Dean and originally Peter Norvig.
- [Google Pro Tip: Use Back-of-the-Envelope Calculations to Choose the Best Design](https://highscalability.com/google-pro-tip-use-back-of-the-envelope-calculations-to-choo/): High Scalability's 2011 summary of Jeff Dean's case for estimating before you build.
- [Interactive latency numbers by year](https://colin-scott.github.io/personal_website/research/interactive_latency.html): shows how those numbers have shifted as hardware improved.
- [Jeff Dean, "Designs, Lessons and Advice from Building Large Distributed Systems" (LADIS 2009)](https://www.cs.cornell.edu/projects/ladis2009/talks/dean-keynote-ladis2009.pdf): includes the original "numbers everyone should know" slide and short worked estimates.
- [Simon Eskildsen, napkin-math](https://github.com/sirupsen/napkin-math): benchmarked throughput and latency figures for estimates, with exercises.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Back-of-the-envelope estimation".
- [System Design School primer](https://systemdesignschool.io/primer): "Estimating the Load", under Designing for Scale.
