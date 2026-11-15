// tinymath: a tiny vector-math library for practising how C++ is built (chapter 1).
// This header only declares the functions. Their definitions are in src/vec.cpp.
#pragma once

#if __cplusplus < 202002L
#error "tinymath needs C++20 or newer"
#endif

#include <vector>

namespace tinymath {

// The & means the vector is passed without being copied, and const means the function will not change it.
// Chapter 4 explains both.
float dot(const std::vector<float>& a, const std::vector<float>& b);
float norm(const std::vector<float>& a);
float cosine_similarity(const std::vector<float>& a, const std::vector<float>& b);

}  // namespace tinymath
