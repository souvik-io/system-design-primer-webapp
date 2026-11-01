import { useMemo, useState } from 'react'
import { Button, Narration, Stat, WidgetFrame } from './ui'

// Rotary position embedding (RoFormer, arXiv 2104.09864) for one 128-wide head with Llama 3's base of
// 500,000 (content/infra/transformer-as-workload.md, "Positions and RoPE"). Pair i of the head rotates by
// position x theta_i, with theta_i = base^(-2i/128). The query and key here are fixed random vectors; only
// their positions change. The score q . k depends on the positions only through their difference.
// Llama 3.1's long-context rescaling of the slow frequencies is left out to keep the picture simple.

const HEAD_DIM = 128
const PAIRS = HEAD_DIM / 2
const BASE = 500_000
const THETA = Array.from({ length: PAIRS }, (_, i) => BASE ** ((-2 * i) / HEAD_DIM))
const SHOWN = [0, 12, 24, 63]
const MAX_POS = 8192

/** Seeded normal draws, so the vectors are the same on every visit. */
function normals(n: number, seed: number) {
  let a = seed
  const rand = () => {
    a = (a * 1103515245 + 12345) % 2147483648
    return (a + 1) / 2147483649
  }
  return Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()))
}

// Each pair as (length, angle) for the query and the key.
const Q = normals(HEAD_DIM, 7)
const K = normals(HEAD_DIM, 11)
const pairs = Array.from({ length: PAIRS }, (_, i) => ({
  q: { r: Math.hypot(Q[i], Q[i + PAIRS]), a: Math.atan2(Q[i + PAIRS], Q[i]) },
  k: { r: Math.hypot(K[i], K[i + PAIRS]), a: Math.atan2(K[i + PAIRS], K[i]) },
}))
const score = (distance: number) =>
  pairs.reduce((s, p, i) => s + p.q.r * p.k.r * Math.cos(p.q.a - p.k.a + distance * THETA[i]), 0) / Math.sqrt(HEAD_DIM)

