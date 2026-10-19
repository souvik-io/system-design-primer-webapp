# Real-world architectures

The rest of this handbook teaches ideas one at a time: caching, replication, sharding, queues, consensus. Real systems use many of them at once, and the interesting part is how they fit together and what each team gave up to get what it needed. Reading how real systems were built is the best follow-up to the handbook, for three reasons:

- **You see the trade-offs being made for real.** A chapter can tell you that a store can favor availability over consistency. A paper shows you a team that did it, why, and what broke afterwards.
- **You collect patterns.** After a few papers you notice the same small set of techniques again and again: a ring of hashed keys, a single master that holds metadata, a log that everything writes to, a cache in front of the database.
- **Interview questions often come from the same domain.** If you are interviewing at a company, its engineering blog shows the problems its engineers care about and the words they use for them.

This chapter is a reading list with notes. It has three parts: the papers and talks behind well-known systems, write-ups of how particular companies built their products, and the engineering blogs where companies still publish this kind of material.

Details such as version numbers, machine counts and product names go out of date quickly, so there is no point memorizing them. Read for the shape of the design, with four questions in mind:

- What problem were they solving, and for whom?
- What constraints shaped the design: the size of the data, the read-to-write ratio, the latency target, the size of the team?
- Which trade-offs did they make, and what did they give up?
- What would they change, or what did they change later?

### A worked example: reading the Dynamo paper

