// Property 5 (#130): generated command sequences never reach an illegal state.
//
// The sequence generator deliberately does not drive the tower's status-patch
// escape hatch. `applyMissionUpdate` accepts a bare `status: 'completed'` patch
// even when tasks are open — that override is intentional and pinned by
// tests/state-machine.test.mjs ("mission transitions: blocked can be marked
// completed again"). Completion instead goes through the admission pipeline
// (`assertCompletionRequest` → `completionReport` → `applyCompletion`) and a
// merge goes through the gate (`completionBlockers` + `mergeGateBlockers`)
// before `applyMergeSuccess`, exactly like app/mission.js and app/merge.js.
// Merge can only be recorded for a mission the gate admits, so a merged mission
// either carries a clean/merge review at the reviewed tip or is legitimately
// review-exempt (`reviewPolicy: none` plus a non-empty exemption reason under a
// config that allows the exemption) — both are legal, and the property checks
// the exemption itself too.
//
// Invariants checked after every accepted command:
//   * revision is a non-negative integer;
//   * mission ids are unique and every status is a known status;
//   * completed and merged missions have no open tasks and carry a completion
//     report;
//   * merged missions have no blockers, the recorded merge commit, and the
//     review evidence described above;
//   * a mission that reaches a terminal status never leaves that terminal status.
//
// Every rejected command must leave the committed state byte-identical (a
// refusal is a no-op), which is the atomicity M25 established for routed writes.
//
// No shrunk domain counterexample has been observed for this property across the
// three PR seeds (131, 40961, 978217) or the 2000-run long tier; the frozen
// completion and merge matrices at the bottom are the permanent guard and do not
// come from a recorded failure.
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { TowerToolError } from '../../domain/errors.js'
import { ROSTER_INACTIVE_STATES } from '../../domain/roster.js'
import { validateState } from '../../domain/state.js'
import { completionBlockers, mergeGateBlockers } from '../../domain/gate.js'
import { applyMergeSuccess } from '../../domain/integration/merge.js'
import { isReviewExempt, latestReview, reviewExemptionInvalid, reviewsForBranch } from '../../domain/integration/review.js'
import {
  assertCompletionRequest,
  completionReport,
  applyCompletion,
} from '../../domain/missions/completion.js'
import { applyMissionUpdate } from '../../domain/missions/lifecycle.js'
import {
  applyReviewOutcome,
  normalizeReviewVerdict,
  reviewAdmission,
  reviewOutcome,
  reviewRecord,
  reviewRound,
} from '../../domain/missions/review.js'
import { mergeVerdictArb, reviewStatusArb, stateWithMissionsArb } from './arbitraries/index.mjs'
import { runProperty } from './helpers/harness.mjs'
import { MODEL_CONFIG, MODEL_STATUSES } from './model/tables.mjs'

const NOW = 1_700_000_000_000
const REPORT = 'property-driven completion report'
const REVIEWER = 'prop-reviewer'
const ABANDON_NOTE = 'property-driven abandon'
const AUTHORIZATION = 'authorized-by-property'
const MERGED_TIP = 'f'.repeat(40)
const MAX_REPORT_BYTES = 32_768

/** Starting statuses for generated missions; the sequence may move them anywhere legal. */
const OPEN_SEQUENCE_STATUSES = ['planned', 'active', 'blocked', 'paused']

/** Status targets the tower's generic patch may legally request (never completed/merged). */
const PATCH_TARGETS = MODEL_STATUSES.filter((status) => status !== 'completed' && status !== 'merged')

/**
 * A synthetic 40-character lower-case hex tip, distinct per mission index.
 * @param {number} index
 * @returns {string}
 */
function syntheticTip(index) {
  return ((index + 1) % 16).toString(16).repeat(40)
}

/**
 * The trailing number of a tower id (`R12` → 12), or 0 when there is none.
 * @param {unknown} value
 * @returns {number}
 */
function idNumber(value) {
  const match = /(\d+)\s*$/.exec(String(value ?? ''))
  return match ? Number(match[1]) : 0
}

/**
 * @param {string} missionId
 * @returns {string}
 */
function workerName(missionId) {
  return `prop-worker-${missionId}`
}

/**
 * @param {string} missionId
 * @returns {string}
 */
function workerAgentId(missionId) {
  return `agent-${workerName(missionId)}`
}

/**
 * @param {any} state
 * @param {number} index
 * @returns {any}
 */
function missionAt(state, index) {
  const missions = state.missions ?? []
  return missions[index % Math.max(1, missions.length)]
}

