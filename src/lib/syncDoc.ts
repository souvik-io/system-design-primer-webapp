import type { ProgressData } from './progress'
import type { CardState, FlashcardData } from './flashcards'
import type { NotesData } from './notes'
import type { PlanData } from './plans'

// Everything that syncs to an account, as one JSON document. Two copies (this browser and the
// account) are merged item by item, and the most recent change to each item wins. Removals are
// kept as timestamps too, so un-marking a section or resetting a deck isn't undone by an older copy.

// Version 2 added notes, bookmarks and the study plan. Older code refuses version 2 documents
// instead of saving over them without those parts.

export type SyncDoc = { v: 2; progress: ProgressData; flashcards: FlashcardData; notes: NotesData; plan: PlanData }

export const SYNC_VERSION = 2

export function emptyDoc(): SyncDoc {
  return {
    v: SYNC_VERSION,
    progress: { completed: {}, removed: {}, resetAt: 0, lastVisited: null },
    flashcards: { cards: {}, removedCards: {}, introduced: { day: '', byDeck: {} }, newPerDay: 10, newPerDayAt: 0 },
    notes: { notes: {}, bookmarks: {} },
    plan: { plan: null, planAt: 0 },
  }
}

/** Reads a stored document, filling in anything missing. Throws for a newer format this code can't merge safely. */
export function parseDoc(data: unknown): SyncDoc {
  const empty = emptyDoc()
  if (!data || typeof data !== 'object') return empty
  const d = data as Partial<SyncDoc>
  if (typeof d.v === 'number' && d.v > SYNC_VERSION) throw new Error('Your progress was saved by a newer version of this site. Reload the page.')
  return {
    v: SYNC_VERSION,
    progress: { ...empty.progress, ...d.progress },
    flashcards: { ...empty.flashcards, ...d.flashcards },
    notes: { ...empty.notes, ...d.notes },
    plan: { ...empty.plan, ...d.plan },
  }
}

export function mergeDocs(a: SyncDoc, b: SyncDoc): SyncDoc {
  return {
    v: SYNC_VERSION,
    progress: mergeProgress(a.progress, b.progress),
    flashcards: mergeFlashcards(a.flashcards, b.flashcards),
    notes: { notes: latestEach(a.notes.notes, b.notes.notes), bookmarks: latestEach(a.notes.bookmarks, b.notes.bookmarks) },
    plan: pick(a.plan, b.plan, a.plan.planAt, b.plan.planAt),
  }
}

/** Per key, the entry changed most recently. Ties go to the larger JSON so both orders agree. */
function latestEach<T extends { at: number }>(a: Record<string, T>, b: Record<string, T>) {
  const out: Record<string, T> = {}
  for (const key of keysOf(a, b)) {
    const [x, y] = [a[key], b[key]]
    out[key] = x && y ? pick(x, y, x.at, y.at) : (x ?? y)
  }
  return out
}

function pick<T>(a: T, b: T, atA: number, atB: number): T {
  if (atA !== atB) return atA > atB ? a : b
  return stableJson(a) >= stableJson(b) ? a : b
}

function mergeProgress(a: ProgressData, b: ProgressData): ProgressData {
  const resetAt = Math.max(a.resetAt, b.resetAt)
  const completed: Record<string, number> = {}
  const removed: Record<string, number> = {}
  for (const key of keysOf(a.completed, b.completed, a.removed, b.removed)) {
    const doneAt = Math.max(a.completed[key] ?? 0, b.completed[key] ?? 0)
    const removedAt = Math.max(a.removed[key] ?? 0, b.removed[key] ?? 0)
    if (doneAt > Math.max(removedAt, resetAt)) completed[key] = doneAt
    else if (removedAt > resetAt) removed[key] = removedAt
  }
  const latest = !a.lastVisited ? b.lastVisited : !b.lastVisited ? a.lastVisited : b.lastVisited.at > a.lastVisited.at ? b.lastVisited : a.lastVisited
  return { completed, removed, resetAt, lastVisited: latest && latest.at > resetAt ? latest : null }
}

function mergeFlashcards(a: FlashcardData, b: FlashcardData): FlashcardData {
  const cards: Record<string, CardState> = {}
  const removedCards: Record<string, number> = {}
  for (const id of keysOf(a.cards, b.cards, a.removedCards, b.removedCards)) {
    const card = newerCard(a.cards[id], b.cards[id])
    const removedAt = Math.max(a.removedCards[id] ?? 0, b.removedCards[id] ?? 0)
    if (card && (card.at ?? 0) >= removedAt) cards[id] = card
    else if (removedAt) removedCards[id] = removedAt
  }

  // New cards started today: the later day wins, and on the same day take the larger count per deck.
  let introduced = a.introduced.day >= b.introduced.day ? a.introduced : b.introduced
  if (a.introduced.day === b.introduced.day) {
    const byDeck = { ...a.introduced.byDeck }
    for (const [deck, n] of Object.entries(b.introduced.byDeck)) byDeck[deck] = Math.max(byDeck[deck] ?? 0, n)
    introduced = { day: a.introduced.day, byDeck }
  }

  const setting = b.newPerDayAt > a.newPerDayAt ? b : a
  return { cards, removedCards, introduced, newPerDay: setting.newPerDay, newPerDayAt: setting.newPerDayAt }
}

function newerCard(a: CardState | undefined, b: CardState | undefined) {
  if (!a || !b) return a ?? b
  const atA = a.at ?? 0
  const atB = b.at ?? 0
  if (atA !== atB) return atA > atB ? a : b
  return b.due > a.due ? b : a
}

function keysOf(...maps: Record<string, unknown>[]) {
  const keys = new Set<string>()
  for (const m of maps) for (const k of Object.keys(m)) keys.add(k)
  return keys
}

/** Compares two documents regardless of key order. */
export function sameDoc(a: SyncDoc, b: SyncDoc) {
  return stableJson(a) === stableJson(b)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
}
