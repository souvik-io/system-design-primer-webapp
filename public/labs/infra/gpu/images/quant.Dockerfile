# The quantization image, for chapters 4.3 to 4.5: llm-compressor to make quantized checkpoints and vLLM to serve
# and evaluate them. The two pin different versions of PyTorch, Transformers and compressed-tensors (vLLM 0.32.0
# wants torch 2.13.0 and compressed-tensors 0.17.0, llm-compressor 0.15.0 wants torch up to 2.14.1 and
# compressed-tensors 0.20.1), so each gets its own virtual environment: /opt/venv (vLLM, on PATH) and /opt/llmc.
# Checkpoints written by the newer compressed-tensors load in vLLM's older one; quantize_and_eval.py checks that.
#   docker build -t lab-quant -f images/quant.Dockerfile images
FROM nvidia/cuda:13.0.3-devel-ubuntu24.04
# A slow PyPI download should be retried rather than fail the whole build.
ENV PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir vllm==0.32.0 pyarrow
RUN python3 -m venv /opt/llmc && /opt/llmc/bin/pip install --no-cache-dir llmcompressor==0.15.0
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /labs
