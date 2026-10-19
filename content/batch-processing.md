# Batch processing and distributed computing

Most system design questions are about **online** systems: a user sends a request, a service reads an index or a cache, and a response comes back in tens of milliseconds. Latency and availability under concurrent load are what matter there.

Organizations also pile up data that nobody queries one row at a time: terabytes to petabytes of logs, payments, sensor readings and crawled web pages. Turning that into something useful (daily reports, billing summaries, search indexes, training data for machine learning models) is the job of **batch processing**: jobs that run over a large, bounded input, such as "yesterday's logs", and produce an output, taking minutes or hours instead of milliseconds. What matters for a batch job is throughput, and finishing correctly even when machines fail partway through.

This chapter covers distributed batch computing: Google's MapReduce and its open-source version in Hadoop, Apache Spark and its multi-stage execution, the storage systems batch jobs read from (data warehouses, data lakes and lakehouses), the Lambda and Kappa architectures for combining batch with streaming, and the problems that show up in production. It builds on the chapters on [relational databases](/learn/relational-databases), [queues and asynchronous work](/learn/queues-and-async) and [event streaming](/learn/event-streaming).

## OLTP vs OLAP: two different workloads

A common mistake is to run large analytical queries directly against the database that serves live traffic. The two workloads want different things.

| Property | Online transaction processing (OLTP) | Analytics and batch (OLAP) |
|---|---|---|
| **Main users** | End users, through apps and web clients | Analysts, data engineers, ML pipelines |
| **Access pattern** | Small reads and writes of a few rows, by key | Scans over millions or billions of rows, reading a few columns |
| **Latency goal** | Milliseconds | Seconds for interactive queries; minutes to hours for batch jobs |
| **Data layout** | Normalized, row-oriented tables (PostgreSQL, MySQL) | Denormalized, column-oriented storage (Parquet, ORC, ClickHouse, warehouses) |
| **Freshness** | Current to the latest commit | Snapshots, often loaded hourly or daily |
| **Limited by** | Random I/O, lock contention, round trips | Sequential scan throughput, memory, and network shuffle |

An operational database is tuned for fast lookups by key and for transactions. A full scan over 500 million rows in the same database competes with live traffic for disk and CPU, pushes the hot working set out of the buffer cache so ordinary queries slow down, and, as a long-running transaction, can hold back cleanup of old row versions (vacuum in PostgreSQL, purge in MySQL). Most databases use MVCC, so the scan doesn't block writers with locks, but it can still slow every checkout on the site. The usual fix is to copy the data out, through a read replica, a change-data-capture stream, or periodic exports, and run analytics on separate systems. The [database internals](/learn/database-internals) chapter covers how storage engines lay data out on disk.

## MapReduce: the foundational model

Jeffrey Dean and Sanjay Ghemawat described MapReduce in a 2004 paper from Google. It let engineers process terabytes across thousands of ordinary machines by writing two functions, while the framework handled distribution, network transfer and machine failures. Hadoop is the open-source implementation, with HDFS in place of Google's file system, GFS.

A job is a **map** function and a **reduce** function, connected by a **shuffle and sort** step the framework runs.

```diagram
title: MapReduce execution
[in:store] Input splits\n(HDFS / GFS) @ 0,1
[m1] Map task 1 @ 1,0
[m2] Map task 2 @ 1,1
[m3] Map task 3 @ 1,2
[shuf] Shuffle and sort\n(partition by key) @ 2,1
[r1] Reduce task 1 @ 3,0.5
[r2] Reduce task 2 @ 3,1.5
[out:store] Output files\n(HDFS / GFS) @ 4,1
in -> m1
in -> m2
in -> m3
m1 -> shuf
m2 -> shuf
m3 -> shuf
shuf -> r1
shuf -> r2
r1 -> out
r2 -> out
```

### The map phase

The input is divided into **splits**, usually one file-system block each: 64 MB in GFS, 128 MB by default in current HDFS.

