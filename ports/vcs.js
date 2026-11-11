// Vcs port (#69). Implementation: adapters/vcs-git.js.
//
// The structured change readers (`worktreeChanges`, `diffChanges`) are optional
// capabilities rather than required methods, like `store.copyFileExclusive`: a
// scripted or in-memory vcs has no checkout to inspect and must keep satisfying
// `assertVcsPort` without them. The app layer feature-detects each reader and
// falls back to name-only Git output. They are still declared here (both in the
// `VcsPort` typedef and in `VCS_OPTIONAL_METHODS`) because the port-call guard
// must see the names: a capability that is called but not declared is an
// undeclared dependency, and a caller that reads one must use optional chaining.
import { assertPort, definePort } from './contract.js'

/**
 * One structured path change, as emitted by `git status --porcelain=v1 -z` and
 * `git diff --name-status -z`. `status` is the raw status field (` M`, `??`,
 * `R100`, ...), `path` is the destination (or only) path, and `origPath` names
 * the rename/copy source or is null. Path bytes are never display-quoted.
 * @typedef {{ status: string, path: string, origPath: string | null }} GitPathChange
 */

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
 * @property {(cwd: string, options?: object) => Promise<GitPathChange[]>} [worktreeChanges] Optional structured reader for uncommitted changes.
 * @property {(cwd: string, range: string, options?: object) => Promise<GitPathChange[]>} [diffChanges] Optional structured reader for a revision range.
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

// Optional capabilities are declared separately from VCS_PORT so `assertVcsPort`
// keeps accepting every alternate adapter that cannot observe a checkout. The
// app layer must probe them through optional chaining; the contract test
// (`tests/memory-adapters.contract.test.mjs`) checks that every optional read is
// declared here and that the shipped Git adapter implements all of them.
export const VCS_OPTIONAL_METHODS = Object.freeze(['worktreeChanges', 'diffChanges'])

/** @param {unknown} impl */
export function assertVcsPort(impl) {
  return /** @type {VcsPort} */ (assertPort(impl, VCS_PORT, 'vcs'))
}
