// Terminal-mission archive decisions (#73).
//
// A finished mission keeps its tasks, reviews, findings and completion report,
// but every mutation rewrites the whole state document. Archiving moves that
// history into `<git-common-dir>/dsh-tower/archive/` and leaves only an index
// entry behind, so state.json grows with active work rather than with the
// repository's total history.
//
// This module is pure: it declares the archive document contract, selects what
// is eligible under the configured policy, and builds the records. Reading and
// writing the files, and the lock that makes them atomic with state.json, live
// in `lib/archive.js` and `app/archive.js`.
// @ts-check
import { isTerminal } from '../mission.js'

/** @typedef {import('../../types/index.js').Finding} Finding */
/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').Review} Review */
/** @typedef {import('../../types/index.js').TowerConfig} TowerConfig */

/** The archive document version. It is independent of `SCHEMA_VERSION`. */
export const ARCHIVE_VERSION = 1

export const DAY_MS = 24 * 60 * 60 * 1000

/** @typedef {{ archivedAt: number, archivedYear: number }} ArchiveMeta */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A worktree is still live until teardown records its removal. Archiving a
 * mission whose worktree exists would lose the only record of where it is.
 * @param {Mission} mission
 * @returns {boolean}
 */
export function hasLiveWorktree(mission) {
  const record = /** @type {Record<string, any>} */ (mission)
  return Boolean(record.worktree) && !record.worktreeRemovedAt
}

/**
 * When the mission became terminal. Missing timestamps are treated as ancient
 * so a legacy terminal mission does not stay hot forever; the threshold is
 * still explicit in config.
 * @param {Mission} mission
 * @returns {number}
 */
