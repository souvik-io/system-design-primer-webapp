import { useState } from 'react'
import { IndexSlider, Narration, Segmented, Stat, WidgetFrame } from './ui'

// How many warps of one kernel fit on an SM at once (content/infra/gpu-execution.md). Each block needs
// registers, shared memory and a block slot; the scarcest of the four limits sets how many blocks are
// resident. Occupancy = active warps / maximum warps per SM (CUDA C++ Best Practices Guide).
//
// Limits: Hopper tuning guide (compute capability 9.0: 64 warps, 32 blocks, 64K registers, 228 KB shared memory
// per SM, 227 KB per block) and Ada tuning guide (8.9: 48 warps, 24 blocks, 64K registers, 100 KB per SM,
// 99 KB per block). The gpu_probe.py run on Modal printed the same register and shared memory figures.
// CUDA also reserves 1 KB of shared memory per block on these GPUs (Ampere and Hopper tuning guides;
// cudaDevAttrReservedSharedMemoryPerBlock), which is why 227 KB is the per-block maximum against 228 KB per SM.
// Real allocation also rounds registers and shared memory up to hardware granules, so true occupancy can be a
// little lower than this estimate.

type GpuId = 'h100' | 'l4'
const GPUS: Record<GpuId, { name: string; warps: number; blocks: number; regs: number; smem: number; smemBlock: number }> = {
  h100: { name: 'H100 (9.0)', warps: 64, blocks: 32, regs: 65536, smem: 228, smemBlock: 227 },
  l4: { name: 'L4 (8.9)', warps: 48, blocks: 24, regs: 65536, smem: 100, smemBlock: 99 },
}
const RESERVED = 1 // KB of shared memory CUDA reserves for each block
const THREADS = [32, 64, 128, 256, 512, 1024]
const REGS = [16, 24, 32, 40, 48, 64, 96, 128, 168, 255]
const SMEM = [0, 4, 8, 16, 32, 48, 64, 96, 128, 164, 227]

