// Pure read-model projections for the status/detail/diff use cases. Loading
// state, reading the activity tail, and running Git stay in app/read.js.
// @ts-check
import { reviewsNewestFirst } from '../integration/review.js'
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
  // Reviews linked by mission id or by the mission's branch are shown; the
  // order is the shared one (highest round first, and inside one round the most
  // recently recorded verdict first), never raw storage order.
  const reviews = reviewsNewestFirst(
    (state.reviews ?? []).filter(
      (review) => review.missionId === mission.id || (branch && review.branch === branch),
    ),
  )
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
    // Rotation policy is adapter-enforced; the dashboard still names it so a
    // reader can explain why activity.jsonl is bounded. The on-disk segment
    // state (live/rotated bytes) is tower_doctor's report.
    activityLog: {
      maxBytes: Number.isInteger(config.activity?.maxBytes) ? config.activity.maxBytes : null,
      retention: Number.isInteger(config.activity?.retention) ? config.activity.retention : null,
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
 * @param {string|null} [input.reviewedCommit]
 * @param {number} [input.maxBytes]
 * @returns {object}
 */
export function diffView({ mission, baseTip, branchTip, mergeBase, files, commits, fullPatch, maxBytes, reviewedCommit = null }) {
  const limit = patchLimit(maxBytes)
  return {
    missionId: mission.id,
    branch: mission.worktree ? mission.worktree.branch : null,
    baseTip,
    branchTip,
    // #149 W3: a reviewer sees (and is stamped with) one recorded commit; the
    // field is null for every other caller reading the live branch.
    reviewedCommit,
    mergeBase,
    files,
    commits,
    truncated: fullPatch.length > limit,
    patch: fullPatch.slice(0, limit),
  }
}

/**
 * #211: `sinceRevision` keeps a row only when it was stamped at a later state
 * revision. Rows written before per-row stamps existed carry no revision;
 * `sinceRevision: 0` therefore means "no filter" (and is the documented way to
 * see legacy rows), while a positive value never returns them.
 * @param {{ revision?: unknown }} row
 * @param {unknown} sinceRevision
 * @returns {boolean}
 */
export function rowChangedSince(row, sinceRevision) {
  const since = Number(sinceRevision)
  if (!Number.isInteger(since) || since <= 0) return true
  return Number.isInteger(row?.revision) && /** @type {number} */ (row.revision) > since
}

/**
 * #211: `fields` projects read rows to exactly the requested keys. Unknown keys
 * are omitted instead of reported, so a caller may ask for a superset.
 * @param {object[]} rows
 * @param {unknown} fields
 * @returns {object[]}
 */
export function projectFields(rows, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return rows
  const keys = [...new Set(fields.filter((field) => typeof field === 'string' && field.length > 0))]
  return rows.map((row) => {
    /** @type {Record<string, unknown>} */
    const projected = {}
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row, key)) projected[key] = /** @type {any} */ (row)[key]
    }
    return projected
  })
}

/**
 * #211: narrow the roster view to one agent (`name` or `agentId`) and/or the
 * newest `tail` rows. Extraction happens after observation enrichment, so a
 * caller sees the same fields for every row.
 * @param {object[]} rows
 * @param {{ agent?: unknown, tail?: unknown }} [input]
 * @returns {object[]}
 */
export function selectRosterRows(rows, input = {}) {
  let selected = rows
  const agent = typeof input.agent === 'string' && input.agent.length > 0 ? input.agent : null
  if (agent) {
    selected = selected.filter((row) => {
      const candidate = /** @type {any} */ (row)
      return candidate.name === agent || (candidate.agentId !== null && candidate.agentId !== undefined && String(candidate.agentId) === agent)
    })
  }
  const tail = Number(input.tail)
  if (Number.isInteger(tail) && tail > 0) selected = selected.slice(-tail)
  return selected
}

/**
 * #211: `tower_inspect doctor` projections. `checks:true` returns the full
 * check rows without the diagnostic sections; `compact:true` additionally strips
 * every passing row to `{id, status}` and drops `action`. Defaults are the
 * untouched report.
 * @param {any} report
 * @param {{ checks?: boolean, compact?: boolean }} [input]
 * @returns {any}
 */
export function doctorProjection(report, input = {}) {
  if (!input.checks && !input.compact) return report
  const rows = (report.checks ?? []).map((row) => {
    if (!input.compact) return row
    if (row.status === 'pass') return { id: row.id, status: row.status }
    return { id: row.id, status: row.status, ...(row.detail === undefined ? {} : { detail: row.detail }) }
  })
  return { ok: report.ok, checks: rows }
}

/**
 * #211: parse `git diff --numstat` output into `{path, added, deleted}` rows.
 * A binary file reports `-`; it becomes null rather than NaN.
 * @param {unknown} output
 * @returns {{ path: string, added: number | null, deleted: number | null }[]}
 */
export function parseNumstat(output) {
  return String(output ?? '')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [added, deleted, ...rest] = line.split('\t')
      return {
        path: rest.join('\t'),
        added: added === '-' ? null : Number(added),
        deleted: deleted === '-' ? null : Number(deleted),
      }
    })
}

