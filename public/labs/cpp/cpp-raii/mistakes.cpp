// Chapter 6 lab, part 4: four mistakes the compiler catches for you.
// Pick one with -DLAB_MISTAKE=1 (2, 3 or 4) and read what the compiler says.
//
//   cmake -S . -B build-m -DLAB_MISTAKE=1 && cmake --build build-m
//
//   1  copying a File, whose copy constructor is deleted          an error
//   2  calling a non-const member function on a const Matrix      an error
//   3  passing an int where an explicit constructor is needed     an error
//   4  member initializers that read members not yet initialized  warnings only: it compiles and is wrong
#include <cstdio>
#include <vector>

#include "buffer.h"
#include "file.h"
#include "matrix.h"

#ifndef MISTAKE
#define MISTAKE 1
#endif

void report(const Buffer& b) { std::printf("%zu floats\n", b.size()); }

// Mistake 4: data_ is declared first, so it is initialized first, before rows_ and cols_ hold anything.
// The order of the initializer list below does not matter; the order of the declarations does.
class BadMatrix {
 public:
  BadMatrix(std::size_t rows, std::size_t cols) : rows_(rows), cols_(cols), data_(rows_ * cols_) {}
  std::size_t size() const { return data_.size(); }

 private:
  std::vector<float> data_;
  std::size_t rows_;
  std::size_t cols_;
};

int main() {
#if MISTAKE == 1
  File a("mistakes_tmp.txt", "w");
  File b = a;  // error: the copy constructor of File is deleted
#elif MISTAKE == 2
  const Matrix m(2, 2);
  m.fill(1.0f);  // error: fill is not a const member function
#elif MISTAKE == 3
  report(1024);  // error: Buffer(std::size_t) is explicit, so an int does not silently become a Buffer
#elif MISTAKE == 4
  BadMatrix m(64, 64);
  std::printf("BadMatrix(64, 64) holds %zu floats (it should be 4096)\n", m.size());
#endif
  return 0;
}
