# Design the data structures for a social network

A social network stores people and the friendships between them. When you open a stranger's profile on a professional network, the site often shows how you're connected: "You → Priya → Marco → this person." That line is the **shortest path** between two people in the friendship graph. A **graph** here is just a set of people (called **nodes** or vertices) and the friendships that join pairs of them (called **edges**). The **degree of separation** between two people is how many friendships the shortest path uses.

Finding that path for a handful of people is a first-year algorithms exercise. Doing it for 100 million people, whose friend lists don't fit on one machine, is a real design problem. Every step of the search needs someone's friend list, and those lists live on many different servers. A search that touches a few thousand people can mean a few thousand network calls, and a careless one can touch millions. Most of this design is about keeping that number small.

This chapter follows the four steps from [The system design interview, step by step](/learn/system-design-interview). It starts with breadth-first search on one machine, spreads the graph across servers, and then cuts the cost of a search by more than a thousand times with bidirectional search, depth limits and caching. Along the way it looks at how Facebook stores its own social graph.

## Step 1: Outline use cases, constraints and assumptions

### Use cases

We'll scope the problem to these use cases:

- **A user searches for someone and sees the shortest path to that person.** The answer is the list of people along the path, from the searcher to the target.
- **The service is highly available.** Search should keep working when individual servers fail.

### Out of scope

