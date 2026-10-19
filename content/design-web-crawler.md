# Design a web crawler

A **web crawler** is a program that downloads web pages, finds the links on them, and then downloads the pages those links point to. For example, the crawler fetches `https://example.com/`, finds links to `/about` and `https://news.example.org/today`, adds both to its to-do list, and later fetches each of them, finding more links as it goes. Search engines run crawlers so they have a copy of the web to search.

In this chapter the crawler feeds a small search service. A user types `hello world` and gets back a list of pages, each with a title, a short **snippet** (a sentence or two of text from the page) and a link. The crawler's job is to keep the data behind that list complete and up to date.

It's a good interview question because the web is hostile to naive code. Pages link in cycles, so a careless crawler visits the same pages forever. Many URLs serve the same content, and some sites generate endless URLs. Every site belongs to someone else, and a crawler that fetches too fast can overload it. And a billion pages refreshed weekly comes to petabytes a month.

The chapter follows the four steps from [The system design interview, step by step](/learn/system-design-interview). The [search engine design](/learn/design-search-engine) covers ranking and the index in more depth. This chapter spends its depth on the crawler.

## Step 1: Outline use cases, constraints and assumptions

### Use cases

- **The service crawls a list of URLs.** While doing so it:
  - builds a **reverse index** (also called an **inverted index**): a map from each word to the pages that contain it, so a search can find matching pages without reading every page, and
  - generates a title and a snippet for each page. They are **static**: generated once per crawl, and the same whatever the search query.
- **A user enters a search term and sees a list of relevant pages,** with the titles and snippets the crawler generated. We'll only sketch the components for this use case, without going deep.
- **The service is highly available.**

### Out of scope

- Search analytics, such as dashboards of what people search for.
- Personalized search results.
- Computing **PageRank**, a score for how important a page is based on which pages link to it. We order the crawl by a popularity score, but we treat that score as an input we're given. The search engine chapter explains [how PageRank works](/learn/design-search-engine#link-authority-pagerank).

### Assumptions

