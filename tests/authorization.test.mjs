// Default-deny authorization kernel (Debt W1-C).
//
// One actor x tool matrix decides access, and the caller is resolved from the
// tower owner / roster only. These tests pin all 29 shipped rows (27 define()d
// tools plus the two directly registered session tools, tower_mode and
// tower_control), the five access classes, and the two tools that used to
// promote an unknown caller to the tower: tower_inbox and tower_diff.
// Run with: node --test tests/authorization.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import {
  __testResetToolSurface,
  authorizeSessionCall,
  definedToolNames,
  recordToolRegistration,
  registerTowerTools,
} from '../host/tool-registry.js'
import { Tower } from '../host/tower.js'
import { ACTOR_ACCESS, AUTHORIZATION_MATRIX, allowsAnonymous, anonymousActor, authorize, isRepositoryOptional, resolveActor } from '../host/authorization.js'
import { isRepositoryOptionalTool } from '../host/tool-profiles.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-auth-') {
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

function fakeSubagents() {
  let seq = 0
  const activations = []
  return {
    activations,
    list: () => ['spawn'],
    async startActivation(input) {
      seq += 1
      const childId = `child-${seq}`
      activations.push({ ...input, childId })
      return {
        childId,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    async sendMessage() {},
    async listDescendants() {
      return []
    },
  }
}

function makeCtx() {
  // The recorded surface is process state; every fixture starts from empty.
  __testResetToolSurface()
  const tools = new Map()
  const subagents = fakeSubagents()
  const agentPresets = { list: async () => [{ id: 'tower-worker' }, { id: 'tower-reviewer' }] }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'agentPresets') return agentPresets
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      guard() {
        return () => {}
      },
    },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  registerTowerTools(ctx)
  return { ctx, tools, subagents }
}

function execFor(agentId) {
  return { agent: { id: agentId }, signal: undefined }
}

function call(tools, name, args, agentId = 'tower-auth') {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  return tool.execute(args, execFor(agentId))
}

function assertCode(error, code, pattern) {
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
  if (pattern) assert.match(error.message, pattern)
  return true
}

/**
 * The first executable statement inside a tool's `execute` handler in the Host
 * entry source. Blank lines and comments are skipped, so a comment can never
 * stand in for the kernel call.
 *
 * @param {string} source @param {string} tool @returns {string}
 */
function firstHandlerStatement(source, tool) {
  const registered = source.indexOf(`name: '${tool}'`)
  assert.notEqual(registered, -1, `index.js must register ${tool}`)
  const execute = source.indexOf('async execute(', registered)
  assert.notEqual(execute, -1, `${tool} must have an execute handler`)
  const bodyStart = source.indexOf('\n', execute) + 1
  for (const line of source.slice(bodyStart).split('\n')) {
    const statement = line.trim()
    if (statement === '' || statement.startsWith('//') || statement.startsWith('/*') || statement.startsWith('*')) continue
    return statement
  }
  assert.fail(`${tool} execute handler has no statements`)
}

/**
 * Pin the F31 wiring: a session tool's handler must await the shared kernel call
 * as its first statement, with the same tool name and the calling exec. The scan
 * is deliberately textual: both session rows are public for every access class,
 * so no behavioural probe can observe the kernel invocation.
 *
 * @param {string} source @param {string} tool
 */
function assertSessionHandlerPinned(source, tool) {
  const first = firstHandlerStatement(source, tool)
  assert.match(
    first,
    new RegExp(`^await authorizeSessionCall\\('${tool}', exec[,)]`),
    `${tool} must await authorizeSessionCall('${tool}', exec, ...) before handler logic; first statement is: ${first}`,
  )
}

/**
 * The expected authorization matrix, written out independently of
 * host/authorization.js. Every row carries its full allow set plus its shape
 * (bootstrap flag, participant check), so widening or narrowing any single
 * cell has to be mirrored in this fixture to stay green.
 */
const EXPECTED_MATRIX = Object.freeze({
  tower_init: Object.freeze({ allow: [ACTOR_ACCESS.tower], bootstrap: true }),
  tower_plan: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_mission: Object.freeze({ allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.survey] }),
  tower_status: Object.freeze({
    allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey, ACTOR_ACCESS.unknown],
  }),
  tower_spawn: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_roster: Object.freeze({ allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey] }),
  tower_interrupt: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_diff: Object.freeze({
    allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey],
    check: true,
  }),
  tower_adopt: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_send: Object.freeze({ allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey] }),
  tower_inbox: Object.freeze({ allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey] }),
  tower_complete: Object.freeze({
    allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey],
  }),
  tower_finding: Object.freeze({
    allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey],
  }),
  tower_findings: Object.freeze({
    allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey],
  }),
  tower_review: Object.freeze({ allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.reviewer] }),
  tower_preflight: Object.freeze({
    allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey, ACTOR_ACCESS.unknown],
  }),
  tower_merge: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_rebase: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_teardown: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_doctor: Object.freeze({
    allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey, ACTOR_ACCESS.unknown],
  }),
  tower_recover: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_batch: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_resource: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_import_legacy: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_legacy_map: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  tower_test: Object.freeze({ allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.survey] }),
  tower_reload: Object.freeze({ allow: [ACTOR_ACCESS.tower] }),
  // Session tools, not repository-authorized tools: they key off the calling
  // agent's session, so every access class reaches the handler's own gates.
  tower_mode: Object.freeze({
    allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey, ACTOR_ACCESS.unknown],
  }),
  tower_control: Object.freeze({
    allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey, ACTOR_ACCESS.unknown],
  }),
})

