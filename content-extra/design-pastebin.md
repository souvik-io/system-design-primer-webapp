# Design a text-sharing service like Pastebin

A text-sharing service lets someone paste a block of text into a web form and get back a short link, such as `https://paste.example/r7k2x9a`. Anyone who opens the link sees the text. People use it to share a stack trace with a colleague, a config file in a chat, or a log excerpt in a bug report. Pastebin.com is the best-known example.

The traffic in this exercise is modest, but the design still makes you decide real things. Each paste has two kinds of data. One is a small record: the paste's short code, when it was created and when it expires. The other is the text itself, which can be a few bytes or hundreds of kilobytes. Where each one lives, how expired pastes get cleaned up, and how to serve a paste that suddenly gets popular are the interesting decisions.

The same design covers a URL shortener such as Bitly. A shortener stores a long URL where this service stores text, and it answers a visit with a redirect instead of a page. The handbook covers that problem in [Design a URL shortener](/learn/design-url-shortener), which goes deep on short codes, redirect status codes and redirect caching. This chapter treats short codes briefly. It spends its depth on storing paste contents, size limits, expiry, caching the read path, and counting page views.

The chapter follows the four steps from [The system design interview, step by step](/learn/system-design-interview).

## Step 1: Outline use cases, constraints and assumptions

There's no interviewer to answer questions here, so we'll state the use cases and assumptions ourselves.

### Use cases

- **A user enters a block of text and gets a randomly generated link.**
  - By default, a paste never expires.
  - The user can choose a timed expiration instead, such as one hour or one week.
- **A user enters a paste's URL and views its contents.**
- **Users are anonymous.** Nobody signs in.
- **The service tracks analytics for each page**, as monthly visit counts.
- **The service deletes expired pastes.**
- **The service is highly available.** A paste link that doesn't open is a broken promise.

### Out of scope

- Registering for an account, and verifying an email address.
- Logging in, and editing a paste after it's created.
- Choosing a paste's visibility, such as public, unlisted or private.
- Choosing your own short link (a "custom alias"). We'll note where it would fit.

### Assumptions

These numbers are made-up inputs for the exercise. They don't describe any real service.

- Traffic isn't evenly distributed. Some pastes get far more views than others, and traffic comes in spikes.
- Following a short link should be fast.
- Pastes are text only.
- Page-view analytics don't need to be real time.
- There are 10 million users.
- There are 10 million new pastes a month.
- There are 100 million paste reads a month, so reads outnumber writes 10 to 1.

### Calculate usage

The size of one paste, counting 1 KB as 1,000 bytes:

- Paste contents: 1 KB on average, so 1,000 bytes.
- `shortlink`: 7 bytes, one per character of the code.
- `expiration_length_in_minutes`: 4 bytes, a 32-bit integer.
- `created_at`: 5 bytes, a compact date and time.
- `paste_path`: up to 255 bytes, where the text lives in storage.
- Total: 1,000 + 7 + 4 + 5 + 255 = 1,271 bytes, or about **1.27 KB per paste**.

The 255 bytes for the path is an upper bound, since a variable-length column stores only the characters it holds. Using the upper bound keeps the estimate safe.

Storage over time:

- Each month: 1.27 KB × 10 million pastes = **12.7 GB**.
- Over three years: 12.7 GB × 36 months = 457 GB, so about **450 GB**.
- Pastes over three years: 10 million × 36 = **360 million short links**. Pastes can't be edited, so every write is a new paste.

Split that into its two parts, because they'll live in different stores:

- Metadata (everything except the text): 271 bytes × 360 million ≈ **98 GB** over three years.
- Text: 1,000 bytes × 360 million = **360 GB** over three years.

Request rates. A month has about 2.5 million seconds. (The exact figure is 30.4 days × 86,400 s ≈ 2.63 million; the round number is fine for an estimate.)

- Writes: 10 million ÷ 2.5 million s = **4 new pastes a second** on average.
- Reads: 100 million ÷ 2.5 million s = **40 reads a second** on average.

A handy conversion guide:

- 2.5 million seconds in a month.
- 1 request a second = 2.5 million requests a month.
- 40 requests a second = 100 million requests a month.
- 400 requests a second = 1 billion requests a month.

A few more numbers for step 4:

- Read bandwidth: 40 reads a second × about 1.3 KB ≈ 52 KB a second, or about 0.4 megabits a second.
- Peaks: if the busiest minute runs at 10 times the average, that's 40 writes and 400 reads a second.
- Cache: 100 million ÷ 30 ≈ 3.3 million reads a day. Even if every read were for a different paste, holding them all in memory would take 3.3 million × 1.3 KB ≈ 4.3 GB.
- Logs: at about 200 bytes per access log line, 100 million reads produce about 20 GB of logs a month.

**What these numbers tell us.** On average this is a small system, and one server could handle the load. So the design is shaped by other things. The first is availability, because one server is one machine that can fail. The second is skew: one paste shared on a busy forum can get thousands of views a second while the average stays at 40. The third is growth, with 360 million pastes after three years. Note too that the text is almost four times the size of the metadata. That hints that the two belong in different stores. The [estimation](/learn/estimation) chapter covers this kind of arithmetic.

