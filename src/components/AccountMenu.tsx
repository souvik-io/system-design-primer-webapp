import { useEffect, useRef, useState, type FormEvent } from 'react'
import clsx from 'clsx'
import { Cloud, CloudAlert, CloudCheck, CloudOff, CloudUpload, LoaderCircle } from 'lucide-react'
import { loadAccounts, sendSignInLink, signOut, syncAvailable, syncNow, useAccount, type SyncStatus } from '../lib/account'

export function AccountMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { ready, email, status, error } = useAccount()

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!syncAvailable) return null

  const Icon = !ready ? Cloud : !email ? (error ? CloudAlert : CloudOff) : STATUS_ICON[status]
  const label = !ready ? 'Account' : email ? `Sync: ${STATUS_TEXT[status]}` : 'Sign in to sync your progress'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          loadAccounts()
          setOpen((o) => !o)
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        title={label}
        className={clsx(
          'flex items-center gap-2 rounded-md p-2 text-sm hover:bg-rule/50',
          (status === 'error' && email) || (error && !email) ? 'text-red-600 dark:text-red-400' : 'text-ink-2',
        )}
      >
        <Icon size={18} className={clsx(status === 'syncing' && email && 'animate-pulse')} />
        {ready && !email && <span className="hidden md:inline">Sign in</span>}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Account"
          className="absolute top-full right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-rule bg-surface p-5 shadow-lg"
        >
          {email ? <SignedIn email={email} /> : <SignedOut />}
        </div>
      )}
    </div>
  )
}

const STATUS_ICON: Record<SyncStatus, typeof Cloud> = {
  idle: Cloud,
  syncing: CloudUpload,
  synced: CloudCheck,
  offline: CloudOff,
  error: CloudAlert,
}

const STATUS_TEXT: Record<SyncStatus, string> = {
  idle: 'signed in',
  syncing: 'saving',
  synced: 'up to date',
  offline: 'offline',
  error: "couldn't sync",
}

function SignedOut() {
  const linkError = useAccount((s) => s.error)
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSending(true)
    setError(null)
    try {
      await sendSignInLink(email.trim())
      setSentTo(email.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : "The link wasn't sent. Try again.")
    } finally {
      setSending(false)
    }
  }

  if (sentTo) {
    return (
      <div className="text-sm">
        <h2 className="text-base font-semibold text-ink">Check your email</h2>
        <p className="mt-2 text-ink-2">
          We sent a sign-in link to <span className="font-medium text-ink">{sentTo}</span>. Open it on this device to finish signing in.
        </p>
        <button type="button" className="mt-4 text-accent hover:underline" onClick={() => setSentTo(null)}>
          Use a different email
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="text-sm">
      <h2 className="text-base font-semibold text-ink">Sync your progress</h2>
      <p className="mt-2 text-ink-2">
        Sign in to keep your reading progress and flashcard reviews on every device. What you've done in this browser is added to your account.
      </p>
      {linkError && !error && <p className="mt-3 text-red-600 dark:text-red-400">{linkError}</p>}
      <label htmlFor="account-email" className="mt-4 block font-medium text-ink">
        Email
      </label>
      <input
        id="account-email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="mt-1.5 w-full rounded-lg border border-rule bg-paper px-3 py-2 text-ink placeholder:text-muted focus:border-accent focus:outline-none"
      />
      {error && <p className="mt-2 text-red-600 dark:text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={sending}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-on-accent hover:opacity-90 disabled:opacity-60"
      >
        {sending && <LoaderCircle size={16} className="animate-spin" />}
        Email me a sign-in link
      </button>
      <p className="mt-3 text-muted">No password needed.</p>
    </form>
  )
}

function SignedIn({ email }: { email: string }) {
  const { status, lastSynced, error } = useAccount()
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [, tick] = useState(0)

  // Keep "Saved 2 minutes ago" current while the menu is open.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="text-sm">
      <p className="text-muted">Signed in as</p>
      <p className="truncate font-medium text-ink">{email}</p>

      <div className="mt-4 rounded-lg bg-paper px-3 py-2.5">
        {status === 'syncing' ? (
          <p className="text-ink-2">Saving your progress…</p>
        ) : status === 'offline' ? (
          <p className="text-ink-2">You're offline. Your progress will sync when you reconnect.</p>
        ) : status === 'error' ? (
          <>
            <p className="text-red-600 dark:text-red-400">Couldn't sync: {error}</p>
            <button type="button" className="mt-1 text-accent hover:underline" onClick={() => void syncNow()}>
              Try again
            </button>
          </>
        ) : (
          <p className="text-ink-2">Progress and flashcards sync across your devices.{lastSynced ? ` Last synced ${timeAgo(lastSynced)}.` : ''}</p>
        )}
      </div>

      {signOutError && <p className="mt-3 text-red-600 dark:text-red-400">{signOutError}</p>}
      <button
        type="button"
        disabled={signingOut}
        onClick={async () => {
          setSigningOut(true)
          setSignOutError(null)
          try {
            await signOut()
          } catch (err) {
            setSignOutError(err instanceof Error ? err.message : String(err))
            setSigningOut(false)
          }
        }}
        className="mt-4 rounded-lg border border-rule px-3 py-1.5 font-medium text-ink hover:border-muted/50 disabled:opacity-60"
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
      <p className="mt-2 text-muted">Signing out removes your progress from this browser. It stays in your account.</p>
    </div>
  )
}

function timeAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`
  const h = Math.round(m / 60)
  return `${h} ${h === 1 ? 'hour' : 'hours'} ago`
}
