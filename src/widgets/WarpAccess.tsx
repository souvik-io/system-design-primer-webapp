import { useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button, Narration, Segmented, Stat, WidgetFrame } from './ui'

// One warp of 32 threads issues one load each (content/infra/gpu-execution.md).
// Global memory: on compute capability 6.0 and newer, the warp's loads are served in 32-byte sectors, and the
// cost is the number of distinct sectors touched (CUDA C++ Best Practices Guide, "Coalesced Access to Global
// Memory"). Shared memory: 32 banks of 4-byte words; addresses in the same bank but different words are
// serialised, and the same word is broadcast (same guide, "Shared Memory and Memory Banks").

type Mode = 'global' | 'shared'
type Pattern = 'contiguous' | 'offset' | 'stride2' | 'stride8' | 'stride32' | 'column' | 'random' | 'broadcast'

const WARP = 32
const SECTOR = 32
const BANKS = 32

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Element index each thread reads. */
function indices(pattern: Pattern, seed: number): number[] {
  const r = rng(seed)
  return Array.from({ length: WARP }, (_, t) => {
    switch (pattern) {
      case 'contiguous':
        return t
      case 'offset':
        return t + 3
      case 'stride2':
        return 2 * t
      case 'stride8':
        return 8 * t
      case 'stride32':
        return 32 * t
      case 'column':
        return 33 * t // a column of a 32 x 33 padded tile
      case 'random':
        return Math.floor(r() * 512)
      case 'broadcast':
        return 5
    }
  })
}

const PATTERNS: { value: Pattern; label: string }[] = [
  { value: 'contiguous', label: 'Thread t reads t' },
  { value: 'offset', label: 'Shifted by 3' },
  { value: 'stride2', label: 'Stride 2' },
  { value: 'stride8', label: 'Stride 8' },
  { value: 'stride32', label: 'Stride 32' },
  { value: 'column', label: 'Stride 33' },
  { value: 'random', label: 'Random' },
  { value: 'broadcast', label: 'All read one value' },
]