/**
 * Normalize a generated state into a sequence base:
 *   * missions start in a non-terminal status with a worktree and a worker owner;
 *   * a roster row exists for every mission (so completion admission can find it);
 *   * branch names use an upper-case slug, which `branchNameArb` cannot produce,
 *     so generated review rows never collide with the branches driven here;
 *   * sequence counters are raised above any existing generated id.
 * @param {any} state
 * @returns {any}
 */
function prepareSequenceState(state) {
  const base = structuredClone(state)
  base.schemaVersion = 3
  base.base = 'main'
  base.revision = Number.isInteger(base.revision) && base.revision >= 0 ? base.revision : 0
  base.updatedAt = NOW
  base.caseInsensitive = base.caseInsensitive ?? false
  base.mergeIntent = null
  base.rebaseIntent = null
  for (const key of ['missions', 'roster', 'reviews', 'findings', 'messages', 'batches']) {
    if (!Array.isArray(base[key])) base[key] = []
  }
  base.reviewSeq = Math.max(
    Number.isInteger(base.reviewSeq) ? base.reviewSeq : 0,
    ...base.reviews.map((review) => idNumber(review?.id)),
    0,
  )
  base.findingSeq = Math.max(
    Number.isInteger(base.findingSeq) ? base.findingSeq : 0,
    ...base.findings.map((finding) => idNumber(finding?.id)),
    0,
  )
  base.missions = base.missions.map((mission, index) => {
    const status = OPEN_SEQUENCE_STATUSES[index % OPEN_SEQUENCE_STATUSES.length]
    const id = String(mission.id)
    const tasks = (mission.tasks ?? []).map((task, taskIndex) => ({
      ...task,
      text: typeof task?.text === 'string' && task.text.length > 0 ? task.text : `property task ${taskIndex}`,
      status: task?.status === 'done' || task?.status === 'dropped' ? task.status : 'open',
    }))
    const blockers = status === 'blocked' && (mission.blockers ?? []).length === 0
      ? ['property-blocker']
      : Array.isArray(mission.blockers) ? mission.blockers : []
    return {
      ...mission,
      status,
      owner: workerName(id),
      deps: Array.isArray(mission.deps) ? mission.deps : [],
      tasks,
      blockers,
      notes: [],
      completionReport: null,
      pauseCause: status === 'paused' ? 'user' : null,
      worktree: {
        path: `/worktrees/${id}`,
        branch: `tower/${id}-PROPERTY`,
        baseCommit: syntheticTip(index),
        realPath: `/worktrees/${id}`,
        createdAt: NOW,
      },
      mergedAt: undefined,
      mergedCommit: undefined,
    }
  })
  base.roster = [
    ...base.roster.filter((entry) => typeof entry?.name === 'string' && !entry.name.startsWith('prop-worker-')),
    ...base.missions.map((mission) => ({
      name: workerName(mission.id),
      role: 'worker',
      state: 'running',
      missionId: mission.id,
      parentSessionId: `parent-${workerName(mission.id)}`,
      agentId: workerAgentId(mission.id),
    })),
  ]
  return base
}

/**
 * Render gate blocker records (`{ code, detail }`) as one readable line.
 * @param {any[]} blockers
 * @returns {string}
 */
function describeBlockers(blockers) {
  return blockers
    .map((blocker) => (typeof blocker === 'string' ? blocker : `${blocker.code}: ${blocker.detail}`))
    .join('; ')
}

/**
 * Why a `merge` command must be refused, or an empty list when the gate admits it.
 * Mirrors the app's merge route: completion evidence plus the merge gate.
 * @param {any} mission
 * @param {any} state
 * @returns {any[]}
 */
function mergeBlockers(mission, state) {
  const branch = mission.worktree?.branch ?? null
  return [
    ...completionBlockers(mission, MODEL_CONFIG),
    ...mergeGateBlockers({
      mission,
      roster: state.roster ?? [],
      branch,
      branchTip: mission.worktree?.baseCommit ?? null,
      review: latestReview(reviewsForBranch(state.reviews ?? [], branch ?? '')),
      config: MODEL_CONFIG,
      activity: {},
      parentStatus: null,
      inactiveStates: ROSTER_INACTIVE_STATES,
      rebaseWaived: false,
    }),
  ]
}

