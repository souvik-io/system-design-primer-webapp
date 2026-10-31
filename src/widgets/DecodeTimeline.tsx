import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, IndexSlider, Key, Narration, Stat, WidgetFrame } from './ui'
import trace from './data/decode-trace.json'

// A real profiler trace of one decode step of Llama 3.2 1B (BF16, batch 1) on a Modal H100, recorded by
// public/labs/infra/gpu/profile_decode.py with torch.profiler (content/infra/profiling.md). Each GPU kernel is
// [start µs, duration µs, category, name]; each CPU launch call is [start µs, duration µs]. Times are measured
// under the profiler, which slows the CPU side, so gaps are wider than in the unprofiled step (step_ms).

type Kernel = [number, number, string, string]
const KERNELS = trace.kernels as Kernel[]
const LAUNCHES = trace.launches as [number, number][]
const COLORS: Record<string, string> = {
  'matmul (cuBLAS nvjet)': 'var(--w1)',
  attention: 'var(--w3)',
  'element-wise': 'var(--w4)',
  reduction: 'var(--w2)',
  concatenate: 'var(--w5)',
  other: 'var(--w6)',
}
const END = Math.max(...KERNELS.map(([t, d]) => t + d))
const ZOOMS = [END, 20000, 5000, 1000, 300]
const ANSWERS = [
  {
    id: 'compute',
    label: 'The GPU is short of compute',
    right: false,
    why: "The GPU is idle most of the time, so it is not running out of arithmetic. Even the matmuls do little arithmetic, because each weight is multiplied by a single token's activations.",
  },
  {
    id: 'memory',
    label: 'The GPU is short of memory bandwidth',
    right: false,
    why: 'Bandwidth limits the matmuls while they run, but they occupy only a small part of the step. Most of the time the GPU has nothing to run at all.',
  },
  {
    id: 'cpu',
    label: 'The CPU cannot launch kernels fast enough',
    right: true,
    why: 'Right. Hundreds of kernels that each run for one or two microseconds, separated in this profiled trace by gaps of about ten microseconds, mean that the GPU finishes each kernel and then waits for the CPU to launch the next one. CUDA graphs and torch.compile, in Part 3, remove most of this overhead.',
  },
]

