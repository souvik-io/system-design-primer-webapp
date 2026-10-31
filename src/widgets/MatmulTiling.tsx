import { useEffect, useMemo, useState } from 'react'
import { Pause, Play, SkipForward } from 'lucide-react'
import { Button, IndexSlider, Narration, Segmented, Stat, WidgetFrame, useReducedMotion } from './ui'

// One 8,192 x 8,192 x 8,192 BF16 matmul, computed tile by tile (content/infra/triton-kernels.md).
// Each program computes one BM x BN output tile and reads a BM-row panel of A and a BN-column panel of B.
// The GPU runs one program per SM at a time: a wave. This is the wave model of tiling_traffic.py: programs in
// a wave move along K together, so a panel that several of them need is read from memory once.
// Tile order follows Triton's matmul tutorial: GROUP_M = 1 is row-major, GROUP_M = 8 walks 8 rows at a time.
// GPU figures: SM counts measured with gpu_probe.py on Modal (H100, A10); dense BF16 peaks and bandwidth from
// NVIDIA's specification pages.

const N = 8192
const BYTES = 2
type GpuId = 'h100' | 'a10'
const GPUS: Record<GpuId, { name: string; sms: number; peak: number; bw: number }> = {
  h100: { name: 'H100', sms: 132, peak: 989e12, bw: 3.35e12 },
  a10: { name: 'A10', sms: 72, peak: 125e12, bw: 600e9 },
}
const TILES = [
  { bm: 128, bn: 128, label: '128 x 128' },
  { bm: 128, bn: 256, label: '128 x 256' },
]

function order(numM: number, numN: number, group: number) {
  const tiles: [number, number][] = []
  for (let pid = 0; pid < numM * numN; pid++) {
    const g = Math.floor(pid / (group * numN))
    const first = g * group
    const size = Math.min(numM - first, group)
    const local = pid % (group * numN)
    tiles.push([first + (local % size), Math.floor(local / size)])
  }
  return tiles
}

function perWave(tiles: [number, number][], sms: number, bm: number, bn: number) {
  const waves = Math.ceil(tiles.length / sms)
  return Array.from({ length: waves }, (_, i) => {
    const slice = tiles.slice(i * sms, (i + 1) * sms)
    const rows = new Set(slice.map(([m]) => m)).size
    const cols = new Set(slice.map(([, n]) => n)).size
    return { rows, cols, bytes: (rows * bm + cols * bn) * N * BYTES }
  })
}

