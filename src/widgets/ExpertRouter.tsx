import { useMemo, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button, IndexSlider, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// A batch of tokens routed through one mixture-of-experts layer (content/infra/mixture-of-experts.md).
// Each token picks its top-k experts. The router is simulated: every expert gets a fixed popularity, and
// each token samples k distinct experts in proportion to it (Gumbel top-k). "Even" gives all experts the
// same popularity. "Like a trained router" is calibrated to what expert_load.py measured on Granite 3.1
// 1B-A400M (32 experts, top 8): the busiest expert at about 3x the even share, and about 18 of 32 experts
// touched by 4 tokens and 27 by 16, against 22 and 32 with even routing.
//
// Expert counts and top-k: Mixtral paper (arXiv 2401.04088), Granite and Qwen3 config.json files,
// DeepSeek-V3 paper (arXiv 2412.19437; it also has one shared expert that every token uses).
// Capacity: Switch Transformer (arXiv 2101.03961), capacity = tokens x k / experts x capacity factor.

type PresetId = 'mixtral' | 'granite' | 'qwen' | 'deepseek'
type Balance = 'even' | 'trained' | 'poor'
type Capacity = 'off' | '1' | '1.25' | '2'

const PRESETS: Record<PresetId, { name: string; experts: number; topK: number }> = {
  mixtral: { name: 'Mixtral 8x7B', experts: 8, topK: 2 },
  granite: { name: 'Granite 1B-A400M', experts: 32, topK: 8 },
  qwen: { name: 'Qwen3-30B-A3B', experts: 128, topK: 8 },
  deepseek: { name: 'DeepSeek-V3', experts: 256, topK: 8 },
}
const SPREAD: Record<Balance, number> = { even: 0, trained: 1, poor: 2 }
const BATCHES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]
const MAX_TOKENS = BATCHES[BATCHES.length - 1]
const GPU_COUNTS = [1, 4, 8]

/** A small seeded random generator (mulberry32), so a given setting always draws the same batch. */
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

/** Expert choices for MAX_TOKENS tokens: choices[t] holds token t's k distinct experts. */
function drawTokens(experts: number, topK: number, spread: number, seed: number) {
  const pop = rng(experts * 7919)
  // Popularity: log-weights from a fixed normal draw per expert count, scaled by the spread.
  const logPop = Array.from({ length: experts }, () => {
    const u = Math.max(pop(), 1e-12)
    return spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * pop())
  })
  const rand = rng(seed * 104729 + experts * 31 + topK)
  const choices: number[][] = []
  const scores = new Float64Array(experts)
  const order = Array.from({ length: experts }, (_, i) => i)
  for (let t = 0; t < MAX_TOKENS; t++) {
    for (let i = 0; i < experts; i++) scores[i] = logPop[i] - Math.log(-Math.log(Math.max(rand(), 1e-12)))
    order.sort((a, b) => scores[b] - scores[a])
    choices.push(order.slice(0, topK))
  }
  return choices
}

const pct = (x: number) => `${x >= 0.995 || x === 0 ? Math.round(x * 100) : (x * 100).toFixed(x < 0.1 ? 1 : 0)}%`
const one = (x: number) => (x >= 10 ? Math.round(x).toLocaleString() : x.toFixed(1))

// Bar chart geometry
const W = 640
const H = 190
const L = 40
const R = 12
const T = 12
const B = 26

