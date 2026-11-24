// Documentation consistency check: tool names, blocker codes, error codes,
// process-local events, hand-written surface counts and local links must not
// drift from the implementation. The Chinese reference pages must cover the same
// names and state the same counts. Run: node scripts/check-docs.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_COUNT, LEGACY_TOOL_EVENT_NAMES } from '../domain/events.js'
import { ERROR_CODES } from '../domain/errors.js'
import { BLOCKER_CODE_VALUES } from '../domain/shapes/blockers.js'
import { configSurface } from '../domain/config/schema.js'
import { COMPONENT_SURFACE_FILE, parseComponentSurface } from '../domain/components.js'
import { LEGACY_TOOL_REPLACEMENTS } from '../host/tool-profiles.js'
import { FOREIGN_CAPABILITIES } from '../host/doctor-acceptance.js'
import { DENY_OWNER_TOOLS } from '../domain/generated/deny-surface.js'
import { CAPABILITY_STANCE, CAPABILITY_STANCES } from '../domain/vocabulary.js'
import { SURFACE_BASELINE_FILE } from '../domain/surface.js'
import { toolBytes } from './lib/profile-surface.mjs'
import { loadShippedToolSurface } from './lib/tool-surface.mjs'
import { parseArgs, runMain } from './lib/cli.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `usage: node scripts/check-docs.mjs [--root <dir>]

  --root   repository root to check (default: this package)
  --help   print this text

Checks the hand-written reference pages, the READMEs and the architecture
overview against the live registries, and verifies that relative markdown links
resolve. Fails with one line per problem.`

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g
const FENCED_CODE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g

/**
 * Every relative link in the docs tree and the top-level READMEs must point at a
 * file that exists. Anchors are not resolved; external, protocol-relative,
 * root-absolute and same-page links are not repository references.
 *
 * @param {string} root repository root
 * @returns {string[]} one problem per missing target
 */
export function linkProblems(root = packageRoot) {
  const pages = []
  const docs = path.join(root, 'docs')
  if (fs.existsSync(docs)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.md')) pages.push(full)
      }
    }
    walk(docs)
  }
  for (const name of ['README.md', 'README.en.md', 'GLOSSARY.md']) {
    if (fs.existsSync(path.join(root, name))) pages.push(path.join(root, name))
  }
  const problems = []
  for (const page of pages.sort()) {
    // Links shown as examples inside code are not references.
    const text = fs.readFileSync(page, 'utf8').replace(FENCED_CODE, '').replace(INLINE_CODE, '')
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const target = match[1]
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(target)) continue
      const [withoutAnchor] = target.split('#')
      if (!withoutAnchor) continue
      const resolved = path.resolve(path.dirname(page), withoutAnchor)
      if (!fs.existsSync(resolved)) {
        problems.push(`${path.relative(root, page)} links to missing ${target}`)
      }
    }
  }
  return problems
}

// F56: #163 folded five view tools and four same-resource pairs into
// `tower_inspect`, `tower_init`, `tower_finding`, `tower_mode` and
// `tower_import`. A retired name left in a current page teaches the reader to
// call a tool that does not exist, which the count checks above cannot see.
// History stays history, but an exemption must be as narrow as the history it
// protects:
//  - ADRs and the CHANGELOG are not current pages at all (the walk skips them);
//  - doctor.md keeps one paragraph that deliberately lists the old names, and
//    `withoutRetiredNameParagraph` removes exactly that paragraph;
//  - the marked 2.9.0 migration block may pair an old name with its replacement,
//    and only when the same list item also names the replacement tool;
//  - any other allowance is a file + fragment entry that carries its reason.
const RETIRED_TOOL_NAMES = Object.keys(LEGACY_TOOL_REPLACEMENTS)

/** The live tool a retired name folded into: `tower_status` -> `tower_inspect`. */
const REPLACEMENT_TOOL = Object.fromEntries(
  Object.entries(LEGACY_TOOL_REPLACEMENTS).map(([retired, replacement]) => [
    retired,
    replacement.match(/tower_[a-z_]+/)[0],
  ]),
)

/**
 * Deliberate history that must keep naming a retired tool. Each entry is scoped
 * to one file plus one fragment of the enclosing paragraph; `reason` records why
 * the current-tense rule must not apply there.
 */
const RETIRED_NAME_EXEMPTIONS = Object.freeze([
  {
    file: 'docs/reference/surface-budget.md',
    fragment: 'registrations that were uncounted at 2.3.0',
    reason: 'the 2.3.0 measurement correction must name the second uncounted registration, and the same paragraph says which tool it folded into',
  },
  {
    file: 'ui-bundle/README.md',
    fragment: 'is still read from older history',
    reason: 'the dock still derives the stance from a pre-2.9.0 history entry; client.mode.js owns that reader',
  },
])

/**
 * Marked migration blocks: a retired name is allowed only between the begin/end
 * markers of its own file, and with `pairsWithReplacement` only when the
 * enclosing list item names the replacement. A missing marker fails the check
 * instead of silently widening it.
 */
const RETIRED_NAME_BLOCKS = Object.freeze([
  {
    file: 'docs/guide/install-upgrade-migration.md',
    begin: '<!-- tower-retired-names:begin 2.9.0-migration -->',
    end: '<!-- tower-retired-names:end 2.9.0-migration -->',
    pairsWithReplacement: true,
  },
  {
    file: 'docs/zh/guide/install-upgrade-migration.md',
    begin: '<!-- tower-retired-names:begin 2.9.0-migration -->',
    end: '<!-- tower-retired-names:end 2.9.0-migration -->',
    pairsWithReplacement: true,
  },
])

/** Markdown the tarball ships that is release history rather than a current page. */
const HISTORY_PAGES = new Set(['CHANGELOG.md'])

/** Match a package.json `files` pattern (`*`, `**`) against a slash path. */
function filesPatternMatches(pattern, relative) {
  const parts = pattern.split('/')
  const target = relative.split('/')
  const segmentMatches = (segment, value) => {
    if (!segment.includes('*')) return segment === value
    const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    return new RegExp(`^${escaped}$`).test(value)
  }
  const matchFrom = (patternIndex, valueIndex) => {
    if (patternIndex === parts.length) return valueIndex === target.length
    if (parts[patternIndex] === '**') {
      for (let next = valueIndex; next <= target.length; next += 1) {
        if (matchFrom(patternIndex + 1, next)) return true
      }
      return false
    }
    return (
      valueIndex < target.length &&
      segmentMatches(parts[patternIndex], target[valueIndex]) &&
      matchFrom(patternIndex + 1, valueIndex + 1)
    )
  }
  return matchFrom(0, 0)
}

/** Markdown under a shipped directory, repo-relative; ADR history stays out. */
function markdownUnder(root, directory) {
  const base = path.join(root, directory)
  const pages = []
  if (!fs.existsSync(base)) return pages
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'adr') walk(full)
      } else if (entry.name.endsWith('.md')) {
        pages.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  walk(base)
  return pages.sort()
}

/**
 * The markdown pages the package ships, read from package.json `files` so a
 * newly shipped page cannot be forgotten: a positive file entry is taken as-is,
 * a positive directory entry is walked recursively for `*.md` (so `skills/` and
 * `ui-bundle/` are covered, not only a README), and `!` exclusions apply to both.
 * Plus the contributor test guide (`tests/` is not in the tarball but is
 * current-facing documentation).
 */
function shippedMarkdown(root) {
  let entries = []
  try {
    entries = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files ?? []
  } catch {
    entries = []
  }
  const excludes = entries
    .filter((entry) => entry.startsWith('!'))
    .map((entry) => entry.slice(1))
  const excluded = (page) => excludes.some((pattern) => filesPatternMatches(pattern, page))
  const pages = new Set()
  for (const entry of entries) {
    if (entry.startsWith('!')) continue
    const candidates = entry.endsWith('.md')
      ? [entry]
      : entry.endsWith('/')
        ? markdownUnder(root, entry.slice(0, -1))
        : []
    for (const page of candidates) {
      if (HISTORY_PAGES.has(page) || excluded(page)) continue
      pages.add(page)
    }
  }
  pages.add('tests/README.md')
  return [...pages].sort()
}

/**
 * Every current-facing markdown page: the docs tree except ADRs, the shipped
 * markdown from package.json `files` (READMEs, COMPATIBILITY, GLOSSARY, SECURITY,
 * CONTRIBUTING, PRINCIPLES, ui-bundle/README.md, skills/*.md) and tests/README.md.
 * Exported so a test can assert a shipped page was not dropped from the scan.
 */
export function currentDocPages(root) {
  const pages = new Set()
  const docs = path.join(root, 'docs')
  if (fs.existsSync(docs)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'adr') walk(full)
        } else if (entry.name.endsWith('.md')) {
          pages.add(full)
        }
      }
    }
    walk(docs)
  }
  for (const name of shippedMarkdown(root)) {
    const full = path.join(root, name)
    if (fs.existsSync(full)) pages.add(full)
  }
  return [...pages].sort()
}

/**
 * Remove the deliberately historical paragraph that documents retired names
 * (doctor.md's `deprecated-tool-names` check). The paragraph ends at the next
 * blank line.
 */
function withoutRetiredNameParagraph(text) {
  const kept = []
  let skipping = false
  for (const line of text.split('\n')) {
    if (skipping) {
      if (line.trim() === '') {
        skipping = false
        kept.push(line)
      }
      continue
    }
    if (line.includes('deprecated-tool-names')) {
      skipping = true
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/** Contiguous non-blank lines around `index`: the enclosing paragraph. */
function paragraphBounds(lines, index) {
  let start = index
  while (start > 0 && lines[start - 1].trim() !== '') start -= 1
  let end = index
  while (end < lines.length - 1 && lines[end + 1].trim() !== '') end += 1
  return [start, end]
}

const BULLET = /^\s*(?:[-*+]|\d+\.)\s/

/** The enclosing markdown list item: its bullet line through the next bullet or blank line. */
function listItemBounds(lines, index) {
  let start = index
  if (!BULLET.test(lines[index])) {
    while (start > 0) {
      const previous = lines[start - 1]
      if (previous.trim() === '') break
      start -= 1
      if (BULLET.test(previous)) break
    }
  }
  let end = start
  while (end < lines.length - 1) {
    const next = lines[end + 1]
    if (next.trim() === '' || BULLET.test(next)) break
    end += 1
  }
  return [start, end]
}

/** Line range of a marked block, or null when either marker is gone. */
function blockBounds(lines, block) {
  const begin = lines.findIndex((line) => line.trim() === block.begin)
  if (begin < 0) return null
  const end = lines.findIndex((line, index) => index > begin && line.trim() === block.end)
  return end < 0 ? null : [begin, end]
}

/** A paragraph that carries one of this file's exempt fragments may name retired tools. */
function exemptParagraph(exemptions, lines, index) {
  if (exemptions.length === 0) return false
  const [start, end] = paragraphBounds(lines, index)
  const paragraph = lines.slice(start, end + 1).join('\n')
  return exemptions.some((entry) => paragraph.includes(entry.fragment))
}

/** Inside a pairing block, the same list item must also name the replacement tool. */
function pairsWithReplacement(block, lines, index, name) {
  if (block.pairsWithReplacement !== true) return true
  const [start, end] = listItemBounds(lines, index)
  const item = lines.slice(start, end + 1).join('\n')
  return new RegExp(`\\b${REPLACEMENT_TOOL[name]}\\b`).test(item)
}

/**
 * The reference tool tables are hand-written in two languages, so a row added to
 * one of them alone is invisible to the English-only checks (#F60). The first
 * cell of every row is the tool name, which makes the row *set* comparable
 * without diffing the prose.
 *
 * @param {string} text a `docs/<language>/reference/tools.md` page
 * @returns {string[]} sorted tool names in the table's first column
 */
export function toolTableNames(text) {
  const names = new Set()
  for (const line of text.split('\n')) {
    const match = line.match(/^\|\s*`(tower_[a-z0-9_]+)`\s*\|/)
    if (match) names.add(match[1])
  }
  return [...names].sort()
}

/** One row of a reference tool table, by first-cell name; '' when absent. */
function toolRow(text, name) {
  return text.split('\n').find((line) => line.startsWith(`| \`${name}\` `)) ?? ''
}

