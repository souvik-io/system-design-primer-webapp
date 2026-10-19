# Availability

This chapter answers six questions:

- What does it mean for a service to be "available", and how do you measure it?
- What do "three nines" and "four nines" mean in minutes of downtime?
- Why does recovering quickly matter as much as failing rarely?
- How do fail-over and replication keep a service running when a server dies, and what do they cost?
- How do you work out the availability of a system built from many parts?
- Why do redundant copies sometimes all fail at once, and what can you do about it?

We'll keep using **Crumb**, the recipe site from the [Scalability](/learn/scalability) chapter. By now Crumb has several app servers behind a load balancer, a cache, and a database with a copy on a second machine. Every evening, thousands of people open a Crumb recipe while they cook. If the site goes down at 7 p.m., they are left halfway through a recipe they can no longer read.

## What availability means

**Availability** is how much of the time a service works for the people using it. The simplest way to measure it is by time:

```
Availability = uptime ÷ (uptime + downtime)
```

**Uptime** is the time the service was working, and **downtime** is the time it wasn't. The result is written as a percentage. People usually describe it by counting the nines: a service with 99.99% availability is said to have "four nines".

The [Google SRE book](https://sre.google/sre-book/embracing-risk/) starts with this time-based measure too. Then it points out a problem. Real services are rarely fully up or fully down.

Say one of Crumb's three app servers breaks, and a third of recipe pages fail to load for ten minutes. Was Crumb up during those ten minutes? Neither answer is right. The SRE book says that at Google "a time-based metric for availability is usually not meaningful because we are looking across globally distributed services."

Google measures **aggregate availability** instead. This is the fraction of requests that succeed. In the book's example, a system "that serves 2.5M requests in a day with a daily availability target of 99.99% can serve up to 250 errors and still hit its target for that given day."

For Crumb, counting requests is the better fit. A cook doesn't care whether a server process was running. They care whether the recipe page loaded.

### SLIs, SLOs and SLAs

Teams use three related terms to talk about availability. The SRE book's chapter on [service level objectives](https://sre.google/sre-book/service-level-objectives/) defines them:

- A **service level indicator (SLI)** is "a carefully defined quantitative measure of some aspect of the level of service that is provided." In plain words, it's the number you measure. For Crumb, a good SLI is the fraction of recipe page loads that succeed in under one second.
- A **service level objective (SLO)** is "a target value or range of values for a service level that is measured by an SLI." It's the goal you set for that number. For Crumb: 99.95% of recipe page loads succeed, measured over 30 days.
- A **service level agreement (SLA)** is "an explicit or implicit contract with your users that includes consequences of meeting (or missing) the SLOs they contain." It's a promise with a penalty attached.

To tell an SLO from an SLA, the book suggests asking "what happens if the SLOs aren't met?" If nothing happens, it's an SLO. If someone owes a refund or a penalty, it's an SLA. Companies usually set their internal SLOs stricter than the SLAs they sign. That way they notice trouble before it costs them money. The [monitoring chapter](/learn/observability#slis-slos-and-error-budgets) shows how to track SLOs day to day.

### A real SLA

Amazon's [Compute SLA](https://aws.amazon.com/compute/sla/), which covers EC2 virtual machines, was last updated on May 25, 2022. It makes two commitments:

| Commitment | Target | Service credit if missed |
| --- | --- | --- |
| Region-level | 99.99% monthly uptime | 10% below 99.99%, 30% below 99.0%, 100% below 95.0% |
| Instance-level | 99.5% for a single instance | 10% below 99.5%, 30% below 99.0%, 100% below 95.0% |

Two details are worth noticing.

First, the region-level promise only counts as broken when all of your running instances "deployed in two or more AZs in the same AWS region" have no external connectivity at the same time. An AZ, or availability zone, is a separate data center site within a region. So AWS offers four nines only to customers who spread their servers across zones.

Second, the remedy is a credit on your bill. The SLA calls this your "sole and exclusive" remedy unless your agreement says otherwise. An SLA tells you what the provider pays when things go wrong. It doesn't tell you how often things will go wrong.

### Availability vs durability

Storage services quote two numbers that are easy to confuse:

- **Availability** is whether you can reach your data right now.
- **Durability** is whether your data still exists.

The [Amazon S3 storage classes page](https://aws.amazon.com/s3/storage-classes/) says S3 is "designed to exceed 99.999999999% (11 nines) data durability." Its availability numbers are much lower. S3 Standard is designed for 99.99% availability, with a 99.9% SLA. S3 One Zone-IA keeps data in a single availability zone. It is designed for 99.5% availability, with a 99% SLA.

So S3 is very unlikely to lose Crumb's recipe photos. It is still allowed to make them unreachable for hours a year.

## The nines

Each extra nine cuts the allowed downtime by a factor of ten. To find the allowed downtime, multiply the unavailable fraction by the length of the period:

```
Allowed downtime = (1 − availability) × period
```

The table below uses these period lengths:

- a year of 365.25 days, which is 31,557,600 seconds,
- a month of one twelfth of that year, which is 2,629,800 seconds (about 30.44 days),
- a week of 604,800 seconds,
- a day of 86,400 seconds.

For example, three nines over a year allows 0.001 × 31,557,600 s = 31,557.6 s. That is 8 hours, 45 minutes and 57.6 seconds.

| Availability | Per year | Per month | Per week | Per day |
| --- | --- | --- | --- | --- |
| 99% (two nines) | 3d 15h 39m 36s | 7h 18m 18s | 1h 40m 48s | 14m 24s |
| 99.9% (three nines) | 8h 45m 57.6s | 43m 49.8s | 10m 4.8s | 1m 26.4s |
| 99.99% (four nines) | 52m 35.8s | 4m 23.0s | 1m 0.5s | 8.6s |
| 99.999% (five nines) | 5m 15.6s | 26.3s | 6.0s | 0.86s |

Other tables you find may differ by a fraction of a second, because they assume a different year. A 365-day year gives 52 minutes 33.6 seconds for four nines. That is why the SRE book says a 99.99% target "can be down for up to 52.56 minutes in a year." A 365.2425-day year, the average length of a calendar year, gives 52 minutes 35.7 seconds. Watch for one common error: some tables list 1 minute 5 seconds a week for four nines. The correct figure is 0.0001 × 604,800 s = 60.48 seconds.

Four nines allows 4 minutes 23 seconds of downtime a month. That's less time than it takes an on-call engineer to wake up and log in. So a four-nines service has to recover from most failures by itself, without waiting for a person.

### Why not 100%?

The SRE book's [introduction](https://sre.google/sre-book/introduction/) says "100% is the wrong reliability target for basically everything (pacemakers and anti-lock brakes being notable exceptions)." The reason it gives is that "no user can tell the difference between a system being 100% available and 99.999% available." Between the user and the service sit the user's laptop, their WiFi, their internet provider and the power grid. The book notes that "those systems collectively are far less than 99.999% available." Meanwhile, each extra nine costs more than the one before. It needs more spare machines, slower releases and more people on call.

The book turns the target into an **error budget**. In its words, "the error budget is one minus the availability target. A service that's 99.99% available is 0.01% unavailable. That permitted 0.01% unavailability is the service's error budget."

The budget is there to be spent on shipping changes, since every release carries some risk. The book says: "Ideally, we would spend all of our error budget taking risks with things we launch in order to launch them quickly." While budget remains, the team keeps releasing. When an outage uses it up, releases slow down until the service is stable again.

Here is Crumb's budget. Its SLO is 99.95%, and it serves 10 million recipe page loads a month. The budget is 0.0005 × 10,000,000 = 5,000 failed page loads. A bad deploy that breaks 2,000 page loads uses 40% of that month's budget.

## Failures and recovery: MTBF and MTTR

Two averages describe how a part of the system fails:

- **MTBF (mean time between failures)** is how long the part typically runs before it breaks.
- **MTTR (mean time to repair, or to recover)** is how long it takes to get it working again.

Together they give a good estimate of availability:

```
Availability ≈ MTBF ÷ (MTBF + MTTR)
```

Say Crumb's database server fails about once every 30 days, which is 720 hours. Each time, it takes 4 hours to notice the problem, find the cause and fix it. Availability is 720 ÷ 724 ≈ 99.45%. Now compare two ways to improve it:

- **Make failures half as frequent.** MTBF becomes 1,440 hours, and availability is 1,440 ÷ 1,444 ≈ 99.72%.
- **Cut recovery to 30 minutes** with automated fail-over. MTTR becomes 0.5 hours, and availability is 720 ÷ 720.5 ≈ 99.93%.

Faster recovery wins by a wide margin. It is also usually the more achievable fix. You can't stop disks, networks or cloud zones from failing, but you do control how quickly you recover.

The SRE book makes the same point: "Reliability is a function of mean time to failure (MTTF) and mean time to repair (MTTR)." It also notes that "Humans add latency." Writing down the steps for handling a failure ahead of time, in a document called a playbook, "produces roughly a 3x improvement in MTTR" compared with working it out during the incident.

The fastest recovery of all is to have another copy already running and let it take over. The rest of this chapter is about how to do that.

## Fail-over and replication

There are two patterns for keeping a service running when one of its servers fails. They work together.

- **Fail-over** means moving the work from a failed server to a healthy one. It answers the question "who serves traffic now?"
- **Replication** means keeping copies of the data on more than one server. It makes sure the server that takes over has the data it needs.

A spare app server that holds no data only needs fail-over. A spare database server is useless unless replication has kept its data up to date. Fail-over comes in two forms, active-passive and active-active, covered next.

## Fail-over: active-passive

In **active-passive** fail-over, one server, the **active**, handles all the traffic. A second server, the **passive** or **standby**, waits in reserve. Only the active server serves requests. This setup is also called **master-slave failover**.

The two servers exchange **heartbeats**. A heartbeat is a small "I'm still alive" message sent at a regular interval, often every second. If the passive server stops receiving heartbeats, it assumes the active has failed. It then takes over the active server's IP address and starts serving requests. Clients keep sending traffic to the same address, so they don't need to know a switch happened.

One standard way to do this on a local network is VRRP, the Virtual Router Redundancy Protocol, defined in [RFC 5798](https://www.rfc-editor.org/rfc/rfc5798.txt). The active server, which VRRP calls the Master, owns a shared virtual IP address. By default it sends an advertisement every second. A backup declares the Master down after three missed intervals plus a short "skew time". With the default settings, that wait is about 3.6 seconds: 3 seconds, plus (256 − 100) × 1 s ÷ 256 ≈ 0.6 seconds. Then the backup takes over the address. [Keepalived](https://www.keepalived.org/) is an open-source Linux tool that implements VRRP.

```diagram
title: Active-passive. Only the active server serves traffic.
[c:client] Visitors @ 0,0.5
[vip] Shared IP\nor DNS name @ 1,0.5
[a] Active\nCrumb server @ 2.7,0
[p] Standby\nCrumb server @ 2.7,1.2
[db:store] Database @ 4,0.5
c -> vip
vip -> a
vip --> p : on failover
a <-> p : heartbeats
a -> db
```

### Hot, warm and cold standby

How long the switch takes depends on how ready the standby is:

| Standby | What state it's in | Typical takeover time |
| --- | --- | --- |
| **Hot** | Running, with current data | Seconds |
| **Warm** | Running, but must load recent data or fill its caches | Minutes |
| **Cold** | Switched off, or not even set up yet. It must be started, and may need restoring from a backup | Minutes to hours |

The hotter the standby, the shorter the downtime. It also costs more, because you pay for a machine that sits idle most of the time. For Crumb's database, a hot standby that receives every change through replication is worth the cost. For a rarely used admin tool, a cold standby may be enough.

### Split brain and fencing

A missed heartbeat means the standby can't hear the active server. It doesn't prove the active server is dead. Maybe only the network link between them broke. If the standby takes over anyway, two servers each believe they are the active one, and both accept writes. This is called **split brain**.

For Crumb, split brain could mean one database has a new comment and the other has a renamed recipe. Someone then has to merge the two by hand. For a payments service, it would mean two ledgers that disagree about who paid what.

The standard defence is **fencing**. The [Pacemaker documentation](https://clusterlabs.org/projects/pacemaker/doc/2.1/Pacemaker_Explained/html/fencing.html), from a widely used Linux clustering tool, defines it as "the ability to make a node unable to run resources, even when that node is unresponsive to cluster commands." In practice, the standby cuts off the old active server's power, its access to storage, or its network. Pacemaker notes that fencing is also called STONITH, short for "Shoot The Other Node In The Head". When you can't be sure the other server is dead, you make sure.

Many systems also use a **quorum** of three or more servers. A server acts as the leader only if a majority of the group agrees. A server that is cut off from the majority steps down. That's why clusters often have three servers when two could carry the load. The [consensus chapter](/learn/consensus#quorums-and-majorities) explains how majorities and [fencing tokens](/learn/consensus#leases-and-fencing-tokens) work.

## Fail-over: active-active

In **active-active** fail-over, every server handles traffic all the time. The load is spread across them. If one dies, the others take over its share. This setup is also called **master-master failover**.

The clients need a way to find all the active servers:

- **If the servers face the public internet**, DNS has to know the public IP address of each server. A DNS name can list several addresses, so different visitors are sent to different servers. When a server fails, its address must be removed from DNS. Visitors whose devices cached the old answer will keep trying the dead server for a while, as the [DNS chapter](/learn/dns-and-cdn#why-dns-failover-is-slow) explains.
- **If the servers are internal**, the application code that calls them has to know about every server. It might read a list from its configuration, or ask a service registry.

In practice, many teams put a [load balancer](/learn/load-balancing) in front of active-active servers. The clients then only need the load balancer's address, and the load balancer tracks which servers are healthy. A single load balancer would be a new single point of failure, so load balancers are run in pairs, using either form of fail-over. The load balancing chapter covers this under [running load balancers in pairs](/learn/load-balancing#running-load-balancers-in-pairs).

```diagram
title: Active-active. Every server serves, and survivors absorb a failure.
[c:client] Visitors @ 0,0.5
[lb] Load balancer @ 1,0.5
[a] Crumb server\nzone A @ 2.5,0
[b] Crumb server\nzone B @ 2.5,1
c -> lb
lb -> a
lb -> b
```

Active-active has three advantages:

- **No hardware sits idle.** Every server you pay for is doing useful work.
- **Fail-over is almost instant.** The survivors are already serving, so nothing needs to start up.
- **Broken servers are noticed at once.** A standby that never carries traffic can fail quietly, and you find out on the day you need it. An active server that breaks starts returning errors right away.

It also has two costs.

The first is **capacity**. Say Crumb's two servers each run at 70% of their capacity. If one dies, the survivor must carry 140%, so it falls over too. Plan for **N+1**: if the load needs N servers, run one more.

The second is **state**, meaning data that must stay the same on every server. Stateless app servers, which keep no data of their own, are easy to run active-active. Databases are harder. If two database servers both accept writes to the same rows, the writes can conflict. So many teams run their app servers active-active and their database active-passive.

## Disadvantages of fail-over

Both forms of fail-over have two costs.

**It adds hardware and complexity.** You pay for extra servers, and you need extra software to watch heartbeats, decide when to switch, and move traffic. That software is code like any other, and it can have bugs. As the GitHub outage [later in this chapter](#github-october-21-2018-when-failover-is-the-outage) shows, a fail-over system can cause a bigger outage than the fault it reacted to.

**Recent writes can be lost.** The active server copies each new write to the passive server, but usually a moment after it has confirmed the write to the user. If the active server fails in that moment, the passive server takes over without the latest writes. Say a Crumb user posts a comment and sees it saved. Half a second later the primary database dies before sending the comment to the standby. The standby takes over, and the comment is gone.

You can prevent this loss by making the active server wait until the standby has the write before it confirms. The cost is that every write takes longer, because it now includes a round trip to the standby. The [relational databases chapter](/learn/relational-databases#synchronous-asynchronous-and-semi-synchronous-replication) compares the options, and the [CAP chapter](/learn/cap-and-consistency) explains the wider trade-off between staying available and keeping copies in agreement.

## Replication

Fail-over moves the traffic. Replication makes sure the data is there when the traffic arrives. There are two main shapes:

- **Primary-replica replication**, also called **master-slave replication.** One server, the primary, accepts all writes and sends every change to one or more replicas. The replicas serve reads. If the primary fails, a replica can be promoted to become the new primary. This pairs naturally with active-passive fail-over.
- **Primary-primary replication**, also called **master-master replication.** Two servers both accept writes and send each other their changes. If either one fails, the other carries on with reads and writes. This pairs with active-active fail-over, but the two servers can receive conflicting writes, and something has to resolve them.

The [relational databases chapter](/learn/relational-databases#replication-copies-of-the-whole-database) covers both in detail, including how promotion works, how replicas fall behind, and how conflicts are handled.

## Availability in sequence and in parallel

A real service is made of many parts: load balancers, servers, databases, outside services. The availability of the whole depends on how the parts are connected. There are two basic arrangements.

### In sequence

Parts are **in sequence** when a request needs every one of them to work. If any one fails, the request fails. To get the overall availability, multiply the availabilities of the parts:

```
Availability (total) = Availability (Foo) × Availability (Bar)
```

Every part is below 100%, so each one you add pulls the total down. If Foo and Bar each have 99.9% availability, the total is 0.999 × 0.999 = 0.998001, about 99.8%.

Crumb's search runs through four parts in a row: the load balancer, an app server, a hosted search service and the database. If each one has 99.95% availability, the chain has 0.9995 × 0.9995 × 0.9995 × 0.9995 ≈ 99.80%. The hosted search service is run by another company, so it's a link Crumb can't make more reliable. It sets a ceiling on Crumb's search no matter how much Crumb improves its own parts.

### In parallel

Parts are **in parallel** when a request needs only one of them to work. The request fails only if every copy fails at once. So you multiply the chances of failure, and subtract the result from 1:

```
Availability (total) = 1 − (1 − Availability (Foo)) × (1 − Availability (Bar))
```

Each copy you add pushes the total up. If Foo and Bar each have 99.9% availability, each fails 0.1% of the time. Both fail together 0.001 × 0.001 = 0.000001 of the time. The total is 1 − 0.000001 = 0.999999, or 99.9999%. On paper, two three-nines servers give six nines.

### Mixing both

Real systems mix the two arrangements. In the diagram below, the two app servers are in parallel with each other. That pair is in sequence with the load balancer and the database.

```diagram
title: Sequence multiplies availability. Parallel multiplies failure.
[c:client] Visitors @ 0,0.5
[lb] Load balancer @ 1,0.5
[a] App server A @ 2,0
[b] App server B @ 2,1
[db:store] Database @ 3,0.5
c -> lb
lb -> a
lb -> b
a -> db
b -> db
```

To calculate it, combine the parallel group first, then multiply along the chain. Say the load balancer has 99.99%, each app server 99.9%, and the database 99.95%:

| Setup | Calculation | Total |
| --- | --- | --- |
| One app server | 0.9999 × 0.999 × 0.9995 | ≈ 99.84% |
| Two app servers | 0.9999 × 0.999999 × 0.9995 | ≈ 99.94% |
| Three app servers | 0.9999 × 0.999999999 × 0.9995 | ≈ 99.94% |
| Two app servers and a database standby | 0.9999 × 0.999999 × 0.99999975 | ≈ 99.99% |

The second app server helps. The third barely changes anything, because the single database now caps the result. Adding a database standby lifts the total to about 99.99%, and now the load balancer is the weakest link. The lesson is to find the part with the lowest availability that has no copy, and give it one. For most systems, that's the database.

## The big caveat: correlated failures

The parallel formula is only valid if failures are **independent**. That means one copy failing tells you nothing about whether the other will fail. Real failures are often **correlated**, meaning they tend to happen together:

- Servers in one rack share power.
- Data centers share configuration.
- Every copy receives the same bad deploy at the same moment.
- The fail-over machinery that joins the copies can fail itself.

When failures are correlated, the six nines promised by two three-nines servers can collapse to three nines, or worse. Three well-documented outages show how.

### Facebook, October 4, 2021: redundant DNS, one shared rule

Facebook runs its DNS servers in many locations, a textbook parallel setup. On October 4, 2021, all of them vanished from the internet together. Meta's post, [More details about the October 4 outage](https://engineering.fb.com/2021/10/05/networking-traffic/outage-details/), explains why.

During routine maintenance, "a command was issued with the intention to assess the availability of global backbone capacity." The command took down the backbone network that connects Facebook's data centers. An audit tool should have blocked the command, but "a bug in that audit tool prevented it from properly stopping the command."

The DNS servers had a sensible safety rule: "our DNS servers disable those BGP advertisements if they themselves can not speak to our data centers." BGP advertisements are the messages that tell the rest of the internet how to reach a server. With the backbone down, every DNS server applied that rule at the same moment and withdrew its routes. The servers were still running, but nothing on the internet could reach them.

Meta's post doesn't give a duration. Cloudflare, watching from outside, [reported](https://blog.cloudflare.com/october-2021-facebook-outage/) that facebook.com stopped resolving on its 1.1.1.1 resolver at around 15:50 UTC and came back at 21:20 UTC. That's about five and a half hours.

Recovery was slow because the outage had also cut off remote access and broken internal tools. Engineers had to go to the data centers in person. Meta says those buildings are "hard to get into, and once you're inside, the hardware and routers are designed to be difficult to modify even when you have physical access to them."

Two lessons follow. Copies that follow identical logic fail identically. And recovery tools that depend on the broken system fail along with it. The [DNS chapter](/learn/dns-and-cdn) explains the layer at the center of this outage.

### AWS S3, February 28, 2017: one mistyped input

AWS's [summary of the Amazon S3 disruption](https://aws.amazon.com/message/41926/) in its US-EAST-1 region is a short read.

At 9:37 AM PST, an S3 engineer followed an established playbook and ran a command to remove a few servers from a billing subsystem. "One of the inputs to the command was entered incorrectly and a larger set of servers was removed than intended." Those servers supported two other S3 subsystems. The index subsystem tracks the metadata and location of every stored object. The placement subsystem chooses where to store new objects. Both needed a full restart, which AWS had "not completely restarted ... in our larger regions for many years." The index subsystem was fully recovered at 1:18 PM PST and placement at 1:54 PM. That was a little over four hours after the command.

Many other services depended on S3 in sequence. AWS lists the S3 console, new EC2 instance launches, EBS volumes that needed data from S3 snapshots, and AWS Lambda among the affected services. Even the AWS Service Health Dashboard couldn't show the problem at first, because of "a dependency the SHD administration console has on Amazon S3."

AWS's fixes are worth copying:

- The tool now removes capacity more slowly.
- A safeguard stops it from removing capacity when that would take any subsystem below its minimum.
- The dashboard's console now runs across multiple regions.

### GitHub, October 21, 2018: when failover is the outage

GitHub's [post-incident analysis](https://github.blog/news-insights/company-news/oct21-post-incident-analysis/) is the best-known case of automated fail-over doing more harm than the fault it reacted to.

At 22:52 UTC, maintenance work on failing optical equipment cut the link between GitHub's US East Coast network hub and its main East Coast data center. The connection came back after 43 seconds.

That was long enough for Orchestrator, GitHub's tool for MySQL fail-over, to start moving the primary databases to the US West Coast. A few seconds of East Coast writes had not yet been copied west. When the network came back, GitHub's application servers on the East Coast started sending their writes across the continent. They couldn't cope with "the additional latency introduced by a cross-country round trip for the majority of their database calls."

Now each coast had writes that the other lacked. Switching back would have put user data at risk. GitHub restored the East Coast databases from backup instead, and "the time required to restore multiple terabytes of backup data caused the process to take hours." The site returned to normal at 23:03 UTC on October 22, after 24 hours and 11 minutes of degraded service.

GitHub noted that its restore procedure was tested daily. Even so, it had never needed to rebuild an entire cluster from backup before. The first fix it listed was to "adjust the configuration of Orchestrator to prevent the promotion of database primaries across regional boundaries."

Two lessons follow. A fail-over decision based on a few seconds of silence can be wrong. And failing over to somewhere far away brings costs, like extra latency and mismatched data, that the formulas leave out.

## Practical patterns

### Health checks that test the right thing

A load balancer can only route around a broken server if it can tell the server is broken. So it sends each server a regular **health check**, often a request to an endpoint like `/health`, and stops sending traffic to servers that fail it.

Getting the check right is harder than it sounds:

- **Too shallow:** a check that only proves the server process is running will pass even when the server can't reach its database.
- **Too deep:** a check that queries every shared dependency will fail on every server at once when that dependency has a brief problem. The load balancer then pulls the whole fleet out of service.

A common middle ground is to check what each server owns: it accepts connections, its configuration loaded, and its disk works. Problems with shared dependencies are reported through monitoring instead. The [load balancing chapter](/learn/load-balancing#health-checks) covers the routing side.

### Redundancy across failure domains

A **failure domain** is a set of things that fail together. Examples are a rack, a data center, a region, a deploy, and a configuration system. Redundancy only helps if the copies sit in different failure domains.

AWS describes availability zones as "multiple, isolated locations within each Region." Its [EC2 documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html) says "by launching EC2 instances in multiple Availability Zones, you can protect your applications from the failure of a single location in the Region."

For Crumb, a sensible setup is app servers in three zones, and the database standby in a different zone from the primary. Running in several regions also protects against a regional failure like the S3 outage in 2017. As GitHub found, though, fail-over between regions brings extra latency and mismatched data.

Treat changes as a failure domain too. Roll out new configuration and code to one zone, or to a small slice of traffic, before sending it everywhere.

### Graceful degradation

When a dependency fails, a service can often still do part of its job. This is called **graceful degradation**. Some examples for Crumb:

- If the hosted search service is down, the search page shows popular recipes and a note that search will be back soon.
- If the comments service is down, recipe pages load without comments.
- If the primary database is down, Crumb stays up in read-only mode. People can read recipes but can't post until a replica is promoted.

A payments service can do the same. If its fraud-scoring service is down, it could approve small charges from returning customers with simpler rules and hold the rest.

Each dependency you make optional drops out of the sequence calculation, so it can no longer take the whole service down. Decide which features are essential, and build the switches to turn the others off before you need them. The [timeouts and retries chapter](/learn/reliability-patterns#graceful-degradation) covers the related patterns of circuit breakers and load shedding.

### Test failover on purpose

A fail-over path you never use may not work when you need it. Netflix's [July 2011 post on the Simian Army](https://web.archive.org/web/2011id_/http://techblog.netflix.com/2011/07/netflix-simian-army.html) described Chaos Monkey as "a tool that randomly disables our production instances to make sure we can survive this common type of failure without any customer impact." Netflix ran it "in the middle of a business day, in a carefully monitored environment with engineers standing by to address any problems." The same post introduced Chaos Gorilla, which "simulates an outage of an entire Amazon availability zone." Chaos Monkey is now [open source](https://github.com/Netflix/chaosmonkey).

Crumb doesn't need Netflix's scale to use the idea. Once a month, during a quiet hour, it can fail its database over to the standby and time how long recovery takes. Each drill measures the real MTTR and finds broken steps before an outage does.

## Putting it together

| Problem | Pattern | Covered in |
| --- | --- | --- |
| Unclear what "up" means | A request-based SLI, an SLO and an error budget | [What availability means](#what-availability-means) |
| Outages last hours | Automate recovery to cut MTTR | [MTBF and MTTR](#failures-and-recovery-mtbf-and-mttr) |
| The database is a single point of failure | Replication plus a hot standby with fencing | [Active-passive](#fail-over-active-passive) |
| App servers are a single point of failure | Several servers behind a load balancer, N+1 | [Active-active](#fail-over-active-active) |
| Fail-over might lose recent writes | Wait for the standby to confirm important writes | [Disadvantages of fail-over](#disadvantages-of-fail-over) |
| A long chain of dependencies | Remove links, or make them optional | [Sequence and parallel](#availability-in-sequence-and-in-parallel) |
| Copies that fail together | Spread across zones, roll out gradually, test fail-over | [Practical patterns](#practical-patterns) |

Use the formulas to compare designs, not to predict uptime. The parallel number is an upper limit. It holds only as far as your copies really fail independently.

## Check yourself

<details>
<summary>Crumb's dashboard says its servers were up all of last month, but users complain that recipe pages failed to load. How can both be true, and what should Crumb measure instead?</summary>

Time-based availability only asks whether servers were running. A running server can still time out on its database or return errors. Crumb should measure the fraction of real page loads that succeeded, fast enough. It should measure this as close to the user as practical, for example at the load balancer.

</details>

<details>
<summary>Using a 365.25-day year, how much downtime does 99.95% allow per year and per month? Show the math.</summary>

The allowed unavailability is 1 − 0.9995 = 0.0005. Per year: 0.0005 × 31,557,600 s = 15,778.8 s, about 4 hours 23 minutes. Per month (2,629,800 s): 0.0005 × 2,629,800 = 1,314.9 s, about 21 minutes 55 seconds.

</details>

<details>
<summary>A server fails every 30 days on average and takes 4 hours to fix. Would you rather halve how often it fails, or cut repair time to 30 minutes?</summary>

Today: 720 ÷ 724 ≈ 99.45%. Halving the failure rate: 1,440 ÷ 1,444 ≈ 99.72%. Cutting repair to 30 minutes: 720 ÷ 720.5 ≈ 99.93%. Faster recovery wins, and it's usually easier to achieve, for example with automated fail-over to a hot standby.

</details>

<details>
<summary>What's the difference between active-passive and active-active fail-over, and what other names do they go by?</summary>

In active-passive (master-slave) fail-over, only the active server handles traffic. The passive server watches the active's heartbeats and takes over its IP address if they stop. In active-active (master-master) fail-over, every server handles traffic and the load is spread across them. If one fails, the others absorb its share.

</details>

<details>
<summary>Two active-passive setups are identical except that one standby is hot and the other is cold. Why does one have much longer outages?</summary>

A hot standby is already running with current data, so it can take over in seconds. A cold standby has to be started, and may need to be set up and restored from a backup first. That can take minutes to hours, and the service is down the whole time. The hot standby costs more, because you pay for a running machine that mostly sits idle.

</details>

<details>
<summary>An active-passive standby stops hearing heartbeats and promotes itself. What can go wrong, and how do real systems prevent it?</summary>

The active server may still be alive, with only the link between them broken. Then both servers accept writes and their data drifts apart. This is split brain. Fencing (STONITH) prevents it: before taking over, the standby cuts the old server's power or storage access. A quorum of three or more servers helps too, since a server cut off from the majority steps down.

</details>

<details>
<summary>Crumb's primary database fails, and the standby takes over within seconds. A user says the comment they posted just before the failure has vanished. What happened, and how could Crumb prevent it?</summary>

The primary confirmed the comment to the user, then crashed before copying it to the standby. With asynchronous replication, this window always exists. Crumb can close it by having the primary wait until the standby has received each write before confirming it. That makes every write slower by at least one round trip between the two servers.

</details>

<details>
<summary>Crumb runs two app servers in active-active behind public DNS, with no load balancer. What does DNS need to know, and what happens to some visitors when one server dies?</summary>

DNS needs to list the public IP address of both servers. When one dies, its address must be removed. Visitors whose devices or resolvers cached the old answer will keep trying the dead server until the cache expires. A load balancer in front avoids this, because clients only need its one address and it tracks which servers are healthy.

</details>

<details>
<summary>A load balancer at 99.99%, two app servers at 99.9% each in parallel, and a database at 99.95%. What's the overall availability, and what should you improve first?</summary>

Combine the parallel pair first: 1 − (0.001 × 0.001) = 0.999999. Then multiply along the chain: 0.9999 × 0.999999 × 0.9995 ≈ 99.94%. The single database is the weakest part with no copy, so give it a standby first. A third app server would barely change the total.

</details>

<details>
<summary>Two servers at 99.9% each run in parallel, and the formula says 99.9999%. Give three reasons the real number could be far lower.</summary>

The formula assumes failures are independent. Copies can share logic and react the same way to one event, as Facebook's DNS servers all withdrew their routes together. They can share a dependency in sequence, as many AWS services did on S3 in US-EAST-1. And the fail-over mechanism itself can misfire, as GitHub's cross-region fail-over after a 43-second network break led to over 24 hours of degraded service. Shared racks, power, zones, deploys and configuration are other common links.

</details>

## Further reading

The sources this chapter draws on:

- [Site Reliability Engineering: Introduction](https://sre.google/sre-book/introduction/): the case against 100%, error budgets, and MTTR.
- [Site Reliability Engineering: Embracing Risk](https://sre.google/sre-book/embracing-risk/): time-based vs aggregate availability.
- [Site Reliability Engineering: Service Level Objectives](https://sre.google/sre-book/service-level-objectives/): SLIs, SLOs and SLAs, and how to choose them.
- [Amazon Compute Service Level Agreement](https://aws.amazon.com/compute/sla/) and [Amazon S3 storage classes](https://aws.amazon.com/s3/storage-classes/): a real SLA, and durability next to availability.
- [RFC 5798: Virtual Router Redundancy Protocol](https://www.rfc-editor.org/rfc/rfc5798.txt): the standard behind many active-passive IP takeovers, with its heartbeat timers spelled out.
- [Pacemaker Explained: Fencing](https://clusterlabs.org/projects/pacemaker/doc/2.1/Pacemaker_Explained/html/fencing.html): fencing and split brain in a real clustering tool.
- [AWS Regions and Zones](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html): how AWS's failure domains are laid out.

The outages and practices:

- [More details about the October 4 outage](https://engineering.fb.com/2021/10/05/networking-traffic/outage-details/): Meta on how one command took its DNS offline, with [Cloudflare's outside view](https://blog.cloudflare.com/october-2021-facebook-outage/) of the timings.
- [Summary of the Amazon S3 service disruption](https://aws.amazon.com/message/41926/): AWS on the February 2017 US-EAST-1 outage.
- [October 21 post-incident analysis](https://github.blog/news-insights/company-news/oct21-post-incident-analysis/): GitHub on a 43-second network break and a 24-hour recovery.
- [The Netflix Simian Army](https://web.archive.org/web/2011id_/http://techblog.netflix.com/2011/07/netflix-simian-army.html): Netflix's 2011 post introducing Chaos Monkey (archived copy).
