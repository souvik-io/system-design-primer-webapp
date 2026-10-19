# Relational databases and scaling SQL

This chapter answers five questions:

- What is a relational database, and what do the four ACID guarantees promise?
- How does copying a database to more machines (replication) add read capacity and survive failures, and what does it cost?
- How do you split a database that has outgrown one machine, either by feature (federation) or by rows (sharding)?
- When is it worth storing the same data twice to make reads faster (denormalization)?
- How do you find and fix slow queries before you reach for more hardware (SQL tuning)?

We'll keep using **Crumb**, the recipe-sharing site from the [Scalability](/learn/scalability) chapter. Crumb stores its data in a relational database with four main tables: `users`, `recipes`, `comments` and `ratings`. Crumb now has several app servers behind a load balancer and a cache, and its one database server is starting to struggle. The Scalability chapter sketched the ways out. This chapter works through each one in detail.

## What a relational database is

A **relational database** stores data in **tables**. A table looks like a spreadsheet:

- Each **row** is one item, such as one recipe.
- Each **column** is one fact about that item, such as its title or the date it was posted.
- The **schema** is the list of tables and columns, with a fixed type for each column (a number, some text, a date).

Here is a small piece of Crumb's `recipes` table:

| id | author_id | title | posted_at |
| --- | --- | --- | --- |
| 101 | 7 | Brown butter cookies | 2026-03-02 |
| 102 | 9 | Weeknight dal | 2026-03-04 |

Every row has a **primary key**, a column whose value is unique to that row. Here it is `id`. Rows in one table point to rows in another with a **foreign key**. The `author_id` column holds the `id` of a row in the `users` table, so Crumb can find who wrote each recipe without copying the author's name into every recipe.

You read and change the data with **SQL** (Structured Query Language). To show a recipe page with its author's name, Crumb asks the database to combine two tables. Combining rows from several tables by matching keys is called a **join**:

```sql
SELECT recipes.title, users.display_name
FROM recipes
JOIN users ON users.id = recipes.author_id
WHERE recipes.id = 101;
```

Storing each fact in exactly one place, and using keys and joins to connect the pieces, is called **normalization**. If an author changes their display name, Crumb updates one row in `users`, and every recipe page shows the new name. Keep this idea in mind. Several scaling techniques later in this chapter work by giving it up on purpose.

Well-known relational databases include PostgreSQL, MySQL, SQL Server and Oracle. The term **RDBMS** (relational database management system) means the software that runs one.

## Transactions and ACID

A **transaction** is a group of reads and writes that the database treats as one unit of work.

Here is a concrete one. When a user gives a recipe four stars, Crumb does two things:

1. It inserts a row into `ratings`: user 42 gave recipe 101 four stars.
2. It updates two columns on the recipe's row, `rating_sum` and `rating_count`, so the recipe page can show the average without adding up every rating each time.

Crumb wraps both steps in one transaction:

```sql
BEGIN;
INSERT INTO ratings (user_id, recipe_id, stars) VALUES (42, 101, 4);
UPDATE recipes SET rating_sum = rating_sum + 4, rating_count = rating_count + 1
  WHERE id = 101;
COMMIT;
```

Relational databases promise four things about transactions. Together they are called **ACID**.

### Atomicity: all or nothing

Either every step of the transaction happens, or none of them does. If the server crashes after the `INSERT` but before the `UPDATE`, the database undoes the insert when it restarts. Crumb never ends up with a rating that isn't counted in the average.

### Consistency: the rules always hold

Every transaction moves the database from one valid state to another valid state. "Valid" means the data obeys the rules written into the schema. These rules are called **constraints**. Crumb's `ratings` table might have three:

- `CHECK (stars BETWEEN 1 AND 5)`: a rating of 7 stars is rejected.
- A foreign key on `recipe_id`: you can't rate a recipe that doesn't exist.
- `UNIQUE (user_id, recipe_id)`: each user can rate each recipe only once.

If any step would break a rule, the whole transaction fails, and atomicity rolls back the other steps.

This "C" is a different idea from the "C" in the CAP theorem. CAP's consistency is about whether every reader sees the latest write. The [CAP chapter](/learn/cap-and-consistency#c-consistency) explains the difference.

### Isolation: transactions don't see each other's half-finished work

When many transactions run at the same time, the result should be the same as if they had run one after another.

Here is the kind of bug this is about. Two people rate recipe 101 at the same moment. Crumb's code reads `rating_count`, adds one in the application, and writes the new value back. Both requests read 10, and both write 11, so one rating vanishes from the count. This is a **lost update**. Writing `rating_count = rating_count + 1` inside the database avoids it, because the database locks the row and applies the two updates one after the other.

### Durability: committed means saved

Once the database says a transaction is committed, the change survives a crash or a power cut. Databases usually do this with a **write-ahead log**, an append-only file that records each change before the main data files are touched. In PostgreSQL's [words](https://www.postgresql.org/docs/current/wal-intro.html), changes to data files "must be written only after those changes have been logged." After a crash, the database replays the log.

### Isolation levels

Perfect isolation is expensive, because the database has to hold more transactions back to keep them apart. So databases offer several **isolation levels**. The SQL standard names four, defined by which oddities each one still allows:

- A **dirty read** sees another transaction's change before it commits.
- A **non-repeatable read** reads the same row twice and gets two different values.
- A **phantom read** runs the same search twice and gets a different set of rows.

