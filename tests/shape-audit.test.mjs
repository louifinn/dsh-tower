// Shape audit (#149): the ongoing fitness function that keeps generic layers
// from branching on a kind/role or re-introducing the global status vocabulary.
// Run with: node --test tests/shape-audit.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import { applyWaivers, evaluator, inspectSource, loadShapeWaivers } from '../scripts/shape-audit.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-shape-audit-'))
  const write = (relative, source) => {
    const file = path.join(dir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, source)
  }
  write(
    'scripts/architecture-waivers.json',
    JSON.stringify({ waivers: [], shapeWaivers: [] }, null, 2),
  )
  return { dir, write }
}

test('the original shape-audit rules fail on a seeded fixture', () => {
  const violations = inspectSource(
    [
      "if (mission.kind === 'survey') return",
      "if (role !== 'reviewer') return",
      'const terminal = TERMINAL_STATUSES.has(status)',
      "isTerminal(mission.status)",
      "canTransition('planned', 'active')",
      "shape.isTerminal(status) // legitimate method call",
      "// kind === 'survey' in documentation is not code",
    ].join('\n'),
  )
  const rules = violations.map((violation) => violation.rule)
  assert.deepEqual(rules.sort(), ['global-status-vocabulary', 'kind-literal', 'role-literal', 'shape-entry-point', 'shape-entry-point'])
  // The negative lookbehind keeps a shape method call legal, so a registry
  // consumer cannot be mistaken for the deleted one-argument global helper.
  assert.equal(
    violations.some((violation) => /line 6:/.test(violation.detail)),
    false,
  )
})

test('the repository audit is green with no unjustified waivers', () => {
  const result = evaluator(root)
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(result.waived, [])
  assert.deepEqual(result.unused, [])
  const waivers = loadShapeWaivers(root)
  assert.deepEqual(waivers.errors, [])
  assert.deepEqual(waivers.waivers, [], 'no waiver is planned for this redesign')
})

