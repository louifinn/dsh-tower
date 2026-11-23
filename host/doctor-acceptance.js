// Extra read-only doctor checks kept out of host/doctor.js.
//
// #159: an artifact merge gate is a human acceptance of the committed tip, never a
// review; a pending acceptance is a warning, a recorded one stays visible.
// #F32/#F71: the state writer lock and the short-lived state-commit mutex are the two
// records that can wedge every mutation, so both are described here — by one module,
// with host/doctor.js under its file-size ceiling, and the doctor never reclaims a
// record or writes anything.
import { shapeFor } from '../domain/shapes/index.js'
import { CAPABILITY_STANCE, DOCTOR_STATUS } from '../domain/vocabulary.js'
import { lockTiming } from '../adapters/persistence.js'
import { inventoryOrphanWorktrees } from '../app/teardown.js'

// #F75: user-facing copy the component gate reads; it names the human decision, never a tool id.
const DOCTOR_ACTION_COPY = Object.freeze({
  artifactAcceptance:
    'the human accepts through the approval channel; no agent may self-accept and the merge gate refuses without it',
  // #187: an allowed checkout becomes visible here; the copy names the explicit sweep, never a tool id.
  orphanWorktrees:
    'run the worktree teardown step with its orphan option; it removes only clean checkouts inside the worktree root, never the main checkout or a path outside it, and nothing is removed automatically',
  // #188/#189: doctor reports the stance and never denies or removes a capability.
  foreignCapabilities:
    'keep the capability available and land changes through one path at a time, or turn its plugin row off for a run that must land changes through Tower; doctor only reports the stance and never denies or removes a capability',
  // #228: a full disk turns every durable write into a bare errno; name the volume and the intact document.
  diskSpace:
    'free space on the named volume (delete a stale worktree or an old archive file), or move the repository to a volume with room, then retry the operation that was refused; the document that was already on disk is unchanged',
})

/**
 * The `disk-space` doctor check over one free-space reading (#228). A reading the
 * runtime cannot take is a warning, never a pass: every durable write depends on it.
 * The passing row names the volume but no live byte count, so two snapshots of a
 * quiet repository stay identical; the failing row quotes the numbers.
 * @param {{ volume: string, floorBytes: number, freeBytes: number | null, error?: string }} reading
 */
export function diskSpaceCheck(reading) {
  const id = 'disk-space'
  const floor = `${Math.round(reading.floorBytes / 1048576)} MB`
  if (reading.freeBytes === null) return { id, status: 'warn', detail: `free space on volume ${reading.volume} is unreadable (${reading.error}); durable writes cannot be verified`, action: DOCTOR_ACTION_COPY.diskSpace }
  if (reading.freeBytes < reading.floorBytes) return { id, status: 'fail', detail: `volume ${reading.volume} has ${Math.round(reading.freeBytes / 1048576)} MB free, below the ${floor} every durable write needs`, action: DOCTOR_ACTION_COPY.diskSpace }
  return { id, status: 'pass', detail: `volume ${reading.volume} is above the ${floor} free-space floor` }
}

