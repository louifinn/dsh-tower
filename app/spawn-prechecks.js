// tower_spawn prechecks (#56 P3c): roster naming, mission preconditions, and
// service/provider/lease validation. Split out of tools/spawn.js; the only write
// is the stalled-reservation reap (#F57), which must be serialized with the
// ownership decision it unblocks.
import { TowerToolError } from '../domain/errors.js'
import { resolveSpawnProvider } from './host-contract.js'
import { reapStalledReservations } from './roster.js'
import { isStalledReservation } from '../domain/collab/spawn.js'
import { ROSTER_INACTIVE_STATES } from '../domain/roster.js'
import { reviewUnavailable } from '../domain/integration/review.js'
import { shapeFor } from '../domain/shapes/index.js'
import { roleCountsTowardBudget, roleMissionBlockers, roleTracksMission } from '../domain/roles.js'

/**
 * #F69: the preset ids the plugin page shows under a row title. A configured
 * custom id is not here: that name belongs to the operator, so rendering it is
 * correct and the copy gate treats it as a value, not an internal identifier.
 */
const VISIBLE_PRESET_LABELS = Object.freeze({
  'tower-worker': 'Tower Worker preset',
  'tower-reviewer': 'Tower Reviewer preset',
  'tower-survey': 'Tower Survey preset',
  'tower-survey-sandbox': 'Tower Survey Sandbox preset',
})

/** The plugin-page title of a preset id, or the configured custom id (#F69). */
export function presetLabel(id) {
  const key = String(id)
  return VISIBLE_PRESET_LABELS[key] ?? key
}

/**
 * #F69: every user-facing spawn failure is written here, in GLOSSARY.md
 * vocabulary: the visible plugin-page row (Lease coordination) and the concrete
 * next step, never a config key, a capability row id or a tool id. The copy gate
 * (`scripts/check-components.mjs`) reads this table and fails the build when an
 * internal identifier leaks back in. The stable error codes stay at the throw
 * sites; only the message and its rendered `next` step come from here.
 */
export const ERROR_COPY = Object.freeze({
  rosterNameTaken: 'roster name already used: {name}; choose a different name for this agent',
  stalledReservations:
    'stalled spawn reservation(s) hold review checkouts that could not be removed: {reservations}; remove each checkout with "git worktree remove --force <path>", then retry starting an agent, or run the adopt or teardown step to retry the cleanup',
  multipleLiveWorkers:
    'mission {missionId} has {count} live worker entries: {workers}; review the live roster before starting another agent',
  liveWorkerExists: 'mission {missionId} already has a live worker "{name}" ({detail})',
  liveWorkerExistsNext: 'stop it with the interrupt action, or pass takeover:true after it is no longer running',
  takeoverParentUnavailable:
    'cannot verify that worker {name} ({detail}) stopped: its parent catalog is unavailable',
  takeoverParentUnavailableNext: 'retry once the parent session is reachable',
  takeoverStillRunning: 'worker {name} is still running',
  takeoverStillRunningNext: 'interrupt it (or wait), then retry the takeover',
  takeoverNotInCatalog: 'worker {name} (mission {missionId}, {detail}) is not in the live catalog',
  takeoverNotInCatalogNext: 'run the roster adopt action, then retry the takeover',
  workerLimit: 'live worker limit reached ({max}){live}',
  workerLimitNext: 'stop a worker with the interrupt action or raise the live worker limit in the Tower configuration',
  spawnUnavailable: 'subagents service is unavailable; cannot spawn',
  presetMissing: 'the {preset} is not registered',
  presetMissingNext:
    'switch the {preset} row back on in the plugin page and restart DSH, or choose a registered preset on the plugin configuration form',
  presetMissingCustom: 'the configured preset "{preset}" is not registered',
  presetMissingCustomNext:
    'choose a registered preset on the plugin configuration form, or register the configured preset and restart DSH',
  leaseUnavailable:
    'the required lease "{lease}" cannot be satisfied: Lease coordination is switched off in the plugin page; switch it back on and restart DSH, or clear the lease requirement on the plugin configuration form',
  leaseUnavailableNext: 'switch Lease coordination back on in the plugin page and restart DSH',
  leaseNotHeld: 'no live lease "{lease}" is held; acquire it with the lease action before starting an agent',
  leaseNotHeldNext: 'acquire the lease with the lease action before starting an agent',
  leaseForeignHolder: 'lease "{lease}" is held by "{holder}", not by this tower',
  // #F84: the review-disabled refusal has no entry here. The role contract
  // (domain/roles.js) owns that sentence and the spawn precheck passes it
  // through unchanged, so a second copy would only be able to drift.
})

