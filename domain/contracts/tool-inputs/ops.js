// tower_init / tower_doctor / tower_recover / tower_test / tower_batch /
// tower_resource / tower_import_legacy / tower_legacy_map / tower_reload input
// contracts. Pure TypeBox only; no I/O.
//
// #163: `tower_init` is the only tool that keeps the `repoRoot` field (it
// bootstraps the repository). Every other schema omits it; the runtime resolves
// the calling session's repository. Alias fields stay accepted through the tool
// definitions' `aliases` maps but are no longer advertised.
import {
  BATCH_ACTIONS,
  IMPORT_OPS,
  INIT_OPS,
  LEASE_ACTIONS,
  LEGACY_MAP_ACTIONS,
  RECOVERY_ACTIONS,
} from '../../vocabulary.js'
import { Type, enumOf, untypedObject } from './shared.js'

export const InitInput = Type.Object({
  op: Type.Optional(enumOf(INIT_OPS, { description: 'init creates/anchors Tower state (default); adopt reconciles the roster with the subagent catalog.' })),
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  base: Type.Optional(Type.String({ description: 'Optional local base branch (defaults to the checked-out branch).' })),
  auto_git_init: Type.Optional(Type.Boolean({ description: 'Run git init (and an empty initial commit) when repoRoot is not a repository yet.' })),
  snapshot_dirty: Type.Optional(Type.Boolean({ description: 'Snapshot uncommitted tracked changes into a dangling commit used as the mission baseline (untracked files are not included).' })),
  reanchor: Type.Optional(Type.Boolean({ description: 'Update the recorded base when no mission is active.' })),
  retire_missing: Type.Optional(Type.Boolean({ description: 'adopt: retire provably missing agents (default true); false marks them missing so the tower can inspect them.' })),
}, { additionalProperties: false })

export const DoctorInput = Type.Object({}, { additionalProperties: false })

export const RecoverInput = Type.Object({
  action: enumOf(RECOVERY_ACTIONS, { description: 'Recovery action.' }),
  confirm: Type.Optional(Type.String({ description: 'Required literal CLEAR_STALE_LOCK for clear-stale-lock.' })),
  force: Type.Optional(Type.Boolean({ description: 'clear-stale-lock: clear the lock even when its recorded PID is alive (a recycled PID); requires confirm and still moves the record to a .recovered-<ts> backup.' })),
}, { additionalProperties: false })

export const TestInput = Type.Object({
  missionId: Type.String({ description: 'Mission id, e.g. M1 (alias: id).' }),
}, { additionalProperties: false })

export const BatchInput = Type.Object({
  action: enumOf(BATCH_ACTIONS, { description: 'Batch operation.' }),
  missionIds: Type.Optional(Type.Array(Type.String(), { description: 'Exact mission ids in this batch (create).' })),
  exclusions: Type.Optional(Type.Array(Type.String(), { description: 'Paused legacy mission ids excluded from the batch.' })),
  requiredChecks: Type.Optional(Type.Array(Type.String(), { description: 'Check names every build member must record (default ["check"]).' })),
  receiptPaths: Type.Optional(Type.Array(Type.String(), { description: 'Exact relative receipt files checked at close.' })),
  batchId: Type.Optional(Type.String({ description: 'Batch id (status/close/abandon).' })),
  reason: Type.Optional(Type.String({ description: 'Reason recorded when abandoning a batch.' })),
  checks: Type.Optional(Type.Array(untypedObject(), { description: 'Close-time extra check evidence.' })),
  treeTip: Type.Optional(Type.String({ description: 'Expected reviewed/tested commit for close evidence.' })),
  receiptHashes: Type.Optional(untypedObject('Relative receipt path -> sha256 observed by the caller.')),
}, { additionalProperties: false })

export const ResourceInput = Type.Object({
  action: enumOf(LEASE_ACTIONS, { description: 'Lease operation.' }),
  name: Type.Optional(Type.String({ description: 'Lease name, e.g. plugin-load or heavy-ci.' })),
  holder: Type.Optional(Type.String({ description: 'Holder label (defaults to the caller).' })),
  token: Type.Optional(Type.String({ description: 'Release token; generated on acquire when omitted.' })),
  ttlMs: Type.Optional(Type.Integer({ minimum: 1000, description: 'Lease lifetime (default leases.ttlMs).' })),
  force: Type.Optional(Type.Boolean({ description: 'Explicitly release an expired lease (token still required).' })),
}, { additionalProperties: false })

export const ImportLegacyInput = Type.Object({
  sourcePath: Type.String({ description: 'Absolute path to the legacy JSON state file.' }),
}, { additionalProperties: false })

export const LegacyMapInput = Type.Object({
  action: enumOf(LEGACY_MAP_ACTIONS, { description: 'Mapping operation.' }),
  sourceHash: Type.Optional(Type.String({ description: 'Legacy snapshot sha256 (map).' })),
  oldId: Type.Optional(Type.String({ description: 'Legacy mission id (map).' })),
  newMissionId: Type.Optional(Type.String({ description: 'Current mission id; optional audit pointer.' })),
}, { additionalProperties: false })

/** #163 Phase 4: snapshot + map share `tower_import`. */
export const ImportInput = Type.Object({
  op: Type.Optional(enumOf(IMPORT_OPS, { description: 'snapshot imports a legacy state file (default when sourcePath is present); map records/lists audit mappings.' })),
  sourcePath: Type.Optional(Type.String({ description: 'Absolute path to the legacy JSON state file (snapshot).' })),
  action: Type.Optional(enumOf(LEGACY_MAP_ACTIONS, { description: 'Mapping operation (map).' })),
  sourceHash: Type.Optional(Type.String({ description: 'Legacy snapshot sha256 (map).' })),
  oldId: Type.Optional(Type.String({ description: 'Legacy mission id (map).' })),
  newMissionId: Type.Optional(Type.String({ description: 'Current mission id; optional audit pointer.' })),
}, { additionalProperties: false })

export const ReloadInput = Type.Object({}, { additionalProperties: false })
