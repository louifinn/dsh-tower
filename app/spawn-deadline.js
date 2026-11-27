// tower_spawn deadline and phase vocabulary (#237): the one bound on a whole
// pre-flight, the frozen phase names it reports, and the bounded wait for a
// refused run to unwind. Split out of app/spawn-support.js so each file keeps a
// single concern; no I/O of its own.
import { TowerToolError } from '../domain/errors.js'
import { DEFAULT_SPAWN_PREFLIGHT_TIMEOUT_MS } from '../domain/config/schema.js'

/**
 * #237: the phase names a `tower_spawn` pre-flight can be in when its one
 * deadline expires. The list is frozen and small on purpose: it is the value of
 * `details.phase` on the failure, the word the activity log names, and what
 * `tower_inspect` status reports as `spawn.phase`. A name is a position in the
 * pre-flight, not an operation name, so a caller can tell "queueing behind
 * another spawn" (`queue`) from "waiting for the host to answer" (`observe`).
 * @type {readonly string[]}
 */
export const SPAWN_PREFLIGHT_PHASES = Object.freeze([
  'queue',
  'open',
  'resolve',
  'observe',
  'roster',
  'ownership',
  'services',
  'provision',
  'discovery',
  'reserve',
  'activate',
  'record',
])

/**
 * The value `details.phase` carries when the deadline expires before the first
 * phase runs. It is not in the frozen list on purpose: a caller that sees it
 * knows nothing has been attempted yet.
 */
export const SPAWN_PHASE_PENDING = 'pending'

/** @param {unknown} phase */
export function isSpawnPreflightPhase(phase) {
  return typeof phase === 'string' && SPAWN_PREFLIGHT_PHASES.includes(phase)
}

/**
 * #237 R2 P1: how long a refusal waits for the in-flight phase to observe the
 * abort and release what it wrote. The abort signal is advisory — a read that
 * ignores it would otherwise hold the caller — so the wait is bounded, and a
 * step that outlives the window is named in `details.rollback` as still being
 * cleaned up rather than silently assumed clean.
 */
export const SPAWN_REFUSAL_GRACE_MS = 2000

/**
 * #237: bound the tower_spawn pre-flight with one deadline instead of hoping
 * every read settles. `run` receives an abort signal it must forward to the
 * reads it performs, a `reach(phase)` marker it calls before entering each phase
 * so a stalled call names the step that never answered, an `assertLive(phase)`
 * guard it calls at the start of every phase that writes (it records the phase
 * and then refuses when the deadline already fired), and a `retune(ms)` marker
 * it calls once the repository config resolves.
 *
 * The deadline covers the whole pre-flight: the phases are sequential, so the
 * bound a caller asked for is the bound it gets. The abort signal alone is not
 * enough — a read that ignores it would still hang — so the deadline rejects
 * the returned promise on its own. `retune` re-arms the *remaining* budget to
 * the configured `spawn.preflightTimeoutMs` from the start, so a repository that
 * allows a longer bound gets it while an already spent budget is not refunded.
 *
 * A refusal does not just reject: it aborts with the very error the caller will
 * see, then waits up to `SPAWN_REFUSAL_GRACE_MS` for `run` to unwind so the
 * rollback is done before the caller is told the spawn failed. Longer than that
 * and the caller is told anyway — but the failure then carries `details.rollback`
 * saying what was already released, instead of claiming nothing was written.
 *
 * @template T
 * @param {{
 *   timeoutMs?: number | undefined,
 *   signal?: AbortSignal | undefined,
 *   phase?: string | undefined,
 *   onPhase?: ((phase: string, elapsedMs: number) => void) | undefined,
 *   details?: ((phase: string) => Record<string, unknown>) | undefined,
 *   run: (context: {
 *     signal: AbortSignal,
 *     reach: (phase: string) => void,
 *     assertLive: (phase: string) => void,
 *     retune: (timeoutMs: unknown) => void,
 *   }) => Promise<T>,
 * }} options
 * @returns {Promise<T>}
 */
