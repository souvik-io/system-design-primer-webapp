# Design an image generation service (text to image, like Midjourney or DALL·E)

An image generation service turns a prompt such as "a lighthouse in a storm, ink wash style" into a grid of four pictures. It also edits uploaded images, repaints masked regions and enlarges a chosen picture. Consumers use a web and mobile app, and developers call the same engine through an API.

An image model spends seconds of GPU work and has nothing usable until the end, so the design is a job queue with GPU workers behind it. It builds on [GPUs for AI](/learn/gpus-for-ai), [running inference at scale](/learn/inference-fleets), [estimating AI workloads](/learn/ai-estimation) and [queues and async work](/learn/queues-and-async). Multi-tenant admission control is covered in the [model inference platform](/learn/design-inference-platform#admission-control-and-fairness) question.

## How a diffusion model makes an image

Unlike the token-by-token models in the LLM chapters, most image models are **diffusion models**. They start from random noise and remove some of it in each of many **denoising steps**, guided by the prompt. Five ideas are enough for the design:

- **Latent space and the VAE decoder.** The steps run on a compressed copy of the image called a latent, a 128×128 grid with 4 channels for a 1024×1024 image. A variational autoencoder (VAE) converts between pixels and latents, and its decoder turns the final latent into pixels once, at the end.
- **The text encoder** turns the prompt into vectors that every step reads. It runs once per request.
- **The denoiser** is the large network that predicts the noise in the current latent. One call of it is an **evaluation**.
- **Classifier-free guidance (CFG)** evaluates the denoiser twice per step, with and without the prompt, and pushes the result away from the unprompted answer by a guidance scale such as 6. Images follow the prompt more closely, and each step costs twice as much.
- **Distilled few-step models** imitate the full model in 1 to 4 steps, usually with guidance built in, at some cost in quality and variety.

## Requirements and estimates

### Scope

- **Functional:** text to image at 1024×1024 (plus four other shapes of about one megapixel), four images per request, previews while they form, image-to-image edits and inpainting (repainting a masked area), 2× upscale, style presets, a gallery with history, and a developer API with webhooks.
- **Tiers:** free users get relaxed mode only, a slower queue, with a daily cap. Paid users get monthly fast credits plus unlimited relaxed mode. API customers pay per image and use the fast queue.
- **Safety and provenance:** a check on every prompt before GPU work and on every image before anyone sees it, plus a signed C2PA manifest and an invisible watermark on each output.
- **Non-functional:** fast mode returns four images within 15 seconds at p95 (the 95th percentile), with a first preview soon after the job starts. Paid relaxed jobs finish within 10 minutes at p95. Free jobs are best effort and may be refused at peak. An accepted job is never lost.
- **Out of scope:** training, video, and ranking for a public feed.

### Traffic

These numbers are invented. There are 2 million daily active users, 10% of them paid. Free users run 2 jobs a day and paid users 15, and the API adds 1.4 million.

- Free 1.8 million × 2 = 3.6 million, paid 200,000 × 15 = 3.0 million, API 1.4 million: **8 million jobs a day**, 80% text to image, 10% edits and 10% upscales.
- 8,000,000 ÷ 86,400 ≈ 92.6 jobs a second on average. With an assumed peak factor of 2.5, about **231 a second** at peak.
- Half of paid jobs use fast mode, so fast carries 1.5 + 1.4 = **2.9 million jobs a day** and relaxed carries 3.6 + 1.5 = **5.1 million**.

### GPU time per image

The model class is an SDXL-sized latent diffusion model of about 3.5 billion parameters, about 7 GB of weights in 16-bit numbers. The timing is an **assumption** to replace with profiling: on one H100 at 1024×1024, a denoising step costs 8 ms of fixed overhead plus 17 ms per evaluation in the batch. The VAE decode takes 60 ms per image and the text encoder 10 ms per request (also assumptions).

A full request has 4 images × 2 evaluations (CFG) = 8 evaluations per step. One step takes 8 + 17 × 8 = 144 ms, and 30 steps take 4,320 ms. Adding 4 × 60 = 240 ms of decode and 10 ms of text encoding gives **4.57 GPU-seconds per request, 1.14 per image**. At $3 an hour that is $0.00095 per image if the GPU never idles. In general, GPU time ≈ steps × evaluations per step × time per evaluation, plus decode. Turning guidance off cuts a request to 2.53 GPU-seconds, a 4-step distilled model without guidance to 0.55, and time per evaluation grows roughly with pixel count, so a 512×512 draft costs about a quarter as much per evaluation.

An edit at strength 0.6 runs the last 60% of the schedule (18 steps) after encoding the source image (40 ms, assumed): 18 × 144 + 240 + 40 + 10 = 2,882 ms. A 2× upscale enlarges the image and refines it with 15 steps over four 1024×1024 tiles batched with CFG: 15 × 144 + 240 = 2,400 ms. The average job is 0.8 × 4.57 + 0.1 × 2.88 + 0.1 × 2.40 ≈ **4.18 GPU-seconds**.

### GPUs and cost

- All jobs: 8 million × 4.18 ≈ 33.5 million GPU-seconds a day, about 387 GPUs busy on average and 969 at peak.
- Fast mode: 2.9 million × 4.18 ÷ 86,400 ≈ 140 busy GPUs on average, 351 at peak. Planned at 75% utilization to leave room for bursts and failures, the peak needs 351 ÷ 0.75 ≈ **469 H100s**.
- Relaxed mode: 5.1 million × 4.18 ÷ 86,400 ≈ 247 busy GPUs on average, 617 at peak. Its jobs can wait, so it runs near 90% utilization on spot GPUs.
- Output: 6.4 million × 4 + 0.8 million × 4 + 0.8 million × 1 = **29.6 million images a day**.

If fast capacity tracks the daily curve at 75% utilization, it uses 140 ÷ 0.75 × 24 ≈ 4,494 GPU-hours a day, $13,480 at $3 an hour, against $33,700 for holding 469 GPUs all day. Relaxed mode uses 247 ÷ 0.9 × 24 ≈ 6,586 GPU-hours, $7,900 at an assumed spot price of $1.20 an hour. Per image, fast costs $13,480 ÷ 10.73 million ≈ **$0.0013** and relaxed $7,900 ÷ 18.87 million ≈ **$0.0004**, about $640,000 a month in all.

### Storage and egress

Assumed sizes: a 1024×1024 PNG is 1.5 MB, a WebP display copy 250 KB and a thumbnail 20 KB. An upscaled 2048×2048 image is 6 MB as PNG and 1 MB as WebP.

- New data: 28.8 million × 1.77 MB + 0.8 million × 7.02 MB ≈ 51.0 + 5.6 = **56.6 TB a day**, 20.7 PB a year if everything is kept.
- Retention: keep every PNG for 30 days (1.3 PB at any time), then only for the 10% of images a user downloaded, upscaled, favourited or published (1.58 PB a year). Keep WebP copies, thumbnails and upscales for all (4.89 PB a year). After one year the store holds about **7.8 PB**, about $155,000 a month at an assumed $0.02 per GB-month, against $413,000 if every PNG were kept. It then grows by 0.54 PB a month, so old images belong in a colder storage class.
- Egress: assume each image is viewed twice at display size and ten times as a thumbnail (700 KB), and each upscale is downloaded once. That is 28.8 million × 0.7 MB + 0.8 million × 6 MB ≈ **25 TB a day**, about $15,000 a month at an assumed $0.02 per GB.

## API design

A submit returns `202 Accepted` with a job ID at once. The app follows progress over a WebSocket, and API clients poll or receive a webhook.

| Call | Purpose |
|---|---|
| `POST /v1/images/generations` | Text to image. Returns `job_id`, `status` and an estimated wait. |
| `POST /v1/images/edits` | Image to image or inpainting, with a source image, optional mask and strength. |
| `POST /v1/images/{image_id}/upscale` | A 2× upscale of one image. |
| `GET /v1/jobs/{job_id}` and `POST /v1/jobs/{job_id}/cancel` | State, progress and image URLs; cancel a queued or running job. |
| `GET /v1/images?cursor=...` and `DELETE /v1/images/{image_id}` | Gallery listing and deletion. |

```http
POST /v1/images/generations HTTP/1.1
Authorization: Bearer <api key>
Idempotency-Key: 4f0c9a1e-77d2-4b8e-a0c3-91e5d2b6f7a8
Content-Type: application/json

{"prompt": "a lighthouse in a storm, ink wash style", "model": "base-v3",
 "size": "1024x1024", "n": 4, "style": "ink-wash", "seed": 81723,
 "guidance": 6, "mode": "fast", "webhook_url": "https://example.com/hooks/images"}
```

The [idempotency key](/learn/reliability-patterns#idempotency-keys) stops a retried submit from running or charging twice. A webhook is a POST signed with an HMAC (a keyed hash) of its timestamp and body, carrying `job_id`, a unique `event_id` and the final state. It is delivered at least once, with backoff for up to 24 hours, so receivers skip an `event_id` they have seen.

## High-level design

```diagram
title: Submitting is cheap. GPU work happens behind a queue.
[c:client] App and\nAPI clients @ 0,1
[api] Job API\nauth, credits @ 1,1
[ps:note] Prompt check\nbefore GPU @ 1,0
[db:store] Jobs DB\nrecipe, state @ 2,0
[q:queue] Tiered queues\nfast, relaxed @ 2,1
[w] GPU workers\nbatch, denoise @ 3,1
[ic:note] Image check\nafter decode @ 3,0
[ev] Progress\nfan-out @ 2,2.5
[obj:store] Object storage\nPNG, WebP @ 4,1
[cdn] CDN\nsigned URLs @ 4,2.5
c <-> api : submit, WebSocket
api -> ps : prompt
api --> db : job row
api -> q : enqueue
q -> w : batch
w -> ic : images
w -> obj : store
w --> ev : previews
ev --> api : push
obj -> cdn : origin
```

1. The API authenticates the caller, checks the idempotency key, the tier's limits and the user's running jobs (at most 3 fast ones for a paid user), and reserves credits.
2. The prompt check runs. A refused prompt gets `400` with a policy code and costs no GPU time.
3. The API writes the job row with the full recipe, enqueues the job ID and returns `202`.
4. A worker pulls a batch of compatible jobs, runs the steps and publishes a preview every 5 steps.
5. Each decoded image passes the image check, gets its C2PA manifest and watermark, and is written to object storage as PNG, WebP and thumbnail.
6. The worker marks the job `succeeded`, settles credits and emits the event behind the WebSocket push or webhook. Clients load images from the CDN, as in the [video streaming](/learn/design-video-streaming#cdn-delivery-and-cost) design.

## Why this is a job queue

Nothing is finished until the decoder runs, about 4.6 seconds in. A request held open that long ties up a connection through every proxy, and a dropped connection loses the result. A job ID lets the client disconnect, switch devices or use a webhook, and lets the server retry a failed worker unseen, the pattern in [telling the user the job is done](/learn/queues-and-async#telling-the-user-the-job-is-done).

```diagram
title: Job states. Only the worker holding the lease moves a running job.
[ad:client] Submit @ 0,1
[qd:queue] queued @ 1,1
[rn] running\nstep k of n @ 2,1
[ok:note] succeeded @ 4,0
[bl:note] blocked\nby image check @ 4,1
[fl:note] failed\nafter 3 tries @ 4,2
[cx:note] cancelled\nby the user @ 2,2.5
[sh:note] rejected\nwhen shedding @ 0,2.5
ad -> qd : accepted
ad --> sh
qd <-> rn : lease, expiry
rn -> ok : images pass
rn -> bl : all flagged
rn -> fl
qd --> cx
rn --> cx
```

A worker takes a job by **lease**: it marks the job `running` with its ID and an expiry 30 seconds ahead, and renews the lease every few steps. If the worker dies, the lease expires and the job returns to the queue, like the visibility timeout in [when a worker fails halfway](/learn/queues-and-async#acknowledgements-and-visibility-timeouts). The third failure ends in `failed` with credits refunded. Writes are keyed by job ID and image index, so a repeated attempt overwrites the same objects. If only some images are flagged, the job succeeds and those show a notice.

**Previews.** Every 5 steps the worker decodes the current latent with a small approximate decoder (assumed 3 ms for four images) and publishes a 2×2 grid as one JPEG of about 30 KB. In fast mode the first preview comes 5 × 144 ms ≈ 0.7 seconds after the job starts. Six previews per job is about 1.4 TB a day, pushed over a [WebSocket](/learn/realtime#websockets) and never stored. A user who sees a bad composition at step 10 can cancel and free the GPU.

## GPU workers and batching

### Batching jobs of the same shape

A batch shares one tensor, so its jobs must match on model, style, size, step count and guidance. At 1024×1024 the assumed timing gives little gain past one request, because 8 evaluations already keep the GPU busy with arithmetic. A step costs 21 ms per evaluation at 2 evaluations, 18 at 8, 17.5 at 16 and 17.25 at 32.

Running a request's four images one at a time takes 4 × 30 × 42 + 240 = 5,280 ms, against 4,570 as one batch, so a request's images always share a batch. Adding a second request lifts throughput from 0.875 to 0.899 images per GPU-second, under 3%, and nearly doubles latency to 8.9 seconds. Fast mode runs one request per batch, and relaxed mode may pair two. At 512×512 the fixed 8 ms matters more (12.3 ms for one evaluation, 4.5 ms each at 32), so drafts are batched across many requests.

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class Job:
    job_id: str
    model: str        # model version, e.g. "base-v3" or "turbo-v3"
    style: str        # LoRA id, "" for none
    width: int
    height: int
    steps: int
    images: int = 4
    cfg: bool = True  # classifier-free guidance doubles the evaluations


def shape_key(j):
    """Jobs with equal keys can share one batch tensor and one step loop."""
    return (j.model, j.style, j.width, j.height, j.steps, j.cfg)


def evals(j):
    return j.images * (2 if j.cfg else 1)


def next_batch(waiting, max_evals):
    """`waiting` is in scheduling order. Take the head, then later jobs with the same key."""
    head = waiting[0]
    batch, used = [head], evals(head)
    for j in waiting[1:]:
        if shape_key(j) == shape_key(head) and used + evals(j) <= max_evals:
            batch.append(j)
            used += evals(j)
    return batch, used


waiting = [
    Job("a", "turbo-v3", "", 512, 512, 4, cfg=False),
    Job("b", "base-v3", "", 1024, 1024, 30),
    Job("c", "turbo-v3", "", 512, 512, 4, cfg=False),
    Job("d", "turbo-v3", "ink-wash", 512, 512, 4, cfg=False),
]
batch, used = next_batch(waiting, max_evals=32)
print([j.job_id for j in batch], used)   # ['a', 'c'] 8
```

The head always runs, so batching never makes the oldest job wait. Mixing shapes would need padding: a 1024×1024 job and a 1344×768 job padded to a shared 1344×1024 do 31% and 33% more work than their own pixels need, and the padding changes the picture. That is one reason the API allows only five sizes.

### Memory on one GPU

An H100 has about 72 GB usable after 10% headroom. With assumed sizes, four 7 GB model variants (current base, previous version, inpainting and distilled) take 28 GB, an upscaler 3 GB, activations for 8 evaluations at about 2 GB each 16 GB, one VAE decode at 1024 about 5 GB, and 50 style adapters at 150 MB each 7.5 GB. That is 59.5 GB. A 70B language model needs four H100s for its weights, while one H100 holds five image models, so compute is the scarce resource and every worker serves every variant. Newer models are larger (FLUX.1 has about 12 billion parameters, 24 GB in 16-bit), so redo the budget per model.

### Styles as LoRA adapters

A style is a LoRA adapter, a small set of weight changes trained for one look, as in [serving many models](/learn/inference-fleets#serving-many-models). At an assumed 150 MB, one loads from local NVMe in 0.03 seconds and from the regional store over 10 Gbps in 0.12. Merging it into the denoiser takes about a second (assumed) and then costs nothing per step, while applying it unmerged adds a little per step but lets one batch mix styles. Assume the top 50 styles cover 80% of styled jobs, so those stay on every worker. A rare style is mapped by [consistent hashing](/learn/consistent-hashing) onto 8 workers, where it stays warm, and its jobs go there.

## Tiered queues and scheduling

Each tier has a queue, and each job gets a deadline at submission: 15 seconds for fast, 600 for paid relaxed and 1,800 for free. Workers pop in strict tier order, except that a paid relaxed job within 60 seconds of its deadline goes ahead of fast work, so a busy evening cannot starve it.

```python
import heapq
import itertools

TARGET_S = {"fast": 15, "relaxed_paid": 600, "relaxed_free": 1800}
GUARD_S = 60      # a paid relaxed job this close to its deadline jumps the fast queue


class TieredQueue:
    def __init__(self):
        self.heaps = {tier: [] for tier in TARGET_S}
        self.seq = itertools.count()

    def push(self, tier, job, now):
        deadline = now + TARGET_S[tier]
        heapq.heappush(self.heaps[tier], (deadline, next(self.seq), job))

    def pop(self, now):
        paid = self.heaps["relaxed_paid"]
        if paid and paid[0][0] - now <= GUARD_S:
            return heapq.heappop(paid)[2]
        for tier in ("fast", "relaxed_paid", "relaxed_free"):
            if self.heaps[tier]:
                return heapq.heappop(self.heaps[tier])[2]
        return None


q = TieredQueue()
q.push("relaxed_free", "free-1", now=0)
q.push("relaxed_paid", "paid-1", now=0)
q.push("fast", "fast-1", now=545)
q.push("fast", "fast-2", now=545)
print(q.pop(now=545), q.pop(now=545), q.pop(now=546), q.pop(now=547))
# paid-1 fast-1 fast-2 free-1
```

- **No preemption.** A running batch is not interrupted for a fast job. Its state is small (a 128×128×4 latent in 16-bit is 131 KB per image, plus the step and random state), but rebuilding the batch would save only seconds. On a shared worker a fast job waits at most one batch, 4.6 seconds, or 8.9 if two requests were paired. Dedicated fast workers never run relaxed batches.
- **Credits.** Fast jobs reserve credits from a price table (4 for text to image, 3 for an edit, 2 for an upscale) set from measured GPU-seconds, so spend is predictable. Failed jobs are refunded, and a job cancelled mid-run pays for its steps.
- **Shedding the free tier.** At peak, paid relaxed work needs about 182 busy GPUs and free work about 436. With the relaxed fleet capped at 450 GPUs, free work gets 268, and its backlog grows by about 168 GPU-hours in the peak hour. When the estimated free wait (queue length over current throughput) passes 30 minutes, new free submissions get `429` with a suggested time. Refusing at the door costs nothing, while dropping an accepted job breaks a promise, as [back pressure](/learn/queues-and-async#back-pressure-when-the-queue-keeps-growing) explains.

## Autoscaling and spot GPUs

Assume the quietest hour runs at 0.2 of the daily average. Fast mode then needs 140 × 0.2 ÷ 0.75 ≈ 37 GPUs at night and 469 at the evening peak. Scale on queue wait and waiting jobs per worker, since GPU utilization reads near 100% on any saturated worker whatever the queue length.

The fleet chapter's [cold start](/learn/inference-fleets#loading-models-quickly) for a 141 GB model on a 10 Gbps link was about 209 seconds on a fresh node and 88 on a warm one. With the same 10 GB container image and link but 7 GB of weights, the download falls from 113 seconds to 5.6 and the disk load from 28 seconds to 1.4. Assume 45 seconds of engine start, including cached compiled kernels and a warm-up image. A cold node is ready in 8 + 5.6 + 1.4 + 45 = 60 seconds and a warm one in about 46, so start-up work now dominates. A new cloud machine adds minutes, so keep a small warm pool and scale ahead of the evening rise.

The relaxed tier runs on spot GPUs, spare capacity the provider can reclaim at short notice. At $1.20 an hour instead of $3 (assumed), its 6,586 GPU-hours save about $11,860 a day. Providers warn from about 30 seconds to 2 minutes ahead, longer than a batch, so the worker stops leasing and finishes. A machine that vanishes unwarned loses on average half a job (about 2.3 GPU-seconds), and the expired leases send its jobs elsewhere. Fast mode stays on on-demand GPUs, because a reclaim wave at peak would break its target.

## Latency tricks

- **Distilled drafts.** A 4-step distilled model without guidance makes four images in about 0.55 GPU-seconds, about 8 times cheaper than the full model. A 512×512 draft mode returns in about a second, and the user refines a chosen draft with the full model as an image-to-image job.
- **Cache text embeddings** keyed on the encoder version and prompt hash, since users reroll the same prompt. It saves only 10 ms of 4,570, and an SDXL-style embedding (77 tokens × 2,048 values × 2 bytes) is about 315 KB.
- **Compile the denoiser** for each supported shape with `torch.compile` or TensorRT. Gains of 20% to 40% per step are plausible, an assumption to measure. Each shape needs its own compiled graph, a second reason for five sizes, and stored artifacts let new workers skip compiling.
- **Generate at 1024, then upscale.** A 2048×2048 step costs at least 4 times as much (4 times the pixels, and attention cost grows with their square), and models trained near one megapixel compose poorly at larger sizes. The tiled upscale costs 2.4 GPU-seconds and looks better.

## Safety pipeline

```diagram
title: Checks run before GPU spend and before anyone sees an image.
[p:client] Prompt or\nupload @ 0,1
[tc] Text and upload\nchecks @ 1,1
[hm:note] Known-image\nhash match @ 1,2.5
[g] Generate\non GPU @ 2,1
[ic] Image\nclassifier @ 3,1
[out:store] Stored with\nC2PA, watermark @ 4,1
[rv:queue] Review and\nappeals queue @ 3,2.5
[x:note] Refused, with\npolicy code @ 1,0
p -> tc : request
tc -> g : allowed
tc --> x : blocked
tc --> hm : uploads
g -> ic : decoded images
ic -> out : pass or blur
ic --> rv : flagged
```

1. **Before the GPU.** A text classifier scores the prompt and negative prompt, alongside maintained term lists, in a few milliseconds on CPU. Uploads for edits get an image classifier, stricter rules when they show a real person, and a match against hash lists of known child sexual abuse material (CSAM) from child-safety organizations. Each refusal saves 4.6 GPU-seconds, and the image never exists.
2. **After decoding, before storage.** An image classifier checks every output (about 10 ms per image, assumed), because harmless-looking prompts can produce bad images. Each image passes, is blurred behind a click-through (for adult accounts that opted in), or is blocked.
3. **Review.** Blocked outputs are kept encrypted for a fixed period, readable only by the trust and safety team. Users can appeal, decisions become training labels, and the overturn rate measures over-blocking.

CSAM follows a separate path. In many jurisdictions, including the United States, a provider that becomes aware of apparent CSAM must report it to a designated body (in the US, NCMEC's CyberTipline) and preserve it as the law specifies. Counsel defines the process. Engineering provides a restricted pipeline, holds the material from automatic deletion for the preservation period, and acts on the account.

Rate limits apply per account, device and network, and an account with repeated blocks slows down, then loses fast mode, then is suspended (see [abuse and content safety](/learn/ai-security#abuse-and-content-safety)). Unlike the windowed checks on streamed text in the [chat assistant](/learn/design-chat-assistant#safety-and-moderation-in-the-stream), each image is checked whole before release.

## Storage and delivery

Each file is stored under a **content-addressed key**, the SHA-256 hash of its bytes, such as `img/3f/3fa9c2…e1.webp`. The bytes behind a key never change, so the CDN caches it with `Cache-Control: public, max-age=31536000, immutable` (see [HTTP caching headers](/learn/dns-and-cdn#http-caching-headers)). The metadata database maps each `image_id` to its keys, job, owner, seed and visibility.

Private images use **signed URLs**, with an expiry and a signature the CDN checks at the edge. The signature stays out of the cache key, or every viewer would miss. Thumbnails and WebP copies are written with the PNG, and a [pull CDN](/learn/dns-and-cdn#pull-cdns) fits, since most images are seen only by their creator.

Deletion marks the row, which hides the image at once. A background job then deletes the objects (unless another row points at the same hash, as when a seeded job is rerun) and purges the CDN paths. Signed URLs expire within an hour, which bounds how long a copied link works, and backups age out on their own schedule.

## Provenance

- **A C2PA manifest.** The Coalition for Content Provenance and Authenticity (C2PA) defines signed metadata embedded in the file. Ours states that this service generated the image, with which model version, and anyone can verify the signature. Screenshots, many re-encoders and some upload pipelines strip it.
- **An invisible watermark.** A small payload, such as 48 bits mapping to the job, is hidden in the pixels. It survives resizing and moderate compression, while heavy edits, crops or regeneration through another model can remove it. Detection reports a confidence score, and its false positive rate needs measuring, because wrongly labelling an artist's work as generated does real harm.
- **A perceptual hash** of each output, a fingerprint that changes little under resizing or recompression, answers "did we make this?" after the metadata is gone.

These signals can show that a marked image came from this service. None can prove that an unmarked image was made by a person.

## Seeds and reproducibility

The seed fixes the starting noise. Each image stores its seed (the request seed plus the image index) and the full recipe: model version, scheduler, steps, guidance, size, style version and source image. Reusing a seed with a small prompt change keeps a similar composition. Reruns are not bit-exact, because another GPU type, batch size, library version or nondeterministic kernel can change pixels slightly. Promise reproduction only on the same model version, keep old versions available as long as that promise lasts, and serve the stored file when an exact copy matters.

## Observability and quality

- **Latency:** queue wait per tier at p50 and p95, time to first preview, and submit-to-finish time. Queue wait moves first under load, since generation time barely changes.
- **Efficiency:** GPU utilization, batch fill, useful GPU-seconds over paid GPU-seconds (the rest is idle time, retries and cancelled work), and cost per image per tier.
- **Safety:** prompt block rate, output block and blur rates, appeal overturn rate and review backlog. Output blocks rising while prompt blocks stay flat suggests a new evasion technique or a model change.
- **Quality:** an image-text similarity score for prompt adherence, and human preference sampling, where raters compare current and candidate models on the same prompt and seed (see [human review](/learn/ai-evals-and-observability#human-review-and-binary-scores)). Also track the share of grids with an upscale or download, and rerolls per prompt.

Trace each job with a span per stage, as in [tracing model calls](/learn/ai-evals-and-observability#tracing-model-calls), and log only prompt hashes.

## Trade-offs to discuss

- **Batch size against latency.** At 1024×1024 a second request in the batch adds under 3% throughput and nearly doubles latency. At small sizes and with distilled models, batching pays.
- **Spot against predictability.** Spot GPUs make relaxed mode 60% cheaper and suit short, restartable jobs.
- **Shedding against queuing free work.** Refusing early protects paid users and is honest. A long free queue accepts jobs that may finish after the user leaves.
- **Retention against cost.** Keeping every PNG costs about $413,000 a month after a year, against $155,000 with the policy. Regenerating from the recipe is no substitute, since it is not bit-exact.
- **Prompt checks against output checks.** Prompt checks are cheap and easy to evade. Output checks catch more and cost GPU time on every image, so the design runs both.

## Check yourself

<details>
<summary>A product manager wants to turn classifier-free guidance off to save money. What does it save, and what else changes?</summary>

A step falls from 144 ms to 8 + 17 × 4 = 76 ms, and a request from 4.57 to 2.53 GPU-seconds, about 45% less, but images follow the prompt less closely. A distilled model with guidance built in saves more without that loss, once it passes a quality eval.

</details>

<details>
<summary>Fast mode serves 2.9 million jobs a day with a peak factor of 2.5, planned at 75% utilization. How many H100s at peak, and what does a fast image cost?</summary>

2.9 million × 4.18 ÷ 86,400 ≈ 140 busy GPUs on average, 351 at peak, so 351 ÷ 0.75 ≈ 469. Tracking the daily curve takes about 4,494 GPU-hours, $13,480, over 10.7 million images: about $0.0013 each.

</details>

<details>
<summary>Why is the API asynchronous with job IDs instead of one long HTTP request?</summary>

Nothing usable exists until about 4.6 seconds of GPU work are done, and relaxed jobs may wait minutes first. A long request holds a connection through every proxy and loses the result if it drops. A job ID lets clients reconnect, poll or take a webhook, and lets the server retry a failed worker unseen.

</details>

<details>
<summary>A fast job arrives while every shared worker is in a relaxed batch. How long can it wait, and why not pause the batch?</summary>

At most one batch, about 4.6 seconds, or 8.9 if two requests were paired. Pausing is possible, since a latent is only 131 KB per image, but rebuilding the batch would save only seconds.

</details>

<details>
<summary>The provider reclaims a spot machine running relaxed jobs. What happens?</summary>

On the warning, the worker stops leasing and finishes its batch, which is shorter than the notice. Without one, the leases expire after 30 seconds and other workers rerun the jobs, overwriting the same objects because writes are keyed by job ID and image index. The expected loss is half a job.

</details>

<details>
<summary>A news site asks whether a viral image came from your service. It has no C2PA manifest. What can you check?</summary>

Run the watermark detector, which may still find the payload after resizing or recompression, and compare the image's perceptual hash with stored output hashes. A match points to a job. No match proves nothing, because heavy edits or regeneration can remove both signals.

</details>

## Further reading

- [Ho, Jain and Abbeel, Denoising Diffusion Probabilistic Models (arXiv 2006.11239)](https://arxiv.org/abs/2006.11239): the step-by-step denoising process this design schedules.
- [Rombach et al., High-Resolution Image Synthesis with Latent Diffusion Models (arXiv 2112.10752)](https://arxiv.org/abs/2112.10752): denoising in a VAE latent space, the basis of Stable Diffusion.
- [Ho and Salimans, Classifier-Free Diffusion Guidance (arXiv 2207.12598)](https://arxiv.org/abs/2207.12598): the guidance scale and its two evaluations.
- [Podell et al., SDXL (arXiv 2307.01952)](https://arxiv.org/abs/2307.01952): the model class behind the estimates, with its two text encoders and multi-aspect training.
- [Sauer et al., Adversarial Diffusion Distillation (arXiv 2311.17042)](https://arxiv.org/abs/2311.17042): images in one to four steps from a distilled model.
- [Song et al., Consistency Models (arXiv 2303.01469)](https://arxiv.org/abs/2303.01469): another route to few-step generation.
- [C2PA](https://c2pa.org/): the content provenance specification and its signed manifests.
