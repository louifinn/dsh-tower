// Worker completion preparation and commit use cases.
import path from 'node:path'
import { TowerToolError } from '../domain/errors.js'
import {
  normalizeChecks,
  assertCompletionRequest,
  assertCompletionInbox,
  completionReport,
  applyCompletion,
} from '../domain/missions/completion.js'
import { shapeFor } from '../domain/shapes/index.js'
import { fullMission } from '../domain/summary.js'
import { validateState } from '../domain/state.js'
import { sweepArchive } from './archive.js'
import { cleanupSandbox } from './sandbox.js'
import { trackedFingerprint } from './sharedCheckout.js'

export { normalizeChecks }

/**
 * Read the primitives the shape's completion invariants need. Which reads happen
 * is declared by the shape, so this layer never asks "is this a survey?"; a
 * detached sandbox declares `requiresSandbox` and its HEAD/commit count is read
 * from the recorded sandbox path instead of the shared checkout (#148 W2).
 * @param {any} tower
 * @param {import('../types/index.js').Mission} mission
 * @param {any} invariants
 * @returns {Promise<{ commits: number, clean: boolean, dirtyPaths: string[], head: string, trackedChanged: string[], readCommit?: string, sandbox?: string | null }>}
 */
async function completionFacts(tower, mission, invariants) {
  const worktree = /** @type {any} */ (mission.worktree)
  const sandbox = invariants.requiresSandbox ? String(/** @type {any} */ (mission).sandbox ?? '') : ''
  /** @type {{ commits: number, clean: boolean, dirtyPaths: string[], head: string, trackedChanged: string[], readCommit?: string, sandbox?: string | null }} */
  const facts = { commits: 0, clean: true, dirtyPaths: [], head: '', trackedChanged: [], sandbox: sandbox || null }
  if (invariants.requiresSandbox) {
    if (!sandbox) {
      throw new TowerToolError('invalid-argument', `mission ${mission.id} has no detached sandbox recorded; re-provision it or abandon the survey`)
    }
    const entries = await tower.deps.vcs.listWorktrees(tower.root)
    if (!entries.some((entry) => entry.path && path.resolve(entry.path) === path.resolve(sandbox))) {
      throw new TowerToolError(
        'invalid-argument',
        `mission ${mission.id} detached sandbox ${sandbox} is not registered with git; the disposable checkout was removed — re-provision the survey`,
      )
    }
  }
  if (invariants.requiresWorktree) await tower.assertWorktree(worktree)
  const cwd = sandbox || worktree?.path
  if (invariants.requiresCommits) {
    const base = invariants.requiresSandbox ? /** @type {string} */ (mission.readCommit) : worktree.baseCommit
    facts.commits = await tower.deps.vcs.countCommits(cwd, base)
  }
  if (invariants.requiresClean) {
    facts.clean = await tower.deps.vcs.isClean(cwd)
    if (!facts.clean) {
      facts.dirtyPaths = (await tower.git(cwd, ['status', '--porcelain']))
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
    }
  }
  facts.readCommit = /** @type {string | undefined} */ (mission.readCommit)
  if (invariants.requiresHeadMatch || invariants.requiresTrackedStatus) {
    // A shared survey reads the shared checkout: HEAD and the tracked fingerprint
    // must match the plan-time record exactly (a path that changed either way
    // counts). A detached sandbox reads its own disposable checkout: only HEAD
    // must still equal the recorded commit; writes there are expected.
    facts.head = await tower.revParse(invariants.requiresSandbox ? sandbox : tower.root, 'HEAD')
    if (invariants.requiresTrackedStatus) {
      const current = trackedFingerprint(await tower.git(tower.root, ['status', '--porcelain']))
      const planned = new Set(mission.readDirty ?? [])
      const currentSet = new Set(current)
      facts.trackedChanged = [
        ...new Set([
          ...current.filter((path) => !planned.has(path)),
          ...(mission.readDirty ?? []).filter((path) => !currentSet.has(path)),
        ]),
      ].sort()
    }
  }
  return facts
}

export async function checkCompletion(tower, input) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === input.missionId)
  if (!mission) {
    throw new TowerToolError('invalid-argument', `unknown mission "${input.missionId}"`)
  }
  const worker = assertCompletionRequest({
    mission,
    roster: state.roster,
    input,
    maxReportBytes: tower.config.gates?.maxReportBytes,
  })
  const shape = shapeFor(mission.kind)
  const invariants = /** @type {{
   *   requiresWorktree: boolean, requiresSandbox: boolean, requiresCommits: boolean,
   *   requiresClean: boolean, requiresHeadMatch: boolean, requiresTrackedStatus: boolean,
   *   check: (ctx: any) => { commits: number },
   * }} */ ('resolveCompletion' in shape && typeof shape.resolveCompletion === 'function'
    ? shape.resolveCompletion(mission, tower.config)
    : shape.completion)
  if (invariants.requiresWorktree && !mission.worktree) {
    throw new TowerToolError('invalid-argument', `mission ${mission.id} has no worktree`)
  }
  if (invariants.requiresSandbox && !/** @type {any} */ (mission).sandbox) {
    throw new TowerToolError('invalid-argument', `mission ${mission.id} has no detached sandbox; re-provision it or abandon the survey`)
  }
  const facts = await completionFacts(tower, mission, invariants)
  const { commits } = invariants.check({ mission, ...facts })
  const unread = tower.unreadFor(state, worker.name)
  assertCompletionInbox({ mission, worker, unread })
  return { state, mission, worker, commits }
}

export async function complete(tower, input) {
  // Two-phase pilot (#51): expensive git/state checks run before the lock;
  // the lock only revalidates the state revision and commits the transition.
  const prepared = await tower.checkCompletion(input)
  const result = await tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== prepared.state.revision) {
      throw new TowerToolError('stale-base', 'tower state changed while completion was being prepared; retry')
    }
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) throw new TowerToolError('mission-not-found', `unknown mission "${input.missionId}"`)
    const { worker, commits } = prepared
    const checks = normalizeChecks(input.checks)
    const now = Date.now()
    const storedReport = completionReport({
      report: input.report,
      worker,
      checks,
      now,
      maxReportBytes: tower.config.gates?.maxReportBytes,
    })
    const applied = applyCompletion({ mission, report: storedReport, now, result: input.result })
    await sweepArchive(tower, state, { now })
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    await tower.deps.store.appendJsonl(tower.paths.activity, {
      at: now,
      type: 'complete',
      missionId: mission.id,
      text: `${worker.name} reported completion (${commits} commit(s))`,
    })
    tower.emitEvents(applied.events, { revision: state.revision, at: now })
    return { mission: fullMission(mission), commits, unread: 0 }
  })
  // The completion transition is durable at this point. Removing the disposable
  // sandbox is advisory: a failed cleanup is reported, never rolled back into
  // the mission state or allowed to fail the completion.
  let sandboxCleanup = null
  if (result.mission.sandbox) {
    const sandbox = result.mission.sandbox
    try {
      sandboxCleanup = await cleanupSandbox(tower, input.missionId)
    } catch (error) {
      sandboxCleanup = {
        ok: false,
        removed: false,
        attempts: 0,
        path: sandbox,
        error: String(error?.message ?? error).slice(0, 400),
      }
    }
    if (sandboxCleanup?.ok) {
      delete result.mission.sandbox
      delete result.mission.sandboxCleanupError
    }
  }
  return { ...result, ...(sandboxCleanup ? { sandboxCleanup } : {}) }
}
