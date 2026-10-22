// `tower_provision` use case, split into three phases (#51):
//
//   prepare — mission/base commit/worktree identity, all lock-free.
//   act     — revalidate the prepared revision, then `git worktree add` (and
//             its supporting exclude/canonical reads) under the git mutex.
//   commit  — one short state lock revalidates the revision and that the
//             mission still has no worktree, then records it. A rejected
//             commit rolls the created worktree/branch back outside the lock.
import path from 'node:path'
import { validateState } from '../domain/state.js'
import { TowerToolError } from '../domain/errors.js'
import {
  baseCommitChoice,
  createdWorktreeResult,
  existingWorktreeResult,
  hasMissionId,
  provisionActivityText,
  worktreeBranch,
  worktreePath,
  worktreeRecord,
  worktreeRoot,
} from '../domain/integration/provision.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

/** Phase 1 of `Tower.provision` (#51). An existing worktree returns here. */
async function prepareProvision(tower, input) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === input.missionId)
  if (!mission) fail(`unknown mission "${input.missionId}"`, 'mission-not-found')
  if (mission.worktree) {
    await tower.assertWorktree(mission.worktree)
    return { early: existingWorktreeResult(mission, mission.worktree) }
  }
  const needsSnapshot = !input.baseCommit && input.includeDirtyBase !== false
  const snapshotCommitValid =
    needsSnapshot && state.snapshotCommit
      ? (await tower.tryGit(tower.root, ['cat-file', '-e', `${state.snapshotCommit}^{commit}`])) !== null
      : false
  const choice = baseCommitChoice({
    baseCommit: input.baseCommit,
    includeDirtyBase: input.includeDirtyBase,
    snapshotCommit: state.snapshotCommit,
    snapshotCommitValid,
  })
  const baseCommit = 'commit' in choice ? choice.commit : await tower.revParse(tower.root, state.base)
  const branch = worktreeBranch(mission)
  const root = worktreeRoot({
    worktreeRoot: input.worktreeRoot,
    configuredRoot: tower.config.worktrees.root,
    repoRoot: tower.root,
    commonDirHash: tower.deps.ids.shortHash(tower.commonDir),
  })
  if (!path.isAbsolute(root)) fail('worktreeRoot must be an absolute path')
  tower.assertOutside(root)
  await tower.deps.store.ensureDir(root)
  const wtPath = worktreePath(root, mission.id)
  if (await tower.deps.store.exists(wtPath)) fail(`worktree path already exists: ${wtPath}`)
  if ((await tower.tryGit(tower.root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null) {
    fail(`branch already exists: ${branch}`)
  }
  return { stateRevision: state.revision, missionId: mission.id, baseCommit, branch, wtPath }
}

/** Phase 2 of `Tower.provision` (#51): no state lock, worktree add under the git mutex. */
async function actProvision(tower, prepared) {
  return tower.deps.store.withGitLock(tower.paths, async () => {
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
    if (await tower.deps.store.exists(prepared.wtPath)) fail(`worktree path already exists: ${prepared.wtPath}`)
    if ((await tower.tryGit(tower.root, ['show-ref', '--verify', '--quiet', `refs/heads/${prepared.branch}`])) !== null) {
      fail(`branch already exists: ${prepared.branch}`)
    }
    await tower.git(tower.root, ['worktree', 'add', '-b', prepared.branch, prepared.wtPath, prepared.baseCommit])
    await tower.ensureExcluded(prepared.wtPath)
    const worktree = worktreeRecord({
      path: prepared.wtPath,
      branch: prepared.branch,
      baseCommit: prepared.baseCommit,
      createdAt: Date.now(),
      realPath: await tower.deps.ownership.canonicalPath(prepared.wtPath),
    })
    return { phase: 'created', worktree }
  }, tower.gitMutexOptions({ phase: 'provision' }))
}

/** Phase 3 of `Tower.provision` (#51): record the worktree under a short lock. */
async function commitProvision(tower, prepared, acted) {
  return tower.deps.store.withLock(tower.paths, async () => {
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
      await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    } catch (error) {
      return { phase: 'persist-error', error }
    }
    await tower.deps.store.appendJsonl(tower.paths.activity, {
      at: now,
      type: 'worktree',
      missionId: prepared.missionId,
      text: provisionActivityText(prepared.branch, prepared.wtPath),
    }).catch(() => {})
    return { phase: 'committed', mission, worktree: acted.worktree }
  })
}

/** Undo a created worktree/branch outside the state lock (git mutex only). */
async function rollbackProvision(tower, prepared) {
  await tower.deps.store.withGitLock(tower.paths, async () => {
    await tower.git(tower.root, ['worktree', 'remove', '--force', prepared.wtPath]).catch(() => {})
    await tower.git(tower.root, ['branch', '-D', prepared.branch]).catch(() => {})
  }, tower.gitMutexOptions({ phase: 'provision' }))
}

/** #51 two-phase provision: prepare/act/commit with rollback on rejection. */
export async function provision(tower, input = {}) {
  const missionId = input.missionId
  if (!hasMissionId(missionId)) {
    fail('tower_spawn requires missionId in this version')
  }
  const prepared = await prepareProvision(tower, input)
  if (prepared.early) return prepared.early

  const acted = await actProvision(tower, prepared)
  if (acted.phase === 'existing') return existingWorktreeResult(acted.mission, acted.worktree)
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
    return existingWorktreeResult(committed.mission, committed.worktree)
  }
  if (committed.phase === 'persist-error') {
    // Preserve the single-phase rollback: a failed state write must not leave
    // an untracked worktree/branch behind.
    await rollbackProvision(tower, prepared)
    throw committed.error
  }
  return createdWorktreeResult(committed.mission, committed.worktree)
}
