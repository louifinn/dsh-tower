// #248: a mission whose work reached the base without a clean review at the tip
// can be recorded merged — once, explicitly, with an audit trail. Before this,
// `tower_merge` refused on `not-clean`/`tip-moved` and `tower_rebase` answered
// "already contained … call tower_merge", so the mission was wedged forever and
// `tower_init({reanchor:true})` could never move the base.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { Tower } from '../host/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seed(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

function readState(tower) {
  return JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
}

function blockerCodes(result) {
  return (result.blockers ?? []).map((blocker) => blocker.code)
}

function blockerFor(result, code) {
  return (result.blockers ?? []).find((blocker) => blocker.code === code)
}

/**
 * A completed mission whose reviewer returned p2/fix-then-merge and whose tip
 * then moved once: exactly the shape `fix-then-merge` produces when the tower
 * resolves the finding itself.
 */
async function p2MissionThenFix(prefix) {
  const { root, repo } = seed(prefix)
  const configDir = path.join(repo, '.git', 'dsh-tower')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ review: { mode: 'required' } }))
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({
    missions: [{ title: 'Landed record', scope: ['src/**'], tasks: ['write file', 'commit'] }],
  })
  const provisioned = await tower.provision({ missionId: 'M1' })
  const wt = provisioned.worktree.path
  const branch = provisioned.worktree.branch
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', 'M1 a'])
  await tower.mission({ id: 'M1', status: 'active' })
  await tower.mission({ id: 'M1', task_done: 'write file' })
  await tower.mission({ id: 'M1', task_done: 'commit' })
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-1',
    role: 'worker',
    agentId: 'agent-worker',
    parentSessionId: 'parent-1',
    cwd: wt,
    branch,
  })
  await tower.complete({ missionId: 'M1', agentId: 'agent-worker', report: 'done' })
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'reviewer-1',
    role: 'reviewer',
    agentId: 'agent-review-1',
    parentSessionId: 'parent-review',
    cwd: wt,
    branch,
    reviewCommit: git(wt, ['rev-parse', 'HEAD']),
  })
  await tower.submitReview({
    missionId: 'M1',
    agentId: 'agent-review-1',
    status: 'p2-1items',
    merge: 'fix-then-merge',
    findings: 'src/a.txt:1 names the wrong file',
    decision: 'fix it and merge',
  })
  // The tower resolves the finding itself: the reviewed tip is now behind.
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'fixed\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', 'M1 a: resolve the P2'])
  await tower.mission({ id: 'M1', status: 'completed', note: 'tower resolved the P2 by hand' })
  return { root, repo, tower, wt, branch, tip: git(wt, ['rev-parse', 'HEAD']) }
}

/** The commit range a hand landing has to reproduce: base..branch, oldest first. */
function branchCommits(repo, branch) {
  return git(repo, ['rev-list', '--reverse', `HEAD..${branch}`]).split('\n').filter(Boolean)
}

test('#248: a p2-reviewed mission with a moved tip is refused, then recorded with record:{reason}', async () => {
  const { root, repo, tower, wt, tip } = await p2MissionThenFix('dsh-tower-landed-record-')
  try {
    // 1. The ordinary merge refuses before anything landed: the review does not
    //    cover the tip, so the gate reports both causes and names the remediations.
    const refused = await tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(refused.ok, false)
    assert.deepEqual(blockerCodes(refused).sort(), ['not-clean', 'tip-moved'])
    assert.equal(readState(tower).missions[0].status, 'completed')

    // 2. Land the branch content by hand — the shape this issue exists for.
    git(repo, ['merge', '--no-ff', '-m', 'land M1 by hand', 'tower/m1-landed-record'])

    // 3. Without `record`, the refusal changes shape: the work is in the base and
    //    the only remediation left is a reviewed record.
    const unrecorded = await tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(unrecorded.ok, false)
    const blocker = blockerFor(unrecorded, 'landed-unrecorded')
    assert.ok(blocker, JSON.stringify(unrecorded.blockers))
    assert.match(blocker.detail, /the work shipped/i)
    assert.match(blocker.detail, /record:\s*\{\s*reason/)
    assert.equal(readState(tower).missions[0].status, 'completed')

    // 4. With `record`, the same call records the landing in one step.
    const landingMerge = git(repo, ['rev-parse', 'HEAD'])
    const recorded = await tower.merge({
      missionId: 'M1',
      activity: {},
      record: {
        reason: 'tower resolved the P2 in the follow-up commit; the reviewer had already accepted the shape',
        commits: [tip],
      },
    })
    assert.equal(recorded.ok, true, JSON.stringify(recorded))
    assert.equal(recorded.recorded, true)
    assert.equal(recorded.basis, 'review-superseded')
    // The recorded commit is the one that integrated the branch into the base,
    // not the branch tip: the tip never became an ancestor by itself.
    assert.equal(recorded.mergedCommit, landingMerge)
    const state = readState(tower)
    assert.equal(state.missions[0].status, 'merged')
    assert.equal(state.missions[0].mergedCommit, landingMerge)
    assert.match(state.missions[0].notes.at(-1), /recorded landed merge/i)
    assert.match(state.missions[0].notes.at(-1), /review round 1 was "p2-1items"/)
    assert.match(state.missions[0].notes.at(-1), /resolved the P2/)
    // Recording never rewrites the branch or the base.
    assert.equal(git(wt, ['rev-parse', 'HEAD']), tip)
  } finally {
    removeTemp(root)
  }
})

test('#248: record refuses a commit that never landed and leaves the state untouched', async () => {
  const { root, repo, tower } = await p2MissionThenFix('dsh-tower-landed-record-refuse-')
  try {
    git(repo, ['merge', '--no-ff', '-m', 'land M1 by hand', 'tower/m1-landed-record'])
    const baseBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    // A commit that exists only on a scratch branch: never in the base.
    git(repo, ['checkout', '-b', 'scratch-unlanded', 'tower/m1-landed-record'])
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'never landed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'unlanded work'])
    const unlanded = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['checkout', baseBranch])
    assert.equal(await tower.isAncestor(repo, unlanded, 'HEAD'), false, 'the scratch commit must not be in the base')

    const before = readState(tower).revision
    const refused = await tower.merge({
      missionId: 'M1',
      activity: {},
      record: { reason: 'this commit never landed', commits: [unlanded] },
    })
    assert.equal(refused.ok, false)
    const blocker = blockerFor(refused, 'landed-unrecorded')
    assert.ok(blocker, JSON.stringify(refused.blockers))
    assert.match(blocker.detail, /not in |none of record\.commits/i)
    const after = readState(tower)
    assert.equal(after.missions[0].status, 'completed')
    assert.equal(after.revision, before, 'a refused record writes nothing')
  } finally {
    removeTemp(root)
  }
})

