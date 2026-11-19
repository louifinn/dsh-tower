// The shared teardown helper is itself a contract (#91).
//
// Windows can keep a handle on a file inside a temp tree after the test that
// created it has finished, so a bare recursive delete turns a green suite red
// at random. The helper retries transient failures with bounded backoff, moves
// the tree out of the way after the first one, and refuses to delete anything
// outside `os.tmpdir()`.
//
// The retry path is exercised two ways: with injected syscalls on every OS, and
// with a real Windows handle (a file opened with `FileShare.None`). The real
// case is skipped, visibly, off Windows.
//
// #184/#186: mission-worktree teardown lives in `app/teardown.js`, so its
// bounded-retry and `exclude` reporting contracts are pinned here too.
// #185/#187: the explicit opt-in orphan sweep and its three hard protections
// (the main checkout, state-recorded paths, paths outside the worktree root)
// are pinned here; the doctor report over the same inventory lives in
// tests/doctor-ownership.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CLEANUP_ATTEMPTS, TRANSIENT_CLEANUP_ERRORS, assertTempPath, removeOnce, removeTemp } from './helpers/cleanup.mjs'
import { Tower } from '../host/tower.js'
import { inventoryOrphanWorktrees, teardownWorktreeRoot } from '../app/teardown.js'
import { worktreePath } from '../domain/integration/provision.js'

