# Classes and RAII

Imagine a model server that loads LoRA adapters from disk when a request asks for one. The loader opens the adapter file, reads a small header, and if the adapter was trained for a different base model, it logs a warning and returns early. The early return forgets to close the file. Nothing goes wrong in testing, because a test opens a few dozen files. In production, every mismatched request leaks one file descriptor, and a process may hold only a fixed number of them: commonly 1,024 on Linux and 256 on macOS by default, as `ulimit -n` shows. A few days later the limit is reached, and every call that needs a new descriptor fails with `EMFILE`, "Too many open files". That includes `accept`, because network connections are file descriptors too, so the server stops taking requests altogether. It is still running, and the error it logs points at a line far away from the bug.

The bug is one missing line, and the obvious fix is to add `fclose` before the `return`. That fix lasts until the next person adds another early return, or until a function called in the middle throws an exception and skips the cleanup at the bottom. Python has the same problem and solves it with `with open(path) as f:`, which closes the file however the block ends. But in Python, `with` is something you remember to write. C++ goes further: every object's destructor runs automatically when the object's scope ends, by any path, so if a resource is owned by an object, it cannot be forgotten. This idea has an awkward name, **RAII**, for "resource acquisition is initialization", and it is the most important idea in C++. Containers, smart pointers, locks, threads and files in the standard library are all built on it, and so are GPU buffers, CUDA streams and device guards in PyTorch.

This chapter teaches the class features you need to write RAII types yourself: classes and their invariants, constructors and member initializer lists, `explicit`, destructors and what happens to them when an exception is thrown, types that refuse to be copied, and `const` member functions. It ends with a `ScopedTimer` that later chapters reuse for measurements. The lab leaks file descriptors until the operating system says no, watches destructors run while an exception travels up the stack, and lets the compiler catch four mistakes.

## Structs and classes

In Python, a class bundles data and the methods that act on it, and every attribute is reachable from outside: `self._cache` is private only by convention. A C++ class bundles the same things, but access is enforced by the compiler, and the layout of the data is fixed when the program is compiled.

C++ has two keywords for a class, `struct` and `class`, and they differ in exactly one way: members of a `struct` are public unless you say otherwise, and members of a `class` are private unless you say otherwise. (The same default applies to base classes, a detail that matters only with inheritance.) Everything else, including constructors, member functions and destructors, works identically in both. By convention, `struct` is used for plain bundles of data whose fields any value is allowed in, like Chapter 2's `SamplingParams` or Project A's `LogRecord`, and `class` for types that protect a rule about their data.

Here is the matrix from Chapter 4's lab, written as a class:

```cpp
class Matrix {
 public:
  Matrix(std::size_t rows, std::size_t cols) : rows_(rows), cols_(cols), data_(rows * cols, 0.0f) {}

  std::size_t rows() const { return rows_; }
  std::size_t cols() const { return cols_; }
  float& operator()(std::size_t r, std::size_t c) { return data_[r * cols_ + c]; }
  float operator()(std::size_t r, std::size_t c) const { return data_[r * cols_ + c]; }
  void fill(float value) { for (float& x : data_) x = value; }

 private:
  std::size_t rows_;
  std::size_t cols_;
  std::vector<float> data_;
};
```

The pieces, from top to bottom:

- The line that starts with `Matrix(` is a **constructor**, the function that runs when a `Matrix` is created. The next section covers it.
- `rows()`, `cols()` and `fill()` are **member functions**, C++'s name for methods. Inside one, the members are in scope without a prefix: `rows_` means "this object's `rows_`". There is no `self` parameter. A hidden pointer called `this` points at the object, and you rarely need to write it.
- `operator()` lets you write `m(1, 2)` to reach an element, the way `__getitem__` lets Python code write `m[1, 2]`. There are two versions, explained in the section on const member functions.
- The data members end with an underscore. That is only a naming convention, used by Google's style guide among others, which keeps members apart from parameters and local variables with the same name.

Calling a member function looks like Python: `m.fill(1.0f)`, or `p->fill(1.0f)` through a pointer. The object's size is the size of its data members plus padding, exactly as in Chapter 3. Member functions take no space in the object, because there is one copy of their code for the whole program. `sizeof(Matrix)` is 40 on a 64-bit machine: two 8-byte sizes and a 24-byte vector.

### Public, private and invariants

Why make members private at all? Because `Matrix` has an **invariant**, a rule that must hold for every `Matrix` at every moment: `data_.size()` equals `rows_ * cols_`. Every member function relies on it. `operator()` computes `r * cols_ + c` and trusts that the result is inside the vector. If `rows_` were public, any code anywhere could write `m.rows_ = 100` and break the rule, and the next element access would read past the end of the buffer, which Chapter 5 showed is undefined behavior with no error message.

