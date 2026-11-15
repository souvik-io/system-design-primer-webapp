<!-- Flashcards for Part I of C++ for AI Infrastructure Engineers: the toolchain, syntax for Python programmers, memory, pointers, undefined behavior, and Project A. -->

<!-- chapter: cpp-toolchain -->

## Name the four stages that turn C++ source files into a running program, and what each produces.

<!-- /learn/cpp-toolchain#from-source-file-to-running-program -->

The **preprocessor** handles `#` lines and produces a translation unit, one long file of plain C++. The **compiler** checks types, optimizes and emits an **object file** (`.o`) for each source file on its own. The **linker** joins the object files and libraries into an executable, matching every use of a name with its one definition. The **loader**, part of the operating system, maps the executable and its shared libraries into memory when the program starts and jumps to `main`.

## Why do large C++ projects take so long to build, and what is designed to fix it?

<!-- /learn/cpp-toolchain#the-preprocessor-pastes-text -->

`#include` pastes the entire text of a header, and of everything it includes, into every source file that includes it, so the compiler parses the same headers again for every file. A short file with a few standard headers becomes tens of thousands of lines. C++20 modules, and `import std;` in C++23, are designed to fix this, although compiler and build-system support is still uneven.

## What does the one-definition rule require across a whole program, and what breaks it most often?

<!-- /learn/cpp-toolchain#declarations-definitions-and-the-one-definition-rule -->

An ordinary function or global variable that is used must be defined exactly once: zero definitions gives "undefined reference" and two give "multiple definition". Classes, `inline` functions and variables, and templates may be defined in every translation unit, as long as every copy is identical. The common mistake is a function body in a header without `inline`, which gives one definition per source file that includes it.

## What is name mangling, and what does it turn a mismatched declaration into?

<!-- /learn/cpp-toolchain#the-linker-joins-the-pieces -->

The compiler encodes a function's namespace and parameter types into its symbol name, so overloads get different symbols: under the Itanium ABI, `int add(int, int)` becomes `_Z3addii`. A function declared with one parameter type and defined with another is therefore two different symbols, and the mismatch appears as an undefined reference at link time, not as a type error. `c++filt` turns mangled names back into readable ones.

## How do you tell from an error message which stage is complaining?

<!-- /learn/cpp-toolchain#which-stage-is-complaining -->

`file:line:column` errors about `#include`, missing files or `#error` come from the preprocessor; ones about types, undeclared names or "no matching function" come from the compiler. Messages mentioning `ld`, `undefined reference`, `multiple definition` or `Undefined symbols for architecture`, with no line number, come from the linker. Errors when the program starts or Python imports a module come from the loader, and `CMake Error` comes from CMake before anything compiles. Read the first error first.

## In modern CMake, what is a target, and what do PUBLIC and PRIVATE mean on a target setting?

<!-- /learn/cpp-toolchain#cmake-describes-the-build -->

A target is something CMake builds, created by `add_library` or `add_executable`, and settings are attached to targets rather than set globally. `PRIVATE` applies a setting only to the target's own files. `PUBLIC` applies it to the target and to everything that links it, so `target_include_directories(tinymath PUBLIC include)` lets every user of `tinymath` find its headers.

## What do -O0, -O2, -g and -DNDEBUG each do?

<!-- /learn/cpp-toolchain#build-types-and-the-flags-that-matter -->

`-O0`, the default, translates code almost line by line: easy to debug and slow. `-O2` is the usual production optimization level. `-g` adds debug information that maps machine code back to source lines; it makes files larger but does not slow the program. `-DNDEBUG` defines `NDEBUG`, which switches off `assert`.

<!-- chapter: cpp-syntax -->

## Why is int8_t risky to print with std::cout, and how do you print the number?

<!-- /learn/cpp-syntax#silent-wrong-answers -->

