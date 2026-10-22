// Pure read-model projections for the status/detail/diff use cases. Loading
// state, reading the activity tail, and running Git stay in app/read.js.
// @ts-check
import { FINDING_STATUSES, MISSION_STATUSES } from '../mission.js'
import { fullMission, findingSummary, taskCounts } from '../summary.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

/**
 * @param {object} input
 * @param {TowerState} input.state
 * @param {Mission} input.mission
 * @param {Array<Record<string, unknown>>} input.activity
 * @returns {object}
 */
export function missionDetailView({ state, mission, activity }) {
  const branch = mission.worktree ? mission.worktree.branch : null
  const reviews = (state.reviews ?? [])
    .filter((review) => review.missionId === mission.id || (branch && review.branch === branch))
    .slice()
    .sort((left, right) => right.round - left.round)
  const findings = (state.findings ?? []).filter((finding) => finding.missionId === mission.id)
  const missionActivity = activity.filter((entry) => entry.missionId === mission.id)
  return {
    mission: fullMission(mission),
    reviews: reviews.slice(0, 10),
    findings: findings.slice(-10).map((finding) => findingSummary(finding)),
    activity: missionActivity.slice(-20),
  }
}

/**
 * @param {object} input
 * @param {TowerState} input.state
 * @param {string} input.statePath
 * @param {Array<Record<string, unknown>>} input.activity
 * @param {number} input.unreadTower
 * @param {object} input.config
 * @param {object[]} input.missions enriched mission views
 * @param {number | null} [input.archivedMissions] archived mission count, or null when unreadable
 * @param {object} [input.archive] archive index view/diagnostic
 * @param {{ held: boolean, pid?: number | null, phase?: string | null, heldMs?: number | null }} [input.gitLock]
 * @returns {object}
 */
export function statusView({
  state,
  statePath,
  activity,
  unreadTower,
  config = {},
  missions,
  archivedMissions = 0,
  archive = null,
  gitLock = { held: false },
}) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const status of MISSION_STATUSES) counts[status] = 0
  for (const mission of state.missions) counts[mission.status] = (counts[mission.status] ?? 0) + 1
  const openTasks = state.missions.reduce((sum, mission) => sum + taskCounts(mission.tasks ?? []).open, 0)
  /** @type {Record<string, number>} */
  const findingsByStatus = {}
  for (const findingStatus of FINDING_STATUSES) findingsByStatus[findingStatus] = 0
  for (const finding of state.findings ?? []) {
    const findingStatus = finding.status ?? 'open'
    findingsByStatus[findingStatus] = (findingsByStatus[findingStatus] ?? 0) + 1
  }
  return {
    repoRoot: state.repoRoot,
    commonDir: state.commonDir,
    statePath,
    base: state.base,
    revision: state.revision,
    towerAgentId: state.towerAgentId ?? null,
    ownerMissing: !state.towerAgentId,
    counts,
    openTasks,
    roster: (state.roster ?? []).length,
    messages: (state.messages ?? []).length,
    unreadTower,
    findings: (state.findings ?? []).length,
    findingsByStatus,
    reviews: (state.reviews ?? []).length,
    config: {
      path: config.configPath ?? null,
      repoConfigPresent: config.repoConfigPresent === true,
      spawn: {
        workerPreset: config.spawn?.workerPreset ?? null,
        reviewerPreset: config.spawn?.reviewerPreset ?? null,
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
    missions,
    archivedMissions,
    gitLock,
    ...(archive ? { archive } : {}),
    activity,
  }
}

/**
 * @param {unknown} maxBytes
 * @returns {number}
 */
export function patchLimit(maxBytes) {
  return Number.isInteger(maxBytes) && /** @type {number} */ (maxBytes) > 0 ? /** @type {number} */ (maxBytes) : 64 * 1024
}

/**
 * @param {object} input
 * @param {Mission} input.mission
 * @param {string} input.baseTip
 * @param {string} input.branchTip
 * @param {string} input.mergeBase
 * @param {string[]} input.files
 * @param {string[]} input.commits
 * @param {string} input.fullPatch
 * @param {number} [input.maxBytes]
 * @returns {object}
 */
export function diffView({ mission, baseTip, branchTip, mergeBase, files, commits, fullPatch, maxBytes }) {
  const limit = patchLimit(maxBytes)
  return {
    missionId: mission.id,
    branch: mission.worktree ? mission.worktree.branch : null,
    baseTip,
    branchTip,
    mergeBase,
    files,
    commits,
    truncated: fullPatch.length > limit,
    patch: fullPatch.slice(0, limit),
  }
}
