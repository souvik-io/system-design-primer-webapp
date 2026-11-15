// Project A: small checks for the parser and the percentile code.
//
//   cmake --build build && ./build/test_core       (or: ctest --test-dir build)
//
// CHECK is our own macro rather than assert(), because CMake's Release build defines NDEBUG, which turns every
// assert() into nothing. These checks run in every build type.
#include <cstdio>
#include <cstdlib>
#include <initializer_list>
#include <string>
#include <vector>

#include "log_parser.h"
#include "stats.h"

namespace {

int failures = 0;

#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) {                                                     \
      std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                      \
    }                                                                  \
  } while (0)

void test_parser() {
  loga::LogRecord r;
  CHECK(loga::parse_line("1763164800123 POST /v1/chat/completions 200 734211", r));
  CHECK(r.timestamp_ms == 1763164800123ULL);
  CHECK(r.method == "POST");
  CHECK(r.endpoint == "/v1/chat/completions");
  CHECK(r.status == 200);
  CHECK(r.latency_us == 734211);

  CHECK(!loga::parse_line("", r));                                       // empty line
  CHECK(!loga::parse_line("1763164800123 POST /v1/chat", r));            // truncated: three fields
  CHECK(!loga::parse_line("1 POST /x 200 5 extra", r));                  // six fields
  CHECK(!loga::parse_line("1 POST /x 200 5 ", r));                       // trailing space: an empty sixth field
  CHECK(!loga::parse_line("1 POST  /x 200 5", r));                       // two spaces: an empty field
  CHECK(!loga::parse_line("1 POST x 200 5", r));                         // endpoint without a leading slash
  CHECK(!loga::parse_line("1 POST /x 2O0 5", r));                        // letter O, not zero
  CHECK(!loga::parse_line("1 POST /x 200 -5", r));                       // a sign is not a digit
  CHECK(!loga::parse_line("1 POST /x 200 5\r", r));                      // a Windows line ending
  CHECK(!loga::parse_line("1 POST /x 99 5", r));                         // status below 100
  CHECK(!loga::parse_line("1 POST /x 200 3600000001", r));               // latency above one hour
  CHECK(!loga::parse_line("18446744073709551616 POST /x 200 5", r));     // 2^64 does not fit in 64 bits
  CHECK(loga::parse_line("18446744073709551615 POST /x 200 3600000000", r));  // the largest values allowed
}

void test_percentiles() {
  // Nearest rank on 1..10: p50 is the 5th value, p95, p99 and p99.9 are all the 10th.
  CHECK(loga::rank_index(10, 500) == 4);
  CHECK(loga::rank_index(10, 950) == 9);
  CHECK(loga::rank_index(1, 500) == 0);
  CHECK(loga::rank_index(1000, 990) == 989);
  CHECK(loga::rank_index(5'000'000, 999) == 4'994'999);  // would overflow if computed in a 32-bit int

  for (loga::Method m : {loga::Method::Sort, loga::Method::Select}) {
    std::vector<std::uint32_t> v = {7, 3, 10, 1, 9, 2, 8, 4, 6, 5};
    loga::LatencySummary s = loga::summarize(v, m);
    CHECK(s.count == 10);
    CHECK(s.mean == 5);  // 55 / 10, rounded down
    CHECK(s.percentile[0] == 5);
    CHECK(s.percentile[1] == 10);
    CHECK(s.percentile[2] == 10);
    CHECK(s.percentile[3] == 10);
    CHECK(s.max == 10);
  }
}

void test_formatting() {
  CHECK(loga::format_ms(1234567) == "1234.567");
  CHECK(loga::format_ms(7) == "0.007");
  CHECK(loga::format_ms(60000) == "60.000");
  CHECK(loga::format_share(970, 1000) == "97.000%");
  CHECK(loga::format_share(1, 3) == "33.333%");
}

}  // namespace

int main() {
  test_parser();
  test_percentiles();
  test_formatting();
  if (failures == 0) std::printf("all checks passed\n");
  return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
