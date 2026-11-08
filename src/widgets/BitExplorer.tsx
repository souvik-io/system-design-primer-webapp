import { useMemo, useState } from 'react'
import { Button, IndexSlider, Key, Narration, Segmented, SERIES, Stat, WidgetFrame } from './ui'

// How a number is stored in each floating-point format, and how block scales let a 4-bit format hold real weights
// (content/infra/number-formats.md). Field widths and special values follow IEEE 754 for FP32, FP16 and BF16, the
// OCP FP8 specification for E4M3 and E5M2, and the OCP MX v1.0 specification for FP4 E2M1 and the E8M0 scale.
// NVFP4's two-level scales follow NVIDIA's "Pretraining Large Language Models with NVFP4" (arXiv 2509.25149).
// The rounding matches public/labs/infra/number_formats.py, which checks it against PyTorch's casts.

type Fmt = 'FP32' | 'BF16' | 'FP16' | 'E5M2' | 'E4M3' | 'E2M1'
type Kind = 'ieee' | 'fn' | 'none'
const SPEC: Record<Fmt, { e: number; m: number; kind: Kind; label: string }> = {
  FP32: { e: 8, m: 23, kind: 'ieee', label: 'FP32' },
  BF16: { e: 8, m: 7, kind: 'ieee', label: 'BF16' },
  FP16: { e: 5, m: 10, kind: 'ieee', label: 'FP16' },
  E5M2: { e: 5, m: 2, kind: 'ieee', label: 'FP8 E5M2' },
  E4M3: { e: 4, m: 3, kind: 'fn', label: 'FP8 E4M3' },
  E2M1: { e: 2, m: 1, kind: 'none', label: 'FP4 E2M1' },
}

function decode(code: number, f: Fmt): number {
  const { e, m, kind } = SPEC[f]
  const sign = Math.floor(code / 2 ** (e + m)) % 2 ? -1 : 1
  const exp = Math.floor(code / 2 ** m) % 2 ** e
  const man = code % 2 ** m
  const bias = 2 ** (e - 1) - 1
  if (kind === 'ieee' && exp === 2 ** e - 1) return man === 0 ? sign * Infinity : NaN
  if (kind === 'fn' && exp === 2 ** e - 1 && man === 2 ** m - 1) return NaN
  if (exp === 0) return sign * 2 ** (1 - bias) * (man / 2 ** m)
  return sign * 2 ** (exp - bias) * (1 + man / 2 ** m)
}

// Every non-negative finite value of a 16-bit-or-smaller format; a value's index is its bit pattern.
const grids = new Map<Fmt, number[]>()
function grid(f: Fmt) {
  let g = grids.get(f)
  if (!g) {
    g = []
    const { e, m } = SPEC[f]
    for (let c = 0; c < 2 ** (e + m); c++) {
      const v = decode(c, f)
      if (!Number.isFinite(v)) break
      g.push(v)
    }
    grids.set(f, g)
  }
  return g
}

type Encoded = { code: number; value: number; note: 'exact' | 'rounded' | 'overflow' | 'underflow' | 'saturated' }

const f32 = new DataView(new ArrayBuffer(4))

/** Round to the nearest value of the format, ties to the even bit pattern, as a cast would. */
function encode(x: number, f: Fmt): Encoded {
  const { e, m, kind } = SPEC[f]
  const signBit = x < 0 || Object.is(x, -0) ? 2 ** (e + m) : 0
  if (f === 'FP32') {
    f32.setFloat32(0, x)
    const v = f32.getFloat32(0)
    const note = v === x ? 'exact' : !Number.isFinite(v) ? 'overflow' : v === 0 ? 'underflow' : 'rounded'
    return { code: f32.getUint32(0), value: v, note }
  }
  const g = grid(f)
  const a = Math.abs(x)
  const top = g[g.length - 1]
  const halfStep = 2 ** (Math.floor(Math.log2(top)) - m - 1)
  if (kind !== 'none' && a >= top + halfStep) {
    // IEEE formats overflow to infinity; E4M3 has no infinity, and PyTorch's cast gives NaN.
    const code = kind === 'ieee' ? (2 ** e - 1) * 2 ** m : 2 ** (e + m) - 1
    return { code: signBit + code, value: kind === 'ieee' ? Math.sign(x) * Infinity : NaN, note: 'overflow' }
  }
  if (kind === 'none' && a > top) return { code: signBit + g.length - 1, value: Math.sign(x) * top, note: 'saturated' }
  let lo = 0
  let hi = g.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (g[mid] <= a) lo = mid
    else hi = mid
  }
  const dLo = a - g[lo]
  const dHi = g[hi] - a
  const idx = dHi < dLo || (dHi === dLo && hi % 2 === 0) ? hi : lo
  const value = (x < 0 ? -1 : 1) * g[idx]
  const note = value === x ? 'exact' : idx === 0 && a > 0 ? 'underflow' : 'rounded'
  return { code: signBit + idx, value, note }
}