- The master schedules each map task on a machine that holds a replica of its split, or failing that on one nearby in the same rack. This is **data locality**: sending a few kilobytes of code to the data is far cheaper than sending 128 MB of data to the code.
- The map function takes one input record and emits zero or more intermediate `(key, value)` pairs.
- *Example:* in word count, the map function reads a line of text and emits `(word, 1)` for each word.

### The shuffle and sort phase

The shuffle gets **all values for the same key to the same reduce task**:

- Each map task splits its output into R partitions, one per reduce task, usually with `hash(key) mod R`.
- It sorts each partition by key and writes it to the map machine's local disk, not to the distributed file system.
- Each reduce task fetches its partition from every map task over the network (over HTTP in Hadoop).
- The reduce task merges these sorted runs, so it sees keys in sorted order, with all values for one key together.

The shuffle is usually the most expensive part of a job, since every intermediate byte crosses the network. A **combiner** reduces it: an optional function that runs on the map side and pre-aggregates output before it is sent. In word count, a combiner turns a thousand `("the", 1)` pairs from one map task into a single `("the", 1000)`. A combiner is only correct for operations that are associative and commutative, such as sum, count and max. A plain average isn't one, but you can combine `(sum, count)` pairs and divide at the end.

### The reduce phase

The reduce function is called once per key, with an iterator over that key's values: `reduce(key, list of values)`.

- It aggregates them (in word count, it sums the counts) and writes the result to the distributed file system, which replicates it.
- Each reduce task writes its own output file, so a job with R reduce tasks produces R files: `part-00000`, `part-00001`, and so on.

### Fault tolerance in MapReduce

With thousands of machines, something fails during almost every large job. MapReduce handles this by re-running work:

- **A map worker fails.** The master notices the missed heartbeats and reschedules that worker's map tasks on other machines, which read another replica of the same input split. Even map tasks that had finished are re-run, because their output was on the failed machine's local disk, and reduce tasks may still need to fetch it.
- **A reduce worker fails.** Its unfinished reduce tasks are rescheduled, and the new attempts fetch their partitions from the map outputs again. Finished reduce tasks aren't re-run, because their output is already in the replicated file system.
- **Slow machines.** A single slow machine (a failing disk, a noisy neighbor) can hold up a whole job. Near the end of a job, the master starts backup copies of the remaining tasks and takes whichever copy finishes first. Google's paper reports that turning this off made one sort job take 44% longer.
- **Determinism.** Re-running is only safe if tasks are deterministic and have no side effects outside their output files. Each attempt writes to a private temporary file, and the framework commits exactly one attempt's output by renaming it. With deterministic functions, the job's output is then the same as if nothing had failed.

### Limitations of classic MapReduce

MapReduce made large-scale processing practical, but its model has real costs:

1. **Every job writes to the distributed file system.** Real pipelines are chains of jobs. Each job writes its full output to HDFS, replicated three times, and the next job reads it back. A pipeline of 5 jobs pays for 5 replicated writes, 5 reads and 5 shuffles, even though only the final output needs to be kept.
2. **Iterative algorithms are slow.** Machine learning algorithms such as k-means, and graph algorithms such as PageRank, pass over the same data many times. In MapReduce each pass is a separate job that reads its input from disk again.
3. **A rigid programming model.** Joins, filters and multi-step logic all have to be expressed as chains of map and reduce functions. Higher-level tools (Hive for SQL, Pig) generated those chains, but couldn't remove the disk write between each pair of jobs.

## Apache Spark: multi-stage jobs and in-memory reuse

Spark started at UC Berkeley's AMPLab in 2009, was open-sourced in 2010, and became a top-level Apache project in 2014. It is now the most widely used general-purpose batch engine.

Spark made two main changes: **Resilient Distributed Datasets (RDDs)**, and execution of a whole multi-step program as one job, planned as a **directed acyclic graph (DAG)** of stages.

### Resilient Distributed Datasets

