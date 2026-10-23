// Type-surface integrity (#115).
//
// `npm run types:coverage` must keep the checked program derived from the
// shipped program, so a runtime file outside the tsc program is a red check
// instead of an invisible gap. These tests prove both directions with real
// fixtures: a shipped file outside the program fails, an extra program file
// (tests, declarations) does not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'
import {
  evaluateCoverage,
  expandShipped,
  globToRegExp,
  runtimeJavaScript,
} from '../scripts/types-coverage.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(args, options = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'types-coverage.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  })
}

function fixture(files, tsconfigInclude) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-types-coverage-'))
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  write(
    'package.json',
    JSON.stringify({ name: 'types-coverage-fixture', version: '0.0.0', files: ['index.js', 'host/*.js', 'ui-bundle/', 'scripts/', 'types/'] }, null, 2),
  )
  write(
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: { allowJs: true, checkJs: true, noEmit: true, types: [] },
        include: tsconfigInclude,
      },
      null,
      2,
    ),
  )
  for (const file of files) write(file, 'export {}\n')
  return dir
}

test('types coverage: shipped runtime files outside the tsc program fail (fixture)', () => {
  const dir = fixture(['index.js', 'host/a.js', 'host/b.js', 'ui-bundle/client.js', 'scripts/legacy.js', 'types/index.d.ts'], ['index.js', 'host/a.js'])
  try {
    const result = run(['--root', dir])
    assert.notEqual(result.status, 0, 'host/b.js is shipped but not in the program')
    assert.match(result.stderr, /1 shipped runtime \.js file\(s\) are outside the tsc program/)
    assert.match(result.stderr, /- host\/b\.js/)
    assert.doesNotMatch(result.stderr, /ui-bundle/)
    assert.doesNotMatch(result.stderr, /scripts\/legacy\.js/)
  } finally {
    removeTemp(dir)
  }
})

test('types coverage: the program may contain files that are not shipped (fixture)', () => {
  // Extra program files are expected: tests/*.ts, types/*.d.ts and fixtures are
  // checked but never published. Only the missing direction is a failure.
  const dir = fixture(['index.js', 'host/a.js', 'host/b.js'], ['index.js', 'host/a.js', 'host/b.js', 'extra.js'])
  try {
    const result = run(['--root', dir])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /3\/3 shipped runtime \.js files/)
  } finally {
    removeTemp(dir)
  }
})

test('types coverage: an empty tsc program is a configuration failure, not a pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-types-empty-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ files: ['index.js'] }))
    fs.writeFileSync(path.join(dir, 'index.js'), 'export {}\n')
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true }, include: ['missing.js'] }))
    const result = run(['--root', dir])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /types coverage: /)
  } finally {
    removeTemp(dir)
  }
})

test('types coverage: glob expansion keeps globs and the non-Node tiers honest', () => {
  const files = ['index.js', 'host/a.js', 'host/nested/b.js', 'domain/x.js', 'domain/deep/y.js', 'ui-bundle/c.js', 'scripts/tool.js']
  assert.deepEqual(expandShipped(['index.js', 'host/*.js', 'domain/**/*.js'], files), [
    'domain/deep/y.js',
    'domain/x.js',
    'host/a.js',
    'index.js',
  ])
  assert.equal(globToRegExp('host/*.js').test('host/nested/b.js'), false)
  assert.equal(globToRegExp('domain/**/*.js').test('domain/x.js'), true)
  const { runtime, excluded } = runtimeJavaScript(files)
  assert.deepEqual(runtime, ['domain/deep/y.js', 'domain/x.js', 'host/a.js', 'host/nested/b.js', 'index.js'])
  assert.deepEqual(excluded.map((entry) => entry.file), ['ui-bundle/c.js', 'scripts/tool.js'])
})

test('types coverage: evaluateCoverage fails only for a shipped file outside the program', () => {
  assert.deepEqual(evaluateCoverage({ runtime: ['a.js', 'b.js'], program: ['a.js', 'test.ts'] }), {
    ok: false,
    missing: ['b.js'],
    checked: 1,
    total: 2,
  })
  assert.deepEqual(evaluateCoverage({ runtime: ['a.js'], program: ['a.js', 'extra.js', 'tests/x.ts'] }), {
    ok: true,
    missing: [],
    checked: 1,
    total: 1,
  })
})
