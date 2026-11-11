// Published support floor gate (#M71 W4-A).
//
// The floor is stated in six places for six different readers: the package
// manifest and its lock (npm), the mount-smoke host pin (what CI boots), the
// live workflow matrix (what the nightly installs), and the newest
// COMPATIBILITY.md row (what the release claims). scripts/support.json is the
// single manifest; this gate fails when any of the other five disagrees, so a
// host bump cannot leave a stale floor behind.
//
// Usage: node scripts/check-support.mjs [--root <dir>] [--json] [--help]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCompatibility, parseVersion } from '../host/compatibility.js'
import { parseArgs, runMain } from './lib/cli.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = 'usage: node scripts/check-support.mjs [--root <dir>] [--json] [--help]'

const SUPPORT_FILE = 'scripts/support.json'
const PACKAGE_FILE = 'package.json'
const LOCK_FILE = 'package-lock.json'
const HOST_PIN_FILE = 'scripts/mount-smoke/host.json'
const WORKFLOW_FILE = '.github/workflows/test.yml'
const COMPATIBILITY_FILE = 'COMPATIBILITY.md'

// A floor is one open-ended semver range ("more than or equal to"); exact
// versions, caret/tilde ranges and unions would make the CI matrix ambiguous.
const NODE_RANGE = /^>=\d+(?:\.\d+){0,2}$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * Return the text of one top-level job in a GitHub Actions workflow, or null.
 * Jobs are the only keys at two-space indentation under `jobs:`.
 */
export function jobBlock(workflow, id) {
  const lines = String(workflow ?? '').split('\n')
  const start = lines.findIndex((line) => line === `  ${id}:`)
  if (start === -1) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/** The dsh versions listed under the live job's matrix, in file order. */
export function liveMatrixPins(workflow) {
  const block = jobBlock(workflow, 'live')
  if (!block) return []
  const pins = []
  let inDsh = false
  let dshIndent = 0
  for (const line of block.split('\n')) {
    const key = line.match(/^(\s+)dsh:\s*$/)
    if (key) {
      inDsh = true
      dshIndent = key[1].length
      continue
    }
    if (!inDsh) continue
    if (line.trim() === '') continue
    const item = line.match(/^(\s+)-\s*'?([^'\s#]+)'?\s*(?:#.*)?$/)
    if (item && item[1].length > dshIndent) {
      pins.push(item[2])
      continue
    }
    inDsh = false
  }
  return pins
}

/** The newest COMPATIBILITY.md row (the file lists newest first), or null. */
export function newestCompatibilityRow(text) {
  return parseCompatibility(text)[0] ?? null
}

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))
}

/** Read the manifest and every place that restates it. */
export function readSupportInputs(root = packageRoot) {
  return {
    support: readJson(root, SUPPORT_FILE),
    packageJson: readJson(root, PACKAGE_FILE),
    packageLock: readJson(root, LOCK_FILE),
    hostPin: readJson(root, HOST_PIN_FILE),
    workflow: fs.readFileSync(path.join(root, WORKFLOW_FILE), 'utf8'),
    compatibility: fs.readFileSync(path.join(root, COMPATIBILITY_FILE), 'utf8'),
  }
}

function floorProblem(source, field, actual, expected) {
  if (actual === undefined || actual === null || actual === '') {
    return `${source}: ${field} is missing; it must repeat ${JSON.stringify(expected)} from ${SUPPORT_FILE}`
  }
  return `${source}: ${field} is ${JSON.stringify(actual)}; ${SUPPORT_FILE} sets ${JSON.stringify(expected)}`
}

/**
 * Compare the manifest with every restatement of it.
 * @returns {{ ok: boolean, problems: string[], facts: object }}
 */
export function evaluateSupport({ support, packageJson, packageLock, hostPin, workflow, compatibility } = {}) {
  const problems = []
  const node = typeof support?.node === 'string' ? support.node.trim() : ''
  const dsh = typeof support?.dsh === 'string' ? support.dsh.trim() : ''
  const nodeIsRange = NODE_RANGE.test(node)
  if (!nodeIsRange) {
    problems.push(
      `${SUPPORT_FILE}: node is ${JSON.stringify(support?.node)}; it must be one ">=" range such as ">=24.9"`,
    )
  }
  if (!EXACT_VERSION.test(dsh) || !parseVersion(dsh)) {
    problems.push(`${SUPPORT_FILE}: dsh is ${JSON.stringify(support?.dsh)}; it must be one exact version such as "0.2.2-rc.1"`)
  }

  if (nodeIsRange) {
    const engine = packageJson?.engines?.node
    if (engine !== node) problems.push(floorProblem(PACKAGE_FILE, 'engines.node', engine, node))

    const lockEngine = packageLock?.packages?.['']?.engines?.node
    if (lockEngine !== node) problems.push(floorProblem(`${LOCK_FILE} (packages[""])`, 'engines.node', lockEngine, node))

    const pin = hostPin?.dsh
    if (pin !== dsh) problems.push(floorProblem(HOST_PIN_FILE, 'dsh', pin, dsh))
  }

  const pins = liveMatrixPins(workflow)
  if (pins.length !== 1) {
    problems.push(
      `${WORKFLOW_FILE}: live job matrix lists ${pins.length} dsh versions (${pins.join(', ') || 'none'}); exactly one pin (${JSON.stringify(dsh)}) is required`,
    )
  } else if (pins[0] !== dsh) {
    problems.push(floorProblem(`${WORKFLOW_FILE} (live matrix)`, 'dsh', pins[0], dsh))
  }

  const row = newestCompatibilityRow(compatibility)
  if (!row) {
    problems.push(`${COMPATIBILITY_FILE}: no version row; the newest row must verify ${JSON.stringify(dsh)}`)
  } else {
    if (row.hostVersion !== dsh) problems.push(floorProblem(COMPATIBILITY_FILE, 'newest row host version', row.hostVersion, dsh))
    if (nodeIsRange && !row.ran.includes(`Node ${node}`)) {
      problems.push(
        `${COMPATIBILITY_FILE}: newest row (${row.hostVersion}) does not state the Node floor ${JSON.stringify(`Node ${node}`)}; it ran ${JSON.stringify(row.ran)}`,
      )
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    facts: {
      node,
      dsh,
      packageEngine: packageJson?.engines?.node ?? null,
      lockEngine: packageLock?.packages?.['']?.engines?.node ?? null,
      hostPin: hostPin?.dsh ?? null,
      liveMatrixPins: pins,
      newestRow: row ? { hostVersion: row.hostVersion, tag: row.commit, verifiedOn: row.verifiedOn } : null,
    },
  }
}

export function evaluateSupportAt(root = packageRoot) {
  return evaluateSupport(readSupportInputs(root))
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    initial: { root: packageRoot, json: false, help: false },
    flags: { '--json': 'json', '--help': 'help' },
    values: { '--root': { key: 'root', parse: (value) => path.resolve(value) } },
  })
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const result = evaluateSupportAt(options.root)
  if (options.json) console.log(JSON.stringify(result, null, 2))
  if (!result.ok) {
    for (const problem of result.problems) console.error(`support check: ${problem}`)
    return 1
  }
  if (!options.json) {
    const tag = result.facts.newestRow?.tag ?? result.facts.newestRow?.hostVersion
    console.log(
      `support ok: Node ${result.facts.node}, DSH ${result.facts.dsh}, package engines/lock, host pin, live matrix and COMPATIBILITY ${tag} agree`,
    )
  }
  return 0
}

await runMain(import.meta.url, () => main(), { errorPrefix: 'support check', usage: USAGE })
