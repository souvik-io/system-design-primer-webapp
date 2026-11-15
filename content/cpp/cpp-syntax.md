# C++ syntax for Python programmers

You already know what a loop is, what a function is and how an `if` works, so this chapter does not teach programming again. It teaches the differences, and there are two kinds. The first kind is cosmetic: braces instead of indentation, semicolons, types written out. You will absorb those in an afternoon. The second kind is dangerous: places where C++ compiles your code without complaint and then computes a different answer from the one Python would give. Integer division, overflow and comparisons between signed and unsigned numbers are the classic examples, and they are exactly the operations that quantization code, tensor indexing and tokenizers do all day.

So the chapter moves fast through the phrasebook (variables, control flow, functions, enums, namespaces) and then slows down for the silent wrong answers, with a quiz where you predict what each snippet prints. The lab writes a small dtype table of the kind every tensor library has, quantizes a few weights to int8, and packs two 4-bit numbers into one byte, which is how 4-bit models are stored.

Before this chapter, read [the toolchain chapter](/learn/cpp-toolchain), which explains how a C++ file becomes a program. The lab builds with the same CMake commands.

## A first program, line by line

Here is a complete C++ program. It is longer than its Python equivalent, and every extra line is there for a reason.

```cpp
#include <iostream>
#include <vector>

int main() {
  std::vector<float> logits = {2.0f, -1.0f, 0.5f};
  float best = logits[0];
  for (float x : logits) {
    if (x > best) best = x;
  }
  std::cout << "max logit: " << best << '\n';
  return 0;
}
```

- `#include <iostream>` pastes in the declarations of the standard input and output streams. Python's `import` loads a module at run time; `#include` copies text before compiling, as the previous chapter showed.
- `int main()` is where the program starts. It returns an `int` to the operating system, where 0 means success. `main` is the one function allowed to leave out its `return`, in which case it returns 0.
- `std::vector<float>` is a growable array of 32-bit floats, the closest thing to a Python list of numbers. The `std::` prefix says it comes from the standard library's namespace.
- `float best = logits[0];` declares a variable with its type. The type never changes: `best` is a `float` for the rest of its life.
- Every statement ends with a semicolon, and braces mark blocks. Indentation is for humans only.
- `std::cout << ... << '\n'` prints. The `<<` operator sends each value to the stream in turn. Single quotes make a `char`, double quotes make a string literal.

You will also see `std::printf` from C, which takes a format string like Python's old `%` formatting. C++23 added `std::print`, whose format strings look like those of Python's `str.format`, and newer standard libraries provide it. This course uses `std::cout` and `std::printf` because every compiler in use supports them.

## Variables, types and auto

In Python, a name points at an object, and the object carries its type. In C++, a variable *is* a piece of memory of a fixed size, and its type is decided when the program is compiled. That is the source of C++'s speed: the compiler knows that `best` is four bytes holding a float, so `x > best` becomes a single machine instruction with no type check at run time.

There are several ways to initialize a variable, and the brace form is the safest:

```cpp
int a = 3;        // copy initialization, the familiar form
int b{3};         // brace initialization
int c{};          // braces with nothing inside: zero
int d = 3.9;      // compiles, silently stores 3
int e{3.9};       // error: narrowing conversion from double to int
```

Braces refuse **narrowing conversions**, ones that can lose information, such as a `double` to an `int`. The `=` form performs them silently. That difference is one reason modern C++ style prefers braces.

`auto` asks the compiler to use the type of the initializer. It is still static typing: the type is fixed at compile time, you just did not write it.

```cpp
auto n = 10;               // int
auto x = 10.0;             // double: a literal with a decimal point is a double
auto y = 10.0f;            // float: the f suffix makes it a float
auto big = 3'000'000'000;  // too big for int, so it becomes long on Linux and macOS
```

The apostrophes are digit separators, which C++14 added for readability, like Python's underscores in `3_000_000_000`. Use `auto` when the type is obvious from the right-hand side or long to write, and write the type when it carries meaning, such as `std::int8_t` for a quantized weight.

### const and constexpr

