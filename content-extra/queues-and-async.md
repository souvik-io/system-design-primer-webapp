# Queues and asynchronous work

This chapter answers five questions:

- Which work should happen while the user waits, and which should happen later?
- How does a queue hand work to background workers, and how does the user find out it's done?
- What happens when a worker crashes halfway through a job?
- How many workers do you need, and how long will a job wait?
- What should happen when work arrives faster than workers can finish it?

We'll keep using **Crumb**, the recipe-sharing site from [Scalability 101](/learn/scalability-101). Crumb has several slow jobs: resizing uploaded photos, sending a weekly newsletter, working out which recipes are trending, and exporting a user's data on request. This chapter follows those jobs.

Two words first. Work is **synchronous** when the caller waits for it to finish before getting an answer. Work is **asynchronous** when the caller gets an answer straight away and the work finishes later, usually in another process. Scalability 101 introduced the idea with a [bakery analogy](/learn/scalability-101#asynchronism). This chapter covers how it works in practice.

## Doing work outside the request

When a Crumb user uploads a photo, the app makes four sizes of it, strips the location data, and checks it for banned content. That takes about three seconds. Doing work **in-line** means doing it inside the request, before the response goes back. Done in-line, the user watches a spinner for three seconds while the app server serves no one else. If 500 people upload at once, every app server is busy with photos and the whole site slows down.

There are two ways to move expensive work out of the request.

**Defer it.** The app records that the work needs doing, replies at once, and lets a background process do it a moment later. The upload returns in about 150 ms with "Your photo is processing", and a worker does the resizing. This is what a queue is for.

**Do it in advance.** Some work doesn't depend on any one request. Crumb's "trending recipes" list counts views and saves across millions of rows. Counting on every page view would be slow and wasteful, so a job recounts every five minutes and stores the result, and pages just read it. This is called **periodic aggregation**. When the data outgrows one machine, it becomes [batch processing](/learn/batch-processing).

| Crumb's work | When it runs | Why |
| --- | --- | --- |
| Resize an uploaded photo | Deferred, seconds later | Slow, and the user can carry on without it |
| Export a user's data | Deferred, minutes later | Very slow, so the user is told by email |
| Weekly newsletter, trending list | On a schedule | Not triggered by any one request |
| Total cooking time for a recipe | In-line | Takes microseconds, and the page needs it now |

## How a message queue works

A **message** is a small piece of data that one program sends to another, such as `{"job": "resize", "photo": "uploads/8812.jpg"}`. A **message queue** receives messages, holds them until someone is ready, and then delivers them. The program that sends messages is the **producer**. The program that takes them off is the **consumer**, usually called a **worker** when it runs background jobs. The server that runs the queue is the **broker**.

Here is Crumb's photo upload:

1. The app server saves the original photo to object storage.
2. It writes a `jobs` row with the status "queued", publishes a message with the job ID to the queue, and replies to the browser with the job ID.
3. A worker receives the message, resizes the photo and saves the new sizes.
4. The worker marks the job "done" and tells the queue it has finished, so the queue deletes the message.

```diagram
title: Crumb's photo upload. The app replies at once, and a worker does the slow part.
[u:client] Browser @ 0,0
[app] App server @ 1,0
[q:queue] Photo jobs\nqueue @ 2,0
[w] Workers @ 3,0
[db:store] Jobs table @ 1,1.3
[s:store] Object storage @ 3,1.3
u -> app : upload
app -> db : status
app --> q : publish
q --> w
w -> s : resized photos
```

The user isn't blocked, and the app server is free after a few milliseconds. The queue also absorbs bursts. If uploads arrive faster than workers handle them for a few minutes, messages wait in the queue and workers catch up afterwards.

### Making it feel instant

The page can act as if deferred work has already happened. The client does a small amount of work itself so the user sees a result at once. This is called an **optimistic update**.

When a Crumb user posts a recipe, the browser adds it to the top of their own profile straight away, using the data it just sent. Behind the scenes, workers still have to index it for search and add it to the feeds of the author's 40,000 followers, which can take a minute. The author sees it immediately, which is what they care about. The cost is that the page must handle failure, for example with "This photo couldn't be processed. Try again?"

### Telling the user the job is done

| Method | How it works | Good for |
| --- | --- | --- |
| Polling | The client asks a status URL every few seconds | Simple pages and scripts |
| Push | The server sends an update over a WebSocket or server-sent events (see [realtime](/learn/realtime)) | Pages the user is still looking at |
| Webhook | The server calls a URL the client registered in advance | Other companies' systems using your API |
| Email or notification | The server sends a link | Jobs that take minutes or hours |

HTTP has a status code for this. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-202-accepted) defines **202 Accepted** as meaning the request "has been accepted for processing, but the processing has not been completed," and says the response ought to point to a status monitor. So Crumb's export endpoint replies `202 Accepted` with a link like `/exports/5521`. The page polls that link, and Crumb also emails a download link, because someone waiting 20 minutes for an export has probably closed the tab.

