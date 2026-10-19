// Checks that the generated site still contains everything from the primer.
//
// 1. Every paragraph, heading, list item, table cell, code block and image in the
//    source files is looked up in the rendered chapters. Anything not found is
//    reported, unless it's in a part we leave out on purpose (listed below).
// 2. Every internal link and image in chapters and flashcards must point at a
//    chapter, heading, deck or file that exists.
//
// Exits with code 1 when something is wrong. Run after `npm run content`.

import fs from 'node:fs'
import path from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import { toString as mdToString } from 'mdast-util-to-string'
import { decodeCamo } from './flashcards.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'source-repo')
const CONTENT = path.join(ROOT, 'public/content')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/generated/manifest.json'), 'utf8'))

// Text is compared with all whitespace removed, so line wrapping and indentation don't matter.
const squash = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, '')

const htmlToText = (html) => html.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '')

// Parts of the source we leave out on purpose: [where, test, reason]
const INTENTIONAL = [
  ['*', (b) => /^This notebook was prepared by/.test(b.text), 'Notebook attribution line (the site footer credits the author)'],
  ['(before first heading)', () => true, 'Language links and translation request (translations are not included)'],
  ['The System Design Primer', () => true, 'Page title (the site header replaces it)'],
  ['Index of system design topics', () => true, 'Table of contents (the sidebar and home page replace it)'],
  ['System design interview questions with solutions', () => true, 'Index of solutions (each is a chapter; other wordings show as "Also asked as")'],
  [
    'Object-oriented design interview questions with solutions',
    () => true,
    'Index of solutions (each is a chapter; unsolved ones are listed on the home page)',
  ],
]
// Diagrams from primer solutions that a chapter written for this site now replaces (see content-extra/).
const replacedSolutionImages = new Set(
  fs
    .readdirSync(path.join(SRC, 'solutions/system_design'))
    .filter((dir) => fs.existsSync(path.join(ROOT, 'content-extra', `design-${dir.replace(/_/g, '-')}.md`)))
    .flatMap((dir) => {
      const f = path.join(SRC, 'solutions/system_design', dir, 'README.md')
      return fs.existsSync(f) ? [...fs.readFileSync(f, 'utf8').matchAll(/imgur\.com\/(\w+\.\w+)/g)].map((m) => m[1]) : []
    }),
)
INTENTIONAL.push([
  '*',
  (b) => b.kind === 'image' && replacedSolutionImages.has(path.basename(b.text)),
  'Diagram from a design solution that a chapter written for this site replaces',
])
const intentionalReason = (b) => INTENTIONAL.find(([where, test]) => (where === '*' || where === b.chapter) && test(b))?.[2]

let siteText = ''
const siteImages = new Set()
const imageCountByChapter = new Map()
const chapterData = new Map()
for (const part of manifest.parts) {
  siteText += squash(part.title + (part.unsolved ?? []).join(''))
  for (const ch of part.chapters) {
    const data = JSON.parse(fs.readFileSync(path.join(CONTENT, `${ch.id}.json`), 'utf8'))
    chapterData.set(ch.id, data)
    siteText += squash(data.title + (ch.alsoAsked ?? '')) // rendered by the page, not the HTML
    for (const s of data.sections) {
      siteText += squash(htmlToText(s.html))
      for (const [, src] of s.html.matchAll(/<img[^>]*src="([^"]+)"/g)) {
        siteImages.add(src)
        imageCountByChapter.set(ch.id, (imageCountByChapter.get(ch.id) ?? 0) + 1)
      }
    }
  }
}

const parser = unified().use(remarkParse).use(remarkGfm)

/** Visible text of a markdown node: inline HTML contributes its text, images contribute nothing. */
function text(node) {
  if (node.type === 'image') return ''
  if (node.type === 'html') return node.value.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
  if ('value' in node) return node.value
  return (node.children ?? []).map(text).join('')
}