/**
 * English and Chinese `reference/tools.md` must list the same tool rows, and the
 * `tower_spawn` row in both must keep the placement semantics its output schema
 * carries: a branch worktree has a `worktree` object, a survey gets `null`. This
 * is a set/shape check, not a word-for-word translation comparison.
 *
 * @param {string} root repository root
 * @returns {string[]} one problem per missing row or lost placement sentence
 */
export function toolTableRowProblems(root = packageRoot) {
  const enPage = 'docs/reference/tools.md'
  const zhPage = 'docs/zh/reference/tools.md'
  const problems = []
  if (!fs.existsSync(path.join(root, enPage))) return problems
  // A missing translation tree is reported by the parity block, not twice here.
  if (!fs.existsSync(path.join(root, zhPage))) return problems

  const enText = fs.readFileSync(path.join(root, enPage), 'utf8')
  const zhText = fs.readFileSync(path.join(root, zhPage), 'utf8')
  const enNames = toolTableNames(enText)
  const zhNames = toolTableNames(zhText)
  const missingInZh = enNames.filter((name) => !zhNames.includes(name))
  const missingInEn = zhNames.filter((name) => !enNames.includes(name))
  if (missingInZh.length > 0) problems.push(`${zhPage} is missing tool rows: ${missingInZh.join(', ')}`)
  if (missingInEn.length > 0) problems.push(`${enPage} is missing tool rows: ${missingInEn.join(', ')}`)

  for (const [page, text] of [[enPage, enText], [zhPage, zhText]]) {
    const row = toolRow(text, 'tower_spawn')
    if (row === '') {
      problems.push(`${page} has no table row for tower_spawn`)
      continue
    }
    if (!row.includes('`worktree`')) {
      problems.push(`${page}: the tower_spawn row must name the worktree placement`)
    }
    if (!/\bnull\b/.test(row)) {
      problems.push(`${page}: the tower_spawn row must state that a survey placement is null`)
    }
  }
  return problems
}

/** The page that carries the Tower-mode denied-capability table (#191). */
export const DENY_DOC_PAGE = 'docs/reference/deny.md'
/** The required Chinese mirror: same rows, translated prose and header labels. */
export const DENY_DOC_PAGE_ZH = 'docs/zh/reference/deny.md'
const DENY_TABLE_BEGIN = '<!-- tower-deny-table:begin -->'
const DENY_TABLE_END = '<!-- tower-deny-table:end -->'
const DENY_TABLE_COLUMNS = ['capability', 'denied tools', 'stance', 'replacement', 'coverage', 'cost']
const DENY_COVERAGE = new Set(['full', 'partial', 'none'])
const DENY_NO_TOOLS = '—'

/** Split one markdown table line into trimmed cells. */
function denyTableCells(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** The backticked tokens in a cell, in order. */
function denyCellTokens(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1])
}

/**
 * Split a page into the rows between the deny-table markers. The English page
 * must use the canonical column labels; the Chinese mirror translates them, so
 * for that page only the column count is enforced — the row ids, stance,
 * coverage and tool cells stay mechanically identical.
 *
 * @param {string} text the page
 * @param {string} page repo-relative path, for problem messages
 * @param {{ requireEnglishHeader?: boolean }} [options]
 */
