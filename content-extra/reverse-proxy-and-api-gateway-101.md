# Reverse proxy, API gateway, and microservices 101

On your laptop, a client talks straight to your application process on port 8080. In production you almost never let internet clients do that. Exposing every backend service directly means each one has to terminate TLS, check credentials, enforce rate limits and survive whatever the internet throws at it, and clients have to know the address of every service.

Instead, requests come in through a front door: a **reverse proxy**, or its more application-aware relative, an **API gateway**. Behind it, services in a microservice system need a way to find each other as instances come and go, and something has to handle encryption, retries and metrics on every internal call.

The primer covers reverse proxies and microservices briefly. This chapter fills in the parts that come up in design discussions: why event-driven proxies like NGINX and Envoy can hold so many connections, what an API gateway adds on top of a reverse proxy, the Backend-for-Frontend pattern, the two styles of service discovery, and how sidecar proxies grew into the service mesh.

It builds on the primer's [reverse proxy](/learn/reverse-proxy-web-server), [application layer](/learn/application-layer), [load balancer](/learn/load-balancer) and [security](/learn/security) chapters.

## Forward proxy vs reverse proxy

A proxy is a server that makes requests on someone else's behalf. The two kinds differ in whose behalf that is.

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

- **Forward proxy.** Sits in front of a group of clients and sends their outbound requests to the internet for them. Websites see the proxy's IP address, not the clients'. Companies and schools use them to filter and log outbound traffic and, less often now, to cache it.
- **Reverse proxy.** Sits in front of a group of servers and receives inbound requests for them. Clients connect to `api.example.com` and never learn which server answered. The proxy can terminate TLS, spread load across servers, cache responses, compress them, and hide the internal layout of the system.

The same software often does both jobs. What makes it forward or reverse is where it sits and who configured it.

## Concurrency models and the C10K problem

In 1999 Dan Kegel wrote an essay on the **C10K problem**: how to have one server handle 10,000 clients at the same time. Hardware was already fast enough. The bottleneck was how servers used the operating system. The answer shaped every modern proxy, and it's why NGINX, and later Envoy, took over the front-door role from the classic Apache setup.

### Thread (or process) per connection

The traditional model gives each connected client its own operating system thread, or in Apache's old prefork mode, its own process. The thread reads the request, runs the handler, waits on the database, writes the response, and then waits for the client's next request on the same keep-alive connection.

Code written this way is easy to follow, but it scales poorly with the number of connections, even idle ones:

- **Memory.** Each thread reserves stack space. On Linux the default reservation is 8 MB of virtual address space, and the JVM default is 1 MB. Only the pages a thread actually touches use physical RAM, typically tens of kilobytes, but add per-connection buffers and bookkeeping and the total grows with every connection. A prefork process per connection, with an interpreter like PHP loaded into each, often costs several megabytes of real memory each.
- **Scheduling.** Thousands of threads mean the kernel spends a growing share of CPU time switching between them, and caches are cold after each switch.
- **Waste on idle clients.** If 10,000 clients are connected and only 100 are sending anything at this moment, 9,900 threads sit blocked doing nothing while still holding their memory.

### Event-driven, non-blocking I/O

Event-driven servers turn this around. They run a small, fixed number of workers, usually one per CPU core: NGINX uses worker processes, Envoy uses worker threads, and Node.js uses a single event-loop thread. Each worker handles thousands of connections by never blocking on any one of them. It relies on the kernel's readiness notification APIs: **`epoll`** on Linux and **`kqueue`** on the BSDs and macOS.

1. Each socket is set to **non-blocking** mode. A read with no data waiting returns at once with "would block" instead of putting the thread to sleep.
2. The worker registers every socket it owns with the kernel once (`epoll_ctl` on Linux), saying which events it cares about, such as "readable" or "writable".
3. The worker calls `epoll_wait`, which sleeps until at least one registered socket is ready.
4. The kernel returns a list of just the ready sockets. The worker reads, parses and writes as much as it can on each one without blocking, then goes back to step 3.

```diagram
title: One worker's event loop over many non-blocking sockets
[socks:note] Many client\nsockets @ 0,0
[kernel:store] Kernel\n(epoll / kqueue) @ 2,0
[worker] Worker\n(one per core) @ 1,1
socks -> kernel : data arrives
kernel -> worker : ready list
worker -> socks : read / write
```

