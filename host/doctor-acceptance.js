// Extra read-only doctor checks kept out of host/doctor.js.
//
// #159: an artifact mission's merge gate is a human acceptance of the committed
// tip, never a review. A pending acceptance is a warning (the human decides when
// to accept it), and a recorded one is reported so the decision stays visible
// without running preflight.
//
// #F32/#F71: the state writer lock and the short-lived state-commit mutex are
// the two records that can wedge every Tower mutation. Both checks live here
// too, so host/doctor.js stays under its file-size ceiling and the two records
// are described by one module: the doctor never reclaims or writes anything.
import { shapeFor } from '../domain/shapes/index.js'
import { CAPABILITY_STANCE, DOCTOR_STATUS } from '../domain/vocabulary.js'
import { lockTiming } from '../adapters/persistence.js'
import { inventoryOrphanWorktrees } from '../app/teardown.js'

// #F75: the remedy an artifact acceptance row injects is user-facing copy. The
// component gate reads this table, so the sentence names the human decision and
// the merge consequence without a tool id.
const DOCTOR_ACTION_COPY = Object.freeze({
  artifactAcceptance:
    'the human accepts through the approval channel; no agent may self-accept and the merge gate refuses without it',
  // #187: `create_worktree` is allowed and not denied; its checkouts become
  // visible here instead. The copy names the explicit sweep, never a tool id,
  // and states the boundary the sweep cannot cross (outside the worktree root).
  orphanWorktrees:
    'run the worktree teardown step with its orphan option; it removes only clean checkouts inside the worktree root, never the main checkout or a path outside it, and nothing is removed automatically',
  // #188/#189: doctor reports the stance for a non-Tower capability and never
  // denies or removes it. The remedy names the one-path-at-a-time discipline
  // without a tool id or a config key.
  foreignCapabilities:
    'keep the capability available and land changes through one path at a time, or turn its plugin row off for a run that must land changes through Tower; doctor only reports the stance and never denies or removes a capability',
})

/**
 * One `artifact-acceptance` doctor check over the loaded state.
 * @param {{ missions?: any[] }} state
 */
export function artifactAcceptanceCheck(state) {
  const missions = (state.missions ?? []).filter((mission) => shapeFor(mission.kind).fields.acceptance)
  const pending = missions.filter((mission) => !shapeFor(mission.kind).isTerminal(mission.status) && !(/** @type {any} */ (mission).acceptance))
  const accepted = missions.filter((mission) => Boolean(/** @type {any} */ (mission).acceptance))
  if (pending.length > 0) {
    return {
      id: 'artifact-acceptance',
      status: 'warn',
      detail: `${pending.length} artifact mission(s) wait on a human acceptance of the committed tip (${pending.map((mission) => mission.id).join(', ')})`,
      action: DOCTOR_ACTION_COPY.artifactAcceptance,
    }
  }
  return {
    id: 'artifact-acceptance',
    status: 'pass',
    detail:
      accepted.length > 0
        ? `${accepted.length} artifact mission(s) with a recorded human acceptance`
        : 'no artifact missions pending acceptance',
  }
}

/**
 * #187: report the checkouts git knows that no mission, sandbox or review row
 * records. `create_worktree` stays allowed (Tower does not deny the capability)
 * and this check is what makes its checkouts visible; a lost state file or a
 * crashed provision shows up the same way. Doctor is read-only — only the
 * explicit orphan sweep in `tower_teardown` removes anything, and only a clean
 * checkout strictly inside the worktree root. A checkout outside that root is
 * reported but can never be removed by the sweep, so the limitation is stated in
 * the row instead of hidden.
 * @param {any} tower
 * @param {any} state
 */
