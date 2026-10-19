<!-- chapter: how-to-approach-a-system-design-interview-question -->

## What are the four steps you can use to lead a system design interview?
<!-- /learn/how-to-approach-a-system-design-interview-question -->

1. Outline use cases, constraints and assumptions.
2. Create a high level design.
3. Design core components.
4. Scale the design.

The interview is an open-ended conversation, and you're expected to lead it. These steps give the discussion a shape.

## In the first step of a design interview, what questions help you scope the problem?
<!-- /learn/how-to-approach-a-system-design-interview-question#step-1-outline-use-cases-constraints-and-assumptions -->

- Who will use it, and how? How many users are there?
- What does the system do? What are its inputs and outputs?
- How much data do you expect to handle?
- How many requests per second?
- What is the expected **read to write ratio**?

Ask to clarify use cases and constraints, and say your assumptions out loud.

## You're asked to design a URL shortener. Which core components could you dig into in step 3?
<!-- /learn/how-to-approach-a-system-design-interview-question#step-3-design-core-components -->

- Generating and storing a hash of the full URL (MD5 and Base62)
- Hash collisions
- SQL or NoSQL, and the database schema
- Translating a hashed URL back to the full URL, via a database lookup
- The API and object-oriented design

## In the "scale the design" step, what are you trying to do, and which tools might you reach for?
<!-- /learn/how-to-approach-a-system-design-interview-question#step-4-scale-the-design -->

Identify and address bottlenecks, given the constraints you agreed in step 1. Typical tools are a load balancer, horizontal scaling, caching and database sharding. Discuss possible solutions and their trade-offs. Everything is a trade-off.

## Which reference tables help when you're asked for back-of-the-envelope estimates?
<!-- /learn/how-to-approach-a-system-design-interview-question#back-of-the-envelope-calculations -->

The primer's Appendix has three:

- Guidance on using back-of-the-envelope calculations
- A **powers of two** table
- **Latency numbers** every programmer should know

You may be asked to do these estimates by hand during the interview.

<!-- chapter: scalability-101 -->

## Stack Overflow ran on a handful of big servers. What three limits stop most teams from only scaling up?
<!-- /learn/scalability-101#scaling-up-a-bigger-machine -->

**Vertical scaling** is simple: your code doesn't change, and nothing can go wrong between machines. But:

- **There's a ceiling.** Eventually you're on the largest machine anyone sells.
- **Cost grows faster than capacity.** The top-end machine costs far more than twice one with half its power.
- **It's still one machine.** A failure or a reboot for patches takes everything down.

## You run three app servers behind a load balancer and users get logged out at random. Why, and what's the robust fix?
<!-- /learn/scalability-101#scaling-out-clones-behind-a-load-balancer -->

Each server keeps sessions in its own memory, so a request that lands on a different server finds no session. Follow the golden rule: every server runs the same code and keeps **no user data on its own disk or memory**. Put sessions in a shared store like Redis or the database, and uploads in shared storage such as an object store. The servers become **stateless** clones.

## What do sticky sessions cost you compared with stateless servers?
<!-- /learn/scalability-101#scaling-out-clones-behind-a-load-balancer -->

With **sticky sessions**, the load balancer sends a user back to the same server every time, often using a cookie. It's quicker to set up, but:

- Load spreads unevenly.
- When a server dies, every user stuck to it loses their session.

Stateless servers are the more robust default.

## Why is DNS round robin a weak way to spread traffic across servers?
<!-- /learn/scalability-101#load-balancing -->

Browsers, operating systems and ISPs cache DNS answers. So one busy server can keep getting traffic, and a dead server keeps getting traffic until the cached records expire. A dedicated load balancer fixes this by running **health checks** and choosing a server per request.

## Why do most teams cache whole objects rather than SQL query results?
<!-- /learn/scalability-101#caching -->

- **Query results**, keyed on a hash of the SQL, are easy to add but hard to keep correct. When one row changes, you must find every cached query that included it.
- **Objects**, like "recipe 812, fully assembled", need one key deleted when the recipe changes.

Either way, keep the cache in a shared in-memory store, not in files on each app server.

## What turned a bad config value into Facebook's 2010 outage, and what's the general lesson?
<!-- /learn/scalability-101#caching -->

