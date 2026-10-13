# Database 101: storage engines, indexes and sharding

What happens on disk when you run `INSERT INTO users VALUES (...)`, or `SELECT * FROM orders WHERE user_id = 42`?

The primer's [database](/learn/database) chapter covers relational and NoSQL databases, replication and sharding at a high level. In a design discussion, "we'll use a database" and "we'll shard by user ID" are only the start. The follow-up questions are about what's underneath: why a B-Tree engine like InnoDB struggles with a heavy random-write load that Cassandra or RocksDB absorbs, how many disk reads a lookup costs, why the order of columns in a composite index matters, and how Google Spanner uses clocks to order transactions across the world.

This chapter works up from the disk: the two main storage engine designs (B-Trees and log-structured merge-trees), how indexes are laid out, sharding strategies and the mistakes that hurt most, and distributed SQL databases such as Spanner and CockroachDB. It builds on [CAP and consistency 101](/learn/cap-and-consistency-101).

## Storage engines: how bytes reach the disk

Storage engines are shaped by one fact: **sequential I/O is much cheaper than random I/O**.

On a spinning disk that's obvious, because a random read means moving the head. SSDs have no moving parts, but the gap is still there. A flash drive can't overwrite a page in place; it writes new pages and erases old blocks in the background, so lots of small random writes cause extra internal copying (write amplification inside the drive) and wear. Large sequential writes are the cheapest thing you can ask a drive to do.

Two families of engines respond to this differently.

```diagram
title: Two ways to lay data out on disk
[btree:store] B-Tree engine\nInnoDB, Postgres @ 0.5,0
[lsm:store] LSM-tree engine\nRocksDB, Cassandra @ 2.5,0
[pages] Overwrite pages\nin place @ 0.5,1.3
[logs] Append sorted\nfiles, merge later @ 2.5,1.3
btree -> pages : update
lsm -> logs : update
```

- A **B-Tree** keeps one sorted copy of the data in fixed-size pages and updates pages in place.
- A **log-structured merge-tree (LSM-tree)** never modifies data on disk. It writes new sorted files and merges them in the background.

### B-Trees: the default for transactional databases

Rudolf Bayer and Edward McCreight described the B-Tree in 1970 (the paper appeared in 1972). Its variant, the **B+ Tree**, is what MySQL's InnoDB, PostgreSQL's indexes, SQLite and SQL Server use.

#### How it's organized

1. **Fixed-size pages.** The file is divided into pages, typically 4, 8 or 16 KB (InnoDB uses 16 KB, PostgreSQL 8 KB). A page is the unit the engine reads and writes.
2. **High fan-out.** An interior page holds keys and pointers to child pages. With 8-byte keys and 6- to 8-byte pointers, a 16 KB page has room for around a thousand children. Real pages are partly empty and keys are often longer, so a few hundred is a more typical working figure.
3. **Shallow trees.** Each level multiplies the reach by the fan-out. With a fan-out of 1,000, three levels reach 1,000³ = **a billion** entries and four reach a trillion. The root and the next level are read constantly, so they stay in the buffer pool in memory. Finding one row in a billion-row table then costs about one or two disk reads.
4. **Linked leaves.** In a B+ Tree, interior pages hold only keys for routing. Data (or pointers to it) lives only in the leaves, and each leaf links to its neighbors. A range query such as `WHERE age BETWEEN 20 AND 30` walks down the tree once to the first matching leaf, then follows the links sideways.

```diagram
title: A B+ Tree: route down, then scan along the leaves
[root] Root page\n(in memory) @ 1.5,0
[int1] Interior page @ 0.5,1
[int2] Interior page @ 2.5,1
[leaf1:store] Leaf\nkeys 1–100 @ 0,2.2
[leaf2:store] Leaf\nkeys 101–200 @ 1.5,2.2
[leaf3:store] Leaf\nkeys 201–300 @ 3,2.2
root -> int1
root -> int2
int1 -> leaf1
int1 -> leaf2
int2 -> leaf3
leaf1 <-> leaf2 : next / prev
leaf2 <-> leaf3 : next / prev
```

#### The cost of updating in place

To change one 100-byte row, InnoDB can't write just those 100 bytes. It:

1. Reads the 16 KB page holding the row into the buffer pool, if it isn't there already.
2. Changes the row in memory.
3. Later, writes the whole 16 KB page back to its place on disk.

If a page is full, an insert splits it into two, and the parent page has to change too.

