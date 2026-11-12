// Tower tool registration aggregators (W5-A).
//
// The Host entry and the optional capability rows call the functions here; the
// runtime/dispatch primitive lives in `tool-runtime.js`, the cross-cutting
// observers in `tool-observers.js`, and `tool-registry.js` re-exports this
// module's stable public names. Registration order in `registerCoreTowerTools`
// is the shipped tool order and must not change.
import {
  PARENT_STATUS_OK,
  ROSTER_INACTIVE_STATES,
} from '../domain/vocabulary.js'
import {
  requireKnownActor,
  requireTowerActor,
} from './authorization.js'
import { resolveRepo } from '../adapters/git.js'
import { resolveTowerConfig, runtimeConfig } from './config.js'
import { isConfigResolutionError } from './authorization.js'
import { reviewUnavailable } from '../domain/integration/review.js'
import { runDoctor } from './doctor.js'
import { createHmrBridge } from './hmr.js'
import { assertRuntimePreconditions } from './presets.js'
import { readStateLock } from '../adapters/store.js'
import { lockTiming } from '../adapters/persistence.js'
import { acquireLease, releaseLease, inspectLeases } from '../adapters/leases.js'
import { importLegacySnapshot, validateLegacyMap } from '../adapters/legacy.js'
import { registerInspectTool } from '../tools/inspect.js'
import { registerRecoverTool } from '../tools/recover.js'
import { registerTestTool } from '../tools/test.js'
import { registerBatchTool } from '../tools/batch.js'
import { registerResourceTool } from '../tools/resource.js'
import { registerImportTool } from '../tools/import.js'
import { registerReloadTool } from '../tools/reload.js'
import { registerInitTool } from '../tools/init.js'
import { registerPlanTool } from '../tools/plan.js'
import { registerMissionTool } from '../tools/mission.js'
import { registerInterruptTool } from '../tools/interrupt.js'
import { registerSendTool } from '../tools/send.js'
import { registerInboxTool } from '../tools/inbox.js'
import { registerReviewTool } from '../tools/review.js'
import { registerMergeTool } from '../tools/merge.js'
import { registerRebaseTool } from '../tools/rebase.js'
import { registerTeardownTool } from '../tools/teardown.js'
import { registerSpawnTool } from '../tools/spawn.js'
import { registerCompleteTool } from '../tools/complete.js'
import { registerFindingTool } from '../tools/finding.js'
import { summarize as summarizeBatch } from '../domain/batch.js'
import { assertPorts } from '../ports/index.js'
import {
  COMPONENT_TOOLS,
  componentEnabled,
  componentReport,
  holdComponent,
  disabledReason,
  presetAvailable,
  PRESET_ROW_COMPONENTS,
} from './capability-registry.js'
import { createDefaultDeps } from '../adapters/default.js'
import {
  actorFor,
  checkSendRate,
  createTower,
  define,
  definedToolCount,
  enqueueSpawn,
  ensureRepository,
  openTower,
  recordSpawnSuccess,
  recordSpawnThrottle,
  recordToolRegistration,
  runtimeState,
  spawnBackoffState,
  spawnBackoffView,
  textOf,
  watchedRepos,
} from './tool-runtime.js'
import {
  interruptRosterAgent,
  observeActivity,
  ownershipView,
  runMissionDiscovery,
  verifyBatchReceiptFiles,
} from './tool-observers.js'

/**
 * Register the mandatory Tower host surface (#121).
 *
 * The host owns planning, mode integration, the health contract
 * (`tower_doctor`) and the recovery escape (`tower_recover`); neither is a
 * component and neither can be switched off. The optional capabilities
 * (batch/import/leases/tests/reload) are registered by their own entry points
 * (`registerBatchCapability`, ...), so switching a component row off removes
 * exactly that capability while the host keeps working.
 */
