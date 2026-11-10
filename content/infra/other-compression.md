# Pruning and distillation

Quantization keeps every weight and stores it in fewer bits. The two other ways to make a model cheaper remove work instead. Pruning sets weights to zero, either anywhere or in a pattern the hardware can skip. Distillation trains a smaller model to imitate a larger one. Both are older than LLM quantization and both appear in interviews, but in serving practice they play a smaller role, for reasons this short chapter explains with measurements: a small model pruned on a Mac, and 2:4 sparse matmuls timed on an H100 and an L4.

Before this chapter, read [Post-training quantization algorithms](/learn/ptq-algorithms); the pruning methods here use the same calibration statistics.

## Unstructured and structured pruning

Unstructured pruning removes individual weights wherever they matter least, so it loses the least accuracy for a given sparsity, but the zeros are scattered, and a GPU's dense tensor cores multiply them anyway. Storing a scattered sparse matrix in the common formats needs an index per nonzero, so at 50% sparsity it saves no memory, and common GPU libraries gain no time from it. Structured pruning removes whole units: attention heads, MLP neurons, entire layers. The result is a smaller dense model that runs faster on any hardware, but removing whole units hurts more, and the model usually needs further training to recover.

Semi-structured sparsity sits between the two. NVIDIA's Ampere and later GPUs have sparse tensor cores that accept a weight matrix in which every group of four consecutive values holds at least two zeros, the 2:4 pattern. The matrix is stored as its nonzero half plus a 2-bit index for each kept value, and NVIDIA states that the sparse tensor cores deliver twice the math throughput of dense ones; its paper measured nearly 2 times the speed on large matrix multiplications. The pattern is fixed at 50% sparsity, and since every group of four must lose two values, even a group of four important weights loses two.

## Choosing what to prune

Magnitude pruning, the classic method, removes the weights with the smallest absolute values. It ignores the inputs, which chapters 4.2 and 4.3 showed matter: a small weight on a channel with large activations can contribute more to the output than a large weight on a quiet channel. Two methods from 2023 fixed this for LLMs without retraining. SparseGPT, by Frantar and Alistarh, two of the GPTQ authors, uses the same Hessian-based error compensation as GPTQ: it removes weights and updates the remaining ones to preserve the layer's output, and it pruned OPT-175B and BLOOM-176B to 60% unstructured sparsity in under 4.5 hours with a negligible rise in perplexity. Wanda, by Sun and others, is simpler still: it scores each weight by its magnitude times the norm of its input channel over calibration data, |W_ij| × ||X_j||, removes the lowest-scoring weights in each output row, and updates nothing.

```widget
sparsity-pattern
```

With magnitude scoring, notice how many weights on the three loud input channels are removed, and the output error that causes. Switch to Wanda's score: those weights survive and the error falls, without changing any kept weight. Then switch between the free pattern and 2:4 to see what the hardware's constraint costs.

## Measured: half the weights of a small model

The lab pruned every linear layer of SmolLM2-135M to 50% sparsity, scoring weights by magnitude and by Wanda's score with input norms from 16,384 calibration tokens, and measured WikiText-2 perplexity, which is 17.10 for the dense model:

| Pruning, 50% sparsity | Perplexity | Change |
|---|---|---|
| Magnitude, unstructured | 466.0 | +2,625% |
| Wanda, unstructured | 36.3 | +112% |
| Magnitude, 2:4 | 1,477.2 | +8,537% |
| Wanda, 2:4 | 104.6 | +512% |
| For comparison: INT4 group 128, GPTQ with act-order (chapter 4.3) | 20.1 | +17% |

Using the activations makes the difference between a broken model and a damaged one: Wanda's score cut the perplexity by a factor of 13 to 14 over magnitude pruning, in both patterns. The 2:4 constraint costs a further factor of about 3. And no pruning result comes near INT4 quantization, which stores about 4.2 bits per weight against 2:4 sparse BF16's 9 bits. Small models suffer more from pruning, as from quantization; the Wanda paper reports much smaller losses for 7B to 65B models at 50% unstructured sparsity, but the order is the same.

