// Pure worker-completion policy and check normalization.
//
// app/checkCompletion.js still loads state, verifies the worktree/commits with
// Git, and persists the transition; the rules below are repository-free.
// @ts-check
import { TowerToolError } from '../errors.js'
import { EVIDENCE_SOURCE, evidenceEntries } from '../evidence.js'
import { completedEvent } from '../events.js'
import { scopeSplit } from '../scope.js'
import { shapeFor } from '../shapes/index.js'
import { isWorkerRole } from '../vocabulary.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */

/**
 * Hard cap for `tower_complete.report`, in UTF-8 bytes (32 KiB). The value is
 * the default of `gates.maxReportBytes`; a repository may lower or raise it.
 */
export const DEFAULT_MAX_REPORT_BYTES = 32 * 1024

/**
 * UTF-8 byte length, so multi-byte text is not silently favoured by a
 * character-count bound.
 * @param {string} value
 * @returns {number}
 */
export function utf8ByteLength(value) {
  return Buffer.byteLength(String(value), 'utf8')
}

/**
 * Reject a report over the cap instead of truncating it: a silent cut loses
 * evidence and cannot be recovered by the tower. The writer is told to keep the
 * full text beside the branch and reference it.
 * @param {string} report
 * @param {number} [maxBytes]
 * @returns {number} accepted UTF-8 byte length
 */
export function assertReportSize(report, maxBytes = DEFAULT_MAX_REPORT_BYTES) {
  const bytes = utf8ByteLength(report)
  if (bytes > maxBytes) {
    throw new TowerToolError(
      'invalid-argument',
      `report is ${bytes} bytes (UTF-8), over the ${maxBytes}-byte cap; reports are rejected, not truncated — write the full text to a file in the mission worktree and reference the path in the report`,
      {
        nextAction: 'write the full text to a file in the mission worktree and reference the path in the report',
      },
    )
  }
  return bytes
}

/**
 * Byte size of a stored completion report. Older documents have no
 * `reportBytes`, so the body is measured on read; the field is never required.
 * @param {any} completionReport
 * @returns {number | null}
 */
export function completionReportBytes(completionReport) {
  if (!isPlainObject(completionReport)) return null
  const stored = completionReport.reportBytes
  if (Number.isInteger(stored) && stored >= 0) return stored
  return typeof completionReport.report === 'string' ? utf8ByteLength(completionReport.report) : null
}

/**
 * #232: the supported way forward when a worker's own row is already stopped.
 * The refusal used to name no route at all, so the only options a reader could
 * see were a hand-edited status or a stranded mission. Both halves matter: the
 * bookkeeping worker re-runs the gates and writes the evidence, and a hand-set
 * `completed` is refused because the record it would fake does not exist.
 */
export const STOPPED_WORKER_NEXT_ACTION =
  'spawn a short-lived bookkeeping worker (tower_spawn role:"worker" on the same mission) that re-runs the gates and calls tower_complete; never set the mission to "completed" by hand — a hand-set completed status is refused because it records no report, no checks, and no evidence'

/**
 * @param {string} message
 * @param {string} [code]
 * @param {{ nextAction?: string | null, retryable?: boolean }} [options]
 * @returns {never}
 */
