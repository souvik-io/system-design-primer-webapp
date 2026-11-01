# native_sampler.py: a top-k/top-p sampler in C++, bound to Python with pybind11 (chapter 3.2).
#
#  1. Builds a small C++ extension from the source below. PyTorch's cpp_extension.load_inline does the build: it
#     writes the files, runs the compiler through Ninja and imports the module. The code itself uses only
#     pybind11 and the C++ standard library; PyTorch is just the build tool here.
#  2. Shows that the C++ function reads the NumPy array in place (same memory address), refuses an array of the
#     wrong dtype, and silently copies a non-contiguous one unless told not to.
#  3. Checks the C++ filtering against a NumPy version, and the C++ sampling against the filtered probabilities.
#  4. Times NumPy and C++ on one thread, then on 4 threads, with the C++ code holding or releasing the GIL.
#
# Needs torch, numpy, ninja and a C++ compiler (Xcode's command line tools on a Mac, g++ on Linux).
# Run: python native_sampler.py      The first run compiles for about 10 seconds on an M2; later runs reuse the build.
import os
import platform
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from torch.utils.cpp_extension import load_inline

CPP = r"""
#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <optional>
#include <random>
#include <span>
#include <stdexcept>
#include <vector>

namespace py = pybind11;

// A C-contiguous float32 array. Without py::array::forcecast, pybind11 refuses a dtype that cannot be cast to float32
// safely (float64, int64) but silently copies one that can (float16, int16). It also copies a float32 array that is
// not contiguous, unless the argument is marked noconvert() (see the module below).
using Logits = py::array_t<float, py::array::c_style>;

// Temperature, then top-k, then top-p, the order Hugging Face's generate applies them. Fills `idx` and `p` with
// the kept token ids and their renormalised probabilities, most likely first.
static void filter_row(std::span<const float> x, int top_k, float top_p, float temperature,
                       std::vector<int32_t>& idx, std::vector<float>& p) {
  const int64_t vocab = static_cast<int64_t>(x.size());
  const int64_t k = (top_k > 0 && top_k < vocab) ? top_k : vocab;
  idx.resize(vocab);
  std::iota(idx.begin(), idx.end(), 0);
  auto higher = [&](int32_t a, int32_t b) { return x[a] > x[b]; };
  std::nth_element(idx.begin(), idx.begin() + (k - 1), idx.end(), higher);  // the k largest, unordered, O(vocab)
  idx.resize(k);
  std::sort(idx.begin(), idx.end(), higher);                                 // order only those k

  p.resize(k);
  const float top = x[idx[0]];
  double sum = 0;
  for (int64_t i = 0; i < k; ++i) sum += p[i] = std::exp((x[idx[i]] - top) / temperature);
  double cumulative = 0;
  int64_t keep = k;
  for (int64_t i = 0; i < k; ++i) {  // the smallest set of tokens whose probability reaches top_p
    cumulative += p[i] / sum;
    if (cumulative >= top_p) { keep = i + 1; break; }
  }
  idx.resize(keep);
  p.resize(keep);
  const double kept = std::accumulate(p.begin(), p.end(), 0.0);
  for (auto& v : p) v = static_cast<float>(v / kept);
}

// Samples one token per row. Runs without the GIL when release_gil is true: everything it touches inside the
// released region is plain C++ memory, never a Python object.
static py::array_t<int64_t> sample_impl(Logits logits, int top_k, float top_p, float temperature,
                                        uint64_t seed, bool release_gil) {
  if (logits.ndim() != 2) throw std::invalid_argument("logits must be 2-D (rows, vocab)");
  const int64_t rows = logits.shape(0), vocab = logits.shape(1);
  const float* data = logits.data();      // the NumPy array's own buffer, read in place
  std::vector<int64_t> out(rows);
  {
    std::optional<py::gil_scoped_release> no_gil;
    if (release_gil) no_gil.emplace();     // released here, reacquired when no_gil goes out of scope (RAII)
    std::vector<int32_t> idx;
    std::vector<float> p;
    for (int64_t r = 0; r < rows; ++r) {
      filter_row(std::span<const float>(data + r * vocab, vocab), top_k, top_p, temperature, idx, p);
      std::mt19937_64 rng(seed + r);
      const float u = std::uniform_real_distribution<float>(0.0f, 1.0f)(rng);
      float cumulative = 0;
      int64_t chosen = idx.back();
      for (size_t i = 0; i < idx.size(); ++i) {
        cumulative += p[i];
        if (u < cumulative) { chosen = idx[i]; break; }
      }
      out[r] = chosen;
    }
  }
  py::array_t<int64_t> result(rows);       // a new NumPy array, created with the GIL held
  std::copy(out.begin(), out.end(), result.mutable_data());
  return result;
}

// The filtered distribution as a dense (rows, vocab) array, for checking against NumPy.
static py::array_t<float> filtered_probs(Logits logits, int top_k, float top_p, float temperature) {
  const int64_t rows = logits.shape(0), vocab = logits.shape(1);
  py::array_t<float> result({rows, vocab});
  float* out = result.mutable_data();
  std::fill(out, out + rows * vocab, 0.0f);
  std::vector<int32_t> idx;
  std::vector<float> p;
  for (int64_t r = 0; r < rows; ++r) {
    filter_row(std::span<const float>(logits.data() + r * vocab, vocab), top_k, top_p, temperature, idx, p);
    for (size_t i = 0; i < idx.size(); ++i) out[r * vocab + idx[i]] = p[i];
  }
  return result;
}

PYBIND11_MODULE(native_sampler_ext, m) {
  m.def("sample", [](Logits l, int k, float p, float t, uint64_t s) { return sample_impl(l, k, p, t, s, true); },
        "Top-k/top-p sampling, one token per row, with the GIL released.");
  m.def("sample_holding_gil",
        [](Logits l, int k, float p, float t, uint64_t s) { return sample_impl(l, k, p, t, s, false); },
        "The same, but holding the GIL throughout.");
  m.def("filtered_probs", &filtered_probs);
  m.def("data_address", [](Logits l) { return reinterpret_cast<uintptr_t>(l.data()); },
        "The address of the first element the C++ code sees.");
  m.def("data_address_noconvert", [](Logits l) { return reinterpret_cast<uintptr_t>(l.data()); },
        py::arg("logits").noconvert(), "The same, but refusing any array that would need converting.");
}
"""

