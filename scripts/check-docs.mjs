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

/**
 * @param {string} root repository root
 * @returns {string[]} one problem per retired tool name on a current page
 */
export function retiredToolNameProblems(root = packageRoot) {
  const problems = []
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

  problems.push(...toolTableRowProblems(root))
  problems.push(...retiredToolNameProblems(root))
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
