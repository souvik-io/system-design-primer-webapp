# Design the Twitter timeline and search

Twitter is a service where people post short public messages called **tweets**. When you **follow** someone, their tweets show up in your **home timeline**, the feed of tweets from everyone you follow. The tweets one person has posted make up their **user timeline**. Anyone can also **search** all recent tweets by keyword, for example "world cup final".

Those features pull the design in different directions. One tweet from a user with 30 million followers has to appear in 30 million home timelines within seconds. Millions of people open their home timeline many times a day and expect it to load instantly. Search has to find a tweet posted ten seconds ago among billions of others. The interesting question is where to do the work: when a tweet is written, when a timeline is read, or somewhere in between.

"Design the Facebook feed" and "Design Facebook search" are close cousins of this question, so the same answer works for them with small changes.

This chapter follows the four steps from [The system design interview, step by step](/learn/system-design-interview). The [social news feed](/learn/design-social-news-feed) chapter goes deeper into fan-out strategies, cursor pagination and ranking. This one covers enough fan-out to stand alone, then spends its depth on the parts specific to Twitter: the services that build and read timelines, keyword search, notifications, and how each piece scales.

## Step 1: Outline use cases, constraints and assumptions

### Use cases

We'll scope the problem to these use cases:

- **A user posts a tweet.**
  - The service pushes the tweet to the user's followers, and sends push notifications and emails to followers who asked for them.
- **A user views their user timeline**, meaning their own tweets.
- **A user views their home timeline**, meaning tweets from the people they follow.
- **A user searches by keyword.**
- **The service is highly available.** Reading timelines keeps working when individual machines fail.

### Out of scope

- **Pushing tweets to the firehose and other streams.** A **firehose** is a stream of every public tweet as it's posted.
- **Visibility rules** that remove tweets from a timeline based on a user's settings. Two examples:
  - Hide an @reply (a tweet that starts by addressing another user) unless the reader also follows the person being replied to.
  - Respect a user's "hide retweets" setting for an account they follow.
- **Analytics**, such as counting impressions or engagement.

### Assumptions

These numbers are hypothetical inputs for the exercise. They describe no real service.

General:

- Traffic is not evenly distributed. Big events cause spikes, and some users have vastly more followers than others.
- Posting a tweet should be fast for the author.
- Delivering a tweet to all followers should be fast too, unless the author has millions of followers.
- There are 100 million active users.
- Users post 500 million tweets a day, or 15 billion a month.
- Each tweet is delivered to 10 followers on average. That's 5 billion deliveries a day, or 150 billion a month.
- There are 250 billion read requests a month.
- There are 10 billion searches a month.

Timeline:

- Viewing a timeline should be fast.
- The service is far more read-heavy than write-heavy, so we optimize for fast reads of tweets.
- Ingesting tweets, meaning accepting and delivering them, is write-heavy.

Search:

- Searching should be fast.
- Search is read-heavy.

### Calculate usage

Ask the interviewer whether they want these numbers before working them out. A month has 30 × 86,400 s = 2,592,000 seconds, about 2.6 million. All rates below are averages. Because traffic is uneven, we'll also assume peaks of about 3× the average.

**Size of one tweet.**

- `tweet_id`: 8 bytes (a 64-bit integer).
- `user_id`: 8 bytes (also a 64-bit integer).
- `text`: 140 bytes, if the text is ASCII. A 140-character tweet in other scripts or with emoji takes more bytes, because UTF-8 uses up to 4 bytes per character.
- `media` (photos and video): 10 KB on average across all tweets, since most tweets have none.
- Total: about 10 KB per tweet. The media is almost all of it.

**Storage.**

- New tweet content per day: 10 KB × 500 million = 5 TB.
- Per month: 5 TB × 30 = 150 TB.
- Over 3 years: 150 TB × 36 = 5.4 PB.
- Text and metadata alone, about 200 bytes per tweet with timestamps and a reply-to id, is 500 million × 200 B = 100 GB a day: 3 TB a month and about 108 TB over 3 years. So about 98% of the bytes are media.

**Request rates.**

- Tweets posted: 500 million ÷ 86,400 s ≈ **5,800 a second**, or about 17,000 a second at peak.
- Fan-out deliveries: 5 billion ÷ 86,400 s ≈ **58,000 a second**, or about 175,000 a second at peak.
- Read requests: 250 billion ÷ 2,592,000 s ≈ **96,000 a second**, or about 290,000 a second at peak.
- Searches: 10 billion ÷ 2,592,000 s ≈ **3,900 a second**, or about 12,000 a second at peak.
- Reads per tweet: 250 billion reads ÷ 15 billion tweets ≈ 17.

**Bandwidth.**

- Incoming: 5,800 tweets a second × 10 KB ≈ 58 MB/s, about 460 Mbps on average.
- Outgoing, without media: assume a timeline response of 20 tweets with author names and media links is about 20 KB of JSON. 96,000 × 20 KB ≈ 1.9 GB/s, about 15 Gbps on average. Photos and videos come from a CDN and aren't included.

**Memory for home timelines.**

- One timeline entry holds a tweet id, the author's user id and one byte of flags: 8 + 8 + 1 = 17 bytes.
- Keep the newest 800 entries per user: 800 × 17 B = 13,600 B ≈ 13.6 KB per user.
- For 100 million active users: 100 million × 13.6 KB ≈ 1.4 TB.
- With 3 copies of each timeline for availability: about 4 TB, before the overhead of the cache's data structures.

**What these numbers tell us.**