function parseDenyTable(text, page, { requireEnglishHeader = true } = {}) {
  const problems = []
  const begin = text.indexOf(DENY_TABLE_BEGIN)
  const end = text.indexOf(DENY_TABLE_END)
  if (begin === -1) problems.push(`${page} is missing the "${DENY_TABLE_BEGIN}" marker`)
  if (end === -1) problems.push(`${page} is missing the "${DENY_TABLE_END}" marker`)
  if (begin === -1 || end === -1 || end < begin) return { problems, rows: [] }
  const lines = text
    .slice(begin + DENY_TABLE_BEGIN.length, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length < 2) {
    problems.push(`${page}: the deny table needs a header row and at least one capability row`)
    return { problems, rows: [] }
  }
  const header = denyTableCells(lines[0])
  if (header.length !== DENY_TABLE_COLUMNS.length) {
    problems.push(`${page}: the deny table needs ${DENY_TABLE_COLUMNS.length} columns, found ${header.length}`)
  }
  header.forEach((cell, index) => {
    if (!requireEnglishHeader) return
    const expected = DENY_TABLE_COLUMNS[index]
    if (expected !== undefined && cell.toLowerCase() !== expected) {
      problems.push(`${page}: deny table column ${index + 1} must be "${expected}", found "${cell}"`)
    }
  })
  const rows = []
  for (const line of lines.slice(2)) {
    const cells = denyTableCells(line)
    if (cells.length !== DENY_TABLE_COLUMNS.length) {
      problems.push(`${page}: deny table row "${cells[0]}" has ${cells.length} columns, expected ${DENY_TABLE_COLUMNS.length}`)
      continue
    }
    const idMatch = cells[0].match(/^`([a-z0-9-]+)`$/)
    if (!idMatch) {
      problems.push(`${page}: deny table row ${JSON.stringify(cells[0])} must start with a backticked capability id`)
      continue
    }
    rows.push({ id: idMatch[1], cells })
  }
  return { problems, rows }
}

