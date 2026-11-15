// Chapter 4 lab: a row-major matrix, a naive matmul written with pointers, and strided views.
//
//   c++ -std=c++20 -O2 -Wall -Wextra matmul.cpp -o matmul && ./matmul 512
//
// The optional argument is the matrix size n, for an n x n times n x n product (default 512).
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace lab {

// A matrix that owns its data: rows * cols floats in one std::vector, one row after another (row-major).
// Constructors and const member functions are explained in Chapter 6.
struct Matrix {
  int rows = 0;
  int cols = 0;
  std::vector<float> data;

  Matrix(int r, int c) : rows(r), cols(c), data(static_cast<std::size_t>(r) * static_cast<std::size_t>(c)) {}
  float& at(int i, int j) { return data[static_cast<std::size_t>(i) * cols + j]; }
  float at(int i, int j) const { return data[static_cast<std::size_t>(i) * cols + j]; }
};

// C (M x N) = A (M x K) times B (K x N). All three are row-major, and C must not overlap A or B.
// The indexes are int to keep the code close to the chapter. The chapter explains why big tensors need 64-bit ones.
void matmul(const float* A, const float* B, float* C, int M, int N, int K) {
  for (int i = 0; i < M; ++i) {
    for (int j = 0; j < N; ++j) {
      float sum = 0.0f;
      for (int k = 0; k < K; ++k) sum += A[i * K + k] * B[k * N + j];
      C[i * N + j] = sum;
    }
  }
}

// A read-only 2-D view: a pointer, a shape and strides counted in elements, and no ownership.
// This is the same information a PyTorch tensor keeps about its storage.
struct View {
  const float* data;
  std::int64_t rows;
  std::int64_t cols;
  std::int64_t stride0;  // elements to skip to move one row down
  std::int64_t stride1;  // elements to skip to move one column right
};

float get(const View& v, std::int64_t i, std::int64_t j) { return v.data[i * v.stride0 + j * v.stride1]; }

View view_of(const Matrix& m) { return {m.data.data(), m.rows, m.cols, m.cols, 1}; }

// Transposing a view swaps its shape and its strides. No element moves.
View transposed(const View& v) { return {v.data, v.cols, v.rows, v.stride1, v.stride0}; }

// The same product, reading both inputs through views, so either one may be transposed or strided.
void matmul_view(const View& A, const View& B, float* C) {
  for (std::int64_t i = 0; i < A.rows; ++i) {
    for (std::int64_t j = 0; j < B.cols; ++j) {
      float sum = 0.0f;
      for (std::int64_t k = 0; k < A.cols; ++k) sum += get(A, i, k) * get(B, k, j);
      C[i * B.cols + j] = sum;
    }
  }
}

// The same loops in double precision, used only to check the float results.
std::vector<double> matmul_reference(const Matrix& A, const Matrix& B) {
  std::vector<double> C(static_cast<std::size_t>(A.rows) * B.cols, 0.0);
  for (int i = 0; i < A.rows; ++i)
    for (int k = 0; k < A.cols; ++k)
      for (int j = 0; j < B.cols; ++j) C[static_cast<std::size_t>(i) * B.cols + j] += double{A.at(i, k)} * double{B.at(k, j)};
  return C;
}

double max_abs_diff(const std::vector<float>& got, const std::vector<double>& want) {
  double worst = 0.0;
  for (std::size_t i = 0; i < got.size(); ++i) worst = std::fmax(worst, std::fabs(double{got[i]} - want[i]));
  return worst;
}

}  // namespace lab

int main(int argc, char** argv) {
  using lab::Matrix;
  const int n = argc > 1 ? std::atoi(argv[1]) : 512;
  if (n <= 0) {
    std::printf("usage: matmul [n], with n > 0\n");
    return 1;
  }

  // Small values with a fixed pattern, so every run computes the same product.
  Matrix A(n, n);
  Matrix B(n, n);
  for (int i = 0; i < n; ++i) {
    for (int j = 0; j < n; ++j) {
      A.at(i, j) = static_cast<float>((i * 7 + j * 3) % 11) / 11.0f - 0.5f;
      B.at(i, j) = static_cast<float>((i * 5 + j * 2) % 13) / 13.0f - 0.5f;
    }
  }

  // Bt holds B's transpose, stored row-major. A transposed view of Bt has exactly B's shape and values.
  Matrix Bt(n, n);
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < n; ++j) Bt.at(j, i) = B.at(i, j);

  const std::vector<double> want = lab::matmul_reference(A, B);
  const double flops = 2.0 * n * n * n;  // one multiply and one add per (i, j, k)
  using clock = std::chrono::steady_clock;

  // 1. The pointer version: B is read down a column, n floats apart at each step.
  std::vector<float> C1(static_cast<std::size_t>(n) * n);
  auto t0 = clock::now();
  lab::matmul(A.data.data(), B.data.data(), C1.data(), n, n, n);
  auto t1 = clock::now();
  const double ms1 = std::chrono::duration<double, std::milli>(t1 - t0).count();
  std::printf("n = %d, %.0f million floating-point operations per product\n", n, flops / 1e6);
  std::printf("1. matmul(A, B): %.1f ms, %.2f GFLOP/s, max error vs double %.2e\n", ms1, flops / (ms1 * 1e6),
              lab::max_abs_diff(C1, want));

  // 2. The view version with B as a transposed view of Bt: B's column k is now one row of Bt, contiguous in memory.
  std::vector<float> C2(static_cast<std::size_t>(n) * n);
  t0 = clock::now();
  lab::matmul_view(lab::view_of(A), lab::transposed(lab::view_of(Bt)), C2.data());
  t1 = clock::now();
  const double ms2 = std::chrono::duration<double, std::milli>(t1 - t0).count();
  std::printf("2. matmul_view(A, transposed view of Bt): %.1f ms, %.2f GFLOP/s, max error vs double %.2e\n", ms2, flops / (ms2 * 1e6),
              lab::max_abs_diff(C2, want));

  // 3. The same views can compute A times A transposed without building A's transpose at all.
  std::vector<float> C3(static_cast<std::size_t>(n) * n);
  lab::matmul_view(lab::view_of(A), lab::transposed(lab::view_of(A)), C3.data());
  bool symmetric = true;
  for (int i = 0; i < n && symmetric; ++i)
    for (int j = 0; j < n; ++j)
      if (C3[static_cast<std::size_t>(i) * n + j] != C3[static_cast<std::size_t>(j) * n + i]) {
        symmetric = false;
        break;
      }
  std::printf("3. A times A transposed is symmetric: %s\n", symmetric ? "yes" : "no");
  return 0;
}
