// Chapter 5 lab, part 1: a zoo of undefined behavior. Each mode commits one bug. Run one mode at a time:
//
//   ./ub_zoo row-means     reads one float past the end of each row: plausible but wrong averages
//   ./ub_zoo stack-oob     increments hist[4] in an array of four counters
//   ./ub_zoo dangling-view keeps a std::string_view into a std::string that has been destroyed
//   ./ub_zoo double-free   calls delete[] twice on the same pointer
//   ./ub_zoo uninit        adds numbers to a float that was never initialized
//   ./ub_zoo overflow      computes a logits offset that overflows a 32-bit int
//   ./ub_zoo misaligned    reads a float from a byte buffer at an address that is not a multiple of 4
//   ./ub_zoo at            the same out-of-bounds index as row-means, through std::vector::at()
//
// Build it twice and compare what each build says about each mode:
//   cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build
//   cmake -S . -B build-san -DCMAKE_BUILD_TYPE=Debug -DLAB_SANITIZE=ON && cmake --build build-san
//
// The bugs are deliberate, and some of them depend on values read from the command line so that the compiler cannot
// see them at compile time and refuse to build, or quietly delete the code.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

// A 3 x 4 matrix of activations, stored row by row in one buffer, as a tensor would be.
constexpr int kRows = 3;
constexpr int kCols = 4;

std::vector<float> make_matrix() {
  std::vector<float> m(kRows * kCols);
  for (int i = 0; i < kRows * kCols; ++i) m[i] = static_cast<float>(i + 1);  // 1, 2, ..., 12
  return m;
}

// The bug: <= instead of <, so each row reads one element past its end. For rows 0 and 1, that element is the first
// element of the next row, still inside the buffer. For the last row, it is past the end of the whole buffer.
void row_means() {
  std::vector<float> m = make_matrix();
  const float* data = m.data();  // raw pointer access, the way a kernel would see it
  for (int r = 0; r < kRows; ++r) {
    float sum = 0.0f;
    for (int c = 0; c <= kCols; ++c) sum += data[r * kCols + c];
    std::printf("row %d mean %.2f (correct: %.2f)\n", r, sum / kCols, (r * kCols * 2 + kCols + 1) / 2.0);
  }
}

// The same off-by-one, through std::vector::at(), which checks the index and throws.
void at_checked() {
  std::vector<float> m = make_matrix();
  try {
    for (int r = 0; r < kRows; ++r) {
      float sum = 0.0f;
      for (int c = 0; c <= kCols; ++c) sum += m.at(r * kCols + c);
      std::printf("row %d mean %.2f\n", r, sum / kCols);
    }
  } catch (const std::out_of_range& e) {
    std::printf("caught std::out_of_range: %s\n", e.what());
  }
}

// A histogram of token lengths in four buckets; bucket comes from the command line, so 4 is one past the end.
void stack_oob(int bucket) {
  int hist[4] = {0, 0, 0, 0};
  hist[bucket] += 1;
  std::printf("hist = {%d, %d, %d, %d}\n", hist[0], hist[1], hist[2], hist[3]);
}

std::string make_prompt() {
  // Long enough that the characters live on the heap rather than inside the string object (see chapter 3).
  return "You are a helpful assistant. Answer in one short sentence.";
}

void dangling_view() {
  std::string_view view = make_prompt();  // the temporary std::string dies at the end of this statement
  std::printf("first character: %c\n", view[0]);  // reads characters that were freed
}

void double_free() {
  float* scratch = new float[16];
  scratch[0] = 1.0f;
  delete[] scratch;
  std::printf("freed once\n");
  delete[] scratch;  // the bug: the same pointer again
  std::printf("freed twice\n");
}

void uninit(int n) {
  float sum;  // the bug: no initializer
  for (int i = 0; i < n; ++i) sum += 1.0f;
  std::printf("sum of %d ones: %f\n", n, sum);
}

// The offset of the last logit in a [batch, seq, vocab] tensor, computed in 32-bit int.
void overflow(int batch) {
  const int seq = 2048;
  const int vocab = 128256;  // Llama 3's vocabulary size
  int last = batch * seq * vocab - 1;  // overflows when batch * seq * vocab > 2,147,483,647
  std::int64_t last64 = static_cast<std::int64_t>(batch) * seq * vocab - 1;
  std::printf("batch %d: int offset %d, int64 offset %lld\n", batch, last, static_cast<long long>(last64));
}

// A float stored in a byte buffer at offset 1, as it might be in a binary file with a 1-byte header field.
void misaligned(int offset) {
  alignas(4) unsigned char buf[16] = {};
  const float value = 3.5f;
  std::memcpy(buf + offset, &value, sizeof value);  // copying bytes is always fine
  const float* p = reinterpret_cast<const float*>(buf + offset);
  std::printf("read through a cast pointer: %f\n", *p);  // the bug: a float load from an address that is not 4-aligned
  float safe;
  std::memcpy(&safe, buf + offset, sizeof safe);  // the fix: copy the bytes into a real float
  std::printf("read with memcpy:            %f\n", safe);
}

}  // namespace

int main(int argc, char** argv) {
  const char* mode = argc > 1 ? argv[1] : "";
  // Values that come from the command line, so the compiler cannot know them in advance.
  const int arg = argc > 2 ? std::atoi(argv[2]) : -1;

  if (std::strcmp(mode, "row-means") == 0) {
    row_means();
  } else if (std::strcmp(mode, "at") == 0) {
    at_checked();
  } else if (std::strcmp(mode, "stack-oob") == 0) {
    stack_oob(arg >= 0 ? arg : 4);
  } else if (std::strcmp(mode, "dangling-view") == 0) {
    dangling_view();
  } else if (std::strcmp(mode, "double-free") == 0) {
    double_free();
  } else if (std::strcmp(mode, "uninit") == 0) {
    uninit(arg >= 0 ? arg : 10);
  } else if (std::strcmp(mode, "overflow") == 0) {
    overflow(arg >= 0 ? arg : 16);
  } else if (std::strcmp(mode, "misaligned") == 0) {
    misaligned(arg >= 0 ? arg : 1);
  } else {
    std::printf("usage: %s row-means | at | stack-oob [bucket] | dangling-view | double-free | uninit [n] | overflow [batch] | misaligned [offset]\n",
                argv[0]);
    return 1;
  }
  return 0;
}
