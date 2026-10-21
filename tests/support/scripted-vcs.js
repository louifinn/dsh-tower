// Scripted in-memory VCS replacement for lib/git.js (#50): the git surface
// Tower calls through its own methods:
//
//   git(cwd, args)                  -> scripted command dispatch
//   tryGit(cwd, args)               -> git() | null
//   revParse(cwd, ref)              -> sha
//   isClean(cwd)                    -> boolean
//   isAncestor(cwd, a, b)           -> boolean
//
// There is no child_process import and no `git` binary: every command runs
// against a tiny commit graph in memory. Unknown commands are rejected and
// recorded in `vcs.unscripted`, so a lifecycle cannot silently fall through to
// real git. Tests script the graph with seed()/commit()/setDirty() and assert on
// `vcs.calls`; the helpers are test-only and are NOT part of the vcs port.
const SHA_LENGTH = 40
const DEFAULT_ROOT = '/virtual/repo'

function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('path must be a non-empty string')
  const slashed = value.replace(/\\/g, '/')
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
}

/** Shaped like domain/errors.js GitError so classifyError can still classify it. */
export class ScriptedGitError extends Error {
  constructor(args, detail) {
    super(`git ${args.join(' ')} failed: ${detail}`)
    this.name = 'GitError'
    this.args = [...args]
    this.stderr = String(detail)
  }
}

function gitFailure(args, detail) {
  return new ScriptedGitError(args, detail)
}

/**
 * @param {{ repoRoot?: string, branch?: string }} [options]
 */
