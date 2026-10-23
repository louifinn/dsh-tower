// Generate the component-surface reference from the single source of truth
// (#120). The table is a rendering of `scripts/component-surface.json`; editing
// the markdown by hand fails `npm run docs:check:generated:components`.
//
// Usage:
//   node scripts/generate-component-surface.mjs [--root <dir>] [--check]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPONENT_REFERENCE_FILE,
  COMPONENT_SURFACE_FILE,
  parseComponentSurface,
  renderComponentSurface,
} from '../domain/components.js'
import { readBaseline } from './lib/surface.mjs'
import { parseArgs, runMain } from './lib/cli.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `usage: node scripts/generate-component-surface.mjs [--root <dir>] [--check]

  --root   repository root to read and write (default: this package)
  --check  fail when the committed reference differs instead of writing it
  --help   print this text

The table is generated from ${COMPONENT_SURFACE_FILE}; do not edit
${COMPONENT_REFERENCE_FILE} by hand.`

function main(argv) {
  const options = parseArgs(argv, {
    initial: { root: PACKAGE_ROOT, check: false, help: false },
    values: { '--root': { key: 'root', parse: path.resolve } },
    flags: { '--check': 'check', '--help': 'help', '-h': 'help' },
  })
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const root = path.resolve(options.root)
  const surface = parseComponentSurface(fs.readFileSync(path.join(root, COMPONENT_SURFACE_FILE), 'utf8'))
  const baseline = readBaseline(root)
  const expected = renderComponentSurface(surface, { baselineDate: baseline.date })
  const target = path.join(root, COMPONENT_REFERENCE_FILE)
  if (options.check) {
    const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    if (actual !== expected) {
      console.error(`component reference is stale; run npm run docs:generate:components (${COMPONENT_REFERENCE_FILE})`)
      return 1
    }
    console.log(`component reference: ${surface.keys.length} keys in sync (${COMPONENT_REFERENCE_FILE})`)
    return 0
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, expected)
  console.log(`wrote ${COMPONENT_REFERENCE_FILE} (${surface.keys.length} keys, ${surface.components.length} components)`)
  return 0
}

await runMain(import.meta.url, () => main(process.argv.slice(2)), { errorPrefix: 'components', usage: USAGE })
