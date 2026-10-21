// tower_mission: mission lifecycle updates.
import { Tower, MISSION_STATUSES } from '../app/tower.js'
import { TowerToolError } from '../lib/errors.js'
import { SCHEMAS, output } from './output-schemas.js'
import { Type, enumOf } from './schema.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, actorFor: any, requireKnownActor: any }} deps
 */
export function registerMissionTool(ctx, deps) {
  const { define, actorFor, requireKnownActor } = deps
  define(ctx, {
    name: 'tower_mission',
    description:
      'Update one mission: lifecycle status, decision note, blocker, clear blockers, mark a task done, drop a task with a reason, or widen the scope (tower only). "merged" is never set here; only a future tower_merge records it. Merged and abandoned are terminal.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
      id: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: missionId).' })),
      missionId: Type.Optional(Type.String({ description: 'Alias for id; both are accepted.' })),
      status: Type.Optional(enumOf([...MISSION_STATUSES], { description: 'New lifecycle status.' })),
      note: Type.Optional(Type.String({ description: 'Append a decision-log note.' })),
      blocker: Type.Optional(Type.String({ description: 'Report a blocker (also sets status to blocked).' })),
      clear_blockers: Type.Optional(Type.Boolean({ description: 'Clear all recorded blockers.' })),
      clearBlockers: Type.Optional(Type.Boolean({ description: 'Alias for clear_blockers.' })),
      task_done: Type.Optional(Type.String({ description: 'Mark the first open task containing this text as done.' })),
      taskDone: Type.Optional(Type.String({ description: 'Alias for task_done.' })),
      task_drop: Type.Optional(Type.String({ description: 'Mark the first open task containing this text as dropped.' })),
      taskDrop: Type.Optional(Type.String({ description: 'Alias for task_drop.' })),
      task_drop_reason: Type.Optional(Type.String({ description: 'Required with task_drop: why the task is legitimately descoped.' })),
      taskDropReason: Type.Optional(Type.String({ description: 'Alias for task_drop_reason.' })),
      scope: Type.Optional(Type.Array(Type.String(), { description: 'Tower only: replacement scope globs; bumps scopeGeneration.' })),
      pause_cause: Type.Optional(enumOf(['user', 'failure', 'resource', 'dependency'], { description: 'With status=paused: why the mission was paused (default user).' })),
      authorization: Type.Optional(Type.String({ description: 'Authorization reference recorded when resuming a user-paused mission.' })),
    }, { additionalProperties: false }),
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
