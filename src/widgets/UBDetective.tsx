import { Quiz, type QuizItem } from './Quiz'

// "Which tool catches it?" for content/cpp/cpp-undefined-behavior.md. Each snippet has one bug, and the reader picks
// the sanitizer that reports it when the buggy line runs. Answers follow the Clang documentation for each sanitizer:
// ASan checks accesses against allocations (heap, stack, globals), use after free and double free; UBSan's
// -fsanitize=undefined group includes signed-integer-overflow, alignment, null and bounds (arrays whose size the
// compiler knows); MSan checks uninitialized reads; TSan checks data races. Strict aliasing is checked by none of them.

const OPTIONS = ['AddressSanitizer', 'UndefinedBehaviorSanitizer', 'Both ASan and UBSan', 'MemorySanitizer', 'ThreadSanitizer', 'None of them']
const ASAN = 0
const UBSAN = 1
const BOTH = 2
const MSAN = 3
const TSAN = 4
const NONE = 5

const ITEMS: QuizItem[] = [
  {
    snippet: `float* scores = new float[n];
// ... fill scores ...
float last = scores[n];   // one past the end`,
    options: OPTIONS,
    answer: ASAN,
    explanation: (
      <>
        The read lands just past the end of a heap allocation, in the redzone AddressSanitizer places around every allocation, so ASan stops with a{' '}
        <code>heap-buffer-overflow</code> report. UBSan cannot check it, because <code>scores</code> is a plain pointer and the compiler does not know
        how many elements it points to.
      </>
    ),
  },
  {
    snippet: `int hist[4] = {};
int bucket = token_len / 64;   // 4 for a 256-byte token
hist[bucket] += 1;`,
    options: OPTIONS,
    answer: BOTH,
    explanation: (
      <>
        Here the array&apos;s size is part of its type, so UBSan&apos;s <code>bounds</code> check, which is in <code>-fsanitize=undefined</code>, can
        compare the index against 4 and reports it. ASan sees a write into the redzone after the array on the stack and reports a{' '}
        <code>stack-buffer-overflow</code>. With both turned on, UBSan&apos;s line usually appears first, and then ASan stops the program.
      </>
    ),
  },
  {
    snippet: `std::string_view model = std::string("meta-llama/") + name;
std::printf("%c", model[0]);`,
    options: OPTIONS,
    answer: ASAN,
    explanation: (
      <>
        The <code>std::string</code> built on the right is a temporary, destroyed at the end of the first line, so the view refers to freed memory.
        Assuming the string is long enough to live on the heap, ASan reports a <code>heap-use-after-free</code> with three stack traces: the read, the
        free and the allocation. Clang also warns about this simple case at compile time with <code>-Wdangling-gsl</code>.
      </>
    ),
  },
  {
    snippet: `float* buf = new float[1024];
release(buf);   // calls delete[] buf
delete[] buf;`,
    options: OPTIONS,
    answer: ASAN,
    explanation: (
      <>
        Freeing the same block twice is a memory error, and ASan reports <code>attempting double-free</code> with the stacks of both frees. Without
        ASan, the allocator may abort on its own, or may silently corrupt its free lists. The real fix is to decide who owns the buffer, which is what
        chapter 8&apos;s smart pointers make explicit.
      </>
    ),
  },
  {
    snippet: `float sum;   // no initializer
for (int i = 0; i < n; ++i) sum += x[i];
return sum / n;`,
    options: OPTIONS,
    answer: MSAN,
    explanation: (
      <>
        Reading an uninitialized variable is not a memory-access error, because <code>sum</code> is valid memory, so ASan says nothing, and UBSan does
        not track initialization either. MemorySanitizer does, but only with Clang on Linux. Compiler warnings catch simple cases like this one, and
        the fix is <code>float sum = 0.0f;</code>.
      </>
    ),
  },
  {
    snippet: `int batch = 16, seq = 2048, vocab = 128256;
int offset = batch * seq * vocab;`,
    options: OPTIONS,
    answer: UBSAN,
    explanation: (
      <>
        16 × 2,048 × 128,256 is 4,202,692,608, far above the largest <code>int</code>, and signed overflow is undefined. UBSan reports{' '}
        <code>signed integer overflow: 32768 * 128256 cannot be represented in type &apos;int&apos;</code>. ASan checks memory accesses, and there are
        none here yet. The overflow becomes a memory error only later, when the negative offset is used as an index.
      </>
    ),
  },
  {
    snippet: `// bytes points into a file buffer, 1 byte after a header
const unsigned char* bytes = data + 1;
float scale = *reinterpret_cast<const float*>(bytes);`,
    options: OPTIONS,
    answer: UBSAN,
    explanation: (
      <>
        A <code>float</code> must be 4-byte aligned, and this address is not, so UBSan&apos;s <code>alignment</code> check reports a load of a
        misaligned address. The memory itself is valid, so ASan has nothing to report. The fix is{' '}
        <code>std::memcpy(&amp;scale, bytes, sizeof scale)</code>, which is correct at any alignment.
      </>
    ),
  },
  {
    snippet: `long tokens_served = 0;   // shared
// two worker threads each run:
for (auto& r : my_requests) tokens_served += r.tokens;`,
    options: OPTIONS,
    answer: TSAN,
    explanation: (
      <>
        Two threads update the same variable with no lock and no atomic, which is a data race and therefore undefined, and updates can be lost.
        ThreadSanitizer finds races. It cannot be combined with ASan in one build, so projects run it in a separate build. Chapter 16 covers it.
      </>
    ),
  },
  {
    snippet: `float x = 1.0f;
// read the bits of a float through an int pointer
std::uint32_t bits = *reinterpret_cast<std::uint32_t*>(&x);`,
    options: OPTIONS,
    answer: NONE,
    explanation: (
      <>
        The address is valid and aligned, so ASan and UBSan are satisfied, but reading a <code>float</code> through a <code>uint32_t</code> pointer
        breaks the strict aliasing rule, and the optimizer may reorder or drop the read. None of the everyday sanitizers checks this. Write{' '}
        <code>std::bit_cast&lt;std::uint32_t&gt;(x)</code> or copy the bytes with <code>std::memcpy</code>.
      </>
    ),
  },
  {
    snippet: `// m is a std::vector<float> holding rows x cols values
for (int c = 0; c <= cols; ++c)          // <= instead of <
  sum += m.data()[r * cols + c];         // r is 0, the first row`,
    options: OPTIONS,
    answer: NONE,
    explanation: (
      <>
        For the first row, the extra read is element <code>cols</code>, the first element of row 1. It is the wrong number, but it is inside the
        vector&apos;s buffer, so this read is not even undefined behavior, and no sanitizer can know it is wrong. ASan would report the same loop only
        for the last row, whose extra read leaves the buffer. Sanitizers check allocations, not the shape of your data.
      </>
    ),
  },
]

export default function UBDetective() {
  return (
    <Quiz
      title="Try it: which tool catches it?"
      description="Each snippet has one bug, and the buggy line runs with the values shown. Pick the sanitizer that reports it: AddressSanitizer (memory accesses), UndefinedBehaviorSanitizer (undefined operations), MemorySanitizer (uninitialized reads) or ThreadSanitizer (data races)."
      items={ITEMS}
      question="Which tool reports this bug when the line runs?"
      noun="Bug"
    />
  )
}
