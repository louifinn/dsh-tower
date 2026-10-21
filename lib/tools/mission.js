// tower_mission: mission lifecycle updates.
import { Tower, MISSION_STATUSES } from '../tower.js'
import { TowerToolError } from '../errors.js'
import { SCHEMAS, output } from '../schemas.js'

export function registerMissionTool(ctx, deps) {
  const { define, actorFor, requireKnownActor } = deps
  define(ctx, {
    name: 'tower_mission',
    description:
      'Update one mission: lifecycle status, decision note, blocker, clear blockers, mark a task done, drop a task with a reason, or widen the scope (tower only). "merged" is never set here; only a future tower_merge records it. Merged and abandoned are terminal.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        id: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: missionId).' },
        missionId: { type: 'string', description: 'Alias for id; both are accepted.' },
        status: {
          type: 'string',
          enum: [...MISSION_STATUSES],
          description: 'New lifecycle status.',
        },
        note: { type: 'string', description: 'Append a decision-log note.' },
        blocker: { type: 'string', description: 'Report a blocker (also sets status to blocked).' },
        clear_blockers: { type: 'boolean', description: 'Clear all recorded blockers.' },
        clearBlockers: { type: 'boolean', description: 'Alias for clear_blockers.' },
        task_done: { type: 'string', description: 'Mark the first open task containing this text as done.' },
        taskDone: { type: 'string', description: 'Alias for task_done.' },
        task_drop: { type: 'string', description: 'Mark the first open task containing this text as dropped.' },
        taskDrop: { type: 'string', description: 'Alias for task_drop.' },
        task_drop_reason: { type: 'string', description: 'Required with task_drop: why the task is legitimately descoped.' },
        taskDropReason: { type: 'string', description: 'Alias for task_drop_reason.' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Tower only: replacement scope globs; bumps scopeGeneration.' },
        pause_cause: {
          type: 'string',
          enum: ['user', 'failure', 'resource', 'dependency'],
          description: 'With status=paused: why the mission was paused (default user).',
        },
        authorization: { type: 'string', description: 'Authorization reference recorded when resuming a user-paused mission.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"id":["missionId"],"task_done":["taskDone"],"task_drop":["taskDrop"],"task_drop_reason":["taskDropReason"],"clear_blockers":["clearBlockers"]},
    board: true,
    output: output(SCHEMAS.mission),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireKnownActor(actor, 'tower_mission')
      return tower.mission({
        actor,
        id: args.id,
        status: args.status,
        note: args.note,
        blocker: args.blocker,
        clear_blockers: args.clear_blockers,
        task_done: args.task_done,
        task_drop: args.task_drop,
        task_drop_reason: args.task_drop_reason,
        scope: args.scope,
        pause_cause: args.pause_cause,
        authorization: args.authorization,
      })
    },
  })
}
