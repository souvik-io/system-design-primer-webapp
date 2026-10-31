<!-- Flashcards for the AI systems chapters: inference, hardware, serving, retrieval, agents, evals, security and training. -->

<!-- chapter: llm-inference -->

## Explain prefill and decode, and why they stress different resources.
<!-- /learn/llm-inference#prefill-and-decode -->

Prefill is the first pass over the whole prompt. The prompt is known in advance, so the GPU handles all its tokens together as large matrix operations, and it reads each weight once for many tokens. That makes prefill **limited by arithmetic**. Decode then produces the answer one token per pass. Each pass handles only the newest token but still reads every weight and the cached keys and values from GPU memory, so decode is **limited by memory bandwidth**. Long prompts raise time to first token, and long answers stretch decode.

## How many bytes of KV cache does Llama 3.1 70B keep per token in BF16, and what does grouped-query attention save?
<!-- /learn/llm-inference#the-kv-cache -->

Bytes per token = 2 × layers × KV heads × head dimension × bytes per value = 2 × 80 × 8 × 128 × 2 = **327,680 bytes**. The leading 2 covers keys and values. Llama 3 uses grouped-query attention with 8 key-value heads. Without it, the model would keep all 64 heads, giving 2,621,440 bytes per token, **eight times as much**. One 4,096-token conversation takes about 1.34 GB with GQA.

## Why does one user top out near 96 tokens a second on the 70B model across four H100s?
<!-- /learn/llm-inference#prefill-and-decode -->

Every decode step reads all 140 GB of BF16 weights. Four H100s at 3.35 TB/s each give 13.4 TB/s, so a step takes at least 140 ÷ 13,400 ≈ **10.4 ms**, and 1 ÷ 0.01045 ≈ **96 tokens a second**. The step's arithmetic, 140 GFLOP, would take about 0.04 ms at full speed. The step spends almost all its time **waiting on memory**, so more FLOPS would not help.

## The 70B model runs on four 80 GB H100s with a 10% reserve. How many 4,096-token conversations fit in the cache?
<!-- /learn/llm-inference#the-kv-cache -->

320 GB total, minus 32 GB reserved for activations and runtime, minus 140 GB of weights, leaves **148 GB** for the cache. At 327,680 bytes per token that holds about 451,660 tokens, and 451,660 ÷ 4,096 ≈ **110 conversations**. The cache grows linearly with tokens, so conversations twice as long would halve the count.

## Batching 64 users with 2,000-token contexts on the four-H100 setup. What happens to total throughput and to each user's speed?
<!-- /learn/llm-inference#latency-and-throughput-metrics -->

The cache reads add 64 × 2,000 × 327,680 bytes ≈ 42 GB, so a step reads about 182 GB and takes (140 + 42) ÷ 13.4 ≈ **13.6 ms**. Each step makes one token per user: 64 ÷ 0.0136 ≈ 4,706 tokens a second in total, about 74 per user. Throughput rises about **49 times** over one user, while each user slows by about 23%. The weights are read once per step however many users share it.

## What does one full 128K-token conversation cost the 70B model in memory and prefill time?
<!-- /learn/llm-inference#context-windows -->

Taking 128K as 131,072 tokens:

- **Memory:** 131,072 × 327,680 bytes ≈ 42.9 GB of KV cache, so the 148 GB budget holds only **three** such conversations.
- **Compute:** 131,072 × 140 GFLOP ≈ 18,350 TFLOP of prefill, about **9.3 seconds** at 50% of four H100s' peak, before the attention work that grows faster than the length.

Quality can also degrade as the window fills, so test long contexts on your own workload.

<!-- chapter: gpus-for-ai -->

## Explain the roofline model and the ridge point in your own words.
<!-- /learn/gpus-for-ai#compute-versus-memory-bandwidth -->

A step's speed is capped by the lower of two limits: peak compute, or memory bandwidth times arithmetic intensity (FLOPs done per byte read). The **ridge point** is the intensity where the two limits meet. Below it, a workload is memory-bound and bandwidth sets its speed. Above it, the workload is compute-bound. For an H100 at dense BF16, the ridge point is 989 TFLOPS ÷ 3.35 TB/s ≈ **295 FLOPs per byte**. Decode at batch 1 has an intensity of about 1, far below it.

## Why does 70B decode on one H100 stay memory-bound at every batch size when contexts are 2,000 tokens?
<!-- /learn/gpus-for-ai#compute-versus-memory-bandwidth -->

Ignoring the cache, the intensity equals the batch size, so it would cross the ridge near batch 295. But each sequence also reads its own cache, about 655 MB at 2,000 tokens. The intensity becomes B × 140 ÷ (140 + 0.655 × B): **49 at batch 64**, approaching 140 ÷ 0.655 ≈ **214** as the batch grows. That stays below the ridge point of 295. A kernel reaching only half of peak has an effective ridge near 148, and then large batches would become compute-bound.

## A team swaps H100s for H200s at the same GPU count. Which phase speeds up, and by how much?
<!-- /learn/gpus-for-ai#compute-versus-memory-bandwidth -->

**Decode speeds up** by about 1.43 times, because it is memory-bound and the H200's 4.8 TB/s is 1.43 times the H100's 3.35 TB/s. **Prefill does not**, because it is limited by dense FLOPS and the H200 has the same Tensor Core figures (989 TFLOPS dense BF16). The H200's 141 GB also means fewer GPUs can hold the weights, which changes the cost per GPU.

