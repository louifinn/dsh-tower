// Tower mode persistence.
//
// The session-projection route needs zod schemas, which this bundle cannot
// resolve from the DSH installation on every deployment; a small atomic JSON
// store under DSH_HOME/tower-mode keeps the mode across restarts.
//
// Loading distinguishes a missing store (first run) from a corrupt one (the
// bytes exist but cannot be trusted), and saving reports why it failed instead
// of silently returning a boolean. The caller can then avoid telling the human
// that a mode change was persisted when it was not (#167).
import { fs } from '../adapters/store-fs.js'
import os from 'node:os'
import path from 'node:path'
import { acquireLockSync } from '../adapters/lock.js'
import { readJsonSync, writeJsonAtomicSync } from '../adapters/persistence.js'

const DEFAULT_MAX_ENTRIES = 200

function defaultStoreDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'tower-mode')
}

function storeDir(baseDir) {
  return baseDir && String(baseDir).trim() ? path.resolve(String(baseDir)) : defaultStoreDir()
}

function storeFile(baseDir) {
  return path.join(storeDir(baseDir), 'modes.json')
}

function errorText(error) {
  return String(error?.message ?? error)
}

/**
 * Read persisted modes and say whether the file was missing, valid, or
 * corrupt. Only an active (`on: true`) entry is returned, as before; a valid
 * document with no active entries is `ok`, not `missing`.
 *
 * @param {string} [baseDir]
 * @returns {{ status: 'missing'|'ok'|'corrupt', modes: Map<string, any>, file: string, error?: string }}
 */
export function loadModesDetailed(baseDir) {
  const modes = new Map()
  const file = storeFile(baseDir)
  let parsed
  try {
    parsed = readJsonSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', modes, file }
    return { status: 'corrupt', modes, file, error: errorText(error) }
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.modes || typeof parsed.modes !== 'object') {
    return {
      status: 'corrupt',
      modes,
      file,
      error: `expected {"version":1,"modes":{...}} in ${file}`,
    }
  }
  for (const [key, value] of Object.entries(parsed.modes)) {
    if (value && value.on === true) {
      const lock = value.lock && typeof value.lock === 'object'
        && typeof value.lock.token === 'string'
        && typeof value.lock.commonDir === 'string'
        ? { token: value.lock.token, commonDir: value.lock.commonDir }
        : null
      modes.set(key, {
        on: true,
        pausedGoal: value.pausedGoal && typeof value.pausedGoal === 'object' ? value.pausedGoal : null,
        lastChange: value.lastChange && typeof value.lastChange === 'object' ? value.lastChange : null,
        lock,
        baseBranch: typeof value.baseBranch === 'string' && value.baseBranch.trim() ? value.baseBranch.trim() : null,
        lastDisclosure: typeof value.lastDisclosure === 'string' ? value.lastDisclosure : null,
        at: Number(value.at) || 0,
      })
    }
  }
  return { status: 'ok', modes, file }
}

/** Read persisted modes into a Map keyed by agent/session id. */
export function loadModes(baseDir) {
  return loadModesDetailed(baseDir).modes
}

/**
 * Persist the current modes atomically with a short cross-process lock.
 * Returns `{ok:true}` or `{ok:false, error}`; a corrupt existing store is not
 * overwritten, because doing so would destroy the only copy of the bytes.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
export function saveModesDetailed(modes, baseDir, maxEntries = DEFAULT_MAX_ENTRIES, options = {}) {
  const dir = storeDir(baseDir)
  const file = storeFile(baseDir)
  const lock = path.join(dir, 'modes.lock')
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, error: `cannot create the mode store directory ${dir}: ${errorText(error)}` }
  }
  let held
  try {
    held = acquireLockSync(lock, { timeoutMs, invalidPidIsDead: true })
  } catch (error) {
    return { ok: false, error: `cannot acquire the mode store lock ${lock}: ${errorText(error)}` }
  }
  if (!held) return { ok: false, error: `timed out waiting for the mode store lock ${lock}` }
  try {
    let disk = {}
    try {
      const parsed = readJsonSync(file)
      if (!parsed || typeof parsed !== 'object' || !parsed.modes || typeof parsed.modes !== 'object') {
        return { ok: false, error: `corrupt mode store at ${file}: expected {"version":1,"modes":{...}}` }
      }
      disk = parsed.modes
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { ok: false, error: `cannot read the mode store at ${file}: ${errorText(error)}` }
      }
    }
    const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES
    // Merge by timestamp so two sessions saving concurrently do not erase
    // each other's mode changes. A disk-only entry from another process is
    // preserved unless this process has a newer record for the same key.
    const merged = { ...disk }
    for (const [key, value] of modes.entries()) {
      const previous = merged[key]
      if (!previous || (Number(value?.at) || 0) >= (Number(previous?.at) || 0)) merged[key] = value
    }
    const entries = Object.entries(merged)
      .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
      .slice(0, limit)
    const payload = { version: 1, modes: Object.fromEntries(entries) }
    try {
      writeJsonAtomicSync(file, payload)
    } catch (error) {
      return { ok: false, error: `cannot write the mode store at ${file}: ${errorText(error)}` }
    }
    return { ok: true }
  } finally {
    held.release()
  }
}

/** Boolean-compatible wrapper for callers that only need success/failure. */
export function saveModes(modes, baseDir, maxEntries = DEFAULT_MAX_ENTRIES, options = {}) {
  return saveModesDetailed(modes, baseDir, maxEntries, options).ok
}

export function storePath(baseDir) {
  return storeFile(baseDir)
}
