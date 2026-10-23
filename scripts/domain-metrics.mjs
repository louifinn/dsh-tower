import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_ROOTS = ['domain', 'app', 'tools', 'adapters', 'host']
const ENTRY_FILES = ['index.js', 'worker.js', 'reviewer.js', 'skills.js']
const PURE_ROOTS = ['domain']
// #71: the optional Web client is its own tier. It is printed on every run so
// its growth is visible in CI, but it stays out of the pure-domain denominator:
// the share measures the Host architecture, not the browser widget.
const CLIENT_ROOT = 'ui-bundle'

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

function loc(file) {
  return fs.readFileSync(file, 'utf8').split('\n').length
}

const files = SOURCE_ROOTS.flatMap((dir) => walk(path.join(root, dir)))
for (const file of ENTRY_FILES) {
  const full = path.join(root, file)
  if (fs.existsSync(full)) files.push(full)
}
let pure = 0
let total = 0
for (const file of files) {
  const lines = loc(file)
  total += lines
  const relative = path.relative(root, file).split(path.sep).join('/')
  if (PURE_ROOTS.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) pure += lines
}
const clientLines = walk(path.join(root, CLIENT_ROOT)).reduce((sum, file) => sum + loc(file), 0)
const share = total === 0 ? 0 : pure / total
const result = { pure, total, share: Number(share.toFixed(4)), uiBundle: clientLines }
function printMetrics() {
  console.log(`domain-metrics: pure domain share ${(share * 100).toFixed(1)}% (${pure}/${total})`)
  console.log(`domain-metrics: ui-bundle ${clientLines} lines (client tier; excluded from the pure-domain share)`)
}
if (process.argv.includes('--json')) console.log(JSON.stringify(result))
else if (process.argv.includes('--check')) {
  if (share < 0.35) {
    console.error(`domain-metrics: pure domain share ${(share * 100).toFixed(1)}% < 35% (${pure}/${total})`)
    process.exit(1)
  }
  printMetrics()
} else {
  printMetrics()
}
