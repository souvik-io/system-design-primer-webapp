// Turns the system-design-primer repo into structured JSON for the web app.
//
//   source-repo/README.md            -> one chapter per "##" topic, split into "###" sections
//   source-repo/solutions/system_design/*/README.md -> one chapter each, split into "##" steps
//   source-repo/solutions/object_oriented_design/*/*.ipynb -> one chapter each
//
//   source-repo/README.md "About" sections (Anki, credits, license...) -> one untracked "About" chapter
//   content-extra/*.md               -> extra chapters written for this site, hidden unless the reader turns them on
//   source-repo/resources/flash_cards/*.apkg -> flashcard decks (see flashcards.mjs)
//
// Output:
//   src/generated/manifest.json   curriculum outline (imported by the app)
//   public/content/<id>.json      rendered HTML per chapter (fetched on demand)
//   public/content/flashcards/    one JSON file per deck
//   public/content/search.json    plain-text index for search
//   public/repo/...               images referenced by the content

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeStringify from 'rehype-stringify'
import rehypeShiki from '@shikijs/rehype'
import GithubSlugger, { slug as slugOnce } from 'github-slugger'
import { visit, SKIP } from 'unist-util-visit'
import { toString as mdToString } from 'mdast-util-to-string'
import { toString as hastToString } from 'hast-util-to-string'
import { buildDecks, decodeCamo, DECKS } from './flashcards.mjs'
import { renderDiagram } from './diagram.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'source-repo')
const EXTRA = path.join(ROOT, 'content-extra')
const OUT_CONTENT = path.join(ROOT, 'public/content')
const OUT_REPO = path.join(ROOT, 'public/repo')
const OUT_MANIFEST = path.join(ROOT, 'src/generated/manifest.json')
const REPO_URL = 'https://github.com/donnemartin/system-design-primer'

if (process.argv.includes('--if-missing') && fs.existsSync(OUT_MANIFEST)) process.exit(0)

if (!fs.existsSync(SRC)) {
  console.log('Cloning system-design-primer into source-repo/ ...')
  execSync(`git clone --depth 1 ${REPO_URL}.git "${SRC}"`, { stdio: 'inherit' })
}

// ---------------------------------------------------------------------------
// Curriculum