## Why does tensor parallelism belong inside one node?
<!-- /learn/gpus-for-ai#connecting-gpus -->

Tensor parallelism combines activations after every layer. For the 70B model on four GPUs at batch 64, with two combines per layer, each GPU moves about **252 MB per step**. Over NVLink at 450 GB/s each way that takes about 0.56 ms, roughly 4% of the 13.6 ms step. Over PCIe at 64 GB/s each way it takes about 3.9 ms, roughly 29%. NVLink inside a DGX H100 is also **18 times** faster than the InfiniBand path out of the node (900 ÷ 50 GB/s).

## When would you use replicas, tensor parallelism, pipeline parallelism or expert parallelism?
<!-- /learn/gpus-for-ai#splitting-a-model-across-gpus -->

- **Replicas** when the whole model and its cache fit in one copy. They add throughput cheaply because copies never talk while generating.
- **Tensor** when the model is too big for one GPU but fits in one node. It needs fast links for a combine per layer.
- **Pipeline** across nodes or on GPUs without NVLink. Only one activation hop crosses each stage, but stages take turns for one sequence.
- **Expert** only for mixture-of-experts models, placing experts on different GPUs.

## Why can one outlier weight make quantization much worse?
<!-- /learn/gpus-for-ai#number-formats-and-quantization -->

With one scale per tensor, the **largest value sets the grid**, so a single big weight stretches the spacing between levels for every other weight. In the chapter's toy, adding one 0.9 to 100,000 small Gaussian weights made the error about **10 times larger at INT8** and about 5 times larger at INT4. This is why LLM.int8() keeps the few outlier feature dimensions in 16 bits. Published low-bit results vary, so test on your own tasks.

<!-- chapter: inference-engines -->

## Explain continuous batching in your own words, and how it differs from static batching.
<!-- /learn/inference-engines#continuous-batching -->

Static batching runs a batch until every request in it finishes, so a short request sits idle in its slot and new arrivals wait for the whole batch. Continuous batching **schedules each iteration separately**: a request that finishes leaves at once, and a waiting request takes its slot at the next step. On the chapter's 12 sample requests with four slots, static batching took 29 steps with slots 58% busy, while continuous batching took **19 steps with slots 88% busy** and cut the average wait from 11.3 to 5.2 steps.

## How does paging limit KV cache waste, and how much can one request waste on the 70B model?
<!-- /learn/inference-engines#paging -->

The cache is split into fixed-size blocks, and each request keeps a block table mapping its logical blocks to physical ones. It takes a new block only when its last block fills, and blocks return to the pool when it finishes. With vLLM's default of 16 tokens per block, one block holds 16 × 327,680 bytes ≈ 5.2 MB, so a request wastes **at most 15 slots, about 4.9 MB**. Older systems that reserved the maximum length up front used only 20.4% to 38.2% of their cache for real tokens.

## A draft model is accepted 80% of the time and proposes 4 tokens. If a draft step costs 10% of a target step, what is the speedup?
<!-- /learn/inference-engines#speculative-decoding -->

Expected tokens per target pass = (1 − α^(γ+1)) ÷ (1 − α) = (1 − 0.8^5) ÷ 0.2 ≈ **3.36**. A round costs 4 × 0.1 + 1 = 1.4 target steps, so you get 3.36 ÷ 1.4 ≈ **2.4 tokens per target step** of time. The acceptance rule keeps the output distribution the same as sampling from the target alone. The gain is largest at small batches, where the GPU has spare capacity.

## Every request shares a 1,500-token system prompt. What does prefix caching save on the four-H100 setup?
<!-- /learn/inference-engines#prefix-caching -->

Only full blocks are cached, so with 16-token blocks, 93 blocks cover **1,488 tokens**. Each hit skips 1,488 × 140 GFLOP ≈ 208 TFLOP of prefill, about **53 ms at peak** or 105 ms at 50%. The last 12 tokens still run. Prefix caching speeds up only prefill, so a request with a long reply gains little.

## Why does one long prompt cause streaming stalls for everyone else, and what does chunked prefill trade?
<!-- /learn/inference-engines#chunked-prefill -->

Without chunking, an 8,000-token prefill fills an iteration: 1,120 TFLOP, about 283 ms at peak on four H100s and 566 ms at 50%. No other request gets a decode token during it. Chunked prefill splits the prompt into chunks and runs each one alongside all ongoing decodes, so a 512-token chunk costs about 18 ms at peak and **every running request still gets its token**. The trade is that the long prompt's **own time to first token grows**, since its prefill spreads over more iterations.

## The KV block pool runs out mid-generation. What does vLLM do, and what does it cost?
<!-- /learn/inference-engines#preemption-when-memory-runs-out -->

The scheduler **preempts** a sequence, freeing all its blocks together. Under first-come, first-served scheduling, the latest requests go first. The blocks can be swapped to CPU memory or dropped and recomputed later, and vLLM's V1 engine defaults to **recomputation**. Recomputing a 2,000-token context is a full prefill of 280 TFLOP, about 71 ms at peak on four H100s or 140 ms at 50%. Preemption raises end-to-end latency, so watch the preemption count when you push concurrency.

## On the four-H100 setup with 2,000-token contexts, what do you gain and lose going from 64 to 225 concurrent users?
<!-- /learn/inference-engines#tuning-for-latency-or-throughput -->

| Users | Step | Per user | Total |
|---|---|---|---|
| 64 | 13.6 ms | 74 tok/s | 4,700 tok/s |
| 225 | 21.5 ms | 47 tok/s | 10,500 tok/s |

