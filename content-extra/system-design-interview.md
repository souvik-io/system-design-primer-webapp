# The system design interview, step by step

In a system design interview, you're given a short, open prompt such as "Design a URL shortener" or "Design the Twitter timeline," and about 45 minutes to talk through how you'd build it. There is no single correct answer. The interview is an open-ended conversation, and you are expected to lead it.

That's what makes it different from a coding interview. A Palantir engineering post on these interviews, [How to ace a systems design interview](https://web.archive.org/web/20210505130322/https://www.palantir.com/2011/10/how-to-rock-a-systems-design-interview/), says that whatever design you produce "is just a side effect." What the interviewer actually cares about is "the thought process behind your design choices." The same post warns that the prompts look simple but are "wide and bottomless," and reminds candidates that "there is no single right answer to a real-world problem. Everything is a tradeoff."

This chapter gives you four steps that keep the conversation on track. Use them on every practice question in the handbook. Each of the worked design questions follows the same four steps, so you can compare your answer with one that's laid out the same way.

```diagram
title: Four steps, in order. Each one narrows what the next has to cover.
[s1] 1. Requirements\nand estimates @ 0,0
[s2] 2. High-level\ndesign @ 1,0
[s3] 3. Core\ncomponents @ 2,0
[s4] 4. Scale the\ndesign @ 3,0
s1 -> s2
s2 -> s3
s3 -> s4
```

A rough way to split 45 minutes, which you should adjust to the question and the interviewer:

| Step | Rough time |
| --- | --- |
| 1. Outline use cases, constraints and assumptions | 5–10 minutes |
| 2. Create a high-level design | 10 minutes |
| 3. Design the core components | 15 minutes |
| 4. Scale the design | 10 minutes |

We'll use one example throughout: **"Design a URL shortener,"** a service like TinyURL or Bitly that turns a long web address into a short link and redirects anyone who opens it. The handbook's full answer is in [Design a URL shortener](/learn/design-url-shortener).

## Step 1: Outline use cases, constraints and assumptions

Before designing anything, find out what you're building and how big it is. Ask questions to pin down the use cases and the constraints, and say your assumptions out loud.

Questions worth asking for almost any system:

- Who is going to use it?
- How are they going to use it?
- How many users are there?
- What does the system do?
- What are the inputs and outputs of the system?
- How much data do we expect to handle?
- How many requests per second do we expect?
- What is the expected ratio of reads to writes?

Sort the answers into two lists:

- **Functional requirements** are what the system does. For the URL shortener: create a short link from a long one, and redirect anyone who opens the short link. Maybe custom aliases, expiry and click counts.
- **Non-functional requirements** are how well it must do it. For the URL shortener: redirects must be fast and almost always available, because short links get printed and shared everywhere.

Also say what you're leaving out, such as billing or fraud detection. It shows you're managing scope on purpose.

**Then estimate.** Turn the answers into a few numbers: requests per second at peak, storage over a few years, and how much data is hot enough to cache. For the URL shortener, the handbook's design assumes 100 million new links a month and 100 redirects per new link. That works out to about 39 writes and 3,860 redirects per second on average, and about 3 TB of storage over five years. Two conclusions fall out at once: the system is very read-heavy, and the data is small enough that the real challenge is serving reads quickly, not storing them. The [estimation](/learn/estimation) chapter teaches the method.

If the interviewer doesn't give you a number, propose one and say it out loud. A clearly stated assumption is better than a long pause.

## Step 2: Create a high-level design

Now sketch the whole system with all of its important parts, before going into detail on any of them.

- **Sketch the main components and how they connect.** Clients, load balancer, application servers, databases, caches, queues, and anything else the requirements need.
- **Justify each one.** Say why it's there, in one sentence, and connect it to a requirement or an estimate from step 1.
- **Name the main API calls and the core data.** For the URL shortener, that's `POST /api/v1/urls` to create a link and `GET /<code>` to follow one, and a table that maps each short code to its long URL.

```diagram
title: A first sketch of the URL shortener. Detail comes in step 3.
[c:client] Client @ 0,1
[lb] Load balancer @ 1,1
[app] App servers @ 2,1
[cache:store] Cache @ 3,0
[db:store] Database\ncode -> long URL @ 3,2
c -> lb
lb -> app
app -> cache
app -> db
```

Keep this step short. Its job is to agree on the shape of the system with the interviewer, so the rest of the time is spent on the parts that matter.

## Step 3: Design the core components

Pick the most important parts and go into detail on each. Often the interviewer will steer you toward one. For the URL shortener, the core components are:

**Generating and storing the short code.**

- One option is to hash the long URL with a function such as MD5 and encode part of the result in Base62 (the letters a–z and A–Z plus the digits 0–9). This raises a question you must answer: what happens when two URLs produce the same code, a **hash collision**?
- Another is to give each link a unique number from a counter and encode that number in Base62. No collisions, but you need a way to hand out unique numbers across many servers.
- Decide between SQL and NoSQL for the table, and sketch the schema.

