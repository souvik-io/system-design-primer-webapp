# Design a notification system

Almost every product sends notifications: a one-time login code, "your order shipped", "your friend commented", "presale starts in an hour". Each one is a small message, but the system behind them has to talk to several outside providers, respect what each user agreed to receive, survive provider outages and absorb sudden campaign spikes, all without delaying the login code behind a million marketing emails.

Interviewers like this question because it's mostly about [asynchronous processing](/learn/queues-and-async#how-a-message-queue-works) done carefully. Expect to cover queues, retries, deduplication, [rate limiting](/learn/rate-limiting), scheduling and the messy details of real channels. There's no clever algorithm at the centre, so the marks go to clear separation of concerns and good answers to "what happens when this fails?"

## Requirements and estimates

Pick a concrete product so the numbers mean something. Here, it's an event-ticketing app: people buy concert and sports tickets, follow artists and teams, and get reminders before events.

**Functional**

- Internal services can send a notification to a user, or to an audience such as everyone following an artist.
- Four channels: mobile push (iOS and Android), email, SMS and an in-app inbox.
- Users control which categories they get on which channels. Security messages can't be turned off.
- Templates with per-channel content and localization.
- Scheduled sends, including "10:00 in each user's local time" and "2 hours before the event".
- Status tracking per notification: sent, delivered where the channel reports it, opened or clicked.

**Non-functional**

- Transactional messages (login codes, ticket transfers, event time changes) go out within seconds, even during a campaign.
- Bulk campaigns finish within a target window, say 15 minutes for a presale.
- At-least-once delivery to the provider, with duplicates made rare. You can't fully rule them out, and the deep dive explains why.
- No message sent against a user's preferences or consent.

**Estimates** (assumed, round numbers)

- 40 million monthly users, 12 million daily.
- Daily volume: 60 million push, 60 million in-app, 15 million email and 1.5 million SMS. That's 136.5 million a day in total.
- Average rate: 136,500,000 / 86,400 s ≈ 1,600 per second.
- Peak: a presale announcement to 8 million followers, sent by push and email within 15 minutes. That's 16,000,000 / 900 s ≈ 17,800 per second, on top of normal traffic. **Campaigns, not the average, set the capacity.**
- Storage: about 1 KB per delivery record, so 136.5 million × 1 KB ≈ 137 GB a day. Keeping 90 days is about 137 GB × 90 ≈ 12.3 TB.
- Device tokens: 40 million users × about 1.5 devices = 60 million tokens. At roughly 200 bytes each, that's 12 GB, small enough to cache hot entries.
- SMS cost: at an assumed $0.01 per message, 1.5 million a day is $15,000 a day. Prices vary a lot by country, but the point stands: SMS mistakes cost real money, so dedup and rate limits matter most there.

## API and data model

Producers call one internal API. They never talk to APNs or an email provider directly.

```text
POST /v1/notifications
{
  "idempotency_key": "ticket-transfer-55120-accepted",
  "category": "transactional",            // security | transactional | reminder | social | marketing
  "template": "ticket_transfer_accepted",
  "recipients": { "user_ids": ["u_19"] },
  "data": { "event_name": "...", "seat": "..." },
  "priority": "high",                     // high | normal | bulk
  "send_at": null,                        // or an absolute time
  "expires_at": "2026-05-02T18:00:00Z"    // don't deliver after this
}
-> 202 Accepted { "notification_id": "n_7f3a..." }

POST /v1/campaigns            { audience, template, send_at_local: "10:00", ... }
GET  /v1/notifications/{id}   per-channel status
POST /v1/users/{id}/devices   { platform: "ios", token: "..." }
PUT  /v1/users/{id}/preferences
GET  /v1/users/{id}/inbox?cursor=...
```

The API returns `202` because sending is asynchronous. The `idempotency_key` lets a producer retry safely after a timeout, since the service stores keys for a day and returns the original `notification_id` on a repeat. `expires_at` stops a stale message from going out late. A login code delivered after 20 minutes is worse than none.

