import { useMemo, useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { Button, Narration, Segmented, SERIES, Stat, WidgetFrame } from './ui'

// Consistent hashing on a ring, next to hash mod N, with the same 120 keys.

const POOL = ['A', 'B', 'C', 'D', 'E', 'F']
const KEYS = Array.from({ length: 120 }, (_, i) => `user:${i}`)
const POINTS_PER_SERVER = [1, 4, 16, 64]

/** A stable hash of a string to [0, 1): FNV-1a, then a final mix so nearby strings spread out. */
function hash(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 2 ** 32
}

const keyPos = new Map(KEYS.map((k) => [k, hash(k)]))

type Point = { pos: number; server: string }

function ringPoints(servers: string[], perServer: number): Point[] {
  return servers
    .flatMap((server) => Array.from({ length: perServer }, (_, i) => ({ pos: hash(perServer === 1 ? server : `${server}#${i}`), server })))
    .sort((a, b) => a.pos - b.pos)
}

/** Each key belongs to the first point at or after its position, wrapping round to the start. */
function ownersOnRing(points: Point[]) {
  const owners = new Map<string, string>()
  for (const [key, pos] of keyPos) {
    let lo = 0
    let hi = points.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (points[mid].pos < pos) lo = mid + 1
      else hi = mid
    }
    owners.set(key, points[lo % points.length].server)
  }
  return owners
}

function ownersModN(servers: string[]) {
  return new Map(KEYS.map((k) => [k, servers[Math.floor(keyPos.get(k)! * 2 ** 32) % servers.length]]))
}

const countMoved = (a: Map<string, string>, b: Map<string, string>) => KEYS.filter((k) => a.get(k) !== b.get(k))
const pct = (n: number) => `${Math.round((n / KEYS.length) * 100)}%`
const listOf = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

type Change = { id: number; text: ReactNode; moved: Set<string> }

