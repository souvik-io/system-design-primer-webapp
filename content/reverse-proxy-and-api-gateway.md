# Reverse proxies, API gateways and microservices

This chapter answers six questions:

- What is a reverse proxy, and what does it do for the servers behind it?
- How is a reverse proxy different from a load balancer, and why run one in front of a single server?
- Why can one machine running NGINX or Envoy hold tens of thousands of connections at once?
- What does an API gateway add on top of a reverse proxy?
- Why split the web layer from the application layer, and when does that split turn into microservices?
- How do services find each other as they come and go, and what does a service mesh do?

We'll keep using **Crumb**, the recipe-sharing site from the [Scalability](/learn/scalability) chapter. Crumb has several app servers behind a [load balancer](/learn/load-balancing), a cache, a database with read replicas, and workers that process photo uploads from a queue. In this chapter, Crumb puts a reverse proxy at its front door, splits its one big application into smaller services, and then has to solve the problems that splitting creates.

## What a reverse proxy is

On your laptop, a browser talks straight to your application on port 8080. In production you almost never let internet clients do that. If clients reached every server directly, each server would have to handle encryption, block abusive clients and serve files, and clients would need to know the address of every server.

Instead, requests come in through a front door. A **proxy** is a server that makes requests on someone else's behalf. A **reverse proxy** is a web server that sits in front of your own servers and makes requests to them on behalf of clients. It brings your internal services together behind one public address, so the outside world sees a single, unified interface.

Here is what happens when a Crumb user opens a recipe:

1. The browser connects to `crumb.example`. That name points to the reverse proxy, not to any app server.
2. The reverse proxy reads the request and forwards it to a server that can answer it, such as one of Crumb's app servers.
3. The app server sends its response back to the reverse proxy.
4. The reverse proxy returns that response to the browser.

