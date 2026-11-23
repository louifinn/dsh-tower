// Worktree teardown use case.
//
// #51 two-phase: eligibility diagnostics run outside the state lock; each removal
// runs under the git lock and commits in its own short state lock, with the
// revision revalidated before the irreversible mutation.
import path from 'node:path'
import { validateState } from '../domain/state.js'
import { TowerToolError } from '../domain/errors.js'
import { hasLiveAgent } from '../domain/integration/liveness.js'
import { worktreeRoot } from '../domain/integration/provision.js'
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
import { previewArchive, sweepArchive } from './archive.js'
import { cleanupSandbox } from './sandbox.js'
import {
  cleanupReviewCheckout,
  inventoryEmptyLeftovers,
  isInsideWorktreeRoot,
  pathKey,
  prepareLinkSafeRemoval,
  referencedCheckoutPaths,
  reservedCheckoutPaths,
  settleResidualWorktree,
  sweepEmptyLeftovers,
} from './reviewCheckout.js'

// #184: retry a transient Windows lock with the bounded pattern used by
// sandbox/review-checkout cleanup; the attempt count is reported, and a
// permanent failure keeps the mission record instead of failing the call.
export const WORKTREE_CLEANUP_ATTEMPTS = 3
export const WORKTREE_RETRY_DELAY_MS = 50

const TRANSIENT_WORKTREE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
// `adapters/git.js` keeps a spawn error's string code only in the message (a
// numeric exit status becomes `error.code`), so the text is matched as well.
const TRANSIENT_WORKTREE_MESSAGE =
  /EPERM|EBUSY|EACCES|permission denied|access is denied|being used by another process|resource busy/i

/** @param {unknown} error */
export function isTransientWorktreeRemoveError(error) {
  const code = typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code.toUpperCase() : ''
  if (TRANSIENT_WORKTREE_CODES.has(code)) return true
  return TRANSIENT_WORKTREE_MESSAGE.test(String(/** @type {any} */ (error)?.message ?? error))
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Remove one worktree checkout with a bounded retry over transient failures.
 * Runs inside the caller's git-lock section. A checkout that disappears between
 * attempts is reported as removed: the retry loop is what released the handle.
 * @param {any} tower
 * @param {string} worktreePath
 * @param {{ dirty?: boolean, attempts?: number, delayMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, attempts: number, repaired?: boolean, error?: string }>}
 */
async function removeWorktree(tower, worktreePath, options = {}) {
  const attempts = Number.isInteger(options.attempts) && /** @type {number} */ (options.attempts) > 0 ? /** @type {number} */ (options.attempts) : WORKTREE_CLEANUP_ATTEMPTS
  const delayMs = Number.isInteger(options.delayMs) && /** @type {number} */ (options.delayMs) >= 0 ? /** @type {number} */ (options.delayMs) : WORKTREE_RETRY_DELAY_MS
  const args = ['worktree', 'remove', ...(options.dirty ? ['--force'] : []), worktreePath]
  let lastError = null
  let used = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    used = attempt
    try {
      await tower.git(tower.root, args)
      return { ok: true, attempts: used }
    } catch (error) {
      lastError = error
      if (!(await tower.deps.store.exists(worktreePath))) return { ok: true, attempts: used, repaired: true }
      if (!isTransientWorktreeRemoveError(error)) break
      if (attempt < attempts) await delay(delayMs)
    }
  }
  return { ok: false, attempts: used, error: String(/** @type {any} */ (lastError)?.message ?? lastError).slice(0, 400) }
}

// #185: `git worktree list` also reports checkouts Tower never recorded. Only the
// explicit `orphans: true` sweep sees them; it never removes the main checkout, a
// recorded path, a path outside the root, a dirty checkout, or a branch.

/**
 * The worktree root the sweep searches: configured root, else `tower_provision`'s
 * default. It never comes from a mission record, which an orphan sweep repairs.
 * @param {any} tower
 * @returns {string}
 */
export function teardownWorktreeRoot(tower) {
  return path.resolve(
    worktreeRoot({
      configuredRoot: tower.config?.worktrees?.root,
      repoRoot: tower.root,
      commonDirHash: tower.deps.ids.shortHash(tower.commonDir),
    }),
  )
}