function tempDir(prefix = 'dsh-tower-cleanup-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function errno(code, message = `synthetic ${code}`) {
  const error = /** @type {Error & {code?: string|number}} */ (new Error(message))
  error.code = code
  return error
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-teardown-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

async function setupRepo(prefix) {
  const { root, repo } = seedRepo(prefix)
  const tower = await Tower.open(repo)
  await tower.init({})
  return { root, repo, tower }
}

/** Write a valid state document directly, the way a crashed writer would. */
function editState(tower, mutate) {
  const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
  mutate(state)
  state.revision += 1
  state.updatedAt = Date.now()
  fs.writeFileSync(tower.paths.state, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * A merged build mission with a real provisioned checkout and no live agent:
 * exactly the state a merge leaves behind before teardown.
 */
async function mergedMission(tower, title = 'Worktree removal target') {
  const planned = await tower.plan({ missions: [{ title, scope: ['src/**'] }] })
  const mission = planned.missions[0]
  const provisioned = await tower.provision({ missionId: mission.id })
  editState(tower, (state) => {
    const record = state.missions.find((entry) => entry.id === mission.id)
    record.status = 'merged'
    record.mergedCommit = 'a'.repeat(40)
    record.mergedAt = Date.now()
    record.updatedAt = record.mergedAt
    state.roster = []
  })
  return { mission, worktree: provisioned.worktree }
}

/**
 * Replace `tower.git` with a wrapper that fails the first N `worktree remove`
 * calls with the seeded errors, then delegates to the real adapter.
 */
function failWorktreeRemove(tower, errors) {
  const realGit = tower.git.bind(tower)
  const calls = []
  tower.git = async (cwd, args, options) => {
    if (args[0] === 'worktree' && args[1] === 'remove') {
      calls.push(args)
      const error = errors.shift()
      if (error) throw error
    }
    return realGit(cwd, args, options)
  }
  return calls
}

test('assertTempPath: accepts a child of os.tmpdir and refuses everything else', () => {
  const inside = path.join(os.tmpdir(), 'dsh-tower-cleanup-target')
  assert.equal(assertTempPath(inside), path.resolve(inside))

  // The temp root itself is not a test-owned tree.
  assert.throws(() => assertTempPath(os.tmpdir()), /not inside the temp directory/)
  // A path that normalises outside is refused, not merely rejected by prefix.
  assert.throws(() => assertTempPath(path.join(os.tmpdir(), '..', 'escape')), /not inside the temp directory/)
  // A volume root is never a test-owned tree.
  assert.throws(() => assertTempPath(path.parse(os.tmpdir()).root), /not inside the temp directory/)
  assert.throws(() => assertTempPath(''), TypeError)
})

test('removeTemp: removes a tree once and treats an already-missing target as a no-op', () => {
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')

  removeTemp(root)
  assert.equal(fs.existsSync(root), false)
  removeTemp(root)
})

test('removeTemp: every transient Windows code retries and then succeeds', () => {
  assert.deepEqual([...TRANSIENT_CLEANUP_ERRORS].sort(), ['EACCES', 'EBUSY', 'EPERM'])
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const root = tempDir()
    fs.writeFileSync(path.join(root, 'held.txt'), 'held\n')
    let attempts = 0
    const slept = []
    removeTemp(root, {
      renameOutOfTheWay: false,
      remove(file) {
        attempts += 1
        if (attempts <= 2) throw errno(code)
        removeOnce(file)
      },
      sleep(ms) {
        slept.push(ms)
      },
    })
    assert.equal(attempts, 3, `${code} must be retried`)
    assert.deepEqual(slept, [25, 50], `${code} must back off between attempts`)
    assert.equal(fs.existsSync(root), false)
  }
})

test('removeTemp: moves the tree out of the way, then removes the quarantine', () => {
  const root = tempDir()
  fs.writeFileSync(path.join(root, 'held.txt'), 'held\n')
  const renamed = []
  const slept = []
  removeTemp(root, {
    rename(from, to) {
      renamed.push({ from, to })
      fs.renameSync(from, to)
    },
    remove(file) {
      if (renamed.length === 0) throw errno('EPERM')
      removeOnce(file)
    },
    sleep(ms) {
      slept.push(ms)
    },
  })

  assert.equal(renamed.length, 1, 'the first transient failure must move the tree aside')
  assert.equal(renamed[0].from, root)
  assert.ok(renamed[0].to.startsWith(`${root}.cleanup-`), 'the quarantine must be a sibling with a fresh name')
  assert.equal(assertTempPath(renamed[0].to), path.resolve(renamed[0].to))
  assert.deepEqual(slept, [25])
  assert.equal(fs.existsSync(root), false)
  assert.equal(fs.existsSync(renamed[0].to), false, 'the quarantine must not be left behind')
})

test('removeTemp: a non-transient error fails at once without sleeping', () => {
  const root = tempDir()
  try {
    let attempts = 0
    assert.throws(
      () =>
        removeTemp(root, {
          remove() {
            attempts += 1
            throw errno('EIO')
          },
          rename: () => assert.fail('a non-transient error must not move the tree'),
          sleep: () => assert.fail('a non-transient error must not sleep'),
        }),
      (error) => error?.cause?.code === 'EIO' && /EIO/.test(error.message),
    )
    assert.equal(attempts, 1)
  } finally {
    removeTemp(root)
  }
})

test('removeTemp: a persistent transient hold stops at the retry budget', () => {
  const root = tempDir()
  try {
    let attempts = 0
    const slept = []
    assert.throws(
      () =>
        removeTemp(root, {
          attempts: 3,
          renameOutOfTheWay: false,
          remove() {
            attempts += 1
            throw errno('EPERM')
          },
          sleep(ms) {
            slept.push(ms)
          },
        }),
      (error) => error?.cause?.code === 'EPERM' && error.message.includes(root),
    )
    assert.equal(attempts, 3)
    assert.deepEqual(slept, [25, 50], 'the last attempt must not sleep')
    assert.ok(CLEANUP_ATTEMPTS > 3, 'the production budget must be larger than the seeded one')
  } finally {
    removeTemp(root)
  }
})

test(
  'removeTemp: waits for a real Windows handle, then succeeds',
  {
    skip:
      process.platform === 'win32'
        ? false
        : 'requires a real Windows filesystem (a file opened with FileShare.None blocks deletion only there)',
  },
  async () => {
    const root = tempDir('dsh-tower-cleanup-handle-')
    const file = path.join(root, 'held.txt')
    fs.writeFileSync(file, 'held\n')
    // Windows PowerShell opens the file with FileShare.None, so every delete
    // attempt is EPERM until the child closes it. The child exits by itself
    // while the helper is retrying, so the retry loop is what makes the
    // removal succeed. `ready` is what makes the fixture deterministic: the
    // handle exists before the first attempt.
    const script = [
      "$h = [System.IO.File]::Open($env:DSH_TOWER_HOLD_FILE, 'Open', 'Read', 'None')",
      "[Console]::Out.WriteLine('ready')",
      '[Console]::Out.Flush()',
      'Start-Sleep -Milliseconds 400',
      '$h.Close()',
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, DSH_TOWER_HOLD_FILE: file },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const ready = new Promise((resolve, reject) => {
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (output.includes('ready')) resolve(undefined)
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (!output.includes('ready')) reject(new Error(`handle fixture exited before ready (code ${code})`))
      })
    })
    try {
      await ready
      const started = Date.now()
      removeTemp(root)
      const elapsed = Date.now() - started
      assert.equal(fs.existsSync(root), false)
      assert.ok(elapsed >= 100, `the removal must have waited for the handle (waited ${elapsed}ms)`)
    } finally {
      if (child.exitCode === null) child.kill()
      removeTemp(root)
    }
  },
)

