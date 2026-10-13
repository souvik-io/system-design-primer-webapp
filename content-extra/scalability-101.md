# Scalability 101

The primer starts beginners off with two classics: David Malan's [Scalability lecture](https://www.youtube.com/watch?v=-W9F__D3oY4) from Harvard's CS75 (summer 2012), and Sebastian Kreutzberger's four-part blog series [Scalability for Dummies](https://web.archive.org/web/20221030091841/http://www.lecloud.net/tagged/scalability/chrono) (2011). Both still hold up. The lecture runs close to two hours, though, and the blog names tools and habits from more than a decade ago. This chapter covers the same ground in one sitting: vertical and horizontal scaling, clones, load balancing, caching, replication, partitioning and asynchronism. Along the way it shows real companies that hit each wall, with sources you can check. Read it instead of the originals, before them, or after them as a refresher.

To keep things concrete, we'll follow one imaginary app as it grows. Call it **Crumb**, a recipe-sharing site. It begins as a weekend project. Then a food influencer with four million followers posts a Crumb link, and the traffic arrives overnight.

Before that, one definition. A system is **scalable** if adding resources gets you a matching gain in capacity. If one server handles 1,000 requests a second and ten servers handle about 10,000, the system scales. If ten servers still handle only 1,500 because they all wait on one database, it doesn't. The primer's chapter on [performance vs scalability](/learn/performance-vs-scalability) puts it this way: a performance problem makes the system slow for one user, and a scalability problem makes it fast for one user but slow under load.

## Day one: everything on one box

Crumb launches the way most products do. One rented server runs the web app, the database and the uploaded photos.

```diagram
title: Crumb on launch day. One machine does everything.
[u:client] Users @ 0,0
[s] Server\nweb app + database\n+ photo files @ 1,0 span 2
u -> s : HTTPS
```

That's the right call at the start. Facebook began the same way: when it launched from a Harvard dorm room in February 2004, it ran on a single rented server that [cost $85 a month](https://www.thecrimson.com/article/2014/2/4/facebook-ten-years-feature-1/). Building for millions of users before you have a hundred is wasted effort, and a simple system is easier to change once you learn what users actually do.

The trouble is that one box is a single point of failure, and it has a ceiling. When the influencer's post goes out, you have two ways to raise that ceiling.

## Scaling up: a bigger machine

**Vertical scaling** (scaling up) means moving to a more powerful machine: more CPU cores, more RAM, faster disks. Your code doesn't change, and nothing new can go wrong between machines. For many workloads this goes further than people expect.

