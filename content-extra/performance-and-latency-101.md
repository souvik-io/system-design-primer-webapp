# Performance and latency 101

The primer's chapters on [performance vs scalability](/learn/performance-vs-scalability) and [latency vs throughput](/learn/latency-vs-throughput) are a few lines each. They point to three older sources: Werner Vogels's 2006 blog post [A Word on Scalability](https://www.allthingsdistributed.com/2006/03/a_word_on_scalability.html), Jonas Bonér's slide deck [Scalability, Availability & Stability Patterns](https://www.slideshare.net/jboner/scalability-availability-stability-patterns), and a Cadence blog post, [Understanding Latency versus Throughput](https://community.cadence.com/cadence_blogs_8/b/fv/posts/understanding-latency-vs-throughput). All three are short, and the Cadence post was written for chip designers. This chapter fills in what they leave out: why systems stop scaling, how latency and throughput pull against each other, why averages hide the slow requests that users notice, and what it costs a business when pages get slower. It uses real measurements and real failures, each with a source you can check.

We'll keep using **Crumb**, the recipe site from [Scalability 101](/learn/scalability-101). Crumb now runs app servers behind a load balancer, a cache and a database with replicas. This chapter follows one feature, recipe search, as it gets slower and as more people use it.

## Performance and scalability are different problems

Vogels, Amazon's [CTO](https://allthingsdistributed.com/about.html), wrote the definition the primer quotes. In his words, a service is scalable "if when we increase the resources in a system, it results in increased performance in a manner proportional to resources added." He adds that more performance usually means serving more units of work, but it can also mean handling larger units of work, such as when datasets grow. The post also makes two points the primer leaves out. Adding machines for redundancy shouldn't cost you performance either, and as a system grows it ends up with a mix of old and new hardware, so algorithms that assume every node is the same either break or waste the newer machines. His main argument is that "scalability cannot be an after-thought": many algorithms that work at low load "can explode in cost" when request rates, data size or the number of nodes grow.

Bonér's slides turn this into a test the primer repeats almost word for word. You have a **performance problem** if your system is slow for a single user. You have a **scalability problem** if it is fast for a single user but slow under heavy load.

The two problems have different fixes, and applying the wrong one wastes money.

Say Crumb's search takes three seconds even at 4 a.m., when one person is using the site. Adding servers won't help, because nothing is competing for them. The cause is in the work each request does. Typical culprits are a query that scans the whole recipes table because it lacks an index, code that runs one database query per search result (the "N+1 query" pattern), or a page that loads 4 MB of images before showing anything. You fix these with a profiler, an index or less work per request.

Now say search takes 80 ms at 4 a.m. and four seconds at 7 p.m. on a Sunday, when everyone is planning dinner. Each request does the same work at both times. What changes is how many requests share the same resources. Some of them are waiting in line, for a database connection, a lock, a disk or a CPU. That's a scalability problem, and you fix it by finding what they're waiting for and either adding more of it or needing less of it.

Real systems usually have both. A slow query that takes 200 ms with one user also holds a database connection for 200 ms, so it uses up the connection pool sooner under load. Fixing the performance problem often delays the scalability problem.

## Why adding servers stops helping

Vogels's definition sets the goal: double the resources, double the capacity. In practice, each machine you add gives you a little less than the last, and past some point adding machines makes things worse. There are three common reasons.

### A shared bottleneck

Every request may pass through something there's only one of: a primary database, a lock, a single queue, a login service. Adding app servers in front of it only makes the line at it longer. In [Scalability 101](/learn/scalability-101), this is why Crumb moved on from adding app servers to caching, read replicas and sharding. Each of those spreads the load on the database across more machines.

### Amdahl's law

Some work can't be split up. In 1967 Gene Amdahl, then at IBM, argued at the AFIPS conference that the "data management housekeeping" in production programs, about 40% of executed instructions, appeared to be sequential, which would "place an upper limit on throughput of five to seven times the sequential processing rate" ([the paper, as reprinted by IEEE in 2007](https://www3.cs.stonybrook.edu/~rezaul/Spring-2019/CSE613/reading/Amdahl-1967.pdf)). His paper has no equation, but the argument became the formula now called Amdahl's law. If a fraction *p* of the work can run in parallel on *N* machines and the rest can't, the best possible speedup is:

```
speedup = 1 / ((1 - p) + p / N)
```

Take a search job where 95% of the work parallelizes. On 16 machines the speedup is 1 / (0.05 + 0.95/16), about 9 times, not 16. With unlimited machines it can never pass 1 / 0.05 = 20 times. The 5% that runs serially sets the ceiling.

### Coordination costs

Amdahl's law assumes the extra machines at least don't get in each other's way. In real systems they do. Machines need to agree on who holds a lock, keep cached copies consistent, and send each other updates. That traffic grows faster than the number of machines: with 10 nodes there are 45 pairs that may need to talk, and with 100 there are 4,950.

Neil Gunther's [Universal Scalability Law](http://www.perfdynamics.com/Manifesto/USLscalability.html) adds this to Amdahl's model. The relative capacity of *N* machines is:

```
C(N) = N / (1 + α(N - 1) + βN(N - 1))
```

Here α is **contention**, time spent waiting for shared resources, and β is **coherency**, the cost of keeping data consistent between nodes. With β = 0 the formula reduces to Amdahl's law. Gunther's page notes that a non-zero β means throughput eventually goes "retrograde", falling as you add load or machines. With α = 0.05 and β = 0.001, 10 machines give about 6.5 times the capacity of one, 30 machines give about 9, and 60 machines give about 8. Past a certain size, the extra machines cost more in coordination than they add.

The practical lesson is to share as little as possible between requests and between machines, which is why the primer keeps returning to stateless servers, partitioned data and asynchronous work.

## A real scalability failure: HealthCare.gov

HealthCare.gov, the federal website for buying health insurance in states that didn't run their own marketplace, launched on 1 October 2013. The Department of Health and Human Services' Office of Inspector General later interviewed 86 officials, staff and contractors to reconstruct what happened, and its [2016 case study](https://oig.hhs.gov/documents/evaluation/2981/OEI-06-14-00350-Complete%20Report.pdf) shows both kinds of problem at once.

On 26 September, four and a half days before launch, officials from CMS (the agency running the site) ran "limited performance testing" and found the site "could support far fewer concurrent (simultaneous) users than planned", partly because the code needed more infrastructure than expected. They asked the hosting contractor to double capacity in 72 hours. A manager there recalled "pulling gear from all over the world, renting planes to get hardware here."

On launch day, 250,000 people used the site at the same time. The US CTO told the public this was five times the number expected. Outages began within two hours. The report is clear that the traffic wasn't the only cause: the issues "were not caused solely by a higher number of visitors to the website but also by core problems in website performance." On the first day, only six people managed to submit an application and select a plan.

The worst bottleneck was the account and identity system that every visitor had to pass through before reaching anything else. Its contractor hadn't known all traffic would go through it and had planned too little capacity. One CMS official described it as "like having a small, one-lane onramp to a major highway." It also blocked the repair work: developers couldn't easily reach the rest of the site to see its bugs until the entry system was fixed.

```diagram
title: HealthCare.gov in October 2013. Every visitor went through one identity system first.
[u:client] 250,000\nconcurrent users @ 0,0
[id] Account and\nidentity system @ 1,0
[mk] Marketplace\napplication @ 2,0
u -> id : everyone
id -> mk
```

By December, after weeks of fixes, the site handled more than 35,000 concurrent users without crashing. When traffic exceeded capacity, it put people in a "waiting room" and offered to email them when it was their turn, which is the [back pressure](/learn/asynchronism#back-pressure) idea from the primer. A year later, during the second enrollment period, it supported 250,000 concurrent users without an outage, and the median login time had dropped from 18.46 seconds to 3.21 seconds. The Inspector General concluded that the root causes were mostly management ones: unclear leadership, too much time spent on policy and too little on building the website, and a decision to launch on time even though testing wasn't finished. Load testing only helps if it happens early enough for the results to change anything.

## Latency and throughput

The primer's definitions come from the Cadence post. **Latency** is the time it takes to perform an action or produce a result. **Throughput** is the number of actions or results per unit of time. The post was written for chip designers, and its example is a car factory: if it takes eight hours to build a car and the factory turns out 120 cars a day, latency is eight hours and throughput is five cars an hour. Both numbers are true at once because many cars are on the line at the same time.

A highway works the same way. Latency is how long your drive takes, and throughput is how many cars pass a point per hour. Adding lanes raises throughput but doesn't shorten anyone's trip.

For networks, people often say bandwidth when they mean the maximum possible throughput. The two quantities are independent, and you can have a lot of one with very little of the other.

The clearest example is a truck. In 2016 AWS launched [Snowmobile](https://aws.amazon.com/blogs/aws/aws-snowmobile-move-exabytes-of-data-to-the-cloud-in-weeks/), a 45-foot shipping container on a semi-trailer that held up to 100 PB of data. AWS said moving that much data "across the Internet can take years or decades." The arithmetic shows why: 100 PB is 8 × 10¹⁷ bits, which takes about 926 days, roughly two and a half years, to send over a fully used 10 Gbps link. The truck's own switch could load data at 1 Tb/s, which AWS said would fill it in about 10 days, and then it drove to an AWS data center. Each bit took days to arrive, which is terrible latency, but the throughput was far beyond what a 10 Gbps link could deliver. AWS [retired Snowmobile in 2024](https://www.cnbc.com/2024/04/17/aws-stops-selling-snowmobile-truck-for-cloud-migrations.html), saying newer services had made moving data cheaper. The lesson still holds.

The reverse case is a small request over a long distance. The primer's [latency table](/learn/appendix#latency-numbers-every-programmer-should-know) lists a round trip from California to the Netherlands and back at 150 ms. A 1 KB request takes about that long whether the link runs at 1 Gbps or 100 Gbps, because the delay comes from distance and the speed of light, not from capacity. To cut it, you move the data closer to the user (a [CDN](/learn/content-delivery-network) or a nearer region) or make fewer round trips.

The primer's advice is to aim for maximal throughput with acceptable latency. The next two sections explain why you usually can't max out both.

## The trade-off: batching and queueing

### Batching

Sending things in batches saves the fixed cost of each send, such as a network round trip, a disk write or a system call. Fewer, larger sends raise throughput. The price is that the first item in a batch waits for the rest.

Kafka's producer makes the trade-off a setting. Its [`linger.ms` option](https://kafka.apache.org/41/configuration/producer-configs/) tells the producer to wait up to that many milliseconds so more records can be sent together, and the documentation compares it to Nagle's algorithm in TCP. It notes that setting it to 50 would cut the number of requests but "would add up to 50ms of latency to records sent in the absence of load." In Kafka 4.0 the default changed from 0 to 5 ms, because, per the docs, the efficiency of larger batches usually leads to similar or lower latency overall. At low load batching only adds delay, while under heavy load a busy system that batches can end up faster than one that doesn't.

### Queueing as utilization rises

The second trade-off is less obvious. When a server is busy, new requests wait. The busier it is on average, the longer they wait, and the wait grows faster than the load does.

The simplest queueing model, a single server with random arrivals and random service times (called M/M/1), gives the mean response time as the service time divided by (1 − utilization), as in [Raj Jain's lecture notes](https://research.engineering.wustl.edu/~jain/cse567-15/ftp/k_31asq.pdf). Say a Crumb search server takes 10 ms of work per request:

| Utilization | Average response time |
| --- | --- |
| 50% | 20 ms |
| 80% | 50 ms |
| 90% | 100 ms |
| 95% | 200 ms |
| 99% | 1,000 ms |

Going from 50% to 80% busy costs 30 ms. Going from 90% to 99% costs 900 ms. Real servers don't match the model exactly, but the shape holds: latency stays flat for a long time, then climbs steeply as you approach full use. It's a reason to leave headroom, for example by autoscaling well before CPU reaches 100%, and it explains how a server that looks fine at 85% can fall over when a bit more traffic arrives. Running everything at 100% gets the most throughput out of the hardware and the worst latency for users. The model also needs utilization below 100%. Past that, the queue grows without limit, and the only fixes are more capacity or turning work away.

## Little's Law

One formula connects latency, throughput and the number of requests in flight. John Little published a proof of it in 1961. In his [50th-anniversary review](https://people.cs.umass.edu/~emery/classes/cmpsci691st/readings/OS/Littles-Law-50-Years-Later.pdf) he states it as: the average number of items in a queuing system, *L*, equals the average arrival rate, *λ*, times the average time each item spends in the system, *W*.

```
L = λ × W
in-flight requests = arrival rate × average latency
```

He notes that it holds "under remarkably general conditions": for a single queue or a whole network, whatever the order requests are served in.

```diagram
title: Little's Law. Requests in the system = arrival rate × time each spends there.
[in:client] Arrivals\nλ = 2,000/s @ 0,0
[sys] Search service\nL = 100 in flight @ 1,0
[out:client] Responses\nW = 50 ms each @ 2,0
in -> sys
sys -> out
```

Crumb's search gets 2,000 requests a second at peak, and each takes 50 ms on average. So about 2,000 × 0.05 = 100 requests are in progress at any moment. If each search holds a database connection the whole time, the pool needs at least 100 connections.

Now the database slows down and searches take 500 ms. The arrival rate hasn't changed, so in-flight requests rise to 1,000. The 100-connection pool runs out, new requests queue for a connection, latency rises further, and more requests pile up. This is how one slow dependency takes down a healthy service, and it's why timeouts and limits on concurrent requests matter.

Given any two of the numbers, you can work out the third: how many threads or connections you need, or what throughput a fixed pool can sustain at a given latency.

## Averages hide the tail

Suppose Crumb's search has an average latency of 60 ms. That number can hide almost anything. If 99 searches take 30 ms and one takes 3 seconds, the average is about 60 ms, and one user in a hundred waits three seconds.

So teams measure **percentiles**. The p50 (median) is the latency half of requests beat. The p99 is the latency 99% of requests beat, so 1% are slower. A service might report "p50 of 30 ms, p99 of 400 ms." The slow end of the distribution is called the **tail**.

The tail matters more than its size suggests, for two reasons. First, users make many requests. Someone who loads 100 pages in a session hits at least one p99-slow page with probability 1 − 0.99¹⁰⁰, about 63%. Second, one page usually makes many backend calls, and the page is only as fast as the slowest of them.

### The Tail at Scale

Jeff Dean and Luiz André Barroso of Google worked through the second point in [The Tail at Scale](https://www.barroso.org/publications/TheTailAtScale.pdf) (Communications of the ACM, February 2013). Their example is a server that usually responds in 10 ms, with a 99th-percentile latency of one second. If a user request goes to one such server, one in a hundred is slow. If a request has to collect answers from 100 such servers in parallel, 63% of user requests take more than a second. The math: each server is fast with probability 0.99, so all 100 are fast with probability 0.99¹⁰⁰ ≈ 0.37. Even if only one request in 10,000 is slow on each server, a request that fans out to 2,000 servers is slow almost one time in five.

```diagram
title: Fan-out. The user waits for the slowest of many servers.
[u:client] User request @ 0,1
[root] Root server @ 1,1
[l1] Leaf 1 @ 3,0
[l2] Leaf 2 @ 3,1
[l3] Leaf 100\n(one slow reply) @ 3,2
u -> root
root -> l1
root -> l2
root -> l3
```

They give measurements from a real Google service built this way. The 99th-percentile time for one random leaf request to finish was 10 ms. The 99th-percentile time for all leaf requests to finish was 140 ms, and for 95% of them it was 70 ms. Waiting for the slowest 5% of requests accounted for half of the total.

The causes they list are ordinary: machines shared with other jobs, background daemons, garbage collection, log compaction, power and thermal throttling, and queueing at several layers. Their conclusion is that eliminating all of it is impractical, so large systems have to be "tail-tolerant", in the same way fault-tolerant systems build a reliable whole out of unreliable parts. One of their techniques is the **hedged request**: send the request to one replica, and if it hasn't answered within a short delay, send it to a second and use whichever answers first. In a Google benchmark that read 1,000 keys from a Bigtable spread over 100 servers, sending a hedge after 10 ms cut the 99.9th-percentile latency from 1,800 ms to 74 ms while sending just 2% more requests. A related trick waits until the 95th-percentile latency before hedging, which limits the extra load to about 5%.

For Crumb, the lesson is to watch p99 rather than the average, and to treat every extra backend call on a page as another draw from the tail.

## Why latency matters to the business

Dean and Barroso note that systems responding within about 100 ms "feel more fluid and natural to users." Measuring what slowness actually costs is harder, because you have to make the product slower on purpose and compare.

Google did that in 2009. Jake Brutlag's report, [Speed Matters for Google Web Search](https://services.google.com/fh/files/blogs/google_delayexp.pdf), describes experiments in which one group of users had server-side delays of 50 to 400 ms added to their search results for four to six weeks, while a control group didn't. Delays of 100 to 400 ms reduced the number of daily searches per user by 0.2% to 0.6%. The 400 ms delay cost 0.59%.

Two other findings matter more. The effect grew over time: with the 400 ms delay, users did 0.44% fewer searches in the first half of the experiment and 0.74% fewer in the second half. And it outlasted the delay. After the 400 ms delay was removed, those users still searched 0.21% less than the control group, averaged over the next five weeks. Users who learn that a product is slow use it less, and they keep using it less for a while after it gets fast again. Google's [blog post on the experiment](https://research.google/blog/speed-matters/) summarizes the same results.

Fractions of a percent sound small, but for a product used at Google's scale they add up to a lot of lost usage, from delays of under half a second.

## Where the original sources fit

**Vogels's post** is about 450 words long and worth reading in full. Its value is the framing: scalability has to be designed in from the start, it covers redundancy as well as capacity, and fleets become a mix of old and new hardware as they grow.

**Bonér's deck** is 196 slides. SlideShare lists it as published in May 2010, and the title slide gives his role as CTO of Typesafe. The primer's two chapters come from about six of those slides: "How do I know if I have a performance problem?", the scalability version of that question, and "You should strive for maximal throughput with acceptable latency." The rest of the deck is a tour of the patterns the primer covers later, including the CAP theorem and eventual consistency, fail-over and replication, partitioning and HTTP caching, sharding, NoSQL databases, distributed caching and concurrency models. The slides have little explanation on them, so they work best as a checklist after you've read the matching primer chapters, such as [availability vs consistency](/learn/availability-vs-consistency), [cache](/learn/cache) and [database](/learn/database).

**The Cadence post** was written for hardware engineers learning high-level synthesis. After the definitions and the car-factory example, it converts latency into clock periods for chip design, which won't help with web services. The primer's two chapters don't mention queueing, Little's Law or tail latency, which is why this chapter spends most of its length on them.

## Check yourself

<details>
<summary>Crumb's recipe page takes 2.5 seconds to load even when the site is nearly empty. Is this a performance problem or a scalability problem, and would adding app servers help?</summary>

It's a performance problem: the system is slow for a single user. Adding servers won't help, because there's no contention when only one user is on the site. The time is going into the work each request does. Profile the request and look for things like a missing index, one query per item on the page (N+1 queries), or large assets. Fixing it will usually help under load too, since each request then holds resources for less time.

</details>

<details>
<summary>A batch job is 90% parallelizable. What's the best speedup you can get on 8 machines, and on unlimited machines? Why might the real number be lower?</summary>

By Amdahl's law, on 8 machines the speedup is 1 / (0.1 + 0.9/8) = 1 / 0.2125, about 4.7 times. With unlimited machines it approaches 1 / 0.1 = 10 times. Real systems usually do worse because machines also spend time coordinating, waiting on shared resources and keeping data consistent. The Universal Scalability Law models this, and with enough coordination cost, adding machines eventually reduces throughput.

</details>

<details>
<summary>A service handles 500 requests a second with an average latency of 200 ms. How many requests are in flight? What happens if a dependency slows down and latency doubles?</summary>

By Little's Law, in-flight requests = 500 × 0.2 = 100. If latency doubles to 400 ms at the same arrival rate, in-flight requests double to 200. Any fixed pool sized for 100 (threads, database connections) runs out, new requests queue, latency rises further, and the problem feeds itself. Timeouts, limits on concurrency and turning away excess load early stop the spiral.

</details>

<details>
<summary>Each of a page's 50 backend calls is slow 1% of the time. Roughly what fraction of page loads include at least one slow call, and what can you do about it?</summary>

The page is fast only if all 50 calls are fast: 0.99⁵⁰ ≈ 0.61, so about 39% of page loads hit at least one slow call. That's the fan-out effect from The Tail at Scale. Options include reducing the number of calls, making calls in parallel with timeouts and falling back to partial results when that's acceptable, and hedging: if a call to a replicated service hasn't returned by around its 95th-percentile latency, send it to a second replica and use the first answer.

</details>

<details>
<summary>Your servers average 90% CPU and latency looks fine. Why might a manager's plan to "use the hardware fully" by removing a few servers be a bad idea?</summary>

Queueing delay grows steeply as utilization approaches 100%. In the simple M/M/1 model, response time is the service time divided by (1 − utilization): 10 times the service time at 90% busy, 20 times at 95%, 100 times at 99%. Removing servers pushes utilization into the steep part of that curve, and ordinary traffic spikes then cause large latency jumps or a growing backlog. Headroom is what keeps latency acceptable.

</details>

## Further reading

The originals the primer cites:

- [A Word on Scalability](https://www.allthingsdistributed.com/2006/03/a_word_on_scalability.html): Werner Vogels's March 2006 post, the source of the primer's definition. The primer's `http://` link redirects to this address.
- [Scalability, Availability & Stability Patterns](https://www.slideshare.net/jboner/scalability-availability-stability-patterns): Jonas Bonér's 196-slide deck. The primer's link redirects here. Read it as a checklist of patterns after the primer chapters.
- [Understanding Latency versus Throughput](https://community.cadence.com/cadence_blogs_8/b/fv/posts/understanding-latency-vs-throughput): Cadence's post with the car-factory example. The page sits behind a browser check that blocks some tools; if it won't load, there's an [archived copy from February 2026](https://web.archive.org/web/20260215115328/https://community.cadence.com/cadence_blogs_8/b/fv/posts/understanding-latency-vs-throughput).

Papers and reports:

- [The Tail at Scale](https://www.barroso.org/publications/TheTailAtScale.pdf): Dean and Barroso, Communications of the ACM, February 2013. Seven pages, and readable without a background in queueing theory.
- [Speed Matters for Google Web Search](https://services.google.com/fh/files/blogs/google_delayexp.pdf): Jake Brutlag's 2009 delay experiments, with the [blog post](https://research.google/blog/speed-matters/) that announced them.
- [HealthCare.gov: Case Study of CMS Management of the Federal Marketplace](https://oig.hhs.gov/documents/evaluation/2981/OEI-06-14-00350-Complete%20Report.pdf): the HHS Inspector General's 2016 report on the launch.
- [Little's Law as Viewed on Its 50th Anniversary](https://people.cs.umass.edu/~emery/classes/cmpsci691st/readings/OS/Littles-Law-50-Years-Later.pdf): John Little on his own law, with examples from operations and computer architecture.
- [Validity of the single processor approach](https://www3.cs.stonybrook.edu/~rezaul/Spring-2019/CSE613/reading/Amdahl-1967.pdf): Gene Amdahl's 1967 paper, three pages long, in IEEE's 2007 reprint.
- [The Universal Scalability Law](http://www.perfdynamics.com/Manifesto/USLscalability.html): Neil Gunther's explanation of the model and its parameters.
- [Analysis of a single queue](https://research.engineering.wustl.edu/~jain/cse567-15/ftp/k_31asq.pdf): Raj Jain's lecture slides with the M/M/1 results used above.

Examples:

- [AWS Snowmobile announcement](https://aws.amazon.com/blogs/aws/aws-snowmobile-move-exabytes-of-data-to-the-cloud-in-weeks/): Jeff Barr's 2016 post, and [CNBC on its retirement](https://www.cnbc.com/2024/04/17/aws-stops-selling-snowmobile-truck-for-cloud-migrations.html) in 2024.
- [Kafka producer configuration](https://kafka.apache.org/41/configuration/producer-configs/): see `linger.ms` and `batch.size` for a real batching knob.
