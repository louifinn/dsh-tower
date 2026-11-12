// #161 D3: entering Tower mode reconciles the session's Agent Team stance.
// An active team is left — roster snapshotted onto the mode entry and written
// to the repository activity log, running teammates suspended (interrupt keeps
// their pending inbox) — before Tower mode reports active, and `/tower off`
// names what was released without resuming anything.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { removeTemp } from './helpers/cleanup.mjs'

// Isolate the mode store before importing host modules.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-team-'))
process.env.DSH_HOME = home
test.after(() => removeTemp(home))

const { enterMode, exitMode, describeChange, createWorkspaceHook, modeState } = await import(
  '../host/mode-state.js'
)
const { workspaceLockPath } = await import('../adapters/workspaceLock.js')

/** A throwaway git repository so the release roster has an activity log to land in. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-team-repo-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  const run = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  run(['init'])
  run(['config', 'user.email', 'tower@test'])
  run(['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  run(['add', '-A'])
  run(['commit', '-m', 'seed'])
  return { root, repo }
}

function makeAgent(id, cwd) {
  return { id, session: { header: { cwd } } }
}

/**
 * A mock agentTeams service: membership, roster rows, and the Lead-only
 * interrupt every suspended member goes through.
 */
function teamService({ role = 'lead', members = [], failInterruptFor = [] }) {
  const interrupts = []
  return {
    interrupts,
    service: {
      tryMembership: (agent) => (agent ? { role } : undefined),
      listMembers: () => members.map((member) => ({ ...member })),
      interrupt: (agent, name) => {
        if (failInterruptFor.includes(name)) throw new Error(`cannot interrupt ${name}`)
        interrupts.push(name)
        return { previousStatus: 'running' }
      },
    },
  }
}

function baseCtx(services = {}) {
  return { get: (name) => services[name] ?? undefined }
}

function readActivity(repo) {
  const file = path.join(repo, '.git', 'dsh-tower', 'activity.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('entering Tower mode leaves an active team: roster recorded, running members suspended, activity written', async () => {
  const { repo } = makeRepo()
  const team = teamService({
    role: 'lead',
    members: [
      { id: 'm0', name: 'lead', role: 'lead', status: 'running' },
      { id: 'm1', name: 'worker-one', role: 'teammate', status: 'running' },
      { id: 'm2', name: 'worker-two', role: 'teammate', status: 'inactive' },
    ],
  })
  const ctx = baseCtx({ agentTeams: team.service })
  const agent = makeAgent('team-lead-enter', repo)
  const outcome = await enterMode(ctx, 'team-lead-enter', agent, 'user', 'release work')
  assert.equal(outcome.changed, true)
  assert.deepEqual(team.interrupts, ['worker-one'], 'only running teammates are suspended')
  assert.deepEqual(
    outcome.releasedTeam.members.map((member) => `${member.name}=${member.status}`).sort(),
    ['lead=running', 'worker-one=running', 'worker-two=inactive'].sort(),
  )
  assert.deepEqual(outcome.releasedTeam.suspended, ['worker-one'])
  assert.equal(modeState.get('team-lead-enter').releasedTeam.members.length, 3)
  const activity = readActivity(repo).filter((entry) => entry.type === 'mode')
  assert.equal(activity.length, 1, 'the roster release lands in the activity log')
  assert.match(activity[0].text, /left the active agent team/)
  assert.match(activity[0].text, /worker-one=running/)
  assert.match(activity[0].text, /suspended: worker-one/)
  // tower_status reads the same release through the workspace hook's modeInfo.
  const info = createWorkspaceHook().modeInfo({ agent })
  assert.equal(info.releasedTeam.members.length, 3)
})

test('/tower off names the released roster and resumes nothing', async () => {
  const { repo } = makeRepo()
  const team = teamService({
    role: 'lead',
    members: [
      { id: 'm1', name: 'worker-one', role: 'teammate', status: 'running' },
      { id: 'm2', name: 'worker-two', role: 'teammate', status: 'inactive' },
    ],
  })
  const ctx = baseCtx({ agentTeams: team.service })
  const key = 'team-lead-exit'
  const agent = makeAgent(key, repo)
  const entered = await enterMode(ctx, key, agent, 'user', null)
  const onText = describeChange(true, entered, false, null, true)
  assert.match(onText, /An Agent Team was left on entry/)
  assert.match(onText, /worker-one, worker-two|worker-two, worker-one/)
  assert.match(onText, /nothing is resumed automatically/)
  const exited = await exitMode(key, 'user', null)
  assert.deepEqual(exited.releasedTeam.members.map((member) => member.name).sort(), ['worker-one', 'worker-two'])
  const offText = describeChange(false, exited, false, null, true)
  assert.match(offText, /was not resumed/)
  assert.match(offText, /restart it yourself/)
})