function stepAt(code: number, f: Fmt) {
  // Gap to the next value up in magnitude, which is how coarse the format is around this number.
  const { e, m } = SPEC[f]
  const mag = code % 2 ** (e + m)
  if (f === 'FP32') {
    const exp = Math.floor(mag / 2 ** 23)
    return 2 ** (Math.max(exp, 1) - 127 - 23)
  }
  const g = grid(f)
  return mag + 1 < g.length ? g[mag + 1] - g[mag] : g[mag] - g[mag - 1]
}

const fmtNum = (v: number) =>
  !Number.isFinite(v) ? (Number.isNaN(v) ? 'NaN' : v > 0 ? '+Inf' : '−Inf') : Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(4) : String(+v.toPrecision(7))

const PRESETS = ['0.1', '3.14159', '300', '1000.7', '70000', '0.00001']

function OneNumber() {
  const [text, setText] = useState('0.1')
  const [f, setF] = useState<Fmt>('BF16')
  const x = Number(text)
  const valid = text.trim() !== '' && Number.isFinite(x)
  const enc = valid ? encode(x, f) : null
  const { e, m } = SPEC[f]
  const bits = enc ? enc.code.toString(2).padStart(1 + e + m, '0').split('') : []
  const expField = enc ? Math.floor(enc.code / 2 ** m) % 2 ** e : 0
  const manField = enc ? enc.code % 2 ** m : 0
  const bias = 2 ** (e - 1) - 1
  const g = f === 'FP32' ? null : grid(f)
  const largest = g ? g[g.length - 1] : 3.4028234663852886e38
  const rel = enc && Number.isFinite(enc.value) && x !== 0 ? Math.abs(enc.value - x) / Math.abs(x) : null
  const box = f === 'FP32' ? 15 : 22

  let story = ''
  if (enc) {
    if (enc.note === 'overflow')
      story =
        SPEC[f].kind === 'ieee'
          ? `${x} is beyond ${f}'s largest value, ${fmtNum(largest)}, so it becomes infinity: the exponent field is all ones and the mantissa is zero.`
          : `${x} is beyond E4M3's largest value, 448. E4M3 has no infinity, so a plain cast gives NaN (S.1111.111); quantization code clamps to 448 before casting.`
    else if (enc.note === 'saturated')
      story = `FP4 has no infinity or NaN, so a value beyond 6 is clamped to 6. A scale must bring the data into range first.`
    else if (enc.note === 'underflow')
      story = `${x} is less than half the smallest value ${f} can store, so it rounds to zero. A scale that multiplies the data up first would keep it.`
    else if (expField === 0 && manField !== 0)
      story = `The exponent field is zero, so this is a subnormal number: there is no implicit leading 1, and precision falls off as values approach zero.`
    else if (enc.note === 'exact') story = `${x} is exactly representable in ${f}, so nothing is lost.`
    else
      story = `${f} keeps ${m} mantissa bits, so near this number its values are ${fmtNum(stepAt(enc.code, f))} apart, and ${x} rounds to the nearest one, off by ${((rel ?? 0) * 100).toPrecision(2)}%.`
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[0.8125rem] text-muted">
          Number
          <input
            value={text}
            onChange={(ev) => setText(ev.target.value)}
            inputMode="decimal"
            className="w-32 rounded-md border border-rule bg-paper px-2 py-1 text-ink tabular-nums"
            aria-label="Number to store"
          />
        </label>
        {PRESETS.map((p) => (
          <Button key={p} onClick={() => setText(p)} pressed={text === p}>
            {p}
          </Button>
        ))}
      </div>
      <Segmented label="Format" value={f} options={(Object.keys(SPEC) as Fmt[]).map((k) => ({ value: k, label: SPEC[k].label }))} onChange={setF} />

      {enc ? (
        <>
          <div className="overflow-x-auto">
            <div className="flex w-max gap-[2px]" role="img" aria-label={`Bits: ${bits.join('')}`}>
              {bits.map((b, i) => {
                const field = i === 0 ? 0 : i <= e ? 1 : 2
                return (
                  <span
                    key={i}
                    className="flex items-center justify-center rounded-sm font-mono text-[0.75rem] font-semibold text-on-accent"
                    style={{ width: box, height: 26, background: SERIES[field], opacity: b === '1' ? 1 : 0.45 }}
                  >
                    {b}
                  </span>
                )
              })}
            </div>
          </div>
          <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
            <Key color={SERIES[0]}>sign</Key>
            <Key color={SERIES[1]}>exponent, {e} bits, bias {bias}</Key>
            <Key color={SERIES[2]}>mantissa, {m} bits</Key>
          </p>
          <p className="font-mono text-[0.8125rem] text-ink-2">
            {Number.isFinite(enc.value)
              ? expField === 0
                ? `(−1)^${bits[0]} × 2^${1 - bias} × (0 + ${manField}/${2 ** m}) = ${fmtNum(enc.value)}`
                : `(−1)^${bits[0]} × 2^(${expField} − ${bias}) × (1 + ${manField}/${2 ** m}) = ${fmtNum(enc.value)}`
              : `special pattern: ${fmtNum(enc.value)}`}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Stored value" value={fmtNum(enc.value)} tone={Number.isFinite(enc.value) ? undefined : 'bad'} />
            <Stat label="Relative error" value={rel === null ? '—' : rel === 0 ? '0' : `${(rel * 100).toPrecision(2)}%`} tone={rel !== null && rel > 0.05 ? 'warn' : undefined} />
            <Stat label="Gap to next value here" value={Number.isFinite(enc.value) ? fmtNum(stepAt(enc.code, f)) : '—'} />
            <Stat label={`Largest ${f} value`} value={fmtNum(largest)} />
          </div>
          <Narration tone={enc.note === 'overflow' || enc.note === 'underflow' || enc.note === 'saturated' ? 'bad' : undefined}>{story}</Narration>
        </>
      ) : (
        <Narration tone="bad">Type a finite number, such as 0.1 or 1e-5.</Narration>
      )}
    </div>
  )
}

