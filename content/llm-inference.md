# How LLM inference works

Inference is the work a model server does for each request. It takes the prompt, runs a trained model, and returns the reply. Training happens once, in a separate and much larger job. Inference runs for every message a user sends, so its speed and cost decide what a product can offer.

A large language model (LLM) predicts the next token of a sequence. A token is a short piece of text, often a word or part of one. Hugging Face's guide to chat templates puts the idea this way: "All causal LMs, whether chat-trained or not, continue a sequence of tokens." An answer therefore comes out one token at a time, and each token depends on every token before it.

This chapter defines the vocabulary the rest of the AI part uses: prefill and decode, the KV cache (the keys and values an attention step keeps for every token so far), time to first token (TTFT, the wait before the first answer token) and time per output token (TPOT, the average gap between later tokens). Each one gets a concrete example before the general rule. The running example is Meta's Llama 3.1 family, with 8B, 70B and 405B parameters (the learned numbers inside the model). The Llama 3 paper publishes the shape of each size, and the memory arithmetic depends on those shapes.

For GPU hardware, serving engines and fleet sizing, see [GPUs and accelerators](/learn/gpus-for-ai), [inference engines](/learn/inference-engines) and [estimating AI workloads](/learn/ai-estimation).

## Tokens

A tokenizer splits text into pieces called tokens and maps each piece to an ID in a fixed vocabulary. The model reads and writes IDs, never letters, and a detokenizer turns IDs back into text.

The OpenAI Cookbook's token-counting notebook shows how tiktoken, OpenAI's open-source tokenizer library, splits the sentence "tiktoken is great!" under its o200k_base encoding:

```text
Token  ID    Piece
1      83    "t"
2      8251  "ikt"
3      2488  "oken"
4      382   " is"
5      2212  " great"
6      0     "!"
```

Six tokens cover three words and a punctuation mark. Each space attaches to the token after it (" is", " great"). Even "tiktoken" splits into "t", "ikt" and "oken", so token counts and word counts differ. Under cl100k_base, the single word "antidisestablishmentarianism" becomes six tokens.

The merge rules come from byte pair encoding (BPE). tiktoken's README calls BPE a way of converting text into tokens, and its educational module shows the procedure: count adjacent pairs, merge the most frequent pair into a new token, and repeat. Sennrich and colleagues used the same idea to split rare words for machine translation. The script below runs the procedure on a tiny corpus, starting from characters rather than bytes.

```python
from collections import Counter

def apply_merge(pieces, pair):
    out, i = [], 0
    while i < len(pieces):
        if i + 1 < len(pieces) and (pieces[i], pieces[i + 1]) == pair:
            out.append(pieces[i] + pieces[i + 1])
            i += 2
        else:
            out.append(pieces[i])
            i += 1
    return out

def learn_merges(text, num_merges):  # start from characters, merge the most common pair
    words, merges = Counter(tuple(w) for w in text.split()), []  # word -> count
    for _ in range(num_merges):
        pairs = Counter()
        for word, freq in words.items():
            for pair in zip(word, word[1:]):
                pairs[pair] += freq
        if not pairs:
            break
        best = max(pairs, key=pairs.get)  # ties go to the pair seen first
        merges.append(best)
        new_words = Counter()
        for word, freq in words.items():
            new_words[tuple(apply_merge(list(word), best))] += freq
        words = new_words
    return merges

merges = learn_merges("low low low lower lower newest newest widest", 4)
print("merges:", ["".join(p) for p in merges])
# merges: ['lo', 'low', 'es', 'est']
for word in ["lowest", "widest"]:  # encode: apply the merges in learned order
    pieces = list(word)
    for pair in merges:
        pieces = apply_merge(pieces, pair)
    print(word, "->", pieces)
# lowest -> ['low', 'est']
# widest -> ['w', 'i', 'd', 'est']
```

The first merge is "lo", because the pairs l-o and o-w tie at five and the first one counted wins. Encoding applies the merges in the order they were learned, so "lowest" becomes "low" and "est". Frequent pieces become single tokens, and rare text falls back to smaller pieces, so any input can be encoded.

Llama 3's vocabulary has 128K tokens: 100K from tiktoken plus 28K added for better non-English coverage, according to its paper. On every pass the model produces one score per vocabulary entry. A softmax, which turns scores into probabilities that sum to one, converts them into next-token probabilities.

