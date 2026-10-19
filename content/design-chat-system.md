# Design a chat system

A chat system lets people exchange short messages in near real time, one to one or in groups, across several devices each. It looks simple until you list what users take for granted: messages show up in the same order for everyone, nothing is lost when a phone goes through a tunnel, the laptop knows what you read on your phone, and the little "delivered" and "read" marks are accurate.

This question comes up often because it touches long-lived connections, ordering, storage design for an append-heavy workload, and fan-out. The [object-oriented chat server](/learn/ood-online-chat) covers the class structure. This chapter is about the distributed system underneath. It assumes you've read [real-time communication](/learn/realtime) and [unique ID generation](/learn/unique-ids).

## Requirements and estimates

Start by pinning down scope with the interviewer. A reasonable set:

- **Functional:** 1:1 chats and group chats; text messages (attachments go to object storage and are referenced by URL); online/last-seen presence; sent, delivered and read receipts; history on every device a user signs into; push notifications for offline users.
- **Non-functional:** a message sent to an online recipient arrives within a few hundred milliseconds; no message is lost once the sender sees "sent"; every member sees a conversation in the same order; high availability (a chat outage is very visible).
- **Out of scope for now:** voice and video calls, search, bots.

Then size it. These numbers are assumptions for a large consumer app, not figures from any real product:

- 200 million daily active users, each sending 40 messages a day.
- Messages: 200M × 40 = 8 billion a day. 8 × 10⁹ ÷ 86,400 s ≈ 92,600 a second on average. With a peak of about 3× average, plan for roughly **300,000 writes a second**.
- Storage: assume 200 bytes per message including metadata. 8 × 10⁹ × 200 B = 1.6 TB a day, or 1.6 TB × 365 ≈ 584 TB a year. With 3 replicas that's about **1.75 PB a year**.
- Connections: if 25% of daily users are online at the busiest moment, that's 50 million open connections. If one connection server holds 250,000 of them (a conservative assumption that leaves headroom for memory and CPU), you need 50M ÷ 250K = **200 connection servers**, plus spares.
- Deliveries: one message goes to every other member's devices. If an average message reaches 2.5 devices, deliveries are 2.5× the message rate: about 750,000 a second at peak.

Two things stand out. The write rate is high and append-only, which shapes storage. And the connection count, not the message rate, sizes the front tier. See [estimation](/learn/estimation) for more on this kind of arithmetic.

## API and data model

Clients talk to the system over two channels.

A **WebSocket** to a connection server carries everything real time, in both directions. A small set of frame types is enough:

```text
client -> server  send      {conv_id, client_msg_id, body}
server -> client  ack       {client_msg_id, msg_id, seq}
server -> client  message   {conv_id, msg_id, seq, sender_id, body, sent_at}
client -> server  delivered {conv_id, up_to_seq}
client -> server  read      {conv_id, up_to_seq}
client -> server  sync      {cursor}
```

`client_msg_id` is a random ID the client picks before sending. If the connection drops before the ack arrives, the client resends with the same ID, and the server uses it to drop the duplicate. That gives you at-least-once delivery on the wire with exactly-once storage.

Plain **HTTPS** handles everything that isn't latency sensitive: creating groups, changing membership, uploading attachments, and fetching older history page by page.

The core tables:

| Table | Key | Holds |
|---|---|---|
| `messages` | partition: `(conv_id, bucket)`; sort: `seq` descending | sender, body, `msg_id`, timestamp |
| `conversations` | `conv_id` | type (1:1 or group), member list, `last_seq` |
| `user_conversations` | partition: `user_id`; sort: `updated_at` | per-user view: `last_read_seq`, muted, preview |
| `devices` | `user_id`, `device_id` | push token, sync cursor |

Unread counts fall out for free: `last_seq − last_read_seq`. You never count rows.

## High-level design

```diagram
title: Sending a message to an online and an offline recipient
[sender:client] Sender @ 0,0
[wsa] Connection\nserver A @ 1,0
[chat] Chat service @ 2,0
[store:store] Message store @ 3,0
[wsb] Connection\nserver B @ 1,1
[recv:client] Recipient @ 0,1
[reg:store] Session\nregistry @ 2,1
[push] Push service @ 3.5,1
[apns:client] APNs / FCM @ 3.5,2
sender <-> wsa : WebSocket
wsa -> chat
chat -> store : append
chat -> reg : lookup
chat -> wsb
wsb -> recv
chat --> push : offline
push --> apns
```

The path of one message:

