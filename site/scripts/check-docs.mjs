// Checks the things the build cannot.
//
// `linkValidationPlugin` fetches every rendered link, which catches a page that moved
// or vanished. But it strips the `#fragment` before fetching, so nothing verifies the
// 68 anchors in docs/ — a renamed heading breaks them silently and the build stays
// green. Raw HTML has the same shape of problem: it is dropped during compilation
// rather than rejected, so a re-introduced <br/> disappears without a word.
//
// Run against the source files, not the build, so it also protects the GitHub view.

import { readFile } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import GithubSlugger from 'github-slugger'

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs')

const FENCE = /^\s*(```|~~~)/
const LINK = /\]\(([^)\s]+)\)/g
const HTML = /<\/?[a-zA-Z][a-zA-Z0-9]*\s*\/?>/

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.md')) out.push(p)
  }
  return out
}

/** Split a file into (prose lines, fenced-code lines) so we never inspect code. */
function prose(text) {
  const lines = text.split('\n')
  const out = []
  let inFence = false
  let tok = null
  for (const [i, line] of lines.entries()) {
    const m = FENCE.exec(line)
    if (m) {
      if (!inFence) { inFence = true; tok = m[1] }
      else if (m[1] === tok) { inFence = false; tok = null }
      continue
    }
    if (!inFence) out.push([i + 1, line])
  }
  return out
}

/** The slugs GitHub and fumadocs both generate — they use the same slugger. */
function headingSlugs(text) {
  const slugger = new GithubSlugger()
  const slugs = new Set()
  for (const [, line] of prose(text)) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!m) continue
    const title = m[2].replace(/`/g, '').trim()
    slugs.add(slugger.slug(title))
  }
  return slugs
}

const files = walk(DOCS)
const slugCache = new Map()
async function slugsFor(path) {
  if (!slugCache.has(path)) slugCache.set(path, headingSlugs(await readFile(path, 'utf8')))
  return slugCache.get(path)
}

const problems = []

for (const file of files) {
  const text = await readFile(file, 'utf8')
  const rel = relative(DOCS, file)

  for (const [lineNo, line] of prose(text)) {
    // (c) raw HTML — silently deleted at compile time, so it must never come back.
    const withoutCode = line.replace(/`[^`]*`/g, '')
    if (HTML.test(withoutCode)) {
      problems.push(`${rel}:${lineNo}  raw HTML is stripped during compilation: ${withoutCode.trim().slice(0, 60)}`)
    }

    for (const m of line.matchAll(LINK)) {
      const href = m[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) continue

      const [target, hash] = href.split('#')

      // (b) same-page anchor
      if (!target) {
        if (hash && !(await slugsFor(file)).has(hash)) {
          problems.push(`${rel}:${lineNo}  #${hash} matches no heading on this page`)
        }
        continue
      }

      if (!target.endsWith('.md')) continue

      // (a) the target file exists on disk
      const resolved = resolve(dirname(file), target)
      if (!files.includes(resolved)) {
        problems.push(`${rel}:${lineNo}  ${target} does not exist`)
        continue
      }

      // (b) the anchor exists in the target
      if (hash && !(await slugsFor(resolved)).has(hash)) {
        problems.push(`${rel}:${lineNo}  ${target}#${hash} matches no heading in ${relative(DOCS, resolved)}`)
      }
    }
  }
}

if (problems.length) {
  console.error(`check-docs: ${problems.length} problem(s)\n`)
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}

console.log(`check-docs: ${files.length} files, all links and anchors resolve, no raw HTML`)
