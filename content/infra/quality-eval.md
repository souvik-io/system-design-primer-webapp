# Measuring quality loss

A quantized model is only worth serving if it still does its job, and "the perplexity went up by 2%" does not say whether it does. This chapter covers how to measure what quantization did to a model: perplexity and its limits, the KL divergence between the quantized and original models' predictions, task benchmarks run with an evaluation harness, and the paired view that shows how many answers changed, which an unchanged accuracy can hide. It ends with how to put quality next to memory and speed in one table that supports a decision. The lab measures SmolLM2-135M's quantized versions all four ways on a Mac and Llama 3.1 8B's on a GPU.

Before this chapter, read [Post-training quantization algorithms](/learn/ptq-algorithms), which produces the versions this chapter evaluates.

## Perplexity and its limits

Perplexity is the exponential of the average negative log-likelihood the model assigns to each next token of a text: a perplexity of 17 means the model was, on average, as uncertain as if it were choosing uniformly among 17 tokens. It is cheap, needs no labels, and is sensitive to small changes, which is why quantization papers report it, usually on the test split of WikiText-2, a set of Wikipedia articles. The labs in this part compute it the standard way, on fixed windows of 1,024 or 2,048 tokens. lm-evaluation-harness's wikitext task scores whole documents and reports perplexity per word, so its numbers are not comparable with these.

Its limits matter. Perplexity averages over every token, and most tokens in prose are easy: the end of a word, a common phrase, punctuation. A quantization error that ruins the model's arithmetic, its code, or its use of a fact from 10,000 tokens earlier barely moves the average. It depends on the tokenizer, so perplexities of models with different vocabularies cannot be compared, and on the text, so Wikipedia perplexity says little about a chat or code workload. And it measures the model's fit to the text, not its agreement with the original model: a quantized model can match WikiText's tokens slightly better by chance while answering a different set of questions correctly. Perplexity is a good first screen: a large rise rules a version out, but a rise of 1% does not clear it, and such a version still needs the measurements below.

## KL divergence from the original model

The question quantization raises is not "how well does the model fit text?" but "how far did the model move from the original?". The KL divergence answers it directly. At each position of a text, the original model gives a probability distribution P over the next token and the quantized model gives Q, and

```text
KL(P || Q) = Σ over the vocabulary of P(t) × (log P(t) - log Q(t))
```

is zero only if the two distributions are identical, and grows with every change in what the model believes, not only in the probability of the token that happened to come next. Averaged over many positions, it is a far more sensitive and more stable measure of damage than perplexity. A companion measure is top-1 agreement: the share of positions where both models' most likely next token is the same, which is how often greedy decoding takes the same step.

Dutta and others at Microsoft Research made the case in 2024 in "Accuracy is Not All You Need": compressed models often match their baseline's benchmark accuracy while changing many individual answers, and they proposed KL divergence and "flips" as the metrics to report. llama.cpp's perplexity tool can likewise compute KL divergence against logits saved from the original model. KL divergence needs both models' full output distributions at the same positions, so it is computed with the two models side by side, or with the original's distributions saved to disk; it cannot be computed from a served model's top few log-probabilities alone.

## Task benchmarks and flips

Task benchmarks check what users care about: whether the model still solves problems. The usual tool is EleutherAI's lm-evaluation-harness, which implements hundreds of tasks against a common model interface, including a vLLM backend. Tasks come in two kinds. Log-likelihood tasks, such as MMLU, ARC and HellaSwag, score each multiple-choice answer by the probability the model assigns to it, which is fast and deterministic. Generative tasks, such as GSM8K's grade-school math problems, let the model write an answer and check it; the harness's GSM8K task uses five worked examples in the prompt and reports exact match under two filters, `strict-match`, which needs the "#### answer" format, and `flexible-extract`, which takes the last number. Generative tasks are slower but catch damage to multi-step reasoning, the kind of skill that quantization tends to hurt first.

Two cautions apply to every benchmark number. The first is noise. An accuracy measured on n questions has a standard error of about √(p(1 - p) / n): on GSM8K's 1,319 test problems at 80% accuracy, that is 1.1 points, so a difference of 1 or 2 points between two versions may be chance. The second is that equal accuracy does not mean equal behaviour. Because the original and quantized models answer the same questions, they can be compared question by question: a flip is a question that one model answers correctly and the other does not. A version that gains 20 questions and loses 20 has the same accuracy and 40 flips, and each flip is a user who gets a different answer than before. Reporting the flip rate next to the accuracy shows how much a version changed, not only whether it got better or worse on balance.

