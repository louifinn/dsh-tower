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
 * Pick a unique roster name before any activation.
 * @param {{ role: string, missionId: string | undefined, requested: string | undefined, roster: any[] }} input
 */
export function resolveRosterName({ role, missionId, requested, roster }) {
  if (typeof requested === 'string' && requested.trim()) {
    const name = requested.trim()
    if (roster.some((entry) => entry.name === name)) {
      throw new TowerToolError('invalid-argument', 'roster name already used: ' + name)
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
  if (blocker) throw new TowerToolError(blocker.code, blocker.message)
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
      'stalled spawn reservation(s) hold review checkouts that could not be removed: ' +
        unreaped
          .map(
            (entry) =>
              `${entry.name} (mission ${entry.missionId ?? 'none'}) still holds ${entry.checkout} after ${entry.attempts} attempt(s): ${entry.error}`,
          )
          .join('; ') +
        '; remove it with "git worktree remove --force <path>" and retry tower_spawn, or run tower_init({op:"adopt"}) or tower_teardown to retry the cleanup',
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
      'mission ' +
        missionId +
        ' has ' +
        sameMission.length +
        ' live worker entries: ' +
        sameMission.map((entry) => `${entry.name} (${rosterDetail(entry)})`).join('; ') +
        '; inspect tower_inspect with view: roster before spawning',
    )
  }
  if (sameMission.length === 1 && !effectiveTakeover) {
    const worker = sameMission[0]
    throw new TowerToolError(
      'invalid-transition',
      'mission ' + missionId + ' already has a live worker "' + worker.name + '" (' + rosterDetail(worker) +
        '); stop it with tower_interrupt, or pass takeover:true after it is no longer running',
    )
  }
  if (effectiveTakeover) {
    if (sameMission.length === 1) {
      const worker = sameMission[0]
      const observed = await observeActivity(ctx, tower)
      if (observed.parentStatus[worker.parentSessionId] !== 'ok') {
        throw new TowerToolError(
          'takeover-refused',
          'cannot verify that worker ' + worker.name + ' (' + rosterDetail(worker) +
            ') stopped: its parent catalog is unavailable',
        )
      }
      const activity = observed.activity[worker.agentId]
      if (activity === 'running') {
        throw new TowerToolError(
          'takeover-refused',
          'worker ' + worker.name + ' is still running; call tower_interrupt (or wait) before takeover',
        )
      }
      if (activity === undefined) {
        throw new TowerToolError(
          'takeover-refused',
          'worker ' + worker.name + ' (mission ' + (worker.missionId ?? 'none') + ', ' + rosterDetail(worker) +
            ') is not in the live catalog; run tower_init({op:"adopt"}) before takeover',
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
      'live worker limit reached (' + max + ')' + (live ? '; live: ' + live : '') +
        '; stop a worker with tower_interrupt or raise spawn.maxLiveWorkers',
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
  if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot spawn')
  // The host adapter owns both the old list() surface and the rc.3 getProvider
  // surface; see app/host-contract.js.
  const provider = resolveSpawnProvider(subagents, config)
  const presets = ctx.get('agentPresets')
  if (presets && typeof presets.list === 'function') {
    const available = await presets.list()
    if (!available.some((entry) => String(entry.id) === preset)) {
      throw new TowerToolError('preset-missing', 'agent preset "' + preset + '" is not registered; check the Tower bundle preset rows and restart DSH')
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
        `spawn.requireLease="${requiredLease}" cannot be satisfied: ${leasesRow.reason ?? 'the tower-leases component is disabled'}, so tower_resource is not registered; re-enable the tower-leases row or clear spawn.requireLease`,
      )
    }
    const info = await inspectLeases(tower.commonDir)
    const lease = info.leases.find((entry) => entry.name === requiredLease && entry.expired !== true)
    if (!lease) {
      throw new TowerToolError(
        'lease-busy',
        `spawn.requireLease="${requiredLease}" is not held; acquire it with tower_resource before spawning`,
      )
    }
    if (lease.holder !== actor.name && lease.holder !== String(exec.agent.id)) {
      throw new TowerToolError(
        'lease-busy',
        `spawn.requireLease="${requiredLease}" is held by "${lease.holder}", not by this tower`,
      )
    }
  }
  return { subagents, provider }
}
