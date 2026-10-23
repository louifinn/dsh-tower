// Stable domain events (#75).
//
// The domain layer *describes* what changed; `app/` persists the state and only
// then emits the event through the injected event port. `state.json` remains the
// authoritative record — events are a process-local observation channel, not an
// event-sourced log, and are never replayed.
//
// The table below is the single source of truth for the generated reference
// (`docs/reference/events.md`), so a rename cannot drift from the runtime.
// Every domain event carries `{ missionId, revision, at }`; `merged` also
// carries the merge `commit`. Names are dotted (`tower.mission.*`); the older
// tool-shaped `tower/<tool>` aliases stay for one minor release and are marked
// deprecated in the generated reference.
// @ts-check

/** @typedef {'planned'|'completed'|'reviewed'|'merged'|'abandoned'} MissionEventType */

/**
 * @typedef {object} MissionEventEntry
 * @property {MissionEventType} type
 * @property {string} name
 * @property {string[]} payload
 * @property {string} description
 */

/** Stable domain-fact events (`tower.mission.*`). */
export const MISSION_EVENTS = Object.freeze({
  planned: {
    type: 'planned',
    name: 'tower.mission.planned',
    payload: ['missionId', 'revision', 'at'],
    description: 'tower_plan persisted one or more new missions',
  },
  completed: {
    type: 'completed',
    name: 'tower.mission.completed',
    payload: ['missionId', 'revision', 'at'],
    description: 'tower_complete recorded a completion report (or tower_mission set status "completed")',
  },
  reviewed: {
    type: 'reviewed',
    name: 'tower.mission.reviewed',
    payload: ['missionId', 'revision', 'at'],
    description: 'tower_review recorded a verdict for the mission branch',
  },
  merged: {
    type: 'merged',
    name: 'tower.mission.merged',
    payload: ['missionId', 'revision', 'at', 'commit'],
    description: 'tower_merge recorded the merge commit that landed the mission branch',
  },
  abandoned: {
    type: 'abandoned',
    name: 'tower.mission.abandoned',
    payload: ['missionId', 'revision', 'at'],
    description: 'a mission transitioned to "abandoned"',
  },
})

/** @type {readonly MissionEventType[]} */
export const MISSION_EVENT_TYPES = Object.freeze(['planned', 'completed', 'reviewed', 'merged', 'abandoned'])

/** @type {readonly MissionEventEntry[]} */
export const MISSION_EVENT_TABLE = Object.freeze(
  MISSION_EVENT_TYPES.map((type) => /** @type {MissionEventEntry} */ (MISSION_EVENTS[type])),
)

/** Tool-shaped alias events, kept for one minor release (#75). */
export const LEGACY_TOOL_EVENT_TABLE = Object.freeze([
  { name: 'tower/init', description: '`tower_init` created or re-anchored state' },
  { name: 'tower/plan', description: '`tower_plan` created missions' },
  { name: 'tower/mission', description: '`tower_mission` changed one mission' },
  { name: 'tower/spawn', description: '`tower_spawn` recorded a worker/reviewer' },
  { name: 'tower/complete', description: '`tower_complete` recorded a completion report' },
  { name: 'tower/review', description: '`tower_review` recorded a verdict' },
  { name: 'tower/merge', description: '`tower_merge` returned (including gate failures; inspect `value.ok`)' },
  { name: 'tower/rebase', description: '`tower_rebase` returned' },
  { name: 'tower/teardown', description: '`tower_teardown` removed worktrees' },
  { name: 'tower/finding', description: '`tower_finding` created one finding' },
  { name: 'tower/findings', description: '`tower_findings` read/listed/updated findings' },
  { name: 'tower/send', description: '`tower_send` persisted a message' },
  { name: 'tower/inbox', description: '`tower_inbox` acknowledged messages' },
  { name: 'tower/interrupt', description: '`tower_interrupt` stopped a live agent' },
  { name: 'tower/diff', description: '`tower_diff` read a mission diff' },
  { name: 'tower/adopt', description: '`tower_adopt` reconciled the roster' },
  { name: 'tower/roster', description: '`tower_roster` read the roster' },
  { name: 'tower/status', description: '`tower_status` read the dashboard' },
  { name: 'tower/preflight', description: '`tower_preflight` evaluated the gate' },
  { name: 'tower/doctor', description: '`tower_doctor` completed its read-only checks' },
  { name: 'tower/recover', description: '`tower_recover` inspected or cleared a stale state lock' },
  { name: 'tower/test', description: '`tower_test` ran discovery' },
  { name: 'tower/batch', description: '`tower_batch` created, inspected or closed a batch' },
  { name: 'tower/resource', description: '`tower_resource` acquired/released/inspected leases' },
  { name: 'tower/import_legacy', description: '`tower_import_legacy` stored a legacy snapshot' },
  { name: 'tower/legacy_map', description: '`tower_legacy_map` mapped or listed legacy ids' },
  { name: 'tower/mode', description: '`tower_mode` read the session stance (`value.mode`, `allowAgentControl`, `deniedWhileActive`)' },
  { name: 'tower/control', description: '`tower_control` entered/left the mode (`value.mode`, actor/reason in `value`)' },
  { name: 'tower/reload', description: '`tower_reload` returned a reload schedule/result' },
])

