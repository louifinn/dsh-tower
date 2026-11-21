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
// This module owns the checkout lifecycle, the checkout paths the orphan sweep
// protects, and the #214 cleanup of the empty shells directly under the worktree
// root: a checkout whose contents were removed can leave its directory behind,
// and `git worktree list` no longer reports it. The commit stamp and the
// admission rules live in `domain/missions/review.js` and `app/review.js`.
import path from 'node:path'
import { TowerToolError } from '../domain/errors.js'
import { validateState } from '../domain/state.js'
import { sandboxPath, worktreePath } from '../domain/integration/provision.js'
import { shapeFor } from '../domain/shapes/index.js'
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
 * @returns {Promise<{ ok: boolean, removed: boolean, attempts: number, error?: string, emptyDirectoryCheck?: { available: boolean, reason: string } }>}
 */
export async function removeReviewCheckout(tower, checkout) {
  const removal = await removeSandbox(tower, checkout)
  // #214: git can unregister the checkout and delete its contents while the
  // directory itself survives (a handle, or a cleanup that stopped at the
  // `git worktree remove` step). The registration is already gone, so no
  // `git worktree list` row makes this shell visible; remove it here while the
  // roster row still names it. A non-empty directory is left to the operator.
  if (!removal.ok) return removal
  let inspection
  try {
    inspection = await isEmptyDirectory(tower.deps.store, checkout)
  } catch {
    return removal
  }
  // A store without directory enumeration cannot tell whether the shell is
  // empty. Report the limitation rather than claim the cleanup finished.
  if (!inspection.available) {
    return { ...removal, emptyDirectoryCheck: { available: false, reason: String(inspection.reason) } }
  }
  if (!inspection.empty) return removal
  const cleaned = await removeEmptyDirectory(tower.deps.store, checkout)
  if (!cleaned.available) {
    return { ...removal, emptyDirectoryCheck: { available: false, reason: String(cleaned.reason) } }
  }
  if (!cleaned.ok) return { ...removal, error: cleaned.error }
  return { ...removal, removed: removal.removed || cleaned.removed }
}

/**
 * Remove a reviewer's checkout and clear the recorded path on its roster row.
 * The recorded commit stays: it is the evidence the review was based on.
 * @param {any} tower
 * @param {{ name: string, missionId?: string | null }} input
 * @returns {Promise<{ entry: any, removal: { ok: boolean, removed: boolean, attempts: number, error?: string, emptyDirectoryCheck?: { available: boolean, reason: string } } } | null>}
 */
export async function cleanupReviewCheckout(tower, input) {
  const removal = await tower.withStateLock(async (_paths, held) => {
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
  const result = await removeReviewCheckout(tower, removal.checkout)
  // A failed removal keeps the path on the row so teardown can retry it; the
  // verdict itself never depends on this advisory cleanup.
  if (!result.ok) return { entry: null, removal: result }
  const written = await tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    const entry = (state.roster ?? []).find((row) => row.name === removal.entryName)
    if (!entry || entry.reviewCheckout !== removal.checkout) return entry ?? null
    delete entry.reviewCheckout
    state.revision += 1
    state.updatedAt = Date.now()
    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    return entry
  })
  return { entry: written, removal: result }
}

// Checkout path accounting shared with the #185/#214 orphan sweep. A path is
// protected because state records it, because a provision may be about to
// record it, or because it is the main checkout; everything else inside the
// worktree root is a candidate for the explicit `orphans` sweep.
const CASE_INSENSITIVE_PATHS = process.platform === 'win32'
export const RESERVED_CHECKOUT_REASON = 'a checkout is being provisioned and is not recorded by state yet'
// Fail closed: a mission whose kind cannot be read may still provision, so its
// expected path stays reserved with this reason instead of being swept.
export const RESERVED_CHECKOUT_UNKNOWN_KIND_REASON = 'a checkout may be in flight because the mission kind could not be read, so the path is kept'
// A mission cannot start a provision once its work is closed: `completed` (only
// a merge or acceptance remains), `merged` or `abandoned`. `paused` and
// `blocked` can resume into a spawn, so they still reserve. This is deliberately
// not the shape's `isTerminal`: a build's `completed` is not terminal yet.
const PROVISIONING_CLOSED_STATUSES = new Set(['completed', 'merged', 'abandoned'])

