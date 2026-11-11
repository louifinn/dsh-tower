import { TowerToolError } from '../domain/errors.js'
// Minimal git port: array arguments only, bounded output, no shell.
import { execFile } from './vcs-git.js'
import path from 'node:path'
// node:fs reaches this adapter only through the single fs boundary (#50).
import { fs } from './store-fs.js'

const GIT_TIMEOUT_MS = 15000
const MAX_BUFFER = 16 * 1024 * 1024
let configuredTimeoutMs = GIT_TIMEOUT_MS

/** @typedef {{ timeoutMs?: number, maxBuffer?: number }} GitOptions */
/** @typedef {{ path: string, branch?: string, head?: string }} WorktreeEntry */
/**
 * One changed path as Git reports it. `path` is the current name; `origPath` is
 * the rename/copy source and null for every other status. Both sides are kept
 * because a rename that moves a file *into* scope still touched the source.
 * @typedef {{ status: string, path: string, origPath: string | null }} GitPathChange
 */

/** Override the default Git timeout from resolved Tower config. */
export function setGitTimeout(ms) {
  const value = Number(ms)
  if (Number.isFinite(value) && value >= 1000) configuredTimeoutMs = value
}

/** Process default retained for manual adapter use; Tower instances pass their own. */
export function configuredGitTimeout() {
  return configuredTimeoutMs
}

const BLOCKED_GIT_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_QUARANTINE_PATH',
])

/**
 * Git must not inherit a repository redirect from the DSH process environment.
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(source = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (BLOCKED_GIT_ENV.has(key)) continue
    env[key] = value
  }
  return env
}

import { GitError } from '../domain/errors.js'
export { GitError }

/**
 * Run one git command with bounded output and no shell, returning stdout
 * byte-for-byte. `-z` readers must never go through the display normalization
 * below: stripping or folding bytes would corrupt path names.
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitOptions} [options]
 * @returns {Promise<string>}
 */
function gitRaw(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: options.timeoutMs ?? configuredTimeoutMs,
        maxBuffer: options.maxBuffer ?? MAX_BUFFER,
        windowsHide: true,
        env: gitEnv(),
      },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT'
          const bufferOverflow = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          reject(
            new GitError(
              args,
              String(stderr || error.message || '').trim(),
              typeof error.code === 'number' ? error.code : undefined,
              { timedOut, bufferOverflow, stdout: String(stdout ?? '').slice(0, 64 * 1024) },
            ),
          )
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/**
 * Run one git command with bounded output and no shell. Display-oriented
 * callers get CRLF folded and the trailing newline dropped; structured `-z`
 * readers call `gitRaw` instead.
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitOptions} [options]
 * @returns {Promise<string>}
 */
export async function git(cwd, args, options = {}) {
  const stdout = await gitRaw(cwd, args, options)
  return stdout.replace(/\r\n/g, '\n').trimEnd()
}

/**
 * Run git when its failure is not an error (existence probes).
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitOptions} [options]
 * @returns {Promise<string | null>}
 */
export async function tryGit(cwd, args, options) {
  try {
    return await git(cwd, args, options)
  } catch {
    return null
  }
}

/**
 * Split NUL-delimited output. The final NUL terminator is not an entry; every
 * other empty field is malformed and rejected by the callers.
 * @param {string} output
 * @returns {string[]}
 */
function nulFields(output) {
  const fields = output.split('\0')
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop()
  return fields
}

/**
 * @param {string} tool
 * @param {string} output
 * @returns {never}
 */
function malformedGitOutput(tool, output) {
  throw new TypeError(`malformed git ${tool} output: ${JSON.stringify(output.slice(0, 240))}`)
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * Each entry is `XY <path>`. A rename or copy (`R`/`C` in either status
 * column) is followed by one extra field: the original path. Under `-z` Git
 * does not C-quote paths, so spaces, tabs, newlines and non-ASCII bytes arrive
 * verbatim; only NUL separates the fields.
 * @param {string} output
 * @returns {GitPathChange[]}
 */
export function parseWorktreeChanges(output) {
  if (typeof output !== 'string') throw new TypeError('git status output must be a string')
  const fields = nulFields(output)
  /** @type {GitPathChange[]} */
  const changes = []
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]
    // Status is exactly two columns, then one space, then the path. Checking
    // the separator (not indexOf) keeps a leading status space such as ` M`.
    if (entry.length < 4 || entry.charAt(2) !== ' ') malformedGitOutput('status --porcelain -z', entry)
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (path.length === 0) malformedGitOutput('status --porcelain -z', entry)
    const renamed = status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C'
    let origPath = null
    if (renamed) {
      index += 1
      if (index >= fields.length || fields[index].length === 0) {
        malformedGitOutput('status --porcelain -z (rename source)', output)
      }
      origPath = fields[index]
    }
    changes.push({ status, path, origPath })
  }
  return changes
}

