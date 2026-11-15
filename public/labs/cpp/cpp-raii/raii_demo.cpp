// Chapter 6 lab: classes and RAII.
//
//   ./build/raii_demo fds-leak          open a file 100,000 times with a raw FILE* and an early return that forgets fclose
//   ./build/raii_demo fds-raii          the same loop with the File class: the destructor always closes
//   ./build/raii_demo unwind            an exception travels up through three functions; watch the destructors run
//   ./build/raii_demo unwind-uncaught   the same exception with no catch anywhere
//   ./build/raii_demo exit              std::exit in the middle of a scope
//   ./build/raii_demo timer             ScopedTimer around matmuls of three sizes
//   ./build/raii_demo timer-bug         a ScopedTimer that was never given a name
//   ./build/raii_demo matrix            the Matrix class, const and non-const access
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>

#include "buffer.h"
#include "file.h"
#include "matrix.h"
#include "scoped_timer.h"

namespace {

const char* kInput = "raii_demo_input.txt";

void write_input() {
  File f(kInput, "w");
  std::fputs("# a header line\n1.5\n2.5\n", f.get());
}  // f closes here, so the data is flushed before anyone reads it

// Returns the first number in the file. Files that start with '#' have a header, and the early
// return for them forgets fclose: the classic leak on an error or special-case path.
float first_value_leaky(const char* path) {
  std::FILE* f = std::fopen(path, "r");
  if (f == nullptr) throw std::runtime_error(std::string("fopen failed: ") + std::strerror(errno));
  int c = std::fgetc(f);
  if (c == '#') return 0.0f;  // BUG: returns without fclose(f)
  float x = 0.0f;
  std::ungetc(c, f);
  if (std::fscanf(f, "%f", &x) != 1) x = 0.0f;
  std::fclose(f);
  return x;
}

// The same function with File. There is no fclose to forget.
float first_value_raii(const char* path) {
  File f(path, "r");
  int c = std::fgetc(f.get());
  if (c == '#') return 0.0f;  // f's destructor closes the file here
  float x = 0.0f;
  std::ungetc(c, f.get());
  if (std::fscanf(f.get(), "%f", &x) != 1) x = 0.0f;
  return x;  // and here
}

template <typename Fn>
void open_many(Fn fn, const char* name) {
  write_input();
  const int kCalls = 100'000;
  for (int i = 0; i < kCalls; ++i) {
    try {
      fn(kInput);
    } catch (const std::exception& e) {
      std::printf("%s: call %d failed: %s\n", name, i + 1, e.what());
      return;
    }
  }
  std::printf("%s: all %d calls succeeded\n", name, kCalls);
}

// Prints when it is acquired and released, like Chapter 3's Tracer.
struct Step {
  const char* what;
  explicit Step(const char* w) : what(w) { std::printf("  acquire %s\n", what); }
  ~Step() { std::printf("  release %s\n", what); }
  Step(const Step&) = delete;
  Step& operator=(const Step&) = delete;
};

std::mutex model_mutex;

void run_layer(int tokens) {
  Step scratch("scratch buffer");
  if (tokens > 4096) throw std::length_error("prompt longer than the context window");
  std::printf("  running the layer\n");
}

void handle_request(int tokens) {
  Step file("model file");
  std::lock_guard<std::mutex> lock(model_mutex);  // a real RAII lock, held until this function exits
  Step marker("lock (the lock_guard above is now held)");
  run_layer(tokens);
  std::printf("  request done\n");
}

void unwind(bool catch_it) {
  std::printf("handle_request(8192):\n");
  if (!catch_it) {
    handle_request(8192);  // nothing catches the exception: std::terminate
    return;
  }
  try {
    handle_request(8192);
  } catch (const std::exception& e) {
    std::printf("caught: %s\n", e.what());
  }
  // If the lock had not been released during unwinding, this would wait forever.
  std::lock_guard<std::mutex> again(model_mutex);
  std::printf("the mutex is free again\n");
}

Step global_step("a global (static storage)");

void exit_midway() {
  Step local("a local (automatic storage)");
  static Step in_function("a function-local static");
  std::printf("calling std::exit(0)\n");
  std::exit(0);
}

void timer() {
  ScopedTimer total("all three matmuls");
  for (std::size_t n : {128, 256, 512}) {
    Matrix a(n, n), b(n, n);
    a.fill(1.0f);
    b.fill(0.5f);
    std::string label = "matmul " + std::to_string(n);
    ScopedTimer t(label.c_str());
    Matrix c = matmul(a, b);
    // Use the result, so the optimizer cannot remove the work. Each element is n * 0.5.
    std::printf("%s: c(0,0) = %.1f\n", label.c_str(), c(0, 0));
  }  // t is destroyed before label, because it was declared later, so label is still valid when it prints
}

void timer_bug() {
  Matrix a(512, 512), b(512, 512);
  a.fill(1.0f);
  b.fill(0.5f);
  ScopedTimer("matmul 512, timed by a timer with no name");  // BUG: a temporary, destroyed at the semicolon
  Matrix c = matmul(a, b);
  std::printf("c(0,0) = %.1f\n", c(0, 0));
}

void print_corner(const Matrix& m) {
  // m is const here, so m(0, 0) calls the const operator(), which returns a value.
  std::printf("corner %.2f, sum %.2f\n", m(0, 0), m.sum());
}

void matrix_demo() {
  Matrix m(2, 3);
  m.fill(0.25f);
  m(0, 0) = 4.0f;  // the non-const operator() returns float&, so this assigns into the matrix
  print_corner(m);
  Buffer scores(1024);
  std::printf("Buffer of %zu floats at %p, first value %.1f\n", scores.size(), static_cast<void*>(scores.data()), scores.data()[0]);
}

int usage() {
  std::fprintf(stderr, "usage: raii_demo fds-leak|fds-raii|unwind|unwind-uncaught|exit|timer|timer-bug|matrix\n");
  return 2;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) return usage();
  std::string mode = argv[1];
  if (mode == "fds-leak") open_many(first_value_leaky, "leaky");
  else if (mode == "fds-raii") open_many(first_value_raii, "raii");
  else if (mode == "unwind") unwind(true);
  else if (mode == "unwind-uncaught") unwind(false);
  else if (mode == "exit") exit_midway();
  else if (mode == "timer") timer();
  else if (mode == "timer-bug") timer_bug();
  else if (mode == "matrix") matrix_demo();
  else return usage();
  return 0;
}
