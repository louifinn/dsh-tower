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
import { SHAPE_KINDS, shapeFor } from '../shapes/index.js'

/** @typedef {{ readCommit: string, readDirty: string[] }} LegacySurveyRead */
/** @typedef {{ legacySurveyRead?: LegacySurveyRead | null }} MigrationContext */
/** @typedef {{ from: number, to: number, migrate: (state: Record<string, any>, context?: MigrationContext) => Record<string, any> }} StateMigration */

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

/**
 * v2 -> v3. Scope matching gained a detected case mode (#90). Older documents
 * never recorded one, and a migration must not read the filesystem, so the
 * field is backfilled as `null` ("not detected"). Comparison then keeps the
 * safe exact default until the next `tower_init` probes the checkout.
 * @param {Record<string, any>} state
 * @returns {Record<string, any>}
 */
export function migrateV2ToV3(state) {
  if (state.caseInsensitive !== undefined) return state
  return { ...state, caseInsensitive: null }
}

/**
 * v3 -> v4. Mission state becomes per-shape (#149). Every mission is stamped with
 * its kind; a legacy branch-shaped survey keeps the commit it read (the
 * worktree's base commit) and drops the worktree/branch/merge fields it no
 * longer owns. Build missions keep their document unchanged.
 *
 * The step is pure and one-way. Re-running it on a v4 document is a fixed point:
 * every mission already has a kind, so the same shape migration rewrites it to
 * the same values.
 *
 * A legacy survey planned but never provisioned records no base commit at all
 * (2.6.0 wrote neither `baseCommit` nor a worktree at plan time). The loader
 * resolves the state base once and passes it as `context.legacySurveyRead`; the
 * survey shape consumes it only when it has no recorded base of its own.
 * @param {Record<string, any>} state
 * @param {MigrationContext} [context]
 * @returns {Record<string, any>}
 */
export function migrateV3ToV4(state, context = {}) {
  const next = { ...state }
  next.missions = (Array.isArray(next.missions) ? next.missions : []).map((mission) => {
    if (!isPlainObject(mission)) return mission
    const shape = SHAPE_KINDS.map((kind) => shapeFor(kind)).find((candidate) => candidate.isLegacy(mission))
    return shape ? shape.migrateLegacy(mission, context) : mission
  })
  return next
}

/**
 * True when a pre-v4 document contains at least one legacy mission whose shape
 * cannot anchor its read from the document alone (a survey planned but never
 * provisioned). The load path must resolve the repository base before migration
 * runs; a document that recorded its own commit needs no resolver, and a
 * current-version document is never re-migrated.
 * @param {unknown} state
 * @returns {boolean}
 */
export function legacySurveyNeedsRead(state) {
  if (!isPlainObject(state)) return false
  const document = /** @type {Record<string, any>} */ (state)
  const version = document.schemaVersion
  if (!Number.isInteger(version) || version < 1 || version >= SCHEMA_VERSION) return false
  const missions = Array.isArray(document.missions) ? document.missions : []
  return missions.some((mission) => {
    if (!isPlainObject(mission)) return false
    const shape = SHAPE_KINDS.map((kind) => shapeFor(kind)).find((candidate) => candidate.isLegacy(mission))
    return typeof shape?.needsLegacyRead === 'function' && shape.needsLegacyRead(mission)
  })
}

/** Ordered registry: entry 0 moves 1 -> 2, entry 1 moves 2 -> 3, and so on. */
export const STATE_MIGRATIONS = Object.freeze([
  Object.freeze({ from: 1, to: 2, migrate: migrateV1ToV2 }),
  Object.freeze({ from: 2, to: 3, migrate: migrateV2ToV3 }),
  Object.freeze({ from: 3, to: 4, migrate: migrateV3ToV4 }),
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
 * touched and the returned document has the target `schemaVersion`. The same
 * `MigrationContext` object reaches every step, so a step may consume a value
 * the loader resolved once (the legacy survey read).
 *
 * @param {Record<string, any>} state
 * @param {{ statePath?: string, to?: number, migrations?: readonly StateMigration[] } & MigrationContext} [options]
 * @returns {{ state: Record<string, any>, from: number, to: number, steps: Array<{ from: number, to: number }> }}
 */
export function migrateState(state, options = {}) {
  const where = options.statePath ? ` at ${options.statePath}` : ''
  const to = options.to ?? SCHEMA_VERSION
  const migrations = options.migrations ?? STATE_MIGRATIONS
  /** @type {MigrationContext} */
  const context = { legacySurveyRead: options.legacySurveyRead }
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
      next = step.migrate(current, context)
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
