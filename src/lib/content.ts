import manifestJson from '../generated/manifest.json'
import type { Redirects } from './legacy'

export type SectionMeta = { id: string; title: string }
export type ChapterMeta = {
  id: string
  title: string
  summary: string
  minutes: number
  sections: SectionMeta[]
  /** Reference material that doesn't count toward progress */
  untracked?: boolean
}
export type HandbookId = 'system-design' | 'infra'
export type Part = {
  id: string
  handbook: HandbookId
  title: string
  description: string
  chapters: ChapterMeta[]
  untracked?: boolean
}

export type Heading = { id: string; title: string; depth: number }
export type Section = SectionMeta & { html: string; headings: Heading[] }
export type Chapter = { id: string; title: string; sections: Section[] }

export type DeckMeta = {
  id: string
  handbook: HandbookId
  title: string
  description: string
  cardIds: string[]
}
export type Card = { id: string; front: string; back: string; href?: string }
export type Deck = { id: string; title: string; cards: Card[] }

export const parts: Part[] = (manifestJson.parts as Part[]).filter((p) => p.chapters.length > 0)

/** The site holds two courses. Each has its own home page, sidebar, progress and chapter order. */
export const HANDBOOKS: Record<HandbookId, { title: string; short: string; home: string; description: string }> = {
  'system-design': {
    title: 'System Design Handbook',
    short: 'System design',
    home: '/',
    description: 'A free course in designing large-scale systems, from the interview method to databases, caches and worked designs.',
  },
  infra: {
    title: 'AI Infrastructure Engineer Handbook',
    short: 'AI infrastructure',
    home: '/infra',
    description:
      'Inference from kernels to clusters: how models run on GPUs, how serving engines schedule them, and how to make them fast and cheap. Each chapter has a lab.',
  },
}

export const partsOf = (handbook: HandbookId) => parts.filter((p) => p.handbook === handbook)
export const decks = manifestJson.decks as DeckMeta[]
export const deckById = new Map(decks.map((d) => [d.id, d]))
export const redirects: Redirects = manifestJson.redirects

export const chapters: (ChapterMeta & { part: Part })[] = parts.flatMap((part) => part.chapters.map((c) => ({ ...c, part })))
export const chaptersOf = (handbook: HandbookId) => chapters.filter((c) => c.part.handbook === handbook)

export const chapterById = new Map(chapters.map((c) => [c.id, c]))

/** Chapters that count toward a handbook's progress */
export const trackedChaptersOf = (handbook: HandbookId) => chaptersOf(handbook).filter((c) => !c.untracked)

const sectionKeys = new Set(chapters.flatMap((c) => c.sections.map((s) => sectionKey(c.id, s.id))))
export const sectionExists = (key: string) => sectionKeys.has(key)

export function sectionKey(chapterId: string, sectionId: string) {
  return `${chapterId}/${sectionId}`
}

/** URL for a section. The overview has no heading of its own, so it links to the chapter top. */
export function sectionHref(chapterId: string, sectionId: string) {
  return sectionId === 'overview' ? `/learn/${chapterId}` : `/learn/${chapterId}#${sectionId}`
}

const cache = new Map<string, Promise<unknown>>()

function loadJson<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Couldn't load ${url} (HTTP ${r.status}).`)
      return r.json() as Promise<T>
    })
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

export const loadChapter = (id: string) => loadJson<Chapter>(`/content/${id}.json`)
export const loadDeck = (id: string) => loadJson<Deck>(`/content/flashcards/${id}.json`)