export async function orphanWorktreeCheck(tower, state) {
  let inventory
  try {
    inventory = await inventoryOrphanWorktrees(tower, state)
  } catch (error) {
    return {
      id: 'worktrees-orphans',
      status: 'warn',
      detail: `could not inventory git worktrees: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 240)}`,
      action: DOCTOR_ACTION_COPY.orphanWorktrees,
    }
  }
  // A reserved path belongs to a mission that may be recording its checkout
  // right now. It is read-only noise rather than an unrecorded checkout, but it
  // must still be named (#187): a bare "no unrecorded worktrees" would hide a
  // checkout the sweep is deliberately keeping.
  const inflight = inventory.inflight.length
  const inflightNote = inflight > 0 ? `${inflight} checkout(s) in flight (kept)` : ''
  const externalNote =
    inventory.external.length > 0
      ? `; ${inventory.external.length} checkout(s) outside the worktree root are unrecorded too and are never removed by Tower`
      : ''
  if (inventory.orphans.length === 0 && inventory.external.length === 0) {
    return {
      id: 'worktrees-orphans',
      status: 'pass',
      detail: inflight > 0 ? `no unrecorded worktrees; ${inflightNote}` : 'no unrecorded worktrees',
    }
  }
  if (inventory.orphans.length === 0) {
    return {
      id: 'worktrees-orphans',
      status: 'warn',
      detail: `no unrecorded worktree inside the worktree root${externalNote}${inflight > 0 ? `; ${inflightNote}` : ''}`,
      action: DOCTOR_ACTION_COPY.orphanWorktrees,
    }
  }
  const dirty = inventory.orphans.filter((entry) => entry.action === 'keep').length
  const prunable = inventory.orphans.filter((entry) => entry.action === 'prune').length
  const removable = inventory.orphans.length - dirty - prunable
  const parts = []
  if (removable > 0) parts.push(`${removable} clean`)
  if (dirty > 0) parts.push(`${dirty} with uncommitted changes (kept)`)
  if (prunable > 0) parts.push(`${prunable} with a stale registration`)
  return {
    id: 'worktrees-orphans',
    status: 'warn',
    detail: `${inventory.orphans.length} unrecorded worktree(s) under the worktree root (${parts.join(', ')})${externalNote}${inflight > 0 ? `; ${inflightNote}` : ''}; run the worktree teardown step with its orphan option`,
    action: DOCTOR_ACTION_COPY.orphanWorktrees,
  }
}

function check(id, status, detail, action) {
  return { id, status, detail, ...(action ? { action } : {}) }
}

/**
 * Facts and the `state-lock` check for the state writer lock (#F32/#92).
 *
 * An unreadable record is a warning, never a pass (#F71 R1): the lock file
 * exists and every mutation keeps failing on it, so "no state lock" would hide
 * exactly the state the operator needs to repair.
 * @param {{ record: any, alive: boolean | null, path?: string, error?: string }} lock
 */
export function stateLockFacts(lock) {
  const timing = lockTiming(lock.record)
  const report = {
    held: Boolean(lock.record),
    unreadable: Boolean(lock.error),
    path: lock.path ?? null,
    error: lock.error ?? null,
    pid: lock.record?.pid ?? null,
    startedAt: lock.record?.startedAt ?? null,
    at: lock.record?.at ?? null,
    alive: lock.alive,
    ageMs: timing.ageMs,
    heartbeatAgeMs: timing.heartbeatAgeMs,
    staleAfterMs: timing.staleAfterMs,
    stale: timing.stale,
  }
  // The PID alone cannot distinguish a live writer from a recycled PID (#92);
  // report the heartbeat age so a stuck tower is diagnosable without reading
  // the file.
  const heartbeatText =
    timing.heartbeatAgeMs === null
      ? 'no heartbeat timestamp'
      : `last heartbeat ${timing.heartbeatAgeMs}ms ago (stale after ${timing.staleAfterMs}ms)`
  const row = lock.error
    ? check(
        'state-lock',
        'warn',
        `unreadable state lock at ${lock.path ?? 'the state lock file'} (${lock.error}); every mutation retries it and then fails until it is moved aside`,
        'confirm no Tower writer is active, then run the clear-stale-lock recovery step with force:true and confirm:"CLEAR_STALE_LOCK" to rename the unreadable record to a backup (never delete it)',
      )
    : !lock.record
      ? check('state-lock', 'pass', 'no state lock file')
      : lock.alive === false
      ? check(
          'state-lock',
          'warn',
          `stale state lock (pid ${lock.record.pid ?? 'unknown'} is gone; ${heartbeatText}); the next mutation reclaims it atomically`,
        )
      : timing.stale
        ? check(
            'state-lock',
            'warn',
            `state lock pid ${lock.record.pid ?? 'unknown'} is alive but silent (${heartbeatText}); a live-but-silent holder is never reclaimed automatically`,
            'confirm the process is gone (or stop it), then run the clear-stale-lock recovery step with force:true and confirm:"CLEAR_STALE_LOCK" to move the record to a backup',
          )
        : check(
            'state-lock',
            'warn',
            `state lock held by pid ${lock.record.pid ?? 'unknown'}; ${heartbeatText}; retry after it finishes`,
          )
  return { report, check: row }
}

