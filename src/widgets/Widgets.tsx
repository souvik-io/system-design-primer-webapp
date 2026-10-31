import { lazy, Suspense, useEffect, useState, type ComponentType, type RefObject } from 'react'
import { createPortal } from 'react-dom'

// Interactive diagrams. The content build leaves an empty <div data-widget="name"> where each one
// goes (from a ```widget block in content/), and this renders the matching component into it. Each
// diagram's code loads only when its chapter does.

const WIDGETS: Record<string, ComponentType> = {
  'hash-ring': lazy(() => import('./HashRing')),
  'cache-strategies': lazy(() => import('./CacheStrategies')),
  replication: lazy(() => import('./Replication')),
  'rate-limiter': lazy(() => import('./RateLimiter')),
  'kv-cache-calculator': lazy(() => import('./KvCacheCalculator')),
  'batching-simulator': lazy(() => import('./BatchingSimulator')),
  'roofline-explorer': lazy(() => import('./RooflineExplorer')),
}

export function Widgets({ root, chapter }: { root: RefObject<HTMLElement | null>; chapter: unknown }) {
  const [slots, setSlots] = useState<{ el: HTMLElement; name: string }[]>([])

  // A passive effect, not a layout effect: the parent's ref isn't attached yet when this
  // component's layout effects run (StrictMode's second run in development hides that).
  useEffect(() => {
    const els = [...(root.current?.querySelectorAll<HTMLElement>('[data-widget]') ?? [])]
    setSlots(els.map((el) => ({ el, name: el.dataset.widget! })))
  }, [root, chapter])

  return slots.map(({ el, name }, i) => {
    const Widget = WIDGETS[name]
    if (!Widget) {
      console.warn(`No interactive diagram called "${name}".`)
      return null
    }
    return createPortal(
      <Suspense fallback={<div className="h-64 animate-pulse rounded-xl border border-rule bg-surface" />}>
        <Widget />
      </Suspense>,
      el,
      `${name}-${i}`,
    )
  })
}
