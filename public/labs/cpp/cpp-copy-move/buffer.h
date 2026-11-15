// Buffer from Chapter 6, now with a real copy and a move, and with counters that record every copy, move and
// allocation, so that the lab can show what ordinary-looking code really does.
#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <utility>

// What happened to Buffers since the last reset_counters(). An inline variable (C++17) is one object shared by
// every file that includes this header.
struct Counters {
  long allocations = 0;
  long copies = 0;
  long moves = 0;
  long long bytes_copied = 0;
};
inline Counters g_count;

inline void reset_counters() { g_count = Counters{}; }

inline void print_counters(const char* label) {
  std::printf("  %-34s allocations %5ld   copies %5ld   moves %5ld   bytes copied %lld\n", label, g_count.allocations,
              g_count.copies, g_count.moves, g_count.bytes_copied);
}

class Buffer {
 public:
  explicit Buffer(std::size_t n) : data_(new float[n]()), size_(n) { ++g_count.allocations; }

  ~Buffer() { delete[] data_; }  // delete[] on nullptr does nothing, so a moved-from Buffer is fine to destroy

  // Copy: a new block of the same size, with the same values. A deep copy, like std::vector's.
  Buffer(const Buffer& other) : data_(new float[other.size_]), size_(other.size_) {
    std::copy(other.data_, other.data_ + size_, data_);
    count_copy();
  }

  // Copy assignment. Assigning a Buffer to itself must do nothing. If the sizes differ, allocate the new block before
  // freeing the old one, so that if new throws, *this is unchanged. If they match, reuse the block we already have,
  // as std::vector does: no allocation at all.
  Buffer& operator=(const Buffer& other) {
    if (this == &other) return *this;
    if (size_ != other.size_) {
      float* fresh = new float[other.size_];
      delete[] data_;
      data_ = fresh;
      size_ = other.size_;
      ++g_count.allocations;
    }
    std::copy(other.data_, other.data_ + size_, data_);
    ++g_count.copies;
    g_count.bytes_copied += static_cast<long long>(size_ * sizeof(float));
    return *this;
  }

  // Move: take the other Buffer's block and leave it empty. No allocation, no element copied, and nothing that
  // can throw, which is what noexcept promises.
  Buffer(Buffer&& other) noexcept : data_(std::exchange(other.data_, nullptr)), size_(std::exchange(other.size_, 0)) {
    ++g_count.moves;
  }

  // Move assignment: free our block, take theirs. The check makes b = std::move(b) harmless.
  Buffer& operator=(Buffer&& other) noexcept {
    if (this != &other) {
      delete[] data_;
      data_ = std::exchange(other.data_, nullptr);
      size_ = std::exchange(other.size_, 0);
      ++g_count.moves;
    }
    return *this;
  }

  float* data() { return data_; }
  const float* data() const { return data_; }
  std::size_t size() const { return size_; }

 private:
  void count_copy() {
    ++g_count.allocations;
    ++g_count.copies;
    g_count.bytes_copied += static_cast<long long>(size_ * sizeof(float));
  }

  float* data_;
  std::size_t size_;
};

// The same Buffer inside a wrapper whose move constructor is correct but not marked noexcept. Everything else is
// defaulted. (Declaring a move constructor deletes the implicit copy operations, so they must be asked for with
// = default, which is the rule of five in miniature.)
struct SlowBuffer {
  explicit SlowBuffer(std::size_t n) : buf(n) {}
  SlowBuffer(SlowBuffer&& other) : buf(std::move(other.buf)) {}  // no noexcept
  SlowBuffer(const SlowBuffer&) = default;
  SlowBuffer& operator=(const SlowBuffer&) = default;
  SlowBuffer& operator=(SlowBuffer&&) = default;
  ~SlowBuffer() = default;

  Buffer buf;
};

// Rule of zero: a layer that declares no special member functions. The compiler writes all five, and each one
// does the right thing because Buffer does.
struct Layer {
  Buffer weights;
};

// The same layer with an empty destructor added "for logging later". A user-declared destructor stops the compiler
// from declaring the move operations, so moving a LoggedLayer quietly copies it.
struct LoggedLayer {
  Buffer weights;
  ~LoggedLayer() {}
};
