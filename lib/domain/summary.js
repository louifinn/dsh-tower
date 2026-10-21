// Pure mission/finding summaries.
// @ts-check
import { FINDING_STATUSES } from './mission.js'

/** @typedef {import('../../types/index.js').Finding} Finding */
/** @typedef {import('../../types/index.js').FindingSummary} FindingSummary */
/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').MissionDetail} MissionDetail */
/** @typedef {import('../../types/index.js').MissionSummary} MissionSummary */
/** @typedef {import('../../types/index.js').MissionTask} MissionTask */
/** @typedef {import('../../types/index.js').TaskCounts} TaskCounts */

/**
 * @param {MissionTask[]} tasks
 * @returns {TaskCounts}
 */
function taskCounts(tasks) {
  /** @type {TaskCounts} */
  const counts = { total: tasks.length, done: 0, open: 0, dropped: 0 }
  for (const task of tasks) {
    if (task.status === 'done') counts.done += 1
    else if (task.status === 'dropped') counts.dropped += 1
    else counts.open += 1
  }
  return counts
}

/**
 * @param {Mission} mission
 * @returns {MissionSummary}
 */
export function missionSummary(mission) {
  return {
    id: mission.id,
    title: mission.title,
    kind: mission.kind,
    status: mission.status,
    scope: mission.scope,
    deps: mission.deps,
    owner: mission.owner ?? null,
    worktree: mission.worktree
      ? {
          path: mission.worktree.path,
          branch: mission.worktree.branch,
          baseCommit: mission.worktree.baseCommit,
        }
      : null,
    blockers: mission.blockers ?? [],
    tasks: taskCounts(mission.tasks ?? []),
    scopeGeneration: mission.scopeGeneration ?? 1,
    ownerGeneration: mission.ownerGeneration ?? 0,
    pauseCause: mission.pauseCause ?? null,
    reviewPolicy: mission.reviewPolicy ?? 'required-clean',
    mergedCommit: mission.mergedCommit ?? null,
    mergedAt: mission.mergedAt ?? null,
    updatedAt: mission.updatedAt,
  }
}

/**
 * @param {Mission} mission
 * @returns {MissionDetail}
 */
function fullMission(mission) {
  return {
    ...missionSummary(mission),
    tasks: (mission.tasks ?? []).map((task) => ({ ...task })),
    notes: mission.notes ?? [],
    completionReport: mission.completionReport ?? null,
    authorizationRef: mission.authorizationRef ?? null,
    references: mission.references ?? [],
    reviewPolicy: mission.reviewPolicy ?? 'required-clean',
    reviewExemptionReason: mission.reviewExemptionReason ?? '',
    testRuns: mission.testRuns ?? [],
  }
}

/**
 * @param {Finding} finding
 * @returns {FindingSummary}
 */
function findingSummary(finding) {
  return {
    id: finding.id,
    seq: finding.seq ?? null,
    type: finding.type,
    title: finding.title,
    severity: finding.severity ?? null,
    status: finding.status ?? 'open',
    missionId: finding.missionId ?? null,
    branch: finding.branch ?? null,
    reportedBy: finding.reportedBy ?? null,
    at: finding.at ?? null,
    updatedAt: finding.updatedAt ?? null,
    closedAt: finding.closedAt ?? null,
  }
}

/**
 * @param {Finding[]} findings
 * @returns {Record<string, number>}
 */
function countFindings(findings) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const status of FINDING_STATUSES) counts[status] = 0
  for (const finding of findings) {
    const status = finding.status ?? 'open'
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

export { taskCounts, fullMission, findingSummary, countFindings }
