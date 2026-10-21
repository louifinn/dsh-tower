// Read-only dashboard/detail use cases.
import { TowerToolError } from '../errors.js'
import { MISSION_STATUSES, FINDING_STATUSES } from '../domain/mission.js'
import { taskCounts, fullMission, findingSummary } from '../domain/summary.js'
import { readActivityTail } from '../store.js'
import { git } from '../git.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export async function missionDetail(tower, missionId) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === missionId)
  if (!mission) fail(`unknown mission "${missionId}"`, 'mission-not-found')
  const branch = mission.worktree ? mission.worktree.branch : null
  const reviews = (state.reviews ?? [])
    .filter((review) => review.missionId === mission.id || (branch && review.branch === branch))
    .slice()
    .sort((a, b) => b.round - a.round)
  const findings = (state.findings ?? []).filter((finding) => finding.missionId === mission.id)
  const activity = (await readActivityTail(tower.paths.activity, 200)).filter((entry) => entry.missionId === mission.id)
  return {
    mission: fullMission(mission),
    reviews: reviews.slice(0, 10),
    findings: findings.slice(-10).map((finding) => findingSummary(finding)),
    activity: activity.slice(-20),
  }
}

export async function status(tower, input = {}) {
  const state = await tower.load()
  const activity = await readActivityTail(tower.paths.activity, 12)
  const counts = {}
  for (const status of MISSION_STATUSES) counts[status] = 0
  for (const mission of state.missions) counts[mission.status] = (counts[mission.status] ?? 0) + 1
  const openTasks = state.missions.reduce((sum, mission) => sum + taskCounts(mission.tasks).open, 0)
  const findingsByStatus = {}
  for (const findingStatus of FINDING_STATUSES) findingsByStatus[findingStatus] = 0
  for (const finding of state.findings ?? []) {
    const findingStatus = finding.status ?? 'open'
    findingsByStatus[findingStatus] = (findingsByStatus[findingStatus] ?? 0) + 1
  }
  return {
    repoRoot: state.repoRoot,
    commonDir: state.commonDir,
    statePath: tower.paths.state,
    base: state.base,
    revision: state.revision,
    counts,
    openTasks,
    roster: (state.roster ?? []).length,
    messages: (state.messages ?? []).length,
    unreadTower: tower.unreadFor(state, 'tower').length,
    findings: (state.findings ?? []).length,
    findingsByStatus,
    reviews: (state.reviews ?? []).length,
    config: {
      path: tower.config.configPath ?? null,
      repoConfigPresent: tower.config.repoConfigPresent === true,
      spawn: {
        workerPreset: tower.config.spawn?.workerPreset ?? null,
        reviewerPreset: tower.config.spawn?.reviewerPreset ?? null,
      },
    },
    recentFindings: (state.findings ?? []).slice(-5).map((finding) => ({
      id: finding.id,
      type: finding.type,
      severity: finding.severity,
      status: finding.status ?? 'open',
      title: finding.title,
      missionId: finding.missionId,
      reportedBy: finding.reportedBy,
      at: finding.at,
    })),
    missions: await tower.enrichedMissions(state, input.missionIds),
    activity,
  }
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
  const limit = Number.isInteger(input.maxBytes) && input.maxBytes > 0 ? input.maxBytes : 64 * 1024
  return {
    missionId: mission.id,
    branch: mission.worktree.branch,
    baseTip,
    branchTip,
    mergeBase,
    files,
    commits,
    truncated: fullPatch.length > limit,
    patch: fullPatch.slice(0, limit),
  }
}
