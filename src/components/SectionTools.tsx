import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Bookmark, Check, Circle, NotebookPen } from 'lucide-react'
import { useIsSectionDone, useProgress } from '../lib/progress'
import { useIsBookmarked, useNote, useNotes } from '../lib/notes'

/** The controls under each section: mark done, bookmark, and a note. */
export function SectionTools({ chapterId, sectionId, title, tracked }: { chapterId: string; sectionId: string; title: string; tracked: boolean }) {
  const note = useNote(chapterId, sectionId)
  const [editing, setEditing] = useState(false)

  return (
    <div className="mt-8">
      {editing ? (
        <NoteEditor chapterId={chapterId} sectionId={sectionId} title={title} onClose={() => setEditing(false)} />
      ) : (
        note && (
          <div className="mb-4 rounded-lg border border-rule bg-surface px-4 py-3">
            <div className="flex items-baseline gap-3">
              <h4 className="text-sm font-semibold text-ink">Your note</h4>
              <button type="button" onClick={() => setEditing(true)} className="ml-auto text-sm text-accent hover:underline">
                Edit note
              </button>
            </div>
            <p className="mt-1.5 text-[0.95rem] leading-relaxed whitespace-pre-wrap text-ink-2">{note}</p>
          </div>
        )
      )}
      <div className="flex flex-wrap items-center gap-2">
        {tracked && <DoneButton chapterId={chapterId} sectionId={sectionId} title={title} />}
        <BookmarkButton chapterId={chapterId} sectionId={sectionId} title={title} />
        {!note && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-3.5 py-2 text-sm font-medium text-ink-2 hover:border-muted/50 hover:text-ink"
            aria-label={`${title}: add a note`}
          >
            <NotebookPen size={16} />
            Add note
          </button>
        )}
      </div>
    </div>
  )
}

function DoneButton({ chapterId, sectionId, title }: { chapterId: string; sectionId: string; title: string }) {
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
        'flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors',
        done ? 'border-done/40 bg-done-soft text-done' : 'border-rule bg-surface text-ink-2 hover:border-done/50 hover:text-ink',
      )}
    >
      {done ? <Check size={16} strokeWidth={3} /> : <Circle size={16} />}
      {done ? 'Section done' : 'Mark section as done'}
    </button>
  )
}

function BookmarkButton({ chapterId, sectionId, title }: { chapterId: string; sectionId: string; title: string }) {
  const on = useIsBookmarked(chapterId, sectionId)
  const setBookmark = useNotes((s) => s.setBookmark)
  return (
    <button
      type="button"
      onClick={() => setBookmark(chapterId, sectionId, !on)}
      aria-pressed={on}
      aria-label={`${title}: ${on ? 'bookmarked' : 'bookmark'}`}
      title={on ? 'Remove bookmark' : 'Bookmark this section to come back to it'}
      className={clsx(
        'flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors',
        on ? 'border-accent/40 bg-accent-soft text-accent' : 'border-rule bg-surface text-ink-2 hover:border-muted/50 hover:text-ink',
      )}
    >
      <Bookmark size={16} fill={on ? 'currentColor' : 'none'} />
      {on ? 'Bookmarked' : 'Bookmark'}
    </button>
  )
}

/** Saves as you type. Closing with an empty box deletes the note. */
export function NoteEditor({ chapterId, sectionId, title, onClose }: { chapterId: string; sectionId: string; title: string; onClose: () => void }) {
  const saved = useNote(chapterId, sectionId)
  const setNote = useNotes((s) => s.setNote)
  const [text, setText] = useState(saved)
  const ref = useRef<HTMLTextAreaElement>(null)
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // Keep the box sized to its text.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, 96)}px`
  }, [text])

  const save = (value: string) => {
    clearTimeout(pending.current)
    setNote(chapterId, sectionId, value)
  }
  useEffect(() => () => clearTimeout(pending.current), [])

  const close = () => {
    save(text)
    onClose()
  }

  return (
    <div className="mb-4 rounded-lg border border-accent/50 bg-surface px-4 py-3">
      <label htmlFor={`note-${sectionId}`} className="text-sm font-semibold text-ink">
        Your note on {title}
      </label>
      <textarea
        id={`note-${sectionId}`}
        ref={ref}
        value={text}
        onChange={(e) => {
          const value = e.target.value
          setText(value)
          clearTimeout(pending.current)
          pending.current = setTimeout(() => setNote(chapterId, sectionId, value), 500)
        }}
        onBlur={() => save(text)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
            e.preventDefault()
            close()
          }
        }}
        placeholder="What to remember, a question to look up, how you'd explain it in an interview…"
        className="mt-2 block w-full resize-none rounded-md border border-rule bg-paper px-3 py-2 text-[0.95rem] leading-relaxed text-ink placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <button type="button" onClick={close} className="rounded-md bg-accent px-3 py-1.5 font-medium text-on-accent hover:opacity-90">
          Done
        </button>
        {saved && (
          <button
            type="button"
            onClick={() => {
              setText('')
              save('')
              onClose()
            }}
            className="text-muted hover:text-ink"
          >
            Delete note
          </button>
        )}
        <span className="ml-auto text-muted">Saved as you type. Esc to close.</span>
      </div>
    </div>
  )
}
