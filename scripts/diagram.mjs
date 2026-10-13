// Draws the `diagram` code blocks used in content-extra/ as inline SVG.
// The syntax is described in content-extra/README.md. Colors come from CSS classes
// (see .diagram in src/index.css), so diagrams follow the light and dark theme.

const COL = 160 // grid column width
const ROW = 120 // grid row height
const BOX_W = 136
const LINE = 16 // label line height
const PAD = 12
const KINDS = new Set(['box', 'store', 'queue', 'client', 'note'])

const NODE = /^\[([\w-]+)(?::(\w+))?\]\s+(.+?)\s*@\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s+span\s+(\d+))?$/
const EDGE = /^([\w-]+)\s*(<->|-->|->)\s*([\w-]+)(?:\s*:\s*(.+))?$/

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const r = (n) => Math.round(n * 10) / 10

/** Parses a diagram block. Throws with the line number on anything it doesn't understand. */
export function parseDiagram(source, where = 'diagram') {
  let title = ''
  const nodes = new Map()
  const edges = []
  source.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const fail = (msg) => {
      throw new Error(`${where}, diagram line ${i + 1}: ${msg}\n  ${line}`)
    }
    if (line.startsWith('title:')) {
      title = line.slice(6).trim()
      return
    }
    let m = line.match(NODE)
    if (m) {
      const [, id, kind = 'box', label, col, row, span = '1'] = m
      if (!KINDS.has(kind)) fail(`unknown kind "${kind}". Use ${[...KINDS].join(', ')}.`)
      if (nodes.has(id)) fail(`node "${id}" is defined twice.`)
      nodes.set(id, { id, kind, lines: label.split('\\n').map((s) => s.trim()), col: Number(col), row: Number(row), span: Number(span) })
      return
    }
    m = line.match(EDGE)
    if (m) {
      const [, from, op, to, label] = m
      edges.push({ from, to, label: label?.trim(), both: op === '<->', dashed: op === '-->', line: i + 1, text: line })
      return
    }
    fail('expected a node like "[id] Label @ 0,0", an edge like "a -> b : label", or "title: ..."')
  })
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (!nodes.has(id)) throw new Error(`${where}, diagram line ${e.line}: no node "${id}"\n  ${e.text}`)
    }
  }
  return { title, nodes, edges }
}

function geometry(node) {
  const h = Math.max(48, 20 + node.lines.length * LINE) + (node.kind === 'store' ? 10 : 0)
  const w = BOX_W + (node.span - 1) * COL
  const x = PAD + node.col * COL
  const cy = PAD + node.row * ROW + 30
  return { x, y: cy - h / 2, w, h, cx: x + w / 2, cy }
}

/** Where the line from a box's center towards (tx, ty) leaves the box, plus a small gap. */
function exitPoint(g, tx, ty, gap) {
  const dx = tx - g.cx
  const dy = ty - g.cy
  const t = Math.min(dx ? (g.w / 2 + gap) / Math.abs(dx) : Infinity, dy ? (g.h / 2 + gap) / Math.abs(dy) : Infinity)
  return [g.cx + dx * t, g.cy + dy * t]
}

function shape(node, g) {
  const { x, y, w, h } = g
  const cls = `dg-node dg-${node.kind}`
  if (node.kind === 'store') {
    const ry = 7
    return (
      `<path class="${cls}" d="M${x},${y + ry} a${w / 2},${ry} 0 0,1 ${w},0 v${h - 2 * ry} a${w / 2},${ry} 0 0,1 ${-w},0 z"/>` +
      `<path class="dg-line" d="M${x},${y + ry} a${w / 2},${ry} 0 0,0 ${w},0"/>`
    )
  }
  if (node.kind === 'queue') {
    const bars = [16, 26, 36].map((d) => `<line class="dg-line" x1="${x + w - d}" y1="${y + 8}" x2="${x + w - d}" y2="${y + h - 8}"/>`)
    return `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>${bars.join('')}`
  }
  const rx = node.kind === 'client' ? h / 2 : 8
  return `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`
}

