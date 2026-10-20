# Retrieval-augmented generation

A plain language model answers from what it learned in training. That knowledge is fixed when training ends, the model can't look anything up while it writes, and it doesn't say where a claim came from. Retrieval-augmented generation (RAG) adds a search step before the model writes. A retriever finds passages likely to help with the question, those passages go into the prompt, and the model answers from them and cites them by number.

The term comes from a 2020 paper by Lewis and colleagues. Their central idea was that a model with a searchable external memory can pick up new facts by changing that memory, without retraining.

The running example is Halden, an invented payroll software company. Its support agents work from a 380-page internal handbook and 1,200 public support articles. The assistant must answer an agent's question from those documents, cite the paragraphs it used, and never show a policy that the asking agent can't read. Numbers about Halden are assumptions, labeled where they appear.

Retrieval usually runs on embeddings. An embedding model turns a passage into a vector, a list of numbers, so that passages with similar meaning point in similar directions. A vector index returns the stored vectors nearest a query's vector. A chunk is a short piece of a document, usually a few paragraphs, stored and retrieved as one unit. [Vector search](/learn/vector-search) explains how embeddings and approximate nearest neighbor indexes work, so here the index is a black box.

## Why retrieve

The weights hold what the model learned in training, and they are hard to change. The RAG paper names the problem: models "cannot easily expand or revise their memory, can't straightforwardly provide insight into their predictions, and may produce 'hallucinations.'" Halden needs private knowledge the model never trained on, answers that follow policies as they change, and a source for every answer.

Retrieval can improve accuracy, but the evidence is specific to the test setup. The authors reported, qualitatively, that their models "hallucinate less" than a BART baseline, a sequence-to-sequence model without retrieval. Their experiments used a December 2018 Wikipedia snapshot, so measure the effect on your own documents.

### RAG, fine-tuning and long context

| | RAG | Fine-tuning | Long context |
|---|---|---|---|
| How knowledge gets in | Retrieved into the prompt per question | Trained into the weights | Whole documents pasted into the prompt |
| Changing a fact | Re-index the document | Train again | Edit the text and resend it every request |
| Citations | Easy: each chunk has an ID | Hard: no source is stored | Possible, but the model must find the passage |
| Best for | Changing facts, private documents, citations | Tone, format, behavior | Small, stable document sets |

Fine-tuning is a weak way to add facts. Ovadia and colleagues found that "while unsupervised fine-tuning offers some improvement, RAG consistently outperforms it, both for existing knowledge encountered during training and entirely new knowledge."

Long context works when the whole corpus fits and traffic is low. Every prompt token is processed on every request, and the model keeps a key and a value for each one for the request's whole life (the KV cache, which [LLM inference](/learn/llm-inference#the-kv-cache) explains). Models also use the middle of a long prompt less reliably. Halden's documents hold about 910,000 words, or roughly 1.2 million tokens at an assumed 1.3 tokens per word. That is about nine times the 128,000-token window that the Llama 3 paper describes.

```diagram
title: Retrieval adds one step before the model writes
[q:client] Agent\nquestion @ 0,0
[r] Retriever\nkeyword + vector @ 1,0
[idx:store] Index\nchunks and vectors @ 1,1
[p] Prompt\nsources + question @ 2,0
[m] Language model @ 3,0
[a:client] Answer with\ncitations [1] [2] @ 4,0
q -> r
r <-> idx : search
r -> p : top chunks
p -> m
m -> a
```

## The indexing pipeline

The indexing pipeline runs whenever a document is added or changed, ahead of any question, so the question path stays fast.

Parsing converts each file to text and keeps its structure: headings, lists and tables. Parsers fail quietly. A two-column PDF can come out in the wrong order, and a page can vanish without an error. Compare the pages going in with the characters coming out, and read a sample by hand.

The pipeline then chunks the text, attaches metadata, embeds each chunk and writes three things: vectors to a vector index, words to a keyword index that supports BM25 scoring (a standard keyword-search method), and chunk text and metadata to a chunk store keyed by chunk ID. The prompt is built from the chunk store, so the source is never reread at question time.

