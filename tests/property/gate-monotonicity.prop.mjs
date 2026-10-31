// Property 9 (#130): the merge gate is monotone under worsening evidence.
//
// WHAT THIS FILE CHECKS
// ---------------------
// `domain/gate.js` composes two pure gates from snapshots:
//
//   * `completionBlockers(mission, config)` — status, open tasks, blockers and
//     completion-check evidence;
//   * `mergeGateBlockers({mission, roster, branch, branchTip, review, config,
//     activity, parentStatus, inactiveStates, rebaseWaived})` — review verdicts,
//     the reviewed tip, roster activity and test receipts.
//
// The issue's literal wording ("making the worker inactive never removes an
// existing blocker") is **false by design**, and this file does not pretend
// otherwise: a roster row that becomes `inactive`/`missing`/`retired` is
// evidence that the worker stopped, so `worker-busy` *must* disappear — that is
// the whole point of the roster state. The same is true of a clean review
// resolving `no-review`/`not-clean` and a test receipt resolving `tests-missing`.
// The direction the gates actually guarantee is one-way:
//
//   once an obstacle exists, only improving its witness removes it;
//   worsening a witness never removes a blocker, and never unblocks the gate.
//
// Each property below therefore starts from generated evidence, applies one
// *worsening* transform and asserts the blocker multiset only grows:
//
//   * completion gate: add a blocker, add an open task, require check evidence
//     with no completion report, mark a completed mission active again;
//   * merge gate: add an unknown-status worker, mark an eligible row stale,
//     put a worker back into `running`, require tests with no receipt at the
//     (moved) tip, worsen the review status, hold the verdict, withdraw the
//     merge verdict, and move the tip away from the reviewed commit.
//
// Two complementary properties pin the other half of "metamorphic": changing a
// field the gate does not read (review findings, mission title/notes/scope/…)
// leaves every blocker code unchanged, and the deliberate `running → inactive`
// exception is frozen as a documented example rather than asserted as a
// monotone direction.
//
// `mergeGateBlockers` has no file-level input, so "adding an out-of-scope file"
// is an app/preflight concern, not a pure gate witness; its pure analogue is the
// unrelated-change stability property.
//
// No shrunk counterexample has been observed for these properties across the
// three PR seeds (131, 40961, 978217) or the 2000-run long tier.
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { completionBlockers, mergeGateBlockers } from '../../domain/gate.js'
import { isTerminal } from '../../domain/mission.js'
import { ROSTER_INACTIVE_STATES } from '../../domain/roster.js'
import {
  OTHER_TIP,
  cleanMergeEvidenceArb,
  completionEvidenceArb,
  mergeEvidenceArb,
} from './arbitraries/index.mjs'
import { runProperty } from './helpers/harness.mjs'

/** @param {any[]} blockers */
function codes(blockers) {
  return blockers.map((blocker) => blocker.code)
}

/** @param {string[]} values @returns {Map<string, number>} */
function countCodes(values) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

/** @param {any} evidence */
function mergeCodes(evidence) {
  return codes(mergeGateBlockers({ ...evidence }))
}

/** @param {any} evidence */
function completionCodes(evidence) {
  return codes(completionBlockers(evidence.mission, evidence.config))
}

/**
 * The core metamorphic assertion: the after multiset contains the before
 * multiset, and a blocked gate never becomes unblocked.
 * @param {string[]} before
 * @param {string[]} after
 * @param {string} label
 */
function assertMonotone(before, after, label) {
  const beforeCounts = countCodes(before)
  const afterCounts = countCodes(after)
  for (const [code, count] of beforeCounts) {
    assert.ok(
      (afterCounts.get(code) ?? 0) >= count,
      `${label}: worsening removed ${code} (${before.join(', ')} -> ${after.join(', ')})`,
    )
  }
  if (before.length > 0) {
    assert.ok(after.length > 0, `${label}: worsening turned a blocked gate unblocked (${before.join(', ')} -> [])`)
  }
}

// ---------------------------------------------------------------------------
// Completion gate: adding obstacles never clears an existing one.
// ---------------------------------------------------------------------------