const ACCESS_CLASSES = Object.freeze([
  ACTOR_ACCESS.tower,
  ACTOR_ACCESS.worker,
  ACTOR_ACCESS.reviewer,
  ACTOR_ACCESS.survey,
  ACTOR_ACCESS.unknown,
])

/**
 * Compare a matrix-shaped object against EXPECTED_MATRIX. Returns one problem
 * string per deviation (extra/missing row, allow-set drift, duplicate grant,
 * bootstrap flag, participant check, repository-optional flag); an empty array
 * means the matrix is pinned exactly. The mutation test feeds this checker
 * damaged copies of the real matrix and proves it notices.
 */
function matrixProblems(matrix) {
  const problems = []
  const actualKeys = Object.keys(matrix).sort()
  const expectedKeys = Object.keys(EXPECTED_MATRIX).sort()
  for (const key of expectedKeys) if (!Object.hasOwn(matrix, key)) problems.push(`missing row "${key}"`)
  for (const key of actualKeys) if (!Object.hasOwn(EXPECTED_MATRIX, key)) problems.push(`unexpected row "${key}"`)
  for (const key of expectedKeys) {
    if (!Object.hasOwn(matrix, key)) continue
    const row = matrix[key]
    const expected = EXPECTED_MATRIX[key]
    if (!Array.isArray(row?.allow)) {
      problems.push(`row "${key}" has no allow array`)
      continue
    }
    if (new Set(row.allow).size !== row.allow.length) problems.push(`row "${key}" repeats a grant: [${row.allow.join(', ')}]`)
    const actual = [...new Set(row.allow)].sort()
    const wanted = [...expected.allow].sort()
    if (actual.length !== wanted.length || actual.some((access, index) => access !== wanted[index])) {
      problems.push(`row "${key}" allows [${actual.join(', ')}]; expected [${wanted.join(', ')}]`)
    }
    if ((row.bootstrap === true) !== (expected.bootstrap === true)) {
      problems.push(`row "${key}" bootstrap is ${row.bootstrap === true}; expected ${expected.bootstrap === true}`)
    }
    if ((typeof row.check === 'function') !== (expected.check === true)) {
      problems.push(`row "${key}" check is ${typeof row.check === 'function'}; expected ${expected.check === true}`)
    }
    if (Object.hasOwn(row, 'repoOptional')) {
      problems.push(`row "${key}" carries repoOptional; the repository-optional contract lives in host/tool-profiles.js (#163)`)
    }
  }
  return problems
}

/** Hand-built actor per access class for pure authorization decisions. */
function actorFor(access) {
  const role = access === ACTOR_ACCESS.survey ? 'worker' : access
  const missionId =
    access === ACTOR_ACCESS.worker || access === ACTOR_ACCESS.reviewer
      ? 'M1'
      : access === ACTOR_ACCESS.survey
        ? 'M3'
        : null
  return { name: `${access}-actor`, role, access, agentId: `agent-${access}`, missionId, owner: 'owner', ownerMissing: false }
}

/**
 * Init as the owner, plan two build missions plus one survey, and record a
 * worker row per build, a survey worker, and a reviewer row on M1. Rows are
 * recorded directly so no worktree or checkout is needed for the matrix.
 */
async function setupMembers(prefix) {
  const { root, repo } = seedRepo(prefix)
  const { tools, subagents } = makeCtx()
  const ownerId = 'tower-auth'
  await call(tools, 'tower_init', { repoRoot: repo }, ownerId)
  const tower = await Tower.open(repo)
  const planned = await tower.plan({
    missions: [
      { title: 'Build A', scope: ['a/**'], tasks: ['write it'] },
      { title: 'Build B', scope: ['b/**'], tasks: ['write it'] },
      { title: 'Survey A', kind: 'survey' },
    ],
  })
  const head = git(repo, ['rev-parse', 'HEAD'])
  await tower.recordSpawn({ missionId: 'M1', name: 'worker-m1', role: 'worker', agentId: 'agent-worker-1', parentSessionId: ownerId, cwd: null, branch: null })
  await tower.recordSpawn({ missionId: 'M2', name: 'worker-m2', role: 'worker', agentId: 'agent-worker-2', parentSessionId: ownerId, cwd: null, branch: null })
  await tower.recordSpawn({ missionId: 'M3', name: 'survey-m3', role: 'worker', agentId: 'agent-survey-3', parentSessionId: ownerId, cwd: repo, branch: null })
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'reviewer-m1',
    role: 'reviewer',
    agentId: 'agent-reviewer-1',
    parentSessionId: ownerId,
    cwd: null,
    branch: null,
    reviewCommit: head,
  })
  return { root, repo, tools, subagents, tower, ownerId, ids: planned.missions.map((mission) => mission.id) }
}

