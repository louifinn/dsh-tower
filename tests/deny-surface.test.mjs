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
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { enumerateDenyOwnerTools } from '../scripts/lib/owner-surface.mjs'
import {
  DEFAULT_DENY_TOOLS,
  FOREIGN_ORCHESTRATION_OWNERS,
  uncoveredDenyTools,
} from '../domain/deny-owners.js'
import { DENY_OWNER_TOOLS } from '../domain/generated/deny-surface.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

test('the owner pins track the pinned DSH host, so a host bump re-enumerates', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'mount-smoke', 'host.json'), 'utf8'))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  for (const owner of FOREIGN_ORCHESTRATION_OWNERS) {
    const version = pkg.devDependencies?.[owner.package]
    assert.ok(version, `${owner.package} must be a devDependency for the enumeration`)
    assert.equal(
      version,
      pin.dsh,
      `${owner.package} is pinned to ${version} but the host pin is ${pin.dsh}; bump the owner pins and run \`npm run deny:generate\``,
    )
  }
})
