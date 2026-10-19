# Design a social media news feed (like Facebook, Instagram, or Twitter)

A news feed collects recent posts from the people and pages a user follows, orders or ranks them, and shows them as one scrolling list. When the user opens the app, they expect a fresh feed in a few hundred milliseconds, and they expect scrolling to keep going without repeats or gaps.

This is a common interview question because it forces one central decision: do you build each user's feed when someone posts (**fan-out on write**, or push) or when someone reads (**fan-out on read**, or pull)? Each choice breaks down somewhere, most visibly on accounts with tens of millions of followers. The question also covers caching timelines for hundreds of millions of users, pagination over a list that keeps changing, and ranking.

It builds on the chapters on [relational databases](/learn/relational-databases), [caching](/learn/cache), [queues and asynchronous work](/learn/queues-and-async), [event streaming](/learn/event-streaming), [unique IDs](/learn/unique-ids) and [rate limiting](/learn/rate-limiting).

## Requirements and estimates

### Functional requirements

1. **Publish:** users post text, images and video.
2. **View feed:** users see posts from the accounts they follow, newest or most relevant first.
3. **Follow:** users follow and unfollow other accounts.
4. **Pagination:** users scroll through the feed without seeing duplicates or skipping posts.

### Non-functional requirements

1. **Fast reads:** the first page of the feed loads in under 200 ms at the 99th percentile.
2. **High availability:** reading the feed keeps working when parts of a data center fail. A feed that is a little stale is far better than one that doesn't load.
3. **Eventual consistency:** a delay of a few seconds between a post and its appearance in followers' feeds is acceptable. The author should see their own post immediately, though; the client can insert it locally.
4. **Read-heavy traffic:** feed loads far outnumber posts.

### Capacity estimates

These numbers are assumptions for a large consumer app, not figures from any real one:

- **Users:** 300 million daily active users, each following 300 accounts on average.
- **Posts:** 100 million new posts a day. 100,000,000 ÷ 86,400 s ≈ 1,160 posts a second on average. With a peak of 3× average, plan for about **3,500 posts a second**.
- **Feed loads:** each user opens or refreshes the feed 10 times a day. 300M × 10 = 3 billion loads a day, and 3 × 10⁹ ÷ 86,400 s ≈ 35,000 a second on average, or about **100,000 a second** at peak. That's 30 feed loads for every post.
- **Fan-out writes:** every follow has one follower and one followee, so the average account also has 300 followers. If every post were pushed to every follower, that would be 100M × 300 = 30 billion timeline inserts a day, 30 × 10⁹ ÷ 86,400 s ≈ 350,000 a second on average and about **1 million a second** at peak. Under fan-out on write, the cache receives ten times more writes than there are feed loads. The work hasn't gone away; it has moved from read time to write time.
- **Post storage:** 100M posts × 500 bytes of metadata (IDs, text, timestamps, media URLs) = 50 GB a day, about 18 TB a year. Images and video go to object storage behind a CDN; the database stores only their URLs.
- **Timeline cache:** keep the newest 500 post IDs for each daily user. Each ID is 8 bytes, so the raw data is 500 × 8 B = 4 KB per user and 300M × 4 KB ≈ 1.2 TB in total. The data structure adds overhead, though. A Redis sorted set with 500 members uses something like 64 bytes per entry once you count the score, pointers and hash table, so assume 500 × 64 B = 32 KB per user, or **about 10 TB**, and about 20 TB with one replica. At 100 GB of usable memory per node, that's around 200 cache nodes. Storing IDs in a packed list instead of a sorted set brings it much closer to the raw 1.2 TB, which is what Twitter did with its Redis timelines.

Two things stand out. Fan-out on write turns each post into hundreds of cache writes. And the cache's size depends on how timelines are encoded as much as on how many IDs they hold.

## Data model and API

### Core schema

