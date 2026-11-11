# Speculative decoding

Every technique in this part so far has made the server do the same work more efficiently. Speculative decoding is different in kind: it makes the server do more work in order to finish each request sooner. A cheap drafter guesses the next few tokens, the target model checks all of the guesses in one pass, and every guess that survives is a token the request did not have to wait a whole decode step for. The output follows the same distribution the target model would have produced on its own.

Whether this is a good trade depends on a spare resource. A decode step for a few requests is limited by how fast the GPU can read the weights, and its arithmetic units are mostly idle ([The arithmetic of inference](/learn/inference-arithmetic)). Speculation spends that idle arithmetic. When the batch is large enough that the arithmetic is no longer idle, the same technique makes the server slower, and this chapter measures where that happens.

After this chapter you can state the acceptance rule and show why it does not change the output distribution, predict the speed-up from an acceptance rate and a draft cost, say what kind of drafter suits which traffic, read the path a draft token takes through vLLM, and answer the interview question "when does speculative decoding hurt?" with numbers. The system design handbook's section on [speculative decoding](/learn/inference-engines#speculative-decoding) is the short version, and this chapter assumes you have read it and [Inside vLLM](/learn/inside-vllm). Everything about vLLM refers to **vLLM 0.32.0**, with paths under `vllm/`.

## Draft, then verify

A decode step produces one token per request because the model's output at a position depends on the token at that position, and the next token is not known until this one has been sampled. The step itself is not the obstacle. A forward pass can take several positions of one sequence at once, which is what prefill does, and with Llama 3.1 8B on an H100 a pass over four positions takes almost exactly as long as a pass over one, about 6.5 ms, because either way the GPU reads the same 16 GB of weights once.

Speculative decoding uses this. Suppose the request so far ends in "The capital of France", and a drafter proposes that the next three tokens are " is", " Paris" and ".". The target model is given four positions in one pass: the last real token and the three proposals. The pass returns four next-token distributions.

| Position fed to the target | The target's own next token | The drafter's proposal for it | Result |
|---|---|---|---|
| " France" (real) | " is" | " is" | Accepted |
| " is" (draft 1) | " Paris" | " Paris" | Accepted |
| " Paris" (draft 2) | "," | "." | Rejected, the target's "," is kept |
| "." (draft 3) | not used | | Computed for nothing |

The output at the first position was computed from real tokens only, so it is exactly what a plain decode step would have produced. If the first proposal matches it, the output at the second position is also what a plain step would have produced, because it was computed from the same tokens a plain step would have had. The argument repeats until the first mismatch. At the mismatch the target's own token is taken, and everything after it is thrown away, since it was computed after a token that is not in the output. In the table, one pass emitted three tokens: two accepted proposals and the target's correction.

```diagram
title: One round. The drafter runs k times, the target once, and the pass emits between 1 and k + 1 tokens
[c:note] Tokens so far @ 0,0.5
[d] Drafter\nproposes k tokens @ 1.3,0.5
[t] Target model\none pass over\nk + 1 positions @ 2.6,0.5
[o:note] Accepted drafts\nplus one token\nfrom the target @ 4,0.5
c -> d
d -> t : k draft tokens
t -> o : verify in order
```

Three properties follow from this picture, and the rest of the chapter is about them.

- **A pass always emits at least one token.** If the first proposal is wrong, the target's token for that position is still correct and is kept. Speculation can waste work, but it cannot stall.
- **A pass emits at most k + 1 tokens**, when all k proposals are accepted and the last position supplies one more. vLLM calls that last one the bonus token.
- **Rejected positions are pure waste.** Their arithmetic was done, and their keys and values were written, for a continuation that does not exist. Whether that waste costs time depends on whether the arithmetic was idle anyway.

## The acceptance rule

Comparing the proposal with "the target's own next token" is the whole rule when decoding is greedy. At temperature 0 the target's token is the one with the largest logit, the proposal either is that token or is not, and the output of speculative decoding is the output of greedy decoding.

With sampling there is no single right token, and "accept if equal to what the target sampled" would waste most good proposals. Leviathan, Kalman and Matias gave the rule that is used instead, which they call speculative sampling. Let p be the target's distribution at a position and q the drafter's, and let x be the token the drafter sampled from q.

1. Accept x with probability min(1, p(x) ÷ q(x)). A token the target likes at least as much as the drafter did is always kept, and one the drafter was overconfident about is kept in proportion.
2. On a rejection, sample the token from the residual distribution, max(0, p − q) rescaled to sum to 1, and stop verifying this draft.

The output is distributed exactly as p, and the proof is two lines. Token x is emitted either by being proposed and accepted, with probability q(x) × min(1, p(x) ÷ q(x)) = min(p(x), q(x)), or by a rejection followed by a draw from the residual. The total probability of a rejection is 1 − Σ min(p, q), which is also the sum of max(0, p − q), so the second route contributes exactly max(0, p(x) − q(x)). The two add up to p(x). The paper's Appendix A.1 has the same argument, and Chen and colleagues at DeepMind published the same method independently.

The proof also gives the acceptance probability at one position: β = Σ min(p(x), q(x)), which is 1 minus half the sum of |p(x) − q(x)|. It is 1 when the drafter's distribution equals the target's and falls as they diverge. The paper writes α for the average of β over positions, and reports α between 0.5 and 0.9 for drafters two orders of magnitude smaller than their targets.

vLLM's default is a variation, and it matters for reading its numbers. Its model-based drafters propose greedily, each draft token being the drafter's most likely one, and no draft distribution is kept (`draft_sample_method` is `greedy`). The verifier then treats q as putting all its mass on the proposed token x: it accepts with probability p(x), and on a rejection samples from p with x removed. This is the same rule with a one-hot q, so it is still exact. Its acceptance probability is p(x), the probability the target gives to the drafter's favourite token, which can be higher or lower than Σ min(p, q).

[spec_decode_sim.py](/labs/infra/spec_decode_sim.py) implements both forms in a few lines and draws 200,000 tokens from each.

```text
One position, target p = [0.5, 0.2, 0.15, 0.1, 0.05], draft q = [0.25, 0.45, 0.1, 0.05, 0.15]
    draft proposes          accepted, predicted  accepted, measured   output distribution, measured
    a sample from q                       0.650               0.649   0.499 0.200 0.150 0.100 0.050
    its most likely token                 0.200               0.201   0.499 0.201 0.151 0.099 0.050
```

Both rows reproduce p to three decimals. They differ only in how often the proposal survives: this drafter's favourite token is one the target gives 0.20, so proposing it every time is accepted 20% of the time, while sampling from q is accepted 65% of the time. The script's self-checks also generate three-token sequences from a pair of small conditional models and compare all 64 sequence frequencies with direct sampling from the target.

Two practical consequences are worth knowing before the measurements. First, acceptance at temperature 1 tends to be lower than at temperature 0 for the same drafter, because a greedy proposal that is the target's top token is always accepted at temperature 0 and only with probability p(x) at temperature 1. Second, "the same distribution" is a statement about probabilities, and it does not promise the same text as a run without speculation: a sampled run uses its random numbers differently, and even a greedy run computes its logits in passes of a different shape, which can change which of two nearly tied logits is larger. The lab measures how often that happens.