runProperty({
  name: 'completion monotone: appending a mission blocker only adds blockers-present',
  arbitrary: completionEvidenceArb,
  predicate: ({ mission, config }) => {
    const before = completionCodes({ mission, config })
    const after = completionCodes({
      mission: { ...mission, blockers: [...(mission.blockers ?? []), 'late blocker'] },
      config,
    })
    assertMonotone(before, after, `mission ${mission.id} blocker`)
    // A generated mission may already carry blockers, in which case the count
    // stays at one: the appended blocker is an additional witness, not an
    // additional code. Presence is the guaranteed effect.
    assert.ok(after.includes('blockers-present'), 'a mission with a blocker must report blockers-present')
  },
})

runProperty({
  name: 'completion monotone: appending an open task only adds tasks-open',
  arbitrary: completionEvidenceArb,
  predicate: ({ mission, config }) => {
    const before = completionCodes({ mission, config })
    const after = completionCodes({
      mission: { ...mission, tasks: [...(mission.tasks ?? []), { text: 'late open task', status: 'open' }] },
      config,
    })
    assertMonotone(before, after, `mission ${mission.id} task`)
    assert.equal(countCodes(after).get('tasks-open'), 1, 'one open task list must report tasks-open exactly once')
  },
})

runProperty({
  name: 'completion monotone: requiring check evidence with no completion report only adds no-check-evidence',
  arbitrary: completionEvidenceArb,
  predicate: ({ mission, config }) => {
    const before = completionCodes({ mission, config })
    const after = completionCodes({
      mission: { ...mission, completionReport: null },
      config: { ...config, gates: { ...(config.gates ?? {}), requireChecks: true } },
    })
    assertMonotone(before, after, `mission ${mission.id} check evidence`)
    assert.equal(countCodes(after).get('no-check-evidence'), 1, 'missing check evidence must report exactly once')
  },
})

runProperty({
  name: 'completion monotone: a completed mission moved back to active only adds mission-not-completed',
  arbitrary: completionEvidenceArb.filter(({ mission }) => !isTerminal(mission.status)),
  predicate: ({ mission, config }) => {
    const before = completionCodes({ mission, config })
    const after = completionCodes({
      mission: { ...mission, status: mission.status === 'completed' ? 'active' : mission.status },
      config,
    })
    assertMonotone(before, after, `mission ${mission.id} status`)
    const expected = mission.status === 'completed' ? 1 : 0
    assert.equal(
      countCodes(after).get('mission-not-completed'),
      1,
      `an open mission must report mission-not-completed${expected === 1 ? ' after leaving completed' : ''}`,
    )
  },
})

// ---------------------------------------------------------------------------
// Merge gate: roster, test and review witnesses.
// ---------------------------------------------------------------------------

runProperty({
  name: 'merge monotone: adding a worker whose parent status is unknown only adds worker-status-unknown',
  arbitrary: mergeEvidenceArb,
  predicate: (evidence) => {
    const before = mergeCodes(evidence)
    const lateRow = {
      name: 'late-worker-unknown',
      role: 'worker',
      state: 'unknown',
      missionId: evidence.mission.id,
      agentId: 'agent-late-worker-unknown',
      parentSessionId: 'session-late-worker-unknown',
    }
    const after = mergeCodes({
      ...evidence,
      roster: [...evidence.roster, lateRow],
      // The app passes the parent catalog snapshot; an entry missing from it is
      // exactly what `worker-status-unknown` records.
      parentStatus: { ...(evidence.parentStatus ?? {}) },
    })
    assertMonotone(before, after, `mission ${evidence.mission.id} late worker`)
    assert.ok(after.includes('worker-status-unknown'), 'the added worker must contribute worker-status-unknown')
  },
})

runProperty({
  name: 'merge monotone: marking a worker stale only adds worker-stale',
  arbitrary: mergeEvidenceArb,
  predicate: (evidence) => {
    const before = mergeCodes(evidence)
    const lateRow = {
      name: 'late-worker-stale',
      role: 'worker',
      state: 'unknown',
      missionId: evidence.mission.id,
      agentId: 'agent-late-worker-stale',
      parentSessionId: 'session-late-worker-stale',
      stale: true,
    }
    const after = mergeCodes({ ...evidence, roster: [...evidence.roster, lateRow] })
    assertMonotone(before, after, `mission ${evidence.mission.id} stale worker`)
    assert.equal(countCodes(after).get('worker-stale'), 1, 'stale workers report one worker-stale blocker')
  },
})

