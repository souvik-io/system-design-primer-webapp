# Load balancers

This chapter answers five questions:

- What does a load balancer do, and how does it know which servers are healthy?
- How does it choose which server gets the next request?
- What is the difference between layer 4 and layer 7 load balancing?
- How do you stop the load balancer itself from taking your site down?
- What does scaling out behind a load balancer cost elsewhere in the system?

We'll keep using **Crumb**, the recipe-sharing site from [Scalability 101](/learn/scalability-101). Crumb runs several identical app servers behind a load balancer. Sessions live in Redis, photos live in object storage, and the app servers share a cache and a database with read replicas. Scalability 101 treated the load balancer as a box that sends each request to a free server. This chapter opens that box.

## What a load balancer does

Think of the host at a busy restaurant. Guests don't pick their own waiter. The host seats them in a section whose waiter has room, and stops seating people in a section whose waiter has gone home sick. Guests never need to know who is working tonight.

A **load balancer** plays the host's role for servers. Clients connect to one address, the load balancer's. For each request or connection, it picks one server from the group behind it and forwards the request there. When the server replies, the load balancer passes the response back to the client. The servers behind it are called **backends**, the **pool**, or **targets** (AWS's word).

A load balancer has four jobs:

1. **Spread the work** across all the servers, so you can add capacity by adding servers.
2. **Avoid unhealthy servers.** If a server crashes or starts failing, stop sending it requests.
3. **Avoid overloading any one server** while others sit idle.
4. **Remove a single point of failure.** A **single point of failure** is one part whose failure takes the whole system down. One app server is one. With three behind a load balancer, any one can fail and the site stays up.

```diagram
title: Crumb's load balancer stops sending requests to the server that failed its health check.
[u:client] Users @ 0,1
[lb] Load balancer @ 1,1
[a] App server 1 @ 3,0
[b] App server 2 @ 3,1
[c] App server 3\n(failing) @ 3,2
u -> lb : HTTPS
lb -> a
lb -> b
lb --> c : health checks only
```

The same idea works in front of database read replicas, a cache cluster, or an internal service. Wherever several identical servers can do a job, something has to decide which one gets each piece of work.

### Hardware, software and managed load balancers

- **Hardware appliances** are dedicated boxes from networking vendors. They are fast but expensive, and you usually scale them by buying a bigger box.
- **Software load balancers** such as HAProxy, NGINX and Envoy run on ordinary servers. For more capacity, you run more copies.
- **Managed cloud load balancers**, such as AWS Elastic Load Balancing, are run for you by the cloud provider. You configure rules and pay for use.

Software on ordinary machines now handles enormous traffic. Google's network load balancer, Maglev, runs on standard Linux servers. Google's [2016 paper](https://research.google/pubs/maglev-a-fast-and-reliable-software-network-load-balancer/) says it "has been serving Google's traffic since 2008," and that one Maglev machine "is able to saturate a 10Gbps link with small packets."

## Health checks

A load balancer can only avoid a broken server if it notices the server is broken. It does this with **health checks**, of two kinds.

### Active health checks

In an **active** check, the load balancer sends its own test request to each server on a schedule, such as `GET /health` every few seconds. A server that fails several checks in a row is taken out of rotation. It comes back after passing several in a row. Defaults vary a lot:

| Setting | AWS Application Load Balancer | HAProxy |
| --- | --- | --- |
| Time between checks | 30 seconds | 2 seconds |
| Failures before marked down | 2 | 3 |
| Successes before marked up | 5 | 2 |

The AWS values are from its [health check settings](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html), which also set a 5-second timeout per check. The HAProxy values are the `inter`, `fall` and `rise` defaults in its [configuration manual](https://www.haproxy.org/download/2.8/doc/configuration.txt).

Here is what that means for Crumb. Say an app server crashes just after passing a check. With AWS's defaults, the next two checks fail about 30 and 60 seconds later, and only then is the server marked down. For roughly a minute, it keeps getting a share of real requests, and they fail. With HAProxy's defaults, the same crash is noticed in about 6 seconds. Checking more often finds failures sooner, at the cost of a little extra load.

### Passive health checks

In a **passive** check, the load balancer watches the real traffic it forwards. If requests to a server keep failing, it stops using that server for a while. In NGINX's [load balancing guide](https://nginx.org/en/docs/http/load_balancing.html), `max_fails` sets how many failures mark a server as failed (the default is 1). After the `fail_timeout` period, NGINX tries the server again with live requests and brings it back if they succeed.

Passive checks react at once, but only after some users' requests have failed. Active checks find a dead server even when no traffic flows, but only on their schedule. Most setups use both.

### What to check, and what if everything fails

A check that only proves the process is running can pass while the server can't do useful work. A check that tests a shared dependency, such as the database, can fail on every server at once. The [availability chapter](/learn/availability-101#health-checks-that-test-the-right-thing) covers how to design a check that avoids both problems.

When every server fails its checks, the check itself is often wrong, and the servers may still answer some requests. So AWS's Application Load Balancer **fails open**: if every target is unhealthy, it sends traffic to all of them "regardless of their health status." Possibly failing requests beat a certain outage.

## Choosing a server: routing methods

For each request, the load balancer picks a server using a rule called the **load balancing algorithm** or **routing method**.

| Method | How it picks | Good for | Watch out for |
| --- | --- | --- | --- |
| Round robin | Each server in turn | Similar servers and requests | Ignores how busy servers are |
| Weighted round robin | In turn, bigger servers get more turns | Servers of different sizes | Keeping weights up to date |
| Random | Any server, by chance | Many load balancers, no shared state | Short streaks of bad luck |
| Least loaded | The server doing the least work now | Requests of very different cost | New servers get flooded |
| Power of two choices | Two at random, then the less busy | Large fleets, many load balancers | A little more work per pick |
| Hashing | A hash of a key, such as IP or URL | Same key to the same server | Adding a server moves many keys |
| Session cookie | The server the cookie names | Apps with sessions on the server | Uneven load, lost sessions |

### Round robin, weighted round robin and random

**Round robin** works like dealing cards: server 1, server 2, server 3, then back to server 1. It is the default in both NGINX and HAProxy.

It assumes every server is the same size. When Crumb adds a server with twice the CPU of the others, **weighted round robin** gives it weight 2 and the old servers weight 1. Out of every four requests, the big server gets two and each small one gets one. NGINX's guide shows the same idea with weights of 3, 1 and 1.

It also assumes every request costs about the same. A Crumb recipe page takes 20 ms. A search across five ingredients can take two seconds. If several slow searches land on one server, round robin keeps sending it its full share anyway.

**Random** spreads load as evenly as round robin over thousands of requests, and needs no memory of whose turn it is. That helps when Crumb runs several load balancer machines: each can pick randomly without coordinating with the others.

### Least loaded

**Least loaded** methods send each request to the server doing the least work right now. Products measure work differently:

- **Least connections** counts open connections (NGINX's `least_conn`, HAProxy's `leastconn`).
- **Least outstanding requests** counts requests sent but not yet answered. AWS Application Load Balancers [offer it](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html) alongside round robin and weighted random.
- **Least response time** favours servers that have answered fastest. NGINX's guide describes a `least_time` method that weighs average response time and active connections.

These handle Crumb's slow searches well. A server stuck on three searches has more requests open than its neighbours, so new work goes elsewhere.

They aren't always worth it. HAProxy's manual recommends `leastconn` "where very long sessions are expected," such as database connections, and calls it "not very well suited for protocols using short sessions such as HTTP." When requests finish in milliseconds, every server's count hovers near zero and says little.

There is also a trap. A new server has zero connections, so it looks like the best choice for every request at once and gets flooded before its caches warm up. **Slow start** fixes this by raising a new server's share gradually. HAProxy's `slowstart` grows it "linearly from 0 to 100%" over the time you set. AWS allows 30 to 900 seconds and leaves it off by default.

### The power of two random choices

A cheaper way to get most of the benefit: pick **two** servers at random, and send the request to the less busy one.

Michael Mitzenmacher, Andréa Richa and Ramesh Sitaraman explain why this works in their [survey](https://www.eecs.harvard.edu/~michaelm/postscripts/handbook2001.pdf). Picture balls dropped into bins. If each ball goes into one random bin, some bin ends up far fuller than average. If each ball checks two random bins and picks the emptier one, the fullest bin is dramatically less full. In their words, "even a small amount of choice can lead to drastically different results," and each choice beyond two helps only a little more.

It also suits several load balancers working side by side. If they all pick "the least loaded server," they may all see the same quiet server and pile onto it together. With two random choices, they spread out. HAProxy's `random` algorithm draws 2 servers by default, which its manual says "generally shows very good distribution and performance."

### Hashing: the same key to the same server

Sometimes requests that share something should land on the same server. **Hash-based** routing takes a key from the request, hashes it, and uses the result to pick a server. The same key always gives the same server.

- **Source IP hashing** uses the client's address. HAProxy's manual says it is "generally used in TCP mode where no cookie may be inserted." NGINX calls it `ip_hash`.
- **URL hashing** uses the request path, so every request for `/recipes/812` reaches the same cache server. HAProxy's manual says this is done "to maximize the cache hit rate."

The usual method divides the hash by the number of servers and keeps the remainder. Add or remove a server and that number changes, so most keys move. HAProxy warns that "many clients will be directed to a different server." For a cache, that means a sudden wave of misses. **Consistent hashing** moves only a small share of keys when the pool changes. It has [its own chapter](/learn/consistent-hashing).

For Crumb: start with round robin, or least outstanding requests if request costs vary a lot. Add weights when servers differ in size. Use hashing only when keeping a key on one server pays off, as it does for caches.

## Session persistence (sticky sessions)

**Session persistence**, or **sticky sessions**, means sending all of one user's requests to the same server. It exists for apps that keep each user's login in the memory of the server they first reached. [Scalability 101](/learn/scalability-101#scaling-out-clones-behind-a-load-balancer) explains why such users get logged out when a request lands elsewhere.

Load balancers usually do this with a **cookie**, a small piece of data the browser sends back with every request.

- The load balancer can **insert its own cookie** naming the server. An AWS Application Load Balancer's cookie lasts one day by default.
- It can **reuse the app's cookie**. HAProxy's [architecture guide](http://www.haproxy.org/download/1.2/doc/architecture.txt) prefixes the app's `JSESSIONID` cookie with the server's name, so the load balancer can read which server each user belongs to.
- Without cookies, as with plain TCP, **source IP hashing** gives weaker stickiness. Many users behind one office network share an IP and all land on one server. A phone that moves from Wi-Fi to mobile data gets a new IP and a new server.

Stickiness has costs. Load becomes uneven, because a server holding a few very active users can't hand them off. A server failure still logs out everyone stuck to it. And removing a server means waiting for its sessions to end.

That's why Crumb keeps its servers **stateless**, with sessions in Redis. Any server can handle any request. Stickiness remains useful as an optimization: if a server caches a user's recent data locally, sending the user back gives more cache hits, and nothing breaks if they land elsewhere.

## TLS termination

Crumb's traffic is encrypted with **TLS** (Transport Layer Security), the protocol behind the browser's padlock. Its older name, **SSL**, survives in many product settings. A TLS server needs a **certificate** in the [X.509](https://en.wikipedia.org/wiki/X.509) format, which proves it owns its domain name, plus a matching private key.

Setting up encrypted connections costs CPU. **TLS termination** (or SSL termination) means the load balancer does this work. AWS's [listener documentation](https://docs.aws.amazon.com/elasticloadbalancing/latest/classic/elb-listener-config.html) puts it plainly: the load balancer "decrypts requests from clients before sending them to the back-end instances." It encrypts the responses on the way back.

This has three benefits:

1. **App servers do less work**, because they skip encryption.
2. **Certificates live in one place.** Without termination, every app server needs the certificate and private key. With it, you install and renew them on the load balancer only, and there are fewer copies of the key to leak.
3. **The load balancer can read requests**, which layer 7 routing needs.

| Setup | Load balancer to app servers | Who holds certificates | Load balancer reads requests? |
| --- | --- | --- | --- |
| Terminate | Plain HTTP on a private network | Load balancer | Yes |
| Terminate and re-encrypt | A new TLS connection | Load balancer and servers | Yes |
| Pass-through | The client's encrypted stream, untouched | Servers | No |

Re-encryption suits rules that require encryption inside the data center. Pass-through keeps the load balancer from seeing any data, but limits it to layer 4 routing.

Proxying also hides the client's address: app servers see connections from the load balancer. For HTTP, the load balancer adds an `X-Forwarded-For` header with the client's IP. For plain TCP, the **proxy protocol** adds a short header with it at the start of the connection. The [security chapter](/learn/security-101#in-transit-tls-13) covers TLS itself.

## Layer 4 and layer 7 load balancing

Networking is often described in layers, using the OSI model. Two layers matter here:

- **Layer 4, the transport layer**, is where TCP and UDP work. Traffic is described by source and destination **IP addresses** and **ports**. A port is a number that says which program the traffic is for, such as 443 for HTTPS.
- **Layer 7, the application layer**, is where HTTP works. Here you can see the method (`GET`), the path (`/recipes/812`), headers, cookies and the body.

Picture two people sorting mail. One reads only the envelope. The other opens each letter before deciding which department gets it. The first is faster. The second makes better decisions.

### Layer 4

A **layer 4 load balancer** looks only at addresses and ports, never at the contents. It doesn't know whether the traffic is HTTP, a database protocol or a game. It picks a server when a connection starts and sends the whole connection there, usually by rewriting the packets' addresses. That rewriting is called **network address translation** (NAT).

AWS's Network Load Balancer works this way. Its [documentation](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/introduction.html) says it "can handle millions of requests per second." It picks a target by hashing the protocol, addresses, ports and TCP sequence number, and "each individual TCP connection is routed to a single target for the life of the connection." It also offers a fixed IP address per zone, which helps customers who must allow it through a firewall.

Choosing per connection has a catch. HTTP/2 and gRPC send many requests over one long-lived connection, so a layer 4 load balancer sends all of them to one server. The [reverse proxy chapter](/learn/reverse-proxy-and-api-gateway-101#server-side-discovery) notes the same problem in Kubernetes.

### Layer 7

A **layer 7 load balancer** accepts the client's connection itself, reads the full request, picks a server, and sends the request over a separate connection to it. It usually keeps connections to each server open and ready, so it doesn't pay to open one per request.

Because it reads requests, it can route on their contents:

- **By path.** Crumb sends `/search` to servers with extra memory and `/upload` to servers that handle large files.
- **By host name.** `api.crumb.example` and `www.crumb.example` can share one load balancer.
- **By cookie or header.** Beta testers, marked by a cookie, can reach servers running the new version.
- **By sensitivity.** Payment pages can go to a small, locked-down pool.

It can also retry a failed request on another server, add headers, set sticky cookies, and answer some requests itself with a redirect or an error page.

### The trade-off

| | Layer 4 | Layer 7 |
| --- | --- | --- |
| Reads | Addresses and ports | Method, path, headers, cookies, body |
| Picks a server | Once per connection | Once per request |
| Protocols | Any TCP or UDP | HTTP and protocols built on it |
| TLS | Can pass it through | Must decrypt to route |
| Cost per request | Lower | Higher |
| AWS example | Network Load Balancer | Application Load Balancer |

Layer 4 gives up flexibility to use less time and computing power. On modern hardware the gap is often small for web traffic, so many teams default to layer 7 for its features. AWS's [comparison page](https://aws.amazon.com/elasticloadbalancing/features/) suggests its Network Load Balancer when "extreme performance and static IP is needed," and its Application Load Balancer for "flexible application management."

Large sites often use both. GitHub's [2016 post introducing GLB](https://github.blog/engineering/infrastructure/introducing-glb/) describes a tier of layer 4 "director" machines spreading connections across a tier of layer 7 "proxy" machines running HAProxy.

```diagram
title: A layer 4 tier spreads connections. A layer 7 tier reads each request and picks a pool.
[u:client] Users @ 0,1
[l4] Layer 4\nload balancers @ 1,1
[l7] Layer 7\nload balancers @ 2,1
[web] Web pool @ 4,0
[search] Search pool @ 4,1
[up] Upload pool @ 4,2
u -> l4
l4 -> l7 : connections
l7 -> web : everything else
l7 -> search : /search
l7 -> up : /upload
```

## When the load balancer is the problem

Every request to Crumb now passes through the load balancer, which brings three risks:

1. **One load balancer is a single point of failure.** If it dies, every app server is healthy and unreachable.
2. **It can become a bottleneck.** If it lacks CPU, memory or bandwidth, or a setting such as a connection limit or timeout is wrong, every request slows down.
3. **It adds complexity**: one more thing to configure, monitor and upgrade. Running a second one to fix risk 1 adds more.

### Running load balancers in pairs

The fix for risk 1 is more than one load balancer, in one of the two fail-over patterns from the [availability chapter](/learn/availability-101#fail-over-active-passive):

- **Active-passive.** One load balancer handles all traffic while a standby waits. They exchange **heartbeats**, small "I'm alive" messages. Clients use a **virtual IP address** that can move between machines. If heartbeats stop, the standby claims the virtual IP and takes over. HAProxy's architecture guide shows two load balancers sharing an address this way, using a protocol called VRRP and a tool called keepalived.
- **Active-active.** Both handle traffic all the time, spread by DNS or by routers splitting one address across machines. Each needs enough spare capacity to carry everything if the other fails. GitHub's GLB post notes a subtlety: when routers split traffic and one machine leaves, about "1/N connections will get reassigned to the remaining servers," and those break unless the load balancers share connection information.

```diagram
title: Active-passive. The standby takes over the shared virtual IP when heartbeats stop.
[u:client] Users @ 0,0.5
[vip:note] Virtual IP @ 1,0.5
[a] Load balancer 1\n(active) @ 2.5,0
[p] Load balancer 2\n(standby) @ 2.5,1
[app] App servers @ 4,0
u -> vip
vip -> a
vip --> p : on failover
a <-> p : heartbeats
a -> app
```

Managed cloud load balancers handle this redundancy for you. The managed service can still fail, though.

### A real incident: Christmas Eve 2012

On 24 December 2012, part of AWS's load balancing service in its US-East region broke. According to [AWS's summary](https://aws.amazon.com/message/680587/), a maintenance process was run by mistake against the live data describing customers' load balancers. The developer's access was meant to need approval each time, but it "was incorrectly set to be persistent." Part of the data was deleted at 12:24 PM Pacific time.

Load balancers left alone kept working. Ones that were changed or scaled during the event were left misconfigured. At the peak, 6.8% of running load balancers in the region were affected. AWS restored the data from a snapshot overnight and had almost all of them working by 10:30 AM on Christmas Day.

Netflix was hit. In [its write-up](https://web.archive.org/web/20170210200715/http://techblog.netflix.com:80/2012/12/a-closer-look-at-christmas-eve-outage.html), Adrian Cockcroft explained that Netflix used hundreds of load balancers, and "a handful failed." Streaming on TV-connected devices in the US, Canada and Latin America was disrupted, and game consoles were affected for about seven hours. The servers behind them were fine: "our applications continued to respond normally whenever the requests were able to get through."

The lessons for Crumb:

- **Healthy servers behind a broken load balancer are still an outage.** Users can't tell the difference.
- **A managed load balancer is still a dependency that can fail.** Someone else runs it, but it can still break.
- **Configuration changes are risky during an incident.** Here, load balancers broke when they were changed or scaled.

Netflix responded by working toward surviving the loss of a whole region, which is where global load balancing comes in.

## Adding and removing servers safely

Crumb's pool changes daily. Deploys replace servers, and autoscaling adds servers at dinner time and removes them overnight.

**Connection draining** handles removal. The load balancer stops sending a departing server new requests but lets its current ones finish before it shuts down. AWS calls this the **deregistration delay**. It [defaults to 300 seconds](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html) and can be set from 0 to 3,600. Set it a little above your slowest normal request. If Crumb's slowest uploads take 40 seconds, 60 seconds is enough. Long-lived connections, such as WebSockets, may never end by themselves, so the app should ask those clients to reconnect.

**Slow start**, from the routing section, handles the other direction: a fresh server's share of traffic rises gradually while its caches warm up.

## Global load balancing

So far, everything happens inside one region. A load balancer in Virginia can't send a Sydney user to a nearby server, or help if Virginia goes down. **Global load balancing** picks which region a user reaches. The [DNS and CDN chapter](/learn/dns-and-cdn-101) covers both main tools:

- **DNS-based routing** answers each lookup with a region chosen by location, latency or health ([routing policies](/learn/dns-and-cdn-101#dns-routing-policies)). Its weakness is caching: old answers linger until they expire. AWS notes that clients may keep using a removed address until its 60-second time-to-live runs out. See [why DNS failover is slow](/learn/dns-and-cdn-101#why-dns-failover-is-slow).
- **Anycast** announces one IP address from many sites, and internet routing sends each user to the nearest one. A failed site stops announcing, and traffic moves within seconds. See [Anycast routing](/learn/dns-and-cdn-101#anycast-routing-one-address-many-places).

A large site stacks them: DNS or anycast picks the region, a layer 4 tier spreads connections, a layer 7 tier picks a pool, and the servers do the work.

## Horizontal scaling and what it costs

Load balancers make **horizontal scaling** possible: adding more ordinary machines. **Vertical scaling** means replacing one machine with a bigger, pricier one. [Scalability 101](/learn/scalability-101#scaling-up-a-bigger-machine) compares them.

For the app tier, scaling out on commodity machines usually wins:

- **Cost.** Ordinary servers give more capacity per dollar than top-end machines.
- **Availability.** Losing one of ten small servers costs 10% of capacity. Losing your one big server costs all of it.
- **Hiring.** More engineers know common hardware and open-source software than know a particular vendor's enterprise system.

GitHub's own load balancers went this way. Its GLB post describes the old setup as a few large, vertically scaled HAProxy machines, where "scaling horizontally was deemed too difficult." GLB was built to run on commodity hardware and scale out.

Scaling out has three costs.

**1. Complexity.** You need a reliable way to build identical servers and deploy every change to all of them. Scalability 101 covers images, containers and autoscaling.

**2. Servers must be stateless.** If a server keeps a session or an uploaded photo locally, the user's next request may land on a server without it. Keep sessions in a shared database or cache such as Redis, and files in object storage. Choose the session store carefully: Memcached keeps data only in memory, so a restart logs out everyone whose session it held. Redis with persistence turned on, or a database, survives restarts.

**3. Downstream servers see more connections.** Each app server opens its own connections to the cache and database. If each Crumb server keeps 20 database connections, 5 servers need 100 and 50 servers need 1,000. PostgreSQL's [documentation](https://www.postgresql.org/docs/current/runtime-config-connection.html) gives its default limit as "typically 100," and says raising it costs more shared memory. Growing the app tier can exhaust the database's connections even when query volume barely changes. Fixes include a connection pooler that lets many app servers share fewer real connections, smaller pools per server, and sending more reads to the cache and replicas.

## Check yourself

<details>
<summary>Crumb uses round robin across four identical servers. Most requests take 20 ms, but searches take up to 2 seconds. At dinner time one server's latency spikes while the others look fine. What's happening, and what would you change?</summary>

Round robin gives each server the same number of requests regardless of cost. One server has picked up several slow searches by chance, and it keeps getting its full share of new requests on top of them. Switch to a method that sees current load, such as least outstanding requests or the power of two random choices, so new requests avoid the busy server. You could also send `/search` to its own pool with a layer 7 rule, so slow searches can't delay ordinary pages.

</details>

<details>
<summary>An app server crashes. With AWS's default health checks, roughly how long does it keep receiving requests, and how could you shorten that?</summary>

Checks run every 30 seconds, and two failures in a row mark a server down. If it dies just after a passing check, it is marked down about a minute later, and requests sent to it in that minute fail. Shorten it by checking more often (HAProxy's default is every 2 seconds) and adding passive checks that remove a server as soon as real requests to it fail. Retrying failed requests on another server also hides some errors from users.

</details>

<details>
<summary>Crumb wants to send `/upload` to a separate pool and keep TLS certificates off the app servers. Does it need layer 4 or layer 7 load balancing? Why?</summary>

Layer 7. Every request arrives on the same address and port 443, so a layer 4 load balancer can't tell an upload from a recipe view. A layer 7 load balancer reads the path, but to do so it has to decrypt the request, so it terminates TLS. That also keeps the certificate and private key on the load balancer only. If traffic must stay encrypted inside the data center, it can re-encrypt toward the app servers.

</details>

<details>
<summary>Crumb's cache servers sit behind a load balancer that hashes the URL and divides by the number of servers. After a fifth cache server is added, the database is overloaded. Why, and what's the fix?</summary>

Going from four servers to five changes the result of the division for most URLs. Most requests now reach a cache server that doesn't hold their page, miss, and fall through to the database at once. Consistent hashing fixes this: adding a fifth server moves only about a fifth of the keys, and the rest keep hitting the server that already caches them.

</details>

<details>
<summary>A teammate says, "Our load balancer is a managed cloud service, so it can't be a single point of failure." How would you respond?</summary>

A managed load balancer is usually redundant within a region, so one machine dying won't take it down. It is still one dependency for the whole site. In December 2012, AWS's load balancing service lost configuration data and some customer load balancers in one region failed for hours, including several Netflix used, while the servers behind them were healthy. Plan for it with more than one region behind global load balancing, few configuration changes during incidents, and monitoring from outside the load balancer so you can tell "servers are down" from "nothing can reach them."

</details>

## Further reading

Background and classics:

- [Load balancing (computing), Wikipedia](https://en.wikipedia.org/wiki/Load_balancing_(computing)): a broad overview of algorithms and approaches.
- [HAProxy architecture guide (1.2)](http://www.haproxy.org/download/1.2/doc/architecture.txt): Willy Tarreau's 2008 working configurations for cookie persistence, a VRRP pair of load balancers, and layer 4 load balancers in front of HAProxy. Old, but the patterns still apply.
- [Inside NGINX: How We Designed for Performance & Scale](https://web.archive.org/web/20221128230738/https://www.nginx.com/blog/inside-nginx-how-we-designed-for-performance-scale/): how NGINX's event-driven design handles hundreds of thousands of connections. Archived copy, since the original now redirects.
- [What is layer 4 load balancing?](https://web.archive.org/web/20240117134735/https://www.nginx.com/resources/glossary/layer-4-load-balancing/) and [What is layer 7 load balancing?](https://web.archive.org/web/20220517230652/https://www.nginx.com/resources/glossary/layer-7-load-balancing/): NGINX's short definitions of the two layers, as archived copies.
- [Round robin vs weighted round robin](https://g33kinfo.com/info/round-robin-vs-weighted-round-robin-lb/): a short 2010 explanation of how weights share load across servers of different sizes.
- [Scalability for Dummies, part 1: clones](https://web.archive.org/web/20220530193911/https://www.lecloud.net/post/7295452622/scalability-for-dummies-part-1-clones): Sebastian Kreutzberger's 2011 case for servers that keep no user data.

Real configuration and products:

- [HAProxy configuration manual](https://www.haproxy.org/download/2.8/doc/configuration.txt): the `balance` section explains each algorithm and when to use it. See `fall`, `rise`, `inter` and `slowstart` for health checks.
- [NGINX load balancing guide](https://nginx.org/en/docs/http/load_balancing.html): round robin, least connections, IP hashing, weights and passive health checks in a few short examples.
- [Classic Load Balancer listeners](https://docs.aws.amazon.com/elasticloadbalancing/latest/classic/elb-listener-config.html): AWS on TCP versus HTTP listeners, TLS termination, `X-Forwarded-For` and the proxy protocol.
- [What is a Network Load Balancer?](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/introduction.html) and [Application Load Balancer target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html): a real layer 4 and layer 7 load balancer, including algorithms, draining, slow start and stickiness.
- [ALB health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html): default timings and the fail-open rule.
- [Elastic Load Balancing features](https://aws.amazon.com/elasticloadbalancing/features/): AWS's comparison of its load balancer types.
- [PostgreSQL connection settings](https://www.postgresql.org/docs/current/runtime-config-connection.html): `max_connections` and why raising it costs memory.

Research and real systems:

- [The Power of Two Random Choices](https://www.eecs.harvard.edu/~michaelm/postscripts/handbook2001.pdf): Mitzenmacher, Richa and Sitaraman's survey. The introduction is readable without the maths.
- [Maglev](https://research.google/pubs/maglev-a-fast-and-reliable-software-network-load-balancer/): Google's NSDI 2016 paper on a software network load balancer at Google's scale.
- [Introducing the GitHub Load Balancer](https://github.blog/engineering/infrastructure/introducing-glb/): GitHub's move from a few big HAProxy machines to layer 4 and layer 7 tiers on commodity hardware.
- [AWS's summary of the December 24, 2012 ELB event](https://aws.amazon.com/message/680587/) and [Netflix's view of the same outage](https://web.archive.org/web/20170210200715/http://techblog.netflix.com:80/2012/12/a-closer-look-at-christmas-eve-outage.html): one incident seen from the provider's side and the customer's side.
