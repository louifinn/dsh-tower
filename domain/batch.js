// Batch admission packets (2.1): pure create/close/summarize validation.
//
// A batch is a second, generic lifecycle layered over missions (#149 W3): it is
// not a mission shape and never gets a kind. Its whole lifecycle — statuses,
// transition edges, terminality, legacy-status normalization and the status
// vocabulary — lives in this module (see `BATCH_STATUS*`), so no other module
// compares or writes `batch.status` to a string literal.
//
// This module performs no filesystem, git, or subprocess I/O. The tower tool
// layer reads the worktree, receipt files, and test results, then passes what
// it observed into `validateClose`. Receipt hashes may be supplied by the
// caller in `input.receipts`/`input.receiptHashes` (already computed) or bound
// to a passing check as `{ receiptRef, receiptHash }`; both forms are checked
// against the batch's frozen `receiptPaths`.
//
// Expected state/batch shapes (everything else is ignored):
//   state.missions[]        -> { id, status, mergedCommit?, completionReport?, testRuns? }
//   state.batches[]         -> { id, status: 'open'|'closed'|'abandoned', missionIds,
//                                exclusions, requiredChecks, receiptPaths, receiptHashes? }
//   state.legacySnapshots[] -> { sourceHash, pausedMissionIds: string[] }
// A batch record is the normalized validateCreate result plus `id`, `status`,
// `createdAt`, and the optional `receiptHashes` expected-hash map.
//
// 2.1 rule: validateCreate throws `BatchError` (code `batch-invalid`) for
// invalid input; validateClose returns blockers instead of throwing for
// verification/lifecycle failures and only throws for structurally malformed
// arguments. I/O-bound rules from the Codex batch contract (dirty worktree,
// branch identity, real HEAD comparison) stay in the tool layer; pass
// `input.treeTip` to bind recorded check `treeCommit` values to the current
// HEAD.
import path from 'node:path'
import { findEvidence } from './evidence.js'
import { shapeFor } from './shapes/index.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const MAX_MISSIONS = 50
const MAX_CHECKS = 50
const MAX_RECEIPTS = 200
const MAX_EXCLUSIONS = 50

// The batch lifecycle contract (#149 W3). A batch is opened by tower_batch
// create and leaves `open` exactly once, to `closed` (every member verified) or
// `abandoned` (retired without verification). There is no third stop state and
// no per-shape variant.
export const BATCH_STATUS = Object.freeze({ OPEN: 'open', CLOSED: 'closed', ABANDONED: 'abandoned' })
/** @type {readonly string[]} */
export const BATCH_STATUSES = Object.freeze([BATCH_STATUS.OPEN, BATCH_STATUS.CLOSED, BATCH_STATUS.ABANDONED])
export const BATCH_TRANSITIONS = Object.freeze({
  [BATCH_STATUS.OPEN]: Object.freeze([BATCH_STATUS.CLOSED, BATCH_STATUS.ABANDONED]),
  [BATCH_STATUS.CLOSED]: Object.freeze([]),
  [BATCH_STATUS.ABANDONED]: Object.freeze([]),
})
// Pre-v5 documents (and hand-written fixtures) used synonyms for `open`; v5
// normalizes them once in the state migration and nothing else accepts them.
/** @type {readonly string[]} */
const LEGACY_OPEN_BATCH_STATUSES = Object.freeze(['created', 'active', 'pending'])

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBatchTerminal(value) {
  return value === BATCH_STATUS.CLOSED || value === BATCH_STATUS.ABANDONED
}

/**
 * @param {unknown} from
 * @param {unknown} to
 * @returns {boolean}
 */
export function canTransitionBatch(from, to) {
  return (BATCH_TRANSITIONS[/** @type {string} */ (from)] ?? []).includes(/** @type {string} */ (to))
}