/** Canonical comparison key: absolute, and case-folded on Windows. */
export function pathKey(value) {
  const resolved = path.resolve(value)
  return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved
}

/**
 * Every checkout path the state claims: mission worktrees, detached sandboxes
 * and live review checkouts. Teardown protects all of them, and their absence
 * from a reinitialised state is what makes the old checkouts orphans.
 * @param {any} state
 * @returns {Set<string>}
 */
export function referencedCheckoutPaths(state) {
  const paths = new Set()
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) paths.add(pathKey(value))
  }
  for (const mission of state.missions ?? []) {
    add(mission.worktree?.path)
    add(mission.sandbox)
  }
  for (const entry of state.roster ?? []) add(entry.reviewCheckout)
  return paths
}

/**
 * True when `candidate` is a strict descendant of `root`: the root itself, a
 * sibling and every `..` escape are outside.
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
export function isInsideWorktreeRoot(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * Checkout paths a running provision is about to record, each with the reason
 * the sweep must keep it. `tower_provision` creates the checkout under the git
 * lock and commits its record only after releasing it; reserving the expected
 * path closes that window, so a sweep never deletes the checkout a concurrent
 * provision just made. A path is reserved only while the mission can still start
 * a provision: no recorded checkout, the shape declares that kind
 * (`fields.worktree` or `fields.sandbox`), and the status is not closed. A shape
 * read that throws keeps the reservation with a recorded reason instead of
 * removing the path.
 * @param {any} state
 * @param {string} root
 * @returns {Map<string, string>} canonical path -> why the sweep must keep it
 */
export function reservedCheckoutPaths(state, root) {
  /** @type {Map<string, string>} */
  const reserved = new Map()
  for (const mission of state.missions ?? []) {
    let fields = null
    let shapeError = null
    try {
      fields = shapeFor(mission.kind).fields
    } catch (error) {
      shapeError = String(error?.message ?? error).slice(0, 160)
    }
    if (PROVISIONING_CLOSED_STATUSES.has(mission.status)) continue
    for (const [recorded, declared, expected] of [
      [mission.worktree, fields?.worktree, worktreePath(root, mission.id)],
      [mission.sandbox, fields?.sandbox, sandboxPath(root, mission.id)],
    ]) {
      if (recorded) continue
      if (!fields) reserved.set(pathKey(expected), `${RESERVED_CHECKOUT_UNKNOWN_KIND_REASON}: ${shapeError}`)
      else if (declared) reserved.set(pathKey(expected), RESERVED_CHECKOUT_REASON)
    }
  }
  return reserved
}

// #214: directory enumeration and removal are optional StorePort filesystem
// capabilities (ports/store.js), the same precedent as `copyFileExclusive`. The
// app layer feature-detects them and reports the limitation; it never reaches for
// the filesystem module directly, which the architecture gate keeps inside
// adapters/**. A store that exposes neither must not be read as "no shells": every
// caller surfaces `available: false` and the reason instead.
export const DIRECTORY_SCAN_UNSUPPORTED = 'the store does not expose directory enumeration'
export const DIRECTORY_REMOVAL_UNSUPPORTED = 'the store does not expose empty-directory removal'

/**
 * Feature-detect the optional directory capabilities. A store may expose
 * neither, only enumeration, or both; each caller names the one it needs.
 * @param {any} store
 * @returns {{ readdir: ((dir: string) => Promise<string[]>) | null, rmdir: ((dir: string) => Promise<void>) | null }}
 */
export function directoryCapabilities(store) {
  return {
    readdir: typeof store?.readdir === 'function' ? (dir) => store.readdir(dir) : null,
    rmdir: typeof store?.rmdir === 'function' ? (dir) => store.rmdir(dir) : null,
  }
}

/**
 * Direct child directory names of `root`, sorted. A missing root has no
 * children; files are skipped so only directories are ever considered. A store
 * without `readdir` returns `available: false` with the reason; callers must
 * report that instead of reading the empty `directories` as "no shells".
 * @param {any} store
 * @param {string} root
 * @returns {Promise<{ available: boolean, reason: string | null, directories: string[] }>}
 */
