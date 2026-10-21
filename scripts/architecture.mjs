// Architecture fitness functions (#55).
//
// Rules are intentionally staged: rules for not-yet-migrated areas are
// warnings (printed, exit 0) and flip to errors in the PR that makes them true.
// The evaluator is exported so tests can seed one fixture violation per rule.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['lib', 'app', 'domain', 'tools']
const CHILD_PROCESS_ALLOWED = new Set(['lib/git.js', 'lib/tests.js', 'lib/hmr.js', 'lib/doctor.js'])
const FS_ALLOWED = new Set() // migration not complete: fs still lives in lib/
const LITERAL_PATTERN = /enum:\s*\[\s*'(?:planned|active|completed|blocked|paused|abandoned|worker|reviewer|bug|improve|vuln|idea|low|medium|high|critical|open|triaged|fixed|wontfix)'/

function walk(root, relative = '') {
  const dir = path.join(root, relative)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(relative, entry.name)
    if (entry.isDirectory()) out.push(...walk(root, next))
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(next.split(path.sep).join('/'))
  }
  return out
}

function evaluator(root) {
  const files = ROOTS.flatMap((dir) => walk(root, dir)).filter((file) => !file.includes('/node_modules/'))
  const violations = []
  const record = (rule, file, detail, level) => violations.push({ rule, file, detail, level })

  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    const lines = text.split('\n')
    const imports = [...text.matchAll(/from\s+'([^']+)'|require\('([^']+)'\)/g)].map((match) => match[1] ?? match[2])
    if ((file.startsWith('domain/') || file.startsWith('lib/domain/')) && imports.some((spec) => /^(node:fs|node:fs\/promises|node:child_process|\.\.\/adapters|adapters\/)/.test(spec))) {
      record('domain-pure', file, 'domain imports I/O or adapters', 'error')
    }
    if (file.startsWith('lib/') && imports.includes('node:child_process') && !CHILD_PROCESS_ALLOWED.has(file)) {
      record('child-process-surface', file, 'only adapters/** may spawn processes', 'warn')
    }
    if ((file.startsWith('lib/') || file.startsWith('app/')) && imports.some((spec) => spec === 'node:fs' || spec === 'node:fs/promises') && !FS_ALLOWED.has(file)) {
      record('fs-surface', file, 'only adapters/** may use fs', 'warn')
    }
    if (file.startsWith('tools/')) {
      if (imports.some((spec) => spec.startsWith('node:') && spec !== 'node:path')) {
        record('tools-thin', file, 'tools/** may import only node:path', 'warn')
      }
      if (LITERAL_PATTERN.test(text)) record('tools-vocabulary', file, 'status/type/role literal in tools/**', 'warn')
    }
    const limit = file.startsWith('tools/') ? 200 : 800
    if (file.split('/').length === 2 && lines.length > limit) {
      record('aggregate-size', file, `${lines.length} lines exceeds ${limit}`, 'warn')
    }
    if (/^(?:export\s+)?let\s+/m.test(text) && (file.startsWith('lib/') || file.startsWith('app/') || file.startsWith('domain/'))) {
      record('ambient-state', file, 'top-level let outside an allow-list', 'warn')
    }
  }
  return { ok: violations.every((violation) => violation.level !== 'error'), violations }
}

const rootArg = process.argv.indexOf('--root')
const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : PACKAGE_ROOT
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const result = evaluator(root)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const violation of result.violations) {
      const line = `architecture ${violation.level}: [${violation.rule}] ${violation.file}: ${violation.detail}`
      if (violation.level === 'error') console.error(line)
      else console.warn(line)
    }
    if (result.violations.length === 0) console.log('architecture: ok')
  }
  process.exit(result.ok ? 0 : 1)
}

export { evaluator }
