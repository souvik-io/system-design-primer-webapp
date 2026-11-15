# Copy and move semantics

Here is a bug that costs nothing to write and a great deal to run. A small C++ inference engine walks through a model's layers for every token it generates:

```cpp
for (auto layer : model.layers) {
  x = layer.forward(x);
}
```

It looks exactly like the Python it was translated from, `for layer in model.layers:`, and it gives exactly the right answer. It is also copying the whole model for every token. In Python, the loop variable is a new name for an object that already exists. In C++, `auto layer` declares a new `Layer` object and initializes it from the element in the vector, which means copying it, weights and all. Each copy is destroyed at the end of the iteration, and the next iteration copies the next layer.

Put numbers on it with Llama 2 7B, which has 32 layers, a hidden size of 4,096 and an MLP size of 11,008. One layer holds four 4,096 × 4,096 attention matrices (67,108,864 weights), three 4,096 × 11,008 MLP matrices (135,266,304 weights) and two norm vectors (8,192 weights), 202,383,360 weights in all, about 405 MB in fp16. The loop copies all 32 layers, about 12.95 GB, for every token. A copy reads every byte and writes it again, so that is about 26 GB of memory traffic, on top of the 12.95 GB that the forward pass itself must read. On a machine with 100 GB/s of memory bandwidth, reading the weights once takes at least 0.13 seconds per token, and the copies add at least 0.26 seconds more. One missing `const auto&` makes generation at least three times slower, and no test will fail.

The fix is one token, `for (const auto& layer : model.layers)`, but knowing where to put it requires a clear picture of when C++ copies, when it can avoid copying, and how you tell it to hand data over instead. That picture is this chapter. It covers what a copy is and how to write one, the lvalues and rvalues that decide which operation runs, what `std::move` actually does (less than its name suggests), how to write a move constructor, why `noexcept` changes what `std::vector` does, the rules of zero, three and five, copy elision, and how to pass and store objects without copying them. It finishes Chapter 6's `Buffer` by giving it a real copy and, more importantly, a move. The lab counts every copy and every move in a set of ordinary-looking programs, and times what a copy costs.

## What a copy means in C++

In Python, `b = a` never copies anything. It binds a second name to the same object, and if that object is a list, `a.append(1)` changes what `b` shows too. To get a separate list you must ask for one, with `a.copy()` or `copy.deepcopy(a)`.