Speed is the other half of the case for 2:4, and the lab timed a 2:4 sparse weight matrix of the Llama 3 70B MLP shape, 8,192 by 28,672, against the same matrix multiplied densely in BF16:

| Rows of activations | 16 | 64 | 256 | 1,024 | 4,096 | 8,192 |
|---|---|---|---|---|---|---|
| H100, cuSPARSELt | 0.31× | 0.35× | 0.54× | 0.61× | 0.74× | 0.76× |
| L4, cuSPARSELt | 1.59× | 1.69× | 0.64× | 0.48× | 0.44× | 0.43× |
| L4, CUTLASS | 1.63× | 1.72× | 1.18× | 0.87× | 0.81× | 0.79× |

On the H100, PyTorch's 2:4 path was slower than the dense matmul at every size, and its CUTLASS path supports only compute capability 8.x. On the L4 it helped only at small batches, where the matmul is memory-bound and the sparse matrix is 252 MiB against 448: the gain came from reading fewer bytes, not from the sparse tensor cores' arithmetic, and at large batches it lost. The hardware's 2 times is real for well-tuned kernels at suitable shapes, as NVIDIA's measurements show, but a general library may not deliver it.

## Distillation

Knowledge distillation, named by Hinton, Vinyals and Dean in 2015, trains a smaller student model to match a larger teacher's output distributions rather than only the correct next token. The teacher's probabilities carry more information per example than a single label: they say which wrong answers are nearly right. DistilBERT, an early example, was 40% smaller than BERT, ran 60% faster, and kept 97% of its language understanding.

For LLMs, distillation is now combined with structured pruning. NVIDIA's Minitron work pruned the 15B Nemotron-4 model's attention heads, MLP neurons and embedding channels to make 8B and 4B models, then retrained them by distillation from the original, using up to 40 times fewer training tokens than training those sizes from scratch. Meta made Llama 3.2 1B and 3B by structured pruning of Llama 3.1 8B, then used the logits of Llama 3.1 8B and 70B as targets during their pre-training. The result of distillation is an ordinary dense model, so it runs on every engine and every GPU, and it can be quantized afterwards like any other.

The cost is training. Pruning and distillation of this kind takes tens of billions to trillions of tokens on a GPU cluster, so it is done by model producers, not by a serving team. A serving team's version of the choice is simpler: use the smaller distilled model if one exists and is good enough, and quantize it.

## When each is worth it

Quantization is the default because it is cheap and reliable: post-training methods run in minutes to an hour on one GPU, every serving engine supports the common formats, and at 8 bits the quality loss is usually negligible. Pruning to 2:4 needs its own kernels, gives at most a 2 times speedup on the matrix multiplications and, as the lab shows, often less in practice, and it costs more quality than INT4 quantization at a similar memory saving unless the model is retrained. Unstructured sparsity saves little or nothing on GPUs with common libraries at the levels that keep quality; research kernels gain only at much higher sparsity. Distillation gives the largest, most portable savings, a genuinely smaller model, but at the price of a training run. In practice, a serving team chooses among the distilled sizes model producers publish, then quantizes the one it picks.

## Lab: prune a model, then time sparse matmuls

**Tier: [Mac] then [1 GPU].** Part A runs on a CPU in about seven minutes and needs the lab files from chapters 4.2 and 4.3 in the same folder. Part B needs an NVIDIA GPU of compute capability 8.0 or later.

Download [pruning.py](/labs/infra/pruning.py) and [gpu/sparse_matmul.py](/labs/infra/gpu/sparse_matmul.py). Run the first with `python pruning.py`, and the second from the `gpu/` folder:

```bash
modal run modal_run.py --script sparse_matmul.py --gpu 'H100!'  # about 10 s of GPU time, under $0.01
python gcp_run.py --script sparse_matmul.py --gpu L4            # a Spot VM; about $0.12 with the image build
```

**Part A, pruning.** Prune every linear layer of SmolLM2-135M to 50% sparsity by magnitude and by Wanda's score, unstructured and 2:4, and compare the perplexities with each other and with chapter 4.3's INT4 results.

