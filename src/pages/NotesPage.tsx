import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import clsx from 'clsx'
import { Bookmark, Download, NotebookPen } from 'lucide-react'
import { chapters, sectionHref, sectionKey, type ChapterMeta, type SectionMeta } from '../lib/content'
import { useNotes } from '../lib/notes'
import { NoteEditor } from '../components/SectionTools'

type Filter = 'all' | 'bookmarks' | 'notes'
type Item = { chapter: ChapterMeta; section: SectionMeta; note: string; noteAt: number; bookmarked: boolean }

export function NotesPage() {
  const notes = useNotes((s) => s.notes)
  const bookmarks = useNotes((s) => s.bookmarks)
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    document.title = 'Notes and bookmarks | System Design Handbook'
    window.scrollTo(0, 0)
  }, [])

  // Everything with a note or a bookmark, in course order.
  const items: Item[] = []
  for (const chapter of chapters) {
    for (const section of chapter.sections) {
      const key = sectionKey(chapter.id, section.id)
      const note = notes[key]?.text ?? ''
      const bookmarked = Boolean(bookmarks[key]?.on)
      if (note || bookmarked) items.push({ chapter, section, note, noteAt: notes[key]?.at ?? 0, bookmarked })
    }
  }
  const shown = items.filter((i) => filter === 'all' || (filter === 'notes' ? i.note : i.bookmarked))
  const counts = { all: items.length, bookmarks: 0, notes: 0 }
  for (const i of items) {
    if (i.bookmarked) counts.bookmarks++
    if (i.note) counts.notes++
  }

  const groups: { chapter: ChapterMeta; items: Item[] }[] = []
  for (const i of shown) {
    if (groups.at(-1)?.chapter.id !== i.chapter.id) groups.push({ chapter: i.chapter, items: [] })
    groups.at(-1)!.items.push(i)
  }

  return (
    <div className="mx-auto max-w-[70ch] px-4 pt-10 pb-16 sm:px-8 lg:pt-14">
      <h1 className="text-[2rem] leading-tight font-semibold tracking-tight text-ink">Notes and bookmarks</h1>
      <p className="mt-3 font-serif text-lg leading-relaxed text-ink-2">
        Everything you've bookmarked or written a note on, in course order. Add them from the buttons at the end of each section.
      </p>

      {items.length === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-rule px-5 py-8 text-center">
          <p className="font-medium text-ink">Nothing here yet.</p>
          <p className="mt-1 text-sm text-muted">
            At the end of any section, use <span className="font-medium text-ink-2">Bookmark</span> to come back to it later, or{' '}
            <span className="font-medium text-ink-2">Add note</span> to write down what you want to remember.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <div role="tablist" aria-label="Show" className="inline-flex rounded-lg border border-rule bg-surface p-0.5 text-sm">
              {(['all', 'bookmarks', 'notes'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={clsx('rounded-md px-3 py-1.5 font-medium', filter === f ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink')}
                >
                  {f === 'all' ? 'All' : f === 'bookmarks' ? 'Bookmarks' : 'Notes'} <span className="tabular-nums opacity-75">{counts[f]}</span>
                </button>
              ))}
            </div>
            {counts.notes > 0 && (
              <button
                type="button"
                onClick={() => downloadNotes(items.filter((i) => i.note))}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink-2 hover:border-muted/50 hover:text-ink"
              >
                <Download size={15} /> Download notes
              </button>
            )}
          </div>

          {groups.length === 0 ? (
            <p className="mt-8 text-muted">{filter === 'notes' ? 'No notes yet.' : 'No bookmarks yet.'}</p>
          ) : (
            <div className="mt-8 space-y-9">
              {groups.map((g) => (
                <section key={g.chapter.id} aria-labelledby={`notes-${g.chapter.id}`}>
                  <h2 id={`notes-${g.chapter.id}`} className="text-lg font-semibold tracking-tight text-ink">
                    <Link to={`/learn/${g.chapter.id}`} className="hover:text-accent">
                      {g.chapter.title}
                    </Link>
                  </h2>
                  <div className="mt-3 space-y-3">
                    {g.items.map((i) => (
                      <NoteItem key={i.section.id} item={i} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function NoteItem({ item }: { item: Item }) {
  const [editing, setEditing] = useState(false)
  const setBookmark = useNotes((s) => s.setBookmark)
  const { chapter, section, note, noteAt, bookmarked } = item

  return (
    <div className="rounded-lg border border-rule bg-surface px-4 py-3">
      <div className="flex items-start gap-3">
        <Link to={sectionHref(chapter.id, section.id)} className="flex-1 font-medium text-ink hover:text-accent">
          {section.title}
        </Link>
        <button
          type="button"
          onClick={() => setBookmark(chapter.id, section.id, !bookmarked)}
          aria-pressed={bookmarked}
          aria-label={`${section.title}: ${bookmarked ? 'bookmarked' : 'bookmark'}`}
          title={bookmarked ? 'Remove bookmark' : 'Bookmark'}
          className={clsx('rounded p-1', bookmarked ? 'text-accent' : 'text-muted hover:text-ink')}
        >
          <Bookmark size={16} fill={bookmarked ? 'currentColor' : 'none'} />
        </button>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={`${section.title}: ${note ? 'edit note' : 'add a note'}`}
            title={note ? 'Edit note' : 'Add a note'}
            className="rounded p-1 text-muted hover:text-ink"
          >
            <NotebookPen size={16} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-3">
          <NoteEditor chapterId={chapter.id} sectionId={section.id} title={section.title} onClose={() => setEditing(false)} />
        </div>
      ) : (
        note && (
          <>
            <p className="mt-1.5 text-[0.95rem] leading-relaxed whitespace-pre-wrap text-ink-2">{note}</p>
            <p className="mt-2 text-xs text-muted">
              Edited {new Date(noteAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
            </p>
          </>
        )
      )}
    </div>
  )
}

/** Saves the notes as a Markdown file, grouped by chapter. */
function downloadNotes(items: Item[]) {
  const lines = ['# My System Design Handbook notes', '']
  let chapter = ''
  for (const i of items) {
    if (i.chapter.id !== chapter) {
      chapter = i.chapter.id
      lines.push(`## ${i.chapter.title}`, '')
    }
    lines.push(`### ${i.section.title}`, '', i.note.trim(), '')
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `system-design-notes-${new Date().toISOString().slice(0, 10)}.md`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
