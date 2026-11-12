// Read-only legacy snapshot support.
//
// Validates, and stores an immutable copy of, a Tower Codex (schemaVersion: 1)
// or DSH `state.json` payload under `<common>/dsh-tower/legacy/<sha256>.json`.
// Loading a snapshot never activates, adopts, or resumes anything: `paused`
// missions stay paused, no mission/worktree/state identity is created, and this
// module never writes `state.json` — the caller records the returned snapshot
// summary in `state.legacySnapshots` inside its own lock.
//
// `validateLegacyMap` is the audit-only mapping check: a map is a record that
// legacy id X corresponds to DSH mission Y. It never adopts or restores work.
import { fsp } from './store-fs.js'
import path from 'node:path'
import crypto from 'node:crypto'
import { isShapeKind } from '../domain/shapes/index.js'

const SCHEMA_VERSION = 1
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
const DSH_STATUSES = ['planned', 'active', 'completed', 'blocked', 'paused', 'merged', 'abandoned']
// Tower Codex also retires missions; `retired` is accepted input vocabulary and
// is remapped below. It is never a DSH mission status.
const CODEX_STATUSES = [...DSH_STATUSES, 'retired']
const DSH_ID_RE = /^M\d+$/
const CODEX_ID_RE = /^T\d{4,}$/
const SHA256_RE = /^[a-f0-9]{64}$/

// The strict adapter contract (#149 W4). One payload is exactly one legacy
// format; every status and field alias this module accepts is declared here.
// Missions are normalised to the shape registry's DSH vocabulary: a status
// remap is applied and reported in `remapped`, never silently invented, and a
// value the adapter cannot carry is reported in `unresolved`/`dropped`.
export const LEGACY_FORMATS = Object.freeze({
  'tower-codex': Object.freeze({
    idPattern: CODEX_ID_RE,
    idHint: 'T####',
    statuses: CODEX_STATUSES,
    statusRemap: Object.freeze({ retired: 'abandoned' }),
    baseBranchField: 'baseBranch',
    requiresBaseBranch: true,
  }),
  dsh: Object.freeze({
    idPattern: DSH_ID_RE,
    idHint: 'M#',
    statuses: DSH_STATUSES,
    statusRemap: Object.freeze({}),
    baseBranchField: 'base',
    requiresBaseBranch: false,
  }),
})

// Only these fields cross the adapter boundary. Everything else a legacy
// mission carries is validated for safety, then reported as dropped: the
// adapter deliberately does not invent DSH semantics for it.
const CARRIED_MISSION_FIELDS = Object.freeze(['id', 'status', 'kind'])
const DROPPED_REASON = 'validated for safety but not carried into the summary; the exact payload bytes remain in the stored snapshot'

function fail(code, message) {
  /** @type {Error & {code?: string}} */
  const error = new Error(message)
  error.code = code
  throw error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

// Path semantics are selected from an injected platform so both branches are
// testable on any OS (#86). On the real platform this is exactly `path`.
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

export function win32Lower(value, platform = process.platform) {
  return platform === 'win32' ? value.toLowerCase() : value
}

/**
 * Is `child` inside `parent` (or the same path)? Windows reconciles case
 * because NTFS is case-insensitive; the POSIX branch stays case-sensitive.
 */
export function isInside(parent, child, platform = process.platform) {
  const pathImpl = pathFor(platform)
  const relative = pathImpl.relative(
    win32Lower(pathImpl.resolve(parent), platform),
    win32Lower(pathImpl.resolve(child), platform),
  )
  return relative === '' || (!relative.startsWith('..') && !pathImpl.isAbsolute(relative))
}

async function realpathOrResolve(target) {
  try {
    return await fsp.realpath(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return path.resolve(target)
    throw error
  }
}

/**
 * @param {string} error
 * @param {'tower-codex'|'dsh'|null} [format]
 */
function invalidResult(error, format = null) {
  return {
    ok: false,
    format,
    schemaVersion: null,
    missions: [],
    missionIds: [],
    missionCount: 0,
    paused: [],
    unresolved: [],
    dropped: [],
    remapped: [],
    events: null,
    legacySnapshots: null,
    repoRoot: null,
    baseBranch: null,
    error,
  }
}

function validateScope(scope, id) {
  if (!Array.isArray(scope)) return `mission ${id} has no scope array`
  for (const entry of scope) {
    if (typeof entry !== 'string' || entry.trim().length === 0) return `mission ${id} scope entries must be non-empty strings`
    const value = entry.replace(/\\/g, '/').trim()
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return `mission ${id} scope must be relative: ${entry}`
    if (value.split('/').some((part) => part === '..')) return `mission ${id} scope must not contain "..": ${entry}`
  }
  return null
}

function validateTasks(tasks, id) {
  if (!Array.isArray(tasks)) return `mission ${id} has no tasks array`
  for (const entry of tasks) {
    if (typeof entry === 'string') {
      if (entry.trim().length === 0) return `mission ${id} task entries must be non-empty strings`
      continue
    }
    if (!isPlainObject(entry) || !isNonEmptyString(entry.text)) {
      return `mission ${id} task entries must be strings or objects with a text field`
    }
    if (entry.status !== undefined && typeof entry.status !== 'string') {
      return `mission ${id} task status must be a string`
    }
  }
  return null
}

function validateDeps(deps, id) {
  if (!Array.isArray(deps)) return `mission ${id} has no deps array`
  for (const entry of deps) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return `mission ${id} deps entries must be non-empty mission ids`
    }
  }
  return null
}