Main tables:

| Table | Key | Notable fields |
|---|---|---|
| `contacts` | user_id | email, phone, verified flags, IANA time zone, locale |
| `devices` | device_id (indexed by user_id) | platform, push token, app version, last_seen, active |
| `preferences` | (user_id, category, channel) | enabled, consent source and timestamp |
| `templates` | (template_id, version, channel, locale) | subject, body, status (draft, approved) |
| `notifications` | notification_id | idempotency key, category, template version, data |
| `deliveries` | (notification_id, user_id, channel) | status, provider message id, attempts, timestamps |
| `inbox` | (user_id, created_at) | title, body, link, read_at |

Preferences are stored as overrides on top of per-category defaults, so a new user needs no rows at all. Keep the consent source and time for marketing channels. Laws on marketing consent differ by country, and when a regulator asks, you need to show why a user got a message.

## High-level design

```diagram
title: Producers hand off to one service. A router applies preferences and limits, then each channel has its own queue and workers
[svc:client] Producer\nservices @ 0,1.5
[api] Notification\nservice @ 1,1.5
[sch:store] Scheduled\nsends @ 1,3
[pref:store] Prefs, tokens,\ntemplates @ 2,0
[rt] Router @ 2,1.5
[qp:queue] Push queue @ 3,0
[qi:queue] In-app queue @ 3,1
[qe:queue] Email queue @ 3,2
[qs:queue] SMS queue @ 3,3
[wp] APNs / FCM @ 4,0
[wi] Inbox +\nlive socket @ 4,1
[we] Email\nprovider @ 4,2
[ws] SMS\nprovider @ 4,3
svc -> api : send
api --> sch : later
sch --> rt : due
api -> rt
rt -> pref
rt -> qp
rt -> qi
rt -> qe
rt -> qs
qp -> wp
qi -> wi
qe -> we
qs -> ws
```

1. **Notification service.** It validates the request, checks the idempotency key, writes the `notifications` row and returns `202`. Future sends go to the scheduler. Audience sends become a fan-out job that pages through the audience in batches (say 1,000 users at a time) and emits one task per user.
2. **Router**, per user. It loads preferences and contact details (from cache, backed by the tables), drops channels the user has opted out of, applies per-user rate limits and quiet hours, picks the template version and locale, and enqueues one message per channel. Anything dropped is recorded as `suppressed`, with the reason, so "why didn't I get it?" has an answer.
3. **Channel queues and workers.** Each channel has its own queue and worker pool. Workers render the template, call the provider, and record the result.
4. **Tracking.** Provider callbacks (email bounces, SMS delivery receipts) and app events (push opened, inbox read) go to a tracking service, which updates `deliveries` and feeds analytics.

Why a separate queue per channel? **Isolation.** If the SMS provider slows down or goes out, SMS messages back up in their own queue while push and email carry on. Each pool also scales and retries according to its provider's rules.

### Channels in brief

