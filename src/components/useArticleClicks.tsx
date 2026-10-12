import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { X } from 'lucide-react'

/**
 * Behaviour for rendered primer HTML: internal links go through the router,
 * and clicking a diagram opens it full size. Render `zoom` somewhere in the page.
 */
export function useArticleClicks() {
  const [zoomSrc, setZoomSrc] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!zoomSrc) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoomSrc(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomSrc])

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const img = target.closest('img')
    if (img && !target.closest('a')) {
      setZoomSrc(img.src)
      return
    }
    const a = target.closest('a')
    const href = a?.getAttribute('href')
    if (!a || !href?.startsWith('/') || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return
    e.preventDefault()
    navigate(href)
  }

  const zoom = zoomSrc && (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram"
      onClick={() => setZoomSrc(null)}
    >
      <button
        type="button"
        className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        aria-label="Close diagram"
        autoFocus
      >
        <X size={20} />
      </button>
      <img src={zoomSrc} alt="Diagram, full size" className="max-h-[90vh] max-w-full rounded-lg bg-white object-contain p-3" />
    </div>
  )

  return { onClick, zoom }
}