/**
 * Facts and the `commit-lock` check for the short-lived commit mutex (#F71).
 *
 * The mutex is held for one serialise→rename→read-back window, so a record
 * that outlives its process is a leftover fence, not a lock anyone waits out.
 * This check is diagnostic only: `tower_recover clear-stale-lock` is the
 * audited way to move the record aside, and the live holder path always keeps
 * the record (a writer may be between its last CAS and the rename).
 *
 * An unreadable mutex is a warning, never a pass (#F71 R1): the torn record
 * exists and every state write keeps failing on it with `state-commit-busy`.
 * @param {{ record: any, alive: boolean | null, path?: string, error?: string } | null} lock
 */
export function commitLockFacts(lock) {
  const timing = lockTiming(lock?.record ?? null)
  const report = {
    held: Boolean(lock?.record),
    unreadable: Boolean(lock?.error),
    path: lock?.path ?? null,
    error: lock?.error ?? null,
    pid: lock?.record?.pid ?? null,
    token: lock?.record?.token ?? null,
    at: lock?.record?.at ?? null,
    alive: lock?.alive ?? null,
    ageMs: timing.ageMs,
    heartbeatAgeMs: timing.heartbeatAgeMs,
    staleAfterMs: timing.staleAfterMs,
    stale: timing.stale,
  }
  const heldText =
    timing.ageMs === null ? 'an unknown duration' : `${Math.max(0, Math.round(timing.ageMs))}ms`
  const row = lock?.error
    ? check(
        'commit-lock',
        'warn',
        `unreadable state commit mutex at ${lock.path ?? 'the commit lock file'} (${lock.error}); every state write retries it and then fails with state-commit-busy until it is moved aside`,
        'confirm no Tower writer is active, then run the clear-stale-lock recovery step with force:true and confirm:"CLEAR_STALE_LOCK" to rename the unreadable record to a backup (never delete it)',
      )
    : !lock?.record
      ? check('commit-lock', 'pass', 'no state commit mutex')
      : lock.alive === false
      ? check(
          'commit-lock',
          'warn',
          `leftover state commit mutex (pid ${lock.record.pid ?? 'unknown'} is gone; held for ${heldText}); the next state mutation reclaims it atomically`,
        )
      : timing.stale
        ? check(
            'commit-lock',
            'warn',
            `state commit mutex pid ${lock.record.pid ?? 'unknown'} is alive but silent (last activity ${heldText} ago); a live commit holder is never reclaimed automatically`,
            'confirm no Tower writer is active, then run the clear-stale-lock recovery step with force:true and confirm:"CLEAR_STALE_LOCK" to move the record to a backup',
          )
        : check(
            'commit-lock',
            'warn',
            `state commit in progress (pid ${lock.record.pid ?? 'unknown'}, held for ${heldText}); retry after it finishes`,
          )
  return { report, check: row }
}

// #188/#189: the inventory of non-Tower capabilities that can orchestrate agents
// or land changes. Each row records the stance Tower takes, how doctor detects
// it, and the one-line cost of denying it. Tower does not deny these by default:
// denial would break a workflow Tower does not replace while still leaving Tower
// no record of the change it refused. Doctor reports the inventory and never
// enforces it; a capability with no readable source is reported as not
// detectable, never assumed absent.
const FORGE_PACKAGE = '@deepseek-ai/dsh-experimental-forge'
const LIVESHARE_PACKAGE = '@deepseek-ai/dsh-experimental-liveshare'
const AUTO_REVIEW_PACKAGE = '@deepseek-ai/dsh-experimental-auto-review'
const PLUGIN_MANAGER_PACKAGE = '@deepseek-ai/dsh-plugin-manager'
const PLUGIN_MANAGER_TOOL = 'plugin_manager'
const AUTO_PRESET = 'auto'

