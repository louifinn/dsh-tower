#!/usr/bin/env node
// Concept-budget gate (#84): compare the live surface with the committed
// baseline and require evidence for growth.
//
// The surface is three counts the user has to hold at once:
//   config keys   leaf keys in domain/config/schema.js (one level deep)
//   sections      object groups in that schema
//   tools         every tool the Host entry registers, including the
//                 tower_mode/tower_control pair that index.js registers
//                 directly rather than through define() (#118)
//
// `scripts/surface-baseline.json` freezes those counts. A PR that grows a count
// fails here until the baseline carries a decision with either an ADR under
// docs/adr/, deletions that no longer exist in the live surface, or an explicit
// measurement-correction record (reason + date). The same file supplies the date
// and counts printed in the generated config/tools reference headers, so growth
// is visible in a diff.
//
// Usage:
//   node scripts/surface-baseline.mjs [--root <dir>] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configSurface } from '../domain/config/schema.js'
import { SURFACE_CLASSIFICATION_FILE, SURFACE_BASELINE_FILE, surfaceLine } from '../domain/surface.js'
import { loadShippedToolSurface } from './lib/tool-surface.mjs'
import { checkSurfaceBudget } from './lib/surface.mjs'
import { parseArgs, runMain } from './lib/cli.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `usage: node scripts/surface-baseline.mjs [--root <dir>] [--json]

  --root   repository root to check (default: this package)
  --json   print the report as JSON
  --help   print this text

Growth is refused by default. To grow a count, update ${SURFACE_BASELINE_FILE}
with a decision that names an existing docs/adr/ ADR, deletions that are no
longer in the live surface, or a measurement-correction record with a reason and
date. The classification table in
${SURFACE_CLASSIFICATION_FILE} must cover every key and tool exactly once.`

/**
 * The live tool names: apply the shipped Host entry so every registration path
 * is included, then release the mock context's timers.
 */
function liveToolNames() {
  const surface = loadShippedToolSurface()
  try {
    return surface.names
  } finally {
    surface.dispose()
  }
}

/**
 * The live surface used by the gate. Exported so tests can compare the counts
 * with the generated references without spawning the CLI.
 */
export function liveSurface() {
  const config = configSurface()
  const tools = liveToolNames()
  return {
    configKeys: config.count,
    sections: config.sections.length,
    tools: tools.length,
    liveNames: {
      configKeys: config.keys,
      sections: config.sections,
      tools,
    },
  }
}

function main(argv) {
  const options = parseArgs(argv, {
    initial: { root: PACKAGE_ROOT, json: false, help: false },
    values: { '--root': { key: 'root', parse: path.resolve } },
    flags: { '--json': 'json', '--help': 'help', '-h': 'help' },
  })
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const root = path.resolve(options.root)
  if (!fs.existsSync(path.join(root, SURFACE_BASELINE_FILE))) {
    console.error(`surface: ${SURFACE_BASELINE_FILE} is missing under ${root}`)
    return 2
  }
  const current = liveSurface()
  const result = checkSurfaceBudget({ root, current })
  if (options.json) {
    console.log(JSON.stringify({ root, current, ...result }, null, 2))
    return result.ok ? 0 : 1
  }
  console.log(`surface: ${surfaceLine(current)}`)
  if (result.baseline) console.log(`surface: baseline ${result.baseline.date} (${SURFACE_BASELINE_FILE})`)
  if (result.classification) {
    const configRows = result.classification.entries.filter((entry) => entry.kind === 'config').length
    const toolRows = result.classification.entries.filter((entry) => entry.kind === 'tools').length
    console.log(`surface: classified ${configRows} config keys and ${toolRows} tools (${SURFACE_CLASSIFICATION_FILE})`)
  }
  for (const finding of result.findings) console.log(`surface: ${finding.level} [${finding.code}] ${finding.message}`)
  if (result.ok) console.log('surface: ok — counts match the committed baseline and every entry is classified')
  else console.log(`surface: ${result.findings.length} problem(s); growth needs an ADR or a matching deletion`)
  return result.ok ? 0 : 1
}

await runMain(import.meta.url, () => main(process.argv.slice(2)), { errorPrefix: 'surface', usage: USAGE })
