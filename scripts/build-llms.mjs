// Runs after `vite build` and makes the course readable without JavaScript, for search engines,
// AI crawlers and LLM tools:
//
//   dist/learn/<id>.md     each chapter as Markdown
//   dist/llms.txt          an index of the chapters in the llms.txt format (https://llmstxt.org)
//   dist/llms-full.txt     the whole course in one Markdown file
//   dist/learn/<id>.html   each chapter prerendered into the app's HTML, so the text is in the page
//   dist/index.html        the course overview prerendered the same way
//   dist/app.html          the empty app shell, served for every other route (see vercel.json)
//   dist/robots.txt, dist/sitemap.xml
//
// Set SITE_URL (in .env.local, .env or the environment) to the address the site is served from, e.g.
// https://handbook.example.com. Without it, links are root-relative and there's no sitemap,
// since sitemaps need full URLs.

import fs from 'node:fs'
import path from 'node:path'
import { unified } from 'unified'
import rehypeParse from 'rehype-parse'
import rehypeRemark from 'rehype-remark'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { visit, SKIP } from 'unist-util-visit'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/generated/manifest.json'), 'utf8'))

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(path.join(ROOT, file)) // doesn't override variables already set
  } catch {
    /* no such file */
  }
}
const SITE = (process.env.SITE_URL ?? '').replace(/\/+$/, '')
if (SITE && !/^https?:\/\//.test(SITE)) throw new Error(`SITE_URL should start with https://, got "${SITE}".`)
const abs = (p) => (SITE && p.startsWith('/') ? SITE + p : p)

if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('Run `vite build` first: dist/index.html is missing.')
const shell = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
if (!shell.includes('<div id="root"></div>')) throw new Error('dist/index.html has already been prerendered. Run `npm run build` again.')

const SITE_NAME = 'System Design Handbook'
// The second course on the site, at /infra (parts with handbook: 'infra' in the manifest).
const INFRA_NAME = 'AI Infrastructure Engineer Handbook'
const INFRA_DESCRIPTION =
  'Inference from kernels to clusters: how models run on GPUs, how serving engines schedule them, and how to make them fast and cheap. Each chapter has a lab.'
const bookName = (part) => (part.handbook === 'infra' ? INFRA_NAME : SITE_NAME)
const bookHome = (part) => (part.handbook === 'infra' ? '/infra' : '/')
const DESCRIPTION =
  'A free course in system design, from the interview method to databases, caches and worked designs, with progress tracking and flashcards.'

// ---------------------------------------------------------------------------
// HTML -> Markdown

/** Tidies the app's HTML for Markdown: drops interactive diagram slots and turns drawn diagrams into text. */
function forMarkdown() {
  return (tree) => {
    visit(tree, 'element', (node, index, parent) => {
      if (!parent) return
      const p = node.properties
      if (p.dataWidget) {
        parent.children.splice(index, 1)
        return [SKIP, index]
      }
      if (node.tagName === 'figure' && p.className?.includes('diagram')) {
        const caption = node.children.find((c) => c.tagName === 'figcaption')
        const title = caption ? caption.children.map((c) => c.value ?? '').join('') : ''
        parent.children[index] = {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            { type: 'element', tagName: 'em', properties: {}, children: [{ type: 'text', value: `Diagram${title ? `: ${title}` : ''}` }] },
            { type: 'text', value: p.dataText ? ` ${p.dataText}` : '' },
          ],
        }
        return SKIP
      }
      if (node.tagName === 'a' && typeof p.href === 'string') p.href = abs(p.href)
      if (node.tagName === 'img' && typeof p.src === 'string') p.src = abs(p.src)
    })
  }
}

const toMarkdown = unified()
  .use(rehypeParse, { fragment: true })
  .use(forMarkdown)
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify, { bullet: '-', emphasis: '_', rule: '-', fences: true })

const md = (html) => String(toMarkdown.processSync(html)).trim()

// ---------------------------------------------------------------------------
// Chapters

const chapters = manifest.parts.flatMap((part) => part.chapters.map((c) => ({ ...c, part })))
const load = (id) => JSON.parse(fs.readFileSync(path.join(DIST, 'content', `${id}.json`), 'utf8'))

function chapterMarkdown(c, body) {
  const parts = [`# ${c.title}`, `> From the ${bookName(c.part)}, part "${c.part.title}". Web page: ${abs(`/learn/${c.id}`)}`]
  for (const s of body.sections) parts.push(md(s.html))
  return parts.join('\n\n') + '\n'
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The app shell with this page's title and description, and its content in place of the empty root. */
function page({ urlPath, title, description, body, markdown, preload }) {
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:type" content="${urlPath === '/' ? 'website' : 'article'}" />`,
    SITE && `<link rel="canonical" href="${SITE}${urlPath}" />`,
    SITE && `<meta property="og:url" content="${SITE}${urlPath}" />`,
    markdown && `<link rel="alternate" type="text/markdown" href="${markdown}" />`,
    preload && `<link rel="preload" href="${preload}" as="fetch" crossorigin />`,
  ]
    .filter(Boolean)
    .join('\n    ')
  return shell
    .replace(/<title>.*?<\/title>/, head)
    .replace(/\s*<meta name="description"[^>]*>/, '')
    .replace('<div id="root"></div>', `<div id="root"><div class="prerender">${body}</div></div>`)
}

const nav = `<p class="prerender-nav"><a href="/">${SITE_NAME}</a> · <a href="/llms.txt">llms.txt</a></p>`

fs.mkdirSync(path.join(DIST, 'learn'), { recursive: true })
const full = []

