# The toolchain and the compilation model

Sooner or later every AI infrastructure engineer types `cmake --build` on someone else's project and gets a wall of red text: llama.cpp with a new backend switched on, a PyTorch extension against a fresh CUDA version, or vLLM's kernels after a compiler upgrade. The people who fix these quickly are not the ones who memorised the most C++. They are the ones who can look at the first error and say which tool produced it: the preprocessor, the compiler, the linker, the loader that starts the program, or CMake before any of them. Each of those tools fails for its own reasons, and once you know which one is complaining, the cause is usually one of two or three things.

Python hides all of this. You run `python script.py`, and the interpreter reads your file, compiles it to bytecode behind your back, and looks up every name at the moment it is used. A misspelled function name in Python is a `NameError` when that line runs, perhaps an hour into a job. In C++, nothing runs until a whole chain of tools has turned every source file into machine code and joined the pieces into one executable, and every name must be resolved before the program starts. That is more work up front, and it is also why a C++ program can start fast and run without an interpreter in the loop.

This chapter walks the chain one stage at a time: what each stage takes in and produces, the rules that decide where code may live (headers, source files and the one-definition rule), how CMake describes a build so you do not type compiler commands by hand, and the flags that separate a Debug build from a Release build. The lab builds a three-file library by hand, stage by stage, then with CMake, then breaks it on purpose so you can watch each stage fail.

## From source file to running program

A C++ program is usually several source files (`.cpp`) plus header files (`.h` or `.hpp`) that the source files include. The command you type, `clang++` or `g++`, is a **driver**: a small program that runs the real tools in order and passes each one's output to the next.

```diagram
title: How two source files become one program
[main] main.cpp @ 0,0
[vec] vec.cpp @ 0,1
[pp1] Preprocessor @ 1,0
[pp2] Preprocessor @ 1,1
[cc1] Compiler @ 2,0
[cc2] Compiler @ 2,1
[o1] main.o @ 3,0
[o2] vec.o @ 3,1
[ld] Linker @ 4,0.5
[exe] demo @ 4,1.5
main -> pp1
vec -> pp2
pp1 -> cc1
pp2 -> cc2
cc1 -> o1
cc2 -> o2
o1 -> ld
o2 -> ld
ld -> exe
```

Here is what each stage does:

1. **The preprocessor** handles every line that starts with `#`. It pastes in included files, expands macros and drops code that `#if` switches off. Its output is one long file of plain C++, called a **translation unit**.
2. **The compiler** parses the translation unit, checks every type, optimizes the code and emits machine code. An assembler step turns that into an **object file** (`.o`). Each source file is compiled on its own, without looking at the others, which is why big projects can compile hundreds of files in parallel.
3. **The linker** takes all the object files and libraries and joins them into one executable. Its main job is to match every use of a function or global variable in one object file with the single place where it is defined.
4. **The loader** is part of the operating system. When you run the program, it maps the executable into memory, finds the shared libraries the program needs, and jumps to `main`.

You can stop the driver after any stage and look at what it produced. The lab does this for every stage:

| Stage | Command (Clang; GCC takes the same flags) | Output |
|---|---|---|
| Preprocess only | `clang++ -E main.cpp -o main.ii` | The translation unit, as text |
| Compile to assembly | `clang++ -S main.cpp -o main.s` | Human-readable assembly |
| Compile and assemble | `clang++ -c main.cpp -o main.o` | An object file |
| Link | `clang++ main.o vec.o -o demo` | An executable |

Most real builds use `-c` for each source file and one link step at the end, so that changing one file means recompiling only that file and relinking. CMake, below, arranges exactly that.

## The preprocessor pastes text

The preprocessor knows nothing about C++. It works on text, and its most important directive is the bluntest one: `#include "tinymath/vec.h"` means "replace this line with the entire contents of that file". Angle brackets, as in `#include <vector>`, search the system and library include directories; quotes search the current file's directory first, then the same places. The `-I` flag adds a directory to the search, so `-I include` lets `"tinymath/vec.h"` be found in `include/tinymath/vec.h`.

