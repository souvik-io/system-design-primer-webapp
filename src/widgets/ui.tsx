import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { MousePointerClick } from 'lucide-react'

// Shared pieces for the interactive diagrams. They sit inside `.article`, so each one resets
// the article's serif type and spacing at its root.

export function WidgetFrame({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <figure className="widget overflow-hidden rounded-xl border border-rule bg-surface font-sans text-[0.875rem] leading-normal text-ink not-italic">
      <figcaption className="border-b border-rule bg-paper/60 px-4 py-3 sm:px-5">
        <span className="flex items-center gap-2 text-[0.95rem] font-semibold text-ink">
          <MousePointerClick size={16} className="shrink-0 text-accent" aria-hidden />
          {title}
        </span>
        <span className="mt-1 block text-[0.85rem] leading-relaxed text-muted">{description}</span>
      </figcaption>
      <div className="space-y-4 px-4 py-4 sm:px-5">{children}</div>
    </figure>
  )
}

export function Button({
  children,
  onClick,
  disabled,
  tone = 'plain',
  title,
  pressed,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'plain' | 'primary' | 'danger'
  title?: string
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={pressed}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[0.8125rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        tone === 'primary' && 'border-accent bg-accent text-on-accent hover:opacity-90',
        tone === 'danger' && 'border-bad/40 text-bad hover:border-bad hover:bg-bad-soft',
        tone === 'plain' && (pressed ? 'border-accent/50 bg-accent-soft text-accent' : 'border-rule bg-surface text-ink hover:border-muted/60'),
      )}
    >
      {children}
    </button>
  )
}

/** A row of mutually exclusive choices. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-[0.8125rem] text-muted">{label}</span>
      <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-md border border-rule bg-paper p-0.5">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            onClick={() => onChange(o.value)}
            className={clsx(
              'rounded px-2.5 py-1 text-[0.8125rem] font-medium whitespace-nowrap',
              o.value === value ? 'bg-surface text-ink shadow-[0_0_0_1px_var(--rule)]' : 'text-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'bad' | 'good' | 'warn' }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.75rem] text-muted">{label}</div>
      <div
        className={clsx(
          'text-[1.05rem] font-semibold tabular-nums',
          tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-done' : tone === 'warn' ? 'text-warn' : 'text-ink',
        )}
      >
        {value}
      </div>
    </div>
  )
}

/** A sentence describing what just happened, read out by screen readers. */
export function Narration({ children, tone }: { children: ReactNode; tone?: 'bad' | 'good' }) {
  return (
    <p
      aria-live="polite"
      className={clsx(
        'min-h-[2.75rem] rounded-md px-3 py-2 text-[0.85rem] leading-relaxed',
        tone === 'bad' ? 'bg-bad-soft text-ink' : tone === 'good' ? 'bg-done-soft text-ink' : 'bg-paper text-ink-2',
      )}
    >
      {children}
    </p>
  )
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** Colors for up to six servers or series, defined in index.css for both themes. */
export const SERIES = ['var(--w1)', 'var(--w2)', 'var(--w3)', 'var(--w4)', 'var(--w5)', 'var(--w6)']

/** A slider over a list of preset values; `index` picks one and `text` shows it. */
export function IndexSlider({
  label,
  index,
  max,
  onChange,
  text,
  disabled,
}: {
  label: string
  index: number
  max: number
  onChange: (i: number) => void
  text: string
  disabled?: boolean
}) {
  return (
    <label className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-muted ${disabled ? 'opacity-50' : ''}`}>
      {label}
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={index}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-36 accent-[var(--accent)]"
        aria-valuetext={text}
      />
      <span className="text-ink tabular-nums">{text}</span>
    </label>
  )
}

/** A colour swatch with its label, for chart keys. */
export function Key({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-sm" style={{ background: color }} />
      {children}
    </span>
  )
}
