# Network protocols and APIs

This chapter answers five questions:

- What happens between "the app sends a request" and "the server gets it", and what are the layers people refer to?
- What does HTTP promise, and what do its methods and status codes mean?
- When should data travel over TCP, and when over UDP?
- How do RPC and REST differ as ways to design an API, and what does each cost?
- Where do gRPC and GraphQL fit, and how do you keep an API usable as it changes?

We'll keep using **Crumb**, the recipe site from [Scalability 101](/learn/scalability-101). Crumb now has a website, a mobile app, app servers behind a load balancer, a memcached layer and a database. Every arrow between those boxes is a conversation between two programs on different machines. The rules for such a conversation are called a **protocol**. The set of requests a server agrees to answer is called its **API** (application programming interface).

## Layers: how one request is built

Think of a letter sent inside several envelopes. You write the letter and put it in an envelope addressed to a person. The mailroom puts that inside a bigger envelope addressed to their building. The postal service adds labels to get it to the right city. Each handler reads only its own envelope and passes the rest along.

Network data is wrapped the same way. When Crumb's app asks for a recipe, the request gets several layers of wrapping on the way out, and the server unwraps them in reverse order. The best-known description of these layers is the **OSI model** (Open Systems Interconnection), published in 1984 as standard ISO 7498 ([Wikipedia](https://en.wikipedia.org/wiki/OSI_model)). It has seven layers, numbered from the wire upward.

| # | Layer | What it does | Unit of data | Examples |
| --- | --- | --- | --- | --- |
| 7 | Application | The conversation the program cares about, such as "give me recipe 456" | Data | HTTP, DNS, SMTP, SSH, DHCP |
| 6 | Presentation | Puts data in a shared format: character encoding, compression, encryption | Data | JSON, gzip, TLS (partly) |
| 5 | Session | Opens, manages and closes a longer conversation | Data | Sockets, RPC |
| 4 | Transport | Carries data from a program on one machine to a program on another, using port numbers | Segment (TCP) or datagram (UDP) | TCP, UDP, QUIC |
| 3 | Network | Gives machines addresses and routes data across many networks | Packet | IP, ICMP |
| 2 | Data link | Moves frames between machines on the same local network | Frame | Ethernet, Wi-Fi |
| 1 | Physical | Turns bits into signals on a cable, a fiber or a radio wave | Bit | Copper, fiber, radio |

Two warnings make the table more useful.

- **The internet uses a simpler model.** Its protocols weren't designed to fit OSI. [RFC 1122](https://www.rfc-editor.org/rfc/rfc1122) (1989) describes four layers: link, internet (IP), transport (TCP or UDP) and application. Its application layer "essentially combines the functions of the top two layers" of OSI, and Wikipedia adds most of the session layer too. In practice, people use the OSI numbers as labels and treat 5 to 7 as one layer.
- **Some protocols sit between layers.** TLS, the encryption behind HTTPS, does presentation-layer work but runs on top of a transport connection. Wikipedia says it "does not strictly fit inside the model."

In system design you'll hear the numbers most often about load balancers. A **layer 4** load balancer routes by IP address and port without reading the request. A **layer 7** load balancer reads the HTTP request, so it can send `/api` to one pool of servers and `/images` to another. [Scalability 101](/learn/scalability-101#load-balancing) covers both.

## HTTP: requests and responses

**HTTP** (Hypertext Transfer Protocol) is a way to encode data and carry it between a client and a server. It is a **request/response** protocol. The client sends a request. The server sends back a response with the content asked for and a status code that says how the request went.

Here is Crumb's app asking for a recipe, followed by the server's answer:

```http
GET /recipes/456 HTTP/1.1
Host: api.crumb.example
Accept: application/json

HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: max-age=60

{"id": "456", "title": "Lemon drizzle cake", "authorId": "1234"}
```

The first line holds the two essentials: a **method**, also called a verb (`GET`), and a **resource**, also called an endpoint (`/recipes/456`). The lines after it are **headers**, which carry extra information such as the format the client wants. A request can also carry a **body**, as a `POST` usually does.

### Every message stands on its own

HTTP is **stateless**. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110), the current definition of HTTP, says "each request message's semantics can be understood in isolation." The server doesn't need to remember earlier requests to understand this one. If Crumb needs to know who is logged in, each request carries that itself, usually in a cookie or a token.

Because each message is self-contained, other machines can sit between client and server and act on it. RFC 9110 calls them **intermediaries**. A load balancer can send each request to a different server. A cache can answer a repeated `GET` itself. A proxy can encrypt or compress traffic. The RFC notes that "many implementations depend on HTTP's stateless design in order to reuse proxied connections or dynamically load balance requests across multiple servers." That is why the stateless app servers from Scalability 101 fit HTTP so well.

### Methods and their properties

