// Turns the handbook's markdown into structured JSON for the web app.
//
//   content/<chapter-id>.md          -> one chapter each, "##" headings become its sections
//   content/flashcards/<deck-id>.md  -> one flashcard deck each (DECKS)
//   content/redirects.json           -> old chapter ids, headings and decks, and where they went
//
// Output:
//   src/generated/manifest.json   curriculum outline (imported by the app)
//   public/content/<id>.json      rendered HTML per chapter (fetched on demand)
//   public/content/flashcards/    one JSON file per deck
//   public/content/search.json    plain-text index for search

import fs from 'node:fs'
import path from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeStringify from 'rehype-stringify'
import rehypeShiki from '@shikijs/rehype'
import GithubSlugger from 'github-slugger'
import { visit, SKIP } from 'unist-util-visit'
import { toString as mdToString } from 'mdast-util-to-string'
import { toString as hastToString } from 'hast-util-to-string'
import { renderDiagram } from './diagram.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONTENT = path.join(ROOT, 'content')
const OUT_CONTENT = path.join(ROOT, 'public/content')
const OUT_MANIFEST = path.join(ROOT, 'src/generated/manifest.json')

if (process.argv.includes('--if-missing') && fs.existsSync(OUT_MANIFEST)) process.exit(0)

// ---------------------------------------------------------------------------
// Curriculum

const PARTS = [
  {
    id: 'start',
    title: 'Start here',
    description: 'How to use the handbook, how to run an interview answer, how systems grow, and how to estimate.',
    chapters: ['how-to-use-this-handbook', 'system-design-interview', 'scalability', 'estimation'],
  },
  {
    id: 'trade-offs',
    title: 'Core trade-offs',
    description: 'The tensions every design balances: speed, scale, availability and consistency.',
    chapters: ['performance-and-latency', 'cap-and-consistency', 'availability'],
  },
  {
    id: 'building-blocks',
    title: 'Building blocks',
    description: 'The components a request passes through, from DNS to the database.',
    chapters: [
      'dns-and-cdn',
      'load-balancing',
      'reverse-proxy-and-api-gateway',
      'relational-databases',
      'nosql-databases',
      'database-internals',
      'cache',
      'queues-and-async',
      'protocols-and-apis',
      'security',
    ],
  },
  {
    id: 'concepts',
    title: 'Deeper concepts',
    description: 'The techniques large systems lean on, from consistent hashing to consensus.',
    chapters: [
      'consistent-hashing',
      'rate-limiting',
      'unique-ids',
      'event-streaming',
      'reliability-patterns',
      'distributed-transactions',
      'consensus',
      'realtime',
      'observability',
      'batch-processing',
    ],
  },
  {
    id: 'system-design',
    title: 'System design questions',
    description: 'Worked designs with use cases, constraints, estimates, diagrams and scaling discussion.',
    chapters: [
      'design-pastebin',
      'design-url-shortener',
      'design-twitter',
      'design-social-news-feed',
      'design-web-crawler',
      'design-search-engine',
      'design-autocomplete',
      'design-query-cache',
      'design-key-value-store',
      'design-social-graph',
      'design-sales-rank',
      'design-gaming-leaderboard',
      'design-mint',
      'design-payment-system',
      'design-notification-system',
      'design-chat-system',
      'design-collaborative-document',
      'design-file-sync',
      'design-video-streaming',
      'design-recommendation-system',
      'design-scaling-aws',
    ],
  },
  {
    id: 'ood',
    title: 'Object-oriented design questions',
    description: 'Class design exercises with working Python solutions.',
    chapters: ['ood-hash-table', 'ood-lru-cache', 'ood-call-center', 'ood-deck-of-cards', 'ood-parking-lot', 'ood-online-chat'],
  },
  {
    id: 'ai-systems',
    title: 'AI systems',
    description: 'How language models are served, from GPUs and inference engines to retrieval, agents, evaluation and security.',
    chapters: [
      'llm-inference',
      'gpus-for-ai',
      'inference-engines',
      'ai-estimation',
      'inference-fleets',
      'llm-gateways',
      'vector-search',
      'rag',
      'ai-agents',
      'ai-evals-and-observability',
      'ai-security',
      'training-infrastructure',
    ],
  },
  {
    id: 'ai-design',
    title: 'AI system design questions',
    description: 'Worked designs for products built on language and image models, in the same four steps.',
    chapters: [
      'design-chat-assistant',
      'design-inference-platform',
      'design-llm-gateway',
      'design-rag-qa',
      'design-coding-assistant',
      'design-agent-platform',
      'design-vector-database',
      'design-image-generation',
    ],
  },
  {
    id: 'reference',
    title: 'Reference',
    description: 'Numbers to memorise, more practice questions, and real-world architectures.',
    chapters: ['numbers-to-know', 'practice-questions', 'real-world-architectures'],
  },
  {
    id: 'about',
    title: 'About',
    description: 'The flashcards, what is being written next, contributing, credits and the license.',
    // Not study material, so it doesn't count toward progress.
    untracked: true,
    chapters: ['about'],
  },

  // The AI Infrastructure Engineer Handbook, a second course on the same site at /infra. Its chapters live in
  // content/infra/ (dir) and its progress, home page and sidebar are separate from the system design course
  // (handbook). content/infra/SYLLABUS.md is the plan for the rest of it.
  {
    id: 'infra-orientation',
    handbook: 'infra',
    dir: 'infra',
    title: 'Orientation',
    description: 'What an inference engineer does, how the job is hired for, and the models and machines the labs use.',
    chapters: ['inference-engineer-role', 'models-and-machines'],
  },
  {
    id: 'infra-workload',
    handbook: 'infra',
    dir: 'infra',
    title: 'The model as a workload',
    description:
      'Where the FLOPs and bytes of a transformer go, the arithmetic that predicts speed, latency and cost, and what mixture-of-experts models change.',
    chapters: ['transformer-as-workload', 'inference-arithmetic', 'mixture-of-experts'],
  },
  {
    id: 'infra-kernels',
    handbook: 'infra',
    dir: 'infra',
    title: 'GPUs and kernels',
    description: 'How a GPU runs threads and moves memory, how to write kernels in Triton and read them in CUDA, FlashAttention, and profiling.',
    chapters: ['gpu-execution', 'triton-kernels', 'cuda-basics', 'flash-attention', 'profiling'],
  },
]

