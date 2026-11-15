import { useMemo, useState } from 'react'
import { Key, Narration, SERIES, Segmented, Stat, WidgetFrame } from './ui'

// Mean versus percentiles for content/cpp/cpp-log-analyzer.md. A fixed, seeded sample of 10,000 request latencies:
// every request has a "fast" latency drawn from a log-normal distribution with a 40 ms median, and a chosen share
// of them is made slower by a chosen factor. The same random numbers are reused for every setting, so changing a
// control changes only the tail. Percentiles use the nearest-rank definition, as in the project's analyzers.

const N = 10_000
const MEDIAN_MS = 40
const SIGMA = 0.35

type Share = 0 | 0.5 | 1 | 2 | 5 | 10
type Factor = 5 | 20 | 50

const SHARES: { value: Share; label: string }[] = [
  { value: 0, label: '0%' },
  { value: 0.5, label: '0.5%' },
  { value: 1, label: '1%' },
  { value: 2, label: '2%' },
  { value: 5, label: '5%' },
  { value: 10, label: '10%' },
]

const FACTORS: { value: Factor; label: string }[] = [
  { value: 5, label: '5×' },
  { value: 20, label: '20×' },
  { value: 50, label: '50×' },
]

// mulberry32: a small seeded generator, so the sample is the same on every visit.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// For each request: a standard normal value (its fast latency) and a uniform value (whether it is slow).
const BASE = (() => {
  const r = rng(20251115)
  const z: number[] = []
  const u: number[] = []
  for (let i = 0; i < N; i++) {
    const u1 = Math.max(r(), 1e-12)
    const u2 = r()
    z.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)) // Box-Muller
    u.push(r())
  }
  return { z, u }
})()

type Sample = { ms: number; slow: boolean }
type Summary = { sorted: Sample[]; slowCount: number; mean: number; p50: Sample; p95: Sample; p99: Sample }

/** The 0-based index of the nearest-rank percentile: ceil(permille * n / 1000) - 1. */
const rankIndex = (n: number, permille: number) => Math.max(Math.ceil((permille * n) / 1000), 1) - 1

function summarize(share: number, factor: number): Summary {
  const samples: Sample[] = BASE.z.map((z, i) => {
    const fast = MEDIAN_MS * Math.exp(SIGMA * z)
    const slow = BASE.u[i] < share / 100
    return { ms: slow ? fast * factor : fast, slow }
  })
  const sorted = [...samples].sort((a, b) => a.ms - b.ms)
  const mean = samples.reduce((s, x) => s + x.ms, 0) / N
  return {
    sorted,
    slowCount: samples.filter((s) => s.slow).length,
    mean,
    p50: sorted[rankIndex(N, 500)],
    p95: sorted[rankIndex(N, 950)],
    p99: sorted[rankIndex(N, 990)],
  }
}

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`)

// The histogram: logarithmic bins from 10 ms to 10 s, twelve per factor of ten.
const LO = 10
const HI = 10_000
const BINS = 36
const W = 600
const H = 230
const L = 12
const R = 12
const T = 64
const B = 26
const xOf = (ms: number) => L + ((Math.log10(Math.min(Math.max(ms, LO), HI)) - 1) / 3) * (W - L - R)
const TICKS = [10, 30, 100, 300, 1000, 3000, 10000]
const tickLabel = (ms: number) => (ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`)