/**
 * Inventory every git-registered checkout and classify it for the orphan sweep.
 * Read-only: each row is `remove` (clean, unrecorded, strictly inside the root),
 * `prune` (registration whose directory is gone), or `keep` (main checkout, a
 * path state records, a provision in flight, outside the root, uncommitted
 * changes); `inflight` repeats the keeps a mission may be about to record.
 * `leftovers` adds the #214 ordinary directories under the root that nothing
 * claims; `leftoverScanAvailable: false` (with `leftoverScanReason`) means the
 * store exposes no enumeration, so an empty list means "not checked". #234:
 * `leftoversReleased` counts stamped worktree paths the scan was allowed to see.
 * @param {any} tower
 * @param {any} [state] already loaded state, so doctor does not load it twice
 * @returns {Promise<{ root: string, decisions: any[], orphans: any[], external: any[], inflight: any[], leftovers: any[], leftoverError: string | null, leftoverScanAvailable: boolean, leftoverScanReason: string | null, leftoversReleased: number }>}
 */
export async function inventoryOrphanWorktrees(tower, state = null) {
  const loaded = state ?? (await tower.load())
  const root = teardownWorktreeRoot(tower)
  const referenced = referencedCheckoutPaths(loaded)
  const reserved = reservedCheckoutPaths(loaded, root)
  const main = pathKey(tower.root)
  const entries = await tower.deps.vcs.listWorktrees(tower.root)
  const decisions = []
  const inflight = []
  const seen = new Set()
  for (const entry of entries) {
    const resolved = path.resolve(entry.path)
    const key = pathKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    const name = entry.branch ?? path.basename(resolved)
    if (key === main) {
      decisions.push({ name, path: resolved, action: 'keep', reason: 'main checkout' })
      continue
    }
    if (referenced.has(key)) {
      decisions.push({ name, path: resolved, action: 'keep', reason: 'referenced by state' })
      continue
    }
    const reservedReason = reserved.get(key)
    if (reservedReason) {
      const row = { name, path: resolved, action: 'keep', reason: reservedReason }
      decisions.push(row)
      inflight.push(row)
      continue
    }
    if (!isInsideWorktreeRoot(root, resolved)) {
      decisions.push({ name, path: resolved, action: 'keep', reason: 'outside the worktree root' })
      continue
    }
    if (!(await tower.deps.store.exists(resolved))) {
      decisions.push({ name, path: resolved, action: 'prune', reason: 'the directory is gone; the registration is stale' })
      continue
    }
    let clean = false
    try {
      clean = await tower.isClean(resolved)
    } catch {
      clean = false
    }
    decisions.push(
      clean
        ? { name, path: resolved, action: 'remove', reason: 'eligible' }
        : { name, path: resolved, action: 'keep', reason: 'uncommitted changes' },
    )
  }
  const unrecorded = decisions.filter(
    (entry) => entry.action === 'remove' || entry.action === 'prune' || entry.reason === 'uncommitted changes',
  )
  // `seen` holds every `git worktree list` key, so a registered checkout is never
  // mistaken for an empty shell.
  const leftovers = await inventoryEmptyLeftovers(tower.deps.store, root, loaded, seen, tower)
  return {
    root,
    decisions,
    orphans: unrecorded,
    external: decisions.filter((entry) => entry.reason === 'outside the worktree root'),
    inflight,
    leftovers: leftovers.leftovers,
    leftoverError: leftovers.error,
    leftoverScanAvailable: leftovers.available,
    leftoverScanReason: leftovers.reason,
    leftoversReleased: leftovers.released,
  }
}

/**
 * #186: name every requested `exclude` id that matches no mission or roster row,
 * so a typo is visible instead of silently keeping nothing. A matched id is
 * already reported by the decision of the mission it protected.
 * @param {any} state
 * @param {unknown[] | undefined} exclude
 * @returns {{ ids: string[], decisions: any[] }}
 */
function unmatchedExclusions(state, exclude) {
  const requested = []
  const seen = new Set()
  for (const value of exclude ?? []) {
    const id = String(value)
    if (seen.has(id)) continue
    seen.add(id)
    requested.push(id)
  }
  if (requested.length === 0) return { ids: [], decisions: [] }
  const known = new Set((state.missions ?? []).map((mission) => String(mission.id)))
  for (const entry of state.roster ?? []) {
    if (entry.missionId != null) known.add(String(entry.missionId))
  }
  const ids = requested.filter((id) => !known.has(id))
  return {
    ids,
    decisions: ids.map((missionId) => ({ missionId, action: 'keep', reason: 'exclude did not match any mission' })),
  }
}