test('a violation in a generic layer fails the audit; domain/shapes is exempt', () => {
  const { dir, write } = fixtureRepo()
  try {
    write('domain/app/plan.js', "export const isSurvey = (mission) => mission.kind === 'survey'\n")
    const failing = spawnSync(process.execPath, ['scripts/shape-audit.mjs', '--root', dir], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(failing.status, 1)
    assert.match(String(failing.stderr), /\[kind-literal\] domain\/app\/plan\.js/)
  } finally {
    removeTemp(dir)
  }

  const exempt = fixtureRepo()
  try {
    exempt.write('domain/shapes/build.js', "export const isSurvey = (mission) => mission.kind === 'survey'\n")
    const result = evaluator(exempt.dir)
    assert.equal(result.ok, true, result.errors.join('\n'))
  } finally {
    removeTemp(exempt.dir)
  }
})

test('the W3 fitness rules fail on a seeded fixture', () => {
  const violations = inspectSource(
    [
      "const tip = await tower.revParse(mission.worktree.path, 'HEAD')",
      "if (batch.status === 'closed') return",
      "const ledger = path.join(commonDir, 'leases.json')",
      "mission.status = 'blocked'",
      // Legitimate forms the rules must not flag:
      "const head = await tower.revParse(reviewer.reviewCheckout, 'HEAD')",
      'const status = BATCH_STATUS.CLOSED',
      'const tip = await tower.branchTip(mission)',
      'markBlocked(mission, conflictNote)',
    ].join('\n'),
  )
  const rules = violations.map((violation) => violation.rule)
  assert.deepEqual(rules.sort(), ['batch-status-literal', 'blocked-status-write', 'lease-ledger', 'review-tip-read'])
  // Only the four seeded lines are violations; the legitimate forms below them
  // (a checkout HEAD, a constant, the branch-tip helper and markBlocked) are not.
  for (const violation of violations) {
    assert.match(violation.detail, /^line [1-4]:/)
  }
})

test('the W3 owner modules are exempt and every other layer is not', () => {
  const exempt = fixtureRepo()
  try {
    exempt.write('domain/batch.js', "export const isClosed = (batch) => batch.status === 'closed'\n")
    exempt.write('adapters/leases.js', "export const ledger = 'leases.json'\n")
    exempt.write('domain/missions/lifecycle.js', "export const block = (mission) => { mission.status = 'blocked' }\n")
    const result = evaluator(exempt.dir)
    assert.equal(result.ok, true, result.errors.join('\n'))
  } finally {
    removeTemp(exempt.dir)
  }

  const violating = fixtureRepo()
  try {
    violating.write('app/batch.js', "export const isClosed = (batch) => batch.status === 'closed'\n")
    violating.write('app/lease.js', "export const ledger = 'leases.json'\n")
    violating.write('app/merge.js', "export const block = (mission) => { mission.status = 'blocked' }\n")
    const result = evaluator(violating.dir)
    assert.equal(result.ok, false)
    const rules = result.violations.map((violation) => violation.rule).sort()
    assert.deepEqual(rules, ['batch-status-literal', 'blocked-status-write', 'lease-ledger'])
  } finally {
    removeTemp(violating.dir)
  }
})

test('the W4 fitness rules fail on a seeded fixture', () => {
  const violations = inspectSource(
    [
      'const checks = mission.completionReport?.checks ?? []',
      'const runs = mission.testRuns',
      "if (snapshot.format === 'tower-codex') return",
      'for (const id of snapshot.pausedIds) ids.add(id)',
      'const out = mission.scope.some((glob) => fileInScope(glob, file))',
      'const canReview = isReviewerRole(role) && shape.canMerge',
      // Legitimate forms the rules must not flag:
      "const found = findEvidence(contract, mission, 'check')",
      'const fence = scopeFenceBlocker({ mission, reach: shape.reach, changedFiles })',
      'const contract = roleContract(role)',
    ].join('\n'),
  )
  const rules = violations.map((violation) => violation.rule)
  assert.deepEqual(rules.sort(), [
    'evidence-single-read',
    'evidence-single-read',
    'legacy-vocabulary',
    'legacy-vocabulary',
    'role-shape-conflation',
    'scope-reach',
  ])
  for (const violation of violations) {
    assert.match(violation.detail, /^line [1-6]:/)
  }
})

test('the W4 owner modules are exempt and every other layer is not', () => {
  const exempt = fixtureRepo()
  try {
    exempt.write('domain/evidence.js', 'export const runs = (mission) => mission.testRuns\n')
    exempt.write('adapters/legacy.js', "export const format = 'tower-codex'\nexport const paused = (snapshot) => snapshot.pausedIds\n")
    exempt.write('domain/scope.js', 'export const fence = (mission, file) => fileInScope(mission.scope, file)\n')
    exempt.write('domain/roles.js', 'export const canReview = (role, shape) => isReviewerRole(role) && shape.canMerge\n')
    exempt.write('app/recording.js', 'export const record = (mission, receipt) => mission.testRuns.push(receipt)\n')
    exempt.write('domain/summary.js', 'export const summary = (mission) => mission.testRuns\n')
    exempt.write('domain/state/schema.js', 'export const check = (mission) => mission.testRuns !== undefined\n')
    const result = evaluator(exempt.dir)
    assert.equal(result.ok, true, result.errors.join('\n'))
  } finally {
    removeTemp(exempt.dir)
  }

  const violating = fixtureRepo()
  try {
    violating.write('app/checks.js', 'export const checks = (mission) => mission.testRuns\n')
    violating.write('app/import.js', "export const format = 'tower-codex'\n")
    violating.write('app/fence.js', 'export const owns = (mission) => mission.ownsScope\n')
    violating.write('app/spawn.js', 'export const canReview = (role, shape) => isReviewerRole(role) && shape.canMerge\n')
    const result = evaluator(violating.dir)
    assert.equal(result.ok, false)
    const rules = result.violations.map((violation) => violation.rule).sort()
    assert.deepEqual(rules, ['evidence-single-read', 'legacy-vocabulary', 'role-shape-conflation', 'scope-reach'])
  } finally {
    removeTemp(violating.dir)
  }
})

test('a waiver needs a reason and an owner/ref; a stale waiver fails', () => {
  const violations = [{ path: 'app/gate.js', rule: 'kind-literal', detail: 'line 1: kind === survey' }]
  const applied = applyWaivers(violations, [])
  assert.equal(applied.violations.length, 1)

  const waived = applyWaivers(violations, [
    { rule: 'kind-literal', path: 'app/gate.js', reason: 'temporary bridge', owner: 'architecture' },
  ])
  assert.deepEqual(waived.violations, [])
  assert.deepEqual(waived.waived, violations)
  assert.deepEqual(waived.unused, [])

  const stale = applyWaivers([], [{ rule: 'kind-literal', path: 'app/gate.js', reason: 'gone', ref: '#149' }])
  assert.equal(stale.unused.length, 1)

  const { dir } = fixtureRepo()
  try {
    fs.writeFileSync(
      path.join(dir, 'scripts', 'architecture-waivers.json'),
      JSON.stringify({ shapeWaivers: [{ rule: 'kind-literal', path: 'app/gate.js' }] }, null, 2),
    )
    const loaded = loadShapeWaivers(dir)
    assert.equal(loaded.waivers.length, 0, 'an incomplete waiver is not applied')
    assert.equal(loaded.errors.length, 2)
    assert.ok(loaded.errors.some((error) => /reason is required/.test(error)))
    assert.ok(loaded.errors.some((error) => /owner or ref is required/.test(error)))
  } finally {
    removeTemp(dir)
  }
})
