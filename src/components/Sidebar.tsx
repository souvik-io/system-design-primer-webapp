import { Link, NavLink, useParams } from 'react-router'
import clsx from 'clsx'
import { ArrowRightLeft, Bookmark, Check, Info, Layers } from 'lucide-react'
import { decks, HANDBOOKS, partsOf, sectionHref, sectionKey, type ChapterMeta } from '../lib/content'
import { useHandbook } from '../lib/handbook'
import { useChapterProgress, useProgress } from '../lib/progress'
import { useDueCount } from '../lib/flashcards'
import { useNotes, useNotesCount } from '../lib/notes'
import { ProgressRing } from './ProgressRing'

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { chapterId } = useParams()
  const due = useDueCount(decks)
  const notesCount = useNotesCount()
  const handbook = useHandbook()
  const other = handbook === 'infra' ? 'system-design' : 'infra'

  return (
    <nav aria-label="Chapters" className="px-3 py-5 text-[0.875rem]">
      <NavLink
        to={HANDBOOKS[handbook].home}
        end
        onClick={onNavigate}
        className={({ isActive }) =>
          clsx('mb-4 block rounded-md px-3 py-1.5 font-medium', isActive ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-rule/50')
        }
      >
        Course overview
      </NavLink>
      <NavLink
        to="/flashcards"
        onClick={onNavigate}
        className={({ isActive }) =>
          clsx(
            '-mt-3 mb-4 flex items-center gap-2 rounded-md px-3 py-1.5 font-medium',
            isActive ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-rule/50',
          )
        }
      >
        <Layers size={15} />
        Flashcards
        {due > 0 && (
          <span
            className="ml-auto rounded-full bg-accent px-1.5 text-[0.7rem] leading-[1.15rem] text-on-accent tabular-nums"
            aria-label={`${due} due`}
          >
            {due}
          </span>
        )}
      </NavLink>
      <NavLink
        to="/notes"
        onClick={onNavigate}
        className={({ isActive }) =>
          clsx(
            '-mt-3 mb-4 flex items-center gap-2 rounded-md px-3 py-1.5 font-medium',
            isActive ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-rule/50',
          )
        }
      >
        <Bookmark size={15} />
        Notes and bookmarks
        {notesCount > 0 && <span className="ml-auto text-[0.75rem] text-muted tabular-nums">{notesCount}</span>}
      </NavLink>

      <Link
        to={HANDBOOKS[other].home}
        onClick={onNavigate}
        className="-mt-3 mb-5 flex items-center gap-2 rounded-md px-3 py-1.5 text-ink-2 hover:bg-rule/50 hover:text-ink"
      >
        <ArrowRightLeft size={15} />
        {HANDBOOKS[other].title}
      </Link>

      {partsOf(handbook).map((part) => (
        <div key={part.id} className="mb-5">
          <h2 className="px-3 pb-1.5 text-[0.8rem] font-semibold text-muted">{part.title}</h2>
          <ul>
            {part.chapters.map((ch) => (
              <SidebarChapter key={ch.id} chapter={ch} active={ch.id === chapterId} onNavigate={onNavigate} />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function SidebarChapter({ chapter, active, onNavigate }: { chapter: ChapterMeta; active: boolean; onNavigate?: () => void }) {
  const { ratio, done, total } = useChapterProgress(chapter)
  const completed = useProgress((s) => s.completed)
  const bookmarks = useNotes((s) => s.bookmarks)

  return (
    <li>
      <NavLink
        to={`/learn/${chapter.id}`}
        onClick={onNavigate}
        className={clsx(
          'flex items-start gap-2.5 rounded-md px-3 py-1.5 leading-snug',
          active ? 'bg-accent-soft font-medium text-ink' : 'text-ink-2 hover:bg-rule/50 hover:text-ink',
        )}
      >
        <span className="mt-[3px]">
          {chapter.untracked ? (
            <Info size={14} className="text-muted" aria-hidden />
          ) : (
            <ProgressRing ratio={ratio} size={14} stroke={2} label={`${done} of ${total} sections done`} />
          )}
        </span>
        <span>{chapter.title}</span>
      </NavLink>

      {active && chapter.sections.length > 1 && (
        <ul className="my-1 ml-[1.15rem] border-l border-rule pl-3">
          {chapter.sections.map((s) => {
            const isDone = !chapter.untracked && Boolean(completed[sectionKey(chapter.id, s.id)])
            return (
              <li key={s.id}>
                <Link
                  to={sectionHref(chapter.id, s.id)}
                  onClick={onNavigate}
                  className="flex items-start gap-2 rounded px-1.5 py-1 text-[0.8125rem] leading-snug text-muted hover:text-ink"
                >
                  <span
                    className={clsx(
                      'mt-[3px] grid size-3 shrink-0 place-items-center rounded-full',
                      isDone ? 'bg-done text-surface' : 'border border-rule',
                    )}
                  >
                    {isDone && <Check size={8} strokeWidth={4} />}
                  </span>
                  <span className={clsx('flex-1', isDone && 'text-ink-2')}>{s.title}</span>
                  {bookmarks[sectionKey(chapter.id, s.id)]?.on && (
                    <Bookmark size={11} fill="currentColor" className="mt-[3px] shrink-0 text-accent" aria-label="Bookmarked" />
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}