function validateReviews(reviews, id) {
  if (!Array.isArray(reviews)) return `mission ${id} has no reviews array`
  for (const entry of reviews) {
    if (!isPlainObject(entry)) return `mission ${id} review entries must be objects`
  }
  return null
}

/**
 * Detect one legacy format per payload. A declared `format` is authoritative;
 * otherwise every mission id must belong to exactly one namespace. Empty
 * mission lists use the top-level shape (a Tower Codex snapshot has a
 * baseBranch; DSH state uses `base`).
 * @param {any} payload
 * @returns {{ format: 'tower-codex'|'dsh'|null, error: string|null }}
 */
function detectFormat(payload) {
  if (payload.format !== undefined) {
    if (typeof payload.format !== 'string' || !Object.prototype.hasOwnProperty.call(LEGACY_FORMATS, payload.format)) {
      return { format: null, error: `unsupported legacy format ${JSON.stringify(payload.format)} (expected tower-codex or dsh)` }
    }
    return { format: payload.format, error: null }
  }
  if (payload.missions.length === 0) {
    return { format: isNonEmptyString(payload.baseBranch) ? 'tower-codex' : 'dsh', error: null }
  }
  let codex = 0
  let dsh = 0
  for (const mission of payload.missions) {
    const id = mission?.id
    if (typeof id === 'string' && CODEX_ID_RE.test(id)) codex += 1
    else if (typeof id === 'string' && DSH_ID_RE.test(id)) dsh += 1
  }
  if (codex === payload.missions.length) return { format: 'tower-codex', error: null }
  if (dsh === payload.missions.length) return { format: 'dsh', error: null }
  for (const mission of payload.missions) {
    const id = mission?.id
    if (typeof id !== 'string' || (!CODEX_ID_RE.test(id) && !DSH_ID_RE.test(id))) {
      return {
        format: null,
        error: `unsupported legacy mission id ${JSON.stringify(id)} (expected T#### for Tower Codex or M# for DSH)`,
      }
    }
  }
  return { format: null, error: 'legacy snapshot mixes mission id namespaces (T#### and M#); one snapshot is one format' }
}

/**
 * @param {any} payload
 * @param {'tower-codex'|'dsh'} format
 * @param {{ idPattern: RegExp, idHint: string, statuses: string[], statusRemap: Record<string, string>, baseBranchField: string, requiresBaseBranch: boolean }} spec
 * @returns {{error:string|null, missions:Array<{id:string,status:string,kind:string}>, missionIds:string[], paused:string[],
 *   unresolved:Array<{missionId:string, field:string, reason:string}>,
 *   dropped:Array<{field:string, reason:string}>,
 *   remapped:Array<{missionId:string, field:string, from:string, to:string}>}}
 */