Clients treated a cached config value as invalid and fetched a fresh copy from the database. Then the database itself held a value the system treated as invalid, so every client kept querying it: hundreds of thousands of queries a second. The site went down for about two and a half hours. Plan for many requests missing the cache at once, a **cache stampede** or thundering herd.

## A user posts a comment, the page reloads, and the comment seems missing. What's the likely cause and the usual fix?
<!-- /learn/scalability-101#database-replication -->

**Replication lag.** The write went to the primary, but the reload read from a replica that hadn't received it yet. Lag is usually milliseconds but can be seconds under load. The fix is **read-your-own-writes**: for a short time after a user writes, send that user's reads to the primary.

## Besides more read capacity, what does primary-replica replication buy you?
<!-- /learn/scalability-101#database-replication -->

**Failover.** If the primary dies, a replica can be promoted to take its place, so replication protects availability, not just performance. Early Instagram streamed each of its 12 PostgreSQL servers to a replica in a different availability zone, so a whole data center could fail without losing data.

## What two problems does a poorly chosen shard key cause?
<!-- /learn/scalability-101#database-partitioning -->

- **Cross-shard queries.** A query like "this user's friends at every school" must hit many shards and merge results in your code. Joins across shards are slow or unsupported.
- **Hot spots.** One shard holding a celebrity, or all of today's records, gets most of the traffic.

Choose a key that keeps related data together, like early Facebook's database for each school.

## Photo uploads take 8 seconds because thumbnails are made during the request. How do you fix it, and what new risk appears?
<!-- /learn/scalability-101#asynchronism -->

Put a "make thumbnails" job on a **queue** and reply at once ("Your photo is processing"). **Workers** take jobs off the queue in the background. The queue also absorbs spikes. The new risk is a backlog: if uploads arrive faster than workers finish them, the queue only grows, and you need to turn requests away early (back pressure).

<!-- chapter: performance-vs-scalability -->

## How do you tell a performance problem from a scalability problem?
<!-- /learn/performance-vs-scalability -->

- **Performance problem:** the system is slow for a single user.
- **Scalability problem:** the system is fast for a single user but slow under heavy load.

<!-- chapter: latency-vs-throughput -->

## What's the difference between latency and throughput, and what should you aim for?
<!-- /learn/latency-vs-throughput -->

- **Latency** is the time to perform an action or produce a result.
- **Throughput** is the number of such actions or results per unit of time.

Aim for **maximal throughput with acceptable latency**.

<!-- chapter: performance-and-latency-101 -->

## Search takes 3 seconds even at 4 a.m. with one user on the site. Will adding servers help?
<!-- /learn/performance-and-latency-101#performance-and-scalability-are-different-problems -->

No. It's a **performance problem**: nothing is competing for resources, so the time goes into the work each request does. Look for a missing index, one query per result (N+1 queries) or a page loading 4 MB of images. Use a profiler. If search were fast at 4 a.m. but slow at peak, that's a scalability problem: find what requests wait for, then add more of it or need less of it.

## A job is 95% parallelizable. What speedup do you get on 16 machines, and what's the ceiling?
<!-- /learn/performance-and-latency-101#reason-2-some-work-cant-be-split-up-amdahls-law -->

By **Amdahl's law**, speedup = 1 / ((1 − p) + p / N).

- On 16 machines: 1 / (0.05 + 0.95/16), about 9 times, not 16.
- With unlimited machines: 1 / 0.05 = 20 times at most.

The 5% that runs serially sets the ceiling.

## What does the Universal Scalability Law add to Amdahl's law, and what can happen as you add machines?
<!-- /learn/performance-and-latency-101#reason-3-machines-have-to-coordinate -->

It adds **coherency** (β), the cost of keeping data consistent between nodes, on top of **contention** (α), waiting for shared resources. With β above zero, throughput eventually goes "retrograde". With α = 0.05 and β = 0.001, 10 machines give about 6.5 times one machine, 30 give about 9, and 60 give about 8. So share as little as possible between requests and machines.

## What was the worst bottleneck at HealthCare.gov's 2013 launch?
<!-- /learn/performance-and-latency-101#a-real-scalability-failure-healthcaregov -->

The account and identity system every visitor had to pass through first. Its contractor hadn't known all traffic would go through it and planned too little capacity: "a small, one-lane onramp to a major highway." It also blocked repairs to the rest of the site. Load testing ran only days before launch, too late for the results to change anything.

## Why did AWS ship data on a truck (Snowmobile) instead of over the network?
<!-- /learn/performance-and-latency-101#latency-and-throughput -->