The browser never learns which server did the work. NGINX describes the same flow: a reverse proxy "accepts a request from a client, forwards it to a server that can fulfill it, and returns the server's response to the client" ([NGINX glossary, archived](https://web.archive.org/web/20221207025053/https://www.nginx.com/resources/glossary/reverse-proxy-vs-load-balancer)).

```diagram
title: Crumb's reverse proxy is the only address users see.
[u:client] Users @ 0,1
[rp] Reverse proxy @ 1.5,1
[files:store] Static files\n(CSS, JS, photos) @ 1.5,0
[app] App server @ 3.5,1
u -> rp : HTTPS
rp -> files : /static/
rp -> app : everything else
```

### Forward proxy vs reverse proxy

The two kinds of proxy differ in whose behalf they act on.

```diagram
title: A forward proxy acts for clients; a reverse proxy acts for servers
[c1:client] Client 1 @ 0,0
[c2:client] Client 2 @ 0,1
[fwd] Forward proxy\n(egress) @ 1,0.5
[net] Internet @ 2,0.5
[rev] Reverse proxy\n(ingress) @ 3,0.5
[s1] App server 1 @ 4,0
[s2] App server 2 @ 4,1
c1 -> fwd
c2 -> fwd
fwd -> net : hides client IPs
net -> rev : api.example.com
rev -> s1
rev -> s2
```

- **A forward proxy** sits in front of a group of clients. It sends their outbound requests to the internet for them, so websites see the proxy's IP address instead of the clients'. Companies and schools use forward proxies to filter and log outbound traffic. Some also use them to cache it.
- **A reverse proxy** sits in front of a group of servers. It receives inbound requests for them. Clients connect to `api.example.com` and never learn which server answered.

The same software often does both jobs. Where it sits, and who configured it, decides which kind it is.

### What a reverse proxy does for you

Because every request passes through the reverse proxy, it is a natural place to do work that would otherwise be repeated on every server. The NGINX glossary page linked above lists most of these benefits.

- **Increased security.** Clients can't see anything about the backend servers, such as their addresses or software versions, so attackers can't reach them directly. The proxy can also block traffic from known bad IP addresses (a **denylist**, sometimes called a blacklist), and it can limit how many connections each client may open. The [rate limiting chapter](/learn/rate-limiting#where-the-limiter-lives) covers finer-grained limits.
- **Increased scalability and flexibility.** Clients only ever see the reverse proxy's IP address. So you can add servers, remove them, move them or change their configuration without telling any client.
- **SSL termination.** Encrypting and decrypting traffic costs CPU. The reverse proxy decrypts incoming requests and encrypts outgoing responses, so the backend servers don't have to do this potentially expensive work. It also means the [X.509](https://en.wikipedia.org/wiki/X.509) certificate and its private key live only on the proxy. Without termination, you would install them on every server. (SSL is the old name for TLS. The [load balancing chapter](/learn/load-balancing#tls-termination) compares terminating, re-encrypting and passing traffic through.)
- **Compression.** The proxy compresses responses, for example with gzip, before sending them. Smaller responses use less bandwidth and arrive sooner.
- **Caching.** The proxy can keep a copy of a response. When the same request arrives again, it returns the copy without asking a backend server. Responses come back faster and the servers do less work. The [DNS and CDN chapter](/learn/dns-and-cdn#http-caching-headers) explains the headers that control what may be cached.
- **Static content.** Files that are the same for every user can be served by the proxy directly from disk. These include HTML, CSS and JavaScript files, photos, videos and other downloads. The app servers then spend their time only on requests that need code to run.

Here is a short NGINX configuration that gives Crumb several of these benefits. It is a sketch: the paths and addresses are made up.

```nginx
upstream crumb_app {
    server 10.0.1.10:8080;
}

server {
    listen 443 ssl;
    server_name crumb.example;
    ssl_certificate     /etc/nginx/certs/crumb.pem;
    ssl_certificate_key /etc/nginx/certs/crumb.key;

    gzip on;
    gzip_types text/css application/javascript application/json;

    location /static/ {
        root /var/www/crumb;
    }

    location / {
        proxy_pass http://crumb_app;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

- `listen 443 ssl` and the two `ssl_certificate` lines turn on TLS termination.
- `gzip on` compresses the listed types of response.
- The `/static/` block serves files straight from disk.
- Everything else goes to the app server named in `upstream`. The `X-Forwarded-For` header tells the app the user's real IP address, since the connection now comes from the proxy.

### Load balancer vs reverse proxy

A load balancer and a reverse proxy both sit between clients and servers, take requests from the clients and return responses from the servers. So people often confuse them. The difference is in why you deploy each one.

- **A load balancer is useful when you have several servers.** Usually those servers all do the same job, and the load balancer spreads requests across them. It also stops sending requests to a server that has failed. The [load balancing chapter](/learn/load-balancing) covers this in depth.
- **A reverse proxy is useful even with just one server.** Every benefit in the list above (security, a stable public address, SSL termination, compression, caching and static files) applies when there is only one web or application server behind it. In NGINX's words, "deploying a load balancer makes sense only when you have multiple servers," while "it often makes sense to deploy a reverse proxy even with just one web server or application server."
- **One piece of software can do both.** NGINX and HAProxy can each act as a layer 7 reverse proxy and as a load balancer at the same time. ("Layer 7" means the software reads the HTTP request itself, such as its path and headers. See [Layer 4 and layer 7 load balancing](/learn/load-balancing#layer-4-and-layer-7-load-balancing).) The `upstream` block in the Crumb configuration above turns into load balancing as soon as you list a second server in it.

| | Load balancer | Reverse proxy |
| --- | --- | --- |
| Main reason to deploy it | Spread work over several servers and route around failed ones | Give one public face to your servers and take shared work off them |
| Useful with one server? | No | Yes |
| Typical extras | Health checks, sticky sessions | SSL termination, compression, caching, static files |
| Common software | HAProxy, NGINX, Envoy, cloud load balancers | NGINX, HAProxy, Envoy, Apache |

In practice, the two roles blur. Most software load balancers that read HTTP are also reverse proxies, and most reverse proxies can balance load.

### Disadvantages of a reverse proxy

- **More complexity.** The reverse proxy is one more component to configure, monitor, upgrade and debug. A wrong setting on it, such as a timeout that is too short, affects every request.
- **A single point of failure.** A **single point of failure** is one part whose failure takes the whole system down. If Crumb runs one reverse proxy and it crashes, every app server is healthy and no user can reach any of them.
- **Fixing that adds more complexity.** The fix is to run more than one reverse proxy, with a **failover** so that a standby takes over when the active one fails. That means heartbeats, a shared virtual IP address, and testing that the switch really works. The [load balancing chapter](/learn/load-balancing#running-load-balancers-in-pairs) shows how such a pair is set up, and [Availability](/learn/availability#fail-over-active-passive) covers failover in general.

## Concurrency models and the C10K problem

A reverse proxy holds a connection open to every client that is talking to the site. On a busy site, that can be tens of thousands of connections at once. How a server copes with that many connections is the reason NGINX, and later Envoy, replaced the classic Apache setup as the usual front door.

In 1999 Dan Kegel wrote an essay on the **C10K problem**: how to have one server handle 10,000 clients at the same time. Hardware was already fast enough. The bottleneck was the way servers used the operating system.

### Thread (or process) per connection

The traditional model gives each connected client its own operating system thread. Apache's old prefork mode gave each client its own process. The thread reads the request, runs the handler, waits on the database and writes the response. Then it waits for the client's next request on the same keep-alive connection.

Code written this way is easy to follow. But its cost grows with the number of connections, even idle ones:

- **Memory.** Each thread reserves stack space. On Linux the default reservation is 8 MB of virtual address space, and the JVM's default is 1 MB. Only the pages a thread actually touches use physical RAM, typically tens of kilobytes. Add per-connection buffers and bookkeeping, though, and the total grows with every connection. A prefork process with an interpreter such as PHP loaded into it often uses several megabytes of real memory.
- **Scheduling.** With thousands of threads, the kernel spends a growing share of CPU time switching between them. After each switch, the CPU's caches hold the wrong thread's data.
- **Waste on idle clients.** Say 10,000 clients are connected and only 100 are sending anything right now. The other 9,900 threads sit blocked, doing nothing, while still holding their memory.

### Event-driven, non-blocking I/O

Event-driven servers turn this around. They run a small, fixed number of workers, usually one per CPU core. NGINX uses worker processes, Envoy uses worker threads, and Node.js uses a single event-loop thread. Each worker handles thousands of connections by never waiting on any one of them. It relies on the kernel's readiness notification APIs: **`epoll`** on Linux and **`kqueue`** on the BSDs and macOS.

1. Each socket is set to **non-blocking** mode. If the worker tries to read and no data has arrived, the call returns at once with "would block" instead of putting the worker to sleep.
2. The worker registers every socket it owns with the kernel once (with `epoll_ctl` on Linux). It says which events it cares about, such as "readable" or "writable".
3. The worker calls `epoll_wait`, which sleeps until at least one registered socket is ready.
4. The kernel returns a list of only the ready sockets. The worker reads, parses and writes as much as it can on each one without waiting. Then it goes back to step 3.

```diagram
title: One worker's event loop over many non-blocking sockets
[socks:note] Many client\nsockets @ 0,0
[kernel:store] Kernel\n(epoll / kqueue) @ 2,0
[worker] Worker\n(one per core) @ 1,1
socks -> kernel : data arrives
kernel -> worker : ready list
worker -> socks : read / write
```

An idle connection now costs only some socket state in the kernel and a small record in the proxy. The [NGINX home page](https://nginx.org/en/) says "10,000 inactive HTTP keep-alive connections take about 2.5M memory." That figure leaves out the kernel's socket buffers. Still, it's why one modest machine running NGINX or Envoy can hold tens or hundreds of thousands of mostly idle connections.

There is a catch: nothing in a worker may block. A slow disk read or a long computation stalls every connection that worker owns. Proxies suit this model because most of their work is moving bytes from one socket to another. Apache later added its `event` MPM, which hands idle keep-alive connections to an event loop for the same reason.

## Reverse proxy vs API gateway

An **API gateway** is a reverse proxy that specializes in APIs. It knows who each caller is and which API they are calling, and it applies rules per caller. Every API gateway is a reverse proxy, but not every reverse proxy is an API gateway.

The line between the two is blurry, and products sit all along it. Envoy is used as a plain proxy, as a sidecar and as a gateway. NGINX gains gateway features through modules. The table shows the typical emphasis of each.

| Capability | Reverse proxy (NGINX, HAProxy) | API gateway (Kong, AWS API Gateway, Envoy-based gateways) |
|---|---|---|
| **Main job** | Terminate TLS, route and load balance HTTP and TCP, cache, compress. | Manage APIs as a product: who may call what, how often, and in what shape. |
| **Configuration** | Mostly files, applied with a graceful reload. | Usually changed through an API or control plane, often per route or per caller. |
| **Authentication** | TLS, basic auth, perhaps a call out to an auth service. | Checks API keys, OAuth 2.0 access tokens and JWTs, and the scopes inside them. |
| **Rate limiting** | Per client IP or per connection. | Per user, API key or pricing plan, often shared across gateway nodes in a store such as Redis. |
| **Transformation** | Headers, compression. | Rewrites requests and responses, translates JSON to gRPC, validates requests against a schema. |
| **Observability** | Access logs and basic metrics. | Per-caller analytics, distributed tracing, usage reports for billing. |

## Core responsibilities of an API gateway

In a system made of many services, the gateway is the single entry point for traffic from outside. A typical request passes through these steps:

```diagram
title: An API gateway in front of internal services
[client:client] Web and mobile\nclients @ 0,1
[rl:store] Rate-limit\ncounters (Redis) @ 1.5,0
[gw] API gateway @ 1.5,1
[idp] Identity\nprovider @ 1.5,2
[users] User service @ 3,0
[orders] Order service @ 3,1
[pay] Payment service @ 3,2
client -> gw : HTTPS
gw -> rl : check limit
gw --> idp : signing keys
gw -> users : /users
gw -> orders : /orders
gw -> pay : /payments
```

1. Terminate TLS.
2. Authenticate the caller by checking the token's signature, expiry and audience.
3. Check the caller's rate limits and quotas. The [rate limiting chapter](/learn/rate-limiting) explains the algorithms.
4. Pick the backend service from the request's path and method, and load balance across that service's instances.
5. Add tracing headers, record metrics, forward the request, and pass the response back. The [observability chapter](/learn/observability#distributed-tracing) covers tracing.

### Central authentication

Without a gateway, every service has to check tokens itself. Each one parses JWTs, fetches and rotates the identity provider's public keys, and rejects bad requests. When a dozen services in different languages each do this, you get a dozen slightly different bugs.

With a gateway, the work happens once, at the edge:

1. The gateway checks the JWT's signature. It does this locally, with the identity provider's public keys, which it fetches and caches in the background. So a normal request doesn't wait on the identity provider. That's why the edge to it in the diagram is dashed.
2. The gateway rejects missing, expired or forged tokens before they reach any service.
3. The gateway passes the caller's identity to the service. It might add an `X-User-Id: 104` header, or forward the verified token itself.

Step 3 has a catch. The gateway must **remove any `X-User-Id` header the client sent**. Otherwise a caller could claim to be anyone. Services, in turn, must accept that header only from the gateway, which is one reason internal traffic is authenticated with mutual TLS (mTLS). Many teams also let each service check the token again, so that a service exposed by mistake isn't wide open. [Security](/learn/security#service-to-service-identity-mutual-tls) covers tokens and mTLS in detail.

### Protocol translation: HTTP to gRPC

Browsers and outside developers want HTTP with JSON. Many internal services prefer **gRPC**, which sends Protocol Buffers (a compact binary format) over HTTP/2. Its contracts are typed and generated from a schema. The [protocols chapter](/learn/protocols-and-apis#grpc-rpc-over-http2) explains gRPC itself.

A gateway can translate between the two. A client sends `GET /v1/users/104`. The gateway turns it into a `GetUser` gRPC call with `user_id = 104`, then converts the binary reply back into JSON. This is called **gRPC-JSON transcoding**. The mapping is declared in the service's `.proto` file with HTTP annotations. Envoy, Google Cloud's API gateways and others implement it. Outside clients get a normal REST API, internal services stay on gRPC, and either side can change its internals without the other noticing.

A related option, **gRPC-Web**, lets code in the browser call gRPC services. A proxy in the middle translates between what browsers can send and full gRPC.

### The Backend-for-Frontend (BFF) pattern

One general-purpose API rarely suits every client:

- A mobile app on a cellular connection wants one small response with exactly the fields one screen needs. On a slow network, each extra round trip is expensive.
- A desktop web app can afford larger responses, and it may want data from several services at once.

The **Backend-for-Frontend** pattern, named by Sam Newman, gives each kind of client its own thin backend. The team that builds the client also owns its backend.

- **A mobile BFF** calls several internal services, combines the results, and returns one compact response shaped for the app's screens.
- **A web BFF** returns richer data for the browser app. It can also handle web-only concerns such as session cookies.

Each BFF changes at the pace of its own frontend. The core services don't fill up with requests like "add this field for the iOS app." The costs are more services to run, and logic that can get copied between BFFs if you aren't careful. Keep business rules in the core services, and put only combining and reshaping in the BFF.

A public API for outside developers is usually a separate product, with its own versions, API keys and quotas. The API gateway often serves it directly, without a BFF.

## Separating the web and application layers

At first, each Crumb app server does everything. It renders HTML pages, runs the business logic (search, saving recipes, comments) and talks to the database. That's fine until Crumb launches a mobile app.

The mobile app needs Crumb's data as JSON and never asks for HTML pages. If the code that renders pages and the code that runs business logic live in the same servers, Crumb can only scale them together. So Crumb splits its servers into two layers:

- **The web layer** handles what browsers see: it renders pages and serves the website.
- **The application layer**, also called the **platform layer**, holds the business logic and talks to the databases. The web servers call it, and so do the mobile app and any other client.

```diagram
title: Crumb splits its servers into a web layer and an application layer.
[b:client] Browsers @ 0,0
[m:client] Mobile app @ 0,2
[rp] Reverse proxy @ 1,1
[web] Web servers\n(render pages) @ 2,0
[app] Application\nlayer @ 3,1
[db:store] Databases @ 4,1
[q:queue] Job queue @ 3,2
[w] Workers @ 4,2
b -> rp
m -> rp
rp -> web : pages
rp -> app : /api
web -> app
app -> db
app --> q : enqueue
q --> w
```

The split gives Crumb four things:

- **Each layer scales and is configured on its own.** Rendering pages and running searches need different amounts of CPU and memory. Crumb can add servers to whichever layer is busy, and tune each layer's machines for its work.
- **A new API means new application servers only.** When Crumb launches its mobile API, the extra traffic lands on the application layer. Crumb adds application servers without necessarily adding web servers.
- **Several products share one platform.** Will Larson, in [Introduction to Architecting Systems for Scale](https://lethain.com/introduction-to-architecting-systems-for-scale/), points out that one platform layer can serve a website, an API and a mobile app, so each of them doesn't have to repeat the cache and database code.
- **Background work has a home.** Workers in the application layer take slow jobs, such as resizing photos, off the request path. This is what makes asynchronous processing possible. The [queues chapter](/learn/queues-and-async) covers it.

The same idea can go further. The **single responsibility principle** says each part of a system should do one job well. Applied to services, it argues for small, autonomous services that each own one job and work together. A small team that owns a small service understands all of it, can change it without asking other teams, and can plan aggressively for rapid growth. Taken to its end, this idea is called microservices.

## Microservices

**Microservices** are a way of building one application as a suite of small, modular services that can each be deployed on their own. Each service runs as its own process. Services talk to each other through a well-defined, lightweight mechanism, usually HTTP with JSON, gRPC, or messages on a queue. Each one serves a business goal, such as "search recipes" or "store photos."

James Lewis and Martin Fowler's [2014 article](https://martinfowler.com/articles/microservices.html) describes microservices as "suites of independently deployable services," usually organized "around business capability." The opposite is a **monolith**: one application that is built and deployed as a single unit.

A photo-sharing site like Pinterest could have these microservices: user profile, follower, feed, search and photo upload. Crumb's split looks similar:

| Crumb service | Its job | Owns this data |
| --- | --- | --- |
| Users | Accounts, profiles, login | User records |
| Recipes | Create, edit and read recipes | Recipe records |
| Search | Answer recipe searches | A search index |
| Comments | Comments and ratings | Comment records |
| Photos | Accept uploads, store and resize photos | Photo files and metadata |

Each service keeps its own data. Other services ask it through its API, and never read its database directly. That rule is what lets a team change its service's internals without breaking anyone else.

### Why teams split into microservices

- **Independent deploys.** In a monolith, Lewis and Fowler write, "a change made to a small part of the application, requires the entire monolith to be rebuilt and deployed." With microservices, the search team can ship a fix to search alone.
- **Independent scaling.** At dinner time, Crumb's search service is busy and its comments service is not. Crumb can run 20 search instances and 3 comment instances.
- **Smaller failures.** Uber [moved to microservices](https://www.uber.com/blog/microservice-architecture/) around 2012 and 2013, when it had "primarily two monolithic services." The post explains that "a single regression within a monolithic code base can bring the whole system (in this case, all of Uber) down." A bug in one microservice is more likely to take down only that service's feature.
- **Team ownership.** Each team owns a few services from design to production, and can choose the language and database that suit them.

### Disadvantages of the application layer and microservices

- **A different way of working.** A system of loosely coupled services needs a different approach from a monolith in architecture, in operations and in process. Teams have to agree on API contracts, version them, and coordinate changes that cross service boundaries.
- **More to deploy and operate.** Every service needs its own build, deploy pipeline, monitoring, alerts and on-call owner. Five services means five of each.
- **Calls that used to be function calls now cross the network.** A network call can be slow, fail, or succeed without the caller hearing back. Every caller needs timeouts and retries, and the operations it retries must be safe to repeat. The [reliability patterns chapter](/learn/reliability-patterns) covers these.
- **Harder debugging.** One user request may pass through many services, so finding a bug means following it across all of them. Distributed tracing helps (see [observability](/learn/observability#distributed-tracing)).
- **Data split across services.** A change that touches two services' data can no longer use one database transaction. The [distributed transactions chapter](/learn/distributed-transactions) covers the options.

Uber's 2020 post, [Introducing Domain-Oriented Microservice Architecture](https://www.uber.com/blog/microservice-architecture/), shows these costs at scale. By then Uber had "around 2,200 critical microservices." The post describes an outage investigation in which "engineers had to work through around 50 services across 12 different teams" to find the root cause. It also says that "in order to build a simple feature an engineer often has to work across multiple services," each owned by different people. Uber's response was to group related services into **domains**, each "a collection of one or more microservices tied to a logical grouping of functionality," with a gateway as the single entry point into each domain.

For this reason, many teams start with a single, well-organized application and split off services only when a part of it clearly needs its own team, deploys or scaling. Martin Fowler's [Monolith First](https://martinfowler.com/bliki/MonolithFirst.html) (2015) reports that "almost all the successful microservice stories have started with a monolith that got too big and was broken up."

## Service discovery

On a fixed set of servers, a service can reach its database at a known hostname such as `db.internal:5432`. In a cloud or Kubernetes setup, instances are short-lived. Autoscalers add and remove them, and the scheduler moves containers between machines, so IP addresses change all the time.

So how does Crumb's recipe service find a healthy instance of the search service right now? Every approach uses a **service registry**: a list of the live instances of each service, with their names, addresses and ports. Instances add themselves when they start, and health checks remove the ones that stop working.

### Service registries: Consul, etcd and ZooKeeper

Three tools are commonly used to keep this list.

- **Consul** (from HashiCorp) is built for service discovery. Each instance registers its service name, address and port, and Consul runs health checks on it.
- **etcd** describes itself as ["a strongly consistent, distributed key-value store"](https://etcd.io/) for data "that needs to be accessed by a distributed system or cluster of machines." Kubernetes is one of its best-known users. Services write their address under a key, and callers read or watch that key.
- **ZooKeeper** is ["a distributed, open-source coordination service for distributed applications"](https://zookeeper.apache.org/doc/current/zookeeperOver.html). An instance registers by creating an **ephemeral znode**, a small entry that "exists as long as the session that created the znode is active." If the instance dies, its session ends and the entry disappears. Callers set a **watch** on the list, and ZooKeeper tells them when it changes.

etcd and ZooKeeper both keep their data consistent across several machines using consensus. The [consensus chapter](/learn/consensus#zookeeper-and-etcd-in-practice) explains how.

**Health checks** confirm that an instance is really working. They are often done over HTTP. Each instance of Crumb's search service exposes an endpoint such as `GET /health`, and the registry calls it at a regular interval, such as every 10 seconds. [Consul's documentation](https://developer.hashicorp.com/consul/docs/register/health-check/vm) spells out its rules for HTTP checks: "A `200`-`299` response code is healthy," a `429` (too many requests) is a warning, and "all other response codes indicate a failure." By default, a check that hasn't answered in 10 seconds counts as failed. An instance that fails is taken out of the list, and callers stop being sent to it. The [load balancing chapter](/learn/load-balancing#health-checks) discusses what a good health check should test.

**Shared configuration.** Consul and etcd both include a key-value store, which is useful for configuration values and other data that many services share. Crumb could keep its search timeout or a feature switch under a key such as `config/search/timeout_ms`, and every search instance would read it from there. [Consul's documentation](https://developer.hashicorp.com/consul/docs/automate/kv) says its key-value store's "main uses are storing configuration parameters and metadata," and warns that it "is not intended to be a full featured datastore."

The registry is one part of discovery. The other part is who reads it, the calling service or something in between. That gives the two styles below.

### Client-side discovery

The calling service queries the registry itself, for example Netflix Eureka or HashiCorp Consul. It gets the list of healthy instances, and picks one using a load-balancing library inside its own process. Netflix's Ribbon library was the classic example. Spring Cloud LoadBalancer has since replaced it, and gRPC clients can do the same thing natively.

- **Pros:** there is no extra hop, since the request goes straight to the chosen instance. The client can balance cleverly, for example by preferring the least-loaded or nearest instance.
- **Cons:** every language in your stack needs a registry client and balancing logic, and all of them need upgrading when either changes.

### Server-side discovery

The calling service sends its request to one stable name or virtual IP address. Something else picks the instance: a load balancer or proxy that reads the registry.

- An AWS Application Load Balancer in front of an autoscaling group works this way. It is a real extra network hop.
- A **Kubernetes Service** works this way too. The name `http://order-service/` resolves through the cluster's DNS to a stable virtual IP. On each node, `kube-proxy` watches the list of healthy pods. It programs kernel rules (iptables or IPVS) that rewrite packets sent to that virtual IP so they go to a real pod's address. No separate proxy process is involved, so the extra hop costs almost nothing.

- **Pros:** application code makes plain HTTP calls to a name. There is nothing to embed and nothing language-specific.
- **Cons:** with a real load balancer, there is one more hop and one more component to scale and keep available. Kubernetes' kernel-level balancing is also simple. It picks a backend once per connection, so long-lived HTTP/2 or gRPC connections can stay stuck to one pod.

## The service mesh and sidecar proxies

As systems grew from a few services to hundreds, teams wanted the same behavior on every internal call:

- mutual TLS (mTLS), so every call is encrypted and both ends prove who they are;
- timeouts, retries with backoff, and circuit breaking;
- the same metrics for every call (request rate, errors, latency);
- tracing across services.

Putting this in shared libraries means one library per language. Every fix, such as a TLS bug, then needs every service to be rebuilt and redeployed. A **service mesh** moves that logic out of the application and into a proxy.

In the classic design, each service instance gets its own **sidecar proxy**, which runs beside it in the same Kubernetes pod. Istio and Consul use Envoy as the sidecar. Linkerd uses its own lightweight proxy, written in Rust. A **control plane** (Istio's is called `istiod`) sends routing rules, policies and short-lived certificates to all the sidecars.

```diagram
title: Sidecar proxies carry every call between two services
[a] Service A @ 0,0
[pa] Sidecar\nproxy A @ 1,0
[pb] Sidecar\nproxy B @ 2.5,0
[b] Service B @ 3.5,0
[cp] Control plane\n(e.g. istiod) @ 1.75,1.3
a -> pa : plain HTTP
pa -> pb : mTLS
pb -> b : plain HTTP
cp --> pa : config
cp --> pb : config
```

1. **Interception.** When the pod starts, an init container (or a CNI plugin) adds iptables rules inside the pod's network namespace. These rules send all inbound and outbound traffic through the sidecar. The application doesn't have to be told to use a proxy.
2. **The app stays simple.** Service A makes a plain HTTP call to `http://service-b/`. Its sidecar picks a healthy instance of B, opens an mTLS connection to B's sidecar, applies the timeout and retry policy, and records metrics.
3. **The receiving side checks the caller.** B's sidecar checks A's certificate and applies access rules, for example "only service A may call this." Then it hands the request to B over localhost.
4. **Any language gets the same behavior.** All of this happens outside the application's process. Services in Go, Java, Python and Node.js behave the same way, and upgrading the proxy fixes a problem for all of them.

Two limits to keep in mind:

- **Tracing still needs the app's help.** The sidecar can record each call, but it can't tell which incoming request caused a given outgoing one. The application must copy the trace headers (such as W3C `traceparent`, or Zipkin's `x-b3-*` headers) from each incoming request to the requests it makes. Istio's documentation says this explicitly.
- **It costs something.** Every call passes through two extra proxies, which adds latency (usually well under a millisecond each). Every pod also runs one more process that uses memory and CPU. That cost led to designs without sidecars, such as Istio's ambient mode, which moves the work into shared proxies on each node.

## Check yourself

<details>
<summary>Crumb runs only one app server. Why might it still put a reverse proxy in front of it?</summary>

Most of a reverse proxy's benefits don't depend on having several servers. With one server behind it, the proxy still:

- hides the server's address and details from the internet, and can block bad IPs and limit connections per client;
- gives Crumb a stable public address, so the server can be moved or replaced without clients noticing;
- terminates SSL, so the app server skips encryption and the certificate lives in one place;
- compresses responses, caches repeated ones, and serves static files (CSS, JavaScript, photos) straight from disk.

A load balancer, by contrast, only makes sense once there are several servers to spread requests across.

</details>

<details>
<summary>What is the difference between a load balancer and a reverse proxy, and can one program be both?</summary>

A load balancer exists to spread requests over several servers that do the same job, and to stop sending requests to servers that fail. A reverse proxy exists to be the single public face of your servers and to take shared work off them: SSL termination, compression, caching, static files and security filtering. It is useful even with one server.

Yes, one program can be both. NGINX and HAProxy can act as a layer 7 reverse proxy and a load balancer at the same time. In NGINX, listing a second server in an `upstream` block turns the reverse proxy into a load balancer too.

</details>

<details>
<summary>What are the disadvantages of adding a reverse proxy, and how do you remove its single point of failure?</summary>

It adds complexity: one more component to configure, monitor, upgrade and debug, and a wrong setting on it affects every request. A single reverse proxy is also a single point of failure. If it goes down, every server behind it is unreachable.

To remove that, run two or more reverse proxies with failover. For example, an active one and a standby exchange heartbeats and share a virtual IP address, and the standby takes the address if the active one stops responding. That fixes the single point of failure but adds still more configuration and testing.

</details>

<details>
<summary>Why can an event-driven proxy like NGINX hold far more idle connections than a thread-per-connection server?</summary>

In the thread-per-connection model, every connection, even an idle keep-alive one, ties up a thread or process: its stack, its kernel bookkeeping, and a place in the scheduler. Memory and context-switching costs grow with the number of connections, not with the amount of work being done. Tens of thousands of mostly idle clients can exhaust the server.

An event-driven proxy runs about one worker per core. Each worker registers its non-blocking sockets with `epoll` or `kqueue` once, sleeps until the kernel reports which ones are ready, and services only those. An idle connection costs some kernel socket state and a small record in the proxy. NGINX quotes about 2.5 MB for 10,000 inactive keep-alive connections. The trade-off is that a worker must never block, since one slow operation stalls every connection it owns.

</details>

<details>
<summary>Crumb launches a mobile app that needs JSON from the same business logic its website uses. Why does separating the web layer from the application layer help?</summary>

With a separate application (platform) layer, the website's web servers and the mobile app both call the same application servers. The new mobile traffic lands on the application layer, so Crumb adds application servers without adding web servers. Each layer can be scaled and configured for its own work, and the cache and database code lives in one place instead of being repeated for every client. Workers in the application layer can also take slow jobs off the request path through a queue.

</details>

<details>
<summary>What does Crumb gain by splitting into microservices, and what new costs does it take on?</summary>

Gains: each service (users, recipes, search, comments, photos) can be deployed on its own, so a search fix doesn't need the whole application rebuilt. Busy services can be scaled separately. A bug is more likely to break one feature than the whole site. Small teams can own their services end to end.

Costs: a different approach to architecture, operations and process; a build, deploy pipeline, monitoring and on-call owner per service; network calls that can fail, which need timeouts and safe retries; harder debugging across services; and data spread across services, which can no longer share one transaction. Uber's post describes engineers working through about 50 services across 12 teams to find the cause of one problem.

</details>

<details>
<summary>How does a service registry such as Consul know which instances are healthy, and what else can it store?</summary>

Each instance registers its service name, address and port. The registry then checks it regularly, often over HTTP: it calls an endpoint such as `/health`, and in Consul a 2xx response means healthy, a 429 is a warning, and anything else is a failure. Failed instances are removed from the list, so callers aren't sent to them. ZooKeeper works differently: an instance registers an ephemeral znode, which disappears when the instance's session ends.

Consul and etcd also include a key-value store. Teams use it for configuration values and other data that many services share, such as timeouts or feature switches.

</details>

<details>
<summary>What is the Backend-for-Frontend (BFF) pattern, and what problem does it solve?</summary>

It gives each kind of client (mobile app, web app) its own thin backend, owned by that client's team, instead of one general-purpose API for everyone. The BFF calls the core services, combines the results, and returns responses shaped for that client: one compact payload per screen for mobile, richer data for the web.

It solves two problems: clients making many round trips over slow networks, and core services filling up with presentation-specific changes requested by each frontend. The costs are more services to operate and a risk of logic being copied across BFFs, so business rules should stay in the core services.

</details>

<details>
<summary>Your gateway verifies JWTs and forwards the user ID in an X-User-Id header. What two mistakes would let an attacker impersonate another user?</summary>

First, the gateway doesn't strip an `X-User-Id` header sent by the client. An attacker sends their own, and it reaches the service unchanged. The gateway must remove or overwrite it.

Second, the services trust that header from anyone who can reach them. An attacker who gets onto the internal network, or finds a service exposed by mistake, can skip the gateway entirely. Services should accept the header only on connections authenticated as the gateway (mTLS is the usual way), or verify the token themselves.

</details>

<details>
<summary>Compare client-side and server-side service discovery. Where does a Kubernetes Service fit?</summary>

In client-side discovery, the caller queries the registry and load balances in its own process. There is no extra hop, but every language needs a registry client and a balancing library. In server-side discovery, the caller sends to a stable name and a load balancer or proxy picks the instance. Clients stay simple, at the cost of an extra component and often an extra hop.

A Kubernetes Service is server-side discovery. The caller uses a stable DNS name and virtual IP and never sees the registry. The balancing is done by kernel rules that `kube-proxy` programs on every node, not by a separate proxy server, so there's almost no added hop. It balances per connection, though, so long-lived gRPC connections may all stick to one pod unless something balances per request.

</details>

<details>
<summary>What does a service mesh sidecar give you over shared networking libraries, and what does it not do for you?</summary>

It moves mTLS, certificate rotation, retries, timeouts, circuit breaking and per-call metrics out of the application into a separate proxy. Every service gets the same behavior whatever language it's written in. You upgrade or fix that behavior by rolling out a new proxy, without rebuilding every service.

It doesn't remove all the work from the application. Services still have to copy trace headers from incoming to outgoing requests for distributed traces to connect, and retries are only safe if the operations being retried are idempotent. It also adds a small latency cost on every hop and a proxy's worth of memory and CPU per pod.

</details>

## Further reading

- [What is a reverse proxy vs. load balancer? (NGINX, archived)](https://web.archive.org/web/20221207025053/https://www.nginx.com/resources/glossary/reverse-proxy-vs-load-balancer): a short, clear explanation of when you need each one, and the reverse proxy benefits listed in this chapter. Archived copy, since the original now redirects.
- [Reverse proxy (Wikipedia)](https://en.wikipedia.org/wiki/Reverse_proxy): a wider list of what reverse proxies are used for, with links to the main software.
- [HAProxy architecture guide (1.2)](http://www.haproxy.org/download/1.2/doc/architecture.txt): Willy Tarreau's worked configurations for cookie persistence, a high-availability pair of load balancers, layer 4 load balancers in front of HAProxy, and SSL handled by Apache or stunnel in front of it. Old, but the patterns still apply.
- [The C10K problem (Dan Kegel)](https://www.kegel.com/c10k.html): the 1999 essay, updated over the following years, surveying ways to serve 10,000 clients from one machine.
- [Inside NGINX: how we designed for performance and scale (NGINX blog, archived)](https://web.archive.org/web/20221128230738/https://www.nginx.com/blog/inside-nginx-how-we-designed-for-performance-scale/): NGINX's master and worker processes and its event loop. Archived copy, since the original now redirects.
- [Envoy architecture overview](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/arch_overview): Envoy's threading model, filter chains and dynamic configuration.
- [gRPC-JSON transcoder filter (Envoy documentation)](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/grpc_json_transcoder_filter): how HTTP and JSON requests are mapped to gRPC calls.
- [Pattern: Backends For Frontends (Sam Newman)](https://samnewman.io/patterns/architectural/bff/): the article that named the pattern.
- [Introduction to architecting systems for scale (Will Larson)](https://lethain.com/introduction-to-architecting-systems-for-scale/): a short classic on load balancing, caching, queues and the platform layer, with the reasons to split it from the web layer.
- [Microservices (James Lewis and Martin Fowler)](https://martinfowler.com/articles/microservices.html): the 2014 article that defined the style and its common traits, ending with a frank section asking whether microservices are the future.
- [Monolith First (Martin Fowler)](https://martinfowler.com/bliki/MonolithFirst.html): why most successful microservice systems began as a monolith.
- [Introducing Domain-Oriented Microservice Architecture (Uber Engineering)](https://www.uber.com/blog/microservice-architecture/): what running about 2,200 microservices cost Uber, and how it grouped them into domains.
- [What are microservices? (SmartBear, archived)](https://web.archive.org/web/20190301065128/https://smartbear.com/learn/api-design/what-are-microservices/): a plain introduction to the traits microservice systems share, such as per-service databases and team ownership. Archived copy, since the original is gone.
- [Microservices (Wikipedia)](https://en.wikipedia.org/wiki/Microservices) and [Service-oriented architecture (Wikipedia)](https://en.wikipedia.org/wiki/Service-oriented_architecture): overviews of microservices and the older style they grew out of, with criticism and history.
- [Building microservices? Here is what you should know (cloudncode)](https://cloudncode.blog/2016/07/22/msa-getting-started/): a practitioner's checklist, including the risk of making services too small and a plain comparison of client-side and server-side discovery.
- [Crack the system design interview (Tian Pan)](https://tianpan.co/notes/2016-02-13-crack-the-system-design-interview): an interview walkthrough that designs Pinterest with load balancers, a reverse proxy and microservices, useful for practicing how to talk about these layers.
- [Consul documentation](https://developer.hashicorp.com/consul/docs): service registration, health checks and the key-value store.
- [etcd](https://etcd.io/) and [ZooKeeper overview](https://zookeeper.apache.org/doc/current/zookeeperOver.html): the official introductions to the other two common registries, including ZooKeeper's ephemeral znodes and watches.
- [Pattern: client-side service discovery (Chris Richardson, microservices.io)](https://microservices.io/patterns/client-side-discovery.html): with links to the server-side variant and the service registry.
- [Service (Kubernetes documentation)](https://kubernetes.io/docs/concepts/services-networking/service/): how Services, virtual IPs and cluster DNS work.
- [Istio architecture](https://istio.io/latest/docs/ops/deployment/architecture/): the data plane of Envoy sidecars and the `istiod` control plane.