Because including is pasting, every source file that includes `<iostream>` gets the full text of that header and of everything it includes in turn, and the compiler parses all of it again for every file. Running `clang++ -E` on a short file that includes a few standard headers typically produces tens of thousands of lines. This is one of the main reasons large C++ projects take a long time to build, and it is what C++20 modules (and `import std;` in C++23) are designed to fix, although compiler and build-system support for them is still uneven.

<!-- measure: run clang++ -std=c++20 -Iinclude -E src/main.cpp -o main.ii in the chapter 1 lab and record `wc -l main.ii`, with the compiler version; optionally the same with g++ -->

The other directives you will meet constantly:

- `#define NAME value` creates a macro, and the preprocessor replaces `NAME` with `value` everywhere after it. Modern C++ prefers `constexpr` variables for constants, which Chapter 2 covers, but macros remain common for configuration, such as `#ifdef GGML_USE_CUDA` in llama.cpp's code.
- `#if`, `#ifdef`, `#else` and `#endif` keep or drop blocks of code before the compiler sees them. This is how one source tree builds for CUDA, Metal or plain CPU.
- `-D NAME=value` on the command line defines a macro for the whole translation unit. The most important one is `NDEBUG`: when it is defined, the standard `assert` macro expands to nothing, so the checks disappear.
- `#error "message"` stops the build with a message. The lab's header uses it to refuse to build with a language version older than C++20.

### Include guards

Because headers are pasted, the same header can easily arrive twice in one translation unit: `main.cpp` includes `a.h` and `b.h`, and both of those include `shape.h`. If `shape.h` defines a struct, the compiler then sees that struct defined twice in one file and stops with "redefinition of 'Shape'". The classic fix is an **include guard**, a macro that makes the second paste empty:

```cpp
#ifndef TINYMATH_SHAPE_H
#define TINYMATH_SHAPE_H

struct Shape {
  int rows;
  int cols;
};

#endif
```

The shorter form is `#pragma once` as the first line of the header. It is not part of the C++ standard, but GCC, Clang and MSVC all support it, and most new code uses it. Either way, every header you write should have one.

## Declarations, definitions and the one-definition rule

The compiler sees one translation unit at a time, so when `main.cpp` calls `tinymath::dot`, the compiler cannot look inside `vec.cpp` to check that `dot` exists. It needs a **declaration**: a statement of the name and its type, with no body.

```cpp
float dot(const std::vector<float>& a, const std::vector<float>& b);  // a declaration
```

A declaration is a promise: "this function exists somewhere, and here is how to call it". The compiler checks your call against the promise and leaves a note in the object file saying that `main.o` needs a symbol called `dot`. The **definition**, the version with a body, lives in `vec.cpp`, and the linker later connects the note to it. This is the whole reason headers exist: a header holds declarations that many source files need to agree on, and exactly one source file holds each definition.

The rule behind this is the **one-definition rule** (ODR), and it has two halves that are worth knowing precisely:

- **Within one translation unit**, nothing may be defined twice. Breaking this is a compiler error, such as the redefinition error that include guards prevent.
- **Across the whole program**, an ordinary function or global variable that is used must be defined exactly once. Zero definitions is an "undefined reference" from the linker, and two definitions is a "multiple definition" error. Some things are allowed to be defined in every translation unit that uses them, as long as every copy is identical token for token: class and struct definitions, `inline` functions and variables, and templates. That is why those can live in headers.

The most common way to break the second half is to write a function body in a header:

```cpp
// include/tinymath/vec.h
float clamp01(float x) { return x < 0.0f ? 0.0f : (x > 1.0f ? 1.0f : x); }  // a definition in a header
```

Every source file that includes this header now contains its own definition of `clamp01`. Each one compiles without complaint, because each translation unit has only one copy, and then the linker finds two and stops. There are two fixes. Marking the function `inline` tells the linker that identical copies are expected and that it may keep any one of them, which is how header-only libraries work. Moving the body into one `.cpp` file and leaving a declaration in the header is the other.

