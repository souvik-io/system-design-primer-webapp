# Message queues and event streams

The primer's [Asynchronism](/learn/asynchronism#message-queues) chapter explains why queues exist: put slow work on a queue and let workers pick it up later. Interviewers then ask the next questions. What happens if a worker crashes halfway through a message? Can two events for the same order be processed out of order? Can you replay last Tuesday's events after fixing a bug?

The answers depend on which of two designs you pick: a **queue**, where a message is handed to one worker and then deleted, or a **log**, where messages are appended to a durable sequence that many readers walk through at their own pace. This chapter covers both, the delivery guarantees they can give, and the operational pieces (dead-letter queues, back pressure, partition keys) that come up in almost any design with an asynchronous step.

## Queues and logs

### The queue model

RabbitMQ and Amazon SQS are the usual examples. The broker hands each message to one consumer and deletes it when the consumer acknowledges it. If the consumer doesn't acknowledge in time, the message becomes available again and another consumer can take it. SQS calls this window the **visibility timeout**; RabbitMQ redelivers unacknowledged messages when the consumer's channel or connection closes.

This model is good at spreading independent jobs across a pool of workers: add workers and throughput goes up, because any worker can take any message. The cost is that an acknowledged message is gone. There is nothing to replay, and a second application that wants the same messages needs its own copy (a fanout exchange in RabbitMQ, or an SNS topic feeding several SQS queues).

Ordering is weak. With several workers on one queue, message 2 can finish before message 1. SQS standard queues promise only best-effort ordering. SQS FIFO queues keep order within a **message group ID**, and RabbitMQ delivers in order from a single queue, but parallel consumers and redeliveries can still reorder processing.

### The log model

Apache Kafka and Amazon Kinesis Data Streams work differently. A **topic** (Kinesis calls it a stream) is split into **partitions** (Kinesis: shards). Each partition is an append-only log. Every record gets a sequential **offset** within its partition, and records are not deleted when someone reads them. They stay until a **retention** limit expires: a time limit, a size limit, or, in Kafka, log compaction, which keeps only the latest record for each key.

Readers form **consumer groups**. Within a group, each partition is assigned to exactly one consumer, so the group splits the work. Each group tracks its own position (the offset it has processed up to), so two groups reading the same topic don't interfere.

```diagram
title: One topic with three partitions, read by a consumer group
[prod:client] Producers @ 0,1
[p0:queue] Partition 0 @ 1.5,0
[p1:queue] Partition 1 @ 1.5,1
[p2:queue] Partition 2 @ 1.5,2
[c1] Billing\nconsumer 1 @ 3,0.5
[c2] Billing\nconsumer 2 @ 3,2
[note:note] Analytics group\nreads the same\nlog at its own\noffsets @ 4,1.25
prod -> p0 : key hash
prod -> p1
prod -> p2
p0 -> c1
p1 -> c1
p2 -> c2
```

Four consequences follow:

- **Ordering holds per partition only.** There is no order between partition 0 and partition 1.
- **Parallelism is capped by partition count.** Consumers beyond the partition count sit idle.
- **Replay is cheap.** A group resets its offset to an earlier position or timestamp and reads forward again, to recover from a consumer bug or backfill a new service.
- **Fan-out is cheap.** A new consumer group adds read load but needs no copy of the data.

### Sizing a log: a worked example

Suppose a delivery app streams courier GPS pings. Assume 200,000 active couriers, each sending one ping every 4 seconds, at about 200 bytes per ping.

