// Role-contract tests (#163 Phase 5): the tower profile does not mount the
// tools owned by the worker/survey and reviewer roles, and a forged direct call
// fails with an actionable hint instead of an unknown-tool error. Also pins the
// tower_spawn replacement paths for the fields that moved into config/op.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../host/tool-registry.js'
import { ROLE_TOOLS, roleAllowsTool, roleDenialHint, roleForAgent, roleForPreset } from '../host/tool-profiles.js'

function makeCtx() {
  const tools = new Map()
  const registrations = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get() {
      return undefined
    },
    tools: {
      register(definition, options) {
        tools.set(definition.name, definition)
        registrations.set(definition.name, options ?? {})
        return () => {}
      },
      guard() {
        return () => {}
      },
      restrict() {},
    },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  registerTowerTools(ctx)
  return { ctx, tools, registrations }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-role-contract-'))
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

function execFor(agentId, agentPreset) {
  return {
    agent: agentPreset ? { id: agentId, session: { header: { agentPreset } } } : { id: agentId },
  }
}

function session(preset) {
  return { id: `${preset}-agent`, session: { header: { agentPreset: preset } } }
}

test('role contract: complete belongs to worker/survey and review to reviewer', () => {
  assert.deepEqual(ROLE_TOOLS.tower_complete, ['worker', 'survey'])
  assert.deepEqual(ROLE_TOOLS.tower_review, ['reviewer'])
  assert.equal(roleForPreset('tower-worker'), 'worker')
  assert.equal(roleForPreset('tower-survey-sandbox'), 'survey')
  assert.equal(roleForPreset('tower-reviewer'), 'reviewer')
  assert.equal(roleForPreset(undefined), null)
  assert.equal(roleForAgent({ session: { header: { agentPreset: 'tower-reviewer' } } }), 'reviewer')
  assert.equal(roleAllowsTool(session('tower-worker'), 'tower_complete'), true)
  assert.equal(roleAllowsTool(session('tower-survey'), 'tower_complete'), true)
  assert.equal(roleAllowsTool(session('tower-worker'), 'tower_review'), false)
  assert.equal(roleAllowsTool(session('tower-reviewer'), 'tower_review'), true)
  assert.equal(roleAllowsTool(undefined, 'tower_complete'), false)
  assert.match(roleDenialHint('tower_complete'), /worker and survey role sessions/)
  assert.match(roleDenialHint('tower_review'), /reviewer role session/)
})

test('role contract: the tower shell hides role-owned tools from the model', () => {
  const { registrations } = makeCtx()
  assert.deepEqual(registrations.get('tower_complete').when({ agent: undefined }), false)
  assert.deepEqual(registrations.get('tower_review').when({ agent: undefined }), false)
  assert.equal(registrations.get('tower_complete').when({ agent: session('tower-worker') }), true)
  assert.equal(registrations.get('tower_complete').when({ agent: session('tower-reviewer') }), false)
  assert.equal(registrations.get('tower_review').when({ agent: session('tower-reviewer') }), true)
  assert.equal(registrations.get('tower_plan').when, undefined)
})

test('role contract: a forged tower_complete call explains the owning role', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, execFor('tower-agent'))
    await tools.get('tower_plan').execute(
      { repoRoot: repo, missions: [{ title: 'Role case', scope: ['src/**'], tasks: ['write it'] }] },
      execFor('tower-agent'),
    )
    await assert.rejects(
      () => tools.get('tower_complete').execute({ repoRoot: repo, missionId: 'M1', report: 'done' }, execFor('tower-agent')),
      (error) => {
        assert.equal(error.code, 'not-authorized')
        assert.match(error.message, /worker and survey role sessions/)
        assert.match(error.message, /tower_spawn/)
        return true
      },
    )
    // tower_review is not mounted for the tower, but the tower break-glass path
    // stays reachable by direct call and still demands its audit reason.
    await assert.rejects(
      () => tools.get('tower_review').execute({ repoRoot: repo, missionId: 'M1', status: 'clean', merge: 'merge', findings: 'none', decision: 'ok' }, execFor('tower-agent')),
      (error) => {
        assert.equal(error.code, 'not-authorized')
        assert.match(error.message, /requires a non-empty breakGlassReason/)
        return true
      },
    )
  } finally {
    removeTemp(root)
  }
})

test('role contract: tower_spawn rejects fields that moved to config/op', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, execFor('tower-agent'))
    await tools.get('tower_plan').execute(
      { repoRoot: repo, missions: [{ title: 'Spawn case', scope: ['src/**'], tasks: ['write it'] }] },
      execFor('tower-agent'),
    )
    await assert.rejects(
      () => tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M1', role: 'worker', takeover: true }, execFor('tower-agent')),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /op: "takeover"/)
        return true
      },
    )
    await assert.rejects(
      () => tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M1', role: 'worker', waitMs: 1000 }, execFor('tower-agent')),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /spawn\.maxWaitMs/)
        return true
      },
    )
  } finally {
    removeTemp(root)
  }
})