export function registerCoreTowerTools(ctx, options = {}) {
  runtimeState.workspaceHook = options.workspace ?? null
  runtimeState.hmrBridge = options.hmrBridge ?? null
  // #121/#122: capability tools are part of this build even while their
  // component row is off. A row's entry point only runs when the row is on, so
  // record the declared capability names here — before any row gates
  // registration — and the concept budget reports the full 29-tool build
  // surface in every profile. `componentReport` is what names the subset that
  // is actually mounted; this count never shrinks because a user switched a
  // component off.
  for (const toolIds of Object.values(COMPONENT_TOOLS)) {
    for (const toolId of toolIds) recordToolRegistration(toolId)
  }
  // #69: the host entry (index.js) is the composition root. When it supplies the
  // port set, adopt it — validated once — instead of constructing a second set
  // here. Tests/embedders that omit deps fall back to one lazily built set.
  // #75: the event port is bound here to the live Cordis emitter; emitting is
  // best effort so a listener can never fail the tool that produced the fact.
  const baseDeps = options.deps ? assertPorts(options.deps) : (runtimeState.deps ?? createDefaultDeps())
  runtimeState.deps = {
    ...baseDeps,
    // #140: the merge gate lives in the pure domain, which cannot read the
    // component registry. Publish the two probes it needs on the port bag the
    // store already receives, so `evaluateGate` can name a disabled row as the
    // cause instead of guessing from config.
    components: {
      enabled: (id) => componentEnabled(id),
      reason: (id) => disabledReason(id),
      // Preset rows are declarative and invisible to the code registry, so the
      // synchronous `enabled` probe cannot answer for them. Callers that gate a
      // shape read this async probe, which returns null when `agentPresets` is
      // absent (unknown, not disabled).
      available: async (id) => {
        const presetId = PRESET_ROW_COMPONENTS[id]
        if (presetId) return presetAvailable(ctx, presetId)
        return componentEnabled(id)
      },
    },
    events: {
      emit(name, payload) {
        try {
          ctx.emit?.(name, payload)
        } catch {
          // events are an optional side channel; never fail a tool for them
        }
      },
    },
  }
  // A lightweight roster watchdog: the authoritative activity comes from the
  // subagents catalog; a missing observation after spawn.staleMs is marked
  // stale (never silently treated as stopped) and blocks merge via the gate.
  const watchMs = Math.max(1000, Number(runtimeConfig().mode?.heartbeatMs) || 10000)
  const timer = setInterval(() => {
    void (async () => {
      try {
        if (!ctx.get('subagents')) return
        for (const repoRoot of [...watchedRepos()]) {
          const tower = await openTower(repoRoot)
          const view = await tower.rosterView()
          const live = view.roster.filter((entry) => !ROSTER_INACTIVE_STATES.includes(entry.state))
          if (live.length === 0) { watchedRepos().delete(repoRoot); continue }
          const parents = [...new Set(live.map((entry) => entry.parentSessionId).filter(Boolean))]
          if (parents.length === 0) continue
          const { activity, parentStatus } = await observeActivity(ctx, tower)
          const authoritative = parents.every((parent) => parentStatus[parent] === PARENT_STATUS_OK)
          await tower.sweepRoster({
            staleMs: Number(tower.config.spawn?.staleMs) || 0,
            activity,
            authoritative,
          })
        }
      } catch {
        // watchdog failures are best effort; tools still re-check on demand
      }
    })()
  }, watchMs)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))
  registerInitTool(ctx, { openTower, define, actorFor, requireTowerActor, workspaceHook: runtimeState.workspaceHook, ensureRepository, resolveRepo, runtimeConfig })

  // #121: planning validates the mounted component rows as well as the presets,
  // so a review gate without its reviewer row is refused before work starts.
  registerPlanTool(ctx, { openTower, define, actorFor, requireTowerActor, assertPresetsAvailable: assertRuntimePreconditions })

  registerMissionTool(ctx, { openTower, define, actorFor, requireKnownActor })

  // #163 Phase 3: the five read-only views share one state and three arguments;
  // one tool with a view enum replaces five descriptions and five schemas.
  registerInspectTool(ctx, {
    define,
    openTower,
    workspaceHook: runtimeState.workspaceHook,
    spawnBackoffView,
    observeActivity,
    componentReport,
    ownershipView,
    createTower,
    resolveRepo,
    runtimeConfig,
    resolveTowerConfig,
    isConfigResolutionError,
    runDoctor,
    // #84/#122: the doctor view reports the full registered surface. It is always
    // registered itself, and it is the reporter that names a disabled component.
    surface: () => ({ tools: definedToolCount() }),
  })

  // #131: the lease precondition needs the row state, and the app layer may not
  // import the registry, so the probe travels with the other spawn deps.
  registerSpawnTool(ctx, { openTower, define, actorFor, requireTowerActor, enqueueSpawn, observeActivity, spawnBackoffState, recordSpawnThrottle, recordSpawnSuccess, runMissionDiscovery, textOf, inspectLeases, leaseComponent: () => ({ enabled: componentEnabled('tower-leases'), reason: disabledReason('tower-leases') }) })

  registerInterruptTool(ctx, { openTower, define, actorFor, requireTowerActor, interruptRosterAgent })


  registerSendTool(ctx, { openTower, define, actorFor, checkSendRate })

  registerInboxTool(ctx, { openTower, define })

  registerCompleteTool(ctx, { openTower, define, runMissionDiscovery })

  registerFindingTool(ctx, { openTower, define, actorFor, requireKnownActor })


  // #M39: `review.mode:off` is the one configuration that removes tower_review
  // from the mounted surface. The name is still recorded before the decision so
  // the concept budget keeps measuring the build surface (the same rule the
  // shipped-off component rows follow), and status/doctor report the mode as
  // intentionally unavailable. A repository layer cannot re-enable the tool
  // (host/config.js refuses that); the profile owns the mounted surface.
  recordToolRegistration('tower_review')
  if (!reviewUnavailable(runtimeConfig())) registerReviewTool(ctx, { openTower, define, actorFor })

  registerMergeTool(ctx, { openTower, define, actorFor, requireTowerActor, observeActivity })

  registerRebaseTool(ctx, { openTower, define, actorFor, requireTowerActor, observeActivity })

  registerTeardownTool(ctx, { openTower, define, actorFor, requireTowerActor, observeActivity })

  // #122: the recovery escape is registered for every configuration. The lock it
  // repairs can be left behind by any crashed mutation, so an off state would be
  // worse than uninstalling the plugin.
  registerRecoverTool(ctx, { openTower, define, actorFor, requireTowerActor, readStateLock, lockTiming })
}

