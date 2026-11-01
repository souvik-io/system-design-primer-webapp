import { useState } from 'react'
import { RefreshCw, SkipForward } from 'lucide-react'
import { Button, Narration, Segmented, Stat, WidgetFrame } from './ui'

// Summing one value per lane across a warp with shuffles (content/infra/cuda-basics.md), as warp_sum in
// cuda_rmsnorm.py does. __shfl_xor_sync(mask, v, offset) gives each lane the value held by lane (lane XOR offset);
// __shfl_down_sync(mask, v, offset) gives lane i the value of lane i + offset. Five steps with offsets
// 16, 8, 4, 2, 1 sum 32 values: with XOR every lane ends with the total, with "down" only lane 0 does.
// Semantics from the CUDA programming guide's warp shuffle functions.

type Mode = 'xor' | 'down'
const OFFSETS = [16, 8, 4, 2, 1]

function initial(seed: number) {
  let a = seed * 9301 + 49297
  return Array.from({ length: 32 }, () => {
    a = (a * 9301 + 49297) % 233280
    return 1 + Math.floor((a / 233280) * 9)
  })
}

function run(values: number[], mode: Mode, steps: number) {
  let v = values.slice()
  for (let s = 0; s < steps; s++) {
    const off = OFFSETS[s]
    v = v.map((x, i) => {
      const src = mode === 'xor' ? i ^ off : i + off
      return src < 32 ? x + v[src] : 2 * x // shfl_down past lane 31 returns the lane's own value, so v += doubles it
    })
  }
  return v
}

export default function WarpReduce() {
  const [mode, setMode] = useState<Mode>('xor')
  const [step, setStep] = useState(0)
  const [seed, setSeed] = useState(1)

  const start = initial(seed)
  const total = start.reduce((a, b) => a + b, 0)
  const before = run(start, mode, step)
  const after = step < 5 ? run(start, mode, step + 1) : before
  const off = OFFSETS[Math.min(step, 4)]

  const W = 640
  const lane = W / 32
  const H = 190
  const yTop = 34
  const yBot = 150
  const correct = after.filter((x) => x === total).length

  return (
    <WidgetFrame
      title="Try it: summing a warp with shuffles"
      description="Each of the 32 lanes of a warp holds one number. A shuffle lets every lane read a register of another lane in the same warp, without shared memory. Step through the five shuffles that add all 32 numbers."
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Segmented
          label="Shuffle"
          value={mode}
          options={[
            { value: 'xor', label: '__shfl_xor_sync (butterfly)' },
            { value: 'down', label: '__shfl_down_sync' },
          ]}
          onChange={(m) => (setMode(m), setStep(0))}
        />
        <Button onClick={() => setStep((s) => (s >= 5 ? 0 : s + 1))} tone="primary">
          <SkipForward size={14} aria-hidden />{' '}
          {step >= 5 ? 'Start again' : step === 4 ? 'Show the result' : `Next step: offset ${OFFSETS[step + 1]}`}
        </Button>
        <Button onClick={() => (setSeed((s) => s + 1), setStep(0))}>
          <RefreshCw size={14} aria-hidden /> New values
        </Button>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Step ${step} of 5; ${correct} lanes hold the total ${total}`}>
        <text x={0} y={14} fontSize={11.5} fill="var(--ink-2)">
          {step >= 5
            ? 'After five steps'
            : `Before step ${step + 1}: each lane adds the value of lane ${mode === 'xor' ? `(its index XOR ${off})` : `(its index + ${off})`}`}
        </text>
        {step < 5 &&
          before.map((_, i) => {
            const src = mode === 'xor' ? i ^ off : i + off
            if (src >= 32) return null
            return (
              <line
                key={i}
                x1={src * lane + lane / 2}
                y1={yTop + 22}
                x2={i * lane + lane / 2}
                y2={yBot - 2}
                stroke="var(--w3)"
                strokeOpacity={0.6}
                strokeWidth={1}
              />
            )
          })}
        {before.map((x, i) => (
          <g key={`t${i}`}>
            <rect x={i * lane + 1} y={yTop} width={lane - 2} height={22} rx={3} fill="var(--accent-soft)" stroke="var(--w1)" strokeWidth={0.6} />
            <text x={i * lane + lane / 2} y={yTop + 15} textAnchor="middle" fontSize={x >= 100 ? 8 : 10} fill="var(--ink)">
              {x}
            </text>
          </g>
        ))}
        {after.map((x, i) => (
          <g key={`b${i}`}>
            <rect
              x={i * lane + 1}
              y={yBot}
              width={lane - 2}
              height={22}
              rx={3}
              fill={x === total ? 'var(--done-soft)' : 'var(--paper)'}
              stroke={x === total ? 'var(--done)' : 'var(--rule)'}
              strokeWidth={0.8}
            />
            <text x={i * lane + lane / 2} y={yBot + 15} textAnchor="middle" fontSize={x >= 100 ? 8 : 10} fill="var(--ink)">
              {x}
            </text>
          </g>
        ))}
        <text x={0} y={H - 4} fontSize={11} fill="var(--muted)">
          lanes 0 to 31; green lanes hold the full sum
        </text>
      </svg>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Step shown" value={`${Math.min(step + 1, 5)} of 5`} />
        <Stat label="Sum of all 32 values" value={total} />
        <Stat label="Lanes holding the sum" value={correct} tone={correct === 32 ? 'good' : undefined} />
      </div>

      <Narration tone={step >= 4 ? 'good' : undefined}>
        {step >= 4
          ? mode === 'xor'
            ? 'After five XOR shuffles every lane holds the sum, so every thread can use it at once, as RMSNorm does when it scales its own values. Five steps cover 32 lanes because 2 to the power 5 is 32.'
            : 'After five shuffles down, lane 0 holds the sum. The other lanes hold partial sums, or values that were doubled because their source lane was past lane 31 and the shuffle returned their own value; the kernel ignores them. That is enough when one thread writes the result, and the kernel then shares it through shared memory or another shuffle.'
          : `Each step halves the distance between lanes that exchange values, so after step ${step + 1} ${mode === 'xor' ? 'every lane' : `lanes 0 to ${(32 >> (step + 1)) - 1}`} ${mode === 'xor' ? 'holds' : 'each hold'} a sum of ${2 ** (step + 1)} of the original values.${mode === 'down' ? ' A lane whose source would be past lane 31 gets its own value back, so its value doubles and is never used.' : ''} The exchange happens between registers and needs no shared memory or __syncthreads.`}
      </Narration>
    </WidgetFrame>
  )
}
