import { useState } from 'react'
import { IndexSlider, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// A stream of small kernels launched one by one from Python, or replayed from a CUDA graph
// (content/infra/pytorch-execution.md). Eager: the CPU spends `launch` µs issuing each kernel, and the GPU starts
// kernel i when both its launch has finished and kernel i - 1 is done. Graph: the CPU makes one launch call and the
// GPU runs the recorded kernels back to back, with a small gap between them. Defaults come from decode_runtime.py
// on an H100: 5.2 µs per kernel launched from Python, 1.1 µs of GPU work per kernel, and 1.2 µs per kernel when the
// same 200 kernels are replayed as a graph (238 µs in all, so about 0.065 µs between kernels). Replaying a graph is
// charged as one launch call of the same cost.

const COUNTS = [20, 50, 100, 200]
const LAUNCH = [2, 3, 5.2, 7.4, 10, 20]
const WORK = [1.1, 2, 5, 10, 20]
const GRAPH_GAP = 0.065

type Mode = 'eager' | 'graph'

function simulate(n: number, launch: number, work: number, mode: Mode) {
  const cpu: [number, number][] = []
  const gpu: [number, number][] = []
  if (mode === 'eager') {
    let end = 0
    for (let i = 0; i < n; i++) {
      const issued = (i + 1) * launch
      cpu.push([i * launch, launch])
      const start = i === 0 ? issued : Math.max(issued, end + GRAPH_GAP)
      gpu.push([start, work])
      end = start + work
    }
    return { cpu, gpu, total: end }
  }
  cpu.push([0, launch])
  for (let i = 0; i < n; i++) gpu.push([launch + i * (work + GRAPH_GAP), work])
  return { cpu, gpu, total: launch + n * (work + GRAPH_GAP) - GRAPH_GAP }
}

export default function LaunchOverhead() {
  const [count, setCount] = useState(3)
  const [launchI, setLaunchI] = useState(2)
  const [workI, setWorkI] = useState(0)
  const [mode, setMode] = useState<Mode>('eager')

  const n = COUNTS[count]
  const launch = LAUNCH[launchI]
  const work = WORK[workI]
  const run = simulate(n, launch, work, mode)
  const eager = simulate(n, launch, work, 'eager').total
  const graph = simulate(n, launch, work, 'graph').total
  const busy = n * work
  const launchBound = launch > work

  const W = 640
  const L = 44
  const span = Math.max(eager, graph) // one scale for both modes, so switching shows the difference
  const x = (t: number) => L + (t / span) * (W - L - 8)
  const w = (d: number) => Math.max(0.7, (d / span) * (W - L - 8))

  return (
    <WidgetFrame
      title="Try it: launching kernels one by one or as a graph"
      description="Each small kernel costs the CPU a few microseconds to launch from Python. When that is longer than the kernel itself, the GPU waits between kernels. A CUDA graph launches the whole recorded sequence with one call."
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
        <Segmented
          label="Launch"
          value={mode}
          options={[
            { value: 'eager', label: 'One by one (eager)' },
            { value: 'graph', label: 'Replay a CUDA graph' },
          ]}
          onChange={setMode}
        />
        <IndexSlider label="Kernels" index={count} max={COUNTS.length - 1} onChange={setCount} text={String(n)} />
        <IndexSlider label="CPU time per launch" index={launchI} max={LAUNCH.length - 1} onChange={setLaunchI} text={`${launch} µs`} />
        <IndexSlider label="GPU time per kernel" index={workI} max={WORK.length - 1} onChange={setWorkI} text={`${work} µs`} />
      </div>

      <svg viewBox={`0 0 ${W} 120`} className="h-auto w-full" role="img" aria-label={`${n} kernels take ${Math.round(run.total)} microseconds`}>
        <text x={0} y={34} fontSize={11} fill="var(--muted)">
          CPU
        </text>
        <text x={0} y={80} fontSize={11} fill="var(--muted)">
          GPU
        </text>
        <rect x={L} y={66} width={x(run.total) - L} height={22} fill="var(--bad-soft)" />
        {run.cpu.map(([t, d], i) => (
          <rect key={`c${i}`} x={x(t)} y={22} width={w(d) - (mode === 'eager' && w(d) > 2 ? 0.6 : 0)} height={18} fill="var(--muted)" />
        ))}
        {run.gpu.map(([t, d], i) => (
          <rect key={`g${i}`} x={x(t)} y={66} width={w(d)} height={22} fill="var(--w1)" />
        ))}
        <line x1={x(run.total)} x2={x(run.total)} y1={14} y2={96} stroke="var(--ink)" strokeDasharray="3 3" />
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={L + f * (W - L - 8)} y={112} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} fontSize={10} fill="var(--muted)">
            {Math.round(f * span)} µs
          </text>
        ))}
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="var(--muted)">CPU launch call</Key>
        <Key color="var(--w1)">GPU kernel</Key>
        <Key color="var(--bad-soft)">GPU idle</Key>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Time for all kernels" value={`${Math.round(run.total)} µs`} />
        <Stat label="GPU busy" value={`${Math.round((busy / run.total) * 100)}%`} tone={busy / run.total < 0.5 ? 'bad' : 'good'} />
        <Stat label="Per kernel" value={`${(run.total / n).toFixed(1)} µs`} />
        <Stat label="Graph speed-up" value={`${(eager / graph).toFixed(1)}×`} tone={eager / graph > 1.5 ? 'good' : undefined} />
      </div>

      <Narration tone={mode === 'graph' ? 'good' : launchBound ? 'bad' : undefined}>
        {mode === 'graph'
          ? `One launch call replays all ${n} kernels, so the GPU runs them back to back and the CPU is free after one launch call. ${eager / graph < 1.05 ? 'Here the GPU work was already the limit, so the graph gains almost nothing over launching them one by one.' : `Against launching them one by one, this is ${(eager / graph).toFixed(1)} times faster.`}`
          : launchBound
            ? `Each launch takes ${launch} µs of CPU time but each kernel only ${work} µs of GPU time, so the GPU finishes every kernel and waits for the next. The CPU sets the pace: this is a launch-bound workload, like a batch-1 decode step.`
            : `Each kernel runs for ${work} µs, at least as long as the ${launch} µs the CPU needs to launch the next one, so launches stay ahead of the GPU and it is busy almost all the time. ${eager / graph < 1.05 ? 'A CUDA graph would gain almost nothing here.' : `A CUDA graph would gain only ${Math.round((eager / graph - 1) * 100)}% here.`}`}
      </Narration>
    </WidgetFrame>
  )
}
