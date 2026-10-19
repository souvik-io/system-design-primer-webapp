# Design a real-time gaming leaderboard

Online games, competitive programming sites and fitness apps use leaderboards to keep people coming back. Players expect their score and rank to change as soon as a match ends, and millions of people look at the top 100 at the same time.

The design looks like "sort players by score", and for a few thousand players that's all it is. At tens of millions of players, the hard parts show up: answering "what's my rank?" without counting millions of rows, breaking ties fairly, keeping the in-memory structure durable, and deciding whether and how to shard it. The usual answer centers on **Redis sorted sets**, which are built on a **skip list**, so this chapter explains how that structure answers rank queries quickly.

It builds on the chapters on [relational databases](/learn/relational-databases), [caching](/learn/cache), [real-time updates](/learn/realtime) and [rate limiting](/learn/rate-limiting).

## Requirements and estimates

### Functional requirements

1. **Update score:** when a player finishes a match, their score goes up by the points they won.
2. **Top K:** show the top 10 or top 100 players.
3. **My rank:** a player can see their exact position, such as "You are ranked #4,821".
4. **Around me:** a player can see the players just above and below them, say 5 on each side.
5. **Seasons:** the leaderboard resets on a schedule (weekly, monthly or per season), and past results are kept.

### Non-functional requirements

1. **Freshness.** A finished match shows up on the leaderboard within about a second. Players notice if their rank doesn't move.
2. **Throughput.** Thousands of score updates a second at peak, and several times that in reads.
3. **Scale.** 100 million registered players, 10 million of them active on a given day.
4. **Durability.** A crashed server must not lose a confirmed score. The leaderboard itself can be rebuilt, as long as the match results it was built from are safe.

### Capacity estimates

These are assumptions for a large online game, not figures from any real one:

- **Updates:** 10 million daily players × 10 matches each = 100 million score updates a day. 100,000,000 ÷ 86,400 s ≈ **1,160 updates a second** on average. With an evening peak of about 5× average, plan for roughly **6,000 updates a second**.
- **Reads:** players check the leaderboard or their own rank after most matches, and some keep the tab open. Plan for about **20,000 reads a second** at peak, an assumption worth stating out loud in an interview.
- **Memory:** in a Redis sorted set, each member costs its ID string, an 8-byte score, a skip list node with its forward pointers, and a hash table entry. Allow about **100 bytes per player**. 100 million × 100 bytes ≈ **10 GB**.

10 GB fits in memory on one server, so a single global sorted set is feasible even if every registered player has a score. In practice a season's leaderboard only holds players who played that season, which is usually far fewer. Replicas are still needed for availability and to spread the reads.

## Why a relational database struggles with ranking

The obvious first design is a table with an index on score:

```sql
CREATE TABLE leaderboard (
    player_id   BIGINT PRIMARY KEY,
    score       INT NOT NULL,
    updated_at  TIMESTAMP NOT NULL
);
CREATE INDEX idx_score ON leaderboard (score DESC);
```

Now look at each query.

1. **Top 10** is fast. The database walks the first 10 entries of the index:

   ```sql
   SELECT player_id, score FROM leaderboard ORDER BY score DESC LIMIT 10;
   ```

2. **A player's rank** is the problem. To find the rank of a player with 1,250 points, you count everyone above them:

   ```sql
   SELECT COUNT(*) + 1 FROM leaderboard WHERE score > 1250;
   ```

   A standard B-tree index doesn't store how many entries sit under each branch, so the database has to walk every index entry above 1,250. For a player in the middle of 10 million, that's about 5 million entries for one query. At thousands of rank queries a second, the database spends its time counting.

3. **Updates** are fine on their own:

   ```sql
   UPDATE leaderboard SET score = score + 50 WHERE player_id = ?;
   ```

   Each update moves one entry in the score index. A few thousand a second is a reasonable load for a well-provisioned database, but combined with the rank queries above it leaves little headroom.

The relational database is still the right place for the durable record of matches and scores. It just isn't a good engine for answering rank queries. For that you want a structure where rank is cheap to compute: one that knows, at each step of a search, how many elements it skipped.

## Skip lists and Redis sorted sets

A Redis **sorted set** (often called a ZSET) holds unique members, each with a numeric score, kept in score order. Once a set grows past a small size (128 members by default), Redis stores it as two structures side by side:

1. A **hash table** from member to score, so "what's this player's score?" takes O(1).
2. A **skip list** ordered by score (and by member name for equal scores), so insert, delete and rank take O(log N) on average.

Small sets use a compact flat encoding instead, which is faster for a handful of members.

