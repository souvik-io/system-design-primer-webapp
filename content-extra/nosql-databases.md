# NoSQL and choosing a database

This chapter answers four questions:

- What does "NoSQL" mean, and what do BASE and eventual consistency promise compared with ACID?
- What does the same data look like in a key-value store, a document store, a wide column store and a graph database, and what can each one answer quickly?
- How much of the old "SQL or NoSQL" debate still holds, now that relational databases store JSON and NoSQL databases offer transactions?
- How do you choose, and what did one large company learn from choosing twice?

We'll keep using **Crumb**, the recipe site from [Scalability 101](/learn/scalability-101). Crumb's core data lives in a relational database (say PostgreSQL) with read replicas. Crumb now wants four new features: a shopping cart for ingredient delivery, recipes imported from other sites with fields that don't match its own, a log of every page view, and "recipes saved by cooks you follow". Each feature pulls toward a different kind of database.

## What "NoSQL" means

A relational database stores data in tables with fixed columns. Rows refer to each other through keys, and queries combine tables with **joins**. A join matches rows from two tables on a shared value, such as `recipes.author_id = users.id`.

**NoSQL** is a loose name for databases that store data some other way. Most fall into four families.

| Family | Mental model | What it answers fast | Examples |
| --- | --- | --- | --- |
| Key-value store | A hash table: key in, value out | "Give me the value for this key" | Redis, Memcached, DynamoDB |
| Document store | A key-value store that can read inside its values | "Find documents whose fields match this" | MongoDB, CouchDB |
| Wide column store | A sorted map of rows, each with many named columns | "Give me this range of rows" | Bigtable, HBase, Cassandra |
| Graph database | Records connected by relationships | "Follow these relationships from here" | Neo4j, Amazon Neptune |

Most NoSQL stores share three habits.

**Data is denormalized.** Normalizing means storing each fact once and pointing to it from everywhere else. Denormalizing means copying facts into the places that read them. A denormalized Crumb recipe carries its author's name inside it, so showing it takes one read. The cost is that renaming the author means updating every copy.

**Joins happen in application code.** Many NoSQL stores have no join operation. To show a recipe with its author, Crumb's code fetches the recipe, reads the `author_id`, and makes a second request for the user.

