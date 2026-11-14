// The model behind the sampling-filters widget (chapter 5.5, content/infra/structured-output.md). A next-token
// distribution is stored as its 300 highest logits, one token each, and the rest of the vocabulary as a histogram of
// logit values (data/sampling-distributions.json, from SmolLM2-135M). The filters run in vLLM 0.32.0's order:
// temperature, then min-p, then top-k, then top-p, each on what the previous one left and renormalized, and the
// draw comes from what is left at the end. A histogram bin holds tokens with nearly the same logit, so top-k and
// top-p may keep part of a bin.

export type Dist = {
  context: string
  /** [token text, logit], highest first. */
  top: [string, number][]
  /** [logit at the bin's centre, number of tokens in the bin], for every token below the top 300. */
  rest: [number, number][]
  vocab: number
}

export type Settings = {
  /** 0 means greedy: only the most likely token. */
  temperature: number
  /** 0 turns top-k off. */
  topK: number
  /** 1 turns top-p off. */
  topP: number
  /** 0 turns min-p off. */
  minP: number
}

export type Filter = 'greedy' | 'min-p' | 'top-k' | 'top-p'

/** A group of tokens with the same logit: one token of the top 300, or one histogram bin. */
type Group = { logit: number; count: number; kept: number; removedBy?: Filter }

export type Result = {
  /** For each of the top 300 tokens: its probability after temperature and before any filter. */
  before: number[]
  /** For each of the top 300 tokens: its probability in the final distribution (0 if removed). */
  after: number[]
  /** Which filter removed each of the top 300 tokens, if any. */
  removedBy: (Filter | undefined)[]
  /** Tokens that can still be drawn, out of the whole vocabulary. */
  keptTokens: number
  /** How many tokens each filter removed. */
  removed: Record<Filter, number>
  /** Probability, before the filters, of the tokens that survive them. */
  keptMass: number
  /** Probability of drawing a token outside the top 20, before and after the filters. */
  tailBefore: number
  tailAfter: number
}

const SHOWN = 20

function groups(d: Dist): Group[] {
  const g: Group[] = d.top.map(([, logit]) => ({ logit, count: 1, kept: 1 }))
  const rest = [...d.rest].sort((a, b) => b[0] - a[0])
  for (const [logit, count] of rest) g.push({ logit, count, kept: count })
  return g
}

/** Probabilities per token in each group, over the kept tokens, at the given temperature. */
function probs(g: Group[], t: number): number[] {
  const m = Math.max(...g.filter((x) => x.kept > 0).map((x) => x.logit))
  const w = g.map((x) => (x.kept > 0 ? Math.exp((x.logit - m) / t) : 0))
  const z = g.reduce((s, x, i) => s + w[i] * x.kept, 0)
  return w.map((v) => v / z)
}

function drop(x: Group, n: number, by: Filter, removed: Record<Filter, number>) {
  const n2 = Math.min(n, x.kept)
  if (n2 <= 0) return
  x.kept -= n2
  removed[by] += n2
  if (x.kept === 0) x.removedBy = by
}

export function applyFilters(d: Dist, s: Settings): Result {
  const g = groups(d)
  const removed: Record<Filter, number> = { greedy: 0, 'min-p': 0, 'top-k': 0, 'top-p': 0 }
  const t = s.temperature > 0 ? s.temperature : 1
  const p0 = probs(g, t)
  const before = d.top.map((_, i) => p0[i])

  if (s.temperature === 0) {
    g.slice(1).forEach((x) => drop(x, x.count, 'greedy', removed))
  } else {
    if (s.minP > 0) {
      const p = probs(g, t)
      const threshold = s.minP * p[0]
      g.forEach((x, i) => p[i] < threshold && drop(x, x.kept, 'min-p', removed))
    }
    if (s.topK > 0) {
      let left = s.topK
      for (const x of g) {
        const keep = Math.min(left, x.kept)
        left -= keep
        drop(x, x.kept - keep, 'top-k', removed)
      }
    }
    if (s.topP < 1) {
      // Keep the most likely tokens until their mass reaches top_p; the token that crosses it is kept. Inside a
      // histogram bin, keep just enough of its tokens.
      const p = probs(g, t)
      let mass = 0
      for (let i = 0; i < g.length; i++) {
        const x = g[i]
        if (x.kept === 0) continue
        if (mass >= s.topP) {
          drop(x, x.kept, 'top-p', removed)
          continue
        }
        const need = Math.ceil((s.topP - mass) / p[i] - 1e-9)
        const keep = Math.max(1, Math.min(x.kept, need))
        mass += keep * p[i]
        drop(x, x.kept - keep, 'top-p', removed)
      }
    }
  }

  const p1 = probs(g, t)
  const after = d.top.map((_, i) => (g[i].kept ? p1[i] : 0))
  const keptTokens = g.reduce((s2, x) => s2 + x.kept, 0)
  const keptMass = g.reduce((s2, x, i) => s2 + p0[i] * x.kept, 0)
  const tail = (p: number[], kept: boolean) => g.slice(SHOWN).reduce((s2, x, i) => s2 + p[i + SHOWN] * (kept ? x.kept : x.count), 0)
  return {
    before,
    after,
    removedBy: d.top.map((_, i) => g[i].removedBy),
    keptTokens,
    removed,
    keptMass,
    tailBefore: tail(p0, false),
    tailAfter: tail(p1, true),
  }
}

/** Draws `n` tokens from the final distribution; a draw outside the top 300 is returned as null. */
export function draw(d: Dist, r: Result, n: number, random: () => number = Math.random): (string | null)[] {
  const out: (string | null)[] = []
  const restMass = 1 - r.after.reduce((a, b) => a + b, 0)
  for (let k = 0; k < n; k++) {
    let u = random()
    let pick: string | null = null
    for (let i = 0; i < r.after.length; i++) {
      u -= r.after[i]
      if (u < 0) {
        pick = d.top[i][0]
        break
      }
    }
    out.push(pick === null && restMass <= 1e-9 ? d.top[r.after.findIndex((p) => p > 0)][0] : pick)
  }
  return out
}

export { SHOWN }