export default function HashRing() {
  const [servers, setServers] = useState(['A', 'B', 'C'])
  const [perServer, setPerServer] = useState(1)
  const [change, setChange] = useState<Change | null>(null)

  const points = useMemo(() => ringPoints(servers, perServer), [servers, perServer])
  const owners = useMemo(() => ownersOnRing(points), [points])
  const colorOf = (s: string) => SERIES[POOL.indexOf(s)]

  const load = servers.map((s) => ({ server: s, keys: KEYS.filter((k) => owners.get(k) === s).length }))
  const fair = KEYS.length / servers.length
  const busiest = Math.max(...load.map((l) => l.keys)) / fair

  const changeServers = (next: string[], text: (moved: string[], modMoved: string[], after: Map<string, string>) => ReactNode) => {
    const after = ownersOnRing(ringPoints(next, perServer))
    const moved = countMoved(owners, after)
    const modMoved = countMoved(ownersModN(servers), ownersModN(next))
    setServers(next)
    setChange({ id: Date.now(), text: text(moved, modMoved, after), moved: new Set(moved) })
  }

  const add = () => {
    const name = POOL.find((s) => !servers.includes(s))!
    const next = POOL.filter((s) => s === name || servers.includes(s))
    changeServers(next, (moved, modMoved) => (
      <>
        Added server {name}. On the ring, {moved.length} of {KEYS.length} keys moved ({pct(moved.length)}), all of them to {name}. The fair minimum is{' '}
        {pct(KEYS.length / next.length)}. With hash mod N, {modMoved.length} keys ({pct(modMoved.length)}) would have moved.
      </>
    ))
  }

  const remove = (name: string) => {
    const next = servers.filter((s) => s !== name)
    changeServers(next, (moved, modMoved, after) => {
      const to = [...new Set(moved.map((k) => after.get(k)!))].sort()
      return (
        <>
          Removed server {name}. Only its own {moved.length} keys moved, to {listOf(to.map((s) => `server ${s}`))}. Every other key stayed put. With
          hash mod N, {modMoved.length} keys ({pct(modMoved.length)}) would have moved.
        </>
      )
    })
  }

  const changePoints = (n: number) => {
    const nextOwners = ownersOnRing(ringPoints(servers, n))
    const counts = servers.map((s) => KEYS.filter((k) => nextOwners.get(k) === s).length)
    setPerServer(n)
    setChange({
      id: Date.now(),
      moved: new Set(),
      text: (
        <>
          Each server now has {n} {n === 1 ? 'point' : 'points'} on the ring. The busiest server holds {(Math.max(...counts) / fair).toFixed(2)}× its
          fair share of keys
          {n === 1 ? '.' : `, and if one fails its keys spread over the others instead of all landing on one neighbor.`}
        </>
      ),
    })
  }

  return (
    <WidgetFrame
      title="Try it: add and remove servers on a hash ring"
      description="120 keys hashed onto a ring. Each key, shown as a dot, belongs to the first server point clockwise from it. Keys outlined after a change are the ones that moved."
    >
      <div className="grid items-start gap-5 sm:grid-cols-[minmax(0,17rem)_1fr]">
        <Ring points={points} owners={owners} colorOf={colorOf} change={change} perServer={perServer} serverCount={servers.length} />

        <div className="space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-[0.8125rem] text-muted">Keys per server</span>
              <span className="text-[0.75rem] text-muted">dashed line: fair share</span>
            </div>
            <div className="space-y-1.5">
              {load.map(({ server, keys }) => (
                <div key={server} className="flex items-center gap-2">
                  <span className="w-[4.5rem] shrink-0 text-[0.8125rem] font-medium" style={{ color: colorOf(server) }}>
                    Server {server}
                  </span>
                  <span className="relative h-4 flex-1 rounded-sm bg-paper">
                    <span
                      className="absolute inset-y-0 left-0 rounded-sm transition-[width] duration-300"
                      style={{ width: `${(keys / KEYS.length) * 100}%`, background: colorOf(server), opacity: 0.85 }}
                    />
                    <span
                      className="absolute inset-y-[-3px] border-l border-dashed border-ink-2"
                      style={{ left: `${(fair / KEYS.length) * 100}%` }}
                    />
                  </span>
                  <span className="w-8 shrink-0 text-right text-[0.8125rem] tabular-nums">{keys}</span>
                  <button
                    type="button"
                    onClick={() => remove(server)}
                    disabled={servers.length === 1}
                    className="rounded p-0.5 text-muted hover:bg-bad-soft hover:text-bad disabled:invisible"
                    aria-label={`Remove server ${server}`}
                    title={`Remove server ${server}`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2.5">
              <Button onClick={add} disabled={servers.length === POOL.length}>
                <Plus size={14} /> Add server
              </Button>
            </div>
          </div>

          <Segmented
            label="Points per server"
            value={perServer}
            options={POINTS_PER_SERVER.map((n) => ({ value: n, label: String(n) }))}
            onChange={changePoints}
          />

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Servers" value={servers.length} />
            <Stat label="Busiest server" value={`${busiest.toFixed(2)}× fair`} tone={busiest > 1.5 ? 'warn' : busiest < 1.15 ? 'good' : undefined} />
          </div>
        </div>
      </div>

      <Narration>
        {change?.text ??
          'Three servers, one point each. Add or remove a server to see which keys move, then give each server more points and watch the load even out.'}
      </Narration>
    </WidgetFrame>
  )
}

function Ring({
  points,
  owners,
  colorOf,
  change,
  perServer,
  serverCount,
}: {
  points: Point[]
  owners: Map<string, string>
  colorOf: (s: string) => string
  change: Change | null
  perServer: number
  serverCount: number
}) {
  const C = 150
  const R = 116
  const at = (r: number, pos: number) => {
    const a = pos * 2 * Math.PI - Math.PI / 2
    return [C + r * Math.cos(a), C + r * Math.sin(a)] as const
  }
  const f = (n: number) => n.toFixed(1)

  // The arc ending at each point belongs to that point's server.
  const arcs = points.map((p, i) => {
    const prev = points[(i - 1 + points.length) % points.length].pos
    const span = (p.pos - prev + 1) % 1 || 1
    if (span === 1) return <circle key={i} cx={C} cy={C} r={R} fill="none" stroke={colorOf(p.server)} strokeWidth={10} opacity={0.35} />
    const [x1, y1] = at(R, prev)
    const [x2, y2] = at(R, p.pos)
    return (
      <path
        key={i}
        d={`M${f(x1)},${f(y1)} A${R},${R} 0 ${span > 0.5 ? 1 : 0} 1 ${f(x2)},${f(y2)}`}
        fill="none"
        stroke={colorOf(p.server)}
        strokeWidth={10}
        opacity={0.35}
      />
    )
  })

  return (
    <svg viewBox="0 0 300 300" className="mx-auto block w-full max-w-[17rem]" role="img" aria-label={`Hash ring with ${serverCount} servers`}>
      <circle cx={C} cy={C} r={R} fill="none" stroke="var(--rule)" strokeWidth={10} />
      {arcs}
      {points.map((p, i) => {
        if (perServer > 16) {
          const [x1, y1] = at(R - 8, p.pos)
          const [x2, y2] = at(R + 8, p.pos)
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={colorOf(p.server)} strokeWidth={1.5} />
        }
        const [x, y] = at(R, p.pos)
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={perServer === 1 ? 7 : perServer === 4 ? 5 : 3.5}
            fill={colorOf(p.server)}
            stroke="var(--surface)"
            strokeWidth={1.5}
          />
        )
      })}
      {perServer === 1 &&
        points.map((p) => {
          const [x, y] = at(R + 22, p.pos)
          return (
            <text key={p.server} x={x} y={y + 4} textAnchor="middle" fontSize={13} fontWeight={600} fill={colorOf(p.server)}>
              {p.server}
            </text>
          )
        })}
      {KEYS.map((k) => {
        const [x, y] = at(R - 22, keyPos.get(k)!)
        const moved = change?.moved.has(k)
        return (
          <circle
            key={moved ? `${k}-${change!.id}` : k}
            cx={x}
            cy={y}
            r={moved ? 3.6 : 2.8}
            fill={colorOf(owners.get(k)!)}
            stroke={moved ? 'var(--ink)' : 'none'}
            strokeWidth={1.3}
            className={moved ? 'ring-moved' : undefined}
          />
        )
      })}
      <text x={C} y={C - 2} textAnchor="middle" fontSize={15} fontWeight={600} fill="var(--ink)">
        {KEYS.length} keys
      </text>
      <text x={C} y={C + 16} textAnchor="middle" fontSize={11.5} fill="var(--muted)">
        {points.length} {points.length === 1 ? 'point' : 'points'} on the ring
      </text>
    </svg>
  )
}
