import { useEffect } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { chapterById, chaptersOf, HANDBOOKS, partsOf, sectionHref } from '../lib/content'
import { useOverallProgress, useProgress } from '../lib/progress'
import { ProgressRing } from '../components/ProgressRing'
import { PartSection } from './HomePage'

// Home page of the AI Infrastructure Engineer Handbook, the second course on the site.
// Its chapters live in content/infra/; content/infra/SYLLABUS.md lists what is still to be written.

export function InfraHomePage() {
  const handbook = HANDBOOKS.infra
  const overall = useOverallProgress('infra')
  const lastVisited = useProgress((s) => s.lastVisited)
  const location = useLocation()

  useEffect(() => {
    document.title = handbook.title
    const id = location.hash.slice(1)
    if (id) document.getElementById(id)?.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [location.key, location.hash, handbook.title])

  const last = lastVisited && chapterById.get(lastVisited.chapterId)
  const resume = last?.part.handbook === 'infra' ? last : undefined
  const resumeSection = resume?.sections.find((s) => s.id === lastVisited?.sectionId)
  const first = chaptersOf('infra')[0]

  return (
    <div className="mx-auto max-w-[66rem] px-4 pt-10 pb-16 sm:px-8 lg:pt-16">
      <section className="max-w-2xl">
        <p className="text-sm font-medium text-accent">Draft: the first chapters of a longer course</p>
        <h1 className="mt-2 text-[2.25rem] leading-[1.1] font-semibold tracking-tight text-ink sm:text-[3rem]">{handbook.title}</h1>
        <p className="mt-4 font-serif text-lg leading-relaxed text-ink-2">
          How models run on GPUs, how serving engines schedule them, and how to make them fast and cheap, for engineers aiming at inference and ML
          infrastructure roles. Every chapter ends with a lab you run yourself, with a reference solution to check against.
        </p>
        <p className="mt-3 text-[0.95rem] text-muted">
          The lab code is in{' '}
          <a href="/labs/infra/README.md" className="text-accent hover:underline">
            one folder of Python files
          </a>{' '}
          you can download and run. It builds on the{' '}
          <Link to="/#ai-systems" className="text-accent hover:underline">
            AI systems
          </Link>{' '}
          part of the System Design Handbook, which explains what each piece is for. This course goes a level down, into how each piece works.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-4">
          <Link
            to={resume ? sectionHref(resume.id, resumeSection?.id ?? 'overview') : `/learn/${first.id}`}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent hover:opacity-90"
          >
            {resume ? `Continue with ${resume.title}` : 'Start the course'}
            <ArrowRight size={16} />
          </Link>
          <Link to="/flashcards" className="text-sm text-accent hover:underline">
            Flashcards for this course
          </Link>
          <span className="flex items-center gap-2.5 text-sm text-muted">
            <ProgressRing ratio={overall.ratio} size={22} stroke={3} />
            <span className="tabular-nums">
              {overall.done} of {overall.total} sections done
            </span>
          </span>
        </div>
      </section>

      <div className="mt-16 space-y-14">
        {partsOf('infra').map((part) => (
          <PartSection key={part.id} part={part} />
        ))}
      </div>
    </div>
  )
}
