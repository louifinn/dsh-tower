// `tower_init` use case, split into three phases (#51):
//
//   prepare — dirty/committed/base/snapshot decisions, all lock-free (no state
//             lock and no git lock; git reads only).
//   act     — the only Git mutations (stash/update-ref/for-each-ref) run under
//             the repo-scoped git mutex, never under the state lock.
//   commit  — one short state lock writes/claims/reanchors, revalidating the
//             state revision captured by prepare.
import { withLock, withGitLock, exists, ensureDir, writeJsonAtomic, appendJsonl } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import { SCHEMA_VERSION, TERMINAL_STATUSES } from '../domain/mission.js'
import { TowerToolError } from '../lib/errors.js'

const TERMINAL = TERMINAL_STATUSES
const SNAPSHOT_REF_PREFIX = 'refs/tower/snapshot/'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

/** Phase 1 of `Tower.init` (#51). A read-only init returns its result here. */
async function prepareInit(tower, input) {
  const dirty = !(await tower.isClean(tower.root))
  const committed = ((await tower.tryGit(tower.root, ['rev-list', '-n', '1', '--all'])) ?? '').trim().length > 0

  const resolveBase = async () => {
    let base = typeof input.base === 'string' && input.base.trim() ? input.base.trim() : null
    if (base) {
      if (/^refs\//.test(base) || base.startsWith('origin/')) {
        fail(`base must be a local branch name, not ${base}`)
      }
      if (committed && (await tower.tryGit(tower.root, ['show-ref', '--verify', '--quiet', `refs/heads/${base}`])) === null) {
        fail(`base branch "${base}" does not exist locally`)
      }
      return base
    }
    base = tower.branch
    if (!base && !committed) base = 'main'
    if (!base) fail('repository is in detached HEAD; pass an explicit local base branch')
    return base
  }

  if (await exists(tower.paths.state)) {
    const state = await tower.load()
    const owner = state.towerAgentId ? String(state.towerAgentId) : null
    const caller = input.towerAgentId ? String(input.towerAgentId) : null
    if (owner && caller && owner !== caller) {
      fail(`tower state is owned by another agent; ${caller} is not the tower`, 'not-authorized')
    }
    let reanchorBase = null
    if (input.reanchor === true) {
      const active = state.missions.filter((mission) => !TERMINAL.has(mission.status))
      if (active.length > 0) {
        fail(`cannot reanchor base while ${active.length} mission(s) are not merged or abandoned`, 'invalid-transition')
      }
      reanchorBase = await resolveBase()
    }
    const claim = !owner && Boolean(caller)
    const reanchor = input.reanchor === true && reanchorBase !== state.base
    if (!claim && !reanchor) {
      return {
        early: {
          created: false,
          repoRoot: state.repoRoot,
          commonDir: state.commonDir,
          statePath: tower.paths.state,
          base: state.base,
          revision: state.revision,
          missions: state.missions.length,
          reanchored: false,
          dirty,
          snapshotCommit: state.snapshotCommit ?? null,
        },
      }
    }
    return { stateRevision: state.revision, claim, reanchor, base: reanchorBase, dirty }
  }

  return {
    create: true,
    base: await resolveBase(),
    snapshot: input.snapshotDirty === true && dirty,
    dirty,
  }
}

/**
 * Phase 2a of `Tower.init` (#51): create the dirty snapshot and its keeping ref
 * under the git mutex. The prepared "no state file yet" decision is
 * revalidated first so a concurrent init cannot leave an unreferenced snapshot.
 */
async function actInitCreate(tower, prepared) {
  return withGitLock(tower.paths, async () => {
    if (await exists(tower.paths.state)) return { stale: true }
    if (!prepared.snapshot) return { snapshotCommit: null, snapshotRef: null }
    const snapshotCommit = ((await tower.tryGit(tower.root, ['stash', 'create'])) ?? '').trim() || null
    if (!snapshotCommit) {
      fail('snapshotDirty was requested but no snapshot commit could be created; commit or stash the working tree first')
    }
    // A dangling commit can be pruned by git gc; keep a ref so the mission
    // baseline stays reachable for the life of the state.
    const snapshotRef = `${SNAPSHOT_REF_PREFIX}${snapshotCommit}`
    await tower.git(tower.root, ['update-ref', snapshotRef, snapshotCommit])
    return { snapshotCommit, snapshotRef }
  })
}

/** Phase 2b of `Tower.init` (#51): snapshot-ref cleanup for a base reanchor. */
async function actInitReanchor(tower, prepared) {
  return withGitLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== prepared.stateRevision) return { staleRevision: state.revision }
    if (state.base === prepared.base) return { deleted: [] }
    const refs =
      (await tower.tryGit(tower.root, ['for-each-ref', '--format=%(refname) %(objectname)', SNAPSHOT_REF_PREFIX])) ?? ''
    const deleted = []
    for (const line of refs.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const [ref, sha] = line.split(' ')
      if (!ref) continue
      try {
        await tower.git(tower.root, ['update-ref', '-d', ref])
        deleted.push({ ref, sha })
      } catch {
        // best effort: the single-phase code never failed init on a stale snapshot ref
      }
    }
    return { deleted }
  })
}

