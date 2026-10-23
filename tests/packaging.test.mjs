// Published file-list guard (#48) and compatibility provenance (#59).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessHostVersion, compareVersions, parseCompatibility, parseVersion } from '../host/compatibility.js'
import { REQUIRED_FILES, requiredMissing } from '../scripts/check-pack.mjs'

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
    'ui-bundle/package.json',
    'ui-bundle/cordis.patch.yml',
    'COMPATIBILITY.md',
    'types/index.d.ts',
  ]) {
    assert.ok(manifest.includes(required), `${required} must be in the published snapshot`)
  }
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.files.includes('ui-bundle/'))
  assert.ok(pkg.files.includes('COMPATIBILITY.md'))
})

test('packaging: removing a required ui-bundle file fails pack:check (fixture)', () => {
  const manifest = read('scripts/pack-manifest.txt').split('\n').filter(Boolean)
  assert.deepEqual(requiredMissing(manifest), [], 'the reviewed snapshot must contain every required file')
  assert.ok(REQUIRED_FILES.includes('ui-bundle/package.json'))
  assert.ok(REQUIRED_FILES.includes('ui-bundle/cordis.patch.yml'))
  for (const file of ['ui-bundle/package.json', 'ui-bundle/cordis.patch.yml']) {
    const without = manifest.filter((entry) => entry !== file)
    assert.deepEqual(requiredMissing(without), [file], `removing ${file} must fail pack:check`)
  }
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

test('generated error reference matches the source catalog', async () => {
  const { execFileSync } = await import('node:child_process')
  const output = execFileSync(process.execPath, ['scripts/generate-error-reference.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.match(output, /codes in sync/)
})

test('generated tools reference matches the registered surface', async () => {
  const { execFileSync } = await import('node:child_process')
  const output = execFileSync(process.execPath, ['scripts/generate-tools-reference.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.match(output, /tools in sync/)
})

test('generated config reference matches the schema defaults', async () => {
  const { execFileSync } = await import('node:child_process')
  const output = execFileSync(process.execPath, ['scripts/generate-config-reference.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.match(output, /keys in sync/)
})

test('generated events reference matches the event table', async () => {
  const { execFileSync } = await import('node:child_process')
  const output = execFileSync(process.execPath, ['scripts/generate-events-reference.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.match(output, /events in sync/)
})

test('declaration contracts typecheck with tsc --noEmit', async () => {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '--noEmit'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
})
