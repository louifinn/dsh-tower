// tower_init: repository initialization.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { InitInput } from '../domain/contracts/tool-inputs/index.js'
import { isTowerRole, isUnknownRole } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any, workspaceHook: any, ensureRepository: any, resolveRepo: any, runtimeConfig: any }} deps
 */
export function registerInitTool(ctx, deps) {
  const { define, actorFor, requireTowerActor, workspaceHook, ensureRepository, resolveRepo, runtimeConfig } = deps
  define(ctx, {
    name: 'tower_init',
    description:
      'Initialize Tower state under <git-common-dir>/dsh-tower for the repository at absolute repoRoot. Idempotent. Options: autoGitInit, snapshotDirty, reanchor. Only the tower may initialize. Details: docs/reference/tools.md.',
    parameters: InitInput,
    aliases: { auto_git_init: ['autoGitInit'], snapshot_dirty: ['snapshotDirty'] },
    board: true,
    output: output(SCHEMAS.init),
    async execute(args, exec) {
      const profileInit = runtimeConfig().init ?? {}
      let repo = null
      try {
        repo = await resolveRepo(args.repoRoot)
      } catch (error) {
        const autoGitInit =
          args.auto_git_init === true || (args.auto_git_init === undefined && profileInit.autoGitInit === true)
        repo = await ensureRepository(args.repoRoot, autoGitInit)
      }
      const tower = await deps.openTower(repo.root)
      const initConfig = tower.config.init ?? {}
      const snapshotDirty =
        args.snapshot_dirty === true || (args.snapshot_dirty === undefined && initConfig.snapshotDirty === true)
      const agentId = exec?.agent?.id !== undefined ? String(exec.agent.id) : null
      if (!agentId) {
        throw new TowerToolError('not-authorized', 'tower_init requires a caller agent id; refusing to treat an unidentified caller as the tower')
      }
      let state = null
      try {
        state = await tower.load()
      } catch {
        state = null
      }
      if (state?.towerAgentId) {
        const actor = await actorFor(tower, exec)
        requireTowerActor(actor, 'initialize Tower state')
      } else if (state) {
        // Legacy state predating owner binding: an explicit tower_init may
        // claim ownership once. Other tools remain fail-closed until then.
        const actor = await actorFor(tower, exec)
        if (!isTowerRole(actor.role) && !isUnknownRole(actor.role)) {
          requireTowerActor(actor, 'claim Tower ownership')
        }
      }
      const base = args.base ?? workspaceHook?.basePreference?.(exec) ?? undefined
      return tower.init({ base, snapshotDirty, reanchor: args.reanchor, towerAgentId: agentId })
    },
  })
}