### How a skip list works

A skip list is a sorted linked list with extra "express" levels on top. Every element is in the bottom level. Each element is also promoted to the next level up with some fixed probability (Redis uses 1/4), so each level has roughly a quarter of the elements of the one below.

```text
Level 3:  HEAD ------------------------------------> 200 -> NIL
Level 2:  HEAD ----------------> 100 --------------> 200 -> NIL
Level 1:  HEAD -> 50 -> 75 ----> 100 -> 150 -> 180 -> 200 -> NIL
```

To find 180, start at the top level of HEAD. Move right while the next element is not past the target, then drop down a level and repeat. Here, level 3 jumps straight to 200, which overshoots, so drop to level 2. That moves HEAD to 100; the next step, 200, would overshoot again, so drop to level 1 and continue through 150 to 180. Each level cuts the remaining distance by about the promotion factor, so a search takes O(log N) steps on average instead of O(N) for a plain list.

The part that makes rank cheap: Redis stores a **span** on every forward pointer, the number of bottom-level elements that pointer jumps over. While searching for a player, it adds up the spans of the pointers it follows. When it reaches the player, the sum is their rank. No counting of individual elements is needed, so rank costs the same O(log N) as a lookup.

Pugh's original skip list paper (in Further reading) explains why the randomness gives balanced performance without the rotations a balanced tree needs.

### Leaderboard operations in Redis

```text
# Add points to a player (creates the member if it doesn't exist). O(log N)
ZINCRBY leaderboard:s2026q4 50 player_104

# Top 10 with scores, highest first. O(log N + M), M = number returned
ZRANGE leaderboard:s2026q4 0 9 REV WITHSCORES

# A player's 0-based rank, highest score first. O(log N)
ZREVRANK leaderboard:s2026q4 player_104

# A player's score. O(1)
ZSCORE leaderboard:s2026q4 player_104

# The 5 players above and below: with rank R from ZREVRANK,
# ask for positions max(0, R - 5) to R + 5, e.g. for R = 4820:
ZRANGE leaderboard:s2026q4 4815 4825 REV WITHSCORES
```

`ZRANGE ... REV` replaced `ZREVRANGE` in Redis 6.2. The older command still works and you'll see it in a lot of examples. Ranks from Redis start at 0, so add 1 before showing them.

A single Redis instance runs commands on one thread, and these commands are short. One node can typically handle on the order of 100,000 simple operations a second, depending on hardware and command mix, which is far above our 6,000 writes a second.

## End-to-end architecture

```diagram
title: Leaderboard write and read paths
[client:client] Game clients @ 0,0
[lb] Load balancer @ 1,0
[api] API servers @ 2,0
[rep:store] Redis replicas\n(reads) @ 3,0
[q:queue] Kafka\nscore-events @ 2,1
[worker] Score workers @ 2,2
[db:store] PostgreSQL\n(match results) @ 1,2
[primary:store] Redis primary\n(sorted set) @ 3,2
client -> lb
lb -> api
api -> rep : top K, my rank
api -> q : 1. match result
q --> worker
worker -> db : 2. record match
worker -> primary : 3. ZINCRBY
primary --> rep : replication
```

### Write path

1. A match ends. The **game server**, not the player's client, reports the result: `POST /api/v1/scores` with `{"player_id": "p104", "points": 50, "match_id": "m982"}`. Letting clients report their own scores invites cheating, so the API authenticates the game server and rejects anything else.
2. The API server publishes the event to a Kafka topic, `score-events`, keyed by `player_id`. Kafka absorbs bursts and keeps the event durable even if the workers or Redis are briefly down. Keying by player keeps each player's updates in order.
3. A score worker consumes the event and writes the match result to PostgreSQL, with a unique constraint on `match_id`. That table is the source of truth.
4. Only if that insert succeeded does the worker run `ZINCRBY` on the Redis primary. Kafka delivers at least once, and `ZINCRBY` isn't idempotent: running it twice adds the points twice. The unique `match_id` turns a redelivered event into a no-op.

There's still a gap: if the worker crashes after the database insert but before `ZINCRBY`, the redelivered event finds the match already recorded and skips the update. Close it by recording in the same transaction whether the Redis update was applied, and have a periodic job compare totals between PostgreSQL and Redis for recently active players. The end-to-end delay from match end to leaderboard is usually well under a second.

### Read path

