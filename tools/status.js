// tower_status: dashboard and mission detail.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { classifyError } from '../domain/errors.js'
import { StatusInput } from '../domain/contracts/tool-inputs/index.js'
import { ROSTER_INACTIVE_STATES, isMarkdownFormat, isReservedState, isWorkerRole } from '../domain/vocabulary.js'
import { archiveView } from '../app/archive.js'

/**
 * @param {any} ctx
 * @param {{
 *   define: import('../types/index.js').DefineTool,
 *   openTower: any,
 *   workspaceHook: any,
 *   spawnBackoffView: any,
 *   observeActivity: any,
 * }} deps
 */
export function registerStatusTool(ctx, deps) {
  const { define, workspaceHook, spawnBackoffView, observeActivity } = deps
  define(ctx, {
    name: 'tower_status',
    description:
      'Read the Tower dashboard for a repository: state path, base branch, revision, mission status counts, paged mission summaries (scope/deps/tasks/worktree/owner), roster size, findings, archive count, config path and the activity tail. Also reports the repo-scoped git lock holder (`gitLock: {held,pid,phase,heldMs}`) so a merge holding the mutex is visible. Pass missionId for one full mission (tasks, notes, reviews, findings, completion report; archived missions are loaded from their year file); offset/limit page the mission list (default 20, max 100); includeGate adds preflight gate digests for the page; includeArchived appends compact archived summaries after the active page; format:"markdown" returns the human-readable mission board (active missions plus an archived count). Read-only.',
    parameters: StatusInput,
    aliases: { mission_id: ['missionId'], include_gate: ['includeGate'], include_archived: ['includeArchived'] },
    output: output(SCHEMAS.status),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const boardPath = tower.boardFile()
      const mode = workspaceHook?.modeInfo?.(exec) ?? null
      const statusState = await tower.load()
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
      }
      if (isMarkdownFormat(args.format)) {
        const state = await tower.load()
        const output = /** @type {any} */ (result)
        output.markdown = tower.boardMarkdown(state, archiveView(index))
      }
      return result
    },
  })
}
