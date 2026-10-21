// Worker completion preparation and commit use cases.
import { TowerToolError } from '../errors.js'
import { fullMission } from '../domain/summary.js'
import { validateState } from '../domain/state.js'
import { countCommits, isClean } from '../git.js'
import { withLock, writeJsonAtomic, appendJsonl } from '../store.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeChecks(checks) {
  if (checks === undefined) return []
  if (!Array.isArray(checks)) fail('checks must be an array')
  if (checks.length > 20) fail('checks may contain at most 20 entries')
  return checks.map((check, index) => {
    if (!isPlainObject(check)) fail(`checks[${index}] must be an object`)
    const name = typeof check.name === 'string' ? check.name.trim() : ''
    if (!name) fail(`checks[${index}].name must be a non-empty string`)
    const entry = { name }
    if (typeof check.command === 'string' && check.command.trim()) entry.command = check.command.trim()
    if (check.exitCode !== undefined && check.exitCode !== null) {
      if (!Number.isInteger(check.exitCode)) fail(`checks[${index}].exitCode must be an integer`)
      entry.exitCode = check.exitCode
    }
    if (typeof check.evidence === 'string' && check.evidence.trim()) entry.evidence = check.evidence.trim().slice(0, 4000)
    return entry
  })
}

export async function checkCompletion(tower, input) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === input.missionId)
  if (!mission) fail(`unknown mission "${input.missionId}"`)
  const worker = (state.roster ?? []).find((entry) => entry.agentId === input.agentId)
  if (!worker || worker.missionId !== mission.id) {
    fail(`agent ${input.agentId} is not assigned to mission ${mission.id}`)
  }
  if (worker.role !== 'worker') fail(`agent ${worker.name} is a ${worker.role}, not a worker`)
  if (['retired', 'failed', 'interrupted', 'missing', 'stale'].includes(worker.state)) {
    fail(`agent ${worker.name} is ${worker.state}; a stopped worker cannot report completion`)
  }
  if (mission.owner && mission.owner !== worker.name) {
    fail(`agent ${worker.name} is not the current owner of mission ${mission.id} (owner: ${mission.owner})`)
  }
  if (mission.status === 'completed') fail(`mission ${mission.id} is already completed`)
  if (!['active', 'planned'].includes(mission.status)) {
    fail(`mission ${mission.id} is ${mission.status}; it cannot be completed from that state`)
  }
  if (typeof input.report !== 'string' || input.report.trim().length === 0) {
    fail('tower_complete requires a non-empty report')
  }
  const openTasks = mission.tasks.filter((task) => task.status === 'open')
  if (openTasks.length > 0) {
    fail(
      `mission ${mission.id} still has ${openTasks.length} open task(s): ${openTasks
        .map((task) => task.text)
        .join('; ')}`,
    )
  }
  if ((mission.blockers ?? []).length > 0) {
    fail(`mission ${mission.id} has unresolved blockers: ${mission.blockers.join('; ')}`)
  }
  if (!mission.worktree) fail(`mission ${mission.id} has no worktree`)
  await tower.assertWorktree(mission.worktree)
  const commits = await countCommits(mission.worktree.path, mission.worktree.baseCommit)
  if (commits < 1) {
    fail(`mission branch has no commits since ${String(mission.worktree.baseCommit).slice(0, 12)}`)
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
  if (unread.length > 0) {
    fail(
      `mission ${mission.id} cannot complete with ${unread.length} unread inbox message(s) for ${worker.name}; call tower_inbox until unread is 0, incorporate them, then retry`,
    )
  }
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
    mission.completionReport = { report: input.report.trim(), by: worker.name, at: now, checks }
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