The dangerous version of the ODR is the one nobody reports. If two translation units contain *different* definitions of the same class, perhaps because a macro changed the struct's members in one of them, the program is ill-formed, and the standard says no diagnostic is required. The linker usually keeps one copy of the class's inline functions, and the other file silently uses the wrong layout. Real projects meet this when two parts of a build are compiled with different flags or macro settings, and the symptoms are corrupted data rather than error messages. Keep a build's settings consistent and it never happens.

Two keywords control whether a name is visible to the linker at all. A function declared `static`, or placed in an unnamed `namespace { }`, has **internal linkage**: it belongs to its own translation unit, and another file can define a function with the same name without any conflict. Helpers that only one `.cpp` file uses should be written this way.

## The linker joins the pieces

The compiler checks types, and the linker checks that names line up. Every object file carries a table of the symbols it defines and the symbols it still needs, and you can read that table with `nm` (add `-C` to make the names readable). The linker's job is to find, for every needed symbol, exactly one definition in the object files and libraries it was given.

### Mangled names

C++ lets you overload a function: `add(int, int)` and `add(double, double)` can coexist. The linker, though, matches plain strings, so the compiler encodes each function's namespace and parameter types into its symbol name. This is called **name mangling**. Under the Itanium C++ ABI, which GCC and Clang use on Linux and macOS, `int add(int, int)` becomes `_Z3addii` and `double add(double, double)` becomes `_Z3adddd`. On macOS each symbol gets one more leading underscore, so `nm` shows `__Z3addii`. The tool `c++filt` turns a mangled name back into a readable one, and linker errors print the readable version for you, which is why they mention whole parameter lists such as `tinymath::dot(std::vector<float, std::allocator<float> > const&, ...)`.

Mangling has a practical consequence: a C++ function declared with one parameter type and defined with another is two different symbols, so the mismatch shows up as an undefined reference at link time, not as a type error. Chapter 22 shows `extern "C"`, which turns mangling off so that C, Python's `ctypes` and other languages can find a function by its plain name.

### Static and shared libraries

A **static library** (`libtinymath.a` on Linux and macOS, `.lib` on Windows) is an archive of object files. When you link against it, the linker copies the object files that supply missing symbols into your executable, and the library is no longer needed at run time. GNU ld, the default linker on most Linux systems, reads its inputs in order and only takes from an archive the symbols that earlier inputs need, so a library must come after the object files that use it on the command line. LLVM's lld and Apple's linker do not have this restriction. CMake orders libraries correctly for you.

A **shared library** (`.so` on Linux, `.dylib` on macOS, `.dll` on Windows) stays a separate file. The linker only records that your program needs it, and the loader finds and maps it each time the program starts. Shared libraries let many programs use one copy, and let a library be updated without relinking. They are everywhere in AI infrastructure: a PyTorch installation is mostly shared libraries such as `libtorch_cpu.so` and `libc10.so` in `torch/lib`, and every compiled Python extension module, including PyTorch's own `torch._C`, is a shared library that the interpreter loads on `import`.

That last fact is why some failures appear only when the program starts or when Python imports a module. The loader prints `error while loading shared libraries: libfoo.so: cannot open shared object file` when it cannot find a library, and Python raises an `ImportError` with `undefined symbol` when an extension needs a symbol that the loaded libraries do not provide. A classic example is a PyTorch extension compiled against a different PyTorch version, or with a different setting of libstdc++'s `_GLIBCXX_USE_CXX11_ABI` macro than the PyTorch build, so the mangled names it asks for do not exist. `ldd` on Linux and `otool -L` on macOS list the shared libraries a binary needs and where the loader found them.

## Which stage is complaining?

C++ error output looks intimidating mainly because it is long. Two habits make it manageable. First, read the **first** error, not the last: a single missing declaration can cause dozens of follow-on errors that disappear once it is fixed. Second, identify the stage from the shape of the message, before reading the details:

