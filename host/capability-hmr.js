// tower-hmr component entry (#121): dev hot reload, shipped off.
//
// The row defaults to `disabled: true` in cordis.patch.yml, because a profile
// without HMR is the normal case and the capability only makes sense for linked
// development installs. Switching the row on registers `tower_reload` and the
// `/tower reload` branch; switching it off leaves both absent while
// `tower_status` reports "disabled by component tower-hmr".
import { createHmrBridge } from './hmr.js'
import { runtimeConfig } from './config.js'
import { clearHmrBridge, holdComponent, setHmrBridge } from './capability-registry.js'
import { registerHmrCapability } from './tool-registry.js'

export const name = 'dsh-tower/hmr'
export const inject = ['tools', 'tower']

export function apply(ctx) {
  holdComponent(ctx, 'tower-hmr')
  const dev = runtimeConfig().dev ?? {}
  const bridge = createHmrBridge(ctx, {
    requiredIds: dev.reloadRequiredIds,
    delayMs: dev.reloadDelayMs,
    logger: ctx.logger ?? console,
  })
  setHmrBridge(bridge)
  ctx.effect(() => () => {
    clearHmrBridge(bridge)
    bridge.dispose()
  })
  registerHmrCapability(ctx, { bridge })
}