`const` means the variable cannot be changed after it is initialized. Its value may come from anywhere, including user input. `constexpr` means more: the value must be computable while compiling, so the compiler can use it as a constant, for example as the size of a fixed array.

```cpp
const int batch = read_batch_size();  // fine: fixed once set, known only at run time
constexpr int head_dim = 128;         // fine: known while compiling
constexpr int vocab = read_vocab();   // error unless read_vocab is constexpr and can run at compile time
```

Make every variable that does not change `const`. It costs nothing, it documents intent, and the compiler then catches the accidental assignment. A function can also be `constexpr`, which lets the compiler run it at compile time when its arguments are constants. The lab uses that to test its int4 packing before the program even exists.

### A variable you forgot to initialize

```cpp
int count;      // no initializer
count += 1;     // reads a value nobody set
```

In Python, using a name before assigning it raises `NameError`. In C++, a local variable of a built-in type without an initializer holds whatever bits were already in that memory, and reading it is undefined behavior: the program may print a random number, or the optimizer may do something stranger. Chapter 5 covers undefined behavior and the tools that catch it. The habit that prevents this case is simple: always initialize, and `int count{};` costs nothing.

## Control flow

The control flow is familiar, with a few additions worth knowing.

```cpp
for (int i = 0; i < n; ++i) { /* classic counted loop */ }

for (float x : logits) { /* read each element (a copy of it) */ }
for (float& x : logits) { x *= 0.5f; }        // & means x refers to the element itself, so this halves them
for (const auto& row : matrix) { /* read without copying */ }

while (!queue.empty()) { /* ... */ }

int sign = (x >= 0) ? 1 : -1;  // the conditional operator, Python's "1 if x >= 0 else -1"
```

The range-based `for` is the counterpart of Python's `for x in xs`. Without the `&`, each element is copied into `x`. That is free for a `float` but expensive for a large object, which is why `const auto&` is the usual way to read elements. Chapter 4 explains references properly.

Since C++17, an `if` can declare a variable that lives only for that `if` and its `else`:

```cpp
if (auto it = vocab.find(word); it != vocab.end()) {
  token_id = it->second;
}
```

This is close to Python's `if (it := vocab.get(word)) is not None:`, and it keeps `it` from leaking into the rest of the function.

### switch and fall-through

`switch` jumps to the `case` that matches an integer or enum value. It does not work on strings. Its one surprise is that execution **falls through** into the next case unless a `break` or `return` stops it:

```cpp
switch (dtype) {
  case DType::F16:
  case DType::BF16:
    bytes = 2;      // both cases share this code: intended
    break;
  case DType::I8:
    bytes = 1;      // forgot the break: execution continues into the next case
  case DType::F32:
    bytes = 4;      // so an I8 tensor ends up with 4 bytes per element
    break;
}
```

Empty cases stacked together, like `F16` and `BF16`, are a normal idiom. A case with code that falls through is usually a bug, and GCC warns about it under `-Wextra`. When you mean it, write `[[fallthrough]];` at the end of the case, which tells both the compiler and the next reader that it is deliberate. A second useful warning: when you `switch` over an enum without a `default`, `-Wall` warns about any enumerator you did not handle. Add `DType::FP8` to the enum a year later, and the compiler lists every switch that needs a new case.

## Functions

A function declares the type of each parameter and of its result:

```cpp
float mean(const std::vector<float>& xs) {
  float sum = 0.0f;
  for (float x : xs) sum += x;
  return sum / static_cast<float>(xs.size());
}
```

### Arguments are copied unless you say otherwise

This is the difference that costs the most performance. In Python, passing a list to a function passes a reference to the same list. In C++, a parameter declared as `std::vector<float> xs` receives a **copy**, element by element. Call a function like that with a vector of a million floats inside a loop, and every call allocates and copies 4 MB before doing any work. Writing the parameter as `const std::vector<float>& xs` passes a reference instead: no copy, and `const` promises the function will not modify the caller's data. For small types such as `int`, `float` or `DType`, pass by value; for anything that owns memory, pass by `const&` unless you need your own copy. Chapters 4 and 7 return to this in depth.

