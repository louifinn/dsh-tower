// Fail when the published file list drifts from the reviewed snapshot.
// Run: node scripts/check-pack.mjs [--write]
//
// #71: the optional Web client ships inside the main package, so the required
// list asserts the client package manifest and its bundle patch — not just the
// directory's index.js. `requiredMissing` is exported so a fixture can prove
// that removing one of them fails the check.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_FILES = [
  'cordis.patch.yml',
  'index.js',
  'locale/en.json',
  'locale/zh.json',
  'ui-bundle/index.js',
  'ui-bundle/package.json',
  'ui-bundle/cordis.patch.yml',
  'COMPATIBILITY.md',
]

function requiredMissing(paths, required = REQUIRED_FILES) {
  return required.filter((file) => !paths.includes(file))
}

function main() {
  const root = ROOT
  const manifestFile = path.join(root, 'scripts', 'pack-manifest.txt')
  const write = process.argv.includes('--write')

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  let parsed
  try {
    const output = execFileSync(npm, ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    parsed = JSON.parse(output)
  } catch (error) {
    console.error(`pack check: npm pack failed: ${String(error?.message ?? error)}`)
    process.exit(1)
  }

  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  const paths = (entry?.files ?? []).map((file) => file.path).filter(Boolean).sort()
  if (write) {
    fs.writeFileSync(manifestFile, `${paths.join('\n')}\n`)
    console.log(`pack check: wrote ${paths.length} paths to ${path.relative(root, manifestFile)}`)
    process.exit(0)
  }
  const expected = fs.readFileSync(manifestFile, 'utf8').split('\n').filter(Boolean).sort()
  const added = paths.filter((file) => !expected.includes(file))
  const removed = expected.filter((file) => !paths.includes(file))
  if (added.length > 0 || removed.length > 0) {
    console.error('pack check: published file list changed; review and update scripts/pack-manifest.txt')
    if (added.length > 0) console.error(`  added: ${added.join(', ')}`)
    if (removed.length > 0) console.error(`  removed: ${removed.join(', ')}`)
    process.exit(1)
  }
  const missing = requiredMissing(paths)
  if (missing.length > 0) {
    console.error(`pack check: required runtime files missing: ${missing.join(', ')}`)
    process.exit(1)
  }
  console.log(`pack check: ${paths.length} files match scripts/pack-manifest.txt`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()

export { REQUIRED_FILES, requiredMissing }
