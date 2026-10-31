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
//      scripts/surface-baseline.json (the same brake `surface:check` applies);
//   4. #137: user-facing label copy that leaks a config key, an internal tool id,
//      a slash command or a module specifier, leaves a term untranslated in
//      Chinese, drifts from the recorded glossary, or diverges between zh and en
//      in the root locale, the generated row locales and the ui-bundle locale.
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Config, configSurface } from '../domain/config/schema.js'
import {
  COMPONENT_PATCH_FILES,
  COMPONENT_REFERENCE_FILE,
  COMPONENT_SURFACE_FILE,
  LOCALE_FIELDS,
  LOCALE_FILES,
  META_LABEL_PATCHES,
  META_LOCALE_FILES,
  checkForbidden,
  checkGroupLabelCoverage,
  checkKeyClassifications,
  checkLocaleCoverage,
  checkMetaLabelCoverage,
  checkRowOverrides,
  mergeCordisPatches,
  parseComponentSurface,
  parseCordisPatch,
  renderComponentSurface,
  validateComponentSurface,
} from '../domain/components.js'
import { validateSurfaceBaselineKey } from '../domain/surface.js'
import { readBaseline } from './lib/surface.mjs'
import { parseArgs, runMain } from './lib/cli.mjs'
import { OFF_EFFECT_LABEL, ROW_LOCALES, rowLocalePaths } from './generate-capability-locale.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY_FILE = 'host/tool-registry.js'
const ROOT_PATCH = COMPONENT_PATCH_FILES[0]
const USAGE = `usage: node scripts/check-components.mjs [--root <dir>] [--json]

  --root   repository root to check (default: this package)
  --json   print the report as JSON
  --help   print this text

Reads every shipped cordis.patch.yml (${COMPONENT_PATCH_FILES.join(', ')}).
Fails on a visible component without title/summary/disables in both locale files,
a generated row label (capability or preset) whose component entry is missing,
a visible row with no label source at all, a group row whose plugin-page
description omits its off consequence, a forbidden-to-disable capability disabled
by a group, row or boolean key, a component count that moved without a
scripts/surface-baseline.json decision, an unclassified config key or component
row, a stale generated reference, and (#137) any label copy that names a config
key or internal tool id, leaves a glossary term untranslated, or diverges between
zh and en.
Regenerate the table with \`npm run docs:generate:components\` and the row labels
with \`npm run docs:generate:locale\`.`

function finding(code, level, message) {
  return { code, level, message }
}

/** The recorded bilingual vocabulary lives at the repository root. */
export const GLOSSARY_FILE = 'GLOSSARY.md'

/**
 * #137: the canonical bilingual vocabulary for every user-facing label. The
 * glossary is the contract between the English and the Chinese copy: an English
 * concept that appears in a label must use the recorded Chinese term, and the
 * Chinese side may not leave the English word untranslated.
 *
 * `worker` and `reviewer` match lowercase prose only on purpose: "Tower Worker"
 * and "Tower Reviewer" are product names, not the generic role.
 */
export const COMPONENT_GLOSSARY = Object.freeze([
  { en: 'mission', zh: '任务线', pattern: /\b[Mm]issions?\b/ },
  { en: 'batch', zh: '批次', pattern: /\b[Bb]atch(?:es)?\b/ },
  { en: 'doctor', zh: '体检', pattern: /\b[Dd]octor\b/ },
  { en: 'board', zh: '看板', pattern: /\b[Bb]oard\b/ },
  { en: 'archive', zh: '归档', pattern: /\b[Aa]rchives?\b/ },
  { en: 'preset', zh: '预设', pattern: /\b[Pp]resets?\b/ },
  { en: 'worktree', zh: '工作树', pattern: /\b[Ww]orktrees?\b/ },
  { en: 'review', zh: '审查', pattern: /\b[Rr]eviews?\b/ },
  { en: 'lease', zh: '租约', pattern: /\b[Ll]eases?\b/ },
  { en: 'worker', zh: '执行代理', pattern: /\bworkers?\b/ },
  { en: 'reviewer', zh: '审查代理', pattern: /\breviewers?\b/ },
])

// A section plus a dot is config-key syntax (`gates.requireTests:true`), not
// prose. The same rule catches every section a user can edit, in either
// language, so a new key family cannot sneak back into a label.
export const CONFIG_KEY_SYNTAX =
  /\b(?:gates|review|spawn|tests|docs|mode|merge|git|worktrees|archive|leases|dev)\.[A-Za-z][A-Za-z0-9_.]*/
