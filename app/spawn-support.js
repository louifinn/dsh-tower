// tower_spawn support (#56 P3c): briefing assembly, agent options, and the
// wait/result settling path. Split out of tools/spawn.js; no I/O of its own.
import { shapeFor } from '../domain/shapes/index.js'
import { roleBriefingKind, rolePlacement } from '../domain/roles.js'
import { TowerToolError, classifyError } from '../domain/errors.js'
import { DEFAULT_SPAWN_PREFLIGHT_TIMEOUT_MS } from '../domain/config/schema.js'
import { SPAWN_OUTCOME } from '../domain/vocabulary.js'
import { workerBriefing, reviewerBriefing } from './briefing.js'
import { buildActivationSpec } from './host-contract.js'
import { cleanupReviewCheckout } from './reviewCheckout.js'

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
 * #237: the pre-flight bookkeeping one `tower_spawn` call owns — how far a
 * stalled call got, and what the repository queue cost it. It is a closure over
 * one call, not module state, so two concurrent spawns never share a trail.
 *
 * `onPhase` writes one activity line per phase and never one per poll: a phase
 * is entered once, so a caller reading activity.jsonl after a kill can see the
 * last phase the call reached. Transitions that happen before a tower handle
 * exists (opening the repository) are buffered and replayed in order by
 * `attach`, rather than dropped.
 *
 * `onWait`/`onQueue` record what the queue cost. The deadline fires from a timer
 * with no ordering against the queue's own settle report, so the wait start is
 * kept here: a caller refused *because* it was queued is then reported as
 * `queue` with the wait it burned, never as a later phase.
 *
 * @param {{ missionId: string }} input
 */
export function createSpawnPreflightRecorder({ missionId }) {
  /** @type {any} */
  let tower = null
  /** @type {Array<[string, number]>} */
  const trail = []
  const flush = () => {
    if (!tower) return
    while (trail.length > 0) {
      const next = trail.shift()
      if (!next) return
      const [phase, elapsedMs] = next
      tower
        .appendActivity({ at: Date.now(), type: 'spawn', missionId, text: `pre-flight ${phase} after ${elapsedMs}ms` })
        .catch(() => {})
    }
  }
  /**
   * Start replaying buffered phases into this repository's activity log.
   * @param {any} handle
   */
  const attach = (handle) => {
    tower = handle
    flush()
  }
  /**
   * @param {string} phase
   * @param {number} elapsedMs
   */
  const onPhase = (phase, elapsedMs) => {
    if (!isSpawnPreflightPhase(phase)) return
    // The queue wait is reported by the queue itself with its own clock and
    // depth; the phase marker here only names where a stall was detected.
    if (phase !== 'queue') trail.push([phase, elapsedMs])
    flush()
  }
  /** @type {{ queuedAt: number, depth: number } | null} */
  let queueWait = null
  /**
   * Facts only: the activity line is written once, when the wait is over (or
   * refused), so a long queue is one line and not one per poll.
   * @param {{ depth: number, queuedAt: number }} wait
   */
  const onWait = (wait) => {
    queueWait = { queuedAt: wait.queuedAt, depth: wait.depth }
  }
  /**
   * @param {{ waitedMs: number, depth: number }} wait
   */
  const onQueue = (wait) => {
    const queuedAt = Date.now() - Math.max(0, Number(wait.waitedMs) || 0)
    queueWait = { queuedAt, depth: wait.depth }
    if (!tower) return
    tower
      .appendActivity({
        at: Date.now(),
        type: 'spawn',
        missionId,
        text: `pre-flight queued ${wait.waitedMs}ms behind ${wait.depth - 1} other spawn(s)`,
      })
      .catch(() => {})
  }
  /**
   * The facts the deadline attaches to `details` for the phase it expired in.
   * Only the queue owns extra facts; every other phase reports the
   * {phase, elapsedMs} pair the contract promises and nothing more.
   * @param {string} reached
   */
  const details = (reached) => {
    if (reached !== 'queue' || !queueWait) return {}
    return { waitedMs: Math.max(0, Date.now() - queueWait.queuedAt), depth: queueWait.depth }
  }
  return { attach, onPhase, onWait, onQueue, details }
}