- Rate: 200,000 / 4 = 50,000 events per second.
- Bandwidth: 50,000 × 200 bytes = 10,000,000 bytes/s, about 10 MB/s.
- Storage for 3 days of retention: 10 MB/s × 86,400 s/day = 864 GB/day, × 3 days ≈ 2.6 TB. With a replication factor of 3, about 7.8 TB on disk across the cluster.
- Partitions: if one consumer instance can handle about 2,000 pings per second (an assumption you'd measure), you need 50,000 / 2,000 = 25 consumers, so at least 25 partitions. Round up to something like 48 to leave room for growth, because adding partitions later changes which partition a key lands in.

The shape of the reasoning is what matters: throughput gives bandwidth, retention gives storage, and consumer speed gives the minimum partition count.

## Delivery semantics

The question is what happens when a consumer fails between "I received this" and "I finished this".

| Guarantee | How the consumer behaves | What can go wrong |
| --- | --- | --- |
| At-most-once | Acknowledge (or commit the offset) before processing | A crash after the ack loses the message |
| At-least-once | Process, then acknowledge | A crash after processing but before the ack causes a redelivery, so the work happens twice |
| Effectively-once | At-least-once delivery plus processing that tolerates duplicates | Correctness now depends on your dedup logic |

Assume at-least-once for SQS, RabbitMQ with manual acks, and Kafka consumers that commit after processing. Duplicates are routine: they follow consumer crashes, rebalances, and visibility timeouts that expire because a job ran long.

### What "exactly once" really means

Over an unreliable network, a sender can't know for sure whether a message arrived if the acknowledgment is lost, so it must either resend (risking a duplicate) or not (risking a loss). Exactly-once *delivery* in that sense isn't achievable. What systems offer instead is exactly-once *processing*: the effect of each message is applied once, even though the message itself may be delivered more than once.

There are two common ways to get there:

1. **Idempotent consumers.** Give each message a unique ID, and have the consumer record applied IDs in the same database transaction as the side effect, skipping any ID already present. Or make the operation naturally idempotent: "set balance to 120" is safe to repeat, "add 20" is not. The [reliability patterns](/learn/reliability-patterns) chapter covers idempotency keys.
2. **Atomic offset and output.** Store the consumer's offset in the same transaction as its results. Kafka transactions do this when a consumer reads from Kafka and writes back to Kafka: output records and the offset commit become visible together to readers using `read_committed`. Kafka's idempotent producer also stops a producer retry from writing the same record twice.

Kafka's exactly-once guarantee stops at Kafka's edge. If your consumer sends an email or calls a payment API, you are back to idempotency on the receiving side. Likewise, SQS FIFO queues deduplicate sends within a 5-minute window, which protects against producer retries but not against your consumer's side effects running twice.

In an interview, "we use at-least-once delivery with idempotent consumers" is almost always the right answer. Say how the consumer detects duplicates.

## Dead letters, back pressure and partition keys

### Dead-letter queues

Some messages will never succeed: a malformed payload, a reference to a deleted record, a bug that only triggers on certain input. With at-least-once delivery, such a **poison message** is redelivered forever, burning worker time, and in a log it blocks every record behind it in the same partition.

A **dead-letter queue** (DLQ) is where these messages go after a set number of failed attempts. SQS does this with a redrive policy and `maxReceiveCount`. RabbitMQ uses a dead-letter exchange, and quorum queues can enforce a delivery limit. Kafka has no built-in DLQ for plain consumers; you write failed records to a separate topic yourself (Kafka Connect and many client frameworks provide this as an option).

```diagram
title: A poison message moves to the dead-letter queue after repeated failures
[q:queue] Orders queue @ 0,0
[w] Worker @ 2,0
[db:store] Orders DB @ 4,0
[dlq:queue] Dead-letter\nqueue @ 0,1.5
[ops] Alert, inspect,\nfix, redrive @ 2,1.5
q -> w : receive
w -> db : apply
q --> dlq : after 5 receives
dlq -> ops
```

A DLQ only helps if someone looks at it. Alert on its depth, and have a way to **redrive** messages back to the main queue once the bug is fixed. Also check what skipping does to ordering: if events for one order must be applied in sequence, parking event 3 and applying event 4 may leave the order in a wrong state.

### Back pressure

The primer's [back pressure](/learn/asynchronism#back-pressure) section covers bounding queue size and returning 503s. Two points to add.

Push and pull brokers behave differently. RabbitMQ pushes messages to consumers, so you limit flow with a **prefetch** count, the number of unacknowledged messages a consumer may hold. Kafka and Kinesis consumers pull, so a slow consumer just falls behind.

Falling behind in a log has a hard limit. The gap between the newest offset and a group's committed offset is **consumer lag**, and it is the main health metric for a streaming system. If lag grows past the retention period, the oldest unread records are deleted before the consumer reaches them, and that data is lost. Monitor lag in time ("we are 40 minutes behind") as well as in records, and alert well before it approaches retention.

A buffer absorbs bursts, not a producer that is permanently faster than its consumers. That needs more consumers (and partitions), less work per message, or slower producers.

### Choosing a partition key

In a log, the partition key decides ordering, parallelism and load balance at once. Kafka's default partitioner hashes the key and takes it modulo the partition count, so all records with the same key land in the same partition, in order.

- **Key by the entity whose events must stay ordered.** For order events, key by `order_id`, so "created", "paid", "shipped" for one order arrive in sequence. Events for different orders can interleave freely.
- **Avoid hot keys.** If one key carries a large share of traffic (one giant tenant), its partition and consumer become the bottleneck. Use a finer key (`tenant_id + user_id`), or split the hot key with a suffix and accept losing strict ordering for it.
- **Keep cardinality high.** A key like `country` with 30 values can't spread evenly across 48 partitions.
- **Plan the partition count up front.** Because placement is `hash(key) mod N`, changing N moves most keys. Old records stay put, so for a while one key's events sit in two partitions and per-key ordering can break. Kafka's default partitioner doesn't use [consistent hashing](/learn/consistent-hashing).
- **No key** means records are spread for balance and you get no ordering at all, which is fine for independent events like page-view logs.

## When to pick which

| You need | Lean towards |
| --- | --- |
| A pool of workers doing independent jobs (resize image, send email) | A queue: SQS, RabbitMQ |
| Per-message retry, delay, priority, or routing rules | A queue: RabbitMQ's exchanges and SQS's delay and visibility settings fit this |
| Several independent consumers of the same events | A log: Kafka, Kinesis, Pulsar |
| Replay after a bug, or backfilling a new service from history | A log, with retention sized for the replay window |
| Strict ordering per entity at high throughput | A log, keyed by entity |
| High volume (tens of thousands of events per second and up) with steady throughput | A log |
| Low operational effort at small scale | A managed queue such as SQS |

The lines are blurring. RabbitMQ added streams, a log-style data structure with offsets and replay. Redis Streams has consumer groups. Pulsar supports both queue-style and stream-style subscriptions. Kafka itself is adding share groups (KIP-932, "Queues for Kafka"), which let several consumers share a partition and acknowledge records one at a time, as a queue would. In an interview, name the model you want (queue or log) and the property that made you choose it, then name a product.

Two mistakes are common. Using Kafka for a simple background job queue brings partition counts, rebalances and head-of-line blocking that a work queue wouldn't have. Building an event-driven system where several services react to the same events on a queue that deletes messages once read means you can't replay or add a consumer later without copying data around.

## Check yourself

<details>
<summary>A topic has 12 partitions. Your consumer group has 20 instances and lag keeps growing. What's happening, and what would you change?</summary>

Only 12 of the 20 instances are working, because each partition goes to one consumer in the group, so adding instances won't help. Increase the partition count (accepting that keys get remapped), make each consumer faster (for example by batching database writes), or process records in parallel inside a consumer while committing offsets in order.

</details>

<details>
<summary>A consumer reads a "payment captured" event, credits the merchant's balance in Postgres, then commits its Kafka offset. It crashes between the database write and the commit. What happens, and how do you make it safe?</summary>

After restart, the group resumes from the last committed offset, so the event is processed again and the merchant is credited twice. To make it safe, record the event ID (or the partition and offset) in a table in the same database transaction as the credit, and skip events whose ID is already there. Kafka transactions don't help here, because the side effect is in Postgres, not Kafka.

</details>

<details>
<summary>You key a ride-events topic by city. Most of your traffic comes from three large cities. What problem will you see, and what key would you choose instead?</summary>

The three partitions holding those cities will be hot, and their consumers will lag while others sit idle. Ask what actually needs ordering. Usually it's the events for one ride, so key by `ride_id`. That spreads load evenly and still keeps each ride's events in order.

</details>

<details>
<summary>Your analytics team wants to recompute last month's metrics with a corrected formula. Your events go through SQS today. What would you tell them?</summary>

SQS deletes messages once processed, and keeps even unread ones for at most 14 days, so last month's events are gone. You'd need the raw events archived elsewhere, in object storage or in a log like Kafka or Kinesis with long enough retention. It's a good argument for putting events several teams care about on a log.

</details>

<details>
<summary>A single malformed record in a Kafka partition makes the consumer throw an exception every time. What does that do to the partition, and what's your fix?</summary>

The consumer can't move past that offset, so every record behind it in the partition waits. That is head-of-line blocking. Catch the failure after a few retries, write the record and its error to a dead-letter topic, commit past it, and alert so someone can fix and replay it. Check first whether skipping it breaks ordering assumptions for that key.

</details>

## Further reading

- [Apache Kafka documentation: design](https://kafka.apache.org/documentation/#design): the official explanation of the log, partitions, consumer groups and delivery semantics.
- [Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html): redrive policies and `maxReceiveCount` in practice.
- [RabbitMQ: consumer acknowledgements and publisher confirms](https://www.rabbitmq.com/docs/confirms): how acks, redelivery and prefetch work.
- [Amazon Kinesis Data Streams: key concepts](https://docs.aws.amazon.com/streams/latest/dev/key-concepts.html): shards, partition keys, sequence numbers and retention.
- Alex Xu, *System Design Interview – An Insider's Guide, Volume 2* (2022), with Sahn Lam, "Distributed message queue".
- [System Design School primer](https://systemdesignschool.io/primer): "Buffer with Message Queues" and "Message Queues".