// Bare internal identifiers: tool ids, slash commands and package specifiers.
export const TOOL_ID_SYNTAX = /\btower_[a-z]/
export const COMMAND_SYNTAX = /\/tower\s/
export const MODULE_SPECIFIER_SYNTAX = /\bdsh-tower\/[a-z]/
// Words that must be translated in the Chinese copy. Lowercase only, so
// product names ("Tower Worker"), file names (MISSIONS.md) and brand names
// (Tower, DSH) are not mistakes.
export const ZH_UNTRANSLATED = Object.freeze([
  'mission',
  'batch',
  'doctor',
  'board',
  'archive',
  'preset',
  'worktree',
  'review',
  'lease',
  'host',
  'state',
  'worker',
  'reviewer',
])
const ZH_UNTRANSLATED_SYNTAX = ZH_UNTRANSLATED.map((term) => ({
  term,
  pattern: new RegExp(`\\b${term}\\b`),
}))

/**
 * Flatten the user-facing fields of one locale file into `{ path, text }`
 * entries: `meta.title`, `meta.description` and every
 * `components.<id>.title/summary/disables`. A missing field is kept as an empty
 * string so parity and emptiness are reported once, with its path.
 *
 * @param {string} file repository-relative path
 * @param {any} payload parsed locale JSON (or null when the file is missing)
 * @returns {Array<{ file: string, path: string, text: string }>}
 */
export function labelCopyFields(file, payload) {
  const fields = []
  const push = (key, value) => {
    fields.push({ file, path: key, text: typeof value === 'string' ? value : '' })
  }
  if (payload && typeof payload === 'object') {
    push('meta.title', payload.meta?.title)
    push('meta.description', payload.meta?.description)
    for (const [id, entry] of Object.entries(payload.components ?? {})) {
      for (const field of LOCALE_FIELDS) push(`components.${id}.${field}`, entry?.[field])
    }
  }
  return fields
}

function checkBannedCopy(field, lang, record) {
  const label = `${field.file} ${field.path}`
  const configKey = field.text.match(CONFIG_KEY_SYNTAX)
  if (configKey) {
    record(
      'locale-copy-config-key',
      `${label} names a config key ("${configKey[0]}"); describe the capability and its off consequence in plain language instead`,
    )
  }
  const toolId = field.text.match(TOOL_ID_SYNTAX)
  if (toolId) {
    record(
      'locale-copy-tool-id',
      `${label} names the internal tool id "${toolId[0]}"; describe what the user can do instead`,
    )
  }
  const command = field.text.match(COMMAND_SYNTAX)
  if (command) {
    record(
      'locale-copy-command',
      `${label} names the slash command "${command[0].trim()}"; describe the capability instead`,
    )
  }
  const specifier = field.text.match(MODULE_SPECIFIER_SYNTAX)
  if (specifier) {
    record(
      'locale-copy-module',
      `${label} names the module specifier "${specifier[0]}"; describe the capability instead`,
    )
  }
  if (lang !== 'zh') return
  for (const { term, pattern } of ZH_UNTRANSLATED_SYNTAX) {
    if (pattern.test(field.text)) {
      record(
        'locale-copy-untranslated',
        `${label} leaves "${term}" untranslated; use the glossary term from ${GLOSSARY_FILE}`,
      )
    }
  }
}

/**
 * The Chinese side of the glossary check. Chinese has no word boundaries, so a
 * shorter term (审查) can be a substring of a longer one (审查代理). The longest
 * recorded term wins: it is removed before shorter terms are matched, which
 * keeps the two roles distinct instead of reporting a false mismatch.
 */
function checkZhGlossary(field, enText, enFile, record) {
  const ordered = [...COMPONENT_GLOSSARY].sort((a, b) => b.zh.length - a.zh.length)
  let remaining = field.text
  for (const term of ordered) {
    if (!remaining.includes(term.zh)) continue
    remaining = remaining.split(term.zh).join(' ')
    if (!term.pattern.test(enText)) {
      record(
        'locale-glossary',
        `${enFile} ${field.path} must name the English ${term.en} for the Chinese "${term.zh}"`,
      )
    }
  }
}

