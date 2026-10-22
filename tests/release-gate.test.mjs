// Release gate (#97, #76): a tag is a claim, so the version must have moved and
// the changelog must carry release content.
//
// The comparator is tested as a pure function over the truth table
// (version equal/different x unreleased empty/non-empty x PR/tag push). The CLI
// is tested against real temporary Git repositories, including the tag-push
// pitfall: `git describe --tags --abbrev=0` reports the pushed tag itself, so
// the previous tag has to be resolved from `<tag>^`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'
import { evaluateRelease, unreleasedSection, versionSection } from '../scripts/release-check.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const script = path.join(root, 'scripts', 'release-check.mjs')

const changelog = (unreleased = '', released = '') => [
  '# Changelog',
  '',
  '## 未发布（Unreleased）',
  '',
  unreleased,
  '',
  released,
].join('\n')

const evaluate = (overrides = {}) =>
  evaluateRelease({
    version: '2.1.0',
    mode: 'pr',
    tag: null,
    previousTag: 'v2.0.4',
    changelog: changelog('- feat: delivery gate'),
    commitsSince: 114,
    describe: 'v2.0.4-114-gec443c',
    ...overrides,
  })

const codes = (result) => result.findings.map((finding) => finding.code).sort()
const summary = (result) => result.findings.map((finding) => `${finding.level}:${finding.code}`).sort()

// --- changelog parsing -------------------------------------------------------

test('the unreleased section is read up to the next level-2 heading', () => {
  const text = changelog('- feat: one', '## 2.0.4（2026-10-21）\n\n- feat: old')
  assert.match(unreleasedSection(text), /feat: one/)
  assert.doesNotMatch(unreleasedSection(text), /feat: old/)
  assert.equal(unreleasedSection('## Unreleased\n\n- feat: two'), '- feat: two')
})

test('a missing, blank or comment-only unreleased section is empty', () => {
  assert.equal(unreleasedSection(changelog('')), '')
  assert.equal(unreleasedSection(changelog('   \n   ')), '')
  assert.equal(unreleasedSection(changelog('<!-- placeholder -->')), '<!-- placeholder -->')
  assert.equal(unreleasedSection('# Changelog\n\n## 2.0.4\n\n- old'), null)
})

test('the version section matches the exact version, not a prefix', () => {
  const text = changelog('', '## 2.1.0-beta.1（2026-10-22）\n\n- beta')
  assert.match(versionSection(text, '2.1.0-beta.1'), /beta/)
  assert.equal(versionSection(text, '2.1.0'), null)
})

// --- pure comparator: the truth table ---------------------------------------

test('PR + version equal + unreleased content: warning, never a failure', () => {
  const result = evaluate({ version: '2.0.4' })
  assert.equal(result.ok, true)
  assert.deepEqual(codes(result), ['version-not-bumped'])
  assert.equal(result.findings[0].level, 'warning')
  assert.match(result.findings[0].message, /Unreleased is non-empty/)
})

test('tag push + version equal + unreleased content: failure naming both facts', () => {
  const result = evaluate({ version: '2.0.4', mode: 'tag', tag: 'v2.1.0' })
  assert.equal(result.ok, false)
  assert.deepEqual(codes(result), ['tag-name-mismatch', 'version-not-bumped'])
  const finding = result.findings.find((entry) => entry.code === 'version-not-bumped')
  assert.equal(finding.level, 'error')
  assert.match(finding.message, /version did not move/)
  assert.match(finding.message, /package\.json 2\.0\.4 equals the previous tag v2\.0\.4/)
  assert.match(finding.message, /Unreleased is non-empty/)
})

test('tag push + version equal + unreleased empty: still a failure (no bump)', () => {
  const result = evaluate({ version: '2.0.4', mode: 'tag', tag: 'v2.1.0', changelog: changelog('') })
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('version-not-bumped'))
  const finding = result.findings.find((entry) => entry.code === 'version-not-bumped')
  assert.match(finding.message, /Unreleased is empty/)
})

