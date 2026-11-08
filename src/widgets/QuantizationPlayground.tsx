import { useMemo, useState } from 'react'
import { Button, IndexSlider, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// Integer quantization with a scale and zero-point (content/infra/quantization-math.md). The arithmetic is the
// same as quantize() in public/labs/infra/quant_math.py: symmetric codes run from -2^(b-1) to 2^(b-1) - 1 with the
// largest magnitude mapped to 2^(b-1) - 1; asymmetric codes run from 0 to 2^b - 1 between the group's minimum and
// maximum (widened to include zero), with an integer zero-point. The activation mode follows LLM.int8()
// (Dettmers et al., 2022): per-tensor and per-token INT8 scales, and the mixed-precision decomposition that keeps
// every feature column holding a value of magnitude 6 or more in 16 bits.

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

function gaussians(seed: number, n: number) {
  const rnd = mulberry32(seed)
  const out: number[] = []
  while (out.length < n) {
    const u = Math.max(rnd(), 1e-9)
    const v = rnd()
    const r = Math.sqrt(-2 * Math.log(u))
    out.push(r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v))
  }
  return out.slice(0, n)
}

type Group = { scale: number; zero: number; levels: number[] }

/** Quantize one group; returns the dequantized values and the group's grid. */
function quantGroup(x: number[], bits: number, sym: boolean, clip: number): { q: number[]; g: Group } {
  if (sym) {
    const qmax = 2 ** (bits - 1) - 1
    const scale = Math.max((Math.max(...x.map(Math.abs)) * clip) / qmax, 1e-12)
    const levels = Array.from({ length: 2 ** bits }, (_, i) => (i - qmax - 1) * scale)
    const q = x.map((v) => Math.min(qmax, Math.max(-qmax - 1, Math.round(v / scale))) * scale)
    return { q, g: { scale, zero: 0, levels } }
  }
  const qmax = 2 ** bits - 1
  const lo = Math.min(0, ...x) * clip
  const hi = Math.max(0, ...x) * clip
  const scale = Math.max((hi - lo) / qmax, 1e-12)
  const zero = Math.round(-lo / scale)
  const levels = Array.from({ length: qmax + 1 }, (_, i) => (i - zero) * scale)
  const q = x.map((v) => (Math.min(qmax, Math.max(0, Math.round(v / scale) + zero)) - zero) * scale)
  return { q, g: { scale, zero, levels } }
}