/**
 * #237: bound the tower_spawn pre-flight with one deadline instead of hoping
 * every read settles. `run` receives an abort signal it must forward to the
 * reads it performs, a `reach(phase)` marker it calls before entering each phase
 * so a stalled call names the step that never answered, and a `retune(ms)`
 * marker it calls once the repository config resolves.
 *
 * The deadline covers the whole pre-flight: the phases are sequential, so the
 * bound a caller asked for is the bound it gets. The abort signal alone is not
 * enough — a read that ignores it would still hang — so the deadline rejects
 * the returned promise on its own. `retune` re-arms the *remaining* budget to
 * the configured `spawn.preflightTimeoutMs` from the start, so a repository that
 * allows a longer bound gets it while an already spent budget is not refunded.
 *
 * @template T
 * @param {{
 *   timeoutMs?: number | undefined,
 *   signal?: AbortSignal | undefined,
 *   phase?: string | undefined,
 *   onPhase?: ((phase: string, elapsedMs: number) => void) | undefined,
 *   details?: ((phase: string) => Record<string, unknown>) | undefined,
 *   run: (context: { signal: AbortSignal, reach: (phase: string) => void, retune: (timeoutMs: unknown) => void }) => Promise<T>,
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
  // `details` lets the caller attach facts it owns to the refusal (the queue
  // reports the wait it cost) without this helper knowing about queues.
  /** @param {string} name */
  const factsFor = (name) => {
    const extra = typeof details === 'function' ? details(name) : null
    return { ...(extra ?? {}), phase: name, elapsedMs: elapsed() }
  }
  const cancelledError = () =>
    new TowerToolError(
      'spawn-unavailable',
      'tower_spawn was cancelled during pre-flight; the mission keeps its planned status and no worker was started',
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
  const fire = () => {
    // A cancelled caller and an expired deadline are different failures: the
    // deadline is ours to report, the cancellation is the caller's own abort.
    if (cancelled()) {
      fail(cancelledError())
      return
    }
    fail(
      new TowerToolError(
        'spawn-unavailable',
        `tower_spawn pre-flight exceeded spawn.preflightTimeoutMs (${budgetMs}ms) in phase ${phase}; the mission keeps its planned status and no worker was started, so a retry needs no cleanup`,
        { details: factsFor(phase) },
      ),
    )
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
      abort(signal.reason)
      fail(cancelledError())
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
    return await Promise.race([run({ signal: controller.signal, reach, retune }), expired])
  } finally {
    clearTimeout(timer)
    // The deadline is over either way; do not leave the caller's listener behind.
    abort('pre-flight settled')
    if (listenable && onCallerAbort) signal.removeEventListener('abort', onCallerAbort)
  }
}

/**
 * Resolve where a spawn runs (#149 W3). A worker gets the shape's provisioning
 * (branch worktree, shared checkout, or detached survey sandbox); a reviewer
 * gets a disposable detached checkout at the recorded branch tip, so the
 * verdict is stamped with a commit instead of a live worktree HEAD.
 * @param {any} tower
 * @param {{ role: string, context: any, missionId: string, name: string, worktreeRoot?: string, includeDirtyBase?: boolean, instructions?: string }} input
 */
