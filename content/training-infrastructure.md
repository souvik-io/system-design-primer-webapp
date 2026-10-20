# Training and fine-tuning infrastructure

Serving handles requests as they arrive. Training is a batch job that runs for weeks, spreads across thousands of GPUs and has to survive hardware failures. The Llama 3 paper's flagship model has 405 billion trainable parameters, trained on 15.6 trillion tokens with 3.8 × 10^25 floating-point operations (FLOPs) on up to 16K H100 GPUs (arXiv 2407.21783). A FLOP is one floating-point addition or multiplication. A token is one piece of text, as [how LLM inference works](/learn/llm-inference#tokens) explains.

Many teams fine-tune someone else's model instead. The questions are the same at every size: how much memory each GPU must hold, how much compute the job needs, how the work is split, what happens when a GPU fails, and where the data comes from.

The examples use the running example's Llama 3.1 8B and 70B models on 80 GB H100 GPUs. Two estimates are worked in full: the memory to train a 70B model with Adam, and the compute to train an 8B model on 15 trillion tokens. Hardware is covered in [GPUs and accelerators](/learn/gpus-for-ai), and serving in [inference engines](/learn/inference-engines) and [inference fleets](/learn/inference-fleets).

## Training compared with inference

An inference step reads the weights and never changes them. For the 70B model in BF16 (16-bit floating point), a decode step at batch size one reads all 140 GB of weights.

A training step runs a forward pass to measure the loss, a backward pass to compute a gradient for every weight, and an optimizer step that changes every weight using those gradients. Training is also synchronous: every data-parallel GPU must finish a step before the group can start the next, so one slow or failed GPU holds back all the others. It stores state that inference never touches, one gradient per weight plus the optimizer's running averages.

### Compute per token

A forward pass costs about 2 FLOPs per parameter per token. The factor 2 comes from the multiply and the add in each matrix product (Kaplan et al., arXiv 2001.08361). The backward pass costs about twice that, so a training token costs about 6 FLOPs per parameter:

```text
training FLOPs ≈ 6 × parameters × tokens
```

For the 70B model, one training token costs 6 × 70 × 10^9 = 420 GFLOP.

### A worked estimate: 8B on 15 trillion tokens

The Llama 3 model card says the pre-training data was "over 15 trillion tokens", so this estimate is a floor.

1. Total work: 6 × 8 × 10^9 × 15 × 10^12 = 7.2 × 10^23 FLOPs.
2. Peak speed: NVIDIA's H100 page lists 1,979 teraFLOPS for BF16 Tensor Cores, marked "with sparsity". Sparsity doubles throughput, so the dense figure is 989 teraFLOPS (NVIDIA's Hopper architecture post).
3. Utilization: assume 40 percent. The Llama 3 paper reports a model FLOPs utilization (MFU) of 38 to 43 percent for its 405B run. MFU is the share of peak arithmetic that goes to the model's own math. Each GPU delivers 0.40 × 989 × 10^12 = 3.956 × 10^14 FLOP/s.
4. Time: 7.2 × 10^23 ÷ 3.956 × 10^14 = 1.82 × 10^9 GPU-seconds, or 505,561 GPU-hours and 21,065 GPU-days. On 1,000 GPUs, that is about 21 days, if nothing fails.

The Llama 3 model card reports 1.3 million H100-80GB GPU-hours for 8B and 6.4 million for 70B. The 8B figure is 2.6 times the estimate, and the 70B figure is 1.45 times the 4.42 million estimate. The 405B case fits better. The paper's 3.8 × 10^25 FLOPs matches 6 × 405 × 10^9 × 15.6 × 10^12 = 3.79 × 10^25. The Llama 3.1 card's 30.84 million GPU-hours is 10 to 25 percent above the estimate at the paper's 38 to 43 percent MFU.

The gap grows as the model shrinks, and the sources don't explain it. A plausible cause is that a small model does less math per byte moved between GPUs, so its GPUs idle more. Restarts, checkpoints and data stalls add GPU-hours that the estimate leaves out, so treat 40 percent as optimistic. The 8B run also uses 1,875 tokens per parameter, about 94 times the ratio of 20 that Chinchilla found compute-optimal (arXiv 2203.15556).

