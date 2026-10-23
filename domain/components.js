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
export const COMPONENT_SURFACE_FILE = 'scripts/component-surface.json'
export const COMPONENT_REFERENCE_FILE = 'docs/reference/component-surface.md'
export const COMPONENT_SCHEMA_VERSION = 1
export const COMPONENT_CLASSES = ['core', 'optional-component', 'optional-config', 'forbidden-to-disable']
export const COMPONENT_SCOPES = ['visible', 'internal']
export const COMPONENT_KINDS = ['group', 'row']
export const LOCALE_FILES = ['locale/en.json', 'locale/zh.json']
export const LOCALE_FIELDS = ['title', 'summary', 'disables']

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
  return { schema: COMPONENT_SCHEMA_VERSION, date, adr, classes, components, keys, forbidden }
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
 * @returns {{ rows: Array<{ id: string, scope: string, kind: string, group: boolean, overrides: string[] }>, visible: string[] }}
 */
export function parseCordisPatch(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const insertIndex = lines.findIndex((line) => /^\s*-\s+insert:\s*$/.test(line))
  if (insertIndex < 0) return { rows: [], visible: [] }
  /** @type {Array<{ id: string, scope: string, kind: string, group: boolean, overrides: string[], indent: number, line: number }>} */
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
    const overrides = new Set()
    for (const line of block) {
      for (const match of line.matchAll(/([A-Za-z0-9_-]+)\s*:\s*false\b/g)) overrides.add(match[1])
    }
    row.overrides = [...overrides]
  }
  return {
    rows: rows.map(({ line, indent, ...row }) => row),
    visible: rows.filter((row) => row.scope === 'visible').map((row) => row.id),
  }
}

/**
 * The shipped shape and the classification must describe the same components and
 * config keys. This is the parity half of the gate: a row without a class, or a
 * class without a row, is an unowned decision.
 *
 * @param {ReturnType<typeof parseComponentSurface>} surface
 * @param {{ configKeys: string[], patch: ReturnType<typeof parseCordisPatch> }} live
 */
export function validateComponentSurface(surface, live) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  const shipped = new Map(live.patch.rows.map((row) => [row.id, row]))
  const classified = new Map(surface.components.map((component) => [component.id, component]))
  for (const component of surface.components) {
    const row = shipped.get(component.id)
    if (!row) {
      record('component-missing', `component surface lists "${component.id}" but cordis.patch.yml does not ship it`)
      continue
    }
    if (row.scope !== component.scope) {
      record(
        'component-scope',
        `component "${component.id}" is ${component.scope} in the source of truth but ${row.scope} in cordis.patch.yml`,
      )
    }
    if (row.kind !== component.kind) {
      record(
        'component-kind',
        `component "${component.id}" is a ${component.kind} in the source of truth but a ${row.kind} in cordis.patch.yml`,
      )
    }
  }
  for (const row of live.patch.rows) {
    if (!classified.has(row.id)) {
      record('component-unclassified', `cordis.patch.yml ships component "${row.id}" but the source of truth does not classify it`)
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
 * @param {ReturnType<typeof parseComponentSurface>} surface
 * @param {Record<string, any>} locales file path -> parsed locale JSON
 */
export function checkLocaleCoverage(surface, locales) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  const known = new Set(surface.components.map((component) => component.id))
  for (const component of surface.components) {
    if (component.scope !== 'visible') continue
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
 * The denylist. The host, the health contract, the recovery escape, the review
 * contract and the merge gates may not be turned off by any group, row or
 * boolean key.
 *
 * The live disablers are derived statically:
 *   - `host/tool-registry.js` maps a tool to the `tools.expose*` boolean that
 *     skips registering it (and `tools.exposeOperational` skips them all);
 *   - `cordis.patch.yml` rows may set a contract key to `false`, or expose a
 *     forbidden capability as its own switchable row.
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
  const gatedLeaves = new Set(
    surface.forbidden.flatMap((capability) => (capability.gatedBy ?? []).map((key) => key.split('.').pop())),
  )
  for (const row of rows) {
    if (row.scope === 'visible' && forbiddenRowIds.has(row.id)) {
      record('forbidden-component', 'error', `component "${row.id}" exposes a forbidden-to-disable capability as a switch`)
    }
    for (const leaf of row.overrides ?? []) {
      if (gatedLeaves.has(leaf)) {
        record(
          'forbidden-override',
          'error',
          `row "${row.id}" sets ${leaf}:false in cordis.patch.yml; a component may not switch off a contract key`,
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
      liveSwitches.add('tools.exposeOperational')
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
  const keyRows = surface.keys.map((key) => `| \`${key.name}\` | \`${key.class}\` | ${key.note} |`).join('\n')
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

## Config keys

All keys from \`domain/config/schema.js\`, classified on the component axis.

| Key | Component class | Decision note |
|---|---|---|
${keyRows}

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
