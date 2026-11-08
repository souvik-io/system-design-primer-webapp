# The default lab image. PyTorch's Linux wheels bring the CUDA 13.2 runtime and Triton, but no compiler;
# Transformers is there for the labs that load a model.
#
# modal_run.py and gcp_run.py both build from this file, and so can you on any machine with an NVIDIA GPU:
#   docker build -t lab-base -f images/base.Dockerfile images
#   docker run --rm --gpus all -v "$PWD":/labs -w /labs lab-base python gpu_probe.py
FROM python:3.12-slim-bookworm
# A slow PyPI download should be retried rather than fail the whole build.
ENV PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10
# gcc: Triton compiles a small C launcher for each kernel the first time it runs (chapters 2.2 and 4.2).
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.15.0 numpy==2.5.4 transformers==5.22.2
WORKDIR /labs