/**
 * Normalize a recorded batch status to the canonical vocabulary. An absent
 * status means `open`; a legacy synonym means `open`; an unknown value is left
 * as-is so validation can report it instead of silently rewriting it.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeBatchStatus(value) {
  if (value === undefined || value === null || value === '') return BATCH_STATUS.OPEN
  const status = String(value)
  if (BATCH_STATUSES.includes(status)) return status
  if (LEGACY_OPEN_BATCH_STATUSES.includes(status)) return BATCH_STATUS.OPEN
  return status
}


/** Stable batch error; add `batch-invalid` to ERROR_CODES to map it directly. */
export class BatchError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BatchError'
    this.code = 'batch-invalid'
  }
}

function fail(message) {
  throw new BatchError(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function readInput(input, camel, snake) {
  if (!isPlainObject(input)) return undefined
  if (input[camel] !== undefined) return input[camel]
  return input[snake]
}

function trimmedName(value, where) {
  if (!nonEmptyString(value)) fail(`${where} must be a non-empty string`)
  return value.trim()
}

function normalizeIdList(value, where, { max = MAX_MISSIONS } = {}) {
  if (!Array.isArray(value)) fail(`${where} must be a non-empty array`)
  if (value.length === 0) fail(`${where} must be a non-empty array`)
  if (value.length > max) fail(`${where} must have at most ${max} entries`)
  const ids = []
  for (const [index, raw] of value.entries()) {
    const id = trimmedName(raw, `${where}[${index}]`)
    if (ids.includes(id)) fail(`${where}[${index}] must not duplicate "${id}"`)
    ids.push(id)
  }
  return ids
}

function normalizeNameList(value, where, { max = MAX_CHECKS, allowEmpty = false } = {}) {
  if (!Array.isArray(value)) fail(`${where} must be an array`)
  if (!allowEmpty && value.length === 0) fail(`${where} must be a non-empty array`)
  if (value.length > max) fail(`${where} must have at most ${max} entries`)
  const names = []
  for (const [index, raw] of value.entries()) {
    const name = trimmedName(raw, `${where}[${index}]`)
    if (names.includes(name)) fail(`${where}[${index}] must not duplicate "${name}"`)
    names.push(name)
  }
  return names
}

/** Normalize one receipt path to `a/b/c`; rejects absolute, parent, glob, and directory paths. */
function normalizeReceiptPath(value, where) {
  if (!nonEmptyString(value)) fail(`${where} must be a non-empty string`)
  const raw = value.trim()
  if (raw.includes('\0')) fail(`${where} must not contain a NUL byte`)
  if (/[*?]/.test(raw) || /[[\]{}]/.test(raw)) fail(`${where} must not contain wildcard characters`)
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]{2}/.test(raw)) {
    fail(`${where} must be a relative path`)
  }
  if (/[\\/]$/.test(raw)) fail(`${where} must name a file, not a directory`)
  const segments = []
  for (const segment of raw.split(/[\\/]+/)) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') fail(`${where} must not contain ".."`)
    segments.push(segment)
  }
  if (segments.length === 0) fail(`${where} must be a relative file path`)
  return segments.join('/')
}

function normalizeReceiptPathOrNull(value, where) {
  try {
    return normalizeReceiptPath(value, where)
  } catch {
    return null
  }
}

/** Legacy snapshots imported by adapters/legacy.js; only paused missions may be excluded. */
function pausedLegacyIds(state) {
  const ids = new Set()
  const snapshots = Array.isArray(state.legacySnapshots) ? state.legacySnapshots : []
  for (const snapshot of snapshots) {
    if (!isPlainObject(snapshot)) continue
    // #149 W4: `pausedMissionIds` is the one canonical field the legacy adapter
    // writes. Reading any other shape here would be a second live vocabulary.
    if (!Array.isArray(snapshot.pausedMissionIds)) continue
    for (const id of snapshot.pausedMissionIds) if (nonEmptyString(id)) ids.add(id.trim())
  }
  return ids
}

function missionInOpenBatch(state, missionId) {
  const batches = Array.isArray(state.batches) ? state.batches : []
  for (const batch of batches) {
    if (!isPlainObject(batch)) continue
    const status = normalizeBatchStatus(batch.status ?? BATCH_STATUS.OPEN)
    if (isBatchTerminal(status)) continue
    if (Array.isArray(batch.missionIds) && batch.missionIds.includes(missionId)) return batch
  }
  return null
}