// ---------------------------------------------------------------------------
// #184: bounded retry for `git worktree remove`. A Windows terminal/job tool
// can hold a directory handle, so the first attempts fail EPERM/EBUSY while the
// handle is released; the decision reports the attempt count and a permanent
// failure keeps the mission record instead of losing the checkout path.
// ---------------------------------------------------------------------------

test('teardown: a transient worktree-remove failure retries and reports attempts (#184)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-teardown-retry-')
  try {
    const { mission, worktree } = await mergedMission(tower)
    const calls = failWorktreeRemove(tower, [errno('EPERM'), errno('EBUSY')])

    const result = await tower.teardown({})
    assert.equal(calls.length, 3, 'two transient failures then the real removal')
    assert.deepEqual(result.removed, [mission.id])
    const decision = result.decisions.find((entry) => entry.missionId === mission.id)
    assert.equal(decision.action, 'removed')
    assert.equal(decision.attempts, 3, 'the decision reports how many attempts the removal took')
    assert.equal(fs.existsSync(worktree.path), false)
    const after = (await tower.load()).missions.find((entry) => entry.id === mission.id)
    assert.equal(typeof after.worktreeRemovedAt, 'number')
  } finally {
    removeTemp(root)
  }
})

test('teardown: a permanent worktree-remove failure is tried once and keeps the record (#184)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-teardown-permanent-')
  try {
    const { mission, worktree } = await mergedMission(tower)
    const calls = failWorktreeRemove(tower, [new Error(`fatal: '${worktree.path}' is not a working tree`)])

    const result = await tower.teardown({})
    assert.equal(calls.length, 1, 'a non-transient failure is never retried')
    const decision = result.decisions.find((entry) => entry.missionId === mission.id)
    assert.equal(decision.action, 'keep')
    assert.equal(decision.attempts, 1)
    assert.match(decision.reason, /remove failed after 1 attempt\(s\): .*not a working tree/)
    assert.equal(fs.existsSync(worktree.path), true, 'the checkout is kept')
    const after = (await tower.load()).missions.find((entry) => entry.id === mission.id)
    assert.equal(after.worktreeRemovedAt, undefined, 'the record still points at the live checkout')
  } finally {
    removeTemp(root)
  }
})

