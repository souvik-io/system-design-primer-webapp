import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import clsx from 'clsx'
import { ArrowRight, Info } from 'lucide-react'
import {
  chapterById,
  chapters,
  chaptersOf,
  decks,
  HANDBOOKS,
  partsOf,
  sectionHref,
  sectionKey,
  type ChapterMeta,
  type DeckMeta,
  type Part,
} from '../lib/content'
import { useDeckStats } from '../lib/flashcards'
import { useChapterProgress, useOverallProgress, useProgress } from '../lib/progress'
import { useAccount } from '../lib/account'
import { ProgressRing } from '../components/ProgressRing'
import { SystemMap } from '../components/SystemMap'
import { MovedNotice } from '../components/MovedNotice'
import { StudyPlan } from '../components/StudyPlan'

export function HomePage() {
  const overall = useOverallProgress()
  const lastVisited = useProgress((s) => s.lastVisited)
  const location = useLocation()

  useEffect(() => {
    document.title = 'System Design Handbook'
    const id = location.hash.slice(1)
    if (id) document.getElementById(id)?.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [location.key, location.hash])

  const last = lastVisited && chapterById.get(lastVisited.chapterId)
  const resume = last?.part.handbook === 'system-design' ? last : undefined
  const resumeSection = resume?.sections.find((s) => s.id === lastVisited?.sectionId)

  return (
    <div className="mx-auto max-w-[66rem] px-4 pt-10 pb-16 sm:px-8 lg:pt-16">
      <section className="max-w-2xl">
        <h1 className="text-[2.25rem] leading-[1.1] font-semibold tracking-tight text-ink sm:text-[3rem]">System Design Handbook</h1>
        <p className="mt-4 font-serif text-lg leading-relaxed text-ink-2">
          A free course in designing large-scale systems, from the interview method to databases, caches and worked designs. Read a section, mark it
          done, and pick up where you left off next time.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-4">
          {resume ? (
            <Link
              to={sectionHref(resume.id, resumeSection?.id ?? 'overview')}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent hover:opacity-90"
            >
              Continue with {resume.title}
              <ArrowRight size={16} />
            </Link>
          ) : (
            <Link
              to={`/learn/${chaptersOf('system-design')[0].id}`}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent hover:opacity-90"
            >
              Start the course
              <ArrowRight size={16} />
            </Link>
          )}
          <span className="flex items-center gap-2.5 text-sm text-muted">
            <ProgressRing ratio={overall.ratio} size={22} stroke={3} />
            <span className="tabular-nums">
              {overall.done} of {overall.total} sections done
            </span>
          </span>
        </div>
      </section>

      <MovedNotice />

      <Link
        to={HANDBOOKS.infra.home}
        className="group mt-10 flex items-center gap-4 rounded-2xl border border-rule bg-surface px-5 py-4 hover:border-accent"
      >
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-ink group-hover:text-accent">{HANDBOOKS.infra.title}</span>
          <span className="mt-0.5 block text-sm text-muted">{HANDBOOKS.infra.description}</span>
        </span>
        <ArrowRight size={18} className="shrink-0 text-muted group-hover:text-accent" />
      </Link>

      <StudyPlan />

      <section className="mt-12" aria-labelledby="map-heading">
        <div className="rounded-2xl border border-rule bg-surface py-5">
          <SystemMap />
        </div>
        <p id="map-heading" className="mt-3 max-w-2xl text-sm text-muted">
          The building blocks, in the order a request reaches them. Each one fills in as you finish its sections.
        </p>
      </section>

      <section className="mt-14" aria-labelledby="flashcards-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="flashcards-heading" className="text-xl font-semibold tracking-tight text-ink">
            Flashcards
          </h2>
          <Link to="/flashcards" className="text-sm text-accent hover:underline">
            All decks and settings
          </Link>
        </div>
        <p className="mt-1 max-w-2xl text-[0.95rem] text-muted">
          Review what you've read with spaced repetition. Cards you struggle with come back sooner.
        </p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-3">
          {decks.map((d) => (
            <DeckLink key={d.id} deck={d} />
          ))}
        </ul>
      </section>

      <div className="mt-16 space-y-14">
        {partsOf('system-design').map((part) => (
          <PartSection key={part.id} part={part} />
        ))}
      </div>

      <ResetProgress />
    </div>
  )
}

export function PartSection({ part }: { part: Part }) {
  return (
    <section id={part.id} className="scroll-mt-20">
      <div className="max-w-2xl">
        <h2 className="text-xl font-semibold tracking-tight text-ink">{part.title}</h2>
        <p className="mt-1 text-[0.95rem] text-muted">{part.description}</p>
      </div>
      <ol className="mt-4 divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
        {part.chapters.map((ch) => (
          <ChapterRow key={ch.id} chapter={ch} />
        ))}
      </ol>
    </section>
  )
}

function ChapterRow({ chapter }: { chapter: ChapterMeta }) {
  const { done, total, ratio } = useChapterProgress(chapter)
  return (
    <li>
      <Link to={`/learn/${chapter.id}`} className="group flex items-center gap-4 px-4 py-3.5 hover:bg-accent-soft/50 sm:px-5">
        {chapter.untracked ? (
          <Info size={22} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden />
        ) : (
          <ProgressRing ratio={ratio} size={22} stroke={2.5} label={`${done} of ${total} sections done`} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-ink group-hover:text-accent">{chapter.title}</span>
          {chapter.summary && <span className="mt-0.5 line-clamp-1 text-sm text-muted">{chapter.summary}</span>}
        </span>
        {!chapter.untracked && (
          <span className="hidden shrink-0 text-right text-[0.8125rem] text-muted tabular-nums sm:block">
            <span className="block">{chapter.minutes} min</span>
            <span className={clsx('block', done > 0 && 'text-done')}>
              {done}/{total}
            </span>
          </span>
        )}
      </Link>
    </li>
  )
}

function DeckLink({ deck }: { deck: DeckMeta }) {
  const stats = useDeckStats(deck)
  return (
    <li>
      <Link to={`/flashcards/${deck.id}`} className="group block h-full rounded-xl border border-rule bg-surface p-4 hover:border-accent">
        <span className="block font-medium text-ink group-hover:text-accent">{deck.title}</span>
        <span className="mt-1 block text-sm text-muted tabular-nums">
          {stats.due > 0 ? <span className="font-medium text-accent">{stats.due} due</span> : `${stats.total} cards`}
          {stats.newToday > 0 && `, ${stats.newToday} new today`}
        </span>
        <span className="mt-3 block h-1 overflow-hidden rounded-full bg-rule" aria-hidden>
          <span className="block h-full rounded-full bg-done" style={{ width: `${(stats.learned / stats.total) * 100}%` }} />
        </span>
      </Link>
    </li>
  )
}

function ResetProgress() {
  const [confirming, setConfirming] = useState(false)
  const completed = useProgress((s) => s.completed)
  const count = chapters.filter((c) => !c.untracked).reduce((n, c) => n + c.sections.filter((s) => completed[sectionKey(c.id, s.id)]).length, 0)
  const reset = useProgress((s) => s.reset)
  const signedIn = useAccount((s) => Boolean(s.email))
  if (count === 0 && !confirming) return null

  return (
    <div className="mt-16 flex items-center gap-3 text-sm text-muted">
      {confirming ? (
        <>
          <span>
            Clear all {count} completed {count === 1 ? 'section' : 'sections'}
            {signedIn ? ' on every device' : ''}? This can't be undone.
          </span>
          <button
            type="button"
            className="rounded-md border border-rule px-2.5 py-1 font-medium text-ink hover:border-red-500 hover:text-red-600"
            onClick={() => {
              reset()
              setConfirming(false)
            }}
          >
            Clear progress
          </button>
          <button type="button" className="px-2 py-1 hover:text-ink" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </>
      ) : (
        <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => setConfirming(true)}>
          Clear progress
        </button>
      )}
    </div>
  )
}