With the members private, the only code that can change them is the class's own member functions, so to check the invariant you read one class instead of the whole program. That is what encapsulation buys in C++. It is not about hiding secrets. It is about making a rule small enough to verify. PyTorch's tensors have the same kind of invariant: the shape, the strides and the storage offset together must stay inside the storage, and `as_strided`, the function that sets all three directly, checks that the result does.

A useful rule of thumb from the C++ Core Guidelines: if a type has an invariant, make it a `class` with private data; if every combination of values is valid, as in a struct of sampling parameters, make it a `struct` with public data and no ceremony.

### Declaring in a header, defining in a source file

A member function defined inside the class body, as above, is implicitly `inline`, so the class can live in a header that many files include without breaking the one-definition rule from Chapter 1. Longer functions are usually declared in the class and defined in a `.cpp` file, with the class name and `::` in front:

```cpp
// matrix.h
class Matrix {
 public:
  float sum() const;   // declared here
  // ...
};

// matrix.cpp
float Matrix::sum() const {   // defined here; Matrix:: says whose sum this is
  float s = 0.0f;
  for (float x : data_) s += x;
  return s;
}
```

This keeps the header short, and a change to the function body recompiles only `matrix.cpp`, not every file that includes the header. The lab's `matrix.h` keeps everything in the header because the class is small.

## Constructors

A **constructor** is a member function with the same name as the class and no return type. It runs when the object is created and its job is to establish the invariant, so that every object is valid from its first moment. Python's `__init__` is the closest equivalent, with one difference that matters: in Python the object already exists, empty, when `__init__` runs, while in C++ the object does not exist until its constructor finishes. If the constructor throws, there is no object.

```cpp
Matrix a(2, 3);        // calls Matrix(std::size_t, std::size_t)
Matrix b{2, 3};        // the same, with braces
auto c = Matrix(2, 3); // the same again
```

A class can have several constructors with different parameters, chosen by overloading like any function. If you write no constructor at all, the compiler generates a **default constructor**, one with no parameters, that default-initializes each member. As soon as you write any constructor yourself, that default constructor is no longer generated, so `Matrix m;` stops compiling. Usually that is what you want: a `Matrix` with no shape has no meaning. If you do want one, write `Matrix() = default;` and give the members default values.

Members can have default values written where they are declared, called **default member initializers**:

```cpp
struct GenerationStats {
  std::int64_t prompt_tokens = 0;
  std::int64_t output_tokens = 0;
  double seconds = 0.0;
};
```

Every constructor that does not set these members uses the defaults, so a forgotten member is zero instead of an uninitialized value. Chapter 5 showed what reading an uninitialized value costs, so this is a cheap habit worth having.

### Member initializer lists

The part after the colon, `: rows_(rows), cols_(cols), data_(rows * cols, 0.0f)`, is the **member initializer list**. It says how each member is constructed. Python programmers tend to write the same thing in the body instead:

```cpp
Matrix(std::size_t rows, std::size_t cols) {
  rows_ = rows;                          // assignment, not initialization
  cols_ = cols;
  data_ = std::vector<float>(rows * cols);
}
```

This compiles, but it does something different. Every member is fully constructed before the constructor's body starts, so here `data_` is first constructed as an empty vector, and then a second vector is built and assigned over it. For `std::size_t` the difference is invisible. For members that are expensive to construct, it is wasted work. And for three kinds of member the body version does not compile at all, because they cannot be assigned after construction: `const` members, reference members, and members of a type with no default constructor, such as a `Matrix` inside another class. The rule is simple: initialize members in the initializer list, and use the body only for work that is not initialization, such as checking arguments.

The initializer list has one trap. Members are always initialized in the order they are **declared in the class**, not the order they are written in the list. Suppose someone moves `data_` to the top of the class and also changes its initializer to use the members instead of the parameters:

```cpp
class BadMatrix {
 public:
  BadMatrix(std::size_t rows, std::size_t cols) : rows_(rows), cols_(cols), data_(rows_ * cols_) {}
 private:
  std::vector<float> data_;   // declared first, so initialized first
  std::size_t rows_;
  std::size_t cols_;
};
```

The list reads as if `rows_` and `cols_` are set before `data_`, but `data_` is declared first, so it is initialized first, from two members that hold no value yet. That is a read of uninitialized memory: the vector may get some huge size, throw, or be empty. GCC and Clang both warn about the mismatched order with `-Wall` (the warning is `-Wreorder`), and Clang also warns that the field is used uninitialized. The habit that avoids it: write the initializer list in declaration order, and initialize from the constructor's parameters rather than from other members where you can. The lab's Part 4 shows you the warnings.

### explicit

A constructor that can be called with one argument is also, by default, a **conversion**: the compiler will use it silently to turn the argument's type into your class. The `Buffer` class this chapter builds owns an array of floats, and its constructor takes the number of elements:

```cpp
void report(const Buffer& b);

report(1024);   // without explicit: compiles, builds a temporary Buffer of 1,024 floats, and passes it
```