for (const [i, c] of chapters.entries()) {
  const body = load(c.id)
  const markdown = chapterMarkdown(c, body)
  fs.writeFileSync(path.join(DIST, 'learn', `${c.id}.md`), markdown)
  full.push(markdown)

  // Previous and next stay inside the chapter's own handbook.
  const prev = chapters[i - 1]?.part.handbook === c.part.handbook ? chapters[i - 1] : undefined
  const next = chapters[i + 1]?.part.handbook === c.part.handbook ? chapters[i + 1] : undefined
  const article = [
    nav,
    `<p><a href="${bookHome(c.part)}#${c.part.id}">${esc(c.part.title)}</a></p>`,
    `<h1>${esc(c.title)}</h1>`,
    ...body.sections.map((s) => `<section class="article">${s.html}</section>`),
    `<p>${prev ? `Previous: <a href="/learn/${prev.id}">${esc(prev.title)}</a>` : ''}${prev && next ? ' · ' : ''}${
      next ? `Next: <a href="/learn/${next.id}">${esc(next.title)}</a>` : ''
    }</p>`,
  ].join('\n')
  fs.writeFileSync(
    path.join(DIST, 'learn', `${c.id}.html`),
    page({
      urlPath: `/learn/${c.id}`,
      title: `${c.title} | ${bookName(c.part)}`,
      description: c.summary || `${c.title}, from the ${bookName(c.part)}.`,
      body: article,
      markdown: `/learn/${c.id}.md`,
      preload: `/content/${c.id}.json`,
    }),
  )
}

// ---------------------------------------------------------------------------
// Index pages

const tracked = chapters.filter((c) => !c.untracked && c.part.handbook !== 'infra')
const intro =
  `A free, open-source course in designing large-scale systems, in ${tracked.length} chapters: how to run a system design interview, ` +
  `the core trade-offs, building blocks from DNS to databases and caches, deeper concepts such as consistent hashing and consensus, ` +
  `worked system design and object-oriented design questions, and reference material. Each chapter lists its sources under Further reading.`

const llms = [`# ${SITE_NAME}`, `> ${intro}`]
llms.push(
  `Each chapter is available as Markdown at \`/learn/<chapter-id>.md\`, and the whole course is in one file at [llms-full.txt](${abs('/llms-full.txt')}).`,
)
for (const part of manifest.parts) {
  const optional = part.untracked
  llms.push(
    `## ${optional ? 'Optional' : part.handbook === 'infra' ? `${INFRA_NAME}: ${part.title}` : part.title}`,
    part.chapters.map((c) => `- [${c.title}](${abs(`/learn/${c.id}.md`)})${c.summary ? `: ${c.summary}` : ''}`).join('\n'),
  )
}
fs.writeFileSync(path.join(DIST, 'llms.txt'), llms.join('\n\n') + '\n')
fs.writeFileSync(path.join(DIST, 'llms-full.txt'), [`# ${SITE_NAME}`, `> ${intro}`, ...full].join('\n\n---\n\n'))

const partList = (parts) =>
  parts.map(
    (part) =>
      `<section id="${part.id}"><h2>${esc(part.title)}</h2><p>${esc(part.description)}</p><ul>${part.chapters
        .map((c) => `<li><a href="/learn/${c.id}">${esc(c.title)}</a>${c.summary ? `: ${esc(c.summary)}` : ''}</li>`)
        .join('')}</ul></section>`,
  )
const infraParts = manifest.parts.filter((p) => p.handbook === 'infra')
fs.writeFileSync(
  path.join(DIST, 'infra.html'),
  page({
    urlPath: '/infra',
    title: INFRA_NAME,
    description: INFRA_DESCRIPTION,
    body: [nav, `<h1>${INFRA_NAME}</h1>`, `<p>${esc(INFRA_DESCRIPTION)}</p>`, ...partList(infraParts)].join('\n'),
  }),
)

const home = [
  nav,
  `<h1>${SITE_NAME}</h1>`,
  `<p>${esc(intro)}</p>`,
  `<p><a href="/infra">${INFRA_NAME}</a>: ${esc(INFRA_DESCRIPTION)}</p>`,
  ...manifest.parts
    .filter((p) => p.handbook !== 'infra')
    .map(
      (part) =>
        `<section id="${part.id}"><h2>${esc(part.title)}</h2><p>${esc(part.description)}</p><ul>${part.chapters
          .map((c) => `<li><a href="/learn/${c.id}">${esc(c.title)}</a>${c.summary ? `: ${esc(c.summary)}` : ''}</li>`)
          .join('')}</ul></section>`,
    ),
].join('\n')

// Every route without its own page gets the empty shell, so it doesn't flash the overview.
fs.writeFileSync(path.join(DIST, 'app.html'), shell)
fs.writeFileSync(
  path.join(DIST, 'index.html'),
  page({
    urlPath: '/',
    title: SITE_NAME,
    description: DESCRIPTION,
    body: home,
    markdown: '/llms.txt',
  }),
)

const urls = ['/', '/infra', '/flashcards', ...chapters.map((c) => `/learn/${c.id}`)]
fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n${SITE ? `\nSitemap: ${SITE}/sitemap.xml\n` : ''}`)
if (SITE) {
  const today = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(
    path.join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`)
      .join('\n')}\n</urlset>\n`,
  )
} else fs.rmSync(path.join(DIST, 'sitemap.xml'), { force: true })

const kb = (f) => Math.round(fs.statSync(path.join(DIST, f)).size / 1024)
console.log(
  `Wrote ${chapters.length} Markdown chapters and prerendered pages, llms.txt (${kb('llms.txt')} KB), llms-full.txt (${kb('llms-full.txt')} KB), robots.txt` +
    (SITE ? `, sitemap.xml for ${SITE}.` : '. Set SITE_URL for full URLs and a sitemap.'),
)
