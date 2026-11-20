# Pointers, references and const

Open any CUDA kernel, any BLAS routine or any PyTorch custom operator, and the first line looks something like this:

```cpp
void rms_norm(const float* x, const float* weight, float* out, int n, float eps);
```

There is no tensor type in that signature, no shape object and no Python list. There are addresses: `x` says where the input starts, `weight` where the weights start, and `out` where the result should go. The `const` on the first two promises the function only reads them, and the missing `const` on `out` says it writes there. The `n` says how many floats to process, because an address alone does not say where the data ends. That is the language every low-level API speaks, and this chapter teaches you to read and write it.

Python hides addresses completely. A Python name refers to an object somewhere in memory, and you never see where. C++ lets you hold the address itself, do arithmetic on it and pass it around, which is exactly what you need to describe "the 4,096 floats starting here" without copying them. It is also how a single block of memory can be read as a matrix, its transpose, a single row or a single column, all without moving a byte. By the end of this chapter a PyTorch tensor will look like what it is: a pointer, a shape, strides and an offset.

This chapter builds on [the memory chapter](/learn/cpp-memory), which explains where objects live and how long they live. Pointers are only safe when you know both.

## Addresses and pointers

Every object in a running program occupies some bytes of memory, and the address of its first byte identifies it. The `&` operator, placed before a variable, gives that address, and a **pointer** is a variable that stores one:

```cpp
int x = 42;
int* p = &x;    // p holds the address of x; its type is "pointer to int"
*p = 7;         // * follows the address: this writes 7 into x
int y = *p;     // and this reads x through p, so y is 7
```

```diagram
title: A pointer holds the address of another object
[p] p @ 0,0
[x] x = 7 @ 2,0
p -> x : holds the address of x
```

The same two symbols appear in two roles, which is the main source of confusion at first. In a declaration, `int* p` means "p is a pointer to int". In an expression, `*p` means "the object p points at", which is called **dereferencing**, and `&x` means "the address of x". The `*` in a declaration binds to the name, not the type, so `int* a, b;` declares one pointer `a` and one plain `int` `b`. Declare one pointer per line and the trap never matters.

A few facts about pointers are worth knowing from the start:

- On a 64-bit system every object pointer is 8 bytes, whether it points at a `char` or a 10-gigabyte buffer. The type of the pointer, `float*` or `int*`, tells the compiler what is at the address and how big each element is. It does not change the pointer's size.
- Printing a pointer prints its address in hexadecimal. The value changes from one run to the next, because operating systems place the stack and the heap at random addresses each time a program starts, a defence called address space layout randomization.
- To reach a member through a pointer to a struct, write `p->rows`, which is shorthand for `(*p).rows`.

That gives C++ three ways to reach inside something, and which one you write depends only on what is on the left:

| Operator | Left side | Example | Meaning |
| --- | --- | --- | --- |
| `::` | a namespace, enum or class name | `std::vector`, `DType::F16` | a name declared inside that scope |
| `.` | an object | `t.rows` | a member of this object |
| `->` | a pointer to an object | `p->rows` | a member of the object at this address |

```cpp
struct Shape { int rows, cols; };

Shape t{2, 3};
Shape* p = &t;

int a = t.rows;      // t is an object: use .
int b = p->rows;     // p is a pointer: use ->
int c = (*p).rows;   // the same as p->rows; the parentheses matter, since *p.rows means *(p.rows)
```

Writing `p.rows` or `t->rows` is a compile error, not a silent bug, so the compiler tells you when you picked the wrong one. Smart pointers, coming in Chapter 8, follow the same rule: `->` reaches the object they own, and `.` calls a function of the smart pointer itself.

### nullptr

A pointer that points at nothing holds the **null pointer**, written `nullptr`. It is how C++ says "no object here": a function that searches for something can return `nullptr` when it finds nothing, the way a Python function returns `None`.

```cpp
const Tensor* t = find_tensor(name);
if (t == nullptr) {
  // not found: handle it
}
```

Dereferencing a null pointer is undefined behavior. On Linux and macOS it usually crashes the program at once with a segmentation fault, because the operating system leaves the lowest addresses unmapped on purpose, but the language promises nothing, and Chapter 5 shows how an optimizer can make it worse. The rule is simple: if a pointer can be null, test it before you dereference it.

