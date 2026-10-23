// tower_reload: dev-only HMR reload request.
//
// #121: this tool is the `tower-hmr` component. It is registered only by that
// component's entry point, so the row is the switch; there is no second
// `dev.hotReload` boolean to disagree with it.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { ReloadInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any, sharedHmrBridge: any, runtimeConfig: any, createHmrBridge: any }} deps
 */
export function registerReloadTool(ctx, deps) {
  const { define, actorFor, requireTowerActor, sharedHmrBridge, runtimeConfig, createHmrBridge } = deps
  const dev = runtimeConfig().dev ?? {}
  const bridge =
    sharedHmrBridge ??
    createHmrBridge(ctx, {
      requiredIds: dev.reloadRequiredIds,
      delayMs: dev.reloadDelayMs,
      logger: ctx.logger ?? console,
    })
  define(ctx, {
    name: 'tower_reload',
    description:
      'Dev-only: ask DSH HMR to reconcile this profile and reload the Tower Host plugin from disk. Registered only while the tower-hmr component is on (the row is shipped off). The reload is scheduled a few milliseconds after this call returns (so the result reaches the model first). Use after editing the plugin source in a linked profile; plugin_manager install/update already triggers reconciliation by itself. Fails with reload-unavailable when the HMR service is absent.',
    parameters: ReloadInput,
    output: output(SCHEMAS.reload),
    async execute(args, exec) {
      if (typeof args.repoRoot === 'string') {
        const tower = await deps.openTower(args.repoRoot)
        const actor = await actorFor(tower, exec)
        requireTowerActor(actor, 'reload the Tower plugin')
      }
      if (!bridge.available) {
        throw new TowerToolError('reload-unavailable', 'this DSH profile has no HMR service; restart DSH instead')
      }
      const outcome = bridge.schedule()
      return {
        ok: true,
        ...outcome,
        ...(outcome.lastError ? { error: outcome.lastError } : {}),
        restartHint: 'If the new code does not appear, restart DSH or check the profile hmr entry.',
      }
    },
  })
}
