// Rebase use case.
//
// #51 two-phase: long git work runs outside the state lock.
//   prepare (lock-free reads) -> intent (short state lock) -> act (git lock)
//   -> commit (short state lock with revision revalidation).
// The durable `state.rebaseIntent` lets a crash between act and commit be
// reconciled by the next tower_rebase, and `mission.rebase` keeps the
// reviewed-tip waiver semantics the merge gate depends on.
import crypto from 'node:crypto'
import { withLock, withGitLock, gitMutexOptions, writeJsonAtomic, appendJsonl } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import { TowerToolError } from '../domain/errors.js'
import { liveAgentFor } from '../domain/integration/liveness.js'
import {
  alreadyMergedRebaseResult,
  alreadyUpToDateResult,
  ambiguousRebaseIntentMessage,
  buildRebaseIntent,
  classifyRebaseIntent,
  clearedRebaseIntentActivityText,
  dirtyWorktreeResult,
  malformedRebaseIntent,
  rebaseActivityText,
  rebaseConflictNote,
  rebaseConflictResult,
  rebaseReconcileActivityText,
  rebaseReconcileNote,
  rebaseSuccessNote,
  rebaseSuccessResult,
  rebaseTipsMoved,
  rebaseTipsMovedDetail,
  STALE_ACT,
  STALE_PREPARE,
  workerBusyResult,
} from '../domain/integration/rebase.js'

const RECONCILE_ATTEMPTS = 5

function fail(message, code = 'invalid-transition') {
  throw new TowerToolError(code, message)
}

function stale(message) {
  return new TowerToolError('stale-base', message)
}

function findMission(state, missionId) {
  return state.missions.find((entry) => entry.id === missionId)
}

/**
 * Phase 1 (#51): every read needed to decide the rebase — roster liveness,
 * worktree ownership, cleanliness, and both tips — happens without any lock.
 * Returns the snapshot the intent and the commit revalidate against.
 */
async function prepareRebase(tower, input) {
  const state = await tower.load()
  const mission = findMission(state, input.missionId)
  if (!mission) fail(`unknown mission "${input.missionId}"`)
  if (!mission.worktree) fail(`mission ${mission.id} has no worktree to rebase`)
  const activity = input.activity ?? {}
  const busy = liveAgentFor(state, mission.id, activity)
  if (busy) {
    return { early: workerBusyResult(busy) }
  }
  await tower.assertWorktree(mission.worktree)
  if (!(await tower.isClean(mission.worktree.path))) {
    return { early: dirtyWorktreeResult(mission.worktree.path) }
  }
  const oldTip = await tower.revParse(mission.worktree.path, 'HEAD')
  const baseTip = await tower.revParse(tower.root, state.base)
  if (await tower.isAncestor(tower.root, oldTip, baseTip)) {
    // The branch is already contained in the base (manual merge, crashed
    // merge, earlier fast-forward). Rewriting the branch tip to the base
    // would destroy the reviewed tip and the ability to record the merge.
    return { early: alreadyMergedRebaseResult({ oldTip, baseTip, base: state.base }) }
  }
  if (await tower.isAncestor(tower.root, baseTip, oldTip)) {
    return { early: alreadyUpToDateResult({ oldTip, baseTip }) }
  }
  // Count the commits a successful rebase will replay. The count is recorded
  // with the intent so reconciliation can prove a crashed rebase finished
  // instead of guessing from a moved tip.
  let commits = null
  try {
    const count = Number.parseInt(String(await tower.git(mission.worktree.path, ['rev-list', '--count', `${baseTip}..${oldTip}`])).trim(), 10)
    commits = Number.isInteger(count) ? count : null
  } catch {
    commits = null
  }
  return {
    stateRevision: state.revision,
    missionId: mission.id,
    worktree: { path: mission.worktree.path, branch: mission.worktree.branch },
    base: state.base,
    oldTip,
    baseTip,
    commits,
    early: null,
  }
}

/** Inspect a durable intent with lock-free git reads. Never mutates. */
async function inspectRebaseIntent(tower, state, intent) {
  const mission = findMission(state, intent.missionId)
  const worktreePath =
    mission && mission.worktree && typeof mission.worktree.path === 'string' ? mission.worktree.path : null
  if (!worktreePath) {
    return classifyRebaseIntent({ intent, mission, tipReadable: false, baseIsAncestor: false })
  }
  let tip
  try {
    tip = await tower.revParse(worktreePath, 'HEAD')
  } catch {
    return classifyRebaseIntent({ intent, mission, tipReadable: false, baseIsAncestor: false })
  }
  if (tip === intent.oldTip) {
    return classifyRebaseIntent({ intent, mission, tip, tipReadable: true, baseIsAncestor: true })
  }
  if (!(await tower.isAncestor(tower.root, intent.baseTip, tip))) {
    return classifyRebaseIntent({ intent, mission, tip, tipReadable: true, baseIsAncestor: false })
  }
  let actualCommits = null
  if (intent.commits !== null && intent.commits !== undefined) {
    try {
      const raw = await tower.git(worktreePath, ['rev-list', '--count', `${intent.baseTip}..${tip}`])
      actualCommits = Number.parseInt(String(raw).trim(), 10)
    } catch {
      actualCommits = null
    }
  }
  return classifyRebaseIntent({ intent, mission, tip, tipReadable: true, baseIsAncestor: true, actualCommits })
}

/**
 * Reconcile a rebase intent left behind by a crash between act and commit.
 * The two unambiguous outcomes (the branch never moved, or the rebase landed
 * with the expected commit count) are committed; anything else keeps the
 * marker and refuses rather than guessing.
 */
