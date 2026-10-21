// Read-only dashboard/detail use cases.
import { TowerToolError } from '../domain/errors.js'
import { diffView, missionDetailView, statusView } from '../domain/read/views.js'
import { readActivityTail } from '../lib/store.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export async function missionDetail(tower, missionId) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === missionId)
  if (!mission) fail(`unknown mission "${missionId}"`, 'mission-not-found')
  const activity = await readActivityTail(tower.paths.activity, 200)
  return missionDetailView({ state, mission, activity })
}

export async function status(tower, input = {}) {
  const state = await tower.load()
  const activity = await readActivityTail(tower.paths.activity, 12)
  return statusView({
    state,
    statePath: tower.paths.state,
    activity,
    unreadTower: tower.unreadFor(state, 'tower').length,
    config: tower.config,
    missions: await tower.enrichedMissions(state, input.missionIds),
  })
}

export async function diff(tower, input = {}) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === input.missionId)
  if (!mission) fail(`unknown mission "${input.missionId}"`, 'mission-not-found')
  if (!mission.worktree) fail(`mission ${mission.id} has no worktree to diff`)
  await tower.assertWorktree(mission.worktree)
  const baseTip = await tower.revParse(tower.root, state.base)
  const branchTip = await tower.revParse(mission.worktree.path, 'HEAD')
  const mergeBase = (await tower.git(mission.worktree.path, ['merge-base', baseTip, branchTip])).trim()
  const files = (await tower.git(mission.worktree.path, ['diff', '--name-status', `${mergeBase}..${branchTip}`]))
    .split('\n')
    .filter(Boolean)
  const commits = (await tower.git(mission.worktree.path, ['log', '--oneline', `${mergeBase}..${branchTip}`]))
    .split('\n')
    .filter(Boolean)
  const fullPatch = await tower.git(mission.worktree.path, ['diff', `${mergeBase}..${branchTip}`])
  return diffView({
    mission,
    baseTip,
    branchTip,
    mergeBase,
    files,
    commits,
    fullPatch,
    maxBytes: input.maxBytes,
  })
}