/**
 * #137: check one en/zh pair of locale files. Every user-facing field must be
 * non-empty, free of config-key and internal-identifier syntax, and consistent
 * with the recorded glossary in both directions. Both files must carry the same
 * field paths.
 *
 * @param {Array<{ en: { file: string, payload: any }, zh: { file: string, payload: any } }>} pairs
 */
export function checkLocaleCopy(pairs) {
  const findings = []
  const record = (code, message) => findings.push(finding(code, 'error', message))
  for (const pair of pairs ?? []) {
    if (!pair?.en?.payload || !pair?.zh?.payload) {
      record(
        'locale-copy-missing',
        `locale copy pair is incomplete: ${pair?.en?.file ?? '<en>'} and ${pair?.zh?.file ?? '<zh>'} must both exist`,
      )
      continue
    }
    const en = labelCopyFields(pair.en.file, pair.en.payload)
    const zh = labelCopyFields(pair.zh.file, pair.zh.payload)
    const enPaths = new Set(en.map((field) => field.path))
    const zhPaths = new Set(zh.map((field) => field.path))
    for (const path of enPaths) {
      if (!zhPaths.has(path)) {
        record('locale-copy-parity', `${pair.en.file} labels ${path} but ${pair.zh.file} does not`)
      }
    }
    for (const path of zhPaths) {
      if (!enPaths.has(path)) {
        record('locale-copy-parity', `${pair.zh.file} labels ${path} but ${pair.en.file} does not`)
      }
    }
    const enByPath = new Map(en.map((field) => [field.path, field.text]))
    const zhByPath = new Map(zh.map((field) => [field.path, field.text]))
    for (const side of [
      { lang: 'en', fields: en, other: zhByPath },
      { lang: 'zh', fields: zh, other: enByPath },
    ]) {
      for (const field of side.fields) {
        if (!field.text.trim()) {
          record('locale-copy-empty', `${field.file} ${field.path} is empty`)
          continue
        }
        checkBannedCopy(field, side.lang, record)
        const otherText = side.other.get(field.path)
        if (otherText === undefined) continue
        if (side.lang === 'en') {
          for (const term of COMPONENT_GLOSSARY) {
            if (term.pattern.test(field.text) && !otherText.includes(term.zh)) {
              record(
                'locale-glossary',
                `${pair.zh.file} ${field.path} must name "${term.zh}" for the English ${term.en} in ${pair.en.file}`,
              )
            }
          }
        } else {
          checkZhGlossary(field, otherText, pair.en.file, record)
        }
      }
    }
  }
  return findings
}

/**
 * #137: the ui-bundle row labels its own package with a hand-written `meta`
 * block, but its single source is still `components['tower-ui']` in the root
 * locale. Pin the meta text to exactly what the row-locale generator would
 * render, so the hand-written copy cannot drift from the source of truth.
 *
 * @param {string[]} metaRowIds visible rows that ship their own meta label
 * @param {Record<string, any>} locales root locale file -> payload
 * @param {Record<string, any>} metaLocales package meta locale file -> payload
 * @param {Record<string, string>} markers off-effect label per language
 */
export function checkMetaRowCopy(metaRowIds, locales, metaLocales, markers) {
  const findings = []
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const rootLocaleFor = (lang) => LOCALE_FILES.find((file) => file.endsWith(`/${lang}.json`))
  for (const file of META_LOCALE_FILES) {
    const lang = path.basename(file, '.json') === 'zh' ? 'zh' : 'en'
    const meta = metaLocales?.[file]?.meta
    if (!meta || typeof meta.title !== 'string' || typeof meta.description !== 'string') continue
    const rootFile = rootLocaleFor(lang)
    const space = lang === 'zh' ? '' : ' '
    for (const id of metaRowIds ?? []) {
      const entry = locales?.[rootFile]?.components?.[id]
      if (!entry) {
        findings.push(
          finding(
            'meta-row-source',
            'error',
            `${file} labels ${id}, but ${rootFile} has no components.${id} entry to source it from`,
          ),
        )
        continue
      }
      if (
        typeof entry.title !== 'string' ||
        typeof entry.summary !== 'string' ||
        typeof entry.disables !== 'string'
      ) {
        continue // already reported by the locale coverage rule
      }
      if (normalize(meta.title) !== normalize(entry.title)) {
        findings.push(
          finding('meta-row-copy', 'error', `${file} meta.title must equal components.${id}.title in ${rootFile}`),
        )
      }
      const expected = normalize(`${entry.summary}${space}${markers[lang]}${space}${entry.disables}`)
      if (normalize(meta.description) !== expected) {
        findings.push(
          finding(
            'meta-row-copy',
            'error',
            `${file} meta.description must be components.${id} summary + off-effect label + disables, exactly as the row-locale generator renders it`,
          ),
        )
      }
    }
  }
  return findings
}