- A message with `file:line:column: error:` that mentions `#include`, a file that was not found, or `#error` comes from the **preprocessor**.
- A message with `file:line:column: error:` about types, undeclared identifiers or "no matching function" comes from the **compiler**. The `note:` lines after it often explain more than the error itself.
- A message that mentions `ld`, `collect2`, `undefined reference`, `multiple definition` or `Undefined symbols for architecture` comes from the **linker**. It has no line number, because the linker works on object files, not source code.
- A message printed when the program starts, or when Python imports a module, comes from the **loader**.
- A message that begins with `CMake Error` comes from **CMake**, before anything was compiled.

```widget
build-stage-quiz
```

## CMake describes the build

Typing compiler commands works for three files. PyTorch has thousands of source files, optional CUDA and ROCm backends, generated code and dozens of third-party libraries, and it must build on Linux, macOS and Windows. Nobody writes those commands by hand. **CMake** is the build system generator that most of the C and C++ projects in AI infrastructure use, including PyTorch (whose `setup.py` drives a CMake build), llama.cpp, ONNX Runtime and the CUDA kernels in vLLM. You describe *what* to build in a `CMakeLists.txt`, and CMake generates the files for a build tool such as Make or Ninja, which then runs the compiler and linker commands in the right order and rebuilds only what changed.

Here is the lab's whole `CMakeLists.txt`, without its comments:

```cmake
cmake_minimum_required(VERSION 3.20)
project(tinymath LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(TINYMATH_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(TINYMATH_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

add_library(tinymath src/vec.cpp)
target_include_directories(tinymath PUBLIC include)
target_compile_options(tinymath PRIVATE -Wall -Wextra -Wpedantic)

add_executable(demo src/main.cpp)
target_link_libraries(demo PRIVATE tinymath)
target_compile_options(demo PRIVATE -Wall -Wextra -Wpedantic)
```

The central idea of modern CMake is the **target**. `add_library` and `add_executable` each create one, and every setting is attached to a target rather than set globally. The keywords `PUBLIC` and `PRIVATE` say who else gets a setting. `target_include_directories(tinymath PUBLIC include)` means "tinymath needs this include path, and so does anything that links tinymath", so `demo` can include `tinymath/vec.h` without repeating the path. The warning flags are `PRIVATE`, so they apply only to the target's own files. The `CMAKE_CXX_STANDARD` lines ask for C++20 and refuse to fall back to an older standard, and `CMAKE_CXX_EXTENSIONS OFF` asks for `-std=c++20` rather than GCC's `-std=gnu++20` dialect.

