// Project A: latency summaries with nearest-rank percentiles, and the integer-only number formatting that keeps the
// C++ report byte-for-byte identical to the Python one.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace loga {

// p50, p95, p99 and p99.9, written in thousandths ("permille") so that every rank is computed with integers.
inline constexpr int kNumPercentiles = 4;
inline constexpr std::uint64_t kPermilles[kNumPercentiles] = {500, 950, 990, 999};

// All values are in microseconds. mean is rounded down to a whole microsecond.
struct LatencySummary {
  std::uint64_t count = 0;
  std::uint64_t mean = 0;
  std::uint64_t percentile[kNumPercentiles] = {};  // in the order of kPermilles
  std::uint64_t max = 0;
};

// How summarize() finds the percentiles: sort everything, or select only the ranks it needs.
enum class Method { Sort, Select };

// The 0-based index of the nearest-rank percentile in a sorted list of n values:
// ceil(permille * n / 1000) - 1, and never less than 0.
std::size_t rank_index(std::size_t n, std::uint64_t permille);

// Summarizes `values`, which must not be empty. It reorders `values` in place.
LatencySummary summarize(std::vector<std::uint32_t>& values, Method method);

// 1234567 microseconds -> "1234.567" (milliseconds, three decimals).
std::string format_ms(std::uint64_t us);

// count as a percentage of total, rounded down to three decimals: 970, 1000 -> "97.000%".
std::string format_share(std::uint64_t count, std::uint64_t total);

}  // namespace loga