/** Restore snapshot refs when the reanchor commit is rejected after phase 2. */
async function restoreInitRefs(tower, deleted) {
  const entries = deleted.filter((entry) => typeof entry.sha === 'string' && entry.sha.length > 0)
  if (entries.length === 0) return
  await withGitLock(tower.paths, async () => {
    for (const entry of entries) {
      await tower.git(tower.root, ['update-ref', entry.ref, entry.sha]).catch(() => {})
    }
  })
}

/** Phase 3a of `Tower.init` (#51): write the initial state under a short lock. */
async function commitInitCreate(tower, prepared, acted, input) {
  return withLock(tower.paths, async () => {
    // Revision revalidation for the create path: prepare saw "absent", so a
    // state file that appeared meanwhile must never be overwritten.
    if (await exists(tower.paths.state)) {
      throw new TowerToolError('stale-base', 'tower state appeared while init was being prepared; retry')
    }
    const now = Date.now()
    const state = {
      schemaVersion: SCHEMA_VERSION,
      repoRoot: tower.root,
      commonDir: tower.commonDir,
      base: prepared.base,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      dirtyBase: prepared.dirty,
      ...(input.towerAgentId ? { towerAgentId: String(input.towerAgentId) } : {}),
      ...(acted.snapshotCommit ? { snapshotCommit: acted.snapshotCommit, snapshotRef: acted.snapshotRef } : {}),
      missions: [],
    }
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'init',
      text: `base ${prepared.base}${acted.snapshotCommit ? ` snapshot ${acted.snapshotCommit.slice(0, 12)}` : ''}${prepared.dirty ? ' (dirty base)' : ''}`,
    })
    return {
      created: true,
      repoRoot: tower.root,
      commonDir: tower.commonDir,
      statePath: tower.paths.state,
      base: prepared.base,
      revision: 0,
      missions: 0,
      reanchored: false,
      dirty: prepared.dirty,
      snapshotCommit: acted.snapshotCommit,
      snapshotRef: acted.snapshotRef,
    }
  })
}

/** Phase 3b of `Tower.init` (#51): owner claim and reanchor writes under a short lock. */
async function commitInitExisting(tower, prepared, input) {
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== prepared.stateRevision) {
      throw new TowerToolError(
        'stale-base',
        `tower state changed while init was being prepared (${prepared.stateRevision} -> ${state.revision}); retry`,
      )
    }
    const now = Date.now()
    const owner = state.towerAgentId ? String(state.towerAgentId) : null
    const caller = input.towerAgentId ? String(input.towerAgentId) : null
    if (owner && caller && owner !== caller) {
      fail(`tower state is owned by another agent; ${caller} is not the tower`, 'not-authorized')
    }
    if (!owner && caller) {
      state.towerAgentId = caller
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, { at: now, type: 'init', text: `tower owner claimed by ${caller}` })
    }
    let reanchored = false
    if (prepared.reanchor && state.base !== prepared.base) {
      state.base = prepared.base
      state.baseChangedAt = now
      delete state.snapshotCommit
      delete state.snapshotRef
      reanchored = true
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, { at: now, type: 'init', text: `base reanchored to ${prepared.base}` })
    }
    return {
      created: false,
      repoRoot: state.repoRoot,
      commonDir: state.commonDir,
      statePath: tower.paths.state,
      base: state.base,
      revision: state.revision,
      missions: state.missions.length,
      reanchored,
      dirty: prepared.dirty,
      snapshotCommit: state.snapshotCommit ?? null,
    }
  })
}

/** #51 two-phase init: prepare/act/commit with stale-state retries. */
export async function init(tower, input = {}) {
  await ensureDir(tower.paths.dir)
  const prepared = await prepareInit(tower, input)
  if (prepared.early) return prepared.early
  if (prepared.create) {
    const acted = await actInitCreate(tower, prepared)
    if (acted.stale) {
      throw new TowerToolError('stale-base', 'tower state appeared while init was being prepared; retry')
    }
    return commitInitCreate(tower, prepared, acted, input)
  }
  const acted = prepared.reanchor ? await actInitReanchor(tower, prepared) : { deleted: [] }
  if (acted.staleRevision !== undefined) {
    throw new TowerToolError(
      'stale-base',
      `tower state changed while init was being prepared (${prepared.stateRevision} -> ${acted.staleRevision}); retry`,
    )
  }
  try {
    return await commitInitExisting(tower, prepared, input)
  } catch (error) {
    if (acted.deleted.length > 0) await restoreInitRefs(tower, acted.deleted)
    throw error
  }
}
