# Running inference at scale

A model server on one machine answers quickly while its requests fit in its GPUs. A product needs many servers, and a fleet of GPU servers differs from the web fleet in the [load balancing](/learn/load-balancing) chapter. A recipe page on Crumb, the recipe site from earlier chapters, takes about 20 ms and frees its server. A reply from a large model holds GPU memory for seconds, and each server's cache decides how much work its next request needs. So open requests stop measuring load, and the choice of server changes what a request costs.

This chapter answers five questions:

- What makes a fleet of GPU servers different from a fleet of web servers?
- How should a router pick a server when each server's cache matters?
- How do you autoscale when a new server takes minutes to become ready?
- When should prefill and decode run on separate machines, and how do urgent and patient work share GPUs?
- What happens to requests when a GPU fails?

The examples use the running example: Llama 3.1 70B with BF16 weights (2 bytes per number) on four H100 GPUs, split by tensor parallelism, which divides each layer's matrix multiplications across the GPUs. The weights take about 140 GB. After 10% of the 320 GB is kept free, about 148 GB remains for the KV cache, which stores the keys and values of past tokens. That holds about 450,000 tokens. We call one copy of a model on its own GPUs a **replica**.

## From one server to a fleet

A recipe page is short. A reply on the running example is long. Decoding makes one token per step, and with 64 users each user gets about 74 tokens a second. A 500-token reply takes 500 ÷ 74 ≈ 6.8 seconds, and it holds a batch slot and cache for all of that time. A 2,000-token conversation holds 2,000 × 327,680 bytes ≈ 655 MB.

So a replica is limited by memory and batch slots, and least connections ignores that. Two replicas with 40 open requests each can hold very different amounts of cache. Forty 500-token chats hold 40 × 500 × 327,680 bytes ≈ 6.6 GB. Forty 4,096-token documents hold about 53.7 GB, eight times as much.

The Kubernetes Gateway API Inference Extension calls a set of replicas an InferencePool and sends each request to an endpoint picker, which chooses one replica. That picker is the router in this chapter.

```diagram
title: One request passes a gateway, then a router that reads each replica's state.
[cl:client] Clients @ 0,1
[gw] Gateway\nauth and limits @ 1,1
[rt] Router\nqueue and cache @ 2,1
[a] Replica A\n4 GPUs @ 3,0
[b] Replica B\n4 GPUs @ 3,1
[c] Replica C\n4 GPUs @ 3,2
cl -> gw : HTTPS
gw -> rt
rt -> a
rt -> b
rt -> c
```

## Routing requests

Round robin assumes every request costs the same. Least connections assumes an open connection means the same work everywhere. Better signals come from the engine. vLLM publishes `vllm:num_requests_waiting` (requests queued, not yet running) and `vllm:kv_cache_usage_perc` (the fraction of cache in use) as Prometheus metrics. Queue length says how long a new request waits, and cache usage says whether a long prompt fits.

The llm-d router's endpoint picker weighs KV-cache locality, load and priority, according to its README. The Gateway API Inference Extension's README, read in October 2026, says its endpoint picker has moved to llm-d. Both projects are changing quickly, so check their status before you depend on either.

Routing needs more than load because of prefix caching. An engine that holds a prompt's shared beginning, such as a system prompt, skips prefilling it. A 1,500-token system prompt costs 1,500 × 140 GFLOP = 210 TFLOP to prefill (a TFLOP is a trillion floating-point operations): about 53 ms at full compute on four H100s, or 106 ms at 50%. But that cache lives on one replica, and a request sent elsewhere pays again.

The gain can be large. In December 2024, the SGLang team reported that its cache-aware router, released in v0.4, raised throughput from 82,665 to 158,596 tokens a second and cache hits from 20% to 75%. The run used 8 A100 80 GB GPUs, Llama 3.1 8B and a synthetic shared-prefix workload. The table compares v0.3 with v0.4, so these are release-to-release gains.

A router can't see each replica's cache without a round trip per request. SGLang's router keeps an approximate radix tree (a tree of prompt prefixes) for each worker, built from the requests it routed. Its current docs make `cache_aware` the default, which balances cache locality against load. They also warn that the tree isn't shared across router replicas, which can cost 10 to 20 percent of cache hits. Mooncake's Conductor scheduler goes further. It checks each prefill instance's matching cache and picks the lowest estimated time to first token.

