// The result is bound to the recorded reviewed tip only when requested.
// Callers must treat the patch as read-only evidence.
// The tool never checks out or mutates the mission branch.
// Reviewers may use it without holding the state lock.
// tower_diff — read-only mission branch view.
// 
// Input: DiffInput (missionId/id, maxBytes) from domain contracts.
// Output: merge base, changed files, commits, capped patch.
// Authorization: tower, reviewer, or assigned worker may inspect.
// Side effects: none; it never writes state, git, or the repository.
// Failure modes: unknown mission, missing worktree, stale branch.
// Errors are classified as [tower:<code>] by the registry.
// The patch cap is enforced by the pure read projection.
// See docs/reference/tools.generated.md for the public shape.
// tower_diff: read-only mission branch view.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { DiffInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any }} deps
 */
export function registerDiffTool(ctx, deps) {
  // openTower is injected by the composition root (#69).
  const { define } = deps
  define(ctx, {
    name: 'tower_diff',
    description:
      'Read-only view of a mission branch for review: merge base, changed files, commits, and a capped patch against the recorded base. Safe for reviewers; it never modifies the repository.',
    parameters: DiffInput,
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.diff),
    async execute(args) {
      const tower = await deps.openTower(args.repoRoot)
      return tower.diff({ missionId: args.missionId, maxBytes: args.maxBytes })
    },
  })
}
