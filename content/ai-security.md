# Security for AI systems

A parameterized SQL query is safe because the database can tell the query text from the values. A language model cannot make that distinction. It reads one stream of **tokens**, the pieces of text it works with, and that stream holds the developer's instructions, the user's question, a fetched web page and a tool's output. Every rule in the [Security](/learn/security) chapter still applies. This chapter covers what the model adds.

This chapter answers six questions:

- What changes when a model reads text from people the app does not trust?
- What is prompt injection, and why can't it be fully fixed?
- Which defenses reduce the damage, and which only look like defenses?
- How do models leak data, and how should an app handle text they write?
- How far should an agent's tools reach?
- How do jailbreaks, unsafe model files and runaway costs fit in?

We'll use **Crumb**, the recipe site from the [Scalability](/learn/scalability) chapter, which has added a chat assistant. It answers questions about recipes, reads a signed-in user's private drafts when asked, and can email a recipe to a friend.

## The new attack surface

The Security chapter's rule against injection is to keep data separate from code, and a model cannot do that. The UK's National Cyber Security Centre (NCSC) wrote in December 2025 that "Current large language models (LLMs) simply do not enforce a security boundary between instructions and data inside a prompt." The **prompt** is everything the model reads for one call, including the system prompt and any text the app added. [LLM inference](/learn/llm-inference) explains tokens and context windows.

Untrusted text arrives from web pages, emails, comments and tool results. Replies go out as text that the app may treat as HTML, SQL, shell commands or tool arguments. Anything in the prompt can come back out, including through logs and caches. Some model files run code when loaded, and every request spends GPU time or money.

OWASP, the Open Worldwide Application Security Project, publishes the [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/). When we checked in October 2026, its main page showed the 2025 edition and no newer one. The table lists its ten items and where each is covered here.

