// Machine-checked type invariants (#45, #115).
//
// The published vocabulary in types/index.d.ts is generated from the runtime
// constants (`npm run types:generate`, gated by `docs:check:generated:types`),
// so this file no longer transcribes signatures: that diff is a generator now.
// What remains are the invariants generation cannot express, and that would be
// silently lost if a type were widened:
//
//   * the pure domain, the git adapter and the app use cases accept and return
//     the published shapes (not `any`-widened copies);
//   * the hand-written TowerState still overlaps the validator schema it
//     deliberately does not copy;
//   * the closed unions stay closed (live @ts-expect-error directives);
//   * the `tower` Cordis service is typed for consumers.
//
// It is never executed and lives in tests/ on purpose: adding a file to types/
// would change the published `npm pack` list.

import type { Static } from '@sinclair/typebox'

import type {
  Blocker,
  Finding,
  FindingSummary,
  MergeGateOptions,
  Mission,
  MissionDetail,
  MissionStatus,
  MissionSummary,
  MissionTask,
  Review,
  TaskCounts,
  TowerState,
} from '../types/index.js'

// Assert that the implementation type A is assignable to the contract type B.
type Expect<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

type DomainGate = typeof import('../domain/gate.js')
type DomainMission = typeof import('../domain/mission.js')
type DomainState = typeof import('../domain/state.js')
type DomainSummary = typeof import('../domain/summary.js')
type GitAdapter = typeof import('../adapters/git.js')

// --- published shapes flow through the pure domain -----------------------
export type GateMergeContract = Expect<Extends<DomainGate['mergeGateBlockers'], (options: MergeGateOptions) => Blocker[]>>
export type ValidateStateContract = Expect<
  Extends<DomainState['validateState'], (state: unknown, statePath?: string) => TowerState>
>
export type MissionSummaryContract = Expect<
  Extends<DomainSummary['missionSummary'], (mission: Mission) => MissionSummary>
>
export type FullMissionContract = Expect<Extends<DomainSummary['fullMission'], (mission: Mission) => MissionDetail>>
export type FindingSummaryContract = Expect<
  Extends<DomainSummary['findingSummary'], (finding: Finding) => FindingSummary>
>
export type TaskCountsContract = Expect<Extends<DomainSummary['taskCounts'], (tasks: MissionTask[]) => TaskCounts>>

// #115: the generated MissionStatus union is the element type of the runtime
// constant the generator reads. A widened/weakened JSDoc annotation fails here.
export type MissionVocabularyContract = Expect<Equal<DomainMission['MISSION_STATUSES'][number], MissionStatus>>

// --- the hand-written state contract still overlaps the schema ----------
type DomainStateSchema = typeof import('../domain/state/schema.js').StateSchema
type SchemaState = Static<DomainStateSchema>
type SchemaMission = SchemaState['missions'][number]

// A full `Equal<TowerState, Static<typeof StateSchema>>` is intentionally not
// asserted. The validator schema is structurally tolerant (additional legacy
// fields, optional revision, semantically checked vocabularies), while
// TowerState describes a normalized document. These two lines pin the overlap:
// the version literal refines the public number and every schema key has a
// public counterpart.
export type StateSchemaVersionContract = Expect<Equal<SchemaState['schemaVersion'], 3>>
export type StateSchemaRootKeysContract = Expect<Extends<keyof SchemaState, keyof TowerState>>
export type StateSchemaMissionKeysContract = Expect<Extends<keyof SchemaMission, keyof Mission>>

// --- adapter nullability is explicit, never `undefined` ------------------
export type GitTryContract = Expect<
  Extends<
    GitAdapter['tryGit'],
    (cwd: string, args: string[], options?: { timeoutMs?: number; maxBuffer?: number }) => Promise<string | null>
  >
>
export type GitResolveRepoContract = Expect<
  Extends<
    GitAdapter['resolveRepo'],
    (repoRoot: string) => Promise<{ root: string; commonDir: string; branch: string | null }>
  >
>

// --- the app use cases keep their async boundary -------------------------
type PromiseFunction = (...args: never[]) => Promise<unknown>
type UseCaseGate = typeof import('../app/gate.js')
type UseCaseRead = typeof import('../app/read.js')
type UseCaseReview = typeof import('../app/review.js')
type UseCaseRoster = typeof import('../app/roster.js')

export type GateUseCaseContract = Expect<Extends<UseCaseGate['evaluateGate'], PromiseFunction>>
export type ReadUseCaseContract = Expect<
  Extends<[UseCaseRead['missionDetail'], UseCaseRead['status'], UseCaseRead['diff']], [PromiseFunction, PromiseFunction, PromiseFunction]>
>
export type ReviewUseCaseContract = Expect<Extends<UseCaseReview['submitReview'], PromiseFunction>>
export type RosterUseCaseContract = Expect<
  Extends<
    [UseCaseRoster['recordRosterObservations'], UseCaseRoster['sweepRoster'], UseCaseRoster['unreadFor']],
    [PromiseFunction, PromiseFunction, PromiseFunction]
  >
>

// ===========================================================================
// Negative checks: these directives must stay live, otherwise tsc fails with
// "Unused '@ts-expect-error' directive". They pin the closed unions the
// generator emits from the live tables.
// ===========================================================================

// @ts-expect-error reviewPolicy is 'required-clean' | 'none'
const _invalidReviewPolicy: import('../types/index.js').ReviewPolicy = 'required'

// @ts-expect-error Mission.status is required
const _invalidMission: Mission = { id: 'M1', title: 'typo', kind: 'build', scope: [], deps: [] }

// @ts-expect-error MissionTask.status is a closed union
const _invalidTask: MissionTask = { text: 'x', status: 'closed' }

// @ts-expect-error FindingType is a closed union
const _invalidFinding: Finding = { id: 'F1', title: 'x', type: 'feature' }

// @ts-expect-error MergeVerdict is the three runtime verdicts
const _invalidVerdict: Review = { missionId: 'M1', branch: 'main', round: 1, status: 'clean', mergeVerdict: 'approve', reviewedCommit: 'abc', at: 0 }

// #50: the `tower` Cordis service is typed for consumers.
declare const towerCtx: import('@deepseek-ai/cordis').Context
const towerService = towerCtx.tower
if (towerService) {
  const hasSession: boolean = towerService.has('session')
  const entries: IterableIterator<[string, unknown]> = towerService.entries()
  void hasSession
  void entries
}
