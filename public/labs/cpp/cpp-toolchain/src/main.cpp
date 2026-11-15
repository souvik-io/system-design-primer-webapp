// Computes the cosine similarity of two "embeddings" of a million floats, 100 times, and times it.
#include <chrono>
#include <cstddef>
#include <cstdio>
#include <vector>

#include "tinymath/vec.h"

int main() {
  const std::size_t n = 1'000'000;
  std::vector<float> a(n);
  std::vector<float> b(n);
  for (std::size_t i = 0; i < n; ++i) {
    a[i] = static_cast<float>(i % 100) / 100.0f;
    b[i] = static_cast<float>((i * 7) % 100) / 100.0f;
  }

  const int reps = 100;
  const auto start = std::chrono::steady_clock::now();
  float total = 0.0f;
  for (int r = 0; r < reps; ++r) total += tinymath::cosine_similarity(a, b);
  const auto stop = std::chrono::steady_clock::now();
  const double ms = std::chrono::duration<double, std::milli>(stop - start).count();

  std::printf("cosine similarity: %.6f\n", total / reps);
  std::printf("%d calls took %.1f ms\n", reps, ms);
#ifdef NDEBUG
  std::printf("NDEBUG is defined, so assert() is switched off\n");
#else
  std::printf("NDEBUG is not defined, so assert() is checked\n");
#endif
  return 0;
}
