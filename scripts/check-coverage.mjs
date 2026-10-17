// Checks content-extra/COVERAGE.md, the list of every topic in The System Design Primer and the
// chapter section on this site that covers it.
//
// Every filled-in target must point at a chapter and heading that exist. Empty rows are topics
// still to be written; with --strict they fail the check, so the primer can't be removed while
// anything it teaches has no home here.
//
// Run after `npm run content`.

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONTENT = path.join(ROOT, 'public/content')
const strict = process.argv.includes('--strict')

const rows = fs
  .readFileSync(path.join(ROOT, 'content-extra/COVERAGE.md'), 'utf8')
  .split('\n')
  .filter((line) => line.startsWith('| ') && !line.startsWith('| Topic') && !line.startsWith('| ---'))
  .map((line) => {
    const cells = line.slice(2, -2).split(/(?<!\\) \| /)
    return { topic: cells[0].replace(/\\\|/g, '|'), target: (cells[1] ?? '').trim() }
  })

// Heading ids per chapter, from the built JSON: section ids plus any id="" in the rendered HTML.
const headings = new Map()
function chapterHeadings(id) {
  if (headings.has(id)) return headings.get(id)
  const file = path.join(CONTENT, `${id}.json`)
  const ids = fs.existsSync(file) ? new Set() : null
  if (ids) {
    const raw = fs.readFileSync(file, 'utf8')
    for (const [, h] of raw.matchAll(/"id":\s*"([^"]+)"/g)) ids.add(h)
    for (const [, h] of raw.matchAll(/id=\\"([^"\\]+)\\"/g)) ids.add(h)
  }
  headings.set(id, ids)
  return ids
}

const problems = []
const open = []
for (const { topic, target } of rows) {
  if (!target) {
    open.push(topic)
    continue
  }
  const [chapter, heading] = target.split('#')
  const ids = chapterHeadings(chapter)
  if (!ids) problems.push(`"${topic}" points at chapter "${chapter}", which doesn't exist`)
  else if (heading && !ids.has(heading)) problems.push(`"${topic}" points at "${target}", but that chapter has no heading "${heading}"`)
}

const covered = rows.length - open.length
console.log(`Primer coverage: ${covered} of ${rows.length} topics have a home on this site.`)
for (const p of problems) console.log(`  ✗ ${p}`)
if (open.length) {
  console.log(`${open.length} still to write${strict ? ':' : ' (run with --strict to list them and fail).'}`)
  if (strict) for (const t of open) console.log(`  - ${t}`)
}
if (problems.length || (strict && open.length)) process.exit(1)
