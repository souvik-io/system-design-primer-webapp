import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Narration, Segmented, Stat, WidgetFrame, useReducedMotion } from './ui'

// A primary and two replicas. Writes go to the primary and reach each replica after a delay.
// Reading a replica that hasn't caught up returns old data, and failing the primary shows which
// acknowledged writes survive the promotion of a replica.

type NodeId = 'db-1' | 'db-2' | 'db-3'
const IDS: NodeId[] = ['db-1', 'db-2', 'db-3']
type Mode = 'async' | 'semi'
type WriteStatus = 'saved' | 'waiting' | 'lost' | 'failed'

type SimNode = { up: boolean; applied: number[] }
type Msg = { from: NodeId; to: NodeId; seqs: number[]; sentAt: number; arriveAt: number }
type Write = { seq: number; at: number; status: WriteStatus; ackMs?: number }

type Sim = {
  primary: NodeId | null
  nodes: Record<NodeId, SimNode>
  writes: Write[]
  nextSeq: number
  msgs: Msg[]
  /** While the primary is down: when the replicas notice and promote one of them */
  promoteAt: number | null
  failed: NodeId | null
  message: ReactNode
  tone?: 'bad' | 'good'
  staleReads: number
}

const DETECT_MS = 2000
const KEEP = 14

/** db-3 sits further away than db-2, so it lags more. */
const lagFor = (to: NodeId, base: number) => base * (to === 'db-3' ? 1.6 : to === 'db-1' ? 1.25 : 1)

const start = (): Sim => ({
  primary: 'db-1',
  nodes: { 'db-1': { up: true, applied: [] }, 'db-2': { up: true, applied: [] }, 'db-3': { up: true, applied: [] } },
  writes: [],
  nextSeq: 1,
  msgs: [],
  promoteAt: null,
  failed: null,
  message: 'db-1 is the primary. Every write goes to it and is copied to db-2 and db-3 after a delay. Write a few times, then read from a replica.',
  staleReads: 0,
})

const has = (n: SimNode, seq: number) => n.applied.includes(seq)
const latestOn = (n: SimNode) => (n.applied.length ? Math.max(...n.applied) : 0)
const newestSaved = (s: Sim) => s.writes.filter((w) => w.status === 'saved').at(-1)?.seq ?? 0

