<!-- Flashcards for Parts 0 and 1 of the AI Infrastructure Engineer Handbook: the role, models and machines, the transformer as a workload, the arithmetic of inference, and mixture-of-experts models. -->

<!-- chapter: inference-engineer-role -->

## Name the layers a completion request passes through, from the router to memory, and what each one does.
<!-- /learn/inference-engineer-role#what-an-inference-engineer-does -->

The **router** chooses a replica, often by load or by which replica already holds the prompt's prefix in its cache. The **engine scheduler** decides every step which requests run, how many prompt tokens to process and where each request's KV cache lives. The **model runner** turns the batch into GPU work through PyTorch modules, compiled graphs and CUDA graphs. The **kernels** do the arithmetic, and matmuls and attention take nearly all the time. **GPU memory** holds the weights and the KV cache, and reading it limits most decode steps.

## How does an inference engineer's job differ from a kernel engineer's and a platform engineer's?
<!-- /learn/inference-engineer-role#where-the-role-sits -->

The inference engineer owns the serving engine, the model runtime, and latency and cost per token. A kernel engineer owns individual GPU kernels, and a platform engineer owns clusters, deployment and observability. The inference engineer sits between them and needs enough kernel knowledge to spot a slow kernel and write a simple one, and enough platform knowledge to run the engine as a service.

## What five kinds of interview round do inference roles use, and which ones do the handbook's labs prepare for?
<!-- /learn/inference-engineer-role#how-interviews-test-it -->

The rounds are **coding** (often inference-flavoured, such as attention with a KV cache or a top-p sampler), an **ML systems deep dive** with live estimates, **system design**, a **past-project deep dive**, and sometimes a **take-home**. The labs produce material for coding, the deep dive and the past-project round: code you wrote, numbers you measured and write-ups you can talk through.

<!-- chapter: models-and-machines -->

## Llama 3.1 8B stores 8.03B parameters but uses 7.50B in matmuls per token. Where does the difference go, and which number sets which resource?
<!-- /learn/models-and-machines#counting-parameters -->

The difference is the **input embedding**, 525.3M parameters, which is a table lookup that copies one row per token rather than a multiply. The stored count, 8.03B, sets the **memory** the weights need. The matmul count, 7.50B, sets the **compute**: about 2 × 7.50B = 15.0 GFLOP per token, before attention scores.

## Give the formula for KV cache bytes per token, and work it out for Llama 3.1 8B in BF16.
<!-- /learn/models-and-machines#kv-cache-per-token -->

KV bytes per token = 2 (keys and values) × layers × KV heads × head dimension × bytes per value. For Llama 3.1 8B that is 2 × 32 × 8 × 128 × 2 = **131,072 bytes**, so one 8K-token sequence takes about 1.07 GB.

## Why does Qwen3-30B-A3B need less KV cache per token than Llama 3.1 8B, although it is almost four times larger on disk?
<!-- /learn/models-and-machines#kv-cache-per-token -->

The cache depends on the attention layout, not the parameter count. Qwen3-30B-A3B has 48 layers but only **4 KV heads** of 128, so it keeps 2 × 48 × 4 × 128 × 2 = 98,304 bytes per token. Llama 3.1 8B has 32 layers with 8 KV heads and keeps 131,072.

## What is a GPU's ridge point, and what are the values for the H100, the L4 and the M2 used in the handbook?
<!-- /learn/models-and-machines#the-three-machines -->

The ridge point is peak FLOPs divided by memory bandwidth: the arithmetic intensity at which an operation stops being limited by memory. It is about **295** FLOPs per byte for the H100 SXM (989 TFLOPS dense BF16, 3.35 TB/s), **403** for the L4 (121 TFLOPS, 300 GB/s) and about **30** for the measured M2 (2.5 TFLOPS FP16, 84 GB/s measured).

## Why is a "4-bit" checkpoint usually larger than half a byte per parameter?
<!-- /learn/models-and-machines#weights-in-bytes -->

Real 4-bit formats store a scale for each small group of weights. One 16-bit scale per 128 weights adds 16 ÷ 128 = 0.125 bits per weight, and many tools keep the embeddings and the LM head in 16 bits.

