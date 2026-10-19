import type { ProgressData } from './progress'
import type { NotesData } from './notes'

// Old URLs and saved data from before the chapters were renamed or replaced (content/redirects.json).

/** Version of the saved progress and notes. Bump it when content/redirects.json gains entries, so saved data is moved again. */
export const DATA_VERSION = 2

export type Redirects = {
  /** Old chapter id -> new id. The headings are unchanged. */
  renamed: Record<string, string>
  /** Old chapter id -> the chapter, or "chapter#heading", that took over its content */
  replaced: Record<string, string>
  /** "oldChapter#oldHeading" -> "chapter#heading" */
  anchors: Record<string, string>
  /** "oldChapter/oldSection" -> "chapter/section" that now holds that heading */
  sections: Record<string, string>
  /** Old deck id -> new deck id */
  decks: Record<string, string>
}

/**
 * Where an old chapter link should go now, or null if it's current. `from` is the old chapter id that
 * the server's redirect passes along, so a heading in it can still be found.
 */
export function movedChapterUrl(r: Redirects, chapterId: string, search: string, hash: string, exists: (id: string) => boolean) {
  const from = new URLSearchParams(search).get('from')
  const old = from ?? (exists(chapterId) ? null : chapterId)
  const heading = decodeURIComponent(hash.slice(1))
  if (!old) {
    // A heading that moved within, or out of, a chapter that still exists. Only used when the page lacks it.
    const to = heading ? r.anchors[`${chapterId}#${heading}`] : undefined
    return to ? { url: `/learn/${to}`, ifMissing: heading } : null
  }
  if (old in r.renamed) return { url: `/learn/${r.renamed[old]}${hash}` }
  if (old in r.replaced) return { url: `/learn/${(heading && r.anchors[`${old}#${heading}`]) || r.replaced[old]}` }
  // ?from= with an unknown chapter: drop it and stay.
  return from ? { url: `/learn/${chapterId}${hash}` } : null
}

/** Where a section key ("chapter/section") of an old chapter now lives, or null if it isn't old. */
export function movedSectionKey(r: Redirects, key: string, sectionExists: (key: string) => boolean): string | null {
  if (sectionExists(key)) return null
  const [chapter, section] = splitKey(key)
  if (r.sections[key]) return r.sections[key]
  if (chapter in r.renamed) {
    const renamed = `${r.renamed[chapter]}/${section}`
    return sectionExists(renamed) ? renamed : `${r.renamed[chapter]}/overview`
  }
  if (chapter in r.replaced) return r.sections[`${chapter}/overview`] ?? null
  return null
}

function splitKey(key: string): [string, string] {
  const at = key.indexOf('/')
  return [key.slice(0, at), key.slice(at + 1)]
}

/** Progress in renamed chapters follows them. Progress in replaced chapters stays where it was: those sections are gone. */
export function migrateProgress(r: Redirects, p: ProgressData): ProgressData {
  const rename = (key: string) => {
    const [chapter, section] = splitKey(key)
    return chapter in r.renamed ? `${r.renamed[chapter]}/${section}` : key
  }
  const move = (m: Record<string, number>) => {
    const out: Record<string, number> = {}
    for (const [k, at] of Object.entries(m)) out[rename(k)] = Math.max(out[rename(k)] ?? 0, at)
    return out
  }
  const v = p.lastVisited
  const visitedChapter = v && (r.renamed[v.chapterId] ?? r.replaced[v.chapterId]?.split('#')[0])
  return {
    ...p,
    completed: move(p.completed),
    removed: move(p.removed),
    lastVisited: v && visitedChapter ? { ...v, chapterId: visitedChapter, sectionId: v.chapterId in r.renamed ? v.sectionId : 'overview' } : v,
  }
}

/** Notes and bookmarks move to the section that now covers the same heading. Notes landing on one section are joined; for bookmarks the latest change wins. */
export function migrateNotes(r: Redirects, n: NotesData, sectionExists: (key: string) => boolean): NotesData {
  const notes: NotesData['notes'] = {}
  const bookmarks: NotesData['bookmarks'] = {}
  const order = <T extends { at: number }>(m: Record<string, T>) => Object.entries(m).sort(([, a], [, b]) => a.at - b.at)
  for (const [key, note] of order(n.notes)) {
    const to = movedSectionKey(r, key, sectionExists) ?? key
    const prev = notes[to]
    if (prev?.text && note.text && prev.text !== note.text) notes[to] = { text: `${prev.text}\n\n${note.text}`, at: Math.max(prev.at, note.at) }
    else notes[to] = note.text || !prev ? note : prev
  }
  for (const [key, mark] of order(n.bookmarks)) {
    const to = movedSectionKey(r, key, sectionExists) ?? key
    const prev = bookmarks[to]
    bookmarks[to] = prev && prev.at > mark.at ? prev : mark
  }
  return { notes, bookmarks }
}