// #214: no directory enumeration means an empty shell cannot be proven empty, so the
// limitation is a warning, never a clean pass.
const SHELL_SCAN_UNSUPPORTED =
  'the store implementation does not expose directory enumeration, so empty leftover directories cannot be scanned and tower_teardown cannot clean empty review-checkout shells with this store'

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
 * #187/#214: report the checkouts and empty shells under the worktree root that
 * no mission, sandbox or review row records. Doctor is read-only — only the
 * explicit orphan sweep in `tower_teardown` removes anything — and a checkout git
 * records outside the root is named, never counted as a Tower orphan.
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
  // right now; it is read-only noise, but naming it keeps a bare pass honest.
  const inflight = inventory.inflight.length
  const inflightNote = inflight > 0 ? `; ${inflight} checkout(s) in flight (kept)` : ''
  // #214: a checkout git registers outside the root belongs to another tool; it is
  // named on a pass and never counted with the orphans or shells Tower can remove.
  const foreignNote =
    inventory.external.length > 0
      ? `; ${inventory.external.length} checkout(s) outside the worktree root are not managed by Tower, are not counted as its orphans and are never removed by Tower`
      : ''
  // #214: no directory enumeration is a limitation, never a clean pass.
  const capabilityNote = inventory.leftoverScanAvailable === false && !inventory.leftoverError ? SHELL_SCAN_UNSUPPORTED : ''
  const leftoverRows = inventory.leftovers.filter((entry) => entry.action === 'remove')
  const leftoverNames = leftoverRows.slice(0, 5).map((entry) => entry.name)
  const leftoverText =
    leftoverRows.length > 0
      ? `${leftoverRows.length} empty leftover ${leftoverRows.length === 1 ? 'directory' : 'directories'} under the worktree root (${leftoverNames.join(', ')}${leftoverRows.length > 5 ? ', ...' : ''})`
      : ''
  if (inventory.orphans.length === 0 && leftoverRows.length === 0) {
    if (inventory.leftoverError) return check('worktrees-orphans', 'warn', `could not scan the worktree root for empty leftover directories: ${inventory.leftoverError}${foreignNote}${inflightNote}`, DOCTOR_ACTION_COPY.orphanWorktrees)
    if (capabilityNote) return check('worktrees-orphans', 'warn', `${capabilityNote}${foreignNote}${inflightNote}`, DOCTOR_ACTION_COPY.orphanWorktrees)
    return check('worktrees-orphans', 'pass', `no unrecorded worktrees${foreignNote}${inflightNote}`)
  }
  if (inventory.orphans.length === 0) {
    return {
      id: 'worktrees-orphans',
      status: 'warn',
      detail: `${leftoverText}; run tower_teardown with its orphan option to remove empty unrecorded directories${foreignNote}${inflightNote}`,
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
    detail: `${inventory.orphans.length} unrecorded worktree(s) under the worktree root (${parts.join(', ')})${leftoverText ? `; ${leftoverText}` : ''}${inflightNote}${capabilityNote ? `; ${capabilityNote}` : ''}; run the worktree teardown step with its orphan option`,
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
 * The mutex covers one serialise→rename→read-back window, so a record that outlives
 * its process is a leftover fence, not a lock anyone waits out. Diagnostic only:
 * the audited recovery moves the record aside, and the live holder path always keeps
 * it (a writer may be between its last CAS and the rename). An unreadable mutex is a
 * warning, never a pass (#F71 R1): every state write keeps failing on it with
 * `state-commit-busy`.
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

// #188/#189: the inventory of non-Tower capabilities that can orchestrate agents or
// land changes: the stance, how doctor detects it, the cost of denying it. Tower denies
// none by default — denial breaks a workflow Tower does not replace while leaving no
// record of the change it refused — so doctor reports and never enforces, and a
// capability with no readable source is not detectable, never assumed absent.
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
    detection: `the loader row for ${LIVESHARE_PACKAGE}, or a mounted liveshareShares service`,
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

// Which probe can see each capability: the loader inventory is authoritative for every
// row, the tool registry for the plugin manager tool, the preset catalog for Auto; a
// named service only proves presence, never absence.
const CAPABILITY_PROBES = Object.freeze({
  forge: Object.freeze({ loader: Object.freeze({ ids: ['forge'], packages: [FORGE_PACKAGE] }), services: ['forge'] }),
  liveshare: Object.freeze({
    loader: Object.freeze({ ids: ['liveshare'], packages: [LIVESHARE_PACKAGE] }),
    services: ['liveshareShares'],
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
    (capability) => capability.present && capability.stance === CAPABILITY_STANCE.compatibility,
  )
  // `deployment-config` is a distinct stance: the capability is configured where
  // the deployment is built, not taught or accepted here. No row has it today,
  // but the pass detail must not describe it as "supported" when one appears.
  const deploymentConfigured = capabilities.filter(
    (capability) => capability.present && capability.stance === CAPABILITY_STANCE.deploymentConfig,
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
  if (deploymentConfigured.length > 0) {
    notes.push(
      `configured at deployment and reported: ${deploymentConfigured
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
 * #188/#189: read the loader's configured rows from the shapes the real cordis
 * `Loader` exposes. `entries()` is a generator over the live entry tree (it
 * already recurses into nested subtrees and yields `Entry` nodes whose
 * `options` is the configured row); `store` is a null-prototype dict keyed by
 * entry id; `root.data`/`subtree` are entry groups. Both `loader-conflicts` and
 * the foreign-capability inventory read this one list, and a group's nested
 * rows are flattened so a row behind an include is found.
 * @param {any} loader
 * @returns {any[] | null} the rows, or null when nothing readable is mounted
 */
export function readLoaderRows(loader) {
  if (!loader || typeof loader !== 'object') return null

  const rows = []
  const seen = new Set()

  /** @param {any} entry */
  const push = (entry) => {
    if (!entry || typeof entry !== 'object' || seen.has(entry)) return null
    seen.add(entry)
    const options =
      entry.options && typeof entry.options === 'object'
        ? entry.options
        : entry.data && typeof entry.data === 'object'
          ? entry.data
          : entry
    // A runtime Entry keeps the raw `disabled` option and exposes the effective
    // state on `entry.disabled`, which evaluates a `!!js` expression and an
    // owning disabled group. Report the effective state so a row disabled by
    // expression is not called mounted; a plain options row is already the row.
    let disabled = options.disabled
    if (entry !== options) {
      try {
        const effective = entry.disabled
        if (typeof effective === 'boolean') disabled = effective
      } catch {
        // a half-mounted entry can fail the getter; keep the raw option
      }
    }
    rows.push(disabled === options.disabled ? options : { ...options, disabled })
    return options
  }

  /** @param {any[]} data */
  const readGroup = (data) => {
    for (const entry of data) {
      const row = push(entry)
      if (entry?.subtree && typeof entry.subtree === 'object') readTree(entry.subtree)
      const children = Array.isArray(entry?.children)
        ? entry.children
        : row?.group === true && Array.isArray(row.config)
          ? row.config
          : null
      if (children) readGroup(children)
    }
  }

  /** @param {any} tree */
  const readTree = (tree) => {
    if (!tree || typeof tree !== 'object') return false
    if (typeof tree.entries === 'function') {
      try {
        const iterator = tree.entries()
        if (iterator && typeof iterator[Symbol.iterator] === 'function') {
          for (const entry of iterator) push(entry)
          return true
        }
      } catch {
        // fall through to the raw store/root shapes
      }
    }
    if (tree.store && typeof tree.store === 'object') {
      for (const entry of Object.values(tree.store)) {
        const row = push(entry)
        if (entry?.subtree && typeof entry.subtree === 'object') readTree(entry.subtree)
        else if (row?.group === true && Array.isArray(row.config)) readGroup(row.config)
      }
      return true
    }
    if (tree.root && Array.isArray(tree.root.data)) {
      readGroup(tree.root.data)
      return true
    }
    return false
  }

  return readTree(loader) ? rows : null
}

/**
 * F89: the `loader-conflicts` check over the rows `readLoaderRows` flattened.
 * The shipped `cordis.patch.yml` mounts the host plugin as a nested row
 * (`id: tower-host`, `name: dsh-tower`) inside the mandatory `tower` group
 * anchor (`name: cordis:group`, `group: true`), so the anchor and the rows
 * nested under it are Tower itself, never a conflict. A `dsh-tower` row outside
 * that anchor is a second copy of the plugin. The child list is the same
 * `children`/`config` field the reader flattens, so this adds no new assumption
 * about the loader's internal shape. A disabled row is installed but not
 * mounted, so it is never a live second copy: the remedy this check prints
 * ("remove or disable") has to clear the check after the restart, which is why
 * only enabled rows are counted. `readLoaderRows` stamps the effective disabled
 * state on every flattened row, so the module's single predicate decides.
 * @param {any[]} rows
 */
export function loaderConflictCheck(rows) {
  const towerRows = rows.filter((row) => row && row.name === 'dsh-tower' && !loaderRowDisabled(row))
  const owned = new Set()
  /** @param {any} row */
  const collect = (row) => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || owned.has(row.id)) return
    owned.add(row.id)
    const children = Array.isArray(row.children)
      ? row.children
      : row.group === true && Array.isArray(row.config)
        ? row.config
        : null
    if (children) for (const child of children) collect(child)
  }
  collect(rows.find((row) => row && row.id === 'tower' && row.group === true))
  // Tower always mounts exactly one enabled `dsh-tower` row, so a lone enabled
  // row cannot be a second copy: older layouts mounted it top-level (id
  // `tower`) before the shipped group anchor existed. A disabled row never
  // mounts, so only a second enabled row is a duplicate.
  if (towerRows.length <= 1) {
    return check('loader-conflicts', 'pass', 'no conflicting dsh-tower loader rows')
  }
  const foreign = towerRows.filter((row) => !owned.has(row.id))
  const conflicts = foreign.length > 0 ? foreign : towerRows
  return check(
    'loader-conflicts',
    'fail',
    `another loader row in this repository also resolves to "dsh-tower" (${conflicts
      .map((row) => row.id ?? '?')
      .join(', ')}); remove or disable the duplicate row`,
    "remove or disable the duplicate loader row in the profile's cordis.patch.yml, then restart DSH and re-run the environment health check",
  )
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
