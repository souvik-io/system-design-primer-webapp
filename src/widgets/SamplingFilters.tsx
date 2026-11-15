import { useState } from 'react'
import { Button, IndexSlider, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'
import { applyFilters, draw, SHOWN, type Dist } from './samplingSim'
import data from './data/sampling-distributions.json'

// Sampling settings on real next-token distributions (content/infra/structured-output.md). The three distributions
// are SmolLM2-135M's for three prompts, from a peaked one to a flat one; the filters run in vLLM's order
// (samplingSim.ts).

const DISTS = data.contexts as Dist[]
const LABELS = ['Peaked', 'In between', 'Flat']
const TEMPS = [0, 0.3, 0.5, 0.7, 0.8, 1, 1.2, 1.5, 2, 3]
const TOPK = [0, 1, 5, 10, 20, 50, 100, 500]
const TOPP = [1, 0.99, 0.95, 0.9, 0.8, 0.5, 0.2]
const MINP = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5]
const pct = (p: number) => (p >= 0.1 ? `${(100 * p).toFixed(0)}%` : p >= 0.001 ? `${(100 * p).toFixed(1)}%` : p > 0 ? '<0.1%' : '0')
/** A token as text, with its spaces, newlines and tabs made visible. */
const show = (t: string) => t.replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/ /g, '·') || '∅'

export default function SamplingFilters() {
  const [di, setDi] = useState(0)
  const [ti, setTi] = useState(5)
  const [ki, setKi] = useState(0)
  const [pi, setPi] = useState(0)
  const [mi, setMi] = useState(0)
  const [draws, setDraws] = useState<(string | null)[]>([])

  const d = DISTS[di]
  const s = { temperature: TEMPS[ti], topK: TOPK[ki], topP: TOPP[pi], minP: MINP[mi] }
  const r = applyFilters(d, s)
  const reset = () => setDraws([])

  const W = 640
  const rowH = 17
  const H = SHOWN * rowH + 30
  const labelW = 120
  const barW = W - labelW - 70
  const maxP = Math.max(...r.before.slice(0, SHOWN), ...r.after.slice(0, SHOWN))
  const x = (p: number) => (p / maxP) * barW

  const active = [s.minP > 0 && `min-p ${s.minP}`, s.topK > 0 && `top-k ${s.topK}`, s.topP < 1 && `top-p ${s.topP}`].filter(Boolean)
  const removedText = (['min-p', 'top-k', 'top-p'] as const)
    .filter((f) => r.removed[f] > 0)
    .map((f) => `${f} removed ${r.removed[f].toLocaleString()}`)
    .join(', ')

  let narration: string
  if (s.temperature === 0) {
    narration = `Greedy decoding always takes “${show(d.top[0][0])}”, the most likely token, so every other setting is ignored and the same prompt always gives the same answer.`
  } else if (!active.length) {
    narration = `With no filter, all ${d.vocab.toLocaleString()} tokens can be drawn. The ${SHOWN} shown hold ${pct(1 - r.tailBefore)} of the probability at temperature ${s.temperature}, and the other ${(d.vocab - SHOWN).toLocaleString()} hold ${pct(r.tailBefore)} between them: that long tail is where incoherent continuations come from.`
  } else {
    narration = `${active.join(', then ')} leaves ${r.keptTokens.toLocaleString()} of ${d.vocab.toLocaleString()} tokens, which held ${pct(r.keptMass)} of the probability (${removedText}). The kept tokens are rescaled to add up to 1, so each becomes ${r.keptMass < 0.999 ? `${(1 / r.keptMass).toFixed(2)} times` : 'about as'} likely as before.`
  }

  return (
    <WidgetFrame
      title="Try it: temperature, top-k, top-p and min-p"
      description="The bars are SmolLM2-135M's next-token probabilities for a prompt, the 20 most likely of 49,152 tokens. Temperature reshapes the distribution; min-p, top-k and top-p then cut its tail, in that order, as vLLM does. Faint bars are the probabilities before the cuts, solid bars after."
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
        <Segmented label="Prompt" value={di} options={LABELS.map((l, i) => ({ value: i, label: l }))} onChange={(i) => (setDi(i), reset())} />
        <IndexSlider label="Temperature" index={ti} max={TEMPS.length - 1} onChange={(i) => (setTi(i), reset())} text={s.temperature === 0 ? '0 (greedy)' : String(s.temperature)} />
        <IndexSlider label="min-p" index={mi} max={MINP.length - 1} onChange={(i) => (setMi(i), reset())} text={s.minP ? String(s.minP) : 'off'} />
        <IndexSlider label="top-k" index={ki} max={TOPK.length - 1} onChange={(i) => (setKi(i), reset())} text={s.topK ? String(s.topK) : 'off'} />
        <IndexSlider label="top-p" index={pi} max={TOPP.length - 1} onChange={(i) => (setPi(i), reset())} text={s.topP < 1 ? String(s.topP) : 'off'} />
      </div>
      <p className="font-mono text-[0.8125rem] text-ink-2">
        {d.context}
        <span className="text-accent"> ▍</span>
      </p>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Next-token probabilities before and after the filters">
        {d.top.slice(0, SHOWN).map(([tok], i) => {
          const y = 8 + i * rowH
          const gone = r.after[i] === 0
          return (
            <g key={i}>
              <text x={labelW - 8} y={y + 11} textAnchor="end" fontSize={11} fontFamily="var(--font-mono, monospace)" fill={gone ? 'var(--muted)' : 'var(--ink)'}>
                {show(tok)}
              </text>
              <rect x={labelW} y={y + 2} width={Math.max(x(r.before[i]), 1)} height={rowH - 5} rx={2} fill="var(--accent)" opacity={0.18} />
              {!gone && <rect x={labelW} y={y + 2} width={Math.max(x(r.after[i]), 1)} height={rowH - 5} rx={2} fill="var(--accent)" />}
              <text x={labelW + Math.max(x(r.before[i]), x(r.after[i])) + 6} y={y + 11} fontSize={10.5} fill="var(--muted)">
                {gone ? `removed by ${r.removedBy[i]}` : pct(r.after[i])}
              </text>
            </g>
          )
        })}
        <text x={labelW} y={H - 6} fontSize={10.5} fill="var(--muted)">
          {`The other ${(d.vocab - SHOWN).toLocaleString()} tokens: ${pct(r.tailBefore)} before the cuts, ${pct(r.tailAfter)} after`}
        </text>
      </svg>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="color-mix(in srgb, var(--accent) 22%, transparent)">After temperature, before the cuts</Key>
        <Key color="var(--accent)">What is drawn from</Key>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Tokens that can be drawn" value={r.keptTokens.toLocaleString()} />
        <Stat label="Probability they held" value={pct(r.keptMass)} />
        <Stat label="Most likely token" value={pct(r.after[0])} />
        <Stat label="Chance of a token outside the top 20" value={pct(r.tailAfter)} tone={r.tailAfter > 0.3 ? 'warn' : undefined} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setDraws(draw(d, r, 12))}>Draw 12 tokens</Button>
        {draws.length > 0 && (
          <span className="font-mono text-[0.8125rem] text-ink-2">
            {draws.map((t, i) => (
              <span key={i} className="mr-1.5 inline-block rounded bg-paper px-1">
                {t === null ? <span className="text-warn">(rare token)</span> : show(t)}
              </span>
            ))}
          </span>
        )}
      </div>
      <Narration>{narration}</Narration>
    </WidgetFrame>
  )
}