function label(node, g) {
  // Cylinders have their lid at the top, and queues their bars on the right, so nudge the text off them.
  const top = g.cy + (node.kind === 'store' ? 3 : 0) - ((node.lines.length - 1) * LINE) / 2 + 4.5
  const cx = g.cx - (node.kind === 'queue' ? 14 : 0)
  const tspans = node.lines.map((l, i) => `<tspan x="${r(cx)}" y="${r(top + i * LINE)}">${esc(l)}</tspan>`).join('')
  return `<text class="dg-label${node.kind === 'note' ? ' dg-muted' : ''}" text-anchor="middle">${tspans}</text>`
}

/** The diagram as one line of text, for the Markdown copies of each chapter that crawlers and LLMs read. */
function describe(nodes, edges) {
  const name = (id) => nodes.get(id).lines.join(' ')
  const arrow = (e) => (e.both ? '<->' : '->')
  const lines = edges.map((e) => `${name(e.from)} ${arrow(e)} ${name(e.to)}${e.label ? ` (${e.label})` : ''}`)
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]))
  const alone = [...nodes.keys()].filter((id) => !linked.has(id)).map(name)
  return [...lines, ...alone].join('; ')
}

/** Returns the diagram as HTML: an inline SVG in a <figure>, with the title as its caption. */
export function renderDiagram(source, where) {
  const { title, nodes, edges } = parseDiagram(source, where)
  const geo = new Map([...nodes.values()].map((n) => [n.id, geometry(n)]))
  const all = [...geo.values()]
  // The drawing area grows to fit labels that sit outside the grid.
  let [left, top, right, bottom] = [0, 0, Math.max(...all.map((g) => g.x + g.w)) + PAD, Math.max(...all.map((g) => g.y + g.h)) + PAD]

  const lines = []
  const labels = []
  for (const e of edges) {
    const a = geo.get(e.from)
    const b = geo.get(e.to)
    const [x1, y1] = exitPoint(a, b.cx, b.cy, e.both ? 5 : 3)
    const [x2, y2] = exitPoint(b, a.cx, a.cy, 5)
    lines.push(
      `<line class="dg-edge${e.dashed ? ' dg-dashed' : ''}" x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" marker-end="url(#dg-arrow)"${
        e.both ? ' marker-start="url(#dg-arrow)"' : ''
      }/>`,
    )
    if (e.label) {
      const w = e.label.length * 6.2 + 10
      let mx = (x1 + x2) / 2
      let my = (y1 + y2) / 2
      // A label that doesn't fit along a short arrow goes beside it instead of covering the boxes.
      const length = Math.hypot(x2 - x1, y2 - y1)
      if (Math.abs(y2 - y1) < 8) {
        if (length < w + 6) my -= Math.max(a.h, b.h) / 2 + 13
      } else if (Math.abs(x2 - x1) < 8 && length < 40) {
        mx += w / 2 + 8
      }
      left = Math.min(left, mx - w / 2 - 4)
      right = Math.max(right, mx + w / 2 + 4)
      top = Math.min(top, my - 13)
      bottom = Math.max(bottom, my + 13)
      labels.push(
        `<rect class="dg-edge-bg" x="${r(mx - w / 2)}" y="${r(my - 9)}" width="${r(w)}" height="18" rx="4"/>` +
          `<text class="dg-edge-label" x="${r(mx)}" y="${r(my + 4)}" text-anchor="middle">${esc(e.label)}</text>`,
      )
    }
  }

  const body = [...nodes.values()].map((n) => shape(n, geo.get(n.id)) + label(n, geo.get(n.id))).join('')
  const svg =
    `<svg class="dg" viewBox="${r(left)} ${r(top)} ${r(right - left)} ${r(bottom - top)}" width="${r(right - left)}" role="img" aria-label="${esc(title || 'Diagram')}">` +
    `<defs><marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path class="dg-arrowhead" d="M0,1 L9,5 L0,9 z"/></marker></defs>` +
    lines.join('') +
    body +
    labels.join('') +
    `</svg>`
  return `<figure class="diagram" data-text="${esc(describe(nodes, edges))}"><div class="diagram-scroll">${svg}</div>${title ? `<figcaption>${esc(title)}</figcaption>` : ''}</figure>`
}
