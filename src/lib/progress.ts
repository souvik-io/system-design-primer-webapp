import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { sectionKey, totalSections, trackedChapters, type ChapterMeta } from './content'

type LastVisited = { chapterId: string; sectionId: string; at: number }

export type ProgressData = {
  /** sectionKey -> time it was marked done */
  completed: Record<string, number>
  /** sectionKey -> time it was marked not done, so the change wins over older copies when syncing */
  removed: Record<string, number>
  /** When all progress was last cleared */
  resetAt: number
  lastVisited: LastVisited | null
}

type ProgressState = ProgressData & {
  setSectionDone: (chapterId: string, sectionId: string, done: boolean) => void
  setChapterDone: (chapter: ChapterMeta, done: boolean) => void
  visit: (chapterId: string, sectionId: string) => void
  reset: () => void
}

export const useProgress = create<ProgressState>()(
  persist(
    (set) => ({
      completed: {},
      removed: {},
      resetAt: 0,
      lastVisited: null,
      setSectionDone: (chapterId, sectionId, done) => set((s) => mark(s, [sectionKey(chapterId, sectionId)], done)),
      setChapterDone: (chapter, done) =>
        set((s) =>
          mark(
            s,
            chapter.sections.map((sec) => sectionKey(chapter.id, sec.id)),
            done,
          ),
        ),
      visit: (chapterId, sectionId) => set({ lastVisited: { chapterId, sectionId, at: Date.now() } }),
      reset: () => set({ completed: {}, removed: {}, resetAt: Date.now(), lastVisited: null }),
    }),
    { name: 'sdp-progress', version: 1 },
  ),
)

function mark(s: ProgressData, keys: string[], done: boolean) {
  const now = Date.now()
  const completed = { ...s.completed }
  const removed = { ...s.removed }
  for (const key of keys) {
    if (done === Boolean(completed[key])) continue
    if (done) {
      completed[key] = now
      delete removed[key]
    } else {
      delete completed[key]
      removed[key] = now
    }
  }
  return { completed, removed }
}

export function useChapterProgress(chapter: ChapterMeta) {
  const completed = useProgress((s) => s.completed)
  const done = chapter.sections.filter((sec) => completed[sectionKey(chapter.id, sec.id)]).length
  return { done, total: chapter.sections.length, ratio: done / chapter.sections.length }
}

export function useOverallProgress() {
  const completed = useProgress((s) => s.completed)
  let done = 0
  for (const c of trackedChapters) for (const sec of c.sections) if (completed[sectionKey(c.id, sec.id)]) done++
  return { done, total: totalSections, ratio: done / totalSections }
}

export function useIsSectionDone(chapterId: string, sectionId: string) {
  return useProgress((s) => Boolean(s.completed[sectionKey(chapterId, sectionId)]))
}