1. The player opens the leaderboard: `GET /api/v1/leaderboard/top?limit=10`.
2. The API server runs `ZRANGE leaderboard:s2026q4 0 9 REV WITHSCORES` on one of the Redis replicas.
3. For "around me", it runs `ZREVRANK` to get the player's rank R, then `ZRANGE` from max(0, R − 5) to R + 5. Run both in a pipeline or a small Lua script so they see the same version of the set.
4. It adds display names and avatars from a profile cache and returns the result.

The top 100 changes constantly but is read by everyone. Caching that one response for a second or two in the API servers removes most of the read load from Redis, and nobody can tell the difference.

Replicas lag the primary slightly, so a player who just finished a match might read their old rank from a replica. If that matters, read the player's own rank from the primary and serve the shared top-K view from replicas.

To push updates to players who keep the leaderboard open, see [real-time updates](/learn/realtime). Polling every few seconds is often good enough for a leaderboard.

## Breaking ties

Two players both have 1,500 points. Who's ranked higher?

Redis orders members with equal scores by member name, byte by byte. With `REV` that order is reversed too. Either way, the result depends on player IDs, which is arbitrary from the players' point of view. A common fair rule is that **whoever reached the score first ranks higher**.

### Packing the time into the score

Redis scores are 64-bit floating-point numbers. A double holds every integer up to 2⁵³ (about 9 × 10¹⁵) exactly, so you can pack two values into one integer score as long as the total stays below that.

Use the high part for points and the low part for how early the score was reached:

```text
elapsed   = seconds since the season started (must be < 2^24, about 194 days)
composite = points × 2^24 + (2^24 − 1 − elapsed)
points    = floor(composite ÷ 2^24)
```

Higher points always win, because one point is worth more than any possible time value. Between equal points, a smaller `elapsed` gives a larger low part, so the player who got there first ranks higher. Points can go up to 2²⁹ − 1, about 537 million, before the composite passes 2⁵³.

For example, Player A reaches 1,500 points 1,000 seconds into the season, and Player B reaches 1,500 points at 2,000 seconds. A's composite is 1,500 × 16,777,216 + 16,776,215, and B's is 1,500 × 16,777,216 + 16,775,215. A's is larger by 1,000, so A ranks first. The API divides by 2²⁴ and drops the remainder before showing a score.

Two consequences:

- **Updates are no longer plain `ZINCRBY`.** Adding points also has to reset the time part to the current time. The worker reads the current score, computes the new composite and writes it with `ZADD`, in a small Lua script so the read and write are atomic. Because Kafka is keyed by player, one worker handles all of a player's updates in order, so there's no race.
- **Don't encode the time as a fraction**, as in points + (1 − timestamp ÷ max_timestamp). Above about a million points, a double doesn't have enough precision left in its fractional part to tell nearby timestamps apart, and ties quietly come back.

## Sharding

A single sorted set handles our numbers, but it's worth knowing the options for when it doesn't, or when one region or game mode needs isolation.

### Option 1: one primary, many read replicas

Keep the authoritative sorted set on one Redis primary and add replicas for reads. Our 6,000 writes a second are well within one primary's capacity, and 20,000 reads a second spread over a few replicas, plus the top-K cache, is light. This is the simplest design, and it keeps every query exact. Start here.

### Option 2: shard by score range

Split players into sorted sets by score band, each on its own node:

| Band | Points | Node |
|---|---|---|
| Bronze | 0 – 1,000 | 1 |
| Silver | 1,001 – 2,500 | 2 |
| Gold | 2,501 – 5,000 | 3 |
| Diamond | 5,001 and up | 4 |

- **Top K** reads only the highest band, assuming it holds at least K players.
- **A player's rank** is the number of players in all higher bands (`ZCARD` on each, which is O(1)) plus their rank within their own band.
- **Crossing a band** means removing the player from one set and adding them to another, which has to be done carefully so the player isn't briefly in both or neither.
- **Imbalance** is the main drawback. Scores are rarely spread evenly, so the bottom band usually holds most players and most updates. You end up re-cutting the bands as the season goes on.

### Option 3: shard by player ID

Hash `player_id` to pick one of N sorted sets. Updates are spread evenly, and each touches one shard.

- **A player's rank** becomes a question to every shard: `ZCOUNT key (score +inf` counts players with a strictly higher score, in O(log N). Add the counts from all shards, plus 1.
- **Top K** asks every shard for its top K and merges the results.

Both reads touch every shard, but each part is cheap, and the number of shards is small. This scales writes well and avoids the imbalance of score bands.

## Seasons and archiving

Most games run competitive seasons, with a fresh leaderboard each time.