# ---------------------------------------------------------------------------------------------------------------
# 1. Build. load_inline prepends PyTorch's own header, which is the slow part of the compile.
print(f"{platform.machine()}, {platform.system()}, Python {platform.python_version()}, NumPy {np.__version__}, "
      f"{os.cpu_count()} CPU cores")
t0 = time.perf_counter()
ext = load_inline(name="native_sampler_ext", cpp_sources=CPP, extra_cflags=["-O3", "-std=c++20"], verbose=False)
print(f"1. Built (or loaded) the extension in {time.perf_counter() - t0:.1f} s")

# ---------------------------------------------------------------------------------------------------------------
# 2. Zero copy: the C++ code sees the NumPy array's own buffer.
VOCAB, ROWS = 128_256, 32                       # Llama 3's vocabulary; 32 sequences in a decode batch
rng = np.random.default_rng(0)
logits = (rng.standard_normal((ROWS, VOCAB)) * 3).astype(np.float32)
same = ext.data_address(logits) == logits.ctypes.data
print(f"\n2. Address seen by C++ equals the NumPy buffer's address: {same}")
try:
    ext.sample(logits.astype(np.float64), 50, 0.9, 1.0, 0)
except TypeError:
    print("   A float64 array is refused with a TypeError rather than silently converted into a copy")
view = logits[:, ::2]                           # every second column: float32, but not contiguous
print(f"   A strided view is accepted, but C++ sees a different address, so pybind11 made a contiguous copy: "
      f"{ext.data_address(view) != view.ctypes.data}")
try:
    ext.data_address_noconvert(view)
