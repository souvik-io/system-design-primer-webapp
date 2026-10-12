import { useMemo, useState, type ReactNode } from 'react'
import { Narration, Segmented, WidgetFrame } from './ui'

// The same requests run through four rate limiters, each set to 10 requests per 10 seconds.
// Times are in tenths of a second so window arithmetic stays exact.

const LIMIT = 10
const WINDOW = 100 // 10 s
const SPAN = 300 // 30 s on the timeline
const RATE = LIMIT / WINDOW // tokens per tenth of a second
const CAPACITY = LIMIT

type Preset = 'boundary' | 'steady' | 'burst' | 'own'

const range = (from: number, count: number, step: number) => Array.from({ length: count }, (_, i) => from + i * step)

const PRESETS: Record<Exclude<Preset, 'own'>, number[]> = {
  boundary: [...range(60, 10, 4), ...range(100, 10, 4), 170, 200, 230, 260, 290],
  steady: range(4, 37, 8),
  burst: range(150, 25, 1),
}

type Algo = { id: string; name: string; run: (ts: number[]) => boolean[] }

const ALGOS: Algo[] = [
  {
    id: 'fixed',
    name: 'Fixed window',
    run: (ts) => {
      const counts = new Map<number, number>()
      return ts.map((t) => {
        const w = Math.floor(t / WINDOW)
        const c = counts.get(w) ?? 0
        if (c >= LIMIT) return false
        counts.set(w, c + 1)
        return true
      })
    },
  },
  {
    id: 'log',
    name: 'Sliding window log',
    run: (ts) => {
      const log: number[] = []
      return ts.map((t) => {
        while (log.length && log[0] <= t - WINDOW) log.shift()
        if (log.length >= LIMIT) return false
        log.push(t)
        return true
      })
    },
  },
  {
    id: 'counter',
    name: 'Sliding window counter',
    run: (ts) => {
      const counts = new Map<number, number>()
      return ts.map((t) => {
        const w = Math.floor(t / WINDOW)
        const elapsed = (t - w * WINDOW) / WINDOW
        const estimate = (counts.get(w) ?? 0) + (counts.get(w - 1) ?? 0) * (1 - elapsed)
        if (estimate >= LIMIT) return false
        counts.set(w, (counts.get(w) ?? 0) + 1)
        return true
      })
    },
  },
  {
    id: 'bucket',
    name: 'Token bucket',
    run: (ts) => {
      let tokens = CAPACITY
      let last = 0
      return ts.map((t) => {
        tokens = Math.min(CAPACITY, tokens + (t - last) * RATE)
        last = t
        if (tokens < 1) return false
        tokens -= 1
        return true
      })
    },
  },
]

/** The most allowed requests in any 10-second stretch. */
function busiest(ts: number[], ok: boolean[]) {
  const allowed = ts.filter((_, i) => ok[i])
  let best = 0
  for (let i = 0, j = 0; i < allowed.length; i++) {
    while (allowed[i] - allowed[j] >= WINDOW) j++
    best = Math.max(best, i - j + 1)
  }
  return best
}

/** Token count over time, for drawing the bucket's level. */
function tokenLevels(ts: number[]) {
  const points: [number, number][] = []
  let tokens = CAPACITY
  let last = 0
  const at = (t: number) => Math.min(CAPACITY, tokens + (t - last) * RATE)
  let i = 0
  for (let t = 0; t <= SPAN; t++) {
    while (i < ts.length && ts[i] === t) {
      points.push([t, at(t)])
      tokens = at(t)
      last = t
      if (tokens >= 1) tokens -= 1
      points.push([t, tokens])
      i++
    }
    points.push([t, at(t)])
  }
  return points
}

// Layout
const VIEW_W = 556
const LEFT = 158
const RIGHT = 548
const LANE = 42
const TOP = 10
const x = (t: number) => LEFT + (t / SPAN) * (RIGHT - LEFT)

