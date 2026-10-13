# Design a payment system and gateway

A payment system takes money from a customer, records where it went, and eventually pays it out to a merchant. Most of the interview designs in this course can tolerate a little sloppiness: a like count that's briefly off or a post that shows up two seconds late hurts nobody. A payment system can't. If the network drops in the middle of checkout, the customer must be charged once, not zero times and not twice, and every cent that moves has to be accounted for afterwards.

The primer touches on transactions under databases but has no worked payment design. This chapter builds one: **idempotency keys** so retries are safe, a **state machine** for the payment lifecycle, integration with a **payment service provider (PSP)**, a **double-entry ledger**, and a daily **reconciliation** job that checks your records against the outside world.

It builds on the primer's [database](/learn/database) and [consistency patterns](/learn/consistency-patterns) chapters, and on the extra chapters on [distributed transactions](/learn/distributed-transactions) and [reliability patterns](/learn/reliability-patterns).

## Requirements and estimates

### Functional requirements

1. **Accept a payment:** take a card token, an amount and a currency, and charge it through a PSP.
2. **Safe retries:** a retried or duplicated request never charges the customer twice.
3. **Lifecycle:** support authorization, capture, void and refund.
4. **Ledger:** record every movement of money as immutable double-entry records.
5. **Reconciliation:** check internal records against the PSP's and bank's settlement reports every day.

### Non-functional requirements

1. **Correctness over availability.** Payment status and ledger entries need ACID transactions. It's better to reject a payment than to record half of one.
2. **Durability.** Once the API tells a caller a payment succeeded, that fact is committed to replicated storage. A crash must not lose it.
3. **Security and compliance.** Follow PCI DSS (the Payment Card Industry Data Security Standard). Raw card numbers (PANs) and CVVs never reach your application servers.
4. **Latency.** An authorization takes a few seconds at most. Most of that time is spent waiting on the PSP and the card network, not in your own code.

### Capacity estimates

These numbers are assumptions for a large online marketplace, not figures from any real company:

- **Volume:** 10 million payments a day. 10,000,000 ÷ 86,400 s ≈ **116 payments a second** on average.
- **Peak:** sales events like Black Friday can run at about 10× average, so plan for roughly **1,200 payments a second**.
- **Storage:** assume 1 KB per payment, covering the payment row, its state changes and its ledger entries. 10M × 1 KB = **10 GB a day**, and 10 GB × 365 × 5 ≈ **18 TB over five years**, before replication.

None of this needs a sharded NoSQL store. A replicated relational database (PostgreSQL or MySQL with a synchronous standby) handles a few thousand transactional writes a second, and a distributed SQL database such as CockroachDB or Spanner is an option if you outgrow one primary. What you need from the store is transactions and durability, and relational databases are good at both. See [estimation](/learn/estimation) for more on this kind of arithmetic.

## API design and idempotency

### Payment API

```http
POST /api/v1/payments
Idempotency-Key: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
Content-Type: application/json

{
  "order_id": "ord_892341",
  "amount": 4999,
  "currency": "USD",
  "payment_method_token": "tok_visa_4242",
  "customer_id": "cust_104"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "payment_id": "pay_582019",
  "status": "AUTHORIZED",
  "amount": 4999,
  "currency": "USD",
  "created_at": 1735689600
}
```

`amount` is an integer in the currency's smallest unit, so 4999 means $49.99. Never store money as a floating-point number: 0.1 + 0.2 isn't exactly 0.3 in binary floating point, and those errors add up across millions of rows. Note that the smallest unit differs by currency: the Japanese yen has no minor unit, and some currencies use three decimal places.

The response can also come back with a status like `REQUIRES_ACTION` when the card issuer wants the customer to complete an extra check (3-D Secure), and the client then finishes that step before the payment moves on.

### Idempotency keys

Here's the failure every payment API has to handle. The customer clicks "Pay". The payment service charges the card through the PSP. Then the connection drops before the response reaches the browser. The customer sees a spinner and clicks "Pay" again, or the client retries on its own. Without protection, the card is charged twice.

The fix is an **idempotency key**: a unique ID the client generates once per checkout attempt and sends with every retry of that attempt. The server remembers which keys it has seen and what it answered. Stripe popularized this pattern, and there's an IETF Internet-Draft that standardizes the `Idempotency-Key` header.

