// tower_wait (#201): one bounded blocking wait for a mission or roster agent.
//
// The call returns exactly one conclusion — `reached`, `timeout` (with the last
// bounded observation) or `unknown` (the target/catalog cannot be read, which is
// not a timeout). It never holds the state lock, never writes state, and never
// blocks the event loop longer than one poll interval: each round sleeps
// `min(500ms, remaining)` and re-reads `state.json` once through the read-only
// load path (no `persist`, so a wait can never migrate or write).
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import {
  WaitInput,
  WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_MAX_TIMEOUT_MS,
  WAIT_MIN_TIMEOUT_MS,
  WAIT_UNTILS,
} from '../domain/contracts/tool-inputs/index.js'
import {
  agentSummary,
  observationFingerprint,
  observeWaitTarget,
  waitConditionMet,
  waitReachedDetail,
  waitTimeoutLast,
} from '../domain/read/views.js'

/** Maximum time one poll pass sleeps before re-reading state. */
const WAIT_POLL_MS = 500

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * Read `state.json` once for one poll. `tower.load()` without `persist` is the
 * read-only path: no state lock, no write, no migration.
 * @param {any} tower
 */
async function readState(tower) {
  try {
    return { state: await tower.load() }
  } catch (error) {
    const reason = error?.code === 'not-initialized'
      ? `Tower state is not initialized for ${tower.root}; run tower_init first`
      : `Tower state is unreadable: ${String(error?.message ?? error)}`
    return { state: null, reason }
  }
}

/**
 * @param {any} ctx
 * @param {{
 *   define: import('../types/index.js').DefineTool,
 *   openTower: any,
 *   requireTowerActor?: (actor: any, action: string) => void,
 * }} deps
 */
export function registerWaitTool(ctx, deps) {
  const { define } = deps
  define(ctx, {
    name: 'tower_wait',
    description:
      'Wait, bounded, for one mission or roster agent until settled (default), completed, inactive or any-change. Returns reached, timeout (with the last observation) or unknown; timeoutMs is 1000-600000 (default 30000) and a wait never blocks forever. Never writes state. Details: docs/reference/tools.md.',
    parameters: WaitInput,
    aliases: { missionId: ['id'] },
    output: output(SCHEMAS.wait),
    validateArgs(args) {
      const hasMission = typeof args.missionId === 'string' && args.missionId.trim().length > 0
      const hasAgent = typeof args.agent === 'string' && args.agent.trim().length > 0
      if (hasMission === hasAgent) {
        throw new TowerToolError(
          'invalid-argument',
          'tower_wait takes exactly one of missionId or agent (pass a mission id, or a roster name/agent id)',
        )
      }
      if (args.until !== undefined && !WAIT_UNTILS.includes(args.until)) {
        throw new TowerToolError('invalid-argument', `tower_wait until must be one of ${WAIT_UNTILS.join('|')}`)
      }
      if (args.timeoutMs !== undefined) {
        const value = args.timeoutMs
        if (!Number.isInteger(value) || value < WAIT_MIN_TIMEOUT_MS || value > WAIT_MAX_TIMEOUT_MS) {
          throw new TowerToolError(
            'invalid-argument',
            `tower_wait timeoutMs must be an integer between ${WAIT_MIN_TIMEOUT_MS} and ${WAIT_MAX_TIMEOUT_MS} (got ${JSON.stringify(value)}); the default is ${WAIT_DEFAULT_TIMEOUT_MS} and a wait never exceeds ${WAIT_MAX_TIMEOUT_MS}`,
          )
        }
      }
    },
    async execute(args, exec, actor) {
      // Defence in depth: the authorization matrix already makes the row
      // tower-only, and this mirror keeps a direct handler call honest.
      deps.requireTowerActor?.(actor, 'wait for Tower targets')
      const tower = await deps.openTower(args.repoRoot)
      const target =
        typeof args.missionId === 'string'
          ? { missionId: args.missionId.trim() }
          : { agent: /** @type {string} */ (args.agent).trim() }
      const until = args.until ?? 'settled'
      const timeoutMs = args.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS
      const startedAt = Date.now()
      /** @type {string | null} */
      let baseline = null
      /**
       * The last roster row observed for an agent target. A row that vanishes
       * mid-wait is `missing` (a settled state) rather than an unknown target:
       * the target existed when the wait began, so its absence is the target's
       * final state, not a typo. `any-change` observes the same target, so a
       * disappearance there is also a reached change, reported as `missing`.
       * @type {any}
       */
      let lastAgentRow = null

      for (;;) {
        const { state, reason } = await readState(tower)
        if (!state) {
          return { status: 'unknown', waitedMs: Math.max(0, Date.now() - startedAt), target, reason }
        }
        const observation = observeWaitTarget(state, target)
        if (!observation.found) {
          if (lastAgentRow && (until === 'settled' || until === 'inactive' || until === 'any-change')) {
            return {
              status: 'reached',
              waitedMs: Math.max(0, Date.now() - startedAt),
              target,
              detail: { until, agent: { ...agentSummary(lastAgentRow), state: 'missing' } },
            }
          }
          return { status: 'unknown', waitedMs: Math.max(0, Date.now() - startedAt), target, reason: observation.reason }
        }
        if (observation.row) lastAgentRow = observation.row

        if (until === 'any-change') {
          const fingerprint = observationFingerprint(observation)
          if (baseline !== null && fingerprint !== baseline) {
            return {
              status: 'reached',
              waitedMs: Math.max(0, Date.now() - startedAt),
              target,
              detail: waitReachedDetail(observation, until),
            }
          }
          baseline = fingerprint
        } else if (waitConditionMet(observation, until)) {
          return {
            status: 'reached',
            waitedMs: Math.max(0, Date.now() - startedAt),
            target,
            detail: waitReachedDetail(observation, until),
          }
        }

        const remaining = timeoutMs - (Date.now() - startedAt)
        if (remaining <= 0) {
          return {
            status: 'timeout',
            waitedMs: Math.max(0, Date.now() - startedAt),
            target,
            last: waitTimeoutLast(observation, Number.isInteger(state.revision) ? state.revision : 0),
          }
        }
        // Bounded sleep; the next round re-reads state once. No lock is held
        // between reads, so a writer never waits on a waiting caller.
        await sleep(Math.min(WAIT_POLL_MS, remaining))
      }
    },
  })
}
