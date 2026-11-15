// Project A: the C++ log analyzer.
//
//   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
//   cmake --build build
//   ./build/log_analyzer big.log > report_cpp.txt
//   ./build/log_analyzer --sort big.log > report_cpp.txt   # percentiles by full sort instead of nth_element
//   diff report_py.txt report_cpp.txt                      # no output means the reports are identical
//
// The report goes to stdout and the timings to stderr, exactly like analyze.py.
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <initializer_list>
#include <iomanip>
#include <iostream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "log_parser.h"
#include "stats.h"

namespace {

struct EndpointRow {
  std::string name;
  loga::LatencySummary summary;
};

// The order of the endpoint rows: slowest p99 first, and by name when two p99s are equal, as in analyze.py.
// percentile[2] is p99 (kPermilles is {500, 950, 990, 999}).
bool slower_first(const EndpointRow& a, const EndpointRow& b) {
  if (a.summary.percentile[2] != b.summary.percentile[2]) return a.summary.percentile[2] > b.summary.percentile[2];
  return a.name < b.name;
}

void print_row(const std::string& name, const loga::LatencySummary& s) {
  std::cout << std::left << std::setw(24) << name << std::right << std::setw(10) << s.count << std::setw(12)
            << loga::format_ms(s.mean);
  for (int i = 0; i < loga::kNumPercentiles; ++i) std::cout << std::setw(12) << loga::format_ms(s.percentile[i]);
  std::cout << std::setw(12) << loga::format_ms(s.max) << '\n';
}

double seconds_since(std::chrono::steady_clock::time_point start) {
  return std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
}

}  // namespace

int main(int argc, char** argv) {
  loga::Method method = loga::Method::Select;
  const char* path = nullptr;
  for (int i = 1; i < argc; ++i) {
    std::string_view arg = argv[i];
    if (arg == "--sort") {
      method = loga::Method::Sort;
    } else if (path == nullptr) {
      path = argv[i];
    } else {
      path = nullptr;  // two file names: print the usage line below
      break;
    }
  }
  if (path == nullptr) {
    std::fprintf(stderr, "usage: %s [--sort] <log file>\n", argv[0]);
    return 1;
  }

  const auto t0 = std::chrono::steady_clock::now();
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    std::fprintf(stderr, "cannot open %s\n", path);
    return 1;
  }

  std::uint64_t lines = 0, malformed = 0;
  std::unordered_map<int, std::uint64_t> by_status;
  std::unordered_map<std::string, std::vector<std::uint32_t>> by_endpoint;
  std::vector<std::uint32_t> all_latencies;
  std::string line;  // reused for every line, so its buffer is allocated once and then grows only if needed
  std::string key;   // reused too: assign() copies the endpoint into the existing buffer

  while (std::getline(in, line)) {
    ++lines;
    loga::LogRecord record;
    if (!loga::parse_line(line, record)) {
      ++malformed;
      continue;
    }
    ++by_status[record.status];  // operator[] inserts a zero the first time a status is seen
    all_latencies.push_back(record.latency_us);
    // record.endpoint points into `line`, which the next getline overwrites, so the map must own a copy of it.
    // Using the view itself as the key would leave every key dangling.
    key.assign(record.endpoint);
    by_endpoint[key].push_back(record.latency_us);
  }
  const double parse_seconds = seconds_since(t0);

  const auto t1 = std::chrono::steady_clock::now();
  const std::uint64_t requests = all_latencies.size();
  std::cout << "lines read: " << lines << '\n';
  std::cout << "malformed lines: " << malformed << '\n';
  std::cout << "valid requests: " << requests << '\n';
  if (requests > 0) {
    // Status codes, in increasing order. An unordered_map has no useful order, so copy it out and sort.
    std::vector<std::pair<int, std::uint64_t>> statuses(by_status.begin(), by_status.end());
    std::sort(statuses.begin(), statuses.end());
    std::cout << '\n' << std::left << std::setw(8) << "status" << std::right << std::setw(12) << "count" << std::setw(10) << "share" << '\n';
    for (const auto& [status, count] : statuses) {
      std::cout << std::left << std::setw(8) << status << std::right << std::setw(12) << count << std::setw(10)
                << loga::format_share(count, requests) << '\n';
    }

    const loga::LatencySummary all = loga::summarize(all_latencies, method);
    std::vector<EndpointRow> rows;
    for (auto& [name, values] : by_endpoint) rows.push_back({name, loga::summarize(values, method)});
    std::sort(rows.begin(), rows.end(), slower_first);

    std::cout << "\nlatency in ms, nearest-rank percentiles, endpoints by p99, slowest first\n";
    std::cout << std::left << std::setw(24) << "endpoint" << std::right << std::setw(10) << "count";
    for (const char* h : {"mean", "p50", "p95", "p99", "p99.9", "max"}) std::cout << std::setw(12) << h;
    std::cout << '\n';
    print_row("(all)", all);
    for (const EndpointRow& row : rows) print_row(row.name, row.summary);
  }
  std::cout.flush();
  std::fprintf(stderr, "read and parse: %.3f s, summarize and format: %.3f s\n", parse_seconds, seconds_since(t1));
  return 0;
}
