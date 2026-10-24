#!/usr/bin/env node
// Component-surface policy gate (#120).
//
// Principle 11 says optional capabilities are switches and the core is not. This
// gate is what makes that a rule instead of a slogan. It fails on:
//
//   1. a visible component without `title`, `summary` and `disables` in both
//      locale/en.json and locale/zh.json — and the same three strings for every
//      component that ships a generated row label, including the internal
//      worker preset (#121);
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
  LOCALE_FIELDS,
  LOCALE_FILES,
  checkForbidden,
  checkLocaleCoverage,
  parseComponentSurface,
  parseCordisPatch,
  parseOperationalRegistry,
  renderComponentSurface,
  validateComponentSurface,
} from '../domain/components.js'
import { validateSurfaceBaselineKey } from '../domain/surface.js'
import { readBaseline } from './lib/surface.mjs'
import { parseArgs, runMain } from './lib/cli.mjs'
import { ROW_LOCALES } from './generate-capability-locale.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY_FILE = 'host/tool-registry.js'
const PATCH_FILE = 'cordis.patch.yml'
const USAGE = `usage: node scripts/check-components.mjs [--root <dir>] [--json]

  --root   repository root to check (default: this package)
  --json   print the report as JSON
  --help   print this text

Fails on a visible component without title/summary/disables in both locale files,
a generated row label (capability or preset) whose component entry is missing,
a forbidden-to-disable capability disabled by a group, row or boolean key, a
component count that moved without a scripts/surface-baseline.json decision,
an unclassified config key or component row, and a stale generated reference.
Regenerate the table with \`npm run docs:generate:components\`.`

function finding(code, level, message) {
  return { code, level, message }
}

/**
 * The generated row-label map is a coverage axis of its own (#121). A component
 * that ships a `<specifier>/locale/<lang>.json` label must carry `title`,
 * `summary` and `disables` in every shipped locale — including an internal
 * component such as the mandatory worker preset, which the visible-only rule in
 * `domain/components.js` deliberately does not cover.
 *
 * `rows` is the generator's declaration (`{ specifier, component, mandatory? }`).
 * When a row records `mandatory`, it must agree with the component-surface
 * scope: an internal component is a dependency, never a switch. That is how the
 * worker's "mandatory dependency" description and the component policy stay one
 * decision.
 *
 * @param {any} surface the parsed `scripts/component-surface.json`
 * @param {Record<string, any>} locales file path -> parsed locale JSON
 * @param {Array<{ specifier: string, component: string, mandatory?: boolean }>} rows
 */
export function checkRowLocaleCoverage(surface, locales, rows) {
  const findings = []
  const record = (code, message) => findings.push(finding(code, 'error', message))
  const components = new Map(surface.components.map((component) => [component.id, component]))
  for (const row of rows ?? []) {
    const component = components.get(row?.component)
    if (!component) {
      record(
        'row-locale-unknown',
        `row locale "${row?.specifier}" names component "${row?.component}", which the component surface does not declare`,
      )
      continue
    }
    if (typeof row.mandatory === 'boolean' && row.mandatory !== (component.scope === 'internal')) {
      record(
        'row-locale-scope',
        `row locale "${row.specifier}" labels ${component.id} ${row.mandatory ? 'mandatory' : 'optional'}, but the component surface scope is ${component.scope}`,
      )
    }
    for (const file of LOCALE_FILES) {
      const entry = locales?.[file]?.components?.[component.id]
      if (!entry || typeof entry !== 'object') {
        record('row-locale', `row locale ${component.id} has no entry in ${file}`)
        continue
      }
      for (const field of LOCALE_FIELDS) {
        const value = typeof entry[field] === 'string' ? entry[field].trim() : ''
        if (!value) record('row-locale', `row locale ${component.id} misses "${field}" in ${file}`)
      }
    }
  }
  return findings
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
 * keeps the denylist check offline and free of a booted Host. The parser accepts
 * both the tuple and the `Map.set(...)` forms, and a trailing comma (F11), so a
 * reformatted table cannot fall out of the allowlist.
 */
function operationalRegistry(root) {
  const file = path.join(root, REGISTRY_FILE)
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  return parseOperationalRegistry(text)
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
  // #121: a row that ships a generated `<specifier>/locale/*.json` label needs
  // the same three strings in both locales, including an internal row (the
  // mandatory worker preset) that the visible-only rule above does not cover.
  findings.push(...checkRowLocaleCoverage(surface, live.locales, ROW_LOCALES))
  findings.push(...checkForbidden(surface, { booleans: live.booleans, registry: live.registry, patch: live.patch }))

  // #122: an empty OPERATIONAL_TOOLS table is the expected state. Every route
  // that does exist must still match the `gateableTools` allowlist, which
  // checkForbidden enforces above; there is no "unreadable registry" failure to
  // raise when the correct count is zero.

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
