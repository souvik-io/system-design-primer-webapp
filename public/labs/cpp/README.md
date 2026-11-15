# Lab code for C++ for AI Infrastructure Engineers

Each chapter of the course at `/cpp` has a folder here, named after the chapter's id. Every folder is a small CMake project, so the same two commands build any of them:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

You need a C++20 compiler (Apple clang from the Xcode command line tools, GCC 11 or newer, or Clang 14 or newer) and CMake 3.20 or newer. On macOS, `xcode-select --install` provides the compiler and `brew install cmake` provides CMake. On Ubuntu or Debian, `sudo apt install build-essential cmake` provides both. Parts I to V need nothing else. Part VI needs an NVIDIA GPU and the CUDA toolkit, and its folders explain how to get them.

| Chapter | Folder | What it builds |
|---|---|---|
| 1. Toolchain and compilation model | `cpp-toolchain/` | `tinymath`, a three-file vector-math library, built by hand stage by stage and then with CMake |
| 2. Syntax speedrun | `cpp-syntax/` | `traps`, the chapter's "predict the output" snippets, and `dtypes`, a dtype table with int8 quantization and int4 packing |