const PARTS = [
  {
    id: 'start',
    title: 'Start here',
    description: 'Why system design matters, how much to study, and how to run an interview answer.',
    readme: ['motivation', 'study-guide', 'how-to-approach-a-system-design-interview-question', 'system-design-topics-start-here'],
  },
  {
    id: 'trade-offs',
    title: 'Core trade-offs',
    description: 'The tensions every design balances: speed, scale, availability and consistency.',
    readme: ['performance-vs-scalability', 'latency-vs-throughput', 'availability-vs-consistency', 'consistency-patterns', 'availability-patterns'],
  },
  {
    id: 'building-blocks',
    title: 'Building blocks',
    description: 'The components a request passes through, from DNS to the database.',
    readme: [
      'domain-name-system',
      'content-delivery-network',
      'load-balancer',
      'reverse-proxy-web-server',
      'application-layer',
      'database',
      'cache',
      'asynchronism',
      'communication',
      'security',
    ],
  },
  {
    id: 'reference',
    title: 'Reference',
    description: 'Numbers to memorise, more practice questions, and real-world architectures.',
    readme: ['appendix'],
  },
  {
    id: 'system-design',
    title: 'System design questions',
    description: 'Worked solutions with use cases, constraints, diagrams and scaling discussion.',
    files: ['pastebin', 'twitter', 'web_crawler', 'mint', 'social_graph', 'query_cache', 'sales_rank', 'scaling_aws'].map((d) => ({
      id: `design-${d.replace(/_/g, '-')}`,
      file: `solutions/system_design/${d}/README.md`,
    })),
  },
  {
    id: 'ood',
    title: 'Object-oriented design questions',
    description: 'Class design exercises with Python solutions.',
    files: [
      ['hash_table', 'hash_map'],
      ['lru_cache', 'lru_cache'],
      ['call_center', 'call_center'],
      ['deck_of_cards', 'deck_of_cards'],
      ['parking_lot', 'parking_lot'],
      ['online_chat', 'online_chat'],
    ].map(([d, f]) => ({
      id: `ood-${d.replace(/_/g, '-')}`,
      file: `solutions/object_oriented_design/${d}/${f}.ipynb`,
    })),
  },
  // Not from the primer: written for this site from other sources (content-extra/).
  {
    id: 'extra-concepts',
    title: 'Beyond the primer: concepts',
    description: 'Topics the primer leaves out, from estimation to consensus. Written for this site.',
    extra: [
      'estimation',
      'consistent-hashing',
      'rate-limiting',
      'unique-ids',
      'event-streaming',
      'reliability-patterns',
      'distributed-transactions',
      'consensus',
      'realtime',
      'observability',
    ],
  },
  {
    id: 'extra-designs',
    title: 'Beyond the primer: design questions',
    description: 'More worked interview questions, written for this site.',
    extra: [
      'design-key-value-store',
      'design-notification-system',
      'design-chat-system',
      'design-autocomplete',
      'design-video-streaming',
      'design-file-sync',
    ],
  },
  {
    id: 'about',
    title: 'About the primer',
    description: 'The flashcard decks, topics still being written, credits, contributing and the license.',
    // Not study material, so it doesn't count toward progress.
    untracked: true,
    about: ['anki-flashcards', 'under-development', 'contributing', 'credits', 'contact-info', 'license'],
  },
]

const ABOUT_ID = 'about'

// README sections we don't render as chapters, and where links to them should go instead.
const SKIPPED_README_TARGETS = {
  'index-of-system-design-topics': '/',
  'system-design-interview-questions-with-solutions': '/#system-design',
  'object-oriented-design-interview-questions-with-solutions': '/#ood',
}

// Sections too small to track on their own; they're folded into the preceding section.
const FOLD_INTO_PREVIOUS = /^(source\(s\)|disadvantage\(s\)|further reading)/i

// Chapters long enough that "####" headings get their own trackable section too.
const SPLIT_DEEPER = new Set(['database'])

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

