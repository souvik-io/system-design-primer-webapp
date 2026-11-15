# Memory: stack, heap and lifetime

Here is a number that surprises most Python programmers. A Python list of a million floats, built with something like `[float(i) for i in range(1_000_000)]`, takes about 32 MB on a 64-bit CPython: each float is a separate 24-byte object somewhere in memory, and the list holds a million 8-byte pointers to them. A C++ `std::vector<float>` of a million floats takes 4 MB, because it holds the numbers themselves, side by side, four bytes each. That is also why NumPy and PyTorch exist: under their Python surface, a tensor is a C or C++ buffer of raw numbers.

The difference is not an accident of implementation. Python decides where every object lives and when it is freed, and pays for that convenience in memory and speed. C++ hands both decisions to you. You choose whether a value lives on the **stack**, where it is free to create and disappears automatically, or on the **heap**, where it can be as large as you like and live as long as you need, but costs more to create and must be released. And you need to know exactly when each object's life ends, because using an object after that is one of the most common and most dangerous bugs in C++.

This matters more in AI infrastructure than almost anywhere else. An inference engine is, to a large extent, a memory manager: vLLM's central idea, PagedAttention, is a way of allocating the KV cache, and PyTorch keeps its own allocator for GPU memory because asking the driver for memory on every operation would be far too slow. This chapter covers the CPU side of the same ideas: the stack, the heap, `new` and `delete`, the rules for when objects are created and destroyed, and how `sizeof`, alignment and padding decide how much memory a struct really takes. The lab watches objects being born and destroyed, measures struct layouts, and crashes a program three different ways on purpose.

## Where Python keeps your data, and where C++ does

In CPython, every value is an object on the heap, and every variable is a reference to one. `x = 3.0` creates a float object and points `x` at it. The interpreter counts the references to each object and frees the object the moment the count reaches zero, and a garbage collector cleans up the cycles that counting misses. You never choose where anything lives, and you rarely think about when it is freed.

In C++, a variable _is_ its value. `double x = 3.0;` inside a function sets aside 8 bytes in that function's stack frame and puts the bits of 3.0 there. There is no separate object, no reference count, and no pointer to follow. Where a value lives depends on how you create it, and the language calls this its **storage duration**:

| How it is created                                       | Where it lives                              | When it dies                                  |
| ------------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| A local variable in a function                          | The stack                                   | When its enclosing block ends                 |
| With `new`, or inside a container such as `std::vector` | The heap                                    | When `delete` runs, or the container frees it |
| A global, or a `static` variable                        | A fixed area set up when the program starts | After `main` returns                          |
| `thread_local`                                          | Per thread                                  | When its thread ends                          |

Most real objects mix the first two. A `std::vector<float>` is a small object, three pointers or 24 bytes with GCC's and Clang's standard libraries on a 64-bit machine, that can live on the stack. Its elements live in a separate block on the heap, which the vector allocates, grows and frees for you:

```diagram
title: A vector: a small object on the stack, its elements on the heap
[main] main's frame @ 0,0
[load] load_layer's frame @ 0,1
[vec] w: std::vector\n24 bytes @ 1.5,1
[heap:store] 4,096 floats\n16 KiB on the heap @ 3.5,1
main -> load : calls
load -> vec : local variable
vec -> heap : data pointer
```

When `load_layer` returns, `w` is destroyed with its frame, and its destructor frees the heap block. Nothing waits for a garbage collector. This pattern, a small owner on the stack that frees a heap resource when it dies, is called RAII, and Chapter 6 is built around it.

## The stack: fast, automatic and small

Every call to a function gets a **stack frame**: a block of memory holding the function's local variables, the arguments that did not fit in registers, and the address to return to. Frames are pushed and popped in strict order, last in, first out, which is where the name comes from. On x86-64 and ARM64 the stack grows downward, and creating a whole frame is usually one instruction that subtracts the frame's size from the stack pointer register. Destroying it is one instruction that adds the size back.

That gives the stack three properties worth remembering:

- **It is nearly free.** Allocating a local `float[64]` costs the same as allocating nothing, because the whole frame is reserved at once.
- **It is automatic.** Locals disappear when their block ends, whatever path the code takes out of it: falling off the end, `return`, `break`, or an exception.
- **It is usually fast to touch.** The same few kilobytes at the top of the stack are reused call after call, so they are almost always in the processor's cache.

