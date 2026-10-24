// The expected loaded surface of the dsh-tower bundle (#95, #121).
//
// Pure derivation and comparison only: the mount smoke boots a throwaway
// profile, and these helpers turn the checked-in source of truth into the ids
// that boot must produce. Keeping them here — instead of inside the command —
// lets the offline suite pin the oracle without installing a host.
//
// The oracle is deliberately source-derived where the source is unambiguous:
// one tool id per tool module, one skill id per bundled skill file. The bundle
// rows and presets come from `cordis.patch.yml` and are stated here as the
// contract the component policy protects: one mandatory host group plus
// individually switchable optional top-level rows (#121). Tools owned by a row
// that ships off (today only `tower-hmr` -> `tower_reload`) are trimmed from the
// expected surface using the same ownership table the runtime reports, so the
// shipped default profile (28 tools) and the all-rows-on build surface (29)
// cannot be confused again.

import { COMPONENT_TOOLS } from '../../host/capability-registry.js'

/** Tools registered by index.js rather than by a handler module under tools/. */
export const INDEX_TOOL_IDS = ['tower_control', 'tower_mode']

/** The mandatory host group row: off equals uninstalling. */
export const BUNDLE_ID = 'tower'

/** Rows that must stay nested inside {@link BUNDLE_ID}. */
export const BUNDLE_CHILD_IDS = ['preset-tower-worker', 'tower-host']

/** The optional capability rows that sit at the top level beside the host. */
export const OPTIONAL_ROW_IDS = [
  'preset-tower-reviewer',
  'tower-batch',
  'tower-hmr',
  'tower-import',
  'tower-leases',
  'tower-skills',
  'tower-tests',
]

/** Rows shipped off: the mount smoke must not expect them to be active. */
export const DEFAULT_OFF_ROW_IDS = ['tower-hmr']

/**
 * Tool ids owned by the rows in {@link DEFAULT_OFF_ROW_IDS}. The ownership table
 * is the one `host/capability-registry.js` uses to report a disabled component,
 * so the oracle cannot drift from the runtime: turning a row's default off in
 * `cordis.patch.yml` automatically removes its tools from the expected surface.
 * @returns {Set<string>} the tool ids a default profile does not register.
 */
export function defaultOffToolIds() {
  const ids = new Set()
  for (const rowId of DEFAULT_OFF_ROW_IDS) {
    for (const toolId of COMPONENT_TOOLS[rowId] ?? []) ids.add(toolId)
  }
  return ids
}

/**
 * The two preset rows the bundle declares. Each row mounts a Tower-owned
 * declaration module (`dsh-tower/preset-*`) whose config the agent-preset
 * registry registers; the label and the read-only reviewer surface are part of
 * the contract, so the smoke compares the loaded `agentPresets.list()` entries
 * against this table (#121).
 */
export const PRESET_ROWS = Object.freeze([
  Object.freeze({ id: 'tower-worker', specifier: 'preset-worker', name: 'Tower Worker', order: 60 }),
  Object.freeze({ id: 'tower-reviewer', specifier: 'preset-reviewer', name: 'Tower Reviewer', order: 61 }),
])

/** Presets the bundle declares for its worker and reviewer roles. */
export const PRESET_IDS = PRESET_ROWS.map((row) => row.id).sort()

/** Module specifiers the two preset rows mount; each owns its Plugins-page label. */
export const PRESET_SPECIFIERS = PRESET_ROWS.map((row) => `dsh-tower/${row.specifier}`)

/** Cordis fiber state 2: mounted and active. */
const FIBER_ACTIVE = 2
/** Cordis fiber state 3: the plugin failed to activate. */
const FIBER_FAILED = 3
/** Cordis fiber state 1: activation is still in flight (the boot has not settled). */
const FIBER_PENDING = 1

const OWNED_ROW_IDS = new Set([BUNDLE_ID, ...BUNDLE_CHILD_IDS, ...OPTIONAL_ROW_IDS])