function blocker(message, code = 'batch-invalid') {
  return { code, message }
}

/**
 * Validate `tower_batch create` input and return the normalized, frozen batch
 * payload `{ missionIds, exclusions, requiredChecks, receiptPaths }`.
 * Throws `BatchError` (`batch-invalid`) for unknown/duplicate missions,
 * non-paused exclusions, empty requiredChecks, or unsafe receipt paths.
 * Accepts camelCase keys and snake_case aliases (`mission_ids`, ...).
 */
export function validateCreate(state, input) {
  if (!isPlainObject(state)) fail('state must be an object')
  if (!isPlainObject(input)) fail('input must be an object')
  const missions = Array.isArray(state.missions) ? state.missions : fail('state.missions must be an array')
  const byId = new Map()
  for (const mission of missions) {
    if (isPlainObject(mission) && nonEmptyString(mission.id)) byId.set(mission.id, mission)
  }

  const missionIds = normalizeIdList(readInput(input, 'missionIds', 'mission_ids'), 'missionIds')
  for (const missionId of missionIds) {
    if (!byId.has(missionId)) fail(`missionIds must reference known missions: "${missionId}" is unknown`)
    const openBatch = missionInOpenBatch(state, missionId)
    if (openBatch) fail(`mission ${missionId} already belongs to open batch ${openBatch.id ?? '(unnamed)'}`)
  }

  const exclusionsRaw = readInput(input, 'exclusions', 'exclusions') ?? []
  if (!Array.isArray(exclusionsRaw)) fail('exclusions must be an array')
  if (exclusionsRaw.length > MAX_EXCLUSIONS) fail(`exclusions must have at most ${MAX_EXCLUSIONS} entries`)
  const pausedLegacy = pausedLegacyIds(state)
  const exclusions = []
  for (const [index, raw] of exclusionsRaw.entries()) {
    const exclusion = trimmedName(raw, `exclusions[${index}]`)
    if (exclusions.includes(exclusion)) fail(`exclusions[${index}] must not duplicate "${exclusion}"`)
    if (missionIds.includes(exclusion)) fail(`exclusions[${index}] must not overlap missionIds ("${exclusion}")`)
    if (!pausedLegacy.has(exclusion)) {
      fail(`exclusions[${index}] "${exclusion}" is not a paused legacy mission id`)
    }
    exclusions.push(exclusion)
  }

  const requiredRaw = readInput(input, 'requiredChecks', 'required_checks')
  const requiredChecks = normalizeNameList(requiredRaw === undefined ? ['check'] : requiredRaw, 'requiredChecks')

  const receiptPathsRaw = readInput(input, 'receiptPaths', 'receipt_paths') ?? []
  if (!Array.isArray(receiptPathsRaw)) fail('receiptPaths must be an array')
  if (receiptPathsRaw.length > MAX_RECEIPTS) fail(`receiptPaths must have at most ${MAX_RECEIPTS} entries`)
  const receiptPaths = []
  for (const [index, raw] of receiptPathsRaw.entries()) {
    const receiptPath = normalizeReceiptPath(raw, `receiptPaths[${index}]`)
    if (receiptPaths.includes(receiptPath)) fail(`receiptPaths[${index}] must not duplicate "${receiptPath}"`)
    receiptPaths.push(receiptPath)
  }

  return { missionIds, exclusions, requiredChecks, receiptPaths }
}

