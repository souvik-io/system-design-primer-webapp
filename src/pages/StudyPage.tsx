import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import clsx from 'clsx'
import { ArrowLeft, BookOpen, Check } from 'lucide-react'
import { deckById, loadDeck, redirects, type Card, type Deck, type DeckMeta } from '../lib/content'
import { deckStats, formatWait, RATINGS, schedule, useFlashcards, type Rating } from '../lib/flashcards'
import { useArticleClicks } from '../components/useArticleClicks'
import { NotFound } from './NotFound'

/** What to do before revealing the answer, per deck. */
const PROMPTS: Record<string, string> = {
  topics: 'Explain it out loud: what it is, how it works, and its trade-offs.',
  'design-walkthroughs': 'Talk through a design: use cases and constraints, high-level design, core components, then scaling.',
  'object-oriented': 'Sketch the classes, what each is responsible for, and how they relate.',
}
// The other decks ask one specific question per card.
const SITE_PROMPT = 'Answer out loud or in your head, then check.'

const RATING_LABEL: Record<Rating, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' }

// Cards due again within this window come back in the same session.
const REQUEUE_WITHIN = 20 * 60_000

function useDeck(id: string) {
  const [deck, setDeck] = useState<Deck | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadDeck(id).then(setDeck, (e: Error) => setError(e.message))
  }, [id])
  return { deck, error }
}

export function StudyPage() {
  const { deckId = '' } = useParams()
  const meta = deckById.get(deckId)
  if (!meta) return redirects.decks[deckId] ? <Navigate to={`/flashcards/${redirects.decks[deckId]}`} replace /> : <NotFound />
  return <Study key={meta.id} meta={meta} />
}

function Study({ meta }: { meta: DeckMeta }) {
  const { deck, error } = useDeck(meta.id)
  const rate = useFlashcards((s) => s.rate)
  const cards = useFlashcards((s) => s.cards)
  const [queue, setQueue] = useState<string[] | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [reviewed, setReviewed] = useState(0)
  const { onClick, zoom } = useArticleClicks()

  useEffect(() => {
    document.title = `${meta.title} | Flashcards`
  }, [meta])

  /** Due cards first (oldest first), then today's new cards in deck order. */
  const buildQueue = useCallback(
    (extraNew = 0) => {
      const s = useFlashcards.getState()
      const stats = deckStats(meta, s.cards, s.introduced, s.newPerDay)
      const now = Date.now()
      const due = meta.cardIds.filter((id) => s.cards[id] && s.cards[id].due <= now).sort((a, b) => s.cards[a].due - s.cards[b].due)
      const fresh = meta.cardIds.filter((id) => !s.cards[id]).slice(0, stats.newToday + extraNew)
      return [...due, ...fresh]
    },
    [meta],
  )

  useEffect(() => {
    if (deck && queue === null) setQueue(buildQueue())
  }, [deck, queue, buildQueue])

  const byId = useMemo(() => new Map(deck?.cards.map((c) => [c.id, c])), [deck])
  const card = queue?.length ? byId.get(queue[0]) : undefined

  const answer = useCallback(
    (rating: Rating) => {
      if (!card) return
      const next = rate(meta.id, card.id, rating)
      setQueue((q) => {
        const rest = (q ?? []).slice(1)
        return next.due - Date.now() < REQUEUE_WITHIN ? [...rest, card.id] : rest
      })
      setRevealed(false)
      setReviewed((n) => n + 1)
      window.scrollTo(0, 0)
    },
    [card, meta.id, rate],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof HTMLElement && e.target.closest('input, select, textarea'))) return
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        // Leave other links and buttons alone; the reveal button itself is handled here.
        if (e.target instanceof HTMLElement && e.target.closest('a, button:not([data-reveal])')) return
        e.preventDefault()
        setRevealed(true)
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        answer(RATINGS[Number(e.key) - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [revealed, answer])

  const counts = useMemo(() => {
    const ids = new Set(queue ?? [])
    let fresh = 0
    let learning = 0
    let review = 0
    for (const id of ids) {
      const c = cards[id]
      if (!c) fresh++
      else if (c.reps === 0) learning++
      else review++
    }
    return { fresh, learning, review }
  }, [queue, cards])

  return (
    <div className="mx-auto max-w-3xl px-4 pt-8 pb-40 sm:px-8 lg:pt-12">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link to="/flashcards" className="flex items-center gap-1.5 text-sm text-muted hover:text-ink">
          <ArrowLeft size={14} /> All decks
        </Link>
        {queue && queue.length > 0 && (
          <div className="ml-auto flex gap-3 text-sm tabular-nums" aria-label="Cards left in this session">
            <span className="text-accent">{counts.fresh} new</span>
            <span className="text-red-600 dark:text-red-400">{counts.learning} learning</span>
            <span className="text-done">{counts.review} review</span>
          </div>
        )}
      </div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">{meta.title}</h1>

      {error ? (
        <p className="mt-8 rounded-lg border border-rule bg-surface p-6 text-sm text-muted">
          This deck didn't load. {error} Reload the page to try again.
        </p>
      ) : !deck || queue === null ? (
        <div className="mt-8 h-48 animate-pulse rounded-xl bg-rule/60" aria-label="Loading deck" />
      ) : card ? (
        <CardView
          key={card.id + reviewed}
          card={card}
          prompt={PROMPTS[meta.id] ?? SITE_PROMPT}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          onAnswer={answer}
          onArticleClick={onClick}
        />
      ) : (
        <SessionDone meta={meta} reviewed={reviewed} onMore={(n) => setQueue(buildQueue(n))} />
      )}
      {zoom}
    </div>
  )
}

