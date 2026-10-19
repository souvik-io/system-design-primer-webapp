import { useState } from 'react'
import { Link } from 'react-router'
import { X } from 'lucide-react'
import { decks, sectionExists } from '../lib/content'
import { useProgress } from '../lib/progress'
import { useFlashcards } from '../lib/flashcards'

// The site used to present The System Design Primer's own text. Every chapter has since been written for
// the site. Readers who studied the old chapters or decks get one notice saying what moved and what didn't.

const DISMISSED = 'sdp-moved-notice-dismissed'
const cardIds = new Set(decks.flatMap((d) => d.cardIds))

function readDismissed() {
  try {
    return localStorage.getItem(DISMISSED) === '1'
  } catch {
    return false
  }
}

export function MovedNotice() {
  const [dismissed, setDismissed] = useState(readDismissed)
  // Sections that were rewritten or replaced are gone, so these no longer count. Renamed chapters' progress has moved.
  const oldSections = useProgress((s) => Object.keys(s.completed).filter((key) => !sectionExists(key)).length)
  const oldCards = useFlashcards((s) => Object.keys(s.cards).filter((id) => !cardIds.has(id)).length)
  if (dismissed || (oldSections === 0 && oldCards === 0)) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED, '1')
    } catch {
      /* private mode: it shows again next visit */
    }
  }

  return (
    <section
      className="relative mt-10 rounded-xl border border-accent/40 bg-accent-soft/40 px-5 py-4 pr-12 text-[0.95rem] text-ink-2"
      aria-label="What changed"
    >
      <button
        type="button"
        onClick={dismiss}
        className="absolute top-3 right-3 rounded-md p-1.5 text-muted hover:bg-rule/50 hover:text-ink"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
      <p className="font-medium text-ink">This site is now the System Design Handbook.</p>
      <p className="mt-1">
        Every chapter has been written for the site, covering the same syllabus as The System Design Primer and more. Old links still work, and your
        notes and bookmarks have moved to the matching new sections.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {oldSections > 0 && (
          <li>
            {oldSections} {oldSections === 1 ? 'section' : 'sections'} you'd marked done {oldSections === 1 ? 'has' : 'have'} been rewritten or
            replaced, so {oldSections === 1 ? 'it no longer counts' : 'they no longer count'} toward your progress. Mark the new sections done as you
            read them.
          </li>
        )}
        {oldCards > 0 && (
          <li>
            Your review history for the primer's three Anki decks didn't carry over. The new{' '}
            <Link to="/flashcards" className="text-accent hover:underline">
              decks
            </Link>{' '}
            replace them.
          </li>
        )}
      </ul>
      <p className="mt-2">
        <Link to="/learn/about" className="text-accent hover:underline">
          About the handbook
        </Link>
      </p>
    </section>
  )
}
