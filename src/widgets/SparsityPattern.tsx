import { useMemo, useState } from 'react'
import { Button, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// Pruning half of a weight matrix (content/infra/other-compression.md), as in public/labs/infra/pruning.py:
// unstructured (the lowest-scoring half of each row) or 2:4 (the 2 lowest of every 4 consecutive weights along
// a row, NVIDIA's semi-structured sparsity), scored by |W| (magnitude) or by |W| × ||X_j|| (Wanda, Sun et al. 2023,
// arXiv 2306.11695), where ||X_j|| is the norm of input channel j over a batch of tokens.

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
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r())

const ROWS = 8
const COLS = 16
const TOK = 64
const LOUD = [2, 9, 13] // input channels with large activations

type Pattern = 'unstructured' | '2:4'
type Score = 'magnitude' | 'wanda'

export default function SparsityPattern() {
  const [pattern, setPattern] = useState<Pattern>('2:4')
  const [score, setScore] = useState<Score>('magnitude')
  const [seed, setSeed] = useState(4)

  const { w, x, xnorm } = useMemo(() => {
    const r = mulberry32(seed)
    const w = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => gauss(r)))
    const x = Array.from({ length: TOK }, () => Array.from({ length: COLS }, (_, j) => gauss(r) * (LOUD.includes(j) ? 6 : 1)))
    const xnorm = Array.from({ length: COLS }, (_, j) => Math.sqrt(x.reduce((s, row) => s + row[j] ** 2, 0)))
    return { w, x, xnorm }
  }, [seed])

  const keep = w.map((row) => {
    const s = row.map((v, j) => Math.abs(v) * (score === 'wanda' ? xnorm[j] : 1))
    const k = row.map(() => true)
    if (pattern === 'unstructured') {
      ;[...s.keys()].sort((a, b) => s[a] - s[b]).slice(0, COLS / 2).forEach((j) => (k[j] = false))
    } else {
      for (let g = 0; g < COLS; g += 4) {
        ;[g, g + 1, g + 2, g + 3]
          .sort((a, b) => s[a] - s[b])
          .slice(0, 2)
          .forEach((j) => (k[j] = false))
      }
    }
    return k
  })

  const out = (mask: boolean) =>
    x.map((xr) => w.map((wr, i) => wr.reduce((acc, v, j) => acc + (mask && !keep[i][j] ? 0 : v * xr[j]), 0)))
  const ref = out(false)
  const pruned = out(true)
  let e = 0
  let n = 0
  ref.forEach((r, t) => r.forEach((v, i) => ((e += (v - pruned[t][i]) ** 2), (n += v * v))))
  const err = Math.sqrt(e / n)
  const loudKept = keep.reduce((s, k) => s + LOUD.filter((j) => k[j]).length, 0)

  const W = 640
  const cw = (W - 20) / COLS
  const ch = 26
  const maxW = Math.max(...w.flat().map(Math.abs))

  return (
    <WidgetFrame
      title="Try it: prune half of a weight matrix"
      description="Eight output rows by sixteen input channels. Three input channels (marked) carry large activations. Prune half the weights by magnitude or by Wanda's score, freely or in the 2:4 pattern sparse tensor cores need."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Pattern"
          value={pattern}
          options={[
            { value: 'unstructured', label: 'Any half of each row' },
            { value: '2:4', label: '2 of every 4' },
          ]}
          onChange={setPattern}
        />
        <Segmented
          label="Score"
          value={score}
          options={[
            { value: 'magnitude', label: '|W|' },
            { value: 'wanda', label: '|W| × input norm (Wanda)' },
          ]}
          onChange={setScore}
        />
        <Button onClick={() => setSeed((s) => s + 1)}>New weights</Button>
      </div>

      <svg viewBox={`0 0 ${W} ${ROWS * ch + 24}`} className="h-auto w-full" role="img" aria-label={`Pruned weight matrix; output error ${(err * 100).toFixed(1)}%`}>
        {Array.from({ length: COLS }, (_, j) => (
          <text key={j} x={10 + j * cw + cw / 2} y={12} fontSize={10} textAnchor="middle" fill={LOUD.includes(j) ? 'var(--accent)' : 'var(--muted)'} fontWeight={LOUD.includes(j) ? 700 : 400}>
            {LOUD.includes(j) ? '▲' : j + 1}
          </text>
        ))}
        {pattern === '2:4' &&
          [4, 8, 12].map((g) => <line key={g} x1={10 + g * cw} x2={10 + g * cw} y1={16} y2={16 + ROWS * ch} stroke="var(--muted)" strokeDasharray="3 3" />)}
        {w.map((row, i) =>
          row.map((v, j) => (
            <g key={`${i}-${j}`}>
              <rect
                x={10 + j * cw + 1}
                y={18 + i * ch}
                width={cw - 2}
                height={ch - 3}
                rx={3}
                fill={keep[i][j] ? 'var(--accent)' : 'var(--paper)'}
                opacity={keep[i][j] ? 0.25 + 0.75 * (Math.abs(v) / maxW) : 1}
                stroke="var(--rule)"
              />
              {!keep[i][j] && (
                <text x={10 + j * cw + cw / 2} y={18 + i * ch + ch / 2 + 2} fontSize={11} textAnchor="middle" fill="var(--muted)">
                  0
                </text>
              )}
            </g>
          )),
        )}
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="var(--accent)">kept weight (stronger colour = larger)</Key>
        <span>▲ input channel with large activations</span>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Output error" value={`${(err * 100).toFixed(1)}%`} tone={err > 0.3 ? 'bad' : err > 0.15 ? 'warn' : 'good'} />
        <Stat label="Weights on ▲ channels kept" value={`${loudKept} of ${ROWS * LOUD.length}`} />
        <Stat label="Sparse tensor cores can use it" value={pattern === '2:4' ? 'yes' : 'no'} tone={pattern === '2:4' ? 'good' : undefined} />
      </div>
      <Narration>
        {score === 'magnitude'
          ? 'Magnitude pruning ignores the inputs, so it drops weights on the loud channels as readily as anywhere else, and those weights carry much of the output.'
          : 'Wanda multiplies each weight by its input channel’s norm, so weights on the loud channels survive and the quiet channels lose more; the output error falls without changing a single kept weight.'}{' '}
        {pattern === '2:4'
          ? 'The 2:4 pattern forces exactly two zeros in every group of four, even when a group holds four important weights, which costs some accuracy in exchange for hardware support.'
          : 'Unstructured pruning can drop any weights, so it loses less accuracy, but GPUs cannot skip the zeros to save time.'}
      </Narration>
    </WidgetFrame>
  )
}