The cost of an idle connection drops to some kernel socket state and a small per-connection structure in the proxy. The NGINX project's own figure is that 10,000 inactive keep-alive connections take about **2.5 MB** of memory, not counting the kernel's socket buffers. That's why one modest machine running NGINX or Envoy can hold tens or hundreds of thousands of mostly idle connections.

The catch is that nothing in a worker may block. A slow disk read or a CPU-heavy computation stalls every connection on that worker. Proxies are a good fit because their work is mostly moving bytes between sockets. Apache itself later added the `event` MPM, which hands idle keep-alive connections to an event loop for the same reason.

## Reverse proxy vs API gateway

Every API gateway is a reverse proxy, but not every reverse proxy is an API gateway. The line between them is blurry, and products sit all along it: Envoy is used as a plain proxy, a sidecar and a gateway, and NGINX gains gateway features through modules. The table shows the typical emphasis of each.

| Capability | Reverse proxy (NGINX, HAProxy) | API gateway (Kong, AWS API Gateway, Envoy-based gateways) |
|---|---|---|
| **Main job** | Terminate TLS, route and load balance HTTP/TCP, cache, compress. | Manage APIs as a product: who may call what, how often, in what shape. |
| **Configuration** | Mostly files, applied with a graceful reload. | Usually changed through an API or control plane, often per route or per consumer. |
| **Authentication** | TLS, basic auth, maybe a call out to an auth service. | Validating API keys, OAuth 2.0 access tokens and JWTs, checking scopes. |
| **Rate limiting** | Per client IP or per connection. | Per user, API key or pricing plan, often shared across gateway nodes in a store such as Redis. |
| **Transformation** | Headers, compression. | Rewriting requests and responses, JSON to gRPC, request validation against a schema. |
| **Observability** | Access logs and basic metrics. | Per-consumer analytics, distributed tracing, usage reports for billing. |

## Core responsibilities of an API gateway

In a microservice system, the gateway is the single entry point for external traffic. A typical request passes through these steps:

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
2. Authenticate the caller: check the token's signature, expiry and audience.
3. Check rate limits and quotas for that caller.
4. Pick the backend service from the path and method, and load balance across its instances.
5. Add tracing headers, record metrics, forward the request, and pass the response back.

### Central authentication

Without a gateway, every service has to validate tokens itself: parse JWTs, fetch and rotate the identity provider's public keys, and reject bad requests. Doing it in a dozen services written in different languages invites a dozen slightly different bugs.

With a gateway:

1. The gateway verifies the JWT's signature once at the edge. It does this locally with the identity provider's public keys, which it fetches and caches in the background, so a normal request doesn't wait on the identity provider (the dashed edge above).
2. It rejects missing, expired or forged tokens before they reach any service.
3. It passes the caller's identity downstream, for example as an `X-User-Id: 104` header, or by forwarding the verified token itself.

There's a catch with step 3. The gateway must **remove any `X-User-Id` header the client sent**, or a caller could claim to be anyone. And services must accept that header only from the gateway, which is one reason internal traffic is authenticated with mTLS. Many teams also let each service check the token again, so a service exposed by mistake isn't wide open. [Security 101](/learn/security-101) covers tokens and mTLS in detail.

### Protocol translation: HTTP to gRPC

Browsers and third-party developers want HTTP with JSON. Many internal services prefer **gRPC**: it uses Protocol Buffers (a compact binary format) over HTTP/2, and its contracts are typed and generated from a schema.

A gateway can bridge the two. A client sends `GET /v1/users/104`, and the gateway turns it into a `GetUser` gRPC call with `user_id = 104`, then converts the binary reply back to JSON. This is called **gRPC-JSON transcoding**. The mapping is declared in the service's `.proto` file with HTTP annotations, and Envoy, Google Cloud's API gateways and others implement it. External clients get a normal REST API while internal services stay gRPC, and either side can change its internals without the other noticing.

A related option, **gRPC-Web**, lets browser code call gRPC services through a proxy that translates between what browsers can send and full gRPC.

### The Backend-for-Frontend (BFF) pattern

One general-purpose API rarely suits every client:

- A mobile app on a cellular connection wants one small response with exactly the fields one screen needs, because each extra round trip on a slow network is expensive.
- A desktop web app can afford richer responses and may want data from several services at once.

The **Backend-for-Frontend** pattern, named by Sam Newman, gives each kind of client its own thin backend layer, owned by the team that builds that client:

- **Mobile BFF:** calls several internal services, combines the results, and returns one compact response shaped for the app's screens.
- **Web BFF:** returns richer data for the browser app, and can handle web-specific concerns such as session cookies.