/** Coverage cell with optional markdown emphasis removed. */
function denyCoverage(cell) {
  return cell.replace(/[`*_]/g, '').trim()
}

/** Replacement/stance/coverage rules shared by the English page and its mirror. */
function denyRowShapeProblems(page, row) {
  const problems = []
  const [, toolsCell, stanceCell, replacement, coverageCell, cost] = row.cells
  const stance = stanceCell.replace(/`/g, '').trim()
  const coverage = denyCoverage(coverageCell)
  if (!CAPABILITY_STANCES.includes(stance)) {
    problems.push(`${page}: ${row.id} stance ${JSON.stringify(stance)} is not one of ${CAPABILITY_STANCES.join(', ')}`)
  }
  if (!DENY_COVERAGE.has(coverage)) {
    problems.push(`${page}: ${row.id} coverage ${JSON.stringify(coverage)} must be full, partial or none`)
  }
  if (cost.trim() === '') problems.push(`${page}: ${row.id} must record the cost of denial`)
  if (coverage === 'none') {
    if (!/^none\b/i.test(replacement)) {
      problems.push(`${page}: ${row.id} has coverage none, so its replacement must start with "none"`)
    }
  } else if (!denyCellTokens(replacement).some((token) => token.startsWith('tower_'))) {
    problems.push(`${page}: ${row.id} has coverage ${coverage}, so its replacement must name at least one tower_ tool`)
  }
  return problems
}

/** Validate one owner row: tools equal the deny surface, stance is deny, coverage valid. */
function denyOwnerRowProblems(page, row, tools) {
  const problems = denyRowShapeProblems(page, row)
  const [toolsCell, stanceCell] = [row.cells[1], row.cells[2]]
  const actual = denyCellTokens(toolsCell).sort()
  const missing = tools.filter((name) => !actual.includes(name))
  const extra = actual.filter((name) => !tools.includes(name))
  if (missing.length > 0) problems.push(`${page}: ${row.id} is missing denied tools: ${missing.join(', ')}`)
  if (extra.length > 0) problems.push(`${page}: ${row.id} names tools the deny surface does not record: ${extra.join(', ')}`)
  const stance = stanceCell.replace(/`/g, '').trim()
  if (stance !== CAPABILITY_STANCE.deny) {
    problems.push(`${page}: ${row.id} is a denied owner, so its stance must be "${CAPABILITY_STANCE.deny}"`)
  }
  return problems
}

/**
 * The `deny.md` table must list every owner in the generated deny surface and
 * every warned foreign capability from `host/doctor-acceptance.js`, with the
 * stance vocabulary those modules export, a coverage value and a cost. A deny
 * surface entry without a row fails here; an owner tool added upstream fails on
 * the tools cell. The required Chinese mirror must carry the same rows in the
 * same order with the same stance/coverage/tool cells (#191).
 *
 * @param {string} root repository root
 * @param {{ owners?: Record<string, string[]>, capabilities?: readonly { id: string, stance: string }[] }} [expected]
 *   test seam: seed a capability that is not documented yet
 * @returns {string[]} one problem per missing, extra or malformed row
 */
export function denyTableProblems(root = packageRoot, expected = {}) {
  const owners = expected.owners ?? DENY_OWNER_TOOLS
  const capabilities = expected.capabilities ?? FOREIGN_CAPABILITIES
  const page = path.join(root, DENY_DOC_PAGE)
  if (!fs.existsSync(page)) {
    return [`${DENY_DOC_PAGE} is missing (the Tower-mode denied capabilities and replacements table)`]
  }
  const parsed = parseDenyTable(fs.readFileSync(page, 'utf8'), DENY_DOC_PAGE)
  const problems = [...parsed.problems]
  const ownerIds = Object.keys(owners)
  const expectedIds = [...ownerIds, ...capabilities.map((capability) => capability.id)]
  const rowIds = parsed.rows.map((row) => row.id)
  const seen = new Set()
  for (const id of rowIds) {
    if (seen.has(id)) problems.push(`${DENY_DOC_PAGE}: duplicate deny table row for ${id}`)
    seen.add(id)
  }
  const missing = expectedIds.filter((id) => !seen.has(id))
  if (missing.length > 0) {
    problems.push(
      `${DENY_DOC_PAGE} is missing deny table rows for: ${missing.join(', ')}; add one row per denied or warned capability and run \`npm run docs:check\``,
    )
  }
  const extra = rowIds.filter((id) => !expectedIds.includes(id))
  if (extra.length > 0) {
    problems.push(`${DENY_DOC_PAGE} has deny table rows for capabilities Tower neither denies nor warns: ${extra.join(', ')}`)
  }
  for (const row of parsed.rows) {
    if (ownerIds.includes(row.id)) {
      problems.push(...denyOwnerRowProblems(DENY_DOC_PAGE, row, owners[row.id] ?? []))
      continue
    }
    const capability = capabilities.find((entry) => entry.id === row.id)
    if (!capability) continue
    problems.push(...denyRowShapeProblems(DENY_DOC_PAGE, row))
    const stance = row.cells[2].replace(/`/g, '').trim()
    const toolsCell = row.cells[1].trim()
    if (toolsCell !== DENY_NO_TOOLS && toolsCell !== '-') {
      problems.push(`${DENY_DOC_PAGE}: ${row.id} is not a tool owner, so its denied-tools cell must be "${DENY_NO_TOOLS}"`)
    }
    if (stance !== capability.stance) {
      problems.push(`${DENY_DOC_PAGE}: ${row.id} stance ${JSON.stringify(stance)} must match the live stance ${JSON.stringify(capability.stance)}`)
    }
  }
  const zhPage = path.join(root, DENY_DOC_PAGE_ZH)
  if (!fs.existsSync(zhPage)) {
    problems.push(
      `${DENY_DOC_PAGE_ZH} is missing (the Chinese mirror of ${DENY_DOC_PAGE}); translate the page and keep its table rows identical`,
    )
  } else {
    const zh = parseDenyTable(fs.readFileSync(zhPage, 'utf8'), DENY_DOC_PAGE_ZH, {
      requireEnglishHeader: false,
    })
    problems.push(...zh.problems)
    const zhIds = zh.rows.map((row) => row.id)
    if (zhIds.join(',') !== rowIds.join(',')) {
      problems.push(`${DENY_DOC_PAGE_ZH} must list the same rows in the same order as ${DENY_DOC_PAGE}`)
    }
    for (const row of parsed.rows) {
      const mirror = zh.rows.find((entry) => entry.id === row.id)
      if (!mirror) {
        problems.push(`${DENY_DOC_PAGE_ZH} is missing the ${row.id} row`)
        continue
      }
      const stance = row.cells[2].replace(/`/g, '').trim()
      const mirrorStance = mirror.cells[2].replace(/`/g, '').trim()
      if (mirrorStance !== stance) {
        problems.push(`${DENY_DOC_PAGE_ZH}: ${row.id} stance ${JSON.stringify(mirrorStance)} must match the English row ${JSON.stringify(stance)}`)
      }
      const coverage = denyCoverage(row.cells[4])
      const mirrorCoverage = denyCoverage(mirror.cells[4])
      if (mirrorCoverage !== coverage) {
        problems.push(`${DENY_DOC_PAGE_ZH}: ${row.id} coverage ${JSON.stringify(mirrorCoverage)} must match the English row ${JSON.stringify(coverage)}`)
      }
      const enTools = denyCellTokens(row.cells[1]).sort().join(',')
      const zhTools = denyCellTokens(mirror.cells[1]).sort().join(',')
      if (zhTools !== enTools) {
        problems.push(`${DENY_DOC_PAGE_ZH}: ${row.id} denied tools must mirror the English row`)
      }
    }
  }
  return problems
}

/**
 * @param {string} root repository root
 * @returns {string[]} one problem per retired tool name on a current page
 */
export function retiredToolNameProblems(root = packageRoot) {  const problems = []
  for (const page of currentDocPages(root)) {
    const relative = path.relative(root, page).split(path.sep).join('/')
    const lines = withoutRetiredNameParagraph(fs.readFileSync(page, 'utf8')).split('\n')
    const blocks = []
    for (const block of RETIRED_NAME_BLOCKS) {
      if (block.file !== relative) continue
      const bounds = blockBounds(lines, block)
      if (bounds === null) {
        problems.push(`${relative} must keep its "${block.begin}" / "${block.end}" marker pair for the 2.9.0 migration note`)
        continue
      }
      blocks.push({ ...block, bounds })
    }
    const exemptions = RETIRED_NAME_EXEMPTIONS.filter((entry) => entry.file === relative)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '') continue
      for (const name of RETIRED_TOOL_NAMES) {
        if (!new RegExp(`\\b${name}\\b`).test(line)) continue
        if (exemptParagraph(exemptions, lines, index)) continue
        const block = blocks.find((entry) => index >= entry.bounds[0] && index <= entry.bounds[1])
        if (block && pairsWithReplacement(block, lines, index, name)) continue
        problems.push(
          `${relative}:${index + 1} mentions the retired tool name "${name}"; use ${LEGACY_TOOL_REPLACEMENTS[name]}`,
        )
      }
    }
  }
  return problems
}

// #223: prose surface figures. A hand-written tool total or input-schema byte
// count must restate the live surface, not last release's. Expected values come
// from `scripts/surface-baseline.json` plus the two numbers only a live load knows:
// the default profile's mounted tool count and the all-rows-on build bytes (#202's
// 32,792 B had no source of truth at all and was two bytes stale).
//
// The lexers read the spellings the pages actually use (R206): byte counts as
// "32,794 B", "13,287 input bytes" or "6,348 bytes"; tool totals as "23 tools",
// "18 mounted tools", "23 个工具", "23-tool", and the verb-first "the default
// profile mounts 18" / "registers 18" / "advertises 15". A number that merely
// looks like a count — "45 tool error codes", "21 alias fields", "28/28" — is not
// a figure and is left alone.
const SURFACE_HISTORY_MARKER = /^<!--\s*tower-surface-history\s+(\d{4}-\d{2}-\d{2})\s*:\s*(.+?)\s*-->$/
const SURFACE_SAMPLE_MARKER = /^<!--\s*tower-surface-sample\s*:\s*(.+?)\s*-->$/
const SURFACE_MARKER_PREFIX = /^<!--\s*tower-surface-(?:history|sample)\b/
// A byte figure is read in the three forms the pages write it: "32,794 B",
// "13,287 input bytes" and "6,348 bytes". The lookbehind keeps "UTF-8 bytes"
// (the "8" follows a hyphen) out, and the numbers never start mid-token.
const SURFACE_BYTES_FIGURE = /(?<![\w.,/-])(\d[\d,]*)\s*(?:input\s+bytes|bytes|B\b)/g
// A tool total is read as "23 tools", "23 个工具", "23-tool" (and "18 mounted
// tools"); the lookaheads keep "45 tool error codes", "21 alias fields",
// "45 个工具错误码" and "21 个工具形别名" out, and the lookbehind keeps "28/28" out.
const SURFACE_TOOLS_FIGURE =
  /(?<![\d/.,])(\d{1,3})(?:\s+mounted)?\s*(?:个工具(?!错误|形|别名)|-tool\b(?!\s+(?:error|alias(?:es)?|shape|names?|codes?))|tools?\b(?!\s+(?:error|alias(?:es)?|shape|names?|codes?)))/g
// The verb-first spelling: "the default profile mounts 18", "registers 23",
// "advertises 15". R206 showed this form escaped a number-first lexer entirely,
// and every page that writes it means the same tool count.
const SURFACE_MOUNTED_FIGURE = /(?<![\w/.-])(?:mounts?|registers?|advertis(?:e|es|ed|ing))\s+(\d{1,3})(?!\d|\.\d|,\d{3})/g
const SURFACE_PROFILE_ID = /`(host:(?:mode-off|idle|active)|preset:(?:worker|reviewer|survey|survey-sandbox))`/g
const SURFACE_PROFILE_WORD = /(?:`(tower|worker|reviewer)`|\b(?:the\s+)?(tower|worker|reviewer)\s+profile\b)/g

const SURFACE_MIRROR_PAIRS = [
  ['README.en.md', 'README.md'],
  ['docs/reference/tools.md', 'docs/zh/reference/tools.md'],
  ['docs/reference/doctor.md', 'docs/zh/reference/doctor.md'],
  ['docs/guide/install-upgrade-migration.md', 'docs/zh/guide/install-upgrade-migration.md'],
]
const SURFACE_MIRROR_EXEMPT = new Map([
  ['docs/reference/surface-budget.md', 'measurement history; the zh tree cites it from docs/zh/reference/tools.md'],
])

let shippedSurface
/**
 * The two surface facts no JSON file records: how many tools the default profile
 * mounts, and how many bytes the all-rows-on build surface advertises.
 *
 * @returns {{defaultTools: number, buildBytes: number}|{error: string}}
 */
function shippedSurfaceFacts() {
  if (shippedSurface) return shippedSurface
  try {
    const surface = loadShippedToolSurface()
    try {
      let buildBytes = 0
      for (const definition of surface.definitions.values()) buildBytes += toolBytes(definition)
      shippedSurface = { defaultTools: surface.defaultDefinitions.size, buildBytes }
    } finally {
      surface.dispose()
    }
  } catch (error) {
    shippedSurface = { error: `cannot measure the shipped tool surface (${error.message})` }
  }
  return shippedSurface
}

/**
 * Every surface figure on one line, in source order.
 *
 * @param {string} line
 * @returns {{kind: 'bytes'|'tools', value: number, raw: string, index: number}[]}
 */
function surfaceFiguresIn(line) {
  const figures = []
  for (const match of line.matchAll(SURFACE_BYTES_FIGURE)) {
    figures.push({ kind: 'bytes', value: Number(match[1].replaceAll(',', '')), raw: match[0].trim(), index: match.index })
  }
  for (const match of line.matchAll(SURFACE_TOOLS_FIGURE)) {
    figures.push({ kind: 'tools', value: Number(match[1]), raw: match[0].trim(), index: match.index })
  }
  for (const match of line.matchAll(SURFACE_MOUNTED_FIGURE)) {
    figures.push({ kind: 'tools', value: Number(match[1]), raw: match[0].trim(), index: match.index })
  }
  return figures.sort((left, right) => left.index - right.index)
}

/**
 * The subject a figure belongs to, from the nearest label before it. Labels are
 * backticked profile ids, backticked `tower`/`worker`/`reviewer`, or "the X
 * profile"; the sentence punctuation resets the search so a label cannot leak
 * across clauses.
 *
 * @param {string} prefix line text before the figure
 * @returns {string|null} `host:...`/`preset:...`/`profiles.<name>` or null
 */
function surfaceLabelAt(prefix) {
  let start = 0
  for (const match of prefix.matchAll(/[。；;]/g)) start = match.index + 1
  const segment = prefix.slice(start)
  let label = null
  let at = -1
  for (const match of segment.matchAll(SURFACE_PROFILE_ID)) {
    at = match.index
    label = match[1]
  }
  for (const match of segment.matchAll(SURFACE_PROFILE_WORD)) {
    if (match.index <= at) continue
    at = match.index
    label = `profiles.${match[1] ?? match[2]}`
  }
  return label
}

/**
 * The markdown block a marker protects: the fence that opens at the next
 * non-blank line, or the contiguous paragraph/list/table run that starts there.
 *
 * @param {string[]} lines
 * @param {number} markerIndex
 * @returns {{start: number, end: number, fence: boolean}|null}
 */
function surfaceBlockAfterMarker(lines, markerIndex) {
  let start = markerIndex + 1
  while (start < lines.length && lines[start].trim() === '') start += 1
  if (start >= lines.length) return null
  if (lines[start].trimStart().startsWith('```')) {
    for (let end = start + 1; end < lines.length; end += 1) {
      if (lines[end].trimStart().startsWith('```')) return { start, end, fence: true }
    }
    return { start, end: lines.length - 1, fence: true }
  }
  let end = start
  while (end + 1 < lines.length && lines[end + 1].trim() !== '') end += 1
  return { start, end, fence: false }
}

/**
 * @param {string=} root repository root
 * @returns {string[]} one problem per stale, invented or unprotected surface figure
 */
export function surfaceFigureProblems(root = packageRoot) {
  const facts = shippedSurfaceFacts()
  if (facts.error) return [`surface figures: ${facts.error}`]
  let baselineText
  let baseline
  try {
    baselineText = fs.readFileSync(path.join(root, SURFACE_BASELINE_FILE), 'utf8')
    baseline = JSON.parse(baselineText)
  } catch (error) {
    return [`surface figures: cannot read ${SURFACE_BASELINE_FILE} (${error.message})`]
  }

  const bytesCurrent = new Set([facts.buildBytes])
  const toolsCurrent = new Set([facts.defaultTools])
  const recordedBytes = new Set()
  const recordedTools = new Set()
  for (const entry of Object.values(baseline.profiles ?? {})) {
    if (Number.isFinite(entry?.inputBytes?.value)) bytesCurrent.add(entry.inputBytes.value)
    if (Number.isFinite(entry?.tools?.value)) toolsCurrent.add(entry.tools.value)
  }
  for (const entry of Object.values(baseline.profileBytes?.profiles ?? {})) {
    if (Number.isFinite(entry?.bytes)) bytesCurrent.add(entry.bytes)
    if (Number.isFinite(entry?.tools)) toolsCurrent.add(entry.tools)
  }
  if (Number.isFinite(baseline.surfaces?.tools?.value)) toolsCurrent.add(baseline.surfaces.tools.value)
  // The baseline's own `seed` values are the ladder's oldest rungs: a page may
  // quote them, but they are history, not a current figure.
  for (const surface of Object.values(baseline.surfaces ?? {})) {
    if (Number.isFinite(surface?.seed)) recordedTools.add(surface.seed)
  }
  for (const profile of Object.values(baseline.profiles ?? {})) {
    if (Number.isFinite(profile?.tools?.seed)) recordedTools.add(profile.tools.seed)
    if (Number.isFinite(profile?.inputBytes?.seed)) recordedBytes.add(profile.inputBytes.seed)
  }
  const recordDecisions = (decisions, target) => {
    for (const decision of decisions ?? []) {
      for (const value of [decision?.from, decision?.to]) if (Number.isFinite(value)) target.add(value)
    }
  }
  for (const surface of Object.values(baseline.surfaces ?? {})) recordDecisions(surface?.decisions, recordedTools)
  for (const profile of Object.values(baseline.profiles ?? {})) {
    recordDecisions(profile?.tools?.decisions, recordedTools)
    recordDecisions(profile?.inputBytes?.decisions, recordedBytes)
  }
  recordDecisions(baseline.profileBytes?.decisions, recordedBytes)
  // The baseline's own prose is a record too: a page may quote a historical tool
  // count or byte size the decisions' notes spell out ("mounts 17", "22,061 B").
  for (const match of baselineText.matchAll(SURFACE_TOOLS_FIGURE)) recordedTools.add(Number(match[1]))
  for (const match of baselineText.matchAll(SURFACE_MOUNTED_FIGURE)) recordedTools.add(Number(match[1]))
  for (const match of baselineText.matchAll(/\d[\d,]*\s*B\b/g)) {
    recordedBytes.add(Number(match[0].replace(/\s*B$/, '').replaceAll(',', '')))
  }
  // A byte delta ("adds 211 bytes", "grows by 605 bytes") is a size a page may
  // restate; only a value the baseline's own prose mentions is acceptable, so the
  // ladder above is not widened by numbers nobody measured.
  for (const match of baselineText.matchAll(/\d[\d,]*\s*(?:input\s+)?bytes\b/g)) {
    recordedBytes.add(Number(match[0].replace(/(?:\s+input)?\s+bytes$/, '').replaceAll(',', '')))
  }

  const targetFor = (label) => {
    if (!label) return null
    if (label.startsWith('profiles.')) {
      const entry = baseline.profiles?.[label.slice('profiles.'.length)]
      return entry ? { name: label, tools: entry.tools?.value, bytes: entry.inputBytes?.value } : null
    }
    const entry = baseline.profileBytes?.profiles?.[label]
    return entry ? { name: label, tools: entry.tools, bytes: entry.bytes } : null
  }
  const isCurrent = (figure) => (figure.kind === 'bytes' ? bytesCurrent : toolsCurrent).has(figure.value)
  const isRecorded = (figure) => (figure.kind === 'bytes' ? recordedBytes : recordedTools).has(figure.value)
  const expectedList = (kind) =>
    [...(kind === 'bytes' ? bytesCurrent : toolsCurrent)].sort((left, right) => left - right).join(', ')

  const problems = []
  const relativePages = new Map(
    currentDocPages(root).map((page) => [page, path.relative(root, page).split(path.sep).join('/')]),
  )
  const pageSet = new Set(relativePages.values())
  const claimPages = new Set()
  for (const [page, relative] of relativePages) {
    const lines = fs.readFileSync(page, 'utf8').split(/\r?\n/)
    const figures = lines.map(surfaceFiguresIn)
    const fenceLines = new Set()
    let fenceOpen = -1
    lines.forEach((line, index) => {
      if (!line.trimStart().startsWith('```')) return
      if (fenceOpen < 0) {
        fenceOpen = index
        return
      }
      for (let cursor = fenceOpen; cursor <= index; cursor += 1) fenceLines.add(cursor)
      fenceOpen = -1
    })
    if (fenceOpen >= 0) {
      for (let cursor = fenceOpen; cursor < lines.length; cursor += 1) fenceLines.add(cursor)
    }

    const protectedLines = new Map()
    const historyMarkers = []
    const sampleMarkers = []
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (!SURFACE_MARKER_PREFIX.test(trimmed) || fenceLines.has(index)) return
      const history = trimmed.match(SURFACE_HISTORY_MARKER)
      const sample = trimmed.match(SURFACE_SAMPLE_MARKER)
      if (!history && !sample) {
        problems.push(
          `${relative}:${index + 1}: malformed surface marker; write "<!-- tower-surface-history YYYY-MM-DD: reason -->" or "<!-- tower-surface-sample: reason -->"`,
        )
        return
      }
      const block = surfaceBlockAfterMarker(lines, index)
      if (block === null) {
        problems.push(`${relative}:${index + 1}: surface marker protects no block; put it directly above the paragraph or fence it describes`)
        return
      }
      if (history) {
        const date = history[1]
        const stamp = new Date(`${date}T00:00:00Z`)
        if (Number.isNaN(stamp.getTime()) || stamp.toISOString().slice(0, 10) !== date) {
          problems.push(`${relative}:${index + 1}: surface history marker needs a real date (YYYY-MM-DD)`)
          return
        }
        for (let cursor = block.start; cursor <= block.end; cursor += 1) protectedLines.set(cursor, 'history')
        historyMarkers.push({ line: index, block })
        return
      }
      if (!block.fence) {
        problems.push(`${relative}:${index + 1}: surface sample marker must precede a fenced sample of illustrative output, not prose`)
        return
      }
      for (let cursor = block.start; cursor <= block.end; cursor += 1) protectedLines.set(cursor, 'sample')
      sampleMarkers.push({ line: index, block })
    })

    for (let index = 0; index < lines.length; index += 1) {
      const mode = protectedLines.get(index) ?? 'claim'
      if (mode === 'sample' || figures[index].length === 0) continue
      if (mode === 'claim') claimPages.add(relative)
      for (const figure of figures[index]) {
        if (mode === 'history') {
          if (isCurrent(figure) || isRecorded(figure)) continue
          problems.push(
            `${relative}:${index + 1}: ${figure.raw} is neither a live surface figure nor recorded in ${SURFACE_BASELINE_FILE}; a history marker cannot protect an invented value`,
          )
          continue
        }
        const label = surfaceLabelAt(lines[index].slice(0, figure.index))
        const target = label ? targetFor(label) : null
        if (target) {
          const expected = figure.kind === 'bytes' ? target.bytes : target.tools
          if (Number.isFinite(expected) && figure.value === expected) continue
          problems.push(
            `${relative}:${index + 1}: ${figure.raw} does not match ${target.name} (expected ${expected}); the live value is in ${SURFACE_BASELINE_FILE}`,
          )
          continue
        }
        if (isCurrent(figure)) continue
        problems.push(
          `${relative}:${index + 1}: unrecognised surface figure ${figure.raw}: not a live surface value (expected one of ${expectedList(figure.kind)}); fix it, or add "<!-- tower-surface-history YYYY-MM-DD: reason -->" above it if it records history`,
        )
      }
    }

    for (const marker of historyMarkers) {
      const blockFigures = []
      for (let cursor = marker.block.start; cursor <= marker.block.end; cursor += 1) blockFigures.push(...figures[cursor])
      if (blockFigures.length === 0) {
        problems.push(`${relative}:${marker.line + 1}: surface history marker protects no surface figure; remove it`)
        continue
      }
      if (blockFigures.every(isCurrent)) {
        problems.push(
          `${relative}:${marker.line + 1}: surface history marker protects only live figures; remove it (history markers cover recorded history, not the current ladder)`,
        )
      }
    }
    for (const marker of sampleMarkers) {
      let count = 0
      for (let cursor = marker.block.start; cursor <= marker.block.end; cursor += 1) count += figures[cursor].length
      if (count === 0) {
        problems.push(`${relative}:${marker.line + 1}: surface sample marker protects no surface figure; remove it`)
      }
    }
  }

  for (const [en, zh] of SURFACE_MIRROR_PAIRS) {
    if (!pageSet.has(en)) problems.push(`${en} is not scanned for surface figures; keep it in the gate`)
    if (!fs.existsSync(path.join(root, zh))) {
      problems.push(`${zh} is missing: a missing zh mirror of ${en} is a failure, not a skip`)
    } else if (!pageSet.has(zh)) {
      problems.push(`${zh} exists but is not scanned for surface figures`)
    }
  }
  for (const relative of claimPages) {
    if (!relative.startsWith('docs/reference/') || SURFACE_MIRROR_EXEMPT.has(relative)) continue
    const mirror = `docs/zh/${relative.slice('docs/'.length)}`
    if (!fs.existsSync(path.join(root, mirror))) {
      problems.push(`${relative} states surface figures but its zh mirror ${mirror} is missing; a missing zh mirror is a failure, not a skip`)
    } else if (!pageSet.has(mirror)) {
      problems.push(`${mirror} exists but is not scanned for surface figures`)
    }
  }
  return problems
}