function collectReceiptHashes(options) {
  const hashes = new Map()
  const problems = []
  const record = (rawPath, rawValue, where) => {
    const path = normalizeReceiptPathOrNull(rawPath, where)
    if (!path) {
      problems.push(blocker(`${where} is not a safe relative receipt path`))
      return
    }
    const value = isPlainObject(rawValue) ? (rawValue.sha256 ?? rawValue.hash ?? rawValue.receiptHash) : rawValue
    if (!nonEmptyString(value) || !SHA256_PATTERN.test(value.trim())) {
      problems.push(blocker(`${where} hash must be a sha256 hex digest`))
      return
    }
    const normalized = value.trim().toLowerCase()
    if (hashes.has(path) && hashes.get(path) !== normalized) {
      problems.push(blocker(`receipt "${path}" was reported with conflicting hashes`))
      return
    }
    hashes.set(path, normalized)
  }

  const receiptHashes = readInput(options, 'receiptHashes', 'receipt_hashes')
  if (receiptHashes !== undefined) {
    if (!isPlainObject(receiptHashes)) problems.push(blocker('receiptHashes must be an object of path -> sha256'))
    else {
      for (const [rawPath, rawValue] of Object.entries(receiptHashes)) {
        record(rawPath, rawValue, `receiptHashes["${rawPath}"]`)
      }
    }
  }
  const receipts = readInput(options, 'receipts', 'receipts')
  if (receipts !== undefined) {
    if (!Array.isArray(receipts)) problems.push(blocker('receipts must be an array'))
    else {
      for (const [index, entry] of receipts.entries()) {
        if (!isPlainObject(entry)) {
          problems.push(blocker(`receipts[${index}] must be an object`))
          continue
        }
        const rawPath = entry.path ?? entry.receiptPath ?? entry.receipt_path
        record(rawPath, entry, `receipts[${index}]`)
      }
    }
  }
  return { hashes, problems }
}

function expectedReceiptHashes(batch, options) {
  const expected = new Map()
  const add = (value) => {
    if (!isPlainObject(value)) return
    for (const [rawPath, rawHash] of Object.entries(value)) {
      const path = normalizeReceiptPathOrNull(rawPath, `receiptHashes["${rawPath}"]`)
      if (!path || !nonEmptyString(rawHash) || !SHA256_PATTERN.test(rawHash.trim())) continue
      expected.set(path, rawHash.trim().toLowerCase())
    }
  }
  add(batch.receiptHashes)
  add(readInput(options, 'expectedReceiptHashes', 'expected_receipt_hashes'))
  return expected
}

function bindCheckEvidence(entry, missionId, name, receiptPaths, observedHashes) {
  const problems = []
  const record = {}
  const rawRef = entry.receiptRef ?? entry.receipt_ref
  if (rawRef !== undefined && rawRef !== null) {
    const receiptRef = normalizeReceiptPathOrNull(rawRef, `mission ${missionId} check "${name}" receiptRef`)
    if (!receiptRef) {
      problems.push(blocker(`mission ${missionId} check "${name}" has an unsafe receiptRef`))
    } else if (!receiptPaths.includes(receiptRef)) {
      problems.push(blocker(`mission ${missionId} check "${name}" receiptRef "${receiptRef}" is outside the frozen receiptPaths`))
    } else {
      record.receiptRef = receiptRef
      const rawHash = entry.receiptHash ?? entry.receipt_hash
      if (rawHash !== undefined && rawHash !== null) {
        if (!nonEmptyString(rawHash) || !SHA256_PATTERN.test(rawHash.trim())) {
          problems.push(blocker(`mission ${missionId} check "${name}" receiptHash must be a sha256 hex digest`))
        } else {
          const hash = rawHash.trim().toLowerCase()
          record.receiptHash = hash
          if (observedHashes.has(receiptRef) && observedHashes.get(receiptRef) !== hash) {
            problems.push(blocker(`mission ${missionId} check "${name}" receiptHash does not match the reported receipt "${receiptRef}"`))
          } else {
            observedHashes.set(receiptRef, hash)
          }
        }
      }
    }
  }
  return { problems, record }
}

function checkTreeTip(entry, missionId, name, treeTip) {
  if (!treeTip) return []
  const committed = entry.treeCommit ?? entry.tree_commit ?? entry.treeTip ?? entry.tree_tip
  if (!nonEmptyString(committed)) return []
  if (committed.trim() === treeTip) return []
  return [blocker(`mission ${missionId} check "${name}" was recorded at tree ${committed.trim()}, current HEAD is ${treeTip}`)]
}

