// tower_plan: create missions.
import { Tower } from '../tower.js'
import { SCHEMAS, output } from '../schemas.js'

export function registerPlanTool(ctx, deps) {
  const { define, actorFor, requireTowerActor } = deps
  define(ctx, {
    name: 'tower_plan',
    description:
      'Plan one or more missions in an initialized repository. Each mission has a printable-ASCII title, relative scope globs, optional task checklist, optional mission-id dependencies, and kind build|survey. Assigns M1.. ids and auto-adds a dependency when build scopes overlap (serializes merges); rejects dependency cycles.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missions: {
          type: 'array',
          description: 'Missions to create, in intended order.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Printable ASCII title; used as the mission label.' },
              scope: { type: 'array', items: { type: 'string' }, description: 'Relative file globs this mission may touch; empty only for survey.' },
              tasks: { type: 'array', items: { type: 'string' }, description: 'Verifiable task items the worker ticks off.' },
              deps: { type: 'array', items: { type: 'string' }, description: 'Mission ids that must merge before this one.' },
              kind: { type: 'string', enum: ['build', 'survey'], description: 'survey = read-only investigation that reserves no scope.' },
              context: { type: 'string', description: "The user's own key sentences, verbatim (max 4096 chars)." },
              references: {
                type: 'array',
                maxItems: 20,
                items: { type: 'string' },
                description: 'Read-only pointers/files the worker should read (max 20); copied into the briefing.',
              },
              reviewPolicy: {
                type: 'string',
                enum: ['required-clean', 'none'],
                description: 'required-clean (mission default) means a clean review is required when review.requireReview is on; none needs reviewExemptionReason, and with the review gate on it also needs gates.allowReviewExemption.',
              },
              reviewExemptionReason: {
                type: 'string',
                description: 'Non-empty justification when reviewPolicy is "none".',
              },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      required: ['repoRoot', 'missions'],
      additionalProperties: false,
    },
    board: true,
    output: output(SCHEMAS.plan),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'plan missions')
      return tower.plan({ missions: args.missions })
    },
  })
}
