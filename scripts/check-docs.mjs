// Documentation consistency check: tool names, blocker codes, error codes and
// release numbers must not drift from the implementation. The Chinese
// reference pages must cover the same names. Run: node scripts/check-docs.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_COUNT, LEGACY_TOOL_EVENT_NAMES } from '../domain/events.js'
import { ERROR_CODES } from '../domain/errors.js'
import { BLOCKER_CODE_VALUES } from '../domain/shapes/blockers.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const exists = (file) => fs.existsSync(path.join(root, file))

const toolModuleSources = fs.existsSync(path.join(root, 'tools'))
  ? fs.readdirSync(path.join(root, 'tools'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => read(`tools/${name}`))
      .join('\n')
  : ''
const toolsSource = read('tools/index.js') + toolModuleSources + read('host/tool-registry.js') + read('index.js')
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
// its defaults are owned by scripts/check-config-reference.mjs (#M64): this file
// must not restate config keys, because the Schemastery tree is the source.
const toolsDoc = read('docs/reference/tools.md')
const blockersDoc = read('docs/reference/blockers.md')
const errorsDoc = read('docs/reference/errors.md')
const eventsDoc = read('docs/reference/events.md')
if (!toolsDoc.includes(`up to ${toolNames.length} tools`)) {
  problems.push(`docs/reference/tools.md must state "up to ${toolNames.length} tools"`)
}
if (!blockersDoc.includes(`${blockerCodes.size} stable blocker/failure codes`)) {
  problems.push(`docs/reference/blockers.md must state ${blockerCodes.size} stable blocker/failure codes`)
}
if (!errorsDoc.includes(`${errorCodes.length} tool error codes`)) {
  problems.push(`docs/reference/errors.md must state ${errorCodes.length} tool error codes`)
}
if (!eventsDoc.includes(`${EVENT_COUNT} process-local events`)) {
  problems.push(`docs/reference/events.md must state ${EVENT_COUNT} process-local events`)
}

// Chinese parity: when the translation tree exists it must cover the same
// reference names, so a tool or code cannot be added only in English.
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
}

if (problems.length > 0) {
  console.error('documentation check failed:')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
console.log(
  `docs ok: ${toolNames.length} tools, ${blockerCodes.size} blocker codes, ${errorCodes.length} error codes, ${EVENT_COUNT} events, version ${packageJson.version}`,
)