/** Collect the checkable blocks of a markdown document, tagged with the "##" chapter they sit in. */
function blocks(md) {
  const out = []
  let chapter = '(before first heading)'
  const tree = parser.parse(md)
  for (const top of tree.children) {
    if (top.type === 'heading' && top.depth <= 2) chapter = mdToString(top)
    visit(top, (node) => {
      if (['paragraph', 'heading', 'tableCell'].includes(node.type)) {
        const t = text(node)
        if (t.trim()) out.push({ chapter, kind: node.type, text: t })
        visit(node, 'image', (img) => {
          out.push({ chapter, kind: 'image', text: img.url })
        })
        return 'skip'
      }
      if (node.type === 'code') out.push({ chapter, kind: 'code', text: node.value })
      if (node.type === 'html') {
        const t = text(node).trim()
        if (t) out.push({ chapter, kind: 'html', text: t })
      }
    })
  }
  for (const [, src] of md.matchAll(/<img[^>]*src="([^"]+)"/g)) out.push({ chapter, kind: 'image', text: src })
  return out
}

function imageFound(src) {
  const name = path.basename(decodeCamo(src).split('?')[0])
  for (const s of siteImages) if (s === src || path.basename(s) === name) return true
  return false
}

function check(label, md, chapterId) {
  const missing = []
  const all = blocks(md)
  for (const b of all) {
    const ok = b.kind === 'image' ? imageFound(b.text) : siteText.includes(squash(b.text))
    if (!ok) missing.push(b)
  }
  // Solution diagrams hosted on imgur are swapped for local copies with different names.
  // Accept that when the chapter renders as many images as the source has.
  const sourceImages = all.filter((b) => b.kind === 'image').length
  if (chapterId && imageCountByChapter.get(chapterId) === sourceImages) {
    return { label, total: all.length, missing: missing.filter((b) => !(b.kind === 'image' && /imgur\.com/.test(b.text))) }
  }
  return { label, total: all.length, missing }
}

function notebookMarkdown(file) {
  const nb = JSON.parse(fs.readFileSync(file, 'utf8'))
  return nb.cells
    .map((c) => {
      const src = Array.isArray(c.source) ? c.source.join('') : c.source
      return c.cell_type === 'code' ? '```\n' + src.replace(/^%%writefile.*\n/, '') + '\n```' : src
    })
    .join('\n\n')
}

const results = [check('README.md', fs.readFileSync(path.join(SRC, 'README.md'), 'utf8'))]
for (const dir of fs.readdirSync(path.join(SRC, 'solutions/system_design'))) {
  const f = path.join(SRC, 'solutions/system_design', dir, 'README.md')
  // A chapter written for this site replaces this one; COVERAGE.md tracks what it has to cover.
  if (fs.existsSync(f) && !fs.existsSync(path.join(ROOT, 'content-extra', `design-${dir.replace(/_/g, '-')}.md`)))
    results.push(check(`solutions/system_design/${dir}/README.md`, fs.readFileSync(f, 'utf8'), `design-${dir.replace(/_/g, '-')}`))
}
for (const dir of fs.readdirSync(path.join(SRC, 'solutions/object_oriented_design'))) {
  const d = path.join(SRC, 'solutions/object_oriented_design', dir)
  for (const f of fs.readdirSync(d).filter((f) => f.endsWith('.ipynb'))) {
    results.push(check(`solutions/object_oriented_design/${dir}/${f}`, notebookMarkdown(path.join(d, f))))
  }
}