export default function Replication() {
  const [sim, setSim] = useState(start)
  const [mode, setMode] = useState<Mode>('async')
  const [lag, setLag] = useState(1.2)
  const [auto, setAuto] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const reduced = useReducedMotion()

  const busy = sim.msgs.length > 0 || sim.promoteAt !== null || auto
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      setSim((s) => step(s, t))
    }, 50)
    return () => clearInterval(id)
  }, [busy])

  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => setSim((s) => (s.primary ? write(s, Date.now(), mode, lag) : s)), 700)
    return () => clearInterval(id)
  }, [auto, mode, lag])

  const act = (f: (s: Sim, t: number) => Sim) => {
    const t = Date.now()
    setNow(t)
    setSim((s) => f(step(s, t), t))
  }

  const behind = (id: NodeId) => {
    if (!sim.primary || id === sim.primary || !sim.nodes[id].up) return 0
    const p = sim.nodes[sim.primary]
    return p.applied.filter((seq) => !has(sim.nodes[id], seq)).length
  }

  const lastAck = [...sim.writes].reverse().find((w) => w.ackMs !== undefined)
  const lost = sim.writes.filter((w) => w.status === 'lost').length

  return (
    <WidgetFrame
      title="Try it: replication lag and failover"
      description="Three database servers. Writes go to the primary and are copied to the replicas after a delay. Read from a replica that's behind, then fail the primary and see which writes survive."
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented
          label="Replication"
          value={mode}
          options={[
            { value: 'async', label: 'Asynchronous' },
            { value: 'semi', label: 'Semi-synchronous' },
          ]}
          onChange={(m) => {
            setMode(m)
            setSim((s) => ({
              ...s,
              tone: undefined,
              message:
                m === 'async'
                  ? 'Asynchronous: the primary confirms a write as soon as it has it, without waiting for any replica.'
                  : 'Semi-synchronous: the primary confirms a write only once at least one replica has it too. Writes take longer.',
            }))
          }}
        />
        <label className="flex items-center gap-2.5 text-[0.8125rem] text-muted">
          Replication delay
          <input
            type="range"
            min={0.2}
            max={3}
            step={0.1}
            value={lag}
            onChange={(e) => setLag(Number(e.target.value))}
            className="w-28 accent-[var(--accent)]"
          />
          <span className="w-9 text-ink tabular-nums">{lag.toFixed(1)} s</span>
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button tone="primary" onClick={() => act((s, t) => write(s, t, mode, lag))}>
          Write
        </Button>
        <Button onClick={() => setAuto((a) => !a)} pressed={auto}>
          {auto ? 'Stop writing' : 'Keep writing'}
        </Button>
        <Button tone="danger" disabled={!sim.primary} onClick={() => act(failPrimary)}>
          Fail the primary
        </Button>
        {sim.failed && sim.primary && <Button onClick={() => act((s, t) => rejoin(s, t, lag))}>Bring {sim.failed} back</Button>}
        <Button
          onClick={() => {
            setAuto(false)
            setSim(start())
          }}
        >
          Start over
        </Button>
      </div>

      <Diagram sim={sim} now={now} behind={behind} reduced={reduced} onRead={(id) => act((s) => read(s, id))} />

      <Strips sim={sim} />

      <Narration tone={sim.tone}>{sim.message}</Narration>

      <div className="grid grid-cols-2 gap-3 border-t border-rule pt-3 sm:grid-cols-4">
        <Stat label="Writes saved" value={sim.writes.filter((w) => w.status === 'saved').length} />
        <Stat label="Last write took" value={lastAck ? `${lastAck.ackMs! < 5 ? '<5' : lastAck.ackMs} ms` : '–'} />
        <Stat label="Stale reads" value={sim.staleReads} tone={sim.staleReads ? 'warn' : undefined} />
        <Stat label="Saved, then lost" value={lost} tone={lost ? 'bad' : undefined} />
      </div>
    </WidgetFrame>
  )
}

// --- Simulation ------------------------------------------------------------

function write(s: Sim, t: number, mode: Mode, lag: number): Sim {
  if (!s.primary) {
    const seq = s.nextSeq
    return {
      ...s,
      nextSeq: seq + 1,
      writes: [...s.writes, { seq, at: t, status: 'failed' as const }].slice(-40),
      tone: 'bad',
      message: `Write #${seq} failed: there's no primary right now. The replicas are still waiting to be sure it's gone.`,
    }
  }
  const p = s.primary
  const seq = s.nextSeq
  const replicas = IDS.filter((id) => id !== p && s.nodes[id].up)
  const waits = mode === 'semi'
  return {
    ...s,
    nextSeq: seq + 1,
    nodes: { ...s.nodes, [p]: { ...s.nodes[p], applied: [...s.nodes[p].applied, seq] } },
    msgs: [...s.msgs, ...replicas.map((to) => ({ from: p, to, seqs: [seq], sentAt: t, arriveAt: t + lagFor(to, lag) * 1000 }))],
    writes: [...s.writes, { seq, at: t, status: waits ? 'waiting' : 'saved', ...(waits ? {} : { ackMs: 2 }) } as Write].slice(-40),
    tone: undefined,
    message: waits
      ? `Write #${seq} is on ${p}. The client waits until a replica has it too.`
      : `Write #${seq} is saved on ${p} and the client has its answer. The replicas get it ${lag.toFixed(1)} s or more later.`,
  }
}