/**
 * Map one tools/ file name to the tool id its module must register.
 * `import-legacy.js` registers `tower_import_legacy`; `index.js` registers none.
 * @param {string} fileName - a file name under tools/.
 * @returns {string | null} the expected tool id, or null for non-tool files.
 */
export function toolIdForModule(fileName) {
  if (typeof fileName !== 'string' || !fileName.endsWith('.js')) return null
  const base = fileName.slice(0, -'.js'.length)
  if (base.length === 0 || base === 'index' || base.includes('/') || base.includes('\\')) return null
  return `tower_${base.replaceAll('-', '_')}`
}

/**
 * @param {string[]} moduleFiles - file names under tools/.
 * @param {{ enabledRows?: string[] }} [options] - rows enabled in the profile
 *   under test. Defaults to the shipped profile: every optional row except the
 *   ones in {@link DEFAULT_OFF_ROW_IDS}. Pass every row id to pin the full
 *   build surface (29 tools with the shipped sources).
 * @returns {string[]} sorted tool ids the loaded profile must register.
 */
export function expectedToolIds(moduleFiles, options = {}) {
  const enabledRows = options.enabledRows === undefined ? null : new Set(options.enabledRows)
  const skipped = new Set()
  for (const rowId of DEFAULT_OFF_ROW_IDS) {
    if (enabledRows !== null && enabledRows.has(rowId)) continue
    for (const toolId of COMPONENT_TOOLS[rowId] ?? []) skipped.add(toolId)
  }
  const ids = new Set(INDEX_TOOL_IDS)
  for (const file of moduleFiles) {
    const id = toolIdForModule(file)
    if (id !== null) ids.add(id)
  }
  for (const id of skipped) ids.delete(id)
  return [...ids].sort()
}

/**
 * @param {string[]} skillFiles - file names under skills/.
 * @returns {string[]} sorted skill ids the bundled provider must publish.
 */
