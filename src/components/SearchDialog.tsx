import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import MiniSearch from 'minisearch'
import clsx from 'clsx'
import { Check, CornerDownLeft, Search } from 'lucide-react'
import { chapterById, sectionHref, sectionKey } from '../lib/content'
import { useProgress } from '../lib/progress'
import { useSettings } from '../lib/settings'

type Doc = { id: string; chapterId: string; sectionId: string; chapterTitle: string; title: string; text: string }
type Result = Doc & { terms: string[] }

let indexPromise: Promise<MiniSearch<Doc>> | null = null
let chapterIdsOfDocs: string[] = []

function loadIndex() {
  indexPromise ??= fetch('/content/search.json')
    .then((r) => r.json() as Promise<Doc[]>)
    .then((docs) => {
      const ms = new MiniSearch<Doc>({
        fields: ['title', 'chapterTitle', 'text'],
        storeFields: ['chapterId', 'sectionId', 'chapterTitle', 'title', 'text'],
        searchOptions: { boost: { title: 4, chapterTitle: 2 }, prefix: true, fuzzy: 0.15, combineWith: 'AND' },
      })
      ms.addAll(docs)
      chapterIdsOfDocs = docs.map((d) => d.chapterId)
      return ms
    })
    .catch((err) => {
      indexPromise = null
      throw err
    })
  return indexPromise
}

function snippet(text: string, terms: string[]) {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase())
    if (i !== -1 && (at === -1 || i < at)) at = i
  }
  if (at === -1) return text.slice(0, 140)
  const start = Math.max(0, at - 50)
  return (start > 0 ? '…' : '') + text.slice(start, start + 160).trim() + '…'
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length)
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'))
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-accent/20 px-0.5 text-ink">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  )
}

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState<MiniSearch<Doc> | null>(null)
  const [error, setError] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const navigate = useNavigate()
  const completed = useProgress((s) => s.completed)
  const showExtras = useSettings((s) => s.showExtras)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setError(false)
    loadIndex().then(setIndex, () => setError(true))
  }, [open])

  const { results, hiddenMatches } = useMemo(() => {
    if (!index || !query.trim()) return { results: [] as Result[], hiddenMatches: 0 }
    const all = index.search(query)
    const shown = all.filter((r) => showExtras || !chapterById.get(r.chapterId)?.extra)
    return {
      results: shown.slice(0, 12).map((r) => ({ ...(r as unknown as Doc), terms: r.terms })),
      hiddenMatches: all.length - shown.length,
    }
  }, [index, query, showExtras])

  const sectionCount = useMemo(() => {
    if (!index) return ''
    return chapterIdsOfDocs.filter((id) => showExtras || !chapterById.get(id)?.extra).length
  }, [index, showExtras])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const go = (r: Result) => {
    onClose()
    navigate(sectionHref(r.chapterId, r.sectionId))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && results[active]) {
      go(results[active])
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-3 border-b border-rule px-4">
          <Search size={18} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for a topic, like sharding or CAP theorem"
            className="h-13 w-full bg-transparent text-[0.95rem] text-ink outline-none placeholder:text-muted focus-visible:outline-none"
            aria-label="Search query"
            aria-controls="search-results"
            aria-activedescendant={results[active] ? `result-${active}` : undefined}
          />
          <kbd className="rounded border border-rule px-1.5 font-mono text-[0.7rem] text-muted">Esc</kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {error ? (
            <p className="px-4 py-8 text-center text-sm text-muted">The search index didn't load. Check your connection and open search again.</p>
          ) : !query.trim() ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              Search all {sectionCount} sections{showExtras ? '' : ' of the primer'} by title or content.
            </p>
          ) : results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              {hiddenMatches > 0
                ? `Nothing in the primer matches "${query}", but ${hiddenMatches} ${hiddenMatches === 1 ? 'section' : 'sections'} in the extra chapters ${hiddenMatches === 1 ? 'does' : 'do'}. Turn on extra chapters from the course overview to see them.`
                : `Nothing matches "${query}". Try a shorter or more general term.`}
            </p>
          ) : (
            <ul id="search-results" ref={listRef} role="listbox" className="p-2">
              {results.map((r, i) => (
                <li
                  key={r.id}
                  id={`result-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(r)}
                  className={clsx('cursor-pointer rounded-lg px-3 py-2.5', i === active && 'bg-accent-soft')}
                >
                  <div className="flex items-center gap-2 text-[0.8rem] text-muted">
                    <span className="truncate">{r.chapterTitle}</span>
                    {completed[sectionKey(r.chapterId, r.sectionId)] && <Check size={13} className="shrink-0 text-done" aria-label="Done" />}
                    {i === active && <CornerDownLeft size={13} className="ml-auto shrink-0" />}
                  </div>
                  <div className="font-medium text-ink">
                    <Highlight text={r.sectionId === 'overview' ? r.chapterTitle : r.title} terms={r.terms} />
                  </div>
                  <p className="mt-0.5 line-clamp-2 font-serif text-[0.85rem] leading-snug text-ink-2">
                    <Highlight text={snippet(r.text, r.terms)} terms={r.terms} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
