// tower_inspect view: status — dashboard and mission detail.
import { SCHEMAS, output } from '../../domain/contracts/outputs.js'
import { TowerToolError, classifyError } from '../../domain/errors.js'
import { SCHEMA_VERSION } from '../../domain/mission.js'
import { inspectStateVersion } from '../../domain/state.js'
import { StatusInput } from '../../domain/contracts/tool-inputs/index.js'
import {
  PARENT_STATUS_OK,
  ROSTER_ACTIVITY,
  ROSTER_INACTIVE_STATES,
  isMarkdownFormat,
  isReservedState,
  isWorkerRole,
} from '../../domain/vocabulary.js'
import { isTerminal } from '../../domain/shapes/index.js'
import { agentRowSummary, projectFields, rowChangedSince, selectAgentActivity } from '../../domain/read/views.js'
import { rosterEntryStale } from '../../domain/collab/roster.js'
import { archiveView } from '../../app/archive.js'
import { reviewPolicyView } from '../../domain/integration/review.js'

/** #207: the bounded activity tail one agent-status call may scan. */
const STATUS_ACTIVITY_TAIL = 200
/** #207: default number of activity summaries returned for one agent. */
const STATUS_AGENT_ACTIVITY_DEFAULT = 5

/**
 * Read the on-disk state version without loading, migrating, or locking it — the
 * same read-only inspection `tower_doctor` performs (F40).
 * @param {any} tower
 * @returns {Promise<{ raw: any, info: any }>}
 */
async function inspectOnDiskState(tower) {
  try {
    const raw = await tower.deps.store.readJson(tower.paths.state)
    return { raw, info: inspectStateVersion(raw, tower.paths.state) }
  } catch (error) {
    return {
      raw: null,
      info: {
        status: 'invalid',
        currentVersion: null,
        supportedVersion: SCHEMA_VERSION,
        migrations: [],
        message: `tower state could not be inspected: ${String(error?.message ?? error)}`,
      },
    }
  }
}

/**
 * F40: a public read-only row must report an unreadable state file instead of
 * failing in the handler. The dashboard keeps its required shape (empty
 * collections) and adds the classified load error plus the on-disk schema, so a
 * `newer` or corrupt `state.json` is diagnosable. The helper only reads: it
 * never migrates, writes, or creates a backup.
 * @param {any} tower
 * @param {any} args
 * @param {{ error: any, components: any, boardPath: string, mode: any, review: any }} context
 */
async function degradedStatus(tower, args, { error, components, boardPath, mode, review }) {
  const { raw, info } = await inspectOnDiskState(tower)
  // A corrupt document has no base/revision to trust; the branch this checkout
  // resolved from is still a useful, non-fabricated fallback.
  const base = typeof raw?.base === 'string' && raw.base.length > 0 ? raw.base : tower.branch ?? ''
  const revision = Number.isInteger(raw?.revision) && raw.revision >= 0 ? raw.revision : 0
  const common = {
    ok: false,
    repoRoot: tower.root,
    commonDir: tower.commonDir,
    statePath: tower.paths.state,
    base,
    revision,
    counts: {},
    missions: [],
    activity: [],
    stateError: classifyError(error).message,
    stateSchema: {
      currentVersion: info.currentVersion,
      supportedVersion: info.supportedVersion,
      migrations: info.migrations ?? [],
      status: info.status,
      ...(info.message ? { message: info.message } : {}),
    },
    boardPath,
    mode,
    review,
    components,
  }
  if (args.missionId) return { ...common, missionId: args.missionId, detail: null }
  return { ...common, total: 0, offset: 0, nextOffset: null }
}

/**
 * #210: a terminal mission's checkout is a diagnostic for the doctor, not a
 * live-work fact, so it carries no dirty fields. A missing path has none either.
 * @param {any} mission
 * @returns {boolean}
 */
function missionTerminal(mission) {
  try {
    return isTerminal(mission.kind, mission.status)
  } catch {
    // An unknown kind cannot be proven non-terminal: be silent, never throw.
    return true
  }
}

/**
 * #210: at most one bounded `git status` read per non-terminal mission. Failures
 * are reported as unknown (null) instead of failing the whole dashboard.
 * @param {any} tower
 * @param {any} mission
 * @returns {Promise<{ worktreeDirty?: boolean | null, uncommittedPathCount?: number | null }>}
 */
async function worktreeDiagnostics(tower, mission) {
  const path = mission?.worktree?.path
  if (typeof path !== 'string' || path.length === 0) return {}
  if (missionTerminal(mission)) return {}
  try {
    const vcs = tower.deps?.vcs
    /** @type {unknown} */
    let changes
    if (vcs && typeof vcs.worktreeChanges === 'function') {
      changes = await vcs.worktreeChanges(path)
    } else {
      const porcelain = await tower.git(path, ['status', '--porcelain'])
      changes = String(porcelain ?? '')
        .split('\n')
        .filter((line) => line.length > 0)
    }
    const count = Array.isArray(changes) ? changes.length : 0
    return { worktreeDirty: count > 0, uncommittedPathCount: count }
  } catch {
    return { worktreeDirty: null, uncommittedPathCount: null }
  }
}

