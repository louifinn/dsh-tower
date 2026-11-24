// Mission lifecycle update use case.
import { TowerToolError } from '../domain/errors.js'
import { applyMissionUpdate } from '../domain/missions/lifecycle.js'
import { baseMismatchMessage } from '../domain/vocabulary.js'
import { validateState } from '../domain/state.js'
import { fullMission } from '../domain/summary.js'
import { sweepArchive } from './archive.js'
import { cleanupSandbox } from './sandbox.js'
function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export async function updateMission(tower, input = {}) {
  const missionId = typeof input.id === 'string' ? input.id.trim() : input.id
  if (typeof missionId !== 'string' || missionId.length === 0) fail('tower_mission requires id')
  const result = await tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === missionId)
    if (!mission) fail(`unknown mission "${missionId}"`, 'mission-not-found')
    const { changes, events, widen } = applyMissionUpdate({ mission, state, input, config: tower.config })
    const now = Date.now()
    mission.updatedAt = now
    await sweepArchive(tower, state, { now })
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    await tower.appendActivity({
      at: now,
      type: 'mission',
      missionId: mission.id,
      text: changes.join('; '),
    })
    // #219: a widen that deferred or restored a neighbour touched that mission
    // too, so it gets its own activity entry even though the whole call is one
    // revision bump.
    if (widen) {
      for (const id of widen.deferred) {
        await tower.appendActivity({
          at: now,
          type: 'mission',
          missionId: id,
          text: `deferred by widen of ${mission.id}`,
        })
      }
      for (const id of widen.restored) {
        await tower.appendActivity({
          at: now,
          type: 'mission',
          missionId: id,
          text: `deferral restored by ${mission.id}`,
        })
      }
    }
    tower.emitEvents(events, { revision: state.revision, at: now })
    return { revision: state.revision, mission: fullMission(mission), ...(widen ? { widen } : {}) }
  })
  // Abandoning a detached survey disposes its sandbox. The state transition is
  // already durable; cleanup is advisory and reports rather than throws.
  let sandboxCleanup = null
  if (result.mission.status === 'abandoned' && result.mission.sandbox) {
    const sandbox = result.mission.sandbox
    try {
      sandboxCleanup = await cleanupSandbox(tower, missionId)
    } catch (error) {
      sandboxCleanup = {
        ok: false,
        removed: false,
        attempts: 0,
        path: sandbox,
        error: String(error?.message ?? error).slice(0, 400),
      }
    }
    if (sandboxCleanup?.ok) {
      delete result.mission.sandbox
      delete result.mission.sandboxCleanupError
    }
  }
  return { ...result, ...(sandboxCleanup ? { sandboxCleanup } : {}) }
}

/**
 * #215: the live HEAD label, read from git on every call. `tower.branch` is
 * captured when the Tower opens and is stale after an in-session checkout.
 * @param {any} tower
 * @returns {Promise<{ head: string | null, headDetached: boolean }>}
 */