### Overloading

Two functions can share a name if their parameter types differ, and the compiler picks one from the argument types:

```cpp
float absmax(const std::vector<float>& xs);
int   absmax(const std::vector<std::int8_t>& xs);
```

Overloading is convenient, and occasionally confusing. Given `void f(long)` and `void f(double)`, the call `f(1)` does not compile: `1` is an `int`, converting it to `long` and converting it to `double` count as equally good conversions, and the compiler reports the call as ambiguous instead of guessing. `f(1L)` or `f(1.0)` resolves it.

### Default arguments, and no keyword arguments

A parameter can have a default value, written once, in the declaration that callers see (normally in the header), and only for trailing parameters:

```cpp
// sampler.h
int sample(const std::vector<float>& logits, float temperature = 1.0f, int top_k = 0);
```

C++ has no keyword arguments, so there is no way to pass `top_k` while leaving `temperature` at its default. The usual workaround is a small options struct. C++20's designated initializers make it read almost like Python keywords, as long as the fields are named in the order they are declared:

```cpp
struct SamplingParams {
  float temperature = 1.0f;
  int top_k = 0;
  float top_p = 1.0f;
};

int sample(const std::vector<float>& logits, const SamplingParams& p);

int token = sample(logits, {.top_k = 40, .top_p = 0.9f});
```

## Enums, namespaces and structured bindings

### enum class

Every tensor library has an enum of element types. PyTorch's C++ core calls it `c10::ScalarType`, and llama.cpp's ggml library calls it `ggml_type`. Here is a small one:

```cpp
enum class DType : std::uint8_t { F32, F16, BF16, I8, I4 };

DType t = DType::BF16;
int raw = static_cast<int>(t);   // 2: converting to int must be explicit
```

`enum class`, added in C++11, is a **scoped** enum: its names live inside it, so you write `DType::F16`, and it never converts to an integer by itself. The older plain `enum` puts its names in the surrounding scope, where `F16` can collide with something else, and converts to `int` silently, so `if (dtype == 3)` compiles. Prefer `enum class`. The `: std::uint8_t` after the name sets the underlying type, so each value fits in one byte when a file header or tensor descriptor stores it.

### Namespaces

A namespace groups names to avoid collisions, much as a Python module does. Everything in the standard library is in `std`, which is why you write `std::vector`. You declare your own with `namespace tinymath { ... }`, and C++17 lets you nest them in one line, `namespace engine::kernels { ... }`. You can bring names into scope with `using std::vector;`, or everything with `using namespace std;`. The second form is common in tutorials and frowned on in real code, and it should never appear in a header, because it would leak into every file that includes it.

### Structured bindings

C++17's structured bindings unpack a pair, a tuple or a simple struct into named variables, like Python's tuple unpacking:

```cpp
auto [q, scale] = quantize_i8(weights);   // the function returns a std::pair

for (const auto& [token, id] : vocab) {    // vocab is a std::unordered_map<std::string, int>
  // ...
}
```

The second form, iterating over a map's key-value pairs, is the counterpart of `for token, id in vocab.items():`.

## Fixed-width integers and casts

### int is not a fixed size

Python has one integer type, and it grows as large as it needs to. C++ has several, and the standard only sets minimum sizes: `int` must hold at least 16 bits, `long` at least 32, `long long` at least 64. On every mainstream 64-bit system today `int` is 32 bits, but `long` differs between platforms: it is 64 bits on Linux and macOS, a model called LP64, and 32 bits on 64-bit Windows, called LLP64. Code that assumes `long` holds a 64-bit offset into a large file works on one and breaks on the other.

When the size matters, and in AI infrastructure it usually does, use the fixed-width types from `<cstdint>`:

| Type | Bits | Range |
|---|---|---|
| `std::int8_t` | 8 | -128 to 127 |
| `std::uint8_t` | 8 | 0 to 255 |
| `std::int16_t` | 16 | -32,768 to 32,767 |
| `std::uint16_t` | 16 | 0 to 65,535 |
| `std::int32_t` | 32 | about -2.1 billion to 2.1 billion |
| `std::uint32_t` | 32 | 0 to about 4.3 billion |
| `std::int64_t` | 64 | about -9.2 × 10^18 to 9.2 × 10^18 |
| `std::uint64_t` | 64 | 0 to about 1.8 × 10^19 |

These types are the vocabulary of quantization. An int8 checkpoint stores each weight as an `int8_t`. A 4-bit checkpoint packs two weights into each `uint8_t`, as the lab does. A file format reads its header fields as `uint32_t` and `uint64_t`, because a field's size on disk must not depend on the machine reading it. Since C++20, signed integers are required to use two's complement, the representation every real processor already used, so the bit patterns are portable as well as the sizes.

Two more names appear everywhere. `std::size_t` is the unsigned type of sizes and indexes: `sizeof` returns it and `v.size()` returns it, and on 64-bit platforms it is 64 bits. `std::ptrdiff_t` is its signed partner, the type of the difference between two pointers. That `size()` is unsigned is the root of several traps below, and C++20 added `std::ssize(v)`, which returns the size as a signed number.

Floating point needs one note too. Python's `float` is a C `double`, 64 bits. In C++, `float` is 32 bits and `double` is 64. NumPy defaults to 64-bit floats and PyTorch to 32-bit ones, and model weights live in 32 bits or fewer, so in this course `float` is the default and `double` is reserved for accumulators that need the precision. The 16-bit formats fp16 and bf16 have no standard built-in type you can count on: C++23 added the optional types `std::float16_t` and `std::bfloat16_t`, but compiler support is uneven, so libraries define their own, such as PyTorch's `c10::Half` and `c10::BFloat16`. The [number formats chapter](/learn/number-formats) of the AI infrastructure handbook explains what their bits mean.

### Casts

Converting between types explicitly is called casting, and C++ has named casts so that each conversion says what kind it is:

```cpp
float avg = static_cast<float>(sum) / static_cast<float>(count);   // numeric conversion
auto id = static_cast<int>(DType::I8);                               // enum to integer
std::uint32_t bits = std::bit_cast<std::uint32_t>(1.0f);             // C++20: the raw bits of a float
```

`static_cast` covers ordinary conversions between numbers and enums. `std::bit_cast`, in `<bit>`, reinterprets the bits of one type as another of the same size, which is how you inspect a float's sign, exponent and mantissa. Keeping the top 16 bits of a float's pattern gives a crude bf16 value, although real converters round rather than cut off the lower bits. C also has a cast written `(int)x`, which C++ accepts, but it will perform any of several conversions, including dangerous ones, without telling you which. Named casts are easy to search for and refuse conversions they were not designed for, so prefer them.

## Silent wrong answers

Here is the part of the chapter that matters most. Each of these compiles, runs, and gives an answer a Python programmer does not expect.

**Integer division truncates.** When both operands are integers, `/` divides as integers, and the conversion to a floating type, if any, happens afterwards. `double avg = total / count;` with two `int`s throws away the fraction before it reaches `avg`. Cast one operand first: `static_cast<double>(total) / count`.

**Negative division rounds toward zero.** In C++, `-7 / 2` is -3 and `-7 % 2` is -1: the quotient truncates toward zero, and the remainder takes the sign of the left operand. Python's `//` rounds down, giving -4, and its `%` gives 1. Code ported from Python that computes a ring-buffer index or a hash bucket with `%` gives negative indexes for negative inputs.

**Unsigned arithmetic wraps; signed overflow is undefined.** Unsigned arithmetic wraps around modulo 2 to the power of the type's width, so a `uint32_t` holding 0 minus 1 is 4,294,967,295, and storing a value that is too big into an unsigned type wraps it the same way, so a `uint8_t` holding 250 becomes 4 after `x += 10`. Both are well defined, if surprising. Overflowing a *signed* integer in arithmetic, such as adding 1 to the largest `int`, is undefined behavior. The language makes no promise at all, and optimizers use that freedom: because overflow "cannot happen", a compiler may treat `x + 1 > x` as always true for a signed `x`. Chapter 5 shows this in action. Python never overflows, because its integers grow, so this whole class of bug is new.