export async function provisionSpawnPlacement(tower, { role, context, missionId, name, worktreeRoot, includeDirtyBase, instructions }) {
  // #149 W4: the role contract decides the placement; the shape supplies the
  // mission provisioning facts it does not own.
  const reviewCheckout = rolePlacement(role) === 'review-checkout'
  const shape = shapeFor(context.mission.kind)
  const provisioned = reviewCheckout
    ? null
    : await tower.provision({ missionId, worktreeRoot, includeDirtyBase: includeDirtyBase !== false })
  const review = reviewCheckout
    ? await tower.provisionReviewCheckout({ missionId, name, worktreeRoot })
    : null
  const mission = review ? review.mission : provisioned.mission
  const worktree = review ? mission.worktree : provisioned.worktree
  const cwd = review ? review.path : (provisioned.cwd ?? worktree.path)
  const branch = worktree?.branch ?? null
  // The briefing must describe the checkout that actually exists: a detached
  // sandbox is recorded only after provision, so use the provisioned mission.
  const briefing = buildSpawnBriefing({
    role,
    towerRoot: tower.root,
    context: /** @type {any} */ ({ ...context, mission }),
    worktree,
    review,
    instructions,
  })
  return {
    mission,
    worktree,
    cwd,
    branch,
    review,
    briefing,
    provisioning: review ? 'review-checkout' : (provisioned.provisioning ?? shape.provisioning),
    created: review ? true : provisioned.created,
    sandbox: provisioned?.sandbox ?? null,
  }
}

/**
 * #237: the mutation half of a spawn — reserve the roster row, start the child,
 * record it — kept beside the placement it depends on so `tools/spawn.js` stays
 * a registration and not an orchestration. The failure path is part of the
 * contract here because it is what keeps a half-started spawn honest: the child
 * is interrupted when one already started, the reserved row is failed, and a
 * review spawn's detached checkout is reclaimed, so a retry needs no cleanup.
 *
 * @param {{
 *   tower: any,
 *   subagents: any,
 *   provider: string,
 *   preset: string,
 *   name: string,
 *   exec: any,
 *   briefing: string,
 *   cwd: string,
 *   branch: string | null,
 *   review: any,
 *   mission: any,
 *   role: string,
 *   config: any,
 *   agentOptions: Record<string, unknown>,
 *   takeover: any,
 *   worktree: any,
 *   sandbox: any,
 *   provisioning: any,
 *   created: any,
 *   reach: (phase: string) => void,
 *   recordSpawnSuccess: (root: string, maxLiveWorkers: any) => void,
 *   recordSpawnThrottle: (root: string, maxLiveWorkers: any) => void,
 * }} input
 */
export async function activateAndRecordSpawn(input) {
  const {
    tower, subagents, provider, preset, name, exec, briefing, cwd, branch, review,
    mission, role, config, agentOptions, takeover, worktree, sandbox,
    provisioning, created, reach, recordSpawnSuccess, recordSpawnThrottle,
  } = input
  const maxLiveWorkers = config.spawn.maxLiveWorkers
  const maxDepth = config.spawn.maxDepth ?? 1
  let activation = null
  let agentId = null
  let entry = null
  reach('reserve')
  const reserved = await tower.reserveRoster({
    missionId: mission.id,
    name,
    role,
    parentSessionId: String(exec.agent.id),
    cwd,
    branch,
    reviewCommit: review?.commit,
    reviewCheckout: review?.path,
  })
  try {
    reach('activate')
    // Flat on DSH 0.2.2-rc.3, nested on rc.1/rc.2; the adapter selects the shape.
    activation = await subagents.startActivation(buildActivationSpec(subagents, {
      provider, label: name,
      request: {
        cwd, agentPreset: preset, prompt: [{ type: 'text', text: briefing }],
        parent: exec.agent, maxDepth,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      },
      signal: exec.signal,
    }))
    agentId = String(activation.childId)
    reach('record')
    entry = await tower.recordSpawn({
      missionId: mission.id,
      name,
      role,
      agentId,
      parentSessionId: String(exec.agent.id),
      cwd,
      branch,
      reviewCommit: review?.commit,
      reviewCheckout: review?.path,
      takeover,
    })
    recordSpawnSuccess(tower.root, maxLiveWorkers)
  } catch (error) {
    if (classifyError(error).retryable === true) {
      recordSpawnThrottle(tower.root, maxLiveWorkers)
    }
    // The child may already be running: stop it and fail the reserved entry.
    if (agentId) {
      try {
        await Promise.resolve(subagents.interrupt(agentId, { kind: 'ancestor', agent: exec.agent }))
      } catch {
        // best effort; the error below is the actionable one
      }
    }
    await tower
      .recordSpawnOutcome({
        missionId: mission.id,
        name,
        state: SPAWN_OUTCOME.failed,
        detail: `spawn failed${agentId ? ` after activation ${agentId}` : ' before activation'}: ${String(error?.message ?? error).slice(0, 300)}`,
      })
      .catch(() => {})
    // A failed review spawn must not leak its detached evidence checkout.
    if (review) {
      await cleanupReviewCheckout(tower, { name, missionId: mission.id }).catch(() => {})
    }
    throw error
  }
  const recordOutcome = (state, detail) =>
    tower.recordSpawnOutcome({ missionId: mission.id, name, state, detail }).catch(() => {})

  const report = {
    name,
    agentId,
    role,
    missionId: mission.id,
    preset,
    provider,
    maxDepth,
    ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
    worktree: worktree ? { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit } : null,
    nodeModulesLink: reserved?.nodeModulesLink ?? null,
    sandbox,
    review: review ? { commit: review.commit, checkout: review.path } : null,
    provisioning,
    created,
    briefingChars: briefing.length,
    takeover,
    rosterEntry: entry,
  }

  return { report, activation, recordOutcome }
}