/** Apply one generated command; throws the same error the routed write would. */
function applyCommand(command, draft) {
  const mission = missionAt(draft, command.index)
  switch (command.kind) {
    case 'status': {
      const input = { status: command.target }
      if (command.target === 'abandoned') input.note = ABANDON_NOTE
      if (mission.status === 'paused' && command.target === 'active') input.authorization = AUTHORIZATION
      applyMissionUpdate({ mission, state: draft, input, config: MODEL_CONFIG })
      return
    }
    case 'complete': {
      const worker = assertCompletionRequest({
        mission,
        roster: draft.roster,
        input: { agentId: workerAgentId(mission.id), report: REPORT },
        maxReportBytes: MAX_REPORT_BYTES,
      })
      const report = completionReport({
        report: REPORT,
        worker,
        checks: [],
        now: NOW,
        maxReportBytes: MAX_REPORT_BYTES,
      })
      applyCompletion({ mission, report, now: NOW })
      return
    }
    case 'review': {
      const branch = mission.worktree.branch
      const tip = mission.worktree.baseCommit
      const verdict = normalizeReviewVerdict({
        status: command.status,
        merge: command.merge,
        findings: command.status === 'clean' ? 'none' : `p1: property finding on ${mission.id}`,
        decision: 'generated sequence review',
        checks: ['property'],
      })
      const admission = reviewAdmission({ mission, reviews: draft.reviews, branch, tip })
      const roundInfo = reviewRound({
        reviews: draft.reviews,
        branch,
        reviewerName: REVIEWER,
        maxRoundsPerReviewer: MODEL_CONFIG.review.maxRoundsPerReviewer,
        round: admission.round,
      })
      const outcome = reviewOutcome({
        status: verdict.status,
        merge: verdict.merge,
        round: roundInfo.round,
        reviewerName: REVIEWER,
        appended: admission.appended,
      })
      const seq = (Number.isInteger(draft.reviewSeq) ? draft.reviewSeq : 0) + 1
      draft.reviews.push(reviewRecord({
        seq,
        missionId: mission.id,
        branch,
        tip,
        verdict,
        reviewerName: REVIEWER,
        reviewerRole: 'reviewer',
        round: roundInfo.round,
        now: NOW,
      }))
      draft.reviewSeq = seq
      applyReviewOutcome({ mission, outcome, now: NOW })
      return
    }
    case 'merge': {
      const blockers = mergeBlockers(mission, draft)
      if (blockers.length > 0) {
        throw new TowerToolError(
          'invalid-transition',
          `merge gate refused ${mission.id}: ${describeBlockers(blockers)}`,
        )
      }
      applyMergeSuccess({
        mission,
        branchTip: mission.worktree.baseCommit,
        base: draft.base,
        newTip: MERGED_TIP,
        now: NOW,
      })
      return
    }
    case 'task_done': {
      const tasks = mission.tasks ?? []
      const task = tasks.length > 0 ? tasks[command.taskIndex % tasks.length] : null
      applyMissionUpdate({
        mission,
        state: draft,
        input: { task_done: task ? String(task.text) : 'no such task' },
        config: MODEL_CONFIG,
      })
      return
    }
    case 'blocker': {
      applyMissionUpdate({ mission, state: draft, input: { blocker: 'property blocker' }, config: MODEL_CONFIG })
      return
    }
    case 'clear_blockers': {
      applyMissionUpdate({ mission, state: draft, input: { clear_blockers: true }, config: MODEL_CONFIG })
      return
    }
    default:
      assert.fail(`unknown generated command kind ${String(command.kind)}`)
  }
}

/**
 * The state invariants of a legal Tower session. `label` locates the failing
 * command in the sequence.
 * @param {any} state
 * @param {string} label
 * @returns {void}
 */