/**
 * Disposable review checkouts (#149 W3). A reviewer works in a detached checkout
 * at its recorded review commit and the checkout is removed when the verdict is
 * recorded; a failed spawn or an interrupted reviewer leaves it behind, so
 * teardown retries the bounded removal and clears the recorded path. A checkout
 * whose reviewer is still active is kept. This runs before the worktree phase so
 * its state revisions never invalidate the worktree claims.
 * @param {any} tower
 * @param {any} input
 * @returns {Promise<{ decisions: any[], removed: string[], notes: string[] }>}
 */
async function teardownReviewCheckouts(tower, input) {
  const state = await tower.load()
  const exclude = new Set(input.exclude ?? [])
  const decisions = []
  const removed = []
  const notes = []
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
      const limited = outcome?.removal.emptyDirectoryCheck
      const reason = !outcome
        ? 'checkout and record were already gone'
        : limited?.available === false
          ? `checkout was removed; the empty directory could not be inspected: ${limited.reason}`
          : 'checkout was already gone'
      if (limited?.available === false) notes.push(`review checkout ${checkout} may have left an empty shell: ${limited.reason}`)
      decisions.push({ ...row, action: 'removed', reason })
      removed.push(entry.name)
      continue
    }
    decisions.push({
      ...row,
      action: 'keep',
      reason: `checkout cleanup failed after ${outcome.removal.attempts} attempt(s): ${outcome.removal.error}`,
    })
  }
  return { decisions, removed, notes }
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
    // #F61: a terminal mission may outlive its checkout (the directory was
    // deleted outside Tower while the worktree record survived). There is
    // nothing to verify or remove, so it is a repair candidate: the git phase
    // prunes a leftover registration best-effort and the commit phase stamps
    // worktreeRemovedAt, so doctor/status stop reporting a live worktree.
    if (!(await tower.deps.store.exists(mission.worktree.path))) {
      const decision = {
        missionId: mission.id,
        action: 'remove',
        reason: 'worktree directory is already gone; the removal will be recorded',
      }
      decisions.push(decision)
      if (!dryRun) candidates.push({ missionId: mission.id, worktree: mission.worktree, decision })
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

  return { state, stateRevision: state.revision, decisions, candidates, dryRun }
}

/** Short state lock: reject a stale decision before any git mutation. */
async function claimRemoval(tower, candidate, expectedRevision, input) {
  const activity = input.activity ?? {}
  return tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    if (state.revision !== expectedRevision) {
      throw new TowerToolError('stale-base', `${STALE}. No worktree was removed.`)
    }
    return revalidateTeardownCandidate(state, candidate, activity)
  })
}

/**
 * #185: carry out the entries the inventory marked, re-validating them on a
 * freshly loaded state under the git lock. A path state now records, one a
 * provision is about to claim, or one outside the root is kept; a checkout that
 * turned dirty is kept; a vanished directory is pruned and one bounded
 * `git worktree prune` clears stale registrations. Branch rows are never deleted:
 * an orphan's branch is not Tower's to discard.
 * @param {any} tower
 * @param {{ root: string, decisions: any[] }} inventory
 * @returns {Promise<{ decisions: any[], removed: string[], pruned: string[] }>}
 */