test('a teammate entering Tower mode records the roster without suspending anyone', async () => {
  const { repo } = makeRepo()
  const team = teamService({
    role: 'teammate',
    members: [
      { id: 'm0', name: 'lead', role: 'lead', status: 'running' },
      { id: 'm1', name: 'worker-one', role: 'teammate', status: 'running' },
    ],
  })
  const ctx = baseCtx({ agentTeams: team.service })
  const outcome = await enterMode(ctx, 'team-member-enter', makeAgent('team-member-enter', repo), 'user', null)
  assert.deepEqual(team.interrupts, [], 'interrupt is Lead-only; a teammate suspends nobody')
  assert.equal(outcome.releasedTeam.role, 'teammate')
  assert.match(outcome.teamNote, /only the Team Lead can suspend members/)
  // The release still reaches the activity log.
  assert.ok(readActivity(repo).some((entry) => entry.type === 'mode'))
})

test('no team service or no membership leaves nothing to reconcile', async () => {
  const { repo } = makeRepo()
  const none = await enterMode(baseCtx(), 'team-absent-service', makeAgent('team-absent-service', repo), 'user', null)
  assert.equal(none.releasedTeam, null)
  assert.equal(none.teamNote, null)
  const idle = teamService({ role: 'lead', members: [] })
  idle.service.tryMembership = () => undefined
  const outside = await enterMode(
    baseCtx({ agentTeams: idle.service }),
    'team-absent-member',
    makeAgent('team-absent-member', makeRepo().repo),
    'user',
    null,
  )
  assert.equal(outside.releasedTeam, null)
})

test('a roster read failure enters with a note instead of silently sharing the session', async () => {
  const { repo } = makeRepo()
  const broken = {
    tryMembership: () => ({ role: 'lead' }),
    listMembers: () => {
      throw new Error('team store unreadable')
    },
  }
  const outcome = await enterMode(
    baseCtx({ agentTeams: broken }),
    'team-broken-roster',
    makeAgent('team-broken-roster', repo),
    'user',
    null,
  )
  assert.equal(outcome.releasedTeam, null)
  assert.match(outcome.teamNote, /team-reconcile-failed: the team roster could not be read/)
  // The mode itself still turned on: the deny guard enforces exclusivity.
  assert.equal(outcome.mode, 'on')
})

test('a suspend failure is reported, not hidden', async () => {
  const { repo } = makeRepo()
  const team = teamService({
    role: 'lead',
    members: [
      { id: 'm1', name: 'worker-one', role: 'teammate', status: 'running' },
      { id: 'm2', name: 'worker-two', role: 'teammate', status: 'running' },
    ],
    failInterruptFor: ['worker-two'],
  })
  const outcome = await enterMode(
    baseCtx({ agentTeams: team.service }),
    'team-suspend-fail',
    makeAgent('team-suspend-fail', repo),
    'user',
    null,
  )
  assert.deepEqual(team.interrupts, ['worker-one'])
  assert.match(outcome.teamNote, /suspending worker-two failed/)
  assert.deepEqual(outcome.releasedTeam.suspended, ['worker-one'])
  assert.deepEqual(outcome.releasedTeam.failed.map((entry) => entry.name), ['worker-two'])
})

test('the activity directory is created before the first release line', async () => {
  const { repo } = makeRepo()
  const dir = path.join(repo, '.git', 'dsh-tower')
  fs.rmSync(dir, { recursive: true, force: true })
  const team = teamService({
    role: 'lead',
    members: [{ id: 'm1', name: 'worker-one', role: 'teammate', status: 'inactive' }],
  })
  await enterMode(
    baseCtx({ agentTeams: team.service }),
    'team-fresh-dir',
    makeAgent('team-fresh-dir', repo),
    'user',
    null,
  )
  assert.ok(fs.existsSync(path.join(dir, 'activity.jsonl')), 'the release line creates its own directory')
  assert.ok(!fs.existsSync(workspaceLockPath(path.join(repo, '.git'))), 'entry alone does not take the workspace lock')
})
