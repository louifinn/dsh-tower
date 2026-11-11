// Structured Git readers (#M57): porcelain -z worktree changes and
// name-status -z diffs retain both sides of a rename and never parse display
// text, so spaces, non-ASCII and case-only paths survive unchanged.
//
// Run with: node --test tests/git-structured.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import {
  diffChanges,
  parseNameStatusChanges,
  parseWorktreeChanges,
  worktreeChanges,
} from '../adapters/git.js'
import { createVcsPort } from '../adapters/vcs-git.js'
import { assertVcsPort, VCS_OPTIONAL_METHODS } from '../ports/vcs.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// ---------------------------------------------------------------------------
// Pure parsers: these are the grammar of `-z`, independent of the filesystem
// ---------------------------------------------------------------------------

test('parseWorktreeChanges: keeps XY status and both rename sides', () => {
  const output =
    ' M src/modified.txt\0' +
    'A  src/added.txt\0' +
    '?? docs/新 文件.txt\0' +
    'R  src/new name.txt\0docs/旧 文件.txt\0' +
    'RM src/edited rename.txt\0src/original.txt\0' +
    'C  src/copied.txt\0src/original.txt\0'
  assert.deepEqual(parseWorktreeChanges(output), [
    { status: ' M', path: 'src/modified.txt', origPath: null },
    { status: 'A ', path: 'src/added.txt', origPath: null },
    { status: '??', path: 'docs/新 文件.txt', origPath: null },
    { status: 'R ', path: 'src/new name.txt', origPath: 'docs/旧 文件.txt' },
    { status: 'RM', path: 'src/edited rename.txt', origPath: 'src/original.txt' },
    { status: 'C ', path: 'src/copied.txt', origPath: 'src/original.txt' },
  ])
})

test('parseWorktreeChanges: -z output is never unquoted or newline-normalized', () => {
  // Under -z Git does not C-quote: quotes, backslashes, CJK and even newlines
  // inside a path are literal bytes. Only NUL separates fields.
  const output = ' M src/"quoted".txt\0 M src/中文.txt\0 M src/line\nbreak.txt\0'
  assert.deepEqual(parseWorktreeChanges(output), [
    { status: ' M', path: 'src/"quoted".txt', origPath: null },
    { status: ' M', path: 'src/中文.txt', origPath: null },
    { status: ' M', path: 'src/line\nbreak.txt', origPath: null },
  ])
})

test('parseWorktreeChanges: empty output means a clean checkout', () => {
  assert.deepEqual(parseWorktreeChanges(''), [])
})

test('parseWorktreeChanges: malformed framing fails loudly instead of misparsing', () => {
  assert.throws(() => parseWorktreeChanges('R  src/new.txt\0'), /malformed git status/)
  assert.throws(() => parseWorktreeChanges('nonsense\0'), /malformed git status/)
  assert.throws(() => parseWorktreeChanges('R  \0src/old.txt\0'), /malformed git status/)
})

test('parseNameStatusChanges: rename and copy entries name origin then destination', () => {
  const output =
    'M\0src/modified.txt\0' +
    'A\0docs/新 文件.txt\0' +
    'R100\0docs/旧 文件.txt\0src/new name.txt\0' +
    'C075\0src/original.txt\0src/copied.txt\0' +
    'D\0src/gone.txt\0'
  assert.deepEqual(parseNameStatusChanges(output), [
    { status: 'M', path: 'src/modified.txt', origPath: null },
    { status: 'A', path: 'docs/新 文件.txt', origPath: null },
    { status: 'R100', path: 'src/new name.txt', origPath: 'docs/旧 文件.txt' },
    { status: 'C075', path: 'src/copied.txt', origPath: 'src/original.txt' },
    { status: 'D', path: 'src/gone.txt', origPath: null },
  ])
})

test('parseNameStatusChanges: tolerates a missing final NUL and rejects bad pairs', () => {
  assert.deepEqual(parseNameStatusChanges('M\0src/a.txt'), [
    { status: 'M', path: 'src/a.txt', origPath: null },
  ])
  assert.throws(() => parseNameStatusChanges('R100\0src/old.txt\0'), /malformed git diff/)
  assert.throws(() => parseNameStatusChanges('R100\0\0src/new.txt\0'), /malformed git diff/)
  assert.throws(() => parseNameStatusChanges('wat\0src/a.txt\0'), /malformed git diff/)
})

// ---------------------------------------------------------------------------
// Real repository: the emitted -z framing, including case-only renames
// ---------------------------------------------------------------------------

