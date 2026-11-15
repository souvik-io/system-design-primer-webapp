// Chapter 3 lab, part 3: what goes wrong with the stack and the heap. Run one mode at a time:
//
//   ./memory_demo heap-big       16 MiB of floats on the heap: fine
//   ./memory_demo stack-big      16 MiB of floats in one stack frame: crashes on a default 8 MiB stack
//   ./memory_demo leak           forgets delete[] on an early return, ten times
//   ./memory_demo dangling       keeps a pointer into a vector while the vector grows
//   ./memory_demo dangling-read  the same, and then reads through the stale pointer (undefined behavior)
//
// Build it in Debug, so the optimizer does not remove the work these functions do:
//   cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build
// and again with -DLAB_SANITIZE=ON to let AddressSanitizer explain each crash.
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <vector>

namespace {

constexpr std::size_t kFloats = 16 * 1024 * 1024 / sizeof(float);  // 16 MiB worth of floats: 4,194,304 of them

float heap_big() {
  std::vector<float> buf(kFloats);  // the vector object is on the stack, its 16 MiB of elements on the heap
  for (std::size_t i = 0; i < kFloats; ++i) buf[i] = static_cast<float>(i);
  return buf[kFloats - 1];
}

float stack_big() {
  float buf[kFloats];  // all 16 MiB in this function's stack frame
  for (std::size_t i = 0; i < kFloats; ++i) buf[i] = static_cast<float>(i);
  return buf[kFloats - 1];
}

// Sums n_tokens scores using a scratch buffer, but the early return skips the delete[].
float score(int n_tokens) {
  float* scratch = new float[1024 * 1024];  // 4 MiB
  if (n_tokens == 0) return 0.0f;           // the bug: this path never reaches delete[]
  float sum = 0.0f;
  for (int i = 0; i < n_tokens; ++i) {
    scratch[i] = static_cast<float>(i);
    sum += scratch[i];
  }
  delete[] scratch;
  return sum;
}

void dangling(bool read_it) {
  std::vector<float> cache;
  cache.push_back(1.0f);
  float* first = cache.data();  // a pointer into the vector's current heap block
  std::printf("data() before growing: %p\n", static_cast<void*>(first));
  for (int i = 0; i < 1000; ++i) cache.push_back(static_cast<float>(i));
  std::printf("data() after growing:  %p\n", static_cast<void*>(cache.data()));
  std::printf("the old pointer is %s\n", first == cache.data() ? "still valid" : "now dangling: its block was freed");
  if (read_it) std::printf("reading through it gives %f\n", *first);  // undefined behavior if the block moved
}

}  // namespace

int main(int argc, char** argv) {
  const char* mode = argc > 1 ? argv[1] : "";
  if (std::strcmp(mode, "heap-big") == 0) {
    std::printf("heap_big returned %.0f\n", heap_big());
  } else if (std::strcmp(mode, "stack-big") == 0) {
    std::printf("stack_big returned %.0f\n", stack_big());
  } else if (std::strcmp(mode, "leak") == 0) {
    float total = 0.0f;
    for (int i = 0; i < 10; ++i) total += score(0);
    std::printf("leak: 10 calls with no tokens, total %.0f, and 40 MiB never freed\n", total);
  } else if (std::strcmp(mode, "dangling") == 0) {
    dangling(false);
  } else if (std::strcmp(mode, "dangling-read") == 0) {
    dangling(true);
  } else {
    std::printf("usage: %s heap-big | stack-big | leak | dangling | dangling-read\n", argv[0]);
    return 1;
  }
  return 0;
}