Nobody reading `report(1024)` would guess that it allocates 4 KiB and zeroes it. Worse, an innocent typo such as passing a token count where a buffer was expected compiles cleanly. Marking the constructor `explicit` turns off the silent conversion:

```cpp
class Buffer {
 public:
  explicit Buffer(std::size_t n);
  // ...
};

report(1024);           // error: no implicit conversion from int to Buffer
report(Buffer(1024));   // fine: the conversion is visible in the code
```

The standard library does the same: `std::vector`'s constructor that takes a size is `explicit`, so `std::vector<float> v = 10;` does not compile and you must write `std::vector<float> v(10);`. The C++ Core Guidelines recommend making every single-argument constructor `explicit` unless you really want the conversion, as `std::string` does when it accepts a string literal. The lab's Part 4 shows the error.

## Destructors

A **destructor** is the constructor's opposite. It is written with a tilde, `~Buffer()`, takes no arguments, and runs automatically when the object's lifetime ends: when a local object's scope ends, when `delete` destroys a heap object, when a container destroys its elements, or when a temporary dies at the end of its statement. Chapter 3 listed exactly when each of those happens. You almost never call a destructor yourself.

```cpp
class Buffer {
 public:
  explicit Buffer(std::size_t n) : data_(new float[n]()), size_(n) {}
  ~Buffer() { delete[] data_; }
  // ...
 private:
  float* data_;
  std::size_t size_;
};
```

When a `Buffer` dies, its destructor body runs first, and then its members are destroyed in the reverse order of their declaration. `Matrix` needs no destructor at all, because its only resource is inside `data_`, and the `std::vector`'s own destructor frees it when the `Matrix` is destroyed. That is worth noticing: a class made of members that clean up after themselves gets correct cleanup for free.

Python has `__del__`, but it is a poor equivalent. CPython usually calls it when the last reference disappears, but not when the object is part of a reference cycle until the garbage collector runs, and the language does not promise to call it at all for objects still alive when the interpreter exits. That is why Python code cannot rely on `__del__` to close a file and uses `with` instead. A C++ destructor runs at a point you can find by reading the code.

Two rules about destructors matter in practice:

- **A destructor should never throw.** Since C++11, destructors are implicitly `noexcept`, so an exception that escapes one calls `std::terminate`, which ends the program. The reason is that destructors run while another exception may already be travelling up the stack, as the next section shows, and C++ cannot handle two at once. If cleanup can fail, as `fclose` can when it flushes data to a full disk, the destructor should log or ignore the error, and code that cares should call an explicit `close()` that reports it first.
- **A constructor that throws does not run its own destructor**, because the object never existed. Members that were already fully constructed are destroyed, though. This is why each resource should have its own owner. A class holding two raw pointers, `a_ = new float[n]; b_ = new float[n];`, leaks `a_` if the second `new` throws, because no destructor will run. A class holding two `std::vector`s cannot leak, because the first vector is a fully constructed member and is destroyed during the failed construction.

### Destructors during an exception

When an exception is thrown, the program looks up the call stack for a `catch` that matches it. As the exception leaves each function, every local object in that function is destroyed, in reverse order, exactly as if the function had returned. This process is called **stack unwinding**, and it is what makes RAII work with exceptions:

```cpp
void handle_request(int tokens) {
  File model("model.bin", "rb");
  std::lock_guard<std::mutex> lock(model_mutex);
  run_layer(tokens);           // throws std::length_error for a too-long prompt
}                              // never reached normally; during unwinding, lock is released, then model is closed

int main() {
  try {
    handle_request(8192);
  } catch (const std::exception& e) {
    std::printf("caught: %s\n", e.what());   // by now the lock is free and the file is closed
  }
}
```

By the time the `catch` block runs, every object between the `throw` and the `catch` has been destroyed. The lab's `unwind` mode prints each destruction as it happens.

There are three ways out of a program that skip some or all destructors, and they are worth knowing so that you are not surprised:

- If no `catch` anywhere matches the exception, the program calls `std::terminate`, and the standard leaves it to the implementation whether the stack is unwound first. With GCC and Clang on Linux and macOS, the usual result is that no destructors run at all, because the runtime first searches the stack for a handler and gives up before unwinding anything. The lab's `unwind-uncaught` mode lets you check.
- `std::exit` ends the program without unwinding the stack. It destroys global and `static` objects, but not the local variables of the functions that are still running.
- A crash, such as a segmentation fault, or `std::abort`, runs no destructors at all.

None of this is a weakness of RAII in practice. The operating system reclaims a dead process's memory and file descriptors anyway. What a destructor cannot do after a crash is finish work outside the process, such as flushing a half-written checkpoint, which is why careful programs write to a temporary file and rename it only when it is complete.

## RAII: tie every resource to an object

