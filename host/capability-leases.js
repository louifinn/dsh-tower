// tower-leases component entry (#121): advisory resource leases only.
import { holdComponent } from './capability-registry.js'
import { registerLeasesCapability } from './tool-registry.js'

export const name = 'dsh-tower/leases'
export const inject = ['tools', 'tower']

export function apply(ctx) {
  holdComponent(ctx, 'tower-leases')
  registerLeasesCapability(ctx)
}
