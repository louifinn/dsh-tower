// tower-artifact component entry (#159): the artifact mission shape.
//
// An artifact mission writes deliverables a code review cannot judge and lands
// on a human acceptance of the committed tip. The shape's planning path is a
// capability, not a flag on build: this row is its switch. The row owns no
// tool and no preset — an artifact worker uses the mandatory worker preset in
// the same branch worktree a build uses — so the entry point only holds the
// row in the registry. Off means tower_plan refuses kind:"artifact" with an
// actionable code while build and survey missions are unaffected.
//
// The row is declared in cordis.patch.yml; the package export is `./artifact`.
import { holdComponent } from './capability-registry.js'

export const name = 'dsh-tower/artifact'
export const inject = ['tower']

export function apply(ctx) {
  holdComponent(ctx, 'tower-artifact')
}