Total throughput rises about **2.2 times**, while each user drops from about 74 to **47 tokens a second**. At 225 users the 450,000-token cache budget is full, so that is the memory ceiling. These are upper bounds that ignore prefill and scheduler overhead.

<!-- chapter: ai-estimation -->

## Explain in your own words the three checks that decide how many GPUs to rent.
<!-- /learn/ai-estimation#how-many-gpus -->

- **Memory:** the weights plus the KV cache for every request running at once must fit in usable memory.
- **Throughput at peak:** the GPUs split their time between prefill and decode, and the decode batch must keep up with the output tokens the peak traffic asks for, at the per-user speed you need.
- **Headroom:** the fleet must still meet that speed with one replica down.

**The largest of the three counts wins**, and spares go on top. A fleet that only just keeps up at peak fails as soon as one machine does.

## With a 10% reserve, which of these hold Llama 3.1 405B: 8 H100s in BF16, 8 H100s in FP8, or 8 H200s in BF16?
<!-- /learn/ai-estimation#memory-for-the-weights -->

- **8 × H100, BF16:** 576 GB usable against 810 GB of weights. **Does not fit.**
- **8 × H100, FP8:** the weights shrink to 405 GB, leaving **171 GB** for the cache.
- **8 × H200, BF16:** 1,015 GB usable, leaving **205 GB** for the cache.

Weight bytes are parameters × bytes per parameter, so the number format moves the answer as much as the GPU does. Lower precision can cost quality.

## In the support assistant, why does prefill set the replica count before decode does?
<!-- /learn/ai-estimation#worked-example-a-support-assistant -->

Each request sends 2,000 prompt tokens and gets 400 back, so prompts are five times the length of answers. At peak that is **13,889 prompt tokens a second**. One four-H100 replica at 50% of dense math prefills 1,978 TFLOPS ÷ 140 GFLOP ≈ **14,129 tokens a second**, so prefill alone would take 98% of its time. Decode only gets what prefill leaves, and one replica cannot keep up.

## The support assistant needs 30 tokens a second per user with one replica down. Why three replicas and not two?
<!-- /learn/ai-estimation#worked-example-a-support-assistant -->

Two replicas give each user **42 tokens a second** at peak, but if one fails, the single survivor cannot even keep up with prefill and its queue grows without limit. Three replicas give **60 tokens a second**, and with one down the remaining two still give 42, above the 30 required. Three replicas of four H100s is 12 GPUs, or $26,280 a month at $3.00 an hour.

## How does Little's law confirm the support assistant's batch size of about 16?
<!-- /learn/ai-estimation#worked-example-a-support-assistant -->

Requests in flight = arrival rate × time in the system. At peak, 6.94 requests a second each spend about 6.7 seconds decoding (400 tokens at 60 a second) plus 0.14 seconds of prefill. That gives about **47 requests in flight** across three replicas, or **about 16 per replica**, which matches the batch from the throughput equation. Their cache, about 12.2 GB per replica, is far below the 148 GB available, so memory is not the constraint.

## The batch-64 ceiling says $0.71 per million output tokens, but the support assistant fleet costs $1.83 per million tokens. Why is the real figure higher?
<!-- /learn/ai-estimation#cost-per-million-tokens -->

The $0.71 is a ceiling: four H100s at $12 an hour producing about 4,714 tokens a second at full utilisation. The real fleet is **sized for peak** and billed every hour, while average prefill load is only about 11% of its capacity. Its batches are also smaller, so **each weight read is shared across fewer tokens**. $26,280 a month over 14,400 million input and output tokens comes to about $1.83 per million.

## An estimate says a 70B model needs 2.6 MB of KV cache per token and quotes GPU memory in GiB. What went wrong?
<!-- /learn/ai-estimation#sanity-checks -->

Two common slips:

- **Wrong head count.** Using the 64 attention heads instead of the 8 KV heads gives 2,621,440 bytes per token, **eight times too large**. The correct figure is 327,680 bytes.
- **Mixed units.** An 80 GiB GPU has 85.9 GB, about 7% more than the 80 GB vendors quote, so mixing the two overstates memory by that much.

Other checks: recompute per user, and confirm small-batch decode lands far below the ridge point of about 295 FLOPs per byte.

<!-- chapter: inference-fleets -->

## Explain why open connections are a poor measure of load on a GPU replica.
<!-- /learn/inference-fleets#from-one-server-to-a-fleet -->

A model reply holds a batch slot and its KV cache for seconds, so a replica is limited by **memory and batch slots**, and requests differ hugely in both. Forty 500-token chats hold about 6.6 GB of cache on the 70B model, while forty 4,096-token documents hold about 53.7 GB, **eight times as much**. Least connections sees the same count for both. Better signals come from the engine: the queue of waiting requests and the fraction of KV cache in use.

## A new 70B replica starts on a fresh node with a 10 Gbps link. Where do its roughly 209 seconds go, and what does a warm node save?
<!-- /learn/inference-fleets#loading-models-quickly -->

With the chapter's assumptions:

- Pull a 10 GB image: 8 s
- Download 141.1 GB of weights at 1.25 GB/s: 112.9 s
- Load from a 5 GB/s disk into GPU memory: 28.2 s
- Engine start: 60 s

That totals about **209 seconds**. A warm node already has the image and weights on disk, so it pays only the load and the engine start, about **88 seconds**, while its idle GPUs cost money.

