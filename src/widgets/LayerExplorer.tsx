import { useState } from 'react'
import { IndexSlider, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// Every operation in one decoder layer with its FLOPs, bytes, arithmetic intensity and roofline time.
// The formulas are layer_ops.py from content/infra/transformer-as-workload.md ("Where the bytes go"), so
// the widget's 8B / H100 numbers match that script's printed table. Element-wise byte counts are rough:
// each op is taken to read and write its activations a few times. Prefill attention assumes a fused
// kernel that scores half the causal square and reads K and V once.
//
// Model shapes: Llama 3 paper (arXiv 2407.21783) and the models' config.json files. GPU peaks: NVIDIA
// spec pages, dense BF16; the M2 row is the chapter 1.2 measurement (roofline_probe.py).

type ModelId = '1b' | '8b' | '70b'
type HwId = 'm2' | 'l4' | 'h100'
type Phase = 'decode' | 'prefill'

const MODELS: Record<ModelId, { name: string; d: number; inter: number; heads: number; kvHeads: number; headDim: number; layers: number }> = {
  '1b': { name: 'Llama 3.2 1B', d: 2048, inter: 8192, heads: 32, kvHeads: 8, headDim: 64, layers: 16 },
  '8b': { name: 'Llama 3.1 8B', d: 4096, inter: 14336, heads: 32, kvHeads: 8, headDim: 128, layers: 32 },
  '70b': { name: 'Llama 3.1 70B', d: 8192, inter: 28672, heads: 64, kvHeads: 8, headDim: 128, layers: 80 },
}
const HARDWARE: Record<HwId, { name: string; peak: number; bandwidth: number }> = {
  m2: { name: 'Apple M2', peak: 2.53e12, bandwidth: 84e9 },
  l4: { name: 'L4', peak: 121e12, bandwidth: 300e9 },
  h100: { name: 'H100', peak: 989e12, bandwidth: 3.35e12 },
}
const BATCHES = [1, 2, 4, 8, 16, 32, 64, 128, 256]
const LENGTHS = [128, 256, 512, 1000, 2000, 4000, 8000, 16000, 32000]
const BYTES = 2

type Op = { name: string; flops: number; bytes: number; kind: 'matmul' | 'attention' | 'elementwise' }

function layerOps(m: (typeof MODELS)[ModelId], seqs: number, fresh: number, context: number): Op[] {
  const t = seqs * fresh
  const linear = (name: string, dIn: number, dOut: number): Op => ({
    name,
    flops: 2 * t * dIn * dOut,
    bytes: BYTES * (dIn * dOut + t * (dIn + dOut)),
    kind: 'matmul',
  })
  const { d, inter, heads, kvHeads, headDim } = m
  return [
    { name: 'RMSNorm ×2 + residual adds', flops: t * d * 10, bytes: BYTES * t * d * 8, kind: 'elementwise' },
    linear('QKV projection', d, (heads + 2 * kvHeads) * headDim),
    { name: 'RoPE', flops: t * (heads + kvHeads) * headDim * 3, bytes: BYTES * t * (heads + kvHeads) * headDim * 2, kind: 'elementwise' },
    {
      name: 'Attention (QK, softmax, PV)',
      flops: seqs * 4 * heads * headDim * fresh * context * (fresh > 1 ? 0.5 : 1),
      bytes: seqs * context * kvHeads * headDim * 2 * BYTES + seqs * fresh * heads * headDim * 2 * BYTES,
      kind: 'attention',
    },
    linear('Output projection', heads * headDim, d),
    linear('Gate + up projection', d, 2 * inter),
    { name: 'SiLU × up', flops: t * inter * 5, bytes: BYTES * t * inter * 3, kind: 'elementwise' },
    linear('Down projection', inter, d),
  ]
}

const COLORS = { matmul: 'var(--w1)', attention: 'var(--w3)', elementwise: 'var(--w4)' }
const time = (s: number) => (s >= 1e-3 ? `${(s * 1e3).toFixed(2)} ms` : `${(s * 1e6).toFixed(s < 1e-5 ? 1 : 0)} µs`)
const share = (x: number) => (x === 0 ? '0%' : x < 0.001 ? '<0.1%' : x < 0.1 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`)
const intensity = (x: number) => (x >= 100 ? Math.round(x).toLocaleString() : x >= 10 ? x.toFixed(0) : x.toFixed(1))

export default function LayerExplorer() {
  const [modelId, setModelId] = useState<ModelId>('8b')
  const [hwId, setHwId] = useState<HwId>('h100')
  const [phase, setPhase] = useState<Phase>('decode')
  const [batchIndex, setBatchIndex] = useState(0)
  const [lengthIndex, setLengthIndex] = useState(4)

  const model = MODELS[modelId]
  const hw = HARDWARE[hwId]
  const batch = phase === 'decode' ? BATCHES[batchIndex] : 1
  const length = LENGTHS[lengthIndex]
  const ops = phase === 'decode' ? layerOps(model, batch, 1, length) : layerOps(model, 1, length, length)
  const ridge = hw.peak / hw.bandwidth
  const rows = ops.map((op) => {
    const compute = op.flops / hw.peak
    const memory = op.bytes / hw.bandwidth
    return { ...op, seconds: Math.max(compute, memory), memoryBound: memory >= compute, intensity: op.flops / op.bytes }
  })
  const totalFlops = rows.reduce((n, r) => n + r.flops, 0)
  const totalTime = rows.reduce((n, r) => n + r.seconds, 0)
  const elementwise = rows.filter((r) => r.kind === 'elementwise')
  const ewFlops = elementwise.reduce((n, r) => n + r.flops, 0) / totalFlops
  const ewTime = elementwise.reduce((n, r) => n + r.seconds, 0) / totalTime
  const attention = rows.find((r) => r.kind === 'attention')!
  const mlp = rows.filter((r) => r.name.includes('projection') && !r.name.startsWith('QKV') && !r.name.startsWith('Output'))
  const mlpTime = mlp.reduce((n, r) => n + r.seconds, 0) / totalTime
  const matmulsBound = rows.filter((r) => r.kind === 'matmul').every((r) => r.memoryBound)

  let note: string
  if (phase === 'prefill') {
    note =
      `With ${length.toLocaleString()} tokens sharing each weight read, the matmuls run at over ${intensity(Math.min(...rows.filter((r) => r.kind === 'matmul').map((r) => r.intensity)))} FLOPs per byte and are ${matmulsBound ? 'still memory-bound on this chip' : 'compute-bound'}. ` +
      `The element-wise operations do ${share(ewFlops)} of the FLOPs but take ${share(ewTime)} of the time, because each one reads and writes the whole activation. Fusing them into the neighbouring kernels removes that traffic.`
  } else if (matmulsBound) {
    note =
      `Every matmul does about ${intensity(rows[1].intensity)} FLOPs per byte, below the ridge point of ${intensity(ridge)}, so its time is the time to read its weights. ` +
      `The MLP holds most of the weights and takes ${share(mlpTime)} of the step. Attention takes ${share(attention.seconds / totalTime)}, and that share grows with the batch and the context, because each sequence reads its own cache.`
  } else {
    note =
      `At batch ${batch} the weight matmuls do about ${intensity(rows[1].intensity)} FLOPs per byte, past the ridge point of ${intensity(ridge)}, so they are compute-bound. ` +
      `Attention stays at ${intensity(attention.intensity)} FLOPs per byte whatever the batch, and it takes ${share(attention.seconds / totalTime)} of the step.`
  }

  return (
    <WidgetFrame
      title="Try it: one decoder layer, operation by operation"
      description="Each row is one operation in a single layer. The grey bar is its share of the layer's FLOPs; the coloured bar is its share of the time on the chosen chip. Where the two differ, the operation is limited by memory, not arithmetic."
    >
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <Segmented
            label="Model"
            value={modelId}
            options={(Object.keys(MODELS) as ModelId[]).map((id) => ({ value: id, label: MODELS[id].name.split(' ').pop()! }))}
            onChange={setModelId}
          />
          <Segmented
            label="Chip"
            value={hwId}
            options={(Object.keys(HARDWARE) as HwId[]).map((id) => ({ value: id, label: HARDWARE[id].name }))}
            onChange={setHwId}
          />
          <Segmented
            label="Phase"
            value={phase}
            options={[
              { value: 'decode', label: 'Decode step' },
              { value: 'prefill', label: 'Prefill' },
            ]}
            onChange={setPhase}
          />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <IndexSlider
            label="Batch"
            index={batchIndex}
            max={BATCHES.length - 1}
            onChange={setBatchIndex}
            disabled={phase === 'prefill'}
            text={phase === 'prefill' ? '1 prompt' : `${batch} ${batch === 1 ? 'sequence' : 'sequences'}`}
          />
          <IndexSlider
            label={phase === 'decode' ? 'Context' : 'Prompt'}
            index={lengthIndex}
            max={LENGTHS.length - 1}
            onChange={setLengthIndex}
            text={`${length.toLocaleString()} tokens`}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-[0.8rem]">
          <thead>
            <tr className="text-left text-[0.75rem] text-muted">
              <th className="py-1 pr-2 font-medium">Operation</th>
              <th className="py-1 pr-2 text-right font-medium">FLOPs per byte</th>
              <th className="py-1 pr-2 font-medium">Limit</th>
              <th className="w-[38%] py-1 font-medium">Share of FLOPs, then of time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-rule">
                <td className="py-1.5 pr-2 text-ink">{r.name}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{intensity(r.intensity)}</td>
                <td className={`py-1.5 pr-2 ${r.memoryBound ? 'text-ink-2' : 'text-done'}`}>{r.memoryBound ? 'memory' : 'compute'}</td>
                <td className="py-1.5">
                  <Bar value={r.flops / totalFlops} color="var(--muted)" />
                  <Bar value={r.seconds / totalTime} color={COLORS[r.kind]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="var(--muted)">share of FLOPs</Key>
        <Key color="var(--w1)">time: weight matmuls</Key>
        <Key color="var(--w3)">time: attention</Key>
        <Key color="var(--w4)">time: element-wise</Key>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="One layer, ideal" value={time(totalTime)} />
        <Stat label={`All ${model.layers} layers`} value={time(totalTime * model.layers)} />
        <Stat label="Ridge point of this chip" value={`${intensity(ridge)} FLOPs/byte`} />
        <Stat label="Element-wise: FLOPs vs time" value={`${share(ewFlops)} vs ${share(ewTime)}`} />
      </div>

      <Narration>{note}</Narration>
    </WidgetFrame>
  )
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-sm bg-paper">
        <div className="h-full" style={{ width: `${Math.max(value * 100, value > 0 ? 0.5 : 0)}%`, background: color }} />
      </div>
      <span className="w-11 text-right text-[0.72rem] text-muted tabular-nums">{share(value)}</span>
    </div>
  )
}
