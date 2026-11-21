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
 * A roster name or agent id is only attributed to a log entry when it appears
 * as a whole token. `text.includes(name)` made `worker-m1` match a line about
 * `worker-m10`, crediting one agent with another's events. Both ends of the
 * match must be a non-word character (or the start/end of the text).
 * @param {string} text
 * @param {string} needle
 * @returns {boolean}
 */
function textNamesToken(text, needle) {
  if (!needle) return false
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text)
}

/**
 * #207: one agent's bounded recent activity, newest last.
 *
 * The activity log entries are `{at, type, missionId?, text}` and the writers
 * embed the roster name/agent id in the text (`reserved worker worker-m1`,
 * `worker-m1 reported completion`, ...), so an entry belongs to an agent when
 * it names the agent explicitly, or when its text carries the row's name or
 * agent id as a whole token and it belongs to the row's mission. Mission-level
 * entries that name nobody never leak into a single agent's tail. The result is
 * the compact `{at, event, text}` shape so a caller can render one agent
 * without the table.
 *
 * @param {Array<Record<string, any>>} [activity] newest-last log entries
 * @param {Record<string, any>} [entry] the roster row
 * @param {number} [limit] newest N (default 5)
 * @returns {{ at: number | null, event: string, text: string }[]}
 */
export function selectAgentActivity(activity = [], entry = {}, limit = 5) {
  const rows = Array.isArray(activity) ? activity : []
  const name = typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : null
  const agentId =
    entry?.agentId !== null && entry?.agentId !== undefined && String(entry.agentId).length > 0
      ? String(entry.agentId)
      : null
  const missionId =
    entry?.missionId !== null && entry?.missionId !== undefined ? String(entry.missionId) : null

  const matched = rows.filter((record) => {
    if (!record || typeof record !== 'object') return false
    if (record.agentId !== undefined && record.agentId !== null) {
      const explicit = String(record.agentId)
      return (agentId !== null && explicit === agentId) || (name !== null && explicit === name)
    }
    if (record.name !== undefined && record.name !== null) return name !== null && String(record.name) === name
    if (record.missionId !== undefined && record.missionId !== null && missionId !== null) {
      if (String(record.missionId) !== missionId) return false
    }
    const text = typeof record.text === 'string' ? record.text : ''
    return (name !== null && textNamesToken(text, name)) || (agentId !== null && textNamesToken(text, agentId))
  })

  const wanted = Number(limit)
  const bounded = matched.slice(-(Number.isInteger(wanted) && wanted > 0 ? wanted : 5))
  return bounded.map((record) => ({
    at: Number.isFinite(Number(record.at)) ? Number(record.at) : null,
    event: typeof record.type === 'string' && record.type.length > 0 ? record.type : 'activity',
    text: typeof record.text === 'string' ? record.text : '',
  }))
}

/**
 * #207: the bounded roster summary a single-agent status/roster view returns.
 * The entry is a persisted roster row (possibly with internal observation
 * counters), so this projection keeps the caller-facing fields only.
 *
 * @param {Record<string, any>} entry
 * @param {{ activity?: string, observed?: boolean, stale?: boolean }} [observation]
 * @returns {Record<string, any>}
 */
export function agentRowSummary(entry, observation = {}) {
  const summary = {
    name: entry?.name ?? null,
    agentId: entry?.agentId ?? null,
    role: entry?.role ?? null,
    missionId: entry?.missionId ?? null,
    state: entry?.state ?? null,
    activity: observation.activity ?? null,
    observed: observation.observed === true,
    stale: observation.stale === true,
  }
  for (const key of ['lastObservedAt', 'failureReason', 'previousOutcome', 'outcome', 'outcomeAt']) {
    if (entry?.[key] !== undefined) summary[key] = entry[key]
  }
  return summary
}

/**
 * #207: with `compact:true` the single-agent views keep only the identity a
 * caller needs to name the agent and read its state — no observation counters,
 * stale flag, activity or outcome fields. Status adds its own compact mission
 * shape through `compactMissionSummary`.
 * @param {Record<string, any>} entry
 * @returns {{ name: any, role: any, missionId: any, state: any }}
 */
export function compactAgentSummary(entry) {
  return {
    name: entry?.name ?? null,
    role: entry?.role ?? null,
    missionId: entry?.missionId ?? null,
    state: entry?.state ?? null,
  }
}

/**
 * #207: the compact mission shape a `status {agent, compact:true}` view carries.
 * @param {Record<string, any>} mission
 * @returns {{ id: any, status: any, kind: any }}
 */
export function compactMissionSummary(mission) {
  return {
    id: mission?.id ?? null,
    status: mission?.status ?? null,
    kind: mission?.kind ?? null,
  }
}

// ---------------------------------------------------------------------------
// #201: tower_wait observations. Pure projections over one loaded state
// document; tools/wait.js owns the polling loop and the bounded sleep.
// ---------------------------------------------------------------------------

/** The bounded roster slice a timeout summary may carry (never the whole table). */
export const WAIT_SUMMARY_ROWS = 5

// F73/#210 vocabulary: `stale` is an unconfirmed absence and `reserved` is a
// pending spawn, so neither counts as settled.
const SETTLED_AGENT_STATES = new Set(['inactive', 'retired', 'failed', 'interrupted', 'missing'])
const SETTLED_MISSION_STATUSES = new Set(['completed', 'merged', 'blocked', 'paused', 'abandoned'])
const COMPLETED_MISSION_STATUSES = new Set(['completed', 'merged'])