## Six replicas each average 6 waiting requests against a target of 4. What does the Kubernetes HPA do, and how long does a spike wait?
<!-- /learn/inference-fleets#autoscaling -->

Desired replicas = ceiling(current × metric ÷ target) = ceiling(6 × 6 ÷ 4) = **9**. The HPA evaluates every 15 seconds by default, and new replicas take about 209 seconds on a fresh node, so a spike waits about **224 seconds** for relief. Scale-down uses the highest desired count from the last 300 seconds, so a short dip doesn't remove replicas. Scale on queue length and time to first token, since CPU use says little about a GPU replica.

## When does running prefill and decode on separate pools pay off?
<!-- /learn/inference-fleets#separating-prefill-and-decode -->

Separation stops long prefills from delaying other users' decode steps, but the KV cache must then **move over the network**. A 2,000-token prompt makes about 655 MB of cache. Over an 800 Gbps link that copy takes about **6.6 ms**. Over 25 Gbps it takes about **210 ms**, longer than the 142 ms prefill itself. It pays with a fast link or a copy that overlaps computation. It costs two pools to size, gains little for short prompts, and a lost decode machine takes its cache with it.

## How big is a rank-16 LoRA adapter on the query and value projections of Llama 3.1 8B?
<!-- /learn/inference-fleets#serving-many-models -->

A rank-r adapter on a d_in × d_out matrix adds r × (d_in + d_out) parameters. Queries: 16 × (4,096 + 4,096) = 131,072. Values, with 1,024 outputs: 16 × (4,096 + 1,024) = 81,920. That is 212,992 per layer, or **6,815,744** across 32 layers, about **13.6 MB** in BF16, roughly a thousandth of the 16 GB base model. That is why one replica can serve many fine-tunes, and why routing must send each request to a replica holding its adapter.

## A replica dies partway through a reply. When is it safe to retry on another replica?
<!-- /learn/inference-fleets#when-gpus-fail -->

- **No token reached the client:** retry anywhere. Prefill repeats, but the client saw nothing.
- **Some tokens reached the client:** send the prompt plus those tokens to another replica to continue. Sampling is random, so the continuation may differ, which is fine for chat.
- **No partial reply kept, or an exact answer needed:** return an error and let the client retry.

Retries become **unsafe once the model has called a tool that changes state**, so give those calls an idempotency key.

## What does offline batch inference gain on the four-H100 replica, and what caps it?
<!-- /learn/inference-fleets#offline-batch-inference -->

With no user waiting, the batch can grow until the **KV cache is full**: 450,000 ÷ 2,000 = 225 sequences at 2,000 tokens. An idealised step reads about 288.6 GB and takes about 21.5 ms, giving roughly **10,400 tokens a second** against 4,700 for the 64-user interactive case. At $12 an hour that is about **$0.32 per million tokens** instead of $0.71, at full utilisation. Decode stays memory-bound at every batch size, because each sequence's cache read takes longer than its arithmetic.

<!-- chapter: llm-gateways -->

## Explain in your own words why a gateway reserves tokens at admission and settles them afterward.
<!-- /learn/llm-gateways#token-based-rate-limits -->

When a request arrives, the gateway knows the prompt size but not how long the reply will be. So it **reserves** an estimate first, the prompt plus `max_tokens` as the worst case or plus an expected reply, and then **settles** when the response ends by swapping the reservation for the provider's real count. Providers count differently: OpenAI counts the full `max_tokens` up front, while Anthropic counts output as it is produced. A gateway must **match each provider's rule**, or it either collects 429s or refuses work the provider would accept.

## How should a gateway react to a 429, a 5xx or 529, a timeout, and a 400?
<!-- /learn/llm-gateways#routing-and-fallbacks -->

- **429:** a limit was hit. Wait for `Retry-After` if present, otherwise back off with jitter, and fall back if it persists. A spend-cap 429 is never retried.
- **500, 502, 503, 504, 529:** the provider is failing or overloaded. Retry briefly, then fall back.
- **Timeouts and connection failures:** fall back.
- **400:** the request is wrong for that target. Retrying won't help, so check each target's capabilities before routing to it.

## The gateway tries each target three times, and the provider SDK inside it also retries twice by default. What can go wrong?
<!-- /learn/llm-gateways#routing-and-fallbacks -->

The retries **multiply**. Three gateway attempts, each making up to three SDK attempts, can hit the provider **3 × 3 = 9 times** for one request, which deepens an overload or a rate limit instead of riding it out. Retry in one layer only, and **cool down a failing target** so traffic routes around it, as LiteLLM can do right after a 429.

## Streamed answers through an Envoy route get cut off at about 15 seconds. Why, and what should you configure?
<!-- /learn/llm-gateways#streaming-through-a-gateway -->

Envoy's route timeout defaults to **15 seconds for the whole response**, which its docs call a problem for streaming. Long answers stream for longer than that. Streaming routes need an **idle timeout** instead, one that caps silence between events. NGINX's `proxy_read_timeout` already works that way: its 60 seconds apply between two reads, so a steady stream is safe. Forward provider `ping` events during long pauses, since they count as activity.

## A team's provider prompt cache shows almost no cached tokens. What should you check?
<!-- /learn/llm-gateways#caching-responses -->

- **Prefix stability.** Matching is by exact prefix, so one changed token early on, such as a timestamp near the top, breaks every later block. Put stable content first and per-request values last.
- **Prompt length.** Anthropic's minimum runs from 512 to 4,096 tokens depending on the model, and shorter prompts are processed **without caching and without an error**.
- **Lifetime.** Anthropic's default is 5 minutes, refreshed on each use, so infrequent traffic expires.

