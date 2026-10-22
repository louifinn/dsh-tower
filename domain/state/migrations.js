// State-schema migrations (#72).
//
// The state file is a durable contract, so a version move is a migration, never
// a corruption. This module is the single place a future version is added: bump
// `SCHEMA_VERSION` in `../mission.js`, append one `{ from, to, migrate }` entry
// here, and every load path picks it up.
//
// Each `migrate` is a pure function: it receives a parsed document and returns a
// new one. It must not read the filesystem, mutate its argument, read the clock,
// or throw for data it can normalise. A step that throws becomes
// `[tower:state-migration-failed]` and the original file is left byte-identical.
// @ts-check
import { TowerToolError } from '../errors.js'
import { SCHEMA_VERSION } from '../mission.js'

/** @typedef {{ from: number, to: number, migrate: (state: Record<string, any>) => Record<string, any> }} StateMigration */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * v1 -> v2. Documents written before the current schema can omit `revision` and
 * a mission's `tasks`/`deps` arrays; v2's structural contract requires them.
 * The step only backfills absent values and never drops data.
 * @param {Record<string, any>} state
 * @returns {Record<string, any>}
 */
export function migrateV1ToV2(state) {
  const next = { ...state }
  if (!Number.isInteger(next.revision) || next.revision < 0) next.revision = 0
  next.missions = (Array.isArray(next.missions) ? next.missions : []).map((mission) => {
    if (!isPlainObject(mission)) return mission
    return {
      ...mission,
      tasks: Array.isArray(mission.tasks) ? mission.tasks : [],
      deps: Array.isArray(mission.deps) ? mission.deps : [],
    }
  })
  return next
}

/** Ordered registry: entry 0 moves 1 -> 2, entry 1 moves 2 -> 3, and so on. */
export const STATE_MIGRATIONS = Object.freeze([
  Object.freeze({ from: 1, to: 2, migrate: migrateV1ToV2 }),
])

/**
 * The ordered steps needed to move `from` to `to`, or null when the gap cannot
 * be crossed. `[]` means the document is already at `to`; a downgrade is never
 * expressed as a chain.
 *
 * @param {unknown} from
 * @param {number} [to]
 * @param {readonly StateMigration[]} [migrations]
 * @returns {StateMigration[] | null}
 */
export function migrationChain(from, to = SCHEMA_VERSION, migrations = STATE_MIGRATIONS) {
  if (!Number.isInteger(from) || /** @type {number} */ (from) < 1) return null
  if (!Number.isInteger(to) || to < 1) return null
  if (from === to) return []
  if (/** @type {number} */ (from) > to) return null
  const chain = []
  let version = /** @type {number} */ (from)
  while (version < to) {
    const step = migrations.find((entry) => entry.from === version)
    if (!step || !Number.isInteger(step.to) || step.to <= version) return null
    chain.push(step)
    version = step.to
  }
  return version === to ? chain : null
}

/**
 * Apply the registry to a parsed document. Pure: the input object is never
 * touched and the returned document has the target `schemaVersion`.
 *
 * @param {Record<string, any>} state
 * @param {{ statePath?: string, to?: number, migrations?: readonly StateMigration[] }} [options]
 * @returns {{ state: Record<string, any>, from: number, to: number, steps: Array<{ from: number, to: number }> }}
 */
export function migrateState(state, options = {}) {
  const where = options.statePath ? ` at ${options.statePath}` : ''
  const to = options.to ?? SCHEMA_VERSION
  const migrations = options.migrations ?? STATE_MIGRATIONS
  const from = state?.schemaVersion
  const chain = migrationChain(from, to, migrations)
  if (!chain || chain.length === 0) {
    throw new TowerToolError(
      'state-version-unsupported',
      `tower state schemaVersion ${String(from)}${where} cannot be migrated to ${to}`,
      {
        nextAction: `upgrade dsh-tower when the state was written by a newer release; otherwise restore a state.json this build can read (schemaVersion ${SCHEMA_VERSION})`,
      },
    )
  }
  /** @type {Record<string, any>} */
  let current = state
  /** @type {Array<{ from: number, to: number }>} */
  const steps = []
  for (const step of chain) {
    /** @type {Record<string, any>} */
    let next
    try {
      next = step.migrate(current)
    } catch (error) {
      throw new TowerToolError(
        'state-migration-failed',
        `state migration v${step.from} -> v${step.to} failed${where}: ${String(error?.message ?? error)}`,
        {
          cause: error,
          nextAction: 'the original state.json was not modified; inspect the pre-migration backup state.json.v<N>.bak and report this failure',
        },
      )
    }
    if (!isPlainObject(next)) {
      throw new TowerToolError(
        'state-migration-failed',
        `state migration v${step.from} -> v${step.to} returned ${next === null ? 'null' : typeof next}${where}`,
        { nextAction: 'the original state.json was not modified; report this migration bug' },
      )
    }
    current = { ...next, schemaVersion: step.to }
    steps.push({ from: step.from, to: step.to })
  }
  return { state: current, from: /** @type {number} */ (from), to, steps }
}