/**
 * @param {any} tower
 * @param {any[]} missions
 * @returns {Promise<any[]>}
 */
async function withWorktreeDiagnostics(tower, missions) {
  return Promise.all(
    missions.map(async (mission) => {
      const diagnostics = await worktreeDiagnostics(tower, mission)
      return Object.keys(diagnostics).length > 0 ? { ...mission, ...diagnostics } : mission
    }),
  )
}

/**
 * #207: one agent's status is its roster row plus a bounded activity tail — never
 * the dashboard page. It reuses the same catalog-observation/staleness rule as
 * the roster view, and the state portrait is truthful even when the subagent
 * catalog is unavailable (activity `unknown`, `observed: false`).
 *
 * @param {any} ctx
 * @param {any} tower
 * @param {any} args
 * @param {any} state loaded state
 * @param {{ observeActivity?: (ctx: any, tower: any) => Promise<any> }} deps
 * @returns {Promise<Record<string, any>>}
 */
async function agentStatusView(ctx, tower, args, state, deps) {
  const needle = args.agent
  const entry = (state.roster ?? []).find(
    (row) =>
      row.name === needle ||
      (row.agentId !== null && row.agentId !== undefined && String(row.agentId) === needle),
  )
  if (!entry) {
    throw new TowerToolError(
      'invalid-argument',
      `unknown roster agent "${needle}"; omit agent for the dashboard or use tower_inspect view:"roster" without agent`,
    )
  }
  let observed
  let parentKnown = false
  try {
    const observedView = await deps.observeActivity?.(ctx, tower)
    observed = observedView?.activity?.[String(entry.agentId)]
    parentKnown = observedView?.parentStatus?.[entry.parentSessionId] === PARENT_STATUS_OK
  } catch {
    // Observation is best effort: the persisted row and its log stay reportable.
  }
  const staleMs = Number(tower.config.spawn?.staleMs) || 0
  const stale = rosterEntryStale(entry, { observed, parentKnown, staleMs, now: Date.now() })
  const mission = (state.missions ?? []).find((row) => row.id === entry.missionId) ?? null
  const log = await tower.deps.store.readActivityTail(tower.paths.activity, STATUS_ACTIVITY_TAIL)
  const tail = Number.isInteger(Number(args.tail)) && Number(args.tail) > 0
    ? Number(args.tail)
    : STATUS_AGENT_ACTIVITY_DEFAULT
  return {
    revision: state.revision,
    repoRoot: tower.root,
    commonDir: tower.commonDir,
    statePath: tower.paths.state,
    agent: agentRowSummary(entry, {
      activity: observed ?? (parentKnown ? ROSTER_ACTIVITY.missing : ROSTER_ACTIVITY.unknown),
      observed: observed !== undefined,
      stale,
    }),
    mission: mission
      ? {
          id: mission.id,
          status: mission.status,
          title: mission.title ?? null,
          kind: mission.kind ?? null,
          owner: mission.owner ?? null,
        }
      : null,
    activity: selectAgentActivity(log, entry, tail),
  }
}

/**
 * @param {any} ctx
 * @param {{
 *   define: import('../../types/index.js').DefineTool,
 *   openTower: any,
 *   workspaceHook: any,
 *   spawnBackoffView: any,
 *   observeActivity: any,
 *   componentReport: (ctx: any) => Promise<{ enabled: string[], disabled: Array<{ id: string, reason: string }> }>,
 *   ownershipView?: (ctx: any, tower: any, exec: any) => Promise<any>,
 * }} deps
 */
