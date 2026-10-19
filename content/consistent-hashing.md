# Consistent hashing

Once data or cache entries are spread across several machines, every request has to answer one question: which machine holds this key? The obvious answer, hashing the key and taking the result modulo the number of machines, works until the number of machines changes. Then almost every key moves at once. Consistent hashing is a family of techniques that keeps most keys where they are when machines join or leave.

It comes up in interviews whenever you [shard](/learn/relational-databases#sharding-splitting-one-table-across-databases) a database, partition a distributed cache, or design something like a [key-value store](/learn/design-key-value-store). It also routes requests in the [query cache design](/learn/design-query-cache#step-4-scale-the-design), and it cuts the data that has to move when shards are added. This chapter covers how it works and where it falls short.

## The problem with hash mod N

With N servers, the simple scheme is `server = hash(key) mod N`. A good hash spreads keys evenly and the lookup is a single division.

Now add a server. A key stays put only if `hash(key) mod N` equals `hash(key) mod (N+1)`, and for a uniform hash that happens for only about 1 in N+1 keys. Going from 4 servers to 5, about 20% of keys stay where they were and **80% move**. Going from 10 to 11, about 91% move. Removing a server, or having one crash, is just as bad.

Ideally, adding a fifth server would move only the fifth of keys that the new server should now own, and nothing else.

What all that movement costs depends on what you're storing:

- **For a cache,** moved keys become misses. If most of the cache misses at once, the load falls through to the database, which was sized assuming a high hit rate. Resizing the cache can take down the database behind it.
- **For a datastore,** moved keys mean copying data between machines. Moving 80% of a large dataset takes hours and saturates the network while it runs.

## The ring

Consistent hashing, introduced by Karger and colleagues in 1997 for web caching (work that led to Akamai), hashes servers and keys into the same space. Picture the hash range bent into a circle. Each server sits at the position given by hashing its name, and a key belongs to the **first server clockwise** from the key's position.

A small example makes it concrete. Use a toy ring numbered 0 to 99 (real rings use 0 to 2^64 − 1) and three servers that hash to positions 10, 45 and 80:

| Server | Position | Owns positions |
|---|---|---|
| North | 10 | 81–99 and 0–10 (wrapping past the top) |
| East | 45 | 11–45 |
| West | 80 | 46–80 |

```diagram
title: A toy ring from 0 to 99. Each key goes to the first server clockwise.
[n] North at 10 @ 1,0
[e] East at 45 @ 2,1.5
[w] West at 80 @ 0,1.5
[k93:note] key at 93 @ 0,0
[k22:note] key at 22 @ 2,0
[k61:note] key at 61 @ 1,2.5
n -> e
e -> w
w -> n
k93 -> n
k22 -> e
k61 -> w
```

So a key hashing to 22 lives on East, 61 on West, and 93 wraps around to North. Now see what a change costs:

- **Add a server, South, at position 30.** South takes positions 11–30, which used to belong to East. North and West don't notice. About 20% of the ring moved, all of it from one server.
- **Remove West.** Its range, 46–80, passes to the next server clockwise, North. East doesn't notice.

On average, adding or removing one of N servers moves about 1/N of the keys, which is the minimum possible.

The lookup is cheap. Keep the server positions in a sorted array, binary-search for the first position greater than the key's hash, and wrap to the start if you run off the end. That's O(log N), and the array is small enough to keep on every client.

The plain ring has two problems:

- **Uneven arcs.** Random positions don't divide a circle evenly. In the toy ring, North owns 30 positions and West 35, which is close to fair only by luck. With 10 servers and one position each, the server with the largest arc owns about 29% of the ring on average, nearly three times its fair share of 10%.
- **Load dumps onto one neighbor.** When West failed above, North's share jumped from 30% to 65% of the ring, while East's stayed the same. The neighbor may then overload too.

## Virtual nodes

The fix for both problems is to give each physical server many positions on the ring, called **virtual nodes** or tokens. Hash `"A#0"`, `"A#1"`, … `"A#99"` instead of just `"A"`, and every one of those positions points back to server A.

- **Balance improves** with more positions. The spread between servers shrinks roughly as 1/√V for V virtual nodes each. In a quick simulation of 10 servers, one position each gave a standard deviation of about 86% of the fair share; 100 positions gave about 9%; 1,000 gave about 3%.
- **Failure spreads.** A failed server's 100 small ranges go to many different successors, so no single neighbor takes the whole load.
- **Unequal hardware is easy.** Give a machine with twice the memory twice the virtual nodes. Memcached's libketama client does this, placing 160 points per server, scaled by each server's weight.

```widget
hash-ring
```

Here is the whole idea in Python, including the replica walk explained in the next section:

```python
import bisect, hashlib

def h(s: str) -> int:
    return int.from_bytes(hashlib.md5(s.encode()).digest()[:8], "big")

class Ring:
    def __init__(self, nodes, vnodes=100):
        self.points = sorted((h(f"{n}#{i}"), n) for n in nodes for i in range(vnodes))
        self.hashes = [p for p, _ in self.points]

    def owners(self, key: str, replicas: int = 1) -> list[str]:
        start = bisect.bisect_right(self.hashes, h(key))  # first point clockwise
        found = []
        for j in range(len(self.points)):                 # walk on, wrapping around
            node = self.points[(start + j) % len(self.points)][1]
            if node not in found:                         # skip a node's other vnodes
                found.append(node)
                if len(found) == replicas:
                    break
        return found
```

Virtual nodes have costs too. The ring table grows to N × V entries, and every virtual node is a separate range to stream, repair and track. Cassandra used 256 tokens per node by default for years; version 4.0 lowered the default to 16 and paired it with an allocation algorithm that picks token positions for balance instead of at random, because hundreds of tokens per node made repair and streaming slower. The Dynamo paper describes a similar journey: Amazon moved from random tokens to splitting the ring into a fixed number of equal partitions and handing those out to nodes, which made balance predictable and data easier to move.

## Replication along the ring

The ring also tells you where to put copies. To store three copies of a key, start at the key's position and walk clockwise, taking the first three **distinct physical servers** you meet. Dynamo calls this list the key's **preference list**.

The word "distinct" matters. With virtual nodes, the next few positions clockwise might all belong to the same machine, and three copies on one machine protect against nothing. The walk skips positions whose physical server is already in the list, which is what the `if node not in found` line above does. Real systems go further and spread replicas across racks or data centers; Cassandra's `NetworkTopologyStrategy` does this.

Replication along the ring pairs naturally with quorum reads and writes (read and write quorums that overlap), with read repair, and with Dynamo-style **hinted handoff**, where a write meant for a down replica is held by the next server on the ring until the replica returns. Those belong to [replication](/learn/availability#replication) and [consistency](/learn/cap-and-consistency#the-consistency-spectrum) more than to hashing; [design a key-value store](/learn/design-key-value-store) puts them together.

## Hot keys

Consistent hashing balances **keys**, not **load**. If one key gets a hundred times more traffic than the rest, such as a celebrity's profile or a flash-sale product, it lands on one server no matter how many virtual nodes you add. More nodes don't help either, because the hot key still maps to exactly one place.

Common fixes, each with a cost:

- **Cache hot reads closer to the caller.** A small in-process cache on each application server absorbs the hottest reads before they reach the shared tier. The cost is staleness for as long as the local entry lives.
- **Read from any replica.** If the key is already stored on several servers, spread its reads across all of them instead of always hitting the first. That works for read-heavy hot keys, but it only spreads load as many ways as there are replicas.
- **Split the key.** Write to `counter:42#0` through `counter:42#9`, which hash to different servers, and sum them on read. This suits counters and append-only data. Reads get more expensive, and you need to know in advance which keys are hot.
- **Bound the load.** "Consistent hashing with bounded loads" (Mirrokni, Thorup and Zadimoghaddam, 2016) caps each server at a set factor above the average load. When the owner is full, a request moves on to the next server clockwise. HAProxy supports this through its `hash-balance-factor` setting. It suits load balancing, where any server can handle any request but you'd prefer the one with a warm cache.

## Alternatives and a comparison

The ring isn't the only way to get minimal movement.

**Rendezvous hashing**, also called highest random weight hashing (Thaler and Ravishankar, 1996), skips the ring. For each key, compute `hash(key, server)` for every server and pick the server with the highest score. Removing a server only moves the keys for which it scored highest. Balance is good without virtual nodes, and taking the top few scores gives you replica placement for free. The catch is that every lookup touches every server: O(N) work. That's fine for tens of servers and wasteful for thousands.

**Jump consistent hash** (Lamping and Veach, Google, 2014) is a few lines of arithmetic that map a 64-bit key and a bucket count N to a bucket number from 0 to N−1. It needs no memory, runs in O(log N) time and balances almost perfectly. The limitation is that buckets are numbered: you can grow or shrink only at the end. If bucket 3 of 10 disappears, you can't simply remove it. That suits storage where each "bucket" is a logical shard with its own replicas, so a machine failure is handled below the hashing layer. It doesn't suit a pool of cache servers where any one of them can die.

| Method | Lookup cost | State to keep | Balance | Remove any server? | Good fit |
|---|---|---|---|---|---|
| hash mod N | O(1) | none | good | moves almost all keys | fixed-size clusters |
| Ring + virtual nodes | O(log NV) | N × V positions | good with enough V | yes | Dynamo-style stores, cache clients |
| Rendezvous | O(N) | server list | good | yes | small server sets, picking replicas |
| Jump hash | O(log N) | none | near perfect | only the last bucket | numbered, replicated shards |

Who uses what:

- **Amazon's Dynamo** (2007) built its partitioning and replication on a ring with virtual nodes. **Cassandra** inherited the design, with Murmur3 tokens and configurable vnodes per node. Riak uses a ring of fixed partitions.
- **Memcached** servers don't know about each other. The client chooses the server, and libketama (from Last.fm) made ring-based consistent hashing the standard way to do it. Clients such as libmemcached offer a ketama mode.
- **Load balancers** use it to keep a client or key on the same backend for cache warmth. NGINX's `hash … consistent` directive uses ketama, and HAProxy has `hash-type consistent`.

## Check yourself

<details>
<summary>A cache tier of 10 servers uses hash mod N. You add an eleventh during peak traffic. Roughly what happens to the hit rate and to the database?</summary>

About 10 of every 11 keys now map to a different server, so roughly 91% of lookups miss at once, and the hit rate stays low until the caches refill. Nearly all of that traffic falls through to the database, which was sized for the old hit rate and may fall over. With a consistent hashing ring, only about 1/11 of keys would move.

</details>

<details>
<summary>A ring has three physical servers with one position each. One fails. Where does its load go, and how would virtual nodes change that?</summary>

All of its range goes to the next server clockwise, which suddenly carries roughly two-thirds of the traffic while the third server's load doesn't change. With 100 virtual nodes per server, the failed server's ranges are scattered around the ring, so its load splits roughly evenly between the two survivors.

</details>

<details>
<summary>Why does the replica walk need to skip positions belonging to a physical server that's already been chosen?</summary>

With virtual nodes, consecutive ring positions can belong to the same machine. Without the skip, "three replicas" could mean three copies on one server, and losing that server would lose the data. Skipping repeats guarantees distinct machines. Production systems also skip to spread across racks or zones.

</details>

<details>
<summary>One product page key gets 50 times the traffic of any other. Will adding virtual nodes or more servers help? What would you do?</summary>

No. Both rebalance how keys are spread, but this one key still maps to exactly one server. Put a short-lived in-process cache in front of the shared tier so most reads never leave the application server, or spread reads across the key's replicas. If the traffic is writes, such as a view counter, split the key into several sub-keys and sum them on read.

</details>

<details>
<summary>When would you pick jump consistent hash over a ring?</summary>

When your buckets are logical shards numbered 0 to N−1 that never vanish individually, because each shard is itself replicated, and you only grow by adding shards at the end. Then jump hash gives near-perfect balance with no table to store or sync. For a pool of cache servers where any one can fail, use a ring or rendezvous hashing instead.

</details>

## Further reading

- [Karger et al., "Consistent Hashing and Random Trees" (STOC 1997)](https://doi.org/10.1145/258533.258660): the original paper.
- [DeCandia et al., "Dynamo: Amazon's Highly Available Key-value Store" (SOSP 2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf): the partitioning and replication sections cover the ring, virtual nodes and preference lists, and the lessons-learned section compares partitioning strategies.
- [Apache Cassandra: Dynamo architecture](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html): how tokens, vnodes and replica placement work in practice.
- [Lamping and Veach, "A Fast, Minimal Memory, Consistent Hash Algorithm"](https://arxiv.org/abs/1406.2294): the jump hash paper, with the full code.
- [Mirrokni, Thorup and Zadimoghaddam, "Consistent Hashing with Bounded Loads"](https://arxiv.org/abs/1608.01350): capping per-server load.
- [Rendezvous hashing (Wikipedia)](https://en.wikipedia.org/wiki/Rendezvous_hashing): a clear overview with references to the original papers.
- [libketama source](https://github.com/RJ/ketama): the Memcached client library that made ring hashing standard.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design consistent hashing".
- [System Design School primer](https://systemdesignschool.io/primer): "Partitioning", under Designing for Scale.
