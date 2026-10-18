// Documentation consistency check: tool names, blocker codes and release numbers
// must not drift from the implementation. Run: node scripts/check-docs.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

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
]) blockerCodes.add(code)
const missingBlockers = [...blockerCodes].filter((code) => !blockersSource.includes(`\`${code}\``)).sort()

const packageJson = JSON.parse(read('package.json'))
const changelog = read('CHANGELOG.md')
const missingChangelog = !changelog.includes(`## ${packageJson.version}`)

const problems = []
if (missingTools.length > 0) problems.push(`docs/reference/tools.md misses tools: ${missingTools.join(', ')}`)
if (missingBlockers.length > 0) problems.push(`docs/reference/blockers.md misses codes: ${missingBlockers.join(', ')}`)
if (missingChangelog) problems.push(`CHANGELOG.md misses version ${packageJson.version}`)

if (problems.length > 0) {
  console.error('documentation check failed:')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
console.log(`docs ok: ${toolNames.length} tools, ${blockerCodes.size} blocker codes, version ${packageJson.version}`)
