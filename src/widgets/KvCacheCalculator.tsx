import { useState, type ReactNode } from 'react'
import { Narration, Segmented, Stat, WidgetFrame } from './ui'

// How much GPU memory a model's weights and KV cache need, and how many requests fit at once.
// Model shapes are from the Llama 3 paper (arXiv 2407.21783, table 3); GPU figures are from NVIDIA's
// spec pages (dense BF16 TFLOPS, without sparsity). Decimal units throughout: 1 GB = 10^9 bytes.

type ModelId = '8b' | '70b' | '405b'
type GpuId = 'a100' | 'h100' | 'h200'

const MODELS: Record<ModelId, { name: string; params: number; layers: number; kvHeads: number; headDim: number }> = {
  '8b': { name: 'Llama 3.1 8B', params: 8e9, layers: 32, kvHeads: 8, headDim: 128 },
  '70b': { name: 'Llama 3.1 70B', params: 70e9, layers: 80, kvHeads: 8, headDim: 128 },
  '405b': { name: 'Llama 3.1 405B', params: 405e9, layers: 126, kvHeads: 8, headDim: 128 },
}

const GPUS: Record<GpuId, { name: string; memory: number; bandwidth: number; tflops: number }> = {
  a100: { name: 'A100 80 GB', memory: 80e9, bandwidth: 2.039e12, tflops: 312 },
  h100: { name: 'H100 80 GB', memory: 80e9, bandwidth: 3.35e12, tflops: 989 },
  h200: { name: 'H200 141 GB', memory: 141e9, bandwidth: 4.8e12, tflops: 989 },
}

const CONTEXTS = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072]
/** Engines leave this share of GPU memory for activations and their own bookkeeping. */
const RESERVE = 0.1

const gb = (bytes: number) => (bytes >= 100e9 ? Math.round(bytes / 1e9).toLocaleString() : (bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)) + ' GB'
const tokensLabel = (n: number) => (n >= 1024 ? `${n / 1024}K` : String(n))

