// `tower_provision` use case, split into three phases (#51):
//
//   prepare — mission/base commit/worktree identity, all lock-free.
//   act     — revalidate the prepared revision, then the git mutation (and its
//             supporting exclude/canonical reads) under the git mutex.
//   commit  — one short state lock revalidates the revision and that the
//             mission still has no worktree, then records it. A rejected
//             commit rolls the created worktree/branch (or survey sandbox)
//             back outside the lock.
//
// #148 W2: a survey resolves its placement through its shape. `shared` keeps the
// old no-provisioning path; `detached` creates a disposable detached worktree at
// the recorded readCommit (no branch, no baseCommit, never merged).
import path from 'node:path'
import { validateState } from '../domain/state.js'
import { TowerToolError } from '../domain/errors.js'
import { provisioningFor } from '../domain/shapes/index.js'
import {
  baseCommitChoice,
  createdWorktreeResult,
  detachedSandboxResult,
  existingWorktreeResult,
  hasMissionId,
  provisionActivityText,
  sandboxActivityText,
  sandboxPath,
  sharedProvisionResult,
  worktreeBranch,
  worktreePath,
  worktreeRecord,
  worktreeRoot,
} from '../domain/integration/provision.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

/**
 * Resolve the parent directory for mission checkouts and refuse an unsafe one.
 * @param {any} tower
 * @param {any} input
 * @returns {string}
 */
export function resolveCheckoutRoot(tower, input) {
  const root = worktreeRoot({
    worktreeRoot: input.worktreeRoot,
    configuredRoot: tower.config.worktrees.root,
    repoRoot: tower.root,
    commonDirHash: tower.deps.ids.shortHash(tower.commonDir),
  })
  if (!path.isAbsolute(root)) fail('worktreeRoot must be an absolute path')
  tower.assertOutside(root)
  return root
}

/**
 * True when `mission.sandbox` is a worktree registered with git and still at the
 * recorded readCommit. A recorded path that git no longer knows is treated as
 * gone so a failed cleanup does not wedge a re-provision; a registered sandbox
 * whose HEAD moved is a refusal (its contents are the worker's work, not ours
 * to discard silently).
 * @param {any} tower
 * @param {import('../types/index.js').Mission} mission
 * @returns {Promise<boolean>}
 */
async function sandboxIsCurrent(tower, mission) {
  const sandbox = /** @type {any} */ (mission).sandbox
  if (typeof sandbox !== 'string' || sandbox.length === 0) return false
  const entries = await tower.deps.vcs.listWorktrees(tower.root)
  const registered = entries.some((entry) => path.resolve(entry.path) === path.resolve(sandbox))
  if (!registered) return false
  const head = await tower.revParse(sandbox, 'HEAD')
  if (head !== mission.readCommit) {
    fail(
      `detached sandbox ${sandbox} is at ${String(head).slice(0, 12)}, not the recorded readCommit ${String(mission.readCommit).slice(0, 12)}; inspect it or remove it before provisioning again`,
    )
  }
  return true
}

