import { useState } from 'react'
import { RotateCcw, SkipForward, Trash2 } from 'lucide-react'
import { Button, Key, Narration, Segmented, Stat, WidgetFrame } from './ui'

// PyTorch's CUDA caching allocator on a "growing batch" pattern (content/infra/pytorch-execution.md), the same
// pattern as part 3 of decode_runtime.py: 16 tensors, each allocated and freed before the next, from 256 MiB up to
// 736 MiB in steps of 32 MiB. A freed block stays cached in its segment. By default each large request that fits
// no cached block gets a new segment from cudaMalloc, so the cached segments pile up; with expandable_segments the
// allocator maps more memory onto the end of one segment instead, in pages of large_segment_size (20 MiB,
// c10/core/AllocatorConfig.h), so the 736 MiB tensor needs 37 pages. The lab measured 7,936 MiB and 740 MiB reserved.

const SIZES = Array.from({ length: 16 }, (_, i) => 256 + 32 * i)
const page = (mib: number) => Math.ceil(mib / 20) * 20 // expandable segments map memory in 20 MiB pages
type Mode = 'default' | 'expandable'

export default function CachingAllocator() {
  const [mode, setMode] = useState<Mode>('default')
  const [step, setStep] = useState(0) // tensors allocated so far (the last one is still alive)
  const [cut, setCut] = useState(0) // the step at which empty_cache() was last called, or 0

  const emptied = cut > 0 && cut === step
  const live = step > 0 ? SIZES[step - 1] : 0
  // Default: one segment per request since the last empty_cache(), which kept only the live tensor's segment.
  // Expandable: one segment, mapped in 20 MiB pages up to the largest tensor (the sizes only grow).
  const segments = mode === 'default' ? SIZES.slice(Math.max(cut - 1, 0), step) : step ? [page(live)] : []
  const reserved = segments.reduce((a, b) => a + b, 0)

  const W = 640
  const SCALE = (W - 16) / 7936
  let cursor = 8

  return (
    <WidgetFrame
      title="Try it: the caching allocator and a growing batch"
      description="PyTorch keeps freed GPU memory in a cache instead of returning it to the driver. Allocate tensors that grow by 32 MiB each, freeing each one before the next, and watch what the allocator reserves."
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Segmented
          label="Allocator setting"
          value={mode}
          options={[
            { value: 'default', label: 'Default' },
            { value: 'expandable', label: 'expandable_segments:True' },
          ]}
          onChange={(m) => (setMode(m), setStep(0), setCut(0))}
        />
        <Button tone="primary" disabled={step >= SIZES.length} onClick={() => setStep((s) => s + 1)}>
          <SkipForward size={14} aria-hidden />{' '}
          {step === 0 ? `Allocate ${SIZES[0]} MiB` : step < SIZES.length ? `Free the last tensor, allocate ${SIZES[step]} MiB` : 'All 16 allocated'}
        </Button>
        <Button disabled={step === 0 || emptied} onClick={() => setCut(step)}>
          <Trash2 size={14} aria-hidden /> empty_cache()
        </Button>
        <Button onClick={() => (setStep(0), setCut(0))}>
          <RotateCcw size={14} aria-hidden /> Start again
        </Button>
      </div>

      <svg viewBox={`0 0 ${W} 64`} className="h-auto w-full" role="img" aria-label={`${segments.length} segments, ${reserved} MiB reserved`}>
        <rect x={8} y={14} width={W - 16} height={30} fill="none" stroke="var(--rule)" strokeDasharray="3 3" />
        {segments.map((s, i) => {
          const x0 = cursor
          cursor += s * SCALE
          const isLive = i === segments.length - 1 && live > 0
          const used = isLive ? live * SCALE : 0
          return (
            <g key={i}>
              <rect x={x0} y={14} width={s * SCALE} height={30} fill="var(--muted)" opacity={0.3} stroke="var(--surface)" />
              {isLive && <rect x={x0} y={14} width={used} height={30} fill="var(--w1)" stroke="var(--surface)" />}
            </g>
          )
        })}
        <text x={8} y={58} fontSize={10} fill="var(--muted)">
          0
        </text>
        <text x={W - 8} y={58} textAnchor="end" fontSize={10} fill="var(--muted)">
          7,936 MiB
        </text>
      </svg>
      <p className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <Key color="var(--w1)">in use by the live tensor</Key>
        <Key color="var(--muted)">reserved, cached and free</Key>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Allocated (in use)" value={`${live} MiB`} />
        <Stat
          label="Reserved (memory_reserved)"
          value={`${reserved.toLocaleString()} MiB`}
          tone={reserved > 2 * Math.max(live, 1) ? 'bad' : undefined}
        />
        <Stat label="Segments" value={segments.length} />
        <Stat label="Reserved per MiB in use" value={live ? `${(reserved / live).toFixed(1)}×` : '—'} />
      </div>

      <Narration tone={emptied && mode === 'default' ? 'good' : step > 2 && mode === 'default' ? 'bad' : undefined}>
        {step === 0
          ? 'Nothing allocated yet. Each step frees the previous tensor and allocates one 32 MiB larger, as a batch that grows a little at a time would.'
          : emptied && mode === 'expandable'
            ? `With expandable segments, the only memory reserved is the ${page(live)} MiB of pages under the live tensor, so empty_cache() has nothing to return.`
            : emptied
              ? `empty_cache() returned every cached segment that holds no live tensor to the driver, leaving ${live} MiB reserved for the live tensor. The next allocations will call cudaMalloc again, which is slow, so serving engines avoid this in the hot path.`
              : mode === 'default'
                ? step === 1
                  ? 'The first tensor gets a 256 MiB segment from cudaMalloc.'
                  : `The freed segments are all smaller than ${live} MiB, so none can hold the new tensor and the allocator asks the driver for another segment. ${reserved.toLocaleString()} MiB are now reserved for a ${live} MiB tensor; nvidia-smi shows all of it as used.`
                : step === 1
                  ? 'The first tensor gets memory mapped into one expandable segment.'
                  : `The freed block sits at the end of the one segment, so the allocator maps ${page(live) - page(SIZES[step - 2])} MiB more onto it, in 20 MiB pages, and reuses the rest. Reserved memory stays at the largest tensor rounded up to whole pages: ${page(live)} MiB.`}
      </Narration>
    </WidgetFrame>
  )
}