**Small types are promoted, and conversions back wrap.** Arithmetic on types smaller than `int` first converts them to `int`. So with `std::int8_t q = 127;`, the expression `q + 1` is the `int` 128, with no overflow. Storing 128 back into `q` is a narrowing conversion, which C++20 defines to wrap, so `q` becomes -128. Quantization code clamps to the valid range *before* converting for this reason.

**Signed and unsigned comparisons convert the signed side.** When a signed and an unsigned integer of the same size meet in an expression, the signed one is converted to unsigned. The same happens when an `int` meets a larger unsigned type such as `size_t`. So `-1 < v.size()` is false for every vector, because -1 becomes the largest `size_t`, 18,446,744,073,709,551,615 on a 64-bit platform. Compiling with `-Wall -Wextra` warns about signed and unsigned comparisons; keep those warnings on and read them.

**size() minus one, and the loop that never ends.** For an empty vector, `v.size() - 1` is not -1 but 18,446,744,073,709,551,615. A related classic is the backwards loop:

```cpp
for (std::size_t i = v.size() - 1; i >= 0; --i) { /* ... */ }   // never ends
```

An unsigned `i` is always `>= 0`, so after `i` reaches 0, `--i` wraps it to the largest value and the loop carries on, reading far outside the vector. GCC warns that the comparison is always true under `-Wextra`. Safe versions count with a signed index, `for (std::ptrdiff_t i = std::ssize(v) - 1; i >= 0; --i)`, or test before decrementing, `for (std::size_t i = v.size(); i-- > 0;)`.

**int8_t prints as a character.** On every common platform, `std::int8_t` is another name for `signed char` and `std::uint8_t` for `unsigned char`. Streams print character types as characters, so `std::cout << q` with `q == 65` prints `A`, and a vector of int8 weights prints as a line of odd symbols. Write `+q` or `static_cast<int>(q)` to print the number.

**A float runs out of integers at 2^24.** A 32-bit `float` keeps 24 bits of precision, so above 16,777,216 it can no longer represent every integer: 16,777,217 rounds to 16,777,216, and adding 1 to a float counter stuck at that value changes nothing. Python's `float` has 53 bits of precision, so the same surprise starts only above 9 × 10^15 there. It bites in C++ when you accumulate a sum of millions of values in `float`, which is why the dot product in chapter 1's lab adds its products into a `double`.

Now test yourself. Each snippet below is one of these traps; decide what it prints before revealing the answer.

```widget
integer-traps
```

## Lab: a dtype table, int8 quantization and int4 packing

The lab is two small programs, [`traps.cpp`](/labs/cpp/cpp-syntax/traps.cpp) and [`dtypes.cpp`](/labs/cpp/cpp-syntax/dtypes.cpp), with a [`CMakeLists.txt`](/labs/cpp/cpp-syntax/CMakeLists.txt) that builds both. Download the three files into one folder. The lab needs only a C++20 compiler and CMake, so it runs on a laptop. Build both with the usual two commands:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
```

### Part 1: run the traps

`traps.cpp` contains the quiz snippets as one program, numbered the same way, plus one more: `v.size() - 1` for an empty vector. Before running `./build/traps`, write down what you expect each line to print. Then run it and compare. Read the compiler warnings from the build as well, because `-Wall -Wextra` flags several of the traps before the program ever runs.

<!-- measure: build traps with -Wall -Wextra on the reader's compiler; record which lines produced warnings and the full output of ./build/traps -->

Then rebuild with the sanitizers on and run it again:

```bash
cmake -S . -B build-san -DCMAKE_BUILD_TYPE=Debug -DLAB_SANITIZE=ON
cmake --build build-san
./build-san/traps
```

UndefinedBehaviorSanitizer checks every signed arithmetic operation while the program runs, so line 7 should now be reported with a message of the form `runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'`. The overflow is no less undefined without the sanitizer; the tool just makes it visible.

