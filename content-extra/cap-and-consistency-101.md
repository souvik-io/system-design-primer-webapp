# CAP and consistency 101

This chapter answers five questions:

- What does the CAP theorem actually say, and what do C, A and P mean?
- Why is "pick two of three" a misleading way to put it?
- How often do networks really break, and what did Amazon, Google and GitHub do about it?
- What trade-off do databases face on normal days, when nothing is broken?
- What do "eventual" and "strong" consistency mean in practice, and how do quorums let you choose between them?

Good short introductions to CAP include Robert Greiner's blog post [CAP Theorem: Revisited](https://robertgreiner.com/cap-theorem-revisited/) (2014), Kaushik Sathupadi's [A plain English introduction to CAP theorem](http://ksat.me/a-plain-english-introduction-to-cap-theorem), Henry Robinson's [CAP FAQ](https://github.com/henryr/cap-faq) (2013), and a short [video lecture on the CAP theorem](https://www.youtube.com/watch?v=k-Yaq8AHlFA). The three levels of consistency, weak, eventual and strong, come from Ryan Barrett's 2009 Google I/O talk [Transactions Across Datacenters](https://snarfed.org/s/transactions_across_datacenters_io.html).

This chapter covers what those sources say and a good deal more, and every number in it links to its source.

We'll follow one imaginary product throughout. **Pebble** is a small online bank. Asha and Ben share a joint account with $500 in it. Pebble runs in two data centers, East and West. It keeps a copy of every balance in both, so that either one can serve customers if the other goes down. Asha's requests usually go to East, and Ben's go to West.

```diagram
title: Pebble keeps a copy of every balance in two data centers.
[a:client] Asha @ 0,0
[e] East\napp servers @ 1,0
[de:store] East\ndatabase @ 1,1
[w] West\napp servers @ 3,0
[dw:store] West\ndatabase @ 3,1
[b:client] Ben @ 4,0
a -> e
b -> w
e -> de
w -> dw
de <-> dw : replication
```

## When the link breaks

While East and West can talk to each other, keeping the two copies the same is routine work. Asha withdraws $100 in East. East tells West about it, and both copies now say $400.

Now cut the link between them. Maybe a fiber cable gets dug up, a network switch reboots, or someone pushes a bad configuration. Both data centers are still running, and customers can still reach both of them. But East and West can no longer reach each other. This situation is called a **network partition**: the network has split into parts that can't talk.

During the partition, Ben checks his balance in West and then tries to withdraw $400. West has two choices:

1. **Refuse or wait.** West can't check with East whether the balance has changed. So it returns an error, or holds the request until the link comes back. Ben is unhappy, but nobody sees a wrong number.
2. **Answer anyway.** West uses its own copy, which still says $500, and lets Ben withdraw. If Asha withdraws $400 in East at the same moment, the account ends up $300 overdrawn once the link comes back.

Neither choice gives Ben an up-to-date answer. Only East knows about Asha's withdrawal, and East can't tell West. West must either stay correct by refusing, or stay available by answering with data that might be stale. That forced choice is the CAP theorem. The rest of this chapter states it carefully and looks at how real systems live with it.

## What C, A and P actually mean

Most explanations of CAP use informal definitions. The formal ones come from the [2002 proof](https://www.comp.nus.edu.sg/~gilbert/pubs/BrewersConjecture-SigAct.pdf) by Seth Gilbert and Nancy Lynch. They are narrower than most people assume.

### C: consistency

**Consistency** means the system behaves as if there were only one copy of the data, even though there are several. Once anyone has seen Asha's withdrawal, nobody anywhere may see the old $500 again.

The technical name for this is **linearizability**. Gilbert and Lynch define it as a single order of all operations in which "each operation looks as if it were completed at a single instant." Martin Kleppmann says it plainly in [Please stop calling databases CP or AP](https://martin.kleppmann.com/2015/05/11/please-stop-calling-databases-cp-or-ap.html): consistency in CAP "actually means linearizability, which is a very specific (and very strong) notion of consistency."

**This is not the C in ACID.** In ACID, consistency means that each transaction leaves the database following its rules, such as "usernames are unique" or "a balance never goes below zero." CAP's consistency is only about whether every reader sees the latest value. Gilbert and Lynch point this out in a footnote. Eric Brewer, who first proposed CAP, says the same in [CAP Twelve Years Later](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/): "the C in CAP refers only to single-copy consistency, a strict subset of ACID consistency." So Pebble's rule that a balance never goes negative is an ACID-style rule, and CAP says nothing about it.

### A: availability

**Availability** in the proof is also strict: "every request received by a non-failing node in the system must result in a response." In other words, every server that is still running has to answer, including the ones that are cut off from the rest. Suppose that during a partition only the larger group of servers keeps serving, and the smaller group refuses requests. That system is not "available" in the CAP sense, even if most customers never notice.

### P: partition tolerance

**Partition tolerance** means the system keeps its promises even when the network loses messages. The proof allows the network to "lose arbitrarily many messages sent from one node to another."

From inside a server, a slow link and a broken link look exactly the same: a reply you were waiting for hasn't arrived. Brewer's 2012 article draws the practical conclusion: "a partition is a time bound on communication." If a server can't hear from the other side within the time it is willing to wait, it has to treat the situation as a partition. For that request, it must pick consistency or availability.

Greiner's post uses looser wording. For example, he describes availability as "a reasonable response within a reasonable amount of time." That is fine for design discussions, but it isn't what the theorem proves.

## Where the theorem came from

Eric Brewer was a professor at Berkeley and a co-founder of Inktomi, a company that built search engines and web caches on clusters of machines. In his 2012 article, he writes that the idea "first appeared in fall 1998" and was published in 1999.

It reached a wide audience on July 19, 2000, in his keynote at the ACM Symposium on Principles of Distributed Computing (PODC), titled [Towards Robust Distributed Systems](https://people.eecs.berkeley.edu/~brewer/cs262b-2004/PODC-keynote.pdf). The key slide reads: "Theorem: You can have at most two of these properties for any shared-data system." At that point it was not yet proved. It was a conjecture, based on his experience building real systems. The same talk framed the wider trade-off as ACID versus BASE, short for "basically available, soft state, eventually consistent."

Two years later, Gilbert and Lynch, both at MIT, proved it. Their paper, "Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services," appeared in ACM SIGACT News in 2002. It assumes a network where there are no shared clocks and messages can be lost. Their Theorem 1 says that in such a network, no data store can guarantee both availability and consistency.

The proof is the Pebble story with the names removed:

1. Split the servers into two groups.
2. Drop every message between the groups.
3. Write a new value on one side.
4. Read it on the other side.

If both sides must answer, the read can't possibly see the write.

## Why "pick two of three" misleads

CAP is usually taught as "you can only have two of the three guarantees." Brewer himself wrote in 2012 that "the '2 of 3' formulation was always misleading because it tended to oversimplify the tensions among properties." There are three problems with it.

### Problem 1: you can't choose to give up P

A partition is something the network does to you. As Greiner puts it: "Network failures happen to your system and you don't get to choose when they occur." Robinson's FAQ restates the theorem as "Possibility of Partitions => Not (C and A)." In other words, if partitions can happen, you can't have both C and A. He says there is "no realistic CA system" among distributed systems.

A single database on a single machine can be consistent and available, because there is nothing for it to be cut off from. But as soon as Pebble runs in two data centers, partitions are possible. So the real question is not "which two letters?" It is: "during a partition, do we keep consistency or availability?"

### Problem 2: the choice only applies during a partition

Brewer again: "because partitions are rare, there is little reason to forfeit C or A when the system is not partitioned." On a normal day, Pebble can be fully consistent and fully available at once.

### Problem 3: the choice doesn't have to be the same everywhere

Brewer notes that the choice "can occur many times within the same system at very fine granularity." It can be different for each operation, each kind of data, or even each user.

His own example is a bank's ATM network. You might expect ATMs to need strong consistency, "but in practice, A trumps C," because an ATM that works is an ATM that earns money. When an ATM loses contact with the bank, it switches into what Brewer calls **stand-in mode**:

- It limits withdrawals to some amount k, "where k might be $200."
- Deposits and balance checks keep working.
- When the network comes back, the bank compares records. If an account went below zero, it charges a fee.

In Brewer's words, the banking system "depends not on consistency for correctness, but rather on auditing and compensation."

That gives Pebble a better answer than "refuse everything" or "allow everything." During a partition, West can accept deposits, show balances marked "may be out of date," and let Ben withdraw up to $200. The worst case is a limited overdraft, and the bank can fix that afterward. Brewer recommends this pattern in general:

1. Detect that a partition has happened.
2. Switch to an explicit partition mode that limits some operations.
3. Run a recovery process when the link comes back.

### Most real databases are neither CP nor AP

Kleppmann adds that under the strict definitions, many real databases fit neither label. Take a common setup: one leader database that accepts writes, plus replicas that copy from it in the background.

- It isn't CAP-available, because clients that can't reach the leader can't write.
- It isn't CAP-consistent, because the replicas can return stale data.

He suggests describing a system by the specific guarantees it does offer, instead of by a two-letter label. When people do use the labels, read them as a short description of what the system does during a partition:

- A **CP** system keeps consistency. During a partition, it refuses or delays requests it can't answer correctly, so a request to the cut-off side may wait and then fail with a timeout error. CP is a good fit when the business needs reads and writes to be atomic, as with Pebble's balances.
- An **AP** system keeps availability. During a partition, each side keeps answering with the most recent version of the data it has, which may not be the latest. Writes made on one side can take some time to reach the other side once the link is back. AP is a good fit when the business can accept eventual consistency, or when the system must keep working despite failures outside its control.

## Partitions really happen

It is tempting to treat partitions as rare enough to ignore. The evidence says otherwise.

**Microsoft's data centers.** Phillipa Gill, Navendu Jain and Nachiappan Nagappan studied more than a year of network logs from tens of Microsoft data centers in [Understanding Network Failures in Data Centers](https://people.cs.umass.edu/~phillipa/papers/comm235-gill.pdf) (SIGCOMM 2011). On average, they counted 5.2 network devices and 40.8 network links failing per day. Backup network paths helped less than you might hope. They found that "network redundancy is only 40% effective in reducing the median impact of failure."

**A collection of real incidents.** Peter Bailis and Kyle Kingsbury gathered dozens of real outages in [The network is reliable](https://aphyr.com/posts/288-the-network-is-reliable) (2013), later published in Communications of the ACM in 2014. Two examples:

- Google's paper on Chubby, its lock service, reported 61 outages over 700 days. Nine of them lasted more than 30 seconds. Of those nine, four were caused by network maintenance and two by suspected network problems.
- On December 22, 2012, a switch software update at GitHub caused a 90-second partition. In several pairs of file servers, each server decided its partner was dead, and both ended up shut down. Recovering them took five hours, and GitHub was badly degraded the whole time.

**Even Google's own network.** Google runs its own global network, and it still sees partitions. In [Spanner, TrueTime and the CAP Theorem](https://research.google/pubs/spanner-truetime-and-the-cap-theorem/) (2017), Brewer reports that network problems caused under 8% of incidents in Spanner, Google's database, and that "we did see individual data centers or regions get cut off from the rest of the network."

## CP and AP choices in real systems

Here are three real systems. Amazon chose availability on purpose. Google chose consistency and made partitions rare enough that it hardly matters. GitHub ended up choosing during an outage, which is the expensive way.

### Amazon's shopping cart: stay writable, merge later

Amazon's [Dynamo paper](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf), presented at the SOSP conference in 2007, describes a key-value store built to always accept writes. The main example is the shopping cart: "customers should be able to view and add items to their shopping cart even if disks are failing, network routes are flapping, or data centers are being destroyed by tornados."

**How it works.** During a failure, Dynamo lets different copies of the same cart accept changes independently. That can leave two versions of one cart that disagree. Dynamo keeps both, and tags each with a **vector clock**, a small record of which server made which changes, so it can tell the versions apart. The next time the cart is read, the shopping cart code merges the versions into one.

**The cost.** The paper is open about it: "an 'add to cart' operation is never lost. However, deleted items can resurface." Suppose you removed a book from your cart on one side of a partition, while the other side still had it. When the versions are merged, the book comes back.

**Why Amazon accepted that.** The paper opens by noting that at Amazon "even the slightest outage has significant financial consequences." Compared with a cart that refuses changes, a removed item that reappears is a small annoyance. So for carts, Amazon chose AP on purpose.

### Google Spanner: consistent, and available enough

Spanner, described in Google's [OSDI 2012 paper](https://research.google/pubs/spanner-googles-globally-distributed-database-2/), is a SQL database replicated around the world with strong consistency. In his 2017 note, Brewer asks whether it beats CAP.

**Technically, it's CP.** "During (some) partitions, Spanner chooses C and forfeits A." Every update has to be agreed by a majority of the copies, using a voting protocol called **Paxos**. If the server in charge of an update can't reach a majority, the update waits.

**In practice, it's "effectively CA."** Spanner's availability inside Google is better than five nines (99.999%), so users treat it as always up. Brewer says the reason is mostly Google's network:

- Spanner's traffic stays on Google's own private links.
- Each data center typically has at least three independent fiber connections.
- A majority of Spanner's copies has never ended up on the smaller side of a partition.

Google's clock service, **TrueTime**, often gets the credit, but Brewer writes that it "does not significantly help achieve CA." What TrueTime does is give a time range that is guaranteed to contain the real time. Spanner uses that to put all transactions in a reliable order. This guarantee is called external consistency, and Brewer describes it as similar to linearizability.

### GitHub, October 2018: a partition makes the choice for you

GitHub's [post-incident analysis](https://github.blog/2018-10-30-oct21-post-incident-analysis/) shows what happens when a system ends up on one side without planning to.

**The 43-second partition.** At 22:52 UTC on October 21, 2018, engineers were replacing failing 100G optical equipment. The work cut the link between GitHub's US East Coast network hub and its main East Coast data center. "Connectivity between these locations was restored in 43 seconds."

**What the system did.** GitHub uses a tool called Orchestrator to manage its MySQL databases and decide which server is the primary. During those 43 seconds, the Orchestrator servers that could still talk to each other formed a majority without the East Coast data center. They decided the East was gone and started moving the primary databases to the West Coast. When the link came back, applications began writing to the West.

**The damage.** A few seconds of writes had already landed in the East and never been copied to the West. In GitHub's words, "the database clusters in both data centers now contained writes that were not present in the other data center."

**The choice.** GitHub couldn't safely switch back to the East, because that would lose the newer writes made in the West. Staying on the West wasn't good either. Most database calls would then need a round trip across the country, and that would make the site unusable for many users. GitHub chose to "prioritize data integrity over site usability and time to recovery." The team restored data from backups and began reconciling the stray writes by hand. One of the busiest clusters alone had 954 of them.

**The cost.** The site was degraded for 24 hours and 11 minutes. More than five million webhook events and 80,000 Pages builds queued up along the way.

GitHub ended up making a CP choice: it kept the data correct and gave up availability. But it made that choice in the middle of an incident, at a high price. Brewer's advice to plan an explicit partition mode is about making the decision ahead of time instead.

## PACELC: the trade-off when nothing is broken

CAP only tells you something about the times when the network is partitioned. Daniel Abadi argued in [Consistency Tradeoffs in Modern Distributed Database System Design](https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf) (IEEE Computer, February 2012) that a different trade-off matters more to database design, because it applies all the time: **consistency versus latency**.

Here's how it looks at Pebble on a normal day, with the network working fine. Asha withdraws money in East. East has two options:

- **Wait for West to confirm before telling Asha it worked.** Both copies always agree, but every write has to wait for a round trip across the country.
- **Reply to Asha right away, and copy the change to West in the background.** Writes are fast, but for a short time West may still show the old balance.

Abadi's name for the full picture is **PACELC**, pronounced "pass-elk." It reads as two questions:

- **If there is a Partition (P):** does the system choose Availability (A) or Consistency (C)?
- **Else (E), when running normally:** does it choose low Latency (L) or Consistency (C)?

Abadi classifies some well-known databases this way:

| Database | During a partition | Normal operation |
| --- | --- | --- |
| Dynamo, Cassandra, Riak | Availability (PA) | Latency (EL) |
| VoltDB/H-Store, Megastore, BigTable, HBase | Consistency (PC) | Consistency (EC) |
| MongoDB | Availability (PA) | Consistency (EC) |

The first group gives up consistency in both cases. The second group, which includes fully ACID systems, pays in availability and latency to stay consistent.

## The consistency spectrum

Consistency is not just on or off. Barrett's talk describes three levels.

**Weak consistency: after a write, reads may or may not see it.** Barrett's slide calls it "best effort only." His examples are voice calls over the internet, live video and real-time multiplayer games, where a lost update doesn't matter because a new one arrives a moment later. If your phone loses signal for a few seconds during a call, you don't hear what was said in the gap, and the call carries on. Memcached is another example: an entry in a [cache](/learn/cache-101) can be thrown out or go stale at any time. Pebble might accept weak consistency for a "recently viewed" list, but never for balances.

**Eventual consistency: after a write, reads will see it eventually, with no promise about when.** Werner Vogels of Amazon defines it in [Eventually Consistent](https://www.allthingsdistributed.com/2008/12/eventually_consistent.html) (revised for ACM Queue in 2008). It is a guarantee "that if no new updates are made to the object, eventually all accesses will return the last updated value." His classic example is DNS: when you change a domain's address, servers around the world pick up the change over time. Email works the same way. The gap between the write and the moment every reader sees it is called the **inconsistency window**. Data is usually copied to replicas in the background. Barrett's table puts [primary-replica replication](/learn/relational-databases#primary-replica-replication) with background copying in this group, and most [NoSQL](/learn/nosql-databases) databases favor it. Eventual consistency suits systems that must stay highly available.

**Strong consistency: after a write, every read sees it.** Barrett's examples are file systems and relational databases. Every write is copied to the other replicas before it counts as done. Strong consistency suits systems that need transactions. That makes writes slower, and during some partitions part of the data can't be served at all. Pebble's balances belong here, with Brewer's limited stand-in mode for partitions.

## Guarantees for one user

Plain eventual consistency can confuse a single user. Ben deposits $50 and refreshes the page. The deposit is gone, because his read went to a replica that hadn't received it yet. He refreshes again, and it's back.

You don't need strong consistency everywhere to prevent this. Vogels's article names smaller guarantees that each fix part of the problem:

- **Read-your-writes.** After you change something, you always see your change. In Vogels's words, the process "always accesses the updated value and will never see an older value." Ben always sees his own deposit.
- **Session consistency.** Read-your-writes, kept for as long as a session lasts.
- **Monotonic reads.** Once you have seen a value, you never see an older one. In Vogels's words, "any subsequent accesses will never return any previous values." Ben's balance never jumps backward.
- **Causal consistency.** If one change caused another, everyone sees them in that order. If Asha tells Ben she has made a transfer, and Ben then checks, he sees the transfer.

These cost far less than strong consistency for everyone. Two cheap ways to get them:

- **Read-your-writes:** for a few seconds after a user writes, send that user's reads to the primary database. The same fix appears in [Scalability 101](/learn/scalability-101#database-replication).
- **Monotonic reads:** always send each user to the same replica.

Systems can also move along the spectrum over time. For years, Amazon S3 was eventually consistent. After a write, there was a short window when the new data was "not yet visible to all GET or LIST requests." On December 1, 2020, AWS [announced](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/) that all S3 GET, PUT and LIST operations were now strongly consistent. The change covered existing and new objects in all regions, at no extra charge, and AWS said it had no impact on performance.

## Quorums: N, R and W

Dynamo-style databases let you pick your own spot on the consistency spectrum by setting three numbers:

- **N** is how many replicas store each item.
- **W** is how many replicas must confirm a write before it counts as done.
- **R** is how many replicas are asked on each read.

A group of replicas that is big enough to count is called a **quorum**. Vogels gives the rule: "If W+R > N, then the write set and the read set always overlap and one can guarantee strong consistency."

Here's why. With N = 3, W = 2 and R = 2, every write reaches at least two of the three replicas, and every read asks two of the three. Any two replicas you read from must include at least one that got the latest write, as the diagram shows. But if W + R ≤ N, a read might ask only replicas that missed the write, and you get eventual consistency instead. The Dynamo paper reports that N = 3, W = 2, R = 2 was the common setting across several of Amazon's Dynamo deployments.

```diagram
title: N = 3, W = 2, R = 2. The read and the write always share a replica.
[w:client] Writer @ 0,0
[r:client] Reader @ 0,2
[a:store] Replica A\nnew value @ 2,0
[b:store] Replica B\nnew value @ 2,1
[c:store] Replica C\nold value @ 2,2
w -> a : write
w -> b : write
r -> b : read
r -> c : read
```

The same numbers also decide availability. With W = 2, a write fails if two of the three replicas can't be reached. With W = 1, writes almost always succeed, but reads can miss them.

Kleppmann adds two warnings:

1. **Quorums aren't CAP-available.** During a partition, clients on the smaller side can't reach enough replicas, so their quorum reads and writes fail.
2. **Don't rely on quorums alone for linearizability.** Real databases add features on top of the basic rule, such as **sloppy quorums**, which let other servers stand in when replicas are unreachable, and **read repair**, which fixes stale replicas during reads. These create edge cases where, for example, deleted data comes back.

So treat the W + R > N rule as a good first approximation, not a full guarantee. The [relational databases](/learn/relational-databases#replication-copies-of-the-whole-database) and [NoSQL](/learn/nosql-databases) chapters cover the replication setups it applies to.

## What Barrett's talk adds

The three consistency levels come from Ryan Barrett's talk [Transactions Across Datacenters (and other weekend projects)](https://snarfed.org/s/transactions_across_datacenters_io.html), given at Google I/O in 2009. It uses Google App Engine's datastore as the case study. The page linked here is his slide deck, and the [video](https://www.youtube.com/watch?v=srOgpXECblk) runs about an hour.

The weak, eventual and strong levels come from his opening slides. The main part of the talk compares five ways to keep data in more than one data center, summed up in one table:

| | Backups | Master/slave | Multi-master | 2PC | Paxos |
|---|---|---|---|---|---|
| Consistency | Weak | Eventual | Eventual | Strong | Strong |
| Latency | Low | Low | Low | High | High |
| Throughput | High | High | High | Low | Medium |
| Data loss | Lots | Some | Some | None | None |
| Failover | Down | Read only | Read/write | Read/write | Read/write |

Here is what each column means:

- **Backups** copy data to another place now and then. They are cheap, but you lose everything since the last backup.
- **[Master/slave](/learn/relational-databases#primary-replica-replication)** sends all writes to one main server, which copies them to the others in the background. It is fast, but when the main server dies, any writes it hadn't copied yet are lost.
- **[Multi-master](/learn/relational-databases#primary-primary-replication)** accepts writes in every data center. It needs a way to merge conflicting writes later.
- **Two-phase commit (2PC)** asks every server "are you ready?" and only commits if all of them say yes. It gives strong consistency, but it is "heavyweight, synchronous, high latency." Brewer's Spanner note adds that it has been called the "anti-availability" protocol, because every member must be up for it to work.
- **Paxos** commits a write once a majority of servers agree. It gives strong consistency and keeps working if a minority of servers fail, at the cost of latency. Barrett quotes Mike Burrows, author of Google's Chubby paper: there is "either Paxos, or Paxos with cruft, or broken."

The talk is still worth watching because the table still holds. Spanner combines the last two columns: Brewer notes that it makes each participant in a two-phase commit a Paxos group, so the protocol stays available when single servers fail. GitHub's 2018 outage shows the weak spot of the master/slave column in practice: writes that hadn't been copied yet when the primary moved. Barrett ends with "No silver bullet..." followed by "...but still worth doing!"

## Check yourself

<details>
<summary>A teammate says, "Our database is CA: we just don't allow partitions." What's wrong with that?</summary>

A system can't allow or forbid partitions. They are network failures, and they can happen whenever there is more than one machine. Robinson's CAP FAQ says there is no realistic CA system among distributed systems. The only true CA setup is a single machine, which has nothing to be cut off from. What the teammate probably means is one of two things. Either the database stops serving some requests during a partition (CP), or it keeps serving them with possibly stale data (AP). They should find out which one it is, and plan for it.

</details>

<details>
<summary>How is the C in CAP different from the C in ACID?</summary>

CAP's C is linearizability. The system acts as if there were only one copy of the data, and once any read sees a write, no later read sees an older value. It is about single operations on single items. ACID's C means each transaction leaves the database following its rules, such as unique keys or a balance that never goes negative. Brewer calls CAP's version "a strict subset of ACID consistency." A system can be linearizable and still let an application break its own rules.

</details>

<details>
<summary>During a partition, Pebble's West data center can't reach East. Describe a policy for Ben's withdrawals that isn't simply "refuse" or "allow".</summary>

Use a limited partition mode, like the ATM stand-in mode Brewer describes. West keeps accepting deposits and showing balances, marked as possibly out of date. It allows withdrawals up to a fixed limit, such as $200 per account, while the partition lasts. When the link returns, Pebble combines the operations from both sides. That works because deposits and withdrawals give the same total in any order. If an account ended up overdrawn, Pebble charges a fee or asks the customer to repay. The risk is capped at the withdrawal limit, and customers aren't locked out.

</details>

<details>
<summary>Why can a deleted item come back in a Dynamo shopping cart?</summary>

During a failure, different replicas can accept different changes to the same cart. When the versions conflict, Dynamo keeps all of them, and the shopping cart code merges them. The merge is designed so that an "add to cart" is never lost. So if an item was removed in one version but is still there in another, it survives the merge. Amazon accepted this because a cart that refuses changes costs more than an item that comes back.

</details>

<details>
<summary>Ben deposits money, refreshes, and the deposit has vanished. Refreshing again, it's back. Which guarantee is missing, and how would you add it cheaply?</summary>

Read-your-writes is missing, and probably monotonic reads as well. His reads are going to different replicas, and some of them haven't received the deposit yet. Two cheap fixes: for a short time after a user writes, send that user's reads to the primary, or always send each user's session to the same replica so their view never moves backward. Neither one needs strong consistency for every user.

</details>

<details>
<summary>A store has N = 5 replicas. Give two (R, W) settings that guarantee reads overlap the latest write, one tuned for fast writes and one for fast reads.</summary>

The overlap rule is R + W > N, so R + W must be at least 6. For fast writes, use W = 1 and R = 5: a write needs only one replica, but every read must ask all five. For fast reads, use W = 5 and R = 1. A balanced choice is W = 3 and R = 3, which keeps both reads and writes working even if two replicas are down. Remember Kleppmann's warning, though: the overlap rule alone isn't a safe guarantee of linearizability.

</details>

<details>
<summary>According to PACELC, which trade-off does Pebble face most often, and why?</summary>

Latency versus consistency. A partition between East and West might happen a few times a year, so the CAP choice rarely comes up. But if every write must be confirmed by the other data center before it succeeds, every customer pays for that cross-country round trip on every write, every day. Pebble might accept the extra latency for balances and transfers, and skip it for things like profile pictures and notification settings.

</details>

## Further reading

Short introductions (all were reachable when this chapter was written):

- [CAP Theorem: Revisited](https://robertgreiner.com/cap-theorem-revisited/): Robert Greiner's 2014 post, a short and clear explanation of why partition tolerance isn't optional. It revises his earlier post on CAP.
- [A plain English introduction to CAP theorem](http://ksat.me/a-plain-english-introduction-to-cap-theorem): Kaushik Sathupadi's story of "Remembrance Inc", a phone-in memory service run by a couple with two notebooks. It ends with a bonus section on eventual consistency. The page works over plain http. The https version currently shows a certificate error.
- [The CAP FAQ](https://github.com/henryr/cap-faq): Henry Robinson's 2013 question-and-answer guide. Read it for precise answers to "is my system CA?" and "can CAP be beaten?".
- [L16: The CAP Theorem](https://www.youtube.com/watch?v=k-Yaq8AHlFA): a seven-and-a-half-minute lecture from the Distributed Systems Course channel on YouTube. Its description points to Brewer's 2012 article and to Michael Whittaker's [illustrated proof of the CAP theorem](https://mwhittaker.github.io/blog/an_illustrated_proof_of_the_cap_theorem/).
- [Transactions Across Datacenters](https://snarfed.org/s/transactions_across_datacenters_io.html): Ryan Barrett's Google I/O 2009 slides, with the [video](https://www.youtube.com/watch?v=srOgpXECblk).

The papers behind the theorem:

- [Towards Robust Distributed Systems](https://people.eecs.berkeley.edu/~brewer/cs262b-2004/PODC-keynote.pdf): Brewer's PODC 2000 keynote slides, where CAP first reached a wide audience.
- [Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services](https://www.comp.nus.edu.sg/~gilbert/pubs/BrewersConjecture-SigAct.pdf): Gilbert and Lynch's 2002 proof. The first few pages are readable without a theory background.
- [CAP Twelve Years Later: How the "Rules" Have Changed](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/): Brewer's 2012 IEEE Computer article, republished by InfoQ. The best single follow-up to this chapter.
- [Consistency Tradeoffs in Modern Distributed Database System Design](https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf): Abadi's 2012 PACELC paper.
- [Please stop calling databases CP or AP](https://martin.kleppmann.com/2015/05/11/please-stop-calling-databases-cp-or-ap.html): Kleppmann's 2015 case for more precise language.

Real systems and incidents:

- [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf): the 2007 SOSP paper behind the always-writable shopping cart.
- [Eventually Consistent](https://www.allthingsdistributed.com/2008/12/eventually_consistent.html): Werner Vogels on the consistency guarantees a client can expect, and on quorums.
- [Spanner, TrueTime and the CAP Theorem](https://research.google/pubs/spanner-truetime-and-the-cap-theorem/): Brewer's 2017 note on why Spanner is technically CP and effectively CA.
- [October 21 post-incident analysis](https://github.blog/2018-10-30-oct21-post-incident-analysis/): GitHub's account of a 43-second partition and a day of recovery.
- [The network is reliable](https://aphyr.com/posts/288-the-network-is-reliable): Bailis and Kingsbury's survey of real network failures.
- [Understanding Network Failures in Data Centers](https://people.cs.umass.edu/~phillipa/papers/comm235-gill.pdf): Gill, Jain and Nagappan's SIGCOMM 2011 study of Microsoft's data center networks.
- [Amazon S3 update: strong read-after-write consistency](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/): the December 2020 announcement.