export default function MatmulTiling() {
  const [gpuId, setGpuId] = useState<GpuId>('h100')
  const [tileIndex, setTileIndex] = useState(1)
  const [group, setGroup] = useState(1)
  const [wave, setWave] = useState(0)
  const [playing, setPlaying] = useState(false)
  const reduced = useReducedMotion()

  const gpu = GPUS[gpuId]
  const { bm, bn } = TILES[tileIndex]
  const numM = N / bm
  const numN = N / bn
  const tiles = useMemo(() => order(numM, numN, group), [numM, numN, group])
  const waves = Math.ceil(tiles.length / gpu.sms)
  const w = Math.min(wave, waves - 1)

  const waveBytes = useMemo(() => perWave(tiles, gpu.sms, bm, bn), [tiles, gpu.sms, bm, bn])
  const total = waveBytes.reduce((s, x) => s + x.bytes, 0)
  // The row-major total, to say whether grouping is what keeps the matmul compute-bound.
  const rowMajorTotal = useMemo(() => perWave(order(numM, numN, 1), gpu.sms, bm, bn).reduce((s, x) => s + x.bytes, 0), [numM, numN, gpu.sms, bm, bn])
  const rowMajorMs = (rowMajorTotal / gpu.bw) * 1e3
  const tilesThisWave = Math.min(gpu.sms, tiles.length - w * gpu.sms)
  const soFar = waveBytes.slice(0, w + 1).reduce((s, x) => s + x.bytes, 0)
  const current = waveBytes[w]
  const flops = 2 * N ** 3
  const computeMs = (flops / gpu.peak) * 1e3
  const memoryMs = (total / gpu.bw) * 1e3
  const noReuse = (bm * bn) / (bm + bn)

  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => setWave((x) => (x + 1 >= waves ? 0 : x + 1)), reduced ? 900 : 450)
    return () => clearInterval(id)
  }, [playing, waves, reduced])

  const activeRows = new Set(tiles.slice(w * gpu.sms, (w + 1) * gpu.sms).map(([m]) => m))
  const activeCols = new Set(tiles.slice(w * gpu.sms, (w + 1) * gpu.sms).map(([, n]) => n))

  // Geometry: B panels across the top, A panels down the left, C in the middle.
  const W = 640
  const strip = 14
  const gap = 6
  const gridW = W - strip - gap
  const cell = gridW / numN
  const gridH = cell * numM * (bm / bn) // keep tiles to scale: a tile is bm tall and bn wide
  const rowH = gridH / numM
  const H = strip + gap + gridH

  return (
    <WidgetFrame
      title="Try it: tile order and memory traffic"
      description="One 8,192-square BF16 matmul, split into output tiles. Each wave runs one tile per SM; highlighted strips are the panels of A and B that wave must read. Compare row-major order with grouped order on each GPU."
    >
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <Segmented
            label="GPU"
            value={gpuId}
            options={(Object.keys(GPUS) as GpuId[]).map((id) => ({ value: id, label: `${GPUS[id].name} (${GPUS[id].sms} SMs)` }))}
            onChange={(v) => (setGpuId(v), setWave(0))}
          />
          <Segmented
            label="Tile"
            value={tileIndex}
            options={TILES.map((t, i) => ({ value: i, label: t.label }))}
            onChange={(v) => (setTileIndex(v), setWave(0))}
          />
          <Segmented
            label="Order"
            value={group}
            options={[
              { value: 1, label: 'Row-major' },
              { value: 8, label: 'Grouped, 8 rows' },
            ]}
            onChange={(v) => (setGroup(v), setWave(0))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <IndexSlider label="Wave" index={w} max={waves - 1} onChange={(i) => (setWave(i), setPlaying(false))} text={`${w + 1} of ${waves}`} />
          <Button onClick={() => setPlaying((p) => !p)} pressed={playing}>
            {playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />} {playing ? 'Pause' : 'Play'}
          </Button>
          <Button onClick={() => (setWave((x) => (x + 1 >= waves ? 0 : x + 1)), setPlaying(false))}>
            <SkipForward size={14} aria-hidden /> Next wave
          </Button>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Wave ${w + 1}: ${current.rows} row panels of A and ${current.cols} column panels of B`}
      >
        {Array.from({ length: numN }, (_, n) => (
          <rect
            key={`b${n}`}
            x={strip + gap + n * cell + 0.5}
            y={0}
            width={cell - 1}
            height={strip}
            fill={activeCols.has(n) ? 'var(--w3)' : 'var(--paper)'}
            stroke="var(--rule)"
            strokeWidth={0.5}
          />
        ))}
        {Array.from({ length: numM }, (_, m) => (
          <rect
            key={`a${m}`}
            x={0}
            y={strip + gap + m * rowH + 0.5}
            width={strip}
            height={Math.max(rowH - 1, 0.5)}
            fill={activeRows.has(m) ? 'var(--w4)' : 'var(--paper)'}
            stroke="var(--rule)"
            strokeWidth={0.5}
          />
        ))}
        {tiles.map(([m, n], i) => {
          const tw = Math.floor(i / gpu.sms)
          const fill = tw === w ? 'var(--w1)' : tw < w ? 'var(--accent-soft)' : 'var(--surface)'
          return (
            <rect
              key={`${m},${n}`}
              x={strip + gap + n * cell + 0.5}
              y={strip + gap + m * rowH + 0.5}
              width={cell - 1}
              height={Math.max(rowH - 1, 0.5)}
              fill={fill}
              stroke="var(--rule)"
              strokeWidth={0.4}
            />
          )
        })}
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 text-[0.75rem] text-muted">
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm align-middle" style={{ background: 'var(--w1)' }} />
          tiles in this wave
        </span>
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm align-middle" style={{ background: 'var(--w4)' }} />
          row panels of A it reads
        </span>
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm align-middle" style={{ background: 'var(--w3)' }} />
          column panels of B it reads
        </span>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="This wave reads" value={`${current.rows} A + ${current.cols} B panels`} />
        <Stat label="Read so far / whole matmul" value={`${(soFar / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB`} />
        <Stat
          label="Memory time vs compute time"
          value={`${memoryMs.toFixed(2)} vs ${computeMs.toFixed(2)} ms`}
          tone={memoryMs > computeMs ? 'bad' : 'good'}
        />
        <Stat label="Per tile, no sharing" value={`${noReuse.toFixed(0)} FLOPs/byte`} />
      </div>

      <Narration tone={memoryMs > computeMs ? 'bad' : undefined}>
        {`Each wave runs one tile per SM, ${gpu.sms} at most, and this wave runs ${tilesThisWave}. In ${group === 1 ? 'row-major order' : 'grouped order'} it covers ${current.rows} rows and ${current.cols} columns of tiles, so it reads ${current.rows} panels of A and ${current.cols} of B, each ${N.toLocaleString()} deep. `}
        {memoryMs > computeMs
          ? `Over the whole matmul that is ${(total / 1e9).toFixed(1)} GB, ${memoryMs.toFixed(1)} ms at the ${gpu.name}'s ${gpu.bw / 1e9 >= 1000 ? `${gpu.bw / 1e12} TB/s` : `${gpu.bw / 1e9} GB/s`}, longer than the ${computeMs.toFixed(1)} ms of arithmetic: this order makes the matmul memory-bound. Grouped order makes each wave squarer, so it shares more panels.`
          : group !== 1 && rowMajorMs > computeMs
            ? `Over the whole matmul that is ${(total / 1e9).toFixed(2)} GB, ${memoryMs.toFixed(2)} ms of memory time against ${computeMs.toFixed(2)} ms of arithmetic, so grouped order keeps the matmul compute-bound. Row-major order would read ${(rowMajorTotal / 1e9).toFixed(1)} GB and need ${rowMajorMs.toFixed(1)} ms, longer than the arithmetic.`
            : `Over the whole matmul that is ${(total / 1e9).toFixed(2)} GB, ${memoryMs.toFixed(2)} ms of memory time against ${computeMs.toFixed(2)} ms of arithmetic, so the matmul stays compute-bound in either order and the order matters little.`}
      </Narration>
    </WidgetFrame>
  )
}