const wavelength = (theta: number) => (2 * Math.PI) / theta
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n).toLocaleString()}` : n.toFixed(1))

export default function RopeRotation() {
  const [queryPos, setQueryPos] = useState(1200)
  const [keyPos, setKeyPos] = useState(1000)
  const [lastShift, setLastShift] = useState<number | null>(null)

  const distance = queryPos - keyPos
  const s = score(distance)
  const curve = useMemo(() => Array.from({ length: 241 }, (_, i) => score((i / 240) * 2048)), [])
  const lo = Math.min(...curve)
  const hi = Math.max(...curve)

  const shift = (by: number) => {
    const next = Math.min(MAX_POS - Math.max(queryPos, keyPos), Math.max(-Math.min(queryPos, keyPos), by))
    setQueryPos(queryPos + next)
    setKeyPos(keyPos + next)
    setLastShift(next)
  }

  // Score chart geometry
  const W = 640
  const H = 130
  const L = 40
  const R = 12
  const T = 18
  const B = 26
  const xOf = (d: number) => L + (d / 2048) * (W - L - R)
  const yOf = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B)

  return (
    <WidgetFrame
      title="Try it: rotate a query and a key by their positions"
      description="Each dial is one pair of numbers in a 128-wide head, rotated by position times its own frequency. Move the query and the key, or shift both together, and watch the attention score."
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Position label="Query position" value={queryPos} onChange={(v) => (setQueryPos(v), setLastShift(null))} color="var(--w1)" />
        <Position label="Key position" value={keyPos} onChange={(v) => (setKeyPos(v), setLastShift(null))} color="var(--w3)" />
        <Button onClick={() => shift(1000)}>Shift both +1,000</Button>
        <Button onClick={() => shift(-1000)}>Shift both −1,000</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SHOWN.map((i) => (
          <Dial key={i} pair={i} queryPos={queryPos} keyPos={keyPos} />
        ))}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Attention score against the distance between query and key; now ${s.toFixed(2)} at distance ${distance}`}
      >
        <text x={L} y={12} fontSize={11.5} fill="var(--ink-2)">
          Score q · k / √128 against distance (query position − key position)
        </text>
        <line x1={L} x2={W - R} y1={yOf(0)} y2={yOf(0)} stroke="var(--rule)" />
        <polyline points={curve.map((v, i) => `${xOf((i / 240) * 2048)},${yOf(v)}`).join(' ')} fill="none" stroke="var(--ink-2)" strokeWidth={1.25} />
        {[0, 512, 1024, 1536, 2048].map((d) => (
          <text key={d} x={xOf(d)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {d.toLocaleString()}
          </text>
        ))}
        {distance >= 0 && distance <= 2048 && (
          <circle cx={xOf(distance)} cy={yOf(s)} r={6} fill="var(--w1)" stroke="var(--surface)" strokeWidth={2} />
        )}
      </svg>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Distance" value={distance.toLocaleString()} />
        <Stat label="Attention score" value={s.toFixed(3)} />
        <Stat label="Fastest pair turns once every" value={`${wavelength(THETA[0]).toFixed(1)} tokens`} />
      </div>

      <Narration tone={lastShift ? 'good' : undefined}>
        {lastShift
          ? `Both moved by ${lastShift.toLocaleString()}. Every dial turned, but the angle between the two arrows in each dial did not change, so the score is still ${s.toFixed(3)}. RoPE scores depend only on the distance between tokens.`
          : distance < 0
            ? `The key is after the query. A causal model never computes this score, because a token only attends to earlier positions.`
            : `The query is ${distance.toLocaleString()} tokens after the key. The fast pairs on the left spin many times over that distance and the slow ones barely move, so together they encode both short and long distances. A key is rotated once at its own position and cached, which is why a cached prefix is reusable only at the same positions.`}
      </Narration>
    </WidgetFrame>
  )
}

function Position({ label, value, onChange, color }: { label: string; value: number; onChange: (v: number) => void; color: string }) {
  return (
    <label className="flex items-center gap-2 text-[0.8125rem] text-muted">
      <span className="size-2.5 rounded-full" style={{ background: color }} />
      {label}
      <input
        type="range"
        min={0}
        max={MAX_POS}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-32 accent-[var(--accent)]"
      />
      <span className="w-12 text-ink tabular-nums">{value.toLocaleString()}</span>
    </label>
  )
}

function Dial({ pair, queryPos, keyPos }: { pair: number; queryPos: number; keyPos: number }) {
  const p = pairs[pair]
  const qa = p.q.a + queryPos * THETA[pair]
  const ka = p.k.a + keyPos * THETA[pair]
  const r = 40
  const c = 50
  const arrow = (angle: number, len: number) => ({ x: c + Math.cos(angle) * len, y: c - Math.sin(angle) * len })
  const q = arrow(qa, r * 0.9)
  const k = arrow(ka, r * 0.75)
  return (
    <figure className="flex flex-col items-center rounded-lg border border-rule bg-paper/50 p-2">
      <svg viewBox="0 0 100 100" className="w-full max-w-[8rem]" role="img" aria-label={`Pair ${pair}: query and key arrows`}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--rule)" strokeWidth={1.5} />
        <line x1={c} y1={c} x2={q.x} y2={q.y} stroke="var(--w1)" strokeWidth={3} strokeLinecap="round" />
        <line x1={c} y1={c} x2={k.x} y2={k.y} stroke="var(--w3)" strokeWidth={3} strokeLinecap="round" />
        <circle cx={c} cy={c} r={2.5} fill="var(--ink-2)" />
      </svg>
      <figcaption className="text-center text-[0.72rem] leading-snug text-muted">
        pair {pair}: one turn per {tokens(wavelength(THETA[pair]))} tokens
      </figcaption>
    </figure>
  )
}