test('authorization: the expected map pins every shipped tool and the matrix matches it exactly', async () => {
  const { tools } = makeCtx()
  // F31: registerTowerTools() defines 27 tools; the Host entry records the two
  // session tools it registers directly. The matrix must cover the recorded
  // build surface (29) even though the define() aggregate stays at 27.
  recordToolRegistration('tower_mode')
  recordToolRegistration('tower_control')
  const shipped = definedToolNames()
  assert.equal(tools.size, 27, 'the define() aggregate registers 27 tools')
  assert.equal(shipped.length, 29, 'the shipped build surface is 29 tools')
  const expected = Object.keys(EXPECTED_MATRIX).sort()
  assert.deepEqual(expected, shipped, 'the expected map names exactly the shipped surface')
  assert.deepEqual(Object.keys(AUTHORIZATION_MATRIX).sort(), expected, 'every shipped tool has exactly one policy row')

  // The regression this fixes (F31): no shipped tool may lack a row. Default
  // deny still applies to names that are not part of the shipped surface.
  for (const name of shipped) assert.ok(Object.hasOwn(AUTHORIZATION_MATRIX, name), `${name} must have a matrix row`)

  // tower_mode and tower_control are mounted by the Host entry, not by the
  // define() aggregate; tower_control is additionally gated by
  // mode.allowAgentControl before it is registered at all. The matrix row is
  // the same regardless, so the kernel never depends on which profile mounted.
  assert.equal(tools.has('tower_mode'), false, 'the define() aggregate never mounts tower_mode')
  assert.equal(tools.has('tower_control'), false, 'the define() aggregate never mounts tower_control')

  assert.deepEqual(
    [...AUTHORIZATION_MATRIX.tower_mode.allow].sort(),
    [...ACCESS_CLASSES].sort(),
    'tower_mode is a public read-only session tool',
  )
  assert.deepEqual(
    [...AUTHORIZATION_MATRIX.tower_control.allow].sort(),
    [...ACCESS_CLASSES].sort(),
    'tower_control is an explicit mode-policy row; mode.allowAgentControl and the handler own its gates',
  )

  assert.deepEqual(
    matrixProblems(AUTHORIZATION_MATRIX),
    [],
    'no row deviates from the expected allow set, bootstrap flag, participant check or repository-optional flag',
  )
  assert.ok(Object.isFrozen(AUTHORIZATION_MATRIX), 'the matrix is immutable')
  for (const [name, row] of Object.entries(AUTHORIZATION_MATRIX)) {
    assert.ok(Object.isFrozen(row), `${name} row is immutable`)
    assert.ok(Object.isFrozen(row.allow), `${name} allow list is immutable`)
  }

  await assert.rejects(
    () => authorize('tower_unknown_tool', actorFor(ACTOR_ACCESS.tower)),
    (error) => assertCode(error, 'not-authorized', /denied by default/),
  )
})

test('authorization: authorizeSessionCall fails closed when the repository cannot be opened', async () => {
  // Deliberately nonexistent: actor resolution throws, the helper falls back to
  // the anonymous actor, and the matrix still decides. authorize() sits outside
  // that fallback, so a denial is never swallowed into a successful call.
  const missingRepo = path.join(os.tmpdir(), `dsh-tower-auth-missing-${process.pid}-${Date.now()}`)
  assert.equal(fs.existsSync(missingRepo), false, 'the fixture repository must not exist')
  const exec = execFor('agent-mystery')

  await assert.rejects(
    () => authorizeSessionCall('tower_merge', exec, missingRepo),
    (error) => assertCode(error, 'not-authorized', /requires a registered roster agent or the tower/),
    'a gated row is denied, not downgraded to the fallback actor',
  )
  await assert.rejects(
    () => authorizeSessionCall('tower_unknown_tool', exec, missingRepo),
    (error) => assertCode(error, 'not-authorized', /denied by default/),
    'an unlisted name is denied through the session helper too',
  )

  // Positive control: the best-effort fallback itself is live, so the denials
  // above are not merely "everything throws". The public session row still
  // reaches the handler's own mode-policy gates.
  const actor = await authorizeSessionCall('tower_mode', exec, missingRepo)
  assert.equal(actor.access, ACTOR_ACCESS.unknown)
  assert.equal(actor.ownerMissing, true)
})

test('authorization: both Host session handlers call the kernel before any handler logic', () => {
  const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  assertSessionHandlerPinned(source, 'tower_mode')
  assertSessionHandlerPinned(source, 'tower_control')

  // Exactly one kernel call per directly registered session tool: deleting one
  // call site drops its name here even though the public row and every handler
  // behaviour test would still pass, because both rows allow every access class.
  const callSites = [...source.matchAll(/await authorizeSessionCall\('(tower_[a-z_]+)'/g)].map((match) => match[1])
  assert.deepEqual(callSites.sort(), ['tower_control', 'tower_mode'], 'both and only both session handlers authorize')
  assert.match(
    source,
    /import \{[^}]*authorizeSessionCall[^}]*\} from '\.\/host\/tool-registry\.js'/,
    'index.js imports the shared kernel call rather than a local copy',
  )

  // Negative controls: handler logic before the kernel call is caught, and a
  // missing call is caught, so a comment or a later statement cannot satisfy
  // the scan.
  const reordered = [
    "name: 'tower_mode',",
    'async execute(_args, exec) {',
    '  // authorize later, maybe',
    '  const key = agentKey(exec.agent)',
    "  await authorizeSessionCall('tower_mode', exec, agentCwd(exec.agent))",
    "  return { mode: key ? 'on' : 'off' }",
    '}',
  ].join('\n')
  assert.throws(() => assertSessionHandlerPinned(reordered, 'tower_mode'), /must await authorizeSessionCall/)
  const missing = ["name: 'tower_control',", 'async execute(args, exec) {', '  const key = agentKey(exec.agent)', '}'].join('\n')
  assert.throws(() => assertSessionHandlerPinned(missing, 'tower_control'), /must await authorizeSessionCall/)
})

