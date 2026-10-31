// Component-surface policy (#120): who may be switched off, recorded as data.
//
// Principle 11 says optional capabilities are switches and the core is not. This
// module is that policy as data plus the pure checks over it: the component rows
// in `cordis.patch.yml`, the four-way classification of every config key, and
// the forbidden-to-disable capabilities (host, health, recovery, review contract,
// merge gates) that no group, row or boolean key may gate.
//
// The single source of truth is `scripts/component-surface.json`. The generated
// reference `docs/reference/component-surface.md` is a rendering of it, so
// "should this be a component?" is a table lookup rather than a judgement call.
//
// This module is pure: no fs, no git. `scripts/check-components.mjs` supplies the
// live schema, `cordis.patch.yml`, the locale files and the baseline.
//
// #138: the class/row-override rules live in `component-rules.js` so this module
// stays under the architecture aggregate-size brake; they are re-exported here.
import { collectConfigOverrides } from './component-rules.js'
export { checkKeyClassifications, checkRowOverrides } from './component-rules.js'

export const COMPONENT_SURFACE_FILE = 'scripts/component-surface.json'
export const COMPONENT_REFERENCE_FILE = 'docs/reference/component-surface.md'
export const COMPONENT_SCHEMA_VERSION = 1
export const COMPONENT_CLASSES = ['core', 'optional-component', 'optional-config', 'forbidden-to-disable']
export const COMPONENT_SCOPES = ['visible', 'internal']
export const COMPONENT_KINDS = ['group', 'row']
export const LOCALE_FILES = ['locale/en.json', 'locale/zh.json']
export const LOCALE_FIELDS = ['title', 'summary', 'disables']
// #134: every shipped Cordis patch has component rows, not only the root one.
// `ui-bundle/cordis.patch.yml` ships the `tower-ui` row. Labels for its rows live
// in that package's own locale files (a DSH row renders `meta.title` /
// `meta.description`, not the root `components` block).
export const COMPONENT_PATCH_FILES = ['cordis.patch.yml', 'ui-bundle/cordis.patch.yml']
export const META_LABEL_PATCHES = ['ui-bundle/cordis.patch.yml']
export const META_LOCALE_FILES = ['ui-bundle/locale/en.json', 'ui-bundle/locale/zh.json']

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function componentError(message) {
  return new Error(message)
}

function text(value, label) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) throw componentError(`${label} must be a non-empty string`)
  return trimmed
}

function stringList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw componentError(`${label} must be an array of strings`)
  return value.map((item) => text(item, `${label} entry`))
}

function normalizeComponent(entry, index) {
  if (!isPlainObject(entry)) throw componentError(`components[${index}] must be an object`)
  const scope = text(entry.scope, `components[${index}].scope`)
  if (!COMPONENT_SCOPES.includes(scope)) {
    throw componentError(`components[${index}].scope "${scope}" must be one of ${COMPONENT_SCOPES.join('/')}`)
  }
  const kind = text(entry.kind, `components[${index}].kind`)
  if (!COMPONENT_KINDS.includes(kind)) {
    throw componentError(`components[${index}].kind "${kind}" must be one of ${COMPONENT_KINDS.join('/')}`)
  }
  return {
    id: text(entry.id, `components[${index}].id`),
    scope,
    kind,
    fallback: text(entry.fallback, `components[${index}].fallback`),
    allowedOverrides: stringList(entry.allowedOverrides, `components[${index}].allowedOverrides`),
  }
}

function normalizeKey(entry, index) {
  if (!isPlainObject(entry)) throw componentError(`keys[${index}] must be an object`)
  const className = text(entry.class, `keys[${index}].class`)
  if (!COMPONENT_CLASSES.includes(className)) {
    throw componentError(`keys[${index}].class "${className}" must be one of ${COMPONENT_CLASSES.join('/')}`)
  }
  return {
    name: text(entry.name, `keys[${index}].name`),
    class: className,
    note: text(entry.note, `keys[${index}].note`),
    // #138: an `optional-config` boolean (or a recorded behaviour knob) needs a
    // dated reason for staying a tuning key; the gate refuses the classification
    // without it.
    exemption: entry.exemption === undefined ? null : normalizeDecision(entry.exemption, `keys[${index}].exemption`),
  }
}

