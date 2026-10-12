# Real-time updates: polling, WebSockets and server-sent events

Plain [HTTP](/learn/communication#hypertext-transfer-protocol-http) is request/response: the client asks, the server answers, and the server has no way to speak first. Plenty of features need the server to speak first. Examples include a chat message arriving, a delivery driver's position changing, a build finishing or a stock price ticking. This chapter covers the ways to push updates from server to client, what each costs, and what changes when you hold millions of connections open at once.

It comes up whenever an interview question has the word "live" in it: chat, collaborative editing, live comments, dashboards, multiplayer games, ride tracking. Interviewers usually want two things. First, a sensible choice of transport with a reason. Second, an answer to the harder question: once a user is connected to one of your 200 gateway servers, how does a message produced somewhere else in your system find that server?

## The four main techniques

### Short polling

The client asks "anything new?" on a timer, say every 5 seconds. The server answers right away, usually with "no".

It's trivially simple and works through every proxy, cache and load balancer ever built. The cost is waste and delay. Most requests return nothing but still carry full HTTP headers and pass through your auth and routing layers. An update waits on average half the interval before anyone sees it. With 1 million clients polling every 5 seconds you take 200,000 requests per second (1,000,000 / 5) just to say "nothing new". Short polling is fine when updates are rare, a few seconds of lag is acceptable, and the client count is modest.

### Long polling

The client sends a request and the server holds it open until it has something to say or a timeout passes (often 20–60 seconds). The server responds, and the client immediately sends the next request.

Updates now arrive almost as soon as they happen, and empty responses only happen at the timeout. It still works anywhere HTTP works, which is why it was the standard technique before WebSockets and why many libraries still use it as a fallback. The catches:

- There's a gap between one response and the next request. Messages produced in that gap must be buffered on the server, and the client should send a cursor ("give me everything after message 1841") so nothing is lost or repeated.
- Each held request ties up a connection, and with some server designs a thread. That's fine with an event-driven server and painful with one thread per request.
- Timeouts on proxies and load balancers have to be longer than your hold time, or they cut the request off.

[RFC 6202](https://www.rfc-editor.org/rfc/rfc6202) documents these issues in detail.

### Server-sent events (SSE)

The client opens one HTTP request and the server never finishes the response. It writes events down it as they happen, in a simple text format (`text/event-stream`). Browsers expose this as the `EventSource` API.

```text
id: 1842
event: order-status
data: {"orderId": 77, "status": "out_for_delivery"}

```

SSE is one-directional, server to client. The client sends anything else as ordinary HTTP requests. In return you get features that you would otherwise build yourself. The browser reconnects automatically when the stream drops. On reconnect it sends the last `id` it saw in a `Last-Event-ID` header, so the server can resume from the right place. The server can also set the retry delay with a `retry:` field.

The limits are worth knowing:

- Data is UTF-8 text only, so binary payloads need encoding.
- The browser `EventSource` API can't set custom request headers, so auth usually rides on cookies or a token in the URL.
- Over HTTP/1.1, browsers allow about six connections per host, and each open stream uses one. HTTP/2 removes the problem by carrying many streams over one connection.
- Proxies that buffer responses can hold events back. You may need to turn buffering off for the stream endpoint.

### WebSockets

A WebSocket ([RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)) starts as an HTTP/1.1 request with an `Upgrade: websocket` header. The server answers `101 Switching Protocols`, and from then on the [TCP](/learn/communication#transmission-control-protocol-tcp) connection carries a framed, full-duplex protocol, so either side can send at any time. Frames are text or binary, and the per-frame header is small: 2 bytes for a short server-to-client frame, up to 14 bytes in the worst case (client frames add a 4-byte masking key). There are also ping and pong control frames for keep-alives. WebSockets can run over HTTP/2 ([RFC 8441](https://www.rfc-editor.org/rfc/rfc8441)) and HTTP/3 too, though HTTP/1.1 upgrade is still the most common path.

That makes WebSockets the default for genuinely two-way, chatty traffic: chat with typing indicators, games, collaborative cursors. What you don't get is everything above the frame layer. There's no automatic reconnection, no resume-from-message-id, no request/response correlation and no delivery acknowledgement. Every serious WebSocket app builds a small protocol on top: message ids, acks, heartbeats and a reconnect-and-catch-up routine.

### Two newer options, briefly

- **WebTransport** runs over HTTP/3 (QUIC). It gives you multiple independent streams, which avoids head-of-line blocking between them, plus unreliable datagrams. It's promising for games and media, but browser support and server tooling are newer and less uniform than for WebSockets.
- **WebRTC** connects browsers peer to peer for audio, video and data channels. You still need a server for signaling (often a WebSocket) and STUN/TURN servers to get through NATs. Reach for it when clients should talk to each other directly, not to stream server updates.

## Comparing them

| | Short polling | Long polling | SSE | WebSockets |
|---|---|---|---|---|
| Direction | Client pulls | Client pulls, server answers when ready | Server to client | Both ways |
| Latency of an update | Up to the poll interval | Near-immediate, plus a gap between requests | Near-immediate | Near-immediate |
| Overhead per update | Full HTTP request and response, mostly empty | Full HTTP request and response | A few bytes of framing on an open stream | 2–14 bytes of framing |
| Proxies and load balancers | Works everywhere | Needs idle timeouts longer than the hold | Works through HTTP, but response buffering can delay events | Needs upgrade support at layer 7, long idle timeouts; some corporate proxies interfere (TLS helps) |
| Reconnection and resume | Not needed; each poll stands alone | You build it (cursor per request) | Built in: auto-reconnect plus `Last-Event-ID` | You build all of it |
| Browser support | Universal | Universal | All modern browsers | All modern browsers |

Two observations from the table. SSE is underrated: if traffic is mostly server to client (notifications, feeds, dashboards, progress bars), it gives you reconnection and resume for free over plain HTTP. And the transport choice matters less at scale than the system behind it, which the next section covers.

## Scaling persistent connections

With polling, any server can answer any request. A persistent connection is different: user 42 is attached to one specific server for minutes or hours. That one fact drives most of the design.

### How many connections per server

An idle connection costs a file descriptor, kernel socket buffers and whatever per-connection state your application keeps (the user id, subscriptions, a send buffer). Event-driven servers (Go, Erlang, Node.js, Netty and similar) can hold hundreds of thousands of mostly idle connections per machine once file-descriptor limits and buffer sizes are tuned. Thread-per-connection servers can't.

For estimates, pick a conservative number and show the arithmetic. Say each gateway handles 100,000 connections, and you expect 8 million concurrent users at peak:

- 8,000,000 / 100,000 = 80 gateway servers at full load.
- Run them at about 70% so a few can fail or drain for deploys: 80 / 0.7 ≈ 115 servers.

Message rate matters as much as connection count. 100,000 connections that each receive one message a minute is about 1,700 messages per second per server (100,000 / 60), which is easy. The same connections in a fast-moving game at 20 updates per second each would be 2 million messages per second, which isn't.

Watch for a less obvious limit too. A proxy or load balancer that terminates client connections opens its own connection to each backend. Each of those uses a local port, and one source IP talking to one backend IP and port has only tens of thousands of usable ephemeral ports (Linux defaults to roughly 28,000). Layer 4 load balancing that passes connections straight through avoids this. Otherwise, give the proxy several source IPs or point it at several backend ports.

### Routing and load balancing

Once a WebSocket or SSE stream is open, it stays on the server it landed on, so the connection itself is "sticky". You don't need cookie-based session affinity for that. You do need it if you use long polling with server-side per-client buffers, since each new poll must land where the buffer lives.

Prefer least-connections over round-robin when picking a server for a new connection. Long-lived connections also make rebalancing slow. When you add servers during a spike, the new ones start empty and the old ones stay full until clients reconnect. Many systems fix this by asking a fraction of clients on hot servers to reconnect, a few at a time.

### Getting a message to the right server

A message for user 42 is produced by some backend service that has no connection to user 42. There are two common designs.

1. **A pub/sub layer between servers.** Each gateway subscribes to a channel for every user (or room, or document) it holds. Producers publish to the channel and only the subscribed gateways receive the message. Redis Pub/Sub and NATS are common choices. This is simple and handles group fan-out naturally. Note that plain Redis Pub/Sub is fire-and-forget: a gateway that's briefly disconnected misses messages, so you still need durable storage for catch-up.
2. **A connection registry.** Gateways record "user 42 is on gateway 17" in a fast store. Producers look the user up and call gateway 17 directly. This means fewer moving parts per message, but the registry must be updated on every connect and disconnect and cleaned up when a gateway dies.

```diagram
title: Gateways hold client connections; a pub/sub layer routes messages to whichever gateway holds the user
[c:client] Clients @ 0,0.5
[lb] Load balancer @ 1,0.5
[g1] Gateway 1 @ 2,0
[g2] Gateway 2 @ 2,1
[ps:queue] Pub/sub @ 3,0.5
[svc] Chat, orders,\nother services @ 4,0.5
[db:store] Message store @ 4,1.5
c -> lb : WSS / SSE
lb -> g1
lb -> g2
ps -> g1
ps -> g2
svc -> ps : publish
svc -> db : persist first
```

In both designs, treat the live push as a fast path, not the system of record. Write the message durably first (see [event streaming](/learn/event-streaming) and [message queues](/learn/asynchronism#message-queues)), then push. A client that reconnects asks for everything after its last-seen id, so a lost push costs a few seconds of delay instead of a lost message.

### Heartbeats

TCP doesn't reliably tell you when the other side has vanished. A phone that drops off Wi-Fi leaves a half-open connection the server may hold for a long time. Meanwhile, NAT gateways, mobile carriers and load balancers silently drop connections that look idle. Idle timeouts of a few minutes or less are common; AWS's Application Load Balancer, for example, defaults to 60 seconds.

The fix is a heartbeat: a ping every 20–30 seconds, with the connection closed if no pong comes back within a timeout. Heartbeats keep middleboxes from treating the connection as idle and let both sides detect death quickly. The trade-off is mobile battery and bandwidth. That's one reason mobile apps lean on OS push services (see [the notification system design](/learn/design-notification-system)) when the app is in the background, instead of holding a socket open.

### Reconnect storms

When a gateway holding 100,000 connections crashes, 100,000 clients notice within seconds and reconnect at once. Each one also asks "what did I miss?", which hits your message store. Deploys cause the same thing on purpose. Defenses:

- Clients reconnect with exponential backoff plus random jitter, so the wave spreads over tens of seconds instead of one (see [reliability patterns](/learn/reliability-patterns)).
- For deploys, drain gradually. Stop routing new connections to the old server, then close its existing ones in small batches over minutes.
- Make catch-up cheap. Serve "messages after id X" from an index or cache, and cap how far back a reconnect can ask for before the client does a full reload instead.
- Keep spare capacity so the survivors can absorb the reconnecting clients.

## How to choose

Walk through these questions in order:

1. **Is lag of a few seconds acceptable, and are updates rare?** Short polling. It's the cheapest to build and operate, and nobody will fault you for not over-engineering a "refresh order status" screen.
2. **Is traffic mostly server to client?** SSE. You get automatic reconnection and resume over plain HTTP. Think notifications, live scores, dashboards, AI token streaming and job progress.
3. **Do both sides send frequently, or do you need binary frames?** WebSockets. Chat, multiplayer, collaborative editing. Plan for the reconnect, ack and heartbeat protocol you'll build on top.
4. **Clients behind hostile proxies, or a very old stack?** Long polling as a fallback.
5. **Peer-to-peer media, or unreliable low-latency datagrams?** WebRTC, or WebTransport where support allows.

Whatever you pick, say in the interview how messages reach the right server, how clients catch up after a disconnect, and how you survive a mass reconnect. Those three answers matter more than the transport.

## Check yourself

<details>
<summary>A sports app shows live scores to 2 million concurrent viewers. Updates come every few seconds per game, and clients never send anything except "I'm watching game 812". Which transport would you choose, and why?</summary>

SSE fits well. Traffic is one-way, the browser reconnects automatically and resumes with `Last-Event-ID`, and it all runs over ordinary HTTP, so load balancers and proxies treat it like any long response (you may need to turn off response buffering). The "I'm watching game 812" choice can go in the stream URL or a normal request. WebSockets would work too, but you'd be building reconnection and resume yourself for no benefit.

</details>

<details>
<summary>Your chat gateways each hold 80,000 WebSocket connections. You add 10 new gateways during a traffic spike, but the old ones stay overloaded. Why, and what do you do?</summary>

Existing connections never move on their own. The load balancer only places new connections, so the new gateways fill slowly while the old ones keep their full load. Use least-connections for new connections, and actively shed load: ask a small slice of clients on the hottest gateways to reconnect (with jitter), and they will land on the emptier servers. Don't disconnect everyone at once, or you cause a reconnect storm.

</details>

<details>
<summary>A message is published to Redis Pub/Sub for user 42 while user 42's gateway is restarting. What happens, and how should the design cope?</summary>

Redis Pub/Sub doesn't store messages, so no subscriber receives it and it's gone from the pub/sub layer. The design copes by treating pub/sub as the fast path only. The message was written to a durable store before publishing, and when user 42 reconnects, the client asks for everything after its last-seen message id. The user sees the message a few seconds late instead of never.

</details>

<details>
<summary>Users on one mobile carrier report that live updates stop after about a minute of no activity, but the app shows them as still connected. What's likely going on?</summary>

A middlebox, most likely a carrier NAT or a load balancer with an idle timeout, is silently dropping connections that look idle. Neither end got a clean close, so both think the connection is alive (half-open). Send application-level heartbeats more often than the shortest idle timeout on the path, say every 20–30 seconds, and close and reconnect when a pong doesn't come back in time.

</details>

<details>
<summary>Estimate the gateway fleet for 3 million concurrent connections, assuming 60,000 connections per server and a 30% headroom target.</summary>

At full load you need 3,000,000 / 60,000 = 50 servers. To run them at 70% utilization, divide by 0.7: 50 / 0.7 ≈ 72 servers. Then check message rate as well. If each connection gets one message every 10 seconds, each server pushes about 60,000 × 0.7 / 10 ≈ 4,200 messages per second, which is comfortable for one machine.

</details>

## Further reading

- [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455): the handshake, framing, masking and control frames.
- [HTML Standard: Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html): the event stream format, reconnection and `Last-Event-ID`.
- [RFC 6202: Known issues and best practices for long polling and streaming](https://www.rfc-editor.org/rfc/rfc6202): why held HTTP requests are harder than they look.
- [RFC 8441: Bootstrapping WebSockets with HTTP/2](https://www.rfc-editor.org/rfc/rfc8441): how WebSockets share an HTTP/2 connection.
- [MDN: WebTransport API](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API): the newer QUIC-based option.
- [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events): a practical guide to `EventSource`.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design a chat system".
