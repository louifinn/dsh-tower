// tower_mission: mission lifecycle updates.
import { TowerToolError } from '../domain/errors.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { MissionInput } from '../domain/contracts/tool-inputs/index.js'
import { fullMission } from '../domain/summary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireKnownActor: any, requestHumanAcceptance?: any }} deps
 */
export function registerMissionTool(ctx, deps) {
  const { define, actorFor, requireKnownActor } = deps
  define(ctx, {
    name: 'tower_mission',
    description:
      'Update one mission (id) or many (missions:[{id,...}], or ids shorthand for lifecycle-only fields). Status, note, blocker, tasks, scope edit/widen, defer (tower only), or human-approved accept (single form only). Bulk atomic defaults true; merged only by tower_merge.',
    parameters: MissionInput,
    aliases: {"id":["missionId"],"task_done":["taskDone"],"task_drop":["taskDrop"],"task_drop_reason":["taskDropReason"],"task_add":["taskAdd"],"clear_blockers":["clearBlockers"]},
    board: true,
    output: output(SCHEMAS.mission),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireKnownActor(actor, 'tower_mission')
      // #159 D3: acceptance is the one update that must pass through the human
      // approval channel before it may touch state. The ask resolves the tip,
      // shows the deliverables, and only a human selection of the accept
      // option continues; a profile without the channel is refused rather than
      // auto-accepted.
      let accept = undefined
      if (args.accept === true && (args.missions !== undefined || args.ids !== undefined)) {
        throw new TowerToolError('invalid-argument', 'tower_mission accept is only available on the single-mission form')
      }
      if (args.accept === true) {
        // aliases normalize missionId to id before execute, so only id is read.
        const missionId = typeof args.id === 'string' ? args.id.trim() : ''
        if (missionId.length === 0) {
          throw new TowerToolError('invalid-argument', 'tower_mission requires id')
        }
        if (typeof deps.requestHumanAcceptance !== 'function') {
          throw new TowerToolError(
            'approval-unavailable',
            'artifact acceptance needs the DSH userQuestions service, which this profile does not expose; an acceptance is never auto-recorded',
          )
        }
        const decision = await deps.requestHumanAcceptance(ctx, exec, {
          tower,
          missionId,
          note: args.accept_note,
        })
        if (!decision.approved) {
          // A declined or cancelled question records nothing; return the
          // unchanged mission so the caller sees the acceptance is still open.
          const state = await tower.load()
          const mission = state.missions.find((entry) => entry.id === missionId)
          if (!mission) throw new TowerToolError('mission-not-found', `unknown mission "${missionId}"`)
          return {
            revision: state.revision,
            mission: fullMission(mission),
            accepted: false,
            ...(decision.cancelled ? { cancelled: true } : {}),
          }
        }
        accept = { tip: decision.tip, note: args.accept_note }
      }
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
        task_add: args.task_add,
        scope: args.scope,
        allowMissingScope: args.allowMissingScope,
        deferred: args.deferred,
        widen: args.widen,
        pause_cause: args.pause_cause,
        authorization: args.authorization,
        missions: args.missions,
        ids: args.ids,
        atomic: args.atomic,
        ...(accept !== undefined ? { accept } : {}),
      })
    },
  })
}