1. The sender's app writes a `send` frame on its WebSocket. Connection server A is stateless apart from its sockets. It forwards the frame to the chat service.
2. The chat service checks that the sender belongs to the conversation, assigns the next sequence number and a message ID, and appends the message to the message store.
3. Only after the write is durable does it ack the sender. This is the "sent" tick. If the ack never arrives, the client retries with the same `client_msg_id`.
4. The chat service looks up each member's devices in the **session registry**, a fast key-value store (Redis or similar) mapping `user_id` to a list of `(device_id, connection_server)`. Connection servers write to it when a socket opens and delete on close, with a TTL so entries from crashed servers expire.
5. For each online device, it forwards the message to the right connection server, which writes it down the socket. Many designs put a pub/sub layer here so the chat service doesn't need direct connections to hundreds of connection servers.
6. For devices with no live session, it hands off to the push service, which calls Apple Push Notification service or Firebase Cloud Messaging. The push only wakes the app or shows a banner. The app then connects and syncs; the push is never the source of truth. The [notification system](/learn/design-notification-system) chapter covers that pipeline.

Connection servers often sit behind a [layer 4 load balancer](/learn/load-balancing#layer-4), because WebSockets are long-lived TCP connections and there's little for the balancer to do with the payload. A layer 7 balancer works too, as long as its idle timeouts allow long-lived connections (see [real-time updates](/learn/realtime)). When one of them dies, its 250,000 clients all reconnect at once. Clients must back off with random jitter, or the reconnect storm takes down the next server. See [reliability patterns](/learn/reliability-patterns).

### Presence

Presence is the "online" dot. The connection server already knows when a socket is alive, so presence is a by-product: the client sends a heartbeat every 20–30 seconds, and the presence store keeps `user_id → last_seen` with a TTL a bit longer than that. No heartbeat, the key expires, the user shows as offline.

The expensive part is telling others. If a user with 300 contacts flips state 20 times a day, and you push every flip to every contact, that's 6,000 presence messages a day from one person. Most products cut this down by only pushing presence to people who currently have a chat with that user open, by fetching it lazily when a chat screen loads, by delaying "offline" by a few seconds to absorb network flaps, and by not showing it at all in large groups.

## Ordering, storage and sync

### Message IDs and ordering

Users only care about order **within a conversation**. Nobody can tell whether a message in one chat was stored before a message in another. That lets you pick the conversation as the unit of ordering.

The server, not the client, decides the order. Phone clocks drift and can be set by hand, so `sent_at` from the device is only for display.

There are two common ways to do it:

- **A per-conversation sequence number.** One owner (the shard that holds the conversation, or a counter in a strongly consistent store) increments `last_seq` for each message. The result is gap-free: 41, 42, 43. A client holding 41 that receives 43 knows it missed one. The cost is that every message in a conversation goes through one serialization point, which caps the throughput of a single very busy group. That cap is far above anything a human group produces.
- **A time-ordered unique ID**, Snowflake style (see [unique IDs](/learn/unique-ids)). Any server can mint one without coordination, and sorting by it gives roughly time order. But IDs from two servers can cross by a few milliseconds of clock skew, and there are gaps, so a client can't detect a missing message from IDs alone.

A good answer uses both: a globally unique `msg_id` for references (replies, reactions, deletion), and a per-conversation `seq` for ordering and gap detection. When two people send at the same instant, whichever reaches the sequencer first is first. That's fine, because there was no "real" order between them anyway. What matters is that everyone sees the same one.

### Storage

The access patterns are narrow:

- Append a message to a conversation (hundreds of thousands a second).
- Read the latest N messages of a conversation.
- Read everything in a conversation after `seq` S.
- Rarely, read further back in history.

There are no joins and no cross-conversation transactions. That points to a [wide-column store](/learn/nosql-databases#wide-column-stores) such as Cassandra, ScyllaDB or HBase, or a [key-value store](/learn/nosql-databases#key-value-stores) with sorted keys:

```sql
CREATE TABLE messages (
  conv_id   bigint,
  bucket    int,      -- e.g. days since epoch / 7
  seq       bigint,
  msg_id    bigint,
  sender_id bigint,
  body      text,
  PRIMARY KEY ((conv_id, bucket), seq)
) WITH CLUSTERING ORDER BY (seq DESC);
```

Why this shape works:

- All of a conversation's recent messages live in one partition, stored in `seq` order. "Latest 50" and "everything after 1,042" are single sequential reads.
- Writes are appends to an LSM tree, which these stores handle well at high rates.
- Partitioning by `conv_id` spreads load across nodes with no hot spot other than very busy conversations ([sharding](/learn/relational-databases#sharding-splitting-one-table-across-databases) and [consistent hashing](/learn/consistent-hashing)).
- The `bucket` caps partition size. Without it, a group that has been active for five years becomes one enormous partition. Discord's engineering blog describes exactly this pattern: partition by channel plus a fixed time window.

A relational database can work at smaller scale, and it's easier to reason about. At 300,000 appends a second you would be [sharding](/learn/relational-databases#sharding-splitting-one-table-across-databases) it by `conv_id` and avoiding joins anyway, which leaves you with a hand-built version of the same thing.

### Delivery and read receipts

There are three states, and each has a clear owner:

| State | Meaning | Who records it |
|---|---|---|
| Sent | The server stored it durably | Chat service, when it acks the sender |
| Delivered | A recipient device received it | The device sends `delivered` |
| Read | The recipient saw it on screen | The device sends `read` |

Don't store a receipt row per message per reader. Store a **high-water mark** per member per conversation: "user 7 has read up to seq 1,042". One small update covers any number of messages, because reading message 1,042 implies reading everything before it. The sender's app compares each message's `seq` with the other members' marks to draw the ticks.

In a group, "read by 14 of 30" is a count of members whose mark is at or past that seq. That's cheap for 30 members and wasteful for 5,000, which is one reason large groups often drop read receipts.

### Multi-device sync with a per-device cursor

A user has a phone, a laptop and a tablet. Each needs every message, including the ones the user sent from another device, plus read state.

Treat the sender's own other devices as recipients, so they get new messages through the same path. Then give each device a **cursor** that records how far it has synced. Two designs are common:

- **Per-conversation cursors.** The device remembers the last `seq` it has for each conversation. On reconnect it asks "which conversations changed since time T?", then fetches each one after its stored `seq`. That's simple, but a user in 400 chats means many small requests.
- **A per-user change log.** Every event that touches a user (a new message in any of their chats, a read mark from another device, a membership change) is appended to a per-user log with its own sequence. Each device stores a single cursor into that log. Reconnecting is one request: "give me everything after 88,310". The cost is writing each message into every member's log, which is fan-out on write.

Either way, the device advances its cursor only after it has saved the events locally, so a crash mid-sync just repeats some work. If a device has been offline so long that its cursor points past the log's retention, the server tells it to do a full resync of recent conversations.

When the user reads a chat on their phone, the phone sends `read up_to_seq`. That updates `last_read_seq` and becomes an event in the change log, so the laptop clears its unread badge too.

## Group fan-out

A message to a group is written **once** to storage, then delivered to every member's online devices. That's the same split the [Twitter design](/learn/design-twitter) makes between storing a tweet and fanning it out, with a much smaller fan-out per message.

The delivery cost is linear in group size. A message in a 500-member group, with an average of 1.5 online devices per member, is 750 socket writes. Group size limits exist for this reason, and so does the fact that big groups behave differently. Reasonable rules:

- **Small and medium groups** (up to some hundreds of members): full delivery, per-member receipts, typing indicators.
- **Large groups or broadcast channels** (thousands and up): deliver only to members who have the chat open, push a lightweight "new activity" signal to the rest, and let clients pull on open. Drop read receipts and per-member presence.
- **Membership changes** are ordered events in the conversation too, so a member removed at seq 900 doesn't receive seq 901.

Fan-out happens off the sender's critical path. The sender is acked as soon as the message is stored. Delivery work goes onto a [queue](/learn/queues-and-async#how-a-message-queue-works) partitioned by `conv_id`, which keeps each conversation's deliveries in order and absorbs bursts.

## Scaling and bottlenecks

- **Connection servers** scale horizontally. The limits are memory per connection and the reconnect storm after a failure. Drain servers gracefully on deploy: tell clients to reconnect elsewhere over a few minutes instead of cutting everyone at once.
- **Session registry.** Every message triggers a lookup per member. Shard it by `user_id`, keep it in memory, and accept that it's slightly stale. A message sent to a dead connection server fails, and the device catches up through sync when it reconnects.
- **Hot conversations.** A huge, very active group puts its sequencer and its storage partition on one node. Caps on group size, the time bucket in the partition key, and the separate large-group mode all help.
- **Multi-region.** Users connect to the nearest region. A conversation still needs one sequencer, so pick a home region per conversation (for example, where it was created) and route sends there. Cross-region members pay one extra hop.
- **Retention and cold history.** Old messages are rarely read. Moving buckets past a certain age to cheaper storage keeps the hot cluster small.

## Trade-offs to discuss

- **Per-conversation `seq` vs time-ordered IDs.** Gap detection and simple sync, at the cost of a serialization point per conversation.
- **Fan-out on write vs on read for sync.** A per-user change log makes reconnects one request, but costs a write per member per message. Per-conversation cursors are cheaper to write and slower to sync.
- **WebSockets vs alternatives.** WebSockets give low-latency two-way traffic, but they're stateful connections you have to balance and drain. Long polling or server-sent events are simpler to operate and slower. [Real-time communication](/learn/realtime) compares them.
- **Receipts and presence vs cost.** Both scale with group size and contact count. Large groups usually get fewer features, and users accept that.
- **End-to-end encryption**, as a talking point. With E2EE the server only stores and forwards ciphertext. Signal's published protocol combines an initial key agreement (X3DH, and since 2023 a post-quantum variant, PQXDH) with a ratchet that changes keys as the conversation goes on, the Double Ratchet. Signal has kept extending both against quantum attacks, so check its docs for the current versions. Groups use sender keys or the newer Messaging Layer Security standard. The design consequences are what to raise in an interview: the server can't search messages, build link previews or scan content; every device has its own keys, so with pairwise encryption the sender encrypts once per recipient device (sender keys cut that to once per message for groups); and adding a device or recovering history needs a key-transfer story.

## Check yourself

<details>
<summary>A user's phone shows the message "ok" before "are you free?", but the other person typed them the other way round. What went wrong, and how does your design prevent it?</summary>

The client is probably ordering by device timestamp, or by arrival order over two different connections. In this design the chat service assigns a per-conversation `seq` when it stores each message, and every client sorts by `seq`. Two messages from the same sender over the same socket reach the sequencer in the order they were sent, as long as the connection server forwards each conversation's frames in order, so they get increasing `seq` values and display correctly everywhere. A retry is the exception: if the first send times out and is resent after the second went through, it gets the later `seq`. Clients that need strict order hold later sends until earlier ones are acked.

</details>

<details>
<summary>A laptop has been closed for a week. Walk through what happens when it reconnects.</summary>

It opens a WebSocket, registers in the session registry, and sends `sync` with its stored cursor. The server returns the events after that cursor in pages: new messages, read marks set from other devices, membership changes. The laptop saves each page locally before advancing its cursor. If the cursor is older than the change log's retention, the server replies "resync", and the laptop instead fetches the latest messages of each recent conversation and starts a fresh cursor.

</details>

<details>
<summary>Why store "read up to seq N" per member instead of a read flag per message, and when does even that become too expensive?</summary>

Reading is monotonic: if you've read message 1,042 you've read everything before it, so one number captures it and one small write updates it no matter how many messages you just scrolled past. Per-message flags would cost a write per message per reader. It gets expensive in very large groups, because every read mark is an event other members' devices may need, and showing "read by" counts means comparing thousands of marks. That's why large groups usually turn receipts off.

</details>

<details>
<summary>A connection server holding 250,000 sockets crashes. What breaks, and what keeps it from getting worse?</summary>

Messages being forwarded to that server fail, and its session registry entries are stale until their TTL expires. No messages are lost, because they were stored before fan-out; affected devices catch up through `sync` when they reconnect. The danger is 250,000 clients reconnecting in the same second, so clients use exponential backoff with random jitter, and the load balancer spreads them over the remaining servers. You also need enough spare capacity for those servers to absorb the extra connections.

</details>

<details>
<summary>Your product team wants server-side search across all messages. How does that interact with end-to-end encryption?</summary>

With E2EE the server only holds ciphertext, so it can't build a search index. You either search on the device, over its local copy of history (limited to what that device has synced), or you give up E2EE for the conversations that need server search. That trade-off is a product decision, not just a technical one, so it's worth naming it in the interview rather than quietly picking one side.

</details>

## Further reading

- [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455): the handshake, framing and close semantics your connection servers implement.
- [How Discord stores billions of messages](https://discord.com/blog/how-discord-stores-billions-of-messages): a message table partitioned by channel and time bucket in Cassandra, and the problems it hit.
- [How Discord stores trillions of messages](https://discord.com/blog/how-discord-stores-trillions-of-messages): the follow-up, covering hot partitions and the move to ScyllaDB.
- [Signal protocol specifications](https://signal.org/docs/): X3DH, PQXDH and the Double Ratchet, for the E2EE discussion.
- [RFC 9420: The Messaging Layer Security (MLS) Protocol](https://www.rfc-editor.org/rfc/rfc9420): the IETF standard for end-to-end encrypted group messaging.
- [Firebase Cloud Messaging documentation](https://firebase.google.com/docs/cloud-messaging): how push delivery to offline devices works on Android and the web.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design a chat system".
- [System Design School primer](https://systemdesignschool.io/primer): "NoSQL Databases" and "Message Queues".