test('authorization: every actor x tool cell resolves exactly as the expected map says', async () => {
  const { root, tower } = await setupMembers('dsh-tower-auth-cells-')
  try {
    const actors = {
      [ACTOR_ACCESS.tower]: await resolveActor(tower, execFor('tower-auth')),
      [ACTOR_ACCESS.worker]: await resolveActor(tower, execFor('agent-worker-1')),
      [ACTOR_ACCESS.reviewer]: await resolveActor(tower, execFor('agent-reviewer-1')),
      [ACTOR_ACCESS.survey]: await resolveActor(tower, execFor('agent-survey-3')),
      [ACTOR_ACCESS.unknown]: await resolveActor(tower, execFor('agent-not-in-roster')),
    }
    for (const access of ACCESS_CLASSES) assert.equal(actors[access].access, access, `resolved actor for ${access}`)

    for (const [tool, rule] of Object.entries(EXPECTED_MATRIX)) {
      for (const access of ACCESS_CLASSES) {
        const actor = actors[access]
        const context = { args: { missionId: actor.missionId ?? 'M1' } }
        if (rule.allow.includes(access)) {
          const grant = await authorize(tool, actor, context)
          assert.equal(grant.access, access, `${tool} grants ${access}`)
          assert.equal(grant.bootstrap, false, `${tool} grants ${access} without the bootstrap exception`)
        } else {
          await assert.rejects(
            () => authorize(tool, actor, context),
            (error) => assertCode(error, 'not-authorized'),
            `${tool} denies ${access}`,
          )
        }
      }
    }
  } finally {
    removeTemp(root)
  }
})

test('authorization: tower_reload is repository-optional only through the anonymous absent-repository path', async () => {
  assert.equal(isRepositoryOptional('tower_reload'), true)
  assert.equal(isRepositoryOptional('tower_merge'), false)
  assert.equal(isRepositoryOptionalTool('tower_reload'), true, 'the profile registry is the single source (#163)')
  assert.equal('repoOptional' in AUTHORIZATION_MATRIX.tower_reload, false, 'the matrix row no longer duplicates the marker')
  assert.equal(allowsAnonymous('tower_status'), true)
  assert.equal(allowsAnonymous('tower_reload'), false, 'the absent path is not a public row')

  const anonymous = anonymousActor(execFor('agent-reload-anon'))
  // Without the explicit absent-repository path the anonymous actor is denied:
  // a repository-present call is still decided by the tower-only row.
  await assert.rejects(
    () => authorize('tower_reload', anonymous),
    (error) => assertCode(error, 'not-authorized', /requires a registered roster agent or the tower/),
  )

  // The F39 path: no repository, no roster, explicit repository-absent context.
  const grant = await authorize('tower_reload', anonymous, { repositoryAbsent: true })
  assert.equal(grant.access, ACTOR_ACCESS.unknown)
  assert.equal(grant.repositoryAbsent, true)
  assert.equal(grant.bootstrap, false)

  // A resolved repository actor cannot borrow the absent path: without a
  // repository there is no roster identity to prove.
  await assert.rejects(
    () => authorize('tower_reload', actorFor(ACTOR_ACCESS.worker), { repositoryAbsent: true }),
    (error) => assertCode(error, 'not-authorized'),
  )

  // The flag does not weaken the repository-present contract.
  for (const access of [ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey, ACTOR_ACCESS.unknown]) {
    await assert.rejects(
      () => authorize('tower_reload', actorFor(access)),
      (error) => assertCode(error, 'not-authorized', /tower_reload|only the tower can reload/),
      `tower_reload with a repository denies ${access}`,
    )
  }
  assert.equal((await authorize('tower_reload', actorFor(ACTOR_ACCESS.tower))).access, ACTOR_ACCESS.tower)

  // The absent-repository grant belongs to the declared row, not to every tool.
  await assert.rejects(
    () => authorize('tower_merge', anonymous, { repositoryAbsent: true }),
    (error) => assertCode(error, 'not-authorized'),
  )
})

test('authorization: the expected-map checker rejects a mutated matrix', () => {
  assert.deepEqual(matrixProblems(AUTHORIZATION_MATRIX), [], 'the shipped matrix matches the fixture')

  const clone = () => ({ ...AUTHORIZATION_MATRIX })
  const withRow = (matrix, name, patch) => ({ ...matrix, [name]: { ...AUTHORIZATION_MATRIX[name], ...patch } })

  // The dangerous mutation: widen a tower-only row so a worker is admitted.
  const widened = withRow(clone(), 'tower_merge', {
    allow: [...AUTHORIZATION_MATRIX.tower_merge.allow, ACTOR_ACCESS.worker],
  })
  const widenedProblems = matrixProblems(widened)
  assert.equal(widenedProblems.length, 1, 'the widened row is the only deviation')
  assert.match(widenedProblems[0], /tower_merge/)
  assert.match(widenedProblems[0], /worker/)

  // Admitting the anonymous caller to a known-actor row is caught too.
  const unknownInbox = withRow(clone(), 'tower_inbox', {
    allow: [...AUTHORIZATION_MATRIX.tower_inbox.allow, ACTOR_ACCESS.unknown],
  })
  assert.match(matrixProblems(unknownInbox)[0], /tower_inbox.*unknown/)

  // Narrowing, row shape, and surface drift are all pinned.
  const narrowed = withRow(clone(), 'tower_inbox', { allow: [ACTOR_ACCESS.tower] })
  assert.match(matrixProblems(narrowed)[0], /tower_inbox/)
  const noBootstrap = withRow(clone(), 'tower_init', { bootstrap: false })
  assert.match(matrixProblems(noBootstrap)[0], /tower_init.*bootstrap/)
  const noCheck = withRow(clone(), 'tower_diff', { check: undefined })
  assert.match(matrixProblems(noCheck)[0], /tower_diff.*check/)
  const repeated = withRow(clone(), 'tower_merge', { allow: [ACTOR_ACCESS.tower, ACTOR_ACCESS.tower] })
  assert.match(matrixProblems(repeated)[0], /repeats a grant/)

  // A session row is pinned like any other: dropping tower_control or narrowing
  // tower_mode away from the public policy is a visible deviation.
  const missingControl = clone()
  delete missingControl.tower_control
  assert.match(matrixProblems(missingControl)[0], /missing row "tower_control"/)
  const narrowedMode = withRow(clone(), 'tower_mode', { allow: [ACTOR_ACCESS.tower] })
  assert.match(matrixProblems(narrowedMode)[0], /tower_mode/)

  // The repository-optional contract is pinned in both directions: dropping it
  // from tower_reload or lending it to another row is a deviation, and so is
  // re-introducing the duplicate matrix flag the profile registry replaced.
  const noRepoOptional = withRow(clone(), 'tower_reload', { repoOptional: false })
  assert.match(matrixProblems(noRepoOptional)[0], /tower_reload.*repoOptional/)
  const borrowedRepoOptional = withRow(clone(), 'tower_merge', { repoOptional: true })
  assert.match(matrixProblems(borrowedRepoOptional)[0], /tower_merge.*repoOptional/)

  const missing = clone()
  delete missing.tower_merge
  assert.match(matrixProblems(missing)[0], /missing row "tower_merge"/)
  const extra = { ...clone(), tower_unknown: { allow: [ACTOR_ACCESS.tower] } }
  assert.match(matrixProblems(extra)[0], /unexpected row "tower_unknown"/)

  assert.deepEqual(matrixProblems(AUTHORIZATION_MATRIX), [], 'the real matrix still passes: the checker is not always-fail')
})

