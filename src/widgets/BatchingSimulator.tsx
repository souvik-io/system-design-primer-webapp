import { useEffect, useMemo, useState } from 'react'
import { Button, Narration, Segmented, SERIES, Stat, WidgetFrame } from './ui'

// A GPU with four batch slots works through a queue of requests that each want a different number of
// output tokens. Every step, each busy slot produces one token. Static batching refills only when the
// whole batch has finished; continuous batching refills a slot as soon as its request is done.
// Prefill is left out to keep the picture simple.

type Mode = 'static' | 'continuous'

const SLOTS = 4
const DEFAULT = [12, 2, 6, 3, 9, 4, 2, 10, 5, 3, 7, 4]
const NAMES = 'ABCDEFGHIJKL'

type Schedule = {
  /** steps[t][slot] is the request in that slot during step t, or null if it's idle */
  steps: (number | null)[][]
  /** The step each request started and the step after its last token */
  start: number[]
  end: number[]
}

function schedule(lengths: number[], mode: Mode): Schedule {
  const queue = lengths.map((_, i) => i)
  const left = [...lengths]
  const slot: (number | null)[] = Array(SLOTS).fill(null)
  const steps: (number | null)[][] = []
  const start = lengths.map(() => -1)
  const end = lengths.map(() => -1)
  while (queue.length || slot.some((r) => r !== null)) {
    if (mode === 'continuous' || slot.every((r) => r === null)) {
      for (let k = 0; k < SLOTS && queue.length; k++) {
        if (slot[k] !== null) continue
        const r = queue.shift()!
        slot[k] = r
        start[r] = steps.length
      }
    }
    steps.push([...slot])
    for (let k = 0; k < SLOTS; k++) {
      const r = slot[k]
      if (r === null) continue
      if (--left[r] === 0) {
        end[r] = steps.length
        slot[k] = null
      }
    }
  }
  return { steps, start, end }
}

function summary(s: Schedule, upTo: number) {
  const busy = s.steps.slice(0, upTo).reduce((n, row) => n + row.filter((r) => r !== null).length, 0)
  const started = s.start.filter((t) => t < upTo)
  return {
    finished: s.end.filter((t) => t <= upTo).length,
    utilization: upTo ? busy / (SLOTS * upTo) : 0,
    avgWait: started.length ? started.reduce((a, b) => a + b, 0) / started.length : 0,
  }
}

