// Repository resolution for tool calls (#163).
//
// Every tool used to advertise a required `repoRoot` and repeat the same
// constant. Only `tower_init` keeps the field (it bootstraps the repository);
// the rest resolve it in one place, in the ratified order:
//
//   1. the repository bound to the calling session by an engaged workspace lock
//   2. the session's working directory
//   3. the explicit `repoRoot` field (accepted for headless/embedded callers and
//      for `tower_init`'s bootstrap path)
//
// A directory inside a linked worktree resolves to the main checkout: Tower
// state lives in the repository's common dir, and a worker must never write the
// board into its mission worktree.
import path from 'node:path'
import { resolveRepo } from '../adapters/git.js'
import { TowerToolError } from '../domain/errors.js'
import { agentCwd, agentKey, modeState } from './mode-state.js'
import { isRepositoryOptionalTool } from './tool-profiles.js'

const REPO_ROOT = 'repoRoot'

/**
 * The explicit field, normalized. The schemas no longer advertise it, but the
 * server keeps accepting it (#163 Phase 1).
 *
 * @param {any} args
 * @returns {string | null}
 */
export function explicitRepoRoot(args) {
  const value = args?.[REPO_ROOT]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * The repository bound to the calling session. The workspace lock records the
 * repository's common dir, so a session that entered Tower mode in a worktree
 * still resolves to the main checkout that owns the state and board.
 *
 * @param {any} agent
 * @returns {string | null}
 */
export function boundRepoRoot(agent) {
  const key = agentKey(agent)
  const commonDir = key ? modeState.get(key)?.lock?.commonDir : null
  if (typeof commonDir !== 'string' || commonDir.trim().length === 0) return null
  const root = path.dirname(path.resolve(commonDir))
  return root === path.parse(root).root ? null : root
}

/**
 * Resolve the repository for one tool call. Returns `null` for a
 * repository-optional tool with no explicit field: its handler runs without a
 * repository by contract.
 *
 * `tower_init` is the bootstrap exception: its explicit field names the
 * repository to create, so it wins over the session directory.
 *
 * @param {string} name
 * @param {any} args
 * @param {any} exec
 * @returns {Promise<string | null>}
 */
export async function resolveToolRepoRoot(name, args, exec) {
  const explicit = explicitRepoRoot(args)
  const bound = boundRepoRoot(exec?.agent)
  if (name === 'tower_init') return explicit ?? bound ?? agentCwd(exec?.agent) ?? null
  if (isRepositoryOptionalTool(name)) return explicit
  if (bound) return bound
  const sessionCwd = agentCwd(exec?.agent)
  if (typeof sessionCwd === 'string' && sessionCwd.trim().length > 0) {
    try {
      const repo = await resolveRepo(sessionCwd)
      const main = path.dirname(repo.commonDir)
      if (main !== path.parse(main).root) return main
    } catch {
      // not a repository (or git is unavailable): the explicit field is next
    }
  }
  if (explicit) return explicit
  throw new TowerToolError(
    'repo-invalid',
    `${name} could not resolve a repository: bind a Tower workspace, call it from inside a Git repository, or pass repoRoot explicitly`,
  )
}
