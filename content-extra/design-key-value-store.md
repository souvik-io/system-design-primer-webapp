# Design a distributed key-value store

The primer describes a [key-value store](/learn/database#key-value-store) as a hash table: put a key, get it back. This question asks you to build one that spans dozens of machines, keeps working when some of them die, and lets each caller choose between speed and consistency. It's a favourite because nearly every distributed-systems idea shows up in one design: partitioning, replication, quorums, conflict resolution, failure detection, repair and a storage engine.

The design here follows the Dynamo family: Amazon's 2007 Dynamo paper and the systems it inspired, such as Cassandra, Riak and Voldemort. They are leaderless, always writable, and offer tunable consistency. It isn't the only valid answer: a leader per partition, kept consistent with [consensus](/learn/consensus), is just as legitimate, and the trade-offs section compares the two. Say early in the interview which one you're building and why.

## Requirements and estimates

Pin down scope first. A reasonable set:

**Functional**

- `put(key, value)`, `get(key)` and `delete(key)`.
- Keys up to 256 bytes. Values up to 1 MB, though most are a few KB.
- Optional per-key expiry (TTL).
- No range scans or secondary indexes. Hash partitioning makes them hard, and the trade-offs section covers why.

**Non-functional**

- **Always writable.** Accept writes even when some replicas are down or the network is partitioned. In [CAP](/learn/availability-vs-consistency#cap-theorem) terms, the default favours availability.
- **Tunable consistency.** The caller picks, per request, how many replicas must answer.
- Low latency: single-digit milliseconds at p99 within a region (an assumed target).
- Scales horizontally. Add nodes without downtime.
- Survives the loss of a whole availability zone.

**Estimates** (round, assumed numbers):

- 5 billion keys at about 2 KB per record (key, value and metadata): 5 × 10⁹ × 2 KB = 10 TB of unique data.
- Replication factor 3: 30 TB stored.
- Peak traffic: 300,000 reads/s and 60,000 writes/s.

Size the cluster from both storage and throughput:

- **Storage.** LSM storage engines need free disk for compaction. Suppose each node has 4 TB of SSD and we keep live data around 1.25–2 TB per node, which also keeps rebuilds short. At 2 TB per node, 30 TB / 2 TB = 15 nodes. Rebuilding a dead node then means streaming 2 TB, which at an assumed 200 MB/s takes 2,000,000 MB / 200 MB/s = 10,000 s, or about 2.8 hours.
- **Throughput.** Every write lands on 3 replicas: 60,000 × 3 = 180,000 replica writes/s. Quorum reads touch 2 replicas: 300,000 × 2 = 600,000 replica reads/s. On 15 nodes that's 40,000 reads/s each, which is high for an LSM engine once cache misses hit disk.

Settle on 24 nodes, 8 in each of 3 zones. Per node that's 600,000 / 24 = 25,000 reads/s, 180,000 / 24 = 7,500 writes/s and 30 TB / 24 = 1.25 TB of data. The lesson to say out loud is that storage set the floor and read throughput set the final number.

## API and data model

The client API is small. Real stores usually speak a binary protocol, but the HTTP form shows the shape:

```text
GET    /v1/kv/{key}?consistency=quorum
       -> 200 { "versions": [ { "value": "...", "context": "opaque" } ] }

PUT    /v1/kv/{key}?consistency=quorum
       body: value bytes
       header: If-Context: <context from the get this write is based on>

DELETE /v1/kv/{key}?consistency=quorum
       header: If-Context: <context>
```

Two details matter.

- `get` can return **more than one version**. If two clients wrote the same key concurrently and the system can't tell which is newer, it hands back both and lets the application merge them. This is how Dynamo and Riak behave. Stores that use last-writer-wins return only one.
- The **context** is an opaque blob holding the version (a vector clock, explained below). The client passes it back on the next write, so the store knows which version the write replaces.

Each stored record holds:

| Field | Purpose |
|---|---|
| key | Up to 256 bytes |
| value | Opaque bytes, or empty for a delete |
| version | Vector clock, or a timestamp under last-writer-wins |
| tombstone flag | Marks a delete so it can replicate like a write |
| expires_at | Optional TTL |

## High-level design

Every node runs the same software and can play every role. There's no master. That's the big difference from the primer's [master-slave replication](/learn/database#master-slave-replication).

- **Partitioning** uses [consistent hashing](/learn/consistent-hashing). Each node owns many small token ranges (virtual nodes) on a hash ring. A key's position on the ring is the hash of the key.
- **Replication**: a key lives on the first N distinct physical nodes clockwise from its position. This list is the key's **preference list**. The placement is zone-aware, so it skips a node if that zone already has a replica. With N = 3 and 3 zones, every key has one copy per zone.
- **Coordination**: any node can coordinate any request. It finds the preference list, forwards to the replicas and waits for enough answers. A token-aware client library that knows the ring can send the request straight to a replica, saving a network hop.
- **Membership and failure detection** spread by gossip.
- **The storage engine** on each node is a log-structured merge tree (LSM).

```diagram
title: A quorum write with N = 3, W = 2. The coordinator acks once two zones have the write
[c:client] Client @ 0,1
[co] Coordinator\n(any node) @ 1,1
[a:store] Replica A\nzone 1 @ 2,0
[b:store] Replica B\nzone 2 @ 2,1
[d:store] Replica C\nzone 3 @ 2,2
[n:note] Ack to client\nafter 2 of 3 @ 3,1
c -> co : put
co -> a
co -> b
co -> d
```

The coordinator is often one of the three replicas itself, which removes a hop. Whether it is or not, it always sends to all N replicas and waits only for W of them.

## Replication, quorums and conflicts

### Tunable quorums

Three numbers control consistency and availability:

- **N**: how many replicas each key has.
- **W**: how many replicas must confirm a write before the coordinator reports success.
- **R**: how many replicas must answer a read before the coordinator returns.

If **R + W > N**, every read set overlaps every write set in at least one replica, so a read sees at least one copy of the latest successful write. The coordinator returns the newest version among the replies.

| N | W | R | Overlap | What you get |
|---|---|---|---|---|
| 3 | 1 | 1 | No | Fastest. Reads may be stale. Tolerates 2 replicas down. |
| 3 | 2 | 2 | Yes | The common default. Tolerates 1 replica down for both reads and writes. |
| 3 | 3 | 1 | Yes | Fast reads, but writes fail if any replica is down. |
| 3 | 1 | 3 | Yes | Fast writes, but reads fail if any replica is down. |

A nice side effect: with W = 2, write latency is the second-fastest of three replicas, so one slow node doesn't slow every write. Cassandra exposes these choices as consistency levels like `ONE`, `QUORUM`, `ALL` and `LOCAL_QUORUM` (a quorum within the local data centre).

Be careful not to oversell R + W > N. It **doesn't** make the store linearizable. A write that reached only one replica before failing isn't rolled back, so it may show up in later reads. Two concurrent writes still conflict. And sloppy quorums, covered below, break the overlap guarantee entirely. For true linearizability, you need consensus.

### Versioning: last-writer-wins or vector clocks

Because any replica can accept a write, two clients can update the same key at the same time through different coordinators. The store needs a rule for which version survives.

**Last-writer-wins (LWW)** attaches a timestamp to each write and keeps the highest. It's simple, and reads return one value. The cost is that a concurrent write is **silently discarded**, and clock skew between machines can make an older write win. Cassandra uses LWW, but per column rather than per row, so concurrent updates to different columns of the same row both survive. LWW is fine when writes overwrite whole values and losing a racing update is acceptable, as with caches, session data and "latest position" records.

**Vector clocks** record causality instead of wall-clock time. A version carries a list of (node, counter) pairs. Version X descends from version Y if every counter in Y is less than or equal to the matching counter in X. If neither descends from the other, they're concurrent, a real conflict.

Here's an example with a shared shopping list, key `list:42`. Conflicts don't need a network partition. A client working from a stale read is enough:

1. The phone adds "milk" through coordinator X. The list is now version `[X:1]`.
2. The laptop reads `[X:1]`, adds "eggs" and writes through coordinator Y, passing the context it read. The new version is `[X:1, Y:1]`, which descends from `[X:1]`, so the old version is dropped.
3. The phone never re-read the list. It still holds context `[X:1]`, adds "bread" and writes through X, which gets `[X:2]`.
4. Compare `[X:2]` with `[X:1, Y:1]`. The first has a higher X counter, the second has a Y counter the first lacks, so neither descends from the other. A later `get` returns both as **siblings** ("milk, bread" and "milk, eggs"), with a context that covers `[X:2, Y:1]`.
5. The app merges them into "milk, eggs, bread" and writes through coordinator Z: `[X:2, Y:1, Z:1]`. That descends from both siblings, so they're discarded.

Under LWW, step 3 would have silently erased the eggs.

The cost moves to the application, which must know how to merge. Some merges are hard: a union-merge of a set can bring back items that one side deleted. Clocks also grow as more coordinators touch a key. Dynamo trimmed the oldest entries past a threshold, and Riak later moved to dotted version vectors to limit sibling growth.

### Failure detection with gossip

There's no central registry deciding who's alive. Every second or so, each node picks one or a few random peers and exchanges its membership view: which nodes exist, which tokens they own, and a heartbeat counter for each. News spreads to the whole cluster in a number of rounds that grows with the logarithm of the cluster size.

Each node decides locally whether a peer is down. A peer is down if its heartbeat counter stops advancing, or, in Cassandra's phi accrual detector, if the gap since the last heartbeat is unlikely given the usual gaps. A temporary "down" just routes traffic around the node. Permanent removal from the ring is an operator action, so a five-minute reboot doesn't trigger terabytes of data movement.

### Sloppy quorum and hinted handoff

Suppose replica B, in the preference list for a key, is down, and a client writes with W = 2. A strict quorum would still reach A and C, but in a bad partition the coordinator might reach only A.

Dynamo uses a **sloppy quorum**: the write goes to the first N *healthy* nodes on the ring. If B is down, the next node along, D, takes the write with a **hint** saying "this belongs to B". D stores hints separately and replays them to B when gossip says B is back. Writes stay available, which was Dynamo's goal.

The price is that the W nodes that took the write may not overlap the R nodes a later read contacts, so R + W > N no longer guarantees fresh reads. Practice varies here. Cassandra also stores hints (on the coordinator) but doesn't count them toward the consistency level, except at its weakest level, `ANY`. So Cassandra keeps strict quorums and treats hints purely as a repair aid. Hints also expire (Cassandra's default window is 3 hours), after which only full repair fixes a replica that was down longer.

### Anti-entropy with Merkle trees

Replicas still drift: a hint expired, a node lost a disk, a write reached only one replica. Two mechanisms fix this.

- **Read repair**: when a coordinator sees replicas disagree during a read, it writes the newest version back to the stale ones. This is cheap, but it only fixes keys that someone reads.
- **Anti-entropy repair**: replicas compare their whole data sets in the background. Shipping every key to compare would be far too expensive, so they compare **Merkle trees**. Each leaf is a hash of the keys in a small slice of a token range, and each parent is a hash of its children. Two replicas compare root hashes. If the roots match, the whole range matches. If not, they move down only into the children that differ.

For scale: a token range with 1 million keys and a tree with 2¹⁵ = 32,768 leaves has about 30 keys per leaf (1,000,000 / 32,768 ≈ 30.5). If one key differs, the replicas follow a single path 15 levels down, comparing a few dozen hashes, then exchange about 30 keys instead of 1 million. The cost is building the trees, which means reading all the data. That's why full repair is scheduled and throttled.

## Storage engine

Each node needs an engine that absorbs a steady stream of writes and still serves point reads fast. The log-structured merge tree (LSM) fits, and it's used by Cassandra, RocksDB, LevelDB and HBase, among others. The LSM idea dates to a 1996 paper by O'Neil and colleagues, and the memtable and SSTable terms come from Google's Bigtable paper.

```diagram
title: LSM write and read paths on one node
[w:client] Write @ 0,0
[log:store] Commit log @ 1,0
[mem] Memtable\n(sorted) @ 2,0
[r:client] Read @ 0,1.5
[bf:note] Bloom filter\nper SSTable @ 1,1.5
[sst:store] SSTables\n(immutable) @ 2,1.5
[cmp] Compaction @ 3,1.5
w -> log : 1 append
log -> mem : 2 insert
mem --> sst : flush
r -> mem
r -> bf
bf -> sst : maybe here
sst <-> cmp
```

### Write path

1. **Append to the commit log.** This is a sequential write, so it's fast, and it makes the write durable. How often to `fsync` is a trade-off. Syncing every write is safest but slowest. Batching syncs every few milliseconds (group commit) is much faster but can lose the last few milliseconds on power loss. That's often acceptable because the other replicas have the write too.
2. **Insert into the memtable.** This is a sorted in-memory structure, often a skip list.
3. **Ack** the coordinator.
4. When the memtable reaches a size limit (tens to hundreds of MB, depending on configuration), freeze it and write it to disk as an **SSTable** (sorted string table). That's an immutable file of sorted key-value blocks, with a block index and a Bloom filter. Once the SSTable is safe on disk, the matching commit-log segment can be deleted.

No write ever modifies data in place. That's why LSM engines are good at writes.

### Read path

1. Check the memtable, since it holds the newest data.
2. Check SSTables from newest to oldest. For each one, first ask its **Bloom filter**: "could this key be in here?" A "no" is always correct, so you skip the file without touching disk. A "maybe" means you use the block index to find the one block that could hold the key, then read it (often from a block cache).
3. With whole-value versions, you can stop at the first SSTable that has the key. With per-column timestamps, as in Cassandra, you merge fragments from several SSTables.

### Bloom filters

A Bloom filter is a bit array plus k hash functions. Adding a key sets k bits, and a lookup checks those k bits. It never gives false negatives, only occasional false positives. The false-positive rate is about (1 − e^(−kn/m))^k for n keys in m bits. At 10 bits per key with k = 7, that's kn/m = 0.7, so (1 − e^(−0.7))^7 ≈ (0.503)^7 ≈ 0.8%. So about 1 in 120 lookups for an absent key wastes a disk read.

The memory cost for our cluster: each node holds 5 × 10⁹ × 3 / 24 ≈ 625 million records. At 10 bits per key, that's 6.25 × 10⁹ bits ≈ 780 MB of RAM per node. That's affordable, and it's why every SSTable gets a filter.

### Compaction and deletes

SSTables pile up, and reads slow down as they check more files. **Compaction** merges SSTables, keeps the newest version of each key and writes new, larger files. Two common strategies:

| | Size-tiered | Leveled |
|---|---|---|
| How | Merge several similar-sized SSTables into one bigger one | Levels, each about 10× bigger than the last. Within a level, files don't overlap in key range. |
| Write cost | Lower: data is rewritten fewer times | Higher: data is rewritten as it moves down levels |
| Read cost | Higher: a key may be in many files | Lower: at most one file per level |
| Space | Can briefly need about 2× during big merges | Little overhead |
| Good for | Write-heavy workloads | Read-heavy or update-heavy workloads |

A delete can't just remove the key. A replica that missed the delete would later "repair" the old value back onto the others. So a delete writes a **tombstone**, which replicates like any write. Compaction drops tombstones only after a grace period that must be longer than your repair interval (Cassandra's default is 10 days). Run repair less often than that, and deleted data can come back.