/** Folders under content/ that hold a handbook's chapters, besides content/ itself. */
const CHAPTER_DIRS = [...new Set(PARTS.map((p) => p.dir).filter(Boolean))]

// content/flashcards/<id>.md
const DECKS = [
  {
    id: 'topics',
    title: 'Topics, one card each',
    description: 'One card per topic, from performance and scalability to security. Explain it in your own words, then check.',
  },
  {
    id: 'foundations',
    title: 'Start here and core trade-offs',
    description: 'Interview steps, scaling, estimation, performance and latency, CAP and consistency, and availability.',
  },
  {
    id: 'building-blocks',
    title: 'Building blocks and numbers',
    description: 'DNS to security, the databases and caches in depth, plus the powers of two and latency numbers.',
  },
  {
    id: 'beyond-concepts',
    title: 'Deeper concepts',
    description: 'Consistent hashing, rate limiting, IDs, streaming, reliability, transactions, consensus, real time and observability.',
  },
  {
    id: 'design-decisions',
    title: 'Design questions, decision by decision',
    description: 'The key choices, numbers and trade-offs inside the classic system designs and the object-oriented designs.',
  },
  {
    id: 'beyond-designs',
    title: 'More design decisions',
    description: 'The decisions inside the key-value store, notification, chat, autocomplete, video streaming and file sync designs.',
  },
  {
    id: 'design-walkthroughs',
    title: 'Design walkthroughs',
    description: 'Talk through a whole design question in four steps, then compare with the outline from its chapter.',
  },
  {
    id: 'object-oriented',
    title: 'Object-oriented design',
    description: 'Sketch the classes for each object-oriented question, then compare with the design in its chapter.',
  },
  {
    id: 'ai-concepts',
    title: 'AI systems',
    description: 'Inference, GPUs, serving engines, estimation, fleets, gateways, retrieval, agents, evaluation, security and training.',
  },
  {
    id: 'ai-designs',
    title: 'AI design questions',
    description: 'The key choices and numbers inside the eight AI designs, plus a four-step walkthrough of each.',
  },
  // Decks for the AI Infrastructure Engineer Handbook, one per part; the flashcards page lists them under it.
  {
    id: 'infra-workload',
    handbook: 'infra',
    title: 'Orientation and the model as a workload',
    description: 'The inference role, model and hardware numbers, FLOPs and bytes per layer, attention variants, RoPE, the roofline, and MoE.',
  },
  {
    id: 'infra-kernels',
    handbook: 'infra',
    title: 'GPUs and kernels',
    description: 'Warps, occupancy, coalescing and banks, tensor-core peaks, Triton and CUDA kernels, FlashAttention, and profiling.',
  },
]