export async function runStatusView(ctx, args, exec, deps) {
  const { define, workspaceHook, spawnBackoffView, observeActivity, componentReport, ownershipView } = deps
      const tower = await deps.openTower(args.repoRoot)
      // #121: report the mounted optional components, including the exact
      // "disabled by component <id>" reason. A capability that is off must be a
      // visible fact of the dashboard, never a silent absence from the tools.
      const components = await componentReport(ctx)
      const boardPath = tower.boardFile()
      const mode = workspaceHook?.modeInfo?.(exec) ?? null
      // #M39: the resolved review policy (`{mode, available, required, detail}`)
      // is a first-class dashboard fact. In `off` the detail says review is
      // intentionally unavailable rather than leaving it as a silent absence.
      const review = reviewPolicyView(tower.config)
      let statusState
      try {
        statusState = await tower.load()
      } catch (error) {
        // A missing state file is an initialization error, not an unreadable
        // document: keep failing with `not-initialized` so callers run
        // tower_init. Every other load failure (a newer/corrupt schema, a
        // failed migration) degrades to an on-disk diagnostic instead (F40).
        if (error?.code === 'not-initialized') throw error
        return degradedStatus(tower, args, { error, components, boardPath, mode, review })
      }
      // #207: `status {agent}` is one roster row plus its bounded activity, not
      // the dashboard. It is handled before the page/detail branches so it can
      // never accidentally include the whole mission table.
      if (args.agent !== undefined) {
        return agentStatusView(ctx, tower, args, statusState, { observeActivity })
      }
      const ownership = (await ownershipView?.(ctx, tower, exec)) ?? null
      const inflight = (statusState.roster ?? []).filter(
        (entry) => isWorkerRole(entry.role) && !ROSTER_INACTIVE_STATES.includes(entry.state) && !isReservedState(entry.state),
      ).length
      const spawn = spawnBackoffView(tower.root, tower.config.spawn?.maxLiveWorkers, inflight)
      if (args.missionId) {
        const [status, detail] = await Promise.all([
          tower.status({ missionIds: [args.missionId] }),
          tower.missionDetail(args.missionId),
        ])
        const filtered = status.missions.filter((mission) => mission.id === args.missionId)
        // #210: one bounded worktree read per mission per call — the mission row
        // and the mission detail describe the same checkout, so share the probe.
        const diagnostics = await worktreeDiagnostics(tower, detail?.mission ?? filtered[0])
        const missions = Object.keys(diagnostics).length > 0
          ? filtered.map((mission) => ({ ...mission, ...diagnostics }))
          : filtered
        let enrichedDetail = detail
        if (detail?.mission && Object.keys(diagnostics).length > 0) {
          enrichedDetail = { ...detail, mission: { ...detail.mission, ...diagnostics } }
        }
        return {
          ...status,
          missions: projectFields(missions, args.fields),
          missionId: args.missionId,
          detail: enrichedDetail,
          boardPath,
          mode,
          spawn,
          review,
          components,
          ownership,
        }
      }
      const state = await tower.load()
      const index = await tower.archiveIndex()
      const allActiveIds = state.missions.map((mission) => mission.id)
      // #211: sinceRevision filters before paging, the same way the dashboard
      // pages ids — otherwise `total`/`nextOffset` describe rows not returned.
      // Mission rows carry the per-row stamp written by the spawn/roster use
      // cases; archived summaries have none and are therefore excluded.
      const sinceProvided = args.sinceRevision !== undefined
      const activeIds = sinceProvided
        ? allActiveIds.filter((id) => rowChangedSince(state.missions.find((mission) => mission.id === id), args.sinceRevision))
        : allActiveIds
      const archivedIdsRaw = index.ok
        ? index.missions.map((entry) => entry.id).filter((id) => !allActiveIds.includes(id))
        : []
      const archivedIds = sinceProvided
        ? archivedIdsRaw.filter((id) => rowChangedSince(index.missions.find((entry) => entry.id === id), args.sinceRevision))
        : archivedIdsRaw
      // Hot state pages first, then archived summaries on demand (#73).
      const ids = args.includeArchived === true ? [...activeIds, ...archivedIds] : activeIds
      const total = ids.length
      const offset = typeof args.offset === 'number' && Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0
      const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.max(1, Math.min(100, args.limit)) : 20
      const pageIds = ids.slice(offset, offset + limit)
      const status = await tower.status({ missionIds: pageIds, includeArchived: args.includeArchived === true })
      let page = status.missions
      if (args.includeGate === true) {
        const { activity, parentStatus } = await observeActivity(ctx, tower)
        page = await Promise.all(
          page.map(async (mission) => {
            try {
              const gate = await tower.evaluateGate({ missionId: mission.id, activity, parentStatus })
              return {
                ...mission,
                gate: {
                  ok: gate.ok,
                  blockers: (gate.blockers ?? []).map((blocker) => ({ code: blocker.code, detail: blocker.detail })),
                },
              }
            } catch (error) {
              return { ...mission, gate: { ok: false, error: classifyError(error).message } }
            }
          }),
        )
      }
      const result = {
        ...status,
        missions: projectFields(await withWorktreeDiagnostics(tower, page), args.fields),
        total,
        offset,
        nextOffset: offset + page.length < total ? offset + page.length : null,
        boardPath,
        mode,
        spawn,
        review,
        components,
        ownership,
      }
      // The roster count describes the same filtered view as `missions`.
      if (sinceProvided) {
        result.roster = (state.roster ?? []).filter((row) => rowChangedSince(row, args.sinceRevision)).length
      }
      if (isMarkdownFormat(args.format)) {
        const state = await tower.load()
        const output = /** @type {any} */ (result)
        output.markdown = tower.boardMarkdown(state, archiveView(index))
      }
      return result
}