test('authorization: resolveActor maps owner, worker, reviewer, survey and unknown without guessing', async () => {
  const { root, repo, tower, ownerId } = await setupMembers('dsh-tower-auth-resolve-')
  try {
    const owner = await resolveActor(tower, execFor(ownerId))
    assert.equal(owner.access, ACTOR_ACCESS.tower)
    assert.equal(owner.role, 'tower')
    assert.equal(owner.owner, ownerId)

    const worker1 = await resolveActor(tower, execFor('agent-worker-1'))
    assert.equal(worker1.access, ACTOR_ACCESS.worker)
    assert.equal(worker1.role, 'worker')
    assert.equal(worker1.name, 'worker-m1')
    assert.equal(worker1.missionId, 'M1')

    const worker2 = await resolveActor(tower, execFor('agent-worker-2'))
    assert.equal(worker2.missionId, 'M2')

    const survey = await resolveActor(tower, execFor('agent-survey-3'))
    assert.equal(survey.access, ACTOR_ACCESS.survey, 'a branchless mission shape is survey access')
    assert.equal(survey.role, 'worker')
    assert.equal(survey.missionId, 'M3')

    const reviewer = await resolveActor(tower, execFor('agent-reviewer-1'))
    assert.equal(reviewer.access, ACTOR_ACCESS.reviewer)
    assert.equal(reviewer.role, 'reviewer')
    assert.equal(reviewer.missionId, 'M1')

    const stranger = await resolveActor(tower, execFor('agent-not-in-roster'))
    assert.equal(stranger.access, ACTOR_ACCESS.unknown)
    assert.equal(stranger.role, 'unknown')
    assert.equal(stranger.owner, ownerId, 'the unknown actor still learns who owns the repository')
    assert.equal(stranger.ownerMissing, false)

    const anonymous = await resolveActor(tower, {})
    assert.equal(anonymous.access, ACTOR_ACCESS.unknown)
    assert.equal(anonymous.agentId, null)

    const fabricated = anonymousActor(execFor('agent-x'))
    assert.equal(fabricated.access, ACTOR_ACCESS.unknown)
    assert.equal(fabricated.ownerMissing, true)
  } finally {
    removeTemp(root)
  }

  // No readable state proves nothing: the caller is unknown, not the tower.
  const bare = seedRepo('dsh-tower-auth-resolve-bare-')
  try {
    const bareTower = await Tower.open(bare.repo)
    const unresolved = await resolveActor(bareTower, execFor('agent-bootstrap'))
    assert.equal(unresolved.access, ACTOR_ACCESS.unknown)
    assert.equal(unresolved.owner, null)
    assert.equal(unresolved.ownerMissing, true)
  } finally {
    removeTemp(bare.root)
  }
})