## Spot checks the averages miss

Some damage only shows in specific inputs, so a quality report should include a few targeted checks alongside the standard metrics. Long contexts are the first: quantization error in attention, and in particular a quantized KV cache, accumulates over long sequences, so test retrieval from deep in a long prompt, for instance by placing a fact early and asking for it at the end. Code and math are the second, because a single wrong token breaks them. Languages and domains outside the calibration set are the third, since static scales and AWQ's or GPTQ's statistics were fitted to the calibration data. The last is the product's own prompts: a few hundred real requests, answered by both versions and compared side by side or judged by a stronger model, are often the most convincing evidence a team has.

## One table for the decision

A quantization decision trades memory, speed and quality, so the evidence belongs in one table: for each version, its weight memory and KV cache capacity, its decode latency at the batch sizes that matter and its prefill throughput, and its perplexity, KL divergence, task accuracies and flip rates against the original. A version is worth considering only if no other version is at least as good on every column; those versions form the Pareto front. A budget, such as "fits in 24 GB with room for 32 sequences of 4,096 tokens" or "loses at most 1 point on GSM8K", then picks one version from the front.

```widget
pareto-picker
```

The widget holds the Llama 3.1 8B measurements below. With its defaults, decode step against GSM8K accuracy with 2 points allowed, four versions qualify, and FP8 W8A8 has the fastest decode step. Lower the memory budget to 6 GiB: only the 4-bit versions fit, and none stays within 2 points; allow 5 and GPTQ with perfectblend calibration and AWQ qualify. Then switch the quality measure to WikiText-2 perplexity: the GPTQ version calibrated on WikiText, far below the GSM8K floor, now qualifies, and the perfectblend one does not. Which version looks best depends on what you measure.

## Measured: SmolLM2-135M on a Mac

The lab's [quality_eval.py](/labs/infra/quality_eval.py) makes seven versions of SmolLM2-135M with chapter 4.3's algorithms and compares each with the original on WikiText-2 perplexity, KL divergence and top-1 agreement over 20,460 positions, and accuracy and flips on the first 1,000 ARC-Easy questions:

| Version | Perplexity | KL (nats) | Top-1 agree | ARC-Easy | Flips | Net |
|---|---|---|---|---|---|---|
| Original (BF16 weights, run in FP32) | 17.10 | 0 | 100% | 59.6% | | |
| W8A16, INT8 per channel | 17.17 | 0.0035 | 96.8% | 59.8% | 0.6% | +2 |
| W8A8, INT8 per-token activations | 17.78 | 0.042 | 90.4% | 59.6% | 1.4% | 0 |
| W4A16 group 128, RTN | 23.01 | 0.307 | 70.4% | 55.7% | 13.1% | -39 |
| W4A16 group 128, AWQ | 20.47 | 0.171 | 78.2% | 54.6% | 10.4% | -50 |
| W4A16 group 128, GPTQ | 22.22 | 0.277 | 73.3% | 53.5% | 15.7% | -61 |
| W3A16 group 128, GPTQ | 97.63 | 1.773 | 40.3% | 36.0% | 33.4% | -236 |

GPTQ here is the version without act-order. The table shows the measures disagreeing, which is the point of using several. Every measure ranks the 8-bit versions as nearly lossless, and W8A8's accuracy is unchanged although it altered 14 answers, half for the better. The three INT4 versions are where the measures diverge. AWQ has the lowest perplexity and KL of the three and the highest top-1 agreement, yet it answered fewer ARC questions correctly than plain rounding. The difference between 55.7% and 54.6% is less than one standard error on 1,000 questions, about 1.6 points, so the accuracies cannot rank these versions; KL divergence can, and it says AWQ moved the model least. The flip rates show the cost the accuracies understate: every INT4 version changed the outcome of 10% to 16% of the questions, two to three and a half times its net loss.

A 135-million-parameter model is far more fragile than the 8B model below, so these sizes of change are larger than a production model would show; the pattern of disagreement between measures is the same.

## Measured: Llama 3.1 8B on a GPU