test('PR + version moved + unreleased content: clean', () => {
  const result = evaluate()
  assert.equal(result.ok, true)
  assert.deepEqual(result.findings, [])
  assert.equal(result.facts.unreleased, true)
  assert.equal(result.facts.notesKind, 'unreleased')
})

test('tag push + version moved + unreleased content: clean when the tag is v<version>', () => {
  const result = evaluate({ mode: 'tag', tag: 'v2.1.0' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.findings, [])
})

test('PR + version moved + no release notes: warning only', () => {
  const result = evaluate({ changelog: changelog('') })
  assert.equal(result.ok, true)
  assert.deepEqual(summary(result), ['warning:no-release-notes'])
})

test('tag push + version moved + no release notes: failure', () => {
  const result = evaluate({ mode: 'tag', tag: 'v2.1.0', changelog: changelog('') })
  assert.equal(result.ok, false)
  assert.deepEqual(summary(result), ['error:no-release-notes'])
})

test('a changelog section for the version supplies the release notes', () => {
  const result = evaluate({
    mode: 'tag',
    tag: 'v2.1.0',
    changelog: changelog('', '## 2.1.0（2026-10-22）\n\n- feat: delivery gate'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.facts.unreleased, false)
  assert.equal(result.facts.notesKind, 'version-section')
})

test('the pushed tag must be exactly v<version>', () => {
  for (const [tag, version] of [
    ['v2.1.1', '2.1.0'],
    ['2.1.0', '2.1.0'],
    ['v2.1.0-rc.1', '2.1.0'],
  ]) {
    const result = evaluate({ mode: 'tag', tag, version })
    assert.equal(result.ok, false, tag)
    assert.deepEqual(codes(result), ['tag-name-mismatch'], tag)
    assert.match(result.findings[0].message, new RegExp(`expected v${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  }
})

test('tag push without a tag name is a failure, not a silent pass', () => {
  const result = evaluate({ mode: 'tag', tag: null })
  assert.equal(result.ok, false)
  assert.deepEqual(codes(result), ['tag-missing'])
})

test('a version older than the previous tag is not a release', () => {
  const result = evaluate({ version: '2.0.3' })
  assert.equal(result.ok, true)
  assert.deepEqual(summary(result), ['warning:version-not-bumped'])
  assert.match(result.findings[0].message, /is older than the previous tag v2\.0\.4/)

  const tagged = evaluate({ version: '2.0.3', mode: 'tag', tag: 'v2.0.3' })
  assert.equal(tagged.ok, false)
  assert.deepEqual(summary(tagged), ['error:version-not-bumped'])
})

test('a first release with no previous tag cannot compare, and only warns', () => {
  const result = evaluate({ previousTag: null })
  assert.equal(result.ok, true)
  assert.deepEqual(summary(result), ['warning:no-baseline'])

  const tagged = evaluate({ previousTag: null, mode: 'tag', tag: 'v2.1.0' })
  assert.equal(tagged.ok, true)
  assert.deepEqual(summary(tagged), ['warning:no-baseline'])
})

test('prereleases compare as newer than the stable tag they follow', () => {
  const result = evaluate({ version: '2.1.0-beta.1', mode: 'tag', tag: 'v2.1.0-beta.1' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.findings, [])
})

test('the CLI keeps only the documented flags', () => {
  const repo = makeRepo()
  try {
    seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
    repo.commit('release 2.0.4')
    repo.tag('v2.0.4')
    // --root/--package/--changelog were speculative: no test or doc used them,
    // and the release checklist always runs in the checkout root. Rejecting
    // them keeps the CLI to the documented --mode/--tag/--json surface.
    for (const flag of ['--root', '--package', '--changelog']) {
      const run = runCli(repo.dir, [flag, 'somewhere'])
      assert.equal(run.status, 2, `${flag}: ${run.output}`)
      assert.match(run.output, /unknown argument/)
    }
  } finally {
    repo.cleanup()
  }
})

// --- CLI fixtures over real Git repositories --------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-release-'))
  const run = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  run('init', '-b', 'main')
  run('config', 'user.email', 'release@test')
  run('config', 'user.name', 'Release Test')
  run('config', 'commit.gpgsign', 'false')
  run('config', 'tag.gpgSign', 'false')
  const repo = {
    dir,
    run,
    write(files) {
      for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
    },
    commit(message) {
      run('add', '-A')
      run('commit', '-m', message)
    },
    tag(name) {
      run('tag', '-a', name, '-m', `dsh-tower ${name.replace(/^v/, '')}`)
    },
    cleanup() {
      try {
        removeTemp(dir)
      } catch {
        // Windows can keep a temp directory busy for a moment; the OS cleans it.
      }
    },
  }
  return repo
}

function seed(repo, { version, unreleased = '', released = null }) {
  repo.write({
    'package.json': `${JSON.stringify({ name: 'dsh-tower', version }, null, 2)}\n`,
    'CHANGELOG.md': changelog(unreleased, released ? `## ${released.version}（2026-10-20）\n\n${released.body}` : ''),
  })
}

function runCli(dir, args = [], env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', ...env },
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('the CLI always prints describe, previous tag, commits since and unreleased', () => {
  const repo = makeRepo()
  try {
    seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
    repo.commit('release 2.0.4')
    repo.tag('v2.0.4')
    seed(repo, { version: '2.1.0', unreleased: '- feat: delivery gate' })
    repo.commit('chore: prepare 2.1.0')

    const run = runCli(repo.dir)
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /release-check: version=2\.1\.0 mode=pr tag=- previous-tag=v2\.0\.4/)
    assert.match(run.output, /commits-since=1 describe=v2\.0\.4-1-g[0-9a-f]+ unreleased=yes/)
  } finally {
    repo.cleanup()
  }
})

test('tag push resolves the previous tag as <tag>^, not the pushed tag', () => {
  const repo = makeRepo()
  try {
    seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
    repo.commit('release 2.0.4')
    repo.tag('v2.0.4')
    seed(repo, { version: '2.1.0', unreleased: '- feat: delivery gate' })
    repo.commit('chore: prepare 2.1.0')
    repo.tag('v2.1.0')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /mode=tag tag=v2\.1\.0 previous-tag=v2\.0\.4/)
    assert.match(run.output, /commits-since=1 /)
    assert.match(run.output, /unreleased=yes/)
    assert.doesNotMatch(run.output, /previous-tag=v2\.1\.0/)
  } finally {
    repo.cleanup()
  }
})

test('a tag push without a version bump fails and names the version and unreleased content', () => {
  const repo = makeRepo()
  try {
    seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
    repo.commit('release 2.0.4')
    repo.tag('v2.0.4')
    seed(repo, { version: '2.0.4', unreleased: '- feat: unbumped work' })
    repo.commit('feat: work without a bump')
    repo.tag('v2.1.0')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[version-not-bumped\]/)
    assert.match(run.output, /version did not move/)
    assert.match(run.output, /package\.json 2\.0\.4 equals the previous tag v2\.0\.4/)
    assert.match(run.output, /Unreleased is non-empty/)
    assert.match(run.output, /expected v2\.0\.4/)
  } finally {
    repo.cleanup()
  }
})

test('the same contradiction on a PR warns and exits zero', () => {
  const repo = makeRepo()
  try {
    seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
    repo.commit('release 2.0.4')
    repo.tag('v2.0.4')
    seed(repo, { version: '2.0.4', unreleased: '- feat: unbumped work' })
    repo.commit('feat: work without a bump')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'feature' })
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /warning \[version-not-bumped\]/)
    assert.match(run.output, /warning only/)
  } finally {
    repo.cleanup()
  }
})

