// tower-board component entry (#133): the generated MISSIONS.md board only.
//
// The board used to be the `docs.board` tuning boolean. It is a capability — off
// means the human-readable artifact is simply not written — so it is its own row
// and its own switch. The row owns no tool: the board is written by the
// composition that registers tools, which asks this registry whether the row is
// mounted. Off leaves every mission tool, gate and other capability working; an
// existing board just goes stale. `docs.boardLocation` stays genuine tuning.
//
// The row is declared in cordis.patch.yml; the package export is `./board`.
import { holdComponent } from './capability-registry.js'

export const name = 'dsh-tower/board'
export const inject = ['tower']

export function apply(ctx) {
  holdComponent(ctx, 'tower-board')
}
