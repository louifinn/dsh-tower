// tower_wait input contract (#201). Pure TypeBox only; no I/O.
//
// The wait is bounded on purpose: a supervisor needs a conclusion it can act
// on (reached/timeout/unknown), never a tool call that can hang a model turn.
// The schema advertises the bounds and `tools/wait.js` enforces them again so
// an out-of-range call fails with the exact boundaries.
import { Type, enumOf } from './shared.js'

/** The conditions one bounded wait can reach. */
export const WAIT_UNTILS = ['settled', 'completed', 'inactive', 'any-change']
/** Default wait budget for an omitted `timeoutMs`. */
export const WAIT_DEFAULT_TIMEOUT_MS = 30000
/** Hard upper bound; the wait never exceeds it. */
export const WAIT_MAX_TIMEOUT_MS = 600000
/** Smallest accepted wait, so a timeout cannot be used as a busy spin. */
export const WAIT_MIN_TIMEOUT_MS = 1000

export const WaitInput = Type.Object({
  missionId: Type.Optional(
    Type.String({
      minLength: 1,
      description: 'Wait for this mission (pass exactly one of missionId or agent).',
    }),
  ),
  agent: Type.Optional(
    Type.String({
      minLength: 1,
      description: 'Wait for this roster agent, by name or agent id (pass exactly one of missionId or agent).',
    }),
  ),
  until: Type.Optional(
    enumOf(WAIT_UNTILS, {
      description:
        'settled (default): the target rests (mission completed/merged/blocked/paused/abandoned; agent not running); completed: the mission completed or merged; inactive: no roster row of the target is running; any-change: the target changed since the first read.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: WAIT_MIN_TIMEOUT_MS,
      maximum: WAIT_MAX_TIMEOUT_MS,
      description:
        'Bounded wait in milliseconds (default 30000, minimum 1000, maximum 600000). A wait always returns; it never blocks forever.',
    }),
  ),
}, { additionalProperties: false })