`nullptr` arrived in C++11. Older code writes `NULL` or `0`, which are integers rather than pointers. That matters with overloading: given `f(int)` and `f(char*)`, the call `f(NULL)` picks the `int` version or fails as ambiguous, depending on how the library defines `NULL`, while `f(nullptr)` always picks the pointer version. Use `nullptr` in new code.

## References

A **reference** is another name for an existing object. You declare one with `&` after the type:

```cpp
int x = 42;
int& r = x;     // r is now another name for x
r = 7;          // this changes x
```

That `&` is a third meaning of the symbol, in a declaration this time, and it is unrelated to taking an address. Read `int& r` as "r is a reference to int".

A reference behaves like a pointer that the language manages for you, with three rules that make it safer:

1. It must be bound to an object when it is created. There is no such thing as an uninitialised reference.
2. It cannot be null. A valid program never has a reference that refers to nothing.
3. It cannot be re-pointed. Assigning to a reference assigns to the object it refers to.

The third rule surprises Python programmers, because a Python name _can_ be re-pointed. In Python, `b = a` makes `b` refer to the same list as `a`, and a later `b = other` makes `b` refer to something else while `a` is untouched. In C++, after `int& r = x;`, the statement `r = y;` copies the _value_ of `y` into `x`. The lab checks `&r == &x` afterwards to show that `r` still refers to `x`. A Python name is closer to a C++ pointer that can be re-pointed, and a C++ reference is closer to a permanent alias.

References exist mainly for function parameters, which the next section covers, and for range-based `for` loops such as `for (float& x : v) x *= 0.5f;`, which the previous chapter used. They carry one danger: a reference does not keep its object alive. A function that returns a reference to one of its own local variables returns a name for an object that is destroyed as the function returns, which is the dangling reference that [the memory chapter](/learn/cpp-memory) demonstrates. The same is true of a pointer to a local.

## Four ways to pass an argument

Chapter 2 showed that a parameter declared as `std::vector<float> xs` receives a copy. Pointers and references give three more choices, and together they let a function's signature say exactly what it does with each argument:

| Parameter              | What the function gets                                | Use it when                                                                                                             |
| ---------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `T x`                  | Its own copy                                          | `T` is small and cheap to copy, such as `int`, `float`, a pointer or an enum, or the function needs its own copy anyway |
| `const T& x`           | Read-only access to the caller's object, with no copy | The function only reads a large object, such as a vector, a string or a tensor                                          |
| `T& x`                 | Read and write access to the caller's object          | The function must modify the caller's object                                                                            |
| `T* x` or `const T* x` | An address, which may be `nullptr`                    | "No object" is a valid argument, or the argument is the start of an array of `T`                                        |

The C++ Core Guidelines, the style guide maintained by Bjarne Stroustrup and Herb Sutter, state the same rules: pass cheap types by value and others by `const&` for input (rule F.16), use a non-const reference for a parameter the function modifies (F.17), and prefer a pointer over a reference when "no argument" is a valid option (F.60).

The last row is the one that low-level code uses most, and for a different reason. A function that processes an array receives a pointer to its first element and a count, because a pointer alone does not know how many elements follow it:

```cpp
float sum(const float* data, std::size_t n) {
  float total = 0.0f;
  for (std::size_t i = 0; i < n; ++i) total += data[i];
  return total;
}

std::vector<float> v = {1.0f, 2.0f, 3.0f};
float s = sum(v.data(), v.size());   // data() returns a pointer to the vector's first element
```

`std::vector` guarantees that its elements sit next to each other in memory, so `v.data()` and `v.size()` are all a C-style function needs. This is how a C++ program hands a vector to a BLAS library or copies it to a GPU.

### std::span: the pointer and the length together

Passing a pointer and a length separately invites mistakes: the wrong length, or a length that belongs to a different buffer. C++20 added `std::span`, in the `<span>` header, which holds both in one small object that you pass by value:

```cpp
float sum(std::span<const float> xs) {
  float total = 0.0f;
  for (float x : xs) total += x;
  return total;
}

sum(v);                                     // a vector converts to a span automatically
sum(std::span<const float>(v).first(2));    // a span over the first two elements, no copy
```

