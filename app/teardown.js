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
import { TowerToolError } from '../domain/errors.js'
import { hasLiveAgent } from '../domain/integration/liveness.js'
import {
  ownershipUnverifiedDecision,
  replaceDecision as setDecision,
  revalidateTeardownCandidate,
  STALE_TEARDOWN as STALE,
  teardownActivityText,
  teardownDirtyDecision,
  teardownPrecheck,
  teardownRemoveDecision,
  teardownRemovedDecision,
} from '../domain/integration/teardown.js'
import { sweepArchive } from './archive.js'

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
    const precheck = teardownPrecheck(mission, {
      excluded: exclude.has(mission.id),
      hasLiveAgent: hasLiveAgent(state, mission.id, activity),
    })
    if ('skip' in precheck) continue
    if ('decision' in precheck) {
      decisions.push(precheck.decision)
      continue
    }
    try {
      await tower.assertWorktree(mission.worktree)
    } catch (error) {
      decisions.push(ownershipUnverifiedDecision(mission.id, error))
      continue
    }
    let dirty = true
    try {
      dirty = !(await tower.isClean(mission.worktree.path))
    } catch {
      dirty = true
    }
    const dirtyKeep = teardownDirtyDecision(dirty, input.force)
    if (dirtyKeep) {
      decisions.push({ missionId: mission.id, ...dirtyKeep })
      continue
    }
    if (dryRun) {
      decisions.push({ missionId: mission.id, ...teardownRemoveDecision(dirty) })
      continue
    }
    const decision = { missionId: mission.id, ...teardownRemoveDecision(dirty) }
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
    return revalidateTeardownCandidate(state, candidate, activity)
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
      const current = revalidateTeardownCandidate(fresh, candidate, input.activity ?? {})
      if (!current.ok) return { phase: 'skip', reason: current.reason }
      const mission = current.mission
      const worktree = mission.worktree
      if (!worktree) return { phase: 'skip', reason: 'worktree is already gone' }
      let dirty = true
      try {
        dirty = !(await tower.isClean(worktree.path))
      } catch {
        dirty = true
      }
      const dirtyKeep = teardownDirtyDecision(dirty, input.force)
      if (dirtyKeep) return { phase: 'skip', reason: dirtyKeep.reason }
      try {
        await tower.git(tower.root, ['worktree', 'remove', ...(dirty ? ['--force'] : []), worktree.path])
      } catch (error) {
        return { phase: 'remove-failed', reason: `remove failed: ${String(error?.message ?? error)}` }
      }
      let branchDeleteError = null
      try {
        await tower.git(tower.root, ['branch', '-d', worktree.branch])
      } catch (error) {
        branchDeleteError = String(error?.message ?? error).slice(0, 240)
      }
      return { phase: 'removed', branch: worktree.branch, branchDeleteError }
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
        text: teardownActivityText(outcome.branch, outcome.branchDeleteError),
      })
      return { revision: state.revision }
    })
    expectedRevision = commit.revision
    removed.push(candidate.missionId)
    setDecision(candidate.decision, teardownRemovedDecision(outcome))
  }

  // Archival runs under one final short lock. It is policy-driven (age or the
  // hot-terminal cap), so a mission torn down a moment ago stays hot until it
  // is old enough; `archive.afterDays: 0` archives it on this call.
  const archive = await withLock(tower.paths, async () => {
    const state = await tower.load()
    const swept = await sweepArchive(tower, state, { now: Date.now(), activity: input.activity ?? {} })
    if (swept.written) {
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
    }
    return swept
  })

  return {
    ok: true,
    dryRun: false,
    removed,
    decisions: prepared.decisions,
    archived: archive.archived,
    ...(archive.error ? { archiveError: archive.error } : {}),
  }
}