**Full transactions and strong consistency are usually missing.** A transaction groups several writes so that all of them happen or none do. Classic NoSQL stores made only single writes atomic: one key, one document or one row. They also favored **eventual consistency**, where copies of the data on different machines can disagree for a while after a write and agree again once the update has spread. [CAP and consistency 101](/learn/cap-and-consistency-101#the-consistency-spectrum) places eventual consistency among the other levels. Many of these stores have since added transactions back, as a later section shows.

So choosing a database takes two decisions: relational or not, and if not, which family fits the questions your application asks.

## BASE versus ACID

Relational databases promise **ACID** transactions. **Atomicity** means a transaction happens completely or not at all. **Consistency** means it leaves the data obeying the database's rules. **Isolation** means transactions running at the same time don't see each other's half-finished work. **Durability** means a committed write survives a crash. [Relational databases](/learn/relational-databases) covers these in depth.

**BASE** names the looser promise many NoSQL systems make instead. Eric Brewer set it out in his [2000 PODC keynote](https://people.eecs.berkeley.edu/~brewer/cs262b-2004/PODC-keynote.pdf), the talk that brought the CAP theorem to a wide audience.

- **Basically available.** The system answers requests even when some machines or links have failed. The answer might be out of date or partial.
- **Soft state.** The data on a replica can change even when no client is writing to it, because replicas are still passing updates to each other in the background.
- **Eventual consistency.** If writes stop, all replicas end up with the same data after some time. The system doesn't promise how long that takes.

At Crumb, it looks like this. Ben posts a review, and the write succeeds on one replica. Asha loads the recipe a moment later from another replica and doesn't see the review. A second later she reloads, and it's there. Nothing was lost, and both of them were served the whole time.

Brewer's slides set the two side by side:

| ACID | BASE |
| --- | --- |
| Strong consistency | Weak consistency (stale data is OK) |
| Isolation | Availability first |
| Focus on commit | Best effort |
| Nested transactions | Approximate answers are OK |
| Conservative (pessimistic) | Aggressive (optimistic) |
| Availability? (his question mark) | Simpler and faster |
| Hard to evolve (for example, the schema) | Easier to evolve |

Under the table he added, "But I think it's a spectrum." He also noted that "real internet systems are a careful mixture of ACID and BASE subsystems", and that his own company used ACID "for user profiles and logging (for revenue)". So you choose BASE for particular data, and one system can make different choices for different data.

In CAP terms, a BASE system chooses availability over consistency when the network splits: it keeps answering on both sides and reconciles later. [CAP and consistency 101](/learn/cap-and-consistency-101) explains that choice, and its [quorum section](/learn/cap-and-consistency-101#quorums-n-r-and-w) shows how stores like Cassandra let you tune it per request.

## Key-value stores

Here is Crumb's shopping cart as a key-value pair:

```
key:   cart:user:u77
value: {"items":[{"sku":"garlic-200g","qty":2},{"sku":"noodles-500g","qty":1}]}
```

The store treats the value as an opaque blob of bytes. It doesn't know the value is JSON and can't look inside. It can store a value under a key, return the value for a key, and delete a key.

The mental model is a **hash table**. A hash function turns the key into a slot number, so the store finds the value without searching. Reads and writes usually take **O(1)** time, meaning the time stays about the same whether the store holds a thousand keys or a billion. Many key-value stores keep everything in memory. Others keep data on SSDs, which hold far more for the money and are still fast.

### Keys in sorted order

Some key-value stores keep keys in **lexicographic order**, which is dictionary order: compare the first character, then the second, and so on. Sorted keys make one more operation cheap: returning every key in a range. Suppose Crumb stores ratings like this:

```
rating:1042:u12  -> 5
rating:1042:u77  -> 4
rating:2210:u12  -> 2
```

All of recipe 1042's keys sit next to each other, so "all ratings for recipe 1042" is one scan starting at `rating:1042:`. In a store built on a plain hash table, keys are scattered, and the same question means reading every key.

Watch for one trap. Lexicographic order compares characters, so `rating:10` sorts before `rating:9`. Pad numbers to a fixed width (`0009`, `0010`) so that character order matches numeric order.

### Metadata stored with the value

Many key-value stores let you attach information about a value next to the value. A common example is an expiry time. Redis's [`EXPIRE`](https://redis.io/docs/latest/commands/expire/) sets a timeout after which the key "will automatically be deleted", and DynamoDB has a similar [time to live](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.NamingRulesDataTypes.html) feature. Crumb's carts expire after 30 days. Amazon S3, which stores objects under keys, lets you add up to 2 KB of [user-defined metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html) to each object.

### When key-value stores fit

Key-value stores are fast and easy to scale. Each key is independent, so keys spread across machines with [consistent hashing](/learn/consistent-hashing). They suit simple data models and data that changes rapidly: sessions, carts, counters for a [rate limiter](/learn/rate-limiting), feature flags, and a cache in front of a slower database. Redis and Memcached are the usual cache choices, and [Cache 101](/learn/cache-101#redis-internals-and-memcached) covers how they work. The model holds up at huge scale. Amazon's [2022 DynamoDB paper](https://www.usenix.org/conference/atc22/presentation/elhemali) reports that during Prime Day 2021, Amazon's systems made "trillions of API calls" to DynamoDB, "peaking at 89.2 million requests per second".

The weakness is the short list of operations. Say Crumb stores whole recipes this way and then wants "every recipe that uses garlic". The store can't search inside values, so it would have to read every recipe. The usual fix is to build your own index as more keys, such as `ingredient:garlic -> [1042, 2210]`, and update it in application code whenever a recipe changes. Your code now does work a database would normally do, including keeping that index correct when a write fails halfway.

Because they are so simple, key-value stores often sit underneath richer systems. A document store is a key-value store that understands its values, and the distributed SQL databases in [Database 101](/learn/database-101#distributed-sql) store rows as entries in a sorted key-value layer. The [Bigtable paper](https://static.googleusercontent.com/media/research.google.com/en//archive/bigtable-osdi06.pdf) put it this way: "Key-value pairs are a useful building block, but they should not be the only building block one provides to developers." [Design a distributed key-value store](/learn/design-key-value-store) shows how one is built.

## Document stores

Here is a Crumb recipe as a document:

```json
{
  "_id": "recipe:1042",
  "title": "Garlic butter noodles",
  "author": { "id": "u77", "name": "Asha" },
  "cook_minutes": 20,
  "tags": ["quick", "vegetarian"],
  "ingredients": [
    { "name": "noodles", "amount": "200 g" },
    { "name": "garlic", "amount": "4 cloves" }
  ],
  "steps": ["Boil the noodles.", "Melt butter with the garlic.", "Toss together."]
}
```

A **document** holds everything about one object in one place. A relational database would split this recipe across `recipes`, `ingredients` and `steps` tables and join them on every read. Here it comes back in one read.

The mental model is a **key-value store whose values are documents**, usually JSON, XML or a binary form of JSON such as MongoDB's BSON. The difference is that the database can read the document's structure, so you can query and index fields inside it. In MongoDB, "quick recipes that use garlic" is:

```js
db.recipes.find({ "ingredients.name": "garlic", "cook_minutes": { "$lte": 30 } })
```

With an index on `ingredients.name`, that query doesn't scan every recipe.

The line between the two families is blurry, because many key-value stores let you work with metadata or parts of a value. DynamoDB values can hold [lists and maps](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.NamingRulesDataTypes.html) nested up to 32 levels deep, in items of up to 400 KB, and you can update one nested element. So DynamoDB serves as both a key-value store and a document store.

### How documents are organized

Depending on the product, documents are grouped into **collections** (MongoDB's term, roughly a table), or organized by tags, metadata or directory-like paths. A group doesn't force one shape on its members. Here is an imported recipe in the same collection:

```json
{
  "_id": "recipe:import:88213",
  "title": "Shakshuka",
  "source_url": "https://example.com/shakshuka",
  "servings": { "min": 2, "max": 4 },
  "ingredients": ["6 eggs", "1 can tomatoes", "1 onion"]
}
```

It has no author or cooking time, a range of servings, and plain-string ingredients. The database accepts both. That flexibility is the main appeal, and it has a cost: the schema now lives in your code, and everything that reads recipes must handle both shapes.

### Querying and relationships

Document stores provide APIs or query languages for working inside documents. MongoDB has a rich query language and an aggregation pipeline for grouping and reshaping data. CouchDB offers [Mango](https://docs.couchdb.org/en/stable/api/database/find.html), "a declarative JSON querying syntax".

The main design question is whether to **embed** related data or **reference** it by ID. MongoDB's [data modeling guide](https://www.mongodb.com/docs/manual/core/data-model-design/) gives the rule of thumb: "data that's accessed together should be stored together". Crumb embeds ingredients and steps, because they always appear with the recipe. It keeps reviews in their own collection, because a popular recipe can collect thousands and the page shows only the newest few.

Document stores suit data that changes occasionally and is read as a whole object: product catalogs, content pages, user profiles and recipes.

## Wide column stores

Crumb's per-recipe statistics and ratings fit a wide column store well. Here are two rows:

```
row key "recipe:1042"
  stats:views    = 18234   @ 2026-10-17 19:00
  stats:saves    = 912     @ 2026-10-17 18:55
  ratings:u12    = 5       @ 2026-10-15 08:12
  ratings:u77    = 4       @ 2026-10-16 21:40

row key "recipe:2210"
  stats:views    = 41      @ 2026-10-17 11:30
  ratings:u12    = 2       @ 2026-10-14 17:05
```

### The pieces

- A **column** is the basic unit: a name, a value and a timestamp. `ratings:u77 = 4` is one column.
- A **column family** groups related columns, and the store keeps each family's columns together on disk. `stats` and `ratings` are column families. They play roughly the role of tables in SQL, and you usually define them up front.
- A **row** is all the columns that share a **row key**. Rows don't need the same columns. A viral recipe might have hundreds of thousands of rating columns, which is where the name "wide column" comes from.
- A **super column family**, in early Cassandra, added one more level of grouping. The [Cassandra paper](https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf) calls it "a column family within a column family".

You can read any single column directly with its row key and column name, without loading the rest of the row. The whole structure is a nested map:

```
ColumnFamily<RowKey, Columns<ColKey, Value, Timestamp>>
```

Read it from the outside in. A column family maps each row key to that row's columns, and each row maps column names to timestamped values.

### Why every value has a timestamp

The timestamp does two jobs.

**Versioning.** A store can keep several versions of a column. Bigtable [stores them](https://static.googleusercontent.com/media/research.google.com/en//archive/bigtable-osdi06.pdf) "in decreasing timestamp order, so that the most recent versions can be read first".

**Conflict resolution.** When replicas disagree about a column, the store keeps the value with the newest timestamp. This rule is called **last write wins**, and it decides each column separately, which can surprise you. Discord's [2017 write-up](https://discord.com/blog/how-discord-stores-billions-of-messages) describes a user editing a message while another user deleted it. Each column kept its newest write, and the result was a message with text but no author. Discord's fix was to treat messages with no author as corrupt and delete them.

### Where wide column stores came from

Google introduced the model with **Bigtable**. Its [2006 OSDI paper](https://static.googleusercontent.com/media/research.google.com/en//archive/bigtable-osdi06.pdf) describes "a sparse, distributed, persistent multi-dimensional sorted map" that holds "petabytes of data across thousands of commodity servers". Two open-source systems followed its ideas. **HBase** runs on the Hadoop file system and is widely used with Hadoop. **Cassandra** was built at Facebook for Inbox Search, which had to handle "billions of writes per day" and launched by loading "7TB of inbox data for over 100M users" ([Lakshman and Malik](https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf)).

### Sorted keys and hotspots

Bigtable and HBase keep rows sorted by row key, so reading a range of rows is efficient. That makes the row key your most important design decision. Bigtable's example stores web pages under reversed URLs such as `com.cnn.www`, so pages from one domain sit together. The [HBase reference guide](https://hbase.apache.org/book.html) gives the same advice and warns that "poorly designed row keys are a common source of hotspotting". A **hotspot** is a machine that gets far more traffic than the others. If Crumb's view log used keys starting with the timestamp, every new view would land at the end of the range, on one machine.

Cassandra works slightly differently. It [hashes the partition key](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html), the first part of the primary key, to spread partitions evenly across machines. Inside each partition, rows are sorted by the remaining key fields, called **clustering columns**, so range queries work within one partition. [Database 101](/learn/database-101#partitioning-strategies) compares range and hash partitioning.

### When wide column stores fit

Wide column stores offer high availability and scale to very large data sets. They handle heavy writes well, partly because they usually store data in [LSM-trees](/learn/database-101#lsm-trees-built-for-heavy-writes), which turn writes into fast appends. The price is designing tables around your queries. Cassandra's [modeling guide](https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/intro.html) says "data modeling is query-driven", joins are not supported, and data is copied into one table per query.

## Graph databases

Crumb's last feature is "recipes saved by cooks you follow". Here is a small piece of Crumb's data as a graph:

```diagram
title: Part of Crumb's data as a graph. Boxes are nodes (records) and arrows are edges (relationships).
[asha:client] Asha @ 0,0
[ben:client] Ben @ 1.5,0
[r1] Recipe:\nGarlic noodles @ 3,0
[r2] Recipe:\nShakshuka @ 1.5,1.5
[g:note] Ingredient:\ngarlic @ 3,1.5
asha -> ben : FOLLOWS
ben -> r1 : SAVED
asha -> r2 : SAVED
r1 -> g : CONTAINS
r2 -> g : CONTAINS
```

Each **node** is a record (a user, a recipe, an ingredient). Each **edge**, also called an arc, is a relationship between two nodes. Both can carry properties, so the SAVED edge can record when Ben saved the recipe.

In Cypher, the query language of the Neo4j database, the feature is a short query:

```
MATCH (me:User {id: 'asha'})-[:FOLLOWS]->(:User)-[:SAVED]->(r:Recipe)
WHERE NOT EXISTS { (me)-[:SAVED]->(r) }
RETURN r.title, count(*) AS savers
ORDER BY savers DESC
LIMIT 10
```

It starts at Asha, follows her FOLLOWS edges to other users, follows their SAVED edges to recipes, skips recipes she already saved, and ranks the rest by how many people she follows saved them.

In SQL, this joins `follows` to `saves` to `recipes`, and each extra hop adds more joins. Graph databases store relationships as data in their own right, so following an edge doesn't mean searching a join table. They are built for data with many-to-many relationships and long chains of foreign keys, such as social networks. Amazon's [Neptune documentation](https://docs.aws.amazon.com/neptune/latest/userguide/intro.html) lists "recommendation engines, fraud detection, knowledge graphs, drug discovery, and network security" as typical uses.

### You don't always need one

In 2010 Twitter described [FlockDB](https://web.archive.org/web/20170407041322/https://blog.twitter.com/2010/introducing-flockdb), the store behind its follower lists. It held "over 13 billion edges" and peaked at "20k writes/second and 100k reads/second". Twitter said FlockDB "isn't a database optimized for graph-traversal operations". It ran on partitioned MySQL and answered one-hop questions, such as "who follows this user?", and intersections of those lists. If your queries go one hop, an indexed table of edges may be enough. A graph database earns its place when queries go several hops deep or the path itself matters.

### Graph databases then and now

Graph databases used to be described as new and rarely used, with few tools, and with many reachable only through REST APIs. That has changed.

- **There is a standard query language.** ISO published [GQL (ISO/IEC 39075)](https://webstore.iec.ch/publication/94107) for property graphs on 12 April 2024. Cypher itself dates from 2011 ([Wikipedia](https://en.wikipedia.org/wiki/Graph_Query_Language)).
- **SQL can query graphs.** The SQL:2023 standard added SQL/PGQ, which [lets a read-only graph query run inside a SQL `SELECT`](https://en.wikipedia.org/wiki/Graph_Query_Language).
- **Access goes well beyond REST.** Neo4j has [official drivers](https://neo4j.com/docs/create-applications/) for Python, Go, Java, JavaScript and .NET, which use Bolt, a binary protocol, alongside an HTTP API.
- **Managed services exist.** [Amazon Neptune](https://docs.aws.amazon.com/neptune/latest/userguide/intro.html) supports Gremlin, openCypher and SPARQL.

Graph databases are still a specialist tool, usually run beside a main database for the queries where relationships dominate.

## The lines have blurred

Over the past decade, relational and NoSQL databases have borrowed heavily from each other.

**Relational databases store documents.** PostgreSQL added the [`jsonb` type in version 9.4](https://www.postgresql.org/docs/release/9.4.0/), released in December 2014. It stores JSON in a parsed binary form, and a [GIN index](https://www.postgresql.org/docs/current/datatype-json.html) speeds up containment queries. Crumb could keep imported recipes in a `jsonb` column:

```sql
SELECT title FROM recipes WHERE details @> '{"tags": ["vegetarian"]}';
```

The `@>` operator asks "does this document contain that one?". Needing flexible fields no longer forces you off a relational database.

**NoSQL databases do transactions.** MongoDB [4.0, released in mid-2018](https://www.infoq.com/news/2018/07/MongoDB-4.0-Released), added multi-document ACID transactions within a replica set, and [4.2 extended them to sharded clusters](https://www.mongodb.com/docs/manual/core/transactions/). DynamoDB [added transactions in November 2018](https://aws.amazon.com/blogs/aws/new-amazon-dynamodb-transactions/), with up to 25 items at launch and up to 100 since September 2022. MongoDB still warns that transactions "should not be a replacement for effective schema design".

**Consistency is a setting.** DynamoDB reads are [eventually consistent by default](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html), and a strongly consistent read on a table costs twice as much. Cassandra lets each request choose a [consistency level](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html) such as ONE, QUORUM or ALL.

**Distributed SQL arrived.** Spanner, CockroachDB and YugabyteDB offer SQL and serializable transactions while partitioning and replicating data automatically. [Database 101](/learn/database-101#distributed-sql) explains how and at what cost.

So the useful question is no longer just "SQL or NoSQL". Ask which data model fits your queries, what consistency each piece of data needs, and how much data and traffic you expect.

## Modeling for access patterns

With a relational database, you model the data first, in normalized tables, and write whatever queries you need later. The query planner works out how to answer them. With most NoSQL stores, you list the queries first and shape the data to answer them. AWS's [DynamoDB design guide](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-general-nosql-design.html) says "you shouldn't start designing your schema for DynamoDB until you know the questions it will need to answer", and "you should maintain as few tables as possible".

### Single-table design at Crumb

Say Crumb moves recipe pages to DynamoDB. It writes down its access patterns:

1. Show a recipe with its newest reviews.
2. Show a user's saved recipes, newest first.

DynamoDB has no joins, so one table per entity would mean several requests in a row per page. Instead, Crumb puts every kind of item in one table. Each item has a **partition key** (PK), which decides where it is stored, and a **sort key** (SK), which orders items that share a partition key.

| PK | SK | Other attributes |
| --- | --- | --- |
| `RECIPE#1042` | `#META` | title, author name, cook time |
| `RECIPE#1042` | `REVIEW#2026-10-16T21:40#u77` | stars: 4, text |
| `RECIPE#1042` | `REVIEW#2026-10-17T12:03#u81` | stars: 3, text |
| `USER#u77` | `SAVED#2026-10-17T09:15#2210` | recipe title (copied) |

One query for `PK = RECIPE#1042` returns the recipe and its reviews together. Items sharing a partition key form an **item collection**, and fetching several item types in one request is the point of the pattern, as Alex DeBrie explains in [his guide to single-table design](https://www.alexdebrie.com/posts/dynamodb-single-table/). ISO timestamps sort correctly as text, so "newest reviews" is a sorted read. The recipe title is copied into each saved item, so the saved-recipes page needs no second lookup.

DeBrie also lists the costs. The design is hard to learn. A new access pattern, such as "all reviews by one user", may need a new index plus a job that rewrites existing items. Analytics need the data reshaped first. He suggests one table per entity for new apps whose requirements are still changing fast. AWS adds one more rule: choose keys that spread traffic evenly and avoid hotspots.

## A real example: how Discord stores messages

Discord has written twice about where it keeps chat messages. Together, the posts show a team choosing a store for its access patterns and then living with how it runs.

```diagram
title: Where Discord has stored its messages, from its 2017 and 2023 engineering posts
[m:store] MongoDB\none replica set @ 0,0
[c:store] Cassandra\n12 nodes in 2017\n177 nodes by 2022 @ 2,0
[s:store] ScyllaDB\n72 nodes @ 4,0
m -> c : outgrew RAM, 2015
c -> s : moved May 2022
```

**From MongoDB to Cassandra.** Discord's [2017 post](https://discord.com/blog/how-discord-stores-billions-of-messages) says all messages first lived in one MongoDB replica set. Around November 2015, at about 100 million messages, the data and index no longer fit in RAM, and latency became unpredictable. Reads and writes were about 50/50. Discord wanted linear scaling, automatic failover and predictable performance, and chose Cassandra.

The main query was "show the latest messages in this channel", so the primary key became `((channel_id, bucket), message_id)`:

- `channel_id` plus `bucket`, a window of about 10 days, form the partition key. A channel's messages from one window live together, and no partition grows forever.
- `message_id` is the clustering column. Discord's IDs sort by time, so messages in a partition are already in order.

**What went wrong.** The behaviors described earlier showed up in production. Last write wins produced the authorless messages. Writing empty values created **tombstones**, which are markers Cassandra writes to record a deletion, about 12 needless ones per message. Then a public channel that had held millions of messages was cleared down to one. Reading it meant scanning millions of tombstones, which caused 10-second garbage-collection pauses that made Cassandra stop responding.

**From Cassandra to ScyllaDB.** The [2023 follow-up](https://discord.com/blog/how-discord-stores-trillions-of-messages) says that by early 2022 the cluster had 177 nodes and trillions of messages. Busy channels created hot partitions, garbage-collection pauses caused latency spikes, and compaction fell behind. In May 2022 Discord moved to ScyllaDB, a Cassandra-compatible database. It also added Rust "data services" in front of the database, which send one query when many requests for the same data arrive at once.

| | Cassandra | ScyllaDB |
| --- | --- | --- |
| Nodes | 177 | 72 |
| Disk per node | about 4 TB | about 9 TB |
| p99 latency, fetching history | 40 to 125 ms | 15 ms |
| p99 latency, inserting a message | 5 to 70 ms | 5 ms |

(p99 is the time within which 99% of requests finish.) Rewriting the migration tool in Rust cut the estimated copy time from three months to nine days.

The lessons carry over. The wide column model fit because the main query was a time-ordered range inside one channel. The pain came from how the engine behaved under deletes, hot partitions and garbage collection. And the second fix paired a new engine with a layer that cut duplicate reads.

## SQL or NoSQL: making the choice

Start from a relational database unless you have a specific reason not to, because it stays flexible about the queries you'll want later.

### Reasons to choose a relational database

- **Structured data.** Every recipe has the same fields, with known types.
- **A strict schema.** The database rejects a review without a rating, so a buggy client can't store bad data.
- **Relational data.** Users, recipes, reviews and follows all refer to each other.
- **Complex joins.** "Top-rated vegetarian recipes by authors Asha follows, with review counts" is one query.
- **Transactions.** Booking the last seat in a paid cooking class and recording the payment must happen together.
- **Clear patterns for scaling.** Replicas, federation, sharding and caching are well understood ([Relational databases](/learn/relational-databases) covers them).
- **A mature ecosystem.** More developers, community answers, libraries and tools.
- **Fast indexed lookups.** A [B-tree index](/learn/database-101#b-trees-the-default-for-transactional-databases) finds one row among millions in a few page reads.

### Reasons to choose a NoSQL database

- **Semi-structured data.** Imported recipes arrive with different fields.
- **A dynamic or flexible schema.** You can add a field without a migration, though the schema then lives in your code.
- **Non-relational data.** The data is fetched by key, like a session or a cart.
- **No need for complex joins.** Each query reads one entity or one range.
- **Many terabytes or petabytes of data.** Partitioning across machines is built in.
- **Very data-intensive workloads**, such as recording every page view.
- **Very high throughput in IOPS** (input/output operations per second), meaning a very large number of individual reads and writes.

### Data that suits NoSQL well

| Kind of data | Crumb's example | A good fit |
| --- | --- | --- |
| Fast-arriving clickstream and logs | Every page view and search | Wide column store, or DynamoDB with time-sorted keys |
| Leaderboards and scores | "Most-cooked recipes this week" | Redis sorted sets ([Design a gaming leaderboard](/learn/design-gaming-leaderboard)) |
| Temporary data | The ingredient shopping cart | Key-value store with an expiry time |
| Frequently read ("hot") tables | The few recipes that get most views | Key-value cache in front of the database |
| Metadata and lookup tables | Unit conversions, feature flags | Key-value store |

### A decision table

| If you need... | Lean toward | Watch out for |
| --- | --- | --- |
| Queries and reports you can't predict yet | Relational | Scaling writes past one machine |
| Multi-row transactions on most writes | Relational, or distributed SQL at large scale | Cross-region write latency |
| A few flexible fields beside structured data | Relational with JSON columns | Leaving everything untyped |
| Whole objects of varying shape, read and written as units | Document store | Duplicated data going out of sync |
| Lookups by key at very high rates | Key-value store | Any query that isn't by key |
| Huge, write-heavy, time-ordered data | Wide column store | Hot partitions, tombstones |
| Queries that follow relationships several hops deep | Graph database beside a main database | Running and syncing a second database |

### Crumb's answer

Crumb keeps users, recipes, reviews and paid bookings in PostgreSQL, because they are relational and some writes need transactions. Imported recipes go in a `jsonb` column. Sessions, carts and the weekly leaderboard live in Redis. Page views go to a wide column store, keyed by recipe and day so writes spread across machines. If "recipes saved by cooks you follow" grows into multi-hop recommendations, Crumb can add a graph database later, fed from the same data. Every extra database is one more thing to run, back up and keep in sync, so add one only when a real access pattern needs it.

## Check yourself

<details>
<summary>Crumb stores each recipe as a JSON string in a key-value store. Product now wants "recipes that use garlic and take under 30 minutes". What are your options?</summary>

The key-value store can't look inside values, so answering directly means reading every recipe. You could build your own index as extra keys (`ingredient:garlic -> [ids]`) and keep it updated in application code, with the risk that it drifts. The better option is a store that understands the structure: a document store with an index on `ingredients.name`, or a relational database, which can keep flexible fields in `jsonb`. A query on the contents of the data is a sign it belongs in one of those.

</details>

<details>
<summary>Crumb logs page views in a store that keeps row keys sorted. Compare the row keys `2026-10-17T19:00#recipe:1042` and `recipe:1042#2026-10-17T19:00`.</summary>

With the timestamp first, every new write sorts to the end of the key range and lands on one machine, which becomes a hotspot. "All views in the last hour" is then one range scan. With the recipe ID first, writes spread across machines because many recipes are viewed at once, and "views of recipe 1042 this week" is one range scan, but a query across all recipes for one hour must touch every range. Pick the key that serves your main query and spreads your writes.

</details>

<details>
<summary>What does "soft state" mean in BASE? Give an example at Crumb.</summary>

The data on a replica can change even when no client writes to it, because replicas are still passing updates to each other. A replica showing 3 reviews might show 4 a moment later because Ben's review has just arrived from another replica. With eventual consistency, replicas agree once writes stop, but at any moment two readers can see different versions.

</details>

<details>
<summary>Crumb's "people you follow" list is a graph. Does Crumb need a graph database to show it?</summary>

Not for that. "Who does Asha follow?" and "who follows Asha?" are one-hop questions. A table of edges, indexed in both directions and sharded by user ID, answers them quickly. Twitter's FlockDB did this with 13 billion edges. A graph database pays off when queries go several hops, or when the path itself matters, as in fraud detection.

</details>

<details>
<summary>Crumb's DynamoDB table stores reviews under PK = `RECIPE#id` and SK = `REVIEW#timestamp#userId`. A new feature needs "all reviews by user u77". What happens?</summary>

The table can't answer it efficiently, because one user's reviews are spread across every recipe's partition, so only a full scan works. The fix is a global secondary index keyed by reviewer (for example `USER#u77`) with the timestamp as its sort key. If existing items lack that attribute, a backfill job must rewrite them. This is the cost of designing for access patterns up front.

</details>

<details>
<summary>Why did Discord partition messages by `(channel_id, bucket)` instead of by `channel_id` alone?</summary>

With `channel_id` alone, a busy channel's partition would grow forever, and Discord found that partitions over about 100 MB caused garbage-collection pressure. A 10-day bucket caps each partition's size, and the main query, the newest messages in a channel, still reads one partition in sorted order. Loading older history may mean stepping back through several buckets.

</details>

<details>
<summary>A teammate wants MongoDB for Crumb's new payments ledger "because the schema might change". How do you respond?</summary>

A ledger is the strongest case for relational guarantees. Payments touch several records that must change together, the data is highly structured, and auditors will ask questions nobody can predict. PostgreSQL can hold a few flexible fields in `jsonb`, so schema change is a weak reason to move. MongoDB does support multi-document transactions now, but its own documentation says they shouldn't replace good schema design. Keep the ledger relational.

</details>

## Further reading

Classic introductions and surveys:

- [Introduction to NoSQL](https://www.youtube.com/watch?v=qI_g07C_Q5I): Martin Fowler's introductory talk on NoSQL from GOTO 2012, a good one-sitting overview from a well-known writer on software design.
- [NoSQL database systems: a survey and decision guidance](https://vsis-www.informatik.uni-hamburg.de/getDoc.php/publications/555/NoSQL%20database%20systems%20-%20a%20survey%20and%20decision%20guidance.pdf): Gessert, Wingerath, Friedrich and Ritter (2016). It maps requirements to the techniques NoSQL systems use and ends with a decision tree. A Medium version was [posted on the Baqend blog](https://medium.com/baqend-blog/nosql-databases-a-survey-and-decision-guidance-ea7823a822d).
- [SQL & NoSQL, a brief history](https://blog.grio.com/2015/11/sql-nosql-a-brief-history.html): Roberto Carvelli (2015). It runs from Codd's relational model through ACID, CAP and BASE to the four NoSQL families.
- [NoSQL patterns](http://horicky.blogspot.com/2009/11/nosql-patterns.html): Ricky Ho (2009). It covers the machinery shared by many NoSQL stores: consistent hashing, replication, vector clocks and gossip.
- [Explanation of BASE terminology](https://stackoverflow.com/questions/3342497/explanation-of-base-terminology): a Stack Overflow question asking what each part of BASE means, with answers from several people.
- [Scalability for Dummies, part 2: database](https://web.archive.org/web/20220602114024/https://www.lecloud.net/post/7994751381/scalability-for-dummies-part-2-database): Sebastian Kreutzberger's 2011 post (archived), which frames the choice as "keep MySQL and tune it" or "denormalize and move to NoSQL". [Scalability 101](/learn/scalability-101#database-partitioning) discusses how that advice has aged.

Key-value stores:

- [Key-value database](https://en.wikipedia.org/wiki/Key-value_database): Wikipedia's overview of the model.
- [Disadvantages of key-value stores](https://stackoverflow.com/questions/4056093/what-are-the-disadvantages-of-using-a-key-value-table-over-nullable-columns-or): a Stack Overflow discussion of storing attributes as key-value rows inside a relational table instead of using nullable columns.
- [Overview of Redis architecture](http://web.archive.org/web/20161208184737/http://qnimate.com:80/overview-of-redis-architecture/): an archived copy of a short qnimate post on how Redis is put together (the original page is gone). [Cache 101](/learn/cache-101#redis-internals-and-memcached) covers the same ground in more depth.
- [Memcache internals](https://adayinthelifeof.nl/2011/02/06/memcache-internals/): Joshua Thijssen (2011) on Memcached's slab allocator, per-slab LRU eviction and consistent hashing.
- [Amazon DynamoDB: A Scalable, Predictably Performant, and Fully Managed NoSQL Database Service](https://www.usenix.org/conference/atc22/presentation/elhemali): the 2022 USENIX ATC paper, with the Prime Day numbers quoted above.

Document stores:

- [Document-oriented database](https://en.wikipedia.org/wiki/Document-oriented_database): Wikipedia's overview of the model and its variations.
- [MongoDB architecture](https://www.mongodb.com/resources/products/fundamentals/mongodb-architecture): MongoDB's own guidance page, linking to replica sets, sharding, indexing and data modeling.
- [MongoDB data modeling](https://www.mongodb.com/docs/manual/core/data-model-design/): when to embed and when to reference.
- [CouchDB 2.0 architecture](https://blog.couchdb.org/2016/08/01/couchdb-2-0-architecture/): Robert Newson (2016) on how CouchDB shards databases by document ID and keeps several copies of each shard.
- [Elasticsearch from the bottom up](https://www.elastic.co/blog/found-elasticsearch-from-the-bottom-up): Alex Brasetvik (2013). It explains the inverted index, segments and shards inside Elasticsearch and Lucene, a useful contrast with a general-purpose document store.

Wide column stores:

- [Bigtable: A Distributed Storage System for Structured Data](https://static.googleusercontent.com/media/research.google.com/en//archive/bigtable-osdi06.pdf): the 2006 paper that defined the model. Section 2 on the data model is short and readable.
- [Cassandra: A Decentralized Structured Storage System](https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf): Lakshman and Malik's paper from Facebook.
- [HBase architecture](https://www.edureka.co/blog/hbase-architecture/): an Edureka tutorial on regions, the HMaster, ZooKeeper and the write path.
- [Cassandra 3.0 architecture](https://docs.datastax.com/en/archived/cassandra/3.0/cassandra/architecture/archIntro.html): DataStax's archived (no longer maintained) docs on the peer-to-peer design, write path and compaction.
- [Cassandra data modeling](https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/intro.html): the official guide to query-driven table design.
- [How Discord Stores Billions of Messages](https://discord.com/blog/how-discord-stores-billions-of-messages) (2017) and [How Discord Stores Trillions of Messages](https://discord.com/blog/how-discord-stores-trillions-of-messages) (2023): the two posts behind this chapter's case study.

Graph databases:

- [Graph database](https://en.wikipedia.org/wiki/Graph_database): Wikipedia's overview of the model.
- [Neo4j](https://neo4j.com/): the home of the Neo4j graph database. Its documentation covers Cypher and the drivers mentioned above.
- [Introducing FlockDB](https://web.archive.org/web/20170407041322/https://blog.twitter.com/2010/introducing-flockdb): Twitter's 2010 post (archived) on storing billions of follow edges in sharded MySQL.
- [What is Amazon Neptune?](https://docs.aws.amazon.com/neptune/latest/userguide/intro.html): a managed graph database that supports Gremlin, openCypher and SPARQL.

Choosing:

- [Scaling up to your first 10 million users](https://www.youtube.com/watch?v=kKjm4ehYiMs): an AWS re:Invent 2019 talk on how an application's architecture, its databases included, changes as its user count grows.
- [SQL vs NoSQL: The Differences](https://www.sitepoint.com/sql-vs-nosql-differences/): Craig Buckler's SitePoint article (2015, updated 2024), a side-by-side comparison of schemas, joins, transactions and scaling.
- [Transitioning from RDBMS to NoSQL](https://www.infoq.com/articles/Transition-RDBMS-NoSQL/): a 2012 InfoQ interview with Couchbase's Dipti Borkar on when and how to move, including the point that hybrid setups sometimes work best.
- [The What, Why, and When of Single-Table Design with DynamoDB](https://www.alexdebrie.com/posts/dynamodb-single-table/): Alex DeBrie (2020), the clearest explanation of single-table design and of when to avoid it.
- [NoSQL design for DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-general-nosql-design.html): AWS's short guide to access-pattern-first modeling.
- [PostgreSQL JSON types](https://www.postgresql.org/docs/current/datatype-json.html): the `json` and `jsonb` types, containment and GIN indexing.
- [Towards Robust Distributed Systems](https://people.eecs.berkeley.edu/~brewer/cs262b-2004/PODC-keynote.pdf): Brewer's 2000 keynote slides, where BASE and CAP first appear.
