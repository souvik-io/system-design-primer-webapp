import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Check, Circle, Clock, ExternalLink, PenLine } from 'lucide-react'
import { chapterById, loadChapter, sectionHref, sectionKey, useVisibleContent, type Chapter, type ChapterMeta, type SourceFile } from '../lib/content'
import { useChapterProgress, useIsSectionDone, useProgress } from '../lib/progress'
import { useSettings } from '../lib/settings'
import { useArticleClicks } from '../components/useArticleClicks'
import { ExtrasSwitch } from '../components/ExtrasToggle'
import { NotFound } from './NotFound'

export function ChapterPage() {
  const { chapterId = '' } = useParams()
  const meta = chapterById.get(chapterId)
  const showExtras = useSettings((s) => s.showExtras)
  if (!meta) return <NotFound />
  if (meta.extra && !showExtras) return <HiddenExtra meta={meta} />
  return <ChapterView key={meta.id} meta={meta} />
}

/** Someone followed a link to an extra chapter while extra chapters are turned off. */
function HiddenExtra({ meta }: { meta: ChapterMeta }) {
  useEffect(() => {
    document.title = `${meta.title} | System Design Primer`
  }, [meta])
  return (
    <div className="mx-auto max-w-[70ch] px-4 pt-12 pb-16 sm:px-8">
      <h1 className="text-[2rem] leading-tight font-semibold tracking-tight text-ink">{meta.title}</h1>
      <p className="mt-4 font-serif text-lg leading-relaxed text-ink-2">
        This is one of the extra chapters written for this site, beyond the primer. Extra chapters are turned off. Turn them on to read it.
      </p>
      <ExtrasSwitch className="mt-6" />
      <p className="mt-6 text-sm text-muted">
        You can change this any time from the{' '}
        <Link to="/#extras" className="text-accent hover:underline">
          course overview
        </Link>
        .
      </p>
    </div>
  )
}