// ---- A block of weights in FP4 ---------------------------------------------------------------------------------

type Scheme = 'tensor' | 'mx' | 'nv'
const FP4_MAX = 6
const E4M3_MAX = 448

function weights(seed: number, outlier: boolean) {
  // 32 weight-like values from a seeded normal distribution (Box-Muller), with an optional outlier.
  let s = seed
  const rand = () => {
    // mulberry32: a small seeded generator that stays in 32-bit integer arithmetic
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296
  }
  const out = Array.from({ length: 32 }, () => 0.02 * Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()))
  if (outlier) out[5] = 0.2
  return out
}

function quantizeBlock(w: number[], scheme: Scheme, tensorFactor: number) {
  const amax = (xs: number[]) => Math.max(...xs.map(Math.abs), 1e-30)
  const scales: string[] = []
  let q: number[] = []
  let clamped = 0
  if (scheme === 'tensor') {
    const s = (amax(w) * tensorFactor) / FP4_MAX
    q = w.map((x) => encode(x / s, 'E2M1').value * s)
    scales.push(`one FP32 scale for the whole tensor: ${s.toPrecision(3)}`)
  } else if (scheme === 'mx') {
    // OCP MX v1.0, section 6.3: the largest power of two at or below the block's amax, over FP4's largest power of two (4).
    const k = Math.floor(Math.log2(amax(w))) - 2
    const s = 2 ** k
    q = w.map((x) => {
      if (Math.abs(x / s) > FP4_MAX) clamped++
      return encode(x / s, 'E2M1').value * s
    })
    scales.push(`one E8M0 scale for all 32: 2^${k} = ${s.toPrecision(3)}`)
  } else {
    const g = amax(w) / (FP4_MAX * E4M3_MAX) // the FP32 per-tensor scale
    for (const half of [w.slice(0, 16), w.slice(16)]) {
      const sb = encode(amax(half) / FP4_MAX / g, 'E4M3').value // the block's scale, stored in E4M3
      q.push(...half.map((x) => encode(x / (sb * g), 'E2M1').value * sb * g))
      scales.push(`E4M3 ${fmtNum(sb)}`)
    }
    scales.splice(0, 2, `block scales ${scales[0]} and ${scales[1]}, times one FP32 scale ${g.toExponential(2)}`)
  }
  const err = Math.sqrt(w.reduce((a, x, i) => a + (x - q[i]) ** 2, 0) / w.reduce((a, x) => a + x * x, 0))
  const zeroed = w.filter((x, i) => x !== 0 && q[i] === 0).length
  return { q, scales, err, zeroed, clamped }
}

const FACTORS = [1, 2, 4, 8, 16]
const BITS: Record<Scheme, string> = { tensor: '4', mx: '4.25', nv: '4.5' }

