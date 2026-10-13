# DNS and CDN 101

Almost every request a user makes starts at the edge of the network. The browser first has to turn a name like `api.example.com` into an IP address with the **Domain Name System (DNS)**, and much of what it then downloads comes from a **content delivery network (CDN)** server close to the user, not from your own machines.

The primer covers DNS and CDNs in two short overviews. This chapter goes one level deeper into the parts that come up in design discussions: how a name is resolved step by step, which record types you'll actually configure, how one IP address can live in a hundred cities at once (Anycast), why DNS is a slow way to fail over, and how a CDN decides what to cache, for how long, and how to throw it away.

It builds on the primer's [domain name system](/learn/domain-name-system), [content delivery network](/learn/content-delivery-network), [load balancer](/learn/load-balancer) and [security](/learn/security) chapters.

## How DNS actually works

DNS maps names people can remember to addresses routers can use: `api.example.com` to an IPv4 address such as `203.0.113.10`, or an IPv6 address such as `2001:db8::10`. (Both are addresses reserved for documentation, so they won't point anywhere real.)

There is no single database holding every name. DNS is a tree. The root knows who runs each top-level domain like `.com`, the `.com` servers know who runs each domain under it, and each domain's own **authoritative nameservers** hold its actual records. Every level only has to know about the level below it.

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

### The resolution flow, step by step

Before anything goes on the network, the browser checks its own DNS cache, then asks the operating system, which has a cache too. Only on a miss does the query leave the machine. Then:

1. **Client to recursive resolver.** The operating system's stub resolver sends the question to a **recursive resolver**. That is usually run by the ISP or the office network, or it's a public one such as Cloudflare's `1.1.1.1` or Google's `8.8.8.8`. The resolver does the legwork and answers from its own cache if it can.
2. **Resolver to a root server.** On a cache miss, the resolver asks a **root server**. There are 13 root server identities, `a.root-servers.net` through `m.root-servers.net`, each served from many sites worldwide. The root doesn't know `api.example.com`, but it replies with a **referral**: the nameservers for `.com`.
3. **Resolver to the TLD server.** The resolver asks a `.com` **top-level domain (TLD)** server, which replies with another referral: the **NS records** for `example.com`, naming its authoritative nameservers (at a DNS host such as Route 53 or Cloudflare), usually with their IP addresses attached.
4. **Resolver to the authoritative server.** The resolver asks one of those nameservers, which holds the zone's real records. It answers with the **A record** for `api.example.com` and a **time to live (TTL)**, say 300 seconds.

The resolver caches the answer for the TTL and returns it to the client, whose operating system hands the address to the browser so it can open a TCP (and TLS) connection.

In practice the resolver almost never walks the whole path. The root and `.com` referrals have TTLs of a day or more, so a busy resolver already has them cached, and most lookups are a single trip to the authoritative server, or no trip at all.

### DNS record types you'll actually use

| Type | What it does | Example |
|---|---|---|
| **A** | Maps a name to an IPv4 address. | `api.example.com → 203.0.113.10` |
| **AAAA** | Maps a name to an IPv6 address. | `api.example.com → 2001:db8::10` |
| **CNAME** | Makes one name an alias of another name. The resolver then looks up the target. Not allowed at the zone apex (`example.com` itself). | `www.example.com → example.com` |
| **ALIAS / ANAME** | A provider-specific feature that acts like a CNAME at the apex: the DNS host looks up the target itself and answers with plain A/AAAA records. | `example.com → d123.cloudfront.net` |
| **NS** | Names the authoritative nameservers for a zone. | `example.com → ns1.dns-host.net` |
| **MX** | Names the mail servers that accept email for the domain, with a priority. | `example.com → 10 mail.example.com` |
| **TXT** | Free text, used for domain-ownership checks and email authentication (SPF, DKIM, DMARC). | `v=spf1 include:_spf.google.com ~all` |
| **SRV** | Gives the host and port for a named service. Used by SIP, XMPP and some service-discovery systems. | `_sip._tcp.example.com → 10 60 5060 sip.example.com` |

The SRV example reads: priority 10, weight 60, port 5060, on host `sip.example.com`.

**ALIAS** is the one beginners trip over. CDNs and cloud load balancers give you a hostname, not a fixed IP, because their IPs change. For `www` you just add a CNAME to that hostname. For the bare `example.com` you can't, so you use whatever your DNS host offers instead: Route 53 calls it an alias record, Cloudflare calls it CNAME flattening, and DNSimple and others call it ALIAS or ANAME. The check-yourself section below explains why the apex rule exists.

## Anycast routing: one address, many places

How can `1.1.1.1` answer quickly in Sydney and in São Paulo? It isn't one server.

With ordinary **unicast** addressing, an IP address belongs to one network location. If a user in Tokyo talks to a server in Virginia, every packet crosses the Pacific and North America, and the round trip is around 150 ms before the server does any work.

With **Anycast**, the same IP prefix is announced from many data centers at once using the **Border Gateway Protocol (BGP)**, the protocol networks use to tell each other which addresses they can reach. Each router on the internet picks what it considers the best route to that prefix, which usually leads to a nearby site. So users in different cities send packets to the same address but land in different buildings.

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

Some things to know about it:

- **"Nearby" is a routing decision, not a map.** BGP picks routes by policy and path length between networks, not by kilometers. Usually you land at a close site, but sometimes an ISP's peering sends you to one farther away.
- **It suits short exchanges best.** A DNS query is one UDP packet each way, so it doesn't matter if a route changes between queries. CDNs also run TCP over Anycast. Routes are stable enough that this works well, but a route change mid-connection can send packets to a different site that knows nothing about the connection, which then has to be reset.
- **It spreads attacks out.** A volumetric DDoS attack aimed at an Anycast address comes from bots all over the world, and each bot's traffic goes to its nearest site. The flood is split across every location instead of landing on one link.
- **Failover is a route change.** If a site goes down, it stops announcing the prefix, and routers send traffic to the next-best site. BGP convergence takes seconds, much faster than waiting for DNS caches to expire.

## DNS routing policies

Managed authoritative DNS services (Route 53, Cloudflare DNS, NS1 and others) can return different answers to different users. They act as a coarse global traffic manager:

1. **Geolocation routing.** Answer based on where the user appears to be, for example sending European users to an EU region to keep their data there or to serve local content. The location is usually inferred from the resolver's IP address, or from the client subnet when the resolver sends one (the EDNS Client Subnet extension), so it's approximate.
2. **Latency-based routing.** Return the region with the lowest measured latency from the user's network. Route 53 does this from its own measurements between networks and AWS regions.
3. **Weighted routing.** Split answers by weight, for example 90% to the current fleet and 10% to a canary.
4. **Health checks and failover.** The DNS service probes an endpoint, and when the checks fail it stops handing out that endpoint's address.

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
- **Caches that don't follow the rules.** Some resolvers enforce a minimum TTL, some applications cache lookups for their own lifetime, and some embedded devices barely re-resolve at all. You can't control any of them.
- **Open connections.** DNS only matters when a client opens a new connection. A browser or app holding a keep-alive connection, or a pool of database connections, keeps talking to the old address until that connection breaks.

You can't make the TTL tiny to fix this either. Every expiry means another round of lookups, more load on your DNS provider, and a little more latency for users.

The usual approach: use DNS to spread users across several healthy regions that are all serving traffic (**active-active**), and handle fast failover below DNS. Inside a region, load balancers take a dead server out of rotation within seconds. Across sites, an Anycast front end withdraws a failed location's route, again within seconds. DNS changes then cover the slow, rare case, such as draining a whole region for maintenance.

## Content delivery networks

A CDN is a set of caching reverse proxies spread across many data centers, called **points of presence (PoPs)**, near users. A user's request goes to a nearby PoP, through DNS steering or Anycast. If that PoP has a fresh copy of the response, it answers directly. If not, it fetches from your **origin** (your own servers or a storage bucket), keeps a copy, and answers.

That buys three things: lower latency, because the bytes travel a shorter distance; less load and bandwidth at the origin, because one copy serves many users; and some protection, because the CDN absorbs traffic spikes and attacks before they reach you. How much origin traffic it saves depends on the **cache hit ratio**, which ranges from over 95% for static assets with long lifetimes to near zero for personalized API responses.

### Push vs pull CDNs

| Model | How it works | Good for | Trade-offs |
|---|---|---|---|
| **Pull (origin pull)** | The CDN fetches from the origin on demand, the first time a PoP is asked for something it doesn't have, then caches it. | Websites, static assets, cacheable API responses, most video. | The first request at each PoP is a miss and pays the trip to origin. Almost no work for you. |
| **Push** | You upload content to the CDN's storage ahead of time, through an API or sync tool. | Large files you release on purpose: installers, game patches, a video library. | You manage uploads and deletes yourself, and you pay to store files even if no one requests them. |

Most sites use pull. It needs no extra workflow: point the CDN at the origin and set cache headers.

### Tiered caching and origin shield

Picture a product launch. A new page goes live, and within the same second, PoPs on every continent get their first request for it. Each one misses, and each one asks the origin. With hundreds of PoPs, that's hundreds of identical requests hitting the origin at once: a **thundering herd**, or cache stampede. For an expensive page it can overload the origin, and the database behind it.

CDNs prevent this with **tiered caching**. Edge PoPs don't go to the origin directly. They go to a parent tier, and with an **origin shield** that parent is one designated PoP, usually close to the origin, that every miss funnels through.

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

The origin sees one request per object per shield instead of one per PoP. The shield's cache is also bigger and warmer than any single edge's, so the overall hit ratio goes up. The cost is an extra hop on misses, which matters little compared with going all the way to the origin from every PoP.

## HTTP caching headers

The origin controls caching with response headers. The CDN and the browser both read them. The current definition is RFC 9111.

### Cache-Control directives

- `public`: any cache may store the response, including shared caches like a CDN.
- `private`: only the user's own browser may store it. Shared caches must not. Use it for pages specific to one user, like an account page.
- `no-cache`: caches may store it but must **revalidate** with the origin before every use. Despite the name, it doesn't mean "don't cache".
- `no-store`: don't store it anywhere. Use it for sensitive responses like bank statements.
- `max-age=N`: the response is fresh for N seconds, in the browser and in shared caches.
- `s-maxage=N`: like `max-age`, but only for shared caches, where it takes precedence over `max-age`. This lets you cache briefly in browsers, where you can't purge, and for much longer on the CDN, where you can:

  ```http
  Cache-Control: public, max-age=60, s-maxage=86400
  ```

  Browsers keep this for 1 minute. The CDN keeps it for 86,400 s = **24 hours**.

- `stale-while-revalidate=N` (RFC 5861): once the response goes stale, a cache may keep serving the stale copy for up to N more seconds while it fetches a fresh one in the background. Users get a fast cached answer instead of waiting on the origin, at the price of possibly seeing content a little out of date.
- `stale-if-error=N` (also RFC 5861): if the origin errors or can't be reached, a cache may serve a stale copy for up to N seconds instead of the error.

CDNs differ in which of these they honor, and most let you override the origin's headers with their own rules, so check your provider's documentation.

### Revalidation with ETag

When a cached copy goes stale, a cache doesn't have to download it again. The origin sent an `ETag` (a version identifier for that content) with the original response, and the cache asks whether that version is still current:

```http
GET /styles.css HTTP/1.1
Host: www.example.com
If-None-Match: "33a64df551425f"
```

If nothing changed, the origin answers `304 Not Modified` with no body, and the cache marks its copy fresh again. You save the bandwidth, though not the round trip. `Last-Modified` and `If-Modified-Since` do the same job with a timestamp instead of a version tag.

## Cache invalidation strategies

Phil Karlton's line that "there are only two hard things in computer science: cache invalidation and naming things" is a joke with truth in it. Once a CDN has a copy, you need a way to replace it when the origin changes. The main options:

1. **Content-hashed filenames (cache busting).** Put a hash of the file's contents in its name, like `bundle.8f2a9b.js`. A changed file gets a new name, so it's a new URL, and nothing old needs removing. These files can then be cached for a year with `Cache-Control: public, max-age=31536000, immutable`. The catch is that the HTML page referring to them must have a short lifetime or be purged, or users keep receiving the old page that points at the old bundle. Build tools do the hashing for you. This is the standard approach for JavaScript, CSS and images.
2. **Purge by URL.** Call the CDN's API to remove a specific path from every PoP. Depending on the vendor it takes from a few seconds to a few minutes to spread. It works for a handful of known URLs, but gets awkward when one change affects many URLs.
3. **Purge by tag (surrogate keys).** The origin labels each response with tags in a header, such as Fastly's `Surrogate-Key` or Cloudflare's `Cache-Tag`:

   ```http
   Surrogate-Key: product-142 category-electronics
   ```

   When product 142's price changes, you purge the tag `product-142`, and the CDN drops every cached object carrying it: the product page, its JSON API response, the category listings that show it, a search results page. The origin doesn't need to know which URLs those were. The CDN strips the header before the response reaches users.
4. **Soft purge.** Some CDNs, Fastly among them, can mark objects stale instead of deleting them. The next request triggers a refresh, and if the origin is down, `stale-if-error` lets the CDN keep serving the old copy. You get updated content when the origin is healthy and the old content when it isn't, which is usually better than an error page.

## Edge compute

Most big CDNs now let you run your own code inside their PoPs: Cloudflare Workers, Fastly Compute, and on AWS, CloudFront Functions and Lambda@Edge. The code runs in the PoP that received the request, so it can make decisions without a round trip to the origin. Typical uses:

- **A/B testing.** Read a cookie, assign the user to a variant, and rewrite the request to the matching cached version, with no redirect.
- **Auth and geofencing at the edge.** Verify a JWT signature, or block countries you don't serve, so bad requests are rejected before they reach your network. See [security 101](/learn/security-101) for how JWTs are verified.
- **Image optimization.** Resize and crop images on demand, and convert them to WebP or AVIF when the browser's `Accept` header says it supports them.
- **Light personalization.** Insert the user's region, currency or language into an otherwise cached page.

The limits are tight compared with a normal server: short CPU time per request, limited memory, and usually no fast access to your main database, which lives in one region. Edge code works best when everything it needs is in the request itself or in a small replicated store the platform provides.

## Check yourself

<details>
<summary>Why can't you put a CNAME at the zone apex (example.com), and how do DNS providers work around it?</summary>

The DNS rules (RFC 1034, restated in RFC 1912) say a name with a CNAME record can't have any other records, because a CNAME means "this name is really that other name, look there for everything". The apex of a zone must have an SOA record and NS records. So a CNAME at `example.com` would conflict with records that are required to be there.

Providers work around it inside their authoritative servers. You configure the apex to point at a hostname such as `d123.cloudfront.net`, using Route 53's alias records, Cloudflare's CNAME flattening, or an ALIAS/ANAME record elsewhere. When a resolver asks for `example.com`, the provider looks up the target itself and answers with ordinary A/AAAA records. Resolvers only ever see standard records, so nothing breaks.

</details>

<details>
<summary>What is an origin shield, and what problem does it prevent?</summary>

It's a caching tier between the edge PoPs and the origin: one designated PoP, usually near the origin, that all edge misses go through.

Without it, when new content goes live or a purge clears a popular object, many PoPs miss at the same moment and each one fetches from the origin. That burst of identical requests (a thundering herd, or cache stampede) can overload the origin and the database behind it.

With a shield, the edges ask the shield instead. The shield collapses concurrent requests for the same object into one origin fetch and serves everyone from that. The origin sees about one request per object instead of one per PoP, and the shield's large cache raises the overall hit ratio.

</details>

<details>
<summary>How does Anycast differ from unicast, and why does it help both latency and DDoS protection?</summary>

With unicast, an address lives at one location, and every client's packets travel to it, however far that is.

With Anycast, many sites announce the same address over BGP, and each router on the internet sends packets along its best route, which usually leads to a nearby site. Users everywhere use one address but reach different sites.

That helps latency because the server is usually a short trip away. A DNS lookup to `1.1.1.1` is typically answered within a few milliseconds instead of crossing an ocean. It helps against DDoS because a volumetric attack from a botnet spread across the world is split up: each bot's packets go to the site nearest to it, so no single site or link takes the whole flood.

</details>

<details>
<summary>Your primary region fails and you change DNS to point at the backup, with a 60-second TTL. Twenty minutes later some users still can't reach you. Why?</summary>

The TTL only bounds well-behaved caches. Before the change you also waited for the health checks to declare the region dead, often a minute or more. After it, some resolvers enforce a minimum TTL longer than yours, some applications cache DNS results for as long as they run, and clients that already had open keep-alive or pooled connections don't look up the name again until those connections break.

That's why fast failover is usually done below DNS: load balancers within a region and Anycast route withdrawal across sites. DNS is left to spread users across regions that are all already serving traffic.

</details>

<details>
<summary>An API response sends Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=30. What do the browser and the CDN do with it?</summary>

The browser treats it as stale immediately, so it revalidates every time it needs the response (`max-age=0`). The CDN, which follows `s-maxage`, serves its copy for 5 minutes without asking the origin. For the next 30 seconds after that, it can keep serving the stale copy while it fetches a fresh one in the background, so users don't wait on the origin. If no request arrives in that window, the next request after it waits for a normal fetch.

</details>

## Further reading

- [RFC 1034: Domain names, concepts and facilities](https://www.rfc-editor.org/rfc/rfc1034): the original design of DNS, including the resolution process and the CNAME rule. RFC 1035 is its companion on the wire format.
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111): the current standard for `Cache-Control`, freshness and validation. It replaced RFC 7234.
- [RFC 5861: HTTP Cache-Control extensions for stale content](https://www.rfc-editor.org/rfc/rfc5861): defines `stale-while-revalidate` and `stale-if-error`.
- [Load Balancing without Load Balancers (Cloudflare blog)](https://blog.cloudflare.com/cloudflares-architecture-eliminating-single-p/): how Cloudflare uses Anycast and BGP to spread traffic and survive failures.
- [Choosing a routing policy (Amazon Route 53 documentation)](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html): geolocation, latency, weighted and failover routing as one provider implements them.
- [Purging with surrogate keys (Fastly documentation)](https://docs.fastly.com/en/guides/purging-with-surrogate-keys): tag-based purging in practice.
