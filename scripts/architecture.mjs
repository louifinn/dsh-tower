// Architecture fitness functions (#55). The first ratchet is intentionally
// conservative: it locks in the current boundaries and fails on regression.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const lineCount = (file) => read(file).split('\n').length

const CHILD_PROCESS_ALLOWED = new Set([
  'lib/git.js',
  'lib/tests.js',
  'lib/hmr.js',
  'lib/doctor.js',
])
const LIMITS = {
  'lib/tower.js': 3000,
  'lib/tools.js': 2600,
}

const problems = []
const warnings = []

for (const [file, limit] of Object.entries(LIMITS)) {
  const lines = lineCount(file)
  if (lines > limit) problems.push(`${file} is ${lines} lines (limit ${limit}); split before growing it`)
  else if (lines > limit - 100) warnings.push(`${file} is ${lines} lines, within 100 of its ${limit} limit`)
}

for (const file of fs.readdirSync(path.join(root, 'lib')).filter((name) => name.endsWith('.js'))) {
  const relative = `lib/${file}`
  if (!read(relative).includes("node:child_process")) continue
  if (!CHILD_PROCESS_ALLOWED.has(relative)) {
    problems.push(`${relative} imports node:child_process; only ${[...CHILD_PROCESS_ALLOWED].join(', ')} may spawn`)
  }
}

const toolsImports = [...read('lib/tools.js').matchAll(/from '\.\/([^']+)'/g)].map((match) => match[1])
if (toolsImports.length > 11) {
  problems.push(`lib/tools.js imports ${toolsImports.length} local modules (limit 11); move a use case out`)
}

for (const warning of warnings) console.warn(`architecture warn: ${warning}`)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: problems.length === 0, problems, warnings }, null, 2))
} else if (problems.length > 0) {
  for (const problem of problems) console.error(`architecture: ${problem}`)
} else {
  console.log(`architecture: ok (${Object.keys(LIMITS).length} size ratchets, child_process allowlist, tools imports ${toolsImports.length})`)
}
process.exit(problems.length === 0 ? 0 : 1)
