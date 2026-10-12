# Unique ID generation

Every row, message, order and event needs an identifier. On a single database you let it hand out auto-increment numbers and never think about it again. Once you [shard](/learn/database#sharding), run several regions, or create records before they reach a database (on a phone, in a queue consumer), you need another way to make IDs that never collide, without making one machine a bottleneck.

In interviews this shows up as "design a unique ID generator" and, more often, inside other designs: the short code in a [URL shortener or Pastebin](/learn/design-pastebin#step-3-design-core-components), message IDs in a [chat system](/learn/design-chat-system), tweet IDs in a timeline. The interviewer wants to see that you know the options and what each one costs.

## What a good ID needs

Start by asking which properties matter. They pull against each other.

- **Unique.** Across every shard, region and restart, forever. This is the only property that's never negotiable.
- **Sortable by time.** If IDs roughly follow creation order, you can paginate with `WHERE id < ?` and sort without a separate timestamp. New rows also land at the right-hand end of a B-tree index, which keeps inserts cheap. Across machines, "roughly" is usually the best you can get, and that's normally fine. Twitter's term for this was **k-sorted**: in order to within some bound.
- **Compact.** 64 bits fits in a `BIGINT`, a CPU register and most language integer types. 128 bits doubles the size of every primary key and every index entry that refers to it. The text form matters too, if IDs appear in URLs.
- **No coordination on the hot path.** If every ID needs a call to a central service, that service is a single point of failure and a throughput ceiling.
- **Sometimes, unguessable.** Sequential IDs in public URLs let anyone count your orders or walk through records one by one. That conflicts with being sortable and compact.

## Auto-increment, ticket servers and ranges

**Auto-increment** (a sequence in PostgreSQL, `AUTO_INCREMENT` in MySQL) is compact, ordered and free. Its limits show up at scale:

- Every insert goes through one database, which caps write throughput.
- Two shards each counting from 1 produce colliding IDs, so you can't merge or move data between them without renumbering.
- Values aren't gapless. Rolled-back transactions and crashes skip numbers, so never treat the IDs as a count.
- They reveal volume and are easy to enumerate if exposed publicly.

**Multi-master with a step.** Give N database servers the same increment and different starting offsets. In MySQL, `auto_increment_increment` and `auto_increment_offset` do this: with two servers, one makes 1, 3, 5… and the other 2, 4, 6…. Collisions are gone, but adding a third server means changing the step everywhere, and the IDs aren't time-ordered across servers, because one server can run far ahead of the other.

**Ticket servers.** Flickr published a version of this in 2010. A dedicated MySQL instance does nothing but hand out numbers: each request does a `REPLACE INTO` on a one-row table and reads `LAST_INSERT_ID()`. Two ticket servers, one producing odd numbers and one even, remove the single point of failure. It's simple and works well up to the throughput of a database, but every ID is still a network call.

```diagram
title: Two ticket servers with a step of 2. Either one can serve every app server.
[app1] App server @ 0,0
[app2] App server @ 0,2
[t1:store] Ticket server A\n1, 3, 5, … @ 2,0
[t2:store] Ticket server B\n2, 4, 6, … @ 2,2
app1 -> t1
app1 -> t2
app2 -> t1
app2 -> t2
```

**Range allocation.** Instead of asking for one ID at a time, each application server reserves a block, say 1,000 IDs, with a single atomic update (`UPDATE counters SET next = next + 1000 … RETURNING next`) and hands them out from memory. Database load drops by a factor of 1,000, and a short database outage doesn't stop ID generation until the current block runs out. The cost: a crashed server leaves a gap of unused IDs, and IDs from different servers interleave out of time order.

## UUIDs: v4 and v7

UUIDs are 128-bit identifiers that any machine can make without asking anyone. The text form is 36 characters: 32 hex digits and 4 hyphens. RFC 9562 (2024) replaced the original RFC 4122 and added new versions, including version 7.

**UUID v4** is 122 random bits; the other 6 bits mark the version and variant. Collisions are possible in theory and irrelevant in practice when the random source is good. By the birthday bound, you'd need about √(2 ln 2 × 2^122) ≈ 2.7 × 10^18 UUIDs for a 50% chance of a single duplicate. At a billion a second, that takes about 86 years. Real collisions come from bad randomness, such as cloned virtual machines with identical random state or weak generators, not from the math.

The problem with v4 is databases. Random keys land all over the B-tree index, so every insert touches a random page. Once the index is bigger than memory, inserts cause disk reads and frequent page splits. In MySQL's InnoDB, rows are stored in primary-key order, and every secondary index stores the primary key too, so random 16-byte keys make the whole table slower and larger.

**UUID v7** fixes that. Its first 48 bits are a Unix timestamp in milliseconds, followed by the version and variant bits and 74 bits that are random (the RFC also allows using some of them as a counter to keep IDs from one generator in strict order). IDs sort by creation time both as bytes and as text, so inserts append to the end of the index, as with auto-increment, while still needing no coordination. Some databases now generate it natively; PostgreSQL 18 added a `uuidv7()` function. The trade-off: anyone holding the ID can read its creation time.

Other versions exist. v1 uses a timestamp and the machine's MAC address, which leaks the address and doesn't sort well; v6 reorders v1's fields to sort properly. Unless you have a reason, use v7 for new keys and v4 when you specifically want no timing information.

One warning applies to every version: RFC 9562 says implementations should not assume UUIDs are hard to guess. For password-reset links or API secrets, use a dedicated random token of 128 bits or more from a cryptographic generator.

## Snowflake-style IDs

Twitter built Snowflake in 2010 while moving from MySQL to Cassandra, which has no auto-increment. It packs a timestamp, a machine number and a counter into one 64-bit integer:

```text
 1 bit  41 bits                          10 bits      12 bits
+-----+--------------------------------+------------+------------+
|  0  | milliseconds since your epoch  | machine ID | sequence   |
+-----+--------------------------------+------------+------------+
```

- **41 bits of milliseconds** cover 2^41 ms ≈ 2.2 × 10^9 seconds ≈ 69.7 years from a custom epoch you choose. Counting from 1970 would waste decades of range, so pick a recent date. Twitter's epoch is in November 2010. Discord uses the same idea with an epoch of 1 January 2015.
- **10 bits of machine ID** allow 1,024 generators. Twitter split them into 5 bits of data center and 5 bits of worker.
- **12 bits of sequence** allow 4,096 IDs per millisecond per machine, about 4 million a second.
- The top bit stays 0 so the ID is positive in languages with signed 64-bit integers.

A generator needs only a few lines of code:

```python
import threading, time

EPOCH_MS = 1_704_067_200_000  # 2024-01-01T00:00:00Z. Pick once, never change.

class Snowflake:
    def __init__(self, machine_id: int):
        assert 0 <= machine_id < 1024
        self.machine_id = machine_id
        self.last_ms = -1
        self.seq = 0
        self.lock = threading.Lock()

    def next_id(self) -> int:
        with self.lock:
            now = int(time.time() * 1000)
            if now < self.last_ms:            # clock stepped backwards:
                now = self.last_ms            # keep counting in the last millisecond
            if now == self.last_ms:
                self.seq = (self.seq + 1) & 0xFFF
                if self.seq == 0:             # 4,096 IDs used up this millisecond
                    while now <= self.last_ms:
                        now = int(time.time() * 1000)
            else:
                self.seq = 0
            self.last_ms = now
            return ((now - EPOCH_MS) << 22) | (self.machine_id << 12) | self.seq
```

The interesting parts are the failure cases.

- **Sequence overflow.** If a machine needs more than 4,096 IDs in one millisecond, it waits for the next millisecond. That caps throughput per machine, which is why you'd run several generators.
- **Clocks going backwards.** NTP can step a clock back, and a virtual machine's clock can jump after migration. If the generator trusted the clock blindly, it could repeat a timestamp and sequence it had already used. The options are to refuse to generate until the clock catches up (Twitter's original behavior), to keep counting from the last timestamp as the code above does (which stalls the same way if the jump is large), or to fail loudly and take the node out of service. Configuring time sync to slew the clock gradually instead of stepping it avoids most of this.
- **Machine ID assignment.** Two processes with the same machine ID will produce duplicates, so assignment has to be reliable. Options include static configuration, a lease from ZooKeeper or etcd, or a stable ordinal such as a Kubernetes StatefulSet index. A lease has to expire before the ID can be reused.
- **JavaScript.** JavaScript numbers lose precision above 2^53, and Snowflake IDs are larger. That's why Twitter's API added string `id_str` fields and Discord sends IDs as strings in JSON.
- **Low bits under light load.** When traffic is light, most IDs are the first in their millisecond, so the sequence bits are usually 0. If you shard by `id % 16`, nearly everything lands on shard 0. Hash the ID before taking the modulus, or shard on something else.

Instagram used a variant in 2012: 41 bits of time, 13 bits of logical shard ID and 10 bits of sequence, generated inside PostgreSQL by a stored function. Putting the shard ID in the ID means you can find a row's shard from its ID alone.

## ULID and other formats

**ULID** is a community specification, not an IETF standard. It's 128 bits: a 48-bit millisecond timestamp followed by 80 random bits, written as 26 characters in Crockford's base32 (which avoids the easily confused letters I, L, O and U). ULIDs sort by time as text. The spec's monotonic mode increments the random part when two IDs are created in the same millisecond, so IDs from one generator stay in order.

ULID and UUID v7 have nearly the same layout, and both fit in a 16-byte column. Choose v7 if your database, language and tooling already handle UUIDs. Choose ULID if a shorter, URL-friendly string matters and you're happy to depend on a library.

A few others you might meet:

- **KSUID** (from Segment): 160 bits, a 32-bit timestamp in seconds plus 128 random bits, written as 27 base62 characters. Coarser time, more randomness.
- **MongoDB ObjectId**: 12 bytes, made of a 4-byte timestamp in seconds, a 5-byte random value per process and a 3-byte counter.
- **Short public codes**: a 64-bit ID encoded in base62 takes at most 11 characters, which suits URLs. The primer's [Pastebin design](/learn/design-pastebin#step-3-design-core-components) uses Base62 for its short links too, though it encodes a hash rather than an ID.

## Choosing between them

| Scheme | Size | Sorted by time? | Coordination | Main risk |
|---|---|---|---|---|
| Auto-increment | 64 bits | yes, on one node | one database | write bottleneck; enumerable |
| Ticket server or ranges | 64 bits | roughly | central service (rarely, with ranges) | that service's availability; gaps |
| UUID v4 | 128 bits | no | none | index locality; size |
| UUID v7 | 128 bits | yes, to the ms | none | reveals creation time |
| Snowflake | 64 bits | yes, to the ms | assigning machine IDs | clock problems; 69-year range |
| ULID | 128 bits | yes, to the ms | none | non-standard; needs a library |

A sensible way to decide:

- **One database, internal IDs:** auto-increment is fine. If IDs are shown publicly, add a separate public ID rather than exposing the counter.
- **Many writers, and 128-bit keys are acceptable:** UUID v7. Nothing to deploy, and it's friendly to indexes.
- **High volume where 64 bits matter** (messages, events, existing `BIGINT` columns): Snowflake-style, and budget time for machine ID assignment and clock handling.
- **Secrets and unguessable links:** a cryptographically random token, not any of the above.

Whatever you choose, remember that time-based IDs only give **rough** order across machines, because clocks differ by milliseconds. If you need strict order within a scope, such as messages in one conversation, assign a per-scope sequence number at the single place that owns that scope.

## Check yourself

<details>
<summary>You shard a MySQL users table across 4 servers, each using AUTO_INCREMENT from 1. What breaks, and what are two ways to fix it?</summary>

Each shard creates user 1, 2, 3…, so IDs collide across shards. Any global lookup by ID becomes ambiguous, and you can't move a user to another shard without renumbering them. Set increment 4 and offsets 1–4 per shard, or move ID generation out of the shards entirely with Snowflake-style IDs or UUID v7, which also lets you add shards later without reconfiguring.

</details>

<details>
<summary>A Snowflake service uses a 41-bit timestamp from an epoch of 1 January 2024. When does it run out, and what would choosing the Unix epoch have cost?</summary>

2^41 ms ≈ 69.7 years, so it runs out around September 2093. Counting from 1970 would have used up 54 of those years before the service ever ran, leaving it to overflow around 2039.

</details>

<details>
<summary>Your team shards a table with shard = snowflake_id % 16, and shard 0 gets far more rows than the others. Why?</summary>

`id % 16` keeps only the lowest 4 bits, which belong to the sequence counter. At low or moderate traffic most IDs are the first in their millisecond, so the sequence is 0 and those bits are 0. Hash the ID before taking the modulus, or shard by something with evenly spread values, such as a user ID's hash.

</details>

<details>
<summary>A PostgreSQL table with a UUID v4 primary key has slowed down on inserts as it has grown past available memory. What's happening, and what would you change?</summary>

Random keys put each insert on a random page of the primary key index. Once the index no longer fits in memory, many inserts need a disk read first, and pages split often. Switching new rows to UUID v7 makes inserts land next to each other in one narrow, advancing region of the index, which stays in memory. (With old v4 keys spread across the whole range, that region isn't the right-hand edge, but the effect on caching is the same.) Existing rows can keep their v4 IDs, since both fit the same column type.

</details>

<details>
<summary>A chat app uses Snowflake IDs for messages and sorts each conversation by ID. Two users reply at almost the same moment, through different servers. Can their messages appear in the wrong order?</summary>

Yes. The IDs come from different machines whose clocks can differ by a few milliseconds, so the later message can get the smaller ID. Usually that's acceptable. If you need a strict order that everyone agrees on, have the service that owns the conversation assign a per-conversation sequence number as it accepts each message.

</details>

## Further reading

- [RFC 9562: Universally Unique IDentifiers (UUIDs)](https://www.rfc-editor.org/rfc/rfc9562): the current UUID standard, including v7 and its security notes.
- [Twitter's Snowflake (2010 version)](https://github.com/twitter-archive/snowflake/tree/snowflake-2010): the original requirements and bit layout in the README, with the Scala source.
- [Flickr, "Ticket Servers: Distributed Unique Primary Keys on the Cheap"](https://code.flickr.net/2010/02/08/ticket-servers-distributed-unique-primary-keys-on-the-cheap/): the odd/even ticket server design.
- [Discord API reference: Snowflakes](https://discord.com/developers/docs/reference): a production Snowflake layout and why IDs are sent as strings.
- [ULID specification](https://github.com/ulid/spec): layout, encoding and monotonic mode.
- [KSUID](https://github.com/segmentio/ksuid): Segment's format and the reasoning behind it.
- Instagram Engineering, "Sharding & IDs at Instagram" (2012): the shard-aware variant generated in PostgreSQL.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design a unique ID generator in distributed systems".