A span does not own its elements. It is a **view**, a pointer and a size describing memory that something else owns, so it is cheap to create and pass, and it dangles if the owner goes away. `std::span<const float>` is read-only, and `std::span<float>` can write. Its `operator[]` does not check bounds in C++20, so it is a convenience, not a safety net. New C++ code that does not have to match a C interface should prefer spans to separate pointers and lengths.

## const in every position

`const` can appear in several places in a declaration, and each place means something different. The rule for reading them is to read the declaration from right to left, starting at the name:

```cpp
const float* a;         // a is a pointer to a float that is const
float* const b = &v;    // b is a const pointer to a float
const float* const c = &v;  // c is a const pointer to a const float
const float& d = v;     // d is a reference to a float that is const
```

| Declaration            | Can you change the float through it? | Can you point it somewhere else?   |
| ---------------------- | ------------------------------------ | ---------------------------------- |
| `const float* a`       | No                                   | Yes                                |
| `float* const b`       | Yes                                  | No                                 |
| `const float* const c` | No                                   | No                                 |
| `const float& d`       | No                                   | References can never be re-pointed |

The first row is the one you will write constantly. `const float* x` is a promise that the function will not modify the floats at `x`, and the compiler enforces it: writing `x[0] = 1.0f;` in that function is a compile error. You will also see `float const* x`, which means exactly the same thing, because `const` applies to whatever is on its left, or to the type on its right when nothing is on its left.

The second row, a `const` pointer, is less common. It fixes where the pointer points, and leaves the data writable.

### Why const-correctness is worth the typing

Look at the real signature of cuBLAS's single-precision matrix multiply, one of the NVIDIA library routines that PyTorch calls for float matmuls on a GPU:

```cpp
cublasStatus_t cublasSgemm(cublasHandle_t handle,
                           cublasOperation_t transa, cublasOperation_t transb,
                           int m, int n, int k,
                           const float* alpha,
                           const float* A, int lda,
                           const float* B, int ldb,
                           const float* beta,
                           float* C, int ldc);
```

Without reading a line of documentation you know that `A` and `B` are inputs and `C` is the output, because only `C` lacks `const`. That is const-correctness: when every function marks what it only reads, a signature tells you the data flow, and the compiler stops anyone from breaking the promise by accident. It also spreads: a function that receives a `const float*` cannot pass it on to a function that takes a plain `float*`, so one missing `const` deep in a library forces awkward workarounds on everyone who calls it. Mark every pointer and reference parameter `const` unless the function writes through it.

Two details complete the picture. A member function can be marked `const` after its parameter list, as in `std::size_t size() const`, which promises that calling it does not modify the object; Chapter 6 covers this with classes. And `const` restricts one path to the data, not the data itself: if another non-const pointer refers to the same floats, they can still change through that one. `const_cast` can remove `const`, but modifying an object that was _defined_ `const` is undefined behavior, so treat `const_cast` as a sign that something is wrong.

## Raw arrays and how they decay

C++ inherited fixed-size arrays from C:

```cpp
float a[4] = {1.0f, 2.0f, 3.0f, 4.0f};   // four floats, side by side
```

The array's size is part of its type, `float[4]`, and `sizeof(a)` is 16 bytes, four floats of 4 bytes each. But in almost every expression, the name `a` turns into a pointer to its first element. This is called **array-to-pointer decay**, and it is why `float* p = a;` compiles.

Decay has one nasty consequence. A function parameter written as an array is really a pointer:

```cpp
std::size_t size_inside(const float a[]) {   // the compiler reads this as const float* a
  return sizeof(a);                          // 8 on a 64-bit system: the size of a pointer
}
```

Inside the function, the array's length is gone. The same mistake in C has caused countless bugs, and compilers now warn about `sizeof` on an array parameter. The lab triggers that warning on purpose.

The modern replacements avoid decay. `std::array<float, 4>` is a fixed-size array that behaves like a normal object: it does not decay, it can be copied and returned, and `.size()` works. `std::vector<float>` is the growable version. When a function must accept any of them, take a `std::span<const float>`. Raw arrays still appear inside low-level code and especially in CUDA kernels, where fixed-size local arrays such as `float acc[4];` are common, so you need to recognise them.

