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
 * from a reinitialised state is what makes the old checkouts orphans. #234: a
 * worktree record whose removal was stamped is not a live checkout, so its path
 * is released to the sweep instead of masking the shell left behind.
 * @param {any} state
 * @returns {Set<string>}
 */
export function referencedCheckoutPaths(state) {
  const paths = new Set()
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) paths.add(pathKey(value))
  }
  for (const mission of state.missions ?? []) {
    if (!mission.worktreeRemovedAt) add(mission.worktree?.path)
    add(mission.sandbox)
  }
  for (const entry of state.roster ?? []) add(entry.reviewCheckout)
  return paths
}

/** #234: how many recorded worktree paths a removal stamp released. */
function releasedCheckoutCount(state) {
  let released = 0
  for (const mission of state.missions ?? []) {
    if (mission.worktreeRemovedAt && typeof mission.worktree?.path === 'string' && mission.worktree.path.length > 0) released += 1
  }
  return released
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
// capabilities (ports/store.js). The app layer feature-detects them and reports
// the limitation; a store exposing neither must never be read as "no shells".
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

// #227: a leftover shell can hold the `node_modules` junction `spawn.nodeModules:
// "link"` creates, and `readdir` counts it as an entry. Such a link may be
// unlinked when its canonical target proves it points inside the repository or the
// worktree root; any other entry keeps the shell and is named. No link is followed.
const LEFTOVER_LINK_REASON = 'leftover directory holding only dependency links'
const LEFTOVER_LINK_REMOVED_REASON = `${LEFTOVER_LINK_REASON}; the links were unlinked and their targets were not touched`
const DIRECTORY_LINK_REMOVAL_UNSUPPORTED = 'the store does not expose link removal'

/** @param {any} tower @param {any} [state] */
function leftoverScanContext(tower, state = null) {
  const canonicalPath = tower?.deps?.ownership?.canonicalPath
  const repoRoot = typeof state?.repoRoot === 'string' && state.repoRoot.length > 0 ? state.repoRoot : null
  return {
    repositoryRoot: repoRoot ?? (typeof tower?.root === 'string' && tower.root.length > 0 ? tower.root : null),
    resolveLinkTarget: typeof canonicalPath === 'function' ? (value) => canonicalPath(value) : null,
  }
}

/**
 * #227: decide what one leftover directory is. Empty is removable, and so is a
 * directory whose every entry is a link whose canonical target is strictly
 * inside the repository or the worktree root; `links` then names what may be
 * unlinked. Otherwise `detail` names every blocking entry.
 * @param {any} store
 * @param {string} root worktree root; a link into it is Tower's own tree too
 * @param {string} dir
 * @param {{ repositoryRoot?: string | null, resolveLinkTarget?: ((value: string) => Promise<string>) | null }} [context]
 * @returns {Promise<{ removable: boolean, detail: string, links: Array<{ name: string, path: string, target: string }> }>}
 */
async function classifyLeftover(store, root, dir, context = {}) {
  const { readdir } = directoryCapabilities(store)
  if (!readdir) return { removable: false, detail: DIRECTORY_SCAN_UNSUPPORTED, links: [] }
  const names = await readdir(dir)
  if (names.length === 0) return { removable: true, detail: 'empty leftover directory', links: [] }
  const resolve = typeof context.resolveLinkTarget === 'function' ? context.resolveLinkTarget : null
  const roots = []
  for (const candidate of [context.repositoryRoot, root]) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    const resolved = path.resolve(candidate)
    const canonical = resolve ? await resolve(resolved).catch(() => null) : null
    roots.push(canonical ?? resolved)
  }
  const blockers = []
  const links = []
  for (const name of [...names].sort()) {
    const entryPath = path.join(dir, name)
    let info = null
    try {
      info = typeof store.lstat === 'function' ? await store.lstat(entryPath) : null
    } catch {
      info = null
    }
    if (!info) {
      blockers.push(name)
      continue
    }
    if (info.isSymbolicLink() !== true) {
      blockers.push(info.isDirectory() === true ? `${name}/` : name)
      continue
    }
    const target = resolve ? await resolve(entryPath).catch(() => null) : null
    if (target === null) {
      blockers.push(`${name} (a link whose target could not be resolved)`)
      continue
    }
    if (!roots.some((base) => isInsideWorktreeRoot(base, target))) {
      blockers.push(`${name} -> ${target} (outside the repository and the worktree root)`)
      continue
    }
    links.push({ name, path: entryPath, target })
  }
  if (blockers.length === 0 && links.length > 0 && (typeof store.unlink !== 'function' || typeof store.rmdir !== 'function')) {
    const detail = typeof store.unlink === 'function' ? DIRECTORY_REMOVAL_UNSUPPORTED : DIRECTORY_LINK_REMOVAL_UNSUPPORTED
    return { removable: false, detail, links: [] }
  }
  if (blockers.length === 0) return { removable: true, detail: links.length > 0 ? LEFTOVER_LINK_REASON : 'empty leftover directory', links }
  const shown = blockers.slice(0, 4)
  const detail = `not an empty directory; kept (holds ${shown.join(', ')}${blockers.length > shown.length ? ', ...' : ''})`
  return { removable: false, detail, links: [] }
}

