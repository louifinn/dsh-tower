// Review evidence checkouts (#149 W3).
//
// A review verdict is stamped with a commit, not with whatever a live worktree
// HEAD happens to be when the reviewer submits. When a reviewer is spawned the
// tower creates a disposable detached checkout at the mission branch tip and
// records that commit on the roster row. The reviewer reads (and tower_diff
// shows) that commit; the verdict uses it; the merge gate compares it to the
// current branch tip with the existing `tip-moved` blocker. The checkout is
// removed as soon as the verdict is recorded, so it can never silently drift.
//
// This module owns only the checkout lifecycle. The commit stamp and the
// admission rules live in `domain/missions/review.js` and `app/review.js`.
import path from 'node:path'
import { TowerToolError } from '../domain/errors.js'
import { validateState } from '../domain/state.js'
import { removeSandbox } from './sandbox.js'
import { resolveCheckoutRoot } from './provision.js'

/**
 * @param {string} message
 * @param {string} [code]
 * @returns {never}
 */
function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

/**
 * Deterministic per-reviewer checkout path. `-review-` cannot collide with the
 * `-sandbox` survey suffix or a mission worktree directory.
 * @param {string} root
 * @param {string} missionId
 * @param {string} reviewerName
 * @returns {string}
 */
export function reviewCheckoutPath(root, missionId, reviewerName) {
  const safeName = String(reviewerName).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64)
  return path.join(root, `${missionId}-review-${safeName}`)
}

/**
 * Provision the detached review checkout for a completed mission at its current
 * branch tip. Returns the mission, the checkout path and the commit the reviewer
 * is bound to.
 * @param {any} tower
 * @param {{ missionId?: unknown, name?: unknown, worktreeRoot?: string }} input
 * @returns {Promise<{ mission: any, path: string, commit: string }>}
 */
export async function provisionReviewCheckout(tower, input = {}) {
  const missionId = input.missionId
  if (typeof missionId !== 'string' || missionId.trim().length === 0) fail('tower_spawn requires missionId in this version')
  if (typeof input.name !== 'string' || input.name.trim().length === 0) fail('a review checkout needs the reviewer name')
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === missionId)
  if (!mission) fail(`unknown mission "${missionId}"`, 'mission-not-found')
  if (!mission.worktree) fail(`mission ${mission.id} has no branch to review`, 'reviewer-prerequisite')
  if (mission.status !== 'completed') {
    fail(`mission ${mission.id} is ${mission.status}; only a completed mission can be reviewed`, 'reviewer-prerequisite')
  }
  const commit = await tower.branchTip(mission)
  const root = resolveCheckoutRoot(tower, input)
  await tower.deps.store.ensureDir(root)
  const checkout = reviewCheckoutPath(root, mission.id, input.name.trim())
  await tower.deps.store.withGitLock(tower.paths, async () => {
    if (await tower.deps.store.exists(checkout)) {
      const registered = (await tower.deps.vcs.listWorktrees(tower.root)).some(
        (entry) => path.resolve(entry.path) === path.resolve(checkout),
      )
      if (!registered) {
        fail(`review checkout path already exists and is not a git worktree: ${checkout}; remove it and retry`)
      }
      // A leftover checkout from a failed spawn is disposable evidence for a
      // review that never happened; recreate it at the recorded tip.
      await tower.git(tower.root, ['worktree', 'remove', '--force', checkout]).catch(() => {})
    }
    await tower.git(tower.root, ['worktree', 'add', '--detach', checkout, commit])
    await tower.ensureExcluded(checkout)
  }, tower.gitMutexOptions({ phase: 'review' }))
  const head = await tower.revParse(checkout, 'HEAD')
  if (head !== commit) {
    await removeSandbox(tower, checkout)
    fail(`review checkout ${checkout} was created at ${String(head).slice(0, 12)} instead of ${commit.slice(0, 12)}; no reviewer was started`)
  }
  return { mission, path: checkout, commit }
}

/**
 * Remove one review checkout. Advisory and bounded: a failed cleanup never
 * blocks the verdict, and `tower_teardown`/`tower_recover` retry it later.
 * @param {any} tower
 * @param {string} checkout
 * @returns {Promise<{ ok: boolean, removed: boolean, attempts: number, error?: string }>}
 */
export async function removeReviewCheckout(tower, checkout) {
  return removeSandbox(tower, checkout)
}

/**
 * Remove a reviewer's checkout and clear the recorded path on its roster row.
 * The recorded commit stays: it is the evidence the review was based on.
 * @param {any} tower
 * @param {{ name: string, missionId?: string | null }} input
 * @returns {Promise<{ entry: any, removal: { ok: boolean, removed: boolean, attempts: number, error?: string } } | null>}
 */
export async function cleanupReviewCheckout(tower, input) {
  const removal = await tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    const entry = (state.roster ?? []).find(
      (row) =>
        row.name === input.name &&
        (input.missionId === undefined || input.missionId === null || row.missionId === input.missionId),
    )
    if (!entry || typeof entry.reviewCheckout !== 'string' || entry.reviewCheckout.length === 0) return null
    return { checkout: entry.reviewCheckout, entryName: entry.name, missionId: entry.missionId }
  })
  if (!removal) return null
  const result = await removeSandbox(tower, removal.checkout)
  // A failed removal keeps the path on the row so teardown can retry it; the
  // verdict itself never depends on this advisory cleanup.
  if (!result.ok) return { entry: null, removal: result }
  const written = await tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    const entry = (state.roster ?? []).find((row) => row.name === removal.entryName)
    if (!entry || entry.reviewCheckout !== removal.checkout) return entry ?? null
    delete entry.reviewCheckout
    state.revision += 1
    state.updatedAt = Date.now()
    validateState(state, tower.paths.state)
    await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    return entry
  })
  return { entry: written, removal: result }
}
