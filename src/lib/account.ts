import { create } from 'zustand'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useProgress } from './progress'
import { useFlashcards } from './flashcards'
import { useNotes } from './notes'
import { usePlan } from './plans'
import { emptyDoc, mergeDocs, parseDoc, sameDoc, SYNC_VERSION, type SyncDoc } from './syncDoc'

// Optional accounts. VITE_PROGRESS_STORAGE picks where progress lives:
// - "browser" (the default): localStorage only, no sign-in.
// - "supabase": signing in by email link syncs reading progress, flashcard history, notes, bookmarks and the study plan through
//   one row per user in the `progress` table (see supabase/). Needs the two Supabase variables too.

const storage = import.meta.env.VITE_PROGRESS_STORAGE || 'browser'
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (storage !== 'browser' && storage !== 'supabase')
  console.warn(`VITE_PROGRESS_STORAGE is "${storage}". Use "browser" or "supabase". Keeping progress in the browser.`)
else if (storage === 'supabase' && !(url && key))
  console.warn(
    'VITE_PROGRESS_STORAGE is "supabase" but VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY is missing. Keeping progress in the browser.',
  )

export const syncAvailable = storage === 'supabase' && Boolean(url && key)

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error'

type AccountState = {
  /** False until the saved session (if any) has been checked */
  ready: boolean
  email: string | null
  status: SyncStatus
  lastSynced: number | null
  error: string | null
}

export const useAccount = create<AccountState>(() => ({ ready: true, email: null, status: 'idle', lastSynced: null, error: null }))

let client: Promise<SupabaseClient> | null = null
let userId: string | null = null

/** Loads supabase-js and starts listening for sign-in changes. Only runs once. */
function start() {
  client ??= import('@supabase/supabase-js').then(({ createClient }) => {
    const sb = createClient(url!, key!, { auth: { flowType: 'implicit' } })
    sb.auth.onAuthStateChange((_event, session) => {
      const id = session?.user.id ?? null
      useAccount.setState({ ready: true, email: session?.user.email ?? null })
      if (id === userId) return
      userId = id
      if (!id) {
        useAccount.setState({ status: 'idle', lastSynced: null })
        return
      }
      // Supabase calls made inside this callback can deadlock, so sync on the next tick.
      setTimeout(() => void syncNow(), 0)
    })
    return sb
  })
  return client
}

// Load supabase-js on page load only for someone who is signed in or returning from a sign-in link.
// Everyone else gets it when they open the account menu.
if (syncAvailable) {
  let signedIn = false
  try {
    signedIn = Object.keys(localStorage).some((k) => k.startsWith('sb-') && k.endsWith('-auth-token'))
  } catch {
    /* storage unavailable */
  }
  const params = new URLSearchParams(location.hash.slice(1))
  const linkError = params.get('error_description')
  if (linkError) useAccount.setState({ error: `Sign-in link didn't work: ${linkError}. Request a new one.` })
  if (signedIn || params.has('access_token')) {
    useAccount.setState({ ready: false })
    start()
  }
}

export function loadAccounts() {
  if (syncAvailable) void start()
}

export async function sendSignInLink(email: string) {
  const sb = await start()
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } })
  if (error) throw error
  useAccount.setState({ error: null })
}

/** Saves anything unsynced, then signs out and clears this browser's copy. The account keeps it. */
export async function signOut() {
  clearTimeout(timer)
  timer = undefined
  if (!(await syncNow())) throw new Error("Your latest progress isn't saved yet, so you're still signed in. Check your connection and try again.")
  const sb = await start()
  const { error } = await sb.auth.signOut({ scope: 'local' })
  if (error) throw error
  userId = null
  applyDoc(emptyDoc())
  useAccount.setState({ email: null, status: 'idle', lastSynced: null, error: null })
}

