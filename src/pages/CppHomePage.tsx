import { useEffect } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { chapterById, chaptersOf, HANDBOOKS, partsOf, sectionHref } from '../lib/content'
import { useOverallProgress, useProgress } from '../lib/progress'
import { ProgressRing } from '../components/ProgressRing'
import { PartSection } from './HomePage'

// Home page of C++ for AI Infrastructure Engineers, the third course on the site.
// Its chapters live in content/cpp/; content/cpp/SYLLABUS.md is the plan for the whole course.

/** The course's parts in order. A part is listed under "Still to come" until its id appears in PARTS with chapters. */
const PLANNED = [
  { id: 'cpp-ground-rules', title: 'The ground rules', text: 'How C++ becomes a program, and where your data lives and for how long.' },
  { id: 'cpp-ownership', title: 'Ownership and abstraction', text: 'RAII, moves, smart pointers, the standard library and templates, ending in a tensor library.' },
  { id: 'cpp-performance', title: 'Performance', text: 'Caches, honest benchmarks and SIMD, taught on one matrix multiply made faster step by step.' },
  { id: 'cpp-concurrency', title: 'Concurrency', text: 'Threads, locks, atomics and a thread pool, ending in a small inference server with a batcher.' },
  { id: 'cpp-systems-glue', title: 'Systems glue', text: 'Loading model files with mmap, and calling your C++ from Python without copies.' },
  { id: 'cpp-cuda', title: 'CUDA', text: 'GPU kernels for the operations a transformer runs: matmul, softmax, RMSNorm and RoPE.' },
  { id: 'cpp-capstone', title: 'Capstone', text: 'A small LLM inference engine in C++, parallel on the CPU, with an optional CUDA backend.' },
]

export function CppHomePage() {
  const handbook = HANDBOOKS.cpp
  const overall = useOverallProgress('cpp')
  const lastVisited = useProgress((s) => s.lastVisited)
  const location = useLocation()

  useEffect(() => {
    document.title = handbook.title
    const id = location.hash.slice(1)
    if (id) document.getElementById(id)?.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [location.key, location.hash, handbook.title])

  const last = lastVisited && chapterById.get(lastVisited.chapterId)
  const resume = last?.part.handbook === 'cpp' ? last : undefined
  const resumeSection = resume?.sections.find((s) => s.id === lastVisited?.sectionId)
  const first = chaptersOf('cpp')[0]
  const published = partsOf('cpp')
  const upcoming = PLANNED.filter((p) => !published.some((q) => q.id === p.id))

  return (
    <div className="mx-auto max-w-[66rem] px-4 pt-10 pb-16 sm:px-8 lg:pt-16">
      <section className="max-w-2xl">
        <p className="text-sm font-medium text-accent">Draft: chapters are added as they are written</p>
        <h1 className="mt-2 text-[2.25rem] leading-[1.1] font-semibold tracking-tight text-ink sm:text-[3rem]">{handbook.title}</h1>
        <p className="mt-4 font-serif text-lg leading-relaxed text-ink-2">
          A course in C++ and CUDA for engineers who already program in Python and want to work on the systems that run models. It starts with how
          a C++ program is built and ends with a small LLM inference engine that you write yourself, so every chapter is a step toward that engine.
        </p>
        <p className="mt-3 text-[0.95rem] text-muted">
          It is the hands-on companion to the{' '}
          <Link to={HANDBOOKS.infra.home} className="text-accent hover:underline">
            {HANDBOOKS.infra.title}
          </Link>
          , which explains what inference engines do. This course teaches the language they are written in.
        </p>

        {first && (
          <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-4">
            <Link
              to={resume ? sectionHref(resume.id, resumeSection?.id ?? 'overview') : `/learn/${first.id}`}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent hover:opacity-90"
            >
              {resume ? `Continue with ${resume.title}` : 'Start the course'}
              <ArrowRight size={16} />
            </Link>
            <span className="flex items-center gap-2.5 text-sm text-muted">
              <ProgressRing ratio={overall.ratio} size={22} stroke={3} />
              <span className="tabular-nums">
                {overall.done} of {overall.total} sections done
              </span>
            </span>
          </div>
        )}
      </section>

      {published.length > 0 && (
        <div className="mt-16 space-y-14">
          {published.map((part) => (
            <PartSection key={part.id} part={part} />
          ))}
        </div>
      )}

      {upcoming.length > 0 && (
        <section className="mt-16 max-w-2xl" aria-labelledby="upcoming-heading">
          <h2 id="upcoming-heading" className="text-xl font-semibold tracking-tight text-ink">
            Still to come
          </h2>
          <ol className="mt-4 space-y-3">
            {upcoming.map((p) => (
              <li key={p.id} className="rounded-xl border border-dashed border-rule px-4 py-3">
                <span className="block font-medium text-ink-2">{p.title}</span>
                <span className="mt-0.5 block text-sm text-muted">{p.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}
