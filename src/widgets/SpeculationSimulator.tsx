import { useState } from 'react'
import { IndexSlider, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'
import { bestK, breakEven, pass, samplePasses, type Gpu } from './specDecodeSim'

// Speculative decoding as a trade (content/infra/speculative-decoding.md). A target pass verifies k draft tokens
// per request and emits the accepted ones plus one of its own, so it emits more tokens but also holds k + 1 tokens
// per request where a plain decode step holds one. The GPU presets are straight-line fits to the step times
// public/labs/infra/gpu/spec_decode_bench.py measured for Llama 3.1 8B; see GPUS and DRAFTERS below.

// Step time of Llama 3.1 8B without speculation: 6.41, 6.58, 6.95 and 8.68 ms at 1, 8, 32 and 128 requests on the
// H100, and 34.2 and 36.1 ms at 1 and 16 on the A10 (so the A10 line is an extrapolation beyond 16).
const GPUS: Gpu[] = [
  { name: 'H100', fixed: 6.4, perToken: 0.018 },
  { name: 'A10', fixed: 34.1, perToken: 0.127 },
]
// Milliseconds per drafter step, [H100, A10], worked out from the measured cost of a round. The EAGLE-3 head is one
// transformer layer and is limited by memory bandwidth like the target, so it is about 6% of a target pass on both.
// The 1B draft model's step is 4.9 ms on the H100 and 6.9 ms on the A10: 75% of a target pass on one, 20% on the other.
const DRAFTERS: { name: string; ms: [number, number] }[] = [
  { name: 'Lookup (free)', ms: [0, 0] },
  { name: 'EAGLE-3 head', ms: [0.45, 2.1] },
  { name: '1B draft model', ms: [4.9, 6.9] },
]
const ALPHAS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]
const BATCHES = [1, 2, 4, 8, 16, 32, 64, 128, 256]
const MAX_K = 8
const PASSES = 12

