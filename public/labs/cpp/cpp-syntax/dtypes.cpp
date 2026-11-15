// Chapter 2 lab: a dtype enum, the memory a model needs in each dtype, symmetric int8 quantization,
// and two signed 4-bit values packed into one byte.
//
//   c++ -std=c++20 -Wall -Wextra dtypes.cpp -o dtypes && ./dtypes
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <initializer_list>
#include <utility>
#include <vector>

namespace lab {

// enum class keeps the names inside DType (you write DType::F16) and never converts to int by itself.
// ": std::uint8_t" makes each value take one byte, which matters when a tensor header stores it.
enum class DType : std::uint8_t { F32, F16, BF16, I8, I4 };

// Bits per element. Remove a case and compile with -Wall to see the compiler point out the missing enumerator.
constexpr int bits_of(DType t) {
  switch (t) {
    case DType::F32:
      return 32;
    case DType::F16:
    case DType::BF16:  // an empty case falls through to the next one on purpose
      return 16;
    case DType::I8:
      return 8;
    case DType::I4:
      return 4;
  }
  return 0;  // not reached while every enumerator has a case above
}

constexpr const char* name_of(DType t) {
  switch (t) {
    case DType::F32:
      return "f32";
    case DType::F16:
      return "f16";
    case DType::BF16:
      return "bf16";
    case DType::I8:
      return "i8";
    case DType::I4:
      return "i4";
  }
  return "?";
}

// Bytes needed to store n elements. Adding 7 before dividing by 8 rounds a half-filled byte up.
constexpr std::int64_t bytes_for(DType t, std::int64_t n) { return (n * bits_of(t) + 7) / 8; }

// Symmetric int8 quantization with one scale for the whole vector: q = round(x / scale), kept in [-127, 127].
std::pair<std::vector<std::int8_t>, float> quantize_i8(const std::vector<float>& x) {
  float max_abs = 0.0f;
  for (float v : x) max_abs = std::max(max_abs, std::fabs(v));
  const float scale = max_abs > 0.0f ? max_abs / 127.0f : 1.0f;

  std::vector<std::int8_t> q;
  q.reserve(x.size());
  for (float v : x) {
    const long r = std::lround(v / scale);                              // round to the nearest integer
    q.push_back(static_cast<std::int8_t>(std::clamp(r, -127L, 127L)));  // clamp before narrowing
  }
  return {q, scale};
}

std::vector<float> dequantize_i8(const std::vector<std::int8_t>& q, float scale) {
  std::vector<float> x;
  x.reserve(q.size());
  for (std::int8_t v : q) x.push_back(static_cast<float>(v) * scale);
  return x;
}

// Two signed 4-bit values in [-8, 7] share one byte: lo in bits 0 to 3, hi in bits 4 to 7.
// & 0x0F keeps the low four bits of each value's two's complement form.
constexpr std::uint8_t pack_i4(int lo, int hi) { return static_cast<std::uint8_t>((lo & 0x0F) | ((hi & 0x0F) << 4)); }

// A 4-bit pattern from 8 to 15 stands for a negative number from -8 to -1.
constexpr int sign_extend4(int nibble) { return nibble >= 8 ? nibble - 16 : nibble; }

constexpr std::pair<int, int> unpack_i4(std::uint8_t byte) { return {sign_extend4(byte & 0x0F), sign_extend4(byte >> 4)}; }

}  // namespace lab

// Tests that run while compiling: if one fails, the program does not build.
static_assert(lab::bits_of(lab::DType::BF16) == 16);
static_assert(lab::bytes_for(lab::DType::I4, 3) == 2);  // three 4-bit values need one and a half bytes, rounded up
static_assert(lab::pack_i4(-1, 1) == 0x1F);
static_assert(lab::unpack_i4(lab::pack_i4(-3, 7)) == std::pair{-3, 7});

int main() {
  using lab::DType;

  // The weights of a 7-billion-parameter model in each dtype.
  constexpr std::int64_t params = 7'000'000'000;
  std::printf("Weights of a 7B-parameter model\n");
  for (DType t : {DType::F32, DType::F16, DType::BF16, DType::I8, DType::I4}) {
    const double gb = static_cast<double>(lab::bytes_for(t, params)) / 1e9;
    std::printf("  %-5s %2d bits  %5.1f GB\n", lab::name_of(t), lab::bits_of(t), gb);
  }

  // Quantize six weights to int8, restore them, and look at the error.
  const std::vector<float> w = {0.12f, -0.50f, 0.33f, 0.01f, -0.27f, 0.49f};
  const auto [q, scale] = lab::quantize_i8(w);
  const std::vector<float> back = lab::dequantize_i8(q, scale);
  std::printf("\nint8 quantization, scale = %.9f\n", scale);
  std::printf("  %8s %6s %10s %10s\n", "weight", "int8", "restored", "error");
  for (std::size_t i = 0; i < w.size(); ++i) {
    std::printf("  %8.4f %6d %10.6f %10.6f\n", w[i], static_cast<int>(q[i]), back[i], back[i] - w[i]);
  }

  // Pack and unpack every pair of 4-bit values and count the round trips that fail.
  int failures = 0;
  for (int lo = -8; lo <= 7; ++lo) {
    for (int hi = -8; hi <= 7; ++hi) {
      if (lab::unpack_i4(lab::pack_i4(lo, hi)) != std::pair{lo, hi}) ++failures;
    }
  }
  std::printf("\nint4 round trip: %d failures out of 256 pairs\n", failures);
  return failures == 0 ? 0 : 1;
}