<!-- measure: record the exact UBSan message for line 7 and whether line 7's printed value differs between the Debug and sanitizer builds -->

### Part 2: the dtype table

`dtypes.cpp` starts with the `DType` enum from this chapter and two `constexpr` functions that `switch` over it: `bits_of`, the bits per element, and `name_of`. From those, `bytes_for(t, n)` computes the storage for `n` elements, adding 7 bits before dividing by 8 so that a half-filled byte of 4-bit values rounds up. The program prints the weight memory of a 7-billion-parameter model in each dtype, which works out to 28.0 GB in f32, 14.0 GB in f16 and bf16, 7.0 GB in i8, and 3.5 GB in i4. Those numbers are the first thing an inference engineer computes about any model, because they decide which GPU it fits on.

Try this: delete the `case DType::I4:` lines from `bits_of` and rebuild. The compiler warns that the enumeration value `I4` is not handled in the switch, and then the build stops at the `static_assert` that checks `bytes_for(DType::I4, 3)`, because `bits_of` now falls through to its final `return 0` for `I4`. The warning pointed at the real cause before the failing test did, and that is why the functions have no `default` case: a `default` would silence the warning and leave only the test to catch the mistake, or nothing at all if no test covered it.

### Part 3: symmetric int8 quantization

`quantize_i8` maps a vector of floats to `int8_t` values with one shared scale. It finds the largest absolute value, sets `scale = max_abs / 127`, divides each weight by the scale, rounds to the nearest integer with `std::lround`, and clamps the result to [-127, 127] with `std::clamp` before the narrowing cast. `dequantize_i8` multiplies back. The [quantization math chapter](/learn/quantization-math) of the AI infrastructure handbook explains why this works and when it does not; here the point is the C++.

For the six weights in the program, {0.12, -0.50, 0.33, 0.01, -0.27, 0.49}, the largest magnitude is 0.5, so the scale is 0.5 / 127, about 0.003937. Dividing by it gives 30.48, -127, 83.82, 2.54, -68.58 and 124.46, which round to the int8 values 30, -127, 84, 3, -69 and 124. Restoring 30 gives 30 × 0.003937, about 0.1181, an error of about 0.0019 against the original 0.12. No error can exceed half a step, 0.003937 / 2, about 0.00197, as long as nothing was clamped. Notice that the function returns two things, the values and the scale, as a `std::pair`, and that `main` unpacks them with a structured binding.

<!-- measure: record the scale and the six rows (weight, int8, restored, error) that ./build/dtypes prints -->

### Part 4: two weights in one byte

4-bit models store two weights per byte. `pack_i4(lo, hi)` keeps the low four bits of each value with `& 0x0F`, shifts `hi` left by four, and combines them with `|`. Because signed integers are two's complement, -1 has the low four bits `1111`, so `pack_i4(-1, 1)` is the byte `0x1F`. `unpack_i4` does the reverse: `byte & 0x0F` and `byte >> 4` recover the two 4-bit patterns, and `sign_extend4` maps the patterns 8 to 15 back to -8 to -1. The program checks the round trip for all 256 pairs of values and should report 0 failures.

The file also has four `static_assert` lines. Each is a test that runs while compiling, because the functions it calls are `constexpr`. Change `0x1F` to `0x1E` in one of them and the program stops building, with the failing assertion as the error.

Real formats make different choices for the same idea. llama.cpp's Q4_0 format, defined in `ggml/src/ggml-common.h`, groups weights into blocks of 32. Each block stores one scale as a 16-bit float and 16 bytes of 4-bit values, 18 bytes in all, or 4.5 bits per weight. Instead of two's complement, each stored 4-bit value is unsigned, from 0 to 15, and the dequantizer subtracts 8, which also gives the range -8 to 7. Byte `j` of a block holds weight `j` in its low half and weight `j + 16` in its high half, rather than two neighbouring weights.

### Stretch goals

- Change `quantize_i8` to use one scale per block of 32 weights, the way Q4_0 does, and compare the largest error with the single-scale version on a vector that has one large outlier.
- Write `quantize_i4` and `dequantize_i4` on top of `pack_i4` and `unpack_i4`, with a scale of `max_abs / 7`, and print how the error compares with int8.

