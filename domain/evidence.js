// One evidence contract (#149 W4). "Did the work pass checks?" has exactly one
// answer shape and one reader:
//
//   * a completion report's `checks` (an assertion the caller recorded), and
//   * a test-discovery receipt in `mission.testRuns` (machine evidence bound to
//     the tree tip the discovery ran on).
//
// Every consumer — the merge gate's test blocker, batch close/status, the
// shape completion invariants and the tools that record evidence — calls this
// module. The shape declares which sources appertain (`shape.evidence`); the
// generic layers never read `completionReport.checks` or `mission.testRuns`
// themselves, and no layer copies a receipt into a completion report.
//
// A normalized record is the unit both kinds of evidence share:
//   { names, name, source, ok, command, exitCode, evidence, treeTip, entry }
//
// @ts-check

/** @typedef {'completionReport' | 'testRuns' | 'input'} EvidenceSource */
/**
 * @typedef {{
 *   completionChecks: boolean,
 *   testReceipts: false | 'tip-bound',
 * }} EvidenceContract
 */
/**
 * @typedef {{
 *   names: string[],
 *   name: string,
 *   source: EvidenceSource,
 *   ok: boolean | null,
 *   command: string | null,
 *   exitCode: number | null,
 *   evidence: string | null,
 *   treeTip: string | null,
 *   entry: Record<string, any>,
 * }} EvidenceEntry
 */

/** Provenance labels reported by every reader. */
export const EVIDENCE_SOURCE = Object.freeze({
  COMPLETION: /** @type {const} */ ('completionReport'),
  DISCOVERY: /** @type {const} */ ('testRuns'),
  INPUT: /** @type {const} */ ('input'),
})

/**
 * A nameless discovery receipt answers to both names: `tests` is the name the
 * built-in test tool has always used, `tower_test` the synthetic name older
 * integrations attached to the same receipt.
 */
export const TEST_EVIDENCE_NAMES = Object.freeze(['tests', 'tower_test'])

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {Record<string, any>} entry
 * @returns {boolean}
 */
function isDiscoveryReceipt(entry) {
  return Array.isArray(entry.commands) && Array.isArray(entry.tests)
}

/**
 * @param {Record<string, any>} entry
 * @returns {string[]}
 */
function namesOf(entry) {
  if (isDiscoveryReceipt(entry)) return [...TEST_EVIDENCE_NAMES]
  for (const candidate of [entry.name, entry.id, entry.check]) {
    if (nonEmptyString(candidate)) return [String(candidate).trim()]
  }
  return []
}

/**
 * @param {Record<string, any>} entry
 * @returns {boolean | null}
 */
function outcomeOf(entry) {
  if (typeof entry.status === 'string') {
    const status = entry.status.trim().toLowerCase()
    if (['pass', 'passed', 'ok', 'success', 'succeeded', 'green', 'clean'].includes(status)) return true
    if (['fail', 'failed', 'error', 'failure', 'red', 'not-clean'].includes(status)) return false
  }
  if (typeof entry.ok === 'boolean') return entry.ok
  if (typeof entry.pass === 'boolean') return entry.pass
  if (typeof entry.success === 'boolean') return entry.success
  if (entry.exitCode !== undefined && entry.exitCode !== null) {
    const exitCode = typeof entry.exitCode === 'number' ? entry.exitCode : Number(entry.exitCode)
    if (Number.isFinite(exitCode)) return exitCode === 0
  }
  if (entry.error !== undefined && entry.error !== null && entry.error !== '') return false
  return null
}

/**
 * @param {Record<string, any>} entry
 * @returns {string | null}
 */
function receiptCommand(entry) {
  const commands = Array.isArray(entry.commands) ? entry.commands : []
  const rendered = commands
    .filter((command) => isPlainObject(command))
    .map((command) => `${command.id ?? '?'}: ${command.command ?? '?'}`)
    .join('; ')
  return rendered || null
}

/**
 * @param {Record<string, any>} entry
 * @returns {number | null}
 */
function receiptExitCode(entry) {
  const commands = Array.isArray(entry.commands) ? entry.commands : []
  if (commands.length === 0) return null
  const failed = commands.find((command) => isPlainObject(command) && command.exitCode !== 0)
  if (!failed) return 0
  return typeof failed.exitCode === 'number' ? failed.exitCode : 1
}

/**
 * @param {Record<string, any>} entry
 * @returns {string | null}
 */
function receiptEvidence(entry) {
  if (entry.ok === true) {
    const count = Array.isArray(entry.tests) ? entry.tests.length : 0
    const tip = String(entry.treeTip ?? '').slice(0, 12)
    return `${count} test(s) passed${tip ? ` at ${tip}` : ''}; receipt ${entry.receiptPath ?? entry.diagnosticsPath ?? '(none)'}`
  }
  return `test discovery failed: ${String(entry.error ?? 'unknown').slice(0, 300)}`
}

/**
 * Normalize one evidence source entry. Returns null for an entry that names no
 * check and for a non-object, so a reader never silently invents evidence.
 * @param {unknown} raw
 * @param {EvidenceSource} source
 * @returns {EvidenceEntry | null}
 */