function assertMissionInvariants(state, label) {
  assert.ok(
    Number.isInteger(state.revision) && state.revision >= 0,
    `${label}: revision must be a non-negative integer, got ${state.revision}`,
  )
  const seen = new Set()
  for (const mission of state.missions ?? []) {
    assert.ok(!seen.has(mission.id), `${label}: duplicate mission id ${mission.id}`)
    seen.add(mission.id)
    assert.ok(
      MODEL_STATUSES.includes(mission.status),
      `${label}: mission ${mission.id} has unknown status ${String(mission.status)}`,
    )
    const openTasks = (mission.tasks ?? []).filter((task) => task?.status === 'open')
    if (mission.status === 'completed' || mission.status === 'merged') {
      assert.equal(
        openTasks.length,
        0,
        `${label}: ${mission.status} mission ${mission.id} still has ${openTasks.length} open task(s)`,
      )
      assert.ok(
        mission.completionReport && typeof mission.completionReport.report === 'string',
        `${label}: ${mission.status} mission ${mission.id} has no completion report`,
      )
    }
    if (mission.status !== 'merged') continue
    assert.deepEqual(mission.blockers ?? [], [], `${label}: merged mission ${mission.id} still has blockers`)
    assert.equal(
      mission.mergedCommit,
      MERGED_TIP,
      `${label}: merged mission ${mission.id} did not record the merge commit`,
    )
    if (isReviewExempt(mission, MODEL_CONFIG)) {
      assert.equal(
        reviewExemptionInvalid(mission, MODEL_CONFIG),
        false,
        `${label}: merged mission ${mission.id} used an invalid review exemption`,
      )
      continue
    }
    assert.ok(mission.worktree?.branch, `${label}: merged mission ${mission.id} has no worktree branch`)
    const latest = latestReview(reviewsForBranch(state.reviews ?? [], mission.worktree.branch))
    assert.ok(latest, `${label}: merged mission ${mission.id} has no review on ${mission.worktree.branch}`)
    assert.equal(latest.missionId, mission.id, `${label}: merged mission ${mission.id} used another mission's review`)
    assert.equal(latest.status, 'clean', `${label}: merged mission ${mission.id} was not cleanly reviewed`)
    assert.equal(latest.mergeVerdict, 'merge', `${label}: merged mission ${mission.id} was not approved for merge`)
    assert.equal(
      latest.reviewedCommit,
      mission.worktree.baseCommit,
      `${label}: merged mission ${mission.id} was reviewed at a different tip`,
    )
  }
}

/**
 * Record terminal statuses and assert a mission never leaves the terminal set.
 * @param {any} state
 * @param {string} label
 * @param {Map<string, string>} terminalStatus
 * @returns {void}
 */
function assertTerminalAbsorption(state, label, terminalStatus) {
  for (const mission of state.missions ?? []) {
    if (!MODEL_STATUSES.includes(mission.status)) continue
    if (mission.status !== 'merged' && mission.status !== 'abandoned') continue
    const recorded = terminalStatus.get(mission.id)
    if (recorded !== undefined) {
      assert.equal(
        mission.status,
        recorded,
        `${label}: mission ${mission.id} left terminal status ${recorded} for ${mission.status}`,
      )
    }
    terminalStatus.set(mission.id, mission.status)
  }
}

/**
 * Run one generated command sequence against a normalized state, asserting
 * atomicity on refusals and the state invariants after every accepted write.
 * @param {any} generatedState
 * @param {any[]} commands
 * @returns {any} the final committed state
 */
function executeSequence(generatedState, commands) {
  let current = prepareSequenceState(generatedState)
  validateState(current, 'sequence base')
  const terminalStatus = new Map()
  assertMissionInvariants(current, 'sequence base')
  assertTerminalAbsorption(current, 'sequence base', terminalStatus)
  for (const [position, command] of commands.entries()) {
    const label = `command ${position} (${command.kind})`
    const draft = structuredClone(current)
    let error = null
    try {
      applyCommand(command, draft)
    } catch (caught) {
      error = caught
    }
    if (error !== null) {
      assert.ok(error instanceof TowerToolError, `${label}: refusal must be a TowerToolError, got ${error}`)
      assert.equal(draft.revision, current.revision, `${label}: a refused command bumped the revision`)
      assert.equal(
        JSON.stringify(draft),
        JSON.stringify(current),
        `${label}: a refused command mutated the committed state`,
      )
      continue
    }
    draft.revision = current.revision + 1
    draft.updatedAt = NOW
    validateState(draft, label)
    assertMissionInvariants(draft, label)
    assertTerminalAbsorption(draft, label, terminalStatus)
    current = draft
  }
  return current
}

const missionIndexArb = fc.integer({ min: 0, max: 4 })
const taskIndexArb = fc.integer({ min: 0, max: 3 })

const commandArb = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('status'),
      target: fc.constantFrom(...PATCH_TARGETS),
      index: missionIndexArb,
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('complete'), index: missionIndexArb }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('review'),
      status: reviewStatusArb,
      merge: mergeVerdictArb,
      index: missionIndexArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('task_done'), index: missionIndexArb, taskIndex: taskIndexArb }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('merge'), index: missionIndexArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('blocker'), index: missionIndexArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('clear_blockers'), index: missionIndexArb }) },
)

