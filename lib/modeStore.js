// Tower mode persistence.
//
// The session-projection route needs zod schemas, which this bundle cannot
// resolve from the DSH installation; a small atomic JSON store under
// DSH_HOME/tower-mode keeps the mode across restarts without adding a
// dependency or touching profile state.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_ENTRIES = 200

function storeDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'tower-mode')
}

function storeFile() {
  return path.join(storeDir(), 'modes.json')
}

/** Read persisted modes into a Map keyed by agent/session id. */
export function loadModes() {
  const modes = new Map()
  try {
    const raw = fs.readFileSync(storeFile(), 'utf8')
    const parsed = JSON.parse(raw)
    const entries = parsed && typeof parsed === 'object' && parsed.modes && typeof parsed.modes === 'object'
      ? parsed.modes
      : {}
    for (const [key, value] of Object.entries(entries)) {
      if (value && value.on === true) {
        modes.set(key, {
          on: true,
          pausedGoal: value.pausedGoal && typeof value.pausedGoal === 'object' ? value.pausedGoal : null,
          lastChange: value.lastChange && typeof value.lastChange === 'object' ? value.lastChange : null,
          at: Number(value.at) || 0,
        })
      }
    }
  } catch {
    // a missing or unreadable store simply starts with no persisted mode
  }
  return modes
}

/** Persist the current modes atomically; failures never break the command. */
export function saveModes(modes) {
  try {
    const dir = storeDir()
    fs.mkdirSync(dir, { recursive: true })
    const entries = [...modes.entries()]
      .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
      .slice(0, MAX_ENTRIES)
    const payload = { version: 1, modes: Object.fromEntries(entries) }
    const file = storeFile()
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

export function storePath() {
  return storeFile()
}
