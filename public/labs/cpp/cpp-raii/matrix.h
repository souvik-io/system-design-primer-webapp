// Matrix: a row-major matrix of floats, written as a class.
// Its invariant is data_.size() == rows_ * cols_. The members are private, so only the class's own
// functions can break that, and none of them do.
#pragma once

#include <cstddef>
#include <stdexcept>
#include <vector>

class Matrix {
 public:
  Matrix(std::size_t rows, std::size_t cols) : rows_(rows), cols_(cols), data_(rows * cols, 0.0f) {}

  std::size_t rows() const { return rows_; }
  std::size_t cols() const { return cols_; }

  // Two versions of element access. The non-const one returns a reference you can assign through;
  // the const one is chosen for a const Matrix and returns a copy of the value.
  float& operator()(std::size_t r, std::size_t c) { return data_[r * cols_ + c]; }
  float operator()(std::size_t r, std::size_t c) const { return data_[r * cols_ + c]; }

  void fill(float value) {
    for (float& x : data_) x = value;
  }

  float sum() const {
    float s = 0.0f;
    for (float x : data_) s += x;
    return s;
  }

 private:
  std::size_t rows_;
  std::size_t cols_;
  std::vector<float> data_;  // owns the elements: no destructor needed in Matrix itself
};

// The naive matmul from Chapter 4, now on Matrix objects.
inline Matrix matmul(const Matrix& a, const Matrix& b) {
  if (a.cols() != b.rows()) throw std::invalid_argument("matmul: inner dimensions differ");
  Matrix c(a.rows(), b.cols());
  for (std::size_t i = 0; i < a.rows(); ++i)
    for (std::size_t j = 0; j < b.cols(); ++j) {
      float acc = 0.0f;
      for (std::size_t k = 0; k < a.cols(); ++k) acc += a(i, k) * b(k, j);
      c(i, j) = acc;
    }
  return c;
}