C++ works the other way round. A variable is its value, as [Chapter 3](/learn/cpp-memory#lifetime-when-objects-are-born-and-die) explained, so `std::vector<float> b = a;` creates a second vector with its own heap block and copies every element into it. Afterwards `a` and `b` are completely independent. This is called **value semantics**, and it is what the standard library's types do: copying a `std::string` copies its characters, copying a `std::vector` copies its elements, and copying a `std::map` copies every node. Value semantics make programs easier to reason about, because no one else can change your copy behind your back. The price is that copies can be expensive, and C++ makes them with no visible sign in the code.

### When the copy constructor runs

A class says how it is copied with two special member functions:

```cpp
Buffer(const Buffer& other);             // copy constructor: build a new Buffer from an existing one
Buffer& operator=(const Buffer& other);  // copy assignment: overwrite an existing Buffer with another's contents
```

The copy constructor runs whenever a new object is initialized from an existing object of the same type that is an lvalue (the next section defines the word; for now, read it as "something with a name"). That happens in more places than the `=` sign suggests:

| Code                                    | What is copied                           |
| --------------------------------------- | ---------------------------------------- |
| `Buffer b = a;` or `Buffer b(a);`       | `a`, into the new `b`                    |
| `void f(Buffer x);` called as `f(a)`    | `a`, into the parameter `x`              |
| `for (auto layer : layers)`             | each element, into `layer`               |
| `v.push_back(a);`                       | `a`, into the vector's new element       |
| `auto [w, b] = pair_of_buffers;`        | the whole pair, into a hidden variable   |
| `[a]() { ... }`, a lambda capturing `a` | `a`, into the lambda object (Chapter 10) |

Copy assignment runs when an object that already exists is given a new value: `b = a;` where `b` was declared earlier. The difference matters because assignment must first deal with whatever `b` already holds.

If a class declares neither, the compiler writes both for you, and its versions copy each member in turn, which is called a memberwise copy. For a class whose members are all values, such as a struct of numbers or a class holding a `std::vector` and a `std::string`, memberwise copying is exactly right, because each member knows how to copy itself.

For Chapter 6's `Buffer` it is exactly wrong. `Buffer` holds a raw `float*` to a heap block it owns. A memberwise copy copies the pointer, not the floats, so both objects point to the same block, and both destructors call `delete[]` on it: a double free. That is why [Chapter 6](/learn/cpp-raii) deleted the copy operations, so that the mistake could not compile. Now it is time to decide what copying a `Buffer` should mean.

### A real copy for Buffer

The natural meaning is the same as `std::vector`'s: a copy is a new block of the same size holding the same values.

```cpp
Buffer(const Buffer& other) : data_(new float[other.size_]), size_(other.size_) {
  std::copy(other.data_, other.data_ + size_, data_);
}
```

That is a **deep copy**. It allocates, and it touches every byte of the source and the destination, so its cost grows with the size of the buffer. For a 405 MB layer, that cost is what the introduction calculated.

Copy assignment is harder, because there are three cases to get right: the target already holds a block that must not leak, the source and target might be the same object, and the allocation might throw `std::bad_alloc`:

```cpp
Buffer& operator=(const Buffer& other) {
  if (this == &other) return *this;           // b = b: nothing to do
  if (size_ != other.size_) {
    float* fresh = new float[other.size_];    // allocate first: if this throws, *this is untouched
    delete[] data_;
    data_ = fresh;
    size_ = other.size_;
  }
  std::copy(other.data_, other.data_ + size_, data_);   // same size: reuse our block
  return *this;
}
```

The order of the middle lines is the important part. If the code freed the old block first and then the allocation threw, `data_` would still hold the address of the freed block, and the destructor would later free it a second time. Allocating first means that a failure leaves the object exactly as it was, which is called the **strong exception guarantee**. The check for self-assignment matters for a different reason: `std::copy` requires the destination not to start inside the source range, so copying a buffer onto itself would break that rule. And when the sizes already match, the operator reuses the existing block instead of allocating a new one, which `std::vector`'s copy assignment also does when it has enough capacity. The lab measures how much that saves.

With a copy constructor and copy assignment, `Buffer` can be copied safely. But copying is still expensive, and most of the time it is not what the code needs. The rest of the chapter is about how to avoid it.

## lvalues and rvalues

Consider a decode loop that keeps one buffer of logits and refills it with a new result on every step:

```cpp
Buffer logits(32000);
for (int step = 0; step < max_tokens; ++step) {
  logits = compute_logits(state);   // compute_logits returns a Buffer by value
  // ... sample a token from logits ...
}
```

The object `compute_logits` returns is a temporary. Nobody else can see it, and it will be destroyed at the end of the statement. Copying 128,000 bytes out of it into `logits` and then freeing the original would be absurd. The right thing is for `logits` to take the temporary's heap block, and for the temporary to be left empty. For that, the compiler needs to know which objects are about to disappear, and that is what the categories **lvalue** and **rvalue** describe.

Every expression in C++ has a type and a **value category**. The precise rules have five categories, but two ideas are enough to use them:

| Category | What it is                                                                   | Examples                                                   |
| -------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| lvalue   | An expression that names an object that will still exist after the statement | `x`, `layers[3]`, `*ptr`, a function returning `Buffer&`   |
| rvalue   | A temporary, or an object that the code has marked as no longer needed       | `Buffer(16)`, `compute_logits(s)`, `a + b`, `std::move(x)` |

The names come from the left and right sides of an assignment in C, but the useful test is simpler: if you can take its address with `&`, it is an lvalue. Rvalues come in two kinds. A **prvalue**, such as `Buffer(16)` or the result of a function that returns by value, is a plain value that has not yet become an object anywhere. An **xvalue**, such as `std::move(x)`, refers to an existing object that the code has said it is finished with. Both are rvalues, and both can be moved from.

C++11 added a reference type that binds only to rvalues, the **rvalue reference**, written `T&&`:

```cpp
Buffer a(16);
Buffer& r1 = a;              // fine: an lvalue reference binds to an lvalue
Buffer&& r2 = Buffer(16);    // fine: an rvalue reference binds to a temporary (and keeps it alive)
Buffer&& r3 = a;             // error: an rvalue reference cannot bind to an lvalue
const Buffer& r4 = Buffer(16);  // fine: a const lvalue reference binds to anything
```

This lets you write two overloads of a function, one for objects the caller still needs and one for objects it does not, and the compiler picks between them by value category:

```cpp
void store(const Buffer& b);  // called with lvalues: must leave b alone, so it copies
void store(Buffer&& b);       // called with rvalues: b is about to die, so it may take b's block
```

`store(a)` calls the first. `store(Buffer(16))` and `store(compute_logits(s))` call the second. That is the whole mechanism behind move semantics, and the copy constructor and the move constructor are just the two overloads of construction.

One rule in this area surprises everyone once. **A named rvalue reference is itself an lvalue.** Inside `void store(Buffer&& b)`, the parameter `b` has a name and can be used several times, so the expression `b` is an lvalue, and `Buffer mine = b;` copies. The type says that the caller handed the object over; the name says that you might still use it. To pass it on as an rvalue, you must say so again, with `std::move(b)`. This keeps the language safe: an object is moved from only where the code explicitly says so.

## What std::move really does

The name `std::move` suggests that it moves something. It does not. It is a cast, and the standard library defines it in one line, roughly:

```cpp
template <class T>
constexpr std::remove_reference_t<T>&& move(T&& t) noexcept {
  return static_cast<std::remove_reference_t<T>&&>(t);
}
```

Read past the template syntax, which Chapter 11 explains, and it says: take whatever you were given and return it as an rvalue reference. No bytes are copied, no pointers are changed, and on its own it generates no machine code at all. All it does is change the value category of an expression from lvalue to xvalue, so that overload resolution picks the rvalue overload. If that overload is a move constructor, the move constructor does the moving.

Two consequences follow. First, `std::move(x);` as a statement on its own does nothing to `x`. Second, `std::move` on a `const` object does not move:

```cpp
const std::string prompt = load_prompt();
std::string owned = std::move(prompt);   // copies
```

`std::move(prompt)` has type `const std::string&&`. The move constructor takes a `std::string&&`, without `const`, because moving must modify the source, so it cannot accept a const one. The copy constructor takes a `const std::string&`, which binds to anything, so overload resolution chooses it and the "move" is a copy, without a warning from the compiler. If you want to move out of an object, it cannot be `const`.

### The moved-from object

After `Buffer b = std::move(a);`, `a` still exists. It will be destroyed at the end of its scope like any other object, so it must be left in a state its destructor can handle. What else you can do with it depends on the type. For the standard library's types, the rule is that a moved-from object is in a **valid but unspecified state**: every operation without preconditions still works, so you can call `size()`, assign it a new value or destroy it, but you cannot rely on what it contains. A few types promise more. A moved-from `std::unique_ptr` is guaranteed to be null, and cppreference documents that `std::vector`'s move constructor leaves the source empty. For your own types you choose, and a simple choice is best. This chapter's `Buffer` documents that a moved-from `Buffer` is empty, with a null pointer and a size of 0.

The safe habit, whatever the type, is to treat a moved-from object as if it had no value: either assign it a new one or let it be destroyed.

## Giving Buffer a move

Here is what `Buffer` needs. The **move constructor** takes the other object's heap block instead of allocating its own, and leaves the other object empty. The **move assignment operator** does the same to an existing object, after releasing the block it held.

```cpp
Buffer(Buffer&& other) noexcept
    : data_(std::exchange(other.data_, nullptr)), size_(std::exchange(other.size_, 0)) {}

Buffer& operator=(Buffer&& other) noexcept {
  if (this != &other) {
    delete[] data_;                                  // release what we held
    data_ = std::exchange(other.data_, nullptr);     // take theirs, leave them empty
    size_ = std::exchange(other.size_, 0);
  }
  return *this;
}
```

`std::exchange(x, v)`, from `<utility>`, sets `x` to `v` and returns the old value of `x`, which is exactly "take it and leave something in its place". The move constructor copies one pointer and one size and writes two zeros, whatever the size of the buffer. A 405 MB layer moves as fast as a 4-byte one.

Three details make it correct:

- **The source must be left destructible.** `other`'s destructor will still run and call `delete[] other.data_`. Because the pointer is now `nullptr`, and `delete[]` on a null pointer does nothing, that is safe. Forgetting to null the source is the classic bug in a hand-written move: both objects then own the block, and it is freed twice.
- **Self-move must not destroy the data.** `b = std::move(b)` is rare, but it can happen indirectly, for example when swapping two elements of an array that happen to be the same element. Without the check, the operator would free its own block and then take the dangling pointer back.
- **`noexcept` is a promise that the function will not throw.** The move operations only copy and assign pointers and integers, which cannot throw, so the promise is true. The next section explains why making that promise changes how fast your program runs.

With these two functions, plus the copy operations from earlier and the destructor from Chapter 6, `Buffer` has all five special member functions. Now `logits = compute_logits(state)` moves, `v.push_back(Buffer(4096))` moves, and `v.push_back(std::move(x))` moves. Only code that names an lvalue without `std::move` still copies, and that is code that needs the original afterwards.

## Why noexcept matters

`std::vector` keeps its elements in one heap block. When `push_back` finds the block full, it allocates a larger one, transfers the elements to it, and frees the old block. For a vector of `Buffer`, the transfer could copy each element or move it, and moving is obviously better. But the vector does not always move, and the reason is a promise it makes.

`push_back` offers the strong exception guarantee: if it throws, the vector is left exactly as it was. Suppose the vector is moving ten elements into the new block, and the move of the sixth element throws. The first five have already been moved out of the old block and left empty, so the old state is gone, and moving them back could throw too. The promise cannot be kept. Copying does not have this problem: if the sixth copy throws, the vector discards the new block, and the old block is untouched.

So the vector chooses at compile time, using `std::move_if_noexcept`. If the element type's move constructor is declared `noexcept`, or if the type cannot be copied at all, it moves. Otherwise it copies. A move constructor that is perfectly correct, never throws, but is not marked `noexcept` turns every reallocation into a full copy of every element. Nothing warns you. The program is just slower, and for a vector of large objects, much slower.

How often does that happen? If a vector doubles its capacity whenever it runs out, which both GCC's libstdc++ and LLVM's libc++ do (Microsoft's library grows by 1.5× instead), then 1,000 `push_back` calls into an empty vector cause reallocations at sizes 1, 2, 4, and so on up to 512, and transfer 1 + 2 + 4 + ... + 512 = 1,023 elements in total. With a `noexcept` move that is 1,023 pointer swaps. Without one it is 1,023 allocations and deep copies. The lab runs exactly this experiment.

Three habits follow:

- Mark move constructors and move assignment operators `noexcept` whenever they cannot throw, which for a class that only moves pointers, integers and standard containers is always.
- Moves that the compiler writes for you, or that you request with `= default`, are `noexcept` automatically when the members' moves are. Another reason to prefer them.
- `static_assert(std::is_nothrow_move_constructible_v<Buffer>);` next to the class turns the promise into a compile-time check, so that a later edit cannot silently remove it.

`reserve` avoids the question entirely. If the code knows how many elements are coming, `v.reserve(n)` allocates once, and no reallocation happens until the vector holds more than `n`.

## The rules of zero, three and five

The copy constructor, copy assignment, move constructor, move assignment and destructor are the five special member functions that control an object's life, and the compiler writes any of them you leave out, under rules that are worth knowing precisely because they are easy to trip over.

The original guideline, from C++98, is the **rule of three**: if a class needs a hand-written destructor, copy constructor or copy assignment, it almost certainly needs all three. A destructor that frees something means the class owns a resource, and then the memberwise copy is wrong, exactly as it was for `Buffer`. C++11 added the two move operations and made it the **rule of five**: a class that manages a resource directly should declare all five, even if some are `= default` or `= delete`.

The rules for what the compiler declares when you write some of them yourself are summarized in a well-known table by Howard Hinnant, who designed much of C++11's move semantics:

| If you declare     | Copy constructor       | Copy assignment        | Move constructor | Move assignment |
| ------------------ | ---------------------- | ---------------------- | ---------------- | --------------- |
| Nothing            | Generated              | Generated              | Generated        | Generated       |
| A destructor       | Generated (deprecated) | Generated (deprecated) | Not declared     | Not declared    |
| A copy constructor | Yours                  | Generated (deprecated) | Not declared     | Not declared    |
| A copy assignment  | Generated (deprecated) | Yours                  | Not declared     | Not declared    |
| A move constructor | Deleted                | Deleted                | Yours            | Not declared    |
| A move assignment  | Deleted                | Deleted                | Not declared     | Yours           |

"Deleted" and "not declared" differ in an important way. A deleted copy constructor is still found by overload resolution, and choosing it is a compile error, so the mistake is loud. A move constructor that is not declared simply does not exist, so an rvalue falls back to the copy constructor, whose `const T&` parameter accepts it, and the move becomes a copy. That is quiet.

Chapter 6's `Buffer` is an example of the loud case: it deleted the copy constructor, which also meant no move constructor was declared, so `Buffer b = std::move(a);` did not compile at all. That is why this chapter writes the move constructor by hand.

### The destructor that turned moves into copies

The quiet case is a real trap. Take a layer that follows the rule of zero, described below:

```cpp
struct Layer {
  Buffer weights;
};
```

Moving a `Layer` moves its `Buffer`, because the compiler generates a memberwise move. Now someone adds a destructor, perhaps empty, perhaps to log when layers are unloaded:

```cpp
struct Layer {
  Buffer weights;
  ~Layer() { /* log something later */ }
};
```

According to the second row of the table, a user-declared destructor stops the compiler from declaring the move operations, but it still generates the copy operations. Every `std::move(layer)`, every `return layer;` that is not elided, and every reallocation of a `std::vector<Layer>` now deep-copies the weights. The code compiles, the tests pass, and model loading becomes several times slower. GCC and Clang can warn that the implicit copy is deprecated in this situation with `-Wdeprecated-copy-dtor`, but `-Wall` does not include that warning, so you only see it if you ask for it.

The fix is to delete the destructor, or, if it is really needed, to ask for the other four explicitly:

```cpp
struct Layer {
  Buffer weights;
  ~Layer() { log_unload(); }
  Layer(Layer&&) noexcept = default;
  Layer& operator=(Layer&&) noexcept = default;
  Layer(const Layer&) = default;
  Layer& operator=(const Layer&) = default;
};
```

### The rule of zero

The best rule is the one that needs none of this. The **rule of zero** says that a class should declare none of the five special member functions unless its single job is managing a resource. Resource management belongs in small, dedicated classes, such as `Buffer`, `std::vector`, `std::unique_ptr` or Chapter 6's `File`, which follow the rule of five carefully once. Every other class is built from them and lets the compiler generate everything. `Layer` with just `Buffer weights;` is such a class: it is copyable, movable with `noexcept`, and correct, without a line of special member code. So is a request struct holding a `std::string` prompt and a `std::vector<int>` of token ids.

Most classes you write should follow the rule of zero, and Chapter 8's smart pointers make that possible even for classes that hold resources with unusual cleanup.

## Returning by value and copy elision

Python programmers new to C++ often hesitate to return large objects by value, and older C++ code is full of functions that take an output parameter instead, such as `void make_logits(int n, std::vector<float>& out)`. Modern C++ does not need this, because of **copy elision**: in some cases the compiler is allowed, or required, to construct an object directly in its final location, so that no copy or move happens at all.

There are two cases, and the difference between them matters:

- **Returning a prvalue** is guaranteed to elide since C++17. In `Buffer make() { return Buffer(n); }` called as `Buffer b = make();`, the language says there is no temporary at all: the prvalue `Buffer(n)` initializes `b` directly. The same rule covers `Buffer b = Buffer(n);` and passing `Buffer(n)` to a by-value parameter. Since no copy or move happens, the type does not even need a copy or move constructor.
- **Returning a named local variable**, as in `Buffer b(n); fill(b); return b;`, can be elided by an optimization called **named return value optimization**, or NRVO. The standard allows it but does not require it, and GCC and Clang perform it in the common case where a function returns the same local variable on every path. Where NRVO does not happen, for example when a function returns one of two different local variables depending on a condition, a second rule takes over: a local variable named in a `return` statement is treated as an rvalue, so it is moved, not copied.

So for any type that can be moved, `return local;` costs at most one move, and usually nothing. That makes returning by value the normal, efficient way to produce a large result in C++.

### Do not return std::move(local)

It is tempting to help the compiler:

```cpp
Buffer make_logits(std::size_t vocab) {
  Buffer logits(vocab);
  fill(logits);
  return std::move(logits);   // slower, not faster
}
```

`std::move(logits)` is not the name of a local variable but a function call, so NRVO no longer applies. The function must now construct the return value by moving from `logits`, which costs one move that the plain `return logits;` would have avoided. The `std::move` is a **pessimization**. Compilers flag it: Clang has the `-Wpessimizing-move` warning in `-Wall`, and GCC added the same warning in version 9, also in `-Wall`. A related warning, `-Wredundant-move`, flags a `std::move` that changes nothing because the compiler would have moved anyway, for example when returning a by-value parameter, which can never be elided; GCC enables it with `-Wextra`.

The rule is simple: write `return x;` for a local variable or a parameter, and let the language do the rest. `std::move` in a `return` is right only for something that is not a local, such as a member variable you are handing out: `return std::move(member_);`.

## Passing, storing and handing off

The last place copies hide is in how functions take their arguments. Chapter 4 gave the basic rule: pass small values by value and large objects by `const&`. Move semantics add one more case, the **sink**: a function that keeps its argument, such as a constructor that stores it in a member, or a function that pushes it onto a queue.

```cpp
class Job {
 public:
  explicit Job(Buffer input) : input_(std::move(input)) {}
 private:
  Buffer input_;
};
```

The parameter is taken by value and then moved into the member. Look at what each call costs:

| Call                        | Into the parameter             | Into the member | Total              |
| --------------------------- | ------------------------------ | --------------- | ------------------ |
| `Job a(prompt);`            | a copy (`prompt` is an lvalue) | a move          | one copy, one move |
| `Job b(std::move(prompt));` | a move                         | a move          | two moves          |
| `Job c(Buffer(1024));`      | nothing (guaranteed elision)   | a move          | one move           |

In every case the caller pays for exactly one copy if it keeps its own object, and none if it gives the object away, plus one cheap move. The alternative, two overloads taking `const Buffer&` and `Buffer&&`, saves that one move but doubles the code, and with several parameters the number of overloads multiplies. For types whose move is cheap, which is almost every type, by value then `std::move` is the standard idiom.

The same idea applies to containers. `v.push_back(x)` copies `x`; `v.push_back(std::move(x))` moves it. `v.emplace_back(args...)` goes one step further: it passes its arguments to the element's constructor and builds the element directly inside the vector, so `v.emplace_back(4096)` creates a `Buffer` of 4,096 floats in place with neither a copy nor a move. One side effect: `emplace_back` calls constructors directly, so it can call `explicit` ones, which `push_back` cannot. `v.push_back(4096)` does not compile with Chapter 6's `explicit` constructor, while `v.emplace_back(4096)` does.

### Use after move

Moving creates a new kind of bug. After `queue.push(std::move(request));`, the variable `request` is still in scope and still compiles, but its contents are gone:

```cpp
queue.push(std::move(request));
log("queued request with %zu tokens", request.tokens.size());   // logs 0, or whatever is left
```

For a standard library type, this is not undefined behavior, because the moved-from object is valid, but it is almost certainly wrong. The compiler does not warn. clang-tidy, the linter that ships with Clang, has a check called `bugprone-use-after-move` that finds exactly this pattern, and it is worth turning on in any project that moves objects around. The habit that prevents the bug is to do everything you need with an object before the line that moves it, and to keep the move as the last use.

```widget
copy-or-move
```

## Copy-and-swap

There is a second, well-known way to write assignment, called **copy-and-swap**. Give the class a `swap` that exchanges members, and write a single assignment operator that takes its argument by value:

```cpp
friend void swap(Buffer& a, Buffer& b) noexcept {
  std::swap(a.data_, b.data_);
  std::swap(a.size_, b.size_);
}

Buffer& operator=(Buffer other) noexcept {   // other is a copy, or a moved-into object
  swap(*this, other);                          // take its contents; it takes ours
  return *this;                                // other's destructor frees our old block
}
```

This one function replaces both copy assignment and move assignment. When the caller passes an lvalue, the parameter is copy-constructed, and when it passes an rvalue, the parameter is move-constructed. Either way, all the work that can fail happens while building the parameter, before `*this` is touched, so the strong exception guarantee comes for free. Self-assignment is handled too, without a check, because `other` is a separate object. And the code is short and hard to get wrong.

The cost is that copy-and-swap always builds a complete new object. When you assign a 400 MB buffer to another 400 MB buffer, it allocates a third block and frees one, even though the target's existing block was already the right size and could simply have been overwritten. That is why the standard containers do not use it, and why this chapter's `Buffer` reuses its block when the sizes match. Copy-and-swap is an excellent default for classes where assignment is rare or the members are small, and a poor fit for a class whose whole purpose is holding large data that gets reassigned in a loop.

## What a copy should mean for a tensor

Everything so far has assumed that copying a `Buffer` copies its floats, as copying a `std::vector` does. That is one design, not a law. PyTorch's C++ tensor, `at::Tensor`, made the other choice. An `at::Tensor` is a small handle holding an intrusive pointer to a `TensorImpl`, the object that knows the shape, strides and storage. Copying an `at::Tensor` copies the handle and increments the `TensorImpl`'s reference count, so both copies refer to the same data, exactly as `b = a` does for tensors in Python. A real copy of the data is a separate, explicit call: `clone()`.

Even so, moves matter there. The reference count is atomic, because tensors are shared between threads, so each handle copy costs an atomic increment and, later, an atomic decrement, which is cheap but not free. PyTorch's operators therefore take their tensor arguments as `const at::Tensor&`, and moving a tensor handle into place avoids touching the count at all.

So the question "what does copying this type mean?" is a design decision, and you will make it for your own tensor in Project B: a deep copy, like `std::vector`, which is simple and safe, or a shared handle with explicit `clone()`, like PyTorch, which makes views and slices cheap. Either way, the type should be cheap to move, and that is what lets the rest of an inference engine hand data around freely:

- A request travels from the HTTP handler to the scheduler to a worker thread, and each step can `std::move` it along, so its prompt and token ids are never copied. Part IV builds a queue that works this way.
- A function that builds a KV cache, a batch or a tensor of logits returns it by value, and copy elision or a single move delivers it to the caller.
- A `std::unique_ptr` to a model, which cannot be copied at all, is moved into the object that will own it, which makes the transfer of ownership visible in the code. Chapter 8 is about that.

## Lab: counting copies and moves

The lab is one program, [`moves.cpp`](/labs/cpp/cpp-copy-move/moves.cpp), built on [`buffer.h`](/labs/cpp/cpp-copy-move/buffer.h), which is this chapter's `Buffer` with counters: every allocation, copy and move increments a global counter, and every experiment prints them. The header also defines `SlowBuffer`, whose move constructor is correct but not `noexcept`, and the two layers from the rule-of-five trap. [`scoped_timer.h`](/labs/cpp/cpp-copy-move/scoped_timer.h) is Chapter 6's timer, and [`CMakeLists.txt`](/labs/cpp/cpp-copy-move/CMakeLists.txt) builds everything with `-Wpessimizing-move` and `-Wredundant-move` turned on explicitly. Download the four files into one folder and build in Release, since part of the lab measures time:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

The counts in Parts 1 to 5 follow from the rules in this chapter, so you can predict them before running anything. Write your prediction for each line first, then compare.

### Part 1: the loop that copies a model

`./build/moves copy-loop` builds a "model" of 8 layers of 16 MiB each and runs a fake forward pass over it 10 times, first with `for (auto layer : layers)` and then with `for (const auto& layer : layers)`. The first version should report 80 copies and 80 allocations, one per layer per step, and 1,342,177,280 bytes copied, which is 80 × 16 MiB. The second should report zeros. The two timer lines show what those 1.3 GB of copies cost on your machine.

<!-- measure: the full output of ./build/moves copy-loop on the Mac (Release): the counters and the two timings -->

### Part 2: vector growth and noexcept

`./build/moves growth` pushes 1,000 small buffers into four vectors. Work out each line before you run it, using the doubling argument from the `noexcept` section and the fact that `push_back(Buffer(16))` moves its temporary argument into the vector:

- `vector<Buffer>`, no reserve: 1,000 moves for the arguments plus 1,023 moves for the reallocations, and no copies, if your library doubles its capacity. The final capacity should be 1,024.
- `vector<SlowBuffer>`, no reserve: the same 1,000 moves for the arguments, but the 1,023 transfers become copies, with 1,023 extra allocations, because the move constructor is not `noexcept`.
- `vector<SlowBuffer>` with `reserve(1000)` first: 1,000 moves and no copies, because the vector never reallocates.
- `vector<Buffer>` with `reserve` and `emplace_back(16)`: no copies and no moves, only the 1,000 allocations of the buffers themselves.

The first line of output prints `std::is_nothrow_move_constructible` for both types, which should be 1 for `Buffer` and 0 for `SlowBuffer`. That single bit is what the vector looks at.

<!-- measure: the full output of ./build/moves growth on the Mac, and on Linux with GCC if available; whether the counts matched the predictions -->

### Part 3: return values

`./build/moves returns` calls four functions that each return a `Buffer` of 1,024 floats. Before building, look at the compiler's warnings: `make_moved`, which ends with `return std::move(b);`, should trigger `-Wpessimizing-move`. Then predict the counts:

- `return Buffer(n);` should show one allocation and no moves, by guaranteed elision.
- `return b;` should show one allocation and no moves, by NRVO.
- `return std::move(b);` should show one allocation and one move: the pessimization.
- `if (...) return a; return b;` should show two allocations and one move, because NRVO cannot choose between two variables, and the returned local is moved.

Now rebuild with `-DLAB_NO_ELIDE=ON`, which passes `-fno-elide-constructors`, and run it again. The flag turns off the elisions that are optional, so `return b;` should now show one move. `return Buffer(n);` should still show none, because C++17 made that elision part of the language rather than an optimization, and no flag can turn it off.

<!-- measure: the warnings from the build, and the output of ./build/moves returns with and without -DLAB_NO_ELIDE=ON -->

### Part 4: the destructor trap

`./build/moves trap` moves a `Layer`, which follows the rule of zero, and a `LoggedLayer`, which is the same struct with an empty destructor. Both hold a 4 MiB `Buffer`. The `Layer` move should report one move and no copies. The `LoggedLayer` "move" should report one copy, one allocation and 4,194,304 bytes copied. The last line prints the sizes of the two sources afterwards: the `Layer` that was really moved from is empty, while the `LoggedLayer` still holds its data, because it was only copied.

Then add `-Wdeprecated-copy-dtor` to the compile options in `CMakeLists.txt`, rebuild, and read the warning it gives for `LoggedLayer`. Finally, delete the destructor from `LoggedLayer` in `buffer.h`, rebuild, and confirm that the copy becomes a move.

<!-- measure: the output of ./build/moves trap before and after deleting the destructor, and the -Wdeprecated-copy-dtor warning text -->

### Part 5: sink parameters and use after move

`./build/moves sink` constructs three `Job`s, using the three calls from the table in the sink section, and its counts should match that table row by row: one copy and one move, then two moves, then one allocation and one move. The last line prints the size of `prompt` after it was moved from, which is 0, because this `Buffer` documents that a moved-from buffer is empty. If you have clang-tidy installed, run `clang-tidy -checks='-*,bugprone-use-after-move' moves.cpp -p build` and see whether it flags that line, and the similar line at the end of `trap`.

<!-- measure: the output of ./build/moves sink, and clang-tidy's report if it was available -->

### Part 6: how much a copy costs

`./build/moves bench` creates one 400 MB `Buffer` and times three operations: copying it into a new `Buffer`, copying it into an existing `Buffer` of the same size, which reuses that buffer's memory, and moving it. Pass a different size in megabytes as a second argument, for example `./build/moves bench 100`. The program needs about 800 MB of free memory at the default size.

What to expect, without numbers: the move should be too fast for this timer to see, because it copies a pointer and a size. Both copies must read 400 MB and write 400 MB, so their time is set by memory bandwidth, and dividing 800 MB by the time gives the bandwidth your copy achieved. The copy into a new `Buffer` should be the slower of the two, because it also allocates a fresh block, and the operating system must supply each page of it the first time it is written, while the existing `Buffer`'s pages were already supplied when it was zeroed. Compare the bandwidth you compute with your machine's published memory bandwidth.

<!-- measure: the output of ./build/moves bench (400 MB) on the Mac, the bandwidth computed from each copy, and the machine's published memory bandwidth -->

### Stretch goals

- Remove `noexcept` from `Buffer`'s move constructor in `buffer.h`, rebuild, and run `growth` again. Every type built on `Buffer`, including `Layer`, loses its `noexcept` move too, and the first line of the output changes with it.
- Rewrite `Buffer`'s two assignment operators as a single copy-and-swap `operator=`, run `bench` again, and compare the time for "copy into an existing Buffer". Explain the difference.
- Add `static_assert(std::is_nothrow_move_constructible_v<Layer>);` to `buffer.h`, then add a destructor to `Layer` and read the compiler error. That one line turns the destructor trap into a build failure.
- Change `forward` in `moves.cpp` to take `std::vector<Layer>` by value instead of by `const&`, and predict the new counts for `copy-loop` before running it.

## Check yourself

<details>
<summary>In Python, b = a for a list does not copy anything. What does Buffer b = a; do in C++, and what does std::vector&lt;float&gt; b = a; do?</summary>

Both create a new, independent object. For `std::vector<float>`, the copy constructor allocates a new heap block and copies every element, so changing `b` never affects `a`. For `Buffer`, it does whatever the class's copy constructor says: this chapter's version does the same deep copy, while Chapter 6's version deleted the copy constructor, so the line did not compile. C++ types have value semantics, so copying is the default, and avoiding it is something you ask for with references or moves.

</details>

<details>
<summary>What does std::move(x) do on its own, and where does the actual moving happen?</summary>

On its own it does nothing to `x`. It is a cast that turns the expression `x` into an rvalue reference, so that overload resolution picks a function that takes `T&&`, such as the move constructor or move assignment operator. The moving, taking `x`'s heap block and leaving `x` empty, happens inside that function. If no such function is chosen, for example because `x` is `const` or the type has no move constructor, the cast leads to a copy instead.

</details>

<details>
<summary>A class's move constructor is correct and never throws, but a std::vector of it copies every element when it grows. What is missing, and why does the vector care?</summary>

The move constructor is not marked `noexcept`. `push_back` promises that if it throws, the vector is unchanged. If moving the old elements to the new block could throw halfway, the moved-from elements could not be restored, so the vector uses `std::move_if_noexcept` and copies instead, unless the move is `noexcept` or the type cannot be copied. Adding `noexcept` turns those copies into moves.

</details>

<details>
<summary>Someone adds an empty destructor ~Layer() {} to a struct that holds a weights Buffer, and model loading becomes much slower. Why?</summary>

A user-declared destructor, even an empty one, stops the compiler from declaring a move constructor and move assignment for the class, while it still generates the copy operations. Every `std::move` of a `Layer`, every non-elided return and every reallocation of a `std::vector<Layer>` now falls back to the copy constructor, which deep-copies the weights. Removing the destructor, or adding `= default` declarations for all four copy and move operations, restores the moves.

</details>

<details>
<summary>Why is return std::move(result); usually slower than return result; for a local variable?</summary>

`return result;` allows named return value optimization, in which the compiler constructs `result` directly in the caller's object, so nothing is copied or moved. And if NRVO does not happen, a returned local is treated as an rvalue anyway, so it is moved. `std::move(result)` is not the name of a local, so NRVO cannot apply, and the return must perform a move that would otherwise not happen. GCC and Clang flag it with `-Wpessimizing-move`.

</details>

<details>
<summary>A constructor stores a large Buffer in a member. Why take the parameter by value and std::move it, rather than by const reference?</summary>

With a `const Buffer&` parameter, the constructor must copy into the member, even when the caller passed a temporary or used `std::move` and no longer needs the object. Taking it by value lets the caller decide: an lvalue is copied once into the parameter, an rvalue is moved into it, and a prvalue initializes it directly. The constructor then moves the parameter into the member, which is cheap. The caller pays for a copy only when it keeps its own object.

</details>

## Further reading

- cppreference on [copy constructors](https://en.cppreference.com/w/cpp/language/copy_constructor), [move constructors](https://en.cppreference.com/w/cpp/language/move_constructor) and [move assignment](https://en.cppreference.com/w/cpp/language/move_operator) gives the exact rules for when each is implicitly declared, defaulted, deleted or `noexcept`.
- [cppreference: value categories](https://en.cppreference.com/w/cpp/language/value_category) defines lvalues, prvalues and xvalues precisely, with many examples.
- [cppreference: std::move](https://en.cppreference.com/w/cpp/utility/move) and [std::move_if_noexcept](https://en.cppreference.com/w/cpp/utility/move_if_noexcept) show that both are casts, and [std::vector::push_back](https://en.cppreference.com/w/cpp/container/vector/push_back) states the exception guarantee that makes `noexcept` matter.
- [cppreference: copy elision](https://en.cppreference.com/w/cpp/language/copy_elision) separates the elisions C++17 guarantees from the ones, such as NRVO, it only permits.
- [cppreference: the rule of three/five/zero](https://en.cppreference.com/w/cpp/language/rule_of_three) has short examples of each rule.
- [Tutorial: When to Write Which Special Member](https://foonathan.net/2019/02/special-member-functions/), by Jonathan Müller, walks through Howard Hinnant's table of implicitly declared special members and when to write each one.
- [Understanding when not to std::move in C++](https://developers.redhat.com/blog/2019/04/12/understanding-when-not-to-stdmove-in-c), by Marek Polacek on the Red Hat Developer blog, explains GCC's `-Wpessimizing-move` and `-Wredundant-move` with examples.
- [clang-tidy: bugprone-use-after-move](https://clang.llvm.org/extra/clang-tidy/checks/bugprone/use-after-move.html) documents the check that finds uses of moved-from objects.
- [We shouldn't feel bad about passing Tensor by reference](https://dev-discuss.pytorch.org/t/we-shouldnt-feel-bad-about-passing-tensor-by-reference/85), on PyTorch's developer forum, explains what copying an `at::Tensor` costs and why PyTorch passes tensors as `const Tensor&`.