Now the pieces fit together. **RAII** means: acquire a resource in a constructor, release it in the matching destructor, and let an object's lifetime decide how long you hold it. The name is clumsy, and many people prefer "scope-bound resource management", but the idea is simple. A resource is anything you must give back: memory, a file, a lock, a thread, a socket, a GPU allocation, a CUDA stream. Here is the file wrapper from the lab:

```cpp
class File {
 public:
  File(const char* path, const char* mode) : f_(std::fopen(path, mode)) {
    if (f_ == nullptr) throw std::runtime_error(std::string("cannot open ") + path);
  }
  ~File() { std::fclose(f_); }
  File(const File&) = delete;              // explained in the next section
  File& operator=(const File&) = delete;
  std::FILE* get() const { return f_; }

 private:
  std::FILE* f_;
};
```

The constructor either produces an open file or throws, so a `File` object always holds an open file: that is its invariant, and it is why the destructor can call `fclose` without checking for null. With it, the adapter loader from the introduction cannot leak:

```cpp
std::optional<Adapter> load_adapter(const char* path, const ModelInfo& base) {
  File f(path, "rb");
  Header h = read_header(f.get());
  if (h.base_model != base.name) {
    log_warning("adapter %s was trained for %s", path, h.base_model.c_str());
    return std::nullopt;              // f is closed here
  }
  return parse_adapter(f.get(), h);   // and here, and also if parse_adapter throws
}
```

Compare this with the version that pairs `fopen` and `fclose` by hand. That version needs a `fclose` on every return path and a `try`/`catch` around anything that might throw, and every future edit must keep them all in place. The RAII version has no cleanup code at all, so there is nothing to forget. The widget below shows the difference on a function that holds three resources at once. Try every exit path with both versions.

```widget
raii-stepper
```

Try these settings:

- **Manual cleanup, Exception.** The exception skips all three cleanup lines. The leaked buffer and file are bad, but the locked mutex is worse: the next request that calls `mu.lock()` waits forever, and the server hangs instead of crashing, which is much harder to diagnose.
- **RAII, Exception.** The three destructors run during unwinding, in reverse order of construction: the buffer is freed first, then the lock is released, then the file is closed.
- **RAII, Early return.** The same three destructors run, from a different line. With RAII, every exit path is handled by the same code.

The reverse order is not a detail. An object created later may depend on one created earlier, such as a buffer filled from an open file, so it must be destroyed first. Chapter 3's tracer showed the rule; RAII is the reason it exists.

### RAII in the libraries you will use

Once you know the pattern you see it everywhere. Every resource has a pair of functions, one to acquire and one to release, and a class that ties them to a lifetime:

| Resource        | Acquire and release by hand                | RAII owner                                    |
| --------------- | ------------------------------------------ | --------------------------------------------- |
| Heap memory     | `new` and `delete`                         | `std::vector`, `std::unique_ptr` (Chapter 8)  |
| A file          | `fopen` and `fclose`                       | `std::ifstream`, `std::ofstream`, or `File`   |
| A mutex         | `lock()` and `unlock()`                    | `std::lock_guard`, `std::scoped_lock`         |
| A thread        | create, then `join()`                      | `std::jthread` (C++20)                        |
| GPU memory      | `cudaMalloc` and `cudaFree`                | your own class, or a library's tensor storage |
| A CUDA stream   | `cudaStreamCreate` and `cudaStreamDestroy` | your own class, or PyTorch's stream wrappers  |
| The current GPU | `cudaSetDevice`, then set it back          | PyTorch's `c10::cuda::CUDAGuard`              |
| Python's GIL    | release, then reacquire                    | pybind11's `py::gil_scoped_release`           |

A few of these deserve a sentence each, because you will meet them in AI infrastructure code:

- **`std::lock_guard`** locks a mutex in its constructor and unlocks it in its destructor. Chapter 17 uses it everywhere, and it is the reason a C++ mutex is almost never unlocked by hand.
- **`std::thread`** is a warning about what happens without RAII. If a `std::thread` object is destroyed while its thread is still joinable, its destructor calls `std::terminate`, so an exception between creating a thread and joining it kills the program. C++20's `std::jthread` joins in its destructor instead, and Chapter 16 prefers it for that reason.
- **PyTorch's device guard.** `c10::cuda::CUDAGuard` sets the current CUDA device in its constructor and restores the previous device in its destructor. PyTorch's operator code uses device guards so that work for a tensor on GPU 1 runs on GPU 1, and the caller's current device is restored on every way out, including errors. `torch::NoGradGuard`, PyTorch's C++ version of Python's `with torch.no_grad():`, turns off gradient tracking for exactly one scope in the same way.
- **pybind11's GIL guards.** C++ code called from Python holds the GIL. A long computation should release it so that other Python threads can run, and `py::gil_scoped_release release;` does so in its constructor and reacquires the GIL in its destructor, even if the computation throws. Chapter 22 uses it, and the infra handbook's [native code chapter](/learn/native-code) explains why it matters.

