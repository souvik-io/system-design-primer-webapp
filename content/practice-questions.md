# Practice questions

Reading about system design teaches you the parts. Answering questions out loud teaches you to use them. This chapter is a bank of questions to practise on, with pointers to the chapters that help and to articles that show how real companies solved the same problem.

Here is one way to practise a question, say "Design a chat app like WhatsApp":

1. **Set a timer for 45 minutes.** That's about how long a real interview gives you.
2. **Follow the four steps** from [The system design interview, step by step](/learn/system-design-interview): outline use cases and constraints, sketch a high-level design, design the core components, then scale it.
3. **Say your estimates out loud.** How many messages a day, how many people online at once, how much storage a year. Write the arithmetic down as you go, the way you would on a whiteboard. The [estimation](/learn/estimation) chapter and [numbers to know](/learn/numbers-to-know) help here.
4. **Compare.** When the timer stops, read the worked design if the handbook has one, or the references listed with the question. Note what you missed and what you'd do differently.

The chapter has four parts:

- **Worked designs in this handbook** lists every question the handbook answers in full, with what each one teaches. Start there: you can check your answer against a complete design laid out in the same four steps.
- **More system design questions** groups further questions by theme. For each one you'll find what makes it hard, which chapters help, and references that are still online.
- **More object-oriented design questions** covers class-design questions, where you write the classes and methods for one program instead of drawing a distributed system.
- **How to practise with these** gives a simple plan, a checklist for reviewing your own answers, and tips for practising with a partner.

## Worked designs in this handbook

These chapters each take one question from requirements to a scaled design. The system design chapters follow the same four steps you'll use in an interview, so you can compare your answer with one laid out the same way.

### System design questions

