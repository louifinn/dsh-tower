// Release gate (#97, #76, #M74): a tag is a claim, so the version must have
// moved, the tag must be an annotated object in HEAD's history, the tree must be
// clean, the CHANGELOG must carry a section for the released version, and the
// support manifest must agree with its restatements.
//
// The comparator is tested as a pure function over the new truth table
// (version equal/different x notes x annotated/lightweight/absent tag x clean/
// dirty tree x support agreement x PR/tag/prepublish). The CLI is tested against
// real temporary Git repositories, including the tag-push pitfall:
// `git describe --tags --abbrev=0` reports the pushed tag itself, so the previous
// tag has to be resolved from `<tag>^`.
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

const SUPPORT = { node: '>=24.9', dsh: '0.2.2-rc.1' }

const changelog = (unreleased = '', released = '') => [
  '# Changelog',
  '',
  '## 未发布（Unreleased）',
  '',
  unreleased,
  '',
  released,
].join('\n')

const releasedSection = (version, body = '- feat: delivery gate') =>
  `## ${version}（2026-10-20）\n\n${body}`

const releaseChangelog = (version, options = {}) =>
  changelog(options.unreleased ?? '', releasedSection(version, options.body))

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

// Repository facts the CLI always supplies. The pure tests pass them only when
// the case under test needs a repository fact; `undefined` means "not inspected".
const repoFacts = (overrides = {}) => ({
  tagKind: 'tag',
  tagReachable: true,
  dirty: [],
  headTags: [],
  support: { ok: true, problems: [], facts: null },
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
  const result = evaluate({
    version: '2.0.4',
    mode: 'tag',
    tag: 'v2.1.0',
    changelog: changelog('- feat: delivery gate', releasedSection('2.0.4')),
  })
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

test('tag push + version moved + unreleased-only content: failure (notes belong to the version)', () => {
  const result = evaluate({ mode: 'tag', tag: 'v2.1.0' })
  assert.equal(result.ok, false)
  assert.deepEqual(summary(result), ['error:no-version-notes'])
  const finding = result.findings[0]
  assert.match(finding.message, /no non-empty "## 2\.1\.0/)
  assert.match(finding.message, /Unreleased section is non-empty/)
})

test('tag push + version moved + version section: clean when the tag is v<version>', () => {
  const result = evaluate({ mode: 'tag', tag: 'v2.1.0', changelog: releaseChangelog('2.1.0') })
  assert.equal(result.ok, true)
  assert.deepEqual(result.findings, [])
  assert.equal(result.facts.versionNotes, true)
  assert.equal(result.facts.notesKind, 'version-section')
})

test('notesKind prefers the version section when both sections are non-empty', () => {
  const result = evaluate({ changelog: releaseChangelog('2.1.0', { unreleased: '- feat: next' }) })
  assert.equal(result.facts.unreleased, true)
  assert.equal(result.facts.versionNotes, true)
  assert.equal(result.facts.notesKind, 'version-section')
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
    changelog: releaseChangelog('2.1.0'),
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
    const result = evaluate({
      mode: 'tag',
      tag,
      version,
      changelog: releaseChangelog(version),
    })
    assert.equal(result.ok, false, tag)
    assert.deepEqual(codes(result), ['tag-name-mismatch'], tag)
    assert.match(result.findings[0].message, new RegExp(`expected v${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  }
})

test('tag push without a tag name is a failure, not a silent pass', () => {
  const result = evaluate({ mode: 'tag', tag: null, changelog: releaseChangelog('2.1.0') })
  assert.equal(result.ok, false)
  assert.deepEqual(codes(result), ['tag-missing'])
})

test('tag push fails closed when the tag object is missing, lightweight or outside HEAD', () => {
  const base = { mode: 'tag', tag: 'v2.1.0', changelog: releaseChangelog('2.1.0') }

  const missing = evaluate({ ...base, ...repoFacts({ tagKind: null, tagReachable: null }), headTags: ['v2.1.0'] })
  assert.equal(missing.ok, false)
  assert.deepEqual(codes(missing), ['tag-not-found'])
  assert.match(missing.findings[0].message, /no refs\/tags\/v2\.1\.0/)

  const lightweight = evaluate({ ...base, ...repoFacts({ tagKind: 'commit' }) })
  assert.equal(lightweight.ok, false)
  assert.deepEqual(codes(lightweight), ['tag-lightweight'])
  assert.match(lightweight.findings[0].message, /annotated tag object/)
  assert.match(lightweight.findings[0].message, /git tag -a v2\.1\.0/)

  const unreachable = evaluate({ ...base, ...repoFacts({ tagReachable: false }), headTags: ['v2.1.0'] })
  assert.equal(unreachable.ok, false)
  assert.deepEqual(codes(unreachable), ['tag-unreachable'])
  assert.match(unreachable.findings[0].message, /not in HEAD's history/)
})

test('prepublish accepts a version whose tag does not exist yet', () => {
  const result = evaluate({
    mode: 'prepublish',
    tag: 'v2.1.0',
    changelog: releaseChangelog('2.1.0'),
    ...repoFacts({ tagKind: null, tagReachable: null }),
  })
  assert.equal(result.ok, true, JSON.stringify(result.findings))
  assert.deepEqual(result.findings, [])
})

test('prepublish accepts an annotated tag already on HEAD', () => {
  const result = evaluate({
    mode: 'prepublish',
    tag: 'v2.1.0',
    changelog: releaseChangelog('2.1.0'),
    ...repoFacts({ headTags: ['v2.1.0'] }),
  })
  assert.equal(result.ok, true, JSON.stringify(result.findings))
})

test('prepublish rejects a lightweight tag, an unreachable tag and another tag at HEAD', () => {
  const base = { mode: 'prepublish', changelog: releaseChangelog('2.1.0') }

  const lightweight = evaluate({ ...base, tag: 'v2.1.0', ...repoFacts({ tagKind: 'commit', headTags: ['v2.1.0'] }) })
  assert.equal(lightweight.ok, false)
  assert.deepEqual(codes(lightweight), ['tag-lightweight'])

  const unreachable = evaluate({ ...base, tag: 'v2.1.0', ...repoFacts({ tagReachable: false }) })
  assert.equal(unreachable.ok, false)
  assert.deepEqual(codes(unreachable), ['tag-unreachable'])

  const otherTag = evaluate({
    ...base,
    // No --tag claim: prepublish derives v<version> from package.json.
    ...repoFacts({ tagKind: null, tagReachable: null, headTags: ['v2.2.0'] }),
  })
  assert.equal(otherTag.ok, false)
  assert.deepEqual(codes(otherTag), ['tag-name-mismatch'])
  assert.match(otherTag.findings[0].message, /HEAD is tagged v2\.2\.0/)
})

test('a dirty worktree fails the release modes but not a PR', () => {
  const strict = evaluate({
    mode: 'tag',
    tag: 'v2.1.0',
    changelog: releaseChangelog('2.1.0'),
    ...repoFacts({ dirty: ['package.json', 'README.md'] }),
  })
  assert.equal(strict.ok, false)
  assert.deepEqual(codes(strict), ['dirty-worktree'])
  assert.match(strict.findings[0].message, /2 path\(s\) differ \(package\.json, README\.md\)/)

  const capped = evaluate({
    mode: 'prepublish',
    changelog: releaseChangelog('2.1.0'),
    ...repoFacts({ dirty: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
  })
  assert.match(capped.findings[0].message, /7 path\(s\) differ \(a, b, c, d, e, …\)/)

  const pr = evaluate({ ...repoFacts({ dirty: ['package.json'] }) })
  assert.equal(pr.ok, true)
  assert.deepEqual(pr.findings, [])
})

test('support disagreement fails the release modes and is ignored on a PR', () => {
  const drift = {
    ok: false,
    problems: ['COMPATIBILITY.md: newest row host version is "0.2.1-rc.2"; scripts/support.json sets "0.2.2-rc.1"'],
    facts: null,
  }
  const strict = evaluate({
    mode: 'tag',
    tag: 'v2.1.0',
    changelog: releaseChangelog('2.1.0'),
    ...repoFacts({ support: drift }),
  })
  assert.equal(strict.ok, false)
  assert.deepEqual(codes(strict), ['support-drift'])
  assert.match(strict.findings[0].message, /newest row host version is "0\.2\.1-rc\.2"/)

  const unavailable = evaluate({
    mode: 'tag',
    tag: 'v2.1.0',
    changelog: releaseChangelog('2.1.0'),
    ...repoFacts({ support: null }),
  })
  assert.equal(unavailable.ok, false)
  assert.deepEqual(codes(unavailable), ['support-unavailable'])

  const pr = evaluate({ support: drift })
  assert.equal(pr.ok, true)
  assert.deepEqual(pr.findings, [])
})

test('a version older than the previous tag is not a release', () => {
  const result = evaluate({ version: '2.0.3' })
  assert.equal(result.ok, true)
  assert.deepEqual(summary(result), ['warning:version-not-bumped'])
  assert.match(result.findings[0].message, /is older than the previous tag v2\.0\.4/)

  const tagged = evaluate({
    version: '2.0.3',
    mode: 'tag',
    tag: 'v2.0.3',
    changelog: releaseChangelog('2.0.3'),
  })
  assert.equal(tagged.ok, false)
  assert.deepEqual(summary(tagged), ['error:version-not-bumped'])
})

test('a first release with no previous tag cannot compare, and only warns', () => {
  const result = evaluate({ previousTag: null })
  assert.equal(result.ok, true)
  assert.deepEqual(summary(result), ['warning:no-baseline'])

  const tagged = evaluate({
    previousTag: null,
    mode: 'tag',
    tag: 'v2.1.0',
    changelog: releaseChangelog('2.1.0'),
  })
  assert.equal(tagged.ok, true)
  assert.deepEqual(summary(tagged), ['warning:no-baseline'])
})

test('prereleases compare as newer than the stable tag they follow', () => {
  const result = evaluate({
    version: '2.1.0-beta.1',
    mode: 'tag',
    tag: 'v2.1.0-beta.1',
    changelog: releaseChangelog('2.1.0-beta.1'),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.findings, [])
})

test('an unknown mode is a usage error, not a silent pass', () => {
  assert.throws(() => evaluate({ mode: 'release' }), /--mode must be "pr", "tag" or "prepublish"/)
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
      for (const [name, body] of Object.entries(files)) {
        const target = path.join(dir, name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, body)
      }
    },
    commit(message) {
      run('add', '-A')
      run('commit', '-m', message)
    },
    // An annotated tag object (`tag`), the only shape the release guard accepts.
    tag(name) {
      run('tag', '-a', name, '-m', `dsh-tower ${name.replace(/^v/, '')}`)
    },
    // A lightweight tag: the ref shares its name with a commit object.
    tagLight(name) {
      run('tag', name)
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

// The six restatements `scripts/check-support.mjs` compares, in a shape it
// accepts: package engines, lock root engines, mount host pin, live matrix pin
// and the newest COMPATIBILITY.md row.
function supportFixture(version, { node = SUPPORT.node, dsh = SUPPORT.dsh } = {}) {
  return {
    'scripts/support.json': `${JSON.stringify({ node, dsh }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify(
      {
        name: 'dsh-tower',
        version,
        lockfileVersion: 3,
        packages: { '': { name: 'dsh-tower', version, engines: { node } } },
      },
      null,
      2,
    )}\n`,
    'scripts/mount-smoke/host.json': `${JSON.stringify({ dsh }, null, 2)}\n`,
    '.github/workflows/test.yml': `name: test\njobs:\n  live:\n    strategy:\n      matrix:\n        dsh:\n          - '${dsh}'\n`,
    'COMPATIBILITY.md': [
      '# Compatibility',
      '',
      '| dsh version | tag / commit | verified on | what was run |',
      '|---|---|---|---|',
      `| ${dsh} | v${version} | 2026-10-20 | CI on Node ${node} |`,
      '',
    ].join('\n'),
  }
}

function seed(repo, { version, unreleased = '', released = null, support = true }) {
  const files = {
    'package.json': `${JSON.stringify(
      { name: 'dsh-tower', version, ...(support ? { engines: { node: SUPPORT.node } } : {}) },
      null,
      2,
    )}\n`,
    'CHANGELOG.md': changelog(unreleased, released ? releasedSection(released.version, released.body) : ''),
  }
  if (support) Object.assign(files, supportFixture(version))
  repo.write(files)
}

// Tag off a 2.0.4 release commit so every release test has a real previous tag
// (and therefore a real version-bump comparison).
function seedReleased(repo, version) {
  seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
  repo.commit('release 2.0.4')
  repo.tag('v2.0.4')
  seed(repo, {
    version,
    unreleased: '- feat: delivery gate',
    released: { version, body: '- feat: delivery gate' },
  })
  repo.commit(`release ${version}`)
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
    assert.match(run.output, /tag-type=- reachable=- worktree=clean/)
  } finally {
    repo.cleanup()
  }
})

test('tag push resolves the previous tag as <tag>^, not the pushed tag', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')
    repo.tag('v2.1.0')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /mode=tag tag=v2\.1\.0 previous-tag=v2\.0\.4/)
    assert.match(run.output, /commits-since=1 /)
    assert.match(run.output, /unreleased=yes/)
    assert.match(run.output, /tag-type=tag reachable=yes worktree=clean/)
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
    // The Unreleased section is not a substitute for a 2.0.4 heading either.
    assert.match(run.output, /\[no-version-notes\]/)
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
    seed(repo, {
      version: '2.1.0',
      unreleased: '- feat: delivery gate',
      released: { version: '2.1.0', body: '- feat: delivery gate' },
    })
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
    assert.equal(report.facts.expectedTag, 'v2.0.4')
    assert.equal(report.facts.previousTag, 'v2.0.4')
    assert.equal(report.facts.unreleased, true)
    // The pushed name v2.1.0 has no ref: the machine-readable report says so
    // instead of implying an annotated tag exists.
    assert.equal(report.facts.tagKind, null)
    assert.equal(report.facts.tagReachable, null)
    assert.deepEqual(report.facts.headTags, [])
    assert.deepEqual(report.facts.dirty, [])
    assert.equal(report.facts.support.ok, true)
    assert.equal(report.ok, false)
  } finally {
    repo.cleanup()
  }
})

// --- the hardened tag guard over real Git repositories ----------------------

test('an annotated tag at HEAD passes the tag push guard', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')
    repo.tag('v2.1.0')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /tag-type=tag reachable=yes worktree=clean/)
    assert.match(run.output, /release-check: ok\n$/)
  } finally {
    repo.cleanup()
  }
})

test('an annotated tag behind HEAD is still in history and passes', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')
    repo.tag('v2.1.0')
    // A tag whose commit is an ancestor of HEAD is the normal shape when the
    // guard is re-run after release follow-ups (the v2.7.1 case).
    repo.write({ 'docs/post-release.md': 'follow-up\n' })
    repo.commit('chore: post-release docs')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /previous-tag=v2\.0\.4/)
    assert.match(run.output, /tag-type=tag reachable=yes worktree=clean/)
  } finally {
    repo.cleanup()
  }
})

test('a lightweight tag at HEAD fails the tag push guard', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')
    repo.tagLight('v2.1.0')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[tag-lightweight\]/)
    assert.match(run.output, /git tag -a v2\.1\.0/)
    assert.match(run.output, /tag-type=commit reachable=yes/)
  } finally {
    repo.cleanup()
  }
})

test('a tag on a commit outside HEAD history fails the tag push guard', () => {
  const repo = makeRepo()
  try {
    seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
    repo.commit('release 2.0.4')
    repo.tag('v2.0.4')
    seed(repo, { version: '2.1.0', released: { version: '2.1.0', body: '- feat: delivery gate' } })
    repo.commit('release 2.1.0')
    repo.run('checkout', '-b', 'side')
    repo.write({ 'side.txt': 'side\n' })
    repo.commit('side work')
    repo.tag('v2.1.0')
    repo.run('checkout', 'main')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[tag-unreachable\]/)
    assert.match(run.output, /not in HEAD's history/)
  } finally {
    repo.cleanup()
  }
})

test('a tag name with no ref fails closed instead of passing the name check', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' })
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[tag-name-mismatch\]/)
    assert.match(run.output, /\[tag-not-found\]/)
    assert.match(run.output, /no refs\/tags\/v9\.9\.9/)
  } finally {
    repo.cleanup()
  }
})

test('a dirty worktree fails the tag push guard', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')
    repo.tag('v2.1.0')
    repo.write({ 'NOTES.txt': 'scratch\n' })

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[dirty-worktree\]/)
    assert.match(run.output, /NOTES\.txt/)
    assert.match(run.output, /worktree=1-dirty/)
  } finally {
    repo.cleanup()
  }
})

test('tag push fails when the support manifest disagrees with its restatements', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')
    repo.write({ 'scripts/mount-smoke/host.json': `${JSON.stringify({ dsh: '0.2.2-rc.2' }, null, 2)}\n` })
    repo.commit('drift the host pin')
    repo.tag('v2.1.0')

    const run = runCli(repo.dir, [], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.1.0' })
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[support-drift\]/)
    assert.match(run.output, /host\.json: dsh is "0\.2\.2-rc\.2"/)
  } finally {
    repo.cleanup()
  }
})

// --- prepublish mode over real Git repositories ----------------------------

test('prepublish passes before the tag exists and prints the guarded tag', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')

    const run = runCli(repo.dir, ['--mode', 'prepublish'])
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /mode=prepublish tag=v2\.1\.0/)
    assert.match(run.output, /previous-tag=v2\.0\.4/)
    assert.match(run.output, /tag-type=- reachable=- worktree=clean/)
  } finally {
    repo.cleanup()
  }
})

test('prepublish passes when the annotated tag is already on HEAD', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')
    repo.tag('v2.1.0')

    const run = runCli(repo.dir, ['--mode', 'prepublish'])
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /tag-type=tag reachable=yes worktree=clean/)
  } finally {
    repo.cleanup()
  }
})

test('prepublish fails closed when HEAD is tagged with another version', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')
    repo.tag('v9.9.9')

    const run = runCli(repo.dir, ['--mode', 'prepublish'])
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[tag-name-mismatch\]/)
    assert.match(run.output, /HEAD is tagged v9\.9\.9/)
  } finally {
    repo.cleanup()
  }
})

test('prepublish fails on a lightweight tag for the version', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')
    repo.tagLight('v2.1.0')

    const run = runCli(repo.dir, ['--mode', 'prepublish'])
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[tag-lightweight\]/)
    assert.match(run.output, /tag-type=commit/)
  } finally {
    repo.cleanup()
  }
})

test('prepublish requires a CHANGELOG section for the version being published', () => {
  const repo = makeRepo()
  try {
    seed(repo, { version: '2.0.4', released: { version: '2.0.4', body: '- seeded' } })
    repo.commit('release 2.0.4')
    repo.tag('v2.0.4')
    seed(repo, { version: '2.1.0', unreleased: '- feat: delivery gate' })
    repo.commit('chore: prepare 2.1.0')

    const run = runCli(repo.dir, ['--mode', 'prepublish'])
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[no-version-notes\]/)
  } finally {
    repo.cleanup()
  }
})

test('prepublish fails on a dirty worktree', () => {
  const repo = makeRepo()
  try {
    seedReleased(repo, '2.1.0')
    repo.write({ 'NOTES.txt': 'scratch\n' })

    const run = runCli(repo.dir, ['--mode', 'prepublish'])
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /\[dirty-worktree\]/)
  } finally {
    repo.cleanup()
  }
})

test('prepublish fails when the support manifest drifts and when it cannot be read', () => {
  const drift = makeRepo()
  try {
    seedReleased(drift, '2.1.0')
    drift.write({ 'scripts/mount-smoke/host.json': `${JSON.stringify({ dsh: '0.2.2-rc.2' }, null, 2)}\n` })
    drift.commit('drift the host pin')

    const drifted = runCli(drift.dir, ['--mode', 'prepublish'])
    assert.equal(drifted.status, 1, drifted.output)
    assert.match(drifted.output, /\[support-drift\]/)
    assert.match(drifted.output, /scripts\/support\.json sets "0\.2\.2-rc\.1"/)
  } finally {
    drift.cleanup()
  }

  const missing = makeRepo()
  try {
    seedReleased(missing, '2.1.0')
    // Remove the manifest from the committed tree rather than leaving it
    // deleted-but-dirty: the guard must report an unreadable manifest, not a
    // dirty worktree, and must never treat "cannot evaluate" as agreement.
    fs.rmSync(path.join(missing.dir, 'scripts', 'support.json'))
    missing.commit('drop the support manifest')

    const unreadable = runCli(missing.dir, ['--mode', 'prepublish'])
    assert.equal(unreadable.status, 1, unreadable.output)
    assert.match(unreadable.output, /\[support-unavailable\]/)
  } finally {
    missing.cleanup()
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

const PREPUBLISH_STEPS = [
  'node scripts/release-check.mjs --mode prepublish',
  'npm run support:check',
  'npm run docs:check:generated',
  'npm run docs:check:generated:tools',
  'npm run docs:check:generated:config',
  'npm run docs:check:generated:events',
  'npm run docs:check:generated:blockers',
  'npm run docs:check:generated:types',
  'npm run docs:check:generated:components',
  'npm run docs:check:generated:locale',
  'npm run docs:check:generated:shapes',
  'npm run pack:check',
]

test('npm publish runs the prepublish guard through prepublishOnly', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.scripts.prepublishOnly, 'npm run release:prepublish')
  const chain = pkg.scripts['release:prepublish']
  assert.equal(typeof chain, 'string', 'package.json must expose release:prepublish')
  assert.deepEqual(
    chain.split(' && ').map((step) => step.trim()),
    PREPUBLISH_STEPS,
    'the prepublish chain must be the release guard, the support manifest, every generated-docs check and the pack check',
  )
  // Read-only, offline and non-interactive: nothing here may write the tree,
  // install, publish, touch git/gh or reach the network.
  for (const forbidden of ['--write', 'npm ci', 'npm install', 'npm publish', 'git ', 'gh ', 'curl', 'https://', '--otp']) {
    assert.ok(!chain.includes(forbidden), `release:prepublish must not run ${forbidden}`)
  }
})

test('CONTRIBUTING links the release checklist and the tracker board', () => {
  const contributing = read('CONTRIBUTING.md')
  assert.match(contributing, /docs\/guide\/release\.md/)
  assert.match(contributing, /docs\/board\.md/)
})

test('the release checklist covers prepare, prepublish, publish, tag and notes', () => {
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
    'node scripts/release-check.mjs --mode tag --tag',
    '2FA',
    'human-only',
    'clean clone',
    'open P0/P1',
    // M74: the guard/prepublish flow.
    'npm run release:prepublish',
    'prepublishOnly',
    '--mode prepublish',
    'git cat-file -t',
    'tag-type',
    'annotated tag',
  ]) {
    assert.ok(release.includes(required), `release.md must document: ${required}`)
  }
  // The COMPATIBILITY parser reads cells 0-3; the tag belongs in cell 1.
  assert.match(release, /tag \/ commit/)
  // The guard runs after the tag is created (it checks the tag object) and
  // before it is pushed; the prepublish gate runs before `npm publish`.
  assert.ok(release.indexOf('npm run release:prepublish') < release.indexOf('npm publish --tag next'))
  assert.ok(release.indexOf('git tag -a') < release.indexOf('node scripts/release-check.mjs --mode tag'))
  assert.ok(release.indexOf('node scripts/release-check.mjs --mode tag') < release.indexOf('git push origin'))
})

test('every in-scope page lists the four protected required contexts (F51)', () => {
  const contexts = ['test (22)', 'test (24)', 'test (22, windows)', 'mount']
  for (const file of [
    'SECURITY.md',
    'README.md',
    'README.en.md',
    'CONTRIBUTING.md',
    'docs/agents/workflow.md',
    'docs/operations/ci.md',
    'docs/zh/operations/security.md',
  ]) {
    const text = read(file)
    for (const context of contexts) {
      assert.ok(text.includes(`\`${context}\``), `${file} must name \`${context}\` as a context`)
    }
  }
  // SECURITY.md is the verification source of truth: its required-checks line
  // must name all four in one place.
  assert.match(
    read('SECURITY.md'),
    /required checks `test \(22\)`, `test \(24\)`, `test \(22, windows\)` and `mount`/,
  )
  // The Windows leg is required now; "not required yet" prose is what F51
  // reported (README.md:253/260 and README.en.md:255/262 before this change).
  assert.doesNotMatch(read('README.md'), /`test \(22, windows\)`[^\n]*(非必需|不是必需|尚未必需)/)
  assert.doesNotMatch(read('README.en.md'), /`test \(22, windows\)`[^\n]*(not required|not a required)/)
})

test('the CI doc documents the hardened guard, the cutover and the prepublish gate', () => {
  const ci = read('docs/operations/ci.md')
  assert.match(ci, /npm run release:prepublish/)
  assert.match(ci, /prepublishOnly/)
  assert.match(ci, /annotated tag object/)
  assert.match(ci, /The current required contexts are[^.]*`test \(22\)`[^.]*`test \(24\)`[^.]*`test \(22, windows\)`[^.]*`mount`/)
  // The canonical transition is still documented in one place.
  assert.match(ci, /two-step cutover/i)
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
