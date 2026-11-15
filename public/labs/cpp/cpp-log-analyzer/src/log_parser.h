// Project A: parsing one line of the access log.
//
// A valid line has exactly five fields separated by single spaces:
//   <timestamp ms> <method> <endpoint> <status> <latency us>
//   1763164800123 POST /v1/chat/completions 200 734211
// The rules for "valid" match parse_line() in analyze.py exactly, so both analyzers skip the same lines.
#pragma once

#include <cstdint>
#include <string_view>

namespace loga {

// The largest latency we accept: one hour in microseconds. It fits in a std::uint32_t (at most 4,294,967,295),
// so the analyzer can store each latency in 4 bytes instead of 8.
inline constexpr std::uint64_t kMaxLatencyUs = 3'600'000'000;

// The fields of one parsed line. method and endpoint are views into the caller's line buffer: they are valid only
// until that buffer changes, which in the main loop means until the next std::getline.
struct LogRecord {
  std::uint64_t timestamp_ms = 0;
  std::string_view method;
  std::string_view endpoint;
  int status = 0;
  std::uint32_t latency_us = 0;
};

// Parses one line without its trailing newline. Returns true and fills `out` if the line is valid.
bool parse_line(std::string_view line, LogRecord& out);

}  // namespace loga
