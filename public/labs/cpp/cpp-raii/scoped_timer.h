// ScopedTimer: prints how long a block of code took, when the block ends.
// Chapter 6 builds it; later chapters reuse it. Header-only, so copy it into any project.
//
//   {
//     ScopedTimer t("load weights");
//     load_weights();
//   }   // prints "load weights: 12.345 ms" to stderr here
#pragma once

#include <chrono>
#include <cstdio>

// [[nodiscard]] on the class asks the compiler to warn about ScopedTimer("label"); with no variable name,
// a temporary that is destroyed at the semicolon and so times nothing.
class [[nodiscard]] ScopedTimer {
 public:
  explicit ScopedTimer(const char* label) : label_(label), start_(std::chrono::steady_clock::now()) {}

  ~ScopedTimer() {
    auto elapsed = std::chrono::steady_clock::now() - start_;
    std::fprintf(stderr, "%s: %.3f ms\n", label_, std::chrono::duration<double, std::milli>(elapsed).count());
  }

  // One timer measures one interval, so copying it makes no sense.
  ScopedTimer(const ScopedTimer&) = delete;
  ScopedTimer& operator=(const ScopedTimer&) = delete;

 private:
  const char* label_;
  std::chrono::steady_clock::time_point start_;  // steady_clock never jumps, unlike the wall clock
};