const sequenceArb = fc.record({
  state: stateWithMissionsArb,
  commands: fc.array(commandArb, { minLength: 1, maxLength: 12 }),
})

runProperty({
  name: 'no illegal path: generated command sequences never yield completed-with-open-tasks, an un-reviewed merge, duplicate ids, a negative revision, or an unknown status',
  arbitrary: sequenceArb,
  classify: ({ commands }) => `commands=${commands.length}`,
  predicate: ({ state, commands }) => {
    executeSequence(state, commands)
  },
})

// Frozen focused example: completion admission refuses a mission with any open
// task, a blocker, a different owner, or no worktree, and leaves it un-completed.
const completionMatrix = [
  {
    name: 'an open task',
    patch: { tasks: [{ text: 'still open', status: 'open' }] },
  },
  {
    name: 'a blocker',
    patch: { blockers: ['frozen blocker'] },
  },
  {
    name: 'a different owner',
    patch: { owner: 'someone-else' },
  },
  {
    name: 'no worktree',
    patch: { worktree: null },
  },
]

function frozenState({ status = 'completed', patch = {}, review = null } = {}) {
  const id = 'M1'
  const branch = `tower/${id}-PROPERTY`
  const tip = syntheticTip(0)
  const owner = workerName(id)
  const mission = {
    id,
    title: 'frozen pipeline mission',
    status,
    kind: 'build',
    scope: ['tests/property/**'],
    deps: [],
    tasks: [],
    blockers: [],
    notes: [],
    owner,
    reviewPolicy: 'required-clean',
    reviewExemptionReason: null,
    scopeGeneration: 0,
    ownerGeneration: 0,
    createdAt: NOW,
    updatedAt: NOW,
    pauseCause: null,
    worktree: {
      path: `/worktrees/${id}`,
      branch,
      baseCommit: tip,
      realPath: `/worktrees/${id}`,
      createdAt: NOW,
    },
    completionReport: status === 'completed' || status === 'merged'
      ? { report: REPORT, reportBytes: REPORT.length, by: owner, at: NOW, checks: [] }
      : null,
    ...patch,
  }
  return {
    schemaVersion: 3,
    revision: 11,
    base: 'main',
    repoRoot: '/repo',
    commonDir: '/repo/.git',
    createdAt: NOW,
    updatedAt: NOW,
    dirtyBase: false,
    caseInsensitive: false,
    towerAgentId: null,
    snapshotCommit: null,
    snapshotRef: null,
    missions: [mission],
    roster: [{
      name: owner,
      role: 'worker',
      state: 'running',
      missionId: id,
      parentSessionId: `parent-${owner}`,
      agentId: workerAgentId(id),
    }],
    reviews: review
      ? [{
        id: 'R1',
        seq: 1,
        missionId: id,
        branch,
        reviewedCommit: review.reviewedCommit ?? tip,
        status: review.status,
        mergeVerdict: review.mergeVerdict,
        findings: review.status === 'clean' ? 'none' : 'p1: frozen finding',
        checks: [],
        decision: 'frozen merge matrix',
        reviewer: REVIEWER,
        reviewerRole: 'reviewer',
        round: 1,
        at: NOW - 1_000,
      }]
      : [],
    findings: [],
    messages: [],
    batches: [],
    messageSeq: 0,
    reviewSeq: review ? 1 : 0,
    findingSeq: 0,
    batchSeq: 0,
    deliverySeq: 0,
    mergeIntent: null,
    rebaseIntent: null,
  }
}

/** Drive the completion admission pipeline; returns the refusal, or null on success. */
function attemptCompletion(state) {
  const draft = structuredClone(state)
  const mission = missionAt(draft, 0)
  try {
    const worker = assertCompletionRequest({
      mission,
      roster: draft.roster,
      input: { agentId: workerAgentId(mission.id), report: REPORT },
      maxReportBytes: MAX_REPORT_BYTES,
    })
    const report = completionReport({
      report: REPORT,
      worker,
      checks: [],
      now: NOW,
      maxReportBytes: MAX_REPORT_BYTES,
    })
    applyCompletion({ mission, report, now: NOW })
  } catch (caught) {
    return { draft, error: caught }
  }
  return { draft, error: null }
}