test('teardown: a persistent transient failure stops at the bounded budget and reports the final error (#184)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-teardown-budget-')
  try {
    const { mission, worktree } = await mergedMission(tower)
    // A numeric git exit code is not a string code; the permission wording is
    // what marks this as transient (the adapter keeps the spawn code in text).
    const held = errno(128, `git worktree remove failed: fatal: failed to delete '${worktree.path}': Permission denied`)
    const calls = failWorktreeRemove(tower, [held, held, held, held, held])

    const result = await tower.teardown({})
    assert.equal(calls.length, 3, 'the retry budget is bounded')
    const decision = result.decisions.find((entry) => entry.missionId === mission.id)
    assert.equal(decision.action, 'keep')
    assert.equal(decision.attempts, 3)
    assert.match(decision.reason, /remove failed after 3 attempt\(s\): .*Permission denied/)
    assert.equal(fs.existsSync(worktree.path), true)
    const after = (await tower.load()).missions.find((entry) => entry.id === mission.id)
    assert.equal(after.worktreeRemovedAt, undefined)
  } finally {
    removeTemp(root)
  }
})

// ---------------------------------------------------------------------------
// #186: `exclude` ids are diffed against what actually matched, so a typo is
// visible instead of silently keeping nothing.
// ---------------------------------------------------------------------------

test('teardown: a matching exclude id is reported by its protected decision, not as unmatched (#186)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-teardown-exclude-match-')
  try {
    const { mission, worktree } = await mergedMission(tower)

    const excluded = await tower.teardown({ exclude: [mission.id], dryRun: true })
    assert.deepEqual(excluded.unmatchedExclude, [])
    const decision = excluded.decisions.find((entry) => entry.missionId === mission.id)
    assert.equal(decision.action, 'keep')
    assert.equal(decision.reason, 'excluded')
    assert.equal(fs.existsSync(worktree.path), true, 'an excluded checkout is kept')

    const empty = await tower.teardown({ exclude: [], dryRun: true })
    assert.deepEqual(empty.unmatchedExclude, [])
    assert.equal(
      empty.decisions.some((entry) => entry.reason === 'exclude did not match any mission'),
      false,
      'an empty exclude list names nothing',
    )
  } finally {
    removeTemp(root)
  }
})

test('teardown: an exclude id that matches nothing is named in the result (#186)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-teardown-exclude-typo-')
  try {
    const { mission, worktree } = await mergedMission(tower)

    const result = await tower.teardown({ exclude: ['M99', 'M99'] })
    assert.deepEqual(result.unmatchedExclude, ['M99'], 'the unmatched id is deduped and visible')
    const decision = result.decisions.find((entry) => entry.missionId === 'M99')
    assert.equal(decision.action, 'keep')
    assert.equal(decision.reason, 'exclude did not match any mission')
    assert.deepEqual(result.removed, [mission.id], 'the real mission is still torn down')
    assert.equal(fs.existsSync(worktree.path), false)
  } finally {
    removeTemp(root)
  }
})

// ---------------------------------------------------------------------------
// #185/#187: an explicit, opt-in orphan sweep over the git registrations Tower
// never recorded. `create_worktree` stays allowed; the sweep is how an operator
// reclaims a checkout a lost record (or a crashed run) left behind. Three hard
// protections — the main checkout, every state-recorded path and every path
// outside the worktree root — are pinned here, as are the default-off stance,
// the dry-run preview and the stale-registration prune.
// ---------------------------------------------------------------------------

/** Path equality that matches Windows' case-insensitive filesystem. */
function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === ''
}

/** Create a real linked checkout under the configured worktree root, unrecorded. */
function addOrphanWorktree(tower, name) {
  const root = teardownWorktreeRoot(tower)
  fs.mkdirSync(root, { recursive: true })
  const checkout = path.join(root, name)
  git(tower.root, ['worktree', 'add', '-b', `orphan-${name}`, checkout, 'HEAD'])
  return checkout
}

/** Create a linked checkout next to the worktree root (outside it). */
function addExternalWorktree(tower, name) {
  const parent = path.dirname(teardownWorktreeRoot(tower))
  fs.mkdirSync(parent, { recursive: true })
  const checkout = path.join(parent, name)
  git(tower.root, ['worktree', 'add', '-b', `external-${name}`, checkout, 'HEAD'])
  return checkout
}