// Release-evidence check (#229): `tests/README.md` is the one place release
// evidence lives. The newest `### <version> release evidence (YYYY-MM-DD)` block
// may state only figures the tree can prove — the surface-figure gate above
// checks those. Declaration, pass, skip, file and wall-clock counts describe one
// run on one machine and rot the moment anyone re-runs the suite (the 2.9.8 block
// once carried a mount-smoke duration the run did not produce), so this gate
// refuses them in the newest block and points at the CI job log instead.
// `CONTRIBUTING.md` and `docs/guide/release.md` must both name the same anchor,
// so there is one evidence home, not two.

/** The one page that records release evidence. */
export const EVIDENCE_PAGE = 'tests/README.md'
/** The stable section heading; its GitHub slug is the anchor everything links. */
export const EVIDENCE_SECTION = '## Release evidence'
/** Anchor form other pages must link. */
export const EVIDENCE_ANCHOR = `${EVIDENCE_PAGE}#release-evidence`
/** Every page that must name the one evidence home. */
export const EVIDENCE_LINKERS = ['CONTRIBUTING.md', 'docs/guide/release.md']

const EVIDENCE_BLOCK = /^###\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s+release evidence\s+\((\d{4}-\d{2}-\d{2})\)\s*$/
const EVIDENCE_GATE_MENTIONS = ['check-docs.mjs', 'npm run docs:check']