Tokens matter here for four reasons. Context windows count tokens. Providers price input and output by the token, and Anthropic's documentation lists those prices for each model. Decode makes one pass per output token, so output length sets the work. And each token adds a fixed slice to the KV cache.

## From prompt to answer

A chat request is a list of role-tagged messages. The server renders that list into one token sequence. A chat template adds control tokens that mark where each message starts and ends. Hugging Face's guide says the messages become "a token sequence, often with control tokens," which let the model see the chat structure.

The model then runs in three stages.

1. **Prefill.** The server runs the model once over every prompt token. This builds the key-value (KV) cache for the prompt and produces scores for the first answer token.
2. **Decode.** The server picks one token from the scores, appends it, runs the model on that one new token using the cache, and repeats until a stop condition is met.
3. **Detokenize.** The server turns the output IDs back into text and returns or streams them.

```diagram
title: One request on the server. Prefill runs once, then decode repeats.
[tok] Tokenizer @ 0,0
[pre] Prefill\nall prompt tokens @ 1,0
[dec] Decode\none token per pass @ 2,0
[out] Detokenize\nand stream @ 3,0
[kv:store] KV cache @ 1.5,2
tok -> pre : token IDs
pre -> dec : scores for token 1
dec -> out : each token
pre --> kv : write
kv <-> dec : read, add
```

### The transformer at a glance

Llama 3 uses what its paper calls "a standard, dense Transformer architecture," and Meta describes it as a decoder-only model. Decoder-only means each position attends only to earlier tokens, which the Transformer paper enforces with a mask on the decoder's self-attention.

The 8B model has 32 layers, the 70B has 80 and the 405B has 126. Each layer has an attention step, where a token gathers information from the tokens before it, and a feed-forward network, which transforms each token's vector on its own. In "The trophy did not fit in the suitcase because it was too big," the word "it" refers back to "trophy," and attention is the step that lets the model make that link. Attention also drives the cost of long prompts: each token compares itself with every earlier token. The Transformer paper's table gives self-attention cost per layer as O(n²·d), where n is the sequence length, so doubling the prompt roughly quadruples that part of the work.

### When generation stops

Generation ends when the model emits its end-of-sequence token, a special token that marks the end of a reply. It also ends at the output limit (max_new_tokens in Hugging Face, which counts "ignoring the number of tokens in the prompt"), at a custom stop string, or when the context window fills. Anthropic's API reports which one happened. end_turn means Claude "finished its response naturally," and max_tokens means it "reached the max_tokens limit specified in your request."

## Prefill and decode

Take a 2,000-token prompt. The server can read all 2,000 tokens in one pass, but writing a 300-token reply takes 300 passes. Prefill is the first pass, over the whole prompt at once. The prompt is known in advance, so the GPU can process all of its tokens together as large matrix operations. Splitwise, a paper about running the two phases on separate machines, calls the prompt phase "a compute-intensive prompt computation." Decode produces the answer one token per pass. Each pass processes only the newest token, but it must read all the weights and the cached keys and values from GPU memory. Splitwise calls this "a memory-intensive token generation." Pope and colleagues put it in hardware terms: each step loads the parameters and KV cache from high-bandwidth memory (HBM) into the compute cores, and at small batch sizes "the time to load weights dominates."

The running example puts numbers on this. It uses a 70B model with BF16 weights (16-bit numbers, 2 bytes each) split across four NVIDIA H100 GPUs with tensor parallelism, which divides each layer's weights among the GPUs. Hugging Face's optimization guide gives the rule of thumb of about 2 GB per billion parameters in bfloat16, so the weights take 140 GB. A FLOP is one floating-point operation. The EleutherAI guide gives the cost of a forward pass as about 2PD FLOPs, where P is the parameter count and D the token count. So one token costs about 2 × 70 × 10^9 = 140 GFLOP.

- **Prefill of 2,000 tokens.** The work is 2,000 × 140 GFLOP = 280 TFLOP. NVIDIA's H100 page lists 1,979 TFLOPS for BF16 with sparsity, and NVIDIA's Hopper architecture post explains that sparsity doubles the rate, so the dense figure is about 989 TFLOPS. Four GPUs give 4 × 989 = 3,956 TFLOPS, so prefill takes 280 ÷ 3,956 ≈ 71 ms at full speed, or about 142 ms at an assumed 50% of peak.
- **Decode for one user.** Each step reads all 140 GB. Four H100s at 3.35 TB/s each give 13.4 TB/s, so a step takes at least 140 ÷ 13,400 ≈ 10.4 ms. That caps one user at about 96 tokens a second (1 ÷ 0.01045 ≈ 95.7). The step's arithmetic, 140 GFLOP, would take about 0.04 ms at full speed, so the step waits almost entirely on memory.

