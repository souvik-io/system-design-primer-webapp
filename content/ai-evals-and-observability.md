# Evaluating and observing AI systems

A web service gets two checks on every request. The status code says whether the call worked, and tests say whether the code does what its author meant. A language model call breaks both. A request can return `200 OK` with an answer that quotes the wrong refund policy, and the same request sent twice can produce two different sentences.

**Evaluation** measures whether answers are good, using a repeatable procedure and a number you can track. **Observability** shows what each model call did, how long it took and what it cost. For logs, metrics, traces and SLOs in general, read [Monitoring, logging and tracing](/learn/observability). This chapter covers what changes when the thing you monitor writes text.

The running example is a support assistant for an online store. It reads the store's policy pages and answers customers in a chat window. Before each release, the team asks whether the new version answers more questions correctly. After each release, it asks whether the answers are still correct, fast and affordable.

## Why AI systems need evals

### Same question, different wording

A test that asserts the answer equals "Refunds take 5 business days." fails on a correct answer such as "Your refund should arrive within five business days." Exact equality is the wrong check for free text, so the check has to judge meaning.

Outputs also vary between runs. A model generates text one token at a time, where a token is a short chunk of text. Settings such as temperature add randomness on purpose ([How LLM inference works](/learn/llm-inference#sampling)). Temperature 0 is meant to remove that randomness, and in practice some remains. Thinking Machines sent one prompt to a large Qwen model 1,000 times at temperature 0 and got 80 distinct completions. The most common one appeared 78 times. The cause sits in the serving software. GPU kernels, the programs that run each math operation, add numbers in an order that depends on the batch size (how many requests share one pass through the model). The batch size depends on other users' traffic ([Thinking Machines, 2025](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)). A single run is therefore one sample.

### A 200 can hide a bad answer

For a model, HTTP 200 means only that the call completed. Anthropic's API returns a refusal, where the model declines the request, as a normal HTTP 200 with `stop_reason` set to `refusal`. A reply cut short by the token limit ends with `max_tokens` and no error ([Anthropic, stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)). You see either one only by reading the response body.

The most damaging failures look like success: a fluent answer with the wrong number, a citation to a page that doesn't cover the topic, or a promise the policy doesn't allow. Only a check of the content catches them.

### What an eval is

An **eval** runs a system on a fixed set of inputs, grades each output and reports a score. The inputs and their expectations form the **eval set**. A **grader** decides whether one output passes. It can be code, a second model or a person. OpenAI's guide describes evals as performance tests that keep outputs reliable despite nondeterminism ([OpenAI, evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)).

A score needs its context: the cases, the graders and the model version that produced it. The target needn't be 100% either. Hamel Husain writes that "Your pass rate is a product decision" ([Husain, 2024](https://hamel.dev/blog/posts/evals/)). The assistant may need every refund fact right, and it can accept misses on small talk.

## Building an eval set

### Start from what success means

Before writing cases, write down what a good answer does for this product. For the support assistant, a good answer quotes the refund policy correctly, links the page it used, promises nothing the policy doesn't promise, and stays short. A grader can check each of those. "Helpful" can't be checked until you split it into properties like these.

### Where cases come from

A **golden set** is a fixed collection of cases with trusted expectations, run on every change so the scores stay comparable. Build it from four sources.

- **Production traffic.** Sample real questions from the logs, and remove personal data before storing them.
- **Production failures.** Every bug report and escalated conversation becomes a case. Husain updates tests as new failures appear.
- **Expert hard cases.** Ask a support lead for the questions that confuse customers.
- **Synthetic cases.** A model can draft questions from a description. Husain suggests starting this way. Check them against the logs, since they drift from real traffic.

Anthropic advises: "Design evals that mirror your real-world task distribution" ([Anthropic, define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)). Include edge cases: irrelevant or nonexistent input, very long input, harmful input, and ambiguous cases where people would disagree too.

Tag each case with its category and source, so you can report scores by group. Keep a slice of cases you never look at while tuning prompts, or the prompt learns the test set.

### How many cases

How many cases you need follows from sampling error. The 95% **margin of error** on a pass rate p over n cases is about 1.96 × √(p × (1 − p) ÷ n). At an 80% pass rate, 100 cases give 1.96 × √(0.8 × 0.2 ÷ 100) ≈ ±7.8 points, and 400 cases give ±3.9 points. A 100-case set catches a large break, such as a fall from 80% to 65%, but it can't show that a 3-point change is real. Detecting a few points takes hundreds of cases, compared on the same cases.

## Ways to grade

| Grader | Good at | Cost and speed | Main risk |
|---|---|---|---|
| Exact match | Labels, IDs, fixed values | Free, instant | Rejects correct rewording |
| Code-based check | Format, required facts, banned phrases, cited pages | Cheap and fast, runs on every change | Checks only what you thought to write |
| Model-graded (LLM-as-judge) | Meaning, tone, whether an answer is supported | Costs tokens, seconds per case | Biased; must be calibrated |
| Human review | Anything, including subjective quality | Slow and expensive | Reviewers disagree; hard to scale |

Anthropic states the central trade-off: "More questions with slightly lower signal automated grading is better than fewer questions with high-quality human hand-graded evals" ([Anthropic](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)). Use cheap graders for volume, and people to check them.

### Exact match and code-based checks

Exact match suits categorical answers. If the assistant tags each message `refund`, `shipping` or `other`, compare the tag. Code checks structure and many facts: valid JSON, required fields, no internal order IDs in a customer reply, a length limit, and cited pages that appeared in the retrieved context. Husain recommends building a base of code checks first, since they are fast enough to run on every change. They can't judge meaning, so an answer can pass every check and still be wrong.

### Model-graded evaluation

A **judge** is a second model that reads the question, the answer and a rubric, then returns a verdict. It handles criteria code can't express, such as whether the policy supports an answer. OpenAI's guide lists pairwise comparison, single-answer grading and reference-guided grading as formats.

Judges have measurable biases. In "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena" ([arXiv 2306.05685](https://arxiv.org/abs/2306.05685), Zheng and colleagues, 2023), GPT-4 agreed with human preference votes on MT-Bench 85% of the time when ties were excluded. Two humans agreed 81% of the time under the same rule (Table 5). The abstract describes GPT-4's agreement as "over 80%," "the same level of agreement between humans." The appendix warns that the human figure may be low, given how it was computed. The authors name four biases and limits.

- **Position bias.** With the default prompt, GPT-4 gave the same verdict after the two answers were swapped in 65.0% of comparisons, and it favored the first position in 30.0% (Table 2).
- **Verbosity bias.** Judges prefer longer answers. The authors padded 23 answers by rewording each one's numbered list and adding the reworded copy in front, which made the answers longer without adding anything. Claude-v1 and GPT-3.5 preferred the padded answers in 91.3% of cases, and GPT-4 in 8.7% (Table 3).
- **Self-enhancement bias.** Judges may favor answers from their own model family. The authors say their data are too limited to settle it.
- **Limited reasoning.** On math questions, GPT-4 with the default prompt accepted an incorrect answer in 14 of 20 judgments (70%). With a reference answer, that fell to 3 of 20 (15%) (Section 3.4, Table 4). The sample is small.

The paper's fixes include judging both orders and counting a disagreement as a tie, which the authors adopted as their default. Few-shot examples raised GPT-4's position consistency from 65.0% to 77.5% (Table 13), at four times the API cost for the longer prompts. Also grade with a different model than the one that wrote the answer, as Anthropic's example code suggests.

Before you trust a judge, **calibrate** it against human labels. Raw agreement misleads when most outputs are fine, so measure **precision** (the share of the judge's bad flags that were right) and **recall** (the share of truly bad answers it caught). Husain says to "measure precision and recall separately."

```python
def judge_report(judge_bad: list[bool], human_bad: list[bool]) -> None:
    """Compare a judge's 'bad' flags with human labels on the same outputs."""
    pairs = list(zip(judge_bad, human_bad))
    tp = sum(j and h for j, h in pairs)      # both say bad
    fp = sum(j and not h for j, h in pairs)  # judge says bad, human says fine
    fn = sum(h and not j for j, h in pairs)  # human says bad, judge missed it
    agree = sum(j == h for j, h in pairs) / len(pairs)
    print(f"raw agreement {agree:.0%}, precision {tp / (tp + fp):.0%}, "
          f"recall {tp / (tp + fn):.0%}")


# 100 outputs. Humans flagged 20 as bad. The judge flagged 15, and 12 of those were right.
judge = [True] * 12 + [True] * 3 + [False] * 8 + [False] * 77
human = [True] * 12 + [False] * 3 + [True] * 8 + [False] * 77
judge_report(judge, human)
```

Output:

```text
raw agreement 89%, precision 80%, recall 60%
```

The judge looks good at 89% agreement, yet it caught only 60% of the bad answers. A judge that always said "good" would score 80% on the same sample, with zero recall. Re-calibrate whenever the model, the rubric or the answer format changes.

### Human review and binary scores

People are the reference. They notice failure modes nobody wrote down. OpenAI's guide rates human evals as top quality but slow and costly, so use people to label the calibration sample, read sampled traces and write rubric examples.

Default to pass or fail. Husain often starts "by labeling examples as good or bad," and he finds scores and finer ratings "more onerous to manage than binary ratings." OpenAI's guide gives the same advice for reliability: "Use pairwise comparison or pass/fail for more reliability."

## Running evals before release

Run the eval set whenever something that affects output changes: the prompt, the model version, the retrieval settings, the tools or the grader. Compare the results with a **baseline**, the scores of the version in production. A release gate blocks the change when a rule fails.

```diagram
title: A change runs the eval set, and the gate compares the results with the baseline
[new] Candidate\nprompt or model @ 0,0
[run] Run each case,\nseveral times @ 1,0
[g] Graders:\ncode, judge,\nsample @ 2,0
[gate] Gate: any\nregressions? @ 3,0
[ship:client] Release\nor block @ 4,0
[set:store] Eval set\n(versioned) @ 1,1
[base:store] Baseline\nscores @ 3,1
new -> run
run -> g : outputs
g -> gate : scores
gate -> ship
set --> run : inputs
base --> gate : last release
```

Husain suggests code checks on every change, model-based checks on a schedule, and A/B tests after significant product changes. Pin the exact model version each run used, and store it with the result, so the score can be reproduced. Decide the gate rules before the run. One workable set: no safety case may regress, the overall pass rate may not fall by more than 2 points, and p95 latency may not rise by more than 10%.

### Comparing two prompt versions

The sketch runs an eval on two fake prompt versions. Each fake answers correctly with a fixed probability, promises too much with another, and hedges otherwise. The grader requires the key fact and rejects the word "guarantee." Each question runs three times per seed, and the run repeats for five seeds to show the spread.

```python
import random

# Question -> the fact a passing answer must contain.
KEY_FACTS = {
    "How long do refunds take?": "5 business days",
    "Can I return a sale item?": "30 days",
    "Do you ship to Canada?": "ship to canada",
    "Can I change my delivery address?": "until the order leaves",
}

def grade(answer: str, question: str) -> bool:
    """Code-based grader: the fact must appear, and no banned promise may."""
    return KEY_FACTS[question] in answer.lower() and "guarantee" not in answer.lower()

def pass_rate(model, runs: int = 3, seed: int = 0) -> float:
    """Outputs vary, so run each question several times and count the passes."""
    rng = random.Random(seed)
    results = [grade(model(q, rng), q) for q in KEY_FACTS for _ in range(runs)]
    return sum(results) / len(results)

def make_model(p_good: float, p_banned: float):
    """Fake model: right fact with p_good, a banned promise with p_banned, else a hedge."""
    def model(question: str, rng: random.Random) -> str:
        fact, roll = KEY_FACTS[question], rng.random()
        if roll < p_good:
            return f"Per our policy: {fact}."
        if roll < p_good + p_banned:
            return f"We guarantee {fact}."
        return "I'm not sure. Please contact support."
    return model

PROMPTS = {
    "v1 terse prompt": make_model(p_good=0.6, p_banned=0.2),
    "v2 with policy excerpts": make_model(p_good=0.8, p_banned=0.0),
}

if __name__ == "__main__":
    for name, model in PROMPTS.items():
        rates = [pass_rate(model, seed=s) for s in range(5)]
        print(f"{name}: {min(rates):.0%} to {max(rates):.0%} across 5 seeds")
```

Running it prints:

```text
v1 terse prompt: 42% to 75% across 5 seeds
v2 with policy excerpts: 75% to 83% across 5 seeds
```

The fakes have true pass rates of 60% for v1 and 80% for v2. Yet one seed of v1 scored 75%, the same as the lowest seed of v2. Twelve passes or fails per seed cannot separate the two versions. Before you ship v2, add cases and repeats, and list which cases flipped from pass to fail and back. The flips often tell you more than the headline number.

## Evaluating in production

Offline evals cover only the cases you thought of. OpenAI's guide lists "biased design," meaning test sets that don't represent real traffic, as an anti-pattern. Production adds three signals: sampled judging, online checks and user outcomes.

### Sampled judging

Score a sample of live answers with the same judge and rubric you use offline. Do it off the request path, so customers never wait for a judge.

```diagram
title: Sampled judging runs off the request path
[app] Assistant app\nemits spans @ 0,0
[col] Collector @ 1,0
[t:store] Trace store\n(redacted) @ 2,0
[s:queue] Sample 1-5%\nof traces @ 1,1
[j] Judge workers @ 2,1
[sc:store] Scores @ 3,1
[d] Dashboard\nand alerts @ 4,1
app -> col : OTLP
col -> t : all traces
col --> s : sample
s --> j
j -> sc : pass or fail
sc -> d
```

A judge call is a model call, so judging costs money. Take 1 million requests a day, judge 1% of them, and assume each judge call averages 1,500 input and 150 output tokens. That is 10,000 calls: 15 million input tokens and 1.5 million output tokens. At assumed prices of $3 and $15 per million tokens, the judge costs 15 × $3 + 1.5 × $15 = $45 + $22.50 = $67.50 a day.

Sampling adds noise. If 500 judged answers a day pass at 90%, the daily margin is 1.96 × √(0.9 × 0.1 ÷ 500) ≈ ±2.6 points. Comparing two such days gives a margin on the difference of 1.96 × √(2 × 0.9 × 0.1 ÷ 500) ≈ ±3.7 points. Alert on sustained drops across several days, and treat one bad day as a reason to look.

### Online checks

Some checks must run before a reply leaves the server, because they can block it. Such a check is a **guardrail**, such as JSON validation, detection of personal data that shouldn't appear in replies, or handling of refusals and truncated answers. [LLM gateways](/learn/llm-gateways#logging-and-guardrails) covers where guardrails usually sit.

### A/B tests and user outcomes

An A/B test splits users between two prompt versions and compares an outcome that matters, such as conversations that end without a handoff to a person. Size it first. Moving a thumbs-up rate from 50% to 52%, at 5% significance (the chance of a false win) and 80% power (the chance of detecting a real lift), needs about 9,800 users per arm. The formula is n = (1.96 × √(2 × pbar × (1 − pbar)) + 0.84 × √(p1 × (1 − p1) + p2 × (1 − p2)))² ÷ (p1 − p2)², where pbar is the average of p1 and p2. Fix the end date or sample size in advance, since stopping when the result looks good inflates false wins.

User feedback is a useful signal that is also noisy. Thumbs up and down, regenerations, edits, copies and escalations all carry information, but explicit feedback is sparse and skews toward strong opinions. Use these signals to pick conversations for review, and add the reviewed failures to the eval set, so each production failure guards the next release. Redact personal data, restrict access and set a retention limit ([Security for AI systems](/learn/ai-security#leaking-data)).

## Tracing model calls

A **span** is one timed step, and a **trace** is the tree of spans for one request. [Monitoring, logging and tracing](/learn/observability#distributed-tracing) explains both.

### One request, many spans

A support question usually embeds the question, searches the index, calls the model and sometimes calls a tool, such as an order lookup. Each step is a span. The model call gets its own span, because it is often the slowest and most expensive step.

```diagram
title: One support question as a trace, with timings from an example request
[req] Root span\nPOST /ask\n2,350 ms @ 0,1
[emb] Embedding\nquery, 25 ms @ 1,0
[ret] Retrieval\nvector search\n40 ms @ 1,1
[llm] Model call\nchat, 2,100 ms @ 1,2
[tool] Tool call\nexecute_tool\n120 ms @ 2,2
req -> emb
req -> ret
req -> llm
llm -> tool : order lookup
```

The model span carries the time to first token and the token counts. The tool span shows whether the order lookup, rather than the model, was the slow step.

### The GenAI attributes

OpenTelemetry's semantic conventions for generative AI name the attributes a model span should carry. The spec lives in its own repository and is still marked **Development**, a level short of stable. Its stability page doesn't say what Development allows for attribute names, so treat the names as provisional ([OpenTelemetry GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)). An inference span is named `{operation} {model}`, such as `chat` plus the requested model's name, and uses the client span kind ([OpenTelemetry GenAI client inference](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md)).

| Attribute | What it records | Requirement |
|---|---|---|
| `gen_ai.operation.name` | `chat`, `text_completion`, `embeddings`, `retrieval`, `invoke_agent` or `execute_tool` | Required on the span |
| `gen_ai.response.model` | The model that actually answered | Recommended |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | Tokens in and out | Recommended |
| `gen_ai.usage.cache_read.input_tokens` | Input tokens served from a cache, counted within input tokens | Recommended when non-zero |
| `gen_ai.response.finish_reasons` | Why generation stopped | Recommended |
| `gen_ai.request.temperature`, `gen_ai.request.max_tokens` | Sampling and length settings | Recommended |
| `gen_ai.response.time_to_first_chunk` | Seconds from the request to the first streamed chunk | Recommended for streaming |

Add your own attributes too, such as the prompt, retrieval index and grader versions, so you can slice every dashboard by version. Keep them out of metric labels, because the [cardinality rules](/learn/observability#cardinality-and-cost) apply to prompt versions as much as to user IDs.

### Content and privacy

The fields `gen_ai.input.messages` and `gen_ai.output.messages` are opt-in. The spec warns that output messages are "likely to contain sensitive information including user/PII data." Record metadata by default: models, token counts, timings and finish reasons. Store full content only for a small sample, in a restricted store, with redaction and a short retention period.

## Metrics to watch

Four kinds of panel answer what an operator asks: speed, cost, errors and quality.

### Latency

**Time to first token (TTFT)** is the wait before the first output token. **Time per output token (TPOT)** is the average gap between output tokens after that. [How LLM inference works](/learn/llm-inference#latency-and-throughput-metrics) defines both. OpenTelemetry defines server-side histograms for them, `gen_ai.server.time_to_first_token` and `gen_ai.server.time_per_output_token`, in seconds ([OpenTelemetry GenAI metrics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md)). Chart percentiles, because averages hide slow requests ([Performance and latency](/learn/performance-and-latency#averages-hide-the-slow-requests)).

For the handbook's running deployment, Llama 3.1 70B on four H100 GPUs, memory bandwidth alone caps one user at about 96 tokens a second, and 64 users sharing the GPUs at about 74 tokens a second each ([Estimating AI workloads](/learn/ai-estimation#how-fast-it-can-run) works this out). Real deployments run slower than these limits. Alert from the TPOT you measure on a healthy system, since a TPOT well above that baseline usually means a bigger batch, a fuller cache or a slower code path.

### Tokens and cost

Track input and output tokens per request, and chart their distribution, since a few very long prompts can dominate the bill. Cost per request is input tokens × input price + output tokens × output price. On Anthropic's pricing page, as of October 2026, output tokens cost five times the base input price for every model listed, and cache hits cost a tenth of the base input price or less ([Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)). So a verbose answer costs more than a prompt of the same length. A request with 3,000 input and 400 output tokens costs 3,000 × $3 ÷ 1,000,000 + 400 × $15 ÷ 1,000,000 = $0.009 + $0.006 = $0.015 at assumed prices, or $15,000 a month for a million such requests. Chart cost per feature, per team and per successful task ([LLM gateways](/learn/llm-gateways#tracking-cost)).

### Errors and refusals

Track error rates per route and per prompt version. The `error.type` attribute, marked Stable in the spec, names the failure. Count stop reasons too. A refusal is a successful HTTP call, so it hides among your 200s until you chart it. Rising refusals or truncations are quality problems, even when no status code changes. Page on sudden jumps that hurt users, and send slow drifts to a ticket ([symptom-based alerting](/learn/observability#alerting-on-symptoms)).

### Quality

Quality panels show the pass rate of the golden set, run nightly against production, the pass rate of sampled judging, and user outcomes such as escalations. Read the judge's daily moves against its margin of about ±2.6 points, and treat a change inside that margin as noise until it persists. Place quality beside latency and cost, so a quality gain that doubles cost is visible at once. [RAG](/learn/rag#evaluating-retrieval-and-answers) covers retrieval quality. Filter every panel by model and prompt version, and read the four questions in order: is it up, is it fast, is it affordable, is it good?

## Check yourself

<details>
<summary>A new prompt raises the judge's pass rate on a 100-case eval set from 81% to 84%. Should the team ship it?</summary>

Not on this evidence. The 95% margin on each rate is about 1.96 × √(0.81 × 0.19 ÷ 100) ≈ ±7.7 points, so a 3-point gap sits inside it. If only a few cases flipped, the change is probably noise. Add cases and repeats, and ship only if no critical case regressed.

</details>

<details>
<summary>A judge flags 15 of 100 answers as bad. Humans flagged 20, and 12 of the judge's flags were correct. A colleague says 89% raw agreement proves the judge is good. What do you say?</summary>

Recall is 12 ÷ 20 = 60%, so the judge misses 8 of the 20 bad answers. Precision is 12 ÷ 15 = 80%. A judge that always said "good" would score 80% raw agreement here. Keep it out of release decisions until its recall is acceptable.

</details>

<details>
<summary>After a model upgrade, the pass rate falls 6 points, while latency and cost stay flat. Where do you start?</summary>

Split the results by category, and read the traces of the cases that flipped. Check stop reasons and output token counts, since longer answers can change a grader's verdict. Re-run the same cases on the old model, and check whether the judge changed in the same release.

</details>

<details>
<summary>An A/B test should show whether a prompt lifts the thumbs-up rate from 40% to 42%. Roughly how many users does each arm need at 5% significance and 80% power? How long does the test take with 5,000 eligible users a day?</summary>

With p1 = 0.40, p2 = 0.42 and pbar = 0.41, the numerator is (1.96 × √(2 × 0.41 × 0.59) + 0.84 × √(0.40 × 0.60 + 0.42 × 0.58))², about (1.363 + 0.584)² = 3.79. Divide by 0.02² = 0.0004 to get about 9,500 users per arm, or 19,000 in total. At 5,000 eligible users a day, split evenly, that takes about four days.

</details>

<details>
<summary>A trace shows the model span stopped at the token limit, and its output token count equals the configured maximum. What happened, and what would you change?</summary>

The reply was cut off, so the customer got half an answer. Check whether it ends mid-sentence or mid-JSON. Then decide whether the limit is too low, or whether the new prompt made answers longer. Raise the limit or shorten the instructions, and chart the truncation rate per prompt version.

</details>

## Further reading

- [OpenTelemetry GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md): attribute names and requirement levels. Still at Development.
- [OpenTelemetry GenAI client inference](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md): span names and token and streaming attributes.
- [OpenTelemetry GenAI metrics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md): the latency histograms.
- [Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena"](https://arxiv.org/abs/2306.05685): the agreement numbers and the four biases.
- [Hamel Husain, "Your AI Product Needs Evals"](https://hamel.dev/blog/posts/evals/): code checks first, binary labels, and judge precision and recall.
- [OpenAI, Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices): the five-step process, grader formats and anti-patterns.
- [Anthropic, Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests): grader types and the edge-case checklist.
- [Anthropic, Stop reasons and fallback](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons): the refusal and token-limit stop reasons.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing): output-to-input price ratios. Prices change, so check the page before you budget.
- [Thinking Machines, Defeating Nondeterminism in LLM Inference](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/): why temperature 0 still varies.