An RDD is an immutable collection of records, split into partitions that are processed in parallel across the cluster. DataFrames and Datasets, the APIs most Spark code uses today, are built on top of RDDs.

- **Caching data that is reused.** A program can keep an RDD in memory with `rdd.cache()` or `rdd.persist()`, and later steps or later iterations read it from memory instead of recomputing it or reading it from disk. This is where the large speed-ups come from: the RDD paper reported iterative machine learning jobs running up to 20× faster than on Hadoop. Data that isn't explicitly cached is not kept in memory between actions.
- **Fault tolerance through lineage.** Every RDD records the transformations that produced it from its inputs, its **lineage**. If a machine dies and takes some cached partitions with it, Spark recomputes just those partitions from their parents, rather than keeping replicas of intermediate data. The original input still lives in a replicated store such as HDFS or S3; lineage covers everything derived from it. When lineage gets very long, as in an iterative job with hundreds of steps, recomputing from the start becomes slow, so programs **checkpoint** an RDD to reliable storage to cut the chain.

### DAG execution

Spark builds a plan for the whole program instead of running it as separate two-step jobs. When an action such as `count()` or `write` runs, Spark's DAG scheduler splits the chain of transformations into **stages** at every point where data has to be redistributed. (For DataFrame and SQL code, the Catalyst optimizer first rewrites the query plan, for example pushing filters down toward the data source, before it is turned into stages.)

- **Narrow transformations** such as `map`, `filter` and `flatMap` compute each output partition from a single input partition. Spark chains them into one task that streams each record through all of them, with no network transfer and no intermediate output.
- **Wide transformations** such as `groupByKey`, `reduceByKey` and most joins need records with the same key from every input partition. Each one marks a stage boundary with a shuffle. Like MapReduce, Spark writes shuffle output to local disk on the sending side, so a failed downstream task can re-fetch it without re-running the previous stage. Spark keeps the shuffle; it removes the replicated distributed-file-system write between steps.
- `reduceByKey` combines values on the map side before the shuffle, as a MapReduce combiner does. `groupByKey` ships every value across the network, so it should be avoided when an aggregation will do.

```diagram
title: A Spark job split into stages at the shuffle
[input:store] Input files @ 0,0
[s1] Stage 1\nfilter + map\n(one task each) @ 1,0
[shuf] Shuffle\n(by key) @ 2,0
[s2] Stage 2\nreduceByKey @ 3,0
[out:store] Output @ 4,0
input -> s1
s1 -> shuf : write by partition
shuf -> s2 : fetch
s2 -> out
```

## Storage architectures: warehouses, lakes and lakehouses

Engines such as Spark, Trino and the warehouses' own query engines need storage built for large scans. Analytical storage has gone through three broad designs.

```diagram
title: How analytical storage has evolved
[dw] Data warehouse\n(structured,\nSQL) @ 0,0
[dl] Data lake\n(raw files on\nobject storage) @ 2,0
[lh] Lakehouse\n(open files +\ntable format) @ 4,0
dw -> dl : cheaper, any format
dl -> lh : transactions, speed
```

### Data warehouses (Snowflake, Google BigQuery, Amazon Redshift)

- **What it is:** a database built for analytical SQL. Data is cleaned and modelled into a typed schema, often a **star schema**: a central fact table, such as orders, surrounded by dimension tables, such as customers and products. Data has traditionally been loaded through **ETL** (extract, transform, load): transformed into shape before it lands. Modern cloud warehouses are also used for **ELT**: load the raw data first, then transform it inside the warehouse with SQL.
- **Storage:** column-oriented and compressed. Each column's values are stored together, so `AVG(price)` reads only the `price` column. Instead of B-tree indexes, warehouses keep min/max statistics per block of rows and skip blocks that can't match a filter.
- **Strengths:** fast SQL, transactions, mature access control, and little to operate. Cloud warehouses separate storage from compute and scale each on its own.
- **Weaknesses:** data is stored in the vendor's own format, so other tools (an ML framework, another engine) can only reach it through the warehouse, and you pay its compute prices to do so. Unstructured data such as images and audio doesn't fit.