/** Twelve lengths between 1 and 12 from a small seeded generator (mulberry32), so "new requests" is repeatable. */
function randomLengths(seed: number) {
  let a = seed
  return DEFAULT.map(() => {
    a = (a + 0x6d2b79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return 1 + (((x ^ (x >>> 14)) >>> 0) % 12)
  })
}

// Layout
const VIEW_W = 556
const LEFT = 58
const RIGHT = 548
const ROW = 30
const TOP = 6

export default function BatchingSimulator() {
  const [mode, setMode] = useState<Mode>('static')
  const [seed, setSeed] = useState(0)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const lengths = useMemo(() => (seed === 0 ? DEFAULT : randomLengths(seed)), [seed])
  const both = useMemo(() => ({ static: schedule(lengths, 'static'), continuous: schedule(lengths, 'continuous') }), [lengths])
  const s = both[mode]
  const total = s.steps.length
  const now = Math.min(t, total)
  const done = now === total
  const stats = summary(s, now)
  const other = mode === 'static' ? 'continuous' : 'static'

  useEffect(() => {
    if (!playing) return
    if (done) {
      setPlaying(false)
      return
    }
    const id = setTimeout(() => setT((x) => x + 1), 420)
    return () => clearTimeout(id)
  }, [playing, done, t])

  // Both modes share one horizontal scale, so switching between them shows the difference in length.
  const span = Math.max(both.static.steps.length, both.continuous.steps.length)
  const cell = (RIGHT - LEFT) / span
  const x = (step: number) => LEFT + step * cell
  const height = TOP + ROW * SLOTS + 24
  const tick = span > 30 ? 10 : 5

  const waiting = lengths.map((_, i) => i).filter((r) => s.start[r] >= now)
  const finishedAll = summary(s, total)
  const otherAll = summary(both[other], both[other].steps.length)

  let note: string
  if (now === 0) {
    note = `${lengths.length} requests are waiting, each wanting a different number of tokens (the number on each one). Press Step or Play.`
  } else if (done) {
    note =
      `All ${lengths.length} requests finished in ${total} steps. The slots were busy ${pct(finishedAll.utilization)} of the time, and a request waited ${finishedAll.avgWait.toFixed(1)} steps on average before it started. ` +
      `${other === 'continuous' ? 'Continuous' : 'Static'} batching takes ${both[other].steps.length} steps for the same requests, with the slots busy ${pct(otherAll.utilization)} of the time.`
  } else if (mode === 'static') {
    const idle = s.steps[now - 1].filter((r) => r === null).length
    note =
      idle && waiting.length
        ? `${idle} of ${SLOTS} slots ${idle === 1 ? 'is' : 'are'} idle while ${waiting.length} ${waiting.length === 1 ? 'request waits' : 'requests wait'}. Static batching takes new work only when every request in the batch has finished, so the batch moves at the pace of its longest request.`
        : 'The batch is running. Static batching takes new work only when every request in it has finished.'
  } else {
    // After step 0, a request only starts when another one has just freed its slot.
    const refilled = s.start.some((st) => st > 0 && st === now - 1)
    note = refilled
      ? 'A request finished, and the next one in the queue took its slot at the very next step. The scheduler decides who runs at every step, so slots rarely sit idle while work is waiting.'
      : 'Every step, the scheduler checks for free slots and fills them from the queue.'
  }

  return (
    <WidgetFrame
      title="Try it: static and continuous batching"
      description={`A GPU with ${SLOTS} batch slots serves a queue of requests. Each step, every busy slot generates one token. Run both modes on the same requests and compare how long they take and how busy the slots stay.`}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Segmented
          label="Batching"
          value={mode}
          options={[
            { value: 'static', label: 'Static' },
            { value: 'continuous', label: 'Continuous' },
          ]}
          onChange={setMode}
        />
        <div className="flex flex-wrap gap-2">
          <Button tone="primary" onClick={() => setT((x) => Math.min(x + 1, total))} disabled={done}>
            Step
          </Button>
          <Button onClick={() => (done ? (setT(0), setPlaying(true)) : setPlaying((p) => !p))} pressed={playing}>
            {playing ? 'Pause' : done ? 'Replay' : 'Play'}
          </Button>
          <Button onClick={() => (setPlaying(false), setT(0))} disabled={now === 0}>
            Reset
          </Button>
          <Button onClick={() => (setPlaying(false), setT(0), setSeed((n) => n + 1))}>New requests</Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-rule bg-paper/50 p-2">
        <svg
          viewBox={`0 0 ${VIEW_W} ${height}`}
          className="block w-full min-w-[30rem]"
          role="img"
          aria-label={`Which request each of the ${SLOTS} slots worked on at each step, up to step ${now}`}
        >
          {Array.from({ length: SLOTS }, (_, k) => (
            <g key={k}>
              <text x={6} y={TOP + ROW * k + ROW / 2 + 4} fontSize={12} fill="var(--muted)">
                Slot {k + 1}
              </text>
              <rect x={LEFT} y={TOP + ROW * k + 3} width={RIGHT - LEFT} height={ROW - 6} rx={3} fill="var(--rule)" opacity={0.35} />
            </g>
          ))}
          {s.steps.slice(0, now).map((row, step) =>
            row.map((r, k) => {
              if (r === null) return null
              const first = s.start[r] === step
              return (
                <g key={`${step}-${k}`}>
                  <rect
                    x={x(step) + 0.5}
                    y={TOP + ROW * k + 3}
                    width={cell - 1}
                    height={ROW - 6}
                    rx={2}
                    fill={SERIES[r % SERIES.length]}
                    opacity={r % 2 ? 0.7 : 0.95}
                  />
                  {first && (
                    <text x={x(step) + 4} y={TOP + ROW * k + ROW / 2 + 4} fontSize={11.5} fontWeight={600} fill="var(--on-accent)">
                      {NAMES[r]}
                    </text>
                  )}
                </g>
              )
            }),
          )}
          {now > 0 && !done && (
            <line x1={x(now)} x2={x(now)} y1={TOP} y2={TOP + ROW * SLOTS} stroke="var(--ink-2)" strokeWidth={1.25} strokeDasharray="3 3" />
          )}
          {Array.from({ length: Math.floor(span / tick) + 1 }, (_, i) => i * tick).map((step) => (
            <text key={step} x={x(step)} y={height - 6} textAnchor={step === 0 ? 'start' : 'middle'} fontSize={11} fill="var(--muted)">
              {step}
            </text>
          ))}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[0.8125rem]">
        <span className="mr-1 text-muted">Waiting:</span>
        {waiting.length === 0 ? (
          <span className="text-muted">none</span>
        ) : (
          waiting.map((r) => (
            <span key={r} className="rounded border border-rule bg-paper px-1.5 py-0.5 tabular-nums">
              <span className="font-semibold">{NAMES[r]}</span> <span className="text-muted">{lengths[r]}</span>
            </span>
          ))
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Step" value={`${now} of ${total}`} />
        <Stat label="Finished" value={`${stats.finished} of ${lengths.length}`} />
        <Stat label="Slots busy" value={now ? pct(stats.utilization) : '–'} tone={now ? (stats.utilization > 0.85 ? 'good' : 'warn') : undefined} />
        <Stat label="Average wait to start" value={now ? `${stats.avgWait.toFixed(1)} steps` : '–'} />
      </div>

      <Narration tone={done ? 'good' : undefined}>{note}</Narration>
    </WidgetFrame>
  )
}

const pct = (x: number) => `${Math.round(x * 100)}%`