A GPU buffer class looks exactly like `Buffer`, with `cudaMalloc` and `cudaFree` in place of `new[]` and `delete[]`, and a CUDA stream class looks like `File`. Part VI writes both. The shape never changes: one resource, one owner, released in the destructor.

## Non-copyable types

There is one more thing a resource-owning class must decide, and getting it wrong turns RAII into a double free. In C++, objects are copied all the time: when you pass by value, when you return by value (though Chapter 7 shows the copy is usually avoided), when you write `File b = a;`, and when a `std::vector` of them grows. If a class does not say how it is copied, the compiler generates a **copy constructor** and a **copy assignment operator** that copy every member, one by one.

For `Matrix` that generated copy is exactly right: copying the `std::vector` member copies all the elements, so the new `Matrix` has its own data. For `File` and `Buffer` it is a disaster:

```cpp
{
  Buffer a(1024);
  Buffer b = a;    // with the generated copy: b.data_ is the same pointer as a.data_
}                  // b's destructor deletes the array, then a's destructor deletes it again
```

Copying the pointer member copies the address, not the floats, so two objects now believe they own one array. When they are destroyed, the array is freed twice, which Chapter 5 showed is undefined behavior and which AddressSanitizer reports as `attempting double-free`. Before that, writing through `b` silently changes `a`. For `File`, both destructors would call `fclose` on the same `FILE*`.

The quickest correct fix is to forbid copying. Writing `= delete` after a function's declaration deletes it: the function exists for overload resolution, but any code that would call it fails to compile:

```cpp
class Buffer {
 public:
  explicit Buffer(std::size_t n) : data_(new float[n]()), size_(n) {}
  ~Buffer() { delete[] data_; }

  Buffer(const Buffer&) = delete;              // no copy construction: Buffer b = a; fails
  Buffer& operator=(const Buffer&) = delete;   // no copy assignment:   b = a;        fails

  float* data() { return data_; }
  const float* data() const { return data_; }
  std::size_t size() const { return size_; }

 private:
  float* data_;
  std::size_t size_;
};
```

Now `Buffer b = a;` is a compile error that names the deleted copy constructor, which is a far better place to find the problem than a crash in a destructor. You can still pass a `Buffer` around by reference, `const Buffer&` or `Buffer&`, because a reference does not copy.

Many standard types make the same choice. `std::mutex` cannot be copied, because two objects cannot sensibly be the same lock. `std::unique_ptr` cannot be copied, because its whole point is that exactly one owner frees the object. PyTorch's `CUDAGuard` deletes its copies too. A non-copyable type is not a lesser type. It is one whose author thought about what copying would mean and decided it had no correct meaning.

Forbidding copies has a cost, though. A non-copyable `Buffer` cannot be returned from a function that creates it, or stored in a `std::vector` that grows, or handed to another thread, because all of those need either a copy or something else. That something else is a **move**, which transfers ownership of the array from one `Buffer` to another without copying the floats. Chapter 7 gives `Buffer` a real copy and, more importantly, a move.

## const member functions

Chapter 4 showed `const` on variables, pointers and references, and promised that member functions get it too. A member function marked `const` after its parameter list promises not to modify the object it is called on:

```cpp
std::size_t rows() const { return rows_; }   // reads only: may be called on a const Matrix
void fill(float value) { /* writes data_ */ } // modifies: may not
```

Inside a `const` member function, `this` points to a const object, so assigning to a member is a compile error. The promise matters at the call site. Code that receives a `const Matrix&`, which is how you pass a matrix you will only read, may call only the `const` member functions:

```cpp
float trace(const Matrix& m) {
  float t = 0.0f;
  for (std::size_t i = 0; i < m.rows(); ++i) t += m(i, i);   // rows() and the const operator() are fine
  m.fill(0.0f);   // error: fill is not const
  return t;
}
```

The common mistake runs the other way. Someone writes a getter like `std::size_t rows() { return rows_; }` and forgets the `const`. It works until the first time somebody calls it through a `const Matrix&`, and then the compiler refuses, because it cannot know that `rows()` does not modify anything. So mark every member function that does not modify the object `const` when you write it. The lab's Part 4 shows the error you get otherwise.

`const` is also part of a member function's signature, so a class can have two versions of one function, and the compiler picks by the constness of the object. That is why `Matrix` has two `operator()`s:

```cpp
float& operator()(std::size_t r, std::size_t c)       { return data_[r * cols_ + c]; }   // for a non-const Matrix
float  operator()(std::size_t r, std::size_t c) const { return data_[r * cols_ + c]; }   // for a const Matrix
```

On a non-const matrix, `m(0, 0) = 4.0f` calls the first version, which returns a reference into the data, so the assignment changes the matrix. On a `const Matrix&`, the second is chosen, and it returns a copy of the value, so an assignment through it does not compile. `std::vector::operator[]` and `data()` come in the same two flavours, and so do the `data()` functions of `Buffer`.