// #218/F100: a `node_modules` junction may point at the baseline checkout's
// dependencies; `git worktree remove --force` would follow it, so Tower unlinks
// the link the record names first and refuses to remove a checkout holding any
// other link. Nothing below recurses into a directory.
const NODE_MODULES_LINK_NAME = 'node_modules'

/** @param {any} worktree */
function registeredNodeModulesLink(worktree) {
  const record = worktree?.nodeModulesLink
  if (!record || typeof record !== 'object') return null
  if (typeof record.target !== 'string') return null
  const linkPath = typeof record.path === 'string' && record.path.length > 0
    ? record.path
    : typeof worktree?.path === 'string'
      ? path.join(worktree.path, NODE_MODULES_LINK_NAME)
      : null
  if (linkPath === null) return null
  return { linkPath, target: record.target, createdAt: record.createdAt }
}

/**
 * The direct children of one directory with their link/type fact. `null` means
 * the store cannot enumerate/lstat, so the caller keeps today's behavior rather
 * than guessing (the real fs store always exposes both).
 * @param {any} tower
 * @param {string} dir
 * @returns {Promise<Array<{ name: string, path: string, link: boolean, directory: boolean }> | null>}
 */
async function inspectWorktreeTopLevel(tower, dir) {
  const store = tower.deps.store
  if (typeof store.readdir !== 'function') return null
  let names
  try {
    names = await store.readdir(dir)
  } catch {
    return null
  }
  const entries = []
  for (const name of [...names].sort()) {
    const entryPath = path.join(dir, name)
    let info = null
    if (typeof store.lstat === 'function') {
      try {
        info = await store.lstat(entryPath)
      } catch {
        info = null
      }
    }
    entries.push({
      name,
      path: entryPath,
      link: typeof info?.isSymbolicLink === 'function' && info.isSymbolicLink() === true,
      directory: typeof info?.isDirectory === 'function' && info.isDirectory() === true,
    })
  }
  return entries
}

/** @param {string} left @param {string} right */
function sameEntryPath(left, right) {
  try {
    return pathKey(left) === pathKey(right)
  } catch {
    return path.resolve(left) === path.resolve(right)
  }
}

/**
 * Unlink the recorded `node_modules` link just before the checkout removal, and
 * refuse the removal when any OTHER link/junction sits at the top level: git's
 * recursive delete must never walk through a link Tower cannot prove it owns.
 * @param {any} tower
 * @param {{ path: string, nodeModulesLink?: any }} worktree
 * @returns {Promise<{ available: boolean, blocked: boolean, link: any, kept: Array<{ name: string, reason: string }> }>}
 */