A CMake build is two commands:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release   # configure: read CMakeLists.txt, write build files into build/
cmake --build build                              # build: run the compiler and linker
```

The first step is **configure**: CMake finds a compiler, checks the platform, finds dependencies with `find_package`, and writes the build files into `build/`. Everything stays in that folder, so deleting it gives you a clean start, and you can keep several build folders side by side, such as `build-debug` and `build-release`. Adding `-G Ninja` makes CMake generate files for Ninja, a build tool that starts builds faster than Make and runs in parallel by default. `CMAKE_EXPORT_COMPILE_COMMANDS` writes `compile_commands.json`, a list of the exact command for every file, which editors that use clangd read to understand your include paths and flags.

Two configure-time problems are worth knowing before they find you. If `find_package` cannot find a dependency, CMake stops with a message that names the package, and the fix is usually to point `CMAKE_PREFIX_PATH` at the directory where it is installed. And CMake 4.0, released in 2025, removed compatibility with projects whose `cmake_minimum_required` asks for a version older than 3.5. Many older repositories still ask for one, and fail to configure with "Compatibility with CMake < 3.5 has been removed from CMake". The real fix is to raise the version in the project, and for a project you do not maintain, CMake accepts `-DCMAKE_POLICY_VERSION_MINIMUM=3.5` as a stopgap.

## Build types and the flags that matter

The same source code can be compiled in very different ways, and a C++ engineer has to know which way a binary was built before trusting its speed or its behavior. These are the flags you will see everywhere:

| Flag | What it does |
|---|---|
| `-std=c++20` | Selects the language version. Without it you get the compiler's default, which differs between compilers and versions. |
| `-Wall -Wextra` | Turns on most useful warnings. Despite its name, `-Wall` is not all of them. `-Wpedantic` adds warnings for non-standard extensions. |
| `-Werror` | Turns warnings into errors. Good in continuous integration, painful when a new compiler adds warnings. |
| `-O0`, `-O1`, `-O2`, `-O3` | Optimization level. `-O0`, the default when you pass none, translates code almost line by line, so it is easy to debug and slow. `-O2` is the usual choice for production, and `-O3` optimizes more aggressively, for example by vectorizing more loops. |
| `-g` | Adds debug information, so a debugger can map machine code back to source lines. It does not slow the program down; it makes the files larger. |
| `-DNDEBUG` | Defines `NDEBUG`, which switches off `assert`. |
| `-march=native` | Lets the compiler use every instruction the build machine supports, such as AVX-512. The binary may then crash with an illegal instruction on an older machine. |
| `-fsanitize=address,undefined` | Adds run-time checks for memory errors and undefined behavior, which Chapter 5 covers. Programs run slower, often around 2 times for AddressSanitizer. |

CMake bundles the common combinations into **build types**, chosen with `CMAKE_BUILD_TYPE`. With GCC and Clang, CMake's defaults are:

| Build type | Flags CMake adds | Use it for |
|---|---|---|
| `Debug` | `-g` | Stepping through code in a debugger |
| `Release` | `-O3 -DNDEBUG` | Benchmarks and production |
| `RelWithDebInfo` | `-O2 -g -DNDEBUG` | Profiling: optimized code that profilers can still map to source |
| `MinSizeRel` | `-Os -DNDEBUG` | Small binaries |

There is a trap in this table. If you configure without `CMAKE_BUILD_TYPE`, it is empty, and CMake adds none of these flags, so you get an unoptimized build that looks like a normal one. Benchmarks run on such a build are meaningless. Always pass the build type, and when a number looks too slow, check `CMakeCache.txt` or the compile commands for `-O`.

Debug and Release builds also differ in behavior, not only in speed. A Release build removes every `assert`, so a Debug build may stop with an assertion failure where a Release build carries on with bad data. And the optimizer in a Release build assumes your program never has undefined behavior, so a bug that a Debug build hides by luck can change the result of a Release build. Chapter 5 explains why. The practical rule is to develop with warnings and sanitizers on, and to measure only Release builds.

## Lab: build tinymath by hand, then with CMake

The lab is a small library called tinymath, with three functions on vectors of floats (`dot`, `norm` and `cosine_similarity`, the measure that embedding search uses) and a program that calls `cosine_similarity` on two vectors of a million floats 100 times and times it. Download the four files, keeping their folders:

- [`CMakeLists.txt`](/labs/cpp/cpp-toolchain/CMakeLists.txt) describes the build.
- [`include/tinymath/vec.h`](/labs/cpp/cpp-toolchain/include/tinymath/vec.h) declares the three functions.
- [`src/vec.cpp`](/labs/cpp/cpp-toolchain/src/vec.cpp) defines them.
- [`src/main.cpp`](/labs/cpp/cpp-toolchain/src/main.cpp) is the program that calls them and times the calls.

You need a C++20 compiler and CMake 3.20 or newer. On macOS, `xcode-select --install` installs Apple clang, and `brew install cmake` installs CMake. On Ubuntu, `sudo apt install build-essential cmake` installs both. The commands below use `clang++`; with GCC, replace it with `g++`.

### Part 1: every stage by hand

Run these from the lab folder, one at a time, and look at each output before moving on.

```bash
# 1. Preprocess only, and count how many lines the compiler really reads.
clang++ -std=c++20 -Iinclude -E src/main.cpp -o main.ii
wc -l src/main.cpp main.ii

# 2. Compile vec.cpp to assembly and find dot's code in it.
clang++ -std=c++20 -Iinclude -O2 -S src/vec.cpp -o vec.s

# 3. Compile each source file to an object file.
clang++ -std=c++20 -Iinclude -c src/vec.cpp -o vec.o
clang++ -std=c++20 -Iinclude -c src/main.cpp -o main.o

