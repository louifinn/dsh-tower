// dsh-tower — HMR bridge.
//
// Wraps the optional `@deepseek-ai/dsh-hmr` profile service so Tower can ask
// DSH to reconcile its profile (re-read the patch layers, replace changed
// linked-package modules and report inactive required entries) without
// importing any DSH package. A profile without the HMR service simply reports
// `available: false`; nothing here throws at construction time.
//
// The bridge is intentionally dependency-free apart from the stable tool error
// type, so `tests/hmr.test.mjs` can drive it with a fake `ctx.get('hmr')`.
//
// DSH facts this relies on:
// - `hmr.runExclusive(operation)` serializes the operation with all automatic
//   reload paths; `hmr.reconcileProfile(requiredIds)` must run inside it and
//   throws `HMR profile reconciliation must run inside runExclusive` otherwise.
// - `reconcileProfile` returns `{ warnings, pending[, restartReason] }`:
//   `pending` modules keep running their previous code until a restart, and
//   `restartReason` means the whole process must be restarted.
// - `runExclusive` rejects nested transactions; a tool call is never inside
//   one, so a tool-triggered reload is safe.
import { TowerToolError } from './errors.js'

/** Entry ids Tower expects to be active after a reconciliation. */
export const DEFAULT_REQUIRED_IDS = Object.freeze([
  'tower',
  'tower-skills',
  'preset-tower-worker',
  'preset-tower-reviewer',
])

/** Debounce window for the dev hot-reload hook (milliseconds). */
export const DEFAULT_DELAY_MS = 50

const RESTART_HINT = 'Restart DSH or check the profile hmr configuration.'

/** Read the HMR service without assuming anything about the Cordis context. */
function hmrService(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get('hmr')
  } catch {
    return undefined
  }
}

/** True when `candidate` exposes both HMR methods Tower needs. */
export function isHmrAvailable(candidate) {
  return Boolean(
    candidate &&
      typeof candidate.runExclusive === 'function' &&
      typeof candidate.reconcileProfile === 'function',
  )
}

function normalizeRequiredIds(value) {
  // An explicit array wins (including an empty one); anything else falls back
  // to the Tower entry ids. Trim and drop duplicates so a config typo does not
  // make `reconcileProfile` treat the same entry twice.
  const source = Array.isArray(value) ? value : DEFAULT_REQUIRED_IDS
  const ids = []
  for (const entry of source) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id.length === 0 || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

function normalizeDelayMs(value) {
  if (value === undefined || value === null) return DEFAULT_DELAY_MS
  const delay = Number(value)
  if (!Number.isFinite(delay) || delay < 0) return DEFAULT_DELAY_MS
  return Math.floor(delay)
}

function messageOf(error) {
  return String(error?.message ?? error)
}

function warn(logger, message) {
  try {
    logger?.warn?.(message)
  } catch {
    // Diagnostics must never break a reload path.
  }
}

/**
 * Create the Tower → DSH HMR bridge.
 *
 * @param {object} ctx Cordis context (only `ctx.get` is used).
 * @param {object} [options]
 * @param {string[]} [options.requiredIds] Entry ids whose inactivity is reported as a failure.
 * @param {number} [options.delayMs] Delay before a scheduled reload runs.
 * @param {{ warn?: Function }} [options.logger] Optional logger for failed scheduled reloads.
 * @returns {{ available: boolean, requiredIds: string[], delayMs: number, status: Function, schedule: Function, runNow: Function }}
 */
export function createHmrBridge(ctx, options = {}) {
  const requiredIds = Object.freeze(normalizeRequiredIds(options.requiredIds))
  const delayMs = normalizeDelayMs(options.delayMs)
  const logger = options.logger

  let timer = null
  let lastRunAt = null
  let lastError = null

  const available = () => isHmrAvailable(hmrService(ctx))

  /**
   * Reconcile the profile now. Throws a stable TowerToolError:
   * `reload-unavailable` when the HMR service is absent, `reload-failed` when
   * the reconciliation itself throws (its message carries the cause).
   */
  async function runNow() {
    const hmr = hmrService(ctx)
    if (!isHmrAvailable(hmr)) {
      const message = `HMR profile reload is unavailable; ${RESTART_HINT}`
      lastError = message
      throw new TowerToolError('reload-unavailable', message)
    }
    try {
      const result = await hmr.runExclusive(() => hmr.reconcileProfile(requiredIds))
      lastRunAt = Date.now()
      lastError = null
      return result
    } catch (error) {
      if (error instanceof TowerToolError) {
        lastError = messageOf(error)
        throw error
      }
      const cause = messageOf(error)
      lastError = cause
      throw new TowerToolError(
        'reload-failed',
        `HMR profile reload failed: ${cause}. ${RESTART_HINT}`,
        { cause: error },
      )
    }
  }

  /**
   * Schedule `runNow()` after `delayMs` and return immediately. A failure is
   * recorded in `status().lastError` and passed to `logger.warn`; it is never
   * surfaced as an unhandled rejection. Calling `schedule()` again replaces a
   * still-pending timer, so a burst of edits results in one reconciliation.
   */
  function schedule() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    timer = setTimeout(() => {
      timer = null
      runNow().catch((error) => {
        lastError = messageOf(error)
        warn(logger, `[dsh-tower] scheduled HMR reload failed: ${lastError}`)
      })
    }, delayMs)
    const outcome = { scheduled: true, delayMs, requiredIds: [...requiredIds] }
    if (lastError !== null) outcome.lastError = lastError
    return outcome
  }

  /** Snapshot for tools and diagnostics. `available` is re-read on every call. */
  function status() {
    return {
      available: available(),
      requiredIds: [...requiredIds],
      delayMs,
      scheduled: timer !== null,
      lastRunAt,
      lastError,
    }
  }

  return {
    get available() {
      return available()
    },
    requiredIds,
    delayMs,
    status,
    schedule,
    runNow,
  }
}
