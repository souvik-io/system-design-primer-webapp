# Profiling and benchmarking

Every claim in this part of the handbook rests on a measurement, and a measurement is only as good as its method. This chapter covers both halves of that work. Benchmarking asks how fast something is, and it is easy to get a precise but wrong answer. Profiling asks where the time goes, and it needs the right tool for the question: the PyTorch profiler for a whole model step, Nsight Systems for a timeline of a program, and Nsight Compute for the counters inside one kernel. The lab profiles one decode step of Llama 3.2 1B on an H100 and finds that the GPU spends most of the step waiting.

Before this chapter, read [how a GPU executes code](/learn/gpu-execution) and [the arithmetic of inference](/learn/inference-arithmetic), whose step-time model is what a profile is compared against.

## Benchmarking without fooling yourself

The same operation can produce very different numbers depending on how it is timed. Two measurements in this part show it. Chapter 2.1's probe timed an 8,192-square BF16 matmul on an H100 at 803 TFLOP/s, and chapter 2.2's script timed the same cuBLAS call on another H100 at 678 TFLOP/s. Neither is wrong. The probe reported the fastest of 20 back-to-back runs, which take under 30 ms, while Triton's `do_bench`, according to its source, repeats the call for about 100 ms by default, clears the L2 cache before every run and returns the mean. The longer measurement is more likely to reach the GPU's power limit, described below. Neither number means anything without its method.

A sound benchmark follows a few rules:

- **Synchronise before reading a clock.** Kernel launches return immediately, so a timer read on the CPU without `torch.cuda.synchronize()` measures only the launch. CUDA events, recorded on the GPU's own stream, measure the GPU's time directly.
- **Warm up.** The first calls pay for compilation, autotuning, memory allocation and cold caches. Every script in this part runs a few untimed iterations first.
- **Decide what the caches should hold.** A kernel that will run on fresh data in production should be timed with a cold L2, as `do_bench` does. A kernel that really does reuse data across calls can be timed warm, but say so.
- **Report a distribution for latency.** For a kernel, a mean or median of many runs is enough. For a service, users feel the tail, so report p50, p90 and p99, never only the mean.
- **Record the clocks and the machine.** GPUs change their clock speed with power and temperature, and the host CPU matters whenever launch overhead does. Record the clocks and power with every result, and run long enough for the GPU to reach a steady state, because a short burst can finish before the power limit lowers the clock.

The lab measured both of the last effects on Modal H100s. While a long run of BF16 matmuls was in flight, `nvidia-smi` reported the GPU at its 700 W power limit, with the SM clock down from 1,980 MHz to about 1,400 MHz:

```text
4. SM clock and power while 3,000 BF16 8192-square matmuls run back to back (about 4 s on an H100)
   idle:   1980 MHz, 1980 MHz, 134.80 W, 700.00 W, 28
   busy 1: 1395 MHz, 1980 MHz, 699.86 W, 700.00 W, 45
   busy 2: 1455 MHz, 1980 MHz, 695.89 W, 700.00 W, 47
   busy 3: 1905 MHz, 1980 MHz, 611.18 W, 700.00 W, 35
   busy 4: 1980 MHz, 1980 MHz, 449.95 W, 700.00 W, 33
   busy 5: 1980 MHz, 1980 MHz, 197.92 W, 700.00 W, 32
   busy 6: 1980 MHz, 1980 MHz, 119.68 W, 700.00 W, 32
```

The columns are the current SM clock, the maximum SM clock, the power draw, the power limit and the temperature in degrees Celsius. The samples probably begin near the end of the run: Python can queue only a limited number of kernels ahead of the GPU, so the loop that queues the matmuls returns when most of them have already run. The first two samples catch the GPU at its power limit, and the later ones show the clock recovering and the power falling as the last matmuls finish. This is the explanation chapter 2.1 left open for the BF16 rate dipping at the largest matmul: a long, dense run of matmuls reaches the power limit, and the GPU lowers its clock to stay within it. A short benchmark that never reaches the limit will report a higher rate than a long production run achieves.

