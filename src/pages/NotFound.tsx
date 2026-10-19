import { useEffect } from 'react'
import { Link } from 'react-router'

export function NotFound() {
  useEffect(() => {
    document.title = 'Page not found | System Design Handbook'
  }, [])

  return (
    <div className="mx-auto max-w-xl px-6 py-24 text-center">
      <h1 className="text-2xl font-semibold text-ink">This page doesn't exist</h1>
      <p className="mt-2 text-muted">The link may be from an older version of the course.</p>
      <Link to="/" className="mt-6 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent">
        Go to the course overview
      </Link>
    </div>
  )
}