Each BFF changes at the pace of its own frontend, and the core services don't fill up with "add this field for the iOS app" changes. The costs are more services to run, and logic that can be duplicated between BFFs if you aren't careful. Keep business rules in the core services and only aggregation and shaping in the BFF.

A public API for third-party developers is usually a separate product with its own versioning, API keys and quotas, often served by the API gateway directly rather than by a BFF.

## Service discovery

On a fixed set of servers, a service can reach its database at a known hostname like `db.internal:5432`. In a cloud or Kubernetes setup, instances are short-lived: autoscalers add and remove them, and the scheduler moves containers between machines, so IP addresses change all the time.

So how does the checkout service find a healthy instance of the order service right now? Every approach has a **service registry**, a list of the live instances of each service, kept current by registration and health checks. The approaches differ in who reads it.

### Client-side discovery

The calling service queries the registry itself, for example Netflix Eureka or HashiCorp Consul, gets the list of healthy instances, and picks one using a load-balancing library in its own process. Netflix's Ribbon library was the classic example. Spring Cloud LoadBalancer has since replaced it, and gRPC clients can do the same thing natively.

- **Pros:** no extra hop, since the request goes straight to the chosen instance. The client can use smart balancing, such as preferring the least-loaded or nearest instance.
- **Cons:** every language in your stack needs a registry client and balancing logic, and they all need upgrading when either changes.

### Server-side discovery

The calling service sends its request to one stable name or virtual IP, and something else picks the instance: a load balancer or proxy that reads the registry.

- An AWS Application Load Balancer in front of an autoscaling group works this way, and it is a real extra network hop.
- A **Kubernetes Service** works this way too. `http://order-service/` resolves through cluster DNS to a stable virtual IP. On each node, `kube-proxy` watches the list of healthy pods and programs kernel rules (iptables or IPVS) that rewrite packets for that virtual IP to a real pod address. No separate proxy process is involved, so the extra hop is close to free.

- **Pros:** application code just makes plain HTTP calls to a name. Nothing to embed, nothing language-specific.
- **Cons:** with a real load balancer, one more hop and one more component to scale and keep available. Kubernetes' kernel-level balancing is also simple: it picks a backend per connection, so long-lived HTTP/2 or gRPC connections can stick to one pod.

## The service mesh and sidecar proxies

As systems grew from a few services to hundreds, teams wanted the same behavior on every internal call:

- mutual TLS (mTLS) so every call is encrypted and both ends are authenticated;
- timeouts, retries with backoff, and circuit breaking;
- consistent metrics for every call (rate, errors, latency);
- tracing across services.

Putting this in shared libraries means one library per language, and every fix, a TLS bug for example, needs a rebuild and redeploy of every service. A **service mesh** moves that logic out of the application and into a proxy.

