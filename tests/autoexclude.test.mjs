// #58: in-repo Tower artifacts are excluded through .git/info/exclude, never .gitignore.
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

function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-exclude-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  const configDir = path.join(repo, '.git', 'dsh-tower')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ docs: { boardLocation: 'repo' } }))
  return { root, repo }
}

test('repo board is auto-excluded, idempotent, and preserves .gitignore/exclude', async () => {
  const { root, repo } = seed()
  try {
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    fs.mkdirSync(path.dirname(exclude), { recursive: true })
    fs.writeFileSync(exclude, '# keep me\nnode_modules/\n')
    const gitignore = path.join(repo, '.gitignore')
    fs.writeFileSync(gitignore, 'dist/\n')
    git(repo, ['add', '.gitignore'])
    git(repo, ['commit', '-m', 'add gitignore'])
    const gitignoreBefore = fs.readFileSync(gitignore, 'utf8')

    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.writeBoard()
    await tower.writeBoard()
    await tower.writeBoard()

    const status = git(repo, ['status', '--porcelain'])
    assert.equal(status, '', `board must not make the repository dirty: ${status}`)
    const lines = fs.readFileSync(exclude, 'utf8').split(/\r?\n/).filter(Boolean)
    assert.equal(lines.filter((line) => line === 'MISSIONS.md').length, 1)
    assert.deepEqual(lines.slice(0, 2), ['# keep me', 'node_modules/'])
    assert.equal(fs.readFileSync(gitignore, 'utf8'), gitignoreBefore, '.gitignore stays untouched')
  } finally {
    removeTemp(root)
  }
})
