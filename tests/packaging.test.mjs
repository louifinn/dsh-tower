// Published file-list guard (#48) and compatibility provenance (#59).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessHostVersion, compareVersions, parseCompatibility, parseVersion } from '../lib/compatibility.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('packaging: reviewed pack manifest covers required runtime files', () => {
  const manifest = read('scripts/pack-manifest.txt').split('\n').filter(Boolean)
  assert.ok(manifest.length > 0)
  for (const required of [
    'cordis.patch.yml',
    'index.js',
    'locale/en.json',
    'locale/zh.json',
    'ui-bundle/index.js',
    'COMPATIBILITY.md',
    'types/index.d.ts',
  ]) {
    assert.ok(manifest.includes(required), `${required} must be in the published snapshot`)
  }
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.files.includes('ui-bundle/'))
  assert.ok(pkg.files.includes('COMPATIBILITY.md'))
})

test('compatibility: version comparison handles prereleases', () => {
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1'), -1)
  assert.equal(compareVersions('0.2.2', '0.2.1-rc.2'), 1)
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1-rc.2'), 0)
  assert.equal(parseVersion('nonsense'), null)
})

test('compatibility: table parser and four host verdicts', () => {
  const rows = parseCompatibility(`
| dsh version | commit | verified on | what was run |
|---|---|---|---|
| 0.2.1-rc.2 | abc | 2026-10-21 | npm test |
| 0.2.2 | def | 2026-11-01 | npm test |
`)
  assert.equal(rows.length, 2)
  assert.equal(assessHostVersion('0.2.1-rc.2', rows).verdict, 'verified')
  assert.equal(assessHostVersion('0.2.2', rows).verdict, 'verified')
  assert.equal(assessHostVersion('0.3.0', rows).verdict, 'untested-newer')
  assert.equal(assessHostVersion('0.1.0', rows).verdict, 'untested-older')
  assert.equal(assessHostVersion('garbage', rows).verdict, 'unknown')
  assert.equal(assessHostVersion('0.2.0', []).verdict, 'unknown')
})
