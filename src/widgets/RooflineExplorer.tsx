import { useState, type ReactNode } from 'react'
import { IndexSlider as Slider, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// A roofline for one GPU with a model's decode step or prefill placed on it. The step is split into its
// two parts, the weight matmuls and attention, because batching shares the weights across sequences but
// every sequence reads its own KV cache (content/infra/inference-arithmetic.md, "The step-time model").
// Each part takes max(FLOPs / peak, bytes / bandwidth); the step is their sum. Times are ideal: real
// kernels reach a fraction of both limits.
//
// GPU figures: dense (non-sparse) peaks from NVIDIA's spec pages, as tabled in content/gpus-for-ai.md and
// content/infra/models-and-machines.md. The M2 row is measured with roofline_probe.py in the chapter.
// Model shapes: Llama 3 paper and the models' config.json files. Decimal units: 1 GB = 10^9 bytes.

type HwId = 'm2' | 'l4' | 'a100' | 'h100' | 'h200' | 'b200'
type ModelId = '1b' | '8b' | '70b' | 'moe'
type Phase = 'decode' | 'prefill'

const HARDWARE: Record<HwId, { name: string; bandwidth: number; bf16: number; fp8?: number; usable: number; note?: string }> = {
  m2: { name: 'Apple M2', bandwidth: 84e9, bf16: 2.53e12, usable: 5.7e9, note: 'measured: FP16, 84 GB/s copy, 5.7 GB usable by the GPU' },
  l4: { name: 'L4', bandwidth: 300e9, bf16: 121e12, fp8: 242e12, usable: 24e9 * 0.9 },
  a100: { name: 'A100', bandwidth: 2.039e12, bf16: 312e12, usable: 80e9 * 0.9, note: 'no FP8 Tensor Cores, so FP8 weights are computed in BF16' },
  h100: { name: 'H100', bandwidth: 3.35e12, bf16: 989e12, fp8: 1979e12, usable: 80e9 * 0.9 },
  h200: { name: 'H200', bandwidth: 4.8e12, bf16: 989e12, fp8: 1979e12, usable: 141e9 * 0.9 },
  b200: { name: 'B200', bandwidth: 8e12, bf16: 2250e12, fp8: 4500e12, usable: 180e9 * 0.9 },
}

type Moe = { always: number; expert: number; experts: number; topK: number }

const MODELS: Record<
  ModelId,
  { name: string; short: string; matmul: number; stored: number; layers: number; qWidth: number; kvPerToken: number; attnPerCtx: number; moe?: Moe }
> = {
  // matmul: parameters one token multiplies through; stored: all parameters, which set memory.
  // kvPerToken: BF16 bytes, 2 x layers x KV heads x head dim x 2. attnPerCtx: 4 x layers x query heads x head dim.
  '1b': {
    name: 'Llama 3.2 1B',
    short: '1B',
    matmul: 1.236e9,
    stored: 1.236e9,
    layers: 16,
    qWidth: 2048,
    kvPerToken: 32_768,
    attnPerCtx: 4 * 16 * 2048,
  },
  '8b': {
    name: 'Llama 3.1 8B',
    short: '8B',
    matmul: 7.5e9,
    stored: 8.03e9,
    layers: 32,
    qWidth: 4096,
    kvPerToken: 131_072,
    attnPerCtx: 4 * 32 * 4096,
  },
  '70b': {
    name: 'Llama 3.1 70B',
    short: '70B',
    matmul: 70e9,
    stored: 70e9,
    layers: 80,
    qWidth: 8192,
    kvPerToken: 327_680,
    attnPerCtx: 4 * 80 * 8192,
  },
  // Qwen3-30B-A3B (config.json): 48 layers, 32 query and 4 KV heads of 128, 128 experts of 3 x 2048 x 768, top 8.
  // `always` is what every step reads: attention, routers and the LM head. Experts are read only if chosen.
  moe: {
    name: 'Qwen3-30B-A3B',
    short: '30B-A3B',
    matmul: 3.04e9,
    stored: 30.53e9,
    layers: 48,
    qWidth: 4096,
    kvPerToken: 98_304,
    attnPerCtx: 4 * 48 * 4096,
    moe: { always: 48 * (18_874_368 + 262_144) + 151_936 * 2048, expert: 48 * 3 * 2048 * 768, experts: 128, topK: 8 },
  },
}

/** Weight parameters one step reads. An MoE layer reads each expert that at least one of `tokens` chose;
 * with even routing that is E x (1 - (1 - k/E)^tokens) experts per layer. */
function weightsRead(model: (typeof MODELS)[ModelId], tokens: number) {
  if (!model.moe) return { params: model.matmul, touched: undefined }
  const { always, expert, experts, topK } = model.moe
  const touched = experts * (1 - (1 - topK / experts) ** tokens)
  return { params: always + touched * expert, touched }
}

const BATCHES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]
const CONTEXTS = [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000]

