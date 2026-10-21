// Rebase use case.
//
// #51 two-phase: long git work runs outside the state lock.
//   prepare (lock-free reads) -> intent (short state lock) -> act (git lock)
//   -> commit (short state lock with revision revalidation).
// The durable `state.rebaseIntent` lets a crash between act and commit be
// reconciled by the next tower_rebase, and `mission.rebase` keeps the
// reviewed-tip waiver semantics the merge gate depends on.
import crypto from 'node:crypto'
import { withLock, withGitLock, writeJsonAtomic, appendJsonl } from '../store.js'
import { validateState } from '../domain/state.js'
import { ROSTER_INACTIVE } from '../domain/roster.js'
import { TowerToolError } from '../errors.js'

const RECONCILE_ATTEMPTS = 5
const STALE_PREPARE = 'tower state changed while the rebase was being prepared; retry'
const STALE_ACT =
  'tower state changed while the rebase was running; the rebase intent is retained so the next tower_rebase can reconcile it; retry'

function fail(message, code = 'invalid-transition') {
  throw new TowerToolError(code, message)
}

function stale(message) {
  return new TowerToolError('stale-base', message)
}

function findMission(state, missionId) {
  return state.missions.find((entry) => entry.id === missionId)
}

function short(tip) {
  return String(tip ?? '').slice(0, 7)
}

