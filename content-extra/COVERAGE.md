# Coverage checklist

Every topic in The System Design Primer, and where this site covers it. The site is replacing the primer's own text with chapters written here, and nothing the primer teaches may be lost on the way: each row needs a chapter before the primer can be removed.

- **Topic** is the primer's heading path (`›` separates levels), or a design question, object-oriented design question, Anki deck or About section.
- **Covered in** is `<chapter-id>#<heading-id>` (or just `<chapter-id>`). Leave it empty while the topic still needs writing.
- Fill a row only once that section teaches everything the primer's section does, including its disadvantages.
- `npm run coverage` checks that every target exists and reports what's left. `npm run coverage -- --strict` fails while any row is empty.

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
| System design topics: start here | scalability-101 |
| System design topics: start here › Step 1: Review the scalability video lecture | scalability-101 |
| System design topics: start here › Step 2: Review the scalability article | scalability-101 |
| System design topics: start here › Next steps | scalability-101#what-comes-next |
| Performance vs scalability | performance-and-latency-101#performance-and-scalability-are-different-problems |
| Latency vs throughput | performance-and-latency-101#latency-and-throughput |
| Availability vs consistency | cap-and-consistency-101#what-c-a-and-p-actually-mean |
| Availability vs consistency › CAP theorem | cap-and-consistency-101#when-the-link-breaks |
| Availability vs consistency › CAP theorem › CP - consistency and partition tolerance | cap-and-consistency-101#cp-and-ap-choices-in-real-systems |
| Availability vs consistency › CAP theorem › AP - availability and partition tolerance | cap-and-consistency-101#cp-and-ap-choices-in-real-systems |
| Consistency patterns | cap-and-consistency-101#the-consistency-spectrum |
| Consistency patterns › Weak consistency | cap-and-consistency-101#the-consistency-spectrum |
| Consistency patterns › Eventual consistency | cap-and-consistency-101#the-consistency-spectrum |
| Consistency patterns › Strong consistency | cap-and-consistency-101#the-consistency-spectrum |
| Availability patterns | availability-101#fail-over-and-replication |
| Availability patterns › Fail-over | availability-101#fail-over-and-replication |
| Availability patterns › Fail-over › Active-passive | availability-101#fail-over-active-passive |
| Availability patterns › Fail-over › Active-active | availability-101#fail-over-active-active |
| Availability patterns › Disadvantage(s): failover | availability-101#disadvantages-of-fail-over |
| Availability patterns › Replication | availability-101#replication |
| Availability patterns › Replication › Master-slave and master-master | availability-101#replication |
| Availability patterns › Availability in numbers | availability-101#the-nines |
| Availability patterns › Availability in numbers › 99.9% availability - three 9s | availability-101#the-nines |
| Availability patterns › Availability in numbers › 99.99% availability - four 9s | availability-101#the-nines |
| Availability patterns › Availability in numbers › Availability in parallel vs in sequence | availability-101#availability-in-sequence-and-in-parallel |
| Domain name system | dns-and-cdn-101#how-dns-works |
| Domain name system › Disadvantage(s): DNS | dns-and-cdn-101#the-costs-and-risks-of-dns |
| Content delivery network | dns-and-cdn-101#content-delivery-networks |
| Content delivery network › Push CDNs | dns-and-cdn-101#push-cdns |
| Content delivery network › Pull CDNs | dns-and-cdn-101#pull-cdns |
| Content delivery network › Disadvantage(s): CDN | dns-and-cdn-101#the-downsides-of-a-cdn |
| Load balancer | load-balancing#what-a-load-balancer-does |
| Load balancer › Layer 4 load balancing | load-balancing#layer-4 |
| Load balancer › Layer 7 load balancing | load-balancing#layer-7 |
| Load balancer › Horizontal scaling | load-balancing#horizontal-scaling-and-what-it-costs |
| Load balancer › Horizontal scaling › Disadvantage(s): horizontal scaling | load-balancing#horizontal-scaling-and-what-it-costs |
| Load balancer › Disadvantage(s): load balancer | load-balancing#when-the-load-balancer-is-the-problem |
| Reverse proxy (web server) | reverse-proxy-and-api-gateway-101#what-a-reverse-proxy-is |
| Reverse proxy (web server) › Load balancer vs reverse proxy | reverse-proxy-and-api-gateway-101#load-balancer-vs-reverse-proxy |
| Reverse proxy (web server) › Disadvantage(s): reverse proxy | reverse-proxy-and-api-gateway-101#disadvantages-of-a-reverse-proxy |
| Application layer | reverse-proxy-and-api-gateway-101#separating-the-web-and-application-layers |
| Application layer › Microservices | reverse-proxy-and-api-gateway-101#microservices |
| Application layer › Service Discovery | reverse-proxy-and-api-gateway-101#service-discovery |
| Application layer › Disadvantage(s): application layer | reverse-proxy-and-api-gateway-101#disadvantages-of-the-application-layer-and-microservices |
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
| Cache | cache-101#what-a-cache-is |
| Cache › Client caching | cache-101#client-caching |
| Cache › CDN caching | cache-101#cdn-caching |
| Cache › Web server caching | cache-101#web-server-caching |
| Cache › Database caching | cache-101#database-caching |
| Cache › Application caching | cache-101#application-caching |
| Cache › Caching at the database query level | cache-101#caching-at-the-database-query-level |
| Cache › Caching at the object level | cache-101#caching-at-the-object-level |
| Cache › When to update the cache | cache-101#when-to-update-the-cache |
| Cache › When to update the cache › Cache-aside | cache-101#cache-aside |
| Cache › When to update the cache › Write-through | cache-101#write-through |
| Cache › When to update the cache › Write-behind (write-back) | cache-101#write-behind-write-back |
| Cache › When to update the cache › Refresh-ahead | cache-101#refresh-ahead |
| Cache › Disadvantage(s): cache | cache-101#the-costs-of-caching |
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
| Security | security-101 |
| Appendix |  |
| Appendix › Powers of two table |  |
| Appendix › Latency numbers every programmer should know |  |
| Appendix › Latency numbers every programmer should know › Latency numbers visualized |  |
| Appendix › Additional system design interview questions |  |
| Appendix › Real world architectures |  |
| Appendix › Company architectures |  |
| Appendix › Company engineering blogs |  |
| Design question › Design Pastebin.com (or Bit.ly) | design-pastebin |
| Design question › Design the Twitter timeline and search | design-twitter |
| Design question › Design a web crawler | design-web-crawler |
| Design question › Design Mint.com | design-mint |
| Design question › Design the data structures for a social network | design-social-graph |
| Design question › Design a key-value store for a search engine | design-query-cache |
| Design question › Design Amazon's sales ranking by category feature | design-sales-rank |
| Design question › Design a system that scales to millions of users on AWS | design-scaling-aws |
| Object-oriented design › Hash map |  |
| Object-oriented design › Least recently used cache |  |
| Object-oriented design › Call center |  |
| Object-oriented design › Deck of cards |  |
| Object-oriented design › Parking lot |  |
| Object-oriented design › Chat server |  |
| Anki deck › System design concepts |  |
| Anki deck › System design exercises |  |
| Anki deck › Object-oriented design |  |
| About › Anki flashcards |  |
| About › Coding Resource |  |
| About › Under development |  |
| About › Contributing |  |
| About › Credits |  |
| About › Contact info |  |
| About › License |  |