Prefill reads each weight once and applies it to every prompt token, so it does a lot of arithmetic per byte read. Decode reads every weight to produce one token. The GPU chapter explains this with the roofline model, which compares a chip's arithmetic speed with its memory speed. A longer prompt takes longer to prefill, so long prompts raise TTFT.

## The KV cache

Consider one 4,096-token conversation on the 70B model. Its cache takes about 1.34 GB (4,096 × 327,680 bytes, computed below), next to 140 GB of weights.

Each attention step needs the keys and values of every earlier token in every layer. Without a cache, each decode step would recompute them for the whole sequence, "even though the earlier tokens haven't changed," as Hugging Face's KV cache guide puts it. With a cache, each token's keys and values are computed once, stored, and appended to. Hugging Face calls this a trade-off between speed and memory.

The cache size per token follows from the model's shape:

```text
bytes per token = 2 × layers × KV heads × head dimension × bytes per value
```

The leading 2 covers keys and values. The head dimension is the model dimension divided by the number of attention heads, so the 70B model has 8,192 ÷ 64 = 128. Llama 3 uses grouped-query attention (GQA) with 8 key-value heads at every size, so several query heads share each key-value head. The GQA paper describes the key-value heads as "more than one, less than number of query heads." The vLLM paper runs a similar calculation for OPT-13B, a 13-billion-parameter model, and reports 800 KB per token in FP16, which matches 2 × 5,120 × 40 × 2 = 819,200 bytes.

| Model | Layers | KV heads | Head dimension | Bytes per token, BF16 |
|---|---|---|---|---|
| Llama 3.1 8B | 32 | 8 | 128 | 2 × 32 × 8 × 128 × 2 = 131,072 |
| Llama 3.1 70B | 80 | 8 | 128 | 2 × 80 × 8 × 128 × 2 = 327,680 |
| Llama 3.1 405B | 126 | 8 | 128 | 2 × 126 × 8 × 128 × 2 = 516,096 |

```python
# Bytes of KV cache per token: keys and values (the 2), for every layer and KV head.
LLAMA_3_1 = {
    "8B": dict(layers=32, kv_heads=8, head_dim=128),
    "70B": dict(layers=80, kv_heads=8, head_dim=128),
    "405B": dict(layers=126, kv_heads=8, head_dim=128),
}


def kv_bytes_per_token(layers: int, kv_heads: int, head_dim: int,
                       bytes_per_value: int = 2) -> int:
    return 2 * layers * kv_heads * head_dim * bytes_per_value


for name, shape in LLAMA_3_1.items():
    print(f"{name}: {kv_bytes_per_token(**shape):,} bytes per token")
# 8B: 131,072 bytes per token
# 70B: 327,680 bytes per token
# 405B: 516,096 bytes per token

per_token = kv_bytes_per_token(**LLAMA_3_1["70B"])
print(f"70B, one 4,096-token conversation: {4096 * per_token / 1e9:.2f} GB")
# 70B, one 4,096-token conversation: 1.34 GB

cache_budget = 148 * 10**9  # bytes left after the weights, in the running example
print(f"70B cache budget holds {cache_budget // per_token:,} tokens")
# 70B cache budget holds 451,660 tokens

print(f"Without GQA (64 KV heads): {kv_bytes_per_token(80, 64, 128):,} bytes per token")
# Without GQA (64 KV heads): 2,621,440 bytes per token
```

One 4,096-token conversation takes 4,096 × 327,680 = 1,342,177,280 bytes, about 1.34 GB. Without GQA, the 70B model would keep 64 key-value heads, and the same formula gives 2,621,440 bytes per token, eight times as much.

In the running example, four 80 GB H100s hold 320 GB. Keeping an assumed 10% (32 GB) free for activations and runtime, and loading 140 GB of weights, leaves 148 GB for the cache. That holds 148 × 10^9 ÷ 327,680 ≈ 451,660 tokens, about 110 conversations of 4,096 tokens (451,660 ÷ 4,096 ≈ 110).