export default function ExpertRouter() {
  const [presetId, setPresetId] = useState<PresetId>('qwen')
  const [topK, setTopK] = useState(PRESETS.qwen.topK)
  const [batchIndex, setBatchIndex] = useState(3)
  const [balance, setBalance] = useState<Balance>('trained')
  const [capacity, setCapacity] = useState<Capacity>('off')
  const [gpus, setGpus] = useState(1)
  const [seed, setSeed] = useState(1)

  const preset = PRESETS[presetId]
  const experts = preset.experts
  const k = Math.min(topK, experts)
  const batch = BATCHES[batchIndex]

  const choices = useMemo(() => drawTokens(experts, k, SPREAD[balance], seed), [experts, k, balance, seed])

  // Tokens per expert for this batch, and experts touched for every batch size (for the curve).
  const counts = new Array<number>(experts).fill(0)
  for (let t = 0; t < batch; t++) for (const e of choices[t]) counts[e]++
  const touchedAt = useMemo(
    () =>
      BATCHES.map((b) => {
        const seen = new Set<number>()
        for (let t = 0; t < b; t++) for (const e of choices[t]) seen.add(e)
        return seen.size
      }),
    [choices],
  )
  const touched = touchedAt[batchIndex]
  const evenTouched = (b: number) => experts * (1 - (1 - k / experts) ** b)

  const slots = batch * k
  const mean = slots / experts
  const busiest = Math.max(...counts)
  const cap = capacity === 'off' ? Infinity : Math.max(1, Math.ceil(Number(capacity) * mean))
  const dropped = counts.reduce((n, c) => n + Math.max(0, c - cap), 0)

  const perGpu = Array.from({ length: gpus }, (_, g) => {
    const size = experts / gpus
    return counts.slice(g * size, (g + 1) * size).reduce((a, b) => a + b, 0)
  })
  const gpuImbalance = gpus > 1 ? Math.max(...perGpu) / (slots / gpus) : 1

  const yMax = Math.max(busiest, capacity === 'off' ? 0 : cap, mean) * 1.15 || 1
  const yOf = (v: number) => T + (1 - v / yMax) * (H - T - B)
  const slot = (W - L - R) / experts
  const barW = Math.max(1, slot * (experts > 64 ? 0.9 : 0.75))

  let note: ReactNode
  if (capacity !== 'off' && dropped > 0) {
    note = `Each expert takes at most ${cap} tokens here (${capacity} x the even share of ${one(mean)}). ${dropped} of ${slots} token-expert pairs, ${pct(dropped / slots)}, overflow and skip that expert, passing through the residual connection instead. Switch Transformer used this during training. DeepSeek-V3 drops no tokens, and serving engines such as vLLM compute every routed token, so in serving an uneven load costs time rather than quality.`
  } else if (touched < experts) {
    note = `${batch} ${batch === 1 ? 'token picks' : 'tokens pick'} ${touched} of the ${experts} experts, so this decode step reads only ${pct(touched / experts)} of the layer's expert weights. Each expert it reads serves about ${one(slots / touched)} ${slots / touched < 1.5 ? 'token' : 'tokens'}, so the expert matmuls do about ${one(slots / touched)} FLOPs per byte in BF16, far below an H100's ridge point of 295. A bigger batch reads more experts, so it is not free the way it is for a dense model.`
  } else {
    note = `Every expert is touched, so the step reads all the expert weights, as a dense model of the same total size would. Each expert serves about ${one(mean)} tokens, so the expert matmuls run at about ${one(mean)} FLOPs per byte; a dense model at the same batch would be at ${batch}. That gap is why MoE models need far larger batches than dense ones to become compute-bound.`
  }
  if (gpus > 1)
    note = (
      <>
        {note} With experts split over {gpus} GPUs, the busiest GPU has {gpuImbalance.toFixed(2)} times its even share of work, and the whole layer
        waits for it.
      </>
    )

  return (
    <WidgetFrame
      title="Try it: route a batch through an MoE layer"
      description="Each token picks its top-k experts. Change the model, the batch size and how evenly the router spreads its choices, and watch how many experts a decode step has to read, how busy the busiest one is, and what a capacity limit does. The trained setting copies the unevenness measured on Granite's 32 experts; with more experts, the same unevenness makes the busiest expert stand out further, and models trained with stronger balancing may be more even."
    >
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <Segmented
            label="Model"
            value={presetId}
            options={(Object.keys(PRESETS) as PresetId[]).map((id) => ({ value: id, label: PRESETS[id].name }))}
            onChange={(id) => {
              setPresetId(id)
              setTopK(PRESETS[id].topK)
            }}
          />
          <Segmented
            label="Top-k"
            value={k}
            options={[1, 2, 4, 8].filter((v) => v <= experts).map((v) => ({ value: v, label: String(v) }))}
            onChange={setTopK}
          />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <Segmented
            label="Router"
            value={balance}
            options={[
              { value: 'even', label: 'Even' },
              { value: 'trained', label: 'Like a trained router' },
              { value: 'poor', label: 'Poorly balanced' },
            ]}
            onChange={setBalance}
          />
          <Segmented
            label="Capacity factor"
            value={capacity}
            options={[
              { value: 'off', label: 'None' },
              { value: '1', label: '1.0' },
              { value: '1.25', label: '1.25' },
              { value: '2', label: '2.0' },
            ]}
            onChange={setCapacity}
          />
          <Segmented label="GPUs" value={gpus} options={GPU_COUNTS.map((g) => ({ value: g, label: String(g) }))} onChange={setGpus} />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <IndexSlider
            label="Tokens in the batch"
            index={batchIndex}
            max={BATCHES.length - 1}
            onChange={setBatchIndex}
            text={`${batch.toLocaleString()} ${batch === 1 ? 'token' : 'tokens'}`}
          />
          <Button onClick={() => setSeed((s) => s + 1)} title="Draw a new batch of tokens">
            <RefreshCw size={14} aria-hidden /> New batch
          </Button>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Tokens per expert for ${batch} tokens over ${experts} experts: ${touched} experts used, the busiest has ${busiest} tokens against an even share of ${one(mean)}.`}
      >
        {gpus > 1 &&
          perGpu.map((_, g) => (
            <g key={g}>
              <rect
                x={L + (g * (W - L - R)) / gpus}
                y={T}
                width={(W - L - R) / gpus}
                height={H - T - B}
                fill={g % 2 ? 'var(--paper)' : 'transparent'}
              />
              <text x={L + ((g + 0.5) * (W - L - R)) / gpus} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
                GPU {g}
              </text>
            </g>
          ))}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="var(--rule)" />
        {[0, Math.round(yMax / 1.15 / 2), Math.round(yMax / 1.15)].map((v) => (
          <text key={v} x={L - 6} y={yOf(v) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
            {v}
          </text>
        ))}
        {counts.map((c, i) => {
          const x = L + i * slot + (slot - barW) / 2
          const kept = Math.min(c, cap)
          return (
            <g key={i}>
              {kept > 0 && <rect x={x} y={yOf(kept)} width={barW} height={yOf(0) - yOf(kept)} fill="var(--w1)" />}
              {c > cap && <rect x={x} y={yOf(c)} width={barW} height={yOf(cap) - yOf(c)} fill="var(--bad)" />}
            </g>
          )
        })}
        <line x1={L} x2={W - R} y1={yOf(mean)} y2={yOf(mean)} stroke="var(--ink-2)" strokeDasharray="4 4" />
        <text x={W - R} y={yOf(mean) - 5} textAnchor="end" fontSize={11} fill="var(--ink-2)">
          even share {one(mean)}
        </text>
        {capacity !== 'off' && (
          <>
            <line x1={L} x2={W - R} y1={yOf(cap)} y2={yOf(cap)} stroke="var(--bad)" strokeWidth={1.5} />
            <text x={L + 4} y={yOf(cap) - 5} fontSize={11} fill="var(--bad)">
              capacity {cap}
            </text>
          </>
        )}
        {gpus === 1 && (
          <text x={(L + W - R) / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {experts} experts, tokens each one received
          </text>
        )}
      </svg>

      <TouchedCurve experts={experts} touchedAt={touchedAt} batchIndex={batchIndex} even={evenTouched} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Experts touched" value={`${touched} of ${experts}`} />
        <Stat label="Expert weights read" value={pct(touched / experts)} />
        <Stat label="Busiest expert vs even share" value={`${(busiest / mean).toFixed(2)}x`} tone={mean >= 2 && busiest / mean > 2.5 ? 'warn' : undefined} />
        {capacity !== 'off' ? (
          <Stat label="Token-expert pairs dropped" value={pct(dropped / slots)} tone={dropped > 0 ? 'bad' : 'good'} />
        ) : gpus > 1 ? (
          <Stat label="Busiest GPU vs even share" value={`${gpuImbalance.toFixed(2)}x`} tone={gpuImbalance > 1.3 ? 'warn' : undefined} />
        ) : (
          <Stat label="Tokens per touched expert" value={one(slots / touched)} />
        )}
      </div>

      <Narration tone={capacity !== 'off' && dropped > 0 ? 'bad' : undefined}>{note}</Narration>
    </WidgetFrame>
  )
}

/** Share of experts touched against batch size: this router's draws and the even-routing formula. */
function TouchedCurve({
  experts,
  touchedAt,
  batchIndex,
  even,
}: {
  experts: number
  touchedAt: number[]
  batchIndex: number
  even: (b: number) => number
}) {
  const w = 640
  const h = 150
  const l = 40
  const r = 12
  const t = 22
  const b = 30
  const xOf = (i: number) => l + (i / (BATCHES.length - 1)) * (w - l - r)
  const xOfBatch = (batch: number) => l + (Math.log2(batch) / Math.log2(MAX_TOKENS)) * (w - l - r)
  const yOf = (share: number) => t + (1 - share) * (h - t - b)
  const curve = Array.from({ length: 101 }, (_, i) => {
    const batch = 2 ** ((i / 100) * Math.log2(MAX_TOKENS))
    return `${i ? 'L' : 'M'} ${xOfBatch(batch)} ${yOf(even(batch) / experts)}`
  }).join(' ')
  return (
    <figure className="space-y-1">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" role="img" aria-label="Share of experts touched against batch size">
        <text x={l} y={13} fontSize={11.5} fill="var(--ink-2)">
          Share of experts a decode step reads, by batch size
        </text>
        {[0, 0.5, 1].map((s) => (
          <g key={s}>
            <line x1={l} x2={w - r} y1={yOf(s)} y2={yOf(s)} stroke="var(--rule)" />
            <text x={l - 6} y={yOf(s) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {s * 100}%
            </text>
          </g>
        ))}
        {BATCHES.map((batch, i) => (
          <text key={batch} x={xOf(i)} y={h - 12} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {batch}
          </text>
        ))}
        <path d={curve} fill="none" stroke="var(--ink-2)" strokeWidth={1.5} strokeDasharray="4 4" />
        <polyline points={touchedAt.map((u, i) => `${xOf(i)},${yOf(u / experts)}`).join(' ')} fill="none" stroke="var(--w1)" strokeWidth={1.5} />
        {touchedAt.map((u, i) => (
          <circle
            key={i}
            cx={xOf(i)}
            cy={yOf(u / experts)}
            r={i === batchIndex ? 6 : 3}
            fill="var(--w1)"
            stroke="var(--surface)"
            strokeWidth={i === batchIndex ? 2 : 0}
          />
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 text-[0.75rem] text-muted">
        <Key color="var(--w1)">this router, this draw</Key>
        <span className="flex items-center gap-1.5">
          <span className="w-4 border-t-[1.5px] border-dashed border-ink-2" />
          even routing: E x (1 - (1 - k/E)^B)
        </span>
        <span>tokens in the batch (B), log scale</span>
      </figcaption>
    </figure>
  )
}