```diagram
title: Components that make a retried payment safe
[client:client] Client @ 0,0
[pay] Payment service @ 1.5,0
[psp:store] PSP\n(Stripe, Adyen) @ 3,0
[idemp:store] Idempotency\nstore @ 1.5,1
client <-> pay : POST + Idempotency-Key
pay <-> idemp : claim key / save reply
pay <-> psp : charge (same key)
```

The first request with a given key:

1. The client generates a UUID for this checkout attempt and sends it in the `Idempotency-Key` header.
2. The payment service inserts the key into the idempotency store with status `IN_PROGRESS`. A unique constraint on the key makes this the lock: only one request can win the insert.
3. It calls the PSP, passing along an idempotency key of its own derived from the payment ID. That way, if the service itself has to retry the PSP call, the PSP won't charge twice either.
4. When the PSP answers, the service records the result and sets the key's status to `COMPLETED`, storing the response body next to it.
5. It returns `201 Created` to the client.

A retry with the same key:

1. The client resends the identical request with the identical key.
2. The insert fails because the key already exists, so the service reads the stored row instead.
3. If the status is `COMPLETED`, it returns the stored response body. The PSP is not called again.
4. If the status is still `IN_PROGRESS`, the first request is still running. The service returns `409 Conflict` and the client retries a little later.

The claim step in SQL:

```sql
INSERT INTO idempotency_keys (key, customer_id, request_hash, status, created_at)
VALUES ('9b1deb4d-...', 'cust_104', 'sha256:...', 'IN_PROGRESS', NOW())
ON CONFLICT (key) DO NOTHING;
```

If that statement inserts one row, this request owns the key. If it inserts zero, someone else got there first.

A few details make the difference between a toy and a working design:

- **Scope the key to the caller.** Keys from different customers or API clients shouldn't collide, so the uniqueness constraint is on `(customer_id, key)` or the key is namespaced per account.
- **Check the request body.** Store a hash of the request with the key. If a retry arrives with the same key but a different amount, reject it with an error: that's a client bug, not a retry.
- **Handle the "unknown" outcome.** If the PSP call times out, you don't know whether the card was charged. Don't mark the payment failed. Leave it pending and ask the PSP for the status (or retry with the same PSP idempotency key), and let webhooks and reconciliation settle it.
- **Expire keys.** Keys only need to live as long as clients might retry, typically 24 hours to a few days. Stripe, for example, can prune keys once they're at least 24 hours old.
- **Keep the store transactional.** If the idempotency record lives in the same relational database as the payment row, you can update both in one transaction. A cache like Redis is faster but can lose a key on failover, which is exactly when retries happen.

## Payment lifecycle state machine

A payment moves through a fixed set of states, and the service only allows the transitions the business rules permit. Each transition is a database update guarded by the current state (`UPDATE ... SET status = 'CAPTURED' WHERE id = ? AND status = 'AUTHORIZED'`), so two workers can't both capture the same payment.

```diagram
title: Payment states and the transitions between them
[init] INITIATED @ 0,0
[auth] AUTHORIZED @ 1.5,0
[cap] CAPTURED @ 3,0
[fail] FAILED @ 0,1
[void] VOIDED @ 1,1
[exp] EXPIRED @ 2,1
[ref] REFUNDED @ 3,1
init -> auth : approved
init -> fail : declined
auth -> cap : capture
auth -> void : void
auth -> exp : hold lapsed
cap -> ref : refund
```

- **FAILED** means the authorization never succeeded: the issuer declined the card, or the PSP returned an error. No money was held.
- **VOIDED** means the merchant cancelled an authorization before capturing it, for example because the item was out of stock. No money moved.
- **EXPIRED** means nobody captured the authorization in time. Card networks only honor an authorization for a limited window, from a few days to about a month depending on the network and the kind of merchant, after which the issuer releases the hold.
- **REFUNDED** means money that was captured is being sent back. Real systems usually also track partial refunds and chargebacks (disputes the customer raises through their bank), which are separate states.

Keep VOIDED, EXPIRED and FAILED apart. They mean different things to the merchant, to support staff and to the ledger: a failed payment never held money, a voided one released a hold on purpose, and an expired one usually points to a bug or a stuck fulfilment process.

### Authorization vs capture

Many merchants split a card payment into two steps:

1. **Authorization.** The issuer checks the card and places a hold on the amount. The customer's available credit drops, but no money has moved to the merchant.
2. **Capture.** The merchant tells the PSP to collect the authorized amount. The PSP submits it for **clearing and settlement**, and the money reaches the merchant's account later, typically a day or more after capture.