/** Delivers messages that have arrived, confirms semi-synchronous writes, and promotes a replica when it's time. */
function step(s: Sim, t: number): Sim {
  let next = s
  const arrived = s.msgs.filter((m) => m.arriveAt <= t)
  if (arrived.length) {
    const nodes = { ...s.nodes }
    for (const m of arrived) {
      const n = nodes[m.to]
      if (!n.up) continue
      nodes[m.to] = { ...n, applied: [...n.applied, ...m.seqs.filter((q) => !n.applied.includes(q))].sort((a, b) => a - b) }
    }
    const replicas = IDS.filter((id) => id !== s.primary)
    const writes = s.writes.map((w) =>
      w.status === 'waiting' && replicas.some((id) => has(nodes[id], w.seq)) ? { ...w, status: 'saved' as const, ackMs: Math.round(t - w.at) } : w,
    )
    next = { ...s, nodes, writes, msgs: s.msgs.filter((m) => m.arriveAt > t) }
  }
  if (next.promoteAt !== null && t >= next.promoteAt) next = promote(next, t)
  return next
}

function failPrimary(s: Sim, t: number): Sim {
  if (!s.primary) return s
  const p = s.primary
  const unsent = s.msgs.filter((m) => m.from === p).length
  return {
    ...s,
    primary: null,
    failed: p,
    nodes: { ...s.nodes, [p]: { ...s.nodes[p], up: false } },
    // Copies still on their way from the failed primary never arrive.
    msgs: s.msgs.filter((m) => m.from !== p),
    promoteAt: t + DETECT_MS,
    tone: 'bad',
    message: `${p} crashed${unsent ? `, with ${unsent} ${unsent === 1 ? 'copy' : 'copies'} still on the way to the replicas` : ''}. Writes fail until the replicas notice it's gone and promote one of themselves.`,
  }
}

function promote(s: Sim, t: number): Sim {
  const candidates = IDS.filter((id) => s.nodes[id].up)
  if (!candidates.length) return { ...s, promoteAt: null }
  // The replica with the most writes wins, so as little as possible is lost.
  const winner = candidates.reduce((a, b) => (latestOn(s.nodes[b]) > latestOn(s.nodes[a]) ? b : a))
  const w = s.nodes[winner]
  const lostSeqs: number[] = []
  const writes = s.writes.map((wr) => {
    if (has(w, wr.seq)) return wr.status === 'waiting' ? { ...wr, status: 'saved' as const, ackMs: Math.round(t - wr.at) } : wr
    if (wr.status === 'saved') {
      lostSeqs.push(wr.seq)
      return { ...wr, status: 'lost' as const }
    }
    if (wr.status === 'waiting') return { ...wr, status: 'failed' as const }
    return wr
  })
  // The other replica copies anything it's missing from the new primary.
  const catchUp = candidates
    .filter((id) => id !== winner)
    .map((to) => ({ from: winner, to, seqs: w.applied.filter((q) => !has(s.nodes[to], q)), sentAt: t, arriveAt: t + 800 }))
    .filter((m) => m.seqs.length)
  return {
    ...s,
    primary: winner,
    promoteAt: null,
    writes,
    msgs: [...s.msgs, ...catchUp],
    tone: lostSeqs.length ? 'bad' : 'good',
    message: lostSeqs.length ? (
      <>
        {winner} was the most up to date replica and is now the primary. {lostSeqs.length === 1 ? 'Write' : 'Writes'} #{lostSeqs.join(', #')} never
        reached it. The client was told {lostSeqs.length === 1 ? 'it was' : 'they were'} saved, and {lostSeqs.length === 1 ? "it's" : "they're"} gone.
      </>
    ) : (
      <>{winner} is now the primary, and it has every write the clients were told was saved. Nothing was lost.</>
    ),
  }
}

function rejoin(s: Sim, t: number, lag: number): Sim {
  const old = s.failed
  if (!old || !s.primary) return s
  const p = s.nodes[s.primary]
  const extra = s.nodes[old].applied.filter((q) => !has(p, q))
  const kept = s.nodes[old].applied.filter((q) => has(p, q))
  const missing = p.applied.filter((q) => !kept.includes(q))
  return {
    ...s,
    failed: null,
    nodes: { ...s.nodes, [old]: { up: true, applied: kept } },
    msgs: missing.length ? [...s.msgs, { from: s.primary, to: old, seqs: missing, sentAt: t, arriveAt: t + lagFor(old, lag) * 1000 }] : s.msgs,
    tone: undefined,
    message: extra.length ? (
      <>
        {old} is back as a replica. It still had #{extra.join(', #')}, which the new primary never got, so it throws{' '}
        {extra.length === 1 ? 'that write' : 'those writes'} away and copies the rest from {s.primary}.
      </>
    ) : (
      <>
        {old} is back as a replica and copies what it missed from {s.primary}.
      </>
    ),
  }
}