function validateMissions(payload, format, spec) {
  const missions = []
  const missionIds = []
  const paused = []
  const unresolved = []
  const remapped = []
  const droppedFields = new Set()
  const seen = new Set()
  for (let index = 0; index < payload.missions.length; index += 1) {
    const mission = payload.missions[index]
    if (!isPlainObject(mission)) return { error: `missions[${index}] must be an object`, missions: [], missionIds: [], paused: [], unresolved: [], dropped: [], remapped: [] }
    if (typeof mission.id !== 'string' || !spec.idPattern.test(mission.id)) {
      return { error: `missions[${index}] has unsupported id ${JSON.stringify(mission.id)} (expected ${spec.idHint})`, missions: [], missionIds: [], paused: [], unresolved: [], dropped: [], remapped: [] }
    }
    if (seen.has(mission.id)) return { error: `duplicate legacy mission id ${mission.id}`, missions: [], missionIds: [], paused: [], unresolved: [], dropped: [], remapped: [] }
    seen.add(mission.id)
    if (typeof mission.status !== 'string' || !spec.statuses.includes(mission.status)) {
      return { error: `mission ${mission.id} has unknown status ${JSON.stringify(mission.status)}`, missions: [], missionIds: [], paused: [], unresolved: [], dropped: [], remapped: [] }
    }
    const mappedStatus = spec.statusRemap[mission.status]
    if (mappedStatus !== undefined) {
      remapped.push({ missionId: mission.id, field: 'status', from: mission.status, to: mappedStatus })
    }
    const status = mappedStatus ?? mission.status
    if (!DSH_STATUSES.includes(status)) {
      return { error: `legacy status ${JSON.stringify(mission.status)} has no declared DSH mapping`, missions: [], missionIds: [], paused: [], unresolved: [], dropped: [], remapped: [] }
    }
    let kind = 'build'
    if (mission.kind !== undefined) {
      if (!isShapeKind(mission.kind)) {
        return { error: `mission ${mission.id} has unknown kind ${JSON.stringify(mission.kind)}`, missions: [], missionIds: [], paused: [], unresolved: [], dropped: [], remapped: [] }
      }
      kind = mission.kind
    } else {
      unresolved.push({ missionId: mission.id, field: 'kind', reason: 'legacy mission has no kind; assumed build' })
    }
    for (const problem of [
      validateScope(mission.scope, mission.id),
      validateTasks(mission.tasks, mission.id),
      validateDeps(mission.deps, mission.id),
      validateReviews(mission.reviews, mission.id),
    ]) {
      if (problem) return { error: problem, missions: [], missionIds: [], paused: [], unresolved: [], dropped: [], remapped: [] }
    }
    for (const key of Object.keys(mission)) {
      if (!CARRIED_MISSION_FIELDS.includes(key)) droppedFields.add(key)
    }
    missions.push({ id: mission.id, status, kind })
    missionIds.push(mission.id)
    if (status === 'paused') paused.push(mission.id)
  }
  return {
    missions,
    missionIds,
    paused,
    unresolved,
    dropped: [...droppedFields].sort().map((field) => ({ field, reason: DROPPED_REASON })),
    remapped,
    error: null,
  }
}

/**
 * Validate a legacy payload without touching the filesystem or the Tower state.
 * Supports a Tower Codex `schemaVersion: 1` state (repoRoot/baseBranch/
 * missions/events/legacySnapshots with T#### missions) and a DSH `state.json`
 * (repoRoot/missions with M# missions).
 *
 * @returns {{ok:boolean, format:'tower-codex'|'dsh'|null, schemaVersion:number|null,
 *   missions:Array<{id:string,status:string,kind:string}>, missionIds:string[],
 *   missionCount:number, paused:string[],
 *   unresolved:Array<{missionId:string, field:string, reason:string}>,
 *   dropped:Array<{field:string, reason:string}>,
 *   remapped:Array<{missionId:string, field:string, from:string, to:string}>,
 *   events:number|null, legacySnapshots:number|null, repoRoot:string|null,
 *   baseBranch:string|null, error:string|null}}
 */
export function validateLegacySnapshot(payload) {
  if (!isPlainObject(payload)) return invalidResult('legacy snapshot must be a JSON object')
  if (payload.schemaVersion !== SCHEMA_VERSION) {
    return invalidResult(
      payload.schemaVersion === undefined
        ? 'legacy snapshot has no schemaVersion (expected 1)'
        : `unsupported legacy schemaVersion ${JSON.stringify(payload.schemaVersion)} (expected 1)`,
    )
  }
  if (!Array.isArray(payload.missions)) return invalidResult('legacy snapshot has no missions array')

  const detected = detectFormat(payload)
  if (detected.error || !detected.format) {
    return invalidResult(detected.error ?? 'legacy snapshot format could not be determined')
  }
  const format = detected.format
  const spec = LEGACY_FORMATS[format]

  const rejected = (error) => invalidResult(error, format)
  const validated = validateMissions(payload, format, spec)
  if (validated.error) return rejected(validated.error)

  if (isNonEmptyString(payload.repoRoot) === false) {
    return rejected(`legacy ${format} snapshot has no repoRoot string`)
  }
  if (spec.requiresBaseBranch && isNonEmptyString(payload[spec.baseBranchField]) === false) {
    return rejected(`legacy ${format} snapshot has no baseBranch string`)
  }
  const baseBranchValue = payload[spec.baseBranchField]
  if (baseBranchValue !== undefined && baseBranchValue !== null && !isNonEmptyString(baseBranchValue)) {
    return rejected(`legacy ${format} snapshot has no baseBranch string`)
  }
  if (payload.events !== undefined && !Array.isArray(payload.events)) {
    return rejected('legacy snapshot events must be an array')
  }
  if (payload.legacySnapshots !== undefined && !Array.isArray(payload.legacySnapshots)) {
    return rejected('legacy snapshot legacySnapshots must be an array')
  }
  if (payload.revision !== undefined && (!Number.isInteger(payload.revision) || payload.revision < 0)) {
    return rejected('legacy snapshot revision must be a non-negative integer')
  }

  return {
    ok: true,
    format,
    schemaVersion: SCHEMA_VERSION,
    missions: validated.missions,
    missionIds: validated.missionIds,
    missionCount: validated.missionIds.length,
    paused: validated.paused,
    unresolved: validated.unresolved,
    dropped: validated.dropped,
    remapped: validated.remapped,
    events: Array.isArray(payload.events) ? payload.events.length : null,
    legacySnapshots: Array.isArray(payload.legacySnapshots) ? payload.legacySnapshots.length : null,
    repoRoot: payload.repoRoot.trim(),
    baseBranch: isNonEmptyString(baseBranchValue) ? baseBranchValue.trim() : null,
    error: null,
  }
}