export default function RateLimiter() {
  const [preset, setPreset] = useState<Preset>('boundary')
  const [own, setOwn] = useState<number[]>([])
  const ts = useMemo(() => [...(preset === 'own' ? own : PRESETS[preset])].sort((a, b) => a - b), [preset, own])
  const results = useMemo(() => ALGOS.map((a) => ({ ...a, ok: a.run(ts) })), [ts])
  const stats = results.map((r) => ({ id: r.id, allowed: r.ok.filter(Boolean).length, busiest: busiest(ts, r.ok) }))
  const statOf = (id: string) => stats.find((s) => s.id === id)!
  const levels = useMemo(() => tokenLevels(ts), [ts])
  const height = TOP + LANE * (ALGOS.length + 1) + 28

  const toggleAt = (clientX: number, svg: SVGSVGElement) => {
    const box = svg.getBoundingClientRect()
    const vx = ((clientX - box.left) / box.width) * VIEW_W
    if (vx < LEFT - 4 || vx > RIGHT + 4) return
    const t = Math.round(Math.min(SPAN, Math.max(0, ((vx - LEFT) / (RIGHT - LEFT)) * SPAN)))
    const base = preset === 'own' ? own : PRESETS[preset]
    const near = base.findIndex((q) => Math.abs(q - t) <= 2)
    setOwn(near >= 0 ? base.filter((_, i) => i !== near) : [...base, t])
    setPreset('own')
  }

  const notes: Record<Preset, ReactNode> = {
    boundary: (
      <>
        Ten requests arrive just before the window resets at 10 s, and ten just after. The fixed window counts them in different windows and lets{' '}
        {statOf('fixed').busiest} through in under 8 seconds, twice the limit. The sliding log never allows more than {LIMIT} in any 10 seconds. The
        sliding counter's estimate assumes the previous window's requests were spread evenly, so it lets a few extra through (
        {statOf('counter').busiest}). The token bucket's busiest 10 seconds ({statOf('bucket').busiest}) is over {LIMIT} by design: a full bucket plus
        what refills meanwhile. Only its long-run rate is held to 1 a second.
      </>
    ),
    steady: (
      <>
        About 1.25 requests a second, a little over the limit of 1 a second. The window-based limiters hold close to {LIMIT} per 10 seconds and reject
        the rest: they allowed {statOf('fixed').allowed}, {statOf('log').allowed} and {statOf('counter').allowed}. The token bucket allowed{' '}
        {statOf('bucket').allowed} of {ts.length}: its bucket of {CAPACITY} absorbs the extra quarter request a second for a long time. That's the
        burst allowance at work. Over a longer run it would settle at 1 a second.
      </>
    ),
    burst: (
      <>
        25 requests in 2.5 seconds after a quiet spell. Each window-based limiter starts with its full allowance and stops at {LIMIT}. The token
        bucket starts full too, and also lets through the tokens that refill during the burst, {statOf('bucket').allowed} in all.
      </>
    ),
    own: (
      <>
        {ts.length === 0
          ? 'Click the timeline to add requests.'
          : `${ts.length} requests. Busiest 10 seconds: fixed window ${statOf('fixed').busiest}, sliding log ${statOf('log').busiest}, sliding counter ${statOf('counter').busiest}, token bucket ${statOf('bucket').busiest}.`}{' '}
        Click an empty spot on the timeline to add a request, or a request to remove it.
      </>
    ),
  }

  return (
    <WidgetFrame
      title="Try it: four rate limiters on the same traffic"
      description={`Each limiter allows ${LIMIT} requests per 10 seconds; the token bucket holds ${CAPACITY} tokens and refills 1 a second. Pick a traffic pattern, or click the timeline to add and remove requests.`}
    >
      <Segmented
        label="Traffic"
        value={preset}
        options={[
          { value: 'boundary', label: 'Burst at a boundary' },
          { value: 'steady', label: 'Steady, a bit fast' },
          { value: 'burst', label: 'Quiet, then a burst' },
          { value: 'own', label: 'Your own' },
        ]}
        onChange={(p) => {
          if (p === 'own' && preset !== 'own' && !own.length) setOwn([...PRESETS[preset as Exclude<Preset, 'own'>]])
          setPreset(p)
        }}
      />

      <div className="overflow-x-auto rounded-lg border border-rule bg-paper/50 p-2">
        <svg
          viewBox={`0 0 ${VIEW_W} ${height}`}
          className="block w-full min-w-[32rem] cursor-crosshair"
          role="img"
          aria-label="Requests over 30 seconds and which ones each rate limiter allowed"
          onClick={(e) => toggleAt(e.clientX, e.currentTarget)}
        >
          {[1, 2].map((w) => (
            <g key={w}>
              <line x1={x(w * WINDOW)} x2={x(w * WINDOW)} y1={TOP - 4} y2={height - 24} stroke="var(--muted)" strokeDasharray="3 4" opacity={0.6} />
            </g>
          ))}
          {[0, 50, 100, 150, 200, 250, 300].map((t) => (
            <text key={t} x={x(t)} y={height - 8} textAnchor={t === SPAN ? 'end' : 'middle'} fontSize={11.5} fill="var(--muted)">
              {t / 10} s
            </text>
          ))}

          <Lane index={0} label="Requests" sub={`${ts.length} sent`}>
            {ts.map((t, i) => (
              <circle key={i} cx={x(t)} cy={laneY(0)} r={3.2} fill="var(--ink-2)" opacity={0.75} />
            ))}
          </Lane>

          {results.map((r, li) => {
            const st = stats[li]
            const over = st.busiest > LIMIT
            return (
              <Lane
                key={r.id}
                index={li + 1}
                label={r.name}
                sub={`${st.allowed} allowed, busiest 10 s: ${st.busiest}`}
                subTone={over ? 'warn' : undefined}
              >
                {r.id === 'bucket' && (
                  <polyline
                    points={levels.map(([t, lv]) => `${x(t).toFixed(1)},${(laneY(li + 1) + 13 - (lv / CAPACITY) * 26).toFixed(1)}`).join(' ')}
                    fill="none"
                    stroke="var(--w3)"
                    strokeWidth={1.25}
                    opacity={0.7}
                  />
                )}
                {ts.map((t, i) =>
                  r.ok[i] ? (
                    <circle key={i} cx={x(t)} cy={laneY(li + 1)} r={3.2} fill="var(--done)" />
                  ) : (
                    <g key={i} stroke="var(--bad)" strokeWidth={1.6}>
                      <line x1={x(t) - 3} y1={laneY(li + 1) - 3} x2={x(t) + 3} y2={laneY(li + 1) + 3} />
                      <line x1={x(t) - 3} y1={laneY(li + 1) + 3} x2={x(t) + 3} y2={laneY(li + 1) - 3} />
                    </g>
                  ),
                )}
              </Lane>
            )
          })}
        </svg>
      </div>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-done" /> allowed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-semibold text-bad">×</span> rejected
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-[var(--w3)]" /> tokens left in the bucket
        </span>
        <span>Dashed lines: where the fixed windows reset</span>
      </p>

      <Narration>{notes[preset]}</Narration>
    </WidgetFrame>
  )
}

const laneY = (i: number) => TOP + LANE * i + LANE / 2

function Lane({ index, label, sub, subTone, children }: { index: number; label: string; sub: string; subTone?: 'warn'; children: ReactNode }) {
  const y = laneY(index)
  return (
    <g>
      {index > 0 && <line x1={6} x2={RIGHT + 6} y1={y - LANE / 2} y2={y - LANE / 2} stroke="var(--rule)" />}
      <text x={6} y={y - 2} fontSize={13} fontWeight={600} fill="var(--ink)">
        {label}
      </text>
      <text x={6} y={y + 13} fontSize={11} fill={subTone ? 'var(--warn)' : 'var(--muted)'} fontWeight={subTone ? 600 : 400}>
        {sub}
      </text>
      {children}
    </g>
  )
}