```sql
-- MySQL syntax. Posts are sharded by user_id; follows by follower_id,
-- with a second copy sharded by followee_id for "who follows X?".
CREATE TABLE users (
    user_id     BIGINT PRIMARY KEY,
    username    VARCHAR(64) NOT NULL,
    created_at  TIMESTAMP NOT NULL
);

CREATE TABLE follows (
    follower_id  BIGINT NOT NULL,
    followee_id  BIGINT NOT NULL,
    created_at   TIMESTAMP NOT NULL,
    PRIMARY KEY (follower_id, followee_id),
    INDEX idx_followee (followee_id)
);

CREATE TABLE posts (
    post_id     BIGINT PRIMARY KEY,   -- time-ordered, Snowflake style
    user_id     BIGINT NOT NULL,
    content     TEXT,
    media_url   VARCHAR(1024),
    created_at  TIMESTAMP NOT NULL,
    INDEX idx_user_created (user_id, created_at DESC)
);
```

`post_id` is a time-ordered ID (see [unique IDs](/learn/unique-ids)), so sorting by ID is close to sorting by creation time, and any server can mint one without coordination.

### Feed API

Publishing a post:

```http
POST /api/v1/posts HTTP/1.1
Content-Type: application/json

{
  "content": "Excited to launch our new product today!",
  "media_url": "https://cdn.example.com/images/prod.jpg"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "post_id": 98234190241,
  "created_at": 1735689600
}
```

Reading the feed, one page at a time. The `cursor` is an opaque token from the previous response:

```http
GET /api/v1/feed?limit=20&cursor=eyJwb3N0X2lkIjo5ODI HTTP/1.1
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "items": [
    {
      "post_id": 98234190241,
      "user_id": 14205,
      "content": "Excited to launch...",
      "created_at": 1735689600
    }
  ],
  "next_cursor": "eyJwb3N0X2lkIjo5ODA"
}
```

## The central decision: push vs pull

When someone posts, who does the work of putting that post into feeds: the system at write time, or each reader at read time?

### Approach 1: fan-out on read (pull)

Posts are stored once, under their author. No feeds are precomputed.

When Alice opens the app:

1. The feed service looks up everyone Alice follows: 300 accounts.
2. It fetches the newest posts from each of them, for example `SELECT ... FROM posts WHERE user_id IN (...300 IDs...) ORDER BY created_at DESC LIMIT 20`. With posts sharded by `user_id`, that's a query to many shards, each walking the `(user_id, created_at)` index for its authors.
3. It merges the results by time and returns the top 20.

- **Pros:**
  - Posting is one insert, no matter how many followers the author has.
  - No storage or work is spent on users who never open the app.
  - A new follow or unfollow takes effect on the very next load.
- **Cons:**
  - Each feed load does work proportional to the number of accounts followed. At 100,000 loads a second × 300 followees, that's up to 30 million per-author index lookups a second, spread over many shards. The slowest shard sets the latency of every load.
  - It's hard to stay under 200 ms at the 99th percentile for users who follow thousands of accounts.

### Approach 2: fan-out on write (push)

Every user has a precomputed timeline in an in-memory store: a list of post IDs, newest first. Redis sorted sets are a common choice, with the post's timestamp as the score.

When Bob publishes a post:

1. The post service saves the post to the database.
2. A fan-out worker fetches Bob's followers.
3. For each follower, it adds Bob's `post_id` to that follower's timeline, for example `ZADD timeline:alice <timestamp_ms> <post_id>`, then trims the timeline to its newest 500 entries.
4. When Alice opens the app, her feed is already assembled. Reading the first page is `ZREVRANGE timeline:alice 0 19`, which costs O(log N + M) for M returned entries: well under a millisecond inside Redis.

- **Pros:**
  - Feed reads are fast and predictable, and cost the same no matter how many accounts the reader follows.
