# Undefined behavior

Here is a bug that every ML systems engineer meets sooner or later. A custom kernel computes the mean of each row of an activation matrix. It compiles without a warning, it runs without a crash, and it returns numbers that look entirely reasonable. The model's accuracy drops by half a point, and nobody can say why. Two weeks later someone notices that the inner loop says `c <= cols` where it should say `c < cols`, so every row's sum included one element too many, which for every row but the last was the first element of the next row. Nothing crashed, because almost all of those extra reads stayed inside the same buffer. The answer was simply wrong.

In Python the same mistake is impossible to miss. Index past the end of a list and you get `IndexError` with a line number. Add two integers that are too big and Python makes room for the result. Use a variable before assigning it and you get `NameError`. C++ makes none of these checks. When a program indexes past the end of an array, reads freed memory or overflows a signed integer, the C++ standard says the behavior is **undefined**: the language makes no promise about what happens next. The program may crash, may print a wrong answer, may print the right answer today and a wrong one after a compiler upgrade, or may do something stranger still.

This chapter explains what undefined behavior is and why C++ has it, walks through the cases you will actually meet, shows why turning on the optimizer makes hidden bugs appear, and then introduces the tools that find them: compiler warnings, AddressSanitizer, UndefinedBehaviorSanitizer, and the standard library's own checks. The lab commits eight bugs on purpose and lets the tools explain each one.

## What "undefined" means

The C++ standard sorts the behavior of programs into a few kinds, and the differences matter:

| Kind                   | What the standard says                                           | Example                                              |
| ---------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| Well defined           | Exactly one result                                               | `7 / 2` is 3                                         |
| Implementation-defined | Each compiler picks a result and documents it                    | `sizeof(long)` is 8 on Linux and 4 on 64-bit Windows |
| Unspecified            | One of several results, and the compiler need not tell you which | the order in which `f(a(), b())` calls `a` and `b`   |
| Undefined              | No requirements at all                                           | reading `v[10]` from a 10-element array              |

The last row is stronger than it looks. Undefined behavior does not mean "you get some garbage value". The standard's section on program execution says that once a run of the program reaches undefined behavior, it places no requirement on that run, "not even with regard to operations preceding the first undefined operation". A compiler is therefore allowed to assume that undefined behavior never happens, and to transform your code on that assumption. Most of the strange effects later in this chapter come from that one rule.

Why would a language be designed this way? Because every check costs time, and C++ was designed so that you pay only for what you ask for. If every `v[i]` had to check `i` against the size, every inner loop of every matmul would carry a compare and a branch. If signed overflow had to wrap, the compiler could not assume that `i + 1 > i` in a loop counter, and it would lose optimizations that matter, such as turning a 32-bit loop index into a 64-bit pointer increment. Leaving these cases undefined lets the compiler generate the fastest code for correct programs. The price is that incorrect programs can behave in any way at all, and the job of finding the incorrect parts falls on you and your tools.

That price is not theoretical. The Chromium project reports that around 70% of its serious security bugs are memory safety bugs, which is to say undefined behavior of the kinds below. In ML systems the more common symptom is quieter: numbers that look plausible and are wrong.

## The cases you will meet

Most undefined behavior in real code falls into a handful of patterns. Each one below has a mode in the lab.

### Reading or writing out of bounds

Accessing an array, a `std::vector` through `[]`, or any buffer through a pointer outside its bounds is undefined. What actually happens depends on what lies next to the buffer. Here is the row-mean bug from the start of the chapter, in the form the lab uses:

```cpp
std::vector<float> m(rows * cols);       // a rows x cols matrix, stored row by row
const float* data = m.data();
for (int r = 0; r < rows; ++r) {
  float sum = 0.0f;
  for (int c = 0; c <= cols; ++c)        // the bug: <= instead of <
    sum += data[r * cols + c];
  means[r] = sum / cols;
}
```

