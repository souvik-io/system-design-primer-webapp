// Buffer: an RAII owner for a heap array of floats, the shape of every tensor storage and GPU buffer class.
// Copying is deleted for now; Chapter 7 gives Buffer a real copy and a move.
#pragma once

#include <cstddef>

class Buffer {
 public:
  explicit Buffer(std::size_t n) : data_(new float[n]()), size_(n) {}
  ~Buffer() { delete[] data_; }

  Buffer(const Buffer&) = delete;
  Buffer& operator=(const Buffer&) = delete;

  float* data() { return data_; }
  const float* data() const { return data_; }
  std::size_t size() const { return size_; }

 private:
  float* data_;
  std::size_t size_;
};
