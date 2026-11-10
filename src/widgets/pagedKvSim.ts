// The simulation behind the "Paged KV allocator" widget (PagedKvAllocator.tsx), kept free of React so that
// tests/pagedKvSim.test.ts can check it. A pool of KV slots serves a fixed list of requests, one step at a time,
// under one of two policies:
//
//   reserve  Each sequence gets one contiguous region of prompt + MAX_TOKENS slots when it starts, the way servers
//            did before PagedAttention. Nothing grows, so nothing is ever preempted, but most of each region sits
//            empty and the free space breaks into holes that a new request may not fit in.
//   paged    Slots come in blocks taken from a free list as a sequence grows, so its blocks can be anywhere. When a
//            running sequence needs a block and none is free, the most recently admitted sequence is preempted:
//            its blocks are freed and it waits at the front of the queue to recompute its tokens.
//
// Each step, every running sequence writes one token (a decode), and newly admitted sequences write their whole
// prompt at once (prefill is not chunked here) and sample their first token. With two samples per request, a
// request's second sequence forks from the first after the prompt: in paged mode the two share the prompt's blocks
// (reference count 2) and the partly full last block is copied when one of them writes to it (copy-on-write).

export const POOL = 128 // KV slots, one per token
export const MAX_TOKENS = 24 // the most output tokens any request may ask for

export type Mode = 'reserve' | 'paged'
export type Req = { arrive: number; prompt: number; out: number }

// Ten requests: when each arrives, its prompt length, and how many tokens it turns out to generate (at most MAX_TOKENS).
export const REQUESTS: Req[] = [
  { arrive: 0, prompt: 10, out: 14 },
  { arrive: 0, prompt: 6, out: 20 },
  { arrive: 1, prompt: 14, out: 6 },
  { arrive: 2, prompt: 8, out: 22 },
  { arrive: 3, prompt: 12, out: 10 },
  { arrive: 4, prompt: 5, out: 18 },
  { arrive: 6, prompt: 9, out: 8 },
  { arrive: 8, prompt: 16, out: 12 },
  { arrive: 10, prompt: 7, out: 16 },
  { arrive: 12, prompt: 11, out: 9 },
]

type Seq = {
  id: number // index into the sequence list: request r's samples are 2r and 2r + 1
  req: number
  sample: number // 0 or 1
  computed: number // tokens whose keys and values are in the cache
  generated: number // output tokens sampled so far
  blocks: number[] // paged mode: block table
  start: number // reserve mode: first slot of the region, or -1
  size: number // reserve mode: region size
  state: 'future' | 'waiting' | 'running' | 'done'
  admitted: number // order of admission, for choosing whom to preempt
}

export type Slot = {
  owner: number // sequence id, or -1 when free
  used: boolean // holds a token's keys and values (otherwise allocated but empty)
  shared: number // how many sequences use this slot's block
  blockStart: boolean // first slot of a block (paged) or of a region (reserve)
}

export type Snapshot = {
  step: number
  slots: Slot[]
  running: number[]
  waiting: number[]
  finished: number // requests whose every sample is done
  used: number // slots holding keys and values
  allocated: number // slots handed out (used or not)
  preemptions: number
  recomputed: number // tokens recomputed after preemption, in total
  copies: number // copy-on-write block copies, in total
  events: string[]
}

export const label = (seqId: number, samples: number) =>
  String.fromCharCode(65 + Math.floor(seqId / 2)) + (samples === 2 ? String(1 + (seqId % 2)) : '')