except TypeError:
    print("   With the argument marked noconvert(), the same view is refused with a TypeError")


# ---------------------------------------------------------------------------------------------------------------
# 3. Correctness against a NumPy version.
def numpy_filtered(x, top_k, top_p, temperature):
    """Temperature, top-k and top-p in NumPy, returning the dense filtered distribution."""
    x = x / temperature
    k = top_k if 0 < top_k < x.shape[1] else x.shape[1]
    top = np.argpartition(-x, k - 1, axis=1)[:, :k]                     # the k largest, unordered
    order = np.argsort(-np.take_along_axis(x, top, 1), axis=1, kind="stable")
    top = np.take_along_axis(top, order, 1)                             # most likely first
    vals = np.take_along_axis(x, top, 1)
    p = np.exp(vals - vals[:, :1])
    p /= p.sum(1, keepdims=True)
    cumulative = np.cumsum(p, 1)
    keep = (cumulative - p) < top_p                                     # tokens needed to reach top_p
    p = np.where(keep, p, 0)
    p /= p.sum(1, keepdims=True)
    out = np.zeros_like(x)
    np.put_along_axis(out, top, p, 1)
    return out


def numpy_sample(x, top_k, top_p, temperature, seed):
    p = numpy_filtered(x, top_k, top_p, temperature)
    u = np.random.default_rng(seed).random((x.shape[0], 1))
    return (np.cumsum(p, 1) < u).sum(1)


settings = (50, 0.9, 0.8)                       # top_k, top_p, temperature
diff = np.abs(ext.filtered_probs(logits, *settings) - numpy_filtered(logits, *settings)).max()
kept = (ext.filtered_probs(logits, *settings) > 0).sum(1)
print(f"\n3. Filtered distributions, C++ against NumPy: largest difference {diff:.1e}; "
      f"tokens kept per row {kept.min()} to {kept.max()} of the top 50")
row = np.repeat(logits[:1], 20_000, axis=0)     # one row, sampled 20,000 times with different seeds
counts = np.bincount(np.concatenate([ext.sample(row[i:i + 2000], *settings, i) for i in range(0, 20_000, 2000)]),
                     minlength=VOCAB) / 20_000
expected = ext.filtered_probs(logits[:1], *settings)[0]
print(f"   Sampling one row 20,000 times: sample frequencies differ from the probabilities by at most "
      f"{np.abs(counts - expected).max():.3f}; tokens outside the filtered set drawn: {(counts[expected == 0] > 0).sum()}")

# ---------------------------------------------------------------------------------------------------------------
# 4. Speed: one thread sampling all 4 batches in turn, then 4 threads each sampling one of them.
CALLS, THREADS = 40, 4
batches = [(rng.standard_normal((ROWS, VOCAB)) * 3).astype(np.float32) for _ in range(THREADS)]
versions = {
    "NumPy": lambda x, s: numpy_sample(x, *settings, s),
    "C++ holding the GIL": lambda x, s: ext.sample_holding_gil(x, *settings, s),
    "C++ releasing the GIL": lambda x, s: ext.sample(x, *settings, s),
}


def work(fn, x):
    for s in range(CALLS):
        fn(x, s)


print(f"\n4. Sampling a batch of {ROWS} rows of {VOCAB:,} logits (top-k 50, top-p 0.9, temperature 0.8), "
      f"{CALLS} calls per thread")
for name, fn in versions.items():
    work(fn, batches[0])                        # warm up
    t0 = time.perf_counter()
    for x in batches:                           # one thread does the same four batches the threads will share
        work(fn, x)
    one = (time.perf_counter() - t0) / (CALLS * THREADS)
    with ThreadPoolExecutor(THREADS) as pool:
        t0 = time.perf_counter()
        list(pool.map(lambda x: work(fn, x), batches))
        many = (time.perf_counter() - t0) / (CALLS * THREADS)
    print(f"   {name:<22} 1 thread: {one * 1e3:6.2f} ms per call   {THREADS} threads: {many * 1e3:6.2f} ms per call "
          f"({one / many:.1f}x the throughput)")
