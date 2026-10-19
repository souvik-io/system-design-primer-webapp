# Database internals

This chapter answers five questions:

- How does a database lay data out on disk, and why do the two main designs, B-trees and LSM-trees, make opposite trade-offs?
- What does one lookup cost in disk reads, and what does one small write really cost?
- How are clustered, secondary and covering indexes laid out, and why does the order of columns in a composite index matter?
- Which ways of splitting rows across shards exist, and which sharding mistakes hurt most?
- How do distributed SQL databases such as Spanner and CockroachDB shard and replicate data for you, and how do they put transactions in order when every machine's clock is slightly wrong?

This chapter builds on two earlier ones. [Relational databases](/learn/relational-databases) covers ACID transactions, isolation levels, replication, federation, the basics of sharding and SQL tuning. [NoSQL and choosing a database](/learn/nosql-databases) covers the NoSQL families, BASE, and how to choose between SQL and NoSQL. Those chapters describe what a database promises. This one looks at the machinery that keeps those promises.

We'll keep using **Crumb**, the recipe site from [Scalability 101](/learn/scalability-101). Crumb keeps users, recipes, comments, ratings and paid cooking-class bookings in PostgreSQL. It logs every page view in a separate write-heavy store. Its main tables have started to outgrow one server, so it has begun sharding them by user ID. Each section below asks what happens underneath one of those choices.

## Storage engines: how bytes reach the disk

A **storage engine** is the part of a database that writes rows to disk and finds them again. The layers above it parse SQL and plan queries. The engine does the actual reading and writing.

Every storage engine is shaped by one fact: **sequential I/O is much cheaper than random I/O**. Sequential I/O reads or writes blocks that sit next to each other, one after another. Random I/O jumps between blocks scattered across the disk.

On a spinning disk the gap is obvious, because each jump means moving the read head. SSDs have no moving parts, but the gap is still there. A flash drive can't overwrite a page in place. It writes the new data to a fresh page and erases old blocks in the background. So many small random writes make the drive copy data around internally, which slows it down and wears it out. Large sequential writes are the cheapest thing you can ask any drive to do.

Two families of engines respond to this fact in different ways.

```diagram
title: Two ways to lay data out on disk
[btree:store] B-Tree engine\nInnoDB, Postgres @ 0.5,0
[lsm:store] LSM-tree engine\nRocksDB, Cassandra @ 2.5,0
[pages] Overwrite pages\nin place @ 0.5,1.3
[logs] Append sorted\nfiles, merge later @ 2.5,1.3
btree -> pages : update
lsm -> logs : update
```

- A **B-tree** keeps one sorted copy of the data in fixed-size pages. To change a row, it rewrites the page that holds it.
- A **log-structured merge-tree (LSM-tree)** never changes data that is already on disk. It writes new sorted files and merges them in the background.

### B-Trees: the default for transactional databases

