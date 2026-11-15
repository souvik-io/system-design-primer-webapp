import clsx from 'clsx'
import { Quiz, type QuizItem } from './Quiz'

// "Which stage is complaining?" for content/cpp/cpp-toolchain.md. Each error message is written in the format the
// named tool prints: GCC or Clang for the preprocessor and compiler, GNU ld (via g++) for the linker, glibc's
// dynamic loader at run time, and CMake for configure errors. Paths and names belong to the chapter's lab.

const STAGES = ['CMake (configure)', 'Preprocessor', 'Compiler', 'Linker', 'Loader (run time)']

const at = (stage: string) => STAGES.indexOf(stage)

const ITEMS: QuizItem[] = [
  {
    snippet: `src/main.cpp:7:10: fatal error: 'tinymath/vec.h' file not found
    7 | #include "tinymath/vec.h"
      |          ^~~~~~~~~~~~~~~~
1 error generated.`,
    options: STAGES,
    answer: at('Preprocessor'),
    explanation: (
      <>
        <code>#include</code> is handled by the preprocessor, which searches the include paths for the file and could not find it. The compiler never
        saw any C++ code. The fix is an include path: <code>-I include</code> on the command line, or <code>target_include_directories</code> in CMake.
      </>
    ),
  },
  {
    snippet: `src/main.cpp:21:43: error: use of undeclared identifier 'cosine_similarity'
   21 |   for (int r = 0; r < reps; ++r) total += cosine_similarity(a, b);
      |                                           ^`,
    options: STAGES,
    answer: at('Compiler'),
    explanation: (
      <>
        The compiler reads one file at a time and refuses any name it has not seen declared. Here the function lives in the <code>tinymath</code>{' '}
        namespace, so the call needs <code>tinymath::cosine_similarity</code>, or the header that declares it was never included.
      </>
    ),
  },
  {
    snippet: `/usr/bin/ld: CMakeFiles/demo.dir/src/main.cpp.o: in function \`main':
main.cpp:(.text+0x1a4): undefined reference to \`tinymath::dot(std::vector<float, std::allocator<float> > const&, std::vector<float, std::allocator<float> > const&)'
collect2: error: ld returned 1 exit status`,
    options: STAGES,
    answer: at('Linker'),
    explanation: (
      <>
        The words <code>/usr/bin/ld</code>, <code>undefined reference</code> and <code>collect2</code> all mean the linker. Every file compiled, and
        <code> main.cpp</code> called <code>dot</code> trusting its declaration, but no object file supplied the definition. Usually{' '}
        <code>vec.cpp</code> was left out of the build, or the definition&apos;s signature differs from the declaration.
      </>
    ),
  },
  {
    snippet: `/usr/bin/ld: libtinymath.a(vec.cpp.o): in function \`tinymath::clamp01(float)':
vec.cpp:(.text+0x0): multiple definition of \`tinymath::clamp01(float)'; CMakeFiles/demo.dir/src/main.cpp.o:main.cpp:(.text+0x0): first defined here
collect2: error: ld returned 1 exit status`,
    options: STAGES,
    answer: at('Linker'),
    explanation: (
      <>
        A function body was written in a header without <code>inline</code>. Two source files included that header, so each object file carries its
        own copy, and the linker refuses to choose between them. This breaks the one-definition rule. Mark the function <code>inline</code> or move
        its body into one <code>.cpp</code> file.
      </>
    ),
  },
  {
    snippet: `In file included from src/main.cpp:3:
include/tinymath/shape.h:3:8: error: redefinition of 'Shape'
    3 | struct Shape {
      |        ^
include/tinymath/shape.h:3:8: note: previous definition is here`,
    options: STAGES,
    answer: at('Compiler'),
    explanation: (
      <>
        The compiler reports it, but the preprocessor set it up: the header was pasted into the file twice, through two different includes, and the
        compiler then saw the same struct defined twice in one file. An include guard or <code>#pragma once</code> at the top of the header stops the
        second paste.
      </>
    ),
  },
  {
    snippet: `./build/demo: error while loading shared libraries: libtinymath.so: cannot open shared object file: No such file or directory`,
    options: STAGES,
    answer: at('Loader (run time)'),
    explanation: (
      <>
        The build succeeded. This happens when the program starts: the dynamic loader looks for the shared library the program was linked against
        and cannot find it in its search path. The usual fixes are installing the library where the loader looks, setting an rpath when linking, or
        setting <code>LD_LIBRARY_PATH</code> while testing.
      </>
    ),
  },
  {
    snippet: `CMake Error at CMakeLists.txt:8 (find_package):
  By not providing "FindTorch.cmake" in CMAKE_MODULE_PATH this project has
  asked CMake to find a package configuration file provided by "Torch", but
  CMake did not find one.`,
    options: STAGES,
    answer: at('CMake (configure)'),
    explanation: (
      <>
        Nothing has been compiled yet. CMake is still configuring the build and cannot find LibTorch&apos;s CMake package. Point it there, for example
        with <code>-DCMAKE_PREFIX_PATH=$(python -c &apos;import torch; print(torch.utils.cmake_prefix_path)&apos;)</code>.
      </>
    ),
  },
  {
    snippet: `CMake Error at CMakeLists.txt:1 (cmake_minimum_required):
  Compatibility with CMake < 3.5 has been removed from CMake.`,
    options: STAGES,
    answer: at('CMake (configure)'),
    explanation: (
      <>
        CMake 4.0 dropped support for projects that ask for a version older than 3.5, which many old repositories still do. Raise the version in the
        project&apos;s <code>cmake_minimum_required</code>, or, for a project you do not maintain, pass <code>-DCMAKE_POLICY_VERSION_MINIMUM=3.5</code>.
      </>
    ),
  },
  {
    snippet: `src/main.cpp:15:21: error: no matching function for call to 'dot'
   15 |   const float d = tinymath::dot(a, 3);
      |                   ^~~~~~~~~~~~~
include/tinymath/vec.h:15:7: note: candidate function not viable: no known conversion from 'int' to 'const std::vector<float>' for 2nd argument`,
    options: STAGES,
    answer: at('Compiler'),
    explanation: (
      <>
        Type checking is the compiler&apos;s job. It found a function named <code>dot</code>, but none whose parameters accept these arguments. The
        notes after the error list each candidate and why it did not fit, and they are usually the most useful lines.
      </>
    ),
  },
  {
    snippet: `In file included from src/main.cpp:7:
include/tinymath/vec.h:6:2: error: #error "tinymath needs C++20 or newer"
    6 | #error "tinymath needs C++20 or newer"
      |  ^~~~~`,
    options: STAGES,
    answer: at('Preprocessor'),
    explanation: (
      <>
        <code>#error</code> is a preprocessor directive. The header checks <code>__cplusplus</code> with <code>#if</code> and stops the build when the
        language version is too old. Compile with <code>-std=c++20</code>, or set <code>CMAKE_CXX_STANDARD</code> to 20.
      </>
    ),
  },
]

function Pipeline({ item, answered }: { item: QuizItem; answered: boolean }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-[0.75rem]" aria-label="Build stages">
      {STAGES.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          <span
            className={clsx(
              'rounded-full border px-2 py-0.5',
              answered && i === item.answer ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-rule text-muted',
            )}
          >
            {s}
          </span>
          {i < STAGES.length - 1 && (
            <span className="text-muted" aria-hidden>
              →
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}

export default function BuildStageQuiz() {
  return (
    <Quiz
      title="Try it: which stage is complaining?"
      description="Each message below is what a real build prints when one stage fails. Read it, decide which stage produced it, and see what usually causes it."
      items={ITEMS}
      question="Which stage produced this error?"
      noun="Error"
      extra={(item, answered) => <Pipeline item={item} answered={answered} />}
    />
  )
}
