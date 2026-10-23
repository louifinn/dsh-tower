// Vcs port (#69). Implementation: adapters/vcs-git.js.
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} VcsPort
 * @property {(cwd: string, args: string[], options?: object) => Promise<string>} git
 * @property {(cwd: string, args: string[], options?: object) => Promise<string|null>} tryGit
 * @property {(cwd: string, ref: string) => Promise<string>} revParse
 * @property {(cwd: string) => Promise<boolean>} isClean
 * @property {(cwd: string, ancestor: string, descendant: string) => Promise<boolean>} isAncestor
 * @property {(repoRoot: string) => Promise<{ root: string, commonDir: string, branch: string|null }>} resolveRepo
 * @property {(cwd: string) => Promise<string|null>} currentBranch
 * @property {(cwd: string, fromRef: string) => Promise<number>} countCommits
 * @property {(cwd: string) => Promise<Array<{ path: string, branch?: string, head?: string }>>} listWorktrees
 */

export const VCS_PORT = definePort('VcsPort', [
  'git',
  'tryGit',
  'revParse',
  'isClean',
  'isAncestor',
  'resolveRepo',
  'currentBranch',
  'countCommits',
  'listWorktrees',
])

/** @param {unknown} impl */
export function assertVcsPort(impl) {
  return /** @type {VcsPort} */ (assertPort(impl, VCS_PORT, 'vcs'))
}
