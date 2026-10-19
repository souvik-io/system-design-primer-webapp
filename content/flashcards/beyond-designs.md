<!-- chapter: design-key-value-store -->

## In the key-value store design, why do you end up with 24 nodes when 15 would hold the 30 TB of replicated data?
<!-- /learn/design-key-value-store#requirements-and-estimates -->

At 2 TB per node, storage needs only 15 nodes. But throughput is 600,000 replica reads/s (quorum reads touch 2 replicas), which is 40,000 reads/s per node on 15 nodes. That's high for an LSM engine once cache misses hit disk. With 24 nodes (8 per zone) each node does 25,000 reads/s and holds 1.25 TB. **Storage set the floor; read throughput set the final number.**

## Why can a get in the Dynamo-style key-value store return more than one version, and what is the context the client sends back?
<!-- /learn/design-key-value-store#api-and-data-model -->

If two clients wrote the same key concurrently and the store can't tell which is newer, it returns both **siblings** and the application merges them. The **context** is an opaque blob holding the version (a vector clock). The client passes it back on its next write, so the store knows which version that write replaces. Stores using last-writer-wins return only one value.

## With N = 3, a team sets W = 1 and R = 1 and users sometimes miss their own updates. Why, and what are two fixes?
<!-- /learn/design-key-value-store#tunable-quorums -->

1 + 1 isn't greater than 3, so the replica that took the write and the one that answered the read can differ.

- **W = 2, R = 2**: read and write sets always overlap, but both paths get slower and fail if two replicas are down.
- **W = 3, R = 1**: reads stay fast, but every write waits for the slowest replica and fails if any replica is down.

## Why doesn't R + W > N make a leaderless key-value store linearizable?
<!-- /learn/design-key-value-store#tunable-quorums -->

- A write that reached only one replica before failing isn't rolled back, so it may appear in later reads.
- Two concurrent writes still conflict.
- Sloppy quorums break the overlap guarantee entirely.

R + W > N only means a read sees at least one copy of the latest successful write. For true linearizability you need consensus.

## When is last-writer-wins acceptable in a key-value store, and what do vector clocks give you instead?
<!-- /learn/design-key-value-store#versioning-last-writer-wins-or-vector-clocks -->

**LWW** keeps the highest timestamp. It's simple, but a concurrent write is silently discarded and clock skew can let an older write win. It's fine when writes overwrite whole values and losing a racing update is OK: caches, session data, "latest position" records.

**Vector clocks** track causality, so concurrent writes become siblings and no write is lost. The cost moves to the application, which must know how to merge.

## What does a sloppy quorum with hinted handoff buy you, and what guarantee does it cost?
<!-- /learn/design-key-value-store#sloppy-quorum-and-hinted-handoff -->

If a replica in the preference list is down, the write goes to the next healthy node with a **hint** ("this belongs to B"), which is replayed when B returns. Writes stay available. The cost: the W nodes that took the write may not overlap the R nodes a later read contacts, so R + W > N no longer guarantees fresh reads. Cassandra keeps strict quorums and uses hints only as a repair aid.

## Why do replicas compare Merkle trees for anti-entropy repair instead of shipping keys?
<!-- /learn/design-key-value-store#anti-entropy-with-merkle-trees -->

Shipping every key is far too expensive. Each Merkle leaf hashes a small slice of a token range and each parent hashes its children. Replicas compare roots and descend only into children that differ. With 1 million keys and 32,768 leaves, one differing key means following one path 15 levels down, then exchanging about 30 keys instead of 1 million. Building the trees reads all the data, so full repair is scheduled and throttled.

## Why does a delete in a replicated LSM store write a tombstone, and what happens if repair runs less often than the grace period?
<!-- /learn/design-key-value-store#compaction-and-deletes -->

