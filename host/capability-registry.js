// Runtime view of the optional component rows (#121).
//
// The component rows in `cordis.patch.yml` are separate loader entries. A
// capability row that is off simply never runs `apply()`, so the host cannot
// ask a disabled plugin to report itself. This module is the small shared
// registry the capability entry points write into and the read-only reporters
// (`tower_status`, `tower_doctor`) read back. An absent entry is a disabled
// component, reported with the exact "disabled by component <id>" wording the
// acceptance contract asks for, never a silent absence.
//
// The registry is process-local and reference-counted: a capability entry point
// registers on apply and unregisters through its `ctx.effect` disposer, so an
// HMR reload cannot leave a stale "enabled" claim behind. It is coordination,
// not state: no file is written and no tool result depends on it except the
// capability report itself.

/** The visible optional component rows, in `cordis.patch.yml` order. */
export const TOWER_COMPONENT_IDS = Object.freeze([
  'tower-skills',
  'tower-batch',
  'tower-import',
  'tower-leases',
  'tower-tests',
  'tower-hmr',
  'preset-tower-reviewer',
])

/** Tool ids each code component owns; the preset row owns no tool. */
export const COMPONENT_TOOLS = Object.freeze({
  'tower-skills': Object.freeze([]),
  'tower-batch': Object.freeze(['tower_batch']),
  'tower-import': Object.freeze(['tower_import_legacy', 'tower_legacy_map']),
  'tower-leases': Object.freeze(['tower_resource']),
  'tower-tests': Object.freeze(['tower_test']),
  'tower-hmr': Object.freeze(['tower_reload']),
  'preset-tower-reviewer': Object.freeze([]),
})

/** id -> number of live registrations (redelivery/HMR can overlap briefly). */
const active = new Map()

/**
 * Mark one component as mounted. IDEMPOTENT per call site: the reference count
 * lets a brief double-mount during HMR stay "enabled" until the last disposer
 * runs.
 * @param {string} id
 */
export function registerComponent(id) {
  if (!TOWER_COMPONENT_IDS.includes(id)) throw new TypeError(`unknown Tower component: ${id}`)
  active.set(id, (active.get(id) ?? 0) + 1)
}

/** Drop one registration; a component is disabled when its count reaches 0. */
export function unregisterComponent(id) {
  const count = active.get(id) ?? 0
  if (count <= 1) active.delete(id)
  else active.set(id, count - 1)
}

/** True when a code component entry point is currently mounted. */
export function componentEnabled(id) {
  return (active.get(id) ?? 0) > 0
}

/** Register/unregister a component around one plugin's lifetime. */
export function holdComponent(ctx, id) {
  registerComponent(id)
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => unregisterComponent(id))
  }
  return () => unregisterComponent(id)
}

/** Test hook: process-local registry state must be reset per fixture. */
export function __testResetComponentRegistry() {
  active.clear()
  sharedHmrBridge = null
}

/** The exact wording the acceptance contract uses for a missing capability. */
export function disabledReason(id) {
  return `disabled by component ${id}`
}

/** Reviewer-preset availability from the optional agent-presets service. */
async function reviewerPresetAvailable(ctx) {
  const service = ctx?.get?.('agentPresets')
  if (!service || typeof service.list !== 'function') return null
  try {
    const presets = await service.list()
    return Array.isArray(presets) && presets.some((entry) => String(entry?.id) === 'tower-reviewer')
  } catch {
    return null
  }
}

/**
 * Report every optional component as enabled or disabled. The reviewer preset
 * is not a code entry point: its row mounts an agent preset, so availability is
 * read from `agentPresets` and reported as unknown (omitted) when that service
 * is absent, exactly as the doctor's preset check does.
 *
 * @param {any} ctx
 * @returns {Promise<{ enabled: string[], disabled: Array<{ id: string, reason: string }> }>}
 */
export async function componentReport(ctx) {
  const enabled = []
  const disabled = []
  for (const id of TOWER_COMPONENT_IDS) {
    if (id === 'preset-tower-reviewer') {
      const available = await reviewerPresetAvailable(ctx)
      if (available === false) disabled.push({ id, reason: disabledReason(id) })
      else if (available === true) enabled.push(id)
      continue
    }
    if (componentEnabled(id)) enabled.push(id)
    else disabled.push({ id, reason: disabledReason(id) })
  }
  return { enabled, disabled }
}

// A capability plugin's `ctx.provide()` is visible to its descendants, not to
// the parent host context that owns `/tower` and `tower_mode`. The hot-reload
// bridge is a process singleton, so it is shared here rather than through a
// service lookup the host could not see.
let sharedHmrBridge = null

/** Publish the mounted tower-hmr bridge for the host entry to read. */
export function setHmrBridge(bridge) {
  sharedHmrBridge = bridge
}

/** Clear the publication when the component unloads; never clear another bridge. */
export function clearHmrBridge(bridge) {
  if (sharedHmrBridge === bridge) sharedHmrBridge = null
}

/** The mounted tower-hmr bridge, or null when the component row is off. */
export function currentHmrBridge() {
  return sharedHmrBridge
}

/** One-line form used by `tower_status` and the doctor's `components` check. */
export function componentSummary(report) {
  if (!report || report.disabled.length === 0) {
    return `${report?.enabled?.length ?? 0} optional component(s) enabled`
  }
  return report.disabled.map((entry) => entry.reason).join('; ')
}