function snapshot(): SyncDoc {
  const { completed, removed, resetAt, lastVisited } = useProgress.getState()
  const { cards, removedCards, introduced, newPerDay, newPerDayAt } = useFlashcards.getState()
  const { notes, bookmarks } = useNotes.getState()
  const { plan, planAt } = usePlan.getState()
  return {
    v: SYNC_VERSION,
    progress: { completed, removed, resetAt, lastVisited },
    flashcards: { cards, removedCards, introduced, newPerDay, newPerDayAt },
    notes: { notes, bookmarks },
    plan: { plan, planAt },
  }
}

let applying = false

function applyDoc(doc: SyncDoc) {
  applying = true
  try {
    useProgress.setState(doc.progress)
    useFlashcards.setState(doc.flashcards)
    useNotes.setState(doc.notes)
    usePlan.setState(doc.plan)
  } finally {
    applying = false
  }
}

// Sync runs one at a time. Each run reads the account's copy, merges it with this browser's, and
// writes back only if this browser had something newer. The write is conditional on the version
// it read, so if another device saved in between, the run reads again and re-merges.

let queued: Promise<boolean> | null = null
let current: Promise<boolean> = Promise.resolve(true)

export function syncNow(): Promise<boolean> {
  if (queued) return queued
  queued = current.then(() => {
    queued = null
    return runSync()
  })
  current = queued
  return queued
}

async function runSync(): Promise<boolean> {
  const id = userId
  if (!id) return false
  if (!navigator.onLine) {
    useAccount.setState({ status: 'offline' })
    return false
  }
  useAccount.setState({ status: 'syncing' })
  try {
    const sb = await start()
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: row, error } = await sb.from('progress').select('data, version').eq('user_id', id).maybeSingle()
      if (error) throw error
      if (userId !== id) return false

      const remote = row ? parseDoc(row.data) : null
      const local = snapshot()
      const merged = remote ? mergeDocs(local, remote) : local
      if (!sameDoc(merged, local)) applyDoc(merged)
      if (remote && sameDoc(merged, remote)) return synced()

      const now = new Date().toISOString()
      const write = row
        ? await sb
            .from('progress')
            .update({ data: merged, version: row.version + 1, updated_at: now })
            .eq('user_id', id)
            .eq('version', row.version)
            .select('version')
        : await sb.from('progress').insert({ user_id: id, data: merged, version: 1, updated_at: now }).select('version')
      // 23505: another device created the row first. Either way, read again and re-merge.
      if (write.error && write.error.code !== '23505') throw write.error
      if (!write.error && write.data.length > 0) return synced()
    }
    throw new Error('Other devices kept saving at the same time.')
  } catch (e) {
    const message = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)
    useAccount.setState({ status: navigator.onLine ? 'error' : 'offline', error: navigator.onLine ? message : null })
    return false
  }
}

function synced() {
  useAccount.setState({ status: 'synced', lastSynced: Date.now(), error: null })
  return true
}

// Save changes shortly after they happen. Just scrolling to a new section waits longer, since
// it only moves "continue where you left off".

let timer: ReturnType<typeof setTimeout> | undefined
let timerAt = Infinity

function scheduleSync(delay: number) {
  if (!userId || applying) return
  const at = Date.now() + delay
  if (timer && timerAt <= at) return
  clearTimeout(timer)
  timerAt = at
  timer = setTimeout(() => {
    timer = undefined
    timerAt = Infinity
    void syncNow()
  }, delay)
}

useProgress.subscribe((s, prev) => scheduleSync(s.completed !== prev.completed || s.resetAt !== prev.resetAt ? 1500 : 15_000))
useFlashcards.subscribe(() => scheduleSync(1500))
useNotes.subscribe(() => scheduleSync(1500))
usePlan.subscribe(() => scheduleSync(1500))

// Save before the tab is hidden or closed, pick up other devices' changes when it comes back,
// and retry after reconnecting.
document.addEventListener('visibilitychange', () => {
  if (!userId) return
  if (document.visibilityState === 'hidden') {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
      timerAt = Infinity
      void syncNow()
    }
  } else void syncNow()
})
window.addEventListener('online', () => {
  if (userId) void syncNow()
})