### mutable

Occasionally a member must change inside a `const` function without changing the object's observable value. The two classic cases are a cache and a mutex:

```cpp
class Vocab {
 public:
  std::size_t size() const {
    std::lock_guard<std::mutex> lock(mu_);   // locking modifies mu_, inside a const function
    return tokens_.size();
  }
 private:
  mutable std::mutex mu_;   // mutable: may be modified even in const member functions
  std::vector<std::string> tokens_;
};
```

`size()` really is read-only from the caller's point of view, but locking the mutex changes the mutex's state. Marking `mu_` `mutable` allows that. Use `mutable` only for this kind of internal bookkeeping. There is also a convention behind it: the standard library assumes that calling `const` member functions from several threads at once is safe, so a `mutable` cache that is filled inside a `const` function needs a lock or an atomic. Part IV returns to this.

## A reusable ScopedTimer

Here is RAII applied to time instead of memory. You will measure a great deal in this course, and the simplest timing tool in C++ is an object that records the time when it is created and prints the elapsed time when it is destroyed. Scope a block with one, and the block is timed, whichever way it exits:

```cpp
class [[nodiscard]] ScopedTimer {
 public:
  explicit ScopedTimer(const char* label) : label_(label), start_(std::chrono::steady_clock::now()) {}

  ~ScopedTimer() {
    auto elapsed = std::chrono::steady_clock::now() - start_;
    std::fprintf(stderr, "%s: %.3f ms\n", label_, std::chrono::duration<double, std::milli>(elapsed).count());
  }

  ScopedTimer(const ScopedTimer&) = delete;
  ScopedTimer& operator=(const ScopedTimer&) = delete;

 private:
  const char* label_;
  std::chrono::steady_clock::time_point start_;
};
```

Using it takes one line:

```cpp
{
  ScopedTimer t("load weights");
  load_weights(path);
}   // prints "load weights: ..." here
```

Each design choice has a reason:

- **`std::chrono::steady_clock`**, not `system_clock`. The system clock follows wall time, which can jump forwards or backwards when the machine synchronizes with a time server. The steady clock only moves forward at a constant rate, which is what you want for measuring intervals.
- **`duration<double, std::milli>`** converts the elapsed time, whatever the clock's internal unit is, to milliseconds as a `double`. `<chrono>` keeps units in the type, so you cannot mix up nanoseconds and milliseconds by accident.
- **It prints to `stderr`**, so timing lines do not mix with a program's real output on `stdout`, and you can redirect one without the other.
- **It is not copyable**, because one timer measures one interval. A copy would print the same interval twice.
- **`[[nodiscard]]` on the class** catches the classic RAII mistake, described next.

The mistake is forgetting the variable name:

```cpp
ScopedTimer("matmul 512");   // no name: a temporary
Matrix c = matmul(a, b);     // not timed
```

Without a name, `ScopedTimer("matmul 512")` creates a temporary, and Chapter 3 showed that a temporary is destroyed at the end of its full expression, here the semicolon. The timer starts and stops on the same line, prints something close to zero, and the matmul runs untimed. The same mistake with a lock, `std::lock_guard<std::mutex>{mu};`, locks and immediately unlocks, leaving the code that follows unprotected, and it compiles cleanly. Since C++20, the standard encourages compilers to warn when a temporary of a class marked `[[nodiscard]]` is created and thrown away like this, and the lab's `timer-bug` mode lets you see what your compiler says. You can also mark just the constructor `[[nodiscard]]`, which is the approach some libraries, Qt among them, have discussed for their lock types.

One limit of `ScopedTimer` is important enough to state now, although Chapter 14 covers it properly. In a Release build, the optimizer may delete work whose result is never used, and it can move computations across the clock calls. The lab prints one element of every matmul result for that reason. A timer tells you how long a block took; whether the block did what you think needs a little care.

## Lab: file handles, unwinding and a timer

The lab is one program, [`raii_demo.cpp`](/labs/cpp/cpp-raii/raii_demo.cpp), with a mode for each experiment, four small headers that hold the chapter's classes, [`file.h`](/labs/cpp/cpp-raii/file.h), [`buffer.h`](/labs/cpp/cpp-raii/buffer.h), [`matrix.h`](/labs/cpp/cpp-raii/matrix.h) and [`scoped_timer.h`](/labs/cpp/cpp-raii/scoped_timer.h), and [`mistakes.cpp`](/labs/cpp/cpp-raii/mistakes.cpp), which holds four mistakes for the compiler to catch. [`CMakeLists.txt`](/labs/cpp/cpp-raii/CMakeLists.txt) builds everything. Download all seven files into one folder. You need only a C++20 compiler and CMake. Build a Release version, since Part 5 measures time:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

`scoped_timer.h` is meant to be reused, so keep a copy somewhere you can find it. Later labs include their own copy.