<!-- chapter: transformer-as-workload -->

## List the operations in one Llama decoder layer, in order, and say which ones have weights.
<!-- /learn/transformer-as-workload#one-layer-as-a-list-of-operations -->

RMSNorm, the **QKV projection**, RoPE on queries and keys, attention over the KV cache, the **output projection** with a residual add, RMSNorm, the **gate and up projections**, SiLU of the gate times up, and the **down projection** with a residual add. Only the four matmuls have weights worth counting, 218M per layer in Llama 3.1 8B. Attention has no weights but reads the KV cache.

## What single number separates prefill from decode for a matmul, and what does it do to the work?
<!-- /learn/transformer-as-workload#prefill-and-decode-shapes -->

The number of tokens T in the step. In prefill T is the prompt length, so each matmul is a matrix-matrix multiply and every weight read is used T times. In decode T is the batch size, so at batch 1 each matmul is a vector times a matrix and every weight is used once. That one number moves the work from one end of the roofline to the other.

## How many FLOPs does attention add per token at context c for Llama 3.1 8B, and at what context does it equal the matmuls?
<!-- /learn/transformer-as-workload#where-the-flops-go -->

Attention costs 4 × layers × query heads × head dimension × c = 4 × 32 × 32 × 128 × c = **524,288 × c** FLOPs per token. That equals the matmuls' 15.0 GFLOP at c ≈ **28,600** tokens, so the 2 × parameters rule undercounts long contexts.

## Why is decode attention's arithmetic intensity in Llama 3.1 8B fixed at 4 FLOPs per byte, whatever the batch?
<!-- /learn/transformer-as-workload#where-the-bytes-go -->

Each sequence reads its own keys and values, so batching shares nothing. Each cached number, 2 bytes, is used by the 4 query heads that share its KV head, for 2 FLOPs each: 8 FLOPs per 2 bytes. The intensity equals query heads divided by KV heads, 32 ÷ 8 = 4.

## In a 2,000-token prefill of Llama 3.1 8B, the norms, RoPE and SiLU do 0.03% of the FLOPs. Why do they take about 10% of the ideal time, and what is the fix?
<!-- /learn/transformer-as-workload#where-the-bytes-go -->

They are memory-bound at under 1 FLOP per byte, because each one reads and writes the whole activation while the matmuls next to them are compute-bound. Their time is set by bytes, not arithmetic. **Fusing** them into neighbouring kernels removes most of those reads and writes.

## Compare MHA, GQA, MQA and MLA on KV cache size and decode attention intensity, for the 8B shape.
<!-- /learn/transformer-as-workload#attention-variants -->

**MHA** keeps 32 KV heads: 524,288 bytes per token at 1 FLOP per byte. **GQA** with 8 heads keeps 131,072 bytes at 4. **MQA** keeps 1 head: 16,384 bytes at 32, but quality can drop. **MLA**, with DeepSeek's latent of 512 + 64 numbers per layer, keeps 36,864 bytes per token at about 60 FLOPs per byte, at the cost of extra projection matmuls.

## What does RoPE do, and what are its three consequences for serving?
<!-- /learn/transformer-as-workload#positions-and-rope -->

RoPE rotates each pair of a query's and key's dimensions by an angle proportional to the token's position, so their dot product depends on the distance between positions. Three consequences follow. The cache stores **already-rotated keys**. **Prefix caching** works only when the shared prefix sits at the same positions. **Long context is a RoPE setting**: Llama 3.1 uses `rope_scaling` of type llama3 with factor 8, and the engine must apply it too.

<!-- chapter: inference-arithmetic -->

## State the step-time model, and why it sums per-part rooflines instead of using one roofline for the whole step.
<!-- /learn/inference-arithmetic#the-step-time-model -->

Step time ≈ the sum over operations of max(FLOPs ÷ peak, bytes ÷ bandwidth). Different parts sit on different sides of the ridge point: at large batch the weight matmuls can be compute-bound while attention, at 4 FLOPs per byte, stays memory-bound. One roofline on the totals would average them and predict a shorter step than either part allows.