### Data lakes (files on S3, Google Cloud Storage, Azure Data Lake Storage)

- **What it is:** files in object storage, in whatever format they arrived in: Parquet and CSV, JSON logs, images, PDFs. Storage is cheap and effectively unlimited.
- **Schema-on-read:** data is written as is, and a schema is applied when a job reads it. Many engines (Spark, Trino, Python ML libraries) can read the same files directly.
- **Strengths:** cheap, scalable, open formats, and storage separate from compute.
- **Weaknesses:** a directory of files has no transactions. A job that crashes halfway leaves partial output that readers may pick up. Two jobs writing at once can corrupt a table. Schemas drift, nobody knows which files are current, and listing millions of objects to plan a query is slow. Without discipline, a lake turns into what people call a **data swamp**.

### Lakehouses (Apache Iceberg, Delta Lake, Apache Hudi)

- **What it is:** data lake files (usually Parquet) plus a **table format**, a metadata layer that records exactly which files make up each version of a table. Engines read and write through that metadata instead of listing directories, which gives a lake many of a warehouse's guarantees.
- **What the table format adds:**
  - **Atomic commits and snapshot isolation.** A writer adds new files, then commits by atomically swapping in a new metadata version. Readers see either the old snapshot or the new one, never a half-written job. Concurrent writers use optimistic concurrency: if two commits conflict, one retries.
  - **Time travel.** Old snapshots are kept until they expire, so you can query a table as it was, for example `SELECT * FROM orders TIMESTAMP AS OF '2026-10-01'` in Spark SQL, or roll back a bad write.
  - **File pruning.** The metadata stores min/max statistics for each column in each file. A query filtering on `created_at > '2026-10-10'` skips files whose range can't match, which on a table partitioned or sorted by date can mean skipping most of it.
  - **Schema and partition evolution.** Columns can be added or renamed, and Iceberg can change how a table is partitioned without rewriting old data.

The warehouse and the lakehouse have been converging: warehouses can now read and write open table formats, and lakehouse engines have added warehouse features.

## Combining batch and streaming: Lambda vs Kappa

Many systems need both fresh numbers (a dashboard updated within seconds, fraud alerts) and complete, correct numbers over history (monthly billing, retraining a model). Two architectures for getting both are known by name.

### The Lambda architecture

Nathan Marz described the Lambda architecture around 2011. It runs the same logic twice, in three layers:

```diagram
title: The Lambda architecture
[in:client] New events @ 0,1
[speed] Speed layer\n(Storm / Flink)\nrecent, fast @ 2,0
[batch] Batch layer\n(Hadoop / Spark)\ncomplete, slow @ 2,2
[serv] Serving layer\n(merged views) @ 4,1
in -> speed
in -> batch
speed -> serv
batch -> serv
```

1. **Batch layer:** stores every raw event in an append-only master dataset, and periodically (hourly or daily) recomputes its views from all of it. The results are complete and correct, but always a few hours old.
2. **Speed layer:** processes events as they arrive with a stream processor, covering only the window the batch layer hasn't reached yet. Its results are fresh but may be approximate: it might use approximate algorithms or handle late events less carefully. They are thrown away once the batch layer catches up.
3. **Serving layer:** answers queries by combining the batch view with the speed layer's view of recent data.

**The main drawback:** the same business logic is written and maintained twice, once for the stream processor and once for the batch engine, often in different frameworks. Every change has to land in both, and when the two give slightly different numbers someone has to find out why.

### The Kappa architecture

Jay Kreps, one of Kafka's creators, proposed what he called the Kappa architecture in a 2014 essay, "Questioning the Lambda Architecture". It drops the batch layer:

```diagram
title: The Kappa architecture
[in:client] Events @ 0,0
[log:queue] Event log\n(Kafka / Pulsar)\nlong retention @ 1,0
[stream] Stream processor\n(Flink, Spark\nStreaming) @ 2.5,0
[serv:store] Serving store @ 4,0
in -> log
log -> stream
stream -> serv
```

