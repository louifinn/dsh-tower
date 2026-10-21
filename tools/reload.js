// tower_reload: dev-only HMR reload request.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { runtimeConfig } from '../lib/config.js'
import { createHmrBridge } from '../lib/hmr.js'
import { ReloadInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, actorFor: any, requireTowerActor: any, sharedHmrBridge: any }} deps
 */
export function registerReloadTool(ctx, deps) {
  const { define, actorFor, requireTowerActor, sharedHmrBridge } = deps
  // Dev-only hot reload. The tool is registered whenever dev.hotReload is on;
  // it reports reload-unavailable when the profile has no HMR service. When the
  // Host passed a shared bridge, its status() reflects the command's reloads too.
  const dev = runtimeConfig().dev ?? {}
  if (dev.hotReload !== false) {
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
        'Dev-only: ask DSH HMR to reconcile this profile and reload the Tower Host plugin from disk. The reload is scheduled a few milliseconds after this call returns (so the result reaches the model first). Use after editing the plugin source in a linked profile; plugin_manager install/update already triggers reconciliation by itself. Registered while dev.hotReload is on; fails with reload-unavailable when the HMR service is absent.',
      parameters: ReloadInput,
      output: output(SCHEMAS.reload),
      async execute(args, exec) {
        if (typeof args.repoRoot === 'string') {
          const tower = await Tower.open(args.repoRoot)
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
}
