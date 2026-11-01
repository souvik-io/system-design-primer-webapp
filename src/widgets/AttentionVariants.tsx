import { useState } from 'react'
import { IndexSlider, Narration, Segmented, Stat, WidgetFrame } from './ui'

// How the attention layout sets the KV cache size and decode attention's arithmetic intensity
// (content/infra/transformer-as-workload.md, "Attention variants"). The shape is Llama 3.1 8B's:
// 32 layers, 32 query heads of 128, BF16. Only the number of key/value heads changes.
//
// MLA uses DeepSeek-V2/V3's sizes (arXiv 2405.04434, 2412.19437): a 512-wide latent plus a 64-wide
// RoPE key per token and layer, cached instead of per-head keys and values. Placed on the 8B shape it
// is a hypothetical model, shown for comparison. Its FLOPs assume the "absorbed" form, in which every
// query head scores the 576-wide cached vector and sums the 512-wide latent.
//
// Memory: one H100 (80 GB, 90% usable) minus Llama 3.1 8B's 16.1 GB of BF16 weights leaves 55.9 GB.

type Layout = 32 | 16 | 8 | 4 | 2 | 1 | 'mla'

const LAYERS = 32
const HEADS = 32
const HEAD_DIM = 128
const LATENT = 512
const ROPE_DIM = 64
const KV_ROOM = 80e9 * 0.9 - 16.06e9
const BANDWIDTH = 3.35e12
const CONTEXTS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000]
const BATCHES = [1, 4, 16, 32, 64, 128, 256]

function layout(l: Layout) {
  if (l === 'mla') {
    const bytesPerLayer = (LATENT + ROPE_DIM) * 2
    return {
      name: 'Multi-head latent attention',
      kvPerToken: LAYERS * bytesPerLayer,
      intensity: (HEADS * (2 * (LATENT + ROPE_DIM) + 2 * LATENT)) / bytesPerLayer,
    }
  }
  const name = l === HEADS ? 'Multi-head attention' : l === 1 ? 'Multi-query attention' : 'Grouped-query attention'
  return { name, kvPerToken: 2 * LAYERS * l * HEAD_DIM * 2, intensity: HEADS / l }
}

const gb = (b: number) => (b >= 10e9 ? `${Math.round(b / 1e9)} GB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`)
const ms = (s: number) => (s >= 1e-3 ? `${(s * 1e3).toFixed(2)} ms` : `${Math.round(s * 1e6)} µs`)