function read(s: Sim, id: NodeId): Sim {
  const n = s.nodes[id]
  if (!n.up) return { ...s, tone: 'bad', message: `${id} is down. The read fails.` }
  const got = latestOn(n)
  const newest = newestSaved(s)
  const savedMissing = s.writes.filter((w) => w.status === 'saved' && !has(n, w.seq)).length
  if (!savedMissing || (got === 0 && newest === 0))
    return {
      ...s,
      tone: 'good',
      message: got ? `${id} returned write #${got}, the newest saved write.` : `${id} has no writes yet. Write something first.`,
    }
  return {
    ...s,
    staleReads: s.staleReads + 1,
    tone: 'bad',
    message: (
      <>
        {id} returned {got ? `write #${got}` : 'nothing'}, but #{newest} has been saved. This read is {savedMissing}{' '}
        {savedMissing === 1 ? 'write' : 'writes'} behind, so a user who just made write #{newest} wouldn't see it here.
      </>
    ),
  }
}

// --- Drawing ---------------------------------------------------------------

const POS: Record<NodeId, { x: number; y: number }> = {
  'db-1': { x: 16, y: 70 },
  'db-2': { x: 236, y: 8 },
  'db-3': { x: 236, y: 132 },
}
const W = 140
const H = 62
const center = (id: NodeId) => ({ x: POS[id].x + W / 2, y: POS[id].y + H / 2 })

function edgePoints(a: NodeId, b: NodeId) {
  const [p, q] = [center(a), center(b)]
  const trim = (from: typeof p, to: typeof q) => {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const k = Math.min(dx ? (W / 2 + 4) / Math.abs(dx) : Infinity, dy ? (H / 2 + 4) / Math.abs(dy) : Infinity)
    return { x: from.x + dx * k, y: from.y + dy * k }
  }
  return [trim(p, q), trim(q, p)] as const
}

