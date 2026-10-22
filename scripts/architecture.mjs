// Architecture fitness functions (#55).
//
// Rules are intentionally staged: rules for not-yet-migrated areas are
// warnings (printed, exit 0) and flip to errors in the PR that makes them true.
// The evaluator is exported so tests can seed one fixture violation per rule.
//
// Exemptions are justified data, not bare sets (#80). Every waiver lives in
// scripts/architecture-waivers.json and carries a reason plus an owner or
// reference; an unexplained waiver is itself a blocking `waiver-contract`
// violation, so a bare path can no longer turn the gate green. The
// ambient-state waivers must also name the exact top-level binding, which
// exempts one variable rather than the whole file: a new top-level `let` in a
// previously exempt file is still a violation. The green summary prints the
// number of waivers actually applied.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(MODULE_DIR, '..')
const WAIVER_FILE = path.join(MODULE_DIR, 'architecture-waivers.json')
const WAIVER_LABEL = 'scripts/architecture-waivers.json'
const ROOTS = ['lib', 'app', 'domain', 'tools', 'adapters', 'ports']
const RULES = new Set([
  'domain-pure',
  'child-process-surface',
  'fs-surface',
  'app-ports-only',
  'composition-root',
  'port-shape',
  'tools-thin',
  'tools-vocabulary',
  'aggregate-size',
  'ambient-state',
])
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
// A waived ambient-state violation is per binding, so the waiver can match the
// variable name while a second top-level `let` in the same file still fails.
const TOP_LEVEL_LET = /^(?:export\s+)?let\s+(.+?)(?:\s*=|\s*$)/gm

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

function loadWaivers(file = WAIVER_FILE) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  const waivers = Array.isArray(parsed) ? parsed : parsed?.waivers
  if (!Array.isArray(waivers)) throw new Error('waivers must be an array or an object with a waivers array')
  return waivers
}

function evaluator(root, options = {}) {
  const files = ROOTS.flatMap((dir) => walk(root, dir)).filter((file) => !file.includes('/node_modules/'))
  const violations = []
  const record = (rule, file, detail, level, match) => {
    violations.push(match === undefined ? { rule, file, detail, level } : { rule, file, detail, level, match })
  }

  let waivers
  if (options.waivers !== undefined) {
    waivers = options.waivers
    if (!Array.isArray(waivers)) {
      record('waiver-contract', WAIVER_LABEL, 'waivers must be an array', 'error')
      waivers = []
    }
  } else {
    try {
      waivers = loadWaivers(options.waiverFile)
    } catch (error) {
      record('waiver-contract', WAIVER_LABEL, `cannot read waivers: ${error?.message ?? error}`, 'error')
      waivers = []
    }
  }

  // Every waiver is validated before it is allowed to suppress a violation.
  // An invalid entry names its rule and path in the failure so the reviewer can
  // see exactly which decision is missing.
  const validWaivers = []
  waivers.forEach((waiver, index) => {
    const label = `waiver[${index}]`
    if (waiver === null || typeof waiver !== 'object' || Array.isArray(waiver)) {
      record('waiver-contract', WAIVER_LABEL, `${label} is not an object`, 'error')
      return
    }
    const rule = typeof waiver.rule === 'string' ? waiver.rule.trim() : ''
    const file = typeof waiver.path === 'string' ? waiver.path.trim() : ''
    const reason = typeof waiver.reason === 'string' ? waiver.reason.trim() : ''
    const owner = typeof waiver.owner === 'string' ? waiver.owner.trim() : ''
    const ref = typeof waiver.ref === 'string' ? waiver.ref.trim() : ''
    const match = typeof waiver.match === 'string' ? waiver.match.trim() : ''
    const where = file || '<unknown path>'
    let valid = true
    if (!rule) {
      record('waiver-contract', where, `${label} has no rule${file ? ` for ${file}` : ''}`, 'error')
      valid = false
    } else if (!RULES.has(rule)) {
      record('waiver-contract', where, `${label} for ${where} names unknown rule "${rule}"`, 'error')
      valid = false
    }
    if (!file) {
      record('waiver-contract', where, `${label}${rule ? ` for rule "${rule}"` : ''} has no path`, 'error')
      valid = false
    } else if (path.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')) {
      record(
        'waiver-contract',
        where,
        `${label} for rule "${rule}" uses a repo-relative path with forward slashes: ${file}`,
        'error',
      )
      valid = false
    }
    if (!reason) {
      record('waiver-contract', where, `${label} for rule "${rule}" on ${where} has no reason`, 'error')
      valid = false
    }
    if (!owner && !ref) {
      record('waiver-contract', where, `${label} for rule "${rule}" on ${where} has no owner or reference`, 'error')
      valid = false
    }
    if (rule === 'ambient-state' && !match) {
      record(
        'waiver-contract',
        where,
        `${label} for rule "ambient-state" on ${where} must name the exact binding with "match"`,
        'error',
      )
      valid = false
    }
    // domain-pure and domain/** are load-bearing: there is no exemption path
    // for them, not even a justified one (#80).
    if (rule === 'domain-pure') {
      record('waiver-contract', where, `${label} for rule "domain-pure" on ${where} cannot be waived`, 'error')
      valid = false
    }
    if (file.startsWith('domain/')) {
      record('waiver-contract', where, `${label} for rule "${rule}" on ${where} cannot waive domain/**`, 'error')
      valid = false
    }
    if (valid) validWaivers.push({ rule, path: file, match: match || undefined, reason, owner: owner || undefined, ref: ref || undefined })
  })

  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    const lines = text.split('\n')
    const imports = [...text.matchAll(/from\s+'([^']+)'|require\('([^']+)'\)/g)].map((match) => match[1] ?? match[2])
    if (file.startsWith('domain/') && imports.some((spec) => /^(node:fs|node:fs\/promises|node:child_process|\.\.\/adapters|adapters\/)/.test(spec))) {
      record('domain-pure', file, 'domain imports I/O or adapters', 'error')
    }
    if (imports.includes('node:child_process')) {
      record('child-process-surface', file, 'only adapters/** may spawn processes', 'error')
    }
    if (imports.some((spec) => spec === 'node:fs' || spec === 'node:fs/promises')) {
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
    if (file.startsWith('lib/') || file.startsWith('app/') || file.startsWith('domain/')) {
      for (const declaration of text.matchAll(TOP_LEVEL_LET)) {
        const binding = declaration[1].trim()
        record('ambient-state', file, `top-level let '${binding}' has no justified waiver`, 'error', binding)
      }
    }
  }

  // A waiver only suppresses the violation it names. Path-only waivers cover
  // per-file rules; ambient-state waivers must also match the binding.
  const remaining = []
  let waived = 0
  for (const violation of violations) {
    const waiver = validWaivers.find(
      (entry) =>
        entry.rule === violation.rule &&
        entry.path === violation.file &&
        (entry.match === undefined || entry.match === violation.match),
    )
    if (waiver && violation.level === 'error') {
      waived += 1
      continue
    }
    remaining.push(violation)
  }
  return {
    ok: remaining.every((violation) => violation.level !== 'error'),
    violations: remaining,
    waivers: validWaivers.length,
    waived,
  }
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
    if (result.violations.length === 0) console.log(`architecture: ok (waivers: ${result.waived})`)
  }
  process.exit(result.ok ? 0 : 1)
}

export { evaluator, loadWaivers, WAIVER_FILE }