function normalizeDecision(decision, label) {
  if (!isPlainObject(decision)) throw componentError(`${label} needs a decision object`)
  const date = text(decision.date, `${label}.date`)
  if (!ISO_DATE.test(date)) throw componentError(`${label}.date must be YYYY-MM-DD`)
  const ref = text(decision.ref, `${label}.ref`).replace(/\\/g, '/')
  return {
    date,
    ref,
    issue: decision.issue === undefined ? null : text(decision.issue, `${label}.issue`),
    reason: text(decision.reason, `${label}.reason`),
  }
}

function normalizeForbidden(entry, index) {
  if (!isPlainObject(entry)) throw componentError(`forbidden[${index}] must be an object`)
  let acceptedSwitches = null
  if (entry.acceptedSwitches !== undefined) {
    if (!isPlainObject(entry.acceptedSwitches)) {
      throw componentError(`forbidden[${index}].acceptedSwitches must be an object`)
    }
    acceptedSwitches = {
      keys: stringList(entry.acceptedSwitches.keys, `forbidden[${index}].acceptedSwitches.keys`),
      decision: normalizeDecision(entry.acceptedSwitches.decision, `forbidden[${index}].acceptedSwitches.decision`),
    }
  }
  return {
    id: text(entry.id, `forbidden[${index}].id`),
    capability: text(entry.capability, `forbidden[${index}].capability`),
    reason: text(entry.reason, `forbidden[${index}].reason`),
    tools: stringList(entry.tools, `forbidden[${index}].tools`),
    rowIds: stringList(entry.rowIds, `forbidden[${index}].rowIds`),
    gatedBy: stringList(entry.gatedBy, `forbidden[${index}].gatedBy`),
    acceptedSwitches,
  }
}

/**
 * The allowlist of boolean routes: which tool a `tools.expose*` key may skip.
 *
 * `host/tool-registry.js` is the only place a `tools.expose*` boolean removes a
 * tool, so the shipped routes are data here. A registry route that is not listed
 * is a forbidden switch, even when the affected capability lists no tools of its
 * own (the review contract and the merge gates register their tools through the
 * same `define()` path as everything else).
 */
function normalizeGateableTools(value) {
  if (value === undefined) return []
  if (!isPlainObject(value)) {
    throw componentError('component surface "gateableTools" must be an object mapping a tool to a tools.* config key')
  }
  return Object.entries(value).map(([tool, key]) => {
    const name = text(tool, 'gateableTools tool')
    const configKey = text(key, `gateableTools.${tool}`)
    if (!/^tools\.[A-Za-z][A-Za-z0-9]*$/.test(configKey)) {
      throw componentError(`gateableTools.${tool} must name a tools.* config key, got ${configKey}`)
    }
    return { tool: name, key: configKey }
  })
}

/**
 * Parse and validate the single source of truth. Structural problems throw with
 * an actionable message; semantic problems are findings from the validators
 * below, so one run can report all of them.
 * @param {string | object} source
 */