function Diagram({
  sim,
  now,
  behind,
  reduced,
  onRead,
}: {
  sim: Sim
  now: number
  behind: (id: NodeId) => number
  reduced: boolean
  onRead: (id: NodeId) => void
}) {
  const pairs: [NodeId, NodeId][] = [
    ['db-1', 'db-2'],
    ['db-1', 'db-3'],
    ['db-2', 'db-3'],
  ]
  const live = (a: NodeId, b: NodeId) => sim.primary && (a === sim.primary || b === sim.primary) && sim.nodes[a].up && sim.nodes[b].up

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-rule bg-paper/50 p-2">
        <svg viewBox="0 0 392 202" className="mx-auto block w-full max-w-[30rem]" role="img" aria-label="A primary database and two replicas">
          {pairs.map(([a, b]) => {
            const [p, q] = edgePoints(a, b)
            return (
              <line
                key={a + b}
                x1={p.x}
                y1={p.y}
                x2={q.x}
                y2={q.y}
                stroke={live(a, b) ? 'var(--muted)' : 'var(--rule)'}
                strokeWidth={live(a, b) ? 1.5 : 1}
                strokeDasharray={live(a, b) ? undefined : '4 4'}
              />
            )
          })}
          {sim.msgs.map((m, i) => {
            const [p, q] = edgePoints(m.from, m.to)
            const f = reduced ? 0.5 : Math.min(1, Math.max(0, (now - m.sentAt) / (m.arriveAt - m.sentAt)))
            const label = m.seqs.length === 1 ? `#${m.seqs[0]}` : `${m.seqs.length}`
            return (
              <g key={i} transform={`translate(${p.x + (q.x - p.x) * f}, ${p.y + (q.y - p.y) * f})`}>
                <rect x={-14} y={-9} width={28} height={18} rx={9} fill="var(--accent)" />
                <text y={4} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--on-accent)">
                  {label}
                </text>
              </g>
            )
          })}
          {IDS.map((id) => {
            const n = sim.nodes[id]
            const isPrimary = id === sim.primary
            const lagging = behind(id)
            const role = !n.up ? 'Down' : isPrimary ? 'Primary' : sim.primary ? 'Replica' : 'Replica, no primary'
            const { x, y } = POS[id]
            return (
              <g key={id}>
                <rect
                  x={x}
                  y={y}
                  width={W}
                  height={H}
                  rx={8}
                  fill={n.up ? 'var(--surface)' : 'var(--bad-soft)'}
                  stroke={!n.up ? 'var(--bad)' : isPrimary ? 'var(--accent)' : 'var(--ink-2)'}
                  strokeWidth={isPrimary ? 2 : 1.25}
                />
                <text x={x + 12} y={y + 22} fontSize={13} fontWeight={600} fill="var(--ink)">
                  {id}
                </text>
                <text
                  x={x + W - 12}
                  y={y + 22}
                  fontSize={11.5}
                  textAnchor="end"
                  fontWeight={600}
                  fill={!n.up ? 'var(--bad)' : isPrimary ? 'var(--accent)' : 'var(--muted)'}
                >
                  {role}
                </text>
                <text x={x + 12} y={y + 45} fontSize={12} fill={lagging ? 'var(--warn)' : 'var(--ink-2)'} fontWeight={lagging ? 600 : 400}>
                  {latestOn(n) ? `has up to #${latestOn(n)}` : 'no writes yet'}
                  {lagging ? `, ${lagging} behind` : ''}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.8125rem] text-muted">Read from</span>
        {IDS.map((id) => (
          <Button key={id} onClick={() => onRead(id)} disabled={!sim.nodes[id].up}>
            {id}
            {id === sim.primary ? ' (primary)' : ''}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** Which of the recent writes each server has. */
function Strips({ sim }: { sim: Sim }) {
  const recent = sim.writes.slice(-KEEP)
  if (!recent.length) return null
  const statusText: Record<WriteStatus, string> = { saved: 'saved', waiting: 'waiting for a replica', lost: 'saved, then lost', failed: 'failed' }
  return (
    <div className="overflow-x-auto">
      <div
        className="inline-grid min-w-full gap-y-1 text-[0.75rem]"
        style={{ gridTemplateColumns: `3.5rem repeat(${recent.length}, minmax(1.6rem, 1fr))` }}
      >
        <span className="text-muted">Write</span>
        {recent.map((w) => (
          <span
            key={w.seq}
            title={`Write #${w.seq}: ${statusText[w.status]}`}
            className={clsx(
              'text-center font-medium tabular-nums',
              w.status === 'lost' && 'text-bad line-through',
              w.status === 'failed' && 'text-muted line-through',
              w.status === 'waiting' && 'text-warn',
            )}
          >
            {w.seq}
          </span>
        ))}
        {IDS.map((id) => (
          <Row key={id} id={id} sim={sim} recent={recent} />
        ))}
      </div>
      <p className="mt-1.5 text-[0.75rem] text-muted">Filled squares are the writes each server has. Struck-through numbers failed or were lost.</p>
    </div>
  )
}

function Row({ id, sim, recent }: { id: NodeId; sim: Sim; recent: Write[] }) {
  const n = sim.nodes[id]
  return (
    <>
      <span className={clsx('font-medium', !n.up ? 'text-bad' : id === sim.primary ? 'text-accent' : 'text-ink-2')}>{id}</span>
      {recent.map((w) => (
        <span key={w.seq} className="flex justify-center">
          <span
            className={clsx(
              'size-3.5 rounded-[3px] border',
              has(n, w.seq) ? (w.status === 'lost' ? 'border-bad bg-bad' : 'border-accent bg-accent') : 'border-rule',
              !n.up && 'opacity-50',
            )}
            aria-label={`${id} ${has(n, w.seq) ? 'has' : "doesn't have"} write ${w.seq}`}
          />
        </span>
      ))}
    </>
  )
}