Log cached-token counts per team so misses become visible.

## What must go into the key of a gateway's exact-match response cache?
<!-- /learn/llm-gateways#caching-responses -->

**Every field that can change the reply**: the model, the messages, temperature, `max_tokens` and tools, hashed in a canonical form. It must also include the **tenant**, so one customer never receives another customer's cached answer. The same question at a different temperature must miss. Set lifetimes per use case too: opening hours can be cached for an hour, but one customer's order status should never be cached.

<!-- chapter: vector-search -->

## Explain in your own words why many systems normalize vectors when they write them.
<!-- /learn/vector-search#measuring-similarity -->

Normalizing divides each vector by its length so every vector has length 1. After that, the **dot product equals cosine similarity**, and squared Euclidean distance equals 2 − 2 × cosine, so all three measures **rank neighbors in the same order**. Doing the division once at write time lets every query use the cheapest measure, the plain dot product. Still use the measure the embedding model was trained for.

## How long does one exact search over 100 million 768-dimension float32 vectors take on an H100, and what limits it?
<!-- /learn/vector-search#exact-search -->

The query reads 100,000,000 × 3,072 bytes = **307.2 GB** and does about 154 GFLOP, which is 0.5 FLOP per byte. The H100 balances at 67 ÷ 3.35 = 20 FLOPs per byte, so the query is **memory-bound**: about **92 ms** to read everything against 2.3 ms of arithmetic. Four cards bring the floor to about 23 ms. If 40 queries share one pass, each byte supports 20 FLOPs, so exact search suits offline batches better than single queries.

## How much memory does an HNSW index with M = 16 need for 100 million 768-dimension vectors?
<!-- /learn/vector-search#hnsw -->

FAISS's guide gives d × 4 + M × 2 × 4 bytes per vector: 768 × 4 + 16 × 2 × 4 = **3,200 bytes**, so about **320 GB** in total, at least four H100s just to hold it. Memory grows with M. FAISS's HNSW index also **does not support removing vectors**, which matters when documents change often. In return, search cost grows roughly logarithmically and inserts happen one at a time.

## What does product quantization with 64-byte codes do to 100 million 768-dimension vectors?
<!-- /learn/vector-search#product-quantization -->

Each vector splits into 64 sub-vectors of 12 numbers, and each sub-vector becomes a one-byte index into a 256-entry codebook. The codes take 100,000,000 × 64 = **6.4 GB**, **48 times smaller** than the raw 307.2 GB, and the codebooks only about 0.8 MB. Scoring a code takes 64 table lookups and 63 additions instead of 1,535 operations. PQ is **lossy** and can reorder neighbors, so pair it with an inverted file or rerank the best candidates with full vectors.

## Why fuse keyword and vector results with reciprocal rank fusion instead of adding their scores?
<!-- /learn/vector-search#hybrid-search -->

BM25 scores and cosine scores live on **different scales**, so a weighted sum needs tuning for every collection. RRF uses **ranks only**: each list adds 1 ÷ (k + rank) for each document, with k = 60. A document near the top of both lists beats one that tops only one list. A document that only one retriever finds still gets that share, such as 1 ÷ 61 ≈ 0.0164 for a first place. Hybrid search matters because vectors can miss exact strings like error codes, which BM25 catches.

## You switch to a new embedding model for 100 million chunks. What does the migration cost, and how do you run it safely?
<!-- /learn/vector-search#changing-the-embedding-model -->

Vectors from different models can't be compared, so the **whole corpus must be re-embedded**. At an assumed 1,000 chunks a second per GPU, that is 100,000 GPU-seconds, about **27.8 GPU-hours**, or 1.4 hours on 20 GPUs. Re-embed into a new field, build a new index, switch queries after testing them, then delete the old index. Store the **model name and version** with each vector so a mixed index is visible.

<!-- chapter: rag -->

## Explain retrieval-augmented generation in your own words. What does it give that a plain model lacks?
<!-- /learn/rag#why-retrieve -->

A plain model answers from its weights, which are fixed when training ends, can't look anything up, and keep no source for a claim. RAG adds a **search step before the model writes**: a retriever finds passages likely to help, they go into the prompt, and the model answers from them and cites them by number. Changing a fact means **re-indexing a document instead of retraining**, and every answer can point at its source. Fine-tuning suits tone and format better than facts.

## Halden has 910,000 words of documents, chunked at 300 words with 50 words of overlap. How big is the vector index, and what does that tell you?
<!-- /learn/rag#the-indexing-pipeline -->

Each chunk adds 250 new words, so 910,000 ÷ 250 = **3,640 chunks**. At 1,024 float32 dimensions, the vectors take 3,640 × 1,024 × 4 = 14,909,440 bytes, about **14.9 MB**. That fits in one server's memory many times over. For a corpus this size, **storage is easy and retrieval quality is the hard part**, so effort belongs in parsing, chunking and evaluation.

## Halden's prompt budget is 4,350 tokens on the 70B model. How many requests fit in 148 GB of KV cache, and what if each pasted 100,000 tokens of handbook?
<!-- /learn/rag#the-token-budget -->

At 327,680 bytes per token, 4,350 tokens take about **1.43 GB** per request, so 148 GB holds about **103 requests** at once. Pasting 100,000 tokens would take 32.8 GB per request, leaving room for **about four**. The context window was never the limit here: 4,350 tokens is far below 128,000. **Memory per request** is the real constraint, which is why retrieving five chunks beats pasting the handbook.

