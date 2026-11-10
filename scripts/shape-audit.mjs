// Shape audit (#149): one shape registry means generic layers must not branch on
// a kind or a role, and the old global status vocabulary must not come back.
//
// The audit is the ongoing mechanism, not a one-off cleanup: it fails on
//   - a comparison against a kind literal ('build' | 'survey'),
//   - a comparison against a role literal ('worker' | 'reviewer' | 'tower'),
//   - the global TERMINAL_STATUSES / TRANSITIONS identifiers,
//   - a one-argument isTerminal(...) or one-argument canTransition(...) call,
//   - reading a review tip from a live worktree HEAD (review evidence is a commit),
//   - comparing a batch status against a literal outside the batch owner module,
//   - naming the lease ledger outside the lease adapter.
//
// Exemptions live in scripts/architecture-waivers.json under `shapeWaivers` and
// require a reason plus an owner or a ref, exactly like the architecture gate.
// A waiver with no reason is a contract failure, and a waiver for a path that no
// longer violates anything is reported as stale.
//
// Usage: node scripts/shape-audit.mjs [--root <path>] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const WAIVER_FILE = 'scripts/architecture-waivers.json'
export const WAIVER_KEY = 'shapeWaivers'
export const SCAN_DIRS = ['domain', 'app', 'tools', 'host', 'adapters', 'ports']
export const SHAPE_DIR = 'domain/shapes'
/**
 * The fitness rules this audit enforces. `docs/reference/shapes.md` is generated
 * from this list, so a verdict cannot name a rule the audit does not run.
 */
export const RULES = [
  {
    id: 'kind-literal',
    rule: 'Generic layers never compare mission.kind with a literal.',
    owner: 'domain/shapes/<kind>.js',
  },
  {
    id: 'role-literal',
    rule: 'Generic layers use the vocabulary role predicates, never a role literal.',
    owner: 'domain/roles.js',
  },
  {
    id: 'global-status-vocabulary',
    rule: 'No module reaches for the global TERMINAL_STATUSES/TRANSITIONS tables.',
    owner: 'domain/shapes/<kind>.js',
  },
  {
    id: 'shape-entry-point',
    rule: 'isTerminal(kind, status) and canTransition(kind, from, to) are the only entry points.',
    owner: 'domain/shapes/index.js',
  },
  {
    id: 'review-tip-read',
    rule: 'A review never reads a live worktree HEAD; verdicts are stamped with a recorded commit.',
    owner: 'app/reviewCheckout.js',
  },
  {
    id: 'batch-status-literal',
    rule: 'Batch status literals live in domain/batch.js; every other layer uses its constants.',
    owner: 'domain/batch.js',
  },
  {
    id: 'lease-ledger',
    rule: 'Only adapters/leases.js reads or writes the lease ledger.',
    owner: 'adapters/leases.js',
  },
  {
    id: 'blocked-status-write',
    rule: 'blocked is derived from open blockers; only domain/missions/lifecycle.js writes it.',
    owner: 'domain/missions/lifecycle.js',
  },
]
/** Rules whose implementation module necessarily names the vocabulary it owns. */
export const RULE_EXEMPT_PATHS = {
  'batch-status-literal': ['domain/batch.js'],
  'lease-ledger': ['adapters/leases.js'],
  'blocked-status-write': ['domain/missions/lifecycle.js'],
}