On every common platform `std::int8_t` is another name for `signed char`, and streams print character types as characters, so a value of 65 prints as `A`. Write `+q` or `static_cast<int>(q)` to print it as a number.

## What is -7 / 2 and -7 % 2 in C++, and why does it matter when porting Python code?

<!-- /learn/cpp-syntax#silent-wrong-answers -->

-3 and -1: C++ integer division truncates toward zero, and the remainder takes the sign of the left operand. Python's `//` rounds down, giving -4, and its `%` gives 1. Ported code that computes a ring-buffer index or a hash bucket with `%` gets negative indexes for negative inputs.

## Why does for (std::size_t i = v.size() - 1; i >= 0; --i) never end, and what are two safe versions?

<!-- /learn/cpp-syntax#silent-wrong-answers -->

An unsigned `i` is always `>= 0`, so when it reaches 0, `--i` wraps it to the largest `size_t` and the loop carries on, reading far outside the vector. Count with a signed index, `for (std::ptrdiff_t i = std::ssize(v) - 1; i >= 0; --i)`, or test before decrementing, `for (std::size_t i = v.size(); i-- > 0;)`.

## Above what value can a 32-bit float no longer represent every integer, and where does that bite?

<!-- /learn/cpp-syntax#silent-wrong-answers -->

Above 2^24 = 16,777,216, because a `float` keeps 24 bits of precision, so 16,777,217 rounds to 16,777,216 and adding 1 to a float counter stuck there changes nothing. It bites when you sum millions of values in `float`, which is why accumulators are often `double`.

## How big is long on Linux, macOS and 64-bit Windows, and what should code use when size matters?

<!-- /learn/cpp-syntax#fixed-width-integers-and-casts -->

`long` is 64 bits on Linux and macOS (the LP64 model) and 32 bits on 64-bit Windows (LLP64). When the size matters, as it does for file formats and quantized weights, use the fixed-width types from `<cstdint>`, such as `std::int8_t`, `std::uint32_t` and `std::int64_t`.

## What is std::bit_cast for, and why prefer named casts over (int)x?

<!-- /learn/cpp-syntax#fixed-width-integers-and-casts -->

`std::bit_cast`, from C++20's `<bit>`, reinterprets the bits of one type as another of the same size, such as a `float`'s bits as a `uint32_t`, which is how you inspect sign, exponent and mantissa. A C-style cast will perform any of several conversions, including dangerous ones, without saying which; named casts such as `static_cast` are searchable and refuse conversions they were not designed for.

<!-- chapter: cpp-memory -->

## Why does a Python list of a million floats take about 32 MB while a std::vector<float> takes 4 MB?

<!-- /learn/cpp-memory#overview -->

In CPython each float is a separate 24-byte object, and the list holds a million 8-byte pointers to them. A `std::vector<float>` stores the numbers themselves side by side, 4 bytes each. NumPy and PyTorch tensors are, underneath, C or C++ buffers of raw numbers for the same reason.

## Why is a local array on the stack cheaper than the same array from new?

<!-- /learn/cpp-memory#the-stack-fast-automatic-and-small -->

A function's whole stack frame, including its local arrays, is reserved at once by moving the stack pointer and released the same way on return. `new` calls the allocator, which must find a free block, record it and coordinate with other threads, and it must be matched by a `delete` that undoes the bookkeeping.

## What are the default stack sizes on Linux, macOS and Windows, and what happens when a function's locals exceed them?

<!-- /learn/cpp-memory#the-stack-fast-automatic-and-small -->

Linux uses 8 MB by default (`ulimit -s`). macOS gives the main thread 8 MB and other threads 512 KB. Windows uses 1 MB. A local array larger than the stack, such as 16 MB of logits, runs past the end of the stack into a guard page and crashes with a segmentation fault. Put large buffers on the heap, for example in a `std::vector`.

## In what order are objects destroyed, and when does a temporary die?

<!-- /learn/cpp-memory#lifetime-when-objects-are-born-and-die -->

