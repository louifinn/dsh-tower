// Cumulative Release notes.
//
// Policy: a GitHub Release aggregates every CHANGELOG section since the previous
// Release, because tag-only versions have no Release of their own. These tests
// pin the window `(since, version]`, the SemVer ordering (including pre-release
// identifiers), the exact body shape the corrected live Releases use, the error
// codes, and `--check` against a real notes file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'
import { extractSections, generateReleaseNotes } from '../scripts/release-notes.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'release-notes.mjs')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

// Deliberately stored newest-first, like the real CHANGELOG. 2.1.1 and 2.1.2
// are tag-only versions (no GitHub Release), so a 2.3.0 Release must carry them.
// `## 2.2.0` has no blank line before it, mirroring the real file.
const FIXTURE = [
  '# Changelog',
  '',
  '> fixture',
  '',
  '## 未发布（Unreleased）',
  '',
  '## 2.5.0-beta（2026-10-30）',
  '',
  '- beta',
  '',
  '## 2.5.0-alpha.10（2026-10-30）',
  '',
  '- alpha ten',
  '',
  '## 2.5.0-alpha.2（2026-10-30）',
  '',
  '- alpha two',
  '',
  '## 2.4.0（2026-10-24）',
  '',
  '### 新增',
  '',
  '- feat: four',
  '',
  '## 2.3.0（2026-10-23）',
  '',
  '### 修复',
  '',
  '- fix: three',
  '## 2.2.0（2026-10-23）',
  '',
  '- feat: two',
  '',
  '## 2.1.2（2026-10-23）',
  '',
  '- fix: one-two',
  '',
  '## 2.1.1（2026-10-23）',
  '',
  '- fix: one-one',
  '',
  '## 2.1.0（2026-10-23）',
  '',
  '- feat: one',
  '',
  '## 2.1.0-beta.1（2026-10-22）',
  '',
  '- feat: prerelease',
  '',
].join('\n')

function makeRoot(changelog = FIXTURE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-release-notes-'))
  if (changelog !== null) fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog)
  return dir
}

function cleanup(dir) {
  try {
    removeTemp(dir)
  } catch {
    // Windows can keep a temp directory busy for a moment; the OS cleans it.
  }
}

