// Converts the primer's Anki decks (resources/flash_cards/*.apkg) into JSON for the app.
//
// An .apkg is a zip holding a SQLite database. Each note has a Front and a Back field
// containing HTML copied from GitHub, with inline styles, anchor icons and camo-proxied
// images. We keep the content and drop the presentation.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { unified } from 'unified'
import rehypeParse from 'rehype-parse'
import rehypeShiki from '@shikijs/rehype'
import rehypeStringify from 'rehype-stringify'
import { toString as hastToString } from 'hast-util-to-string'

export const DECKS = [
  {
    id: 'system-design',
    file: 'resources/flash_cards/System Design.apkg',
    title: 'System design concepts',
    description: 'One card per topic. Recall what it is, how it works and its trade-offs.',
  },
  {
    id: 'exercises',
    file: 'resources/flash_cards/System Design Exercises.apkg',
    title: 'System design exercises',
    description: 'Talk through a full design out loud, then compare it with the worked solution.',
  },
  {
    id: 'ood',
    file: 'resources/flash_cards/OO Design.apkg',
    title: 'Object-oriented design',
    description: 'Sketch the classes and their relationships, then compare with the Python solution.',
  },
]

function readNotes(apkgPath) {
  const files = unzipSync(fs.readFileSync(apkgPath))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-anki-'))
  try {
    const dbPath = path.join(dir, 'collection.anki2')
    fs.writeFileSync(dbPath, files['collection.anki2'])
    const db = new DatabaseSync(dbPath, { readOnly: true })
    // Cards are ordered by their position in the deck, which follows the primer's order.
    const rows = db.prepare('SELECT n.id, n.flds FROM notes n JOIN cards c ON c.nid = n.id ORDER BY c.due, c.id').all()
    db.close()
    return rows.map((r) => {
      const [front, back] = String(r.flds).split('\x1f')
      return { id: String(r.id), front, back }
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** camo.githubusercontent.com/<digest>/<hex of original url> -> original url */
export function decodeCamo(src) {
  const m = src.match(/^https?:\/\/camo\.githubusercontent\.com\/[0-9a-f]+\/([0-9a-f]+)$/i)
  return m ? Buffer.from(m[1], 'hex').toString('utf8') : src
}

const DROP = new Set(['svg', 'script', 'style', 'meta', 'link'])
const UNWRAP = new Set(['span', 'div', 'font', 'figure', 'section', 'article'])
const KEEP_ATTRS = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'loading', 'decoding'],
  td: ['colSpan', 'rowSpan'],
  th: ['colSpan', 'rowSpan'],
}
// The card's front is the title, so headings on the back sit below it.
const HEADING = { h1: 'h3', h2: 'h3', h3: 'h4', h4: 'h5', h5: 'h5', h6: 'h5' }

function rehypeCleanCard({ rewriteHref, rewriteImg }) {
  const hasImage = (node) => node.tagName === 'img' || (node.children ?? []).some(hasImage)
  const isBlank = (node) =>
    node.tagName === 'p' &&
    !hastToString(node)
      .replace(/\u00a0/g, ' ')
      .trim() &&
    !hasImage(node)

  const clean = (parent, lang) => {
    const out = []
    for (const node of parent.children) {
      if (node.type === 'comment') continue
      if (node.type !== 'element') {
        out.push(node)
        continue
      }
      const cls = [].concat(node.properties.className ?? [])
      if (DROP.has(node.tagName)) continue
      if (node.tagName === 'a' && cls.some((c) => c === 'anchor' || c === 'anchor-link')) continue

      const nodeLang = cls.some((c) => /python/.test(c)) ? 'python' : lang

      // Code arrives as GitHub's token spans. Flatten it and let the highlighter redo it.
      if (node.tagName === 'pre') {
        out.push({
          type: 'element',
          tagName: 'pre',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'code',
              properties: { className: [`language-${nodeLang ?? 'text'}`] },
              // Notebook cells start with a Jupyter "%%writefile" line that isn't part of the solution.
              children: [{ type: 'text', value: hastToString(node).replace(/^%%writefile.*\n/, '') }],
            },
          ],
        })
        continue
      }

      clean(node, nodeLang)
      if (UNWRAP.has(node.tagName)) {
        out.push(...node.children)
        continue
      }

      node.tagName = HEADING[node.tagName] ?? node.tagName
      const p = node.properties
      if (node.tagName === 'a' && typeof p.href === 'string') {
        p.href = rewriteHref(p.href)
        if (/^https?:/.test(p.href)) Object.assign(p, { target: '_blank', rel: ['noopener', 'noreferrer'] })
      } else if (node.tagName === 'img' && typeof p.src === 'string') {
        Object.assign(p, { src: rewriteImg(decodeCamo(p.src)), alt: 'Diagram', loading: 'lazy', decoding: 'async' })
      }
      const keep = KEEP_ATTRS[node.tagName] ?? []
      node.properties = Object.fromEntries(Object.entries(p).filter(([k]) => keep.includes(k)))

      if (isBlank(node)) continue
      if (node.tagName === 'table') {
        out.push({ type: 'element', tagName: 'div', properties: { className: ['table-wrap'] }, children: [node] })
        continue
      }
      out.push(node)
    }
    parent.children = out
  }

  return (tree) => clean(tree)
}

/**
 * Build every deck. Writes public/content/flashcards/<deck>.json and returns
 * the deck outline for the manifest.
 */
export async function buildDecks({ srcDir, outDir, rewriteHref, rewriteImg, hrefForTitle }) {
  const processor = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeCleanCard, { rewriteHref, rewriteImg })
    .use(rehypeShiki, { themes: { light: 'github-light', dark: 'github-dark' }, defaultLanguage: 'text', fallbackLanguage: 'text' })
    .use(rehypeStringify)

  fs.mkdirSync(outDir, { recursive: true })
  const outline = []

  for (const deck of DECKS) {
    const cards = []
    for (const note of readNotes(path.join(srcDir, deck.file))) {
      const front = hastToString(unified().use(rehypeParse, { fragment: true }).parse(note.front))
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const back = String(await processor.process(note.back))
      cards.push({ id: note.id, front, back, href: hrefForTitle(front) })
    }
    fs.writeFileSync(path.join(outDir, `${deck.id}.json`), JSON.stringify({ id: deck.id, title: deck.title, cards }))
    outline.push({ id: deck.id, title: deck.title, description: deck.description, cardIds: cards.map((c) => c.id) })
  }
  return outline
}
