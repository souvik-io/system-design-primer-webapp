import { useLocation, useParams } from 'react-router'
import { chapterById, type HandbookId } from './content'

/** The handbook the reader is in: the current chapter's, or the one whose home page is open. */
export function useHandbook(): HandbookId {
  const { chapterId } = useParams()
  const { pathname } = useLocation()
  const chapter = chapterId ? chapterById.get(chapterId) : undefined
  if (chapter) return chapter.part.handbook
  return pathname === '/infra' || pathname.startsWith('/infra/') ? 'infra' : 'system-design'
}