const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
const relErr = (x: number[], q: number[]) => rms(x.map((v, i) => v - q[i])) / rms(x)
const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 2 : 1)}%`

// ---- Weights ---------------------------------------------------------------------------------------------------
const N = 64
const BITS = [2, 3, 4, 8]
const GROUPS = [64, 32, 16, 8]
const CLIPS = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5]

function Weights() {
  const [bi, setBi] = useState(2)
  const [gi, setGi] = useState(0)
  const [sym, setSym] = useState(true)
  const [ci, setCi] = useState(0)
  const [outlier, setOutlier] = useState(false)
  const [seed, setSeed] = useState(3)
  const bits = BITS[bi]
  const group = GROUPS[gi]
  const clip = CLIPS[ci]

  const w = useMemo(() => {
    const g = gaussians(seed, N).map((v) => v * 0.02)
    if (outlier) g[37] = 0.16
    return g
  }, [seed, outlier])

  const groups: { q: number[]; g: Group }[] = []
  for (let s = 0; s < N; s += group) groups.push(quantGroup(w.slice(s, s + group), bits, sym, clip))
  const q = groups.flatMap((r) => r.q)
  const err = relErr(w, q)
  const zeroed = w.filter((v, i) => q[i] === 0 && v !== 0).length
  const meta = (16 + (sym ? 0 : bits)) / group
  const bpw = bits + meta

  const W = 640
  const H = 190
  const lim = Math.max(...w.map(Math.abs), ...q.map(Math.abs)) * 1.08
  const y = (v: number) => H / 2 - (v / lim) * (H / 2 - 6)
  const col = (W - 16) / N
  const x = (i: number) => 8 + i * col + col / 2
  const drawGrid = 2 ** bits <= 16

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <IndexSlider label="Bits" index={bi} max={BITS.length - 1} onChange={setBi} text={`INT${bits}`} />
        <IndexSlider
          label="Weights per scale"
          index={gi}
          max={GROUPS.length - 1}
          onChange={setGi}
          text={group === N ? '64 (the whole row: per channel)' : `group of ${group}`}
        />
        <IndexSlider label="Clip range to" index={ci} max={CLIPS.length - 1} onChange={setCi} text={`${Math.round(clip * 100)}%`} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Range"
          value={sym ? 'sym' : 'asym'}
          options={[
            { value: 'sym', label: 'Symmetric' },
            { value: 'asym', label: 'Asymmetric (zero-point)' },
          ]}
          onChange={(v) => setSym(v === 'sym')}
        />
        <Button onClick={() => setOutlier(!outlier)} pressed={outlier}>
          {outlier ? 'Remove the outlier' : 'Add an outlier'}
        </Button>
        <Button onClick={() => setSeed((s) => s + 1)}>New weights</Button>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`64 weights quantized to INT${bits}; error ${pct(err)}`}>
        {drawGrid &&
          groups.map((r, gIdx) =>
            r.g.levels.map((lv, k) =>
              Math.abs(lv) <= lim ? (
                <line
                  key={`${gIdx}-${k}`}
                  x1={x(gIdx * group) - col / 2}
                  x2={x(gIdx * group + group - 1) + col / 2}
                  y1={y(lv)}
                  y2={y(lv)}
                  stroke="var(--rule)"
                  strokeWidth={lv === 0 ? 0 : 1}
                />
              ) : null,
            ),
          )}
        <line x1={8} x2={W - 8} y1={H / 2} y2={H / 2} stroke="var(--muted)" strokeWidth={0.75} />
        {groups.slice(1).map((_, gIdx) => (
          <line key={gIdx} x1={x((gIdx + 1) * group) - col / 2} x2={x((gIdx + 1) * group) - col / 2} y1={2} y2={H - 2} stroke="var(--muted)" strokeDasharray="3 3" />
        ))}
        {w.map((v, i) => {
          const zero = q[i] === 0 && v !== 0
          return (
            <g key={i}>
              <rect x={x(i) - col * 0.3} width={col * 0.6} y={Math.min(y(v), H / 2)} height={Math.abs(y(v) - H / 2)} fill="var(--muted)" opacity={0.35} />
              <line x1={x(i) - col * 0.45} x2={x(i) + col * 0.45} y1={y(q[i])} y2={y(q[i])} stroke={zero ? 'var(--warn)' : 'var(--accent)'} strokeWidth={2.5} />
            </g>
          )
        })}
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="color-mix(in srgb, var(--muted) 35%, transparent)">original weight</Key>
        <Key color="var(--accent)">dequantized value</Key>
        <Key color="var(--warn)">rounded to zero</Key>
        <span>{drawGrid ? 'Thin lines: the values each group can store.' : `INT${bits} has ${2 ** bits} levels per group, too many to draw.`}</span>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Error (RMS, relative)" value={pct(err)} tone={err > 0.25 ? 'bad' : err > 0.1 ? 'warn' : 'good'} />
        <Stat label="Weights rounded to zero" value={`${zeroed} of ${N}`} tone={zeroed > 16 ? 'bad' : undefined} />
        <Stat label="Bits per weight" value={bpw.toFixed(bpw % 1 ? 3 : 0)} />
        <Stat label="Scales and zero-points" value={`${groups.length} ${sym ? 'scale' : 'scale + zero'}${groups.length > 1 ? 's' : ''}`} />
      </div>
      <Narration>
        {sym
          ? `Symmetric: each group's largest magnitude becomes code ${2 ** (bits - 1) - 1}, so zero is always a code but half the grid may sit where a group has no weights. `
          : `Asymmetric: each group's minimum and maximum set the grid, and a zero-point records which code means 0, so the grid covers only the range in use. `}
        {outlier
          ? group === N
            ? 'The outlier sets the scale for the whole row, so the step between levels is large and most small weights round to zero or one step from it.'
            : `The outlier sets the scale only for its own group of ${group}; the other groups keep fine grids. Smaller groups contain the damage at ${meta.toFixed(3)} extra bits per weight.`
          : clip < 1
            ? 'Clipping shrinks the range: the largest weights are cut to the edge, and every other weight gets a finer grid. Too much clipping makes the cut weights the main error.'
            : `Each group's scale is ${groups[0].g.scale.toExponential(2)}${groups.length > 1 ? ' or so' : ''}. Lower the bits to see the grid coarsen, or add an outlier.`}
      </Narration>
    </div>
  )
}

