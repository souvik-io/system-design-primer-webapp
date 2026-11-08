import { useMemo, useState } from 'react'
import { Button, IndexSlider, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// SmoothQuant's smoothing (Xiao et al., 2022, arXiv 2211.10438, equation 4), as in content/infra/ptq-algorithms.md:
// s_j = max|X_j|^alpha / max|W_j|^(1 - alpha) for each input channel j, then X' = X / s and W' = W * s, which leaves
// X W^T unchanged. Both sides are then quantized to INT8: activations with one scale per tensor or per token,
// weights with one scale per output channel, as in public/labs/infra/ptq_algorithms.py.
//
// The layer has 1,024 input channels, four of them outliers, because the balance matters: in a real layer the
// thousands of ordinary channels carry much of the output, so rounding them coarsely is what hurts. With only a
// few ordinary channels the outlier channels would dominate the output and hide the damage.

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gauss(rnd: () => number) {
  const u = Math.max(rnd(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
}

const T = 32 // tokens
const C = 1024 // input channels
const O = 16 // output channels
const OUTLIERS = [131, 387, 643, 899]

function absMax(vals: number[]) {
  let m = 0
  for (const v of vals) m = Math.max(m, Math.abs(v))
  return m
}

/** Symmetric INT8 fake-quantization of each row (or of the whole matrix when perRow is false). */
function q8(m: number[][], perRow: boolean) {
  const all = perRow ? 0 : Math.max(...m.map(absMax)) / 127 || 1
  return m.map((r) => {
    const s = perRow ? absMax(r) / 127 || 1 : all
    return r.map((v) => Math.max(-128, Math.min(127, Math.round(v / s))) * s)
  })
}

function matmulT(x: number[][], w: number[][]) {
  return x.map((r) =>
    w.map((wr) => {
      let s = 0
      for (let k = 0; k < r.length; k++) s += wr[k] * r[k]
      return s
    }),
  )
}

function relErr(a: number[][], b: number[][]) {
  let e = 0
  let n = 0
  a.forEach((r, i) => r.forEach((v, j) => ((e += (v - b[i][j]) ** 2), (n += v * v))))
  return Math.sqrt(e / n)
}

const colMax = (m: number[][]) => Array.from({ length: C }, (_, j) => absMax(m.map((r) => r[j])))

/** Smooth with the given alpha (null: no smoothing), quantize both sides to INT8 and measure the errors. */
function errors(x: number[][], w: number[][], ref: number[][], alpha: number | null, perToken: boolean) {
  let xs = x
  let ws = w
  if (alpha !== null) {
    const xmax = colMax(x)
    const wmax = colMax(w)
    const s = xmax.map((xm, j) => Math.max(xm ** alpha / wmax[j] ** (1 - alpha), 1e-6))
    xs = x.map((r) => r.map((v, j) => v / s[j]))
    ws = w.map((r) => r.map((v, j) => v * s[j]))
  }
  const xq = q8(xs, perToken)
  const wq = q8(ws, true)
  return { xs, ws, out: relErr(ref, matmulT(xq, wq)), act: relErr(xs, xq), wt: relErr(ws, wq) }
}

const ALPHAS = Array.from({ length: 21 }, (_, i) => i / 20)
const SIZES = [10, 20, 40, 70, 100]

export default function OutlierMigration() {
  const [ai, setAi] = useState(0)
  const [si, setSi] = useState(2)
  const [perToken, setPerToken] = useState(false)
  const [seed, setSeed] = useState(11)
  const alpha = ALPHAS[ai]
  const size = SIZES[si]

  const { x, w, ref } = useMemo(() => {
    const rnd = mulberry32(seed)
    const x = Array.from({ length: T }, () =>
      Array.from({ length: C }, (_, j) => gauss(rnd) * (OUTLIERS.includes(j) ? size * (0.7 + 0.3 * rnd()) : 1)),
    )
    const w = Array.from({ length: O }, () => Array.from({ length: C }, () => gauss(rnd) * 0.05))
    return { x, w, ref: matmulT(x, w) }
  }, [seed, size])

  const curve = useMemo(() => ALPHAS.map((a) => errors(x, w, ref, a, perToken).out), [x, w, ref, perToken])
  const none = useMemo(() => errors(x, w, ref, null, perToken).out, [x, w, ref, perToken])
  const cur = useMemo(() => errors(x, w, ref, alpha, perToken), [x, w, ref, alpha, perToken])
  const best = curve.indexOf(Math.min(...curve))

  const xmax = colMax(cur.xs)
  const wmax = colMax(cur.ws)
  const ratio = (v: number[]) => Math.max(...v) / [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]

  // Largest |value| per input channel, each side on its own scale; the outlier channels are drawn on top.
  const W = 640
  const bh = 70
  const half = W / 2 - 30
  const spikes = (vals: number[], x0: number, color: string, label: string) => {
    const m = Math.max(...vals)
    const px = (j: number) => x0 + ((j + 0.5) / C) * half
    const py = (v: number) => 20 + bh - (v / m) * bh
    const ordinary = vals.map((v, j) => (OUTLIERS.includes(j) ? '' : `M${px(j).toFixed(1)} ${20 + bh}V${py(v).toFixed(1)}`)).join('')
    return (
      <g>
        <text x={x0} y={12} fontSize={11} fill="var(--muted)">
          {label}
        </text>
        <path d={ordinary} stroke={color} strokeWidth={0.6} opacity={0.5} />
        {OUTLIERS.map((j) => (
          <line key={j} x1={px(j)} x2={px(j)} y1={20 + bh} y2={py(vals[j])} stroke={color} strokeWidth={3} />
        ))}
        <text x={x0} y={bh + 34} fontSize={10} fill="var(--muted)">
          largest / median channel: {ratio(vals).toFixed(1)}×
        </text>
      </g>
    )
  }

  const CW = 640
  const CH = 130
  const maxE = Math.max(...curve, none)
  const cx = (i: number) => 40 + (i / 20) * (CW - 60)
  const cy = (e: number) => 22 + (1 - e / maxE) * (CH - 42)

  return (
    <WidgetFrame
      title="Try it: move outliers from activations to weights"
      description="A layer with 1,024 input channels, four of which carry outliers. SmoothQuant divides each activation channel by s and multiplies the matching weights by s; alpha decides how much of the range moves. Both sides are then quantized to INT8."
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <IndexSlider label="Migration strength alpha" index={ai} max={20} onChange={setAi} text={alpha.toFixed(2)} />
        <IndexSlider label="Outlier size" index={si} max={SIZES.length - 1} onChange={setSi} text={`${size}×`} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Activation scales"
          value={perToken ? 'token' : 'tensor'}
          options={[
            { value: 'tensor', label: 'One per tensor' },
            { value: 'token', label: 'One per token' },
          ]}
          onChange={(v) => setPerToken(v === 'token')}
        />
        <Button onClick={() => setSeed((s) => s + 1)}>New data</Button>
      </div>

      <svg viewBox={`0 0 ${W} ${bh + 40}`} className="h-auto w-full" role="img" aria-label="Largest value per input channel of the smoothed activations and weights">
        {spikes(xmax, 0, 'var(--accent)', 'activations X / s, largest |value| per channel')}
        {spikes(wmax, W / 2 + 30, 'var(--w3)', 'weights W × s, largest |value| per channel')}
      </svg>

      <svg viewBox={`0 0 ${CW} ${CH}`} className="h-auto w-full" role="img" aria-label={`Output error against alpha; lowest at alpha ${ALPHAS[best].toFixed(2)}`}>
        <line x1={40} x2={CW - 20} y1={CH - 20} y2={CH - 20} stroke="var(--rule)" />
        <line x1={40} x2={CW - 20} y1={cy(none)} y2={cy(none)} stroke="var(--muted)" strokeDasharray="4 4" />
        <polyline points={curve.map((e, i) => `${cx(i)},${cy(e)}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={2} />
        <circle cx={cx(ai)} cy={cy(curve[ai])} r={5} fill="var(--accent)" />
        <circle cx={cx(best)} cy={cy(curve[best])} r={4} fill="none" stroke="var(--done)" strokeWidth={2} />
        {[0, 0.25, 0.5, 0.75, 1].map((a) => (
          <text key={a} x={cx(a * 20)} y={CH - 6} fontSize={10} textAnchor="middle" fill="var(--muted)">
            {a}
          </text>
        ))}
        <text x={0} y={11} fontSize={10} fill="var(--muted)">
          output error
        </text>
        <text x={CW - 20} y={CH - 24} fontSize={10} textAnchor="end" fill="var(--muted)">
          alpha
        </text>
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="var(--accent)">output error of the INT8 layer at each alpha</Key>
        <Key color="var(--done)">lowest</Key>
        <span>dashed: no smoothing, {(none * 100).toFixed(1)}%</span>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Output error" value={`${(cur.out * 100).toFixed(2)}%`} tone={cur.out > 0.05 ? 'bad' : cur.out > 0.02 ? 'warn' : 'good'} />
        <Stat label="Activation error" value={`${(cur.act * 100).toFixed(2)}%`} />
        <Stat label="Weight error" value={`${(cur.wt * 100).toFixed(2)}%`} />
        <Stat label="Best alpha here" value={ALPHAS[best].toFixed(2)} />
      </div>
      <Narration>
        {alpha === 0
          ? 'At alpha 0, s only evens out the weights (s = 1 / max|W_j|), and the activations keep their outliers. Those set the activation scale, so every ordinary activation is rounded coarsely, and the ordinary channels carry most of the output.'
          : alpha === 1
            ? 'At alpha 1 every activation channel is flattened to the same range and the whole difficulty lands on the weights: the outlier channels’ weights are now huge, and each weight row’s INT8 scale is set by them.'
            : `With alpha ${alpha.toFixed(2)}, part of the outliers' range has moved into the weights. The product X W^T is unchanged before quantization; what changes is how evenly the two INT8 grids are used. SmoothQuant found 0.5 a good balance for OPT and BLOOM and needed 0.75 to 0.9 for models with harder activations.`}
        {perToken &&
          ' Per-token scales help only partly: the outliers sit in the same channels of every token, so every token’s scale is still set by them.'}
      </Narration>
    </WidgetFrame>
  )
}