export const FOREIGN_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'forge',
    name: 'Forge change requests',
    detection: `the loader row for ${FORGE_PACKAGE}, or a mounted forge service`,
    stance: CAPABILITY_STANCE.warnAllow,
    denialCost:
      'forge would lose its change-request and merge-on-request path, and Tower would have no record of what it refused',
    remedy:
      'keep forge mounted and land changes through one path at a time, or disable its row for a run that lands through Tower',
  }),
  Object.freeze({
    id: 'liveshare',
    name: 'Live sharing',
    detection: `the loader row for ${LIVESHARE_PACKAGE}, or a mounted liveshare service`,
    stance: CAPABILITY_STANCE.warnAllow,
    denialCost:
      'a shared session would lose viewing and bounded writing, and Tower would have no record of the share',
    remedy:
      'share with viewing only while Tower owns the repository, or end the share before a run that lands changes',
  }),
  Object.freeze({
    id: 'plugin-manager',
    name: 'Plugin manager',
    detection: `a visible ${PLUGIN_MANAGER_TOOL} tool, a mounted plugin manager service, or a loader row for ${PLUGIN_MANAGER_PACKAGE}`,
    stance: CAPABILITY_STANCE.warnAllow,
    denialCost:
      'the profile could no longer install or enable a plugin from a session, and Tower would have no record of the change',
    remedy: 'keep it available and install or enable plugins outside a Tower run',
  }),
  Object.freeze({
    id: 'auto-review',
    name: 'Auto review',
    detection: `a registered ${AUTO_PRESET} permission preset, or the loader row for ${AUTO_REVIEW_PACKAGE}`,
    stance: CAPABILITY_STANCE.warnAllow,
    denialCost:
      'Auto would be removed for every session, including unattended runs, and Tower does not replace the reviewer',
    remedy:
      'run Tower sessions under a permission preset other than Auto; if Auto stays selected, expect a denied worker call to fail closed',
    failureMode:
      "DSH pins a delegated child's approval policy to never, so a tool call Auto denies fails closed: there is no approval prompt and no escalation path for the worker",
  }),
])

// Which probe can see each capability. The loader inventory is authoritative for
// every row; the tool registry is authoritative for the plugin manager tool and
// the permission preset catalog for Auto; a named service only proves presence,
// never absence.
const CAPABILITY_PROBES = Object.freeze({
  forge: Object.freeze({ loader: Object.freeze({ ids: ['forge'], packages: [FORGE_PACKAGE] }), services: ['forge'] }),
  liveshare: Object.freeze({
    loader: Object.freeze({ ids: ['liveshare'], packages: [LIVESHARE_PACKAGE] }),
    services: ['liveshare'],
  }),
  'plugin-manager': Object.freeze({
    loader: Object.freeze({ ids: ['tool-plugin-manager', 'plugin-manager'], packages: [PLUGIN_MANAGER_PACKAGE] }),
    tools: Object.freeze({ name: PLUGIN_MANAGER_TOOL }),
    services: ['pluginManager'],
  }),
  'auto-review': Object.freeze({
    loader: Object.freeze({ ids: ['auto-review'], packages: [AUTO_REVIEW_PACKAGE] }),
    presets: Object.freeze({ name: AUTO_PRESET }),
  }),
})

/** @param {any} error */
function errorText(error) {
  return String(/** @type {any} */ (error)?.message ?? error).slice(0, 200)
}

/** @param {any} row */
function loaderLabel(row) {
  return typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : 'unnamed row'
}

/** @param {any} row */
function loaderRowDisabled(row) {
  return row?.disabled === true || row?.options?.disabled === true || row?.config?.disabled === true
}

/**
 * @param {any[]} rows
 * @param {{ ids?: string[], packages?: string[] }} spec
 * @returns {any}
 */
function findLoaderRow(rows, spec) {
  const ids = spec.ids ?? []
  const packages = spec.packages ?? []
  for (const row of rows) {
    if (!row) continue
    const id = typeof row.id === 'string' ? row.id : null
    const name = typeof row.name === 'string' ? row.name : null
    if (id && ids.includes(id)) return row
    if (name && packages.some((pkg) => name === pkg || name.startsWith(`${pkg}/`))) return row
  }
  return null
}

/** @param {any} rows */
function loaderProbe(rows) {
  if (!Array.isArray(rows)) return { available: false, reason: 'the loader inventory is unavailable' }
  return { available: true, rows }
}

/**
 * @param {any} ctx
 * @param {any} agent
 * @returns {any}
 */