At an assumed $3.00 per H100-hour (real prices vary by provider and commitment), the ideal run costs about $1.5 million, and the reported 1.3 million GPU-hours cost about $3.9 million.

The sketch reproduces the arithmetic.

```python
# Training compute: 6 x parameters x tokens, converted to H100 GPU-hours at a stated MFU.
PEAK_BF16 = 989e12  # H100 SXM dense BF16 FLOP/s (the spec's 1,979 TFLOPS is with sparsity)


def training_flops(params: float, tokens: float) -> float:
    return 6 * params * tokens


def gpu_hours(flops: float, mfu: float) -> float:
    return flops / (mfu * PEAK_BF16) / 3600


if __name__ == "__main__":
    flops_8b = training_flops(8e9, 15e12)
    hours_8b = gpu_hours(flops_8b, mfu=0.40)
    print(f"8B on 15T tokens: {flops_8b:.2e} FLOPs, {hours_8b:,.0f} GPU-hours, "
          f"{hours_8b / 24:,.0f} GPU-days")
    print(f"  Llama 3 model card (1.3M GPU-hours) = {1.3e6 / hours_8b:.2f} x this")
    hours_70b = gpu_hours(training_flops(70e9, 15e12), mfu=0.40)
    print(f"70B on 15T tokens: {hours_70b:,.0f} GPU-hours; "
          f"model card (6.4M) = {6.4e6 / hours_70b:.2f} x this")
    flops_405b = training_flops(405e9, 15.6e12)
    print(f"405B on 15.6T tokens: {flops_405b:.2e} FLOPs (paper: 3.8e25)")
    for mfu in (0.43, 0.38):
        print(f"  405B at MFU {mfu:.0%}: {gpu_hours(flops_405b, mfu) / 1e6:.2f}M GPU-hours")

# Output:
# 8B on 15T tokens: 7.20e+23 FLOPs, 505,561 GPU-hours, 21,065 GPU-days
#   Llama 3 model card (1.3M GPU-hours) = 2.57 x this
# 70B on 15T tokens: 4,423,660 GPU-hours; model card (6.4M) = 1.45 x this
# 405B on 15.6T tokens: 3.79e+25 FLOPs (paper: 3.8e25)
#   405B at MFU 43%: 24.76M GPU-hours
#   405B at MFU 38%: 28.02M GPU-hours
```

## Memory for training

Training here uses mixed precision with Adam, the setup behind the ZeRO paper's accounting (arXiv 1910.02054). The paper counts 16 bytes per parameter:

| What is stored | Precision | Bytes per parameter |
|---|---|---|
| Weights for the forward and backward passes | 16-bit | 2 |
| Gradients | 16-bit | 2 |
| Master copy of the weights | 32-bit | 4 |
| Adam momentum | 32-bit | 4 |
| Adam variance | 32-bit | 4 |
| Total | | 16 |

The paper writes this as 2Ψ + 2Ψ + KΨ = 16Ψ bytes, where Ψ is the parameter count and K = 12 is the optimizer's three 4-byte terms. These bytes are model state. Activations (values kept for the backward pass), buffers and fragmented memory come on top. The paper calls all of that residual memory and handles it separately (ZeRO-R).

For the 70B model, 70 × 10^9 × 16 bytes = 1,120 GB. One H100 holds 80 GB of HBM3, the stacked memory next to the chip, so the state needs at least 1,120 ÷ 80 = 14 GPUs before activations. An H200 holds 141 GB, according to NVIDIA's H200 page, which marks the figure preliminary, so eight are the minimum. The 140 GB of BF16 weights is one eighth of the total. The 8B model needs 128 GB, which is more than one H100.

So for a 70B model, the question is how many GPUs share the state, and how.

## Data parallelism and sharding