- Reads outnumber writes 17 to 1, so the home timeline should be ready before anyone asks for it.
- Fan-out turns 5,800 tweets a second into 58,000 timeline writes a second. Each write is 17 bytes, about 1 MB/s in total, so the challenge is the count of operations. That many small writes would strain a relational database and are easy for an in-memory store.
- All home timelines fit in a few terabytes of RAM across a cluster, so keeping them in memory is practical.
- Media is 98% of storage. Put it in an object store behind a CDN and keep it out of the database.
- Search at 3,900 queries a second over billions of tweets needs its own specialized cluster.

The [estimation](/learn/estimation) chapter explains the method behind this arithmetic.

## Step 2: Create a high-level design

```diagram
title: Twitter timeline and search, first version
[client:client] Client @ 0,2.1
[web] Web server\n(reverse proxy) @ 1,2.1
[obj:store] Object store\n(media) @ 1,0.4
[sql:store] SQL database @ 1,4.4
[sapi] Search API @ 2,0
[write] Write API @ 2,1.8
[read] Read API @ 2,4.2
[ss] Search service @ 3,0
[fan] Fan-out service @ 3,1.8
[notif] Notification\nservice @ 3,3
[tl] Timeline service @ 3,4.2
[cluster:store] Search cluster @ 4,0
[graph] User graph\nservice @ 4,1.3
[cache:store] Memory cache @ 4,2.6
[tinfo] Tweet info\nservice @ 4,3.9
[uinfo] User info\nservice @ 4,5.1
client -> web
web -> sapi
web -> write
web -> read
sapi -> ss
ss -> cluster
write -> obj
write -> sql
write -> fan
fan -> cluster
fan -> graph
fan -> cache
fan --> notif
read -> tl
read -> sql
tl -> cache
tl -> tinfo
tl -> uinfo
```

Each component, and why it's there:

- **Web server:** a **reverse proxy**, meaning a server in front of the application servers that receives every request and forwards it to the right API. See [reverse proxies](/learn/reverse-proxy-and-api-gateway-101).
- **Write, read and search APIs:** separate entry points, because posting, reading and searching scale differently.
- **SQL database:** the durable record of every tweet, user and follow. It also serves the user timeline.
- **Object store:** holds photos and videos, which are 98% of the bytes.
- **Fan-out service:** copies each new tweet's id into every follower's home timeline, adds the tweet to the search index, and triggers notifications.
- **User graph service:** answers "who follows this user?" and "whom does this user follow?" from memory.
- **Memory cache:** an in-memory key-value store, such as Redis, holding each active user's home timeline as a list of ids.
- **Timeline service:** reads a home timeline from the memory cache and fills in each tweet and author.
- **Tweet info and user info services:** return full tweets and author profiles for a batch of ids.
- **Search service and search cluster:** the service parses queries, and the cluster holds an index of recent tweets split across many servers.
- **Notification service:** sends push notifications and emails through a queue, so the author never waits for them.

## Step 3: Design core components

### Use case: User posts a tweet

Posting has two jobs: save the tweet in the author's user timeline, and deliver it to every follower's home timeline.

**Saving the tweet.** The user timeline fits a relational database well. Each tweet is one row, and "user 123's tweets, newest first" is one index lookup.

```sql
CREATE TABLE users (
    user_id     BIGINT PRIMARY KEY,
    handle      VARCHAR(15) NOT NULL UNIQUE,
    name        VARCHAR(50) NOT NULL,
    created_at  TIMESTAMP NOT NULL
);

CREATE TABLE tweets (
    tweet_id           BIGINT PRIMARY KEY,   -- time-ordered, so newer ids are larger
    user_id            BIGINT NOT NULL,
    text               VARCHAR(140) NOT NULL,
    media_ids          VARCHAR(255),         -- keys in the object store, if any
    reply_to_tweet_id  BIGINT NULL,
    created_at         TIMESTAMP NOT NULL,
    INDEX idx_user_timeline (user_id, tweet_id DESC)
);

CREATE TABLE follows (
    follower_id  BIGINT NOT NULL,
    followee_id  BIGINT NOT NULL,
    created_at   TIMESTAMP NOT NULL,
    PRIMARY KEY (follower_id, followee_id),   -- whom does X follow?
    INDEX idx_followers (followee_id, follower_id)   -- who follows X?
);
```

