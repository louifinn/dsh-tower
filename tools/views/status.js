// tower_inspect view: status — dashboard and mission detail.
import { SCHEMAS, output } from '../../domain/contracts/outputs.js'
import { classifyError } from '../../domain/errors.js'
import { SCHEMA_VERSION } from '../../domain/mission.js'
import { inspectStateVersion } from '../../domain/state.js'
import { StatusInput } from '../../domain/contracts/tool-inputs/index.js'
import { ROSTER_INACTIVE_STATES, isMarkdownFormat, isReservedState, isWorkerRole } from '../../domain/vocabulary.js'
import { archiveView } from '../../app/archive.js'
import { reviewPolicyView } from '../../domain/integration/review.js'

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
        return {
          ...status,
          missions: status.missions.filter((mission) => mission.id === args.missionId),
          missionId: args.missionId,
          detail,
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
      const activeIds = state.missions.map((mission) => mission.id)
      const archivedIds = index.ok
        ? index.missions.map((entry) => entry.id).filter((id) => !activeIds.includes(id))
        : []
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
        missions: page,
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
      if (isMarkdownFormat(args.format)) {
        const state = await tower.load()
        const output = /** @type {any} */ (result)
        output.markdown = tower.boardMarkdown(state, archiveView(index))
      }
      return result
}