In plain data parallelism, every GPU holds a full copy of the model and trains on its own slice of the batch. The GPUs average their gradients with an all-reduce, a collective operation that leaves every GPU with the same result. This adds throughput, but each GPU still holds 1,120 GB at any GPU count. FSDP calls this mode NO_SHARD.

ZeRO removes the copies in three stages. With K = 12 and N data-parallel GPUs, the per-GPU model-state memory is:

- Stage 1 partitions the optimizer states: 4Ψ + KΨ/N bytes.
- Stage 2 also partitions the gradients: 2Ψ + 14Ψ/N bytes.
- Stage 3 also partitions the weights: 16Ψ/N bytes.

The paper's example is a 7.5-billion-parameter model on 64 GPUs. It needs 120 GB per GPU with standard data parallelism, 31.4 GB at stage 1, 16.6 GB at stage 2 and 1.9 GB at stage 3 (arXiv 1910.02054). For the 70B model on 64 GPUs, the same formulas give 293 GB, 155 GB and 17.5 GB. Only stage 3 leaves room for activations on an 80 GB card.

PyTorch's Fully Sharded Data Parallel (FSDP) offers these strategies. As of October 2026, its docs (version 2.14, updated May 2026) describe:

- FULL_SHARD, the default, shards parameters, gradients and optimizer states. Parameters are all-gathered (every GPU collects the missing shards) before each unit computes, then resharded. The docs say it is inspired by ZeRO stage 3.
- SHARD_GRAD_OP shards gradients and optimizer states, and keeps the parameters unsharded from forward through backward.
- NO_SHARD replicates everything, like DistributedDataParallel.
- HYBRID_SHARD applies FULL_SHARD within a node and replicates parameters across nodes.

Sharding costs communication. ZeRO stage 3 moves 3Ψ bytes per step, against 2Ψ for standard data parallelism, which is 1.5 times as much (arXiv 1910.02054). HYBRID_SHARD keeps the all-gathers inside one server, where GPUs share NVLink, the fast link between GPUs in a server.

```diagram
title: Full sharding. Each layer is gathered just before it runs, then freed.
[g0] GPU 0\nshard 1 of 4 @ 0,0
[g1] GPU 1\nshard 2 of 4 @ 1,0
[g2] GPU 2\nshard 3 of 4 @ 2,0
[g3] GPU 3\nshard 4 of 4 @ 3,0
[ag] All-gather\nlayer 12 @ 1.5,1
[full] Each GPU holds\nlayer 12 in full @ 1.5,2
g0 -> ag
g1 -> ag
g2 -> ag
g3 -> ag
ag -> full : run layer 12
```

The sketch below computes model-state memory per GPU with and without sharding.

```python
# Training memory per GPU: model state only (weights, gradients, Adam states).
# Mixed precision with Adam costs 16 bytes per parameter (ZeRO paper: 2P + 2P + 12P).

BYTES_PER_PARAM = {
    "BF16 weights": 2,
    "BF16 gradients": 2,
    "FP32 master weights": 4,
    "Adam momentum": 4,
    "Adam variance": 4,
}
TOTAL_BYTES = sum(BYTES_PER_PARAM.values())  # 16


def training_memory_gb(params: float, gpus: int, sharded: bool) -> float:
    """GB of model state per GPU, before activations and buffers.

    sharded=True:  full sharding (ZeRO-3 / FSDP FULL_SHARD); each GPU holds 1/gpus.
    sharded=False: no sharding (plain data parallelism); each GPU holds a full copy.
    """
    total_gb = params * TOTAL_BYTES / 1e9
    return total_gb / gpus if sharded else total_gb


if __name__ == "__main__":
    for name, params in [("8B", 8e9), ("70B", 70e9)]:
        for gpus in (1, 8, 16, 64):
            none = training_memory_gb(params, gpus, sharded=False)
            full = training_memory_gb(params, gpus, sharded=True)
            print(f"{name:>3} on {gpus:>2} GPUs: no sharding {none:7.1f} GB, "
                  f"full sharding {full:6.1f} GB")

# Output:
#  8B on  1 GPUs: no sharding   128.0 GB, full sharding  128.0 GB
#  8B on  8 GPUs: no sharding   128.0 GB, full sharding   16.0 GB
#  8B on 16 GPUs: no sharding   128.0 GB, full sharding    8.0 GB
#  8B on 64 GPUs: no sharding   128.0 GB, full sharding    2.0 GB
# 70B on  1 GPUs: no sharding  1120.0 GB, full sharding 1120.0 GB
# 70B on  8 GPUs: no sharding  1120.0 GB, full sharding  140.0 GB
# 70B on 16 GPUs: no sharding  1120.0 GB, full sharding   70.0 GB
# 70B on 64 GPUs: no sharding  1120.0 GB, full sharding   17.5 GB
```

