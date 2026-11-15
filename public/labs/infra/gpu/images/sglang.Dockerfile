# The SGLang image, for chapter 5.3's comparison with vLLM. SGLang pins its own PyTorch (2.14.1, built with
# CUDA 13.0, for SGLang 0.5.23), which differs from the version vLLM 0.32.0 pins, so the two engines cannot share
# an image. It starts from NVIDIA's CUDA 13.0 development image for the same reason as the vLLM image: FlashInfer,
# SGLang's default attention backend, compiles some of its kernels with nvcc the first time they run.
#   docker build -t lab-sglang -f images/sglang.Dockerfile images
FROM nvidia/cuda:13.0.3-devel-ubuntu24.04
# A slow PyPI download should be retried rather than fail the whole build.
ENV PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential libnuma1 \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN pip install --no-cache-dir sglang==0.5.23
WORKDIR /labs