export function parseComponentSurface(source) {
  let value = source
  if (typeof source === 'string') {
    try {
      value = JSON.parse(source)
    } catch (error) {
      throw componentError(`component surface is not valid JSON: ${error?.message ?? error}`)
    }
  }
  if (!isPlainObject(value)) throw componentError('component surface must be a JSON object')
  if (value.schema !== undefined && value.schema !== COMPONENT_SCHEMA_VERSION) {
    throw componentError(`component surface schema ${value.schema} is not supported (expected ${COMPONENT_SCHEMA_VERSION})`)
  }
  const date = text(value.date, 'component surface date')
  if (!ISO_DATE.test(date)) throw componentError(`component surface date must be YYYY-MM-DD, got ${JSON.stringify(value.date)}`)
  const adr = text(value.adr, 'component surface adr').replace(/\\/g, '/')
  if (!adr.startsWith('docs/adr/') || !adr.endsWith('.md')) {
    throw componentError(`component surface adr must name a docs/adr/*.md record, got ${adr}`)
  }
  if (!isPlainObject(value.classes)) throw componentError('component surface needs a "classes" object')
  const classes = {}
  for (const name of COMPONENT_CLASSES) {
    classes[name] = text(value.classes[name], `component surface classes.${name}`)
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw componentError('component surface needs a non-empty "components" array')
  }
  const components = value.components.map(normalizeComponent)
  if (!Array.isArray(value.keys) || value.keys.length === 0) {
    throw componentError('component surface needs a non-empty "keys" array')
  }
  const keys = value.keys.map(normalizeKey)
  const forbidden = Array.isArray(value.forbidden) ? value.forbidden.map(normalizeForbidden) : []
  const gateableTools = normalizeGateableTools(value.gateableTools)
  // #138: non-boolean keys that gate behaviour cannot hide behind
  // `optional-config`; they are reviewed on the same axis as booleans.
  const behaviorKnobs = stringList(value.behaviorKnobs, 'component surface behaviorKnobs')
  const seen = (list, label) => {
    const names = new Set()
    for (const entry of list) {
      if (names.has(entry.id)) throw componentError(`${label} "${entry.id}" is declared twice`)
      names.add(entry.id)
    }
  }
  seen(components, 'component')
  seen(forbidden, 'forbidden capability')
  const keyNames = new Set()
  for (const key of keys) {
    if (keyNames.has(key.name)) throw componentError(`config key ${key.name} is classified twice`)
    keyNames.add(key.name)
  }
  if (!components.some((component) => component.scope === 'visible')) {
    throw componentError('component surface needs at least one visible component')
  }
  return {
    schema: COMPONENT_SCHEMA_VERSION,
    date,
    adr,
    classes,
    components,
    keys,
    behaviorKnobs,
    gateableTools,
    forbidden,
  }
}

/**
 * Read the shipped component rows out of `cordis.patch.yml`.
 *
 * The parse is deliberately small: a row is an `- id:` entry directly under
 * `- insert:` or directly under a group's `config:` list. A plugin id under
 * `plugins:` is not a component. `group` marks a row that mounts a group of
 * sections rather than a single plugin.
 *
 * @param {string} text
 * @returns {{ rows: Array<{ id: string, scope: string, kind: string, group: boolean, overrides: string[], configOverrides: Array<{ key: string, value: string }>, patch?: string }>, visible: string[] }}
 */
