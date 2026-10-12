import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Narration, Segmented, Stat, WidgetFrame } from './ui'

// One record, user:42, read and written under three cache update strategies.
// Latencies are illustrative: 1 ms for the cache, 10 ms for a database read, 15 ms for a write.

type Strategy = 'aside' | 'through' | 'behind'
type NodeId = 'app' | 'cache' | 'db' | 'other'
type Step = { from: NodeId; to: NodeId; text: string; ms: number }

const CACHE_MS = 1
const DB_READ_MS = 10
const DB_WRITE_MS = 15
const FLUSH_AFTER = 4000

const ABOUT: Record<Strategy, string> = {
  aside:
    'The app checks the cache first. On a miss it reads the database and puts the result in the cache. Writes go to the database, then delete the cached copy.',
  through:
    'The app reads and writes through the cache. On a miss the cache loads from the database itself. A write returns only after the cache has written it to the database too.',
  behind:
    'Reads work as in write-through, but a write returns as soon as the cache has it. The cache writes it to the database a few seconds later, combining repeated writes into one.',
}

type Pending = { version: number; flushAt: number; overwrites: number | null }

type State = {
  cache: number | null
  db: number
  /** The newest value the system has acknowledged and still holds */
  latest: number
  nextVersion: number
  pending: Pending | null
  lastRead: number | null
  op: string | null
  steps: Step[]
  message: ReactNode
  tone?: 'bad' | 'good'
  stats: {
    reads: number
    hits: number
    stale: number
    readMs: number
    writes: number
    writeMs: number
    dbWrites: number
    lost: number
    saved: number
  }
}

const fresh = (message: ReactNode): State => ({
  cache: null,
  db: 1,
  latest: 1,
  nextVersion: 2,
  pending: null,
  lastRead: null,
  op: null,
  steps: [],
  message,
  stats: { reads: 0, hits: 0, stale: 0, readMs: 0, writes: 0, writeMs: 0, dbWrites: 0, lost: 0, saved: 0 },
})

const START = 'The database holds v1 of user:42 and the cache is empty. Read it, write new versions, and try the events that cause trouble.'

