// Pure state-file validation and migration decisions (#56 P4, #72).
//
// The structural contract lives in `state/schema.js` (TypeBox), the policy
// checks in `state/semantics.js`, and the version registry in
// `state/migrations.js`. This module stays the public entry point so every
// app/tool import of `domain/state.js` is unchanged.
//
// `validateState` proves a document matches the *current* schema.
// `prepareState` is the load-path decision: it inspects the version, applies the
// ordered migration registry, then validates the target schema. Both are pure;
// the side effects (backup, write, activity) live in `lib/stateFile.js`.
// @ts-check
import { TowerToolError } from './errors.js'
import { SCHEMA_VERSION } from './mission.js'
import { migrationChain, migrateState } from './state/migrations.js'
import { stateShapeError } from './state/schema.js'
import { assertStateSemantics } from './state/semantics.js'

/** @typedef {import('../types/index.js').TowerState} TowerState */
/** @typedef {{ from: number, to: number }} MigrationStep */
/** @typedef {import('./state/migrations.js').StateMigration} StateMigration */

export { StateSchema, stateShapeError } from './state/schema.js'

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Classify a document's `schemaVersion` without throwing. This is the read path
 * doctor uses, so it must stay usable on a repository that cannot load.
 * @param {unknown} state
 * @param {string} [statePath]
 * @param {readonly StateMigration[]} [migrations] registry to classify against
 * @returns {{
 *   status: 'current'|'migratable'|'newer'|'unmigratable'|'invalid',
 *   currentVersion: number|null,
 *   supportedVersion: number,
 *   migrations: MigrationStep[],
 *   message?: string,
 * }}
 */
export function inspectStateVersion(state, statePath, migrations) {
  const where = statePath ? ` at ${statePath}` : ''
  if (!isPlainObject(state)) {
    return {
      status: 'invalid',
      currentVersion: null,
      supportedVersion: SCHEMA_VERSION,
      migrations: [],
      message: `tower state is not an object${where}`,
    }
  }
  const version = /** @type {Record<string, any>} */ (state).schemaVersion
  if (!Number.isInteger(version) || version < 1) {
    return {
      status: 'invalid',
      currentVersion: null,
      supportedVersion: SCHEMA_VERSION,
      migrations: [],
      message: `tower state has no usable schemaVersion (${JSON.stringify(version)})${where}`,
    }
  }
  if (version === SCHEMA_VERSION) {
    return { status: 'current', currentVersion: version, supportedVersion: SCHEMA_VERSION, migrations: [] }
  }
  if (version > SCHEMA_VERSION) {
    return { status: 'newer', currentVersion: version, supportedVersion: SCHEMA_VERSION, migrations: [] }
  }
  const chain = migrationChain(version, SCHEMA_VERSION, migrations)
  if (!chain) {
    return { status: 'unmigratable', currentVersion: version, supportedVersion: SCHEMA_VERSION, migrations: [] }
  }
  return {
    status: 'migratable',
    currentVersion: version,
    supportedVersion: SCHEMA_VERSION,
    migrations: chain.map((step) => ({ from: step.from, to: step.to })),
  }
}

/**
 * @param {{ status: string, currentVersion: number|null, supportedVersion: number, message?: string }} info
 * @param {string} [statePath]
 * @returns {TowerToolError}
 */
function versionError(info, statePath) {
  const where = statePath ? ` at ${statePath}` : ''
  if (info.status === 'newer') {
    return new TowerToolError(
      'state-version-unsupported',
      `tower state${where} has schemaVersion ${info.currentVersion}, but this build supports ${info.supportedVersion}: it was written by a newer dsh-tower and will not be downgraded`,
      {
        nextAction: `upgrade dsh-tower to a release that supports state schemaVersion ${info.currentVersion}; the file was left untouched`,
      },
    )
  }
  if (info.status === 'migratable') {
    return new TowerToolError(
      'state-version-unsupported',
      `tower state${where} has schemaVersion ${info.currentVersion}; load it through the state loader to migrate it to ${info.supportedVersion}`,
      { nextAction: 'call any tower tool; mutations apply the migration under the state lock' },
    )
  }
  if (info.status === 'unmigratable') {
    return new TowerToolError(
      'state-version-unsupported',
      `tower state${where} has schemaVersion ${info.currentVersion}, which has no migration to ${info.supportedVersion}`,
      {
        nextAction: `restore a state.json written by dsh-tower ${info.supportedVersion}; this build will not guess at an unknown schema`,
      },
    )
  }
  return new TowerToolError('state-corrupt', info.message ?? `tower state is not usable${where}`)
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new TowerToolError('state-corrupt', message)
}

/**
 * Prove a document matches the current schema. Any other version is rejected
 * with a version error rather than corruption; the load path migrates first.
 * @param {unknown} state
 * @param {string} [statePath]
 * @returns {TowerState}
 */
export function validateState(state, statePath) {
  const info = inspectStateVersion(state, statePath)
  if (info.status !== 'current') throw versionError(info, statePath)
  const where = statePath ? ` at ${statePath}` : ''
  const shapeError = stateShapeError(state, where)
  if (shapeError) fail(shapeError)
  return assertStateSemantics(state, where)
}

/**
 * The pure load-path decision: migrate an older document through the registry,
 * validate the result against the target schema, then report what happened. The
 * returned state is the validated migrated document; the caller decides whether
 * to persist it (only while holding the state lock).
 *
 * @param {unknown} state
 * @param {string} [statePath]
 * @param {{ migrations?: readonly StateMigration[] }} [options]
 * @returns {{ state: TowerState, from: number, to: number, migrated: MigrationStep[], changed: boolean }}
 */
export function prepareState(state, statePath, options = {}) {
  const info = inspectStateVersion(state, statePath, options.migrations)
  if (info.status === 'current') {
    return {
      state: validateState(state, statePath),
      from: SCHEMA_VERSION,
      to: SCHEMA_VERSION,
      migrated: [],
      changed: false,
    }
  }
  if (info.status !== 'migratable') throw versionError(info, statePath)
  const outcome = migrateState(/** @type {Record<string, any>} */ (state), {
    statePath,
    to: info.supportedVersion,
    migrations: options.migrations,
  })
  // Validation runs on the *target* document: a shape that was invalid under
  // the old schema (a missing `tasks` array, say) may be valid after a backfill,
  // and validating the target is what proves the migration did its job.
  return {
    state: validateState(outcome.state, statePath),
    from: outcome.from,
    to: outcome.to,
    migrated: outcome.steps,
    changed: true,
  }
}
