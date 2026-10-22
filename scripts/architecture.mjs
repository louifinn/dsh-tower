// Architecture fitness functions (#55).
//
// Rules are intentionally staged: rules for not-yet-migrated areas are
// warnings (printed, exit 0) and flip to errors in the PR that makes them true.
// The evaluator is exported so tests can seed one fixture violation per rule.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['lib', 'app', 'domain', 'tools', 'adapters', 'ports']
const CHILD_PROCESS_ALLOWED = new Set(['adapters/vcs-git.js'])
const FS_ALLOWED = new Set(['adapters/store-fs.js'])
// Composition roots own the only intentional process-wide mutable state.
const AMBIENT_ALLOWED = new Set(['lib/config.js', 'lib/git.js'])
// The registration aggregator wires tool modules together; the thinness rule
// applies to the individual modules under tools/.
const TOOLS_REGISTRATION = new Set(['tools/index.js'])
// The registration aggregator is the only tools/ module above the 200-line
// per-tool ceiling: it wires the individual modules together. P3c split
// tower_spawn, so every tool module now enforces the ceiling.
const TOOLS_SIZE_ALLOWED = new Set(['tools/index.js'])
// #69: the app layer may import only these. App siblings (`./x.js`), the pure
// domain, and the explicit ports are the whole dependency surface.
const APP_ALLOWED_PREFIXES = ['./', '../domain/', '../ports/']
const APP_ALLOWED_EXACT = new Set(['node:path'])
// #69: only the host entries (index.js/worker.js/reviewer.js, outside this scan
// set) and the adapters may import adapters. lib/ is the infrastructure layer
// below the ports and is retired by #70; until then it is the one documented
// importer exemption, and app/tools/domain/ports never may.
const COMPOSITION_ROOT_EXEMPT_PREFIXES = ['lib/']
const ADAPTER_IMPORT = /^(?:\.\.\/)?adapters(?:\/|$)/
// #69: a port must be a runtime contract, not a comment plus `export {}`.
const RUNTIME_PORT_EXPORT = /^export\s+(?:const|function|class)\s/m
// #69: port modules must not reach into an implementation.
const PORT_IMPLEMENTATION_IMPORT = /^(?:\.\.\/)?(?:adapters|lib|app|tools)(?:\/|$)/
const LITERAL_PATTERN = /enum:\s*\[\s*'(?:planned|active|completed|blocked|paused|abandoned|worker|reviewer|bug|improve|vuln|idea|low|medium|high|critical|open|triaged|fixed|wontfix)'/
const TOOL_LITERAL_PATTERN = /(?:===|!==|==|!=|\.includes\(|case\s+)'?(?:planned|active|completed|blocked|paused|abandoned|worker|reviewer|bug|improve|vuln|idea|low|medium|high|critical|open|triaged|fixed|wontfix|create|abandon|close|status|merge|fix-then-merge|hold|acquire|release|map|user|failure|resource|dependency|json|markdown)'/

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
    if (file.startsWith('domain/') && imports.some((spec) => /^(node:fs|node:fs\/promises|node:child_process|\.\.\/adapters|adapters\/)/.test(spec))) {
      record('domain-pure', file, 'domain imports I/O or adapters', 'error')
    }
    if (imports.includes('node:child_process') && !CHILD_PROCESS_ALLOWED.has(file)) {
      record('child-process-surface', file, 'only adapters/** may spawn processes', 'error')
    }
    if (imports.some((spec) => spec === 'node:fs' || spec === 'node:fs/promises') && !FS_ALLOWED.has(file)) {
      record('fs-surface', file, 'only adapters/** may use fs', 'error')
    }
    // #69 app-ports-only: the app depends on ports, the pure domain, and Node's
    // path module. Adapters and lib/ infrastructure are reached through deps.
    if (file.startsWith('app/')) {
      for (const spec of imports) {
        const allowed =
          APP_ALLOWED_EXACT.has(spec) ||
          APP_ALLOWED_PREFIXES.some((prefix) => spec.startsWith(prefix))
        if (!allowed) {
          record(
            'app-ports-only',
            file,
            `imports ${spec}; app/** may import only app siblings, domain/**, ports/** and node:path`,
            'error',
          )
        }
      }
    }
    // #69 composition-root: only the host entries and the adapters may import an
    // adapter; lib/ is the documented infrastructure lapse until #70.
    if (!COMPOSITION_ROOT_EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix)) && !file.startsWith('adapters/')) {
      for (const spec of imports) {
        if (ADAPTER_IMPORT.test(spec)) {
          record('composition-root', file, `imports ${spec}; adapters are composed once in the host entry`, 'error')
        }
      }
    }
    // #69 port-shape: a port module exports a runtime contract and imports no
    // implementation. `export {}` alone is a comment, not a seam.
    if (file.startsWith('ports/')) {
      if (!RUNTIME_PORT_EXPORT.test(text)) {
        record('port-shape', file, 'port modules must export a runtime contract (const/function/class)', 'error')
      }
      for (const spec of imports) {
        if (PORT_IMPLEMENTATION_IMPORT.test(spec)) {
          record('port-shape', file, `imports ${spec}; ports must not depend on an implementation`, 'error')
        }
      }
    }
    if (file.startsWith('tools/')) {
      if (imports.some((spec) => spec.startsWith('node:') && spec !== 'node:path')) {
        record('tools-thin', file, 'tools/** may import only node:path', 'error')
      }
      if (LITERAL_PATTERN.test(text) || TOOL_LITERAL_PATTERN.test(text)) {
        record('tools-vocabulary', file, 'status/type/role literal in tools/**', 'error')
      }
      if (lines.length < 40 || lines.length > 200) {
        record('aggregate-size', file, `${lines.length} lines outside 40-200`, 'error')
      }
    } else if (lines.length > 800) {
      record('aggregate-size', file, `${lines.length} lines exceeds 800`, 'error')
    }
    if (/^(?:export\s+)?let\s+/m.test(text) && !AMBIENT_ALLOWED.has(file) && (file.startsWith('lib/') || file.startsWith('app/') || file.startsWith('domain/'))) {
      record('ambient-state', file, 'top-level let outside an allow-list', 'error')
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
