// Machine-checked type contracts (#45).
//
// This file is never executed: it exists so `tsc --noEmit` (also run by
// tests/packaging.test.mjs) proves that the published vocabulary in
// types/index.d.ts still describes the implementation:
//
//   * every pure module under lib/domain/ (now inside the checkJs program)
//     keeps the exported signature the contract promises;
//   * the git adapter under lib/git.js keeps its explicit nullability, and the
//     tower use-case modules under lib/tower/ still export the expected async
//     use cases.
//
// It lives in tests/ instead of types/ on purpose: adding a file to types/
// changes the published `npm pack` file list, which scripts/pack-manifest.txt
// would have to be reviewed for. This fixture stays dev-only.

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
  RosterEntry,
  TaskCounts,
  TowerConfig,
  TowerState,
  Review,
} from '../types/index.js'

// Assert that the implementation type A is assignable to the contract type B.
type Expect<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

type DomainGate = typeof import('../lib/domain/gate.js')
type DomainMission = typeof import('../lib/domain/mission.js')
type DomainPlanning = typeof import('../lib/domain/planning.js')
type DomainReport = typeof import('../lib/domain/report.js')
type DomainRoster = typeof import('../lib/domain/roster.js')
type DomainScope = typeof import('../lib/domain/scope.js')
type DomainState = typeof import('../lib/domain/state.js')
type DomainSummary = typeof import('../lib/domain/summary.js')

// --- lib/domain/gate.js -----------------------------------------------------
export type GateCompletionContract = Expect<
  Extends<DomainGate['completionBlockers'], (mission: Mission, config?: TowerConfig) => Blocker[]>
>
export type GateMergeContract = Expect<Extends<DomainGate['mergeGateBlockers'], (options: MergeGateOptions) => Blocker[]>>
export type GateRebaseWaiverContract = Expect<Extends<DomainGate['rebaseWaived'], (mission: Mission, review: Review) => boolean>>

// --- lib/domain/mission.js --------------------------------------------------
export type MissionVocabularyContract = Expect<Extends<DomainMission['MISSION_STATUSES'], readonly MissionStatus[]>>
export type MissionTerminalContract = Expect<Extends<DomainMission['isTerminal'], (status: string) => boolean>>
export type MissionTransitionContract = Expect<Extends<DomainMission['canTransition'], (from: string, to: string) => boolean>>
export type MissionPauseCauseContract = Expect<
  Extends<DomainMission['pauseCauseError'], (value?: string | null) => string | null>
>

// --- lib/domain/planning.js -------------------------------------------------
export type PlanningNumberContract = Expect<Extends<DomainPlanning['nextMissionNumber'], (missions: Mission[]) => number>>
export type PlanningDependencyContract = Expect<
  Extends<DomainPlanning['addDependency'], (mission: Mission, dep: string) => void>
>
export type PlanningPathContract = Expect<
  Extends<DomainPlanning['hasDependencyPath'], (missions: Map<string, Mission>, from: string, to: string) => boolean>
>
export type PlanningAcyclicContract = Expect<Extends<DomainPlanning['assertAcyclic'], (missions: Mission[]) => void>>
export type PlanningAutoDepsContract = Expect<
  Extends<DomainPlanning['addAutoDeps'], (newMissions: Mission[], existingMissions: Mission[]) => void>
>

// --- lib/domain/report.js ---------------------------------------------------
export type BoardContract = Expect<Extends<DomainReport['boardMarkdown'], (state: TowerState) => string>>

// --- lib/domain/roster.js ---------------------------------------------------
export type RosterLiveWorkerContract = Expect<
  Extends<DomainRoster['liveWorkerEntry'], (state: TowerState, missionId: string) => RosterEntry | undefined>
>
export type RosterWorkersContract = Expect<
  Extends<DomainRoster['workerEntries'], (state: TowerState, missionId: string) => RosterEntry[]>
>
export type RosterCountContract = Expect<Extends<DomainRoster['countLiveWorkers'], (state: TowerState) => number>>

// --- lib/domain/scope.js ----------------------------------------------------
export type ScopeFileContract = Expect<
  Extends<DomainScope['fileInScope'], (scope: string[] | null | undefined, file: string) => boolean>
>
export type ScopeTitleContract = Expect<Extends<DomainScope['validateTitle'], (title: unknown) => string>>
export type ScopeNormalizeContract = Expect<
  Extends<DomainScope['normalizeScope'], (scope: unknown, options?: { allowEmpty?: boolean }) => string[]>
>
export type ScopeOverlapContract = Expect<Extends<DomainScope['scopesOverlap'], (a: string[], b: string[]) => boolean>>

// --- lib/domain/state.js ----------------------------------------------------
export type ValidateStateContract = Expect<
  Extends<DomainState['validateState'], (state: unknown, statePath?: string) => TowerState>