- **Graph databases and other graph-specific products.** The exercise asks you to build the graph from ordinary parts (sharded key-value storage, caches and services), so you understand what a graph database does for you. We'll come back to graph databases as a trade-off at the end.
- **Weighted edges.** Every friendship counts as one step. "Close friends count as half a step" would need a different algorithm (Dijkstra's).
- **Finding the target's id.** We assume the client already knows the person id of the profile being viewed. Name search is a separate system.
- **Adding and removing friends,** friend suggestions ("people you may know"), privacy rules about who can see whose friends, and the news feed.

### Assumptions

- There are **100 million users**.
- Each user has **50 friends on average**. Some have far more.
- Users run **1 billion friend searches a month**.
- Traffic is uneven. Some searches are popular and repeated many times, and others are run only once.
- Friendships are mutual and unweighted: if Ana is Ben's friend, Ben is Ana's friend.
- The graph won't fit on a single machine.

### Calculate usage

**Seconds in a month.** 30 × 86,400 s = 2,592,000 s, about 2.6 million.

**Search rate.** 1,000,000,000 searches ÷ 2,592,000 s ≈ **386 searches a second** on average. Round it to 400. Traffic is uneven, so plan for a peak of about 3× the average: roughly **1,200 searches a second**.

**Friend-list entries.** 100 million users × 50 friends = **5 billion entries** across all friend lists. Each friendship appears twice, once in each person's list, so that's **2.5 billion distinct friendships**.

**Friend-list storage.** A person id is a 64-bit integer, which is 8 bytes. 5 billion entries × 8 bytes = **40 GB** of friend ids. One friend list averages 50 × 8 = **400 bytes**.

**Person records.** Add an id (8 bytes), a name (about 40 bytes) and a few other fields (about 50 bytes) to the 400-byte friend list, and a person is about **500 bytes**. 100 million × 500 bytes = **50 GB** of raw data. Data held in memory as hash tables and objects usually takes several times its raw size, so budget 4×: about **200 GB** of memory to hold everyone.

**Cost of one search.** This is the number that drives the design. Say the target is 4 friendships away, and assume no overlap between friend lists (real lists overlap, which makes the true numbers smaller). A plain search from the searcher outward has to read the friend lists of everyone within 3 steps before it can see people at step 4:

- 1 (the searcher) + 50 + 2,500 + 125,000 = **127,551 friend-list reads** for one search.
- At 386 searches a second, that's 386 × 127,551 ≈ **49 million friend-list reads a second**.
- In bytes, 127,551 × 400 bytes ≈ 51 MB per search, or about **20 GB a second** moved across the network.

**What these numbers tell us.** Storage is modest. 50 GB of raw data, or 200 GB in memory, spread across a handful of servers is easy to hold, and all the friend lists together (40 GB) could fit in a cache cluster. The search rate is modest too: 400 a second is low for a web service. The problem is the fan-out of each search. **Fan-out** is how many new people each step reaches; with 50 friends each, every extra step multiplies the work by 50. A naive search turns 400 user requests a second into tens of millions of internal reads a second, each one possibly a network call to another machine. Step 4 shows how bidirectional search brings 127,551 reads down to about 100.

The [estimation](/learn/estimation) chapter covers the method behind this kind of arithmetic.

## Step 2: Create a high-level design

```diagram
title: The friend-search path. Person data is sharded across person servers.
[client:client] Client @ 0,0
[web] Web server\n(reverse proxy) @ 1,0
[api] Search API @ 2,0
[ugs] User graph\nservice @ 3,0
[lookup] Lookup\nservice @ 2,1.5
[ps:store] Person servers\n(sharded) @ 4,1.5
client -> web : HTTPS
web -> api
api -> ugs
ugs -> lookup : which server?
ugs -> ps : friend lists
```

- **Client:** the web or mobile app. It asks for the path from the signed-in user to a profile.
- **Web server (reverse proxy):** terminates HTTPS, handles authentication and forwards requests to the API servers. See [reverse proxies](/learn/reverse-proxy-and-api-gateway#what-a-reverse-proxy-is).
- **Search API:** validates the request, applies rate limits and calls the user graph service. It keeps the public API separate from the internal graph code.
- **User graph service:** runs the shortest-path search. It holds the search state (who has been visited, how each person was reached) and fetches friend lists as it needs them.
- **Lookup service:** tells the user graph service which person server holds a given person.
- **Person servers:** each holds the records, including friend lists, for one slice of the users. Together they hold the whole graph.

## Step 3: Design core components

### Use case: User searches for someone and sees the shortest path to the searched person

#### On one machine: breadth-first search

Start small. Suppose five people, where an arrow means "is friends with":

- Ana (1) is friends with Ben (2) and Chen (3).
- Ben and Chen are both friends with Dev (4).
- Dev is friends with Eva (5).

The shortest path from Ana to Eva is Ana → Ben → Dev → Eva, three friendships. (Ana → Chen → Dev → Eva is just as short; either answer is correct.)

**Breadth-first search (BFS)** finds this path. It explores the graph in rings. First it looks at everyone 1 step from the start, then everyone 2 steps away, then 3, and so on. Because it finishes each ring before starting the next, the first time it reaches the target it has used the fewest possible steps. This only works when every edge costs the same, which is true here.

BFS keeps two things:

- A **queue** of people waiting to be expanded, in the order they were found. **Expanding** a person means reading their friend list.
- A **parent** map that records, for each person found, who we reached them from. It doubles as the "visited" set, so nobody is queued twice. At the end, we walk the parent map backwards from the target to rebuild the path.

```python
from collections import deque

def shortest_path(friends, source, dest):
    """friends maps person id -> list of friend ids.
    Returns the ids along a shortest path, or None if there is no path."""
    if source == dest:
        return [source]
    parent = {source: None}          # who we reached each person from
    queue = deque([source])
    while queue:
        person = queue.popleft()
        for friend in friends.get(person, ()):
            if friend in parent:     # already found by a path at least as short
                continue
            parent[friend] = person
            if friend == dest:       # stop as soon as the target is found
                return walk_back(parent, dest)
            queue.append(friend)
    return None

def walk_back(parent, node):
    path = []
    while node is not None:
        path.append(node)
        node = parent[node]
    path.reverse()
    return path

friends = {1: [2, 3], 2: [1, 4], 3: [1, 4], 4: [2, 3, 5], 5: [4]}
shortest_path(friends, 1, 5)          # [1, 2, 4, 5]
```

Two details matter later:

1. The check `friend == dest` happens when a person is first **discovered**, before they're taken off the queue. Checking at discovery saves expanding a whole ring. In a graph where each ring is 50 times bigger than the last, that's a large saving.
2. Compare ids with `==`. In Python, `is` checks whether two values are the same object in memory, and two equal large integers often aren't.

On one machine, BFS takes time proportional to the people and friendships it touches. With everything in memory, each friend-list read takes well under a microsecond.

#### Why it doesn't fit on one machine

From step 1, the person records come to about 50 GB raw and about 200 GB as in-memory structures. Some large servers have that much memory, so why not use one?

- **Growth.** 100 million users is our starting point. Facebook's 2016 study covered 1.59 billion active people with "hundreds of billions of friendship connections." A design that needs one machine stops working well before that.
- **Throughput.** Even the efficient search we'll build does about 100 friend-list reads per search. At peak, that's over 100,000 reads a second, plus the writes when people add and remove friends. Spreading the data spreads that load.
- **Availability.** One machine is a single point of failure. If it goes down, every search fails.

So we split the people across machines, which is called **sharding**. Each piece is a **shard**.

#### Sharding people across person servers

A **person server** holds the records for one or more shards and answers one question quickly: "Give me the records for these person ids." Each record includes the person's friend list, so reading someone's friends is one lookup on one server.

```python
from dataclasses import dataclass

@dataclass
class Person:
    id: int
    name: str
    friend_ids: list[int]

class PersonServer:
    def __init__(self):
        self.people = {}                      # person id -> Person

    def add_person(self, person):
        self.people[person.id] = person

    def get_people(self, ids):
        """Batch read: the records this server holds for the given ids."""
        return [self.people[i] for i in ids if i in self.people]
```

`get_people` takes a list of ids on purpose. One call that returns 40 people costs about the same network time as a call that returns one, and step 4 relies on that.

Which shard does a person go in? The simplest choice that spreads load evenly is to hash the person id: `shard = hash(person_id) mod number_of_shards`. Hashing scatters people, and their friends, across all shards. That's good for balance and bad for locality: a person's 50 friends are probably on 50 different shards. Step 4 looks at sharding by location instead. The [sharding section](/learn/database-internals#sharding) of the database chapter compares partitioning schemes in general.

#### The lookup service

The user graph service needs to know where each person lives. The **lookup service** answers "which person server holds person 1234?"

```python
class LookupService:
    def __init__(self, person_to_server):
        self.person_to_server = person_to_server   # person id -> PersonServer

    def lookup_person_server(self, person_id):
        return self.person_to_server[person_id]
```

This version is a **directory**: an explicit table with one row per person. A directory is flexible, because you can move one heavy user to a quieter server by changing one row. It's also big. 100 million rows of an 8-byte id and a 2-byte server number is 1 GB raw, several GB as a hash table, and it must be replicated so it doesn't become a single point of failure. The [directory partitioning](/learn/database-internals#directory-partitioning) section covers this trade-off. Step 4 replaces most of it with a computation.

#### The user graph service runs the search

The **user graph service** runs the same BFS, with one change: it doesn't have the friend lists. For each person it expands, it does two network calls:

1. Ask the lookup service which person server holds that person.
2. Ask that person server for the person's record and read `friend_ids`.

```python
from collections import deque

class UserGraphService:
    def __init__(self, lookup_service):
        self.lookup = lookup_service

    def get_person(self, person_id):
        server = self.lookup.lookup_person_server(person_id)   # network call 1
        people = server.get_people([person_id])                # network call 2
        return people[0] if people else None

    def shortest_path(self, source_id, dest_id):
        if source_id == dest_id:
            return [source_id]
        parent = {source_id: None}
        queue = deque([source_id])
        while queue:
            person = self.get_person(queue.popleft())
            for friend_id in person.friend_ids:
                if friend_id in parent:
                    continue
                parent[friend_id] = person.id
                if friend_id == dest_id:
                    return walk_back(parent, dest_id)
                queue.append(friend_id)
        return None
```

Notice that the queue and the parent map hold **ids** only. The search fetches a person's record only when it expands them. The parent map lives in the user graph service, because a person server shouldn't store per-search state, and many searches run at once.

An easy mistake is to fetch every friend's record as soon as they're discovered. That fetches 50 records for every person expanded, most of which are never expanded, and multiplies the network calls by the fan-out.

This code is correct and slow. Each expansion costs two network round trips. Assume a round trip inside one data center takes about 0.5 ms, the figure in the widely shared latency table credited to Jeff Dean and Peter Norvig. Expanding the 127,551 people from step 1 one at a time takes 127,551 × 2 × 0.5 ms ≈ **128 seconds**. Step 4 fixes that.

Internal calls between the user graph service, lookup service and person servers use **RPC** (remote procedure calls), such as gRPC. They're private, high-volume and latency-sensitive, so a compact binary protocol suits them better than JSON over REST. See [RPC](/learn/protocols-and-apis#rpc-calling-a-function-on-another-machine).

#### The API

The public API is REST. The signed-in user is the source, so the request names only the target:

```http
GET /api/v1/friend_search?person_id=1234 HTTP/1.1
Host: social.example.com
Authorization: Bearer <token>
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "degree": 2,
  "path": [
    {"person_id": "100", "name": "foo", "link": "https://social.example.com/foo"},
    {"person_id": "53",  "name": "bar", "link": "https://social.example.com/bar"},
    {"person_id": "1234","name": "baz", "link": "https://social.example.com/baz"}
  ]
}
```

The path starts with the searcher (person 100) and ends with the target (person 1234). `degree` is the number of friendships on the path, which is one less than the number of people. If no path exists within the search limit (step 4), the response is `200 OK` with `"path": null` and a `"reason"` such as `"beyond_search_limit"`. It's a normal answer, so the status stays 200.

Person ids are strings in the JSON because JavaScript numbers lose precision above 2⁵³, and 64-bit ids can be larger than that.

## Step 4: Scale the design

```diagram
title: The scaled design. Internal load balancers are left out.
[client:client] Client @ 0,0
[dns] DNS @ 0,1.5
[lb] Load balancer @ 1,0
[web] Web servers @ 2,0
[api] Search API @ 3,0
[lookup] Lookup\nservice @ 2,1.5
[ugs] User graph\nservice @ 3,1.5
[cache:store] Memory cache\n(friend lists) @ 4,1.5
[ps:store] Person servers\n+ replicas @ 3,3
[nosql:store] Precomputed\ntraversals (NoSQL) @ 4,3
[batch] Offline\nbatch jobs @ 4,4.5
client -> dns
client -> lb
lb -> web
web -> api
api -> ugs
ugs -> lookup
ugs -> cache
ugs -> ps
ugs -> nosql
ps --> batch : nightly export
batch --> nosql
```

Don't jump straight to this picture in an interview. Describe the loop: load-test the simple design, profile it to find the bottleneck, fix that bottleneck while weighing alternatives, and repeat. [Design a system that scales to millions of users on AWS](/learn/design-scaling-aws) walks through that loop step by step.

### Find the bottlenecks

The step-1 numbers point at one thing. At about 400 searches a second, the front of the system (load balancer, web servers, search API) carries light traffic and scales by adding stateless copies. The trouble is inside each search:

1. **Too many people expanded.** A one-sided BFS to depth 4 reads about 127,551 friend lists.
2. **Too many network round trips.** Each read costs a call to the lookup service plus a call to a person server, one after the other.
3. **Repeated work.** Popular searches run again and again, and well-connected people's friend lists are read by many searches.

The subsections below take these in order of impact, after a quick word on the front end.

### Load balancer, web servers and the search API

- **DNS** points the client at the load balancer.
- A **load balancer** spreads requests across several **web servers** and **search API** servers. They hold no state between requests, so you scale them by adding copies, and a failed copy is simply taken out of rotation. See [load balancing](/learn/load-balancing) and [horizontal scaling](/learn/load-balancing#horizontal-scaling-and-what-it-costs).
- The **user graph service** is stateless between searches too (its BFS state lives only for one request), so it scales the same way.

This fixes availability at the front and costs some more machines to run. It does nothing for the cost of a search.

### Search from both ends: bidirectional BFS

**Bidirectional BFS** runs two searches at once: one outward from the searcher and one outward from the target. When a person discovered by one side has already been seen by the other, the two halves meet, and the path is the first half joined to the second half reversed. Friendships are mutual, so the backward search uses the same friend lists.

Here is the arithmetic, with 50 friends each and no overlap between lists. Take a target 4 steps away:

- **One-sided BFS** expands depths 0, 1, 2 and 3 before it discovers depth 4: 1 + 50 + 2,500 + 125,000 = **127,551 friend-list reads**.
- **Bidirectional BFS** needs each side to reach depth 2, so each side expands only depths 0 and 1: 1 + 50 = 51 reads per side, **102 in total**.

That's about **1,250 times less work**. A ring at depth d holds about 50^d people, and splitting the path in half turns one 50⁴ problem into two 50² problems. In general, with fan-out b and distance d, a one-sided search costs about b^d and a two-sided search about 2 × b^(d/2).

| Distance to target | One-sided reads | Two-sided reads | Ratio |
| --- | --- | --- | --- |
| 4 steps, 50 friends | 127,551 | 102 | about 1,250× |
| 5 steps, 50 friends | 6,377,551 | 2,602 | about 2,450× |
| 4 steps, 100 friends | 1,010,101 | 202 | about 5,000× |

(For 5 steps, one side reaches depth 3 and the other depth 2, so the reads are 1 + 50 + 2,500 on one side and 1 + 50 on the other.)

The higher the fan-out, the bigger the win. At 386 searches a second and 102 reads each, the system does about 39,400 friend-list reads a second, or roughly 118,000 at peak. That's about 16 MB a second of friend lists instead of 20 GB.

Is 4 or 5 steps realistic? Facebook's 2016 research post "Three and a half degrees of separation" estimated that across its 1.59 billion active people, the average distance was 4.57 friendships, which is 3.57 people in between. Within the US it was 3.46 degrees. So most pairs of people sit 4 or 5 steps apart, which is right where bidirectional search pays off most.

The code below adds two methods to `UserGraphService`. It expands one ring at a time. Each time, it expands whichever side has the smaller frontier (the set of people found in the last ring), because a smaller frontier means fewer friend lists to read.

```python
def shortest_path_bidirectional(self, source_id, dest_id, max_hops=6):
    if source_id == dest_id:
        return [source_id]
    parents_fwd, parents_bwd = {source_id: None}, {dest_id: None}
    frontier_fwd, frontier_bwd = [source_id], [dest_id]
    hops = 0                        # depth searched so far, both sides combined
    while frontier_fwd and frontier_bwd and hops < max_hops:
        if len(frontier_fwd) <= len(frontier_bwd):
            frontier_fwd, meet = self._expand(frontier_fwd, parents_fwd, parents_bwd)
        else:
            frontier_bwd, meet = self._expand(frontier_bwd, parents_bwd, parents_fwd)
        hops += 1
        if meet is not None:
            return join(meet, parents_fwd, parents_bwd)
    return None                     # no path within max_hops

def _expand(self, frontier, parents, other_parents):
    """Expand one whole ring. Returns the next ring and a meeting person, if any."""
    friend_lists = self.friends_of(frontier)     # batched, see the next section
    next_frontier = []
    for person_id in frontier:
        for friend_id in friend_lists.get(person_id, ()):
            if friend_id in parents:
                continue
            parents[friend_id] = person_id
            if friend_id in other_parents:
                return next_frontier, friend_id
            next_frontier.append(friend_id)
    return next_frontier, None

def join(meet, parents_fwd, parents_bwd):
    path = walk_back(parents_fwd, meet)          # source ... meet
    node = parents_bwd[meet]
    while node is not None:                      # meet ... dest
        path.append(node)
        node = parents_bwd[node]
    return path
```

Why is the first meeting point on a shortest path? Before this ring, the two sides had searched to depths a and b and shared nobody. That means no path of length a + b or less exists: if one did, the person a steps along it would already be in both sets. Expanding one side by a ring can only produce meetings on paths of length a + b + 1, so any meeting found is a shortest path.

Bidirectional search has costs. The code is more complex. For directed graphs, such as "follows" on a network like Twitter, the backward side needs each person's list of followers, a second index that must be kept in step with the first (see [Design Twitter](/learn/design-twitter)). And it needs the target known up front, which is true here.

### Cut the cost of each cross-server hop

Bidirectional BFS reads about 100 friend lists. The naive service still reads them one at a time, with two round trips each: 102 × 2 × 0.5 ms ≈ 100 ms of pure network wait. Four changes shrink that.

**1. Compute the server instead of asking for it.** Give each person a shard number that can be computed from their id, such as `hash(person_id) mod 4096`, or one written into the id itself when the person is created. The lookup service then only needs a table of 4,096 shards to servers, a few kilobytes. Every user graph service keeps a copy in memory and refreshes it when shards move. Each read drops from two round trips to one. To move shards between servers without reshuffling everything, map shards to servers with [consistent hashing](/learn/consistent-hashing) or an explicit shard table. Facebook's TAO does exactly this: each object id embeds its shard id, and "the number of shards far exceeds the number of servers."

**2. Batch by server, one ring at a time.** BFS can't know ring 3 until ring 2 is done, but within a ring all the reads are independent. Group the ring's ids by person server and send one batch request per server:

```python
from collections import defaultdict

def friends_of(self, ids):
    """Fetch friend lists for many people, one request per person server."""
    by_server = defaultdict(list)
    for person_id in ids:
        by_server[self.lookup.lookup_person_server(person_id)].append(person_id)
    friend_lists = {}
    for server, batch in by_server.items():       # in production, send these in parallel
        for person in server.get_people(batch):
            friend_lists[person.id] = person.friend_ids
    return friend_lists
```

**3. Send the batches in parallel.** With batching and parallel requests, a search costs one round of calls per ring. The 4-step search above expands four rings (two per side), so it waits for about 4 rounds × 0.5 ms = 2 ms of network time plus the servers' own work, instead of 100 ms.

A ring that fans out to many servers waits for the slowest one. If each server is slow 1% of the time (a garbage-collection pause, a busy disk), a ring that touches 50 servers hits at least one slow server about 39% of the time. This is the tail-latency effect described in [The Tail at Scale](/learn/performance-and-latency#the-tail-at-scale). Fixes include sending a backup request to a replica when the first is slow, and keeping per-ring timeouts.

**4. Put friends on the same server.** Friends tend to live near each other, so sharding people **by location** puts more of a person's friends on the same server. Then a ring needs fewer batches, and some friend-of-friend reads stay on one machine. The cost is uneven shards (a big city is a hot shard) and moving people when they relocate. The gain is also limited. The TAO paper says Facebook's graph is "tightly interconnected" and that "it is not possible to group users so that cross-partition requests are rare." Measure whether location sharding helps before relying on it.

### Limit the search depth

Some pairs of people are far apart, and some aren't connected at all. Without a limit, a search for an unconnected person explores everyone reachable before giving up. Three ways to bound it:

- **A hop limit.** LinkedIn labels people as 1st-degree (you're connected), 2nd-degree ("connected to your 1st-degree connections") and 3rd-degree ("connected to your 2nd-degree connections"). Members outside those circles (and not linked in other ways, such as a shared group) are "out of network." A product that labels connections this way only ever needs paths of 3 steps or fewer. In our code it's `max_hops=3`: the two sides together search at most 3 rings, about 1 + 1 + 50 = 52 reads (each side expands its start person, then one side expands its 50 friends). The answer "beyond 3rd degree" is cheap and honest.
- **A time or work limit.** Stop after, say, 200 ms or 10,000 friend-list reads, and tell the user: "This could take a while. Keep searching?" The work done so far can be kept for a few minutes so continuing doesn't start over.
- **Prefer well-connected people.** People with many friends are more likely to shorten a path, so a search that expands them first often finds a path sooner. This turns BFS into a best-first search, which finds a short path quickly but no longer guarantees the shortest. It's a fair trade when the product shows "a way you're connected" rather than "the shortest way." The safe version of this idea is already in the bidirectional code: always expand the smaller frontier.

High-degree people cut both ways. LinkedIn caps members at 30,000 1st-degree connections, and a person with that many is a huge frontier on their own. Their friend list is 600 times longer than average, and all 30,000 people land in the next frontier. A search that reaches such a person can cap how many of their friends it follows, or expand them last.

### Cache friend lists in memory

Every search reads friend lists, and the same lists come up again and again. A well-connected person's list is read by many searches, and someone who searches several profiles in a row reads their own neighborhood each time. Put a **memory cache**, such as Memcached or Redis, between the user graph service and the person servers.

- **What to cache:** each person's friend list, keyed by person id. This is caching at the object level (see [caching at the object level](/learn/cache#caching-at-the-object-level)). All 100 million lists come to about 40 GB, so a modest cache cluster could hold every one. In practice, the hot fraction is enough.
- **How to fill it:** [cache-aside](/learn/cache#cache-aside). The service checks the cache, falls back to the person server on a miss, and writes the result into the cache.
- **When friendships change:** delete both people's cached lists after the person servers commit the change, and give entries a TTL so a missed delete doesn't last forever.
- **Why memory:** in the latency table credited to Jeff Dean, reading 1 MB sequentially takes about 250 µs from memory, about 1 ms from an SSD (4×) and about 20 ms from a spinning disk (80×). These are rough figures from around 2012, and the ratios are what matter.

The cache also helps person servers: hot lists are served from the cache, so a celebrity's shard isn't hammered by every search that passes through them.

This is a large part of what Facebook built. TAO, described in a USENIX ATC 2013 paper, stores the social graph as **objects** (nodes, such as users and posts) and **associations** (typed, directed edges, such as FRIEND). Friendships are stored as two associations, one in each direction, and TAO keeps an edge and its inverse in step. Data lives in sharded MySQL, and an association is stored on the shard of its source object "so that every association query can be served from a single server." In front of MySQL sit two tiers of graph-aware caches. Clients talk to **follower** caches, and followers forward misses and writes to a **leader** cache, one per shard, which talks to the database. The paper reports that TAO handles "a billion reads and millions of writes each second," that writes were only 0.2% of requests, and that its read hit rate was 96.4%.

TAO's API is deliberately small: fetch an object, fetch or count a node's edges of one type, page through them by time. The paper says TAO's goal "is not to support a complete set of graph queries." A multi-hop search like ours would be built from many single-hop reads, which is why batching and caching single-hop reads matters so much.

### Store traversals: cache and precompute

Friend-list caching speeds up each read. The next step is to avoid reads altogether.

**Cache search results.** Keep recent results keyed by (source, target) in the memory cache with a short TTL. Popular searches, such as many people viewing the same celebrity's profile, then cost one cache read. Results go stale when friendships change, but a path that was right a few minutes ago is usually fine to show.

**Cache partial traversals.** A user who searches several profiles in a row starts every search from the same place. Cache their forward rings (their friends and friends-of-friends, with parent pointers) for a few minutes, so each new search only has to run the backward side.

**Precompute neighborhoods offline.** A nightly batch job can compute, for every person, everyone within 2 steps along with the friend that leads to each one. Store the results in a **NoSQL** key-value or wide-column store, keyed by person id.

- **Size:** about 50 + 2,500 = 2,550 people per person. With an 8-byte id and an 8-byte "via" friend each, that's about 40 KB per person, and 100 million × 40 KB ≈ **4 TB** before replication. That's large but ordinary for a distributed key-value store.
- **Query:** any path of 4 steps or fewer is found by reading two rows, the source's and the target's, and intersecting them. Paths of 1 to 4 steps all show up this way.
- **Costs:** the data is up to a day old, so a friendship made this morning won't appear. You can fix that by running a live search when the precomputed answer is missing or by updating rows incrementally as friendships change. Well-connected people blow up the row size: someone with 5,000 friends who each have 50 has 250,000 people within 2 steps. Cap the row or skip precomputing for such people. The job itself is a large distributed computation; see [batch processing](/learn/batch-processing).

### Keep the service available

The second use case is high availability. Each component needs a plan for failure:

- **Person servers** are the source of truth, so each shard has **replicas** on other machines, ideally in other racks or zones. Reads go to any replica. If the primary fails, a replica is promoted. See [fail-over and replication](/learn/availability#fail-over-and-replication).
- **The lookup table** is small once shards are computed from ids, so every user graph service keeps a copy. The service that publishes changes to it can be down briefly without stopping searches, since the cached copy keeps working until shards move.
- **The memory cache** is an accelerator. If it fails, searches get slower and person servers get busier, so size the person servers to survive a cold cache, and watch for a [cache stampede](/learn/cache#cache-stampede-thundering-herd) when it comes back.
- **Graceful degradation.** If a person server is unreachable mid-search, the search can skip that shard's people and still return a path if one exists through other people. The path may not be the shortest, and the response can say so.

## Trade-offs and follow-up questions

**Exact shortest path or a good-enough path?** An exact BFS with no limits can explode on unconnected or distant pairs. Bounding depth (LinkedIn's 3rd degree), bounding time, or preferring hubs makes cost predictable at the price of sometimes answering "too far" or showing a path that isn't the shortest. Pick the hop limit by default: users mostly care about close connections, and a clear "3rd degree or beyond" is better than a slow page.

**Hash sharding or location sharding?** Hashing gives even shards and simple routing, and nearly every friend is on another server. Location sharding keeps more friends together but gives uneven shards, needs moves when people relocate, and still leaves many cross-server reads in a tightly connected graph. Start with hashing into many small logical shards, which keeps the option to place shards cleverly later.

**Directory or computed lookup?** A per-person directory lets you move any single person anywhere, at the cost of a large, replicated table and an extra round trip per read. Computing the shard from the id (or embedding it in the id, as TAO does) removes the round trip, and a small shard-to-server table keeps flexibility. Use [consistent hashing](/learn/consistent-hashing) or many logical shards so adding servers moves little data.

**Search live, or precompute?** Live bidirectional search is always current and costs about 100 cached reads per search. Precomputed 2-step neighborhoods answer with two reads but are hours old and take terabytes. With caching, live search is fast enough here, so precompute only if latency targets demand it, or for the most-viewed profiles.

**How stale can a friend list be?** A cached list may still include someone who unfriended a person a few seconds ago, so the path might go through a friendship that no longer exists. TAO accepts this kind of staleness: its paper describes eventual consistency between cache tiers, with read-after-write consistency within one tier. A cheap safeguard is to re-check the 3 to 5 edges of the final path against the person servers before returning it. See [guarantees for one user](/learn/cap-and-consistency#guarantees-for-one-user).

**Why not a graph database?** If the constraint is lifted, a graph database stores relationships so that following an edge is cheap, and its query language expresses multi-hop questions directly. See [graph databases](/learn/nosql-databases#graph-databases). At hundreds of millions of people it still has to be sharded, and every hop between shards costs a network call, so the ideas in this chapter (bidirectional search, depth limits, caching) still apply. A related confusion: GraphQL, despite its name, is an API query language that lets a client choose the fields it gets back. It doesn't store graphs. See [GraphQL](/learn/protocols-and-apis#graphql-the-client-picks-the-fields).

**REST outside, RPC inside.** The public endpoint is one simple REST call that browsers and apps handle easily. Inside, a single search makes dozens of batched calls, where RPC's binary encoding, persistent connections and generated clients pay off. See [RPC and REST side by side](/learn/protocols-and-apis#rpc-and-rest-side-by-side).

## Check yourself

<details>
<summary>Suppose the average user had 100 friends instead of 50, and the target is 4 steps away. How many friend-list reads do one-sided and bidirectional BFS need, ignoring overlap?</summary>

One-sided BFS expands depths 0 to 3 before discovering depth 4: 1 + 100 + 10,000 + 1,000,000 = 1,010,101 reads. Bidirectional BFS expands depths 0 and 1 on each side: 2 × (1 + 100) = 202 reads. The ratio is about 5,000, up from about 1,250 at 50 friends.

The ratio grows with fan-out because the one-sided cost is about b^d and the two-sided cost about 2 × b^(d/2). Doubling b multiplies the first by 16 and the second by only about 4.

</details>

<details>
<summary>Your lookup service is a table with one row per person, and every friend-list read first calls it. A bidirectional search reads 102 lists. What does the lookup cost, and how would you remove it?</summary>

Read one at a time, that's 102 extra round trips, about 51 ms at 0.5 ms each, doubling the network time of the search. It also makes the lookup service as busy as all the person servers combined.

Compute the shard from the person id instead, for example `hash(id) mod 4096`, or embed the shard number in the id when the person is created. The only table left maps 4,096 shards to servers. It's a few kilobytes, so every user graph service keeps it in memory and refreshes it when a shard moves. The lookup becomes a local calculation with no network call.

</details>

<details>
<summary>A user searches for a celebrity with 30,000 connections. What happens in the bidirectional search, and what keeps it cheap?</summary>

The searcher's side starts with 1 person and the celebrity's side with 1. After one ring each, the searcher's frontier has about 50 people and the celebrity's has 30,000. Because the code always expands the smaller frontier, it keeps growing the searcher's side, reading about 50 lists for the next ring instead of 30,000. The 2,500 friends-of-friends it discovers are checked against the celebrity's 30,000 connections in memory, which is cheap.

What keeps it cheap is the smaller-frontier rule plus caching. The celebrity's friend list is read by many searches, so it's almost always in the memory cache. Popular targets also benefit from caching whole results keyed by (source, target).

</details>

<details>
<summary>The product changes from mutual friendships to one-way follows. What has to change in the search?</summary>

One-sided BFS from the searcher still works: it follows "who does this person follow" lists. Bidirectional BFS needs the backward side to walk edges in reverse, so it needs "who follows this person" lists, a second index. Each follow is then written twice, once in the follower's list and once in the followee's, and those two copies can be on different shards. TAO handles this with inverse associations: when an edge type has an inverse, adding or deleting the edge also adds or deletes the inverse. It doesn't make the two writes atomic, and a background job repairs edges left without their inverse.

</details>

<details>
<summary>Estimate the storage for precomputing everyone's 2-step neighborhood. Would you do it?</summary>

With 50 friends each and no overlap, a person has 50 + 2,500 = 2,550 people within 2 steps. Storing an 8-byte id and an 8-byte "via" friend for each is about 40 KB per person, and 100 million people gives about 4 TB, more with replication. Real lists overlap, which lowers this, and high-degree people raise it sharply.

It answers any path of 4 steps or fewer with two reads. But the data is up to a day old and costs a large nightly job. Live bidirectional search with cached friend lists costs about 100 cache reads and finishes in a few milliseconds of network time, so I'd only precompute for the most-viewed targets or if latency targets demanded it.

</details>

<details>
<summary>After adding more person servers, the median search time stays the same but the 99th percentile gets worse. Why?</summary>

With more servers, each ring of a search fans out to more of them, and the ring finishes only when the slowest reply arrives. If each server is slow 1% of the time and a ring touches 50 servers, the chance that at least one is slow is 1 − 0.99⁵⁰ ≈ 39%. Adding servers raises the fan-out and with it the odds of hitting a slow one, which shows up in the tail.

Fixes: send a backup request to a replica when a reply is late (hedged requests), set per-ring timeouts and continue without the slow shard, cache more of the hot friend lists, and use more, smaller logical shards placed so a ring touches fewer machines.

</details>

## Further reading

- [TAO: Facebook's Distributed Data Store for the Social Graph](https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson) (USENIX ATC 2013): how Facebook stores its graph as objects and associations on sharded MySQL behind two tiers of graph-aware caches, with production numbers on reads, writes, hit rates and high-degree nodes. The [PDF](https://www.usenix.org/system/files/conference/atc13/atc13-bronson.pdf) is short and readable.
- [Three and a half degrees of separation](https://research.facebook.com/blog/2016/02/three-and-a-half-degrees-of-separation/) (Facebook Research, 2016): the study that measured an average distance of 4.57 friendships across 1.59 billion people, and how they estimated it without running a search for every pair.
- [Your network and degrees of connection](https://www.linkedin.com/help/linkedin/answer/a545636/your-network-and-degrees-of-connection) (LinkedIn Help): LinkedIn's definitions of 1st, 2nd and 3rd-degree connections and the 30,000-connection cap, a real example of a product that bounds search depth.
- [Bidirectional search](https://en.wikipedia.org/wiki/Bidirectional_search) (Wikipedia): the general algorithm and its b^(d/2) cost, with pointers to the variants for weighted graphs.
- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832): the table of rough latencies, credited to Jeff Dean and Peter Norvig, used here for round trips and memory versus disk reads.