## Why does a cross-encoder rerank better than first-stage vector search, and what does it cost?
<!-- /learn/rag#reranking-with-a-cross-encoder -->

Vector search compares precomputed vectors, so the query and chunk are never read together. A cross-encoder **reads the query and one candidate together** and scores their relevance. Reranking BM25's top 1,000 with BERT-large raised MRR@10 on MS MARCO from 16.7 to 36.5, purely by reordering the same candidates. The cost is **one model pass per candidate**: 50 candidates of about 400 tokens means roughly 21,500 tokens read per question, so rerank a short list.

## Why enforce permissions inside each search instead of filtering the final list of chunks?
<!-- /learn/rag#permissions-at-retrieval-time -->

Anything that reaches the prompt can be repeated by the model, and an instruction not to share it won't reliably stop it. Filtering a finished list afterward is weaker: **restricted chunks use up candidate slots**, so fewer allowed chunks survive, and **any search path that skips the filter leaks**. Apply the filter inside every search, resolve the user's groups at query time, and key cached answers by permission groups too.

## A query's only relevant chunk sits at rank 6, and the prompt holds five chunks. How do recall@5 and MRR score it?
<!-- /learn/rag#retrieval-metrics -->

**Recall@5 counts it as a miss**, because the chunk never reached the prompt. **MRR still credits it with 1/6**, because MRR only looks at the rank of the first relevant result. Recall@k matches the question "did the evidence reach the model?", while MRR rewards putting the best result first. With five chunks in the prompt, report recall@5. Measure retrieval separately from answers, since no prompt change fixes a chunk that never arrived.

## An edited policy must be answerable within 15 minutes. How do you keep the index fresh without mixing versions?
<!-- /learn/rag#keeping-the-index-fresh -->

Version each document by content hash and last-modified time. On a change, re-chunk that one document, write the new chunks under the **new version**, switch queries to it, then **delete the old chunks from every index and cache**, so readers see one version or the other. Route changes through a queue and watch **queue lag**, the age of the oldest waiting change, to see whether the 15-minute promise holds. Test deletes by searching for a phrase from a deleted document and expecting zero hits.

<!-- chapter: ai-agents -->

## Explain the difference between a workflow and an agent, and how to pick the simplest design that works.
<!-- /learn/ai-agents#from-a-model-call-to-an-agent -->

In a **workflow**, code fixes the path: models and tools run in a predefined order. In an **agent**, the model directs its own steps, calling a tool, reading the result and deciding what to do next, in a loop until the task ends or a limit stops it. Agents cost more and errors can compound. Use **one call** when the answer is already in the prompt, a **workflow** when the steps are known, and a **loop only when the next step depends on what the model finds**.

## An agent's fixed prompt is 2,000 tokens and each step adds about 1,200. What do ten steps cost in input tokens and KV cache on the 70B model?
<!-- /learn/ai-agents#managing-context -->

Each step resends the whole history. Step 10 reads 2,000 + 9 × 1,200 = **12,800 tokens**, and all ten steps read 20,000 + 1,200 × 45 = **74,000 input tokens**, 3.7 times ten separate calls with the same prompt. At 327,680 bytes per token, step 10 needs about **4.2 GB** of KV cache, so the 148 GB budget holds about 35 such contexts at once. Return less from tools, clear old results, summarise, and keep the prefix stable for caching.

## Why does the agent harness checkpoint the model's reply before running any tool, and how should it build the idempotency key?
<!-- /learn/ai-agents#the-agent-loop -->

If the worker crashes after a tool runs but before its result is saved, the restart must **finish the same recorded call** instead of asking the model again, since a new call might choose differently. Saving the reply and its tool calls first makes that possible. The key combines the **run ID and the recorded call ID**, so a retry sends the same key and the payments service returns its stored result. In the chapter's crash test this gives one refund. A tool that ignores the key issues two.

## The refund tool uses strict mode, yet the agent refunds an order outside the return window. Why didn't the schema stop it?
<!-- /learn/ai-agents#tool-calling -->

Strict mode only makes the arguments **match the schema**, so missing fields and wrong types go away. It **cannot express business rules** such as "only if the order was delivered within the return window." A rule in the system prompt is only a request. The tool, or the payments service behind it, has to **check the rule itself** and refuse the call when it fails, returning an error the model can act on.

## A chat answer uses 5,000 tokens. What do an agent and a multi-agent system cost at 10,000 tasks a day and $5 per million tokens?
<!-- /learn/ai-agents#multi-agent-systems -->

Using Anthropic's reported multiples, an agent uses about 4 times the tokens of a chat (20,000) and a multi-agent system about 15 times (75,000). At 10,000 tasks a day, chat costs about **$250 a day** and multi-agent about **$3,750**, or 2.5 cents against 37.5 cents per task. Multi-agent suits heavily parallel tasks whose information exceeds one context window. **Start with one agent**, and split only when the parts are independent and the task is worth the tokens.

## An agent succeeds on 90% of single tries. Why isn't that the number to trust?
<!-- /learn/ai-agents#measuring-agents -->

A single-try rate hides **inconsistency**. If tries are independent, all eight succeed with probability 0.9^8 ≈ **0.43**. τ-bench measured this as pass^k: its best function-calling agent averaged above 60% success per task, but its **pass^8 fell below 25%**. Also track **cost per successful task**, checked on the final state: 1,000 runs at $0.10 with 600 successes is about $0.17 per success.

