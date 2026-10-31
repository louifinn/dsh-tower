// Arbitraries for one mission row, as stored in `state.missions` and as
// accepted by `domain/missions/plan.js` (newMission output shape).
//
// Values are schema-shaped, not runtime state: they never name a real
// repository, worktree or branch that exists on disk.
import fc from 'fast-check'

import { commitShaArb, branchNameArb } from './commitSha.mjs'
import { scopeArb, worktreePathArb } from './path.mjs'
import {
  missionKindArb,
  missionStatusArb,
  pauseCauseArb,
  reviewPolicyArb,
  taskStatusArb,
} from './status.mjs'

/** Mission ids are the tower's `M<n>` sequence. */
export const missionIdArb = fc.integer({ min: 1, max: 999 }).map((value) => `M${value}`)

/** Roster labels are printable and kebab-ish: `<role>-<missionId>`. */
export const rosterNameArb = fc
  .tuple(fc.constantFrom('tower', 'worker', 'reviewer', 'tower-worker'), fc.integer({ min: 1, max: 999 }))
  .map(([role, id]) => `${role}-m${id}`)

/** A printable, NFC-stable mission title (the domain caps it at 120 code points). */
export const missionTitleArb = fc.oneof(
  { weight: 4, arbitrary: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,:_()/'+-]{0,60}$/) },
  { weight: 1, arbitrary: fc.constantFrom('数据迁移', 'Tower · 属性测试', 'paths: a/b ** c') },
)

const timestampArb = fc.integer({ min: 0, max: 2_000_000_000_000 })

/** `{text, status, note?}` — the task checklist row. */
const missionTaskArb = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,:_()/'+-]{0,60}$/),
    taskStatusArb,
    fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
  )
  .map(([text, status, note]) => (note === undefined ? { text, status } : { text, status, note }))

/** The worktree record a planned/active mission carries. */
const missionWorktreeArb = fc.record({
  path: worktreePathArb,
  branch: branchNameArb,
  baseCommit: commitShaArb,
  realPath: worktreePathArb,
  createdAt: timestampArb,
})

/** A completion report, optional on completed missions. */
const completionReportArb = fc.record({
  report: fc.string({ maxLength: 200 }),
  reportBytes: fc.integer({ min: 0, max: 100_000 }),
  by: rosterNameArb,
  at: timestampArb,
  checks: fc.array(
    fc.record({
      name: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
      command: fc.string({ maxLength: 40 }),
      exitCode: fc.constantFrom(0, 1, 2),
    }),
    { maxLength: 2 },
  ),
})

const missionBaseArb = fc.record({
  id: missionIdArb,
  title: missionTitleArb,
  status: missionStatusArb,
  kind: missionKindArb,
  scope: scopeArb,
  deps: fc.array(missionIdArb, { maxLength: 3 }),
  tasks: fc.array(missionTaskArb, { maxLength: 4 }),
  blockers: fc.array(fc.string({ maxLength: 60 }), { maxLength: 2 }),
  notes: fc.array(fc.string({ maxLength: 80 }), { maxLength: 2 }),
  owner: fc.option(rosterNameArb, { nil: null }),
  references: fc.array(fc.string({ maxLength: 60 }), { maxLength: 3 }),
  scopeGeneration: fc.integer({ min: 1, max: 100 }),
  ownerGeneration: fc.integer({ min: 0, max: 100 }),
  createdAt: timestampArb,
  updatedAt: timestampArb,
  worktree: fc.option(missionWorktreeArb, { nil: null }),
  pauseCause: fc.option(pauseCauseArb, { nil: null }),
  completionReport: fc.option(completionReportArb, { nil: null }),
})

/**
 * `reviewPolicy` and `reviewExemptionReason` are generated together: `none`
 * always carries a non-empty reason, which is the invariant
 * `assertStateSemantics` enforces.
 */
const reviewFieldsArb = fc
  .tuple(reviewPolicyArb, fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,:_'-]{0,60}$/))
  .map(([policy, reason]) =>
    policy === 'none'
      ? { reviewPolicy: 'none', reviewExemptionReason: reason }
      : { reviewPolicy: 'required-clean' },
  )

/** One mission document. The id is *not* guaranteed unique across missions. */
export const missionArb = fc
  .tuple(missionBaseArb, reviewFieldsArb)
  .map(([mission, reviewFields]) => ({ ...mission, ...reviewFields }))
