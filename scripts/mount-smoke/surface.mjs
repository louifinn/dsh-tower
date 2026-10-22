// The expected loaded surface of the dsh-tower bundle (#95).
//
// Pure derivation and comparison only: the mount smoke boots a throwaway
// profile, and these helpers turn the checked-in source of truth into the ids
// that boot must produce. Keeping them here — instead of inside the command —
// lets the offline suite pin the oracle without installing a host.
//
// The oracle is deliberately source-derived where the source is unambiguous:
// one tool id per tool module, one skill id per bundled skill file. The bundle
// children and presets come from `cordis.patch.yml` and are stated here as the
// contract the #66 invariant protects.

/** Tools registered by index.js rather than by a handler module under tools/. */
export const INDEX_TOOL_IDS = ['tower_control', 'tower_mode']

/** The single top-level row the bundle is allowed to contribute (#66). */
export const BUNDLE_ID = 'tower-bundle'

/** Rows that must stay nested inside {@link BUNDLE_ID}. */
export const BUNDLE_CHILD_IDS = ['preset-tower-reviewer', 'preset-tower-worker', 'tower', 'tower-skills']

/** Presets the bundle declares for its worker and reviewer roles. */
export const PRESET_IDS = ['tower-reviewer', 'tower-worker']

/** Cordis fiber state 2: mounted and active. */
const FIBER_ACTIVE = 2

const OWNED_ROW_IDS = new Set([BUNDLE_ID, ...BUNDLE_CHILD_IDS])

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
 * @returns {string[]} sorted tool ids the loaded profile must register.
 */
export function expectedToolIds(moduleFiles) {
  const ids = new Set(INDEX_TOOL_IDS)
  for (const file of moduleFiles) {
    const id = toolIdForModule(file)
    if (id !== null) ids.add(id)
  }
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

/**
 * Assert the bundle contributes exactly one top-level group row (#66) and that
 * every composed section actually mounted.
 * @param {Array<{ id?: string, name?: string, group?: boolean, config?: unknown[] }>} topRows -
 *   the composed rows at the root of the loaded profile tree.
 * @param {Record<string, number | undefined>} [entryStates] - fiber state per entry id.
 * @returns {string[]} one message per violated invariant.
 */
export function checkBundleRow(topRows, entryStates = {}) {
  const rows = Array.isArray(topRows) ? topRows.filter(Boolean) : []
  const failures = []
  const bundleRows = rows.filter((row) => row.id === BUNDLE_ID)
  if (bundleRows.length !== 1) {
    failures.push(
      bundleRows.length === 0
        ? `bundle: no top-level ${BUNDLE_ID} row; the bundle did not compose`
        : `bundle: found ${bundleRows.length} top-level ${BUNDLE_ID} rows, expected exactly 1`,
    )
    if (bundleRows.length === 0) return failures
  }

  const leaked = new Set()
  for (const row of rows) {
    if (row.id === BUNDLE_ID) continue
    const name = typeof row.name === 'string' ? row.name : ''
    const ownedName = name === 'dsh-tower' || name.startsWith('dsh-tower/')
    if (!OWNED_ROW_IDS.has(String(row.id)) && !ownedName) continue
    if (leaked.has(String(row.id))) continue
    leaked.add(String(row.id))
    failures.push(`bundle: ${row.id} is a top-level row; it must stay nested in ${BUNDLE_ID}`)
  }

  const bundleRow = bundleRows[0]
  if (bundleRow.name !== 'cordis:group' || bundleRow.group !== true) {
    failures.push(
      `bundle: ${BUNDLE_ID} is not a cordis:group row (name ${JSON.stringify(bundleRow.name)}, group ${JSON.stringify(bundleRow.group)})`,
    )
  }

  const rawChildren = Array.isArray(bundleRow.childIds) ? bundleRow.childIds : Array.isArray(bundleRow.config) ? bundleRow.config : []
  const children = rawChildren
    .map((child) =>
      child && typeof child === 'object' && child.id !== undefined ? String(child.id) : typeof child === 'string' ? child : null,
    )
    .filter(Boolean)
  const expectedChildren = [...BUNDLE_CHILD_IDS].sort()
  for (const id of expectedChildren) if (!children.includes(id)) failures.push(`bundle: ${BUNDLE_ID} is missing child ${id}`)
  for (const id of children) if (!expectedChildren.includes(id)) failures.push(`bundle: ${BUNDLE_ID} has unexpected child ${id}`)
  if (new Set(children).size !== children.length) failures.push(`bundle: ${BUNDLE_ID} has duplicate child rows`)

  for (const id of [BUNDLE_ID, ...BUNDLE_CHILD_IDS]) {
    const state = entryStates?.[id]
    if (state !== FIBER_ACTIVE) {
      failures.push(`bundle: entry ${id} is not active (entry state ${state === undefined ? 'missing' : state})`)
    }
  }
  return failures
}