Objects in a scope are destroyed in reverse order of construction, so that nothing is destroyed while a later object might still use it. A temporary lives until the end of the full expression that created it. Function-local statics are constructed on first use and, like globals, destroyed after `main` returns, in reverse order.

## Why can a pointer taken with v.data() go bad after push_back, and what are the fixes?

<!-- /learn/cpp-memory#lifetime-when-objects-are-born-and-die -->

When `push_back` exceeds the vector's capacity, the vector allocates a larger block, moves the elements and frees the old block, so the old pointer dangles and reading through it is a use-after-free. Store an index instead of a pointer, or call `reserve` with the final size first so that the vector never reallocates.

## A struct holds bool, double, bool in that order. What is its sizeof on a 64-bit platform, and how do you shrink it?

<!-- /learn/cpp-memory#sizeof-alignment-and-padding -->

24 bytes: the first `bool` at offset 0, 7 bytes of padding so the `double` starts at offset 8, the second `bool` at 16, and the size rounded up to a multiple of 8. Putting the `double` first gives 8 + 1 + 1 bytes, rounded up to 16. Ordering members from largest alignment to smallest removes most padding.

## How big is std::string with libstdc++ and with libc++, and why does it hold short strings without the heap?

<!-- /learn/cpp-memory#sizeof-alignment-and-padding -->

32 bytes with GCC's libstdc++ and 24 with LLVM's libc++. Both use the small string optimization: short strings are stored inside the string object itself, with no heap allocation, and the two libraries reserve different amounts of room for it.

<!-- chapter: cpp-pointers -->

## What are the three rules that make a reference safer than a pointer?

<!-- /learn/cpp-pointers#references -->

A reference must be bound to an object when it is created, it cannot be null, and it cannot be re-pointed: after `int& r = x;`, the statement `r = y;` copies the value of `y` into `x`. A reference still does not keep its object alive, so returning a reference to a local dangles.

## What do the C++ Core Guidelines F.16, F.17 and F.60 say about passing arguments?

<!-- /learn/cpp-pointers#four-ways-to-pass-an-argument -->

F.16: pass cheap types by value and other inputs by `const&`. F.17: use a non-const reference for a parameter the function modifies. F.60: prefer a pointer over a reference when "no argument" is a valid option, so the pointer can be `nullptr`.

## What is std::span, and what does it not do?

<!-- /learn/cpp-pointers#four-ways-to-pass-an-argument -->

A C++20 view holding a pointer and a length together, passed by value; `std::span<const float>` is read-only and `std::span<float>` can write. It does not own its elements, so it dangles if the owner goes away, and its `operator[]` does not check bounds in C++20.

## How do you read const float* x versus float* const x?

<!-- /learn/cpp-pointers#const-in-every-position -->

Read right to left from the name. `const float* x` is a pointer to const floats: the function cannot modify the data, and this is the form inputs use, as in `cublasSgemm`'s `const float* A`. `float* const x` is a const pointer to floats: the pointer cannot be re-pointed, but the data can be written.

## What is array-to-pointer decay, and what does it do to sizeof on a parameter?

<!-- /learn/cpp-pointers#raw-arrays-and-how-they-decay -->

In almost every expression a raw array's name turns into a pointer to its first element. A function parameter written as an array, `float a[4]`, is really a pointer, so `sizeof(a)` inside the function is the pointer's 8 bytes, not the array's size, and the length is lost. `std::array`, `std::vector` and `std::span` avoid decay.

## What strides does PyTorch give t = torch.arange(6).reshape(2, 3) and t.T, and is t.T contiguous?

<!-- /learn/cpp-pointers#tensors-are-pointers-with-shapes-and-strides -->

`t` has strides `(3, 1)`: one row down moves 3 elements, one column right moves 1. `t.T` has shape `(3, 2)` and strides `(1, 3)` over the same six floats, so no data moves. `t.T` is not contiguous, because walking along its rows jumps 3 elements at a time, so code that takes a raw `const float*` must check `is_contiguous()` or call `.contiguous()` first.

