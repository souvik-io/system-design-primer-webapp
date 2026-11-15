import { Quiz, type QuizItem } from './Quiz'

// "Predict the output" for content/cpp/cpp-syntax.md: C++ expressions that compile and quietly give an answer a Python
// programmer does not expect. Each snippet assumes #include <iostream>, <cstdint> and <vector>, C++20, and a 64-bit
// platform where int is 32 bits and std::size_t is 64 bits, which is true of Linux, macOS and Windows on x86-64 and ARM64.
// C++20 made the conversion of an out-of-range value to a signed type well defined (modulo 2^N), which item 6 relies on.

const ITEMS: QuizItem[] = [
  {
    snippet: `int a = 7, b = 2;
double r = a / b;
std::cout << r;`,
    options: ['3.5', '3', '4'],
    answer: 1,
    explanation: (
      <>
        <code>a / b</code> divides two <code>int</code>s, so it is integer division and gives 3. Only then is 3 converted to a <code>double</code>. Write{' '}
        <code>static_cast&lt;double&gt;(a) / b</code> to divide as floating point. Python 3&apos;s <code>/</code> always gives a float, so there{' '}
        <code>7 / 2</code> is 3.5.
      </>
    ),
  },
  {
    snippet: `std::cout << -7 / 2 << ' ' << -7 % 2;`,
    options: ['-4 1', '-3 -1', '-3 1'],
    answer: 1,
    explanation: (
      <>
        C++ integer division truncates toward zero, so <code>-7 / 2</code> is -3, and the remainder takes the sign of the left operand, so{' '}
        <code>-7 % 2</code> is -1. Python&apos;s <code>//</code> rounds down instead, so Python prints <code>-4 1</code>. Code ported from Python that
        computes a bucket or a wrap-around index with <code>%</code> breaks on negative numbers.
      </>
    ),
  },
  {
    snippet: `std::vector<int> v;  // empty
std::cout << (-1 < v.size());`,
    options: ['1', '0', 'It does not compile'],
    answer: 1,
    explanation: (
      <>
        <code>v.size()</code> is a <code>std::size_t</code>, which is unsigned. When a signed and an unsigned 64-bit value meet, the signed one is converted
        to unsigned, so -1 becomes 18,446,744,073,709,551,615, the largest <code>size_t</code>, and the comparison is false. <code>std::cout</code>{' '}
        prints a <code>bool</code> as 0 or 1. Compiling with <code>-Wall -Wextra</code> warns about this comparison.
      </>
    ),
  },
  {
    snippet: `std::uint8_t x = 250;
x += 10;
std::cout << +x;`,
    options: ['260', '4', '255'],
    answer: 1,
    explanation: (
      <>
        <code>x + 10</code> is computed as an <code>int</code>, 260. A <code>uint8_t</code> holds only 0 to 255, so storing 260 back wraps it modulo 256 to
        4. Conversion to an unsigned type always wraps, so this is well defined. The unary{' '}
        <code>+</code> promotes <code>x</code> to <code>int</code> so that it prints as a number, which matters for the next question.
      </>
    ),
  },
  {
    snippet: `std::int8_t q = 65;
std::cout << q;`,
    options: ['65', 'A', 'It does not compile'],
    answer: 1,
    explanation: (
      <>
        On every common platform <code>int8_t</code> is another name for <code>signed char</code>, and <code>std::cout</code> prints a character type as a
        character. 65 is the code for <code>A</code>. Printing int8 weights this way shows a stream of odd symbols, so write{' '}
        <code>+q</code> or <code>static_cast&lt;int&gt;(q)</code>.
      </>
    ),
  },
  {
    snippet: `std::int8_t q = 127;
q = q + 1;
std::cout << +q;`,
    options: ['128', '-128', 'Undefined behavior'],
    answer: 1,
    explanation: (
      <>
        <code>q + 1</code> is computed as an <code>int</code>, 128, so nothing overflows. Storing 128 back into an <code>int8_t</code> is a narrowing
        conversion, which C++20 defines to wrap modulo 256, giving -128. Before C++20 the result was implementation-defined, and compilers gave -128
        anyway. This is why quantization code clamps to [-127, 127] or [-128, 127] before converting.
      </>
    ),
  },
  {
    snippet: `int big = 2147483647;  // the largest 32-bit int
std::cout << big + 1;`,
    options: ['-2147483648', '2147483648', 'Undefined behavior'],
    answer: 2,
    explanation: (
      <>
        Overflowing a signed integer in arithmetic is undefined behavior: the language makes no promise about what happens. An unoptimized build will
        often print -2147483648, but an optimizer is allowed to assume the overflow never happens and transform the code on that basis. Chapter 5
        shows how that goes wrong. Unsigned arithmetic, by contrast, always wraps.
      </>
    ),
  },
  {
    snippet: `std::cout << 5 / 2 * 2.0 << ' ' << 2.0 * 5 / 2;`,
    options: ['5 5', '4 5', '4.0 5.0'],
    answer: 1,
    explanation: (
      <>
        Operators of the same precedence run left to right. On the left, <code>5 / 2</code> is integer division, 2, and then 2 × 2.0 is 4.0. On the right,
        2.0 × 5 is 10.0 and 10.0 / 2 is 5.0. By default <code>std::cout</code> prints a whole-number <code>double</code> without a decimal point, so you
        see <code>4 5</code>.
      </>
    ),
  },
  {
    snippet: `float f = 16777217.0f;
std::cout << (f == 16777216.0f);`,
    options: ['0', '1', 'It does not compile'],
    answer: 1,
    explanation: (
      <>
        A <code>float</code> has 24 bits of precision, so above 2^24 = 16,777,216 it cannot represent every integer, and 16,777,217 rounds to
        16,777,216. Python&apos;s <code>float</code> is a 64-bit <code>double</code> with 53 bits, which is why this surprise rarely shows up in Python.
        It matters when you count tokens or sum millions of values in fp32.
      </>
    ),
  },
  {
    snippet: `int n{3.9};
std::cout << n;`,
    options: ['3', '4', 'It does not compile'],
    answer: 2,
    explanation: (
      <>
        Brace initialization refuses narrowing conversions, such as a <code>double</code> to an <code>int</code>, so the compiler stops with an error.{' '}
        <code>int n = 3.9;</code> would compile and silently store 3. This is one reason modern C++ style prefers braces.
      </>
    ),
  },
]

export default function IntegerTraps() {
  return (
    <Quiz
      title="Try it: predict the output"
      description="Each snippet compiles (or not) and runs on a 64-bit machine with C++20. Decide what it prints before revealing the answer. Most of them would print something else in Python."
      items={ITEMS}
      question="What happens?"
      noun="Snippet"
    />
  )
}
