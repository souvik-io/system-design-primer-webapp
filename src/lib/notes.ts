import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { redirects, sectionExists, sectionKey } from './content'
import { DATA_VERSION, migrateNotes } from './legacy'

// Notes and bookmarks per section, keyed like progress ("chapter/section"). Each entry keeps the
// time it last changed, and deleting one keeps an empty entry, so syncing can pick the latest edit.

export type Note = { text: string; at: number }
export type Bookmark = { on: boolean; at: number }

export type NotesData = {
  notes: Record<string, Note>
  bookmarks: Record<string, Bookmark>
}

type NotesState = NotesData & {
  setNote: (chapterId: string, sectionId: string, text: string) => void
  setBookmark: (chapterId: string, sectionId: string, on: boolean) => void
}

export const useNotes = create<NotesState>()(
  persist(
    (set) => ({
      notes: {},
      bookmarks: {},
      setNote: (chapterId, sectionId, text) =>
        set((s) => {
          const key = sectionKey(chapterId, sectionId)
          const clean = text.trim() ? text : ''
          if ((s.notes[key]?.text ?? '') === clean) return s
          return { notes: { ...s.notes, [key]: { text: clean, at: Date.now() } } }
        }),
      setBookmark: (chapterId, sectionId, on) =>
        set((s) => {
          const key = sectionKey(chapterId, sectionId)
          if (Boolean(s.bookmarks[key]?.on) === on) return s
          return { bookmarks: { ...s.bookmarks, [key]: { on, at: Date.now() } } }
        }),
    }),
    {
      name: 'sdp-notes',
      // Notes and bookmarks in renamed or replaced chapters move to the section that now covers the same heading.
      version: DATA_VERSION,
      migrate: (state, version) =>
        (version < DATA_VERSION ? { ...(state as NotesData), ...migrateNotes(redirects, state as NotesData, sectionExists) } : state) as NotesState,
    },
  ),
)

export function useNote(chapterId: string, sectionId: string) {
  return useNotes((s) => s.notes[sectionKey(chapterId, sectionId)]?.text ?? '')
}

export function useIsBookmarked(chapterId: string, sectionId: string) {
  return useNotes((s) => Boolean(s.bookmarks[sectionKey(chapterId, sectionId)]?.on))
}

/** How many sections have a note or a bookmark. */
export function useNotesCount() {
  return useNotes((s) => {
    const keys = new Set<string>()
    for (const [k, n] of Object.entries(s.notes)) if (n.text) keys.add(k)
    for (const [k, b] of Object.entries(s.bookmarks)) if (b.on) keys.add(k)
    return keys.size
  })
}