export function parseCordisPatch(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const insertIndex = lines.findIndex((line) => /^\s*-\s+insert:\s*$/.test(line))
  if (insertIndex < 0) return { rows: [], visible: [] }
  /** @type {Array<{ id: string, scope: string, kind: string, group: boolean, overrides: string[], configOverrides: Array<{ key: string, value: string }>, indent: number, line: number }>} */
  const rows = []
  const stack = []
  let rowIndent = null
  for (let index = insertIndex; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = /^(\s*)/.exec(line)?.[1].length ?? 0
    if (index === insertIndex) {
      stack.push({ indent, key: 'insert' })
      continue
    }
    const idMatch = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (idMatch) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      const container = stack.length > 0 ? stack[stack.length - 1].key : null
      if (container !== 'insert' && container !== 'config') continue
      if (container === 'insert' && rowIndent === null) rowIndent = indent
      const scope = container === 'insert' && indent === rowIndent ? 'visible' : 'internal'
      rows.push({
        id: idMatch[1].replace(/^['"]|['"]$/g, ''),
        scope,
        kind: 'row',
        group: false,
        overrides: [],
        configOverrides: [],
        indent,
        line: index,
      })
      continue
    }
    const keyMatch = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (keyMatch) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      stack.push({ indent, key: keyMatch[1] })
    }
  }
  for (const row of rows) {
    const block = []
    for (let index = row.line + 1; index < lines.length; index += 1) {
      const line = lines[index]
      const nextId = /^(\s*)-\s+id:/.exec(line)
      if (nextId && nextId[1].length <= row.indent) break
      if (!line.trim() || /^\s*#/.test(line)) continue
      const lineIndent = /^(\s*)/.exec(line)?.[1].length ?? 0
      if (lineIndent <= row.indent && !/^\s*-\s+/.test(line)) break
      block.push(line)
    }
    row.group = block.some((line) => /^\s*group:\s*true\s*$/.test(line))
    row.kind = row.group ? 'group' : 'row'
    row.configOverrides = row.group ? [] : collectConfigOverrides(lines, row)
    // #138: keep the false-valued paths for the forbidden denylist, and the full
    // override set for the "row matches the capability it owns" check.
    row.overrides = row.configOverrides.filter((entry) => entry.value === 'false').map((entry) => entry.key)
  }
  return {
    rows: rows.map(({ line, indent, ...row }) => row),
    visible: rows.filter((row) => row.scope === 'visible').map((row) => row.id),
  }
}

/**
 * Merge every shipped patch into the one live shape the policy checks compare
 * against. Rows keep the file they came from, so a finding can name it.
 *
 * @param {Record<string, ReturnType<typeof parseCordisPatch>>} patches file -> parsed patch
 * @returns {{ rows: Array<{ id: string, scope: string, kind: string, group: boolean, overrides: string[], patch: string }>, visible: string[] }}
 */
export function mergeCordisPatches(patches = {}) {
  const files = Object.keys(patches)
  const rows = []
  for (const file of files) {
    for (const row of patches[file]?.rows ?? []) rows.push({ ...row, patch: file })
  }
  return {
    rows,
    visible: rows.filter((row) => row.scope === 'visible').map((row) => row.id),
  }
}

/**
 * The shipped shape and the classification must describe the same components and
 * config keys. This is the parity half of the gate: a row without a class, or a
 * class without a row, is an unowned decision.
 *
 * @param {ReturnType<typeof parseComponentSurface>} surface
 * @param {{ configKeys: string[], patch: ReturnType<typeof mergeCordisPatches> }} live
 */
export function validateComponentSurface(surface, live) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  const shipped = new Map(live.patch.rows.map((row) => [row.id, row]))
  const classified = new Map(surface.components.map((component) => [component.id, component]))
  for (const component of surface.components) {
    const row = shipped.get(component.id)
    if (!row) {
      record('component-missing', `component surface lists "${component.id}" but no shipped cordis.patch.yml defines it`)
      continue
    }
    if (row.scope !== component.scope) {
      record(
        'component-scope',
        `component "${component.id}" is ${component.scope} in the source of truth but ${row.scope} in ${row.patch ?? 'cordis.patch.yml'}`,
      )
    }
    if (row.kind !== component.kind) {
      record(
        'component-kind',
        `component "${component.id}" is a ${component.kind} in the source of truth but a ${row.kind} in ${row.patch ?? 'cordis.patch.yml'}`,
      )
    }
  }
  for (const row of live.patch.rows) {
    if (!classified.has(row.id)) {
      record('component-unclassified', `${row.patch ?? 'cordis.patch.yml'} ships component "${row.id}" but the source of truth does not classify it`)
    }
  }
  const declared = new Set(surface.keys.map((key) => key.name))
  const liveKeys = new Set(live.configKeys)
  for (const name of live.configKeys) {
    if (!declared.has(name)) record('key-unclassified', `config key ${name} has no component-axis class`)
  }
  for (const name of declared) {
    if (!liveKeys.has(name)) record('key-unknown', `component surface classifies ${name}, which is not a live config key`)
  }
  const accepted = new Set()
  for (const capability of surface.forbidden) {
    for (const key of capability.acceptedSwitches?.keys ?? []) accepted.add(key)
  }
  for (const key of accepted) {
    const entry = surface.keys.find((candidate) => candidate.name === key)
    if (!entry) {
      record('forbidden-class', `forbidden capability records ${key}, which has no component-axis class`)
    } else if (entry.class !== 'forbidden-to-disable') {
      record('forbidden-class', `${key} gates a forbidden capability but is classified "${entry.class}", not forbidden-to-disable`)
    }
  }
  return findings
}