To survive a crash between those steps, B-Tree engines keep a **write-ahead log (WAL)**: before a change is applied to a data page, a record of it is appended to the log and flushed. In MySQL it's called the redo log; PostgreSQL calls it the WAL. After a crash, the engine replays the log to redo changes that hadn't reached the data pages. Because a 16 KB page write can be torn halfway by a power cut, engines also protect the pages themselves: InnoDB writes each page to a doublewrite buffer first, and PostgreSQL logs a full copy of each page the first time it changes after a checkpoint.

So every change is written at least twice, once to the log and once to the page, and a small change costs a whole page write. That's **write amplification**. With many writes spread across a large table, page flushes become random I/O, and that's where B-Tree engines run out of disk throughput first.

### LSM-trees: built for heavy writes

In 1996, Patrick O'Neil, Edward Cheng, Dieter Gawlick and Elizabeth O'Neil published *The Log-Structured Merge-Tree (LSM-Tree)*. The idea: never update data in place on disk. Buffer writes in memory, write them out as new sorted files, and merge files in the background.

LSM-trees are used by LevelDB, RocksDB, Cassandra, ScyllaDB, HBase, Google Bigtable, and CockroachDB (through Pebble, its RocksDB-like engine).

```diagram
title: LSM-tree write path
[client:client] Write @ 0,0.5
[wal:store] WAL\n(append only) @ 1.5,0
[mem] MemTable\n(sorted, in RAM) @ 1.5,1
[l0:store] Level 0\nSSTables @ 3,1
[l1:store] Level 1+\nSSTables @ 3,0
client -> wal : 1. append
client -> mem : 2. insert
mem -> l0 : 3. flush when full
l0 -> l1 : 4. compaction
```

#### Writing

