// `tower_provision` use case, split into three phases (#51):
//
//   prepare — mission/base commit/worktree identity, all lock-free.
//   act     — revalidate the prepared revision, then `git worktree add` (and
//             its supporting exclude/canonical reads) under the git mutex.
//   commit  — one short state lock revalidates the revision and that the
//             mission still has no worktree, then records it. A rejected
//             commit rolls the created worktree/branch back outside the lock.
import path from 'node:path'
import { withLock, withGitLock, exists, ensureDir, writeJsonAtomic, appendJsonl, shortHash } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import { canonicalPath } from '../lib/worktreeOwnership.js'
import { TowerToolError } from '../lib/errors.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug || 'mission'
}

/** Phase 1 of `Tower.provision` (#51). An existing worktree returns here. */
async function prepareProvision(tower, input) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === input.missionId)
  if (!mission) fail(`unknown mission "${input.missionId}"`, 'mission-not-found')
  if (mission.worktree) {
    await tower.assertWorktree(mission.worktree)
    return { early: { mission, worktree: mission.worktree, created: false } }
  }
  const baseCommit = input.baseCommit
    ? String(input.baseCommit)
    : input.includeDirtyBase === false
      ? await tower.revParse(tower.root, state.base)
      : state.snapshotCommit && (await tower.tryGit(tower.root, ['cat-file', '-e', `${state.snapshotCommit}^{commit}`])) !== null
        ? state.snapshotCommit
        : await tower.revParse(tower.root, state.base)
  const branch = `tower/${mission.id.toLowerCase()}-${slugify(mission.title)}`
  const configuredRoot = tower.config.worktrees.root
  const root = input.worktreeRoot
    ? path.resolve(input.worktreeRoot)
    : configuredRoot
      ? path.resolve(configuredRoot)
      : path.join(path.dirname(tower.root), '.dsh-tower-worktrees', shortHash(tower.commonDir))
  if (!path.isAbsolute(root)) fail('worktreeRoot must be an absolute path')
  tower.assertOutside(root)
  await ensureDir(root)
  const wtPath = path.join(root, mission.id)
  if (await exists(wtPath)) fail(`worktree path already exists: ${wtPath}`)
  if ((await tower.tryGit(tower.root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null) {
    fail(`branch already exists: ${branch}`)
  }
  return { stateRevision: state.revision, missionId: mission.id, baseCommit, branch, wtPath }
}

/** Phase 2 of `Tower.provision` (#51): no state lock, worktree add under the git mutex. */
async function actProvision(tower, prepared) {
  return withGitLock(tower.paths, async () => {
    let fresh
    try {
      fresh = await tower.load()
    } catch (error) {
      return { phase: 'stale', detail: String(error?.message ?? error) }
    }
    if (fresh.revision !== prepared.stateRevision) {
      return { phase: 'stale', detail: `state revision changed from ${prepared.stateRevision} to ${fresh.revision}` }
    }
    const mission = fresh.missions.find((entry) => entry.id === prepared.missionId)
    if (!mission) return { phase: 'missing' }
    if (mission.worktree) {
      await tower.assertWorktree(mission.worktree)
      return { phase: 'existing', mission, worktree: mission.worktree }
    }
    if (await exists(prepared.wtPath)) fail(`worktree path already exists: ${prepared.wtPath}`)
    if ((await tower.tryGit(tower.root, ['show-ref', '--verify', '--quiet', `refs/heads/${prepared.branch}`])) !== null) {
      fail(`branch already exists: ${prepared.branch}`)
    }
    await tower.git(tower.root, ['worktree', 'add', '-b', prepared.branch, prepared.wtPath, prepared.baseCommit])
    await tower.ensureExcluded(prepared.wtPath)
    const worktree = {
      path: prepared.wtPath,
      branch: prepared.branch,
      baseCommit: prepared.baseCommit,
      createdAt: Date.now(),
      realPath: await canonicalPath(prepared.wtPath),
    }
    return { phase: 'created', worktree }
  })
}

/** Phase 3 of `Tower.provision` (#51): record the worktree under a short lock. */
async function commitProvision(tower, prepared, acted) {
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === prepared.missionId)
    if (!mission) throw new TowerToolError('mission-not-found', `unknown mission "${prepared.missionId}"`)
    // Revision revalidation: the plan was built from prepared.stateRevision.
    if (state.revision !== prepared.stateRevision) return { phase: 'stale', revision: state.revision }
    // Never overwrite a worktree another writer recorded while git ran.
    if (mission.worktree) return { phase: 'existing', mission, worktree: mission.worktree }
    const now = acted.worktree.createdAt
    mission.worktree = acted.worktree
    mission.baseCommit = prepared.baseCommit
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now
    try {
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
    } catch (error) {
      return { phase: 'persist-error', error }
    }
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'worktree',
      missionId: prepared.missionId,
      text: `${prepared.branch} at ${prepared.wtPath}`,
    }).catch(() => {})
    return { phase: 'committed', mission, worktree: acted.worktree }
  })
}

/** Undo a created worktree/branch outside the state lock (git mutex only). */
async function rollbackProvision(tower, prepared) {
  await withGitLock(tower.paths, async () => {
    await tower.git(tower.root, ['worktree', 'remove', '--force', prepared.wtPath]).catch(() => {})
    await tower.git(tower.root, ['branch', '-D', prepared.branch]).catch(() => {})
  })
}

/** #51 two-phase provision: prepare/act/commit with rollback on rejection. */
export async function provision(tower, input = {}) {
  const missionId = input.missionId
  if (typeof missionId !== 'string' || missionId.trim().length === 0) {
    fail('tower_spawn requires missionId in this version')
  }
  const prepared = await prepareProvision(tower, input)
  if (prepared.early) return prepared.early

  const acted = await actProvision(tower, prepared)
  if (acted.phase === 'existing') return { mission: acted.mission, worktree: acted.worktree, created: false }
  if (acted.phase === 'missing') fail(`unknown mission "${prepared.missionId}"`, 'mission-not-found')
  if (acted.phase === 'stale') {
    throw new TowerToolError(
      'stale-base',
      `tower state changed while the worktree was being prepared (${acted.detail}); no worktree was created — retry`,
    )
  }

  let committed
  try {
    committed = await commitProvision(tower, prepared, acted)
  } catch (error) {
    // The worktree already exists. A commit that cannot even take the state
    // lock must not leave the mission wedged with an unrecorded worktree.
    await rollbackProvision(tower, prepared)
    throw error
  }
  if (committed.phase === 'stale') {
    await rollbackProvision(tower, prepared)
    throw new TowerToolError(
      'stale-base',
      `tower state changed while the worktree was being created (${prepared.stateRevision} -> ${committed.revision}); the new worktree was rolled back — retry`,
    )
  }
  if (committed.phase === 'existing') {
    // Another writer recorded a worktree for this mission while git ran; the
    // one created here is orphaned, so remove it and report the recorded one.
    await rollbackProvision(tower, prepared)
    await tower.assertWorktree(committed.worktree)
    return { mission: committed.mission, worktree: committed.worktree, created: false }
  }
  if (committed.phase === 'persist-error') {
    // Preserve the single-phase rollback: a failed state write must not leave
    // an untracked worktree/branch behind.
    await rollbackProvision(tower, prepared)
    throw committed.error
  }
  return { mission: committed.mission, worktree: committed.worktree, created: true }
}
