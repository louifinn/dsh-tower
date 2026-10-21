// Worktree teardown use case.
//
// #51 two-phase: eligibility diagnostics (ownership, registration, dirty
// state) run outside the state lock; each removal runs its git commands under
// the git lock and is committed in its own short state lock. Every removal
// therefore bumps the state revision exactly once, and the revision is
// revalidated immediately before the irreversible git mutation so a stale
// decision never removes a worktree that changed hands.
import { withLock, withGitLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import { ROSTER_INACTIVE } from '../domain/roster.js'
import { TowerToolError } from '../lib/errors.js'

const STALE = 'tower state changed while teardown was being prepared; retry'

function liveAgent(state, missionId, activity) {
  return (state.roster ?? []).some(
    (entry) => entry.missionId === missionId && !ROSTER_INACTIVE.has(entry.state) && activity[entry.agentId] === 'running',
  )
}

function setDecision(decision, value) {
  const missionId = decision.missionId
  for (const key of Object.keys(decision)) delete decision[key]
  Object.assign(decision, { missionId, ...value })
}

/**
 * Phase 1 (#51): decide every keep/remove outcome without holding the state
 * lock. Removable worktrees become candidates; the returned decision objects
 * stay mutable so the removal outcome can replace them in mission order.
 */
async function prepareTeardown(tower, input) {
  const state = await tower.load()
  const activity = input.activity ?? {}
  const exclude = new Set(input.exclude ?? [])
  const dryRun = input.dryRun === true
  const decisions = []
  const candidates = []

  for (const mission of state.missions) {
    if (!mission.worktree || mission.worktreeRemovedAt) continue
    if (exclude.has(mission.id)) {
      decisions.push({ missionId: mission.id, action: 'keep', reason: 'excluded' })
      continue
    }
    if (liveAgent(state, mission.id, activity)) {
      decisions.push({ missionId: mission.id, action: 'keep', reason: 'live agent' })
      continue
    }
    if (!['merged', 'abandoned'].includes(mission.status)) {
      decisions.push({ missionId: mission.id, action: 'keep', reason: `mission is ${mission.status}` })
      continue
    }
    try {
      await tower.assertWorktree(mission.worktree)
    } catch (error) {
      decisions.push({
        missionId: mission.id,
        action: 'keep',
        reason: `worktree ownership/registration unverified: ${String(error?.message ?? error).slice(0, 240)}`,
      })
      continue
    }
    let dirty = true
    try {
      dirty = !(await tower.isClean(mission.worktree.path))
    } catch {
      dirty = true
    }
    if (dirty && input.force !== true) {
      decisions.push({ missionId: mission.id, action: 'keep', reason: 'uncommitted changes' })
      continue
    }
    if (dryRun) {
      decisions.push({ missionId: mission.id, action: 'remove', reason: 'eligible', forced: dirty })
      continue
    }
    const decision = { missionId: mission.id, action: 'remove', reason: 'eligible', forced: dirty }
    decisions.push(decision)
    candidates.push({ missionId: mission.id, worktree: mission.worktree, decision })
  }

  return { stateRevision: state.revision, decisions, candidates, dryRun }
}

/** Short state lock: reject a stale decision before any git mutation. */
async function claimRemoval(tower, candidate, expectedRevision, input) {
  const activity = input.activity ?? {}
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== expectedRevision) {
      throw new TowerToolError('stale-base', `${STALE}. No worktree was removed.`)
    }
    const mission = state.missions.find((entry) => entry.id === candidate.missionId)
    if (!mission || !mission.worktree || mission.worktreeRemovedAt) return { ok: false, reason: 'worktree is already gone' }
    if (mission.worktree.path !== candidate.worktree.path) return { ok: false, reason: 'worktree path changed during teardown' }
    if (!['merged', 'abandoned'].includes(mission.status)) return { ok: false, reason: `mission is ${mission.status}` }
    if (liveAgent(state, mission.id, activity)) return { ok: false, reason: 'live agent' }
    return { ok: true }
  })
}