/**
 * Figures that only a run can produce. Each carries the label used in the
 * failure line. The duration patterns are deliberately narrow: integer seconds
 * are also how config bounds read ("the 3 s discovery timeout"), while a run's
 * wall-clock is decimal or parenthesised.
 */
const EVIDENCE_RUN_FIGURES = [
  [/\b\d[\d,]*\s+(?:declarations?|pass(?:ed)?|skips?|fail(?:ed|ures?)?)\b/i, 'a declaration, pass, skip or failure count'],
  [/\b(?:all\s+)?\d[\d,]*\s+files?\b/i, 'a file count'],
  [/(?<![\w.])\d[\d,]*\s+(?:runs?|inputs?|seeds?)\b/i, 'a run count'],
  [/\b\d+\s+of\s+\d+\b/, 'a pass ratio'],
  [/\(\s*\d+(?:\.\d+)?\s*(?:s|sec(?:onds?)?|ms)\s*\)/i, 'a wall-clock duration'],
  [/\b\d{1,4}\.\d+\s*(?:s|sec(?:onds?)?|ms)\b/i, 'a wall-clock duration'],
  [/\b(?:took|elapsed|finished in|ran in)\s*[:=]?\s*\d+(?:\.\d+)?\s*(?:s|sec(?:onds?)?|ms)\b/i, 'a wall-clock duration'],
]

/**
 * @param {string} left version
 * @param {string} right version
 * @returns {number} negative when left < right, positive when left > right
 */