Latency and throughput are independent. Sending 100 PB over a fully used 10 Gbps link takes about 926 days. Snowmobile loaded data at 1 Tb/s, then drove it to an AWS data center. Each bit took days to arrive, which is terrible latency, but the throughput was far beyond the link's.

## What does Kafka's linger.ms setting trade, and why did Kafka 4.0 change its default?
<!-- /learn/performance-and-latency-101#batching -->

It makes the producer wait up to that many milliseconds so more records go in one batch. Fewer, larger sends raise throughput, but at low load each record can wait the full delay. Kafka 4.0 raised the default from 0 to 5 ms because larger batches usually give similar or lower latency overall. Under heavy load, batching can make a busy system faster.

## Your servers average 90% CPU and latency looks fine. Why is removing a few servers to "use the hardware fully" risky?
<!-- /learn/performance-and-latency-101#queueing-why-busy-servers-get-slow-suddenly -->

In the M/M/1 model, response time is the service time divided by (1 − utilization). With 10 ms of work: 50 ms at 80% busy, 100 ms at 90%, 200 ms at 95%, 1,000 ms at 99%. Latency stays flat, then climbs steeply near full use. Removing servers pushes you onto the steep part, so ordinary spikes cause big latency jumps.

## Search gets 2,000 requests a second at 50 ms each. What happens to your 100-connection pool if latency rises to 500 ms?
<!-- /learn/performance-and-latency-101#littles-law -->

**Little's Law**: in-flight requests = arrival rate × average latency. At 50 ms that's 100, just enough. At 500 ms it's 1,000. The pool runs out, new requests queue, latency rises further and more requests pile up. That's how one slow dependency takes down a healthy service, and why timeouts and concurrency limits matter.

## Why should you track p99 latency instead of the average?
<!-- /learn/performance-and-latency-101#averages-hide-the-slow-requests -->

An average hides the slow **tail**: 99 requests at 30 ms and one at 3 seconds still average about 60 ms. The tail matters more than it looks because users make many requests. Someone loading 100 pages hits at least one p99-slow page with probability 1 − 0.99¹⁰⁰, about 63%. And a page is only as fast as its slowest backend call.

## Each server is slow 1% of the time. Why are 63% of requests slow when each one fans out to 100 such servers?
<!-- /learn/performance-and-latency-101#the-tail-at-scale -->

The request waits for the slowest server. All 100 are fast with probability 0.99¹⁰⁰ ≈ 0.37, so 63% of requests hit at least one slow reply. In a real Google service, the p99 for one leaf was 10 ms, but for all leaves to finish it was 140 ms. Dean and Barroso conclude large systems must be "tail-tolerant".

## What is a hedged request, and what did it achieve in Google's Bigtable benchmark?
<!-- /learn/performance-and-latency-101#the-tail-at-scale -->

Send a request to one replica. If it hasn't answered within a short delay, send it to a second and use whichever answers first. Hedging after 10 ms cut the 99.9th-percentile latency from 1,800 ms to 74 ms while sending only 2% more requests. Waiting until the 95th-percentile latency before hedging limits extra load to about 5%.

## What did Google's 2009 delay experiments show about how users react to slower search?
<!-- /learn/performance-and-latency-101#why-latency-matters-to-the-business -->

Added delays of 100 to 400 ms cut daily searches per user by 0.2% to 0.6%. The effect grew over time: with 400 ms, 0.44% fewer searches in the first half and 0.74% fewer in the second. It also outlasted the delay. Users still searched 0.21% less over the five weeks after it was removed.

<!-- chapter: availability-vs-consistency -->

## Why does CAP leave you choosing only between consistency and availability?
<!-- /learn/availability-vs-consistency#cap-theorem -->

CAP says a distributed system can support only two of consistency, availability and partition tolerance. Networks aren't reliable, so you must support **partition tolerance**. That leaves a software trade-off: during a partition, either return the most recent write or an error (consistency), or always respond, possibly with older data (availability).

## When is a CP system a good choice, and what does a client see during a partition?
<!-- /learn/availability-vs-consistency#cp---consistency-and-partition-tolerance -->

CP fits when your business needs **atomic reads and writes**. During a partition, waiting for a response from the partitioned node might end in a timeout error. You get correct data or no answer.

