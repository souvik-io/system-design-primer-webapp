// The model behind the speculation simulator (chapter 5.4). A target pass over n tokens takes `fixed + perToken * n`
// milliseconds: the fixed part is reading the weights once, which a pass pays whatever it holds, and the per-token
// part is the arithmetic. Without speculation a step holds one token per request. With k draft tokens it holds
// k + 1 per request, and the drafter adds `draftMs` for each of its k steps. Each draft token is accepted with
// probability alpha, independently, so a pass emits (1 - alpha^(k+1)) / (1 - alpha) tokens on average (Leviathan
// et al., Equation 1). public/labs/infra/spec_decode_sim.py checks the same formulas by simulation, and the
// presets in SpeculationSimulator.tsx are fitted to public/labs/infra/gpu/spec_decode_bench.py's measurements.

export type Gpu = {
  name: string
  /** Milliseconds a pass takes however few tokens it holds. */
  fixed: number
  /** Milliseconds each token in the pass adds. */
  perToken: number
}

/** Expected tokens a target pass emits: the accepted draft tokens and one of its own. */
export function expectedTokens(alpha: number, k: number): number {
  if (k <= 0) return 1
  if (alpha >= 1) return k + 1
  return (1 - alpha ** (k + 1)) / (1 - alpha)
}

export type Pass = {
  /** Milliseconds for a pass without speculation. */
  plain: number
  /** Milliseconds for the target to verify k draft tokens and compute one more, per request. */
  verify: number
  /** Milliseconds the drafter takes. */
  draft: number
  /** Tokens emitted per request per pass. */
  tokens: number
  /** Tokens per second for the whole batch, without and with speculation. */
  plainRate: number
  specRate: number
  speedup: number
  /** The share of the positions the target computed that were thrown away. */
  wasted: number
}

/** One round at a batch size. `draftMs` is the time of one drafter step for the whole batch. */
export function pass(gpu: Gpu, batch: number, alpha: number, k: number, draftMs: number): Pass {
  const plain = gpu.fixed + gpu.perToken * batch
  const verify = gpu.fixed + gpu.perToken * batch * (k + 1)
  const draft = k * draftMs
  const tokens = expectedTokens(alpha, k)
  const plainRate = (batch / plain) * 1000
  const specRate = ((batch * tokens) / (verify + draft)) * 1000
  return { plain, verify, draft, tokens, plainRate, specRate, speedup: specRate / plainRate, wasted: 1 - tokens / (k + 1) }
}

/** The largest batch size, among those given, at which speculation is still faster; 0 if none. */
export function breakEven(gpu: Gpu, batches: number[], alpha: number, k: number, draftMs: number): number {
  let best = 0
  for (const b of batches) if (pass(gpu, b, alpha, k, draftMs).speedup > 1) best = Math.max(best, b)
  return best
}

/** The draft length, from 1 to maxK, with the highest speed-up. */
export function bestK(gpu: Gpu, batch: number, alpha: number, draftMs: number, maxK: number): number {
  let best = 1
  for (let k = 2; k <= maxK; k++) {
    if (pass(gpu, batch, alpha, k, draftMs).speedup > pass(gpu, batch, alpha, best, draftMs).speedup) best = k
  }
  return best
}

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** How many draft tokens each of `count` passes accepted, drawn with a fixed seed so the picture is stable. */
export function samplePasses(alpha: number, k: number, count: number, seed = 7): number[] {
  const rand = mulberry32(seed)
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    let accepted = 0
    while (accepted < k && rand() < alpha) accepted++
    out.push(accepted)
  }
  return out
}