function CardView({
  card,
  prompt,
  revealed,
  onReveal,
  onAnswer,
  onArticleClick,
}: {
  card: Card
  prompt: string
  revealed: boolean
  onReveal: () => void
  onAnswer: (r: Rating) => void
  onArticleClick: (e: React.MouseEvent) => void
}) {
  const state = useFlashcards((s) => s.cards[card.id])
  const now = Date.now()

  return (
    <>
      <section className="mt-6 rounded-2xl border border-rule bg-surface px-6 py-10 text-center sm:px-10 sm:py-14" aria-live="polite">
        <p className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink sm:text-[2.25rem]">{card.front}</p>
        <p className="mx-auto mt-4 max-w-md text-sm text-muted">{prompt}</p>
      </section>

      {revealed ? (
        <>
          <section className="mt-6 rounded-2xl border border-rule bg-surface px-5 py-7 sm:px-8" onClick={onArticleClick}>
            <div className="article mx-auto" dangerouslySetInnerHTML={{ __html: card.back }} />
            {card.href && (
              <Link to={card.href} className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline">
                <BookOpen size={16} /> Read this in the course
              </Link>
            )}
          </section>

          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-paper/95 px-4 py-3 backdrop-blur lg:left-72">
            <div className="mx-auto grid max-w-3xl grid-cols-4 gap-2">
              {RATINGS.map((r, i) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onAnswer(r)}
                  className={clsx(
                    'flex flex-col items-center rounded-lg border px-2 py-2 text-sm font-medium transition-colors',
                    r === 'again' && 'border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-300',
                    r === 'hard' && 'border-rule text-ink hover:bg-rule/50',
                    r === 'good' && 'border-done/50 text-done hover:bg-done-soft',
                    r === 'easy' && 'border-accent/50 text-accent hover:bg-accent-soft',
                  )}
                >
                  <span>{RATING_LABEL[r]}</span>
                  <span className="text-xs font-normal opacity-75">
                    {formatWait(schedule(state, r, now).due - now)}
                    <kbd className="ml-2 hidden rounded border border-current/30 px-1 font-mono text-[0.65rem] sm:inline">{i + 1}</kbd>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={onReveal}
            autoFocus
            data-reveal
            className="rounded-lg bg-accent px-6 py-3 text-sm font-medium text-on-accent hover:opacity-90"
          >
            Show answer <kbd className="ml-2 font-mono text-xs opacity-75">Space</kbd>
          </button>
        </div>
      )}
    </>
  )
}

function SessionDone({ meta, reviewed, onMore }: { meta: DeckMeta; reviewed: number; onMore: (extraNew: number) => void }) {
  const cards = useFlashcards((s) => s.cards)
  const introduced = useFlashcards((s) => s.introduced)
  const newPerDay = useFlashcards((s) => s.newPerDay)
  const stats = deckStats(meta, cards, introduced, newPerDay)

  return (
    <section className="mt-6 rounded-2xl border border-rule bg-surface px-6 py-12 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-full bg-done-soft text-done">
        <Check size={24} strokeWidth={3} />
      </span>
      <h2 className="mt-4 text-xl font-semibold text-ink">{reviewed > 0 ? 'Session complete' : 'Nothing to study right now'}</h2>
      <p className="mt-2 text-muted">
        {reviewed > 0 && `You answered ${reviewed} ${reviewed === 1 ? 'card' : 'cards'}. `}
        {stats.nextDue
          ? `The next card is due in ${formatWait(stats.nextDue - Date.now())}.`
          : stats.unseen === 0
            ? 'You have seen every card in this deck.'
            : ''}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        {stats.unseen > 0 && (
          <button
            type="button"
            onClick={() => onMore(Math.min(stats.unseen, newPerDay))}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:opacity-90"
          >
            Learn {Math.min(stats.unseen, newPerDay)} more new cards
          </button>
        )}
        <Link to="/flashcards" className="rounded-lg border border-rule px-4 py-2 text-sm font-medium text-ink hover:border-muted/50">
          Back to all decks
        </Link>
      </div>
    </section>
  )
}

export function BrowsePage() {
  const { deckId = '' } = useParams()
  const meta = deckById.get(deckId)
  if (!meta) return redirects.decks[deckId] ? <Navigate to={`/flashcards/${redirects.decks[deckId]}/browse`} replace /> : <NotFound />
  return <Browse key={meta.id} meta={meta} />
}

function Browse({ meta }: { meta: DeckMeta }) {
  const { deck, error } = useDeck(meta.id)
  const cards = useFlashcards((s) => s.cards)
  const { onClick, zoom } = useArticleClicks()

  useEffect(() => {
    document.title = `${meta.title} | Flashcards`
    window.scrollTo(0, 0)
  }, [meta])

  return (
    <div className="mx-auto max-w-3xl px-4 pt-8 pb-16 sm:px-8 lg:pt-12">
      <Link to="/flashcards" className="flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft size={14} /> All decks
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">{meta.title}</h1>
      <p className="mt-1 text-muted">All {meta.cardIds.length} cards. Open one to read its answer.</p>

      {error ? (
        <p className="mt-8 rounded-lg border border-rule bg-surface p-6 text-sm text-muted">
          This deck didn't load. {error} Reload the page to try again.
        </p>
      ) : !deck ? (
        <div className="mt-8 h-48 animate-pulse rounded-xl bg-rule/60" aria-label="Loading deck" />
      ) : (
        <ol className="mt-6 divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
          {deck.cards.map((c) => {
            const s = cards[c.id]
            const status = !s ? 'New' : s.due <= Date.now() ? 'Due now' : `Due in ${formatWait(s.due - Date.now())}`
            return (
              <li key={c.id}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5 hover:bg-accent-soft/40">
                    <span className="flex-1 font-medium text-ink">{c.front}</span>
                    <span className={clsx('text-sm', !s ? 'text-accent' : s.due <= Date.now() ? 'text-red-600 dark:text-red-400' : 'text-muted')}>
                      {status}
                    </span>
                  </summary>
                  <div className="border-t border-rule px-5 py-6" onClick={onClick}>
                    <div className="article" dangerouslySetInnerHTML={{ __html: c.back }} />
                    {c.href && (
                      <Link to={c.href} className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline">
                        <BookOpen size={16} /> Read this in the course
                      </Link>
                    )}
                  </div>
                </details>
              </li>
            )
          })}
        </ol>
      )}
      {zoom}
    </div>
  )
}
