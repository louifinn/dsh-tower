// Worker completion preparation and commit use cases.
import { TowerToolError } from '../domain/errors.js'
import {
  normalizeChecks,
  assertCompletionRequest,
  assertCompletionInbox,
  completionReport,
} from '../domain/missions/completion.js'
import { fullMission } from '../domain/summary.js'
import { validateState } from '../domain/state.js'
import { countCommits, isClean } from '../lib/git.js'
import { withLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'

export { normalizeChecks }

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
  await tower.assertWorktree(mission.worktree)
  const commits = await countCommits(mission.worktree.path, mission.worktree.baseCommit)
  if (commits < 1) {
    throw new TowerToolError(
      'invalid-argument',
      `mission branch has no commits since ${String(mission.worktree.baseCommit).slice(0, 12)}`,
    )
  }
  if (!(await isClean(mission.worktree.path))) {
    const dirty = (await tower.git(mission.worktree.path, ['status', '--porcelain']))
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
    throw new TowerToolError(
      'worktree-dirty',
      `mission ${mission.id} worktree has uncommitted changes (${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}); commit, remove, or record them before tower_complete`,
    )
  }
  const unread = tower.unreadFor(state, worker.name)
  assertCompletionInbox({ mission, worker, unread })
  return { state, mission, worker, commits }
}

export async function complete(tower, input) {
  // Two-phase pilot (#51): expensive git/state checks run before the lock;
  // the lock only revalidates the state revision and commits the transition.
  const prepared = await tower.checkCompletion(input)
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== prepared.state.revision) {
      throw new TowerToolError('stale-base', 'tower state changed while completion was being prepared; retry')
    }
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) throw new TowerToolError('mission-not-found', `unknown mission "${input.missionId}"`)
    const { worker, commits } = prepared
    const checks = normalizeChecks(input.checks)
    const now = Date.now()
    mission.status = 'completed'
    mission.completionReport = completionReport({
      report: input.report,
      worker,
      checks,
      now,
      maxReportBytes: tower.config.gates?.maxReportBytes,
    })
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'complete',
      missionId: mission.id,
      text: `${worker.name} reported completion (${commits} commit(s))`,
    })
    return { mission: fullMission(mission), commits, unread: 0 }
  })
}