export async function withSpawnDeadline({ timeoutMs, signal, phase: initialPhase, onPhase, details, run }) {
  const startedAt = Date.now()
  let phase = initialPhase ?? SPAWN_PHASE_PENDING
  const controller = new AbortController()
  /** @param {unknown} value */
  const budgetFor = (value) => {
    const limit = Number(value)
    return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_SPAWN_PREFLIGHT_TIMEOUT_MS
  }
  let budgetMs = budgetFor(timeoutMs)
  const elapsed = () => Date.now() - startedAt
  // #237 R3 P2: from `provision` on, the response always carries `rollback` — a
  // placeholder `refundRollbackFacts` overwrites once the bounded unwind lands.
  const WRITES_AT = SPAWN_PREFLIGHT_PHASES.indexOf('provision')
  const factsFor = (name) => {
    const extra = typeof details === 'function' ? details(name) : null
    /** @type {Record<string, unknown>} */
    const facts = { ...(extra ?? {}), phase: name, elapsedMs: elapsed() }
    if (SPAWN_PREFLIGHT_PHASES.indexOf(name) >= WRITES_AT) {
      facts.rollback = { status: 'pending', note: `refused in phase ${name}; the unwind was still running when the caller was told, so the activity log records what it released` }
    }
    return facts
  }
  // #237 R2 P1: the message names what the caller can rely on — nothing was
  // activated and whatever the pre-flight had already written is reported in
  // `details.rollback` — instead of the old claim that no cleanup could exist.
  const cancelledError = () =>
    new TowerToolError(
      'spawn-unavailable',
      'tower_spawn was cancelled during pre-flight; no worker was started and details.rollback reports what the pre-flight released (or that the release is still pending)',
      { details: factsFor(phase) },
    )
  /** @param {unknown} reason */
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  // #237: the host and the mock suite both drive the tool with a duck-typed
  // `{ aborted }` object rather than a real AbortSignal, so the cancellation
  // fact and the listener API are read separately: a truthy `aborted` is the
  // same fact, and only an object that actually implements `addEventListener`
  // may be subscribed to. Assuming the listener API turned a stub signal into a
  // `tool-internal` TypeError instead of a bounded pre-flight, which is worse
  // than the hang it was meant to bound.
  const cancelled = () => signal !== null && signal !== undefined && Boolean(signal.aborted)
  const listenable = signal !== null && signal !== undefined && typeof signal.addEventListener === 'function'
  if (cancelled() && signal) abort(signal.reason)
  /** @param {string} next */
  const reach = (next) => {
    if (next === phase) return
    phase = next
    onPhase?.(next, elapsed())
  }
  /**
   * #237 R2 P1: the refusal the caller will see, once one has happened. Kept so
   * a phase that skipped `assertLive` still finds the run cancelled instead of
   * writing after the caller was told the spawn failed.
   * @type {any}
   */
  let stopped = null
  let timer
  /**
   * One deferred rejection for the whole call: `retune` only re-arms the timer,
   * never the promise, so the deadline is the same value the race is waiting on.
   * @type {(error: any) => void}
   */
  let fail = () => {}
  const expired = new Promise((_resolve, reject) => {
    fail = reject
  })
  expired.catch(() => {})
  /**
   * End the pre-flight: remember the refusal, forward it through the abort
   * signal (so a cooperatively cancelled read sees the caller's own error and
   * the rollback in `run` can recognize it), and reject the race.
   * @param {any} error
   */
  const stop = (error) => {
    if (stopped) return stopped
    stopped = error
    abort(error)
    fail(error)
    return error
  }
  const fire = () => {
    // A cancelled caller and an expired deadline are different failures: the
    // deadline is ours to report, the cancellation is the caller's own abort.
    if (cancelled()) {
      stop(cancelledError())
      return
    }
    stop(
      new TowerToolError(
        'spawn-unavailable',
        `tower_spawn pre-flight exceeded spawn.preflightTimeoutMs (${budgetMs}ms) in phase ${phase}; no worker was started and details.rollback reports what the pre-flight released (or that the release is still pending)`,
        { details: factsFor(phase) },
      ),
    )
  }
  /**
   * #237 R2 P1: called at the start of every phase that writes. It records the
   * phase (so the activity trail and `details.phase` name the step that was
   * about to mutate) and then refuses if the pre-flight already ended: without
   * this the deadline only stopped the caller from waiting, while `run` kept
   * provisioning worktrees, reserving roster rows and activating children.
   * @param {string} next
   */
  const assertLive = (next) => {
    reach(next)
    if (stopped) throw stopped
  }
  /** @param {number} ms */
  const arm = (ms) => {
    clearTimeout(timer)
    timer = setTimeout(fire, Math.max(0, ms))
  }
  arm(budgetMs)
  /** @type {(() => void) | null} */
  let onCallerAbort = null
  if (listenable && !signal.aborted) {
    // A caller that cancels must not wait for the deadline, and must not depend
    // on the reads cooperating: abort the forwarded signal and end the call now,
    // with the phase it reached.
    onCallerAbort = () => {
      stop(cancelledError())
    }
    signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  /**
   * Re-arm the remaining budget once the repository config is known. Only the
   * not-yet-spent part of the new bound is granted: a pre-flight that already
   * burned its budget cannot extend it by reading its own config.
   * @param {unknown} value
   */
  const retune = (value) => {
    const next = budgetFor(value)
    if (next === budgetMs) return
    budgetMs = next
    arm(budgetMs - elapsed())
  }
  try {
    // An already-cancelled caller enters no phase and runs no read: starting the
    // pre-flight would spawn a child the caller has already given up on.
    if (cancelled()) throw cancelledError()
    /** @type {Promise<T>} */
    const running = run({ signal: controller.signal, reach, assertLive, retune })
    // A refused run keeps going until it reaches its next `assertLive` (or a
    // read forwards the abort). The caller must not be told the spawn failed
    // while that unwind is still writing: wait a bounded grace for it, then
    // report anyway rather than hang. The refusal itself is what the caller
    // sees either way — the run's own rejection is already accounted for.
    const settled = running.catch(() => {})
    const raced = Promise.race([running, expired])
    try {
      return await raced
    } catch (error) {
      if (stopped && error === stopped) await withinRefusalGrace(settled)
      throw error
    }
  } finally {
    clearTimeout(timer)
    // The deadline is over either way; do not leave the caller's listener behind.
    abort('pre-flight settled')
    if (listenable && onCallerAbort) signal.removeEventListener('abort', onCallerAbort)
  }
}

/**
 * #237 R2 P1: wait for a refused pre-flight to finish unwinding, but never
 * longer than the grace: the caller was already told the spawn failed, and a
 * rollback that outlives the window is reported by the rollback facts instead of
 * being waited for.
 * @param {Promise<unknown>} settled
 * @returns {Promise<void>}
 */
async function withinRefusalGrace(settled) {
  /** @type {any} */
  let timer
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, SPAWN_REFUSAL_GRACE_MS)
    // Node keeps the process alive for a pending timer; this one is a bound on a
    // wait, not work the caller is waiting for.
    if (typeof timer?.unref === 'function') timer.unref()
  })
  try {
    await Promise.race([settled, bound])
  } finally {
    clearTimeout(timer)
  }
}