function ChapterView({ meta }: { meta: ChapterMeta & { part: { id: string; title: string } } }) {
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const articleRef = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const { onClick: onArticleClick, zoom } = useArticleClicks()
  const tracked = !meta.untracked
  const visit = useProgress((s) => s.visit)
  const setChapterDone = useProgress((s) => s.setChapterDone)
  const progress = useChapterProgress(meta)
  const { chapters } = useVisibleContent()

  useEffect(() => {
    document.title = `${meta.title} | System Design Primer`
    loadChapter(meta.id).then(setChapter, (e: Error) => setError(e.message))
  }, [meta])

  // Scroll to the linked heading once content is in the page, or to the top otherwise.
  useEffect(() => {
    if (!chapter) return
    const id = decodeURIComponent(location.hash.slice(1))
    const el = id ? document.getElementById(id) : null
    if (!el) {
      window.scrollTo(0, 0)
      return
    }
    el.scrollIntoView()

    // Diagrams above the target, and web fonts on a first visit, load afterwards and push
    // it down. Re-anchor once they're in, unless the reader has scrolled in the meantime.
    let cancelled = false
    const y = window.scrollY
    const above = [...(articleRef.current?.querySelectorAll('img') ?? [])].filter(
      (img) => !img.complete && img.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
    )
    for (const img of above) img.loading = 'eager'
    const settled = (img: HTMLImageElement) =>
      new Promise((done) => {
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
      })
    Promise.all([document.fonts.ready, ...above.map(settled)]).then(() => {
      if (!cancelled && Math.abs(window.scrollY - y) < 2) el.scrollIntoView()
    })
    return () => {
      cancelled = true
    }
  }, [chapter, location.key, location.hash])

  // Track which section is being read, for the outline and "continue where you left off".
  useEffect(() => {
    if (!chapter || !articleRef.current) return
    const els = [...articleRef.current.querySelectorAll<HTMLElement>('[data-section]')]
    const visible = new Map<string, boolean>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set((e.target as HTMLElement).dataset.section!, e.isIntersecting)
        const first = els.find((el) => visible.get(el.dataset.section!))
        if (first) setActiveSection(first.dataset.section!)
      },
      { rootMargin: '-72px 0px -55% 0px' },
    )
    els.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [chapter])

  useEffect(() => {
    if (activeSection && tracked) visit(meta.id, activeSection)
  }, [activeSection, meta.id, visit, tracked])

  const index = chapters.findIndex((c) => c.id === meta.id)
  const prev = chapters[index - 1]
  const next = chapters[index + 1]
  const allDone = progress.done === progress.total

  return (
    <div className="flex justify-center gap-12 px-4 pt-8 pb-16 sm:px-8 lg:px-12 lg:pt-12">
      <div className="w-full max-w-[70ch] min-w-0">
        <header className="mb-10">
          <Link to={`/#${meta.part.id}`} className="text-sm text-muted hover:text-ink">
            {meta.part.title}
          </Link>
          <h1 id={meta.id} className="mt-2 text-[2rem] leading-tight font-semibold tracking-tight text-ink sm:text-[2.5rem]">
            {meta.title}
          </h1>
          {meta.alsoAsked && <p className="mt-2 text-muted">Also asked as: {meta.alsoAsked}</p>}
          {meta.extra && (
            <p className="mt-4 flex gap-2.5 rounded-lg border border-dashed border-rule px-3.5 py-2.5 text-sm text-ink-2">
              <PenLine size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
              <span>
                Written for this site, not part of The System Design Primer. The sources it draws on are listed under Further reading at the end.
              </span>
            </p>
          )}

          {tracked && (
            <>
              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm text-muted">
                <span className="flex items-center gap-1.5">
                  <Clock size={15} /> {meta.minutes} min read
                </span>
                <span className="tabular-nums">
                  {progress.done} of {progress.total} {progress.total === 1 ? 'section' : 'sections'} done
                </span>
                <button
                  type="button"
                  onClick={() => setChapterDone(meta, !allDone)}
                  className={clsx(
                    'ml-auto rounded-md border px-3 py-1.5 text-[0.8125rem] font-medium',
                    allDone ? 'border-done/40 bg-done-soft text-done' : 'border-rule bg-surface text-ink hover:border-muted/50',
                  )}
                >
                  {allDone ? 'Mark chapter as not done' : 'Mark chapter as done'}
                </button>
              </div>
              <div className="mt-4 h-1 overflow-hidden rounded-full bg-rule" aria-hidden>
                <div className="h-full rounded-full bg-done transition-[width] duration-300" style={{ width: `${progress.ratio * 100}%` }} />
              </div>
            </>
          )}
        </header>

        {error ? (
          <div className="rounded-lg border border-rule bg-surface p-6 text-sm">
            <p className="font-medium text-ink">This chapter didn't load.</p>
            <p className="mt-1 text-muted">{error} Reload the page to try again.</p>
          </div>
        ) : !chapter ? (
          <div className="space-y-3" aria-label="Loading chapter">
            {[90, 100, 75, 95, 60].map((w, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-rule/70" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : (
          <div ref={articleRef} onClick={onArticleClick}>
            {chapter.sections.map((sec) => (
              <section key={sec.id} data-section={sec.id} className="border-b border-rule pb-10 not-first:pt-10">
                <div className="article" dangerouslySetInnerHTML={{ __html: sec.html }} />
                {tracked && <SectionDoneButton chapterId={meta.id} sectionId={sec.id} title={sec.title} />}
              </section>
            ))}
            {chapter.sourceFiles.length > 0 && <SourceFiles files={chapter.sourceFiles} />}
          </div>
        )}

        <nav className="mt-12 grid gap-3 sm:grid-cols-2" aria-label="Chapter navigation">
          {prev ? (
            <Link to={`/learn/${prev.id}`} className="group rounded-lg border border-rule p-4 hover:border-accent/60">
              <span className="flex items-center gap-1.5 text-sm text-muted">
                <ArrowLeft size={14} /> Previous
              </span>
              <span className="mt-1 block font-medium text-ink group-hover:text-accent">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link to={`/learn/${next.id}`} className="group rounded-lg border border-rule p-4 text-right hover:border-accent/60">
              <span className="flex items-center justify-end gap-1.5 text-sm text-muted">
                Next <ArrowRight size={14} />
              </span>
              <span className="mt-1 block font-medium text-ink group-hover:text-accent">{next.title}</span>
            </Link>
          )}
        </nav>
      </div>

      <aside className="sticky top-24 hidden h-fit max-h-[calc(100vh-7rem)] w-56 shrink-0 overflow-y-auto xl:block">
        <h2 className="mb-3 text-sm font-semibold text-ink">In this chapter</h2>
        <Outline meta={meta} active={activeSection} hasSource={Boolean(chapter?.sourceFiles.length)} />
      </aside>

      {zoom}
    </div>
  )
}

function SectionDoneButton({ chapterId, sectionId, title }: { chapterId: string; sectionId: string; title: string }) {
  const done = useIsSectionDone(chapterId, sectionId)
  const setSectionDone = useProgress((s) => s.setSectionDone)
  return (
    <button
      type="button"
      onClick={() => setSectionDone(chapterId, sectionId, !done)}
      aria-pressed={done}
      aria-label={`${title}: ${done ? 'done' : 'mark as done'}`}
      title={done ? 'Mark as not done' : undefined}
      className={clsx(
        'mt-8 flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors',
        done ? 'border-done/40 bg-done-soft text-done' : 'border-rule bg-surface text-ink-2 hover:border-done/50 hover:text-ink',
      )}
    >
      {done ? <Check size={16} strokeWidth={3} /> : <Circle size={16} />}
      {done ? 'Section done' : 'Mark section as done'}
    </button>
  )
}

/** The runnable .py files behind a solution, collapsed by default. Not part of progress. */
function SourceFiles({ files }: { files: SourceFile[] }) {
  return (
    <section data-section="source-code" className="pt-10">
      <h3 id="source-code" className="text-2xl font-semibold tracking-tight text-ink">
        Full source code
      </h3>
      <p className="mt-2 font-serif text-ink-2">The complete Python files for this solution. The text above quotes the key parts.</p>
      <div className="mt-5 space-y-3">
        {files.map((f) => (
          <details key={f.name} className="group overflow-hidden rounded-lg border border-rule bg-surface">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-mono text-sm text-ink hover:bg-accent-soft/40">
              <ArrowRight size={14} className="text-muted transition-transform group-open:rotate-90" />
              {f.name}
              <a
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1 font-sans text-xs text-muted hover:text-accent"
                onClick={(e) => e.stopPropagation()}
              >
                GitHub <ExternalLink size={12} />
              </a>
            </summary>
            <div
              className="article max-w-none border-t border-rule [&_pre]:rounded-none [&_pre]:border-0"
              dangerouslySetInnerHTML={{ __html: f.html }}
            />
          </details>
        ))}
      </div>
    </section>
  )
}

function Outline({ meta, active, hasSource }: { meta: ChapterMeta; active: string | null; hasSource: boolean }) {
  const completed = useProgress((s) => s.completed)
  return (
    <ul className="space-y-0.5 border-l border-rule text-[0.8125rem]">
      {meta.sections.map((s) => {
        const done = Boolean(completed[sectionKey(meta.id, s.id)])
        return (
          <li key={s.id}>
            <Link
              to={sectionHref(meta.id, s.id)}
              className={clsx(
                '-ml-px flex items-start gap-2 border-l py-1 pl-3 leading-snug',
                active === s.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
              )}
            >
              <span className="flex-1">{s.title}</span>
              {done && <Check size={13} strokeWidth={3} className="mt-0.5 shrink-0 text-done" aria-label="Done" />}
            </Link>
          </li>
        )
      })}
      {hasSource && (
        <li>
          <Link
            to={`/learn/${meta.id}#source-code`}
            className={clsx(
              '-ml-px flex border-l py-1 pl-3 leading-snug',
              active === 'source-code' ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            Full source code
          </Link>
        </li>
      )}
    </ul>
  )
}