runProperty({
  name: 'completion pipeline: a mission with an open task, a blocker, another owner, or no worktree is refused and left un-completed',
  arbitrary: fc.constantFrom(
    ...completionMatrix.map((entry) => ({
      name: entry.name,
      state: frozenState({ status: 'active', patch: entry.patch }),
    })),
    { name: 'an admissible mission', state: frozenState({ status: 'active' }) },
  ),
  predicate: (entry) => {
    validateState(entry.state, `frozen completion matrix: ${entry.name}`)
    const { draft, error } = attemptCompletion(entry.state)
    const mission = draft.missions[0]
    if (entry.name === 'an admissible mission') {
      assert.equal(error, null, `${entry.name}: expected admission to succeed, got ${error}`)
      assert.equal(mission.status, 'completed', `${entry.name}: admission must record completed`)
      assert.ok(mission.completionReport, `${entry.name}: admission must record a completion report`)
      return
    }
    assert.ok(error instanceof TowerToolError, `${entry.name}: expected a refusal, got ${error}`)
    assert.notEqual(mission.status, 'completed', `${entry.name}: a refused completion must not write completed`)
    assert.deepEqual(
      JSON.parse(JSON.stringify(draft)),
      JSON.parse(JSON.stringify(entry.state)),
      `${entry.name}: a refused completion must be a no-op`,
    )
  },
})

// Frozen focused example: only a clean/merge verdict at the exact reviewed tip
// admits a merge. Each row names the gate blocker the app would report.
const mergeMatrix = [
  { name: 'no review', state: frozenState(), blocker: 'no-review' },
  {
    name: 'a non-clean review at the tip',
    state: frozenState({ review: { status: 'p2-3items', mergeVerdict: 'merge' } }),
    blocker: 'not-clean',
  },
  {
    name: 'a clean review at an old tip',
    state: frozenState({ review: { status: 'clean', mergeVerdict: 'merge', reviewedCommit: syntheticTip(1) } }),
    blocker: 'tip-moved',
  },
  {
    name: 'a clean review with a hold verdict',
    state: frozenState({ review: { status: 'clean', mergeVerdict: 'hold' } }),
    blocker: 'review-hold',
  },
  {
    name: 'a clean review with a fix-then-merge verdict',
    state: frozenState({ review: { status: 'clean', mergeVerdict: 'fix-then-merge' } }),
    blocker: 'review-not-approved',
  },
  {
    name: 'a mission that is not completed',
    state: frozenState({ status: 'active', review: { status: 'clean', mergeVerdict: 'merge' } }),
    blocker: 'mission-not-completed',
  },
  {
    name: 'a clean/merge review at the tip',
    state: frozenState({ review: { status: 'clean', mergeVerdict: 'merge' } }),
    blocker: null,
  },
]

/** Drive the merge route; returns the refusal, or null on success. */
function attemptMerge(state) {
  const draft = structuredClone(state)
  const mission = missionAt(draft, 0)
  try {
    const blockers = mergeBlockers(mission, draft)
    if (blockers.length > 0) {
      throw new TowerToolError(
        'invalid-transition',
        `merge gate refused ${mission.id}: ${describeBlockers(blockers)}`,
      )
    }
    applyMergeSuccess({
      mission,
      branchTip: mission.worktree.baseCommit,
      base: draft.base,
      newTip: MERGED_TIP,
      now: NOW,
    })
  } catch (caught) {
    return { draft, error: caught }
  }
  return { draft, error: null }
}

runProperty({
  name: 'merge pipeline: only a clean/merge review at the exact reviewed tip admits a merge',
  arbitrary: fc.constantFrom(...mergeMatrix),
  predicate: (entry) => {
    validateState(entry.state, `frozen merge matrix: ${entry.name}`)
    const { draft, error } = attemptMerge(entry.state)
    const mission = draft.missions[0]
    if (entry.blocker === null) {
      assert.equal(error, null, `${entry.name}: expected the gate to admit the merge, got ${error}`)
      assert.equal(mission.status, 'merged', `${entry.name}: an admitted merge must record merged`)
      assert.equal(mission.mergedCommit, MERGED_TIP, `${entry.name}: an admitted merge must record the tip`)
      assertMissionInvariants(draft, `frozen merge matrix: ${entry.name}`)
      return
    }
    assert.ok(error instanceof TowerToolError, `${entry.name}: expected a refusal, got ${error}`)
    assert.match(String(error.message), new RegExp(entry.blocker), `${entry.name}: expected ${entry.blocker}`)
    assert.notEqual(mission.status, 'merged', `${entry.name}: a refused merge must not record merged`)
    assert.deepEqual(
      JSON.parse(JSON.stringify(draft)),
      JSON.parse(JSON.stringify(entry.state)),
      `${entry.name}: a refused merge must be a no-op`,
    )
  },
})