1. **Append to the WAL.** Each write (`PUT key value` or `DELETE key`) is appended to a log on disk so it survives a crash. Appends are sequential.
2. **Insert into the MemTable.** The write also goes into an in-memory sorted structure, the **MemTable**, usually a skip list. Once both steps are done the write is acknowledged.
3. **Flush to an SSTable.** When the MemTable reaches a size limit (RocksDB's default is 64 MB), it's frozen and written out in one sequential pass as a **sorted string table (SSTable)**: a file of key-value pairs in key order, with a small index and a Bloom filter. SSTables are **immutable**; once written, they're never changed. The WAL segment for that MemTable can then be dropped.
4. **Updates and deletes are new entries.** An update is a newer entry for the same key. A delete writes a marker called a **tombstone**. The old values stay in older files until compaction removes them.

#### Reading, Bloom filters and compaction

A key's newest value may be in the MemTable or in any SSTable, so a read checks newest first:

- Look in the MemTable.
- Then check SSTables from newest to oldest, stopping at the first match (a tombstone means "deleted").

Checking many files for one key is **read amplification**. Two things keep it down:

- **Bloom filters.** Each SSTable has a Bloom filter, usually kept in memory: a bit array that answers "is this key in this file?" with "definitely not" or "probably yes". If it says "definitely not", the engine skips the file without reading it. At about 10 bits per key the false positive rate is around 1%, so a point lookup usually reads only the one file that has the key. Bloom filters don't help range scans, which still have to merge every file whose key range overlaps.
- **Compaction.** Background threads read several SSTables, merge them in key order (like the merge step of merge sort), keep only the newest version of each key, drop tombstones once nothing older can be hiding behind them, and write new SSTables. Fewer files means fewer places to look and less space wasted on old versions.

Two common compaction strategies:

- **Size-tiered** (Cassandra's default): when there are several SSTables of similar size, merge them into one bigger file. It rewrites data fewer times, so it suits write-heavy loads. But a key can be in many files, and a big merge temporarily needs free space about equal to the files being merged, so operators leave a lot of disk free.
- **Leveled** (RocksDB's default): data is arranged in levels L0, L1, L2 and so on, each about 10 times larger than the one before. Within each level below L0, files don't overlap in key range, so a lookup reads at most one file per level. Reads and disk usage are more predictable; the price is more rewriting, because data is merged again each time it moves down a level.

#### B-Tree vs LSM-tree

| | B-Tree (InnoDB, PostgreSQL) | LSM-tree (RocksDB, Cassandra) |
|---|---|---|
| Good at | Predictable reads and range scans | High write rates |
| How a write lands | Log append now, page overwrite later | Log append and MemTable insert; files written sequentially later |
| Write amplification | Whole page per small change, plus the log | Data rewritten by each compaction, but always sequentially |
| Read cost | One path down the tree, often one or two disk reads | MemTable plus several files; Bloom filters skip most |
| Space overhead | Partly empty pages after splits and deletes | Old versions until compacted; low with leveled compaction, higher with size-tiered |
| Latency spikes | Checkpoints can cause flush bursts | Heavy compaction can compete with foreground reads and writes |

Neither wins everywhere. Benchmark with your own workload: plenty of write-heavy systems run happily on PostgreSQL, and RocksDB serves read-heavy workloads too.

## Indexes: getting query performance right

An index is an extra data structure that lets the database find rows without reading the whole table. Missing or badly ordered indexes are one of the most common reasons a query is slow.

### Clustered, secondary and covering indexes

```diagram
title: A secondary index lookup in InnoDB
[q:client] WHERE email = ? @ 0,0
[sec:store] Secondary index\nemail → user_id @ 1.5,0
[pk:store] Clustered index\nuser_id → row @ 3,0
[row] Full row\n(name, address…) @ 3,1.2
q -> sec : 1. search email
sec -> pk : 2. look up user_id
pk -> row : leaf holds row
```

**Clustered index.** The table's rows are stored inside the index itself, in key order.

- A table can have only one, because rows can only be stored in one order.
- In InnoDB, the primary key is always the clustered index. Its leaf pages hold whole rows.
- PostgreSQL is different: rows live in an unordered heap, and every index, including the primary key's, points into the heap. (Its `CLUSTER` command reorders the heap once but doesn't keep it ordered.)

**Secondary index.** An index on other columns, such as `CREATE INDEX idx_email ON users(email)`.

- In InnoDB, a secondary index's leaves hold the indexed columns plus the row's **primary key**, not the row.
- So `SELECT * FROM users WHERE email = 'alice@example.com'` is two searches: down the email index to find `user_id = 42`, then down the clustered index to fetch the row.
- In PostgreSQL the second step is a fetch from the heap instead.

**Covering index.** If every column a query needs is in the index, the database answers from the index alone and skips the second lookup. This is an **index-only scan**.

- `SELECT user_id, email FROM users WHERE email = 'alice@example.com'` is covered by `idx_email` in InnoDB, because the leaf holds `email` and the primary key `user_id`.
- To cover more columns, add them to the index: a composite index on `(email, full_name)`, or in PostgreSQL and SQL Server, `INCLUDE (full_name)`, which stores the column in the leaves without making it part of the key.
- How much faster this is depends on whether the second lookup would have gone to disk. For a query returning many rows, skipping one random read per row can be a large win. In PostgreSQL, an index-only scan still has to check row visibility for pages not yet marked all-visible by vacuum.

The trade-off: every index makes writes slower and takes space, and wide covering indexes do so more.

### The leftmost prefix rule

A composite index covers several columns:

```sql
CREATE INDEX idx_orders ON orders (user_id, status, created_at);
```

Entries are sorted by `user_id`, then by `status` within the same `user_id`, then by `created_at` within the same `status`, like a phone book sorted by last name and then first name. The index helps when a query constrains a **leftmost prefix** of those columns:

```sql
-- Uses all three columns
SELECT * FROM orders WHERE user_id = 10 AND status = 'PAID' AND created_at > '2026-01-01';

-- Uses user_id and status
SELECT * FROM orders WHERE user_id = 10 AND status = 'PAID';

-- Uses user_id only
SELECT * FROM orders WHERE user_id = 10;

-- Can't seek with this index: the first column isn't constrained
SELECT * FROM orders WHERE status = 'PAID';
SELECT * FROM orders WHERE created_at > '2026-01-01';
```

The last two are like looking up everyone named "Maria" in a phone book sorted by last name: the order doesn't help. (Some engines can still use the index there, with tricks such as MySQL's skip scan when the first column has few distinct values, but don't design around that.)

**Equality first, range last.** Once the index hits a range condition (`<`, `>`, `BETWEEN`, `LIKE 'abc%'`), the columns after it can't narrow the search any further. Take the query `WHERE user_id = 10 AND status = 'PAID' AND created_at > '2026-01-01'`:

- With an index on `(user_id, created_at, status)`, the database seeks to `user_id = 10`, scans every entry with a recent `created_at`, and checks `status` on each one as it goes.
- With an index on `(user_id, status, created_at)`, it seeks straight to `user_id = 10, status = 'PAID'` and scans only the matching date range.

So put columns compared with `=` first and the range column last.

## Sharding

When a table outgrows the storage or write capacity of the biggest single server you're willing to run, you split its rows across several databases. Each database holds a **shard**, and a **shard key** decides which shard a row belongs to.

```diagram
title: Targeted vs scatter-gather queries
[c1:client] user_id = 42 @ 0,0
[c2:client] status = 'PENDING'\n(no shard key) @ 0,1.6
[router] Router\n(Vitess, Citus…) @ 1.5,0.8
[s1:store] Shard 1 @ 3,0
[s2:store] Shard 2 @ 3,0.8
[s3:store] Shard 3 @ 3,1.6
c1 -> router
c2 -> router
router -> s1 : one shard
router --> s2 : scatter
router --> s3 : scatter
```

A query that includes the shard key goes to one shard. A query without it has to ask all of them.

### Partitioning strategies

#### Range partitioning

Each shard holds a continuous range of the key: user IDs 1–1,000,000 on shard 1, 1,000,001–2,000,000 on shard 2, or one shard per month.

- **Good:** range queries on the key (`WHERE id BETWEEN 500 AND 600`) touch one shard or a few neighbors.
- **Bad:** if the key always increases, such as an auto-increment ID, a timestamp or a Snowflake ID, every new row goes to the last range. All the write traffic lands on one shard while the others sit idle. That's a **hot spot**.

#### Hash partitioning

Hash the shard key and use the hash to pick a shard.

- **Good:** keys spread evenly, so increasing keys no longer pile onto one shard.
- **Bad:** neighboring keys hash to unrelated shards, so a range query on the key (`WHERE user_id BETWEEN 10 AND 100`) has to go to every shard.

The simplest version is `shard = hash(user_id) mod N`. Its problem is changing N: going from 4 to 5 shards changes the shard for about 80% of keys, so most of the data has to move. **[Consistent hashing](/learn/consistent-hashing)** fixes that by placing shards and keys on a ring. Adding a shard takes over only the keys next to it, about 1/N of the total, and virtual nodes keep the load even. Many systems take a simpler route with the same effect: split the hash space into many more fixed partitions than there are servers (say 1,024), and move whole partitions between servers.

#### Directory partitioning

A lookup service maps each key, or each tenant, to a shard: `tenant A → shard 3`, `tenant B → shard 1`. The mapping lives in a small, strongly consistent store such as etcd, ZooKeeper or a replicated SQL table, and routers cache it.

- **Good:** full control over placement. A very large customer can get a shard of its own, and you can move one tenant without touching the rest.
- **Bad:** the directory is one more thing to keep available and consistent, and every query needs the mapping, from the cache or a lookup.

### Sharding mistakes that hurt

#### Picking a shard key with a hot spot

The range case above is the classic example, but hash partitioning has its own version: a key that's hot by nature. Sharding by `tenant_id` when one tenant generates half the traffic, or by `celebrity_id` for a social feed, puts that load on one shard no matter how the hashing works. Look at the distribution of traffic per key, not just the number of distinct keys, before choosing.

#### Scatter-gather queries

If a query doesn't include the shard key, for example `SELECT * FROM orders WHERE status = 'PROCESSING' ORDER BY created_at DESC LIMIT 10` on a table sharded by `user_id`, the router can't tell which shard has the answer. It has to:

1. Send the query to all N shards.
2. Get each shard's top 10.
3. Merge the 10 × N results and return the overall top 10.

The query is as slow as the **slowest** shard. If each shard has a 1% chance of a slow response, a query that touches 50 shards hits at least one slow shard 1 − 0.99⁵⁰ ≈ **40%** of the time. Every scatter query also uses capacity on every shard, so total query load grows with the number of shards. Occasional scatter queries are fine. If a frequent query needs a different key, keep a second copy of the data sharded or indexed by that key, for example a global secondary index or a separate table maintained from a change stream.

#### Cross-shard joins and transactions

On one server, joining `users` to `orders` is a local operation. Shard both tables on unrelated keys, and the join has to ship rows over the network to some coordinator to be matched. A transaction that updates rows on two shards needs a [distributed transaction](/learn/distributed-transactions) protocol such as two-phase commit, which is slower and harder to operate.

The fix is to **co-locate** data that's used together by sharding it on the same key. In a store, shard `orders`, `order_items` and `shipments` all by `user_id`, so one customer's whole order history lives on one shard and joins and transactions on it stay local. Spanner supports this directly with interleaved tables, which store child rows physically next to their parent row.

#### Resharding as an afterthought

Splitting a shard means copying data while it's being written, then switching traffic over without losing writes. Doing this by hand under pressure is risky. Plan for it from the start: choose a scheme that moves partitions, not individual keys, or use a system (Vitess, Citus, or the distributed SQL databases below) that automates it.

## Distributed SQL

For a long time the options looked like this:

- **A single-node relational database** (MySQL, PostgreSQL): ACID transactions, SQL, joins and secondary indexes. Scaling writes beyond one machine meant sharding in the application, with all the problems above.
- **A NoSQL store** (Cassandra, DynamoDB, early MongoDB): horizontal scaling and multi-region replication built in, but limited or no multi-row transactions, and few or no joins.

**Distributed SQL** databases (Google Spanner, CockroachDB, YugabyteDB, TiDB) aim for both: SQL and serializable transactions across many machines, with sharding and replication handled by the database. They don't escape the [CAP theorem](/learn/cap-and-consistency-101): they choose consistency, so a partition that cuts off a majority of replicas makes that data unavailable, and every write pays for a consensus round trip, which is slow across regions.

```diagram
title: How distributed SQL databases are layered
[sql] SQL layer\n(stateless nodes) @ 1.5,0
[kv:store] Sorted key-value\nstore, in ranges @ 1.5,1.2
[raft] Raft or Paxos\ngroup per range @ 1.5,2.4
sql -> kv : rows → keys
kv -> raft : replicate
```

### Ranges and consensus

These systems store every table and index as entries in **one large sorted key space**, with keys built from the table ID, index ID and primary key.

- The key space is cut into contiguous chunks called **ranges** (CockroachDB) or regions (TiDB). They're a few hundred MB each by default; CockroachDB's limit is 512 MiB.
- When a range grows past its limit, it splits in two automatically, and the database moves ranges between nodes to balance load. This is range partitioning, done automatically, with hot ranges split further.
- Each range is replicated to 3 or 5 nodes, usually in different zones, by a [consensus](/learn/consensus) group: Raft in CockroachDB, TiDB and YugabyteDB, Paxos in Spanner. A write commits once a majority of the range's replicas have it.

A transaction that touches several ranges uses a commit protocol layered on top of consensus, a form of two-phase commit in which every participant is itself a replicated group.

### Ordering transactions with clocks: Spanner's TrueTime

To give every transaction a timestamp that respects real-world order, across machines in many datacenters, you need clocks you can trust. Ordinary clocks synchronized with NTP are usually within a few milliseconds of each other, but the error can grow much larger, and a machine can't tell how wrong its own clock is. If server A's clock runs 10 ms ahead of server B's, a transaction on B that starts after one on A has committed can still get an earlier timestamp, and a reader could see the second change without the first.

Google's **Spanner** handles this with the **TrueTime** API.

- Each datacenter has time masters with GPS receivers and some with atomic clocks. Every server polls several masters.
- `TT.now()` doesn't return a single time. It returns an interval `[earliest, latest]` that is guaranteed to contain the true time. Its half-width ε is the clock uncertainty, and the 2012 paper reports it varying between about 1 and 7 ms.

Spanner uses that interval for **commit wait**:

1. The transaction's leader picks a commit timestamp `s` no earlier than `TT.now().latest`, so `s` is not before the true time.
2. Before making the commit visible and releasing locks, it waits until `TT.now().earliest > s`, meaning `s` is certainly in the past on every clock.

```text
s = TT.now().latest
wait until TT.now().earliest > s     (about 2ε, on average)
then release locks and acknowledge the commit
```

Because of the wait, any transaction that starts after this one commits, on any server anywhere, sees a time later than `s` and gets a larger timestamp. Timestamps therefore match real-time order. This property is called **external consistency**, also known as strict serializability. The wait lasts about 2ε, a few milliseconds, and Spanner overlaps it with the Paxos replication it has to do anyway, so it often adds little latency. Smaller ε means shorter waits, which is why Google invests in the clock hardware.

Spanner uses locks (two-phase locking) for read-write transactions, and the timestamps let read-only transactions read a consistent snapshot at any timestamp without taking locks.

**CockroachDB** runs on ordinary hardware without TrueTime. It uses **hybrid logical clocks** (physical time combined with a logical counter) and assumes clocks are within a configured maximum offset of each other (500 ms by default). When a read finds a value with a timestamp inside its uncertainty window, so it can't tell whether that write came before or after it, it moves its own timestamp later and retries, which may restart the transaction. Nodes whose clocks drift past the limit shut themselves down. The result is serializable transactions without commit wait, at the cost of occasional retries and a weaker real-time guarantee than Spanner's.

## Check yourself

<details>
<summary>Why can an LSM-tree take a much higher write rate than a B-Tree on the same drive?</summary>

A B-Tree updates pages in place. A small change means appending to the WAL and later writing back the whole 8 or 16 KB page that holds the row, at that page's position on disk. With writes spread over a large table, those page writes are random and each carries mostly unchanged bytes.

An LSM-tree turns every write into sequential I/O. The write is appended to the WAL and inserted into the in-memory MemTable, and the client is acknowledged. When the MemTable fills, it's written out as an SSTable in one sequential pass. Merging old versions is left to background compaction, which also writes sequentially. The cost moves to reads, which may have to check several files, and Bloom filters keep most of those checks in memory.

</details>

<details>
<summary>In InnoDB, why can `SELECT user_id, email FROM users WHERE email = ?` be faster than `SELECT * FROM users WHERE email = ?`, given an index on `email`?</summary>

InnoDB stores rows in the clustered primary key index. A secondary index on `email` stores only `email` and the primary key `user_id`. For `SELECT *`, the engine searches the email index to find `user_id`, then searches the clustered index to fetch the row: two tree searches, and possibly a random disk read for the second. For `SELECT user_id, email`, both columns are already in the email index's leaf, so the query is answered from the index alone, an index-only scan, and the second search never happens. Adding more columns to the index (or using `INCLUDE` in PostgreSQL) can make other queries covered too, at the cost of slower writes and more space.

</details>

<details>
<summary>An index on `(user_id, created_at, status)` exists, and a common query filters on `user_id = ?`, `status = 'PAID'` and `created_at > ?`. What's wrong, and what index would be better?</summary>

The range condition on `created_at` comes before `status` in the index. The engine can seek to the `user_id` and the start of the date range, but then has to scan every entry in that range and check `status` on each, including all the orders that aren't paid. An index on `(user_id, status, created_at)` puts both equality columns first, so the engine seeks directly to `user_id = ?, status = 'PAID'` and scans only the date range it needs.

</details>

<details>
<summary>Why is range partitioning on an auto-increment ID or a timestamp a bad choice for a write-heavy table?</summary>

Each new row has a larger key than every earlier row, so it always falls in the last range. All inserts go to one shard, which runs out of CPU, I/O or connections, while the shards holding older ranges get no writes. Adding shards doesn't help, because new writes still go only to the newest range. Hash partitioning on the key (or on a different key, such as `user_id`) spreads inserts over all shards, at the cost of making range queries on that key go to every shard.

</details>

<details>
<summary>What does Spanner's commit wait guarantee, and why does it depend on TrueTime's uncertainty bound?</summary>

It guarantees external consistency: if transaction T2 starts after T1 has committed in real time, T2 gets a larger timestamp, even if they run on servers on different continents. The leader picks T1's timestamp `s` at or above `TT.now().latest`, then waits until `TT.now().earliest > s` before releasing locks and acknowledging. After that, every clock in the system is past `s`, so any later transaction's timestamp exceeds it. The wait only works because TrueTime's interval is guaranteed to contain the true time; ordinary clocks have no such bound, so a system without one can't know how long to wait. The wait is about twice the uncertainty, a few milliseconds, which is why keeping ε small matters.

</details>

## Further reading

- [The Log-Structured Merge-Tree (LSM-Tree)](https://www.cs.umb.edu/~poneil/lsmtree.pdf) (O'Neil, Cheng, Gawlick and O'Neil, Acta Informatica, 1996): the paper that introduced the LSM-tree.
- [Designing Data-Intensive Applications](https://dataintensive.net/) by Martin Kleppmann (2017): chapter 3 compares B-Trees and LSM-trees, and chapter 6 covers partitioning.
- [Spanner: Google's Globally-Distributed Database](https://research.google/pubs/pub39966/) (Corbett et al., OSDI 2012): TrueTime, commit wait and external consistency.
- [CockroachDB: The Resilient Geo-Distributed SQL Database](https://dl.acm.org/doi/10.1145/3318464.3386134) (Taft et al., SIGMOD 2020): ranges, Raft, and transactions with hybrid logical clocks on ordinary hardware.
- [Use The Index, Luke!](https://use-the-index-luke.com/) by Markus Winand: how B-Tree indexes work and how to design composite indexes, across the major SQL databases.
