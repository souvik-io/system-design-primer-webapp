import { Check } from 'lucide-react'

type Props = { ratio: number; size?: number; stroke?: number; label?: string }

/** Small circular progress indicator; turns into a filled check when complete. */
export function ProgressRing({ ratio, size = 18, stroke = 2.5, label }: Props) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const complete = ratio >= 1

  if (complete) {
    return (
      <span
        className="inline-grid shrink-0 place-items-center rounded-full bg-done text-surface"
        style={{ width: size, height: size }}
        role="img"
        aria-label={label ?? 'Complete'}
      >
        <Check size={size * 0.62} strokeWidth={3} />
      </span>
    )
  }

  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" role="img" aria-label={label ?? `${Math.round(ratio * 100)}% complete`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--rule)" strokeWidth={stroke} />
      {ratio > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--done)"
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - ratio)}
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}
