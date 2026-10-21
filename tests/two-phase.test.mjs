// #51 pilot: complete prepares outside the lock and commits only on the same
// state revision.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Tower } from '../lib/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-two-phase-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

test('complete rejects a state revision change prepared outside the lock', async () => {
  const { root, repo } = seed()
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-agent' })
    await tower.plan({ missions: [{ title: 'Two phase', scope: ['x/**'] }] })
    tower.checkCompletion = async () => ({
      state: { revision: 0 },
      mission: { id: 'M1' },
      worker: { name: 'worker-m1' },
      commits: 1,
    })
    await assert.rejects(
      () => tower.complete({ missionId: 'M1', agentId: 'worker-m1', report: 'done', checks: [] }),
      (error) => {
        assert.equal(error.code, 'stale-base')
        return true
      },
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('complete commits when the prepared revision is still current', async () => {
  const { root, repo } = seed()
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-agent' })
    await tower.plan({ missions: [{ title: 'Two phase ok', scope: ['x/**'] }] })
    const state = await tower.load()
    tower.checkCompletion = async () => ({
      state: { revision: state.revision },
      mission: { id: 'M1' },
      worker: { name: 'worker-m1' },
      commits: 1,
    })
    const result = await tower.complete({ missionId: 'M1', agentId: 'worker-m1', report: 'done', checks: [] })
    assert.equal(result.mission.status, 'completed')
    assert.equal((await tower.load()).missions[0].status, 'completed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('recordSpawn captures the spawn tip outside the state lock', async () => {
  const { root, repo } = seed()
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-agent' })
    await tower.plan({ missions: [{ title: 'Spawn prepare', scope: ['x/**'] }] })
    let sawLock = null
    tower.tryGit = async () => {
      const fsmod = await import('node:fs')
      sawLock = fsmod.existsSync(tower.paths.lock)
      return 'abc123\n'
    }
    const entry = await tower.recordSpawn({
      missionId: 'M1', name: 'worker-m1', role: 'worker', agentId: 'agent-1',
      parentSessionId: 'parent-1', cwd: repo, branch: 'b',
    })
    assert.equal(sawLock, false)
    assert.equal(entry.spawnTip, 'abc123')
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