The host mattered too. The same script, run three times on Modal H100s, measured a batch-1 decode step of Llama 3.2 1B at 15.68 ms, 7.49 ms and 16.12 ms, and chapter 3.1's lab measured the same step at 10.30 ms. The code that times the step did not change between the runs, and the third run reserved four CPU cores. The step is limited by how fast the CPU launches kernels, as the next section shows, so a different host CPU or a busier neighbour changed the result by a factor of two, and reserving cores did not remove the difference. A benchmark report should name the GPU, the driver, the library versions and, for anything launch-bound, the CPU. The [record.py](/labs/infra/record.py) helper from chapter 0.1 captures most of these.

## Profiling a decode step with the PyTorch profiler

`torch.profiler` records every PyTorch operation on the CPU and every kernel on the GPU, and links them, so it answers the first question to ask of a slow model: is the time on the CPU, on the GPU, or between them? The lab's [profile_decode.py](/labs/infra/gpu/profile_decode.py) runs Llama 3.2 1B in BF16 at batch 1 with a 512-token prompt, then profiles one decode step on an H100, run with four reserved CPU cores (`--cpu 4`):

```text
NVIDIA H100 80GB HBM3, PyTorch 2.15.0+cu132; unsloth/Llama-3.2-1B-Instruct: 2.47 GB of weights

1. Decode step at batch 1: 16.12 ms wall time (62 tokens/s); reading the weights once at the spec bandwidth would take 0.74 ms
2. One profiled step: 694 GPU kernels, 549 kernel launches from the CPU; GPU busy 2.24 ms of a 24.95 ms span (9%); longest gap between kernels 198 us
```

The model predicts 0.74 ms, the time to read 2.47 GB of weights at 3.35 TB/s, and the step takes 16.12 ms on this host, more than twenty times longer. The profile shows why. The step runs 694 kernels, which add up to 2.24 ms of GPU work, so even without the profiler the GPU is idle for about 86% of the step. The median kernel in the trace runs for 1.7 µs, shorter than the time the CPU takes to launch the next one. The profiler itself slows the CPU side further, which is why the profiled span is 25 ms rather than 16; the GPU times inside it are still accurate.