function fail(message, code = 'invalid-argument', options = {}) {
  throw new TowerToolError(code, message, options)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Receipt ids in one mission's recorded test runs, read through
 * domain/evidence.js (the single evidence reader) rather than off the mission
 * shape directly.
 * @param {any} mission
 * @returns {Set<string>}
 */
function recordedRunIds(mission) {
  /** @type {Set<string>} */
  const ids = new Set()
  if (!mission || typeof mission !== 'object') return ids
  for (const record of evidenceEntries(shapeFor(mission.kind).evidence, mission)) {
    if (record.source !== EVIDENCE_SOURCE.DISCOVERY) continue
    const id = record.entry && record.entry.id
    if (typeof id === 'string' && id.trim()) ids.add(id.trim())
  }
  return ids
}

/**
 * Normalize `tower_complete` check evidence.
 *
 * A check may cite a receipt in the mission's `testRuns` with `runId`. The id
 * is resolved against the mission handed in as `scope.mission`, so an unknown
 * or foreign receipt is rejected before the completion transaction writes.
 * @param {any} checks
 * @param {{ mission?: any, missions?: any[] }} [scope]
 * @returns {any[]}
 */
export function normalizeChecks(checks, scope) {
  if (checks === undefined) return []
  if (!Array.isArray(checks)) fail('checks must be an array')
  if (checks.length > 20) fail('checks may contain at most 20 entries')
  return checks.map((check, index) => {
    if (!isPlainObject(check)) fail(`checks[${index}] must be an object`)
    const name = typeof check.name === 'string' ? check.name.trim() : ''
    if (!name) fail(`checks[${index}].name must be a non-empty string`)
    /** @type {Record<string, any>} */
    const entry = { name }
    if (check.runId !== undefined) {
      if (typeof check.runId !== 'string' || !check.runId.trim()) {
        fail(`checks[${index}].runId must be a non-empty string`)
      }
      const runId = check.runId.trim()
      if (!scope || !scope.mission) {
        fail(`checks[${index}].runId cites a recorded test run but no mission is in scope to resolve it`)
      }
      /** @type {Set<string>} */
      const runs = recordedRunIds(scope.mission)
      if (!runs.has(runId)) {
        /** @type {any[]} */
        const missions = Array.isArray(scope.missions) ? scope.missions : []
        const owner = missions.find((entryMission) => entryMission
          && entryMission.id !== scope.mission.id
          && recordedRunIds(entryMission).has(runId))
        if (owner) {
          fail(`checks[${index}].runId "${runId}" belongs to mission ${owner.id}, not ${scope.mission.id}`)
        }
        fail(`checks[${index}].runId "${runId}" is not a recorded test run of mission ${scope.mission.id}; call tower_test or tower_verify to record one`)
      }
      entry.runId = runId
    }
    if (typeof check.command === 'string' && check.command.trim()) entry.command = check.command.trim()
    if (check.exitCode !== undefined && check.exitCode !== null) {
      if (!Number.isInteger(check.exitCode)) fail(`checks[${index}].exitCode must be an integer`)
      entry.exitCode = check.exitCode
    }
    if (typeof check.evidence === 'string' && check.evidence.trim()) entry.evidence = check.evidence.trim().slice(0, 4000)
    return entry
  })
}

/**
 * Resolve and validate the reporting worker and the mission's completion
 * preconditions that need no repository access.
 *
 * `allowStaleSelfReport` is the F73 admission: a worker that is calling
 * `tower_complete` is alive, so its own `stale` row may proceed — the
 * completion transaction revives and closes it under the same state lock that
 * commits the mission. Every other terminal state, and every other row, still
 * refuses; callers that omit the option keep the strict refusal (the guard
 * proof in `tests/roster-watchdog.test.mjs` drives that path directly).
 * @param {{ mission: Mission, roster: RosterEntry[] | undefined, input: any, maxReportBytes?: number, allowStaleSelfReport?: boolean }} params
 * @returns {RosterEntry}
 */
export function assertCompletionRequest({ mission, roster, input, maxReportBytes, allowStaleSelfReport = false }) {
  const worker = (roster ?? []).find((entry) => entry.agentId === input.agentId)
  if (!worker || worker.missionId !== mission.id) {
    fail(`agent ${input.agentId} is not assigned to mission ${mission.id}`)
  }
  if (!isWorkerRole(worker.role)) fail(`agent ${worker.name} is a ${worker.role}, not a worker`)
  const stopped = ['retired', 'failed', 'interrupted', 'missing', 'stale'].includes(worker.state)
  if (stopped && !(worker.state === 'stale' && allowStaleSelfReport === true)) {
    // #231: the residue a dead worker left behind, when the sweep recorded one.
    const residue = /** @type {{ filesChanged?: number, branch?: string | null } | undefined} */ (
      /** @type {any} */ (worker).residue
    )
    fail(
      `agent ${worker.name} is ${worker.state}; a stopped worker cannot report completion`,
      'invalid-transition',
      {
        // #232: a refusal without a route leaves a hand-edited status as the only
        // visible option. Name the supported recovery and forbid the fake one.
        // #231: when the row recorded what the dead worker left behind, quote it
        // so the caller does not have to run `git status` by hand.
        nextAction: residue
          ? `${STOPPED_WORKER_NEXT_ACTION} (the stopped worker left ${residue.filesChanged ?? 0} file(s) changed on ${residue.branch ?? 'its branch'})`
          : STOPPED_WORKER_NEXT_ACTION,
      },
    )
  }
  if (mission.owner && mission.owner !== worker.name) {
    fail(`agent ${worker.name} is not the current owner of mission ${mission.id} (owner: ${mission.owner})`)
  }
  if (mission.status === 'completed') fail(`mission ${mission.id} is already completed`)
  // `blocked` is derived from open blockers, so name them instead of a generic
  // status error: clearing them is the one recovery path (#149 W3).
  const blockers = mission.blockers ?? []
  if (blockers.length > 0) {
    fail(`mission ${mission.id} has unresolved blockers: ${blockers.join('; ')}; clear the blockers to resume it`)
  }
  if (!['active', 'planned'].includes(mission.status)) {
    fail(`mission ${mission.id} is ${mission.status}; it cannot be completed from that state`)
  }
  if (typeof input.report !== 'string' || input.report.trim().length === 0) {
    fail('tower_complete requires a non-empty report')
  }
  assertReportSize(input.report.trim(), maxReportBytes)
  const openTasks = (mission.tasks ?? []).filter((task) => task.status === 'open')
  if (openTasks.length > 0) {
    fail(
      `mission ${mission.id} still has ${openTasks.length} open task(s): ${openTasks
        .map((task) => task.text)
        .join('; ')}`,
    )
  }
  return worker
}

/**
 * Unread inbox messages block completion.
 * @param {{ mission: Mission, worker: RosterEntry, unread: unknown[] }} params
 * @returns {void}
 */
export function assertCompletionInbox({ mission, worker, unread }) {
  if (unread.length > 0) {
    fail(
      `mission ${mission.id} cannot complete with ${unread.length} unread inbox message(s) for ${worker.name}; call tower_inbox until unread is 0, incorporate them, then retry`,
    )
  }
}

/**
 * Project the completion report stored on the mission.
 *
 * #222: `footprint` is the one durable record of which files the completion
 * actually covered. It is omitted entirely when the caller could not derive one
 * (a completion is never refused because the diff was unreadable), so the
 * historical report shape is unchanged for every caller that has no footprint.
 *
 * @param {{ report: string, worker: RosterEntry, checks: any[], now: number, maxReportBytes?: number, footprint?: any }} params
 * @returns {any}
 */
export function completionReport({ report, worker, checks, now, maxReportBytes, footprint }) {
  const text = report.trim()
  // The published CompletionReport type does not name `footprint` yet
  // (types/index.d.ts is outside this mission's fence); widen locally instead.
  const stored = /** @type {any} */ ({
    report: text,
    reportBytes: assertReportSize(text, maxReportBytes),
    by: worker.name,
    at: now,
    checks,
  })
  if (footprint) stored.footprint = footprint
  return stored
}

/**
 * Normalize the files a worker declared it touched (`tower_complete.files`).
 * Declarations are a claim, never the authority: they are bounded and trimmed
 * so a transcript-sized list cannot reach the state document.
 * @param {unknown} files
 * @returns {string[]}
 */
export function normalizeDeclaredFiles(files) {
  if (files === undefined || files === null) return []
  if (!Array.isArray(files)) fail('files must be an array of repository-relative paths')
  if (files.length > 500) fail('files supports at most 500 entries')
  /** @type {Set<string>} */
  const seen = new Set()
  for (const entry of files) {
    if (typeof entry !== 'string' || entry.trim().length === 0) fail('files entries must be non-empty strings')
    if (entry.length > 400) fail(`files entry is longer than 400 characters: ${JSON.stringify(entry.slice(0, 40))}…`)
    seen.add(entry.trim())
  }
  return [...seen].sort()
}

/**
 * Build the completion footprint (#222): what the branch diff contains, how the
 * mission's fence splits it, and what the worker claimed. The derived diff is
 * the authority; a declaration only ever ADDS a name (the union is reported) and
 * a disagreement is recorded as a mismatch note rather than a refusal.
 *
 * `caseInsensitive` is the checkout's comparison mode, detected once at
 * `tower_init` and stored in state. It is threaded through here for the same
 * reason `scopeSplit` takes it: the footprint and the merge gate must produce
 * one split, so a case-only path cannot be inside for the record and outside for
 * review (R211).
 *
 * @param {{ mission: Mission, declared?: string[], changed?: string[], widenAt?: number | null, caseInsensitive?: boolean }} params
 * @returns {any}
 */
export function completionFootprint({ mission, declared = [], changed = [], widenAt = null, caseInsensitive = false }) {
  const shape = shapeFor(mission.kind)
  const derived = Array.isArray(changed) ? changed.filter((file) => typeof file === 'string' && file.length > 0) : []
  const claimed = Array.isArray(declared) ? declared : []
  const union = [...new Set([...derived, ...claimed])].sort()
  const split = scopeSplit({ mission, reach: shape.reach, changedFiles: union, caseInsensitive: caseInsensitive === true })
  const derivedSet = new Set(derived)
  const claimedSet = new Set(claimed)
  /** @type {string[]} */
  const mismatch = []
  if (claimed.length > 0) {
    for (const file of claimed) {
      if (!derivedSet.has(file)) mismatch.push(`${file} (declared, absent from the branch diff)`)
    }
    for (const file of derived) {
      if (!claimedSet.has(file)) mismatch.push(`${file} (changed, not declared)`)
    }
  }
  const scope = Array.isArray(mission.scope) ? [...mission.scope] : []
  const rawGeneration = mission.scopeGeneration
  const scopeGeneration = typeof rawGeneration === 'number' && Number.isInteger(rawGeneration) ? rawGeneration : 1
  const widenedTo = scopeGeneration > 1 ? [...scope] : null
  return {
    scope,
    scopeGeneration,
    widenAt: widenAt ?? null,
    widenedTo,
    changed: union,
    insideScope: split.insideScope,
    outsideScope: split.outsideScope,
    declared: [...claimed].sort(),
    mismatch,
    mismatchNote: mismatch.length === 0 ? null : `the worker's declaration and the branch diff disagree: ${mismatch.join('; ')}`,
  }
}

/**
 * Normalize the optional survey result (#148 D6). Only a shape that accepts a
 * result may carry one; the value stays small so the state document does not
 * become an evidence dump.
 * @param {unknown} result
 * @returns {any}
 */
export function normalizeResult(result) {
  if (result === undefined || result === null) return null
  if (!isPlainObject(result)) fail('result must be an object')
  const value = /** @type {Record<string, any>} */ (result)
  /** @type {Record<string, any>} */
  const normalized = {}
  for (const key of ['paths', 'symbols', 'plan']) {
    if (value[key] === undefined) continue
    if (!Array.isArray(value[key])) fail(`result.${key} must be an array of strings`)
    if (value[key].length > 200) fail(`result.${key} supports at most 200 entries`)
    normalized[key] = value[key].map((entry) => {
      if (typeof entry !== 'string' || entry.trim().length === 0) fail(`result.${key} entries must be non-empty strings`)
      return entry.trim()
    })
  }
  if (value.notes !== undefined) {
    if (typeof value.notes !== 'string') fail('result.notes must be a string')
    normalized.notes = value.notes.trim().slice(0, 4000)
  }
  return normalized
}

/**
 * Apply the completion transition to the mission draft and describe the domain
 * fact. Persistence stays in app/checkCompletion.js.
 * @param {{ mission: Mission, report: any, now: number, result?: any }} params
 * @returns {{ state: Mission, events: Array<{ type: string, missionId: string }> }}
 */
export function applyCompletion({ mission, report, now, result }) {
  const shape = shapeFor(mission.kind)
  const normalized = normalizeResult(result)
  if (normalized !== null) {
    if (!shape.acceptsResult) fail(`mission ${mission.id} is a ${shape.kind}; a completion result is survey evidence only`)
    mission.result = normalized
  }
  mission.status = 'completed'
  mission.completionReport = report
  mission.updatedAt = now
  // #231 R198: `predecessorResidue` is a warning for the next worker about a
  // death nobody has explained yet. An accepted completion is that worker's own
  // resolution, so the warning must not outlive it and reappear in the briefing
  // of a later fix worker. (The type surface omits the optional field; the
  // state schema permits extra mission properties.)
  delete /** @type {any} */ (mission).predecessorResidue
  return { state: mission, events: [completedEvent(mission)] }
}
