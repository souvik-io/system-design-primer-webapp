# Design a system that scales to millions of users on AWS

Picture a website where people post short entries, about 1 KB of text each, and read each other's. On launch day it has one user: you. Three years later it has 10 million users, who write a billion entries a month and read a hundred billion. This chapter grows that site on Amazon Web Services (AWS), one stage at a time, from a single virtual machine to a design that survives the loss of a data center and adds servers on its own when traffic rises.

The question is different from the other designs in this handbook. Nobody asks you to invent a clever algorithm. The interviewer wants to see how you move a system from small to large: measure it, find the part that breaks first, fix that part, and repeat. Each fix has a price, in money and in complexity, and the skill being tested is knowing when a fix is worth paying for.

[Scalability](/learn/scalability) tells the general story of growing from one server to many, with a recipe site called Crumb: vertical and horizontal scaling, load balancing, caching, replication, partitioning and queues. Read it first if those ideas are new. This chapter assumes them and focuses on the AWS services that implement each stage, how they behave, and what each one costs. The stages follow a well-known AWS conference talk from 2015, "Scaling Up to Your First 10 Million Users," updated to today's services.

The chapter follows the four steps from [The system design interview, step by step](/learn/system-design-interview). Step 3 builds the first box. Step 4 grows it through five stages.

## Step 1: Outline use cases, constraints and assumptions

The method for this whole question is a loop:

1. **Benchmark or load test.** Send realistic traffic at the system until something gives.
2. **Profile.** Find which component gave out first, and why.
3. **Fix that bottleneck,** after weighing the alternatives and their trade-offs.
4. **Repeat.**

You don't need deep AWS knowledge to answer this question well unless the job asks for it. Almost every idea here has a non-AWS equivalent, and the chapter names the general concept next to each service.

### Use cases

- A **user** makes a read or write request.
  - The **service** processes it, stores the user's data, and returns the result.
- The **service** grows from a handful of users to millions.
  - Along the way we discuss the general scaling patterns that let an architecture handle many more users and requests.
- The **service** is highly available. It keeps working when a server, or a whole data center, fails.

### Out of scope

- Product features beyond "read" and "write." We treat the content as opaque 1 KB items.
- Running in several AWS Regions. The design stays in one Region, spread across its Availability Zones. Multi-Region comes up as a follow-up question.
- Billing, accounts and authentication.

### Assumptions

- **Traffic is uneven.** It rises during the working day and falls at night, and a few items are far more popular than the rest.
- **The data is relational.** Users, posts and the links between them fit naturally in tables.
- **The site grows from 1 user to tens of millions.** We label the stages by rough user counts.
- At full size:
  - 10 million users.
  - 1 billion writes a month.
  - 100 billion reads a month, so reads outnumber writes 100 to 1.
  - Each write adds about 1 KB of content.
  - Most writes create new content rather than editing existing content.

### Calculate usage

A 30-day month has 30 × 86,400 = 2,592,000 seconds, about 2.6 million. Rounding it to 2.5 million makes the arithmetic easy and is off by about 4%.

- **Writes:** 1,000,000,000 ÷ 2,592,000 s ≈ 386 a second. Call it **400 writes a second** on average.
- **Reads:** 100,000,000,000 ÷ 2,592,000 s ≈ 38,600 a second. Call it **40,000 reads a second** on average.
- **Peaks:** traffic is uneven, so assume the busiest hour runs at 3 times the average: about **1,200 writes** and **120,000 reads a second**.
- **New storage:** 1 KB × 1 billion writes = **1 TB a month**, which is 12 TB in the first year and **36 TB over three years**. That's raw content, before indexes and before any copies.
- **Bandwidth:** reads return about 38,600 × 1 KB ≈ 39 MB a second, or about 310 megabits a second, on average. Over a month that's 100 billion × 1 KB = **100 TB sent to users**, before images, scripts and page markup.

A conversion table worth remembering, using 2.5 million seconds a month:

| Per second | Per month |
| --- | --- |
| 1 | 2.5 million |
| 40 | 100 million |
| 400 | 1 billion |
| 40,000 | 100 billion |

**What these numbers tell us.** The system is very read-heavy, so the big wins come from serving reads without touching the main database: caches, replicas and a content delivery network (CDN). The average write rate is modest. The trouble with writes comes later, from storage growth: 36 TB of content plus indexes, copied to every replica, eventually outgrows one database server. And 100 TB a month of outbound data is a real line on the bill. The [estimation](/learn/estimation) chapter covers this kind of arithmetic in more depth.

## Step 2: Create a high-level design

The design starts as small as it can be. One virtual server runs everything, and a DNS name points at it.

```diagram
title: Launch day. One EC2 instance runs the web app and MySQL.
[u:client] Users @ 0,0
[dns] Route 53\nDNS @ 0,1
[ec2] EC2 instance\nweb app + MySQL\nElastic IP @ 2,0
[cw] CloudWatch\nmetrics @ 2,1
u -> dns : 1. look up name
u -> ec2 : 2. HTTPS
ec2 --> cw : CPU, disk, network
```

- **Amazon EC2 instance.** A virtual server running the web server, the application and MySQL, because at this size one machine is plenty and one machine is simplest.
- **Elastic IP.** A fixed public address for that server, so the DNS record survives the server being replaced.
- **Amazon Route 53.** The DNS service that maps the site's name to that address.
- **Amazon CloudWatch.** Collects the server's metrics, which tell us what to fix first when the box struggles.

Everything after this is added in response to a measured problem. Step 4 walks this road:

| Stage | Rough users | What gets added | Problem it solves |
| --- | --- | --- | --- |
| Start | 1 | One EC2 instance, Elastic IP, Route 53 | Getting online |
| 1 | 100 | S3 for files, RDS for MySQL, a VPC | One box doing every job |
| 2 | 1,000 | Load balancer, two Availability Zones, web and app tiers, CloudFront | One web server is a bottleneck and a single point of failure |
| 3 | 100,000 | ElastiCache, read replicas | The database drowning in reads |
| 4 | 500,000 | Auto Scaling, automation, deeper monitoring | Paying for peak capacity all night |
| 5 | 10 million | Archiving, sharding, federation, DynamoDB, SQS and workers | Data and writes outgrowing one database |

