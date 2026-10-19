# Distributed transactions and sagas

Inside one relational database, a transaction makes several writes succeed or fail together. The [relational databases](/learn/relational-databases#transactions-and-acid) chapter covers the ACID properties that make this work. Split the system into [microservices](/learn/reverse-proxy-and-api-gateway#microservices), each with its own database, and that guarantee is gone. Placing an order might touch the order service, the inventory service and the payment service. If the payment fails after inventory was reserved, nothing rolls the reservation back for you.

This chapter covers the two families of answers. **Two-phase commit** tries to keep atomicity across databases, at a real cost in availability. **Sagas** give up atomic isolation and instead run a sequence of local transactions with compensating steps to undo work. It also covers the **dual-write problem**, the subtle bug where a service updates its database and publishes an event, and only one of the two happens. Interviewers bring these up in any design that involves money, bookings or inventory.

## Why one transaction can't span services

A local transaction relies on a single database engine holding locks, writing one log, and deciding commit or abort in one place. Across services, none of that exists:

- **Each service owns its data.** Other services reach it only through its API, so there is no shared engine to hold locks across all of it.
- **The stores may differ.** The order service might use Postgres, inventory might use DynamoDB, and payment goes through an external card processor that has no notion of your transaction.
- **Locks across the network are expensive.** Holding a row lock while you wait for another service to reply makes every concurrent request for that row wait as well.
- **Availability multiplies.** If a commit needs all participants to be up, the components act [in sequence](/learn/availability#the-nines). Three services at 99.9% each give 0.999 × 0.999 × 0.999 ≈ 0.997, or 99.7%, for the operation as a whole.

## Two-phase commit and its blocking problem

**Two-phase commit** (2PC) is the classic protocol for atomic commits across several databases. One node acts as **coordinator**; the databases are **participants**.

1. **Prepare.** The coordinator asks every participant whether it can commit. Each participant does the work, writes it durably along with a "prepared" record, keeps its locks, and votes yes or no. A yes vote is a promise: the participant can no longer abort on its own.
2. **Commit or abort.** If all votes are yes, the coordinator durably records "commit" and tells everyone to commit. If any vote is no, or a participant doesn't answer in time, it tells everyone to abort.

The weak point is the gap between the phases. Suppose all participants vote yes and the coordinator crashes before sending the decision. The participants are now **in doubt**. They can't commit, because another participant might have voted no. They can't abort, because the coordinator might have decided commit and told someone else. So they wait, holding their locks, until the coordinator recovers. Any transaction that needs those rows waits too. This is why 2PC is called a **blocking** protocol.

2PC is still used where its costs are acceptable. Databases support it through XA or commands like PostgreSQL's `PREPARE TRANSACTION` (disabled by default, since `max_prepared_transactions` defaults to 0). Google Spanner runs 2PC across shards, but each participant and the coordinator are themselves replicated with Paxos, so a single machine failure doesn't leave anyone in doubt. That is the general fix: make the coordinator highly available using [consensus](/learn/consensus). It works, but it is a database-internal technique. Across independently owned services, especially external ones like a payment provider, 2PC is rarely an option.

## Sagas

A **saga** is a sequence of local transactions, each in one service. Each step commits on its own and triggers the next. If a step fails, the saga runs **compensating transactions** for the steps that already committed, in reverse order. The idea comes from a 1987 paper by Hector Garcia-Molina and Kenneth Salem on long-lived database transactions.

### Example: booking concert tickets

A ticketing site sells reserved seats. Buying two seats involves four services. Here is one saga for it, with each step's compensation:

| Step | Service | Action | Compensation |
| --- | --- | --- | --- |
| 1 | Orders | Create order with status `PENDING` | Mark order `CANCELLED` |
| 2 | Seats | Place a 10-minute hold on seats 14A and 14B | Release the hold |
| 3 | Payments | Authorize $180 on the card | Void the authorization |
| 4 | Payments | Capture the $180 | None: this is the point of no return |
| 5 | Tickets | Issue tickets and email them | None: retried until it succeeds |
| 6 | Orders | Mark order `CONFIRMED` | None: retried until it succeeds |

The order of the steps is deliberate.

- **Cheap, invisible steps go first.** Releasing a seat hold costs nothing. Voiding an authorization doesn't show up as a charge on the customer's statement. If the card is declined at step 3, undoing steps 1 and 2 is harmless.
- **One step is the pivot.** Capturing the payment (step 4) is the step after which the saga commits to finishing. Before it, everything can be compensated. After it, nothing is undone.
- **Steps after the pivot must be retriable.** Issuing tickets can fail temporarily, but it must eventually succeed, so it is retried with backoff rather than compensated. These steps must be idempotent, because retries will repeat them (see [reliability patterns](/learn/reliability-patterns)).

Compensation is not the same as rollback. A rollback makes it as if the transaction never happened. A compensation is a new action that semantically reverses an old one, and other parts of the system may have seen the intermediate state. If a confirmation email has already gone out, the compensation is a second email saying "your order was cancelled", not unsending the first. Compensations also have to be idempotent and must not fail for business reasons. "Release the hold" has to work even if the hold already expired.

### Orchestration and choreography

There are two ways to drive a saga.

In **orchestration**, a single orchestrator (often part of the order service, or a workflow engine such as AWS Step Functions or Temporal) tells each service what to do, waits for the reply, and decides the next step or the compensations. It persists the saga's state, so it can resume after a crash.

```diagram
title: An orchestrator drives each step and its compensation, and persists saga state
[c:client] Buyer @ 0,1
[orch] Order saga\norchestrator @ 1.5,1
[log:store] Saga state @ 1.5,2.3
[seats] Seat service @ 3.5,0
[pay] Payment service @ 3.5,1
[tix] Ticket service @ 3.5,2
c -> orch : place order
orch -> log
orch --> seats : hold / release
orch --> pay : auth, void, capture
orch --> tix : issue
```

In **choreography**, there is no central controller. Each service listens for events and reacts: the seat service sees `OrderCreated` and places a hold, then emits `SeatsHeld`; the payment service sees `SeatsHeld` and authorizes, and so on. Failures are events too (`PaymentDeclined`), and each service knows which events should make it compensate.

| | Orchestration | Choreography |
| --- | --- | --- |
| Where the flow lives | In one place, readable as code | Spread across services' event handlers |
| Coupling | Orchestrator knows every participant | Services know only the events they consume |
| Debugging "where is order 991?" | Ask the orchestrator | Reconstruct from events in several services |
| Risk | Orchestrator grows into a god service | Cyclic dependencies, flows nobody can see whole |
| Good fit | Many steps, branching, compensations | Short flows with two or three steps |

A common path is to start with choreography and move to orchestration once a flow grows past a few steps or needs careful compensation logic.

### The missing isolation

A saga has atomicity in a loose sense (it eventually completes or compensates) but no isolation. Other requests can see and act on intermediate states. Two examples from the ticket saga: a reporting job counts seats 14A and 14B as sold while they are only held, and the buyer clicks "cancel order" while the payment step is still running.

Common countermeasures:

- **Semantic locks.** Make intermediate states explicit in the data. The order is `PENDING`, the seats are `HELD` rather than `SOLD`. Other operations check these flags: reports count only `SOLD` seats, and a cancel request on a `PENDING` order is rejected or queued until the saga settles.
- **Order the steps to limit exposure.** As in the table above: reversible steps before the pivot, retriable steps after it.
- **Reread before you write.** A step checks that the record hasn't changed since the saga started, for example by comparing a version number, and fails (triggering compensation) if it has.
- **Prefer commutative updates.** "Add 2 to held count" and "subtract 2" can be applied in any order, unlike "set held count to 7".

## The dual-write problem and the transactional outbox

Saga steps are usually connected by events. That introduces a subtle bug. The order service writes the new order to its database and then publishes `OrderCreated` to Kafka. If it crashes between the two, the order exists but no one hears about it. Reverse the order, and a crash can publish an event for an order that was never saved. Two separate systems can't be updated atomically without something like 2PC, which message brokers and databases rarely share. This is the **dual-write problem**, and it appears anywhere a service updates a database and a cache, search index or broker separately.

The **transactional outbox** avoids it by writing only to the database. In the same local transaction as the business change, the service inserts the event into an `outbox` table. Both rows commit or neither does. A separate **relay** then reads the outbox and publishes each event to the broker.

```diagram
title: The order row and its event commit together; a relay publishes the event later
[svc] Order service @ 0,0
[db:store] Orders DB:\norders + outbox @ 2,0
[relay] CDC relay\n(e.g. Debezium) @ 2,1.3
[k:queue] order-events\ntopic @ 4,1.3
[cons] Seat and payment\nservices @ 4,0
svc -> db : one local txn
db -> relay : read WAL
relay --> k : publish
k --> cons
```

The relay comes in two forms:

- **Polling publisher.** Query the outbox for unpublished rows, publish them, mark them sent. Simple, but polling adds latency and load, and under concurrent writers rows can become visible in a different order than their IDs suggest.
- **Change data capture (CDC).** Read the database's replication log (PostgreSQL's write-ahead log via logical decoding, MySQL's binlog) and turn committed outbox inserts into messages. Debezium is a common open-source tool for this, and has an outbox-specific router. CDC delivers events in commit order with low latency, at the cost of running another piece of infrastructure.

Either way, the relay may publish an event more than once (it can crash after publishing but before recording progress), so consumers must deduplicate by event ID. Key the topic by the aggregate ID, such as the order ID, so a given order's events stay in order (see [event streaming](/learn/event-streaming)). Delete or archive outbox rows after publishing so the table doesn't grow forever.

You might ask why not use CDC on the `orders` table itself and skip the outbox. You can, but then consumers depend on your internal table layout, and every schema change risks breaking them. The outbox gives you an explicit event format that you control.

## Check yourself

<details>
<summary>In the ticket saga, why authorize the card before capturing it, instead of charging it in one step?</summary>

Authorization reserves the money without moving it, and voiding it is cheap and nearly invisible to the customer. That keeps the payment step compensatable while the seat hold is still uncertain. Capture becomes the pivot, done only once everything before it has succeeded, so you avoid charging and then refunding, which costs fees and alarms customers.

</details>

<details>
<summary>A 2PC participant voted yes and then lost contact with the coordinator. Why can't it just time out and abort?</summary>

Its yes vote promised it would commit if told to. The coordinator may already have decided commit and told other participants, who have committed. If this participant aborted, the transaction would be committed in some places and not others, which is exactly what 2PC exists to prevent. So it must keep its locks and wait to learn the decision.

</details>

<details>
<summary>Your user service updates a user's email in Postgres and then calls the search service's API to update the index. Sometimes search shows the old email for days. What's wrong, and how would you fix it?</summary>

It's a dual write: when the second call fails or the process crashes between the two, the index never gets the update and nothing retries. Write an event to an outbox table in the same transaction as the email change, and have a relay or CDC pipeline deliver it to the search indexer, which applies it idempotently. The index will lag by seconds, but it will converge.

</details>

<details>
<summary>A customer cancels an order while its saga is between "seats held" and "payment captured". How should the system handle this?</summary>

The order is in a `PENDING` state, which acts as a semantic lock. The simplest safe approach is to record the cancel request and let the saga act on it: if the saga hasn't reached the pivot, it runs compensations (void the authorization, release the seats); if it has, the cancel becomes a normal post-purchase refund flow. What you must avoid is a cancel handler that releases seats directly while the saga is still capturing payment.

</details>

<details>
<summary>A teammate proposes choreography for a 9-step insurance claim workflow with several branches and manual review. What would you push back on?</summary>

With nine steps and branches, the flow would be spread across many services' event handlers, and nobody could see or change it in one place. Answering "why is claim 123 stuck?" would mean piecing events together from several services. An orchestrator, or a workflow engine, keeps the steps, branches, timeouts and compensations in one readable definition, at the cost of a central component you have to keep available.

</details>

## Further reading

- [Hector Garcia-Molina and Kenneth Salem, "Sagas" (1987)](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf): the original paper.
- [Pattern: Saga](https://microservices.io/patterns/data/saga.html) and [Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) by Chris Richardson.
- [Pat Helland, "Life beyond Distributed Transactions"](https://queue.acm.org/detail.cfm?id=3025012) (ACM Queue): designing for a world without distributed transactions.
- [PostgreSQL: PREPARE TRANSACTION](https://www.postgresql.org/docs/current/sql-prepare-transaction.html): two-phase commit in a real database, and its warnings.
- [Debezium outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html): an outbox relay built on CDC.
- Alex Xu, *System Design Interview – An Insider's Guide, Volume 2* (2022), with Sahn Lam, "Digital wallet".
- [System Design School primer](https://systemdesignschool.io/primer): "Multi-Step Workflows and Sagas".