### Keep messages small

Queues are built for many small messages. Amazon SQS [allows up to 1 MiB per message](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html), and for anything bigger AWS points to a library that stores the payload in S3 and sends a reference. Do the same everywhere: put large data in storage and only its location in the message. This is often called a **claim check**. Crumb's photo messages are about 1 KB, while the photos are about 5 MB.

## Message queues and task queues

- A **message queue** moves messages without caring what is inside them. RabbitMQ, Amazon SQS and Redis are used this way.
- A **task queue** is a framework built on top of a message queue. You give it a task: a function name plus its arguments. It sends the task through a broker and runs the function in a worker process. Most task queues also retry failures, store results and run tasks on a schedule.

Celery is a common task queue for Python. Its [introduction](https://docs.celeryq.dev/en/stable/getting-started/introduction.html) describes RabbitMQ and Redis as fully supported brokers and lists Amazon SQS among others. A Crumb task looks like this:

```python
@app.task
def resize_photo(photo_key):
    ...  # make four sizes, strip location data, check content

# In the upload handler: send the task and return at once.
resize_photo.delay("uploads/8812.jpg")
```

`.delay` doesn't run the function. It sends a message to the broker, and a Celery worker runs the function later. This suits CPU-heavy jobs, because the workers can run on separate machines sized for that work.

### Tools you'll meet

| Tool | What it is | What to know |
| --- | --- | --- |
| Redis Pub/Sub | Broadcast channels in Redis | At-most-once. The [docs](https://redis.io/docs/latest/develop/pubsub/) say that if a subscriber has an error or disconnects, the message "is forever lost". |
| Redis Streams | An append-only log in Redis | Stored messages with acknowledgements, so at-least-once is possible. The [docs](https://redis.io/docs/latest/develop/data-types/streams/) warn that replication is asynchronous, so a failover can lose recent messages. |
| RabbitMQ | An open-source broker you run yourself | [Originally built for AMQP 0-9-1](https://www.rabbitmq.com/docs/protocols). AMQP 1.0 became a core protocol in version 4.0, and plugins add MQTT and STOMP. You install, monitor and upgrade the nodes. |
| Amazon SQS | A hosted queue | No servers to run. [Standard queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-queue-types.html) deliver every message at least once, sometimes twice, in roughly the order sent. FIFO queues keep order within a message group. Every call is an HTTPS request to AWS, so expect more delay than from a broker on your own network. |
| Celery | Task queue for Python | Runs on RabbitMQ, Redis or SQS. Clients exist for other languages, but its home is Python. |
| Sidekiq | Task queue for Ruby | [Keeps jobs in Redis](https://github.com/sidekiq/sidekiq) and retries failures automatically. |
| BullMQ | Task queue for Node.js | [Built on Redis](https://docs.bullmq.io/), with delayed jobs, priorities, retries and cron-style repeating jobs. |

Kafka is the other big name. It is a **log**: it keeps messages after they are read, so many readers can go through them and replay them. A **queue** deletes each message once a worker handles it. The [event streaming](/learn/event-streaming#queues-and-logs) chapter covers that choice. For background jobs like Crumb's, a queue is usually the simpler fit.

## When a worker fails halfway

Workers crash. Deploys restart them, machines get replaced, and code throws exceptions. The queue has to decide what happens to the message a dead worker was holding.

### Acknowledgements and visibility timeouts

A worker **acknowledges** a message only after it has finished the work. Until then, the queue keeps it. Amazon SQS does this with a **visibility timeout**. When a worker receives a message, [SQS hides it from other workers](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) for a set time: 30 seconds by default, 12 hours at most. If the worker deletes the message in time, it's gone. If the worker crashes, the message reappears and another worker takes it. Redis Streams keeps a similar pending list of delivered but unacknowledged messages, which a healthy consumer can claim.

The timeout must be longer than the job. If a huge panorama takes 50 seconds and the timeout is 30, the message reappears while the first worker is still busy, and a second worker starts on it too. An Amazon [Builders' Library article on queue backlogs](https://builder.aws.com/content/3EuRcgkTP1MI0c7zM8W6HL3WIqA/avoiding-insurmountable-queue-backlogs) warns that this snowballs under load: when everything slows down, more jobs overrun the timeout, so more work is done twice. Set the timeout above the slowest normal job. For long jobs, have the worker extend it while it works, a **heartbeat**. In SQS that is the `ChangeMessageVisibility` call, still within the 12-hour cap.

### Duplicates are normal, so make workers idempotent

Acknowledging after the work gives **at-least-once delivery**. Nothing is lost, but a message can be handled twice, for example when a worker finishes a job and crashes before acknowledging. SQS standard queues can also deliver a message twice by themselves, and the SQS docs tell you to design for it. The [event streaming chapter](/learn/event-streaming#delivery-semantics) explains the delivery guarantees and what "exactly once" really means.

So every worker should be **idempotent**: running it twice has the same effect as running it once.

- **Resizing a photo** writes the same four files to the same four paths. Running it twice wastes a little CPU and does no harm.
- **Sending the newsletter** is not idempotent, because a second run sends a second email. The worker can record each (subscriber, issue) pair with a unique constraint and skip pairs already recorded. A crash between sending and recording still allows a rare duplicate. That is acceptable for email. For payments, use the [idempotency keys](/learn/reliability-patterns#idempotency-keys) that payment APIs provide.

### Retries and dead-letter queues

Some failures are temporary, like a database that was briefly overloaded. Retrying later usually works. Task queues do this for you. Sidekiq's [error-handling guide](https://github.com/sidekiq/sidekiq/wiki/Error-Handling) says a failed job is retried 25 times over about three weeks, waiting longer after each attempt, which gives the team time to ship a fix. The growing wait is **exponential backoff**. Adding randomness, called **jitter**, stops thousands of failed jobs retrying at the same instant. See [reliability patterns](/learn/reliability-patterns#retries-backoff-and-retry-storms) for both.

Other failures are permanent, like a corrupt photo file. A message that fails every time is a **poison message**. A **dead-letter queue** is a separate queue where such messages go after a set number of attempts, so a person can inspect them, fix the bug and send them back. SQS and RabbitMQ have them, and Sidekiq calls its version the Dead set. The [event streaming chapter](/learn/event-streaming#dead-letter-queues) covers setting one up.

## Scheduling, delays and priorities

### Delayed and periodic jobs

A **delayed job** runs after a set wait, such as a nudge 10 minutes after a user abandons a half-written recipe. SQS can [hide a message for up to 15 minutes](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html), and BullMQ and Celery support jobs that run at a later time. For long delays, like "remind me in 30 days", store the due time in a database table and have a scheduled job enqueue whatever is due. That survives broker restarts and is easy to cancel.

A **periodic job** runs on a timetable, like the trending list every five minutes or the newsletter every Monday. The classic tool is **cron**, the Unix scheduler, which reads schedules like `*/5 * * * *` (every five minutes). Celery's version is [celery beat](https://docs.celeryq.dev/en/stable/userguide/periodic-tasks.html). Its docs warn that only one scheduler may run for a schedule, "otherwise you'd end up with duplicate tasks." If Crumb runs a scheduler on two machines for safety, the newsletter goes out twice. Run exactly one, or make each run idempotent, for example by recording "issue 2026-10-19 sent" and skipping the run if that record exists.

### Priorities

Crumb's workers send password-reset emails, which a user is waiting for, and the newsletter, which goes to 300,000 people at once. On a shared queue, a password reset can sit behind 300,000 newsletter messages. There are two fixes.

- **A priority queue** delivers higher-priority messages first. RabbitMQ [supports this](https://www.rabbitmq.com/docs/priority) and recommends only two to four levels. Its docs note that priority only matters when messages are backed up.
- **Separate queues** give each kind of work its own queue and workers. Password resets get a small pool that is always ready. The newsletter pool can fall hours behind without hurting anything else.

RabbitMQ's priority page suggests considering separate queues first. The [notification system design](/learn/design-notification-system#priority-versus-bulk) uses the same split.

### Fan-out with publish/subscribe

When a recipe is published, Crumb needs to update search, update followers' feeds, and send push notifications. With **publish/subscribe** (pub/sub), the app publishes one "recipe published" event to a **topic**, and each interested service gets its own copy in its own queue. Adding a spam checker later means adding a subscriber, with no change to the publisher. RabbitMQ does this with a [fanout exchange](https://www.rabbitmq.com/tutorials/tutorial-three-python), which copies each message to every queue bound to it. In Kafka, each service reads the same log as its own consumer group.

## Publishing reliably after a database write

The photo flow hides a trap. The app writes to the database and also publishes to the queue. These are two separate systems, so it can't update both in one step.

- **Save, then crash before publishing:** the recipe exists but is never indexed, and nothing notices.
- **Publish, then the transaction fails:** a worker processes a recipe that doesn't exist.
- **Publish before the transaction commits:** a fast worker looks for the recipe too early and reports "not found". This only shows up under load, so it is easy to miss.

This is the **dual-write problem**. The usual fix is the **transactional outbox**. The app writes the event to an `outbox` table in the same transaction as the recipe, so both are saved or neither is. A relay process then reads the outbox and publishes each event. The relay can publish an event twice, so consumers must still be idempotent. The [distributed transactions chapter](/learn/distributed-transactions#the-dual-write-problem-and-the-transactional-outbox) covers the outbox in full.

## Sizing workers with Little's Law

**Little's Law** says the average number of items in a system equals the rate they arrive times the average time each one spends there:

```
L = λ × W
items in the system = arrival rate × time each one spends there
```

The [performance and latency chapter](/learn/performance-and-latency-101#littles-law) explains it. Here is how it sizes Crumb's photo queue.

**How many workers.** At the Sunday-evening peak, Crumb gets 20 uploads a second, and each job takes 3 seconds. So 20 × 3 = 60 jobs are in progress on average, and Crumb needs at least 60 worker processes. Running them flat out leaves no room for bursts or retries, and [waiting time shoots up](/learn/performance-and-latency-101#queueing-why-busy-servers-get-slow-suddenly) as anything nears 100% busy. Aiming for about 70% busy gives 60 ÷ 0.7 ≈ 86, rounded to 90 workers. Together they finish 90 ÷ 3 = 30 jobs a second.

**What a spike does.** A celebrity chef runs a "post your dinner" challenge, and uploads jump to 100 a second for 10 minutes. Workers still finish 30 a second, so the queue grows by 70 every second.

- After 10 minutes, the backlog is 70 × 600 = 42,000 jobs.
- A photo uploaded then waits about 42,000 ÷ 30 = 1,400 seconds, around 23 minutes, before a worker starts on it. That is Little's Law applied to the queue: wait = queue length ÷ drain rate.
- Once uploads fall back to 20 a second, workers gain only 30 − 20 = 10 jobs a second. Clearing 42,000 jobs takes 4,200 seconds, about 70 minutes.

A 10-minute spike causes over an hour of slow thumbnails. The AWS article puts it as a rule: after an hour-long outage, a system needs "double the system's capacity for another hour" to recover.

**Why small messages matter.** At 1 KB each, 42,000 messages take about 42 MB. If each carried the 5 MB photo, the backlog would be about 210 GB, more memory than most broker machines have.

**What to watch.** Queue length is useful, but the **age of the oldest message** says directly how far behind the workers are. The AWS article says its teams focus on "the age of messages that are in the queue." If Crumb adds workers automatically, it should scale on that age, and check that the database behind the workers can take the extra load.

## Back pressure: when the queue keeps growing

A queue absorbs a burst. It can't absorb work that arrives faster than workers finish it for a long time. Then the queue only grows, and that hurts in three ways.

1. **Every job gets slower**, because each new job waits behind the whole backlog. Results arrive after anyone cares.
2. **The broker runs short of memory.** Many brokers keep messages in RAM. Once the queue outgrows memory, the broker reads from disk and misses its caches more often, so it slows down just when it most needs speed. A broker that keeps everything in memory may stop completely.
3. **Recovery takes longer**, because a bigger backlog takes longer to clear.

### A real incident: Slack's job queue

Slack runs its background work through a job queue. [Slack's engineering blog](https://slack.engineering/scaling-slacks-job-queue/) says it handles "every Slack message post, push notification, URL unfurl, calendar reminder, and billing calculation," processing over 1.4 billion jobs on its busiest days at a peak of 33,000 a second. The original design held queued jobs in Redis, in memory.

The post describes a major outage this caused. Contention in Slack's database layer slowed the jobs down. Jobs kept arriving at the usual rate, so the queue grew until Redis hit its maximum configured memory. After that, no new jobs could be added, and every Slack feature that depended on the queue failed. Worse, taking a job off the queue also needed a little free memory. Even after the database was fixed, the queue stayed stuck and needed "extensive manual intervention to recover."

Slack's fix was to put Kafka in front of Redis. The web app now writes jobs to Kafka, which keeps them on disk for two days. A relay moves jobs from Kafka into Redis at a rate limit operators can change. When workers slow down, the backlog builds on disk, where there is room, and Redis only gets what the relay lets through.

The lessons apply to any queue. Decide what happens when the queue is full before it happens. Make sure removing work never depends on having room to add work. Put a limit, or a large durable buffer, in front of anything that holds messages in memory.

### Bounding the queue

**Back pressure** means pushing back on producers when consumers can't keep up, instead of accepting more work than the system can handle. The simplest form is a limit on the queue's length.

Pick the limit from the longest wait you'll accept. By Little's Law, limit = drain rate × longest acceptable wait. Crumb decides no photo should wait more than 10 minutes, and its workers drain 30 jobs a second, so the limit is 30 × 600 = 18,000 messages. During the chef's challenge the queue fills in about 18,000 ÷ 70 ≈ 260 seconds. After that, some uploads are turned away, and every accepted photo is ready within 10 minutes.

Martin Thompson's post [Applying Back Pressure When Overloaded](https://mechanical-sympathy.blogspot.com/2012/05/apply-back-pressure-when-overloaded.html) makes the case: a system that bounds its queues keeps working at full throughput and keeps response times good for work it has accepted. Brokers give you the tools.

- RabbitMQ can [cap a queue](https://www.rabbitmq.com/docs/maxlength) by message count or bytes. By default it then drops the oldest messages. With `reject-publish` it refuses new ones, and a publisher using confirms is told each time.
- When a RabbitMQ node runs low on memory or disk, it [blocks connections that publish](https://www.rabbitmq.com/docs/alarms) until the alarm clears, while consumers keep receiving.

Which end to drop depends on the job. For photo uploads, refuse new work, because the queued jobs still matter. For the trending list, drop old messages, because a newer run replaces an older one. The AWS article notes that some systems "can tolerate very old messages being dropped" for this reason.

### What the caller sees

```diagram
title: A bounded queue. When it is full, new work is refused quickly instead of piling up.
[c:client] Browsers @ 0,0
[api] Upload API @ 1,0
[q:queue] Photo queue\nlimit 18,000 @ 2,0
[w] 90 workers\n30 jobs a second @ 3,0
[n:note] When full:\n503 + Retry-After\nclient backs off @ 1,1.2
c -> api
api --> q : only if room
q --> w
```

- **503 Service Unavailable** is the standard reply. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-503-service-unavailable) describes it as a temporary overload "which will likely be alleviated after some delay," and lets the server send a `Retry-After` header saying how long to wait.
- **429 Too Many Requests** fits better when one client is over its own limit. See [rate limiting](/learn/rate-limiting).
- The client should **retry later with exponential backoff and jitter**. Crumb's upload page keeps the photo in the browser, shows "Busy, retrying in 30 seconds", and tries again with growing waits. Retrying at once in a tight loop would only add to the overload.

Refusing is not the only option. Crumb could accept uploads but make two image sizes instead of four until the queue drains, or pause the newsletter workers and lend their machines to photos. Both are forms of [load shedding](/learn/reliability-patterns#load-shedding), deciding in advance which work matters most.

## When to stay synchronous

Queues have costs. They add a broker to run and monitor, workers to deploy, duplicates to handle, and a user interface that must show "still processing". One user action now spans two processes, which is harder to debug without [tracing](/learn/observability#distributed-tracing). And every deferred result arrives a little later.

Keep work synchronous in two cases.

- **It's cheap.** Adding up a recipe's cooking time takes microseconds. A queue would make it slower and add new ways to fail.
- **The user needs the answer to continue.** Checking a password at login, or approving a card at checkout, must finish before the next page loads. These are realtime workflows. A queue would only hide the same wait behind a polling loop.

Even then, the slow parts that follow can often be split off. The card approval stays synchronous, and the receipt email goes on a queue. In short, queue work that is slow, can wait, or may need retrying. Keep work in-line when it is fast and this response needs it.

## Check yourself

<details>
<summary>Crumb adds "Download all my data". Building the file takes 2 to 20 minutes. Walk through the design from the moment the user clicks.</summary>

The endpoint creates an `exports` row marked "queued" and records the job event in the same transaction, through an outbox. It replies `202 Accepted` with a status link like `/exports/5521`. A worker builds the file, uploads it to object storage, marks the row "done" and emails a download link. An open page can poll the status link or get a push update. The worker must be idempotent: a retry overwrites the same file and emails only if the row isn't already marked as sent. Because the job can take 20 minutes, the visibility timeout must be longer than that, or the worker must extend it with a heartbeat.

</details>

<details>
<summary>Crumb's video workers use SQS with the default 30-second visibility timeout. Transcoding takes about two minutes. What happens, and how do you fix it?</summary>

After 30 seconds the message reappears and a second worker starts on the same video. Another 30 seconds later a third starts, and so on. Each video is transcoded several times, workers are wasted on duplicates, and a backlog can build up. Set the timeout well above the slowest normal job, or have the worker extend it with `ChangeMessageVisibility` while it runs, within the 12-hour cap. Make the worker idempotent too, since standard queues can deliver twice anyway.

</details>

<details>
<summary>Recipe imports arrive at 50 a second and each takes 400 ms. How many workers do you need? With 90,000 messages queued and a drain rate of 100 a second, how long does a new import wait? What queue limit keeps the wait under 5 minutes?</summary>

By Little's Law, 50 × 0.4 = 20 imports are in progress on average, so you need at least 20 workers. Aiming for about 70% busy gives 20 ÷ 0.7 ≈ 29, so about 30. A new import waits about 90,000 ÷ 100 = 900 seconds, which is 15 minutes. To keep the wait under 5 minutes at 100 a second, cap the queue at 100 × 300 = 30,000 messages, and reply 503 with `Retry-After` when it's full.

</details>

<details>
<summary>A teammate wants to queue three things: updating a recipe's average rating when someone rates it, checking a password at login, and making a printable PDF of a recipe. Which would you queue?</summary>

The rating average is cheap with a running sum and count, so keep it in-line. The password check must stay synchronous, because the user can't continue without the answer, and a queue would only add delay and moving parts. The PDF is the best candidate: slow, CPU-heavy and safe to retry. The page can say "Preparing your PDF" and offer the download when it's ready.

</details>

<details>
<summary>Crumb's search indexer sometimes logs "recipe not found" for recipes that clearly exist a minute later. What's the likely cause, and the fix?</summary>

The app is probably publishing "index this recipe" before its transaction commits. A fast worker looks up the recipe before the row is visible and finds nothing. Publishing after the commit fixes that, but a crash between commit and publish would then lose the message. The transactional outbox solves both: the event is saved in the same transaction as the recipe, and a relay publishes it after the commit.

</details>

## Further reading

- [It's All a Numbers Game](https://www.youtube.com/watch?v=1KRYH75wgy4): Martin Thompson's GOTO 2012 talk on the queueing maths behind scalable systems.
- [Applying Back Pressure When Overloaded](https://mechanical-sympathy.blogspot.com/2012/05/apply-back-pressure-when-overloaded.html): Thompson's 2012 post, which shows how to size a bounded queue from the latency you can accept.
- [Little's law](https://en.wikipedia.org/wiki/Little%27s_law) and [exponential backoff](https://en.wikipedia.org/wiki/Exponential_backoff): Wikipedia's articles on the two formulas this chapter leans on.
- [Scaling Slack's Job Queue](https://slack.engineering/scaling-slacks-job-queue/): the Redis outage above and the Kafka-based redesign, including how Slack migrated without downtime.
- [Avoiding insurmountable queue backlogs](https://builder.aws.com/content/3EuRcgkTP1MI0c7zM8W6HL3WIqA/avoiding-insurmountable-queue-backlogs): an Amazon Builders' Library article from 2019 on why backlogs turn short outages into long ones.
- [SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) and [SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html): the official limits, including retention of 60 seconds to 14 days (4 days by default).
- [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/): consumer groups and claiming messages from failed consumers. Read the section on persistence and replication before relying on it.
- [RabbitMQ queue length limits](https://www.rabbitmq.com/docs/maxlength) and [resource alarms](https://www.rabbitmq.com/docs/alarms): the broker's own back-pressure tools.
- [Celery periodic tasks](https://docs.celeryq.dev/en/stable/userguide/periodic-tasks.html) and [Sidekiq error handling](https://github.com/sidekiq/sidekiq/wiki/Error-Handling): practical guides to scheduling and automatic retries.
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-status-codes): the HTTP definitions of 202 Accepted and 503 Service Unavailable.