function toolsProbe(ctx, agent) {
  let tools
  try {
    tools = ctx?.get?.('tools') ?? ctx?.tools
  } catch (error) {
    return { available: false, reason: `the tool registry could not be read (${errorText(error)})` }
  }
  if (!tools) return { available: false, reason: 'the tool registry service is not mounted' }
  if (typeof tools.definitions === 'function') {
    try {
      const definitions = tools.definitions(agent ?? undefined)
      const names = new Set(
        (Array.isArray(definitions) ? definitions : [])
          .map((definition) => definition?.name)
          .filter((name) => typeof name === 'string'),
      )
      return { available: true, has: (/** @type {string} */ name) => names.has(name) }
    } catch (error) {
      return { available: false, reason: `the tool registry view could not be read (${errorText(error)})` }
    }
  }
  if (typeof tools.get === 'function') {
    return { available: true, has: (/** @type {string} */ name) => Boolean(tools.get(name, agent ?? undefined)) }
  }
  return { available: false, reason: 'the tool registry service exposes no readable view' }
}

/**
 * @param {any} ctx
 * @param {any} agent
 * @returns {any}
 */
function permissionPresetsProbe(ctx, agent) {
  let presets
  try {
    presets = ctx?.get?.('permissionPresets')
  } catch (error) {
    return { available: false, reason: `the permission preset service could not be read (${errorText(error)})` }
  }
  if (!presets) return { available: false, reason: 'the permission preset service is not mounted' }
  let names = null
  try {
    if (Array.isArray(presets.names)) names = presets.names
    else if (typeof presets.names === 'function') names = presets.names()
    else if (typeof presets.catalog === 'function') {
      const catalog = presets.catalog()
      names = (catalog?.options ?? []).map((/** @type {any} */ option) => option?.value)
    }
  } catch (error) {
    return { available: false, reason: `the permission preset catalog could not be read (${errorText(error)})` }
  }
  if (!Array.isArray(names)) {
    return { available: false, reason: 'the permission preset service exposes no readable names' }
  }
  let selected = null
  try {
    selected = typeof presets.current === 'function' ? presets.current(agent?.session) : null
  } catch {
    selected = null
  }
  return {
    available: true,
    names: new Set(names.filter((/** @type {any} */ name) => typeof name === 'string')),
    selected,
  }
}

/** @param {any} ctx */
function serviceProbe(ctx) {
  return {
    available: typeof ctx?.get === 'function',
    /** @param {string} name */
    get(name) {
      try {
        return ctx.get(name)
      } catch {
        return undefined
      }
    },
  }
}

/**
 * One inventory row: the table fields plus what the probes could see.
 * @param {any} capability
 * @param {any} probes
 * @returns {any}
 */
function describeCapability(capability, probes) {
  const spec = CAPABILITY_PROBES[capability.id] ?? {}
  const evidence = []
  const unavailable = []
  let installed = false
  let present = false
  let selected = null
  let authoritative = 0

  if (spec.loader) {
    if (!probes.loader.available) {
      unavailable.push(probes.loader.reason)
    } else {
      authoritative += 1
      const row = findLoaderRow(probes.loader.rows, spec.loader)
      if (row) {
        installed = true
        const disabled = loaderRowDisabled(row)
        evidence.push(`loader row "${loaderLabel(row)}"${disabled ? ' (disabled)' : ''}`)
        if (!disabled) present = true
      }
    }
  }
  if (spec.tools) {
    if (!probes.tools.available) {
      unavailable.push(probes.tools.reason)
    } else {
      authoritative += 1
      if (probes.tools.has(spec.tools.name)) {
        installed = true
        present = true
        evidence.push(`the ${spec.tools.name} tool is visible`)
      }
    }
  }
  if (spec.presets) {
    if (!probes.presets.available) {
      unavailable.push(probes.presets.reason)
    } else {
      authoritative += 1
      if (probes.presets.names.has(spec.presets.name)) {
        installed = true
        present = true
        evidence.push(`the ${spec.presets.name} permission preset is registered`)
      }
      selected = probes.presets.selected === spec.presets.name
    }
  }
  for (const serviceName of spec.services ?? []) {
    if (!probes.services.available) {
      unavailable.push(`the ${serviceName} service cannot be looked up`)
      continue
    }
    if (probes.services.get(serviceName)) {
      installed = true
      present = true
      evidence.push(`the ${serviceName} service is mounted`)
    } else {
      unavailable.push(`the ${serviceName} service is not mounted, which does not prove the package is absent`)
    }
  }
  return {
    ...capability,
    present,
    installed,
    detectable: present || authoritative > 0,
    selected,
    evidence,
    unavailable,
  }
}

/**
 * The `foreign-capabilities` verdict over the inventory rows.
 * @param {any[]} capabilities
 * @returns {{ status: string, detail: string, action?: string }}
 */