- **Cons:**
  - **The celebrity problem.** An account with 80 million followers posts, and the fan-out workers must make 80 million timeline writes. If the fleet can sustain 1 million timeline writes a second in total, that single post takes 80 seconds of the whole fleet's capacity, and ordinary users' posts wait behind it. Followers also see the post at very different times, since some timelines get it a minute later than others.
  - **Wasted work.** Many followers won't open the app before the post scrolls out of their 500-entry timeline. Writing to their timelines was pointless.
  - **Follow changes are slow to show.** A new follow doesn't backfill old posts unless you add that step, and an unfollow leaves the old account's posts in the cached timeline until they are filtered out at read time.

### Approach 3: the hybrid model

Large platforms combine the two. Twitter described this publicly in 2012–2013: ordinary accounts are pushed to followers' timelines, while accounts with very large followings are skipped during fan-out and merged in when a timeline is read.

```diagram
title: Hybrid fan-out: push for most authors, pull for celebrities
[author:client] Ordinary\nauthor @ 0,0
[celeb:client] Celebrity @ 0,2.4
[post] Post service @ 1,1.2
[q:queue] Fan-out\nqueue @ 2.2,0
[worker] Fan-out\nworkers @ 3.4,0
[tl:store] Timeline\ncache @ 4,1.2
[pc:store] Posts DB\n+ post cache @ 2.2,2.4
[feed] Feed service @ 3.4,2.4
[reader:client] Reader @ 3.4,3.4
author -> post
celeb -> post
post --> q : ordinary only
q --> worker
worker -> tl : push post_id
post -> pc : save post
reader -> feed : GET /feed
feed -> tl : 1. timeline
feed -> pc : 2. celebrity posts
```

1. **Ordinary authors** (below a follower threshold, say 100,000; the number is a tuning choice): fan out on write. Workers push the post ID into every follower's timeline.
2. **Celebrities** (above the threshold): no fan-out. The post is saved once, like every post, and added to a small cached list of that author's recent posts.
3. **At read time:** the feed service reads the user's precomputed timeline, fetches the recent-post lists of the celebrities the user follows, merges them by time (or hands the combined set to ranking), and returns the top 20.

The read-side cost is now proportional to the number of celebrities a user follows, not the number of accounts. Celebrity post lists are read by millions of users, which makes them ideal cache entries: one hot key per celebrity, replicated across several cache nodes so one node doesn't take all the reads.

Two refinements are common:

- **Skip inactive followers.** Don't fan out to users who haven't opened the app in, say, 30 days. If one returns, rebuild their timeline with a pull query the first time, then resume pushing.
- **Choose per author, or even per pair.** The threshold doesn't have to be a single cut-off. Research such as Yahoo's "Feeding Frenzy" paper picks push or pull for each (author, follower) pair, based on how often the author posts compared with how often the follower reads.

## End-to-end architecture

```diagram
title: News feed architecture
[client:client] Client app @ 0,1
[post] Post service @ 1,0
[db:store] Posts DB\n+ post cache @ 2,0
[kafka:queue] Kafka\n(post events) @ 1,1
[worker] Fan-out\nworkers @ 2,1
[graph:store] Follow graph @ 3,1
[feed] Feed service @ 1,2
[tl:store] Timeline\ncache @ 2,2
[rank] Ranking service @ 1,3
client -> post : publish
client -> feed : fetch feed
post -> db : save
post --> kafka : post event
kafka --> worker
worker -> graph : followers
worker -> tl : push post_id
feed -> tl : read timeline
feed <-> rank : score
```

### The publishing flow

1. The client uploads any image or video straight to object storage with a pre-signed URL, then sends the post's metadata to the **post service**.
2. The post service writes the post to the posts database (sharded by `user_id`), with a `post_id` minted from a time-ordered ID generator.
3. It publishes `{post_id, author_id, created_at}` to a Kafka topic and returns `201` to the client. Fan-out happens off the author's request path.
4. **Fan-out workers** consume the event:
   - They look up the author's follower count in the follow graph. Above the threshold, they only add the post to the author's recent-posts list and stop.
   - Otherwise they page through the author's followers, skipping inactive ones, and for each one add the post ID to `timeline:<follower_id>` and trim it to 500 entries.
   - The Kafka topic is partitioned by `author_id`, so one author's posts are processed in order, and a burst of posts is absorbed by the queue instead of by the cache.