/** A planned, provisioned mission with a live recorded checkout (no teardown policy applies). */
async function activeMission(tower, title = 'Protected checkout') {
  const planned = await tower.plan({ missions: [{ title, scope: ['src/**'] }] })
  const mission = planned.missions[0]
  const provisioned = await tower.provision({ missionId: mission.id })
  return { mission, worktree: provisioned.worktree }
}

test('teardown: the orphan sweep is opt-in and a normal teardown leaves an unrecorded checkout alone (#185)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-optin-')
  try {
    const orphan = addOrphanWorktree(tower, 'unrecorded-clean')
    const result = await tower.teardown({})

    assert.equal(Object.hasOwn(result, 'orphanWorktrees'), false, 'a normal teardown returns no orphan report')
    const listed = await tower.deps.vcs.listWorktrees(tower.root)
    assert.ok(listed.some((entry) => samePath(entry.path, orphan)), 'the registration is still there')
    assert.equal(fs.existsSync(orphan), true, 'the checkout is untouched without the opt-in')
  } finally {
    removeTemp(root)
  }
})

test('teardown: orphan mode removes a clean unrecorded checkout inside the root and keeps its branch (#185)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-clean-')
  try {
    const orphan = addOrphanWorktree(tower, 'unrecorded-clean')
    const before = await tower.load()

    const result = await tower.teardown({ orphans: true })
    const report = result.orphanWorktrees
    assert.ok(report, 'the opt-in adds the orphan report')
    assert.equal(samePath(report.root, teardownWorktreeRoot(tower)), true)
    const decision = report.decisions.find((entry) => samePath(entry.path, orphan))
    assert.equal(decision.action, 'removed')
    assert.equal(decision.reason, 'eligible')
    assert.equal(decision.name, 'orphan-unrecorded-clean')
    assert.deepEqual(report.removed.map((entry) => path.resolve(entry)), [path.resolve(orphan)])
    assert.deepEqual(report.pruned, [])
    assert.equal(fs.existsSync(orphan), false, 'the clean checkout is removed')
    assert.match(git(tower.root, ['branch', '--list', 'orphan-unrecorded-clean']), /orphan-unrecorded-clean/, 'the branch is not Tower\'s to delete')

    // An unrecorded checkout has no mission to stamp: a successful sweep writes
    // no state record at all.
    const after = await tower.load()
    assert.equal(after.revision, before.revision)
  } finally {
    removeTemp(root)
  }
})

test('teardown: orphan mode keeps a dirty unrecorded checkout even with force (#185)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-dirty-')
  try {
    const orphan = addOrphanWorktree(tower, 'unrecorded-dirty')
    fs.writeFileSync(path.join(orphan, 'scratch.txt'), 'scratch\n')

    const result = await tower.teardown({ orphans: true, force: true })
    const decision = result.orphanWorktrees.decisions.find((entry) => samePath(entry.path, orphan))
    assert.equal(decision.action, 'keep')
    assert.equal(decision.reason, 'uncommitted changes')
    assert.deepEqual(result.orphanWorktrees.removed, [])
    assert.equal(fs.existsSync(orphan), true, 'only a clean checkout is removed')
  } finally {
    removeTemp(root)
  }
})

test('teardown: orphan mode never removes the main checkout, a recorded worktree or an outside path (#185)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-protect-')
  try {
    const { worktree } = await activeMission(tower)
    const external = addExternalWorktree(tower, 'outside-checkout')

    const result = await tower.teardown({ orphans: true })
    const decisions = result.orphanWorktrees.decisions
    const main = decisions.find((entry) => samePath(entry.path, tower.root))
    const recorded = decisions.find((entry) => samePath(entry.path, worktree.path))
    const outside = decisions.find((entry) => samePath(entry.path, external))
    assert.equal(main.action, 'keep')
    assert.equal(main.reason, 'main checkout')
    assert.equal(recorded.action, 'keep')
    assert.equal(recorded.reason, 'referenced by state')
    assert.equal(outside.action, 'keep')
    assert.equal(outside.reason, 'outside the worktree root')
    assert.deepEqual(result.orphanWorktrees.removed, [])
    assert.equal(fs.existsSync(worktree.path), true)
    assert.equal(fs.existsSync(external), true)
  } finally {
    removeTemp(root)
  }
})

