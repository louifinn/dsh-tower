// Published file-list guard (#48), compatibility provenance (#59), and the
// client-file assertion (#71).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'
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
    // #137 F23: GLOSSARY.md is a gate input for the copy check, so it ships
    // with the package and is pinned by the reviewed snapshot.
    'GLOSSARY.md',
  ]) {
    assert.ok(manifest.includes(required), `${required} must be in the published snapshot`)
  }
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.files.includes('ui-bundle/'))
  assert.ok(pkg.files.includes('COMPATIBILITY.md'))
  assert.ok(pkg.files.includes('GLOSSARY.md'))
  // #121: the nested capability and preset row locale files ship with the
  // package, so the Plugins page can resolve `<specifier>/locale/<lang>.json`
  // from the install.
  assert.ok(pkg.files.includes('locale/'))
  for (const specifier of ['skills', 'batch', 'import', 'leases', 'tests', 'hmr', 'preset-worker', 'preset-reviewer']) {
    for (const lang of ['en', 'zh']) {
      assert.ok(
        manifest.includes(`locale/${specifier}/${lang}.json`),
        `locale/${specifier}/${lang}.json must be in the published snapshot`,
      )
    }
  }
  // The two preset-declaring rows mount Tower-owned modules; they must ship.
  for (const file of ['host/preset-worker.js', 'host/preset-reviewer.js']) {
    assert.ok(manifest.includes(file), `${file} must be in the published snapshot`)
  }
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

test('packaging: the real pack gate fails when ui-bundle/cordis.patch.yml is removed (fixture)', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pack-'))
  try {
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true })
      fs.writeFileSync(path.join(fixture, file), text)
    }
    write(
      'package.json',
      JSON.stringify(
        {
          name: 'tower-pack-fixture',
          version: '0.0.0',
          files: ['cordis.patch.yml', 'index.js', 'host/', 'locale/', 'ui-bundle/', 'COMPATIBILITY.md'],
        },
        null,
        2,
      ),
    )
    for (const file of REQUIRED_FILES) write(file, `${file}\n`)
    // check-pack writes its reviewed snapshot next to the script under --root.
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true })
    const run = (...args) =>
      spawnSync(process.execPath, [path.join(root, 'scripts', 'check-pack.mjs'), '--root', fixture, ...args], {
        cwd: root,
        encoding: 'utf8',
      })

    // Baseline: write the fixture manifest, then the gate passes.
    let result = run('--write')
    assert.equal(result.status, 0, result.stderr)
    result = run()
    assert.equal(result.status, 0, result.stderr || result.stdout)

    // Remove one required client file, refresh the snapshot, and the gate fails
    // for the required-file reason (not for a manifest diff).
    fs.unlinkSync(path.join(fixture, 'ui-bundle', 'cordis.patch.yml'))
    result = run('--write')
    assert.equal(result.status, 0, result.stderr)
    result = run()
    assert.notEqual(result.status, 0, 'a missing ui-bundle/cordis.patch.yml must fail pack:check')
    assert.match(result.stderr, /required runtime files missing: ui-bundle\/cordis\.patch\.yml/)
  } finally {
    removeTemp(fixture)
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
