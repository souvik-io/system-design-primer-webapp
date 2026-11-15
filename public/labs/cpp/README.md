# Lab code for C++ for AI Infrastructure Engineers

Each chapter of the course at `/cpp` has a folder here, named after the chapter's id. Every folder is a small CMake project, so the same two commands build any of them:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

You need a C++20 compiler (Apple clang from the Xcode command line tools, GCC 11 or newer, or Clang 14 or newer) and CMake 3.20 or newer. On macOS, `xcode-select --install` provides the compiler and `brew install cmake` provides CMake. On Ubuntu or Debian, `sudo apt install build-essential cmake` provides both. Parts I to V need nothing else. Part VI needs an NVIDIA GPU and the CUDA toolkit, and its folders explain how to get them.

| Chapter                             | Folder                    | What it builds                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Toolchain and compilation model  | `cpp-toolchain/`          | `tinymath`, a three-file vector-math library, built by hand stage by stage and then with CMake                                                                                                                            |
| 2. Syntax speedrun                  | `cpp-syntax/`             | `traps`, the chapter's "predict the output" snippets, and `dtypes`, a dtype table with int8 quantization and int4 packing                                                                                                 |
| 3. Memory: stack, heap and lifetime | `cpp-memory/`             | `lifetime`, which prints when objects are created and destroyed, `layout`, which measures sizeof, alignment and padding, and `memory_demo`, a stack overflow, a leak and a dangling pointer                               |
| 4. Pointers, references and const   | `cpp-pointers/`           | `pointers`, numbered experiments with addresses, arrays, references and `const`, and `matmul`, a naive matrix multiply written with pointers plus strided views                                                           |
| 5. Undefined behavior               | `cpp-undefined-behavior/` | `ub_zoo`, eight deliberate bugs for the sanitizers to explain, and `optimizer`, code whose answer changes between Debug and Release because it relies on signed overflow                                                  |
| Project A. Log analyzer             | `cpp-log-analyzer/`       | `gen_logs.py`, a synthetic inference-server access log, `analyze.py`, the Python reference, and `log_analyzer`, the same report in C++ with a library, tests and CTest                                                    |
| 6. Classes and RAII                 | `cpp-raii/`               | `raii_demo`, file handles leaked and then owned, stack unwinding, `std::exit`, a `ScopedTimer` around matmuls, and `mistakes`, four errors for the compiler to catch                                                      |
| 7. Copy and move semantics          | `cpp-copy-move/`          | `moves`, which counts the copies, moves and allocations behind ordinary code (range-for, vector growth with and without `noexcept`, returns, the destructor trap, sink parameters) and times a 400 MB copy against a move |
