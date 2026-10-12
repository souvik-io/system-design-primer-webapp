import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { Layout } from './components/Layout'
import { HomePage } from './pages/HomePage'
import { ChapterPage } from './pages/ChapterPage'
import { NotFound } from './pages/NotFound'
import { FlashcardsPage } from './pages/FlashcardsPage'
import { BrowsePage, StudyPage } from './pages/StudyPage'
import { NotesPage } from './pages/NotesPage'
import './index.css'

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/learn/:chapterId', element: <ChapterPage /> },
      { path: '/flashcards', element: <FlashcardsPage /> },
      { path: '/flashcards/:deckId', element: <StudyPage /> },
      { path: '/flashcards/:deckId/browse', element: <BrowsePage /> },
      { path: '/notes', element: <NotesPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