```diagram
title: The indexing pipeline runs when documents change, ahead of questions
[src:client] Sources\nhandbook, articles @ 0,0
[parse] Parse\ntext and structure @ 1,0
[chunk] Chunk and tag\nmetadata, version @ 2,0
[emb] Embedding\nmodel @ 3,0
[vec:store] Vector index @ 4,0
[docs:store] Chunk store\ntext, metadata @ 2,1
[kw:store] Keyword index\nBM25 @ 3,1
src -> parse
parse -> chunk
chunk -> emb
emb -> vec : vectors
chunk -> docs : keep text
chunk -> kw : words
```

Halden's sizes, as assumptions: 380 pages of about 500 words and 1,200 articles of about 600 words make 910,000 words. With 300-word chunks that overlap their neighbors by 50 words, each chunk adds 250 new words, giving 910,000 ÷ 250 = 3,640 chunks. At 1,024 dimensions and 4 bytes per number, the vectors take 3,640 × 1,024 × 4 = 14,909,440 bytes, about 14.9 MB. That fits in one server's memory many times over, so for Halden storage is easy and retrieval quality is the hard part.

## Chunking

A chunk is the unit the system embeds, retrieves and quotes. Its size sets how exactly a search matches a question, how much context each match brings, and how many tokens each retrieved item costs. A token is a piece of text the model reads as one unit, often a word or part of one.

Small chunks match precisely but lose context: "This exception applies to the plans above" means nothing alone. Large chunks keep context, but their vector averages everything in them. The original RAG paper split Wikipedia into disjoint 100-word chunks. No size suits every corpus, so measure recall, as described below, and adjust.

Split on structure first: headings, then paragraphs, and sentences only when a paragraph is too long. Overlap repeats text across boundaries, so a sentence that falls on a boundary appears whole somewhere, at the cost of extra storage.

### Chunking with overlap

The sketch packs paragraphs into chunks of at most `max_words`, and each chunk starts with the last `overlap` units of the one before. A paragraph longer than the limit is split at sentence ends. The sketch counts words to stay dependency-free; production systems count tokens with the embedding model's tokenizer.

```python
import re


def split_long(paragraph: str, max_words: int) -> list[str]:
    """Split a long paragraph into sentence groups of at most max_words."""
    groups, current = [], ""
    for sentence in re.split(r"(?<=[.!?])\s+", paragraph):
        candidate = f"{current} {sentence}".strip()
        if current and len(candidate.split()) > max_words:
            groups.append(current)
            candidate = sentence
        current = candidate
    return groups + [current]


def chunk_document(doc_id: str, text: str, max_words: int = 120, overlap: int = 1) -> list[tuple[str, str]]:
    """Pack whole paragraphs into chunks. Each new chunk starts with the last
    `overlap` units of the previous one, so text near a boundary appears twice."""
    units = []  # paragraphs, each with the separator that comes before it
    for para in (p.strip() for p in text.split("\n\n")):
        if para:
            pieces = [para] if len(para.split()) <= max_words else split_long(para, max_words)
            units += [("\n\n" if i == 0 else " ") + piece for i, piece in enumerate(pieces)]
    chunks, current, size = [], [], 0
    for unit in units:
        n = len(unit.split())
        if current and size + n > max_words:
            chunks.append(current)
            current = current[max(0, len(current) - overlap):]
            size = sum(len(u.split()) for u in current)
            if size + n > max_words:  # the overlap doesn't fit, so start fresh
                current, size = [], 0
        current.append(unit)
        size += n
    if current:
        chunks.append(current)
    return [(f"{doc_id}#{i}", "".join(c).strip()) for i, c in enumerate(chunks)]
```

Here is the refund section of Halden's handbook, four short paragraphs:

```text
Refunds for annual plans are available within 30 days of purchase.

Monthly plans cannot be refunded after the first invoice is paid.

Exception: agents may approve a refund after 30 days when the outage lasted more than 4 hours.

Submit refund requests through the support console and attach the invoice number.
```

With `max_words=30` and `overlap=1`, the function returns three chunks. Each line shows a chunk's word count and the first words of each paragraph in it:

```text
refunds#0 22 words: Refunds for annual plans / Monthly plans cannot be
refunds#1 28 words: Monthly plans cannot be / Exception: agents may approve
refunds#2 29 words: Exception: agents may approve / Submit refund requests through
```

The 30-day rule for annual plans (paragraph 1) and the agent exception (paragraph 3) never share a chunk. A question about the exception can therefore return a chunk that says nothing about which plans it covers. Raising the overlap to two paragraphs wouldn't fix this: the overlap would no longer fit under the 30-word limit, so the function would start each chunk fresh. A 60-word limit keeps the whole section in one chunk. In production, also prepend the heading path to each chunk, and fetch the neighbors of each match.

### Context for each chunk

Anthropic's contextual retrieval has a model write a short description of where each chunk sits in its document, usually 50 to 100 tokens, and prepends it before embedding. On Anthropic's test sets, this cut the fraction of relevant chunks missed in the top 20 from 5.7% to 3.7%. Adding contextual BM25 brought it to 2.9%. The cost is one model call per chunk at indexing time.

### Metadata

Each chunk carries metadata for four jobs: filters (`product = payroll-plus`), citations (title, section path, URL), freshness (version date, content hash) and permissions (the groups allowed to read it). Decide these fields first, because changing chunk boundaries later means embedding every chunk again.

## Retrieving and reranking

At question time, the system rewrites the question, searches in two ways, merges the results and reranks the best candidates.

```diagram
title: One question, two searches, one merge, one rerank
[q:client] Rewritten\nquery @ 0,1
[bm] Keyword search\ntop 50 (BM25) @ 1,0
[vs] Vector search\ntop 50 @ 1,2
[rrf] Merge by rank\n(RRF) @ 2,1
[rr] Cross-encoder\nreranks 50 to 5 @ 3,1
[out:client] Top 5 chunks\nfor the prompt @ 4,1
q -> bm
q -> vs
bm -> rrf
vs -> rrf
rrf -> rr
rr -> out
```

### Query rewriting

"What about annual ones?" means nothing to a search engine. A small model can rewrite the message into a standalone query, such as "refund window for annual plans," using the conversation so far. Each rewrite costs a model call, so keep it only when evaluation shows a gain.

### Hybrid search

Vector search matches meaning, so "money back" finds "refund," but it can miss exact strings such as an error code, ERR-4012. Keyword search with BM25 scores each chunk by the query words it contains, weighted by how rare they are across the corpus. Anthropic describes BM25 as a method that "uses lexical matching to find precise word or phrase matches."

Merge the two lists with reciprocal rank fusion (RRF), which uses ranks and ignores raw scores. A chunk's score is the sum of 1 ÷ (60 + rank) over each list it appears in. Cormack and colleagues proposed RRF in 2009, fixed the constant at 60, and reported that the choice was not critical. A chunk ranked 2nd by BM25 and 5th by vector search scores 1/62 + 1/65 ≈ 0.0315. A chunk ranked 1st only by vector search scores 1/61 ≈ 0.0164. The chunk both searches agree on wins. [Vector search](/learn/vector-search#hybrid-search) covers hybrid search in more depth.

### Permissions at retrieval time

Enforce permissions inside each search, before anything reaches the prompt. A model can repeat any paragraph that reaches its prompt, and an instruction not to share it won't reliably stop it. Filtering a finished list afterward is weaker, because restricted chunks use up candidate slots and any search path that skips the filter leaks. OWASP recommends "fine-grained access controls and permission-aware vector and embedding stores," and it warns that embeddings from one group can be "inadvertently retrieved in response to queries from another group's LLM." Key cached answers by permission groups too.

### Reranking with a cross-encoder

