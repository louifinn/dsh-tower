// tower-tests component entry (#121): declared test discovery only.
//
// With this row off there is no `tower_test` tool and no receipt to satisfy
// `gates.requireTests`; planning/mode entry refuse that combination with an
// explanatory error (host/presets.js), and the merge gate still reports
// `tests-missing` because no receipt can exist.
import { holdComponent } from './capability-registry.js'
import { registerTestsCapability } from './tool-registry.js'

export const name = 'dsh-tower/tests'
export const inject = ['tools', 'tower']

export function apply(ctx) {
  holdComponent(ctx, 'tower-tests')
  registerTestsCapability(ctx)
}