/**
 * Read a legacy snapshot, validate it, and store the exact payload bytes as
 * `<common>/dsh-tower/legacy/<sha256>.json`. The import is idempotent for the
 * same bytes; it never writes state.json, never activates/adopts a mission, and
 * `paused` stays paused in the returned summary.
 *
 * @returns {Promise<{summary:object, snapshot:object}>} where `snapshot` is the record
 *   the caller may append to `state.legacySnapshots`.
 */
export async function importLegacySnapshot(input = {}) {
  const repoRoot = input?.repoRoot
  const commonDir = input?.commonDir
  const sourcePath = input?.sourcePath

  if (!isNonEmptyString(repoRoot)) fail('invalid-argument', 'repoRoot is required')
  if (!path.isAbsolute(repoRoot)) fail('invalid-argument', `repoRoot must be an absolute path: ${repoRoot}`)
  if (!isNonEmptyString(commonDir)) fail('invalid-argument', 'commonDir is required')
  if (!path.isAbsolute(commonDir)) fail('invalid-argument', `commonDir must be an absolute path: ${commonDir}`)
  if (!isNonEmptyString(sourcePath)) fail('invalid-argument', 'sourcePath is required')
  if (!path.isAbsolute(sourcePath)) fail('invalid-argument', `sourcePath must be an absolute path: ${sourcePath}`)

  const resolvedSource = path.resolve(sourcePath)
  let sourceStat
  try {
    sourceStat = await fsp.stat(resolvedSource)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('invalid-argument', `sourcePath does not exist: ${resolvedSource}`)
    throw error
  }
  if (!sourceStat.isFile()) fail('invalid-argument', `sourcePath is not a regular file: ${resolvedSource}`)

  const stateDir = path.join(path.resolve(commonDir), 'dsh-tower')
  const stateReal = await realpathOrResolve(stateDir)
  const sourceReal = await realpathOrResolve(resolvedSource)
  if (isInside(stateReal, sourceReal)) {
    fail('legacy-invalid', `sourcePath must not be inside the Tower state directory: ${stateReal}`)
  }

  const buffer = await fsp.readFile(sourceReal)
  if (buffer.length > MAX_SNAPSHOT_BYTES) {
    fail(
      'legacy-invalid',
      `legacy snapshot is too large: ${buffer.length} bytes (max ${MAX_SNAPSHOT_BYTES})`,
    )
  }
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let payload
  try {
    payload = JSON.parse(text)
  } catch (error) {
    fail('legacy-invalid', `invalid legacy JSON at ${resolvedSource}: ${error.message}`)
  }
  const validation = validateLegacySnapshot(payload)
  if (!validation.ok) fail('legacy-invalid', `${resolvedSource}: ${validation.error}`)

  const sourceHash = sha256(buffer)
  const legacyDir = path.join(stateDir, 'legacy')
  const storedPath = path.join(legacyDir, `${sourceHash}.json`)
  await fsp.mkdir(legacyDir, { recursive: true })

  let idempotent = false
  try {
    const handle = await fsp.open(storedPath, 'wx')
    try {
      await handle.writeFile(buffer)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await fsp.readFile(storedPath).catch(() => null)
    if (!existing || sha256(existing) !== sourceHash) {
      fail('legacy-invalid', `legacy snapshot path exists with different contents: ${storedPath}`)
    }
    idempotent = true
  }

  const importedAt = Date.now()
  const summary = {
    format: validation.format,
    schemaVersion: SCHEMA_VERSION,
    missionCount: validation.missionCount,
    missionIds: validation.missionIds,
    paused: validation.paused,
    pausedCount: validation.paused.length,
    unresolved: validation.unresolved,
    dropped: validation.dropped,
    remapped: validation.remapped,
    events: validation.events,
    legacySnapshots: validation.legacySnapshots,
    sourcePath: resolvedSource,
    sourceHash,
    storedPath,
    bytes: buffer.length,
    idempotent,
    importedAt,
  }
  const snapshot = {
    sourceHash,
    sourcePath: resolvedSource,
    storedPath,
    format: validation.format,
    schemaVersion: SCHEMA_VERSION,
    repoRoot: validation.repoRoot,
    baseBranch: validation.baseBranch,
    missionIds: validation.missionIds,
    missionCount: validation.missionCount,
    pausedMissionIds: validation.paused,
    unresolved: validation.unresolved,
    droppedFields: validation.dropped.map((entry) => entry.field),
    remapped: validation.remapped,
    bytes: buffer.length,
    importedAt,
  }
  return { summary, snapshot }
}

/**
 * Audit-only validation for a legacy-id → DSH-mission mapping. The caller
 * records `{sourceHash, oldId, newMissionId}` (plus its own timestamp) in
 * `state.legacyMaps`; mapping never adopts, restores, or resumes anything.
 *
 * @returns {{ok:true, duplicate:boolean, map:{sourceHash:string, oldId:string,
 *   newMissionId:string|null}}}
 */
export function validateLegacyMap(state, input = {}) {
  if (!isPlainObject(state)) fail('invalid-argument', 'state is required')
  const sourceHash = input?.sourceHash
  const oldId = input?.oldId
  const rawNewMissionId = input?.newMissionId

  if (!isNonEmptyString(sourceHash)) fail('invalid-argument', 'sourceHash is required')
  if (!SHA256_RE.test(sourceHash)) {
    fail('invalid-argument', `sourceHash must be a 64-character hex SHA256: ${sourceHash}`)
  }
  if (!isNonEmptyString(oldId)) fail('invalid-argument', 'oldId is required')
  if (rawNewMissionId !== undefined && rawNewMissionId !== null && rawNewMissionId !== '' && typeof rawNewMissionId !== 'string') {
    fail('invalid-argument', `newMissionId must be a mission id string: ${JSON.stringify(rawNewMissionId)}`)
  }
  const newMissionId = isNonEmptyString(rawNewMissionId) ? rawNewMissionId.trim() : null

  const snapshots = Array.isArray(state.legacySnapshots) ? state.legacySnapshots : []
  const snapshot = snapshots.find((entry) => {
    if (!isPlainObject(entry)) return false
    const hash = entry.sourceHash ?? entry.hash ?? entry.sha256
    return hash === sourceHash
  })
  if (!snapshot) {
    fail('legacy-invalid', `unknown legacy snapshot ${sourceHash.slice(0, 12)}; import it with tower_import first`)
  }

  const snapshotIds = Array.isArray(snapshot.missionIds)
    ? snapshot.missionIds.filter((id) => typeof id === 'string')
    : Array.isArray(snapshot.missions)
      ? snapshot.missions.map((mission) => (typeof mission === 'string' ? mission : mission?.id)).filter((id) => typeof id === 'string')
      : []
  const missionIds = (Array.isArray(state.missions) ? state.missions : [])
    .map((mission) => mission?.id)
    .filter((id) => typeof id === 'string')

  if (!snapshotIds.includes(oldId) && !missionIds.includes(oldId)) {
    fail(
      'legacy-invalid',
      `legacy id ${oldId} is not in snapshot ${sourceHash.slice(0, 12)} and is not a known mission`,
    )
  }
  if (newMissionId !== null && !missionIds.includes(newMissionId)) {
    fail('legacy-invalid', `unknown new mission "${newMissionId}"; plan it before mapping`)
  }

  const maps = Array.isArray(state.legacyMaps) ? state.legacyMaps : []
  const existing = maps.find((entry) => isPlainObject(entry) && entry.sourceHash === sourceHash && entry.oldId === oldId)
  if (existing) {
    const existingTarget = existing.newMissionId ?? null
    if (existingTarget !== newMissionId) {
      fail(
        'legacy-invalid',
        `legacy map for ${oldId} already points to ${existingTarget ?? 'no mission'}; mappings are append-only and must not be rewritten`,
      )
    }
    return { ok: true, duplicate: true, map: existing }
  }

  return { ok: true, duplicate: false, map: { sourceHash, oldId, newMissionId } }
}
