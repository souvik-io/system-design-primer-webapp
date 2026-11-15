// Chapter 2: the "predict the output" snippets as one program, numbered like the quiz in the chapter.
// Write down what you expect each line to print, then run it.
//
//   c++ -std=c++20 -Wall -Wextra traps.cpp -o traps && ./traps
//
// Line 7 is undefined behavior. Build with -fsanitize=undefined to have it reported while the program runs.
// The compiler warnings you get with -Wall -Wextra are part of the lesson, so read them too.
#include <cstdint>
#include <iostream>
#include <vector>

int main() {
  {
    int a = 7, b = 2;
    double r = a / b;  // integer division happens first, then the conversion to double
    std::cout << "1. 7 / 2 stored in a double: " << r << '\n';
  }
  {
    std::cout << "2. -7 / 2 and -7 % 2: " << -7 / 2 << ' ' << -7 % 2 << '\n';
  }
  {
    std::vector<int> v;  // empty
    std::cout << "3. -1 < v.size(): " << (-1 < v.size()) << '\n';
  }
  {
    std::uint8_t x = 250;
    x += 10;
    std::cout << "4. uint8_t 250 + 10: " << +x << '\n';  // unary + promotes x to int so it prints as a number
  }
  {
    std::int8_t q = 65;
    std::cout << "5. int8_t 65 printed directly: " << q << '\n';
  }
  {
    std::int8_t q = 127;
    q = q + 1;
    std::cout << "6. int8_t 127 + 1: " << +q << '\n';
  }
  {
    // volatile stops the compiler from working out the overflow while compiling, so it happens at run time.
    volatile int big = 2147483647;
    std::cout << "7. INT_MAX + 1 (undefined behavior): " << big + 1 << '\n';
  }
  {
    std::cout << "8. 5 / 2 * 2.0 and 2.0 * 5 / 2: " << 5 / 2 * 2.0 << ' ' << 2.0 * 5 / 2 << '\n';
  }
  {
    float f = 16777217.0f;
    std::cout << "9. 16777217.0f == 16777216.0f: " << (f == 16777216.0f) << '\n';
  }
  {
    // 10. Remove the // below to watch the compiler refuse a narrowing conversion.
    // int n{3.9};
    std::cout << "10. int n{3.9}; does not compile (see the comment in the source)\n";
  }
  {
    std::vector<float> v;  // empty
    std::size_t last = v.size() - 1;
    std::cout << "11. v.size() - 1 for an empty vector: " << last << '\n';
  }
  return 0;
}