export function terminalTimestamp(mission) {
  const record = /** @type {Record<string, any>} */ (mission)
  for (const value of [record.mergedAt, record.abandonedAt, record.updatedAt]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

/**
 * Select the terminal missions the policy wants moved out of state.json.
 *
 * Eligibility:
 *   - status is `merged` or `abandoned` (terminal);
 *   - the worktree is gone (never provisioned, or removed by teardown);
 *   - the caller did not protect it (open batch members, live agents).
 *
 * Triggers:
 *   - `force` archives every eligible mission (tower_teardown);
 *   - otherwise a mission older than `afterDays` is archived, and when the hot
 *     terminal count exceeds `maxMissions`, the oldest eligible missions are
 *     archived until the count fits the cap.
 *
 * @param {Mission[]} missions
 * @param {Partial<TowerConfig['archive']>} [policy]
 * @param {{ now?: number, force?: boolean, protectedIds?: Iterable<string> }} [options]
 * @returns {Mission[]}
 */
export function selectForArchive(missions, policy = {}, options = {}) {
  if (policy?.enabled === false) return []
  const now = Number.isFinite(options.now) ? /** @type {number} */ (options.now) : Date.now()
  const protectedIds = new Set(options.protectedIds ?? [])
  const afterDays = Number.isFinite(policy?.afterDays) ? /** @type {number} */ (policy.afterDays) : 30
  const maxMissions = Number.isFinite(policy?.maxMissions) ? /** @type {number} */ (policy.maxMissions) : 100
  const eligible = missions.filter(
    (mission) => isTerminal(mission.status) && !hasLiveWorktree(mission) && !protectedIds.has(mission.id),
  )
  if (eligible.length === 0) return []
  if (options.force === true) return eligible

  const selected = new Set()
  const cutoff = now - Math.max(0, afterDays) * DAY_MS
  for (const mission of eligible) {
    if (terminalTimestamp(mission) <= cutoff) selected.add(mission.id)
  }
  if (eligible.length > maxMissions) {
    const oldest = [...eligible].sort((left, right) => terminalTimestamp(left) - terminalTimestamp(right))
    for (let index = 0; index < oldest.length - maxMissions; index += 1) selected.add(oldest[index].id)
  }
  return missions.filter((mission) => selected.has(mission.id))
}

/**
 * Review records that belong to one mission, by id or by its branch.
 * @param {Mission} mission
 * @param {Review[] | null | undefined} reviews
 * @returns {Review[]}
 */
export function linkedReviews(mission, reviews) {
  const branch = /** @type {Record<string, any>} */ (mission).worktree?.branch ?? null
  return (reviews ?? []).filter(
    (review) => review.missionId === mission.id || (branch !== null && review.branch === branch),
  )
}

/**
 * @param {Mission} mission
 * @param {Finding[] | null | undefined} findings
 * @returns {Finding[]}
 */
export function linkedFindings(mission, findings) {
  return (findings ?? []).filter((finding) => finding.missionId === mission.id)
}

/**
 * Closed findings are historical; open/triaged findings stay in state.json so
 * `tower_findings` keeps showing actionable work even after its mission is
 * archived. The archive entry still carries a snapshot of every linked finding.
 * @param {Finding} finding
 * @returns {boolean}
 */
export function isClosedFinding(finding) {
  return finding.status === 'fixed' || finding.status === 'wontfix'
}

/** UTC year used for `archive/<year>.json`. @param {number} now @returns {number} */
export function archiveYearFor(now) {
  return new Date(now).getUTCFullYear()
}

/**
 * The compact entry written to `archive/index.json` (and referenced by
 * `tower_status`). It carries enough fields to keep ordering, dependency
 * lookups and mission-id allocation working without loading a year file.
 * @param {Mission} mission
 * @param {ArchiveMeta} meta
 * @returns {Record<string, any>}
 */
export function archiveIndexEntry(mission, meta) {
  const record = /** @type {Record<string, any>} */ (mission)
  const branch = record.worktree?.branch ?? record.branch ?? null
  return {
    id: mission.id,
    title: String(record.title ?? mission.id),
    status: mission.status,
    kind: record.kind ?? 'build',
    scope: Array.isArray(record.scope) ? record.scope : [],
    deps: Array.isArray(record.deps) ? record.deps : [],
    owner: record.owner ?? null,
    branch,
    mergedCommit: record.mergedCommit ?? null,
    mergedAt: record.mergedAt ?? null,
    updatedAt: record.updatedAt ?? null,
    archivedAt: meta.archivedAt,
    archivedYear: meta.archivedYear,
  }
}

/**
 * A full archived record. It nests the untouched mission and its linked
 * reviews/findings so `tower_status missionId` can reproduce the detail view.
 * @param {Mission} mission
 * @param {ArchiveMeta & { reviews?: Review[], findings?: Finding[] }} meta
 * @returns {Record<string, any>}
 */
export function archivedEntry(mission, meta) {
  return {
    ...archiveIndexEntry(mission, meta),
    mission,
    reviews: meta.reviews ?? [],
    findings: meta.findings ?? [],
  }
}

/**
 * Strip the full payload before writing the index.
 * @param {Record<string, any>} entry
 * @returns {Record<string, any>}
 */
export function indexEntryFromArchived(entry) {
  const { mission: _mission, reviews: _reviews, findings: _findings, ...index } = entry
  return index
}

/**
 * Dedupe entries by id, keeping the first occurrence. Archiving is idempotent:
 * a crash between writing a year file and writing state.json is retried on the
 * next mutation and must not create a second record.
 * @template {{ id?: unknown }} T
 * @param {T[]} entries
 * @returns {T[]}
 */
export function dedupeById(entries) {
  const seen = new Set()
  const out = []
  for (const entry of entries) {
    const id = entry?.id
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    out.push(entry)
  }
  return out
}

/**
 * Validate an archive document. Returns the diagnostic string, or null when the
 * document is structurally usable. A truncated or foreign archive must degrade
 * to a diagnostic in status/doctor, never to a thrown state-corrupt error.
 * @param {unknown} document
 * @param {'index'|'year'} kind
 * @param {string} [where]
 * @returns {string | null}
 */
export function archiveDocumentError(document, kind, where = '') {
  if (!isPlainObject(document)) return `tower archive ${kind} is not an object${where}`
  const record = /** @type {Record<string, any>} */ (document)
  if (record.archiveVersion !== ARCHIVE_VERSION) {
    return `tower archive ${kind} has unsupported archiveVersion ${JSON.stringify(record.archiveVersion)}${where}`
  }
  if (!Array.isArray(record.missions)) return `tower archive ${kind} has no missions array${where}`
  const ids = new Set()
  for (const entry of record.missions) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') {
      return `tower archive ${kind} has an entry without id${where}`
    }
    if (ids.has(entry.id)) return `tower archive ${kind} has duplicate mission ${entry.id}${where}`
    ids.add(entry.id)
    if (typeof entry.status !== 'string') return `tower archive ${kind} entry ${entry.id} has no status${where}`
    if (kind === 'year') {
      if (!isPlainObject(entry.mission) || entry.mission.id !== entry.id) {
        return `tower archive ${kind} entry ${entry.id} has no full mission${where}`
      }
      if (entry.reviews !== undefined && !Array.isArray(entry.reviews)) {
        return `tower archive ${kind} entry ${entry.id} has no reviews array${where}`
      }
      if (entry.findings !== undefined && !Array.isArray(entry.findings)) {
        return `tower archive ${kind} entry ${entry.id} has no findings array${where}`
      }
    }
    if (kind === 'index' && (!Number.isInteger(entry.archivedYear) || entry.archivedYear < 1970)) {
      return `tower archive ${kind} entry ${entry.id} has no archivedYear${where}`
    }
  }
  return null
}