The first-stage vector search compares precomputed vectors, so the query and the chunk are never read together. A cross-encoder reads the query and one candidate together and outputs a relevance score. Nogueira and Cho used BERT this way, with the query as sentence A and the passage as sentence B, scoring each passage independently. Re-ranking BM25's top 1,000 results raised mean reciprocal rank at 10 (MRR@10, defined below) on MS MARCO's development set from 16.7 to 36.5 for their BERT-large model. The gain came from reordering the same candidates.

The cost is one model pass per candidate. With 50 candidates of about 400 tokens each, plus the question repeated with each one, the reranker reads about 21,500 tokens per question. Reranking models are much smaller than the model that writes the answer, but this work still happens on every question and adds latency, so rerank a short list. Anthropic kept the top 150 candidates and reranked them down to 20, which cut its missed-chunk rate from 2.9% to 1.9%.

## Building the prompt

The prompt's contents count against the context window, the most tokens the model reads in one request. They also cost time and memory.

### The token budget

Halden's assumed budget: 600 tokens of instructions, 1,000 of conversation history, five chunks at 400 tokens (2,000), a 50-token question and 700 tokens reserved for the answer. The total is 4,350 tokens, far below the 128,000-token window.

The real limit is memory. Table 3 of the Llama 3 paper gives the 70B model 80 layers, 64 attention heads over a model dimension of 8,192, and 8 key-value heads, so each head is 128-dimensional (8,192 ÷ 64). The cache holds a key and a value per layer, per key-value head, for each token: 2 × 80 × 8 × 128 × 2 = 327,680 bytes per token, using 2 bytes per BF16 number. The 4,350-token prompt needs 4,350 × 327,680 = 1,425,408,000 bytes, about 1.43 GB, for the whole request.