export default function LatencyPercentiles() {
  const [share, setShare] = useState<Share>(1)
  const [factor, setFactor] = useState<Factor>(20)

  const base = useMemo(() => summarize(0, 1), [])
  const s = useMemo(() => summarize(share, factor), [share, factor])

  const bins = useMemo(() => {
    const fast = new Array(BINS).fill(0)
    const slow = new Array(BINS).fill(0)
    for (const x of s.sorted) {
      const k = Math.min(BINS - 1, Math.max(0, Math.floor(((Math.log10(x.ms) - 1) / 3) * BINS)))
      if (x.slow) slow[k]++
      else fast[k]++
    }
    return { fast, slow, max: Math.max(...fast.map((f, k) => f + slow[k])) }
  }, [s])

  const binW = (W - L - R) / BINS
  const plotH = H - T - B
  // Square-root heights, so that a tail of a few dozen requests is still visible next to a peak of thousands.
  const hOf = (count: number) => (Math.sqrt(count) / Math.sqrt(bins.max)) * plotH

  const markers = [
    { label: 'mean', ms: s.mean, color: 'var(--ink-2)', dash: '4 3' },
    { label: 'p50', ms: s.p50.ms, color: SERIES[1], dash: undefined },
    { label: 'p95', ms: s.p95.ms, color: SERIES[3], dash: undefined },
    { label: 'p99', ms: s.p99.ms, color: SERIES[4], dash: undefined },
  ]

  let story: string
  if (share === 0) {
    story =
      `With no slow requests, all the spread is ordinary variation: the mean (${fmt(s.mean)}) sits next to the median (${fmt(s.p50.ms)}), ` +
      `and p99 is ${(s.p99.ms / s.p50.ms).toFixed(1)}× the median. Now add some slow requests.`
  } else {
    const p99Text = s.p99.slow
      ? `p99 jumped from ${fmt(base.p99.ms)} to ${fmt(s.p99.ms)}: the 99th percentile now lands on a slow request.`
      : `p99 is still a fast request, ${fmt(s.p99.ms)}: when no more than about 1 request in 100 is slow, the whole tail fits above the 99th percentile, and only p99.9 or the maximum would show it.`
    story =
      `${s.slowCount.toLocaleString()} of ${N.toLocaleString()} requests are ${factor}× slower. ` +
      `The median barely moved, from ${fmt(base.p50.ms)} to ${fmt(s.p50.ms)}, because most requests are still fast. ${p99Text} ` +
      `The mean rose from ${fmt(base.mean)} to ${fmt(s.mean)}: it reacts to the tail, but it cannot tell you whether many requests got a little slower or a few got much slower.`
  }

  return (
    <WidgetFrame
      title="Mean, median and the tail"
      description="10,000 simulated request latencies. Make some of them slow and watch which numbers notice."
    >
      <div className="flex flex-col gap-2.5">
        <Segmented label="Slow requests" value={share} options={SHARES} onChange={setShare} />
        <Segmented label="How much slower" value={factor} options={FACTORS} onChange={setFactor} />
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Histogram of latencies on a logarithmic axis. Mean ${fmt(s.mean)}, p50 ${fmt(s.p50.ms)}, p95 ${fmt(s.p95.ms)}, p99 ${fmt(s.p99.ms)}.`}
      >
        {TICKS.map((t) => (
          <g key={t}>
            <line x1={xOf(t)} x2={xOf(t)} y1={T} y2={H - B} stroke="var(--rule)" strokeWidth={1} />
            <text x={xOf(t)} y={H - B + 16} textAnchor={t === LO ? 'start' : t === HI ? 'end' : 'middle'} fontSize={12} fill="var(--muted)">
              {tickLabel(t)}
            </text>
          </g>
        ))}
        {bins.fast.map((f, k) => {
          const hf = f > 0 ? hOf(f) : 0
          const hs = bins.slow[k] > 0 ? hOf(f + bins.slow[k]) - hf : 0
          const x = L + k * binW + 1
          return (
            <g key={k}>
              {hf > 0 && <rect x={x} y={H - B - hf} width={binW - 2} height={hf} fill={SERIES[0]} />}
              {hs > 0 && <rect x={x} y={H - B - hf - hs} width={binW - 2} height={hs} fill={SERIES[2]} />}
            </g>
          )
        })}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="var(--muted)" strokeWidth={1} />
        {markers.map((m, level) => {
          const x = xOf(m.ms)
          const y = 14 + level * 13
          const right = x > W - 110
          return (
            <g key={m.label}>
              <line x1={x} x2={x} y1={y + 3} y2={H - B} stroke={m.color} strokeWidth={2} strokeDasharray={m.dash} />
              <text
                x={right ? x - 5 : x + 5}
                y={y + 4}
                textAnchor={right ? 'end' : 'start'}
                fontSize={12}
                fontWeight={600}
                fill={m.color}
                stroke="var(--surface)"
                strokeWidth={4}
                paintOrder="stroke"
              >
                {m.label} {fmt(m.ms)}
              </text>
            </g>
          )
        })}
      </svg>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted">
        <Key color={SERIES[0]}>fast requests</Key>
        <Key color={SERIES[2]}>slow requests</Key>
        <span>Bar height grows with the square root of the count, so a small tail stays visible.</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="mean" value={fmt(s.mean)} />
        <Stat label="p50" value={fmt(s.p50.ms)} />
        <Stat label="p95" value={fmt(s.p95.ms)} tone={s.p95.slow ? 'bad' : undefined} />
        <Stat label="p99" value={fmt(s.p99.ms)} tone={s.p99.slow ? 'bad' : undefined} />
        <Stat label="p99 ÷ p50" value={`${(s.p99.ms / s.p50.ms).toFixed(1)}×`} />
      </div>

      <Narration>{story}</Narration>
    </WidgetFrame>
  )
}
