#!/usr/bin/env node
// Concept-budget gate (#84): compare the live surface with the committed
// baseline and require evidence for growth.
//
// The surface is four counts the user has to hold at once:
//   config keys   leaf keys in domain/config/schema.js (one level deep)
//   sections      object groups in that schema
//   tools         every tool the Host entry registers, including the
//                 tower_mode tool that index.js registers
//                 directly rather than through define() (#118)
//   components    user-visible rows in every shipped cordis.patch.yml (#120,
//                 #134), so the 2.3.0 4 -> 1 contraction and any future move
//                 need a written decision
//   profiles      (#163) per-profile mounted tool counts and advertised
//                 input-schema bytes for the tower/worker/reviewer presets:
//                 consolidation work is judged by these numbers, so moving one
//                 needs a dated decision in the same baseline
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
import { COMPONENT_PATCH_FILES, mergeCordisPatches, parseCordisPatch } from '../domain/components.js'
import {
  SURFACE_BASELINE_FILE,
  SURFACE_CLASSIFICATION_FILE,
  SURFACE_PROFILES,
  TOOL_DESCRIPTION_BUDGET,
  surfaceLine,
} from '../domain/surface.js'
import { REVIEWER_ALLOW, ROLE_TOOLS, WORKER_ALLOW } from '../host/tool-profiles.js'
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
date. The per-profile tool counts and advertised input-schema bytes (tower,
worker, reviewer) are two-way and need a dated decision for any change. Every
advertised tool description must stay within ${TOOL_DESCRIPTION_BUDGET} characters.
The classification table in
${SURFACE_CLASSIFICATION_FILE} must cover every key and tool exactly once, and
the component count comes from the visible rows in every shipped
cordis.patch.yml.`

/**
 * The advertised input-schema bytes of one tool definition: the JSON a client
 * receives for `parameters`, measured in UTF-8 bytes (#163).
 * @param {{ parameters?: unknown }} definition
 */
function schemaBytes(definition) {
  return Buffer.byteLength(JSON.stringify(definition.parameters ?? {}), 'utf8')
}

/**
 * Per-profile counts (#163): each profile mounts a different subset, and each
 * pays the advertised input-schema bytes of that subset on every request.
 *
 * The tower profile is the default Host surface (`defaultDefinitions`, before
 * the optional capability rows are applied). The worker and reviewer profiles
 * are the very allow-lists their presets install (`worker.js` / `reviewer.js`),
 * intersected with the tools this build registers — so a rename cannot leave
 * the budget measuring a stale list.
 *
 * @param {Map<string, any>} definitions the default-profile definitions
 */
function profileCounts(definitions) {
  const all = [...definitions.values()]
  const measure = (allow) => {
    const selected = allow ? all.filter((definition) => allow.includes(definition.name)) : all
    return {
      tools: selected.length,
      inputBytes: selected.reduce((total, definition) => total + schemaBytes(definition), 0),
    }
  }
  // #163 Phase 5: the tower profile does not advertise the role-owned tools
  // (complete/review belong to worker/survey/reviewer sessions), though they
  // stay in the default registered set and the all-on build surface.
  const towerAllow = all.filter((definition) => !Object.hasOwn(ROLE_TOOLS, definition.name)).map((definition) => definition.name)
  return { tower: measure(towerAllow), worker: measure(WORKER_ALLOW), reviewer: measure(REVIEWER_ALLOW) }
}

/**
 * The live surface used by the gate. Exported so tests can compare the counts
 * with the generated references without spawning the CLI.
 * @param {string} [root] repository root (defaults to this package)
 */
export function liveSurface(root = PACKAGE_ROOT) {
  const config = configSurface()
  const surface = loadShippedToolSurface()
  let tools
  let profiles
  let descriptions
  try {
    tools = surface.names
    profiles = profileCounts(surface.defaultDefinitions)
    // #163: the 300-char advertised-description budget is checked for every
    // shipped tool, including the optional capability rows.
    descriptions = [...surface.definitions.values()].map((definition) => ({
      name: definition.name,
      length: String(definition.description ?? '').length,
    }))
  } finally {
    surface.dispose()
  }
  // #134: the counted component surface is every shipped patch, not only the
  // root one; `ui-bundle/cordis.patch.yml` ships the tower-ui row.
  const patches = {}
  for (const file of COMPONENT_PATCH_FILES) {
    const patchFile = path.join(root, file)
    if (!fs.existsSync(patchFile)) continue
    patches[file] = parseCordisPatch(fs.readFileSync(patchFile, 'utf8'))
  }
  const patch = mergeCordisPatches(patches)
  return {
    configKeys: config.count,
    sections: config.sections.length,
    tools: tools.length,
    components: patch.visible.length,
    profiles,
    descriptions,
    liveNames: {
      configKeys: config.keys,
      sections: config.sections,
      tools,
      components: patch.visible,
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
  console.log(`surface: components: ${current.components} visible (${current.liveNames.components.join(', ')})`)
  const profileLine = SURFACE_PROFILES.map(
    (profile) => `${profile} ${current.profiles[profile].tools} tools / ${current.profiles[profile].inputBytes} B input schema`,
  ).join(' · ')
  console.log(`surface: profiles: ${profileLine}`)
  const longest = [...current.descriptions].sort((left, right) => right.length - left.length)[0]
  console.log(
    `surface: descriptions: ${current.descriptions.length} tools, longest ${longest ? `${longest.length} chars (${longest.name})` : '0 chars'} · budget ${TOOL_DESCRIPTION_BUDGET}`,
  )
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