async function reconcileRebaseIntent(tower) {
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt += 1) {
    const snapshot = await tower.load()
    const intent = snapshot.rebaseIntent
    if (!intent) return
    if (malformedRebaseIntent(intent)) {
      throw stale('a rebase intent in tower state is malformed; inspect it and retry')
    }
    const inspection = await inspectRebaseIntent(tower, snapshot, intent)
    if (inspection.action === 'ambiguous') {
      throw stale(ambiguousRebaseIntentMessage(intent, inspection.tip))
    }
    const applied = await withLock(tower.paths, async () => {
      const state = await tower.load()
      if (state.revision !== snapshot.revision) return false
      const current = state.rebaseIntent
      if (!current || current.token !== intent.token) return true
      const now = Date.now()
      const mission = findMission(state, intent.missionId)
      delete state.rebaseIntent
      state.revision += 1
      state.updatedAt = now
      if (inspection.action === 'record' && mission) {
        const tip = /** @type {string} */ (inspection.tip)
        mission.rebase = { at: now, oldTip: intent.oldTip, newTip: tip, baseTip: intent.baseTip }
        if (mission.status === 'blocked') mission.status = 'active'
        mission.notes.push(rebaseReconcileNote({ oldTip: intent.oldTip, newTip: tip, baseTip: intent.baseTip }))
        mission.updatedAt = now
      }
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, {
        at: now,
        type: 'rebase',
        missionId: intent.missionId,
        text:
          inspection.action === 'record'
            ? rebaseReconcileActivityText({
                oldTip: intent.oldTip,
                newTip: /** @type {string} */ (inspection.tip),
                baseTip: intent.baseTip,
              })
            : clearedRebaseIntentActivityText(inspection.reason),
      })
      return true
    })
    if (applied) return
  }
  throw stale('tower state kept changing while reconciling a pending rebase intent; retry')
}

export async function rebase(tower, input) {
  await reconcileRebaseIntent(tower)
  const prepared = await prepareRebase(tower, input)
  if (prepared.early) return prepared.early
  const worktree = /** @type {{ path: string, branch: string }} */ (prepared.worktree)

  // Record the intent before touching Git: a crash between the rebase and the
  // commit leaves a durable marker instead of an unexplained moved branch.
  const token = crypto.randomUUID()
  const startedAt = Date.now()
  const intentRevision = await withLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== prepared.stateRevision) throw stale(STALE_PREPARE)
    const mission = findMission(state, prepared.missionId)
    if (!mission) throw new TowerToolError('mission-not-found', `unknown mission "${prepared.missionId}"`)
    if (!mission.worktree) fail(`mission ${mission.id} has no worktree to rebase`)
    state.rebaseIntent = buildRebaseIntent({
      token,
      missionId: mission.id,
      base: prepared.base,
      oldTip: prepared.oldTip,
      baseTip: prepared.baseTip,
      commits: prepared.commits ?? null,
      startedAt,
    })
    state.revision += 1
    state.updatedAt = startedAt
    await writeJsonAtomic(tower.paths.state, state)
    return state.revision
  })

  // Phase 2 (#51): the long git work runs under the git lock and never under
  // the state lock. Re-verify the snapshot right before rewriting the branch.
  const outcome = await withGitLock(tower.paths, async () => {
    const currentTip = await tower.revParse(worktree.path, 'HEAD')
    const currentBase = await tower.revParse(tower.root, prepared.base)
    if (rebaseTipsMoved({ oldTip: prepared.oldTip, baseTip: prepared.baseTip, currentTip, currentBase })) {
      return {
        phase: 'stale',
        detail: rebaseTipsMovedDetail({
          oldTip: prepared.oldTip,
          baseTip: prepared.baseTip,
          currentTip,
          currentBase,
        }),
      }
    }
    try {
      await tower.git(worktree.path, ['rebase', prepared.baseTip])
    } catch (error) {
      await tower.git(worktree.path, ['rebase', '--abort']).catch(() => {})
      return { phase: 'conflict', detail: String(error?.message ?? error) }
    }
    const newTip = await tower.revParse(worktree.path, 'HEAD')
    return { phase: 'done', newTip }
  }, gitMutexOptions(tower, { phase: 'rebase' }))

  // Phase 3 (#51): re-read state and revalidate the revision computed by the
  // intent write; the lock only holds the state mutation, never a subprocess.
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== intentRevision) throw stale(STALE_ACT)
    const mission = findMission(state, prepared.missionId)
    if (!mission) throw new TowerToolError('mission-not-found', `unknown mission "${prepared.missionId}"`)
    const intent = state.rebaseIntent
    if (!intent || intent.token !== token) throw stale(STALE_ACT)
    const now = Date.now()

    if (outcome.phase === 'stale') {
      delete state.rebaseIntent
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      throw stale(outcome.detail)
    }

    if (outcome.phase === 'conflict') {
      delete state.rebaseIntent
      mission.status = 'blocked'
      mission.blockers.push(rebaseConflictNote(prepared.base, prepared.baseTip))
      mission.updatedAt = now
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, { at: now, type: 'rebase', missionId: mission.id, text: 'conflict' })
      return rebaseConflictResult(outcome.detail)
    }

    const { newTip } = outcome
    delete state.rebaseIntent
    mission.rebase = { at: now, oldTip: prepared.oldTip, newTip, baseTip: prepared.baseTip }
    if (mission.status === 'blocked') mission.status = 'active'
    mission.notes.push(
      rebaseSuccessNote({ oldTip: prepared.oldTip, newTip, baseTip: prepared.baseTip }),
    )
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'rebase',
      missionId: mission.id,
      text: rebaseActivityText({ oldTip: prepared.oldTip, newTip, baseTip: prepared.baseTip }),
    })
    return rebaseSuccessResult({ oldTip: prepared.oldTip, newTip, baseTip: prepared.baseTip })
  })
}
