import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { Menu, Moon, Search, Sun, X } from 'lucide-react'
import { useTheme } from '../lib/theme'
import { useOverallProgress } from '../lib/progress'
import { ProgressRing } from './ProgressRing'
import { Sidebar } from './Sidebar'
import { SearchDialog } from './SearchDialog'

export function Layout() {
  const [searchOpen, setSearchOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { isDark, toggle } = useTheme()
  const overall = useOverallProgress()
  const location = useLocation()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable]')
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => setDrawerOpen(false), [location.pathname])

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-rule bg-paper/85 backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
          <button
            type="button"
            className="-ml-1 rounded-md p-1.5 text-ink-2 hover:bg-rule/50 lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open chapter list"
          >
            <Menu size={20} />
          </button>

          <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight text-ink">
            <img src="/favicon.svg" alt="" className="size-7" />
            <span className="hidden sm:inline">System Design Primer</span>
          </Link>

          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="ml-auto flex h-9 items-center gap-2 rounded-lg border border-rule bg-surface px-3 text-sm text-muted hover:border-muted/50 sm:w-72 md:ml-8 md:mr-auto"
            aria-label="Search the primer"
          >
            <Search size={16} />
            <span className="hidden sm:inline">Search topics</span>
            <kbd className="ml-auto hidden rounded border border-rule px-1.5 font-mono text-[0.7rem] sm:inline">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>

          <Link
            to="/"
            className="hidden items-center gap-2 rounded-lg px-2 py-1 text-sm text-ink-2 hover:bg-rule/50 md:flex"
            title={`${overall.done} of ${overall.total} sections done`}
          >
            <ProgressRing ratio={overall.ratio} size={20} />
            <span className="tabular-nums">{Math.round(overall.ratio * 100)}% done</span>
          </Link>

          <button
            type="button"
            onClick={toggle}
            className="rounded-md p-2 text-ink-2 hover:bg-rule/50"
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      <div className="flex">
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-72 shrink-0 overflow-y-auto border-r border-rule lg:block">
          <Sidebar />
        </aside>

        <main className="min-w-0 flex-1">
          <Outlet />
          <footer className="border-t border-rule px-4 py-8 text-sm text-muted sm:px-8">
            Content from{' '}
            <a
              className="underline underline-offset-2 hover:text-ink"
              href="https://github.com/donnemartin/system-design-primer"
              target="_blank"
              rel="noreferrer"
            >
              The System Design Primer
            </a>{' '}
            by Donne Martin, licensed under{' '}
            <a
              className="underline underline-offset-2 hover:text-ink"
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noreferrer"
            >
              CC BY 4.0
            </a>
            . Reorganized into chapters and sections for this site.
          </footer>
        </main>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Chapters">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[min(20rem,85vw)] overflow-y-auto bg-paper shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-rule px-4">
              <span className="font-semibold">Chapters</span>
              <button
                type="button"
                className="rounded-md p-1.5 hover:bg-rule/50"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close chapter list"
              >
                <X size={20} />
              </button>
            </div>
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  )
}
