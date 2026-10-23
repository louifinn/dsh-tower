// Strict type ratchet (#115, step 4).
//
// `tsconfig.strict.json` turns `noImplicitAny: true` on for an explicit,
// growing file list. The list is the ratchet: CI runs the strict config, and
// this gate makes the list a reviewed artifact instead of a file that can
// silently shrink.
//
// Run: node scripts/types-strict.mjs [--write] [--allow-shrink] [--root <dir>]
//
//   * no flag          — check: every listed file exists, every file in the
//                        seed tier (`domain/contracts/**`) is listed, and the
//                        reviewed snapshot (scripts/types-strict-manifest.txt)
//                        matches the list exactly.
//   * --write          — record the current list in the snapshot. Removing an
//                        entry additionally needs `--allow-shrink`, so shrinking
//                        the ratchet is a deliberate, visible decision.
//
// The list must stay explicit files: a glob would let a new file enter the
// strict program without a reviewed one-line diff, which is the opposite of a
// ratchet. `domain/contracts/**` is the seed tier: adding a file there fails
// the check until the list and the snapshot name it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MANIFEST = 'scripts/types-strict-manifest.txt'
const SEED_DIRECTORIES = ['domain/contracts']

function walk(root, relative) {
  const dir = path.join(root, relative)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = `${relative}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(root, next))
    else out.push(next)
  }
  return out
}

/** Entries that are not repo-relative explicit files. @param {unknown} include */
export function invalidEntries(include) {
  if (!Array.isArray(include) || include.length === 0) return ['include must be a non-empty array of files']
  const problems = []
  for (const entry of include) {
    if (typeof entry !== 'string' || entry.length === 0) {
      problems.push(`${JSON.stringify(entry)} is not a non-empty path`)
      continue
    }
    if (path.isAbsolute(entry) || entry.includes('\\') || entry.split('/').includes('..')) {
      problems.push(`${entry}: use a repo-relative path with forward slashes`)
    } else if (/[*?]/.test(entry)) {
      problems.push(`${entry}: the strict list must name explicit files, not a glob`)
    }
  }
  return problems
}

/** @param {{ include: string[], manifest: string[] }} input */
export function compareLists({ include, manifest }) {
  const listed = new Set(include)
  const pinned = new Set(manifest)
  return {
    lost: manifest.filter((file) => !listed.has(file)).sort(),
    grew: include.filter((file) => !pinned.has(file)).sort(),
  }
}

/** Every seed-tier file the strict list must name. */
function seedFiles(root) {
  return SEED_DIRECTORIES.flatMap((directory) => walk(root, directory)).filter((file) => file.endsWith('.js')).sort()
}

function readManifest(root) {
  const file = path.join(root, MANIFEST)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
}

function fail(lines) {
  console.error('types strict: the ratchet would shrink or drift:')
  for (const line of lines) console.error(`  - ${line}`)
  process.exit(1)
}

function main() {
  const rootArg = process.argv.indexOf('--root')
  const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : SELF_ROOT
  const write = process.argv.includes('--write')
  const allowShrink = process.argv.includes('--allow-shrink')
  const configFile = path.join(root, 'tsconfig.strict.json')

  if (!fs.existsSync(configFile)) {
    console.error(`types strict: ${path.relative(process.cwd(), configFile)} is missing`)
    process.exit(1)
  }
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  if (config?.compilerOptions?.noImplicitAny !== true) {
    console.error('types strict: tsconfig.strict.json must set compilerOptions.noImplicitAny: true explicitly')
    process.exit(1)
  }
  const include = Array.isArray(config.include) ? config.include : []
  const invalid = invalidEntries(include)
  if (invalid.length > 0) fail(invalid)

  const missingFiles = include.filter((file) => !fs.existsSync(path.join(root, file)))
  if (missingFiles.length > 0) fail(missingFiles.map((file) => `${file}: listed in tsconfig.strict.json but does not exist`))

  const seeds = seedFiles(root)
  const unlistedSeeds = seeds.filter((file) => !include.includes(file))
  if (unlistedSeeds.length > 0) {
    fail(unlistedSeeds.map((file) => `${file}: in the seed tier but not in tsconfig.strict.json include`))
  }

  const manifest = readManifest(root)
  const { lost, grew } = compareLists({ include, manifest })
  if (write) {
    if (lost.length > 0 && !allowShrink) {
      fail([
        ...lost.map((file) => `${file}: pinned in ${MANIFEST} but missing from tsconfig.strict.json include`),
        'pass --allow-shrink to record a deliberate removal',
      ])
    }
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, MANIFEST), `${[...include].sort().join('\n')}\n`)
    console.log(`types strict: wrote ${include.length} files to ${MANIFEST} (${lost.length} removed, ${grew.length} added)`)
    return
  }

  if (lost.length > 0 || grew.length > 0) {
    fail([
      ...lost.map((file) => `${file}: pinned in ${MANIFEST} but no longer checked (the ratchet must not shrink)`),
      ...grew.map((file) => `${file}: newly checked but not pinned; run npm run types:strict:write to record it`),
    ])
  }
  console.log(`types strict: ${include.length} files pinned, noImplicitAny over ${SEED_DIRECTORIES.join(', ')}/**`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