// Sections too small to track on their own; they're folded into the preceding section.
const FOLD_INTO_PREVIOUS = /^(source\(s\)|disadvantage\(s\)|further reading)/i

// Interactive diagrams (src/widgets/Widgets.tsx), placed with a ```widget block. The build leaves an
// empty placeholder where each one goes and the app renders into it.
const WIDGET_NAMES = new Set([
  'hash-ring',
  'cache-strategies',
  'replication',
  'rate-limiter',
  'kv-cache-calculator',
  'batching-simulator',
  'roofline-explorer',
  'layer-explorer',
  'attention-variants',
  'rope-rotation',
  'expert-router',
  'warp-access',
  'occupancy',
  'matmul-tiling',
  'warp-reduce',
  'online-softmax',
  'decode-timeline',
])

function widgetNode(name, where) {
  if (!WIDGET_NAMES.has(name)) throw new Error(`${where}: no interactive diagram called "${name}". Known: ${[...WIDGET_NAMES].join(', ')}.`)
  return { type: 'html', value: `<div class="widget-slot" data-widget="${name}"></div>` }
}

// ---------------------------------------------------------------------------
// Markdown helpers

const parser = unified().use(remarkParse).use(remarkGfm)

function slugHeadings(tree) {
  const slugger = new GithubSlugger()
  visit(tree, 'heading', (node) => {
    const id = slugger.slug(mdToString(node))
    node.data = { ...node.data, id, hProperties: { id } }
  })
}

function isBlank(node) {
  return node.type === 'html' && !node.value.trim()
}

/** Split a list of nodes at headings of `depth`. Content before the first one becomes "Overview". */
function splitSections(nodes, depth) {
  const sections = []
  let current = { id: 'overview', title: 'Overview', nodes: [] }
  for (const node of nodes) {
    if (node.type === 'heading' && node.depth === depth) {
      sections.push(current)
      current = { id: node.data.id, title: mdToString(node), nodes: [node] }
    } else {
      current.nodes.push(node)
    }
  }
  sections.push(current)

  const merged = []
  for (const s of sections) {
    if (!s.nodes.some((n) => !isBlank(n))) continue
    if (merged.length && FOLD_INTO_PREVIOUS.test(s.title)) merged.at(-1).nodes.push(...s.nodes)
    else merged.push(s)
  }
  return merged
}

function firstSentenceSummary(nodes) {
  for (const n of nodes) {
    if (n.type !== 'paragraph') continue
    const text = mdToString(n).replace(/\s+/g, ' ').trim()
    if (text.length < 40 || /^note:/i.test(text)) continue
    if (text.length <= 180) return text
    return text.slice(0, 180).replace(/\s+\S*$/, '') + '…'
  }
  return ''
}

// ---------------------------------------------------------------------------
// Rendering

function rehypeRewrite() {
  return (tree, file) => {
    const ctx = file.data.ctx
    visit(tree, 'element', (node, index, parent) => {
      const p = node.properties
      if (node.tagName === 'a' && typeof p.href === 'string') {
        if (p.href.startsWith('#') && ctx.chapterId) p.href = `/learn/${ctx.chapterId}${p.href}`
        // External links, and the standalone interactive diagrams in public/diagrams/, open in a new tab
        if (/^https?:/.test(p.href) || p.href.startsWith('/diagrams/')) {
          p.target = '_blank'
          p.rel = ['noopener', 'noreferrer']
        }
      } else if (node.tagName === 'img' && typeof p.src === 'string') {
        p.loading = 'lazy'
        p.decoding = 'async'
        if (!p.alt) p.alt = 'Diagram'
      } else if (node.tagName === 'table' && parent) {
        parent.children[index] = { type: 'element', tagName: 'div', properties: { className: ['table-wrap'] }, children: [node] }
        return [SKIP, index + 1]
      }
    })
  }
}

const htmlProcessor = unified()
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeRewrite)
  .use(rehypeShiki, {
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultLanguage: 'text',
    fallbackLanguage: 'text',
  })
  .use(rehypeStringify)

