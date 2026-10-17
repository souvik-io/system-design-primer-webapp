# Coverage checklist

Every topic in The System Design Primer, and where this site covers it. The site is replacing the primer's own text with chapters written here, and nothing the primer teaches may be lost on the way: each row needs a chapter before the primer can be removed.

- **Topic** is the primer's heading path (`›` separates levels), or a design question, object-oriented design question, Anki deck or About section.
- **Covered in** is `<chapter-id>#<heading-id>` (or just `<chapter-id>`). Leave it empty while the topic still needs writing.
- Fill a row only once that section teaches everything the primer's section does, including its disadvantages.
- `npm run coverage` checks that every target exists and reports what's left. `npm run coverage -- --strict` fails while any row is empty.

| Topic | Covered in |
| --- | --- |
| Motivation |  |
| Motivation › Learn how to design large-scale systems |  |
| Motivation › Learn from the open source community |  |
| Motivation › Prep for the system design interview |  |
| Study guide |  |
| How to approach a system design interview question |  |
| How to approach a system design interview question › Step 1: Outline use cases, constraints, and assumptions |  |
| How to approach a system design interview question › Step 2: Create a high level design |  |
| How to approach a system design interview question › Step 3: Design core components |  |
| How to approach a system design interview question › Step 4: Scale the design |  |
| How to approach a system design interview question › Back-of-the-envelope calculations |  |
| System design topics: start here |  |
| System design topics: start here › Step 1: Review the scalability video lecture |  |
| System design topics: start here › Step 2: Review the scalability article |  |
| System design topics: start here › Next steps |  |
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
| Availability patterns |  |
| Availability patterns › Fail-over |  |
| Availability patterns › Fail-over › Active-passive |  |
| Availability patterns › Fail-over › Active-active |  |
| Availability patterns › Disadvantage(s): failover |  |
| Availability patterns › Replication |  |
| Availability patterns › Replication › Master-slave and master-master |  |
| Availability patterns › Availability in numbers |  |
| Availability patterns › Availability in numbers › 99.9% availability - three 9s |  |
| Availability patterns › Availability in numbers › 99.99% availability - four 9s |  |
| Availability patterns › Availability in numbers › Availability in parallel vs in sequence |  |
| Domain name system |  |
| Domain name system › Disadvantage(s): DNS |  |
| Content delivery network |  |
| Content delivery network › Push CDNs |  |
| Content delivery network › Pull CDNs |  |
| Content delivery network › Disadvantage(s): CDN |  |
| Load balancer |  |
| Load balancer › Layer 4 load balancing |  |
| Load balancer › Layer 7 load balancing |  |
| Load balancer › Horizontal scaling |  |
| Load balancer › Horizontal scaling › Disadvantage(s): horizontal scaling |  |
| Load balancer › Disadvantage(s): load balancer |  |
| Reverse proxy (web server) |  |
| Reverse proxy (web server) › Load balancer vs reverse proxy |  |
| Reverse proxy (web server) › Disadvantage(s): reverse proxy |  |
| Application layer |  |
| Application layer › Microservices |  |
| Application layer › Service Discovery |  |
| Application layer › Disadvantage(s): application layer |  |
| Database |  |
| Database › Relational database management system (RDBMS) |  |
| Database › Relational database management system (RDBMS) › Master-slave replication |  |
| Database › Relational database management system (RDBMS) › Master-master replication |  |
| Database › Relational database management system (RDBMS) › Federation |  |
| Database › Relational database management system (RDBMS) › Sharding |  |
| Database › Relational database management system (RDBMS) › Denormalization |  |
| Database › Relational database management system (RDBMS) › SQL tuning |  |
| Database › NoSQL |  |
| Database › NoSQL › Key-value store |  |
| Database › NoSQL › Document store |  |
| Database › NoSQL › Wide column store |  |
| Database › NoSQL › Graph database |  |
| Database › NoSQL › Source(s) and further reading: NoSQL |  |
| Database › SQL or NoSQL |  |
| Cache |  |
| Cache › Client caching |  |
| Cache › CDN caching |  |
| Cache › Web server caching |  |
| Cache › Database caching |  |
| Cache › Application caching |  |
| Cache › Caching at the database query level |  |
| Cache › Caching at the object level |  |
| Cache › When to update the cache |  |
| Cache › When to update the cache › Cache-aside |  |
| Cache › When to update the cache › Write-through |  |
| Cache › When to update the cache › Write-behind (write-back) |  |
| Cache › When to update the cache › Refresh-ahead |  |
| Cache › Disadvantage(s): cache |  |
| Asynchronism |  |
| Asynchronism › Message queues |  |
| Asynchronism › Task queues |  |
| Asynchronism › Back pressure |  |
| Asynchronism › Disadvantage(s): asynchronism |  |
| Communication |  |
| Communication › Hypertext transfer protocol (HTTP) |  |
| Communication › Hypertext transfer protocol (HTTP) › Source(s) and further reading: HTTP |  |
| Communication › Transmission control protocol (TCP) |  |
| Communication › User datagram protocol (UDP) |  |
| Communication › User datagram protocol (UDP) › Source(s) and further reading: TCP and UDP |  |
| Communication › Remote procedure call (RPC) |  |
| Communication › Remote procedure call (RPC) › Disadvantage(s): RPC |  |
| Communication › Representational state transfer (REST) |  |
| Communication › Representational state transfer (REST) › Disadvantage(s): REST |  |
| Communication › RPC and REST calls comparison |  |
| Communication › RPC and REST calls comparison › Source(s) and further reading: REST and RPC |  |
| Security |  |
| Appendix |  |
| Appendix › Powers of two table |  |
| Appendix › Latency numbers every programmer should know |  |
| Appendix › Latency numbers every programmer should know › Latency numbers visualized |  |
| Appendix › Additional system design interview questions |  |
| Appendix › Real world architectures |  |
| Appendix › Company architectures |  |
| Appendix › Company engineering blogs |  |
| Design question › Design Pastebin.com (or Bit.ly) |  |
| Design question › Design the Twitter timeline and search |  |
| Design question › Design a web crawler |  |
| Design question › Design Mint.com |  |
| Design question › Design the data structures for a social network |  |
| Design question › Design a key-value store for a search engine |  |
| Design question › Design Amazon's sales ranking by category feature |  |
| Design question › Design a system that scales to millions of users on AWS |  |
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
