# Availability 101

The primer's [availability patterns](/learn/availability-patterns) section is short. It names the two ways to keep a service running when parts of it break, [fail-over](/learn/availability-patterns#fail-over) and [replication](/learn/availability-patterns#replication), gives two tables of "nines", and shows how to combine components in [sequence and in parallel](/learn/availability-patterns#availability-in-parallel-vs-in-sequence). It cites no sources. This chapter covers the same ground in more depth and adds what the summary leaves out: how availability is measured, how targets and contracts work, why recovery speed matters as much as preventing failures, and why the parallel formula is too optimistic in practice. The numbers are recomputed here, and the company stories link to the companies' own accounts.

To keep things concrete, we'll follow one imaginary service. Call it **Tillpay**, a payments API that online shops call from their checkout pages to charge a card. When Tillpay is down, its customers can't take money, so every minute of downtime has a price.

## What availability means

The primer defines availability as uptime as a percentage of total time. The [Google SRE book](https://sre.google/sre-book/embracing-risk/) starts there too, with time-based availability: uptime divided by uptime plus downtime.

That's hard to apply to a service that's rarely fully up or fully down. If one of Tillpay's three API servers breaks and a third of charges fail for ten minutes, was Tillpay up? The SRE book says that at Google "a time-based metric for availability is usually not meaningful because we are looking across globally distributed services." Google uses **aggregate availability** instead: the proportion of requests that succeed. In the book's example, a system "that serves 2.5M requests in a day with a daily availability target of 99.99% can serve up to 250 errors and still hit its target for that given day."

For Tillpay, counting requests is the better fit. A shop owner doesn't care whether a server was running. They care whether the charge went through.

### SLIs, SLOs and SLAs

The SRE book's chapter on [service level objectives](https://sre.google/sre-book/service-level-objectives/) defines three terms you'll meet everywhere:

- A **service level indicator (SLI)** is "a carefully defined quantitative measure of some aspect of the level of service that is provided." For Tillpay: the fraction of charge requests that succeed in under two seconds.
- A **service level objective (SLO)** is "a target value or range of values for a service level that is measured by an SLI." For Tillpay: 99.95% of charges succeed, measured over 30 days.
- A **service level agreement (SLA)** is "an explicit or implicit contract with your users that includes consequences of meeting (or missing) the SLOs they contain."

The book's test for telling an SLO from an SLA is to ask "what happens if the SLOs aren't met?" If nothing happens, it's an SLO. If someone owes a refund or a penalty, it's an SLA. Companies usually set internal SLOs stricter than the SLAs they sign, so they notice trouble before it costs money.

### A real SLA

The [Amazon EC2 SLA](https://aws.amazon.com/compute/sla/) (last updated May 25, 2022) has two levels:

| Commitment | Target | Service credit if missed |
| --- | --- | --- |
| Region-level | 99.99% monthly uptime | 10% below 99.99%, 30% below 99.0%, 100% below 95.0% |
| Instance-level | 99.5% for a single instance | 10% below 99.5%, 30% below 99.0%, 100% below 95.0% |

Two details stand out. The region-level promise only counts as broken when all of your running instances "deployed in two or more AZs in the same AWS region" lose external connectivity at once, so four nines is offered only to customers who spread across availability zones. And the remedy is a credit on your bill, which the SLA calls your "sole and exclusive" remedy unless your agreement says otherwise. An SLA tells you what the provider pays when things go wrong. It doesn't tell you how often they will.

### Availability vs durability

Storage services quote two numbers that are easy to confuse. **Availability** is whether you can reach your data right now. **Durability** is whether your data still exists.

The [Amazon S3 storage classes page](https://aws.amazon.com/s3/storage-classes/) says S3 is "designed to exceed 99.999999999% (11 nines) data durability." S3 Standard is designed for 99.99% availability, with a 99.9% SLA. S3 One Zone-IA, which keeps data in a single availability zone, is designed for 99.5% availability, with a 99% SLA. S3 is very unlikely to lose Tillpay's receipts, but it's allowed to make them unreachable for hours a year.

## The nines

Each extra nine cuts the allowed downtime by a factor of ten. The allowed downtime is (1 − availability) × the period. This table uses a year of 365.25 days (31,557,600 seconds), a month of one twelfth of that (2,629,800 seconds, about 30.44 days), a week of 604,800 seconds and a day of 86,400 seconds. For three nines over a year: 0.001 × 31,557,600 s = 31,557.6 s, or 8 hours, 45 minutes and 57.6 seconds.

| Availability | Per year | Per month | Per week | Per day |
| --- | --- | --- | --- | --- |
| 99% (two nines) | 3d 15h 39m 36s | 7h 18m 18s | 1h 40m 48s | 14m 24s |
| 99.9% (three nines) | 8h 45m 57.6s | 43m 49.8s | 10m 4.8s | 1m 26.4s |
| 99.99% (four nines) | 52m 35.8s | 4m 23.0s | 1m 0.5s | 8.6s |
| 99.999% (five nines) | 5m 15.6s | 26.3s | 6.0s | 0.86s |

These mostly match the primer. Its monthly figure for three nines (43m 49.7s) is a tenth of a second off, from a slightly different month length. Its weekly figure for four nines, 1m 5s, is wrong: 0.0001 × 604,800 s is 60.48 seconds. Sources also differ on the year. The SRE book says a 99.99% target "can be down for up to 52.56 minutes in a year", which assumes 365 days (0.0001 × 525,600 minutes).

Four nines allows 4 minutes 23 seconds a month. That's less time than it takes an on-call engineer to wake up and log in, so a four-nines service has to recover from most failures without waiting for a person.

### Why not 100%?

The SRE book's [introduction](https://sre.google/sre-book/introduction/) says "100% is the wrong reliability target for basically everything (pacemakers and anti-lock brakes being notable exceptions)," because "no user can tell the difference between a system being 100% available and 99.999% available." The user's laptop, WiFi, ISP and power grid sit in between, and "those systems collectively are far less than 99.999% available." Meanwhile each extra nine costs more than the last: more redundancy, slower releases, more people on call.

The book turns the target into an **error budget**: "the error budget is one minus the availability target. A service that's 99.99% available is 0.01% unavailable. That permitted 0.01% unavailability is the service's error budget." The budget is meant to be spent on shipping changes: "Ideally, we would spend all of our error budget taking risks with things we launch in order to launch them quickly." While budget remains, the team releases. When an outage uses it up, releases slow down.

If Tillpay's SLO is 99.95% and it handles 10 million charges a month, its budget is 5,000 failed charges. A bad deploy that fails 2,000 charges uses 40% of it.

## Failures and recovery: MTBF and MTTR

Two averages describe how a component fails. **MTBF** (mean time between failures) is how long it typically runs before breaking. **MTTR** (mean time to repair, or recover) is how long it takes to get it working again. Availability is approximately:

```
Availability ≈ MTBF / (MTBF + MTTR)
```

Say Tillpay's database server fails about once every 30 days (720 hours), and it takes 4 hours to notice, diagnose and fix. Availability is 720 / 724 ≈ 99.45%. Compare two improvements:

- Make failures half as frequent (MTBF 1,440 hours): 1,440 / 1,444 ≈ 99.72%.
- Cut recovery to 30 minutes with automated failover: 720 / 720.5 ≈ 99.93%.

Faster recovery wins by a wide margin, and it's often the more achievable fix. You can't stop disks, networks or cloud zones from failing, but you control how quickly you recover. The SRE book puts it this way: "Reliability is a function of mean time to failure (MTTF) and mean time to repair (MTTR)," and "Humans add latency." It adds that recording best practices ahead of time in a playbook "produces roughly a 3x improvement in MTTR" compared with improvising.

The rest of this chapter is about shrinking MTTR to seconds by keeping another copy ready to take over.

## Fail-over: active-passive

In [active-passive](/learn/availability-patterns#active-passive) fail-over, the active server handles all traffic while a standby waits. They exchange **heartbeats**, small "I'm alive" messages sent every second or so. If the standby misses several in a row, it takes over: it claims the active's IP address, or a load balancer or DNS record is pointed at it.

```diagram
title: Active-passive. Only the active node serves traffic.
[c:client] Checkouts @ 0,0.5
[vip] Shared IP\nor DNS name @ 1,0.5
[a] Active\nTillpay API @ 2.7,0
[p] Standby\nTillpay API @ 2.7,1.2
[db:store] Database @ 4,0.5
c -> vip
vip -> a
vip --> p : on failover
a <-> p : heartbeats
a -> db
```

How long the switch takes depends on how ready the standby is. A **hot** standby is running with current data and takes over in seconds. A **warm** standby is running but has to catch up, loading recent data or warming caches, which takes minutes. A **cold** standby has to be started, maybe provisioned and restored from backup, which takes minutes to hours. The hotter the standby, the more you pay for a machine that sits idle.

### Split brain and fencing

A missed heartbeat means the standby can't hear the active. It doesn't prove the active is dead. Maybe only the link between them broke. If the standby takes over then, two servers each believe they're active and both accept writes. This is **split brain**, and for a payments service it means two ledgers that disagree.

The standard defence is **fencing**. The [Pacemaker documentation](https://clusterlabs.org/projects/pacemaker/doc/2.1/Pacemaker_Explained/html/fencing.html), from a widely used Linux clustering tool, defines it as "the ability to make a node unable to run resources, even when that node is unresponsive to cluster commands": cutting its power, its storage access or its network. It notes that fencing is also called STONITH, "Shoot The Other Node In The Head". When you can't be sure the other node is dead, you make sure.

Many systems also use a **quorum** of three or more nodes. A node only acts as leader if a majority agrees, and a node cut off from the majority steps down. That's why clusters often have three nodes when two would carry the load.

The primer lists one more drawback: if the active fails before its latest writes reach the standby, those writes are lost. Waiting for each write to be copied before confirming it prevents that, at a cost in latency. That trade-off is covered in [availability vs consistency](/learn/availability-vs-consistency#cap-theorem).

## Fail-over: active-active

In [active-active](/learn/availability-patterns#active-active), every node serves traffic all the time. A load balancer or DNS spreads requests across them, and if one dies, the others take its share.

```diagram
title: Active-active. Every node serves, and survivors absorb a failure.
[c:client] Checkouts @ 0,0.5
[lb] Load balancer @ 1,0.5
[a] Tillpay API\nzone A @ 2.5,0
[b] Tillpay API\nzone B @ 2.5,1
c -> lb
lb -> a
lb -> b
```

No hardware sits idle, and failover is close to instant because the survivors are already serving. You also find out at once if a node is broken. A standby that never carries traffic can fail quietly, and you learn about it on the day you need it.

There are two costs. The first is capacity: if two nodes each run at 70% and one dies, the survivor needs 140%, and it falls over too. Plan for N+1, one more node than the load needs. The second is state. Stateless API servers are easy to run active-active. Databases are harder, because two nodes accepting writes to the same rows can conflict, as the primer explains under [master-master replication](/learn/database#master-master-replication). Many teams run app servers active-active and the database active-passive, using [master-slave replication](/learn/database#master-slave-replication).

## Sequence and parallel

**In sequence**, a request needs every part to work, so you multiply availabilities:

```
A(total) = A(foo) × A(bar)
```

Two parts at 99.9% give 0.999 × 0.999 = 0.998001, about 99.8%, as the primer says. Tillpay's charge path runs through a load balancer, an API server, the database and a card network gateway. At 99.95% each, the chain is 0.9995⁴ ≈ 99.80%, and the gateway, which Tillpay doesn't control, caps the whole thing.

**In parallel**, a request needs only one copy to work. The system fails only when every copy fails, so you multiply the failure probabilities:

```
A(total) = 1 − (1 − A(foo)) × (1 − A(bar))
```

Two parts at 99.9% give 1 − (0.001 × 0.001) = 0.999999, or 99.9999%. The primer's figure checks out: two three-nines servers appear to give six nines.

```diagram
title: Sequence multiplies availability. Parallel multiplies failure.
[c:client] Client @ 0,0.5
[lb] Load balancer @ 1,0.5
[a] API server A @ 2,0
[b] API server B @ 2,1
[db:store] Database @ 3,0.5
c -> lb
lb -> a
lb -> b
a -> db
b -> db
```

Real systems mix both. Above, the two API servers are in parallel, and that pair is in sequence with the load balancer and the database. Combine the parallel pair first, then multiply along the chain. The single database caps the result however many API servers you add, which is why it's usually the first thing to get a standby.

## The big caveat: correlated failures

Multiplying failure probabilities is only valid if failures are **independent**: one copy failing tells you nothing about the other. Real failures are often correlated. Servers in one rack share power. Data centres share config. Replicas receive the same bad deploy at the same moment. And the failover machinery that joins the copies can fail itself. When that happens, the six nines from two three-nines servers can collapse to three, or worse. Three well-documented outages show how.

### Facebook, October 4, 2021: redundant DNS, one shared rule

Facebook's DNS servers run in many locations, a textbook parallel setup. On October 4, 2021, all of them vanished from the internet together. Meta's post, [More details about the October 4 outage](https://engineering.fb.com/2021/10/05/networking-traffic/outage-details/), explains why. During routine maintenance, "a command was issued with the intention to assess the availability of global backbone capacity," and it took down the backbone that connects Facebook's data centres. An audit tool should have blocked it, but "a bug in that audit tool prevented it from properly stopping the command."

The DNS servers had a reasonable safety rule: "our DNS servers disable those BGP advertisements if they themselves can not speak to our data centers." With the backbone gone, every one of them applied that rule at once and withdrew its routes. They were still running, but nothing on the internet could reach them. Meta's post gives no duration. Cloudflare, watching from outside, [reported](https://blog.cloudflare.com/october-2021-facebook-outage/) that facebook.com stopped resolving on its 1.1.1.1 resolver at around 15:50 UTC and returned at 21:20 UTC, about five and a half hours later.

Recovery was slow because the outage had also cut off remote access and broken internal tools. Engineers had to go to the data centres, which are "hard to get into, and once you're inside, the hardware and routers are designed to be difficult to modify even when you have physical access to them." Copies that follow identical logic fail identically, and recovery tools that depend on the broken system fail with it.

### AWS S3, February 28, 2017: one mistyped input

AWS's [summary of the Amazon S3 disruption](https://aws.amazon.com/message/41926/) in its US-EAST-1 region is a short read. At 9:37 AM PST, an S3 engineer following an established playbook ran a command to remove a few servers from a billing subsystem. "One of the inputs to the command was entered incorrectly and a larger set of servers was removed than intended." Those servers supported S3's index subsystem, which tracks every object's metadata and location, and its placement subsystem, which allocates storage for new objects. Both needed a full restart, which AWS had "not completely restarted ... in our larger regions for many years." The index subsystem was fully recovered at 1:18 PM PST and placement at 1:54 PM, a little over four hours after the command.

Many things depended on S3 in sequence. AWS lists the S3 console, new EC2 instance launches, EBS volumes that needed data from S3 snapshots, and AWS Lambda among the affected services. Even the AWS Service Health Dashboard couldn't show the problem at first, because of "a dependency the SHD administration console has on Amazon S3." AWS's fixes are worth copying: the tool now removes capacity more slowly, a safeguard stops capacity being removed when that would take any subsystem below its minimum, and the dashboard's console now runs across multiple regions.

### GitHub, October 21, 2018: when failover is the outage

GitHub's [post-incident analysis](https://github.blog/news-insights/company-news/oct21-post-incident-analysis/) is the best-known case of automated failover doing more harm than the fault it reacted to. At 22:52 UTC, maintenance on failing optical equipment cut the link between GitHub's US East Coast network hub and its primary East Coast data centre. Connectivity came back in 43 seconds.

That was long enough for Orchestrator, GitHub's MySQL failover tool, to start moving database primaries to the US West Coast. Several seconds of East Coast writes hadn't been copied west. When the network returned, GitHub's East Coast application servers began writing across the continent, and they couldn't handle "the additional latency introduced by a cross-country round trip for the majority of their database calls."

With writes on both coasts that the other side lacked, failing back would have risked user data. GitHub restored the East Coast databases from backup instead, and "the time required to restore multiple terabytes of backup data caused the process to take hours." The site returned to green at 23:03 UTC on October 22, after 24 hours and 11 minutes of degraded service. GitHub noted that its restore procedure was tested daily, but it had never needed to rebuild an entire cluster from backup before. The first fix it listed was to "adjust the configuration of Orchestrator to prevent the promotion of database primaries across regional boundaries." A failover decision based on a few seconds of silence can be wrong, and failing over somewhere far away has costs the formula ignores.

## Practical patterns

### Health checks that test the right thing

A load balancer routes around a broken server only if it can tell it's broken. It sends each server a regular **health check**, often to an endpoint like `/health`, and drops servers that fail. A check that only proves the process is running will pass while the server can't reach its database. A check that queries every shared dependency will fail on all servers at once when that dependency hiccups, pulling the whole fleet out of rotation. A common middle ground is to check what each server owns (it accepts connections, its config loaded, its disk works) and report shared dependencies through monitoring. The [load balancer](/learn/load-balancer) chapter covers the routing side.

### Redundancy across failure domains

A **failure domain** is a set of things that fail together: a rack, a data centre, a region, a deploy, a config system. Redundancy only helps across them. AWS describes availability zones as "multiple, isolated locations within each Region," and its [EC2 documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html) says "by launching EC2 instances in multiple Availability Zones, you can protect your applications from the failure of a single location in the Region."

For Tillpay, a sensible setup is API servers in three zones and a database standby in a different zone from the primary. Multiple regions protect against a regional failure like S3's in 2017, but as GitHub found, cross-region failover brings latency and divergent data. Treat changes as a failure domain too: roll out config and code to one zone or a small slice of traffic first.

### Graceful degradation

When a dependency fails, a service can often still do part of its job. If Tillpay's fraud-scoring service is down, it could approve small charges from returning customers with simpler rules and hold the rest. If the receipts service is down, it can charge now and email receipts later. Each dependency made optional drops out of the sequence multiplication. Decide which features are essential, and build the off switches before you need them.

### Test failover on purpose

A failover path you never use may not work. Netflix's [July 2011 post on the Simian Army](https://web.archive.org/web/2011id_/http://techblog.netflix.com/2011/07/netflix-simian-army.html) described Chaos Monkey as "a tool that randomly disables our production instances to make sure we can survive this common type of failure without any customer impact." Netflix ran it "in the middle of a business day, in a carefully monitored environment with engineers standing by to address any problems." The same post introduced Chaos Gorilla, which "simulates an outage of an entire Amazon availability zone." Chaos Monkey is now [open source](https://github.com/Netflix/chaosmonkey).

Tillpay doesn't need Netflix's scale to borrow the idea. It can fail its database over to the standby in a quiet hour each month and time the recovery. Every drill measures real MTTR and finds broken steps before an outage does.

## Putting it together

| Problem | Pattern | Covered in |
| --- | --- | --- |
| Unclear what "up" means | A request-based SLI, an SLO and an error budget | [What availability means](#what-availability-means) |
| Outages last hours | Automate recovery to cut MTTR | [MTBF and MTTR](#failures-and-recovery-mtbf-and-mttr) |
| The database is a single point of failure | Hot standby with fencing | [Active-passive](#fail-over-active-passive) |
| App servers are a single point of failure | Several servers behind a load balancer, N+1 | [Active-active](#fail-over-active-active) |
| A long chain of dependencies | Remove links, or make them optional | [Sequence and parallel](#sequence-and-parallel) |
| Copies that fail together | Spread across zones, roll out gradually, test failover | [Practical patterns](#practical-patterns) |

Use the formulas to compare designs, not to predict uptime. The parallel number is an upper bound that holds only as far as your copies really are independent. For the building blocks behind these patterns, see [scalability 101](/learn/scalability-101), and for the DNS layer at the centre of Facebook's outage, the [domain name system](/learn/domain-name-system) chapter.

## Check yourself

<details>
<summary>Tillpay's dashboard says its servers were up all of last month, but shops complain that charges failed. How can both be true, and what should Tillpay measure instead?</summary>

Time-based availability only asks whether servers were running. A running server can still time out on its database or return errors. Tillpay should measure the fraction of real charge requests that succeeded, fast enough, measured as close to the client as practical, such as at the load balancer.

</details>

<details>
<summary>Using a 365.25-day year, how much downtime does 99.95% allow per year and per month? Show the math.</summary>

The allowed unavailability is 1 − 0.9995 = 0.0005. Per year: 0.0005 × 31,557,600 s = 15,778.8 s, about 4 hours 23 minutes. Per month (2,629,800 s): 0.0005 × 2,629,800 = 1,314.9 s, about 21 minutes 55 seconds.

</details>

<details>
<summary>A server fails every 30 days on average and takes 4 hours to fix. Would you rather halve how often it fails, or cut repair time to 30 minutes?</summary>

Today: 720 / 724 ≈ 99.45%. Halving the failure rate: 1,440 / 1,444 ≈ 99.72%. Cutting repair to 30 minutes: 720 / 720.5 ≈ 99.93%. Faster recovery wins, and it's usually more achievable, for example with automated failover to a hot standby.

</details>

<details>
<summary>An active-passive standby stops hearing heartbeats and promotes itself. What can go wrong, and how do real systems prevent it?</summary>

The active may still be alive, with only the link between them broken. Then both accept writes and their data diverges: split brain. Fencing (STONITH) prevents it: before taking over, the standby cuts the old node's power or storage access. A quorum of three or more nodes helps too, since a node cut off from the majority steps down.

</details>

<details>
<summary>Two servers at 99.9% each run in parallel, and the formula says 99.9999%. Give three reasons the real number could be far lower.</summary>

The formula assumes independent failures. Copies can share logic and react identically to one event, as Facebook's DNS servers all withdrew their routes together. They can share a dependency in sequence, as many AWS services did on S3 in US-EAST-1. And the failover mechanism itself can misfire, as GitHub's cross-region failover after a 43-second network blip led to over 24 hours of degraded service. Shared racks, power, zones, deploys and config are other common links.

</details>

## Further reading

The sources this chapter draws on:

- [Site Reliability Engineering: Introduction](https://sre.google/sre-book/introduction/): the case against 100%, error budgets, and MTTR.
- [Site Reliability Engineering: Embracing Risk](https://sre.google/sre-book/embracing-risk/): time-based vs aggregate availability.
- [Site Reliability Engineering: Service Level Objectives](https://sre.google/sre-book/service-level-objectives/): SLIs, SLOs and SLAs, and how to choose them.
- [Amazon EC2 Service Level Agreement](https://aws.amazon.com/compute/sla/) and [Amazon S3 storage classes](https://aws.amazon.com/s3/storage-classes/): a real SLA, and durability next to availability.
- [Pacemaker Explained: Fencing](https://clusterlabs.org/projects/pacemaker/doc/2.1/Pacemaker_Explained/html/fencing.html): fencing and split brain in a real clustering tool.
- [AWS Regions and Zones](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html): how AWS's failure domains are laid out.

The outages and practices:

- [More details about the October 4 outage](https://engineering.fb.com/2021/10/05/networking-traffic/outage-details/): Meta on how one command took its DNS offline, with [Cloudflare's outside view](https://blog.cloudflare.com/october-2021-facebook-outage/) of the timings.
- [Summary of the Amazon S3 service disruption](https://aws.amazon.com/message/41926/): AWS on the February 2017 US-EAST-1 outage.
- [October 21 post-incident analysis](https://github.blog/news-insights/company-news/oct21-post-incident-analysis/): GitHub on a 43-second partition and a 24-hour recovery.
- [The Netflix Simian Army](https://web.archive.org/web/2011id_/http://techblog.netflix.com/2011/07/netflix-simian-army.html): Netflix's 2011 post introducing Chaos Monkey (archived copy).