The user counts are rough guides. Real systems hit these walls at very different sizes, depending on how heavy each request is. Measurements decide when to move to the next stage.

## Step 3: Design core components

### Use case: User makes a read or write request

A read is a request such as `GET /api/v1/posts/8812`, answered with the post as JSON. A write is `POST /api/v1/posts` with about 1 KB of text in the body, answered with `201 Created` and the new post's id. Behind both sits a small schema:

```sql
CREATE TABLE users (
    id          BIGINT PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    created_at  TIMESTAMP NOT NULL
);

CREATE TABLE posts (
    id          BIGINT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id),
    body        VARCHAR(1024) NOT NULL,      -- the ~1 KB of content per write
    created_at  TIMESTAMP NOT NULL,
    INDEX idx_user_time (user_id, created_at)
);
```

With one or two users, the goals are simple: a single box for simplicity, a bigger box when that one fills up, and monitoring to show which resource is running out.

#### Start with a single box

Run the **web server** on one EC2 instance, and store user data on the same instance in a **MySQL** database.

When the box gets busy, use **vertical scaling**: choose a bigger box. On AWS you stop the instance, change its type, for example from `m5.large` to `m5.2xlarge`, and start it again. From then on you pay the new type's rate. Plan for a few minutes of downtime while it's stopped. Your code doesn't change.

