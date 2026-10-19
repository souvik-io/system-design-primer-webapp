import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { chapterById, sectionHref, sectionKey } from '../lib/content'
import { useChapterProgress, useProgress } from '../lib/progress'
import { ProgressRing } from './ProgressRing'

// The "Building blocks" chapters laid out as the path a request takes through a system.
// Coordinates are in pixels on a fixed canvas; the wrapper scrolls on narrow screens.
const W = 150
const H = 64
const COL = [16, 262, 458, 654, 858]
const ROW = [40, 178, 316]
const CANVAS = { width: 1024, height: 404 }

// A node covers a whole chapter, or the run of its sections from `from` up to (not including) `until`,
// where one chapter covers two boxes.
type NodeDef = { chapterId: string; from?: string; until?: string; label: string; x: number; y: number }

const NODES: NodeDef[] = [
  { chapterId: 'dns-and-cdn', until: 'content-delivery-networks', label: 'DNS', x: COL[1], y: ROW[0] },
  { chapterId: 'load-balancing', label: 'Load balancer', x: COL[1], y: ROW[1] },
  { chapterId: 'dns-and-cdn', from: 'content-delivery-networks', label: 'CDN', x: COL[1], y: ROW[2] },
  {
    chapterId: 'reverse-proxy-and-api-gateway',
    until: 'separating-the-web-and-application-layers',
    label: 'Reverse proxy',
    x: COL[2],
    y: ROW[1],
  },
  {
    chapterId: 'reverse-proxy-and-api-gateway',
    from: 'separating-the-web-and-application-layers',
    label: 'Application layer',
    x: COL[3],
    y: ROW[1],
  },
  { chapterId: 'cache', label: 'Cache', x: COL[4], y: ROW[0] },
  { chapterId: 'relational-databases', label: 'Database', x: COL[4], y: ROW[1] },
  { chapterId: 'queues-and-async', label: 'Queues', x: COL[4], y: ROW[2] },
]

const CLIENT = { x: COL[0], y: ROW[1], w: 112 }
const mid = (y: number) => y + H / 2

function link(from: [number, number], to: [number, number]) {
  const cx = (from[0] + to[0]) / 2
  return `M${from[0]} ${from[1]} C${cx} ${from[1]}, ${cx} ${to[1]}, ${to[0]} ${to[1]}`
}

const clientX = CLIENT.x + CLIENT.w / 2
const EDGES = [
  // Client resolves DNS and fetches static assets from the CDN (drawn as elbows from the client's top and bottom).
  `M${clientX} ${CLIENT.y} V${mid(ROW[0]) + 16} Q${clientX} ${mid(ROW[0])} ${clientX + 16} ${mid(ROW[0])} H${COL[1]}`,
  `M${clientX} ${CLIENT.y + H} V${mid(ROW[2]) - 16} Q${clientX} ${mid(ROW[2])} ${clientX + 16} ${mid(ROW[2])} H${COL[1]}`,
  `M${CLIENT.x + CLIENT.w} ${mid(ROW[1])} H${COL[1]}`,
  `M${COL[1] + W} ${mid(ROW[1])} H${COL[2]}`,
  `M${COL[2] + W} ${mid(ROW[1])} H${COL[3]}`,
  link([COL[3] + W, mid(ROW[1])], [COL[4], mid(ROW[0])]),
  `M${COL[3] + W} ${mid(ROW[1])} H${COL[4]}`,
  link([COL[3] + W, mid(ROW[1])], [COL[4], mid(ROW[2])]),
]

const SECURITY = { x: COL[2] - 16, y: 14, w: CANVAS.width - COL[2] + 8, h: CANVAS.height - 28 }

// Below this scale the labels get too small, so the map scrolls sideways instead.
const MIN_SCALE = 0.72

