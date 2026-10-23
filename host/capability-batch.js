// tower-batch component entry (#121): evidence batches only.
//
// Each optional capability is its own loader row, so switching this component
// off removes exactly `tower_batch` and leaves the rest of Tower working. The
// row is declared in cordis.patch.yml; the package export is `./batch`.
import { holdComponent } from './capability-registry.js'
import { registerBatchCapability } from './tool-registry.js'

export const name = 'dsh-tower/batch'
export const inject = ['tools', 'tower']

export function apply(ctx) {
  holdComponent(ctx, 'tower-batch')
  registerBatchCapability(ctx)
}