## Tokens per pass, and the formula for speed

If each proposal were accepted independently with probability α, the number of tokens a pass emits would be a geometric variable capped at k + 1, with mean

tokens per pass = (1 − α^(k+1)) ÷ (1 − α).

This is Equation 1 of the Leviathan paper, which writes γ where this chapter writes k. vLLM reports the same quantity from its counters as the **mean acceptance length**, 1 + accepted draft tokens ÷ drafts.

```text
Tokens per target pass, (1 - a^(k+1)) / (1 - a), and in brackets a simulation of 100,000 passes
    acceptance a   k = 1             k = 3             k = 5             k = 8
    0.3            1.30 (1.30)     1.42 (1.41)     1.43 (1.43)     1.43 (1.42)
    0.5            1.50 (1.50)     1.88 (1.88)     1.97 (1.97)     2.00 (2.00)
    0.7            1.70 (1.70)     2.53 (2.53)     2.94 (2.95)     3.20 (3.21)
    0.8            1.80 (1.80)     2.95 (2.95)     3.69 (3.69)     4.33 (4.33)
    0.9            1.90 (1.90)     3.44 (3.44)     4.69 (4.69)     6.13 (6.12)
```

The table shows why acceptance rate matters more than draft length. At α = 0.5 no draft length gets past 2 tokens per pass, because a draft survives to position 4 one time in sixteen. Going from 0.7 to 0.9 at k = 5 is worth more than any amount of extra drafting at 0.7.

To turn tokens into time the paper adds one number, the cost coefficient c: the time of one drafter step divided by the time of one target pass. A round is k drafter steps and one target pass, so it takes kc + 1 target passes of time, and the paper's Theorem 3.8 gives the expected speed-up as

speed-up = (1 − α^(k+1)) ÷ ((1 − α)(kc + 1)).

```text
The paper's speed-up, tokens per pass / (k c + 1), for a draft that costs c target passes per token
    a = 0.7        k = 1       k = 3       k = 5       k = 8
    c = 0.0        1.70        2.53        2.94        3.20
    c = 0.05       1.62        2.20        2.35        2.28
    c = 0.15       1.48        1.75        1.68        1.45
    c = 0.3        1.31        1.33        1.18        0.94
```

With a free drafter, longer drafts always help a little. With a drafter that costs 15% of a target pass, the best draft length at α = 0.7 is 3, and a drafter that costs 30% gains at most a third at any length. The paper's own experiments had c below 0.05: a 77-million-parameter T5-small drafting for the 11-billion-parameter T5-XXL reached α = 0.75 on translation at temperature 0 and a 3.4 times speed-up.

The formula rests on two assumptions, and both fail in a serving engine.

The first is independence. Real acceptance need not be the same at every position, and text has easy stretches, where every proposal is right, and hard ones, where the first is wrong. The paper calls the assumption an approximation. The measurements below show a drafter for which it holds well and one for which it does not.

The second is stated in the theorem: the target can evaluate k + 1 positions "in parallel without increasing the walltime". That is true of one request on an otherwise idle accelerator, which is how the paper measured it, at batch size 1 on one TPU. It is the assumption that the arithmetic is free. The same paper's Theorem 3.11 counts what speculation does to the amount of arithmetic: at α = 0.8 and k = 5 with a free drafter, the target performs 1.63 times as many operations per emitted token to run 3.69 times as fast. A serving engine at a large batch size has no idle arithmetic to spend, and the rest of this chapter is largely about what replaces the term kc + 1 there.

## Where drafts come from

A drafter is judged by two numbers: how often its proposals are accepted, and what a proposal costs. The methods in use fall into three families, which sit at different points between "free and often wrong" and "accurate and not free".

**A separate, smaller model.** This is the original method. The drafter is an ordinary language model with the same tokenizer, run autoregressively for k steps. Leviathan and colleagues drafted for T5-XXL with T5-small. Chen and colleagues drafted for the 70-billion-parameter Chinchilla with a 4-billion-parameter model of 8 layers built for the purpose, which took 1.8 ms a token against Chinchilla's 14.1 ms, and measured speed-ups of 1.92 to 2.46 times. A draft model needs no training if a small model of the same family exists, and its acceptance is high because it is a real language model. Its costs are the largest of any method. The ratio c is rarely small: a 1B drafter for an 8B target reads about a sixth of the bytes per step, k times per round. It has its own weights and its own KV cache in GPU memory. And it must be kept in step with the target, prefilling every prompt the target prefills.

**Lookup, with no model at all.** In many requests the answer repeats text that is already in the context: a summary quotes its document, an edited file is mostly the original file, an agent's next step restates the tool output it was given. Prompt lookup decoding, proposed by Apoorv Saxena in 2023, uses this directly. It takes the last few tokens of the sequence, searches for the same n-gram earlier in the sequence, and proposes the tokens that followed it there. The proposal costs a string search on the CPU, and when the model is copying, it is right for many tokens in a row. The author's measurements were a 2.4 times average speed-up on summarization and question answering over a context, with greedy decoding on Mistral 7B, and far less on open chat. When the model is not copying, there is nothing to find.

Two extensions widen what can be looked up. REST retrieves continuations from a datastore built in advance from a corpus, and reports 1.62 to 2.36 times on 7B and 13B models. SuffixDecoding, from Snowflake, keeps suffix trees over the current request and over the outputs of earlier requests, so a server that answers similar requests all day, as an agent pipeline does, drafts from its own history. It also chooses the draft length per step, proposing up to a multiple of the matched length, so a long match yields a long draft and a weak match a short one. Its paper reports a mean speed-up of 5.3 times on a proprietary agentic SQL workload and 2.5 times on SWE-Bench, and reports that on ordinary chat benchmarks it is behind model-based drafters.

**Extra heads on the target model.** The third family trains a small network that reads the target's own hidden states, so the drafter starts from everything the target has already computed about the context.

Medusa adds K heads to the last hidden state, each a one-layer feed-forward network with a residual connection, where head k predicts the token k + 1 positions ahead. All heads run on the same hidden state at once, so drafting costs almost nothing. The weakness is that the heads do not see each other's choices: the proposal for position 3 is made without knowing what was proposed for position 2. Medusa compensates by taking several candidates per head and verifying a tree of combinations in one pass, with an attention mask that lets each candidate see only its own branch. Its paper reports 2.2 times with the base model frozen and 2.3 to 2.8 times with the base model fine-tuned together with the heads. Its preferred acceptance test, typical acceptance, keeps any token the target finds plausible enough. That is faster than the exact rule, and the paper says plainly that it does not preserve the target's distribution.