async function sweepOrphanWorktrees(tower, inventory) {
  const decisions = inventory.decisions.map((entry) => ({ ...entry }))
  const targets = decisions.filter((entry) => entry.action === 'remove' || entry.action === 'prune')
  if (targets.length === 0) return { decisions, removed: [], pruned: [] }

  const outcome = await tower.deps.store.withGitLock(tower.paths, async () => {
    let state
    try {
      state = await tower.load()
    } catch (error) {
      return { phase: 'unreadable', detail: String(/** @type {any} */ (error)?.message ?? error).slice(0, 240) }
    }
    const referenced = referencedCheckoutPaths(state)
    const reserved = reservedCheckoutPaths(state, inventory.root)
    const main = pathKey(tower.root)
    const results = new Map()
    let pruneNeeded = false
    for (const entry of targets) {
      const key = pathKey(entry.path)
      const keep = (reason, extra = {}) => results.set(key, { action: 'keep', reason, ...extra })
      if (key === main) {
        keep('main checkout')
        continue
      }
      if (referenced.has(key)) {
        keep('referenced by state')
        continue
      }
      const reservedReason = reserved.get(key)
      if (reservedReason) {
        keep(reservedReason)
        continue
      }
      if (!isInsideWorktreeRoot(inventory.root, entry.path)) {
        keep('outside the worktree root')
        continue
      }
      if (!(await tower.deps.store.exists(entry.path))) {
        pruneNeeded = true
        results.set(key, { action: 'pruned', reason: 'the directory was gone; the stale registration was pruned' })
        continue
      }
      let clean = false
      try {
        clean = await tower.isClean(entry.path)
      } catch {
        clean = false
      }
      if (!clean) {
        keep('uncommitted changes')
        continue
      }
      // #218/F100: an orphan has no registration, so any top-level link is kept:
      // git's recursive removal must never be allowed to walk through it.
      const linkPlan = await prepareLinkSafeRemoval(tower, { path: entry.path })
      if (linkPlan.blocked) {
        keep(`contains a link Tower did not create: ${linkPlan.kept.map((kept) => `${kept.name} (${kept.reason})`).join('; ')}`)
        continue
      }
      const removal = await removeWorktree(tower, entry.path)
      if (!removal.ok) {
        keep(`remove failed after ${removal.attempts} attempt(s): ${removal.error}`, { attempts: removal.attempts })
        continue
      }
      if (removal.repaired) pruneNeeded = true
      const residual = await settleResidualWorktree(tower, entry.path, null)
      results.set(key, {
        action: 'removed',
        reason: 'eligible',
        ...(removal.attempts > 1 ? { attempts: removal.attempts } : {}),
        ...(linkPlan.link ? { nodeModulesLink: linkPlan.link } : {}),
        ...(residual.decisions.length > 0 ? { residuals: residual.decisions } : {}),
      })
    }
    if (pruneNeeded) {
      try {
        await tower.git(tower.root, ['worktree', 'prune'])
      } catch {
        // the directories are already gone; recording them as pruned is the repair
      }
    }
    return { phase: 'done', results }
  }, tower.gitMutexOptions({ phase: 'teardown' }))

  if (outcome.phase === 'unreadable') {
    for (const entry of targets) {
      const row = decisions.find((candidate) => pathKey(candidate.path) === pathKey(entry.path))
      if (!row) continue
      row.action = 'keep'
      row.reason = `state could not be re-read before the sweep: ${outcome.detail}`
    }
    return { decisions, removed: [], pruned: [] }
  }

  const removed = []
  const pruned = []
  for (const entry of decisions) {
    const swept = outcome.results.get(pathKey(entry.path))
    if (!swept) continue
    entry.action = swept.action
    entry.reason = swept.reason
    if (swept.attempts) entry.attempts = swept.attempts
    if (swept.nodeModulesLink) entry.nodeModulesLink = swept.nodeModulesLink
    if (swept.residuals) entry.residuals = swept.residuals
    if (swept.action === 'removed') removed.push(entry.path)
    if (swept.action === 'pruned') pruned.push(entry.path)
  }
  return { decisions, removed, pruned }
}

