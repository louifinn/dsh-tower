// Gate for the config reference (#M64).
//
// `domain/config/schema.js` is the single source for the config surface: key
// list, section count, defaults and descriptions. This check fails when
//   - the generated page drifts from the schema,
//   - a row is missing, duplicated, out of order or carries a stale default,
//   - the generated header counts stop matching the schema/baseline,
//   - a hand-written config page grows a per-key table, or
//   - a hand-written config page does not link the generated page at a path
//     that resolves from that page and exists on disk.
// `npm run docs:check:generated:config` runs this file; the generator's
// `--check` byte-compares the same render, so the two entry points cannot
// disagree on content.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Config, configSurface, resolveTowerConfig } from '../domain/config/schema.js'
import { readBaseline } from './lib/surface.mjs'
import {
  CONFIG_REFERENCE_FILE,
  configReferenceRows,
  renderConfigReference,
} from './generate-config-reference.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Hand-written pages that must link the generated reference, not restate it. */
const HAND_CONFIG_PAGES = ['docs/reference/config.md', 'docs/zh/reference/config.md']
/** A row whose first cell is a config key (`group.child` or a top-level key). */
const HAND_KEY_ROW = /^\|\s*`(?:section|allowAgentControl|[a-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*)`\s*\|/m
const TABLE_ROW = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|(.*)\|\s*$/
const HEADER = /config keys: (\d+) · sections: (\d+) · tools: (\d+) · baseline (\d{4}-\d{2}-\d{2})/
/** A local markdown link target: `[text](target)`; group 1 is the target. */
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g

/**
 * Resolve each link in a hand-written page to the generated config reference
 * relative to that page. Matching the basename alone cannot see a dead path
 * such as `docs/zh/reference/config.generated.md`, so callers compare the
 * resolved path with `CONFIG_REFERENCE_FILE` and check the file exists.
 *
 * @param {string} text markdown source of the page
 * @param {string} page repo-relative page path
 * @returns {{ target: string, resolved: string }[]}
 */
export function generatedReferenceLinks(text, page) {
  const links = []
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const target = match[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) continue
    const [withoutAnchor] = target.split('#')
    if (withoutAnchor === '') continue
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page), withoutAnchor))
    if (path.posix.basename(resolved) === path.posix.basename(CONFIG_REFERENCE_FILE)) {
      links.push({ target, resolved })
    }
  }
  return links
}

/**
 * @param {{ root?: string }} [options]
 * @returns {{ problems: string[] }}
 */
export function checkConfigReference({ root = repoRoot } = {}) {
  const problems = []
  const generated = path.join(root, CONFIG_REFERENCE_FILE)
  const actual = fs.existsSync(generated) ? fs.readFileSync(generated, 'utf8') : ''

  let expected = ''
  let baseline = null
  try {
    expected = renderConfigReference({ root })
    baseline = readBaseline(root)
  } catch (error) {
    problems.push(`cannot render the reference: ${error.message}`)
  }

  if (actual === '') {
    problems.push(`${CONFIG_REFERENCE_FILE} is missing; run npm run docs:generate:config`)
  } else if (expected !== '' && actual !== expected) {
    problems.push(`${CONFIG_REFERENCE_FILE} is stale; run npm run docs:generate:config`)
  }

  const surface = configSurface()
  const defaults = resolveTowerConfig({})
  const expectedRows = new Map(configReferenceRows(Config, defaults).map((row) => [row.key, row]))
  const lines = actual.split(/\r?\n/)

  const headerLine = lines.find((line) => line.startsWith('> Surface:')) ?? ''
  const header = headerLine.match(HEADER)
  if (!header) {
    problems.push(`${CONFIG_REFERENCE_FILE} is missing the generated surface header`)
  } else {
    const [, keys, sections, tools, date] = header
    if (Number(keys) !== surface.count) {
      problems.push(`header says ${keys} config keys but the schema has ${surface.count}`)
    }
    if (Number(sections) !== surface.sections.length) {
      problems.push(`header says ${sections} sections but the schema has ${surface.sections.length}`)
    }
    if (baseline !== null) {
      if (Number(tools) !== baseline.surfaces.tools.value) {
        problems.push(`header says ${tools} tools but the surface baseline has ${baseline.surfaces.tools.value}`)
      }
      if (date !== baseline.date) {
        problems.push(`header baseline ${date} does not match the surface baseline ${baseline.date}`)
      }
    }
  }

  const rows = []
  const seen = new Set()
  for (const line of lines) {
    const match = line.match(TABLE_ROW)
    if (!match) continue
    const [, key, value, description] = match
    if (seen.has(key)) problems.push(`row \`${key}\` appears more than once`)
    seen.add(key)
    rows.push(key)
    if (description.trim() === '') {
      problems.push(`row \`${key}\` has no description; describe it in domain/config/schema.js`)
    }
    const expectedRow = expectedRows.get(key)
    if (expectedRow === undefined) {
      problems.push(`row \`${key}\` is not a live config key`)
    } else if (expectedRow.value !== value) {
      problems.push(`default for \`${key}\` is \`${value}\`; the schema resolves \`${expectedRow.value}\``)
    }
  }

  for (const key of surface.keys) {
    if (!seen.has(key)) problems.push(`row \`${key}\` is missing from the generated reference`)
  }
  if (rows.length !== surface.count) {
    problems.push(`reference has ${rows.length} keys; the schema has ${surface.count}`)
  } else if (rows.some((key, index) => key !== surface.keys[index])) {
    problems.push('reference key order differs from the schema order')
  }

  for (const page of HAND_CONFIG_PAGES) {
    const file = path.join(root, page)
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (text === '') {
      problems.push(`${page} is missing`)
      continue
    }
    if (HAND_KEY_ROW.test(text)) {
      problems.push(`${page} restates config keys in a hand-maintained table; the schema is the single source (link ${CONFIG_REFERENCE_FILE})`)
    }
    const links = generatedReferenceLinks(text, page)
    if (links.length === 0) {
      problems.push(`${page} must link ${CONFIG_REFERENCE_FILE} from the page`)
      continue
    }
    for (const link of links) {
      if (link.resolved !== CONFIG_REFERENCE_FILE) {
        problems.push(`${page} links ${link.target}, which resolves to ${link.resolved}; the generated page is ${CONFIG_REFERENCE_FILE}`)
      } else if (!fs.existsSync(path.join(root, link.resolved))) {
        problems.push(`${page} links ${link.target}, but ${link.resolved} does not exist`)
      }
    }
  }

  return { problems }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const rootArg = process.argv.indexOf('--root')
  const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : repoRoot
  const { problems } = checkConfigReference({ root })
  if (problems.length > 0) {
    console.error('config reference check failed:')
    for (const problem of problems) console.error(`- ${problem}`)
    process.exit(1)
  }
  console.log(`config reference: ${configSurface().count} keys in sync`)
}