EAGLE fixes the weakness by making the head autoregressive. Its drafter is one transformer decoder layer and a linear layer, about 0.24 billion trainable parameters for a 7B target, and it borrows the target's embedding table and output head. It predicts the next hidden state from the previous ones, in the target's own feature space, and it is given the tokens that were actually sampled, shifted one step ahead, since a hidden state alone does not say which of several likely tokens was chosen. The paper reports that this one change raised its speed-up on Vicuna 7B from 1.9 to 2.8 times. EAGLE-2 keeps the same network and changes the search: it grows the candidate tree where the drafter is confident, having found that the drafter's confidence predicts acceptance well, and reports 3.05 to 4.26 times. EAGLE-3 retrains the network. It drops the requirement that the head reproduce the target's hidden states and trains it to predict tokens directly, feeds it a fusion of hidden states from a low, a middle and a high layer of the target in place of the top layer alone, and trains it on its own earlier outputs so that later draft steps see at training time the inputs they will see in use. The paper reports up to 6.5 times at batch size 1.

Multi-token prediction is the same idea moved into pretraining. DeepSeek-V3 was trained with one extra module that predicts the token after next, a single transformer block that shares the model's embedding and output head, as an auxiliary loss that improves the main model. The module can be discarded at inference or kept as a drafter. The technical report gives an acceptance rate of 85 to 90% for its one extra token and 1.8 times the tokens per second.

| Drafter | What a proposal costs | Extra GPU memory | Training needed | Where acceptance is high |
|---|---|---|---|---|
| Smaller model of the same family | k forward passes of the small model | Its weights and its own KV cache | None | Everywhere the small model is competent |
| Prompt lookup (n-gram) | A search of the sequence on the CPU | None | None | Only where the output repeats the context |
| Suffix decoding | A suffix-tree lookup on the CPU | None on the GPU | None | Repetition of the context or of earlier responses |
| Medusa heads | One small feed-forward pass | K small heads | Heads, per target model | First one or two positions |
| EAGLE-3 head | k passes of one transformer layer | One layer and its KV | A head, per target model | General text and code |
| Multi-token prediction | One or a few passes of one block | The module | Part of pretraining | Whatever the model was trained on |

One caution applies to every published number above. Nearly all of them were measured at batch size 1, with one request on an otherwise idle GPU, and many use a tree of candidates, which multiplies the tokens the target must verify per pass. The EAGLE-3 paper is unusual in also reporting a serving engine under load. In SGLang on an H100, with Llama 3.1 8B, a chain of 3 draft tokens and no tree, its speed-up falls from 1.81 times at batch size 2 to 1.38 times at batch size 64, and the first EAGLE falls below 1.0 at batch size 24. Those two numbers are the subject of the second half of this chapter.

## Speculation inside vLLM

vLLM turns speculation on with one flag, whose value is a JSON object that names a method and its settings.

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct \
  --speculative-config '{"method": "eagle3", "model": "RedHatAI/Llama-3.1-8B-Instruct-speculator.eagle3", "num_speculative_tokens": 3}'