## Scaling and bottlenecks

- **Adding nodes.** A new node takes some tokens and streams those ranges from the current owners. With virtual nodes, it takes small slices from many peers, so no single node does all the streaming. Going from 24 to 25 nodes moves about 30 TB / 25 = 1.2 TB onto the new node. Throttle the streaming so it doesn't hurt live traffic.
- **Hot keys.** Consistent hashing spreads keys, not load. One very popular key still lands on its N replicas. Options: put a [cache](/learn/cache) in front, let hot-key reads use R = 1 and spread across all replicas, or split the key at the application level (`counter:7#0` … `counter:7#9`, summed on read).
- **Large values.** Big values bloat compaction and the memtable. Cap the size at 1 MB and keep larger blobs in object storage, with the key-value store holding a pointer.
- **Tail latency.** One slow replica, perhaps in the middle of a compaction or a garbage-collection pause, sets the p99 for reads at R = 1. **Speculative retry** sends the read to another replica if the first hasn't answered within, say, its usual p95 latency.
- **Background work.** Compaction and repair compete with live traffic for disk and network. Throttle both and schedule full repair per range, not all at once.
- **Multiple regions.** Place N replicas per region, use local quorums for low latency, and replicate across regions asynchronously. Cross-region conflicts then follow the same LWW or vector-clock rules, just more often.