function compareEvidenceVersions(left, right) {
  const [leftCore, leftPre = ''] = left.split('-', 2)
  const [rightCore, rightPre = ''] = right.split('-', 2)
  const leftNumbers = leftCore.split('.').map(Number)
  const rightNumbers = rightCore.split('.').map(Number)
  for (let index = 0; index < Math.max(leftNumbers.length, rightNumbers.length); index += 1) {
    const delta = (leftNumbers[index] ?? 0) - (rightNumbers[index] ?? 0)
    if (delta !== 0) return delta
  }
  if (leftPre === rightPre) return 0
  if (leftPre === '') return 1
  if (rightPre === '') return -1
  return leftPre < rightPre ? -1 : 1
}

/**
 * @param {string=} root repository root
 * @returns {string[]} one problem per release-evidence drift
 */
export function releaseEvidenceProblems(root = packageRoot) {
  const problems = []
  const page = path.join(root, EVIDENCE_PAGE)
  if (!fs.existsSync(page)) {
    return [`${EVIDENCE_PAGE} is missing: it is the one place release evidence lives`]
  }
  const lines = fs.readFileSync(page, 'utf8').split(/\r?\n/)
  const sectionIndex = lines.findIndex((line) => line.trim() === EVIDENCE_SECTION)
  if (sectionIndex < 0) {
    problems.push(
      `${EVIDENCE_PAGE} must keep the "${EVIDENCE_SECTION}" section: its #release-evidence anchor is the one place other pages link`,
    )
  }
  const blocks = []
  lines.forEach((line, index) => {
    const match = line.match(EVIDENCE_BLOCK)
    if (match) blocks.push({ index, version: match[1], date: match[2] })
  })
  if (blocks.length === 0) {
    problems.push(
      `${EVIDENCE_PAGE} must keep at least one "### <version> release evidence (YYYY-MM-DD)" block under "${EVIDENCE_SECTION}"`,
    )
    return problems
  }
  const newest = blocks[0]
  if (sectionIndex >= 0 && newest.index < sectionIndex) {
    problems.push(
      `${EVIDENCE_PAGE}:${newest.index + 1}: the newest evidence block must sit under the "${EVIDENCE_SECTION}" heading, not above it`,
    )
  }
  for (let index = 1; index < blocks.length; index += 1) {
    const previous = blocks[index - 1]
    const current = blocks[index]
    if (compareEvidenceVersions(previous.version, current.version) < 0) {
      problems.push(
        `${EVIDENCE_PAGE}:${current.index + 1}: evidence blocks are newest-first; ${current.version} sits below ${previous.version}`,
      )
    }
    if (current.date > previous.date) {
      problems.push(
        `${EVIDENCE_PAGE}:${current.index + 1}: evidence blocks are newest-first by date; ${current.date} sits below ${previous.date}`,
      )
    }
  }

  // The newest block is the live one; older blocks are frozen records of their
  // release's run and are not re-measured.
  let end = lines.length
  for (let index = newest.index + 1; index < lines.length; index += 1) {
    if (/^#{2,3}\s/.test(lines[index])) {
      end = index
      break
    }
  }
  const newestBlock = lines.slice(newest.index + 1, end)
  const blockText = newestBlock.join('\n')
  for (const mention of EVIDENCE_GATE_MENTIONS) {
    if (!blockText.includes(mention)) {
      problems.push(
        `${EVIDENCE_PAGE}:${newest.index + 1}: the newest evidence block must name the gate (${mention}); run-local figures are refused here`,
      )
    }
  }
  newestBlock.forEach((line, offset) => {
    const lineNumber = newest.index + 2 + offset
    for (const [pattern, label] of EVIDENCE_RUN_FIGURES) {
      const match = line.match(pattern)
      if (!match) continue
      problems.push(
        `${EVIDENCE_PAGE}:${lineNumber}: restates ${label} ("${match[0].trim()}"); the tree cannot prove it — record it in the CI job log and keep only checked figures here`,
      )
    }
  })

  for (const file of EVIDENCE_LINKERS) {
    const linker = path.join(root, file)
    if (!fs.existsSync(linker)) {
      problems.push(`${file} is missing but must name the one release-evidence home: ${EVIDENCE_ANCHOR}`)
      continue
    }
    if (!fs.readFileSync(linker, 'utf8').includes(EVIDENCE_ANCHOR)) {
      problems.push(
        `${file} must name the one release-evidence home: ${EVIDENCE_ANCHOR} (tests/README.md records it; this file must not restate a run)`,
      )
    }
  }
  return problems
}

/**
 * Check one repository root. The registries are imported from this package, so a
 * fixture root may carry a copy of the documentation without duplicating the
 * implementation data the counts are compared against.
 *
 * @param {string} root repository root
 */
