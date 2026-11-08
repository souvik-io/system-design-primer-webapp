# The toolkit image, for labs that compile or profile CUDA: nvcc, compute-sanitizer, Nsight Compute and
# Nsight Systems come with NVIDIA's development image. Its CUDA version (13.2) matches the one the pinned
# PyTorch 2.15.0 wheels were built with; change both together.
#   docker build -t lab-toolkit -f images/toolkit.Dockerfile images
FROM nvidia/cuda:13.2.1-devel-ubuntu24.04
# libdw1: Nsight Systems' trace importer needs libdw.so.1, which the image lacks.
# python3-dev: torch.utils.cpp_extension compiles against Python's headers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential libdw1 \
 && rm -rf /var/lib/apt/lists/*
# Ubuntu 24.04 refuses system-wide pip installs (PEP 668), so the packages go into a virtual environment on PATH.
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN pip install --no-cache-dir torch==2.15.0 numpy==2.5.4 ninja==1.13.2 transformers==5.22.2
WORKDIR /labs