Chapter 4.3's GPU lab also measured the quality of every Llama 3.1 8B version on an H100: WikiText-2 perplexity over 40 windows of 2,048 tokens; all 1,319 GSM8K test problems, with five worked examples in the prompt, greedy decoding and the final number compared with the answer; and the 1,172 ARC-Challenge test questions, scored by log-likelihood like ARC-Easy above. At these accuracies the standard errors are 1.2 points for GSM8K and 1.5 for ARC-Challenge. "Lost" counts the questions BF16 answered correctly and the version did not, "gained" the reverse, and their sum is the flips.

| Version | Perplexity | GSM8K | Lost / gained | ARC-Challenge | Lost / gained |
|---|---|---|---|---|---|
| BF16 | 6.93 | 76.8% | | 55.9% | |
| BF16 again, same settings | 6.93 | 76.9% | 1 / 2 | 55.9% | 0 / 0 |
| BF16 again, at most 32 sequences at a time | 6.93 | 76.5% | 18 / 14 | 55.9% | 1 / 1 |
| FP8 W8A8 | 6.97 (+0.7%) | 76.7% | 69 / 68 | 56.1% | 18 / 20 |
| INT8 W8A8, SmoothQuant then GPTQ | 7.03 (+1.4%) | 76.3% | 71 / 64 | 56.0% | 20 / 21 |
| BF16, FP8 KV cache | 6.98 (+0.8%) | 75.4% | 84 / 66 | 55.9% | 19 / 19 |
| INT4, RTN | 7.66 (+10.5%) | 66.4% | 213 / 76 | 51.0% | 92 / 35 |
| INT4, GPTQ, perfectblend calibration | 7.48 (+8.0%) | 73.4% | 122 / 77 | 53.8% | 60 / 35 |
| INT4, GPTQ, WikiText calibration | 7.22 (+4.2%) | 66.6% | 207 / 72 | 54.7% | 55 / 41 |
| INT4, AWQ | 7.30 (+5.3%) | 72.4% | 136 / 78 | 54.4% | 57 / 40 |
| NVFP4, run weight-only | 7.25 (+4.6%) | 70.7% | 164 / 84 | 54.3% | 52 / 33 |
| INT4 AWQ, FP8 KV cache | 7.35 (+6.1%) | 71.0% | 160 / 83 | 54.4% | 57 / 40 |