export function checkDocs(root = packageRoot) {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
  const exists = (file) => fs.existsSync(path.join(root, file))

  const toolModuleSources = fs.existsSync(path.join(root, 'tools'))
    ? fs.readdirSync(path.join(root, 'tools'))
        .filter((name) => name.endsWith('.js'))
        .map((name) => read(`tools/${name}`))
        .join('\n')
    : ''
  const indexSource = read('index.js')
  const toolsSource = read('tools/index.js') + toolModuleSources + read('host/tool-registry.js') + indexSource
  const documentedTools = read('docs/reference/tools.md')
  const toolNames = [...new Set([...toolsSource.matchAll(/name: '(tower_[a-z_]+)'/g)].map((match) => match[1]))]
    .filter((name) => name !== 'tower-control')
    .sort()
  const missingTools = toolNames.filter((name) => !documentedTools.includes(`\`${name}\``))

  // #M62 W2-A: the blocker vocabulary has one registry (the same module the
  // generated reference renders from). This gate no longer greps app/tower.js or
  // carries a second list, so adding a registry entry is the only way to add a
  // documented code, and it cannot be missed here.
  const blockersSource = read('docs/reference/blockers.md')
  const blockerCodes = new Set(BLOCKER_CODE_VALUES)
  const missingBlockers = [...blockerCodes].filter((code) => !blockersSource.includes(`\`${code}\``)).sort()

  // #75: the legacy alias list comes from the same event table the generated
  // reference and the runtime use, so a renamed alias fails here first.
  const eventNames = LEGACY_TOOL_EVENT_NAMES.map((name) => name.replace(/^tower\//, ''))
  const documentedEvents = read('docs/reference/events.md')
  const missingEvents = eventNames.filter((name) => !documentedEvents.includes(`\`tower/${name}\``))

  // #M62 W2-A: import the catalogue instead of re-parsing domain/errors.js;
  // the same object feeds the generated error reference.
  const documentedErrors = read('docs/reference/errors.md')
  const errorCodes = Object.keys(ERROR_CODES).sort()
  const missingErrors = errorCodes.filter((code) => !documentedErrors.includes(`\`${code}\``))

  const packageJson = JSON.parse(read('package.json'))
  const changelog = read('CHANGELOG.md')
  const missingChangelog = !changelog.includes(`## ${packageJson.version}`)

  const problems = []
  if (missingTools.length > 0) problems.push(`docs/reference/tools.md misses tools: ${missingTools.join(', ')}`)
  if (missingBlockers.length > 0) problems.push(`docs/reference/blockers.md misses codes: ${missingBlockers.join(', ')}`)
  if (missingErrors.length > 0) problems.push(`docs/reference/errors.md misses codes: ${missingErrors.join(', ')}`)
  if (missingEvents.length > 0) problems.push(`docs/reference/events.md misses events: ${missingEvents.join(', ')}`)
  if (missingChangelog) problems.push(`CHANGELOG.md misses version ${packageJson.version}`)

  // Counts are part of the contract, not just names. The config reference and
  // its defaults are owned by scripts/check-config-reference.mjs (#M64): this
  // file must not restate config keys, because the Schemastery tree is the
  // source. The component count comes from the same surface the generated
  // component page renders.
  const toolsDoc = read('docs/reference/tools.md')
  const blockersDoc = read('docs/reference/blockers.md')
  const errorsDoc = read('docs/reference/errors.md')
  const eventsDoc = read('docs/reference/events.md')
  const config = configSurface()
  const counts = {
    tools: toolNames.length,
    errors: errorCodes.length,
    events: EVENT_COUNT,
    configKeys: config.count,
    sections: config.sections.length,
    blockers: blockerCodes.size,
    visibleComponents: parseComponentSurface(read(COMPONENT_SURFACE_FILE)).components
      .filter((component) => component.scope === 'visible').length,
  }
  if (!toolsDoc.includes(`up to ${counts.tools} tools`)) {
    problems.push(`docs/reference/tools.md must state "up to ${counts.tools} tools"`)
  }
  if (!blockersDoc.includes(`${counts.blockers} stable blocker/failure codes`)) {
    problems.push(`docs/reference/blockers.md must state ${counts.blockers} stable blocker/failure codes`)
  }
  if (!errorsDoc.includes(`${counts.errors} tool error codes`)) {
    problems.push(`docs/reference/errors.md must state ${counts.errors} tool error codes`)
  }
  if (!eventsDoc.includes(`${counts.events} process-local events`)) {
    problems.push(`docs/reference/events.md must state ${counts.events} process-local events`)
  }
  const doctorSurfaceLine = `config keys: ${counts.configKeys} · sections: ${counts.sections} · tools: ${counts.tools}`
  if (!read('docs/reference/doctor.md').includes(doctorSurfaceLine)) {
    problems.push(`docs/reference/doctor.md sample output must state "${doctorSurfaceLine}"`)
  }

  // F43: the READMEs and the architecture overview state the whole live surface
  // in one checked sentence. The checker derives every number from the registry
  // above, so it cannot drift into a second hard-coded list.
  const surfaceEn = `Surface counts (live, checked by \`npm run docs:check\`): ${counts.tools} tools, ${counts.errors} tool error codes, ${counts.events} process-local events, ${counts.configKeys} config keys, ${counts.blockers} stable blocker/failure codes, ${counts.visibleComponents} visible components.`
  const surfaceZh = `表面计数（实时，由 \`npm run docs:check\` 校验）：${counts.tools} 个工具、${counts.errors} 个工具错误码、${counts.events} 个进程内事件、${counts.configKeys} 个配置键、${counts.blockers} 个稳定 blocker/failure code、${counts.visibleComponents} 个可见组件。`
  const surfacePages = [
    ['README.md', surfaceZh],
    ['README.en.md', surfaceEn],
    ['docs/architecture/overview.md', surfaceEn],
  ]
  for (const [page, sentence] of surfacePages) {
    if (!read(page).includes(sentence)) {
      problems.push(`${page} must state the live surface counts: "${sentence}"`)
    }
  }

  // The README tool headings and their "up to N tools" sentence carry a second
  // hand-written breakdown; both must add up to the live tool count.
  const toolBreakdowns = [
    ['README.md', /^## 工具（(\d+) 个：(\d+) 个核心 \+ (\d+) 个可选）/m],
    ['README.md', /最多 (\d+) 个工具：(\d+) 个核心 \+ (\d+) 个可选/],
    ['README.en.md', /^## Tools \((\d+): (\d+) core \+ (\d+) optional\)$/m],
    ['README.en.md', /up to (\d+) tools: (\d+) core \+ (\d+) optional/],
  ]
  for (const [page, pattern] of toolBreakdowns) {
    const match = read(page).match(pattern)
    if (!match) {
      problems.push(`${page} must state the "N tools: N core + N optional" breakdown (${pattern})`)
      continue
    }
    const [total, core, optional] = match.slice(1).map(Number)
    if (total !== counts.tools || core + optional !== counts.tools) {
      problems.push(
        `${page} says ${total} tools (${core} core + ${optional} optional); the live registry has ${counts.tools}`,
      )
    }
  }

  // The architecture tree also counts the tools registered through define().
  // tower_mode is registered directly by the Host entry, so that
  // number is derived from index.js instead of being restated by hand.
  const directSessionTools = new Set(
    [...indexSource.matchAll(/recordToolRegistration\('(tower_[a-z_]+)'\)/g)].map((match) => match[1]),
  )
  const defineRegistered = toolNames.filter((name) => !directSessionTools.has(name)).length
  const overview = read('docs/architecture/overview.md')
  const defineMatch = overview.match(/\+ (\d+) define\(\)-registered tools/)
  if (!defineMatch) {
    problems.push(`docs/architecture/overview.md must state the define()-registered tool count`)
  } else if (Number(defineMatch[1]) !== defineRegistered) {
    problems.push(
      `docs/architecture/overview.md says ${defineMatch[1]} define()-registered tools; the live registry has ${defineRegistered}`,
    )
  }
  const totalMatch = overview.match(/(\d+) total/)
  if (!totalMatch || Number(totalMatch[1]) !== counts.tools) {
    problems.push(`docs/architecture/overview.md must state "${counts.tools} total" tools`)
  }

  // Chinese parity: when the translation tree exists it must cover the same
  // reference names and state the same counts, so a tool or code cannot be added
  // only in English.
  if (exists('docs/zh')) {
    const zhPages = {
      'docs/zh/README.md': null,
      'docs/zh/reference/tools.md': (text) => toolNames.filter((name) => !text.includes(`\`${name}\``)),
      'docs/zh/reference/blockers.md': (text) => [...blockerCodes].filter((code) => !text.includes(`\`${code}\``)),
      'docs/zh/reference/errors.md': (text) => errorCodes.filter((code) => !text.includes(`\`${code}\``)),
      'docs/zh/reference/events.md': (text) => eventNames.filter((name) => !text.includes(`\`tower/${name}\``)),
      'docs/zh/reference/config.md': null,
      'docs/zh/guide/hot-reload.md': null,
    }
    for (const [page, check] of Object.entries(zhPages)) {
      if (!exists(page)) {
        problems.push(`${page} is missing (Chinese docs parity)`)
        continue
      }
      if (!check) continue
      const missing = check(read(page))
      if (missing.length > 0) problems.push(`${page} misses: ${missing.join(', ')}`)
    }
    const zhCounts = [
      ['docs/zh/reference/tools.md', `最多 ${counts.tools} 个工具`],
      ['docs/zh/reference/blockers.md', `${counts.blockers} 个稳定 blocker/failure code`],
      ['docs/zh/reference/errors.md', `${counts.errors} 个工具错误码`],
      ['docs/zh/reference/events.md', `${counts.events} 个进程内事件`],
    ]
    for (const [page, phrase] of zhCounts) {
      if (exists(page) && !read(page).includes(phrase)) {
        problems.push(`${page} must state "${phrase}"`)
      }
    }
  }

  problems.push(...denyTableProblems(root))
  problems.push(...toolTableRowProblems(root))
  problems.push(...retiredToolNameProblems(root))
  problems.push(...surfaceFigureProblems(root))
  problems.push(...releaseEvidenceProblems(root))
  problems.push(...linkProblems(root))
  return {
    problems,
    counts,
    toolNames,
    blockerCodes: [...blockerCodes].sort(),
    errorCodes,
    eventNames,
    version: packageJson.version,
  }
}

await runMain(
  import.meta.url,
  async () => {
    const { root, help } = parseArgs(process.argv.slice(2), {
      initial: { root: packageRoot },
      values: { '--root': 'root' },
      flags: { '--help': 'help' },
    })
    if (help) {
      console.log(USAGE)
      return 0
    }
    const result = checkDocs(path.resolve(root))
    if (result.problems.length > 0) {
      console.error('documentation check failed:')
      for (const problem of result.problems) console.error(`- ${problem}`)
      return 1
    }
    console.log(
      `docs ok: ${result.toolNames.length} tools, ${result.blockerCodes.length} blocker codes, ${result.errorCodes.length} error codes, ${result.counts.events} events, ${result.counts.configKeys} config keys, ${result.counts.visibleComponents} visible components, version ${result.version}`,
    )
    return 0
  },
  { errorPrefix: 'documentation check', usage: USAGE },
)
