# Design a video streaming platform

A video platform lets creators upload videos and lets viewers watch them on anything from a phone on a train to a living-room TV. The upload side is a batch pipeline that turns one large source file into dozens of smaller ones. The watch side is almost entirely a content delivery problem: moving a very large number of bytes to viewers cheaply, without stalls.

Interviewers like this question because the interesting parts aren't in the web tier. They're in how you get multi-gigabyte files in reliably, how you split transcoding into parallel work, how adaptive bitrate streaming actually works, and why bandwidth cost shapes the architecture. It builds on the primer's [CDN](/learn/content-delivery-network) and [asynchronism](/learn/asynchronism) chapters.

## Requirements and estimates

Scope:

- **Functional:** creators upload videos up to a few hours long; the platform transcodes them and publishes them; viewers browse, watch with smooth quality switching, and see view counts.
- **Non-functional:** playback starts within a couple of seconds and rarely stalls; uploads survive flaky connections; a published video is never lost; processing a typical video takes minutes, not hours.
- **Out of scope:** live streaming, recommendations, comments, monetization. Mention them, then set them aside.

The numbers below are assumptions for a mid-to-large platform, chosen to keep the arithmetic readable.

### Watching

- 40 million daily viewers, each watching 45 minutes a day.
- Average delivered bitrate of 3 Mbps across phones, laptops and TVs.
- Average concurrent viewers: 40M × 45 min ÷ 1,440 min a day = **1.25 million**.
- Average egress: 1.25M × 3 Mbps = 3.75 Tbps. With an evening peak of about 2.5× average, that's roughly **9 Tbps**.
- Bytes a day: 3.75 × 10¹² bits/s × 86,400 s = 3.24 × 10¹⁷ bits ≈ 4.05 × 10¹⁶ bytes, about **40 PB a day**.

### Uploading

- 500,000 new videos a day, averaging 8 minutes.
- Source files average 10 Mbps: 8 × 60 s × 10 Mbps = 4,800 Mb = 600 MB each.
- Raw uploads: 500K × 600 MB = **300 TB a day**, or 300 TB ÷ 86,400 s ≈ 3.5 GB/s ≈ 28 Gbps of ingress.
- Transcoded output: if the rendition ladder below adds up to about 10 Mbps, roughly the source bitrate, the outputs are about the same size as the inputs: another 300 TB a day per codec.
- Total new storage: about 600 TB a day, or roughly 220 PB a year before replication.

The headline is the ratio. Egress (about 40 PB a day) is over a hundred times ingress (300 TB a day). Read bandwidth is the dominant cost, so the design should spend money on the write side, like extra encoding work, if it saves bytes on the read side. [Estimation](/learn/estimation) covers this kind of reasoning.

## API and data model

Uploads use a short REST handshake; the bytes themselves bypass your servers:

```http
POST /videos                         -> {video_id, upload_id, part_urls[]}
POST /videos/{id}/upload:complete    {upload_id, parts: [{n, etag}]}
GET  /videos/{id}                    -> metadata, status, thumbnails
GET  /videos/{id}/play               -> {manifest_url, license_url?}
POST /videos/{id}/views              {session_id, position}
```

`GET /play` returns the URL of a manifest on the CDN, not the video. The player fetches everything else from the CDN.

The main records:

| Record | Store | Notes |
|---|---|---|
| `videos` | Sharded relational DB | id, owner, title, duration, status (`uploading`, `processing`, `ready`, `blocked`), visibility |
| `renditions` | Same DB | video_id, codec, resolution, bitrate, manifest path |
| `jobs` / `tasks` | Workflow store | DAG state per video, retries, timings |
| `view_counts` | Counter store | Aggregated, updated in batches |
| Source and segments | Object storage | Immutable files addressed by path |

Metadata is small, relational and read-heavy, so a sharded SQL database with a cache in front works well. YouTube built Vitess to scale its MySQL databases this way. The video files go in object storage, never in the database, the same split the primer's [Pastebin design](/learn/design-pastebin) makes for paste contents.

## High-level design

```diagram
title: Upload and processing path
[creator:client] Creator app @ 0,0
[api] Upload API @ 1,0
[meta:store] Metadata DB @ 2,0
[raw:store] Raw uploads\n(object store) @ 1,1
[sched] Workflow\nscheduler @ 2,1
[q:queue] Task queues @ 3,1
[workers] Workers @ 4,1
[out:store] Segments and\nmanifests @ 4,2
creator <-> api : create, complete
creator -> raw : PUT parts
api -> meta
raw --> sched : upload done
sched -> meta : status
sched -> q
q -> workers
workers -> out
```

