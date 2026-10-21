// tower_status: dashboard and mission detail.
import { Tower, ROSTER_INACTIVE_STATES } from '../tower.js'
import { SCHEMAS, output } from '../schemas.js'
import { classifyError } from '../errors.js'

export function registerStatusTool(ctx, deps) {
  const { define, workspaceHook, spawnBackoffView, observeActivity } = deps
  define(ctx, {
    name: 'tower_status',
    description:
      'Read the Tower dashboard for a repository: state path, base branch, revision, mission status counts, paged mission summaries (scope/deps/tasks/worktree/owner), roster size, findings, config path and the activity tail. Pass missionId for one full mission (tasks, notes, reviews, findings, completion report); offset/limit page the mission list (default 20, max 100); includeGate adds preflight gate digests for the page; format:"markdown" returns the human-readable mission board. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Return full detail for one mission instead of the dashboard list.' },
        offset: { type: 'integer', minimum: 0, description: 'Mission list offset (default 0).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Mission list page size (default 20).' },
        includeGate: { type: 'boolean', description: 'Compute tower_preflight-style gate digests for missions on this page.' },
        format: { type: 'string', enum: ['json', 'markdown'], description: 'markdown returns the MISSIONS.md board text.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: { mission_id: ['missionId'], include_gate: ['includeGate'] },
    output: output(SCHEMAS.status),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const boardPath = tower.boardFile()
      const mode = workspaceHook?.modeInfo?.(exec) ?? null
      const statusState = await tower.load()
      const inflight = (statusState.roster ?? []).filter(
        (entry) => entry.role === 'worker' && !ROSTER_INACTIVE_STATES.includes(entry.state) && entry.state !== 'reserved',
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
      const total = state.missions.length
      const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0
      const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(100, args.limit)) : 20
      const pageIds = state.missions.slice(offset, offset + limit).map((mission) => mission.id)
      const status = await tower.status({ missionIds: pageIds })
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
      if (args.format === 'markdown') {
        const state = await tower.load()
        result.markdown = tower.boardMarkdown(state)
      }
      return result
    },
  })
}