export default function SpeculationSimulator() {
  const [gpuI, setGpuI] = useState(0)
  const [drafterI, setDrafterI] = useState(1)
  const [alphaI, setAlphaI] = useState(6)
  const [k, setK] = useState(3)
  const [batchI, setBatchI] = useState(0)

  const gpu = GPUS[gpuI]
  const drafter = DRAFTERS[drafterI]
  const draftMs = drafter.ms[gpuI]
  const alpha = ALPHAS[alphaI]
  const batch = BATCHES[batchI]
  const now = pass(gpu, batch, alpha, k, draftMs)
  const curve = BATCHES.map((b) => pass(gpu, b, alpha, k, draftMs).speedup)
  const edge = breakEven(gpu, BATCHES, alpha, k, draftMs)
  const best = bestK(gpu, batch, alpha, draftMs, MAX_K)
  const bestSpeed = pass(gpu, batch, alpha, best, draftMs).speedup
  // Suggest another draft length only when it is visibly better at the precision the widget prints.
  const betterK = best !== k && bestSpeed.toFixed(2) !== now.speedup.toFixed(2)
  const bestText = `${best} draft token${best === 1 ? '' : 's'}`
  const passes = samplePasses(alpha, k, PASSES)
  const cost = (now.verify + now.draft) / now.plain

  // Left: a dozen passes, one row each. Right: speed-up against batch size.
  const W = 640
  const H = 236
  const cell = 15
  const stripX = 34
  const chartX = 300
  const chartW = W - chartX - 12
  const top = 22
  const bottom = H - 34
  const yMax = Math.max(2, Math.ceil(Math.max(...curve, 1) + 0.2))
  const x = (i: number) => chartX + (i / (BATCHES.length - 1)) * chartW
  const y = (s: number) => bottom - (Math.min(s, yMax) / yMax) * (bottom - top)
  const path = curve.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s).toFixed(1)}`).join(' ')

  return (
    <WidgetFrame
      title="Try it: when speculation pays"
      description="A drafter proposes k tokens per request, and one pass of the target model checks them all. The pass emits more tokens, but it also carries k + 1 tokens per request, and the drafter takes time. Change the acceptance rate, the draft length, the drafter and the batch size, and watch the speed-up."
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
        <Segmented label="GPU" value={gpuI} options={GPUS.map((g, i) => ({ value: i, label: g.name }))} onChange={setGpuI} />
        <Segmented label="Drafter" value={drafterI} options={DRAFTERS.map((d, i) => ({ value: i, label: d.name }))} onChange={setDrafterI} />
        <IndexSlider label="Acceptance rate" index={alphaI} max={ALPHAS.length - 1} onChange={setAlphaI} text={alpha.toFixed(2)} />
        <IndexSlider label="Draft tokens k" index={k - 1} max={MAX_K - 1} onChange={(i) => setK(i + 1)} text={String(k)} />
        <IndexSlider label="Batch size" index={batchI} max={BATCHES.length - 1} onChange={setBatchI} text={String(batch)} />
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Speculation is ${now.speedup.toFixed(2)} times the speed of plain decoding at batch size ${batch}`}
      >
        <text x={0} y={12} fontSize={11} fill="var(--muted)">
          {PASSES} passes of one request
        </text>
        {passes.map((accepted, row) => (
          <g key={row}>
            <text x={stripX - 8} y={top + row * (cell + 1.5) + 11} fontSize={9} textAnchor="end" fill="var(--muted)">
              {row + 1}
            </text>
            {Array.from({ length: k }, (_, i) => (
              <rect
                key={i}
                x={stripX + i * (cell + 2)}
                y={top + row * (cell + 1.5)}
                width={cell}
                height={cell - 2}
                rx={2}
                fill={i < accepted ? 'var(--w1)' : 'var(--bad-soft)'}
                stroke={i < accepted ? 'none' : 'var(--rule)'}
              />
            ))}
            <rect x={stripX + k * (cell + 2) + 6} y={top + row * (cell + 1.5)} width={cell} height={cell - 2} rx={2} fill="var(--w3)" />
            <text x={stripX + (MAX_K + 1) * (cell + 2) + 14} y={top + row * (cell + 1.5) + 11} fontSize={10} fill="var(--ink-2)">
              +{accepted + 1}
            </text>
          </g>
        ))}

        <text x={chartX} y={12} fontSize={11} fill="var(--muted)">
          Speed-up over plain decoding, by batch size
        </text>
        {Array.from({ length: yMax + 1 }, (_, s) => (
          <g key={s}>
            <line x1={chartX} x2={chartX + chartW} y1={y(s)} y2={y(s)} stroke="var(--rule)" strokeWidth={s === 1 ? 0 : 0.6} />
            <text x={chartX - 6} y={y(s) + 3} fontSize={10} textAnchor="end" fill="var(--muted)">
              {s}×
            </text>
          </g>
        ))}
        <rect x={chartX} y={y(1)} width={chartW} height={bottom - y(1)} fill="var(--bad-soft)" opacity={0.6} />
        <line x1={chartX} x2={chartX + chartW} y1={y(1)} y2={y(1)} stroke="var(--ink-2)" strokeDasharray="4 3" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2.2} />
        {curve.map((s, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(s)}
            r={i === batchI ? 5 : 2.5}
            fill={i === batchI ? 'var(--accent)' : 'var(--surface)'}
            stroke="var(--accent)"
            strokeWidth={1.5}
          />
        ))}
        {BATCHES.map((b, i) => (
          <text key={b} x={x(i)} y={bottom + 14} fontSize={10} textAnchor="middle" fill={i === batchI ? 'var(--ink)' : 'var(--muted)'}>
            {b}
          </text>
        ))}
        <text x={chartX + chartW / 2} y={H - 4} fontSize={10} textAnchor="middle" fill="var(--muted)">
          requests decoding together
        </text>
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="var(--w1)">Draft token accepted</Key>
        <Key color="var(--bad-soft)">Draft token computed and thrown away</Key>
        <Key color="var(--w3)">The target’s own token</Key>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Tokens per pass" value={now.tokens.toFixed(2)} />
        <Stat label="Cost of a pass" value={`${cost.toFixed(2)}× plain`} />
        <Stat label="Speed-up" value={`${now.speedup.toFixed(2)}×`} tone={now.speedup > 1.05 ? 'good' : now.speedup < 1 ? 'bad' : 'warn'} />
        <Stat label="Target work thrown away" value={`${Math.round(now.wasted * 100)}%`} tone={now.wasted > 0.5 ? 'warn' : undefined} />
      </div>

      <Narration tone={now.speedup < 1 ? 'bad' : now.speedup > 1.05 ? 'good' : undefined}>
        {now.speedup < 1
          ? `A pass now emits ${now.tokens.toFixed(2)} tokens per request but takes ${cost.toFixed(2)} times as long as a plain step, because it carries ${batch * (k + 1)} tokens where a plain step carries ${batch}${draftMs > 0 ? ' and the drafter runs first' : ''}. Speculation is slower here: ${Math.round(now.specRate).toLocaleString('en-US')} tokens a second against ${Math.round(now.plainRate).toLocaleString('en-US')}. ${edge > 0 ? `With these settings it stops paying above a batch of ${edge}.` : 'With these settings it does not pay at any batch size.'} ${bestSpeed > 1 ? `At this batch size ${bestText} would still gain, ${bestSpeed.toFixed(2)}×.` : 'No draft length pays at this batch size.'}`
          : `A pass emits ${now.tokens.toFixed(2)} tokens per request and takes ${cost.toFixed(2)} times as long as a plain step, so the server produces ${Math.round(now.specRate).toLocaleString('en-US')} tokens a second where plain decoding produces ${Math.round(now.plainRate).toLocaleString('en-US')}. ${betterK ? `At this batch size ${bestText} would do better, ${bestSpeed.toFixed(2)}×.` : 'No other draft length does better at this batch size.'} ${edge >= BATCHES[BATCHES.length - 1] ? '' : `Speculation stops paying above a batch of ${edge}.`}`}
      </Narration>
    </WidgetFrame>
  )
}