```

The methods of 0.32.0 are listed in `config/speculative.py`, and the drafters themselves are in `v1/spec_decode/`.

| `method` | Drafter | Runs on |
|---|---|---|
| `draft_model` | A second language model, named in `model` | GPU |
| `ngram` | Prompt lookup: the longest match of `prompt_lookup_min` to `prompt_lookup_max` tokens | CPU, compiled with Numba |
| `ngram_gpu` | The same lookup as tensor operations | GPU |
| `suffix` | Suffix decoding, from the Arctic Inference package | CPU |
| `eagle`, `eagle3` | An EAGLE head, named in `model` | GPU |
| `medusa`, `mlp_speculator` | Medusa heads, or a small multi-layer perceptron per draft position | GPU |
| `mtp` and the model-specific variants | The target's own multi-token prediction module | GPU |

Every method produces a **chain**: one proposal per position, k positions deep. The candidate trees of the Medusa and EAGLE papers are not implemented in this version. A tree multiplies the tokens a pass must verify, and the measurements below show what extra tokens cost in a batched server.

Chapter 5.2 followed one request through the scheduler, the model runner and the sampler. Speculation adds a loop between the model runner and the scheduler, and changes one thing in each.

1. **The drafter proposes at the end of a step.** After the model runner has sampled, `propose_draft_token_ids` (`v1/worker/gpu_model_runner.py`) calls the drafter for every request in the batch. The CPU drafters read the request's token ids. An EAGLE head (`SpecDecodeBaseProposer.propose` in `llm_base_proposer.py`) is handed the hidden states the target just computed. EAGLE-3 takes them from three layers, by default layers 2, n ÷ 2 and n − 3, which are 2, 16 and 29 of Llama 3.1 8B's 32. The head first runs over the positions the target just processed, which keeps its own KV cache up to date, and then runs k − 1 more steps of one token per request, each fed the token it just proposed.
2. **The proposals go back to the scheduler.** The engine core passes them to `Scheduler.update_draft_token_ids`, which stores them on each request as `spec_token_ids`.
3. **The scheduler schedules them as ordinary tokens.** The scheduler of chapter 5.2 gives each request enough tokens for its computed count to catch up with its total. With speculation the total is the prompt, the output and the draft tokens, so a decoding request is scheduled for 1 + k tokens where it used to get 1. Those tokens are charged against the step's token budget like any others, and KV blocks are allocated for them. For EAGLE and draft models the allocation also reserves k lookahead slots, because the drafter writes its own keys and values for the positions it proposes.
4. **The target verifies.** The forward pass is unchanged, and for each request it returns k + 1 rows of logits. `RejectionSampler` (`v1/sample/rejection_sampler.py`) samples the bonus token from the last row with the normal sampler, then runs a Triton kernel with one program per request that walks the draft left to right. For a greedy request it compares each draft token with the argmax of its row and stops at the first difference. For a sampled request it applies the rule of the previous section, with the draft probability taken as 1 unless `draft_sample_method` is `probabilistic`. The result is a tensor of k + 1 token ids per request, in which everything after the first rejection is a placeholder.
5. **The scheduler rolls back.** In `update_from_output`, the number of accepted tokens is the number of tokens the request received minus one, the rest of the draft was rejected, and `num_computed_tokens` is reduced by that many. The KV slots of the rejected positions are written again in the next step.

The lookup drafters cost the engine something that does not show in this list. `ngram` and `suffix` run on the CPU and need each step's sampled tokens there before they can propose, so vLLM turns off asynchronous scheduling, the default of chapter 5.2 in which the CPU prepares step N + 1 while the GPU runs step N, and logs that it has. `ngram_gpu` exists to avoid this: it does the lookup on the GPU and keeps asynchronous scheduling.

vLLM exports counters for speculation, and every ten seconds logs a line computed from them. This one is from the lab's EAGLE-3 server while it answered 32 chat requests at a time at temperature 1.

```text
SpecDecoding metrics: Mean acceptance length: 2.24, Accepted throughput: 892.42 tokens/s, Drafted throughput: 2167.30 tokens/s, Accepted: 8925 tokens, Drafted: 21675 tokens, Per-position acceptance rate: 0.625, 0.386, 0.224, Avg Draft acceptance rate: 41.2%
```

| Counter | Counts |
|---|---|
| `vllm:spec_decode_num_drafts` | Target passes that verified a draft, one per request per step |
| `vllm:spec_decode_num_draft_tokens` | Draft tokens verified |
| `vllm:spec_decode_num_accepted_tokens` | Draft tokens accepted, not counting bonus tokens |
| `vllm:spec_decode_num_accepted_tokens_per_pos` | Accepted tokens at each draft position |

The mean acceptance length is 1 + accepted ÷ drafts, and it is the number to watch: for a drafter that drafts on every pass, it is the tokens a request gets from one pass. A drafter that skips passes when it has nothing to propose, as suffix decoding does, gets fewer tokens per pass than its acceptance length, because the passes without a draft are not counted. The draft acceptance rate, accepted ÷ drafted, is easy to misread. A draft that is rejected at position 1 still counts positions 2 and 3 as drafted and not accepted, so the rate falls as k grows even when the drafter is no worse. The per-position rates are unconditional: 0.224 at position 3 is the share of drafts in which all three tokens were accepted. Dividing each by the one before gives the chance that a token is accepted given that the draft got that far, which here is 0.63, 0.62 and 0.58.

Two more settings matter for the measurements that follow. `num_speculative_tokens_per_batch_size` takes a list of ranges of batch size with a draft length for each, down to 0, so a server can speculate deeply when nearly idle and not at all when full. And `rejection_sample_method: synthetic` replaces verification with a coin flip tuned to a chosen mean acceptance length, which is of no use in production and of great use in a benchmark, since it separates what a drafter costs from how good it is. The lab uses it.

## Six drafters on an H100

The lab script, [spec_decode_bench.py](/labs/infra/gpu/spec_decode_bench.py), serves Llama 3.1 8B from vLLM 0.32.0 on an H100, once without speculation and once with each drafter, and runs two workloads against every server.

- **Chat.** Each request asks for about 200 words on a different technical question, with a 62-token prompt and an answer capped at 256 tokens. Nothing in the answer is in the prompt.
- **Code.** Each request holds a different 43-line Python class and asks for the whole file back with one small change. The prompt is about 373 tokens and the answer about 306, nearly all of it copied.

Every prompt is different, so the prefix cache contributes nothing. Each workload runs closed-loop at 1, 8, 32 and 128 requests in flight, at temperature 0. The drafters are prompt lookup with 5 draft tokens and a match of 2 to 5 tokens, suffix decoding with up to 16, the EAGLE-3 head that Red Hat trained for this model with 3 and with 5, and Llama 3.2 1B as a draft model with 5. Without speculation the server produced 155, 1,184, 4,355 and 13,350 output tokens a second on chat at the four concurrencies, and 154, 1,129, 3,838 and 9,534 on code. The tables give each drafter's throughput as a multiple of those. The row for prompt lookup on the GPU (`ngram_gpu`) comes from a second run on another H100, divided by that run's own baseline, which was within 4% of the first at every concurrency.

| Chat workload | Acceptance length | 1 request | 8 | 32 | 128 |
|---|---|---|---|---|---|
| Prompt lookup, k = 5 | 1.06 | 0.88× | 0.83× | 0.74× | 0.40× |
| Prompt lookup on the GPU, k = 5 | 1.06 | 1.05× | 1.02× | 0.91× | 0.47× |
| Suffix decoding, k ≤ 16 | 1.28 | 0.89× | 0.90× | 0.88× | 0.63× |
| EAGLE-3 head, k = 3 | 2.45 | 2.03× | 1.89× | 1.76× | 1.17× |
| EAGLE-3 head, k = 5 | 2.67 | 2.01× | 1.88× | 1.69× | 0.92× |
| 1B draft model, k = 5 | 3.16 | 0.66× | 0.60× | 0.61× | 0.54× |

| Code workload | Acceptance length | 1 request | 8 | 32 | 128 |
|---|---|---|---|---|---|
| Prompt lookup, k = 5 | 4.47 | 3.56× | 3.23× | 2.63× | 1.51× |
| Prompt lookup on the GPU, k = 5 | 4.47 | 4.30× | 3.93× | 3.04× | 1.67× |
| Suffix decoding, k ≤ 16 | 9.26 | 6.11× | 4.81× | 3.01× | 1.57× |
| EAGLE-3 head, k = 3 | 3.60 | 2.93× | 2.78× | 2.38× | 1.54× |
| EAGLE-3 head, k = 5 | 4.85 | 3.57× | 3.35× | 2.66× | 1.52× |
| 1B draft model, k = 5 | 5.97 | 1.24× | 1.20× | 1.26× | 1.20× |

The acceptance lengths are those at one request in flight. They barely move with concurrency, as they should not: the EAGLE-3 head's was 2.45, 2.47, 2.42 and 2.46 on chat. What a drafter proposes does not depend on how busy the server is. What its proposals cost does. Suffix decoding is the exception, rising from 1.28 to 1.54 on chat, which fits a drafter that learns from earlier responses, since the larger runs answered more requests.

**The workload decides whether lookup works at all.** On code, where the answer repeats the prompt, prompt lookup emits 4.4 tokens per pass and suffix decoding 8.8, and one request runs 3.6 and 6.1 times as fast: 942 tokens a second from a model that decodes at 154. Suffix decoding's advantage is its adaptive length, since after a long match it proposes up to 12 tokens where prompt lookup stops at 5. On chat there is nothing to copy. Lookup is right about once in thirty passes, and the two CPU lookup drafters make the server slower at every concurrency.

**Lookup that finds nothing is not free in this version of vLLM.** Two costs remain when the lookup fails, and the three lookup rows separate them. The first is the scheduling mode: with a CPU drafter the engine gives up asynchronous scheduling. That is the 12% that `ngram` loses on chat at one request, where `ngram_gpu`, which proposes exactly the same tokens and keeps asynchronous scheduling, gains 5%. It is also why `ngram_gpu` is a fifth faster than `ngram` on code. The second cost is in the counters. On the chat run at one request, vLLM recorded 1,424 drafts of 5 tokens each for 1,519 output tokens, with either n-gram drafter. Almost every pass carried five draft positions through the target, although a replay of the same lookup over the same answers ([spec_decode_sim.py](/labs/infra/spec_decode_sim.py)) finds a match on only 125 passes. Five extra positions cost nothing at one request and a great deal at 128, where both n-gram drafters run at less than half the baseline. Suffix decoding drafts only when it has a match, 1.4 tokens on about two thirds of the passes, so it avoids most of the second cost and pays the first: it loses 11% at low concurrency and 37% at 128.

**The EAGLE-3 head is the general-purpose drafter.** It roughly doubles the speed of a chat request, to 314 tokens a second, and triples a code request. It is the only drafter that is ahead on both workloads at every concurrency when k is 3. Its acceptance lengths are close to what its model card reports for it, 2.50 on summarization and 3.02 on code with 3 draft tokens.

**The most accurate drafter is the slowest.** The 1B draft model has the highest acceptance length on chat, 3.16, and on code it is right 99.5% of the time, and it makes chat slower by a third and code faster by only a quarter. The reason is the cost coefficient. Dividing the acceptance length by the speed-up gives the time of one round in plain passes: 3.16 ÷ 0.66 = 4.8, or about 31 ms where a plain pass takes 6.5 ms. Five steps of the draft model account for about 24 ms of that, 4.9 ms a step. Llama 3.2 1B is about 2.5 GB of weights, a sixth of the 8B model's, so the roofline would put its step under 1 ms on this GPU. It takes 4.9 ms, so the step is not limited by memory bandwidth but by fixed costs per layer and per step that do not shrink with the model, the kind of overhead measured in [PyTorch execution for inference](/learn/pytorch-execution). vLLM runs the drafter in piecewise CUDA graphs, which leave each layer's attention outside the graph, but these runs did not profile the step, so they cannot say which overhead dominates. So c is 0.75 here, where the paper's experiments had c below 0.05. The EAGLE-3 head, one layer in place of sixteen, costs about 0.45 ms a step.

**Every speed-up shrinks as the server fills, and the longer draft shrinks faster.** The EAGLE-3 head with 3 draft tokens goes from 2.03 times at one request to 1.17 times at 128 on chat. With 5 draft tokens it starts level, at 2.01 times, and ends at 0.92 times: at 128 requests in flight the deeper draft makes the server slower than no speculation. On code, where most draft tokens are accepted, the deeper draft is still ahead at 32 and level at 128.

vLLM's answer to this is a schedule. A third run gave the EAGLE-3 server `"num_speculative_tokens_per_batch_size": [[1, 16, 5], [17, 64, 3], [65, 1024, 1]]`, which drafts 5 tokens when a step holds up to 16 requests, 3 up to 64, and 1 beyond. On chat it was 2.01, 1.89 and 1.76 times as fast as its baseline at 1, 8 and 32 requests, which are the fixed 5-token server's numbers at 1 and 8 and the fixed 3-token server's at 32, and its counters show the fourth and fifth positions almost unused at 32. The run at 128, where the schedule asks for one draft token, ended with a failed request in this version, so the reference results for the schedule stop at 32.

**Draft position matters for a head and not for a model.** Dividing each per-position acceptance rate by the one before gives the chance that a draft token is accepted when all the tokens before it were.

| Drafter, chat workload | Position 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| EAGLE-3 head, k = 5 | 0.71 | 0.65 | 0.62 | 0.54 | 0.47 |
| 1B draft model, k = 5 | 0.74 | 0.72 | 0.73 | 0.76 | 0.73 |
| EAGLE-3 head, k = 5, code | 0.93 | 0.93 | 0.92 | 0.86 | 0.87 |

The draft model is a language model, and its fifth token is as good as its first, so the capped geometric formula describes it well: α = 0.74 predicts 3.2 tokens per pass and it produced 3.16. The head gets worse with depth. Its first step reads the target's true hidden states, and each later step reads its own approximation of them. With α taken from position 1, the formula predicts 3.0 tokens per pass at k = 5 and the head produced 2.67. Positions 4 and 5 together add 0.22 tokens per pass over k = 3, and they cost two more positions per request on every pass. The head's own configuration file sets 3 draft tokens.

**Sampling costs a little acceptance.** At temperature 1 the EAGLE-3 head's acceptance length on chat was 2.34 against 2.45 at temperature 0, and a single request's decode rate was 1.94 times the baseline's against 2.05 times. A greedy proposal is accepted with the probability the target gives it, which for this model on this text is usually high.

**The drafter takes memory from the KV pool.** The server without speculation had room for 451,056 tokens of KV. With the EAGLE-3 head it had 409,584, 9% fewer, and with the 1B draft model 345,328, 23% fewer: the drafter's weights come out of the same GPU memory, and the pool must also hold the drafter's own keys and values for every token. On an H100 with an 8B model this is affordable. On a 24 GB A10 the same model without speculation has a pool of 29,792 tokens, and with the EAGLE-3 head the pool was between 10,032 and 16,896 tokens in different runs.

**The output is the target's, but not always the same text.** At temperature 0 and one request in flight, every configuration but one produced exactly the same text as the server without speculation for all six chat answers and all six code answers in the main H100 run. The exception was suffix decoding on chat, where two of six matched. The other machines agree less. On a second H100, the EAGLE-3 server with the draft-length schedule, which drafts 5 tokens at one request, matched its baseline on two chat answers of six. On the A10, none of four chat answers matched for any drafter: the texts agree for between 8% and 80% of their length and then continue differently, while three or four of four code answers matched. These runs cannot say how much of that is speculation, because they did not test whether two baseline servers on the same machine agree with each other. vLLM's documentation makes no promise that they do: a pass of a different shape computes slightly different logits, and where two tokens are nearly tied the argmax can change. What the acceptance rule guarantees is the distribution. If a service needs identical text from run to run, test that with speculation on, on the hardware it will run on.

## The price of a pass

The tables mix two things, how often a drafter is right and what its drafts cost. vLLM's synthetic acceptance separates them. The lab starts the EAGLE-3 server three more times with `"rejection_sample_method": "synthetic"` and a mean acceptance length L of 1.0, 2.5 and 4.0. The head still drafts 3 tokens and the target still computes them, and then a coin decides. The text that comes out is not the target's, and only the timing is used. Because L is known exactly, the time of a pass follows from the speed-up: a pass with speculation takes L ÷ speed-up plain passes.

```text
What a pass costs with 3 draft tokens from the EAGLE-3 head (NVIDIA H100 80GB HBM3, chat workload)
    The synthetic rows fix the acceptance length L, so (pass with speculation) / (plain pass) = L / speed-up.
    concurrency  plain tok/s  L = 1.0: speed-up, cost   L = 2.5: speed-up, cost   L = 4.0: speed-up, cost   break-even L
              1          155        0.84x,  1.19             2.05x,  1.21             3.26x,  1.23           1.21
              8        1,184        0.83x,  1.20             1.98x,  1.27             3.12x,  1.28           1.25
             32        4,355        0.80x,  1.24             1.87x,  1.34             2.84x,  1.41           1.33
            128       13,350        0.53x,  1.89             1.21x,  2.06             1.77x,  2.25           2.07