```diagram
title: Playback path
[player:client] Player @ 0,0
[edge] CDN edge @ 1,0
[mid] Regional\ncache @ 2,0
[origin:store] Origin\n(object store) @ 3,0
[papi] Playback API @ 1,1
[mdb:store] Metadata\nand cache @ 2,1
player -> edge : segments
edge -> mid : miss
mid -> origin : miss
player -> papi : play
papi -> mdb
```

### Uploads with pre-signed URLs

Pushing 600 MB through your API servers wastes their bandwidth and ties up connections for minutes. Instead:

1. The client calls `POST /videos`. The API creates a `videos` row with status `uploading`, starts a multipart upload in object storage, and returns **pre-signed URLs**, one per part. A pre-signed URL is a link signed with the service's credentials that allows exactly one kind of operation (here, a PUT to one part of one object) until it expires. It isn't single-use: anyone holding it can repeat that operation until then.
2. The client splits the file into parts and uploads them directly to object storage, several at a time.
3. If the connection drops, the client retries only the parts that failed. If the app restarts, it asks the API which parts already arrived and resumes from there. That makes the upload **resumable**.
4. The client calls `complete` with the list of parts. Object storage stitches them into one object and emits an event, which starts processing.

Part sizes depend on the store. Amazon S3, for example, requires parts of at least 5 MiB except the last, and allows up to 10,000 parts per upload. Choose part sizes so a large file stays well under the part limit and a failed part is cheap to retry. If you'd rather not depend on one vendor's multipart API, the open tus protocol defines resumable uploads over plain HTTP.

The trade-off is that the API no longer sees the bytes, so validation happens afterward in the pipeline. Treat every upload as untrusted until it has been probed.

## The transcoding pipeline

A source file arrives in whatever format the creator's camera or editor produced. The pipeline turns it into a set of renditions every player can handle, plus thumbnails and captions. It's naturally a **directed acyclic graph** of tasks:

```diagram
title: Tasks for one video; branches run in parallel
[probe] Probe and\nvalidate @ 0,1
[enc] Split and\nencode chunks @ 1,1
[pack] Package\nHLS / DASH @ 2,1
[pub] Publish @ 3,1
[side] Thumbnails,\ncaptions @ 1.5,0
[scan] Safety scan @ 1.5,2
probe -> enc
enc -> pack
pack -> pub
probe -> side
side -> pub
probe -> scan
scan -> pub
```

- **Probe and validate:** read the container, codecs, duration and resolution. Reject corrupt or unsupported files early, before spending compute on them.
- **Split:** cut the video into chunks of a few seconds at keyframe boundaries. Each chunk can then be encoded independently on a different worker. A 2-hour film becomes thousands of small tasks that finish in minutes instead of one task that takes hours.
- **Encode:** for each chunk, produce each rung of the bitrate ladder. All renditions must put keyframes at the same timestamps, so the player can switch between them at any segment boundary.
- **Package:** join the encoded chunks into streaming segments and write the manifests.
- **Side tasks:** thumbnails, speech-to-text captions and safety checks run in parallel with encoding, because they only depend on the probed source.
- **Publish:** flip the status to `ready` and make the manifest URL live.

How to run it:

- A **workflow scheduler** holds each video's DAG and enqueues a task when all its inputs are done. Workers pull tasks from [task queues](/learn/asynchronism#task-queues), process them, write outputs to object storage and report completion. Off-the-shelf engines (Temporal, AWS Step Functions, Airflow) or a hand-built scheduler on a queue all fit.
- **Tasks are idempotent.** A task writes its output to a deterministic path, so a retry after a worker crash overwrites the same file instead of creating a duplicate. Queues deliver at least once, so this matters.
- **Separate queues by work type and priority.** Encoding needs CPU or GPU machines, captions may need GPUs, and thumbnails are cheap. Short videos and paying creators can go in a higher-priority queue. When a queue grows, scale its workers, and apply [back pressure](/learn/asynchronism#back-pressure) to uploads only as a last resort.
- **Publish early.** Encode the low and medium rungs first and mark the video watchable as soon as they're packaged. The 1080p and 4K rungs fill in later.

## Adaptive bitrate streaming

A viewer's bandwidth changes from second to second. Adaptive bitrate (ABR) streaming handles this by encoding the video at several quality levels, cutting each into short segments, and letting the player choose a level for each segment.

An example ladder (assumed values; real ladders vary by content):

| Rendition | Resolution | Video bitrate |
|---|---|---|
| 240p | 426×240 | 0.4 Mbps |
| 360p | 640×360 | 0.8 Mbps |
| 480p | 854×480 | 1.4 Mbps |
| 720p | 1280×720 | 2.8 Mbps |
| 1080p | 1920×1080 | 5.0 Mbps |

That ladder adds up to 10.4 Mbps, which is where the "about 10 Mbps of output" in the estimate came from.

The two main formats are **HLS** (HTTP Live Streaming, from Apple, published as RFC 8216) and **MPEG-DASH** (an ISO standard). Both work the same way:

- Each rendition is a sequence of segments, typically 2 to 6 seconds each.
- A **media playlist** (HLS) or a section of the **MPD** (DASH) lists one rendition's segments in order.
- A **master playlist** (HLS) or the MPD lists the renditions with their bandwidth and resolution.

A trimmed HLS master playlist:

```text
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3100000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080
1080p/index.m3u8
```

`BANDWIDTH` is the peak bitrate in bits per second, including audio and container overhead, which is why it's a little above the video bitrate in the table.

The player downloads the master playlist, picks a starting rendition, and then fetches segments over ordinary HTTP. Before each segment, it looks at its recent download throughput and how many seconds of video are buffered, and moves up or down the ladder. Because everything is plain HTTP GETs of immutable files, every segment is cacheable by any CDN, which is the main reason HTTP-based streaming displaced older stateful protocols such as RTMP for delivery.

Practical notes:

- **CMAF** (fragmented MP4 segments) lets one set of segment files serve both HLS and DASH players. Without it you might store each rendition twice (MPEG-TS segments for older HLS players, fMP4 for DASH), doubling storage and splitting cache space between two copies.
- **Shorter segments** let the player adapt faster and start sooner, at the cost of more requests and slightly worse compression.
- **Per-title encoding.** A static lecture needs far fewer bits than a fast sports clip to look good. Netflix has written about choosing a ladder per title from its complexity. It costs more analysis per video and saves bandwidth on every view.

## Scaling and bottlenecks

### CDN delivery and cost

At around 9 Tbps peak, nearly all playback traffic must come from CDN caches, and egress is the largest bill. To make the cost concrete, suppose a blended delivery price of $0.005 per GB. That number is made up for the arithmetic; real contracts vary widely with volume. Then 40 PB a day is 40 × 10⁶ GB × $0.005 = **$200,000 a day**. Every percent of bitrate you save is worth $2,000 a day.

Popularity is heavily skewed: a small share of videos gets most of the views, and a long tail is rarely watched. That changes how you treat each:

- **Popular videos** stay hot in edge caches with very high hit rates. Spend extra encoding effort on them: more efficient codecs such as VP9, HEVC or AV1, and per-title ladders. The encoding cost is paid once and the savings repeat on every view.
- **Long-tail videos** mostly miss at the edge. A tiered setup (edge, then regional cache, then origin) keeps origin load manageable. You can also skip some renditions or codecs until a video proves popular, and transcode them on demand. Store rarely watched sources and renditions in a cheaper storage class; Facebook's f4 paper describes moving older, less-read files to erasure-coded "warm" storage to cut storage overhead.
- **Pre-positioning.** For predictable spikes, like a big premiere, push content to edges ahead of time instead of letting the first viewers fault it in. See [push vs pull CDNs](/learn/content-delivery-network#push-cdns).
- **Owning the edge.** At very large scale, platforms place their own cache servers inside ISP networks; Netflix's Open Connect program is the best-known example. It trades capital and operational cost for lower per-byte cost and better performance.

### Other bottlenecks

- **Metadata reads** for a popular video page are cached aggressively; the metadata DB mostly sees writes and cache misses. See [cache](/learn/cache#application-caching).
- **View counts.** At 10 views per viewer a day (an assumption), that's 400 million views a day, about 4,600 a second on average, concentrated on a few hot videos. Incrementing a row per view makes those rows a bottleneck. Instead, send view events to a stream, filter out duplicates and bots, aggregate per video per minute, and add the aggregates to the stored count. The displayed count lags by minutes, and nobody minds. [Event streaming](/learn/event-streaming) covers the pipeline.
- **Transcoding capacity** follows upload volume, which peaks on weekends and around events. Workers that scale with queue depth, and spot or preemptible machines for low-priority work, keep costs down.
- **Hot origin objects.** If a video goes viral before edges have it, many edges miss at once. Request collapsing in the regional tier (one origin fetch per object, shared by waiting requests) protects origin.

### DRM and safety

Mention both and keep moving unless the interviewer digs in:

- **DRM:** segments are encrypted (the Common Encryption standard can let one encrypted file work with several DRM systems), and players get keys from a license server after an entitlement check. Widevine, FairPlay and PlayReady cover most devices. The pipeline gains an encryption step, and `GET /play` returns a license URL.
- **Safety:** the pipeline runs hash matching against known illegal content, classifiers for policy violations, and copyright fingerprinting before or shortly after publishing. Decide which checks block publishing and which run after; that's a latency vs risk trade-off.

## Trade-offs to discuss

- **More renditions and codecs vs storage and compute.** Each extra rung or codec improves playback for some viewers and multiplies storage. Popularity-based encoding puts the cost where it pays back.
- **Segment length:** faster adaptation and startup vs more requests and slightly larger files.
- **Publish speed vs completeness:** publishing after the low rungs makes videos available sooner, while a 4K viewer briefly sees lower quality.
- **Pre-signed direct uploads vs proxying through the API:** far less load on your servers vs less control during the upload, so validation moves into the pipeline.
- **Third-party CDN vs your own edge:** pay per byte and move fast, or invest in your own infrastructure once volume justifies it.
- **Exact vs approximate view counts:** exact counting is expensive at hot keys; batched, slightly delayed counts are usually fine.

## Check yourself

<details>
<summary>A creator on hotel Wi-Fi uploads a 4 GB file and the connection drops at 3.1 GB. What happens in your design?</summary>

The file was being sent as many independent parts to pre-signed URLs, so the parts that completed are already stored. When the app reconnects, it asks the API which parts have arrived, requests fresh pre-signed URLs if the old ones expired, and uploads only the missing parts. Then it calls `complete`. Nothing is re-sent from the beginning, and the API servers never carried the bytes.

</details>

<details>
<summary>Why must every rendition have keyframes at the same timestamps?</summary>

The player switches renditions at segment boundaries, and each segment must start with a keyframe so it can be decoded without earlier data. If the 480p and 720p segments started at different times, switching would leave a gap or overlap and a visible glitch. Aligned keyframes, set during encoding, make segment N of every rendition cover the same time span.

</details>

<details>
<summary>Your encoding team says AV1 cuts bitrate by a meaningful amount at the same quality but costs several times more compute to encode. Should you encode everything in AV1?</summary>

Not everything. The encoding cost is paid once per video, while the bandwidth savings are paid back on every view, so it pays off only for videos that get enough views, and only for viewers whose devices can decode AV1. A common policy is to encode a widely supported codec for everything and add the more efficient one once a video crosses a popularity threshold. Use the estimate to find roughly where the break-even point is.

</details>

<details>
<summary>A worker crashes halfway through encoding chunk 37 of a film. How does the pipeline recover without corrupting the output?</summary>

The task was never marked complete, so after its visibility timeout or lease expires, the queue hands it to another worker. Because the task writes to a deterministic path (for example `video/720p/chunk-37`), the retry overwrites any partial output instead of creating a second copy. The packaging task only starts when the scheduler sees all chunks complete, so it never reads a half-written chunk.

</details>

<details>
<summary>Long-tail videos make up most of your catalog but few of your views. Name two ways to cut what they cost you.</summary>

Store them more cheaply: move older, rarely watched sources and renditions to a cheaper storage class or erasure-coded storage. And don't produce what nobody watches: skip high rungs or extra codecs for new videos until they get views, and transcode on demand if someone does ask. Both trade a little latency for a rare viewer against a lot of storage and compute.

</details>

## Further reading

- [RFC 8216: HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216): the HLS playlist format, including what `BANDWIDTH` means.
- [Apple HTTP Live Streaming](https://developer.apple.com/streaming/): Apple's HLS tools and authoring guidance.
- [Uploading and copying objects using multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) (Amazon S3): part limits, retries and completing uploads.
- [tus resumable upload protocol](https://tus.io/protocols/resumable-upload): an open protocol for resumable uploads over HTTP.
- [Per-title encode optimization](https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2) (Netflix): why one bitrate ladder doesn't fit every video.
- [Netflix Open Connect](https://openconnect.netflix.com/): a streaming company's own CDN, placed inside ISP networks.
- [f4: Facebook's warm BLOB storage system](https://www.usenix.org/conference/osdi14/technical-sessions/presentation/muralidhar) (OSDI 2014): storing rarely read media cheaply.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design YouTube".
- [System Design School primer](https://systemdesignschool.io/primer): "Object Storage", "CDN" and "Buffer with Message Queues".
