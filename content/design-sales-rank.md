# Design Amazon's sales rank by category

Open a product page on a large online store and you will often see a line such as "#3 in Kitchen Scales". Browse a category and you can sort it by "Best Sellers". Both come from a **sales rank**: for each category, a list of products ordered by how many units sold recently. This chapter designs the service that computes those lists and the API that serves them.

The two halves of the problem pull in opposite directions. Computing the rank means reading every sale from the past week, about a quarter of a billion records, and adding them up by category and product: a large, slow, offline job. Serving the rank means answering tens of thousands of requests a second for the same few lists: a small, fast lookup. The design keeps the two apart. A batch job does the heavy counting once an hour, and the read path only looks up the job's last answer.

Amazon describes its own version, Best Sellers Rank, in a short help page. The page says the calculation "is based on Amazon sales, and is updated frequently to reflect recent and historical sales of every item sold on Amazon". It also says Amazon created category and subcategory lists because the overall list "doesn't always indicate how well an item is selling in relation to similar items", and that a product page shows the item's rank in a few popular subcategories where it ranks high. The UK and Canadian versions of the same page say the calculation is updated hourly. The page doesn't give a formula, so this chapter designs a simpler rule of its own: units sold in the past seven days.

The chapter follows the four steps from [The system design interview, step by step](/learn/system-design-interview).

## Step 1: Outline use cases, constraints and assumptions

### Use cases

We'll scope the problem to these use cases:

- **The service calculates the past week's most popular products in each category.** "Most popular" means the most units sold.
- **A user views the past week's most popular products in a category.** For example, the top 20 sellers in "Kitchen Scales".
- **The service is highly available.** If the ranking job fails or a database goes down, users still see a ranking, even if it's an hour or two old.

### Out of scope

- The rest of the store: the catalog, search, the cart, checkout and payments. We only design the parts that compute and serve the sales rank.
- How sales are recorded in the first place. We assume the checkout system calls a **Sales API** for every completed sale, and that this API writes a log line we can read later.

### Assumptions

These numbers are inputs for the exercise. They aren't figures from Amazon.

- Traffic is not evenly distributed. Some categories and some hours are much busier than others.
- A product can be in several categories. A kitchen scale might be in "Kitchen Scales" and in "Baking Tools".
- A product never changes category.
- Categories are flat. There are no subcategories such as `home/kitchen/scales`.
- Rankings must be refreshed at least once an hour. The most popular products might need refreshing more often.
- There are 10 million products and 1,000 categories.
- There are 1 billion sales transactions a month.
- There are 100 billion read requests a month for rankings, so reads outnumber transactions 100 to 1.

### Calculate usage

**Size of one transaction.** Each sale record holds:

| Field | Size |
| --- | --- |
| `created_at` (timestamp) | 5 bytes |
| `product_id` | 8 bytes |
| `category_id` | 4 bytes |
| `seller_id` | 8 bytes |
| `buyer_id` | 8 bytes |
| `quantity` | 4 bytes |
| `total_price` | 5 bytes |
| **Total** | **42 bytes, call it about 40** |

**Storage.**

- New sales data per month: 1 billion × 42 bytes = 42 GB, or about 40 GB.
- Over three years: 42 GB × 36 months = 1,512 GB, about 1.5 TB.
- Almost all of this is new records. Sales are appended to a log and never updated in place.

**Request rates.** A 30-day month has 30 × 86,400 = 2,592,000 seconds, about 2.6 million. So 1 request a second is about 2.6 million requests a month.

- Transactions: 1,000,000,000 ÷ 2,592,000 ≈ 386 a second, about **400 a second** on average. Traffic is uneven, so assume a peak of three times that, about **1,200 a second**.
- Reads: 100,000,000,000 ÷ 2,592,000 ≈ 38,600 a second, about **40,000 a second** on average and about **120,000 a second** at a 3× peak.

**Input to one ranking run.** A week is 7 ÷ 30 of a month:

- 1 billion × 7 ÷ 30 ≈ 233 million transactions in the window.
- 233 million × 42 bytes ≈ 9.8 GB, about **10 GB** of input per run.
- One hour of sales is 1 billion ÷ (30 × 24) ≈ 1.4 million transactions, about 58 MB.

**Size of the result.** The output has at most one row per (category, product) pair that sold something in the week. Assume each product is in two categories on average. Then there are at most 10 million × 2 = 20 million rows. Budget 100 bytes a row, including indexes and per-row overhead, and the whole table is 20 million × 100 bytes = **2 GB**. If we keep only the top 100 products in each category, it's 1,000 × 100 = 100,000 rows, about **10 MB**.