/** Fill the `{name}` placeholders of one copy string (#F69). */
function fillCopy(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/**
 * Pick a unique roster name before any activation.
 * @param {{ role: string, missionId: string | undefined, requested: string | undefined, roster: any[] }} input
 */
export function resolveRosterName({ role, missionId, requested, roster }) {
  if (typeof requested === 'string' && requested.trim()) {
    const name = requested.trim()
    if (roster.some((entry) => entry.name === name)) {
      throw new TowerToolError('invalid-argument', fillCopy(ERROR_COPY.rosterNameTaken, { name }))
    }
    return name
  }
  const base = role + '-' + String(missionId).toLowerCase()
  let candidate = base
  let suffix = 2
  while (roster.some((entry) => entry.name === candidate)) {
    candidate = base + '-' + suffix
    suffix += 1
  }
  return candidate
}

/**
 * #F109: the role-contract blocker rendered with the route that contract
 * attaches. The blocker prose belongs to the role contract (the #F84
 * single-source exception), so the passthrough keeps one construction site and
 * no ERROR_COPY entry; the optional route rides the same error.
 */
class RoleBlockerError extends TowerToolError {
  /** @param {{ code: string, message: string, nextAction?: string }} blocker */
  constructor(blocker) {
    super(blocker.code, blocker.message, blocker.nextAction ? { nextAction: blocker.nextAction } : undefined)
  }
}

/**
 * Role/mission preconditions checked before any provisioning.
 * `config` is the repository-resolved Tower config (#M39): with
 * `review.mode:off` there is no review to dispatch, so the reviewer role is
 * refused before a worktree, preset or activation is touched.
 * @param {{ role: string, context: any, config?: any }} input
 */
export function assertSpawnableMission({ role, context, config }) {
  const shape = shapeFor(context.mission.kind)
  // #149 W4: the role contract owns the prerequisites; the shape only supplies
  // facts (can it merge? does it have a worktree? which statuses accept a spawn).
  const [blocker] = roleMissionBlockers(role, {
    shape,
    mission: context.mission,
    reviewAvailable: !reviewUnavailable(config),
  })
  if (!blocker) return
  // #F84: every blocker goes through one path. The role contract owns the
  // sentence (operator copy for the review posture included), so the precheck
  // must not rewrite any code's message here; the caller gets the registry's
  // wording and the registry's matching next step.
  throw new RoleBlockerError(blocker)
}

/** One roster row in an error message: role, state and the agent id if any. */
function rosterDetail(entry) {
  const agent = typeof entry.agentId === 'string' ? entry.agentId : 'none'
  return `${entry.role ?? 'unknown'} ${entry.state ?? 'unknown'}, agent ${agent}`
}

/**
 * Single-owner and live-worker rules, checked before provisioning or starting
 * a child so a rejection cannot leak an activation or worktree.
 * Before the live-worker scan it reaps reservations that never received an
 * agent id (#F57); the caller's `view` was read before that reap, so reaped rows
 * are filtered out of it.
 * @param {{
 *   role: string,
 *   tower: any,
 *   ctx: any,
 *   view: any,
 *   missionId: string | undefined,
 *   takeover: boolean | undefined,
 *   maxLiveWorkers: number | undefined,
 *   budget: number,
 *   observeActivity: any,
 *   signal?: AbortSignal | undefined,
 * }} input
 */
export async function precheckWorkerOwnership({
  role,
  tower,
  ctx,
  view,
  missionId,
  takeover,
  maxLiveWorkers,
  budget,
  observeActivity,
  signal,
}) {
  let effectiveTakeover = takeover === true
  if (!roleTracksMission(role)) return effectiveTakeover
  // #F57: a reservation that never received an agent id belongs to a dispatch
  // that failed before activation. It can never become active and nothing can
  // observe or interrupt it, so counting it as a live worker would wedge the
  // mission (spawn, takeover and adopt all refuse). Reap those rows first, then
  // run the normal ownership checks on the remaining roster.
  const { reaped, unreaped } = await reapStalledReservations(tower)
  // A row whose disposable review checkout could not be removed is kept so the
  // path is not lost; report it as the actionable roster problem it is rather
  // than as a live worker that takeover can never resolve.
  if (unreaped.length > 0) {
    throw new TowerToolError(
      'invalid-transition',
      fillCopy(ERROR_COPY.stalledReservations, {
        reservations: unreaped
          .map(
            (entry) =>
              `${entry.name} (mission ${entry.missionId ?? 'none'}) still holds ${entry.checkout} after ${entry.attempts} attempt(s): ${entry.error}`,
          )
          .join('; '),
      }),
    )
  }
  const reapedNames = new Set(reaped.map((entry) => entry.name))
  const roster = reapedNames.size === 0 ? view.roster : view.roster.filter((entry) => !reapedNames.has(entry.name))
  // #148: a read-only survey worker must not consume a build worker slot, but
  // the single-owner rule still applies to every worker entry.
  const state = await tower.load()
  const kinds = new Map(state.missions.map((entry) => [entry.id, entry.kind]))
  const budgeted = (entry) => roleCountsTowardBudget(entry.role, shapeFor(kinds.get(entry.missionId)))
  const liveWorkers = roster.filter(
    (entry) =>
      roleTracksMission(entry.role) &&
      !ROSTER_INACTIVE_STATES.includes(entry.state) &&
      // A reservation still inside the grace window has no child behind it yet;
      // it may belong to a concurrent dispatch, so it must not count as a live
      // worker (that would reject the spawn it belongs to).
      !isStalledReservation(entry),
  )
  const budgetWorkers = liveWorkers.filter(budgeted)
  const sameMission = liveWorkers.filter((entry) => entry.missionId === missionId)
  if (sameMission.length > 1) {
    throw new TowerToolError(
      'invalid-transition',
      fillCopy(ERROR_COPY.multipleLiveWorkers, {
        missionId,
        count: sameMission.length,
        workers: sameMission.map((entry) => `${entry.name} (${rosterDetail(entry)})`).join('; '),
      }),
    )
  }
  if (sameMission.length === 1 && !effectiveTakeover) {
    const worker = sameMission[0]
    throw new TowerToolError(
      'invalid-transition',
      fillCopy(ERROR_COPY.liveWorkerExists, { missionId, name: worker.name, detail: rosterDetail(worker) }),
      { nextAction: fillCopy(ERROR_COPY.liveWorkerExistsNext) },
    )
  }
  if (effectiveTakeover) {
    if (sameMission.length === 1) {
      const worker = sameMission[0]
      const observed = await observeActivity(ctx, tower, { signal })
      if (observed.parentStatus[worker.parentSessionId] !== 'ok') {
        throw new TowerToolError(
          'takeover-refused',
          fillCopy(ERROR_COPY.takeoverParentUnavailable, { name: worker.name, detail: rosterDetail(worker) }),
          { nextAction: fillCopy(ERROR_COPY.takeoverParentUnavailableNext) },
        )
      }
      const activity = observed.activity[worker.agentId]
      if (activity === 'running') {
        throw new TowerToolError(
          'takeover-refused',
          fillCopy(ERROR_COPY.takeoverStillRunning, { name: worker.name }),
          { nextAction: fillCopy(ERROR_COPY.takeoverStillRunningNext) },
        )
      }
      if (activity === undefined) {
        throw new TowerToolError(
          'takeover-refused',
          fillCopy(ERROR_COPY.takeoverNotInCatalog, {
            name: worker.name,
            missionId: worker.missionId ?? 'none',
            detail: rosterDetail(worker),
          }),
          { nextAction: fillCopy(ERROR_COPY.takeoverNotInCatalogNext) },
        )
      }
    } else {
      effectiveTakeover = false
    }
  }
  const replacing = effectiveTakeover ? sameMission : []
  const remaining = budgetWorkers.filter((entry) => !replacing.includes(entry))
  const max = Math.min(Number(maxLiveWorkers) || 4, budget)
  // The new mission's shape decides whether this spawn consumes a build slot: a
  // survey does not, so it is allowed while every build slot is busy (#148).
  const mission = state.missions.find((entry) => entry.id === missionId)
  const countsTowardBudget = roleCountsTowardBudget(role, shapeFor(mission?.kind))
  if (countsTowardBudget && remaining.length >= max) {
    const live = remaining.map((entry) => `${entry.name} (${entry.missionId ?? 'no mission'})`).join(', ')
    throw new TowerToolError(
      'worker-limit',
      fillCopy(ERROR_COPY.workerLimit, { max, live: live ? '; live: ' + live : '' }),
      { nextAction: fillCopy(ERROR_COPY.workerLimitNext) },
    )
  }
  return effectiveTakeover
}

/**
 * Service/provider/preset/lease checks, run before provisioning.
 * `inspectLeases` is injected by the composition root so the app layer never
 * imports the lease adapter (#69). `leaseComponent` is the matching probe for the
 * `tower-leases` row (#131): when the row is off there is no `tower_resource`
 * tool, so a missing lease cannot be fixed by following the old advice.
 * @param {{ tower: any, ctx: any, config: any, preset: string, actor: any, exec: any, inspectLeases: any, leaseComponent?: () => { enabled: boolean, reason: string } }} input
 */
export async function precheckSpawnServices({ tower, ctx, config, preset, actor, exec, inspectLeases, leaseComponent }) {
  const subagents = ctx.get('subagents')
  if (!subagents) throw new TowerToolError('spawn-unavailable', fillCopy(ERROR_COPY.spawnUnavailable))
  // The host adapter owns both the old list() surface and the rc.3 getProvider
  // surface; see app/host-contract.js.
  const provider = resolveSpawnProvider(subagents, config)
  const presets = ctx.get('agentPresets')
  if (presets && typeof presets.list === 'function') {
    const available = await presets.list()
    if (!available.some((entry) => String(entry.id) === preset)) {
      // #F69: a built-in preset has a visible row in the plugin page, so both
      // remedies exist (switch the row back on, or configure a registered
      // preset). A custom configured id has no row: only the configuration-form
      // remedy is real, and the message names the configured value as the
      // operator's own name rather than an internal id.
      if (Object.hasOwn(VISIBLE_PRESET_LABELS, String(preset))) {
        throw new TowerToolError(
          'preset-missing',
          fillCopy(ERROR_COPY.presetMissing, { preset: presetLabel(preset) }),
          { nextAction: fillCopy(ERROR_COPY.presetMissingNext, { preset: presetLabel(preset) }) },
        )
      }
      throw new TowerToolError(
        'preset-missing',
        fillCopy(ERROR_COPY.presetMissingCustom, { preset }),
        { nextAction: fillCopy(ERROR_COPY.presetMissingCustomNext) },
      )
    }
  }
  if (typeof config.spawn.requireLease === 'string' && config.spawn.requireLease.trim()) {
    const requiredLease = config.spawn.requireLease.trim()
    // #131: registration-aware. Telling a caller to "acquire it with
    // tower_resource" is useless when the tower-leases row is off and the tool is
    // not registered; name the component and both remedies instead.
    const leasesRow = typeof leaseComponent === 'function' ? leaseComponent() : null
    if (leasesRow && leasesRow.enabled !== true) {
      // Refuse before reading the ledger: a lease left over from when the row was
      // on must not let a spawn through, and the ledger cannot be fixed without
      // the unregistered tool (issue #131, evidence note 4).
      throw new TowerToolError(
        'lease-busy',
        fillCopy(ERROR_COPY.leaseUnavailable, { lease: requiredLease }),
        { nextAction: fillCopy(ERROR_COPY.leaseUnavailableNext) },
      )
    }
    const info = await inspectLeases(tower.commonDir)
    const lease = info.leases.find((entry) => entry.name === requiredLease && entry.expired !== true)
    if (!lease) {
      throw new TowerToolError(
        'lease-busy',
        fillCopy(ERROR_COPY.leaseNotHeld, { lease: requiredLease }),
        { nextAction: fillCopy(ERROR_COPY.leaseNotHeldNext) },
      )
    }
    if (lease.holder !== actor.name && lease.holder !== String(exec.agent.id)) {
      throw new TowerToolError(
        'lease-busy',
        fillCopy(ERROR_COPY.leaseForeignHolder, { lease: requiredLease, holder: lease.holder }),
      )
    }
  }
  return { subagents, provider }
}
