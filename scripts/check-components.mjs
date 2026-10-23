#!/usr/bin/env node
// Component-surface policy gate (#120).
//
// Principle 11 says optional capabilities are switches and the core is not. This
// gate is what makes that a rule instead of a slogan. It fails on:
//
//   1. a visible component without `title`, `summary` and `disables` in both
//      locale/en.json and locale/zh.json;
//   2. a forbidden-to-disable capability (host, health, recovery, review
//      contract, merge gates) that any group, row or boolean key can disable;
//   3. a component count that moved without a decision in
//      scripts/surface-baseline.json (the same brake `surface:check` applies).
//
// It also refuses the quiet forms of the same drift: a shipped component row
// missing from the single source of truth, a live config key without a
// component-axis class, and a generated reference that is out of date.
//
// The single source of truth is `scripts/component-surface.json`; the generated
// table is `docs/reference/component-surface.md`; the policy is recorded in
// `docs/adr/0005-component-surface.md`.
//
// Usage:
//   node scripts/check-components.mjs [--root <dir>] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, configSurface } from '../domain/config/schema.js'
import {
  COMPONENT_REFERENCE_FILE,
  COMPONENT_SURFACE_FILE,
  LOCALE_FILES,
  checkForbidden,
  checkLocaleCoverage,
  parseComponentSurface,
  parseCordisPatch,
  renderComponentSurface,
  validateComponentSurface,
} from '../domain/components.js'
import { validateSurfaceBaselineKey } from '../domain/surface.js'
import { readBaseline } from './lib/surface.mjs'
import { parseArgs, runMain } from './lib/cli.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY_FILE = 'host/tool-registry.js'
const PATCH_FILE = 'cordis.patch.yml'
const USAGE = `usage: node scripts/check-components.mjs [--root <dir>] [--json]

  --root   repository root to check (default: this package)
  --json   print the report as JSON
  --help   print this text

Fails on a visible component without title/summary/disables in both locale files,
a forbidden-to-disable capability disabled by a group, row or boolean key, a
component count that moved without a scripts/surface-baseline.json decision,
an unclassified config key or component row, and a stale generated reference.
Regenerate the table with \`npm run docs:generate:components\`.`

function finding(code, level, message) {
  return { code, level, message }
}

/** The live boolean config keys, derived from the schemastery schema. */
function liveBooleanKeys() {
  const keys = []
  for (const [key, schema] of Object.entries(Config.dict ?? {})) {
    const dict = schema?.dict
    if (dict && typeof dict === 'object') {
      for (const [child, childSchema] of Object.entries(dict)) {
        if (childSchema?.type === 'boolean') keys.push(`${key}.${child}`)
      }
    } else if (schema?.type === 'boolean') {
      keys.push(key)
    }
  }
  return keys
}

/**
 * The static wiring that lets a boolean key remove a tool: the OPERATIONAL_TOOLS
 * table in host/tool-registry.js. Parsing it (rather than importing the runtime)
 * keeps the denylist check offline and free of a booted Host. Both quote styles
 * are accepted so a reformatted entry cannot fall out of the allowlist.
 */