- **Core idea:** do everything as stream processing. A batch job is a stream job whose input happens to have an end.
- **One pipeline:** every event goes into a durable, append-only log (Kafka or Pulsar) with long retention, and one stream processing job, with one codebase, produces the outputs.
- **Reprocessing:** when the logic changes or a bug needs fixing, start a second copy of the new job reading from the start of the log (or as far back as needed), writing to a new output table. When it has caught up with the present, switch readers to the new table and stop the old job.

Kappa has its own costs. The log has to keep enough history to replay, which is where tiered storage (old log segments moved to object storage) helps. Replaying months of events through a streaming engine can be much slower than a batch engine reading columnar files. And some computations, such as a large join over all history, are more natural as batch jobs. Many teams end up in between: one codebase (for example Spark, whose batch and streaming APIs share most code, or Flink, which runs both), with batch runs for backfills.

## Practical challenges in production batch systems

### Data skew and stragglers

A stage finishes when its slowest task finishes. If the data is partitioned by `user_id` and one key has far more records than the rest, the task that owns it runs long after the others are done.

An example with assumed numbers: 1 billion events from 10 million users, about 100 each, spread over 1,000 reduce tasks. That's about 1,000,000 events per task. Now add one celebrity account with 100 million events. Every one of them hashes to the same task, which gets about 101 million events, roughly **100× the average**. If a typical task takes a minute, that one takes over an hour and a half, and the job takes as long as it does.

**Mitigation: salting.** Split the hot key into K sub-keys by appending a random number:

```text
salted_key = user_id + "_" + (random integer from 0 to K − 1)
```

The first aggregation groups by `salted_key`, spreading the hot key's records over up to K tasks. A second, much smaller aggregation strips the salt and combines the K partial results. This works for aggregations that can be combined in pieces, such as sums, counts and max. For a **join** on a hot key, salt the large side and copy each matching row of the small side K times, once per salt value, so every salted row still finds its match.

Engines help too. Spark's adaptive query execution can detect skewed partitions in a join at runtime and split them, and broadcasting a small table to every task avoids shuffling the large side at all.

### Idempotence and exactly-once output

Batch jobs fail partway through: out-of-memory errors, preempted spot instances, a bad record. If a job that appends rows to a table dies after writing 60% of them and is simply restarted, those 60% are written twice.

**Mitigations:**

