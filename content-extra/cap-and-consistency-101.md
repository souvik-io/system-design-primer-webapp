# CAP and consistency 101

The primer covers this ground in two short chapters. [Availability vs consistency](/learn/availability-vs-consistency) states the CAP theorem in a few lines and points to four outside sources: Robert Greiner's blog post [CAP Theorem: Revisited](https://robertgreiner.com/cap-theorem-revisited/) (2014), Kaushik Sathupadi's [A plain English introduction to CAP theorem](http://ksat.me/a-plain-english-introduction-to-cap-theorem), Henry Robinson's [CAP FAQ](https://github.com/henryr/cap-faq) (2013) and a short [video lecture on the CAP theorem](https://www.youtube.com/watch?v=k-Yaq8AHlFA). [Consistency patterns](/learn/consistency-patterns) then lists weak, eventual and strong consistency, drawn from Ryan Barrett's 2009 Google I/O talk [Transactions Across Datacenters](https://snarfed.org/s/transactions_across_datacenters_io.html).

All of those are short and still worth reading. This chapter fills in what they leave out: what the three letters mean precisely, where the theorem came from, why "pick two of three" misleads, how often networks actually split, and how Amazon, Google and GitHub made the trade-off in real systems. It also covers PACELC, the guarantees a single user can count on, and quorums. Every number below links to its source.

We'll follow one imaginary product throughout. **Pebble** is a small online bank. Asha and Ben share a joint account with $500 in it. Pebble runs in two data centers, East and West, and keeps a copy of every balance in both so either can serve customers if the other goes down. Asha's requests usually go to East and Ben's to West.

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

As long as East and West can talk to each other, keeping the two copies in step is plumbing. When Asha withdraws $100 in East, East tells West, and both copies say $400.

Now cut the link between them. A fiber gets dug up, a switch reboots, or a configuration push goes wrong. Both data centers are running and both can reach their customers, but neither can reach the other. Ben asks West for his balance and then tries to withdraw $400. West has two choices:

1. **Refuse or wait.** West can't confirm the balance with East, so it returns an error or holds the request until the link is back. Ben is unhappy, but nobody sees a wrong number.
2. **Answer anyway.** West uses its own copy, which says $500, and lets Ben withdraw. If Asha withdraws $400 in East at the same moment, the account is $300 overdrawn once the link comes back.

No option gives Ben an up-to-date answer, because the only data center that knows about Asha's withdrawal can't send it. That forced choice is the CAP theorem. The rest of this chapter states it carefully and looks at how real systems live with it.

## What C, A and P actually mean

The primer gives the usual informal definitions. The formal ones come from Seth Gilbert and Nancy Lynch's [2002 proof](https://www.comp.nus.edu.sg/~gilbert/pubs/BrewersConjecture-SigAct.pdf), and they're narrower than most people assume.

**Consistency** means the system behaves as if there were a single copy of the data. Gilbert and Lynch call it atomic or linearizable consistency: there must be a single order of all operations in which "each operation looks as if it were completed at a single instant". Once any reader has seen Asha's withdrawal, no later reader anywhere may see the old $500. Martin Kleppmann puts it bluntly in [Please stop calling databases CP or AP](https://martin.kleppmann.com/2015/05/11/please-stop-calling-databases-cp-or-ap.html): consistency in CAP "actually means linearizability, which is a very specific (and very strong) notion of consistency."

This is a different C from the one in ACID. Gilbert and Lynch point out in a footnote that ACID consistency is about transactions, while theirs is a property of single request and response operations. Eric Brewer, who proposed CAP, says the same in [CAP Twelve Years Later](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/): in ACID, C means a transaction keeps the database's rules, such as unique keys, while "the C in CAP refers only to single-copy consistency, a strict subset of ACID consistency." Pebble's rule that a balance never goes below zero is an ACID-style invariant, and CAP says nothing about it.

**Availability** in the proof is also strict: "every request received by a non-failing node in the system must result in a response." Every working node has to answer, including the ones cut off from the rest. A system where only the majority side keeps serving isn't available in this sense, even if most customers never notice.

**Partition tolerance** means the system keeps meeting its guarantees even when the network loses messages. In the proof, the network may "lose arbitrarily many messages sent from one node to another." A slow link and a dead fiber look the same from inside: a message you were waiting for hasn't arrived. Brewer's 2012 article draws the practical conclusion that "a partition is a time bound on communication". If a node can't reach the other side within the time it's willing to wait, it has to choose between C and A for that request.

Greiner's post uses looser wording, such as availability meaning "a reasonable response within a reasonable amount of time". That's fine for design discussions, but it isn't what the theorem proves.

## Where the theorem came from

Brewer was a Berkeley professor and co-founder of Inktomi, which built search engines and web caches on clusters. He writes in the 2012 article that the idea "first appeared in fall 1998" and was published in 1999. It reached a wide audience in his keynote at the ACM Symposium on Principles of Distributed Computing (PODC) on July 19, 2000, titled [Towards Robust Distributed Systems](https://people.eecs.berkeley.edu/~brewer/cs262b-2004/PODC-keynote.pdf). The slide reads: "Theorem: You can have at most two of these properties for any shared-data system." At that point it was a conjecture drawn from building real systems. The same talk framed the wider trade-off as ACID versus BASE (basically available, soft state, eventually consistent).

Two years later, Gilbert and Lynch, both at MIT, turned it into a proof in "Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services", published in ACM SIGACT News in 2002. Their Theorem 1 says that in an asynchronous network, where there are no clocks and messages can be lost, no read/write data object can guarantee both availability and atomic consistency. The proof is the Pebble story with the names removed: split the nodes into two groups, drop every message between them, write on one side, read on the other. If both sides must answer, the read can't see the write.

## Why "pick two of three" misleads

The primer states CAP as "you can only support two of the following guarantees", which is how it's usually taught. Brewer himself wrote in 2012 that "the '2 of 3' formulation was always misleading because it tended to oversimplify the tensions among properties."

The first problem is that you can't choose to give up P. A partition is something the network does to you, as Greiner puts it: "Network failures happen to your system and you don't get to choose when they occur." Robinson's FAQ rewrites the theorem as "Possibility of Partitions => Not (C and A)" and says there is "no realistic CA system" among distributed systems. A single database on a single machine can be consistent and available because it has nothing to be partitioned from. Once Pebble has two data centers, it has already accepted P. What's left to decide is what happens during a partition, which is the choice between C and A.

The second problem is that the choice only applies while a partition is happening. Brewer: "because partitions are rare, there is little reason to forfeit C or A when the system is not partitioned." Pebble can be fully consistent and fully available on every normal day.

The third problem is that the choice doesn't have to be one setting for the whole system. Brewer notes that it "can occur many times within the same system at very fine granularity". It can differ by operation, by data, even by user. His own example is a bank. ATMs look like they need strong consistency, "but in practice, A trumps C" because availability means revenue. During a partition, an ATM switches to what Brewer calls stand-in mode, which limits net withdrawals to some amount k, "where k might be $200". Deposits and balance checks keep working. When the network recovers, the bank reconciles, and if an account went below zero it charges a fee. In his words, the banking system "depends not on consistency for correctness, but rather on auditing and compensation."

That gives Pebble a better answer than refusing everything or allowing everything. During a partition, West accepts deposits, shows balances marked "may be out of date", and lets Ben withdraw up to $200. The worst case is a bounded overdraft that the bank can fix afterward. Brewer recommends this as a general approach: detect the partition, enter an explicit partition mode that limits some operations, and run a recovery process when the link returns.

Kleppmann adds that under the strict definitions, many real databases are neither CP nor AP. A single-leader database with asynchronous replicas isn't CAP-available, because clients cut off from the leader can't write, and it isn't CAP-consistent, because replicas serve stale reads. He suggests describing systems by the specific guarantees they offer. The primer's [CP](/learn/availability-vs-consistency#cp---consistency-and-partition-tolerance) and [AP](/learn/availability-vs-consistency#ap---availability-and-partition-tolerance) labels are best read as describing what a system does during a partition.

## Partitions really happen

Phillipa Gill, Navendu Jain and Nachiappan Nagappan studied more than a year of network logs from tens of Microsoft data centers in [Understanding Network Failures in Data Centers](https://people.cs.umass.edu/~phillipa/papers/comm235-gill.pdf) (SIGCOMM 2011). They counted a mean of 5.2 device failures and 40.8 link failures per day. Redundant network paths helped less than you might hope: they found that "network redundancy is only 40% effective in reducing the median impact of failure."

Peter Bailis and Kyle Kingsbury collected dozens of real incidents in [The network is reliable](https://aphyr.com/posts/288-the-network-is-reliable) (2013), later published in Communications of the ACM in 2014. Two examples from it:

- Google's paper on Chubby, its lock service, reported 61 outages over 700 days of operation. Of the nine that lasted more than 30 seconds, four were caused by network maintenance and two by suspected network connectivity problems.
- On December 22, 2012, a switch software update at GitHub led to a 90-second partition. Pairs of file servers each decided the other was dead, and both ended up shut down. Recovering them took five hours, with GitHub significantly degraded.

Even Google, with its own global network, sees them. In [Spanner, TrueTime and the CAP Theorem](https://research.google/pubs/spanner-truetime-and-the-cap-theorem/) (2017), Brewer reports that network problems caused under 8% of Spanner's internal incidents, and that "we did see individual data centers or regions get cut off from the rest of the network."

## CP and AP choices in real systems

### Amazon's shopping cart: stay writable, merge later

Amazon's [Dynamo paper](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf), presented at SOSP in 2007, describes a key-value store built to always accept writes. The motivating example is the shopping cart: "customers should be able to view and add items to their shopping cart even if disks are failing, network routes are flapping, or data centers are being destroyed by tornados."

To do that, Dynamo lets different replicas accept writes during a failure and keeps the conflicting versions, using vector clocks to tell which version came from which. When a read finds versions that conflict, the cart application merges them. The paper is candid about the cost: "an 'add to cart' operation is never lost. However, deleted items can resurface." If you removed a book on one side of a partition and the other side still had it, the merged cart has the book again.

The paper opens by noting that at Amazon "even the slightest outage has significant financial consequences". A reappearing item is a small annoyance by comparison, so for carts Amazon chose AP on purpose.

### Google Spanner: consistent, and available enough

Spanner, described in Google's [OSDI 2012 paper](https://research.google/pubs/spanner-googles-globally-distributed-database-2/), is a globally replicated SQL database with strong consistency. Brewer's 2017 note asks whether it beats CAP. His answer: technically it's a CP system, because "during (some) partitions, Spanner chooses C and forfeits A." Updates go through Paxos groups, and if a leader can't reach a majority, its updates stall.

He argues it is "effectively CA" anyway, because its availability, better than five nines internally, is high enough that users treat it as always up. The reason is mostly Google's network: Spanner traffic stays on Google's own links, each data center typically has at least three independent fibers, and a Spanner quorum was never on the minority side of a partition. TrueTime, Google's clock service, often gets the credit, but Brewer writes that it "does not significantly help achieve CA". TrueTime returns a time interval guaranteed to contain the real time, which gives Spanner its external consistency, a guarantee Brewer describes as similar to linearizability.

### GitHub, October 2018: a partition makes the choice for you

GitHub's [post-incident analysis](https://github.blog/2018-10-30-oct21-post-incident-analysis/) shows what happens when a system takes one side without meaning to.

At 22:52 UTC on October 21, 2018, maintenance to replace failing 100G optical equipment cut the link between GitHub's US East Coast network hub and its primary East Coast data center. "Connectivity between these locations was restored in 43 seconds." In that window, Orchestrator, which manages GitHub's MySQL topology, formed a quorum without the primary data center and began failing database clusters over to the West Coast. When the link came back, applications wrote to the West. A few seconds of writes had landed in the East and never replicated out. "The database clusters in both data centers now contained writes that were not present in the other data center."

GitHub couldn't safely fail back to the East. Staying on the West meant a cross-country round trip for most database calls, which would make the site unusable for many users. They chose to "prioritize data integrity over site usability and time to recovery", restored data from backups, and began reconciling the stray writes by hand (954 of them on one of the busiest clusters). The degradation lasted 24 hours and 11 minutes, and more than five million webhook events and 80,000 Pages builds queued up along the way.

GitHub ended up making a CP choice, made during the incident and at a high price. Brewer's advice to plan an explicit partition mode is about making that decision ahead of time.

## PACELC: the trade-off when nothing is broken

CAP only says something about periods when the network is partitioned. Daniel Abadi argued in [Consistency Tradeoffs in Modern Distributed Database System Design](https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf) (IEEE Computer, February 2012) that a different trade-off shapes databases more, because it applies all the time: consistency against latency.

On a normal day, if East waits for West to confirm Asha's withdrawal before telling her it succeeded, every write pays a cross-region round trip. If East replies at once and replicates in the background, West may briefly show the old balance.

Abadi's name for the full picture is PACELC, pronounced "pass-elk": "if there is a partition (P), how does the system trade off availability and consistency (A and C); else (E), when the system is running normally in the absence of partitions, how does the system trade off latency (L) and consistency (C)?" In his classification, Dynamo, Cassandra and Riak are PA/EL: they give up consistency in both cases. Fully ACID systems such as VoltDB/H-Store and Megastore are PC/EC, and so are BigTable and HBase: they pay in availability and latency to keep consistency. He classifies MongoDB as PA/EC.

## The consistency spectrum

The [consistency patterns](/learn/consistency-patterns) chapter describes three levels, taken from Barrett's talk.

**[Weak consistency](/learn/consistency-patterns#weak-consistency):** after a write, reads may or may not see it. Barrett's slide calls it "best effort only" and gives VoIP, live video and real-time multiplayer games as examples. The primer adds memcached: a [cache](/learn/cache) entry can be evicted or stale at any time. Pebble might accept this for a "recently viewed" list, never for balances.

**[Eventual consistency](/learn/consistency-patterns#eventual-consistency):** after a write, reads will see it eventually, with no promise about when. Werner Vogels of Amazon, in [Eventually Consistent](https://www.allthingsdistributed.com/2008/12/eventually_consistent.html) (revised for ACM Queue in 2008), defines it as a guarantee "that if no new updates are made to the object, eventually all accesses will return the last updated value", and gives DNS as the classic example. The time between the write and the moment every reader sees it is the inconsistency window. Barrett's table puts asynchronous [master-slave replication](/learn/database#master-slave-replication) here, and the primer notes that most [NoSQL](/learn/database#nosql) stores favor it.

**[Strong consistency](/learn/consistency-patterns#strong-consistency):** after a write, reads will see it. Barrett's examples are file systems and relational databases. Data is replicated synchronously, so writes are slower and some partitions make data unavailable. Pebble's balances belong here, with Brewer's bounded stand-in mode for partitions.

## Guarantees for one user

Plain eventual consistency lets odd things happen to one user. Ben deposits $50, refreshes, and the deposit is gone because the read hit a replica that hadn't caught up. He refreshes again and it's back.

Vogels's article names guarantees that fix this without strong consistency everywhere:

- **Read-your-writes.** A process that has updated an item "always accesses the updated value and will never see an older value." Ben always sees his own deposit.
- **Session consistency.** Read-your-writes for as long as a session lasts.
- **Monotonic reads.** Once a process has seen a value, "any subsequent accesses will never return any previous values." Ben's balance never jumps backward.
- **Causal consistency.** If Asha tells Ben she's made a transfer, and Ben then reads, he sees the transfer.

These cost far less than global strong consistency. Read-your-writes can be as simple as sending a user's reads to the primary for a few seconds after that user writes, a fix that also appears in [Scalability 101](/learn/scalability-101#database-replication). Monotonic reads can be had by pinning each user to one replica.

Systems do move along the spectrum. Amazon S3 was eventually consistent for years: after a write, there was a short window when the new data was "not yet visible to all GET or LIST requests". On December 1, 2020, AWS [announced](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/) that all S3 GET, PUT and LIST operations were now strongly consistent, for existing and new objects in all regions, at no extra charge and, according to AWS, with no impact on performance.

## Quorums: N, R and W

Dynamo-style systems let you choose your place on the spectrum with three numbers. **N** is how many replicas store each item, **W** is how many must confirm a write before it counts as done, and **R** is how many are asked on each read.

Vogels gives the rule: "If W+R > N, then the write set and the read set always overlap and one can guarantee strong consistency." With N = 3, W = 2 and R = 2, any two replicas you read from must include at least one that took the latest write. With W + R ≤ N, a read might hit only replicas that missed the write, and you get eventual consistency. The Dynamo paper reports that the common configuration across several Dynamo instances was (3,2,2).

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

The numbers also set availability. With W = 2, a write fails if two of the three replicas are unreachable. With W = 1, writes almost always succeed, but reads can miss them. Kleppmann adds two cautions. During a partition, clients on the minority side can't reach a quorum, so quorum reads and writes aren't CAP-available there. And he thinks it unwise to rely on quorums for linearizability, because features such as sloppy quorums and read repair create edge cases where deleted data comes back. The quorum rule is a good first approximation, and the [database](/learn/database) chapter covers the replication setups it applies to.

## What Barrett's talk adds

The primer's only source for consistency patterns is Ryan Barrett's [Transactions Across Datacenters (and other weekend projects)](https://snarfed.org/s/transactions_across_datacenters_io.html), given at Google I/O in 2009, with Google App Engine's datastore as the case study. The page linked from the primer is his slide deck, and the [video](https://www.youtube.com/watch?v=srOgpXECblk) runs about an hour.

The weak, eventual and strong levels come from his opening slides. The core of the talk compares five ways to keep data in more than one data center, summarized in one table:

| | Backups | Master/slave | Multi-master | 2PC | Paxos |
|---|---|---|---|---|---|
| Consistency | Weak | Eventual | Eventual | Strong | Strong |
| Latency | Low | Low | Low | High | High |
| Throughput | High | High | High | Low | Medium |
| Data loss | Lots | Some | Some | None | None |
| Failover | Down | Read only | Read/write | Read/write | Read/write |

Backups are cheap and lose data. [Master-slave](/learn/database#master-slave-replication) replication is fast and loses the writes that hadn't replicated when the master died. [Multi-master](/learn/database#master-master-replication) accepts writes everywhere and needs a way to merge them. Two-phase commit gives strong consistency but is "heavyweight, synchronous, high latency". Brewer's Spanner note adds that it has been called the "anti-availability" protocol, because all members must be up for it to work. Paxos gets strong consistency from majority writes and survives a minority of failures, at the cost of latency. Barrett quotes Mike Burrows, author of Google's Chubby paper: there is "either Paxos, or Paxos with cruft, or broken."

The talk is still worth watching because that table still holds. Spanner combines the last two columns: Brewer notes it makes each two-phase commit participant a Paxos group so the protocol stays available. GitHub's 2018 outage shows the master/slave column's weak spot in practice: writes that hadn't replicated when the primary moved. Barrett ends with "No silver bullet..." followed by "...but still worth doing!"

## Check yourself

<details>
<summary>A teammate says, "Our database is CA: we just don't allow partitions." What's wrong with that?</summary>

Partitions aren't something a system allows or forbids. They're network failures that happen whenever there's more than one machine. Robinson's CAP FAQ says there is no realistic CA system among distributed systems. The only true CA setup is a single machine with nothing to be cut off from. What the teammate probably means is that during a partition the database stops serving some requests (CP), or keeps serving them with possibly stale data (AP). They should find out which one, and plan for it.

</details>

<details>
<summary>How is the C in CAP different from the C in ACID?</summary>

CAP's C is linearizability: the system acts as if there were one copy of the data, and once any read sees a write, no later read sees an older value. It's about single operations on single items. ACID's C means each transaction leaves the database obeying its rules, such as unique keys or a balance that never goes negative. Brewer calls CAP's version "a strict subset of ACID consistency." A system can be linearizable and still let an application break its own invariants.

</details>

<details>
<summary>During a partition, Pebble's West data center can't reach East. Describe a policy for Ben's withdrawals that isn't simply "refuse" or "allow".</summary>

Use a bounded partition mode, like the ATM stand-in mode Brewer describes. West keeps accepting deposits and showing balances (marked as possibly stale), and allows withdrawals up to a fixed limit such as $200 per account while the partition lasts. When the link returns, Pebble merges the two sides' operations, which works because deposits and withdrawals commute, and compensates for any overdraft with a fee or a request to repay. The risk is limited to the withdrawal cap, and customers aren't locked out.

</details>

<details>
<summary>Why can a deleted item come back in a Dynamo shopping cart?</summary>

During a failure, different replicas can accept different updates to the same cart. When the versions conflict, Dynamo keeps them and the cart application merges them. The merge is designed so that an "add to cart" is never lost, so if an item was removed in one version but is still present in another, it survives the merge. Amazon accepted this because a cart that refuses changes costs more than an item that comes back.

</details>

<details>
<summary>Ben deposits money, refreshes, and the deposit has vanished. Refreshing again, it's back. Which guarantee is missing, and how would you add it cheaply?</summary>

Read-your-writes, and probably monotonic reads as well. His reads are going to different replicas, some of which haven't received the deposit. Cheap fixes: for a short time after a user writes, send that user's reads to the primary, or pin each user's session to one replica so they never move backward. Neither needs strong consistency for every user.

</details>

<details>
<summary>A store has N = 5 replicas. Give two (R, W) settings that guarantee reads overlap the latest write, one tuned for fast writes and one for fast reads.</summary>

The overlap rule is R + W > N, so R + W must be at least 6. For fast writes, use W = 1 and R = 5: a write needs only one replica, but every read must ask all five. For fast reads, use W = 5 and R = 1. A balanced choice is W = 3, R = 3, which also survives two replicas being down for both reads and writes. Keep in mind that, as Kleppmann warns, the overlap rule alone isn't a safe guarantee of linearizability.

</details>

<details>
<summary>According to PACELC, which trade-off does Pebble face most often, and why?</summary>

Latency against consistency. A partition between East and West might happen a few times a year, so the CAP choice applies rarely. But if every write has to be confirmed by the other data center before it succeeds, every customer pays that cross-region round trip on every write, every day. Pebble might accept the latency for balances and transfers, and skip it for things like profile pictures and notification settings.

</details>

## Further reading

The originals this chapter is a companion to (all were reachable when this chapter was written):

- [CAP Theorem: Revisited](https://robertgreiner.com/cap-theorem-revisited/): Robert Greiner's 2014 post, a short and clear statement of why partition tolerance isn't optional. It revises his earlier post on CAP, and it's the source of the primer's CAP diagram.
- [A plain English introduction to CAP theorem](http://ksat.me/a-plain-english-introduction-to-cap-theorem): Kaushik Sathupadi's story of "Remembrance Inc", a phone-in memory service run by a couple with two notebooks. It ends with a bonus section on eventual consistency. The page works over plain http; the https version currently shows a certificate error.
- [The CAP FAQ](https://github.com/henryr/cap-faq): Henry Robinson's 2013 question-and-answer guide. Read it for precise answers to "is my system CA?" and "can CAP be beaten?".
- [L16: The CAP Theorem](https://www.youtube.com/watch?v=k-Yaq8AHlFA): a seven-and-a-half-minute lecture from the Distributed Systems Course channel on YouTube. Its description points to Brewer's 2012 article and to Michael Whittaker's [illustrated proof of the CAP theorem](https://mwhittaker.github.io/blog/an_illustrated_proof_of_the_cap_theorem/).
- [Transactions Across Datacenters](https://snarfed.org/s/transactions_across_datacenters_io.html): Ryan Barrett's Google I/O 2009 slides, with the [video](https://www.youtube.com/watch?v=srOgpXECblk). The primer's link (snarfed.org/transactions_across_datacenters_io.html) redirects here.

The papers behind the theorem:

- [Towards Robust Distributed Systems](https://people.eecs.berkeley.edu/~brewer/cs262b-2004/PODC-keynote.pdf): Brewer's PODC 2000 keynote slides, where CAP first reached a wide audience.
- [Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services](https://www.comp.nus.edu.sg/~gilbert/pubs/BrewersConjecture-SigAct.pdf): Gilbert and Lynch's 2002 proof. The first few pages are readable without a theory background.
- [CAP Twelve Years Later: How the "Rules" Have Changed](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/): Brewer's 2012 IEEE Computer article, republished by InfoQ. The best single follow-up to this chapter.
- [Consistency Tradeoffs in Modern Distributed Database System Design](https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf): Abadi's 2012 PACELC paper.
- [Please stop calling databases CP or AP](https://martin.kleppmann.com/2015/05/11/please-stop-calling-databases-cp-or-ap.html): Kleppmann's 2015 case for more precise language.

Real systems and incidents:

- [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf): the 2007 SOSP paper behind the always-writable shopping cart.
- [Eventually Consistent](https://www.allthingsdistributed.com/2008/12/eventually_consistent.html): Werner Vogels on client-side consistency models and quorums.
- [Spanner, TrueTime and the CAP Theorem](https://research.google/pubs/spanner-truetime-and-the-cap-theorem/): Brewer's 2017 note on why Spanner is technically CP and effectively CA.
- [October 21 post-incident analysis](https://github.blog/2018-10-30-oct21-post-incident-analysis/): GitHub's account of a 43-second partition and a day of recovery.
- [The network is reliable](https://aphyr.com/posts/288-the-network-is-reliable): Bailis and Kingsbury's survey of real network failures.
- [Understanding Network Failures in Data Centers](https://people.cs.umass.edu/~phillipa/papers/comm235-gill.pdf): Gill, Jain and Nagappan's SIGCOMM 2011 study of Microsoft's data center networks.
- [Amazon S3 update: strong read-after-write consistency](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/): the December 2020 announcement.