Merchants that ship physical goods often capture when the order ships, so they never collect money for something they can't send. Digital goods are usually authorized and captured in one call.

The difference matters when an order is cancelled:

- **Before capture,** the merchant voids the authorization. Nothing was collected, so there's nothing to give back, and the hold usually disappears from the customer's statement quickly.
- **After capture,** the merchant has to refund. That's a new transfer in the other direction, it takes days to show up, and the processing fee on the original charge is often not returned.

## Double-entry bookkeeping

The simple way to track money is one mutable balance column:

```sql
UPDATE accounts SET balance = balance - 50 WHERE user_id = 104;
```

That works until someone asks why the balance changed. The column only remembers the latest number. You can't tell whether the $50 went to an order, a refund, a bug or an attacker, and you can't rebuild yesterday's balance.

Payment systems use **double-entry bookkeeping** instead, the method Italian merchants were using by the 14th century and that Luca Pacioli described in 1494. Its rules:

1. Every transaction is recorded as at least two **entries**, each a **debit** or a **credit** to some account.
2. In every transaction, total debits = total credits. Money always comes from somewhere and goes somewhere.
3. Balances aren't stored as the source of truth. An account's balance is the sum of its entries. You can cache it, but you can always recompute it.
4. Entries are append-only. To fix a mistake, you add a reversing entry. You never edit or delete a row.

What debit and credit do to a balance depends on the account type. For **asset** accounts (money you hold or are owed), a debit increases the balance and a credit decreases it. For **liability** accounts (money you owe others) and **revenue** accounts, it's the other way round: a credit increases them.

### Example: a $50 marketplace order

Alice buys $50 of shoes from merchant Bob on our marketplace. The marketplace keeps a 3% commission ($1.50) and owes Bob the remaining $48.50. These entries are from the **marketplace's** books, and to keep the example small they ignore the PSP's own fee.

| Transaction | Account | Type | Debit | Credit | What happened |
|---|---|---|---|---|---|
| `tx_001` | `psp_receivable` | asset | $50.00 | | Alice's card captured; the PSP owes us $50 |
| `tx_001` | `merchant_payable:bob` | liability | | $48.50 | We now owe Bob his share |
| `tx_001` | `commission_revenue` | revenue | | $1.50 | Our 3% commission |
| `tx_002` | `cash:bank` | asset | $50.00 | | The PSP settles into our bank account |
| `tx_002` | `psp_receivable` | asset | | $50.00 | The PSP no longer owes us |
| `tx_003` | `merchant_payable:bob` | liability | $48.50 | | We pay Bob, so we owe him nothing |
| `tx_003` | `cash:bank` | asset | | $48.50 | The payout leaves our bank account |

Each transaction balances on its own: $50.00 = $48.50 + $1.50 for `tx_001`, $50.00 = $50.00 for `tx_002`, $48.50 = $48.50 for `tx_003`. Across the table, total debits = total credits = **$148.50**.

After all three, `psp_receivable` and `merchant_payable:bob` are back to zero, `cash:bank` is up $1.50, and `commission_revenue` shows $1.50 earned. That's the right answer: the only money the marketplace kept is its commission. Alice's card doesn't appear at all, because her card account lives in her bank's books, not ours.

A scheduled job checks that every transaction balances and that derived balances match the entries. A mismatch of even one cent should page someone, because it means a bug wrote an unbalanced transaction.

In the database, a ledger is usually two tables: `transactions` (one row per business event, with an idempotency reference back to the payment) and `entries` (one row per debit or credit, pointing at its transaction and account). The application role can `INSERT` into them but has no `UPDATE` or `DELETE` grants.

## End-to-end architecture

```diagram
title: Payment system components
[client:client] Checkout client @ 0,1
[pay] Payment\nservice @ 1,1
[txdb:store] Payments DB\n(state, keys) @ 1,0
[ledger:store] Ledger DB\n(double-entry) @ 1,2
[gw] PSP gateway @ 2,1
[psp:store] External PSP\n(Stripe, Adyen) @ 3,1
[hook] Webhook\nreceiver @ 2.2,2.2
[recon] Reconciliation\njob @ 3,3
client -> pay : POST /payments
pay <-> txdb : state + keys
pay -> gw : charge
gw <-> psp : HTTPS API
psp --> hook : webhooks
hook -> pay : update state
pay -> ledger : append entries
psp --> recon : settlement files
recon -> ledger : compare
```