/**
 * #137: the glossary is a gate input, so the document that records it must
 * exist and still name every canonical term pair. Copy and policy cannot drift
 * apart silently.
 *
 * @param {string} root
 */
export function checkGlossaryFile(root) {
  const file = path.join(root, GLOSSARY_FILE)
  if (!fs.existsSync(file)) {
    return [
      finding(
        'glossary-missing',
        'error',
        `${GLOSSARY_FILE} is missing; the bilingual label vocabulary has to be recorded in one place`,
      ),
    ]
  }
  const text = fs.readFileSync(file, 'utf8')
  const findings = []
  for (const term of COMPONENT_GLOSSARY) {
    if (!text.includes(term.en) || !text.includes(term.zh)) {
      findings.push(
        finding(
          'glossary-term',
          'error',
          `${GLOSSARY_FILE} does not record both "${term.en}" and "${term.zh}"`,
        ),
      )
    }
  }
  return findings
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

/** The live config keys and their schema type, derived from schemastery. */
export function liveKeyTypes() {
  /** @type {Record<string, string>} */
  const types = {}
  for (const [key, schema] of Object.entries(Config.dict ?? {})) {
    const dict = schema?.dict
    if (dict && typeof dict === 'object') {
      for (const [child, childSchema] of Object.entries(dict)) {
        types[`${key}.${child}`] = childSchema?.type ?? 'unknown'
      }
    } else {
      types[key] = schema?.type ?? 'unknown'
    }
  }
  return types
}

/** The live boolean config keys, derived from the schemastery schema. */
function liveBooleanKeys() {
  return Object.entries(liveKeyTypes())
    .filter(([, type]) => type === 'boolean')
    .map(([key]) => key)
}

/**
 * #138.2: import the OPERATIONAL_TOOLS table from host/tool-registry.js. The old
 * regex scraper treated "found nothing" and "could not read the file" as the same
 * empty route table. An empty Map is a legitimate determined state; a missing
 * file, an import error or a missing/non-Map export is a gate failure.
 *
 * The import is dynamic and rooted at the checked directory, so the gate reads
 * the module the package actually ships. The table is checked for shape before
 * it reaches the denylist.
 *
 * @returns {Promise<{ routes?: Record<string, string>, error?: string }>}
 */
async function operationalRegistry(root) {
  const file = path.join(root, REGISTRY_FILE)
  if (!fs.existsSync(file)) {
    return { error: `${REGISTRY_FILE} is missing; the operational-tool route table cannot be determined` }
  }
  let module
  try {
    module = await import(pathToFileURL(file).href)
  } catch (error) {
    return { error: `${REGISTRY_FILE} cannot be imported: ${String(error?.message ?? error)}` }
  }
  const table = module.OPERATIONAL_TOOLS
  if (!(table instanceof Map)) {
    return { error: `${REGISTRY_FILE} must export OPERATIONAL_TOOLS as a Map; the route table cannot be determined` }
  }
  /** @type {Record<string, string>} */
  const routes = {}
  for (const [tool, flag] of table) {
    if (typeof tool !== 'string' || !tool || typeof flag !== 'string' || !flag) {
      return { error: `${REGISTRY_FILE} OPERATIONAL_TOOLS contains a route whose tool or switch is not a non-empty string` }
    }
    routes[tool] = flag
  }
  return { routes }
}

/** Read the live inputs the pure checks need: schema, patches, locales, registry. */
export async function componentCheckData(root) {
  const config = configSurface()
  const keyTypes = liveKeyTypes()
  const registry = await operationalRegistry(root)
  // #134: the policy gate reads every shipped patch, not only the root one. A row
  // added to `ui-bundle/cordis.patch.yml` without a classification must fail here.
  const patches = {}
  for (const file of COMPONENT_PATCH_FILES) {
    const patchFile = path.join(root, file)
    patches[file] = fs.existsSync(patchFile)
      ? parseCordisPatch(fs.readFileSync(patchFile, 'utf8'))
      : { rows: [], visible: [] }
  }
  const patch = mergeCordisPatches(patches)
  const locales = {}
  for (const file of LOCALE_FILES) {
    const localeFile = path.join(root, file)
    locales[file] = fs.existsSync(localeFile) ? JSON.parse(fs.readFileSync(localeFile, 'utf8')) : null
  }
  // A package that ships its own patch labels its rows with its own meta block.
  const metaLocales = {}
  for (const file of META_LOCALE_FILES) {
    const localeFile = path.join(root, file)
    metaLocales[file] = fs.existsSync(localeFile) ? JSON.parse(fs.readFileSync(localeFile, 'utf8')) : null
  }
  // #137: the generated row labels are user-facing copy too, so the copy gate
  // reads them alongside the hand-written root and ui-bundle locales.
  const rowLocales = {}
  for (const file of rowLocalePaths()) {
    const localeFile = path.join(root, file)
    rowLocales[file] = fs.existsSync(localeFile) ? JSON.parse(fs.readFileSync(localeFile, 'utf8')) : null
  }
  return {
    configKeys: config.keys,
    sections: config.sections,
    keyTypes,
    booleans: liveBooleanKeys(),
    registry: registry.routes ?? {},
    registryError: registry.error ?? null,
    patches,
    patch,
    locales,
    metaLocales,
    rowLocales,
  }
}

/**
 * #138.3: a shipped `cordis.patch.yml` that the policy does not read is an
 * unreviewed component surface. Discover every patch in the package and compare
 * it with COMPONENT_PATCH_FILES in both directions, so a new patch fails until
 * its rows are classified and a listed-but-missing patch fails rather than
 * silently contributing zero rows.
 *
 * @param {string} root
 * @returns {string[]} repository-relative paths, POSIX separators
 */
export function discoverShippedPatches(root) {
  const found = []
  const skip = new Set(['.git', 'node_modules', 'coverage', '.dsh-tower-worktrees'])
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'cordis.patch.yml') found.push(path.relative(root, full).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return found.sort()
}

/**
 * @param {string[]} discovered repository-relative patch paths
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function checkShippedPatchCoverage(discovered) {
  const findings = []
  for (const file of discovered) {
    if (!COMPONENT_PATCH_FILES.includes(file)) {
      findings.push(
        finding(
          'patch-unclassified',
          'error',
          `${file} is a shipped cordis.patch.yml but is not in COMPONENT_PATCH_FILES; add it to the policy before its rows can ship`,
        ),
      )
    }
  }
  for (const file of COMPONENT_PATCH_FILES) {
    if (!discovered.includes(file)) {
      findings.push(finding('patch-missing', 'error', `${file} is listed in COMPONENT_PATCH_FILES but does not exist`))
    }
  }
  return findings
}

/**
 * #134: every visible row needs a label source. Rows in the root patch use the
 * generated `<specifier>/locale/*.json` files (capability rows) or the package
 * root `meta` (the group); rows that ship in their own package use that package's
 * `meta.title` / `meta.description`. A visible row with neither source shows only
 * its module specifier on the Plugins page, so it is a gate failure.
 *
 * @param {{ rows: Array<{ id: string, scope: string, kind: string, patch: string }> }} patch merged patch
 * @param {Array<{ component: string }>} rowLocales the generator declaration
 */
export function checkRowLabelSources(patch, rowLocales) {
  const findings = []
  const generated = new Set((rowLocales ?? []).map((row) => row.component))
  for (const row of patch?.rows ?? []) {
    if (row.scope !== 'visible' || row.kind === 'group') continue
    if (generated.has(row.id)) continue
    if (META_LABEL_PATCHES.includes(row.patch)) continue
    findings.push(
      finding(
        'row-locale-missing',
        'error',
        `visible component "${row.id}" (${row.patch}) ships neither a generated <specifier>/locale label nor a package meta label`,
      ),
    )
  }
  return findings
}

/**
 * Run every component-surface rule against one repository root.
 * @param {string} root
 * @returns {Promise<{ ok: boolean, surface: any, live: any, findings: Array<{ code: string, level: string, message: string }> }>}
 */
export async function checkComponents(root) {
  const findings = []
  const live = await componentCheckData(root)
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
  // #138.3: every shipped patch is discovered, and every listed patch exists. A
  // new package patch therefore fails until it joins COMPONENT_PATCH_FILES.
  findings.push(...checkShippedPatchCoverage(discoverShippedPatches(root)))
  // #138.1: a boolean (or recorded behaviour knob) cannot hide its capability on
  // the `optional-config` axis without a dated tuning-only exemption.
  findings.push(...checkKeyClassifications(surface, live))
  // #138.4: a row may only override the config keys its component owns.
  findings.push(...checkRowOverrides(surface, live))
  // #134: the root locale `components` block labels the rows that ship in the root
  // patch. A row that ships in its own package (`tower-ui`) is labelled by that
  // package's `meta` block and is checked below instead.
  const rootVisible = live.patches?.[ROOT_PATCH]?.visible ?? []
  findings.push(...checkLocaleCoverage(surface, live.locales, { ids: rootVisible }))
  // #121: a row that ships a generated `<specifier>/locale/*.json` label needs
  // the same three strings in both locales, including an internal row (the
  // mandatory worker preset) that the visible-only rule above does not cover.
  findings.push(...checkRowLocaleCoverage(surface, live.locales, ROW_LOCALES))
  // #134: every visible row must have a label source; one without is a page that
  // shows only `dsh-tower/board`.
  findings.push(...checkRowLabelSources(live.patch, ROW_LOCALES))
  // #132: the group row's plugin-page description must state its off consequence.
  findings.push(...checkGroupLabelCoverage(surface, live.locales))
  // #134: rows shipping in their own package are labelled by that package's meta.
  const metaRowIds = (live.patch?.rows ?? [])
    .filter((row) => META_LABEL_PATCHES.includes(row.patch) && row.scope === 'visible')
    .map((row) => row.id)
  findings.push(...checkMetaLabelCoverage(metaRowIds, live.metaLocales, OFF_EFFECT_LABEL))
  // #137: the package meta label is hand-written but sourced from the root
  // locale; pin it to the same composition the generator renders.
  findings.push(...checkMetaRowCopy(metaRowIds, live.locales, live.metaLocales, OFF_EFFECT_LABEL))
  // #137: every user-facing label is copy, not a config dump. Check both
  // languages of the root locale, the ui-bundle meta and every generated row
  // locale: plain language, zh/en parity, recorded glossary terms only.
  const labelPairs = [
    {
      en: { file: LOCALE_FILES[0], payload: live.locales[LOCALE_FILES[0]] },
      zh: { file: LOCALE_FILES[1], payload: live.locales[LOCALE_FILES[1]] },
    },
    {
      en: { file: META_LOCALE_FILES[0], payload: live.metaLocales[META_LOCALE_FILES[0]] },
      zh: { file: META_LOCALE_FILES[1], payload: live.metaLocales[META_LOCALE_FILES[1]] },
    },
    ...ROW_LOCALES.map((row) => ({
      en: { file: `locale/${row.specifier}/en.json`, payload: live.rowLocales?.[`locale/${row.specifier}/en.json`] },
      zh: { file: `locale/${row.specifier}/zh.json`, payload: live.rowLocales?.[`locale/${row.specifier}/zh.json`] },
    })),
  ]
  findings.push(...checkLocaleCopy(labelPairs))
  findings.push(...checkGlossaryFile(root))
  // #138.2: the route table is imported, so an absent file, a failed import or a
  // missing/non-Map export fails closed. An empty Map remains the correct
  // determined state (#122): "nothing is gated" is distinct from "could not read".
  if (live.registryError) {
    findings.push(finding('registry-unreadable', 'error', live.registryError))
  }
  findings.push(...checkForbidden(surface, { booleans: live.booleans, registry: live.registry, patch: live.patch }))

  // The decision record must exist: the ADR is where the policy is argued.
  if (!fs.existsSync(path.join(root, surface.adr))) {
    findings.push(finding('adr-missing', 'error', `component surface names ${surface.adr}, which does not exist`))
  }
  for (const key of surface.keys) {
    if (!key.exemption) continue
    if (!fs.existsSync(path.join(root, key.exemption.ref))) {
      findings.push(
        finding(
          'key-exemption-decision',
          'error',
          `${key.name} keeps optional-config by an exemption recorded in ${key.exemption.ref}, which does not exist`,
        ),
      )
    }
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

async function main(argv) {
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
  const report = await checkComponents(root)
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