- **Traffic is uneven.** Some searches are very popular, and others are run only once.
- **All users are anonymous.**
- **Search results must come back fast.**
- **The crawler must not get stuck in an infinite loop.** The web is a graph with cycles: page A links to B, B links to C, and C links back to A. A crawler that doesn't remember where it has been goes around that cycle forever.
- **There are 1 billion links to crawl.**
- **Pages are recrawled regularly to stay fresh,** on average once a week, and popular sites more often. That gives about **4 billion fetches a month** (1 billion pages × about 4 weeks).
- **The average stored size of a page is 500 KB.** To keep it simple, a changed page counts the same as a new one: every fetch stores a full copy.
- **There are 100 billion searches a month.**
- **We build from ordinary parts:** databases, queues and services, without an existing search platform such as [Apache Solr](https://solr.apache.org/) or crawler such as [Apache Nutch](https://nutch.apache.org/).

The estimates below need a few more assumptions of our own. State them out loud in an interview:

- An average page has **50 outgoing links**.
- A page's visible text, without markup, scripts and styles, averages **10 KB**.
- A title, snippet and URL take about **500 bytes**, so a page of 10 results is about **5 KB**.
- Search traffic peaks at about **3 times** its average.
- An average fetch, including DNS lookup, connecting and downloading, takes about **2 seconds**.

### Calculate usage

A 30-day month has 30 × 86,400 = 2,592,000 seconds, about 2.6 million.

**Crawling**

- Fetch rate: 4,000,000,000 ÷ 2,592,000 s ≈ **1,540 pages a second**. We control the crawl, so it can run close to this average all day, with no peak.
- Inbound bandwidth: 1,540 × 500 KB ≈ 770 MB a second, which is 770 × 8 ≈ **6.2 Gbit/s**, around the clock.
- Fetches in flight: by [Little's Law](/learn/performance-and-latency#littles-law), that's the rate times the time each one takes: 1,540 a second × 2 s ≈ **3,100 open fetches**.
- New links found: 1,540 pages a second × 50 links ≈ **77,000 links a second**, each checked against the URLs we already know.

**Storage**

- Page content: 4,000,000,000 × 500 KB = 2,000,000,000,000 KB = **2 PB a month**.
- Over 3 years: 2 PB × 36 months = **72 PB**, if we keep every copy of every page.
- Latest copy of each page only: 1,000,000,000 × 500 KB = **500 TB**.
- Titles and snippets: 1,000,000,000 × 500 bytes = **500 GB**.
- Reverse index: 1,000,000,000 × 10 KB of text = 10 TB of text. A compressed inverted index is usually smaller than the text it indexes, so budget **10 TB**.
- Crawl bookkeeping, at about 200 bytes per URL: 1,000,000,000 × 200 bytes = **200 GB**.

**Searching**

- Search rate: 100,000,000,000 ÷ 2,592,000 s ≈ **38,600 a second** on average, and 3 × 38,600 ≈ **116,000 a second** at peak.
- Outbound bandwidth: 38,600 × 5 KB ≈ 193 MB a second, about **1.5 Gbit/s**.
- Reads to writes: 38,600 searches for every 1,540 pages crawled, roughly **25 to 1**.

**A sanity check.** Common Crawl, a nonprofit that publishes a free copy of the web, reported that its [August 2026 crawl](https://commoncrawl.org/blog/august-2026-crawl-archive-now-available) fetched 2.14 billion pages between August 7 and August 20, with 360 TiB of uncompressed content. That's 2,140,000,000 ÷ (14 × 86,400 s) ≈ 1,770 pages a second, close to our 1,540. It's also about 185 KB a page (360 TiB ≈ 396,000,000,000,000 bytes ÷ 2.14 billion), so our 500 KB is generous by almost 3 times. That's fine for a capacity plan.

**What these numbers tell us.** Search and crawling are two systems with different shapes. Search is read-heavy and latency-sensitive at tens of thousands of requests a second, so it needs caching and replicas. Crawling is a steady, throughput-bound job limited by bandwidth (6.2 Gbit/s), open connections (3,100) and "have we seen this URL?" checks (77,000 a second). Page content dominates storage, so the retention policy is the biggest storage decision: 72 PB for every version over three years, or 500 TB for the latest only. The index and snippets are small by comparison.

## Step 2: Create a high-level design

```diagram
title: First design: a crawler that feeds a search service
[client:client] User @ 0,0
[web] Web server\n(reverse proxy) @ 1,0
[api] Query API @ 2,0
[ds] Document\nservice @ 3,0
[ris] Reverse index\nservice @ 2,1
[jobs:queue] Job queues @ 3,1
[crawler] Crawler\nservice @ 3,2
[db:store] NoSQL database @ 2,2
[www:client] Web sites @ 4,2
client -> web
web -> api
api -> ds : titles, snippets
api -> ris : matching pages
jobs --> ds
jobs --> ris
crawler --> jobs : index jobs
crawler <-> db
crawler -> www : fetch
```

- **Crawler service:** a loop that takes the next URL, fetches the page and hands it off for indexing. It's the only part that talks to the outside web.
- **NoSQL database:** holds `links_to_crawl`, the to-do list ranked by priority, and `crawled_links`, a record of every page fetched with its signature and fetch time. Every access is by URL, which suits a key-value store.
- **Job queues:** let the crawler hand off pages without waiting for indexing, which is slower than fetching. See [queues and async work](/learn/queues-and-async).
- **Reverse index service:** turns page text into the word-to-pages index, and answers "which pages contain these words?"
- **Document service:** generates and stores each page's static title and snippet, and returns them by page ID.
- **Web server:** a [reverse proxy](/learn/reverse-proxy-and-api-gateway#what-a-reverse-proxy-is) that accepts connections from users and forwards requests.
- **Query API:** parses the search text, asks the reverse index for matching pages, and asks the document service for their titles and snippets.

## Step 3: Design core components

### Use case: Service crawls a list of URLs

#### The seed list and the two tables

A crawler needs a starting list, the **seed list**. We assume we're given an initial `links_to_crawl` ranked by overall site popularity. If not, we can seed it with popular sites that link out to a lot of other content, such as large directories and news front pages, and discover the rest by following links.

`links_to_crawl` is the **frontier**: the URLs waiting to be fetched, each with a priority score. The crawler always takes the highest-scoring URL next. A [Redis sorted set](https://redis.io/docs/latest/develop/data-types/sorted-sets/) fits: unique strings, each with a numeric score, kept in score order. Adding a URL (`ZADD`) costs O(log N), and [`ZPOPMAX`](https://redis.io/docs/latest/commands/zpopmax/) removes and returns the highest-scoring member, also in O(log N).

```text
links_to_crawl   (sorted set, score = priority)
  https://en.wikipedia.org/wiki/Main_Page        0.97
  https://www.bbc.com/news                        0.95
  https://example.com/about                       0.31
```

`crawled_links` records what we have fetched, keyed by URL, with a second index on `signature`:

```text
crawled_links    (key-value, key = normalized URL)
  url            https://example.com/about
  signature      9f2c41a07be3d655        # fingerprint of the page content
  crawled_at     2026-10-12T08:14:03Z
  next_crawl_at  2026-10-19T08:14:03Z
  change_count   3                       # recrawls that found new content
```

Relational or NoSQL? Every access is by one URL, there are no joins, and a billion rows must be split across machines, which suits a key-value store. See [SQL or NoSQL](/learn/nosql-databases#sql-or-nosql-making-the-choice).

#### The crawler loop

For each URL, the crawler:

1. Takes the highest-priority URL from `links_to_crawl`.
2. Checks that the site's `robots.txt` allows it (see [politeness](#politeness-robotstxt-and-crawl-rate-per-host)).
3. Fetches the page.
4. Computes the page's **signature**, a short fingerprint of its content.
5. Looks in `crawled_links` for a page with the same or a very similar signature.
   - If there is one, this URL is a copy of a page we already have. It isn't indexed again. It goes back into `links_to_crawl` with a lower priority, so the crawler doesn't keep returning to it. This also stops a cycle of links between copies from trapping the crawler.
   - If not, it adds a job to the reverse index service's queue and one to the document service's queue, and records the URL and signature in `crawled_links`.
6. Extracts the page's links, normalizes them, and adds the new ones to `links_to_crawl`.

As a Python sketch, with storage hidden behind a small class:

```python
import hashlib
import time
from urllib.parse import urljoin, urlsplit, urlunsplit

WEEK = 7 * 86_400


def normalize(url):
    """Make equal URLs compare equal: lowercase scheme and host,
    drop default ports and #fragments."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if parts.port and parts.port != {"http": 80, "https": 443}.get(scheme):
        host = f"{host}:{parts.port}"
    return urlunsplit((scheme, host, parts.path or "/", parts.query, ""))


def signature(text):
    """Exact-content fingerprint. Near-duplicates need more (see below)."""
    words = " ".join(text.lower().split())
    return hashlib.sha256(words.encode()).hexdigest()[:16]


class LinkStore:
    """links_to_crawl in a Redis sorted set, crawled_links in a key-value store."""

    def __init__(self, redis, kv):
        self.redis, self.kv = redis, kv

    def next_url(self):
        popped = self.redis.zpopmax("links_to_crawl")
        return popped[0][0] if popped else None

    def add_if_new(self, url, priority):
        if self.kv.get(url) is None:
            # nx=True: never overwrite a URL that's already queued
            self.redis.zadd("links_to_crawl", {url: priority}, nx=True)

    def demote(self, url, priority=0.01):
        self.redis.zadd("links_to_crawl", {url: priority})

    def copy_of_another(self, url, sig):
        other = self.kv.find_by_signature(sig)   # URL stored with this signature
        return other is not None and other != url

    def record(self, url, sig):
        now = time.time()
        self.kv.put(url, {"signature": sig, "crawled_at": now,
                          "next_crawl_at": now + WEEK})


def crawl(store, fetcher, robots, index_queue, doc_queue, score):
    while True:
        url = store.next_url()
        if url is None:
            time.sleep(1)                   # frontier empty for now
            continue
        if not robots.allowed(url):
            continue
        page = fetcher.get(url)             # waits for this host's turn
        if page is None:                    # timeout, error, not HTML
            continue
        sig = signature(page.text)
        if store.copy_of_another(url, sig):
            store.demote(url)               # a copy: don't index it again
            continue
        index_queue.put({"url": url, "text": page.text})
        doc_queue.put({"url": url, "html": page.html})
        store.record(url, sig)
        for href in page.links:
            link = normalize(urljoin(url, href))
            store.add_if_new(link, score(link))
```

The loop checks for repeats at two moments:

- **Before fetching, by URL.** `add_if_new` refuses URLs already queued or crawled. This is cheap and stops most cycles: when C links back to A, A is already in `crawled_links`.
- **After fetching, by content.** A signature needs the content, so this check must wait for the download. It catches one page reached through different URLs, such as `http://` and `https://` versions, or an article with and without a tracking parameter.

One production detail: `ZPOPMAX` removes the URL before it's fetched, so a crawler that crashes mid-fetch loses it. The fix is a lease. Move the URL to an "in progress" set with a deadline, and put it back if it isn't recorded in time, like a [visibility timeout](/learn/queues-and-async#acknowledgements-and-visibility-timeouts) in a message queue.

#### What happens to the jobs

The **reverse index service** reads its queue. For each page it splits the text into lowercase words and adds the page's ID to each word's list of pages, called a **posting list**:

```text
"hello"  -> [17, 42, 108, ...]
"world"  -> [42, 99, 108, ...]
```

To answer `hello world`, it intersects the lists (pages 42 and 108), ranks the matches and returns the best. Updating posting lists one page at a time is slow, so real indexers batch pages into new index segments and merge them in the background. See [the inverted index pipeline](/learn/design-search-engine#the-inverted-index-pipeline).

The **document service** reads its own queue. It takes the title from the HTML `<title>` element, and the snippet from the meta description or the first 160 or so characters of the main text, and stores them by page ID:

```text
documents
  doc_id      42
  url         https://foo.com
  title       foo's title
  snippet     foo's snippet: the first sentence or two of the page.
  crawled_at  2026-10-12T08:14:03Z
```

Because snippets are static, all the work happens at crawl time, and a search only needs a lookup by ID.

### Handling duplicates

There are two kinds of duplicates, and they need different tools.

#### Duplicate URLs

The same URL arrives many times: from every page that links to it, from seed lists merged with discovered links, and from crawler restarts. Before a batch of URLs goes into the frontier, we remove repeats.

For a small list, `sort -u urls.txt` on one machine is enough. With 1 billion links we use **MapReduce**, a way to run a job over data spread across many machines. A *map* step turns each record into key-value pairs. The framework groups all pairs with the same key onto one machine (the *shuffle*). A *reduce* step combines each group into an output. The [batch processing chapter](/learn/batch-processing#mapreduce-the-foundational-model) explains the model.

Here the key is the normalized URL. Every copy of a URL lands in the same group, and the reducer writes it out once.

```python
from collections import defaultdict


def map_urls(lines):
    """Map: emit (normalized URL, 1) for every line."""
    for line in lines:
        if line.strip():
            yield normalize(line.strip()), 1


def shuffle(pairs):
    """What the framework does between map and reduce."""
    groups = defaultdict(list)
    for key, value in pairs:
        groups[key].append(value)
    return groups


def reduce_urls(groups):
    """Reduce: one output per distinct URL. The count is how often
    the URL was linked, a useful signal for its priority."""
    for url, ones in groups.items():
        yield url, sum(ones)


lines = ["https://Example.com/a#top", "https://example.com/a", "https://example.com/b"]
print(dict(reduce_urls(shuffle(map_urls(lines)))))
# {'https://example.com/a': 2, 'https://example.com/b': 1}
```

Watch the reducer. A tempting version emits only URLs whose count is 1. That silently drops every URL that appears more than once, which is the opposite of what we want. Emit every key once, whatever its count.

Between batch runs, the crawler still needs a fast "seen this URL?" check for 77,000 links a second. A **Bloom filter** is a compact bit array that answers "definitely not seen" or "probably seen". At a 1% false-positive rate it needs about 9.6 bits per URL (−ln 0.01 ÷ (ln 2)² ≈ 4.6 ÷ 0.48), so 1,000,000,000 × 9.6 bits ≈ 1.2 GB, which fits in one machine's memory. The cost: about 1 new URL in 100 is wrongly reported as seen and skipped. The [cache chapter](/learn/cache#cache-penetration) uses a Bloom filter the same way.

#### Duplicate content

An exact fingerprint, like the SHA-256 hash in the loop, only catches pages that match character for character. Two copies of an article that differ by a timestamp get completely different hashes. Such copies are common: *Introduction to Information Retrieval* notes that [by some estimates as many as 40% of web pages](https://nlp.stanford.edu/IR-book/html/htmledition/near-duplicates-and-shingling-1.html) duplicate other pages.

To catch near-duplicates, compare pages by similarity:

1. Break each page into **shingles**, every run of k consecutive words. With k = 4, "the quick brown fox jumps" gives "the quick brown fox" and "quick brown fox jumps".
2. Measure overlap with the **Jaccard index**: the size of the intersection of two shingle sets divided by the size of their union. Identical pages score 1.0. Pages above a threshold such as 0.9 are near-duplicates.
3. Comparing every pair of a billion pages is impossible, so shrink each page's shingles into a fixed-size **sketch** with **MinHash**: hash every shingle with many hash functions and keep the smallest value for each. The chance that two pages share the minimum for one function equals their Jaccard index, so the fraction of matching minimums estimates it.

```python
import hashlib


def shingles(text, k=4):
    words = text.lower().split()
    return {" ".join(words[i:i + k]) for i in range(max(1, len(words) - k + 1))}


def jaccard(a, b):
    return len(a & b) / len(a | b) if (a or b) else 1.0


def minhash(shingle_set, num_hashes=200):
    return [min(int.from_bytes(hashlib.blake2b(f"{seed}:{s}".encode(),
                                               digest_size=8).digest(), "big")
                for s in shingle_set)
            for seed in range(num_hashes)]


def estimated_similarity(sketch_a, sketch_b):
    return sum(x == y for x, y in zip(sketch_a, sketch_b)) / len(sketch_a)
```

The sketch is 200 numbers however long the page is, so it fits in `crawled_links` beside the signature. **Cosine similarity** is an alternative: it treats each page as a vector of word counts and measures the angle between two vectors, so it weighs how often words appear and ignores their order.

Large crawlers often use **SimHash**, which packs a page into one 64-bit fingerprint such that similar pages differ in only a few bits. The search engine chapter explains [SimHash and how Google used it](/learn/design-search-engine#near-duplicate-detection-with-simhash). With any of these, the loop's "seen similar content?" check becomes a search for fingerprints close to the new one.

### Determining when to update the crawl results

Pages change, so they must be fetched again. Each row in `crawled_links` has a `crawled_at` timestamp. A simple policy: after a default period, say one week, every page is due again, and popular or frequently updated sites sooner. A scheduler finds rows whose `next_crawl_at` has passed and puts those URLs back in `links_to_crawl`.

A better policy learns each page's rate of change. Every recrawl tells us whether the signature changed, so over several visits we can estimate the mean time between changes and set the interval from it:

```python
DAY = 86_400
MIN_INTERVAL, MAX_INTERVAL = 1 * DAY, 30 * DAY


def next_interval(previous, changed):
    """Recrawl sooner after a change, later after no change."""
    interval = previous / 2 if changed else previous * 1.5
    return max(MIN_INTERVAL, min(MAX_INTERVAL, interval))
```

It's tempting to recrawl every page in direct proportion to how often it changes. Cho and Garcia-Molina tested this on 270 web sites over four months, in [Synchronizing a database to improve freshness](https://www.kth.se/social/files/554f1d5bf27654514fd00393/synchronizing-a-database-to-improve-freshness.pdf) (SIGMOD 2000). Revisiting every page at the same rate kept the copy fresher than revisiting in proportion to change rate, because a page that changes many times a day goes stale again almost at once. With their crawl budget and real change data, the predicted share of fresh pages was 0.12 for the proportional policy, 0.57 for the uniform one and 0.62 for their optimal one. Their conclusion: "to improve freshness, we should penalize the elements that change too often." That's why `next_interval` has a floor. A search engine may still revisit a popular, fast-changing page often, because a stale copy of an important page affects more users.

Two web standards make recrawling cheaper:

- **Conditional requests.** Send the `ETag` or last-modified date from the previous fetch in an `If-None-Match` or `If-Modified-Since` header. An unchanged page comes back as [`304 Not Modified`](https://www.rfc-editor.org/rfc/rfc9110#section-15.4.5) with no body, saving the 500 KB download. Our storage estimate counted every refresh as a new page, so it's pessimistic.
- **Sitemaps.** A site can list its URLs in an XML sitemap with a `<lastmod>` date for each. Google says it [uses `<lastmod>` if it's consistently accurate, and ignores `<changefreq>` and `<priority>`](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap). Site-reported dates help, but the crawler should check them against what it sees.

### Politeness: robots.txt and crawl rate per host

Every fetch costs someone else's server some work, and to a small site a crawler sending hundreds of requests a second looks like an attack. Politeness has two parts: obeying the site's rules, and limiting the rate.

#### robots.txt

The **Robots Exclusion Protocol** lets a site tell crawlers which paths they may fetch. It was standardized as [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309) in September 2022. The rules that shape our design:

- **Location and groups.** The rules live at `/robots.txt` at the top of the host, such as `https://example.com/robots.txt`. The file is split into groups that start with `user-agent` lines. A crawler uses the group matching its name, compared case-insensitively, and otherwise the `*` group.
- **Matching.** Each group has `allow` and `disallow` path rules. `*` matches any run of characters, and `$` marks the end of the path. The most specific matching rule (the one with the most characters) wins, and `allow` should win a tie. If nothing matches, the URL is allowed.
- **Errors.** A 4xx response, such as 404, means the file is "unavailable", and the crawler may fetch anything. A 5xx response or an unreachable server means the crawler "MUST assume complete disallow". If that lasts a long time (the RFC's example is 30 days), the crawler may treat the file as unavailable or keep using a cached copy.
- **Limits.** Crawlers should follow at least five redirects to the file, must parse at least 500 KiB of it, and "SHOULD NOT use the cached version for more than 24 hours, unless the robots.txt file is unreachable."
- **It isn't security.** The RFC says it "is not a substitute for valid content security measures." A polite crawler honors it anyway.

An example:

```text
User-agent: *
Disallow: /search
Disallow: /*?sessionid=
Allow: /search/about$
```

Our crawler may fetch `/news/today`. It may not fetch `/search?q=x` or `/cart?sessionid=abc`. It may fetch `/search/about`, because that `Allow` rule is longer than `Disallow: /search`.

So the design needs a **robots cache**: parsed rules per host, with the time they were fetched. A host's `robots.txt` is fetched before any other URL on it and refreshed at most every 24 hours. Many URLs share a host, so *Introduction to Information Retrieval* finds such a cache [still "highly effective"](https://nlp.stanford.edu/IR-book/html/htmledition/crawler-architecture-1.html).

Many files contain `Crawl-delay: 10`, asking for 10 seconds between requests. RFC 9309 doesn't define it, though it lets crawlers interpret extra records, and Google [doesn't support `crawl-delay`](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt). Our crawler can honor it as a minimum gap, but it can't rely on sites setting it.

#### Crawl rate per host

So the crawler needs its own per-host limit. The textbook design, from the Mercator crawler and described in [*Introduction to Information Retrieval*](https://nlp.stanford.edu/IR-book/html/htmledition/the-url-frontier-1.html), has two rules:

1. Keep **only one connection open to a host at a time**.
2. Before the next request to a host, wait about **ten times as long as the last fetch took**. A site that took 0.5 s to answer is asked again 5 s later, so a struggling site is automatically visited less.

The frontier implements this with two layers of queues. **Front queues** order URLs by priority. Each **back queue** holds URLs from a single host, and a heap orders hosts by the earliest time each may be contacted again. In our design, `links_to_crawl` plays the front queues, and each crawler keeps back queues and the heap in memory. The search engine chapter [walks through this frontier](/learn/design-search-engine#the-crawl-frontier-priority-and-politeness).

The crawler should also back off when a site pushes back. A `429 Too Many Requests` or `503 Service Unavailable` means "too fast", and a [`Retry-After`](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3) header says how long to wait. Google documents the same signal from the site's side: [returning 500, 503 or 429 makes Googlebot slow down](https://developers.google.com/search/docs/crawling-indexing/reduce-crawl-rate) across the whole hostname.

Politeness changes the capacity math. At one request per host every 10 seconds, each host supplies at most 0.1 pages a second. To reach 1,540 pages a second, the crawler must work on at least 1,540 ÷ 0.1 = **15,400 hosts at once**. That's why step 4 shards the crawler by host.

### Crawler traps

A **crawler trap** (or spider trap) is a set of URLs that never runs out. *Introduction to Information Retrieval* describes [pages "that mislead crawlers into getting stuck fetching an infinite number of pages"](https://nlp.stanford.edu/IR-book/html/htmledition/features-a-crawler-must-provide-1.html), and notes that many are accidents of "faulty website development". Google's [URL structure guidelines](https://developers.google.com/search/docs/crawling-indexing/url-structure) list common causes:

- **Calendars** that link to the next and previous day with no end: `/calendar?date=2026-10-20` links to `2026-10-21`, and so on forever.
- **Filters and sort orders** that combine, so a shop with 20 filters produces millions of listing URLs.
- **Session IDs in URLs**, which give every visit a fresh set of URLs.
- **Broken relative links**, which produce `/docs/section/section/section/...` if the server answers every path with a page instead of a 404.

Some responses never end, such as an audio stream. Common Crawl [truncates every fetch at 5 MiB](https://commoncrawl.org/blog/august-2026-crawl-archive-now-available) for this reason.

Content checks catch some traps, but a calendar's pages really do differ. Add limits:

- **Cap each download** in size and time.
- **Cap URLs** by length, path depth and repeated path segments.
- **Budget each host:** a page budget per crawl cycle, scaled by popularity. A small site that suddenly has 10 million queued URLs is much more likely a trap than a success.
- **Strip known session parameters** while normalizing URLs.
- **Rely on priority.** Pages deep in a trap have few links from other sites, so a good score sinks them.

```python
from urllib.parse import urlsplit


def looks_like_trap(url, max_len=2000, max_depth=15, max_repeats=3):
    segments = [s for s in urlsplit(url).path.split("/") if s]
    return (len(url) > max_len
            or len(segments) > max_depth
            or any(segments.count(s) > max_repeats for s in set(segments)))
```

### Use case: User inputs a search term and sees a list of relevant pages with titles and snippets

1. The **client** sends the search to the **web server**, running as a [reverse proxy](/learn/reverse-proxy-and-api-gateway#what-a-reverse-proxy-does-for-you).
2. The web server forwards it to a **Query API** server.
3. The Query API parses the query: it removes markup, breaks the text into terms, fixes typos, normalizes capitalization, and converts the query to boolean operations.
4. It asks the **reverse index service** for matching documents. That service ranks the matches and returns the IDs of the best ones.
5. It asks the **document service** for their titles and snippets, and returns the results.

Step 3 on the input ` <b>Helo</b> WORLD `:

| Step | Result |
| --- | --- |
| Remove markup | `Helo WORLD` |
| Break into terms | `Helo`, `WORLD` |
| Fix typos | `Hello`, `WORLD` (the index knows "hello" is common and "helo" is rare) |
| Normalize capitalization | `hello`, `world` |
| Boolean form | `hello AND world` |

The public API is [REST](/learn/protocols-and-apis#rest-resources-and-representations): a `GET` with the query in the URL.

```text
$ curl "https://search.com/api/v1/search?query=hello+world"
```

```json
{
  "query": "hello world",
  "results": [
    {"title": "foo's title", "snippet": "foo's snippet", "link": "https://foo.com"},
    {"title": "bar's title", "snippet": "bar's snippet", "link": "https://bar.com"},
    {"title": "baz's title", "snippet": "baz's snippet", "link": "https://baz.com"}
  ],
  "next_page": "/api/v1/search?query=hello+world&page=2"
}
```

Because it's a `GET` with everything in the URL, browsers, CDNs and our own cache can all cache it by the normalized query.

Between the Query API and the internal services, use [RPC](/learn/protocols-and-apis#rpc-calling-a-function-on-another-machine), such as gRPC. The calls are fixed functions ("find documents for these terms", "get documents by ID") between services we own, and compact binary messages over persistent connections save time on a path that must be fast.

## Step 4: Scale the design

```diagram
title: Scaled design. Internal load balancers are left out to reduce clutter.
[client:client] User @ 0,0
[dns] DNS @ 0,1
[lb] Load balancer @ 1,0
[web] Web servers @ 2,0
[api] Query API\nservers @ 3,0
[cache:store] Memory cache @ 4,0
[ris:store] Reverse index\n(sharded) @ 3,1
[ds:store] Document svc\n(sharded) @ 4,1
[jobs:queue] Job queues @ 3.5,2
[crawler] Crawler fleet\n(by host) @ 2,2
[front:store] NoSQL frontier,\ncrawled_links @ 1,2
[mr] MapReduce\ndedup @ 0,2
[dnsc:store] DNS cache,\nrobots cache @ 2,3
[pages:store] Page store @ 3.5,3
[www:client] Web sites @ 1,3
client -> dns
client -> lb
lb -> web
web -> api
api -> cache
api -> ris
api -> ds
jobs --> ris
jobs --> ds
crawler --> jobs
crawler <-> front
mr -> front
crawler -> dnsc
crawler -> pages
crawler -> www : fetch
```

**Don't jump straight to the final design.** Say that you would (1) **benchmark** and load-test, (2) **profile** to find bottlenecks, (3) fix them one at a time while weighing alternatives and trade-offs, and (4) repeat. [Design a system that scales to millions of users](/learn/design-scaling-aws) shows that loop on a smaller system. Here, the step-1 numbers predict the bottlenecks:

| Number from step 1 | What breaks |
| --- | --- |
| 116,000 searches a second at peak | One web server, API server or index server can't take it. |
| 10 TB index, 500 GB of documents | The index doesn't fit in one machine's memory, so latency depends on disk. |
| Uneven, repetitive search traffic | Popular queries redo the same work thousands of times a second. |
| 3,100 open fetches across 15,400 hosts | One crawler machine runs out of connections, and DNS lookups pile up. |
| 77,000 new links a second | The frontier database takes a lookup and a write for every link. |
| 6.2 Gbit/s inbound, 2 PB a month | Network and storage must be sized for the crawl, not only for users. |

### DNS, load balancer and web servers

Users reach the service through [DNS](/learn/dns-and-cdn#how-dns-works), which returns a **load balancer**'s address. The load balancer spreads requests over many identical **web servers**. Adding copies of a stateless server is **horizontal scaling**, and it answers the 116,000-a-second peak. It costs more machines to run, and every server must stay stateless; see [horizontal scaling and what it costs](/learn/load-balancing#horizontal-scaling-and-what-it-costs). Run the load balancers in pairs so they aren't a single point of failure.

The web servers act as [reverse proxies](/learn/reverse-proxy-and-api-gateway#what-a-reverse-proxy-does-for-you): they terminate TLS, compress responses and forward requests to the **Query API servers**, a separate [application layer](/learn/reverse-proxy-and-api-gateway#separating-the-web-and-application-layers). Splitting the layers lets the web layer scale with connections and the API layer scale with query work.

### A memory cache for popular queries

Some searches are very popular, and others run once. Serve popular ones from a **memory cache** such as Redis or Memcached, keyed by the normalized query. That cuts response time, keeps load off the reverse index and document services, and absorbs [uneven traffic and spikes](/learn/cache#caches-smooth-out-uneven-load), such as a news event that sends millions of people to one search.

Memory is much faster than storage. In the widely shared [latency numbers table](https://gist.github.com/jboner/2841832), reading 1 MB sequentially takes about 250 µs from memory, 1 ms from an SSD (4 times as long) and 20 ms from a spinning disk (80 times as long).

Ten million cached result pages at 5 KB each come to 50 GB, which a small Redis cluster holds easily. How much traffic that absorbs depends on how skewed queries are, so measure the hit rate. Use [cache-aside](/learn/cache#cache-aside) with a TTL of minutes to an hour, so results catch up with recrawls, and [LRU eviction](/learn/cache#when-the-cache-is-full) so rare queries fall out. When a very popular entry expires, thousands of requests can hit the index at once; [cache stampede](/learn/cache#cache-stampede-thundering-herd) covers the fixes.

### Sharding and federation for the index and document services

The reverse index service and document service need heavy use of sharding and federation to handle their data size and request load.

- **Federation** splits data by function into separate databases. The reverse index, the documents and the crawl tables already live in separate stores owned by separate services, so each can be sized and scaled for its own load. See [federation](/learn/relational-databases#federation-one-database-per-feature).
- **Sharding** splits one dataset across many machines. See [sharding](/learn/relational-databases#sharding-splitting-one-table-across-databases).
  - The **document service** shards by document ID. Ten results touch at most 10 shards, in parallel. 500 GB over 10 shards is 50 GB each, which fits in memory.
  - The **reverse index** can be split by document (each shard indexes some pages, and every query asks every shard) or by term (each shard owns some words, and a query asks only those shards). By document is the usual choice because it balances load and survives a lost shard better; see [partitioning the index](/learn/design-search-engine#partitioning-the-index-by-document-or-by-term). 10 TB over 50 shards is 200 GB each, enough to keep each shard's hot part in memory.
- Each shard has **replicas**, which add read capacity for the peak and keep the service up when a machine fails.

The cost is complexity. A query fans out to many shards and waits for the slowest, so [tail latency](/learn/performance-and-latency#the-tail-at-scale) matters, and resharding as the index grows takes planning.

### Scaling the frontier and crawled_links

`links_to_crawl` and `crawled_links` stay in a [key-value NoSQL store](/learn/nosql-databases#key-value-stores), sharded by **hash of the host name**. All of a host's URLs then sit on one shard, which is what per-host politeness needs: the crawler that owns a shard enforces the rate for its hosts without asking anyone. The trade-off is skew, since a huge site makes its shard heavier. Place hosts with [consistent hashing](/learn/consistent-hashing) and split the largest out.

The 77,000 new links a second never hit the database directly. Each crawler's Bloom filter drops URLs it has seen, and the MapReduce job removes repeats from large URL lists before they're merged into the frontier.

These tables can be **eventually consistent**. If one crawler briefly misses that another just recorded a URL, the worst case is fetching a page twice, a small price for fast, available writes. See [the consistency spectrum](/learn/cap-and-consistency#the-consistency-spectrum).

### Scaling the crawler service

- **Partition crawlers by host.** Each crawler machine owns a range of host hashes, matching the frontier shards. A failed machine's range is reassigned.
- **Keep a DNS cache.** Every fetch needs the host's IP address, and DNS lookups can become the bottleneck, so the crawler keeps its own cache, refreshed periodically. Google's 1998 crawler did the same: [each crawler kept "its own DNS cache"](http://infolab.stanford.edu/~backrub/google.html) because DNS lookup was "a major performance stress". Keep the robots cache beside it.
- **Keep many connections open.** Fetching is mostly waiting, so each machine runs thousands of fetches at once with asynchronous I/O. Google's early crawlers each kept about 300 connections open, and four of them peaked at over 100 pages a second. Our 3,100 open fetches spread over a few dozen machines. Reusing a connection for the next request to the same host (**connection pooling**, or keep-alive) saves a TCP and TLS handshake each time; see [connection pooling](/learn/protocols-and-apis#what-the-guarantees-cost).
- **Use UDP where it applies.** Switching to UDP can help, but only in two places. DNS queries already use it: [RFC 1035](https://www.rfc-editor.org/rfc/rfc1035#section-4.2.1) calls UDP "the recommended method for standard queries". Page fetches use HTTP/1.1 or HTTP/2 over TCP, except for servers that support HTTP/3, which runs over QUIC on UDP and needs fewer handshake round trips. See [HTTP/3](/learn/protocols-and-apis#http3-streams-move-into-the-transport).
- **Provision bandwidth.** Crawling is bandwidth-intensive: 6.2 Gbit/s on average, all day. Size network links for that with headroom. Conditional requests and compressed responses (`Accept-Encoding: gzip`) reduce it.
- **Put raw pages in object storage.** The 2 PB a month go to a cheap, replicated object store. Decide early between every version (72 PB over 3 years) and the latest only (500 TB).

### Keeping the service available

- **Search path:** replicated web servers, API servers, cache nodes and index shards behind load balancers, spread across failure domains. If one index shard is down, the Query API returns results from the others, which is better than an error. See [graceful degradation](/learn/availability#graceful-degradation).
- **Databases:** replicas with automatic [fail-over](/learn/availability#fail-over-active-passive) for the document and crawl stores.
- **Crawl path:** durable job queues, so a crashed indexer loses nothing, and URL leases, so a crashed crawler's URLs return to the frontier. Search keeps serving the existing index even if the crawl stops for an hour, so the crawl can accept weaker availability than search.

## Trade-offs and follow-up questions

**1. How to store the frontier?** A Redis sorted set gives one priority order and is easy to explain, but knows nothing about hosts. The Mercator front and back queues handle priority and politeness together, with more machinery. A log such as Kafka is durable and fast but has no priority order. Start with the sorted set sharded by host, with per-host back queues as the politeness layer. See [the crawl frontier](/learn/design-search-engine#the-crawl-frontier-priority-and-politeness).

**2. Exact or approximate "seen URL" checks?** A database lookup is exact but costs a read per link, 77,000 a second. A Bloom filter holds a billion URLs in 1.2 GB but skips about 1% of new URLs. Use the Bloom filter as the fast first pass, and confirm "probably seen" answers in the database if losing 1% of new pages matters.

**3. Exact or near-duplicate content detection?** SHA-256 is cheap and never wrong about identical pages, but misses a changed timestamp. MinHash or SimHash catch near-duplicates, with a threshold that will sometimes merge pages that really differ. Use the exact hash first, then a near-duplicate check before indexing.

**4. How often to recrawl?** A fixed weekly cycle is simple and predictable. Adaptive intervals spend the budget on pages that change. Cho and Garcia-Molina's results warn against recrawling purely in proportion to change rate. Use adaptive intervals with a floor and a ceiling, weighted by popularity.

**5. Every version or only the latest?** 72 PB versus 500 TB over three years. Unless the product needs page history, keep the latest copy plus the signature history, which is tiny.

**6. Static or query-dependent snippets?** Static snippets are cheap to serve and cache. Snippets that highlight the search words are more useful but need page text at query time. Start static, as required, and mention the upgrade.

**7. How polite is polite enough?** A stricter per-host rate protects sites but slows the crawl of large ones. The ten-times-the-fetch-time rule adapts by itself. Honor `robots.txt`, `Crawl-delay`, `429`, `503` and `Retry-After`, then use sitemaps and conditional requests to spend a large site's budget on pages that changed. The [rate limiting chapter](/learn/rate-limiting) covers the algorithms a per-host limiter can use.

## Check yourself

<details>
<summary>The product team wants the 100 million most popular pages refreshed daily, and the other 900 million weekly. What fetch rate and bandwidth does that need?</summary>

Daily pages: 100,000,000 × 30 = 3,000,000,000 fetches a month. Weekly pages: 900,000,000 × 30 ÷ 7 ≈ 3,860,000,000. Together, about 6,860,000,000 fetches a month.

6,860,000,000 ÷ 2,592,000 s ≈ 2,650 fetches a second, up from 1,540. At 500 KB each, that's about 1.3 GB a second, or roughly 10.6 Gbit/s. With a 2-second fetch, Little's Law puts about 5,300 fetches in flight. Check politeness before agreeing, because popular pages cluster on a few large sites. Conditional requests matter too, since most daily refetches will return `304 Not Modified`.

</details>

<details>
<summary>Overnight, the frontier grew by 40 million URLs from one small site, all like /events?date=2031-04-17. What happened, and what do you change?</summary>

The crawler fell into a calendar trap. Each date page links to the next and previous dates with no end, and each day's page is slightly different, so the content checks didn't stop it.

Remove the site's queued URLs. Then add a per-host page budget scaled by popularity, so a small site can't flood the frontier, and URL limits on length, depth and repeated segments. Also check the site's `robots.txt`, since many sites disallow their calendars.

</details>

<details>
<summary>A host's robots.txt has returned 503 for three days. What should the crawler do under RFC 9309? What if it had returned 404?</summary>

A 5xx status makes the file "unreachable", and the crawler must assume complete disallow: fetch nothing from that host, and keep retrying `robots.txt`. If it lasts a long time (the RFC's example is 30 days), the crawler may treat the file as unavailable or keep using a cached copy.

A 404 makes the file "unavailable", which means no restrictions. The crawler may fetch any URL on the host, still under its own per-host rate limit.

</details>

<details>
<summary>A colleague's MapReduce job for removing duplicate URLs emits a URL only when its count is 1. It outputs 300 million URLs from an input with 1 billion distinct ones. Why?</summary>

The reducer drops every URL that appeared two or more times. Popular URLs appear many times, because many pages link to them, so the job threw away most of the URLs that matter. Emit every key once, whatever its count. Keep the count, though: it's how often the URL was linked, which can feed its crawl priority.

</details>

<details>
<summary>A site with 50 million pages allows one request a second. Can the crawler refresh it weekly? What would you do?</summary>

No. 50,000,000 requests at one a second take 50,000,000 seconds, about 579 days for one pass.

Spend the budget where it counts. Use the site's sitemaps and `<lastmod>` dates to find changed pages, checking them since sites aren't always accurate. Send conditional requests so unchanged pages cost a `304` with no body. Prioritize by popularity and measured change rate, and accept that the long tail is refreshed rarely. It's also worth asking the site for a higher rate or a feed of changes.

</details>

<details>
<summary>A crawler machine crashes. Which URLs are lost, and how does the design recover?</summary>

With plain `ZPOPMAX`, every URL the machine had popped but not recorded is lost: it left `links_to_crawl` and never reached `crawled_links`. That's around a hundred URLs per crash.

With leases, popping moves a URL into an in-progress set with a deadline, and a sweeper returns expired ones to the frontier. The machine's host range goes to another crawler, which rebuilds its per-host queues from the frontier shard. Pages already queued for indexing are safe in the durable queues. A page may be fetched twice after a crash, so indexing must be idempotent: indexing the same URL and signature twice gives the same result.

</details>

## Further reading

- [RFC 9309: Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309): the 2022 standard for `robots.txt`. Short, and it settles matching, error and caching questions.
- [How Google interprets the robots.txt specification](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt): how one large crawler applies RFC 9309, including ignoring `crawl-delay`.
- [Introduction to Information Retrieval: The URL frontier](https://nlp.stanford.edu/IR-book/html/htmledition/the-url-frontier-1.html): the front and back queue design for priority and politeness. Its neighbors on [crawler architecture](https://nlp.stanford.edu/IR-book/html/htmledition/crawler-architecture-1.html), [what a crawler must provide](https://nlp.stanford.edu/IR-book/html/htmledition/features-a-crawler-must-provide-1.html) and [near-duplicates and shingling](https://nlp.stanford.edu/IR-book/html/htmledition/near-duplicates-and-shingling-1.html) cover the rest of this chapter's crawler.
- [The Anatomy of a Large-Scale Hypertextual Web Search Engine](http://infolab.stanford.edu/~backrub/google.html) (Brin and Page, 1998): section 4.3 describes Google's first crawler, its DNS cache, and the social side of crawling.
- [Synchronizing a database to improve freshness](https://www.kth.se/social/files/554f1d5bf27654514fd00393/synchronizing-a-database-to-improve-freshness.pdf) (Cho and Garcia-Molina, SIGMOD 2000): why recrawling in proportion to change rate backfires.
- [Common Crawl: August 2026 crawl archive](https://commoncrawl.org/blog/august-2026-crawl-archive-now-available): real figures for a crawl of about 2 billion pages, for sanity-checking estimates.
- [Google: URL structure best practices](https://developers.google.com/search/docs/crawling-indexing/url-structure): the common sources of infinite URL spaces, from the site owner's side.
- [Google: Reduce the Googlebot crawl rate](https://developers.google.com/search/docs/crawling-indexing/reduce-crawl-rate) and [Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap): how a large crawler reacts to 429 and 503, and which sitemap fields it trusts.
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110): conditional requests, `304 Not Modified` and `Retry-After`, which make recrawling cheaper and politer.
- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/): the data structure behind `links_to_crawl`.
- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832): the memory, SSD and disk figures behind the case for a memory cache.