<!-- chapter: ai-evals-and-observability -->

## Explain in your own words why status codes and ordinary unit tests fall short for a model-backed feature.
<!-- /learn/ai-evals-and-observability#why-ai-systems-need-evals -->

A 200 only means the call completed. A refusal or a reply cut off at the token limit also arrives as a 200, and the most damaging failures, such as a fluent answer with the wrong number, look like success. Exact-equality tests reject correct rewordings. Outputs also vary between runs, even at temperature 0: one prompt sent 1,000 times gave 80 distinct completions, because GPU kernels add numbers in an order that depends on batch size. So **a single run is one sample**, and checks must **judge meaning** across repeated runs.

## How many eval cases do you need to trust a change in pass rate around 80%?
<!-- /learn/ai-evals-and-observability#how-many-cases -->

The 95% margin of error is about 1.96 × √(p × (1 − p) ÷ n). At 80%, **100 cases give about ±7.8 points** and **400 cases give about ±3.9**. A 100-case set catches a big break, such as 80% falling to 65%, but cannot show that a 3-point change is real. Detecting a few points takes **hundreds of cases**, compared on the same cases, and it helps to list which cases flipped.

## What biases does an LLM judge have, and how do you reduce them?
<!-- /learn/ai-evals-and-observability#model-graded-evaluation -->

From the MT-Bench study:

- **Position:** GPT-4 kept its verdict after swapping answers in only 65% of comparisons.
- **Verbosity:** Claude-v1 and GPT-3.5 preferred padded answers in 91.3% of cases.
- **Weak reasoning:** on math, GPT-4 accepted wrong answers 70% of the time, falling to 15% with a reference answer.

Fixes: **judge both orders** and treat disagreement as a tie, give a reference answer, add few-shot examples, use a different model from the one that wrote the answer, and calibrate against human labels.

## You judge 1% of a million daily requests with a model. What does it cost, and how big a daily move is noise?
<!-- /learn/ai-evals-and-observability#sampled-judging -->

10,000 judge calls at 1,500 input and 150 output tokens each is 15 million input and 1.5 million output tokens. At assumed prices of $3 and $15 per million, that is **$67.50 a day**. Sampling adds noise: 500 judged answers at a 90% pass rate give about ±2.6 points per day, and **about ±3.7 points** on the difference between two days. Alert on sustained drops over several days, and run the judging off the request path.

## Prompt v2 looks better than v1, yet single runs of 12 graded answers can't tell them apart. Why, and what do you do?
<!-- /learn/ai-evals-and-observability#comparing-two-prompt-versions -->

Twelve pass-or-fail results per run are **too few to separate the two**. Across five seeds, v1 scored 42% to 75% and v2 scored 75% to 83%, so one v1 seed matched v2's lowest. Before shipping, **add cases and repeats**, and list which cases flipped between pass and fail, since the flips often say more than the headline number. Decide gate rules, such as "no safety case may regress", before the run.

## What should a model-call span record by default, and what should it leave out?
<!-- /learn/ai-evals-and-observability#the-genai-attributes -->

Record **metadata**: the operation name, the model that actually answered, input and output tokens, cache-read tokens, finish reasons, temperature and max tokens, and time to first chunk when streaming. Add your own prompt, index and grader versions so dashboards can be sliced by version, but keep those out of metric labels. Full input and output messages are **opt-in**, since they likely contain personal data. Store content only for a small sample, redacted, restricted and kept briefly. The OpenTelemetry GenAI names are still marked Development, so treat them as provisional.

<!-- chapter: ai-security -->

## Explain prompt injection in your own words, and why it has no complete fix.
<!-- /learn/ai-security#prompt-injection -->

A model reads one stream of text holding the developer's instructions, the user's question and any fetched content, and it has **no separate channel for instructions**. So any text it reads can steer it. In **direct** injection the attacker types into the chat. In **indirect** injection the instructions sit in a page, email or comment the app later feeds the model, and the attacker never talks to it. Models follow instructions wherever they appear, so the NCSC, OWASP and OpenAI all doubt it can be fully solved. Design so a **successful injection can do little harm**.

## How does the dual LLM pattern limit prompt injection, and what does a stronger version cost?
<!-- /learn/ai-security#separate-the-model-that-reads-from-the-model-that-acts -->

A **privileged** model takes the user's instructions and holds the tools but never reads untrusted text. A **quarantined** model reads untrusted text and has no tools. Plain-code **controller** logic keeps untrusted text in named variables, so the privileged model can refer to it without seeing it. Willison noted it isn't fully reliable. CaMeL goes further by fixing the control flow from the trusted query, and on AgentDojo it solved **77% of tasks with provable security against 84% undefended**, a 7-point price for the guarantee.

## In Crumb's tool gate, which model-requested calls run freely and which need a person?
<!-- /learn/ai-security#ask-a-person-before-a-risky-action -->

- **Unknown tools:** denied by default until someone classifies them.
- **Reads:** run freely, since they change nothing outside the session.
- **Writes:** run freely in a clean session, but need approval once the session is **tainted** by untrusted text.
- **External sends:** always need a person.

The approval screen must show the **exact action**, recipient and full body, since a model-written summary can be shaped by injected text. Asking before every search would train people to click yes without reading.

## Why can a prefix cache shared across customers leak prompts?
<!-- /learn/ai-security#logs-traces-and-caches -->

