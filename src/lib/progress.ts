import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { sectionKey, totalSections, trackedChapters, type ChapterMeta } from './content'

type LastVisited = { chapterId: string; sectionId: string; at: number }

type ProgressState = {
  /** sectionKey -> time it was marked done */
  completed: Record<string, number>
  lastVisited: LastVisited | null
  setSectionDone: (chapterId: string, sectionId: string, done: boolean) => void
  setChapterDone: (chapter: ChapterMeta, done: boolean) => void
  visit: (chapterId: string, sectionId: string) => void
  reset: () => void
}

export const useProgress = create<ProgressState>()(
  persist(
    (set) => ({
      completed: {},
      lastVisited: null,
      setSectionDone: (chapterId, sectionId, done) =>
        set((s) => {
          const completed = { ...s.completed }
          if (done) completed[sectionKey(chapterId, sectionId)] = Date.now()
          else delete completed[sectionKey(chapterId, sectionId)]
          return { completed }
        }),
      setChapterDone: (chapter, done) =>
        set((s) => {
          const completed = { ...s.completed }
          for (const sec of chapter.sections) {
            const key = sectionKey(chapter.id, sec.id)
            if (done) completed[key] ??= Date.now()
            else delete completed[key]
          }
          return { completed }
        }),
      visit: (chapterId, sectionId) => set({ lastVisited: { chapterId, sectionId, at: Date.now() } }),
      reset: () => set({ completed: {}, lastVisited: null }),
    }),
    { name: 'sdp-progress', version: 1 },
  ),
)

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
