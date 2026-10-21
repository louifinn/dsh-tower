// tower_mission: mission lifecycle updates.
import { Tower } from '../app/tower.js'
import { TowerToolError } from '../domain/errors.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { MissionInput } from '../domain/contracts/tool-inputs/index.js'

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
    parameters: MissionInput,
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