## How many floating-point operations does a naive M x K by K x N matmul do, and why is B read badly?

<!-- /learn/cpp-pointers#a-naive-matmul-with-pointers -->

2 × M × N × K: one multiply and one add for each combination of i, j and k. Each element of C reads a row of A, which is contiguous, and a column of B, which jumps N floats at every step in row-major order, so every multiply touches a different cache line.

<!-- chapter: cpp-undefined-behavior -->

## What does the C++ standard require of a program run that reaches undefined behavior?

<!-- /learn/cpp-undefined-behavior#what-undefined-means -->

Nothing at all, not even for the operations before the undefined one. So the compiler may assume undefined behavior never happens and transform the code on that basis. Implementation-defined behavior, by contrast, has one documented result per compiler, and unspecified behavior has one of several allowed results.

## Why does int offset = batch * seq * vocab; work with batch 8 but not batch 16, for seq 2,048 and vocab 128,256?

<!-- /learn/cpp-undefined-behavior#the-cases-you-will-meet -->

With batch 8 the product is 2,101,346,304, just under the largest `int`, 2,147,483,647. With batch 16 it is 4,202,692,608, which overflows, and signed overflow is undefined; in practice it usually wraps negative and the kernel indexes far outside the tensor. Compute offsets in `std::int64_t`, casting before the multiplication.

## What is the safe way to read a float from an arbitrary position in a byte buffer?

<!-- /learn/cpp-undefined-behavior#the-cases-you-will-meet -->

Copy the bytes with `std::memcpy(&value, bytes, sizeof value)`. Casting the byte pointer to `const float*` and dereferencing it is undefined twice over: the address may not be 4-byte aligned, and reading through a pointer to an unrelated type breaks the strict aliasing rule. Compilers turn a small `memcpy` into a single load, so it costs nothing.

## Why may return x + 1 > x; print false in Debug and true in Release for the largest int?

<!-- /learn/cpp-undefined-behavior#why-the-optimizer-makes-bugs-appear -->

For the largest `int`, `x + 1` overflows, which is undefined, so the optimizer may assume it never happens, and then the comparison is always true and the function becomes "return true". An unoptimized build usually does the addition on the hardware, which wraps to the most negative `int`, and returns false. The program, not the compiler, is wrong.

## How did GCC remove a null check from the Linux tun driver in 2009?

<!-- /learn/cpp-undefined-behavior#why-the-optimizer-makes-bugs-appear -->

The code read `tun->sk` before testing `tun` for null. Since dereferencing a null pointer is undefined, the compiler concluded `tun` could not be null and deleted the check, which became the exploitable CVE-2009-1897. The kernel has been built with `-fno-delete-null-pointer-checks` ever since.

## How does AddressSanitizer detect a read just past a heap buffer, and what does it cost?

<!-- /learn/cpp-undefined-behavior#tools-that-find-it -->

It keeps shadow memory, one byte describing every eight bytes of the program's memory, and the compiler inserts a shadow check before every load and store. Allocations are surrounded by poisoned redzones, and freed memory is poisoned and quarantined, so an overflow or a use-after-free hits poisoned memory and ASan stops with a report. The Clang documentation gives a typical slowdown of 2x.

## Which sanitizer finds each of these: an uninitialized read, signed overflow, a data race, a heap overflow?

<!-- /learn/cpp-undefined-behavior#tools-that-find-it -->

MemorySanitizer finds uninitialized reads (Clang on Linux only). UndefinedBehaviorSanitizer finds signed overflow, misaligned loads, null dereferences and out-of-bounds indexes into arrays of known size. ThreadSanitizer finds data races. AddressSanitizer finds heap, stack and global overflows, use after free and double free. ASan, MSan and TSan cannot be combined in one build, but ASan and UBSan can.