export default function WarpAccess() {
  const [mode, setMode] = useState<Mode>('global')
  const [pattern, setPattern] = useState<Pattern>('contiguous')
  const [size, setSize] = useState(4)
  const [seed, setSeed] = useState(1)

  const elemBytes = mode === 'shared' ? 4 : size
  const idx = useMemo(() => indices(pattern, seed), [pattern, seed])
  const addresses = idx.map((i) => i * elemBytes)
  const useful = new Set(addresses).size * elemBytes

  // Global: distinct 32-byte sectors. Shared: worst bank's count of distinct words.
  const sectors = [...new Set(addresses.map((a) => Math.floor(a / SECTOR)))].sort((a, b) => a - b)
  const moved = sectors.length * SECTOR
  const bankWords = new Map<number, Set<number>>()
  for (const a of addresses) {
    const word = a / 4
    const bank = word % BANKS
    if (!bankWords.has(bank)) bankWords.set(bank, new Set())
    bankWords.get(bank)!.add(word)
  }
  const ways = Math.max(...[...bankWords.values()].map((s) => s.size))

  // Drawing: the span of memory the warp touches, one cell per 4 bytes, grouped into sectors or bank rows.
  const W = 640
  const minSector = Math.min(...sectors)
  const maxSector = Math.max(...sectors)
  const shownSectors = Math.min(maxSector - minSector + 1, 64)
  const touched = new Set(sectors)

  let note: string
  if (mode === 'global') {
    const eff = useful / moved
    note =
      sectors.length <= Math.ceil((WARP * elemBytes) / SECTOR)
        ? `The warp needs ${useful} bytes and the hardware moves ${moved}, in ${sectors.length} sectors of 32 bytes: every byte fetched is used. This is a coalesced access, and it is the pattern every fast kernel aims for.`
        : `The warp needs ${useful} bytes but touches ${sectors.length} different 32-byte sectors, so the hardware moves ${moved} bytes and ${Math.round(eff * 100)}% of them are used. A kernel with this pattern can reach at most about that share of the memory bandwidth.`
    if (pattern === 'broadcast') note = `All 32 threads read the same ${elemBytes}-byte value, so one sector serves the whole warp.`
  } else {
    note =
      ways === 1
        ? `Every thread reads a different bank, or threads that share a bank read the same word, which is broadcast. The warp's load finishes in one pass.`
        : `${ways} threads read different words in the same bank, so the hardware splits the load into ${ways} passes: a ${ways}-way bank conflict. ${pattern === 'stride32' ? 'Reading a column of a 32 x 32 tile does exactly this; padding each row to 33 words (try "Stride 33") moves every element of the column to a different bank.' : ''}`
  }

  return (
    <WidgetFrame
      title="Try it: one warp's memory access"
      description="All 32 threads of a warp issue one load at the same time. Pick which element each thread reads and see how many 32-byte sectors the hardware moves from global memory, or how many passes shared memory needs because of bank conflicts."
    >
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <Segmented
            label="Memory"
            value={mode}
            options={[
              { value: 'global', label: 'Global memory (HBM)' },
              { value: 'shared', label: 'Shared memory' },
            ]}
            onChange={setMode}
          />
          {mode === 'global' && (
            <Segmented
              label="Element size"
              value={size}
              options={[
                { value: 2, label: '2 bytes (BF16)' },
                { value: 4, label: '4 bytes (FP32)' },
                { value: 8, label: '8 bytes' },
              ]}
              onChange={setSize}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Segmented label="Access pattern" value={pattern} options={PATTERNS} onChange={setPattern} />
          {pattern === 'random' && (
            <Button onClick={() => setSeed((s) => s + 1)} title="Draw new random addresses">
              <RefreshCw size={14} aria-hidden /> New addresses
            </Button>
          )}
        </div>
      </div>

      {mode === 'global' ? (
        <svg
          viewBox={`0 0 ${W} 120`}
          className="h-auto w-full"
          role="img"
          aria-label={`${sectors.length} sectors touched, ${moved} bytes moved for ${useful} useful bytes`}
        >
          <text x={0} y={12} fontSize={11.5} fill="var(--ink-2)">
            Memory from sector {minSector} to {minSector + shownSectors - 1}
            {maxSector - minSector + 1 > shownSectors ? ` (${maxSector - minSector + 1 - shownSectors} more sectors not shown)` : ''}
          </text>
          {Array.from({ length: shownSectors }, (_, s) => {
            const sector = minSector + s
            const w = W / Math.max(shownSectors, 8)
            const x = s * w
            const hit = touched.has(sector)
            // 4-byte slots of this sector covered by any thread's element (an 8-byte element covers two).
            const usedWords = new Set(
              addresses.flatMap((a) =>
                Array.from({ length: Math.max(1, elemBytes / 4) }, (_, k) => a + 4 * k)
                  .filter((b) => Math.floor(b / SECTOR) === sector)
                  .map((b) => Math.floor((b % SECTOR) / 4)),
              ),
            )
            return (
              <g key={sector}>
                <rect
                  x={x + 1}
                  y={24}
                  width={w - 2}
                  height={40}
                  rx={3}
                  fill={hit ? 'var(--accent-soft)' : 'transparent'}
                  stroke={hit ? 'var(--w1)' : 'var(--rule)'}
                />
                {Array.from({ length: 8 }, (_, k) => (
                  <rect
                    key={k}
                    x={x + 3 + (k * (w - 6)) / 8}
                    y={30}
                    width={Math.max(0.5, (w - 6) / 8 - 1)}
                    height={28}
                    fill={usedWords.has(k) ? 'var(--w1)' : hit ? 'var(--rule)' : 'transparent'}
                  />
                ))}
              </g>
            )
          })}
          <text x={0} y={84} fontSize={11.5} fill="var(--muted)">
            Each box is one 32-byte sector of eight 4-byte slots; a filled slot holds data a thread asked for.
          </text>
          <text x={0} y={104} fontSize={11.5} fill="var(--muted)">
            Outlined sectors are fetched in full, whether or not every slot is used.
          </text>
        </svg>
      ) : (
        <svg
          viewBox={`0 0 ${W} 110`}
          className="h-auto w-full"
          role="img"
          aria-label={`Shared memory banks: worst bank serves ${ways} different words`}
        >
          <text x={0} y={12} fontSize={11.5} fill="var(--ink-2)">
            32 banks; each column is one bank, and each dot is a different 4-byte word asked of it (at most 8 drawn)
          </text>
          {Array.from({ length: BANKS }, (_, b) => {
            const words = [...(bankWords.get(b) ?? [])]
            const w = W / BANKS
            return (
              <g key={b}>
                <rect
                  x={b * w + 1}
                  y={22}
                  width={w - 2}
                  height={66}
                  rx={2}
                  fill={words.length > 1 ? 'var(--bad-soft)' : 'transparent'}
                  stroke="var(--rule)"
                />
                {words.slice(0, 8).map((_, k) => (
                  <circle key={k} cx={b * w + w / 2} cy={30 + k * 7.5} r={3} fill={words.length > 1 ? 'var(--bad)' : 'var(--w1)'} />
                ))}
                {b % 4 === 0 && (
                  <text x={b * w + w / 2} y={104} textAnchor="middle" fontSize={10} fill="var(--muted)">
                    {b}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Bytes the warp needs" value={useful} />
        {mode === 'global' ? (
          <>
            <Stat label="32-byte sectors moved" value={sectors.length} />
            <Stat label="Bytes moved" value={moved} />
            <Stat
              label="Useful share"
              value={pattern === 'broadcast' ? 'one sector for all' : `${+((useful / moved) * 100).toFixed(1)}%`}
              tone={pattern === 'broadcast' ? 'good' : useful / moved < 0.5 ? 'bad' : useful / moved < 0.9 ? 'warn' : 'good'}
            />
          </>
        ) : (
          <>
            <Stat label="Banks used" value={bankWords.size} />
            <Stat label="Passes needed" value={ways} tone={ways > 1 ? 'bad' : 'good'} />
            <Stat label="Conflict" value={ways > 1 ? `${ways}-way` : 'none'} tone={ways > 1 ? 'bad' : 'good'} />
          </>
        )}
      </div>

      <Narration tone={mode === 'global' ? (useful / moved < 0.5 && pattern !== 'broadcast' ? 'bad' : undefined) : ways > 1 ? 'bad' : undefined}>
        {note}
      </Narration>
    </WidgetFrame>
  )
}