If a delete just removed the key, a replica that missed the delete would later "repair" the old value back onto the others. A **tombstone** replicates like any write. Compaction drops tombstones only after a grace period that must be longer than your repair interval (Cassandra's default is 10 days). Run repair less often than that, and deleted data can come back.

## Your key-value table is read-heavy and update-heavy. Size-tiered or leveled compaction, and what do you give up?
<!-- /learn/design-key-value-store#compaction-and-deletes -->

**Leveled.** Within a level files don't overlap in key range, so a read checks at most one file per level, and space overhead is small. You give up write cost: data is rewritten as it moves down levels. Size-tiered compaction rewrites data fewer times, which suits write-heavy workloads, but a key may sit in many files and big merges can briefly need about 2× space.

## In the key-value store, what does a leader per partition give you over the leaderless design, and what does it cost?
<!-- /learn/design-key-value-store#trade-offs-to-discuss -->

A leader per partition replicated with Raft or Paxos gives linearizable reads and writes with no siblings. The cost: writes to a partition pause during leader election, and a minority side of a network partition can't write. Leaderless designs stay writable through failures but give eventual consistency and conflict handling. DynamoDB, despite the name, uses the leader-based approach.

<!-- chapter: design-notification-system -->

## In the notification system estimates, what sets the capacity: the daily average or campaigns?
<!-- /learn/design-notification-system#requirements-and-estimates -->

Campaigns. The daily average is 136.5 million / 86,400 s ≈ 1,600 per second. A presale announcement to 8 million followers by push and email within 15 minutes is 16,000,000 / 900 s ≈ 17,800 per second, on top of normal traffic. You size for that spike, not the average.

## Why does the notification API return 202 and take an idempotency_key and an expires_at?
<!-- /learn/design-notification-system#api-and-data-model -->

- **202 Accepted**: sending is asynchronous, so the API only confirms it took the request.
- **idempotency_key**: a producer can retry safely after a timeout. Keys are stored for a day and a repeat returns the original `notification_id`.
- **expires_at**: stops a stale message going out late. A login code delivered after 20 minutes is worse than none.

## Why does the notification design give each channel its own queue and worker pool?
<!-- /learn/design-notification-system#high-level-design -->

**Isolation.** If the SMS provider slows down or goes out, SMS messages back up in their own queue while push and email carry on. Each pool also scales and retries according to its own provider's rules.

## What does a success response from APNs or FCM actually tell you, and what should you do when a token is reported invalid?
<!-- /learn/design-notification-system#channels-in-brief -->

Success means the provider **accepted** the message, not that the phone showed it. When a provider reports a token as unregistered or invalid, deactivate it right away. Stale tokens waste capacity on sends that can never arrive.

## During a 10-million-user campaign, login codes take minutes to arrive. What's the likely cause and fix?
<!-- /learn/design-notification-system#priority-versus-bulk -->

Login codes are sharing a queue, workers or provider quota with the campaign, so they wait behind bulk traffic. Fixes:

- A separate high-priority queue (or topic) per channel with dedicated or weighted consumers.
- Bulk consumers behind a token bucket set below the provider quota, leaving room for high-priority sends.
- Alert on the age of the oldest message in the high-priority lane.

## How should a notification worker treat each kind of provider response?
<!-- /learn/design-notification-system#retries -->

| Response | Action |
|---|---|
| Success | Record `sent` with the provider message id |
| Transient (timeout, 5xx, 429) | Retry with exponential backoff and jitter, honour `Retry-After`, cap attempts, stop after `expires_at` |
| Permanent (invalid token, hard bounce) | Don't retry. Record `failed`, clean up the token or address |

Messages that use up their retries go to a dead-letter queue.

## How does the notification system keep duplicates rare, and why can't it promise exactly-once?
<!-- /learn/design-notification-system#deduplication -->

- The API idempotency key turns producer retries into no-ops.
- Each send has a dedup key (`notification_id + user_id + channel`). A conditional write moves the row from `queued` to `sending`, so only one worker wins.

A crash between "provider accepted" and "we recorded it" still causes a duplicate. Exactly-once delivery to a phone isn't possible across systems you don't control, so you keep that window small.

## How do you schedule a campaign for 10:00 in each user's local time?
<!-- /learn/design-notification-system#scheduled-sends -->

Store each user's **IANA time zone** (like `Asia/Kolkata`), never a fixed offset, because daylight saving changes offsets. Compute each user's UTC send time when you expand the campaign, and store sends bucketed by minute for a scheduler to claim. Local times span UTC−12 to UTC+14, so the campaign spreads over about 26 hours, which flattens load. Test the spring-forward and autumn repeat-hour cases.

## Why are email open counts an unreliable engagement signal, and what's better?
<!-- /learn/design-notification-system#tracking-delivery-and-opens -->

Opens are counted with a tracking pixel, and some mail clients, notably Apple Mail with Mail Privacy Protection, load images automatically, which inflates open counts. **Clicks**, tracked through redirect links, are more honest. Feed engagement back: stop marketing email to addresses that haven't opened or clicked in months, which also protects sender reputation.

<!-- chapter: design-chat-system -->

## In the chat design, what sizes the connection tier, and how many servers does the estimate give?
<!-- /learn/design-chat-system#requirements-and-estimates -->

The connection count, not the message rate. If 25% of 200 million daily users are online at peak, that's 50 million open connections. At 250,000 connections per server (a conservative assumption), you need 50M ÷ 250K = 200 connection servers, plus spares.

## In the chat design, why use a WebSocket for message delivery but plain HTTPS for other calls?
<!-- /learn/design-chat-system#api-and-data-model -->

The **WebSocket** carries everything real time in both directions: send, ack, incoming messages, delivered and read marks, sync. It gives low-latency two-way traffic, but it's a stateful connection you must balance and drain. **HTTPS** handles what isn't latency sensitive: creating groups, changing membership, uploading attachments and fetching older history page by page.

## What is client_msg_id for in the chat send frame?
<!-- /learn/design-chat-system#api-and-data-model -->

The client picks a random `client_msg_id` before sending. If the connection drops before the ack arrives, the client resends with the same ID, and the server uses it to drop the duplicate. That gives at-least-once delivery on the wire with exactly-once storage.

## When does the chat sender see the "sent" tick, and why is a push notification never the source of truth?
<!-- /learn/design-chat-system#high-level-design -->

The chat service acks the sender only after the message is durably appended to the message store. For devices with no live session, the push service calls APNs or FCM, but the push only wakes the app or shows a banner. The app then connects and syncs from the store.

## A user with 300 contacts flips online status 20 times a day. How do chat products keep presence from getting expensive?
<!-- /learn/design-chat-system#presence -->

Pushing every flip to every contact is 6,000 presence messages a day from one person. Products cut this by:

- Pushing presence only to people who have a chat with that user open.
- Fetching it lazily when a chat screen loads.
- Delaying "offline" a few seconds to absorb network flaps.
- Not showing presence in large groups.

## In the chat design, how are message ids ordered per conversation, and why keep both a seq and a msg_id?
<!-- /learn/design-chat-system#message-ids-and-ordering -->

The server orders messages per conversation, not the client clock. A per-conversation **seq** from one owner is gap-free (41, 42, 43), so a client can detect a missing message, at the cost of one serialization point per conversation. A Snowflake-style **msg_id** needs no coordination but can cross by clock skew and has gaps. So use `msg_id` for references (replies, reactions, deletion) and `seq` for ordering and gap detection.

## Why is the chat messages table partitioned by (conv_id, bucket) rather than conv_id alone?
<!-- /learn/design-chat-system#storage -->

Partitioning by `conv_id` keeps a conversation's recent messages in one partition in `seq` order, so "latest 50" and "everything after 1,042" are single sequential reads. The time **bucket** caps partition size. Without it, a group active for five years becomes one enormous partition. Discord describes the same pattern: partition by channel plus a fixed time window.

## How does the chat design store read receipts without a row per message per reader?
<!-- /learn/design-chat-system#delivery-and-read-receipts -->

It stores a **high-water mark** per member per conversation: "user 7 has read up to seq 1,042". Reading 1,042 implies reading everything before it, so one small update covers any number of messages. The sender's app compares each message's `seq` with members' marks to draw ticks. Unread counts are `last_seq − last_read_seq`.

## For multi-device sync, when would you pick a per-user change log over per-conversation cursors?
<!-- /learn/design-chat-system#multi-device-sync-with-a-per-device-cursor -->

A **per-user change log** gives each device one cursor, so reconnecting is one request ("everything after 88,310"). It costs a write into every member's log per message (fan-out on write). **Per-conversation cursors** are cheaper to write, but a user in 400 chats makes many small requests on reconnect. Pick the change log when fast reconnects matter more than write cost.

## How should a chat system treat a broadcast channel with thousands of members differently from a small group?
<!-- /learn/design-chat-system#group-fan-out -->

Delivery cost is linear in group size: 500 members at 1.5 online devices each is 750 socket writes per message. For large groups, deliver only to members with the chat open, push a lightweight "new activity" signal to the rest and let clients pull on open. Drop read receipts and per-member presence. Small groups keep full delivery, receipts and typing indicators.

<!-- chapter: design-autocomplete -->

## In the autocomplete latency budget, which step dominates, and what does that tell you to do?
<!-- /learn/design-autocomplete#latency-budget -->

The network round trip to the nearest edge (20–50 ms) dominates, against under 10 ms for the server lookup and under 10 ms to render, inside a roughly 100 ms "feels instant" limit. So serve from as close to the user as possible, avoid the round trip when you can, and make the lookup an in-memory read, not a query that ranks on the fly.

## The autocomplete index is about 32 GB. Why shard it at all?
<!-- /learn/design-autocomplete#index-size -->

About 32 GB fits in the memory of one large server, so data size isn't the reason. You shard for throughput, fault isolation and multiple languages. At this size the simplest setup is full replicas: every suggest server holds the whole index behind a load balancer.

## Why does the autocomplete pipeline build from submitted searches rather than from suggest requests?
<!-- /learn/design-autocomplete#high-level-design -->

Suggest requests are mostly half-typed noise. Submitted searches go to a query log, a batch job aggregates counts, and the builder ranks and filters suggestions per prefix into an immutable snapshot that suggest servers load.

## How does exponential decay with a 7-day half-life weight older searches in autocomplete ranking?
<!-- /learn/design-autocomplete#aggregation-windows-and-decay -->

Each window's count is weighted by `0.5 ^ (age / half_life)`. A search from a week ago counts half as much as one today, and one from four weeks ago counts 1/16. A long half-life gives stable, slowly changing suggestions. A short one reacts faster but is noisier. You can keep two scores and blend them.

## Why drop queries typed by fewer than a minimum number of distinct users before building suggestions?
<!-- /learn/design-autocomplete#aggregation-windows-and-decay -->

Rare queries are mostly noise, and they can contain personal information like names, addresses or order numbers. The trade-off is privacy against coverage: the threshold also hides genuinely rare, useful completions.

## When would you store autocomplete as a trie with cached top-k, and when as a flat prefix-to-top-k table?
<!-- /learn/design-autocomplete#two-ways-to-store-prefix--top-k -->

- **Flat table**: one key read per lookup, shards with any key scheme including hashing, and fits naturally in a KV store or CDN. Often the easier interview answer.
- **Trie with top-k per node**: walk about 20 nodes and read a list. Better when memory is tight or you want fuzzy matching, which walks neighbouring branches.

## Why is sharding the autocomplete index by first letter a bad idea?
<!-- /learn/design-autocomplete#sharding -->

It's badly skewed, and the skew changes. During a big tournament, prefixes like "world c" can carry a large share of traffic for weeks, then fade. With a flat table, hash the prefix so any shard can own any prefix. With a trie, split by prefix ranges sized by measured traffic and re-split as traffic shifts. Shard by language or region first.

## You remove an offensive suggestion from the autocomplete index, but users still see it. Why?
<!-- /learn/design-autocomplete#caching-at-three-layers -->

The response is cached in browsers and at the CDN. With a 15-minute TTL, a removed suggestion can survive at the edge for up to 15 minutes. Urgent removals need a CDN purge as well as an index change. A serve-time manual removal list avoids waiting for the next build.

## Autocomplete responses can arrive out of order. How does the client handle that and cut load?
<!-- /learn/design-autocomplete#on-the-client -->

- **Ignore stale responses**: tag each request with a sequence number and drop any response older than the latest shown.
- **Debounce**: wait until typing pauses a few tens of milliseconds before sending.
- **Filter locally**: show cached suggestions for "pyth" that still match "pytho" while the real request is in flight.

## Why does personalization conflict with autocomplete caching, and what's a common split?
<!-- /learn/design-autocomplete#personalization-as-an-extension -->

A response that depends on the user can't be stored at the CDN under a shared key. Keep the shared suggestions fully cacheable and merge personal ones on the client, from local history or a small per-user call that runs in parallel.

<!-- chapter: design-video-streaming -->

## In the video streaming estimates, egress is over 100 times ingress. How should that shape the design?
<!-- /learn/design-video-streaming#requirements-and-estimates -->

Egress is about 40 PB a day against about 300 TB a day of raw uploads. Read bandwidth is the dominant cost, so spend money on the write side, such as extra encoding work, whenever it saves bytes on the read side.

## Why upload videos to object storage with pre-signed URLs instead of through your API servers, and what do you give up?
<!-- /learn/design-video-streaming#uploads-with-pre-signed-urls -->

Pushing 600 MB through API servers wastes their bandwidth and ties up connections for minutes. With a multipart upload and one **pre-signed URL** per part, the client uploads parts directly and retries only failed parts, so the upload is resumable. The cost: the API never sees the bytes, so validation moves into the pipeline. Treat every upload as untrusted until probed.

## Why does the transcoding pipeline split a video into chunks at keyframe boundaries?
<!-- /learn/design-video-streaming#the-transcoding-pipeline -->

Each chunk can then be encoded independently on a different worker, so a 2-hour film becomes thousands of small tasks that finish in minutes instead of one task that takes hours. All renditions must also put keyframes at the same timestamps, so the player can switch between them at any segment boundary.

## Why must transcoding tasks be idempotent, and how are they made so?
<!-- /learn/design-video-streaming#the-transcoding-pipeline -->

Queues deliver at least once, and workers crash. Each task writes its output to a **deterministic path**, so a retry overwrites the same file instead of creating a duplicate.

## What does "publish early" mean in the video pipeline, and what's the trade-off?
<!-- /learn/design-video-streaming#the-transcoding-pipeline -->

Encode the low and medium rungs first and mark the video watchable as soon as they're packaged. The 1080p and 4K rungs fill in later. Videos become available sooner, but a 4K viewer briefly sees lower quality.

## How does an adaptive bitrate player decide which rendition to fetch next?
<!-- /learn/design-video-streaming#adaptive-bitrate-streaming -->

It downloads the master playlist, which lists renditions with their bandwidth and resolution, picks a starting rendition, then fetches segments over plain HTTP. Before each segment it checks its recent download throughput and how many seconds of video are buffered, and moves up or down the ladder.

## Why did HTTP-based streaming like HLS and DASH displace stateful protocols such as RTMP for delivery?
<!-- /learn/design-video-streaming#adaptive-bitrate-streaming -->

Everything is plain HTTP GETs of immutable segment files, so every segment is cacheable by any CDN. At around 9 Tbps peak, nearly all playback traffic has to come from CDN caches.

## What problem does CMAF solve for a video platform?
<!-- /learn/design-video-streaming#adaptive-bitrate-streaming -->

CMAF (fragmented MP4 segments) lets one set of segment files serve both HLS and DASH players. Without it you might store each rendition twice, MPEG-TS for older HLS players and fMP4 for DASH, doubling storage and splitting cache space between two copies.

## How should a video platform treat popular videos differently from the long tail?
<!-- /learn/design-video-streaming#cdn-delivery-and-cost -->

- **Popular**: stay hot in edge caches. Spend extra encoding on them (VP9, HEVC, AV1, per-title ladders). You pay once and save on every view.
- **Long tail**: mostly miss at the edge. Use tiered caching (edge, regional, origin), skip some renditions until a video proves popular, and move rarely watched files to cheaper storage.

## Why not increment a database row for every video view, and what do you do instead?
<!-- /learn/design-video-streaming#other-bottlenecks -->

About 4,600 views a second, concentrated on a few hot videos, would make those rows a bottleneck. Send view events to a stream, filter duplicates and bots, aggregate per video per minute, and add the aggregates to the stored count. The displayed count lags by minutes, and nobody minds.

<!-- chapter: design-file-sync -->

## What do the file sync estimates reveal about the shape of the system?
<!-- /learn/design-file-sync#requirements-and-estimates -->

An exabyte-scale blob store (about 1.6 EB of logical content) with modest write rates, plus a metadata store that's far smaller (about 120 TB, still too big for one server, so sharded) but takes every commit, about 15,600 writes a second at peak, and must never disagree with itself.

## In the file sync design, how does a commit avoid uploading blocks the server already has?
<!-- /learn/design-file-sync#high-level-design -->

The client splits the file into blocks, hashes each, and calls `commit` with the block list and `base_rev`. The metadata service replies with the hashes it's missing. The client uploads only those to the block service and repeats the commit. Once every block exists, the server checks `base_rev`, appends a journal entry and updates `files_latest` in one transaction.

## What properties fall out of storing file blocks under the hash of their contents?
<!-- /learn/design-file-sync#blocks-and-content-hashes -->

- **Deduplication**: identical blocks are stored once, so copying or moving a file uploads nothing.
- **Immutability**: a block can't change under its name, so it's trivial to cache and replicate.
- **Integrity**: the client verifies each downloaded block against its hash.
- **Resumability**: an interrupted upload skips blocks already stored.

## A user inserts one byte at the start of a large file. How do fixed-size blocks and content-defined chunks compare?
<!-- /learn/design-file-sync#fixed-size-vs-content-defined-chunks -->

With **fixed-size blocks**, every boundary shifts, every hash changes and the whole file uploads again. With **content-defined chunking**, boundaries sit where a rolling hash matches a pattern, so they move with the content and only nearby chunks change. The cost is more CPU, since the rolling hash runs over every byte.

## Why are old file versions cheap in a block-based sync service, and why is deleting blocks tricky?
<!-- /learn/design-file-sync#versions-come-cheap -->

A version is an old journal entry with its block list. Blocks are immutable and shared, so 30 days of history costs metadata rows plus only blocks that changed. A block can be freed only when no current file, retained version or in-progress upload references it. Reference counting is fast but error-prone under failures; mark-and-sweep is slower but self-correcting. Add a grace period either way.

## Why is a missed or duplicated long-poll wake-up harmless in the file sync design?
<!-- /learn/design-file-sync#the-change-journal-and-cursors -->

The notification carries no data. It only tells the client to list changes since its **cursor**, and the cursor is the source of truth. A missed wake-up is caught on the next one, and a duplicate just returns no new entries.

## Two devices edit the same file from rev 7 while one is offline. What happens when both commit?
<!-- /learn/design-file-sync#conflicts -->

The first commit with `base_rev = 7` matches and becomes rev 8. The second also sends `base_rev = 7`, but the current rev is 8, so the server returns `409`. That device saves its version as a "conflicted copy" file and downloads rev 8 under the original name. This is optimistic concurrency, a compare-and-set on `rev`. The service can't merge formats it doesn't understand, so it never silently picks a loser.

## Why must GET /blocks/{hash} check permissions even though hashes are hard to guess?
<!-- /learn/design-file-sync#sharing-and-permissions -->

**A hash must not be a password.** If any block went to anyone who knew its hash, a leaked block list would leak the file. Check the requester can read some file referencing the block. With cross-user dedup that's not enough: a client could commit hashes it never had and then own a file referencing them. So a commit must not reference a block the client hasn't uploaded or proved it holds.

## In the file sync design, why must blocks be stored before the metadata commit is accepted?
<!-- /learn/design-file-sync#consistency-metadata-vs-blocks -->

Then any reader that sees a journal entry can always fetch its blocks. The reverse order would let other devices see files whose content doesn't exist yet. It also lets the two halves use different stores: metadata needs strong consistency within a namespace, while immutable, content-named blocks can replicate asynchronously.
