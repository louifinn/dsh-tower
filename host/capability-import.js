// tower-import component entry (#121): legacy import and its audit map only.
import { holdComponent } from './capability-registry.js'
import { registerImportCapability } from './tool-registry.js'

export const name = 'dsh-tower/import'
export const inject = ['tools', 'tower']

export function apply(ctx) {
  holdComponent(ctx, 'tower-import')
  registerImportCapability(ctx)
}
