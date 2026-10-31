import { useState } from 'react'
import { RefreshCw, SkipForward } from 'lucide-react'
import { Button, Narration, Segmented, Stat, WidgetFrame } from './ui'

// One query row of attention computed block by block, as FlashAttention does (content/infra/flash-attention.md).
// The row has 16 scores s_j and one value v_j per key (a one-number "vector" to keep it readable). After each
// block, the running max m, the running sum l of exp(s - m) and the running output acc = sum exp(s - m) * v are
// rescaled by alpha = exp(m_old - m_new), so the final acc / l equals softmax(s) . v exactly
// (Milakov and Gimelshein 2018; Dao et al. 2022). online_softmax.py checks the same algebra numerically.

const N = 16

function draw(seed: number) {
  let a = seed * 7 + 3
  const r = () => {
    a = (Math.imul(a, 1103515245) + 12345) & 0x7fffffff
    return a / 2147483648
  }
  return {
    s: Array.from({ length: N }, () => Math.round((r() * 8 - 3) * 10) / 10),
    v: Array.from({ length: N }, () => Math.round((r() * 4 - 2) * 10) / 10),
  }
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '−∞')

export default function OnlineSoftmax() {
  const [seed, setSeed] = useState(2)
  const [block, setBlock] = useState(4)
  const [step, setStep] = useState(0) // blocks processed

  const { s, v } = draw(seed)
  const blocks = N / block
  // Replay the online algorithm up to `step` blocks, keeping a history row per block.
  let m = -Infinity
  let l = 0
  let acc = 0
  const history: { m: number; alpha: number; l: number; acc: number }[] = []
  for (let b = 0; b < step; b++) {
    const ss = s.slice(b * block, (b + 1) * block)
    const vv = v.slice(b * block, (b + 1) * block)
    const mNew = Math.max(m, ...ss)
    const alpha = Math.exp(m - mNew)
    const p = ss.map((x) => Math.exp(x - mNew))
    l = l * alpha + p.reduce((x, y) => x + y, 0)
    acc = acc * alpha + p.reduce((x, y, i) => x + y * vv[i], 0)
    m = mNew
    history.push({ m, alpha, l, acc })
  }
  const max = Math.max(...s)
  const exactP = s.map((x) => Math.exp(x - max))
  const exact = exactP.reduce((x, y, i) => x + y * v[i], 0) / exactP.reduce((x, y) => x + y, 0)
  const done = step >= blocks
  const last = history[history.length - 1]

  // Score bars
  const W = 640
  const H = 150
  const col = W / N
  const zero = 90
  const scale = 12

  return (
    <WidgetFrame
      title="Try it: softmax one block at a time"
      description="One row of attention scores, processed in blocks as FlashAttention does. Each block may raise the running maximum; when it does, everything accumulated so far is rescaled by alpha. Step through the blocks and compare the result with the exact softmax."
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Segmented
          label="Block size"
          value={block}
          options={[2, 4, 8].map((b) => ({ value: b, label: String(b) }))}
          onChange={(b) => (setBlock(b), setStep(0))}
        />
        <Button tone="primary" onClick={() => setStep((x) => (x >= blocks ? 0 : x + 1))}>
          <SkipForward size={14} aria-hidden /> {done ? 'Start again' : `Process block ${step + 1} of ${blocks}`}
        </Button>
        <Button onClick={() => (setSeed((x) => x + 1), setStep(0))}>
          <RefreshCw size={14} aria-hidden /> New scores
        </Button>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${step} of ${blocks} blocks processed`}>
        <line x1={0} x2={W} y1={zero} y2={zero} stroke="var(--rule)" />
        {Array.from({ length: blocks }, (_, b) => (
          <rect
            key={b}
            x={b * block * col + 1}
            y={4}
            width={block * col - 2}
            height={H - 30}
            rx={4}
            fill={b === step ? 'var(--accent-soft)' : 'transparent'}
            stroke={b < step ? 'var(--done)' : 'var(--rule)'}
            strokeDasharray={b < step ? undefined : '3 3'}
          />
        ))}
        {s.map((x, j) => {
          const h = x * scale
          const seen = Math.floor(j / block) < step
          return (
            <g key={j}>
              <rect
                x={j * col + col * 0.25}
                y={h >= 0 ? zero - h : zero}
                width={col * 0.5}
                height={Math.abs(h)}
                fill={seen ? 'var(--w1)' : 'var(--muted)'}
                opacity={seen ? 1 : 0.45}
              />
              <text x={j * col + col / 2} y={H - 12} textAnchor="middle" fontSize={10} fill="var(--muted)">
                v={v[j]}
              </text>
            </g>
          )
        })}
        {Number.isFinite(m) && <line x1={0} x2={W} y1={zero - m * scale} y2={zero - m * scale} stroke="var(--bad)" strokeDasharray="5 4" />}
        {Number.isFinite(m) && (
          <text x={W - 4} y={zero - m * scale - 4} textAnchor="end" fontSize={11} fill="var(--bad)">
            running max m = {m.toFixed(1)}
          </text>
        )}
      </svg>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] border-collapse text-[0.8rem] tabular-nums">
          <thead>
            <tr className="text-left text-[0.75rem] text-muted">
              <th className="py-1 pr-2 font-medium">After block</th>
              <th className="py-1 pr-2 font-medium">max m</th>
              <th className="py-1 pr-2 font-medium">rescale alpha = exp(m_old − m_new)</th>
              <th className="py-1 pr-2 font-medium">sum l</th>
              <th className="py-1 font-medium">output so far, acc / l</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h, i) => (
              <tr key={i} className="border-t border-rule">
                <td className="py-1 pr-2">{i + 1}</td>
                <td className="py-1 pr-2">{h.m.toFixed(1)}</td>
                <td className={`py-1 pr-2 ${h.alpha < 0.999 && i > 0 ? 'font-semibold text-warn' : ''}`}>
                  {i === 0 ? '0 (nothing yet)' : fmt(h.alpha)}
                </td>
                <td className="py-1 pr-2">{h.l.toFixed(3)}</td>
                <td className="py-1">{(h.acc / h.l).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Blocks processed" value={`${step} of ${blocks}`} />
        <Stat label="Online result" value={last ? (last.acc / last.l).toFixed(6) : '—'} tone={done ? 'good' : undefined} />
        <Stat label="Exact softmax(s) · v" value={exact.toFixed(6)} />
      </div>

      <Narration tone={done ? 'good' : undefined}>
        {step === 0
          ? 'Nothing processed yet. The algorithm keeps only three numbers per query row: the largest score seen so far, the sum of exponentials relative to it, and the weighted sum of values.'
          : done
            ? `All ${blocks} blocks are done and acc / l equals the exact softmax-weighted value. The full row of ${N} probabilities never existed at once, which is how FlashAttention avoids storing the N × N matrix.`
            : step === 1
              ? `Block 1 sets the first running maximum, m = ${last.m.toFixed(1)}, and starts the sum and output from its own exponentials. There is nothing earlier to rescale yet.`
              : last.m > history[step - 2].m
                ? `Block ${step} contained a new maximum, so the old sum and output were multiplied by alpha = ${fmt(last.alpha)} to put them on the same scale as the new block before adding it.`
                : `Block ${step} did not raise the maximum, so alpha is 1 and its exponentials were simply added to the running sum and output.`}
      </Narration>
    </WidgetFrame>
  )
}