The catch is that a frame's size must be fixed when the function is compiled. `float scratch[n];` with an `n` known only at run time is not standard C++. GCC and Clang accept it as an extension called a variable-length array, and `-Wpedantic` warns about it. Data whose size you learn at run time, such as a tensor whose shape comes from a model file, belongs on the heap.

### How big is the stack?

The other catch is that the stack is small, and it does not grow on demand beyond a fixed limit. The defaults are worth knowing because they differ between platforms:

| Platform      | Main thread                    | Other threads             |
| ------------- | ------------------------------ | ------------------------- |
| Linux (glibc) | Usually 8 MB, from `ulimit -s` | The same limit by default |
| macOS         | 8 MB                           | 512 KB                    |
| Windows       | 1 MB                           | 1 MB                      |

Exceed the limit and the program touches a guard page below the stack, and the operating system kills it with a segmentation fault. There is no exception to catch and no friendly message. Two things cause this in practice. One is deep recursion, such as a recursive walk over a very deep tree. The other is a large local array: `float logits[32000 * 128];` is about 16 MB, twice the Linux default, and a program that declares it inside a function crashes as soon as it touches the array. The rule of thumb is to keep anything larger than a few kilobytes off the stack. Note the macOS row: code that runs happily on the main thread can crash in a worker thread, whose stack is sixteen times smaller.

## The heap: big, flexible and manual

The heap is the large pool of memory that a program requests from the operating system as it needs it. A heap allocation can be any size, decided at run time, and it lives until you release it, whatever happens to the function that created it. That is exactly what tensors, KV caches and model weights need.

### new and delete

The raw C++ tools are `new` and `delete`:

```cpp
float* one = new float(3.0f);    // allocate one float on the heap and initialize it
delete one;                      // destroy it and give the memory back

float* buf = new float[n];       // allocate n floats; their values are indeterminate
float* zeroed = new float[n]();  // the () asks for every element to be zero
delete[] buf;                    // an array from new[] must be released with delete[]
delete[] zeroed;
```

`new` does two things: it asks the allocator for memory, and then runs the object's constructor in it. `delete` does the reverse: it runs the destructor and returns the memory. If the allocator cannot find memory, `new` throws `std::bad_alloc` rather than returning a null pointer, unlike C's `malloc`. On Linux, though, a large allocation often succeeds even when memory is short, because the kernel assigns physical pages only when the program first writes to them, so running out tends to show up later, as the out-of-memory killer ending the process.

Manual `new` and `delete` give you three ways to get it wrong, and each is undefined behavior or a leak:

1. **Forget the `delete`**, and the memory is never returned. This is a **leak**. In a server that runs for weeks, a few leaked kilobytes per request add up to an out-of-memory crash.
2. **Use the memory after `delete`**, and you read or write a block that the allocator may already have handed to someone else. This is a **use-after-free**.
3. **`delete` the same pointer twice**, or release `new[]` memory with plain `delete`, and you corrupt the allocator's own records. This is a **double free** or a mismatched delete.

The first is easy to commit, because every path out of a function must reach the `delete`:

```cpp
float score(int n_tokens) {
  float* scratch = new float[1024 * 1024];
  if (n_tokens == 0) return 0.0f;   // leaks 4 MiB: this path never reaches delete[]
  // ... use scratch ...
  delete[] scratch;
  return sum;
}
```

An exception thrown in the middle leaks it too. The fix is not to be more careful. It is to stop writing `new` and `delete` by hand. Use `std::vector<float> scratch(1024 * 1024);` and the vector frees its memory however the function exits. When you need a single heap object, `std::make_unique` (Chapter 8) does the same. Modern C++ code almost never contains a bare `delete`, and when you see one in a code review, it deserves a second look. You still need to understand `new` and `delete`, because containers and smart pointers are built on them, and because older code and C libraries are full of them.

### What an allocation costs

A stack allocation is a subtraction. A heap allocation is a function call into the allocator, which has to find a free block of the right size, record that it is in use, and, in a multithreaded program, avoid colliding with other threads doing the same. For a large request it may also have to ask the operating system for fresh pages; glibc's `malloc`, for example, serves requests of 128 KiB and more with a separate `mmap` call by default, although it adjusts that threshold as the program runs. None of this is slow for one allocation, but an allocation inside a loop that runs a million times is a common reason C++ code is slower than expected.