## When is an AP system a good choice, and what does a read return during a partition?
<!-- /learn/availability-vs-consistency#ap---availability-and-partition-tolerance -->

A read returns the most readily available version of the data on any node, which might not be the latest. Writes may take time to propagate once the partition heals. AP fits when the business can accept **eventual consistency**, or when the system must keep working despite external errors.

<!-- chapter: consistency-patterns -->

## Why does weak consistency suit a video call or a multiplayer game?
<!-- /learn/consistency-patterns#weak-consistency -->

After a write, reads may or may not see it; it's a best-effort approach, as in memcached. In real-time use, old data has no value. If you lose reception on a call for a few seconds, you don't hear what was said while you were gone. You just pick up from now.

## How do eventual and strong consistency differ in how data is replicated, and what does each suit?
<!-- /learn/consistency-patterns#eventual-consistency -->

| | Eventual | Strong |
| --- | --- | --- |
| After a write | Reads see it eventually (typically ms) | Reads see it |
| Replication | Asynchronous | Synchronous |
| Seen in | DNS, email | File systems, RDBMSes |
| Suits | Highly available systems | Systems needing transactions |

<!-- chapter: cap-and-consistency-101 -->

## How is the C in CAP different from the C in ACID?
<!-- /learn/cap-and-consistency-101#what-c-a-and-p-actually-mean -->

CAP's C is **linearizability**: the system acts as if there were a single copy, so once any reader sees a write, no later reader sees the old value. It's about single operations. ACID's C means a transaction keeps the database's rules, like unique keys or a balance never going negative. Brewer calls CAP's version "a strict subset of ACID consistency."

## A teammate says, "Our database is CA: we just don't allow partitions." What's wrong with that?
<!-- /learn/cap-and-consistency-101#why-pick-two-of-three-misleads -->

You can't choose to give up P. Partitions are network failures that happen to you. Robinson's CAP FAQ says there's "no realistic CA system" among distributed systems; only a single machine with nothing to be cut off from is truly CA. The real question is what the database does during a partition: stop serving some requests (CP) or serve possibly stale data (AP).

## During a partition, how can a bank do better than simply refusing or allowing all withdrawals?
<!-- /learn/cap-and-consistency-101#why-pick-two-of-three-misleads -->

Use a bounded **partition mode**, like Brewer's ATM stand-in mode. Keep accepting deposits and showing balances (marked possibly stale), but cap withdrawals at an amount like $200. When the link returns, reconcile and charge a fee for any overdraft. The bank relies on auditing and compensation, not consistency, for correctness, and the risk is limited to the cap.

## Do network partitions really happen inside well-run data centers?
<!-- /learn/cap-and-consistency-101#partitions-really-happen -->

Yes. A study of Microsoft data centers counted a mean of 5.2 device failures and 40.8 link failures per day, and found network redundancy "only 40% effective" at reducing the median impact. A switch update at GitHub in 2012 caused a 90-second partition and five hours of recovery. Even Google saw data centers or regions cut off.

## Why can a deleted item reappear in a Dynamo shopping cart, and why did Amazon accept that?
<!-- /learn/cap-and-consistency-101#amazons-shopping-cart-stay-writable-merge-later -->

During failures, different replicas accept writes and keep conflicting versions, tracked with vector clocks. The cart merges them so an "add to cart" is never lost, which means an item removed on one side but still present on the other survives the merge. For Amazon, even a slight outage has significant financial consequences, so it chose AP for carts on purpose.

## Spanner is technically CP. Why does Brewer call it "effectively CA"?
<!-- /learn/cap-and-consistency-101#google-spanner-consistent-and-available-enough -->

During some partitions it chooses consistency: a leader that can't reach a majority stalls its updates. But its availability, better than five nines internally, is high enough that users treat it as always up. That's mostly down to Google's private network, with at least three independent fibers per data center typically. Brewer says TrueTime "does not significantly help achieve CA".

## How did a 43-second network cut at GitHub in 2018 turn into 24 hours of degraded service?
<!-- /learn/cap-and-consistency-101#github-october-2018-a-partition-makes-the-choice-for-you -->

Orchestrator formed a quorum without the primary East Coast data center and failed databases over to the West. A few seconds of East writes never replicated, so both coasts held writes the other lacked. GitHub chose data integrity over usability, restored from backups and reconciled stray writes by hand. It made a CP choice mid-incident, at a high price.

