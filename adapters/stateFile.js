// State-file load path: schema-version inspection, migration, and the one
// persisted migration result (#72).
//
// The domain stays pure: `prepareState` classifies, transforms and validates the
// document. This module owns the disk effects, and it persists them only while
// the caller holds the state lock, so a reader can never rewrite a document a
// concurrent writer is about to change. A read-only load still migrates in
// memory; the next locked write persists that migration once.
//
// Ordering mirrors the protocol contract:
//   1. classify the version (a newer document is refused before any write);
//   2. write the pre-migration backup;
//   3. migrate in memory and validate the target schema;
//   4. atomically replace state.json, bump `revision` once, append
//      `state.migrated {from,to}` to the activity log.
// A migration that throws therefore leaves state.json byte-identical.
import { inspectStateVersion, prepareState } from '../domain/state.js'
import { isStateLockHeld } from './store.js'

/**
 * @typedef {object} StateLoadResult
 * @property {import('../types/index.js').TowerState} state
 * @property {ReturnType<typeof inspectStateVersion>} version
 * @property {null | {
 *   from: number, to: number, steps: Array<{ from: number, to: number }>,
 *   persisted: boolean, backupPath: string|null,
 * }} migration
 */

/**
 * Read `paths.state`, migrate it when it is older than this build, and (only
 * while the state lock is held) persist that migration.
 *
 * @param {{
 *   store: any,
 *   paths: any,
 *   now?: number,
 *   persist?: boolean,
 *   migrations?: readonly import('../domain/state/migrations.js').StateMigration[],
 * }} input
 * @returns {Promise<StateLoadResult>}
 */
export async function loadStateFile(input) {
  const { store, paths, migrations } = input
  const now = input.now ?? Date.now()
  const raw = await store.readJson(paths.state)
  const version = inspectStateVersion(raw, paths.state, migrations)
  const persist = input.persist ?? isStateLockHeld(paths)
  const backupPath = `${paths.state}.v${String(version.currentVersion ?? 'unknown')}.bak`

  // Backup before the original can change. `prepareState` is pure, so a
  // throwing migration cannot touch state.json whether or not this ran.
  if (persist && version.status === 'migratable') {
    await store.writeJsonAtomic(backupPath, raw)
  }

  const prepared = prepareState(raw, paths.state, { migrations })
  if (!prepared.changed) {
    return { state: prepared.state, version, migration: null }
  }

  if (!persist) {
    return {
      state: prepared.state,
      version,
      migration: {
        from: prepared.from,
        to: prepared.to,
        steps: prepared.migrated,
        persisted: false,
        backupPath: null,
      },
    }
  }

  const baseRevision =
    Number.isInteger(prepared.state.revision) && prepared.state.revision >= 0 ? prepared.state.revision : 0
  const migrated = { ...prepared.state, revision: baseRevision + 1, updatedAt: now }
  await store.writeJsonAtomic(paths.state, migrated)
  await store.appendJsonl(paths.activity, {
    at: now,
    type: 'state.migrated',
    from: prepared.from,
    to: prepared.to,
    revision: migrated.revision,
    text: `schema v${prepared.from} -> v${prepared.to}`,
  })
  return {
    state: migrated,
    version,
    migration: {
      from: prepared.from,
      to: prepared.to,
      steps: prepared.migrated,
      persisted: true,
      backupPath,
    },
  }
}
