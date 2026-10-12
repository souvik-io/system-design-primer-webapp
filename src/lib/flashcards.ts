import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DeckMeta } from './content'

// A small SM-2 style scheduler, close to how Anki behaves:
// new cards go through short learning steps, then intervals grow by the card's ease.

export type Rating = 'again' | 'hard' | 'good' | 'easy'
export const RATINGS: Rating[] = ['again', 'hard', 'good', 'easy']

export type CardState = {
  /** Timestamp (ms) when the card is next due */
  due: number
  /** Current interval in days; 0 while still learning */
  interval: number
  ease: number
  /** Successful reviews in a row */
  reps: number
  lapses: number
}

const MINUTE = 60_000
const DAY = 86_400_000
const START_EASE = 2.5
const MIN_EASE = 1.3

export function schedule(prev: CardState | undefined, rating: Rating, now: number): CardState {
  const s = prev ?? { due: now, interval: 0, ease: START_EASE, reps: 0, lapses: 0 }
  const learning = s.reps === 0

  switch (rating) {
    case 'again':
      return { ...s, interval: 0, reps: 0, ease: Math.max(MIN_EASE, s.ease - 0.2), lapses: s.lapses + (learning ? 0 : 1), due: now + MINUTE }
    case 'hard': {
      if (learning) return { ...s, due: now + 10 * MINUTE }
      const interval = Math.max(s.interval + 1, Math.round(s.interval * 1.2))
      return { ...s, interval, reps: s.reps + 1, ease: Math.max(MIN_EASE, s.ease - 0.15), due: now + interval * DAY }
    }
    case 'good': {
      const interval = learning ? 1 : s.reps === 1 ? Math.max(3, s.interval + 1) : Math.max(s.interval + 1, Math.round(s.interval * s.ease))
      return { ...s, interval, reps: s.reps + 1, due: now + interval * DAY }
    }
    case 'easy': {
      const interval = learning ? 4 : Math.max(s.interval + 2, Math.round(s.interval * s.ease * 1.3))
      return { ...s, interval, reps: s.reps + 1, ease: s.ease + 0.15, due: now + interval * DAY }
    }
  }
}

/** Short label for when a card would next be shown, e.g. "<1m", "10m", "3d", "2mo". */
export function formatWait(ms: number) {
  const min = Math.round(ms / MINUTE)
  if (min < 1) return '<1m'
  if (min < 60) return `${min}m`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(ms / DAY)
  if (days < 30) return `${days}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')}y`
}

const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time

type FlashcardState = {
  cards: Record<string, CardState>
  /** New cards started per deck, for the current day only */
  introduced: { day: string; byDeck: Record<string, number> }
  newPerDay: number
  rate: (deckId: string, cardId: string, rating: Rating) => CardState
  setNewPerDay: (n: number) => void
  resetDeck: (deck: DeckMeta) => void
}

export const useFlashcards = create<FlashcardState>()(
  persist(
    (set, get) => ({
      cards: {},
      introduced: { day: today(), byDeck: {} },
      newPerDay: 10,
      rate: (deckId, cardId, rating) => {
        const prev = get().cards[cardId]
        const next = schedule(prev, rating, Date.now())
        set((s) => {
          const introduced = s.introduced.day === today() ? s.introduced : { day: today(), byDeck: {} }
          return {
            cards: { ...s.cards, [cardId]: next },
            introduced: prev ? introduced : { ...introduced, byDeck: { ...introduced.byDeck, [deckId]: (introduced.byDeck[deckId] ?? 0) + 1 } },
          }
        })
        return next
      },
      setNewPerDay: (n) => set({ newPerDay: n }),
      resetDeck: (deck) =>
        set((s) => {
          const cards = { ...s.cards }
          for (const id of deck.cardIds) delete cards[id]
          return { cards, introduced: { ...s.introduced, byDeck: { ...s.introduced.byDeck, [deck.id]: 0 } } }
        }),
    }),
    { name: 'sdp-flashcards', version: 1 },
  ),
)

export type DeckStats = {
  total: number
  /** Cards seen at least once and not currently failed */
  learned: number
  /** Seen cards due now */
  due: number
  /** New cards still allowed today */
  newToday: number
  /** New cards never seen */
  unseen: number
  /** When the next not-yet-due card comes up */
  nextDue: number | null
}

export function deckStats(
  deck: DeckMeta,
  cards: Record<string, CardState>,
  introduced: FlashcardState['introduced'],
  newPerDay: number,
  now = Date.now(),
): DeckStats {
  let learned = 0
  let due = 0
  let unseen = 0
  let nextDue: number | null = null
  for (const id of deck.cardIds) {
    const c = cards[id]
    if (!c) {
      unseen++
      continue
    }
    if (c.reps > 0) learned++
    if (c.due <= now) due++
    else if (nextDue === null || c.due < nextDue) nextDue = c.due
  }
  const usedToday = introduced.day === today() ? (introduced.byDeck[deck.id] ?? 0) : 0
  return { total: deck.cardIds.length, learned, due, unseen, newToday: Math.min(unseen, Math.max(0, newPerDay - usedToday)), nextDue }
}

export function useDeckStats(deck: DeckMeta) {
  const cards = useFlashcards((s) => s.cards)
  const introduced = useFlashcards((s) => s.introduced)
  const newPerDay = useFlashcards((s) => s.newPerDay)
  return deckStats(deck, cards, introduced, newPerDay)
}

/** Reviews due now across every deck (new cards not included). */
export function useDueCount(deckList: DeckMeta[]) {
  const cards = useFlashcards((s) => s.cards)
  const now = Date.now()
  let due = 0
  for (const d of deckList) for (const id of d.cardIds) if (cards[id] && cards[id].due <= now) due++
  return due
}