| Item | Where this chapter covers it |
|---|---|
| LLM01:2025 Prompt Injection | [Prompt injection](#prompt-injection) |
| LLM02:2025 Sensitive Information Disclosure | [Leaking data](#leaking-data) |
| LLM03:2025 Supply Chain | [The model supply chain](#the-model-supply-chain) |
| LLM04:2025 Data and Model Poisoning | Briefly, in [the data pipeline](/learn/training-infrastructure#the-data-pipeline) |
| LLM05:2025 Improper Output Handling | [Handling model output safely](#handling-model-output-safely) |
| LLM06:2025 Excessive Agency | [Limiting what agents can do](#limiting-what-agents-can-do) |
| LLM07:2025 System Prompt Leakage | [Leaking data](#leaking-data) |
| LLM08:2025 Vector and Embedding Weaknesses | Briefly, in [RAG](/learn/rag) |
| LLM09:2025 Misinformation | Briefly, in [evaluating AI systems](/learn/ai-evals-and-observability) |
| LLM10:2025 Unbounded Consumption | [Runaway costs](#runaway-costs) |

## Prompt injection

OWASP defines the first risk as: "A Prompt Injection Vulnerability occurs when user prompts alter the LLM's behavior or output in unintended ways." The user's own prompt is only one way in, since any text the model reads can carry instructions. Simon Willison named the attack in September 2022, after SQL injection: "I propose that the obvious name for this should be prompt injection."

```diagram
title: One prompt, many sources. The model reads all of it as text.
[dev:note] Developer's\ninstructions @ 0,0
[user:client] User's\nquestion @ 0,1
[page:note] Untrusted:\nrecipe page and\ncomments @ 0,2
[drafts:store] Private\ndrafts @ 0,3
[p] The prompt\n(one text) @ 1,1.5
[m] Model @ 2.5,1.5
[out:client] Reply and\ntool calls @ 4,1.5
dev -> p
user -> p
page -> p
drafts -> p
p -> m
m -> out
```

The developer's instructions, the question and the fetched content become one text. The model has no separate channel for instructions.

### Direct and indirect injection

In **direct injection**, the attacker types the instructions into the chat, so the harm usually stays in that user's session. In **indirect injection**, the instructions sit in content that the app later gives to the model, such as a web page, an email or a comment. The victim asks about that content, and the attacker never talks to the model. In 2023, Kai Greshake and colleagues demonstrated this in "Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection." They injected prompts "into data likely to be retrieved," against systems that included "Bing's GPT-4 powered Chat and code-completion engines."

### A worked example at Crumb

Priya asks the assistant to summarize a recipe's comments and to check her drafts for the ingredients.

1. The app fetches the recipe page and its comments, which strangers wrote.
2. One comment contains a sentence written as an instruction, asking the assistant to send the reader's drafts to an address the commenter chose. We describe it rather than quote it, since its wording does not matter here.
3. The app joins the developer's instructions, the question, the comments and her drafts into one text. Nothing marks the comment as data that must never be obeyed.
4. The model may follow the sentence and call the email tool with the drafts.
5. Priya gets an ordinary summary. The stranger already has her drafts.

The attacker needed only a public comment. Three things had to line up: the text reached the prompt, the model followed it, and a tool could send data out. Each is a place the app can act.

### Why there is no complete fix

A model follows instructions wherever they appear, and it cannot reliably tell the developer's from an attacker's. The NCSC says that "it's very possible that prompt injection attacks may never be totally mitigated in the way that SQL injection attacks can be." OWASP says it is "unclear if there are fool-proof methods of prevention for prompt injection." In December 2025, OpenAI wrote that prompt injection is unlikely to ever be fully solved, as TechCrunch reported. The defenses below reduce the risk, but none makes injected text harmless by itself.

## Defending against prompt injection

Assume some injected text will reach the model, and design so that a successful injection can do little harm. OWASP's LLM01 page lists seven mitigations. Three shape the design most.

### Enforce rules in code, not in the prompt

If Crumb's system prompt says "Only email the signed-in user," an injected comment can contradict it. The email tool itself should refuse any address other than the user's own or a contact the user picked. The model can ask to send, and the tool decides. OWASP's LLM07 entry says security controls must be "enforced independently from the LLM."

### Separate the model that reads from the model that acts

In April 2023, Willison described the **dual LLM** pattern. A **privileged** model takes the user's instructions and holds the tools, but never reads untrusted text. A **quarantined** model reads untrusted text and has no tools, and its output is treated as untrusted. A **controller**, which is plain code, keeps untrusted text in named variables, so the privileged model can refer to it without seeing it.

```diagram
title: Dual LLM. The model with tools never reads the untrusted page.
[user:client] Priya @ 0,0
[ctrl] Controller\n(plain code) @ 1.5,0
[priv] Privileged\nmodel, tools @ 0,1.5
[quar] Quarantined\nmodel, no tools @ 3,1.5
[tools:store] Tools\n(drafts, email) @ 1.5,3
[page:note] Recipe page\nand comments @ 3,3
user -> ctrl : question
ctrl <-> priv : placeholders, calls
ctrl <-> quar : text, short answer
ctrl -> tools : approved calls
page -> quar : fetched
```

Willison wrote that "The social engineering aspects also mean that this isn't a 100% reliable solution." The 2025 CaMeL paper, "Defeating Prompt Injections by Design," by Edoardo Debenedetti and colleagues, goes further. It extracts the control and data flows from the trusted query, so retrieved data cannot change which steps run. On the AgentDojo benchmark, CaMeL solved 77% of tasks with provable security, against 84% for an undefended system. That 7-point gap is the price of the guarantee.

### Mark untrusted content and constrain what comes back

OWASP's advice to "segregate and identify external content" points the same way: keep retrieved text distinct, and label it as data. These labels are soft controls, since the model can still obey a sentence inside them. Willison's 2022 translation example showed this: a prompt that warned the model about such text still failed. Constrained outputs are harder to abuse. If a quarantined model may answer only "recipe", "comment" or "spam", code has nothing else to act on. If the model proposes a URL to fetch, check its host against an allowlist (a list of permitted values) first, as the [SSRF section](/learn/security#server-side-request-forgery-ssrf) of the Security chapter explains.

Filters catch known patterns, so treat them as one layer. Keep poisoned pages in your evaluation set, and log every denied tool call. [Evaluating AI systems](/learn/ai-evals-and-observability) explains how to build an eval set.

## Leaking data

OWASP's LLM02 entry opens: "Sensitive information can affect both the LLM and its application context." Its examples include personal identifiable information (PII), financial details, health records and security credentials.

### Put only permitted data in the prompt

The model cannot keep a secret from the person it talks to, except by obeying instructions, which can be overridden. So the app decides, before the model runs, what enters the prompt. Priya's drafts go into Priya's prompt and nobody else's. Retrieval must filter by permission before the model sees a document, as [RAG](/learn/rag#retrieving-and-reranking) describes.

System prompts are not secret either. OWASP's LLM07 entry says the system prompt "should not be considered a secret, nor should it be used as a security control." A coupon code in the system prompt is a leak waiting for the right question.

### Data leaves through the reply, the tools and the browser

Data can leave in the reply, in a tool call such as an email, or in a link or image that the browser loads. The last channel is easy to miss. A URL can carry data in its path or query string, so a model that writes a URL can send data to whichever server it names. Sending data to someone who should not receive it is called **exfiltration**.

A 2025 paper, "EchoLeak: The First Real-World Zero-Click Prompt Injection Exploit in a Production LLM System," describes this in a product. "Zero-click" means the victim does nothing. Its abstract describes a Microsoft 365 Copilot vulnerability that "enabled remote, unauthenticated data exfiltration via a single crafted email." Its public CVE identifier is CVE-2025-32711.

### Logs, traces and caches

Logs and traces copy prompts and replies, which often contain personal data. Redact when you log, keep retention short and limit who can read them. OWASP's guidance includes "Tokenization and Redaction."

A model server can also reuse the attention data for a repeated prompt prefix, the [KV cache](/learn/llm-inference#the-kv-cache), through [prefix caching](/learn/inference-engines#prefix-caching). That saves compute, but a cache shared across customers can leak. In a 2025 NDSS Symposium paper, "I Know What You Asked: Prompt Leakage via KV-Cache Sharing in Multi-Tenant LLM Serving," Guanlong Wu and colleagues describe sharing "the Key-Value (KV) cache for identical token sequences among multiple users, saving both memory and computation," which "may lead to new side channel attack vectors." A **side channel** is a measurable effect, such as response time, that reveals something the system meant to hide. The paper names SGLang and vLLM as systems that use this mechanism. Keep prefix caches inside one **tenant**, meaning one customer or team.

### Most leaks need no attacker

In May 2023, The Register reported that Samsung had temporarily banned generative AI tools, after Korean media reports that staff had typed confidential material into ChatGPT while debugging code and writing up meeting notes. Data that leaves the company's systems cannot be pulled back. Prevention is policy and tooling: an approved tool, a list of data that must never be pasted, and controlled retention.

## Handling model output safely

OWASP's LLM05 entry defines the risk as "insufficient validation, sanitization, and handling of the outputs generated by large language models before they are passed downstream to other components and systems." The model should be treated as "any other user, adopting a zero-trust approach." So the Security chapter's rules apply to model output as they apply to form fields.

### Escape for HTML

If a reply reaches the page as raw HTML, a `<script>` tag in it runs in the reader's browser. That is stored cross-site scripting (XSS), with the model standing in for the commenter. Escape the text on the way out. This sketch does that, and it runs as written.

```python
import html

def render_reply(model_text: str) -> str:
    """Turn a model reply into HTML that shows the text and nothing else."""
    escaped = html.escape(model_text, quote=True)  # & < > " ' become entities
    paragraphs = [p for p in escaped.split("\n\n") if p.strip()]
    return "".join("<p>" + p.replace("\n", "<br>") + "</p>" for p in paragraphs)

if __name__ == "__main__":
    reply = 'Your refund is on its way.\n\n<script>alert("hi")</script>'
    out = render_reply(reply)
    print(out)
    # <p>Your refund is on its way.</p><p>&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;</p>
    assert "<script>" not in out
    assert out.startswith("<p>Your refund is on its way.</p>")
    print("ok")
```

The `<script>` tag arrives as harmless text, and the quotes are escaped too, so the text is also safe inside an attribute. Escaping covers text only. Markdown needs a sanitizer with an allowlist of tags, and a URL in an `href` or `src` needs a scheme check, because a `javascript:` URL runs code with no tag at all.

### Build queries from allowlists

If the assistant filters recipes by cuisine, the model should not write SQL. Ask it for a JSON object such as `{"cuisine": "thai"}`, check the value against a fixed list, and pass it as a query parameter. Shell commands follow the same rule: the model chooses from named operations, and the code builds the argument array.

### Images and links are a data channel

When the chat panel renders Markdown, the browser loads each image without a click, and the URL the model wrote can point anywhere. Do not load external images from model output. If you need them, allow only your own hosts through your proxy, and set a Content Security Policy with a tight `img-src`.

## Limiting what agents can do

An agent is a model in a loop that calls tools, as the [AI agents](/learn/ai-agents) chapter explains. Each **tool**, a function the model can ask the app to run, is a permission. OWASP's LLM06 entry names "excessive functionality," "excessive permissions" and "excessive autonomy" as the causes of excessive agency. Its defenses include human-in-the-loop control, so a person approves high-impact actions before they happen.

### The lethal trifecta

In June 2025, Simon Willison named three conditions that together make an agent dangerous:

1. "Access to your private data"
2. "Exposure to untrusted content"
3. "The ability to externally communicate in a way that could be used to steal your data"

"If your agent combines these three features, an attacker can easily trick it into accessing your private data and sending it to that attacker," he wrote. His advice is to "avoid that lethal trifecta combination entirely."

Crumb's assistant has all three. Remove one leg wherever you can, and gate the rest. The NCSC is blunter: "Therefore don't let an LLM processing emails from random external people have access to privileged tools." For Crumb, keep the drafts, which are the feature, and the comments, which are the content, then gate the send. Reading leaks nothing outside the session by itself, and a send is the one way out.

```diagram
title: The lethal trifecta. Remove a leg, or gate the last one.
[priv:store] Private drafts\nand saved lists @ 0,0
[untr:note] Comments and\nrecipe pages\nfrom strangers @ 2,0
[agent] Assistant\n(model + tools) @ 1,1.5
[ext:client] Send email\nto anyone @ 1,3
priv -> agent : reads
untr -> agent : reads
agent -> ext : sends
```

### Give each tool the smallest scope

`read_drafts` returns only the signed-in user's drafts. `search_recipes` queries the public index. `save_to_list` writes only to the user's list. `send_email` reaches only the user or a contact the user picked, with a length limit and no attachments. Crumb has no tool that runs arbitrary SQL or fetches any URL, the open-ended tools that OWASP advises against where possible.

### Ask a person before a risky action

A risky action has effects outside the session, such as sending, paying, deleting or changing settings. A session with untrusted content in it is **tainted**, and in a tainted session every write is risky, because the model's next choice may come from that content. The approval screen must show the exact action, including the recipient and full body. A summary written by the model can be wrong or shaped by injected text.

The gate sits between the model's request and the tool:

```python
from dataclasses import dataclass
from typing import Callable

# Each tool is read, write or external. Unlisted tools are denied.
TOOLS = {
    "read_drafts": "read",
    "search_recipes": "read",
    "save_to_list": "write",
    "send_email": "external",
}

@dataclass
class ToolCall:
    name: str
    args: dict

def allow(call: ToolCall, tainted: bool,
          approve: Callable[[ToolCall], bool]) -> bool:
    """Decide whether a model-requested tool call may run.

    tainted: untrusted text (a page, comment or email) is in the context.
    approve: shows the exact call to a person; returns True or False.
    """
    kind = TOOLS.get(call.name)
    if kind is None:
        return False           # unknown tool: deny by default
    if kind == "read":
        return True            # reads change nothing outside the session
    if kind == "write" and not tainted:
        return True            # a clean session may save to the user's list
    return approve(call)       # tainted writes, and every send, need a person

if __name__ == "__main__":
    never = lambda call: False     # a person who always says no
    always = lambda call: True     # a person who always says yes
    cases = [
        (ToolCall("search_recipes", {"q": "rice"}), True, never),
        (ToolCall("save_to_list", {"id": 7}), False, never),
        (ToolCall("save_to_list", {"id": 7}), True, never),
        (ToolCall("send_email", {"to": "a@example.com"}), False, never),
        (ToolCall("send_email", {"to": "a@example.com"}), True, always),
        (ToolCall("delete_account", {}), False, always),
    ]
    for call, tainted, approve in cases:
        result = allow(call, tainted, approve)
        print(f"{call.name:15} tainted={tainted!s:5} -> {result}")
```

Running it prints:

```text
search_recipes  tainted=True  -> True
save_to_list    tainted=False -> True
save_to_list    tainted=True  -> False
send_email      tainted=False -> False
send_email      tainted=True  -> True
delete_account  tainted=False -> False
```

Unknown tools are denied, so a new tool does nothing until someone classifies it. Reads run freely. Writes run freely in a clean session but need a person in a tainted one, and every send needs a person. Ask only for actions with effects, because if the assistant asks before every search, people will click yes without reading.

If an agent runs code, run it in a sandbox with no network by default, no secrets, and limits on time and memory. OWASP's LLM10 entry lists sandbox techniques among its mitigations.

## Abuse and content safety

A **jailbreak** is a prompt that gets a model to ignore its safety training. OWASP calls it "a form of prompt injection where the attacker provides inputs that cause the model to disregard its safety protocols entirely."

Banned-phrase lists cannot keep up. In a 2023 paper, Andy Zou and colleagues used an automated search to find suffixes, strings of text added to a request, that made models produce objectionable content. Their abstract says the suffixes are "quite transferable, including to black-box, publicly released LLMs," and that one worked on the public interfaces of ChatGPT, Bard and Claude.

A **moderation classifier** is a separate model that labels text or images against categories. OpenAI's guide says its models "detect harmful content in text and images," and recommends using the scores as signals for your own policy. Two limits matter for agents. The endpoint "doesn't cover tool names, tool descriptions, tool schemas, or response-format schemas." And "if you stream a generated response, moderation scores arrive after the full generated output is available." You can wait for the whole reply, which delays the first visible token, or stream and replace a flagged reply. A general chat app can stream. An app for children should hold output until the check passes.

Misuse at scale is mostly a rate and identity problem, which [rate limiting](/learn/rate-limiting) covers.

## The model supply chain

OWASP's LLM03 entry warns that supply chain weaknesses "can affect the integrity of training data, models, and deployment platforms." For some model file formats, the file is code as well as data.

### Why pickle files can run code

Python's `pickle` format stores an object as instructions for a small **stack machine**, a program that pushes and pops values. The Python documentation warns: "The pickle module is not secure. Only unpickle data you trust." Hugging Face's documentation explains that some instructions import a name from a module, and `REDUCE` calls it with arguments, so loading the file runs code. Pickle is "the default format for PyTorch model weights."

PyTorch changed its default for this reason. Since version 2.6, `torch.load` uses `weights_only=True` unless you pass a `pickle_module`. Its [serialization notes](https://docs.pytorch.org/docs/2.6/notes/serialization.html) warn that `weights_only=False` "can result in arbitrary code execution." Load any community checkpoint in an isolated worker with no database access, no network and no secrets. That is [least privilege](/learn/security#the-principle-of-least-privilege) applied to model loading.

### Prefer safetensors

Safetensors is a format "for storing tensors safely (as opposed to pickle)," according to its [documentation](https://huggingface.co/docs/safetensors/index). A **tensor** is a multi-dimensional array of numbers, such as a weight matrix. Its layout is an 8-byte little-endian integer giving the size of a JSON header, then the header, which maps each tensor name to its data type, shape and byte range, then the raw bytes. Nothing in that layout asks a loader to import or call anything. The [README](https://github.com/huggingface/safetensors) marks pickle as "Unsafe, runs arbitrary code."

A safe format does not make a model trustworthy. OWASP warns that "Models are binary black boxes and unlike open source, static inspection can offer little to security assurances."

### Scan, verify and pin

Hugging Face's Hub scans pickle files and lists the modules they import, using `pickletools.genops`, which "allows us to read the file without executing potentially dangerous code." The page says the scan is "not 100% foolproof." OWASP advises that you "only use models from verifiable sources and use third-party model integrity checks with signing and file hashes." Pin the exact commit you reviewed, and check each file's **hash**, a fingerprint of its bytes, in your deploy pipeline.

### A research demonstration

In February 2024, HiddenLayer published "Silent Sabotage: Hijacking Safetensors Conversion on Hugging Face." It described how Hugging Face's conversion bot, SFConvertbot, which turned pickle models into safetensors through pull requests, could be abused. A hijacked model submitted for conversion could persist malicious code "inside the service so that models are hijacked automatically." HiddenLayer says it told Hugging Face before publishing. The lesson is general: a service that converts, hosts or scans model files is part of your supply chain, and it can be attacked like any other build step.

## Runaway costs

OWASP's LLM10 entry describes Denial of Wallet: attackers who send heavy volumes exploit usage-based billing, "leading to unsustainable financial burdens on the provider and risking financial ruin." A bug that loops over a tool call a thousand times burns the same money.

### Where the money goes

API bills count input tokens, everything sent in the prompt, and output tokens, everything written back. An agent resends its growing history at every step, so a run's cost grows with its steps. Assume a model API costs $3 per million input tokens. That is an assumption, since real prices vary widely by provider and commitment.

- One chat turn with a 2,000-token prompt costs 2,000 × $3 ÷ 1,000,000 = $0.006.
- An agent run with 20 steps starts at 10,000 tokens and adds 1,000 tokens of tool results per step. The total is 20 × 10,000 + 1,000 × 190 = 390,000 input tokens, which costs $1.17, about 195 chat turns' worth.

Caching a stable prompt prefix can make repeated text cheaper, as [Managing context](/learn/ai-agents#managing-context) explains, but caps are still needed.

Self-hosting moves the cost from tokens to GPU time. Assume $3.00 per H100-hour. The 70B deployment in [AI estimation](/learn/ai-estimation#memory-for-the-kv-cache) uses four H100s, so 4 × $3.00 = $12.00 an hour, or about $8,760 a month at 730 hours. With a fixed fleet, an attacker cannot raise that bill, but can fill the capacity. If the fleet autoscales, the attacker can do both. Its 148 GB of KV cache holds 148 × 10^9 ÷ 327,680 ≈ 451,660 tokens. Each 4,096-token conversation takes 4,096 × 327,680 bytes ≈ 1.34 GB, so about 110 long conversations fill the cache, and other users wait.

### Put limits at several levels

- **Per request:** cap input and output tokens.
- **Per agent run:** cap steps, tool calls and total input tokens.
- **Per user or key:** use token-based limits, estimating before a call and settling after it. [Token-based rate limits](/learn/llm-gateways#token-based-rate-limits) covers how.
- **Per tenant:** cap concurrent requests, so one customer cannot take all the GPUs.
- **Per team:** set a budget with alerts, and a switch that stops the feature.

The sketch enforces the per-run limit and computes the two costs above.

```python
def run_cost(start_tokens: int, tokens_per_step: int, steps: int,
             usd_per_million: float) -> float:
    """Input cost of an agent run whose prompt grows each step."""
    total = sum(start_tokens + tokens_per_step * i for i in range(steps))
    return total * usd_per_million / 1_000_000

class Budget:
    """Stop an agent run before it passes its step or input-token limit."""

    def __init__(self, max_steps: int, max_input_tokens: int) -> None:
        self.max_steps = max_steps
        self.max_input_tokens = max_input_tokens
        self.steps = 0
        self.input_tokens = 0

    def charge(self, context_tokens: int) -> None:
        """Call before each model call, with the size of the prompt."""
        self.steps += 1
        self.input_tokens += context_tokens
        if self.steps > self.max_steps:
            raise RuntimeError(f"step limit of {self.max_steps} reached")
        if self.input_tokens > self.max_input_tokens:
            raise RuntimeError(
                f"input-token limit of {self.max_input_tokens} reached")

if __name__ == "__main__":
    turn = run_cost(2_000, 0, 1, 3.00)        # one 2,000-token chat turn
    run = run_cost(10_000, 1_000, 20, 3.00)   # 20 steps, prompt grows 1,000 each
    print(f"one turn: ${turn:.3f}")           # one turn: $0.006
    print(f"20-step run: ${run:.2f}, {run / turn:.0f} times one turn")
    # 20-step run: $1.17, 195 times one turn
    for max_steps, max_tokens in [(3, 50_000), (10, 25_000)]:
        budget = Budget(max_steps, max_tokens)
        try:
            for _ in range(4):
                budget.charge(10_000)         # four calls of 10,000 tokens
        except RuntimeError as err:
            print("stopped:", err)
    # stopped: step limit of 3 reached
    # stopped: input-token limit of 25000 reached
```

`Budget.charge` runs before each model call and raises an error when a limit would be passed, so the call that goes over is never sent. The hard stop lives in code the model cannot change.

## Check yourself

<details>
<summary>A Crumb assistant run starts with a 6,000-token prompt and adds 800 tokens of tool results at each of 15 steps. At $3 per million input tokens, what does one run cost, and how many 2,000-token chat turns cost the same?</summary>

Step i (counting from 0) processes 6,000 + 800 × i tokens, so the run processes 15 × 6,000 + 800 × 105 = 174,000 tokens, or $0.522. A 2,000-token turn costs $0.006, so the run costs as much as 87 turns. A step or input-token cap would stop it early.

</details>

<details>
<summary>The 70B deployment on four H100s keeps about 148 GB for the KV cache. How many 4,096-token conversations fit, and what happens when 150 arrive together?</summary>

The cache holds about 451,660 tokens, so about 110 conversations fit. The other 40 wait or are rejected, and everyone's latency rises. A per-tenant cap on concurrent requests stops one customer from taking all the capacity.

</details>

<details>
<summary>Crumb's assistant reads public comments, sees each user's private drafts and can email recipes. Which leg of the lethal trifecta do you remove or gate, and why?</summary>

Keep the comments and the drafts, since they are the content and the feature. Gate the send. Reading leaks nothing outside the session by itself, and sending is the one way out. A send can show the exact recipient and body in a preview, and it can be limited to the user's own address.

</details>

<details>
<summary>After Crumb enables Markdown rendering, a reply makes the reader's browser request an image from a domain Crumb does not own, and the URL includes text from the user's last message. What is happening, and what two changes fix it?</summary>

The reply contains an image whose URL carries data, and the browser loads images without a click. Stop loading external images from model output, or allow only your own hosts through your proxy. Also add a Content Security Policy with a strict `img-src`.

</details>

<details>
<summary>A developer puts live coupon codes in the system prompt with the line "Never reveal these codes." What is wrong, and where should the codes live?</summary>

The system prompt is not a secret. It is part of the model's context, and a clever question can get the model to repeat it. OWASP's LLM07 entry says it "should not be considered a secret, nor should it be used as a security control." The coupon service should check codes on the server, and the model should only ask it to apply one.

</details>

<details>
<summary>A teammate wants to load a 7B community model whose files are PyTorch pickle checkpoints. What do you ask for, and what do you check first?</summary>

Ask for safetensors, whose layout loads without running code. If only the pickle exists, load it in an isolated worker with no database access, no network and no secrets, using `weights_only=True`. Check the source and any signature, pin the exact commit, and compare file hashes. Then run your evaluation set, since a safe format does not show good behavior.

</details>

## Further reading

- [OWASP Top 10 for LLM Applications, 2025](https://genai.owasp.org/llm-top-10/): the ten risks in the table. Start with LLM01, LLM06 and LLM10.
- Simon Willison: his [2022 post on prompt injection](https://simonwillison.net/2022/Sep/12/prompt-injection/), [2023 post on the dual LLM pattern](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/) and [2025 post on the lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/). Read them in that order.
- [Greshake et al., arXiv 2302.12173](https://arxiv.org/abs/2302.12173): the indirect prompt injection study.
- [NCSC, "Prompt injection is not SQL injection (it may be worse)"](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection): why the SQL fix does not carry over.
- [Debenedetti et al., arXiv 2503.18813](https://arxiv.org/abs/2503.18813): CaMeL, with its AgentDojo results.
- [Reddy et al., arXiv 2509.10540](https://arxiv.org/abs/2509.10540): EchoLeak, a zero-click exfiltration in a production product.
- [Wu et al., "I Know What You Asked" (NDSS)](https://www.ndss-symposium.org/ndss-paper/i-know-what-you-asked-prompt-leakage-via-kv-cache-sharing-in-multi-tenant-llm-serving/): prompt leakage through shared KV caches.
- [Zou et al., arXiv 2307.15043](https://arxiv.org/abs/2307.15043): automated jailbreak suffixes that transfer across models.
- [OpenAI's moderation guide](https://developers.openai.com/api/docs/guides/moderation): categories, limits and the streaming caveat.
- [The Register on Samsung (May 2023)](https://www.theregister.com/2023/05/02/samsung_generative_ai_ban/): a leak that needed no attacker.
- [Python's pickle documentation](https://docs.python.org/3/library/pickle.html): the security warning.
- [PyTorch serialization notes, version 2.6](https://docs.pytorch.org/docs/2.6/notes/serialization.html): the `weights_only` default.
- [Hugging Face Hub, pickle scanning](https://huggingface.co/docs/hub/security-pickle): how pickle files run code, and what the scanner misses.
- [Safetensors documentation](https://huggingface.co/docs/safetensors/index) and [README](https://github.com/huggingface/safetensors): purpose and layout.
- [HiddenLayer, "Silent Sabotage"](https://hiddenlayer.com/research/silent-sabotage/): the 2024 research on the conversion bot.
- [TechCrunch on OpenAI and prompt injection (December 2025)](https://techcrunch.com/2025/12/22/openai-says-ai-browsers-may-always-be-vulnerable-to-prompt-injection-attacks/): OpenAI's statement that prompt injection is unlikely to be fully solved.