async function renderSection(section, ctx) {
  const hast = await htmlProcessor.run({ type: 'root', children: section.nodes }, { path: ctx.file, data: { ctx } })
  const headings = []
  visit(hast, 'element', (node) => {
    if (/^h[3-4]$/.test(node.tagName) && node.properties.id) {
      headings.push({ id: String(node.properties.id), title: hastToString(node).trim(), depth: Number(node.tagName[1]) })
    }
  })
  return {
    id: section.id,
    title: section.title,
    html: htmlProcessor.stringify(hast),
    headings,
    text: hastToString(hast).replace(/\s+/g, ' ').trim(),
  }
}

// ---------------------------------------------------------------------------
// Sources

/** A chapter: "##" headings become sections, shifted down a level so they render as <h3>. */
function readChapter(id, dir) {
  const file = dir ? `content/${dir}/${id}.md` : `content/${id}.md`
  if (!fs.existsSync(path.join(ROOT, file))) throw new Error(`${file} doesn't exist, but PARTS lists it.`)
  const tree = parser.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  slugHeadings(tree)
  const titleIdx = tree.children.findIndex((n) => n.type === 'heading' && n.depth === 1)
  if (titleIdx === -1) throw new Error(`${file} needs a "# Title" heading.`)
  const title = mdToString(tree.children[titleIdx])
  const nodes = tree.children.filter((_, i) => i !== titleIdx)
  for (const n of nodes) {
    visit(n, 'heading', (h) => void (h.depth = Math.min(6, h.depth + 1)))
    visit(n, 'code', (c, index, parent) => {
      if (!parent) return
      if (c.lang === 'diagram') parent.children[index] = { type: 'html', value: renderDiagram(c.value, file) }
      if (c.lang === 'widget') parent.children[index] = widgetNode(c.value.trim(), file)
    })
  }
  // A block can be at the top level, which the visit above can't replace in place.
  const body = nodes.map((n) =>
    n.type !== 'code'
      ? n
      : n.lang === 'diagram'
        ? { type: 'html', value: renderDiagram(n.value, file) }
        : n.lang === 'widget'
          ? widgetNode(n.value.trim(), file)
          : n,
  )
  return { id, title, nodes: body, ctx: { file, chapterId: id } }
}

/**
 * A deck: each "## " heading is a card's front, followed by an
 * <!-- /learn/... --> comment linking to where it's taught, then the answer.
 */