export async function prepareLinkSafeRemoval(tower, worktree) {
  const entries = await inspectWorktreeTopLevel(tower, worktree.path)
  if (entries === null) return { available: false, blocked: false, link: null, kept: [] }
  const registration = registeredNodeModulesLink(worktree)
  const kept = []
  for (const entry of entries) {
    if (!entry.link) continue
    if (registration && sameEntryPath(entry.path, registration.linkPath)) continue
    kept.push({
      name: entry.name,
      reason: 'unrecorded link or junction kept in place; teardown never follows or deletes a link it did not create',
    })
  }
  if (kept.length > 0) return { available: true, blocked: true, link: null, kept }
  if (!registration) return { available: true, blocked: false, link: null, kept: [] }
  const entry = entries.find((candidate) => sameEntryPath(candidate.path, registration.linkPath))
  // A recorded path that is gone needs no unlink; one that turned into a real
  // directory is not a link and is left for git to remove with the checkout.
  if (!entry || !entry.link) return { available: true, blocked: false, link: null, kept: [] }
  try {
    await tower.deps.store.unlink(registration.linkPath)
  } catch (error) {
    return {
      available: true,
      blocked: true,
      link: null,
      kept: [{ name: NODE_MODULES_LINK_NAME, reason: `the recorded node_modules link could not be unlinked: ${String(error?.message ?? error).slice(0, 160)}` }],
    }
  }
  return {
    available: true,
    blocked: false,
    link: { action: 'removed', path: registration.linkPath, target: registration.target },
    kept: [],
  }
}

/**
 * After `git worktree remove` (which may leave ignored files behind), settle the
 * residual directory without ever recursing: unlink only the recorded link,
 * remove only proved-empty directories, keep everything else and say so.
 * @param {any} tower
 * @param {string} dir
 * @param {{ path: string, nodeModulesLink?: any } | null} worktree
 * @returns {Promise<{ available: boolean, decisions: Array<{ name: string, action: string, reason: string }> }>}
 */
export async function settleResidualWorktree(tower, dir, worktree) {
  const store = tower.deps.store
  const entries = await inspectWorktreeTopLevel(tower, dir)
  if (entries === null) return { available: false, decisions: [] }
  const registration = worktree ? registeredNodeModulesLink(worktree) : null
  /** @type {Array<{ name: string, action: string, reason: string }>} */
  const decisions = []
  for (const entry of entries) {
    if (entry.link) {
      if (registration && sameEntryPath(entry.path, registration.linkPath)) {
        try {
          await store.unlink(entry.path)
          decisions.push({ name: entry.name, action: 'removed', reason: 'recorded node_modules link; its target was not touched' })
        } catch (error) {
          decisions.push({ name: entry.name, action: 'kept', reason: `the recorded link could not be unlinked: ${String(error?.message ?? error).slice(0, 160)}` })
        }
      } else {
        decisions.push({ name: entry.name, action: 'kept', reason: 'unrecorded link or junction; teardown does not delete links it did not create' })
      }
      continue
    }
    if (entry.directory) {
      if (typeof store.rmdir !== 'function') {
        decisions.push({ name: entry.name, action: 'kept', reason: 'directory kept: this store cannot remove directories' })
        continue
      }
      try {
        const children = await store.readdir(entry.path)
        if (children.length > 0) {
          decisions.push({ name: entry.name, action: 'kept', reason: 'directory is not empty' })
          continue
        }
        await store.rmdir(entry.path)
        decisions.push({ name: entry.name, action: 'removed', reason: 'empty directory' })
      } catch (error) {
        decisions.push({ name: entry.name, action: 'kept', reason: `directory kept: ${String(error?.message ?? error).slice(0, 160)}` })
      }
      continue
    }
    decisions.push({ name: entry.name, action: 'kept', reason: 'file kept; teardown removes only recorded links and empty directories' })
  }
  // Remove the now-empty shell itself, still without touching any content.
  if (typeof store.rmdir === 'function') {
    try {
      const left = await store.readdir(dir)
      if (left.length === 0) await store.rmdir(dir)
    } catch {
      // a shell that is gone or still populated is not this helper's failure
    }
  }
  return { available: true, decisions }
}