function operationalRegistry(root) {
  const file = path.join(root, REGISTRY_FILE)
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const registry = {}
  for (const match of text.matchAll(/\[\s*['"](tower_[a-z_]+)['"]\s*,\s*['"](expose[A-Za-z]+)['"]\s*\]/g)) {
    registry[match[1]] = match[2]
  }
  return registry
}

/** Read the live inputs the pure checks need: schema, patch, locales, registry. */
export function componentCheckData(root) {
  const config = configSurface()
  const patchFile = path.join(root, PATCH_FILE)
  const patch = fs.existsSync(patchFile)
    ? parseCordisPatch(fs.readFileSync(patchFile, 'utf8'))
    : { rows: [], visible: [] }
  const locales = {}
  for (const file of LOCALE_FILES) {
    const localeFile = path.join(root, file)
    locales[file] = fs.existsSync(localeFile) ? JSON.parse(fs.readFileSync(localeFile, 'utf8')) : null
  }
  return {
    configKeys: config.keys,
    sections: config.sections,
    booleans: liveBooleanKeys(),
    registry: operationalRegistry(root),
    patch,
    locales,
  }
}

/**
 * Run every component-surface rule against one repository root.
 * @param {string} root
 * @returns {{ ok: boolean, surface: any, live: any, findings: Array<{ code: string, level: string, message: string }> }}
 */
export function checkComponents(root) {
  const findings = []
  const live = componentCheckData(root)
  const surfaceFile = path.join(root, COMPONENT_SURFACE_FILE)
  if (!fs.existsSync(surfaceFile)) {
    return {
      ok: false,
      surface: null,
      live,
      findings: [finding('surface-missing', 'error', `${COMPONENT_SURFACE_FILE} is missing`)],
    }
  }
  let surface
  try {
    surface = parseComponentSurface(fs.readFileSync(surfaceFile, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      surface: null,
      live,
      findings: [finding('surface-invalid', 'error', `${COMPONENT_SURFACE_FILE}: ${String(error?.message ?? error)}`)],
    }
  }
  findings.push(...validateComponentSurface(surface, { configKeys: live.configKeys, patch: live.patch }))
  findings.push(...checkLocaleCoverage(surface, live.locales))
  findings.push(...checkForbidden(surface, { booleans: live.booleans, registry: live.registry, patch: live.patch }))

  // The denylist derives its switches from the registry table; a mapping to a
  // key the schema does not declare is unenforceable, so it fails here.
  const booleanSet = new Set(live.booleans)
  for (const [tool, flag] of Object.entries(live.registry)) {
    if (!booleanSet.has(`tools.${flag}`)) {
      findings.push(
        finding(
          'registry-flag',
          'error',
          `${REGISTRY_FILE} maps ${tool} to tools.${flag}, which is not a live boolean config key`,
        ),
      )
    }
  }
  if (Object.keys(live.registry).length === 0) {
    findings.push(finding('registry-unreadable', 'error', `${REGISTRY_FILE} has no OPERATIONAL_TOOLS entries; the denylist cannot derive disablers`))
  }

  // The decision record must exist: the ADR is where the policy is argued.
  if (!fs.existsSync(path.join(root, surface.adr))) {
    findings.push(finding('adr-missing', 'error', `component surface names ${surface.adr}, which does not exist`))
  }
  for (const capability of surface.forbidden) {
    const decision = capability.acceptedSwitches?.decision
    if (!decision) continue
    if (!fs.existsSync(path.join(root, decision.ref))) {
      findings.push(
        finding(
          'forbidden-decision',
          'error',
          `forbidden capability ${capability.id} records a decision in ${decision.ref}, which does not exist`,
        ),
      )
    }
  }

  // Check 3: the component count is a baselined surface. `surface:check` runs
  // the full baseline; this narrow call keeps the component brake available in
  // this gate too, so a moved count fails here without re-measuring the rest.
  const visible = live.patch.visible
  let baseline = null
  try {
    baseline = readBaseline(root)
    findings.push(
      ...validateSurfaceBaselineKey(
        baseline,
        'components',
        { components: visible.length, liveNames: { components: visible } },
        { exists: (relative) => fs.existsSync(path.join(root, relative)) },
      ),
    )
  } catch (error) {
    findings.push(finding('baseline-unreadable', 'error', `scripts/surface-baseline.json is unreadable: ${String(error?.message ?? error)}`))
  }

  // The reference is a rendering, not prose. There is exactly one way to update
  // it: edit the source of truth and run the generator.
  try {
    const expected = renderComponentSurface(surface, { baselineDate: baseline?.date })
    const referenceFile = path.join(root, COMPONENT_REFERENCE_FILE)
    const actual = fs.existsSync(referenceFile) ? fs.readFileSync(referenceFile, 'utf8') : ''
    if (actual !== expected) {
      findings.push(
        finding('reference-stale', 'error', `${COMPONENT_REFERENCE_FILE} is stale; run npm run docs:generate:components`),
      )
    }
  } catch (error) {
    findings.push(finding('reference-unreadable', 'error', `${COMPONENT_REFERENCE_FILE} cannot be rendered: ${String(error?.message ?? error)}`))
  }

  return { ok: findings.every((entry) => entry.level !== 'error'), surface, live, findings }
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
  const report = checkComponents(root)
  if (options.json) {
    console.log(JSON.stringify({ root, ...report }, null, 2))
    return report.ok ? 0 : 1
  }
  if (report.surface) {
    const visible = report.surface.components.filter((component) => component.scope === 'visible').length
    const internal = report.surface.components.length - visible
    console.log(
      `components: ${visible} visible, ${internal} internal, ${report.surface.keys.length} config keys classified (${COMPONENT_SURFACE_FILE})`,
    )
  }
  for (const item of report.findings) console.log(`components: ${item.level} [${item.code}] ${item.message}`)
  if (report.ok) console.log('components: ok — locale coverage, the forbidden denylist and the component baseline hold')
  else console.log(`components: ${report.findings.length} problem(s); see docs/adr/0005-component-surface.md`)
  return report.ok ? 0 : 1
}

await runMain(import.meta.url, () => main(process.argv.slice(2)), { errorPrefix: 'components', usage: USAGE })
