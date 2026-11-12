// Artifact acceptance properties (#159).
//
// WHAT THIS FILE CHECKS
// ---------------------
// The artifact shape's merge gate is a human acceptance record bound to one
// committed tip. Two invariants from the issue are checked as properties:
//
//   * an artifact mission can never reach `merged` while
//     `acceptance.tip !== head`: the pure merge gate must report
//     `acceptance-stale` (a moved tip) or `acceptance-missing` (no record) for
//     every generated acceptance/head pair, under every review mode — the
//     "adding a commit after acceptance always produces acceptance-stale on
//     the next preflight" invariant is the tip-moved case of the same property;
//   * a build (or survey) mission can never carry an acceptance record: the
//     state validator rejects the document, and an artifact acceptance that
//     claims any author other than the human is rejected just as firmly.
//
// All properties are pure: they run the domain gate and validator over
// generated snapshots, never a repository.
import fc from 'fast-check'
import assert from 'node:assert/strict'

import { mergeGateBlockers } from '../../domain/gate.js'
import { validateState } from '../../domain/state.js'
import { SCHEMA_VERSION } from '../../domain/mission.js'
import { runProperty } from './helpers/harness.mjs'

const hexCharArb = fc.constantFrom(...'0123456789abcdef'.split(''))
const shaArb = fc.array(hexCharArb, { minLength: 40, maxLength: 40 }).map((chars) => chars.join(''))
const modeArb = fc.constantFrom('off', 'optional', 'required')

/** A generated completed artifact mission carrying an optional acceptance. */
const artifactMissionArb = fc.record({
  acceptedTip: shaArb,
  branchTip: shaArb,
  mode: modeArb,
  hasAcceptance: fc.boolean(),
  reviewEvidence: fc.option(
    fc.record({
      status: fc.constantFrom('clean', 'p1-2items', 'p2-1items'),
      mergeVerdict: fc.constantFrom('merge', 'fix-then-merge', 'hold'),
      reviewedCommit: shaArb,
    }),
    { nil: null },
  ),
})

runProperty({
  name: 'artifact gate: a tip-bound acceptance is the only way through, whatever the review mode',
  arbitrary: artifactMissionArb,
  classify: ({ hasAcceptance, acceptedTip, branchTip, mode }) =>
    hasAcceptance
      ? acceptedTip === branchTip
        ? `accepted=current-tip (mode ${mode})`
        : `accepted=moved-tip (mode ${mode})`
      : `no-acceptance (mode ${mode})`,
  predicate: ({ acceptedTip, branchTip, mode, hasAcceptance, reviewEvidence }) => {
    const mission = {
      id: 'M1',
      kind: 'artifact',
      title: 'property artifact mission',
      status: 'completed',
      scope: ['reports/**'],
      artifacts: ['reports/r.html'],
      deps: [],
      tasks: [{ text: 'render', status: 'done' }],
      blockers: [],
      notes: [],
      reviewPolicy: 'required-clean',
      reviewExemptionReason: null,
      testRuns: [],
      worktree: { path: '/wt', branch: 'tower/m1', baseCommit: 'b'.repeat(40) },
      ...(hasAcceptance
        ? { acceptance: { at: 1, by: 'human', tip: acceptedTip, artifacts: ['reports/r.html'] } }
        : {}),
    }
    const review = reviewEvidence
      ? {
          id: 'R1',
          seq: 1,
          missionId: 'M1',
          branch: 'tower/m1',
          round: 1,
          status: reviewEvidence.status,
          mergeVerdict: reviewEvidence.mergeVerdict,
          reviewedCommit: reviewEvidence.reviewedCommit,
          at: 0,
          reviewer: 'prop-reviewer',
          reviewerRole: 'reviewer',
        }
      : null
    const blockers = mergeGateBlockers({
      mission,
      roster: [],
      branch: 'tower/m1',
      branchTip,
      review,
      config: { review: { mode }, gates: { requireChecks: false, requireTests: false } },
      activity: {},
      parentStatus: null,
      inactiveStates: [],
    })
    const codes = blockers.map((blocker) => blocker.code)
    // The review contract never applies: no generated review evidence can
    // produce a review blocker for an artifact mission.
    for (const code of ['no-review', 'not-clean', 'review-hold', 'review-not-approved', 'tip-moved', 'review-mission-mismatch']) {
      assert.equal(codes.includes(code), false, `${code} must never appear for an artifact mission (mode ${mode})`)
    }
    if (!hasAcceptance) {
      assert.ok(codes.includes('acceptance-missing'), `a missing acceptance blocks (mode ${mode}): ${codes.join(',')}`)
      return
    }
    if (acceptedTip !== branchTip) {
      // The invariant: new commits (or a rebase) after the acceptance always
      // produce acceptance-stale on the next preflight, so the mission can
      // never reach merged with acceptance.tip !== head.
      assert.ok(codes.includes('acceptance-stale'), `a moved tip blocks (mode ${mode}): ${codes.join(',')}`)
      const stale = blockers.find((blocker) => blocker.code === 'acceptance-stale')
      assert.match(stale.detail, /accepted [0-9a-f]{7} but tip is [0-9a-f]{7}/)
      return
    }
    // The acceptance names the current tip: no acceptance blocker remains.
    assert.equal(
      codes.includes('acceptance-missing') || codes.includes('acceptance-stale'),
      false,
      `a current-tip acceptance clears the acceptance gate (mode ${mode}): ${codes.join(',')}`,
    )
  },
  examples: [
    // The literal invariant from the issue: accept, then the branch moves.
    [{ acceptedTip: 'a'.repeat(40), branchTip: 'b'.repeat(40), mode: 'required', hasAcceptance: true, reviewEvidence: null }],
    [{ acceptedTip: 'a'.repeat(40), branchTip: 'b'.repeat(40), mode: 'optional', hasAcceptance: true, reviewEvidence: null }],
    [{ acceptedTip: 'a'.repeat(40), branchTip: 'b'.repeat(40), mode: 'off', hasAcceptance: true, reviewEvidence: null }],
  ],
})

