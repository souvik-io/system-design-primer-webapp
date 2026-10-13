// Flags `diagram` blocks in content-extra/ that would render badly: too wide for the page,
// two arrows drawn over each other, an arrow running through a box, or labels that collide.
// Usage: node scripts/lint-diagrams.mjs [file.md ...]   (defaults to every chapter)
import fs from 'node:fs'
import path from 'node:path'
import { parseDiagram } from './diagram.mjs'

const COL = 160, ROW = 120, BOX_W = 136, LINE = 16, PAD = 12
const MAX_COLS = 5, MAX_LINE = 18, MAX_EDGE_LABEL = 26

function geometry(n) {
  const h = Math.max(48, 20 + n.lines.length * LINE) + (n.kind === 'store' ? 10 : 0)
  const w = BOX_W + (n.span - 1) * COL
  const x = PAD + n.col * COL
  const cy = PAD + n.row * ROW + 30
  return { x, y: cy - h / 2, w, h, cx: x + w / 2, cy }
}

// Does the segment (x1,y1)-(x2,y2) pass through the rectangle (shrunk by `inset`)?
function hitsBox(x1, y1, x2, y2, g, inset = 4) {
  const [l, t, r, b] = [g.x + inset, g.y + inset, g.x + g.w - inset, g.y + g.h - inset]
  let t0 = 0, t1 = 1
  const dx = x2 - x1, dy = y2 - y1
  for (const [p, q] of [[-dx, x1 - l], [dx, r - x1], [-dy, y1 - t], [dy, b - y1]]) {
    if (p === 0) { if (q < 0) return false; continue }
    const u = q / p
    if (p < 0) { if (u > t1) return false; if (u > t0) t0 = u }
    else { if (u < t0) return false; if (u < t1) t1 = u }
  }
  return t0 < t1
}

const overlap = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b

export function lintDiagram(src) {
  const problems = []
  const { nodes, edges } = parseDiagram(src)
  const geo = new Map([...nodes.values()].map((n) => [n.id, geometry(n)]))
  for (const n of nodes.values()) {
    if (n.col + n.span > MAX_COLS) problems.push(`node "${n.id}" reaches column ${n.col + n.span - 1}; keep everything within columns 0-${MAX_COLS - 1}`)
    for (const l of n.lines) if (l.length > MAX_LINE) problems.push(`node "${n.id}" line "${l}" is ${l.length} chars (max ${MAX_LINE}); add \\n`)
  }
  for (const [a, b] of [...nodes.values()].flatMap((a, i, all) => all.slice(i + 1).map((b) => [a, b]))) {
    const ga = geo.get(a.id), gb = geo.get(b.id)
    if (overlap({ l: ga.x, r: ga.x + ga.w, t: ga.y, b: ga.y + ga.h }, { l: gb.x, r: gb.x + gb.w, t: gb.y, b: gb.y + gb.h }))
      problems.push(`nodes "${a.id}" and "${b.id}" overlap`)
  }
  const seen = new Map()
  const labelBoxes = []
  for (const e of edges) {
    const key = [e.from, e.to].sort().join('|')
    if (seen.has(key)) problems.push(`two edges between "${e.from}" and "${e.to}" draw on top of each other (lines ${seen.get(key)} and ${e.line}); merge them or use <->`)
    else seen.set(key, e.line)
    if (e.label && e.label.length > MAX_EDGE_LABEL) problems.push(`edge ${e.from}->${e.to} label "${e.label}" is ${e.label.length} chars (max ${MAX_EDGE_LABEL})`)
    const a = geo.get(e.from), b = geo.get(e.to)
    for (const [id, g] of geo) {
      if (id === e.from || id === e.to) continue
      if (hitsBox(a.cx, a.cy, b.cx, b.cy, g)) problems.push(`edge ${e.from}->${e.to} runs through node "${id}"`)
    }
    if (e.label) {
      const w = e.label.length * 6.2 + 10
      const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2
      const box = { l: mx - w / 2, r: mx + w / 2, t: my - 9, b: my + 9, e: `${e.from}->${e.to}` }
      // The visible line runs between the box edges; the label sits on its middle and hides what it covers.
      const ex = (g, tx, ty) => {
        const dx = tx - g.cx, dy = ty - g.cy
        const t = Math.min(dx ? g.w / 2 / Math.abs(dx) : Infinity, dy ? g.h / 2 / Math.abs(dy) : Infinity)
        return [g.cx + dx * t, g.cy + dy * t]
      }
      const [x1, y1] = ex(a, b.cx, b.cy), [x2, y2] = ex(b, a.cx, a.cy)
      const len = Math.hypot(x2 - x1, y2 - y1)
      const along = Math.abs(x2 - x1) / (len || 1) * w + Math.abs(y2 - y1) / (len || 1) * 18
      const sideways = Math.abs(y2 - y1) < 8 || (Math.abs(x2 - x1) < 8 && len < 40) // the renderer moves these labels aside
      if (!sideways && len < along + 24) problems.push(`edge ${e.from}->${e.to} is too short for its label "${e.label}"; move the nodes apart or shorten the label`)
      if (!sideways) for (const [id, g] of geo) if (overlap(box, { l: g.x, r: g.x + g.w, t: g.y, b: g.y + g.h })) problems.push(`label of ${box.e} covers node "${id}"`)
      for (const o of labelBoxes) if (overlap(box, o)) problems.push(`label of ${box.e} collides with label of ${o.e}`)
      labelBoxes.push(box)
    }
  }
  return problems
}

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'content-extra')
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f))
let total = 0
for (const file of files) {
  const md = fs.readFileSync(file, 'utf8')
  const blocks = [...md.matchAll(/^```diagram\n([\s\S]*?)^```/gm)]
  for (const m of blocks) {
    const lineNo = md.slice(0, m.index).split('\n').length
    let problems
    try { problems = lintDiagram(m[1]) } catch (err) { problems = [err.message] }
    for (const p of problems) console.log(`${path.basename(file)}:${lineNo}: ${p}`)
    total += problems.length
  }
}
console.log(total ? `\n${total} problem(s)` : 'All diagrams OK')
process.exitCode = total ? 1 : 0
