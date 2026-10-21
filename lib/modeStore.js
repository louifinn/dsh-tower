// Tower mode persistence.
//
// The session-projection route needs zod schemas, which this bundle cannot
// resolve from the DSH installation on every deployment; a small atomic JSON
// store under DSH_HOME/tower-mode keeps the mode across restarts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomicSync } from './store.js'

const DEFAULT_MAX_ENTRIES = 200

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // best effort; a busy loop would be worse
  }
}

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

/** Read persisted modes into a Map keyed by agent/session id. */
export function loadModes(baseDir) {
  const modes = new Map()
  try {
    const raw = fs.readFileSync(storeFile(baseDir), 'utf8')
    const parsed = JSON.parse(raw)
    const entries = parsed && typeof parsed === 'object' && parsed.modes && typeof parsed.modes === 'object'
      ? parsed.modes
      : {}
    for (const [key, value] of Object.entries(entries)) {
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
  } catch {
    // a missing or unreadable store simply starts with no persisted mode
  }
  return modes
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function reclaimDeadLock(lock) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lock, 'utf8'))
    if (processAlive(Number(parsed?.pid))) return false
    fs.unlinkSync(lock)
    return true
  } catch {
    return false
  }
}

/** Persist the current modes atomically with a short cross-process lock. */
export function saveModes(modes, baseDir, maxEntries = DEFAULT_MAX_ENTRIES) {
  const dir = storeDir(baseDir)
  const file = storeFile(baseDir)
  const lock = path.join(dir, 'modes.lock')
  const token = randomUUID()
  try {
    fs.mkdirSync(dir, { recursive: true })
    let acquired = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const fd = fs.openSync(lock, 'wx')
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }))
        fs.closeSync(fd)
        acquired = true
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        reclaimDeadLock(lock)
        sleepSync(5)
      }
    }
    if (!acquired) return false
    try {
      const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES
      let disk = {}
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object' && parsed.modes && typeof parsed.modes === 'object') disk = parsed.modes
      } catch {
        disk = {}
      }
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
      writeJsonAtomicSync(file, payload)
      return true
    } finally {
      try {
        const held = JSON.parse(fs.readFileSync(lock, 'utf8'))
        if (held?.token === token) fs.unlinkSync(lock)
      } catch {
        // a missing/foreign lock is not ours to remove
      }
    }
  } catch {
    return false
  }
}

export function storePath(baseDir) {
  return storeFile(baseDir)
}