export function simulate(mode: Mode, blockSize: number, samples: 1 | 2): Snapshot[] {
  const numBlocks = POOL / blockSize
  const free: number[] = Array.from({ length: numBlocks }, (_, i) => i)
  const ref: number[] = Array(numBlocks).fill(0)
  const region: number[] = Array(POOL).fill(-1) // reserve mode: owner of each slot
  const seqs: Seq[] = REQUESTS.flatMap((_, r) =>
    [0, 1].map((s) => ({ id: 2 * r + s, req: r, sample: s, computed: 0, generated: 0, blocks: [], start: -1, size: 0, state: 'future' as Seq['state'], admitted: -1 })),
  )
  const active = seqs.filter((s) => s.sample < samples)
  const waiting: Seq[] = []
  let running: Seq[] = []
  let admissions = 0
  let preemptions = 0
  let recomputed = 0
  let copies = 0
  const snaps: Snapshot[] = [snapshot(0, [])]
  const L = (s: Seq) => label(s.id, samples)

  function take(): number {
    const b = free.shift()!
    ref[b] = 1
    return b
  }
  function release(s: Seq) {
    if (mode === 'paged') {
      for (const b of s.blocks) if (--ref[b] === 0) free.push(b)
      s.blocks = []
    } else {
      for (let i = s.start; i < s.start + s.size; i++) region[i] = -1
      s.start = -1
    }
  }
  function finish(s: Seq) {
    s.state = 'done'
    release(s)
    running = running.filter((x) => x !== s)
  }
  function preempt(s: Seq, events: string[]) {
    release(s)
    running = running.filter((x) => x !== s)
    s.state = 'waiting'
    recomputed += s.computed
    events.push(`No block was free, so ${L(s)}, the most recently admitted, was preempted: its blocks went back to the pool and it will recompute its ${s.computed} tokens.`)
    s.computed = 0
    preemptions++
    waiting.unshift(s)
  }
  function firstFit(size: number): number {
    for (let i = 0, run = 0; i < POOL; i++) {
      run = region[i] === -1 ? run + 1 : 0
      if (run === size) return i - size + 1
    }
    return -1
  }

  for (let step = 1; step <= 300; step++) {
    const events: string[] = []
    for (const s of active) {
      if (s.state === 'future' && s.sample === 0 && REQUESTS[s.req].arrive < step) {
        s.state = 'waiting'
        waiting.push(s)
      }
    }

    // 1. Every running sequence writes the token it sampled last step.
    let preempted = false
    for (const s of [...running]) {
      if (s.state !== 'running') continue
      if (mode === 'paged') {
        const last = s.blocks[s.blocks.length - 1]
        const cow = s.computed % blockSize !== 0 && ref[last] > 1
        const need = (s.computed % blockSize === 0 ? 1 : 0) + (cow ? 1 : 0)
        while (free.length < need && s.state === 'running') {
          preempt(running[running.length - 1], events)
          preempted = true
        }
        if (s.state !== 'running') continue
        if (cow) {
          ref[last]--
          s.blocks[s.blocks.length - 1] = take()
          copies++
          events.push(`${L(s)} was about to write into a block it shares, so it got its own copy first (copy-on-write).`)
        }
        if (s.computed % blockSize === 0) s.blocks.push(take())
      }
      s.computed++
      s.generated++
      if (s.generated >= REQUESTS[s.req].out) finish(s)
    }

    // 2. Admit waiting sequences in order while they fit, unless memory was short this step.
    while (waiting.length && !preempted) {
      const s = waiting[0]
      const tokens = REQUESTS[s.req].prompt + s.generated
      if (mode === 'paged') {
        const need = Math.ceil(tokens / blockSize)
        if (free.length < need) break
        s.blocks = Array.from({ length: need }, take)
      } else {
        const size = REQUESTS[s.req].prompt + MAX_TOKENS
        const start = firstFit(size)
        if (start < 0) {
          const freeSlots = region.filter((o) => o === -1).length
          if (freeSlots >= size)
            events.push(`${L(s)} needs ${size} slots in a row. ${freeSlots} slots are free, but split into holes, so it must wait: external fragmentation.`)
          break
        }
        for (let i = start; i < start + size; i++) region[i] = s.id
        s.start = start
        s.size = size
      }
      waiting.shift()
      s.state = 'running'
      s.admitted = admissions++
      s.computed = tokens
      s.generated++
      running.push(s)
      if (samples === 2 && s.sample === 0 && s.generated === 1) {
        // The second sample forks from the first once the prompt is in the cache.
        const c = seqs[s.id + 1]
        c.state = 'running'
        c.admitted = admissions++
        c.computed = tokens
        c.generated = 1
        if (mode === 'paged') {
          c.blocks = [...s.blocks]
          for (const b of c.blocks) ref[b]++
        } else {
          const size = REQUESTS[s.req].prompt + MAX_TOKENS
          const start = firstFit(size)
          if (start < 0) {
            c.state = 'waiting' // no room for its own region: it waits and will compute the prompt itself
            c.computed = 0
            c.generated = 0
            waiting.unshift(c)
            break
          }
          for (let i = start; i < start + size; i++) region[i] = c.id
          c.start = start
          c.size = size
        }
        running.push(c)
      }
    }
    snaps.push(snapshot(step, events))
    if (active.every((s) => s.state === 'done')) break
  }
  return snaps

  function snapshot(step: number, events: string[]): Snapshot {
    const slots: Slot[] = Array.from({ length: POOL }, () => ({ owner: -1, used: false, shared: 0, blockStart: false }))
    for (const s of running) {
      if (mode === 'paged') {
        s.blocks.forEach((b, i) => {
          for (let k = 0; k < blockSize; k++) {
            const slot = slots[b * blockSize + k]
            slot.owner = s.id
            slot.shared = ref[b]
            slot.blockStart = k === 0
            if (i * blockSize + k < s.computed) slot.used = true
          }
        })
      } else {
        for (let k = 0; k < s.size; k++) {
          const slot = slots[s.start + k]
          slot.owner = s.id
          slot.shared = 1
          slot.blockStart = k === 0
          slot.used = k < s.computed
        }
      }
    }
    const allocated = slots.filter((x) => x.owner >= 0).length
    const used = slots.filter((x) => x.used).length
    const finished = REQUESTS.filter((_, r) => active.filter((s) => s.req === r).every((s) => s.state === 'done')).length
    return {
      step,
      slots,
      running: running.map((s) => s.id),
      waiting: waiting.map((s) => s.id),
      finished,
      used,
      allocated,
      preemptions,
      recomputed,
      copies,
      events,
    }
  }
}