## Pointer arithmetic

Adding an integer to a pointer moves it by that many _elements_, not bytes. If `p` is a `float*`, then `p + 2` points two floats further on, which is 8 bytes further, and if `p` were a `double*`, `p + 2` would be 16 bytes further. The compiler multiplies by the element size for you, which is why a pointer has a type at all.

```cpp
float a[4] = {1.0f, 2.0f, 3.0f, 4.0f};
float* first = a;
float* third = first + 2;       // points at a[2]
float v = *third;               // 3.0f
std::ptrdiff_t d = third - first;   // 2: subtracting pointers counts elements
```

Indexing is pointer arithmetic in disguise. The standard defines `p[i]` as `*(p + i)`, so `a[2]`, `*(a + 2)` and `first[2]` are the same expression. Once you see this, CUDA code stops looking mysterious: `x[blockIdx.x * n + threadIdx.x]` is simply "start at `x`, move this many floats, read".

Pointer arithmetic is only valid inside one array. You may move a pointer to any element of the array or to the position one past the last element, which is what `end()` iterators represent, but not further, and you must never dereference the one-past-the-end position. Computing an address outside the array is undefined behavior even if you never read it. Chapter 5 shows what out-of-bounds access does in practice and how AddressSanitizer catches it.

Remember too the way a pointer goes bad that [the memory chapter](/learn/cpp-memory) showed: when a `std::vector` grows beyond its capacity, it allocates a bigger block, moves its elements there and frees the old block, so any pointer you took with `data()` or `&v[0]` before that points at freed memory. Take pointers into a vector after it has finished growing, or reserve the space first.

## Tensors are pointers with shapes and strides

Memory is one-dimensional: a long row of bytes with consecutive addresses. A matrix is two-dimensional. Every tensor library has to map the second onto the first, and almost all of them use **row-major** order, also called C order: the first row, then the second row, and so on. A 2 × 3 matrix holding the numbers 0 to 5 is stored as six consecutive floats:

|           | column 0    | column 1    | column 2    |
| --------- | ----------- | ----------- | ----------- |
| **row 0** | 0 (index 0) | 1 (index 1) | 2 (index 2) |
| **row 1** | 3 (index 3) | 4 (index 4) | 5 (index 5) |

So element `(i, j)` of a matrix with `cols` columns lives at flat index `i * cols + j`. In code:

```cpp
std::vector<float> A(rows * cols);
A[i * cols + j] = 1.0f;          // element (i, j)
```

You will write `i * cols + j` thousands of times in this course. It is worth seeing it in a more general form. Moving one column to the right moves 1 element in memory, and moving one row down moves `cols` elements. Those two numbers are the matrix's **strides**, and with them the index formula becomes:

```text
flat index = offset + i * stride0 + j * stride1
```

For a plain row-major matrix, `offset` is 0, `stride0` is `cols` and `stride1` is 1. PyTorch stores exactly this for every tensor: a pointer to its storage, the shape, the strides and the storage offset. You can see it from Python, where `t = torch.arange(6).reshape(2, 3)` gives `t.stride() == (3, 1)`.

The power of strides is that many operations only change those numbers and never touch the data:

- **Transpose.** `t.T` has shape `(3, 2)` and strides `(1, 3)`: the shape and the strides are swapped, and the storage is the same six floats. Transposing a 10,000 × 10,000 matrix this way costs nothing.
- **Selecting a column.** `t[:, 1]` has shape `(2,)`, stride `(3,)` and storage offset 1: start at the second float and jump a whole row each time.
- **Selecting rows.** `t[1:]` has shape `(1, 3)` and storage offset 3. It is the second row, still row-major.
- **Step slicing.** `t[:, ::2]` keeps the strides of the rows and doubles the column stride to 2, so it reads every other column.

```diagram
title: Two views share one storage
[t] t: shape (2, 3)\nstride (3, 1) @ 0,0
[tt] t.T: shape (3, 2)\nstride (1, 3) @ 0,1
[s] storage: 6 floats @ 2,0.5
t -> s
tt -> s
```