```

Three readings of this table are the core of the chapter.

**Speculating is never free.** The row for L = 1.0 is a drafter that is always wrong. It costs 16% of throughput at one request in flight and 47% at 128. A drafter's proposals have to be good enough to pay this back before they gain anything.

**The break-even acceptance length is the cost of a pass.** At one request a pass with 3 draft tokens takes 1.21 plain passes, so the drafter needs an acceptance length above 1.21, about one accepted token every five passes. That bar is low, which is why almost any reasonable drafter helps a lone request. At 128 requests the pass takes 2.07 plain passes, so the drafter must average more than one accepted token per pass merely to break even. The EAGLE-3 head's 2.45 on chat clears it, which is its 1.17 times. Prompt lookup's 1.06 does not come close.

**The cost rises because the arithmetic stops being free.** Without speculation, a step takes 6.4 ms at one request and 8.7 ms at 128: the step is still mostly reading weights. With 3 draft tokens, a step at 128 requests carries 512 tokens where it carried 128, and the time of the pass roughly doubles. The paper's formula has kc + 1 in the denominator, the drafter's time and one target pass of fixed length. In a serving engine the denominator is the drafter's time plus the time of a target pass over k + 1 times as many tokens, and that second term grows with the batch size until it approaches k + 1. In that limit even a perfect drafter gains nothing, since it emits k + 1 tokens in a pass that takes k + 1 times as long.

On an A10, where a plain pass takes 34 ms, the same experiment gives a pass cost of 1.20 at one request and 1.32 at 16, and the EAGLE-3 head was 2.04 and 1.76 times as fast on chat. The 1B draft model, which lost on the H100, wins on the A10, 1.48 times on chat at one request. Its step takes 4.9 ms on the H100 and 6.9 ms on the A10, which is 0.75 of a target pass on the first and 0.20 on the second. The same drafter can be the wrong choice on a fast GPU and a reasonable one on a slow GPU.

## Simulation

The widget is the cost model of the previous section. A target pass takes a fixed time plus a time per token, fitted to the measurements: 6.4 ms plus 0.018 ms a token on the H100, and 34.1 ms plus 0.127 ms on the A10, where the fit rests on two points and is an extrapolation beyond 16 requests. The drafter adds its measured time per step. Each draft token is accepted with the same probability, which you set. The strip on the left draws twelve passes of one request, and the chart shows the speed-up at every batch size for the current settings. The widget charges a lookup drafter nothing, which is what a lookup costs on the GPU and less than vLLM's implementation costs in practice.

```widget
speculation-simulator
```

Try these, in order.

1. Start with the H100, the EAGLE-3 head, acceptance 0.7, 3 draft tokens and a batch of 1. The speed-up is close to the 2.03 times measured on chat. Move the batch size to 128 and compare with the measured 1.17 times.
2. At a batch of 128, raise the draft length to 5. The speed-up falls, but it stays above 1, where the lab measured 0.92 times. The widget gives every position the same acceptance rate, and the real head's fourth and fifth tokens are accepted less often. Lower the acceptance rate to 0.6 and the widget crosses 1 as well. The narration names the best draft length for each setting.
3. Set the acceptance rate to 0.9 and find the best draft length at a batch of 1 and at a batch of 128. Deep drafts pay only when the drafter is nearly always right and the GPU is nearly idle.
4. Choose the 1B draft model on the H100 at acceptance 0.7 and try every draft length. Nothing reaches 1. Switch the GPU to the A10 without changing anything else and read the speed-up again.
5. Choose the lookup drafter, 5 draft tokens and an acceptance rate of 0.1, which is roughly prompt lookup on chat. At a batch of 1 the widget shows a small gain, because its lookup costs nothing. Find the batch size at which the gain turns into a loss.
6. With the EAGLE-3 head and 3 draft tokens, lower the acceptance rate until the speed-up at a batch of 128 falls below 1, and compare the tokens per pass at that point with the break-even length of 2.07 in the previous section.

## Lab: the rule, a lookup drafter, and the servers

**Tier: [Mac] for Part A, [1 GPU] for Part B.**

**Part A, without a GPU.** [spec_decode_sim.py](/labs/infra/spec_decode_sim.py) needs only Python's standard library, and reads two files of results from Part B, which are in the repository: [spec_decode_traces.json](/labs/infra/gpu/spec_decode_traces.json), the token ids of 12 chat and 12 code prompts with Llama 3.1 8B's greedy answers, and [spec_decode_h100.json](/labs/infra/gpu/spec_decode_h100.json). Put both in a folder named `gpu` beside the script.

```bash
python spec_decode_sim.py           # about 6 seconds on an M2
python spec_decode_sim.py --test    # only the self-checks
```

Read `speculative_token`, `ngram_propose` and `replay`, then do four things. First, for p = (0.6, 0.3, 0.1) and q = (0.2, 0.2, 0.6), work out by hand the acceptance probability with a sampled proposal and with a greedy one, and the residual distribution in each case, then check with the functions. Second, before running, predict which workload prompt lookup helps and by roughly how much, then read the replay tables and compare them with what vLLM measured. Third, explain from the replay why a longer draft raises the tokens per pass on code and lowers the share of drafted tokens that are accepted. Fourth, write `adaptive_propose`, which finds the longest match of 2 to 12 tokens and proposes as many tokens as the match was long, and compare it with a fixed draft of 12 on both workloads, counting the draft positions that were computed and rejected.

**Part B, the servers.** The script is [spec_decode_bench.py](/labs/infra/gpu/spec_decode_bench.py). It starts one `vllm serve` per configuration, so the model is loaded once per row.

```bash
cd gpu
modal run modal_run.py --script spec_decode_bench.py --gpu 'H100!' --vllm                    # 26 min, $1.68
modal run modal_run.py --script spec_decode_bench.py --gpu A10 --vllm --args "--quick"       # 30 min, $0.56
modal run modal_run.py --script spec_decode_bench.py --gpu 'H100!' --vllm --args "--only 'off;ngram gpu' --tag h100_ngram_gpu"
python gcp_run.py --script spec_decode_bench.py --gpu L4 --vllm --args "--quick"
```

The times and costs are those of the reference runs, which ran nine configurations. The script now has eleven: `ngram gpu` and `eagle3 dynamic` were measured afterwards in runs of their own with `--only`, about 9 minutes and $0.60 each. `--quick` uses the same model with fewer requests, at 1 and 16 in flight. `--only` takes configuration names separated by semicolons, and should always include `off`, since every result is a ratio to the baseline measured on the same machine. The vLLM image now includes Arctic Inference for suffix decoding, so the launcher rebuilds it on first use.

From your own runs, fill in the two tables of "Six drafters on an H100" and the table of "The price of a pass". Then answer four questions from your numbers. Why does the 1B draft model lose on chat although it has the highest acceptance length? At 128 requests in flight, why is the EAGLE-3 head slower with 5 draft tokens than with 3? For a chat service on this GPU, at what concurrency would you turn speculation off, and what would you measure in production to know that you had reached it? And which drafter would you choose for a service that rewrites files, and what would you check before trusting the 6 times of the table?

<details>
<summary>Reference solution</summary>

*Part A.* With a sampled proposal the acceptance probability is Σ min(p, q) = 0.2 + 0.2 + 0.1 = 0.5, and the residual is max(0, p − q) = (0.4, 0.1, 0) rescaled, which is (0.8, 0.2, 0). With a greedy proposal the drafter always proposes token 3, the target gives it 0.1, so the acceptance probability is 0.1, and the residual is p with token 3 removed, (0.6, 0.3, 0) rescaled to (0.667, 0.333, 0). Both give the target's distribution: in the greedy case token 1 is emitted with probability 0.9 × 0.667 = 0.6.

The replay tables of the unmodified script are these.

```text
Prompt lookup replayed on 12 answers of Llama 3.1 8B, chat: open questions (3,042 output tokens)
    draft tokens k  match length  tokens per pass  passes with a draft  acceptance length  drafted tokens accepted
                 5        2 to 5             1.05                 10%               1.57                     11%
                 5        1 to 5             1.10                 48%               1.21                      4%
                 5        5 to 5             1.00                  1%               1.53                     11%
                 3        2 to 5             1.05                 10%               1.55                     18%
                10        2 to 5             1.05                 10%               1.57                      6%
                20        2 to 5             1.05                 10%               1.57                      3%
                20        5 to 5             1.00                  1%               1.53                      3%
    vLLM measured, k = 5 and match length 2 to 5, on its own chat run at concurrency 1: acceptance length 1.06, 1% of drafted tokens accepted

