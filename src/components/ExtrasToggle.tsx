import clsx from 'clsx'
import { useSettings } from '../lib/settings'

/** On/off switch for the extra chapters written for this site. */
export function ExtrasSwitch({ className }: { className?: string }) {
  const showExtras = useSettings((s) => s.showExtras)
  const setShowExtras = useSettings((s) => s.setShowExtras)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={showExtras}
      onClick={() => setShowExtras(!showExtras)}
      className={clsx('group inline-flex items-center gap-3 text-sm font-medium text-ink', className)}
    >
      <span
        className={clsx(
          'relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors',
          showExtras ? 'bg-accent' : 'bg-muted/40 group-hover:bg-muted/60',
        )}
        aria-hidden
      >
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 size-4 rounded-full bg-surface shadow-sm transition-transform motion-reduce:transition-none',
            showExtras && 'translate-x-4',
          )}
        />
      </span>
      Show extra chapters
    </button>
  )
}
