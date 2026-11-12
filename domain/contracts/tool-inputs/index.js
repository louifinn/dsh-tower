// Tool input contracts (#56 P3c): named schemas grouped by area plus a
// `ToolInputs` map keyed by registered tool name. Pure data; no I/O.
import {
  CompleteInput,
  MissionInput,
  PlanInput,
  PreflightInput,
  ReviewInput,
  StatusInput,
} from './missions.js'
import {
  AdoptInput,
  InboxInput,
  InterruptInput,
  RosterInput,
  SendInput,
  SpawnInput,
} from './collaboration.js'
import { DiffInput, MergeInput, RebaseInput, TeardownInput } from './integration.js'
import { InspectInput } from './inspect.js'
import { FindingInput, FindingsInput } from './findings.js'
import {
  BatchInput,
  DoctorInput,
  ImportLegacyInput,
  InitInput,
  LegacyMapInput,
  RecoverInput,
  ReloadInput,
  ResourceInput,
  TestInput,
} from './ops.js'

export {
  CompleteInput,
  MissionInput,
  PlanInput,
  PreflightInput,
  ReviewInput,
  StatusInput,
  AdoptInput,
  InboxInput,
  InterruptInput,
  RosterInput,
  SendInput,
  SpawnInput,
  DiffInput,
  MergeInput,
  RebaseInput,
  TeardownInput,
  InspectInput,
  FindingInput,
  FindingsInput,
  BatchInput,
  DoctorInput,
  ImportLegacyInput,
  InitInput,
  LegacyMapInput,
  RecoverInput,
  ReloadInput,
  ResourceInput,
  TestInput,
}

/** @type {Record<string, import('@sinclair/typebox').TSchema>} */
const ToolInputs = {
  tower_init: InitInput,
  tower_plan: PlanInput,
  tower_mission: MissionInput,
  tower_inspect: InspectInput,
  tower_spawn: SpawnInput,
  tower_interrupt: InterruptInput,
  tower_adopt: AdoptInput,
  tower_send: SendInput,
  tower_inbox: InboxInput,
  tower_complete: CompleteInput,
  tower_finding: FindingInput,
  tower_findings: FindingsInput,
  tower_review: ReviewInput,
  tower_merge: MergeInput,
  tower_rebase: RebaseInput,
  tower_teardown: TeardownInput,
  tower_recover: RecoverInput,
  tower_test: TestInput,
  tower_batch: BatchInput,
  tower_resource: ResourceInput,
  tower_import_legacy: ImportLegacyInput,
  tower_legacy_map: LegacyMapInput,
  tower_reload: ReloadInput,
}

export { ToolInputs }