To know when to scale up, and which way, watch the basic metrics: CPU, memory (is the database's working set still in RAM?), disk I/O (are reads and writes queueing?) and network. CloudWatch collects metrics such as CPU and network traffic for every instance, every five minutes by default, or every minute if you turn on detailed monitoring. The CloudWatch agent, installed on the instance, adds memory and disk-space metrics from inside it. On the box itself, `top` and open-source tools such as Nagios, StatsD and Graphite do the same job.

Vertical scaling has two costs, covered in the [Scalability](/learn/scalability#scaling-up-a-bigger-machine) chapter. Big instances get very expensive, and eventually there's no bigger one. Worse, one box has no redundancy and no failover: when it reboots for patches, the site is down. The alternative is **horizontal scaling**, adding more boxes, which is where Step 4 goes.

#### Start with SQL, consider NoSQL

The data is relational, so start with MySQL on the same box. It gives you joins, transactions and mature tools, and your team almost certainly knows SQL. The 2015 talk gives the same advice: start with SQL, and move to NoSQL only when you need to, such as when you expect more than 5 TB of data in the first year or have an extremely data-intensive workload. Our numbers reach 12 TB in year one, so the question returns in stage 5. [NoSQL and choosing a database](/learn/nosql-databases#sql-or-nosql-making-the-choice) covers the decision.

#### Assign a public static IP

An EC2 instance can get a public IPv4 address automatically, but AWS releases it when the instance stops and assigns a new one when it starts. A reboot keeps the address. A stop and start, which is what a resize does, loses it.

An **Elastic IP address** is a static public IPv4 address that belongs to your account until you release it. It stays the same however often the instance it's attached to is stopped, started or replaced. That helps with failover: if the server dies, you start a replacement, move the Elastic IP to it, and users follow without any DNS change.

Since February 1, 2024, AWS charges $0.005 an hour for every public IPv4 address, attached or idle, about $3.65 a month each. Accounts get a default quota of five Elastic IPs per Region, and AWS recommends using them mainly for this remap-on-failure purpose.

#### Use a DNS

Add a **DNS** record that maps the domain name to the Elastic IP. On AWS that's Route 53: a plain `A` record such as `example.com → 203.0.113.10`, with the simple routing policy. Route 53 also offers failover, weighted, latency-based and geolocation routing, which later stages can use. [DNS and CDNs](/learn/dns-and-cdn#how-dns-works) explains how a lookup works and why DNS changes take time to spread.

#### Secure the web server

Open only the ports the site needs, using a **security group**, a virtual firewall attached to the instance. Anything without an allow rule is blocked:

| Direction | Port | Source or destination | Why |
| --- | --- | --- | --- |
| Inbound | 80 (HTTP) | Anywhere | Redirect visitors to HTTPS |
| Inbound | 443 (HTTPS) | Anywhere | The site itself |
| Inbound | 22 (SSH) | Your office's IP range only | Administration |
| Outbound | none | | The server never starts connections |

Security groups are stateful: if a request is allowed in, its response is allowed out, so a server with no outbound rules still answers every visitor. A new security group starts with an outbound rule that allows everything, and you must delete it to stop the server from starting connections of its own. That limits what an attacker can do from a compromised server, such as downloading tools or sending your data elsewhere. The cost is that the server can't fetch patches either, so a common compromise is to allow outbound traffic only through a gateway you control, as stage 1 does.

Port 22 can go too. AWS Systems Manager Session Manager gives administrators a shell without any open inbound port, bastion host or SSH key. Access is granted with AWS Identity and Access Management (IAM) policies, and sessions can be logged. [Security](/learn/security) covers firewalls and least privilege in general.

## Step 4: Scale the design

Here's where the site ends up after all five stages:

```diagram
title: At 10 million users. Files come from CloudFront, everything else through the load balancer.
[u:client] Users @ 0,1
[cf] CloudFront\nCDN @ 1,0
[s3:store] S3\nstatic files @ 2,0
[alb] Load balancer\nTLS ends here @ 1,1
[web] Web tier\nAuto Scaling @ 2,1
[app] App tier\nAuto Scaling @ 3,1
[cache:store] ElastiCache @ 3,0
[db:store] MySQL shards\n+ read replicas @ 4,1
[ddb:store] DynamoDB @ 4,0
[q:queue] SQS queue @ 3,2
[w] Workers\nEC2 or Lambda @ 4,2
u -> cf
cf -> s3
u -> alb
alb -> web
web -> app
app -> cache
app -> db
app -> ddb
app --> q
q --> w
```

Before adding anything, go back to the step 1 numbers and ask what breaks first:

- **One web server** can't serve 120,000 reads a second, and if it fails the site is down. That calls for more servers behind a load balancer, in more than one data center.
- **One MySQL server** can't answer 120,000 reads a second while also taking every write. Most reads are for popular content, so a cache takes most of them, and read replicas take much of the rest.
- **Storage grows by 1 TB a month.** Amazon RDS for MySQL allows up to 64 TiB (about 70 TB) per instance. 36 TB of content plus indexes, which can easily double it, reaches that ceiling within three years. That calls for archiving and for splitting data across databases.
- **Traffic is uneven.** Servers sized for the morning peak sit idle all night. That calls for autoscaling.
- **100 TB a month leaves the system,** before images and scripts. A CDN serves the static part from closer to users.

The stages below add components in the order a growing site usually needs them. At each stage, your load tests might show that you need only one or two of the changes. In an interview, tie each component to the bottleneck it fixes and the price you pay for it.

### Stage 1: 100 users, move the database and files off the web server

```diagram
title: Stage 1. Files go to S3, MySQL moves to RDS in a private subnet.
[u:client] Users @ 0,0
[web] Web server\nEC2, public subnet @ 2,0
[rds:store] RDS for MySQL\nprivate subnet @ 4,0
[s3:store] S3 bucket\nuser files, JS,\nCSS, images @ 2,1
u -> web : HTTPS
web -> rds : SQL
web -> s3 : store uploads
u -> s3 : static files
```

**What the measurements show.** Load on the single box is rising. Profiling points at MySQL, which takes more and more memory and CPU, while user uploads fill the disk. Bigger instances have kept up so far, but they're getting expensive, and they can't scale the database and the web server separately: a database that needs memory forces you to buy CPU for the web server too.

**Goals.** Lighten the load on the box and let each part scale on its own: store static content in an **object store**, and move **MySQL** to its own server.

**What it costs.** The web server's code and configuration must change to point at the object store and the new database. Each new component needs securing. The AWS bill grows, which you should weigh against the cost of running, patching and backing up the same systems yourself.

#### Store static content separately

Amazon S3 is a managed **object store**: you put files ("objects") into a container ("bucket") and fetch them by name over HTTP. Move user uploads, JavaScript, CSS, images and videos off the web server's disk and into S3.

S3's Standard storage class keeps every object on multiple devices across at least three Availability Zones. It's designed for 99.999999999% durability and 99.99% availability over a year. Since January 5, 2023, every new object is encrypted at rest by default, at no extra cost. Reads are strongly consistent, so an object is readable the moment its upload succeeds. You pay for what you use and never size a disk again.

Buckets are private by default, with Block Public Access turned on. Letting browsers fetch files straight from S3 at this stage means making a deliberate public exception. Stage 2 removes it by putting a CDN in front.

#### Move the MySQL database to a separate box

You could run MySQL yourself on a second EC2 instance. Amazon RDS (Relational Database Service) is usually the better default. It runs MySQL for you and handles backups, software patching, failure detection and recovery, while you still own the schema and query tuning. In return:

- **It's simpler to administer and scale.** Moving to a larger instance class, such as `db.m7g.2xlarge` to `db.m7g.4xlarge`, is a setting change.
- **It can span Availability Zones.** A Multi-AZ deployment keeps a synchronous standby in a second zone. Stage 2 turns it on.
- **It encrypts data at rest.** RDS encrypts storage, logs, backups, snapshots and replicas with AES-256, using a key from AWS Key Management Service (KMS). You must choose encryption when you create the instance. Encrypting an existing one means restoring from an encrypted copy of a snapshot.

#### Secure the system

Encrypt data in transit (HTTPS from users, TLS from the web server to MySQL) and at rest (S3 and RDS encryption). [Security](/learn/security#encrypt-data-in-transit-and-at-rest) explains both.

Then put everything inside a **Virtual Private Cloud (VPC)**, a private network for your account, divided into **subnets**. Each subnet lives in one Availability Zone.

- A **public subnet** has a route to an internet gateway. The web server lives here, so it can send and receive internet traffic.
- A **private subnet** has no such route. Everything else lives here, starting with the database, so nothing on the internet can reach it directly.
- **Security groups** open each component's ports only to the sources that need them. The database allows port 3306 from the web server's security group and nothing else. Naming a security group as the source keeps the rule correct as servers come and go.

Apply the same pattern to every component that later stages add.

Servers in private subnets still need outbound access sometimes, for patches. A **NAT gateway** lets them start connections out while blocking any connection started from outside. It costs about $0.045 an hour (roughly $33 a month) plus $0.045 per gigabyte processed, in US East at the time of writing, and AWS suggests one per Availability Zone to avoid cross-zone traffic. Traffic to S3 or DynamoDB can skip it: a gateway endpoint for those services has no extra charge.

### Stage 2: 1,000 users, add a load balancer and a second Availability Zone

```diagram
title: Stage 2. Two tiers behind load balancers, in two Availability Zones.
[u:client] Users @ 0,1
[cf] CloudFront @ 1,0
[s3:store] S3 @ 3,0
[alb] Public ALB\nTLS ends here @ 1,1
[web] Web servers\nAZ a + AZ b @ 2,1
[ilb] Internal ALB @ 3,1
[app] App servers\nAZ a + AZ b @ 4,1
[db:store] RDS primary\nAZ a @ 4,2
[sb:store] RDS standby\nAZ b @ 2,2
u -> cf
cf -> s3
u -> alb
alb -> web
web -> ilb
ilb -> app
app -> db
db -> sb : synchronous copy
```

**What the measurements show.** The single web server is now the bottleneck at peak hours. Responses slow down, and at the worst moments the site goes down. The business also wants the site to survive a server failure, which it can't while there's one of everything.

**Goals.** Use **horizontal scaling** to handle the load and remove single points of failure: a load balancer, several web servers, two Availability Zones, separate web and application tiers, and a CDN.

#### Add a load balancer and more web servers

A **load balancer** receives every request and passes it to one of several servers. On AWS that's **Elastic Load Balancing**, and for HTTP you'd pick an **Application Load Balancer (ALB)**. If you run your own, such as HAProxy on EC2, you need at least two in an active-passive or active-active pair across zones, or the load balancer becomes the new single point of failure. [Load balancers](/learn/load-balancing#running-load-balancers-in-pairs) explains both setups.

A managed ALB is highly available by design. It runs a node in each Availability Zone you enable, and it requires at least two. It health-checks every server and stops routing to failed ones. It scales itself as traffic grows by changing its IP addresses, published in DNS with a 60-second time to live (TTL). So you point `example.com` at it with a Route 53 **alias record**, which follows those changes automatically, works at the bare domain where a `CNAME` can't, and is free to query.

**Terminate TLS on the load balancer.** Its HTTPS listener holds the certificate, which can come from AWS Certificate Manager (ACM), and decrypts requests before passing them on. The servers stop spending CPU on encryption, and certificates live in one place. [TLS termination](/learn/load-balancing#tls-termination) covers when to re-encrypt behind it.

The web servers can now move to private subnets, since the load balancer reaches them on private addresses, which also saves $0.005 an hour per public IP. The ALB itself costs $0.0225 an hour in US East, about $16 a month, plus $0.008 per Load Balancer Capacity Unit (LCU) hour. An LCU measures new connections, active connections, bytes processed and rule evaluations, and you're billed on whichever you use most.

#### Spread servers and the database across Availability Zones

An **Availability Zone (AZ)** is one or more data centers with separate power and networking. A Region's zones are many kilometers apart, all within 100 km of each other, so two servers in two zones rarely fail together.

- **Web servers:** run at least one in each of two zones. ALBs always balance across zones, so every healthy server gets an even share.
- **MySQL:** turn on **RDS Multi-AZ**, the managed form of primary-standby failover. RDS keeps a standby in another zone and replicates every write to it synchronously. If the primary fails, its zone has trouble, or it needs offline patching, RDS fails over to the standby, typically in 60 to 120 seconds. It does so by pointing the database's DNS name at the standby, so applications must reconnect and must not cache the old address. AWS recommends a JVM DNS cache of 60 seconds or less for this reason.

The standby can't serve reads. Synchronous replication adds some latency to every commit. And you pay for the standby as a full instance, so Multi-AZ roughly doubles the database bill. [Availability](/learn/availability#fail-over-active-passive) covers the pattern and its pitfalls.

#### Separate the web servers from the application servers

So far each server both handles HTTP and runs business logic. Split them:

- **Web servers** run as a [reverse proxy](/learn/reverse-proxy-and-api-gateway#separating-the-web-and-application-layers): they hold connections and pass the work along.
- **Application servers** run the logic and talk to the database.

Now each tier is sized and configured on its own, and you can add application servers without adding web servers. You can split the application tier further, for example servers for the **read APIs** and others for the **write APIs**, so a burst of heavy writes can't slow reads. An **internal load balancer** sits between the tiers. Its nodes have only private addresses, so only the web tier can reach it. Later diagrams leave it out to reduce clutter.

#### Move static content to a CDN

A **CDN** keeps copies of files close to users. Amazon **CloudFront** sends each request to the edge location with the lowest latency. If that location has the file, it answers at once. If not, it fetches the file from the **origin**, here the S3 bucket, and keeps a copy, by default for 24 hours unless the origin's headers say otherwise. CloudFront can cache some dynamic content too, such as pages that are the same for every visitor, which takes load off the web tier and cuts latency.

Lock the bucket down with **origin access control (OAC)**, so its policy allows reads only from your CloudFront distribution and browsers can't skip the CDN. CloudFront charges for data sent to users and for requests, and fetches from AWS origins such as S3 are free. [DNS and CDNs](/learn/dns-and-cdn#content-delivery-networks) covers caching rules and invalidation.

### Stage 3: 100,000 users, add a cache and read replicas

```diagram
title: Stage 3. A cache absorbs most reads; replicas take the misses.
[u:client] Users @ 0,0
[alb] Load balancer @ 1,0
[web] Web and app\nservers @ 2,0
[cache:store] ElastiCache\nsessions, hot data @ 2,1
[p:store] RDS primary\nwrites @ 4,0
[r:store] Read replicas\nreads @ 4,1
u -> alb
alb -> web
web -> cache : 1. try cache
web -> p : writes
web -> r : 2. reads on miss
p --> r : async copy
```

**What the measurements show.** The site is read-heavy, 100 reads per write, and the database suffers under the reads. Query latency climbs at peak and the primary's CPU stays high.

**Goals.** Take load off MySQL with a **memory cache** and **read replicas**, and add web and application servers to keep responses fast. Again, profiling may show you need only some of these.

#### Add a memory cache

Memory is much faster than storage. In the widely shared table of latency numbers every programmer should know, reading 1 MB sequentially takes about 250 microseconds from memory, about 1 millisecond from an SSD (4 times as long) and about 20 milliseconds from a spinning disk (80 times as long).

**First, give MySQL's own cache enough memory.** MySQL's InnoDB engine keeps recently used table and index pages in its **buffer pool**, and its manual notes that dedicated servers often give it up to 80% of physical memory. If the hot data fits, reads stop touching disk, and that may be enough. Older advice to tune MySQL's query cache no longer applies: MySQL 8.0 dropped it because it didn't scale on multi-core machines, as [Relational databases](/learn/relational-databases#the-query-cache-and-why-its-gone) explains.

**Then add a cache cluster.** Amazon **ElastiCache** runs Valkey, Redis OSS or Memcached for you, as a serverless cache that scales itself or as nodes you size. Put two kinds of data in it:

- **Frequently read content from MySQL,** such as popular posts and profiles. The application checks the cache first, reads the database only on a miss, and stores the result. This is **cache-aside**, explained in [Caching](/learn/cache#cache-aside). Because a few items get most of the traffic, the cache also absorbs uneven load and spikes.
- **Session data from the web servers.** While each server keeps sessions in its own memory, users are tied to one server, and losing it logs them out. With sessions in the cache, the web servers become **stateless**, so any server can handle any request. That's what makes autoscaling safe in stage 4. DynamoDB is another common home for sessions.

A rough size: new content arrives at 1 TB ÷ 30 ≈ 33 GB a day. If most reads hit the last week's posts, the hot set is about 7 × 33 GB ≈ 230 GB, plus sessions, so plan for a cluster that spreads keys over several nodes. Choose Valkey or Redis OSS for replicas with automatic failover, which Memcached lacks, so one failed node doesn't empty its share of the cache.

The cost is another system to run and pay for, plus new bugs: stale data after a write, and a flood of misses to the database when the cache is cold or fails. [Caching](/learn/cache#failure-modes-and-how-to-prevent-them) covers both.

#### Add MySQL read replicas

Alongside the cache, **read replicas** take reads off the primary, the one server that accepts writes. RDS builds each replica from a snapshot and keeps it current with MySQL's asynchronous replication. An RDS for MySQL instance can have up to 15 replicas in its Region, in any zones, and RDS recommends giving each one the same compute and storage as the source. You add and remove them yourself, since RDS doesn't autoscale replicas. Each one is billed like a regular instance, though replication traffic within a Region is free.

Three changes make replicas work:

1. **Split reads from writes** in the application. Writes go to the primary, reads to a replica.
2. **Spread reads across replicas** with a load balancer or proxy in front of them, or one internal DNS name. (Diagrams leave this out.)
3. **Handle replication lag.** A user who posts and immediately reloads might read from a replica that hasn't seen the post. One fix is to send a user's reads to the primary for a few seconds after that user writes:

```python
import time

PRIMARY_HOST = "app-db.example.internal"       # accepts reads and writes
REPLICA_HOST = "app-db-read.example.internal"  # one name in front of all replicas
STICKY_SECONDS = 5                             # longer than the lag we normally see

def pick_db_host(user_id: int, is_write: bool, cache) -> str:
    """Send writes, and reads that follow a recent write, to the primary."""
    if is_write:
        # Stored in the shared cache, because any web server may get the next request.
        cache.set(f"last_write:{user_id}", time.time(), ex=STICKY_SECONDS)
        return PRIMARY_HOST
    if cache.get(f"last_write:{user_id}") is not None:
        return PRIMARY_HOST   # read your own write
    return REPLICA_HOST
```

For a rough count, suppose the cache answers 90% of the 120,000 peak reads, leaving 12,000 a second. If your load tests show one replica handles 4,000 of your queries a second with headroom, you need three, plus a spare so that losing one doesn't overload the rest. The per-replica figure is made up; measure your own. [Relational databases](/learn/relational-databases#replication-lag-and-reading-your-own-writes) covers replication and lag in depth.

Finally, add web and application servers as needed. With sessions in the cache, that's just launching more instances behind the load balancers.

### Stage 4: 500,000 users, autoscale and automate

```diagram
title: Stage 4. CloudWatch alarms tell Auto Scaling when to add or remove servers.
[alb] Load balancer @ 0,0
[web] Web tier\nAuto Scaling group @ 1,0
[app] App tier\nAuto Scaling group @ 3,0
[cw] CloudWatch\nmetrics + alarms @ 2,1
[asg] EC2 Auto Scaling\npolicies @ 2,2
alb -> web
web -> app : via internal LB
web --> cw : CPU, requests
app --> cw
cw -> asg : alarm
```

**What the measurements show.** Traffic peaks during US business hours and drops sharply when people leave work. Running peak capacity all day wastes money all night. The team is small and wants to automate as much of the operations work as possible.

**Goals.** Add **autoscaling** to keep up with spikes and to power down idle instances. **Automate DevOps.** **Keep monitoring** to find the next bottleneck.

#### Add autoscaling

**Amazon EC2 Auto Scaling** manages Auto Scaling groups of identical instances. Each group has a minimum size it never goes below, a maximum it never exceeds, and a desired capacity it maintains. It replaces instances that fail health checks and registers new instances with the load balancer. It has no charge of its own; you pay for the instances and alarms.

- **One group per tier:** one for the web servers and one for each type of application server, so each scales on its own signal.
- **Each group spans several zones,** and Auto Scaling keeps instances balanced across them.
- **Set limits:** say a minimum of 2, one per zone, so the tier survives a zone failure, and a maximum that caps the bill.

CloudWatch provides the trigger, in two broad ways:

- **Time of day, for predictable load.** A scheduled action raises the minimum before the morning rush. Predictive scaling learns daily and weekly patterns and adds capacity before traffic arrives.
- **Metrics over time, for load you can't predict.** A **target tracking** policy works like a thermostat: you pick a metric and a target, such as average CPU at 50%, and Auto Scaling creates the alarms and adds or removes instances to hold it. Built-in metrics are CPU, network in and out, and ALB requests per instance, and you can add custom metrics. Latency is a poor target-tracking metric, because it doesn't fall in proportion as servers are added.

```python
import boto3

autoscaling = boto3.client("autoscaling")

# Thermostat: keep the web tier's average CPU near 50%.
autoscaling.put_scaling_policy(
    AutoScalingGroupName="web-tier",
    PolicyName="cpu-50",
    PolicyType="TargetTrackingScaling",
    TargetTrackingConfiguration={
        "PredefinedMetricSpecification": {"PredefinedMetricType": "ASGAverageCPUUtilization"},
        "TargetValue": 50.0,
    },
)

# Calendar: at least 8 web servers before the US workday starts.
autoscaling.put_scheduled_update_group_action(
    AutoScalingGroupName="web-tier",
    ScheduledActionName="weekday-morning",
    Recurrence="0 8 * * MON-FRI",
    TimeZone="America/New_York",
    MinSize=8,
)
```

Autoscaling adds complexity: servers must be stateless, each new instance must configure itself, and you debug a fleet whose members change hourly. It also lags. A metric must cross its threshold, and a new instance must boot, pass health checks and warm up before it helps. With basic monitoring, EC2 metrics arrive only every five minutes. A sudden spike can outrun all that, and target tracking also scales in gradually after a drop. Scheduled and predictive scaling cover the spikes you can see coming.

#### Automate DevOps

Autoscaling only works if a new instance goes from nothing to serving traffic with no human involved:

- **Configuration management** tools such as Chef, Puppet and Ansible set up servers from code.
- **Images and launch templates.** Bake the application into an Amazon Machine Image (AMI) and describe the instance in a launch template. Instance refresh rolls a new image across a group gradually.
- **Infrastructure as code.** AWS CloudFormation, or a tool like Terraform, describes the whole stack in template files you version, review and can rebuild from.

#### Keep monitoring

Each stage moves the bottleneck, and only measurement shows where:

- **Host level:** one EC2 instance's metrics, to spot a bad server.
- **Aggregate level:** load balancer statistics such as request counts, errors and latency across a tier.
- **Log analysis:** CloudWatch Logs for application logs, and CloudTrail, which records every action taken in the AWS account and by whom. Loggly, Splunk and Sumo Logic are third-party options.
- **External site performance:** CloudWatch Synthetics runs scripts called canaries, as often as once a minute, that follow the same paths customers do. Pingdom and New Relic do this too.
- **Notifications and incidents:** a service such as PagerDuty pages whoever is on call.
- **Error reporting:** a service such as Sentry groups application exceptions as they happen.

[Monitoring, logging and tracing](/learn/observability) explains what to measure and when to alert.

### Stage 5: 10 million users, split the data and go asynchronous

```diagram
title: Stage 5. Slow work moves to a queue; data is split by user and by kind.
[up:client] Client uploads\na photo @ 0,1
[app] App servers @ 1,1
[q:queue] SQS queue @ 2,2
[w] Workers\nEC2 or Lambda @ 3,2
[s3:store] S3\nthumbnails @ 4,2
[db:store] MySQL shards\nby user_id @ 3,0
[ddb:store] DynamoDB\nsessions, counters @ 1,0
[rs:store] Redshift\nold data @ 4,0
up -> app
app -> ddb
app -> db
app --> q : thumbnail job
q --> w
w -> s3
w -> db : mark ready
db --> rs : nightly export
```

**What the measurements show.** As the service grows toward the step 1 numbers, each round of load testing and profiling turns up a new bottleneck. (Autoscaling groups are left out of the diagram.)

**Goals.** Keep fixing the problems those numbers predict.

#### Archive old data to a warehouse

If the MySQL database grows too large, keep only a limited window, such as the last year, and move the rest to a **data warehouse**. Amazon **Redshift** is a managed, petabyte-scale warehouse, so 1 TB of new content a month is comfortably within its range. Analysts query history there, and the transactional database stays small enough to back up, restore and replicate quickly.

#### Scale reads with the cache and writes with SQL patterns

At 40,000 reads a second on average, mostly for popular content, the answer to read traffic is to scale the memory cache, which also absorbs uneven traffic and spikes. The read replicas may still struggle with the misses: at 120,000 reads a second at peak, even a 5% miss rate is 6,000 queries a second.

Writes are harder. 400 a second on average, with much higher peaks, all land on one primary. A large MySQL server may handle that rate, and your load tests will tell you, but its storage also grows 1 TB a month toward the 64 TiB limit. One primary runs out of room before it runs out of speed. Four SQL patterns help:

- **[Federation](/learn/relational-databases#federation-one-database-per-feature)** gives each function its own database, such as users, posts and messages, so each is smaller and takes only its share of the writes.
- **[Sharding](/learn/relational-databases#sharding-splitting-one-table-across-databases)** splits one table across databases by key. Sharding `posts` by `user_id` over 8 shards gives each about 36 TB ÷ 8 = 4.5 TB after three years and 1,200 ÷ 8 = 150 writes a second at peak. Queries across users, such as a global "latest posts" feed, must then ask every shard or come from somewhere else.
- **[Denormalization](/learn/relational-databases#denormalization)** stores copies of data where it's read, trading extra writes for fewer joins.
- **[SQL tuning](/learn/relational-databases#sql-tuning)** fixes slow queries and missing indexes. It's the cheapest, so do it first.

#### Move some data to NoSQL

To absorb more of the reads and writes, move data that doesn't need relations to a **NoSQL** database such as **Amazon DynamoDB**. It's a fully managed key-value and document store that AWS describes as giving single-digit millisecond performance at any scale. It replicates every table across three Availability Zones by default and scales tables to virtually any size, with no servers or shards for you to manage. In on-demand mode you pay per request.

The trade-off is the query model. DynamoDB has no joins, so you design tables around the questions the application asks and denormalize to answer each in one lookup. Sessions, counters and per-user lists like "this user's posts, newest first" fit well, and the core relational data can stay in MySQL. [NoSQL and choosing a database](/learn/nosql-databases#modeling-for-access-patterns) shows how.

#### Do slow work asynchronously

Separate the application servers further so each job scales on its own. Work that doesn't need to finish while the user waits, such as batch jobs and heavy computations, runs **asynchronously** through a **queue** and **workers**.

In a photo feature, the upload and the thumbnail can be split:

1. The **client** uploads a photo.
2. The **application server** stores the original in S3, records it in the database, puts a job on a queue such as **Amazon SQS** (Simple Queue Service), and returns at once.
3. A **worker**, on EC2 or as an AWS Lambda function, pulls the job off the queue, creates the thumbnail, updates the database, and stores the thumbnail in S3.

```python
import json
import boto3

sqs = boto3.client("sqs")
s3 = boto3.client("s3")
BUCKET = "example-photos"
QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/thumbnails"

def upload_photo(user_id: int, image: bytes) -> dict:
    """In the request: store, record, enqueue, return."""
    photo_id = new_photo_id()
    key = f"originals/{photo_id}.jpg"
    s3.put_object(Bucket=BUCKET, Key=key, Body=image)
    insert_photo(photo_id, user_id, key)  # thumbnail_key starts out NULL
    sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=json.dumps({"photo_id": photo_id, "key": key}))
    return {"photo_id": photo_id, "status": "processing"}

def run_worker() -> None:
    """On a worker: take jobs, do the slow part, delete each job when done."""
    while True:
        resp = sqs.receive_message(QueueUrl=QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=20)
        for msg in resp.get("Messages", []):
            job = json.loads(msg["Body"])
            if not thumbnail_done(job["photo_id"]):  # a job can arrive twice
                original = s3.get_object(Bucket=BUCKET, Key=job["key"])["Body"].read()
                thumb_key = f"thumbs/{job['photo_id']}.jpg"
                s3.put_object(Bucket=BUCKET, Key=thumb_key, Body=make_thumbnail(original))
                set_thumbnail_key(job["photo_id"], thumb_key)
            sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=msg["ReceiptHandle"])
```

Three SQS behaviors shape that code:

- **Receiving hides a message without removing it.** It stays invisible to other workers for the **visibility timeout**, 30 seconds by default. If the worker crashes before deleting it, the message reappears and another worker retries, so no job is lost.
- **Standard queues deliver at least once,** so a message occasionally arrives twice. The worker checks whether the thumbnail exists before redoing the work. Lambda's SQS integration is also at-least-once, and AWS recommends idempotent functions. See [Queues and asynchronous work](/learn/queues-and-async#duplicates-are-normal-so-make-workers-idempotent).
- **Ordering is best-effort.** FIFO queues guarantee order within a message group at lower throughput. Thumbnails don't care about order.

Workers can autoscale on a custom metric of queue messages per instance. With Lambda, AWS polls the queue and runs your function per batch, so there are no workers to manage. The costs: the client must show "processing" until the thumbnail is ready, and you need to watch queue depth and keep a dead-letter queue for jobs that keep failing.

Beyond 10 million users the loop continues. The 2015 talk ends with multiple AWS Regions and custom solutions where managed services no longer fit.

## Trade-offs and follow-up questions

**Managed services or your own on EC2?** RDS, ElastiCache and DynamoDB cost more per hour than the same software on plain instances, but AWS handles backups, patching, failover and much of the scaling. For a small team that's usually the right trade, because engineers cost more than instance hours. Run your own when you need a version, extension or setting the managed service lacks, or at a scale where the savings pay for a database team.

**Multi-AZ standby, read replicas, or both?** A Multi-AZ standby is for availability: synchronous, unreadable, and takes over in a minute or two. A read replica is for capacity: asynchronous, can lag, and promoting it is a manual step. At this size you usually want both. RDS also offers Multi-AZ DB clusters, whose two standbys in other zones also serve reads. See [Availability](/learn/availability) and [Relational databases](/learn/relational-databases#primary-replica-replication).

**Cache first, or replicas first?** A cache is cheaper per read and much faster, but brings stale data and a new failure mode. Replicas speed up every query, including the long tail a cache misses, but each is a full database instance. At 100 reads per write with popular items, the cache usually pays off first, after giving the buffer pool enough memory. See [Caching](/learn/cache).

**What should trigger autoscaling?** CPU target tracking is simple and works when CPU is what runs out. ALB requests per target tracks web load more directly. Scheduled scaling handles the rush you can see coming, and predictive scaling learns it. A high minimum costs money every hour; a low one risks slow mornings. Here, target tracking on requests per target plus a scheduled weekday minimum is a reasonable pick.

**Sharding, federation or NoSQL?** Federation is gentlest: each database stays ordinary MySQL. Sharding scales one huge table but moves cross-shard queries and resharding into your code. DynamoDB removes the sharding work but needs access-pattern design and has no joins. A reasonable path: federate first, move sessions and counters to DynamoDB, and shard only the tables that still don't fit. See [Relational databases](/learn/relational-databases#the-scaling-toolkit-at-a-glance) and [NoSQL](/learn/nosql-databases).

**Workers on EC2 or Lambda?** Lambda has nothing to patch or scale and suits short, bursty jobs like thumbnails. EC2 workers suit steady, heavy or long-running jobs with special libraries. Both need idempotent handlers. See [Queues and asynchronous work](/learn/queues-and-async).

**More than one Region?** This design survives losing an Availability Zone, not a whole Region. Going multi-Region means copying data across Regions (cross-Region read replicas, DynamoDB global tables) and steering users with Route 53 latency or failover routing. It roughly doubles the infrastructure and raises hard consistency questions, so most products wait until a regulation or an availability promise requires it. See [DNS routing policies](/learn/dns-and-cdn#dns-routing-policies) and [CAP and consistency](/learn/cap-and-consistency).

## Check yourself

<details>
<summary>RDS reports that a Multi-AZ failover finished in 90 seconds, but your Java application servers kept failing for 20 minutes, until someone restarted them. What happened?</summary>

RDS fails over by changing the database endpoint's DNS record to point at the standby. Some JVM configurations cache DNS lookups until the process restarts, so the servers kept connecting to the dead primary.

Set the JVM's DNS cache TTL (`networkaddress.cache.ttl`) to 60 seconds or less, as AWS recommends, and make sure the connection pool drops broken connections. Then rehearse it: rebooting an RDS instance with failover triggers the same switch on purpose.

</details>

<details>
<summary>When Auto Scaling removes a web server at night, some users are logged out. What's wrong, and what's the fix?</summary>

The web servers are stateful: each keeps sessions in its own memory, probably with sticky sessions on the load balancer. Removing a server destroys its sessions.

Move sessions to a shared store such as ElastiCache or DynamoDB. Then any server can serve any user, Auto Scaling can remove any of them safely, and sticky sessions can go.

</details>

<details>
<summary>A user posts an entry, reloads, and it isn't there. Ten seconds later it appears. Which stage caused this, and what do you change?</summary>

Stage 3. Writes go to the primary, reads go to a replica, and replication is asynchronous, so the reload hit a replica that hadn't caught up.

Send a user's reads to the primary for a few seconds after they write, as in `pick_db_host`, or write the new entry into the cache along with the database. Also watch replica lag in CloudWatch: lag of minutes means the replicas are overloaded.

</details>

<details>
<summary>At peak the site serves 120,000 reads a second with a 95% cache hit rate, and one replica handles 3,000 of your queries a second comfortably. How many replicas do you need, and what happens if the hit rate drops to 80% when a cache node fails?</summary>

At 95%, misses are 120,000 × 0.05 = 6,000 a second, so 6,000 ÷ 3,000 = 2 replicas, plus a spare or two for failures: about 3 to 4.

At 80%, misses jump to 120,000 × 0.20 = 24,000 a second, which needs 8 replicas. Small changes in hit rate cause large swings in database load. That's why the cache needs replicas and automatic failover (Valkey or Redis OSS), and why you can't rely on adding replicas in a hurry: you create them yourself, and RDS for MySQL allows at most 15 per source.

</details>

<details>
<summary>Three years in, the posts table holds 36 TB of content and about as much again in indexes. What limit are you hitting, and what are your options?</summary>

RDS for MySQL tops out at 64 TiB, about 70 TB, and you're at roughly 72 TB. The standby and every replica hold full copies too, so the storage bill multiplies.

From least to most work: archive old posts to Redshift or S3; federate posts into their own database; shard posts by `user_id` across several RDS instances; or move posts to DynamoDB. With 1 TB arriving every month, archiving only buys time. Sharding or DynamoDB is the long-term answer for the largest table.

</details>

<details>
<summary>The bill shows a large "NAT gateway data processing" charge. Workers in private subnets read originals from S3 and write thumbnails back. What's happening, and how do you cut it?</summary>

Traffic from private subnets to S3 goes through the NAT gateway, which charges per gigabyte processed, about $0.045 per GB in US East at the time of writing. Every photo read and every thumbnail written pays it.

Add a gateway endpoint for S3 to the VPC. Gateway endpoints have no extra charge, and S3 traffic then bypasses the NAT gateway. For traffic that still needs NAT, keep a NAT gateway in each Availability Zone so it doesn't cross zones.

</details>

<details>
<summary>Every weekday at 9 a.m. Eastern, latency spikes for about ten minutes, even though CPU target tracking is on. Why, and what would you change?</summary>

Target tracking reacts after the fact. CPU must rise, an alarm must fire, and new instances must boot, pass health checks and warm up. With basic monitoring, EC2 metrics arrive only every five minutes. That adds up to about ten minutes.

The spike is predictable, so scale before it: a scheduled action that raises the minimum before 9 a.m., or predictive scaling. Turn on one-minute detailed monitoring, and consider tracking ALB requests per target, which rises as soon as traffic does. Keep target tracking for the days the pattern breaks.

</details>

## Further reading

- [A Beginner's Guide to Scaling to 11 Million+ Users on Amazon's AWS](https://highscalability.com/a-beginners-guide-to-scaling-to-11-million-users-on-amazons/): High Scalability's 2016 summary of Joel Williams's re:Invent 2015 talk, the stage-by-stage plan this chapter updates.
- [Elastic IP addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html) and [EC2 instance IP addressing](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-instance-addressing.html): when public addresses change, why Elastic IPs exist, and the quota.
- [New AWS public IPv4 address charge](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/): the announcement of the $0.005-an-hour charge that started February 1, 2024.
- [Change the instance type](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/change-instance-type-of-ebs-backed-instance.html): what a vertical resize involves on EC2, including the stop and the address change.
- [Route 53 routing policies](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html) and [alias versus CNAME records](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-choosing-alias-non-alias.html): the routing options, and why alias records suit load balancers and CloudFront.
- [VPC subnets](https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html), [security groups](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html), [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html) and [gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html): public and private subnets, stateful firewalls, and outbound access without surprise bills.
- [Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html): shell access to instances without opening port 22.
- [Data protection in Amazon S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html) and [S3 default encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html): the durability design, and encryption on by default since January 2023.
- [What is Amazon CloudFront?](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html) and [restricting access to an S3 origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html): how edge caching works, and how origin access control keeps the bucket private.
- [What is Amazon RDS?](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Welcome.html), [Multi-AZ deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html), [failover](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html), [read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html) and [storage limits](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html): what RDS manages, how failover works, how replicas are built and billed, and the 64 TiB ceiling.
- [How Elastic Load Balancing works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html) and [ELB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/): nodes per zone, cross-zone balancing, the 60-second DNS TTL, internal load balancers, and LCUs.
- [Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/what-is-amazon-ec2-auto-scaling.html), [scaling methods](https://docs.aws.amazon.com/autoscaling/ec2/userguide/scaling-overview.html) and [target tracking](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html): group limits, scheduled and predictive scaling, and which metrics work as targets.
- [Comparing Valkey, Memcached and Redis OSS in ElastiCache](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/SelectEngine.html): which engines support replication and failover.
- [What is Amazon DynamoDB?](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html): the data model, capacity modes and default three-zone replication.
- [SQS queue types](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-queue-types.html), [visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) and [Lambda with SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html): at-least-once delivery, ordering, retries, and why handlers must be idempotent.
- [What is Amazon CloudWatch?](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/WhatIsCloudWatch.html), [Synthetics canaries](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Synthetics_Canaries.html) and [CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html): metrics, alarms, logs, outside-in checks and an audit trail.
- [What is Amazon Redshift?](https://docs.aws.amazon.com/redshift/latest/mgmt/welcome.html) and [What is CloudFormation?](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/Welcome.html): the warehouse for old data, and infrastructure as code.
- [The InnoDB buffer pool](https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool.html) and [MySQL 8.0: retiring support for the query cache](https://dev.mysql.com/blog-archive/mysql-8-0-retiring-support-for-the-query-cache/): the database cache to tune first, and why the old query cache is gone.
- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832): Jonas Bonér's table of memory, SSD, disk and network latencies.
