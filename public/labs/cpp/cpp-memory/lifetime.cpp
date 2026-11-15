// Chapter 3 lab, part 1: when objects are created and destroyed.
// Each Tracer prints a line when it is constructed and when it is destroyed.
// Before you run it, write down the order you expect, then compare.
//
//   c++ -std=c++20 -Wall -Wextra lifetime.cpp -o lifetime && ./lifetime
#include <cstdio>
#include <cstring>

// A constructor runs when the object comes to life and a destructor (the ~Tracer function) runs when it dies.
// Chapter 6 covers both properly; here they only print.
struct Tracer {
  const char* name;
  explicit Tracer(const char* n) : name(n) { std::printf("  construct %s\n", name); }
  ~Tracer() { std::printf("  destroy   %s\n", name); }
};

// A global: constructed before main starts, destroyed after main returns.
Tracer global("global");

void scopes() {
  std::printf("enter scopes()\n");
  Tracer a("a");
  {
    Tracer b("b");
    Tracer c("c");
    std::printf("  leaving the inner block\n");
  }  // c, then b, are destroyed here: reverse order of construction
  Tracer d("d");
  std::printf("leaving scopes()\n");
}  // d, then a

void temporaries() {
  std::printf("enter temporaries()\n");
  // Tracer("temp") is a temporary. It lives until the end of the full expression, the whole printf call.
  std::printf("  the temporary's name has %zu letters\n", std::strlen(Tracer("temp").name));
  std::printf("  the next statement\n");
}

void heap() {
  std::printf("enter heap()\n");
  Tracer* h = new Tracer("heap");  // lives until delete, not until the end of a scope
  {
    Tracer s("stack");
  }
  std::printf("  the heap object is still alive\n");
  delete h;
}

void counter() {
  // A function-local static is constructed the first time control reaches it, and destroyed after main returns.
  static Tracer once("function-local static");
}

int main() {
  std::printf("main starts\n");
  scopes();
  temporaries();
  heap();
  counter();
  counter();  // the second call does not construct it again
  std::printf("main returns\n");
  return 0;
}