test('authorization: unknown is denied everywhere except public rows, the two session tools and an ownerless bootstrap', async () => {
  const { root, repo, tower } = await setupMembers('dsh-tower-auth-matrix-')
  try {
    const worker = await resolveActor(tower, execFor('agent-worker-1'))
    const reviewer = await resolveActor(tower, execFor('agent-reviewer-1'))
    const survey = await resolveActor(tower, execFor('agent-survey-3'))
    const unknown = await resolveActor(tower, execFor('agent-not-in-roster'))

    // The expected map, not an ad-hoc list, decides which rows are public:
    // three read-only operator surfaces stay readable so a broken repository is
    // diagnosable, and the two session tools key off the caller's session rather
    // than repository ownership (their handlers still enforce identity, reason
    // and the takeover approval path).
    const publicRows = Object.keys(EXPECTED_MATRIX).filter((tool) => EXPECTED_MATRIX[tool].allow.includes(ACTOR_ACCESS.unknown))
    assert.deepEqual(
      publicRows.sort(),
      ['tower_control', 'tower_doctor', 'tower_mode', 'tower_preflight', 'tower_status'],
      'the three read-only operator rows and the two session tools are public',
    )
    for (const tool of publicRows) {
      const grant = await authorize(tool, unknown, { args: { missionId: 'M1' } })
      assert.equal(grant.access, ACTOR_ACCESS.unknown, `${tool} is public`)
    }
    // Every other row denies an unknown caller, even on an owned repository.
    const guardedRows = Object.keys(EXPECTED_MATRIX).filter((tool) => !EXPECTED_MATRIX[tool].allow.includes(ACTOR_ACCESS.unknown))
    assert.equal(guardedRows.length, 24, 'all but the five public rows deny the unknown caller')
    for (const tool of guardedRows) {
      await assert.rejects(
        () => authorize(tool, unknown, { args: { missionId: 'M1' } }),
        (error) => assertCode(error, 'not-authorized'),
        `${tool} denies an unknown caller`,
      )
    }

    // tower_init is bootstrap-only: an ownerless actor may claim, an owned one may not.
    const ownerless = { ...anonymousActor(execFor('agent-bootstrap')), owner: null }
    const bootstrap = await authorize('tower_init', ownerless)
    assert.equal(bootstrap.bootstrap, true)
    await assert.rejects(
      () => authorize('tower_init', unknown),
      (error) => assertCode(error, 'not-authorized', /requires a registered roster agent or the tower/),
    )

    // Known classes are limited by their explicit rows.
    await assert.rejects(
      () => authorize('tower_plan', worker),
      (error) => assertCode(error, 'not-authorized', /only the tower can plan missions/),
    )
    await assert.rejects(
      () => authorize('tower_plan', reviewer),
      (error) => assertCode(error, 'not-authorized', /only the tower can plan missions/),
    )
    await assert.rejects(
      () => authorize('tower_plan', survey),
      (error) => assertCode(error, 'not-authorized', /only the tower can plan missions/),
    )
    await assert.rejects(
      () => authorize('tower_review', worker, { args: { missionId: 'M1' } }),
      (error) => assertCode(error, 'not-authorized', /only an assigned reviewer or the tower may review/),
    )
    await assert.rejects(
      () => authorize('tower_mission', reviewer, { args: { missionId: 'M1' } }),
      (error) => assertCode(error, 'not-authorized', /only the tower or the mission's worker may update a mission/),
    )
    await assert.rejects(
      () => authorize('tower_test', reviewer, { args: { missionId: 'M1' } }),
      (error) => assertCode(error, 'not-authorized', /reviewers may not run test discovery/),
    )

    // Worker and survey can reach the mission/test/app layers that own the deeper rules.
    assert.equal((await authorize('tower_mission', worker, { args: { missionId: 'M1' } })).access, ACTOR_ACCESS.worker)
    assert.equal((await authorize('tower_test', worker, { args: { missionId: 'M1' } })).access, ACTOR_ACCESS.worker)
    assert.equal((await authorize('tower_inbox', survey)).access, ACTOR_ACCESS.survey)
    assert.equal((await authorize('tower_findings', reviewer, { args: { id: 'F1' } })).access, ACTOR_ACCESS.reviewer)
    assert.equal((await authorize('tower_complete', reviewer, { args: { missionId: 'M1' } })).access, ACTOR_ACCESS.reviewer)

    // Diff visibility is mission-scoped: a participant passes, a non-participant does not.
    assert.equal((await authorize('tower_diff', worker, { args: { missionId: 'M1' } })).access, ACTOR_ACCESS.worker)
    await assert.rejects(
      () => authorize('tower_diff', worker, { args: { missionId: 'M2' } }),
      (error) => assertCode(error, 'not-authorized', /does not participate in mission M2/),
    )
    await assert.rejects(
      () => authorize('tower_diff', reviewer, { args: { missionId: 'M2' } }),
      (error) => assertCode(error, 'not-authorized', /does not participate in mission M2/),
    )
    assert.equal((await authorize('tower_diff', survey, { args: { missionId: 'M3' } })).access, ACTOR_ACCESS.survey)
  } finally {
    removeTemp(root)
  }
})

test('authorization: restricted rows deny every access class outside the expected allow set', async () => {
  // Every tower-only row (including the bootstrap row) refuses the other four classes.
  const towerOnly = Object.keys(EXPECTED_MATRIX).filter(
    (tool) => EXPECTED_MATRIX[tool].allow.length === 1 && EXPECTED_MATRIX[tool].allow[0] === ACTOR_ACCESS.tower,
  )
  assert.equal(towerOnly.length, 14, 'fourteen rows are tower-only')
  for (const tool of towerOnly) {
    for (const access of ACCESS_CLASSES) {
      if (access === ACTOR_ACCESS.tower) continue
      await assert.rejects(
        () => authorize(tool, actorFor(access), { args: { missionId: 'M1' } }),
        (error) => assertCode(error, 'not-authorized'),
        `${tool} denies ${access}`,
      )
    }
    assert.equal((await authorize(tool, actorFor(ACTOR_ACCESS.tower), { args: { missionId: 'M1' } })).access, ACTOR_ACCESS.tower)
  }

  // The highest-risk row specifically: only the tower may merge.
  for (const access of [ACTOR_ACCESS.worker, ACTOR_ACCESS.reviewer, ACTOR_ACCESS.survey, ACTOR_ACCESS.unknown]) {
    await assert.rejects(
      () => authorize('tower_merge', actorFor(access), { args: { missionId: 'M1' } }),
      (error) => assertCode(error, 'not-authorized'),
      `tower_merge denies ${access}`,
    )
  }

  // tower_review is asymmetric: the tower and reviewers only.
  for (const access of [ACTOR_ACCESS.worker, ACTOR_ACCESS.survey, ACTOR_ACCESS.unknown]) {
    await assert.rejects(
      () => authorize('tower_review', actorFor(access), { args: { missionId: 'M1' } }),
      (error) => assertCode(error, 'not-authorized'),
      `tower_review denies ${access}`,
    )
  }
  for (const access of [ACTOR_ACCESS.tower, ACTOR_ACCESS.reviewer]) {
    assert.equal((await authorize('tower_review', actorFor(access), { args: { missionId: 'M1' } })).access, access)
  }

  // The inbox used to promote an unknown caller to the tower; it is denied outright.
  await assert.rejects(
    () => authorize('tower_inbox', actorFor(ACTOR_ACCESS.unknown)),
    (error) => assertCode(error, 'not-authorized', /requires a registered roster agent or the tower/),
  )

  // Public rows stay callable for every class, including unknown.
  for (const tool of ['tower_status', 'tower_preflight', 'tower_doctor', 'tower_mode', 'tower_control']) {
    for (const access of ACCESS_CLASSES) {
      const grant = await authorize(tool, actorFor(access), { args: { missionId: 'M1' } })
      assert.equal(grant.access, access, `${tool} is public for ${access}`)
    }
  }
})

test('tower_inbox: an unknown caller cannot read, acknowledge or clear mail, and each actor reads only its own', async () => {
  const { root, repo, tools, tower } = await setupMembers('dsh-tower-auth-inbox-')
  try {
    await tower.recordMessage({ from: 'tower', to: 'worker-m1', subject: 'direct m1', body: 'one' })
    await tower.recordMessage({ from: 'tower', to: 'worker-m2', subject: 'direct m2', body: 'two' })
    await tower.recordMessage({ from: 'tower', to: 'all', subject: 'broadcast', body: 'all' })
    await tower.recordMessage({ from: 'worker-m1', to: 'tower', subject: 'status', body: 'hi' })
    const seeded = await tower.load()
    assert.equal(seeded.messages.length, 4)
    assert.ok(seeded.messages.every((message) => (message.readBy ?? []).length === 0), 'nothing is acknowledged before anyone reads')

    // A missing agent id and an id outside the roster are both denied before any write.
    await assert.rejects(
      () => tools.get('tower_inbox').execute({ repoRoot: repo }, {}),
      (error) => assertCode(error, 'not-authorized', /requires a registered roster agent or the tower/),
    )
    await assert.rejects(
      () => call(tools, 'tower_inbox', { repoRoot: repo }, 'agent-not-in-roster'),
      (error) => assertCode(error, 'not-authorized', /requires a registered roster agent or the tower/),
    )
    const untouched = await tower.load()
    assert.equal(untouched.revision, seeded.revision, 'a denied inbox read does not write state')
    assert.ok(untouched.messages.every((message) => (message.readBy ?? []).length === 0), 'a denied read acknowledges nothing')

    // The M1 worker sees only mail addressed to it (plus broadcasts) and clears it.
    const m1 = await call(tools, 'tower_inbox', { repoRoot: repo }, 'agent-worker-1')
    assert.equal(m1.reader, 'worker-m1')
    assert.deepEqual(m1.messages.map((message) => message.subject).sort(), ['broadcast', 'direct m1'])
    assert.equal(m1.unreadRemaining, 0)
    const afterM1 = await tower.load()
    assert.deepEqual(afterM1.messages.find((message) => message.subject === 'direct m1').readBy, ['worker-m1'])
    assert.deepEqual(afterM1.messages.find((message) => message.subject === 'direct m2').readBy, [], 'another worker mail is not acknowledged')
    assert.deepEqual(afterM1.messages.find((message) => message.subject === 'broadcast').readBy, ['worker-m1'])

    // The M2 worker cannot see or acknowledge the M1 worker's direct mail.
    const m2 = await call(tools, 'tower_inbox', { repoRoot: repo }, 'agent-worker-2')
    assert.equal(m2.reader, 'worker-m2')
    assert.deepEqual(m2.messages.map((message) => message.subject).sort(), ['broadcast', 'direct m2'])
    assert.ok(!m2.messages.some((message) => message.subject === 'direct m1'))

    // The tower reads its own mailbox, never another agent's direct mail.
    const towerInbox = await call(tools, 'tower_inbox', { repoRoot: repo }, 'tower-auth')
    assert.equal(towerInbox.reader, 'tower')
    assert.deepEqual(towerInbox.messages.map((message) => message.subject), ['status'])
    assert.ok(!towerInbox.messages.some((message) => message.subject === 'direct m1' || message.subject === 'direct m2'))

    // Reviewers and survey workers keep their own known-actor mailboxes.
    const reviewerInbox = await call(tools, 'tower_inbox', { repoRoot: repo }, 'agent-reviewer-1')
    assert.equal(reviewerInbox.reader, 'reviewer-m1')
    assert.deepEqual(reviewerInbox.messages.map((message) => message.subject), ['broadcast'])
    const surveyInbox = await call(tools, 'tower_inbox', { repoRoot: repo }, 'agent-survey-3')
    assert.equal(surveyInbox.reader, 'survey-m3')
    assert.deepEqual(surveyInbox.messages.map((message) => message.subject), ['broadcast'])
  } finally {
    removeTemp(root)
  }
})

test('tower_diff: unknown callers and non-participants are denied, participants reach the app layer', async () => {
  const { root, repo, tools } = await setupMembers('dsh-tower-auth-diff-')
  try {
    // Denied before mission lookup: a stranger learns nothing about mission existence.
    await assert.rejects(
      () => call(tools, 'tower_diff', { repoRoot: repo, missionId: 'M404' }, 'agent-not-in-roster'),
      (error) => assertCode(error, 'not-authorized', /requires a registered roster agent or the tower/),
    )
    await assert.rejects(
      () => call(tools, 'tower_diff', { repoRoot: repo, missionId: 'M1' }, 'agent-worker-2'),
      (error) => assertCode(error, 'not-authorized', /does not participate in mission M1/),
    )
    await assert.rejects(
      () => call(tools, 'tower_diff', { repoRoot: repo, missionId: 'M2' }, 'agent-reviewer-1'),
      (error) => assertCode(error, 'not-authorized', /does not participate in mission M2/),
    )

    // Participants pass the kernel and reach the app refusal for a mission with no worktree yet.
    for (const [agentId, missionId] of [
      ['tower-auth', 'M2'],
      ['agent-worker-1', 'M1'],
      ['agent-reviewer-1', 'M1'],
    ]) {
      await assert.rejects(
        () => call(tools, 'tower_diff', { repoRoot: repo, missionId }, agentId),
        (error) => {
          assert.equal(error.code, 'invalid-argument', `${agentId} passes authorization for ${missionId}`)
          assert.match(error.message, /no worktree/)
          return true
        },
      )
    }

    // A survey worker participates, but its shape has no branch diff at all.
    await assert.rejects(
      () => call(tools, 'tower_diff', { repoRoot: repo, missionId: 'M3' }, 'agent-survey-3'),
      (error) => assertCode(error, 'invalid-transition', /no branch diff/),
    )
  } finally {
    removeTemp(root)
  }
})

test('authorization: tower-only tools deny workers and unknown callers without side effects', async () => {
  const { root, repo, tools, subagents, tower, ownerId } = await setupMembers('dsh-tower-auth-owned-')
  try {
    const before = await tower.load()
    await assert.rejects(
      () => call(tools, 'tower_spawn', { repoRoot: repo, missionId: 'M2', role: 'worker' }, 'agent-worker-1'),
      (error) => assertCode(error, 'not-authorized', /only the tower can spawn tower agents/),
    )
    await assert.rejects(
      () => call(tools, 'tower_merge', { repoRoot: repo, missionId: 'M1' }, 'agent-worker-1'),
      (error) => assertCode(error, 'not-authorized', /only the tower can merge missions/),
    )
    await assert.rejects(
      () => call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Sneaky', scope: ['x/**'] }] }, 'agent-worker-1'),
      (error) => assertCode(error, 'not-authorized', /only the tower can plan missions/),
    )
    await assert.rejects(
      () => call(tools, 'tower_init', { repoRoot: repo }, 'agent-not-in-roster'),
      (error) => assertCode(error, 'not-authorized', /requires a registered roster agent or the tower/),
    )
    await assert.rejects(
      () => call(tools, 'tower_init', { repoRoot: repo }, 'agent-worker-1'),
      (error) => assertCode(error, 'not-authorized', /only the tower can initialize Tower state/),
    )

    const after = await tower.load()
    assert.equal(after.revision, before.revision, 'denied tower-only calls do not write state')
    assert.equal(after.missions.length, before.missions.length)
    assert.equal(subagents.activations.length, 0, 'denied calls start no subagents')

    const planned = await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'After denials', scope: ['c/**'] }] }, ownerId)
    assert.equal(planned.missions.length, 1, 'the owner can still plan one new mission')
    assert.equal((await tower.load()).missions.length, 4, 'the new mission landed on top of the untouched three')
  } finally {
    removeTemp(root)
  }
})

test('authorization: tower_init bootstraps only while no owner exists, then the owner is required', async () => {
  const { root, repo } = seedRepo('dsh-tower-auth-bootstrap-')
  try {
    const { tools } = makeCtx()
    // Before any state the re-claim hint is actionable, not a tower promotion.
    await assert.rejects(
      () => call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Early' }] }, 'agent-bootstrap'),
      (error) => assertCode(error, 'not-authorized', /tower_init to re-claim/),
    )
    const claimed = await call(tools, 'tower_init', { repoRoot: repo }, 'agent-bootstrap')
    assert.equal(claimed.created, true)
    assert.equal(claimed.repoRoot, repo)
    const state = await (await Tower.open(repo)).load()
    assert.equal(state.towerAgentId, 'agent-bootstrap')

    // Once owned, another unidentified agent cannot re-claim.
    await assert.rejects(
      () => call(tools, 'tower_init', { repoRoot: repo }, 'agent-impostor'),
      (error) => assertCode(error, 'not-authorized', /requires a registered roster agent or the tower/),
    )
    const after = await (await Tower.open(repo)).load()
    assert.equal(after.towerAgentId, 'agent-bootstrap')

    // The owner may re-initialize.
    await call(tools, 'tower_init', { repoRoot: repo }, 'agent-bootstrap')

    // Bootstrap still refuses an unidentified caller instead of claiming for it.
    const second = seedRepo('dsh-tower-auth-bootstrap-empty-')
    try {
      await assert.rejects(
        () => tools.get('tower_init').execute({ repoRoot: second.repo }, {}),
        (error) => assertCode(error, 'not-authorized', /caller agent id/),
      )
    } finally {
      removeTemp(second.root)
    }
  } finally {
    removeTemp(root)
  }
})
