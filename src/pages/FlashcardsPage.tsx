import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { decks as allDecks, useVisibleDecks, type DeckMeta } from '../lib/content'
import { ExtrasSwitch } from '../components/ExtrasToggle'
import { formatWait, useDeckStats, useFlashcards } from '../lib/flashcards'
import { useAccount } from '../lib/account'

const NEW_PER_DAY_OPTIONS = [5, 10, 20, 50]

export function FlashcardsPage() {
  const newPerDay = useFlashcards((s) => s.newPerDay)
  const setNewPerDay = useFlashcards((s) => s.setNewPerDay)
  const signedIn = useAccount((s) => Boolean(s.email))
  const decks = useVisibleDecks()
  const groups = [
    { title: 'From the primer', note: "The primer's own Anki decks: one card per topic or question.", decks: decks.filter((d) => !d.site) },
    {
      title: 'Written for this site',
      note: 'One question per card, covering every chapter in more detail, the 101 chapters included. Each card links to where its answer is taught.',
      decks: decks.filter((d) => d.site),
    },
  ].filter((g) => g.decks.length)
  const hiddenExtras = allDecks.filter((d) => d.extra).length - decks.filter((d) => d.extra).length

  useEffect(() => {
    document.title = 'Flashcards | System Design Primer'
    window.scrollTo(0, 0)
  }, [])

  return (
    <div className="mx-auto max-w-3xl px-4 pt-10 pb-16 sm:px-8 lg:pt-14">
      <h1 className="text-[2rem] leading-tight font-semibold tracking-tight text-ink sm:text-[2.5rem]">Flashcards</h1>
      <p className="mt-3 max-w-2xl font-serif text-lg leading-relaxed text-ink-2">
        Spaced repetition over the whole course. Answer from memory, reveal the card, then rate how well you knew it. Cards you find hard come
        back sooner.
      </p>

      {groups.map((g) => (
        <section key={g.title} className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight text-ink">{g.title}</h2>
          <p className="mt-0.5 text-sm text-muted">{g.note}</p>
          <ul className="mt-4 divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
            {g.decks.map((d) => (
              <DeckRow key={d.id} deck={d} />
            ))}
          </ul>
        </section>
      ))}

      {hiddenExtras > 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-rule px-5 py-4 text-sm text-muted">
          <p>
            {hiddenExtras} more {hiddenExtras === 1 ? 'deck covers' : 'decks cover'} the extra chapters beyond the primer. Turn them on to see{' '}
            {hiddenExtras === 1 ? 'it' : 'them'}.
          </p>
          <ExtrasSwitch className="mt-3" />
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-muted">
        <label htmlFor="new-per-day">New cards per deck each day</label>
        <select
          id="new-per-day"
          value={newPerDay}
          onChange={(e) => setNewPerDay(Number(e.target.value))}
          className="rounded-md border border-rule bg-surface px-2 py-1 text-ink"
        >
          {NEW_PER_DAY_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-2 text-sm text-muted">
        {signedIn ? 'Your review history syncs to your account.' : 'Your review history is saved in this browser.'}
      </p>
    </div>
  )
}

function DeckRow({ deck }: { deck: DeckMeta }) {
  const stats = useDeckStats(deck)
  const resetDeck = useFlashcards((s) => s.resetDeck)
  const [confirming, setConfirming] = useState(false)
  const toStudy = stats.due + stats.newToday

  return (
    <li className="p-5">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="text-lg font-semibold text-ink">{deck.title}</h3>
          <p className="mt-0.5 text-sm text-muted">{deck.description}</p>
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <Stat label="Due" value={stats.due} highlight={stats.due > 0} />
            <Stat label="New today" value={stats.newToday} />
            <Stat label="Learned" value={`${stats.learned} of ${stats.total}`} />
          </dl>
          <div className="mt-3 h-1 max-w-sm overflow-hidden rounded-full bg-rule" aria-hidden>
            <div className="h-full rounded-full bg-done" style={{ width: `${(stats.learned / stats.total) * 100}%` }} />
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          {toStudy > 0 ? (
            <Link
              to={`/flashcards/${deck.id}`}
              className="rounded-lg bg-accent px-4 py-2 text-center text-sm font-medium text-on-accent hover:opacity-90"
            >
              Study {toStudy} {toStudy === 1 ? 'card' : 'cards'}
            </Link>
          ) : (
            <span className="rounded-lg border border-rule px-4 py-2 text-center text-sm text-muted">
              {stats.nextDue ? `Next review in ${formatWait(stats.nextDue - Date.now())}` : 'All caught up'}
            </span>
          )}
          <Link to={`/flashcards/${deck.id}/browse`} className="text-center text-sm text-accent hover:underline sm:text-right">
            Browse all {stats.total} cards
          </Link>
        </div>
      </div>

      {stats.total - stats.unseen > 0 && (
        <div className="mt-4 text-sm text-muted">
          {confirming ? (
            <span className="flex flex-wrap items-center gap-3">
              Forget your history for this deck?
              <button
                type="button"
                className="rounded-md border border-rule px-2.5 py-1 font-medium text-ink hover:border-red-500 hover:text-red-600"
                onClick={() => {
                  resetDeck(deck)
                  setConfirming(false)
                }}
              >
                Reset deck
              </button>
              <button type="button" className="hover:text-ink" onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </span>
          ) : (
            <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => setConfirming(true)}>
              Reset deck
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function Stat({ label, value, highlight }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className={highlight ? 'font-semibold text-accent' : 'font-medium text-ink'}>{value}</dd>
    </div>
  )
}