The worked design compares both approaches in [Generating the short code](/learn/design-url-shortener#generating-the-short-code) and gives the [schema](/learn/design-url-shortener#schema).

**Translating a short code back into the long URL.** Each redirect is a lookup by code: check the cache, fall back to the database, then reply with an HTTP redirect. Even the choice of status code matters. A `301` lets browsers cache the redirect and skip your servers next time, while a `302` sends every click through you, so you can count it. See [301 vs 302](/learn/design-url-shortener#301-vs-302-and-307-308).

**The API and the object-oriented design.** Define the requests and responses exactly, and, if asked, the main classes in the code.

For each component, explain the options you considered and why you picked one. That reasoning is what the interviewer is listening for.

## Step 4: Scale the design

Finally, look for the bottlenecks, given the constraints from step 1, and fix them. Common questions to ask yourself:

- Do you need a **load balancer** and more application servers? This is **horizontal scaling**: running many copies of the same server.
- Would **caching** take load off the database? For a read-heavy system, almost always.
- Does the data need **sharding**, meaning splitting it across several databases?
- Is there slow work that could move to a **queue**, so users don't wait for it?
- What happens when a machine, a database or a whole data center fails?

For the URL shortener, the estimates in step 1 already point the way. Redirects outnumber new links 100 to 1, so a cache in front of the database serves most of them. Link creation is slow enough that one database could take it for a while, but billions of rows over five years mean planning how to shard the table.

**Everything is a trade-off.** For each fix, say what it costs: more parts to run, data that may be briefly out of date, or extra latency. Discuss more than one option, then pick one and say why. The [scalability](/learn/scalability-101) chapter walks through the usual fixes in the order systems tend to need them.

## Back-of-the-envelope calculations

You may be asked to estimate numbers by hand at any point in the interview. Three resources help:

- The [estimation](/learn/estimation) chapter, for the method and worked examples.
- The [powers of two table](/learn/numbers-to-know#powers-of-two), for converting between bytes, kilobytes, megabytes and so on.
- The [latency numbers every programmer should know](/learn/numbers-to-know#latency-numbers-every-programmer-should-know), for how long common operations take, from reading memory to a network round trip across the world.

Google's Jeff Dean argues that every engineer should be able to estimate how well different designs will perform this way, before building any of them. High Scalability's 2011 post, [Google Pro Tip: Use Back-of-the-Envelope Calculations to Choose the Best Design](https://highscalability.com/google-pro-tip-use-back-of-the-envelope-calculations-to-choo/), summarizes his advice with a worked example.

## Common mistakes

These come up again and again in practice interviews:

- **Designing before asking.** Jumping straight to boxes and arrows means you may solve the wrong problem. Spend the first few minutes on step 1.
- **Hiding your assumptions.** If you assume 10 million users but don't say so, the interviewer can't follow your reasoning or correct it.
- **Going deep too early.** Spending 20 minutes on the database schema before the whole system is sketched leaves no time for scaling.
- **Naming tools instead of reasons.** "We'll use Kafka" says little. "We'll put a queue here so uploads don't wait for thumbnails" shows you understand the problem.
- **Presenting one option as the only one.** Interviewers want to hear the alternatives and the trade-off you made.
- **Going quiet.** Think out loud. The interviewer can only judge the reasoning they hear.

## Check yourself

<details>
<summary>The prompt is "Design a photo-sharing app." What should your first five minutes sound like?</summary>

Questions and assumptions, not boxes. Who uses it and how: do people upload, follow others and scroll a feed? Which features are in scope: comments, likes, stories? How many daily users, how many uploads a day, how big is a photo, and what's the ratio of views to uploads? Then state the numbers you'll assume, turn them into rough requests per second and storage, and say what you're leaving out. Only then start sketching.

</details>

<details>
<summary>Why justify each component in the high-level design, instead of just drawing it?</summary>

Because the interviewer is judging your reasoning, not the diagram. A box labelled "cache" tells them you know caches exist. Saying "redirects outnumber new links 100 to 1, so a cache will serve most of them" shows you can connect a requirement to a design choice.

</details>

<details>
<summary>In step 3 of the URL shortener, why does the choice between hashing the URL and using a counter matter?</summary>

The two options fail in different ways. Hashing the URL and keeping only part of the hash can make two different URLs produce the same short code, so you need a plan for collisions, such as checking the database and trying again. A counter never collides, but every server needs unique numbers, so you need a way to hand them out without one server becoming a bottleneck. Choosing one, and saying why, is the kind of decision the interview is about.

</details>

<details>
<summary>The interviewer asks how your design handles ten times the traffic. How do you answer?</summary>

Go back to the numbers from step 1, multiply them by ten, and find what breaks first. Maybe the database can't handle the reads, the app servers run out of capacity, or the data no longer fits on one machine. Then propose a fix for each bottleneck, such as caching, more app servers behind the load balancer, or sharding, and say what each fix costs. Don't add components the new numbers don't need.

</details>

## Further reading

- [How to ace a systems design interview](https://web.archive.org/web/20210505130322/https://www.palantir.com/2011/10/how-to-rock-a-systems-design-interview/): Palantir's 2011 post, archived. Short, and its list of topics to be familiar with (concurrency, networking, real-world performance, estimation, availability) is still a good checklist.
- [The system design interview](https://www.hiredintech.com/system-design/): HiredInTech's free guide to the system design process, with practice.
- [Episode 06: Intro to Architecture and Systems Design Interviews](https://www.youtube.com/watch?v=ZgdS0EUmn70): Jackson Gabbard's video introduction to these interviews.
- [My System Design Template](https://leetcode.com/discuss/career/229177/My-System-Design-Template): a widely shared checklist on LeetCode's forum for structuring an answer. The page may ask you to sign in or block automated tools.
- [Google Pro Tip: Use Back-of-the-Envelope Calculations to Choose the Best Design](https://highscalability.com/google-pro-tip-use-back-of-the-envelope-calculations-to-choo/): High Scalability's 2011 summary of Jeff Dean's advice on estimation.