export function foreignCapabilityStatus(capabilities) {
  const denied = capabilities.filter((capability) => capability.present && capability.stance === CAPABILITY_STANCE.deny)
  const warned = capabilities.filter(
    (capability) => capability.present && capability.stance === CAPABILITY_STANCE.warnAllow,
  )
  const compatible = capabilities.filter(
    (capability) =>
      capability.present &&
      (capability.stance === CAPABILITY_STANCE.compatibility ||
        capability.stance === CAPABILITY_STANCE.deploymentConfig),
  )
  const undetectable = capabilities.filter((capability) => !capability.detectable)
  const dormant = capabilities.filter((capability) => !capability.present && capability.installed)
  if (denied.length > 0) {
    return {
      status: DOCTOR_STATUS.fail,
      detail: `a capability recorded under a deny stance is available: ${denied
        .map((capability) => `${capability.name} (${capability.stance})`)
        .join(', ')}; doctor cannot enforce that stance`,
      action: DOCTOR_ACTION_COPY.foreignCapabilities,
    }
  }
  const parts = []
  if (warned.length > 0) {
    parts.push(
      `${warned.length} non-Tower ${warned.length === 1 ? 'capability is' : 'capabilities are'} available and allowed: ${warned
        .map((capability) => `${capability.name} (${capability.stance}): ${capability.denialCost}`)
        .join('; ')}`,
    )
  }
  // #188: a selected capability with a failure mode is the combination an
  // operator must see, not a footnote in the report. Auto review is the case:
  // DSH pins a delegated child's approval policy to never, so a denied worker
  // call has no escalation path.
  const selectedFailure = capabilities.filter(
    (capability) => capability.present && capability.selected === true && capability.failureMode,
  )
  if (selectedFailure.length > 0) {
    parts.push(
      `${selectedFailure.map((capability) => `${capability.name} is selected`).join(', ')}: ${selectedFailure
        .map((capability) => capability.failureMode)
        .join('; ')}`,
    )
  }
  if (undetectable.length > 0) {
    parts.push(
      `detection is unavailable for ${undetectable.length} known ${
        undetectable.length === 1 ? 'capability type' : 'capability types'
      }: ${undetectable
        .map((capability) => `${capability.name} (${capability.unavailable[0] ?? 'no readable source'})`)
        .join('; ')}`,
    )
  }
  if (parts.length > 0) {
    return { status: DOCTOR_STATUS.warn, detail: parts.join('; '), action: DOCTOR_ACTION_COPY.foreignCapabilities }
  }
  const notes = []
  if (compatible.length > 0) {
    notes.push(
      `supported and reported: ${compatible
        .map((capability) => `${capability.name} (${capability.stance})`)
        .join(', ')}`,
    )
  }
  if (dormant.length > 0) {
    notes.push(`installed but not mounted: ${dormant.map((capability) => capability.name).join(', ')}`)
  }
  return {
    status: DOCTOR_STATUS.pass,
    detail: `no non-Tower capability is available; ${capabilities.length} known ${
      capabilities.length === 1 ? 'type' : 'types'
    } checked${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
  }
}

/**
 * #188/#189: inventory the non-Tower capabilities that can orchestrate agents or
 * land changes, and report the stance Tower records for each one.
 * @param {{ ctx?: any, agent?: any, rows?: any[] | null }} input
 * @returns {{ check: any, report: any }}
 */
export function foreignCapabilityCheck({ ctx, agent, rows }) {
  const probes = {
    loader: loaderProbe(rows),
    tools: toolsProbe(ctx, agent),
    presets: permissionPresetsProbe(ctx, agent),
    services: serviceProbe(ctx),
  }
  const capabilities = FOREIGN_CAPABILITIES.map((capability) => describeCapability(capability, probes))
  const verdict = foreignCapabilityStatus(capabilities)
  return {
    check: check('foreign-capabilities', verdict.status, verdict.detail, verdict.action),
    report: {
      capabilities,
      present: capabilities.filter((capability) => capability.present).map((capability) => capability.id),
      installed: capabilities.filter((capability) => capability.installed).map((capability) => capability.id),
      notDetectable: capabilities.filter((capability) => !capability.detectable).map((capability) => capability.id),
      stances: Object.fromEntries(capabilities.map((capability) => [capability.id, capability.stance])),
    },
  }
}