// Chart geometry: log-log, intensity 0.25 to 10,000 FLOPs per byte, performance 0.01 to 10,000 TFLOP/s.
const W = 640
const H = 300
const L = 52
const R = 16
const T = 14
const B = 40
const X_MIN = Math.log10(0.25)
const X_MAX = Math.log10(10_000)
const Y_MIN = -2
const Y_MAX = 4
const xOf = (intensity: number) => L + ((Math.log10(intensity) - X_MIN) / (X_MAX - X_MIN)) * (W - L - R)
const yOf = (flops: number) => T + (1 - (Math.log10(flops / 1e12) - Y_MIN) / (Y_MAX - Y_MIN)) * (H - T - B)

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes >= 100e9 ? 0 : 1)} GB`
const time = (s: number) => (s >= 1 ? `${s.toFixed(2)} s` : s >= 1e-3 ? `${(s * 1e3).toFixed(2)} ms` : `${Math.round(s * 1e6)} µs`)
const num = (n: number) => (n >= 100 ? Math.round(n).toLocaleString() : n >= 10 ? n.toFixed(0) : n.toFixed(1))

type PartResult = { flops: number; bytes: number; peak: number; seconds: number; intensity: number; memoryBound: boolean }

function part(flops: number, bytes: number, peak: number, bandwidth: number): PartResult {
  const compute = flops / peak
  const memory = bytes / bandwidth
  return { flops, bytes, peak, seconds: Math.max(compute, memory), intensity: flops / bytes, memoryBound: memory >= compute }
}

export default function RooflineExplorer() {
  const [hwId, setHwId] = useState<HwId>('h100')
  const [modelId, setModelId] = useState<ModelId>('8b')
  const [phase, setPhase] = useState<Phase>('decode')
  const [weightBytes, setWeightBytes] = useState(2)
  const [kvBytes, setKvBytes] = useState(2)
  const [batchIndex, setBatchIndex] = useState(0)
  const [ctxIndex, setCtxIndex] = useState(2)

  const hw = HARDWARE[hwId]
  const model = MODELS[modelId]
  const batch = phase === 'decode' ? BATCHES[batchIndex] : 1
  const context = CONTEXTS[ctxIndex]
  // FP8 weights run on FP8 Tensor Cores where the GPU has them. Attention is computed in BF16 either way.
  const fp8Compute = weightBytes === 1 && hw.fp8 !== undefined
  const weightPeak = fp8Compute ? hw.fp8! : hw.bf16
  const kvPerToken = (model.kvPerToken * kvBytes) / 2
  const read = weightsRead(model, phase === 'decode' ? batch : context)

  let weights: PartResult
  let attention: PartResult
  if (phase === 'decode') {
    weights = part(batch * 2 * model.matmul, read.params * weightBytes, weightPeak, hw.bandwidth)
    attention = part(batch * context * model.attnPerCtx, batch * context * kvPerToken, hw.bf16, hw.bandwidth)
  } else {
    // One prompt of `context` tokens. A fused attention kernel scores about half the prompt x prompt square
    // (the causal mask), writes K and V once, and reads Q and writes the output once per layer.
    weights = part(2 * context * model.matmul, read.params * weightBytes, weightPeak, hw.bandwidth)
    attention = part(
      (model.attnPerCtx * context * context) / 2,
      context * kvPerToken + model.layers * context * model.qWidth * 2 * 2,
      hw.bf16,
      hw.bandwidth,
    )
  }
  const step = weights.seconds + attention.seconds

  const weightMemory = model.stored * weightBytes
  const kvFree = hw.usable - weightMemory
  const maxBatch = kvFree > 0 ? Math.floor(kvFree / (context * kvPerToken)) : 0
  const fits = kvFree > 0 && maxBatch >= batch
  const ridge = weightPeak / hw.bandwidth
  const attnRidge = hw.bf16 / hw.bandwidth

  const roof = (peak: number) => {
    const knee = peak / hw.bandwidth
    const x0 = 10 ** X_MIN
    return `M ${xOf(x0)} ${yOf(hw.bandwidth * x0)} L ${xOf(knee)} ${yOf(peak)} L ${xOf(10 ** X_MAX)} ${yOf(peak)}`
  }

  let note: ReactNode
  if (kvFree <= 0) {
    note = `${model.name}'s weights take ${gb(weightMemory)} at this precision, more than the ${gb(hw.usable)} one ${hw.name} can use. Pick a smaller model, FP8, or a bigger GPU.`
  } else if (!fits) {
    note = `The weights fit, but ${batch} sequences of ${context.toLocaleString()} tokens need ${gb(batch * context * kvPerToken)} of KV cache and only ${gb(kvFree)} is left. Memory holds a batch of ${maxBatch}. The times below are what the step would take if it fit.`
  } else if (phase === 'prefill') {
    note =
      `Prefill runs all ${context.toLocaleString()} prompt tokens through each weight it reads, so the matmuls sit at ${num(weights.intensity)} FLOPs per byte, ` +
      `${weights.memoryBound ? 'still below' : 'past'} the ridge point of ${num(ridge)}. Attention's share is ${Math.round((attention.seconds / step) * 100)}% and grows with the square of the prompt. ` +
      `At 100% of peak the first token waits ${time(step)}; a real kernel at half of peak takes twice that.`
  } else {
    const moe = model.moe
    const wb = moe
      ? `This batch touches about ${num(read.touched!)} of the ${moe.experts} experts in each layer, so the step reads ${gb(weights.bytes)} of weights. ` +
        (read.touched! < moe.experts * 0.95
          ? `A bigger batch touches more experts, so unlike a dense model the weight reads grow with the batch until every expert is hit.`
          : `Every expert is now hit, so the weight reads stop growing; the matmuls are at ${num(weights.intensity)} FLOPs per byte against a ridge of ${num(ridge)}.`)
      : weights.memoryBound
        ? `The weight matmuls are memory-bound (${num(weights.intensity)} FLOPs per byte, ridge ${num(ridge)}): the step reads all ${gb(weights.bytes)} of weights however many sequences share it, so a bigger batch is nearly free.`
        : `The weight matmuls have passed the ridge point (${num(weights.intensity)} against ${num(ridge)}) and are compute-bound: a bigger batch now costs time in proportion.`
    const ab =
      batch * context * kvPerToken > weights.bytes
        ? ` Attention now reads more bytes than the weights do: its intensity stays at ${num(attention.intensity)} at any batch, because every sequence reads its own cache.`
        : ` Attention sits at ${num(attention.intensity)} FLOPs per byte at every batch size, since each sequence reads its own cache.`
    note = wb + ab
  }

  const pct = (s: number) => `${(s / step) * 100}%`

  return (
    <WidgetFrame
      title="Try it: a decode step on the roofline"
      description="Pick a GPU, a model and its number formats, then move the batch and context. Each part of the step lands on the roofline at its arithmetic intensity, and takes whichever is longer: its arithmetic or its memory reads. Times are ideal; real engines are slower."
    >
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <Segmented
            label="GPU"
            value={hwId}
            options={(Object.keys(HARDWARE) as HwId[]).map((id) => ({ value: id, label: HARDWARE[id].name }))}
            onChange={setHwId}
          />
          <Segmented
            label="Model"
            value={modelId}
            options={(Object.keys(MODELS) as ModelId[]).map((id) => ({ value: id, label: MODELS[id].short }))}
            onChange={setModelId}
          />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <Segmented
            label="Phase"
            value={phase}
            options={[
              { value: 'decode', label: 'Decode step' },
              { value: 'prefill', label: 'Prefill' },
            ]}
            onChange={setPhase}
          />
          <Segmented
            label="Weights"
            value={weightBytes}
            options={[
              { value: 2, label: 'BF16' },
              { value: 1, label: 'FP8' },
            ]}
            onChange={setWeightBytes}
          />
          <Segmented
            label="KV cache"
            value={kvBytes}
            options={[
              { value: 2, label: 'BF16' },
              { value: 1, label: 'FP8' },
            ]}
            onChange={setKvBytes}
          />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Slider
            label={phase === 'decode' ? 'Batch' : 'Batch (prefill: one prompt)'}
            index={batchIndex}
            max={BATCHES.length - 1}
            onChange={setBatchIndex}
            disabled={phase === 'prefill'}
            text={`${batch} ${batch === 1 ? 'sequence' : 'sequences'}`}
          />
          <Slider
            label={phase === 'decode' ? 'Context' : 'Prompt'}
            index={ctxIndex}
            max={CONTEXTS.length - 1}
            onChange={setCtxIndex}
            text={`${context.toLocaleString()} tokens`}
          />
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Roofline for ${hw.name}. Weight matmuls at ${num(weights.intensity)} FLOPs per byte, ${weights.memoryBound ? 'memory' : 'compute'}-bound. Attention at ${num(attention.intensity)} FLOPs per byte, ${attention.memoryBound ? 'memory' : 'compute'}-bound.`}
      >
        {[-2, -1, 0, 1, 2, 3, 4].map((e) => (
          <g key={`y${e}`}>
            <line x1={L} x2={W - R} y1={yOf(10 ** e * 1e12)} y2={yOf(10 ** e * 1e12)} stroke="var(--rule)" strokeWidth={1} />
            <text x={L - 6} y={yOf(10 ** e * 1e12) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {10 ** e >= 1 ? (10 ** e).toLocaleString() : 10 ** e}
            </text>
          </g>
        ))}
        {[1, 10, 100, 1000, 10000].map((v) => (
          <g key={`x${v}`}>
            <line x1={xOf(v)} x2={xOf(v)} y1={T} y2={H - B} stroke="var(--rule)" strokeWidth={1} />
            <text x={xOf(v)} y={H - B + 15} textAnchor="middle" fontSize={11} fill="var(--muted)">
              {v.toLocaleString()}
            </text>
          </g>
        ))}
        <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" fontSize={11.5} fill="var(--ink-2)">
          Arithmetic intensity (FLOPs per byte read)
        </text>
        <text x={12} y={(T + H - B) / 2} textAnchor="middle" fontSize={11.5} fill="var(--ink-2)" transform={`rotate(-90 12 ${(T + H - B) / 2})`}>
          TFLOP/s
        </text>

        {fp8Compute && <path d={roof(hw.bf16)} fill="none" stroke="var(--muted)" strokeWidth={1.25} strokeDasharray="4 4" />}
        <path d={roof(weightPeak)} fill="none" stroke="var(--ink-2)" strokeWidth={2} />
        <line x1={xOf(ridge)} x2={xOf(ridge)} y1={yOf(weightPeak)} y2={H - B} stroke="var(--ink-2)" strokeWidth={1} strokeDasharray="3 3" />
        <text x={xOf(ridge) + 4} y={H - B - 6} fontSize={11} fill="var(--ink-2)">
          ridge {num(ridge)}
        </text>
        <text x={L + 8} y={T + 14} fontSize={11.5} fill="var(--ink-2)">
          {hw.name}: peak {num(weightPeak / 1e12)} TFLOP/s {fp8Compute ? 'FP8' : hwId === 'm2' ? 'FP16' : 'BF16'}, {num(hw.bandwidth / 1e9)} GB/s
        </text>

        <Point
          x={attention.intensity}
          y={Math.min(hw.bf16, hw.bandwidth * attention.intensity)}
          color="var(--w3)"
          label="attention"
          below={phase === 'prefill'}
        />
        <Point
          x={weights.intensity}
          y={Math.min(weightPeak, hw.bandwidth * weights.intensity)}
          color="var(--w1)"
          label="weight matmuls"
          below={phase === 'decode'}
        />
      </svg>

      <div>
        <div
          className="flex h-6 w-full overflow-hidden rounded-md border border-rule bg-paper"
          role="img"
          aria-label={`Step time ${time(step)}: weight matmuls ${time(weights.seconds)}, attention ${time(attention.seconds)}`}
        >
          <div className="h-full shrink-0" style={{ width: pct(weights.seconds), background: 'var(--w1)' }} />
          <div className="h-full shrink-0" style={{ width: pct(attention.seconds), background: 'var(--w3)' }} />
        </div>
        <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
          <Key color="var(--w1)">
            weight matmuls {time(weights.seconds)}, {weights.memoryBound ? 'memory' : 'compute'}-bound
          </Key>
          <Key color="var(--w3)">
            attention {time(attention.seconds)}, {attention.memoryBound ? 'memory' : 'compute'}-bound
          </Key>
          {hw.note && (
            <span>
              {hw.name}: {hw.note}
            </span>
          )}
          {weightBytes === 1 && !fp8Compute && hwId !== 'a100' && <span>FP8 weights computed in FP16 on this chip</span>}
          {attnRidge !== ridge && <span>dashed: BF16 roof, used by attention</span>}
        </p>
      </div>

      {phase === 'decode' ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Decode step (inter-token latency)" value={time(step)} />
          <Stat label="Speed per sequence" value={`${num(1 / step)} tokens/s`} />
          <Stat label="Total speed" value={`${num(batch / step)} tokens/s`} />
          <Stat
            label="Batch memory allows"
            value={kvFree > 0 ? maxBatch.toLocaleString() : 'none'}
            tone={!fits ? 'bad' : maxBatch < 8 ? 'warn' : undefined}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Prefill at 100% of peak" value={time(step)} />
          <Stat label="Prompt tokens per second" value={num(context / step)} />
          <Stat label="Attention's share" value={`${Math.round((attention.seconds / step) * 100)}%`} />
          <Stat label="Fits in memory" value={fits ? 'yes' : 'no'} tone={fits ? undefined : 'bad'} />
        </div>
      )}

      <Narration tone={!fits ? 'bad' : undefined}>{note}</Narration>
    </WidgetFrame>
  )
}

/** A dot on the roof with its label. Labels above sit to the left and labels below to the right, so they
 * stay clear of the rising bandwidth line; a label below flips left near the right edge. In decode the
 * weights sit right of attention, in prefill above it, so the two labels go on opposite sides. */
function Point({ x, y, color, label, below }: { x: number; y: number; color: string; label: string; below?: boolean }) {
  const cx = xOf(Math.min(Math.max(x, 10 ** X_MIN), 10 ** X_MAX))
  const cy = yOf(Math.max(y, 10 ** Y_MIN * 1e12))
  const left = !below || cx > W - 130
  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill={color} stroke="var(--surface)" strokeWidth={2} />
      <text x={cx + (left ? -10 : 10)} y={cy + (below ? 18 : -10)} textAnchor={left ? 'end' : 'start'} fontSize={12} fontWeight={600} fill={color}>
        {label}
      </text>
    </g>
  )
}
