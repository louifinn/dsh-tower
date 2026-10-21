// tower_diff and tower_adopt.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { Type } from './schema.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, actorFor: any, requireTowerActor: any }} deps
 */
export function registerDiffAdoptTools(ctx, deps) {
  const { define, actorFor, requireTowerActor } = deps
  define(ctx, {
    name: 'tower_diff',
    description:
      'Read-only view of a mission branch for review: merge base, changed files, commits, and a capped patch against the recorded base. Safe for reviewers; it never modifies the repository.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path to the main checkout root.' }),
      missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
      id: Type.Optional(Type.String({ description: 'Alias for missionId; both are accepted.' })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1024, description: 'Patch cap in bytes (default 65536).' })),
    }, { additionalProperties: false }),
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.diff),
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      return tower.diff({ missionId: args.missionId, maxBytes: args.maxBytes })
    },
  })

  define(ctx, {
    name: 'tower_adopt',
    description:
      'Reconcile the roster with the durable subagent catalog after a restart or new session. Agents that are provably gone are marked retired (records are kept) or missing (retireMissing:false, so the tower can inspect/take over); agents whose parent catalog cannot be read stay unknown and are never changed. Only the tower may adopt.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
      retireMissing: Type.Optional(Type.Boolean({ description: 'Retire provably gone agents (default true); false marks them missing instead.' })),
    }, { additionalProperties: false }),
    aliases: { retire_missing: ['retireMissing'] },
    output: output(SCHEMAS.adopt),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'adopt the roster')
      const view = await tower.rosterView()
      const subagents = ctx.get('subagents')
      if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot adopt')

      const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
      const activity = new Map()
      const parentStatus = {}
      for (const parent of parents) {
        try {
          const rows = await subagents.listDescendants(parent)
          for (const row of rows) activity.set(String(row.id), row.activity ?? 'unknown')
          parentStatus[parent] = 'ok'
        } catch (error) {
          parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
        }
      }

      const retiredCandidates = []
      const presentIds = []
      const absentIds = []
      for (const entry of view.roster) {
        if (entry.state === 'retired') continue
        if (parentStatus[entry.parentSessionId] !== 'ok') continue
        if (activity.has(entry.agentId)) {
          presentIds.push(entry.agentId)
        } else {
          absentIds.push(entry.agentId)
        }
      }
      const observations = await tower.recordRosterObservations({ present: presentIds, absent: absentIds, confirmations: 2 })
      retiredCandidates.push(...observations.candidates)
      const retireMissing = args.retireMissing !== false
      const { retired } = retireMissing ? await tower.markRetired(retiredCandidates) : { retired: [] }
      const { missing } = retireMissing ? { missing: [] } : await tower.markMissing(retiredCandidates)
      const after = await tower.rosterView()
      return {
        retired,
        missing,
        unconfirmed: absentIds.filter((agentId) => !retiredCandidates.includes(agentId)),
        skippedUnknownParents: Object.entries(parentStatus)
          .filter(([, status]) => status !== 'ok')
          .map(([parent]) => parent),
        roster: after.roster,
        parentStatus,
      }
    },
  })
}
