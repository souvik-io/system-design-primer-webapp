// The rules behind the radix-tree prefix cache widget (chapter 5.3). A small pool of KV slots serves requests one
// at a time. The cache is a radix tree over token ids, as in SGLang: a lookup walks the tree and splits a node when
// the match ends inside it, a finished request leaves its prompt and its answer in the tree, and when the pool is
// short the least recently used leaf is evicted. The same requests also go through a hashed-block cache with
// 4-token blocks, the design of vLLM's block pool, so the two hit counts can be compared.
// public/labs/infra/prefix_cache_sim.py is the same model in Python at full size.

export type Action = { kind: 'chat'; who: number } | { kind: 'fewshot' } | { kind: 'repeat' }
export const CHATS = ['A', 'B', 'C']
export const SYSTEM = 12 // tokens in the system prompt every chat starts with
export const EXAMPLES = 16 // tokens of few-shot examples
export const USER = 3
export const ANSWER = 5
export const QUESTION = 3
export const SHORT_ANSWER = 2
export const BLOCK = 4

type Tag = { group: number; text: string } // group picks the colour: 0 system, 1-3 chats, 4 examples, 5 questions

type Node = { id: number; key: number[]; children: Map<number, Node>; parent: Node | null; last: number }

export type NodeView = {
  id: number
  depth: number // tokens between the root and the start of this node
  len: number
  row: number
  parentRow: number
  label: string
  group: number
  state: 'matched' | 'new' | 'idle'
  last: number
}

export type Snap = {
  nodes: NodeView[]
  rows: number
  used: number
  /** What the last request did; null before the first one. */
  last: null | {
    name: string
    prompt: number
    output: number
    hit: number
    blockHit: number
    split: boolean
    evicted: { label: string; len: number }[]
    refused: boolean
  }
  prompts: number // prompt tokens over all requests
  hits: number
  blockHits: number
  evictedTokens: number
  /** Tokens the next request of each kind needs in the pool (prompt plus answer). */
  next: { chat: number[]; fewshot: number; repeat: number | null }
}

/** The hashed-block cache: chained hashes of full blocks, and a free queue whose front is evicted first. */
class Blocks {
  free: number[]
  hashOf: (string | null)[]
  table = new Map<string, number>()
  constructor(pool: number) {
    const n = Math.floor(pool / BLOCK)
    this.free = Array.from({ length: n }, (_, i) => i)
    this.hashOf = Array(n).fill(null)
  }
  hashes(tokens: number[]) {
    const out: string[] = []
    let parent = ''
    for (let i = 0; i + BLOCK <= tokens.length; i += BLOCK) {
      parent = `${parent}|${tokens.slice(i, i + BLOCK).join(',')}`
      out.push(parent)
    }
    return out
  }
  /** Run one request from start to finish; returns the prompt tokens found in the cache. */
  serve(prompt: number[], output: number[]) {
    const found: number[] = []
    for (const h of this.hashes(prompt).slice(0, Math.floor((prompt.length - 1) / BLOCK))) {
      const b = this.table.get(h)
      if (b === undefined) break
      found.push(b)
    }
    this.free = this.free.filter((b) => !found.includes(b))
    const all = [...prompt, ...output]
    const fresh: number[] = []
    for (let i = found.length; i < Math.ceil(all.length / BLOCK); i++) {
      const b = this.free.shift()!
      if (this.hashOf[b] !== null) {
        this.table.delete(this.hashOf[b]!)
        this.hashOf[b] = null
      }
      fresh.push(b)
    }
    const blocks = [...found, ...fresh]
    this.hashes(all).forEach((h, i) => {
      if (this.hashOf[blocks[i]] === null && !this.table.has(h)) {
        this.table.set(h, blocks[i])
        this.hashOf[blocks[i]] = h
      }
    })
    for (const b of [...blocks].reverse()) {
      if (this.hashOf[b] === null) this.free.unshift(b)
      else this.free.push(b)
    }
    return found.length * BLOCK
  }
}