export default function CacheStrategies() {
  const [strategy, setStrategy] = useState<Strategy>('aside')
  const [s, setS] = useState<State>(() => fresh(START))
  const [now, setNow] = useState(() => Date.now())

  // Write-behind: flush the queued write when it's due, and tick the countdown until then.
  useEffect(() => {
    if (!s.pending) return
    const tick = setInterval(() => setNow(Date.now()), 250)
    const flush = setTimeout(() => setS((st) => flushPending(st)), Math.max(0, s.pending.flushAt - Date.now()))
    return () => {
      clearInterval(tick)
      clearTimeout(flush)
    }
  }, [s.pending])

  const choose = (next: Strategy) => {
    setStrategy(next)
    setS(fresh(START))
  }

  const read = () =>
    setS((st) => {
      const steps: Step[] = []
      let cache = st.cache
      let value: number
      if (cache !== null) {
        steps.push({ from: 'app', to: 'cache', text: `App asks the cache for user:42: hit, v${cache}`, ms: CACHE_MS })
        value = cache
      } else if (strategy === 'aside') {
        steps.push({ from: 'app', to: 'cache', text: 'App asks the cache for user:42: miss', ms: CACHE_MS })
        steps.push({ from: 'app', to: 'db', text: `App reads the database: v${st.db}`, ms: DB_READ_MS })
        steps.push({ from: 'app', to: 'cache', text: `App puts v${st.db} in the cache`, ms: CACHE_MS })
        value = cache = st.db
      } else {
        steps.push({ from: 'app', to: 'cache', text: 'App asks the cache for user:42: miss', ms: CACHE_MS })
        steps.push({ from: 'cache', to: 'db', text: `Cache loads v${st.db} from the database, keeps it and returns it`, ms: DB_READ_MS })
        value = cache = st.db
      }
      const ms = total(steps)
      const hit = st.cache !== null
      const stale = value !== st.latest
      return {
        ...st,
        cache,
        lastRead: value,
        op: 'Read user:42',
        steps,
        tone: stale ? 'bad' : undefined,
        message: stale ? (
          <>
            Returned v{value}, but the latest write is v{st.latest}. This read is stale, and stays stale until the cached copy expires or is replaced.
          </>
        ) : hit ? (
          <>
            Cache hit: v{value} in {ms} ms.
          </>
        ) : (
          <>
            Cache miss: v{value} in {ms} ms, and the next read will be a hit.
          </>
        ),
        stats: {
          ...st.stats,
          reads: st.stats.reads + 1,
          hits: st.stats.hits + (hit ? 1 : 0),
          stale: st.stats.stale + (stale ? 1 : 0),
          readMs: st.stats.readMs + ms,
        },
      }
    })

  const write = () =>
    setS((st) => {
      const v = st.nextVersion
      const base = { ...st, nextVersion: v + 1, latest: v, op: `Write v${v}`, tone: undefined }
      const stats = { ...st.stats, writes: st.stats.writes + 1 }
      if (strategy === 'aside') {
        const steps: Step[] = [
          { from: 'app', to: 'db', text: `App writes v${v} to the database`, ms: DB_WRITE_MS },
          { from: 'app', to: 'cache', text: 'App deletes user:42 from the cache', ms: CACHE_MS },
        ]
        return {
          ...base,
          db: v,
          cache: null,
          steps,
          message: (
            <>
              Saved v{v} in {total(steps)} ms. The cached copy is gone, so the next read is a miss that loads v{v}.
            </>
          ),
          stats: { ...stats, writeMs: stats.writeMs + total(steps), dbWrites: stats.dbWrites + 1 },
        }
      }
      if (strategy === 'through') {
        const steps: Step[] = [
          { from: 'app', to: 'cache', text: `App writes v${v} to the cache`, ms: CACHE_MS },
          { from: 'cache', to: 'db', text: `Cache writes v${v} to the database before replying`, ms: DB_WRITE_MS },
        ]
        return {
          ...base,
          db: v,
          cache: v,
          steps,
          message: (
            <>
              Saved v{v} in {total(steps)} ms. The cache and the database agree, and the next read is a hit.
            </>
          ),
          stats: { ...stats, writeMs: stats.writeMs + total(steps), dbWrites: stats.dbWrites + 1 },
        }
      }
      const steps: Step[] = [
        { from: 'app', to: 'cache', text: `App writes v${v} to the cache, which replies at once`, ms: CACHE_MS },
        { from: 'cache', to: 'db', text: `Cache queues the database write for later`, ms: 0 },
      ]
      const replaced = st.pending
      return {
        ...base,
        cache: v,
        pending: { version: v, flushAt: replaced?.flushAt ?? Date.now() + FLUSH_AFTER, overwrites: replaced?.overwrites ?? null },
        steps,
        message: replaced ? (
          <>
            Saved v{v} in {total(steps)} ms. It replaces v{replaced.version} in the queue, so the database gets one write instead of two.
          </>
        ) : (
          <>
            Saved v{v} in {total(steps)} ms, but only in the cache. The database still has v{st.db} until the queued write runs.
          </>
        ),
        stats: { ...stats, writeMs: stats.writeMs + total(steps), saved: stats.saved + (replaced ? 1 : 0) },
      }
    })

  const otherWrite = () =>
    setS((st) => {
      const v = st.nextVersion
      const steps: Step[] = [{ from: 'other', to: 'db', text: `Another service writes v${v} straight to the database`, ms: DB_WRITE_MS }]
      const cached = st.cache !== null
      return {
        ...st,
        db: v,
        latest: v,
        nextVersion: v + 1,
        pending: st.pending && { ...st.pending, overwrites: v },
        op: `Another service writes v${v}`,
        steps,
        tone: undefined,
        message: st.pending ? (
          <>
            The database now has v{v}, but the cache still has v{st.pending.version} queued. When that write runs it will overwrite v{v}.
          </>
        ) : cached ? (
          <>
            The database has v{v}, but the cache still holds v{st.cache} and nothing tells it. Reads will be stale until the entry expires.
          </>
        ) : (
          <>The database has v{v}. The cache is empty, so the next read loads the new value.</>
        ),
        stats: { ...st.stats, dbWrites: st.stats.dbWrites + 1 },
      }
    })

  const expire = () =>
    setS((st) => {
      if (st.pending)
        return {
          ...st,
          op: 'Entry expires',
          steps: [],
          tone: undefined,
          message: <>The entry has a write that hasn't reached the database yet, so it can't expire until that write runs.</>,
        }
      return {
        ...st,
        cache: null,
        op: 'Entry expires',
        steps: [],
        tone: undefined,
        message:
          st.cache === null ? (
            <>The cache is already empty.</>
          ) : (
            <>The cached copy of user:42 expired (its TTL ran out). The next read loads it from the database again.</>
          ),
      }
    })

  const crash = () =>
    setS((st) => {
      const lost = st.pending
      return {
        ...st,
        cache: null,
        pending: null,
        latest: lost ? st.db : st.latest,
        op: 'Cache node restarts',
        steps: [],
        tone: lost ? 'bad' : undefined,
        message: lost ? (
          <>
            The cache node restarted with v{lost.version} still queued. The app was told v{lost.version} was saved, but the database has v{st.db}.
            That write is lost.
          </>
        ) : (
          <>The cache node restarted empty. Nothing was lost, but the next read is a miss and pays for the database trip.</>
        ),
        stats: { ...st.stats, lost: st.stats.lost + (lost ? 1 : 0) },
      }
    })

  const { stats } = s
  const avg = (sum: number, n: number) => (n ? `${Math.round(sum / n)} ms` : '–')

  return (
    <WidgetFrame
      title="Try it: cache-aside, write-through and write-behind"
      description="One record, user:42, kept in a database with a cache in front. Pick a strategy, then read, write, and try the events that make caches go wrong."
    >
      <div className="space-y-2">
        <Segmented
          label="Strategy"
          value={strategy}
          options={[
            { value: 'aside', label: 'Cache-aside' },
            { value: 'through', label: 'Write-through' },
            { value: 'behind', label: 'Write-behind' },
          ]}
          onChange={choose}
        />
        <p className="text-[0.85rem] leading-relaxed text-ink-2">{ABOUT[strategy]}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button tone="primary" onClick={read}>
          Read
        </Button>
        <Button tone="primary" onClick={write}>
          Write v{s.nextVersion}
        </Button>
        <Button onClick={otherWrite}>Another service writes the database</Button>
        <Button onClick={expire}>Entry expires</Button>
        <Button tone="danger" onClick={crash}>
          Cache node restarts
        </Button>
      </div>

      <Diagram s={s} now={now} />

      {s.op && (
        <div>
          <div className="text-[0.8125rem] font-semibold text-ink">
            {s.op}
            {s.steps.length > 0 && <span className="font-normal text-muted">, {total(s.steps)} ms</span>}
          </div>
          {s.steps.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {s.steps.map((step, i) => (
                <div key={i} className="flex gap-2 text-[0.8125rem] text-ink-2">
                  <span className="grid size-[1.15rem] shrink-0 place-items-center rounded-full bg-accent text-[0.7rem] font-semibold text-on-accent">
                    {i + 1}
                  </span>
                  <span className="flex-1">{step.text}</span>
                  <span className="text-muted tabular-nums">{step.ms} ms</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Narration tone={s.tone}>{s.message}</Narration>

      <div className="grid grid-cols-3 gap-3 border-t border-rule pt-3 sm:grid-cols-6">
        <Stat label="Reads" value={stats.reads} />
        <Stat label="Hit rate" value={stats.reads ? `${Math.round((stats.hits / stats.reads) * 100)}%` : '–'} />
        <Stat label="Stale reads" value={stats.stale} tone={stats.stale ? 'bad' : undefined} />
        <Stat label="Avg read" value={avg(stats.readMs, stats.reads)} />
        <Stat label="Avg write" value={avg(stats.writeMs, stats.writes)} />
        <Stat label="Lost writes" value={stats.lost} tone={stats.lost ? 'bad' : undefined} />
      </div>
    </WidgetFrame>
  )
}

function total(steps: Step[]) {
  return steps.reduce((n, s) => n + s.ms, 0)
}

function flushPending(st: State): State {
  const p = st.pending
  if (!p) return st
  const overwrote = p.overwrites !== null && p.overwrites > p.version
  return {
    ...st,
    db: p.version,
    latest: overwrote ? p.version : st.latest,
    pending: null,
    op: 'Background write',
    steps: [{ from: 'cache', to: 'db', text: `Cache writes the queued v${p.version} to the database`, ms: DB_WRITE_MS }],
    tone: overwrote ? 'bad' : 'good',
    message: overwrote ? (
      <>
        The queued v{p.version} reached the database and overwrote v{p.overwrites}, which another service wrote in the meantime. That newer write is
        lost.
      </>
    ) : (
      <>The queued v{p.version} reached the database. The app didn't wait for it.</>
    ),
    stats: { ...st.stats, dbWrites: st.stats.dbWrites + 1, lost: st.stats.lost + (overwrote ? 1 : 0) },
  }
}

// --- Drawing ---------------------------------------------------------------

const BOX = {
  app: { x: 16, y: 62, w: 118, h: 62 },
  cache: { x: 236, y: 8, w: 140, h: 62 },
  db: { x: 236, y: 128, w: 140, h: 62 },
  other: { x: 16, y: 150, w: 118, h: 40 },
}
const EDGES: { a: NodeId; b: NodeId; line: [number, number, number, number] }[] = [
  { a: 'app', b: 'cache', line: [134, 80, 236, 40] },
  { a: 'app', b: 'db', line: [134, 106, 236, 150] },
  { a: 'cache', b: 'db', line: [306, 70, 306, 128] },
  { a: 'other', b: 'db', line: [134, 172, 236, 172] },
]

function Diagram({ s, now }: { s: State; now: number }) {
  const used = (a: NodeId, b: NodeId) => s.steps.flatMap((st, i) => ((st.from === a && st.to === b) || (st.from === b && st.to === a) ? [i + 1] : []))
  const flushIn = s.pending ? Math.max(0, Math.ceil((s.pending.flushAt - now) / 1000)) : 0

  return (
    <div className="overflow-x-auto rounded-lg border border-rule bg-paper/50 p-2">
      <svg viewBox="0 0 392 198" className="mx-auto block w-full max-w-[30rem]" role="img" aria-label="App, cache and database">
        {EDGES.map(({ a, b, line: [x1, y1, x2, y2] }) => {
          const nums = used(a, b)
          const queued = a === 'cache' && b === 'db' && s.pending
          const active = nums.length > 0
          return (
            <g key={a + b}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={queued ? 'var(--warn)' : active ? 'var(--accent)' : 'var(--rule)'}
                strokeWidth={active || queued ? 2 : 1.5}
                strokeDasharray={queued || a === 'other' ? '5 4' : undefined}
              />
              {active && (
                <g>
                  <rect
                    x={(x1 + x2) / 2 - 7 - (nums.length - 1) * 5}
                    y={(y1 + y2) / 2 - 9}
                    width={14 + (nums.length - 1) * 10}
                    height={18}
                    rx={9}
                    fill="var(--accent)"
                  />
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--on-accent)">
                    {nums.join(',')}
                  </text>
                </g>
              )}
              {queued && (
                <text x={x1 - 8} y={(y1 + y2) / 2 + 4} textAnchor="end" fontSize={11} fill="var(--warn)" fontWeight={600}>
                  v{s.pending!.version} queued, {flushIn}s
                </text>
              )}
            </g>
          )
        })}

        <Box
          id="app"
          title="App"
          value={s.lastRead === null ? 'no reads yet' : `last read v${s.lastRead}`}
          warn={s.lastRead !== null && s.lastRead !== s.latest}
        />
        <Box id="cache" title="Cache" value={s.cache === null ? 'empty' : `user:42 = v${s.cache}`} warn={s.cache !== null && s.cache !== s.latest} />
        <Box id="db" title="Database" value={`user:42 = v${s.db}`} warn={s.db !== s.latest} />
        <Box id="other" title="Another service" muted />
      </svg>
    </div>
  )
}

function Box({ id, title, value, warn, muted }: { id: NodeId; title: string; value?: string; warn?: boolean; muted?: boolean }) {
  const b = BOX[id]
  return (
    <g>
      <rect
        x={b.x}
        y={b.y}
        width={b.w}
        height={b.h}
        rx={8}
        fill="var(--surface)"
        stroke={muted ? 'var(--muted)' : id === 'db' ? 'var(--accent)' : 'var(--ink-2)'}
        strokeDasharray={muted ? '4 3' : undefined}
        strokeWidth={1.25}
      />
      <text
        x={b.x + b.w / 2}
        y={b.y + (value ? 25 : b.h / 2 + 4.5)}
        textAnchor="middle"
        fontSize={13}
        fontWeight={600}
        fill={muted ? 'var(--muted)' : 'var(--ink)'}
      >
        {title}
      </text>
      {value && (
        <text
          x={b.x + b.w / 2}
          y={b.y + 45}
          textAnchor="middle"
          fontSize={12}
          className={clsx('tabular-nums')}
          fill={warn ? 'var(--warn)' : 'var(--ink-2)'}
          fontWeight={warn ? 600 : 400}
        >
          {value}
        </text>
      )}
    </g>
  )
}