## Trade-offs to discuss

- **Leaderless versus leader per partition.** Leaderless designs stay writable through failures and partitions, but you get eventual consistency and conflict handling. A leader per partition, replicated with Raft or Paxos, gives linearizable reads and writes with no siblings, but writes to a partition pause during leader election, and a minority side of a partition can't write. Amazon's DynamoDB service, despite the name, uses this leader-based approach rather than the original Dynamo design.
- **LWW versus vector clocks.** LWW is simple for clients but silently loses concurrent writes and depends on clocks. Vector clocks never lose a write, but every client must handle siblings.
- **Strict versus sloppy quorums.** Sloppy quorums keep writes available during failures at the cost of the R + W > N read guarantee.
- **Hash versus range partitioning.** Hashing spreads load evenly and avoids hot ranges, but range scans must hit every node. Range partitioning, as in Bigtable and HBase, supports scans but needs splitting and rebalancing as ranges get hot. This is the same choice the primer raises for [sharding](/learn/database#sharding).
- **LSM versus B-tree.** LSM engines turn random writes into sequential ones and compress well, but they pay with compaction work and multi-file reads. B-tree engines, the norm in relational databases, read in a predictable number of page lookups but update pages in place.

## Check yourself

<details>
<summary>With N = 3, a team sets W = 1 and R = 1 for speed, then complains that users sometimes don't see their own updates. Explain why, and give two different fixes with their costs.</summary>

With W = 1 and R = 1, the replica that took the write and the replica that answered the read can differ, since 1 + 1 isn't greater than 3. So a read can miss a write that succeeded. One fix is W = 2, R = 2, which guarantees overlap but adds latency to both paths and fails if two replicas are down. Another, if writes are rare, is W = 3 and R = 1: reads stay as fast as before, but every write waits for the slowest replica and fails whenever any replica is down.

</details>

<details>
<summary>Two concurrent writes to the same key carry vector clocks [A:3, B:1] and [A:2, B:2]. What does the store do? What would a last-writer-wins store do?</summary>

Neither clock descends from the other: the first has a higher A counter, the second a higher B counter. So they're concurrent, and a vector-clock store keeps both as siblings and returns both on the next read for the application to merge. A last-writer-wins store would keep whichever had the later timestamp and silently drop the other, even if the "later" timestamp only came from a fast clock.

</details>

<details>
<summary>A node was down for 6 hours. Cassandra's hint window is 3 hours. What state is its data in when it returns, and what fixes it?</summary>

Hints covered only the first 3 hours of missed writes. After that, coordinators stopped storing hints for it, so the node is missing writes from the remaining 3 hours. Read repair will fix keys as they're read, but the reliable fix is an anti-entropy repair over the node's ranges. Merkle trees find the differing slices and stream only those. Until repair finishes, reads at R = 1 that hit this node can return stale data.

</details>

<details>
<summary>Your read latency rises steadily over a week of heavy writes, then drops sharply. What's probably happening in the storage engine?</summary>

SSTables are piling up faster than compaction merges them, so each read checks more files, with more Bloom-filter checks, more false positives and more disk reads. The sharp drop is a large compaction finally merging them. Fixes include giving compaction more I/O, switching that table to leveled compaction if it's read-heavy, or checking whether tombstones are piling up and slowing reads.

</details>

<details>
<summary>An interviewer asks you to support "get all keys with prefix user:42:". What changes in the design?</summary>

With hash partitioning, keys sharing a prefix are scattered across the ring, so a prefix query would have to ask every node. One option is to partition by a prefix (the partition key) and keep keys sorted within the partition, as Cassandra does with partition and clustering keys. Then `user:42:*` lives together on one replica set and an SSTable range scan serves it. The cost is that a single huge or hot prefix becomes a hot partition, so you need limits on partition size.

</details>

## Further reading

- [Dynamo: Amazon's highly available key-value store (2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf): the original paper behind this design, covering consistent hashing, sloppy quorums, hinted handoff, vector clocks and Merkle trees.
- [Amazon DynamoDB: A scalable, predictably performant, and fully managed NoSQL database service (USENIX ATC 2022)](https://www.usenix.org/conference/atc22/presentation/elhemali): how the managed service differs, with leader-based replication per partition.
- [Bigtable: A distributed storage system for structured data (2006)](https://static.googleusercontent.com/media/research.google.com/en//archive/bigtable-osdi06.pdf): where memtables, SSTables and compaction come from.
- [Apache Cassandra documentation: Dynamo](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html): how a production system implements and departs from Dynamo.
- [RocksDB wiki: Leveled compaction](https://github.com/facebook/rocksdb/wiki/Leveled-Compaction): a clear explanation of levels and their trade-offs.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design a key-value store".
- [System Design School primer](https://systemdesignschool.io/primer): "Partitioning" and "NoSQL Databases".