At 8 GPUs, full sharding leaves 140 GB per GPU for the 70B model, still too big for an 80 GB card. At 16 GPUs it leaves 70 GB, so about 10 GB remains for activations. These are model-state numbers only, so they set a floor on the GPU count.

## Tensor, pipeline and 3D parallelism

Sharding fixes memory, but each GPU still runs the full math of every layer. When one layer's math is too big for one GPU, or the layers are too many for one server, the math must be split.

Tensor parallelism splits the matrix products inside each layer. The 2019 Megatron-LM paper splits the MLP's first matrix by columns, so each GPU computes its own part of the hidden layer, and the second by rows, followed by one all-reduce. Attention heads split the same way. Each layer needs two all-reduces in the forward pass and two in the backward pass, on every layer's critical path, so tensor parallelism needs fast links. The 2021 paper says it works best inside one server and can be impractical across the slower links between servers (arXiv 1909.08053, arXiv 2104.04473). The Llama 3 16K layout keeps tensor-parallel size at 8, the GPUs in one server (arXiv 2407.21783, section 3.3 and Table 4).

Pipeline parallelism splits the layers into stages on different servers and cuts each batch into microbatches that flow through them. The cost is the bubble, the idle time at the start and end of each batch. The 2021 Megatron-LM paper gives the lost fraction as (p − 1) ÷ m, where p is the number of stages and m is the number of microbatches (arXiv 2104.04473). With 4 stages and 8 microbatches, that is 3 ÷ 8 = 37.5 percent. With 32 microbatches, it is 3 ÷ 32 = 9.4 percent. Interleaving gives each device v smaller groups of layers, which divides the bubble by v at the cost of more communication.

```diagram
title: Two replicas of a 4-stage pipeline. Each stage is one server of 8 GPUs.
[a1] R1 stage 1\nlayers 1-20 @ 0,0
[a2] R1 stage 2\nlayers 21-40 @ 1,0
[a3] R1 stage 3\nlayers 41-60 @ 2,0
[a4] R1 stage 4\nlayers 61-80 @ 3,0
[b1] R2 stage 1\nlayers 1-20 @ 0,2
[b2] R2 stage 2\nlayers 21-40 @ 1,2
[b3] R2 stage 3\nlayers 41-60 @ 2,2
[b4] R2 stage 4\nlayers 61-80 @ 3,2
a1 -> a2 : activations
a2 -> a3 : activations
a3 -> a4 : activations
b1 -> b2 : activations
b2 -> b3 : activations
b3 -> b4 : activations
a1 <-> b1 : gradients all-reduce
```

Large runs combine the kinds. The 2021 paper's 1-trillion-parameter run used 3,072 GPUs at 502 petaFLOP/s, 52 percent of peak per GPU. The Llama 3 16K layout is tensor size 8 × pipeline size 16 × data size 128 = 16,384 GPUs, with context-parallel size 1 (Table 4). It reaches 41 percent MFU, against 43 percent at 8K GPUs with data-parallel size 64. The paper attributes the drop to a smaller batch per data-parallel group, since the batch stays at 16 million tokens (section 3.3.2).

## Failures and checkpoints

