// Component-surface schema and parse (W5-A).
//
// Split out of `domain/components.js` without behavior change: the constants and
// pure shape/parse helpers, plus the generated-reference renderer. The
// class/row-override rules live in `component-rules.js`, the locale/meta checks
// in `component-locale.js`, and `domain/components.js` re-exports the stable
// public names to the gate and the tests.
import { collectConfigOverrides } from './component-rules.js'

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

The host, the health contract, the recovery escape and the merge gates are
configuration or code, never switches. The review gate in \`required\` mode is
also non-disableable: a completed mission still needs the review evidence bound
to the branch tip, and the exemption path stays explicit. The policy itself is
not a never-switch — \`review.mode\` is the one tri-state control on the
plugin-page config form (\`off\`, \`optional\` or \`required\`) — and only the gate it
turns on in \`required\` mode is non-disableable. \`npm run
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
