import { Quiz, type QuizItem } from './Quiz'

// "Copy or move?" for content/cpp/cpp-copy-move.md. Each snippet does one thing to a Buffer-like object, and the reader
// says what the marked line costs. Answers follow the language rules described in the chapter (cppreference: copy
// elision, move constructors, the rule of three/five/zero, std::vector::push_back), assuming GCC or Clang with their
// usual settings, which perform NRVO in the simple single-return case shown.

const OPTIONS = ['A copy', 'A move', 'Neither: no copy and no move', 'It does not compile']
const COPY = 0
const MOVE = 1
const NEITHER = 2
const ERROR = 3

const ITEMS: QuizItem[] = [
  {
    snippet: `// layers is a std::vector<Layer>, and each Layer holds its weights
for (auto layer : model.layers)      // <- each iteration
  x = layer.forward(x);`,
    options: OPTIONS,
    answer: COPY,
    explanation: (
      <>
        <code>auto layer</code> declares a new <code>Layer</code> and initializes it from an element of the vector, which is an lvalue, so every
        iteration copies a whole layer, weights included. Python&apos;s <code>for layer in layers</code> only binds a name, which is why this habit
        carries over so easily. Write <code>const auto&amp; layer</code> and nothing is copied.
      </>
    ),
  },
  {
    snippet: `Buffer make_logits(std::size_t vocab) {
  Buffer logits(vocab);
  fill(logits);
  return logits;                     // <- this line
}`,
    options: OPTIONS,
    answer: NEITHER,
    explanation: (
      <>
        This is named return value optimization: the compiler builds <code>logits</code> directly in the caller&apos;s object, so the return costs
        nothing. The standard allows NRVO without requiring it, and GCC and Clang do it in simple cases like this one. If they did not, the rule that
        a returned local is treated as an rvalue would make it a move. It is never a copy.
      </>
    ),
  },
  {
    snippet: `Buffer make_logits(std::size_t vocab) {
  Buffer logits(vocab);
  fill(logits);
  return std::move(logits);          // <- this line
}`,
    options: OPTIONS,
    answer: MOVE,
    explanation: (
      <>
        <code>std::move(logits)</code> is no longer the name of a local variable, so NRVO no longer applies, and the return statement must move from
        it. The <code>std::move</code> made the code slower, not faster. GCC and Clang warn about it with <code>-Wpessimizing-move</code>.
      </>
    ),
  },
  {
    snippet: `const std::string prompt = load_prompt();
std::string owned = std::move(prompt);   // <- this line`,
    options: OPTIONS,
    answer: COPY,
    explanation: (
      <>
        <code>std::move</code> only casts, and casting a <code>const std::string</code> gives a <code>const std::string&amp;&amp;</code>. The move
        constructor takes a non-const <code>std::string&amp;&amp;</code>, because it must modify its source, so it cannot accept this. The copy
        constructor&apos;s <code>const std::string&amp;</code> can, so the &quot;move&quot; silently copies.
      </>
    ),
  },
  {
    snippet: `struct Layer {
  Buffer weights;
  ~Layer() { }                   // added "for logging later"
};
Layer b = std::move(a);          // <- this line`,
    options: OPTIONS,
    answer: COPY,
    explanation: (
      <>
        A user-declared destructor, even an empty one, stops the compiler from declaring a move constructor. The implicit copy constructor is still
        generated, and <code>const Layer&amp;</code> accepts the rvalue, so <code>std::move</code> leads to a copy of the weights. Delete the
        destructor, or add <code>Layer(Layer&amp;&amp;) = default;</code> and the other special members.
      </>
    ),
  },
  {
    snippet: `std::vector<Buffer> batch;
Buffer x(4096);
batch.push_back(x);              // <- this line`,
    options: OPTIONS,
    answer: COPY,
    explanation: (
      <>
        <code>x</code> is an lvalue, so <code>push_back(const Buffer&amp;)</code> is chosen and the vector copies it. That is the right behavior if
        you still need <code>x</code>. If you do not, write <code>batch.push_back(std::move(x))</code>, which chooses{' '}
        <code>push_back(Buffer&amp;&amp;)</code> and moves.
      </>
    ),
  },
  {
    snippet: `void enqueue(Buffer input);       // takes its argument by value

enqueue(Buffer(4096));           // <- this line`,
    options: OPTIONS,
    answer: NEITHER,
    explanation: (
      <>
        <code>Buffer(4096)</code> is a prvalue, and since C++17 a prvalue initializes the object it is meant for directly. The parameter{' '}
        <code>input</code> is built in place, with no temporary to copy or move from. This elision is guaranteed, so it happens in every build, even
        with <code>-fno-elide-constructors</code>.
      </>
    ),
  },
  {
    snippet: `struct Slow {
  Buffer buf;
  Slow(Slow&& o) : buf(std::move(o.buf)) {}  // no noexcept
  Slow(const Slow&) = default;
};
v.push_back(s);   // v is full, so it must reallocate. What happens
                  // to the elements already in v?`,
    options: OPTIONS,
    answer: COPY,
    explanation: (
      <>
        When a vector grows, it moves its old elements to the new block only if the move constructor is <code>noexcept</code>, or if the type cannot
        be copied at all. Otherwise it copies them, so that if a copy throws halfway, the old elements are still intact and <code>push_back</code> can
        keep its strong exception guarantee. Adding <code>noexcept</code> turns every one of those copies into a move.
      </>
    ),
  },
  {
    snippet: `std::unique_ptr<Model> model = load_model(path);
std::unique_ptr<Model> worker_copy = model;   // <- this line`,
    options: OPTIONS,
    answer: ERROR,
    explanation: (
      <>
        <code>std::unique_ptr</code> has a deleted copy constructor, because two owners would both delete the model. The compiler rejects the line. To
        hand the model over, write <code>std::move(model)</code>, after which <code>model</code> is null. To share it, Chapter 8 introduces{' '}
        <code>std::shared_ptr</code>.
      </>
    ),
  },
  {
    snippet: `// Buffer as Chapter 6 left it:
//   Buffer(const Buffer&) = delete;
//   no move constructor declared
Buffer a(1024);
Buffer b = std::move(a);         // <- this line`,
    options: OPTIONS,
    answer: ERROR,
    explanation: (
      <>
        Declaring the copy constructor, even as deleted, stops the compiler from declaring a move constructor. So overload resolution finds only the
        deleted copy constructor, which accepts the rvalue, and choosing a deleted function is a compile error. A deleted function still takes part in
        overload resolution; it is not the same as having none. That is why this chapter writes Buffer&apos;s move constructor by hand.
      </>
    ),
  },
]

export default function CopyOrMove() {
  return (
    <Quiz
      title="Try it: copy or move?"
      description="Each snippet does one thing to a Buffer, a std::string or a std::unique_ptr. Say what the marked line costs: a copy of the data, a move, nothing at all, or a compile error. Buffer has the copy and the move from this chapter unless a snippet says otherwise."
      items={ITEMS}
      question="What does the marked line do?"
      noun="Snippet"
    />
  )
}