### Part 1: run out of file descriptors

First check your limit:

```bash
ulimit -n
```

Then run the leaky version, which calls a function 100,000 times. The function opens a small file, and because the file starts with `#`, it takes the early return that forgets `fclose`:

```bash
./build/raii_demo fds-leak
```

It should stop with a line saying which call failed and why, and the reason should be `Too many open files`. Predict the call number before you run it. Each call leaks one descriptor, and three are already taken by standard input, output and error, so the failing call should be close to your limit. Then run the same loop with the `File` class:

```bash
./build/raii_demo fds-raii
```

All 100,000 calls should succeed, because `File`'s destructor closes the file on the early return. The two functions in `raii_demo.cpp` differ only in who closes the file.

<!-- measure: the output of `ulimit -n` and of both fds modes on the Mac (and on Linux if available), and how far the failing call number was from the limit -->

### Part 2: watch the stack unwind

```bash
./build/raii_demo unwind
```

`handle_request` acquires three things, a model file, a real `std::lock_guard` on a mutex, and a scratch buffer, each represented by an object that prints when it is acquired and released, and then `run_layer` throws because the prompt is too long. Before running it, write down the order of the `acquire` and `release` lines and where `caught:` appears. You should see the three releases in reverse order, all before `caught:`, and then `the mutex is free again`. That last line comes from code that locks the same mutex after the `catch`. If unwinding had not released the lock, the program would hang there forever.

Then remove the `catch`:

```bash
./build/raii_demo unwind-uncaught
```

Now nothing catches the exception. The program ends with an error about an uncaught exception, and the shell reports an abort. Count the `release` lines. The standard leaves this case to the implementation, and the usual result with GCC and Clang is that none appear.

<!-- measure: the output of unwind and unwind-uncaught on the Mac, and how many release lines unwind-uncaught printed -->

### Part 3: std::exit skips the locals

```bash
./build/raii_demo exit
```

`exit_midway` has a local `Step`, a function-local `static` `Step`, and there is a global `Step` too. It then calls `std::exit(0)`. Before running it, predict which of the three `release` lines appear. Following the rules in this chapter, the static and the global should be released, in reverse order of construction, and the local should not.

<!-- measure: the output of the exit mode -->

### Part 4: let the compiler catch four mistakes

`mistakes.cpp` holds one mistake per number. Build it with each in turn and read what the compiler says:

```bash
cmake -S . -B build-m -DLAB_MISTAKE=1 && cmake --build build-m
cmake -S . -B build-m -DLAB_MISTAKE=2 && cmake --build build-m
cmake -S . -B build-m -DLAB_MISTAKE=3 && cmake --build build-m
cmake -S . -B build-m -DLAB_MISTAKE=4 && cmake --build build-m && ./build-m/mistakes
```

1. **Copying a `File`.** The error should name the deleted copy constructor of `File`, and many compilers also point at the line in `file.h` where it was deleted.
2. **Calling `fill` on a `const Matrix`.** The error says that `fill` cannot be called on a const object, though compilers word it differently: look for "const" and "discards qualifiers" or "not marked const".
3. **Passing `1024` where a `const Buffer&` is expected.** Because `Buffer(std::size_t)` is `explicit`, there is no conversion, and the error says so.
4. **The `BadMatrix` initialization order.** This one compiles, with warnings. Find the `-Wreorder` warning, and with Clang, a warning that `rows_` is used uninitialized. Then run it. The program asks for a vector whose size is computed from two uninitialized values, so it may print a wrong size, throw `std::length_error` or `std::bad_alloc`, or even print 4,096 by luck. Whatever it does, it is undefined behavior.

<!-- measure: the first line of each compiler error for mistakes 1 to 3, the warnings for mistake 4, and what ./build-m/mistakes printed, with the compiler name and version -->

### Part 5: time a matmul, then break the timer

```bash
./build/raii_demo timer
./build/raii_demo timer-bug
```

`timer` multiplies square matrices of size 128, 256 and 512 with the naive `matmul` from Chapter 4, now written on `Matrix`, and times each one with its own `ScopedTimer` inside a timer for all three. The work grows as n³, so each doubling of n should take roughly eight times longer, although cache effects, which Chapter 13 explains, often make the largest size worse than that. Each line also prints `c(0,0)`, which should be n × 0.5: 64, 128 and 256.

`timer-bug` is the same 512 matmul timed by a `ScopedTimer` with no name. Before you run it, look at the build output from the first step: did the compiler warn about the discarded temporary? Then run it, and compare the time it prints with the 512 line from `timer`.

<!-- measure: the three matmul times and the total from `timer` (Release, on the Mac), the time printed by timer-bug, and whether the compiler warned about the nameless ScopedTimer and with what message -->

### Stretch goals