export async function readHeadView(tower) {
  const branch = await tower.tryGit(tower.root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const name = typeof branch === 'string' ? branch.trim() : ''
  if (name.length > 0) return { head: name, headDetached: false }
  try {
    return { head: await tower.revParse(tower.root, 'HEAD'), headDetached: true }
  } catch {
    return { head: null, headDetached: false }
  }
}

/**
 * #215: fail closed when the checkout is not on `state.base`. Planning or
 * spawning from another branch would cut worktrees from one tip while the
 * recorded base points at another, so the refusal names both sides and the two
 * ways out instead of letting the inconsistency surface later at merge time.
 * @param {any} tower
 * @param {string} [action]
 */
export async function assertBaseCheckout(tower, action = 'this operation') {
  const state = await tower.load()
  const { head, headDetached } = await readHeadView(tower)
  // A store without a git worktree (the in-memory adapter used by scope
  // planning) cannot report HEAD, so the recorded base stays authoritative:
  // there is no checkout to compare against.
  if (head === null || head === state.base) return
  throw new TowerToolError(
    'base-mismatch',
    baseMismatchMessage({ base: state.base, head, detached: headDetached, action }),
  )
}

/**
 * Advisory sandbox disposal after an abandoning update. The state transition is
 * already durable; cleanup reports rather than throws and the returned mission
 * loses `sandbox` only when removal succeeded (same contract as the single form).
 * @param {any} tower
 * @param {any} mission
 * @returns {Promise<any | null>}
 */
async function cleanupAbandonedSandbox(tower, mission) {
  if (mission?.status !== 'abandoned' || !mission.sandbox) return null
  const sandbox = mission.sandbox
  let sandboxCleanup
  try {
    sandboxCleanup = await cleanupSandbox(tower, mission.id)
  } catch (error) {
    sandboxCleanup = {
      ok: false,
      removed: false,
      attempts: 0,
      path: sandbox,
      error: String(error?.message ?? error).slice(0, 400),
    }
  }
  if (sandboxCleanup?.ok) {
    delete mission.sandbox
    delete mission.sandboxCleanupError
  }
  return sandboxCleanup
}

/**
 * #216: apply the bulk `tower_mission` form. `atomic:true` (the default) runs
 * every item against one cloned draft under one state lock and writes once, so
 * any failure leaves `state.json` byte-identical; `atomic:false` applies items
 * in order through the single form, keeps going after a failure, and reports
 * each item. Either way one `mission.bulk` activity record is appended.
 * @param {any} tower
 * @param {{ atomic: boolean, items: Array<{ id: string, fields: Record<string, any>, unverified?: any }>, actor?: any }} batch
 */
export async function updateMissionBatch(tower, batch) {
  if (batch.atomic) return atomicMissionBatch(tower, batch)
  return sequentialMissionBatch(tower, batch)
}

/**
 * @param {any} tower
 * @param {{ items: Array<{ id: string, fields: Record<string, any> }>, actor?: any }} batch
 */
async function atomicMissionBatch(tower, batch) {
  const applied = await tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    const draft = structuredClone(state)
    const now = Date.now()
    /** @type {Array<{ mission: any, changes: string[], events: any[] }>} */
    const entries = []
    for (const item of batch.items) {
      const mission = draft.missions.find((entry) => entry.id === item.id)
      if (!mission) fail(`unknown mission "${item.id}"`, 'mission-not-found')
      const { changes, events } = applyMissionUpdate({
        mission,
        state: draft,
        input: { ...item.fields, id: item.id, actor: batch.actor },
        config: tower.config,
      })
      mission.updatedAt = now
      entries.push({ mission, changes, events })
    }
    await sweepArchive(tower, draft, { now })
    draft.revision += 1
    draft.updatedAt = now

    validateState(draft, tower.paths.state)
    await tower.writeState(draft, held)
    for (const entry of entries) {
      await tower.appendActivity({
        at: now,
        type: 'mission',
        missionId: entry.mission.id,
        text: entry.changes.join('; '),
      })
    }
    await tower.appendActivity({
      at: now,
      type: 'mission.bulk',
      text: `bulk mission update (atomic): ${entries.map((entry) => entry.mission.id).join(', ')}`,
    })
    tower.emitEvents(entries.flatMap((entry) => entry.events), { revision: draft.revision, at: now })
    return {
      revision: draft.revision,
      atomic: true,
      missions: entries.map((entry) => fullMission(entry.mission)),
      results: entries.map((entry) => ({ id: entry.mission.id, ok: true, changes: entry.changes })),
    }
  })
  for (const result of applied.results) {
    const mission = applied.missions.find((entry) => entry.id === result.id)
    const sandboxCleanup = await cleanupAbandonedSandbox(tower, mission)
    if (sandboxCleanup) result.sandboxCleanup = sandboxCleanup
  }
  return applied
}

/**
 * @param {any} tower
 * @param {{ items: Array<{ id: string, fields: Record<string, any> }>, actor?: any }} batch
 */
async function sequentialMissionBatch(tower, batch) {
  /** @type {Array<Record<string, any>>} */
  const results = []
  /** @type {any[]} */
  const missions = []
  let revision = null
  for (const item of batch.items) {
    try {
      const updated = await updateMission(tower, { ...item.fields, id: item.id, actor: batch.actor })
      revision = updated.revision
      missions.push(updated.mission)
      results.push({ id: item.id, ok: true, mission: updated.mission })
    } catch (error) {
      results.push({
        id: item.id,
        ok: false,
        error: String(error?.message ?? error).slice(0, 400),
        code: typeof error?.code === 'string' ? error.code : 'tool-internal',
      })
    }
  }
  if (revision === null) revision = (await tower.load()).revision
  const succeeded = results.filter((entry) => entry.ok).map((entry) => entry.id)
  const failed = results.filter((entry) => !entry.ok).map((entry) => entry.id)
  await tower.appendActivity({
    at: Date.now(),
    type: 'mission.bulk',
    text: `bulk mission update (partial): ${succeeded.length > 0 ? succeeded.join(', ') : 'none'}; failed: ${failed.length > 0 ? failed.join(', ') : 'none'}`,
  })
  return { revision, atomic: false, missions, results }
}