An [interactive version of this diagram](/diagrams/payment-system.html) lets you pan, zoom and trace the request paths.

The components:

1. **Payment service.** Validates requests, enforces idempotency, drives the state machine, and writes ledger entries when money actually moves (on capture, refund and settlement, not on authorization).
2. **Payments database.** Holds payment rows, their state history and the idempotency keys, all in one ACID database so a state change and its key update commit together.
3. **PSP gateway.** Wraps each PSP's API behind one internal interface, so the payment service doesn't care whether a charge goes to Stripe, Adyen or Braintree. This is also where you put timeouts, retries with the PSP's idempotency key, and [circuit breakers](/learn/reliability-patterns), and where you can route to a second PSP when one is down.
4. **Ledger.** The append-only double-entry store described above. Some teams run it as a separate service with its own database so that nothing else can write to it.
5. **Webhook receiver.** Many outcomes arrive later and asynchronously: a 3-D Secure check completing, a capture settling, a refund finishing, a chargeback. The receiver verifies each webhook's signature, drops duplicates by event ID (PSPs deliver webhooks at least once), and passes the event to the payment service.
6. **Reconciliation job.** Once a day, compares the PSP's settlement reports with the ledger and the payments database.

Writing the payment state and the ledger entries is the one place where two stores must agree. If they're in the same database, one transaction covers both. If the ledger is a separate service, write the state change and an outbox row in one transaction and have a worker deliver the outbox to the ledger, which deduplicates by transaction ID. The [distributed transactions](/learn/distributed-transactions) chapter covers the outbox pattern.

## Reconciliation

If every internal write is transactional and every request is idempotent, why check anything afterwards? Because the system talks to banks, card networks and PSPs over the network, and their view of events can differ from yours:

- A capture succeeds at the PSP, but the response times out and the webhook is lost during an outage, so your database still says `AUTHORIZED`.
- A customer disputes a charge with their bank, and the chargeback reaches you only in a report.
- The PSP deducts a fee you didn't expect, or a currency conversion is off by a cent.
- A bug in your own code writes the wrong amount.

### The daily reconciliation pipeline

PSPs and banks publish **settlement reports**: files (CSV, or banking formats such as ISO 20022 camt.053 and the older SWIFT MT940) listing every transaction that settled in a period, usually daily. Reconciliation compares three sources: the PSP's report, your payments database and your ledger.

```diagram
title: Daily reconciliation
[file:store] PSP settlement\nreport @ 0,0
[internal:store] Payments DB\nand ledger @ 0,1.2
[engine] Reconciliation\njob (batch) @ 1.6,0.6
[ok:store] Matched @ 3.5,0
[bad:store] Exceptions\nqueue @ 3.5,1.2
file -> engine
internal -> engine
engine -> ok : all fields agree
engine -> bad : mismatch
```

The job, often run as a [batch processing](/learn/batch-processing) pipeline:

1. Normalizes both sides into the same shape: PSP transaction ID, amount, currency, type (charge, refund, fee, chargeback), date.
2. Joins them on the PSP transaction ID. It deliberately doesn't join on the amount: if it did, a wrong amount would show up as two unmatched records instead of one mismatch.
3. Puts each record in a bucket:
   - **Matched.** Both sides agree on amount, currency and type. This should be the vast majority.
   - **Missing internally.** The PSP settled something you have no record of, or have in a different state (the lost-webhook case). Usually the fix is to update the payment state and post the missing ledger entries, through the same code path a webhook would use.
   - **Missing externally.** You recorded a capture the PSP didn't settle. Often it's timing: it was captured just before the cutoff and will appear in tomorrow's file. If it's still missing after a day or two, it goes to a person to investigate.
   - **Amount mismatch.** Same transaction, different amounts. Usually an unexpected fee or an exchange-rate difference. A person reviews it and posts a correcting entry.

Every exception gets a ticket and an owner. A rising exception rate is one of the best early warnings that something in the payment path is broken.

## PCI DSS compliance and card tokenization

Any system that stores, processes or transmits card numbers falls under PCI DSS, and the more of your infrastructure touches card data, the bigger and more expensive the yearly assessment. The standard approach is to make sure your servers never see a card number:

1. The checkout page loads the PSP's client-side component (Stripe Elements, Adyen's web components, Braintree's hosted fields). The card fields live in an `iframe` served by the PSP.
2. The card number goes straight from the browser to the PSP's servers. It never passes through yours.
3. The PSP returns a **token** that stands for the card, such as `tok_visa_4242`.
4. The browser sends only the token to your payment service, which passes it to the PSP when charging.

The token is useless outside your account with that PSP, so a leaked token can't be used to charge the card elsewhere. For repeat purchases, you ask the PSP to save the card and store the reusable payment method ID it gives back.

This doesn't take you out of PCI scope entirely: you still have to secure the page that loads the iframe. But it shrinks your obligations to the shortest self-assessment questionnaire (SAQ A for fully outsourced card entry) instead of a full audit of your data centers.

## Check yourself

<details>
<summary>Why record money as double-entry ledger entries instead of updating a balance column?</summary>

A balance column only holds the current number. If it changes from $500 to $400, nothing tells you whether the $100 was a purchase, a subscription, a bug or a theft, and you can't recompute what the balance was last Tuesday.

With double-entry bookkeeping every movement is an append-only transaction whose debits equal its credits, so money always comes from one account and goes to another. The balance is the sum of the entries, so it can be recomputed and audited at any time, and a mistake is fixed with a visible reversing entry instead of a silent edit. A transaction that doesn't balance points straight at a bug.

</details>

<details>
<summary>The network drops after the PSP charged the card but before the client got the response. Walk through how the idempotency key prevents a double charge.</summary>

The first request inserted its key with status `IN_PROGRESS`, called the PSP, and on success stored the response and set the status to `COMPLETED`. The client never saw that response, so it retries with the same key. The insert fails on the unique constraint, the service reads the existing row, sees `COMPLETED`, and returns the stored response without calling the PSP. If the retry arrives while the first request is still running, it sees `IN_PROGRESS` and gets a `409`, then retries later. The service also passes an idempotency key to the PSP, so its own retries to the PSP can't double-charge either.

</details>

<details>
<summary>What's the difference between authorization and capture, and why do merchants separate them?</summary>

Authorization asks the issuer to approve the payment and hold the amount on the card. No money moves to the merchant. Capture tells the PSP to collect the held amount, which then goes through clearing and settlement and reaches the merchant days later.

Separating them lets a merchant authorize at checkout and capture only when the order ships. If the item turns out to be out of stock, the merchant voids the authorization: nothing was collected, so there's no refund to process and usually no processing fee. If too much time passes without a capture, the authorization expires and the hold is released.

</details>

<details>
<summary>In the marketplace example, why is Bob's $48.50 recorded as a credit to a liability account, and why does Alice's card not appear in the ledger?</summary>

When Alice pays, the marketplace receives money that belongs to Bob, so it owes him $48.50. Money you owe is a liability, and liabilities increase with a credit. When the marketplace pays Bob out, it debits that liability back to zero. Alice's card account is an account at her bank, so it lives in her bank's books. The marketplace only records its own side: what the PSP owes it, what lands in its bank account, what it owes merchants, and what it earned.

</details>

<details>
<summary>Reconciliation finds a capture in the PSP's settlement report that your database still shows as AUTHORIZED. What probably happened, and what should the job do?</summary>

Most likely the capture succeeded at the PSP but the response timed out and the webhook was lost or failed. The PSP's report is the evidence that money moved. The job should move the payment to `CAPTURED` and post the ledger entries through the same code path a webhook would use, so the logic isn't duplicated, and log the event so the team can find out why the webhook didn't land.

</details>

## Further reading

- [Designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency): Brandur Leach's post on the Stripe blog explaining idempotency keys and safe client retries.
- [Stripe API reference: Idempotent requests](https://docs.stripe.com/api/idempotent_requests): how a production payment API handles keys, mismatched parameters and key expiry.
- [The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/): the IETF HTTP APIs working group's Internet-Draft standardizing the header.
- [The Double-Entry Counting Method](https://beancount.github.io/docs/the_double_entry_counting_method/): Martin Blais's explanation, from the Beancount documentation, of accounts, debits and credits, and why every transaction sums to zero.
- [PCI Security Standards Council](https://www.pcisecuritystandards.org/): the PCI DSS standard and the self-assessment questionnaires.
- Martin Kleppmann, [*Designing Data-Intensive Applications*](https://dataintensive.net/) (O'Reilly, 2017): the chapters on transactions and on consistency and consensus, background for the guarantees this design relies on.
