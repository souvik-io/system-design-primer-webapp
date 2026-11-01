# The inference engineer

Training produces a model once. Serving it runs every day, for every user, and that is where most of the GPU bill goes. An inference engineer makes the serving fast, cheap and reliable. This handbook teaches that job from the bottom up: the arithmetic of a forward pass, the GPU it runs on, the kernels and engines that schedule it, the compression that shrinks it, and the fleet that keeps it up.

The [system design handbook](/learn/how-to-use-this-handbook) on this site explains what an inference platform contains and why. This one goes a level down and asks you to build and measure the pieces. Each chapter links to the system design chapter it builds on instead of repeating it, so read [how LLM inference works](/learn/llm-inference) first if prefill, decode and the KV cache are new.

This chapter covers what the job is, how it differs from its neighbours, what employers ask for, how interviews test it, and how to set up the lab you will use for the rest of the course.

## What an inference engineer does

A request for a completion passes through several layers before a single multiplication happens. An inference engineer owns most of them.

```diagram
title: The path of one request. The inference engineer owns everything from the router down.
[client:client] Client app @ 0,0
[gw] API gateway\nauth, quotas @ 1,0
[router] Router\npicks a replica @ 2,0
[sched] Engine scheduler\nbatches, KV blocks @ 3,0
[runner] Model runner\nCUDA graphs @ 3,1
[kern] Kernels\nGEMM, attention @ 2,1
[hbm:store] GPU memory\nweights, KV cache @ 1,1
client -> gw : HTTPS, streamed
gw -> router
router -> sched
sched -> runner : one batch per step
runner -> kern
kern -> hbm : read every step
```

- The **router** chooses a replica, often by load or by which replica already holds the prompt's prefix in its cache.
- The **engine scheduler** decides, every step, which requests run, how many prompt tokens to process, and where each request's KV cache lives in GPU memory.
- The **model runner** turns that batch into GPU work: PyTorch modules, compiled graphs and captured CUDA graphs.
- The **kernels** do the arithmetic. Matrix multiplies (GEMMs) and attention take nearly all of the time.
- **GPU memory** holds the weights and the KV cache. Reading it is what limits most decode steps, as Part 1 shows.