# 4. Read the symbol tables: T means "defined here", U means "needed from elsewhere".
nm -C vec.o
nm -C main.o

# 5. Link, and run.
clang++ main.o vec.o -o demo
./demo
```

In step 4, `vec.o` should list `tinymath::dot`, `tinymath::norm` and `tinymath::cosine_similarity` with `T`, and `main.o` should list `tinymath::cosine_similarity` with `U`, among other symbols from the standard library. That `U` is the note the linker resolves in step 5. Run `nm vec.o` again without `-C` to see the mangled names.

<!-- measure: Part 1 on the Mac (and optionally Linux): line counts of main.cpp and main.ii; the nm -C lines for the three tinymath symbols in vec.o and main.o; whether the build ran; the demo output -->

### Part 2: the same build with CMake, in Debug and Release

```bash
cmake -S . -B build-debug -DCMAKE_BUILD_TYPE=Debug
cmake --build build-debug
./build-debug/demo

cmake -S . -B build-release -DCMAKE_BUILD_TYPE=Release
cmake --build build-release
./build-release/demo
```

Both programs print the same similarity, but the Release build should be several times faster, and only the Debug build reports that `assert` is switched on. Then configure a third build without `-DCMAKE_BUILD_TYPE` and check whether its time looks like Debug or Release. Run `cmake --build build-release --clean-first --verbose` to see the exact compiler commands CMake generated, and compare their flags with the build-type table above. The `--clean-first` matters: on a build that is already up to date there is nothing to recompile, so `--verbose` alone prints no compiler commands at all.

<!-- measure: the "100 calls took ... ms" line for Debug, Release and the build with no build type, on the Mac (compiler version and CMake version), ideally the median of 3 runs each -->

### Part 3: break it four ways

Make each change below, rebuild, read the first error, and decide which stage produced it before you look closely. Undo each change before the next one.

1. In `src/main.cpp`, change the include to `#include "tinymath/vecs.h"`.
2. In `src/vec.cpp`, delete the whole definition of `norm`, but leave its declaration in the header.
3. In `include/tinymath/vec.h`, add `float clamp01(float x) { return x < 0.0f ? 0.0f : (x > 1.0f ? 1.0f : x); }` inside the namespace, without `inline`. Then add `inline` and rebuild.
4. Create `include/tinymath/shape.h` containing only `struct Shape { int rows; int cols; };`, with no `#pragma once`, and include it twice at the top of `src/main.cpp`. Then add `#pragma once` to it and rebuild.

You should see one preprocessor error, one compiler error and two linker errors, and the two fixes in steps 3 and 4 should each make their error go away. On an Apple silicon Mac the linker errors read `Undefined symbols for architecture arm64` and `duplicate symbol` rather than GNU ld's `undefined reference` and `multiple definition`, but they mean the same things.

<!-- measure: the first error message from each of the four breakages, on the Mac and optionally on Linux, so the chapter can show the macOS wording -->

### Part 4, optional: build a real project

llama.cpp builds with the same two CMake commands as tinymath. Clone it and build it:

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build
cmake --build build --config Release -j
```

Notice that the configure step passes no build type, which the previous section called a trap. llama.cpp guards against it: its `CMakeLists.txt` sets `CMAKE_BUILD_TYPE` to `Release` when you leave it empty, a defensive pattern many projects copy. The `--config Release` flag only matters for generators that hold several build types in one build folder, such as Visual Studio and Xcode, and is ignored by Make and Ninja.

Watch the configure output: it reports which backends it found, such as Metal on a Mac or CUDA on a machine with the toolkit installed. Then look at its top-level `CMakeLists.txt` and find the `option(...)` lines; each one is a switch you can set with `-D` at configure time, just like `TINYMATH_SANITIZE`. llama.cpp's own build guide, linked below, lists them.

<!-- measure: llama.cpp build: wall time of the build step, which backends configure reported, and the machine -->

## Check yourself

<details>
<summary>A build fails with "undefined reference to `tinymath::norm(std::vector&lt;float, std::allocator&lt;float&gt; &gt; const&amp;)'". Which stage failed, and what are the two most likely causes?</summary>