test('a bumped tag with no changelog notes fails on a tag push', () => {
  const repo = makeRepo()
  try {
    seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
    repo.commit('release 2.0.4')
    repo.tag('v2.0.4')
    seed(repo, { version: '2.1.0' })
    repo.commit('chore: bump without notes')
    repo.tag('v2.1.0')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[no-release-notes\]/)
  } finally {
    repo.cleanup()
  }
})

test('a stray non-version tag never becomes the previous tag', () => {
  const repo = makeRepo()
  try {
    seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
    repo.commit('release 2.0.4')
    repo.tag('v2.0.4')
    // A UI/release tag that is not `v<semver>` is nearer to HEAD than v2.0.4,
    // so `git describe` reports it; the gate must skip it and compare against
    // the last version tag instead.
    repo.write({ 'ui-version.json': '{"version":"0.2.2"}\n' })
    repo.commit('feat(ui): bump the widget')
    repo.tag('ui-0.2.2')
    seed(repo, { version: '2.1.0', unreleased: '- feat: delivery gate' })
    repo.commit('chore: prepare 2.1.0')

    const branch = runCli(repo.dir)
    assert.equal(branch.status, 0, branch.output)
    assert.match(branch.output, /previous-tag=v2\.0\.4/)
    assert.doesNotMatch(branch.output, /version-not-bumped/)
    assert.doesNotMatch(branch.output, /previous tag ui-0\.2\.2/)

    repo.tag('v2.1.0')
    const tagged = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(tagged.status, 0, tagged.output)
    assert.match(tagged.output, /previous-tag=v2\.0\.4/)
    assert.doesNotMatch(tagged.output, /version-not-bumped/)
  } finally {
    repo.cleanup()
  }
})