/** Split a list of nodes at headings of `depth`..`maxDepth`. Content before the first one becomes "Overview". */
function splitSections(nodes, depth, maxDepth = depth) {
  const sections = []
  let current = { id: 'overview', title: 'Overview', nodes: [] }
  for (const node of nodes) {
    if (node.type === 'heading' && node.depth >= depth && node.depth <= maxDepth) {
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

const truncate = (text, n = 180) => (text.length <= n ? text : text.slice(0, n).replace(/\s+\S*$/, '') + '…')

/** Solutions all open with the same boilerplate, so summarise them by the use cases they cover. */
function useCaseSummary(nodes) {
  const at = nodes.findIndex((n) => n.type === 'heading' && /following use cases?$/i.test(mdToString(n)))
  const list = at === -1 ? null : nodes.slice(at + 1).find((n) => n.type === 'list')
  if (!list) return ''
  const items = list.children.slice(0, 3).map((item) => mdToString(item.children[0]).replace(/\s+/g, ' ').trim())
  return truncate(`Covers: ${items.join('; ')}`)
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
// Link and image rewriting

const chapterByRepoFile = new Map() // 'solutions/system_design/pastebin/README.md' -> chapter id
const readmeAnchors = new Map() // README heading slug -> app URL
const copiedImages = new Set()

const imgurLocal = new Map() // imgur file name -> local copy, for diagrams the decks reference too

for (const part of PARTS) {
  for (const f of part.files ?? []) {
    chapterByRepoFile.set(f.file, f.id)
    chapterByRepoFile.set(path.posix.dirname(f.file), f.id) // links to the folder, e.g. tree/master/solutions/system_design/mint
  }
}

function resolveReadmeAnchor(slug) {
  return readmeAnchors.get(slug) ?? `${REPO_URL}#${slug}`
}

function useImage(repoPath) {
  if (!fs.existsSync(path.join(SRC, repoPath))) return null
  copiedImages.add(repoPath)
  return `/repo/${repoPath}`
}

function rewriteHref(href, ctx) {
  if (href.startsWith('#')) {
    const slug = decodeURIComponent(href.slice(1))
    if (ctx.localAnchors?.has(slug)) return `/learn/${ctx.chapterId}#${slug}`
    return resolveReadmeAnchor(slug)
  }

  const gh = href.match(/^https?:\/\/github\.com\/donnemartin\/system-design-primer\/?(?:(?:blob|tree)\/master\/([^#?]*))?(?:#(.*))?$/)
  if (gh) {
    const [, repoPath, hash] = gh
    if (!repoPath) return hash ? resolveReadmeAnchor(hash) : '/'
    return rewriteRepoPath(decodeURIComponent(repoPath), hash, href)
  }

  if (/^[a-z]+:/i.test(href) || href.startsWith('/')) return href

  const [rel, hash] = href.split('#')
  const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(ctx.file), rel))
  return rewriteRepoPath(repoPath, hash, `${REPO_URL}/blob/master/${repoPath}`)
}

function rewriteRepoPath(repoPath, hash, fallback) {
  const chapterId = chapterByRepoFile.get(repoPath)
  if (chapterId) return `/learn/${chapterId}${hash ? `#${hash}` : ''}`
  if (repoPath === 'README.md') return hash ? resolveReadmeAnchor(hash) : '/'
  const deck = DECKS.find((d) => d.file === repoPath)
  if (deck) return `/flashcards/${deck.id}`
  if (/\.(png|jpe?g|gif)$/i.test(repoPath)) return useImage(repoPath) ?? fallback
  return fallback
}

function rewriteImgSrc(rawSrc, ctx) {
  // Old camo proxy URLs no longer resolve, but the image they wrap usually still does.
  const src = decodeCamo(rawSrc).replace(/^http:\/\/i\.imgur\.com\//, 'https://i.imgur.com/')
  const imgur = src.match(/^https:\/\/i\.imgur\.com\/(\w+\.(?:png|jpe?g|gif))$/i)
  if (imgur) {
    const local =
      useImage(`images/${imgur[1]}`) ?? (ctx?.file.startsWith('solutions/') ? localSolutionDiagram(ctx) : null) ?? imgurLocal.get(imgur[1])
    if (local) imgurLocal.set(imgur[1], local)
    return local ?? src
  }
  if (/^[a-z]+:/i.test(src)) return src
  const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(ctx?.file ?? 'README.md'), src))
  return useImage(repoPath) ?? `${REPO_URL}/raw/master/${repoPath}`
}

// Solution READMEs link some diagrams on imgur that aren't in images/, but the same
// diagrams sit next to the README in order: <name>_basic.png, or <name>_1.png, _2.png...
function localSolutionDiagram(ctx) {
  const dir = path.posix.dirname(ctx.file)
  const name = path.posix.basename(dir)
  ctx.imgurMisses = (ctx.imgurMisses ?? 0) + 1
  const candidates = ctx.imgurMisses === 1 ? [`${name}_basic.png`, `${name}_1.png`] : [`${name}_${ctx.imgurMisses}.png`]
  for (const c of candidates) {
    const found = useImage(`${dir}/${c}`)
    if (found) return found
  }
  return null
}

function rehypeRewrite() {
  return (tree, file) => {
    const ctx = file.data.ctx
    visit(tree, 'element', (node, index, parent) => {
      const p = node.properties
      if (node.tagName === 'a' && typeof p.href === 'string') {
        p.href = rewriteHref(p.href, ctx)
        if (/^https?:/.test(p.href)) {
          p.target = '_blank'
          p.rel = ['noopener', 'noreferrer']
        }
      } else if (node.tagName === 'img' && typeof p.src === 'string') {
        p.src = rewriteImgSrc(p.src, ctx)
        p.loading = 'lazy'
        p.decoding = 'async'
        if (!p.alt || p.alt === 'Imgur') p.alt = 'Diagram'
      } else if (node.tagName === 'p' && p.align === 'center') {
        delete p.align
        p.className = ['figure']
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
// Sources -> chapters

function readmeChapters() {
  const tree = parser.parse(fs.readFileSync(path.join(SRC, 'README.md'), 'utf8'))
  slugHeadings(tree)

  const chapters = new Map()
  let current = null
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 2) {
      current = { id: node.data.id, title: mdToString(node), nodes: [] }
      chapters.set(current.id, current)
    } else if (current) {
      current.nodes.push(node)
    }
  }

  // Map every README heading to where it lives in the app.
  const wanted = new Set(PARTS.flatMap((p) => p.readme ?? []))
  const about = new Set(PARTS.flatMap((p) => p.about ?? []))
  for (const ch of chapters.values()) {
    const inAbout = about.has(ch.id)
    const base = wanted.has(ch.id) ? `/learn/${ch.id}` : inAbout ? `/learn/${ABOUT_ID}` : SKIPPED_README_TARGETS[ch.id]
    readmeAnchors.set(ch.id, inAbout ? `${base}#${ch.id}` : (base ?? `${REPO_URL}#${ch.id}`))
    for (const n of ch.nodes) {
      if (n.type !== 'heading') continue
      readmeAnchors.set(n.data.id, wanted.has(ch.id) || inAbout ? `${base}#${n.data.id}` : (base ?? `${REPO_URL}#${n.data.id}`))
    }
  }

  return chapters
}

/** Several README "##" sections combined into one chapter, each becoming a section. */
function aboutChapter(readme, ids) {
  const nodes = []
  for (const id of ids) {
    const ch = readme.get(id)
    if (!ch) throw new Error(`README section "${id}" not found — did the upstream headings change?`)
    const body = structuredClone(ch.nodes)
    for (const n of body) visit(n, 'heading', (h) => void (h.depth = Math.min(6, h.depth + 1)))
    nodes.push({ type: 'heading', depth: 3, children: [{ type: 'text', value: ch.title }], data: { id, hProperties: { id } } }, ...body)
  }
  return { id: ABOUT_ID, title: 'About the primer', nodes, sectionDepth: 3, ctx: { file: 'README.md', chapterId: ABOUT_ID } }
}

/** Rows of the README's question tables: [{ question, href }] */
function questionRows(readme, id) {
  const rows = []
  visit({ type: 'root', children: readme.get(id)?.nodes ?? [] }, 'tableRow', (row, index) => {
    if (index === 0) return // header
    let href
    visit(row.children[1], 'link', (l) => void (href = l.url))
    rows.push({ question: mdToString(row.children[0]).trim(), href })
  })
  return rows
}

/** Runnable .py files next to a solution, which the solution text only quotes in part. */
async function sourceFiles(file, ctx) {
  const dir = path.posix.dirname(file)
  const names = fs
    .readdirSync(path.join(SRC, dir))
    .filter((f) => f.endsWith('.py') && f !== '__init__.py')
    .sort()
  const out = []
  for (const name of names) {
    const value = fs.readFileSync(path.join(SRC, dir, name), 'utf8').trimEnd()
    const { html } = await renderSection({ id: name, title: name, nodes: [{ type: 'code', lang: 'python', value }] }, ctx)
    out.push({ name, url: `${REPO_URL}/blob/master/${dir}/${name}`, html })
  }
  return out
}

function notebookToMarkdown(file) {
  const nb = JSON.parse(fs.readFileSync(path.join(SRC, file), 'utf8'))
  return nb.cells
    .map((cell) => {
      const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source
      if (cell.cell_type === 'markdown') return /^This notebook was prepared by/.test(src) ? '' : src
      if (cell.cell_type === 'code') {
        const code = src.replace(/^%%writefile.*\n/, '').trim()
        return code ? '```python\n' + code + '\n```' : ''
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function fileChapter({ id, file }) {
  const md = file.endsWith('.ipynb') ? notebookToMarkdown(file) : fs.readFileSync(path.join(SRC, file), 'utf8')
  const tree = parser.parse(md)
  slugHeadings(tree)
  const titleIdx = tree.children.findIndex((n) => n.type === 'heading' && n.depth === 1)
  const title = mdToString(tree.children[titleIdx])
  const nodes = tree.children.filter((_, i) => i !== titleIdx)
  const localAnchors = new Set()
  visit(tree, 'heading', (n) => localAnchors.add(n.data.id))
  return { id, title, nodes, file, sectionDepth: 2, ctx: { file, chapterId: id, localAnchors } }
}

/** An extra chapter: "##" headings become sections, shifted down a level to match the README chapters. */
function extraChapter(id) {
  const file = `content-extra/${id}.md`
  const tree = parser.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  slugHeadings(tree)
  const titleIdx = tree.children.findIndex((n) => n.type === 'heading' && n.depth === 1)
  if (titleIdx === -1) throw new Error(`${file} needs a "# Title" heading.`)
  const title = mdToString(tree.children[titleIdx])
  const nodes = tree.children.filter((_, i) => i !== titleIdx)
  const localAnchors = new Set()
  for (const n of nodes) {
    visit(n, 'heading', (h) => {
      localAnchors.add(h.data.id)
      h.depth = Math.min(6, h.depth + 1)
    })
    visit(n, 'code', (c, index, parent) => {
      if (c.lang !== 'diagram' || !parent) return
      parent.children[index] = { type: 'html', value: renderDiagram(c.value, file) }
    })
  }
  // A diagram can be a top-level block, which the visit above can't replace in place.
  const body = nodes.map((n) => (n.type === 'code' && n.lang === 'diagram' ? { type: 'html', value: renderDiagram(n.value, file) } : n))
  return { id, title, nodes: body, sectionDepth: 3, ctx: { file, chapterId: id, localAnchors } }
}

// ---------------------------------------------------------------------------
// Build

fs.rmSync(OUT_CONTENT, { recursive: true, force: true })
fs.rmSync(OUT_REPO, { recursive: true, force: true })
fs.mkdirSync(OUT_CONTENT, { recursive: true })
fs.mkdirSync(path.dirname(OUT_MANIFEST), { recursive: true })

const readme = readmeChapters()

function extraExists(id) {
  if (fs.existsSync(path.join(EXTRA, `${id}.md`))) return true
  console.warn(`  Skipping extra chapter "${id}": content-extra/${id}.md doesn't exist yet.`)
  return false
}
const primerIds = new Set([...readme.keys(), ABOUT_ID, ...chapterByRepoFile.values()])
for (const id of PARTS.flatMap((p) => p.extra ?? [])) {
  if (primerIds.has(id)) throw new Error(`Extra chapter id "${id}" is already used by a primer chapter. Rename the file.`)
}
const manifest = { generatedAt: new Date().toISOString(), parts: [], decks: [] }
const searchDocs = []

// The README's question tables: alternative wordings of solved questions, and questions without a solution yet.
const questionTables = {
  'system-design': questionRows(readme, 'system-design-interview-questions-with-solutions'),
  ood: questionRows(readme, 'object-oriented-design-interview-questions-with-solutions'),
}

for (const part of PARTS) {
  const sources = part.readme
    ? part.readme.map((id) => {
        const ch = readme.get(id)
        if (!ch) throw new Error(`README section "${id}" not found — did the upstream headings change?`)
        return { ...ch, sectionDepth: 3, maxSectionDepth: SPLIT_DEEPER.has(id) ? 4 : 3, ctx: { file: 'README.md', chapterId: id } }
      })
    : part.about
      ? [aboutChapter(readme, part.about)]
      : part.extra
        ? part.extra.filter(extraExists).map(extraChapter)
        : part.files.map(fileChapter)
  const rows = questionTables[part.id] ?? []

  const chapters = []
  for (const src of sources) {
    // Sequential on purpose: image fallbacks depend on document order.
    const sections = []
    for (const s of splitSections(src.nodes, src.sectionDepth, src.maxSectionDepth)) sections.push(await renderSection(s, src.ctx))
    const words = sections.reduce((n, s) => n + s.text.split(' ').length, 0)

    const files = src.file ? await sourceFiles(src.file, src.ctx) : []

    fs.writeFileSync(
      path.join(OUT_CONTENT, `${src.id}.json`),
      JSON.stringify({ id: src.id, title: src.title, sections: sections.map(({ text, ...s }) => s), sourceFiles: files }),
    )
    for (const s of sections) {
      searchDocs.push({
        id: `${src.id}#${s.id}`,
        chapterId: src.id,
        sectionId: s.id,
        chapterTitle: src.title,
        title: s.title,
        text: s.text.slice(0, 6000),
      })
    }
    const asked = rows.find((r) => r.href && chapterByRepoFile.get(path.posix.normalize(r.href)) === src.id)
    chapters.push({
      id: src.id,
      title: src.title,
      ...(asked && asked.question !== src.title ? { alsoAsked: asked.question } : {}),
      ...(part.untracked ? { untracked: true } : {}),
      ...(part.extra ? { extra: true } : {}),
      summary: useCaseSummary(src.nodes) || firstSentenceSummary(src.nodes),
      minutes: Math.max(1, Math.round(words / 220)),
      sections: sections.map((s) => ({ id: s.id, title: s.title })),
    })
  }
  const unsolved = rows.filter((r) => r.href === '#contributing' && !/^Add /.test(r.question)).map((r) => r.question)
  manifest.parts.push({
    id: part.id,
    title: part.title,
    description: part.description,
    ...(part.untracked ? { untracked: true } : {}),
    ...(part.extra ? { extra: true } : {}),
    ...(unsolved.length ? { unsolved } : {}),
    chapters,
  })
}

// Decks link each card to the chapter or heading with the same title, when there is one.
const chapterHrefByTitle = new Map(manifest.parts.flatMap((p) => p.chapters.map((c) => [c.title.toLowerCase(), `/learn/${c.id}`])))
manifest.decks = await buildDecks({
  srcDir: SRC,
  outDir: path.join(OUT_CONTENT, 'flashcards'),
  rewriteHref: (href) => rewriteHref(href, { file: 'README.md' }),
  rewriteImg: (src) => rewriteImgSrc(src, null),
  hrefForTitle: (title) => {
    const byChapter = chapterHrefByTitle.get(title.toLowerCase())
    if (byChapter) return byChapter
    const url = readmeAnchors.get(slugOnce(title))
    return url?.startsWith('/') ? url : undefined
  },
})

for (const repoPath of copiedImages) {
  const dest = path.join(OUT_REPO, repoPath)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(path.join(SRC, repoPath), dest)
}

fs.writeFileSync(path.join(OUT_CONTENT, 'search.json'), JSON.stringify(searchDocs))
fs.writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2))

const chapterCount = manifest.parts.reduce((n, p) => n + p.chapters.length, 0)
const cardCount = manifest.decks.reduce((n, d) => n + d.cardIds.length, 0)
console.log(`Built ${chapterCount} chapters, ${searchDocs.length} sections, ${cardCount} flashcards, ${copiedImages.size} images.`)