export async function directChildDirectories(store, root) {
  const { readdir } = directoryCapabilities(store)
  if (!readdir) return { available: false, reason: DIRECTORY_SCAN_UNSUPPORTED, directories: [] }
  const names = await readdir(root)
  const directories = []
  for (const name of names) {
    try {
      const info = await store.stat(path.join(root, name))
      if (info?.isDirectory()) directories.push(name)
    } catch {
      // A child that vanished between the listing and the stat is not a shell.
    }
  }
  return { available: true, reason: null, directories: directories.sort() }
}

/**
 * Whether `dir` holds no entries. `readdir` rather than a cached stat keeps a
 * concurrent checkout from being mistaken for an empty shell. Without the
 * capability the answer is `available: false`, never "empty".
 * @param {any} store
 * @param {string} dir
 * @returns {Promise<{ available: boolean, reason: string | null, empty: boolean }>}
 */
export async function isEmptyDirectory(store, dir) {
  const { readdir } = directoryCapabilities(store)
  if (!readdir) return { available: false, reason: DIRECTORY_SCAN_UNSUPPORTED, empty: false }
  return { available: true, reason: null, empty: (await readdir(dir)).length === 0 }
}

/**
 * Remove one empty directory. A vanished or now-non-empty directory is a benign
 * keep (`ENOENT`/`ENOTEMPTY`/`EEXIST`): the caller re-checks both, and a busy
 * Windows handle is a retryable removal failure. Without the capability nothing
 * is attempted and the result says why.
 * @param {any} store
 * @param {string} dir
 * @returns {Promise<{ ok: boolean, removed: boolean, available: boolean, reason?: string, error?: string }>}
 */
export async function removeEmptyDirectory(store, dir) {
  const { rmdir } = directoryCapabilities(store)
  if (!rmdir) return { ok: false, removed: false, available: false, reason: DIRECTORY_REMOVAL_UNSUPPORTED }
  try {
    await rmdir(dir)
    return { ok: true, removed: true, available: true }
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? '')
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') {
      return { ok: true, removed: false, available: true }
    }
    return {
      ok: false,
      removed: false,
      available: true,
      error: String(/** @type {any} */ (error)?.message ?? error).slice(0, 240),
    }
  }
}

/**
 * #214: ordinary directories directly under the worktree root that neither
 * state nor `git worktree list` claims. They are the shells a review checkout
 * leaves behind when its contents were removed but the directory survived; a
 * non-empty or unreadable directory is reported as a keep, never removed. A
 * store without directory enumeration returns `available: false` with the
 * reason, which every caller must surface rather than report a clean sweep.
 * @param {any} store
 * @param {string} root
 * @param {any} state
 * @param {Set<string>} registered canonical keys from `git worktree list`
 * @returns {Promise<{ leftovers: any[], error: string | null, available: boolean, reason: string | null }>}
 */
export async function inventoryEmptyLeftovers(store, root, state, registered) {
  const referenced = referencedCheckoutPaths(state)
  const reserved = reservedCheckoutPaths(state, root)
  const leftovers = []
  let scan
  try {
    scan = await directChildDirectories(store, root)
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') {
      return { leftovers, error: null, available: true, reason: null }
    }
    return {
      leftovers,
      error: String(/** @type {any} */ (error)?.message ?? error).slice(0, 240),
      available: false,
      reason: null,
    }
  }
  if (!scan.available) return { leftovers, error: null, available: false, reason: scan.reason }
  for (const name of scan.directories) {
    const entryPath = path.join(root, name)
    const key = pathKey(entryPath)
    if (referenced.has(key) || reserved.has(key) || registered.has(key)) continue
    try {
      const inspection = await isEmptyDirectory(store, entryPath)
      leftovers.push(
        inspection.empty
          ? { name, path: entryPath, action: 'remove', reason: 'empty leftover directory' }
          : { name, path: entryPath, action: 'keep', reason: 'not an empty directory; kept' },
      )
    } catch (error) {
      leftovers.push({
        name,
        path: entryPath,
        action: 'keep',
        reason: `could not inspect the directory: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 200)}`,
      })
    }
  }
  return { leftovers, error: null, available: true, reason: null }
}