/**
 * Parse `git diff --name-status -z`.
 *
 * Each entry is `<status>`, then the path. Rename/copy entries (`R<score>`,
 * `C<score>`) are followed by the original path and then the destination path.
 * `-z` output is unquoted, so paths keep spaces, punctuation and non-ASCII
 * characters exactly as Git stores them.
 * @param {string} output
 * @returns {GitPathChange[]}
 */
export function parseNameStatusChanges(output) {
  if (typeof output !== 'string') throw new TypeError('git diff output must be a string')
  const fields = nulFields(output)
  /** @type {GitPathChange[]} */
  const changes = []
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) malformedGitOutput('diff --name-status -z', status)
    const renamed = status[0] === 'R' || status[0] === 'C'
    if (renamed) {
      if (index + 2 >= fields.length) malformedGitOutput('diff --name-status -z (rename pair)', output)
      index += 1
      const origPath = fields[index]
      index += 1
      const path = fields[index]
      if (!origPath || !path) malformedGitOutput('diff --name-status -z (rename pair)', output)
      changes.push({ status, path, origPath })
    } else {
      index += 1
      const path = fields[index]
      if (!path) malformedGitOutput('diff --name-status -z (path)', output)
      changes.push({ status, path, origPath: null })
    }
  }
  return changes
}

/**
 * Structured worktree changes for a checkout. Unlike `git()`, this preserves
 * rename sources and never normalizes path bytes.
 * @param {string} cwd
 * @param {GitOptions} [options]
 * @returns {Promise<GitPathChange[]>}
 */
export async function worktreeChanges(cwd, options) {
  return parseWorktreeChanges(await gitRaw(cwd, ['status', '--porcelain=v1', '-z'], options))
}

/**
 * Structured changes for a revision range (`base..tip`), with rename and copy
 * detection so both sides of a move are reported.
 * @param {string} cwd
 * @param {string} range
 * @param {GitOptions} [options]
 * @returns {Promise<GitPathChange[]>}
 */
export async function diffChanges(cwd, range, options) {
  if (typeof range !== 'string' || range.trim().length === 0) {
    throw new TypeError('diff range must be a non-empty string')
  }
  return parseNameStatusChanges(
    await gitRaw(
      cwd,
      ['diff', '--name-status', '-z', '--find-renames', '--find-copies', '--no-relative', '--no-ext-diff', range],
      options,
    ),
  )
}

/**
 * Resolve an absolute caller path to the repository root, its common git dir
 * (shared by all worktrees), and the current branch of that checkout.
 * @param {string} repoRoot
 * @returns {Promise<{ root: string, commonDir: string, branch: string | null }>}
 */
export async function resolveRepo(repoRoot) {  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    throw new TowerToolError('repo-invalid', 'repoRoot is required')
  }
  if (!path.isAbsolute(repoRoot)) {
    throw new TowerToolError('repo-invalid', `repoRoot must be an absolute path: ${repoRoot}`)
  }
  let top
  try {
    top = await git(repoRoot, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    throw new TowerToolError('repo-invalid', `not a git repository: ${repoRoot}`, { cause: error })
  }
  const root = path.resolve(top)
  let commonRaw
  try {
    commonRaw = await git(root, ['rev-parse', '--git-common-dir'])
  } catch (error) {
    throw new TowerToolError('repo-invalid', `not a git repository: ${root}`, { cause: error })
  }
  const commonDir = path.isAbsolute(commonRaw)
    ? path.resolve(commonRaw)
    : path.resolve(root, commonRaw)
  const branch = await tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return {
    root,
    commonDir,
    branch: branch && branch.trim() ? branch.trim() : null,
  }
}