test('teardown: a lost state file exposes its old checkout to a re-init, and orphan mode reclaims it (#185)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-lost-state-')
  try {
    const { worktree } = await mergedMission(tower)
    // A lost state file is the scenario the issue names: the checkout survives,
    // the record that pointed at it does not.
    fs.rmSync(tower.paths.state)
    await tower.init({})
    assert.deepEqual((await tower.load()).missions, [], 'the re-initialised state knows no mission')

    const result = await tower.teardown({ orphans: true })
    const decision = result.orphanWorktrees.decisions.find((entry) => samePath(entry.path, worktree.path))
    assert.equal(decision.action, 'removed')
    assert.equal(fs.existsSync(worktree.path), false)
  } finally {
    removeTemp(root)
  }
})

test('teardown: orphan dry_run previews decisions and prunes nothing (#185)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-dryrun-')
  try {
    const clean = addOrphanWorktree(tower, 'preview-clean')
    const dirty = addOrphanWorktree(tower, 'preview-dirty')
    fs.writeFileSync(path.join(dirty, 'scratch.txt'), 'scratch\n')

    const result = await tower.teardown({ orphans: true, dryRun: true })
    const decisions = result.orphanWorktrees.decisions
    const cleanRow = decisions.find((entry) => samePath(entry.path, clean))
    const dirtyRow = decisions.find((entry) => samePath(entry.path, dirty))
    assert.equal(cleanRow.action, 'remove', 'a dry run predicts the removal')
    assert.equal(dirtyRow.action, 'keep')
    assert.equal(dirtyRow.reason, 'uncommitted changes')
    assert.deepEqual(result.orphanWorktrees.removed, [])
    assert.deepEqual(result.orphanWorktrees.pruned, [])
    assert.equal(fs.existsSync(clean), true, 'a dry run removes nothing')
    assert.equal(fs.existsSync(dirty), true)
  } finally {
    removeTemp(root)
  }
})

test('teardown: orphan mode prunes a stale registration whose directory is gone (#185)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-prune-')
  try {
    const orphan = addOrphanWorktree(tower, 'stale-registration')
    fs.rmSync(orphan, { recursive: true, force: true, maxRetries: 3 })

    const result = await tower.teardown({ orphans: true })
    const decision = result.orphanWorktrees.decisions.find((entry) => samePath(entry.path, orphan))
    assert.equal(decision.action, 'pruned')
    assert.deepEqual(result.orphanWorktrees.pruned.map((entry) => path.resolve(entry)), [path.resolve(orphan)])
    const listed = await tower.deps.vcs.listWorktrees(tower.root)
    assert.equal(listed.some((entry) => samePath(entry.path, orphan)), false, 'git worktree prune cleared the registration')
  } finally {
    removeTemp(root)
  }
})

// ---------------------------------------------------------------------------
// The in-flight reservation is narrow on purpose (#185 R1). A mission only
// reserves `<root>/<id>` while it can still be about to provision it: the shape
// must declare a worktree and the status must not have closed the mission.
// Otherwise the reservation hides a checkout from the orphan sweep forever and
// the doctor can print a bare "no unrecorded worktrees" while it exists.
// ---------------------------------------------------------------------------

