// Project A: parsing one line of the access log. See log_parser.h for the format.
#include "log_parser.h"

#include <charconv>
#include <cstddef>
#include <system_error>

namespace loga {

namespace {

// A field of 1 to 20 ASCII digits whose value fits in 64 bits, the same rule as number() in analyze.py.
// std::from_chars reads digits until the first character that is not one; for an unsigned type it does not
// accept a sign, and it never skips spaces. ptr == end checks that the whole field was digits.
bool parse_number(std::string_view field, std::uint64_t& value) {
  if (field.empty() || field.size() > 20) return false;
  const char* end = field.data() + field.size();
  auto [ptr, ec] = std::from_chars(field.data(), end, value);
  return ec == std::errc{} && ptr == end;
}

}  // namespace

bool parse_line(std::string_view line, LogRecord& out) {
  std::string_view fields[5];
  std::size_t count = 0;
  std::size_t start = 0;
  // Split on single spaces. Each field is a view into `line`: nothing is copied.
  while (true) {
    std::size_t space = line.find(' ', start);
    if (count == 5) return false;  // a sixth field: too many
    if (space == std::string_view::npos) {
      fields[count++] = line.substr(start);
      break;
    }
    fields[count++] = line.substr(start, space - start);
    start = space + 1;
  }
  if (count != 5) return false;

  if (fields[1].empty() || !fields[2].starts_with('/')) return false;

  std::uint64_t timestamp = 0, status = 0, latency = 0;
  if (!parse_number(fields[0], timestamp) || !parse_number(fields[3], status) || !parse_number(fields[4], latency)) {
    return false;
  }
  if (status < 100 || status > 599 || latency > kMaxLatencyUs) return false;

  out.timestamp_ms = timestamp;
  out.method = fields[1];
  out.endpoint = fields[2];
  out.status = static_cast<int>(status);
  out.latency_us = static_cast<std::uint32_t>(latency);
  return true;
}

}  // namespace loga
