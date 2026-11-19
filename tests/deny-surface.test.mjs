// #161 D2: the Tower-mode deny set is owned, not named. This test enumerates
// every foreign-orchestration owner's tools at test time — importing the real
// upstream packages pinned in devDependencies — and asserts the deny surface
// covers all of them, so an upstream addition breaks CI instead of leaking
// past the guard. The same contract as tool-names.test.mjs: cross-surface
// claims are checked mechanically, never remembered.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { enumerateDenyOwnerTools } from '../scripts/lib/owner-surface.mjs'
import { denySurfaceCheck } from '../scripts/generate-deny-surface.mjs'
import { apply as applyWorker } from '../worker.js'
import {
  DEFAULT_DENY_TOOLS,
  DENY_INVENTORY_REVIEWED_PIN,
  DENY_OWNER_BUILD_EXCEPTIONS,
  DENY_OWNER_PACKAGE_BUILD,
  FOREIGN_ORCHESTRATION_OWNERS,
  evaluateDenyInventoryBuild,
  uncoveredDenyTools,
} from '../domain/deny-owners.js'
import { DENY_OWNER_TOOLS } from '../domain/generated/deny-surface.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The support pin scripts/support.json currently records. */
function supportedBuild() {
  return JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'support.json'), 'utf8')).dsh
}

/** The real devDependency pins the evaluator reads. */
function ownerPins() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies
}

/** The ui-bundle ships a static mirror of the default deny list (no imports). */
function uiBundleDefaultDenied() {
  const source = fs.readFileSync(path.join(root, 'ui-bundle', 'client.helpers.js'), 'utf8')
  const match = /const DEFAULT_DENIED_TOOLS = \[([\s\S]*?)\]/.exec(source)
  assert.ok(match, 'ui-bundle/client.helpers.js must define DEFAULT_DENIED_TOOLS')
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1])
}

test('every tool each orchestration owner registers is denied in Tower mode', async () => {
  const live = await enumerateDenyOwnerTools()
  for (const owner of FOREIGN_ORCHESTRATION_OWNERS) {
    assert.ok(Array.isArray(live[owner.id]) && live[owner.id].length > 0, `${owner.id} enumerated no tools`)
  }
  const uncovered = uncoveredDenyTools(live, DEFAULT_DENY_TOOLS)
  assert.deepEqual(uncovered, [], `deny set misses owner tools: ${uncovered.join(', ')}`)
  // The denied names are exactly the owners' registrations — no ghosts either.
  const union = [...new Set(Object.values(live).flat())].sort()
  assert.deepEqual([...DEFAULT_DENY_TOOLS].sort(), union)
})

test('the committed deny inventory matches the live upstream enumeration', async () => {
  const live = await enumerateDenyOwnerTools()
  assert.deepEqual(DENY_OWNER_TOOLS, live, 'run `npm run deny:generate` after bumping the owner pins')
})

test('the stale hand-written names are gone from every deny source', () => {
  for (const name of ['team_task_reopen']) {
    assert.equal(DEFAULT_DENY_TOOLS.includes(name), false, `${name} no longer exists upstream`)
    assert.equal(JSON.stringify(DENY_OWNER_TOOLS).includes(name), false)
    assert.equal(uiBundleDefaultDenied().includes(name), false)
  }
  // And the four names the hand-written list missed are covered now.
  for (const name of ['team_task_get', 'list_agents', 'send_message', 'interrupt_agent']) {
    assert.ok(DEFAULT_DENY_TOOLS.includes(name), `${name} must be denied`)
  }
})

test('the ui-bundle static mirror equals the derived default deny list', () => {
  assert.deepEqual(uiBundleDefaultDenied().sort(), [...DEFAULT_DENY_TOOLS].sort())
})

test('a seeded upstream addition fails the coverage contract, naming owner and tool', async () => {
  const live = await enumerateDenyOwnerTools()
  const seeded = {
    ...live,
    'tool-agent-team': [...live['tool-agent-team'], 'team_task_new'],
  }
  const uncovered = uncoveredDenyTools(seeded, DEFAULT_DENY_TOOLS)
  assert.deepEqual(uncovered, ['tool-agent-team:team_task_new'])
})

test('every deny owner is pinned to the complete build the inventory was enumerated from', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  for (const owner of FOREIGN_ORCHESTRATION_OWNERS) {
    const version = pkg.devDependencies?.[owner.package]
    assert.ok(version, `${owner.package} must be a devDependency for the enumeration`)
    assert.equal(
      version,
      DENY_OWNER_PACKAGE_BUILD,
      `${owner.package} is pinned to ${version} but the deny inventory build is ${DENY_OWNER_PACKAGE_BUILD}; bump every owner pin together and run \`npm run deny:generate\``,
    )
  }
})

test('the deny build relationship is green on this checkout', () => {
  const result = evaluateDenyInventoryBuild({
    supportedBuild: supportedBuild(),
    devDependencies: ownerPins(),
  })
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
  assert.equal(result.facts.supportedBuild, supportedBuild())
  assert.equal(result.facts.inventoryBuild, DENY_OWNER_PACKAGE_BUILD)
  assert.equal(result.facts.reviewedPin, DENY_INVENTORY_REVIEWED_PIN)
  // Every owner package is on the documented exception table while the
  // supported pin trails the inventory build.
  for (const fact of result.facts.owners) {
    assert.equal(fact.exception, true, `${fact.package} must be a documented exception, not an implicit pin`)
    assert.equal(fact.pin, fact.expectedBuild)
  }
})