## Why can a kernel's out-of-bounds write go unnoticed by ASan or compute-sanitizer inside PyTorch?

<!-- /learn/cpp-undefined-behavior#tools-that-find-it -->

Sanitizers check accesses against allocations, not against your tensor's shape. PyTorch's caching allocator carves many tensors out of one large block, so a write past one tensor usually lands inside a neighbor in the same block, which looks legal. Setting `PYTORCH_NO_CUDA_MEMORY_CACHING=1` turns the caching off when you hunt for such bugs.

## When should you use v.at(i) instead of v[i], and what is the middle way?

<!-- /learn/cpp-undefined-behavior#checked-and-unchecked-indexing -->

Use `.at(i)`, which throws `std::out_of_range`, when the index comes from outside the code's control, such as a token id in a request; use `v[i]` in hot loops whose bounds come from the data's own shape. The middle way is a hardened standard library: `_GLIBCXX_ASSERTIONS` for libstdc++ or `_LIBCPP_HARDENING_MODE` for libc++ makes `v[i]` check its index too.

<!-- chapter: cpp-log-analyzer -->

## What is the nearest-rank percentile, and how does it differ from NumPy's default?

<!-- /learn/cpp-log-analyzer#version-1-python -->

The nearest-rank p is the smallest value with at least p% of the values at or below it: in a sorted list of n values, the value at 1-based rank ⌈p × n / 100⌉. It is always a value that really occurred. NumPy's `np.percentile` defaults to linear interpolation, which blends the two neighboring values and can return a latency no request had; `method="inverted_cdf"` gives the nearest-rank result.

## Why does the log analyzer compute percentile ranks with integers, as (permille * n + 999) / 1000?

<!-- /learn/cpp-log-analyzer#version-1-python -->

Floating point can land just above a whole number: `0.55 * 100` is 55.00000000000001, whose ceiling is 56, one rank too high. Adding 999 before integer division by 1000 is an exact ceiling, so Python and C++ get the same rank for every n. In C++ the product must be 64-bit, because 999 × 5,000,000 overflows a 32-bit `int`.

## Why must an unordered_map built while reading lines with getline own std::string keys rather than string_view keys?

<!-- /learn/cpp-log-analyzer#version-2-c-file-by-file -->

A `string_view` points into the line buffer, and the next `getline` overwrites that buffer, so every key would silently change to whatever the latest line holds. AddressSanitizer may not catch it, because the buffer is still allocated. Copy the field into a `std::string` key; reusing one key string with `assign` avoids an allocation per line.

## Why parse numeric fields with std::from_chars instead of std::stoi or a stringstream?

<!-- /learn/cpp-log-analyzer#version-2-c-file-by-file -->

`from_chars` works on a character range, so it needs no copy of the field, never allocates or throws, ignores the locale, does not skip spaces, and returns where it stopped, so the code can require the whole field to be digits. `stoi` needs a `std::string`, skips leading spaces, accepts trailing junk such as `12abc`, and throws on errors. A `stringstream` is flexible but slow.

## What does std::nth_element do, and why is it enough for percentiles?

<!-- /learn/cpp-log-analyzer#version-2-c-file-by-file -->

It rearranges a range so the element at position nth is the one that would be there after sorting, with nothing larger before it and nothing smaller after, in linear time on average. A percentile needs only the value at one rank, so a full O(n log n) sort is unnecessary, and with increasing ranks each search can start at the previous answer.

## Why should tests not rely on assert, and what are four rules for timing two programs fairly?

<!-- /learn/cpp-log-analyzer#timing-it-fairly -->

CMake's Release build defines `NDEBUG`, which turns every `assert` into nothing, so the tests would check nothing; use your own check macro. To time fairly: build in Release, warm the file cache and run several times, time the whole program and its phases (with `std::chrono::steady_clock` in C++), and check the output every time, since a faster wrong answer is not faster.
