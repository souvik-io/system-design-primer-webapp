// Checks the generated site for broken links and missing redirects.
//
// 1. Every internal link and image in chapters and flashcards must point at a
//    chapter, heading, deck or file that exists.
// 2. Every old chapter id in content/redirects.json must have a redirect in vercel.json
//    to the same place, so links from elsewhere keep working.
//
// Exits with code 1 when something is wrong. Run after `npm run content`.

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONTENT = path.join(ROOT, 'public/content')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/generated/manifest.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Internal links

const chapterData = new Map()
for (const part of manifest.parts) {
  for (const ch of part.chapters) chapterData.set(ch.id, JSON.parse(fs.readFileSync(path.join(CONTENT, `${ch.id}.json`), 'utf8')))
}

const anchorsByChapter = new Map()
for (const [id, data] of chapterData) {
  const ids = new Set([id, ...data.sections.map((s) => s.id)])
  for (const s of data.sections) for (const [, a] of s.html.matchAll(/\sid="([^"]+)"/g)) ids.add(a)
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
  if (pathname.startsWith('/labs/')) return fs.existsSync(path.join(ROOT, 'public', decodeURIComponent(pathname))) ? null : 'file missing'
  if (pathname.startsWith('/diagrams/')) return fs.existsSync(path.join(ROOT, 'public', decodeURIComponent(pathname))) ? null : 'file missing'
  return 'unknown internal route'
}

const links = [] // [where, url]
const collect = (where, html) => {
  // Only real tags: example markup inside code blocks is escaped, so it never starts with "<".
  for (const [, url] of html.matchAll(/<(?:a|img)\b[^>]*?\s(?:href|src)="(\/[^"]*)"/g)) links.push([where, url])
}
for (const [id, data] of chapterData) for (const s of data.sections) collect(`chapter ${id}`, s.html)
for (const d of manifest.decks) {
  const deck = JSON.parse(fs.readFileSync(path.join(CONTENT, 'flashcards', `${d.id}.json`), 'utf8'))
  if (deck.cards.length !== d.cardIds.length) links.push([`deck ${d.id}`, '(card count differs from manifest)'])
  for (const c of deck.cards) {
    collect(`card "${c.front}"`, c.back)
    if (c.href) links.push([`card "${c.front}" course link`, c.href])
  }
}
// Where old chapters, headings and decks are sent must exist too.
const movedChapters = { ...manifest.redirects.renamed, ...manifest.redirects.replaced }
for (const [old, to] of Object.entries(movedChapters)) links.push([`redirect of chapter "${old}"`, `/learn/${to}`])
for (const [old, to] of Object.entries(manifest.redirects.anchors)) links.push([`redirect of "${old}"`, `/learn/${to}`])

const broken = links.map(([where, url]) => [where, url, brokenReason(url)]).filter(([, , r]) => r)
console.log(`Internal links and images: ${links.length - broken.length}/${links.length} resolve`)
for (const [where, url, reason] of broken.slice(0, 20)) console.log(`  ✗ ${where}: ${url} (${reason})`)
if (broken.length > 20) console.log(`  … and ${broken.length - 20} more`)

// ---------------------------------------------------------------------------
// Redirects for search engines and links from other sites. The app redirects too, but only once it loads.

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'))
const served = new Map((vercel.redirects ?? []).map((r) => [r.source, r.destination]))
// A renamed chapter kept its headings, so the browser's #fragment still works. A replaced one carries
// ?from= so the app can look the old heading up in the anchors map.
const expected = (old) =>
  old in manifest.redirects.renamed
    ? `/learn/${manifest.redirects.renamed[old]}`
    : `/learn/${manifest.redirects.replaced[old].split('#')[0]}?from=${old}`
const missing = []
for (const old of Object.keys(movedChapters)) {
  const want = expected(old)
  if (served.get(`/learn/${old}`) !== want) missing.push(`/learn/${old} -> ${want}`)
}
for (const [old, to] of Object.entries(manifest.redirects.decks)) {
  for (const suffix of ['', '/browse']) {
    const want = `/flashcards/${to}${suffix}`
    if (served.get(`/flashcards/${old}${suffix}`) !== want) missing.push(`/flashcards/${old}${suffix} -> ${want}`)
  }
}
console.log(`\nRedirects in vercel.json: ${missing.length ? `${missing.length} missing or wrong` : 'all present'}`)
for (const m of missing) console.log(`  ✗ ${m}`)

const problems = broken.length + missing.length
console.log(problems ? `\n${problems} problems found.` : '\nNo problems found.')
process.exitCode = problems ? 1 : 0