/** @param {any} state */
function rosterOf(state) {
  return Array.isArray(state?.roster) ? state.roster : []
}

/** @param {any} state */
function missionsOf(state) {
  return Array.isArray(state?.missions) ? state.missions : []
}

/**
 * Bounded summary of one mission row.
 * @param {any} mission
 * @returns {Record<string, any>}
 */
export function missionSummary(mission) {
  return {
    id: mission?.id ?? null,
    status: mission?.status ?? null,
    kind: mission?.kind ?? null,
    owner: mission?.owner ?? null,
    title: mission?.title ?? null,
  }
}

/**
 * Bounded summary of one roster row.
 * @param {any} row
 * @returns {Record<string, any>}
 */
export function agentSummary(row) {
  return {
    name: row?.name ?? null,
    agentId: row?.agentId ?? null,
    role: row?.role ?? null,
    missionId: row?.missionId ?? null,
    state: row?.state ?? null,
  }
}

/**
 * One pure observation of the wait target from a loaded state document.
 * @param {any} state
 * @param {{ missionId?: string, agent?: string }} target
 * @returns {{ found: boolean, reason?: string, mission?: any, row?: any, rows?: any[] }}
 */
export function observeWaitTarget(state, target) {
  if (target.missionId !== undefined) {
    const mission = missionsOf(state).find((entry) => String(entry?.id) === target.missionId)
    if (!mission) {
      return {
        found: false,
        reason: `mission "${target.missionId}" is not in the state catalog; check the id (archived missions no longer appear here)`,
      }
    }
    return {
      found: true,
      mission,
      rows: rosterOf(state).filter((entry) => String(entry?.missionId) === target.missionId),
    }
  }
  const row = rosterOf(state).find(
    (entry) =>
      entry?.name === target.agent ||
      (entry?.agentId !== null && entry?.agentId !== undefined && String(entry.agentId) === target.agent),
  )
  if (!row) {
    return {
      found: false,
      reason: `no roster agent named "${target.agent}" exists in the state catalog; check the name or agent id`,
    }
  }
  const mission =
    row.missionId === null || row.missionId === undefined
      ? null
      : missionsOf(state).find((entry) => String(entry?.id) === String(row.missionId)) ?? null
  return { found: true, row, mission }
}

/**
 * The one target change a poll compares, built from bounded row summaries.
 * @param {{ mission?: any, row?: any, rows?: any[] }} observation
 */
export function observationFingerprint(observation) {
  return JSON.stringify({
    mission: observation.mission ? missionSummary(observation.mission) : null,
    agent: observation.row ? agentSummary(observation.row) : null,
    roster: (observation.rows ?? []).map(agentSummary),
  })
}

/**
 * The wait condition over one observation, in the shared state vocabulary.
 *
 * The target kind decides the fact, never the other kind's row: an agent's
 * `settled`/`inactive` reads only that roster row, so a completed mission that
 * still has a live reviewer never reports the agent as settled (R185 P1). A
 * mission's `settled` reads only its status, and its `inactive` is true when
 * every roster row is settled — a mission with no rows (planned, artifact, or
 * completed before any spawn) is inactive rather than an eternal timeout.
 * `completed` is always the mission status, including for an agent target: the
 * agent's `completed` means its bound mission completed/merged.
 *
 * @param {{ mission?: any, row?: any, rows?: any[] }} observation
 * @param {string} until
 */
export function waitConditionMet(observation, until) {
  if (observation.row) {
    // Agent target: `settled` and `inactive` both mean the row rests. The
    // mission status is deliberately not consulted (R185 P1).
    if (until === 'completed') return COMPLETED_MISSION_STATUSES.has(observation.mission?.status ?? null)
    return SETTLED_AGENT_STATES.has(observation.row.state)
  }
  const status = observation.mission?.status ?? null
  if (until === 'completed') return COMPLETED_MISSION_STATUSES.has(status)
  if (until === 'inactive') {
    return (observation.rows ?? []).every((row) => SETTLED_AGENT_STATES.has(row.state))
  }
  return SETTLED_MISSION_STATUSES.has(status)
}

/**
 * @param {{ mission?: any, row?: any }} observation
 * @param {string} until
 */
export function waitReachedDetail(observation, until) {
  const detail = { until }
  if (observation.mission) detail.mission = missionSummary(observation.mission)
  if (observation.row) detail.agent = agentSummary(observation.row)
  return detail
}

/**
 * The bounded last observation a timeout carries.
 * @param {{ mission?: any, row?: any, rows?: any[] }} observation
 * @param {number} revision
 */
export function waitTimeoutLast(observation, revision) {
  const last = { revision }
  if (observation.mission) last.mission = missionSummary(observation.mission)
  if (observation.row) last.agent = agentSummary(observation.row)
  const rows = observation.rows ?? []
  if (rows.length > 0) {
    last.roster = rows.slice(0, WAIT_SUMMARY_ROWS).map(agentSummary)
    if (rows.length > WAIT_SUMMARY_ROWS) last.rosterTruncated = rows.length - WAIT_SUMMARY_ROWS
  }
  return last
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