## Check yourself

<details>
<summary>A function computes double avg = total / count; where total and count are int. For total = 7 and count = 2, avg is 3. Why, and what is the fix?</summary>

Both operands of `/` are `int`, so the division is integer division and produces 3. Only then is 3 converted to `double` for the assignment. Converting one operand before dividing makes it floating-point division: `static_cast<double>(total) / count` gives 3.5.

</details>

<details>
<summary>What is wrong with for (std::size_t i = v.size() - 1; i &gt;= 0; --i), and how do you write it safely?</summary>

`std::size_t` is unsigned, so `i >= 0` is always true, and when `i` is 0, `--i` wraps around to the largest `size_t`. The loop never ends and indexes far outside the vector. For an empty vector, `v.size() - 1` is already the largest `size_t`, so it goes wrong from the first iteration. Use a signed index, `for (std::ptrdiff_t i = std::ssize(v) - 1; i >= 0; --i)`, or test before decrementing, `for (std::size_t i = v.size(); i-- > 0;)`.

</details>

<details>
<summary>Why should a dtype be an enum class rather than a plain enum or an int?</summary>

An `enum class` keeps its names inside its own scope, so `DType::I8` cannot collide with another `I8`, and it never converts to an integer implicitly, so comparing a dtype with a bare number or passing one where an `int` is expected does not compile. A `switch` over it without a `default` also gets a warning from `-Wall` for each value it does not handle, so adding a new dtype points you to every place that must learn about it.

</details>

<details>
<summary>A function float mean(std::vector&lt;float&gt; xs) is called once per request on a vector of a million floats. It gives the right answer. What is the problem?</summary>

The parameter is passed by value, so every call copies the whole vector, allocating and copying 4 MB before computing anything. Declaring it `const std::vector<float>& xs` passes a reference to the caller's vector instead, with no copy, and `const` guarantees `mean` cannot modify it.

</details>

<details>
<summary>You print a row of int8 weights with std::cout and get a line of odd symbols. Why, and how do you print the numbers?</summary>

`std::int8_t` is a name for `signed char` on every common platform, and streams print character types as characters, so each weight is printed as the character with that code. Converting each value to `int` first, with `+q` or `static_cast<int>(q)`, prints the number.

</details>

<details>
<summary>How many bytes does one block of 32 weights take in llama.cpp's Q4_0 format, and how many bits per weight is that?</summary>

A block holds one 16-bit scale, 2 bytes, and 32 four-bit values packed two per byte, 16 bytes, for 18 bytes in total. 18 bytes is 144 bits for 32 weights, which is 4.5 bits per weight: the 4 bits of each value plus the scale's 16 bits shared among 32 weights.

</details>

## Further reading

- [cppreference: arithmetic operators](https://en.cppreference.com/w/cpp/language/operator_arithmetic) gives the exact rules for integer division, remainder, promotion and overflow.
- [cppreference: implicit conversions](https://en.cppreference.com/w/cpp/language/implicit_conversion) covers integral promotion and the conversions behind the signed and unsigned traps.
- [cppreference: fixed width integer types](https://en.cppreference.com/w/cpp/types/integer) lists everything in `<cstdint>`, with the limits of each type.
- [cppreference: enumeration declaration](https://en.cppreference.com/w/cpp/language/enum) explains scoped and unscoped enums and underlying types.
- [cppreference: structured binding declaration](https://en.cppreference.com/w/cpp/language/structured_binding) shows every kind of object that can be unpacked.
- [learncpp.com](https://www.learncpp.com/) is a free, thorough tutorial that covers this chapter's material at a slower pace, with exercises.
- [A Tour of C++, third edition](https://www.stroustrup.com/tour3.html), by Bjarne Stroustrup, the language's creator, is a short book that surveys modern C++ for programmers who already know another language.
- [llama.cpp's ggml-common.h](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-common.h) defines `block_q4_0` and the other quantized block formats, as real-world examples of fixed-width types and packed data.