A tensor is **contiguous** when its elements, read in row-major order of its own shape, sit back to back in memory, which means every dimension's stride equals the product of the sizes after it (PyTorch ignores dimensions of size 1, whose stride never matters). `t` is contiguous. `t.T` is not, because walking along one of its rows jumps 3 elements at a time. PyTorch reports this with `t.is_contiguous()`, and `t.contiguous()` returns the same tensor if it is already contiguous, or otherwise allocates new storage and copies the elements into row-major order. Two numbering conventions differ between libraries, so check which one you are reading: PyTorch counts strides in elements, NumPy counts them in bytes, and llama.cpp's ggml keeps byte strides in an array called `nb` and lists dimensions from the innermost outwards.

Why should a C++ programmer care? Because code that receives a raw `const float*` assumes a layout, almost always contiguous row-major. Pass it the data pointer of a transposed view and it silently reads the wrong elements. That is why custom PyTorch operators so often begin with a check such as `TORCH_CHECK(x.is_contiguous())`, or call `.contiguous()` before taking the pointer, and why `t.T.view(-1)` raises an error that suggests `.reshape` instead: a non-contiguous tensor cannot be flattened without a copy. Try it here:

```widget
tensor-strides
```

### Row-major and column-major

Not every library uses row-major order. Fortran stored matrices column by column, **column-major**, and the original BLAS interface followed it, so cuBLAS expects column-major matrices too. That is what the `lda`, `ldb` and `ldc` arguments in the `cublasSgemm` signature above are about: each is a **leading dimension**, the stride between consecutive columns. Code that holds row-major data usually does not transpose anything to call cuBLAS. It uses a piece of algebra instead: a row-major matrix read as column-major is its transpose, and (A × B)ᵀ = Bᵀ × Aᵀ, so swapping the two inputs (and their dimensions) makes cuBLAS compute the row-major product directly. Strides are the idea that makes that trick, and many others like it, possible.

## A naive matmul with pointers

Everything in this chapter comes together in the most important function in AI: matrix multiplication. Here is the textbook version for row-major matrices, C = A × B, where A is M × K, B is K × N and C is M × N:

```cpp
void matmul(const float* A, const float* B, float* C, int M, int N, int K) {
  for (int i = 0; i < M; ++i) {
    for (int j = 0; j < N; ++j) {
      float sum = 0.0f;
      for (int k = 0; k < K; ++k) sum += A[i * K + k] * B[k * N + j];
      C[i * N + j] = sum;
    }
  }
}
```

Read the signature first. `A` and `B` are `const float*`, inputs; `C` is a `float*`, the output; and the three sizes say how to interpret the flat buffers. Each element of C is the dot product of one row of A with one column of B. The row of A is contiguous, `A[i * K + k]` for consecutive `k`. The column of B is not: `B[k * N + j]` jumps N floats at every step. For N = 512, that is 2,048 bytes per step, so every multiply touches a different cache line. Chapter 13 explains why that pattern is slow and Project C fixes it step by step, from this version to one many times faster. For now, the point is that the order in which you walk memory is a property of the indexing code you write, and strides are how you control it.

The function does 2 × M × N × K floating-point operations, one multiply and one add for each combination of i, j and k. For three 512 × 512 matrices that is 2 × 512³ = 268,435,456 operations, which is the number you divide by the run time to get FLOP/s.

Two more lessons hide in those five lines.

**Indexes overflow.** `i * K + k` is computed as an `int`, and the largest `int` is 2,147,483,647. An 8 GiB buffer of 16-bit values holds 4,294,967,296 elements, twice that, and KV caches and embedding tables of that size are routine in serving. Indexing them with `int` overflows, which is undefined behavior. PyTorch stores sizes and strides as 64-bit integers for this reason, and its CUDA kernels check whether a tensor is small enough for faster 32-bit index arithmetic (the helper is called `canUse32BitIndexMath`) before using it. Use `std::int64_t` or `std::size_t` for indexes into large buffers.

**Pointers can alias.** Nothing in the signature stops a caller from passing the same buffer as `A` and `C`. The compiler must allow for that possibility, so after every write to `C` it has to assume `A` and `B` might have changed, which limits how much it can keep in registers and reorder. GCC, Clang and MSVC accept a non-standard `__restrict` qualifier that promises a pointer does not alias any other, and CUDA code spells it `__restrict__`. Chapter 15 comes back to it when vectorizing loops.