**Read bandwidth.** Assume a response holds 20 products and is about 2 KB of JSON. Then 40,000 × 2 KB = 80 MB a second on average, and 240 MB a second at peak.

**What these numbers tell us.**

- Reads dominate, and they all ask for one of only 1,000 lists. The answers fit in a few megabytes of memory. That's a perfect fit for a cache, and even for a CDN.
- Writes are simple appends at a few hundred a second. They don't need a database on the hot path; a log in cheap storage is enough.
- The ranking itself is a batch computation over about 10 GB, repeated every hour. That's modest for a small cluster, but it's a full re-read of data that has mostly been read before. We'll look at doing it incrementally.
- Three years of raw sales, about 1.5 TB, is too much to keep in the database that serves reads, but trivial for an object store.

The [estimation](/learn/estimation) chapter explains this kind of arithmetic in more detail.

## Step 2: Create a high-level design

```diagram
title: Sales rank: the first design
[client:client] Client @ 0,1
[web] Web server\n(reverse proxy) @ 1,1
[read] Read API @ 2,0
[sales] Sales API @ 2,2
[rank] Sales Rank\nService @ 3,1
[db:store] SQL database\n(sales_rank) @ 4,0
[obj:store] Object store\n(sales logs) @ 4,2
client -> web
web -> read
web -> sales
read -> db : top products
sales -> obj : append log
obj -> rank : hourly job
rank -> db : load results
```

