// Chapter 4: pointers, references, arrays and const, as numbered experiments that match the chapter.
//
//   c++ -std=c++20 -Wall -Wextra pointers.cpp -o pointers && ./pointers
//
// The addresses it prints change from run to run, because the operating system places the stack and the heap at
// random addresses each time a program starts (address space layout randomization). Distances between addresses
// inside one array do not change.
//
// Experiment 4 makes the compiler warn on purpose: sizeof on an array parameter measures a pointer.
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <span>
#include <vector>

namespace {

// 4. An array parameter is really a pointer parameter: the compiler reads "const float a[]" as "const float* a".
std::size_t size_inside(const float a[]) {
  return sizeof(a);  // the size of a pointer, not of the array
}

// 6. Changes the caller's vector through a non-const reference.
void scale(std::vector<float>& v, float s) {
  for (float& x : v) x *= s;
}

// 7. A pointer and a length, the shape of every C, BLAS and CUDA interface. const float* means read only.
float sum(const float* data, std::size_t n) {
  float total = 0.0f;
  for (std::size_t i = 0; i < n; ++i) total += data[i];
  return total;
}

// 8. The same function with std::span, which carries the pointer and the length together.
float sum_span(std::span<const float> xs) {
  float total = 0.0f;
  for (float x : xs) total += x;
  return total;
}

}  // namespace

int main() {
  // 1. & takes an address and * follows one.
  int x = 42;
  int* p = &x;
  std::printf("1. x = %d, &x = %p, p = %p, *p = %d\n", x, static_cast<void*>(&x), static_cast<void*>(p), *p);
  *p = 7;
  std::printf("   after *p = 7, x = %d\n", x);

  // 2. Every object pointer is the same size, whatever it points at.
  std::printf("2. sizeof(char*) = %zu, sizeof(int*) = %zu, sizeof(double*) = %zu\n", sizeof(char*), sizeof(int*), sizeof(double*));

  // 3. Pointer arithmetic counts whole elements, not bytes.
  float a[4] = {1.0f, 2.0f, 3.0f, 4.0f};
  float* first = a;          // the array decays to a pointer to its first element
  float* third = first + 2;  // two elements on
  const auto bytes = reinterpret_cast<std::uintptr_t>(third) - reinterpret_cast<std::uintptr_t>(first);
  std::printf("3. *third = %.1f, third - first = %td elements, %llu bytes apart\n", *third, third - first,
              static_cast<unsigned long long>(bytes));
  std::printf("   a[2] = %.1f and *(a + 2) = %.1f are the same expression\n", a[2], *(a + 2));

  // 4. sizeof sees the whole array here, but only a pointer inside the function.
  std::printf("4. sizeof(a) in main = %zu bytes, inside size_inside = %zu bytes\n", sizeof(a), size_inside(a));

  // 5. std::array does not decay and knows its own size.
  std::array<float, 4> arr = {1.0f, 2.0f, 3.0f, 4.0f};
  std::printf("5. std::array<float, 4>: size() = %zu, sizeof = %zu bytes\n", arr.size(), sizeof(arr));

  // 6. A reference is another name for an object. Assigning through it changes that object.
  int y = 100;
  int& r = x;
  r = y;  // copies 100 into x; r still refers to x, not to y
  std::printf("6. after r = y: x = %d, and &r == &x is %d\n", x, &r == &x);
  std::vector<float> v = {1.0f, 2.0f, 3.0f};
  scale(v, 10.0f);
  std::printf("   after scale(v, 10): v = {%.0f, %.0f, %.0f}\n", v[0], v[1], v[2]);

  // 7 and 8. A pointer and a length, then a span.
  std::printf("7. sum(v.data(), v.size()) = %.0f\n", sum(v.data(), v.size()));
  std::printf("8. sum_span(v) = %.0f, sum of the first two = %.0f\n", sum_span(v), sum_span(std::span<const float>(v).first(2)));

  // 9. const in each position. Remove the // from a line marked "error" to watch the compiler refuse it.
  float value = 1.0f;
  float other = 2.0f;
  const float* read_only = &value;   // pointer to const float: the float cannot be changed through it
  read_only = &other;                // fine: the pointer itself may move
  // *read_only = 3.0f;              // error: the float is read only through this pointer
  float* const fixed = &value;       // const pointer to float: the float may change, the pointer may not
  *fixed = 3.0f;                     // fine
  // fixed = &other;                 // error: the pointer is const
  const float* const both = &value;  // neither may change
  std::printf("9. *read_only = %.1f, *fixed = %.1f, *both = %.1f\n", *read_only, *fixed, *both);

  // 10. nullptr means "points at nothing". Test for it before dereferencing.
  const int* nothing = nullptr;
  if (nothing == nullptr) std::printf("10. nothing is null, so the program does not dereference it\n");

  // 11. A pointer into a vector goes stale when the vector moves its elements to a bigger block.
  std::vector<int> grow = {1, 2, 3};
  const auto before = reinterpret_cast<std::uintptr_t>(grow.data());
  grow.reserve(grow.capacity() * 2 + 1);  // asking for more than the capacity forces a new block
  const auto after = reinterpret_cast<std::uintptr_t>(grow.data());
  std::printf("11. data() moved after reserve: %s, so any pointer taken before is now dangling\n", before == after ? "no" : "yes");
  return 0;
}