| Level | Dirty read | Non-repeatable read | Phantom read |
| --- | --- | --- | --- |
| Read uncommitted | possible | possible | possible |
| Read committed | no | possible | possible |
| Repeatable read | no | no | possible |
| Serializable | no | no | no |

Only Serializable fully matches "as if one at a time." PostgreSQL [defaults to Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html), and MySQL's InnoDB engine [defaults to Repeatable Read](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html). The defaults are fine for most web pages. When money or stock counts are involved, check what your level allows.

## The scaling toolkit at a glance

One database server has limits. It has only so much CPU, memory and disk speed, and if it fails, everything stops. There are six standard techniques for scaling a relational database. They solve different problems:

| Technique | What it does | What it helps with | Main cost |
| --- | --- | --- | --- |
| Primary-replica replication | Copies the whole database to read-only machines | More read capacity, survives a failed server | Replicas can lag behind |
| Primary-primary replication | Lets two servers both accept writes | Writes keep working if one server fails | Conflicting writes |
| Federation | Gives each feature its own database | Less load on each database | No joins across features |
| Sharding | Splits one table's rows across databases | Write capacity and data size | Routing, uneven shards, cross-shard queries |
| Denormalization | Stores copies of data to skip joins | Faster reads | Copies can drift apart; slower writes |
| SQL tuning | Makes each query do less work | Everything, at no hardware cost | Needs measurement and care |

A sensible order is to tune first, then add replicas, and to split the data only when you must. Tuning is cheap and makes every later step go further. Splitting data is hard to undo.

## Replication: copies of the whole database

**Replication** means keeping a full copy of the database on more than one server. Each change made on one server is sent to the others and applied there.