export function expectedSkillIds(skillFiles) {
  return skillFiles
    .filter((file) => typeof file === 'string' && file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .sort()
}

/**
 * Compare one loaded id list against the expected one.
 * @param {string} label - diagnostic prefix (`tool`, `skill`, `preset`, ...).
 * @param {string[]} expectedIds - ids the surface must contain.
 * @param {string[]} loadedIds - ids the loaded profile registered.
 * @returns {string[]} one message per missing, unexpected, or miscounted id.
 */
export function compareIds(label, expectedIds, loadedIds) {
  const expected = [...new Set(expectedIds)].sort()
  const loaded = [...new Set(loadedIds)].sort()
  const failures = []
  for (const id of expected) if (!loaded.includes(id)) failures.push(`${label}: missing ${id}`)
  for (const id of loaded) if (!expected.includes(id)) failures.push(`${label}: unexpected ${id}`)
  if (loaded.length !== expected.length) failures.push(`${label}: loaded ${loaded.length} ids, expected ${expected.length}`)
  return failures
}

/** Read one localized field: DSH reports `{ en, zh }` maps, a bare string, or nothing. */
function localizedField(value, lang) {
  if (typeof value === 'string') return value.trim() || undefined
  if (value && typeof value === 'object' && typeof value[lang] === 'string') return value[lang].trim() || undefined
  return undefined
}

/**
 * Assert the two preset rows resolve distinct Plugins-page labels. The defect
 * this mission fixes was two rows sharing `@deepseek-ai/dsh-agent-preset`, so
 * both rendered that module's single title; the smoke now reads the same
 * `readPluginMeta` the page uses and requires a distinct title and description
 * per specifier (#121).
 * @param {Record<string, { title?: unknown, description?: unknown, error?: string } | null>} labels
 *   module specifier -> label metadata from `readPluginMeta`.
 * @returns {string[]} one message per missing, failed or indistinguishable label.
 */
export function checkPresetLabels(labels) {
  const failures = []
  const byLanguage = { en: new Map(), zh: new Map() }
  for (const row of PRESET_ROWS) {
    const specifier = `dsh-tower/${row.specifier}`
    const label = labels?.[specifier]
    if (label === undefined) {
      failures.push(`label: no label reported for ${specifier}`)
      continue
    }
    if (label === null) {
      failures.push(`label: ${specifier} resolves no locale metadata`)
      continue
    }
    if (label.error) {
      failures.push(`label: ${specifier}: ${label.error}`)
      continue
    }
    for (const lang of ['en', 'zh']) {
      const title = localizedField(label.title, lang)
      const description = localizedField(label.description, lang)
      if (!title) {
        failures.push(`label: ${specifier} has no ${lang} title`)
        continue
      }
      if (!description) failures.push(`label: ${specifier} has no ${lang} description`)
      if (title === specifier) failures.push(`label: ${specifier} falls back to the module specifier as its ${lang} title`)
      if (!title.includes(row.name)) failures.push(`label: ${specifier} ${lang} title does not name ${row.name}`)
      byLanguage[lang].set(specifier, { title, description })
    }
  }
  for (const lang of ['en', 'zh']) {
    const entries = [...byLanguage[lang].entries()]
    if (entries.length < 2) continue
    const [first] = entries
    for (const [specifier, entry] of entries.slice(1)) {
      if (entry.title === first[1].title) {
        failures.push(`label: ${first[0]} and ${specifier} share the same ${lang} title`)
      }
      if (entry.description !== undefined && entry.description === first[1].description) {
        failures.push(`label: ${first[0]} and ${specifier} share the same ${lang} description`)
      }
    }
  }
  return failures
}

/**
 * Compare the loaded preset definitions against {@link PRESET_ROWS}. A missing
 * preset, a changed display name/order, or an activation diagnostic (`broken`)
 * is a failed claim: a preset row that mounts but never activates is exactly the
 * regression the smoke exists to catch.
 * @param {Array<{ id?: string, name?: string, order?: number, broken?: string }>} entries
 * @returns {string[]} one message per violated preset claim.
 */
export function checkPresetRows(entries) {
  const list = Array.isArray(entries) ? entries : []
  const byId = new Map(list.map((entry) => [String(entry?.id), entry]))
  const failures = []
  for (const row of PRESET_ROWS) {
    const entry = byId.get(row.id)
    if (!entry) {
      failures.push(`preset: missing ${row.id}`)
      continue
    }
    if (entry.name !== row.name) {
      failures.push(`preset: ${row.id} name ${JSON.stringify(entry.name)}, expected ${JSON.stringify(row.name)}`)
    }
    if (entry.order !== row.order) {
      failures.push(`preset: ${row.id} order ${JSON.stringify(entry.order)}, expected ${row.order}`)
    }
    if (entry.broken) failures.push(`preset: ${row.id} failed to mount: ${entry.broken}`)
  }
  return failures
}

/** Entry ids whose fiber reported an activation error (state 3). */
export function failedEntryStates(entryStates = {}) {
  return Object.entries(entryStates)
    .filter(([, state]) => state === FIBER_FAILED)
    .map(([id]) => id)
    .sort()
}

/** Entry ids still loading when the boot returned (state 1). */
export function pendingEntryStates(entryStates = {}) {
  return Object.entries(entryStates)
    .filter(([, state]) => state === FIBER_PENDING)
    .map(([id]) => id)
    .sort()
}

/**
 * No row may fail or stay pending in a green smoke: the bundle is supposed to
 * compose a working profile, not merely register the ids it claims.
 * @param {Record<string, number | null | undefined>} entryStates
 * @returns {string[]} one message per failed or pending row.
 */
export function checkRowStates(entryStates = {}) {
  const failures = []
  for (const id of failedEntryStates(entryStates)) failures.push(`row: ${id} failed to mount (entry state 3)`)
  for (const id of pendingEntryStates(entryStates)) failures.push(`row: ${id} is still pending (entry state 1)`)
  return failures
}

/** Effective loader id for a nested row (`group:child`), falling back to the raw id. */
function stateKey(id, entryStates) {
  if (entryStates[id] !== undefined) return id
  const nested = `${BUNDLE_ID}:${id}`
  if (entryStates[nested] !== undefined) return nested
  return id
}

/**
 * Assert the bundle ships one mandatory host group plus the optional rows and
 * that every expected row actually mounted (the `tower-hmr` row is shipped off).
 * @param {Array<{ id?: string, name?: string, group?: boolean, config?: unknown[], childIds?: unknown[] }>} topRows
 * @param {Record<string, number | undefined>} [entryStates] - fiber state per entry id.
 * @returns {string[]} one message per violated invariant.
 */
export function checkBundleRow(topRows, entryStates = {}) {
  const rows = Array.isArray(topRows) ? topRows.filter(Boolean) : []
  const failures = []
  const hostRows = rows.filter((row) => row.id === BUNDLE_ID)
  if (hostRows.length !== 1) {
    failures.push(
      hostRows.length === 0
        ? `bundle: no top-level ${BUNDLE_ID} host row; the bundle did not compose`
        : `bundle: found ${hostRows.length} top-level ${BUNDLE_ID} rows, expected exactly 1`,
    )
    if (hostRows.length === 0) return failures
  }

  const topIds = new Set(rows.map((row) => String(row.id)))
  for (const id of OPTIONAL_ROW_IDS) {
    if (!topIds.has(id)) failures.push(`bundle: missing optional top-level row ${id}`)
  }
  for (const row of rows) {
    if (row.id === BUNDLE_ID) continue
    const name = typeof row.name === 'string' ? row.name : ''
    const ownedName = name === 'dsh-tower' || name.startsWith('dsh-tower/')
    if (!OWNED_ROW_IDS.has(String(row.id)) && !ownedName) continue
    if (OPTIONAL_ROW_IDS.includes(String(row.id))) continue
    failures.push(`bundle: ${row.id} is a top-level row; it must stay nested in ${BUNDLE_ID}`)
  }

  const hostRow = hostRows[0]
  if (hostRow.name !== 'cordis:group' || hostRow.group !== true) {
    failures.push(
      `bundle: ${BUNDLE_ID} is not a cordis:group row (name ${JSON.stringify(hostRow.name)}, group ${JSON.stringify(hostRow.group)})`,
    )
  }

  const rawChildren = Array.isArray(hostRow.childIds) ? hostRow.childIds : Array.isArray(hostRow.config) ? hostRow.config : []
  const children = rawChildren
    .map((child) =>
      child && typeof child === 'object' && child.id !== undefined ? String(child.id) : typeof child === 'string' ? child : null,
    )
    .filter(Boolean)
  const expectedChildren = [...BUNDLE_CHILD_IDS].sort()
  for (const id of expectedChildren) if (!children.includes(id)) failures.push(`bundle: ${BUNDLE_ID} is missing child ${id}`)
  for (const id of children) if (!expectedChildren.includes(id)) failures.push(`bundle: ${BUNDLE_ID} has unexpected child ${id}`)
  if (new Set(children).size !== children.length) failures.push(`bundle: ${BUNDLE_ID} has duplicate child rows`)

  for (const id of [BUNDLE_ID, ...OPTIONAL_ROW_IDS]) {
    if (DEFAULT_OFF_ROW_IDS.includes(id)) {
      const state = entryStates[id]
      if (state === FIBER_ACTIVE) failures.push(`bundle: ${id} ships disabled but is active`)
      continue
    }
    const key = stateKey(id, entryStates)
    const state = entryStates[key]
    if (state !== FIBER_ACTIVE) {
      failures.push(`bundle: entry ${id} is not active (entry state ${state === undefined ? 'missing' : state})`)
    }
  }
  for (const id of BUNDLE_CHILD_IDS) {
    const key = stateKey(id, entryStates)
    const state = entryStates[key]
    if (state !== FIBER_ACTIVE) {
      failures.push(`bundle: entry ${id} is not active (entry state ${state === undefined ? 'missing' : state})`)
    }
  }
  return failures
}