Even Python cares about this: CPython has its own small-object allocator, pymalloc, for objects of 512 bytes or less, because calling `malloc` for every integer and float would be too slow. AI systems take the idea further:

- PyTorch does not call `cudaMalloc` and `cudaFree` for every tensor. Its caching allocator keeps freed GPU blocks and reuses them, because those driver calls are expensive and `cudaFree` waits for the GPU to finish its work. The [caching allocator section](/learn/pytorch-execution#the-cuda-caching-allocator) of the infra handbook shows how it works.
- vLLM allocates the KV cache once, at startup, as one large pool of fixed-size blocks sized by `gpu_memory_utilization`, and then hands blocks to requests from that pool. The [paged KV cache section](/learn/mini-inference-engine#the-paged-kv-cache) builds the same thing in Python.

The pattern in both is the same, and you will write it yourself in the capstone: allocate big blocks rarely, then reuse them.

## Lifetime: when objects are born and die

Every C++ object has a **lifetime**: it begins when the object's construction finishes and ends when its destructor starts. Outside its lifetime, the memory may still be there, but there is no object in it, and using it is undefined behavior. Python never lets you see this, because an object lives as long as anyone holds a reference to it. In C++ the rules are fixed and predictable, which is what makes C++ resource management work:

- A local object is destroyed when its enclosing block ends, and locals in the same block are destroyed in the **reverse order** of their construction. Reverse order is what you want: an object created later may depend on one created earlier, so it must go first.
- A **temporary**, such as the result of a function call that is never given a name, is destroyed at the end of the full expression that created it, which is usually the end of the statement.
- An object created with `new` lives until `delete`, regardless of scopes.
- A global is constructed before `main` starts and destroyed after `main` returns. A `static` variable inside a function is constructed the first time control reaches it, safely even if several threads arrive at once, and is also destroyed after `main` returns. Statics are destroyed in the reverse order of their construction.

The lab's `lifetime.cpp` makes this visible with a struct that prints a line in its constructor and its destructor:

```cpp
struct Tracer {
  const char* name;
  explicit Tracer(const char* n) : name(n) { std::printf("  construct %s\n", name); }
  ~Tracer() { std::printf("  destroy   %s\n", name); }
};

void scopes() {
  Tracer a("a");
  {
    Tracer b("b");
    Tracer c("c");
  }               // c is destroyed, then b
  Tracer d("d");
}                 // d is destroyed, then a
```

The order is not a quirk of one compiler. The standard requires it, so every conforming compiler prints `a`, `b`, `c` constructed, then `c` and `b` destroyed, then `d` constructed, and finally `d` and `a` destroyed. This determinism is a real advantage over Python. A file, a lock or a block of GPU memory owned by a C++ object is released at a known point in the code, while Python releases it whenever the last reference disappears, which in practice is often but not always immediately, and is why Python code needs `with` statements for files.

### Dangling: a pointer that outlives its object

A **dangling** pointer or reference refers to an object whose lifetime has ended. It still holds an address, and reading through it may even seem to work, because the old bytes are often still there. That is what makes it dangerous: the bug shows up later, somewhere else, as wrong data.

The textbook case is returning a reference to a local variable:

```cpp
const std::vector<float>& make_logits() {
  std::vector<float> logits(32000);
  return logits;   // logits is destroyed here, so the caller gets a reference to a dead object
}
```

Compilers catch this simple form. GCC and Clang both warn by default that the function returns a reference to a local, and the fix is to return the vector by value, which C++ makes cheap, as Chapter 7 explains.

The case that bites real systems is subtler, because nothing is returned and no compiler warns. A `std::vector` keeps its elements in one heap block with some spare room, its **capacity**. When you add an element and the spare room is used up, the vector allocates a larger block, moves the elements across, and frees the old block. Any pointer or reference into the old block now dangles:

```cpp
std::vector<float> cache;
cache.push_back(1.0f);
float* first = cache.data();          // points into the current block
for (int i = 0; i < 1000; ++i) cache.push_back(i);   // the vector reallocates, several times
float x = *first;                     // undefined behavior: that block was freed
```

Imagine this in an inference engine: one component keeps a pointer to a sequence's KV entries while another appends a new token, and attention silently reads freed memory. It produces plausible numbers, not a crash, at least until the allocator reuses the block. Two habits prevent it. Keep indexes rather than pointers into a container that can grow, or reserve the full size up front with `cache.reserve(n)`, which allocates once so that later `push_back` calls up to that size never move the elements. Chapter 5 shows how AddressSanitizer reports this bug the moment it happens, and the lab gives you a preview.

## sizeof, alignment and padding

`sizeof(T)` is the number of bytes an object of type `T` occupies, computed while compiling. For the basic types on mainstream 64-bit platforms the answers are the ones you would guess: 1 for `bool` and `char`, 4 for `int` and `float`, 8 for `double`, `std::int64_t` and any pointer. For a struct, though, the answer is often larger than the sum of its members, and the reason is **alignment**.

A processor reads memory most efficiently when a value starts at an address that is a multiple of its size, and some instructions require it. So every type has an alignment, given by `alignof(T)`: an 8-byte `double` must start at an address divisible by 8. To keep every member of a struct aligned, the compiler applies three rules:

1. Members are laid out in the order you declare them.
2. Each member starts at the next offset that is a multiple of its alignment, and the compiler inserts unused **padding** bytes to get there.
3. The struct's alignment is its largest member's alignment, and its size is rounded up to a multiple of that, so that the next element of an array is aligned too.

Here is per-block bookkeeping for a KV cache, written in the order someone thought of the fields:

```cpp
struct BlockInfo {
  bool in_use;             // offset 0, then 7 bytes of padding
  std::int64_t seq_id;     // offset 8
  std::int32_t ref_count;  // offset 16
  bool on_gpu;             // offset 20, then 3 bytes of padding
  double last_used;        // offset 24
  std::int32_t num_tokens; // offset 32, then 4 bytes of padding at the end
};                         // sizeof 40, of which 14 bytes are padding
```

The members hold 26 bytes of data, but the struct takes 40. Sort the same members from largest alignment to smallest, `seq_id`, `last_used`, `ref_count`, `num_tokens`, `in_use`, `on_gpu`, and the only padding left is 6 bytes at the end: `sizeof` drops to 32, 20% smaller, with no change in meaning. For one struct this is irrelevant. For a table with an entry per KV block, per token or per request, multiplied by millions, it is memory and cache space for free.

```widget
struct-layout
```

Three related tools are worth knowing now, and later chapters use them:

- `offsetof(T, member)`, from `<cstddef>`, gives a member's offset in bytes. Binary file formats and GPU code that share a struct between two programs check it with `static_assert`, because both sides must agree on every byte.
- `alignas(64)` raises a type's alignment. Two threads that update counters sitting in the same 64-byte cache line slow each other down, an effect called false sharing, and padding each counter to its own line is the fix. Chapter 20 covers it, and Chapter 13 explains cache lines.
- Packed layouts, written `#pragma pack` or `__attribute__((packed))`, remove padding entirely, at the price of unaligned access. They appear in code that reads file headers byte for byte. llama.cpp's quantized blocks avoid the need by choosing members that pack naturally: `block_q4_0` is a 2-byte scale followed by 16 bytes of 4-bit weights, 18 bytes with no padding, because a 2-byte alignment fits evenly into 18.

`sizeof` also explains the standard library's own types. `sizeof(std::vector<float>)` is 24 on 64-bit Linux and macOS no matter how many elements the vector holds, because the elements are on the heap. `sizeof(std::string)` is 32 with GCC's libstdc++ and 24 with LLVM's libc++, which Apple clang uses: both store short strings inside the string object itself, a trick called the small string optimization, and they reserve different amounts of room for it. A single empty struct, finally, has a `sizeof` of 1, not 0, because every object must have its own address.

## Lab: lifetimes, layouts and three crashes

The lab is three small programs: [`lifetime.cpp`](/labs/cpp/cpp-memory/lifetime.cpp), [`layout.cpp`](/labs/cpp/cpp-memory/layout.cpp) and [`memory_demo.cpp`](/labs/cpp/cpp-memory/memory_demo.cpp), with a [`CMakeLists.txt`](/labs/cpp/cpp-memory/CMakeLists.txt) that builds all three. Download the four files into one folder. It needs only a C++20 compiler and CMake. Build in Debug, so that the optimizer does not delete the work the crash demonstrations depend on:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
```

### Part 1: predict the order

Read `lifetime.cpp` before running it. It has a global `Tracer`, the `scopes` function above, a temporary, an object created with `new`, and a function-local `static` that is reached twice. Write down the complete order of `construct` and `destroy` lines you expect, then run `./build/lifetime` and compare. Pay attention to three lines in particular: `construct global` comes before `main starts`; `destroy temp` comes after the line that printed the temporary's name, because the temporary lives until the end of the whole `printf` statement; and the function-local static is constructed once, on the first call, and destroyed after `main returns`, before the global.

<!-- measure: the full output of ./build/lifetime on the Mac, and whether it matched the reader's prediction -->

### Part 2: measure the layouts

Run `./build/layout`. It prints `sizeof` and `alignof` for the built-in types, for `std::vector<float>` and `std::string`, and for both versions of `BlockInfo` with every member's offset. Check the offsets against the comments in the `BlockInfo` listing above. The file also contains five `static_assert` checks of these sizes, so if it compiled at all, they held on your machine.

Two lines in the output depend on your standard library. `sizeof(std::string)` should be 32 with GCC and 24 with Apple clang, and the program prints how many characters an empty string can hold before it needs the heap, which differs for the same reason. If you have both compilers, run it with each. `long double` is another line that differs: it is 16 bytes on x86-64 Linux but the same as `double` on ARM64 macOS.

<!-- measure: the full output of ./build/layout on the Mac (Apple clang, ARM64) and, if available, on Linux with GCC -->

### Part 3: three crashes on purpose

`memory_demo` takes one mode at a time:

```bash
./build/memory_demo heap-big       # 16 MiB of floats in a std::vector: works
./build/memory_demo stack-big      # the same 16 MiB as a local array: crashes
./build/memory_demo leak           # loses 4 MiB on each of ten early returns
./build/memory_demo dangling       # keeps a pointer into a vector that grows
./build/memory_demo dangling-read  # and then reads through it
```

The first two do the same work, and only the location of the buffer differs. `stack-big` should die with a segmentation fault and no other explanation, because a 16 MiB frame does not fit in an 8 MB stack. `leak` runs to the end without complaint, which is the whole problem with leaks. `dangling` prints the vector's data address before and after it grows, so you can see that the elements moved, and `dangling-read` then reads through the stale pointer. It will probably print a number, perhaps even the right one, because the freed block has not been reused yet. That is undefined behavior working exactly as described: no crash, no warning, possibly the wrong answer.

<!-- measure: for each mode in the Debug build, what happened (output, or the crash message from the shell), and the two data() addresses from dangling -->

Now rebuild with the sanitizers and run the same modes again:

```bash
cmake -S . -B build-san -DCMAKE_BUILD_TYPE=Debug -DLAB_SANITIZE=ON
cmake --build build-san
./build-san/memory_demo stack-big
./build-san/memory_demo dangling-read
./build-san/memory_demo leak
```

AddressSanitizer turns the silent bugs into reports. `stack-big` should now stop with an AddressSanitizer report and a stack trace, usually headed `ERROR: AddressSanitizer: stack-overflow`, although some platforms report it as a plain `SEGV` instead, and `dangling-read` should stop at the bad read with `ERROR: AddressSanitizer: heap-use-after-free`, followed by three stack traces: where the bad read happened, where the memory was freed (inside `push_back`, as the vector grew), and where it was originally allocated. That is often enough to find the bug without a debugger. For the leak, it depends on the platform. On Linux, AddressSanitizer includes LeakSanitizer, which reports `detected memory leaks` when the program exits, with the stack of each leaked allocation. Apple's clang does not support LeakSanitizer, so on a Mac use the system's `leaks` tool on the normal build instead: `leaks -atExit -- ./build/memory_demo leak`.

<!-- measure: the first lines of the ASan reports for stack-big and dangling-read on the Mac, and the leak report from `leaks -atExit` (Mac) or LeakSanitizer (Linux) -->

### Stretch goals

- In `dangling`, call `cache.reserve(1001);` right after creating the vector and run `dangling-read` under the sanitizer again. The data address should no longer change, and the report should disappear.
- Fix `score` so that it cannot leak, by replacing the `new[]` with a `std::vector<float>`, and confirm that the leak report is gone.
- Run `ulimit -s` in your shell to see the stack limit, in kilobytes, and `ulimit -Hs` to see the hard limit, the highest value you are allowed to set. On Linux, `ulimit -s 32768` raises the limit to 32 MB for programs started from that shell, after which `stack-big` should succeed. Try the same on macOS and note what happens.

## Check yourself

<details>
<summary>Why is creating a local array on the stack cheaper than allocating the same array with new?</summary>

A function's whole stack frame, including every local array, is reserved at once by moving the stack pointer, usually with one instruction, and released the same way on return. `new` calls the allocator, which must find a free block of the right size, record that it is in use and coordinate with other threads, and it must be matched by a `delete` that does the bookkeeping in reverse.

</details>

<details>
<summary>A function declares float logits[32000 * 128]; as a local variable and crashes with a segmentation fault the first time it runs. Why, and what is the fix?</summary>

The array is 4,096,000 floats, about 16 MB, which is larger than the usual 8 MB stack on Linux and macOS, so touching it runs past the end of the stack into the guard page. The fix is to put it on the heap, for example `std::vector<float> logits(32000 * 128);`, where the vector object on the stack is only 24 bytes.

</details>

<details>
<summary>In what order are a, b and c destroyed if they are declared in that order in one block, and why that order?</summary>

In reverse: `c`, then `b`, then `a`. Objects declared later may depend on objects declared earlier, for example a lock guard that refers to a mutex declared above it, so destroying them in reverse order guarantees that nothing is destroyed while a later object might still use it.

</details>

<details>
<summary>Code keeps a float* to an element of a std::vector&lt;float&gt;, and after more push_back calls the values read through it are wrong. What happened?</summary>

When a `push_back` exceeds the vector's capacity, the vector allocates a larger block, moves the elements to it and frees the old block. The pointer still holds the old address, so it dangles, and reading through it is a use-after-free. Store an index instead of a pointer, or call `reserve` with the final size first so that the vector never reallocates.

</details>

<details>
<summary>A struct holds a bool, a double and a bool, in that order. What is its sizeof on a 64-bit platform, and how can you shrink it?</summary>

24 bytes: the first `bool` is at offset 0, followed by 7 bytes of padding so the `double` can start at offset 8; the second `bool` is at offset 16, and the size is rounded up to a multiple of 8, giving 24. Putting the `double` first and the two `bool`s after it makes the layout 8 + 1 + 1 bytes, rounded up to 16.

</details>

<details>
<summary>Why do PyTorch and vLLM manage GPU memory with their own allocators or pools instead of allocating for each tensor?</summary>

Asking the driver for memory with `cudaMalloc` and returning it with `cudaFree` is expensive, and `cudaFree` waits for the GPU to finish its work. PyTorch's caching allocator keeps freed blocks and reuses them, and vLLM allocates its whole KV cache as a pool of fixed-size blocks at startup and hands them out to requests. Both follow the same rule as fast CPU code: allocate large blocks rarely and reuse them.

</details>

## Further reading

- [cppreference: storage duration](https://en.cppreference.com/w/cpp/language/storage_duration) and [cppreference: lifetime](https://en.cppreference.com/w/cpp/language/lifetime) give the precise rules for when objects are created and destroyed, including temporaries.
- [cppreference: new expression](https://en.cppreference.com/w/cpp/language/new) and [delete expression](https://en.cppreference.com/w/cpp/language/delete) describe what `new` and `delete` do, including the array forms.
- [cppreference: object, alignment](https://en.cppreference.com/w/cpp/language/object#Alignment) explains alignment and padding, and [`alignas`](https://en.cppreference.com/w/cpp/language/alignas) shows how to raise it.
- [The Lost Art of Structure Packing](http://www.catb.org/esr/structure-packing/), by Eric S. Raymond, is a long, practical guide to padding and how to reorder members to remove it.
- [AddressSanitizer in the Clang documentation](https://clang.llvm.org/docs/AddressSanitizer.html) lists the bugs it finds and the platforms where leak detection works.
- [Apple's Threading Programming Guide](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Multithreading/CreatingThreads/CreatingThreads.html) documents the 8 MB main-thread and 512 KB secondary-thread stack sizes on macOS.
- [A guide to PyTorch's CUDA caching allocator](https://zdevito.github.io/2022/08/04/cuda-caching-allocator.html), by Zachary DeVito, shows the same "allocate rarely, reuse often" idea applied to GPU memory.
