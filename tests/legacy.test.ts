import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateNotes, migrateProgress, movedChapterUrl, movedSectionKey, type Redirects } from '../src/lib/legacy.ts'

const r: Redirects = {
  renamed: { 'cache-101': 'cache' },
  replaced: { database: 'relational-databases', 'study-guide': 'how-to-use-this-handbook#pick-a-study-plan' },
  anchors: {
    'database#master-slave-replication': 'relational-databases#primary-replica-replication',
    'database#key-value-store': 'nosql-databases#key-value-stores',
    'about#anki-flashcards': 'about#flashcards',
  },
  sections: {
    'database/overview': 'relational-databases/overview',
    'database/master-slave-replication': 'relational-databases/replication-copies-of-the-whole-database',
    'database/key-value-store': 'nosql-databases/key-value-stores',
  },
  decks: { ood: 'object-oriented' },
}
const chapters = new Set(['cache', 'relational-databases', 'nosql-databases', 'how-to-use-this-handbook', 'about'])
const exists = (id: string) => chapters.has(id)
const sections = new Set([
  'cache/overview',
  'cache/cache-aside',
  'relational-databases/overview',
  'relational-databases/replication-copies-of-the-whole-database',
  'nosql-databases/key-value-stores',
])
const sectionExists = (key: string) => sections.has(key)

test('a renamed chapter keeps its heading', () => {
  assert.deepEqual(movedChapterUrl(r, 'cache-101', '', '#cache-aside', exists), { url: '/learn/cache#cache-aside' })
})

test("a replaced chapter's heading goes where it moved, even to another chapter", () => {
  assert.deepEqual(movedChapterUrl(r, 'database', '', '#key-value-store', exists), { url: '/learn/nosql-databases#key-value-stores' })
  assert.deepEqual(movedChapterUrl(r, 'database', '', '#unknown', exists), { url: '/learn/relational-databases' })
  assert.deepEqual(movedChapterUrl(r, 'study-guide', '', '', exists), { url: '/learn/how-to-use-this-handbook#pick-a-study-plan' })
})

test("the server redirect's ?from= finds the old heading", () => {
  assert.deepEqual(movedChapterUrl(r, 'relational-databases', '?from=database', '#master-slave-replication', exists), {
    url: '/learn/relational-databases#primary-replica-replication',
  })
})

test('current chapters stay put, except a moved heading the page lacks', () => {
  assert.equal(movedChapterUrl(r, 'cache', '', '#cache-aside', exists), null)
  assert.deepEqual(movedChapterUrl(r, 'about', '', '#anki-flashcards', exists), { url: '/learn/about#flashcards', ifMissing: 'anki-flashcards' })
})

test('section keys move to the section holding the heading', () => {
  assert.equal(movedSectionKey(r, 'database/master-slave-replication', sectionExists), 'relational-databases/replication-copies-of-the-whole-database')
  assert.equal(movedSectionKey(r, 'database/sql-tuning', sectionExists), 'relational-databases/overview')
  assert.equal(movedSectionKey(r, 'cache-101/cache-aside', sectionExists), 'cache/cache-aside')
  assert.equal(movedSectionKey(r, 'cache-101/gone', sectionExists), 'cache/overview')
  assert.equal(movedSectionKey(r, 'cache/cache-aside', sectionExists), null)
})

test('progress follows renamed chapters only', () => {
  const p = migrateProgress(r, {
    completed: { 'cache-101/cache-aside': 5, 'database/master-slave-replication': 6 },
    removed: {},
    resetAt: 0,
    lastVisited: { chapterId: 'database', sectionId: 'master-slave-replication', at: 7 },
  })
  assert.deepEqual(p.completed, { 'cache/cache-aside': 5, 'database/master-slave-replication': 6 })
  assert.deepEqual(p.lastVisited, { chapterId: 'relational-databases', sectionId: 'overview', at: 7 })
  assert.deepEqual(migrateProgress(r, p), p, 'running it twice changes nothing')
})

test('notes move, and two notes landing on one section are joined', () => {
  const n = migrateNotes(
    r,
    {
      notes: {
        'database/overview': { text: 'first', at: 1 },
        'database/sql-tuning': { text: 'second', at: 2 },
        'cache/cache-aside': { text: 'kept', at: 3 },
      },
      bookmarks: { 'database/key-value-store': { on: true, at: 4 } },
    },
    sectionExists,
  )
  assert.deepEqual(n.notes, {
    'relational-databases/overview': { text: 'first\n\nsecond', at: 2 },
    'cache/cache-aside': { text: 'kept', at: 3 },
  })
  assert.deepEqual(n.bookmarks, { 'nosql-databases/key-value-stores': { on: true, at: 4 } })
  assert.deepEqual(migrateNotes(r, n, sectionExists), n, 'running it twice changes nothing')
})