test('teardown: a survey mission does not reserve the worktree path, so orphan mode reclaims it (#185 R1)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-survey-reservation-')
  try {
    const planned = await tower.plan({ missions: [{ title: 'Read the seed commit', kind: 'survey' }] })
    const mission = planned.missions[0]
    const checkoutRoot = teardownWorktreeRoot(tower)
    fs.mkdirSync(checkoutRoot, { recursive: true })
    const checkout = worktreePath(checkoutRoot, mission.id)
    git(tower.root, ['worktree', 'add', '-b', 'survey-unrecorded', checkout, 'HEAD'])

    const result = await tower.teardown({ orphans: true })
    const decision = result.orphanWorktrees.decisions.find((entry) => samePath(entry.path, checkout))
    assert.equal(decision.action, 'removed', 'a survey never provisions a branch worktree, so that path is not in flight')
    assert.equal(fs.existsSync(checkout), false)
  } finally {
    removeTemp(root)
  }
})

test('teardown: a completed mission with no recorded worktree does not reserve its path either (#185 R1)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-completed-reservation-')
  try {
    const planned = await tower.plan({ missions: [{ title: 'Closed build', scope: ['src/**'] }] })
    const mission = planned.missions[0]
    editState(tower, (state) => {
      const record = state.missions.find((entry) => entry.id === mission.id)
      record.status = 'completed'
      record.updatedAt = Date.now()
    })
    const checkoutRoot = teardownWorktreeRoot(tower)
    fs.mkdirSync(checkoutRoot, { recursive: true })
    const checkout = worktreePath(checkoutRoot, mission.id)
    git(tower.root, ['worktree', 'add', '-b', 'completed-unrecorded', checkout, 'HEAD'])

    const result = await tower.teardown({ orphans: true })
    const decision = result.orphanWorktrees.decisions.find((entry) => samePath(entry.path, checkout))
    assert.equal(decision.action, 'removed', 'a completed mission is past provisioning, so its path is not in flight')
    assert.equal(fs.existsSync(checkout), false)
  } finally {
    removeTemp(root)
  }
})

test('teardown: a provisionable mission with no record yet keeps its in-flight checkout (#185 R1)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-inflight-')
  try {
    const planned = await tower.plan({ missions: [{ title: 'Live build', scope: ['src/**'] }] })
    const mission = planned.missions[0]
    const checkoutRoot = teardownWorktreeRoot(tower)
    fs.mkdirSync(checkoutRoot, { recursive: true })
    const checkout = worktreePath(checkoutRoot, mission.id)
    git(tower.root, ['worktree', 'add', '-b', 'inflight-unrecorded', checkout, 'HEAD'])

    const result = await tower.teardown({ orphans: true })
    const decision = result.orphanWorktrees.decisions.find((entry) => samePath(entry.path, checkout))
    assert.equal(decision.action, 'keep')
    assert.equal(decision.reason, 'a checkout is being provisioned and is not recorded by state yet')
    assert.deepEqual(result.orphanWorktrees.removed, [])
    assert.equal(fs.existsSync(checkout), true, 'a provisionable mission still owns the in-flight window')
  } finally {
    removeTemp(root)
  }
})

test('teardown: an unreadable mission kind keeps its reservation with a reason instead of throwing (#185 R1)', async () => {
  const { root, tower } = await setupRepo('dsh-tower-orphan-unknown-kind-')
  try {
    const checkoutRoot = teardownWorktreeRoot(tower)
    fs.mkdirSync(checkoutRoot, { recursive: true })
    const checkout = path.join(checkoutRoot, 'M404')
    git(tower.root, ['worktree', 'add', '-b', 'unknown-kind-checkout', checkout, 'HEAD'])
    // A state document the loader refuses cannot be produced through the tools;
    // hand the inventory the mission directly to pin the fail-closed shape read.
    const state = { missions: [{ id: 'M404', kind: 'mystery', status: 'planned' }], roster: [] }

    const inventory = await inventoryOrphanWorktrees(tower, state)
    const decision = inventory.decisions.find((entry) => samePath(entry.path, checkout))
    assert.equal(decision.action, 'keep')
    assert.match(decision.reason, /mission kind could not be read/)
    assert.match(decision.reason, /unknown mission kind "mystery"/)
    assert.equal(inventory.orphans.length, 0)
    assert.equal(inventory.inflight.length, 1)
  } finally {
    removeTemp(root)
  }
})