/**
 * #214: ordinary directories directly under the worktree root that neither state
 * nor `git worktree list` claims: the shells a review checkout leaves when its
 * contents were removed but the directory survived. #227: a shell holding only
 * dependency links is removable (see `classifyLeftover`); anything else is a keep
 * naming the blockers. A store without enumeration returns `available: false`
 * with the reason instead of a clean sweep. #234: `released` counts the stamped
 * worktree paths this scan was allowed to see.
 * @param {any} store
 * @param {string} root
 * @param {any} state
 * @param {Set<string>} registered canonical keys from `git worktree list`
 * @param {any} [tower] supplies the repository root and the link-target resolver
 * @returns {Promise<{ leftovers: any[], error: string | null, available: boolean, reason: string | null, released: number }>}
 */
export async function inventoryEmptyLeftovers(store, root, state, registered, tower = null) {
  const referenced = referencedCheckoutPaths(state)
  const reserved = reservedCheckoutPaths(state, root)
  const context = leftoverScanContext(tower, state)
  const released = releasedCheckoutCount(state)
  const leftovers = []
  let scan
  try {
    scan = await directChildDirectories(store, root)
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') {
      return { leftovers, error: null, available: true, reason: null, released }
    }
    return {
      leftovers,
      error: String(/** @type {any} */ (error)?.message ?? error).slice(0, 240),
      available: false,
      reason: null,
      released,
    }
  }
  if (!scan.available) return { leftovers, error: null, available: false, reason: scan.reason, released }
  for (const name of scan.directories) {
    const entryPath = path.join(root, name)
    const key = pathKey(entryPath)
    if (referenced.has(key) || reserved.has(key) || registered.has(key)) continue
    try {
      const inspection = await classifyLeftover(store, root, entryPath, context)
      leftovers.push({ name, path: entryPath, action: inspection.removable ? 'remove' : 'keep', reason: inspection.detail })
    } catch (error) {
      leftovers.push({
        name,
        path: entryPath,
        action: 'keep',
        reason: `could not inspect the directory: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 200)}`,
      })
    }
  }
  return { leftovers, error: null, available: true, reason: null, released }
}

/**
 * #214: remove the empty leftover directories the inventory marked, re-checking
 * each one on a freshly loaded state under the git lock. A path state now
 * claims, a reserved path, a registered checkout, a path outside the root, a
 * non-empty directory and a failed removal are all kept; only a directory that
 * `classifyLeftover` proved empty — or holds nothing but unlinked dependency
 * links — can be removed.
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
    const context = leftoverScanContext(tower, state)
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
        inspection = await classifyLeftover(tower.deps.store, inventory.root, entry.path, context)
      } catch (error) {
        keep(`could not inspect the directory: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 200)}`)
        continue
      }
      if (!inspection.removable) {
        keep(inspection.detail)
        continue
      }
      const unlinked = []
      let unlinkFailure = null
      for (const link of inspection.links) {
        try {
          await tower.deps.store.unlink(link.path)
          unlinked.push(link)
        } catch (error) {
          unlinkFailure = `the leftover link ${link.name} could not be unlinked: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`
          break
        }
      }
      if (unlinkFailure !== null) {
        keep(unlinkFailure)
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
      results.set(key, {
        action: 'removed',
        reason: unlinked.length > 0 ? LEFTOVER_LINK_REMOVED_REASON : 'empty leftover directory',
        ...(unlinked.length > 0 ? { links: unlinked.map(({ name, target }) => ({ name, target })) } : {}),
      })
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
    Object.assign(entry, swept)
    if (swept.action === 'removed') removed.push(entry.path)
  }
  return { decisions, removed, available: true }
}
