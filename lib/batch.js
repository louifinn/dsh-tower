// Batch admission packets (2.1): pure create/close/summarize validation.
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
//   state.legacySnapshots[] -> { hash, missions: [{ id, status }], pausedIds? }
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

const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const MAX_MISSIONS = 50
const MAX_CHECKS = 50
const MAX_RECEIPTS = 200
const MAX_EXCLUSIONS = 50
const PASS_STATUSES = new Set(['passed', 'pass', 'ok', 'success', 'succeeded', 'done', 'green'])
const FAIL_STATUSES = new Set(['failed', 'fail', 'error', 'errored', 'timeout', 'timed-out', 'blocked'])
const OPEN_BATCH_STATUSES = new Set(['open', 'created', 'active', 'pending'])
const CLOSED_BATCH_STATUSES = new Set(['closed', 'abandoned'])

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

/** Legacy snapshots imported by lib/legacy.js; only paused missions may be excluded. */
function pausedLegacyIds(state) {
  const ids = new Set()
  const collectMission = (mission) => {
    if (isPlainObject(mission) && nonEmptyString(mission.id) && mission.status === 'paused') {
      ids.add(mission.id.trim())
    }
  }
  const collectList = (value) => {
    if (Array.isArray(value)) value.forEach(collectMission)
    else if (isPlainObject(value)) Object.values(value).forEach(collectMission)
  }
  const snapshots = Array.isArray(state.legacySnapshots) ? state.legacySnapshots : []
  for (const snapshot of snapshots) {
    if (!isPlainObject(snapshot)) continue
    collectList(snapshot.missions)
    if (isPlainObject(snapshot.snapshot)) collectList(snapshot.snapshot.missions)
    if (isPlainObject(snapshot.payload)) collectList(snapshot.payload.missions)
    // lib/legacy.js stores imported snapshots with `pausedMissionIds`; older,
    // hand-written fixtures may use `pausedIds`.
    for (const key of ['pausedIds', 'pausedMissionIds']) {
      if (Array.isArray(snapshot[key])) {
        for (const id of snapshot[key]) if (nonEmptyString(id)) ids.add(id.trim())
      }
    }
  }
  return ids
}

function missionInOpenBatch(state, missionId) {
  const batches = Array.isArray(state.batches) ? state.batches : []
  for (const batch of batches) {
    if (!isPlainObject(batch)) continue
    const status = batch.status ?? 'open'
    if (!OPEN_BATCH_STATUSES.has(status)) continue
    if (Array.isArray(batch.missionIds) && batch.missionIds.includes(missionId)) return batch
  }
  return null
}

function checkNames(entry) {
  if (!isPlainObject(entry)) return []
  for (const candidate of [entry.name, entry.id, entry.check]) {
    if (nonEmptyString(candidate)) return [candidate.trim()]
  }
  // A nameless runDiscovery receipt stored in mission.testRuns is the built-in
  // test tool evidence. It answers to `tests` (the tool-layer auto check name)
  // and to `tower_test` (the synthetic name used by earlier integrations).
  if (Array.isArray(entry.commands) && Array.isArray(entry.tests)) return ['tests', 'tower_test']
  return []
}

function checkOutcome(entry) {
  if (!isPlainObject(entry)) return null
  if (typeof entry.status === 'string') {
    const status = entry.status.trim().toLowerCase()
    if (PASS_STATUSES.has(status)) return true
    if (FAIL_STATUSES.has(status)) return false
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
 * Find the most authoritative recorded outcome for `name` on one mission:
 * completion report first, then testRuns newest-first, then caller-supplied
 * `extraChecks` (optionally scoped by `missionId`).
 */
function findCheck(mission, name, extraChecks, missionId) {
  const sources = []
  const reportChecks = Array.isArray(mission?.completionReport?.checks) ? mission.completionReport.checks : []
  for (let index = reportChecks.length - 1; index >= 0; index -= 1) {
    sources.push({ source: 'completionReport', entry: reportChecks[index] })
  }
  const testRuns = Array.isArray(mission?.testRuns) ? mission.testRuns : []
  for (let index = testRuns.length - 1; index >= 0; index -= 1) {
    const run = testRuns[index]
    if (!isPlainObject(run)) continue
    if (Array.isArray(run.checks) && run.checks.length > 0) {
      for (let inner = run.checks.length - 1; inner >= 0; inner -= 1) {
        sources.push({ source: 'testRuns', entry: run.checks[inner] })
      }
    } else {
      sources.push({ source: 'testRuns', entry: run })
    }
  }
  for (let index = extraChecks.length - 1; index >= 0; index -= 1) {
    const entry = extraChecks[index]
    if (!isPlainObject(entry)) continue
    const scope = entry.missionId ?? entry.mission_id
    if (scope !== undefined && scope !== null && String(scope) !== missionId) continue
    sources.push({ source: 'input', entry })
  }
  for (const source of sources) {
    if (!checkNames(source.entry).includes(name)) continue
    const outcome = checkOutcome(source.entry)
    if (outcome === null) continue
    return { outcome, source: source.source, entry: source.entry }
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
  const status = batch.status ?? 'open'
  if (status === 'closed') blockers.push(blocker(`batch ${batch.id ?? ''} is already closed`.trim()))
  else if (status === 'abandoned') blockers.push(blocker(`batch ${batch.id ?? ''} is abandoned`.trim()))

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
    if (mission.status !== 'completed' && mission.status !== 'abandoned') {
      blockers.push(blocker(`mission ${missionId} is ${mission.status}, not completed or abandoned`))
      continue
    }
    for (const name of requiredChecks) {
      if (mission.status === 'abandoned') {
        results.push({ missionId, name, ok: true, outcome: 'skipped', source: 'abandoned' })
        continue
      }
      const found = findCheck(mission, name, extraChecks, missionId)
      if (!found) {
        results.push({ missionId, name, ok: false, outcome: 'missing', source: null })
        blockers.push(blocker(`mission ${missionId} has no recorded check "${name}"`, 'tests-missing'))
        continue
      }
      if (found.outcome !== true) {
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
  const status = batch.status ?? 'open'

  const missions = Array.isArray(state.missions) ? state.missions : fail('state.missions must be an array')
  const byId = new Map()
  for (const mission of missions) if (isPlainObject(mission) && nonEmptyString(mission.id)) byId.set(mission.id, mission)

  const blockers = []
  if (CLOSED_BATCH_STATUSES.has(status)) blockers.push(blocker(`batch ${batch.id ?? ''} is already ${status}`.trim()))
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
    if (mission.status !== 'completed' && mission.status !== 'abandoned') {
      blockers.push(blocker(`mission ${missionId} is ${mission.status}, not completed or abandoned`))
      continue
    }
    for (const name of requiredChecks) {
      if (mission.status === 'abandoned') {
        checks.push({ missionId, name, ok: true, outcome: 'skipped', source: 'abandoned' })
        continue
      }
      const found = findCheck(mission, name, [], missionId)
      if (!found) {
        checks.push({ missionId, name, ok: false, outcome: 'missing', source: null })
        continue
      }
      checks.push({
        missionId,
        name,
        ok: found.outcome === true,
        outcome: found.outcome === true ? 'passed' : 'failed',
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
