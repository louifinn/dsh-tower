// Default-deps binding of the Tower app service (#69).
//
// The composition root (index.js / lib/tool-registry.js) builds one deps object
// and injects it into the app layer. This module is the convenience binding for
// embedders and tests that want the process-default adapters; it is the only
// lib/ module besides tool-registry.js that knows the default adapter set.
//
// Object layout supplied here is memoised in adapters/default.js, so every
// caller shares the same adapter instances.
import { Tower as InjectedTower } from '../app/tower.js'
import { defaultDeps } from '../adapters/default.js'

export class Tower extends InjectedTower {
  /**
   * @param {{ root: string, commonDir: string, branch?: string | null }} repo
   * @param {import('../types/index.js').TowerConfig} [config]
   * @param {Record<string, any>} [deps]
   */
  constructor(repo, config, deps = defaultDeps) {
    super(repo, config, deps)
  }

  /**
   * @param {string} repoRoot
   * @param {Record<string, any>} [deps]
   */
  static async open(repoRoot, deps = defaultDeps) {
    const repo = await deps.vcs.resolveRepo(repoRoot)
    const config = await deps.config.resolveRepoConfig(repo)
    return new Tower(repo, config, deps)
  }
}
