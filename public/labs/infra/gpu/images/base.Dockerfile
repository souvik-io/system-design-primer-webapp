# The default lab image. PyTorch's Linux wheels bring the CUDA 13.2 runtime and Triton, but no compiler;
# Transformers is there for the labs that load a model.
#
# modal_run.py and gcp_run.py both build from this file, and so can you on any machine with an NVIDIA GPU:
#   docker build -t lab-base -f images/base.Dockerfile images
#   docker run --rm --gpus all -v "$PWD":/labs -w /labs lab-base python gpu_probe.py
FROM python:3.12-slim-bookworm
RUN pip install --no-cache-dir torch==2.15.0 numpy==2.5.4 transformers==5.22.2
WORKDIR /labs
