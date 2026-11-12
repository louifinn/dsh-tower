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
//   profileBytes  (#164) per-profile advertised schema bytes for the host
//                 exposure ladder (mode-off/idle/active) and the four role
//                 presets: the role × phase gate is judged by these bytes, so
//                 any drift needs a dated decision and growth needs an ADR
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
import { PRESET_ALLOWS } from '../domain/exposure.js'
import {
  SURFACE_BASELINE_FILE,
  SURFACE_CLASSIFICATION_FILE,
  SURFACE_PROFILES,
  TOOL_DESCRIPTION_BUDGET,
  surfaceLine,
} from '../domain/surface.js'
import { ROLE_TOOLS } from '../host/tool-profiles.js'
import { loadShippedToolSurface } from './lib/tool-surface.mjs'
import { checkSurfaceBudget } from './lib/surface.mjs'
import { collectProfileSurface, validateProfileBytes } from './lib/profile-surface.mjs'
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
worker, reviewer) are two-way and need a dated decision for any change. The
per-profile byte baseline (#164: the host exposure ladder and the four role
presets) is two-way too; growth additionally needs a decision naming an ADR.
Every advertised tool description must stay within ${TOOL_DESCRIPTION_BUDGET}
characters. The classification table in
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
 * are the very allow-lists their presets install (`worker.js` / `reviewer.js`,
 * both sourced from `domain/exposure.js`), intersected with the tools this
 * build registers — so a rename cannot leave the budget measuring a stale list.
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
  return {
    tower: measure(towerAllow),
    worker: measure(PRESET_ALLOWS['tower-worker']),
    reviewer: measure(PRESET_ALLOWS['tower-reviewer']),
  }
}

/**
 * The live tool surface: apply the shipped Host entry once so every
 * registration path is included, then release the mock context's timers. The
 * returned names/definitions stay usable after dispose (they are plain data).
 * @returns {{ names: string[], definitions: Map<string, any>, defaultDefinitions: Map<string, any> }}
 */
function liveToolSurface() {
  const surface = loadShippedToolSurface()
  try {
    return {
      names: surface.names,
      definitions: surface.definitions,
      defaultDefinitions: surface.defaultDefinitions,
    }
  } finally {
    surface.dispose()
  }
}

/**
 * The live surface used by the gate. Exported so tests can compare the counts
 * with the generated references without spawning the CLI.
 * @param {string} [root] repository root (defaults to this package)
 * @param {{ names: string[], definitions: Map<string, any>, defaultDefinitions: Map<string, any> }} [surface]
 *   already-measured surface, so the CLI loads the shipped entry once
 */
export function liveSurface(root = PACKAGE_ROOT, surface = liveToolSurface()) {
  const config = configSurface()
  const tools = surface.names
  const profiles = profileCounts(surface.defaultDefinitions)
  // #163: the 300-char advertised-description budget is checked for every
  // shipped tool, including the optional capability rows.
  const descriptions = [...surface.definitions.values()].map((definition) => ({
    name: definition.name,
    length: String(definition.description ?? '').length,
  }))
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
  // #163/#164: measure the shipped entry once and reuse the same surface for
  // the name counts, the description budget and the per-profile byte ladder.
  const surface = liveToolSurface()
  const current = liveSurface(root, surface)
  const result = checkSurfaceBudget({ root, current })
  // #164: the per-profile byte baseline over the same shipped surface. Any
  // drift is a finding, so the ladder's savings and any later regrowth are
  // both gated here.
  let profileEntry = null
  try {
    profileEntry = JSON.parse(fs.readFileSync(path.join(root, SURFACE_BASELINE_FILE), 'utf8')).profileBytes
  } catch (error) {
    profileEntry = { error: String(error?.message ?? error) }
  }
  const profileCurrent = collectProfileSurface(surface)
  const profileFindings = validateProfileBytes(profileEntry, profileCurrent, {
    exists: (relative) => fs.existsSync(path.join(root, relative)),
  })
  const profileOk = profileFindings.length === 0
  if (options.json) {
    console.log(JSON.stringify({ root, current, ...result, profileBytes: { current: profileCurrent, findings: profileFindings } }, null, 2))
    return result.ok && profileOk ? 0 : 1
  }
  console.log(`surface: ${surfaceLine(current)}`)
  console.log(`surface: components: ${current.components} visible (${current.liveNames.components.join(', ')})`)
  const nameProfileLine = SURFACE_PROFILES.map(
    (profile) => `${profile} ${current.profiles[profile].tools} tools / ${current.profiles[profile].inputBytes} B input schema`,
  ).join(' · ')
  console.log(`surface: profiles: ${nameProfileLine}`)
  const byteProfileLine = Object.entries(profileCurrent)
    .map(([profile, value]) => `${profile} ${value.bytes} B/${value.tools}`)
    .join(' · ')
  console.log(`surface: profile bytes: ${byteProfileLine}`)
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
  for (const finding of profileFindings) console.log(`surface: ${finding.level} [${finding.code}] ${finding.message}`)
  if (result.ok && profileOk) console.log('surface: ok — counts match the committed baseline and every entry is classified')
  else console.log(`surface: ${result.findings.length + profileFindings.length} problem(s); growth needs an ADR or a matching deletion`)
  return result.ok && profileOk ? 0 : 1
}

await runMain(import.meta.url, () => main(process.argv.slice(2)), { errorPrefix: 'surface', usage: USAGE })