/**
 * Every visible component must carry `title`, `summary` and `disables` in every
 * shipped locale. The locale set itself must only name known components, so a
 * typo cannot pass as coverage.
 *
 * `options.ids` restricts the required set to the components whose labels live in
 * these locale files. #134: the `tower-ui` row ships in `ui-bundle/` and is
 * labelled by that package's own `meta` block, not by the root `components` block.
 *
 * @param {ReturnType<typeof parseComponentSurface>} surface
 * @param {Record<string, any>} locales file path -> parsed locale JSON
 * @param {{ ids?: string[] }} [options]
 */
export function checkLocaleCoverage(surface, locales, options = {}) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  const known = new Set(surface.components.map((component) => component.id))
  const required = options.ids === undefined ? null : new Set(options.ids)
  for (const component of surface.components) {
    if (component.scope !== 'visible') continue
    if (required && !required.has(component.id)) continue
    for (const file of LOCALE_FILES) {
      const entry = locales?.[file]?.components?.[component.id]
      if (!entry || typeof entry !== 'object') {
        record('component-locale', `visible component "${component.id}" has no entry in ${file}`)
        continue
      }
      for (const field of LOCALE_FIELDS) {
        const value = typeof entry[field] === 'string' ? entry[field].trim() : ''
        if (!value) record('component-locale', `visible component "${component.id}" misses "${field}" in ${file}`)
      }
    }
  }
  for (const file of LOCALE_FILES) {
    for (const id of Object.keys(locales?.[file]?.components ?? {})) {
      if (!known.has(id)) record('component-locale-unknown', `${file} labels "${id}", which is not a shipped component`)
    }
  }
  return findings
}

/**
 * #132: the plugin page renders a group row from the root locale `meta.title` /
 * `meta.description`. The off consequence of the `tower` group (off equals
 * uninstalling Tower) must therefore appear in `meta.description`, in every
 * shipped language — otherwise the most important consequence is dead copy.
 *
 * @param {ReturnType<typeof parseComponentSurface>} surface
 * @param {Record<string, any>} locales file path -> parsed locale JSON
 */
export function checkGroupLabelCoverage(surface, locales) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  for (const component of surface.components) {
    if (component.scope !== 'visible' || component.kind !== 'group') continue
    for (const file of LOCALE_FILES) {
      const meta = locales?.[file]?.meta
      const title = typeof meta?.title === 'string' ? meta.title.trim() : ''
      const description = typeof meta?.description === 'string' ? meta.description.trim() : ''
      if (!title) record('group-locale', `${file} misses meta.title for group component "${component.id}"`)
      if (!description) {
        record('group-locale', `${file} misses meta.description for group component "${component.id}"`)
        continue
      }
      const disables = locales?.[file]?.components?.[component.id]?.disables
      const consequence = typeof disables === 'string' ? disables.trim() : ''
      if (!consequence) continue
      if (!description.includes(consequence)) {
        record(
          'group-locale',
          `${file} meta.description does not state the off consequence of group component "${component.id}"`,
        )
      }
    }
  }
  return findings
}

/**
 * #134: a row that ships in its own package is labelled by that package's
 * `meta.title` / `meta.description`, and DSH shows the "when off" consequence in
 * the description. Require both meta strings and the off marker for every
 * visible row of a meta-labelled patch, in every language file it ships.
 *
 * @param {string[]} ids row ids whose labels live in `locales`
 * @param {Record<string, any>} locales file path -> parsed locale JSON
 * @param {Record<string, string>} markers language -> off-effect marker
 */