The two control rows set the scale. Evaluating BF16 a second time with the same settings changed 3 GSM8K answers. Limiting vLLM to 32 sequences at a time, which changes how requests are batched and so the order of the floating-point additions in each matmul, changed 32, 2.4%, with the model and its weights untouched. Greedy decoding over a few hundred tokens amplifies tiny differences in the logits: once one token differs, the rest of the solution follows another path. ARC-Challenge, which only compares the likelihoods of fixed answers, barely moved. (Modal ran both controls on an H200 in place of the H100; it has the same Hopper tensor cores and kernels, and the perplexity matched BF16's to every digit, so only their speed would not be comparable.)

Against that floor, the 8-bit versions are a real but small change. FP8 W8A8 moved GSM8K accuracy by 0.1 points and perplexity by 0.7%, yet it changed 137 answers, 10.4%, four times as many as the batching control, almost evenly split between lost and gained. A user of the FP8 deployment would get a different outcome on about one math problem in ten, as often right as before. INT8 W8A8 and the FP8 KV cache behaved the same way, the KV cache's 1.4-point drop being about one standard error.

The 4-bit versions lose accuracy beyond any noise. Rounding to nearest cost 10.4 points on GSM8K, nine standard errors, and 4.9 on ARC-Challenge. GPTQ with perfectblend calibration and AWQ cut the GSM8K loss to 3.4 and 4.4 points, still three to four standard errors, and lost 1.6 to 1.7 times as many problems as they gained. NVFP4's weights, with no rounding algorithm, only their small blocks and fine scales, landed between them and rounding to nearest. Adding an FP8 KV cache to AWQ cost another 1.4 points, as it did for BF16.

Perplexity ranked the 4-bit versions almost in reverse of GSM8K. By perplexity the best was GPTQ calibrated on WikiText, then NVFP4, AWQ and, last of the calibrated versions, GPTQ with perfectblend; by GSM8K the perfectblend version was best and the WikiText one no better than rounding to nearest. Chapter 4.3 explains why: each GPTQ version fits its calibration data, and each test favours one of them. The generative task also separated the versions far more than the log-likelihood one: the calibrated 4-bit versions lost 1.2 to 2.1 points on ARC-Challenge and 3.4 to 10.2 on GSM8K.

Next to chapter 4.3's costs, the table supports a clear choice for this model on an H100: FP8 W8A8. It is within noise on both benchmarks, decodes 1.47 times faster than BF16 at batch 1 and prefills 1.44 times faster, and halves the weights. The 4-bit versions save another 3 GiB that an 80 GB GPU does not need, cost at least 3 GSM8K points and slow prefill down. On a 24 GB L4, which also runs FP8, chapter 4.3's estimate leaves FP8 about 7.5 GiB of cache against INT4's 10.7, so FP8 stays the safer choice unless the workload needs the larger cache; on GPUs without FP8, such as the A100, INT8 W8A8 is the 8-bit option, and it was also within noise here.

## Lab: a quality report

**Tier: [Mac] then [1 GPU].** Part A runs on a CPU in about 25 minutes and needs chapter 4.2's and 4.3's lab files in the same folder. Part B uses the results of chapter 4.3's GPU lab, `quant_results.json`, from your own run or the reference run.

Download [quality_eval.py](/labs/infra/quality_eval.py) and run it with `python quality_eval.py`. For Part B, run chapter 4.3's [quantize_and_eval.py](/labs/infra/gpu/quantize_and_eval.py) if you have not, which writes `quant_results.json` next to it, or download the reference run's [quant_results.json](/labs/infra/gpu/quant_results.json), which holds every version's measurements and its per-question GSM8K and ARC-Challenge results.

**Part A, four measures.** Implement perplexity, KL divergence and top-1 agreement against the original model, and a log-likelihood multiple-choice task with per-question results. Report each version's accuracy, flip rate and net change, and say which measure separates the versions best.

**Part B, the report.** Write a one-page quantization report for Llama 3.1 8B on the GPU you used, with this structure: the workload and its constraints; a table of every version's memory, KV capacity, decode latency, prefill throughput, perplexity, GSM8K and ARC-Challenge accuracy and flips; the Pareto front; your recommendation with the evidence for it; and what you would check before shipping it. Use the standard error to say which differences are real.

**Part C, a trap.** A colleague reports that the INT4 version "scored the same as BF16 on MMLU, so quantization is free". Write the two follow-up questions you would ask.

<details>
<summary>Reference solution</summary>

`quality_eval.py` on an Apple M2 MacBook with 8 GB of memory:

```text
PyTorch 2.15.0, Transformers 5.22.2

version                              perplexity  KL (nats)  top-1 agree  ARC-Easy   flips   net
original (FP32 from BF16)                 17.10     0.0000       100.0%     59.6%    0.0%    +0
W8A16 INT8 per channel, RTN               17.17     0.0035        96.8%     59.8%    0.6%    +2
W8A8 INT8, per-token activations          17.78     0.0415        90.4%     59.6%    1.4%    +0
W4A16 g128, RTN                           23.01     0.3074        70.4%     55.7%   13.1%   -39
      AWQ alpha chosen per layer group: mean 0.32, range 0.00 to 0.75
W4A16 g128, AWQ                           20.47     0.1711        78.2%     54.6%   10.4%   -50
W4A16 g128, GPTQ                          22.22     0.2767        73.3%     53.5%   15.7%   -61
W3A16 g128, GPTQ                          97.63     1.7727        40.3%     36.0%   33.4%  -236

ARC-Easy: first 1000 test questions. flips: share of questions whose right/wrong outcome
changed; net: change in the number answered correctly. KL and top-1 agreement over 20,460 positions.
```

*Part A.* KL divergence separates the versions best: it spans three orders of magnitude, from 0.0035 for W8A16 to 1.77 for W3A16, and it clearly distinguishes the three INT4 versions, whose ARC-Easy accuracies are within one standard error of each other. Top-1 agreement and, on this model, perplexity give the same order; accuracy alone cannot rank the INT4 versions at all.

*Part B.* A report for a chat product serving Llama 3.1 8B on H100s, from the tables above and chapter 4.3's: the workload is interactive chat with some math, served at small to moderate batch sizes. FP8 W8A8 is on the Pareto front for every cost and is the recommendation: within one standard error of BF16 on GSM8K (76.7% against 76.8%) and ARC-Challenge, 1.47 times faster decode at batch 1, 1.44 times faster prefill, and half the weight memory. INT8 W8A8 is equivalent within noise. The 4-bit versions are rejected for this GPU, because they cost 3.4 to 10.4 GSM8K points, nine standard errors for rounding to nearest, for memory the H100 does not need. The FP8 KV cache doubles the cache at a cost of 1.4 GSM8K points, about one standard error, and should be adopted only if the cache is the bottleneck. Before shipping FP8, check what the averages hide: FP8 changed 10% of GSM8K outcomes, four times the batching control, so compare a few hundred real product prompts side by side with BF16, and test long-context retrieval if the FP8 KV cache is enabled.

*Part C.* First, how many questions changed between right and wrong: equal accuracy can hide many flips, and each flip is a different answer for a user. Second, whether the tasks that matter to the product were measured: MMLU is a log-likelihood multiple-choice test that does not exercise generation, multi-step reasoning, long contexts or code, which is where quantization damage shows first. A third useful question is how big the difference would have to be to be visible, given MMLU's standard error at that accuracy.

</details>

## Interview angle

- **"How do you evaluate a quantized model?"** In layers: perplexity on a standard text as a cheap screen; KL divergence and top-1 agreement against the original model as the most sensitive measure of how far it moved; task benchmarks with lm-evaluation-harness, including a generative reasoning task such as GSM8K, with flips reported next to accuracy; and targeted spot checks on long contexts, code and real product prompts. Then put the results next to memory and latency to make the decision.
- **"Why is perplexity not enough?"** It averages over all tokens, most of which are easy, so damage to reasoning, code or long-context retrieval barely moves it; it depends on the tokenizer and the text; and it measures fit to the text rather than agreement with the original model.
- **"What are flips?"** Questions that the original model answers correctly and the quantized model does not, or the reverse. Two versions can have the same accuracy and very different answers; the flip rate measures that change directly.
- **"Is a 1-point drop on GSM8K significant?"** On 1,319 problems at about 80% accuracy the standard error is about 1.1 points, and the standard error of a difference between two independent runs is larger, so a 1-point drop alone is within noise. A paired comparison of the same questions, through flips, gives a sharper answer than comparing two accuracies.

## Check yourself

<details>
<summary>Version A has a lower perplexity than version B but a higher KL divergence from the original. Which is closer to the original model?</summary>

Version B. KL divergence measures how much each version's predicted distributions differ from the original's, while perplexity measures how well each fits the test text. A version can fit the text slightly better by chance while having moved further from the original model's behaviour.

</details>

<details>
<summary>Why can KL divergence not be computed from what a vLLM server returns by default?</summary>

KL divergence sums over the whole vocabulary, so it needs both models' full next-token distributions at the same positions. A server returns at most a few of the top log-probabilities per position, so the original model's distributions must be computed and saved, or both models run side by side, outside the serving path.

</details>

<details>
<summary>A version has 0 net change on a benchmark and a 6% flip rate. What does that tell you?</summary>

It got as many questions right as the original but not the same ones: 3% of questions that the original answered correctly it now gets wrong, and 3% the other way, roughly. Its average quality is unchanged, but its behaviour is not, and users would see different answers on about 6% of such questions.

</details>

<details>
<summary>What is the standard error of an accuracy of 50% measured on 1,000 questions, and what does it imply?</summary>

√(0.5 × 0.5 / 1000) ≈ 1.6 points. Two versions whose accuracies differ by 2 points on such a benchmark may not differ at all; a larger benchmark, several tasks, or a paired comparison through flips is needed.

</details>

## Further reading

- [Accuracy is Not All You Need](https://arxiv.org/abs/2407.09141), by Dutta and others, argues for KL divergence and flips as the metrics for compressed models.
- EleutherAI's [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness), with task definitions such as [gsm8k.yaml](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/tasks/gsm8k/gsm8k.yaml) and [wikitext.yaml](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/tasks/wikitext/wikitext.yaml).
- [Training Verifiers to Solve Math Word Problems](https://arxiv.org/abs/2110.14168), by Cobbe and others, introduces GSM8K.
- [Think you have Solved Question Answering? Try ARC](https://arxiv.org/abs/1803.05457), by Clark and others, introduces the ARC Easy and Challenge sets.