A profile of one step records one-time costs along with recurring ones, so look at its longest gap before trusting it. The first version of this lab profiled a step at a KV cache length that no earlier step had used, and its trace showed a single 40.8 ms gap just before the first attention kernel. That gap was cuDNN building its attention plan for the new length, which [chapter 3.1](/learn/pytorch-execution#graph-breaks-guards-and-recompiles) explains. The script now profiles a step at a length the timing loop has already used, and its longest gap is 198 µs.

The profiler's table of the top operations by GPU time shows what the 2.24 ms consist of:

```text
                                                        Name    Self CUDA   Self CUDA %    CUDA total  CUDA time avg    # of Calls
                                                aten::linear      0.000us         0.00%       1.246ms      11.023us           113
                                                    aten::mm      1.246ms        55.54%       1.246ms      11.023us           113
                      nvjet_sm90_tst_64x8_64x16_2x1_v_bz_TNT    447.634us        19.96%     447.634us      13.989us            32
                                                   aten::mul    266.418us        11.88%     266.418us       1.788us           149
```

The table above keeps the columns that matter here; the script prints all of them. The 113 matrix multiplications take 55% of the GPU's time, in cuBLAS kernels whose names begin with `nvjet`. They move the 2.47 GB of weights in 1.25 ms, about 2 TB/s or 59% of the spec bandwidth, which is reasonable for matmuls with a single row of activations. The 149 element-wise multiplications, from RMSNorm, the rotary embeddings and the MLP's gating, take another 12%, at under 2 µs each. Grouping the trace's kernels by type gives 433 element-wise kernels, 65 concatenations, which come from the rotary embedding's rotate-half step and from appending the new token's keys and values to the KV cache by copying it, 50 reductions and 32 kernels of cuDNN's fused attention, which PyTorch's `scaled_dot_product_attention` chose for this step.

The widget below draws the recorded trace. The top row is the CPU's launch calls and the bottom row is the GPU's kernels; zoom in to see the gaps:

```widget
decode-timeline
```

The diagnosis is that this step is limited by launch overhead, not by the GPU's memory or arithmetic. The fixes are the subject of [Part 3](/learn/pytorch-execution): CUDA graphs record the whole sequence of kernels once and replay it with a single launch, and `torch.compile` fuses the small element-wise kernels into fewer, larger ones. Serving engines such as vLLM do both, which is why they decode far faster than a plain Hugging Face forward pass on the same GPU.

## Nsight Systems: the whole timeline

Nsight Systems records a timeline of a whole program: CPU threads, CUDA API calls, kernels, memory copies, and NVTX ranges that the program marks itself. It is the tool for questions about how the parts fit together, such as whether the GPU waits for the CPU, whether data copies overlap with compute, or whether two streams really run at the same time. A typical command and summary report look like this:

```bash
nsys profile --trace cuda,nvtx,osrt -o decode python my_script.py
nsys stats --report cuda_gpu_kern_sum --report cuda_api_sum decode.nsys-rep
```

The first command writes a `.nsys-rep` file to open in the Nsight Systems GUI, and the second prints tables of kernel time and API time. The lab's [nsys_decode.py](/labs/infra/gpu/nsys_decode.py) wraps both around the same Llama 3.2 1B decode step. It marks each step with an NVTX range, records only 20 steps between `cudaProfilerStart` and `cudaProfilerStop` (the `--capture-range cudaProfilerApi` option), and prints three summaries. On Modal it needs the toolkit image, whose Nsight Systems importer needs the `libdw1` system package; without it, `nsys` records the raw trace but fails to convert it, with an unhelpful "Importer error status: An unknown error occurred". On an H100 with four reserved cores:

```text
NVTX ranges: 20 decode steps, 16.85 ms each on average (CPU time inside the range)

GPU kernels: 13880 launches (694 per step), 2.22 ms of kernel time per step
    share  count      mean   kernel
    19.7%    640   13.7 us   nvjet_sm90_tst_64x8_64x16_2x1_v_bz_TNT
     9.9%    320   13.7 us   nvjet_sm90_tst_64x8_64x16_2x1_v_bz_splitK_TNT
     8.6%    640    6.0 us   nvjet_sm90_tst_64x8_64x16_4x1_v_bz_TNT
     7.9%     20  174.6 us   nvjet_sm90_tst_384x8_64x4_2x1_v_bz_TNT
     7.8%    640    5.4 us   nvjet_sm90_tst_8x64_64x16_4x1_v_bz_TNN
     6.5%   1280    2.3 us   void at::native::elementwise_kernel<(int)128, (int)4, void at::native:
     3.7%   1280    1.3 us   void at::native::vectorized_elementwise_kernel<(int)8, at::native::CUD
     3.4%    660    2.3 us   void at::native::reduce_kernel<(int)512, (int)1, at::native::ReduceOp<

CUDA API calls on the CPU, by total time:
    share  count      mean   call
    71.5%  10660    5.6 us   cudaLaunchKernel
    21.7%   2900    6.3 us   cuLaunchKernelEx
     2.3%    320    6.1 us   cudaLaunchKernelExC_v11060
     2.0%  10660    0.2 us   cuKernelGetName
     1.0%   4520    0.2 us   cuKernelGetAttribute
     0.5%    640    0.7 us   cuKernelSetAttribute
```

The kernel table agrees with the PyTorch profiler: 694 kernels and about 2.2 ms of GPU work per step, led by the same cuBLAS matmuls. The API table adds the CPU's side. Each step makes 694 launch calls of about 6 µs each, roughly 4 ms of launching per 16.85 ms step, and the rest of the CPU's time goes to Python and PyTorch's own dispatch before each launch. Every one of those microseconds is time the GPU spends waiting, which is the cost that CUDA graphs remove.

The same tool also shows one-time costs. Recording the script's first pass instead, where every step meets a new cache length, gave steps of 48.6 ms on average, and the API table gained one `cuLibraryLoadData` call and one `cuKernelGetFunction` call in every step, the second taking about 1 ms each time: most likely cuDNN loading the attention kernel it had just built for that length. That is why the script records a second pass over lengths it has already seen.

## Nsight Compute: inside one kernel

Nsight Compute replays a kernel several times and reads the GPU's hardware counters, so it answers why one kernel is slow: whether it is memory-bound or compute-bound, how well its loads are coalesced, how full its SMs are, and what its warps are waiting for. It worked inside a Modal container on an A10 once told not to lock the GPU's clocks, with the option `--clock-control none`, at the cost of somewhat less consistent results.

The lab's [ncu_strided.py](/labs/infra/gpu/ncu_strided.py) runs the same element-wise kernel twice over 16 million float32 values, once reading them contiguously and once reading every eighth value, and asks Nsight Compute for four metrics:

| Metric | Contiguous | Every 8th value |
|---|---|---|
| Load requests (`l1tex__t_requests_pipe_lsu_mem_global_op_ld.sum`) | 131,072 | 524,288 |
| Sectors loaded (`l1tex__t_sectors_pipe_lsu_mem_global_op_ld.sum`) | 2,097,152 | 16,777,216 |
| Sectors per request | 16 | 32 |
| DRAM throughput, share of peak | 92% | 95% |
| Kernel time | 278 µs | 1,190 µs |

These counters show chapter 2.1's coalescing rule directly. The contiguous kernel is vectorized, so each thread loads 16 bytes and each warp request covers 512 bytes, exactly 16 sectors. The strided kernel's warp requests touch 32 different sectors each, the worst case, and it loads eight times as many sectors for the same useful data. Both kernels keep DRAM almost fully busy, so the strided one is not idle; it is busy moving bytes it throws away. It takes 4.3 times as long rather than eight because both kernels also write the same 64 MiB of output: the contiguous kernel moves about 128 MiB in total and the strided one about 576 MiB, 4.5 times as much. A kernel that shows high DRAM throughput is not necessarily efficient, which is why sectors per request is the counter to check first for a memory-bound kernel.

The counter names come from Nsight Compute's Kernel Profiling Guide. Running `ncu --set full` on a kernel collects most sections at once, including the memory workload analysis and the warp stall reasons, and the GUI shows them with explanations.

## From evidence to a fix

A profile is useful when it leads to a decision. Most performance problems in inference fall into one of three cases, and each has its own signature and its own fixes:

| What the profile shows | Diagnosis | Typical fixes |
|---|---|---|
| GPU idle between many short kernels; CPU busy launching | Launch overhead, as in the decode step above | CUDA graphs, `torch.compile`, kernel fusion, larger batches |
| Long kernels with high DRAM throughput and low compute use | Memory-bound | Fewer bytes: fusion, lower precision weights or KV cache, better access patterns |
| Long kernels with high tensor-core use | Compute-bound | Lower precision such as FP8, fewer FLOPs, or more GPUs |

The roofline from Part 1 tells you which case to expect before you profile, and the profile tells you whether reality agrees. When they disagree, as with the decode step that the roofline put at 0.74 ms and the measurement found at 16.12 ms, the gap is the most useful thing to explain.

## Lab: profile a decode step

**Tier: [1 GPU].** The profiling run took 37 seconds of H100 time on Modal, about 4 cents, including a 2.5 GB model download. The Nsight Systems run took 28 seconds of H100 time, and the Nsight Compute run 8 seconds of A10 time, under a cent.

The scripts are ready to download:

- [gpu/profile_decode.py](/labs/infra/gpu/profile_decode.py) loads Llama 3.2 1B, measures and profiles a decode step, writes its timeline to `decode_trace.json`, and samples the GPU's clock and power under load. Run it with `modal run modal_run.py --script profile_decode.py --gpu H100 --cpu 4`.
- [gpu/nsys_decode.py](/labs/infra/gpu/nsys_decode.py) records 20 decode steps under Nsight Systems and prints its NVTX, kernel and CUDA API summaries. Run it with `modal run modal_run.py --script nsys_decode.py --gpu H100 --toolkit --cpu 4`.
- [gpu/ncu_strided.py](/labs/infra/gpu/ncu_strided.py) runs a contiguous and a strided read under Nsight Compute. It needs the CUDA toolkit, so run it with `modal run modal_run.py --script ncu_strided.py --gpu A10 --toolkit`. Modal's A10 type may give you an A10 or the closely related A10G.

**Part A, a decode step.** Profile one batch-1 decode step of Llama 3.2 1B with `torch.profiler`. Report the step time, the number of kernels, the GPU's busy time, and the top kernels. Compare the step time with the roofline estimate from chapter 1.2.

**Part B, one kernel's counters.** Use Nsight Compute to measure sectors per request and DRAM throughput for a contiguous and a strided read, and connect the numbers to the coalescing rule from chapter 2.1.

**Part C, a findings memo.** Write one page that a teammate could act on: what you measured, how, what limits the step, and what you would try first, with the expected gain. The lab is done when the memo states a diagnosis supported by at least two numbers from your profiles.

<details>
<summary>Reference solution</summary>

Parts A and B are the measurements printed in this chapter. A memo for Part C, written from them, could read as follows.

**Decode step of Llama 3.2 1B at batch 1 on one H100: findings.**

*What we measured.* With Hugging Face transformers' standard forward pass in BF16, one decode step after a 512-token prompt takes 16.12 ms of wall time, or 62 tokens a second. The roofline estimate for reading the 2.47 GB of weights once at 3.35 TB/s is 0.74 ms. Earlier runs of the same script on other Modal H100s measured 15.68 ms and 7.49 ms, so results depend on the host and must be reported with it.

*Where the time goes.* The PyTorch profiler records 694 GPU kernels per step, adding up to 2.24 ms of GPU work, so the GPU is idle for about 86% of the step. The median kernel runs for 1.7 µs. Matmuls take 55% of the GPU time and reach about 2 TB/s; 433 element-wise kernels and 65 KV-cache concatenations make up most of the rest.

*Diagnosis.* The step is limited by kernel launch overhead on the CPU. It is not limited by the GPU's memory bandwidth or its arithmetic.

*What to try first.* First switch to a static KV cache (in transformers, `cache_implementation="static"`), which preallocates the cache and writes each new token in place, so every decode step has the same shapes. Then capture the step in a CUDA graph, for example with `torch.compile(mode="reduce-overhead")`, which replays all kernels with one launch. That should bring the step close to the GPU's 2.24 ms of work, several times faster. Fusing the element-wise kernels, which `torch.compile` also does, should then cut the GPU time itself towards the 0.74 ms floor. [Chapter 3.1's lab](/learn/pytorch-execution#lab-speed-up-the-decode-step) measures these steps.

</details>

## Interview angle

- **"A model is slower than your estimate. How do you find out why?"** Start with a timeline from the PyTorch profiler or Nsight Systems to see whether the GPU is busy. If it is mostly idle, the problem is on the CPU side: launches, Python overhead or synchronisation. If it is busy, find the kernels that take the time and examine the worst with Nsight Compute to see whether they are memory-bound, compute-bound or poorly coalesced.
- **"How do you benchmark a kernel properly?"** Warm up, synchronise, time with CUDA events, decide whether the cache should be warm or cold, report a mean or median over many runs, and record the GPU, the clocks, the driver and the library versions. For anything that runs long, check whether the GPU is hitting its power limit.
- **"What does it mean if Nsight Compute shows 32 sectors per request?"** Each warp load touches 32 different 32-byte sectors, so each thread's value lives in its own sector; for 4-byte loads, seven eighths of every sector is wasted. The access pattern is uncoalesced, and the fix is to change the data layout or stage the data through shared memory.
- **"Why is a Hugging Face decode step so much slower than vLLM on the same GPU?"** At small batch, a plain forward pass launches hundreds of tiny kernels and the GPU waits for the CPU between them. vLLM captures the decode step in CUDA graphs, uses fused kernels and a paged KV cache that it writes in place, so the GPU stays busy.

## Check yourself

<details>
<summary>The same cuBLAS matmul measured 803 TFLOP/s in one script and 678 TFLOP/s in another on an H100. Give two reasons the method alone can explain this.</summary>

The first script reported the fastest of 20 runs, while `triton.testing.do_bench` returns the mean of many runs, which includes the slower ones. And `do_bench` repeats the call for about 100 ms by default, while the probe's 20 runs take under 30 ms, so the longer measurement is more likely to reach the power limit described in this chapter and run at a lower clock. `do_bench` also clears the L2 cache before every run, but that matters little here: each 8,192-square BF16 operand is 128 MiB, far larger than the H100's 50 MB L2, so back-to-back runs find little of their data still cached. The two scripts also ran on different H100s, whose clocks and power states can differ.

</details>

<details>
<summary>The profiled decode step showed 2.24 ms of GPU work, but the profiled span was 25 ms and the unprofiled step 16.12 ms. Which numbers do you trust, and for what?</summary>

The kernel durations are measured on the GPU and are reliable, so 2.24 ms is the GPU's real work. The profiler adds CPU overhead to every operation, which stretches the gaps between kernels, so the 25 ms span overstates the step. The step time should come from an unprofiled, synchronised measurement, 16.12 ms here. Together they show that the GPU is idle for about 86% of the step.

</details>

<details>
<summary>Under a long run of matmuls, nvidia-smi showed 700 W against a 700 W limit and an SM clock of 1,395 MHz. What does this mean for a benchmark?</summary>

The GPU reached its power limit and lowered its clock from 1,980 MHz to stay within it, so its arithmetic rate fell by almost 30% while the limit applied. A short benchmark that ends before the power limit lowers the clock will report a higher rate than a long production run. Record clocks and power during benchmarks, and run them long enough to reach a steady state.

</details>

<details>
<summary>Both the contiguous and the strided read kept DRAM above 90% busy. Why was the strided one still 4.3 times slower?</summary>

DRAM throughput counts every byte moved, useful or not. The strided read loads 32 sectors per warp request where the contiguous one loads 16, and it needs four times as many requests, so it moves eight times as many sectors for the same useful values. The memory system is just as busy, but most of what it moves is discarded.

</details>

<details>
<summary>Which tool would you reach for first for each question: why the GPU is idle between kernels, why one attention kernel is slow, and which PyTorch operation launches the most kernels?</summary>

For idle gaps between kernels, Nsight Systems or the PyTorch profiler's timeline, since the answer lies in how CPU and GPU work interleave. For one slow kernel, Nsight Compute, which reads the kernel's hardware counters. For which PyTorch operation launches the most kernels, the PyTorch profiler's operator table, which maps kernels back to the operations that launched them.

</details>

## Further reading

- [The PyTorch profiler documentation](https://docs.pytorch.org/docs/stable/profiler.html) covers `torch.profiler`, its operator tables and the trace export used in the lab.
- [The Nsight Systems user guide](https://docs.nvidia.com/nsight-systems/UserGuide/index.html) explains how to record and read timelines, including the `nsys stats` reports.
- [The Nsight Compute Kernel Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html) defines the metrics used here, such as sectors and requests per load, and explains the memory and warp-state sections.
- [triton.testing.do_bench](https://triton-lang.org/main/python-api/generated/triton.testing.do_bench.html) documents the benchmarking helper used throughout this part, and its source shows the L2 cache clearing described above.
- [Making deep learning go brrrr from first principles](https://horace.io/brrr_intro.html) by Horace He explains overhead, bandwidth and compute as the three regimes a profile reveals.
