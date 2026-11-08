# quantize_and_eval.py: quantize Llama 3.1 8B Instruct seven ways with llm-compressor, serve every version in vLLM,
# and measure its memory, speed and quality (chapters 4.3 and 4.4).
#
# Versions: BF16 (the original); FP8 W8A8 (dynamic per-token activations, no calibration); INT8 W8A8 (SmoothQuant
# then GPTQ); INT4 W4A16 rounded to nearest (RTN), with GPTQ calibrated on an instruction mix and on WikiText,
# and with AWQ; NVFP4 (W4A4; vLLM runs it natively only on Blackwell and falls back to weight-only FP4
# elsewhere); BF16 and AWQ with an FP8 KV cache; and two controls, BF16 evaluated again with the same settings and with smaller
# batches, to show how many answers change with no quantization at all. Calibration uses the first rows of
# open-perfectblend, an instruction mix of chat, code, reasoning and math that llm-compressor loads by name as
# "perfectblend", except for the WikiText GPTQ version.
#
# For each version, in a fresh vLLM engine:
#   memory     weight memory and the KV cache capacity vLLM reports at start-up
#   speed      decode step time at batch 1 and 32, and prefill throughput (16 prompts of 2,048 tokens)
#   check      perplexity of each checkpoint loaded with Transformers on 8 windows, next to vLLM's on the same
#              windows, to show that vLLM reads the checkpoint as llm-compressor wrote it
#   quality    WikiText-2 test perplexity (40 windows of 2,048 tokens); GSM8K test accuracy (1,319 problems,
#              5-shot, greedy, the format of lm-evaluation-harness's gsm8k task); ARC-Challenge test accuracy
#              (1,172 questions, length-normalized log-likelihood, like lm-eval's acc_norm); and "flips", the
#              share of questions whose right/wrong outcome differs from BF16's.
#
# The script runs itself in two virtual environments of images/quant.Dockerfile: --quantize NAME in /opt/llmc
# (llm-compressor) and --evaluate NAME in /opt/venv (vLLM). Checkpoints go to CKPT_DIR, outside the lab folder,
# so a launcher does not copy them back; the results go to quant_results.json next to this file.
#
#   python gcp_run.py --script quantize_and_eval.py --gpu L4 --quant --max-hours 6
#   modal run modal_run.py --script quantize_and_eval.py --gpu L4 --quant --args "--model unsloth/Llama-3.2-1B-Instruct --quick"
#   python quantize_and_eval.py      # inside the quant image, or with both environments set up as in the Dockerfile
import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LLMC_PYTHON, VLLM_PYTHON = "/opt/llmc/bin/python", "/opt/venv/bin/python"
CKPT_DIR = Path(os.environ.get("CKPT_DIR", Path.home() / ".cache" / "huggingface" / "handbook-ckpt"))
RESULTS = HERE / "quant_results.json"

# name -> (checkpoint to make, kv cache dtype[, most sequences vLLM runs at once]). Checkpoint "bf16" means the
# original model. The two "again" versions are controls: the same BF16 model evaluated a second time, with the same
# settings and with smaller batches, which shows how many answers change without any quantization at all.
VERSIONS = {
    "BF16": ("bf16", "auto"),
    "FP8 W8A8": ("fp8-dynamic", "auto"),
    "INT8 W8A8 (SmoothQuant + GPTQ)": ("w8a8-int8", "auto"),
    "INT4 W4A16 (RTN)": ("w4a16-rtn", "auto"),
    "INT4 W4A16 (GPTQ, perfectblend calibration)": ("w4a16-gptq", "auto"),
    "INT4 W4A16 (GPTQ, WikiText calibration)": ("w4a16-gptq-wiki", "auto"),
    "INT4 W4A16 (AWQ)": ("w4a16-awq", "auto"),
    "NVFP4 W4A4": ("nvfp4", "auto"),
    "BF16, FP8 KV cache": ("bf16", "fp8"),
    "INT4 W4A16 (AWQ), FP8 KV cache": ("w4a16-awq", "fp8"),
    "BF16 again": ("bf16", "auto", 0),
    "BF16 again, at most 32 sequences at a time": ("bf16", "auto", 32),
}