runProperty({
  name: 'merge monotone: putting a worker back into running only adds worker-busy',
  arbitrary: mergeEvidenceArb,
  predicate: (evidence) => {
    const before = mergeCodes(evidence)
    const lateRow = {
      name: 'late-worker-busy',
      role: 'worker',
      state: 'running',
      missionId: evidence.mission.id,
      agentId: 'agent-late-worker-busy',
      parentSessionId: 'session-late-worker-busy',
    }
    const after = mergeCodes({
      ...evidence,
      roster: [...evidence.roster, lateRow],
      activity: { ...evidence.activity, [lateRow.agentId]: 'running' },
    })
    assertMonotone(before, after, `mission ${evidence.mission.id} busy worker`)
    assert.equal(
      (countCodes(after).get('worker-busy') ?? 0),
      (countCodes(before).get('worker-busy') ?? 0) + 1,
      'the added running worker must contribute exactly one worker-busy blocker',
    )
  },
})

runProperty({
  name: 'merge monotone: requiring tests with no receipt at a moved tip keeps tests-missing',
  arbitrary: mergeEvidenceArb,
  predicate: (evidence) => {
    const before = mergeCodes(evidence)
    // Pick a tip that is neither the current tip nor the reviewed commit, so the
    // move is real and cannot accidentally satisfy tip-moved.
    const taken = new Set([evidence.branchTip, evidence.review?.reviewedCommit])
    const newTip = [OTHER_TIP, 'e'.repeat(40), 'd'.repeat(40)].find((candidate) => !taken.has(candidate))
    assert.ok(newTip, 'the frozen tip candidates must not all collide with the evidence')
    const after = mergeCodes({
      ...evidence,
      branchTip: newTip,
      mission: { ...evidence.mission, testRuns: [] },
      config: { ...evidence.config, gates: { ...(evidence.config.gates ?? {}), requireTests: true } },
    })
    assertMonotone(before, after, `mission ${evidence.mission.id} test evidence`)
    assert.ok(after.includes('tests-missing'), 'requireTests with no passing receipt must report tests-missing')
  },
})

// ---------------------------------------------------------------------------
// Focused merge gate: worsen one review witness on a snapshot that starts clean.
// ---------------------------------------------------------------------------

runProperty({
  name: 'merge monotone: a clean review worsened to a p1 status only adds not-clean',
  arbitrary: cleanMergeEvidenceArb,
  predicate: (evidence) => {
    const before = mergeCodes(evidence)
    const after = mergeCodes({
      ...evidence,
      review: { ...evidence.review, status: 'p1-2items', findings: ['p1: late finding'] },
    })
    assertMonotone(before, after, 'worsened review status')
    assert.equal(countCodes(after).get('not-clean'), 1, 'a non-clean review must report not-clean exactly once')
  },
})

runProperty({
  name: 'merge monotone: a clean review switched to the hold verdict only adds review-hold',
  arbitrary: cleanMergeEvidenceArb,
  predicate: (evidence) => {
    const before = mergeCodes(evidence)
    const after = mergeCodes({ ...evidence, review: { ...evidence.review, mergeVerdict: 'hold' } })
    assertMonotone(before, after, 'hold verdict')
    assert.equal(countCodes(after).get('review-hold'), 1, 'a hold verdict must report review-hold exactly once')
  },
})

runProperty({
  name: 'merge monotone: a clean review switched to fix-then-merge only adds review-not-approved',
  arbitrary: cleanMergeEvidenceArb,
  predicate: (evidence) => {
    const before = mergeCodes(evidence)
    const after = mergeCodes({ ...evidence, review: { ...evidence.review, mergeVerdict: 'fix-then-merge' } })
    assertMonotone(before, after, 'fix-then-merge verdict')
    assert.equal(
      countCodes(after).get('review-not-approved'),
      1,
      'a clean non-merge verdict must report review-not-approved exactly once',
    )
  },
})

runProperty({
  name: 'merge monotone: moving the branch tip away from the reviewed commit only adds tip-moved',
  arbitrary: cleanMergeEvidenceArb,
  predicate: (evidence) => {
    const before = mergeCodes(evidence)
    assert.notEqual(evidence.branchTip, OTHER_TIP, 'the clean-evidence arbitrary must reserve OTHER_TIP for the move')
    const after = mergeCodes({ ...evidence, branchTip: OTHER_TIP })
    assertMonotone(before, after, 'moved tip')
    assert.equal(countCodes(after).get('tip-moved'), 1, 'a moved tip must report tip-moved exactly once')
  },
})

// ---------------------------------------------------------------------------
// Unrelated changes leave both gates unchanged.
// ---------------------------------------------------------------------------