- Rebuild with `-DLAB_SANITIZE=ON` and run `fds-leak` again. AddressSanitizer does not track file descriptors, so expect the same `Too many open files` failure and no report. Leaks of things other than memory are invisible to it, which is one more reason to make them impossible with RAII.
- Add a `close()` member function to `File` that calls `fclose`, reports its result, and sets `f_` to `nullptr`, and change the destructor to close only if `f_` is not null. Explain why a caller who writes data would want to call `close()` before the destructor runs.
- Write a `ScopedTimer` variant that adds the elapsed time to a `double&` passed to its constructor, instead of printing, so a loop can total the time spent in one phase across many iterations.
- Write a `CurrentDirectoryGuard` that saves the working directory with `getcwd` in its constructor, changes to a new one with `chdir`, and restores the old one in its destructor. It is the same shape as PyTorch's device guard.

## Check yourself

<details>
<summary>What is the only difference between struct and class in C++, and how is each usually used?</summary>

Members of a `struct` are public by default and members of a `class` are private by default; everything else is the same. By convention, `struct` is used for plain data where any combination of values is valid, and `class` for types with an invariant that private members protect, such as a matrix whose buffer size must equal rows times columns.

</details>

<details>
<summary>Why should members be initialized in the member initializer list rather than assigned in the constructor body?</summary>

All members are constructed before the body runs, so assigning in the body first constructs each member and then overwrites it, which wastes work for expensive members. Some members cannot be assigned at all after construction: `const` members, references, and members without a default constructor. They must be initialized in the list.

</details>

<details>
<summary>A class declares data_ before rows_ and cols_, and its constructor's initializer list is rows_(rows), cols_(cols), data_(rows_ * cols_). What goes wrong?</summary>

Members are initialized in declaration order, not list order, so `data_` is initialized first, from `rows_` and `cols_` before either holds a value. That reads uninitialized memory, which is undefined behavior. `-Wall` turns on `-Wreorder`, which warns about the mismatch. The fix is to declare the members in the order they depend on each other, or to initialize `data_` from the parameters `rows` and `cols`.

</details>

<details>
<summary>A function locks a mutex, calls a function that throws, and unlocks the mutex at the end. What happens to the next caller, and how does RAII fix it?</summary>

The exception skips the `unlock`, so the mutex stays locked and the next caller waits forever. Locking with `std::lock_guard` ties the lock to an object: during stack unwinding, the guard's destructor runs and unlocks the mutex, so every exit path, including exceptions, releases it.

</details>

<details>
<summary>Why does a class that owns a raw pointer need to delete or define its copy operations, while a class whose only data is a std::vector does not?</summary>

The compiler-generated copy copies each member. For a raw pointer that copies the address, so two objects own the same array and both destructors delete it, a double free. A `std::vector` member already knows how to copy itself by copying its elements, so the generated copy of the enclosing class is correct with no extra code.

</details>

<details>
<summary>Why does `ScopedTimer("load");` with no variable name time nothing, and what helps catch it?</summary>

Without a name it is a temporary, destroyed at the end of the full expression, so the timer is created and destroyed on the same line and the code after it is not timed. Marking the class or its constructor `[[nodiscard]]` asks the compiler to warn when such a temporary is discarded. The same mistake with a `std::lock_guard` leaves the following code unprotected.

</details>

## Further reading

- [cppreference: RAII](https://en.cppreference.com/w/cpp/language/raii) gives the definition and lists the standard library classes that follow it.
- [cppreference: constructors and member initializer lists](https://en.cppreference.com/w/cpp/language/constructor) explains initialization order, and [cppreference: destructors](https://en.cppreference.com/w/cpp/language/destructor) explains destruction order and when destructors run.
- [cppreference: explicit specifier](https://en.cppreference.com/w/cpp/language/explicit) and [cppreference: const- and volatile-qualified member functions](https://en.cppreference.com/w/cpp/language/member_functions) cover the two keywords this chapter added to member functions.
- [cppreference: throwing exceptions](https://en.cppreference.com/w/cpp/language/throw) describes stack unwinding, and [cppreference: std::exit](https://en.cppreference.com/w/cpp/utility/program/exit) lists which objects are and are not destroyed.
- [cppreference: nodiscard](https://en.cppreference.com/w/cpp/language/attributes/nodiscard) lists when the compiler is encouraged to warn, including discarded temporaries of `[[nodiscard]]` types.
- The [C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines), sections C (classes) and R (resource management), give the rules of thumb used here: `class` for invariants, `explicit` single-argument constructors, and one resource per owner.
- [PyTorch's C++ documentation on CUDA guards](https://docs.pytorch.org/cppdocs/api/cuda/guards.html) describes `CUDAGuard` and its stream equivalent, and [pybind11's notes on the GIL](https://pybind11.readthedocs.io/en/latest/advanced/misc.html) describe `gil_scoped_release`.
- `man getrlimit` documents `RLIMIT_NOFILE`, the per-process limit on open file descriptors that `ulimit -n` shows, on both Linux and macOS.
