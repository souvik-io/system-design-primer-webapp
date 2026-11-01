import { useState } from 'react'
import { Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// Why serving engines capture one CUDA graph per batch size, and pad a batch up to the next captured size
// (content/infra/pytorch-execution.md). A graph replays fixed shapes, so a decode batch of 13 sequences runs in the
// graph captured for 16, with 3 rows of wasted work, and a batch larger than the largest captured size runs eagerly.
// vLLM v0.32.0's default sizes (vllm/config/vllm.py, _set_cudagraph_sizes) are [1, 2, 4], then every 8 up to 248,
// then every 16 from 256 to max_cudagraph_capture_size, which is min(2 * max_num_seqs, 512) by default (1,024 on
// compute capability 10.x).

type Plan = 'vllm' | 'small' | 'pow2'

function sizes(plan: Plan) {
  if (plan === 'pow2') return [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]
  const max = plan === 'vllm' ? 512 : 64
  const list = [1, 2, 4]
  for (let s = 8; s < 256; s += 8) list.push(s)
  for (let s = 256; s <= max; s += 16) list.push(s)
  return list.filter((s) => s <= max)
}

const PLANS: { value: Plan; label: string; note: string }[] = [
  {
    value: 'vllm',
    label: 'vLLM default (up to 512)',
    note: 'This is vLLM’s default plan when max_num_seqs is 256 or more. On an H100 the default max_num_seqs is 1,024, so decode batches of 513 to 1,024 sequences run without a graph.',
  },
  {
    value: 'small',
    label: 'vLLM, max_cudagraph_capture_size = 64',
    note: 'With max_cudagraph_capture_size set to 64, vLLM captures 1, 2, 4 and every multiple of 8 up to 64, 11 graphs, and runs any larger decode batch without one.',
  },
  { value: 'pow2', label: 'Powers of two', note: 'Powers of two need few graphs but leave wide gaps between sizes.' },
]

export default function GraphPadding() {
  const [plan, setPlan] = useState<Plan>('vllm')
  const [batch, setBatch] = useState(13)
  const list = sizes(plan)
  const largest = list[list.length - 1]
  const padded = list.find((s) => s >= batch)
  // Average share of wasted rows over every batch size from 1 to the largest captured one.
  let waste = 0
  for (let b = 1; b <= largest; b++) {
    const p = list.find((s) => s >= b)!
    waste += (p - b) / p
  }
  waste /= largest

  const W = 640
  const L = 8
  const MAX = 600
  const x = (v: number) => L + (v / MAX) * (W - 2 * L)

  return (
    <WidgetFrame
      title="Try it: pad a batch to a captured graph"
      description="A CUDA graph replays fixed shapes, so an engine captures one graph per batch size before serving. Each decode batch runs in the graph for the next captured size up. Pick a capture plan and a batch size."
    >
      <Segmented label="Capture sizes" value={plan} options={PLANS.map(({ value, label }) => ({ value, label }))} onChange={setPlan} />
      <label className="flex flex-wrap items-center gap-3 text-[0.8125rem] text-muted">
        Sequences in this decode step
        <input
          type="range"
          min={1}
          max={MAX}
          value={batch}
          onChange={(e) => setBatch(Number(e.target.value))}
          className="w-56 accent-[var(--accent)]"
          aria-valuetext={`${batch} sequences`}
        />
        <span className="text-ink tabular-nums">{batch}</span>
      </label>

      <svg viewBox={`0 0 ${W} 74`} className="h-auto w-full" role="img" aria-label={`${list.length} captured sizes up to ${largest}`}>
        <rect x={x(0)} y={30} width={x(largest) - x(0)} height={14} fill="var(--accent-soft)" />
        <rect x={x(largest)} y={30} width={x(MAX) - x(largest)} height={14} fill="var(--bad-soft)" />
        {list.map((s) => (
          <line key={s} x1={x(s)} x2={x(s)} y1={26} y2={48} stroke="var(--accent)" strokeWidth={1} />
        ))}
        {padded && <rect x={x(batch)} y={30} width={Math.max(1.5, x(padded) - x(batch))} height={14} fill="var(--warn)" />}
        <line x1={x(batch)} x2={x(batch)} y1={14} y2={52} stroke="var(--ink)" strokeWidth={2} />
        <text x={Math.min(x(batch), W - 70)} y={11} fontSize={10.5} fill="var(--ink)">
          batch {batch}
        </text>
        {[0, 128, 256, 384, 512].map((v) => (
          <text key={v} x={x(v)} y={66} textAnchor="middle" fontSize={10} fill="var(--muted)">
            {v}
          </text>
        ))}
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="var(--accent-soft)">covered by a captured graph</Key>
        <Key color="var(--warn)">padded rows</Key>
        <Key color="var(--bad-soft)">runs eagerly</Key>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Graphs to capture" value={list.length} />
        <Stat label="This batch runs as" value={padded ? `graph for ${padded}` : 'eager'} tone={padded ? undefined : 'bad'} />
        <Stat
          label="Padded rows"
          value={padded ? `${padded - batch} (${Math.round(((padded - batch) / padded) * 100)}%)` : '—'}
          tone={padded && (padded - batch) / padded > 0.25 ? 'warn' : undefined}
        />
        <Stat label="Average padding, sizes 1 to max" value={`${(waste * 100).toFixed(1)}%`} />
      </div>

      <Narration tone={padded ? undefined : 'bad'}>
        {padded
          ? padded === batch
            ? `A graph was captured for exactly ${batch} sequences, so nothing is wasted.`
            : `No graph exists for ${batch} sequences, so the engine pads the batch with ${padded - batch} dummy rows and replays the graph for ${padded}. At decode, the step reads the same weights either way, so the extra rows cost little until the batch is large enough to be compute-bound.`
          : `${batch} is more than the largest captured size, ${largest}, so this step runs without a CUDA graph and pays the launch overhead again. ${PLANS.find((p) => p.value === plan)!.note}`}
      </Narration>
    </WidgetFrame>
  )
}
