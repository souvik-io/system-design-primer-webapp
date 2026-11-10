import { useEffect, useMemo, useState } from 'react'
import { Button, Key, Narration, Segmented, SERIES, Stat, WidgetFrame } from './ui'
import { label, MAX_TOKENS, POOL, REQUESTS, simulate, type Mode } from './pagedKvSim'

// A pool of 128 KV slots serves ten requests step by step, either by reserving each sequence's maximum length up
// front or by handing out fixed-size blocks as sequences grow (PagedAttention). The grid shows every slot: solid
// slots hold a token's keys and values, pale ones are allocated but still empty, outlined ones are free. The rules
// are in pagedKvSim.ts.

const COLS = 16
const CELL = 33
const ROW_H = 27
const W = COLS * CELL + 2
const H = (POOL / COLS) * ROW_H + 2

export default function PagedKvAllocator() {
  const [mode, setMode] = useState<Mode>('reserve')
  const [blockSize, setBlockSize] = useState(4)
  const [samples, setSamples] = useState<1 | 2>(1)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const snaps = useMemo(() => simulate(mode, blockSize, samples), [mode, blockSize, samples])
  const other = useMemo(() => simulate(mode === 'paged' ? 'reserve' : 'paged', blockSize, samples), [mode, blockSize, samples])
  const last = snaps.length - 1
  const now = Math.min(t, last)
  const s = snaps[now]
  const done = now === last

  useEffect(() => {
    if (!playing) return
    if (done) {
      setPlaying(false)
      return
    }
    const id = setTimeout(() => setT((x) => x + 1), 450)
    return () => clearTimeout(id)
  }, [playing, done, t])

  const reset = () => {
    setPlaying(false)
    setT(0)
  }
  const color = (seq: number) => SERIES[Math.floor(seq / 2) % SERIES.length]
  const L = (seq: number) => label(seq, samples)
  const util = (x: typeof s) => (x.allocated ? x.used / x.allocated : 0)
  const avgUtil = (xs: typeof snaps) => xs.slice(1).reduce((a, x) => a + util(x), 0) / Math.max(1, xs.length - 1)

  let note: string
  if (now === 0) {
    note =
      mode === 'reserve'
        ? `Each sequence will reserve its prompt plus ${MAX_TOKENS} slots, the most output any request may ask for, in one contiguous region. Press Step or Play.`
        : `Each sequence will take ${blockSize}-slot blocks from the free list only as it needs them, wherever they are. Press Step or Play.`
  } else if (done) {
    const o = other[other.length - 1]
    note =
      `All ${REQUESTS.length} requests finished in ${last} steps, with ${Math.round(avgUtil(snaps) * 100)}% of allocated slots holding keys and values on average. ` +
      `${mode === 'paged' ? 'Reserving the maximum length' : `Paging with ${blockSize}-slot blocks`} takes ${o.step} steps at ${Math.round(avgUtil(other) * 100)}%` +
      (o.preemptions ? `, with ${o.preemptions} preemptions.` : '.')
  } else if (s.events.length) {
    note = s.events.join(' ')
  } else if (mode === 'reserve') {
    note = `${s.running.length} sequences run, but only ${Math.round(util(s) * 100)}% of the slots they hold contain keys and values: the rest is reserved for output that may never come.`
  } else {
    note = `${s.running.length} sequences run. Each takes a new block only when its last one fills, so at most ${blockSize - 1} slots per sequence sit empty.`
  }

  return (
    <WidgetFrame
      title="Try it: a paged KV cache under load"
      description={`A KV cache with room for ${POOL} tokens serves ${REQUESTS.length} requests. Each step, every running sequence adds one token. Compare reserving each sequence's maximum length with paging, then change the block size and add a second sample per request.`}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Segmented
          label="Allocation"
          value={mode}
          options={[
            { value: 'reserve', label: 'Reserve max length' },
            { value: 'paged', label: 'Paged' },
          ]}
          onChange={(v) => (setMode(v), reset())}
        />
        <Segmented
          label="Block size"
          value={blockSize}
          options={[2, 4, 8, 16].map((b) => ({ value: b, label: String(b) }))}
          onChange={(v) => (setBlockSize(v), reset())}
        />
        <Segmented
          label="Samples per request"
          value={samples}
          options={[
            { value: 1, label: '1' },
            { value: 2, label: '2' },
          ]}
          onChange={(v) => (setSamples(v), reset())}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" onClick={() => setT((x) => Math.min(x + 1, last))} disabled={done}>
          Step
        </Button>
        <Button onClick={() => (done ? (setT(0), setPlaying(true)) : setPlaying((p) => !p))} pressed={playing}>
          {playing ? 'Pause' : done ? 'Replay' : 'Play'}
        </Button>
        <Button onClick={reset} disabled={now === 0}>
          Reset
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-rule bg-paper/50 p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[30rem]" role="img" aria-label={`The ${POOL} KV cache slots at step ${now}`}>
          {s.slots.map((slot, i) => {
            const x = 1 + (i % COLS) * CELL
            const y = 1 + Math.floor(i / COLS) * ROW_H
            const owned = slot.owner >= 0
            return (
              <g key={i}>
                <rect
                  x={x + 1.5}
                  y={y + 1.5}
                  width={CELL - 3}
                  height={ROW_H - 3}
                  rx={2}
                  fill={owned ? color(slot.owner) : 'none'}
                  opacity={owned ? (slot.used ? 0.92 : 0.22) : 1}
                  stroke={owned ? 'none' : 'var(--rule)'}
                />
                {slot.blockStart && owned && (
                  <text x={x + 5} y={y + ROW_H / 2 + 4} fontSize={10.5} fontWeight={600} fill={slot.used ? 'var(--on-accent)' : 'var(--ink)'}>
                    {L(slot.owner)}
                    {slot.shared > 1 ? '×2' : ''}
                  </text>
                )}
              </g>
            )
          })}
          {mode === 'paged' &&
            Array.from({ length: POOL / blockSize }, (_, b) => {
              const first = b * blockSize
              return (
                <rect
                  key={b}
                  x={1 + (first % COLS) * CELL + 0.5}
                  y={1 + Math.floor(first / COLS) * ROW_H + 0.5}
                  width={blockSize * CELL - 1}
                  height={ROW_H - 1}
                  rx={3}
                  fill="none"
                  stroke="var(--ink-2)"
                  strokeOpacity={0.45}
                />
              )
            })}
        </svg>
      </div>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="var(--w1)">holds a token's keys and values</Key>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm opacity-25" style={{ background: 'var(--w1)' }} />
          allocated, still empty
        </span>
        <span>{mode === 'paged' ? 'Outlines mark blocks; ×2 marks a block two samples share.' : 'Each region starts at its label.'}</span>
      </p>

      <div className="flex flex-wrap items-center gap-1.5 text-[0.8125rem]">
        <span className="mr-1 text-muted">Waiting:</span>
        {s.waiting.length === 0 ? (
          <span className="text-muted">none</span>
        ) : (
          s.waiting.map((id) => (
            <span key={id} className="rounded border border-rule bg-paper px-1.5 py-0.5 font-semibold tabular-nums">
              {L(id)}
            </span>
          ))
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Step" value={`${now}`} />
        <Stat label="Running / finished" value={`${s.running.length} / ${s.finished} of ${REQUESTS.length}`} />
        <Stat
          label="Allocated slots holding KV"
          value={now ? `${s.used} of ${s.allocated} (${Math.round(util(s) * 100)}%)` : '–'}
          tone={now ? (util(s) > 0.8 ? 'good' : 'warn') : undefined}
        />
        <Stat
          label={samples === 2 && mode === 'paged' ? 'Preemptions / copies' : 'Preemptions (tokens redone)'}
          value={samples === 2 && mode === 'paged' ? `${s.preemptions} / ${s.copies}` : `${s.preemptions} (${s.recomputed})`}
          tone={s.preemptions ? 'warn' : undefined}
        />
      </div>

      <Narration tone={done ? 'good' : undefined}>{note}</Narration>
    </WidgetFrame>
  )
}
