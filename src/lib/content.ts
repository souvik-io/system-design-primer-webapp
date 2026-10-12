import { useSettings } from './settings'
import manifestJson from '../generated/manifest.json'

export type SectionMeta = { id: string; title: string }
export type ChapterMeta = {
  id: string
  title: string
  summary: string
  minutes: number
  sections: SectionMeta[]
  /** The README's wording of this question, when it differs from the title */
  alsoAsked?: string
  /** Reference material that doesn't count toward progress */
  untracked?: boolean
  /** Written for this site, not part of the primer. Hidden unless the reader turns extra chapters on. */
  extra?: boolean
}
export type Part = {
  id: string
  title: string
  description: string
  chapters: ChapterMeta[]
  untracked?: boolean
  extra?: boolean
  /** Questions listed in the primer that don't have a solution yet */
  unsolved?: string[]
}

export type Heading = { id: string; title: string; depth: number }
export type Section = SectionMeta & { html: string; headings: Heading[] }
export type SourceFile = { name: string; url: string; html: string }
export type Chapter = { id: string; title: string; sections: Section[]; sourceFiles: SourceFile[] }

export type DeckMeta = { id: string; title: string; description: string; cardIds: string[] }
export type Card = { id: string; front: string; back: string; href?: string }
export type Deck = { id: string; title: string; cards: Card[] }

export const parts: Part[] = (manifestJson.parts as Part[]).filter((p) => p.chapters.length > 0)
export const decks: DeckMeta[] = manifestJson.decks
export const deckById = new Map(decks.map((d) => [d.id, d]))

export const chapters: (ChapterMeta & { part: Part })[] = parts.flatMap((part) => part.chapters.map((c) => ({ ...c, part })))

export const chapterById = new Map(chapters.map((c) => [c.id, c]))

export const extraParts = parts.filter((p) => p.extra)
export const extraChapterCount = extraParts.reduce((n, p) => n + p.chapters.length, 0)

const visible = (showExtras: boolean) => {
  const shownParts = showExtras ? parts : parts.filter((p) => !p.extra)
  const shownChapters = showExtras ? chapters : chapters.filter((c) => !c.extra)
  const tracked = shownChapters.filter((c) => !c.untracked)
  return { parts: shownParts, chapters: shownChapters, tracked, totalSections: tracked.reduce((n, c) => n + c.sections.length, 0) }
}
const withExtras = visible(true)
const withoutExtras = visible(false)

/** The parts and chapters the reader has chosen to see: the primer, plus the extra chapters if they're turned on. */
export function useVisibleContent() {
  return useSettings((s) => s.showExtras) ? withExtras : withoutExtras
}

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