test('the CLI reports machine-readable facts with --json', () => {
  const repo = makeRepo()
  try {
    seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
    repo.commit('release 2.0.4')
    repo.tag('v2.0.4')
    seed(repo, { version: '2.0.4', unreleased: '- feat: unbumped work' })
    repo.commit('feat: work without a bump')

    const run = runCli(repo.dir, ['--json'], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 1, run.output)
    const report = JSON.parse(run.output)
    assert.equal(report.facts.version, '2.0.4')
    assert.equal(report.facts.previousTag, 'v2.0.4')
    assert.equal(report.facts.unreleased, true)
    assert.equal(report.ok, false)
  } finally {
    repo.cleanup()
  }
})

// --- wiring and docs --------------------------------------------------------

test('package.json exposes release:check and CI runs it with tags available', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.scripts['release:check'], 'node scripts/release-check.mjs')
  const workflow = read('.github/workflows/test.yml')
  assert.match(workflow, /npm run release:check/)
  assert.match(workflow, /fetch-depth: 0/)
})

test('CONTRIBUTING links the release checklist and the tracker board', () => {
  const contributing = read('CONTRIBUTING.md')
  assert.match(contributing, /docs\/guide\/release\.md/)
  assert.match(contributing, /docs\/board\.md/)
})

test('the release checklist covers bump, changelog, compatibility, publish, tag and notes', () => {
  const release = read('docs/guide/release.md')
  for (const required of [
    'package.json',
    'CHANGELOG.md',
    'COMPATIBILITY.md',
    'npm publish --tag next',
    'git tag -a',
    'gh release create',
    '--verify-tag',
    '--prerelease',
    '--latest=false',
    'npm run release:check',
    '2FA',
    'human-only',
    'clean clone',
    'open P0/P1',
  ]) {
    assert.ok(release.includes(required), `release.md must document: ${required}`)
  }
  // The COMPATIBILITY parser reads cells 0-3; the tag belongs in cell 1.
  assert.match(release, /tag \/ commit/)
})

test('the board doc holds the three saved queries and their verified shape', () => {
  const board = read('docs/board.md')
  for (const query of [
    'gh issue list --state open --label P1',
    "gh issue list --state open --search 'no:milestone label:P0,P1'",
    'closed:>=',
  ]) {
    assert.ok(board.includes(query), `board.md must hold the query: ${query}`)
  }
  assert.match(board, /label:area\//)
  assert.match(board, /label:P0,P1/)
  assert.match(board, /docs\/guide\/release\.md|guide\/release\.md/)
})