export default function KvCacheCalculator() {
  const [modelId, setModelId] = useState<ModelId>('70b')
  const [weightBytes, setWeightBytes] = useState(2)
  const [kvBytes, setKvBytes] = useState(2)
  const [gpuId, setGpuId] = useState<GpuId>('h100')
  const [count, setCount] = useState(4)
  const [ctxIndex, setCtxIndex] = useState(2)

  const model = MODELS[modelId]
  const gpu = GPUS[gpuId]
  const context = CONTEXTS[ctxIndex]

  const total = gpu.memory * count
  const reserve = total * RESERVE
  const weights = model.params * weightBytes
  const kvFree = total - reserve - weights
  const fits = kvFree > 0
  const perToken = 2 * model.layers * model.kvHeads * model.headDim * kvBytes
  const perRequest = perToken * context
  const requests = fits ? Math.floor(kvFree / perRequest) : 0
  const kvUsed = requests * perRequest

  // Each decode step reads every weight once, plus the KV cache of every request in the batch. The
  // step can't be faster than that read, or than the arithmetic (2 FLOPs per parameter per token).
  const bandwidth = gpu.bandwidth * count
  const flops = gpu.tflops * 1e12 * count
  const stepAlone = Math.max(weights / bandwidth, (2 * model.params) / flops)
  const stepFull = Math.max((weights + kvUsed) / bandwidth, (2 * model.params * requests) / flops)

  const pctOf = (bytes: number) => `${Math.max(0, Math.min(100, (bytes / total) * 100))}%`

  let note: string
  if (!fits) {
    note = `${model.name}'s weights take ${gb(weights)} at this precision, but ${count} × ${gpu.name} ${count === 1 ? 'has' : 'have'} only ${gb(total - reserve)} to spare after keeping ${RESERVE * 100}% free. Add GPUs, pick a bigger GPU or a smaller number format.`
  } else if (requests === 0) {
    note = `The weights fit, leaving ${gb(kvFree)} for the KV cache. One request of ${context.toLocaleString()} tokens needs ${gb(perRequest)}, so not even one fits. Shorten the context or add memory.`
  } else {
    note =
      `${model.name} takes ${gb(weights)} for its weights. ${count} × ${gpu.name} ${count === 1 ? 'has' : 'have'} ${gb(total)}; after keeping ${RESERVE * 100}% free, ${gb(kvFree)} is left for the KV cache. ` +
      `At ${(perToken / 1024).toLocaleString()} KiB a token, a ${context.toLocaleString()}-token request needs ${gb(perRequest)}, so ${requests.toLocaleString()} ${requests === 1 ? 'request fits' : 'requests fit'} at once.`
  }

  return (
    <WidgetFrame
      title="Try it: how many requests fit on the GPUs"
      description="Pick a model, its number formats, the GPUs and how long each request's context is. The bar shows where the memory goes. Speeds are upper limits set by memory bandwidth and peak arithmetic; real engines are slower."
    >
      <div className="space-y-2.5">
        <Segmented
          label="Model"
          value={modelId}
          options={(Object.keys(MODELS) as ModelId[]).map((id) => ({ value: id, label: MODELS[id].name.replace('Llama 3.1 ', '') }))}
          onChange={setModelId}
        />
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <Segmented
            label="Weights"
            value={weightBytes}
            options={[
              { value: 2, label: 'BF16' },
              { value: 1, label: 'FP8' },
              { value: 0.5, label: 'INT4' },
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
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <Segmented
            label="GPU"
            value={gpuId}
            options={(Object.keys(GPUS) as GpuId[]).map((id) => ({ value: id, label: GPUS[id].name }))}
            onChange={setGpuId}
          />
          <Segmented label="How many" value={count} options={[1, 2, 4, 8].map((n) => ({ value: n, label: String(n) }))} onChange={setCount} />
        </div>
        <label className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-muted">
          Context per request
          <input
            type="range"
            min={0}
            max={CONTEXTS.length - 1}
            step={1}
            value={ctxIndex}
            onChange={(e) => setCtxIndex(Number(e.target.value))}
            className="w-40 accent-[var(--accent)]"
            aria-valuetext={`${context.toLocaleString()} tokens`}
          />
          <span className="text-ink tabular-nums">{context.toLocaleString()} tokens</span>
        </label>
      </div>

      <div>
        <div
          className="flex h-7 w-full overflow-hidden rounded-md border border-rule bg-paper"
          role="img"
          aria-label={`Of ${gb(total)}: weights ${gb(weights)}, kept free ${gb(reserve)}, KV cache in use ${gb(kvUsed)}`}
        >
          <div className="h-full shrink-0" style={{ width: pctOf(weights), background: fits ? 'var(--w1)' : 'var(--bad)' }} />
          {fits && (
            <>
              <div className="h-full shrink-0" style={{ width: pctOf(kvUsed), background: 'var(--w3)' }} />
              <div className="h-full shrink-0" style={{ width: pctOf(kvFree - kvUsed), background: 'var(--w3)', opacity: 0.25 }} />
            </>
          )}
          <div className="ml-auto h-full shrink-0 bg-rule" style={{ width: pctOf(reserve) }} />
        </div>
        <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
          <Key color={fits ? 'var(--w1)' : 'var(--bad)'}>weights {gb(weights)}</Key>
          {fits && <Key color="var(--w3)">KV cache for {requests.toLocaleString()} requests</Key>}
          <Key color="var(--rule)">kept free {gb(reserve)}</Key>
          <span>
            of {gb(total)} on {count} {count === 1 ? 'GPU' : 'GPUs'}
          </span>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="KV cache per token" value={`${(perToken / 1024).toLocaleString()} KiB`} />
        <Stat label={`Per ${tokensLabel(context)}-token request`} value={gb(perRequest)} />
        <Stat label="Requests at once" value={requests.toLocaleString()} tone={!fits || requests === 0 ? 'bad' : requests < 8 ? 'warn' : 'good'} />
        <Stat label="Left for the KV cache" value={fits ? gb(kvFree) : 'none'} tone={fits ? undefined : 'bad'} />
        <Stat label="Speed for one request alone" value={fits ? `${Math.round(1 / stepAlone).toLocaleString()} tokens/s` : '–'} />
        <Stat label="Total speed, all slots full" value={fits && requests ? `${Math.round(requests / stepFull).toLocaleString()} tokens/s` : '–'} />
      </div>

      <Narration tone={!fits || requests === 0 ? 'bad' : undefined}>{note}</Narration>
    </WidgetFrame>
  )
}

function Key({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-sm" style={{ background: color }} />
      {children}
    </span>
  )
}