Prompt lookup replayed on 12 answers of Llama 3.1 8B, code: return the file with one change (3,660 output tokens)
    draft tokens k  match length  tokens per pass  passes with a draft  acceptance length  drafted tokens accepted
                 5        2 to 5             4.72                 82%               5.53                     91%
                 5        1 to 5             4.85                 92%               5.16                     83%
                 5        5 to 5             4.39                 72%               5.74                     95%
                 3        2 to 5             3.41                 87%               3.77                     92%
                10        2 to 5             7.25                 72%               9.62                     86%
                20        2 to 5            10.17                 61%              15.93                     75%
                20        5 to 5             8.67                 44%              18.41                     87%
    vLLM measured, k = 5 and match length 2 to 5, on its own code run at concurrency 1: acceptance length 4.47, 69% of drafted tokens accepted
```

The column to compare with vLLM is tokens per pass: 1.05 against vLLM's acceptance length of 1.06 on chat, and 4.72 against 4.47 on code, where the replay uses twelve answers and vLLM's run six of them. The other columns differ because vLLM's counters record a full draft of 5 on nearly every pass, including the passes on which the lookup found nothing, and so its acceptance length is in effect tokens per pass and its acceptance rate is lower than the replay's.

A longer draft helps on code because a match in a copied file stays right for dozens of tokens, so with k = 5 most drafts are accepted in full and cut short by k. With k = 20 a pass emits 10.2 tokens. The share accepted falls, from 91% to 75%, because every draft now runs on until it hits the one line that was changed, and the positions after that point are computed and discarded.

For the adaptive proposer, change `ngram_propose` to search match lengths from 12 down to 2 and to return as many tokens as the match was long. On the twelve code answers a fixed draft of 12 gives 7.99 tokens per pass and computes 626 positions that are rejected, and the adaptive draft gives 7.72 tokens per pass with 150 rejected. On chat both give 1.05 tokens per pass, with 3,131 rejected positions for the fixed draft and 500 for the adaptive one. A short match is weak evidence, and drafting little after it gives up almost nothing and wastes far less. This is the idea behind suffix decoding's speculation factor.

*Part B.* The reference results are [spec_decode_h100.json](/labs/infra/gpu/spec_decode_h100.json) and [spec_decode_a10_quick.json](/labs/infra/gpu/spec_decode_a10_quick.json), with [spec_decode_h100_ngram_gpu.json](/labs/infra/gpu/spec_decode_h100_ngram_gpu.json), [spec_decode_h100_dynamic.json](/labs/infra/gpu/spec_decode_h100_dynamic.json) and [spec_decode_a10_followup_quick.json](/labs/infra/gpu/spec_decode_a10_followup_quick.json) from the later runs, and the two sections above explain them.

The draft model loses because of its cost and not its accuracy. A round with it takes 4.8 plain passes on the H100 and emits 3.16 tokens. Its step takes 4.9 ms, three quarters of a target pass, although its weights could be read in under 1 ms: on an H100 a 1B model's decode step is bound by fixed overheads and not by memory bandwidth.

With 5 draft tokens at 128 requests, a pass carries 768 tokens where 3 draft tokens carry 512, and on chat the fourth draft token is accepted in 17% of drafts and the fifth in 9%. The acceptance length rises from 2.46 to 2.71, by a tenth, and the pass gets about two fifths longer, from 2.10 to 2.94 plain passes.

For chat with the EAGLE-3 head and 3 draft tokens, the head's acceptance length is 2.45 and the break-even length is 1.33 at 32 requests and 2.07 at 128, so speculation still pays at 128, by 17%, and by extrapolation stops paying not far beyond. The production signals are the ones vLLM exports: the mean acceptance length from the two counters, the number of running requests, and the time per decode step. Speculation should be off, or the draft shorter, when the acceptance length falls towards the cost of a pass at the current load, and vLLM's `num_speculative_tokens_per_batch_size` makes that switch by batch size.

For rewriting files, suffix decoding or prompt lookup, with no trained drafter at all. Before trusting the table, check four things: that the real requests copy as much as this workload does, since the gain is entirely the copied share; the concurrency the service runs at, since 6.1 times at one request is 1.6 times at 128; what the lookup costs on requests that do not copy, where it is a loss; and that answers are still correct, by comparing outputs with speculation on and off.

</details>

## Interview angle

"How does speculative decoding work, and why does it not change the output?" is the opening question. A complete answer has three parts. The mechanism: a drafter proposes k tokens, and the target scores all k + 1 positions in one pass, which costs about one decode step when the step is memory-bound. The rule: accept a proposal with probability min(1, p ÷ q) and on rejection sample from the rescaled max(0, p − q), which at temperature 0 reduces to "accept while the proposal equals the target's argmax". The reason it is exact: the probability of emitting a token is min(p, q) through acceptance plus max(0, p − q) through rejection, which is p. Candidates who can write those two terms down are rare, and it takes a minute.

"When does it hurt?" is the question that separates people who have run it from people who have read about it. Give the structure and then numbers. Speculation spends idle arithmetic, so it pays while the decode step is memory-bound and stops paying as the batch grows, because each pass carries k + 1 times the tokens. In this chapter's measurements an EAGLE-3 head on Llama 3.1 8B on an H100 gave 2.0 times at one request and 1.17 times at 128 with 3 draft tokens, and 0.92 times at 128 with 5. A pass that verifies 3 draft tokens cost 1.2 plain passes at one request and 2.1 at 128, and that number is the acceptance length a drafter must beat. Then add the other ways it hurts: a drafter that costs too much (the 1B draft model at 0.66 times), a drafter with nothing to propose (lookup on open chat), and memory (the drafter's weights and KV come out of the KV pool).

"Which drafter would you use?" should be answered with a question about the traffic. Copy-heavy output, such as code edits, summaries with quotation, and agents that restate tool results, suits lookup, which needs no training and reached 3.6 to 6.1 times here at one request. General chat needs a model-based drafter, and a trained head on the target's hidden states is cheaper per proposal than a separate small model by an order of magnitude. Ask whether a head exists for the model, since each head is trained for one target, and what the fleet's concurrency is, since that sets the draft length.

A good follow-up to expect is about measurement. Know the difference between acceptance rate and acceptance length, that the first falls with k for the same drafter, that per-position rates are unconditional, and that the right comparison is throughput and per-request speed against a baseline on the same machine at the concurrency you serve.

## Check yourself

<details>
<summary>The target model's pass over k + 1 positions emits between 1 and k + 1 tokens. Why at least 1, and what happens to the positions after the first rejected draft token?</summary>

The output at the first position is computed from real tokens only, so it is the target's own next-token distribution, and a token is taken from it whether or not the first proposal is accepted. Positions after the first rejection were computed with a token in their context that is not part of the output, so their logits are discarded, and the KV slots written for them are overwritten in the next step. vLLM's scheduler reduces the request's count of computed tokens by the number rejected.

</details>

<details>
<summary>State the acceptance rule for sampling, and show that the emitted token is distributed as the target's p.</summary>

A token x sampled from the drafter's q is accepted with probability min(1, p(x) ÷ q(x)). On a rejection the token is sampled from max(0, p − q) rescaled to sum to 1. The probability that x is emitted through acceptance is q(x) × min(1, p(x) ÷ q(x)) = min(p(x), q(x)). The probability of a rejection is 1 − Σ min(p, q), which equals the sum of max(0, p − q), so the probability that x is emitted after a rejection is max(0, p(x) − q(x)). The two add to p(x).

</details>

<details>
<summary>vLLM's EAGLE head proposes its most likely token and keeps no draft distribution. How is a proposal verified at temperature 1, and is the result still exact?</summary>

The verifier treats the draft distribution as putting probability 1 on the proposed token x. It accepts with probability p(x), and on a rejection samples from p with x removed and the rest rescaled. This is the general rule with a one-hot q, so the output is still distributed as p: x is emitted with probability p(x), and any other token y with probability (1 − p(x)) × p(y) ÷ (1 − p(x)) = p(y).

</details>

<details>
<summary>A drafter is accepted 70% of the time at every position. How many tokens does a pass emit with 3 draft tokens and with 8, and what does that say about choosing k?</summary>

The formula (1 − α^(k+1)) ÷ (1 − α) gives 2.53 with k = 3 and 3.20 with k = 8. Five more draft positions per request buy 0.67 tokens per pass, because a draft reaches position 8 only 0.7^8 = 6% of the time. Acceptance rate matters more than draft length, and the extra positions are paid for on every pass whether or not they are reached.

</details>

<details>
<summary>The 1B draft model had the highest acceptance length on chat, 3.16, and made the H100 server slower, 0.66 times. Why?</summary>

A round of 5 draft steps and one target pass took about 4.8 times as long as a plain decode step, and 3.16 ÷ 4.8 is 0.66. Each draft step took 4.9 ms against 6.5 ms for a target pass, a cost coefficient of 0.75, because a 1B model's decode step on an H100 is limited by fixed overheads and not by memory bandwidth. On an A10, where the target pass takes 34 ms, the same drafter's step is a fifth of a target pass and it gave 1.48 times.

</details>

<details>
<summary>With 3 draft tokens from the EAGLE-3 head, a pass cost 1.21 plain passes at one request in flight and 2.07 at 128. What do those numbers mean for a drafter, and why does the cost rise?</summary>

They are break-even acceptance lengths: a drafter helps only if it emits more tokens per pass than the pass costs. At one request almost any drafter clears 1.21. At 128 it must average more than one accepted token per pass. The cost rises because a pass with 3 draft tokens carries four times the tokens of a plain step, 512 against 128 at that concurrency. At small batches that arithmetic fits inside the time the GPU spends reading weights, and at large ones it does not.

</details>

<details>
<summary>Prompt lookup made a code-editing request 3.6 times faster and a chat request slower. Why both?</summary>

Lookup proposes the tokens that followed an earlier occurrence of the last few tokens. When the model is copying its prompt, the proposal is right for many tokens in a row, and a pass emitted 4.4 tokens. On open chat nothing in the context predicts the answer, and a pass emitted 1.06 tokens. The server still paid for speculation: its counters show a five-token draft on nearly every pass, and the CPU drafter turns asynchronous scheduling off. The same lookup done on the GPU, which keeps asynchronous scheduling, was 4.3 times faster on code and level on chat at low concurrency.

</details>

## Further reading

- Leviathan, Kalman and Matias, [Fast Inference from Transformers via Speculative Decoding](https://arxiv.org/abs/2211.17192) (ICML 2023). Section 2.3 and Algorithm 1 give the rule, Appendix A.1 the proof, Equation 1 the tokens per run, Theorem 3.8 the speed-up and Theorem 3.11 the extra arithmetic.
- Chen et al., [Accelerating Large Language Model Decoding with Speculative Sampling](https://arxiv.org/abs/2302.01318) (2023), the same method found independently, measured on Chinchilla 70B with a 4B draft model. It writes q for the target and p for the draft, the reverse of Leviathan.
- Saxena, [Prompt lookup decoding](https://github.com/apoorvumang/prompt-lookup-decoding) (2023), the origin of the n-gram drafter, and Oliaro et al., [SuffixDecoding](https://arxiv.org/abs/2411.04975) (NeurIPS 2025), which extends it to earlier responses and adaptive draft lengths. He et al., [REST](https://arxiv.org/abs/2311.08252) (2023) retrieves drafts from a datastore.
- Cai et al., [Medusa](https://arxiv.org/abs/2401.10774) (ICML 2024): extra decoding heads, tree attention and typical acceptance.
- Li et al., [EAGLE](https://arxiv.org/abs/2401.15077), [EAGLE-2](https://arxiv.org/abs/2406.16858) and [EAGLE-3](https://arxiv.org/abs/2503.01840) (2024 to 2025). Section 4.3 of the third paper has the throughput by batch size in SGLang that this chapter's measurements can be compared with.
- Sun et al., [Block Verification Accelerates Speculative Decoding](https://arxiv.org/abs/2403.10444) (ICLR 2025), which verifies a draft jointly and proves that this never accepts fewer tokens than the token-by-token rule. vLLM offers it as `rejection_sample_method: block`.
- DeepSeek-AI, [DeepSeek-V3 Technical Report](https://arxiv.org/abs/2412.19437) (2024), sections 2.2 and 5.4.3, on multi-token prediction used as a drafter.
- vLLM documentation: [speculative decoding](https://docs.vllm.ai/en/latest/features/speculative_decoding/), with a page per method, and the source at v0.32.0: [rejection_sampler.py](https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/v1/sample/rejection_sampler.py), [ngram_proposer.py](https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/v1/spec_decode/ngram_proposer.py) and [llm_base_proposer.py](https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/v1/spec_decode/llm_base_proposer.py).
- [RedHatAI/Llama-3.1-8B-Instruct-speculator.eagle3](https://huggingface.co/RedHatAI/Llama-3.1-8B-Instruct-speculator.eagle3), the head used in the lab, with its acceptance lengths by draft length, and [Speculators](https://github.com/vllm-project/speculators), the library that trained it.