# ---- Quantizing (runs in /opt/llmc) -----------------------------------------------------------------------------
def quantize(model_id: str, ckpt: str, samples: int) -> None:
    import torch
    from llmcompressor import oneshot
    from llmcompressor.modifiers.gptq import GPTQModifier
    from llmcompressor.modifiers.quantization import QuantizationModifier
    from llmcompressor.modifiers.transform.awq import AWQModifier
    from llmcompressor.modifiers.transform.smoothquant import SmoothQuantModifier
    from transformers import AutoModelForCausalLM, AutoTokenizer

    # The recipes follow llm-compressor 0.15.0's examples for Llama 3, with fewer calibration samples.
    recipes = {
        "fp8-dynamic": (QuantizationModifier(targets="Linear", scheme="FP8_DYNAMIC", ignore=["lm_head"]), 0, 0),
        "w8a8-int8": ([SmoothQuantModifier(smoothing_strength=0.8),
                       GPTQModifier(targets="Linear", scheme="W8A8", ignore=["lm_head"])], samples, 2048),
        "w4a16-rtn": (QuantizationModifier(targets="Linear", scheme="W4A16", ignore=["lm_head"]), 0, 0),
        "w4a16-gptq": (GPTQModifier(targets="Linear", scheme="W4A16", ignore=["lm_head"]), samples, 2048),
        "w4a16-gptq-wiki": (GPTQModifier(targets="Linear", scheme="W4A16", ignore=["lm_head"]), samples, 2048),
        "w4a16-awq": ([AWQModifier(duo_scaling="both"),
                       QuantizationModifier(targets=["Linear"], scheme="W4A16_ASYM", ignore=["lm_head"])], samples, 512),
        "nvfp4": (QuantizationModifier(targets="Linear", scheme="NVFP4", ignore=["lm_head"]), samples, 2048),
    }
    recipe, n, seq = recipes[ckpt]
    model = AutoModelForCausalLM.from_pretrained(model_id, dtype=torch.bfloat16)
    tok = AutoTokenizer.from_pretrained(model_id)
    t = time.time()
    if ckpt.endswith("-wiki"):
        # Random 2,048-token windows of WikiText-2's training split, the domain of the perplexity test, instead of
        # perfectblend's conversations. Chapter 4.3 compares the two.
        from datasets import Dataset

        text = "\n\n".join(r["text"] for r in parquet("Salesforce/wikitext", "wikitext-2-raw-v1/train-00000-of-00001.parquet"))
        ids = tok(text, return_tensors="pt").input_ids[0]
        g = torch.Generator().manual_seed(0)
        starts = torch.randint(0, ids.numel() - seq, (n,), generator=g).tolist()
        ds = Dataset.from_dict({"input_ids": [ids[s : s + seq].tolist() for s in starts],
                                "attention_mask": [[1] * seq for _ in starts]})
        oneshot(model=model, dataset=ds, recipe=recipe, max_seq_length=seq, num_calibration_samples=n)
    elif n:
        oneshot(model=model, dataset="perfectblend", splits=f"train[:{n}]", recipe=recipe, max_seq_length=seq,
                num_calibration_samples=n)
    else:
        oneshot(model=model, recipe=recipe)
    seconds = time.time() - t
    out = CKPT_DIR / ckpt
    model.save_pretrained(out, save_compressed=True)
    tok.save_pretrained(out)
    size = sum(f.stat().st_size for f in out.glob("*.safetensors"))
    (out / "quantize_info.json").write_text(json.dumps({"seconds": seconds, "calibration_samples": n,
                                                        "seq_len": seq, "bytes": size}))
    print(f"[quantize] {ckpt}: {seconds:.0f} s, {size / 1e9:.2f} GB on disk")