Stack Overflow is the standard example. In February 2016, Nick Craver [described their setup](https://nickcraver.com/blog/2016/02/17/stack-overflow-the-architecture-2016-edition/): about 209 million HTTP requests a day, served by 11 web servers and 4 SQL Server machines. The database servers held 384 GB and 768 GB of RAM each, enough to keep most of the data in memory. He also wrote that they were "down to needing only 1 web server", and that they had "unintentionally tested this, successfully, a few times". That's what tuning plus big hardware can do.

Vertical scaling has three limits, and the CS75 lecture covers all of them:

- **There's a ceiling.** At some point you're on the largest machine anyone sells.
- **Cost grows faster than capacity.** The top-end machine costs far more than twice as much as one with half its power.
- **It's still one machine.** When it fails or needs a reboot for patches, everything is down.

Crumb upgrades its server, which buys a few weeks. Then the next jump in traffic arrives.

## Scaling out: clones behind a load balancer

**Horizontal scaling** (scaling out) means running many ordinary machines in place of one big one. Put a load balancer in front, and each request goes to whichever server is free. If you need more capacity, add servers. If one dies, the others carry on.

```diagram
title: Scaling out. Any server can handle any request.
[u:client] Users @ 0,1
[lb] Load balancer @ 1,1
[a] App server 1 @ 2,0
[b] App server 2 @ 2,1
[c] App server 3 @ 2,2
[db:store] Database @ 3,1
u -> lb
lb -> a
lb -> b
lb -> c
a -> db
b -> db
c -> db
```

There's a catch, and it's the subject of the first part of Kreutzberger's series. Say user Steve logs in on server 2, and his next request lands on server 3. If server 2 kept his login session in its own memory, server 3 doesn't know him, and he's logged out for no reason. His uploaded photo saved to server 2's disk is a broken image on server 3.

Kreutzberger's fix, which he called the golden rule of scalability: **every server runs exactly the same code and keeps no user data on its own disk or memory**. Sessions go to a shared store such as Redis or the database. Uploads go to shared storage, which today usually means an object store like Amazon S3. The servers become identical, disposable clones, also called **stateless** servers.

The lecture also covers the other option, **sticky sessions**: the load balancer sends a user back to the same server every time, often using a cookie. It's quicker to set up, but load spreads unevenly, and when a server dies, every user stuck to it loses their session. Stateless servers are the more robust default.

The 2011 series made clones by baking a server image (an AMI, on AWS) and deploying code to every server with a tool called Capistrano. The idea hasn't changed, but the tools have. Today the image is usually a container, an autoscaling group or Kubernetes starts and stops copies based on load, and a CI pipeline handles deploys. If one of your servers can't be deleted and replaced without anyone noticing, it isn't a clone yet.

Crumb moves sessions into Redis and photos into object storage, then runs three app servers behind a load balancer. One server can now crash during dinner rush without users noticing.

## Load balancing

The load balancer is what makes a pool of clones look like one website. The lecture walks through how it evolved, and each step is still in use somewhere.

**DNS round robin.** The simplest version needs no load balancer. Your domain name returns a different server's IP address on each lookup. The problem is caching: browsers, operating systems and ISPs hold on to DNS answers, so one busy server can keep getting traffic, and a dead server keeps getting traffic until the cached records expire.

**A dedicated load balancer.** A piece of software or hardware sits in front of your servers and decides where each request goes. It runs **health checks** so it stops sending traffic to servers that fail them. Common ways to choose a server are round robin, least connections and hashing on the client's address. A **layer 4** balancer routes on IP addresses and ports. A **layer 7** balancer reads the HTTP request, so it can send `/api` to one pool and `/images` to another. The [load balancer](/learn/load-balancer) chapter covers both.

The load balancer itself can't become the new single point of failure, so production setups run a pair, one active and one on standby, or use a managed service the cloud provider keeps redundant.

**A real-world test.** When Pokémon GO launched in Australia and New Zealand in July 2016, Niantic had planned for a certain level of traffic, with a worst case of about five times that. [According to Google Cloud](https://cloud.google.com/blog/products/containers-kubernetes/bringing-pokemon-go-to-life-on-google-cloud), traffic blew past expectations within 15 minutes of launch and went on to hit **50 times** the plan, ten times the worst case. The game survived because it was built to scale out: Google added tens of thousands of CPU cores to the game's Kubernetes cluster, and the team swapped the network load balancer for Google's global HTTP(S) load balancer, which handled the traffic better. Adding capacity that fast is only possible when servers are clones.

## Caching

With clones and a load balancer, the app servers can grow without limit. The database, still a single machine, is now where load piles up. The cheapest way to relieve it is to stop asking it the same questions.

A **cache** is a fast key-value store, usually held in memory (Memcached or Redis), placed between your app and the database. The most common pattern is **cache-aside**:

1. The app looks for the data in the cache.
2. On a hit, it returns the cached copy. The database never hears about the request.
3. On a miss, it reads from the database, puts the result in the cache with an expiry time, and returns it.

Reading from memory takes well under a millisecond. A database query can take tens or hundreds of milliseconds. For a read-heavy app like Crumb, where every popular recipe is viewed thousands of times for each edit, most reads can come from the cache.

Kreutzberger's third part compares two ways to decide what to cache:

- **Cache query results**, keyed on a hash of the SQL. It's easy to add, but hard to keep correct. When one row changes, you have to find every cached query that included it.
- **Cache objects**, such as "recipe 812, fully assembled with ingredients, photos and ratings". When the recipe changes, you delete one key. He strongly preferred this, and most teams still do.

He also gave a warning that still holds: keep the cache in a shared in-memory store, not in files on each app server, or your clones stop being identical.

How far can this go? Facebook adopted memcached in 2005, and by 2013 its cache tier was [serving billions of requests per second](https://engineering.fb.com/2013/04/15/core-infra/scaling-memcache-at-facebook/). Most reads on the site never reached a database.

**What can go wrong.** A cache that the database depends on is also a risk. On 23 September 2010, Facebook was down for about two and a half hours, its worst outage in four years. An automated system checked cached configuration values, and when it found an invalid one it fetched a fresh copy from the database. Then someone saved a value to the database that the system itself treated as invalid. Every client saw the bad value and queried the database to fix it, and the database cluster got [hundreds of thousands of queries a second](https://learn.microsoft.com/en-us/archive/blogs/architectsrule/facebook-more-details-on-todays-outage). Each failed query made things worse, and the only way out was to take the whole database cluster offline, which took the site down with it. The lesson applies to any cache: plan for what happens when many requests miss at once, a problem known as a **cache stampede** or thundering herd.

The [cache](/learn/cache) chapter covers the other update strategies (write-through, write-behind, refresh-ahead) and the trade-offs of each.

## Database replication

Caching handles repeated reads. Writes, and reads the cache misses, still go to one database, and if it fails, Crumb is down. **Replication** keeps copies of the database on other machines.

The most common setup is **primary-replica** (the primer calls it master-slave). All writes go to the primary, which streams its changes to one or more replicas. Reads can go to any replica.

```diagram
title: Writes go to the primary. Reads spread across replicas.
[app] App servers @ 0,1
[p:store] Primary @ 2,1
[r1:store] Replica 1 @ 4,0
[r2:store] Replica 2 @ 4,2
app -> p : writes
app -> r1 : reads
app -> r2 : reads
p --> r1 : replicates
p --> r2 : replicates
```

That buys you two things:

- **Read capacity.** Most apps read far more than they write, so a few replicas take most of the load off the primary.
- **Failover.** If the primary dies, a replica can be promoted to take its place. This is how replication protects availability, not just performance.

Instagram used this setup early on. In late 2011, with 14 million users and three engineers, its [published architecture](https://highscalability.com/instagram-architecture-14-million-users-terabytes-of-photos/) listed 12 PostgreSQL database servers, each streaming to a replica in a different availability zone. A whole data center could fail without losing data.

**The catch: replication lag.** Replicas apply changes a moment after the primary. Usually that's milliseconds, but under heavy load it can be seconds. A Crumb user posts a comment, the page reloads, the read goes to a replica that hasn't received the comment yet, and the comment seems to be missing. They post it again, and now there are two. The usual fix is **read-your-own-writes**: for a short time after a user writes something, send that user's reads to the primary.

The lecture also covers **primary-primary** (master-master) replication, where both nodes accept writes. It helps with availability, but conflicting writes become your problem. The primer's [replication section](/learn/database#master-slave-replication) lists the drawbacks of each setup.

## Database partitioning

Replicas spread out reads, but every write still goes to a single primary, and eventually the data won't fit on one machine. The next step is **partitioning**: splitting the data so different machines own different parts of it.

- **Federation** (functional partitioning) splits by feature: users in one database, recipes in another, comments in a third.
- **Sharding** (horizontal partitioning) splits one big table by a key. Users A to M on shard 1 and N to Z on shard 2, or more commonly `hash(user_id) % N`, so data spreads evenly.

Early Facebook used a version of this that fit its product well. In a [2005 guest lecture at Harvard's CS50](https://www.youtube.com/watch?v=xFFs9UgOAlE), Mark Zuckerberg described giving each school its own MySQL database. Most activity happened between students at the same school, so most queries touched only one small database, and adding a school meant adding a machine.

That example shows the main lesson of sharding: **choose a key that keeps related data together**. Get it wrong and you get two problems:

- **Cross-shard queries.** "Show this user's friends at every school" now has to query many shards and merge the results in your code. Joins across shards are slow, or the database won't do them at all.
- **Hot spots.** If one shard holds a celebrity's account, or all of today's records, it gets most of the traffic while the others sit idle.

Moving to a sharded database later is also hard, so teams shard only when they have to.

Kreutzberger's second part offered two paths: keep MySQL and add replicas, sharding and tuning as it strains, or denormalize early and move to a NoSQL database like MongoDB. That was common advice in 2011, and it has aged unevenly. Relational databases kept improving, managed services made replicas and failover routine, and many large sites still run on sharded MySQL or PostgreSQL. The part that holds up: plan for how the data could be split, and don't build queries that need the whole dataset in one place. The [database](/learn/database) chapter covers federation, sharding, denormalization and SQL vs NoSQL in detail.

## Asynchronism

Some work is slow no matter how many servers you have: resizing a 12-megapixel photo, sending 50,000 notifications, building a weekly report. If that work happens while the user waits, the request ties up a server for seconds, and a burst of uploads can fill every worker the app has.

Kreutzberger's fourth part explains this with a bakery. If you ask for bread and they tell you to come back in two hours, that's bad service. Bakeries avoid it in two ways, and so do websites.

**Bake at night: do the work in advance.** The bakery bakes bread before opening, so there's no wait. A website can precompute work too: render popular pages to static HTML, build each user's feed ahead of time, recompute "trending recipes" every five minutes instead of on every page view. Put the results on a CDN and they serve millions of visitors without touching your servers.

**Take the order: queue the work.** A custom birthday cake can't be made in advance, so the bakery takes the order and tells you when to collect it. On a website, the app puts a job on a **queue** and replies at once ("Your photo is processing"). A pool of **workers** takes jobs off the queue and does them. The user sees a fast response, and the slow part happens in the background.

```diagram
title: The request returns at once. Workers do the slow part.
[u:client] User @ 0,0
[app] App server @ 1,0
[q:queue] Job queue @ 2,0
[w] Workers @ 3,0
[s:store] Storage @ 3,1
u -> app : upload photo
app --> q : enqueue job
q --> w
w -> s : resized photos
```

Instagram's 2011 setup used this pattern too: around 200 Python workers took tasks from a Gearman queue, including pushing each new photo into followers' feeds and sharing posts to Twitter and Facebook. Today the queue is more likely to be RabbitMQ, Amazon SQS, Redis or Kafka, but the pattern hasn't changed.

Queues also absorb spikes. If Crumb gets 10,000 uploads in a minute and its workers handle 2,000 a minute, the queue holds the backlog and the workers catch up. Nothing crashes. Users just wait a bit longer for thumbnails.

**Queues have limits too.** In November 2022, Ticketmaster ran Taylor Swift's Eras Tour presale through Verified Fan, an invite-and-queue system designed to control how many people reach checkout at once. About 1.5 million fans were invited. Bots and fans without codes [still sent 3.5 billion requests](https://www.nbcchicago.com/news/local/ticketmaster-breaks-down-what-happened-during-taylor-swift-presale-snafu/2999756/), four times Ticketmaster's previous peak. Ticketmaster had to slow and delay sales, and it later cancelled the general sale. A queue buys time, but if work keeps arriving faster than workers finish it, the queue only grows. At that point you need to turn requests away early, which the primer covers under [back pressure](/learn/asynchronism#back-pressure).

The [asynchronism](/learn/asynchronism) chapter covers [message queues](/learn/asynchronism#message-queues) and [task queues](/learn/asynchronism#task-queues) in more depth.

## Putting it together

A year later, Crumb looks like this. Every part has a job, and none is a single point of failure.

```diagram
title: Crumb after a year: stateless clones, a cache, replicas and workers.
[u:client] Users @ 0,1
[cdn] CDN\nstatic files @ 0,0
[lb] Load balancers @ 1,1
[app] App servers\n(clones) @ 2,1
[cache:store] Cache\nRedis @ 2,0
[q:queue] Job queue @ 2,2
[w] Workers @ 3,2
[p:store] Primary DB @ 3,0
[r:store] Read replicas @ 3,1
[obj:store] Object storage @ 4,2
u -> cdn
u -> lb
lb -> app
app -> cache
app -> p
app -> r
app --> q
q --> w
w -> obj
p --> r
```

Each change fixed a specific problem. When you're designing a system, start with the symptom, not the tool:

| Symptom | Likely fix | Covered in |
| --- | --- | --- |
| One server is maxed out, and you're early | Scale up to a bigger machine | [Scaling up](#scaling-up-a-bigger-machine) |
| You need more capacity, or can't afford downtime | Stateless clones behind a load balancer | [Scaling out](#scaling-out-clones-behind-a-load-balancer) |
| The database is busy answering the same reads | Cache in memory | [Caching](#caching) |
| Too many reads for one database, or it's a single point of failure | Read replicas and failover | [Replication](#database-replication) |
| Too many writes, or too much data for one machine | Federation or sharding | [Partitioning](#database-partitioning) |
| Requests are slow because of heavy work | Precompute it, or queue it for workers | [Asynchronism](#asynchronism) |

Two warnings to finish. First, every fix adds parts, and parts fail. A single server is easy to reason about, and five layers of distributed systems are not. Scale for the load you have and the growth you expect, not for the load you hope to have someday. Second, these ideas are the foundation for the rest of the primer. Next come the trade-offs behind them, starting with [performance vs scalability](/learn/performance-vs-scalability), then the building blocks one at a time.

## Check yourself

<details>
<summary>Crumb runs three app servers behind a load balancer. Users report being logged out at random. What's the likely cause, and what are two fixes?</summary>

Sessions are stored in each server's own memory, so when the load balancer sends a user to a different server, that server has no record of their session. The robust fix is to make the servers stateless: keep sessions in a shared store like Redis (or the database), so any server can handle any request. The quicker fix is sticky sessions, where the load balancer always sends a user to the same server. But that spreads load unevenly, and users on a server that dies still lose their sessions.

</details>

<details>
<summary>Stack Overflow served about 209 million requests a day from a handful of servers. Why don't more companies scale vertically like that?</summary>

Vertical scaling is simpler, and for many workloads it goes surprisingly far, especially with careful tuning and a database that fits in RAM. But it has a ceiling (the biggest machine you can buy), costs climb steeply near the top end, and a single big machine is still a single point of failure. Traffic that spikes unpredictably, like Pokémon GO's launch at 50 times the plan, needs capacity you can add in minutes, which means scaling out. Many real systems do both: a few large database servers, and many small, disposable app servers.

</details>

<details>
<summary>A user edits a recipe, the page reloads, and they still see the old version. Name two parts of a scaled system that could cause this.</summary>

**Replication lag:** the write went to the primary, but the read was served by a replica that hasn't caught up yet. Fix it by sending a user's reads to the primary for a short time after they write. **A stale cache:** the cached object wasn't deleted or updated when the recipe changed, so readers get the old copy until it expires. Fix it by deleting the object's cache key on every write. This is one reason caching whole objects is easier than caching query results.

</details>

<details>
<summary>Why did giving each school its own database work so well for early Facebook, and when would that scheme cause trouble?</summary>

Most activity stayed within one school, so the partition key matched how the data was used. Nearly every query touched only one small database, and adding a school meant adding a machine. It breaks down once many queries cross partitions. As Facebook opened to everyone, friendships crossed every school boundary, and a query like "friends at any school" would have to hit many databases and merge the results in application code. A good shard key keeps the data that's queried together on the same shard.

</details>

<details>
<summary>Crumb's photo uploads take 8 seconds because thumbnails are generated during the request. How would you fix it, and what new problem must you plan for?</summary>

Save the original photo, put a "make thumbnails" job on a queue, and respond right away with a "processing" state. Workers take jobs from the queue and generate the thumbnails in the background. The new problem is a backlog: if uploads arrive faster than workers finish them, the queue keeps growing and thumbnails arrive later and later. Watch the queue length, add workers when it grows, and decide what to do when it's too long, such as rejecting or slowing new uploads (back pressure).

</details>

## Further reading

The originals this chapter is based on:

- [Scalability lecture, CS75 (Summer 2012), Harvard](https://www.youtube.com/watch?v=-W9F__D3oY4): David Malan's lecture. Watch it for the sections on RAID, high availability and how traffic moves through switches and load balancers, which this chapter leaves out.
- [Scalability for Dummies](https://web.archive.org/web/20221030091841/http://www.lecloud.net/tagged/scalability/chrono): Sebastian Kreutzberger's 2011 series, in four short parts: [clones](https://web.archive.org/web/20220530193911/https://www.lecloud.net/post/7295452622/scalability-for-dummies-part-1-clones), [databases](https://web.archive.org/web/20220602114024/https://www.lecloud.net/post/7994751381/scalability-for-dummies-part-2-database), [caches](https://web.archive.org/web/20230126233752/https://www.lecloud.net/post/9246290032/scalability-for-dummies-part-3-cache) and [asynchronism](https://web.archive.org/web/20220926171507/https://www.lecloud.net/post/9699762917/scalability-for-dummies-part-4-asynchronism).

The real-world examples:

- [Stack Overflow: The Architecture, 2016 Edition](https://nickcraver.com/blog/2016/02/17/stack-overflow-the-architecture-2016-edition/): how far a small, tuned server fleet can go.
- [Bringing Pokémon GO to life on Google Cloud](https://cloud.google.com/blog/products/containers-kubernetes/bringing-pokemon-go-to-life-on-google-cloud): a launch at 50 times the expected traffic.
- [Scaling Memcache at Facebook](https://engineering.fb.com/2013/04/15/core-infra/scaling-memcache-at-facebook/): the NSDI 2013 paper on a cache tier serving billions of requests per second.
- [More details on today's outage](https://learn.microsoft.com/en-us/archive/blogs/architectsrule/facebook-more-details-on-todays-outage): Facebook's 2010 post-mortem, quoted in an archived Microsoft blog.
- [Instagram architecture: 14 million users](https://highscalability.com/instagram-architecture-14-million-users-terabytes-of-photos/): High Scalability's summary of Instagram's 2011 engineering post.
- [Mark Zuckerberg's CS50 guest lecture, 2005](https://www.youtube.com/watch?v=xFFs9UgOAlE): Facebook's early architecture, including the database for each school.
- [Ticketmaster on the Eras Tour presale](https://www.nbcchicago.com/news/local/ticketmaster-breaks-down-what-happened-during-taylor-swift-presale-snafu/2999756/): what happens when demand outgrows a queue.
