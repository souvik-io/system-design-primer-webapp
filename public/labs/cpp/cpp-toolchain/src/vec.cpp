// The definitions of the functions declared in include/tinymath/vec.h.
#include "tinymath/vec.h"

#include <cassert>
#include <cmath>
#include <cstddef>

namespace tinymath {

float dot(const std::vector<float>& a, const std::vector<float>& b) {
  // assert is a macro: it checks the condition in Debug builds and disappears when NDEBUG is defined.
  assert(a.size() == b.size() && "dot: the vectors must have the same length");
  double sum = 0.0;
  for (std::size_t i = 0; i < a.size(); ++i) sum += a[i] * b[i];
  return static_cast<float>(sum);
}

float norm(const std::vector<float>& a) { return std::sqrt(dot(a, a)); }

float cosine_similarity(const std::vector<float>& a, const std::vector<float>& b) {
  return dot(a, b) / (norm(a) * norm(b));
}

}  // namespace tinymath