export function simulate(actions: Action[], pool: number): Snap {
  const tags = new Map<number, Tag>()
  let nextToken = 0
  const make = (n: number, tag: Tag) =>
    Array.from({ length: n }, () => {
      tags.set(nextToken, tag)
      return nextToken++
    })
  const system = make(SYSTEM, { group: 0, text: 'system' })
  const examples = make(EXAMPLES, { group: 4, text: 'examples' })
  const history = CHATS.map(() => [...system])
  const turns = CHATS.map(() => 0)
  let questions = 0
  let lastPrompt: { name: string; prompt: number[] } | null = null

  let ids = 0
  let clock = 0
  const root: Node = { id: ids++, key: [], children: new Map(), parent: null, last: 0 }
  let used = 0
  const blocks = new Blocks(pool)

  const split = (child: Node, at: number) => {
    const top: Node = { id: ids++, key: child.key.slice(0, at), children: new Map(), parent: child.parent, last: child.last }
    child.parent!.children.set(top.key[0], top)
    child.key = child.key.slice(at)
    child.parent = top
    top.children.set(child.key[0], child)
    return top
  }
  /** Walk tokens from the root, splitting a node if the match ends inside it. */
  const match = (tokens: number[]) => {
    let node = root
    let i = 0
    let didSplit = false
    const path: Node[] = []
    while (i < tokens.length && node.children.has(tokens[i])) {
      const child = node.children.get(tokens[i])!
      let k = 0
      while (k < child.key.length && i + k < tokens.length && child.key[k] === tokens[i + k]) k++
      child.last = clock
      if (k < child.key.length) {
        node = split(child, k)
        didSplit = true
        path.push(node)
        i += k
        break
      }
      node = child
      path.push(node)
      i += k
    }
    return { n: i, node, path, didSplit }
  }
  const label = (key: number[]) => {
    const texts = [...new Set(key.map((t) => tags.get(t)!.text))]
    return texts.length > 2 ? `${texts[0]} … ${texts[texts.length - 1]}` : texts.join(' + ')
  }
  const evict = (need: number, keep: Set<Node>) => {
    const out: { label: string; len: number }[] = []
    while (need > 0) {
      let victim: Node | null = null
      const stack = [root]
      while (stack.length) {
        const n = stack.pop()!
        stack.push(...n.children.values())
        if (n !== root && n.children.size === 0 && !keep.has(n) && (!victim || n.last < victim.last || (n.last === victim.last && n.id < victim.id))) victim = n
      }
      if (!victim) break
      victim.parent!.children.delete(victim.key[0])
      need -= victim.key.length
      used -= victim.key.length
      out.push({ label: label(victim.key), len: victim.key.length })
    }
    return out
  }

  const sizes = () => ({
    chat: history.map((h) => h.length + USER + ANSWER),
    fewshot: EXAMPLES + QUESTION + SHORT_ANSWER,
    repeat: lastPrompt ? lastPrompt.prompt.length + SHORT_ANSWER : null,
  })

  let last: Snap['last'] = null
  let prompts = 0
  let hits = 0
  let blockHits = 0
  let evictedTokens = 0
  let matched = new Set<Node>()
  let fresh: Node | null = null

  for (const a of actions) {
    let name: string
    let prompt: number[]
    let output: number[]
    if (a.kind === 'chat') {
      const c = CHATS[a.who]
      const turn = turns[a.who] + 1
      name = `Chat ${c}, turn ${turn}`
      prompt = [...history[a.who], ...make(USER, { group: 1 + a.who, text: `${c}${turn}` })]
      output = make(ANSWER, { group: 1 + a.who, text: `${c}${turn}` })
    } else if (a.kind === 'fewshot') {
      questions++
      name = `Few-shot question ${questions}`
      prompt = [...examples, ...make(QUESTION, { group: 5, text: `Q${questions}` })]
      output = make(SHORT_ANSWER, { group: 5, text: `Q${questions}` })
    } else {
      if (!lastPrompt) continue
      name = `${lastPrompt.name}, sent again`
      prompt = lastPrompt.prompt
      output = make(SHORT_ANSWER, { group: 5, text: 'retry' })
    }
    matched = new Set()
    fresh = null
    if (prompt.length + output.length > pool) {
      last = { name, prompt: prompt.length, output: output.length, hit: 0, blockHit: 0, split: false, evicted: [], refused: true }
      continue
    }
    clock++
    // The last token of a prompt is always run, because its output is the first new token.
    const m = match(prompt.slice(0, -1))
    const need = prompt.length - m.n + output.length
    const evicted = pool - used < need ? evict(need - (pool - used), new Set(m.path)) : []
    used += need
    const all = [...prompt, ...output]
    const again = match(all)
    used -= again.n - m.n // tokens of this request that were in the tree already
    let end = again.node
    if (again.n < all.length) {
      const leaf: Node = { id: ids++, key: all.slice(again.n), children: new Map(), parent: end, last: clock }
      end.children.set(leaf.key[0], leaf)
      fresh = leaf
      end = leaf
    }
    matched = new Set(m.path)
    const blockHit = blocks.serve(prompt, output)
    last = { name, prompt: prompt.length, output: output.length, hit: m.n, blockHit, split: m.didSplit, evicted, refused: false }
    prompts += prompt.length
    hits += m.n
    blockHits += blockHit
    evictedTokens += evicted.reduce((s, e) => s + e.len, 0)
    lastPrompt = { name, prompt }
    if (a.kind === 'chat') {
      history[a.who] = all
      turns[a.who]++
    }
  }

  // Lay the tree out left to right: a node starts where its parent ends, and each leaf gets a row of its own.
  const nodes: NodeView[] = []
  let rows = 0
  const place = (node: Node, depth: number, parentRow: number): number => {
    const kids = [...node.children.values()].sort((x, y) => x.id - y.id)
    const view: NodeView = {
      id: node.id,
      depth,
      len: node.key.length,
      row: 0,
      parentRow,
      label: label(node.key),
      group: tags.get(node.key[0])!.group,
      state: node === fresh ? 'new' : matched.has(node) ? 'matched' : 'idle',
      last: node.last,
    }
    nodes.push(view)
    if (kids.length === 0) view.row = rows++
    else {
      view.row = rows
      kids.forEach((k) => place(k, depth + node.key.length, view.row))
    }
    return view.row
  }
  ;[...root.children.values()].sort((x, y) => x.id - y.id).forEach((k) => place(k, 0, -1))

  return { nodes, rows, used, last, prompts, hits, blockHits, evictedTokens, next: sizes() }
}