## What is the ideal decode step time and single-user speed for Llama 3.1 8B in BF16 on one H100?
<!-- /learn/inference-arithmetic#a-decode-step-part-by-part -->

The step reads about 15.0 GB of matmul weights at 3.35 TB/s, about **4.56 ms** including a little KV cache at a 2,000-token context. That gives about **219 tokens a second**, a ceiling no engine can beat at this precision. The GPU's arithmetic is idle over 99% of the time.

## For Llama 3.1 8B on an H100 with 2,000-token contexts, what caps the batch: compute or memory?
<!-- /learn/inference-arithmetic#a-decode-step-part-by-part -->

Memory. The weight matmuls would become compute-bound at batch 295, the ridge point, but after the 16 GB of weights and a 10% reserve, about 56 GB of cache holds only **213** sequences of 2,000 tokens. At 32,000-token contexts only 13 fit. More throughput comes from fewer bytes, such as FP8 weights or an FP8 KV cache, not from more FLOPS.

## How does a latency target turn into a maximum batch size? Use a 50 tokens-a-second target for Llama 3.1 8B on an H100.
<!-- /learn/inference-arithmetic#latency-against-throughput -->

Inter-token latency equals the step time, so 50 tokens a second means a step of at most 20 ms. With 2,000-token contexts, the step reaches 20 ms at about **batch 200**: 4.5 ms of weights plus 200 × 2,000 × 131,072 bytes ÷ 3.35 TB/s ≈ 15.6 ms of cache. A serving benchmark must therefore report throughput at a stated latency, never alone.

## Why does a 32,000-token prompt take about 49 times as long to prefill as a 1,000-token prompt, and how does it hurt other users?
<!-- /learn/inference-arithmetic#prefill-and-time-to-first-token -->

The extra beyond 32 times comes from attention, whose score matrix grows with the square of the prompt. While a GPU runs the 1.5 s prefill in one piece, the sequences in its decode batch get no tokens. **Chunked prefill** splits the prompt and interleaves the pieces with decode steps.

## Why do output tokens cost about four times as much as input tokens on the same GPU?
<!-- /learn/inference-arithmetic#cost-per-input-and-output-token -->

A prefill reads the weights once for thousands of prompt tokens and is compute-bound. A decode step reads them once for only one token per sequence in the batch and is memory-bound. At $3 per H100-hour and full utilization, the model gives about $0.03 per million input tokens and $0.12 per million output tokens.

## Define MBU and MFU, and say which phase each one suits.
<!-- /learn/inference-arithmetic#efficiency-mbu-and-mfu -->

**MBU**, model bandwidth utilization, is achieved bytes per second divided by peak bandwidth, counting weight bytes and KV cache bytes read per step. It suits **decode**. **MFU**, model FLOPs utilization, is achieved FLOPs per second divided by peak, counting only the FLOPs the model needs. It suits compute-bound work such as **prefill** and training.

## Name four reasons a measured decode step is slower than the roofline model.
<!-- /learn/inference-arithmetic#why-real-numbers-fall-short -->

Achievable bandwidth is below the spec sheet, and the M2 copy reached 84% of it. **Overhead between kernels**, such as launches and the Python scheduler, can rival GPU time at batch 1. Kernels are less efficient on **awkward shapes** such as matmuls with 1 to 16 rows. The model **leaves out work** such as sampling, the large LM head output and streaming, and real batches mix prefill and decode.

<!-- chapter: mixture-of-experts -->

## Walk through what one MoE layer does for one token.
<!-- /learn/mixture-of-experts#what-an-moe-layer-does -->

The router, a d × E matrix, gives each expert a score. The top k scores pick the token's experts, and a softmax over those k scores gives their weights, which sum to 1. Each chosen expert runs its MLP on the token, and the layer adds the outputs, each multiplied by its weight, and passes the sum to the residual connection. Attention is unchanged.

## What are fine-grained experts and shared experts, and which of them does Qwen3-30B-A3B use?
<!-- /learn/mixture-of-experts#total-and-active-parameters -->