## According to PACELC, which trade-off does a multi-region system face most often, and why?
<!-- /learn/cap-and-consistency-101#pacelc-the-trade-off-when-nothing-is-broken -->

**Latency against consistency.** Partitions are rare, but if every write waits for the other region to confirm, every user pays a cross-region round trip on every write, every day. PACELC: if partitioned, trade A against C; else, trade L against C. Abadi classes Dynamo and Cassandra as PA/EL, BigTable and HBase as PC/EC, and MongoDB as PA/EC.

## A user's deposit vanishes on refresh, then reappears on the next. Which guarantees are missing, and what's a cheap fix?
<!-- /learn/cap-and-consistency-101#guarantees-for-one-user -->

**Read-your-writes**, and likely **monotonic reads**: their reads hit replicas at different points. Cheap fixes without global strong consistency:

- Send a user's reads to the primary for a few seconds after they write.
- Pin each user to one replica so their view never moves backward.

## With N = 3 replicas, why do W = 2 and R = 2 give strong consistency while W = 1 and R = 1 don't?
<!-- /learn/cap-and-consistency-101#quorums-n-r-and-w -->

If **W + R > N**, the write set and read set always overlap, so every read includes at least one replica with the latest write. With W + R ≤ N, a read can hit only replicas that missed it, giving eventual consistency. (3,2,2) was Dynamo's common setting. Kleppmann warns quorums alone aren't a safe guarantee of linearizability.

## In Barrett's comparison, how do two-phase commit and Paxos differ?
<!-- /learn/cap-and-consistency-101#what-barretts-talk-adds -->

Both give strong consistency with no data loss and high latency. **2PC** is heavyweight and synchronous, with low throughput, and needs all members up, earning the name "anti-availability" protocol. **Paxos** uses majority writes, so it survives a minority of failures, with medium throughput. Spanner combines them, making each 2PC participant a Paxos group.

<!-- chapter: availability-patterns -->

## In active-passive fail-over, what decides how long the outage lasts when the active server dies?
<!-- /learn/availability-patterns#active-passive -->

The passive server watches heartbeats. When they stop, it takes over the active's IP address and resumes service. Downtime depends on whether the passive is already running in **hot** standby or must start up from **cold** standby. Only the active server handles traffic until then.

## In active-active fail-over, who needs to know about both servers?
<!-- /learn/availability-patterns#active-active -->

Both servers manage traffic and share the load. If they're public-facing, **DNS** must know both servers' public IPs. If they're internal-facing, the **application logic** must know about both. It's also called master-master failover.

## What are the drawbacks of fail-over?
<!-- /learn/availability-patterns#disadvantages-failover -->

- It adds more hardware and more complexity.
- You can lose data if the active system fails before newly written data is replicated to the passive.

## Two components each have 99.9% availability. What's the total in sequence and in parallel?
<!-- /learn/availability-patterns#availability-in-parallel-vs-in-sequence -->

- **Sequence** (both must work): 0.999 × 0.999 ≈ **99.8%**. Availability drops.
- **Parallel** (either can serve): 1 − (0.001 × 0.001) = **99.9999%**. Availability rises.

<!-- chapter: availability-101 -->

## Your servers were up all month, yet users say recipe pages failed to load. What should you measure instead of uptime?
<!-- /learn/availability-101#what-availability-means -->

**Aggregate availability**: the fraction of real requests that succeed. Time-based availability only asks whether servers ran, and a running server can still time out or return errors. Google's SRE book says time-based metrics usually aren't meaningful for globally distributed services. At 99.99%, 2.5 million requests a day may include up to 250 errors.

## How do you tell an SLO from an SLA?
<!-- /learn/availability-101#slis-slos-and-slas -->

Ask "what happens if the SLOs aren't met?" If nothing happens, it's an **SLO**, a target for an SLI such as "99.95% of recipe page loads succeed over 30 days". If someone owes a refund or penalty, it's an **SLA**, a contract. Companies usually set internal SLOs stricter than the SLAs they sign, to notice trouble before it costs money.

## S3 promises 11 nines of durability but only 99.99% availability. What's the difference?
<!-- /learn/availability-101#availability-vs-durability -->

**Durability** is whether your data still exists. **Availability** is whether you can reach it right now. S3 is designed so it's very unlikely to lose an object, yet it's allowed to make data unreachable for hours a year. S3 One Zone-IA, in a single availability zone, is designed for only 99.5% availability.

