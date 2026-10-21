// tower_diff: read-only mission branch view.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { DiffInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool }} deps
 */
export function registerDiffTool(ctx, deps) {
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
      const tower = await Tower.open(args.repoRoot)
      return tower.diff({ missionId: args.missionId, maxBytes: args.maxBytes })
    },
  })
}