export function checkMetaLabelCoverage(ids, locales, markers) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  for (const id of ids) {
    for (const [file, payload] of Object.entries(locales ?? {})) {
      const lang = /([a-z]{2})\.json$/.exec(file)?.[1] ?? ''
      const marker = markers?.[lang] ?? ''
      const title = typeof payload?.meta?.title === 'string' ? payload.meta.title.trim() : ''
      const description = typeof payload?.meta?.description === 'string' ? payload.meta.description.trim() : ''
      if (!title) record('meta-locale', `row "${id}" misses meta.title in ${file}`)
      if (!description) {
        record('meta-locale', `row "${id}" misses meta.description in ${file}`)
        continue
      }
      if (marker && !description.includes(marker)) {
        record('meta-locale', `row "${id}" meta.description does not state the off consequence in ${file}`)
      }
    }
  }
  return findings
}

/**
 * The denylist. The host, the health contract, the recovery escape, the review
 * contract and the merge gates may not be turned off by any group, row or
 * boolean key.
 *
 * The live disablers are derived statically:
 *   - `host/tool-registry.js` may map a tool to a `tools.expose*` boolean that
 *     skips registering it (#122 removed the shipped table; the parser keeps the
 *     allowlist ready if one ever returns);
 *   - `cordis.patch.yml` rows may set a forbidden-to-disable key to `false`, or
 *     expose a forbidden capability as its own switchable row.
 *
 * Two routes are checked, not one. A row override is refused when its leaf names
 * *any* key classified `forbidden-to-disable`, not only a capability's `gatedBy`
 * keys. And every registry route must match the `gateableTools` allowlist in the
 * source of truth, so adding `['tower_merge', 'exposeBatch']` to
 * `host/tool-registry.js` fails even though the merge-gate capability lists no
 * tools that a switch could remove.
 *
 * @param {ReturnType<typeof parseComponentSurface>} surface
 * @param {{ booleans: string[], registry: Record<string, string>, patch: ReturnType<typeof parseCordisPatch> }} live
 */