>

// --- lib/domain/summary.js --------------------------------------------------
export type TaskCountsContract = Expect<Extends<DomainSummary['taskCounts'], (tasks: MissionTask[]) => TaskCounts>>
export type MissionSummaryContract = Expect<
  Extends<DomainSummary['missionSummary'], (mission: Mission) => MissionSummary>
>
export type FullMissionContract = Expect<Extends<DomainSummary['fullMission'], (mission: Mission) => MissionDetail>>
export type FindingSummaryContract = Expect<
  Extends<DomainSummary['findingSummary'], (finding: Finding) => FindingSummary>
>
export type CountFindingsContract = Expect<
  Extends<DomainSummary['countFindings'], (findings: Finding[]) => Record<string, number>>
>

// --- lib/git.js -------------------------------------------------------------
type GitAdapter = typeof import('../lib/git.js')

export type GitTryContract = Expect<
  Extends<
    GitAdapter['tryGit'],
    (cwd: string, args: string[], options?: { timeoutMs?: number; maxBuffer?: number }) => Promise<string | null>
  >
>
export type GitCurrentBranchContract = Expect<Extends<GitAdapter['currentBranch'], (cwd: string) => Promise<string | null>>>
export type GitResolveRepoContract = Expect<
  Extends<
    GitAdapter['resolveRepo'],
    (repoRoot: string) => Promise<{ root: string; commonDir: string; branch: string | null }>
  >
>
export type GitListWorktreesContract = Expect<
  Extends<GitAdapter['listWorktrees'], (cwd: string) => Promise<Array<{ path: string; branch?: string; head?: string }>>>
>

// --- lib/tower/ use cases ---------------------------------------------------
// gate.js/read.js import lib/git.js and batch.js imports lib/batch.js; those
// dependencies are inside the checkJs program too, so importing the use cases
// here also machine-checks the adapter surface above and batch validation.
type UseCaseBatch = typeof import('../lib/tower/batch.js')
type UseCaseFindings = typeof import('../lib/tower/findings.js')
type UseCaseGate = typeof import('../lib/tower/gate.js')
type UseCaseMessages = typeof import('../lib/tower/messages.js')
type UseCaseRead = typeof import('../lib/tower/read.js')
type UseCaseReview = typeof import('../lib/tower/review.js')
type UseCaseRoster = typeof import('../lib/tower/roster.js')

export type GateUseCaseContract = Expect<Extends<UseCaseGate['evaluateGate'], PromiseFunction>>
export type ReadUseCaseContract = Expect<
  Extends<
    [UseCaseRead['missionDetail'], UseCaseRead['status'], UseCaseRead['diff']],
    [PromiseFunction, PromiseFunction, PromiseFunction]
  >
>
export type BatchUseCaseContract = Expect<
  Extends<
    [UseCaseBatch['createBatch'], UseCaseBatch['closeBatch'], UseCaseBatch['abandonBatch'], UseCaseBatch['batchStatus']],
    [PromiseFunction, PromiseFunction, PromiseFunction, PromiseFunction]
  >
>
export type FindingsUseCaseContract = Expect<
  Extends<
    [UseCaseFindings['addFinding'], UseCaseFindings['readFindings'], UseCaseFindings['findings']],
    [PromiseFunction, PromiseFunction, PromiseFunction]
  >
>
export type MessagesUseCaseContract = Expect<
  Extends<
    [UseCaseMessages['recordMessage'], UseCaseMessages['recordDelivery'], UseCaseMessages['inbox']],
    [PromiseFunction, PromiseFunction, PromiseFunction]
  >
>
export type ReviewUseCaseContract = Expect<Extends<UseCaseReview['submitReview'], PromiseFunction>>
export type RosterUseCaseContract = Expect<
  Extends<
    [
      UseCaseRoster['recordRosterObservations'],
      UseCaseRoster['reconcileObservedInactive'],
      UseCaseRoster['markRetired'],
      UseCaseRoster['markMissing'],
      UseCaseRoster['sweepRoster'],
      UseCaseRoster['unreadFor'],
    ],
    [PromiseFunction, PromiseFunction, PromiseFunction, PromiseFunction, PromiseFunction, PromiseFunction]
  >
>

// The use-case modules are untyped internally (tower/input are `any`), so the
// contract check is an export-surface check: each function exists and returns
// a promise.
type PromiseFunction = (...args: never[]) => Promise<unknown>

// ===========================================================================
// Negative checks: these directives must stay live, otherwise tsc fails with
// "Unused '@ts-expect-error' directive". They pin the parts of the published
// contract that are easy to accidentally widen.
// ===========================================================================

// @ts-expect-error reviewPolicy is 'required-clean' | 'none' (runtime state validation)
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
