// Static blocker-emission gate (#M62 W2-A).
//
// The registry in `domain/shapes/blockers.js` is the single blocker vocabulary.
// `domain/gate.js`, the shapes, and `domain/batch.js` validate at runtime, but
// the composition layer (`app/**`, `domain/integration/**`, `domain/scope.js`,
// `host/tool-registry.js`) is outside this change and still spells codes as
// literals. This gate reads those literal positions and fails when:
//   - a code is emitted but absent from the registry (a new, undocumented code);
//   - a registry entry is never emitted by any scanned source (a dead entry).
// Error codes (`domain/errors.js`) are allowed in the same positions, so the
// scan stays about blockers without maintaining a second allow-list.
//
// Usage: node scripts/check-blockers.mjs [--check] [--json] [--root <dir>]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ERROR_CODES } from '../domain/errors.js'
import { BLOCKER_CODE_VALUES, BLOCKER_DEFINITIONS } from '../domain/shapes/blockers.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['app', 'domain', 'host']
const EXCLUDED = new Set(['domain/shapes/blockers.js', 'domain/errors.js'])
const CODE = '([a-z][a-z0-9-]+)'

// A literal is in a blocker position when it is assigned to `code`, pushed onto
// a blocker list, passed to `blocker(...)`, or used as the default second
// argument of the batch/merge blocker helper.
const SINGLE_PATTERNS = [
  new RegExp(`\\bcode\\s*:\\s*'${CODE}'`, 'g'),
  new RegExp(`\\bpush\\(\\s*'${CODE}'`, 'g'),
  new RegExp(`\\bblocker\\(\\s*'${CODE}'`, 'g'),
  new RegExp(`\\bcode\\s*=\\s*'${CODE}'`, 'g'),
]
// `blocker(message, 'tests-missing')` in domain/batch.js. Restricting this to
// the one file keeps a caller's quoted detail from being read as a code.
const SECOND_ARG_PATTERN = new RegExp(`\\bblocker\\([^)\\n]*,\\s*'${CODE}'\\)`, 'g')
// `code: conflict ? 'merge-conflict' : 'merge-hook-failed'` in app/merge.js.
const CODE_TERNARY = new RegExp(`\\bcode\\s*:\\s*[^,\\n]*\\?\\s*'${CODE}'\\s*:\\s*'${CODE}'`, 'g')
// `mergeFailureKind()` in domain/integration/merge.js returns the same pair.
const MERGE_KIND_TERNARY = new RegExp(`\\breturn\\s+[^;\\n]*\\?\\s*'${CODE}'\\s*:\\s*'${CODE}'`, 'g')

/**
 * @param {string} relative
 * @param {string} text
 * @returns {{ code: string, line: number, column: number }[]}
 */
export function scanSource(relative, text) {
  const found = []
  const add = (code, index) => {
    const before = text.slice(0, index)
    const line = before.split('\n').length
    const column = index - before.lastIndexOf('\n')
    found.push({ code, line, column })
  }
  for (const pattern of SINGLE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) add(match[1], match.index ?? 0)
  }
  if (relative === 'domain/batch.js') {
    SECOND_ARG_PATTERN.lastIndex = 0
    for (const match of text.matchAll(SECOND_ARG_PATTERN)) add(match[1], match.index ?? 0)
  }
  if (relative === 'app/merge.js') {
    CODE_TERNARY.lastIndex = 0
    for (const match of text.matchAll(CODE_TERNARY)) {
      add(match[1], match.index ?? 0)
      add(match[2], match.index ?? 0)
    }
  }
  if (relative === 'domain/integration/merge.js') {
    MERGE_KIND_TERNARY.lastIndex = 0
    for (const match of text.matchAll(MERGE_KIND_TERNARY)) {
      add(match[1], match.index ?? 0)
      add(match[2], match.index ?? 0)
    }
  }
  return found
}

/**
 * Pure analysis so tests can mutate both sides without touching the checkout.
 * @param {{
 *   sources: Array<{ path: string, text: string }>,
 *   registered?: ReadonlyArray<string>,
 *   errorCodes?: ReadonlyArray<string>,
 * }} input
 * @returns {{ ok: boolean, emitted: string[], unknown: Array<{ code: string, path: string, line: number }>, missing: string[] }}
 */
export function analyze({ sources, registered = BLOCKER_CODE_VALUES, errorCodes = Object.keys(ERROR_CODES) }) {
  const allowedErrors = new Set(errorCodes)
  const registeredSet = new Set(registered)
  const emitted = new Set()
  const unknown = []
  for (const source of sources) {
    for (const hit of scanSource(source.path, source.text)) {
      if (registeredSet.has(hit.code)) emitted.add(hit.code)
      else if (!allowedErrors.has(hit.code)) unknown.push({ code: hit.code, path: source.path, line: hit.line })
    }
  }
  const missing = registered.filter((code) => !emitted.has(code))
  return { ok: unknown.length === 0 && missing.length === 0, emitted: [...emitted].sort(), unknown, missing }
}

function walk(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      files.push(...walk(full))
    } else if (entry.name.endsWith('.js')) files.push(full)
  }
  return files
}

/** @param {string} repoRoot */
export function collectSources(repoRoot) {
  const sources = []
  for (const dir of SCAN_DIRS) {
    const absolute = path.join(repoRoot, dir)
    if (!fs.existsSync(absolute)) continue
    for (const file of walk(absolute)) {
      const relative = path.relative(repoRoot, file).split(path.sep).join('/')
      if (EXCLUDED.has(relative)) continue
      sources.push({ path: relative, text: fs.readFileSync(file, 'utf8') })
    }
  }
  return sources
}

/** @param {string} repoRoot */
export function evaluate(repoRoot = root) {
  return analyze({ sources: collectSources(repoRoot) })
}

function main(argv) {
  const rootIndex = argv.indexOf('--root')
  const repoRoot = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : root
  const result = evaluate(repoRoot)
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (result.ok) {
    const count = (kind) => BLOCKER_DEFINITIONS.filter((entry) => entry.kinds.includes(kind)).length
    process.stdout.write(
      `blockers ok: ${result.emitted.length} emitted codes match ${BLOCKER_CODE_VALUES.length} registry entries ` +
        `(${count('gate')} gate, ${count('merge')} merge, ${count('rebase')} rebase)\n`,
    )
  } else {
    for (const hit of result.unknown) {
      process.stderr.write(`blocker check: ${hit.path}:${hit.line}: code "${hit.code}" is emitted but absent from domain/shapes/blockers.js\n`)
    }
    for (const code of result.missing) {
      process.stderr.write(`blocker check: registry code "${code}" is never emitted by any scanned source\n`)
    }
  }
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
