// Chapter 3 lab, part 2: sizeof, alignof, offsetof and padding.
//
//   c++ -std=c++20 -Wall -Wextra layout.cpp -o layout && ./layout
//
// The static_asserts below hold on every mainstream 64-bit platform (x86-64 Linux, macOS and Windows, and ARM64),
// where int64_t and double are 8-byte aligned. If one fails on your machine, that is a finding worth writing down.
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

// Per-block bookkeeping for a KV cache, with the members in the order someone thought of them.
struct BlockInfoAsWritten {
  bool in_use;
  std::int64_t seq_id;
  std::int32_t ref_count;
  bool on_gpu;
  double last_used;
  std::int32_t num_tokens;
};

// The same members, largest alignment first.
struct BlockInfoSorted {
  std::int64_t seq_id;
  double last_used;
  std::int32_t ref_count;
  std::int32_t num_tokens;
  bool in_use;
  bool on_gpu;
};

// The layout of llama.cpp's block_q4_0: a 16-bit scale (an fp16 value, kept here as raw bits) and 32 four-bit weights.
struct BlockQ4_0 {
  std::uint16_t d;
  std::uint8_t qs[16];
};

struct Empty {};

// A struct whose alignment is raised to 64 bytes, the cache-line size of most x86-64 processors.
struct alignas(64) PaddedCounter {
  std::int64_t value;
};

static_assert(sizeof(BlockInfoAsWritten) == 40);
static_assert(sizeof(BlockInfoSorted) == 32);
static_assert(sizeof(BlockQ4_0) == 18 && alignof(BlockQ4_0) == 2);
static_assert(sizeof(Empty) == 1);
static_assert(sizeof(PaddedCounter) == 64);

#define SHOW(T) std::printf("  %-22s sizeof %3zu  alignof %2zu\n", #T, sizeof(T), alignof(T))
#define OFFSET(T, m) std::printf("    %-12s offset %2zu  size %zu\n", #m, offsetof(T, m), sizeof(T::m))

int main() {
  std::printf("Built-in types\n");
  SHOW(bool);
  SHOW(char);
  SHOW(short);
  SHOW(int);
  SHOW(long);
  SHOW(long long);
  SHOW(float);
  SHOW(double);
  SHOW(long double);
  SHOW(void*);
  SHOW(std::max_align_t);

  std::printf("\nStandard library types (these differ between libstdc++ and libc++)\n");
  SHOW(std::vector<float>);
  SHOW(std::string);

  std::printf("\nStructs\n");
  SHOW(BlockInfoAsWritten);
  OFFSET(BlockInfoAsWritten, in_use);
  OFFSET(BlockInfoAsWritten, seq_id);
  OFFSET(BlockInfoAsWritten, ref_count);
  OFFSET(BlockInfoAsWritten, on_gpu);
  OFFSET(BlockInfoAsWritten, last_used);
  OFFSET(BlockInfoAsWritten, num_tokens);
  SHOW(BlockInfoSorted);
  OFFSET(BlockInfoSorted, seq_id);
  OFFSET(BlockInfoSorted, last_used);
  OFFSET(BlockInfoSorted, ref_count);
  OFFSET(BlockInfoSorted, num_tokens);
  OFFSET(BlockInfoSorted, in_use);
  OFFSET(BlockInfoSorted, on_gpu);
  SHOW(BlockQ4_0);
  SHOW(Empty);
  SHOW(PaddedCounter);

  // A short string is stored inside the std::string object itself, with no heap allocation.
  // capacity() of an empty string shows how many characters fit before the string needs the heap.
  std::printf("\nstd::string holds up to %zu characters without a heap allocation\n", std::string().capacity());

  // A million blocks of each layout.
  const double million = 1e6;
  std::printf("\nA million BlockInfoAsWritten: %.0f MB, a million BlockInfoSorted: %.0f MB\n", million * sizeof(BlockInfoAsWritten) / 1e6,
              million * sizeof(BlockInfoSorted) / 1e6);
  return 0;
}