In the classic design, each service instance gets its own **sidecar proxy**, running beside it in the same Kubernetes pod. Istio and Consul use Envoy as the sidecar. Linkerd uses its own lightweight Rust proxy. A **control plane** (Istio's is called `istiod`) pushes routing rules, policy and short-lived certificates to all the sidecars.

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

1. **Interception.** When the pod starts, an init container (or a CNI plugin) adds iptables rules inside the pod's network namespace so that all inbound and outbound traffic goes through the sidecar. The application doesn't have to be configured to use a proxy.
2. **The app stays simple.** Service A makes a plain HTTP call to `http://service-b/`. Its sidecar picks a healthy instance of B, opens an mTLS connection to B's sidecar, applies the timeout and retry policy, and records metrics.
3. **The receiving side.** B's sidecar checks A's certificate, applies access policy (for example, "only service A may call this"), and hands the request to B over localhost.
4. **Any language.** Because all of this happens outside the process, services in Go, Java, Python and Node.js get the same behavior, and upgrading the proxy fixes it for all of them.

Two limits to keep in mind:

- **Tracing still needs the app's help.** The sidecar can create a span for each call, but it can't tell that an outgoing request was caused by a particular incoming one. The application must copy the trace headers (such as W3C `traceparent`, or Zipkin's `x-b3-*` headers) from each inbound request to the outbound requests it makes. Istio's documentation says this explicitly.
- **It costs something.** Every call passes through two extra proxies, which adds latency (usually well under a millisecond each), and every pod runs one more process using memory and CPU. That cost led to sidecar-less designs such as Istio's ambient mode, which moves the work into shared per-node proxies.

## Check yourself

<details>
<summary>Why can an event-driven proxy like NGINX hold far more idle connections than a thread-per-connection server?</summary>

In the thread-per-connection model, every connection, even an idle keep-alive one, ties up a thread or process: its stack, its kernel bookkeeping, and a place in the scheduler. Memory and context-switching costs grow with the number of connections, not with the amount of work being done, so tens of thousands of mostly idle clients exhaust the server.

An event-driven proxy runs about one worker per core. Each worker registers its non-blocking sockets with `epoll` or `kqueue` once, sleeps until the kernel reports which ones are ready, and services only those. An idle connection costs some kernel socket state and a small structure in the proxy. NGINX quotes about 2.5 MB for 10,000 inactive keep-alive connections. The trade-off is that a worker must never block, since one slow operation stalls every connection it owns.

</details>

<details>
<summary>What is the Backend-for-Frontend (BFF) pattern, and what problem does it solve?</summary>

It gives each kind of client (mobile app, web app) its own thin backend, owned by that client's team, instead of one general-purpose API for everyone. The BFF calls the core services, combines the results, and returns responses shaped for that client: one compact payload per screen for mobile, richer data for the web.

It solves two problems: clients making many round trips over slow networks, and core services filling up with presentation-specific changes requested by each frontend. The costs are more services to operate and a risk of logic being duplicated across BFFs, so business rules should stay in the core services.

</details>

<details>
<summary>Your gateway verifies JWTs and forwards the user ID in an X-User-Id header. What two mistakes would let an attacker impersonate another user?</summary>

First, the gateway doesn't strip an `X-User-Id` header sent by the client, so an attacker sends their own and it reaches the service unchanged. The gateway must remove or overwrite it. Second, the services trust that header from anyone who can reach them, so an attacker who gets onto the internal network, or finds a service exposed by mistake, can skip the gateway entirely. Services should accept the header only on connections authenticated as the gateway (mTLS is the usual way), or verify the token themselves.

</details>

<details>
<summary>Compare client-side and server-side service discovery. Where does a Kubernetes Service fit?</summary>

In client-side discovery, the caller queries the registry and load balances in its own process: no extra hop, but every language needs a registry client and balancing library. In server-side discovery, the caller sends to a stable name and a load balancer or proxy picks the instance: simple clients, at the cost of an extra component and often an extra hop.

A Kubernetes Service is server-side discovery: the caller uses a stable DNS name and virtual IP and never sees the registry. The balancing is done by kernel rules that `kube-proxy` programs on every node, not by a separate proxy server, so there's almost no added hop. It balances per connection, though, so long-lived gRPC connections may all stick to one pod unless something balances per request.

</details>

<details>
<summary>What does a service mesh sidecar give you over shared networking libraries, and what does it not do for you?</summary>

It moves mTLS, certificate rotation, retries, timeouts, circuit breaking and per-call metrics out of the application into a separate proxy. Every service gets identical behavior whatever language it's written in, and you upgrade or fix that behavior by rolling out a new proxy, not by rebuilding every service.

It doesn't remove all the work from the application. Services still have to propagate trace headers from inbound to outbound requests for distributed traces to connect, and retries are only safe if the operations being retried are idempotent. It also adds a small latency cost on every hop and a proxy's worth of memory and CPU per pod.

</details>

## Further reading

- [The C10K problem (Dan Kegel)](https://www.kegel.com/c10k.html): the 1999 essay, updated over the following years, surveying I/O strategies for serving 10,000 clients from one machine.
- [Inside NGINX: how we designed for performance and scale (NGINX blog)](https://www.nginx.com/blog/inside-nginx-how-we-designed-for-performance-scale/): NGINX's master and worker processes and its event loop.
- [Envoy architecture overview](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/arch_overview): Envoy's threading model, filter chains and dynamic configuration.
- [gRPC-JSON transcoder filter (Envoy documentation)](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/grpc_json_transcoder_filter): how HTTP/JSON requests are mapped to gRPC calls.
- [Pattern: Backends For Frontends (Sam Newman)](https://samnewman.io/patterns/architectural/bff/): the article that named the pattern.
- [Pattern: client-side service discovery (Chris Richardson, microservices.io)](https://microservices.io/patterns/client-side-discovery.html): with links to the server-side variant and the service registry.
- [Service (Kubernetes documentation)](https://kubernetes.io/docs/concepts/services-networking/service/): how Services, virtual IPs and cluster DNS work.
- [Istio architecture](https://istio.io/latest/docs/ops/deployment/architecture/): the data plane of Envoy sidecars and the `istiod` control plane.
