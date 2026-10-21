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
import { fsp } from './adapters/store-fs.js'
import path from 'node:path'
import crypto from 'node:crypto'

const SCHEMA_VERSION = 1
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
const DSH_STATUSES = ['planned', 'active', 'completed', 'blocked', 'paused', 'merged', 'abandoned']
// Tower Codex also retires missions; retired is read-only history here.
const CODEX_STATUSES = [...DSH_STATUSES, 'retired']
const DSH_ID_RE = /^M\d+$/
const CODEX_ID_RE = /^T\d{4,}$/
const SHA256_RE = /^[a-f0-9]{64}$/

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

function win32Lower(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isInside(parent, child) {
  const relative = path.relative(win32Lower(path.resolve(parent)), win32Lower(path.resolve(child)))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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
 * @param {any} payload
 * @param {'tower-codex'|'dsh'} format
 * @returns {{error:string|null, missions:Array<{id:string,status:string,kind:string}>, missionIds:string[], paused:string[]}}
 */
function validateMissions(payload, format) {
  const statuses = format === 'tower-codex' ? CODEX_STATUSES : DSH_STATUSES
  const idRe = format === 'tower-codex' ? CODEX_ID_RE : DSH_ID_RE
  const missions = []
  const missionIds = []
  const paused = []
  const seen = new Set()
  for (let index = 0; index < payload.missions.length; index += 1) {
    const mission = payload.missions[index]
    if (!isPlainObject(mission)) return { error: `missions[${index}] must be an object`, missions: [], missionIds: [], paused: [] }
    if (typeof mission.id !== 'string' || !idRe.test(mission.id)) {
      return { error: `missions[${index}] has unsupported id ${JSON.stringify(mission.id)} (expected ${format === 'tower-codex' ? 'T####' : 'M#'})`, missions: [], missionIds: [], paused: [] }
    }
    if (seen.has(mission.id)) return { error: `duplicate legacy mission id ${mission.id}`, missions: [], missionIds: [], paused: [] }
    seen.add(mission.id)
    if (typeof mission.status !== 'string' || !statuses.includes(mission.status)) {
      return { error: `mission ${mission.id} has unknown status ${JSON.stringify(mission.status)}`, missions: [], missionIds: [], paused: [] }
    }
    if (mission.kind !== undefined && mission.kind !== 'build' && mission.kind !== 'survey') {
      return { error: `mission ${mission.id} has unknown kind ${JSON.stringify(mission.kind)}`, missions: [], missionIds: [], paused: [] }
    }
    for (const problem of [
      validateScope(mission.scope, mission.id),
      validateTasks(mission.tasks, mission.id),
      validateDeps(mission.deps, mission.id),
      validateReviews(mission.reviews, mission.id),
    ]) {
      if (problem) return { error: problem, missions: [], missionIds: [], paused: [] }
    }
    missions.push({ id: mission.id, status: mission.status, kind: mission.kind ?? 'build' })
    missionIds.push(mission.id)
    if (mission.status === 'paused') paused.push(mission.id)
  }
  return { missions, missionIds, paused, error: null }
}

/**
 * Validate a legacy payload without touching the filesystem or the Tower state.
 * Supports a Tower Codex `schemaVersion: 1` state (repoRoot/baseBranch/
 * missions/events/legacySnapshots with T#### missions) and a DSH `state.json`
 * (repoRoot/missions with M# missions).
 *
 * @returns {{ok:boolean, format:'tower-codex'|'dsh'|null, schemaVersion:number|null,
 *   missions:Array<{id:string,status:string,kind:string}>, missionIds:string[],
 *   missionCount:number, paused:string[], events:number|null,
 *   legacySnapshots:number|null, repoRoot:string|null, baseBranch:string|null,
 *   error:string|null}}
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

  /** @type {'tower-codex'|'dsh'} */
  let format = 'dsh'
  if (payload.missions.length === 0) {
    format = isNonEmptyString(payload.baseBranch) ? 'tower-codex' : 'dsh'
  } else {
    const firstId = payload.missions[0]?.id
    if (typeof firstId === 'string' && CODEX_ID_RE.test(firstId)) format = 'tower-codex'
    else if (typeof firstId === 'string' && DSH_ID_RE.test(firstId)) format = 'dsh'
    else {
      return invalidResult(
        `unsupported legacy mission id ${JSON.stringify(firstId)} (expected T#### for Tower Codex or M# for DSH)`,
      )
    }
  }

  const rejected = (error) => invalidResult(error, format)
  const validated = validateMissions(payload, format)
  if (validated.error) return rejected(validated.error)

  if (isNonEmptyString(payload.repoRoot) === false) {
    return rejected(`legacy ${format} snapshot has no repoRoot string`)
  }
  if (format === 'tower-codex' && isNonEmptyString(payload.baseBranch) === false) {
    return rejected('legacy tower-codex snapshot has no baseBranch string')
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
    events: Array.isArray(payload.events) ? payload.events.length : null,
    legacySnapshots: Array.isArray(payload.legacySnapshots) ? payload.legacySnapshots.length : null,
    repoRoot: payload.repoRoot.trim(),
    baseBranch: format === 'tower-codex' ? payload.baseBranch.trim() : (isNonEmptyString(payload.base) ? payload.base.trim() : null),
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
    fail('legacy-invalid', `unknown legacy snapshot ${sourceHash.slice(0, 12)}; import it with tower_import_legacy first`)
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