export function createScriptedVcs(options = {}) {
  const repoRoot = normalizePath(options.repoRoot ?? DEFAULT_ROOT)
  let currentBranch = options.branch ?? 'main'
  const branches = new Map()
  const commits = new Map()
  const worktrees = new Map()
  const refs = new Map()
  const dirty = new Map()
  const calls = []
  const unscripted = []
  let commitSeq = 0
  let seeded = false

  function addCommit({ branch, parents, message }) {
    commitSeq += 1
    const sha = commitSeq.toString(16).padStart(SHA_LENGTH, '0')
    commits.set(sha, { sha, parents: [...parents], message: String(message ?? ''), branch, seq: commitSeq })
    branches.set(branch, sha)
    return sha
  }

  function branchAt(cwd) {
    const target = normalizePath(cwd)
    if (target === repoRoot) return currentBranch
    const worktree = worktrees.get(target)
    if (worktree) return worktree.branch
    throw gitFailure([], `not a scripted worktree: ${target}`)
  }

  function headAt(cwd) {
    const branch = branchAt(cwd)
    const sha = branches.get(branch)
    if (!sha) throw gitFailure([], `branch ${branch} has no tip`)
    return sha
  }

  function resolveRef(cwd, ref) {
    if (ref === undefined || ref === null || ref === '' || ref === 'HEAD') return headAt(cwd)
    let name = String(ref)
    if (name.endsWith('^{commit}')) name = name.slice(0, -'^{commit}'.length)
    if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length)
    if (branches.has(name)) return branches.get(name)
    if (commits.has(name)) return name
    throw gitFailure(['rev-parse', name], `unknown scripted ref: ${name}`)
  }

  function resolveGraphRef(ref) {
    const name = String(ref)
    if (branches.has(name)) return branches.get(name)
    if (commits.has(name)) return name
    throw new Error(`unknown scripted commit: ${name}`)
  }

  function reachableCommits(start) {
    const seen = new Set()
    const stack = [start]
    while (stack.length > 0) {
      const sha = stack.pop()
      if (seen.has(sha)) continue
      seen.add(sha)
      const commit = commits.get(sha)
      if (commit) stack.push(...commit.parents)
    }
    return seen
  }

  function isAncestorCommit(ancestor, descendant) {
    const a = resolveGraphRef(ancestor)
    const d = resolveGraphRef(descendant)
    if (a === d) return true
    return reachableCommits(d).has(a)
  }

  function revParseCommand(cwd, args) {
    const rest = args.slice(1)
    if (rest.includes('--show-toplevel')) return repoRoot
    if (rest.includes('--git-common-dir')) return `${repoRoot}/.git`
    const ref = rest.find((arg) => !arg.startsWith('-'))
    return resolveRef(cwd, ref)
  }

  function statusCommand(cwd) {
    return (dirty.get(normalizePath(cwd)) ?? []).join('\n')
  }

  function mergeBaseCommand(cwd, args) {
    const rest = args.slice(1)
    if (rest[0] !== '--is-ancestor') throw gitFailure(args, 'scripted vcs supports only merge-base --is-ancestor')
    const ancestor = resolveRef(cwd, rest[1])
    const descendant = resolveRef(cwd, rest[2])
    if (!isAncestorCommit(ancestor, descendant)) {
      const error = gitFailure(args, 'exit status 1')
      error.exitCode = 1
      throw error
    }
    return ''
  }

  function mergeCommand(cwd, args) {
    const rest = args.slice(1)
    if (!rest.includes('--no-ff')) throw gitFailure(args, 'scripted vcs supports only merge --no-ff')
    const messageIndex = rest.indexOf('-m')
    const message = messageIndex >= 0 ? rest[messageIndex + 1] : 'merge'
    const positional = rest.filter((arg, index) => {
      if (arg.startsWith('-')) return false
      if (messageIndex >= 0 && index === messageIndex + 1) return false
      return true
    })
    const target = resolveRef(cwd, positional[0])
    const branch = branchAt(cwd)
    const head = headAt(cwd)
    addCommit({ branch, parents: [head, target], message })
    return ''
  }

  function worktreeCommand(cwd, args) {
    const action = args[1]
    if (action === 'add') {
      const flagIndex = args.indexOf('-b')
      if (flagIndex < 0) throw gitFailure(args, 'scripted vcs requires worktree add -b <branch> <path> <commit>')
      const branch = args[flagIndex + 1]
      const worktreePath = normalizePath(args[flagIndex + 2])
      const commit = resolveRef(cwd, args[flagIndex + 3])
      if (branches.has(branch)) throw gitFailure(args, `branch already exists: ${branch}`)
      if (worktrees.has(worktreePath)) throw gitFailure(args, `worktree already exists: ${worktreePath}`)
      branches.set(branch, commit)
      worktrees.set(worktreePath, { path: worktreePath, branch })
      return ''
    }
    if (action === 'remove') {
      const worktreePath = normalizePath(args[args.length - 1])
      if (!worktrees.has(worktreePath)) throw gitFailure(args, `no such worktree: ${worktreePath}`)
      worktrees.delete(worktreePath)
      return ''
    }
    if (action === 'list') {
      const rows = [`worktree ${repoRoot}`, `HEAD ${headAt(repoRoot)}`, `branch refs/heads/${currentBranch}`]
      for (const worktree of worktrees.values()) {
        rows.push(`worktree ${worktree.path}`, `HEAD ${headAt(worktree.path)}`, `branch refs/heads/${worktree.branch}`)
      }
      return rows.join('\n')
    }
    throw gitFailure(args, `unsupported scripted worktree command: ${String(action)}`)
  }

  function branchCommand(cwd, args) {
    const [, flag, name] = args
    if (flag !== '-d' && flag !== '-D') throw gitFailure(args, 'scripted vcs supports only branch -d/-D <name>')
    if (!branches.has(name)) throw gitFailure(args, `branch not found: ${name}`)
    for (const worktree of worktrees.values()) {
      if (worktree.branch === name) throw gitFailure(args, `cannot delete branch checked out at ${worktree.path}`)
    }
    if (flag === '-d' && !isAncestorCommit(branches.get(name), headAt(cwd))) {
      throw gitFailure(args, `branch ${name} is not fully merged`)
    }
    branches.delete(name)
    return ''
  }

  function revListCommand(cwd, args) {
    const rest = args.slice(1)
    if (rest.includes('--parents')) {
      const sha = resolveRef(cwd, rest[rest.length - 1])
      const commit = commits.get(sha)
      return [sha, ...(commit?.parents ?? [])].join(' ')
    }
    if (rest.includes('--count')) {
      const range = rest[rest.length - 1]
      const [fromRef, toRef] = range.split('..')
      const to = toRef ? resolveRef(cwd, toRef) : headAt(cwd)
      const reachable = reachableCommits(to)
      const excluded = fromRef ? reachableCommits(resolveRef(cwd, fromRef)) : new Set()
      return String([...reachable].filter((sha) => !excluded.has(sha)).length)
    }
    if (rest.includes('--merges')) {
      const rev = resolveRef(cwd, rest[rest.length - 1])
      return [...reachableCommits(rev)]
        .filter((sha) => (commits.get(sha)?.parents.length ?? 0) >= 2)
        .join('\n')
    }
    if (rest.includes('--all')) return commits.size > 0 ? [...commits.keys()].join('\n') : ''
    return resolveRef(cwd, rest[rest.length - 1])
  }

  function catFileCommand(cwd, args) {
    const rest = args.slice(1)
    if (rest[0] !== '-e') throw gitFailure(args, 'scripted vcs supports only cat-file -e')
    resolveRef(cwd, rest[1])
    return ''
  }

  function showRefCommand(cwd, args) {
    const ref = args[args.length - 1]
    const name = String(ref).startsWith('refs/heads/') ? String(ref).slice('refs/heads/'.length) : String(ref)
    if (!branches.has(name)) throw gitFailure(args, `no such ref: ${ref}`)
    return ''
  }

  function symbolicRefCommand(cwd, args) {
    if (!args.includes('HEAD')) throw gitFailure(args, 'scripted vcs supports only symbolic-ref HEAD')
    return branchAt(cwd)
  }

  function forEachRefCommand(_cwd, args) {
    const prefixArg = args.find((arg, index) => index > 0 && !arg.startsWith('--'))
    const prefix = prefixArg ?? ''
    const names = [...branches.keys()].map((name) => `refs/heads/${name}`)
    return [...names, ...refs.keys()].filter((name) => name.startsWith(prefix)).join('\n')
  }

  function updateRefCommand(cwd, args) {
    const rest = args.slice(1)
    if (rest[0] === '-d') {
      refs.delete(rest[1])
      return ''
    }
    const [name, value] = rest
    if (!name || !value) throw gitFailure(args, 'unsupported update-ref form')
    refs.set(name, resolveRef(cwd, value))
    return ''
  }

  function resetCommand(cwd, args) {
    const rest = args.slice(1)
    const sha = resolveRef(cwd, rest[rest.length - 1])
    branches.set(branchAt(cwd), sha)
    return ''
  }

  const COMMANDS = {
    'rev-parse': revParseCommand,
    status: statusCommand,
    'merge-base': mergeBaseCommand,
    merge: mergeCommand,
    worktree: worktreeCommand,
    branch: branchCommand,
    'rev-list': revListCommand,
    'cat-file': catFileCommand,
    'show-ref': showRefCommand,
    'symbolic-ref': symbolicRefCommand,
    'for-each-ref': forEachRefCommand,
    'update-ref': updateRefCommand,
    'ls-files': () => '',
    reset: resetCommand,
  }

  async function git(cwd, args, callOptions = {}) {
    if (!Array.isArray(args)) throw new TypeError('scripted vcs git(cwd, args): args must be an array')
    const call = { cwd: normalizePath(cwd), args: [...args], options: { ...callOptions } }
    calls.push(call)
    const handler = COMMANDS[args[0]]
    if (!handler) {
      unscripted.push(call)
      throw gitFailure(args, `unsupported scripted git command: ${String(args[0])}`)
    }
    const output = handler(call.cwd, args)
    return String(output ?? '')
      .replace(/\r\n/g, '\n')
      .trimEnd()
  }

  async function tryGit(cwd, args, callOptions) {
    try {
      return await git(cwd, args, callOptions)
    } catch {
      return null
    }
  }

  async function revParse(cwd, ref) {
    return (await git(cwd, ['rev-parse', ref])).trim()
  }

  async function isClean(cwd) {
    return (await git(cwd, ['status', '--porcelain'])).trim().length === 0
  }

  async function isAncestor(cwd, ancestor, descendant) {
    return (await tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])) !== null
  }

  // ---- test-only scripting helpers (not part of the vcs port) ----------------

  function seed(seedOptions = {}) {
    if (seeded) throw new Error('scripted vcs is already seeded')
    seeded = true
    currentBranch = seedOptions.branch ?? currentBranch
    return addCommit({ branch: currentBranch, parents: [], message: seedOptions.message ?? 'seed' })
  }

  /** Model an external actor writing and committing in a checkout. */
  function commit(cwd, message = 'work') {
    const branch = branchAt(cwd)
    return addCommit({ branch, parents: [headAt(cwd)], message })
  }

  function setDirty(cwd, entries = [' M work.txt']) {
    dirty.set(normalizePath(cwd), Array.isArray(entries) ? entries.slice() : [String(entries)])
  }

  return {
    repoRoot,
    git,
    tryGit,
    revParse,
    isClean,
    isAncestor,
    // scripting/inspection helpers
    seed,
    commit,
    setDirty,
    isAncestorCommit,
    branchTip(name) {
      return branches.get(name) ?? null
    },
    mergeParents(sha) {
      return [...(commits.get(sha)?.parents ?? [])]
    },
    worktreePaths() {
      return [...worktrees.keys()]
    },
    calls,
    unscripted,
  }
}