async function deckCards(deckId, file) {
  const tree = parser.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  const ctx = { file, chapterId: null }
  const slugger = new GithubSlugger()
  const cards = []
  let card = null
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 2) {
      const front = mdToString(node).trim()
      // The id is the question's slug, so rewording a question starts its schedule afresh.
      card = { id: `${deckId}/${slugger.slug(front)}`, front, href: undefined, nodes: [] }
      cards.push(card)
      continue
    }
    const link = node.type === 'html' && node.value.match(/^<!--\s*(\/learn\/\S+)\s*-->$/)
    if (link && card && !card.href && !card.nodes.length) card.href = link[1]
    else if (node.type === 'html' && /^<!--[\s\S]*-->$/.test(node.value.trim())) continue
    else if (card) card.nodes.push(node)
    else throw new Error(`${file}: content before the first "## " card.`)
  }
  const out = []
  for (const c of cards) {
    if (!c.nodes.length) throw new Error(`${file}: card "${c.front}" has no answer.`)
    const { html } = await renderSection({ id: c.id, title: c.front, nodes: c.nodes }, ctx)
    out.push({ id: c.id, front: c.front, back: html, ...(c.href ? { href: c.href } : {}) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Build

fs.rmSync(OUT_CONTENT, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT_CONTENT, 'flashcards'), { recursive: true })
fs.mkdirSync(path.dirname(OUT_MANIFEST), { recursive: true })

const listed = PARTS.flatMap((p) => p.chapters)
for (const dir of ['', ...CHAPTER_DIRS]) {
  for (const f of fs.readdirSync(path.join(CONTENT, dir))) {
    const id = f.replace(/\.md$/, '')
    if (f.endsWith('.md') && !['README', 'COVERAGE', 'SYLLABUS'].includes(id) && !listed.includes(id)) {
      console.warn(`  content/${dir ? dir + '/' : ''}${f} isn't in PARTS, so it isn't published.`)
    }
  }
}

const redirects = JSON.parse(fs.readFileSync(path.join(CONTENT, 'redirects.json'), 'utf8'))
const movedChapters = { ...redirects.renamed, ...redirects.replaced }
for (const old of Object.keys(movedChapters)) {
  if (listed.includes(old)) throw new Error(`"${old}" is a chapter, so content/redirects.json can't send it elsewhere.`)
}

const manifest = { generatedAt: new Date().toISOString(), parts: [], decks: [], redirects: {} }
const searchDocs = []
const sectionsOf = new Map() // chapter id -> rendered sections

for (const part of PARTS) {
  const chapters = []
  for (const id of part.chapters) {
    const src = readChapter(id, part.dir)
    const sections = []
    for (const s of splitSections(src.nodes, 3)) sections.push(await renderSection(s, src.ctx))
    sectionsOf.set(id, sections)
    const words = sections.reduce((n, s) => n + s.text.split(' ').length, 0)

    fs.writeFileSync(path.join(OUT_CONTENT, `${id}.json`), JSON.stringify({ id, title: src.title, sections: sections.map(({ text, ...s }) => s) }))
    for (const s of sections) {
      searchDocs.push({ id: `${id}#${s.id}`, chapterId: id, sectionId: s.id, chapterTitle: src.title, title: s.title, text: s.text.slice(0, 6000) })
    }
    chapters.push({
      id,
      title: src.title,
      ...(part.untracked ? { untracked: true } : {}),
      summary: firstSentenceSummary(src.nodes),
      minutes: Math.max(1, Math.round(words / 220)),
      sections: sections.map((s) => ({ id: s.id, title: s.title })),
    })
  }
  manifest.parts.push({
    id: part.id,
    handbook: part.handbook ?? 'system-design',
    title: part.title,
    description: part.description,
    ...(part.untracked ? { untracked: true } : {}),
    chapters,
  })
}

for (const deck of DECKS) {
  const cards = await deckCards(deck.id, `content/flashcards/${deck.id}.md`)
  fs.writeFileSync(path.join(OUT_CONTENT, 'flashcards', `${deck.id}.json`), JSON.stringify({ id: deck.id, title: deck.title, cards }))
  manifest.decks.push({ ...deck, handbook: deck.handbook ?? 'system-design', cardIds: cards.map((c) => c.id) })
}

// Old URLs, for the app to send readers on. "sections" maps an old section ("chapter/section", the key
// progress and notes use) to the section that now holds its heading, so notes and bookmarks can move.
/** The section of `chapterId` that holds heading `heading`, or the overview. */
function sectionFor(chapterId, heading, required = true) {
  const sections = sectionsOf.get(chapterId)
  if (!sections) throw new Error(`content/redirects.json points at chapter "${chapterId}", which doesn't exist.`)
  if (!heading) return 'overview'
  const s = sections.find((s) => s.id === heading || s.headings.some((h) => h.id === heading))
  if (!s && required) throw new Error(`content/redirects.json points at "${chapterId}#${heading}", but there's no such heading.`)
  return s?.id
}
const sections = {}
for (const [old, to] of Object.entries(movedChapters)) {
  const [chapter, heading] = to.split('#')
  sections[`${old}/overview`] = `${chapter}/${sectionFor(chapter, heading)}`
}
for (const [from, to] of Object.entries(redirects.anchors)) {
  const [oldChapter, oldHeading] = from.split('#')
  if (sectionsOf.has(oldChapter) && sectionFor(oldChapter, oldHeading, false)) {
    throw new Error(`content/redirects.json moves "${from}", but that heading still exists. Remove the entry.`)
  }
  const [chapter, heading] = to.split('#')
  sections[from.replace('#', '/')] = `${chapter}/${sectionFor(chapter, heading)}`
}
for (const [old, to] of Object.entries(redirects.decks)) {
  if (!manifest.decks.some((d) => d.id === to)) throw new Error(`content/redirects.json sends deck "${old}" to "${to}", which doesn't exist.`)
}
manifest.redirects = { renamed: redirects.renamed, replaced: redirects.replaced, anchors: redirects.anchors, sections, decks: redirects.decks }

fs.writeFileSync(path.join(OUT_CONTENT, 'search.json'), JSON.stringify(searchDocs))
fs.writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2))

const chapterCount = manifest.parts.reduce((n, p) => n + p.chapters.length, 0)
const cardCount = manifest.decks.reduce((n, d) => n + d.cardIds.length, 0)
console.log(`Built ${chapterCount} chapters, ${searchDocs.length} sections, ${cardCount} flashcards.`)