The work is measured by a handful of numbers. Time to first token (TTFT) is how long a user waits before anything appears. Inter-token latency (ITL) is the gap between streamed tokens. Throughput is tokens per second per GPU, and cost is dollars per million tokens. [The latency metrics section](/learn/llm-inference#latency-and-throughput-metrics) defines them. In a typical week, the work might look like this:

- You bring up a new model in vLLM or SGLang and find a configuration that meets its latency target.
- You quantize the model to FP8 and show that the quality loss is acceptable.
- You trace a p99 latency regression to a scheduler change or a slow kernel.
- You write a fused kernel for an operation the engine runs unfused.
- You plan how many GPUs next quarter's traffic needs, and what they will cost.

## Where the role sits

Job titles in this area overlap, and the same title means different things at different companies. The table separates the jobs by what they own.

| Role | Owns | A typical task | Hired for |
|---|---|---|---|
| Inference engineer | Serving engine, model runtime, latency and cost per token | Cut p99 ITL by 30% on a new model | Engines, GPUs, quantization, profiling |
| Kernel or performance engineer | Individual GPU kernels | Write an FP8 attention kernel for a new GPU | CUDA, Triton, CUTLASS, hardware detail |
| ML platform or infrastructure engineer | Clusters, scheduling, deployment, observability | Autoscale model replicas on queue depth | Kubernetes, distributed systems, cloud |
| MLOps engineer | Pipelines from training to production | Automate evaluation and rollout of a new checkpoint | CI/CD, model registries, monitoring |
| Research engineer | Training runs and experiments | Scale a training job to 1,000 GPUs | Training frameworks, parallelism, numerics |
| Applied AI engineer | Products built on models | Build a retrieval assistant on an API | Prompting, RAG, evals, product sense |

The inference engineer sits between the kernel engineer and the platform engineer. You need enough kernel knowledge to know when a kernel is the problem and to write a simple one, and enough platform knowledge to run the engine as a service. Small companies often merge all three jobs into one.

## What employers ask for

In a sample of inference postings from October 2026 (Together AI, Nebius, Intel, Hedra and Uniphore, listed under Further reading), the same requirements came up again and again:

- **A serving engine in production.** Postings name vLLM, SGLang or TensorRT-LLM. Together AI's posting asks for familiarity with at least one of TensorRT-LLM, vLLM, SGLang or TGI.
- **GPU kernels.** Postings expect you to read and debug CUDA, and treat writing kernels in CUDA, Triton or CUTLASS as a plus. Hedra's posting asks for building or optimizing GPU kernels when off-the-shelf implementations fall short.
- **Inference techniques.** Postings list KV cache management, continuous batching, quantization and speculative decoding.
- **Profiling and measured results.** Employers want experience with Nsight or similar profilers, the ability to find a workload's bottleneck, and speedups you can point to on real workloads.
- **Open-source work.** Upstream contributions to vLLM or SGLang count in your favour, and Intel's posting makes upstreaming part of the job.

Senior postings add distributed serving (tensor and expert parallelism, disaggregated prefill and decode) and multi-node operations. The handbook's parts follow this list:

| What postings ask for | Where this handbook teaches it |
|---|---|
| Why a model is slow or fast on given hardware | Part 1, the model as a workload |
| GPU architecture, CUDA, Triton, profiling | Part 2, GPUs and kernels |
| PyTorch compilation, CUDA graphs, C++ extensions | Part 3, the runtime layer |
| Quantization (FP8, INT4, FP4) and quality evaluation | Part 4, compression |
| vLLM, SGLang, TensorRT-LLM internals, speculative decoding | Part 5, serving engines |
| Tensor, pipeline and expert parallelism, disaggregation | Part 6, distributed inference |
| LoRA and QLoRA, serving many adapters | Part 7, fine-tuning for serving |
| Containers, Kubernetes, autoscaling, observability | Part 8, production |
| On-device runtimes (optional) | Part 9, edge inference |
| The interview loop and your portfolio | Part 10, interviews |

## How interviews test it

Loops differ by company, but most inference interviews draw on five kinds of round:

1. **Coding.** The language is usually Python and sometimes C++. Expect general problems, plus inference-flavoured ones: implement attention with a KV cache, a top-p sampler, a block allocator, or one step of a batching scheduler. Some companies ask for a small CUDA or Triton kernel.
2. **ML systems deep dive.** You get questions such as "why is decode memory-bound?", "how much KV cache does this model need at 32K context?", or "when does speculative decoding make things slower?" You are expected to work out numbers live.
3. **System design.** You design a service that serves a model to a given load within a latency target. The [AI system design questions](/learn/design-inference-platform) on this site are the practice set for this round.
4. **Past-project deep dive.** You explain something you built or sped up. Interviewers probe the baseline, how you measured, what you changed and what it cost. Projects with numbers beat projects without.
5. **Take-home.** Some companies ask you to make a kernel or a serving configuration faster and to write up what you did.

The labs in this handbook produce material for rounds 1, 2 and 4: working code you wrote, numbers you measured, and write-ups you can talk through.

## How this handbook works

Every chapter has the same parts:

- **Prerequisites** at the top name the system design chapters to read first.
- **Concept sections** work through the ideas with numbers. The numbers come from code you can run, and every printed output in a chapter is real output from that code.
- **A lab** is tagged by the hardware it needs and has a task, a definition of done, and a reference solution folded under "Reference solution". Try the lab before opening the solution.
- **An interview angle** lists questions the chapter prepares you for and what a strong answer contains.
- **Check yourself** and **Further reading** close the chapter, as in the rest of the site.

Labs use three hardware tiers:

| Tag | What it needs | Where to get it |
|---|---|---|
| **[Mac]** or **[any]** | A laptop. Apple silicon, any NVIDIA GPU, or a plain CPU | What you have |
| **[1 GPU]** | One NVIDIA GPU. An L4 or A10G covers most labs; an H100 for FP8 | Hourly rental: RunPod, Lambda, Modal, Vast.ai, Colab |
| **[multi-GPU]** | 2 to 8 GPUs in one machine | Hourly rental, a few hours per lab |

Batch the GPU labs so one rental covers several, and log what each session cost. A line like "measured on one rented L4 for $3" is a good detail in an interview.

## Lab: set up your lab

**Tier: [any].** This lab runs on any laptop and builds the workspace every later lab uses.

Complete these tasks:

1. Create a git repository, `inference-lab`, with folders `bench/`, `labs/`, `notes/` and `results/`.
2. Create a Python 3.12 environment with [uv](https://docs.astral.sh/uv/) and install `torch`, `transformers` and `numpy`.
3. Check that PyTorch sees an accelerator: `cuda` on NVIDIA, `mps` on Apple silicon.
4. Write `bench/record.py` with a function `record(name, result)` that appends one JSON line to `results/results.jsonl`, holding the benchmark name, a UTC timestamp, the result, and the environment it ran in (Python, PyTorch, device name, CUDA and driver versions when present, and the git commit).
5. Open an account with one GPU rental provider and note its hourly price for an L4 and an H100.

The lab is done when `python bench/record.py` appends a line naming your device and `results.jsonl` is committed.

The recorder matters because benchmark numbers without the versions and hardware they came from cannot be compared later. A software upgrade alone can move results a long way: [vLLM reported](https://vllm.ai/blog/2024-09-05-perf-update) 2.7 times the throughput for version 0.6.0 over 0.5.3, on Llama 3 8B on one H100.

The reference recorder is also available as a file, [record.py](/labs/infra/record.py), to save into your lab repository as `bench/record.py`. Every Python file the handbook's labs use is in the site's repository under `public/labs/infra/`, and the scripts that need an NVIDIA GPU are kept apart in `public/labs/infra/gpu/`.

<details>
<summary>Reference solution</summary>

Set up the repository and the environment:

```bash
mkdir inference-lab && cd inference-lab && git init
mkdir bench labs notes results
uv venv --python 3.12 && source .venv/bin/activate
uv pip install torch transformers numpy
python -c "import torch; print(torch.cuda.is_available(), torch.backends.mps.is_available())"
```

Then write `bench/record.py`:

```python
# bench/record.py: append one benchmark result, with the machine and software it ran on, to a log.
import datetime
import json
import platform
import subprocess
import sys


def environment() -> dict:
    env = {"python": platform.python_version(), "os": platform.platform(), "machine": platform.machine()}
    try:
        import torch
        env["torch"] = torch.__version__
        if torch.cuda.is_available():
            env["device"] = torch.cuda.get_device_name(0)
            env["cuda"] = torch.version.cuda
            env["gpu_count"] = torch.cuda.device_count()
        elif torch.backends.mps.is_available():
            env["device"] = "mps"
    except ImportError:
        pass
    if platform.system() == "Darwin":
        env["cpu"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"],
                                    capture_output=True, text=True).stdout.strip()
    try:  # NVIDIA driver version, if nvidia-smi exists
        env["driver"] = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, check=True).stdout.split("\n")[0]
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    try:
        env["git_commit"] = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                                           capture_output=True, text=True, check=True).stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    return env


def record(name: str, result: dict, path: str = "results/results.jsonl") -> dict:
    row = {"name": name, "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
           "env": environment(), "result": result}
    with open(path, "a") as f:
        f.write(json.dumps(row) + "\n")
    return row


if __name__ == "__main__":
    row = record("smoke-test", {"note": sys.argv[1] if len(sys.argv) > 1 else "setup works"})
    print(json.dumps(row, indent=2))
```

This is the output on an Apple M2 laptop before the first commit, so there is no `git_commit` yet:

```text
{
  "name": "smoke-test",
  "time": "2026-10-31T13:39:03+00:00",
  "env": {
    "python": "3.12.10",
    "os": "macOS-26.6.2-arm64-arm-64bit",
    "machine": "arm64",
    "torch": "2.15.0",
    "device": "mps",
    "cpu": "Apple M2"
  },
  "result": {
    "note": "setup works"
  }
}
```

On a rented NVIDIA machine the same script adds `device` (for example "NVIDIA L4"), `cuda`, `gpu_count` and `driver`. Later labs import `record` and pass their measurements as `result`.

</details>

## Interview angle

- **"Tell me about a performance improvement you made."** A strong answer has five parts: the baseline and how it was measured, the bottleneck and how you found it, the change, the result with the same measurement, and the cost or risk of the change. The labs are built to give you stories in this shape.
- **"What does an inference engineer optimize for?"** The job optimizes latency (TTFT and ITL at a percentile), throughput per GPU and cost per token, while holding quality constant. A strong answer adds that these trade against each other through batch size, and that the right point depends on the product's latency target.
- **"How is serving different from training?"** Training is one long throughput job with all data known in advance. Serving is many short, unpredictable requests with latency targets, where memory for the KV cache, not compute, usually limits how many users fit. [Training and fine-tuning infrastructure](/learn/training-infrastructure#training-compared-with-inference) compares them in detail.

## Check yourself

<details>
<summary>Name the layers a request passes through between the API gateway and GPU memory, and one decision each layer makes.</summary>

The router picks a replica, for example the one holding the prompt's prefix in cache. The engine scheduler picks which requests join this step's batch and where their KV cache blocks go. The model runner turns the batch into GPU work, often by replaying a captured CUDA graph. The kernels do the matrix multiplies and attention, and they read weights and KV cache from GPU memory every step.

</details>

<details>
<summary>How does an inference engineer's job differ from a kernel engineer's and from an ML platform engineer's?</summary>

A kernel engineer makes individual GPU operations fast. A platform engineer runs clusters, deployments and autoscaling. The inference engineer owns the serving engine and the model's runtime between them: batching, memory, quantization, and the latency and cost of each token. The job needs enough kernel knowledge to find and fix a slow kernel, and enough platform knowledge to run the engine as a service.

</details>

<details>
<summary>Why record the software versions and hardware with every benchmark result?</summary>

Serving performance depends on the engine version, PyTorch, CUDA, the driver and the exact GPU. Without them, two results cannot be compared, and a later regression cannot be traced to its cause. An engine upgrade alone can move throughput by a large margin.

</details>

<details>
<summary>An interviewer asks how you would show that an optimization helped. What do you describe?</summary>

Describe a fixed workload (prompt and output lengths, request rate), a baseline measured with warmup and several runs, and the metric that matters, for example p99 ITL at a given throughput. Then describe the change made on its own, the same measurement repeated afterwards, and a quality check if the change could affect outputs. Report the spread, not only the best run.

</details>

## Further reading

- The job postings sampled for this chapter in October 2026 were [Together AI, LLM inference frameworks and optimization engineer](https://jobs.generalcatalyst.com/companies/together-ai-2/jobs/72517179-llm-inference-frameworks-and-optimization-engineer), [Uniphore, senior inference engineer](https://www.dice.com/job-detail/736b5e4b-8610-411b-88bc-5b79f3d5607c), [Hedra, inference optimization engineer](https://builtin.com/job/inference-optimization-engineer/11572766), [Nebius, LLM inference optimization](https://jobpilot.suxrobgm.net/jobs/senior-machine-learning-engineer-llm-inference-optimization-at-nebius-group-05fe1a) and [Intel, AI infrastructure engineer](https://intel.wd1.myworkdayjobs.com/en-US/External/job/AI-Infrastructure-Engineer_JR0286233). Postings change or close, so some of these links may stop working.
- [AI inference infrastructure interview prep](https://www.techinterview.org/post/3233475331/ai-inference-infrastructure-interview-prep-2026-vllm-triton/) and [InterviewCoder's LLM engineer questions](https://www.interviewcoder.co/blog/llm-engineer-interview-questions) are community question banks. They are useful for the shape of the questions, not as authorities.
- The [vLLM documentation](https://docs.vllm.ai/) and the [SGLang documentation](https://docs.sglang.io/) cover the two open engines that most postings name.
- [vLLM v0.6.0: 2.7x throughput improvement and 5x latency reduction](https://vllm.ai/blog/2024-09-05-perf-update) is the vLLM team's report of how much one release changed performance on the same hardware.
- [uv](https://docs.astral.sh/uv/) is the Python package and environment manager the labs use.
