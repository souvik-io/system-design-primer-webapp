# Numbers to know

Suppose an interviewer asks: "How long does it take to read 1 GB from an SSD?" You don't need a benchmark to answer. If you remember that reading 1 MB in sequence from an SSD takes about 1 ms, then 1 GB, which is 1,000 MB, takes about 1,000 ms, or one second. The same read from a spinning hard disk takes about 20 seconds, and from main memory about a quarter of a second. Those three answers already tell you a lot about where a design should keep its hot data.

Estimates like this come up all the time in design work. You might need to know how long it takes to generate 100 image thumbnails from disk, how much memory a data structure will take, or whether a link is fast enough to copy a backup overnight. Each of these needs only a few numbers that you know by heart, plus some careful arithmetic. This chapter collects those numbers in one place: powers of two, the classic latency table, throughput figures, and a few numbers for AI systems. The method for using them, step by step, is in [Back-of-the-envelope estimation](/learn/estimation).

A word on age. The famous latency table dates from around 2009 to 2012. Some of its rows have hardly moved since then, and others have improved more than tenfold. This chapter keeps the classic table as it was, because people still quote it, and then shows a modern ballpark next to it, with a source and a year for each number.

## Powers of two

Computers count in binary, so sizes and limits tend to land on powers of two. A few of them are worth knowing on sight.

| Power | Exact value | Approximate value | Bytes |
|---|---|---|---|
| 2^7 | 128 | | |
| 2^8 | 256 | | |
| 2^10 | 1,024 | 1 thousand | 1 KB |
| 2^16 | 65,536 | | 64 KB |
| 2^20 | 1,048,576 | 1 million | 1 MB |
| 2^30 | 1,073,741,824 | 1 billion | 1 GB |
| 2^32 | 4,294,967,296 | | 4 GB |
| 2^40 | 1,099,511,627,776 | 1 trillion | 1 TB |
| 2^50 | 1,125,899,906,842,624 | 1 quadrillion | 1 PB |

Read the table like this. Each step of 10 in the power multiplies the value by 1,024, which is close to 1,000. So 2^10 is about a thousand, 2^20 about a million, 2^30 about a billion and 2^40 about a trillion.

Two rows are worth remembering for their own sake:

- **2^8 = 256** is the number of different values one byte can hold (0 to 255).
- **2^32 ≈ 4.3 billion** is the number of different values a 32-bit unsigned integer can hold. If you plan to give every user, photo or event an ID, and you expect more than about 4 billion of them, a 32-bit ID will run out. A 64-bit ID holds about 1.8 × 10^19 values, which is enough for almost anything.

### Decimal and binary units

The "Bytes" column above uses the same names for two different things. In everyday use, a **kilobyte (KB)** can mean either 1,000 bytes or 1,024 bytes, and a gigabyte can mean either 10^9 bytes or 2^30 bytes.

