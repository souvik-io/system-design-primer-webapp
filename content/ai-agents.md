# Agents and tool use

A model call takes a prompt and returns text. It cannot look up an order, send an email or issue a refund, because it has no connection to those systems. An **agent** adds that connection. It is a program that calls a model in a loop. Each time the model replies, the program either accepts the reply as the final answer, or runs the tool the model asked for and returns the result. The model chooses each step. The program decides what each tool does and sets the limits.

The loop makes an agent useful, and it makes one hard to run. Every step is a model call with its own cost and failure modes, and every tool call may change something outside the program. This chapter covers tool calling, the loop's limits, how context grows, how tools connect through the Model Context Protocol (MCP), and how to run long tasks reliably, safely and affordably. The code is a small loop with a scripted fake model, so it runs without an API key. It assumes you know what a model call costs, which [How LLM inference works](/learn/llm-inference) explains.

## From a model call to an agent

Compare two requests. "Where is my order?" needs one model call, if the order is already in the prompt. "Refund order A-1042 if it is eligible" needs a lookup first, and the next step depends on what the lookup returns. No fixed list of steps covers every case, so the program cannot know in advance how many calls it needs.

Anthropic's guide to building effective agents, dated December 19, 2024, separates two designs. In a **workflow**, "LLMs and tools are orchestrated through predefined code paths." In an **agent**, LLMs dynamically direct "their own processes and tool usage." The guide warns that "the autonomous nature of agents means higher costs, and the potential for compounding errors."

In this chapter, an agent is a model, a set of tools and a loop that runs until the task ends or a limit stops it. Start with the simplest design that works: one call when the answer is in the prompt, a fixed workflow when the steps are known, and a loop only when the next step depends on what the model finds.

## Tool calling

A **tool** is a function that the application runs for the model, together with a description the model reads. Each tool has a name, a description and an input schema written in JSON Schema. Here is an invented refund tool in Anthropic's format:

```text
{
  "name": "issue_refund",
  "description": "Refund part or all of one order. Call lookup_order first, and refund only orders whose status is delivered.",
  "input_schema": {
    "type": "object",
    "properties": {
      "order_id": {"type": "string"},
      "amount_cents": {"type": "integer", "minimum": 1}
    },
    "required": ["order_id", "amount_cents"]
  }
}
```

The description matters as much as the schema. Anthropic's docs say Claude decides when to call a tool "based on the user's request and the tool's description." The model "only sees the schema you provided and the result you returned." Definitions also cost tokens on every request, because they are sent as part of the prompt, and the provider adds a few hundred tokens of its own instructions for tool use.

### The call and the result

When the model wants a tool, it stops with `stop_reason` set to `tool_use` and returns one or more `tool_use` blocks. Each block has an `id`, a `name` and an `input` object. Your code runs the function and sends a `tool_result` block in the next user message, naming the call through `tool_use_id`:

```text
{
  "stop_reason": "tool_use",
  "content": [
    {"type": "text", "text": "I'll look up the order first."},
    {"type": "tool_use", "id": "toolu_01Example1",
     "name": "lookup_order", "input": {"order_id": "A-1042"}}
  ]
}
```

```text
{
  "role": "user",
  "content": [
    {"type": "tool_result", "tool_use_id": "toolu_01Example1",
     "content": "{\"status\": \"delivered\", \"total_cents\": 4599}"}
  ]
}
```

Anthropic's docs add three rules. Send one result for every call in a parallel batch, all in one user message, with the result blocks before any text. Report failures with `is_error` set to `true`, and word the message so the model can act on it, such as "Rate limit exceeded. Retry after 60 seconds." And return a result even for a call you decide not to run.

OpenAI's function calling uses the same cycle with other names, as the table shows.

| Idea | Anthropic Messages API | OpenAI function calling |
| --- | --- | --- |
| Tool definition | `name`, `description`, `input_schema` | `type`, `name`, `description`, `parameters` |
| Model asks for a call | `tool_use` block with `id`, `name`, `input` object | `function_call` item with `call_id`, `name`, `arguments` string |
| Your answer | `tool_result` block with `tool_use_id`, `is_error` | `function_call_output` item with `call_id`, `output` string |
| Enforce the schema | `strict: true` on the tool | `strict: true` on the function |

