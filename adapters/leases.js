// Repo-scoped coordination leases.
//
// One `<common>/dsh-tower/leases.json` per repository (shared by all
// worktrees) plus a short-lived writer lock `<common>/dsh-tower/leases.json.lock`.
// A lease records that a named resource (for example `plugin-load` or
// `heavy-ci`) is claimed by one holder with a token and an absolute TTL.
// Leases are advisory coordination only: they never grant Git, process, or
// filesystem authority, and this module never kills, adopts, or hands over
// work.
//
// Fail-closed protocol: a held, expired, or token-mismatched lease is reported,
// never silently taken over. Only the token holder may release a lease, and
// releasing an expired lease requires an explicit `force: true`.
import { fsp } from './store-fs.js'
import path from 'node:path'
import crypto from 'node:crypto'

import { ensureDir, exists, writeJsonAtomic } from './store.js'
import { acquireLock, lockRecord, readLock } from './lock.js'

export const LEASE_SCHEMA_VERSION = 1
// Matches the `leases.ttlMs` config default (900000); callers normally pass the
// configured value explicitly.
export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000

const LOCK_TIMEOUT_MS = 5000
const LOCK_POLL_MS = 20
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// Exported with the retry loop so a test can assert the budget and the exact
// transient set instead of copying them (#86).
export const UNLINK_ATTEMPTS = 12
export const TRANSIENT_UNLINK_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** @returns {never} */
function fail(code, message) {
  /** @type {Error & {code?: string}} */
  const error = new Error(message)
  error.code = code
  throw error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Path of the repository's lease ledger (validated, absolute commonDir). */
export function leasesPath(commonDir) {
  if (typeof commonDir !== 'string' || commonDir.trim().length === 0) fail('invalid-argument', 'commonDir is required')
  if (!path.isAbsolute(commonDir)) fail('invalid-argument', `commonDir must be an absolute path: ${commonDir}`)
  return path.join(commonDir, 'dsh-tower', 'leases.json')
}

/** Path of the short-lived lease-ledger writer lock. */
export function leasesLockPath(commonDir) {
  return `${leasesPath(commonDir)}.lock`
}

/**
 * Windows can reject unlink while an indexer, antivirus, or a concurrent
 * reader still holds the file; retry briefly instead of failing the mutation.
 *
 * `options.unlink` and `options.sleep` inject the syscall and the backoff so
 * both outcomes are testable on any OS (#86); production callers omit them.
 */
export async function unlinkWithRetry(file, options = {}) {
  const unlink = options.unlink ?? fsp.unlink
  const wait = options.sleep ?? sleep
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlink(file)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      if (!TRANSIENT_UNLINK_ERRORS.has(error?.code) || attempt >= UNLINK_ATTEMPTS) throw error
      await wait(10 + attempt * 15)
    }
  }
}

/**
 * Read and validate the lease ledger. A missing file is an empty ledger; a
 * corrupt or unsupported file is an error (never silently rewritten).
 */
async function readLeaseDocument(commonDir) {
  const file = leasesPath(commonDir)
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { file, doc: { schemaVersion: LEASE_SCHEMA_VERSION, updatedAt: null, leases: {} }, exists: false }
    }
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    fail('state-corrupt', `corrupt tower leases at ${file}: ${error.message}`)
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.leases)) {
    fail('state-corrupt', `corrupt tower leases at ${file}: expected {"schemaVersion":1,"leases":{...}}`)
  }
  if (parsed.schemaVersion !== LEASE_SCHEMA_VERSION) {
    fail('state-corrupt', `unsupported tower leases schemaVersion ${String(parsed.schemaVersion)} at ${file}`)
  }
  const leases = {}
  for (const [name, record] of Object.entries(parsed.leases)) {
    if (
      !isPlainObject(record) ||
      record.name !== name ||
      typeof record.holder !== 'string' ||
      record.holder.length === 0 ||
      typeof record.token !== 'string' ||
      record.token.length === 0 ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      !Number.isFinite(record.createdAt) ||
      !Number.isFinite(record.expiresAt)
    ) {
      fail('state-corrupt', `corrupt lease entry "${name}" at ${file}`)
    }
    leases[name] = {
      name,
      holder: record.holder,
      token: record.token,
      pid: record.pid,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    }
  }
  return {
    file,
    doc: {
      schemaVersion: LEASE_SCHEMA_VERSION,
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null,
      leases,
    },
    exists: true,
  }
}

