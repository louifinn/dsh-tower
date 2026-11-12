// Pure projection for the `/tasks` live-roster panel (#160).
//
// One line per live roster entry — mission, role, name, short branch, state,
// silence since the last recorded event, and that event — sorted by silence,
// then the counts + `tower_interrupt` footer. Staleness comes from the shared
// spawn.staleMs rule (domain/collab/roster.js), never a second definition, and
// the projection reads only the data it is handed: no fs, no clock, no writes.
// @ts-check
import { rosterEntryStale } from '../collab/roster.js'
import { PARENT_STATUS_OK, ROSTER_STATE } from '../vocabulary.js'

/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */

/**
 * Rows a terminal roster state never shows: gone or released agents.
 * @type {Set<string>}
 */
const HIDDEN_STATES = new Set([
  ROSTER_STATE.retired,
  ROSTER_STATE.failed,
  ROSTER_STATE.missing,
  ROSTER_STATE.inactive,
])

/** Bounded output (#160 D2): no pagination, at most this many rows. */
export const TASKS_PANEL_ROW_LIMIT = 20

/**
 * @param {string | null | undefined} branch
 * @returns {string}
 */
function shortBranch(branch) {
  if (typeof branch !== 'string' || branch.length === 0) return '-'
  const segments = branch.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? branch
}

/**
 * @param {number} ms non-negative duration in milliseconds
 * @returns {string}
 */
function silenceLabel(ms) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`
}

/**
 * The newest activity-log entry recorded for the row's mission. A row with no
 * recorded event yet falls back to its spawn (or reservation) timestamp.
 * @param {RosterEntry} entry
 * @param {Array<Record<string, unknown>>} activityLog chronological tail
 * @returns {{ at: number, text: string }}
 */
function lastEventFor(entry, activityLog) {
  for (let index = activityLog.length - 1; index >= 0; index -= 1) {
    const record = activityLog[index]
    if (record && record.missionId === entry.missionId) {
      const at = Number(record.at)
      return {
        at: Number.isFinite(at) ? at : Number(entry.spawnedAt ?? entry.reservedAt ?? 0),
        text: typeof record.text === 'string' && record.text.length > 0 ? record.text : '(no tool yet)',
      }
    }
  }
  return { at: Number(entry.spawnedAt ?? entry.reservedAt ?? 0), text: '(no tool yet)' }
}

/**
 * Render the read-only live-roster panel.
 *
 * @param {object} input
 * @param {RosterEntry[]} [input.roster] roster projection rows
 * @param {Record<string, string>} [input.activity] agentId -> catalog activity
 * @param {Record<string, string>} [input.parentStatus] parentSessionId -> observation status
 * @param {Array<Record<string, unknown>>} [input.activityLog] chronological activity tail
 * @param {unknown} [input.staleMs] the spawn.staleMs window (0 disables)
 * @param {number} [input.now] evaluation time (epoch ms)
 * @param {number} [input.limit] row cap (default TASKS_PANEL_ROW_LIMIT)
 * @returns {string}
 */
export function tasksPanelText({
  roster = [],
  activity = {},
  parentStatus = {},
  activityLog = [],
  staleMs = 0,
  now = Date.now(),
  limit = TASKS_PANEL_ROW_LIMIT,
} = {}) {
  /** @type {Array<{ entry: RosterEntry, stale: boolean, silenceMs: number, last: { at: number, text: string } }>} */
  const rows = []
  for (const entry of roster) {
    if (HIDDEN_STATES.has(/** @type {string} */ (entry.state))) continue
    const observed = entry.agentId === null || entry.agentId === undefined ? undefined : activity[String(entry.agentId)]
    const parentKnown = parentStatus[/** @type {string} */ (entry.parentSessionId)] === PARENT_STATUS_OK
    const last = lastEventFor(entry, activityLog)
    // A row the watchdog already marked stale keeps showing stale even when the
    // live catalog now reports it (the merge gate reads that persisted flag too).
    const persistedStale = entry.state === ROSTER_STATE.stale || entry.stale === true
    rows.push({
      entry,
      stale: persistedStale || rosterEntryStale(entry, { observed, parentKnown, staleMs, now }),
      silenceMs: Math.max(0, now - last.at),
      last,
    })
  }
  rows.sort((a, b) => b.silenceMs - a.silenceMs)

  const lines = []
  if (rows.length === 0) lines.push('No live roster agents.')
  for (const row of rows.slice(0, limit)) {
    const state = row.stale ? ROSTER_STATE.stale : String(row.entry.state ?? ROSTER_STATE.active)
    lines.push(
      [
        String(row.entry.missionId ?? '-'),
        String(row.entry.role ?? '-'),
        String(row.entry.name ?? '-'),
        shortBranch(typeof row.entry.branch === 'string' ? row.entry.branch : undefined),
        state,
        silenceLabel(row.silenceMs),
        `last: ${row.last.text}`,
      ].join('  '),
    )
  }
  if (rows.length > limit) lines.push(`(${rows.length - limit} more not shown)`)

  const staleCount = rows.filter((row) => row.stale).length
  lines.push(
    `${rows.length} live, ${staleCount} stale; tower_interrupt <name> to stop, /tower status for the full board`,
  )
  return lines.join('\n')
}