For every row except the last, the extra element is the first element of the next row. That read is a bug in your program, but it is not undefined behavior as far as the language is concerned, because it stays inside the vector's buffer, so no tool that checks memory can see anything wrong. Only the last row reads past the end of the buffer, and that single read is undefined behavior. Whether it crashes depends on whether the next bytes belong to the program. Usually they do, so the program reads whatever happens to be there and carries on. This is the shape of most out-of-bounds bugs in tensor code: an off-by-one in a loop bound, an index computed with the wrong stride, or a shape that does not match the buffer.

Writes are worse than reads, because they corrupt whatever lives next door. A stack array written one past its end can overwrite another local variable or the function's saved return address. A heap buffer written past its end can overwrite the allocator's bookkeeping, and the program then crashes much later, inside an unrelated `new` or `delete`, far from the line that caused it.

### Use after free and dangling references

[Chapter 3](/learn/cpp-memory#dangling-a-pointer-that-outlives-its-object) showed the classic case: a pointer into a `std::vector` that has since grown and moved its elements. Any pointer, reference or view that outlives the object it refers to dangles, and using it is undefined. One version deserves special mention because modern C++ makes it easy to write:

```cpp
std::string make_prompt();

std::string_view view = make_prompt();   // the std::string returned here is a temporary
std::printf("%c\n", view[0]);            // the temporary was destroyed at the end of the line above
```

A `std::string_view` is a pointer and a length that refers to characters owned by someone else, much like the `std::span` of chapter 4. Here the owner is a temporary `std::string`, which is destroyed at the end of the statement that created it, so the view refers to freed memory from the very next line. Tokenizers and request parsers in inference servers pass `string_view`s around precisely because they avoid copies, so this bug appears in exactly the code that cares most about speed. Clang notices this simple case and warns with `-Wdangling-gsl`, which is on by default. Most dangling views are not this simple, and no compiler warns about them.

### Freeing twice

Calling `delete` twice on the same pointer, or `delete` on a pointer that did not come from `new`, is undefined. It usually happens when two parts of a program each believe they own a buffer. Modern allocators catch some cases themselves: glibc's allocator aborts with a message that begins `free(): double free detected` for small blocks, and macOS's allocator aborts with a message saying that the pointer being freed was not allocated. Neither is guaranteed, and in the bad case the second `delete` succeeds and corrupts the allocator's lists, so that two later allocations receive the same memory. Chapter 8's smart pointers exist largely to make ownership clear enough that this cannot happen.

### Reading uninitialized memory

[Chapter 2](/learn/cpp-syntax#a-variable-you-forgot-to-initialize) introduced this one: a local variable of a built-in type without an initializer holds whatever bits were already in its memory, and reading it is undefined.

```cpp
float sum;                      // no initializer
for (int i = 0; i < n; ++i) sum += x[i];
```

The result depends on what the stack held before, so it can differ between runs, between Debug and Release builds, and between machines, which makes it one of the hardest bugs to reproduce. The same applies to a `struct` member you forgot to set and to memory from `new float[n]`, which is not zeroed. Compilers often warn about the simple cases with `-Wall`. The C++26 standard changes the rules for local variables: reading one before it is set becomes **erroneous behavior**, which is still a bug that compilers are encouraged to diagnose, but no longer undefined, and the variable holds some fixed value instead of anything at all. Until your compiler implements it, both GCC and Clang offer `-ftrivial-auto-var-init=zero`, which zeroes uninitialized locals and is used in hardened builds of some large projects. The habit that prevents the bug costs nothing: write `float sum = 0.0f;`.

### Signed integer overflow

As chapter 2 explained, unsigned arithmetic wraps, but overflowing a signed integer is undefined. In AI infrastructure the classic trigger is an index or an offset computed in `int`. Take the logits of a batch: a tensor of shape `[batch, seq, vocab]`. With a sequence length of 2,048 and Llama 3's vocabulary of 128,256 tokens, the number of elements is:

- batch 8: 8 × 2,048 × 128,256 = 2,101,346,304, just under the largest `int`, 2,147,483,647;
- batch 16: 4,202,692,608, nearly twice the largest `int`.

So `int offset = batch * seq * vocab - 1;` works in every test with batch 8 and is undefined in production with batch 16. On real hardware the multiplication usually wraps, giving a negative offset, and the kernel then reads or writes far outside the tensor. [Chapter 4](/learn/cpp-pointers#a-naive-matmul-with-pointers) met the same problem in matmul indexes, which is why PyTorch checks whether a tensor is small enough for 32-bit index math before choosing a kernel. The fix is to compute sizes and offsets in a 64-bit type, `std::int64_t` or `std::size_t`, and to cast before multiplying, not after: `static_cast<std::int64_t>(batch) * seq * vocab`.

### Misaligned and type-punned loads

Binary formats tempt you to read numbers straight out of a byte buffer:

```cpp
const unsigned char* bytes = file_data + header_size;
float scale = *reinterpret_cast<const float*>(bytes);   // two problems
```

This line has two problems. First, a `float` must sit at an address that is a multiple of 4, as chapter 3 explained, and if `header_size` is odd, it does not. x86-64 and ARM64 processors both load a misaligned float correctly in ordinary code, so nothing visible goes wrong on a laptop, but the behavior is undefined, the compiler may generate vector instructions that do require alignment, and some processors fault. Second, the bytes are not a `float` object as far as the language is concerned, and reading memory through a pointer to an unrelated type breaks the **strict aliasing** rule, which lets the compiler assume that a `float*` and an `int*` never point at the same memory. The portable fix for both is to copy the bytes into a real variable:

```cpp
float scale;
std::memcpy(&scale, bytes, sizeof scale);         // correct for any alignment, and free in practice
std::uint32_t bits = std::bit_cast<std::uint32_t>(scale);   // C++20: the bits of a float, as chapter 2 showed
```

Compilers recognise a small `memcpy` like this and turn it into a single load, so the safe version costs nothing. Chapter 21 returns to this when it reads weight files with `mmap`.

### Data races

Two threads accessing the same memory at the same time, with at least one of them writing and nothing ordering the accesses, is a data race, and a data race is undefined behavior too. `++counter` from two threads can lose updates, and worse things can happen when the optimizer keeps a value in a register that another thread is changing. Part IV of the course is about doing this correctly, and chapter 16 introduces ThreadSanitizer, the tool that finds races.

## Why the optimizer makes bugs appear

A common experience in C++ goes like this. The program works in a Debug build. You switch to Release, and the answers change or the program hangs. It is tempting to blame the compiler, but in almost every case the program had undefined behavior all along, and the optimizer made it visible.

The reason is the rule from the first section. The optimizer assumes your program never has undefined behavior, and it uses that assumption to prove things about your code. Chapter 2 promised an example, and here it is:

```cpp
bool next_is_bigger(int x) { return x + 1 > x; }
```

For every `x` except the largest `int`, this is true. For the largest `int`, `x + 1` overflows, which is undefined, so the compiler may assume it never happens. Under that assumption, `x + 1 > x` is always true, and GCC and Clang with optimization compile the whole function to "return true". In an unoptimized build, the addition usually happens on the hardware, wraps to the most negative `int`, and the function returns false for the largest `int`. Neither compiler is wrong, because the program asked a question that has no answer. The lab's `optimizer.cpp` shows both results.

The same reasoning has removed safety checks in real software. In 2009, the Linux kernel's `tun` network driver contained code of this shape:

```c
struct sock *sk = tun->sk;    // dereferences tun
if (!tun) return POLLERR;     // checks tun for null, too late
```

Because `tun` had already been dereferenced on the first line, the compiler reasoned that it could not be null, since dereferencing a null pointer is undefined, and it deleted the check. An attacker who could arrange for `tun` to be null and map memory at address 0 could then take over the machine. The bug became CVE-2009-1897, and the kernel has been built with GCC's `-fno-delete-null-pointer-checks` ever since.

Loops are affected too. In 2012, a GCC developer found that a new GCC version turned a loop in the SPEC CPU 2006 benchmark `464.h264ref` into an infinite loop. The loop's increment read `d[16]`, one past the end of a 16-element array, just before the test that would have ended the loop. Since that read is undefined, the compiler concluded that the loop must exit before the index reached 16, and it removed the exit test. The bug report was closed as invalid, because the benchmark, not the compiler, was at fault. The lesson for you is that "it works in Debug" is no evidence that a program is correct, and "it broke after a compiler upgrade" usually means a bug was already there.

## Tools that find it

You cannot find undefined behavior by reading output, because a program with undefined behavior often produces correct-looking output. You find it with tools, and they come in three layers: compiler warnings, which cost nothing; sanitizers, which instrument the program to check it as it runs; and checks inside the standard library itself.

### Compiler warnings come first

Every lab in this course compiles with `-Wall -Wextra -Wpedantic`, and that is the cheapest bug detector you have. Compilers warn about many of the simple cases: uninitialized variables, a `string_view` bound to a temporary, returning a reference to a local, comparing signed and unsigned values, and indexes that are out of bounds when both the index and the array size are known at compile time. Projects that care add `-Werror` in continuous integration, so that a warning fails the build instead of scrolling past. Warnings can only see what is visible at compile time, though, and most real bugs depend on values that arrive at run time.

### AddressSanitizer

**AddressSanitizer**, or ASan, finds memory errors at run time: out-of-bounds reads and writes on the heap, the stack and global variables, use after free, use of a stack variable after its scope ends, and double free. You turn it on with one flag, `-fsanitize=address`, at both compile and link time, and it works with both GCC and Clang, including Apple's Clang.

It works by keeping a second, smaller map of memory, called **shadow memory**, in which one byte describes eight bytes of the program's memory: whether they are valid to access. The compiler inserts a check of the shadow before every load and store. Each allocation is surrounded by small poisoned areas called **redzones**, so that a read just past the end of a buffer lands on poisoned memory, and freed memory is poisoned and held in a quarantine for a while before it is reused, so that a use after free also lands on poisoned memory. When a check fails, ASan stops the program and prints a report. The cost is real but modest: the Clang documentation gives a typical slowdown of 2x, which is fine for tests and debugging but not for production.

An ASan report is long, and knowing where to look saves time. It has four parts:

1. A headline that names the kind of error, such as `ERROR: AddressSanitizer: heap-buffer-overflow` or `heap-use-after-free`, followed by whether it was a read or a write and how many bytes.
2. The stack trace of the bad access. The first frame in your own code is almost always the line to fix.
3. A description of the memory involved: for an overflow, how many bytes past the end of which allocation the access landed; for a use after free, a second stack trace showing where the memory was freed and a third showing where it was allocated.
4. A map of the shadow memory around the address, which you can usually skip.

Build with `-g`, which CMake's Debug build type does for you, so that the traces show file names and line numbers, and keep `-fno-omit-frame-pointer`, so that the traces are complete.

### UndefinedBehaviorSanitizer

**UndefinedBehaviorSanitizer**, or UBSan, checks for undefined operations that are not about memory: signed integer overflow, division by zero, shifts by too many bits, misaligned loads and stores, dereferencing a null pointer, converting a float that is too large into an integer, and indexing an array out of bounds when the array's size is known to the compiler. You turn it on with `-fsanitize=undefined`. Its slowdown is small, so many projects run it alongside ASan, and `-fsanitize=address,undefined` builds both into one program. Its reports are one line each. Here is the one Clang's UBSan should print for the lab's `overflow 16` mode, after the full path of the file:

```text
ub_zoo.cpp:101:26: runtime error: signed integer overflow: 32768 * 128256 cannot be represented in type 'int'
```

By default UBSan prints the error and lets the program continue, so one run can report several problems. In tests you usually want the first error to fail the run instead, which `-fno-sanitize-recover=all` does.

### The others: MemorySanitizer, ThreadSanitizer and Valgrind

Three more tools cover the gaps:

- **MemorySanitizer** (`-fsanitize=memory`) finds reads of uninitialized memory, which neither ASan nor UBSan checks. It works only with Clang and only on Linux and a few BSDs, not on macOS, and it needs every library in the program, including the C++ standard library, to be built with it, or it reports false errors.
- **ThreadSanitizer** (`-fsanitize=thread`) finds data races. Chapter 16 uses it. It slows a program much more than ASan does, by 5x to 15x according to the Clang documentation.
- **Valgrind**'s Memcheck tool runs an unmodified program on a simulated processor and catches out-of-bounds heap accesses, use after free, leaks and reads of uninitialized values, all without recompiling. It is far slower than the sanitizers, often tens of times, and it runs on Linux but not on Apple silicon Macs.

ASan, MemorySanitizer and ThreadSanitizer each need their own shadow memory, so you cannot combine any two of them in one build. The usual arrangement in continuous integration is one build with ASan and UBSan together, one with ThreadSanitizer, and, on Linux with Clang, one with MemorySanitizer. Large C++ projects in AI infrastructure work this way: PyTorch's continuous integration includes AddressSanitizer builds, and llama.cpp's CMake files have options such as `LLAMA_SANITIZE_ADDRESS`, `LLAMA_SANITIZE_UNDEFINED` and `LLAMA_SANITIZE_THREAD`.

### What sanitizers cannot see

Sanitizers are powerful, and it is worth knowing exactly where they stop.

**They check only the code that runs.** A sanitizer instruments the program and watches it execute, so a bug on a path your test never takes stays hidden. The lab's `overflow` mode is clean for batch 8 and reports an error only for batch 16. Sanitizers are as good as the inputs you run them with.

**They check allocations, not your intentions.** ASan knows where each allocation starts and ends. It does not know that your buffer holds a matrix, or where one row stops and the next begins. In the row-mean bug, the extra reads for the first rows stay inside the buffer, and ASan says nothing about them. It reports only the last row's read, because that one leaves the allocation. Fixing the line ASan points at fixes all the rows, but only because the same loop produced every read.

**Memory pools hide bugs from them.** The same blindness grows with the size of the allocation. PyTorch's caching allocator and vLLM's KV cache, which chapter 3 described, take one large block of GPU memory and hand out pieces of it. A kernel that writes past the end of its tensor usually lands inside a neighboring tensor in the same block, so a memory checker that watches allocations sees a perfectly legal access. NVIDIA's `compute-sanitizer`, the GPU counterpart of ASan, has the same limit, which is why PyTorch lets you turn its caching allocator off with the environment variable `PYTORCH_NO_CUDA_MEMORY_CACHING=1` when you hunt for this kind of bug. Part VI of the course uses `compute-sanitizer`.

Now test your sense of which tool catches what. Each snippet below has exactly one bug. Decide which sanitizer reports it when the code runs, assuming the buggy line executes with the values shown.

```widget
ub-detective
```

## Checked and unchecked indexing

`std::vector` offers two ways to read an element. `v[i]` does no checking at all: if `i` is out of range, the behavior is undefined, exactly as with a raw pointer. `v.at(i)` checks `i` against `v.size()` and throws a `std::out_of_range` exception if it is out of range, which stops the program with a message if nothing catches it. Chapter 12 explains exceptions. The check costs a compare and a branch, which is negligible in most code and noticeable in the innermost loop of a kernel.

So which should you use? The answer most codebases settle on is `[]` in hot loops whose bounds you control, and `.at()`, or an explicit check, wherever an index comes from outside: from a file, a network request, a user, or a model's output. A token id that arrives in a request and is used to index the embedding table should be checked, because a client can send any number. Inside the matmul loop, where the bounds come from the matrix's own shape, `[]` is fine.

`.at()` checks only the vector's own bounds, so the row-mean bug written with `m.at(r * cols + c)` would still compute wrong means for the first rows and throw only on the last row, exactly where ASan complained. Neither tool can know your matrix's shape. That is a reason to write tensor code with an index function that knows the shape, as chapter 4's `View` did, so that a check there can compare `c` against the number of columns.

There is also a middle way. Both major standard libraries can check `[]` and many other preconditions themselves, with a compile-time switch:

- GCC's libstdc++ checks them when you define `_GLIBCXX_ASSERTIONS`, and aborts with a message when one fails.
- LLVM's libc++, which Apple's Clang uses, has **hardening modes** selected with `_LIBCPP_HARDENING_MODE`. The `fast` mode checks element access such as `v[i]`, and the libc++ documentation recommends it for production use because it is cheap. Older libc++ versions do not know this macro and silently ignore it, so check that it works, as the lab does.

The lab's `LAB_HARDEN` option turns both on. These checks are cheap enough that some companies ship them in production, and C++26 adds standard library hardening to the language standard itself.

## Lab: eight bugs and the tools that explain them

The lab is two programs: [`ub_zoo.cpp`](/labs/cpp/cpp-undefined-behavior/ub_zoo.cpp), which commits one bug per mode, and [`optimizer.cpp`](/labs/cpp/cpp-undefined-behavior/optimizer.cpp), whose answer changes with the optimization level. [`CMakeLists.txt`](/labs/cpp/cpp-undefined-behavior/CMakeLists.txt) builds both and has two options, `LAB_SANITIZE` for ASan and UBSan and `LAB_HARDEN` for the standard library's checks. You need only a C++20 compiler and CMake. Build three versions side by side:

```bash
cmake -S . -B build     -DCMAKE_BUILD_TYPE=Debug                    && cmake --build build
cmake -S . -B build-san -DCMAKE_BUILD_TYPE=Debug -DLAB_SANITIZE=ON  && cmake --build build-san
cmake -S . -B build-rel -DCMAKE_BUILD_TYPE=Release                  && cmake --build build-rel
```

### Part 1: read the warnings

Before running anything, read the warnings from the first build. Clang should warn that the `string_view` in `dangling_view` refers to an object destroyed at the end of the statement, and GCC or Clang will probably warn that `sum` in `uninit` is used uninitialized. Note which bugs produced no warning at all. Those are the ones that depend on values the compiler cannot see.

<!-- measure: the warnings printed by the Debug build of ub_zoo and optimizer with Apple clang (and GCC on Linux if available), and which modes got no warning -->

### Part 2: run the zoo without help

Run every mode with the plain Debug build and write down what happens:

```bash
./build/ub_zoo row-means
./build/ub_zoo stack-oob
./build/ub_zoo dangling-view
./build/ub_zoo double-free
./build/ub_zoo uninit
./build/ub_zoo overflow 8
./build/ub_zoo overflow 16
./build/ub_zoo misaligned
./build/ub_zoo at
```

Expect most of them to finish as if nothing were wrong. `row-means` prints its means next to the correct ones, and the first two rows are too large, because each sum includes the first element of the next row: row 0 should show 3.75 where 2.50 is correct, and row 1 should show 8.75 where 6.50 is correct. The last row's mean depends on whatever lies past the buffer. `overflow 16` prints a negative `int` offset next to the correct 64-bit one, while `overflow 8` is correct. `double-free` is the mode most likely to be stopped by the allocator itself. `at` throws, but only when the index leaves the vector, on the last row, after printing two wrong means.

<!-- measure: the output of each mode in the plain Debug build on the Mac, including any abort message from the allocator for double-free -->

### Part 3: run the zoo with the sanitizers

Now run the same modes from `build-san`. ASan stops the program at the first memory error, so run each mode separately. For each one, find the headline, the first frame in `ub_zoo.cpp`, and, for the use after free, the frames that show where the memory was freed and allocated. Then fill in a table with three columns, one for each kind of report: ASan, UBSan, or nothing. You should find that ASan reports `row-means` (on the last row only), `stack-oob`, `dangling-view` and `double-free`, that UBSan reports `overflow 16` and `misaligned`, and that `stack-oob` may be reported by UBSan as well, because the array's size is known. `uninit` should pass both sanitizers silently, since neither checks for it. On Linux with Clang, you can rebuild with `-fsanitize=memory` instead and watch MemorySanitizer report it.

<!-- measure: the headline and the first ub_zoo.cpp frame of each sanitizer report on the Mac, and the completed three-column table -->

### Part 4: Debug versus Release

Run `optimizer` from both the Debug and the Release build:

```bash
./build/optimizer 2147483647
./build-rel/optimizer 2147483647
./build/optimizer 5
./build-rel/optimizer 5
```

With 5, both builds should agree. With the largest `int`, `next_is_bigger` should print false in the Debug build, where the addition wraps on the hardware, and true in the Release build, where the optimizer has replaced the function with "return true". GCC sometimes simplifies the comparison even without optimization, so with GCC both builds may print true. `next_is_bigger_safe` asks the same question without overflowing, and it is false in every build. `doublings` counts how many times a number can be doubled before it overflows. The loop's only real exit is the overflow, and the optimizer is allowed to assume that a positive number doubled stays positive, so a Release build may report a different count, possibly the safety limit of 100, than the Debug build does. Whatever you see, the source code has not changed, and only the optimizer's assumptions differ. Then run `./build-san/optimizer 2147483647` and read UBSan's reports, which name the overflowing line in each function.

<!-- measure: the output of optimizer for 2147483647 and 5 in Debug, Release and the sanitizer build, with the compiler used -->

### Part 5: the standard library's own checks

Build a fourth version with the standard library's checks on and no sanitizers, and run the row-mean bug through it, after changing the loop in `row_means` to index the vector with `m[r * kCols + c]` instead of the raw pointer:

```bash
cmake -S . -B build-harden -DCMAKE_BUILD_TYPE=Debug -DLAB_HARDEN=ON && cmake --build build-harden
./build-harden/ub_zoo row-means
```

The program should now stop on the last row with a message from the library, or with a trap in libc++'s fast mode, which prints little or nothing. If it still runs to the end, your standard library does not support the checks this way, which is worth noting.

<!-- measure: what build-harden/ub_zoo row-means does with the m[] change, on the Mac (libc++) and on Linux (libstdc++) if available -->

### Stretch goals

- Fix every bug in `ub_zoo.cpp`, then run all modes under the sanitizer build until none reports anything. Remember that a clean run proves only that these inputs are clean.
- Add `-fno-sanitize-recover=all` to the sanitizer flags in `CMakeLists.txt` and see how UBSan's behavior changes for `overflow 16`.
- Run `./build-san/ub_zoo misaligned 0` and `misaligned 4`. UBSan stays quiet because those addresses are aligned. Explain why the cast is still undefined, according to the strict aliasing rule, and why the `memcpy` version is correct for every offset.
- Add `-fwrapv` to the Release build of `optimizer` and run it again. The flag defines signed overflow to wrap, so the optimizer can no longer assume it away. Some projects build with it, or with the related `-fno-strict-overflow`, which the Linux kernel uses.

## Check yourself

<details>
<summary>What is the difference between implementation-defined, unspecified and undefined behavior?</summary>

Implementation-defined behavior has one result chosen and documented by each compiler, such as `sizeof(long)`. Unspecified behavior has one of several allowed results, and the compiler need not say which, such as the order in which a function's arguments are evaluated. Undefined behavior has no requirements at all: the standard says nothing about what the whole run of the program does, and the compiler may assume it never happens.

</details>

<details>
<summary>A program gives correct results in Debug and wrong results in Release. Why is "the optimizer has a bug" usually the wrong first guess?</summary>

The optimizer assumes the program has no undefined behavior and transforms the code on that assumption. If the program overflows a signed integer, reads out of bounds or reads uninitialized memory, the optimized code is allowed to behave differently from the unoptimized code, and both are correct translations of a program that has no defined meaning. Compiler bugs exist, but undefined behavior in the program is far more common, and running the Debug build under ASan and UBSan is the quickest way to find it.

</details>

<details>
<summary>A kernel computes row means with c &lt;= cols. ASan reports one heap-buffer-overflow, on the last row. Are the other rows' means correct?</summary>

No. Every row reads one element too many, but for every row except the last, the extra element is the first element of the next row, which is still inside the buffer, so ASan cannot see anything wrong. ASan checks the bounds of allocations, not the shape of your data. Fixing the loop bound fixes every row.

</details>

<details>
<summary>Why does int offset = batch * seq * vocab; pass every test with batch 8 and fail in production with batch 16, for seq 2,048 and vocab 128,256?</summary>

With batch 8 the product is 2,101,346,304, just under the largest 32-bit `int`, 2,147,483,647. With batch 16 it is 4,202,692,608, which overflows, and signed overflow is undefined. In practice the value usually wraps to a negative number and the kernel indexes far outside the tensor. Computing the offset in `std::int64_t`, casting before the multiplication, fixes it. UBSan reports it, but only for a run that actually uses batch 16.

</details>

<details>
<summary>Which tool would you use to find a read of an uninitialized variable, and why not AddressSanitizer?</summary>

MemorySanitizer, on Linux with Clang, or Valgrind's Memcheck. AddressSanitizer tracks which memory is valid to access, not whether it has been written, so reading an uninitialized but validly allocated variable looks fine to it. A compiler warning such as `-Wuninitialized` catches the simplest cases, and `-ftrivial-auto-var-init=zero` removes the randomness for local variables.

</details>

<details>
<summary>When should you write v.at(i) instead of v[i]?</summary>

When the index comes from outside the code's control, such as a file, a request, a user or a model's output: for example a token id from a client used to index an embedding table. There, a check that throws is far better than undefined behavior. In inner loops whose bounds come from the data's own shape, `v[i]` avoids the cost of the check, and a hardened standard library build or the sanitizers can check those accesses during testing.

</details>

## Further reading

- [cppreference: undefined behavior](https://en.cppreference.com/w/cpp/language/ub) defines the four kinds of behavior and shows examples of optimizations that rely on undefined behavior.
- [What Every C Programmer Should Know About Undefined Behavior](https://blog.llvm.org/2011/05/what-every-c-programmer-should-know.html), a three-part series by Chris Lattner on the LLVM blog, explains why compilers exploit undefined behavior and what that buys in speed.
- [A Guide to Undefined Behavior in C and C++](https://blog.regehr.org/archives/213), by John Regehr, is a careful explanation from a researcher who has spent years finding these bugs in real compilers and programs.
- [Fun with NULL pointers](https://lwn.net/Articles/342330/), on LWN, tells the story of the Linux `tun` driver bug in detail, and [GCC bug 53073](https://gcc.gnu.org/PR53073) is the discussion of the `h264ref` infinite loop.
- The Clang documentation for [AddressSanitizer](https://clang.llvm.org/docs/AddressSanitizer.html), [UndefinedBehaviorSanitizer](https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html), [MemorySanitizer](https://clang.llvm.org/docs/MemorySanitizer.html) and [ThreadSanitizer](https://clang.llvm.org/docs/ThreadSanitizer.html) lists what each tool checks, its cost and the platforms it supports.
- [libc++ hardening modes](https://libcxx.llvm.org/Hardening.html) documents the checks in LLVM's standard library and how to enable them.
- [P2795R5, Erroneous behaviour for uninitialized reads](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2024/p2795r5.html) is the C++26 proposal that changes the rules for uninitialized local variables.
- [Chromium's memory safety page](https://www.chromium.org/Home/chromium-security/memory-safety/) gives the figure that about 70% of the project's serious security bugs are memory safety problems.
- [NVIDIA Compute Sanitizer](https://docs.nvidia.com/compute-sanitizer/ComputeSanitizer/index.html) is the GPU counterpart of these tools, used in Part VI.
