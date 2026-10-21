// Vcs port (#56). Implementation: adapters/vcs-git.js.
/**
 * @typedef {object} VcsPort
 * @property {(cwd: string, args: string[], options?: object) => Promise<string>} git
 * @property {(cwd: string, args: string[], options?: object) => Promise<string|null>} tryGit
 * @property {(cwd: string, ref: string) => Promise<string>} revParse
 * @property {(cwd: string) => Promise<boolean>} isClean
 * @property {(cwd: string, a: string, b: string) => Promise<boolean>} isAncestor
 * @property {(repoRoot: string) => Promise<{root:string, commonDir:string, branch:string|null}>} resolveRepo
 */
export {}