test('a supported pin past the reviewed pin reddens with both builds and the generate hint', () => {
  const result = evaluateDenyInventoryBuild({
    supportedBuild: '0.2.2-rc.5',
    devDependencies: ownerPins(),
  })
  assert.equal(result.ok, false)
  const problem = result.problems.join('\n')
  assert.match(problem, /moved past the reviewed pin/)
  assert.ok(problem.includes('0.2.2-rc.5'), problem)
  assert.ok(problem.includes(DENY_OWNER_PACKAGE_BUILD), problem)
  assert.ok(problem.includes('npm run deny:generate'), problem)
})

test('an owner pinned away from the recorded build without an exception reddens', () => {
  const exceptions = DENY_OWNER_BUILD_EXCEPTIONS.filter(
    (entry) => entry.package !== '@deepseek-ai/dsh-experimental-tool-agent-team',
  )
  const result = evaluateDenyInventoryBuild({
    supportedBuild: supportedBuild(),
    devDependencies: ownerPins(),
    exceptions,
  })
  assert.equal(result.ok, false)
  const problem = result.problems.find((entry) => entry.startsWith('@deepseek-ai/dsh-experimental-tool-agent-team'))
  assert.ok(problem, result.problems.join('\n'))
  assert.match(problem, /document a per-owner exception/)
  assert.ok(problem.includes('npm run deny:generate'), problem)
})

test('a stale generated surface reddens deny:check with the generate hint', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-deny-surface-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'domain', 'generated'), { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'))
  fs.copyFileSync(path.join(root, 'scripts', 'support.json'), path.join(dir, 'scripts', 'support.json'))
  const generated = path.join(dir, 'domain', 'generated', 'deny-surface.js')
  fs.copyFileSync(path.join(root, 'domain', 'generated', 'deny-surface.js'), generated)

  const clean = await denySurfaceCheck(dir)
  assert.equal(clean.ok, true, clean.problems.join('\n'))

  fs.appendFileSync(generated, '\n// hand edit that a regeneration would drop\n')
  const stale = await denySurfaceCheck(dir)
  assert.equal(stale.ok, false)
  assert.match(stale.problems.join('\n'), /is stale \(inventory build .* supported host pin .*\)/)
  assert.match(stale.problems.join('\n'), /npm run deny:generate/)

  fs.copyFileSync(path.join(root, 'domain', 'generated', 'deny-surface.js'), generated)
  const support = JSON.parse(fs.readFileSync(path.join(dir, 'scripts', 'support.json'), 'utf8'))
  support.dsh = '0.2.2-rc.5'
  fs.writeFileSync(path.join(dir, 'scripts', 'support.json'), JSON.stringify(support, null, 2))
  const bumped = await denySurfaceCheck(dir)
  assert.equal(bumped.ok, false)
  assert.match(bumped.problems.join('\n'), /moved past the reviewed pin/)
})

test('the generated header records both builds so a support bump is visible', () => {
  const text = fs.readFileSync(path.join(root, 'domain', 'generated', 'deny-surface.js'), 'utf8')
  assert.ok(text.includes(`Inventory build: ${DENY_OWNER_PACKAGE_BUILD}`), 'the header must record the inventory build')
  assert.ok(text.includes(`Supported host pin: ${supportedBuild()}`), 'the header must record the supported host pin')
})

test('the subagent package the auto-review test imports is a real devDependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const version = pkg.devDependencies?.['@deepseek-ai/dsh-subagent']
  assert.ok(version, '@deepseek-ai/dsh-subagent must be a declared devDependency, not an auto-installed peer')
  assert.equal(version, DENY_OWNER_PACKAGE_BUILD)
  assert.equal(lock.packages[''].devDependencies?.['@deepseek-ai/dsh-subagent'], version)
  const entry = lock.packages['node_modules/@deepseek-ai/dsh-subagent']
  assert.ok(entry, 'the lockfile must resolve the direct devDependency')
  assert.equal(entry.version, version)
  assert.equal(entry.dev, true)
  assert.notEqual(entry.peer, true, 'a direct devDependency must not stay flagged as an implicit dev+peer')
})

test('the deny gate is wired into the aggregate check', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const gates = pkg.scripts.check.split('&&').map((gate) => gate.trim())
  assert.ok(gates.includes('npm run deny:check'), 'npm run check must include npm run deny:check')
  assert.equal(pkg.scripts['deny:check'], 'node scripts/generate-deny-surface.mjs --check')
})

test('#191: the worker protocol states the no-ask limitation and the escalation path', () => {
  let section = null
  applyWorker({
    tools: { restrict() {} },
    systemPrompt: {
      section(value) {
        section = value
      },
    },
  })
  assert.ok(section, 'the worker preset must install its protocol section')
  assert.equal(section.name, 'tower:worker-protocol')
  assert.match(section.text, /cannot ask the user/)
  assert.match(section.text, /no approval prompt/)
  assert.match(section.text, /fails closed/)
  assert.match(section.text, /blocker or putting the question in the mission result/)
})