Here is what that looks like on one paper. [Dynamo: Amazon's Highly Available Key-value Store](https://www.read.seas.harvard.edu/~kohler/class/cs239-w08/decandia07dynamo.pdf) was presented at SOSP in October 2007. It describes the store that some of Amazon's core services used to keep data such as shopping carts.

**The problem.** The paper opens with the shopping cart. Customers "should be able to view and add items to their shopping cart even if disks are failing, network routes are flapping, or data centers are being destroyed by tornados." At Amazon's size, the authors write, small and large components fail continuously. So the store must keep accepting writes while parts of it are broken.

**The constraints.** Many Amazon services, such as shopping carts, best seller lists, session management, sales rank and the product catalog, only need to look data up by its primary key. The paper says that storing their data in a relational database "would lead to inefficiencies and limit scale and availability," so Dynamo offers only a primary-key interface. Amazon also measured its service-level agreements at the 99.9th percentile of latency, so that the slowest 0.1% of requests counted. The paper reports that its 99.9th-percentile latencies were around 200 ms, an order of magnitude higher than the averages.

**The trade-offs.** To stay writable during failures, "Dynamo sacrifices consistency under certain failure scenarios." Two copies of the same cart can be updated separately and drift apart. Dynamo keeps both versions and lets the application merge them when it next reads the data. The design pushes "the complexity of conflict resolution to the reads in order to ensure that writes are never rejected." The cost shows up in the cart: an "add to cart" operation is never lost, "however, deleted items can resurface."

**The techniques.** The paper's Table 1 maps each problem to the technique it used. Every one of them has a section in this handbook:

| Problem | Dynamo's technique | Where the handbook covers it |
| --- | --- | --- |
| Spreading keys over machines | Consistent hashing, with virtual nodes | [Consistent hashing](/learn/consistent-hashing#virtual-nodes) |
| Staying writable when copies disagree | Vector clocks, with the conflict resolved when the data is read | [Versioning](/learn/design-key-value-store#versioning-last-writer-wins-or-vector-clocks) |
| Machines that are down for a short time | Sloppy quorum and hinted handoff | [Sloppy quorum and hinted handoff](/learn/design-key-value-store#sloppy-quorum-and-hinted-handoff) |
| Machines that are gone for good | Anti-entropy using Merkle trees | [Anti-entropy with Merkle trees](/learn/design-key-value-store#anti-entropy-with-merkle-trees) |
| Knowing which machines are alive | A gossip-based membership protocol | [Failure detection with gossip](/learn/design-key-value-store#failure-detection-with-gossip) |

The paper also shows the tuning knobs from [quorums](/learn/cap-and-consistency-101#quorums-n-r-and-w): each key is stored on N machines, a read waits for R of them and a write waits for W. "The common (N,R,W) configuration used by several instances of Dynamo is (3,2,2)." Because R + W = 4 is greater than N = 3, a read and a write that both succeed normally overlap on at least one machine.

**What you take away.** You don't need to remember any of Dynamo's numbers. The lesson is the pattern: when losing a write costs more than showing slightly stale data, accept every write and merge conflicts later. The [CAP chapter](/learn/cap-and-consistency-101#amazons-shopping-cart-stay-writable-merge-later) tells the same story from the theory side.

**What changed later.** Amazon's managed database service, DynamoDB, has a similar name but is a different system. Its own paper, [Amazon DynamoDB: A Scalable, Predictably Performant, and Fully Managed NoSQL Database Service](https://www.usenix.org/system/files/atc22-elhemali.pdf), appeared at USENIX ATC in July 2022. Reading the two papers side by side is a good exercise in how a design changes when it becomes a service that outside customers pay for.

## How to read an architecture write-up

Use this checklist on any paper, talk or blog post in this chapter.

1. **Find the problem first.** Read the abstract and the introduction, then stop and write one sentence: who needed what, and why the existing tools weren't good enough.
2. **Write down the numbers that drove the design.** Requests per second, reads versus writes, data size, latency targets, team size. These explain most of the choices.
3. **Sketch the architecture.** Draw the boxes and arrows yourself before you look at the paper's figure. Mark where the data lives and which parts can fail on their own.
4. **For each component, ask what it solves.** Then ask where it works, where it doesn't, and what would break first if traffic grew ten times.
5. **Name the trade-offs.** Look for what they gave up: consistency for availability, flexibility for speed, generality for simplicity. Most papers say this outright in one or two sentences.
6. **Look for shared patterns and technologies.** Compare it with other systems you have read about. Most designs reuse a small set of ideas, and spotting them is the real skill.
7. **Read the lessons learned.** The "experience" or "lessons" section near the end is often the most useful part, because it is where the authors say what surprised them.
8. **Check the date.** A 2008 post about a site running on a few dozen servers describes a different world from today's managed cloud services. The reasoning can still hold even when the products have changed.
9. **Skip the nitty-gritty on a first pass.** Proofs, benchmark setups and configuration details can wait until you need them.

## Systems and papers

These are the systems most often cited in system design discussions. Where the original paper is freely available, it's linked. For open source projects, the link is an introductory slide deck, with the project's own site or original paper alongside it. The one-sentence descriptions come from the paper or project page.

A worked example of the kind of diagram these write-ups contain: in a 2013 talk, [Timelines at Scale](https://www.infoq.com/presentations/Twitter-Timeline-Scalability/), Twitter's Raffi Krikorian walked through how a tweet reaches people. [High Scalability's summary](https://highscalability.com/the-architecture-twitter-uses-to-deal-with-150m-active-users/) of the talk reports 300,000 read requests a second against 6,000 writes, so Twitter did the work when a tweet was written. A "fanout" step copied each new tweet's ID into every follower's home timeline, kept in a Redis cluster with up to 800 entries per timeline and three copies of each. A separate path fed the tweet to an "Ingester", which indexed it in Earlybird, Twitter's search index, and a service called Blender built search results from it. The tweet also triggered push notifications.

```diagram
title: How a tweet reached readers in 2013, after Twitter's "Timelines at Scale" talk
[u:client] New tweet @ 1,0
[w] Write API @ 1,1
[ing] Ingester @ 0,2
[fan] Fanout @ 1,2
[push] Push\nnotifications @ 2,2
[eb:store] Earlybird\nsearch index @ 0,3
[redis:store] Redis\ntimeline cache @ 1,3
[bl] Blender @ 0,4
[ts] Timeline\nservice @ 1,4
[s:client] Search results @ 0,5
[h:client] Home timeline @ 1,5
u -> w
w -> ing
w -> fan
w -> push
ing -> eb
fan -> redis : tweet IDs
eb -> bl
redis -> ts
bl -> s
ts -> h
```

Fan-out on write has a weak spot: accounts with tens of millions of followers. The summary reports that a tweet could take up to five minutes to reach all 31 million of Lady Gaga's followers, against a goal of five seconds. For accounts like that, Twitter was moving to skip the fan-out and merge their tweets into each reader's timeline at read time. [Design the Twitter timeline and search](/learn/design-twitter) builds the same design step by step.

### Data processing

| System | What it is | Read | Handbook chapters |
| --- | --- | --- | --- |
| **MapReduce** (Google) | A programming model for processing large data sets: you write a map function and a reduce function, and the system runs them in parallel on thousands of machines and handles machine failures for you. | [Paper, OSDI 2004](http://static.googleusercontent.com/media/research.google.com/zh-CN/us/archive/mapreduce-osdi04.pdf) | [Batch processing](/learn/batch-processing#mapreduce-the-foundational-model) |
| **Spark** | A multi-language engine for data engineering, data science and machine learning on one machine or a cluster. It started as a research project at UC Berkeley's AMPLab in 2009 and is now an Apache project. Its core idea is keeping data in memory across steps. | [Slides: Apache Spark Architecture](https://www.slideshare.net/AGrishchenko/apache-spark-architecture) · [RDD paper, NSDI 2012](https://www.usenix.org/system/files/conference/nsdi12/nsdi12-final138.pdf) · [spark.apache.org](https://spark.apache.org/) | [Batch processing](/learn/batch-processing#apache-spark-multi-stage-jobs-and-in-memory-reuse) |
| **Storm** | A distributed realtime computation system that processes unbounded streams of data, "doing for realtime processing what Hadoop did for batch processing." It was built at BackType, which Twitter bought in July 2011, and Twitter open sourced it that September. | [Slides: Introduction to Storm](https://www.slideshare.net/previa/storm-16094009) · [storm.apache.org](https://storm.apache.org/) | [Batch processing](/learn/batch-processing#combining-batch-and-streaming-lambda-vs-kappa), [Event streaming](/learn/event-streaming) |

### Data stores

| System | What it is | Read | Handbook chapters |
| --- | --- | --- | --- |
| **Bigtable** (Google) | A distributed storage system for structured data, built to scale to petabytes across thousands of commodity servers. The paper says more than sixty Google products used it, including web indexing, Google Earth and Google Finance. | [Paper, OSDI 2006](https://www.read.seas.harvard.edu/~kohler/class/cs239-w08/chang06bigtable.pdf) | [Wide column stores](/learn/nosql-databases#wide-column-stores) |
| **HBase** | The Hadoop database: an open source store modeled after Bigtable, running on top of Hadoop and HDFS, with random, realtime reads and writes. | [Slides: Intro to HBase](https://www.slideshare.net/alexbaranau/intro-to-hbase) · [hbase.apache.org](https://hbase.apache.org/) | [Wide column stores](/learn/nosql-databases#wide-column-stores) |
| **Cassandra** | A distributed NoSQL database with a partitioned wide-column model and eventual consistency. It was first designed at Facebook, combining Dynamo's distribution and replication techniques with Bigtable's data and storage model. | [Slides: Cassandra Introduction & Features](https://www.slideshare.net/planetcassandra/cassandra-introduction-features-30103666) · [Paper, LADIS 2009](https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf) | [Wide column stores](/learn/nosql-databases#wide-column-stores), [Consistent hashing](/learn/consistent-hashing) |
| **Dynamo** (Amazon) | A highly available key-value store that gives up consistency in some failure cases so that writes are never rejected. (DynamoDB, Amazon's later managed database, is a separate system with its own 2022 paper.) | [Dynamo paper, SOSP 2007](https://www.read.seas.harvard.edu/~kohler/class/cs239-w08/decandia07dynamo.pdf) · [DynamoDB paper, USENIX ATC 2022](https://www.usenix.org/system/files/atc22-elhemali.pdf) | [Design a key-value store](/learn/design-key-value-store), [CAP and consistency](/learn/cap-and-consistency-101) |
| **MongoDB** | A document database: each record is a document of field and value pairs, similar to a JSON object, and fields can hold other documents and arrays. | [Slides: Introduction to MongoDB](https://www.slideshare.net/mdirolf/introduction-to-mongodb) · [What is MongoDB?](https://www.mongodb.com/docs/manual/introduction/) | [Document stores](/learn/nosql-databases#document-stores) |
| **Spanner** (Google) | Google's "scalable, multi-version, globally-distributed, and synchronously-replicated database," the first to support consistent distributed transactions at global scale. It relies on a time API that exposes how uncertain the clock is. | [Paper, OSDI 2012](https://static.googleusercontent.com/media/research.google.com/en//archive/spanner-osdi2012.pdf) | [CAP and consistency](/learn/cap-and-consistency-101#google-spanner-consistent-and-available-enough), [Distributed transactions](/learn/distributed-transactions) |
| **Memcached** | A free, open source, distributed in-memory key-value cache for small chunks of data, such as the results of database calls, API calls or page rendering. It speeds up web applications by taking load off the database. | [Slides: Introduction to memcached](https://www.slideshare.net/oemebamo/introduction-to-memcached) · [memcached.org](https://memcached.org/) | [Caching](/learn/cache-101#redis-vs-memcached) |
| **Redis** | An in-memory "data structure server" with native types such as strings, hashes, lists, sets and sorted sets. Unlike Memcached it can persist data to disk, either as point-in-time snapshots (RDB) or as a log of every write (AOF). | [Slides: Introduction to Redis](https://www.slideshare.net/dvirsky/introduction-to-redis) · [Redis data types](https://redis.io/docs/latest/develop/data-types/) · [Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) | [Caching](/learn/cache-101#redis-internals-and-memcached), [Key-value stores](/learn/nosql-databases#key-value-stores) |

### File systems

| System | What it is | Read | Handbook chapters |
| --- | --- | --- | --- |
| **Google File System (GFS)** | A scalable distributed file system for large, data-intensive applications, built to tolerate faults on cheap commodity hardware. A single master holds the metadata while many chunkservers hold the data. | [Paper, SOSP 2003](http://static.googleusercontent.com/media/research.google.com/zh-CN/us/archive/gfs-sosp2003.pdf) | [Batch processing](/learn/batch-processing), [Availability](/learn/availability-101) |
| **Hadoop Distributed File System (HDFS)** | The open source counterpart to GFS. A single NameNode manages the file system's namespace, and DataNodes store the blocks that files are split into. It was originally built for the Apache Nutch web search engine. | [HDFS Architecture](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HdfsDesign.html) | [Batch processing](/learn/batch-processing) |

### Coordination and other infrastructure

| System | What it is | Read | Handbook chapters |
| --- | --- | --- | --- |
| **Chubby** (Google) | A lock service for loosely coupled distributed systems. It offers coarse-grained locks and a small amount of reliable storage, through an interface much like a file system, and favors availability and reliability over speed. Paxos sits at its core. | [Paper, OSDI 2006](http://static.googleusercontent.com/media/research.google.com/en/us/archive/chubby-osdi06.pdf) | [Consensus](/learn/consensus) |
| **ZooKeeper** | A distributed, open source coordination service. It offers simple building blocks, arranged like a file system's directory tree, that applications use for synchronization, configuration, groups and naming. It came out of Yahoo. | [Slides: Introduction to Apache ZooKeeper](https://www.slideshare.net/sauravhaloi/introduction-to-apache-zookeeper) · [Paper, USENIX ATC 2010](https://www.usenix.org/legacy/event/atc10/tech/full_papers/Hunt.pdf) · [zookeeper.apache.org](https://zookeeper.apache.org/doc/current/zookeeperOver.html) | [Consensus](/learn/consensus#zookeeper-and-etcd-in-practice) |
| **Dapper** (Google) | Google's tracing system for following one request through many services. It keeps overhead low by sampling requests and by adding instrumentation to a small number of shared libraries. | [Paper, Google technical report 2010](http://static.googleusercontent.com/media/research.google.com/en//pubs/archive/36356.pdf) | [Observability](/learn/observability#distributed-tracing) |
| **Kafka** | A distributed messaging system built at LinkedIn to collect and deliver large volumes of log data with low latency. Today it describes itself as an event streaming platform. | [Slides: Introduction and Overview of Apache Kafka (TriHUG, July 2013)](https://www.slideshare.net/mumrah/kafka-talk-tri-hug) · [Paper, NetDB 2011](https://notes.stephenholiday.com/Kafka.pdf) · [kafka.apache.org](https://kafka.apache.org/) | [Event streaming](/learn/event-streaming#the-log-model), [Queues and async](/learn/queues-and-async) |

Each paper describes its system as it was when the paper was published, often more than a decade ago. The systems have changed since, and some have been replaced. Read the papers for the reasoning behind each design, which ages much more slowly than the details.

## Company architectures

These write-ups describe how particular companies built their products. Most are posts on [High Scalability](https://highscalability.com/), a blog that summarized conference talks and engineering posts for many years. Many are more than ten years old, so the year matters: read them for how the team reasoned under its constraints, and assume the specific tools have changed since. The year is the post's publication date, or the date of the talk where that's known.

| Company | Write-up | Year | Format |
| --- | --- | --- | --- |
| Amazon | [Amazon Architecture](https://highscalability.com/amazon-architecture/) | 2007 | Article |
| Cinchcast | [Producing 1,500 hours of audio every day](https://highscalability.com/cinchcast-architecture-producing-1500-hours-of-audio-every-d/) | 2012 | Article |
| DataSift | [Realtime datamining at 120,000 tweets per second](https://highscalability.com/datasift-architecture-realtime-datamining-at-120000-tweets-p/) | 2011 | Article |
| Dropbox | [How we've scaled Dropbox](https://www.youtube.com/watch?v=PE4gwstWhmc), Kevin Modzelewski at Stanford | 2012 | Video |
| ESPN | [Operating at 100,000 duh nuh nuhs per second](https://highscalability.com/espns-architecture-at-scale-operating-at-100000-duh-nuh-nuhs/) | 2013 | Article |
| Facebook | [Scaling Memcache at Facebook](https://cs.uwaterloo.ca/~brecht/courses/854-Emerging-2014/readings/key-value/fb-memcached-nsdi-2013.pdf) (NSDI) | 2013 | Paper |
| Facebook | [TAO: Facebook's distributed data store for the social graph](https://cs.uwaterloo.ca/~brecht/courses/854-Emerging-2014/readings/data-store/tao-facebook-distributed-datastore-atc-2013.pdf) (USENIX ATC) | 2013 | Paper |
| Facebook | [Finding a needle in Haystack: Facebook's photo storage](https://www.usenix.org/legacy/event/osdi10/tech/full_papers/Beaver.pdf) (OSDI) | 2010 | Paper |
| Facebook | [How Facebook Live streams to 800,000 simultaneous viewers](https://highscalability.com/how-facebook-live-streams-to-800000-simultaneous-viewers/) | 2016 | Article |
| Flickr | [Flickr Architecture](https://highscalability.com/flickr-architecture/) | 2007 | Article |
| Google | [Google Architecture](https://highscalability.com/google-architecture/) | 2008 | Article |
| Instagram | [14 million users, terabytes of photos](https://highscalability.com/instagram-architecture-14-million-users-terabytes-of-photos/) | 2011 | Article |
| Instagram | [What powers Instagram: hundreds of instances, dozens of technologies](https://instagram-engineering.tumblr.com/post/13649370142/what-powers-instagram-hundreds-of-instances) | 2011 | Article |
| Justin.tv | [Justin.tv's live video broadcasting architecture](https://highscalability.com/justintvs-live-video-broadcasting-architecture/) | 2010 | Article |
| Mailbox | [From 0 to one million users in 6 weeks](https://highscalability.com/scaling-mailbox-from-0-to-one-million-users-in-6-weeks-and-1/) | 2013 | Article |
| Netflix | [A 360 degree view of the entire Netflix stack](https://highscalability.com/a-360-degree-view-of-the-entire-netflix-stack/) | 2015 | Article |
| Netflix | [Netflix: what happens when you press play?](https://highscalability.com/netflix-what-happens-when-you-press-play/) | 2017 | Article |
| Pinterest | [From 0 to 10s of billions of page views a month](https://highscalability.com/scaling-pinterest-from-0-to-10s-of-billions-of-page-views-a/) | 2013 | Article |
| Pinterest | [18 million visitors, 10x growth, 12 employees](https://highscalability.com/pinterest-architecture-update-18-million-visitors-10x-growth/) | 2012 | Article |
| Playfish | [50 million monthly users and growing](https://highscalability.com/playfishs-social-gaming-architecture-50-million-monthly-user/) | 2010 | Article |
| PlentyOfFish | [PlentyOfFish Architecture](https://highscalability.com/plentyoffish-architecture/) | 2009 | Article |
| Salesforce | [How they handle 1.3 billion transactions a day](https://highscalability.com/salesforce-architecture-how-they-handle-13-billion-transacti/) | 2013 | Article |
| Stack Overflow | [Stack Overflow Architecture](https://highscalability.com/stack-overflow-architecture/) | 2009 | Article |
| TripAdvisor | [40M visitors, 200M dynamic page views, 30TB data](https://highscalability.com/tripadvisor-architecture-40m-visitors-200m-dynamic-page-view/) | 2011 | Article |
| Tumblr | [15 billion page views a month](https://highscalability.com/tumblr-architecture-15-billion-page-views-a-month-and-harder/) | 2012 | Article |
| Twitter | [Making Twitter 10000 percent faster](https://highscalability.com/scaling-twitter-making-twitter-10000-percent-faster/) | 2009 | Article |
| Twitter | [Storing 250 million tweets a day using MySQL](https://highscalability.com/how-twitter-stores-250-million-tweets-a-day-using-mysql/) | 2011 | Article |
| Twitter | [150M active users, 300K QPS, a 22 MB/s firehose](https://highscalability.com/the-architecture-twitter-uses-to-deal-with-150m-active-users/) | 2013 | Article |
| Twitter | [Timelines at scale](https://www.infoq.com/presentations/Twitter-Timeline-Scalability/), Raffi Krikorian on InfoQ | 2013 | Video |
| Twitter | [Big and small data at Twitter](https://www.youtube.com/watch?v=5cKTP36HVgI), Jeremy Cole at the O'Reilly MySQL Conference | 2011 | Video |
| Twitter | [Operations at Twitter: scaling beyond 100 million users](https://www.youtube.com/watch?v=z8LU0Cj6BOU), John Adams at LISA '10 | 2010 | Video |
| Twitter | [How Twitter handles 3,000 images per second](https://highscalability.com/how-twitter-handles-3000-images-per-second/) | 2016 | Article |
| Uber | [How Uber scales their real-time market platform](https://highscalability.com/how-uber-scales-their-real-time-market-platform/) | 2015 | Article |
| Uber | [Lessons learned from scaling Uber to 2000 engineers, 1000 services, and 8000 Git repositories](https://highscalability.com/lessons-learned-from-scaling-uber-to-2000-engineers-1000-ser/) | 2016 | Article |
| WhatsApp | [The WhatsApp architecture Facebook bought for $19 billion](https://highscalability.com/the-whatsapp-architecture-facebook-bought-for-19-billion/) | 2014 | Article |
| YouTube | [YouTube Scalability](https://www.youtube.com/watch?v=w5WVu624fY8), Cuong Do at a Google Tech Talk (uploaded in 2012) | 2007 | Video |
| YouTube | [YouTube Architecture](https://highscalability.com/youtube-architecture/) | 2008 | Article |

Some pairs are worth reading together, because each one shows a design changing as the company grew:

- **Facebook's three papers** cover one company's storage at three layers. Memcache is a [cache](/learn/cache-101) in front of MySQL. TAO is a graph store that replaced memcache for many kinds of data (compare it with [Design the data structures for a social network](/learn/design-social-graph)). Haystack is a photo store that keeps each photo's metadata in memory, so that reading a photo costs fewer disk operations.
- **The two Pinterest posts**, from 2012 and 2013, cover the same team a year apart.
- **The seven Twitter entries** run from 2009 to 2016 and follow one company as it grew. Read them with [Design the Twitter timeline and search](/learn/design-twitter).

## Company engineering blogs

If you are interviewing at a company, read a few recent posts from its engineering blog. The questions you get may come from the same domain, and the posts show which problems the company's engineers actually work on.

Many of these blogs have moved since they were first started, and a few have closed. The links below are the current addresses, checked in October 2026. Where a blog has closed, the link is to an archived copy on the Internet Archive's Wayback Machine.

| Company | Blog | Notes |
| --- | --- | --- |
| Airbnb | [The Airbnb Tech Blog](https://medium.com/airbnb-engineering) | Moved to Medium from its old address, nerds.airbnb.com. |
| Atlassian | [How we build](https://www.atlassian.com/blog/how-we-build) | The old developer blog now redirects to the general "Inside Atlassian" blog. [Archived copy of the developer blog (2019)](https://web.archive.org/web/20190212050450/https://developer.atlassian.com/blog/). |
| Amazon Web Services | [AWS News Blog](https://aws.amazon.com/blogs/aws/) | Product launches and how AWS services work. |
| Bitly | [word: the Bitly engineering blog](https://word.bitly.com/) | Still online, but the last post is from November 2017. |
| Box | [Box Blog: Engineering](https://blog.box.com/category/engineering) | |
| Cloudera | [Cloudera Blog](https://www.cloudera.com/blog.html) | The old developer blog address redirects here. |
| Dropbox | [Dropbox Tech Blog](https://dropbox.tech/) | Moved from tech.dropbox.com. |
| eBay | [eBay Innovation stories](https://innovation.ebayinc.com/stories/) | The old eBay Tech Blog address redirects here. |
| Etsy | [Code as Craft](https://www.etsy.com/codeascraft) | Moved from codeascraft.com. |
| Evernote | [Evernote Tech Blog (archived, 2017)](https://web.archive.org/web/20171220135146/http://blog.evernote.com/tech/) | Closed. The address now redirects to Evernote's product blog. |
| Facebook (Meta) | [Engineering at Meta](https://engineering.fb.com/) | Replaces the old Facebook Engineering page. |
| Flickr | [code.flickr.net](https://code.flickr.net/) | Still online. The latest post is from February 2022. |
| Foursquare | [Engineering posts on Foursquare's Medium](https://medium.com/foursquare-direct/tagged/engineering) | engineering.foursquare.com now redirects to Foursquare's marketing pages. The latest engineering post is from October 2022. |
| GitHub | [The GitHub Blog: Engineering](https://github.blog/engineering/) | |
| Google | [Google Research Blog](https://research.google/blog/) | Moved from googleresearch.blogspot.com. |
| Groupon | [Groupon Product and Engineering](https://medium.com/groupon-eng) | The latest post is from June 2023. |
| Heroku | [Heroku Blog: Engineering](https://www.heroku.com/blog/category/engineering/) | |
| High Scalability | [High Scalability](https://highscalability.com/) | Not a company blog: summaries of how many companies built their systems, including most of the write-ups above. |
| HubSpot | [HubSpot Product Team Blog: Engineering](https://product.hubspot.com/blog/topic/engineering) | |
| Instagram | [Instagram on Engineering at Meta](https://engineering.fb.com/tag/instagram/) | Instagram moved its blog here in 2022. The [original Tumblr blog](https://instagram-engineering.tumblr.com/) is still online, with posts up to 2015. |
| Intel | [Intel Software Blogs (archived, 2015)](https://web.archive.org/web/20150317224725/https://software.intel.com/en-us/blogs) | Closed. The old address no longer loads. |
| Jane Street | [Jane Street Tech Blog](https://blog.janestreet.com/) | Much of it is about OCaml, the language Jane Street uses. |
| LinkedIn | [LinkedIn Engineering Blog](https://www.linkedin.com/blog/engineering) | |
| Microsoft | [Engineering@Microsoft](https://devblogs.microsoft.com/engineering-at-microsoft/) | The old engineering.microsoft.com site closed and now redirects to Azure DevOps documentation. [Archived copy (2018)](https://web.archive.org/web/20181231043528/http://engineering.microsoft.com/). |
| Microsoft | [Microsoft for Python Developers Blog](https://devblogs.microsoft.com/python/) | Formerly "Python Engineering at Microsoft" on MSDN. |
| Netflix | [Netflix TechBlog](https://netflixtechblog.com/) | Moved from techblog.netflix.com. |
| PayPal | [PayPal Developer Community Blog](https://developer.paypal.com/community/blog/) | PayPal's Medium blog now points here too. |
| Pinterest | [Pinterest Engineering Blog](https://medium.com/pinterest-engineering) | |
| Quora | [Quora Engineering](https://www.quora.com/q/quoraengineering) | The address loads behind a browser check, so it couldn't be checked automatically. |
| Reddit | [Reddit Inc blog](https://redditinc.com/news) and [r/RedditEng](https://www.reddit.com/r/RedditEng/) | redditblog.com redirects to the company blog. Engineering posts go to the r/RedditEng community. |
| Salesforce | [Salesforce Engineering Blog](https://engineering.salesforce.com/) | |
| Slack | [Engineering at Slack](https://slack.engineering/) | |
| Spotify | [Spotify Engineering](https://engineering.atspotify.com/) | The old address, labs.spotify.com, now hosts Spotify's experimental products instead of the blog. |
| Stripe | [Stripe Dev Blog: Engineering](https://stripe.dev/blog/topic/engineering) | stripe.com/blog/engineering redirects here. |
| Twilio | [Twilio Blog](https://www.twilio.com/en-us/blog) | The old engineering address redirects to the main blog. |
| Twitter (X) | [X Engineering](https://blog.x.com/engineering/en_us) | Moved from blog.twitter.com. The page blocks automated checks, so here is an [archived copy from September 2026](https://web.archive.org/web/20260921025440/https://blog.x.com/engineering/en_us). |
| Uber | [Uber Blog: Engineering](https://www.uber.com/us/en/blog/engineering/) | Moved from eng.uber.com. |
| Yahoo | [Yahoo Engineering](https://yahooeng.tumblr.com/) | Still online, but the last post is from March 2019. |
| Yelp | [Yelp Engineering and Product Blog](https://engineeringblog.yelp.com/) | |
| Zynga | [Zynga Engineering Blog](https://www.zynga.com/blogs/engineering) | Posts are infrequent. |

For many more, the community-maintained [engineering-blogs list on GitHub](https://github.com/kilimchoi/engineering-blogs) collects hundreds of company and personal engineering blogs. If you know a company blog that's missing, add it there.

## Further reading

- [The Tail at Scale](https://www.barroso.org/publications/TheTailAtScale.pdf): Dean and Barroso on why large systems care about their slowest requests, the same concern that made Amazon measure Dynamo at the 99.9th percentile. [Performance and latency](/learn/performance-and-latency-101#the-tail-at-scale) walks through it.
- [kilimchoi/engineering-blogs](https://github.com/kilimchoi/engineering-blogs): the largest maintained list of engineering blogs.
- [High Scalability](https://highscalability.com/): the archive behind most of the company write-ups in this chapter, searchable by company name.
- [Design a key-value store](/learn/design-key-value-store), [Design the Twitter timeline and search](/learn/design-twitter) and [Design the data structures for a social network](/learn/design-social-graph): the handbook designs that lean most on the papers above.