export function checkForbidden(surface, live) {
  const findings = []
  const record = (code, level, message) => findings.push({ code, level, message })
  const booleanKeys = new Set(live.booleans ?? [])
  const registry = live.registry ?? {}
  const rows = live.patch?.rows ?? []
  const forbiddenRowIds = new Set(surface.forbidden.flatMap((capability) => capability.rowIds ?? []))

  // Row route: every key classified forbidden-to-disable is unreachable from a
  // row, whatever capability owns it. `gatedBy` is folded in so a contract key
  // recorded only on the capability still resolves to its full name.
  const forbiddenLeaves = new Map()
  const remember = (name) => {
    const leaf = name.split('.').pop()
    if (!forbiddenLeaves.has(name)) forbiddenLeaves.set(name, name)
    if (!forbiddenLeaves.has(leaf)) forbiddenLeaves.set(leaf, name)
  }
  for (const key of surface.keys) {
    if (key.class !== 'forbidden-to-disable') continue
    remember(key.name)
  }
  for (const capability of surface.forbidden) {
    for (const key of capability.gatedBy ?? []) remember(key)
  }
  for (const row of rows) {
    if (row.scope === 'visible' && forbiddenRowIds.has(row.id)) {
      record('forbidden-component', 'error', `component "${row.id}" exposes a forbidden-to-disable capability as a switch`)
    }
    for (const leaf of row.overrides ?? []) {
      const key = forbiddenLeaves.get(leaf)
      if (!key) continue
      record(
        'forbidden-override',
        'error',
        `row "${row.id}" sets ${key}:false in cordis.patch.yml; a component may not switch off a forbidden-to-disable key`,
      )
    }
  }

  // Boolean route: the allowlist is the shipped set of tool -> switch mappings.
  // Anything else in OPERATIONAL_TOOLS is a new way to remove a tool, and a
  // review, merge or host tool must never gain one.
  const gateable = new Map((surface.gateableTools ?? []).map((entry) => [entry.tool, entry.key]))
  for (const [tool, flag] of Object.entries(registry)) {
    const route = `tools.${flag}`
    const declared = gateable.get(tool)
    if (declared === route) continue
    record(
      'forbidden-tool-gate',
      'error',
      declared
        ? `${tool} is gated by ${route} in host/tool-registry.js, but the source of truth records ${declared}; a tool route may not move to another switch`
        : `${tool} is gated by ${route} in host/tool-registry.js but is not a recorded gateable tool; a review, merge or host tool may not become a switch`,
    )
  }
  for (const entry of surface.gateableTools ?? []) {
    if (registry[entry.tool] === undefined) {
      record(
        'gateable-stale',
        'warn',
        `${entry.tool} is recorded as gateable by ${entry.key} but host/tool-registry.js no longer gates it; remove the allowlist entry`,
      )
      continue
    }
    const keyEntry = surface.keys.find((candidate) => candidate.name === entry.key)
    if (!keyEntry) {
      record('gateable-class', 'error', `${entry.tool} is recorded gateable by ${entry.key}, which has no component-axis class`)
      continue
    }
    if (!['optional-component', 'forbidden-to-disable'].includes(keyEntry.class)) {
      record(
        'gateable-class',
        'error',
        `${entry.key} gates ${entry.tool} but is classified "${keyEntry.class}"; only an optional component or recorded forbidden debt may gate a tool`,
      )
    }
    for (const capability of surface.forbidden) {
      if (!(capability.tools ?? []).includes(entry.tool)) continue
      const accepted = new Set(capability.acceptedSwitches?.keys ?? [])
      if (!accepted.has(entry.key)) {
        record(
          'forbidden-tool-gate',
          'error',
          `${entry.tool} belongs to ${capability.capability} but ${entry.key} is not a recorded disabler; the allowlist may not legalise a forbidden switch`,
        )
      }
    }
  }

  for (const capability of surface.forbidden) {
    const liveSwitches = new Set()
    for (const tool of capability.tools ?? []) {
      const flag = registry[tool]
      if (!flag) continue
      liveSwitches.add(`tools.${flag}`)
    }
    const accepted = capability.acceptedSwitches?.keys ?? []
    const acceptedSet = new Set(accepted)
    for (const key of liveSwitches) {
      if (!acceptedSet.has(key)) {
        record(
          'forbidden-disabler',
          'error',
          `${key} can disable ${capability.capability}; a forbidden-to-disable capability may not be gated by a group, row or boolean key`,
        )
      }
    }
    for (const key of accepted) {
      if (!booleanKeys.has(key)) {
        record('forbidden-disabler', 'error', `recorded disabler ${key} for ${capability.id} is not a live boolean config key`)
      }
      if (!liveSwitches.has(key)) {
        record(
          'forbidden-stale',
          'warn',
          `${key} is recorded as a disabler for ${capability.id} but host/tool-registry.js no longer wires it; remove the record`,
        )
      }
    }
  }
  return findings
}