**Part B, sparse matmuls.** Convert a pruned 2:4 weight matrix with `torch.sparse.to_sparse_semi_structured` and time it against the dense matmul at decode and prefill shapes. Explain why the speedup is below 2 times, or why there is none.

<details>
<summary>Reference solution</summary>

`pruning.py` on an Apple M2 MacBook with 8 GB of memory:

```text
PyTorch 2.15.0, Transformers 5.22.2

WikiText-2 test perplexity, every linear layer pruned to 50% sparsity (106.2M weights)
   method                          perplexity   change
   dense                                17.10
   magnitude, unstructured             466.04   +2625%
   Wanda, unstructured                  36.28    +112%
   magnitude, 2:4                     1477.17   +8537%
   Wanda, 2:4                          104.63    +512%

   For comparison, chapter 4.3: INT4 group 128 with GPTQ (act-order) 20.09 (+17%), with RTN 23.01 (+35%).
   2:4 sparse BF16 stores 9 bits per original weight (two 16-bit values and two 2-bit indices per four);
   INT4 with group-128 scales stores about 4.2.
```

*Part A.* Wanda's activation-aware score is what keeps a pruned model working: magnitude pruning removes small weights on channels with large inputs, and those weights carry much of the output. The 2:4 pattern costs more than unstructured pruning at the same sparsity, because it must remove two weights from every group of four, including groups whose four weights all matter. Even the best pruned version is far worse than INT4 quantization while storing more than twice the bits.

`sparse_matmul.py` on Modal's H100 and on a Google Cloud Spot L4 (g2-standard-8):

```text
NVIDIA H100 80GB HBM3, PyTorch 2.15.0+cu132, CUDA 13.2

cusparselt: dense BF16 weights 448 MiB; 2:4 values + indices 252 MiB
        M      dense  2:4 sparse  speedup  max diff
       16    155.2us     497.2us    0.31x   2.5e-03
       64    163.2us     467.0us    0.35x   4.7e-03
      256    184.9us     340.8us    0.54x   4.3e-03
     1024    582.9us     955.3us    0.61x   4.3e-03
     4096   2712.6us    3672.8us    0.74x   4.0e-03
     8192   5618.7us    7355.0us    0.76x   4.0e-03

cutlass: (not supported: "Supported only on GPUs with compute capability 8.x")

NVIDIA L4, PyTorch 2.15.0+cu132, CUDA 13.2

cusparselt: dense BF16 weights 448 MiB; 2:4 values + indices 252 MiB
        M      dense  2:4 sparse  speedup  max diff
       16   1894.6us    1192.9us    1.59x   4.2e-03
       64   2073.1us    1225.4us    1.69x   2.3e-03
      256   3028.6us    4763.2us    0.64x   4.3e-03
     1024   9104.2us   18818.0us    0.48x   4.3e-03
     4096  32938.5us   75134.7us    0.44x   4.1e-03
     8192  65357.0us  150273.2us    0.43x   4.1e-03

cutlass: dense BF16 weights 448 MiB; 2:4 values + indices 252 MiB
        M      dense  2:4 sparse  speedup  max diff
       16   1897.6us    1164.7us    1.63x   2.5e-03
       64   2108.0us    1222.6us    1.72x   4.8e-03
      256   3236.1us    2749.8us    1.18x   4.5e-03
     1024   9255.3us   10609.3us    0.87x   3.9e-03
     4096  34343.0us   42581.6us    0.81x   4.0e-03
     8192  68144.6us   86761.9us    0.79x   3.8e-03
```

*Part B.* The sparse matmul is correct (its result matches the dense product of the same pruned matrix to BF16 precision), but the speedup depends on the regime. At 16 to 64 rows on the L4, the matmul is memory-bound and the sparse matrix has 56% of the dense one's bytes, which allows at most 1.8 times; the lab measured 1.6 to 1.7 times, so the gain is bandwidth. At large batches the matmul is compute-bound, where the sparse tensor cores could double the arithmetic rate, but the sparse kernels PyTorch reaches through cuSPARSELt and CUTLASS ran below the dense cuBLAS kernels on both GPUs. On the H100, whose dense kernels are the most heavily tuned, the sparse path lost everywhere. A 2:4 speedup has to be measured on the target GPU, library version and shapes; it cannot be assumed from the datasheet.