/**
 * Validate `tower_batch close`: every batch member must be completed or
 * abandoned; every required check must have passed evidence for every
 * non-abandoned member (completion report checks, mission testRuns, or
 * caller-supplied `input.checks`); frozen receipt paths must be reported with
 * a sha256 digest that matches any recorded expected hash. Returns
 * `{ ok, blockers, checks }`; blockers use the 2.1 codes `tests-missing` and
 * `tests-failed` for check shortfalls and `batch-invalid` for structural
 * problems. Caller-supplied `input.treeTip` also binds check `treeCommit`s.
 */
export function validateClose(state, batch, input = {}) {
  if (!isPlainObject(state)) fail('state must be an object')
  if (!isPlainObject(batch)) fail('batch must be an object')
  const options = input === undefined || input === null ? {} : input
  if (!isPlainObject(options)) fail('input must be an object')

  const missionIds = normalizeIdList(batch.missionIds, 'batch.missionIds')
  const requiredChecks = normalizeNameList(batch.requiredChecks, 'batch.requiredChecks')
  const exclusions = batch.exclusions ?? []
  if (!Array.isArray(exclusions)) fail('batch.exclusions must be an array')
  const receiptPathsRaw = batch.receiptPaths ?? []
  if (!Array.isArray(receiptPathsRaw)) fail('batch.receiptPaths must be an array')
  const receiptPaths = receiptPathsRaw.map((value, index) => normalizeReceiptPath(value, `batch.receiptPaths[${index}]`))

  const blockers = []
  const status = normalizeBatchStatus(batch.status ?? BATCH_STATUS.OPEN)
  if (status === BATCH_STATUS.CLOSED) blockers.push(blocker(`batch ${batch.id ?? ''} is already closed`.trim()))
  else if (status === BATCH_STATUS.ABANDONED) blockers.push(blocker(`batch ${batch.id ?? ''} is abandoned`.trim()))

  const missions = Array.isArray(state.missions) ? state.missions : fail('state.missions must be an array')
  const byId = new Map()
  for (const mission of missions) if (isPlainObject(mission) && nonEmptyString(mission.id)) byId.set(mission.id, mission)

  const extraChecks = Array.isArray(options.checks) ? options.checks : []
  const treeTip = nonEmptyString(options.treeTip)
    ? options.treeTip.trim()
    : nonEmptyString(options.tree_tip)
      ? options.tree_tip.trim()
      : null
  const observed = collectReceiptHashes(options)
  blockers.push(...observed.problems)

  const results = []
  for (const missionId of missionIds) {
    const mission = byId.get(missionId)
    if (!mission) {
      blockers.push(blocker(`batch mission "${missionId}" does not exist`))
      continue
    }
    if (!['completed', 'merged', 'abandoned'].includes(mission.status)) {
      blockers.push(blocker(`mission ${missionId} is ${mission.status}, not completed, merged or abandoned`))
      continue
    }
    for (const name of requiredChecks) {
      if (mission.status === 'abandoned') {
        results.push({ missionId, name, ok: true, outcome: 'skipped', source: 'abandoned' })
        continue
      }
      const found = findEvidence(shapeFor(mission.kind).evidence, mission, name, { extraChecks, missionId })
      if (!found) {
        results.push({ missionId, name, ok: false, outcome: 'missing', source: null })
        blockers.push(blocker(`mission ${missionId} has no recorded check "${name}"`, 'tests-missing'))
        continue
      }
      if (found.ok !== true) {
        results.push({ missionId, name, ok: false, outcome: 'failed', source: found.source })
        blockers.push(blocker(`mission ${missionId} check "${name}" did not pass`, 'tests-failed'))
        continue
      }
      const evidence = bindCheckEvidence(found.entry, missionId, name, receiptPaths, observed.hashes)
      blockers.push(...evidence.problems)
      blockers.push(...checkTreeTip(found.entry, missionId, name, treeTip))
      results.push({
        missionId,
        name,
        ok: evidence.problems.length === 0,
        outcome: 'passed',
        source: found.source,
        ...evidence.record,
      })
    }
  }

  const expected = expectedReceiptHashes(batch, options)
  for (const receiptPath of receiptPaths) {
    const hash = observed.hashes.get(receiptPath)
    if (!hash) {
      blockers.push(blocker(`receipt "${receiptPath}" was not reported`))
      continue
    }
    const expectedHash = expected.get(receiptPath)
    if (expectedHash && expectedHash !== hash) {
      blockers.push(blocker(`receipt "${receiptPath}" sha256 does not match the recorded expected hash`))
    }
  }
  for (const receiptPath of observed.hashes.keys()) {
    if (!receiptPaths.includes(receiptPath)) {
      blockers.push(blocker(`receipt "${receiptPath}" is outside the frozen receiptPaths`))
    }
  }

  return { ok: blockers.length === 0, blockers, checks: results }
}