// ---- Activations -----------------------------------------------------------------------------------------------
const TOKENS = 8
const CH = 32
const SIZES = [1, 5, 20, 60]
type ActScheme = 'tensor' | 'token' | 'decomposed'

function quantActs(x: number[][], scheme: ActScheme) {
  const q8 = (rows: number[][]) => {
    if (scheme === 'tensor') {
      const flat = rows.flat()
      const { q } = quantGroup(flat, 8, true, 1)
      return rows.map((_, t) => q.slice(t * CH, (t + 1) * CH))
    }
    return rows.map((r) => quantGroup(r, 8, true, 1).q)
  }
  if (scheme !== 'decomposed') return { q: q8(x), kept: [] as number[] }
  const kept = Array.from({ length: CH }, (_, c) => c).filter((c) => x.some((r) => Math.abs(r[c]) >= 6))
  const masked = x.map((r) => r.map((v, c) => (kept.includes(c) ? 0 : v)))
  const q = q8(masked).map((r, t) => r.map((v, c) => (kept.includes(c) ? x[t][c] : v)))
  return { q, kept }
}

function Activations() {
  const [scheme, setScheme] = useState<ActScheme>('tensor')
  const [where, setWhere] = useState<'channel' | 'token'>('channel')
  const [si, setSi] = useState(2)
  const [seed, setSeed] = useState(5)
  const size = SIZES[si]

  const x = useMemo(() => {
    const g = gaussians(seed, TOKENS * CH)
    const rows = Array.from({ length: TOKENS }, (_, t) => g.slice(t * CH, (t + 1) * CH).map((v) => v * 0.6))
    if (size > 1) {
      if (where === 'channel') rows.forEach((r, t) => (r[11] = (t % 2 ? -1 : 1) * size * (0.8 + 0.05 * t)))
      else rows[2] = rows[2].map((v, c) => (c === 11 ? size : v * 3))
    }
    return rows
  }, [seed, size, where])

  const { q, kept } = quantActs(x, scheme)
  const keptSet = new Set(kept)
  // Error of the activations without the outlier column, which is where the damage shows.
  const errOthers = relErr(
    x.flatMap((r) => r.filter((_, c) => c !== 11)),
    q.flatMap((r) => r.filter((_, c) => c !== 11)),
  )
  const errAll = relErr(x.flat(), q.flat())
  const maxAbs = Math.max(...x.flat().map(Math.abs))
  const typical = rms(x.flatMap((r) => r.filter((_, c) => c !== 11)))
  const cellErr = x.map((r, t) => r.map((v, c) => Math.abs(v - q[t][c]) / typical))

  const W = 640
  const cw = (W - 70) / CH
  const ch = 14
  const H = TOKENS * ch * 2 + 44

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented
          label="Outlier"
          value={where}
          options={[
            { value: 'channel', label: 'One channel, every token' },
            { value: 'token', label: 'One token' },
          ]}
          onChange={setWhere}
        />
        <IndexSlider label="Outlier size" index={si} max={SIZES.length - 1} onChange={setSi} text={size === 1 ? 'none' : `about ${size}`} />
        <Button onClick={() => setSeed((s) => s + 1)}>New activations</Button>
      </div>
      <Segmented
        label="INT8 activations"
        value={scheme}
        options={[
          { value: 'tensor', label: 'One scale per tensor' },
          { value: 'token', label: 'One scale per token' },
          { value: 'decomposed', label: 'Per token, outlier columns in 16-bit' },
        ]}
        onChange={setScheme}
      />

      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Activations and their INT8 rounding error; error excluding the outlier channel ${pct(errOthers)}`}>
        <text x={0} y={10} fontSize={11} fill="var(--muted)">
          |x|: {TOKENS} tokens × {CH} channels
        </text>
        {x.map((r, t) =>
          r.map((v, c) => (
            <rect
              key={`a${t}-${c}`}
              x={70 + c * cw}
              y={16 + t * ch}
              width={cw - 1}
              height={ch - 1}
              fill="var(--accent)"
              opacity={Math.min(1, 0.08 + Math.abs(v) / maxAbs)}
            />
          )),
        )}
        {x.map((_, t) => (
          <text key={`l${t}`} x={60} y={16 + t * ch + 10} fontSize={9} textAnchor="end" fill="var(--muted)">
            token {t + 1}
          </text>
        ))}
        <text x={0} y={TOKENS * ch + 33} fontSize={11} fill="var(--muted)">
          rounding error of each activation
        </text>
        {cellErr.map((r, t) =>
          r.map((e, c) => (
            <rect
              key={`e${t}-${c}`}
              x={70 + c * cw}
              y={TOKENS * ch + 40 + t * ch}
              width={cw - 1}
              height={ch - 1}
              fill={keptSet.has(c) ? 'var(--done)' : 'var(--bad)'}
              opacity={keptSet.has(c) ? 0.35 : Math.min(1, e * 2.5)}
            />
          )),
        )}
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="var(--accent)">magnitude</Key>
        <Key color="var(--bad)">error, relative to a typical activation</Key>
        <Key color="color-mix(in srgb, var(--done) 35%, transparent)">kept in 16-bit</Key>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Error, all activations" value={pct(errAll)} />
        <Stat label="Error, the other channels" value={pct(errOthers)} tone={errOthers > 0.1 ? 'bad' : errOthers > 0.03 ? 'warn' : 'good'} />
        <Stat label="Largest |x| / typical" value={`${(maxAbs / typical).toFixed(0)}×`} />
        <Stat label="Columns kept in 16-bit" value={scheme === 'decomposed' ? `${kept.length} of ${CH}` : 'none'} />
      </div>
      <Narration>
        {scheme === 'tensor'
          ? 'One scale for the whole matrix is set by its largest value, so when an outlier is large every ordinary activation falls within a few steps of zero.'
          : scheme === 'token'
            ? where === 'channel'
              ? 'A scale per token helps a token outlier, but here the outlier is in the same channel for every token, so every token’s scale is still set by it. A matmul can only scale activations per token (row), not per channel (column), which is the problem SmoothQuant and LLM.int8() solve.'
              : 'A scale per token confines the outlier token’s coarse grid to that one row; every other token keeps a fine grid.'
            : kept.length
              ? `Columns with any value of magnitude 6 or more stay in 16-bit and are multiplied separately, as LLM.int8() does; everything else is INT8 with a scale per token. The cost is a second, small matmul.`
              : 'No value reaches 6, so nothing is kept in 16-bit and this is plain per-token INT8.'}
      </Narration>
    </div>
  )
}

export default function QuantizationPlayground() {
  const [mode, setMode] = useState<'w' | 'a'>('w')
  return (
    <WidgetFrame
      title="Try it: quantize weights and activations"
      description="Choose the bits, how many values share a scale, symmetric or asymmetric ranges and clipping, and watch the grid and the error; then see why an outlier in the activations breaks INT8."
    >
      <Segmented
        label="Quantize"
        value={mode}
        options={[
          { value: 'w', label: 'A row of weights' },
          { value: 'a', label: 'Activations' },
        ]}
        onChange={setMode}
      />
      {mode === 'w' ? <Weights /> : <Activations />}
    </WidgetFrame>
  )
}
