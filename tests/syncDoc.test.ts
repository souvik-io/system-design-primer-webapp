import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyDoc, mergeDocs, parseDoc, sameDoc, type SyncDoc } from '../src/lib/syncDoc.ts'

const doc = (edit: (d: SyncDoc) => void) => {
  const d = emptyDoc()
  edit(d)
  return d
}
const card = (at: number, due = 0) => ({ due, interval: 1, ease: 2.5, reps: 1, lapses: 0, at })

/** Merges both ways round and checks the result doesn't depend on which copy is local. */
function merge(a: SyncDoc, b: SyncDoc) {
  const ab = mergeDocs(a, b)
  assert.ok(sameDoc(ab, mergeDocs(b, a)), 'merge should not depend on order')
  return ab
}

test('sections done on either device are kept', () => {
  const m = merge(
    doc((d) => (d.progress.completed.x = 1)),
    doc((d) => (d.progress.completed.y = 2)),
  )
  assert.deepEqual(Object.keys(m.progress.completed).sort(), ['x', 'y'])
})

test('the latest of marking done and not done wins', () => {
  let m = merge(
    doc((d) => (d.progress.completed.x = 1)),
    doc((d) => (d.progress.removed.x = 5)),
  )
  assert.equal(m.progress.completed.x, undefined)
  assert.equal(m.progress.removed.x, 5)

  m = merge(
    doc((d) => (d.progress.completed.x = 9)),
    doc((d) => (d.progress.removed.x = 5)),
  )
  assert.equal(m.progress.completed.x, 9)
  assert.equal(m.progress.removed.x, undefined)
})

test('clearing progress removes older sections and the last visited place', () => {
  const m = merge(
    doc((d) => {
      d.progress.completed = { a: 1, b: 20 }
      d.progress.removed = { c: 3 }
      d.progress.lastVisited = { chapterId: 'q', sectionId: 's', at: 4 }
    }),
    doc((d) => (d.progress.resetAt = 10)),
  )
  assert.deepEqual(m.progress.completed, { b: 20 })
  assert.deepEqual(m.progress.removed, {})
  assert.equal(m.progress.lastVisited, null)
  assert.equal(m.progress.resetAt, 10)
})

test('the most recent last visited place wins', () => {
  const m = merge(
    doc((d) => (d.progress.lastVisited = { chapterId: 'a', sectionId: 's', at: 1 })),
    doc((d) => (d.progress.lastVisited = { chapterId: 'b', sectionId: 's', at: 2 })),
  )
  assert.equal(m.progress.lastVisited?.chapterId, 'b')
})

test('the most recent card review wins, and resetting a deck beats older reviews', () => {
  let m = merge(
    doc((d) => (d.flashcards.cards.k = card(1, 100))),
    doc((d) => (d.flashcards.cards.k = card(2, 50))),
  )
  assert.equal(m.flashcards.cards.k.due, 50)

  m = merge(
    doc((d) => (d.flashcards.cards.k = card(1))),
    doc((d) => (d.flashcards.removedCards.k = 2)),
  )
  assert.equal(m.flashcards.cards.k, undefined)
  assert.equal(m.flashcards.removedCards.k, 2)

  m = merge(
    doc((d) => (d.flashcards.cards.k = card(3))),
    doc((d) => (d.flashcards.removedCards.k = 2)),
  )
  assert.ok(m.flashcards.cards.k)
  assert.equal(m.flashcards.removedCards.k, undefined)
})

test('cards reviewed before sync existed (no timestamp) are kept', () => {
  const legacy = { due: 7, interval: 1, ease: 2.5, reps: 1, lapses: 0 }
  const m = merge(
    doc((d) => (d.flashcards.cards.k = legacy)),
    emptyDoc(),
  )
  assert.equal(m.flashcards.cards.k.due, 7)
})

test('new cards started today: same day takes the larger count, a later day replaces it', () => {
  let m = merge(
    doc((d) => (d.flashcards.introduced = { day: '2026-10-12', byDeck: { a: 3, b: 1 } })),
    doc((d) => (d.flashcards.introduced = { day: '2026-10-12', byDeck: { a: 1, c: 2 } })),
  )
  assert.deepEqual(m.flashcards.introduced.byDeck, { a: 3, b: 1, c: 2 })

  m = merge(
    doc((d) => (d.flashcards.introduced = { day: '2026-10-13', byDeck: { a: 1 } })),
    doc((d) => (d.flashcards.introduced = { day: '2026-10-12', byDeck: { a: 9 } })),
  )
  assert.deepEqual(m.flashcards.introduced, { day: '2026-10-13', byDeck: { a: 1 } })
})

test('the most recent new-cards-per-day setting wins', () => {
  const m = merge(
    doc((d) => Object.assign(d.flashcards, { newPerDay: 20, newPerDayAt: 5 })),
    doc((d) => Object.assign(d.flashcards, { newPerDay: 50, newPerDayAt: 3 })),
  )
  assert.equal(m.flashcards.newPerDay, 20)
})

test('merging a copy with itself changes nothing', () => {
  const x = doc((d) => {
    d.progress.completed.x = 1
    d.flashcards.cards.k = card(1)
  })
  assert.ok(sameDoc(mergeDocs(x, x), x))
})

test('stored documents are filled in, and newer formats are refused', () => {
  assert.deepEqual(parseDoc({ v: 1, progress: { completed: { x: 1 } } }).progress, { ...emptyDoc().progress, completed: { x: 1 } })
  assert.ok(sameDoc(parseDoc(null), emptyDoc()))
  assert.deepEqual(parseDoc({ v: 1, progress: {} }).notes, emptyDoc().notes)
  assert.throws(() => parseDoc({ v: 3 }), /newer version/)
})

test('the latest edit to each note and bookmark wins, including deletions', () => {
  const m = merge(
    doc((d) => {
      d.notes.notes['a/x'] = { text: 'old', at: 1 }
      d.notes.notes['a/y'] = { text: '', at: 9 }
      d.notes.bookmarks['a/x'] = { on: true, at: 4 }
    }),
    doc((d) => {
      d.notes.notes['a/x'] = { text: 'new', at: 2 }
      d.notes.notes['a/y'] = { text: 'kept elsewhere', at: 3 }
      d.notes.notes['b/z'] = { text: 'only here', at: 1 }
      d.notes.bookmarks['a/x'] = { on: false, at: 6 }
    }),
  )
  assert.equal(m.notes.notes['a/x'].text, 'new')
  assert.equal(m.notes.notes['a/y'].text, '')
  assert.equal(m.notes.notes['b/z'].text, 'only here')
  assert.equal(m.notes.bookmarks['a/x'].on, false)
})

test('the most recent study plan choice wins, and stopping a plan counts as a choice', () => {
  const started = doc((d) => (d.plan = { plan: { id: 'short', start: '2026-10-01', target: '2026-10-14' }, planAt: 5 }))
  const stopped = doc((d) => (d.plan = { plan: null, planAt: 8 }))
  assert.equal(merge(started, stopped).plan.plan, null)
  assert.equal(merge(started, emptyDoc()).plan.plan?.id, 'short')
})