def hf_perplexity(path: str, windows: int = 8) -> float:
    """Perplexity of a checkpoint loaded with Transformers, which decompresses compressed-tensors checkpoints to
    their dequantized weights. It checks that vLLM reads each checkpoint as llm-compressor wrote it: the two
    perplexities should agree closely for weight-only versions."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(path)
    model = AutoModelForCausalLM.from_pretrained(path, dtype=torch.bfloat16, device_map="cuda").eval()
    text = "\n\n".join(r["text"] for r in parquet("Salesforce/wikitext", "wikitext-2-raw-v1/test-00000-of-00001.parquet"))
    ids = tok(text, return_tensors="pt").input_ids[0][: windows * 2048].view(windows, 2048)
    nll = 0.0
    with torch.no_grad():
        for w in ids:
            out = model(w[None].cuda(), labels=w[None].cuda())
            nll += out.loss.item() * 2047
    return math.exp(nll / (windows * 2047))


# ---- Data -------------------------------------------------------------------------------------------------------
def parquet(repo: str, path: str) -> list[dict]:
    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download

    return pq.read_table(hf_hub_download(repo, path, repo_type="dataset")).to_pylist()


def gsm8k_prompts():
    train = parquet("openai/gsm8k", "main/train-00000-of-00001.parquet")
    test = parquet("openai/gsm8k", "main/test-00000-of-00001.parquet")
    shots = "".join(f"Question: {r['question']}\nAnswer: {r['answer']}\n\n" for r in train[:5])
    return [shots + f"Question: {r['question']}\nAnswer:" for r in test], [r["answer"].split("####")[-1].strip()
                                                                         for r in test]


def gsm8k_correct(text: str, gold: str) -> bool:
    m = re.search(r"####\s*(-?[\d,\.]+)", text)
    if m:
        got = m.group(1)
    else:                                            # lm-eval's flexible-extract: the last number in the answer
        nums = re.findall(r"-?[\d,]*\.?\d+", text)
        got = nums[-1] if nums else ""
    norm = lambda s: s.replace(",", "").replace("$", "").rstrip(".")
    return norm(got) == norm(gold)


# ---- Evaluating (runs in /opt/venv) -------------------------------------------------------------------------------
def evaluate(model_path: str, kv: str, quick: bool, max_seqs: int = 0) -> dict:
    import vllm
    from vllm import LLM, SamplingParams
    from vllm.inputs import TokensPrompt

    res = {"vllm": vllm.__version__}
    llm = LLM(model=model_path, max_model_len=4096, gpu_memory_utilization=0.90, kv_cache_dtype=kv,
              enable_prefix_caching=False, seed=0, **({"max_num_seqs": max_seqs} if max_seqs else {}))
    tok = llm.get_tokenizer()

    # Speed. A decode step is (time for 1 + n tokens - time for 1 token) / n, from the same prompts.
    def gen_seconds(prompts, n):
        sp = SamplingParams(max_tokens=n, ignore_eos=True, temperature=0)
        llm.generate(prompts, sp, use_tqdm=False)
        t = time.perf_counter()
        llm.generate(prompts, sp, use_tqdm=False)
        return time.perf_counter() - t

    rand = lambda n, length: [TokensPrompt(prompt_token_ids=[(i * 7919 + j * 104729) % 30000 + 1000 for j in range(length)])
                              for i in range(n)]
    for batch in (1, 32):
        p = rand(batch, 512)
        res[f"decode_ms_b{batch}"] = (gen_seconds(p, 129) - gen_seconds(p, 1)) / 128 * 1000
    p = rand(16, 2048)
    res["prefill_tok_s"] = 16 * 2048 / gen_seconds(p, 1)

    # WikiText-2 perplexity from the log-probabilities vLLM assigns to the prompt's own tokens.
    text = "\n\n".join(r["text"] for r in parquet("Salesforce/wikitext", "wikitext-2-raw-v1/test-00000-of-00001.parquet"))
    ids = tok(text).input_ids
    n_win = 8 if quick else 40
    wins = [ids[i * 2048 : (i + 1) * 2048] for i in range(n_win)]
    outs = llm.generate([TokensPrompt(prompt_token_ids=w) for w in wins],
                        SamplingParams(max_tokens=1, prompt_logprobs=0), use_tqdm=False)
    nll = count = 0
    for w, o in zip(wins, outs):
        for t, lp in zip(w[1:], o.prompt_logprobs[1:]):
            nll -= lp[t].logprob
            count += 1
    res["wikitext_ppl"] = math.exp(nll / count)
    n8 = sum(1 for _ in wins[:8]) * 2047                  # the same first 8 windows as the Transformers check
    nll8 = -sum(lp[t].logprob for w, o in zip(wins[:8], outs[:8]) for t, lp in zip(w[1:], o.prompt_logprobs[1:]))
    res["vllm_ppl_8"] = math.exp(nll8 / n8)

    # GSM8K, greedy.
    prompts, gold = gsm8k_prompts()
    if quick:
        prompts, gold = prompts[:100], gold[:100]
    outs = llm.generate(prompts, SamplingParams(max_tokens=320, temperature=0, stop=["Question:", "\n\n\n"]),
                        use_tqdm=False)
    res["gsm8k"] = [gsm8k_correct(o.outputs[0].text, g) for o, g in zip(outs, gold)]

    # ARC-Challenge: the choice whose continuation has the highest log-likelihood per character.
    arc = parquet("allenai/ai2_arc", "ARC-Challenge/test-00000-of-00001.parquet")
    if quick:
        arc = arc[:100]
    reqs, index = [], []
    for qi, r in enumerate(arc):
        ctx = f"Question: {r['question']}\nAnswer:"
        n_ctx = len(tok(ctx).input_ids)
        for ci, choice in enumerate(r["choices"]["text"]):
            full = tok(ctx + " " + choice).input_ids
            reqs.append(TokensPrompt(prompt_token_ids=full))
            index.append((qi, ci, n_ctx, len(choice) + 1))
    outs = llm.generate(reqs, SamplingParams(max_tokens=1, prompt_logprobs=0), use_tqdm=False)
    scores = {}
    for (qi, ci, n_ctx, chars), req, o in zip(index, reqs, outs):
        ids_ = req["prompt_token_ids"]
        ll = sum(o.prompt_logprobs[j][ids_[j]].logprob for j in range(n_ctx, len(ids_)))
        scores.setdefault(qi, []).append(ll / chars)
    res["arc"] = [max(range(len(s)), key=s.__getitem__) == r["choices"]["label"].index(r["answerKey"])
                  for (qi, s), r in zip(sorted(scores.items()), arc)]
    return res


def run_child(python: str, args: list[str], log: Path) -> tuple[int, str]:
    """Run this script in another environment, echo its output, and keep it for parsing."""
    with open(log, "w") as f:
        p = subprocess.Popen([python, "-u", __file__, *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in p.stdout:
            f.write(line)
            # Echo the progress lines and real errors; vLLM also logs a harmless failed import of an optional
            # Triton kernel package at start-up, which is skipped.
            if "[quantize]" in line or ("Error" in line and "triton_kernels" not in line):
                print("   " + line.rstrip()[:300], flush=True)
        p.wait()
    return p.returncode, log.read_text()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="unsloth/Meta-Llama-3.1-8B-Instruct")   # an ungated copy of Meta's weights
    ap.add_argument("--samples", type=int, default=256, help="calibration samples")
    ap.add_argument("--quick", action="store_true", help="100 questions per task and 8 perplexity windows")
    ap.add_argument("--only", default="", help="version names to run, separated by semicolons")
    ap.add_argument("--quantize")
    ap.add_argument("--evaluate")
    ap.add_argument("--kv", default="auto")
    ap.add_argument("--max-seqs", type=int, default=0)
    ap.add_argument("--hf-check", help="print a checkpoint's perplexity computed with Transformers")
    a = ap.parse_args()

    if a.quantize:
        quantize(a.model, a.quantize, a.samples)
        return
    if a.hf_check:
        path = a.model if a.hf_check == "bf16" else str(CKPT_DIR / a.hf_check)
        print(f"[hfcheck] {hf_perplexity(path):.4f}")
        return
    if a.evaluate:
        path = a.model if a.evaluate == "bf16" else str(CKPT_DIR / a.evaluate)
        print("[evaluate] " + json.dumps(evaluate(path, a.kv, a.quick, a.max_seqs)))
        return

    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    logs = CKPT_DIR / "logs"
    logs.mkdir(exist_ok=True)
    results = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    wanted = [v for v in VERSIONS if not a.only or v in [x.strip() for x in a.only.split(";")]]
    print(f"model {a.model}; checkpoints in {CKPT_DIR}; {len(wanted)} versions\n", flush=True)
    for name in wanted:
        ckpt, kv, *control = VERSIONS[name]
        info = {}
        if ckpt != "bf16":
            if not (CKPT_DIR / ckpt / "config.json").exists():
                print(f"{name}: quantizing", flush=True)
                code, out = run_child(LLMC_PYTHON, ["--quantize", ckpt, "--model", a.model,
                                                    "--samples", str(a.samples)], logs / f"quantize-{ckpt}.log")
                if code != 0:
                    print("   quantizing failed; last lines:\n" + "\n".join(out.splitlines()[-15:]), flush=True)
                    results[name] = {"error": "quantize failed"}
                    continue
            info = json.loads((CKPT_DIR / ckpt / "quantize_info.json").read_text())
        if kv == "auto" and not control:      # the Transformers cross-check, once per checkpoint
            code, out = run_child(LLMC_PYTHON, ["--hf-check", ckpt, "--model", a.model], logs / f"hfcheck-{ckpt}.log")
            m = re.search(r"\[hfcheck\] ([\d.]+)", out)
            info["hf_ppl_8"] = float(m.group(1)) if m else None
            print(f"   Transformers perplexity on 8 windows: {info['hf_ppl_8']}", flush=True)
        print(f"{name}: evaluating", flush=True)
        args = ["--evaluate", ckpt, "--model", a.model, "--kv", kv, "--max-seqs", str(control[0] if control else 0)]
        args += ["--quick"] if a.quick else []
        code, out = run_child(VLLM_PYTHON, args, logs / f"evaluate-{ckpt}-{kv}-{control[0] if control else 'd'}.log")
        line = next((l for l in out.splitlines() if l.startswith("[evaluate] ")), None)
        # vLLM's engine sometimes exits with an error while shutting down, after the results were printed, so
        # the result line, not the exit code, decides whether the evaluation worked.
        if line is None:
            err = [l for l in out.splitlines() if l.strip() and "triton_kernels" not in l][-6:]
            print("   evaluation failed: " + " | ".join(err)[:400], flush=True)
            results[name] = {"error": " | ".join(err)[:400], **info}
            continue
        r = json.loads(line[len("[evaluate] "):])
        mem = re.search(r"[Mm]odel loading took ([\d.]+) GiB", out)
        kvtok = re.search(r"GPU KV cache size: ([\d,]+) tokens", out)
        r["weights_gib"] = float(mem.group(1)) if mem else None
        r["kv_tokens"] = int(kvtok.group(1).replace(",", "")) if kvtok else None
        results[name] = {**r, **info}
        RESULTS.write_text(json.dumps(results, indent=1))
        print(f"   weights {r['weights_gib']} GiB, KV cache {r['kv_tokens']} tokens, decode {r['decode_ms_b1']:.1f} ms, "
              f"ppl {r['wikitext_ppl']:.3f}, GSM8K {sum(r['gsm8k']) / len(r['gsm8k']):.1%}, "
              f"ARC {sum(r['arc']) / len(r['arc']):.1%}", flush=True)

    base = results.get("BF16", {})
    print(f"\n{'version':<44}{'weights':>9}{'KV tokens':>11}{'decode b1':>11}{'decode b32':>12}{'prefill':>10}"
          f"{'ppl':>8}{'GSM8K':>8}{'flips':>7}{'ARC-C':>8}{'flips':>7}")
    for name in VERSIONS:
        r = results.get(name)
        if not r:
            continue
        if "error" in r:
            print(f"{name:<44}  failed: {r['error'][:100]}")
            continue
        flips = lambda k: (f"{sum(x != y for x, y in zip(r[k], base[k])) / len(r[k]):>7.1%}"
                           if k in base and len(base[k]) == len(r[k]) else f"{'':>7}")
        print(f"{name:<44}{r['weights_gib'] or float('nan'):>7.2f}Gi{r['kv_tokens'] or 0:>11,}{r['decode_ms_b1']:>9.2f}ms"
              f"{r['decode_ms_b32']:>10.2f}ms{r['prefill_tok_s']:>10,.0f}{r['wikitext_ppl']:>8.3f}"
              f"{sum(r['gsm8k']) / len(r['gsm8k']):>8.1%}{flips('gsm8k')}{sum(r['arc']) / len(r['arc']):>8.1%}{flips('arc')}")
    print("\nweights: GPU memory for the weights; KV tokens: KV cache capacity at gpu_memory_utilization 0.90;")
    print("prefill: tokens/s for 16 prompts of 2,048 tokens; flips: questions whose right/wrong outcome differs from BF16.")


if __name__ == "__main__":
    main()