/** Render the generated component reference from the single source of truth. */
export function renderComponentSurface(surface, options = {}) {
  const baselineDate = options.baselineDate ?? surface.date
  const visible = surface.components.filter((component) => component.scope === 'visible')
  const classRows = COMPONENT_CLASSES.map((name) => `| \`${name}\` | ${surface.classes[name]} |`).join('\n')
  const componentRows = surface.components
    .map(
      (component) =>
        `| \`${component.id}\` | ${component.scope} | ${component.kind} | ${component.fallback} |`,
    )
    .join('\n')
  const keyRows = surface.keys
    .map((key) => {
      const exemption = key.exemption
        ? ` Tuning exemption: ${key.exemption.reason} (${key.exemption.date}${key.exemption.issue ? ` · ${key.exemption.issue}` : ''} · [${decidedIn(key.exemption.ref)}](${relativeAdr(key.exemption.ref)}))`
        : ''
      return `| \`${key.name}\` | \`${key.class}\` | ${key.note}${exemption} |`
    })
    .join('\n')
  const behaviorRows = (surface.behaviorKnobs ?? [])
    .map((name) => `| \`${name}\` |`)
    .join('\n') || '| _(none)_ |'
  const forbiddenRows = surface.forbidden
    .map((capability) => {
      const decision = capability.acceptedSwitches?.decision
      const accepted = capability.acceptedSwitches?.keys?.length
        ? capability.acceptedSwitches.keys.map((key) => `\`${key}\``).join(', ')
        : 'none'
      const evidence = decision
        ? `recorded ${decision.date}${decision.issue ? ` · ${decision.issue}` : ''} · [${decidedIn(decision.ref)}](${relativeAdr(decision.ref)})`
        : 'none may exist'
      return `| ${capability.capability} | ${capability.reason} | ${accepted} | ${evidence} |`
    })
    .join('\n')
  const gateableRows = (surface.gateableTools ?? [])
    .map((entry) => `| \`${entry.tool}\` | \`${entry.key}\` |`)
    .join('\n') || '| _(none)_ | — |'
  const visibleIds = visible.map((component) => `\`${component.id}\``).join(', ')
  return `# Component surface (generated)

> Generated by \`npm run docs:generate:components\` from \`${COMPONENT_SURFACE_FILE}\` and
> \`scripts/surface-baseline.json\`. Do not edit by hand.

Decision: [ADR 0005](${relativeAdr(surface.adr)}) · decision date: ${surface.date} · baseline ${baselineDate} · visible components: ${visible.length} (${visibleIds})

The component axis answers one question for every config key: may a user turn it
off, and if so, must that switch be a component? Four classes cover every key, so
"should this be a component?" is a table lookup rather than a judgement call.

| Class | Meaning |
|---|---|
${classRows}

## Components

The shipped \`cordis.patch.yml\` rows, with the fallback contract each off state
must satisfy. A visible row is a component the plugin page may switch; an internal
row is a section of its parent and is not independently switchable.

| Component | Scope | Kind | Off state and fallback |
|---|---|---|---|
${componentRows}

## Forbidden to disable

The host, the health contract, the recovery escape, the review contract and the
merge gates are configuration or code, never switches. \`npm run
docs:check:components\` derives the live disablers from \`host/tool-registry.js\`
and \`cordis.patch.yml\`; a disabler that is not recorded here fails the gate.

| Capability | Why it may not be disabled | Recorded disablers | Decision |
|---|---|---|---|
${forbiddenRows}

## Gateable tools

The allowlist of boolean routes in \`host/tool-registry.js\`. Every shipped
\`tools.expose*\` route must match this table. A route to a tool that is not listed
here is refused, so no boolean key can quietly remove a review, merge or host
tool. Since #122 the shipped table is empty: \`tower_doctor\` and \`tower_recover\`
are registered for every configuration and no other capability may become a
boolean switch.

| Tool | Switch key |
|---|---|
${gateableRows}

## Config keys

All keys from \`domain/config/schema.js\`, classified on the component axis.

| Key | Component class | Decision note |
|---|---|---|
${keyRows}

## Behaviour knobs

Non-boolean keys that gate behaviour are reviewed on the same axis as booleans
(#138): each must be \`core\`, \`optional-component\`, \`forbidden-to-disable\`, or an
\`optional-config\` key with a dated tuning-only exemption. A string or union that
hides a capability cannot use the tuning class without that record.

| Key |
|---|
${behaviorRows}

## Non-goals

This page does not decide whether a key is useful, and it is not an approval
process. It records the class so the gate can refuse an unclassified or
forbidden surface.

Enforced by: \`scripts/check-components.mjs\`; tests in \`tests/components.test.mjs\`; gate: \`npm run docs:check:components\`.
`
}

function relativeAdr(repositoryPath) {
  const name = String(repositoryPath ?? '').split('/').pop()
  return `../adr/${name}`
}

function decidedIn(repositoryPath) {
  return String(repositoryPath ?? '').split('/').pop()
}
