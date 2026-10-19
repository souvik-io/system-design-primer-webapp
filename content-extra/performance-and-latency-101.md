# Performance and latency 101

This chapter answers four questions:

- Why does a site that is fast for one user get slow when thousands use it at once?
- Why does adding more servers eventually stop helping?
- What is the difference between latency and throughput, and why can't you usually max out both?
- Why do engineers watch the slowest requests instead of the average, and what does slowness cost a business?

The classic definitions of these ideas come from three short sources: Werner Vogels's 2006 blog post [A Word on Scalability](https://www.allthingsdistributed.com/2006/03/a_word_on_scalability.html), Jonas Bonér's slide deck [Scalability, Availability & Stability Patterns](https://www.slideshare.net/jboner/scalability-availability-stability-patterns), and a Cadence blog post, [Understanding Latency versus Throughput](https://community.cadence.com/cadence_blogs_8/b/fv/posts/understanding-latency-vs-throughput). This chapter starts from their definitions and goes much further: queueing, Little's Law, tail latency, and what slowness costs. Every number and story in it comes from a source you can check.

We'll keep using **Crumb**, the recipe site from [Scalability 101](/learn/scalability-101). By now Crumb has several app servers behind a load balancer, a cache, and a database with read replicas. This chapter follows one feature, recipe search, as it gets slower and as more people use it.

## Performance and scalability are different problems

Bonér's slides give a simple test:

- You have a **performance problem** if the system is slow even for a single user.
- You have a **scalability problem** if the system is fast for a single user but slow when many people use it at once.

The test matters because the two problems have different fixes. If you apply the wrong fix, you spend money and nothing gets faster.

**A performance problem at Crumb.** Say search takes three seconds at 4 a.m., when only one person is on the site. Adding servers won't help, because there is nothing to share and no one to compete with. The time is going into the work that each request does. Common causes are:

- a query that reads the whole recipes table because the right index is missing,
- code that runs a separate database query for every search result (called the "N+1 query" problem),
- a page that downloads 4 MB of images before it shows anything.

You find these with a profiler and fix them by making each request do less work.

**A scalability problem at Crumb.** Now say search takes 80 ms at 4 a.m. but four seconds at 7 p.m. on a Sunday, when everyone is planning dinner. Each request does exactly the same work at both times. The difference is that at 7 p.m. many requests are sharing the same resources, so some of them have to wait in line: for a database connection, a lock, the disk or the CPU. To fix it, find out what they are waiting for. Then either add more of that resource or change the code so requests need less of it.

**Most real systems have both.** A slow query that takes 200 ms for one user also holds a database connection for those 200 ms. Under load, that uses up the pool of connections faster. So fixing a performance problem often pushes a scalability problem further away.

### Where the definition of scalability comes from

The standard definition of scalability comes from Werner Vogels, Amazon's [CTO](https://allthingsdistributed.com/about.html). He wrote that a service is scalable "if when we increase the resources in a system, it results in increased performance in a manner proportional to resources added." In plain words: if you double the servers, you should be able to handle roughly double the work. Here, "more performance" usually means serving more requests, but it can also mean handling bigger jobs, for example when the data grows.

His post makes three more points that are often left out:

1. Adding machines for redundancy, meaning spare copies in case one fails, should not make the system slower.
2. As a system grows, its servers become a mix of old and new hardware. Designs that assume every machine is identical will either break or leave the newer machines underused.
3. "Scalability cannot be an after-thought." Many algorithms work well at low load but "can explode in cost" when the request rate, the amount of data or the number of machines grows.

## Why adding servers stops helping

Vogels's definition sets the goal: double the resources, double the capacity. Real systems fall short of that. Each machine you add gives a little less benefit than the one before, and past some point adding machines makes the system slower. There are three common reasons.

### Reason 1: everything waits on one shared thing

Often every request has to pass through something there is only one of, such as the main database, a lock, a single queue or a login service. Adding app servers in front of it doesn't help. It just makes the line in front of that one thing longer. In [Scalability 101](/learn/scalability-101), this is why Crumb stopped adding app servers and turned to caching, read replicas and sharding instead. Each of those spreads the database's load over more machines.

### Reason 2: some work can't be split up (Amdahl's law)

Think of a job where 95% of the work can be divided among many machines, but 5% has to run on one machine, one step at a time. However many machines you add, that 5% takes just as long as before. So that 5% sets a limit on how fast the whole job can go.

This idea is called **Amdahl's law**. If a fraction *p* of the work can run in parallel on *N* machines and the rest cannot, the best speedup you can get is:

```
speedup = 1 / ((1 - p) + p / N)
```

Try it with *p* = 0.95, meaning 95% of the work can run in parallel:

- On 16 machines, the speedup is 1 / (0.05 + 0.95/16), which is about 9 times. That is far short of 16.
- On an unlimited number of machines, the speedup can never go past 1 / 0.05 = 20 times.

The law is named after Gene Amdahl, who made the argument in 1967 at the AFIPS conference while working at IBM ([the paper, as reprinted by IEEE in 2007](https://www3.cs.stonybrook.edu/~rezaul/Spring-2019/CSE613/reading/Amdahl-1967.pdf)). He observed that about 40% of the instructions in real programs were "data management housekeeping" that appeared to run in sequence. He argued that this would "place an upper limit on throughput of five to seven times the sequential processing rate." His paper doesn't contain the formula above. Others wrote it down later and named it after him.

### Reason 3: machines have to coordinate

Amdahl's law assumes that extra machines at least don't get in each other's way. In real systems they do. Machines have to agree on who holds a lock, keep their cached copies of data up to date, and send each other updates. This coordination grows faster than the number of machines. With 10 machines there are 45 pairs that might need to talk to each other. With 100 machines there are 4,950.

Neil Gunther's [Universal Scalability Law](http://www.perfdynamics.com/Manifesto/USLscalability.html) adds this cost to Amdahl's model. It estimates how much work *N* machines can do compared with one machine:

```
C(N) = N / (1 + α(N - 1) + βN(N - 1))
```

The formula has two settings:

- **α (alpha) is contention.** It measures time spent waiting in line for a shared resource. This is the same limit Amdahl described.
- **β (beta) is coherency.** It measures time spent keeping copies of data in agreement across machines. This is the new part. If β is 0, the formula is just Amdahl's law again.

Here is what happens with α = 0.05 and β = 0.001:

| Machines | Capacity compared with one machine |
| --- | --- |
| 10 | about 6.5 times |
| 30 | about 9 times |
| 60 | about 8 times |

Going from 30 machines to 60 makes the system slower, because the extra coordination costs more than the extra machines add. Gunther's page calls this "retrograde" throughput, and it happens whenever β is above zero and the system gets big enough.

The practical lesson is to share as little as possible between requests and between machines. That is why this handbook keeps coming back to stateless servers, partitioned data and asynchronous work.

## A real scalability failure: HealthCare.gov

HealthCare.gov is the US federal website where people buy health insurance if their state doesn't run its own marketplace. It launched on 1 October 2013 and failed badly. Afterwards, the Office of Inspector General at the Department of Health and Human Services interviewed 86 officials, staff and contractors to work out what went wrong. Its [2016 case study](https://oig.hhs.gov/documents/evaluation/2981/OEI-06-14-00350-Complete%20Report.pdf) shows a performance problem and a scalability problem at the same time.

**Before launch.** On 26 September, four and a half days before launch, officials from CMS, the agency running the site, did some "limited performance testing." They found that the site "could support far fewer concurrent (simultaneous) users than planned." Part of the reason was that the code needed more servers than expected. They asked the hosting contractor to double capacity within 72 hours. A manager there remembered "pulling gear from all over the world, renting planes to get hardware here."

**Launch day.** 250,000 people tried to use the site at the same time. The US Chief Technology Officer said publicly that this was five times more than expected, and outages started within two hours. The report says the extra traffic wasn't the only cause. The problems "were not caused solely by a higher number of visitors to the website but also by core problems in website performance." On the first day, only six people managed to apply and choose a plan.

**The bottleneck.** The worst choke point was the account and identity system. Every visitor had to get through it before they could reach anything else on the site. The contractor who built it didn't know that all traffic would pass through it, so they planned too little capacity. One CMS official compared it to "having a small, one-lane onramp to a major highway." It also slowed down the repairs, because developers couldn't easily get past it to find bugs in the rest of the site.

```diagram
title: HealthCare.gov in October 2013. Every visitor went through one identity system first.
[u:client] 250,000\nconcurrent users @ 0,0
[id] Account and\nidentity system @ 1,0
[mk] Marketplace\napplication @ 2,0
u -> id : everyone
id -> mk
```

**The recovery.** By December, after weeks of fixes, the site could handle more than 35,000 users at once without crashing. When more people arrived than it could serve, it put them in a "waiting room" and offered to email them when it was their turn. This is [back pressure](/learn/queues-and-async#back-pressure-when-the-queue-keeps-growing): turn extra work away politely instead of falling over. A year later, during the second enrollment period, the site handled 250,000 users at once with no outage. The median login time had dropped from 18.46 seconds to 3.21 seconds.

**The lesson.** The Inspector General found that the root causes were mostly about management, not technology. Leadership was unclear, too much time went into policy and too little into building the website, and the site launched on schedule even though testing wasn't finished. Load testing only helps if you do it early enough to act on what it finds.

## Latency and throughput

The usual definitions come from the Cadence post:

- **Latency** is how long it takes to do one thing. For a web service, it is the time from sending a request to getting the response.
- **Throughput** is how many things get done in a unit of time. For a web service, it is requests handled per second.

The Cadence post explains the difference with a car factory. Suppose it takes eight hours to build one car, and the factory finishes 120 cars a day. The latency is eight hours per car. The throughput is five cars an hour. Both are true at once because many cars are on the assembly line at the same time, each at a different stage.

A highway works the same way. Latency is how long your drive takes. Throughput is how many cars pass a point each hour. Adding lanes lets more cars through per hour, but it doesn't make anyone's trip shorter.

On networks, people often say **bandwidth** to mean the most throughput a link can carry. Bandwidth and latency are separate things. A link can have plenty of one and very little of the other, as the next two examples show.

**High throughput, terrible latency: a truck full of hard drives.** In 2016 AWS launched [Snowmobile](https://aws.amazon.com/blogs/aws/aws-snowmobile-move-exabytes-of-data-to-the-cloud-in-weeks/), a 45-foot shipping container on a truck that could hold up to 100 PB of data. AWS said that moving that much data "across the Internet can take years or decades." The arithmetic backs this up. 100 PB is 8 × 10¹⁷ bits. Sending that over a 10 Gbps link running flat out would take about 926 days, or roughly two and a half years. Snowmobile instead loaded data at up to 1 Tb/s, which AWS said would fill the truck in about 10 days. Then the truck drove to an AWS data center. Every bit took days to arrive, which is awful latency. But the total amount moved per day was far more than a 10 Gbps link could carry. AWS [stopped offering Snowmobile in 2024](https://www.cnbc.com/2024/04/17/aws-stops-selling-snowmobile-truck-for-cloud-migrations.html) because newer services made moving data cheaper, but the example still shows the difference clearly.

**Plenty of bandwidth, still slow: a small request sent far away.** The [table of latency numbers every programmer should know](/learn/numbers-to-know#latency-numbers-every-programmer-should-know) lists a round trip from California to the Netherlands and back at 150 ms. A 1 KB request takes about that long whether the link runs at 1 Gbps or 100 Gbps. The delay comes from the distance and the speed of light, not from the size of the pipe. To reduce it, you move the data closer to the user, with a [CDN](/learn/dns-and-cdn-101#content-delivery-networks) or a nearer data center, or you make fewer round trips.

The standard advice, from Bonér's slides, is to aim for maximal throughput with acceptable latency. The next two sections show why you usually can't have the best of both.

## The trade-off: batching and queueing

### Batching

Think of a bus. If it waits until it is full before leaving, it carries more people per trip. But the first person to get on waits the longest. Computers make the same trade. Every send has a fixed cost, such as a network round trip, a disk write or a call into the operating system. Grouping many items into one send pays that cost once instead of many times, so throughput goes up. The price is that the first item in the batch waits for the others.

Kafka, a popular message system, exposes this trade-off as a setting. Its producer option [`linger.ms`](https://kafka.apache.org/41/configuration/producer-configs/) tells the producer to wait up to that many milliseconds so it can send more records together. The documentation says that setting it to 50 would reduce the number of requests sent, but "would add up to 50ms of latency to records sent in the absence of load." In Kafka 4.0, the default changed from 0 ms to 5 ms. The docs explain that larger batches are efficient enough that overall latency usually ends up about the same or lower. So when traffic is light, batching only adds delay. When traffic is heavy, a system that batches can end up faster than one that doesn't.

### Queueing: why busy servers get slow suddenly

Think of a supermarket checkout. When the cashier is idle, you walk straight up. When the cashier is busy most of the time, a line forms, and the line gets long much faster than the number of shoppers grows.

Servers behave the same way. **Utilization** is the fraction of time a server is busy. As it rises, requests spend more time waiting before the server even starts on them. The simplest queueing model, called M/M/1, describes one server with requests arriving at random times and taking random amounts of time to serve. In that model ([Raj Jain's lecture notes](https://research.engineering.wustl.edu/~jain/cse567-15/ftp/k_31asq.pdf)), the average response time is:

```
response time = service time / (1 - utilization)
```

Say a Crumb search server needs 10 ms of actual work per request:

| How busy the server is | Average response time |
| --- | --- |
| 50% | 20 ms |
| 80% | 50 ms |
| 90% | 100 ms |
| 95% | 200 ms |
| 99% | 1,000 ms |

Going from 50% busy to 80% busy adds 30 ms. Going from 90% to 99% adds 900 ms. Real servers don't follow the model exactly, but they follow the same shape. Latency stays almost flat for a long time, then shoots up as the server nears 100%.

This has three practical consequences:

- **Leave headroom.** For example, add servers automatically well before CPU reaches 100%.
- **"Fine at 85%" can still fall over.** A server that looks healthy at 85% busy is close to the steep part of the curve, so a small rise in traffic can make latency jump.
- **Above 100%, the queue never drains.** If requests arrive faster than the server can handle them, the line grows without limit. The only fixes are more capacity or turning some work away.

Running every server at 100% gets the most work out of the hardware, and it gives users the worst latency.

## Little's Law

One simple formula links latency, throughput and how many requests are being handled at once.

Start with a coffee shop. If two customers walk in every minute, and each one stays for 15 minutes, then on average there are 2 × 15 = 30 customers inside. That is **Little's Law**:

```
L = λ × W
in-flight requests = arrival rate × average latency
```

*L* is the average number of items in the system, *λ* (lambda) is the average arrival rate, and *W* is the average time each item spends in the system. John Little published a proof in 1961. In his [review of the law 50 years later](https://people.cs.umass.edu/~emery/classes/cmpsci691st/readings/OS/Littles-Law-50-Years-Later.pdf), he notes that it holds "under remarkably general conditions." It works for one queue or a whole network of them, and it doesn't matter in what order requests are served.

```diagram
title: Little's Law. Requests in the system = arrival rate × time each spends there.
[in:client] Arrivals\nλ = 2,000/s @ 0,0
[sys] Search service\nL = 100 in flight @ 1,0
[out:client] Responses\nW = 50 ms each @ 2,0
in -> sys
sys -> out
```

**Sizing Crumb's connection pool.** At peak, Crumb's search gets 2,000 requests a second, and each takes 50 ms on average. So about 2,000 × 0.05 = 100 searches are in progress at any moment. If each search holds a database connection for its whole duration, the pool needs at least 100 connections.

**How one slow dependency causes a pile-up.** Now the database slows down, and searches take 500 ms instead of 50 ms. Users keep arriving at the same rate, so the number of searches in progress jumps to 2,000 × 0.5 = 1,000. The pool only has 100 connections, so new requests have to wait for one. That waiting makes latency even worse, which means even more requests pile up. This is how one slow dependency can take down a service that was otherwise healthy, and it is why timeouts and limits on concurrent requests matter.

If you know any two of the three numbers, you can work out the third. For example, you can work out how many threads or connections you need, or how much throughput a fixed-size pool can handle at a given latency.

## Averages hide the slow requests

Suppose Crumb's search has an average latency of 60 ms. That sounds fine, but it can hide a lot. If 99 searches take 30 ms and one takes 3 seconds, the average is still about 60 ms. Meanwhile, one user in every hundred waits three seconds.

That is why teams measure **percentiles** instead:

- **p50**, the median: half of requests are faster than this.
- **p99**: 99% of requests are faster than this, and 1% are slower.

A service might report "p50 of 30 ms, p99 of 400 ms." The slow end of the distribution, beyond the p99 or so, is called the **tail**.

The tail matters more than "1%" suggests, for two reasons:

1. **Each user makes many requests.** Someone who loads 100 pages in a session has about a 63% chance of hitting at least one page slower than the p99. (The chance that all 100 are fast is 0.99¹⁰⁰, about 37%.)
2. **One page usually calls many backend services.** The page can't finish until the slowest of those calls returns.

### The Tail at Scale

Jeff Dean and Luiz André Barroso of Google studied the second point in [The Tail at Scale](https://www.barroso.org/publications/TheTailAtScale.pdf) (Communications of the ACM, February 2013).

Their example is a server that usually responds in 10 ms, but 1 request in 100 takes a full second. If a user's request goes to just one such server, 1 in 100 users waits a second. Now suppose each user request has to collect answers from 100 of these servers in parallel. Each server is fast 99% of the time, so all 100 are fast only 0.99¹⁰⁰ ≈ 37% of the time. That means 63% of user requests take more than a second. It gets worse with more servers. Even if each server is slow only 1 time in 10,000, a request that has to reach 2,000 servers is slow almost 1 time in 5.

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

They also give numbers from a real Google service built this way, where one root server sends each request out to many leaf servers:

- For a single leaf request, the 99th-percentile time was 10 ms.
- For 95% of all the leaf requests to finish, the 99th-percentile time was 70 ms.
- For all of the leaf requests to finish, the 99th-percentile time was 140 ms.

In other words, waiting for the last 5% of leaf replies doubled the time, from 70 ms to 140 ms.

The causes of slow replies are ordinary: machines shared with other jobs, background programs, garbage collection, log compaction, chips slowing down to save power or stay cool, and requests waiting in queues at several layers. Dean and Barroso concluded that you can't remove all of these. Instead, large systems have to be "tail-tolerant": able to give fast answers even though some parts are slow, in the same way fault-tolerant systems keep working even though some parts fail.

One of their techniques is the **hedged request**. Send the request to one copy of the data. If it hasn't answered after a short wait, send the same request to a second copy, and use whichever answer arrives first. In one Google test, a request read 1,000 keys from a Bigtable spread across 100 servers. Sending a hedge after 10 ms cut the 99.9th-percentile latency from 1,800 ms to 74 ms, and it added only 2% more requests. A variant waits until the 95th-percentile latency before sending the hedge, which keeps the extra load to about 5%.

For Crumb, the lessons are to watch p99 rather than the average, and to remember that every extra backend call on a page is another chance to hit a slow reply.

## Why latency matters to the business

Dean and Barroso note that systems that respond within about 100 ms "feel more fluid and natural to users." Measuring what slowness actually costs is harder. The only reliable way is to make the product slower on purpose for some users and compare them with everyone else.

Google did exactly that in 2009. Jake Brutlag's report, [Speed Matters for Google Web Search](https://services.google.com/fh/files/blogs/google_delayexp.pdf), describes the experiments. For four to six weeks, one group of users had an extra 50 to 400 ms of delay added to their search results on Google's servers. A control group had no delay. Delays of 100 to 400 ms reduced the number of searches each user made per day by 0.2% to 0.6%. The 400 ms delay cost 0.59%.

Two other findings were more important:

- **The effect grew over time.** With the 400 ms delay, users made 0.44% fewer searches in the first half of the experiment and 0.74% fewer in the second half.
- **The effect lasted after the delay was removed.** Once the 400 ms delay was switched off, those users still searched 0.21% less than the control group, averaged over the next five weeks.

So users who learn that a product is slow use it less, and they keep using it less for a while even after it gets fast again. Google's [blog post on the experiment](https://research.google/blog/speed-matters/) summarizes the same results.

A fraction of a percent sounds small. At Google's scale, it adds up to a lot of lost searches, all caused by delays shorter than half a second.

## Reading the classic sources

**Vogels's post** is about 450 words and worth reading in full. Its value is the framing: you have to design for scale from the start, scaling covers redundancy as well as capacity, and a growing fleet ends up as a mix of old and new hardware.

**Bonér's deck** has 196 slides. SlideShare lists it as published in May 2010, and the title slide gives his role as CTO of Typesafe. This chapter uses only about six of those slides: "How do I know if I have a performance problem?", the same question for scalability, and "You should strive for maximal throughput with acceptable latency." The rest of the deck is a tour of patterns this handbook covers later: the CAP theorem and eventual consistency, fail-over and replication, partitioning and HTTP caching, sharding, NoSQL databases, distributed caching, and concurrency models. The slides have very little explanation on them, so they work best as a checklist after you have read the matching chapters, such as [CAP and consistency](/learn/cap-and-consistency-101), [caching](/learn/cache-101) and [relational databases](/learn/relational-databases).

**The Cadence post** was written for hardware engineers learning high-level synthesis, a way of designing chips from code. After the definitions and the car-factory example, it moves on to measuring latency in clock cycles, which won't help with web services. It doesn't cover queueing, Little's Law or tail latency, which is why this chapter spends most of its length on them.

## Check yourself

<details>
<summary>Crumb's recipe page takes 2.5 seconds to load even when the site is nearly empty. Is this a performance problem or a scalability problem, and would adding app servers help?</summary>

It's a performance problem, because the page is slow even for a single user. Adding servers won't help. With only one user on the site, nothing is competing for resources. The time is going into the work each request does. Profile the request and look for causes like a missing index, one database query per item on the page (N+1 queries), or large images and scripts. Fixing it usually helps under load too, because each request then holds resources for less time.

</details>

<details>
<summary>A batch job is 90% parallelizable. What's the best speedup you can get on 8 machines, and on unlimited machines? Why might the real number be lower?</summary>

By Amdahl's law, on 8 machines the speedup is 1 / (0.1 + 0.9/8) = 1 / 0.2125, about 4.7 times. With unlimited machines it gets close to 1 / 0.1 = 10 times but never reaches it. Real systems usually do worse, because the machines also spend time coordinating, waiting for shared resources and keeping data consistent. The Universal Scalability Law models this. With enough coordination cost, adding machines eventually makes the system slower.

</details>

<details>
<summary>A service handles 500 requests a second with an average latency of 200 ms. How many requests are in flight? What happens if a dependency slows down and latency doubles?</summary>

By Little's Law, in-flight requests = 500 × 0.2 = 100. If latency doubles to 400 ms and requests keep arriving at the same rate, in-flight requests double to 200. Any fixed pool sized for 100, such as threads or database connections, runs out. New requests have to wait, which raises latency further, and the problem feeds itself. Timeouts, limits on concurrent requests, and turning away extra load early stop the spiral.

</details>

<details>
<summary>Each of a page's 50 backend calls is slow 1% of the time. Roughly what fraction of page loads include at least one slow call, and what can you do about it?</summary>

The page is fast only if all 50 calls are fast. That happens 0.99⁵⁰ ≈ 61% of the time, so about 39% of page loads hit at least one slow call. This is the fan-out effect from The Tail at Scale. You can make fewer calls. You can make the calls in parallel, give each a timeout, and show partial results when that's acceptable. Or you can hedge: if a call to a replicated service hasn't returned by about its 95th-percentile latency, send it to a second copy and use whichever answer comes first.

</details>

<details>
<summary>Your servers average 90% CPU and latency looks fine. Why might a manager's plan to "use the hardware fully" by removing a few servers be a bad idea?</summary>

Waiting time grows sharply as a server gets close to 100% busy. In the simple M/M/1 model, response time is the service time divided by (1 − utilization). That is 10 times the service time at 90% busy, 20 times at 95%, and 100 times at 99%. Removing servers pushes the rest into the steep part of that curve. Then ordinary traffic spikes cause big jumps in latency or a backlog that keeps growing. Spare capacity is what keeps latency acceptable.

</details>

## Further reading

The three classic sources:

- [A Word on Scalability](https://www.allthingsdistributed.com/2006/03/a_word_on_scalability.html): Werner Vogels's March 2006 post, the source of the standard definition of scalability.
- [Scalability, Availability & Stability Patterns](https://www.slideshare.net/jboner/scalability-availability-stability-patterns): Jonas Bonér's 196-slide deck. Read it as a checklist of patterns after the matching chapters.
- [Understanding Latency versus Throughput](https://community.cadence.com/cadence_blogs_8/b/fv/posts/understanding-latency-vs-throughput): Cadence's post with the car-factory example. The page sits behind a browser check that blocks some tools. If it won't load, there's an [archived copy from February 2026](https://web.archive.org/web/20260215115328/https://community.cadence.com/cadence_blogs_8/b/fv/posts/understanding-latency-vs-throughput).

Papers and reports:

- [The Tail at Scale](https://www.barroso.org/publications/TheTailAtScale.pdf): Dean and Barroso, Communications of the ACM, February 2013. Seven pages, and readable without any background in queueing theory.
- [Speed Matters for Google Web Search](https://services.google.com/fh/files/blogs/google_delayexp.pdf): Jake Brutlag's 2009 delay experiments, with the [blog post](https://research.google/blog/speed-matters/) that announced them.
- [HealthCare.gov: Case Study of CMS Management of the Federal Marketplace](https://oig.hhs.gov/documents/evaluation/2981/OEI-06-14-00350-Complete%20Report.pdf): the HHS Inspector General's 2016 report on the launch.
- [Little's Law as Viewed on Its 50th Anniversary](https://people.cs.umass.edu/~emery/classes/cmpsci691st/readings/OS/Littles-Law-50-Years-Later.pdf): John Little on his own law, with examples from operations and computer architecture.
- [Validity of the single processor approach](https://www3.cs.stonybrook.edu/~rezaul/Spring-2019/CSE613/reading/Amdahl-1967.pdf): Gene Amdahl's 1967 paper, three pages long, in IEEE's 2007 reprint.
- [The Universal Scalability Law](http://www.perfdynamics.com/Manifesto/USLscalability.html): Neil Gunther's explanation of the model and its two settings.
- [Analysis of a single queue](https://research.engineering.wustl.edu/~jain/cse567-15/ftp/k_31asq.pdf): Raj Jain's lecture slides with the M/M/1 results used above.

Examples:

- [AWS Snowmobile announcement](https://aws.amazon.com/blogs/aws/aws-snowmobile-move-exabytes-of-data-to-the-cloud-in-weeks/): Jeff Barr's 2016 post, and [CNBC on its retirement](https://www.cnbc.com/2024/04/17/aws-stops-selling-snowmobile-truck-for-cloud-migrations.html) in 2024.
- [Kafka producer configuration](https://kafka.apache.org/41/configuration/producer-configs/): see `linger.ms` and `batch.size` for a real batching setting.
