// Scope enforcement across a rename (#M57). A branch must not be able to move
// an out-of-scope file *into* scope and pass the fence: both sides of the
// rename are changed paths, so the source is checked too.
//
// Run with: node --test tests/scope-rename.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { Tower } from '../host/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function writeFiles(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(repo, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}

function seedRepo(prefix, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  writeFiles(repo, files)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

/** Provision M1 in a fresh repo whose base already contains `files`. */
async function provisionedMission({ prefix, files, scope }) {
  const { root, repo } = seedRepo(prefix, files)
  const tower = await Tower.open(repo)
  await tower.init({})
  await tower.plan({ missions: [{ title: 'Rename scope', scope }] })
  const provisioned = await tower.provision({ missionId: 'M1' })
  return { root, repo, tower, wt: provisioned.worktree.path }
}

/** The detected mode is a checkout fact; tests pin it to exercise both branches. */
function setCaseInsensitive(tower, value) {
  const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
  state.caseInsensitive = value
  fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
}

const evaluate = (tower) => tower.evaluateGate({ missionId: 'M1', activity: {} })
const outOfScope = (result) => result.blockers.find((blocker) => blocker.code === 'out-of-scope')

test('scope: moving a file from outside scope into scope still fails on the source', async () => {
  const ctx = await provisionedMission({
    prefix: 'dsh-tower-scope-rename-escape-',
    files: { 'docs/机密 文件.txt': 'secret\n' },
    scope: ['src/**'],
  })
  try {
    setCaseInsensitive(ctx.tower, false)
    fs.mkdirSync(path.join(ctx.wt, 'src'), { recursive: true })
    git(ctx.wt, ['mv', 'docs/机密 文件.txt', 'src/secret.txt'])
    git(ctx.wt, ['commit', '-m', 'move out-of-scope file into scope'])

    const result = await evaluate(ctx.tower)
    assert.ok(
      result.changedFiles.includes('docs/机密 文件.txt'),
      `rename source missing from ${JSON.stringify(result.changedFiles)}`,
    )
    assert.ok(result.changedFiles.includes('src/secret.txt'))
    const blocker = outOfScope(result)
    assert.ok(blocker, 'the source side must keep the mission out of scope')
    assert.match(blocker.detail, /docs\/机密 文件\.txt/)
    assert.match(blocker.detail, /src\/\*\*/)
  } finally {
    removeTemp(ctx.root)
  }
})

test('scope: a rename with both sides in scope passes the fence', async () => {
  const ctx = await provisionedMission({
    prefix: 'dsh-tower-scope-rename-clean-',
    files: { 'src/old.txt': 'same bytes\n' },
    scope: ['src/**'],
  })
  try {
    setCaseInsensitive(ctx.tower, false)
    git(ctx.wt, ['mv', 'src/old.txt', 'src/new.txt'])
    git(ctx.wt, ['commit', '-m', 'rename inside scope'])

    const result = await evaluate(ctx.tower)
    assert.deepEqual([...result.changedFiles].sort(), ['src/new.txt', 'src/old.txt'])
    assert.equal(outOfScope(result), undefined)
  } finally {
    removeTemp(ctx.root)
  }
})

test('scope: a case-mismatched source fails on a case-sensitive checkout and passes when folded', async () => {
  const ctx = await provisionedMission({
    prefix: 'dsh-tower-scope-rename-case-',
    files: { 'SRC/旧.txt': 'same bytes\n' },
    scope: ['src/**'],
  })
  try {
    // On a case-sensitive filesystem `SRC/` and `src/` are different
    // directories, so `git mv` needs the destination directory to exist.
    fs.mkdirSync(path.join(ctx.wt, 'src'), { recursive: true })
    git(ctx.wt, ['mv', 'SRC/旧.txt', 'src/new.txt'])
    git(ctx.wt, ['commit', '-m', 'rename from case-mismatched directory'])

    setCaseInsensitive(ctx.tower, true)
    const folded = await evaluate(ctx.tower)
    assert.equal(outOfScope(folded), undefined, 'case-insensitive checkout folds both sides')

    setCaseInsensitive(ctx.tower, false)
    const exact = await evaluate(ctx.tower)
    const blocker = outOfScope(exact)
    assert.ok(blocker)
    assert.match(blocker.detail, /SRC\/旧\.txt/)
  } finally {
    removeTemp(ctx.root)
  }
})