export default function DecodeTimeline() {
  const [zoom, setZoom] = useState(0)
  const [pos, setPos] = useState(0) // window start in µs
  const [picked, setPicked] = useState<number | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)

  const width = ZOOMS[zoom]
  const maxStart = Math.max(0, END - width)
  const start = Math.min(maxStart, pos)
  const posStep = Math.max(1, Math.round(width / 2))
  const end = start + width
  const visible = useMemo(() => KERNELS.map((k, i) => [k, i] as const).filter(([[t, d]]) => t + d >= start && t <= end), [start, end])
  const busy = visible.reduce((s, [[t, d]]) => s + Math.min(t + d, end) - Math.max(t, start), 0)
  const totals = useMemo(() => {
    const m = new Map<string, number>()
    for (const [, d, c] of KERNELS) m.set(c, (m.get(c) ?? 0) + d)
    return m
  }, [])
  const allBusy = [...totals.values()].reduce((a, b) => a + b, 0)

  const W = 640
  const L = 54
  const x = (t: number) => L + ((t - start) / width) * (W - L - 8)
  const pk = picked !== null ? KERNELS[picked] : null
  // Step through kernels in time order, moving the window so the chosen kernel stays in view.
  const pick = (i: number) => {
    const k = Math.max(0, Math.min(KERNELS.length - 1, i))
    setPicked(k)
    const [t, d] = KERNELS[k]
    if (zoom > 0 && (t < start || t + d > end)) setPos(Math.max(0, Math.min(maxStart, t - width / 4)))
  }
  const firstVisible = visible.length ? visible[0][1] : 0

  return (
    <WidgetFrame
      title="Try it: read a real decode-step timeline"
      description={`One decode step of Llama 3.2 1B at batch 1 on an H100, recorded with the PyTorch profiler: ${KERNELS.length} GPU kernels and ${LAUNCHES.length} CPU launch calls. Zoom in, click a kernel to see what it is, then decide what limits the step.`}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <IndexSlider
          label="Zoom"
          index={zoom}
          max={ZOOMS.length - 1}
          onChange={(i) => (setZoom(i), setPicked(null))}
          text={width >= 1000 ? `${(width / 1000).toFixed(width >= 10000 ? 0 : 1)} ms window` : `${width} µs window`}
        />
        <label className="flex items-center gap-3 text-[0.8125rem] text-muted">
          Position
          <input
            type="range"
            min={0}
            max={maxStart}
            step={posStep}
            value={start}
            disabled={zoom === 0}
            onChange={(e) => (setPos(Number(e.target.value)), setPicked(null))}
            className="w-40 accent-[var(--accent)]"
            aria-label="Window position"
          />
        </label>
      </div>

      <svg
        viewBox={`0 0 ${W} 130`}
        className="h-auto w-full"
        role="img"
        aria-label={`Timeline from ${Math.round(start)} to ${Math.round(end)} microseconds`}
      >
        <text x={0} y={36} fontSize={11} fill="var(--muted)">
          CPU
        </text>
        <text x={0} y={86} fontSize={11} fill="var(--muted)">
          GPU
        </text>
        <line x1={L} x2={W - 8} y1={104} y2={104} stroke="var(--rule)" />
        {LAUNCHES.filter(([t, d]) => t + d >= start && t <= end).map(([t, d], i) => (
          <rect key={`l${i}`} x={x(t)} y={24} width={Math.max(0.6, (d / width) * (W - L - 8))} height={18} fill="var(--muted)" opacity={0.55} />
        ))}
        {visible.map(([[t, d, c], i]) => (
          <rect
            key={`k${i}`}
            x={x(t)}
            y={70}
            width={Math.max(0.8, (d / width) * (W - L - 8))}
            height={24}
            fill={COLORS[c] ?? 'var(--w6)'}
            stroke={picked === i ? 'var(--ink)' : 'none'}
            strokeWidth={1.5}
            className="cursor-pointer"
            onClick={() => setPicked(i)}
          />
        ))}
        {/* Thin kernels get a wider transparent target so they can be clicked. */}
        {visible.map(([[t, d], i]) =>
          (d / width) * (W - L - 8) < 6 ? (
            <rect
              key={`h${i}`}
              x={x(t + d / 2) - 3}
              y={66}
              width={6}
              height={32}
              fill="transparent"
              className="cursor-pointer"
              onClick={() => setPicked(i)}
            />
          ) : null,
        )}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text key={f} x={L + f * (W - L - 8)} y={120} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} fontSize={10} fill="var(--muted)">
            {width >= 2000 ? `${((start + f * width) / 1000).toFixed(1)} ms` : `${Math.round(start + f * width)} µs`}
          </text>
        ))}
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        {Object.entries(COLORS).map(([c, color]) => (
          <Key key={c} color={color}>
            {c}
          </Key>
        ))}
        <Key color="var(--muted)">CPU launch call</Key>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Kernels in this window" value={visible.length} />
        <Stat label="GPU busy in this window" value={`${Math.round((busy / width) * 100)}%`} tone={busy / width < 0.3 ? 'bad' : undefined} />
        <Stat label="GPU work in the whole step" value={`${(allBusy / 1000).toFixed(2)} ms`} />
        <Stat label="Step without the profiler" value={`${trace.step_ms.toFixed(2)} ms`} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => pick(picked === null ? firstVisible : picked - 1)}>
          <ChevronLeft size={14} aria-hidden /> Previous kernel
        </Button>
        <Button onClick={() => pick(picked === null ? firstVisible : picked + 1)}>
          Next kernel <ChevronRight size={14} aria-hidden />
        </Button>
        <span className="text-[0.75rem] text-muted">or click a kernel in the timeline</span>
      </div>
      <p aria-live="polite" className="min-h-[2.25rem] rounded-md bg-paper px-3 py-2 text-[0.8rem] text-ink-2">
        {pk ? (
          <>
            Kernel {picked! + 1} of {KERNELS.length}: <span className="font-semibold text-ink">{pk[2]}</span>, {pk[1].toFixed(1)} µs, starting at{' '}
            {pk[0].toFixed(1)} µs: <code className="text-[0.75rem]">{pk[3].length >= 70 ? `${pk[3]}…` : pk[3]}</code>
          </>
        ) : (
          'No kernel selected yet.'
        )}
      </p>

      <div className="space-y-2">
        <p className="text-[0.85rem] text-ink">What limits this decode step?</p>
        <div className="flex flex-wrap gap-2">
          {ANSWERS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setAnswer(a.id)}
              aria-pressed={answer === a.id}
              className={`rounded-md border px-2.5 py-1.5 text-[0.8125rem] ${answer === a.id ? (a.right ? 'border-done bg-done-soft text-ink' : 'border-bad bg-bad-soft text-ink') : 'border-rule text-ink hover:border-muted'}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <Narration tone={answer ? (ANSWERS.find((a) => a.id === answer)!.right ? 'good' : 'bad') : undefined}>
        {answer
          ? ANSWERS.find((a) => a.id === answer)!.why
          : `The kernels add up to ${(allBusy / 1000).toFixed(2)} ms of GPU work: ${((totals.get('matmul (cuBLAS nvjet)') ?? 0) / 1000).toFixed(2)} ms in the cuBLAS matmul kernels, ${((totals.get('element-wise') ?? 0) / 1000).toFixed(2)} ms of ${KERNELS.filter((k) => k[2] === 'element-wise').length} small element-wise kernels, and the rest in attention, reductions and cache copies. Zoom in to a 300 µs window to see the gaps between kernels.`}
      </Narration>
    </WidgetFrame>
  )
}
