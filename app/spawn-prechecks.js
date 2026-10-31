// tower_spawn prechecks (#56 P3c): roster naming, mission preconditions, and
// service/provider/lease validation. Split out of tools/spawn.js; no I/O.
import { TowerToolError } from '../domain/errors.js'
import { ROSTER_INACTIVE_STATES } from '../domain/roster.js'

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
 * @param {{ role: string, context: any }} input
 */
export function assertSpawnableMission({ role, context }) {
  if (role === 'reviewer') {
    if (!context.mission.worktree) {
      throw new TowerToolError('reviewer-prerequisite', 'reviewer needs an existing mission worktree; spawn a worker first')
    }
    if (context.mission.status !== 'completed') {
      throw new TowerToolError('reviewer-prerequisite', `reviewer requires a completed mission; ${context.mission.id} is ${context.mission.status}`)
    }
  }
  if (role === 'worker' && ['merged', 'abandoned'].includes(context.mission.status)) {
    throw new TowerToolError(
      'invalid-transition',
      `mission ${context.mission.id} is ${context.mission.status}; a worker can only be spawned for a planned or active mission`,
    )
  }
}

/**
 * Single-owner and live-worker rules, checked before provisioning or starting
 * a child so a rejection cannot leak an activation or worktree.
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
  if (role !== 'worker') return effectiveTakeover
  const liveWorkers = view.roster.filter(
    (entry) => entry.role === 'worker' && !ROSTER_INACTIVE_STATES.includes(entry.state),
  )
  const sameMission = liveWorkers.filter((entry) => entry.missionId === missionId)
  if (sameMission.length > 1) {
    throw new TowerToolError(
      'invalid-transition',
      'mission ' + missionId + ' has ' + sameMission.length + ' live worker entries; inspect tower_roster before spawning',
    )
  }
  if (sameMission.length === 1 && !effectiveTakeover) {
    throw new TowerToolError(
      'invalid-transition',
      'mission ' + missionId + ' already has a live worker "' + sameMission[0].name + '"; stop it with tower_interrupt, or pass takeover:true after it is no longer running',
    )
  }
  if (effectiveTakeover) {
    if (sameMission.length === 1) {
      const worker = sameMission[0]
      const observed = await observeActivity(ctx, tower)
      if (observed.parentStatus[worker.parentSessionId] !== 'ok') {
        throw new TowerToolError(
          'takeover-refused',
          'cannot verify that worker ' + worker.name + ' stopped: its parent catalog is unavailable',
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
          'worker ' + worker.name + ' is not in the live catalog; run tower_adopt before takeover',
        )
      }
    } else {
      effectiveTakeover = false
    }
  }
  const replacing = effectiveTakeover ? sameMission : []
  const remaining = liveWorkers.filter((entry) => !replacing.includes(entry))
  const max = Math.min(Number(maxLiveWorkers) || 4, budget)
  if (remaining.length >= max) {
    throw new TowerToolError(
      'worker-limit',
      'live worker limit reached (' + max + '); stop a worker with tower_interrupt or raise spawn.maxLiveWorkers',
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
  const providers = subagents.list()
  const provider = config.spawn.provider || (providers.includes('spawn') ? 'spawn' : providers[0])
  if (!provider) throw new TowerToolError('provider-missing', 'no subagent provider is registered')
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
    const unavailable = leasesRow && leasesRow.enabled !== true
    const remedy = unavailable
      ? `the ${leasesRow.reason ?? 'tower-leases component is disabled'}, so tower_resource cannot acquire it; re-enable the tower-leases row or clear spawn.requireLease`
      : 'acquire it with tower_resource before spawning'
    const info = await inspectLeases(tower.commonDir)
    const lease = info.leases.find((entry) => entry.name === requiredLease && entry.expired !== true)
    if (!lease) {
      throw new TowerToolError(
        'lease-busy',
        `spawn.requireLease="${requiredLease}" is not held; ${remedy}`,
      )
    }
    if (lease.holder !== actor.name && lease.holder !== String(exec.agent.id)) {
      throw new TowerToolError(
        'lease-busy',
        `spawn.requireLease="${requiredLease}" is held by "${lease.holder}", not by this tower${unavailable ? ` (${leasesRow.reason})` : ''}`,
      )
    }
  }
  return { subagents, provider }
}