export default function AttentionVariants() {
  const [kv, setKv] = useState<Layout>(8)
  const [ctxIndex, setCtxIndex] = useState(1)
  const [batchIndex, setBatchIndex] = useState(4)

  const v = layout(kv)
  const mha = layout(32)
  const context = CONTEXTS[ctxIndex]
  const batch = BATCHES[batchIndex]
  const perSeq = v.kvPerToken * context
  const fits = Math.floor(KV_ROOM / perSeq)
  const readTime = (batch * perSeq) / BANDWIDTH

  // Head diagram geometry
  const W = 640
  const H = 150
  const pad = 16
  const qw = (W - 2 * pad) / HEADS
  const kvCount = kv === 'mla' ? 1 : kv
  const kvw = (W - 2 * pad) / kvCount

  const note =
    kv === 'mla'
      ? `The cache holds one ${LATENT + ROPE_DIM}-number vector per token and layer, shared by all ${HEADS} heads: ${(mha.kvPerToken / v.kvPerToken).toFixed(1)} times smaller than multi-head attention, and smaller than grouped-query attention with 8 KV heads. Every head works from the same cached bytes, so decode attention does about ${Math.round(v.intensity)} FLOPs per byte. The price is extra matmuls to project queries and outputs through the latent space.`
      : kv === HEADS
        ? `Every query head has its own keys and values, so each cached number serves one head: decode attention does 1 FLOP per byte, and a ${context.toLocaleString()}-token sequence needs ${gb(perSeq)} of cache. Only ${fits.toLocaleString()} such sequences fit next to the weights on one H100.`
        : `Each of the ${kv} key/value ${kv === 1 ? 'head is' : 'heads is'} shared by ${HEADS / kv} query heads, so each cached number is used ${HEADS / kv} times: the cache is ${HEADS / kv} times smaller than multi-head attention and decode attention does ${HEADS / kv} FLOPs per byte. ${kv === 1 ? 'Quality can drop with a single head, which is why most models settled on a few.' : `${fits.toLocaleString()} sequences of ${context.toLocaleString()} tokens fit next to the weights.`}`

  return (
    <WidgetFrame
      title="Try it: how many key/value heads?"
      description="All 32 query heads stay. Change how many key/value heads they share, or switch to a latent cache, and see the KV cache per token, how many sequences fit on one H100, and how much work each cached byte does in decode."
    >
      <div className="space-y-2.5">
        <Segmented
          label="Key/value heads"
          value={kv}
          options={[
            { value: 32 as Layout, label: '32 (MHA)' },
            { value: 16 as Layout, label: '16' },
            { value: 8 as Layout, label: '8 (Llama 3)' },
            { value: 4 as Layout, label: '4' },
            { value: 2 as Layout, label: '2' },
            { value: 1 as Layout, label: '1 (MQA)' },
            { value: 'mla' as Layout, label: 'Latent (MLA)' },
          ]}
          onChange={setKv}
        />
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <IndexSlider
            label="Context"
            index={ctxIndex}
            max={CONTEXTS.length - 1}
            onChange={setCtxIndex}
            text={`${context.toLocaleString()} tokens`}
          />
          <IndexSlider label="Batch" index={batchIndex} max={BATCHES.length - 1} onChange={setBatchIndex} text={`${batch} sequences`} />
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${v.name}: 32 query heads sharing ${kv === 'mla' ? 'one latent vector' : `${kv} key/value heads`}`}
      >
        <text x={pad} y={14} fontSize={11.5} fill="var(--ink-2)">
          32 query heads
        </text>
        {Array.from({ length: HEADS }, (_, i) => {
          const target = kv === 'mla' ? 0 : Math.floor(i / (HEADS / kvCount))
          return (
            <g key={i}>
              <line
                x1={pad + (i + 0.5) * qw}
                y1={46}
                x2={pad + (target + 0.5) * kvw}
                y2={98}
                stroke={kv === 'mla' ? 'var(--w5)' : 'var(--w3)'}
                strokeOpacity={0.55}
              />
              <rect x={pad + i * qw + 1.5} y={22} width={qw - 3} height={24} rx={3} fill="var(--w1)" />
            </g>
          )
        })}
        {Array.from({ length: kvCount }, (_, j) => (
          <rect key={j} x={pad + j * kvw + 1.5} y={98} width={kvw - 3} height={24} rx={3} fill={kv === 'mla' ? 'var(--w5)' : 'var(--w3)'} />
        ))}
        <text x={pad} y={140} fontSize={11.5} fill="var(--ink-2)">
          {kv === 'mla'
            ? `one cached latent of ${LATENT} + ${ROPE_DIM} numbers per token and layer`
            : `${kv} cached key/value ${kv === 1 ? 'head' : 'heads'} of ${HEAD_DIM}, each used by ${HEADS / kvCount} query ${HEADS / kvCount === 1 ? 'head' : 'heads'}`}
        </text>
      </svg>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="KV cache per token" value={`${v.kvPerToken.toLocaleString()} bytes`} />
        <Stat label="Sequences that fit (one H100)" value={fits.toLocaleString()} tone={fits < batch ? 'bad' : undefined} />
        <Stat label="Decode attention intensity" value={`${Math.round(v.intensity)} FLOPs/byte`} />
        <Stat
          label={`Cache read per step, batch ${batch}`}
          value={`${gb(batch * perSeq)}, ${ms(readTime)}`}
          tone={fits < batch ? 'bad' : undefined}
        />
      </div>

      <Narration tone={fits < batch ? 'bad' : undefined}>
        {note}
        {fits < batch
          ? ` A batch of ${batch} at this context does not fit: the cache would need ${gb(batch * perSeq)} and ${gb(KV_ROOM)} is free.`
          : ''}
      </Narration>
    </WidgetFrame>
  )
}