| Question | What it teaches |
| --- | --- |
| [Design a text-sharing service like Pastebin](/learn/design-pastebin) | Keeping small records (code, expiry) apart from the larger text they point to, cleaning up expired data, and serving a read-heavy service. Also asked as "Design Bit.ly", which is closer to the URL shortener below. |
| [Design the Twitter timeline and search](/learn/design-twitter) | Where to do the work for a feed: when a post is written (fan-out on write) or when a timeline is read, and what to do about accounts with millions of followers. Also asked as "Design the Facebook feed and search". |
| [Design a web crawler](/learn/design-web-crawler) | Managing a to-do list of billions of links, skipping duplicate pages, and crawling politely without overloading any one site. |
| [Design a personal finance tracker like Mint](/learn/design-mint) | Pulling data from outside systems in background workers, categorising it, and splitting a write-heavy workload from the reads users see. |
| [Design the data structures for a social network](/learn/design-social-graph) | Finding the shortest path between two people when friend lists are spread across many servers, while keeping the number of network calls small. |
| [Design a key-value cache for a search engine's query results](/learn/design-query-cache) | An in-memory cache with least-recently-used eviction, spread over many machines, with a plan for hot keys and stale results. |
| [Design Amazon's sales rank by category](/learn/design-sales-rank) | Separating a large, slow batch job that computes an answer from a small, fast path that serves it. |
| [Design a system that scales to millions of users on AWS](/learn/design-scaling-aws) | Growing one site from a single server to many, one bottleneck at a time, and knowing when each fix is worth its cost. |
| [Design a URL shortener (like TinyURL or Bitly)](/learn/design-url-shortener) | Generating short codes that never collide, choosing a redirect status code, sharding a table with billions of rows, and counting clicks cheaply. |
| [Design a social media news feed](/learn/design-social-news-feed) | Push versus pull feeds, caching feeds for hundreds of millions of users, paging through a list that keeps changing, and ranking. |
| [Design a real-time gaming leaderboard](/learn/design-gaming-leaderboard) | Answering "what's my rank?" among millions of players quickly, with sorted sets built on skip lists, and breaking ties fairly. |
| [Design a payment system and gateway](/learn/design-payment-system) | Making retries safe with idempotency keys, tracking each payment in a state machine, keeping a double-entry ledger, and reconciling with outside providers. |
| [Design a collaborative document editor](/learn/design-collaborative-document) | Merging edits that two people make at the same moment, with operational transformation or CRDTs, so every screen ends up showing the same text. |
| [Design a web search engine](/learn/design-search-engine) | Building an inverted index, splitting it across machines, and ranking results within a couple of hundred milliseconds. |
| [Design a personalized recommendation system](/learn/design-recommendation-system) | Narrowing a catalog of millions of items to twenty in stages, so the expensive model only scores a few hundred candidates. |
| [Design a distributed key-value store](/learn/design-key-value-store) | Partitioning, replication, quorums, conflict resolution and failure detection, all in one design. |
| [Design a notification system](/learn/design-notification-system) | Queues, retries, deduplication and rate limits across several outside providers, without letting a marketing blast delay a login code. |
| [Design a chat system](/learn/design-chat-system) | Long-lived connections, message ordering, delivery and read receipts, and keeping several devices per user in sync. |
| [Design search autocomplete (typeahead)](/learn/design-autocomplete) | Separating an offline pipeline that builds suggestions from an online lookup that answers in milliseconds, and caching almost everything. |
| [Design a video streaming platform](/learn/design-video-streaming) | Uploading very large files reliably, transcoding in parallel, adaptive bitrate streaming, and why bandwidth cost shapes the design. |
| [Design a file sync service (like Dropbox or Google Drive)](/learn/design-file-sync) | Keeping strongly consistent file metadata apart from file content, splitting files into blocks, and handling conflicts from offline edits. |

### Object-oriented design questions

| Question | What it teaches |
| --- | --- |
| [Design a hash map](/learn/ood-hash-table) | Turning a key into an array index, handling collisions, and growing the table as it fills. |
| [Design an LRU cache](/learn/ood-lru-cache) | Combining a hash map with a linked list so that lookups and evictions both take constant time. |
| [Design a call center](/learn/ood-call-center) | Escalating work through a chain of employees and queuing callers when everyone is busy. |
| [Design a deck of cards](/learn/ood-deck-of-cards) | Modelling a general structure once and letting each game (such as blackjack) give it its own rules through inheritance. |
| [Design a parking lot](/learn/ood-parking-lot) | Matching vehicles of different sizes to spots, including a vehicle that needs several spots side by side. |
| [Design a chat server](/learn/ood-online-chat) | Users, friend requests, private chats and group chats as classes, with rules about who may post where. |

## More system design questions

The handbook doesn't work these questions through in full. Each one lists what makes it hard, the chapters that cover the parts you'll need, and references that show how others have answered it. Most of them overlap with a worked design, so do that one first and then try the variation.

The references were checked when this chapter was written. Some are old. Treat the numbers in them as a snapshot of that time, and read them for the reasoning.

### Storage, caching and file systems

**Design a file sync service like Dropbox.**

- What makes it hard: file metadata must stay consistent across every device, while the file contents are large and need to move with as little bandwidth as possible. Two devices that edit the same file offline will conflict when they reconnect.
- Chapters: [Design a file sync service](/learn/design-file-sync), [NoSQL databases](/learn/nosql-databases), [CAP and consistency](/learn/cap-and-consistency).
- References: [How We've Scaled Dropbox](https://www.youtube.com/watch?v=PE4gwstWhmc), a talk on Dropbox's growth posted on Stanford's YouTube channel.

**Design a key-value store like Redis.**

- What makes it hard: on one machine it is a hash table. Across many machines you have to decide how keys are split, how many copies each key has, and what a read returns while copies disagree.
- Chapters: [Design a distributed key-value store](/learn/design-key-value-store), [Design a hash map](/learn/ood-hash-table), [Consistent hashing](/learn/consistent-hashing), [NoSQL databases](/learn/nosql-databases).
- References: [Implementing a Key-Value Store](https://codecapsule.com/2012/11/07/ikvs-implementing-a-key-value-store-table-of-contents/), Emmanuel Goossaert's article series on building one from scratch (it became the KingDB project). [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf), the 2007 paper behind many distributed key-value stores.

**Design a cache system like Memcached.**

- What makes it hard: memory is limited, so you need an eviction policy. Once the cache spans many servers, adding or removing a server must not move most of the keys, and many clients asking for the same missing key at once must not all hit the database.
- Chapters: [Caching](/learn/cache), [Design an LRU cache](/learn/ood-lru-cache), [Design a key-value cache for a search engine](/learn/design-query-cache), [Consistent hashing](/learn/consistent-hashing).
- References: [Introduction to memcached](https://www.slideshare.net/oemebamo/introduction-to-memcached), Jurriaan Persyn's slides on caching basics, memcached's design and invalidation strategies. [Scaling Memcache at Facebook](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala), a 2013 NSDI paper on running memcached as a very large shared cache.

**Design a garbage collection system.**

- What makes it hard: this question is about the memory of one running program. The collector has to find every object the program can still reach, free the rest, and do it without pausing the program for too long.
- Chapters: [Design a hash map](/learn/ood-hash-table) for practice with low-level data structures, and [Performance and latency](/learn/performance-and-latency) for the cost of long pauses.
- References: [Baby's First Garbage Collector](https://journal.stuffwithstuff.com/2013/12/08/babys-first-garbage-collector/), Bob Nystrom's short walk through a mark-and-sweep collector in C. [Garbage Collection Algorithms](https://web.archive.org/web/20171107023757/https://courses.cs.washington.edu/courses/csep521/07wi/prj/rick.pdf), Rick Byers's 2007 University of Washington survey of collection algorithms. The original link now asks for a university login, so this is an archived copy.

**Design a system that serves data from multiple data centers.**

- What makes it hard: copies of the data are far apart, so every write either waits for the other sites (slow but consistent) or doesn't (fast, but a failure can lose recent writes or leave sites disagreeing).
- Chapters: [Availability](/learn/availability), [CAP and consistency](/learn/cap-and-consistency), [Consensus](/learn/consensus), [Relational databases](/learn/relational-databases) for replication, [DNS and CDN](/learn/dns-and-cdn) for sending users to the nearest site.
- References: [How Google Serves Data from Multiple Datacenters](https://highscalability.com/how-google-serves-data-from-multiple-datacenters/), High Scalability's 2009 summary of Ryan Barrett's Google I/O talk. It compares backups, primary-replica copying, multi-primary writes, two-phase commit and Paxos.

**Design a content delivery network like Cloudflare.**

- What makes it hard: thousands of edge servers must decide what to cache, users must be sent to a nearby healthy server, and the origin must be protected when a page suddenly becomes popular.
- Chapters: [DNS and CDN](/learn/dns-and-cdn), [Caching](/learn/cache), [Load balancing](/learn/load-balancing), [Design a video streaming platform](/learn/design-video-streaming).
- References: [Globally distributed content delivery](https://kilthub.cmu.edu/articles/journal_contribution/Globally_distributed_content_delivery/6605972), a 2002 IEEE Internet Computing paper by Dilley, Maggs and others describing the Akamai network, which launched in early 1999.

### Social, messaging and collaboration

**Design a chat app like WhatsApp.**

- What makes it hard: hundreds of millions of phones each hold an open connection, messages must arrive in order and exactly once from the user's point of view, and a phone that was offline must catch up when it reconnects.
- Chapters: [Design a chat system](/learn/design-chat-system), [Real-time communication](/learn/realtime), [Unique IDs](/learn/unique-ids), [Design a chat server](/learn/ood-online-chat).
- References: [The WhatsApp Architecture Facebook Bought For $19 Billion](https://highscalability.com/the-whatsapp-architecture-facebook-bought-for-19-billion/), High Scalability's 2014 write-up. It describes servers written almost entirely in Erlang on FreeBSD, and cites 50 billion messages a day handled by 32 engineers at the time.

**Design the Facebook chat function.**

- What makes it hard: presence. Telling every friend each time someone comes online, goes idle or leaves costs more than delivering the messages, and the cost grows with the size of friend lists.
- Chapters: [Design a chat system](/learn/design-chat-system), [Real-time communication](/learn/realtime), [Queues and async work](/learn/queues-and-async).
- References: [Facebook Chat](https://engineering.fb.com/2008/05/13/web/facebook-chat/), Eugene Letuchy's 2008 post on why presence was the costly part, and on the long-polling server written in Erlang. [Erlang at Facebook](http://www.erlang-factory.com/upload/presentations/31/EugeneLetuchy-ErlangatFacebook.pdf), his 2009 slides on the chat architecture and its rollout.

**Design a picture sharing system like Instagram.**

- What makes it hard: photos are large and written once, while the metadata around them (likes, comments, follows) is small and changes constantly. Each needs a different store, and every upload has to produce several sizes and reach a CDN.
- Chapters: [Design a social media news feed](/learn/design-social-news-feed), [Design a video streaming platform](/learn/design-video-streaming) for the upload pipeline, [DNS and CDN](/learn/dns-and-cdn), [Relational databases](/learn/relational-databases) for sharding.
- References: [Flickr Architecture](https://highscalability.com/flickr-architecture/), High Scalability's 2007 write-up on sharding users across databases and caching heavily. [Instagram Architecture: 14 Million users, Terabytes of Photos](https://highscalability.com/instagram-architecture-14-million-users-terabytes-of-photos/), the 2011 write-up: photos in Amazon S3 behind CloudFront, metadata in PostgreSQL, feeds in Redis.

**Design the Facebook news feed function.**

- What makes it hard: a person may follow hundreds of sources, and loading the feed must not mean hundreds of database reads. You choose between building feeds when people post or when they read, and then rank the result.
- Chapters: [Design a social media news feed](/learn/design-social-news-feed), [Design the Twitter timeline and search](/learn/design-twitter), [Caching](/learn/cache).
- References: [What are the best practices for building something like a news feed?](https://www.quora.com/What-are-the-best-practices-for-building-something-like-a-news-feed) and [What are the scaling issues to keep in mind while developing a social network feed?](https://www.quora.com/Activity-Streams/What-are-the-scaling-issues-to-keep-in-mind-while-developing-a-social-network-feed), two Quora threads; the second has an answer from an engineer who worked on Facebook's News Feed. [Etsy Activity Feeds Architecture](https://www.slideshare.net/danmckinley/etsy-activity-feeds-architecture), Dan McKinley's 2011 slides on building feeds offline and caching them.

**Design the Facebook timeline function.**

- What makes it hard: a profile page shows years of activity, and the normalized data behind it would need many joins per page. Fast pages need the data reshaped for the way it is read.
- Chapters: [Relational databases](/learn/relational-databases) for denormalization, [Caching](/learn/cache), [Design a social media news feed](/learn/design-social-news-feed).
- References: [Building Timeline: Scaling up to hold your life story](https://engineering.fb.com/2012/01/05/web/building-timeline-scaling-up-to-hold-your-life-story/), Ryan Mack's 2012 post on denormalizing the data, storing it in MySQL and caching it in memcached. [Facebook Timeline: Brought to You by the Power of Denormalization](https://highscalability.com/facebook-timeline-brought-to-you-by-the-power-of-denormaliza/), High Scalability's summary of that post.

**Design Google Docs.**

- What makes it hard: two people can type into the same sentence at the same moment, each against a version of the text that doesn't include the other's edit. The system must merge both without locking and without losing either.
- Chapters: [Design a collaborative document editor](/learn/design-collaborative-document), [Real-time communication](/learn/realtime).
- References: [Differential Synchronization](https://neil.fraser.name/writing/sync/), Neil Fraser's 2009 paper on keeping copies of a document in sync with repeated diff and patch. [google-mobwrite](https://code.google.com/archive/p/google-mobwrite), the archived code of MobWrite, a web editor built on that algorithm.

### Search, ranking and recommendations

**Design a search engine like Google.**

- What makes it hard: the index is far too large for one machine, a query must reach hundreds of machines and come back in a fraction of a second, and ranking decides whether the results are any good.
- Chapters: [Design a web search engine](/learn/design-search-engine), [Design a web crawler](/learn/design-web-crawler), [Design a key-value cache for a search engine](/learn/design-query-cache).
- References: [The Anatomy of a Large-Scale Hypertextual Web Search Engine](http://infolab.stanford.edu/~backrub/google.html), Sergey Brin and Larry Page's paper describing the first Google. [Why Writing Your Own Search Engine Is Hard](https://queue.acm.org/doi/10.1145/988392.988407), Anna Patterson's 2004 ACM Queue article on crawling, indexing and serving on a budget. [How would you implement Google Search?](https://softwareengineering.stackexchange.com/questions/38324/how-would-you-implement-google-search), a Stack Exchange thread that answers it as an interview question. [Implementing Search Engines](https://www.ardendertat.com/2012/01/11/implementing-search-engines/), Arden Dertat's 2012 series that builds a small search engine in Python, with TF-IDF ranking.

**Design a scalable web crawler like Google's.**

- What makes it hard: the list of links to visit grows faster than you can fetch it, the same page appears under many addresses, and you must not overload any one site.
- Chapters: [Design a web crawler](/learn/design-web-crawler), [Design a web search engine](/learn/design-search-engine), [Queues and async work](/learn/queues-and-async).
- References: [How can I build a web crawler from scratch?](https://www.quora.com/How-can-I-build-a-web-crawler-from-scratch-What-language-or-framework-would-you-recommend), a Quora thread.

**Design a graph search function like Facebook's.**

- What makes it hard: a query such as "friends of mine who live in Paris and like jazz" combines several relationships, and the answer must be personal to the searcher yet come back as fast as a normal search.
- Chapters: [Design the data structures for a social network](/learn/design-social-graph), [Design a web search engine](/learn/design-search-engine), [Design search autocomplete](/learn/design-autocomplete).
- References: three 2013 Facebook engineering posts: [Building out the infrastructure for Graph Search](https://engineering.fb.com/2013/03/06/core-infra/under-the-hood-building-out-the-infrastructure-for-graph-search/), [Indexing and ranking in Graph Search](https://engineering.fb.com/2013/03/14/core-infra/under-the-hood-indexing-and-ranking-in-graph-search/) and [The natural language interface of Graph Search](https://engineering.fb.com/2013/04/29/web/under-the-hood-the-natural-language-interface-of-graph-search/).

**Design a trending topic system like Twitter's.**

- What makes it hard: you count a firehose of events over a sliding window, and "trending" means rising faster than usual, which is different from being popular. Counts must be merged across many machines into one ranked list.
- Chapters: [Design Amazon's sales rank by category](/learn/design-sales-rank), [Event streaming](/learn/event-streaming), [Batch processing](/learn/batch-processing).
- References: [Implementing Real-Time Trending Topics with a Distributed Rolling Count Algorithm in Storm](https://michael-noll.com/blog/2013/01/18/implementing-real-time-trending-topics-in-storm/), Michael Noll's 2013 post on sliding-window counts merged into a top-N list. [Early detection of Twitter trends explained](https://snikolov.wordpress.com/2012/11/14/early-detection-of-twitter-trends/), Stanislav Nikolov's 2012 post on spotting trends by comparing a topic's activity with past examples.

**Return the top k requests during a time interval.**

- What makes it hard: there may be too many distinct requests to count each one exactly in memory, so you need an approximate counter with known error. Old requests must also drop out as the window slides.
- Chapters: [Design Amazon's sales rank by category](/learn/design-sales-rank), [Design a real-time gaming leaderboard](/learn/design-gaming-leaderboard), [Event streaming](/learn/event-streaming).
- References: [Efficient Computation of Frequent and Top-k Elements in Data Streams](https://www.cs.ucsb.edu/sites/default/files/documents/2005-23.pdf), Metwally, Agrawal and El Abbadi's 2005 paper on finding the top k items in limited space. [An Optimal Strategy for Monitoring Top-k Queries in Streaming Windows](https://davis.wpi.edu/xmdv/docs/EDBT11-diyang.pdf), Yang and others' 2011 EDBT paper on keeping a top-k answer up to date as a window slides.

**Design a recommendation system like Amazon's.**

- What makes it hard: the catalog is huge and a good model is expensive per item, so you can't score every item for every request. You also need fresh signals (what the user just clicked) alongside long-term taste.
- Chapters: [Design a personalized recommendation system](/learn/design-recommendation-system), [Batch processing](/learn/batch-processing), [Caching](/learn/cache).
- References: [Hulu's Recommendation System](https://web.archive.org/web/20170406065247/http://tech.hulu.com/blog/2011/09/19/recommendation-system.html), a 2011 Hulu engineering post (archived copy). [Tutorial: Recommender Systems](https://web.archive.org/web/20161219165858/http://ijcai13.org/files/tutorial_slides/td3.pdf), Dietmar Jannach and Gerhard Friedrich's slides from IJCAI 2013. The original link now returns a broken, cut-off file, so this is an archived copy.

### Commerce, trading and games

**Design a stock exchange (like NASDAQ or Binance).**

- What makes it hard: orders must be matched in a strict, fair order with very low latency, every trade must be recorded exactly once, and the matching engine is hard to split across machines because every order for one stock touches the same order book.
- Chapters: [Design a payment system](/learn/design-payment-system) for idempotency and ledgers, [Distributed transactions](/learn/distributed-transactions), [Reliability patterns](/learn/reliability-patterns), [Performance and latency](/learn/performance-and-latency).
- References: [How to Build an Exchange](https://www.youtube.com/watch?v=b1e4t2k2KJY), a talk on Jane Street's YouTube channel. [Building a trading engine for a crypto exchange](https://www.around25.com/blog/building-a-trading-engine-for-a-crypto-exchange), Cosmin Harangus's 2018 walkthrough in Go. [Building an exchange limit order book in Go](https://bhomnick.net/building-a-simple-limit-order-in-go/), Ben Homnick's 2017 post on order book data structures that add and cancel orders in about constant time.

**Design an online multiplayer card game.**

- What makes it hard: every player must see the same game state, players may be on slow or dropped connections, and the server has to stop players from cheating. Turn-based games can be asynchronous, while fast games need real-time updates.
- Chapters: [Real-time communication](/learn/realtime), [Design a deck of cards](/learn/ood-deck-of-cards), [Design a real-time gaming leaderboard](/learn/design-gaming-leaderboard).
- References: [How to Create an Asynchronous Multiplayer Game](https://web.archive.org/web/20180929181117/http://www.indieflashblog.com/how-to-create-an-asynchronous-multiplayer-game.html), an Indie Flash Blog post (archived copy). [Real Time Multiplayer in HTML5](http://buildnewgames.com/real-time-multiplayer/), Sven Bergström's article on keeping fast browser games in sync.

### Infrastructure and building blocks

**Design a tinyurl system like Bitly.**

- What makes it hard: short codes must never collide, redirects must be very fast, and billions of links need a sharding plan.
- Chapters: [Design a URL shortener](/learn/design-url-shortener), [Design a text-sharing service like Pastebin](/learn/design-pastebin), [Unique IDs](/learn/unique-ids).
- References: [System Design for Big Data: tinyurl](https://n00tc0d3r.blogspot.com/2013/09/big-data-tinyurl.html), a 2013 post on the N00tc0d3r blog.

**Design a random ID generation system.**

- What makes it hard: many servers must hand out IDs without talking to each other on every request, the IDs must never repeat, and they often need to sort roughly by time.
- Chapters: [Unique IDs](/learn/unique-ids), [Consensus](/learn/consensus).
- References: [Announcing Snowflake](https://blog.x.com/engineering/en_us/a/2010/announcing-snowflake), Twitter's 2010 post on the service it built to generate tweet IDs. [twitter-archive/snowflake](https://github.com/twitter-archive/snowflake), the archived code.

**Design an API rate limiter.**

- What makes it hard: limits must hold across many servers, so the counters live somewhere shared, and checking them must add almost no latency. You also decide what happens to a request over the limit and how to treat bursts.
- Chapters: [Rate limiting](/learn/rate-limiting), [Reverse proxies and API gateways](/learn/reverse-proxy-and-api-gateway), [Reliability patterns](/learn/reliability-patterns).
- References: [Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters), Paul Tarjan's 2017 Stripe post on its four kinds of limiters and load shedders, built on token buckets in Redis.

### Newer questions to try

These questions come up often in interviews today. They have no references here, but each is close to a worked design, so you can check most of your answer against it.

| Question | What makes it hard | Chapters that help |
| --- | --- | --- |
| Design a ride-hailing service's driver matching | Finding nearby drivers among millions of moving points, updated every few seconds. | [Real-time communication](/learn/realtime), [NoSQL databases](/learn/nosql-databases), [Design a notification system](/learn/design-notification-system) |
| Design a ticket booking system for a big concert | Selling each seat exactly once while a huge crowd arrives in the same minute. | [Distributed transactions](/learn/distributed-transactions), [Rate limiting](/learn/rate-limiting), [Design a payment system](/learn/design-payment-system) |
| Design a distributed job scheduler | Running each job once and on time, even when the machine that was going to run it fails. | [Queues and async work](/learn/queues-and-async), [Consensus](/learn/consensus), [Reliability patterns](/learn/reliability-patterns) |
| Design a metrics and monitoring system | Storing a flood of small time-stamped numbers cheaply and answering queries over them quickly. | [Observability](/learn/observability), [Event streaming](/learn/event-streaming), [NoSQL databases](/learn/nosql-databases) |
| Design a distributed message queue | Keeping messages durable and in order while many producers and consumers come and go. | [Queues and async work](/learn/queues-and-async), [Event streaming](/learn/event-streaming), [Consensus](/learn/consensus) |
| Design an ad click counter | Counting billions of clicks accurately enough to bill for them, without counting any click twice. | [Event streaming](/learn/event-streaming), [Batch processing](/learn/batch-processing), [Design Amazon's sales rank by category](/learn/design-sales-rank) |

## More object-oriented design questions

In an object-oriented design question you design the classes, their fields and methods, and how they work together, for a program that runs on one machine. Start by listing the nouns in the problem (they become classes) and the verbs (they become methods). Then write the main methods in code.

**Design a circular array.**

A circular array is a fixed-size array whose end wraps around to its start. Picture a queue of the last 1,000 log lines: when line 1,001 arrives, it overwrites line 1 instead of growing the array.

- Hint: store the items in a plain list plus a `start` offset. The item at logical position `i` lives at index `(start + i) % capacity`. Rotating the array by `k` then means only changing `start`, which takes constant time instead of moving every item. Decide what `append` does when the array is full (overwrite the oldest item, raise an error or grow), make the class iterable in logical order, and test the wrap-around at the end of the list.
- Closest worked chapter: [Design a hash map](/learn/ood-hash-table), which also maps positions into a fixed-size array with `%` and has to decide what to do when it fills up.

The questions below are common in interviews. They aren't worked through in the handbook, so use the hint and the closest chapter to check your approach.

| Question | Hint | Closest worked chapter |
| --- | --- | --- |
| Design an elevator system | Separate the elevator car (its floor, direction and stops) from the controller that decides which car answers each call. | [Design a call center](/learn/ood-call-center), which also assigns incoming requests to whoever is free |
| Design a vending machine | Model the machine as a set of states (idle, has money, dispensing) with the allowed moves between them. | [Design a parking lot](/learn/ood-parking-lot) |
| Design a library management system | Books, copies of a book, members and loans are separate classes. A loan links one copy to one member with a due date. | [Design a parking lot](/learn/ood-parking-lot), where spots, vehicles and levels play similar roles |
| Design a movie ticket booking system | Two people must not book the same seat. Hold seats for a few minutes while someone pays, then release them. | [Design a parking lot](/learn/ood-parking-lot) |
| Design a chess game | A `Piece` base class with one subclass per piece type, each knowing its own legal moves. The board checks the rules that involve several pieces. | [Design a deck of cards](/learn/ood-deck-of-cards), which uses the same base-class-and-subclass pattern |
| Design an in-memory file system | Files and directories share a base class, and a directory holds children, which can be either. Paths are walked one name at a time. | [Design a hash map](/learn/ood-hash-table), for looking up children by name |
| Design a text editor with undo and redo | Store each edit as an object that knows how to apply and reverse itself, and keep two stacks of them. | [Design an LRU cache](/learn/ood-lru-cache), for another design built from two cooperating data structures |

## How to practise with these

A short plan you can keep up for a few weeks:

1. **One question a day.** Pick a worked design first, answer it on your own with a 45-minute timer, then read the chapter. Once you've done a few, move on to the questions without worked answers.
2. **Then try the variation.** After the URL shortener, try Pastebin. After the chat system, try Facebook chat. Most of the reasoning carries over, and the differences show you what matters in each.
3. **Revisit your weak spots.** If your estimates were off, spend a day on [estimation](/learn/estimation). If you couldn't scale the database, read [relational databases](/learn/relational-databases) and [NoSQL databases](/learn/nosql-databases) again.

After each attempt, review your answer against this checklist:

- Did I ask about use cases and scale before drawing anything?
- Did I write down my estimates (requests per second, storage, read-to-write ratio) and use them later?
- Did I give each component in my high-level design a reason to exist?
- Did I go deep on the two or three parts that matter most for this question?
- Did I name at least one bottleneck and fix it, and say what the fix costs?
- Did I discuss what happens when a server, a database or a data center fails?
- Did I compare at least two options for one important decision and say why I picked one?

**Practising with a partner** is closer to the real thing than practising alone. One person plays the interviewer and keeps the question vague at first, so the other has to ask. The interviewer answers questions about scale with numbers, pushes on one component ("what happens if this cache goes down?"), and keeps time. Afterwards, go through the checklist together, then swap roles. Playing the interviewer teaches you a lot too, because you see which answers are easy to follow.

## Further reading

If you only read a few of the references above, start with these. Each one explains a decision you'll face again and again.

- [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf): the 2007 paper that introduced many of the ideas in the distributed key-value store design.
- [The Anatomy of a Large-Scale Hypertextual Web Search Engine](http://infolab.stanford.edu/~backrub/google.html): Brin and Page's description of the first Google, covering crawling, indexing and ranking.
- [Scaling Memcache at Facebook](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala): how a simple cache becomes a large shared system, from NSDI 2013.
- [How Google Serves Data from Multiple Datacenters](https://highscalability.com/how-google-serves-data-from-multiple-datacenters/): a clear comparison of the ways to copy data between sites and what each costs.
- [Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters): a short, practical post on protecting an API from too much traffic.
- [Real-world architectures](/learn/real-world-architectures): the handbook's list of articles on how real systems are built.