### The same matmul through views

Combine the matmul with strides and you get a function that multiplies any two views, transposed or not, without copying. The lab defines a small struct with the same information as a PyTorch tensor's metadata:

```cpp
struct View {
  const float* data;
  std::int64_t rows, cols;
  std::int64_t stride0, stride1;   // in elements
};

float get(const View& v, std::int64_t i, std::int64_t j) { return v.data[i * v.stride0 + j * v.stride1]; }

View transposed(const View& v) { return {v.data, v.cols, v.rows, v.stride1, v.stride0}; }
```

`transposed` swaps two pairs of numbers and returns. No element moves. A matmul written with `get(A, i, k) * get(B, k, j)` then works on any layout, which is how the lab computes A × Aᵀ without ever building Aᵀ. Real libraries go further: C++23 added `std::mdspan`, a standard multi-dimensional view with pluggable layouts for row-major, column-major and arbitrary strides, although only recent standard libraries ship it.

## Lab: pointers, views and a first matmul

The lab has two programs, [`pointers.cpp`](/labs/cpp/cpp-pointers/pointers.cpp) and [`matmul.cpp`](/labs/cpp/cpp-pointers/matmul.cpp), and a [`CMakeLists.txt`](/labs/cpp/cpp-pointers/CMakeLists.txt) that builds both. Download the three files into one folder. It needs only a C++20 compiler and CMake.

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/pointers
./build/matmul
```

### Part 1: pointers.cpp

`pointers.cpp` runs eleven numbered experiments that follow this chapter: taking and following an address, pointer sizes, pointer arithmetic in elements and in bytes, array decay, `std::array`, references and `scale`, a pointer-and-length `sum`, the same with `std::span`, `const` in each position, `nullptr`, and a vector whose `data()` moves when it reallocates. Before running it, predict each line. Three things to check:

- Experiment 3 should report the two pointers 2 elements and 8 bytes apart.
- Experiment 4 should show 16 bytes for the array in `main` and 8 inside the function, and the build should have warned about `sizeof` on an array parameter.
- In experiment 9, remove the `//` from one of the lines marked "error" and rebuild, then read how your compiler describes the problem. Put the `//` back before trying the other.

<!-- measure: build pointers on the Mac (and optionally Linux) and record the exact warning for size_inside, the full output of ./build/pointers, and the compiler's error message for each of the two "error" lines in experiment 9 -->

### Part 2: matmul.cpp

`matmul.cpp` builds two n × n matrices with a fixed pattern of values (n is 512 unless you pass another size, as in `./build/matmul 256`) and runs three experiments:

1. `matmul` with raw pointers, timed, with the largest difference from the same product computed in double precision. The difference should be small, because float rounding errors grow with the length of each dot product but stay far below the values themselves.
2. The same product through views, where B is given as a transposed view of a matrix `Bt` that holds B's transpose. The values are identical, but now the inner loop reads B's columns as contiguous rows of `Bt`. Compare its time with experiment 1, then try `./build/matmul 1024`; Chapter 13 explains whatever difference you see.
3. A × Aᵀ through views, without building Aᵀ, checked for the symmetry that such a product must have.

Then build in Debug as in Chapter 1 and run it again, to see how much the optimizer contributes to a loop like this.

<!-- measure: ./build/matmul at n = 256, 512 and 1024 in Release, and at 512 in Debug, on the Mac (chip, compiler version): the ms and GFLOP/s of experiments 1 and 2, the max errors, and the symmetry line -->

### Stretch goals

- Write `View row(const View& v, std::int64_t i)` and `View column(const View& v, std::int64_t j)` that return one row or column as a 1 × n or n × 1 view, by setting the pointer and the shape and leaving the strides alone.
- Add an `is_contiguous(const View&)` function that follows PyTorch's rule, and check it on a view, its transpose and a column.
- Change the indexes in `matmul` from `int` to `std::int64_t` and compare the times. Then explain why the result does not overflow for n = 1024 even with `int`.

## Check yourself