Three properties, defined in [RFC 9110 section 9.2](https://www.rfc-editor.org/rfc/rfc9110#section-9.2), decide how clients, caches and proxies may treat a method:

- **Safe** means read-only. The client isn't asking for anything to change, so a search engine crawler can follow safe links without harm.
- **Idempotent** means sending the same request many times has the same intended effect as sending it once. This is what makes a request safe to retry after a timeout.
- **Cacheable** means a cache may store the response and reuse it for later requests.

| Method | What it does | Idempotent | Safe | Cacheable |
| --- | --- | --- | --- | --- |
| GET | Reads a resource | Yes | Yes | Yes |
| POST | Creates a resource, or starts a process that handles the data sent | No | No | Yes if the response contains freshness info |
| PUT | Creates a resource or replaces it completely | Yes | No | No |
| PATCH | Changes part of a resource | No | No | Yes if the response contains freshness info |
| DELETE | Deletes a resource | Yes | No | No |

These values follow RFC 9110 and RFC 5789. Four details are worth knowing:

1. **Cacheable POST and PATCH responses are rare.** RFC 9110 lets a cache store a POST response only if it has explicit freshness information *and* a `Content-Location` header equal to the URL that was posted to. Even then, the copy can answer a later `GET` or `HEAD`, never another `POST`. [RFC 5789](https://www.rfc-editor.org/rfc/rfc5789) sets the same rule for PATCH. RFC 9110 also notes that "the overwhelming majority of cache implementations only support GET and HEAD." In practice, treat only GET as cacheable.
2. **Idempotent doesn't mean the same response.** Deleting recipe 456 twice leaves the same state as deleting it once. The first call might return `204 No Content` and the second `404 Not Found`. RFC 9110 says the effect is the same "though the response might differ."
3. **PATCH can be idempotent.** RFC 5789 says PATCH "is neither safe nor idempotent" in general, because "add 1 to the like count" changes the result each time. "Set the title to X" is idempotent. A client can also make a PATCH conditional, so it fails if the resource changed since the client last read it.
4. **PUT and DELETE clear caches.** Their responses are never cached, and when one succeeds, caches it passes through mark their stored copy of that URL as out of date.

Two more methods are worth knowing. `HEAD` is a `GET` that returns only headers, and `OPTIONS` asks which methods a resource supports. Both are safe.

Idempotence matters because RFC 9110 says a client "SHOULD NOT automatically retry a request with a non-idempotent method" unless it knows the retry is harmless. If Crumb's app sends `POST /recipes` and the connection drops before the reply, the app can't tell whether the recipe was saved. A retry might create a duplicate. [Idempotency keys](#idempotency-keys-make-post-safe-to-retry), later in this chapter, fix that. How caches decide what to store and for how long, using `Cache-Control` and `ETag`, is covered in [DNS and CDN 101](/learn/dns-and-cdn-101#http-caching-headers).

### Status codes

Every response has a three-digit status code. RFC 9110 says "the first digit of the status code defines the class of response":

| Class | Meaning | Common codes |
| --- | --- | --- |
| 1xx | Informational: received, still working | 101 Switching Protocols |
| 2xx | Success | 200 OK, 201 Created, 204 No Content |
| 3xx | Redirection: the client must take another step | 301 Moved Permanently, 304 Not Modified |
| 4xx | Client error: the request is wrong or can't be fulfilled | 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 429 Too Many Requests |
| 5xx | Server error: a valid request failed on the server | 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable |

Two pairs are often confused. **401** means the request "lacks valid authentication credentials", so the client should log in. **403** means the server understood the request and "refuses to fulfill it." **429** comes from [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) and means the client is being rate limited. [Rate limiting](/learn/rate-limiting#telling-the-client) covers how to tell clients that.

The class tells a client whether to retry. A 400 will fail the same way every time. A 503 might succeed later.

### HTTP needs a transport underneath

HTTP is an application-layer protocol. It defines what messages mean and leaves moving the bytes to a lower-level **transport** protocol. For most of its history that has been **TCP**. Since HTTP/3 it can also be **QUIC**, which runs on **UDP**. The next sections cover those transports and then how the HTTP versions use them.

## TCP: reliable delivery, with a price

**TCP** (Transmission Control Protocol) is like registered mail with tracking. Both sides agree to talk before anything is sent. Every piece is numbered, the receiver signs for what arrives, and anything lost is sent again. The receiving program gets all the data in the right order, or learns that the connection failed.

TCP is **connection-oriented** and runs over **IP** (Internet Protocol), which moves single packets between machines with no delivery promise. [RFC 9293](https://www.rfc-editor.org/rfc/rfc9293), the current TCP standard, sums up what TCP adds: "a reliable, in-order, byte-stream service to applications."

### The three-way handshake

Before any data flows, the two sides open a connection with a **three-way handshake**. These numbers come from RFC 9293's own example:

1. **SYN.** The client sends a segment with the SYN ("synchronize") flag set, saying "I'll number my bytes starting at 100."
2. **SYN-ACK.** The server replies with its own SYN, "I'll start at 300", and an ACK ("acknowledge") of 101, meaning "I got your 100 and expect 101 next."
3. **ACK.** The client acknowledges with 301. The connection is open, and the client's next segment can carry data.

The RFC says the main purpose is to stop "old duplicate connection initiations from causing confusion": a stray SYN from an earlier attempt can't open a ghost connection. To close, each side sends a segment with the FIN flag ("no more data from sender") and the other side acknowledges it.

The handshake costs a full round trip before the request can be sent. If a Crumb user is 150 ms away, that's 150 ms before the app has asked for anything. [Performance and latency 101](/learn/performance-and-latency-101#latency-and-throughput) explains why round trips, more than bandwidth, decide how fast small requests are.

### How TCP keeps data intact and in order

RFC 9293 says TCP detects "packet losses (via sequence numbers) and errors (via per-segment checksums)" and corrects them "via retransmission":

- **Sequence numbers** let the receiver put segments back in order and spot gaps.
- **Checksums**, computed from each segment's contents, reveal bits flipped in transit. A damaged segment is dropped.
- **Acknowledgements** tell the sender which bytes arrived.
- **Retransmission** resends data that wasn't acknowledged in time.

TCP doesn't retry forever. After repeated timeouts on the same data, it closes the connection. RFC 9293 says that limit should be at least 100 seconds for data.

### Flow control and congestion control

- **Flow control** protects the receiver. Each segment carries a **window**, the number of bytes its sender "is willing to accept." A slow receiver shrinks its window, and the other side slows to match.
- **Congestion control** protects the network. RFC 9293 requires "slow start, congestion avoidance, and exponential backoff" (detailed in [RFC 5681](https://www.rfc-editor.org/rfc/rfc5681)). A new connection sends a little and speeds up as acknowledgements return. When packets are lost, TCP takes that as a sign of overload and slows down.

Together these let TCP find a good sending rate on its own, without knowing the network's capacity in advance.

### What the guarantees cost

- **Setup time.** The handshake adds a round trip, and TLS adds more (see [below](#tls-and-the-three-versions-of-http)).
- **Waiting for lost data.** TCP delivers bytes in order. If segment 5 is lost, segments 6 to 20 wait until segment 5 is resent, even if they arrived. One missing piece holds up everything behind it. This is called **head-of-line blocking**.
- **Slower sending after a loss**, because congestion control backs off.
- **Memory per connection** on both machines, for buffers and state.

So TCP generally moves data less efficiently than UDP. And because web servers keep many TCP connections open to get high throughput, the memory adds up.

Facebook hit this limit with its cache. In [Scaling Memcache at Facebook](https://www.cs.bu.edu/~jappavoo/jappavoo.github.com/451/papers/memcache-fb.pdf) (NSDI 2013), its engineers wrote that "the high memory demands of open TCP connections makes it prohibitively expensive to have an open connection between every web thread and memcached server." So each web server sends cache writes through a proxy called mcrouter on the same machine. Mcrouter coalesces the connections, so many threads share a few connections to each cache server.

This is **connection pooling**: open a set of connections once and lend them to requests as needed. It saves a handshake per request and caps memory. Crumb does the same for its database, and [Little's law](/learn/performance-and-latency-101#littles-law) tells you how big the pool should be. Facebook also took a second route for cache reads: it moved them to UDP.

### When to use TCP

TCP suits programs that need high reliability and can accept some delay: web servers, database connections, email (SMTP), file transfer (FTP) and remote login (SSH). Use TCP when:

- you need all of the data to arrive intact, and
- you want the protocol to make the best use of the network's capacity for you.

## UDP: fast, with no promises

**UDP** (User Datagram Protocol) is like sending postcards. You address each card and drop it in the box. There's no setup and no tracking. Most cards arrive, some arrive out of order, some never arrive, and nobody tells you.

[RFC 768](https://www.rfc-editor.org/rfc/rfc768) defined UDP in 1980, in three pages. It sends messages "with a minimum of protocol mechanism," and "delivery and duplicate protection are not guaranteed." The header is 8 bytes: source port, destination port, length and checksum. A sender may even skip the checksum.

A UDP message is called a **datagram**, the UDP word for a packet. Each one is handled on its own, and the only promise is at the datagram level: a datagram that arrives is whole. Datagrams may arrive out of order or not at all. UDP has no connection, no retransmission and no congestion control. Without TCP's guarantees there's less work and less waiting, so UDP is generally more efficient.

### Broadcast, and why DHCP needs it

UDP can **broadcast**: send one datagram to every device on the local network. TCP can't, because a TCP connection has exactly two ends.

This solves a chicken-and-egg problem. A laptop joining Wi-Fi uses **DHCP** (Dynamic Host Configuration Protocol) to get an IP address. Until it has one, it can't open a TCP connection to anybody. [RFC 2131](https://www.rfc-editor.org/rfc/rfc2131) says DHCP runs on UDP. The client, with its own address set to zero, broadcasts a DHCPDISCOVER message to the all-ones broadcast address on UDP port 67. Any DHCP server that hears it can reply with an offer.

### Where UDP wins

UDP is less reliable, but it suits real-time uses where fresh data matters more than complete data: voice calls (VoIP), video chat, live streaming and multiplayer games.

Glenn Fiedler explains why in [UDP vs. TCP](https://gafferongames.com/post/udp_vs_tcp/) (2008). A game server sends every player's position many times a second. Over TCP, one lost update holds back the newer ones, which wait in a queue where "you cannot access it until that lost packet has been retransmitted." The game freezes, then jumps. Over UDP, the game uses the newest datagram and moves on. Fiedler advises building only the reliability you need, such as resending important events, on top of UDP yourself.

Facebook's cache reads are a server-side example. The NSDI paper says "we rely on UDP for get requests to reduce latency and overhead," which cut latency by about 20%. At peak, 0.25% of reads were dropped or arrived out of order, and clients treat those as cache misses. Writes and deletes still go over TCP, because losing them isn't acceptable.

### When to use UDP

Use UDP when:

- you need the lowest latency,
- late data is worse than lost data, and
- you're willing to build your own error handling where you need it.

| | TCP | UDP |
| --- | --- | --- |
| Setup | Three-way handshake | None |
| Delivery | Guaranteed, or the connection fails | Best effort |
| Order | Preserved | Not preserved |
| Flow and congestion control | Built in | None |
| Broadcast | No | Yes |
| Typical uses | Web pages and APIs, databases, email, SSH | DHCP, VoIP, video calls, games, QUIC |

## TLS and the three versions of HTTP

### TLS on top of TCP

Plain TCP carries bytes anyone along the path can read. **TLS** (Transport Layer Security) encrypts them and proves the server's identity. HTTPS is HTTP inside TLS inside TCP. TLS runs its own handshake after TCP's. In TLS 1.3 ([RFC 8446](https://www.rfc-editor.org/rfc/rfc8446), 2018) that takes one round trip, and a client returning to a recent server can send data immediately in a "0-RTT" mode, "at the cost of certain security properties." So a new HTTPS connection over TCP spends two round trips before the request goes out. [Security 101](/learn/security-101#in-transit-tls-13) covers what TLS protects.

### HTTP/1.1: keep the connection open

[HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112), first published in January 1997 ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Evolution_of_HTTP)), made **persistent connections** (keep-alive) the default, "allowing multiple requests and responses to be carried over a single connection." That saves a handshake per request.

A persistent connection still handles one exchange at a time in practice. HTTP/1.1 allows **pipelining**, sending several requests without waiting, but the server "MUST send the corresponding responses in the same order." One slow response holds up all the others: head-of-line blocking at the HTTP layer. So clients open several connections to the same server, and RFC 9112 warns that "each connection consumes server resources."

### HTTP/2: many streams on one connection

[HTTP/2](https://www.rfc-editor.org/rfc/rfc9113), standardized in 2015 and revised as RFC 9113 in 2022, splits messages into binary **frames** and gives each request its own **stream**. Frames from many streams are interleaved on one TCP connection. Crumb's recipe page can fetch the recipe, photos and comments at once, and a slow response no longer blocks the others. HTTP/2 also encodes headers compactly.

RFC 9113 states the catch: "TCP head-of-line blocking is not addressed by this protocol." All the streams share one TCP byte stream. When one packet is lost, TCP holds back everything after it, including frames for streams that lost nothing. As the HTTP/3 standard puts it, "a lost or reordered packet causes all active transactions to experience a stall."

### HTTP/3: streams move into the transport

[HTTP/3](https://www.rfc-editor.org/rfc/rfc9114) (2022) keeps HTTP's meaning and runs it over **QUIC** ([RFC 9000](https://www.rfc-editor.org/rfc/rfc9000), 2021). QUIC is a reliable transport that knows about streams, providing "reliability at the stream level and congestion control across the entire connection." In MDN's words, "only the stream with data in that packet is blocked." QUIC also:

- **builds in TLS 1.3**, so the transport and encryption handshakes happen together instead of one after the other, and
- **identifies a connection by an ID** instead of an IP address and port, so a phone can move from Wi-Fi to mobile data without starting over.

Why build reliability on top of unreliable UDP? RFC 9000 says QUIC uses UDP "to better facilitate deployment in existing systems and networks." Routers, firewalls and operating systems already pass UDP. A new transport protocol would be blocked by many of them. A server advertises HTTP/3 with an `Alt-Svc` response header, and the client switches on later requests.

```diagram
title: What each HTTP version runs on. HTTP/3 moves streams and encryption into QUIC.
[h1] HTTP/1.1 @ 0,0
[t1] TLS @ 0,1
[tcp1] TCP @ 0,2
[h2] HTTP/2\nstreams in frames @ 2,0
[t2] TLS @ 2,1
[tcp2] TCP @ 2,2
[h3] HTTP/3 @ 4,0
[q] QUIC\nstreams + TLS 1.3 @ 4,1
[udp] UDP @ 4,2
h1 -> t1
t1 -> tcp1
h2 -> t2
t2 -> tcp2
h3 -> q
q -> udp
```

All three versions share the same methods, status codes and headers. When Crumb's load balancer starts speaking HTTP/3 to phones, the API code doesn't change.

## RPC: calling a function on another machine

In a **remote procedure call** (RPC), a client makes a procedure run in a different address space, usually on a remote server. The call is written as if it were local, and the details of reaching the server are hidden from the client program. On Crumb, an API server might get nutrition facts from a separate nutrition service like this:

```python
facts = nutrition.get_facts(recipe_id="456")
```

It reads like a local function call, but it behaves differently. A local call takes nanoseconds and never half-fails. A remote call takes milliseconds, can time out, and can fail after the server already did the work. Because remote calls are slower and less reliable, it helps to make them easy to tell apart from local calls, for example by naming and by giving every call an explicit timeout.

### How a call travels

Generated code called **stubs** makes the remote call look local. A call goes through these steps:

1. **Client program.** It calls the client stub. The arguments are pushed onto the stack, just as for a local call.
2. **Client stub.** It **marshals** (packs) the procedure's identifier and the arguments into a request message.
3. **Client communication module.** The operating system sends the message to the server.
4. **Server communication module.** The server's operating system passes the incoming packets to the server stub.
5. **Server stub.** It **unmarshals** (unpacks) the message and calls the procedure matching the identifier, passing the arguments.
6. **The reply** repeats these steps in reverse, back to the client program.

```diagram
title: RPC. Stubs on each side make a remote call look like a local one.
[cp:client] Client program @ 0,0
[cs] Client stub @ 1.5,0
[cn] Client OS\nand network @ 3,0
[sp] Server procedure @ 0,1.5
[ss] Server stub @ 1.5,1.5
[sn] Server OS\nand network @ 3,1.5
cp <-> cs
cs <-> cn
cn <-> sn : request / reply
sn <-> ss
ss <-> sp
```

Tyson Trautmann's [Debunking the Myths of RPC & REST](https://web.archive.org/web/20170608193645/http://etherealbits.com/2012/12/debunking-the-myths-of-rpc-rest/) (2012) adds that "nothing about RPC is inherently bound to HTTP." RPC can use HTTP to carry messages, or its own protocol.

Frameworks generate the stubs from a description of the service. Three popular ones:

- **[Protocol Buffers](https://protobuf.dev/overview/)** (Protobuf), from Google, is "a language-neutral, platform-neutral extensible mechanism for serializing structured data," "like JSON, except it's smaller and faster." gRPC uses it.
- **[Apache Thrift](https://thrift.apache.org/)** pairs a data format with "a code generation engine" for many languages. Facebook [built it in 2006](https://engineering.fb.com/2014/02/20/open-source/under-the-hood-building-and-open-sourcing-fbthrift/) and open-sourced it in 2007.
- **[Apache Avro](https://avro.apache.org/docs/)** is "a data serialization system" that also supports RPC. Data files carry their schema, so "code generation is not required."

### What RPC calls look like over HTTP

The URL names an action:

```http
GET /getRecipe?recipeId=456

POST /rateRecipe
Content-Type: application/json

{"recipeId": "456", "userId": "1234", "stars": 5}
```

RPC is focused on exposing **behaviors**. It is often used for internal communication for performance reasons, because you can hand-craft calls to fit each use case and use a compact binary format.

The same reasoning applies to offering a **native library** (an SDK) that customers call from their own code. Choose one when:

- you know the platform your users are on,
- you want to control how your logic is accessed,
- you want to control how errors are handled on the library's side, and
- performance and the end user's experience are your main concern.

For public APIs called by unknown developers in any language, HTTP APIs in the REST style are more common.

### gRPC: RPC over HTTP/2

Google long used an internal RPC system called Stubby. In March 2015 it [decided to build the next version as open source](https://grpc.io/about/), called **gRPC**. It lets a client "call a method on a server application on a different machine as if it were a local object" ([introduction](https://grpc.io/docs/what-is-grpc/introduction/)). You describe the service in a `.proto` file:

```text
syntax = "proto3";

service NutritionService {
  rpc GetFacts (GetFactsRequest) returns (NutritionFacts);
  rpc WatchPrices (WatchPricesRequest) returns (stream IngredientPrice);
}

message GetFactsRequest {
  string recipe_id = 1;
}
```

A compiler generates client and server code in each language. On the wire, gRPC [runs over HTTP/2](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md): every call is a `POST` to a path like `/NutritionService/GetFacts`, with content type `application/grpc` and a body of length-prefixed Protobuf messages. The result code arrives in **trailers**, headers sent after the body.

HTTP/2 streams give gRPC [four kinds of method](https://grpc.io/docs/what-is-grpc/core-concepts/):

| Kind | What happens | Crumb example |
| --- | --- | --- |
| Unary | One request, one response | Get a recipe's nutrition facts |
| Server streaming | One request, a stream of responses | Watch ingredient prices change |
| Client streaming | A stream of requests, one response | Upload a recipe video in chunks |
| Bidirectional streaming | Both sides stream independently | A live cook-along session |

gRPC also builds in two habits remote calls need. **Deadlines** let the client say how long it will wait, after which the call fails with `DEADLINE_EXCEEDED`. **Cancellation** lets either side stop a call, though "changes made before a cancellation are not rolled back."

Browsers can't call gRPC directly, because "raw HTTP/2 frames are inaccessible in browsers" ([gRPC blog](https://grpc.io/blog/state-of-grpc-web/)). The workaround, gRPC-Web, needs a translating proxy. So most teams use gRPC between their own services and JSON over HTTP for browsers, often with an API gateway translating between them ([Reverse proxy and API gateway 101](/learn/reverse-proxy-and-api-gateway-101#protocol-translation-http-to-grpc)).

### Disadvantages of RPC

- **Clients become tightly coupled to the service.** Clients call specific procedures with specific arguments. If the nutrition team renames `GetFacts` or changes its arguments, clients must be rebuilt and redeployed in step.
- **Every new operation needs a new API.** Facts for ten recipes at once means a new `GetFactsBatch`. Trautmann warns that hand-rolled interfaces tend to be "too narrow for future use cases," leading to "an explosion in the number of methods."
- **RPC can be hard to debug.** Binary messages can't be read in a log or replayed with `curl`.
- **Existing tools may not work out of the box.** An HTTP cache such as [Squid](http://www.squid-cache.org/) understands `GET` and URLs. Trautmann notes that RPC inputs may not be passed "in a standard way that makes it possible to map requests to cached responses," so caching RPC results takes extra work. gRPC sends every call as a `POST`, so standard HTTP caches won't store any of them.

## REST: resources and representations

**REST** (Representational State Transfer) is an architectural style, meaning a set of design rules a system can follow. Roy Fielding defined it in [chapter 5 of his 2000 dissertation](https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm).

REST uses a client/server model. The client acts on a set of **resources** that the server manages. Fielding says "any information that can be named can be a resource": a recipe, a user, a user's saved recipes. The server provides **representations** of resources, such as a JSON document describing a recipe, and actions that either change resources or return new representations.

All communication must be **stateless** and **cacheable**. Each request "must contain all of the information necessary to understand the request," and responses must be labeled as cacheable or not, so clients and intermediaries know when they can reuse one.

### The four qualities of a RESTful interface

Fielding's central rule is a **uniform interface**: every resource is handled the same way. It has four parts:

| Quality | Over HTTP | In practice |
| --- | --- | --- |
| Identify resources | URIs | Each resource has one URI, used whatever the operation. `/recipes/456` is read, replaced and deleted at the same address. |
| Change resources through representations | Methods, headers and body | The method says what to do, headers describe the format, the body carries the representation. |
| Self-descriptive messages | Status codes | Use the standard status codes. Don't reinvent the wheel with your own error scheme. |
| HATEOAS: hypermedia as the engine of application state | HTML and links | Responses link to what the client can do next. A website is the model: the whole service is usable from a browser by following links. |

Most APIs that call themselves REST skip the last one. Fielding complained in 2008 about "the number of people calling any HTTP-based interface a REST API" ([REST APIs must be hypertext-driven](https://roy.gbiv.com/untangled/2008/rest-apis-must-be-hypertext-driven)). His rule is that "a REST API should be entered with no prior knowledge beyond the initial URI." A client that follows links instead of building URLs keeps working when the server reorganizes them.

### What REST calls look like

```http
GET /recipes/456

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "456",
  "title": "Lemon drizzle cake",
  "links": {"author": "/users/1234", "comments": "/recipes/456/comments"}
}

PUT /recipes/456
Content-Type: application/json

{"title": "Lemon drizzle cake (gluten-free)", "servings": 8}
```

The URLs are nouns and the method carries the action. REST is focused on exposing **data**.

### Why REST suits public APIs

- **It minimizes coupling.** A client needs only the URIs and the standard methods. Crumb can change how it stores recipes without any client noticing, so REST is the usual choice for public HTTP APIs.
- **It is uniform.** Resources are exposed through URIs, [representations are described in headers](https://github.com/for-GET/know-your-http-well/blob/master/headers.md), and actions use the verbs GET, POST, PUT, DELETE and PATCH. Browsers, `curl`, caches, CDNs and proxies already understand all of it.
- **It scales.** Because requests are stateless, any server can handle any request. That makes REST services easy to scale horizontally behind a load balancer and to partition across servers. Fielding lists scalability among the benefits of statelessness.

### Disadvantages of REST

- **Not every question fits a resource path.** REST works best when data forms a simple hierarchy, like `/users/1234/recipes`. "Every recipe updated in the past hour that matches these dietary tags" doesn't. It ends up as a mix of path, query parameters and maybe a request body: `GET /recipes?updatedSince=2026-10-17T09:00Z&tags=vegan`.
- **A few verbs may not fit the action.** "Move all expired recipes into the archive" isn't clearly a create, replace or delete. Teams fall back on workarounds like `POST /recipes/archive-jobs`.
- **Nested data takes many round trips.** One recipe page might need the recipe, then its author, then its comments: several requests, often one after another. On a phone with a weak signal, each round trip hurts.
- **Responses grow.** As fields are added over time, old clients receive all of them, including ones they never use. Payloads get bigger and slower.

Fielding named the trade-off himself: "a uniform interface degrades efficiency, since information is transferred in a standardized form rather than one which is specific to an application's needs."

## RPC and REST side by side

The same operations on Crumb, designed both ways. User 1234 saves recipe 456 to their list.

| Operation | RPC | REST |
| --- | --- | --- |
| Sign up | `POST /signup` | `POST /users` |
| Close an account | `POST /closeAccount` with `{"userId": "1234"}` | `DELETE /users/1234` |
| Read a user | `GET /getUser?userId=1234` | `GET /users/1234` |
| Read a user's saved recipes | `GET /getSavedRecipes?userId=1234` | `GET /users/1234/saved-recipes` |
| Save a recipe | `POST /saveRecipe` with `{"userId": "1234", "recipeId": "456"}` | `POST /users/1234/saved-recipes` with `{"recipeId": "456"}` |
| Update a saved recipe's note | `POST /updateSavedRecipe` with `{"userId": "1234", "recipeId": "456", "note": "less sugar"}` | `PUT /users/1234/saved-recipes/456` with `{"note": "less sugar"}` |
| Remove a saved recipe | `POST /unsaveRecipe` with `{"userId": "1234", "recipeId": "456"}` | `DELETE /users/1234/saved-recipes/456` |

RPC names every action, so the endpoint list grows with each feature. REST keeps a small set of resource URLs and lets the method do the work. REST's methods also tell intermediaries something: a cache knows it can store the `GET`, and a retry library knows the `PUT` and `DELETE` are safe to repeat. Every RPC write is a `POST`, which tells them nothing.

Arnaud Lauret's [Do you really know why you prefer REST over RPC?](https://apihandyman.io/do-you-really-know-why-you-prefer-rest-over-rpc/) (2015) argues that neither wins in general. RPC can be easier when you mostly expose operations, and REST when you "deal mainly with data." One API can mix both.

## GraphQL: the client picks the fields

Two of REST's problems have names. **Over-fetching** means getting fields you don't need. **Under-fetching** means getting too little per response, so you need more round trips. **GraphQL** addresses both. Its [introduction](https://graphql.org/learn/introduction/) defines it as "a query language for your API, and a server-side runtime for executing queries using a type system you define for your data."

A GraphQL server usually has [a single endpoint, typically `/graphql`](https://graphql.org/learn/serving-over-http/). The client sends a query shaped like the data it wants, so Crumb's recipe page becomes one request:

```text
{
  recipe(id: "456") {
    title
    author { name }
    comments(first: 10) { text author { name } }
  }
}
```

The client gets "just that data in the expected shape with a single request." A phone can ask for fewer fields than the website, and old clients never receive fields added later. Instead of versions, you add fields and mark old ones `@deprecated` until nobody uses them.

The costs:

- **HTTP caching is harder.** The [caching guide](https://graphql.org/learn/caching/) notes "there's no URL-like primitive" identifying each object. Writes must use `POST`, and long queries can exceed URL limits for `GET`.
- **Status codes say less.** A response with some data and some errors still returns 2xx, because "HTTP does not yet have a status code representing 'partial success.'"
- **One query can fan out** to many tables and services, so the server must resolve each field efficiently.

If you only need a tailored response for one kind of client, a **Backend for Frontend** (BFF) is an alternative: a small server per client type that calls your APIs and returns what each screen needs ([Reverse proxy and API gateway 101](/learn/reverse-proxy-and-api-gateway-101#the-backend-for-frontend-bff-pattern)).

## Designing an API that lasts

### Versioning

Once an app is on millions of phones, you can't update every client at once, so you need to know which changes break them. GitHub's [versioning policy](https://docs.github.com/en/rest/about-the-rest-api/api-versions) is a clear model. "Adding an optional parameter" is additive and appears in every supported version. "Removing or renaming a parameter" or "changing the type of a parameter or response field" is breaking, so it goes into a new version.

Three common ways to choose a version:

- **In the URL**, such as `/v2/recipes/456`. Simple and visible, but each version is a new set of URLs.
- **In a header.** GitHub uses `X-GitHub-Api-Version` with date-based names and supports old versions "for at least 24 more months." [Stripe](https://docs.stripe.com/api/versioning) uses `Stripe-Version`, releasing monthly versions without breaking changes and a breaking major version twice a year.
- **Never break**, only add. GraphQL takes this approach, and Protobuf supports it: old code "will read new messages without issues, ignoring any newly added fields" ([overview](https://protobuf.dev/overview/)).

### Pagination

"List recipe 456's comments" can't return a million rows. APIs return a page plus a way to get the next. Offsets (`?offset=40&limit=20`) are simple but get slower deep in a list and can skip or repeat items as new ones arrive. A cursor, an opaque token pointing just past the last item seen, avoids both. [Designing a social news feed](/learn/design-social-news-feed#cursor-based-pagination-why-offsets-fail) explains in detail.

### Idempotency keys make POST safe to retry

To make a `POST` safe to retry, the client generates a unique **idempotency key** per operation and sends it with every attempt, usually in an `Idempotency-Key` header. The server stores the result under that key and, on a repeat, returns the stored result instead of doing the work again. [Stripe's rules](https://docs.stripe.com/api/idempotent_requests) are a good template:

- Keys should be V4 UUIDs or similarly random strings, up to 255 characters.
- The first result is saved and replayed on retries, "including `500` errors."
- A retry whose parameters differ from the original's gets an error, which catches reused keys.
- Keys may be removed once they are at least 24 hours old.
- `GET` and `DELETE` don't need keys, because they "are idempotent by definition."

An IETF draft to standardize the [Idempotency-Key header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) expired without becoming an RFC, so it remains a convention. [Reliability patterns](/learn/reliability-patterns#idempotency-keys) shows how to store and replay results.

## Choosing between REST, gRPC and GraphQL

| | REST over HTTP | gRPC | GraphQL |
| --- | --- | --- | --- |
| Models the API as | Resources (nouns) | Procedures (verbs) | A typed graph the client queries |
| Wire format | Usually JSON | Protobuf (binary) | JSON |
| HTTP caching and CDNs | Works for GET | Not with standard caches | Harder |
| Browsers | Native | Needs gRPC-Web and a proxy | Native |
| Streaming | Not built in (see [realtime](/learn/realtime)) | Four kinds built in | Subscriptions, if the server supports them |
| Debugging | Readable text, `curl` | Needs gRPC tools | Readable, but one URL for everything |
| Best for | Public APIs, simple CRUD, cache-heavy reads | Internal service calls, low latency, many languages | Varied clients, nested data |

Crumb uses each where it fits. The public API and website use REST over HTTPS, so the CDN can cache `GET /recipes/456`. Internal services call each other with gRPC, with deadlines on every call. The mobile app could move to GraphQL or a BFF if nested REST calls become a real cost. Live features, like a new comment appearing as you read, need a long-lived connection, which [Realtime](/learn/realtime) covers.

```diagram
title: Crumb uses a different protocol on each hop.
[app:client] App and\nbrowser @ 0,0
[lb] Load balancer @ 1,0
[api] API servers @ 2,0
[svc] Nutrition and\nsearch services @ 4,0
[mc:store] Memcached @ 2,1.3
[db:store] Database @ 4,1.3
app -> lb : HTTPS
lb -> api
api -> svc : gRPC
api -> mc : pooled TCP
api -> db : pooled TCP
```

## Check yourself

<details>
<summary>Crumb's app sends <code>POST /recipes</code> to publish a recipe, and it times out with no response. Should the app retry automatically? What would make a retry safe?</summary>

Not as things stand. POST isn't idempotent, and RFC 9110 says clients shouldn't automatically retry non-idempotent requests. The first request may have succeeded with only the reply lost, so a retry could publish the recipe twice. The fix is an idempotency key. The app generates a UUID when the user taps "Publish" and sends it with every attempt. The server saves the result under that key and returns it on a retry instead of creating a second recipe.

</details>

<details>
<summary>A teammate says PATCH responses are cacheable, so the CDN should cache <code>PATCH /recipes/456</code>. What's wrong with that?</summary>

RFC 5789 lets a PATCH response be cached only with explicit freshness information and a `Content-Location` header matching the URL. Even then, it can only answer later `GET` or `HEAD` requests, never another PATCH. Most caches only support GET and HEAD anyway. A PATCH that passes through a cache also marks the stored copy of `/recipes/456` as stale. Cache the GET responses instead, and let PATCH invalidate them.

</details>

<details>
<summary>Crumb is adding a live cook-along where the host's video reaches viewers with as little delay as possible. TCP or UDP for the video, and why?</summary>

UDP, or a protocol built on it. For live video, a late frame is worse than a missing one. With TCP, one lost packet holds back everything after it until it is resent, and congestion control slows sending after the loss. With UDP, the player skips the gap and shows the newest frames, and the application adds error correction only where it matters. Sign-in and chat messages around the session can still use TCP, because they must arrive intact.

</details>

<details>
<summary>Crumb's recipe page loads over HTTP/2. On a lossy mobile network, the text, photos and comments all stall together whenever one packet is lost. Why, and what would help?</summary>

HTTP/2 sends them as separate streams, but they share one TCP connection. TCP delivers bytes strictly in order, so one lost packet holds back all later bytes, including those for streams that lost nothing. RFC 9113 says HTTP/2 doesn't address TCP head-of-line blocking. HTTP/3 does. It runs over QUIC, which recovers losses per stream, so a lost packet blocks only the streams whose data it carried. Crumb can enable HTTP/3 at its load balancer or CDN and advertise it with an `Alt-Svc` header.

</details>

<details>
<summary>Design REST endpoints for Crumb's comments: list a recipe's comments, add one, edit one and delete one. Then name an operation that doesn't fit REST cleanly.</summary>

One reasonable design:

- `GET /recipes/456/comments?cursor=...` lists comments a page at a time.
- `POST /recipes/456/comments` adds one and returns `201 Created` with a `Location` such as `/comments/789`.
- `PATCH /comments/789` edits one, returning `403` if the caller didn't write it.
- `DELETE /comments/789` deletes one and returns `204`.

"Hide every comment by a spammer across all recipes" doesn't fit. It isn't one resource, and no standard verb matches it. Teams usually model it as a new resource, such as `POST /moderation-actions` with `{"type": "hide_all", "userId": "666"}`.

</details>

<details>
<summary>Crumb's API servers call the nutrition service 2,000 times a second. REST with JSON or gRPC? What do you gain and give up?</summary>

gRPC fits a high-volume internal call between services Crumb controls. Protobuf is smaller and faster than JSON, HTTP/2 lets many calls share a connection, the `.proto` file gives both teams a contract with generated code, and deadlines are built in. The costs are tighter coupling and harder debugging. Changing `GetFacts` means regenerating clients, so the team should only ever add fields, and debugging needs gRPC tools instead of `curl`. If browsers ever need the service, an API gateway can translate JSON over HTTP into gRPC.

</details>

## Further reading

Specifications:

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110): the definitive source for methods and status codes. Section 9 covers methods.
- [RFC 9293: TCP](https://www.rfc-editor.org/rfc/rfc9293): the 2022 TCP standard. Section 3.5 has the handshake example used above.
- [RFC 768: UDP](https://www.rfc-editor.org/rfc/rfc768): all of UDP in three pages.
- [RFC 9113 (HTTP/2)](https://www.rfc-editor.org/rfc/rfc9113) and [RFC 9114 (HTTP/3)](https://www.rfc-editor.org/rfc/rfc9114): their introductions explain in a few paragraphs why each version exists.
- [RFC 5789: PATCH](https://www.rfc-editor.org/rfc/rfc5789): short, and clear on why PATCH is neither safe nor idempotent.

HTTP, TCP and UDP:

- [Evolution of HTTP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Evolution_of_HTTP): MDN's history from HTTP/0.9 to HTTP/3.
- [What is HTTP?](https://www.f5.com/glossary/hypertext-transfer-protocol-http): a short glossary entry from F5. The old NGINX link redirects here.
- [What's the difference between PUT and PATCH?](https://laracasts.com/discuss/channels/general-discussion/whats-the-differences-between-put-and-patch?page=1): a forum thread with practical examples of full and partial updates.
- [UDP vs. TCP](https://gafferongames.com/post/udp_vs_tcp/): Glenn Fiedler on why real-time games avoid TCP.
- [Difference between TCP and UDP](https://stackoverflow.com/questions/5970383/difference-between-tcp-and-udp): a Stack Overflow thread with short, clear answers.
- [Transmission Control Protocol](https://en.wikipedia.org/wiki/Transmission_Control_Protocol) and [User Datagram Protocol](https://en.wikipedia.org/wiki/User_Datagram_Protocol): Wikipedia's articles, with header diagrams and connection states.
- [Scaling Memcache at Facebook](https://www.cs.bu.edu/~jappavoo/jappavoo.github.com/451/papers/memcache-fb.pdf): the NSDI 2013 paper. Section 3.1 covers UDP reads, TCP writes and shared connections.

RPC and REST:

- [Fielding's dissertation, chapter 5](https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm): the original definition of REST, readable without the rest of the dissertation.
- [REST APIs must be hypertext-driven](https://roy.gbiv.com/untangled/2008/rest-apis-must-be-hypertext-driven): Fielding on what most "REST" APIs leave out.
- [Do you really know why you prefer REST over RPC?](https://apihandyman.io/do-you-really-know-why-you-prefer-rest-over-rpc/): Arnaud Lauret's operation-by-operation comparison.
- [Debunking the Myths of RPC & REST](https://web.archive.org/web/20170608193645/http://etherealbits.com/2012/12/debunking-the-myths-of-rpc-rest/): Tyson Trautmann on why HTTP caching works for REST and not for RPC (archived copy).
- [REST vs JSON-RPC?](https://stackoverflow.com/questions/15056878/rest-vs-json-rpc): a Stack Overflow discussion of the trade-offs.
- [Why REST for internal use and not RPC](https://web.archive.org/web/20221030091901/https://arstechnica.com/civis/viewtopic.php?t=1190508): an Ars Technica forum thread on the same question for internal services (archived copy).
- [HATEOAS](https://web.archive.org/web/20260820115227/https://www.restcookbook.com/Basics/hateoas/): the REST Cookbook's short page on hypermedia links (archived copy).
- [Know your HTTP headers](https://github.com/for-GET/know-your-http-well/blob/master/headers.md): a table of HTTP headers with links to the specs that define them.
- [Crack the system design interview](https://tianpan.co/notes/2016-02-13-crack-the-system-design-interview): an interview walkthrough of a photo-sharing service, including how services find each other. The old puncsky.com link redirects here.
- [Building and open-sourcing fbthrift](https://engineering.fb.com/2014/02/20/open-source/under-the-hood-building-and-open-sourcing-fbthrift/): Facebook's account of where Thrift came from.

gRPC, GraphQL and API design:

- [gRPC core concepts](https://grpc.io/docs/what-is-grpc/core-concepts/) and [gRPC over HTTP/2](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md): the method kinds, deadlines, and how calls map onto HTTP/2.
- [The state of gRPC in the browser](https://grpc.io/blog/state-of-grpc-web/): why browsers need gRPC-Web and a proxy.
- [Introduction to GraphQL](https://graphql.org/learn/introduction/) and [GraphQL caching](https://graphql.org/learn/caching/): the official guide, including where caching gets harder.
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests), [Stripe versioning](https://docs.stripe.com/api/versioning) and [GitHub API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions): real public APIs' rules, worth copying.
