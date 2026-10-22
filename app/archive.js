// Terminal-mission archival use case (#73).
//
// The policy sweep runs inside an existing state lock, immediately before the
// caller writes state.json: archive files are written first, then the state
// document is compacted, so a crash between the two leaves the mission in state
// and the archive entry is deduped by id on retry. Nothing is deleted: the full
// mission, its linked reviews and its findings are moved to archive/<year>.json.
import { hasLiveAgent } from '../domain/integration/liveness.js'
import { missionSummary } from '../domain/summary.js'
import {
  archiveYearFor,
  archivedEntry,
  isClosedFinding,
  linkedFindings,
  linkedReviews,
  selectForArchive,
} from '../domain/state/archive.js'

/** @typedef {import('../types/index.js').Mission} Mission */
/** @typedef {import('../types/index.js').TowerState} TowerState */

/**
 * Read `archive/index.json` through the Tower's store. Never throws: the
 * returned `ok:false` carries the diagnostic that status/doctor surface.
 * @param {any} tower
 * @returns {Promise<{ ok: boolean, file: string, missions: any[], error?: string, exists: boolean }>}
 */
export function archiveIndex(tower) {
  return tower.deps.archive.readIndex(tower.deps.store, tower.paths)
}

/**
 * Load one archived mission with its linked reviews and findings.
 * @param {any} tower
 * @param {string} missionId
 */
export function archivedMission(tower, missionId) {
  return tower.deps.archive.readEntry(tower.deps.store, tower.paths, missionId)
}

/**
 * A compact archived mission is rendered through the same summary projection as
 * an active one, plus `archived: true`. The completion report and task bodies
 * are intentionally absent: they live in the year file and are loaded only by
 * `tower_status missionId`.
 * @param {Record<string, any>} entry
 * @returns {any}
 */
export function archivedSummary(entry) {
  const mission = /** @type {any} */ ({
    id: entry.id,
    title: entry.title,
    kind: entry.kind ?? 'build',
    status: entry.status,
    scope: Array.isArray(entry.scope) ? entry.scope : [],
    deps: Array.isArray(entry.deps) ? entry.deps : [],
    owner: entry.owner ?? null,
    worktree: null,
    blockers: [],
    tasks: [],
    reviewPolicy: 'required-clean',
    mergedCommit: entry.mergedCommit ?? null,
    mergedAt: entry.mergedAt ?? null,
    updatedAt: entry.updatedAt ?? null,
  })
  return {
    ...missionSummary(mission),
    archived: true,
    archivedAt: entry.archivedAt,
    archivedYear: entry.archivedYear ?? null,
    branch: entry.branch ?? null,
  }
}

/**
 * Status/board view of the archive index: a count plus a diagnostic, never a
 * thrown error.
 * @param {{ ok: boolean, file: string, missions: any[], error?: string, exists: boolean }} index
 * @returns {Record<string, any>}
 */
export function archiveView(index) {
  const years = index.ok
    ? [...new Set(index.missions.map((entry) => entry.archivedYear).filter((year) => Number.isInteger(year)))].sort(
        (left, right) => left - right,
      )
    : []
  return {
    count: index.ok ? index.missions.length : 0,
    years,
    file: index.file,
    present: index.exists === true,
    unreadable: index.ok ? false : true,
    ...(index.ok ? {} : { message: index.error ?? 'tower archive is unreadable' }),
  }
}

/**
 * Move the eligible terminal missions out of `state` and into the archive.
 * Mutates `state` in memory (missions, linked reviews and closed findings) and
 * leaves the caller to validate/persist it under the lock it already holds.
 *
 * @param {any} tower
 * @param {TowerState} state
 * @param {{ now?: number, force?: boolean, activity?: Record<string, string | undefined> }} [options]
 * @returns {Promise<{ archived: string[], written: boolean, files?: string[], error: string | null, year?: number }>}
 */
export async function sweepArchive(tower, state, options = {}) {
  const policy = tower.config.archive ?? {}
  if (policy.enabled === false) return { archived: [], written: false, error: null }
  const now = options.now ?? Date.now()
  const activity = options.activity ?? {}

  // Open batches still need their members; a live agent's mission is never
  // archived even if it is terminal (defence in depth; teardown keeps it too).
  const protectedIds = new Set()
  for (const batch of state.batches ?? []) {
    const record = /** @type {Record<string, any>} */ (batch)
    if (record.status !== 'open') continue
    for (const missionId of Array.isArray(record.missionIds) ? record.missionIds : []) {
      protectedIds.add(String(missionId))
    }
  }
  for (const mission of state.missions) {
    if (hasLiveAgent(state, mission.id, activity)) protectedIds.add(mission.id)
  }

  const selected = selectForArchive(state.missions, policy, {
    now,
    force: options.force === true,
    protectedIds,
  })
  if (selected.length === 0) return { archived: [], written: false, error: null }

  const archivedYear = archiveYearFor(now)
  const entries = selected.map((mission) =>
    archivedEntry(mission, {
      archivedAt: now,
      archivedYear,
      reviews: linkedReviews(mission, state.reviews),
      findings: linkedFindings(mission, state.findings),
    }),
  )

  let written
  try {
    written = await tower.deps.archive.writeEntries(tower.deps.store, tower.paths, { entries, now })
  } catch (error) {
    return { archived: [], written: false, error: `archive write failed: ${String(error?.message ?? error)}` }
  }
  if (!written.ok) return { archived: [], written: false, error: written.error ?? 'archive write failed' }

  // The archive now holds the full record: compact state.json in the same lock.
  const ids = new Set(selected.map((mission) => mission.id))
  const branches = new Set(
    selected
      .map((mission) => mission.worktree?.branch)
      .filter((branch) => typeof branch === 'string'),
  )
  state.missions = state.missions.filter((mission) => !ids.has(mission.id))
  if (Array.isArray(state.reviews)) {
    state.reviews = state.reviews.filter((review) => !ids.has(review.missionId) && !branches.has(review.branch))
  }
  // Open findings stay actionable in state.json; the archive keeps a snapshot.
  if (Array.isArray(state.findings)) {
    state.findings = state.findings.filter(
      (finding) => !(finding.missionId != null && ids.has(finding.missionId) && isClosedFinding(finding)),
    )
  }
  state.revision += 1
  state.updatedAt = now

  for (const mission of selected) {
    await tower.deps.store.appendJsonl(tower.paths.activity, {
      at: now,
      type: 'archive',
      missionId: mission.id,
      text: `archived to archive/${archivedYear}.json`,
    }).catch(() => {})
  }

  return {
    archived: [...ids],
    written: true,
    files: written.files,
    error: null,
    year: archivedYear,
  }
}