/**
 * #214: remove the empty leftover directories the inventory marked, re-checking
 * each one on a freshly loaded state under the git lock. A path state now
 * claims, a reserved path, a registered checkout, a path outside the root, a
 * non-empty directory and a failed removal are all kept; only an empty ordinary
 * directory with no other owner can be removed.
 * @param {any} tower
 * @param {{ root: string, leftovers: any[], leftoverScanAvailable?: boolean, leftoverScanReason?: string | null }} inventory
 * @returns {Promise<{ decisions: any[], removed: string[], available: boolean, reason?: string }>}
 */
export async function sweepEmptyLeftovers(tower, inventory) {
  const decisions = inventory.leftovers.map((entry) => ({ ...entry }))
  // A store without directory enumeration cannot have produced leftover rows;
  // if an unsupported inventory reaches here anyway, remove nothing and say so.
  if (inventory.leftoverScanAvailable === false) {
    return {
      decisions,
      removed: [],
      available: false,
      reason: inventory.leftoverScanReason ?? DIRECTORY_SCAN_UNSUPPORTED,
    }
  }
  const targets = decisions.filter((entry) => entry.action === 'remove')
  if (targets.length === 0) return { decisions, removed: [], available: true }

  const outcome = await tower.deps.store.withGitLock(tower.paths, async () => {
    let state
    try {
      state = await tower.load()
    } catch (error) {
      return { phase: 'unreadable', detail: String(/** @type {any} */ (error)?.message ?? error).slice(0, 240) }
    }
    const referenced = referencedCheckoutPaths(state)
    const reserved = reservedCheckoutPaths(state, inventory.root)
    const registered = new Set((await tower.deps.vcs.listWorktrees(tower.root)).map((entry) => pathKey(entry.path)))
    const results = new Map()
    for (const entry of targets) {
      const key = pathKey(entry.path)
      const keep = (reason) => results.set(key, { action: 'keep', reason })
      if (referenced.has(key)) {
        keep('referenced by state')
        continue
      }
      const reservedReason = reserved.get(key)
      if (reservedReason) {
        keep(reservedReason)
        continue
      }
      if (registered.has(key)) {
        keep('registered as a git worktree')
        continue
      }
      if (!isInsideWorktreeRoot(inventory.root, entry.path)) {
        keep('outside the worktree root')
        continue
      }
      let info = null
      try {
        info = await tower.deps.store.stat(entry.path)
      } catch {
        info = null
      }
      if (!info) {
        results.set(key, { action: 'removed', reason: 'the directory was already gone' })
        continue
      }
      if (!info.isDirectory()) {
        keep('not a directory')
        continue
      }
      let inspection
      try {
        inspection = await isEmptyDirectory(tower.deps.store, entry.path)
      } catch (error) {
        keep(`could not inspect the directory: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 200)}`)
        continue
      }
      if (!inspection.available) {
        keep(String(inspection.reason))
        continue
      }
      if (!inspection.empty) {
        keep('not empty')
        continue
      }
      const removal = await removeEmptyDirectory(tower.deps.store, entry.path)
      if (!removal.available) {
        keep(String(removal.reason))
        continue
      }
      if (!removal.removed) {
        keep(removal.ok ? 'the directory was already gone or changed' : removal.error ?? 'the removal failed')
        continue
      }
      results.set(key, { action: 'removed', reason: 'empty leftover directory' })
    }
    return { phase: 'done', results }
  }, tower.gitMutexOptions({ phase: 'teardown' }))

  if (outcome.phase === 'unreadable') {
    for (const entry of targets) {
      const row = decisions.find((candidate) => candidate.path === entry.path)
      if (!row) continue
      row.action = 'keep'
      row.reason = `state could not be re-read before the sweep: ${outcome.detail}`
    }
    return { decisions, removed: [], available: true }
  }

  const removed = []
  for (const entry of decisions) {
    const swept = outcome.results.get(pathKey(entry.path))
    if (!swept) continue
    entry.action = swept.action
    entry.reason = swept.reason
    if (swept.action === 'removed') removed.push(entry.path)
  }
  return { decisions, removed, available: true }
}