## Step 2: Create a high-level design

```diagram
title: The first design. Paste text goes to the object store; everything else goes to the SQL database.
[c:client] Client @ 0,1
[web] Web server\n(reverse proxy) @ 1,1
[wapi] Write API @ 2,0
[rapi] Read API @ 2,2
[obj:store] Object store\n(paste text) @ 3,0
[db:store] SQL database\n(pastes table) @ 3,2
[mr] Log analysis\n(MapReduce) @ 1,3
[adb:store] Analytics\ndatabase @ 3,3
c -> web
web -> wapi : create
web -> rapi : view
wapi -> obj
wapi -> db
rapi -> obj
rapi -> db
web --> mr : access logs
mr -> adb : monthly counts
```

- **Client.** A browser or a command-line tool such as `curl`.
- **Web server.** It runs as a **reverse proxy**, a server that accepts client requests and forwards them to application servers. It terminates HTTPS, rejects oversized requests and logs every request. See [reverse proxies](/learn/reverse-proxy-and-api-gateway-101#what-a-reverse-proxy-is).
- **Write API.** It validates a new paste, stores it, picks a short code and returns the link.
- **Read API.** It looks up a code, checks expiry and returns the text. Reads outnumber writes 10 to 1, so separate servers let each side scale on its own.
- **SQL database.** It holds one row per paste, mapping the short code to the expiry settings and to where the text lives.
- **Object store.** It holds each paste's text as one file. An **object store** is a storage service that keeps whole files ("objects") under a key, with put, get and delete over HTTP. Amazon S3 is the best-known example.
- **Log analysis and analytics database.** A daily batch job reads the access logs and writes monthly view counts to a separate database, so analytics never loads the database that serves pastes.

## Step 3: Design core components

### Use case: User enters a block of text and gets a randomly generated link

1. The client sends a create request to the web server.
2. The web server forwards it to a Write API server.
3. The Write API server:
   1. checks that the text isn't empty or over the size limit,
   2. works out when the paste expires, if at all,
   3. stores the text in the object store,
   4. generates a short code and saves a row in the `pastes` table, retrying with a new code if that one is taken,
   5. returns the link.

#### Where the text lives

We need something like a huge hash table: give it a code, get back the paste. There are three reasonable places for the text.

1. **In the database row**, next to the metadata. One store, one write, one read.
2. **On file servers you run**, with the row holding a server and path. You handle full disks, replication and failed machines yourself.
3. **In a managed object store**, with the row holding the object's key. A [NoSQL document store](/learn/nosql-databases#document-stores) could play the same role.

This design uses option 3.

- **Durability comes built in.** Amazon's documentation says S3 Standard stores objects across at least three Availability Zones (separate data centers in one region) and is "designed to provide 99.999999999% durability and 99.99% availability of objects over a given year." [Availability 101](/learn/availability-101#availability-vs-durability) explains the difference between the two numbers.
- **The database stays small.** Three years of metadata is about 98 GB, which keeps backups, replicas and failover quick.
- **Large pastes don't crowd out small ones.** A 500 KB value makes every read of its row heavier and fills the database's memory with rarely read text.
- **Raw pastes become cacheable files.** A CDN can serve them, as step 4 shows.

The costs are real. A cache miss now makes two round trips, and the second is slow: Amazon's performance guide puts small-object reads at "roughly 100–200 milliseconds" and suggests a cache in front when you need single-digit milliseconds. And a create writes to two stores that can't share a transaction.

A middle path is worth raising in an interview: keep small pastes in the row and move only large ones out. PostgreSQL does a version of this already. Its documentation says that when a row is wider than about 2 kB, it compresses large values and moves them "out-of-line" to a separate table. Keeping 1 KB pastes inline would save the second round trip for most reads, at the cost of two code paths.

#### Size limits

A size limit protects everything else. Without one, a single 2 GB upload could exhaust a server's memory. Pastebin's FAQ says free accounts can create pastes up to 512 kilobytes and PRO members up to 10 megabytes. We'll use 512 KB, enforced twice: at the web server, as a maximum request body size, and in the Write API, by counting the decoded bytes. Both reject with `413 Content Too Large`.

The limit barely moves the average, but it sets the worst case. One 512 KB paste read 1,000 times a second is 512 MB a second, about 4 gigabits a second of outgoing traffic. That's what the CDN in step 4 is for.

#### The `pastes` table

```sql
CREATE TABLE pastes (
    shortlink                     CHAR(7)      NOT NULL,
    expiration_length_in_minutes  INT          NULL,      -- NULL means never expires
    created_at                    DATETIME     NOT NULL,
    expires_at                    DATETIME     NULL,      -- created_at + length, or NULL
    paste_path                    VARCHAR(255) NOT NULL,  -- key in the object store
    PRIMARY KEY (shortlink),
    INDEX idx_expires_at (expires_at)
);
```

- **`shortlink` is the primary key.** Every read looks a paste up by its code. The primary key also creates an index that the database uses to enforce uniqueness, so two pastes can never share a code.
- **"Never expires" needs a value.** It's the default, so the length column allows `NULL`.
- **`expires_at` is stored and indexed.** The cleanup job asks which pastes have expired, which depends on `created_at + expiration_length_in_minutes`. An index on `created_at` alone can't answer that, because two pastes created together can expire a minute or a year apart. Indexing the computed `expires_at` lets the job find expired rows without scanning the table.
- **Indexes keep lookups fast and in memory.** An index turns a full scan into a search whose steps grow with the logarithm of the table size, and a small, busy index stays in RAM. Jonas Bonér's widely shared latency table lists reading 1 MB sequentially at about 250 microseconds from memory, about 4 times longer from an SSD, and about 80 times longer from a spinning disk. See [use good indexes](/learn/relational-databases#use-good-indexes).

The table could live in a [NoSQL key-value store](/learn/nosql-databases#key-value-stores) instead, since every read is "get by key" with no joins. The cleanup job's "everything that expired before now" is easier in SQL, where it's a range scan on an index. We'll use a relational database. [SQL or NoSQL](/learn/nosql-databases#sql-or-nosql-making-the-choice) covers the choice in general.

#### Generating the short code

The code must be short, safe in a URL, and hard to guess.

1. **Make a large random-looking number.** For example, take an MD5 hash of the client's IP address and the current time. MD5 turns any input into a 128-bit number spread evenly across its range. Hashing random bytes works as well.
2. **Write it in Base62**, the 62 characters `0-9`, `a-z` and `A-Z`, which are all safe in URLs. Base64 adds `+` and `/`, which have special meanings in URLs. Encoding is deterministic, and a *k*-digit result takes *k* steps.
3. **Keep seven characters.** 62⁷ is about 3.52 trillion codes. After three years we'd use 360 million of them, about 0.01%.

Two details matter in practice. First, reduce the number modulo 62⁷ before encoding. A 128-bit number in Base62 has up to 22 characters, and since 2¹²⁸ is only about one eighth of 62²², its first character can take only about 8 values. Cutting the first 7 characters therefore uses only about 8 × 62⁶ ≈ 450 billion codes. Second, add randomness. Two people behind one office network share an IP address, and if they create pastes in the same millisecond, hashing IP and time gives both the same code every time they retry.

```python
import hashlib
import os
import time

ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
CODE_LENGTH = 7


def to_base62(num: int) -> str:
    if num == 0:
        return ALPHABET[0]
    digits = []
    while num > 0:
        num, remainder = divmod(num, 62)
        digits.append(ALPHABET[remainder])
    return "".join(reversed(digits))


def new_shortlink(client_ip: str) -> str:
    seed = f"{client_ip}|{time.time_ns()}|{os.urandom(8).hex()}"
    number = int.from_bytes(hashlib.md5(seed.encode()).digest(), "big")
    return to_base62(number % 62 ** CODE_LENGTH).rjust(CODE_LENGTH, ALPHABET[0])
```

Random codes sometimes collide with a taken one. With 360 million pastes stored, a new code collides about once in 9,800 tries (360 million ÷ 3.52 trillion). Over all three years that's roughly 18,000 collisions (360 million² ÷ (2 × 3.52 trillion)). The fix is cheap: insert, let the primary key reject a duplicate, and retry with a new code. A custom alias, if the product adds one, goes through the same insert and the same check.

The alternative is to encode numbers from a counter, which never collide. [Generating the short code](/learn/design-url-shortener#generating-the-short-code) compares the approaches and how to hand out unique numbers across servers.

#### Writing to two stores

A crash between the object store write and the database write leaves one without the other. The order decides which.

- **Row first:** a crash leaves a row that points at nothing, and readers get an error.
- **Text first:** a crash leaves a file no row points to. Nobody has its code, so nobody can reach it. It only wastes a little storage.

So write the text first, under a key that doesn't depend on the short code, such as a UUID. Otherwise a retry after a code collision would overwrite another paste's text. A periodic sweep deletes objects that no row references once they're a day old. S3 supports this order: it gives "strong read-after-write consistency for PUT and DELETE requests," and "if a PUT request is successful, your data is safely stored." [Distributed transactions](/learn/distributed-transactions) covers keeping two stores in step more generally.

```python
import uuid
from datetime import datetime, timedelta

MAX_PASTE_BYTES = 512 * 1000


def create_paste(request, client_ip, db, object_store):
    text = request["paste_contents"]
    size = len(text.encode("utf-8"))
    if size == 0 or size > MAX_PASTE_BYTES:
        raise PayloadTooLarge(size)

    minutes = request.get("expiration_length_in_minutes")  # None: never expires
    created_at = datetime.utcnow()
    expires_at = created_at + timedelta(minutes=minutes) if minutes else None

    # 1. Text first, under a key that doesn't depend on the code.
    paste_path = f"{expiry_prefix(minutes)}/{uuid.uuid4().hex}"
    object_store.put(paste_path, text, content_type="text/plain; charset=utf-8")

    # 2. Claim a code. The primary key rejects duplicates.
    for _ in range(5):
        shortlink = new_shortlink(client_ip)
        try:
            db.execute(
                "INSERT INTO pastes VALUES (%s, %s, %s, %s, %s)",
                (shortlink, minutes, created_at, expires_at, paste_path),
            )
            return {"shortlink": shortlink}
        except db.UniqueViolation:
            continue
    raise RuntimeError("no free short code")
```

`expiry_prefix` puts each paste under a prefix for its expiry option, such as `ttl-7d/` or `ttl-never/`. The deletion use case explains why.

#### The API

The public API follows REST: each paste is a resource with its own URL, acted on with standard HTTP methods. See [REST](/learn/protocols-and-apis#rest-resources-and-representations).

```
$ curl -X POST https://paste.example/api/v1/pastes \
    -H "Content-Type: application/json" \
    -d '{"paste_contents": "Hello World!", "expiration_length_in_minutes": 60}'
```

```
HTTP/1.1 201 Created
Content-Type: application/json

{
  "shortlink": "r7k2x9a",
  "url": "https://paste.example/r7k2x9a",
  "raw_url": "https://paste.example/raw/r7k2x9a"
}
```

Leaving out `expiration_length_in_minutes` creates a paste that never expires.

Inside the system, services can talk over **remote procedure calls** (RPC), where one server calls a function on another as if it were local. RPC is compact for traffic you control, and REST suits outside users because any HTTP client works. [RPC](/learn/protocols-and-apis#rpc-calling-a-function-on-another-machine) compares them.

### Use case: User enters a paste's URL and views the contents

1. The client requests the paste from the web server.
2. The web server forwards it to a Read API server.
3. The Read API server looks up the code in the `pastes` table.
   - If the row exists and hasn't expired, it fetches the text from the object store and returns it.
   - Otherwise it returns an error.

```
$ curl https://paste.example/api/v1/pastes/r7k2x9a
```

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "paste_contents": "Hello World!",
  "created_at": "2026-10-19T14:02:11Z",
  "expiration_length_in_minutes": 60,
  "expires_at": "2026-10-19T15:02:11Z"
}
```

An unknown code gets `404 Not Found`. An expired one can get `410 Gone`, which says the paste existed and was removed on purpose.

Readers also use two other URLs. `https://paste.example/r7k2x9a` is an HTML page showing the text. `https://paste.example/raw/r7k2x9a` returns only the text, as `text/plain`, for scripts and terminals. The raw URL is often the busiest, and it's the easiest to cache, because every reader gets the same bytes.

The Read API must check `expires_at` on every read. Cleanup runs in the background and can run late, so a paste that expired a second ago has to look gone even if its row and file still exist.

#### Caching the read path

Step 4 adds a memory cache, used **cache-aside**: check the cache, and on a miss read the database and object store, then fill the cache. [Cache-aside](/learn/cache-101#cache-aside) explains the pattern.

```python
DEFAULT_TTL = 3600   # seconds
MISSING = "missing"


def get_paste(shortlink, cache, replica, primary, object_store):
    key = f"paste:{shortlink}"
    entry = cache.get(key)
    if entry is None:
        row = replica.find_paste(shortlink) or primary.find_paste(shortlink)
        if row is None:
            cache.set(key, MISSING, ttl=60)
            return 404, None
        entry = {
            "paste_contents": object_store.get(row.paste_path),
            "created_at": row.created_at,
            "expires_at": row.expires_at,
        }
        cache.set(key, entry, ttl=ttl_for(row.expires_at))

    if entry == MISSING:
        return 404, None
    if entry["expires_at"] and entry["expires_at"] <= datetime.utcnow():
        return 410, None
    return 200, entry


def ttl_for(expires_at):
    """Never cache a paste past its own expiry."""
    if expires_at is None:
        return DEFAULT_TTL
    seconds_left = (expires_at - datetime.utcnow()).total_seconds()
    return max(1, min(DEFAULT_TTL, int(seconds_left)))
```

- **The cache TTL never outlives the paste.** A paste expiring in five minutes is cached for at most five minutes.
- **Unknown codes are cached briefly.** Otherwise someone requesting random codes sends every request to the database, a problem called [cache penetration](/learn/cache-101#cache-penetration).
- **A replica miss falls back to the primary.** A **read replica** is a database copy that receives the primary's changes a moment late. A paste created a second ago may not be there yet, and its creator is the most likely person to open it. See [replication lag](/learn/relational-databases#replication-lag-and-reading-your-own-writes).

### Use case: Service tracks analytics of pages

We need monthly visit counts per paste, and they don't need to be real time. Every view already passes through a web server that writes an access log line, such as:

```
203.0.113.7 - - [19/Oct/2026:14:02:11 +0000] "GET /raw/r7k2x9a HTTP/1.1" 200 1311
```

So the cheapest design counts from the logs after the fact, with nothing added to the read path. Each web server ships its logs to the object store hourly. Once a day, a **MapReduce** job counts views. Dean and Ghemawat's 2004 MapReduce paper from Google uses this very task as an example: counting how often each URL appears in "logs of web page requests." You write two functions.

- The **mapper** reads one log line and, for each successful paste view, outputs the key `(month, shortlink)` with the value 1.
- The framework groups all values with the same key onto one machine. This step is the **shuffle**.
- The **reducer** receives one key with all its values and adds them up.

An optional **combiner** adds up counts on each mapper machine before the shuffle, so a popular paste sends one number per machine instead of one per view. The paper describes combiners for reduce functions that are "commutative and associative," and addition is both.

```python
import re
from datetime import datetime

VIEW = re.compile(
    r'\[(?P<ts>[^\]]+)\] "GET /(?:raw/)?(?P<code>[0-9A-Za-z]{7}) HTTP/[\d.]+" (?P<status>\d{3})'
)


class MonthlyPasteViews:
    def mapper(self, _, line):
        """Emit ((month, shortlink), 1) per successful view:
        ("2026-10", "r7k2x9a"), 1
        ("2026-10", "r7k2x9a"), 1
        ("2026-10", "bQ81zz0"), 1
        """
        match = VIEW.search(line)
        if match is None or match["status"] != "200":
            return
        month = datetime.strptime(match["ts"], "%d/%b/%Y:%H:%M:%S %z").strftime("%Y-%m")
        yield (month, match["code"]), 1

    def combiner(self, key, counts):
        yield key, sum(counts)

    def reducer(self, key, counts):
        """Total per paste per month:
        ("2026-10", "r7k2x9a"), 2
        ("2026-10", "bQ81zz0"), 1
        """
        yield key, sum(counts)
```

The output, one row per paste per month, goes into the analytics database. The input is about 20 GB of logs a month, so this is a small job. Decide what a "visit" means before writing the mapper: this one counts every successful request, but you may want to drop bots or count each visitor once a day. Only the mapper changes. [MapReduce](/learn/batch-processing#mapreduce-the-foundational-model) covers the shuffle and fault tolerance in more depth.

#### A streaming alternative

The other approach counts as views happen. The Read API publishes a small event, `{shortlink, timestamp}`, to a **log** such as Apache Kafka, an append-only sequence of events that consumers read at their own pace. A consumer keeps running totals for a few seconds, then writes the increments to the analytics store. [Event streaming](/learn/event-streaming) explains these logs.

| | Batch over access logs | Streaming view events |
| --- | --- | --- |
| Freshness | A day old | Seconds old |
| Change to the read path | None | Publish one event per view |
| New infrastructure | A scheduled job | A log cluster and always-on consumers |
| Fixing a counting bug | Re-run over the stored logs | Replay the log, if it still holds the events |
| Duplicates | Rare | Need care: see [delivery semantics](/learn/event-streaming#delivery-semantics) |

Real-time counts aren't required, so batch fits better here. Streaming earns its cost if the product wants a live view counter, and many systems run both, as described under [Lambda vs Kappa](/learn/batch-processing#combining-batch-and-streaming-lambda-vs-kappa).

One trap applies to both. Once step 4 puts a CDN in front of raw pastes, many views are answered by the CDN and never reach a web server. The job must also read the CDN's request logs, or the counts drop the day the CDN goes live.

### Use case: Service deletes expired pastes

Deleting an expired paste means removing its row and file and making sure no cache still serves it. The read path already hides expired pastes, so cleanup only reclaims space and doesn't need to be instant. If half of all pastes set an expiry, that's 5 million ÷ 2.5 million s = 2 deletions a second on average, which is easy as long as nothing scans the whole table.

#### The cleanup job

A job runs every few minutes and deletes in small batches, using the `expires_at` index:

```python
def delete_expired_pastes(db, object_store, cache, batch_size=1000):
    while True:
        rows = db.query(
            "SELECT shortlink, paste_path FROM pastes"
            " WHERE expires_at <= NOW() ORDER BY expires_at LIMIT %s",
            batch_size,
        )
        if not rows:
            return
        for row in rows:
            db.execute("DELETE FROM pastes WHERE shortlink = %s", row.shortlink)
            cache.delete(f"paste:{row.shortlink}")
            object_store.delete(row.paste_path)  # a failure leaves a harmless orphan
```

Small batches keep each delete short, so locks are held briefly and replicas aren't flooded with changes. The row goes first, so readers stop finding the paste. If the file delete fails, the orphan sweep from the write path removes it later.

The job could instead mark rows as expired, a **soft delete**. That keeps a record for abuse reports and lets the read path return `410 Gone`, but the table never shrinks. A common middle path marks the row at once and removes it 30 days later.

#### Letting the object store expire files

S3 can delete files on a schedule with **lifecycle rules**. A rule selects objects by key prefix or tag and expires them a set number of days after creation. That's why the write path files each paste under a prefix for its expiry option: one rule per prefix, such as `ttl-7d/`, cleans up those files. Amazon's documentation sets some limits:

- **Rules count in days.** S3 adds the days to the creation time and rounds up "to the next day at midnight UTC," so rules can't do a 10-minute or one-hour expiry.
- **Deletion can run late.** Expired objects are queued and removed asynchronously, possibly "days or even weeks later." Amazon advises against relying on lifecycle rules alone for deletions with a deadline.
- **Billing stops on time anyway:** "after the object expiration time, you aren't charged for storage, even if the object isn't deleted immediately."

So lifecycle rules are a cheap backstop for day-sized options. They don't remove database rows or replace the read-path check. Pastes that never expire go under a prefix with no rule.

#### Caches and the CDN

An expired paste can linger in two caches. The memory cache already caps its TTL at the paste's remaining life. The CDN needs the same rule: raw responses carry `Cache-Control: max-age` set to the smaller of the default and the seconds left. CloudFront's documentation says `max-age` sets how long, in seconds, it keeps an object before asking the origin again, capped by its own maximum TTL. Without the header, CloudFront falls back to the default TTL, which is 24 hours unless you change it. That would keep a 10-minute paste visible for a day.

## Step 4: Scale the design

```diagram
title: The scaled design. Internal load balancers are left out to reduce clutter.
[dns] DNS @ 0,0
[c:client] Client @ 0,1
[cdn] CDN\n(raw pastes) @ 0,2
[lb] Load balancer @ 1,1
[web] Web servers @ 2,1
[wapi] Write API @ 3,0
[rapi] Read API @ 3,2
[primary:store] SQL primary @ 4,0
[replica:store] SQL read\nreplicas @ 4,1
[obj:store] Object store @ 4,2
[cache:store] Memory cache @ 4,3
[mr] Log analysis @ 1,3
[adb:store] Analytics DB @ 2,3
c -> dns
c -> lb
c -> cdn
cdn -> lb : on a miss
lb -> web
web -> wapi
web -> rapi
wapi -> primary
primary -> replica
rapi -> replica
rapi -> obj
rapi -> cache
web --> mr : logs
mr -> adb
```

The Write API also writes to the object store; that edge is left out so lines don't cross.

Don't jump straight to this design. Scaling is a loop: **benchmark** with a load test, **profile** to find the bottleneck, **fix** it while weighing alternatives, and **repeat**. [Design a system that scales to millions of users on AWS](/learn/design-scaling-aws) walks through that loop.

### Finding the bottlenecks

Four writes and 40 reads a second won't strain any one component. The problems are elsewhere:

1. **Every component is a single point of failure**, and high availability is a requirement.
2. **A cache miss costs two round trips**, and small S3 reads take roughly 100–200 ms.
3. **Traffic is skewed.** One popular paste can get thousands of reads a second, and large pastes turn that into gigabits a second.
4. **Data keeps growing**: about 2.7 GB of metadata and 10 million objects a month.

Each component below fixes one of these, and each has a cost.

### DNS and a CDN for raw pastes

**DNS** turns `paste.example` into the load balancers' addresses, and with health checks it can steer clients away from a failed site (bottleneck 1).

A **CDN** is a network of caching servers in many locations that serves content from a server near the reader. Use it as a **pull CDN** for raw pastes: on a miss it fetches the paste from you once, then serves its copy until it expires. A viral raw paste becomes a handful of requests to your servers (bottleneck 3), and distant readers get lower latency. Point the CDN at the load balancer. Then every miss still passes the Read API's expiry check and gets the right `Cache-Control` header, which wouldn't happen if the CDN read the object store directly.

The costs: a paste removed for abuse stays visible at the edge until its copy expires, unless you also send the CDN an invalidation; and CDN-served views vanish from your web server logs. See [CDNs](/learn/dns-and-cdn-101#content-delivery-networks) and [HTTP caching headers](/learn/dns-and-cdn-101#http-caching-headers).

### A load balancer and more web servers

A **load balancer** spreads requests across identical web servers and stops sending traffic to any that fail health checks. Running many copies this way is **horizontal scaling**, and it removes the web tier as a single point of failure. It works because the servers are **stateless**: users are anonymous, so there are no sessions to share. The load balancer is now critical, so run a pair. See [load balancing](/learn/load-balancing).

### Separate Write API and Read API servers

Behind the web servers sits an **application layer** of API servers, split into a write pool and a read pool. Reads are ten times as frequent and writes do more work each, so separate pools scale and deploy independently, and a burst of reads can't starve the create path. The cost is more services to run, plus internal load balancers. See [separating the web and application layers](/learn/reverse-proxy-and-api-gateway-101#separating-the-web-and-application-layers).

### A memory cache for hot pastes

A **memory cache** such as Redis or Memcached keeps recently read pastes in RAM. Popular pastes come back in about a millisecond without touching the database or object store (bottleneck 2), and spikes are absorbed before they reach the database (bottleneck 3). Sizing is easy: a whole day's distinct reads would take about 4.3 GB, and the hottest 20% under 1 GB, so one modest server with a replica is enough.

The costs: cached data can be stale, though pastes are never edited, so only deletion and expiry matter, and the TTL rules bound both. A cold cache sends a burst of misses, and a hot key that expires can make thousands of requests rebuild it together. [Cache stampede](/learn/cache-101#cache-stampede-thundering-herd) lists the fixes.

### Read replicas and failover for the database

The database becomes a **primary** that takes all writes and **read replicas** that copy its changes, an arrangement often called master-slave replication.

- **Replicas serve cache misses.** One or two are plenty, as long as they have spare capacity to keep up with replicating the writes.
- **Failover** promotes a replica if the primary dies. Until then new pastes can't be created, but existing ones stay readable from the cache and replicas.

Four writes a second, more at peak, is well within one primary. The costs are replica lag, which is why reads of brand-new codes fall back to the primary, and promotion, which must never leave two primaries accepting writes. See [primary-replica replication](/learn/relational-databases#primary-replica-replication), [active-passive failover](/learn/availability-101#fail-over-active-passive), [CAP and consistency](/learn/cap-and-consistency-101) and [Availability 101](/learn/availability-101).

### Object store growth

S3 handles 12.7 GB of new text a month comfortably, with no disks to add. What grows is the number of objects and requests. Amazon's documentation says S3 supports "at least 3,500 PUT/COPY/POST/DELETE or 5,500 GET/HEAD requests per second per partitioned Amazon S3 prefix," and that scaling up "happens gradually," with `503 Slow Down` errors meanwhile. At 4 writes a second we're far below that.

One trap: Amazon's storage class table shows that S3 Standard-IA, the cheaper class for rarely read data, bills each object as at least 128 KB and for at least 30 days. A 1 KB paste there costs as much as a 128 KB one. Keep small pastes in S3 Standard.

### The analytics database

The MapReduce output goes into a separate **analytics database**. A data warehouse such as Amazon Redshift or Google BigQuery is built for the large scans and grouping queries that reports run, which would slow the serving database. See [data warehouses](/learn/batch-processing#data-warehouses-snowflake-google-bigquery-amazon-redshift).

### If writes outgrow one primary

Nothing in the assumptions forces this, but an interviewer may ask about 100 times the traffic. Start with **[SQL tuning](/learn/relational-databases#sql-tuning)**: every query on an index, small rows, pooled connections. Then:

- **[Federation](/learn/relational-databases#federation-one-database-per-feature)** splits the database by function, for example pastes on one database and abuse reports on another.
- **[Sharding](/learn/relational-databases#sharding-splitting-one-table-across-databases)** splits the `pastes` table by a hash of `shortlink`. Every read knows the code, and random codes spread evenly.
- **[Denormalization](/learn/relational-databases#denormalization)** copies data to avoid joins. This schema has none, so it helps little here.

Moving the table to a NoSQL key-value store is another option. It has the right shape and scales writes by adding nodes. The cost is the cleanup job's range query on `expires_at`, which most key-value stores don't support directly, though some offer built-in per-item expiry instead.

## Trade-offs and follow-up questions

**Text in the object store or in the database?** The object store brings durability for free, a small database, and raw pastes a CDN can serve. It costs a second, slower read on cache misses and two writes with no shared transaction. At 360 GB over three years, the database could hold the text too. I'd use the object store with a memory cache in front, and mention keeping pastes under a few kilobytes inline. See [where the text lives](#where-the-text-lives).

**Random codes or a counter?** Random codes are unguessable and need no coordination, but inserts sometimes collide, about once per 9,800 creates at the worst point. A counter never collides but needs unique numbers across servers, and sequential codes let anyone list every paste unless they're scrambled. Unlisted sharing is the main use, so I'd pick random codes. See [generating the short code](/learn/design-url-shortener#generating-the-short-code).

**SQL or NoSQL for the metadata?** Reads are lookups by key, which suits key-value stores. Cleanup is a range query on expiry, which suits SQL. At 4 writes a second and 98 GB, one relational primary with replicas is enough. See [SQL or NoSQL](/learn/nosql-databases#sql-or-nosql-making-the-choice).

**How do expired pastes go away?** Only the read-path check is exact. A cleanup job, lifecycle rules and per-item expiry in a store all reclaim space late, by minutes or, for S3 lifecycle, by days. I'd use the read check for correctness, the job for rows and files, and lifecycle rules as a backstop.

**How long should caches keep a paste?** Longer TTLs mean less load; shorter ones make removals visible sooner. Expiry is known in advance, so TTLs can follow it exactly. Abuse takedowns aren't, so they need explicit cache deletes and CDN invalidation. I'd cap the default at about an hour. See [cache invalidation](/learn/dns-and-cdn-101#cache-invalidation-strategies).

**Batch or streaming analytics?** Batch is cheap, leaves the read path alone and is easy to re-run. Streaming gives live counts for the price of a log cluster and duplicate handling. With no real-time requirement, I'd use batch. See [batch processing](/learn/batch-processing).

**What stops abuse?** Anonymous creation needs [rate limiting](/learn/rate-limiting) by IP address. Pastes are untrusted text shown in browsers, so serve raw pastes as `text/plain` with `X-Content-Type-Options: nosniff`, escape text in the HTML page, and ideally serve raw pastes from a separate domain so a crafted paste can't run script alongside your cookies. See [cross-site scripting](/learn/security-101#cross-site-scripting-xss).

## Check yourself

<details>
<summary>The product team now expects an average paste of 10 KB instead of 1 KB. Redo the storage estimate. Does it change where the text should live?</summary>

The metadata is unchanged at about 98 GB over three years. The text grows tenfold: 10 KB × 10 million = 100 GB a month, and 100 GB × 36 = 3.6 TB over three years.

That strengthens the case for the object store. With text in the database, it would hold about 3.7 TB, so backups, replicas and failover would move almost forty times more data than the metadata needs. The inline option weakens too, since most pastes would now be above a 2 kB threshold. Read bandwidth rises from about 0.4 to about 3.2 megabits a second, which is still small.

</details>

<details>
<summary>A 300 KB paste goes viral and its raw URL gets 5,000 requests a second. What breaks in the first design, and what handles it in the scaled one?</summary>

In the first design, every request hits the single Read API, which reads the database and then the object store. At 100–200 ms per object read, [Little's Law](/learn/performance-and-latency-101#littles-law) puts 5,000 × 0.1 to 0.2 s = 500 to 1,000 requests in flight at once, each holding a connection and memory. Outgoing traffic is 5,000 × 300 KB = 1.5 GB a second, about 12 gigabits a second, more than a typical server's network card.

In the scaled design, the CDN answers nearly all of it from the edge. Your servers see about one request per edge location each time the cached copy expires, and those hit the memory cache. The remaining risk is the moment the copy expires everywhere at once, which request coalescing at the CDN or a lock in the cache layer handles.

</details>

<details>
<summary>A user sets a 10-minute expiry. Thirty minutes later a colleague can still open the raw URL, but the HTML page says the paste has expired. What's the likely bug?</summary>

The HTML page goes through the Read API, which checks `expires_at` on every request, so the data is right. Something in front of the raw URL is serving a stale copy, most likely the CDN. The raw response was cached with a fixed `max-age` such as an hour, or with no `Cache-Control` header, in which case CloudFront keeps it for its default TTL, 24 hours unless changed.

The fix is to set `max-age` on raw responses to the smaller of the default and the seconds left, and to check that the CDN's minimum TTL isn't raising it. A lifecycle rule wouldn't help, because rules count in whole days and run late.

</details>

<details>
<summary>Monthly view counts fell 60% in the month the CDN launched, yet the CDN's own reports show traffic grew. What happened?</summary>

The analytics job counts from web server access logs. Since launch, most raw-paste views have been answered at the edge and never reached a web server, so they're missing from the job's input.

Ship the CDN's request logs to the object store and teach the mapper both formats. Then avoid counting twice: a CDN miss appears in both the CDN log and the web server log. Count from the CDN log for URLs the CDN serves and from the web server log for the rest.

</details>

<details>
<summary>A Write API server crashes after uploading the text but before inserting the row. What's left behind, and does anyone notice?</summary>

The object store holds a file under a random key that no row points to. The client saw an error or timeout and probably retries, which uploads a new file and inserts a row. Nobody has a code for the first file, so nobody can reach it, and it only costs a little storage. The orphan sweep lists objects over a day old, checks which keys appear in `paste_path`, and deletes the rest.

With the opposite order, the crash would leave a row pointing to a missing file, and anyone with the code would get an error. That's why the text goes first, under a key independent of the code.

</details>

<details>
<summary>Extend the design with a "burn after reading" option, where a paste can be viewed exactly once. What changes?</summary>

The read must claim the paste atomically, so two people opening the link together can't both see it. A single `DELETE FROM pastes WHERE shortlink = %s RETURNING paste_path`, or a conditional update that sets a "burned" flag, succeeds for exactly one request. It must run on the primary, because replicas lag.

Every cache must be skipped: the Read API doesn't cache these pastes, and responses carry `Cache-Control: no-store` so neither the CDN nor the browser keeps a copy. There's also a product trap. Chat apps and email clients often fetch a link to build a preview before anyone clicks, which would burn the paste. A common fix is a "click to reveal" page, burning the paste only on that second request.

</details>

## Further reading

- [Data protection in Amazon S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html): S3's durability and availability design targets and how objects are spread across Availability Zones.
- [Amazon S3 data consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel): the read-after-write guarantee that makes "upload the text, then insert the row" safe.
- [Best practices: optimizing Amazon S3 performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html): per-prefix request rates and typical small-object latency.
- [Expiring objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html), [Lifecycle configuration elements](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html) and [Setting an S3 Lifecycle configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/how-to-set-lifecycle-configuration-intro.html): how lifecycle expiry rounds to midnight UTC, why it can run days late, and when billing stops.
- [Understanding and managing Amazon S3 storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html): the table of minimum billable object sizes, which is why small pastes belong in S3 Standard.
- [Manage how long content stays in the cache (expiration)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html): how CloudFront combines `Cache-Control` headers with its own TTL settings.
- [PostgreSQL: TOAST](https://www.postgresql.org/docs/current/storage-toast.html): how PostgreSQL moves large values out of the main table, a built-in version of the inline-or-external choice.
- [MapReduce: Simplified Data Processing on Large Clusters](https://www.usenix.org/legacy/events/osdi04/tech/full_papers/dean/dean_html/index.html): Dean and Ghemawat's 2004 paper. Its examples include counting URL access frequency from request logs, the job in this chapter.
- [Pastebin FAQ](https://pastebin.com/faq): the real service's size limits, visibility options and policy on pastes that never expire.
- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832): Jonas Bonér's table of rough timings, including the memory, SSD and disk figures used here.