Rudolf Bayer and Edward McCreight invented the B-tree while working at Boeing Research Labs. According to [Wikipedia](https://en.wikipedia.org/wiki/B-tree), they designed it "to efficiently manage index pages for large random-access files". Their paper first circulated in 1970 and was published in *Acta Informatica* in 1972. A variant called the **B+ tree** is what MySQL's InnoDB engine, PostgreSQL's indexes, SQLite and SQL Server use.

#### How a B-tree is organized

Say Crumb's `ratings` table has grown to a billion rows, and the database needs the row for one rating. Here is how a B+ tree finds it.

1. **The file is split into fixed-size pages.** A page is the unit the engine reads and writes. InnoDB's pages are 16 KB and PostgreSQL's are 8 KB, as [Relational databases](/learn/relational-databases#tighten-up-the-schema) notes.
2. **Each interior page points to many children.** An interior page holds keys and pointers to the pages one level down. The number of children per page is the **fan-out**. With 8-byte keys and 6- to 8-byte pointers, a 16 KB page has room for around a thousand children. Real pages are partly empty and keys are often longer, so a few hundred is a more typical working figure.
3. **So the tree stays shallow.** Each level multiplies the number of reachable entries by the fan-out. With a fan-out of 1,000, three levels reach 1,000³, which is **a billion** entries. Four levels reach a trillion. The root page and the level below it are read constantly, so they stay in the **buffer pool**, the database's cache of pages in memory. Finding one rating among a billion then costs about one or two disk reads.
4. **The leaves are linked.** In a B+ tree, interior pages hold only keys, which are used for routing. The data, or pointers to it, lives only in the leaf pages, and each leaf links to its neighbors. A range query such as `WHERE recipe_id BETWEEN 100 AND 300` walks down the tree once to the first matching leaf. Then it follows the links sideways until it passes the end of the range.

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

Now a Crumb user edits a comment, a change of about 100 bytes. InnoDB can't write just those 100 bytes. It does three things:

1. It reads the 16 KB page that holds the row into the buffer pool, if the page isn't there already.
2. It changes the row in memory.
3. Later, it writes the whole 16 KB page back to its place on disk.

If a page is full when a new row arrives, the engine **splits** it into two pages, and the parent page has to change too.

A crash can happen between any of these steps. To survive one, B-tree engines keep a **write-ahead log (WAL)**, an append-only file that records each change before the data pages are touched. [Relational databases](/learn/relational-databases#durability-committed-means-saved) explains how the WAL makes committed transactions durable. MySQL calls this file the redo log, and PostgreSQL calls it the WAL. After a crash, the engine replays the log to redo any changes that hadn't reached the data pages.

There is one more risk. A power cut can interrupt a 16 KB page write halfway, leaving a **torn page** that is part old data and part new. A log record of one row change can't repair that. So engines protect the pages themselves:

- InnoDB first writes each page to a **doublewrite buffer**. If the server fails in the middle of a page write, InnoDB "can find a good copy of the page from the doublewrite buffer during crash recovery" ([MySQL documentation](https://dev.mysql.com/doc/refman/8.4/en/innodb-doublewrite-buffer.html)).
- PostgreSQL's `full_page_writes` setting, which is on by default, writes "the entire content of each disk page to WAL during the first modification of that page after a checkpoint" ([PostgreSQL documentation](https://www.postgresql.org/docs/current/runtime-config-wal.html)).

So every change is written at least twice, once to the log and once to the page, and a small change costs a whole page write. Writing more bytes to disk than the application asked to change is called **write amplification**. When many writes are spread across a large table, the page writes land all over the disk, so they are random I/O. That is where B-tree engines run out of disk throughput first.

### LSM-trees: built for heavy writes

In 1996, Patrick O'Neil, Edward Cheng, Dieter Gawlick and Elizabeth O'Neil published *The Log-Structured Merge-Tree (LSM-Tree)*. Its idea is to never update data in place on disk. Writes are collected in memory, written out as new sorted files, and merged with older files in the background.

LSM-trees are used by LevelDB, RocksDB, Cassandra, ScyllaDB, HBase, Google Bigtable, and CockroachDB (through Pebble, its RocksDB-like engine).

Crumb's page-view log shows why. Every page view is a small write, thousands arrive each second, and they are spread across many recipes. In a B-tree, each write would dirty a different page, and the engine would spend its disk time rewriting 16 KB pages to record a few bytes each. An LSM-tree turns the same stream into a few large sequential writes.

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

1. **Append to the WAL.** Each write (`PUT key value` or `DELETE key`) is appended to a log on disk, so it survives a crash. Appends are sequential.
2. **Insert into the MemTable.** The write also goes into an in-memory sorted structure called the **MemTable**. In RocksDB the default MemTable is a skip list, a sorted linked list with extra shortcut links ([RocksDB wiki](https://github.com/facebook/rocksdb/wiki/Memtable)). Once both steps are done, the database acknowledges the write.
3. **Flush to an SSTable.** When the MemTable reaches a size limit (64 MB by default in RocksDB), it is frozen and written out in one sequential pass as a **sorted string table (SSTable)**. An SSTable is a file of key-value pairs in key order, with a small index and a Bloom filter (explained below). SSTables are **immutable**: once written, they never change. The WAL segment for that MemTable can then be dropped.
4. **Updates and deletes are new entries.** An update is simply a newer entry for the same key. A delete writes a marker called a **tombstone**. The old values stay in older files until compaction removes them.

#### Reading, Bloom filters and compaction

A key's newest value may be in the MemTable or in any SSTable. So a read checks the newest data first:

1. Look in the MemTable.
2. Then check SSTables from newest to oldest, and stop at the first match. A tombstone means the key was deleted.

Checking many files to find one key is called **read amplification**. Two things keep it down.

**Bloom filters.** Each SSTable has a Bloom filter, usually kept in memory. A Bloom filter is a small bit array that answers the question "is this key in this file?" with either "definitely not" or "probably yes". When it says "definitely not", the engine skips the file without reading it. RocksDB's [Bloom filter guide](https://github.com/facebook/rocksdb/wiki/RocksDB-Bloom-Filter) gives "9.9 bits per key (1% false positive rate)". So a point lookup usually reads only the one file that holds the key. Bloom filters don't help range scans, which still have to read every file whose key range overlaps the range asked for.

**Compaction.** Background threads read several SSTables and merge them in key order, like the merge step of merge sort. They keep only the newest version of each key, drop tombstones once no older value could be hiding behind them, and write new SSTables. Fewer files means fewer places to look and less disk spent on old versions.

There are two common compaction strategies:

- **Size-tiered.** When there are several SSTables of similar size, merge them into one bigger file. Cassandra's documentation says it "is the default compaction strategy if no other strategy is specified" ([Cassandra STCS](https://cassandra.apache.org/doc/latest/cassandra/managing/operating/compaction/stcs.html)). It rewrites data fewer times, so it suits write-heavy loads. The costs: versions of one row "may be spread over many SSTables", and a merge needs disk space for the old and new files at the same time, so operators leave a lot of disk free.
- **Leveled.** Data is arranged in levels L0, L1, L2 and so on. In RocksDB, where this is the default style, "each level is 10 times larger than the previous one" ([RocksDB tuning guide](https://github.com/facebook/rocksdb/wiki/RocksDB-Tuning-Guide)). Below L0, the files within one level don't overlap in key range, so a lookup reads at most one file per level. Reads and disk usage are more predictable. The price is more rewriting, because data is merged again each time it moves down a level.

RocksDB's [compaction overview](https://github.com/facebook/rocksdb/wiki/Compaction) sums up the trade-off. Leveled compaction "minimizes space amplification at the cost of read and write amplification". Tiered compaction "minimizes write amplification at the cost of read and space amplification".

#### B-Tree vs LSM-tree

| | B-Tree (InnoDB, PostgreSQL) | LSM-tree (RocksDB, Cassandra) |
|---|---|---|
| Good at | Predictable reads and range scans | High write rates |
| How a write lands | Log append now, page overwrite later | Log append and MemTable insert now; files written sequentially later |
| Write amplification | A whole page per small change, plus the log | Data rewritten by each compaction, but always sequentially |
| Read cost | One path down the tree, often one or two disk reads | MemTable plus several files; Bloom filters skip most of them |
| Space overhead | Partly empty pages after splits and deletes | Old versions until compacted; low with leveled, higher with size-tiered |
| Latency spikes | Checkpoints can cause bursts of page flushes | Heavy compaction can compete with normal reads and writes |

Neither design wins everywhere. Plenty of write-heavy systems run well on PostgreSQL, and RocksDB serves read-heavy workloads too. Benchmark with your own workload before you switch.

## Indexes: getting query performance right

[Relational databases](/learn/relational-databases#use-good-indexes) explains what an index is, which columns to index, and what indexes cost. This section looks at how indexes are laid out inside the engine. The layout explains why two queries that look almost the same can run at very different speeds.

### Clustered, secondary and covering indexes

When someone signs in to Crumb, the app runs `SELECT * FROM users WHERE email = ?`. Here is what that query does in InnoDB.

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

**Clustered index.** A clustered index stores the table's rows inside the index itself, in key order.

- A table can have only one, because its rows can be stored in only one order.
- In InnoDB, the clustered index is normally the primary key, and its leaf pages hold whole rows. If a table has no primary key, InnoDB uses the first unique index whose columns are all `NOT NULL`. If there is none, it adds a hidden row ID column and clusters on that ([MySQL documentation](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html)).
- PostgreSQL works differently. Rows live in an unordered **heap**, and every index, including the primary key's, points into the heap. PostgreSQL's `CLUSTER` command sorts the heap by an index once, but "Clustering is a one-time operation": rows inserted or updated later are not kept in order ([PostgreSQL documentation](https://www.postgresql.org/docs/current/sql-cluster.html)).

**Secondary index.** A secondary index is an index on other columns, such as `CREATE INDEX idx_email ON users(email)`.

- In InnoDB, "each record in a secondary index contains the primary key columns for the row, as well as the columns specified for the secondary index". The leaf holds no other part of the row.
- So Crumb's sign-in query is two tree searches. The first goes down the email index and finds `user_id = 42`. The second goes down the clustered index to fetch the row for user 42.
- In PostgreSQL, the second step is a fetch from the heap instead.
- Because every secondary index stores the primary key, a long primary key makes every secondary index bigger. MySQL's documentation advises that "it is advantageous to have a short primary key."

**Covering index.** If every column a query needs is already in the index, the database answers from the index alone and skips the second lookup. This is called an **index-only scan**, and the index is said to **cover** the query.

- `SELECT user_id, email FROM users WHERE email = ?` is covered by `idx_email` in InnoDB. The leaf already holds `email` and the primary key `user_id`.
- To cover more columns, add them to the index. You can build a composite index on `(email, display_name)`. In PostgreSQL and SQL Server you can also write `INCLUDE (display_name)`, which stores the column in the leaves without making it part of the search key ([PostgreSQL documentation](https://www.postgresql.org/docs/current/indexes-index-only-scans.html)).
- The speed-up depends on whether the second lookup would have gone to disk. For a query that returns many rows, skipping one random read per row can be a large win.
- PostgreSQL adds one condition. It must check that each row is visible to the current transaction, and it can skip the heap only for pages that its cleanup process, vacuum, has marked as all-visible. Its documentation says an index-only scan "will be a win only if a significant fraction of the table's heap pages have their all-visible map bits set."

The trade-off: every index slows down writes and takes space, and wide covering indexes do so more.

### The leftmost prefix rule

A **composite index** is an index on several columns. Crumb's `bookings` table records paid cooking-class bookings, and it has this index:

```sql
CREATE INDEX idx_bookings ON bookings (user_id, status, created_at);
```

The entries are sorted by `user_id` first. Entries with the same `user_id` are sorted by `status`, and entries with the same `status` are sorted by `created_at`. It works like a phone book sorted by last name and then by first name. The index helps when a query constrains a **leftmost prefix** of its columns, meaning the first column, or the first two, or all three:

```sql
-- Uses all three columns
SELECT * FROM bookings WHERE user_id = 10 AND status = 'PAID' AND created_at > '2026-01-01';

-- Uses user_id and status
SELECT * FROM bookings WHERE user_id = 10 AND status = 'PAID';

-- Uses user_id only
SELECT * FROM bookings WHERE user_id = 10;

-- Can't seek with this index, because the first column isn't constrained
SELECT * FROM bookings WHERE status = 'PAID';
SELECT * FROM bookings WHERE created_at > '2026-01-01';
```

The last two are like looking up everyone named "Maria" in a phone book sorted by last name. The sort order doesn't help you. Some engines have workarounds. MySQL's [skip scan](https://dev.mysql.com/doc/refman/8.4/en/range-optimization.html) runs one small range scan for each distinct value of the first column, so it only pays off when that column has few distinct values. Don't design your indexes around it.

**Put equality columns first and the range column last.** A **range condition** is one that matches a span of values: `<`, `>`, `BETWEEN`, or `LIKE 'abc%'`. Once the index reaches a range condition, the columns after it can't narrow the search any further. Take this query:

```sql
WHERE user_id = 10 AND status = 'PAID' AND created_at > '2026-01-01'
```

- With an index on `(user_id, created_at, status)`, the database seeks to `user_id = 10` and the start of the date range. Then it scans every booking after that date, paid or not, and checks `status` on each one.
- With an index on `(user_id, status, created_at)`, it seeks straight to `user_id = 10, status = 'PAID'` and scans only the matching date range.

So put the columns compared with `=` first, and the range column last.

## Sharding

**Sharding** splits a table's rows across several databases, and a **shard key** decides which database, or **shard**, each row lives on. [Relational databases](/learn/relational-databases#sharding-splitting-one-table-across-databases) covers why and when to shard, how to choose a shard key, and the main disadvantages, with Notion's move to sharded PostgreSQL as an example. This section goes deeper: the three ways to map keys to shards, and the mistakes that cause the most pain once you have shards.

A **router** sits between the app and the shards. It can be a library in the app, or a proxy such as Vitess (for MySQL) or Citus (for PostgreSQL). It reads the shard key from each query and sends the query where it needs to go.

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

A query that includes the shard key goes to one shard. A query without it has to ask every shard.

### Partitioning strategies

There are three main ways to decide which shard owns a key.

| Strategy | How a key finds its shard | Strength | Weakness |
| --- | --- | --- | --- |
| Range | Each shard owns a continuous span of keys | Range queries on the key touch few shards | Increasing keys all land on the last shard |
| Hash | Hash the key, then map the hash to a shard | Spreads keys evenly | Range queries on the key touch every shard |
| Directory | Look the key up in a mapping table | Full control over placement | The directory must stay available and consistent |

#### Range partitioning

Each shard holds a continuous range of the key. For example, user IDs 1 to 1,000,000 go on shard 1 and 1,000,001 to 2,000,000 on shard 2. Or each shard holds one month of data.

- **Good:** a range query on the key, such as `WHERE id BETWEEN 500 AND 600`, touches one shard or a few neighboring ones.
- **Bad:** if the key always increases, every new row goes to the last range. Auto-increment IDs, timestamps and [Snowflake-style IDs](/learn/unique-ids#snowflake-style-ids) all behave this way. If Crumb range-partitioned its page-view log by timestamp, every new view would land on the newest shard while the others sat idle. A shard that gets far more traffic than the rest is a **hot spot**. [NoSQL and choosing a database](/learn/nosql-databases#sorted-keys-and-hotspots) shows the same problem with sorted row keys in Bigtable and HBase.

#### Hash partitioning

Hash the shard key, and use the hash to pick a shard. A hash function turns a key into a number that looks random, and the same key always gives the same number.

- **Good:** keys spread evenly, so increasing keys no longer pile onto one shard.
- **Bad:** neighboring keys hash to unrelated shards. A range query on the key, such as `WHERE user_id BETWEEN 10 AND 100`, has to go to every shard.

The simplest version is `shard = hash(user_id) mod N`, where N is the number of shards. Its problem is changing N. Going from 4 shards to 5 changes the shard for about 80% of keys. A key stays put only when `hash mod 4` equals `hash mod 5`, which is true for 4 out of every 20 hash values. So most of the data has to move.

[Consistent hashing](/learn/consistent-hashing) fixes this. It places shards and keys on a ring. A new shard takes over only the keys next to it on the ring, about 1/N of the total, and virtual nodes keep the load even. Many systems get the same effect in a simpler way. They split the hash space into many more fixed partitions than there are servers, say 1,024, and move whole partitions between servers. Notion's 480 logical shards, described in [Relational databases](/learn/relational-databases#a-real-example-notion-shards-postgresql), work this way.

#### Directory partitioning

A lookup service maps each key, or each tenant, to a shard: `tenant A → shard 3`, `tenant B → shard 1`. The mapping lives in a small, strongly consistent store such as etcd, ZooKeeper or a replicated SQL table, and the routers cache it.

- **Good:** you have full control over placement. A very large customer can get a shard of its own, and you can move one tenant without touching the rest.
- **Bad:** the directory is one more system to keep available and consistent. Every query needs the mapping, either from the cache or from a lookup.

### Sharding mistakes that hurt

#### Picking a shard key with a hot spot

The range case above is the classic hot spot. Hash partitioning has its own version: a key that is hot by nature. [Relational databases](/learn/relational-databases#disadvantages-of-sharding) gives the Crumb example of a celebrity chef with two million followers. If Crumb shards by `author_id`, all the traffic for her recipes goes to one shard. A better hash function doesn't help, because her ID still hashes to exactly one place. The same happens when you shard by `tenant_id` and one tenant produces half the traffic.

So before choosing a shard key, look at how traffic is distributed across keys, as well as how many distinct keys there are. If a few keys will be very hot, plan for them. [Consistent hashing](/learn/consistent-hashing#hot-keys) lists the usual fixes, such as caching hot reads close to the app and splitting one hot key into several.

#### Scatter-gather queries

Crumb shards `bookings` by `user_id`. Its support team wants the ten newest pending bookings:

```sql
SELECT * FROM bookings WHERE status = 'PENDING' ORDER BY created_at DESC LIMIT 10;
```

The query has no `user_id`, so the router can't tell which shard holds the answer. It has to **scatter** the query and **gather** the results:

1. Send the query to all N shards.
2. Get the top 10 from each shard.
3. Merge the 10 × N results and return the overall top 10.

The query is only as fast as the **slowest** shard. Suppose each shard has a 1% chance of a slow response. A query that touches 50 shards hits at least one slow shard 1 − 0.99⁵⁰ ≈ **40%** of the time. Every scatter query also uses capacity on every shard, so the total query load grows with the number of shards.

Occasional scatter queries are fine. If a frequent query needs a different key, keep a second copy of the data that is sharded or indexed by that key. Two common forms are a **global secondary index**, which the database maintains across all shards, and a separate table kept up to date from a stream of changes.

#### Cross-shard joins and transactions

On one server, joining `users` to `bookings` is a local operation. If the two tables are sharded on unrelated keys, matching rows sit on different servers. The join then has to ship rows over the network to one place to be matched. A transaction that updates rows on two shards needs a [distributed transaction](/learn/distributed-transactions#two-phase-commit-and-its-blocking-problem) protocol such as two-phase commit, which is slower and harder to operate.

The fix is to **co-locate** data that is used together, by sharding it on the same key. Crumb shards `bookings`, `payments` and `class_reviews` all by `user_id`. One customer's bookings and payments then live on one shard, and joins and transactions on them stay local.

Spanner supports co-location directly with **interleaved tables**. Its [documentation](https://docs.cloud.google.com/spanner/docs/schema-and-data-model) says it "physically colocates child rows with parent rows in storage", and that it "can perform joins by primary key locally, minimizing storage access and network traffic."

#### Resharding as an afterthought

**Resharding** means changing how data is split, for example splitting one busy shard into two. You have to copy data while it is still being written, then switch traffic to the new shards without losing any writes. Doing this by hand, under pressure, is risky.

Plan for it from the start. Choose a scheme that moves whole partitions instead of individual keys, or use a system that automates the move. Vitess, for example, copies and verifies data on the new shards while the old shards keep serving traffic. Its [documentation](https://vitess.io/docs/reference/features/sharding/) says the final switch happens "with only a few seconds of read-only downtime." The distributed SQL databases in the next section split and move data on their own.

## Distributed SQL

[NoSQL and choosing a database](/learn/nosql-databases#the-lines-have-blurred) describes the old choice. A single-node relational database gives you SQL, joins and ACID transactions, but scaling writes past one machine means sharding by hand, with all the problems above. A NoSQL store scales out on its own, but traditionally gave up multi-row transactions and joins.

**Distributed SQL** databases, such as Google Spanner, CockroachDB, YugabyteDB and TiDB, aim for both. They offer SQL and serializable transactions across many machines, and the database itself handles sharding and replication.

They don't escape the [CAP theorem](/learn/cap-and-consistency-101). They choose consistency. If a network partition cuts a piece of data off from a majority of its replicas, that data becomes unavailable. And every write pays for a round of agreement between replicas, which is slow when the replicas are in different regions.

```diagram
title: How distributed SQL databases are layered
[sql] SQL layer\n(stateless nodes) @ 1.5,0
[kv:store] Sorted key-value\nstore, in ranges @ 1.5,1.2
[raft] Raft or Paxos\ngroup per range @ 1.5,2.4
sql -> kv : rows → keys
kv -> raft : replicate
```

### Ranges and consensus

These systems store every table and every index as entries in **one large sorted key space**. Each key is built from the table ID, the index ID and the row's primary key. So one table's rows sit next to each other, in primary key order.

- The key space is cut into contiguous chunks. CockroachDB calls them **ranges**, and TiDB calls them regions. In CockroachDB, a range splits in two once it passes `range_max_bytes`, which is 512 MiB by default ([CockroachDB documentation](https://docs.cockroachlabs.com/docs/stable/configure-replication-zones)).
- The database moves ranges between nodes to balance load, and splits busy ranges further. This is range partitioning, done automatically.
- Each range is copied to several nodes, usually in different zones. CockroachDB keeps 3 copies by default. The copies of one range form a [consensus](/learn/consensus) group, which uses a protocol that lets a majority of copies agree on each change. CockroachDB, TiDB and YugabyteDB use Raft, and Spanner uses Paxos. A write commits once a majority of the range's copies have it.

A transaction that touches several ranges uses a commit protocol layered on top of consensus. It is a form of two-phase commit in which every participant is itself a replicated group. So a single machine failure doesn't leave the transaction stuck.

### Ordering transactions with clocks: Spanner's TrueTime

A database spread across many datacenters still needs to give each transaction a timestamp. Ideally those timestamps match real-world order: if transaction B starts after transaction A has committed, B should get a later timestamp.

Ordinary clocks make this hard. Servers keep their clocks in step with NTP, the Network Time Protocol. According to [Wikipedia](https://en.wikipedia.org/wiki/Network_Time_Protocol), NTP "can usually maintain time to within tens of milliseconds over the public Internet". It adds: "Asymmetric routes and network congestion can cause errors of 100 ms or more." Worse, a machine can't tell how wrong its own clock is. Suppose server A's clock runs 10 ms ahead of server B's. A transaction on B that starts after one on A has committed can still get an earlier timestamp. A reader could then see the second change without the first.

Google's **Spanner** handles this with an API called **TrueTime**, described in its [2012 paper](https://research.google/pubs/spanner-googles-globally-distributed-database-2/).

- Each datacenter has a set of time master machines. Most have GPS receivers. The rest, which Google calls "Armageddon masters", have atomic clocks. GPS and atomic clocks fail in different ways, so using both protects against either one failing.
- Every server polls several masters, and rejects any that disagree with the rest.
- `TT.now()` doesn't return a single time. It returns an interval, `[earliest, latest]`, that is guaranteed to contain the true time. Half the width of that interval is the clock uncertainty, written ε. The paper reports that in production, ε "is typically a sawtooth function of time, varying from about 1 to 7 ms".

Spanner uses that interval for **commit wait**:

1. The transaction's coordinator picks a commit timestamp `s` no earlier than `TT.now().latest`. So `s` is not before the true time.
2. Before it makes the commit visible and releases locks, it waits until `TT.now().earliest > s`. At that point, `s` is certainly in the past on every clock.

```text
s = TT.now().latest
wait until TT.now().earliest > s     (at least 2ε)
then release locks and acknowledge the commit
```

Because of the wait, any transaction that starts after this one commits, on any server anywhere, sees a time later than `s` and gets a larger timestamp. So timestamps match real-time order. This property is called **external consistency**, also known as strict serializability.

The paper says the expected wait is at least 2ε, which is a few milliseconds. It also says the wait "is typically overlapped with Paxos communication". Spanner has to wait for replication anyway, so commit wait often adds little extra latency. A smaller ε means a shorter wait, which is why Google invests in the clock hardware.

Spanner uses locks (two-phase locking) for read-write transactions. The timestamps also let read-only transactions read a consistent snapshot at any timestamp without taking locks. [CAP and consistency 101](/learn/cap-and-consistency-101#google-spanner-consistent-and-available-enough) covers what Spanner's design means for availability.

### CockroachDB: ordinary clocks with a safety margin

CockroachDB runs on ordinary hardware without TrueTime. It uses **hybrid logical clocks**, which combine the machine's physical time with a logical counter that breaks ties. It also assumes every node's clock is within a configured maximum offset of the others. The default is 500 ms, and the [documentation](https://docs.cockroachlabs.com/docs/stable/cockroach-start) says that "if observed clock offsets exceed this limit, servers will crash to minimize the likelihood of reading inconsistent data."

That offset creates an **uncertainty window** around each read. Sometimes a read finds a value whose timestamp is slightly later than its own, but within the window. It can't tell whether that write really happened before it or after it. So, as the [transaction layer documentation](https://docs.cockroachlabs.com/docs/stable/architecture/transaction-layer) describes, CockroachDB pushes the reading transaction's timestamp past the uncertain value. If the transaction's earlier reads are still valid at the new timestamp, it carries on. If not, it retries at the new timestamp.

The result is serializable transactions without commit wait. The cost is occasional retries, and a weaker real-time guarantee than Spanner's.

## Check yourself

<details>
<summary>Crumb's page-view log takes thousands of small writes a second, spread across many recipes. Why can an LSM-tree absorb that rate better than a B-tree on the same drive?</summary>

A B-tree updates pages in place. Each small write means a WAL append and, later, writing back the whole 8 or 16 KB page that holds the row, at that page's position on disk. With writes spread over a large table, those page writes are random, and each one carries mostly unchanged bytes.

An LSM-tree turns every write into sequential I/O. The write is appended to the WAL and inserted into the in-memory MemTable, and then it is acknowledged. When the MemTable fills, it is written out as an SSTable in one sequential pass. Merging old versions is left to background compaction, which also writes sequentially. The cost moves to reads, which may have to check several files. Bloom filters let most of those checks happen in memory.

</details>

<details>
<summary>An LSM-tree store gets slower at reads as data piles up, and its disk keeps filling with old versions. What is going on, and what are the two main compaction strategies' trade-offs?</summary>

Updates and deletes are written as new entries, so old versions and tombstones accumulate in older SSTables until compaction merges them away. More files means more places to check for each key (read amplification) and more disk spent on dead data (space amplification). If compaction falls behind the write rate, both grow.

Size-tiered compaction merges files of similar size. It rewrites data fewer times, so it suits heavy writes, but one key's versions can be spread across many files, and a large merge needs free disk for the old and new files at once. Leveled compaction keeps each level's files non-overlapping, so a lookup reads at most one file per level and space use stays low. The price is more rewriting, because data is merged again each time it moves down a level.

</details>

<details>
<summary>In InnoDB, why can `SELECT user_id, email FROM users WHERE email = ?` be faster than `SELECT * FROM users WHERE email = ?`, given an index on `email`?</summary>

InnoDB stores rows inside the clustered primary key index. A secondary index on `email` stores only `email` and the primary key `user_id`. For `SELECT *`, the engine searches the email index to find `user_id`, then searches the clustered index to fetch the row. That is two tree searches, and the second may need a random disk read. For `SELECT user_id, email`, both columns are already in the email index's leaf. The query is answered from the index alone, as an index-only scan, and the second search never happens. Adding more columns to the index, or using `INCLUDE` in PostgreSQL, can make other queries covered too, at the cost of slower writes and more space.

</details>

<details>
<summary>An index on `(user_id, created_at, status)` exists, and a common query filters on `user_id = ?`, `status = 'PAID'` and `created_at > ?`. What's wrong, and what index would be better?</summary>

The range condition on `created_at` comes before `status` in the index. The engine can seek to the `user_id` and the start of the date range. But then it has to scan every entry in that range and check `status` on each one, including all the bookings that aren't paid. An index on `(user_id, status, created_at)` puts both equality columns first. The engine then seeks directly to `user_id = ?, status = 'PAID'` and scans only the date range it needs.

</details>

<details>
<summary>Why is range partitioning on an auto-increment ID or a timestamp a bad choice for a write-heavy table?</summary>

Each new row has a larger key than every earlier row, so it always falls in the last range. All inserts go to one shard, which runs out of CPU, I/O or connections, while the shards holding older ranges get no writes. Adding shards doesn't help, because new writes still go only to the newest range. Hash partitioning on the key, or partitioning on a different key such as `user_id`, spreads inserts over all shards. The cost is that range queries on the hashed key must go to every shard.

</details>

<details>
<summary>Crumb's bookings are sharded by `user_id` across 50 shards. The support dashboard's main query is "newest pending bookings", and it is slow and spiky. Why, and what would you do?</summary>

The query has no `user_id`, so the router must send it to all 50 shards, collect each shard's top results, and merge them. It finishes only when the slowest shard answers. If each shard is slow 1% of the time, at least one of 50 is slow about 40% of the time (1 − 0.99⁵⁰). It also adds load to every shard. Since this query runs constantly, keep a second copy of the data organized by what it needs: a global secondary index on `(status, created_at)`, or a small table of pending bookings fed from a stream of changes. Then the dashboard reads one place instead of fifty.

</details>

<details>
<summary>What does Spanner's commit wait guarantee, and why does it depend on TrueTime's uncertainty bound?</summary>

It guarantees external consistency. If transaction T2 starts after T1 has committed in real time, T2 gets a larger timestamp, even if the two run on servers on different continents. The coordinator picks T1's timestamp `s` at or above `TT.now().latest`. Then it waits until `TT.now().earliest > s` before releasing locks and acknowledging. After that, every clock in the system is past `s`, so any later transaction's timestamp is larger. The wait only works because TrueTime's interval is guaranteed to contain the true time. Ordinary NTP clocks have no such bound, so a system without one can't know how long to wait. The wait is at least twice the uncertainty, a few milliseconds, which is why keeping ε small matters. CockroachDB, which lacks TrueTime, instead assumes a maximum clock offset and retries reads that fall inside the uncertainty window.

</details>

## Further reading

- [The Log-Structured Merge-Tree (LSM-Tree)](https://www.cs.umb.edu/~poneil/lsmtree.pdf) (O'Neil, Cheng, Gawlick and O'Neil, Acta Informatica, 1996): the paper that introduced the LSM-tree.
- [Designing Data-Intensive Applications](https://dataintensive.net/) by Martin Kleppmann (2017): chapter 3 compares B-trees and LSM-trees, and chapter 6 covers partitioning.
- [RocksDB wiki](https://github.com/facebook/rocksdb/wiki): clear pages on MemTables, Bloom filters, leveled and universal compaction, and tuning, from the engine's own team.
- [Use The Index, Luke!](https://use-the-index-luke.com/) by Markus Winand: how B-tree indexes work and how to design composite indexes, across the major SQL databases.
- [Spanner: Google's Globally-Distributed Database](https://research.google/pubs/spanner-googles-globally-distributed-database-2/) (Corbett et al., OSDI 2012): TrueTime, commit wait and external consistency.
- [CockroachDB: The Resilient Geo-Distributed SQL Database](https://dl.acm.org/doi/10.1145/3318464.3386134) (Taft et al., SIGMOD 2020): ranges, Raft, and transactions with hybrid logical clocks on ordinary hardware.
- [Vitess sharding](https://vitess.io/docs/reference/features/sharding/): how a sharding layer for MySQL maps keys to shards and reshards a live database.
