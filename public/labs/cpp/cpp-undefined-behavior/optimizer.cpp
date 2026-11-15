// Chapter 5 lab, part 2: the optimizer assumes your program has no undefined behavior.
//
//   ./optimizer 2147483647     the largest int
//   ./optimizer 5
//
// Build it in Debug and in Release and run both with the same argument:
//   cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build
//   cmake -S . -B build-rel -DCMAKE_BUILD_TYPE=Release && cmake --build build-rel
//
// The functions are marked noinline so that the compiler compiles each one on its own, without knowing the argument.
#include <climits>
#include <cstdio>
#include <cstdlib>

// For any x except INT_MAX this is plainly true. For INT_MAX, x + 1 overflows, which is undefined behavior, so the
// compiler may assume it never happens, and then the comparison is always true.
[[gnu::noinline]] bool next_is_bigger(int x) { return x + 1 > x; }

// The same question asked without overflowing: compare before adding.
[[gnu::noinline]] bool next_is_bigger_safe(int x) { return x < INT_MAX; }

// Counts how many times x can be doubled before it overflows. The loop condition x > 0 can only become false through
// overflow, so an optimizer may decide that it never does.
[[gnu::noinline]] int doublings(int x) {
  int n = 0;
  while (x > 0 && n < 100) {  // n < 100 is a safety net so that the program always ends
    x *= 2;                   // overflows once x passes 2^30
    ++n;
  }
  return n;
}

int main(int argc, char** argv) {
  const int x = argc > 1 ? std::atoi(argv[1]) : INT_MAX;
  std::printf("x = %d\n", x);
  std::printf("next_is_bigger(x)      = %s\n", next_is_bigger(x) ? "true" : "false");
  std::printf("next_is_bigger_safe(x) = %s\n", next_is_bigger_safe(x) ? "true" : "false");
  std::printf("doublings(x)           = %d\n", doublings(x));
  return 0;
}
