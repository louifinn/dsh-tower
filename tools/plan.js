// tower_plan: create missions.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { assertPresetsAvailable } from '../lib/presets.js'
import { Type, enumOf } from './schema.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, actorFor: any, requireTowerActor: any }} deps
 */
export function registerPlanTool(ctx, deps) {
  const { define, actorFor, requireTowerActor } = deps
  define(ctx, {
    name: 'tower_plan',
    description:
      'Plan one or more missions in an initialized repository. Each mission has a printable-ASCII title, relative scope globs, optional task checklist, optional mission-id dependencies, and kind build|survey. Assigns M1.. ids and auto-adds a dependency when build scopes overlap (serializes merges); rejects dependency cycles.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
      missions: Type.Array(
        Type.Object({
          title: Type.String({ description: 'Printable ASCII title; used as the mission label.' }),
          scope: Type.Optional(Type.Array(Type.String(), { description: 'Relative file globs this mission may touch; empty only for survey.' })),
          tasks: Type.Optional(Type.Array(Type.String(), { description: 'Verifiable task items the worker ticks off.' })),
          deps: Type.Optional(Type.Array(Type.String(), { description: 'Mission ids that must merge before this one.' })),
          kind: Type.Optional(enumOf(['build', 'survey'], { description: 'survey = read-only investigation that reserves no scope.' })),
          context: Type.Optional(Type.String({ description: "The user's own key sentences, verbatim (max 4096 chars)." })),
          references: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: 'Read-only pointers/files the worker should read (max 20); copied into the briefing.' })),
          reviewPolicy: Type.Optional(enumOf(['required-clean', 'none'], { description: 'required-clean (mission default) means a clean review is required when review.requireReview is on; none needs reviewExemptionReason, and with the review gate on it also needs gates.allowReviewExemption.' })),
          reviewExemptionReason: Type.Optional(Type.String({ description: 'Non-empty justification when reviewPolicy is "none".' })),
        }, { additionalProperties: false }),
        { description: 'Missions to create, in intended order.' },
      ),
    }, { additionalProperties: false }),
    board: true,
    output: output(SCHEMAS.plan),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'plan missions')
      await assertPresetsAvailable(ctx, tower.config)
      return tower.plan({ missions: args.missions })
    },
  })
}