export function normalizeEvidence(raw, source) {
  if (!isPlainObject(raw)) return null
  const entry = /** @type {Record<string, any>} */ (raw)
  const names = namesOf(entry)
  if (names.length === 0) return null
  const receipt = isDiscoveryReceipt(entry)
  return {
    names,
    name: names[0],
    source,
    ok: outcomeOf(entry),
    command: receipt ? receiptCommand(entry) : nonEmptyString(entry.command) ? String(entry.command) : null,
    exitCode: receipt
      ? receiptExitCode(entry)
      : typeof entry.exitCode === 'number'
        ? entry.exitCode
        : null,
    evidence: receipt
      ? receiptEvidence(entry)
      : nonEmptyString(entry.evidence)
        ? String(entry.evidence)
        : null,
    treeTip: nonEmptyString(entry.treeTip) ? String(entry.treeTip) : null,
    entry,
  }
}

/**
 * Every evidence record for one mission, newest first within a source:
 * completion checks, then discovery receipts (when the shape accepts them),
 * then caller-supplied close-time checks.
 * @param {EvidenceContract} contract
 * @param {Record<string, any> | null | undefined} mission
 * @param {{ extraChecks?: any[], missionId?: string }} [options]
 * @returns {EvidenceEntry[]}
 */
export function evidenceEntries(contract, mission, { extraChecks = [], missionId = mission?.id } = {}) {
  /** @type {EvidenceEntry[]} */
  const records = []
  if (contract?.completionChecks !== false) {
    const checks = Array.isArray(mission?.completionReport?.checks) ? mission.completionReport.checks : []
    for (let index = checks.length - 1; index >= 0; index -= 1) {
      const record = normalizeEvidence(checks[index], EVIDENCE_SOURCE.COMPLETION)
      if (record) records.push(record)
    }
  }
  if (contract?.testReceipts) {
    const runs = Array.isArray(mission?.testRuns) ? mission.testRuns : []
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index]
      if (!isPlainObject(run)) continue
      const nested = Array.isArray(run.checks) && run.checks.length > 0
      if (nested) {
        for (let inner = run.checks.length - 1; inner >= 0; inner -= 1) {
          const record = normalizeEvidence(run.checks[inner], EVIDENCE_SOURCE.DISCOVERY)
          if (record) records.push(record)
        }
      } else {
        const record = normalizeEvidence(run, EVIDENCE_SOURCE.DISCOVERY)
        if (record) records.push(record)
      }
    }
  }
  for (let index = extraChecks.length - 1; index >= 0; index -= 1) {
    const entry = extraChecks[index]
    if (!isPlainObject(entry)) continue
    const scope = entry.missionId ?? entry.mission_id
    if (scope !== undefined && scope !== null && String(scope) !== missionId) continue
    const record = normalizeEvidence(entry, EVIDENCE_SOURCE.INPUT)
    if (record) records.push(record)
  }
  return records
}

/**
 * The most authoritative recorded outcome for one check name. Completion
 * checks win over discovery receipts, which win over caller-supplied checks;
 * within a source the newest entry wins.
 * @param {EvidenceContract} contract
 * @param {Record<string, any> | null | undefined} mission
 * @param {string} name
 * @param {{ extraChecks?: any[], missionId?: string }} [options]
 * @returns {EvidenceEntry | null}
 */
export function findEvidence(contract, mission, name, options = {}) {
  for (const record of evidenceEntries(contract, mission, options)) {
    if (!record.names.includes(name)) continue
    if (record.ok === null) continue
    return record
  }
  return null
}

/**
 * The passing discovery receipt bound to `branchTip`, or null. A receipt is
 * evidence only for the tree it ran on, so a receipt recorded at another tip
 * (or no tip) never satisfies the merge gate.
 * @param {EvidenceContract} contract
 * @param {Record<string, any> | null | undefined} mission
 * @param {string | null | undefined} branchTip
 * @returns {EvidenceEntry | null}
 */
export function passingDiscovery(contract, mission, branchTip) {
  if (contract?.testReceipts !== 'tip-bound') return null
  if (!nonEmptyString(branchTip)) return null
  const tip = String(branchTip)
  return (
    evidenceEntries(contract, mission).find(
      (record) => record.source === EVIDENCE_SOURCE.DISCOVERY && record.ok === true && record.treeTip === tip,
    ) ?? null
  )
}

/**
 * Whether a mission has any recorded check evidence. `gates.requireChecks`
 * asks this question; a discovery receipt answers it because a receipt is
 * stronger evidence than a hand-written check line.
 * @param {EvidenceContract} contract
 * @param {Record<string, any> | null | undefined} mission
 * @returns {boolean}
 */
export function hasCheckEvidence(contract, mission) {
  return evidenceEntries(contract, mission).length > 0
}

/**
 * Whether the mission has recorded test-discovery receipts. Diagnostics use
 * this instead of reading `mission.testRuns` themselves.
 * @param {Record<string, any> | null | undefined} mission
 * @returns {boolean}
 */
export function hasTestReceipts(mission) {
  return Array.isArray(mission?.testRuns) && mission.testRuns.length > 0
}