- **Push.** You send to Apple Push Notification service (APNs) or Firebase Cloud Messaging (FCM), addressed by a device token the app registered with your backend. Payloads are small, about 4 KB. A success response means the provider *accepted* the message, not that the phone showed it. When a device is offline, APNs keeps only the most recent notification per app, and FCM holds a limited number. Use collapse keys (`apns-collapse-id`, FCM's `collapse_key`) for messages where only the latest matters, such as "gate changed". When a provider reports a token as unregistered or invalid, deactivate it right away. Stale tokens waste capacity on sends that can never arrive.
- **Email.** You send through a provider or your own mail servers, with SPF, DKIM and DMARC set up so mail isn't marked as spam. Bounce and complaint webhooks feed a **suppression list**, so you never retry a hard-bounced address. Bulk mail needs a `List-Unsubscribe` header with one-click unsubscribe ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058)), which Gmail and Yahoo now require from bulk senders.
- **SMS.** You send through an aggregator. It's expensive. A single message holds 160 GSM-7 characters (70 if it needs Unicode), and longer texts are split into several segments that are each billed. Delivery receipts depend on carriers and are patchy. Honour STOP replies. Sender rules and quiet-hour laws vary by country. Public endpoints that trigger SMS, like "send me a login code", attract fraud that pumps traffic to premium numbers, so they need strict limits.
- **In-app.** Write a row to the user's inbox, increment their unread count, and if they're online, push it over their live connection (see [real-time updates](/learn/realtime)). This is the cheapest channel and the only one you fully control.

## Queues, retries and priority

### Priority versus bulk

A presale campaign puts 16 million messages on the push and email queues within minutes. If a login code joins the back of that queue, the user waits 15 minutes and gives up. So split by priority as well as channel:

- **High**: security codes, ticket transfers, event changes. Small volume, strict latency.
- **Normal**: reminders and social notifications.
- **Bulk**: campaigns and digests.

Give each priority its own queue, or topic, per channel, with dedicated or weighted consumers, so bulk can never starve high. How you build this depends on the broker. With Kafka you'd use separate topics, since a partition is strictly ordered and has no notion of priority. RabbitMQ supports priority queues natively, but separate queues are still easier to reason about and to scale independently. Bulk consumers also run behind a token bucket set below the provider's quota, so a campaign never uses up the quota that high-priority traffic needs.

### Retries

Classify every provider response:

- **Success**: record `sent`, with the provider's message id.
- **Transient** (timeouts, 5xx, 429 rate limited): retry with exponential backoff and jitter, and honour `Retry-After` when the provider sends it. Cap the attempts, and stop retrying once `expires_at` has passed.
- **Permanent** (invalid token, hard bounce, invalid number): don't retry. Record `failed` and clean up the token or address.

Messages that use up their retries go to a dead-letter queue for inspection, not a loop. [Reliability patterns](/learn/reliability-patterns) covers backoff, jitter and circuit breakers. A circuit breaker per provider stops thousands of workers hammering a provider that's already down.

### Deduplication

Queues deliver at least once, so the same message can reach a worker twice. A worker can also crash after the provider accepted a message but before it recorded the fact. Defences, in layers:

1. **At the API**: the idempotency key turns producer retries into no-ops.
2. **Per send**: each message has a deterministic dedup key, `notification_id + user_id + channel`. Before calling the provider, the worker does a conditional write that moves the delivery row from `queued` to `sending`, and only one worker can win. A crashed `sending` row is retried only after a timeout.
3. **At the provider**: most providers won't deduplicate for you, though collapse keys on push at least replace duplicates on the device.

There's still a small window between "provider accepted" and "we recorded it" where a crash causes a duplicate. True exactly-once delivery to a phone isn't possible across systems you don't control, so say so in the interview and keep the window small.

### Rate limiting per user

These limits protect users, not just servers:

- Caps per category, for example at most 3 marketing pushes per user per day, and at most 1 SMS login code per number per 30 seconds and 10 per day.
- **Digests**: instead of 12 "a friend bought tickets" pushes in an hour, hold social notifications briefly and send "5 friends are going to Saturday's show".
- Quiet hours in the user's local time. Non-urgent messages wait until the window ends, while security codes ignore it.

A sliding-window counter per user and category in Redis is enough. See [rate limiting](/learn/rate-limiting) for the algorithms.

## Scheduling, time zones and tracking

### Scheduled sends

"Send at 10:00 local time" means a different UTC instant for each user. Store each user's IANA time zone (such as `Asia/Kolkata`, never a fixed offset, because daylight saving time changes offsets). Then compute each user's send time in UTC when you expand the campaign. Local times span from UTC−12 to UTC+14, so a "10:00 local" campaign naturally spreads over about 26 hours, which conveniently flattens the load.

Store scheduled sends bucketed by minute. A scheduler claims due rows and hands them to the router. In PostgreSQL, `SELECT … FOR UPDATE SKIP LOCKED` lets several scheduler instances claim rows without blocking each other. A delay queue is another option, but check the limits: Amazon SQS, for example, can delay a message by at most 15 minutes, so it can't hold "next Tuesday" on its own.

Watch for daylight-saving edge cases. 02:30 local may not exist on the spring-forward day, and in autumn an hour repeats (02:30 happens twice in central Europe, 01:30 in the US). Use a time zone library's rules for both cases and test them.

Relative schedules ("2 hours before the event") must follow the event. If the concert moves, the reminder must move too, so key scheduled reminders by event id, not just by time.

### Tracking delivery and opens

```diagram
title: The life of one delivery. Each step is recorded so support and analytics can see where it stopped
[req] Requested @ 0,0
[sup:note] Suppressed\n(prefs, limits) @ 0,1
[q] Queued @ 1,0
[rt:queue] Retry with\nbackoff @ 1,1
[sent] Sent\n(provider ok) @ 2,0
[fail:note] Failed\n(permanent) @ 2,1
[del] Delivered @ 3,0
[open] Opened or\nclicked @ 4,0
req -> q
req -> sup
q -> sent : accepted
q <-> rt : transient
q -> fail
sent -> del : receipt
del -> open
```

Each status change is an event appended to a log (Kafka works well here), which feeds two consumers: the `deliveries` row for per-message status, and a columnar analytics store for campaign metrics.

How much you can trust each step varies by channel. "Delivered" is solid for in-app, available from some SMS carriers, and mostly absent for push. Your own app can report "received" and "opened" back with the notification id. Email opens are counted with a tracking pixel, and they're unreliable. Some mail clients, notably Apple Mail with Mail Privacy Protection, load images automatically, which inflates open counts. Clicks, tracked through redirect links, are a more honest engagement signal. Feed engagement back into sending: stop marketing email to addresses that haven't opened or clicked in months, which also protects your sender reputation.

## Scaling and bottlenecks

- **Campaign fan-out.** Expanding 8 million followers is a batch job. Page through the follower index by cursor, emit batches onto the bulk lane, and checkpoint progress so a crash resumes instead of restarting and sending everything twice.
- **Router lookups.** At 17,800 recipients per second, the router can't hit the database for every preference and token. Cache preferences and contacts per user with short TTLs, and invalidate on change. An opt-out must take effect quickly, so keep the TTL to minutes.
- **Provider throughput.** Each provider enforces its own quotas and rates. Keep long-lived connections open (APNs uses HTTP/2, and many requests can share one connection), use the providers' batch APIs where they have them, and size worker pools to the quota, not to your queue depth.
- **Backlogs.** When a provider slows down, its queue grows. Monitor queue depth and, better, the age of the oldest message per lane (see [observability](/learn/observability)), and alert when high-priority age goes past seconds. Apply [back pressure](/learn/queues-and-async#back-pressure-when-the-queue-keeps-growing) to bulk producers before the queues fill up.
- **Storage.** Partition `deliveries` and `inbox` by user_id so reads for one user stay on one shard, and expire rows after 90 days. Write analytics events to a time-partitioned store, kept separate from operational tables.
- **Multiple regions.** Run the pipeline in each region for latency and resilience, but keep each user's preferences in one home region (or replicate them strongly), so an opt-out in one region can't be missed by another.

## Trade-offs to discuss

- **Render early or late.** Rendering in the router fixes the content at enqueue time, which suits audits, but makes queue messages bigger. Rendering in the worker keeps messages small and picks up template fixes, but a template edited mid-campaign could change content halfway through, so pin the template version on the notification either way.
- **At-least-once versus at-most-once.** At-least-once with dedup means rare duplicates. At-most-once means rare silent losses. For login codes and ticket transfers, a rare duplicate is the lesser evil. For a marketing blast, you might accept the opposite.
- **Kafka versus a task queue.** Kafka gives high throughput, replay and ordering per partition, but per-message delays and retries are awkward, so you'd build retry topics. SQS or RabbitMQ give per-message acknowledgement, visibility timeouts and delays out of the box, but no replay. Many systems use Kafka for events and tracking, and a task queue for the send lanes.
- **Fallback channels.** "If push isn't opened in 10 minutes, send SMS" improves reach for critical messages but costs money and risks a double notification. Limit it to a few categories.
- **Batching versus immediacy.** Digests reduce fatigue and cost, but they add delay. Only do it for categories where minutes don't matter.
- **Build versus buy.** Hosted notification platforms handle templates, preferences and provider integrations. You trade control and per-message cost for time to market. In an interview, build it, but mention the option.

## Check yourself

<details>
<summary>During a 10-million-user campaign, users report that login codes take several minutes to arrive. What's the likely cause in this design, and what's the fix?</summary>

Login codes are probably sharing a queue, workers or provider quota with the campaign, so they wait behind bulk traffic. Give high-priority traffic its own queue per channel with dedicated workers, and put bulk consumers behind a token bucket below the provider quota, leaving room for high-priority sends. Also alert on the age of the oldest message in the high-priority lane, so you catch this before users do.

</details>

<details>
<summary>An email worker crashes after the provider returns 200 but before it records `sent`. What happens next, and how do you keep this from spamming users?</summary>

The queue redelivers the message, and another worker may send it again, causing a duplicate. The conditional `queued → sending` write stops two workers sending in parallel. But a row stuck in `sending` after a crash has to be retried eventually, so a small duplicate window remains. Keep it small by recording right after the provider call and setting a sensible timeout before retrying `sending` rows. For truly sensitive messages, accept the rare duplicate rather than risk losing the message.

</details>

<details>
<summary>A campaign is scheduled for "09:00 local" to users across India, Germany and California. Roughly how is the send load spread in UTC, and what could go wrong around daylight saving time?</summary>

India (UTC+5:30) sends at 03:30 UTC, Germany at 07:00 or 08:00 UTC depending on daylight saving, and California at 16:00 or 17:00 UTC. So the load arrives in three separate waves, not one spike. If you store fixed offsets instead of IANA zones, users in Germany or California will get it an hour off after the clocks change. Always compute from the zone name at expansion time.

</details>

<details>
<summary>Estimate how many SMS workers you need if the provider allows 100 requests per second per connection, each worker holds one connection, and SMS peak is 600 per second. What else limits you?</summary>

At 600 / 100 = 6 workers at full use, so run 8–10 to leave headroom for retries and slow responses. The real ceiling is usually the provider's account-level throughput, plus per-country or per-sender-number limits, which no number of workers gets around. Spread traffic across approved sender numbers or short codes where the rules allow, and make sure per-user limits stop runaway retries from burning money.

</details>

<details>
<summary>A user turns off marketing push, but receives one 30 seconds later. Where in the pipeline could this happen, and is it acceptable?</summary>

The message was probably already past the router, either sitting in the push queue or rendered by a worker, before the preference change landed. Or the router read a cached preference that hadn't expired yet. Re-checking preferences in the worker just before sending closes most of the gap, at the cost of one more lookup per message. A short window is usually acceptable for marketing, but invalidate caches on change and keep the window to seconds.

</details>

## Further reading

- [Apple: Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns): headers such as `apns-collapse-id` and `apns-expiration`, plus response codes.
- [Firebase Cloud Messaging: collapsible and non-collapsible messages](https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types): when the provider replaces a waiting message instead of queuing another. Pages next to it cover priority and time to live.
- [RFC 8058: Signaling one-click functionality for list email headers](https://www.rfc-editor.org/rfc/rfc8058): the one-click unsubscribe header.
- [Google: Email sender guidelines](https://support.google.com/a/answer/81126): authentication and unsubscribe requirements for bulk senders.
- [PostgreSQL: SELECT, the locking clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE): `FOR UPDATE SKIP LOCKED` for job claiming.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design a notification system".
- [System Design School primer](https://systemdesignschool.io/primer): "Buffer with Message Queues" and "Message Queues".