/**
 * Serialize one lease mutation behind the ledger's writer lock using the
 * shared kernel. A live writer is waited for and eventually reported; it is
 * never removed because its timestamp looks old. Only a provably dead PID is
 * reclaimed, and the lock is released only when the token (and bytes) still
 * match.
 */
async function withLeaseLock(commonDir, fn) {
  const lockFile = leasesLockPath(commonDir)
  await ensureDir(path.dirname(lockFile))
  const token = crypto.randomUUID()
  const record = lockRecord(token, { kind: 'leases' })
  const held = await acquireLock(lockFile, {
    token,
    record,
    timeoutMs: LOCK_TIMEOUT_MS,
    pollMs: LOCK_POLL_MS,
    heartbeat: false,
  })
  if (!held) {
    const owner = await readLock(lockFile)
    const current = owner.record
    const heartbeatAgeMs = owner.timing?.heartbeatAgeMs
    const ownerError = /** @type {{ error?: string }} */ (owner).error
    const facts = current
      ? `pid ${current.pid ?? 'unknown'} (token ${current.token ?? 'missing'}), last heartbeat ${
          typeof heartbeatAgeMs === 'number'
            ? `${Math.round(heartbeatAgeMs)} ms ago (stale after ${owner.timing?.staleAfterMs ?? 'unknown'} ms)`
            : 'unknown'
        }; a stale heartbeat is diagnostic only and the live lock is not reclaimed`
      : ownerError
        ? `the lock record is unreadable (${ownerError})`
        : 'the lock was released before it could be inspected'
    fail('lease-busy', `tower leases are locked by another writer: ${facts}; retry after it finishes`)
  }
  try {
    return await fn()
  } finally {
    await held.release()
  }
}

/**
 * Claim a named resource for `holder`. Re-acquiring with the current token
 * renews the expiry (idempotent refresh); any other live or expired holder is
 * refused. Returns the stored lease `{name, holder, token, pid, createdAt,
 * expiresAt, renewed}`.
 */
export async function acquireLease(commonDir, options = {}) {
  const name = options?.name
  const holder = options?.holder
  const token = options?.token ?? crypto.randomUUID()
  const pid = options?.pid ?? process.pid
  const ttlMs = options?.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const now = options?.now ?? Date.now()

  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    fail('invalid-argument', `lease name must match ${NAME_RE} (for example "plugin-load"): ${JSON.stringify(name)}`)
  }
  if (typeof holder !== 'string' || holder.trim().length === 0) fail('invalid-argument', 'lease holder is required')
  if (typeof token !== 'string' || token.length === 0) fail('invalid-argument', 'lease token must be a non-empty string')
  if (!Number.isInteger(pid) || pid <= 0) fail('invalid-argument', `lease pid must be a positive integer: ${pid}`)
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) fail('invalid-argument', `lease ttlMs must be a positive integer: ${ttlMs}`)
  if (!Number.isFinite(now)) fail('invalid-argument', 'lease now must be a finite timestamp')

  const trimmedHolder = holder.trim()
  const file = leasesPath(commonDir)
  await ensureDir(path.dirname(file))

  return withLeaseLock(commonDir, async () => {
    const { doc } = await readLeaseDocument(commonDir)
    const existing = doc.leases[name]
    if (existing) {
      if (existing.token !== token) {
        const expiresAt = new Date(existing.expiresAt).toISOString()
        const expired = now >= existing.expiresAt
        fail(
          'lease-busy',
          `lease "${name}" is held by ${existing.holder} (pid ${existing.pid}) until ${expiresAt}` +
            (expired
              ? `; the lease expired at ${expiresAt} but is not taken over automatically — an explicit tower_resource release with force: true recovers it`
              : ''),
        )
      }
      if (existing.holder !== trimmedHolder) {
        fail('lease-token', `lease "${name}" token belongs to holder "${existing.holder}", not "${trimmedHolder}"`)
      }
      const renewed = { ...existing, expiresAt: now + ttlMs }
      doc.leases[name] = renewed
      doc.updatedAt = now
      await writeJsonAtomic(file, doc)
      return { ...renewed, renewed: true }
    }
    const record = { name, holder: trimmedHolder, token, pid, createdAt: now, expiresAt: now + ttlMs }
    doc.leases[name] = record
    doc.updatedAt = now
    await writeJsonAtomic(file, doc)
    return { ...record, renewed: false }
  })
}