Prefix caching reuses KV cache for identical token sequences, so a request whose prefix someone else recently sent **comes back faster**. That timing difference is a **side channel**: a measurable effect that reveals what another user asked. An NDSS 2025 paper described this attack on multi-tenant serving and named SGLang and vLLM as using the mechanism. Keep prefix caches **inside one tenant**. Logs and traces copy prompts too, so redact, keep retention short and restrict access.

## How should an app handle text a model writes before it reaches a browser or a database?
<!-- /learn/ai-security#handling-model-output-safely -->

Treat the model like **any other untrusted user**:

- **HTML:** escape the reply, or a `<script>` in it becomes stored XSS. Markdown needs a sanitizer with an allowlist of tags, and URLs need a scheme check, since `javascript:` runs code with no tag.
- **Queries:** don't let the model write SQL. Ask for JSON such as `{"cuisine": "thai"}`, check it against a fixed list and pass it as a parameter.
- **Images and links:** don't load external images from model output, since the URL can carry data out.

## A 20-step agent run starts at 10,000 tokens and adds 1,000 per step. What does it cost at $3 per million input tokens, and where do you cap it?
<!-- /learn/ai-security#where-the-money-goes -->

The run processes 20 × 10,000 + 1,000 × 190 = **390,000 input tokens**, about **$1.17**, the same as 195 chat turns of 2,000 tokens at $0.006 each. A looping bug or an attacker burns money the same way. Put limits at several levels: tokens per request; steps, tool calls and input tokens per run; token-based limits per user or key; concurrent requests per tenant; and a team budget with a kill switch. Enforce the run cap in code **before** each model call, so the call that would go over is never sent.

<!-- chapter: training-infrastructure -->

## Explain in your own words how a training step differs from an inference step.
<!-- /learn/training-infrastructure#training-compared-with-inference -->

An inference step reads the weights and never changes them. A training step runs a **forward pass** to measure the loss, a **backward pass** to compute a gradient for every weight, and an **optimizer step** that updates every weight. That costs about 6 FLOPs per parameter per token instead of 2, and it stores state inference never touches: gradients and the optimizer's running averages. Training is also **synchronous**, so one slow or failed GPU holds back every other GPU in the group.

## Estimate the GPU time to train an 8B model on 15 trillion tokens at 40% MFU on H100s.
<!-- /learn/training-infrastructure#a-worked-estimate-8b-on-15-trillion-tokens -->

Work = 6 × 8 × 10^9 × 15 × 10^12 = **7.2 × 10^23 FLOPs**. Each GPU delivers 0.40 × 989 TFLOPS ≈ 3.956 × 10^14 FLOP/s, so the job takes about **505,561 GPU-hours**, or roughly 21 days on 1,000 GPUs if nothing fails. The Llama 3 model card reports 1.3 million GPU-hours, about 2.6 times the estimate. Restarts, checkpoints and data stalls add hours the formula leaves out, so treat 40% as optimistic.

## Where do the 16 bytes per parameter of mixed-precision Adam training go, and what does that mean for a 70B model?
<!-- /learn/training-infrastructure#memory-for-training -->

- 16-bit weights: 2 bytes
- 16-bit gradients: 2 bytes
- 32-bit master weights: 4 bytes
- Adam momentum and variance: 4 bytes each

For 70B that is 70 × 10^9 × 16 = **1,120 GB** of model state, eight times the 140 GB of BF16 weights, and at least **14 H100s** before any activations. Even the 8B model needs 128 GB, more than one H100.

## Training the 70B model on 64 GPUs, how much model state does each GPU hold at each ZeRO stage?
<!-- /learn/training-infrastructure#data-parallelism-and-sharding -->

With Ψ = 70 × 10^9 and N = 64:

- **Plain data parallelism:** 1,120 GB on every GPU.
- **Stage 1** (optimizer states sharded): 4Ψ + 12Ψ/N ≈ 293 GB.
- **Stage 2** (plus gradients): 2Ψ + 14Ψ/N ≈ 155 GB.
- **Stage 3** (plus weights): 16Ψ/N = **17.5 GB**.

Only stage 3 leaves room for activations on an 80 GB card. It moves about 1.5 times the communication of plain data parallelism, so keep its all-gathers on fast links.

## With the Llama 3 interruption rate, how often should you checkpoint, and what does asynchronous checkpointing change?
<!-- /learn/training-infrastructure#failures-and-checkpoints -->

419 unexpected interruptions in 54 days gives a mean of about **185.6 minutes** between them. Daly's rule sets the interval at √(2δM) − δ. With a 2-minute stall, that is √(2 × 2 × 185.6) − 2 ≈ **25.2 minutes**, and a failure loses about 12.6 minutes of work. Asynchronous checkpointing stalls training only for the copy to CPU memory. At an assumed 10 seconds, the interval drops to about **7.7 minutes** and the loss per failure to about 3.8 minutes.

## How many weights does a rank-8 LoRA adapter train on a 4,096 × 4,096 matrix, and what is the catch after training?
<!-- /learn/training-infrastructure#fine-tuning -->

LoRA freezes W and learns a low-rank change BA. A full update has 16,777,216 weights, while rank 8 trains 8 × (4,096 + 4,096) = **65,536**, about **0.39%**. The frozen base still needs its weights in memory: 16 GB for 8B in BF16, or 140 GB for 70B, which QLoRA's 4-bit base cuts to 35 GB. After training, BA can **merge into W with no added latency**, but a merged model then serves only that one adapter.