/**
 * Read-only batch status payload (no I/O): member states, per-check evidence
 * across members, and the checks that still block a close. Receipt coverage is
 * intentionally not evaluated here because hashes are only known at close.
 */
export function summarize(state, batch) {
  if (!isPlainObject(state)) fail('state must be an object')
  if (!isPlainObject(batch)) fail('batch must be an object')
  const missionIds = normalizeIdList(batch.missionIds, 'batch.missionIds')
  const requiredChecks = normalizeNameList(batch.requiredChecks, 'batch.requiredChecks')
  const receiptPathsRaw = batch.receiptPaths ?? []
  if (!Array.isArray(receiptPathsRaw)) fail('batch.receiptPaths must be an array')
  const receiptPaths = receiptPathsRaw.map((value, index) => normalizeReceiptPath(value, `batch.receiptPaths[${index}]`))
  const exclusions = Array.isArray(batch.exclusions) ? batch.exclusions : []
  const status = normalizeBatchStatus(batch.status ?? BATCH_STATUS.OPEN)

  const missions = Array.isArray(state.missions) ? state.missions : fail('state.missions must be an array')
  const byId = new Map()
  for (const mission of missions) if (isPlainObject(mission) && nonEmptyString(mission.id)) byId.set(mission.id, mission)

  const blockers = []
  if (isBatchTerminal(status)) blockers.push(blocker(`batch ${batch.id ?? ''} is already ${status}`.trim()))
  const members = []
  const checks = []
  for (const missionId of missionIds) {
    const mission = byId.get(missionId)
    members.push({
      id: missionId,
      found: Boolean(mission),
      status: mission?.status ?? null,
      mergedCommit: mission?.mergedCommit ?? null,
      abandoned: mission?.status === 'abandoned',
    })
    if (!mission) {
      blockers.push(blocker(`batch mission "${missionId}" does not exist`))
      continue
    }
    if (!['completed', 'merged', 'abandoned'].includes(mission.status)) {
      blockers.push(blocker(`mission ${missionId} is ${mission.status}, not completed, merged or abandoned`))
      continue
    }
    for (const name of requiredChecks) {
      if (mission.status === 'abandoned') {
        checks.push({ missionId, name, ok: true, outcome: 'skipped', source: 'abandoned' })
        continue
      }
      const found = findEvidence(shapeFor(mission.kind).evidence, mission, name, { missionId })
      if (!found) {
        checks.push({ missionId, name, ok: false, outcome: 'missing', source: null })
        continue
      }
      checks.push({
        missionId,
        name,
        ok: found.ok === true,
        outcome: found.ok === true ? 'passed' : 'failed',
        source: found.source,
      })
    }
  }

  const pendingChecks = [...new Set(checks.filter((check) => check.outcome === 'missing').map((check) => check.name))]
  const failedChecks = [...new Set(checks.filter((check) => check.outcome === 'failed').map((check) => check.name))]
  return {
    batchId: batch.id ?? null,
    status,
    closed: status === 'closed',
    abandoned: status === 'abandoned',
    createdAt: batch.createdAt ?? null,
    closedAt: batch.closedAt ?? null,
    missionIds,
    exclusions,
    requiredChecks,
    receiptPaths,
    receiptCount: receiptPaths.length,
    members,
    checks,
    pendingChecks,
    failedChecks,
    blockers,
    ok: blockers.length === 0 && pendingChecks.length === 0 && failedChecks.length === 0,
  }
}