**Fine-grained experts** are many narrow experts with more of them chosen per token, which gives the router more combinations. **Shared experts** run for every token so that routed experts can specialise. Both come from DeepSeekMoE. Qwen3-30B-A3B uses fine-grained experts, 8 of 128 that are each 768 wide, and the Qwen3 report says it has **no shared experts**. DeepSeek-V3 has one shared expert and 256 routed ones.

## Give the expected number of experts a layer reads for a decode batch of B tokens, and its value for Qwen3-30B-A3B at B = 1, 4, 16 and 64.
<!-- /learn/mixture-of-experts#which-experts-a-decode-step-reads -->

With even routing, experts read per layer = E × (1 − (1 − k/E)^B). For E = 128 and k = 8, that is **8** at B = 1, about **29** at 4, about **82** at 16 and nearly all **128** at 64. The bytes per decode step therefore grow with the batch, unlike in a dense model.

## On one H100, when is Qwen3-30B-A3B faster than Llama 3.1 8B in decode, and when is it slower?
<!-- /learn/mixture-of-experts#which-experts-a-decode-step-reads -->

At batch 1 it reads 6.1 GB per step against 15.0 GB, so it is about 2.4 times faster: 1.87 ms against 4.56 ms. The two are about even at batch 4. From batch 8 on the MoE model reads more bytes per step, up to 60 GB once every expert is read, so it is slower until attention dominates both at very large batches.

## Why does an MoE model need far larger batches than a dense model to become compute-bound?
<!-- /learn/mixture-of-experts#which-experts-a-decode-step-reads -->

Each expert serves on average only B × k ÷ E tokens, and a BF16 expert matmul does about as many FLOPs per byte as it has tokens. For Qwen3-30B-A3B that is B ÷ 16, so its weight matmuls reach an H100's ridge point at about 2,900 sequences against about 295 for Llama 3.1 8B. DeepSeek-V3 reports that each expert usually sees at most 256 tokens in decode, which is why it spreads experts over 320 GPUs.

## What did measuring Granite 3.1 1B-A400M's router show about real routing?
<!-- /learn/mixture-of-experts#routing-in-practice -->

The load is very uneven: the busiest expert got 3.0 times the even share in the average layer, and in the worst layer every token chose the same expert, the ceiling of 4.00 for top-8 of 32. Prose and code were routed only 14% differently. A batch touched fewer experts than the even formula predicts, 18.4 instead of 21.9 at four tokens.

## Name three ways MoE models are trained or served to keep the expert load balanced.
<!-- /learn/mixture-of-experts#routing-in-practice -->

An **auxiliary loss**, α × N × the sum of f_i × P_i in the Switch Transformer with α = 0.01, penalises uneven routing during training. DeepSeek-V3's **bias-based balancing** adds a per-expert bias, used only for choosing experts, that is lowered for overloaded experts after each step. At serving time, **redundant experts** copy the most loaded experts onto extra GPUs, as in DeepSeek-V3's deployment and vLLM's `--enable-eplb`.

## What is an expert capacity factor, and why do serving engines avoid dropping tokens?
<!-- /learn/mixture-of-experts#capacity-and-dropped-tokens -->

The Switch Transformer caps each expert at (tokens ÷ experts) × capacity factor, and a token that reaches a full expert skips it through the residual connection. Dropping changes the output: Granite's router would lose 23% of its token-expert pairs at a factor of 1.25. DeepSeek-V3 drops no tokens in training or inference, and vLLM computes every routed token, so imbalance costs time instead.

## How do serving engines run an MoE layer efficiently on one GPU?
<!-- /learn/mixture-of-experts#how-engines-run-an-moe-layer -->

They sort the (token, expert) pairs by expert so that each expert's tokens are contiguous, run all the experts' matmuls in one **grouped matmul** kernel, then restore token order and add each token's k results. In vLLM, `moe_align_block_size` does the sorting and padding, and the Triton kernel `fused_moe_kernel` runs the grouped matmul. Across GPUs, all-to-all dispatch and combine steps surround the kernel.