/** @type {readonly string[]} */
export const LEGACY_TOOL_EVENT_NAMES = Object.freeze(LEGACY_TOOL_EVENT_TABLE.map((entry) => entry.name))

/** Total number of process-local events described by the generated reference. */
export const EVENT_COUNT = MISSION_EVENT_TABLE.length + LEGACY_TOOL_EVENT_TABLE.length

/**
 * The runtime name of a domain event type. Throws on an unknown type so a typo
 * fails in tests instead of emitting an unobservable event.
 * @param {string} type
 * @returns {string}
 */
export function missionEventName(type) {
  const entry = /** @type {Record<string, MissionEventEntry>} */ (MISSION_EVENTS)[type]
  if (!entry) throw new TypeError(`unknown mission event type "${type}"`)
  return entry.name
}

/**
 * A domain transition's event *descriptor*: what changed, before the caller
 * knows the persisted revision and timestamp. App code finalises it with
 * `buildMissionEvent` after the state write.
 * @param {MissionEventType} type
 * @param {string} missionId
 * @param {{ commit?: string }} [extra]
 * @returns {{ type: MissionEventType, missionId: string, commit?: string }}
 */
export function missionEventDescriptor(type, missionId, extra = {}) {
  if (!MISSION_EVENT_TYPES.includes(type)) throw new TypeError(`unknown mission event type "${type}"`)
  if (typeof missionId !== 'string' || missionId.length === 0) {
    throw new TypeError('mission events require a non-empty missionId')
  }
  const descriptor = /** @type {{ type: MissionEventType, missionId: string, commit?: string }} */ ({
    type,
    missionId,
  })
  if (type === 'merged') {
    if (typeof extra.commit !== 'string' || extra.commit.length === 0) {
      throw new TypeError('tower.mission.merged requires the merge commit')
    }
    descriptor.commit = extra.commit
  }
  return descriptor
}

/**
 * Finalise one descriptor into `{ name, payload }` for the event port.
 * Payload shapes are fixed here so `docs/reference/events.md` (generated from
 * the same table) cannot describe a different shape than the runtime emits.
 * @param {{ type: MissionEventType, missionId: string, commit?: string }} descriptor
 * @param {{ revision: number, at: number }} context
 * @returns {{ name: string, payload: Record<string, any> }}
 */
export function buildMissionEvent(descriptor, { revision, at }) {
  const entry = /** @type {Record<string, MissionEventEntry>} */ (MISSION_EVENTS)[descriptor.type]
  if (!entry) throw new TypeError(`unknown mission event type "${descriptor.type}"`)
  if (!Number.isInteger(revision)) throw new TypeError('mission events require the persisted integer revision')
  if (!Number.isFinite(at)) throw new TypeError('mission events require the transition timestamp')
  /** @type {Record<string, any>} */
  const payload = { missionId: descriptor.missionId, revision, at }
  if (entry.payload.includes('commit')) payload.commit = descriptor.commit
  return { name: entry.name, payload }
}

/**
 * Descriptors for a set of freshly persisted missions.
 * @param {Array<{ id: string }>} missions
 * @returns {Array<{ type: MissionEventType, missionId: string }>}
 */
export function plannedEvents(missions) {
  return missions.map((mission) => missionEventDescriptor('planned', mission.id))
}

/**
 * @param {{ id: string }} mission
 * @returns {{ type: MissionEventType, missionId: string }}
 */
export function completedEvent(mission) {
  return missionEventDescriptor('completed', mission.id)
}

/**
 * @param {{ id: string }} mission
 * @returns {{ type: MissionEventType, missionId: string }}
 */
export function reviewedEvent(mission) {
  return missionEventDescriptor('reviewed', mission.id)
}

/**
 * @param {{ id: string }} mission
 * @param {string} commit
 * @returns {{ type: MissionEventType, missionId: string, commit: string }}
 */
export function mergedEvent(mission, commit) {
  return /** @type {{ type: MissionEventType, missionId: string, commit: string }} */ (
    missionEventDescriptor('merged', mission.id, { commit })
  )
}

/**
 * @param {{ id: string }} mission
 * @returns {{ type: MissionEventType, missionId: string }}
 */
export function abandonedEvent(mission) {
  return missionEventDescriptor('abandoned', mission.id)
}
