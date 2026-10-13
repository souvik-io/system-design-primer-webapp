# Consensus, leader election and coordination

Many designs quietly assume that some decision is made exactly once: which database node is the primary, which worker owns a shard, who holds a lock, whether a config change happened. On one machine that's trivial. Across several machines that can crash and lose messages, getting a group to agree on one answer, and never later disagree about it, is the **consensus** problem.

You will rarely implement consensus yourself. You will use systems built on it: etcd, ZooKeeper, Consul, and the replication inside databases like CockroachDB and Spanner. Interviewers want to see that you know when you need it, what it costs, and how to use a coordination service safely.

## Why consensus is needed: split brain

The primer's [fail-over](/learn/availability-patterns#fail-over) section describes active-passive pairs: the passive node watches the active one's heartbeat and takes over when it stops. Now suppose the network between them fails, but both nodes are fine and clients can still reach both. The passive node sees no heartbeat and promotes itself. The old active node never crashed, so it keeps accepting writes. You now have two primaries. This is **split brain**.

Both sides now accept conflicting writes: the last concert seat is sold on each side. When the network heals, there is no clean way to merge the two histories, and some writes get thrown away or need manual repair.

The root problem is that a node can't tell "the other node is dead" from "I can't reach the other node". Timeouts can't distinguish them. So a node should never decide alone that it is the leader. It needs agreement from a group, arranged so that two competing nodes can't both get it.

## Quorums and majorities

The arrangement that makes this work is the **majority quorum**. With N voting nodes, a decision needs floor(N/2) + 1 of them. Any two majorities of the same group share at least one node, so two candidates can't both collect a majority for the same term, and a new leader always finds at least one node that knows what the old majority decided.

| Cluster size | Majority | Failures tolerated |
| --- | --- | --- |
| 1 | 1 | 0 |
| 2 | 2 | 0 |
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

Two lessons come from the table. A cluster of 2f + 1 nodes survives f failures. And even sizes don't help: 4 nodes tolerate the same single failure as 3, but need one more vote per write. That's why consensus clusters are almost always 3 or 5 nodes. More nodes add fault tolerance but make every write wait for more acknowledgments.