export function SystemMap() {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const el = wrapperRef.current!
    const observer = new ResizeObserver(([entry]) => {
      setScale(Math.max(MIN_SCALE, Math.min(1, entry.contentRect.width / CANVAS.width)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={wrapperRef} className="overflow-x-auto">
      <div className="mx-auto" style={{ width: CANVAS.width * scale, height: CANVAS.height * scale }}>
        <div className="relative origin-top-left" style={{ ...CANVAS, transform: `scale(${scale})` }}>
          <svg width={CANVAS.width} height={CANVAS.height} className="absolute inset-0" aria-hidden>
            <rect
              x={SECURITY.x}
              y={SECURITY.y}
              width={SECURITY.w}
              height={SECURITY.h}
              rx={16}
              fill="none"
              stroke="var(--rule)"
              strokeWidth={1.5}
              strokeDasharray="6 6"
            />
            {EDGES.map((d, i) => (
              <path
                key={i}
                d={d}
                className="map-edge"
                style={{ animationDelay: `${120 + i * 70}ms` }}
                fill="none"
                stroke="var(--muted)"
                strokeOpacity={0.55}
                strokeWidth={1.5}
              />
            ))}
          </svg>

          <div
            className="absolute grid place-items-center rounded-xl border border-dashed border-muted/60 text-sm font-medium text-muted"
            style={{ left: CLIENT.x, top: CLIENT.y, width: CLIENT.w, height: H }}
          >
            Client
          </div>

          <Chip chapterId="protocols-and-apis" label="Communication" style={{ left: CLIENT.x + CLIENT.w + 6, top: mid(ROW[1]) - 13 }} />
          <Chip chapterId="security" label="Security" style={{ left: SECURITY.x + 14, top: SECURITY.y - 13 }} />

          {NODES.map((n) => (
            <MapNode key={n.label} node={n} />
          ))}
        </div>
      </div>
    </div>
  )
}

function MapNode({ node }: { node: NodeDef }) {
  const chapter = chapterById.get(node.chapterId)!
  const start = node.from ? chapter.sections.findIndex((s) => s.id === node.from) : 0
  const end = node.until ? chapter.sections.findIndex((s) => s.id === node.until) : chapter.sections.length
  const sections = chapter.sections.slice(start, end)
  const done = useProgress((s) => sections.filter((sec) => s.completed[sectionKey(chapter.id, sec.id)]).length)
  const total = sections.length
  const ratio = done / total
  const complete = done === total

  return (
    <Link
      to={sectionHref(chapter.id, sections[0].id)}
      title={chapter.title}
      className={clsx(
        'group absolute flex flex-col justify-center overflow-hidden rounded-xl border px-3.5 transition-colors',
        complete ? 'border-done/60 bg-done-soft' : 'border-rule bg-surface hover:border-accent',
      )}
      style={{ left: node.x, top: node.y, width: W, height: H }}
    >
      <span className="flex items-center gap-1.5 text-[0.875rem] font-semibold text-ink group-hover:text-accent">
        {node.label}
        {complete && <Check size={14} strokeWidth={3} className="text-done" />}
      </span>
      <span className="text-[0.75rem] text-muted tabular-nums">
        {done} of {total} {total === 1 ? 'section' : 'sections'}
      </span>
      <span className="absolute inset-x-0 bottom-0 h-[3px] bg-rule/60" aria-hidden>
        <span className="block h-full bg-done transition-[width] duration-500" style={{ width: `${ratio * 100}%` }} />
      </span>
    </Link>
  )
}

function Chip({ chapterId, label, style }: { chapterId: string; label: string; style: React.CSSProperties }) {
  const chapter = chapterById.get(chapterId)!
  const { ratio, done, total } = useChapterProgress(chapter)
  return (
    <Link
      to={`/learn/${chapterId}`}
      title={chapter.title}
      className="absolute flex h-[26px] items-center gap-1.5 rounded-full border border-rule bg-surface px-2.5 text-[0.75rem] font-medium text-ink-2 hover:border-accent hover:text-accent"
      style={style}
    >
      <ProgressRing ratio={ratio} size={12} stroke={2} label={`${done} of ${total} sections done`} />
      {label}
    </Link>
  )
}