<details>
<summary>What is the difference between const float* p and float* const p?</summary>

Read each from right to left. `const float* p` is a pointer to a `const float`: you cannot change the floats through `p`, but `p` itself can be moved to point elsewhere. `float* const p` is a `const` pointer to a `float`: it must be initialised, it can never point anywhere else, but the float it points at can be changed through it. Function inputs are almost always the first kind.

</details>

<details>
<summary>Inside void f(float a[]), sizeof(a) is 8, although the caller passed an array of 100 floats. Why?</summary>

An array parameter is really a pointer parameter: the compiler reads `float a[]` as `float* a`, and the array decays to a pointer to its first element when it is passed. `sizeof(a)` is therefore the size of a pointer, 8 bytes on a 64-bit system, and the length is lost. Pass the length separately, or take a `std::span<const float>`, which carries both.

</details>

<details>
<summary>After int&amp; r = x; the code runs r = y;. What does this change?</summary>

It copies the value of `y` into `x`. A reference cannot be re-pointed: `r` was bound to `x` when it was created and refers to `x` for the rest of its life, so assigning to `r` assigns to `x`. This is unlike Python, where `b = other` makes the name `b` refer to a different object.

</details>

<details>
<summary>A row-major tensor t has shape (4, 5). What are its strides, where is element (2, 1), and what are the shape and strides of t.T?</summary>

The strides are (5, 1): one row down skips 5 elements and one column right skips 1. Element (2, 1) is at 2 × 5 + 1 = 11. `t.T` has shape (5, 4) and strides (1, 5), and it shares `t`'s storage, so it is not contiguous. Element (1, 2) of `t.T` is at 1 × 1 + 2 × 5 = 11, the same float.

</details>

<details>
<summary>A custom operator takes a const float* from x.data_ptr() and reads x as a row-major matrix. It gives wrong answers only when the caller passes a transposed tensor. Why, and what are two fixes?</summary>

A transposed tensor shares its storage with the original and differs only in its strides, so its data pointer points at the same floats in the original order. Code that assumes contiguous row-major layout ignores the strides and reads the elements in the wrong order. Either call `.contiguous()` before taking the pointer, which copies the data into row-major order when needed, or check `x.is_contiguous()` and reject other layouts with an error. A third option is to pass the strides to the kernel and index with them.

</details>

<details>
<summary>Why can indexing a large tensor with int be a bug even when every individual index is small?</summary>

The flat index is a product and a sum, such as `i * cols + j`, and the result can exceed the largest `int`, 2,147,483,647, even when `i`, `cols` and `j` are all modest. Signed overflow is undefined behavior, so the program may read the wrong address. Buffers of more than 2^31 elements are common in inference, such as an 8 GiB buffer of 16-bit values with 2^32 elements, so index arithmetic on large buffers should use `std::int64_t` or `std::size_t`, as PyTorch does for sizes and strides.

</details>

## Further reading

- [cppreference: pointer declaration](https://en.cppreference.com/w/cpp/language/pointer) and [reference declaration](https://en.cppreference.com/w/cpp/language/reference) give the exact rules for both, including null pointers and what references may bind to.
- [cppreference: cv qualifiers](https://en.cppreference.com/w/cpp/language/cv) explains `const` and `volatile` in every position.
- [cppreference: array declaration](https://en.cppreference.com/w/cpp/language/array) covers array-to-pointer decay, and [std::span](https://en.cppreference.com/w/cpp/container/span) documents the C++20 view.
- [The C++ Core Guidelines on parameter passing](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#S-functions), in the section on functions, give the rules behind the table of four ways to pass an argument.
- [Edward Yang's "PyTorch internals"](http://blog.ezyang.com/2019/05/pytorch-internals/) explains tensors as storage plus sizes, strides and an offset, with pictures, from one of PyTorch's core developers.
- [PyTorch's documentation of Tensor.stride](https://pytorch.org/docs/stable/generated/torch.Tensor.stride.html) and [Tensor.contiguous](https://pytorch.org/docs/stable/generated/torch.Tensor.contiguous.html) show the same ideas from the Python side.
- [The cuBLAS documentation](https://docs.nvidia.com/cuda/cublas/) describes its column-major convention and the leading-dimension arguments.