function liveAgent(state, missionId, activity) {
  return (state.roster ?? []).find(
    (entry) => entry.missionId === missionId && !ROSTER_INACTIVE.has(entry.state) && activity[entry.agentId] === 'running',
  )
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
  const busy = liveAgent(state, mission.id, activity)
  if (busy) {
    return { early: { ok: false, blockers: [{ code: 'worker-busy', detail: `agent ${busy.name} is running; rebase refused` }] } }
  }
  await tower.assertWorktree(mission.worktree)
  if (!(await tower.isClean(mission.worktree.path))) {
    return { early: { ok: false, blockers: [{ code: 'worktree-dirty', detail: `${mission.worktree.path} has uncommitted changes` }] } }
  }
  const oldTip = await tower.revParse(mission.worktree.path, 'HEAD')
  const baseTip = await tower.revParse(tower.root, state.base)
  if (await tower.isAncestor(tower.root, oldTip, baseTip)) {
    // The branch is already contained in the base (manual merge, crashed
    // merge, earlier fast-forward). Rewriting the branch tip to the base
    // would destroy the reviewed tip and the ability to record the merge.
    return {
      early: {
        ok: true,
        alreadyMerged: true,
        skipped: true,
        oldTip,
        newTip: oldTip,
        baseTip,
        note: `${oldTip.slice(0, 7)} is already contained in ${state.base} ${baseTip.slice(0, 7)}; branch left untouched — call tower_merge to record the landed merge`,
      },
    }
  }
  if (await tower.isAncestor(tower.root, baseTip, oldTip)) {
    return { early: { ok: true, alreadyUpToDate: true, oldTip, newTip: oldTip, baseTip } }
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
  if (!mission || !mission.worktree || typeof mission.worktree.path !== 'string') {
    return { action: 'clear', reason: 'the mission has no worktree' }
  }
  let tip
  try {
    tip = await tower.revParse(mission.worktree.path, 'HEAD')
  } catch {
    return { action: 'clear', reason: 'the worktree is not readable' }
  }
  if (tip === intent.oldTip) {
    return { action: 'clear', reason: 'the branch tip is unchanged (the rebase never ran)' }
  }
  if (!(await tower.isAncestor(tower.root, intent.baseTip, tip))) {
    return { action: 'ambiguous', tip }
  }
  if (intent.commits !== null && intent.commits !== undefined) {
    let count = null
    try {
      const raw = await tower.git(mission.worktree.path, ['rev-list', '--count', `${intent.baseTip}..${tip}`])
      count = Number.parseInt(String(raw).trim(), 10)
    } catch {
      count = null
    }
    if (count !== Number(intent.commits)) return { action: 'ambiguous', tip }
  }
  return { action: 'record', tip }
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
    if (typeof intent !== 'object' || typeof intent.missionId !== 'string' || typeof intent.token !== 'string') {
      throw stale('a rebase intent in tower state is malformed; inspect it and retry')
    }
    const inspection = await inspectRebaseIntent(tower, snapshot, intent)
    if (inspection.action === 'ambiguous') {
      throw stale(
        `a rebase intent for ${intent.missionId} from ${new Date(Number(intent.startedAt) || 0).toISOString()} is pending and cannot be reconciled automatically (tip ${short(inspection.tip)} does not match the prepared snapshot); finish or abort the rebase in that worktree, then retry`,
      )
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
        mission.rebase = { at: now, oldTip: intent.oldTip, newTip: inspection.tip, baseTip: intent.baseTip }
        if (mission.status === 'blocked') mission.status = 'active'
        mission.notes.push(
          `reconciled interrupted rebase ${short(intent.oldTip)} -> ${short(inspection.tip)} onto ${short(intent.baseTip)}; the clean rebase waiver is preserved`,
        )
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
            ? `reconciled ${short(intent.oldTip)} -> ${short(inspection.tip)} onto ${short(intent.baseTip)}`
            : `cleared a stale rebase intent (${inspection.reason})`,
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
    state.rebaseIntent = {
      token,
      missionId: mission.id,
      base: prepared.base,
      oldTip: prepared.oldTip,
      baseTip: prepared.baseTip,
      commits: prepared.commits,
      startedAt,
    }
    state.revision += 1
    state.updatedAt = startedAt
    await writeJsonAtomic(tower.paths.state, state)
    return state.revision
  })

  // Phase 2 (#51): the long git work runs under the git lock and never under
  // the state lock. Re-verify the snapshot right before rewriting the branch.
  const outcome = await withGitLock(tower.paths, async () => {
    const currentTip = await tower.revParse(prepared.worktree.path, 'HEAD')
    const currentBase = await tower.revParse(tower.root, prepared.base)
    if (currentTip !== prepared.oldTip || currentBase !== prepared.baseTip) {
      return {
        phase: 'stale',
        detail: `tips moved after preparation (${short(prepared.oldTip)}/${short(prepared.baseTip)} -> ${short(currentTip)}/${short(currentBase)}), so nothing was rebased`,
      }
    }
    try {
      await tower.git(prepared.worktree.path, ['rebase', prepared.baseTip])
    } catch (error) {
      await tower.git(prepared.worktree.path, ['rebase', '--abort']).catch(() => {})
      return { phase: 'conflict', detail: String(error?.message ?? error) }
    }
    const newTip = await tower.revParse(prepared.worktree.path, 'HEAD')
    return { phase: 'done', newTip }
  })

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
      mission.blockers.push(`rebase conflict onto ${prepared.base} @ ${prepared.baseTip.slice(0, 12)}`)
      mission.updatedAt = now
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, { at: now, type: 'rebase', missionId: mission.id, text: 'conflict' })
      return { ok: false, blockers: [{ code: 'rebase-conflict', detail: outcome.detail }] }
    }

    const { newTip } = outcome
    delete state.rebaseIntent
    mission.rebase = { at: now, oldTip: prepared.oldTip, newTip, baseTip: prepared.baseTip }
    if (mission.status === 'blocked') mission.status = 'active'
    mission.notes.push(
      `rebased ${short(prepared.oldTip)} -> ${short(newTip)} onto ${short(prepared.baseTip)}; conflict-free rebase waives re-review`,
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
      text: `${short(prepared.oldTip)} -> ${short(newTip)} onto ${short(prepared.baseTip)}`,
    })
    return { ok: true, oldTip: prepared.oldTip, newTip, baseTip: prepared.baseTip, reviewWaived: true }
  })
}