The cache grows with every token, and each request has its own. The vLLM paper observes that it "grows and shrinks dynamically" and that memory "can be significantly wasted by fragmentation and redundant duplication." The [managing KV cache memory](/learn/inference-engines#managing-kv-cache-memory) and [prefix caching](/learn/inference-engines#prefix-caching) sections of the inference engines chapter cover how engines cope.

## Sampling

Suppose the model has just read "The cat sat on the" and gives "mat" a score 2.0 higher than each of seven other entries. Sampling is the rule that picks the next token from those scores. Four rules matter.

- **Greedy decoding** picks the most likely token each time. Hugging Face calls it the default, and warns that it "breaks down when generating longer sequences because it begins to repeat itself."
- **Sampling** draws the token at random, weighted by its probability.
- **Temperature** divides each score by the temperature before the softmax. The transformers library does this with `scores / self.temperature`. Values below 1 sharpen the distribution, and 0 is "equivalent to shifting all probability mass to the most likely token," which is greedy decoding. Temperature only matters when sampling is on.
- **Top-k and top-p** cut the candidates first. Top-k keeps the K most likely tokens. Top-p keeps "the smallest possible set of words whose cumulative probability exceeds the probability p." The kept probabilities are then rescaled to sum to one.

The script below uses a fake model that scores the right next token 2.0 and every other token 0.0. It shows greedy decoding, sampling at temperature 1, and both stop conditions.

```python
import math
import random

VOCAB = ["The", "cat", "sat", "on", "the", "mat", ".", "<eos>"]
NEXT = {"The": "cat", "cat": "sat", "sat": "on", "on": "the", "the": "mat", "mat": ".", ".": "<eos>"}
def forward(tokens, kv_cache):  # fake model: caches each token, scores the next one
    kv_cache.extend(tokens)  # a real engine stores keys and values per layer
    scores = [0.0] * len(VOCAB)
    scores[VOCAB.index(NEXT[tokens[-1]])] = 2.0  # the right next token scores highest
    return scores

def sample(scores, temperature, rng):
    if temperature == 0:
        return VOCAB[scores.index(max(scores))]  # greedy
    weights = [math.exp(s / temperature) for s in scores]
    return rng.choices(VOCAB, weights=weights)[0]

def generate(prompt, max_new_tokens, temperature):
    rng, kv_cache, output = random.Random(0), [], []
    scores = forward(prompt, kv_cache)  # prefill: the whole prompt in one pass
    while len(output) < max_new_tokens:  # decode: one token per pass
        token = sample(scores, temperature, rng)
        output.append(token)
        if token == "<eos>":  # stop condition 1: end-of-sequence token
            return output, "end-of-sequence", len(kv_cache)
        scores = forward([token], kv_cache)
    return output, "max_new_tokens", len(kv_cache)  # stop condition 2: the limit

for limit, temp in [(10, 0), (3, 0), (10, 1.0)]:
    output, reason, cache = generate(["The"], limit, temp)
    print(" ".join(output), "|", reason, "| cache:", cache)
# cat sat on the mat . <eos> | end-of-sequence | cache: 7
# cat sat on | max_new_tokens | cache: 4
# mat . . on the mat . the mat . | max_new_tokens | cache: 11
for t in (0.5, 1.0, 2.0):
    p = math.exp(2 / t) / (math.exp(2 / t) + len(VOCAB) - 1)
    print(f"temperature {t}: right token {p:.2f}")
# temperature 0.5: right token 0.89
# temperature 1.0: right token 0.51
# temperature 2.0: right token 0.28
```

Greedy decoding writes the whole sentence and stops at the end-of-sequence token, with seven cache entries, one for each token read. A limit of three stops on the limit with four entries, because the newest token has not run through the model yet. At temperature 1 the fake model wanders, and the right token's probability is 0.51. It is 0.89 at temperature 0.5 and 0.28 at 2.0.

For extraction or classification, where one answer is right, use greedy decoding or a low temperature. For brainstorming, use a higher temperature with top-p.

## Streaming the answer

Here is one streamed reply from Anthropic's API, abridged with the ping events removed. Most events carry one piece of the answer.

```text
event: message_start
data: {"type": "message_start", "message": {"id": "msg_...", "role": "assistant", "content": [], ...}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "!"}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, ...}

event: message_stop
data: {"type": "message_stop"}
```

Streaming sends each token as soon as it is decoded, usually as server-sent events (SSE). Anthropic's API uses SSE when a request sets `"stream": true`. MDN describes the format: the content type is text/event-stream, a blank line ends each event, and lines starting with `data:` carry its payload. The connection runs one way, from server to client.

```python
import json

def sse_payloads(lines):  # yields the data field of each event; a blank line ends an event
    data = []
    for line in lines:
        line = line.rstrip("\n")
        if line == "":
            if data:
                yield "\n".join(data)
            data = []
        elif line.startswith("data:"):  # event: and comment lines are ignored
            value = line[5:]
            data.append(value[1:] if value.startswith(" ") else value)

def fake_server():  # stand-in for an HTTP body: one event per token, then a stop event
    for piece in ["Hello", " there", "!"]:
        event = {"type": "content_block_delta", "delta": {"type": "text_delta", "text": piece}}
        yield "event: content_block_delta"
        yield "data: " + json.dumps(event)
        yield ""
    yield "event: message_stop"
    yield 'data: {"type": "message_stop"}'
    yield ""

text = ""
for payload in sse_payloads(fake_server()):
    event = json.loads(payload)
    if event["type"] == "content_block_delta":
        text += event["delta"]["text"]
        print(f"token: {event['delta']['text']!r}")
    elif event["type"] == "message_stop":
        print("stream finished:", repr(text))
# token: 'Hello'
# token: ' there'
# token: '!'
# stream finished: 'Hello there!'
```

Streaming changes when the first token appears. The full answer still takes as long as before, because every decode step still runs. NVIDIA's documentation says time to first token "measures how long you wait before seeing the model's output."

Each hop must forward events as they arrive. A gateway or proxy that buffers the response hides the stream, and the user waits for the whole reply.

```diagram
title: Each hop must forward events as they arrive.
[c:client] Client @ 0,0
[gw] Gateway or proxy @ 1,0
[srv] Inference server @ 2,0
c <-> gw : request, then events
gw <-> srv : prompt, then tokens
```

When the client disconnects, the server should stop decoding, or the GPU keeps producing tokens nobody reads. The [realtime](/learn/realtime) and [protocols and APIs](/learn/protocols-and-apis) chapters cover SSE and other transports.

## Latency and throughput metrics

Picture one response. The request waits in a queue, prefill runs, the first token appears, and then the rest arrive one at a time.

```diagram
title: One response. TTFT covers everything before the first token.
[a:client] Request sent @ 0,0
[b:queue] Queue wait @ 1,0
[c] Prefill of\nthe prompt @ 2,0
[d] First token\nreturned @ 3,0
[e] Decode, one TPOT\nper token @ 4,0
a -> b
b -> c
c -> d
d -> e : rest of the answer
```

Two numbers describe that timeline. NVIDIA's benchmarking documentation, as of October 2026, defines them and two related measures:

- **Time to first token (TTFT)** is "the time from query submission to the first received token, if the response is not empty." It generally includes queueing, prefill and network time.
- **Time per output token (TPOT)**, also called inter-token latency, is "the average time between consecutive tokens," not counting the first. It equals (end-to-end latency − TTFT) ÷ (output tokens − 1).
- **End-to-end latency** is the time from query to full response. It equals TTFT plus the generation time.
- **Throughput** is total output tokens per second across all simultaneous requests.

Other tools define these differently, and NVIDIA notes that results should be compared "only when definitions align." With these definitions, end-to-end latency ≈ TTFT + (output tokens − 1) × TPOT. Assume a TTFT of 200 ms and a TPOT of 13.6 ms, the running example's step time below. A 300-token answer takes 200 + 299 × 13.6 = 4,266.4 ms, about 4.3 seconds.

| Situation | Time per step | Tokens a second, total | Per user |
|---|---|---|---|
| One user | 140 GB ÷ 13.4 TB/s ≈ 10.4 ms | about 96 | about 96 |
| 64 users, 2,000 tokens each | (140 + 42) GB ÷ 13.4 TB/s ≈ 13.6 ms | about 4,700 | about 74 |

The second row's cache reads come to 64 × 2,000 × 327,680 bytes ≈ 42 GB. Each step makes one token per user, so the server makes 64 ÷ 0.0136 ≈ 4,706 tokens a second, or about 74 for each user. The step's arithmetic, 64 × 140 GFLOP ≈ 9 TFLOP, takes about 2.3 ms at full speed, so the step still waits on memory.

Batching raises total throughput about 49 times (4,706 ÷ 96 ≈ 49) and cuts each user's speed by about 23%. The weights are read once per step however many users share it, so each extra user adds mainly its own cache.

Throughput sets cost. Assume $3.00 per H100-hour, so four GPUs cost $12 an hour, or $0.00333 a second. That is about $34.83 per million tokens at 95.7 tokens a second, and about $0.71 at 4,706. Real prices vary by provider and commitment, and these figures ignore idle time and engine overhead. The [cost per million tokens](/learn/ai-estimation#cost-per-million-tokens) section does this properly.

Averages hide slow requests ([performance and latency](/learn/performance-and-latency#averages-hide-the-slow-requests)), so dashboards track percentiles of TTFT and TPOT, such as the 99th percentile, the value that 99% of requests beat. Under load, TTFT rises first, because requests wait in a queue before prefill starts.

## Context windows

Suppose a model's window is 8,192 tokens and a conversation already uses 8,000. The reply can be at most 192 tokens, because the prompt and the reply share one budget. That window is hypothetical. Anthropic's docs define the context window as "all the text a language model can reference when generating a response, including the response itself."

Llama 3.1 has a far larger window. Meta says the 8B and 70B models have "a significantly longer context length of 128K," and the Llama 3 paper says its largest model has "a context window of up to 128K tokens." Taking 128K as 131,072 tokens, a full window limits the 70B model in three ways.

1. **Memory.** One full conversation needs 131,072 × 327,680 bytes ≈ 42.9 GB of KV cache. The 148 GB budget holds three (148 ÷ 42.9 ≈ 3.4).
2. **Compute.** Prefilling a full window takes 131,072 × 140 GFLOP ≈ 18,350 TFLOP. At 50% of four H100s' peak that is 18,350 ÷ 1,978 ≈ 9.3 seconds, before the attention work, which grows faster than the length.
3. **Quality.** Anthropic's docs warn that "as token count grows, accuracy and recall degrade, a phenomenon known as context rot." That is the vendor's own description, so test it on your workload.

Chat multiplies the cost, because each message resends the whole history. Hugging Face's optimization guide says the cache lets a chat "continuously grow the encoded chat history instead of having to re-encode the chat history again from scratch." Without that reuse, every turn repeats prefill over all earlier turns.

At the limit, Anthropic's docs say that an input which alone exceeds the window fails with an error. On newer models, an input plus max_tokens that exceeds the window is accepted, and generation stops at the window with stop reason model_context_window_exceeded. Code should check the budget before sending.

## Check yourself

<details>
<summary>The team serves the 70B model in BF16 with 148 GB of cache. Typical conversations are 8,000 tokens. About how many fit at once?</summary>

One conversation takes 8,000 × 327,680 bytes ≈ 2.6 GB, so 148 ÷ 2.62 ≈ 56 fit. Doubling the length halves the count, because the cache grows linearly with the number of tokens.

</details>

<details>
<summary>A user waits about 6 seconds before the first word of an answer about a 50,000-token document, then tokens stream steadily. Which metric is high, and what do you check first?</summary>

TTFT is high, and TPOT is normal. Prefill dominates: 50,000 × 140 GFLOP = 7,000 TFLOP, about 3.5 seconds at 50% of the four-H100 peak. Check the queue depth first, then whether many requests share this document, since [prefix caching](/learn/inference-engines#prefix-caching) would skip most of that prefill.

</details>

<details>
<summary>You ship invoice extraction as JSON and bakery name suggestions on the same model. Which decoding settings do you use for each?</summary>

Use greedy decoding or a low temperature for extraction, since one answer is right and low temperature keeps the output stable. For names, sample at a higher temperature with top-p, since variety is the goal. Temperature only matters when sampling is on.

</details>

<details>
<summary>A 405B model in BF16 must run with tensor parallelism. Does it fit on 8 H100s, and what is the one-user decode ceiling on 16?</summary>

The weights are 405 × 10^9 × 2 bytes = 810 GB, more than 8 × 80 = 640 GB, so it does not fit. On 16 H100s, each step reads 810 GB at 16 × 3.35 = 53.6 TB/s, about 15.1 ms, so the ceiling is about 66 tokens a second (1 ÷ 0.0151 ≈ 66).

</details>

<details>
<summary>The server streams tokens, but the user sees nothing for 30 seconds and then the whole reply. Where do you look?</summary>

Compare when the first event leaves the inference server with when the client receives it. If the gap is at a gateway or proxy, that hop is buffering the response. Configure it to forward each event as it arrives.

</details>

<details>
<summary>A request carries 7,900 tokens of history, the window is 8,192 tokens, and max_tokens is 1,000. What happens?</summary>

The request needs 7,900 + 1,000 = 8,900 tokens, so only 8,192 − 7,900 = 292 tokens fit for the reply. Depending on the API, the request is rejected, or it is accepted and stops at the window with stop reason model_context_window_exceeded. Check the budget before sending.

</details>

## Further reading

- [The Llama 3 Herd of Models](https://arxiv.org/html/2407.21783): the architecture table, the 128K vocabulary and grouped-query attention.
- [Meta, Introducing Llama 3.1](https://ai.meta.com/blog/meta-llama-3-1/): the 128K context for the 8B and 70B models, and the decoder-only design.
- [Vaswani et al., Attention Is All You Need](https://arxiv.org/html/1706.03762): the Transformer, its self-attention cost, and decoder masking.
- [Sennrich et al., Rare Words with Subword Units](https://arxiv.org/abs/1508.07909): byte pair encoding applied to subword units.
- [tiktoken](https://github.com/openai/tiktoken): OpenAI's tokenizer library, with its BPE explanation and educational merge code.
- [OpenAI Cookbook, How to count tokens with tiktoken](https://raw.githubusercontent.com/openai/openai-cookbook/main/examples/How_to_count_tokens_with_tiktoken.ipynb): the stored outputs behind the token splits above.
- [Patel et al., Splitwise](https://arxiv.org/abs/2311.18677): the compute-intensive prompt phase and the memory-intensive token phase.
- [Pope et al., Efficiently Scaling Transformer Inference](https://arxiv.org/html/2211.05102): why each decode step loads weights and the KV cache from HBM.
- [Kwon et al., PagedAttention](https://arxiv.org/html/2309.06180): the 800 KB per-token cache example for OPT-13B, and how cache memory is wasted.
- [Ainslie et al., GQA](https://arxiv.org/abs/2305.13245): grouped-query attention, with fewer key-value heads than query heads.
- [EleutherAI, transformer math](https://blog.eleuther.ai/transformer-math/): about 2PD FLOPs for a forward pass.
- [Hugging Face, Optimizing LLMs for Speed and Memory](https://huggingface.co/docs/transformers/en/llm_tutorial_optimization): the 2 GB per billion parameters rule, and how cache memory grows.
- [Hugging Face blog on the KV cache](https://huggingface.co/blog/kv-cache): prefill, decode and the speed and memory trade-off.
- [Hugging Face, How to generate text](https://huggingface.co/blog/how-to-generate): greedy search, sampling, top-k and top-p, with examples.
- [Hugging Face, Generation strategies](https://huggingface.co/docs/transformers/en/generation_strategies): greedy decoding as the default, and its repetition problem.
- [Hugging Face, generation utilities](https://huggingface.co/docs/transformers/en/internal/generation_utils): what temperature does, and what 0 means.
- [transformers, logits_process.py](https://raw.githubusercontent.com/huggingface/transformers/main/src/transformers/generation/logits_process.py): the code that divides the scores by the temperature.
- [Hugging Face, text generation parameters](https://huggingface.co/docs/transformers/en/main_classes/text_generation): max_new_tokens, eos_token_id and stop_strings.
- [Hugging Face, Chat templates](https://huggingface.co/docs/transformers/en/chat_templating): how role-tagged messages become one token sequence.
- [MDN, Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events): the event stream format.
- [Anthropic, Streaming Messages](https://platform.claude.com/docs/en/api/messages-streaming): a real event stream.
- [Anthropic, Handling stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons): what each stop reason means.
- [Anthropic, Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows): what the window holds, context rot, and overflow behavior.
- [NVIDIA, NIM LLM benchmarking metrics](https://docs.nvidia.com/nim/benchmarking/llm/metrics.html): the TTFT, TPOT, end-to-end latency and throughput definitions.
- [NVIDIA, H100 product page](https://www.nvidia.com/en-us/data-center/h100/): 80 GB of memory, 3.35 TB/s, and 1,979 TFLOPS with sparsity.
- [NVIDIA, Hopper Architecture In-Depth](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/): why the sparsity figure is twice the dense rate.
