// Mission ids are assigned monotonically by the domain planner.
// tower_plan — create missions and assign M1.. ids.
// 
// Input: PlanInput from domain contracts (missions, scope, deps).
// Output: created mission summaries and board state.
// Authorization: tower only; presets are validated first.
// Side effects: persists state and optional board file.
// It never creates worktrees; spawn/provision do that later.
// Failure modes: invalid scope, cyclic deps, preset missing.
// Pure normalization and DAG policy live in domain/missions.
// See docs/reference/tools.generated.md for the public shape.
// tower_plan: create missions.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { PlanInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any, assertPresetsAvailable: any }} deps
 */
export function registerPlanTool(ctx, deps) {
  // #70: preset validation is injected by the composition root, so this tool
  // never imports host/ or adapters/ directly.
  // openTower is injected by the composition root (#69).
  const { define, actorFor, requireTowerActor, assertPresetsAvailable } = deps
  define(ctx, {
    name: 'tower_plan',
    description:
      'Plan one or more missions in an initialized repository. Each mission has a printable-Unicode title (NFC-normalized, at most 120 characters), relative scope globs, optional task checklist, optional mission-id dependencies, and kind build|survey. Assigns M1.. ids and auto-adds a dependency when build scopes overlap (serializes merges); rejects dependency cycles.',
    parameters: PlanInput,
    board: true,
    output: output(SCHEMAS.plan),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'plan missions')
      await assertPresetsAvailable(ctx, tower.config)
      return tower.plan({ missions: args.missions })
    },
  })
}