1. **One key per season,** such as `leaderboard:s2026q4`. Starting a new season is just writing to a new key. Nothing is reset in place.
2. **Closing a season:**
   - At the cutoff, the API stops accepting results for the old season. Matches that ended before the cutoff but arrive late can be applied for a short grace period.
   - A job reads the final standings from Redis in pages with `ZRANGE` and writes them to durable storage, such as a table in the analytics warehouse or Parquet files in object storage. PostgreSQL already has every match, so the snapshot can be checked against it.
   - Rewards (titles, in-game items) are computed from the snapshot, not from the live key.
3. **Cleanup:** keep the old key in Redis for a few days so "last season" pages stay fast, then give it a TTL or delete it with `UNLINK`, which frees memory in the background instead of blocking the server.

## Check yourself

<details>
<summary>Why is "SELECT COUNT(*) + 1 FROM leaderboard WHERE score > ?" slow at tens of millions of players, and how does a Redis sorted set answer the same question quickly?</summary>

A standard B-tree index can find where a score sits, but it doesn't know how many entries come before that point. The database has to walk every entry above the player's score and count them. For a player in the middle of 10 million, that's millions of entries for one query, and thousands of such queries a second.

A Redis sorted set keeps a skip list in which every forward pointer records its span, the number of elements it jumps over. Searching for a player follows O(log N) pointers on average and adds up their spans along the way. When it reaches the player, the sum is the rank. For 10 million members that's a few dozen steps, done in memory in microseconds.

</details>

<details>
<summary>Two players have the same number of points. How do you rank the one who got there first higher, and why not just add a time-based fraction to the score?</summary>

Pack both values into one integer score: points × 2²⁴ plus (2²⁴ − 1 − seconds since the season started). One point outweighs any time value, so points still decide the order. Between equal points, the earlier time gives a larger number. The display score is the composite divided by 2²⁴, rounded down. The total stays below 2⁵³, so the double that Redis stores holds it exactly.

A fraction such as points + (1 − timestamp ÷ max) looks simpler, but a double has only 53 bits of precision in total. The bigger the points value, the fewer bits are left for the fraction, and nearby timestamps start rounding to the same value.

</details>

<details>
<summary>Kafka redelivers a score event after a worker restart. What stops the player from getting the points twice?</summary>

`ZINCRBY` adds the increment every time it runs, so it can't be retried safely on its own. The worker first inserts the match result into PostgreSQL, where `match_id` is unique. A redelivered event hits the unique constraint, and the worker skips the Redis update. The match table is the source of truth, and a reconciliation job compares it with Redis to catch the rare case where the insert succeeded but the Redis update didn't.

</details>

<details>
<summary>The Redis primary crashes. What could be lost, and how do you recover?</summary>

Replication is asynchronous, so the replica promoted by Sentinel or Redis Cluster may be missing the last few writes the primary accepted. With the append-only file set to `appendfsync everysec`, a restarted primary loses about a second of writes at most. Either way, the loss is in the leaderboard, not in the record of matches: every result is in Kafka and in PostgreSQL. Recovery replays recent events from Kafka, or in the worst case rebuilds the sorted set from the match table by summing each player's points for the season and loading them in batches with `ZADD`.

</details>

<details>
<summary>When would you shard by player ID instead of by score range?</summary>

When the write load outgrows one primary. Score ranges keep top-K reads on one shard, but most players and updates pile into the lower bands, and players moving between bands need careful two-step moves. Hashing by player ID spreads writes evenly and never moves players. The cost is that rank and top-K queries ask every shard (`ZCOUNT` for rank, each shard's top K for the merge), which is fine with a small number of shards.

</details>

## Further reading

- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/): the official guide to sorted sets, including a leaderboard example.
- [Redis ZRANGE command](https://redis.io/docs/latest/commands/zrange/): the unified range command with `REV`, `BYSCORE` and `LIMIT`, and its time complexity.
- [Skip Lists: A Probabilistic Alternative to Balanced Trees](https://15721.courses.cs.cmu.edu/spring2018/papers/08-oltpindexes1/pugh-skiplists-cacm1990.pdf): William Pugh's 1990 paper in *Communications of the ACM* that introduced the skip list.
- [Redis source: t_zset.c](https://github.com/redis/redis/blob/unstable/src/t_zset.c): the sorted set implementation, including the skip list with spans that makes rank queries O(log N).
- [Build a real-time gaming leaderboard with Amazon ElastiCache for Redis](https://aws.amazon.com/blogs/database/building-a-real-time-gaming-leaderboard-with-amazon-elasticache-for-redis/): an AWS Database Blog walkthrough of a sorted-set leaderboard on a managed Redis service.
