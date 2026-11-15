// Chapter 7 lab: where the copies are. Every mode prints Buffer's counters (buffer.h) after each experiment.
//
//   ./moves copy-loop      a "forward pass" over 8 layers, written with auto and with const auto&
//   ./moves growth         1,000 push_backs into a vector, with a noexcept move, a throwing move, and reserve
//   ./moves returns        four ways to return a Buffer from a function
//   ./moves trap           moving a Layer (rule of zero) and a LoggedLayer (user-declared destructor)
//   ./moves sink           a constructor that takes its Buffer by value, called three ways, and a use after move
//   ./moves bench [MB]     the time to copy and to move one large Buffer (default 400 MB)
//
//   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build
#include <cstdio>
#include <cstdlib>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#include "buffer.h"
#include "scoped_timer.h"

namespace {

// Tells the compiler that something outside its view may read the memory p points to, so it must really perform
// the copies whose results reach here. Without it, an optimizer may notice that a copy is only read at one element
// and skip the rest. This is the trick benchmark libraries call DoNotOptimize; Chapter 14 explains it. GCC and Clang.
inline void escape(const void* p) { __asm__ __volatile__("" : : "g"(p) : "memory"); }

// ---------------------------------------------------------------------------------------------------------------
// copy-loop: the bug from the start of the chapter, on a small "model" of 8 layers of 16 MiB each.

float forward(const std::vector<Layer>& layers, bool by_value) {
  float x = 1.0f;
  if (by_value) {
    for (auto layer : layers) {  // copies every layer, every call
      escape(layer.weights.data());
      x += layer.weights.data()[0];
    }
  } else {
    for (const auto& layer : layers) {  // copies nothing
      escape(layer.weights.data());
      x += layer.weights.data()[0];
    }
  }
  return x;
}

void copy_loop() {
  constexpr std::size_t kLayerFloats = 4 * 1024 * 1024;  // 16 MiB of floats per layer
  std::vector<Layer> layers;
  layers.reserve(8);
  for (int i = 0; i < 8; ++i) layers.push_back(Layer{Buffer(kLayerFloats)});

  for (bool by_value : {true, false}) {
    reset_counters();
    float out = 0.0f;
    {
      ScopedTimer t(by_value ? "  10 steps, for (auto layer : layers)" : "  10 steps, for (const auto& layer : layers)");
      for (int step = 0; step < 10; ++step) out += forward(layers, by_value);
    }
    std::printf("  (result %.1f)\n", out);  // use the result, so the optimizer cannot drop the loop
    print_counters(by_value ? "auto layer" : "const auto& layer");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// growth: what a vector does with its elements when it runs out of room.

void growth() {
  constexpr int kCount = 1000;
  std::printf("  is_nothrow_move_constructible: Buffer %d, SlowBuffer %d\n", std::is_nothrow_move_constructible_v<Buffer>,
              std::is_nothrow_move_constructible_v<SlowBuffer>);

  reset_counters();
  {
    std::vector<Buffer> v;
    for (int i = 0; i < kCount; ++i) v.push_back(Buffer(16));
    std::printf("  final capacity %zu\n", v.capacity());
  }
  print_counters("vector<Buffer>, no reserve");

  reset_counters();
  {
    std::vector<SlowBuffer> v;
    for (int i = 0; i < kCount; ++i) v.push_back(SlowBuffer(16));
  }
  print_counters("vector<SlowBuffer>, no reserve");

  reset_counters();
  {
    std::vector<SlowBuffer> v;
    v.reserve(kCount);
    for (int i = 0; i < kCount; ++i) v.push_back(SlowBuffer(16));
  }
  print_counters("vector<SlowBuffer>, reserve first");

  reset_counters();
  {
    std::vector<Buffer> v;
    v.reserve(kCount);
    for (int i = 0; i < kCount; ++i) v.emplace_back(16);  // built in place from the argument 16
  }
  print_counters("vector<Buffer>, reserve + emplace");
}

// ---------------------------------------------------------------------------------------------------------------
// returns: four ways out of a function.

Buffer make_temporary(std::size_t n) {
  return Buffer(n);  // a prvalue: C++17 guarantees no copy and no move
}

Buffer make_named(std::size_t n) {
  Buffer b(n);
  b.data()[0] = 1.0f;
  return b;  // NRVO: allowed, not guaranteed, done by GCC and Clang in simple cases like this
}

Buffer make_moved(std::size_t n) {
  Buffer b(n);
  b.data()[0] = 1.0f;
  return std::move(b);  // the compiler warns: this std::move prevents NRVO, so it forces one move
}

Buffer make_either(std::size_t n, bool first) {
  Buffer a(n);
  Buffer b(n);
  if (first) return a;  // two candidates, so no NRVO; a returned local is treated as an rvalue, so it moves
  return b;
}

void returns() {
  reset_counters();
  { Buffer b = make_temporary(1024); }
  print_counters("return Buffer(n);");

  reset_counters();
  { Buffer b = make_named(1024); }
  print_counters("return b;");

  reset_counters();
  { Buffer b = make_moved(1024); }
  print_counters("return std::move(b);");

  reset_counters();
  { Buffer b = make_either(1024, std::getenv("PICK_B") == nullptr); }
  print_counters("if (...) return a; return b;");
}

// ---------------------------------------------------------------------------------------------------------------
// trap: a destructor that turns moves into copies.

void trap() {
  std::printf("  is_nothrow_move_constructible: Layer %d, LoggedLayer %d\n", std::is_nothrow_move_constructible_v<Layer>,
              std::is_nothrow_move_constructible_v<LoggedLayer>);

  Layer a{Buffer(1024 * 1024)};
  reset_counters();
  Layer a2 = std::move(a);
  print_counters("Layer b = std::move(a)");

  LoggedLayer l{Buffer(1024 * 1024)};
  reset_counters();
  LoggedLayer l2 = std::move(l);
  print_counters("LoggedLayer b = std::move(a)");
  std::printf("  after the move: a.weights.size() = %zu, l.weights.size() = %zu\n", a.weights.size(), l.weights.size());
  (void)a2;
  (void)l2;
}

// ---------------------------------------------------------------------------------------------------------------
// sink: a parameter taken by value and moved into place.

class Job {
 public:
  explicit Job(Buffer input) : input_(std::move(input)) {}
  std::size_t size() const { return input_.size(); }

 private:
  Buffer input_;
};

void sink() {
  Buffer prompt(1024);

  reset_counters();
  Job a(prompt);  // prompt is an lvalue: copied into the parameter, then moved into the member
  print_counters("Job a(prompt)");

  reset_counters();
  Job b(std::move(prompt));  // moved into the parameter, then moved into the member
  print_counters("Job b(std::move(prompt))");

  reset_counters();
  Job c(Buffer(1024));  // a prvalue initializes the parameter directly, then one move into the member
  print_counters("Job c(Buffer(1024))");

  // prompt has been moved from. This Buffer documents that a moved-from Buffer is empty, so this is defined,
  // but it is almost certainly not what the author of the next line wanted.
  std::printf("  prompt.size() after the move: %zu\n", prompt.size());
  (void)a.size();
  (void)b.size();
  (void)c.size();
}

// ---------------------------------------------------------------------------------------------------------------
// bench: what a copy costs, compared with a move.

void bench(long megabytes) {
  const std::size_t n = static_cast<std::size_t>(megabytes) * 1000 * 1000 / sizeof(float);
  std::printf("  one Buffer of %zu floats (%ld MB)\n", n, megabytes);
  Buffer big(n);
  big.data()[n - 1] = 42.0f;

  reset_counters();
  {
    ScopedTimer t("  copy");
    Buffer copy = big;
    escape(copy.data());
    std::printf("  copy's last element %.1f\n", copy.data()[n - 1]);
  }
  {
    Buffer target(n);  // already allocated and zeroed, so its pages are already mapped
    {
      ScopedTimer t("  copy into an existing Buffer of the same size");
      target = big;
      escape(target.data());
    }
    std::printf("  target's last element %.1f\n", target.data()[n - 1]);
  }
  {
    ScopedTimer t("  move");
    Buffer moved = std::move(big);
    escape(moved.data());
    std::printf("  moved's last element %.1f\n", moved.data()[n - 1]);
  }
  print_counters("bench");
}

}  // namespace

int main(int argc, char** argv) {
  std::string_view mode = argc > 1 ? argv[1] : "";
  if (mode == "copy-loop") copy_loop();
  else if (mode == "growth") growth();
  else if (mode == "returns") returns();
  else if (mode == "trap") trap();
  else if (mode == "sink") sink();
  else if (mode == "bench") bench(argc > 2 ? std::atol(argv[2]) : 400);
  else {
    std::fprintf(stderr, "usage: %s copy-loop | growth | returns | trap | sink | bench [MB]\n", argv[0]);
    return 1;
  }
  return 0;
}