/** One minimal valid mission per non-artifact kind, for the document property. */
function missionOfKind(kind) {
  if (kind === 'survey') {
    return {
      id: 'M1',
      title: 'survey document',
      kind,
      status: 'active',
      scope: [],
      readCommit: 'c'.repeat(40),
      readDirty: [],
      deps: [],
      tasks: [],
      blockers: [],
      notes: [],
    }
  }
  return {
    id: 'M1',
    title: 'build document',
    kind,
    status: 'active',
    scope: ['src/**'],
    deps: [],
    tasks: [],
    blockers: [],
    notes: [],
  }
}

runProperty({
  name: 'acceptance document dimension: only an artifact carries one, and only a human wrote it',
  arbitrary: fc.record({
    kind: fc.constantFrom('build', 'survey', 'artifact'),
    by: fc.constantFrom('human', 'agent', 'reviewer', 'tower', ''),
    tip: shaArb,
    note: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
  }),
  predicate: ({ kind, by, tip, note }) => {
    const base = {
      schemaVersion: SCHEMA_VERSION,
      revision: 1,
      base: 'main',
      missions: [kind === 'artifact' ? { ...missionOfKind(kind), artifacts: ['reports/r.html'] } : missionOfKind(kind)],
    }
    const acceptance = { at: 1, by, tip, artifacts: kind === 'artifact' ? ['reports/r.html'] : [], ...(note !== undefined ? { note } : {}) }
    if (kind !== 'artifact') {
      assert.throws(
        () => validateState({ ...base, missions: [{ ...base.missions[0], acceptance }] }, ''),
        (error) => error.code === 'state-corrupt' && /may not carry an acceptance record/.test(error.message),
        `a ${kind} mission may not carry an acceptance record`,
      )
      assert.throws(
        () => validateState({ ...base, missions: [{ ...base.missions[0], artifacts: ['x'] }] }, ''),
        (error) => error.code === 'state-corrupt' && /may not declare artifacts/.test(error.message),
        `a ${kind} mission may not declare artifacts`,
      )
      return
    }
    if (by === 'human') {
      validateState({ ...base, missions: [{ ...base.missions[0], acceptance }] }, '')
      return
    }
    assert.throws(
      () => validateState({ ...base, missions: [{ ...base.missions[0], acceptance }] }, ''),
      (error) => error.code === 'state-corrupt' && /invalid acceptance record/.test(error.message),
      `an artifact acceptance must be by:"human" (got ${JSON.stringify(by)})`,
    )
  },
  examples: [
    [{ kind: 'build', by: 'human', tip: 'a'.repeat(40), note: undefined }],
    [{ kind: 'survey', by: 'human', tip: 'a'.repeat(40), note: undefined }],
    [{ kind: 'artifact', by: 'agent', tip: 'a'.repeat(40), note: undefined }],
    [{ kind: 'artifact', by: 'human', tip: 'a'.repeat(40), note: 'approved' }],
  ],
})
