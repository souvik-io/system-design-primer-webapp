// Project A: latency summaries. See stats.h.
#include "stats.h"

#include <algorithm>

namespace loga {

std::size_t rank_index(std::size_t n, std::uint64_t permille) {
  // permille * n is computed in 64 bits. With a 32-bit int it would overflow above about 2.1 million values,
  // which is undefined behavior for a signed type (Chapter 5) and a wrong rank either way.
  std::uint64_t rank = (permille * n + 999) / 1000;
  if (rank == 0) rank = 1;
  return static_cast<std::size_t>(rank - 1);
}

LatencySummary summarize(std::vector<std::uint32_t>& values, Method method) {
  LatencySummary s;
  s.count = values.size();
  std::uint64_t sum = 0;  // a 32-bit sum would overflow after a few thousand slow requests
  for (std::uint32_t v : values) sum += v;
  s.mean = sum / s.count;

  if (method == Method::Sort) {
    // O(n log n): put every value in order, then read the ranks directly.
    std::sort(values.begin(), values.end());
    for (int i = 0; i < kNumPercentiles; ++i) s.percentile[i] = values[rank_index(values.size(), kPermilles[i])];
    s.max = values.back();
    return s;
  }

  // O(n) on average: std::nth_element puts the value that belongs at position nth there, with nothing larger
  // before it and nothing smaller after it. The ranks increase, so each search can start where the last one ended.
  auto first = values.begin();
  for (int i = 0; i < kNumPercentiles; ++i) {
    auto nth = values.begin() + static_cast<std::ptrdiff_t>(rank_index(values.size(), kPermilles[i]));
    std::nth_element(first, nth, values.end());
    s.percentile[i] = *nth;
    first = nth;
  }
  s.max = *std::max_element(first, values.end());
  return s;
}

namespace {

// 7 -> "007": the last three digits of a fixed-point number.
std::string three_digits(std::uint64_t v) {
  std::string digits = std::to_string(v % 1000);
  return std::string(3 - digits.size(), '0') + digits;
}

}  // namespace

std::string format_ms(std::uint64_t us) { return std::to_string(us / 1000) + "." + three_digits(us); }

std::string format_share(std::uint64_t count, std::uint64_t total) {
  std::uint64_t v = count * 100'000 / total;  // in thousandths of a percent
  return std::to_string(v / 1000) + "." + three_digits(v) + "%";
}

}  // namespace loga