In a partition, the side holding a majority keeps working and the minority side stops accepting writes. That is the CP choice from the [CAP theorem](/learn/availability-vs-consistency#cap-theorem): the minority side gives up availability so the system never has two histories.

Quorums also set latency. A write commits when the leader hears back from enough followers to form a majority, so commit time is roughly the round trip to the follower that completes the majority. Assume a 5-node cluster spread across three regions as 2 + 2 + 1, with the leader in region A. Assume round trips of 1 ms to its peer in region A, 30 ms to both nodes in region B, and 70 ms to region C. The leader needs 2 follower acknowledgments (3 of 5 including itself): the region A peer at 1 ms and a region B node at 30 ms. Commits take about 30 ms plus disk writes, and losing all of region C doesn't change that.

## Raft, at the intuition level

**Raft** is the consensus algorithm behind etcd, Consul, CockroachDB and Kafka's KRaft mode, among others. Its authors designed it to be easier to understand than Paxos. It solves consensus by keeping a **replicated log**: every node holds the same sequence of commands, applies them in order to its own copy of a state machine (say, a key-value map), and so ends up in the same state.

### Terms and leader election

Time is divided into numbered **terms**. Each term starts with an election and has at most one leader. Every message carries the sender's term. A node that sees a higher term than its own updates its term and, if it was leader or candidate, steps down to follower.

Followers expect regular heartbeats from the leader. If a follower's **election timeout** passes without one, it becomes a candidate: it increments the term, votes for itself, and asks the others for votes. Each node votes for at most one candidate per term, and only for a candidate whose log is at least as up to date as its own. A candidate that collects a majority becomes leader. The timeouts are randomized (the Raft paper suggests something like 150 to 300 ms), so usually one node times out first and wins before others start competing.

The "up to date" rule is what keeps committed data safe: a committed entry is on a majority, a winner needs votes from a majority, so some voter has the entry and refuses any candidate missing it.

### Log replication and the commit index

Clients send writes to the leader. The leader appends the command to its log and sends it to followers. Once a majority of nodes (counting the leader) have stored the entry, it is **committed**: it will never be lost or replaced. The leader tracks the highest committed position as its **commit index**, applies committed entries to its state machine, replies to the client, and includes the commit index in later messages so followers apply the entries too.

One subtlety, in case an interviewer probes: a new leader only counts replicas this way for entries from its own term. Entries left over from earlier terms become committed indirectly, once an entry from the current term commits after them (section 5.4.2 of the Raft paper explains why).

```diagram
title: Entry 8 commits once 3 of 5 nodes have stored it
[c:client] Client @ 0,1.5
[L] Leader, term 4\nlog to entry 8 @ 1.5,1.5
[a] Follower A\nhas 8 @ 3.5,0
[b] Follower B\nhas 8 @ 3.5,1
[d] Follower C\nslow, has 6 @ 3.5,2
[e] Follower D\nunreachable @ 3.5,3
[n:note] Committed:\nleader + A + B\n= 3 of 5 @ 1.5,3
c -> L : write
L -> a : append 8
L -> b : append 8
L -> d : append 7, 8
L --> e : retrying
```

Each append message also names the position and term of the entry just before the new ones. A follower whose log doesn't match there rejects the message, and the leader steps back until they agree, then overwrites the follower's conflicting entries. That is how lagging followers, and leftovers from a failed leader, get repaired.

An old leader cut off in a minority partition can't commit anything. When it reconnects and sees a higher term, it steps down and its uncommitted entries are overwritten. Reads need care too, since a deposed leader answering from local state could return stale data. etcd's default reads confirm leadership with a majority first, and it offers cheaper "serializable" reads that may be stale.

### Paxos and FLP

**Paxos**, from Leslie Lamport, came first and underlies Google's Chubby and Spanner; Multi-Paxos gives the same guarantees as Raft, and ZooKeeper uses a related protocol called Zab. In an interview, "a Raft or Paxos group" is enough detail. The **FLP result** (Fischer, Lynch and Paterson, 1985) proves no deterministic algorithm can guarantee consensus terminates in a fully asynchronous network if even one node may crash, which is why real systems stay safe always but rely on timeouts to make progress.

## Leases and fencing tokens

A **lease** is a lock with an expiry. A node that holds a lease may act as leader (or owner of a resource) until the lease runs out, and must renew it to keep going. If the holder crashes, the lease expires and someone else can take over, without anyone needing to know whether the holder is dead or just unreachable.

Leases rely on time, and the holder can't fully control it. Suppose worker A holds a 30-second lease on shard 12 and sends a write to storage, but the write gets stuck: the host is overloaded, or the packet sits in a retry queue somewhere on the network. Forty seconds pass. A's lease expires, worker B takes over shard 12 and starts writing. Then A's delayed write finally arrives, and storage has no way to tell it's stale. Process pauses (garbage collection, a VM being migrated) cause the same problem from the other direction: the holder wakes up and acts on a lease it no longer has.

The fix is a **fencing token**: a number that increases every time the lock is granted. The client includes the token with every write, and the storage service remembers the highest token it has seen and rejects anything lower.

```diagram
title: The storage rejects a write carrying an older fencing token
[lock] Lock service @ 1,0
[c1] Worker A\ndelayed, token 117 @ 0,1
[c2] Worker B\ntoken 118 @ 2,1
[s:store] Storage\nhighest seen: 118 @ 1,2.3
lock -> c1 : grant 117
lock -> c2 : grant 118
c2 -> s : write, 118 OK
c1 -> s : write, 117 rejected
```

Fencing needs the resource to cooperate. A database can check a token in a conditional write (`UPDATE ... SET fence_token = 118, ... WHERE id = ? AND fence_token <= 118`). An external API that knows nothing about your tokens can't, and then the lock alone can't prevent overlapping writes. Coordination services provide suitable numbers: ZooKeeper's transaction IDs and znode versions, and etcd's revision numbers, both of which only increase.

## ZooKeeper and etcd in practice

**ZooKeeper** and **etcd** are small, strongly consistent stores replicated with consensus. Their job is to hold small amounts of critical metadata, typically kilobytes per key, not application data. A few features make them useful for coordination:

| Feature | ZooKeeper | etcd |
| --- | --- | --- |
| Data model | Tree of znodes, like a file system | Flat key space with range queries over prefixes |
| Tied to client liveness | Ephemeral znodes vanish when the client's session ends | Keys attached to a lease vanish when the lease expires |
| Change notification | Watches on znodes | Watch on keys or prefixes, from a given revision |
| Atomic updates | Conditional writes on znode version, multi-op | Transactions: compare, then put or delete |
| Ordering | Sequential znodes get increasing suffixes | Every change gets a global revision number |

These primitives combine into standard recipes:

- **Service discovery.** Each instance registers itself under a key tied to its session or lease. If it dies, the key disappears. Clients watch the prefix to keep an up-to-date list. This is the mechanism behind the primer's [service discovery](/learn/application-layer#service-discovery) section.
- **Configuration.** Store feature flags or settings under a key and have services watch it, so changes reach every instance within seconds and every instance sees changes in the same order.
- **Leader election.** In ZooKeeper, each candidate creates an ephemeral sequential znode under `/election`. The lowest number is leader. Every other candidate watches only the node just below its own, so a leader's death wakes one successor instead of the whole group. etcd's client library offers an election API built on leases and revisions.
- **Distributed locks.** The same pattern, with the lock released when the holder's node or lease goes away. Use the znode version or etcd revision as the fencing token.

Real systems use these heavily. Kubernetes stores all cluster state in etcd. HBase and HDFS high-availability rely on ZooKeeper for master election. Kafka relied on ZooKeeper for cluster metadata for years, then replaced it with its own Raft-based controller (KRaft), and Kafka 4.0 dropped ZooKeeper support entirely.

Two cautions. Sessions and leases take seconds to expire, so failover isn't instant and an old leader may not learn right away that it lost; fencing covers that gap. And ZooKeeper serves reads from whichever server a client is connected to, which may lag; call `sync` first when you need the latest value.

## When you don't need consensus

Consensus costs extra round trips on every write, a cluster you must operate, and unavailability on the minority side of a partition. Many problems don't need it:

- **Something you already use already does it.** A managed database with automatic failover runs its own leader election. You don't need a second one on top.
- **The data can merge.** Counters, sets of likes, shopping-cart additions and other commutative updates can be accepted on any replica and combined later, using CRDTs or application-level merges. This is the [eventual consistency](/learn/consistency-patterns#eventual-consistency) route, and it stays available during partitions.
- **Leaderless quorums are enough.** Dynamo-style stores accept reads and writes from any replica and choose read and write quorums so they overlap (R + W > N). They don't provide a linearizable compare-and-set, but for many workloads that's fine. See [designing a key-value store](/learn/design-key-value-store).
- **Duplicate work is harmless.** If a nightly cleanup job occasionally runs twice and the job is idempotent, a simple lock with an expiry in Redis is fine. Reserve consensus-backed locks with fencing for cases where two holders would corrupt data.
- **One owner per partition, assigned rarely.** Use a coordination service only to assign shards to owners, and keep the per-request path free of consensus.

When you do need it, use etcd, ZooKeeper, Consul or your database's built-in replication. Say in the interview which component provides consensus and what happens to your system when that component's minority side is cut off.

## Check yourself

<details>
<summary>Your team runs a 4-node etcd cluster "for extra safety". What would you suggest, and why?</summary>

A 4-node cluster needs 3 votes for a majority, so it tolerates only 1 failure, the same as 3 nodes, while every write waits for one more acknowledgment. Use 3 nodes, or 5 if you need to survive 2 failures. Placing the nodes in different availability zones matters more than adding a fourth node.

</details>

<details>
<summary>A Raft cluster of 5 nodes splits into a group of 2 (including the old leader) and a group of 3. What happens on each side, and what happens when the network heals?</summary>

The old leader can't reach a majority, so its new writes never commit and clients get errors or timeouts. In the group of 3, a follower times out, wins an election in a higher term, and keeps serving writes. When the network heals, the old leader sees the higher term, steps down, and its uncommitted entries are overwritten by the new leader's log.

</details>

<details>
<summary>A job scheduler uses a lock with a 30-second lease so only one instance runs a billing job that writes invoices to Postgres. Occasionally customers get two invoices. What's the likely cause and fix?</summary>

An instance probably paused or ran long past its lease, another instance took the lock, and the first one kept writing after waking up. Have the lock service issue a fencing token (an etcd revision or ZooKeeper version), store the highest token per billing run in Postgres, and make each write conditional on its token being the highest seen. Making invoice creation idempotent, for example with a unique key per customer and billing period, adds a second layer of protection.

</details>

<details>
<summary>Why does ZooKeeper's leader election recipe have each candidate watch only the node just before its own, rather than the current leader's node?</summary>

If every candidate watched the leader's node, its deletion would wake all of them at once, and they would all hit ZooKeeper to re-check the list. With N candidates that is N requests for one change, known as the herd effect. Watching only the predecessor means each change wakes exactly one candidate, which checks whether it is now the lowest.

</details>

<details>
<summary>A teammate wants to put a Raft cluster in front of a "likes" counter so the count is always exact. Is that a good idea?</summary>

Probably not. Every like would pay a consensus round trip, and during a partition the minority side couldn't accept likes at all. Likes are additions that can be merged later, so sharded counters or per-replica counts summed on read give an accurate total eventually, with much lower cost. Exactness to the second rarely matters for a like count.

</details>

## Further reading

- [Diego Ongaro and John Ousterhout, "In Search of an Understandable Consensus Algorithm"](https://raft.github.io/raft.pdf): the Raft paper. Readable in an evening.
- [The Raft consensus algorithm](https://raft.github.io/): an interactive visualization of elections and replication.
- [Leslie Lamport, "Paxos Made Simple"](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf).
- [Martin Kleppmann, "How to do distributed locking"](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html): leases, process pauses and fencing tokens.
- [ZooKeeper recipes and solutions](https://zookeeper.apache.org/doc/current/recipes.html): the official leader election, lock and barrier recipes.
- [etcd documentation](https://etcd.io/docs/): leases, watches, transactions and the concurrency API.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design a key-value store".
