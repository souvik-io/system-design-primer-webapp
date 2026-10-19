# Coverage checklist

This handbook's syllabus started from The System Design Primer, and when the site replaced the primer's text with its own chapters, nothing the primer taught was allowed to be lost. This table is the record: every topic in the primer, and the section of this site that covers it.

- **Topic** is the primer's heading path (`›` separates levels), or a design question, object-oriented design question, Anki deck or About section.
- **Covered in** is `<chapter-id>#<heading-id>` (or just `<chapter-id>`), or `deck:<deck-id>` for a flashcard deck.
- `npm run coverage -- --strict` checks that every target still exists. Run it after renaming a chapter or a heading, and update the rows it reports.

| Topic | Covered in |
| --- | --- |
| Motivation | how-to-use-this-handbook |
| Motivation › Learn how to design large-scale systems | how-to-use-this-handbook |
| Motivation › Learn from the open source community | how-to-use-this-handbook#an-open-handbook |
| Motivation › Prep for the system design interview | how-to-use-this-handbook |
| Study guide | how-to-use-this-handbook#pick-a-study-plan |
| How to approach a system design interview question | system-design-interview |
| How to approach a system design interview question › Step 1: Outline use cases, constraints, and assumptions | system-design-interview#step-1-outline-use-cases-constraints-and-assumptions |
| How to approach a system design interview question › Step 2: Create a high level design | system-design-interview#step-2-create-a-high-level-design |
| How to approach a system design interview question › Step 3: Design core components | system-design-interview#step-3-design-the-core-components |
| How to approach a system design interview question › Step 4: Scale the design | system-design-interview#step-4-scale-the-design |
| How to approach a system design interview question › Back-of-the-envelope calculations | system-design-interview#back-of-the-envelope-calculations |
| System design topics: start here | scalability |
| System design topics: start here › Step 1: Review the scalability video lecture | scalability |
| System design topics: start here › Step 2: Review the scalability article | scalability |
| System design topics: start here › Next steps | scalability#what-comes-next |
| Performance vs scalability | performance-and-latency#performance-and-scalability-are-different-problems |
| Latency vs throughput | performance-and-latency#latency-and-throughput |
| Availability vs consistency | cap-and-consistency#what-c-a-and-p-actually-mean |
| Availability vs consistency › CAP theorem | cap-and-consistency#when-the-link-breaks |
| Availability vs consistency › CAP theorem › CP - consistency and partition tolerance | cap-and-consistency#cp-and-ap-choices-in-real-systems |
| Availability vs consistency › CAP theorem › AP - availability and partition tolerance | cap-and-consistency#cp-and-ap-choices-in-real-systems |
| Consistency patterns | cap-and-consistency#the-consistency-spectrum |
| Consistency patterns › Weak consistency | cap-and-consistency#the-consistency-spectrum |
| Consistency patterns › Eventual consistency | cap-and-consistency#the-consistency-spectrum |
| Consistency patterns › Strong consistency | cap-and-consistency#the-consistency-spectrum |
| Availability patterns | availability#fail-over-and-replication |
| Availability patterns › Fail-over | availability#fail-over-and-replication |
| Availability patterns › Fail-over › Active-passive | availability#fail-over-active-passive |
| Availability patterns › Fail-over › Active-active | availability#fail-over-active-active |
| Availability patterns › Disadvantage(s): failover | availability#disadvantages-of-fail-over |
| Availability patterns › Replication | availability#replication |
| Availability patterns › Replication › Master-slave and master-master | availability#replication |
| Availability patterns › Availability in numbers | availability#the-nines |
| Availability patterns › Availability in numbers › 99.9% availability - three 9s | availability#the-nines |
| Availability patterns › Availability in numbers › 99.99% availability - four 9s | availability#the-nines |
| Availability patterns › Availability in numbers › Availability in parallel vs in sequence | availability#availability-in-sequence-and-in-parallel |
| Domain name system | dns-and-cdn#how-dns-works |
| Domain name system › Disadvantage(s): DNS | dns-and-cdn#the-costs-and-risks-of-dns |
| Content delivery network | dns-and-cdn#content-delivery-networks |
| Content delivery network › Push CDNs | dns-and-cdn#push-cdns |
| Content delivery network › Pull CDNs | dns-and-cdn#pull-cdns |
| Content delivery network › Disadvantage(s): CDN | dns-and-cdn#the-downsides-of-a-cdn |
| Load balancer | load-balancing#what-a-load-balancer-does |
| Load balancer › Layer 4 load balancing | load-balancing#layer-4 |
| Load balancer › Layer 7 load balancing | load-balancing#layer-7 |
| Load balancer › Horizontal scaling | load-balancing#horizontal-scaling-and-what-it-costs |
| Load balancer › Horizontal scaling › Disadvantage(s): horizontal scaling | load-balancing#horizontal-scaling-and-what-it-costs |
| Load balancer › Disadvantage(s): load balancer | load-balancing#when-the-load-balancer-is-the-problem |
| Reverse proxy (web server) | reverse-proxy-and-api-gateway#what-a-reverse-proxy-is |
| Reverse proxy (web server) › Load balancer vs reverse proxy | reverse-proxy-and-api-gateway#load-balancer-vs-reverse-proxy |
| Reverse proxy (web server) › Disadvantage(s): reverse proxy | reverse-proxy-and-api-gateway#disadvantages-of-a-reverse-proxy |
| Application layer | reverse-proxy-and-api-gateway#separating-the-web-and-application-layers |
| Application layer › Microservices | reverse-proxy-and-api-gateway#microservices |
| Application layer › Service Discovery | reverse-proxy-and-api-gateway#service-discovery |
| Application layer › Disadvantage(s): application layer | reverse-proxy-and-api-gateway#disadvantages-of-the-application-layer-and-microservices |
| Database | relational-databases |
| Database › Relational database management system (RDBMS) | relational-databases#what-a-relational-database-is |
| Database › Relational database management system (RDBMS) › Master-slave replication | relational-databases#primary-replica-replication |
| Database › Relational database management system (RDBMS) › Master-master replication | relational-databases#primary-primary-replication |
| Database › Relational database management system (RDBMS) › Federation | relational-databases#federation-one-database-per-feature |
| Database › Relational database management system (RDBMS) › Sharding | relational-databases#sharding-splitting-one-table-across-databases |
| Database › Relational database management system (RDBMS) › Denormalization | relational-databases#denormalization |
| Database › Relational database management system (RDBMS) › SQL tuning | relational-databases#sql-tuning |
| Database › NoSQL | nosql-databases#what-nosql-means |
| Database › NoSQL › Key-value store | nosql-databases#key-value-stores |
| Database › NoSQL › Document store | nosql-databases#document-stores |
| Database › NoSQL › Wide column store | nosql-databases#wide-column-stores |
| Database › NoSQL › Graph database | nosql-databases#graph-databases |
| Database › NoSQL › Source(s) and further reading: NoSQL | nosql-databases#further-reading |
| Database › SQL or NoSQL | nosql-databases#sql-or-nosql-making-the-choice |
| Cache | cache#what-a-cache-is |
| Cache › Client caching | cache#client-caching |
| Cache › CDN caching | cache#cdn-caching |
| Cache › Web server caching | cache#web-server-caching |
| Cache › Database caching | cache#database-caching |
| Cache › Application caching | cache#application-caching |
| Cache › Caching at the database query level | cache#caching-at-the-database-query-level |
| Cache › Caching at the object level | cache#caching-at-the-object-level |
| Cache › When to update the cache | cache#when-to-update-the-cache |
| Cache › When to update the cache › Cache-aside | cache#cache-aside |
| Cache › When to update the cache › Write-through | cache#write-through |
| Cache › When to update the cache › Write-behind (write-back) | cache#write-behind-write-back |
| Cache › When to update the cache › Refresh-ahead | cache#refresh-ahead |
| Cache › Disadvantage(s): cache | cache#the-costs-of-caching |
| Asynchronism | queues-and-async#doing-work-outside-the-request |
| Asynchronism › Message queues | queues-and-async#how-a-message-queue-works |
| Asynchronism › Task queues | queues-and-async#message-queues-and-task-queues |
| Asynchronism › Back pressure | queues-and-async#back-pressure-when-the-queue-keeps-growing |
| Asynchronism › Disadvantage(s): asynchronism | queues-and-async#when-to-stay-synchronous |
| Communication | protocols-and-apis#layers-how-one-request-is-built |
| Communication › Hypertext transfer protocol (HTTP) | protocols-and-apis#http-requests-and-responses |
| Communication › Hypertext transfer protocol (HTTP) › Source(s) and further reading: HTTP | protocols-and-apis#further-reading |
| Communication › Transmission control protocol (TCP) | protocols-and-apis#tcp-reliable-delivery-with-a-price |
| Communication › User datagram protocol (UDP) | protocols-and-apis#udp-fast-with-no-promises |
| Communication › User datagram protocol (UDP) › Source(s) and further reading: TCP and UDP | protocols-and-apis#further-reading |
| Communication › Remote procedure call (RPC) | protocols-and-apis#rpc-calling-a-function-on-another-machine |
| Communication › Remote procedure call (RPC) › Disadvantage(s): RPC | protocols-and-apis#disadvantages-of-rpc |
| Communication › Representational state transfer (REST) | protocols-and-apis#rest-resources-and-representations |
| Communication › Representational state transfer (REST) › Disadvantage(s): REST | protocols-and-apis#disadvantages-of-rest |
| Communication › RPC and REST calls comparison | protocols-and-apis#rpc-and-rest-side-by-side |
| Communication › RPC and REST calls comparison › Source(s) and further reading: REST and RPC | protocols-and-apis#further-reading |
| Security | security |
| Appendix | numbers-to-know |
| Appendix › Powers of two table | numbers-to-know#powers-of-two |
| Appendix › Latency numbers every programmer should know | numbers-to-know#latency-numbers-every-programmer-should-know |
| Appendix › Latency numbers every programmer should know › Latency numbers visualized | numbers-to-know#how-these-numbers-have-changed |
| Appendix › Additional system design interview questions | practice-questions#more-system-design-questions |
| Appendix › Real world architectures | real-world-architectures#systems-and-papers |
| Appendix › Company architectures | real-world-architectures#company-architectures |
| Appendix › Company engineering blogs | real-world-architectures#company-engineering-blogs |
| Design question › Design Pastebin.com (or Bit.ly) | design-pastebin |
| Design question › Design the Twitter timeline and search | design-twitter |
| Design question › Design a web crawler | design-web-crawler |
| Design question › Design Mint.com | design-mint |
| Design question › Design the data structures for a social network | design-social-graph |
| Design question › Design a key-value store for a search engine | design-query-cache |
| Design question › Design Amazon's sales ranking by category feature | design-sales-rank |
| Design question › Design a system that scales to millions of users on AWS | design-scaling-aws |
| Object-oriented design › Hash map | ood-hash-table |
| Object-oriented design › Least recently used cache | ood-lru-cache |
| Object-oriented design › Call center | ood-call-center |
| Object-oriented design › Deck of cards | ood-deck-of-cards |
| Object-oriented design › Parking lot | ood-parking-lot |
| Object-oriented design › Chat server | ood-online-chat |
| Anki deck › System design concepts | deck:topics |
| Anki deck › System design exercises | deck:design-walkthroughs |
| Anki deck › Object-oriented design | deck:object-oriented |
| About › Anki flashcards | about#flashcards |
| About › Coding Resource | about#coding-interview-practice |
| About › Under development | about#under-development |
| About › Contributing | about#contributing |
| About › Credits | about#credits |
| About › Contact info | about#contact-info |
| About › License | about#license |
