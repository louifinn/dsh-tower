// Type-coverage fitness rule (#115, step 1).
//
// The checked program must be derived from the shipped program: every runtime
// `.js` file that `package.json` publishes has to appear in the `tsc` program,
// otherwise "this file is unchecked" cannot even be reported. Today the
// tsconfig `include` list is hand-written, so a new module outside it is
// invisible by construction; this gate makes that gap a red check.
//
// Run: node scripts/types-coverage.mjs [--root <dir>] [--json]
//
// The shipped set comes from `package.json` `files` (the same list `npm pack`
// uses; scripts/pack-manifest.txt pins the reviewed snapshot). The checked set
// comes from `tsc --noEmit --listFiles`, so no second enumeration is involved:
// changing the tsconfig is enough and this gate follows.
//
// Excluded tiers are data with a reason, not silent gaps:
//   - `client.js` is the core Web Client half (#M40): a browser artifact checked
//     by tests/plugin-config-client.test.mjs and the client rules, not by the
//     Node tsc program;
//   - `ui-bundle/**` is the optional Web client: a browser artifact with DOM
//     types and no Node runtime, checked by tests/ui-bundle.test.mjs and the
//     architecture client rules instead of the Node tsc program;
//   - `scripts/**` is build/dev tooling (ESM `.mjs`, not plugin runtime).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const SELF_ROOT = path.resolve(MODULE_DIR, '..')
const TSC_BIN = path.join(SELF_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const WALK_SKIP = new Set(['node_modules', '.git', '.dsh-tower-worktrees', 'coverage', '.nyc_output'])

/** Shipped `.js` tiers that are deliberately outside the Node tsc program. */
export const NOT_CHECKED_TIERS = [
  {
    pattern: 'client.js',
    reason: 'core Web client: browser artifact, checked by tests/plugin-config-client.test.mjs',
  },
  {
    pattern: 'ui-bundle/**',
    reason: 'optional Web client: browser artifact, checked by tests/ui-bundle.test.mjs and the client architecture rules',
  },
  {
    pattern: 'scripts/**',
    reason: 'build/dev tooling, not plugin runtime',
  },
]

/** Expand one package.json `files` pattern into repo-relative paths. */
export function globToRegExp(pattern) {
  const source = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000\//g, '(?:[^/]+/)*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${source}$`)
}

function walkFiles(root, relative = '') {
  const dir = path.join(root, relative)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (WALK_SKIP.has(entry.name)) continue
    const next = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walkFiles(root, next))
    else out.push(next)
  }
  return out
}

/**
 * Resolve `package.json` `files` into the repo-relative file list.
 * A trailing slash (or a bare directory name) means the whole directory, the
 * same reading `npm pack` gives it.
 * @param {string[]} patterns
 * @param {string[]} files every repo-relative file
 * @returns {string[]}
 */
export function expandShipped(patterns, files) {
  const out = new Set()
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue
    const normalized = pattern.endsWith('/') ? `${pattern}**` : pattern
    const matcher = globToRegExp(normalized)
    const directory = !/\*|\?/.test(normalized) && files.some((file) => file.startsWith(`${normalized}/`))
    const hit = (file) => (directory ? file === normalized || file.startsWith(`${normalized}/`) : matcher.test(file))
    for (const file of files) if (hit(file)) out.add(file)
  }
  return [...out].sort()
}

/**
 * The Node-runtime slice of the shipped set: `.js` files minus the documented
 * non-Node tiers.
 * @param {string[]} shipped
 * @returns {{ runtime: string[], excluded: Array<{ file: string, reason: string }> }}
 */
export function runtimeJavaScript(shipped) {
  const excluded = []
  const runtime = []
  for (const file of shipped) {
    if (!file.endsWith('.js')) continue
    const tier = NOT_CHECKED_TIERS.find((entry) => globToRegExp(entry.pattern).test(file))
    if (tier) excluded.push({ file, reason: tier.reason })
    else runtime.push(file)
  }
  return { runtime: runtime.sort(), excluded }
}

/**
 * Compare the shipped runtime set with the checked program. One direction only:
 * a shipped file outside the program fails. Extra program files (tests/*.ts,
 * the declaration files, fixture helpers) are expected and allowed.
 * @param {{ runtime: string[], program: string[] }} input
 * @returns {{ ok: boolean, missing: string[], checked: number, total: number }}
 */
export function evaluateCoverage({ runtime, program }) {
  const checked = new Set(program)
  const missing = runtime.filter((file) => !checked.has(file))
  return { ok: missing.length === 0, missing, checked: runtime.length - missing.length, total: runtime.length }
}

/** List the project files (never node_modules) in the `tsc` program. */
function programFiles(root) {
  const config = path.join(root, 'tsconfig.json')
  if (!fs.existsSync(config)) throw new Error(`no tsconfig.json under ${root}`)
  if (!fs.existsSync(TSC_BIN)) throw new Error('typescript is not installed; run npm ci first')
  let output
  try {
    output = execFileSync(process.execPath, [TSC_BIN, '--noEmit', '--listFiles', '-p', config], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    // A program with type errors still lists its files; only a config failure
    // (no input at all) is fatal for this gate. Keep diagnostics out of the
    // parse by only accepting existing absolute paths.
    output = String(error?.stdout ?? '')
    if (!output.trim()) throw new Error(`tsc --listFiles failed: ${String(error?.stderr ?? error?.message ?? error)}`)
  }
  const files = new Set()
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (!line || !path.isAbsolute(line)) continue
    if (!fs.existsSync(line)) continue
    const relative = path.relative(root, line).split(path.sep).join('/')
    if (!relative || relative.startsWith('..') || relative.startsWith('node_modules/')) continue
    if (relative.includes('/node_modules/')) continue
    files.add(relative)
  }
  return [...files].sort()
}

function main() {
  const rootArg = process.argv.indexOf('--root')
  const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : SELF_ROOT
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const shipped = expandShipped(Array.isArray(pkg.files) ? pkg.files : [], walkFiles(root))
  const { runtime, excluded } = runtimeJavaScript(shipped)
  let program
  try {
    program = programFiles(root)
  } catch (error) {
    console.error(`types coverage: ${String(error?.message ?? error)}`)
    process.exit(1)
  }
  const result = evaluateCoverage({ runtime, program })
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...result, program: program.length, excluded }, null, 2))
  } else if (result.ok) {
    console.log(
      `types coverage: ${result.checked}/${result.total} shipped runtime .js files are in the tsc program` +
        ` (${program.length} program files, ${excluded.length} excluded: ${[...new Set(excluded.map((entry) => entry.file.split('/')[0]))].join(', ') || 'none'})`,
    )
  } else {
    console.error(
      `types coverage: ${result.missing.length} shipped runtime .js file(s) are outside the tsc program:`,
    )
    for (const file of result.missing) console.error(`  - ${file}`)
    console.error('add the file (or its directory glob) to tsconfig.json `include`')
  }
  process.exit(result.ok ? 0 : 1)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
