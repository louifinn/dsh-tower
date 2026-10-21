// #66: the bundle is all-or-nothing; no independently togglable child rows.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')

test('bundle patch has one group row with all sections nested', () => {
  assert.match(patch, /^\s*- id: tower-bundle\s*$/m)
  assert.match(patch, /^\s*name: cordis:group\s*$/m)
  assert.match(patch, /^\s*group: true\s*$/m)
  const ids = [...patch.matchAll(/^\s{8}- id: ([a-z0-9-]+)\s*$/gm)].map((match) => match[1]).sort()
  assert.deepEqual(ids, ['preset-tower-reviewer', 'preset-tower-worker', 'tower', 'tower-skills'])
  assert.equal((patch.match(/^\s{4}- id: /gm) ?? []).length, 1, 'only the group is a top-level bundle row')
})

test('no child row can be toggled independently of the group', () => {
  assert.doesNotMatch(patch, /^ {4}- id: (tower|tower-skills|preset-tower-[a-z]+)\s*$/m)
  assert.match(patch, /# dsh-tower is an all-or-nothing bundle/)
})

test('reload required ids include the bundle group', async () => {
  const { DEFAULT_REQUIRED_IDS } = await import('../lib/hmr.js')
  assert.ok(DEFAULT_REQUIRED_IDS.includes('tower-bundle'))
  const { runtimeConfig } = await import('../lib/config.js')
  assert.ok(runtimeConfig().dev.reloadRequiredIds.includes('tower-bundle'))
})