// Always exercise the documented `--root <dir>` surface so a fixture never
// depends on the test runner's cwd.
function runNotes(dir, args) {
  const result = spawnSync(process.execPath, [script, '--root', dir, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function headingIndexes(text, versions) {
  return versions.map((version) => text.indexOf(`## ${version}`))
}

// --- the body shape ----------------------------------------------------------

test('a single-version window emits that section and the single-version line', () => {
  const dir = makeRoot()
  try {
    const run = runNotes(dir, ['--version', '2.1.1', '--since', '2.1.0'])
    assert.equal(run.status, 0, run.output)
    assert.ok(
      run.stdout.startsWith('# dsh-tower 2.1.1\n\n> 自上一个 Release `v2.1.0` 起的变更。\n\n---\n\n## 2.1.1'),
      run.stdout,
    )
    assert.ok(run.stdout.includes('## 2.1.1（2026-10-23）'))
    assert.ok(!run.stdout.includes('本 Release 包含'))
    assert.ok(!run.stdout.includes('## 2.1.0（'))
    assert.ok(!run.stdout.includes('2.1.0-beta.1'))
    // Exactly one separator after the provenance block, exactly one trailing newline.
    assert.equal((run.stdout.match(/\n\n---\n\n/g) ?? []).length, 1)
    assert.ok(run.stdout.endsWith('\n'))
    assert.ok(!run.stdout.endsWith('\n\n'))
  } finally {
    cleanup(dir)
  }
})

test('the cumulative window includes tag-only versions in ascending order', () => {
  const dir = makeRoot()
  try {
    const run = runNotes(dir, ['--version', '2.3.0', '--since', '2.1.0'])
    assert.equal(run.status, 0, run.output)
    assert.ok(
      run.stdout.includes(
        '> 本 Release 包含自上一个 Release `v2.1.0` 以来的全部变更：2.1.1、2.1.2、2.2.0、2.3.0。',
      ),
      run.stdout,
    )
    const versions = ['2.1.1', '2.1.2', '2.2.0', '2.3.0']
    const indexes = headingIndexes(run.stdout, versions)
    assert.ok(indexes.every((index) => index >= 0), run.stdout)
    assert.deepEqual([...indexes].sort((left, right) => left - right), indexes)
    assert.ok(!run.stdout.includes('## 2.1.0（'))
    assert.ok(!run.stdout.includes('## 2.4.0'))
    assert.ok(!run.stdout.includes('2.1.0-beta.1'))
    // header block + four sections, separated by the documented `---` rule.
    assert.equal(run.stdout.split('\n\n---\n\n').length, 5)
    assert.equal((run.stdout.match(/\n\n---\n\n/g) ?? []).length, 4)
    assert.ok(run.stdout.endsWith('\n'))
  } finally {
    cleanup(dir)
  }
})

test('a pre-release Since boundary includes only the stable version after it', () => {
  const dir = makeRoot()
  try {
    const run = runNotes(dir, ['--version', '2.1.0', '--since', '2.1.0-beta.1'])
    assert.equal(run.status, 0, run.output)
    assert.ok(run.stdout.includes('> 自上一个 Release `v2.1.0-beta.1` 起的变更。'), run.stdout)
    assert.ok(run.stdout.includes('## 2.1.0（2026-10-23）'))
    assert.ok(!run.stdout.includes('## 2.1.0-beta.1（'))
    assert.ok(!run.stdout.includes('## 2.1.1'))
    assert.ok(!run.stdout.includes('## 2.2.0'))
  } finally {
    cleanup(dir)
  }
})

test('pre-release identifiers order numerically, not lexically', () => {
  const dir = makeRoot()
  try {
    const run = runNotes(dir, ['--version', '2.5.0-beta', '--since', '2.5.0-alpha.2'])
    assert.equal(run.status, 0, run.output)
    assert.ok(run.stdout.includes('2.5.0-alpha.10、2.5.0-beta。'), run.stdout)
    const indexes = headingIndexes(run.stdout, ['2.5.0-alpha.10', '2.5.0-beta'])
    assert.ok(indexes.every((index) => index >= 0), run.stdout)
    assert.ok(indexes[0] < indexes[1], run.stdout)
    assert.ok(!run.stdout.includes('## 2.5.0-alpha.2（'))
  } finally {
    cleanup(dir)
  }
})

test('descending CHANGELOG storage still emits ascending sections', () => {
  const parsed = extractSections(FIXTURE).map((section) => section.version)
  assert.deepEqual(parsed.slice(0, 4), ['2.5.0-beta', '2.5.0-alpha.10', '2.5.0-alpha.2', '2.4.0'])
  const result = generateReleaseNotes({ changelog: FIXTURE, version: '2.3.0', since: '2.1.0' })
  assert.deepEqual(result.versions, ['2.1.1', '2.1.2', '2.2.0', '2.3.0'])
  // The real file is newest-first too; the body order comes from SemVer, not
  // from the order the sections happen to appear in.
  assert.ok(result.text.indexOf('## 2.1.1') < result.text.indexOf('## 2.1.2'))
  assert.ok(result.text.indexOf('## 2.1.2') < result.text.indexOf('## 2.2.0'))
  assert.ok(result.text.indexOf('## 2.2.0') < result.text.indexOf('## 2.3.0'))
})

// --- the real repository window ---------------------------------------------

test('the real CHANGELOG: 2.1.0 to 2.3.0 includes exactly the four later sections', () => {
  const run = spawnSync(
    process.execPath,
    [script, '--version', '2.3.0', '--since', '2.1.0', '--root', root],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  const headings = [...run.stdout.matchAll(/^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gm)].map((match) => match[1])
  assert.deepEqual(headings, ['2.1.1', '2.1.2', '2.2.0', '2.3.0'])
  assert.ok(
    run.stdout.includes(
      '> 本 Release 包含自上一个 Release `v2.1.0` 以来的全部变更：2.1.1、2.1.2、2.2.0、2.3.0。',
    ),
    run.stdout,
  )
  assert.ok(!run.stdout.includes('## 2.1.0（'))
  assert.ok(!run.stdout.includes('## 2.1.0-beta.1（'))
  assert.ok(!run.stdout.includes('## 2.4.0'))
})

// --- argument and window failures -------------------------------------------

test('a missing --version or --since is a usage error (exit 2)', () => {
  const dir = makeRoot()
  try {
    const noVersion = runNotes(dir, ['--since', '2.1.0'])
    assert.equal(noVersion.status, 2, noVersion.output)
    assert.match(noVersion.stderr, /--version <semver> is required/)
    assert.match(noVersion.stderr, /usage:/)

    const noSince = runNotes(dir, ['--version', '2.3.0'])
    assert.equal(noSince.status, 2, noSince.output)
    assert.match(noSince.stderr, /--since <semver> is required/)
    assert.match(noSince.stderr, /usage:/)
  } finally {
    cleanup(dir)
  }
})

test('unparsable versions are rejected instead of silently truncated', () => {
  const dir = makeRoot()
  try {
    const run = runNotes(dir, ['--version', '2.3', '--since', '2.1.0'])
    assert.equal(run.status, 2, run.output)
    assert.match(run.stderr, /"2\.3" is not a SemVer version/)

    const badSince = runNotes(dir, ['--version', '2.3.0', '--since', 'not-a-version'])
    assert.equal(badSince.status, 2, badSince.output)
    assert.match(badSince.stderr, /not-a-version.*is not a SemVer version/)
  } finally {
    cleanup(dir)
  }
})

test('since must be strictly older than version', () => {
  const dir = makeRoot()
  try {
    for (const since of ['2.3.0', '2.4.0']) {
      const run = runNotes(dir, ['--version', '2.3.0', '--since', since])
      assert.equal(run.status, 2, run.output)
      assert.match(run.stderr, /--since .* must be older than --version 2\.3\.0/)
    }
  } finally {
    cleanup(dir)
  }
})

test('an empty window and an unreadable CHANGELOG both fail with exit 2', () => {
  const empty = makeRoot()
  try {
    const window = runNotes(empty, ['--version', '10.0.0', '--since', '9.0.0'])
    assert.equal(window.status, 2, window.output)
    assert.match(window.stderr, /no CHANGELOG section falls in the window \(9\.0\.0, 10\.0\.0\]/)
  } finally {
    cleanup(empty)
  }

  const missing = makeRoot(null)
  try {
    const run = runNotes(missing, ['--version', '2.3.0', '--since', '2.1.0'])
    assert.equal(run.status, 2, run.output)
    assert.match(run.stderr, /cannot read .*CHANGELOG\.md/)
  } finally {
    cleanup(missing)
  }
})

test('--output writes the exact notes text to a file', () => {
  const dir = makeRoot()
  try {
    const stdout = runNotes(dir, ['--version', '2.3.0', '--since', '2.1.0'])
    assert.equal(stdout.status, 0, stdout.output)

    const outputPath = path.join(dir, 'notes.md')
    const written = runNotes(dir, ['--version', '2.3.0', '--since', '2.1.0', '--output', outputPath])
    assert.equal(written.status, 0, written.output)
    assert.match(written.stdout, /wrote .*notes\.md \(4 section\(s\): 2\.1\.1, 2\.1\.2, 2\.2\.0, 2\.3\.0\)/)
    assert.equal(fs.readFileSync(outputPath, 'utf8'), stdout.stdout)
  } finally {
    cleanup(dir)
  }
})

test('--check matches byte-for-byte and rejects a drifted notes file', () => {
  const dir = makeRoot()
  try {
    const outputPath = path.join(dir, 'notes.md')
    const written = runNotes(dir, ['--version', '2.3.0', '--since', '2.1.0', '--output', outputPath])
    assert.equal(written.status, 0, written.output)

    const match = runNotes(dir, ['--version', '2.3.0', '--since', '2.1.0', '--check', outputPath])
    assert.equal(match.status, 0, match.output)
    assert.match(match.stdout, /matches the generated notes for 2\.3\.0 \(4 section\(s\)/)

    fs.writeFileSync(outputPath, `${fs.readFileSync(outputPath, 'utf8')}\nextra\n`)
    const mismatch = runNotes(dir, ['--version', '2.3.0', '--since', '2.1.0', '--check', outputPath])
    assert.equal(mismatch.status, 1, mismatch.output)
    assert.match(mismatch.stderr, /does not match the generated notes for 2\.3\.0/)
    assert.match(mismatch.stderr, /first difference at line \d+/)
    assert.match(mismatch.stderr, /expected \d+ bytes, found \d+ bytes/)

    const absent = runNotes(dir, ['--version', '2.3.0', '--since', '2.1.0', '--check', path.join(dir, 'nope.md')])
    assert.equal(absent.status, 2, absent.output)
    assert.match(absent.stderr, /cannot read .*nope\.md/)
  } finally {
    cleanup(dir)
  }
})

test('--output and --check are mutually exclusive', () => {
  const dir = makeRoot()
  try {
    const run = runNotes(dir, ['--version', '2.3.0', '--since', '2.1.0', '--output', 'a.md', '--check', 'b.md'])
    assert.equal(run.status, 2, run.output)
    assert.match(run.stderr, /--output and --check are mutually exclusive/)
  } finally {
    cleanup(dir)
  }
})

// --- wiring and documentation ------------------------------------------------

test('package.json exposes release:notes', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.scripts['release:notes'], 'node scripts/release-notes.mjs')
})

test('the release checklist documents the cumulative policy and the exact commands', () => {
  const release = read('docs/guide/release.md')
  for (const required of [
    'Cumulative Release notes / 累积发布说明',
    'previous Release',
    'pre-release',
    'tag-only',
    '2.1.1',
    '2.1.2',
    '2.2.0',
    '2.3.0',
    'npm run release:notes -- --version <v> --since <prev-release> --output notes.md',
    '--notes-file notes.md',
    'gh release create',
    'gh release edit',
    '--check',
    'authoritative',
  ]) {
    assert.ok(release.includes(required), `docs/guide/release.md must document: ${required}`)
  }
})