Older documentation calls the server that accepts writes the **master** and the copies the **slaves**. Many projects now say **primary** (or **source**) and **replica**. MySQL, for example, [renamed](https://dev.mysql.com/doc/refman/8.0/en/replica-connection-thread-states.html) "master" to "source" and "slave" to "replica" in version 8.0.26. This chapter uses primary and replica.

### Primary-replica replication

In this setup, one server is the **primary**. It handles all writes, and it can handle reads too. It sends every change to one or more **replicas**. The replicas accept only reads.

A replica can also pass changes on to other replicas, which forms a tree. PostgreSQL calls this [cascading replication](https://www.postgresql.org/docs/current/warm-standby.html), and says it reduces "the number of direct connections to the primary." For example, the primary sends each change across the ocean once, to one replica in Europe, and that replica feeds the other European replicas.

```diagram
title: Crumb's writes go to the primary. Replicas serve reads, and one replica feeds another.
[app] Crumb app\nservers @ 0,1
[p:store] Primary @ 2,0
[r1:store] Replica 1 @ 2,2
[r2:store] Replica 2 @ 4,0
[r3:store] Replica 3 @ 4,2
app -> p : writes
app -> r1 : reads
p --> r1 : changes
p --> r2 : changes
r1 --> r3 : relays changes
```

Crumb gets two things from this:

- **Read capacity.** Most of Crumb's traffic is people reading recipes. Each replica can take a share of those reads, so the primary has more room for writes.
- **A spare server.** If the primary fails, a replica already holds nearly all the data.

**What happens when the primary fails.** The replicas keep answering reads. So Crumb can stay up in **read-only mode**: people can browse recipes, but they can't post comments or ratings. Writes come back once one of two things happens:

- a replica is **promoted**, meaning it is turned into the new primary, or
- a new primary is set up from scratch.

#### Disadvantage: promotion needs extra logic

In PostgreSQL, the promote command itself is short (`pg_ctl promote`). The hard part is everything around it:

1. **Decide the primary is really dead.** A slow network looks the same as a dead server.
2. **Pick the replica with the most data,** since replicas may lag by different amounts.
3. **Point the other replicas and the app's writes at the new primary.**
4. **Stop the old primary from coming back as a primary.**

PostgreSQL's [failover documentation](https://www.postgresql.org/docs/current/warm-standby-failover.html) says it "does not provide the system software required to identify a failure on the primary." It also warns that if a restarted old primary doesn't know it was replaced, both servers may act as primary, which "will lead to confusion and ultimately data loss." So teams add a separate failover tool, and that tool needs testing like any other code.

### Synchronous, asynchronous and semi-synchronous replication

When the primary commits a write, does it wait for the replicas? There are three answers, and each trades speed against safety.

| Mode | Primary waits for | Committed data lost if the primary dies | Extra time per commit |
| --- | --- | --- | --- |
| Asynchronous | nothing | the last moment of writes | none |
| Semi-synchronous | one replica to receive and log the change | none | at least one round trip |
| Synchronous | a replica to save the change | none, unless both servers die | at least one round trip |

- **Asynchronous** is the default in both [MySQL](https://dev.mysql.com/doc/refman/8.4/en/replication-semisync.html) and [PostgreSQL](https://www.postgresql.org/docs/current/warm-standby.html). PostgreSQL says the delay before a replica sees a change is "typically under one second" if the replica keeps up.
- **Semi-synchronous** is MySQL's middle option. The replica only has to confirm it received the change, not that it applied it. MySQL says the cost is "at least the TCP/IP roundtrip time" on every commit.
- **Synchronous** replication, PostgreSQL notes, "necessarily increases the response time." The farther apart the servers are, the longer every write waits.

The diagram below has a primary and two replicas. Send writes, read from a replica before it has caught up, then fail the primary and watch which acknowledged writes survive when a replica is promoted. Switch between asynchronous and semi-synchronous mode to compare. The delays are illustrative.

```widget
replication
```

### Primary-primary replication

In **primary-primary replication** (older name: **master-master**), two servers both accept reads and writes. They send each other their changes and coordinate on writes. If either one fails, the other keeps handling both reads and writes, so the site doesn't drop into read-only mode.

```diagram
title: Primary-primary replication. Both servers accept writes and copy changes to each other.
[app] Crumb app servers @ 1.5,0
[a:store] Primary A @ 0,1.5
[b:store] Primary B @ 3,1.5
app -> a : reads and writes
app -> b : reads and writes
a <-> b : changes both ways
```

The catch is that two servers can now change the same data at the same moment. Say a Crumb author edits her recipe's title on Primary A while a moderator edits the same title on Primary B. Unless something resolves the clash, the two servers end up with different titles.

#### Disadvantages of primary-primary replication

- **Something must choose where each write goes.** You need a load balancer, or code in the app, that picks a primary for each write. Sending all writes for one recipe to the same primary reduces clashes.
- **You give up either consistency or speed.** Most primary-primary systems pick one of two compromises. Some are **loosely consistent**: each server commits on its own and they reconcile later, so for a while they disagree. That breaks the isolation and consistency that ACID promises. Others coordinate before every commit, so they stay in agreement, but each write is slower.
- **Conflicts multiply.** More servers that accept writes, and more network delay between them, mean more writes that overlap in time, so conflict resolution matters more as the setup grows.

Even IDs need care. If both servers hand out auto-incrementing IDs, both may create a comment with ID 5,001. MySQL's [`auto_increment_increment` and `auto_increment_offset`](https://dev.mysql.com/doc/refman/8.4/en/replication-options-source.html) settings exist for this case: with an increment of 2, one server uses odd IDs and the other even IDs.

Some systems resolve conflicts with a fixed rule. In MySQL Group Replication's multi-primary mode, if two servers update the same row at once, the transaction ordered first commits and the other is rolled back. The [documentation](https://dev.mysql.com/doc/refman/8.4/en/group-replication-summary.html) calls this "a distributed first commit wins rule."

### Costs that apply to all replication

These drawbacks apply to both primary-replica and primary-primary setups.

- **Recent writes can be lost.** With asynchronous replication, the primary may commit a write and crash before sending it to any replica. When a replica is promoted, that write is gone. PostgreSQL's [documentation](https://www.postgresql.org/docs/current/warm-standby.html) says the amount lost is "proportional to the replication delay at the time of failover."
- **Every replica must replay every write.** Besides answering reads, each replica applies every change the primary makes. During a burst of writes, replicas spend much of their capacity replaying them and have less left for reads. Replicas add read capacity, never write capacity.
- **More replicas mean more lag.** The primary sends each change to every replica attached to it. More replicas means more sending work, so changes take longer to arrive everywhere. Cascading replication spreads this work out.
- **Replicas may apply changes more slowly than the primary makes them.** On the primary, many connections write in parallel. On some systems, a replica applies changes one at a time, on a single thread, and under heavy writes it falls further and further behind. MySQL 8.4 avoids this by default: [`replica_parallel_workers`](https://dev.mysql.com/doc/refman/8.4/en/replication-options-replica.html) defaults to 4 applier threads. Set it to 1 and transactions "are applied sequentially."
- **More hardware and more moving parts.** Each replica is another server to pay for, monitor, patch and back up.

### Replication lag and reading your own writes

The delay between a write on the primary and its arrival on a replica is called **replication lag**. It causes a familiar bug. A Crumb user saves an edit to her recipe, the page reloads from a replica that hasn't received the edit yet, and the old version appears.

The fix is to guarantee **read-your-writes**: a user always sees their own changes. A simple way is to send a user's reads to the primary for a few seconds after they write. Another is to remember how far along the primary was at the user's write, and read from a replica only once it has caught up to that point. The [CAP chapter](/learn/cap-and-consistency#guarantees-for-one-user) covers this and related guarantees.

## Federation: one database per feature

Replicas spread out reads, but every write still goes to one primary. Crumb's next step is **federation**, also called **functional partitioning**. It splits the database by feature. Instead of one database holding every table, Crumb runs three:

- a **users** database (accounts, profiles, sign-in),
- a **recipes** database,
- a **comments and ratings** database.

```diagram
title: Federation. Each feature gets its own database.
[app] Crumb app\nservers @ 0,1
[u:store] Users DB @ 2.5,0
[r:store] Recipes DB @ 2.5,1
[c:store] Comments and\nratings DB @ 2.5,2
app -> u : accounts
app -> r : recipes
app -> c : comments, ratings
```

Each database can have its own replicas. Federation helps in three ways:

- **Less traffic per database.** Each database handles only its feature's reads and writes. Fewer writes per primary means less to replicate, so replication lag drops too.
- **More of each database fits in memory.** A database is much faster when the data it needs is already in RAM. In a smaller database, more of the data fits there, so more reads skip the disk. This is a better **cache hit rate**.
- **Writes in parallel.** With one primary, every write passes through one server. With three, a burst of new comments doesn't compete with sign-ups, so total write throughput goes up.

Some teams call this **vertical partitioning** or **vertical sharding**. Be careful with the first name: it also means splitting one table's columns into two tables, which comes up under SQL tuning.

### Disadvantages of federation

- **It doesn't help with one huge feature.** Federation only splits by feature. If Crumb's `comments` table alone outgrows a server, putting it in its own database doesn't fix that. You need sharding.
- **The app must know which database to use.** Every query now has to go to the right place. That logic lives in Crumb's code or in a database proxy.
- **Joins across databases get hard.** "Show each comment with the commenter's display name" used to be one join. Now `comments` and `users` are on different servers. You can join them in app code with two queries, or use a feature that lets one database query another, called a **server link** (SQL Server calls it a linked server). In PostgreSQL, the [`postgres_fdw`](https://www.postgresql.org/docs/current/postgres-fdw.html) extension lets one server "access data stored in external PostgreSQL servers." Both options are slower and more fragile than a local join.
- **More hardware and more complexity.** Three databases, each with replicas, means more servers to run, back up and monitor.

### A real example: GitHub splits its main database

GitHub [described its federation project](https://github.blog/engineering/infrastructure/partitioning-githubs-relational-databases-scale/) in 2021. Much of its core data, including user profiles, repositories, issues and pull requests, lived in one main MySQL cluster called `mysql1`. An incident on `mysql1` could hit every feature at once.

The team worked in two stages:

1. **Split the tables in the code first.** They grouped tables into **schema domains**, sets of tables used together, such as `gists`, `gist_comments` and `starred_gists`. A query linter flagged any query that touched more than one domain, and a transaction linter did the same for transactions. Engineers rewrote those joins as separate queries or joined the results in application code.
2. **Then move the tables.** Once a domain stood alone, it could move to its own cluster. One move took 130 of the busiest tables off `mysql1` at once.

In 2019, `mysql1` served about 950,000 queries a second: 900,000 on replicas and 50,000 on the primary. By 2021 the same tables served about 1.2 million queries a second across several clusters, and the average load on each database host had halved.

The lesson for Crumb: moving tables is mechanical. The real work is finding and removing every join and transaction that crosses a feature boundary.

## Sharding: splitting one table across databases

Federation splits tables by feature. **Sharding** splits the *rows* of one table across several databases. Each database, called a **shard**, holds only part of the rows, and has the same tables as the other shards. Sharding is also called **horizontal partitioning**.

The column that decides which shard a row belongs to is the **shard key**. Suppose Crumb shards by user. Every user, with that user's recipes, lives on exactly one shard. As Crumb gains users, it adds more shards.

```diagram
title: Sharding by user. Each shard holds some users and has its own replica.
[app] Crumb app\nservers @ 0,1
[rt] Shard router @ 1,1
[s1:store] Shard 1 @ 2.5,0
[s2:store] Shard 2 @ 2.5,1
[s3:store] Shard 3 @ 2.5,2
[p1:store] Replica @ 4,0
[p2:store] Replica @ 4,1
[p3:store] Replica @ 4,2
app -> rt : user_id
rt -> s1
rt -> s2
rt -> s3
s1 --> p1
s2 --> p2
s3 --> p3
```

The **shard router** in the diagram is whatever maps a shard key to a shard. It can be a library inside the app, a proxy, or a lookup table.

### What sharding buys

Sharding has the same benefits as federation. Each shard gets less traffic and has less to replicate, and more of its data fits in memory. Ten shards means ten primaries taking writes in parallel. It adds two more:

- **Smaller indexes.** An index on a shard covers only that shard's rows. A smaller index is quicker to search and more likely to stay in memory, so queries usually get faster.
- **A failure stays contained.** If shard 2 goes down, users on shards 1 and 3 don't notice. Users on shard 2 lose access, though, so each shard still needs its own replicas to avoid losing data.

### Choosing a shard key

Two common ways to shard a `users` table are by the first letter of the user's last name, or by where the user lives. Both are easy to understand, and both show what can go wrong.

- **By last-name initial.** Shard 1 holds names A to F, shard 2 holds G to M, and so on. But letters are not equally common as initials, so some shards end up much larger than others. And a user who changes her name has to move shards.
- **By geography.** European users go on a shard in Europe and American users on one in the US. Data sits close to its users, which cuts network delay. But regions are rarely the same size, and users move.
- **By a hash of the user's ID.** A **hash function** turns a value into a number that looks random, and the same input always gives the same output. Mapping `hash(user_id)` to a shard spreads users evenly, which is why many systems use hashing or a lookup table.

Whatever you choose, keep data that is used together on the same shard. A recipe page needs the recipe plus all its comments, so Crumb should store each recipe's comments on the recipe's shard, not the commenter's.

### Disadvantages of sharding

- **The app must know about shards.** Every query has to reach the right shard. A query that doesn't include the shard key, such as "find all recipes with 'miso' in the title," has to ask every shard and merge the answers. SQL that used to be one statement becomes several statements plus code.
- **Shards can become lopsided.** Suppose a celebrity chef joins Crumb and two million people follow her. Her recipes, and every comment and rating on them, live on one shard. That shard now gets far more traffic than the others. An overloaded shard like this is called a **hot shard**.
- **Rebalancing is hard.** Fixing a hot shard, or adding shards as Crumb grows, means moving rows between live databases without losing writes. With plain `hash(user_id) % N`, changing N moves most rows to a new shard. **Consistent hashing** is a different way to map keys to shards. When a shard is added, it moves only a small share of the keys. The [consistent hashing chapter](/learn/consistent-hashing#the-problem-with-hash-mod-n) shows why.
- **Joins across shards are hard.** A query that needs rows from two shards can't be one SQL join. The app must query each shard and combine the results. A transaction that changes rows on two shards needs a protocol such as two-phase commit, covered in the [distributed transactions chapter](/learn/distributed-transactions).
- **More hardware and more complexity.** Each shard needs its own replicas, backups, monitoring and upgrades.

[Database internals](/learn/database-internals#sharding) goes deeper on all of this: range, hash and directory partitioning, hot keys, queries that must ask every shard (scatter-gather), cross-shard joins, resharding, and distributed SQL databases such as Spanner that shard for you.

### A real example: Notion shards PostgreSQL

Notion stores every piece of content as a "block" in PostgreSQL. In 2021 it [described](https://www.notion.com/blog/sharding-postgres-at-notion) moving from one large database to a sharded one.

- **Why.** After "four orders of magnitude of growth," on-call engineers "often woke up to database CPU spikes," and PostgreSQL's cleanup process, `VACUUM`, "began to stall consistently."
- **The shard key.** Every block belongs to exactly one workspace, and users usually work in one workspace at a time. So Notion sharded by workspace ID, and most queries need only one shard.
- **The layout.** Notion created 480 **logical shards** spread across 32 physical databases, 15 per database. A logical shard is a self-contained set of tables that can later move to another server whole. Notion chose 480 because it is "divisible by a lot of numbers," so it can grow from 32 servers to 40 or 48 and still spread shards evenly.
- **The move.** New writes went to both the old and new databases while a backfill copied existing data, which took about three days. After a verification step, the final switch needed five minutes of scheduled downtime.

Notion's own top lesson was to shard earlier, before the overloaded database limited its options.

## Denormalization

**Denormalization** means storing extra copies of data so that common reads don't need joins. It makes reads faster at the cost of some write speed.

Take Crumb's recipe page. In a fully normalized design, it needs:

- the recipe row,
- a join to `users` for the author's display name,
- a count over `comments` for the number of comments,
- an average over `ratings` for the star rating.

A denormalized design stores `author_name`, `comment_count`, `rating_sum` and `rating_count` directly on the recipe row. One row read now builds the page. You already saw this idea in the ratings transaction earlier in this chapter.

### Why it pays off

**Reads usually far outnumber writes.** A common rule of thumb is 100 reads per write, or even 1,000. Facebook's TAO, the system that serves its social graph, reports "[a billion reads and millions of writes each second](https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson)." When reads outnumber writes that heavily, an expensive join on every read costs more than a little extra work on every write. A complex join can spend much of its time reading from disk.

**Splitting data makes joins harder.** After federation or sharding, the data a join needs may live on different servers, or even in different data centers. Denormalizing can remove the need for those joins. If each comment row stores the commenter's display name, Crumb can show comments without asking the users database at all.

### Materialized views

Some databases can manage the extra copy for you. A **view** is a saved query that runs each time you read it. A **materialized view** saves the query's *results* as a table, so reading it is as fast as reading a table.

- In **PostgreSQL**, a materialized view is [updated only when you run](https://www.postgresql.org/docs/current/rules-materializedviews.html) `REFRESH MATERIALIZED VIEW`. The documentation's example is a sales summary rebuilt each night for a dashboard. Crumb could use one for a "top recipes this week" page that is fine being an hour out of date.
- **Oracle** can refresh a materialized view [as part of each commit](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CREATE-MATERIALIZED-VIEW.html) to the underlying tables, using `REFRESH ... ON COMMIT`. Its documentation warns this "may increase the time taken to complete the commit."

### Keeping copies in sync

Each copy must change when the original changes. If an author renames herself, every recipe row that holds her old name must change too. The options are:

- **Update both in the same transaction,** as Crumb does with `rating_count`.
- **Use a trigger,** a piece of code the database runs automatically when a row changes.
- **Use constraints.** For example, a foreign key on `(author_id, author_name)` that references `users (id, display_name)` with `ON UPDATE CASCADE` makes the database copy each name change into every recipe. This needs a unique constraint on the pair in `users`.

Constraints and triggers keep copies correct, but they make the schema harder to understand and change.

### Disadvantages of denormalization

- **Data is duplicated.** It takes more storage, and any bug in the sync logic leaves copies that disagree.
- **Keeping copies in sync adds complexity.** Constraints and triggers help, but every extra rule makes the database design harder to follow.
- **It can be slower under heavy writes.** Each write now updates several places. Worse, popular rows become contention points. If thousands of people comment on one viral recipe, every comment must lock that recipe's row to bump `comment_count`. Under a heavy write load, a denormalized database can perform worse than the normalized one.

## SQL tuning

**SQL tuning** means making each query do less work. Whole books cover it, but it always starts with measurement, because guessed fixes often miss. **Benchmarking** creates heavy load on purpose, so you see how the system behaves before real users do. **Profiling** watches the system under load to find which queries use the most time.

### Benchmark: create the load yourself

[`ab`](https://httpd.apache.org/docs/2.4/programs/ab.html), Apache's HTTP benchmarking tool, sends many requests to a URL and reports how many requests per second the server handled. `-n` sets the total number of requests and `-c` sets how many run at once:

```
ab -n 10000 -c 50 https://staging.crumb.example/recipes/101
```

`ab` tests the whole page, app and database together. To load the database directly, PostgreSQL ships [`pgbench`](https://www.postgresql.org/docs/current/pgbench.html), which runs your SQL from many simulated clients and reports transactions per second.

### Profile: find the slow queries

MySQL's [slow query log](https://dev.mysql.com/doc/refman/8.4/en/slow-query-log.html) records every statement that takes longer than `long_query_time` seconds. It is off by default, and the default threshold of 10 seconds is far too high for a website, so Crumb might set it to 0.2. The `mysqldumpslow` tool then groups similar queries so you can see which cost the most in total. Total time is what matters: a 50 ms query that runs 2,000 times a minute costs more than a 5-second query that runs once an hour.

Once you know which query is slow, `EXPLAIN` shows how the database plans to run it. In PostgreSQL's [example](https://www.postgresql.org/docs/current/using-explain.html), a query with no filter gets a `Seq Scan`, which reads every row. A lookup on an indexed column gets an `Index Scan`, which jumps straight to the matching rows. `EXPLAIN ANALYZE` actually runs the query and adds real times and row counts.

These measurements usually point to one of the fixes below.

### Tighten up the schema

Databases store tables on disk in fixed-size blocks called **pages**. InnoDB's default page is [16 KB](https://dev.mysql.com/doc/refman/8.4/en/innodb-limits.html), and PostgreSQL's is [usually 8 kB](https://www.postgresql.org/docs/current/storage-page-layout.html). Reading one row means reading its whole page. Smaller rows mean more rows per page, so each disk read brings in more useful data, and more of the table fits in memory. That is why column types matter.

**`CHAR` for fixed-length values.** `CHAR(4)` always takes 4 bytes: MySQL [pads shorter values with spaces](https://dev.mysql.com/doc/refman/8.4/en/char.html). `VARCHAR(4)` stores a length prefix plus the actual characters, so `'ab'` takes 3 bytes. Because every fixed-length value is the same size, the database can jump straight to one without first reading the lengths of the ones before it. In MySQL's MyISAM engine, a table with no variable-length columns uses a [fixed-size row format](https://dev.mysql.com/doc/refman/8.4/en/data-size.html) that is "faster but may waste some space." So `CHAR` suits values that always have the same length, such as a two-letter country code. This doesn't hold everywhere: PostgreSQL's [documentation](https://www.postgresql.org/docs/current/datatype-character.html) says its `character(n)` "is usually the slowest of the three" string types.

**`TEXT` for long text.** Use `TEXT` for large blocks of text such as recipe instructions. InnoDB can store long values [off-page](https://dev.mysql.com/doc/refman/8.4/en/innodb-row-format.html), leaving only "a 20-byte pointer" in the row, which keeps rows small. `TEXT` columns can also have a [full-text index](https://dev.mysql.com/doc/refman/8.4/en/fulltext-search.html), which supports **boolean searches**: `'+miso -pork'` in `IN BOOLEAN MODE` finds recipes that mention miso but not pork.

**`INT` for whole numbers up to about 4 billion.** An [`INT` takes 4 bytes](https://dev.mysql.com/doc/refman/8.4/en/integer-types.html) (32 bits). It holds up to 2,147,483,647, or 4,294,967,295 (2^32 − 1) when declared `UNSIGNED`. Use `BIGINT` (8 bytes) for IDs that might pass that.

**`DECIMAL` for money.** `FLOAT` and `DOUBLE` store [approximate values](https://dev.mysql.com/doc/refman/8.4/en/floating-point-types.html). In double-precision floating point, 0.1 + 0.2 comes out as 0.30000000000000004. That is wrong for a subscription price. `DECIMAL` stores [exact values](https://dev.mysql.com/doc/refman/8.4/en/fixed-point-types.html), and MySQL names "monetary data" as its main use.

**Keep large files out.** Large binary values (**BLOBs**), such as Crumb's recipe photos, bloat the tables, the backups and the replication stream. Store the file in object storage and keep only its location, such as a URL, in the database.

**What `VARCHAR(255)` is about.** One byte (8 bits) can count up to 255. MySQL gives a `VARCHAR` a one-byte length prefix when its values need at most 255 *bytes*, and two bytes above that. So in some databases, 255 is the longest a column can be while making full use of a one-byte prefix. Two details limit how much this matters. The limit counts bytes, not characters, and in MySQL's `utf8mb4` character set one character can take 4 bytes. And in PostgreSQL the [one-byte header](https://www.postgresql.org/docs/current/datatype-character.html) covers strings up to 126 bytes, so 255 means nothing special there. Pick lengths from what the data needs.

**Use `NOT NULL` where you can.** MySQL's [advice](https://dev.mysql.com/doc/refman/8.4/en/data-size.html) is that `NOT NULL` "makes SQL operations faster, by enabling better use of indexes and eliminating overhead for testing whether each value is NULL." If a value truly can be missing, `NULL` is fine. Just don't allow it everywhere by default.

### Use good indexes

An **index** is a separate, sorted structure that lets the database find rows without reading the whole table, like the index at the back of a book.

**Which columns to index.** Columns used in `WHERE`, `JOIN`, `ORDER BY` and `GROUP BY` are usually faster with an index, and columns a query only reads in its `SELECT` can be added to an index so the query never visits the table. Crumb's recipe page runs this query on every view:

```sql
SELECT author_id, body, created_at FROM comments
WHERE recipe_id = 101 ORDER BY created_at DESC LIMIT 20;
```

Without an index, the database scans every comment on the site and then sorts the matches. An index on `(recipe_id, created_at)` lets it jump to recipe 101's comments, already in date order, and stop after 20.

**How indexes work.** Most indexes are **B-trees**: shallow trees that keep keys sorted and rebalance themselves as rows come and go. Finding, inserting or deleting a key takes **logarithmic time**, so a table a thousand times larger needs only a few more steps per lookup. [Database internals](/learn/database-internals#indexes-getting-query-performance-right) covers B-trees, covering indexes and why column order matters.

**What indexes cost.** An index takes space, and to be fast it must stay in memory, where it competes with the table. Writes get slower too, because every insert, update or delete must also update each index.

**Loading lots of data.** During a big load, it can be faster to drop the indexes, load the data, then rebuild them. PostgreSQL's [documentation](https://www.postgresql.org/docs/current/populate.html) agrees, and warns that queries run slower while the index is missing.

### Avoid expensive joins

A join between a few rows on indexed keys is cheap. A join across large tables on every page view can dominate a database's load. Where profiling shows such a join is the bottleneck, [denormalize](#denormalization) the data it needs or cache the result.

### Partition tables

Some parts of a table are much busier than others. Crumb's `recipes` row holds long instructions that rarely change, and a `view_count` that changes on every page view. Moving the busy column into a small table, `recipe_stats (recipe_id, view_count)`, keeps the hot data compact, so it stays in memory.

Databases can also split a table by rows inside one server, called **table partitioning**. Crumb could partition `comments` by month, so the busy recent months stay small. PostgreSQL's [documentation](https://www.postgresql.org/docs/current/ddl-partitioning.html) says this helps most "when most of the heavily accessed rows of the table are in a single partition or a small number of partitions."

### Pool connections

In PostgreSQL, each connection gets its own [server process](https://www.postgresql.org/docs/current/connect-estab.html). If each of Crumb's app servers opens dozens of connections, the database spends memory on hundreds of mostly idle processes. A **connection pool** keeps a few open connections and lends them to requests as needed. In the transaction mode of [PgBouncer](https://www.pgbouncer.org/features.html), a common pooling proxy, a client holds a real connection "only during a transaction."

### The query cache, and why it's gone

MySQL used to have a built-in **query cache**. It [stored the text of each `SELECT` together with its result](https://web.archive.org/web/20260811114045/https://dev.mysql.com/doc/refman/5.7/en/query-cache.html) and answered identical queries from it. Any change to a table threw away every cached result that used it.

It didn't scale. Every query passed through one shared cache, so busy servers with many cores queued up on it. MySQL switched it off by default in 5.6 (2013), and in 2017 its team [wrote](https://dev.mysql.com/blog-archive/mysql-8-0-retiring-support-for-the-query-cache/) that it "is known to not scale with high-throughput workloads on multi-core machines." Percona's [2016 tuning advice](https://www.percona.com/blog/mysql-5-7-performance-tuning-immediately-after-installation/) also kept it off. It was deprecated in MySQL 5.7.20, and MySQL 8.0's [list of changes](https://dev.mysql.com/doc/refman/8.0/en/mysql-nutshell.html) says: "The query cache was removed."

So on current MySQL there is nothing to tune. Cache results in the application instead, where you control what is stored and when it expires. [Caching](/learn/cache#keeping-the-cache-consistent-with-the-database) covers keeping such a cache in step with the database.

## Check yourself

<details>
<summary>Crumb uses asynchronous primary-replica replication. At 7 p.m. the primary's disk fails. What do users see in the next few minutes, what data might be lost, and what has to happen before comments work again?</summary>

Reads keep working because the replicas are still up, so people can browse recipes, but posting a comment or rating fails: Crumb is in read-only mode. Writes the primary committed but hadn't yet sent are lost. That is usually under a second of writes, more if replicas were lagging. To restore writes, Crumb must confirm the primary is really dead, promote the most up-to-date replica, point the app and other replicas at it, and make sure the old primary can't return as a second primary. Semi-synchronous or synchronous replication would prevent the loss, at the cost of a round trip on every commit.

</details>

<details>
<summary>A teammate proposes sharding Crumb's users by the first letter of their last name, with four shards. Name two problems, and suggest a better key.</summary>

Letters are not equally common as initials, so the shards will be uneven. And a user who changes her name would have to move to another shard. A hash of the user ID spreads users evenly and never changes. Use consistent hashing or a lookup table, so that adding a fifth shard moves only a small share of users.

</details>

<details>
<summary>Crumb's recipe page joins four tables on every view, and recipes are read about 500 times for every comment or rating. What would you denormalize, how would you keep it correct, and when would this backfire?</summary>

Store `author_name`, `comment_count`, `rating_sum` and `rating_count` on the recipe row, so one row read builds the page. Update the counts in the same transaction that inserts the comment or rating, and keep the author name in sync with a cascading foreign key or a trigger. At 500 reads per write, saving a four-table join on every read is worth a little extra work on each write. It backfires when one recipe gets a flood of writes. Then every new comment has to lock the same recipe row to bump the count, and those writes queue up behind each other.

</details>

<details>
<summary>The slow query log shows the comment list query on recipe pages taking 300 ms. How would you confirm the cause, what index would you add, and what does that index cost?</summary>

Run `EXPLAIN ANALYZE` on the query. A sequential scan over `comments` followed by a sort confirms that no useful index exists. Add an index on `(recipe_id, created_at)`. The database can then jump to one recipe's comments, which are already in date order, and stop after 20 rows. The costs: the index takes disk space and memory, and every new comment must now also update the index, so writes get a little slower.

</details>

<details>
<summary>Crumb's write traffic is growing. Someone suggests primary-primary replication between the US and Europe to double write capacity. What's wrong with that reasoning?</summary>

It doesn't double write capacity, because every write still has to be applied on both servers: each primary replays the other's writes as well as its own. It also adds conflicts. If the servers coordinate before each commit, every write waits for a transatlantic round trip. If they don't, the two copies disagree for a while, and ACID's guarantees no longer hold across them. For more write capacity, Crumb should look at federation or sharding, where each write goes to only one primary.

</details>

<details>
<summary>A new engineer reads an old tuning guide and wants to turn on MySQL's query cache. What do you tell them?</summary>

On MySQL 8.0 and later there is nothing to turn on, because the query cache was removed. It was deprecated in 5.7.20 and had been off by default since 5.6. It didn't scale on busy multi-core servers, and any change to a table threw away every cached result for that table. If the goal is to avoid repeating expensive queries, cache the results in the application or in a cache like Redis, where you control what is stored and when it expires.

</details>

## Further reading

Classic references on these techniques (all were reachable when this chapter was written):

- [Scalability, availability & stability patterns](https://www.slideshare.net/jboner/scalability-availability-stability-patterns): Jonas Bonér's slide deck. Its diagrams of master-slave and master-master replication are still a clear overview.
- [Multi-master replication](https://en.wikipedia.org/wiki/Multi-master_replication): Wikipedia's overview of primary-primary replication and its trade-offs.
- [Scaling up to your first 10 million users](https://www.youtube.com/watch?v=kKjm4ehYiMs): an AWS re:Invent 2019 talk on changing an app's architecture step by step as its users grow.
- [Querying data by joining two tables in two databases on different servers](https://stackoverflow.com/questions/5145637/querying-data-by-joining-two-tables-in-two-database-on-different-servers): a Stack Overflow thread showing cross-server joins with linked servers.
- [An unorthodox approach to database design: the coming of the shard](https://highscalability.com/an-unorthodox-approach-to-database-design-the-coming-of-the/): a 2009 High Scalability article on early sharding at Flickr and others.
- [Shard (database architecture)](https://en.wikipedia.org/wiki/Shard_(database_architecture)): Wikipedia's overview of sharding and its history.
- [The simple magic of consistent hashing](https://www.paperplanes.de/2011/12/9/the-magic-of-consistent-hashing.html): Mathias Meyer's short explanation of consistent hashing, with Riak as the main example.
- [Denormalization](https://en.wikipedia.org/wiki/Denormalization): Wikipedia's overview of denormalization and its trade-offs.
- [ab, the Apache HTTP server benchmarking tool](https://httpd.apache.org/docs/2.4/programs/ab.html): the reference for every `ab` option, including its known limits.
- [The slow query log](https://dev.mysql.com/doc/refman/8.4/en/slow-query-log.html): MySQL's reference for turning on and reading the slow query log.
- [Is there a good reason I see VARCHAR(255) used so often?](https://stackoverflow.com/questions/1217466/is-there-a-good-reason-i-see-varchar255-used-so-often-as-opposed-to-another-l): the Stack Overflow thread behind the length-prefix and index-limit explanations.
- [How do NULL values affect performance in a database search?](https://stackoverflow.com/questions/1017239/how-do-null-values-affect-performance-in-a-database-search): answers on how nullable columns interact with indexes in different databases.
- [10 tips for optimizing MySQL queries (that don't suck)](https://web.archive.org/web/20230328150100/https://aiddroid.com/10-tips-optimizing-mysql-queries-dont-suck/): Jesse Farmer's 2008 list (archived repost). Its core advice, profile first, still holds.
- [The MySQL query cache](https://web.archive.org/web/20260811114045/https://dev.mysql.com/doc/refman/5.7/en/query-cache.html): MySQL 5.7's description of the query cache (archived copy), with the deprecation notice at the top.
- [MySQL 5.7 performance tuning immediately after installation](https://www.percona.com/blog/mysql-5-7-performance-tuning-immediately-after-installation/): Percona's 2016 checklist of settings for a new MySQL 5.7 server.

Official documentation worth reading in full:

- [MySQL semisynchronous replication](https://dev.mysql.com/doc/refman/8.4/en/replication-semisync.html): a clear comparison of asynchronous, semi-synchronous and fully synchronous replication.
- [PostgreSQL: log-shipping standby servers](https://www.postgresql.org/docs/current/warm-standby.html): how PostgreSQL replicas, cascading replication and synchronous commit work.
- [PostgreSQL: using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html): a careful tutorial on reading query plans.
- [MySQL: optimizing data size](https://dev.mysql.com/doc/refman/8.4/en/data-size.html): short, practical advice on column types, `NOT NULL` and row formats.

Real systems:

- [Partitioning GitHub's relational databases to handle scale](https://github.blog/engineering/infrastructure/partitioning-githubs-relational-databases-scale/): GitHub's 2021 account of splitting `mysql1` by schema domain, including its query and transaction linters.
- [Herding elephants: lessons learned from sharding Postgres at Notion](https://www.notion.com/blog/sharding-postgres-at-notion): Notion's 2021 write-up of moving to 480 logical shards.
- [TAO: Facebook's distributed data store for the social graph](https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson): the 2013 USENIX paper on a read-heavy system built on MySQL.

Related chapters on this site: [Database internals](/learn/database-internals) for storage engines, indexes and sharding strategies; [NoSQL and choosing a database](/learn/nosql-databases) for the alternatives to relational databases; and [CAP and consistency](/learn/cap-and-consistency) for what replication lag means for consistency.
