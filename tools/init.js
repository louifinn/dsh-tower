// tower_init: repository initialization.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { resolveRepo } from '../lib/git.js'
import { runtimeConfig } from '../lib/config.js'
import { InitInput } from '../domain/contracts/tool-inputs/index.js'
import { isTowerRole, isUnknownRole } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, actorFor: any, requireTowerActor: any, workspaceHook: any, ensureRepository: any }} deps
 */
export function registerInitTool(ctx, deps) {
  const { define, actorFor, requireTowerActor, workspaceHook, ensureRepository } = deps
  define(ctx, {
    name: 'tower_init',
    description:
      'Initialize Tower mission state for a repository (absolute repoRoot). Creates <git-common-dir>/dsh-tower/state.json and an activity log; idempotent on an existing workspace. Options: autoGitInit (git init + empty initial commit when the directory is not a repository), snapshotDirty (snapshot uncommitted work into a dangling commit used as the mission baseline), reanchor (change base when every mission is merged/abandoned). Only the tower may initialize.',
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
          args.autoGitInit === true || (args.autoGitInit === undefined && profileInit.autoGitInit === true)
        repo = await ensureRepository(args.repoRoot, autoGitInit)
      }
      const tower = await Tower.open(repo.root)
      const initConfig = tower.config.init ?? {}
      const snapshotDirty =
        args.snapshotDirty === true || (args.snapshotDirty === undefined && initConfig.snapshotDirty === true)
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