To remove the confusion, the International Electrotechnical Commission (IEC) approved separate names for the binary sizes in December 1998, according to [NIST's page on binary prefixes](https://physics.nist.gov/cuu/Units/binary.html):

| Decimal (SI) unit | Size | Binary (IEC) unit | Size |
|---|---|---|---|
| kilobyte, kB | 10^3 = 1,000 bytes | kibibyte, KiB | 2^10 = 1,024 bytes |
| megabyte, MB | 10^6 = 1,000,000 bytes | mebibyte, MiB | 2^20 = 1,048,576 bytes |
| gigabyte, GB | 10^9 bytes | gibibyte, GiB | 2^30 = 1,073,741,824 bytes |
| terabyte, TB | 10^12 bytes | tebibyte, TiB | 2^40 bytes |

The gap between the two grows with size. A KiB is 2.4% bigger than a kB. A MiB is 4.9% bigger than an MB, a GiB 7.4% bigger than a GB, a TiB 10% bigger than a TB, and a PiB about 12.6% bigger than a PB.

When does it matter?

- **In estimates, it almost never matters.** Your assumptions about users and object sizes are rarely within 10% of the truth. Use powers of ten, because the arithmetic is easier.
- **It matters when you compare quoted figures.** Disk makers and network vendors use decimal units. Operating systems and memory sizes often use binary ones. For example, a hard-disk datasheet from Seagate lists one drive's top transfer rate as "285 MB/s / 272 MiB/s": the same speed in both units. A "1 TB" disk shows up as about 931 GiB in an operating system that counts in binary, and nothing is missing.
- **It matters when you set hard limits.** If a field, a buffer or a quota must hold exactly 64 KiB, write 65,536 bytes in the code. 64,000 bytes is about 2% short.

### Quick conversions

These are the conversions people use most in estimates. The "shortcut" column is the rounded number you do arithmetic with.

| Quantity | Exact or close | Shortcut |
|---|---|---|
| Seconds in a day | 86,400 | about 10^5 |
| Seconds in a 30-day month | 2,592,000 | about 2.6 million, or 2.5 × 10^6 |
| Seconds in a year | 31,536,000 | about 3 × 10^7 |
| 1 million requests a day | 11.6 a second | about 12 a second |
| 1 billion requests a day | 11,574 a second | about 10^4 a second |
| 1 Gbps (gigabit per second) | 125 MB/s | about 100 MB/s after protocol overhead |
| Bits to bytes | divide by 8 | |

Two quick checks show how the shortcuts work. If a service gets 100 million requests a day, divide by 10^5 to get about 1,000 requests a second on average. If a server writes 1 KB per request at 1,000 requests a second, that is 1 MB a second, or about 86 GB a day.

## Latency numbers every programmer should know

**Latency** is how long one operation takes from start to finish. The table below lists the latency of common operations, from reading a CPU cache to sending a packet across an ocean. The list was first compiled by Peter Norvig, in the answers section of his essay [Teach Yourself Programming in Ten Years](https://norvig.com/21-days.html#answers). Jeff Dean of Google then updated it and showed it in his talks, under the title "Numbers Everyone Should Know". Jonas Bonér's [gist of the table](https://gist.github.com/jboner/2841832), labelled "~2012", is the version most people copy.

Units: 1 ns (nanosecond) = 10^-9 seconds. 1 µs (microsecond) = 10^-6 seconds = 1,000 ns. 1 ms (millisecond) = 10^-3 seconds = 1,000 µs = 1,000,000 ns.

| Operation | ns | µs | ms | Notes |
|---|---:|---:|---:|---|
| L1 cache reference | 0.5 | | | |
| Branch mispredict | 5 | | | |
| L2 cache reference | 7 | | | 14 × L1 cache |
| Mutex lock/unlock | 25 | | | |
| Main memory reference | 100 | | | 14 × L2 cache, 200 × L1 cache |
| Compress 1 KB with Zippy | 3,000 | 3 | | |
| Send 1 KB over a 1 Gbps network | 10,000 | 10 | | |
| Read 4 KB randomly from SSD | 150,000 | 150 | | assumes an SSD that reads about 1 GB/s |
| Read 1 MB sequentially from memory | 250,000 | 250 | | |
| Round trip within the same data center | 500,000 | 500 | 0.5 | |
| Read 1 MB sequentially from SSD | 1,000,000 | 1,000 | 1 | about 1 GB/s SSD; 4 × memory |
| HDD seek | 10,000,000 | 10,000 | 10 | 20 × data center round trip |
| Read 1 MB sequentially over a 1 Gbps network | 10,000,000 | 10,000 | 10 | 40 × memory, 10 × SSD |
| Read 1 MB sequentially from HDD | 20,000,000 | 20,000 | 20 | 80 × memory, 20 × SSD |
| Send a packet California → Netherlands → California | 150,000,000 | 150,000 | 150 | |

A few terms, in case they are new:

- An **L1 cache** and an **L2 cache** are small, fast memories inside the CPU. L1 is the smallest and fastest. Main memory (RAM) sits outside the CPU and is much slower to reach.
- A **branch mispredict** happens when the CPU guesses which way an `if` will go, starts work on that path, and has to throw the work away because it guessed wrong.
- A **mutex** is a lock that lets only one thread at a time into a section of code.
- **Zippy** was Google's internal name for a fast compression library, released as open source in 2011 under the name Snappy.
- An **HDD seek** is the time a hard disk takes to move its read head to the right track.
- **Sequential** means reading bytes that sit next to each other. **Random** means jumping to a new place for each read.

Different versions of the table disagree on a few rows. The version above follows Jeff Dean's slide from his October 2009 LADIS keynote, [Designs, Lessons and Advice from Building Large Distributed Systems](https://www.cs.cornell.edu/projects/ladis2009/talks/dean-keynote-ladis2009.pdf), and the jboner gist. An older slide from Dean's Stanford talk, [Software Engineering Advice from Building Large-Scale Distributed Systems](https://static.googleusercontent.com/media/research.google.com/en//people/jeff/stanford-295-talk.pdf), gave slower numbers: 100 ns for a mutex, 10 µs to compress 1 KB with Zippy, and 30 ms to read 1 MB from disk. The row for reading 1 MB over a 1 Gbps network comes from that older slide. It checks out: 1 MB is 8 million bits, which takes 8 ms at 1 Gbps, so "about 10 ms" is fair.

The table was also drawn as a [picture of grids of squares](https://i.imgur.com/k0t1e.png), one square per unit of time, which makes the jumps between rows easy to see. Colin Scott's [interactive version](https://colin-scott.github.io/personal_website/research/interactive_latency.html) adds a year slider, covered in [How these numbers have changed](#how-these-numbers-have-changed) below.

### What the table tells you

The exact values matter less than the gaps between them. Here is what the gaps say, in plain sentences.

- **Memory is far faster than any disk.** A main memory reference takes 100 ns. A random 4 KB read from an SSD takes 150 µs, which is 1,500 times longer. This is the whole case for caching: keep hot data in memory.
- **Sequential reads beat random reads.** A hard disk spends 10 ms just finding the data, and then reads a whole megabyte in 20 ms. If you read 1 MB as 256 separate 4 KB pieces scattered over the disk, you pay 256 seeks, which is about 2.5 seconds. Databases and logs are built around this: they append to the end of a file and read in large blocks.
- **The network inside a data center is faster than a local hard disk.** A round trip to another machine in the same building takes 0.5 ms. One disk seek takes 10 ms. So asking another server's memory, for example a cache like memcached or Redis, is quicker than reading your own disk.
- **Long-distance round trips are expensive.** California to the Netherlands and back takes 150 ms, which is 300 round trips inside a data center. A page that needs four round trips to a faraway server spends 600 ms waiting before any other work. That is why [CDNs](/learn/dns-and-cdn) put content near users, and why APIs used over long distances should avoid many small back-and-forth calls.
- **Compression is cheap compared with sending data.** Compressing 1 KB takes 3 µs, and sending 1 KB over a 1 Gbps link takes 10 µs. If compression halves the size, it often pays for itself.
- **CPU-level costs are tiny next to I/O.** A branch mispredict or a cache miss matters inside tight loops. In a request that does one disk read or one network call, they disappear.

### A human-scale version

Nanoseconds are hard to picture. One way to feel the gaps is to stretch time so that an L1 cache reference takes one second. That multiplies every number by 2 billion.

| Operation | Real time | If an L1 cache reference took 1 second |
|---|---|---|
| L1 cache reference | 0.5 ns | 1 second |
| Branch mispredict | 5 ns | 10 seconds |
| L2 cache reference | 7 ns | 14 seconds |
| Mutex lock/unlock | 25 ns | 50 seconds |
| Main memory reference | 100 ns | 3.3 minutes |
| Compress 1 KB with Zippy | 3 µs | 1.7 hours |
| Send 1 KB over a 1 Gbps network | 10 µs | 5.6 hours |
| Read 4 KB randomly from SSD | 150 µs | 3.5 days |
| Read 1 MB sequentially from memory | 250 µs | 5.8 days |
| Round trip within the same data center | 500 µs | 11.6 days |
| Read 1 MB sequentially from SSD | 1 ms | 23 days |
| HDD seek | 10 ms | 7.6 months |
| Read 1 MB sequentially over a 1 Gbps network | 10 ms | 7.6 months |
| Read 1 MB sequentially from HDD | 20 ms | 15 months |
| California → Netherlands → California | 150 ms | 9.5 years |

On this scale, fetching something from memory is a short coffee break. A round trip inside the data center is a two-week holiday. A round trip across the Atlantic takes most of a decade.

### Handy metrics derived from the table

Each rate below comes from one row of the table. Divide the size by the time.

- **Hard disk, sequential:** 1 MB in 20 ms, so about **50 MB/s**. (The older Stanford slide's 30 ms per MB gives 30 MB/s, which is the figure Dean used in his own worked examples.)
- **1 Gbps Ethernet, sequential:** 1 MB in 10 ms, so about **100 MB/s**. The exact line rate is 125 MB/s; some of it goes to protocol overhead.
- **SSD, sequential:** 1 MB in 1 ms, so about **1 GB/s**.
- **Main memory, sequential:** 1 MB in 250 µs, so about **4 GB/s**.
- **Round trips across the world:** 1 second ÷ 150 ms ≈ **6 to 7 round trips a second**, one after another.
- **Round trips within a data center:** 1 second ÷ 0.5 ms = **2,000 round trips a second**, one after another.

The last two describe one caller waiting for each reply before sending the next request. A server talking to many callers at once can do far more round trips in total.

### How these numbers have changed

Hardware has moved on since the table was written, but unevenly. Colin Scott's [interactive latency page](https://colin-scott.github.io/personal_website/research/interactive_latency.html) shows this by letting you pick a year. It starts from Norvig's numbers and applies a trend to each row ([source code on GitHub](https://github.com/colin-scott/interactive_latencies)). In its model, CPU clock speed stops rising in 2005, main memory latency stays at 100 ns from 2000 on, the data-center round trip stays at 500 µs, and the California–Netherlands round trip stays at 150 ms because it is limited by the speed of light. Storage and network bandwidth keep growing. Treat the page as a model of trends. Its numbers are extrapolations from older data.

For a few rows that have moved the most, here is a modern ballpark from current vendor specifications and published measurements. The classic table above stays as it is; use these when you want a number closer to today's hardware.

| Row | Classic table | A modern ballpark | Source and year |
|---|---|---|---|
| Read 4 KB randomly from SSD | 150 µs | about 60 µs typical read latency for a data-center NVMe SSD | Solidigm D7-PS1010 spec table, in [StorageReview's review](https://www.storagereview.com/review/solidigm-ps1010-ssd-review), 2024 |
| Read 1 MB sequentially from SSD | 1 ms (about 1 GB/s) | about 70 µs, at up to 14,500 MB/s | [Solidigm D7-PS1010 product page](https://www.solidigm.com/products/data-center/d7/ps1010.html), a PCIe 5.0 drive from 2024 |
| Round trip within the same data center | 500 µs | about 50 to 150 µs between two VMs in one cloud zone (netperf mean 67 µs; ping average 146 µs) | Google Cloud blog, [What a trip! Measuring network latency in the cloud](https://cloud.google.com/blog/products/networking/using-netperf-and-ping-to-measure-network-latency), 2020 |
| Read 1 MB sequentially from memory | 250 µs (about 4 GB/s) | a 5th Gen AMD EPYC server CPU has a peak memory bandwidth of 614 GB/s per socket, shared by all its cores | [AMD EPYC 9575F spec page](https://www.amd.com/en/products/processors/server/epyc/9005-series/amd-epyc-9575f.html) |
| HDD seek, and 1 MB from HDD | 10 ms and 20 ms | average rotational latency 4.16 ms; up to 285 MB/s sustained, so 1 MB in about 3.5 ms; about 170 random 4 KB reads a second | Seagate Exos data sheet (ds2046.1), current in 2026 |
| Main memory reference | 100 ns | still about 100 ns | Colin Scott's model holds it flat |
| California → Netherlands → California | 150 ms | still about 150 ms | limited by distance |

Some notes on reading this table:

- **SSDs improved the most.** Random reads are about 2 to 3 times faster, and sequential reads about 14 times faster. The 14,500 MB/s figure is a peak for large sequential reads. A data-center SSD also handles millions of small reads a second when many run in parallel; the D7-PS1010 page lists up to 3.3 million random 4 KB reads a second.
- **Spinning disks got faster at streaming, but not at seeking.** The Seagate figure of 285 MB/s is for the outer edge of the platter, where a disk is fastest. Its 4.16 ms is the average wait for the platter to spin to the right place (half a turn at 7,200 RPM), before counting the head's move. About 170 random reads a second means each one still costs several milliseconds. A disk is still a poor place for random lookups.
- **Data-center networks got several times faster.** The Google measurement is between two virtual machines in one zone, using the internal network. Your numbers depend on the cloud, the instance type and the load.
- **Memory latency barely moved, but bandwidth grew a lot.** The 614 GB/s figure is a peak for the whole socket, with all 12 memory channels in use. One thread reading on its own gets only part of it.
- **The speed of light did not change.** Cross-continent latency is the same as in 2012, which makes it relatively more expensive than everything else that got faster.

## Throughput numbers

**Throughput** is how much work a system finishes per unit of time: bytes per second for a disk, requests per second for a server. The latency table hides throughput inside its rows. This section pulls it out.

### Sequential read and transfer rates

| Medium | Rough rate | Time to move 1 GB | Where the number comes from |
|---|---|---|---|
| Main memory | 4 GB/s in the classic table; up to 614 GB/s peak for a whole modern server socket | 0.25 s classic | Classic table; AMD EPYC spec page |
| NVMe SSD | 1 GB/s classic; up to 14.5 GB/s for a 2024 PCIe 5.0 data-center drive | 1 s classic; about 0.07 s modern | Classic table; Solidigm D7-PS1010 |
| Hard disk | 50 MB/s classic; up to 285 MB/s for a current large drive | 20 s classic; about 3.5 s modern | Classic table; Seagate Exos data sheet |
| 1 Gbps network | 125 MB/s line rate; plan on about 100 MB/s | about 10 s | arithmetic: 1 Gbps ÷ 8 bits per byte |
| 10 Gbps network | 1.25 GB/s | about 1 s | arithmetic |
| 100 Gbps network | 12.5 GB/s | about 0.1 s | arithmetic |

A rule of thumb follows from this table. A fast modern SSD reads data about as fast as a 100 Gbps network can carry it, and a hard disk reads about as fast as a 2 Gbps link. So in a data pipeline, the network card often runs out of capacity before the drive does.

### Requests per second for one machine

How many requests one machine can handle depends heavily on what each request does. The numbers below are rough orders of magnitude for sizing. Real systems often do much less, so measure your own before you commit to a design.

| Server type | Rough throughput | Basis |
|---|---|---|
| In-memory cache node (Redis) | about 70,000 to 180,000 simple commands a second without pipelining; over 1.5 million with 16 commands per pipeline | Examples in the [Redis benchmark docs](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/). Redis runs commands on mostly one thread, so one instance uses about one core. |
| Relational database node, simple reads | about 530,000 to 840,000 primary-key lookups a second in a synthetic test | PostgreSQL's `pgbench -S` (select-only) on a 16-core, 32-thread desktop CPU, with the client on the same machine and all data in memory, [reported on the pgsql-hackers list](https://www.postgresql.org/message-id/CAAKRu_b1hteaenKZ19%3DhUc1vOtixdjT0TfUTnPci22oxoU1MTQ%40mail.gmail.com) in 2023 |
| Relational database node, real workload | **assumption:** about 1,000 to 10,000s of queries a second | Real queries join tables, write to disk and wait on the network and on locks. This range is a planning assumption. |
| Web or app server, dynamic pages | **assumption:** hundreds to a few thousand requests a second | See the derivation below. |

The app server row is easiest to reason about from first principles. If each request needs about 10 ms of CPU time and the server has 16 cores, the most it can do is 16 × (1,000 ms ÷ 10 ms) = 1,600 requests a second. In practice you plan to run well below that peak, because waiting times rise sharply as a server gets close to fully busy (see [Performance and latency](/learn/performance-and-latency#queueing-why-busy-servers-get-slow-suddenly)). A server that mostly waits on other services, rather than computing, can hold many more requests at once, and then memory or connection limits set the ceiling instead.

The gap between the synthetic database result and a real workload is the main lesson of this table. Benchmarks measure the best case. A design should assume much less, and check against measurements once the system exists.

## Numbers for AI systems

AI models add a new kind of estimate: will the model fit in memory, and how fast can it run? The basic numbers come from the GPU's specification and from the model's size.

**Memory and bandwidth of one data-center GPU.** NVIDIA's spec pages list:

| GPU | Memory (HBM) | Memory bandwidth | Source |
|---|---|---|---|
| H100 SXM | 80 GB | 3.35 TB/s | [NVIDIA H100](https://www.nvidia.com/en-us/data-center/h100/) |
| H100 NVL | 94 GB | 3.9 TB/s | same page |
| H200 SXM | 141 GB | 4.8 TB/s | [NVIDIA H200](https://www.nvidia.com/en-us/data-center/h200/) |

HBM (high-bandwidth memory) is the memory stacked next to the GPU chip. Its bandwidth is several times higher than a whole server CPU socket's memory bandwidth (614 GB/s above).

**How big a model's weights are.** A model's weights take up roughly:

```
weight size = number of parameters × bytes per parameter
```

The bytes per parameter depend on the number format. FP16 and BF16 (16-bit floating point) use 2 bytes. 8-bit formats use 1 byte. 4-bit formats use half a byte. So:

- A 70-billion-parameter model in FP16 takes 70 × 10^9 × 2 bytes = 140 GB.
- The same model in an 8-bit format takes about 70 GB, and in a 4-bit format about 35 GB.

This is only the weights. Running a model also needs memory for intermediate results, mainly the cache of each conversation's past tokens. So a 140 GB model does not fit on one 80 GB H100, and it only just fits within one H200's 141 GB with almost no room left over. In practice, it would run on two or more GPUs.

**A rough speed limit.** When a model generates text one token at a time for a single user, each new token needs the GPU to read all the weights from memory once. Reading 140 GB at 4.8 TB/s takes about 29 ms. So one H200 can produce at most about 34 tokens a second for that single conversation, however fast its arithmetic units are. Serving many users at once in the same pass over the weights is how real systems get much higher total throughput.

The gist that popularized the latency table added rows for language models in 2026. They are rough, but useful for scale: a hosted frontier model produces a token about every 20 ms, takes about 1 second before its first token on a short prompt, about 10 seconds to read a 100,000-token prompt with no cache, and about 30 seconds for a single reasoning response.

The [AI systems](/learn/llm-inference) part of the handbook covers model inference in depth. [Estimating AI workloads](/learn/ai-estimation) works through these numbers step by step, including the memory each conversation's cache takes and how many GPUs a product needs.

## Check yourself

<details>
<summary>How long does it take to read a 1 GB file from memory, from an SSD, from a hard disk, and over a 1 Gbps network, using the classic table?</summary>

Work from the 1 MB rows and multiply by 1,000.

- Memory: 1,000 × 250 µs = 0.25 seconds.
- SSD: 1,000 × 1 ms = 1 second.
- Hard disk: 1,000 × 20 ms = 20 seconds.
- 1 Gbps network: 1,000 × 10 ms = 10 seconds (8 seconds at the exact line rate).

With a 2024 PCIe 5.0 SSD at 14.5 GB/s, the SSD read drops to about 0.07 seconds, faster than the classic table's memory figure.

</details>

<details>
<summary>A page shows 100 thumbnails of 256 KB each, stored on hard disks. Estimate the time if you read them one after another, and if you read them all in parallel from many disks.</summary>

Each read needs one seek (10 ms) plus 0.256 MB at 20 ms per MB (about 5 ms). That is about 15 ms per thumbnail.

- One after another: 100 × 15 ms = 1.5 seconds.
- In parallel, with each image on a different disk: about 15 ms, plus some extra for the slowest disk.

If the thumbnails sit in a memory cache instead, reading all 25.6 MB takes about 25.6 × 250 µs ≈ 6.4 ms. Jeff Dean's 2009 slides used the same kind of estimate for a page of 30 thumbnails: about 560 ms read one at a time, about 18 ms read in parallel.

</details>

<details>
<summary>Your service will hand out IDs to about 6 billion objects. Is a 32-bit integer enough?</summary>

No. 2^32 = 4,294,967,296, about 4.3 billion, which is fewer than 6 billion. A signed 32-bit integer only reaches about 2.1 billion. Use a 64-bit ID, which holds about 1.8 × 10^19 values. See [Unique IDs](/learn/unique-ids) for ways to generate them.

</details>

<details>
<summary>You need to copy a 10 TB backup between two data centers. How long does it take over a 1 Gbps link, and over a 10 Gbps link?</summary>

10 TB = 10 × 10^12 bytes × 8 = 8 × 10^13 bits.

- At 1 Gbps: 8 × 10^13 ÷ 10^9 = 80,000 seconds, about 22 hours.
- At 10 Gbps: 8,000 seconds, about 2.2 hours.

Both assume the link runs at full speed the whole time, which real transfers rarely do. Add some margin.

</details>

<details>
<summary>A user in Europe loads a page from a server in California. The page needs 4 sequential round trips before it can show anything. What is the minimum wait, and what would you change?</summary>

Each round trip takes about 150 ms, so 4 × 150 ms = 600 ms before any server work. Faster servers can't fix this, because the time goes on distance. Serve the content from a location near the user with a [CDN](/learn/dns-and-cdn) or a nearby data center, and cut the number of round trips, for example by reusing connections and combining requests.

</details>

<details>
<summary>Can a 70-billion-parameter model in FP16 run on a single 80 GB H100? What about in an 8-bit format?</summary>

In FP16 the weights alone take 70 × 10^9 × 2 bytes = 140 GB, which is far more than 80 GB, so it needs at least two GPUs. In an 8-bit format the weights take about 70 GB. That fits, but it leaves only about 10 GB for the per-conversation cache and other working memory, which limits how many users it can serve at once.

</details>

## Further reading

The classic sources for the latency table:

- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832): Jonas Bonér's gist, the version most people copy, with credits and later additions.
- ["Humanized" latency numbers](https://gist.github.com/hellerbarde/2843375): a second gist with a human-scale version of the table.
- [Visual chart of the latency numbers](https://i.imgur.com/k0t1e.png): the table drawn as grids of squares.
- [Teach Yourself Programming in Ten Years](https://norvig.com/21-days.html#answers): Peter Norvig's essay; the timing table is in its answers section.
- [Designs, Lessons and Advice from Building Large Distributed Systems](https://www.cs.cornell.edu/projects/ladis2009/talks/dean-keynote-ladis2009.pdf): Jeff Dean's LADIS 2009 keynote. "Numbers Everyone Should Know" and the thumbnail estimate are on slides 24 to 27.
- [Software Engineering Advice from Building Large-Scale Distributed Systems](https://static.googleusercontent.com/media/research.google.com/en//people/jeff/stanford-295-talk.pdf): Jeff Dean's earlier Stanford talk, with the older version of the table.
- [Latency Numbers Every Programmer Should Know (interactive)](https://colin-scott.github.io/personal_website/research/interactive_latency.html): Colin Scott's page with a year slider.

Units and modern figures:

- [Power of two](https://en.wikipedia.org/wiki/Power_of_two): Wikipedia's article, with a longer table of powers.
- [Prefixes for binary multiples](https://physics.nist.gov/cuu/Units/binary.html): NIST on KiB, MiB and GiB.
- [What a trip! Measuring network latency in the cloud](https://cloud.google.com/blog/products/networking/using-netperf-and-ping-to-measure-network-latency): how to measure round-trip time between machines, and why the settings change the result.
- [Redis benchmark](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/): how to benchmark a cache node, and the pitfalls that make benchmarks misleading.
- [Back-of-the-envelope estimation](/learn/estimation): the step-by-step method that uses these numbers.
