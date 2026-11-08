import { useState } from 'react'
import clsx from 'clsx'
import { IndexSlider, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'
import data from './data/quant-results.json'

// Every quantized version of Llama 3.1 8B Instruct that public/labs/infra/gpu/quantize_and_eval.py made and
// measured on one GPU (content/infra/quality-eval.md). Each point is one version; the widget filters them by a
// memory budget and a quality floor and draws the Pareto front: the versions no other version beats on both axes.

type Version = (typeof data.versions)[number]
type Cost = 'weights' | 'decode' | 'prefill'
type Quality = 'gsm8k' | 'arc' | 'ppl'

const COST: Record<Cost, { label: string; get: (v: Version) => number; unit: string; better: 'low' | 'high' }> = {
  weights: { label: 'Weight memory', get: (v) => v.weightsGiB, unit: 'GiB', better: 'low' },
  decode: { label: 'Decode step, batch 1', get: (v) => v.decodeMs, unit: 'ms', better: 'low' },
  prefill: { label: 'Prefill throughput', get: (v) => v.prefill / 1000, unit: 'k tok/s', better: 'high' },
}
const QUALITY: Record<Quality, { label: string; get: (v: Version) => number; fmt: (x: number) => string; better: 'low' | 'high' }> = {
  gsm8k: { label: 'GSM8K accuracy', get: (v) => v.gsm8k * 100, fmt: (x) => `${x.toFixed(1)}%`, better: 'high' },
  arc: { label: 'ARC-Challenge accuracy', get: (v) => v.arc * 100, fmt: (x) => `${x.toFixed(1)}%`, better: 'high' },
  ppl: { label: 'WikiText-2 perplexity', get: (v) => v.ppl, fmt: (x) => x.toFixed(2), better: 'low' },
}
const LOSSES = [0.5, 1, 2, 3, 5, 10]

export default function ParetoPicker() {
  const [cost, setCost] = useState<Cost>('decode')
  const [quality, setQuality] = useState<Quality>('gsm8k')
  const [li, setLi] = useState(2)
  const maxW = Math.max(...data.versions.map((v) => v.weightsGiB))
  const budgets = [maxW * 1.01, 10, 8, 6]
  const [bi, setBi] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)

  const base = data.versions.find((v) => v.name === 'BF16')!
  const C = COST[cost]
  const Q = QUALITY[quality]
  const qBase = Q.get(base)
  // Allowed loss: points of accuracy, or percent of perplexity.
  const loss = LOSSES[li]
  const floorOk = (v: Version) => (Q.better === 'high' ? Q.get(v) >= qBase - loss : Q.get(v) <= qBase * (1 + loss / 100))
  const fits = (v: Version) => v.weightsGiB <= budgets[bi]
  const ok = (v: Version) => floorOk(v) && fits(v)

  const betterC = (a: number, b: number) => (C.better === 'low' ? a <= b : a >= b)
  const betterQ = (a: number, b: number) => (Q.better === 'high' ? a >= b : a <= b)
  const dominated = (v: Version) =>
    data.versions.some(
      (o) => o !== v && betterC(C.get(o), C.get(v)) && betterQ(Q.get(o), Q.get(v)) && (C.get(o) !== C.get(v) || Q.get(o) !== Q.get(v)),
    )
  const front = data.versions.filter((v) => !dominated(v))
  const qualifying = data.versions.filter(ok)
  const best = [...qualifying].sort((a, b) => (C.better === 'low' ? C.get(a) - C.get(b) : C.get(b) - C.get(a)))[0]
  const shown = data.versions.find((v) => v.name === picked) ?? best ?? base

  const W = 640
  const H = 300
  const pad = { l: 56, r: 16, t: 14, b: 40 }
  const xs = data.versions.map(C.get)
  const ys = data.versions.map(Q.get)
  const [x0, x1] = [Math.min(...xs) * 0.9, Math.max(...xs) * 1.05]
  const yr = Math.max(...ys) - Math.min(...ys) || 1
  const [y0, y1] = [Math.min(...ys) - yr * 0.15, Math.max(...ys) + yr * 0.15]
  const px = (v: number) => pad.l + ((v - x0) / (x1 - x0)) * (W - pad.l - pad.r)
  const py = (v: number) => {
    const t = (v - y0) / (y1 - y0)
    return pad.t + (Q.better === 'high' ? 1 - t : t) * (H - pad.t - pad.b)
  }
  const frontSorted = [...front].sort((a, b) => C.get(a) - C.get(b))

  // Place each label beside its point where it overlaps no other label, no point and no edge: right, left, then
  // above and below. Versions often sit close together (several 4-bit versions decode at the same speed).
  type Box = { x0: number; x1: number; y0: number; y1: number }
  const hit = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
  const dots = data.versions.map((v) => ({ v, x: px(C.get(v)), y: py(Q.get(v)) }))
  const taken: Box[] = []
  const labels = new Map<string, { x: number; y: number; anchor: 'start' | 'end' | 'middle' }>()
  for (const d of dots) {
    const w = d.v.short.length * 5.8
    const tries: [number, number, 'start' | 'end' | 'middle'][] = [
      [10, 4, 'start'],
      [-10, 4, 'end'],
      [8, -9, 'start'],
      [8, 17, 'start'],
      [-8, -9, 'end'],
      [-8, 17, 'end'],
      [0, -12, 'middle'],
      [0, 21, 'middle'],
    ]
    const boxOf = ([dx, dy, a]: [number, number, string]): Box => {
      const x0 = a === 'start' ? d.x + dx : a === 'end' ? d.x + dx - w : d.x - w / 2
      return { x0, x1: x0 + w, y0: d.y + dy - 9, y1: d.y + dy + 2 }
    }
    const fits = (b: Box) =>
      b.x0 >= pad.l + 2 &&
      b.x1 <= W - 2 &&
      b.y0 >= 0 &&
      b.y1 <= H - pad.b &&
      !taken.some((t) => hit(b, t)) &&
      !dots.some((o) => o !== d && hit(b, { x0: o.x - 7, x1: o.x + 7, y0: o.y - 7, y1: o.y + 7 }))
    const pick = tries.find((t) => fits(boxOf(t))) ?? tries[0]
    taken.push(boxOf(pick))
    labels.set(d.v.name, { x: d.x + pick[0], y: d.y + pick[1], anchor: pick[2] })
  }

  return (
    <WidgetFrame
      title="Try it: pick a quantized model"
      description={`${data.versions.length} versions of ${data.model}, each measured on an ${data.gpu}. Set a memory budget and how much quality you can give up; the points that qualify light up.`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Cost"
          value={cost}
          options={(Object.keys(COST) as Cost[]).map((k) => ({ value: k, label: COST[k].label }))}
          onChange={setCost}
        />
        <Segmented
          label="Quality"
          value={quality}
          options={(Object.keys(QUALITY) as Quality[]).map((k) => ({ value: k, label: QUALITY[k].label }))}
          onChange={setQuality}
        />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <IndexSlider
          label="Weight memory budget"
          index={bi}
          max={budgets.length - 1}
          onChange={setBi}
          text={bi === 0 ? 'any' : `${budgets[bi]} GiB`}
        />
        <IndexSlider
          label="Quality you can give up"
          index={li}
          max={LOSSES.length - 1}
          onChange={setLi}
          text={Q.better === 'high' ? `${loss} points` : `${loss}% perplexity`}
        />
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${C.label} against ${Q.label} for each version`}>
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--rule)" />
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} stroke="var(--rule)" />
        <text x={(W + pad.l) / 2} y={H - 8} fontSize={11} textAnchor="middle" fill="var(--muted)">
          {C.label} ({C.unit}), {C.better === 'low' ? 'lower is better' : 'higher is better'}
        </text>
        <text x={12} y={(H - pad.b) / 2} fontSize={11} textAnchor="middle" fill="var(--muted)" transform={`rotate(-90 12 ${(H - pad.b) / 2})`}>
          {Q.label}, better upward
        </text>
        {[x0, (x0 + x1) / 2, x1].map((t) => (
          <text key={t} x={px(t)} y={H - pad.b + 14} fontSize={10} textAnchor="middle" fill="var(--muted)">
            {t.toFixed(t < 10 ? 1 : 0)}
          </text>
        ))}
        {[y0, (y0 + y1) / 2, y1].map((t) => (
          <text key={t} x={pad.l - 6} y={py(t) + 3} fontSize={10} textAnchor="end" fill="var(--muted)">
            {Q.fmt(t)}
          </text>
        ))}
        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={py(Q.better === 'high' ? qBase - loss : qBase * (1 + loss / 100))}
          y2={py(Q.better === 'high' ? qBase - loss : qBase * (1 + loss / 100))}
          stroke="var(--warn)"
          strokeDasharray="4 4"
        />
        <polyline
          points={frontSorted.map((v) => `${px(C.get(v))},${py(Q.get(v))}`).join(' ')}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
        {data.versions.map((v) => {
          const good = ok(v)
          return (
            <g key={v.name} onClick={() => setPicked(v.name)} className="cursor-pointer">
              <circle
                cx={px(C.get(v))}
                cy={py(Q.get(v))}
                r={v === shown ? 8 : 6}
                fill={good ? 'var(--done)' : 'var(--muted)'}
                opacity={good ? 0.9 : 0.35}
                stroke={v === shown ? 'var(--ink)' : 'none'}
                strokeWidth={1.5}
              />
              <text x={labels.get(v.name)!.x} y={labels.get(v.name)!.y} fontSize={10} textAnchor={labels.get(v.name)!.anchor} fill="var(--ink-2)">
                {v.short}
              </text>
            </g>
          )
        })}
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="var(--done)">fits both limits</Key>
        <Key color="var(--warn)">quality floor</Key>
        <span>Dotted line: the Pareto front. Click a point for its numbers.</span>
      </p>

      <div className={clsx('grid grid-cols-2 gap-3 sm:grid-cols-4')}>
        <Stat label="Version" value={shown.short} />
        <Stat label="Weights / KV capacity" value={`${shown.weightsGiB.toFixed(1)} GiB / ${Math.round(shown.kvTokens / 1000)}k tok`} />
        <Stat label="Decode b1 / prefill" value={`${shown.decodeMs.toFixed(1)} ms / ${(shown.prefill / 1000).toFixed(1)}k`} />
        <Stat label="GSM8K / flips vs BF16" value={`${(shown.gsm8k * 100).toFixed(1)}% / ${(shown.gsm8kFlips * 100).toFixed(1)}%`} />
      </div>
      <Narration tone={best ? 'good' : 'bad'}>
        {best
          ? `${qualifying.length} of ${data.versions.length} versions fit. The one with the best ${C.label.toLowerCase()} is ${best.name}: ${C.get(best).toFixed(1)} ${C.unit}, ${Q.label} ${Q.fmt(Q.get(best))} against BF16's ${Q.fmt(qBase)}.`
          : 'No version fits both limits: allow more quality loss or more memory.'}{' '}
        {shown.gsm8kFlips > 0 && shown !== base
          ? `Even where accuracy barely moves, ${(shown.gsm8kFlips * 100).toFixed(1)}% of GSM8K answers changed between right and wrong for ${shown.short}.`
          : ''}
      </Narration>
    </WidgetFrame>
  )
}
