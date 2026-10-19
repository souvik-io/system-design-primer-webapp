# DNS and CDNs

This chapter answers seven questions:

- How does a browser turn a name like `www.crumb.example` into the address of a server?
- Where are DNS answers cached, and why do record changes take a while to reach everyone?
- Which DNS records will you set up, and what does each one do?
- How can DNS send different users to different servers, and why is it a slow way to fail over?
- What does relying on DNS cost you, and what happens when a DNS provider is attacked?
- What is a CDN, how does content get onto it, and how long does it stay there?
- How do HTTP headers control caching, and how do you clear out old copies?

We'll keep using **Crumb**, the recipe-sharing site from [Scalability 101](/learn/scalability-101). Crumb runs several app servers behind a load balancer in one data center in Virginia. Recipe photos live in object storage. Crumb's users are spread across the world, from Sydney to London.

Before a Crumb page appears, two things have to happen. First, the browser has to find out where Crumb's servers are. The **Domain Name System (DNS)** does that. Second, the page's HTML, scripts and photos have to travel to the user. A **content delivery network (CDN)** shortens that trip by serving copies from a server near the user. This chapter covers both, in that order.

## How DNS works

Computers on the internet find each other by **IP address**, a number such as `203.0.113.10` (IPv4) or `2001:db8::10` (IPv6). People remember names such as `www.crumb.example` much more easily. The **Domain Name System (DNS)** translates a domain name into an IP address. (The addresses and the `.example` names in this chapter are reserved for documentation, so they don't point anywhere real.)

There is no single database that holds every name. DNS is a **hierarchy**, shaped like a tree:

- At the top are the **root servers**. They know who runs each **top-level domain (TLD)**, such as `.com`, `.org` or `.uk`.
- Below them are the **TLD servers**. The `.com` servers know who runs each domain under `.com`.
- At the bottom are each domain's **authoritative nameservers**. These hold the domain's actual records, such as the IP address for `www.crumb.example`.

Each level only has to know about the level directly below it. That is what lets DNS grow to billions of names without one server knowing them all.

The top of the tree is small. [IANA's list of root servers](https://www.iana.org/domains/root/servers) shows 13 named root servers, `a.root-servers.net` through `m.root-servers.net`, run by 12 organizations. Each of the 13 names is served by many machines in many countries. In October 2026, [root-servers.org](https://root-servers.org/) counted more than 2,000 running copies.

```diagram
title: The 4-step recursive DNS resolution flow
[client:client] Client @ 0,1
[res] Recursive\nresolver @ 1.5,1
[root:store] Root server\n(".") @ 3.5,0
[tld:store] TLD server\n(".com") @ 3.5,1
[auth:store] Authoritative\nserver @ 3.5,2
client <-> res : 1. api.example.com?
res <-> root : 2. referral to .com
res <-> tld : 3. referral to NS
res <-> auth : 4. A record + TTL
```

### Finding a DNS server to ask

Your laptop doesn't walk the tree itself. It sends each question to one **recursive resolver**, a DNS server whose job is to find answers on behalf of clients.

Your router or ISP tells your device which resolver to use. When a laptop joins a network, it gets its IP address through **DHCP** (see [how DHCP works](/learn/protocols-and-apis#broadcast-and-why-dhcp-needs-it)). The same DHCP reply can include a list of DNS servers. [RFC 2132](https://www.rfc-editor.org/rfc/rfc2132) defines this as the "domain name server option", option code 6. On a home network, that list usually names the router or the ISP's resolver. You can also set a public resolver by hand, such as Cloudflare's `1.1.1.1` or Google's `8.8.8.8`.

### The resolution flow, step by step

Before anything goes on the network, the browser checks its own DNS cache. Then it asks the operating system, which has a cache too. Only on a miss does the query leave the machine. Then:

1. **Client to recursive resolver.** The operating system sends the question to the recursive resolver. The resolver answers from its own cache if it can.
2. **Resolver to a root server.** On a cache miss, the resolver asks a **root server**. The root doesn't know `api.example.com`. It replies with a **referral**: the names of the nameservers for `.com`.
3. **Resolver to the TLD server.** The resolver asks a `.com` **TLD server**. It replies with another referral: the **NS records** for `example.com`. These name the domain's authoritative nameservers, at a DNS host such as Route 53 or Cloudflare, and usually include their IP addresses.
4. **Resolver to the authoritative server.** The resolver asks one of those nameservers, which holds the domain's real records. It answers with the **A record** for `api.example.com` and a **time to live (TTL)**, say 300 seconds.

The resolver caches the answer and returns it to the client. The operating system hands the address to the browser, which opens a TCP connection (and usually a TLS session) to that address.

In practice, the resolver rarely walks the whole path. The root and `.com` referrals have TTLs of a day or more, so a busy resolver already has them cached. Most lookups are a single trip to the authoritative server, or no trip at all.

### Caching, TTLs and "propagation"

Every DNS answer comes with a **time to live (TTL)**, a number of seconds. The TTL tells everyone who receives the answer how long they may keep reusing it before asking again.

Answers are cached at several layers. The browser caches them, the operating system caches them, and the recursive resolver caches them for all of its users. A lookup stops at the first cache that holds an answer whose TTL hasn't run out.

```diagram
title: A lookup stops at the first cache with a fresh answer.
[b:client] Browser\ncache @ 0,0
[os] Operating\nsystem cache @ 1.3,0
[r] Resolver\ncache @ 2.6,0
[auth:store] Authoritative\nserver @ 4,0
b -> os : miss
os -> r : miss
r -> auth : miss
```

Caching makes DNS fast, but it also means old answers linger. Suppose Crumb moves `www.crumb.example` to a new load balancer and changes its A record. The authoritative server returns the new address at once. Resolvers that cached the old address keep handing it out until their copy's TTL expires. Users of those resolvers still reach the old server.

People call this delay **DNS propagation**, but nothing is actually pushed out. Each cache simply holds the old answer until it expires. With a TTL of one day, the change can take up to a day to reach everyone.

A common habit follows from this. Before a planned change, lower the record's TTL, say to 60 seconds. Then wait at least as long as the old TTL, so every cache has picked up the short one. After that, the real change reaches almost everyone within a minute. Once things are stable, raise the TTL again, because a longer TTL means fewer lookups.

### DNS record types you'll actually use

A **record** is one entry in a domain's DNS data. Each record has a name, a type, a value and a TTL. These are the types you will meet most often, shown with Crumb's records:

| Type | What it does | Example |
|---|---|---|
| **A** (address) | Points a name to an IPv4 address. | `www.crumb.example → 203.0.113.10` |
| **AAAA** | Points a name to an IPv6 address. | `www.crumb.example → 2001:db8::10` |
| **CNAME** (canonical name) | Makes one name an alias of another name. The resolver then looks up the target. Not allowed at the zone apex (`crumb.example` itself). | `img.crumb.example → d123.cloudfront.net` |
| **ALIAS / ANAME** | A provider-specific feature that acts like a CNAME at the apex. The DNS host looks up the target itself and answers with plain A/AAAA records. | `crumb.example → d123.cloudfront.net` |
| **NS** (name server) | Names the authoritative DNS servers for a domain or subdomain. | `crumb.example → ns1.dns-host.net` |
| **MX** (mail exchange) | Names the mail servers that accept email for the domain, with a priority. Lower numbers are tried first. | `crumb.example → 10 mail.crumb.example` |
| **TXT** | Free text. Used for domain-ownership checks and email authentication (SPF, DKIM, DMARC). | `v=spf1 include:_spf.google.com ~all` |
| **SRV** | Gives the host and port for a named service. Used by SIP, XMPP and some service-discovery systems. | `_sip._tcp.example.com → 10 60 5060 sip.example.com` |

The SRV example reads: priority 10, weight 60, port 5060, on host `sip.example.com`.

**How a CNAME resolves.** A CNAME can point to a name that has an A record, or to another CNAME. The resolver follows the chain until it reaches an A or AAAA record, then returns the address. For example, `img.crumb.example` is a CNAME for the CDN's hostname `d123.cloudfront.net`. The resolver looks up that name next, and the CDN's DNS answers with an address.

A common use is to make two names lead to the same site: `www.crumb.example` can be a CNAME for `crumb.example`, which has the A record. The reverse, making the bare `crumb.example` a CNAME for `www.crumb.example`, is the case DNS forbids, because of the apex rule in the table.

**ALIAS** is the record beginners trip over. CDNs and cloud load balancers give you a hostname, not a fixed IP, because their IPs change. For `www` you just add a CNAME to that hostname. For the bare `crumb.example` you can't, so you use whatever your DNS host offers instead. Route 53 calls it an alias record, Cloudflare calls it CNAME flattening, and DNSimple and others call it ALIAS or ANAME. The check-yourself section below explains why the apex rule exists.

## Anycast routing: one address, many places

How can `1.1.1.1` answer quickly in Sydney and in São Paulo? The answer is that many servers share that one address.

With ordinary **unicast** addressing, an IP address belongs to one network location. If a user in Tokyo talks to a server in Virginia, every packet crosses the Pacific and North America. The round trip takes around 150 ms before the server does any work.

With **Anycast**, the same block of IP addresses is announced from many data centers at once. The announcements use the **Border Gateway Protocol (BGP)**, the protocol networks use to tell each other which addresses they can reach. Each router on the internet picks what it considers the best route to those addresses, which usually leads to a nearby site. So users in different cities send packets to the same address but land in different buildings.

```diagram
title: Anycast sends each client to a nearby site announcing the same IP
[c1:client] Client in Tokyo @ 0,0
[c2:client] Client in London @ 0,2
[edge1] Tokyo edge\n198.51.100.1 @ 1.5,0
[edge2] London edge\n198.51.100.1 @ 1.5,2
[origin:store] Origin\n(Virginia) @ 3,1
c1 -> edge1 : a few ms
c2 -> edge2 : a few ms
edge1 --> origin : cache miss
edge2 --> origin : cache miss
```

Four things to know about Anycast:

- **"Nearby" means nearby in routing terms.** BGP picks routes by policy and by the number of networks along the path. It doesn't measure kilometers. Usually you land at a close site, but sometimes an ISP's links send you to one farther away.
- **It suits short exchanges best.** A DNS query is one UDP packet each way, so it doesn't matter if a route changes between queries. CDNs also run TCP over Anycast. Routes are stable enough that this works well. Still, a route change in the middle of a connection can send packets to a different site that knows nothing about the connection, and the connection then has to be reset.
- **It spreads attacks out.** A large DDoS attack aimed at an Anycast address comes from bots all over the world. Each bot's traffic goes to the site nearest to it. The flood is split across every location instead of landing on one link.
- **Failover is a route change.** If a site goes down, it stops announcing the addresses, and routers send traffic to the next-best site. BGP settles on the new routes within seconds, much faster than waiting for DNS caches to expire.

## DNS routing policies

Few companies run their own authoritative nameservers. Most rent them from a **managed DNS service**, such as [Amazon Route 53](https://aws.amazon.com/route53/), [Cloudflare DNS](https://www.cloudflare.com/dns/) or NS1. You edit your records through a dashboard or an API, and the provider runs the servers around the world.

Many managed DNS services can also return different answers to different users. That turns DNS into a coarse traffic manager that chooses which data center a user reaches. Suppose Crumb opens a second data center in Oregon. These are the main ways DNS can split users between Virginia and Oregon.

### Weighted round robin

**Round robin** means handing out addresses in turn: the first lookup gets Virginia, the next gets Oregon, and so on. **Weighted round robin** gives each answer a share of lookups in proportion to a weight you set. [Route 53's weighted routing](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-weighted.html) works this way: each record gets "a relative weight", and its share of traffic is its weight divided by the total. (The [load balancing chapter](/learn/load-balancing#round-robin-weighted-round-robin-and-random) covers the same idea inside one data center.)

Weights help in three common situations:

1. **Taking servers out for maintenance.** Route 53's guide says that to "stop sending traffic to a resource, change the weight for that record to 0." Crumb sets Oregon's weight to 0 before upgrading it, and new lookups all go to Virginia.
2. **Balancing clusters of different sizes.** If Virginia has six app servers and Oregon has three, weights of 2 and 1 send each data center traffic in proportion to its capacity.
3. **A/B testing and canary releases.** Route 53's guide suggests weights of 1 and 255 to send "a tiny part of your traffic" to one resource: 1/256 of lookups. Crumb can point that slice at servers running a new version, watch for errors, and raise the weight step by step.

Remember that weights apply to DNS lookups. One lookup can stand for one user or for thousands of users behind the same resolver, so the real split of traffic is approximate.

### Latency-based routing

**Latency-based routing** answers each lookup with the data center that is fastest for the user. [Route 53's version](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-latency.html) keeps its own measurements of latency between users' networks and AWS regions. When a query arrives, it "finds which Region gives the user the lowest latency" and returns that region's record.

These measurements change over time. Route 53's guide notes that a user routed to Oregon this week might go to another region next week, as internet routes change.

### Geolocation-based routing

**Geolocation routing** answers based on where the user appears to be. [Route 53's guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-geo.html) lists three uses: showing content in the user's language, limiting content to places where you have the rights to distribute it, and keeping each location's traffic on a predictable endpoint. A company might also send European users to an EU data center to keep their data there.

The location is a guess. The DNS service usually sees the resolver's IP address, not the user's. Some resolvers also send part of the user's own address (the EDNS Client Subnet extension), which improves the guess. Some IP addresses can't be mapped to any location at all. For those, Route 53 lets you create a default record, and without one it returns "no answer".

### Health checks and failover

The DNS service probes each endpoint, for example by requesting a page every 30 seconds. When the checks fail, it stops handing out that endpoint's address. If Virginia goes dark, new lookups for `www.crumb.example` return only Oregon.

That sounds like instant failover. It isn't, as the next section explains.

### Why DNS failover is slow

DNS failover works, but it is slow and uneven, because several delays add up.

```text
time to detect   = check interval × failures needed
                   e.g. 30 s × 3 = about 90 s
time to recover  = time to detect + record TTL + extra client caching
                   e.g. 90 s + 60 s + (seconds to hours)
```

- **Detection.** Health checkers need a few failed probes in a row before they declare an endpoint dead, to avoid flapping. That alone is often a minute or more.
- **TTL.** Resolvers that already cached the old answer keep using it until the TTL runs out. A 60-second TTL bounds this for resolvers that honor it.
- **Caches that don't follow the rules.** Some resolvers enforce a minimum TTL. Some applications cache lookups for as long as they run. Some embedded devices barely look names up again at all. You can't control any of them.
- **Open connections.** DNS only matters when a client opens a new connection. A browser or app holding a keep-alive connection, or a pool of database connections, keeps talking to the old address until that connection breaks.

You can't fix this by making the TTL tiny. Every expiry means another round of lookups, more load on your DNS provider, and a little more latency for users.

The usual approach is to use DNS to spread users across several healthy data centers that are all serving traffic (**active-active**, see [availability 101](/learn/availability-101#fail-over-active-active)). Fast failover then happens below DNS. Inside a data center, load balancers take a dead server out of rotation within seconds (see [health checks](/learn/load-balancing#health-checks)). Across sites, an Anycast front end withdraws a failed location's route, again within seconds. DNS changes then cover the slow, rare cases, such as draining a whole data center for maintenance.

## The costs and risks of DNS

DNS is so basic that it's easy to forget it is a system with its own costs. There are three to keep in mind.

**Each lookup adds a delay.** A browser can't connect to a server until it knows the server's address. On a cache miss, the lookup costs at least one round trip to the resolver, plus whatever trips the resolver makes to authoritative servers. A page that loads files from several hostnames, such as `www`, `img` and `api`, may need a lookup for each. The caching described earlier hides most of this cost, because repeat lookups are answered from a cache.

**DNS servers are complex to run, and a few large organizations run the core.** The root servers are run by 12 organizations. [IANA's list](https://www.iana.org/domains/root/servers) includes US government bodies (NASA, the US Department of Defense and the US Army Research Lab), universities such as the University of Southern California and the University of Maryland, and companies such as Verisign and Cogent. Each TLD has its own operator, and [IANA's record for `.com`](https://www.iana.org/domains/root/db/com.html) names VeriSign Global Registry Services as its manager. Below that, most resolvers are run by ISPs and large companies. Most sites, Crumb included, don't run DNS servers at all. They rent them from a managed DNS service, which means they depend on that provider staying up.

**DNS providers are targets for attack.** If attackers knock out a site's DNS provider, the site's own servers can be perfectly healthy and still unreachable. Browsers can't find them without knowing their IP addresses. The next section describes the best-known case.

### A real attack: Dyn, October 21, 2016

Dyn was a managed DNS provider that hosted the authoritative DNS for many large websites. On Friday, October 21, 2016, it was hit by two large DDoS attacks against its DNS servers. A **DDoS (distributed denial-of-service) attack** floods a target with junk traffic from many machines at once, so real requests can't get through.

[Dyn's own analysis](https://web.archive.org/web/20180105214552/https://dyn.com/blog/dyn-analysis-summary-of-friday-october-21-attack/), published five days later, gives the timeline and causes:

- The first attack ran from about 11:10 to 13:20 UTC. The second ran from about 15:50 to 17:00 UTC, with "residual impact" until about 20:30 UTC.
- The attack traffic was floods of TCP and UDP packets to port 53, the DNS port.
- Dyn confirmed the **Mirai botnet** as the main source. A botnet is a network of hijacked devices. Dyn's estimate at the time was "up to 100,000 malicious endpoints".
- Real resolvers made it worse. As their cached answers expired, they kept retrying, creating "10-20X normal traffic volume".

The people who felt it were users of Dyn's customers. [TechCrunch reported](https://techcrunch.com/2016/10/21/many-sites-including-twitter-and-spotify-suffering-outage/) that Twitter, SoundCloud, Spotify, Shopify and other sites "have been inaccessible to many users throughout the day", and also named GitHub, Airbnb, Reddit and Heroku. Those sites' servers were running. Users simply couldn't look up their IP addresses, and almost nobody knows Twitter's IP address by heart.

The lesson for design is that your DNS provider is part of your availability. Some sites run their DNS with two providers at once, so an outage at one doesn't take them offline. For another case where DNS took a whole company offline, see [Facebook's 2021 outage](/learn/availability-101#facebook-october-4-2021-redundant-dns-one-shared-rule).

## Content delivery networks

A **content delivery network (CDN)** is a network of proxy servers spread across the globe. It serves content from locations closer to the user. Each server is a caching **reverse proxy**: it sits in front of your servers and answers requests on their behalf (see [reverse proxies](/learn/reverse-proxy-and-api-gateway-101#forward-proxy-vs-reverse-proxy)). The CDN's data centers are called **points of presence (PoPs)**. Your own servers, or the storage bucket the CDN copies from, are called the **origin**.

Here is what happens when a Crumb user in Sydney opens a recipe:

1. The page refers to the photo as `https://img.crumb.example/pancakes.jpg`.
2. `img.crumb.example` is a CNAME for the CDN's hostname. The CDN's DNS answers with the address of a nearby PoP, or with an Anycast address that routing takes to a nearby PoP. Either way, the site's DNS resolution tells the client which server to contact.
3. The browser asks the Sydney PoP for the photo.
4. If the PoP has a fresh copy (a **cache hit**), it answers at once. The request never leaves Australia.
5. If it doesn't (a **cache miss**), the PoP fetches the photo from Crumb's origin in Virginia, keeps a copy, and answers. The next Sydney user gets the copy.

[Amazon CloudFront's documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html) describes the same flow: each request "is routed to the edge location that provides the lowest latency", which answers from its copy or retrieves the file from the origin.

### What a CDN serves

CDNs mostly serve **static files**: files that are the same for every user, such as HTML, CSS, JavaScript, photos and videos. These are easy to cache, because one copy can serve everyone.

Some CDNs also carry **dynamic content**, meaning responses built for each request, such as a logged-in user's feed. CloudFront's documentation says it speeds up "static and dynamic web content". These responses can't be cached, so the gain comes from the connection instead. [CloudFront's pricing page](https://aws.amazon.com/cloudfront/pricing/) explains that for "dynamic, uncacheable workloads like APIs", it finishes the TLS handshake close to the user and "maintains persistent connections to your origin". The slow connection setup happens over a short distance, and the long trip to the origin reuses a connection that is already open.

### Why a CDN makes a site faster

A CDN improves performance in two ways:

1. **Users receive content from data centers close to them.** The bytes travel a shorter distance, so pages load sooner. See [latency and throughput](/learn/performance-and-latency-101#latency-and-throughput) for why distance matters.
2. **Your servers don't have to serve the requests the CDN fulfills.** One copy at a PoP can serve thousands of users, and the origin never sees those requests. That saves bandwidth, CPU and money at the origin.

It also adds some protection. The CDN absorbs traffic spikes and attacks before they reach you (see [edge security](/learn/security-101#edge-waf-and-api-gateway)).

How much origin traffic a CDN saves depends on its **cache hit ratio**, the share of requests answered from a cached copy. It ranges from over 95% for static files with long lifetimes to near zero for personalized API responses.

### Push CDNs

There are two ways to get your content onto a CDN. With a **push CDN**, you send content to the CDN yourself whenever it changes on your server.

- **You take full responsibility for the content.** You upload files directly to the CDN's storage, through an API or a sync tool. You also rewrite the URLs on your pages to point at the CDN.
- **You decide when content expires and when it is updated.** Nothing changes on the CDN unless you upload or delete it.
- **Content is uploaded only when it is new or has changed.** That keeps traffic between your servers and the CDN to a minimum. The cost is storage: every file you push sits on the CDN, whether anyone requests it or not.

Push CDNs work well for sites with little traffic, and for content that isn't updated often. The content is placed on the CDN once. It isn't fetched again and again at regular intervals. Large files that you release on purpose are a good fit, such as installers, game patches and a video library. Crumb, for example, could push its cooking-course videos. They are large, they change rarely, and Crumb knows exactly when a new one is published.

### Pull CDNs

With a **pull CDN**, the CDN fetches content from your server the first time a user requests it.

- **You leave the content on your server.** You only rewrite your URLs to point at the CDN.
- **The first request is slower.** Until a PoP has cached a file, the first user to ask for it waits while the PoP fetches it from the origin. Each PoP pays this cost separately.
- **A TTL decides how long a copy stays.** When the TTL runs out, the PoP fetches the file again (or asks the origin whether it changed, as described under [revalidation](#revalidation-with-etag)).

Pull CDNs keep storage on the CDN small, because only files that someone requested are kept. They can create **redundant traffic**, though. If a file expires and is pulled again before it has actually changed, the origin sends the same bytes a second time. Crumb's stylesheet with a one-hour TTL is fetched from the origin every hour at every PoP, even if it hasn't changed for months.

Pull CDNs work well for sites with heavy traffic. The load on the origin is spread out evenly, and only recently requested content stays on the CDN. Crumb's recipe photos are a good example. There are millions of them, a few thousand are popular at any moment, and a pull CDN keeps only those.

### Push vs pull compared

| Model | How content gets there | Good for | Trade-offs |
|---|---|---|---|
| **Pull (origin pull)** | The CDN fetches from the origin on demand, the first time a PoP is asked for something it doesn't have, then caches it until its TTL runs out. | High-traffic sites, websites and static files, cacheable API responses, most video. | The first request at each PoP is a miss and pays the trip to origin. Expired files may be fetched again unchanged. Almost no work for you. |
| **Push** | You upload content to the CDN's storage ahead of time, and again whenever it changes. | Low-traffic sites, content that rarely changes, large files you release on purpose. | You manage uploads and deletes yourself, and you pay to store files even if no one requests them. |

Most sites use pull. It needs no extra workflow: point the CDN at the origin and set cache headers.

### Tiered caching and origin shield

Picture a product launch. A new page goes live, and within the same second, PoPs on every continent get their first request for it. Each one misses, and each one asks the origin. With hundreds of PoPs, that's hundreds of identical requests hitting the origin at once. This is called a **thundering herd**, or cache stampede (see [cache stampede](/learn/cache-101#cache-stampede-thundering-herd) for the same problem in an application cache). For an expensive page, it can overload the origin and the database behind it.

CDNs prevent this with **tiered caching**. Edge PoPs don't go to the origin directly. They go to a parent tier first. With an **origin shield**, that parent is one chosen PoP, usually close to the origin, and every miss passes through it.

```diagram
title: Tiered caching with an origin shield
[c1:client] Users in NY @ 0,0
[c2:client] Users in Boston @ 0,2
[edge1] Edge PoP\n(New York) @ 1,0
[edge2] Edge PoP\n(Boston) @ 1,2
[shield] Origin shield\n(parent PoP) @ 2,1
[orig:store] Origin @ 3,1
c1 -> edge1
c2 -> edge2
edge1 -> shield : miss
edge2 -> shield : miss
shield -> orig : one fetch
```

1. The New York and Boston edge PoPs both miss on the same object.
2. Each asks the shield instead of the origin.
3. If the shield has the object, it answers both. If not, it **collapses** the concurrent requests into one fetch to the origin, caches the result, and answers both edges.

The origin sees one request per object per shield, instead of one per PoP. The shield's cache is also bigger and warmer than any single edge's, so the overall hit ratio goes up. The cost is an extra hop on misses. That matters little compared with every PoP going all the way to the origin.

### The downsides of a CDN

A CDN has three main costs.

**It can be expensive.** CDNs charge for the data they deliver and the requests they handle, so the bill grows with traffic. Weigh it against what you would pay without one: more origin servers, and more bandwidth out of your own data center. Some providers also cut the origin's costs. [CloudFront's pricing page](https://aws.amazon.com/cloudfront/pricing/) says that data transfer "between CloudFront and your AWS origins is automatically waived".

**Content can be stale.** If you update a file before its TTL runs out, the CDN keeps serving the old copy until the TTL expires. A Crumb editor fixes a typo in a recipe, and users keep seeing the typo for an hour. The [cache invalidation strategies](#cache-invalidation-strategies) below are the ways around this.

**URLs have to change.** With either push or pull, the URLs for static content must point at the CDN. Crumb changes `https://www.crumb.example/photos/pancakes.jpg` to `https://img.crumb.example/pancakes.jpg` in every page and template. Some CDNs avoid this by sitting in front of the whole domain. With a [proxied record in Cloudflare](https://developers.cloudflare.com/dns/proxy-status/), for example, traffic for the existing name "routes through Cloudflare's network", so the URLs stay the same. The trade is that every request now passes through the CDN.

## HTTP caching headers

The origin controls caching with response headers. The CDN and the browser both read them. The current definition is RFC 9111.

### Cache-Control directives

- `public`: any cache may store the response, including shared caches like a CDN.
- `private`: only the user's own browser may store it. Shared caches must not. Use it for pages specific to one user, like an account page.
- `no-cache`: caches may store the response, but must **revalidate** it with the origin before every use. The name is misleading: it allows caching.
- `no-store`: don't store the response anywhere. Use it for sensitive responses like bank statements.
- `max-age=N`: the response is fresh for N seconds, in the browser and in shared caches.
- `s-maxage=N`: like `max-age`, but only for shared caches, where it takes precedence over `max-age`. This lets you cache briefly in browsers, where you can't purge, and for much longer on the CDN, where you can:

  ```http
  Cache-Control: public, max-age=60, s-maxage=86400
  ```

  Browsers keep this for 1 minute. The CDN keeps it for 86,400 s = **24 hours**.

- `stale-while-revalidate=N` (RFC 5861): once the response goes stale, a cache may keep serving the stale copy for up to N more seconds while it fetches a fresh one in the background. Users get a fast cached answer instead of waiting on the origin. The price is that they may see content that is a little out of date.
- `stale-if-error=N` (also RFC 5861): if the origin returns an error or can't be reached, a cache may serve a stale copy for up to N seconds instead of the error.

CDNs differ in which of these they honor. Most also let you override the origin's headers with their own rules, so check your provider's documentation.

### Revalidation with ETag

When a cached copy goes stale, a cache doesn't have to download it again. The origin sent an `ETag` with the original response. An ETag is a version identifier for that content. The cache asks the origin whether that version is still current:

```http
GET /styles.css HTTP/1.1
Host: www.example.com
If-None-Match: "33a64df551425f"
```

If nothing changed, the origin answers `304 Not Modified` with no body, and the cache marks its copy fresh again. This saves the bandwidth, though not the round trip. It also softens the redundant traffic of pull CDNs: an unchanged file costs a tiny 304 reply instead of the whole file. `Last-Modified` and `If-Modified-Since` do the same job with a timestamp instead of a version tag.

## Cache invalidation strategies

Phil Karlton's line that "there are only two hard things in computer science: cache invalidation and naming things" is a joke with truth in it. Once a CDN has a copy, you need a way to replace it when the origin changes. There are four main options.

1. **Content-hashed filenames (cache busting).** Put a hash of the file's contents in its name, like `bundle.8f2a9b.js`. A changed file gets a new name, so it's a new URL, and nothing old needs removing. These files can then be cached for a year with `Cache-Control: public, max-age=31536000, immutable`. The catch is the HTML page that refers to them. It must have a short lifetime or be purged, or users keep receiving the old page that points at the old bundle. Build tools do the hashing for you. This is the standard approach for JavaScript, CSS and images.
2. **Purge by URL.** Call the CDN's API to remove a specific path from every PoP. Depending on the vendor, it takes from a few seconds to a few minutes to spread. It works for a handful of known URLs. It gets awkward when one change affects many URLs.
3. **Purge by tag (surrogate keys).** The origin labels each response with tags in a header, such as Fastly's `Surrogate-Key` or Cloudflare's `Cache-Tag`:

   ```http
   Surrogate-Key: product-142 category-electronics
   ```

   When product 142's price changes, you purge the tag `product-142`. The CDN drops every cached object carrying it: the product page, its JSON API response, the category listings that show it, and a search results page. The origin doesn't need to know which URLs those were. The CDN strips the header before the response reaches users.
4. **Soft purge.** Some CDNs, Fastly among them, can mark objects stale instead of deleting them. The next request triggers a refresh. If the origin is down, `stale-if-error` lets the CDN keep serving the old copy. You get updated content when the origin is healthy and the old content when it isn't. That is usually better than an error page.

## Edge compute

Most big CDNs now let you run your own code inside their PoPs: Cloudflare Workers, Fastly Compute, and on AWS, CloudFront Functions and Lambda@Edge. The code runs in the PoP that received the request, so it can make decisions without a round trip to the origin. Typical uses:

- **A/B testing.** Read a cookie, assign the user to a variant, and rewrite the request to the matching cached version, with no redirect.
- **Auth and geofencing at the edge.** Verify a JWT signature, or block countries you don't serve, so bad requests are rejected before they reach your network. See [security 101](/learn/security-101) for how JWTs are verified.
- **Image optimization.** Resize and crop images on demand. Convert them to WebP or AVIF when the browser's `Accept` header says it supports them.
- **Light personalization.** Insert the user's region, currency or language into an otherwise cached page.

The limits are tight compared with a normal server. Each request gets little CPU time and memory. There is usually no fast access to your main database, which lives in one region. Edge code works best when everything it needs is in the request itself, or in a small replicated store the platform provides.

## Check yourself

<details>
<summary>Crumb changes the A record for www.crumb.example to a new server. The record's TTL is one day. Why do some users still reach the old server the next morning, and what should Crumb have done differently?</summary>

Resolvers, operating systems and browsers that looked up the name before the change cached the old address. Each of them may keep using it until its copy's TTL runs out, which can be up to a day. Nothing pushes the new answer to them. They only see it when their cached copy expires and they ask again. That delay is what people call DNS propagation.

Crumb should have lowered the TTL first, for example to 60 seconds, then waited at least a day so every cache held the short TTL. After that, the change would have reached almost everyone within a minute or so.

</details>

<details>
<summary>Why can't you put a CNAME at the zone apex (example.com), and how do DNS providers work around it?</summary>

The DNS rules (RFC 1034, restated in RFC 1912) say a name with a CNAME record can't have any other records. A CNAME means "this name is really that other name, look there for everything". The apex of a zone must have an SOA record and NS records. So a CNAME at `example.com` would conflict with records that are required to be there.

Providers work around it inside their authoritative servers. You configure the apex to point at a hostname such as `d123.cloudfront.net`, using Route 53's alias records, Cloudflare's CNAME flattening, or an ALIAS/ANAME record elsewhere. When a resolver asks for `example.com`, the provider looks up the target itself and answers with ordinary A/AAAA records. Resolvers only ever see standard records, so nothing breaks.

</details>

<details>
<summary>Crumb's Virginia data center has six app servers and Oregon has three. Give DNS weights that match their capacity, and say how Crumb would use weights to take Oregon down for maintenance and to test a new version.</summary>

Weights of 2 for Virginia and 1 for Oregon send about two thirds of lookups to Virginia and one third to Oregon, matching six servers to three.

For maintenance, Crumb sets Oregon's weight to 0, so new lookups go only to Virginia. It waits for cached answers to expire before taking Oregon down.

To test a new version, Crumb adds a record for servers running it with a small weight, such as 1 against 255, so about 1 in 256 lookups reach it. It raises the weight step by step if error rates stay normal. The split is approximate, because one lookup can stand for many users behind the same resolver.

</details>

<details>
<summary>In October 2016, many people couldn't open Twitter, even though Twitter's own servers were running. Why?</summary>

Twitter's authoritative DNS was hosted by Dyn, and Dyn's DNS servers were under a large DDoS attack, mostly from the Mirai botnet. Once resolvers' cached answers for Twitter expired, they couldn't get fresh ones from Dyn. Browsers couldn't find Twitter's IP addresses, so they couldn't connect, even though Twitter's servers were healthy. Almost nobody knows a site's IP address by heart. Resolvers retrying their lookups also added to the flood. The design lesson is that your DNS provider is part of your availability, which is why some sites use two DNS providers.

</details>

<details>
<summary>Crumb serves millions of recipe photos, of which a few thousand are popular at any moment, and a small set of cooking-course videos that change a few times a year. Which suits a pull CDN and which suits a push CDN, and why?</summary>

The photos suit a pull CDN. There are too many to upload everywhere, and most are rarely viewed. A pull CDN fetches a photo the first time a PoP is asked for it, keeps the popular ones, and lets the rest expire. Storage on the CDN stays small. The cost is a slower first request at each PoP.

The videos suit a push CDN. They are large and change rarely, and Crumb knows exactly when a new one is published. Uploading each one once means it is never re-fetched from the origin just because a TTL ran out. Crumb pays to store them on the CDN, and it has to upload and delete them itself.

</details>

<details>
<summary>What is an origin shield, and what problem does it prevent?</summary>

It's a caching tier between the edge PoPs and the origin: one chosen PoP, usually near the origin, that all edge misses go through.

Without it, when new content goes live or a purge clears a popular object, many PoPs miss at the same moment, and each one fetches from the origin. That burst of identical requests (a thundering herd, or cache stampede) can overload the origin and the database behind it.

With a shield, the edges ask the shield instead. The shield collapses concurrent requests for the same object into one origin fetch and serves everyone from that. The origin sees about one request per object instead of one per PoP, and the shield's large cache raises the overall hit ratio.

</details>

<details>
<summary>How does Anycast differ from unicast, and why does it help both latency and DDoS protection?</summary>

With unicast, an address lives at one location, and every client's packets travel to it, however far away it is.

With Anycast, many sites announce the same address over BGP. Each router on the internet sends packets along its best route, which usually leads to a nearby site. Users everywhere use one address but reach different sites.

That helps latency because the server is usually a short trip away. A DNS lookup to `1.1.1.1` is typically answered within a few milliseconds instead of crossing an ocean. It helps against DDoS because a large attack from a botnet spread across the world is split up. Each bot's packets go to the site nearest to it, so no single site or link takes the whole flood.

</details>

<details>
<summary>Your primary data center fails and you change DNS to point at the backup, with a 60-second TTL. Twenty minutes later some users still can't reach you. Why?</summary>

The TTL only bounds well-behaved caches. Before the change, you also waited for the health checks to declare the data center dead, often a minute or more. After the change, some resolvers enforce a minimum TTL longer than yours. Some applications cache DNS results for as long as they run. Clients that already had open keep-alive or pooled connections don't look up the name again until those connections break.

That's why fast failover is usually done below DNS: load balancers within a data center, and Anycast route withdrawal across sites. DNS is left to spread users across data centers that are all already serving traffic.

</details>

<details>
<summary>Name three downsides of putting Crumb's static files on a CDN, and one way to reduce each.</summary>

1. **Cost.** The CDN bills for traffic and requests. Compare it with the origin servers and bandwidth you would otherwise pay for. Some providers, such as CloudFront with AWS origins, waive the transfer fees between the origin and the CDN.
2. **Stale content.** A file updated before its TTL runs out keeps being served from the old copy. Use content-hashed filenames for scripts, styles and images, and purge by URL or tag for pages.
3. **Changed URLs.** Static file URLs must point at the CDN's hostname. Build tools and templates can rewrite them, or a CDN that proxies the whole domain lets the URLs stay the same.

</details>

<details>
<summary>An API response sends Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=30. What do the browser and the CDN do with it?</summary>

The browser treats it as stale immediately (`max-age=0`), so it revalidates every time it needs the response. The CDN follows `s-maxage`, so it serves its copy for 5 minutes without asking the origin. For the next 30 seconds after that, it can keep serving the stale copy while it fetches a fresh one in the background, so users don't wait on the origin. If no request arrives in that window, the next request after it waits for a normal fetch.

</details>

## Further reading

- [RFC 1034: Domain names, concepts and facilities](https://www.rfc-editor.org/rfc/rfc1034): the original design of DNS, including the resolution process and the CNAME rule. RFC 1035 covers the wire format.
- [DNS Architecture (Microsoft)](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2008-R2-and-2008/dd197427(v=ws.10)): an older but clear walk through the namespace, zones and how queries are resolved, starting from why DNS replaced a single shared hosts file.
- [Domain Name System (Wikipedia)](https://en.wikipedia.org/wiki/Domain_Name_System): a broad overview with the history, every common record type and the security extensions, with links to the RFCs.
- [DNS articles (DNSimple)](https://support.dnsimple.com/categories/dns/): short, practical explainers on each record type, TTLs and ALIAS records, written by a DNS host.
- [List of root servers (IANA)](https://www.iana.org/domains/root/servers): the 13 root server names, their addresses and the organizations that run them.
- [Dyn analysis summary of the October 21 attack (archived)](https://web.archive.org/web/20180105214552/https://dyn.com/blog/dyn-analysis-summary-of-friday-october-21-attack/): the DNS provider's own timeline of the 2016 attack, including how resolver retries multiplied the traffic.
- [Choosing a routing policy (Amazon Route 53 documentation)](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html): geolocation, latency, weighted and failover routing as one provider implements them.
- [Load Balancing without Load Balancers (Cloudflare blog)](https://blog.cloudflare.com/cloudflares-architecture-eliminating-single-p/): how Cloudflare uses Anycast and BGP to spread traffic and survive failures.
- [Globally distributed content delivery (Dilley et al.)](https://web.archive.org/web/20200220054521/https://figshare.com/articles/Globally_distributed_content_delivery/6605972): Akamai's engineers describe how an early CDN with more than 12,000 servers directed users, handled failures and grew from static files to dynamic pages.
- [Content delivery network (Wikipedia)](https://en.wikipedia.org/wiki/Content_delivery_network): an overview of CDN technology, request routing and the major providers.
- [Pull CDN vs. Push CDN (GeeksforGeeks)](https://www.geeksforgeeks.org/system-design/pull-cdn-vs-push-cdn/): a side-by-side comparison of the two models with examples of when to use each.
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111): the current standard for `Cache-Control`, freshness and validation. It replaced RFC 7234.
- [RFC 5861: HTTP Cache-Control extensions for stale content](https://www.rfc-editor.org/rfc/rfc5861): defines `stale-while-revalidate` and `stale-if-error`.
- [Purging with surrogate keys (Fastly documentation)](https://docs.fastly.com/en/guides/purging-with-surrogate-keys): tag-based purging in practice.