- **Write to a temporary location, then commit atomically.** Each task writes to a private temporary directory (`_temporary/<attempt>/` in Hadoop's output committer). When a task succeeds its output is promoted, and when the whole job succeeds it is moved to the final path and marked with a `_SUCCESS` file. Readers only consume committed output. On HDFS a rename is an atomic metadata operation. On S3 and other object stores a "rename" is a copy followed by a delete, neither atomic nor fast, which is why object-store committers and lakehouse table formats (whose commit is one atomic metadata swap) exist.
- **Overwrite a whole partition instead of appending.** Make each run produce one complete partition and replace it:

  ```sql
  INSERT OVERWRITE TABLE daily_metrics PARTITION (date = '2026-10-13')
  SELECT ...
  ```

  Running the job for 13 October once or five times leaves the same data. Scheduling jobs by the date of the data they process, not by the time they happen to run, also makes it safe to re-run any past day.

These two together make a job **idempotent**: safe to retry. That's what "exactly-once" means for batch output in practice. Tasks may run more than once, but their results are committed once. The [distributed transactions](/learn/distributed-transactions) chapter covers the same idea for services.

## Check yourself

<details>
<summary>Why does Spark run iterative algorithms, such as machine learning training or PageRank, much faster than classic Hadoop MapReduce?</summary>

In MapReduce, each iteration is a separate job. It reads its input from the distributed file system, shuffles, and writes its full output back to HDFS with three replicas, which the next iteration then reads. Fifty iterations mean fifty replicated writes and fifty reads of the whole dataset.

Spark runs the whole loop as one program. The dataset reused on every iteration is cached in the executors' memory once, and later iterations read it from there. Steps that don't need a shuffle are chained inside one task with no intermediate output. Shuffles still happen, and still write to local disk, but nothing has to go through the replicated file system between steps. Lineage replaces replication for fault tolerance: a lost cached partition is recomputed from its parents.

</details>

<details>
<summary>A word-count job's shuffle moves far more data than you expected. What is the first thing to check?</summary>

Whether it uses a combiner (in Spark, whether it uses `reduceByKey` instead of `groupByKey`). Without one, each map task sends one `(word, 1)` pair for every occurrence of every word, so the shuffle is roughly as large as the input text. With one, each map task sends one `(word, count)` pair per distinct word it saw, which for natural language is a tiny fraction of that. A combiner is valid here because addition is associative and commutative.

</details>

<details>
<summary>What is data skew in a shuffle, and how does salting fix it?</summary>

Skew is when a few keys have far more records than the rest. Every record for one key goes to the same task, so the task that owns a hot key runs long after all the others have finished, and the whole stage waits for it. It may also run out of memory.

Salting appends a random suffix from 0 to K − 1 to the key before the shuffle, which splits the hot key into K sub-keys handled by different tasks. Each produces a partial result, and a second, small aggregation strips the salt and combines the K partials. For a join, the large side is salted and the small side's matching rows are copied once per salt value.

</details>

<details>
<summary>A nightly job crashed after writing part of its output, and was restarted. How do you make sure the table doesn't end up with duplicates?</summary>

Don't let partial output become visible, and make each run replace its result instead of adding to it. Tasks write to temporary locations and the job commits atomically at the end, with a directory rename on HDFS, or a single metadata commit with a table format such as Iceberg or Delta (an S3 rename isn't atomic). The job writes a complete partition for the day it processes and overwrites that partition, so a retry replaces the earlier attempt's output instead of appending to it.

</details>

<details>
<summary>What is the main operational advantage of the Kappa architecture over Lambda, and what does it cost?</summary>

One codebase. In Lambda, the same logic exists in a batch job and a streaming job, every change has to be made twice, and the two can drift and disagree. In Kappa, a single streaming job produces every output, and recomputing history means replaying the log through a new version of that job into a new table, then switching readers over.

The costs: the log must keep enough history to replay, and replaying a long history through a streaming engine can be much slower than a batch engine scanning columnar files. Some heavy computations over all history are simply easier to write as batch jobs.

</details>

## Further reading

- [MapReduce: Simplified Data Processing on Large Clusters (Dean and Ghemawat, OSDI 2004)](https://research.google/pubs/pub62/): the original paper, including locality, the master's handling of failures, and backup tasks.
- [Resilient Distributed Datasets: A Fault-Tolerant Abstraction for In-Memory Cluster Computing (Zaharia et al., NSDI 2012)](https://www.usenix.org/system/files/conference/nsdi12/nsdi12-final138.pdf): the paper behind Spark, covering RDDs, lineage, and narrow vs wide dependencies.
- [How to beat the CAP theorem (Nathan Marz, 2011)](http://nathanmarz.com/blog/how-to-beat-the-cap-theorem.html): the blog post that laid out the batch, speed and serving layers later called the Lambda architecture.
- [Questioning the Lambda Architecture (Jay Kreps, 2014)](https://www.oreilly.com/radar/questioning-the-lambda-architecture/): the essay that proposed the Kappa architecture and reprocessing by replaying a log.
- [Apache Iceberg](https://iceberg.apache.org/): documentation and table spec for an open table format, covering snapshots, atomic commits, and partition evolution.
- [Designing Data-Intensive Applications (Martin Kleppmann)](https://dataintensive.net/): chapter 10, "Batch Processing", starts from Unix pipes and works up to MapReduce and dataflow engines.