At 16K GPUs, failures are routine. Over a 54-day pre-training snapshot, the Llama 3 paper counts 466 job interruptions: 47 planned for maintenance and 419 unexpected (arXiv 2407.21783, section 3.3.4). Table 5 lists the largest causes as faulty GPUs (148), GPU HBM3 memory (72), software bugs (54), network switches and cables (35) and host maintenance (32).

Fifty-four days is 1,296 hours, so an unexpected interruption came about every 3.1 hours. If every one were a GPU failure, each GPU would fail about once every 5.8 years. Many causes aren't GPUs, so the real per-GPU rate is lower. A failure is rare for any one GPU and near certain for the job, so the job has to plan for it.

A checkpoint saves the weights, optimizer states, data position and random-number state. The paper says each GPU's share ranges from 1 MB to 4 GB, and that checkpoint writes are "highly bursty", saturating the storage fabric for short periods (sections 3.3.1 and 3.3.4). At 16 bytes per parameter, a 405B model's state is about 6.5 TB.

Checkpointing trades two costs. Checkpoint rarely, and each failure loses a long stretch of work. Checkpoint often, and training stalls each time. Daly's 2006 refinement of Young's first-order rule gives the balance (see further reading). With δ the stall per checkpoint and M the mean time between interruptions, the best interval is √(2δM) − δ, when δ is less than M/2. Assume a 2-minute stall and M = 185.6 minutes. The interval is √(2 × 2 × 185.6) − 2 = 25.2 minutes, and a failure costs about half of that, 12.6 minutes, plus restart time.

Asynchronous checkpointing shrinks the stall. PyTorch's distributed checkpoint API copies the state from GPU memory to CPU memory, then writes it to storage on a background thread by default (PyTorch docs, version 2.14). Training waits only for the copy. If the copy takes an assumed 10 seconds, the interval becomes 7.7 minutes, and the work lost per failure falls to about 3.8 minutes.

```diagram
title: Async checkpoint. Training stalls only for the copy to CPU memory.
[gpu:client] GPUs\nstep N @ 0,0
[cpu] CPU memory\nstaged copy @ 1,0
[disk:store] Storage\nstorage fabric @ 2,0
gpu -> cpu : copy, stalls training
cpu --> disk : background write
```

```python
# Daly's higher-order checkpoint interval: sqrt(2 * delta * M) - delta, valid when delta < M / 2.
# Restart time is left out because Daly's higher-order result shows it drops out.
from math import sqrt


def checkpoint_interval_min(stall_min: float, mtti_min: float) -> float:
    """stall_min: time each checkpoint stalls training (delta).
    mtti_min: mean time to an unexpected interruption (M)."""
    if stall_min >= mtti_min / 2:
        return mtti_min
    return sqrt(2 * stall_min * mtti_min) - stall_min


if __name__ == "__main__":
    mtti = 54 * 24 * 60 / 419  # Llama 3 snapshot: 54 days, 419 unexpected interruptions
    print(f"MTTI: {mtti:.1f} minutes ({mtti / 60:.2f} hours)")
    for label, stall in (("2-minute stall", 2.0), ("10-second stall", 10 / 60)):
        t = checkpoint_interval_min(stall, mtti)
        print(f"{label}: checkpoint every {t:.1f} min, about {t / 2:.1f} min lost per failure")

# Output:
# MTTI: 185.6 minutes (3.09 hours)
# 2-minute stall: checkpoint every 25.2 min, about 12.6 min lost per failure
# 10-second stall: checkpoint every 7.7 min, about 3.8 min lost per failure
```

## The data pipeline

The data pipeline collects and filters text, removes duplicates, tokenizes, and feeds each GPU its shards in a fixed order. The Llama 3 paper removes duplicates at three levels (arXiv 2407.21783, section 3.1.1). URL-level keeps the newest copy of each page. Document-level runs a global MinHash pass that finds near-duplicates without comparing every pair. Line-level drops lines that appear more than six times in each bucket of 30 million documents. The final mix is roughly 50 percent general knowledge, 25 percent math and reasoning, 17 percent code and 8 percent multilingual text (section 3.1.2).