Strict mode makes the arguments match the schema, so missing fields and wrong types go away. It cannot express a rule such as "only if the order was delivered within the return window." The tool has to check business rules itself and refuse the call when they fail.

## The agent loop

The loop runs while the model keeps asking for tools. Anthropic's docs put it this way: while `stop_reason == "tool_use"`, execute the tools and continue the conversation. The loop stops on any other stop reason, such as `end_turn` for a final answer. Treat `max_tokens` as a failure, because a cut-off reply may hold half a tool call. Nothing in the loop caps how long it runs, so the harness needs its own limits:

- A **step budget**: the most model calls one run may make.
- A **cost budget**: the most tokens or money one run may spend.
- A **stop condition**: the model returns an answer with no tool calls.
- An **escalation**: a pause for a person before a risky action.

The sketch makes these concrete. A scripted fake model asks for two tools, then answers. A registry maps each tool to a function and its required fields. The loop checks the step budget before each model call and the token budget after each reply, and it saves state before each tool runs. The four blocks form one standard-library file, `agent_loop.py`.

```python
import json
import os
import uuid

TASK = "A customer asks for a refund on order A-1042."
PAYMENTS = {}      # stands in for the payments service: key -> stored result
REFUNDS_MADE = []  # one entry per real refund, so we can count side effects


def lookup_order(order_id: str, key: str) -> dict:
    return {"order_id": order_id, "status": "delivered", "total_cents": 4599}


def issue_refund(order_id: str, amount_cents: int, key: str) -> dict:
    if key not in PAYMENTS:            # a repeated key returns the stored result
        REFUNDS_MADE.append(key)       # the real side effect happens once per key
        PAYMENTS[key] = {"refunded_cents": amount_cents}
    return PAYMENTS[key]


# The registry: the fields each tool needs, and the function that runs it.
TOOLS = {
    "lookup_order": {"fn": lookup_order, "required": ["order_id"]},
    "issue_refund": {"fn": issue_refund, "required": ["order_id", "amount_cents"]},
}


def fake_model(history: list) -> dict:
    """Scripted stand-in for a model: two tool calls, then a final answer."""
    done = sum(1 for m in history if m["role"] == "tool")
    if done == 0:
        call = {"id": "call_1", "name": "lookup_order", "input": {"order_id": "A-1042"}}
        return {"tool_calls": [call], "tokens": 900}
    if done == 1:
        call = {"id": "call_2", "name": "issue_refund",
                "input": {"order_id": "A-1042", "amount_cents": 4599}}
        return {"tool_calls": [call], "tokens": 700}
    return {"text": "Refunded $45.99 for order A-1042.", "tokens": 300}
```

```python
def execute(call: dict, run_id: str) -> dict:
    entry = TOOLS.get(call["name"])
    if entry is None:
        return {"error": f"unknown tool {call['name']}"}
    missing = [f for f in entry["required"] if f not in call["input"]]
    if missing:                        # the model sees this and can try again
        return {"error": f"missing fields: {missing}"}
    # The key comes from ids the harness recorded, never from the model's text.
    key = f"{run_id}:{call['id']}"
    try:
        return entry["fn"](**call["input"], key=key)
    except Exception as exc:           # report the failure, don't crash the run
        return {"error": str(exc)}


CKPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run_state.json")


def save(state: dict) -> None:
    with open(CKPT, "w") as f:
        json.dump(state, f)
```

```python
def run(max_steps: int = 6, token_budget: int = 5000, crash: bool = False) -> str:
    if os.path.exists(CKPT):           # resume from the last checkpoint
        with open(CKPT) as f:
            state = json.load(f)
        print(f"resuming after {state['steps']} model call(s), "
              f"{len(state['pending'])} tool call(s) pending")
    else:
        state = {"run_id": str(uuid.uuid4()), "steps": 0, "spent": 0, "pending": [],
                 "messages": [{"role": "user", "content": TASK}]}
    while True:
        if state["pending"]:           # finish calls recorded but not yet answered
            call = state["pending"][0]
            result = execute(call, state["run_id"])   # the side effect happens here
            if crash and call["name"] == "issue_refund":
                raise RuntimeError("crashed after the refund, before it was checkpointed")
            state["pending"].pop(0)
            state["messages"].append(
                {"role": "tool", "tool_call_id": call["id"], "content": result})
            save(state)
            continue
        if state["steps"] >= max_steps:    # step budget
            return "stopped: step budget reached"
        reply = fake_model(state["messages"])
        state["steps"] += 1
        state["spent"] += reply["tokens"]
        if state["spent"] > token_budget:  # cost budget: this reply is not acted on
            return "stopped: token budget reached"
        if "tool_calls" not in reply:      # stop condition: a final answer, no tools
            return reply["text"]
        state["messages"].append({"role": "assistant", "tool_calls": reply["tool_calls"]})
        state["pending"] = reply["tool_calls"]
        save(state)                        # checkpoint before any side effect runs
```