test('#248: a cherry-picked landing is recognised as content-equivalent', async () => {
  const { root, repo, tower, tip } = await p2MissionThenFix('dsh-tower-landed-cherry-')
  try {
    // Cherry-pick the whole range instead of merging: the content ships on the
    // base with new SHAs, so the tip is not an ancestor of the base.
    const commits = branchCommits(repo, 'tower/m1-landed-record')
    assert.ok(commits.length >= 2, `expected the mission commits, saw ${JSON.stringify(commits)}`)
    git(repo, ['cherry-pick', ...commits])
    const picked = git(repo, ['rev-parse', 'HEAD'])
    assert.notEqual(picked, tip)
    // Sanity: the branch tip really is unreachable from the base.
    assert.equal(await tower.isAncestor(repo, tip, 'HEAD'), false, 'the original tip must not be an ancestor')

    const recorded = await tower.merge({
      missionId: 'M1',
      activity: {},
      record: { reason: 'cherry-picked onto the release branch during the wave', commits: [picked] },
    })
    assert.equal(recorded.ok, true, JSON.stringify(recorded))
    assert.equal(recorded.recorded, true)
    assert.equal(recorded.basis, 'content-equivalent')
    assert.equal(recorded.mergedCommit, picked)
    assert.equal(readState(tower).missions[0].status, 'merged')
  } finally {
    removeTemp(root)
  }
})

test('#248: a landed mission keeps its worktree until the landing is recorded, then retires', async () => {
  const { root, repo, tower, wt } = await p2MissionThenFix('dsh-tower-landed-teardown-')
  try {
    git(repo, ['merge', '--no-ff', '-m', 'land M1 by hand', 'tower/m1-landed-record'])

    // Before the record, teardown keeps the checkout and names the one call that
    // clears it: the worktree is the evidence `record` needs.
    const wedged = await tower.teardown({ dryRun: true, force: true })
    const kept = wedged.decisions.find((entry) => entry.missionId === 'M1')
    assert.equal(kept.action, 'keep', JSON.stringify(wedged.decisions))
    assert.match(kept.reason, /record it first/i)
    assert.match(kept.reason, /tower_merge/)

    await tower.merge({ missionId: 'M1', activity: {}, record: { reason: 'landed by hand during the wave' } })
    const sweep = await tower.teardown({ force: true })
    const removed = sweep.decisions.find((entry) => entry.missionId === 'M1')
    assert.equal(removed.action, 'removed', JSON.stringify(sweep.decisions))
    assert.equal(fs.existsSync(wt), false)
    assert.ok(readState(tower).missions[0].worktreeRemovedAt, 'the removal is stamped')
  } finally {
    removeTemp(root)
  }
})

test('#248: reanchor proceeds while a landed-but-unrecorded mission is still completed', async () => {
  const { root, repo, tower } = await p2MissionThenFix('dsh-tower-landed-reanchor-')
  try {
    git(repo, ['merge', '--no-ff', '-m', 'land M1 by hand', 'tower/m1-landed-record'])
    // A second base ref so reanchor has somewhere to move to.
    git(repo, ['branch', 'next-base'])

    // The mission is still `completed`, but its work is in the base: reanchor no
    // longer treats it as an open mission blocking the move.
    await tower.init({ base: 'next-base', reanchor: true })
    const state = readState(tower)
    assert.equal(state.base, 'next-base')
    assert.equal(state.missions[0].status, 'completed', 'reanchor does not rewrite mission status')
  } finally {
    removeTemp(root)
  }
})

test('#248: a mission whose branch never moved is never reported landed', async () => {
  const { root, repo } = seed('dsh-tower-landed-empty-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Empty branch', scope: ['src/**'], tasks: ['write file'] }] })
    const provisioned = await tower.provision({ missionId: 'M1' })
    // No commit: the branch still points at the base tip, which is trivially an
    // ancestor. That is "nothing to land", not "landed".
    const swept = await tower.teardown({ dryRun: true })
    const decision = swept.decisions.find((entry) => entry.missionId === 'M1')
    assert.equal(decision.action, 'keep', JSON.stringify(swept.decisions))
    assert.match(decision.reason, /mission is planned/)
    assert.equal(fs.existsSync(provisioned.worktree.path), true)
  } finally {
    removeTemp(root)
  }
})