export async function teardown(tower, input) {
  const prepared = await prepareTeardown(tower, input)
  if (prepared.dryRun) return { ok: true, dryRun: true, removed: [], decisions: prepared.decisions }

  const removed = []
  let expectedRevision = prepared.stateRevision

  for (const candidate of prepared.candidates) {
    const claim = await claimRemoval(tower, candidate, expectedRevision, input)
    if (!claim.ok) {
      setDecision(candidate.decision, { action: 'keep', reason: claim.reason })
      continue
    }

    // Phase 2 (#51): the irreversible git work runs under the git lock and
    // never under the state lock. Re-read state without the lock right before
    // mutating: the git lock may have waited behind another operation, so a
    // stale candidate is refused while the worktree still exists.
    const outcome = await withGitLock(tower.paths, async () => {
      let fresh
      try {
        fresh = await tower.load()
      } catch (error) {
        return { phase: 'stale', detail: String(error?.message ?? error) }
      }
      if (fresh.revision !== expectedRevision) {
        return { phase: 'stale', detail: `state revision changed from ${expectedRevision} to ${fresh.revision} before the removal` }
      }
      const mission = fresh.missions.find((entry) => entry.id === candidate.missionId)
      if (!mission || !mission.worktree || mission.worktreeRemovedAt) return { phase: 'skip', reason: 'worktree is already gone' }
      if (mission.worktree.path !== candidate.worktree.path) return { phase: 'skip', reason: 'worktree path changed during teardown' }
      if (!['merged', 'abandoned'].includes(mission.status)) return { phase: 'skip', reason: `mission is ${mission.status}` }
      if (liveAgent(fresh, mission.id, input.activity ?? {})) return { phase: 'skip', reason: 'live agent' }
      let dirty = true
      try {
        dirty = !(await tower.isClean(mission.worktree.path))
      } catch {
        dirty = true
      }
      if (dirty && input.force !== true) return { phase: 'skip', reason: 'uncommitted changes' }
      try {
        await tower.git(tower.root, ['worktree', 'remove', ...(dirty ? ['--force'] : []), mission.worktree.path])
      } catch (error) {
        return { phase: 'remove-failed', reason: `remove failed: ${String(error?.message ?? error)}` }
      }
      let branchDeleteError = null
      try {
        await tower.git(tower.root, ['branch', '-d', mission.worktree.branch])
      } catch (error) {
        branchDeleteError = String(error?.message ?? error).slice(0, 240)
      }
      return { phase: 'removed', branch: mission.worktree.branch, branchDeleteError }
    })

    if (outcome.phase === 'stale') {
      throw new TowerToolError('stale-base', `${STALE}: ${outcome.detail}. No worktree was removed.`)
    }
    if (outcome.phase !== 'removed') {
      setDecision(candidate.decision, { action: 'keep', reason: outcome.reason })
      continue
    }

    // Phase 3 (#51): commit this removal alone in a short state lock. The
    // removal already happened, so if a writer landed while git ran we apply
    // the removal on the freshly loaded state instead of rejecting it (which
    // would leave state claiming a worktree that no longer exists). Only this
    // mission's fields change, so no concurrent update is lost.
    const commit = await withLock(tower.paths, async () => {
      const state = await tower.load()
      const mission = state.missions.find((entry) => entry.id === candidate.missionId)
      if (!mission) return { revision: state.revision }
      const now = Date.now()
      mission.worktreeRemovedAt = now
      mission.updatedAt = now
      if (outcome.branchDeleteError) mission.branchDeleteError = outcome.branchDeleteError
      else delete mission.branchDeleteError
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, {
        at: now,
        type: 'teardown',
        missionId: mission.id,
        text: `${outcome.branch}${outcome.branchDeleteError ? ' (branch retained)' : ''}`,
      })
      return { revision: state.revision }
    })
    expectedRevision = commit.revision
    removed.push(candidate.missionId)
    setDecision(candidate.decision, {
      action: 'removed',
      branch: outcome.branch,
      ...(outcome.branchDeleteError ? { branchRetained: true, branchDeleteError: outcome.branchDeleteError } : {}),
    })
  }

  return { ok: true, dryRun: false, removed, decisions: prepared.decisions }
}