### The feed reading flow

1. The client calls `GET /api/v1/feed?limit=20`.
2. The **feed service** reads a batch of candidate IDs from the user's timeline, more than one page so ranking has something to choose from, and the recent posts of any celebrities the user follows.
3. It drops posts that have since been deleted and posts from accounts the user has unfollowed or blocked.
4. The **ranking service** scores the candidates and returns them in order. A purely chronological feed skips this step.
5. The feed service fetches the full posts (text, media URLs, author name and avatar) for the top 20 from the post cache with one multi-get, and returns them.

With every step served from memory, the whole read takes a few tens of milliseconds, comfortably inside the 200 ms budget. Ranking is usually the most expensive step.

## Cursor-based pagination: why offsets fail

The obvious way to page through a list is `OFFSET` and `LIMIT`:

```sql
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 20;
```

For a feed this goes wrong in two ways:

1. **Duplicates and gaps.** Alice loads page 1, posts 1 to 20. While she reads, 5 new posts arrive at the top. Page 2 (`OFFSET 20`) now starts at what was position 16, so she sees posts 16–20 again. If posts above her position are deleted instead, items shift the other way and she skips some.
2. **Cost grows with depth.** `OFFSET 100000` makes the database walk 100,020 index entries and throw away the first 100,000, so deep pages get slower and slower.

### Keyset (cursor-based) pagination

A **cursor** records where the last page ended: the sort key of the last item the client saw. The next query starts strictly after it:

```sql
SELECT post_id, content, created_at
FROM posts
WHERE (created_at, post_id) < (:cursor_created_at, :cursor_post_id)
ORDER BY created_at DESC, post_id DESC
LIMIT 20;
```

`post_id` is in the comparison as a tie-breaker, because two posts can share a timestamp. With an index on the sort columns, this is one index seek followed by reading 20 entries: O(log n), the same cost for page 1 as for page 5,000. New posts arriving at the top don't move the position the cursor points to.

In a Redis sorted set, the same idea uses the score:

```text
ZRANGE timeline:alice (1735689600123 -inf BYSCORE REV LIMIT 0 20
```

The `(` makes the bound exclusive, so the query returns the 20 entries with scores strictly below the last one seen. (`ZREVRANGEBYSCORE` does the same on older Redis versions.) Scores are 64-bit floating-point numbers, which hold integers exactly only up to 2⁵³, so a full 64-bit Snowflake ID can't safely be used as a score. Use a millisecond timestamp, and put the last post ID in the cursor too, so ties on the same millisecond don't drop posts.

A **ranked** feed isn't sorted by any single key, so keyset pagination doesn't apply directly. A common approach is to rank a batch of candidates when the session starts, store that ordered list briefly, and have the cursor point into it. New posts appear on the next refresh, not in the middle of a scroll.

## Feed ranking and personalization

Early feeds were strictly reverse-chronological. Most large platforms now rank by predicted interest, often with a chronological option alongside.

Ranking usually runs in two stages:

1. **Candidate generation.** Gather a few hundred candidate post IDs cheaply: the user's precomputed timeline, celebrity posts, and sometimes posts from outside the follow graph that the user is likely to want (the [recommendation system](/learn/design-recommendation-system) chapter covers that side).
2. **Scoring.** A machine learning model predicts how likely the user is to engage with each candidate, from features such as:
   - **Affinity:** how often the reader likes, comments on or messages the author.
   - **Content type:** whether this reader tends to engage with video, photos or text.
   - **Freshness:** older posts are discounted. One simple form is an exponential decay:

     ```text
     score = predicted engagement × e^(−λ × age)
     ```

     With λ = ln 2 ÷ 6 hours, a post's score halves every 6 hours.
   - **Early engagement:** posts that are collecting likes and replies quickly get a boost.