```python
def fresh() -> None:
    if os.path.exists(CKPT):
        os.remove(CKPT)


if __name__ == "__main__":
    for limits in [{"max_steps": 1}, {"token_budget": 1000}]:
        fresh()
        print(limits, "->", run(**limits))
    fresh()
    try:
        run(crash=True)
    except RuntimeError as exc:
        print("crash:", exc)
    print("resume ->", run())
    print("refunds issued:", len(REFUNDS_MADE))
    fresh()
```

Running `python3 agent_loop.py` prints:

```text
{'max_steps': 1} -> stopped: step budget reached
{'token_budget': 1000} -> stopped: token budget reached
crash: crashed after the refund, before it was checkpointed
resuming after 2 model call(s), 1 tool call(s) pending
resume -> Refunded $45.99 for order A-1042.
refunds issued: 1
```

The first run stops at the step budget after one model call. The second run stops because the fake model's second reply would take the spend to 1,600 tokens, over the 1,000-token budget, so the loop never acts on that reply. The third run crashes just after the refund, before its result is saved. On restart, the saved state still lists that call as pending. The loop runs it again with the same key, the payments stub returns the stored result, and the run finishes with one refund.

Two lines carry the design. The checkpoint saves the model's reply before any tool runs, and the key combines a run ID with a recorded call ID, so a retry sends the same key. If `issue_refund` ignores the key, the same crash test issues two refunds. The token check comes after the model call, so it limits waste but cannot prevent the first expensive call.

### Where the idea comes from

The 2022 ReAct paper by Yao and colleagues asked a model to generate "reasoning traces and task-specific actions in an interleaved manner." Its reported gains, 34% on ALFWorld and 10% on WebShop in absolute success rate over imitation and reinforcement learning baselines, come from simulated environments.

## Managing context

Each step resends the whole history, so the context grows. Suppose the fixed part is 2,000 tokens and each step adds about 1,200. Step 10 reads 2,000 + 9 × 1,200 = 12,800 tokens. Across 10 steps the model reads 20,000 + 1,200 × 45 = 74,000 input tokens, which is 3.7 times what ten separate calls with the same prompt would read.