const KIND_PATTERN = /(?:\bkind\b\s*[!=]==?\s*['"](?:build|survey)['"])|(?:['"](?:build|survey)['"]\s*[!=]==?\s*\bkind\b)/
const ROLE_PATTERN = /(?:\brole\b\s*[!=]==?\s*['"](?:worker|reviewer|tower)['"])|(?:['"](?:worker|reviewer|tower)['"]\s*[!=]==?\s*\brole\b)/
const GLOBAL_VOCAB_PATTERN = /\b(?:TERMINAL_STATUSES|TRANSITIONS)\b/
const CALL_PATTERN = /(?<!\.)\b(isTerminal|canTransition)\s*\(([^()]*)\)/g
const REVIEW_TIP_PATTERN = /\brevParse\s*\(\s*[^)]*worktree\.path\s*,\s*['"]HEAD['"]\s*\)/
const BATCH_STATUS_PATTERN =
  /(?:\bbatch\.status\s*[!=]==?\s*['"](?:open|closed|abandoned|created|active|pending)['"])|(?:['"](?:open|closed|abandoned|created|active|pending)['"]\s*[!=]==?\s*\bbatch\.status\b)/
const LEASE_LEDGER_PATTERN = /['"](?:leases\.json|leases\.json\.lock|leases\.lock)['"]/
const BLOCKED_WRITE_PATTERN = /(?:\bstatus\s*=\s*['"]blocked['"])|(?:['"]status['"]\s*:\s*['"]blocked['"])/

/**
 * Count top-level arguments in a call's argument text.
 * @param {string} args
 * @returns {number}
 */
function argumentCount(args) {
  const trimmed = args.trim()
  if (trimmed.length === 0) return 0
  let depth = 0
  let count = 1
  for (const char of trimmed) {
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) count += 1
  }
  return count
}

/**
 * @param {string} source
 * @returns {Array<{ rule: string, detail: string }>}
 */
export function inspectSource(source) {
  const violations = []
  const lines = source.split('\n')
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`
    const trimmed = line.trim()
    // Documentation may quote the vocabulary it forbids; only code counts.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    if (KIND_PATTERN.test(line)) {
      violations.push({ rule: 'kind-literal', detail: `${at}: ${line.trim()} — resolve shapeFor(mission.kind) instead` })
    }
    if (ROLE_PATTERN.test(line)) {
      violations.push({ rule: 'role-literal', detail: `${at}: ${line.trim()} — use the vocabulary role predicates instead` })
    }
    if (GLOBAL_VOCAB_PATTERN.test(line)) {
      violations.push({ rule: 'global-status-vocabulary', detail: `${at}: ${line.trim()} — use shape.isTerminal(status) / shape.transitions` })
    }
    if (REVIEW_TIP_PATTERN.test(line)) {
      violations.push({
        rule: 'review-tip-read',
        detail: `${at}: ${line.trim()} — stamp reviews with a recorded commit (tower.branchTip(mission)) instead of a live worktree HEAD`,
      })
    }
    if (BATCH_STATUS_PATTERN.test(line)) {
      violations.push({
        rule: 'batch-status-literal',
        detail: `${at}: ${line.trim()} — use BATCH_STATUS / canTransitionBatch from domain/batch.js`,
      })
    }
    if (LEASE_LEDGER_PATTERN.test(line)) {
      violations.push({
        rule: 'lease-ledger',
        detail: `${at}: ${line.trim()} — the lease ledger is owned by adapters/leases.js`,
      })
    }
    if (BLOCKED_WRITE_PATTERN.test(line)) {
      violations.push({
        rule: 'blocked-status-write',
        detail: `${at}: ${line.trim()} — blocked is derived from open blockers: use markBlocked(mission, text)`,
      })
    }
    for (const match of line.matchAll(CALL_PATTERN)) {
      const expected = match[1] === 'isTerminal' ? 2 : 3
      if (argumentCount(match[2]) < expected) {
        violations.push({
          rule: 'shape-entry-point',
          detail: `${at}: ${match[0]} — the only entry points are isTerminal(kind, status) and canTransition(kind, from, to)`,
        })
      }
    }
  })
  return violations
}

/**
 * @param {string} start
 * @returns {string[]}
 */
function walk(start) {
  const files = []
  if (!fs.existsSync(start)) return files
  for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
    const full = path.join(start, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      files.push(...walk(full))
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      files.push(full)
    }
  }
  return files
}

/**
 * @param {string} repoRoot
 * @returns {{ path: string, rule: string, detail: string }[]}
 */
export function scan(repoRoot) {
  const results = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(repoRoot, dir))) {
      const relative = path.relative(repoRoot, file).split(path.sep).join('/')
      if (relative.startsWith(`${SHAPE_DIR}/`)) continue
      const source = fs.readFileSync(file, 'utf8')
      for (const violation of inspectSource(source)) {
        const exempt = RULE_EXEMPT_PATHS[violation.rule] ?? []
        if (exempt.includes(relative)) continue
        results.push({ path: relative, ...violation })
      }
    }
  }
  return results
}

/**
 * @param {string} repoRoot
 * @returns {{ waivers: Array<{ rule?: string, path?: string, reason?: string, owner?: string, ref?: string, match?: string }>, errors: string[] }}
 */
export function loadShapeWaivers(repoRoot) {
  const file = path.join(repoRoot, WAIVER_FILE)
  if (!fs.existsSync(file)) return { waivers: [], errors: [`${WAIVER_FILE}: missing`] }
  let document
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return { waivers: [], errors: [`${WAIVER_FILE}: not valid JSON (${String(error?.message ?? error)})`] }
  }
  const entries = document?.[WAIVER_KEY] ?? []
  if (!Array.isArray(entries)) return { waivers: [], errors: [`${WAIVER_FILE}: ${WAIVER_KEY} must be an array`] }
  const errors = []
  for (const [index, entry] of entries.entries()) {
    const where = `${WAIVER_FILE} ${WAIVER_KEY}[${index}]`
    if (!entry || typeof entry !== 'object') {
      errors.push(`${where}: must be an object`)
      continue
    }
    if (typeof entry.rule !== 'string' || entry.rule.length === 0) errors.push(`${where}: rule is required`)
    if (typeof entry.path !== 'string' || entry.path.length === 0) errors.push(`${where}: path is required`)
    if (typeof entry.reason !== 'string' || entry.reason.length === 0) errors.push(`${where}: reason is required`)
    if (!entry.owner && !entry.ref) errors.push(`${where}: owner or ref is required`)
  }
  return { waivers: errors.length === 0 ? entries : [], errors }
}

/**
 * @param {{ path: string, rule: string, detail: string }[]} violations
 * @param {Array<{ rule?: string, path?: string, match?: string }>} waivers
 * @returns {{ violations: typeof violations, waived: typeof violations, unused: Array<{ rule?: string, path?: string }> }}
 */
export function applyWaivers(violations, waivers) {
  const waived = []
  const used = new Set()
  const remaining = []
  for (const violation of violations) {
    const index = waivers.findIndex((waiver) => {
      if (waiver.path !== violation.path) return false
      if (waiver.rule !== violation.rule) return false
      if (waiver.match && !violation.detail.includes(waiver.match)) return false
      return true
    })
    if (index >= 0) {
      used.add(index)
      waived.push(violation)
    } else {
      remaining.push(violation)
    }
  }
  const unused = waivers.filter((_, index) => !used.has(index))
  return { violations: remaining, waived, unused }
}

/**
 * @param {string} repoRoot
 * @returns {{ ok: boolean, violations: any[], waived: any[], errors: string[], unused: any[] }}
 */
export function evaluator(repoRoot = root) {
  const reported = []
  const waivers = loadShapeWaivers(repoRoot)
  if (waivers.errors.length > 0) return { ok: false, violations: [], waived: [], errors: waivers.errors, unused: [] }
  const applied = applyWaivers(scan(repoRoot), waivers.waivers)
  for (const violation of applied.violations) {
    reported.push(`shape-audit error: [${violation.rule}] ${violation.path} ${violation.detail}`)
  }
  if (applied.unused.length > 0) {
    for (const waiver of applied.unused) {
      reported.push(`shape-audit error: [stale-waiver] ${waiver.path} ${waiver.rule} no longer matches a violation; remove it`)
    }
  }
  return {
    ok: reported.length === 0,
    violations: applied.violations,
    waived: applied.waived,
    errors: reported,
    unused: applied.unused,
  }
}

function main(argv) {
  const rootIndex = argv.indexOf('--root')
  const repoRoot = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : root
  const result = evaluator(repoRoot)
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (result.ok) {
    process.stdout.write(`shape-audit: ok (waived: ${result.waived.length})\n`)
  } else {
    for (const line of result.errors) process.stderr.write(`${line}\n`)
  }
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