/**
 * Release a lease. A live lease can only be released by the holder that owns
 * its token. An expired lease is recoverable: the holder may still release it
 * with the original token, and `force: true` lets the tower take over an
 * EXPIRED lease whose holder crashed — that is explicit recovery, never silent
 * takeover, and a live lease always refuses a foreign token. Returns `true` when
 * removed and `false` when no such lease exists.
 */
export async function releaseLease(commonDir, options = {}) {
  const name = options?.name
  const token = options?.token
  const force = options?.force === true
  const now = options?.now ?? Date.now()

  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    fail('invalid-argument', `lease name must match ${NAME_RE} (for example "plugin-load"): ${JSON.stringify(name)}`)
  }
  if (typeof token !== 'string' || token.length === 0) {
    fail('invalid-argument', 'lease token is required to release a lease')
  }
  if (!Number.isFinite(now)) fail('invalid-argument', 'lease now must be a finite timestamp')

  const file = leasesPath(commonDir)
  if (!(await exists(file))) return false
  await ensureDir(path.dirname(file))

  return withLeaseLock(commonDir, async () => {
    const { doc } = await readLeaseDocument(commonDir)
    const existing = doc.leases[name]
    if (!existing) return false
    const expired = now >= existing.expiresAt
    if (existing.token !== token) {
      if (expired && force) {
        // Explicit recovery of a crashed holder: only an expired lease and only
        // with `force`. Live leases below still refuse a foreign token.
      } else {
        fail(
          'lease-token',
          expired
            ? `lease "${name}" is held by ${existing.holder} (pid ${existing.pid}) and expired at ${new Date(existing.expiresAt).toISOString()}; the token does not match — pass force: true to take over the expired lease`
            : `lease "${name}" is held by ${existing.holder} (pid ${existing.pid}) until ${new Date(existing.expiresAt).toISOString()}; a live lease can only be released by its holder`,
        )
      }
    }
    if (!force && expired) {
      fail(
        'lease-busy',
        `lease "${name}" expired at ${new Date(existing.expiresAt).toISOString()}; release it explicitly with force: true`,
      )
    }
    delete doc.leases[name]
    doc.updatedAt = now
    await writeJsonAtomic(file, doc)
    return true
  })
}

/**
 * Read-only view of every lease: `{path, count, leases:[{name, holder, token,
 * pid, createdAt, expiresAt, expired}]}` sorted by name. A corrupt ledger
 * fails closed; an absent ledger is an empty list.
 */
export async function inspectLeases(commonDir, options = {}) {
  const now = options?.now ?? Date.now()
  if (!Number.isFinite(now)) fail('invalid-argument', 'lease now must be a finite timestamp')
  const { file, doc } = await readLeaseDocument(commonDir)
  const leases = Object.values(doc.leases)
    .map((record) => ({ ...record, expired: now >= record.expiresAt }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { path: file, count: leases.length, leases }
}
