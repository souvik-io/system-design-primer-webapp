import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router'
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Bookmark, Check, Clock } from 'lucide-react'
import { chapterById, chapters, loadChapter, redirects, sectionHref, sectionKey, type Chapter, type ChapterMeta } from '../lib/content'
import { movedChapterUrl } from '../lib/legacy'
import { useChapterProgress, useProgress } from '../lib/progress'
import { useNotes } from '../lib/notes'
import { useArticleClicks } from '../components/useArticleClicks'
import { SectionTools } from '../components/SectionTools'
import { Widgets } from '../widgets/Widgets'
import { NotFound } from './NotFound'

const chapterExists = (id: string) => chapterById.has(id)

export function ChapterPage() {
  const { chapterId = '' } = useParams()
  const { search, hash } = useLocation()
  // Old links: a renamed or replaced chapter, or (once the page is in) a heading that moved.
  const moved = movedChapterUrl(redirects, chapterId, search, hash, chapterExists)
  if (moved && !moved.ifMissing) return <Navigate to={moved.url} replace />
  const meta = chapterById.get(chapterId)
  if (!meta) return <NotFound />
  return <ChapterView key={meta.id} meta={meta} />
}

function ChapterView({ meta }: { meta: ChapterMeta & { part: { id: string; title: string } } }) {
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const articleRef = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const { onClick: onArticleClick, zoom } = useArticleClicks()
  const tracked = !meta.untracked
  const visit = useProgress((s) => s.visit)
  const setChapterDone = useProgress((s) => s.setChapterDone)
  const progress = useChapterProgress(meta)

  useEffect(() => {
    document.title = `${meta.title} | System Design Handbook`
    loadChapter(meta.id).then(setChapter, (e: Error) => setError(e.message))
  }, [meta])

  // Scroll to the linked heading once content is in the page, or to the top otherwise.
  useEffect(() => {
    if (!chapter) return
    const id = decodeURIComponent(location.hash.slice(1))
    const el = id ? document.getElementById(id) : null
    if (!el) {
      const moved = id && movedChapterUrl(redirects, meta.id, '', location.hash, chapterExists)
      if (moved) navigate(moved.url, { replace: true })
      else window.scrollTo(0, 0)
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

    // Interactive diagrams render a moment later too. Follow the target as the page grows,
    // for a few seconds or until the reader scrolls.
    let anchored = window.scrollY
    const follow = new ResizeObserver(() => {
      if (cancelled || Math.abs(window.scrollY - anchored) > 2) return follow.disconnect()
      el.scrollIntoView()
      anchored = window.scrollY
    })
    if (articleRef.current) follow.observe(articleRef.current)
    const stop = setTimeout(() => follow.disconnect(), 3000)
    return () => {
      cancelled = true
      follow.disconnect()
      clearTimeout(stop)
    }
  }, [chapter, location.key, location.hash, meta.id, navigate])

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
                <SectionTools chapterId={meta.id} sectionId={sec.id} title={sec.title} tracked={tracked} />
              </section>
            ))}
            <Widgets root={articleRef} chapter={chapter} />
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
        <Outline meta={meta} active={activeSection} />
      </aside>

      {zoom}
    </div>
  )
}

function Outline({ meta, active }: { meta: ChapterMeta; active: string | null }) {
  const completed = useProgress((s) => s.completed)
  const bookmarks = useNotes((s) => s.bookmarks)
  return (
    <ul className="space-y-0.5 border-l border-rule text-[0.8125rem]">
      {meta.sections.map((s) => {
        const done = Boolean(completed[sectionKey(meta.id, s.id)])
        const marked = Boolean(bookmarks[sectionKey(meta.id, s.id)]?.on)
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
              {marked && <Bookmark size={12} fill="currentColor" className="mt-0.5 shrink-0 text-accent" aria-label="Bookmarked" />}
              {done && <Check size={13} strokeWidth={3} className="mt-0.5 shrink-0 text-done" aria-label="Done" />}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