export default function Occupancy() {
  const [gpuId, setGpuId] = useState<GpuId>('h100')
  const [threadIndex, setThreadIndex] = useState(3)
  const [regIndex, setRegIndex] = useState(2)
  const [smemIndex, setSmemIndex] = useState(0)

  const gpu = GPUS[gpuId]
  const threads = THREADS[threadIndex]
  const regs = REGS[regIndex]
  const smem = SMEM[smemIndex]
  const warpsPerBlock = threads / 32
  const fitsBlock = smem <= gpu.smemBlock

  const limits = [
    { name: 'warp slots', blocks: Math.floor(gpu.warps / warpsPerBlock) },
    { name: 'block slots', blocks: gpu.blocks },
    { name: 'registers', blocks: Math.floor(gpu.regs / (regs * threads)) },
    { name: 'shared memory', blocks: smem === 0 ? Infinity : Math.floor(gpu.smem / (smem + RESERVED)) },
  ]
  const blocks = fitsBlock ? Math.min(...limits.map((l) => l.blocks)) : 0
  const binding = limits.filter((l) => l.blocks === blocks).map((l) => l.name)
  const warps = blocks * warpsPerBlock
  const occupancy = warps / gpu.warps

  let note: string
  if (!fitsBlock)
    note = `One block asks for ${smem} KB of shared memory, but a block on this GPU can have at most ${gpu.smemBlock} KB, so the kernel cannot launch.`
  else if (blocks === 0)
    note = `One block of ${threads} threads at ${regs} registers each needs ${(regs * threads).toLocaleString()} registers, more than the SM's ${gpu.regs.toLocaleString()}, so the kernel cannot launch with this configuration.`
  else
    note =
      `${blocks} ${blocks === 1 ? 'block fits' : 'blocks fit'} on each SM, limited by ${binding.join(' and ')}, so ${warps} of ${gpu.warps} warp slots are busy. ` +
      (occupancy >= 0.5
        ? 'That leaves the scheduler plenty of warps to switch to while others wait for memory.'
        : 'With few warps resident, the SM has less work to switch to while warps wait for memory. That hurts memory-bound kernels most; matmul kernels often run well at low occupancy because each warp keeps many loads in flight.')

  return (
    <WidgetFrame
      title="Try it: occupancy of one SM"
      description="A kernel's blocks share each SM's warp slots, block slots, registers and shared memory. Change the block size and what each thread and block uses, and see which resource runs out first."
    >
      <div className="space-y-2.5">
        <Segmented
          label="GPU"
          value={gpuId}
          options={(Object.keys(GPUS) as GpuId[]).map((id) => ({ value: id, label: GPUS[id].name }))}
          onChange={setGpuId}
        />
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <IndexSlider label="Threads per block" index={threadIndex} max={THREADS.length - 1} onChange={setThreadIndex} text={`${threads}`} />
          <IndexSlider label="Registers per thread" index={regIndex} max={REGS.length - 1} onChange={setRegIndex} text={`${regs}`} />
          <IndexSlider label="Shared memory per block" index={smemIndex} max={SMEM.length - 1} onChange={setSmemIndex} text={`${smem} KB`} />
        </div>
      </div>

      <div>
        <div className="mb-1 text-[0.75rem] text-muted">Warp slots on one SM ({gpu.warps})</div>
        <div
          className="grid gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${gpu.warps / 4}, minmax(0, 1fr))` }}
          role="img"
          aria-label={`${warps} of ${gpu.warps} warp slots used`}
        >
          {Array.from({ length: gpu.warps }, (_, i) => {
            const block = Math.floor(i / warpsPerBlock)
            const used = i < warps
            return (
              <div
                key={i}
                className="h-4 rounded-sm"
                style={{ background: used ? (block % 2 ? 'var(--w2)' : 'var(--w1)') : 'var(--paper)', border: '1px solid var(--rule)' }}
              />
            )
          })}
        </div>
        <p className="mt-1 text-[0.75rem] text-muted">Alternating colours mark blocks; empty slots are warps that could have run but did not fit.</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[26rem] border-collapse text-[0.8rem]">
          <thead>
            <tr className="text-left text-[0.75rem] text-muted">
              <th className="py-1 pr-2 font-medium">Resource</th>
              <th className="py-1 pr-2 font-medium">Per SM</th>
              <th className="py-1 pr-2 font-medium">One block uses</th>
              <th className="py-1 text-right font-medium">Blocks it allows</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['warp slots', `${gpu.warps}`, `${warpsPerBlock}`],
              ['block slots', `${gpu.blocks}`, '1'],
              ['registers', gpu.regs.toLocaleString(), (regs * threads).toLocaleString()],
              ['shared memory', `${gpu.smem} KB`, smem === 0 ? '0 KB' : `${smem} KB + 1 KB reserved`],
            ].map(([name, per, uses], i) => (
              <tr key={name} className={`border-t border-rule ${binding.includes(name) && fitsBlock ? 'font-semibold text-ink' : 'text-ink-2'}`}>
                <td className="py-1.5 pr-2">{name}</td>
                <td className="py-1.5 pr-2 tabular-nums">{per}</td>
                <td className="py-1.5 pr-2 tabular-nums">{uses}</td>
                <td className="py-1.5 text-right tabular-nums">{limits[i].blocks === Infinity ? 'no limit' : limits[i].blocks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Blocks per SM" value={blocks} tone={blocks === 0 ? 'bad' : undefined} />
        <Stat label="Active warps" value={`${warps} of ${gpu.warps}`} />
        <Stat label="Occupancy" value={`${Math.round(occupancy * 100)}%`} tone={occupancy === 0 ? 'bad' : occupancy < 0.5 ? 'warn' : 'good'} />
      </div>

      <Narration tone={blocks === 0 ? 'bad' : undefined}>{note}</Narration>
    </WidgetFrame>
  )
}