/** Evidence batches — the `tower-batch` component. */
export function registerBatchCapability(ctx) {
  registerBatchTool(ctx, { openTower, define, actorFor, requireTowerActor, summarizeBatch, verifyBatchReceiptFiles })
}

/** Advisory leases — the `tower-leases` component. */
export function registerLeasesCapability(ctx) {
  registerResourceTool(ctx, { openTower, define, actorFor, requireTowerActor, acquireLease, releaseLease, inspectLeases })
}

/** Legacy import and its audit map — the `tower-import` component. */
export function registerImportCapability(ctx) {
  registerImportTool(ctx, { openTower, define, actorFor, requireTowerActor, importLegacySnapshot, validateLegacyMap })
}

/** Declared test discovery — the `tower-tests` component. */
export function registerTestsCapability(ctx) {
  registerTestTool(ctx, { openTower, define, actorFor, requireKnownActor, runMissionDiscovery })
}

/**
 * Dev hot reload — the `tower-hmr` component (shipped off).
 * The returned bridge is the one `/tower reload` and `tower_mode` report.
 */
export function registerHmrCapability(ctx, options = {}) {
  const dev = runtimeConfig().dev ?? {}
  const bridge =
    options.bridge ??
    runtimeState.hmrBridge ??
    createHmrBridge(ctx, {
      requiredIds: dev.reloadRequiredIds,
      delayMs: dev.reloadDelayMs,
      logger: ctx.logger ?? console,
    })
  registerReloadTool(ctx, { openTower, define, actorFor, requireTowerActor, sharedHmrBridge: bridge, runtimeConfig, createHmrBridge })
  return bridge
}

/**
 * Register every optional capability in-process. This is the aggregate used by
 * tests and embedders; the shipped profile mounts the capability rows instead,
 * so one row can be off without removing the rest.
 */
export function registerAllCapabilities(ctx, options = {}) {
  for (const id of ['tower-batch', 'tower-import', 'tower-leases', 'tower-tests', 'tower-hmr']) holdComponent(ctx, id)
  registerBatchCapability(ctx)
  registerImportCapability(ctx)
  registerLeasesCapability(ctx)
  registerTestsCapability(ctx)
  registerHmrCapability(ctx, options)
}

/**
 * Backwards-compatible aggregate: the mandatory host surface plus every
 * optional capability. Tests and embedders call this; the shipped composition
 * calls `registerCoreTowerTools` and lets the component rows register their own
 * capability.
 */
export function registerTowerTools(ctx, options = {}) {
  registerCoreTowerTools(ctx, options)
  registerAllCapabilities(ctx, options)
}
