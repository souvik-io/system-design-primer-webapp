import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ExternalLink, X } from 'lucide-react'

/**
 * What the zoom overlay shows: an image by URL, a drawn diagram's SVG markup,
 * or an interactive archify diagram from public/diagrams/ (by URL, in a frame).
 */
type Zoomed = { src: string } | { svg: string; width: number } | { frame: string; title: string }

/**
 * Behaviour for rendered primer HTML: internal links go through the router,
 * clicking a diagram (an image or a drawn `diagram` block) opens it full size,
 * and a link to an interactive diagram opens it in place, in the site's theme.
 * Render `zoom` somewhere in the page.
 */
export function useArticleClicks() {
  const [zoomed, setZoomed] = useState<Zoomed | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!zoomed) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoomed(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomed])

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const a = target.closest('a')
    const img = target.closest('img')
    if (img && !a) {
      setZoomed({ src: img.src })
      return
    }
    const svg = target.closest('.diagram')?.querySelector('svg')
    if (svg && !a) {
      setZoomed({ svg: svg.outerHTML, width: svg.viewBox.baseVal.width })
      return
    }
    const href = a?.getAttribute('href')
    if (href && /^\/diagrams\/[^/]+\.html$/.test(href) && !(e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault()
      const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      setZoomed({ frame: `${href}?theme=${theme}`, title: a?.textContent || 'Interactive diagram' })
      return
    }
    // Leave links to static files (like /diagrams/*.html) to the browser: the router has no route for them
    const isFile = /\.[a-z0-9]+$/i.test(href?.split(/[?#]/)[0] ?? '')
    if (!a || !href?.startsWith('/') || isFile || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return
    e.preventDefault()
    navigate(href)
  }

  const zoom = zoomed && (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram"
      onClick={() => setZoomed(null)}
    >
      <button
        type="button"
        className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        aria-label="Close diagram"
        autoFocus
      >
        <X size={20} />
      </button>
      {'frame' in zoomed && (
        <a
          href={zoomed.frame.split('?')[0]}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute top-4 right-16 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          aria-label="Open diagram in a new tab"
          title="Open in a new tab"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink size={20} />
        </a>
      )}
      {'frame' in zoomed ? (
        // The diagram brings its own title, trace and zoom controls. Clicks inside the frame stay in
        // the frame, so only the backdrop and the close button close it.
        <iframe
          src={zoomed.frame}
          title={zoomed.title}
          className="h-[88vh] w-[min(96vw,1400px)] rounded-lg border border-[var(--rule)] bg-[var(--surface)]"
          onLoad={(e) => fitIntoSite(e.currentTarget, () => setZoomed(null))}
        />
      ) : 'src' in zoomed ? (
        <img src={zoomed.src} alt="Diagram, full size" className="max-h-[90vh] max-w-full rounded-lg bg-white object-contain p-3" />
      ) : (
        // Drawn at 1.6× its natural size, up to the window's width, so its labels are easy to read.
        <div
          className="diagram-zoom"
          style={{ width: `min(94vw, ${Math.round(zoomed.width * 1.6)}px)` }}
          dangerouslySetInnerHTML={{ __html: zoomed.svg }}
        />
      )}
    </div>
  )

  return { onClick, zoom }
}

/**
 * Make a framed archify diagram feel like part of the page: paint it in the site's surface colour,
 * and let Escape close the viewer, which it can't hear while focus is in the frame. Archify uses
 * Escape itself to clear a traced route or close a menu, so the viewer closes only on an Escape
 * that left the diagram's open controls (aria-expanded/pressed) as they were.
 */
function fitIntoSite(frame: HTMLIFrameElement, close: () => void) {
  const doc = frame.contentDocument
  const win = frame.contentWindow
  if (!doc || !win) return
  const openControls = () => doc.querySelectorAll('[aria-expanded="true"], [aria-pressed="true"]').length
  let before = 0
  win.addEventListener('keydown', (e) => e.key === 'Escape' && (before = openControls()), true)
  win.addEventListener('keydown', (e) => e.key === 'Escape' && setTimeout(() => openControls() === before && close()))
  const style = doc.createElement('style')
  style.textContent = `body { background: ${getComputedStyle(document.documentElement).getPropertyValue('--surface')} !important; }`
  doc.head.append(style)
}
