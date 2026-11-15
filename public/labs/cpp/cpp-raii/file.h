// File: an RAII owner for one C FILE*. The constructor opens the file and the destructor closes it,
// so every way out of a scope closes it: falling off the end, return, break, or an exception.
#pragma once

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>

class File {
 public:
  File(const char* path, const char* mode) : f_(std::fopen(path, mode)) {
    // A constructor cannot return an error code, so it throws. If it throws, the object never existed,
    // and its destructor will not run: there is nothing to close.
    if (f_ == nullptr) throw std::runtime_error(std::string("cannot open ") + path + ": " + std::strerror(errno));
  }

  ~File() { std::fclose(f_); }

  // Copying would give two File objects the same FILE*, and both destructors would close it.
  File(const File&) = delete;
  File& operator=(const File&) = delete;

  std::FILE* get() const { return f_; }

 private:
  std::FILE* f_;
};