console.log('Content coverage')
let unexpected = 0
const skipped = new Map()
for (const r of results) {
  const real = []
  for (const b of r.missing) {
    const reason = intentionalReason(b)
    if (reason) skipped.set(reason, (skipped.get(reason) ?? 0) + 1)
    else real.push(b)
  }
  unexpected += real.length
  console.log(`  ${real.length ? '✗' : '✓'} ${r.label}: ${r.total - r.missing.length}/${r.total} blocks on the site`)
  for (const [chapter, items] of Map.groupBy(real, (b) => b.chapter)) {
    console.log(`      in "${chapter}": ${items.length} missing`)
    for (const b of items.slice(0, 4)) console.log(`        - [${b.kind}] ${b.text.replace(/\s+/g, ' ').slice(0, 90)}`)
    if (items.length > 4) console.log(`        … and ${items.length - 4} more`)
  }
}
console.log('\n  Left out on purpose:')
for (const [reason, n] of skipped) console.log(`    ${String(n).padStart(3)}  ${reason}`)

// ---------------------------------------------------------------------------
// Internal links

const anchorsByChapter = new Map()
for (const [id, data] of chapterData) {
  const ids = new Set([id, ...data.sections.map((s) => s.id)])
  for (const s of data.sections) for (const [, a] of s.html.matchAll(/\sid="([^"]+)"/g)) ids.add(a)
  if (data.sourceFiles?.length) ids.add('source-code')
  anchorsByChapter.set(id, ids)
}
const deckIds = new Set(manifest.decks.map((d) => d.id))
const partIds = new Set(manifest.parts.map((p) => p.id))

function brokenReason(url) {
  const [pathname, hash] = url.split('#')
  if (pathname === '/') return hash && !partIds.has(hash) ? `no part "${hash}" on the home page` : null
  if (pathname.startsWith('/learn/')) {
    const id = pathname.slice('/learn/'.length)
    if (!anchorsByChapter.has(id)) return `no chapter "${id}"`
    if (hash && !anchorsByChapter.get(id).has(decodeURIComponent(hash))) return `no heading "${hash}" in ${id}`
    return null
  }
  if (pathname.startsWith('/flashcards')) {
    const deck = pathname.split('/')[2]
    return deck && !deckIds.has(deck) ? `no deck "${deck}"` : null
  }
  if (pathname.startsWith('/repo/')) return fs.existsSync(path.join(ROOT, 'public', decodeURIComponent(pathname))) ? null : 'file missing'
  if (pathname.startsWith('/diagrams/')) return fs.existsSync(path.join(ROOT, 'public', decodeURIComponent(pathname))) ? null : 'file missing'
  return 'unknown internal route'
}

const links = [] // [where, url]
const collect = (where, html) => {
  // Only real tags: example markup inside code blocks is escaped, so it never starts with "<".
  for (const [, url] of html.matchAll(/<(?:a|img)\b[^>]*?\s(?:href|src)="(\/[^"]*)"/g)) links.push([where, url])
}
for (const [id, data] of chapterData) {
  for (const s of data.sections) collect(`chapter ${id}`, s.html)
  for (const f of data.sourceFiles ?? []) collect(`chapter ${id} (${f.name})`, f.html)
}
for (const d of manifest.decks) {
  const deck = JSON.parse(fs.readFileSync(path.join(CONTENT, 'flashcards', `${d.id}.json`), 'utf8'))
  if (deck.cards.length !== d.cardIds.length) links.push([`deck ${d.id}`, '(card count differs from manifest)'])
  for (const c of deck.cards) {
    collect(`card "${c.front}"`, c.back)
    if (c.href) links.push([`card "${c.front}" course link`, c.href])
  }
}

const broken = links.map(([where, url]) => [where, url, brokenReason(url)]).filter(([, , r]) => r)
console.log(`\nInternal links and images: ${links.length - broken.length}/${links.length} resolve`)
for (const [where, url, reason] of broken.slice(0, 20)) console.log(`  ✗ ${where}: ${url} (${reason})`)
if (broken.length > 20) console.log(`  … and ${broken.length - 20} more`)

const problems = unexpected + broken.length
console.log(problems ? `\n${problems} problems found.` : '\nNo problems found.')
process.exitCode = problems ? 1 : 0
