// Worktree teardown use case.
//
// #51 two-phase: eligibility diagnostics (ownership, registration, dirty
// state) run outside the state lock; each removal runs its git commands under
// the git lock and is committed in its own short state lock. Every removal
// therefore bumps the state revision exactly once, and the revision is
// revalidated immediately before the irreversible git mutation so a stale
// decision never removes a worktree that changed hands.
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
import { cleanupSandbox } from './sandbox.js'
import { cleanupReviewCheckout } from './reviewCheckout.js'

/**
 * Disposable review checkouts (#149 W3). A reviewer works in a detached checkout
 * at its recorded review commit and the checkout is removed when the verdict is
 * recorded; a failed spawn or an interrupted reviewer leaves it behind, so
 * teardown retries the bounded removal and clears the recorded path. A checkout
 * whose reviewer is still active is kept. This runs before the worktree phase so
 * its state revisions never invalidate the worktree claims.
 * @param {any} tower
 * @param {any} input
 * @returns {Promise<{ decisions: any[], removed: string[] }>}
 */
async function teardownReviewCheckouts(tower, input) {
  const state = await tower.load()
  const exclude = new Set(input.exclude ?? [])
  const decisions = []
  const removed = []
  for (const entry of state.roster ?? []) {
    const checkout = typeof entry.reviewCheckout === 'string' ? entry.reviewCheckout : null
    if (!checkout) continue
    const row = { name: entry.name, missionId: entry.missionId ?? null, checkout }
    if (exclude.has(entry.missionId)) {
      decisions.push({ ...row, action: 'keep', reason: 'excluded' })
      continue
    }
    if (entry.state === 'active') {
      decisions.push({ ...row, action: 'keep', reason: 'reviewer is active' })
      continue
    }
    if (input.dryRun === true) {
      decisions.push({ ...row, action: 'remove', reason: 'eligible' })
      continue
    }
    const outcome = await cleanupReviewCheckout(tower, { name: entry.name, missionId: entry.missionId })
    if (!outcome || outcome.removal.ok) {
      decisions.push({ ...row, action: 'removed', reason: outcome ? 'checkout was already gone' : 'checkout and record were already gone' })
      removed.push(entry.name)
      continue
    }
    decisions.push({
      ...row,
      action: 'keep',
      reason: `checkout cleanup failed after ${outcome.removal.attempts} attempt(s): ${outcome.removal.error}`,
    })
  }
  return { decisions, removed }
}

/**
 * Disposable detached survey sandboxes (#148 W2). A terminal survey may still
 * carry a sandbox after a failed cleanup; teardown retries with the same bounded
 * removal as completion. Run before the worktree phase so its state revisions
 * never invalidate the worktree claims.
 * @param {any} tower
 * @param {any} input
 * @returns {Promise<{ decisions: any[], removed: string[] }>}
 */
async function teardownSandboxes(tower, input) {
  const state = await tower.load()
  const activity = input.activity ?? {}
  const exclude = new Set(input.exclude ?? [])
  const decisions = []
  const removed = []
  for (const mission of state.missions) {
    const sandbox = typeof /** @type {any} */ (mission).sandbox === 'string' ? /** @type {any} */ (mission).sandbox : null
    if (!sandbox) continue
    if (exclude.has(mission.id)) {
      decisions.push({ missionId: mission.id, action: 'keep', sandbox, reason: 'excluded' })
      continue
    }
    if (hasLiveAgent(state, mission.id, activity)) {
      decisions.push({ missionId: mission.id, action: 'keep', sandbox, reason: 'live agent' })
      continue
    }
    if (!['completed', 'abandoned'].includes(mission.status)) {
      decisions.push({ missionId: mission.id, action: 'keep', sandbox, reason: `mission is ${mission.status}` })
      continue
    }
    if (input.dryRun === true) {
      decisions.push({ missionId: mission.id, action: 'remove', sandbox, reason: 'eligible' })
      continue
    }
    const outcome = await cleanupSandbox(tower, mission.id)
    if (!outcome) {
      decisions.push({ missionId: mission.id, action: 'removed', sandbox, reason: 'sandbox was already gone' })
      removed.push(mission.id)
      continue
    }
    if (outcome.ok) removed.push(mission.id)
    decisions.push({
      missionId: mission.id,
      action: outcome.ok ? 'removed' : 'keep',
      sandbox,
      ...(outcome.ok ? {} : { reason: `sandbox cleanup failed after ${outcome.attempts} attempt(s): ${outcome.error}` }),
    })
  }
  return { decisions, removed }
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
  return tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== expectedRevision) {
      throw new TowerToolError('stale-base', `${STALE}. No worktree was removed.`)
    }
    return revalidateTeardownCandidate(state, candidate, activity)
  })
}

export async function teardown(tower, input) {
  // Sandbox cleanup runs first: it owns its own short locks and revisions, so
  // the worktree prepare/act/commit phases below see a stable revision.
  // Review checkout cleanup first: it owns its own short locks and revisions, so
  // the worktree prepare/act/commit phases below see a stable revision.
  const reviews = await teardownReviewCheckouts(tower, input)
  const sandboxes = await teardownSandboxes(tower, input)
  const prepared = await prepareTeardown(tower, input)
  if (prepared.dryRun) {
    return {
      ok: true,
      dryRun: true,
      removed: [],
      decisions: [...reviews.decisions, ...sandboxes.decisions, ...prepared.decisions],
      reviewCheckoutsRemoved: [],
      sandboxesRemoved: [],
    }
  }

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
    const outcome = await tower.deps.store.withGitLock(tower.paths, async () => {
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
    }, tower.gitMutexOptions({ phase: 'teardown' }))

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
    const commit = await tower.deps.store.withLock(tower.paths, async () => {
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
      await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
      await tower.deps.store.appendJsonl(tower.paths.activity, {
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
  const archive = await tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    const swept = await sweepArchive(tower, state, { now: Date.now(), activity: input.activity ?? {} })
    if (swept.written) {
      validateState(state, tower.paths.state)
      await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    }
    return swept
  })

  return {
    ok: true,
    dryRun: false,
    removed,
    decisions: [...reviews.decisions, ...sandboxes.decisions, ...prepared.decisions],
    reviewCheckoutsRemoved: reviews.removed,
    sandboxesRemoved: sandboxes.removed,
    archived: archive.archived,
    ...(archive.error ? { archiveError: archive.error } : {}),
  }
}