export async function teardown(tower, input) {
  // Review-checkout and sandbox cleanup run first: each owns its own short
  // locks and revisions, so the worktree phases below see a stable revision.
  const reviews = await teardownReviewCheckouts(tower, input)
  const sandboxes = await teardownSandboxes(tower, input)
  const prepared = await prepareTeardown(tower, input)
  const unmatched = unmatchedExclusions(prepared.state, input.exclude)
  // #185: the orphan sweep is explicit; this inventory only reads.
  const orphans = input.orphans === true ? await inventoryOrphanWorktrees(tower, prepared.state) : null
  const warnings = [...reviews.notes]
  if (orphans && !orphans.leftoverScanAvailable) {
    warnings.push(
      `empty leftover directory sweep is unavailable: ${orphans.leftoverScanReason}; tower_teardown cannot clean review-checkout shells with this store`,
    )
  }
  if (prepared.dryRun) {
    // #183: same policy inputs and projected state as the real run, but no writes.
    const plannedRemovals = prepared.decisions
      .filter((decision) => decision.action === 'remove')
      .map((decision) => decision.missionId)
    const plannedCleanups = sandboxes.decisions
      .filter((decision) => decision.action === 'remove')
      .map((decision) => decision.missionId)
    const archivePreview = previewArchive(tower, prepared.state, {
      now: Date.now(),
      activity: input.activity ?? {},
      removeWorktreeIds: plannedRemovals,
      removeSandboxIds: plannedCleanups,
    })
    return {
      ok: true,
      dryRun: true,
      removed: [],
      decisions: [...reviews.decisions, ...sandboxes.decisions, ...prepared.decisions, ...unmatched.decisions],
      reviewCheckoutsRemoved: [],
      sandboxesRemoved: [],
      archivePreview,
      unmatchedExclude: unmatched.ids,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(orphans
        ? {
            orphanWorktrees: {
              root: orphans.root,
              decisions: orphans.decisions,
              removed: [],
              pruned: [],
              leftovers: orphans.leftovers,
              leftoversRemoved: [],
              leftoversReleased: orphans.leftoversReleased,
              ...(orphans.leftoverError ? { leftoverError: orphans.leftoverError } : {}),
              ...(orphans.leftoverScanAvailable === false ? { leftoversUnavailable: orphans.leftoverScanReason } : {}),
            },
          }
        : {}),
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

    // Phase 2 (#51): the irreversible git work runs under the git lock, never
    // under the state lock, after a fresh read proves the candidate is not stale.
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
      // #F61: converge a terminal mission whose checkout is gone, repeating the
      // existence check here where it protects the git mutation.
      let repaired = false
      let attempts = 0
      let nodeModulesLink = null
      let residuals = []
      if (await tower.deps.store.exists(worktree.path)) {
        let dirty = true
        try {
          dirty = !(await tower.isClean(worktree.path))
        } catch {
          dirty = true
        }
        const dirtyKeep = teardownDirtyDecision(dirty, input.force)
        if (dirtyKeep) return { phase: 'skip', reason: dirtyKeep.reason }
        // #218/F100: unlink the recorded node_modules link before the recursive
        // git removal; keep the checkout while an unrecorded link could be followed.
        const linkPlan = await prepareLinkSafeRemoval(tower, worktree)
        if (linkPlan.blocked) {
          return {
            phase: 'link-kept',
            reason: `no worktree was removed: ${linkPlan.kept.map((kept) => `${kept.name} — ${kept.reason}`).join('; ')}`,
            links: linkPlan.kept,
          }
        }
        nodeModulesLink = linkPlan.link
        const removal = await removeWorktree(tower, worktree.path, { dirty })
        if (!removal.ok) {
          return {
            phase: 'remove-failed',
            attempts: removal.attempts,
            reason: `remove failed after ${removal.attempts} attempt(s): ${removal.error}`,
          }
        }
        attempts = removal.attempts
        const residual = await settleResidualWorktree(tower, worktree.path, worktree)
        residuals = residual.decisions
        if (removal.repaired) {
          // The checkout vanished while the retry waited out a Windows handle.
          repaired = true
          try {
            await tower.git(tower.root, ['worktree', 'prune'])
          } catch {
            // nothing to remove: the directory is gone
          }
        }
      } else {
        // Best-effort prune of a stale registration; the checkout is already
        // gone, so recording the removal is the actual repair.
        repaired = true
        try {
          await tower.git(tower.root, ['worktree', 'remove', '--force', worktree.path])
        } catch {
          // nothing to remove: the directory is gone
        }
      }
      let branchDeleteError = null
      try {
        // Only delete a branch that still exists; a repaired mission may have
        // been deleted with its checkout. `-d` keeps unmerged branches.
        const listed = (await tower.git(tower.root, ['branch', '--list', worktree.branch])).trim()
        if (listed) await tower.git(tower.root, ['branch', '-d', worktree.branch])
      } catch (error) {
        branchDeleteError = String(error?.message ?? error).slice(0, 240)
      }
      return {
        phase: 'removed',
        branch: worktree.branch,
        branchDeleteError,
        repaired,
        attempts,
        ...(nodeModulesLink ? { nodeModulesLink } : {}),
        ...(residuals.length > 0 ? { residuals } : {}),
      }
    }, tower.gitMutexOptions({ phase: 'teardown' }))

    if (outcome.phase === 'stale') {
      throw new TowerToolError('stale-base', `${STALE}: ${outcome.detail}. No worktree was removed.`)
    }
    if (outcome.phase === 'link-kept') {
      // #218/F100: keep the whole checkout when it holds a link Tower did not create.
      setDecision(candidate.decision, { action: 'keep', reason: outcome.reason, links: outcome.links })
      continue
    }
    if (outcome.phase !== 'removed') {
      setDecision(candidate.decision, {
        action: 'keep',
        reason: outcome.reason,
        ...(Number.isInteger(outcome.attempts) ? { attempts: outcome.attempts } : {}),
      })
      continue
    }

    // Phase 3 (#51): commit this removal alone in a short state lock. The
    // removal already happened, so if a writer landed while git ran we apply
    // the removal on the freshly loaded state instead of rejecting it (which
    // would leave state claiming a worktree that no longer exists). Only this
    // mission's fields change, so no concurrent update is lost.
    const commit = await tower.withStateLock(async (_paths, held) => {
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
      await tower.writeState(state, held)
      await tower.appendActivity({
        at: now,
        type: 'teardown',
        missionId: mission.id,
        text: `${teardownActivityText(outcome.branch, outcome.branchDeleteError)}${outcome.repaired ? ' (checkout was already gone)' : ''}`,
      })
      return { revision: state.revision }
    })
    expectedRevision = commit.revision
    removed.push(candidate.missionId)
    setDecision(candidate.decision, {
      ...teardownRemovedDecision(outcome),
      ...(outcome.attempts > 0 ? { attempts: outcome.attempts } : {}),
      ...(outcome.nodeModulesLink ? { nodeModulesLink: outcome.nodeModulesLink } : {}),
      ...(outcome.residuals ? { residuals: outcome.residuals } : {}),
      ...(outcome.repaired
        ? { repaired: true, reason: 'worktree directory was already gone; the removal was recorded' }
        : {}),
    })
  }

  // #185: the opt-in orphan sweep runs after the mission loop and before
  // archival. It never touches a mission record: an unrecorded checkout has no
  // mission to stamp, so a successful sweep only reports what it removed.
  const orphanSweep = orphans ? await sweepOrphanWorktrees(tower, orphans) : null
  // #214: empty shells have no git registration, so they need their own sweep.
  // It runs under the git lock and never touches a state record.
  const leftoverSweep = orphans ? await sweepEmptyLeftovers(tower, orphans) : null

  // Archival runs under one final short lock. It is policy-driven (age or the
  // hot-terminal cap), so a mission torn down a moment ago stays hot until it
  // is old enough; `archive.afterDays: 0` archives it on this call.
  const archive = await tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    const swept = await sweepArchive(tower, state, { now: Date.now(), activity: input.activity ?? {} })
    if (swept.written) {
      validateState(state, tower.paths.state)
      await tower.writeState(state, held)
    }
    return swept
  })

  return {
    ok: true,
    dryRun: false,
    removed,
    decisions: [...reviews.decisions, ...sandboxes.decisions, ...prepared.decisions, ...unmatched.decisions],
    reviewCheckoutsRemoved: reviews.removed,
    sandboxesRemoved: sandboxes.removed,
    unmatchedExclude: unmatched.ids,
    archived: archive.archived,
    ...(archive.error ? { archiveError: archive.error } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(orphanSweep && orphans
      ? {
          orphanWorktrees: {
            root: orphans.root,
            decisions: orphanSweep.decisions,
            removed: orphanSweep.removed,
            pruned: orphanSweep.pruned,
            ...(leftoverSweep
              ? {
                  leftovers: leftoverSweep.decisions,
                  leftoversRemoved: leftoverSweep.removed,
                  leftoversReleased: orphans.leftoversReleased,
                }
              : {}),
            ...(orphans.leftoverError ? { leftoverError: orphans.leftoverError } : {}),
            ...(orphans.leftoverScanAvailable === false ? { leftoversUnavailable: orphans.leftoverScanReason } : {}),
          },
        }
      : {}),
  }
}