The 70B model in the Llama 3 paper's Table 3 has 80 layers and 8 key/value heads. Its head dimension is 8,192 ÷ 64 = 128, so each token's BF16 KV cache is 2 × 80 × 8 × 128 × 2 = 327,680 bytes. Step 10 therefore needs 12,800 × 327,680 = 4,194,304,000 bytes, about 4.2 GB, or roughly three 4,096-token chats. Four 80 GB H100s, with an assumed 10% kept for runtime, leave 288 GB. After 140 GB of weights, 148 GB remains for KV cache, about 35 contexts of 12,800 tokens at once. [Inference engines](/learn/inference-engines#prefix-caching) explains how serving engines manage that memory.

Anthropic's context engineering guide calls context "a finite resource with diminishing marginal returns." Four techniques help:

- **Return less.** The writing-tools guide advises tools to "return only high signal information back to agents," and to page, filter or truncate large results.
- **Clear old results.** Once a tool result has been used, the model rarely needs its full text again. Drop or shorten old results once the prompt passes a threshold, and keep the full history in your own storage. Anthropic's API offers this as a server-side option called context editing (in beta as of October 2026).
- **Summarize.** Compaction, also in beta, replaces older turns with a summary the server writes. The docs say it helps because "response quality degrades as a conversation grows."
- **Keep notes outside the window.** The agent writes notes "outside of the context window" and reads them back when needed. Anthropic's memory tool offers this as files your application controls.

### Caching the stable prefix

Prompt caching matches prefixes: a change at or before a marked point misses the cache. As the conversation grows, the cache point moves forward, so each step reads most of its history from the cache. Keep the system prompt and tool definitions byte-for-byte stable, and only append messages. Cached input is much cheaper than fresh input: as of October 2026, Anthropic prices cache reads at a tenth of the base input price for most models. [Inference engines](/learn/inference-engines#prefix-caching) explains the same idea inside a self-hosted engine.

## Connecting tools with MCP

Without a shared protocol, each agent application needs its own adapter for each system it touches, so N applications and M systems can mean N × M integrations. The Model Context Protocol (MCP) standardizes that boundary. The specification says it standardizes "how to integrate additional context and tools into the ecosystem of AI applications."

MCP has three roles. A **host** is the AI application. Each **client** inside the host talks to one **server**. Servers offer **resources** (context), **prompts** (templates) and **tools** (functions the model can run). Messages use JSON-RPC 2.0. The latest revision, dated 2026-07-28 in its URLs, describes requests as stateless, and it lists stdio and Streamable HTTP among its transports.

```diagram
title: One host, several MCP servers. Each server wraps one system.
[h] Agent host\nmodel + MCP client @ 0,1
[s1] MCP server\norders @ 2,0
[s2] MCP server\nmail @ 2,1
[s3] MCP server\nfiles @ 2,2
[db:store] Orders DB @ 4,0
[mx] Mail API @ 4,1
[fs:store] File store @ 4,2
h -> s1 : tools/call
h -> s2
h -> s3
s1 -> db
s2 -> mx
s3 -> fs
```

A host calls `tools/list` to discover tools. Each entry has a `name`, a `description`, an `inputSchema` in JSON Schema and optional `annotations`. The host runs one with `tools/call`. The spec separates two kinds of failure. A protocol error means a bad request, such as an unknown tool. A tool execution error comes back as a normal result with `isError` set to `true`, so the model can recover from it.

The security section is blunt. Tools "represent arbitrary code execution," hosts "must obtain explicit user consent before invoking any tool," and clients must treat annotations as untrusted unless the server is trusted. MCP "cannot enforce these security principles at the protocol level," so your application has to. MCP has no session that outlives a connection, so a stateful server returns a handle, such as a basket ID, that the model carries forward.

## Running agents reliably

An agent run is a long workflow with side effects. Model calls fail, tools succeed and lose their replies, and workers crash. Three cases cover most of it.

**A model call fails.** Retry with backoff and jitter, as in [Reliability patterns](/learn/reliability-patterns#retries-backoff-and-retry-storms). A model call changes nothing outside the program, so repeating it is safe, but each retry costs tokens.

**A tool times out after succeeding.** The agent cannot tell whether the refund happened, so use an [idempotency key](/learn/reliability-patterns#idempotency-keys). Build it from ids the harness recorded before the call, as the sketch does. A random key per attempt makes every attempt look like a new request. A key derived from the model's wording can change between attempts.

**The worker crashes between steps.** Save the model's reply and its tool calls before any tool runs, then continue from the saved state on restart. Do not ask the model to redo completed steps, because a new call might choose differently.

### Checkpoints and durable execution

Saving state after each step is a **checkpoint**. Workflow engines go further. Temporal records each step as an event and rebuilds a workflow from that history. In its Go walkthrough, the service notices a dead worker after a Workflow Task Timeout, which defaults to 10 seconds. A new worker then re-runs the workflow code against the recorded history. Activity results are reused, and "the Activity is not re-executed" during replay. Its workflow code must be deterministic.

For agents, put each model call and each tool call in its own activity, so replay reads the recorded reply instead of calling the model again. An engine cannot see inside an activity, though. After a crash mid-activity, it cannot tell whether the side effect happened, so the activity must be safe to repeat. Idempotency keys matter even inside a durable engine.

If two workers could claim the same run, use a lease with a fencing token, as in [Consensus](/learn/consensus#leases-and-fencing-tokens). A partly finished run, such as a refund followed by a failed confirmation email, needs compensating steps, as in [Distributed transactions](/learn/distributed-transactions#sagas). Give each call its own timeout and the run a deadline, and trace every step, as covered in [Evaluating and observing AI systems](/learn/ai-evals-and-observability#tracing-model-calls).

## Permissions and sandboxes

Give each tool only the power its task needs, enforced outside the model.

- **Scope each tool.** `lookup_order` reads only the customer's orders. `issue_refund` refunds at most the order total. Each tool holds its own credentials, so the model never holds a key.
- **Enforce limits in the tool.** A system prompt that says "refunds over $100 need approval" is a request. The payments service has to check it. The MCP spec says servers must validate all tool inputs and implement proper access controls.
- **Treat results as untrusted.** Anthropic's docs warn that tool results "often carry content from sources outside your control," and that they can carry instructions. Keep them inside tool result blocks. See [AI security](/learn/ai-security#prompt-injection).
- **Ask a person first.** The MCP spec says hosts "must obtain explicit user consent before invoking any tool." Agent platforms usually offer three settings per tool: always allow, always ask (pause the run until someone approves), or decide per call by rule. Default tools you didn't write to always ask.
- **Sandbox code.** Anthropic's code execution tool runs code "in a secure, sandboxed environment," with internet access "completely disabled for security." Copy those defaults: no network, time and memory limits, a fresh environment per run and no production credentials.

An agent that reads untrusted text, can see private data and can send data outside is the most exposed combination. Remove one of the three where you can. See [AI security](/learn/ai-security#limiting-what-agents-can-do).

## Multi-agent systems

A multi-agent system runs several model loops on one task. In the common orchestrator and workers shape, a lead agent splits the task and gives each worker "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries." Each worker runs in its own context and returns a condensed result.

```diagram
title: Orchestrator and workers. Each worker starts with a fresh context.
[u:client] Task @ 0,1
[lead] Lead agent\nkeeps the plan @ 1.5,1
[w1] Worker 1\nown context @ 3,0
[w2] Worker 2\nown context @ 3,1
[w3] Worker 3\nown context @ 3,2
u -> lead
lead <-> w1 : brief, summary
lead <-> w2 : brief, summary
lead <-> w3 : brief, summary
```

Workers run in parallel and keep their contexts small. Anthropic's post says these systems suit tasks with "heavy parallelization" and information that "exceeds single context windows." They also cost more. Anthropic reports that "agents typically use about 4× more tokens than chat interactions," and that "multi-agent systems use about 15× more tokens than chats." Its evaluation found that "token usage by itself explains 80% of the variance," so on that evaluation, spending more tokens bought better results.

Try the arithmetic with invented numbers. A chat answer uses 5,000 tokens, so the multiples give 20,000 tokens for an agent and 75,000 for a multi-agent run. At 10,000 tasks a day and an assumed $5 per million tokens (real prices vary), chat costs about $250 a day and multi-agent about $3,750. Per task, that is 2.5 cents against 37.5 cents.

Coordination adds costs too. A weak brief wastes a worker's run, summaries drop detail, and a worker's output can carry injected instructions into the lead's context. The post says multi-agent systems are "not a good fit" for domains that require "all agents to share the same context," and it notes that most coding tasks have fewer parallel parts than research. Start with one agent. Split work only when the parts are independent and the task is worth the tokens.

## Measuring agents

Measure runs by their final state and their cost.

- **Task success rate**: the share of runs whose final state is correct, checked with code. For the refund agent, the ledger should show exactly one refund of $45.99 on order A-1042. A transcript that says "refunded" can still be wrong.
- **Cost per successful task**: total spend divided by successes. Suppose 1,000 runs cost $0.10 each and 600 succeed. The total is $100, so each success costs about $0.17.
- **Steps per task**: model calls per run, at the median and the 95th percentile. A rising count often signals a loop.

A single-try success rate can hide inconsistency. The τ-bench paper defines pass^k as "the chance that all k i.i.d. task trials are successful, averaged across tasks." Its best function-calling agent, using gpt-4o, averaged above 60% success per task, yet its pass^8 fell below 25%. If each try succeeds with probability 0.9 and the tries are independent, all eight succeed with probability 0.9^8, about 0.43.

Build the test set from real requests, including tasks that need several tool calls. Anthropic's guide says prompts should be "inspired by real-world uses," and that "strong evaluation tasks might require multiple tool calls." Rerun the set after any change to the model, a prompt, a tool description or a limit. An agent that gets cheaper by succeeding less has saved nothing. The [evals chapter](/learn/ai-evals-and-observability#building-an-eval-set) explains how to build the set.

## Check yourself

<details>
<summary>An agent takes 8 steps. The fixed prompt is 3,000 tokens, and each step adds 1,500 tokens of tool results and 300 tokens of model output. How many input tokens does step 8 read, and how many do all 8 steps read together?</summary>

Step 8 reads 3,000 + 7 × 1,800 = 15,600 tokens. Over all 8 steps, the fixed 3,000 is read 8 times (24,000), and the growth adds 1,800 × 28 = 50,400, for 74,400 input tokens.

</details>

<details>
<summary>A refund call times out after the payments service processed it. The harness retries with a new random key. What happens, and what should the key be?</summary>

The service treats the retry as a new request, so the customer is refunded twice. The key should come from the run ID and the recorded call ID, so every attempt sends the same key and gets the stored result. Retry from the saved call record, since asking the model again may produce a different call.

</details>

<details>
<summary>After a release, cost per task rose from $0.12 to $0.31, success stayed at 90%, and steps per task rose from 6 to 14. Where do you look first?</summary>

Look at the traces of the longer runs. A rising step count with flat success usually means a loop: one tool called repeatedly, or errors that do not say what to try next. Check whether tool results grew and whether a changed description sent the model to the wrong tool.

</details>

<details>
<summary>Every night a job matches 20,000 bank lines to invoices with fixed rules and sends unmatched lines to a person. Should it be a single model call, a workflow or an agent?</summary>

A workflow. The steps are known, so ordinary code does the matching. A model can help with messy free-text references on unmatched lines, and anything it cannot resolve goes to a person.

</details>

<details>
<summary>An MCP server you did not write marks a tool readOnlyHint: true. A teammate wants to auto-approve every read-only tool from any server. What do you say?</summary>

The spec says clients must treat annotations as untrusted unless the server is trusted, so the hint is only the server's claim. Approve tools by how far you trust the server, and keep human approval for anything that can write or send data.

</details>

<details>
<summary>An agent is correct on 85% of independent tries. What is the chance it is correct on all 5, and what would you change before using it in a pipeline that cannot retry?</summary>

0.85 × 0.85 × 0.85 × 0.85 × 0.85 is about 0.44 (pass^5), so a pipeline that needs all five to pass fails about 56% of the time. Raise per-try reliability with better tools and final-state checks, add idempotent retries, or send failures to a person.

</details>

## Further reading

- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/latest): roles, base protocol and security principles, in the 2026-07-28 revision.
- [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): exact `tools/list` and `tools/call` shapes and error types.
- [Tool use with Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview): client and server tools, with the tool-use token table.
- [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls): the `tool_use` and `tool_result` formats, `is_error` and untrusted results.
- [Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use): running several calls at once.
- [How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works): where each kind of tool runs, and the loop's stop reasons.
- [OpenAI function calling guide](https://developers.openai.com/api/docs/guides/function-calling): the same cycle in OpenAI's shapes.
- [Building effective agents](https://www.anthropic.com/research/building-effective-agents) (Anthropic, December 19, 2024): workflows versus agents. Its page notes that much of the tooling has changed.
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) (Yao et al., 2022): interleaving reasoning and actions.
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (Anthropic, June 13, 2025): token multiples and the lead-and-subagent design.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Anthropic, September 29, 2025): compaction, note-taking and sub-agents.
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (Anthropic, September 11, 2025): what tools should return.
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): prefix matching and cache reads.
- [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) and [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing): two server-side ways to shrink context, both in beta.
- [Code execution tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool): a sandbox with no internet access.
- [Permission policies](https://platform.claude.com/docs/en/managed-agents/permission-policies): one platform's approval modes for tool calls, in beta.
- [Event History walkthrough with the Go SDK](https://docs.temporal.io/encyclopedia/event-history/event-history-go) (Temporal): how durable execution rebuilds state from recorded events.
- [The Llama 3 Herd of Models](https://arxiv.org/html/2407.21783) (Meta, 2024): Table 3 gives the layer and head counts behind the KV-cache arithmetic.
- [NVIDIA H100](https://www.nvidia.com/en-us/data-center/h100/): the 80 GB memory figure for the SXM part.
- [τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045) (Yao et al., 2024): the pass^k reliability metric and its retail results.