Take the running deployment: 70B weights in BF16 on four 80 GB H100 GPUs, which give 320 GB. About 10% stays free for runtime work (an assumption), leaving 288 GB. The 140 GB of weights leave 148 GB for cache, which holds 148 × 10^9 ÷ 1,425,408,000 ≈ 103 requests of this size at once. If each request pasted 100,000 tokens of handbook, one request would take 32.8 GB, leaving room for about four. Keep stable instructions at the start of the prompt, so the engine can reuse their cached work through [prefix caching](/learn/inference-engines#prefix-caching).

The sketch below estimates tokens as characters divided by 4. Llama 3's tokenizer averaged 3.94 characters per token on a sample of English data, so the estimate suits that tokenizer, and others differ.

### Order and citations

In "Lost in the Middle," Liu and colleagues found a U-shaped curve. Models use information at the start ("primacy bias") and at the end ("recency bias") of a long input better than information in the middle. With GPT-3.5-Turbo, multi-document question answering accuracy "can drop by more than 20%." In the worst case, with 20 or 30 documents, it fell below the 56.1% that the same model scored with no documents at all. Put the best chunks first, and keep the count small.

Number the sources and require citations by number. The app maps [2] to a chunk, and it rejects an answer that cites a number it didn't send. Tell the model to say so when the sources don't answer.

```python
def build_prompt(question: str, ranked: list[dict], budget_tokens: int = 1500) -> tuple[str, list[str]]:
    """Keep chunks in rank order until the estimated token budget is spent.
    Each kept chunk gets a number, which the model must use when it cites."""
    kept, lines, used = [], [], 0
    for chunk in ranked:
        cost = len(chunk["text"]) // 4  # about 4 characters per token
        if used + cost > budget_tokens:
            break
        used += cost
        kept.append(chunk["id"])
        lines.append(f"[{len(kept)}] {chunk['title']}\n{chunk['text']}")
    prompt = ("Answer using only the sources below and cite them as [1], [2]. "
              "If the sources do not answer the question, say so.\n\n"
              + "\n\n".join(lines) + f"\n\nQuestion: {question}")
    return prompt, kept


if __name__ == "__main__":
    ranked = [{"id": f"kb#{i}", "title": f"Article {i}", "text": "word " * 160} for i in (1, 2, 3)]
    prompt, kept = build_prompt("Can agents approve a late refund?", ranked, budget_tokens=500)
    print(kept)  # each chunk is 200 tokens, so the third would push the total past 500
    print(prompt.splitlines()[-1])
    # Expected:
    # ['kb#1', 'kb#2']
    # Question: Can agents approve a late refund?
```

A grounded answer to the refund question looks like this:

```text
Annual plans can be refunded within 30 days of purchase [1]. Agents may approve a refund after 30 days when the outage lasted more than 4 hours [2].
```

Treat retrieved text as data. Wrap each source in clear delimiters, and tell the model to ignore any instructions that appear inside sources. That lowers the risk without removing it. Greshake and colleagues showed that attackers can exploit LLM-integrated applications by "strategically injecting prompts into data likely to be retrieved" ([prompt injection](/learn/ai-security#prompt-injection) covers defenses).

## Keeping the index fresh

Documents change, get deleted and change who may read them, and the index has to follow within a promised time. Suppose Halden promises that an edited policy is answerable within 15 minutes. That number is an assumption, but write the promise down before you design the pipeline.

Version each document by a content hash and its last-modified time. On a change, re-parse and re-chunk that one document, write its new chunks under the new version, switch queries to that version, and then delete the old chunks from every index and cache. A reader should see one version or the other, never a mix.

Test deletes explicitly. After a delete event, search for a phrase from the deleted document and expect zero hits from every path. Route changes through a queue, so a bulk import of 1,200 articles can't overwhelm the embedding service ([queues and async processing](/learn/queues-and-async) covers the pattern). Watch queue lag, the age of the oldest waiting change, because it shows whether the 15-minute promise holds.

Permissions change too. Resolve a user's current groups when the query runs, because groups copied at indexing time go stale. Changing the chunker or the embedding model changes every vector, so rebuild the whole index beside the old one, evaluate both on the same eval set, and switch when the new one matches or beats the old ([vector search](/learn/vector-search#changing-the-embedding-model) explains why).

## Evaluating retrieval and answers

Measure retrieval and answers separately. If the right chunk never reaches the prompt, no prompt change can fix the answer.

Build the eval set first. For Halden, assume 200 real agent questions, each with labeled relevant chunks and a reference answer, plus questions the handbook can't answer ([building an eval set](/learn/ai-evals-and-observability#building-an-eval-set)).

### Retrieval metrics

Recall@k is the share of relevant chunks that appear in the top k results, averaged over questions. It matches a prompt with k chunks: did the evidence reach the model? Mean reciprocal rank (MRR) averages, over questions, 1 divided by the rank of the first relevant result, or 0 if none is returned. NIST's TREC-8 definition uses the same formula. Recall@k rewards finding everything within k, and MRR rewards putting the best result first.

The sketch computes both on four toy queries. Each has a ranked list from the retriever and a set of chunks labeled relevant.

```python
def recall_at_k(ranked: list[str], relevant: set[str], k: int) -> float:
    """Share of the relevant chunks that appear in the top k results."""
    return len(set(ranked[:k]) & relevant) / len(relevant)


def reciprocal_rank(ranked: list[str], relevant: set[str]) -> float:
    """1 divided by the rank of the first relevant result, or 0 if none is ranked."""
    for rank, item in enumerate(ranked, start=1):
        if item in relevant:
            return 1 / rank
    return 0.0


# (chunk IDs in the retriever's ranked order, chunk IDs labeled relevant)
runs = [
    (["c07", "c12", "c03", "c44", "c09"], {"c12"}),
    (["c13", "c02", "c14", "c20", "c31"], {"c13", "c14"}),
    (["c50", "c51", "c52", "c53", "c54", "c88"], {"c88"}),
    (["c61", "c72", "c60", "c73", "c74"], {"c60", "c61"}),
]

if __name__ == "__main__":
    for k in (1, 3, 5):
        mean = sum(recall_at_k(r, rel, k) for r, rel in runs) / len(runs)
        print(f"recall@{k} = {mean:.2f}")
    print(f"MRR = {sum(reciprocal_rank(r, rel) for r, rel in runs) / len(runs):.3f}")
    # Expected:
    # recall@1 = 0.25
    # recall@3 = 0.75
    # recall@5 = 0.75
    # MRR = 0.667
```

Recall@1 is 0.25, recall@3 and recall@5 are 0.75, and MRR is 0.667. The third query's relevant chunk sits at rank 6. Recall@5 counts it as a miss, but MRR still credits it with 1/6. With five chunks in the prompt, report recall@5.

### Answer metrics

Score each answer on correctness against the reference, on faithfulness, and on citation accuracy: does each [n] support its sentence? The RAGAS paper defines faithfulness as an answer whose "claims that are made in the answer can be inferred from the context." A language model usually checks the claims, so calibrate that judge against human labels ([ways to grade](/learn/ai-evals-and-observability#ways-to-grade)). Track abstention too.

## How RAG fails

Most failures look the same from outside: a wrong answer. The table gives the first check for each symptom.

| Symptom | Likely cause | First check |
|---|---|---|
| "The handbook has no such policy" | Never ingested, dropped by the parser, or missed by retrieval | Search the chunk store for a phrase from the policy; check recall@5 on the question |
| Right chunk retrieved, answer ignores it | Lost in the middle, or too many chunks | Chunk position; faithfulness by position |
| Answer quotes an old policy | Old and new versions both indexed, or a delete never applied | Version of each cited chunk; delete events and queue lag |
| Sales user sees an HR-only paragraph | Filter missing from one search path, applied after the prompt, or a shared cache | Run the query as a user with no access, through each path |
| Answer follows an instruction found in an article | Indirect prompt injection | Which chunk carried the instruction |
| Citation [4] when only three sources were sent | Citation mapping bug | Validate citation numbers against the sources sent |
| Confident answer to an uncovered question | No abstention rule; no unanswerable questions in the eval set | Abstention rate on unanswerable questions |

Missing documents are the quietest failure, since a dropped table or skipped folder yields a confident "not in the handbook." Search the chunk store before blaming retrieval. Conflicting sources are a version problem: put version dates in the prompt and tell the model to prefer the newest. Check which chunk carried any injected instruction ([AI security](/learn/ai-security#prompt-injection)).

## Beyond basic RAG

### Agentic retrieval

Basic RAG searches once. An agent decides what to search for, reads the results and searches again when it needs to. That helps when one search finds half an answer, such as a customer's plan followed by that plan's refund window. Each search is a tool call with its own tokens and latency, so the loop needs a stop rule and a budget ([AI agents](/learn/ai-agents#tool-calling)).

### Graph-based retrieval

Top-k retrieval fails on whole-corpus questions such as "What are the main complaint themes this quarter?" No single chunk holds that answer. GraphRAG, by Edge and colleagues, "uses an LLM to build a graph index in two stages." It derives an entity knowledge graph from the source documents, then writes community summaries for groups of related entities. The authors state that RAG "fails on global questions directed at an entire text corpus." Indexing calls a language model over the whole corpus, which costs more than embedding the same text. Use graph retrieval for corpus-wide questions only.

## Check yourself

<details>
<summary>Halden adds 2,000 articles of 1,000 words each. Chunks are 300 words, and each starts 250 words after the last. How many chunks are there, and how much memory do 1,024-dimension float32 vectors take?</summary>

1,000 ÷ 250 = 4 chunks per article, so 8,000 chunks. Each vector takes 1,024 × 4 = 4,096 bytes, so 8,000 vectors take 32,768,000 bytes, about 32.8 MB.

</details>

<details>
<summary>Halden's refund policy changes weekly, and every answer must cite its paragraph. Should the team fine-tune a model on the handbook, use RAG, or paste the whole handbook into a long context window?</summary>

RAG. Fine-tuning would need retraining for each change, and it stores no source to cite. Ovadia and colleagues found that RAG outperformed fine-tuning for new knowledge. Long context pays for every token on every request, so it suits only small, stable corpora.

</details>

<details>
<summary>Recall@5 is 0.9, but faithfulness is low, and the assistant misses facts its sources contain. The prompt holds 20 chunks, and the relevant one is usually in the middle. What do you change first?</summary>

Cut the chunk count, and move the best chunks to the start. Retrieval is working, since the evidence arrives. Liu and colleagues found that accuracy drops when relevant information sits in the middle of a long input. Measure faithfulness by chunk position to confirm it on your data.

</details>

<details>
<summary>A sales agent sees a sentence from the HR-only compensation guide. Vector search applies the permission filter, but keyword search doesn't. What is the fix, and how do you prove it?</summary>

Apply the same filter in both searches, ideally through one shared query builder, and key caches by permission groups. Prove it with a test that runs a user with no HR group through every search path and expects zero compensation-guide chunks.

</details>

<details>
<summary>Three questions have their first correct chunk at rank 1, at rank 4, and nowhere in the top 10. What is MRR, and which query should you investigate first?</summary>

MRR = (1 + 1/4 + 0) ÷ 3 ≈ 0.417. Investigate the third query. Reranking can't help when nothing relevant was retrieved, so check whether the chunk is indexed and whether the query rewrite dropped a key term.

</details>

<details>
<summary>An "Exception" paragraph sits two paragraphs below the rule it modifies, and retrieval returns the exception alone. Name two indexing fixes and one query-time fix.</summary>

At indexing time, keep whole sections together up to a size limit, and prepend the heading path or a contextual description to each chunk before embedding. At query time, fetch the neighbors of each hit, so the rule travels with the exception.

</details>

## Further reading

- [Lewis et al., "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks" (arXiv 2005.11401)](https://arxiv.org/abs/2005.11401): the paper that introduced RAG.
- [Liu et al., "Lost in the Middle" (arXiv 2307.03172)](https://arxiv.org/abs/2307.03172): the position effect behind the prompt-ordering advice.
- [Anthropic, "Introducing Contextual Retrieval"](https://www.anthropic.com/news/contextual-retrieval): contextual chunks, contextual BM25 and reranking, with failure rates after each step.
- [Nogueira and Cho, "Passage Re-ranking with BERT" (arXiv 1901.04085)](https://arxiv.org/abs/1901.04085): the cross-encoder re-ranker, with query and passage read as one input.
- [Cormack, Clarke and Büttcher, "Reciprocal Rank Fusion" (SIGIR 2009)](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf): the two-page paper with the RRF formula and the constant 60.
- [Edge et al., "From Local to Global: A Graph RAG Approach" (arXiv 2404.16130)](https://arxiv.org/abs/2404.16130): GraphRAG, for questions about a whole corpus.
- [Ovadia et al., "Fine-Tuning or Retrieval?" (arXiv 2312.05934)](https://arxiv.org/abs/2312.05934): the comparison behind the fine-tuning advice.
- [Es et al., "Ragas" (arXiv 2309.15217)](https://arxiv.org/abs/2309.15217): the faithfulness definition used in the evaluation section.
- [OWASP, "LLM08:2025 Vector and Embedding Weaknesses"](https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/): permission-aware retrieval and cross-group leaks.
- [Greshake et al., "Not what you've signed up for" (arXiv 2302.12173)](https://arxiv.org/abs/2302.12173): indirect prompt injection through retrieved data.
- [NIST, TREC-8 slides on reciprocal rank](https://trec.nist.gov/presentations/TREC8/removed/tsld051.htm): the MRR definition used here.
- [Llama 3 Herd of Models (arXiv 2407.21783)](https://arxiv.org/abs/2407.21783): Table 3 for the architecture numbers, and section 3.2 for the tokenizer's characters per token.
- [NVIDIA H100](https://www.nvidia.com/en-us/data-center/h100/): the 80 GB memory figure for the running example.