runProperty({
  name: 'merge stability: review prose and mission fields the gate does not read leave every blocker unchanged',
  arbitrary: mergeEvidenceArb,
  predicate: (evidence) => {
    const before = mergeCodes(evidence)
    const after = mergeCodes({
      ...evidence,
      mission: {
        ...evidence.mission,
        title: 'renamed by an unrelated change',
        notes: [...(evidence.mission.notes ?? []), 'unrelated note'],
        owner: 'someone-else',
        scope: ['somewhere/else/**'],
        deps: [],
        references: ['unrelated reference'],
        pauseCause: 'user',
        ownerGeneration: 99,
        scopeGeneration: 99,
      },
      review: evidence.review
        ? {
            ...evidence.review,
            findings: [...(evidence.review.findings ?? []), 'unrelated finding'],
            checks: [...(evidence.review.checks ?? []), 'unrelated check'],
            decision: 'unrelated rewritten decision',
            reviewer: 'someone-else',
            reviewerRole: 'tower',
            at: evidence.review.at + 1,
          }
        : null,
    })
    assert.deepEqual(after, before, 'an unrelated evidence change must not move the merge gate')
  },
})

runProperty({
  name: 'completion stability: mission metadata the gate does not read leaves every blocker unchanged',
  arbitrary: completionEvidenceArb,
  predicate: ({ mission, config }) => {
    const before = completionCodes({ mission, config })
    const after = completionCodes({
      mission: {
        ...mission,
        title: 'renamed by an unrelated change',
        notes: [...(mission.notes ?? []), 'unrelated note'],
        owner: 'someone-else',
        scope: ['somewhere/else/**'],
        deps: [],
        references: ['unrelated reference'],
        pauseCause: 'user',
        ownerGeneration: 99,
        scopeGeneration: 99,
        updatedAt: mission.updatedAt + 1,
      },
      config,
    })
    assert.deepEqual(after, before, 'an unrelated mission change must not move the completion gate')
  },
})

// ---------------------------------------------------------------------------
// Frozen documented exception: the issue's literal "inactive never removes"
// claim is false by design. Going inactive is the evidence that clears
// worker-busy; a gate that kept the blocker would ignore the roster state that
// exists to report the worker stopped.
// ---------------------------------------------------------------------------

runProperty({
  name: 'merge gate, documented exception: running -> inactive removes worker-busy (the roster state is the evidence)',
  arbitrary: fc.constant(null),
  predicate: () => {
    const missionId = 'M1'
    const agentId = 'agent-worker-m1'
    /** @type {Record<string, any>} */
    const evidence = {
      mission: {
        id: missionId,
        title: 'frozen monotonicity mission',
        status: 'active',
        kind: 'build',
        scope: ['tests/property/**'],
        deps: [],
        tasks: [],
        blockers: [],
        notes: [],
        owner: 'worker-m1',
        reviewPolicy: 'required-clean',
        reviewExemptionReason: null,
        testRuns: [],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
      roster: [
        {
          name: 'worker-m1',
          role: 'worker',
          state: 'running',
          missionId,
          agentId,
          parentSessionId: 'session-worker-m1',
        },
      ],
      branch: 'tower/m1-frozen',
      branchTip: 'a'.repeat(40),
      review: {
        id: 'R1',
        seq: 1,
        missionId,
        branch: 'tower/m1-frozen',
        reviewedCommit: 'a'.repeat(40),
        status: 'clean',
        mergeVerdict: 'merge',
        findings: ['none'],
        checks: [],
        decision: 'frozen monotonicity review',
        reviewer: 'prop-reviewer',
        reviewerRole: 'reviewer',
        round: 1,
        at: 1_699_999_999_000,
      },
      config: {
        review: { requireReview: true },
        gates: { requireChecks: false, requireTests: false, allowReviewExemption: false },
      },
      activity: { [agentId]: 'running' },
      parentStatus: null,
      inactiveStates: [...ROSTER_INACTIVE_STATES],
      rebaseWaived: false,
    }
    const before = mergeCodes(evidence)
    assert.ok(before.includes('worker-busy'), 'the running worker must start out blocking the merge')
    const after = mergeCodes({
      ...evidence,
      // The activity map still says "running": the roster state is what the gate
      // trusts once a worker has been recorded as stopped.
      roster: [{ ...evidence.roster[0], state: 'inactive' }],
    })
    assert.deepEqual(after, [], 'an inactive worker must clear worker-busy and leave no other blocker')
  },
})
