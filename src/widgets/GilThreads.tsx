import { useState } from 'react'
import { IndexSlider, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// Threads calling a native function, with the function holding or releasing the GIL
// (content/infra/native-code.md). Each call spends part of its time in Python, which needs the GIL, and the rest in
// C++. A function that holds the GIL turns the whole call into one GIL-holding stretch, so threads take turns; one
// that releases it (pybind11's gil_scoped_release) lets the C++ parts of different threads overlap. The simulation
// assumes a CPU core per thread and hands the GIL over in arrival order. native_sampler.py measured 1.0 times the
// one-thread throughput on 4 threads when holding the GIL and 3.5 times when releasing it, on an M2.

const THREADS = [1, 2, 4, 8]
const PY_SHARE = [0.02, 0.1, 0.25, 0.5]
const CALLS = 4
const CALL = 10 // time units per call
const DT = 0.05

type Kind = 'py' | 'held' | 'free' | 'wait'
type Seg = { gil: boolean; len: number; kind: Kind }

function simulate(threads: number, pyShare: number, release: boolean) {
  const py = CALL * pyShare
  const native = CALL - py
  const plan: Seg[][] = Array.from({ length: threads }, () => {
    const segs: Seg[] = []
    for (let c = 0; c < CALLS; c++) {
      if (release) segs.push({ gil: true, len: py, kind: 'py' }, { gil: false, len: native, kind: 'free' })
      else segs.push({ gil: true, len: CALL, kind: 'held' }) // the GIL is held through the C++ part too
    }
    return segs
  })
  const pos = plan.map(() => 0)
  const left = plan.map((s) => s[0].len)
  const lanes: [number, number, Kind][][] = plan.map(() => [])
  const queue: number[] = []
  let owner: number | null = null
  let t = 0
  const mark = (i: number, kind: Kind) => {
    const lane = lanes[i]
    const last = lane[lane.length - 1]
    if (last && last[2] === kind && Math.abs(last[1] - t) < 1e-9) last[1] = t + DT
    else lane.push([t, t + DT, kind])
  }
  while (pos.some((p, i) => p < plan[i].length) && t < 1000) {
    plan.forEach((segs, i) => {
      if (pos[i] < segs.length && segs[pos[i]].gil && owner !== i && !queue.includes(i)) queue.push(i)
    })
    if (owner === null && queue.length) owner = queue.shift()!
    plan.forEach((segs, i) => {
      if (pos[i] >= segs.length) return
      const seg = segs[pos[i]]
      if (seg.gil && owner !== i) return mark(i, 'wait')
      mark(i, seg.kind === 'py' ? 'py' : seg.kind)
      left[i] -= DT
      if (left[i] <= 1e-9) {
        if (seg.gil) owner = null
        pos[i]++
        if (pos[i] < segs.length) left[i] = segs[pos[i]].len
      }
    })
    t += DT
  }
  return { lanes, wall: t }
}

const COLORS: Record<Kind, string> = { py: 'var(--w3)', held: 'var(--w4)', free: 'var(--w1)', wait: 'var(--bad-soft)' }

export default function GilThreads() {
  const [threadsI, setThreadsI] = useState(2)
  const [shareI, setShareI] = useState(1)
  const [release, setRelease] = useState(false)
  const threads = THREADS[threadsI]
  const share = PY_SHARE[shareI]
  const run = simulate(threads, share, release)
  const speedup = (threads * CALLS * CALL) / run.wall
  const ideal = release ? Math.min(threads, 1 / share) : 1

  const W = 640
  const L = 64
  const row = 22
  const H = threads * row + 30
  const span = threads * CALLS * CALL // the time these threads would take if they ran one at a time
  const x = (v: number) => L + (v / span) * (W - L - 8)

  return (
    <WidgetFrame
      title="Try it: threads, native code and the GIL"
      description="Several Python threads each call a C++ function four times. Python code always needs the global interpreter lock. Choose whether the C++ function keeps holding the GIL or releases it while it works."
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
        <Segmented
          label="C++ function"
          value={release ? 'release' : 'hold'}
          options={[
            { value: 'hold', label: 'Holds the GIL' },
            { value: 'release', label: 'Releases the GIL' },
          ]}
          onChange={(v) => setRelease(v === 'release')}
        />
        <IndexSlider label="Threads" index={threadsI} max={THREADS.length - 1} onChange={setThreadsI} text={String(threads)} />
        <IndexSlider
          label="Share of each call in Python"
          index={shareI}
          max={PY_SHARE.length - 1}
          disabled={!release}
          onChange={setShareI}
          text={`${Math.round(share * 100)}%`}
        />
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${threads} threads finish in ${run.wall.toFixed(0)} time units`}
      >
        {run.lanes.map((lane, i) => (
          <g key={i}>
            <text x={0} y={i * row + 15} fontSize={11} fill="var(--muted)">
              Thread {i + 1}
            </text>
            {lane.map(([a, b, kind], j) => (
              <rect key={j} x={x(a)} y={i * row + 3} width={Math.max(0.6, x(b) - x(a))} height={row - 6} fill={COLORS[kind]} />
            ))}
          </g>
        ))}
        <line x1={x(run.wall)} x2={x(run.wall)} y1={0} y2={threads * row} stroke="var(--ink)" strokeDasharray="3 3" />
        <text x={L} y={H - 6} fontSize={10} fill="var(--muted)">
          0
        </text>
        <text x={W - 8} y={H - 6} textAnchor="end" fontSize={10} fill="var(--muted)">
          time if the threads ran one at a time
        </text>
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color={COLORS.py}>Python, holding the GIL</Key>
        <Key color={COLORS.held}>Python and C++, holding the GIL</Key>
        <Key color={COLORS.free}>C++, GIL released</Key>
        <Key color={COLORS.wait}>waiting for the GIL</Key>
      </p>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Calls finished" value={threads * CALLS} />
        <Stat
          label="Throughput against 1 thread"
          value={`${speedup.toFixed(1)}×`}
          tone={speedup > 1.5 ? 'good' : speedup < 1.1 ? 'bad' : undefined}
        />
        <Stat label="Limit from the Python share" value={release ? `${(1 / share).toFixed(0)}×` : '1×'} />
      </div>

      <Narration tone={speedup > 1.5 ? 'good' : threads > 1 ? 'bad' : undefined}>
        {threads === 1
          ? 'With one thread there is nothing to overlap. Add threads to see how they share the GIL.'
          : !release
            ? `The C++ function keeps the GIL for the whole call, so only one thread runs at a time and ${threads} threads give the throughput of one. The lab measured 1.0 times on 4 threads.`
            : speedup >= ideal * 0.9 && ideal === threads
              ? `Only the short Python part of each call needs the GIL, so the C++ parts of all ${threads} threads run at the same time, for ${speedup.toFixed(1)} times the throughput. On a real machine, each call runs a little slower when every core is busy, which lowers this: the lab measured 3.5 times on 4 threads.`
              : threads * share < 0.9
                ? `The C++ parts overlap, but the threads sometimes queue for the GIL for their Python parts, so throughput, ${speedup.toFixed(1)} times one thread, stays below the number of threads.`
                : `The C++ parts overlap, but every call still needs the GIL for its Python part, ${Math.round(share * 100)}% of the call. The GIL is busy almost all the time, so throughput cannot pass ${(1 / share).toFixed(0)} times one thread however many threads you add.`}
      </Narration>
    </WidgetFrame>
  )
}