Tweet ids are **time-ordered**: a later id is always larger, so sorting by `tweet_id` sorts by time, and any server can create ids without a central counter. See [Snowflake-style IDs](/learn/unique-ids#snowflake-style-ids). A NoSQL store would also work, since every access is by `tweet_id` or `user_id` (see [SQL or NoSQL](/learn/nosql-databases#sql-or-nosql-making-the-choice)). We start with SQL and revisit it in step 4.

**Delivering the tweet.** Delivery is the hard part. At 58,000 deliveries a second on average and 175,000 at peak, writing each one as a row in a relational database would overload it, because every insert updates indexes and writes a log to disk. We want a store with very fast writes: a NoSQL database or an in-memory cache. Memory also wins on reads. In the latency table credited to Jeff Dean and Peter Norvig (circa 2012), reading 1 MB sequentially takes about 250 µs from memory, 4 times longer from an SSD, and 80 times longer from a spinning disk.

Photos and videos go to an **object store**, a storage service for large files addressed by key. The client uploads them first and gets back media ids, which the tweet refers to.

**The write path, step by step:**

1. The client sends the tweet to the web server, which forwards it to the write API.
2. The write API checks the request, creates a time-ordered `tweet_id`, and saves the tweet's media in the object store if it came with the request.
3. The write API inserts the tweet into the `tweets` table. This is the author's user timeline.
4. The write API hands the tweet to the fan-out service and returns `201 Created` to the client. The author doesn't wait for delivery.
5. The **fan-out service**:
   - asks the **user graph service** for the author's followers, which it keeps in the memory cache;
   - adds the tweet to the **home timeline of each follower** in the memory cache. This is O(n) in the number of followers: 1,000 followers means 1,000 lookups and 1,000 inserts;
   - adds the tweet to the **search index** so it can be found by keyword;
   - asks the **notification service** to send push notifications and emails to followers who turned them on. The notification service puts the jobs on a **queue**, and separate workers send them, so a slow email provider can't slow down delivery.

**Fan-out on write, and its weak spot.** This approach is called **fan-out on write**, or push. Each home timeline is built when tweets are posted, so a read just fetches a finished list. The opposite is **fan-out on read**, or pull: nothing is precomputed, and opening the app looks up everyone you follow, fetches their recent tweets and merges them. Pull makes posting cheap and reading expensive. Push does the reverse.

Push has a weak spot: users with huge followings. One tweet from an account with 30 million followers needs 30 million timeline inserts. If the fan-out fleet is sized for our peak of 175,000 deliveries a second, that's 30,000,000 ÷ 175,000 ≈ 171 seconds, almost 3 minutes of the entire fleet's capacity. Everyone else's tweets wait behind it. This is the **celebrity problem**. Step 4 fixes it with a **hybrid**: push for most authors and pull for the few with the most followers. The [social news feed](/learn/design-social-news-feed#approach-3-the-hybrid-model) chapter compares push, pull and the hybrid in depth.

**What a home timeline looks like in memory.** If the memory cache is Redis, each home timeline can be a Redis **list**: an ordered sequence of values under one key, such as `home:456`. Each element is 17 bytes:

```
          newest tweet                 next tweet                  older tweet
| 8 bytes   8 bytes   1 byte | 8 bytes   8 bytes   1 byte | 8 bytes   8 bytes   1 byte |
| tweet_id  user_id   flags  | tweet_id  user_id   flags  | tweet_id  user_id   flags  |
```

The `flags` byte marks things like "this is a retweet" or "this is a reply", for filtering at read time. The list stores only ids. Text and author names are looked up when the timeline is read, which keeps entries small and means a profile edit doesn't rewrite millions of timelines.

Ask the interviewer how much code they expect. Here is the fan-out service as a short Python sketch:

```python
import struct

ENTRY = struct.Struct(">QQB")   # tweet_id, user_id, flags: 17 bytes
TIMELINE_LENGTH = 800           # entries kept per home timeline
BATCH_SIZE = 1_000              # followers handled per round trip

def fan_out(tweet, user_graph, timelines, search_index, notifications):
    """Deliver one new tweet. Runs after the tweet is saved in SQL."""
    search_index.add(tweet)     # one write, to one search shard

    entry = ENTRY.pack(tweet.tweet_id, tweet.user_id, tweet.flags)
    for batch in user_graph.followers(tweet.user_id, batch_size=BATCH_SIZE):
        pipe = timelines.pipeline()   # send many commands in one round trip
        for follower_id in batch:
            key = f"home:{follower_id}"
            pipe.lpush(key, entry)                       # newest at the head
            pipe.ltrim(key, 0, TIMELINE_LENGTH - 1)      # drop the oldest
        pipe.execute()

    subscribers = user_graph.notification_subscribers(tweet.user_id)
    if subscribers:
        notifications.enqueue({"tweet_id": tweet.tweet_id,
                               "recipients": subscribers})
```

A few details matter:

- `LPUSH` then `LTRIM key 0 799` caps the list at 800 entries. The Redis documentation notes that `LTRIM` is O(1) in this pattern, because usually one element falls off the end.
- Each batch goes out as one **pipeline**, a group of commands sent together, instead of 1,000 separate round trips. In a real cluster the service first groups each batch by cache server.
- The fan-out service is a pool of workers reading new tweets from a queue, so a burst waits in the queue instead of overwhelming the cache.

**The API.** The public API is REST over HTTPS. **REST** means each URL names a resource and standard HTTP methods act on it. See [REST](/learn/protocols-and-apis#rest-resources-and-representations).

```http
POST /api/v1/tweets HTTP/1.1
Host: api.twitter.example
Authorization: Bearer ABC123
Content-Type: application/json

{
  "status": "hello world!",
  "media_ids": ["ABC987"]
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "tweet_id": "1849203948572610560",
  "user_id": "123",
  "status": "hello world!",
  "media_ids": ["ABC987"],
  "created_at": "2026-10-19T14:03:11Z"
}
```

The server learns the author from the access token, so the client doesn't send `user_id`. Ids are strings in JSON because a 64-bit integer can lose precision when JavaScript reads it as a number.

Inside the data center, services call each other with **RPC** (remote procedure calls), such as `TweetInfo.MultiGet(ids)`. RPC frameworks send compact binary messages, which suits many small internal calls. See [RPC and REST side by side](/learn/protocols-and-apis#rpc-and-rest-side-by-side).

### Use case: User views the home timeline

Thanks to fan-out on write, the home timeline is already built. Reading it means fetching a list of ids and filling in the details, called **hydration**.

1. The client requests the home timeline from the web server.
2. The web server forwards the request to the read API.
3. The read API calls the **timeline service**, which:
   - reads the user's list from the memory cache. The cost doesn't depend on how many people the user follows. Redis documents `LRANGE` as O(S + N), where S is the start offset and N the number of entries returned, so reading from the head costs only the entries read;
   - asks the **tweet info service** for the full tweets, with one **multiget** (a single request for many keys, such as Redis's `MGET`). This is O(n) in the number of tweets on the page;
   - asks the **user info service** for the authors' profiles, with another multiget, also O(n);
   - joins the results and returns them, newest first.

```python
def home_timeline(user_id, count=20, max_id=None):
    raw = timelines.lrange(f"home:{user_id}", 0, TIMELINE_LENGTH - 1)
    if not raw and not timelines.exists(f"home:{user_id}"):
        raw = rebuild_timeline(user_id)   # inactive user: see step 4

    entries = [ENTRY.unpack(r) for r in raw]   # (tweet_id, user_id, flags)
    if max_id is not None:                     # the next page starts below
        entries = [e for e in entries if e[0] < max_id]
    page = entries[:count]

    tweets = tweet_info.multiget([tweet_id for tweet_id, _, _ in page])
    users = user_info.multiget({author_id for _, author_id, _ in page})
    return [
        {**tweets[tweet_id], "user": users[author_id]}
        for tweet_id, author_id, _ in page
        if tweet_id in tweets   # skip tweets deleted since delivery
    ]
```

The client pages backward with `max_id`, meaning "tweets older than the last one I saw." Because tweet ids grow with time, this works as a cursor, and new tweets arriving at the top don't shift later pages. See [cursor-based pagination](/learn/design-social-news-feed#cursor-based-pagination-why-offsets-fail). Reading the whole 800-entry list is only 13.6 KB, so the sketch keeps it simple.

The API:

```http
GET /api/v1/home_timeline?count=20 HTTP/1.1
Authorization: Bearer ABC123
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "tweets": [
    {"tweet_id": "1849203948572610560", "user_id": "456",
     "user": {"handle": "ada", "name": "Ada"}, "status": "foo"},
    {"tweet_id": "1849203911134265345", "user_id": "789",
     "user": {"handle": "grace", "name": "Grace"}, "status": "bar"},
    {"tweet_id": "1849203870012846080", "user_id": "789",
     "user": {"handle": "grace", "name": "Grace"}, "status": "baz"}
  ],
  "next_max_id": "1849203870012846079"
}
```

### Use case: User views the user timeline

The user timeline is one person's own tweets. It's much simpler, because there's no merging across authors.

1. The client requests a user timeline from the web server.
2. The web server forwards the request to the read API.
3. The read API reads the tweets from the SQL database, using the `(user_id, tweet_id DESC)` index:

```sql
SELECT tweet_id, user_id, text, media_ids, created_at
FROM tweets
WHERE user_id = :user_id AND tweet_id < :max_id
ORDER BY tweet_id DESC
LIMIT 20;
```

The REST API matches the home timeline's, except every tweet comes from the one user:

```http
GET /api/v1/user_timeline?user_id=123&count=20 HTTP/1.1
```

Because popular profiles are viewed far more often than they change, the read API can cache the first page of each user timeline in the memory cache. Step 4 uses that cache to serve celebrities' tweets.

### Use case: User searches keywords

Search works in the opposite direction from the home timeline. A tweet is indexed once, on one server, and each query asks every server.

**Indexing a tweet.** When the fan-out service adds a tweet to the search index, the indexer splits its text into **terms** (words, hashtags, mentions), normalizes them, and adds the tweet id to an **inverted index**. An inverted index maps each term to the tweet ids that contain it, like the index at the back of a book, with each list kept newest first. Tweets are spread over the search servers by a hash of the tweet id, so each tweet goes to exactly one **shard**, or slice of the index. The [search engine](/learn/design-search-engine#the-inverted-index-pipeline) chapter covers inverted indexes in depth.

**Answering a query:**

1. The client sends the search request to the web server.
2. The web server forwards the request to the search API.
3. The search API calls the **search service**, which parses the query to decide what to look for:
   - it removes markup, such as HTML tags pasted into the box;
   - it breaks the text into terms;
   - it fixes typos, for example "wrold" to "world";
   - it normalizes capitalization, so "World" and "world" match;
   - it turns the terms into a boolean query, such as `hello AND world`.
4. The search service sends the query to the **search cluster**, a set of servers running a search engine such as [Apache Lucene](https://lucene.apache.org/), an open-source Java library for indexing and search. Because any shard could hold matches, it uses **scatter-gather**: it sends the query to every shard in parallel, then gathers their answers.
5. It merges the answers, ranks and sorts them, and returns the top results.

The search service in Python, as a sketch:

```python
import re
import time
from concurrent.futures import ThreadPoolExecutor, wait

MARKUP = re.compile(r"<[^>]+>")
TERM = re.compile(r"[#@]?\w+")      # keep hashtags and mentions whole

def parse_query(raw, spelling):
    text = MARKUP.sub(" ", raw)                     # remove markup
    terms = TERM.findall(text)                      # break into terms
    terms = [spelling.correct(t) for t in terms]    # fix typos
    terms = [t.lower() for t in terms]              # normalize case
    return {"op": "AND", "terms": terms}            # boolean query

def search(raw, shards, spelling, pool: ThreadPoolExecutor,
           limit=20, timeout_s=0.1):
    query = parse_query(raw, spelling)
    futures = [pool.submit(shard.search, query, limit) for shard in shards]
    done, _ = wait(futures, timeout=timeout_s)      # scatter, with a deadline

    hits = []
    for f in done:                                   # gather
        if f.exception() is None:
            hits.extend(f.result())   # each hit: tweet_id, matched terms, counts

    now_ms = time.time() * 1000
    hits.sort(key=lambda h: rank(h, now_ms), reverse=True)   # merge, rank, sort
    return hits[:limit]

def rank(hit, now_ms):
    age_hours = (now_ms - hit.created_ms) / 3_600_000
    engagement = 1 + hit.retweets + hit.likes + hit.replies
    return engagement ** 0.5 / (1 + age_hours)       # fresh and popular first
```

Each shard returns only its own best `limit` hits, so the service receives at most `limit × number of shards` results. The deadline matters: waiting for one slow shard would make every query slow, so the service returns what it has and accepts slightly incomplete results. The ranking function is a toy that favors recent, popular tweets. A real one would also weigh whom the searcher follows.

The indexer must normalize tweets exactly as the parser normalizes queries. If tweets keep their capital letters and queries don't, "World" in a tweet never matches "world" in a query. Typo fixing is the exception: it runs only on queries, often as a "did you mean" suggestion.

The REST API:

```http
GET /api/v1/search?query=hello+world HTTP/1.1
```

The response looks like the home timeline's, except the tweets are the ones that match the query.

**How Twitter did it, around 2011.** A 2012 paper by Twitter engineers, *Earlybird: Real-Time Search at Twitter*, describes the search system as of fall 2011. Tweets passed through an ingestion pipeline, where they were tokenized and annotated with metadata such as language. They were then hash-partitioned across Earlybird servers, which were built on Lucene and held their indexes in memory. At query time a front end called Blender parsed the query and sent it to multiple Earlybird servers. Blender then merged and re-ranked their results. The paper reports more than two billion queries a day at an average latency of 50 ms, with tweets usually searchable within 10 seconds of being posted.

## Step 4: Scale the design

```diagram
title: Twitter timeline and search, scaled
[dns] DNS @ 0,0
[client:client] Client @ 0,1.5
[cdn] CDN @ 0,3
[lb] Load balancer @ 1,0.5
[web] Web servers @ 1,2
[obj:store] Object store @ 1,3.5
[write] Write API\nservers @ 2,0.5
[read] Read API\nservers @ 2,2
[sapi] Search API\nservers @ 2,3.5
[fan] Fan-out\nworkers @ 3,0
[q:queue] Notification\nqueue @ 3,1.2
[tl] Timeline, tweet\nand user info @ 3,2.4
[ss] Search\nservice @ 3,3.6
[cache:store] Memory cache\ncluster @ 4,1.8
[sqlw:store] SQL write\nprimary + standby @ 4,0.6
[sqlr:store] SQL read\nreplicas @ 4,3
[cluster:store] Search cluster\n(in memory) @ 4,4.2
client -> dns
client -> lb
client -> cdn
cdn -> obj
lb -> web
web -> write
web -> read
web -> sapi
write -> fan
write -> sqlw
fan --> q
fan -> cache
read -> tl
tl -> cache
tl -> sqlr
sapi -> ss
ss -> cluster
```

Don't jump straight from the first design to this one. In an interview, and in real life, scaling is a loop:

1. **Benchmark and load test** the current design, to see how much it can handle.
2. **Profile** it to find the bottleneck, the first part that runs out of capacity.
3. **Fix that bottleneck**, comparing alternatives and their trade-offs.
4. **Repeat.**

The [scaling on AWS](/learn/design-scaling-aws) chapter shows this loop step by step for one system. Here we'll use the step-1 numbers to find the bottlenecks, then add the components above one at a time. Internal load balancers between the tiers are left out of the diagram to reduce clutter.

The numbers point to five pressure points:

- 290,000 reads a second at peak, far more than one web server can take.
- 175,000 fan-out deliveries a second at peak, plus single tweets that need tens of millions of deliveries.
- A memory cache that would grow without limit if it kept every timeline forever.
- 12,000 searches a second at peak, each one touching every search shard.
- 17,000 tweet inserts a second at peak into a table that grows by 15 billion rows a month.

### DNS, CDN, load balancers and more web servers

- **DNS** turns the service's name into IP addresses, and can send each user to a nearby data center. See [DNS](/learn/dns-and-cdn-101#how-dns-works).
- A **CDN** (content delivery network) is a set of caching servers spread around the world. It serves photos and videos from near the user and fetches each file from the object store only once. Media is 98% of our bytes, so the CDN takes most of the outgoing bandwidth. See [content delivery networks](/learn/dns-and-cdn-101#content-delivery-networks).
- A **load balancer** spreads requests over many web servers and skips any server that fails a health check. That handles 290,000 reads a second by **horizontal scaling**, adding more identical servers, and removes the single web server as a point of failure. It's one more component to run, and it requires web servers that keep no per-user state. See [load balancing](/learn/load-balancing#what-a-load-balancer-does).
- The **write, read and search APIs** become separate pools of servers that grow independently, so a spike in searches can't starve timeline reads. The cost is more services to deploy, monitor and connect. See [microservices](/learn/reverse-proxy-and-api-gateway-101#microservices) and [service discovery](/learn/reverse-proxy-and-api-gateway-101#service-discovery).

### The fan-out service and users with many followers

The fan-out service is a likely bottleneck. As step 3 showed, one tweet from a user with millions of followers can take minutes to deliver.

Slow fan-out also causes **race conditions**, where the result depends on which of two operations finishes first. A celebrity tweets, and someone with few followers replies within seconds. The reply is delivered almost at once, while the original is still working through millions of timelines, so a user who follows both sees the reply first. One fix is to **reorder tweets at serve time**: sort each page by the time-ordered `tweet_id`, and if a reply's original is missing, fetch it from the tweet info service and show it first.

A better fix is to **stop fanning out tweets from highly followed users**. Pick a threshold, for example 100,000 followers; the exact number is a tuning choice. For authors above it:

1. The write API saves the tweet as usual. The fan-out service adds it to the search index, but skips the home timeline inserts.
2. On a home timeline read, the timeline service gets the user's precomputed list from the memory cache, then the recent tweets of the highly followed accounts the user follows. It can **search** for them (recent tweets whose author is in that set) or read each celebrity's cached user timeline.
3. It merges the two lists and **re-orders the tweets at serve time** by `tweet_id`.

```python
CELEBRITY_THRESHOLD = 100_000

def fan_out_targets(author_id, user_graph):
    if user_graph.follower_count(author_id) >= CELEBRITY_THRESHOLD:
        return []                     # pulled in at read time instead
    return user_graph.followers(author_id, batch_size=BATCH_SIZE)

def merge_celebrities(user_id, entries, recent_tweets):
    """entries: this user's precomputed (tweet_id, user_id, flags) list."""
    for celeb_id in user_graph.followed_celebrities(user_id):
        for tweet_id in recent_tweets(celeb_id, limit=50):
            entries.append((tweet_id, celeb_id, 0))
    entries.sort(key=lambda e: e[0], reverse=True)   # re-order at serve time
    return entries[:TIMELINE_LENGTH]
```

The trade-off: a timeline read now does a little more work, one extra lookup per celebrity the user follows. In return, posting stays cheap for everyone, and a celebrity's followers all see the tweet at about the same time. A celebrity's recent tweets are read by millions of users, so they make very effective cache entries.

**How Twitter did it, around 2012.** At QCon San Francisco in 2012, Twitter's Raffi Krikorian gave a talk called "Timelines at Scale", published by InfoQ in 2013. High Scalability's summary of the talk reports these details:

- Twitter fanned tweets out on write into home timelines stored as native Redis lists.
- Each entry held the tweet id, the author's user id and 4 bytes of flags, and each timeline was capped at 800 entries.
- Each timeline was kept on 3 machines, and only users who had logged in within the last 30 days were kept in memory.
- The system served about 300,000 queries a second for timelines and search, against about 5,000 new tweets a second on average.
- A tweet from Lady Gaga, who had 31 million followers, could take up to 5 minutes to reach all of them, and replies could show up before the original.
- Twitter planned to stop fanning out the most-followed accounts and merge their tweets in at read time.

The summary also gives about 30 billion timeline deliveries a day against about 400 million tweets, an average of 30 billion ÷ 400 million = 75 deliveries per tweet. Our assumption of 10 is low by comparison, so a real fan-out fleet would need to be several times larger than our estimate.

### Keeping the memory cache small

RAM is fast and expensive. These limits keep the memory cache a manageable size:

- **Keep only several hundred tweets per home timeline.** We picked 800, which is the 13.6 KB per user from step 1. A user who scrolls further back falls through to a slower path that reads from the database.
- **Keep only active users' home timelines.** If a user hasn't been active in the past 30 days, don't fan out to them, and let their timeline expire from the cache. When they return, **rebuild** their timeline:
  1. Ask the user graph service whom the user follows.
  2. Get recent tweets from those users out of the SQL database, merge them by `tweet_id`, and keep the newest 800.
  3. Write the result into the memory cache and resume fan-out to this user.

  The first load after a long absence is slower. In exchange, the cache skips memory and fan-out writes for users who would never have read them.
- **Store only a month of tweets in the tweet info service.** Timelines show recent tweets, so a month covers almost every read. That's 15 billion tweets × 200 bytes ≈ 3 TB of memory. Older tweets are read from the database on a cache miss.
- **Store only active users in the user info service.** At an assumed 1 KB per profile, 100 million active users take 100 GB.
- **Replicate the cache.** Keep each timeline on more than one cache server, as Twitter did with 3 copies. Losing a cache server then doesn't force a rebuild of millions of timelines from the database at once.

```python
def rebuild_timeline(user_id):
    followees = user_graph.following(user_id)
    rows = sql.query(
        "SELECT tweet_id, user_id FROM tweets "
        "WHERE user_id IN %s AND created_at > NOW() - INTERVAL 30 DAY "
        "ORDER BY tweet_id DESC LIMIT %s",
        (tuple(followees), TIMELINE_LENGTH),
    )
    entries = [ENTRY.pack(r.tweet_id, r.user_id, 0) for r in rows]
    key = f"home:{user_id}"
    pipe = timelines.pipeline()
    pipe.delete(key)
    if entries:
        pipe.rpush(key, *entries)        # already newest first
    pipe.expire(key, 30 * 86_400)        # refreshed on each read
    pipe.execute()
    return entries
```

With sharded tweet storage this becomes one query per shard plus a merge, which is slow, so it should be rare.

### The search cluster

The search cluster would likely need to keep its index in memory to keep latency low. Suppose search covers the last 7 days, which is 3.5 billion tweets. In 2011, a fully loaded Earlybird server held 144 million tweets and handled about 5,000 queries a second, according to the Earlybird paper. On hardware like that:

- One full copy of the index needs 3.5 billion ÷ 144 million ≈ 24.3, so 25 servers.
- Every query goes to every shard, so each shard sees all 12,000 peak queries a second. At about 5,000 queries a second per server, that's 12,000 ÷ 5,000 = 2.4 copies, so 3 at the very least, and 4 to survive a failure.
- That's about 4 × 25 = 100 servers.

**More replicas** add query capacity. **More shards** hold more tweets, but every query then waits on more servers, so the slowest one matters more. Older tweets can live in a slower tier that's searched only when recent results run short. The [search engine](/learn/design-search-engine#partitioning-the-index-by-document-or-by-term) chapter compares partitioning schemes.

### Scaling the SQL database

The memory cache takes most reads off the database, but **SQL read replicas** (copies that receive every change from the primary and serve reads) alone are unlikely to handle the cache misses: user timelines, deep scrolling, rebuilds and tweets older than a month. Writes are worse. 17,000 inserts a second at peak, each updating several indexes, plus 3 TB of new rows a month, would overwhelm a single **SQL write primary with a standby**. We need more scaling patterns:

- **Replication and failover.** The primary copies changes to a standby, which takes over if the primary fails. With asynchronous replication, the last few writes can be lost. See [replication](/learn/relational-databases#replication-copies-of-the-whole-database) and [fail-over](/learn/availability-101#fail-over-active-passive). Replicas also lag, so a user who posts and opens their own profile might not see the tweet. Read a user's own recent writes from the primary, or have the client show the new tweet locally. See [reading your own writes](/learn/relational-databases#replication-lag-and-reading-your-own-writes).
- **Federation.** Split the database by function: users in one database, tweets in another, follows in a third. Each one gets the full capacity of its own servers. The cost is that queries that join across them have to be done in application code. See [federation](/learn/relational-databases#federation-one-database-per-feature).
- **Sharding.** Split the `tweets` table across many databases. Sharding by `user_id` keeps each user timeline on one shard, so the most common query touches one server. The cost is that celebrities make their shard hot, and a timeline rebuild has to ask many shards. See [sharding](/learn/relational-databases#sharding-splitting-one-table-across-databases).
- **Denormalization.** Store copies of data where they're read, such as the author's handle on each tweet or a retweet count on the tweet row, so reads avoid joins. The cost is keeping the copies in sync. See [denormalization](/learn/relational-databases#denormalization).
- **SQL tuning.** Benchmark and profile the queries, tighten the schema, add the right indexes, and pool connections. See [SQL tuning](/learn/relational-databases#sql-tuning).

We should also consider moving some data to a **NoSQL database**. Tweets are written once, read by id or by author, and almost never joined, which is a good match for a wide-column or key-value store designed for heavy write loads. The follower graph could move to a store built for adjacency lists. See [NoSQL databases](/learn/nosql-databases) and the [social graph](/learn/design-social-graph) design.

### Notifications through a queue

The notification service puts each "tell these followers about this tweet" job on a **queue**. Workers take jobs off it and call the push and email providers, which keeps slow outside services off the fan-out path. In a burst the queue grows and workers catch up later, so notifications can arrive late. A worker that crashes after sending but before acknowledging a job can send it twice, so workers should record what they've sent and skip duplicates. See [queues and async work](/learn/queues-and-async) and the [notification system](/learn/design-notification-system) design.

### High availability

The last use case was high availability. Every tier above runs on more than one machine:

- web and API servers behind load balancers;
- several copies of each cache entry and search shard;
- a database primary with a standby and read replicas.

The design also chooses **eventual consistency**: a follower might see a tweet a few seconds after it's posted, and two followers might see it at slightly different times. That's acceptable for a timeline and lets the system keep serving reads when parts of it fail. See [availability](/learn/availability-101) and [CAP and consistency](/learn/cap-and-consistency-101).

## Trade-offs and follow-up questions

These are the decisions an interviewer is most likely to probe.

**Push, pull or hybrid for home timelines.** Pull makes posting cheap and every read expensive: one lookup per account followed, on every load. Push makes reads cheap and posting expensive, and it has the celebrity problem. With 17 reads per tweet and a delivery target of a few seconds, push for ordinary users plus pull for the most-followed accounts is the best fit. The interesting follow-up is the threshold: raising it means more fan-out work, and lowering it means more merging at read time. See the [social news feed](/learn/design-social-news-feed#the-central-decision-push-vs-pull) chapter.

**Memory cache or durable store for timelines.** Timelines kept only in memory are fast to read and write, but losing a cache server means rebuilding its timelines from the database. A durable NoSQL store survives restarts but costs more per operation. We keep timelines in memory, replicate them, and treat SQL as the source of truth that can rebuild any timeline. See [when to update the cache](/learn/cache-101#when-to-update-the-cache).

**Ids or whole tweets in each timeline.** Ids keep entries at 17 bytes and make edits and deletes take effect everywhere at once, at the cost of a hydration step on every read. Whole tweets would skip hydration but multiply memory many times over, and a profile change would mean millions of rewrites. Ids win.

**SQL or NoSQL for tweets.** SQL brings transactions, flexible queries and familiar tools, and it's enough at first. At 15 billion new rows a month, SQL sharded by `user_id` and a wide-column NoSQL store end up looking much alike. Choose by what your team can operate. See [SQL or NoSQL](/learn/nosql-databases#sql-or-nosql-making-the-choice).

**How to split the search index.** Splitting by tweet means indexing touches one shard and every query asks all of them. Splitting by term would let a query touch only its terms' shards, but every new tweet would write to many shards, and a trending hashtag would overload one. With a high write rate and short queries, split by tweet, and split again by time, because most searches want recent tweets. See the [search engine](/learn/design-search-engine#partitioning-the-index-by-document-or-by-term) chapter.

**Ordering and consistency.** Fan-out delivers tweets out of order, and replicas lag. We accept eventual consistency, reorder by `tweet_id` at serve time, and give authors read-your-own-writes on their own tweets. See [guarantees for one user](/learn/cap-and-consistency-101#guarantees-for-one-user).

**Queues and back pressure.** Fan-out and notifications run from queues, so posting stays fast and bursts are absorbed. If a queue keeps growing, the system needs [back pressure](/learn/queues-and-async#back-pressure-when-the-queue-keeps-growing), such as delaying fan-out to the least active users first.

**REST outside, RPC inside.** REST is easy for outside developers and caches well. RPC is compact and fast between internal services, which also need [service discovery](/learn/reverse-proxy-and-api-gateway-101#service-discovery). The public API needs authentication, [rate limiting](/learn/rate-limiting) and the other [security](/learn/security-101) basics. Keep benchmarking and [monitoring](/learn/observability) as the system grows, since scaling is never finished.

## Check yourself

<details>
<summary>You want to keep 500 entries per home timeline for 200 million active users, with 2 copies of each. How much memory is that, before data-structure overhead?</summary>

Each entry is 17 bytes, so one timeline is 500 × 17 B = 8,500 B, about 8.5 KB. For 200 million users that's 200 million × 8.5 KB = 1.7 TB, and 3.4 TB with 2 copies. The cache's own structures add overhead per element, so measure it on a sample before buying hardware. Even if it doubles the total, about 7 TB is practical on a cluster of large-memory servers.

</details>

<details>
<summary>An account with 50 million followers tweets. The fan-out fleet can do 200,000 timeline inserts a second in total. What happens with pure fan-out on write, and what would you change?</summary>

50,000,000 ÷ 200,000 = 250 seconds, about 4 minutes of the whole fleet's capacity. Ordinary users' tweets queue behind it, the celebrity's followers see the tweet minutes apart, and replies can arrive before the tweet itself.

Use the hybrid. Skip fan-out for accounts above a follower threshold, keep their recent tweets in a small, heavily cached list (or find them through search), and merge them into each reader's timeline at read time, sorted by tweet id.

</details>

<details>
<summary>A user complains that a reply appeared in their timeline before the tweet it answered. Why, and how do you fix it?</summary>

The original came from an account with many followers, so its fan-out took minutes. The reply came from an account with few followers and was delivered almost at once. Fix it at serve time: sort each page by the time-ordered `tweet_id`, and if a reply's original isn't on the page, fetch it from the tweet info service and show it first. The hybrid removes most of these races too, because big accounts' tweets are merged in at read time.

</details>

<details>
<summary>A user who hasn't opened the app in three months comes back. What happens when they load their home timeline?</summary>

Their timeline expired from the memory cache after 30 days, and fan-out stopped writing to it. The timeline service finds no list, asks the user graph service whom they follow, reads those accounts' recent tweets from the SQL shards, merges them by `tweet_id`, keeps the newest 800 and writes the list to the cache. It then hydrates the first page and marks the user active, so fan-out resumes. That first load is slower. The design accepts this for a rare event, in exchange for not storing or fanning out to tens of millions of inactive users.

</details>

<details>
<summary>Someone searches for "World Cup &lt;b&gt;FINAL&lt;/b&gt;". Trace the query through the search service.</summary>

The service strips the markup, leaving "World Cup FINAL". It splits that into three terms, checks each for typos, and lowercases them to `world`, `cup` and `final`. It builds `world AND cup AND final` and sends it to every shard at once. Each shard intersects its lists for the three terms and returns its best 20 matches. The service waits up to its deadline, merges the lists, ranks them by recency and engagement, and hydrates the top 20 like a timeline. If the indexer hadn't lowercased tweets the same way, `final` would never match a tweet that said "Final".

</details>

<details>
<summary>The product team now wants the "hide retweets" setting that we left out of scope. Where would you implement it?</summary>

At read time, in the timeline service. Each timeline entry already has a flags byte that marks retweets. When hydrating a page, the service loads the reader's set of accounts whose retweets they've hidden and drops matching entries, reading a few extra entries so the page still holds 20 tweets. Filtering at write time would make fan-out check every follower's settings for every tweet, and a changed setting would need the timeline rewritten. Filtering at read time costs a little per read and takes effect immediately.

</details>

## Further reading

- [Timelines at Scale (Raffi Krikorian, InfoQ)](https://www.infoq.com/presentations/Twitter-Timeline-Scalability/): the 2012 QCon San Francisco talk, published by InfoQ in 2013, on how Twitter built home timelines, fan-out and search. The original source for most of what's known about this design.
- [The Architecture Twitter Uses to Deal with 150M Active Users, 300K QPS, a 22 MB/S Firehose, and Send Tweets in Under 5 Seconds (High Scalability, 2013)](https://highscalability.com/the-architecture-twitter-uses-to-deal-with-150m-active-users/): a detailed written summary of that talk, with the numbers quoted in this chapter. Faster to read than watching the talk.
- [Earlybird: Real-Time Search at Twitter (Busch et al., ICDE 2012)](https://cs.uwaterloo.ca/~jimmylin/publications/Busch_etal_ICDE2012.pdf): the paper describing Twitter's in-memory, Lucene-based search engine as of 2011, including how the index is laid out so new tweets are searchable within seconds.
- [Latency comparison numbers](https://gist.github.com/jboner/2841832): the well-known table of memory, SSD, disk and network latencies, credited to Jeff Dean and Peter Norvig, behind the memory-versus-disk comparison in step 3.
- [Redis LTRIM](https://redis.io/docs/latest/commands/ltrim/), [LRANGE](https://redis.io/docs/latest/commands/lrange/) and [MGET](https://redis.io/docs/latest/commands/mget/): the commands used here to cap, read and hydrate timelines, with their time complexity.
- [Apache Lucene](https://lucene.apache.org/): the open-source search library that Earlybird was built on, and the base of many search clusters today.
