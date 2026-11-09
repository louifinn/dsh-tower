// Worker completion preparation and commit use cases.
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
import { trackedFingerprint } from './sharedCheckout.js'

export { normalizeChecks }

/**
 * Read the primitives the shape's completion invariants need. Which reads happen
 * is declared by the shape, so this layer never asks "is this a survey?".
 * @param {any} tower
 * @param {import('../types/index.js').Mission} mission
 * @param {any} invariants
 * @returns {Promise<{ commits: number, clean: boolean, dirtyPaths: string[], head: string, trackedChanged: string[] }>}
 */
async function completionFacts(tower, mission, invariants) {
  const worktree = /** @type {any} */ (mission.worktree)
  /** @type {{ commits: number, clean: boolean, dirtyPaths: string[], head: string, trackedChanged: string[], readCommit?: string }} */
  const facts = { commits: 0, clean: true, dirtyPaths: [], head: '', trackedChanged: [] }
  if (invariants.requiresWorktree) await tower.assertWorktree(worktree)
  if (invariants.requiresCommits) {
    facts.commits = await tower.deps.vcs.countCommits(worktree.path, worktree.baseCommit)
  }
  if (invariants.requiresClean) {
    facts.clean = await tower.deps.vcs.isClean(worktree.path)
    if (!facts.clean) {
      facts.dirtyPaths = (await tower.git(worktree.path, ['status', '--porcelain']))
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
    }
  }
  facts.readCommit = /** @type {string | undefined} */ (mission.readCommit)
  if (invariants.requiresHeadMatch || invariants.requiresTrackedStatus) {
    // A survey reads the shared checkout: HEAD and the tracked fingerprint must
    // match the plan-time record exactly (a path that changed either way counts).
    facts.head = await tower.revParse(tower.root, 'HEAD')
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
  const invariants = shapeFor(mission.kind).completion
  if (invariants.requiresWorktree && !mission.worktree) {
    throw new TowerToolError('invalid-argument', `mission ${mission.id} has no worktree`)
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
  return tower.deps.store.withLock(tower.paths, async () => {
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
}