The feed service sorts by the final score, applies rules such as "no more than two posts in a row from the same author", and returns the top 20. Because ranking takes a few hundred candidates as input, the timeline cache has to hold more than one page per user, which is one reason it keeps hundreds of entries.

## Check yourself

<details>
<summary>Why is fan-out on write a problem for accounts with tens of millions of followers, and how does the hybrid model fix it?</summary>

With pure fan-out on write, each post is copied into the timeline of every follower. A post from an account with 50 million followers is 50 million cache writes. That takes a large share of the fan-out fleet's capacity for a minute or more, delays posts from everyone else that are queued behind it, and makes the post show up for different followers at very different times.

The hybrid model skips fan-out for accounts above a follower threshold. Their posts are stored once and kept in a small, heavily cached list of recent posts per author. When a user loads the feed, the feed service merges their precomputed timeline with the recent posts of the few celebrities they follow. The cost moves to read time, but it's proportional to the number of celebrities followed, which is small, and those lists are hot cache entries shared by millions of readers.

</details>

<details>
<summary>Why does OFFSET/LIMIT pagination show duplicate posts during infinite scroll?</summary>

Because new posts keep arriving at the top. Suppose a user sees page 1 (`OFFSET 0 LIMIT 10`), positions 1 to 10. Three new posts are published. Everything shifts down by three, so the posts that were at positions 8, 9 and 10 are now at 11, 12 and 13. Page 2 (`OFFSET 10 LIMIT 10`) returns positions 11 to 20, which starts with those three posts again.

A cursor records the sort key of the last item shown, such as `(created_at, post_id)`, and the next page asks for items strictly after it. Inserts above that point don't change where it is, so there are no duplicates.

</details>

<details>
<summary>How do you stop the timeline cache from growing forever?</summary>

Cap each timeline and expire timelines nobody reads:

1. **Trim on write.** After each `ZADD`, the worker keeps only the newest 500 entries. Sorted-set ranks count up from the lowest score, which is the oldest post, so the command that removes everything except the 500 highest scores is `ZREMRANGEBYRANK timeline:<user_id> 0 -501`. Older posts are still reachable by falling back to a pull query if someone scrolls that far.
2. **Expire inactive timelines.** Give each timeline a TTL, say 30 days, refreshed when the user reads it, and skip fan-out to users who have been inactive that long. If such a user returns, rebuild their timeline from the database on the first load.

</details>

<details>
<summary>Under fan-out on write, the read path got cheaper. Did the system as a whole get cheaper?</summary>

Not necessarily. With these estimates, pushing each post to 300 followers is 30 billion timeline writes a day, ten times the 3 billion feed loads. Fan-out on write is a good trade because those writes are cheap, asynchronous and off the user's path, while reads are on the path and need predictable latency. It is not less work. That's also why skipping inactive followers and celebrities matters so much: they're where most of the wasted writes are.

</details>

## Further reading

- [Timelines at Scale (Raffi Krikorian, QCon San Francisco 2012)](https://www.infoq.com/presentations/Twitter-Timeline-Scalability/): how Twitter's home timeline used Redis, fanned out on write, and handled very large accounts differently.
- [Designing Data-Intensive Applications (Martin Kleppmann)](https://dataintensive.net/): chapter 1 uses Twitter's home timeline to explain fan-out on write vs read, and why the hybrid exists.
- Adam Silberstein et al., "Feeding Frenzy: Selectively Materializing Users' Event Feeds", SIGMOD 2010: choosing push or pull for each author-follower pair based on posting and reading rates.
- [Redis sorted set commands](https://redis.io/docs/latest/develop/data-types/sorted-sets/): `ZADD`, `ZRANGE ... BYSCORE REV LIMIT`, and `ZREMRANGEBYRANK`, used above for timelines and cursors.