## How much downtime do three and four nines allow, and why does four nines rule out waiting for a human?
<!-- /learn/availability-101#the-nines -->

| | Per year | Per month |
| --- | --- | --- |
| 99.9% | 8h 45m 57.6s | 43m 49.8s |
| 99.99% | 52m 35.8s | 4m 23.0s |

4 minutes 23 seconds a month is less than it takes an on-call engineer to wake up and log in, so most failures must be recovered automatically.

## Your SLO is 99.95% on 10 million page loads a month. What's your error budget, and what is it for?
<!-- /learn/availability-101#why-not-100 -->

The budget is one minus the target: 0.05% of 10 million, or **5,000 failed page loads**. A bad deploy that breaks 2,000 uses 40% of it. The budget is meant to be spent on shipping changes. While it lasts, the team releases; when an outage uses it up, releases slow down. 100% is the wrong target because users can't tell it from 99.999%.

## A server fails every 30 days and takes 4 hours to fix. Should you halve failures or cut repair to 30 minutes?
<!-- /learn/availability-101#failures-and-recovery-mtbf-and-mttr -->

Availability ≈ MTBF / (MTBF + MTTR).

- Today: 720 / 724 ≈ 99.45%
- Halve failures: 1,440 / 1,444 ≈ 99.72%
- 30-minute repair: 720 / 720.5 ≈ 99.93%

Faster recovery wins, and it's often more achievable, for example with automated failover.

## A standby misses heartbeats and promotes itself. What can go wrong, and how do real systems prevent it?
<!-- /learn/availability-101#split-brain-and-fencing -->

The active may still be alive with only the link broken. Then both accept writes and their data diverges: **split brain**. **Fencing** (STONITH, "Shoot The Other Node In The Head") makes the old node unable to run, by cutting its power, storage or network. A **quorum** of three or more nodes also helps, since a node cut off from the majority steps down.

## Two active-active nodes each run at 70%. What happens when one dies, and how should you plan capacity?
<!-- /learn/availability-101#fail-over-active-active -->

The survivor needs 140% of its capacity, so it falls over too. Plan for **N+1**: one more node than the load needs. Active-active is easy for stateless servers but hard for databases, where two writers can conflict, so many teams run app servers active-active and the database active-passive.

## Two 99.9% servers in parallel should give six nines. Why can the real figure be far lower?
<!-- /learn/availability-101#the-big-caveat-correlated-failures -->

The formula assumes **independent failures**. Real ones are often correlated:

- Copies share logic: Facebook's DNS servers all withdrew their routes at once in 2021.
- Copies share a dependency: many AWS services failed with S3 in 2017.
- Failover itself misfires: GitHub's 43-second blip led to 24 hours of degradation.

Use the formula as an upper bound.

## What's wrong with a health check that queries every shared dependency?
<!-- /learn/availability-101#health-checks-that-test-the-right-thing -->

When that dependency hiccups, every server fails the check at once and the whole fleet is pulled from rotation. A check that only proves the process runs is too weak in the other direction. A common middle ground: check what each server owns (it accepts connections, config loaded, disk works) and report shared dependencies through monitoring.

## You run API servers in three zones. Where should the database standby go, and what else counts as a failure domain?
<!-- /learn/availability-101#redundancy-across-failure-domains -->

Put the standby in a different zone from the primary. Redundancy only helps across **failure domains**, sets of things that fail together: a rack, a data center, a region, a deploy, a config system. Treat changes as one too, rolling config and code out to one zone or a small slice of traffic first. Multiple regions add protection, but cross-region failover brings latency and divergent data.

## Crumb's search service is down. How does graceful degradation keep the site useful?
<!-- /learn/availability-101#graceful-degradation -->

Do part of the job instead of failing it: show popular recipes with a note that search will be back soon. Likewise, load recipe pages without comments if comments are down, and go read-only if the primary database is down. Each dependency made optional drops out of the sequence multiplication. Decide what's essential and build the off switches before you need them.

## Why should you trigger failover on purpose, and how did Netflix do it?
<!-- /learn/availability-101#test-failover-on-purpose -->

A failover path you never use may not work. Netflix's **Chaos Monkey** randomly disabled production instances during business hours, with engineers standing by. Chaos Gorilla simulated losing a whole availability zone. A smaller team can fail its database over to the standby monthly, timing recovery to measure real MTTR and find broken steps.