Tokenize once. Running the tokenizer on every pass wastes time, so a common design writes token IDs into binary shards with an index. Megatron-LM's preprocessing script does this, writing a .bin file of IDs and a matching .idx index from JSON lines (tools/preprocess_data.py in its repository). Each data-parallel group reads its own shards in a fixed order, and the loader's position belongs in every checkpoint. A restart that rereads data repeats documents, and one that skips ahead loses them.

Size the pipeline from the compute. At 40 percent MFU, one H100 consumes 3.956 × 10^14 ÷ (6 × 8 × 10^9) ≈ 8,240 tokens per second on the 8B model, so a 2,000-GPU job needs about 16.5 million tokens per second.

## Fine-tuning

Full fine-tuning updates all 70 billion weights and needs the same 1,120 GB of state. That is why LoRA and QLoRA are the practical options.

Supervised fine-tuning (SFT) trains on prompts paired with the responses you want. InstructGPT's first step did this with labelers' demonstrations: "We then fine-tune a pretrained GPT-3 model on this data using supervised learning" (arXiv 2203.02155).

LoRA freezes each weight matrix W and learns a low-rank change BA, where B is d × r and A is r × k, with r much smaller than d or k. Only A and B get gradients (arXiv 2106.09685). For a 4,096 × 4,096 matrix, the model dimension of Llama 3.1 8B, a full update has 16,777,216 weights. Rank 8 trains 8 × (4,096 + 4,096) = 65,536 of them, or 0.39 percent. The paper says rank one or two suffices for GPT-3 175B even at a full dimension of 12,288, and its abstract reports 10,000 times fewer trainable parameters and 3 times less GPU memory than full fine-tuning with Adam. The frozen base still needs its weights: 16 GB in BF16 for 8B, which leaves most of an 80 GB H100 for activations, and 140 GB for 70B. After training, BA merges into W with no added inference latency, but a merged model serves one adapter ([inference fleets](/learn/inference-fleets#serving-many-models) covers serving many).

QLoRA keeps the base model in 4 bits and trains 16-bit adapters on top (arXiv 2305.14314). It adds NF4, a 4-bit data type for normally distributed weights, double quantization (about 0.37 bits saved per parameter), and paged optimizers, which move optimizer memory between CPU and GPU to avoid out-of-memory crashes. It fine-tunes a 65-billion-parameter model on one 48 GB GPU, where 16-bit tuning needs more than 780 GB. For the 70B model, the 4-bit base is 70 × 10^9 × 0.5 bytes = 35 GB. The paper also finds that adapters must sit on all linear layers to match full fine-tuning.

Preference tuning comes after SFT. RLHF, the method InstructGPT used, trains a reward model on labelers' rankings, then runs PPO against it while sampling answers (arXiv 2203.02155). DPO (Direct Preference Optimization) trains on preferred and dispreferred pairs against a frozen reference, the model before tuning. It needs no reward model and no sampling, but it keeps two copies of the model in memory (arXiv 2305.18290). On summarization, DPO beat PPO-based RLHF in the paper's GPT-4-judged comparison.

## Running a fine-tuning service

A company that fine-tunes for many teams needs a service with these parts:

- **Job spec.** The pinned base model version, method, dataset version, hyperparameters, GPU count and owner. An adapter trained on one base version can't be assumed to work on another.
- **Queue and quotas.** Jobs wait by priority, and each team has a GPU quota, so one sweep can't take the cluster.
- **Scheduler.** LoRA jobs fit on a few GPUs. A full 70B fine-tune needs at least 14 GPUs for its state, so it runs as a gang.
- **Workers.** They checkpoint, and after a failure they resume from the newest complete checkpoint.
- **Evaluation gate.** Publish the adapter only if it passes the same eval set as the base model ([AI evals and observability](/learn/ai-evals-and-observability#running-evals-before-release)).
- **Registry.** Store the adapter as safetensors, a format built to store tensors safely, as opposed to pickle (Hugging Face's safetensors docs). Record the base, dataset, hyperparameters and eval results ([AI security](/learn/ai-security#the-model-supply-chain)).
- **Publish.** The inference fleet loads the adapter next to the base model.

A 70B LoRA run on 8 GPUs for 12 hours is 96 GPU-hours, or $288 at an assumed $3.00 per GPU-hour. A higher-priority job should preempt a lower one only after the lower job checkpoints, or the preemption throws away its work. That is why every section above assumes checkpoints.

```diagram
title: A fine-tuning job, from request to served adapter.
[api:client] Job API @ 0,0
[q:queue] Job queue\nper-team quotas @ 1,0
[sch] Scheduler\ngang placement @ 2,0
[run] Workers\ncheckpoint and\nresume @ 3,0
[ev] Eval gate\nagainst base model @ 3,1
[reg:store] Adapter registry @ 2,1
[inf] Inference fleet\nloads the adapter @ 1,1
api -> q : submit
q -> sch
sch -> run : start all workers
run -> ev : checkpoint
ev -> reg : pass
reg -> inf : publish
```

## Scheduling GPU clusters

Training jobs run as gangs, groups of workers that must start together. A synchronous job can't progress until all its workers run, so the scheduler places all of a job's workers, or none.

Without that rule, two jobs that each need 4 servers, with 6 free, could each get 3 and wait forever while holding GPUs. Kubernetes documents gang scheduling as all-or-nothing: "If the cluster cannot accommodate the entire group (or a defined minimum number of Pods, specified by minCount), none of the Pods are bound to a node." As of the v1.37 docs, it is a beta feature, disabled by default (Kubernetes documentation). Kubeflow Trainer's coscheduling option makes a training job's pods start together, only when all their resources are available (Kubeflow Trainer documentation).

Slurm, the scheduler common in high-performance computing, calls itself "an open source, fault-tolerant, and highly scalable cluster management and job scheduling system". Its documentation uses "gang scheduling" for time sharing of parallel jobs, a different idea, so ask which meaning someone means (Slurm documentation).

Placement matters as much as counts. A scheduler that ignores topology can split a tensor-parallel group across two servers, sending its all-reduces over the slower links (arXiv 2104.04473). A 16,384-GPU job needs 2,048 servers at once, so on a busy cluster the scheduler must reserve capacity, wait, or preempt smaller jobs that checkpoint.

## Check yourself

<details>
<summary>A team fully fine-tunes a 13-billion-parameter model with Adam in mixed precision on 8 GPUs of 80 GB each. How much model state does each GPU hold with and without full sharding?</summary>

The state is 13 × 10^9 × 16 = 208 GB. Unsharded, each GPU holds all 208 GB. Fully sharded, each holds 208 ÷ 8 = 26 GB.

</details>

<details>
<summary>At 40 percent MFU on 989 teraFLOP/s H100s, how many GPU-days does 6 × parameters × tokens give for a 70B model on 2 trillion tokens? How long is that on 1,024 GPUs?</summary>

6 × 70 × 10^9 × 2 × 10^12 = 8.4 × 10^23 FLOPs, or 589,821 GPU-hours (24,576 GPU-days). On 1,024 GPUs, that is 24 days.

</details>

<details>
<summary>An 8-stage pipeline runs 16 microbatches. What fraction of time is the bubble, and how many microbatches keep it under 5 percent, with and without 2 interleaved chunks per device?</summary>

The bubble is (8 − 1) ÷ 16 = 43.75 percent. Under 5 percent needs at least 141 microbatches, or at least 71 with 2 chunks per device.

</details>

<details>
<summary>A 4,096-GPU job has an unexpected interruption every 3 hours, and each checkpoint stalls training for 90 seconds. What interval does Daly's rule suggest, and how much work does a failure cost?</summary>

The interval is √(2 × 1.5 × 180) − 1.5 ≈ 21.7 minutes. A failure costs about half of that on average, roughly 11 minutes, plus restart time.

</details>

<details>
<summary>Why won't a 70B model fit on one 80 GB H100 with LoRA in BF16, and what changes that?</summary>

The frozen BF16 base is 140 GB. QLoRA's 4-bit base is 35 GB and fits. Sharding the base across GPUs also works.

</details>

<details>
<summary>Two training jobs each need 4 servers. With 6 free servers and one-at-a-time placement, each job gets 3. What goes wrong, and what should the scheduler do?</summary>

Neither job can start, and the six servers they hold do no useful work. A gang scheduler starts one job on 4 servers and queues the other.

</details>

## Further reading

- [Llama 3 herd of models (arXiv 2407.21783)](https://arxiv.org/abs/2407.21783): 405B compute, the 16K-GPU layout and the interruption table.
- [Llama 3 model card](https://github.com/meta-llama/llama3/blob/main/MODEL_CARD.md): 8B and 70B GPU-hours.
- [Llama 3.1 model card](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/MODEL_CARD.md): later GPU-hours, including 405B.
- [ZeRO (arXiv 1910.02054)](https://arxiv.org/abs/1910.02054): bytes per parameter and the three stages.
- [PyTorch FSDP documentation](https://docs.pytorch.org/docs/stable/fsdp.html): the sharding strategies.
- [Megatron-LM, 2019 (arXiv 1909.08053)](https://arxiv.org/abs/1909.08053): tensor parallelism inside a layer.
- [Megatron-LM, 2021 (arXiv 2104.04473)](https://arxiv.org/abs/2104.04473): the bubble formula, interleaving and 3D parallelism.
- [LoRA (arXiv 2106.09685)](https://arxiv.org/abs/2106.09685): low-rank adapters and rank results.
- [QLoRA (arXiv 2305.14314)](https://arxiv.org/abs/2305.14314): 4-bit base models, NF4 and paged optimizers.
- [Direct Preference Optimization (arXiv 2305.18290)](https://arxiv.org/abs/2305.18290): the DPO loss.
- [InstructGPT (arXiv 2203.02155)](https://arxiv.org/abs/2203.02155): the three-step RLHF pipeline.
- [Kaplan et al., scaling laws (arXiv 2001.08361)](https://arxiv.org/abs/2001.08361): where the factor 6 comes from.
- [Chinchilla (arXiv 2203.15556)](https://arxiv.org/abs/2203.15556): compute-optimal token counts.
- [NVIDIA H100 product page](https://www.nvidia.com/en-us/data-center/h100/): memory and sparsity figures.
- [NVIDIA H200 product page](https://www.nvidia.com/en-us/data-center/h200/): the 141 GB figure, marked preliminary.
- [NVIDIA Hopper architecture in depth](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/): why sparsity doubles throughput.
- [PyTorch distributed checkpoint documentation](https://docs.pytorch.org/docs/stable/distributed.checkpoint.html): copy-then-write async saves.
- [Daly, "A higher order estimate of the optimum checkpoint interval for restart dumps" (2006)](https://laro.lanl.gov/esploro/outputs/journalArticle/A-higher-order-estimate-of-the/9916364420003761): the interval rule.
- [Blog summary of Daly's paper](https://blog.acolyer.org/2015/06/10/a-higher-order-estimate-of-the-optimun-checkpoint-interval-for-restart-dumps/): the formula and its condition.
- [Gang scheduling (Kubernetes documentation)](https://kubernetes.io/docs/concepts/scheduling-eviction/gang-scheduling/): the all-or-nothing rule.
- [Coscheduling (Kubeflow Trainer documentation)](https://trainer.kubeflow.org/en/latest/operator-guides/job-scheduling/coscheduling.html): how training pods start together.
- [Slurm overview](https://slurm.schedmd.com/overview.html): allocation, and Slurm's other meaning of "gang scheduling".
- [Megatron-LM preprocess_data.py](https://github.com/NVIDIA/Megatron-LM/blob/main/tools/preprocess_data.py): tokenized binary shards.
- [Safetensors documentation](https://huggingface.co/docs/safetensors/index): a tensor format for safe weight storage.