The linker failed: "undefined reference" is GNU ld's wording, and there is no source line in the message. Every file compiled, because the header's declaration satisfied the compiler, but no object file or library provided the definition. Either the source file that defines `norm` was not compiled and linked (for example, it is missing from `add_library`), or the definition's signature does not match the declaration, so its mangled name is a different symbol.

</details>

<details>
<summary>Why can a struct definition go in a header that many source files include, but a plain function definition cannot?</summary>

The one-definition rule allows a class or struct to be defined once in every translation unit that uses it, as long as all the copies are identical, because the compiler needs the full definition to know the type's layout. An ordinary function must be defined exactly once in the whole program, so a function body in a header gives every including file its own copy, and the linker reports a multiple definition. Marking the function `inline` lifts that restriction, and so does moving the body to a single `.cpp` file.

</details>

<details>
<summary>What do include guards prevent, and what don't they prevent?</summary>

They stop a header from being pasted twice into the same translation unit, which would otherwise define the same types twice in one file and cause a compiler error. They do nothing across translation units: each `.cpp` file still gets its own copy of the header, which is fine for declarations and type definitions but is exactly how a non-inline function body in a header causes a linker error.

</details>

<details>
<summary>You configure a project with `cmake -S . -B build` and benchmark it. Why might the numbers be far too slow?</summary>

Without `-DCMAKE_BUILD_TYPE`, the build type is empty and CMake adds no optimization flags, so the compiler uses its default of `-O0`. The program is correct but unoptimized. Configure with `-DCMAKE_BUILD_TYPE=Release` (or `RelWithDebInfo` for profiling), and check the compile commands for the `-O` flag before trusting a number.

</details>

<details>
<summary>A Python import of your compiled extension fails with "undefined symbol" even though the build succeeded. Which stage is this, and why didn't the linker catch it?</summary>

It is the loader, at import time. On Linux a shared library is allowed to leave symbols undefined at link time (on macOS, Python extension builds ask for the same with `-undefined dynamic_lookup`), on the assumption that another shared library loaded alongside it will provide them, such as PyTorch's own libraries for a PyTorch extension. The check happens only when the loader maps everything into the process. The usual cause is a mismatch between what the extension was compiled against and what is loaded, such as a different PyTorch version or a different C++ ABI setting, so the mangled names it needs do not exist.

</details>

<details>
<summary>Why does an assertion fire in your Debug build while the Release build of the same code runs to the end?</summary>

CMake's Release build type defines `NDEBUG`, and the `assert` macro expands to nothing when `NDEBUG` is defined, so the check is not in the Release binary at all. The bug is still there; the Release build simply continues with bad data. The Release build is not the correct one, only the quiet one.

</details>

## Further reading

- [cppreference: phases of translation](https://en.cppreference.com/w/cpp/language/translation_phases) lists precisely what the preprocessor and compiler do, in order, and [cppreference: the one-definition rule](https://en.cppreference.com/w/cpp/language/definition) states the rule and its exceptions.
- [The official CMake tutorial](https://cmake.org/cmake/help/latest/guide/tutorial/index.html) builds a project step by step with targets, options and installation, and the [CMake 4.0 release notes](https://cmake.org/cmake/help/latest/release/4.0.html) describe the removed compatibility with old projects.
- [GCC's option summary](https://gcc.gnu.org/onlinedocs/gcc/Option-Summary.html) and [Clang's command line reference](https://clang.llvm.org/docs/ClangCommandLineReference.html) document every flag in this chapter.
- [Ian Lance Taylor's series on linkers](https://www.airs.com/blog/archives/38), written by the author of the gold linker, explains symbols, relocations and shared libraries from the inside, in twenty short posts.
- [llama.cpp's build guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) shows how a real AI project uses CMake options to choose its backends.
- [The Itanium C++ ABI's mangling rules](https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangling) define the symbol names GCC and Clang produce, if you ever need to decode one by hand.