/**
 * @param {any} model
 * @returns {Record<string, unknown>}
 */
export function buildAgentOptions(model) {
  /** @type {Record<string, unknown>} */
  const agentOptions = {}
  for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens']) {
    if (model && model[key] !== undefined && model[key] !== null && model[key] !== '') agentOptions[key] = model[key]
  }
  return agentOptions
}

/**
 * @param {{ role: string, towerRoot: string, context: any, worktree: any, review?: any, instructions: string | undefined }} input
 */
export function buildSpawnBriefing({ role, towerRoot, context, worktree, review = null, instructions }) {
  // Only a shape that owns a worktree gets the git checkout projection; a survey
  // reads the shared checkout and must not see a worktree record it does not own.
  const shape = shapeFor(context.mission.kind)
  const mission = shape.fields.worktree
    ? { ...context.mission, worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit } }
    : { ...context.mission }
  const briefing = {
    repoRoot: towerRoot,
    base: context.base,
    mission,
    deps: context.deps,
    worktree: worktree ?? null,
    review,
    instructions,
    reviews: context.reviews,
    findings: context.findings,
    completionReport: context.completionReport,
  }
  return roleBriefingKind(role) === 'reviewer' ? reviewerBriefing(briefing) : workerBriefing(briefing)
}

/**
 * Wait for the activation result when wait=true, or forward the eventual
 * outcome when wait=false.
 * @param {{
 *   activation: any,
 *   report: any,
 *   recordOutcome: (state: string, detail: any) => Promise<any>,
 *   maxWaitMs: number | undefined,
 *   requestedWaitMs: number | undefined,
 *   textOf: any,
 * }} input
 */
export async function waitForSpawnResult({ activation, report, recordOutcome, maxWaitMs, requestedWaitMs, textOf }) {
  const waitMs = Math.max(1000, Math.min(maxWaitMs ?? 90000, requestedWaitMs ?? 180000))
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), waitMs)
  })
  let result
  try {
    result = await Promise.race([activation.result, timeout])
  } catch (error) {
    report.stopReason = 'failed'
    report.diagnostic = String(error?.message ?? error)
    await recordOutcome('failed', report.diagnostic)
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (result && result.__timeout) {
    report.timedOut = true
    recordOutcome('unknown', 'spawn wait timed out; check tower_inspect with view: roster')
  } else {
    report.stopReason = result?.stopReason ?? null
    report.output = textOf(result?.output)
    report.diagnostic = result?.diagnostic ?? null
    const state = report.stopReason === 'completed' ? 'inactive' : 'failed'
    if (state === 'failed') report.diagnostic = report.diagnostic ?? report.stopReason
    await recordOutcome(state, report.diagnostic ?? null)
  }
  return report
}