/**
 * Synchronously best-effort resolve the common git dir of a working directory
 * (#161 D4): walk up for `.git` — a directory is its own common dir, a file is
 * a worktree pointer whose `gitdir:` line names the common dir. The mode guard
 * is a synchronous call, so it cannot spawn `git rev-parse`; the authoritative
 * resolution for every tool path stays `resolveRepo`. Returns null when no
 * `.git` is found on the way up.
 * @param {string} cwd
 * @returns {string | null}
 */
export function resolveCommonDirSync(cwd) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0 || !path.isAbsolute(cwd)) return null
  let dir = path.resolve(cwd)
  if (fs.statSync(dir, { throwIfNoEntry: false })?.isFile() === true) dir = path.dirname(dir)
  while (true) {
    const dotGit = path.join(dir, '.git')
    const info = fs.statSync(dotGit, { throwIfNoEntry: false })
    if (info?.isDirectory()) return dotGit
    if (info?.isFile()) {
      try {
        const text = fs.readFileSync(dotGit, 'utf8')
        const match = /gitdir:\s*(\S+)/.exec(text)
        const target = match ? match[1].replace(/\/+$/, '') : ''
        if (!target) return null
        let gitDir = path.isAbsolute(target) ? path.resolve(target) : path.resolve(dir, target)
        // A worktree's gitdir is per-worktree; the common dir every Tower
        // record shares lives behind its `commondir` pointer (relative to
        // the gitdir it sits in), exactly as `git rev-parse
        // --git-common-dir` resolves it.
        const commonPointer = path.join(gitDir, 'commondir')
        if (fs.statSync(commonPointer, { throwIfNoEntry: false })?.isFile() === true) {
          const common = fs.readFileSync(commonPointer, 'utf8').trim()
          if (common) gitDir = path.resolve(gitDir, common)
        }
        return gitDir
      } catch {
        return null
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** @param {string} root @returns {Promise<boolean>} */
export async function hasAnyCommit(root) {
  const out = await tryGit(root, ['rev-list', '-n', '1', '--all'])
  return Boolean(out && out.trim())
}

/** @param {string} root @param {string} branch @returns {Promise<boolean>} */
export async function localBranchExists(root, branch) {
  const out = await tryGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  return out !== null
}

/** @param {string} cwd @param {string} ref @returns {Promise<string>} */
export async function revParse(cwd, ref) {
  const out = await git(cwd, ['rev-parse', ref])
  return out.trim()
}

/** @param {string} cwd @param {string} branch @returns {Promise<boolean>} */
export async function branchExists(cwd, branch) {
  return (await localBranchExists(cwd, branch)) === true
}

/** @param {string} cwd @returns {Promise<string | null>} */
export async function currentBranch(cwd) {
  const out = await tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return out && out.trim() ? out.trim() : null
}

export async function addWorktree(cwd, { path: worktreePath, branch, commit }) {
  await git(cwd, ['worktree', 'add', '-b', branch, worktreePath, commit])
  return worktreePath
}

/** @param {string} cwd @returns {Promise<WorktreeEntry[]>} */
export async function listWorktrees(cwd) {
  const out = await git(cwd, ['worktree', 'list', '--porcelain'])
  /** @type {WorktreeEntry[]} */
  const entries = []
  /** @type {WorktreeEntry | null} */
  let current = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length) }
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    }
  }
  if (current) entries.push(current)
  return entries
}

/** @param {string} cwd @returns {Promise<boolean>} */
export async function isClean(cwd) {
  const out = await git(cwd, ['status', '--porcelain'])
  return out.trim().length === 0
}

/** @param {string} cwd @returns {Promise<string | null>} */
export async function currentCommonDir(cwd) {
  const raw = await tryGit(cwd, ['rev-parse', '--git-common-dir'])
  if (raw === null) return null
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw)
}

/** @param {string} cwd @param {string} fromRef @returns {Promise<number>} */
export async function countCommits(cwd, fromRef) {
  const out = await git(cwd, ['rev-list', '--count', `${fromRef}..HEAD`])
  return Number(out.trim() || 0)
}

/** @param {string} cwd @param {string} ancestor @param {string} descendant @returns {Promise<boolean>} */
export async function isAncestor(cwd, ancestor, descendant) {
  const out = await tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
  return out !== null
}
