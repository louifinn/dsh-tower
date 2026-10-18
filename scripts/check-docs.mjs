// Documentation consistency check: tool names, blocker codes, error codes and
// release numbers must not drift from the implementation. The Chinese
// reference pages must cover the same names. Run: node scripts/check-docs.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const exists = (file) => fs.existsSync(path.join(root, file))

const toolsSource = read('lib/tools.js') + read('index.js')
const documentedTools = read('docs/reference/tools.md')
const toolNames = [...new Set([...toolsSource.matchAll(/name: '(tower_[a-z_]+)'/g)].map((match) => match[1]))]
  .filter((name) => name !== 'tower-control')
  .sort()
const missingTools = toolNames.filter((name) => !documentedTools.includes(`\`${name}\``))

const towerSource = read('lib/tower.js')
const blockersSource = read('docs/reference/blockers.md')
const blockerCodes = new Set()
for (const match of towerSource.matchAll(/push\(\s*'([a-z][a-z-]+)'/g)) blockerCodes.add(match[1])
for (const code of [
  'mission-missing',
  'mission-not-completed',
  'tasks-open',
  'blockers-present',
  'branch-missing',
  'stale-base',
  'read-only-survey',
  'out-of-scope',
  'base-dirty',
  'deps-unmerged',
  'no-review',
  'review-mission-mismatch',
  'not-clean',
  'review-hold',
  'review-not-approved',
  'tip-moved',
  'worker-busy',
  'base-wrong-branch',
  'branch-owned-by-closed-missions',
  'merge-conflict',
  'merge-hook-failed',
  'merge-shape',
  'rebase-conflict',
  'worktree-dirty',
  'no-check-evidence',
  'worker-stale',
  'worker-status-unknown',
  'tests-missing',
  'tests-failed',
  'review-exemption-invalid',
  'merge-intent-pending',
  'batch-invalid',
]) blockerCodes.add(code)
const missingBlockers = [...blockerCodes].filter((code) => !blockersSource.includes(`\`${code}\``)).sort()

const eventNames = [
  'init',
  'plan',
  'mission',
  'spawn',
  'complete',
  'review',
  'merge',
  'rebase',
  'teardown',
  'finding',
  'findings',
  'send',
  'inbox',
  'interrupt',
  'diff',
  'adopt',
  'roster',
  'status',
  'preflight',
  'doctor',
  'test',
  'batch',
  'resource',
  'import_legacy',
  'legacy_map',
]
const documentedEvents = read('docs/reference/events.md')
const missingEvents = eventNames.filter((name) => !documentedEvents.includes(`\`tower/${name}\``))

const errorsSource = read('lib/errors.js')
const documentedErrors = read('docs/reference/errors.md')
const errorCodes = [...new Set([...errorsSource.matchAll(/^ {2}'([a-z][a-z-]+)':/gm)].map((match) => match[1]))].sort()
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
  `docs ok: ${toolNames.length} tools, ${blockerCodes.size} blocker codes, ${errorCodes.length} error codes, ${eventNames.length} events, version ${packageJson.version}`,
)