A simpler design hashes the prefix or session ID onto a [consistent hashing](/learn/consistent-hashing) ring. Each prefix gets a home replica with no router state, and adding a replica moves only about 1/N of prefixes. The weakness is a hot prefix, such as a system prompt shared by all traffic, which overloads its home. The [hot keys](/learn/consistent-hashing#hot-keys) section's fix sends the overflow to the next replica clockwise. The vLLM production stack's router offers round-robin and session-ID routing, with prefix-aware routing still in progress.

The sketch below routes to the longest cached prefix. It falls back to the least loaded replica when nothing matches, or when the match is on a much busier replica. Each block's hash includes the previous one, so a match on one block implies a match on every earlier block. Blocks are four words here, where engines use tokens.

```python
import hashlib

BLOCK = 4  # words per cache block (real engines use tokens, often 16 per block)


def block_hashes(words):
    """Chain each block's hash onto the last, so a match implies the whole prefix."""
    hashes, prev = [], ""
    for i in range(0, len(words) - BLOCK + 1, BLOCK):
        prev = hashlib.sha256(f"{prev} {' '.join(words[i:i + BLOCK])}".encode()).hexdigest()[:12]
        hashes.append(prev)
    return hashes


def leading_matches(replica_cache, hashes):
    """How many leading blocks of the prompt a replica already holds."""
    return next((i for i, h in enumerate(hashes) if h not in replica_cache), len(hashes))


class PrefixRouter:
    def __init__(self, names, max_imbalance=4):
        self.active = {n: 0 for n in names}      # requests in flight: the load signal
        self.cached = {n: set() for n in names}  # block hashes each replica probably holds
        self.max_imbalance = max_imbalance

    def route(self, prompt):
        hashes = block_hashes(prompt.split())
        score = {n: leading_matches(self.cached[n], hashes) for n in self.active}
        least = min(self.active, key=self.active.get)
        best = max(self.active, key=lambda n: (score[n], -self.active[n]))
        # Take the cache hit unless that replica is much busier than the least loaded one.
        hit_ok = score[best] > 0 and self.active[best] - self.active[least] <= self.max_imbalance
        chosen = best if hit_ok else least
        self.cached[chosen].update(hashes)  # assume the whole prompt is cached afterwards
        self.active[chosen] += 1
        return chosen, score[chosen]


if __name__ == "__main__":
    router = PrefixRouter(["a", "b"])
    system = "You are the support assistant for Acme. Answer briefly and cite the policy page."
    questions = ["How do I reset my password?", "Where is my invoice?", "How do I cancel?",
                 "Can I change my email?", "Why was I charged twice?", "Do you offer refunds?"]
    for q in questions:
        print(router.route(f"{system} {q}"))
    print(router.route("Summarize this 40 page contract for me."))
```

The demo sends six questions sharing a system prompt, then one unrelated request:

```text
('a', 0)
('a', 3)
('a', 4)
('a', 3)
('a', 3)
('b', 0)
('b', 0)
```

Replica `a` takes the first request, since nothing is cached. The third question begins like the first, so it matches four blocks. The sixth goes to `b`, because `a` has five requests in flight and `b` has none, a gap beyond the limit of four. The sketch omits two things a real router needs: lowering `active` when a stream ends, and bounding `cached`. SGLang bounds its tree with `--max-tree-size` and `--eviction-interval-secs`.

## Autoscaling

The signal matters more than the threshold. CPU use says little about a GPU replica, which does the work while the CPU waits. Queue length and time to first token say more about whether users are waiting.

The Kubernetes Horizontal Pod Autoscaler (HPA) sets desired replicas to ceiling(current replicas × current metric ÷ target). Six replicas that each average 6 waiting requests, against a target of 4, give ceiling(6 × 6 ÷ 4) = 9. The HPA evaluates this every 15 seconds by default. For scale-down, it uses the highest desired count from the last 300 seconds, so a short dip doesn't remove replicas the next minute needs. Scale-up has no window.

New replicas arrive late. The next section estimates about 209 seconds for a fresh node on a 10 Gbps link, so a spike at minute zero waits about 15 + 209 = 224 seconds for relief. Four responses follow, and most fleets combine several:

- **Keep headroom.** Run more replicas than average load needs. Each replica is four GPUs, so this is costly.
- **Keep a warm pool.** Hold nodes that already have the image and weights on local disk. A scale-up then pays only for the GPU load and the engine start, about 88 seconds below, while the idle GPUs cost money.
- **Shed or queue low-priority work** while replicas start (see [priorities and fairness](#priorities-and-fairness)).
- **Scale on queue length and time to first token,** which rise as soon as requests start to wait.

## Loading models quickly

A new replica pulls a container image with the serving software and CUDA libraries (NVIDIA's GPU software), downloads the weights, loads them into GPU memory, and starts the engine. Each stage takes seconds to minutes.

The weights come from the Hugging Face metadata for Llama-3.1-70B-Instruct, a gated repository, so you need an approved account to download it. It lists 70,553,706,496 BF16 parameters across 30 files, which is 141.1 GB at 2 bytes each. The other inputs are assumptions to replace with your own measurements: a 10 GB image, a 10 Gbps download link (1.25 GB/s), a local disk reading at 5 GB/s, and a 60-second engine start. Adding the stages with no overlap gives an upper bound.

```diagram
title: A new replica serves nothing until every stage is done (assumed times).
[s1] Metric crosses\ntarget @ 0,0
[s2] Pull image\n8 s @ 1,0
[s3] Download weights\n113 s @ 2,0
[s4] Load to GPUs\n28 s @ 3,0
[s5] Engine starts\n60 s, then ready @ 4,0
s1 -> s2
s2 -> s3
s3 -> s4
s4 -> s5
```

The working is:

- Image: 10 GB ÷ 1.25 GB/s = 8 s
- Weights download: 141.1 GB ÷ 1.25 GB/s = 112.9 s
- Load from disk into GPU memory: 141.1 GB ÷ 5 GB/s = 28.2 s
- Engine start: 60 s
- Total: 8 + 112.9 + 28.2 + 60 = 209.1 s, about 3.5 minutes

The script below computes this for several links, a warm node, and the KV-cache transfer used in the next section.

```python
# Llama 3.1 70B in BF16 on 4 H100 GPUs: cold start and KV transfer, idealized.
GB = 1e9
WEIGHTS = 70_553_706_496 * 2         # 70.55 billion parameters x 2 bytes (Hugging Face metadata)
IMAGE = 10 * GB                      # assumption: serving image size
DISK_READ = 5 * GB                   # assumption: local NVMe read, bytes per second
ENGINE_START = 60                    # assumption: engine init, memory setup, warm-up (seconds)
KV_PER_TOKEN = 2 * 80 * 8 * 128 * 2  # 327,680 bytes: 2 x layers x KV heads x head dim x bytes


def cold_start(link_gbps, warm=False):
    """Seconds until a new replica can serve. The stages are added, not overlapped."""
    if warm:  # image and weights are already on the node's disk
        return WEIGHTS / DISK_READ + ENGINE_START
    download = (IMAGE + WEIGHTS) / (link_gbps * 1e9 / 8)  # Gbps to bytes per second
    return download + WEIGHTS / DISK_READ + ENGINE_START


def kv_transfer_ms(prompt_tokens, link_gbps):
    return prompt_tokens * KV_PER_TOKEN / (link_gbps * 1e9 / 8) * 1000


for gbps in (10, 25, 100):
    print(f"cold start at {gbps:>3} Gbps: {cold_start(gbps):4.0f} s")
print(f"warm node:            {cold_start(0, warm=True):4.0f} s")
for gbps in (25, 800):
    print(f"KV cache of 2,000 tokens over {gbps} Gbps: {kv_transfer_ms(2000, gbps):5.1f} ms")
print(f"prefill of 2,000 tokens at 50% of 4 x 989 TFLOPS: "
      f"{2000 * 140e9 / (4 * 989e12 * 0.5) * 1000:.0f} ms")
```

```text
cold start at  10 Gbps:  209 s
cold start at  25 Gbps:  137 s
cold start at 100 Gbps:  100 s
warm node:              88 s
KV cache of 2,000 tokens over 25 Gbps: 209.7 ms
KV cache of 2,000 tokens over 800 Gbps:   6.6 ms
prefill of 2,000 tokens at 50% of 4 x 989 TFLOPS: 142 ms
```

A 100 Gbps link cuts the download of the image and weights to about 12 seconds, which makes the engine start the largest stage. Four techniques attack the stages:

- **Keep weights near the GPUs,** on node-local disks or a regional cache. ServerlessLLM loads checkpoints through multi-tier storage and places each model where it can start fastest. Its abstract reports 10 to 200 times lower latency than state-of-the-art serverless systems, without naming the baselines.
- **Load shards in parallel.** Each GPU reads only its share of the weights.
- **Give slow starts time.** Kubernetes startup probes exist for "Pods that have containers that take a long time to come into service." Until one succeeds, the liveness and readiness probes wait.
- **Pre-pull images** on every node, so a scale-up skips that stage.

## Separating prefill and decode

Prefill reads the whole prompt in one pass and is compute-heavy: 2,000 tokens need 280 TFLOP. Decode makes one token per step, reading the weights and the cache each time, so it is memory-heavy. On shared GPUs the two interfere. A long prefill delays other users' decode steps. DistServe, an OSDI 2024 paper, calls this "strong prefill-decoding interferences." Splitwise draws the same line: token generation leaves compute idle, even with batching.

The fix runs prefill and decode on different pools. After prefill, the KV cache moves over the network to a decode GPU.

```diagram
title: Prefill and decode run on separate pools. The KV cache moves between them.
[cl:client] Clients @ 0,1
[rt] Router @ 1,1
[p] Prefill pool\ncompute-heavy @ 2,0
[d] Decode pool\nmemory-heavy @ 2,2
cl <-> rt : prompt in, reply out
rt -> p : new prompts
p --> d : KV cache moves
d -> rt : tokens out
```

The cost is the copy. A 2,000-token prompt makes about 655 MB of cache. Over an 800 Gbps link (100 GB/s), the copy takes about 6.6 ms. Over a 25 Gbps link (3.1 GB/s), it takes about 210 ms, longer than the 142 ms of prefill at 50% utilization. A fast link, or a copy that overlaps computation, makes separation pay.

The papers measured different things, so check their setups:

- **DistServe** (OSDI 2024) ran on 4 nodes with 32 A100 80 GB GPUs and 25 Gbps between nodes, against vLLM and DeepSpeed-MII. Its "7.4 times more requests" is against DeepSpeed-MII on chatbot work. Its "12.6 times tighter SLO" is against vLLM on summarization. These are separate comparisons.
- **Splitwise** (arXiv 2023, ISCA 2024) replayed Azure production traces on DGX-A100 and DGX-H100 servers. Its abstract claims up to 1.4 times the throughput at 20% lower cost, or 2.35 times at equal cost and power. Against a DGX-A100 baseline at equal power and cost, the paper reports 2.15 times on the conversation trace.
- **Mooncake** (arXiv 2407.00079), the serving platform for Kimi, pools KV cache across CPU memory and SSDs. Its abstract reports up to 525% higher throughput in certain simulated scenarios, and 75% more requests handled for Kimi on real workloads.

Separation has costs. You size two pools, and the right split moves with the mix of prompt and reply lengths. Short prompts gain little, and a lost decode machine takes its cache with it. A simpler option is [chunked prefill](/learn/inference-engines#chunked-prefill), which interleaves long prompts with decode steps on one pool.

## Serving many models

Serving many models means several base models in separate pools, with the gateway routing by model name, and many fine-tunes of one base model through LoRA adapters. RouteLLM goes further and chooses between a stronger and a weaker model during inference. Its abstract reports cost reductions of over 2 times in certain cases, without compromising quality.

A LoRA adapter is a small pair of matrices added to frozen base weights. Take Llama 3.1 8B: 32 layers, model dimension 4,096, 32 attention heads and 8 KV heads (Table 3 of the Llama 3 paper), so each head has dimension 128. Put a rank-16 adapter on the query and value projections. A rank-r adapter on a d_in × d_out matrix adds r × (d_in + d_out) parameters. Queries add 16 × 8,192 = 131,072. Values, with 8 KV heads of 128 making 1,024 outputs, add 16 × 5,120 = 81,920. That is 212,992 per layer, or 6,815,744 across 32 layers, about 13.6 MB in BF16. The base model is about 16 GB, so an adapter is roughly a thousandth of it.

S-LoRA keeps all adapters in main memory, moves the ones that running requests need onto the GPU, and batches different adapters with custom kernels. Its abstract reports thousands of adapters on one or several GPUs, and up to 4 times the throughput of HuggingFace PEFT and of vLLM's early LoRA support. Punica batches different LoRA models in one CUDA kernel over a shared base model. Its abstract reports 12 times the throughput of state-of-the-art systems on a fixed GPU cluster, at 2 ms of extra latency per token.

Adapters make placement a routing problem: send adapter X to a replica that has it loaded. The Gateway API Inference Extension's README lists "LoRA Adapters availability" among its signals.

## Priorities and fairness

A person in a chat waits for the first token. A nightly summary waits for nothing. Serve the first first, and use spare capacity for the second. The llm-d endpoint picker weighs priority, and the Gateway API Inference Extension's roadmap lists "Fairness and priority between workloads within the same criticality band" as future work.

Admission control turns away work that can't meet its target. Mooncake's Conductor rejects a request on arrival, with HTTP 429 (Too Many Requests), when predicted latency would break its SLO (the latency target), before any prefill work is spent. In a replay of 23,000 requests on 8 prefill and 8 decode instances, the baseline rejected 4,183, early rejection 3,771, and prediction-based early rejection 3,589. Early rejection wastes less work, but the fleet still rejects, so plan capacity for that.

Limit tokens, not requests, because a tenant sending 100,000-token prompts uses far more prefill and cache than one sending 500-token chats. The [token bucket](/learn/rate-limiting#token-bucket) works with tokens as its unit. When the cache fills, the engine preempts a running request and resumes it later, at the cost of recomputation (see [managing KV cache memory](/learn/inference-engines#managing-kv-cache-memory)).

## When GPUs fail

Hardware fails often at fleet scale. Meta's Llama 3 paper reports a 54-day pre-training run on 16,000 GPUs with 466 job interruptions, 419 of them unexpected, and about 78% of the unexpected ones attributed to confirmed hardware issues. That is one interruption every 2.8 hours (1,296 hours ÷ 466). The run was training, and the failure modes carry over to serving. Plan for a replica to vanish in the middle of a request.

Health checks must exercise the engine, because a process can answer a ping while its GPU has faulted. A small generation test catches more. A failed Kubernetes readiness probe removes the pod from matching Services, and a liveness probe that fails past its tolerance restarts the container. Passive checks, which watch real errors, catch what probes miss (see [health checks](/learn/load-balancing#health-checks)).

If a replica dies after the user has seen part of a reply, the answer depends on what was sent:

1. If no token reached the client, retry on another replica. The prefill repeats, but the client has seen nothing, so the retry is safe.
2. If tokens reached the client, send the prompt plus those tokens to another replica and ask it to continue. Sampling is random, so the continuation may differ, which suits chat but not exact reproduction.
3. If the gateway didn't keep the partial reply, or the product needs an exact answer, return an error and let the client retry.

Retries are safe for a chat reply. They are unsafe once the model has called a tool that changes state, so give those calls an [idempotency key](/learn/reliability-patterns#idempotency-keys). Tensor parallelism also widens the failure, since one GPU's loss stops all four. Treat a replica's GPUs as one unit for health checks and restarts.

## Offline batch inference

Some work has no user waiting, such as evaluations or nightly summaries. Throughput matters, and latency doesn't. Batch APIs trade latency for price. The OpenAI Batch API guide, read in October 2026, says each batch completes within 24 hours ("and often more quickly"), allows up to 50,000 requests per batch, and accepts input files up to 200 MB. The long window lets the provider fill spare capacity, and each provider sets its own price.

Batch work can run a larger decode batch, because each step reads the weights once however many sequences share it. For weights alone, the H100's compute and memory traffic balance at about 295 FLOPs per byte, which for BF16 weights means about 295 sequences. The KV cache changes that. At 2,000 tokens, reading one sequence's cache takes about 49 µs per step, more than its 35 µs of arithmetic, so decode stays memory-bound at any batch size. The cache also caps the batch at 450,000 ÷ 2,000 = 225 sequences. An idealized step at that size reads 141.1 GB of weights and 225 × 2,000 × 327,680 bytes ≈ 147.5 GB of cache, 288.6 GB in all. At 4 × 3.35 TB/s, that takes about 21.5 ms, so 225 ÷ 0.0215 ≈ 10,400 tokens a second. The 64-user interactive case gave about 4,700.

At an assumed $3.00 per H100-hour (real prices vary by provider and commitment), a four-GPU replica costs $12 an hour. That is about $0.32 per million tokens at 10,400 tokens a second with full utilization, or $0.71 at 4,700. Real fleets run below full utilization, so real costs are higher. The [AI estimation chapter](/learn/ai-estimation#cost-per-million-tokens) does this arithmetic in full.

A separate batch pool never competes with interactive traffic, but it sits idle without batch work. A shared pool uses the slots that interactive traffic leaves, but its scheduler must admit interactive requests first and cap batch memory.

## Check yourself

<details>
<summary>A new replica of the 70B model starts on a node with a 25 Gbps download link, a 10 GB image, a 5 GB/s local disk and a 60-second engine start. Estimate the time until it serves, and name the largest stage.</summary>

The image and weights download in (10 + 141.1) GB ÷ 3.125 GB/s ≈ 48.4 s. Loading from disk takes 28.2 s, and the engine start is 60 s. The total is about 137 s, or 2.3 minutes. The engine start is the largest stage.

</details>

<details>
<summary>Two replicas both show 40 open requests. Replica A's KV cache is 90% full and B's is 30% full. Where should the next long request go, and why would least connections get this wrong?</summary>

B, which has room for a long prompt. Least connections sees a tie, but 40 requests can hold very different amounts of cache. The KV usage and queue length metrics show what the connection count hides.

</details>

<details>
<summary>A prefix-aware router sends every request with the same 1,500-token system prompt to replica A, whose queue grows while B is idle. Name two changes and what each costs.</summary>

Lower the imbalance limit (the sketch's `max_imbalance`) so requests spill to B sooner, though each spill repeats the 1,500-token prefill, about 53 ms of compute. Or use a consistent hashing ring with bounded loads, which moves only the overflow, and that overflow loses its cache.

</details>

<details>
<summary>A four-GPU replica loses one GPU while a reply is 200 tokens into a 600-token answer. What happens to the replica, and what can the client see?</summary>

All four GPUs are needed, so the replica fails, and its readiness probe removes it from routing. The gateway can resend the prompt plus the 200 tokens to another replica, which may write a different continuation, or it can return an error. The client sees a pause, then either a continuation or an error.

</details>

<details>
<summary>Interactive time to first token at p99 rises from 0.5 to 3 seconds, but time per output token is unchanged. Long documents are a growing share of traffic. What would you check, and what would you consider changing?</summary>

Check the prefill queue wait and the prompt length distribution. Decode is healthy, so long prompts are queuing ahead of new arrivals. Consider prefix caching, chunked prefill, or a separate prefill pool, after checking that the KV transfer fits the link.

</details>

<details>
<summary>Someone proposes running a nightly job of 50,000 summaries on the interactive replicas to avoid buying GPUs. What limits that job on one replica, and what is the main risk?</summary>

The KV cache caps the batch at about 225 sequences of 2,000 tokens. The main risk is interactive latency, since a large batch and long prefills take the memory and compute chat users need. Run the job at lower priority with a cap on its cache share, or use a batch API.

</details>

## Further reading

Papers:

- [DistServe](https://arxiv.org/abs/2401.09670): disaggregated prefill and decode, with the setups behind its numbers.
- [Splitwise](https://arxiv.org/abs/2311.18677): phase splitting on production traces.
- [Mooncake](https://arxiv.org/abs/2407.00079): KV-cache-centric disaggregation and its scheduler.
- [S-LoRA](https://arxiv.org/abs/2311.03285): thousands of LoRA adapters with unified paging.
- [Punica](https://arxiv.org/abs/2310.18547): batching requests for different LoRA models.
- [ServerlessLLM](https://arxiv.org/abs/2401.14351): multi-tier checkpoint loading for cold starts.
- [RouteLLM](https://arxiv.org/abs/2406.18665): routing between a stronger and a cheaper model.
- [The Llama 3 Herd of Models](https://arxiv.org/abs/2407.21783): Table 3 and the interruption statistics in section 3.3.4.

Documentation, code and data:

- [Llama-3.1-70B-Instruct](https://huggingface.co/meta-llama/Llama-3.1-70B-Instruct): the gated model page, with the parameter metadata.
- [NVIDIA H100](https://www.nvidia.com/en-us/data-center/h100/): memory and bandwidth of the SXM module.
- [SGLang Model Gateway](https://docs.sglang.io/advanced_features/sgl_model_gateway.html): cache-aware routing and its thresholds.
- [SGLang v0.4 post](https://lmsys.org/blog/2024-12-04-sglang-v0-4): the cache-aware benchmark and its workload.
- [llm-d router](https://github.com/llm-d/llm-d-router): an endpoint picker that weighs cache, load and priority.
- [Gateway API Inference Extension](https://gateway-api-inference-extension.sigs.k8s.io/concepts/api-overview/): the InferencePool resource. Its [repository](https://github.com/kubernetes-sigs/gateway-api-inference-extension) has the status and roadmap.
- [vLLM production stack](https://github.com/vllm-project/production-stack): the router's routing options.
- [vLLM metrics](https://docs.vllm.ai/en/stable/usage/metrics.html): the metric names used here.
- [Kubernetes HPA](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/): the formula, the sync period and the stabilization window.
- [Kubernetes probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/): startup, readiness and liveness semantics.
- [OpenAI Batch API guide](https://developers.openai.com/api/docs/guides/batch): the completion window and request limits.