function seedRepo(prefix = 'dsh-tower-git-structured-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'space name.txt'), 'space\n')
  fs.writeFileSync(path.join(repo, 'src', '中文 文件.txt'), 'cjk\n')
  fs.writeFileSync(path.join(repo, 'café.txt'), 'cafe\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

test('worktreeChanges: reports spaces, CJK and case-only renames without quoting', async () => {
  const { root, repo } = seedRepo()
  try {
    const base = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['mv', 'src/space name.txt', 'src/renamed name.txt'])
    git(repo, ['mv', 'café.txt', 'Café.txt'])
    fs.writeFileSync(path.join(repo, 'src', '新 文件.txt'), 'new\n')

    const changes = await worktreeChanges(repo)
    const byPath = new Map(changes.map((change) => [change.path, change]))

    const space = byPath.get('src/renamed name.txt')
    assert.ok(space, JSON.stringify(changes))
    assert.equal(space.origPath, 'src/space name.txt')
    assert.match(space.status, /R/)

    // A case-only rename is a rename, and both spellings are retained exactly.
    const cafe = byPath.get('Café.txt')
    assert.ok(cafe, JSON.stringify(changes))
    assert.equal(cafe.origPath, 'café.txt')
    assert.match(cafe.status, /R/)

    const fresh = byPath.get('src/新 文件.txt')
    assert.ok(fresh, JSON.stringify(changes))
    assert.equal(fresh.status, '??')
    assert.equal(fresh.origPath, null)
    assert.equal(changes.some((change) => /\\303|"/.test(change.path)), false, 'paths must not be C-quoted')

    // The staged form of the same worktree must diff as renames too.
    const committed = await diffChanges(repo, `${base}..HEAD`)
    assert.deepEqual(committed, [], 'staged but uncommitted changes are outside a commit range')

    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'rename and add'])
    const diff = await diffChanges(repo, `${base}..HEAD`)
    const diffByPath = new Map(diff.map((change) => [change.path, change]))
    assert.equal(diffByPath.get('src/renamed name.txt')?.origPath, 'src/space name.txt')
    assert.equal(diffByPath.get('Café.txt')?.origPath, 'café.txt')
    assert.match(diffByPath.get('src/renamed name.txt')?.status ?? '', /^R/)
    assert.equal(diffByPath.get('src/新 文件.txt')?.status, 'A')
    assert.equal(diff.some((change) => change.path.includes('"')), false, 'paths must stay unquoted')
  } finally {
    removeTemp(root)
  }
})

test('worktreeChanges: a clean checkout reports no changes', async () => {
  const { root, repo } = seedRepo('dsh-tower-git-clean-')
  try {
    assert.deepEqual(await worktreeChanges(repo), [])
  } finally {
    removeTemp(root)
  }
})

test('diffChanges: refuses an empty revision range', async () => {
  const { root, repo } = seedRepo('dsh-tower-git-range-')
  try {
    await assert.rejects(() => diffChanges(repo, ''), /diff range/)
    await assert.rejects(() => diffChanges(repo, '   '), /diff range/)
  } finally {
    removeTemp(root)
  }
})

// The declaration in ports/vcs.js only protects production if the shipped
// adapter actually implements both readers with the documented entry shape.
test('the shipped git vcs port implements the optional structured readers', async () => {
  const { root, repo } = seedRepo('dsh-tower-git-vcs-port-')
  try {
    const vcs = createVcsPort()
    assert.doesNotThrow(() => assertVcsPort(vcs))
    for (const method of VCS_OPTIONAL_METHODS) {
      assert.equal(typeof vcs[method], 'function', `createVcsPort().${method} must be a function`)
    }

    const base = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['mv', 'README.md', 'README renamed.md'])
    fs.writeFileSync(path.join(repo, 'src', 'new file.txt'), 'new\n')

    const worktree = await vcs.worktreeChanges(repo)
    const renamed = worktree.find((change) => change.path === 'README renamed.md')
    assert.ok(renamed, JSON.stringify(worktree))
    assert.equal(renamed.origPath, 'README.md')
    assert.match(renamed.status, /^R/)
    const added = worktree.find((change) => change.path === 'src/new file.txt')
    assert.ok(added, JSON.stringify(worktree))
    assert.equal(added.origPath, null)
    assert.equal(added.status, '??')
    for (const change of worktree) {
      assert.deepEqual(Object.keys(change).sort(), ['origPath', 'path', 'status'])
      assert.equal(typeof change.path, 'string')
      assert.ok(change.origPath === null || typeof change.origPath === 'string')
    }

    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'rename through the vcs port'])
    const diff = await vcs.diffChanges(repo, `${base}..HEAD`)
    const moved = diff.find((change) => change.path === 'README renamed.md')
    assert.ok(moved, JSON.stringify(diff))
    assert.equal(moved.origPath, 'README.md')
    assert.match(moved.status, /^R/)
  } finally {
    removeTemp(root)
  }
})
