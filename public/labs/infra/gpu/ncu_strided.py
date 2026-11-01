# ncu_strided.py: Nsight Compute's view of a coalesced and a strided read (chapter 2.5).
#
# The script reads 16M float32 values twice: once contiguously, once taking every 8th value.
# Run plainly it only does the work; run under Nsight Compute it reports, for each copy kernel, the sectors read
# per load request and the DRAM throughput, the counters behind chapter 2.1's coalescing measurements.
#
#   ncu --clock-control none --kernel-name regex:elementwise --launch-skip 1 --launch-count 2 --metrics l1tex__t_sectors_pipe_lsu_mem_global_op_ld.sum,\
#       l1tex__t_requests_pipe_lsu_mem_global_op_ld.sum,dram__throughput.avg.pct_of_peak_sustained_elapsed \
#       python ncu_strided.py
#
# With no arguments it runs that command on itself if ncu is installed. Needs an NVIDIA GPU, the CUDA toolkit,
# and permission to read GPU performance counters, which some hosted containers do not grant.
import os
import shutil
import subprocess
import sys

import torch

n = 16 * 2**20
x = torch.randn(n * 8, device="cuda")
out = torch.empty(n, device="cuda")
# Both reads go through the same element-wise kernel (adding 0), because a plain contiguous copy_ would become a
# cudaMemcpy, which is not a kernel and which Nsight Compute does not profile.
torch.add(x[:n], 0.0, out=out)                          # contiguous: thread t reads element t
torch.add(x.view(n, 8)[:, 0], 0.0, out=out)             # strided: thread t reads element 8t
torch.cuda.synchronize()
print("copies done")

if not os.environ.get("UNDER_NCU"):
    ncu = shutil.which("ncu") or next((p for p in ("/usr/local/cuda/bin/ncu", "/opt/nvidia/nsight-compute/ncu") if os.path.exists(p)), None)
    print(f"ncu: {ncu}, nsys: {shutil.which('nsys')}")
    if ncu:
        metrics = ",".join(["l1tex__t_sectors_pipe_lsu_mem_global_op_ld.sum", "l1tex__t_requests_pipe_lsu_mem_global_op_ld.sum",
                            "dram__throughput.avg.pct_of_peak_sustained_elapsed", "gpu__time_duration.sum"])
        # Skip the first matching kernel (torch.randn's), keep the two copies. --clock-control none lets ncu run
        # where it may not lock the GPU's clocks, as in hosted containers; results then vary a little more.
        run = subprocess.run([ncu, "--clock-control", "none", "--kernel-name", "regex:elementwise", "--launch-skip", "1",
                              "--launch-count", "2", "--metrics", metrics, sys.executable, __file__],
                             env=dict(os.environ, UNDER_NCU="1"), capture_output=True, text=True)
        print("\n".join(l for l in (run.stdout + run.stderr).splitlines() if l.strip())[-3000:])
