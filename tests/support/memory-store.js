// In-memory replacement for lib/store.js (#50): the same surface Tower uses,
// with no filesystem access.
//
// The production store is a durable repo-scoped store: an exclusive writer lock,
// atomic JSON replacement, and an append-only activity log. This double keeps
// that contract in Maps so a Tower lifecycle can run without a disk:
//
//   pathsFor(commonDir)             -> { dir, state, lock, gitLock, activity }
//   exists(file) / ensureDir(dir)   -> used by Tower.load()/Tower.init()
//   readJson(file)                  -> parsed value | ENOENT | [tower:state-corrupt]
//   writeJsonAtomic(file, value)    -> whole-value commit, a reader never sees a partial write
//   appendJsonl(file, value)        -> one complete line per call, under one lock or many
//   withLock(paths, fn, options)    -> FIFO exclusive section, always released
//
// Virtual paths use the "tower-mem://" scheme and are never handed to the host
// filesystem. `store.inspect` is test-only and is NOT part of the port.
import { TowerToolError } from '../../domain/errors.js'

export const MEMORY_SCHEME = 'tower-mem://'

function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('path must be a non-empty string')
  const slashed = value.replace(/\\/g, '/')
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
}

function parentOf(file) {
  const index = file.lastIndexOf('/')
  return index <= 0 ? '/' : file.slice(0, index)
}

function ancestorsOf(dir) {
  const chain = []
  let current = dir
  while (current.length > MEMORY_SCHEME.length) {
    chain.push(current)
    const index = current.lastIndexOf('/')
    if (index < MEMORY_SCHEME.length) break
    const parent = current.slice(0, index)
    if (parent.length < MEMORY_SCHEME.length) break
    current = parent
  }
  return chain
}

function missingFile(file, syscall) {
  const error = new Error(`ENOENT: no such file or directory, ${syscall} '${file}'`)
  error.code = 'ENOENT'
  error.path = file
  return error
}

/** Same key shape and join rule as lib/store.js pathsFor, but virtual. */
export function memoryPathsFor(commonDir) {
  const dir = `${MEMORY_SCHEME}${normalizePath(commonDir)}/dsh-tower`
  return {
    dir,
    state: `${dir}/state.json`,
    lock: `${dir}/state.lock`,
    gitLock: `${dir}/git.lock`,
    activity: `${dir}/activity.jsonl`,
  }
}

/**
 * @param {{ hooks?: { beforeCommit?: (entry: { file: string, value: unknown, text: string }) => void | Promise<void> } }} [options]
 *   beforeCommit is awaited between serialization and the atomic commit. Tests
 *   use it to interleave a reader with a pending write, or to simulate a crash
 *   before the rename without corrupting the previous value.
 */
export function createMemoryStore(options = {}) {
  const hooks = options.hooks ?? {}
  const files = new Map()
  const dirs = new Set()
  const locks = new Map()
  const lockTails = new Map()
  let activeLocks = 0
  let lockSeq = 0
  const stats = { reads: 0, writes: [], appends: [], lockHolds: [], maxConcurrentLocks: 0 }
  Object.defineProperty(stats, 'activeLocks', { enumerable: true, get: () => activeLocks })

  async function exists(file) {
    const target = normalizePath(file)
    return files.has(target) || dirs.has(target)
  }

  async function ensureDir(dir) {
    for (const entry of ancestorsOf(normalizePath(dir))) dirs.add(entry)
  }

  function assertParent(file) {
    if (!dirs.has(parentOf(file))) throw missingFile(file, 'open')
  }

  async function readJson(file) {
    const target = normalizePath(file)
    const entry = files.get(target)
    if (!entry) throw missingFile(target, 'open')
    stats.reads += 1
    try {
      return JSON.parse(entry.text)
    } catch (error) {
      throw new TowerToolError('state-corrupt', `corrupt tower state at ${target}: ${error.message}`)
    }
  }

  async function writeJsonAtomic(file, value) {
    const target = normalizePath(file)
    // Serialize completely before touching the current value: a value that
    // cannot be represented (circular, BigInt) must never replace the old one.
    const text = JSON.stringify(value, null, 2)
    assertParent(target)
    if (typeof hooks.beforeCommit === 'function') await hooks.beforeCommit({ file: target, value, text })
    // One synchronous Map.set after every await: readers observe exactly the
    // previous text or the complete new text, never a prefix of either.
    const existed = files.has(target)
    files.set(target, { text })
    stats.writes.push({ file: target, text, existed, at: Date.now() })
  }

  async function appendJsonl(file, value) {
    const target = normalizePath(file)
    const line = `${JSON.stringify(value)}\n`
    assertParent(target)
    const previous = files.get(target)?.text ?? ''
    files.set(target, { text: previous + line })
    stats.appends.push({ file: target, value, at: Date.now() })
  }

  /**
   * FIFO exclusive section per paths.lock. Production spins and reports
   * state-locked when another process holds the lock; the in-memory double has
   * one process, so it queues waiters instead. The important contract is the
   * same: only one mutation body runs at a time and the lock is released even
   * when the body throws.
   */
  async function withLock(paths, fn, _options = {}) {
    if (!paths || typeof paths.lock !== 'string') throw new TypeError('withLock requires paths.lock')
    const lockPath = normalizePath(paths.lock)
    const previous = lockTails.get(lockPath) ?? Promise.resolve()
    let releaseGate
    const gate = new Promise((resolve) => {
      releaseGate = resolve
    })
    const tail = previous.then(() => gate)
    lockTails.set(lockPath, tail)
    await previous

    const token = `memory-lock-${(lockSeq += 1)}`
    locks.set(lockPath, { token, at: Date.now() })
    activeLocks += 1
    if (activeLocks > stats.maxConcurrentLocks) stats.maxConcurrentLocks = activeLocks
    const startedAt = Date.now()
    let released = false
    const release = () => {
      if (released) return
      released = true
      activeLocks -= 1
      locks.delete(lockPath)
      stats.lockHolds.push({ lock: lockPath, ms: Math.max(0, Date.now() - startedAt), at: Date.now() })
      releaseGate()
      if (lockTails.get(lockPath) === tail) lockTails.delete(lockPath)
    }
    try {
      return await fn(paths)
    } finally {
      release()
    }
  }

  const inspect = {
    stats,
    paths: () => [...files.keys()],
    readText(file) {
      const entry = files.get(normalizePath(file))
      return entry ? entry.text : null
    },
    readActivity(file) {
      const text = inspect.readText(file)
      if (!text) return []
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
    isLocked(lockPath) {
      return locks.has(normalizePath(lockPath))
    },
    exists(file) {
      const target = normalizePath(file)
      return files.has(target) || dirs.has(target)
    },
  }

  return { pathsFor: memoryPathsFor, exists, ensureDir, readJson, writeJsonAtomic, appendJsonl, withLock, inspect }
}