</details>

## Interview angle

- **"What is 2:4 sparsity?"** A pattern in which every group of four consecutive weights has at least two zeros, which NVIDIA's sparse tensor cores (Ampere and later) can skip, storing half the values plus 2-bit indices. It promises up to twice the matmul throughput, but only for that exact pattern at 50% sparsity, and it costs more accuracy than unstructured pruning.
- **"How does Wanda decide what to prune?"** It scores each weight by its magnitude times the L2 norm of its input channel's activations over calibration data and removes the lowest-scoring weights in each output row, with no weight update. Including the activations protects weights on channels with large inputs, which magnitude pruning ignores.
- **"Why is quantization used far more than pruning for LLM serving?"** It is cheaper to apply, needs no retraining, has broad kernel support in every engine, and halves or quarters memory and bandwidth at small quality cost. Unstructured sparsity gives little or no GPU speedup with common libraries at the levels that keep quality, 2:4 sparsity needs special kernels and gives less than 2 times in practice, and recovering quality after pruning usually needs training.
- **"What is distillation, and who does it?"** Training a small student model to match a large teacher's output distributions. It produces a dense smaller model that runs anywhere, and model producers combine it with structured pruning, as in NVIDIA's Minitron models and Meta's Llama 3.2 1B and 3B; a serving team usually consumes distilled models rather than making them.

## Check yourself

<details>
<summary>Why does 50% unstructured sparsity not save memory in a typical sparse format?</summary>

Each kept value needs an index saying where it is. With 16-bit values and 16- or 32-bit column indices, a matrix with half its values kept takes as much memory as the dense one or more. Only the 2:4 pattern, whose position within a group of four fits in 2 bits, stores compactly: about 9 bits per original weight in BF16.

</details>

<details>
<summary>A 2:4 sparse matmul does half the multiplications. Why can it be slower than the dense one?</summary>

At small batch sizes the matmul is memory-bound, and the sparse matrix is still about 56% of the dense one's bytes, so at best it saves a little bandwidth, while its kernel must also read and decode the index metadata. At large batch sizes it is compute-bound, where the sparse tensor cores can help, but only if the library has a well-tuned sparse kernel for that GPU and shape; otherwise the dense library's highly tuned kernels win.

</details>

<details>
<summary>What do pruning a model and quantizing it to INT4 each do to its memory, at 50% sparsity in BF16 and with group-128 INT4?</summary>

2:4 sparsity in BF16 stores about 9 bits per original weight, a 44% saving over BF16's 16. INT4 with group-128 FP16 scales stores about 4.1 to 4.2 bits per weight, a 74% saving, and in the labs it lost less quality.

</details>

## Further reading

- [Accelerating Sparse Deep Neural Networks](https://arxiv.org/abs/2104.08378), by Mishra and others at NVIDIA, describes 2:4 sparsity and the sparse tensor cores.
- [SparseGPT: Massive Language Models Can Be Accurately Pruned in One-Shot](https://arxiv.org/abs/2301.00774) and [A Simple and Effective Pruning Approach for Large Language Models](https://arxiv.org/abs/2306.11695) (Wanda).
- [Distilling the Knowledge in a Neural Network](https://arxiv.org/abs/1503.02531), by Hinton, Vinyals and Dean, and [DistilBERT](https://arxiv.org/abs/1910.01108).
- [Compact Language Models via Pruning and Knowledge Distillation](https://arxiv.org/abs/2407.14679), NVIDIA's Minitron paper.
- Meta's [Llama 3.2 announcement](https://ai.meta.com/blog/llama-3-2-connect-2024-vision-edge-mobile-devices/) describes how the 1B and 3B models were pruned and distilled.
- PyTorch's [semi-structured sparsity tutorial](https://docs.pytorch.org/tutorials/advanced/semi_structured_sparse.html) shows `to_sparse_semi_structured` on a BERT model.