function Block() {
  const [scheme, setScheme] = useState<Scheme>('mx')
  const [outlier, setOutlier] = useState(false)
  const [seed, setSeed] = useState(7)
  const [fi, setFi] = useState(2)
  const w = useMemo(() => weights(seed, outlier), [seed, outlier])
  const r = quantizeBlock(w, scheme, FACTORS[fi])

  const W = 640
  const H = 150
  const lim = Math.max(...w.map(Math.abs)) * 1.1
  const y = (v: number) => H / 2 - (v / lim) * (H / 2 - 8)
  const col = (W - 16) / 32
  const x = (i: number) => 8 + i * col + col / 2

  return (
    <div className="space-y-4">
      <Segmented
        label="Scaling"
        value={scheme}
        options={[
          { value: 'tensor', label: 'FP4, one scale per tensor' },
          { value: 'mx', label: 'MXFP4 (32 per E8M0 scale)' },
          { value: 'nv', label: 'NVFP4 (16 per E4M3 scale)' },
        ]}
        onChange={setScheme}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setOutlier(!outlier)} pressed={outlier}>
          {outlier ? 'Remove the outlier' : 'Add an outlier'}
        </Button>
        <Button onClick={() => setSeed((s) => s + 1)}>New weights</Button>
        <IndexSlider
          label="Largest weight elsewhere in the tensor"
          index={fi}
          max={FACTORS.length - 1}
          onChange={setFi}
          text={`${FACTORS[fi]}× this block's`}
          disabled={scheme !== 'tensor'}
        />
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`32 weights and their FP4 values; error ${(r.err * 100).toFixed(1)}%`}>
        <line x1={8} x2={W - 8} y1={H / 2} y2={H / 2} stroke="var(--rule)" />
        {scheme === 'nv' && <line x1={x(15.5)} x2={x(15.5)} y1={4} y2={H - 4} stroke="var(--muted)" strokeDasharray="3 3" />}
        {w.map((v, i) => {
          const zero = r.q[i] === 0 && v !== 0
          return (
            <g key={i}>
              <rect x={x(i) - col * 0.3} width={col * 0.6} y={Math.min(y(v), H / 2)} height={Math.abs(y(v) - H / 2)} fill="var(--muted)" opacity={0.35} />
              <line
                x1={x(i) - col * 0.42}
                x2={x(i) + col * 0.42}
                y1={y(r.q[i])}
                y2={y(r.q[i])}
                stroke={zero ? 'var(--warn)' : 'var(--accent)'}
                strokeWidth={2.5}
              />
            </g>
          )
        })}
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="color-mix(in srgb, var(--muted) 35%, transparent)">original weight</Key>
        <Key color="var(--accent)">stored in FP4</Key>
        <Key color="var(--warn)">rounded to zero</Key>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Error (RMS, relative)" value={`${(r.err * 100).toFixed(1)}%`} tone={r.err > 0.25 ? 'bad' : r.err > 0.12 ? 'warn' : 'good'} />
        <Stat label="Weights rounded to zero" value={`${r.zeroed} of 32`} tone={r.zeroed > 8 ? 'bad' : undefined} />
        <Stat label="Weights clamped" value={r.clamped} tone={r.clamped ? 'warn' : undefined} />
        <Stat label="Bits per weight" value={BITS[scheme]} />
      </div>
      <Narration>
        {r.scales.join('; ')}.{' '}
        {scheme === 'tensor'
          ? `The scale is set by the largest weight in the whole tensor, so this block uses only part of FP4's range and its small weights round to zero. Raise the slider to see how one large weight elsewhere hurts every block.`
          : scheme === 'mx'
            ? `A power-of-two scale chosen by the OCP rule puts the block's largest weight between 4 and 8, so a weight above 6 is clamped, and on average the block uses less of the grid than a free scale would.`
            : `Each group of 16 gets a scale with three mantissa bits, so its largest weight lands close to 6 and the grid is used fully. The cost is a quarter bit more per weight than MXFP4.`}
        {outlier && scheme !== 'tensor' ? ' The outlier sets its block’s scale, so the other weights in that block lose precision; smaller blocks contain the damage.' : ''}
      </Narration>
    </div>
  )
}

export default function BitExplorer() {
  const [mode, setMode] = useState<'one' | 'block'>('one')
  return (
    <WidgetFrame
      title="Try it: store numbers in fewer bits"
      description="Store one number in each format and see its bits, or store a block of 32 weights in FP4 with three ways of scaling them."
    >
      <Segmented
        label="Show"
        value={mode}
        options={[
          { value: 'one', label: 'One number' },
          { value: 'block', label: 'A block of weights' },
        ]}
        onChange={setMode}
      />
      {mode === 'one' ? <OneNumber /> : <Block />}
    </WidgetFrame>
  )
}