/** Phase 1 of `Tower.provision` (#51). An existing checkout returns here. */
async function prepareProvision(tower, input) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === input.missionId)
  if (!mission) fail(`unknown mission "${input.missionId}"`, 'mission-not-found')
  const provisioning = provisioningFor(mission.kind, tower.config, mission)
  // A shared-checkout shape reads one commit in the main checkout: no branch,
  // no directory, no recorded worktree (#148 D1/D2).
  if (provisioning === 'shared') {
    return { early: sharedProvisionResult(mission, tower.root) }
  }
  // #148 W2: a detached survey owns a disposable checkout, not a mission
  // branch. The recorded readCommit is the only base it has.
  if (provisioning === 'detached') {
    const readCommit = mission.readCommit
    if (typeof readCommit !== 'string' || readCommit.length === 0) {
      fail('a detached survey needs the commit it reads (readCommit); re-plan the survey from a resolved base', 'invalid-argument')
    }
    if (await sandboxIsCurrent(tower, mission)) {
      return { early: detachedSandboxResult(mission, /** @type {string} */ (mission.sandbox), false) }
    }
    const root = resolveCheckoutRoot(tower, input)
    await tower.deps.store.ensureDir(root)
    const wtPath = sandboxPath(root, mission.id)
    if (await tower.deps.store.exists(wtPath)) fail(`sandbox path already exists: ${wtPath}`)
    return { stateRevision: state.revision, missionId: mission.id, mode: 'detached', readCommit, wtPath }
  }
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
  const root = resolveCheckoutRoot(tower, input)
  await tower.deps.store.ensureDir(root)
  const wtPath = worktreePath(root, mission.id)
  if (await tower.deps.store.exists(wtPath)) fail(`worktree path already exists: ${wtPath}`)
  if ((await tower.tryGit(tower.root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null) {
    fail(`branch already exists: ${branch}`)
  }
  return { stateRevision: state.revision, missionId: mission.id, baseCommit, branch, wtPath }
}

/** Phase 2 of `Tower.provision` (#51): no state lock, git work under the mutex. */
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
    if (prepared.mode === 'detached') {
      if (await sandboxIsCurrent(tower, mission)) {
        return { phase: 'existing-sandbox', mission, sandbox: /** @type {any} */ (mission).sandbox }
      }
      if (await tower.deps.store.exists(prepared.wtPath)) fail(`sandbox path already exists: ${prepared.wtPath}`)
      // `--detach` creates no branch: the sandbox is a read-only commit checkout
      // that the agent may dirty, and it never participates in merge/stale-base.
      await tower.git(tower.root, ['worktree', 'add', '--detach', prepared.wtPath, prepared.readCommit])
      await tower.ensureExcluded(prepared.wtPath)
      return { phase: 'created-sandbox', sandbox: prepared.wtPath }
    }
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

/** Phase 3 of `Tower.provision` (#51): record the checkout under a short lock. */
async function commitProvision(tower, prepared, acted) {
  return tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === prepared.missionId)
    if (!mission) throw new TowerToolError('mission-not-found', `unknown mission "${prepared.missionId}"`)
    // Revision revalidation: the plan was built from prepared.stateRevision.
    if (state.revision !== prepared.stateRevision) return { phase: 'stale', revision: state.revision }
    const now = Date.now()
    if (prepared.mode === 'detached') {
      // Never overwrite a sandbox another writer recorded while git ran.
      if (mission.sandbox) return { phase: 'existing-sandbox', mission, sandbox: mission.sandbox }
      mission.sandbox = acted.sandbox
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
        type: 'sandbox',
        missionId: prepared.missionId,
        text: sandboxActivityText(acted.sandbox, prepared.readCommit),
      }).catch(() => {})
      return { phase: 'committed-sandbox', mission, sandbox: acted.sandbox }
    }
    // Never overwrite a worktree another writer recorded while git ran.
    if (mission.worktree) return { phase: 'existing', mission, worktree: mission.worktree }
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

/** Undo a created checkout outside the state lock (git mutex only). */
async function rollbackProvision(tower, prepared) {
  await tower.deps.store.withGitLock(tower.paths, async () => {
    await tower.git(tower.root, ['worktree', 'remove', '--force', prepared.wtPath]).catch(() => {})
    if (prepared.mode !== 'detached' && prepared.branch) {
      await tower.git(tower.root, ['branch', '-D', prepared.branch]).catch(() => {})
    }
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
  if (acted.phase === 'existing-sandbox') {
    return detachedSandboxResult(acted.mission, acted.sandbox, false)
  }
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
    // The checkout already exists. A commit that cannot even take the state
    // lock must not leave the mission wedged with an unrecorded checkout.
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
  if (committed.phase === 'existing' || committed.phase === 'existing-sandbox') {
    // Another writer recorded a checkout for this mission while git ran; the
    // one created here is orphaned, so remove it and report the recorded one.
    await rollbackProvision(tower, prepared)
    if (committed.phase === 'existing-sandbox') {
      return detachedSandboxResult(committed.mission, committed.sandbox, false)
    }
    await tower.assertWorktree(committed.worktree)
    return existingWorktreeResult(committed.mission, committed.worktree)
  }
  if (committed.phase === 'persist-error') {
    // Preserve the single-phase rollback: a failed state write must not leave
    // an untracked worktree/branch (or survey sandbox) behind.
    await rollbackProvision(tower, prepared)
    throw committed.error
  }
  if (committed.phase === 'committed-sandbox') {
    return detachedSandboxResult(committed.mission, committed.sandbox, true)
  }
  return createdWorktreeResult(committed.mission, committed.worktree)
}