- **Client.** A browser or app showing a category's best sellers, and the checkout flow that reports sales.
- **Web server.** A [reverse proxy](/learn/reverse-proxy-and-api-gateway#what-a-reverse-proxy-is) that terminates HTTPS and forwards each request to the right API server.
- **Sales API.** Receives each completed sale and appends it to a log.
- **Object store.** A managed store for files, such as Amazon S3, that holds the sales logs. It's cheaper and simpler than running our own distributed file system, and it handles the 40 GB a month easily.
- **Sales Rank Service.** A batch job that runs every hour. It reads the past week of logs, counts units per category and product, sorts them, and writes the result.
- **SQL database.** Holds the `sales_rank` table, the precomputed answer. It's the only thing the read path needs.
- **Read API.** Answers "what are the top products in category X" by reading `sales_rank`.

## Step 3: Design core components

### Use case: Service calculates the past week's most popular products by category

#### The sales log

Every time a sale completes, the Sales API appends one line per category the product belongs to. A product in two categories produces two lines for one sale. Writing the category into the log at sale time keeps the ranking job simple: it never has to look up which categories a product is in. This is safe because we assumed products never change category. The edge cases section revisits this choice.

The Sales API writes lines to a local file and ships each finished file to the object store every few minutes. Files are stored under a prefix for the hour they cover, for example `sales/2026/10/18/13/part-0007.gz`. That layout matters later: a job that needs one week of data reads exactly 168 hourly prefixes and never touches older files.

Here is a sample of the log, tab-delimited:

```text
timestamp             product_id  category_id  qty  total_price  seller_id  buyer_id
2026-10-12T09:14:03Z  1001        12           2    39.98        501        90017
2026-10-12T09:14:03Z  1001        40           2    39.98        501        90017
2026-10-14T11:29:47Z  2002        12           5    24.95        733        91020
2026-10-16T20:05:31Z  3003        40           4    59.96        812        90017
2026-10-18T13:12:09Z  4004        12           2    5.98         950        92611
2026-10-03T10:00:00Z  2002        12           9    44.91        733        93001
```

The first two lines are one sale of product 1001, which is in categories 12 and 40. The last line is older than a week, so a ranking computed at midnight on October 19 should ignore it.

**Clarify with your interviewer how much code they expect.** The core of the job fits in a few short functions, so it's worth sketching.

#### The ranking job: two passes of MapReduce

**MapReduce** is a way to process a large data set on many machines by writing just two functions. A **map** function reads one input record and emits zero or more key-value pairs. The framework then **shuffles** the pairs: it sorts them and sends every pair with the same key to the same machine. A **reduce** function receives one key with all of its values and emits the result. The framework handles splitting the input, moving data between machines and retrying failed tasks. The [batch processing](/learn/batch-processing#mapreduce-the-foundational-model) chapter explains how it works underneath. Hadoop and Spark both run jobs of this shape.

The job runs as two passes:

1. **Pass 1, count.** The map step reads each log line and, if the sale falls inside the window, emits the key `(category_id, product_id)` with the value `quantity`. The reduce step sums the quantities for each key. The output is the total units sold per product per category.
2. **Pass 2, sort.** The map step rewrites each total so the sort key is `(category_id, -total, product_id)`. The shuffle then does a distributed sort on that key. The reduce step reads each category's products in order, assigns ranks 1, 2, 3 and so on, and keeps the top N.

Here is the logic in Python, with a small driver that plays the framework's part on one machine so the code can be tested:

```python
from datetime import datetime, timedelta, timezone
from itertools import groupby

WINDOW = timedelta(days=7)
TOP_N = 100


def parse(line):
    """Split one tab-delimited log line into the fields the job needs."""
    ts, product_id, category_id, qty, _price, _seller, _buyer = line.split("\t")
    return (datetime.fromisoformat(ts), int(product_id),
            int(category_id), int(qty))


# Pass 1: total units per (category, product) inside the window.

def map_sales(line, window_start, window_end):
    ts, product_id, category_id, qty = parse(line)
    if window_start <= ts < window_end:
        yield (category_id, product_id), qty


def reduce_sum(key, quantities):
    yield key, sum(quantities)


# Pass 2: order each category by units sold, highest first.

def map_sort_key(key, total):
    category_id, product_id = key
    # Negate the total so an ascending sort puts best sellers first.
    # product_id breaks ties, so the order is the same on every run.
    yield (category_id, -total, product_id), None


def reduce_rank(category_id, sorted_keys):
    """Receives one category's keys, already sorted by the shuffle."""
    for rank, (_cat, neg_total, product_id) in enumerate(sorted_keys, 1):
        if rank > TOP_N:
            break
        yield category_id, rank, product_id, -neg_total


def run_locally(lines, window_end):
    """A one-machine stand-in for the framework, to test the logic."""
    window_start = window_end - WINDOW

    # Pass 1: map, then shuffle (group by key), then reduce.
    pairs = [kv for line in lines
             for kv in map_sales(line, window_start, window_end)]
    pairs.sort(key=lambda kv: kv[0])
    totals = [out for key, group in groupby(pairs, key=lambda kv: kv[0])
              for out in reduce_sum(key, (qty for _, qty in group))]

    # Pass 2: sort on the composite key, partition by category.
    keys = sorted(k for key, total in totals
                  for k, _ in map_sort_key(key, total))
    for category_id, group in groupby(keys, key=lambda k: k[0]):
        yield from reduce_rank(category_id, group)
```

Running it on the sample log with `window_end` set to midnight UTC on October 19, 2026 gives:

```text
pass 1 output                  pass 2 output (category, rank, product, units)
(12, 1001) -> 2                (12, 1, 2002, 5)
(12, 2002) -> 5                (12, 2, 1001, 2)
(12, 4004) -> 2                (12, 3, 4004, 2)
(40, 1001) -> 2                (40, 1, 3003, 4)
(40, 3003) -> 4                (40, 2, 1001, 2)
```

The sale of 9 units of product 2002 on October 3 was dropped by the window check, so 2002 has 5 units in category 12, not 14. Products 1001 and 4004 tie at 2 units in category 12, and the lower product ID wins. We'll come back to whether that's fair.

Three details make pass 2 work on a real cluster:

- **Sort descending.** A shuffle sorts keys in ascending order. Putting `-total` in the key makes the best seller come first, so the reducer can stop after N products. Sorting on `total` directly would put the slowest sellers first.
- **Partition by category only.** The framework decides which reducer gets a key by hashing a **partition key**. If it hashed the whole `(category, -total, product)` tuple, one category's products would be scattered over many reducers, and none could assign ranks. So we partition on `category_id` alone and let the sort order the rest of the key within each partition. This combination is called a **secondary sort**.
- **Prune early.** After pass 1, each (category, product) pair appears exactly once with its final total. So each map task in pass 2 can safely keep only its own top N per category before the shuffle; no product it drops could make the overall top N. With 1,000 categories and N = 100, the shuffle moves at most 100,000 entries per map task instead of millions. This pruning would be wrong in pass 1, where a product's units are still spread over many map tasks.

Each run reads only the 168 hourly prefixes in the window. The window check in `map_sales` is still needed, because the first and last files can contain a few lines just outside the boundary. Without the hourly layout, the job would have to read every log ever written just to throw most of it away: about 1.5 TB after three years, to use 10 GB.

#### The `sales_rank` table

The job's output goes into a table in a SQL database:

```sql
CREATE TABLE sales_rank (
    id           BIGINT    NOT NULL AUTO_INCREMENT,
    run_id       BIGINT    NOT NULL,   -- which hourly run produced this row
    category_id  INT       NOT NULL,
    rank_in_category INT   NOT NULL,
    product_id   BIGINT    NOT NULL,
    total_sold   INT       NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (product_id)  REFERENCES products(id),
    UNIQUE KEY by_category (run_id, category_id, rank_in_category),
    KEY by_product (run_id, product_id)
);

CREATE TABLE sales_rank_current (
    id      INT    NOT NULL PRIMARY KEY,   -- always 1
    run_id  BIGINT NOT NULL,
    window_start TIMESTAMP NOT NULL,
    window_end   TIMESTAMP NOT NULL
);
```

- `id` is a surrogate primary key. It's indexed automatically.
- `category_id` and `product_id` refer to the catalog's tables. If those live in another team's database, the foreign keys become a documented convention instead of a constraint.
- The `by_category` index serves the main query, "top N products in category X". Because it includes `rank_in_category`, the database reads N consecutive index entries and stops.
- The `by_product` index serves "what are this product's ranks?", which a product page needs.
- `run_id` lets each hourly run write a complete new set of rows next to the old one. The tiny `sales_rank_current` table says which run is live. Publishing a run is one update to that table, so readers switch from the old ranking to the new one all at once and never see a half-loaded result. A cleanup job deletes runs older than a day or two.

Indexes make lookups take time proportional to the logarithm of the table size instead of scanning every row, and they help keep the hot data in memory. That matters: reading 1 MB sequentially from memory takes about 250 microseconds, from an SSD about 1 ms (4 times longer), and from a spinning disk about 20 ms (80 times longer), according to the widely shared table of latency numbers credited to Jeff Dean. At 2 GB for the full table, or 10 MB for the top 100 per category, this table fits in memory on any database server. See [Use good indexes](/learn/relational-databases#use-good-indexes) for how indexes work.

Why a relational database here? The data is small, the queries are simple lookups, and the hourly bulk load is easy to do in a transaction-friendly way. A key-value store would work too, for example storing each category's top list as one value. The trade-offs section compares the two.

### Use case: User views the past week's most popular products by category

The read path:

1. The **client** sends a request to the **web server**, which runs as a reverse proxy.
2. The **web server** forwards it to a **Read API** server.
3. The **Read API** looks up the live `run_id` and reads the category's rows from `sales_rank`.

The query behind it:

```sql
SELECT r.rank_in_category, r.product_id, r.total_sold
FROM sales_rank r
JOIN sales_rank_current c ON c.id = 1 AND r.run_id = c.run_id
WHERE r.category_id = 1234
  AND r.rank_in_category BETWEEN 1 AND 20
ORDER BY r.rank_in_category;
```

The public interface is a [REST](/learn/protocols-and-apis#rest-resources-and-representations) endpoint:

```text
GET https://shop.example.com/api/v1/popular?category_id=1234&limit=20
```

```json
{
  "category_id": 1234,
  "window_start": "2026-10-12T13:00:00Z",
  "window_end": "2026-10-19T13:00:00Z",
  "products": [
    {"rank": 1, "product_id": 50, "total_sold": 100000},
    {"rank": 2, "product_id": 200, "total_sold": 90000},
    {"rank": 3, "product_id": 3, "total_sold": 80000}
  ],
  "next_cursor": "rank:4"
}
```

- The response says which window it covers, so a client can tell how fresh it is.
- `limit` and `next_cursor` page through longer lists. Since rank is a stable integer within a run, the cursor can simply be the next rank. The [pagination](/learn/protocols-and-apis#pagination) section covers the alternatives.
- Whether to show `total_sold` publicly is a business decision. Exact sales numbers tell competitors a lot. The internal API can return them while the public one returns ranks only.
- The page also needs product names, prices and images. Those come from the catalog service by ID and are cached separately.

Inside the data center, services such as the Read API and the catalog service can talk to each other over [RPC](/learn/protocols-and-apis#rpc-calling-a-function-on-another-machine) such as gRPC. REST suits the public API because any client can call it and HTTP caches understand it.

#### Going further: a sliding window, done incrementally

"The past week" moves forward every hour. A **sliding window** is a window of fixed length (here 168 hours) that advances by a smaller step (here 1 hour), so consecutive windows overlap and each sale belongs to 168 of them. Stream processors use the same term: Apache Flink's documentation describes windows with a size and a separate "slide", and notes that elements are assigned to several windows when the slide is smaller than the size.

Recomputing all 168 hours every hour reads about 10 GB to account for 58 MB of new data. That's affordable at this size, and it has a real advantage: every run starts from the raw log, so a bug fix or a late file is picked up automatically on the next run. But it grows with the window. A 30-day window would mean reading about 42 GB every hour.

The incremental version keeps hourly partial counts:

1. Every hour, run pass 1 on just the hour that ended, and store its totals per (category, product) as a small file, for example `hourly_counts/2026/10/18/13/`.
2. Keep a running total for the current window. To slide it forward by one hour, add the newest hour's counts and subtract the counts of the hour that just left the window.
3. Run pass 2 on the running totals to produce the new ranking.

```python
def slide_window(running, newest_hour, expired_hour):
    """Each argument maps (category_id, product_id) -> units."""
    for key, units in newest_hour.items():
        running[key] = running.get(key, 0) + units
    for key, units in expired_hour.items():
        running[key] -= units
        if running[key] == 0:
            del running[key]
    return running
```

The cost is that errors stick. If a log file arrives late, or a bad hour is counted twice, the running total stays wrong until someone fixes it. One compromise is to slide incrementally every hour and rebuild the running total from the 168 hourly files once a day, which bounds how long any error can last.

#### Going further: edge cases

**Returns and cancellations.** A product that sells 1,000 units and gets 900 back isn't popular. To count returns, log them as events with a negative quantity, then decide which hour they belong to. The hour of the original sale is most accurate, but it means rewriting an hour that may already be summed. The hour of the return is simpler; the sale and the return may then fall in different windows, so clamp each total at zero. For a best-seller list, the simpler rule is usually good enough.

**A product in several categories.** We fan out at write time: one log line per category. That keeps the job simple and works because categories never change. If they could change, write-time fan-out would keep counting a sale under a category the product has left. The alternative is to log only `product_id` and join to a product-to-categories table inside the map step. That table has 10 million products × 2 categories × about 12 bytes ≈ 240 MB, small enough to load into memory on every map task. Remember, too, that per-category ranks don't add up to an overall rank: a product's total in "Kitchen Scales" and in "Baking Tools" is the same set of sales counted twice.

**Ties.** Two products with the same units must still get an order, and the order should be the same on every run. Otherwise a cache filled from one replica and a page served from another can show two products swapping places for no reason. Our sort key uses `product_id` as the tiebreaker, which is stable but arbitrary. Fairer rules include ranking by revenue, or by which product reached the total first. The [leaderboard design](/learn/design-gaming-leaderboard#breaking-ties) shows how to pack a tiebreaker into a single sort key. You also need to decide how ties display: "1, 2, 2, 4" (shared rank) or "1, 2, 3, 4" (every position unique). Pick one and use it everywhere.

**What counts as a sale.** Counting units lets one bulk order of 500 pens beat 300 separate buyers. Counting orders, or distinct buyers, resists that and also makes it harder for a seller to buy their own product to climb the list. Since `buyer_id` is in the log, any of these is a small change to the map step.

## Step 4: Scale the design

```diagram
title: Sales rank, scaled out (internal load balancers not shown)
[dns] DNS @ 0,0
[client:client] Client @ 0,1
[cdn] CDN @ 0,2
[lb] Load balancer @ 1,1
[web] Web servers @ 2,1
[read] Read API @ 3,1
[sales] Sales API @ 3,2
[cache:store] Memory cache @ 4,0
[replica:store] SQL read\nreplicas @ 4,1
[primary:store] SQL primary\n(+ standby) @ 4,2
[obj:store] Object store @ 3,3
[rank] Sales Rank\nService @ 4,3
[olap:store] Analytics\ndatabase @ 2,3
client -> dns
client -> cdn
client -> lb
lb -> web
web -> read
web -> sales
read -> cache
read -> replica
primary -> replica : replication
sales -> obj : sales logs
obj -> rank
rank -> primary : load run
obj -> olap : load
```

Don't jump straight from the first design to this one. In an interview, and in practice, the process is a loop:

1. **Benchmark and load test** the current design at the expected traffic.
2. **Profile** it to find the bottleneck.
3. **Fix that bottleneck**, weighing the alternatives and their costs.
4. **Repeat.**

The [scaling AWS design](/learn/design-scaling-aws) walks through that loop step by step for a general web app, and [Scalability](/learn/scalability) introduces each of the usual fixes. Here we take the numbers from step 1 and ask what breaks first.

### The read path: 40,000 requests a second

The first design sends every read to one SQL database, which can't keep up with 40,000 requests a second on average and about 120,000 at peak. But every request asks for one of 1,000 lists that change once an hour, so nearly every query repeats one the database answered a moment ago.

**Memory cache.** Put a **memory cache** such as Redis or Memcached between the Read API and the database, with keys like `popular:1234:page1`. The Read API checks the cache first and reads the database only on a miss. This pattern is called [cache-aside](/learn/cache#cache-aside). The cache's working set is tiny: 1,000 categories × a few pages × 2 KB is under 10 MB, so every list stays in memory and the hit rate is close to 100%. The cache also absorbs the uneven traffic: a category that suddenly gets a burst of visits costs the database nothing extra.

The risk is the top of every hour. If every key expires at the moment a new run is published, thousands of requests miss at once and all go to the database. This is a **cache stampede**, explained in [Cache stampede (thundering herd)](/learn/cache#cache-stampede-thundering-herd). The cleanest fix here is for the Sales Rank Service to write the new lists into the cache itself when it publishes a run. That's a form of [refresh-ahead](/learn/cache#refresh-ahead): readers never see a miss caused by the hourly change. Keep a TTL (time to live, an expiry time on each key) of a little over an hour as a safety net, with a few minutes of random jitter so keys don't all expire together.

**CDN.** Because the public response is the same for every user and changes at most once an hour, a **CDN** (content delivery network, a network of caches close to users) can serve it too. The API sets `Cache-Control: public, max-age=300`, and the CDN answers most requests without reaching our servers at all. That also takes care of most of the 80 to 240 MB a second of response bandwidth. The cost is staleness: a user may see the previous hour's list for up to five minutes after a new run. See [CDN caching](/learn/cache#cdn-caching) and [Cache-Control directives](/learn/dns-and-cdn#cache-control-directives).

**DNS.** [DNS](/learn/dns-and-cdn#how-dns-works) points the API's name at the CDN and the load balancer, and with several regions can route each user to the nearest one.

**Load balancer and more web and API servers.** Requests that miss the CDN still need servers. A [load balancer](/learn/load-balancing#what-a-load-balancer-does) spreads them across several web servers and Read API servers, which run as identical, stateless copies. This is **horizontal scaling**: add copies to add capacity, and survive the loss of any one of them. The cost is one more component to run, which itself needs a standby. See [Horizontal scaling and what it costs](/learn/load-balancing#horizontal-scaling-and-what-it-costs).

**Separate web and API layers.** Splitting the **web servers** (connections, TLS, routing) from the **Read API** and **Sales API** (application logic) lets each scale on its own: the read side needs many copies, the write side few. See [Separating the web and application layers](/learn/reverse-proxy-and-api-gateway#separating-the-web-and-application-layers).

**SQL read replicas.** With the cache in place, the database sees few reads: misses after a cache node restarts, and the long tail of product-page lookups ("what's this product's rank?"), which spread across up to 20 million rows. **Read replicas** are copies of the database that receive every change from the primary and serve reads. Two or three replicas give room for those misses and keep the read path up if one fails. Replicas lag slightly behind the primary, but since publishing a run is one row change in `sales_rank_current`, a replica either shows the new run or the old one, never a mix. See [Primary-replica replication](/learn/relational-databases#primary-replica-replication).

### The write path: the ranking database and the raw sales data

**What the SQL primary does.** In this design the database that serves reads takes very few writes: one bulk load per hour of up to a few million rows, plus a one-row update to publish. The 400 transactions a second never touch it, because the Sales API appends them to the log. That's the main reason the design scales so well.

If the business also wanted raw transactions in a SQL database, 400 inserts a second on average and about 1,200 at peak would land on one primary, and every insert would also have to reach each replica. That leaves little room for growth and would push us toward the scaling patterns below.

**Fail-over for the primary.** The primary is a single point of failure for publishing runs. Run it with a standby that takes over if it fails: a **primary-standby** pair, also called master-slave fail-over. While the primary is down, reads continue from the replicas and the cache with the last published run, which is exactly what the availability requirement asks for. See [Fail-over: active-passive](/learn/availability#fail-over-active-passive).

**Object store for history.** The Sales API keeps writing logs to the object store, which handles 40 GB a month without any planning on our part. The ranking job only needs the last week. Older data can move to a cheaper storage class after a few weeks, and the serving database never holds raw history at all.

**Analytics database.** Analysts will want to ask questions the ranking job doesn't answer: sales by region, by seller, by hour of the day. Running those against the serving database would compete with the read path. Instead, load the logs into an **analytics database**, also called a **data warehouse**: a database built for scanning and aggregating large tables, usually by storing each column separately. Amazon Redshift, which AWS describes as "a fully managed, petabyte-scale data warehouse service", and Google BigQuery are examples. See [Data warehouses](/learn/batch-processing#data-warehouses-snowflake-google-bigquery-amazon-redshift).

The warehouse can also run the ranking itself. Pass 1 and pass 2 together are a `GROUP BY category_id, product_id` followed by a window function such as `ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY total DESC, product_id)`. At 10 GB per run, a warehouse handles that easily, and a SQL query is easier for the next engineer to maintain than a MapReduce job. Keep MapReduce or Spark for when the logic outgrows SQL. Keep only a limited period in the warehouse, say the last few months, and leave the rest in the object store, where a query engine can still read it.

### Consistency and availability

- **What readers see.** Readers can see a ranking up to about an hour old, plus the CDN's few minutes. That's **eventual consistency**: the system converges on the new answer without promising when. For a best-seller list, that's fine, and it's what lets every layer cache. See [The consistency spectrum](/learn/cap-and-consistency#the-consistency-spectrum).
- **When the job fails.** Because publishing is a single switch of `run_id`, a failed or half-finished run is never published. The previous run stays live and the cache keeps serving it. Alert if the live run gets older than two hours or so; users won't notice an hour's delay, but an engineer should.
- **Late or missing logs.** If a Sales API host ships its files late, the run that should have counted them doesn't. A full recompute picks them up next hour; an incremental one needs the daily rebuild.
- **Redundancy.** Run several copies of every stateless server, keep a standby for the primary, spread replicas and cache nodes across availability zones, and rely on the object store's own replication. See [Redundancy across failure domains](/learn/availability#redundancy-across-failure-domains).

### SQL scaling patterns, if the database grows

The ranking table is small, so these aren't needed at the stated numbers. They matter if the scope grows, for example to millions of fine-grained categories, per-region rankings, or raw transactions stored in SQL.

- **Federation:** split databases by function, so the sales rank tables live apart from catalog and order tables and don't compete with them. See [Federation](/learn/relational-databases#federation-one-database-per-feature).
- **Sharding:** split `sales_rank` across databases by `category_id`. Every query names one category, so each read touches exactly one shard. See [Sharding](/learn/relational-databases#sharding-splitting-one-table-across-databases).
- **Denormalization:** store the product name, image URL and price in the ranking rows, so the read path needs no lookup in the catalog. The cost is keeping those copies in sync. See [Denormalization](/learn/relational-databases#denormalization).
- **SQL tuning:** benchmark, find slow queries, and make sure the main query is served from the `by_category` index alone. See [SQL tuning](/learn/relational-databases#sql-tuning).

**Moving to NoSQL.** The read path needs exactly one operation: "give me the list for this key". A key-value store such as DynamoDB or Redis, holding each category's top list as one value, fits that well. See the trade-offs below and [SQL or NoSQL: making the choice](/learn/nosql-databases#sql-or-nosql-making-the-choice).

## Trade-offs and follow-up questions

**Hourly batch recompute or streaming top-K?** A **streaming** design processes each sale as it arrives: a stream processor reads sales from a log such as Kafka, keeps a running count per (category, product) for the sliding window, and updates a sorted set per category, much like the [leaderboard design](/learn/design-gaming-leaderboard#skip-lists-and-redis-sorted-sets). Rankings would then be seconds old instead of an hour. The costs are real: the processor must hold a week of windowed state, handle late and duplicate events, and recover that state after a crash. See [Delivery semantics](/learn/event-streaming#delivery-semantics). With an hourly freshness requirement, I'd pick the batch job: it's simpler, cheaper, and correct by construction because each run starts from the log. If the business later wants minute-level freshness for the top few products in each category, add a small streaming job for just those and keep the batch job as the source of truth. That's the [Lambda architecture](/learn/batch-processing#the-lambda-architecture) in miniature, with the cost of maintaining the counting logic twice.

**Full recompute or incremental window?** Full recompute reads about 10 GB an hour and fixes its own mistakes. Incremental reads about 58 MB an hour but carries errors forward. At a one-week window I'd start with full recompute; with a longer window or much more traffic, switch to incremental with a daily rebuild.

**MapReduce, Spark or the warehouse?** MapReduce writes every intermediate result to disk between passes. Spark keeps them in memory and expresses both passes in one job. A warehouse expresses both in one SQL query. At 10 GB a run, I'd pick the warehouse or Spark; the two-pass MapReduce is the clearest way to explain the logic, which is why it's worth knowing for the interview.

**SQL table or key-value lists?** A SQL table supports several query shapes (by category, by product, ad hoc checks) and transactional publishing. A key-value store with one value per category gives a single fast read per request and scales out easily, but answering "what's the rank of product X" needs a second structure keyed by product. Since the cache already holds the per-category lists, I'd keep SQL as the durable store and treat the cache as the key-value layer.

**Top N only, or every product?** Storing the top 100 per category keeps the table at about 10 MB. Storing every product (up to 20 million rows) costs about 2 GB and a second index, and lets each product page show its rank, as Amazon's help page says its product pages do. That's cheap, so I'd store everything if product pages need it.

**How fresh do popular products need to be?** The assumptions say popular products might need updating more often. One option is to rerun pass 2 every 10 minutes for the busiest categories, using the hourly counts plus a quick count of the current partial hour. The other is the streaming add-on above. Ask first what "more often" is for: catching a viral product needs minutes, while reporting is fine with an hour.

## Check yourself

<details>
<summary>The product team wants the window extended from 7 days to 30 days. What happens to the hourly job, and what would you change?</summary>

Each full recompute grows from about 233 million transactions (about 10 GB) to the whole month's 1 billion (about 42 GB), read every hour. That still fits a modest cluster, but nearly all of the work repeats the previous hour's.

This is the point to switch to the incremental window: compute pass 1 once per hour, keep the 720 hourly count files, and slide a running total forward by adding the newest hour and subtracting the expired one. Each run then reads about 58 MB of new data plus the running total. Rebuild the running total from the hourly files once a day so errors can't accumulate.

</details>

<details>
<summary>A seller complains that their product ranks #1 in "Phone Cases" even though most buyers returned it. Why did this happen, and how would you fix it?</summary>

The job counts units from the sales log, and returns don't appear in that log, so every unit sold counts whether it was kept or not.

Log returns as events with a negative quantity and let pass 1 sum them like any other line. Counting a return in the hour it happened is simplest, but it can then land in a window that doesn't contain its sale, so clamp each total at zero. Ranking by distinct buyers who kept the product is another option worth raising with the product team.

</details>

<details>
<summary>Every hour, a few seconds after the new ranking is published, the read replicas' CPU spikes and some requests time out. What's going on?</summary>

It's a cache stampede. The cached lists probably all expire, or are all deleted, when the new run is published, so for a moment every request misses and thousands of identical queries hit the replicas at once.

Have the Sales Rank Service write the new lists into the cache as part of publishing, so the cache already holds the new answer before readers switch. Keep TTLs as a safety net, with random jitter so keys don't expire together. Request coalescing, where only one request per key goes to the database on a miss while the others wait for it, also helps.

</details>

<details>
<summary>Product pages should show "#N in Category" for every product, not just the top 100. What changes in the job, the table and the read path?</summary>

The job's pass 2 must keep every product instead of stopping at N, so the per-mapper pruning goes away and the shuffle moves all of the (category, product) totals: up to 20 million rows. That's still small.

The table grows to up to 20 million rows per run, about 2 GB, and the `by_product` index becomes essential, because the product page asks "what are product X's ranks?" The read path gets a second endpoint, such as `GET /api/v1/products/50/ranks`. Its traffic is spread over 10 million products, so the cache hit rate is lower than for category lists. Cache the popular products, and let the read replicas handle the long tail.

</details>

<details>
<summary>In pass 2, why is it safe for each map task to keep only its local top 100 per category, while the same trick in pass 1 would give wrong answers?</summary>

After pass 1, each (category, product) pair appears exactly once, with its full total for the week. If a product isn't in the top 100 among the entries one map task holds, then at least 100 products in that same category have higher totals. So it can't be in the overall top 100 either, and dropping it changes nothing.

In pass 1, a product's units are still spread across many map tasks, one partial count per log file. A product with modest sales in every file might look unimportant in each task yet have the largest total once all its partial counts are added. Pruning there would drop real best sellers.

</details>

<details>
<summary>Estimate how much memory the cache needs to hold the first page of every category, and whether a single cache server is enough.</summary>

There are 1,000 categories, and the first page is about 2 KB, so 1,000 × 2 KB = 2 MB. Even ten pages per category is only 20 MB. Memory isn't the constraint; one server could hold this thousands of times over.

The constraints are request rate and availability. Whatever the CDN doesn't absorb of the 120,000 requests a second at peak goes to the cache. Run two or three cache nodes, each holding the full set, so losing one doesn't send a burst of misses to the database. With data this small, replicate it to every node instead of splitting it.

</details>

## Further reading

- [Amazon Best Sellers Rank (Amazon customer service)](https://www.amazon.com/gp/help/customer/display.html?nodeId=GGGMZK378RQPATDJ): Amazon's own short description of what its Best Sellers Rank reflects and why category lists exist. The [UK version](https://www.amazon.co.uk/gp/help/customer/display.html?nodeId=GGGMZK378RQPATDJ) of the page says it's updated hourly.
- [MapReduce: Simplified Data Processing on Large Clusters](https://research.google/pubs/mapreduce-simplified-data-processing-on-large-clusters/): Jeffrey Dean and Sanjay Ghemawat's 2004 OSDI paper, the original description of the map, shuffle and reduce model the ranking job uses.
- [Apache Flink: Windows](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/operators/windows/): a clear explanation of tumbling and sliding windows, useful if you build the streaming version.
- [What is Amazon Redshift?](https://docs.aws.amazon.com/redshift/latest/mgmt/welcome.html): AWS's overview of its data warehouse, an example of the analytics database in step 4.
- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832): Jonas Bonér's widely shared table, the source of the memory, SSD and disk read times quoted above.
