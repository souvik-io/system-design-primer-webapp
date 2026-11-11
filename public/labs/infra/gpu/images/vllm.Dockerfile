# The vLLM image, for the serving labs. vLLM pins its own PyTorch version (2.13.0, built with CUDA 13.0, for
# vLLM 0.32.0), so it gets an image of its own. It starts from NVIDIA's CUDA 13.0 development image because
# FlashInfer, whose sampler vLLM uses by default, compiles some of its kernels with nvcc the first time they run.
#   docker build -t lab-vllm -f images/vllm.Dockerfile images
FROM nvidia/cuda:13.0.3-devel-ubuntu24.04
# A slow PyPI download should be retried rather than fail the whole build.
ENV PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN pip install --no-cache-dir vllm==0.32.0
# Suffix decoding, one of vLLM's speculative decoding methods (chapter 5.4), is implemented in Snowflake's Arctic
# Inference, which vLLM imports only when that method is chosen. The package has no dependencies of its own.
RUN pip install --no-cache-dir arctic-inference==0.3.0
WORKDIR /labs
