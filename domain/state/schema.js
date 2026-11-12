// Declarative state-file schema (#56 P4, #149).
//
// `StateSchema` describes the structural contract of
// `<git-common-dir>/dsh-tower/state.json`. Schema v4 splits a mission into a
// per-shape union: a build mission owns a branch/worktree/merge projection, a
// survey owns `readCommit`/`readDirty` and may *not* carry the branch-shaped
// fields, and an artifact owns the branch projection plus the declared
// `artifacts` and the human `acceptance` record (#159). Object schemas allow additional properties on purpose: state files
// are forward/backward compatible and legacy rows carry extra fields, while the
// union's forbidden keys are declared `Type.Never()` so a survey carrying a
// worktree record fails the shape check. Semantic policy (uniqueness,
// status/verdict vocabularies, review exemption, worktree records and the
// revision counter) lives in `./semantics.js`, so this module remains a pure
// declaration.
// @ts-check
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { SCHEMA_VERSION } from '../mission.js'
import { isShapeKind, shapeFor } from '../shapes/index.js'

const optional = { additionalProperties: true }

const NonNegativeInteger = Type.Integer({ minimum: 0 })

const WorktreeSchema = Type.Object({}, optional)

const BuildMissionSchema = Type.Object(
  {
    id: Type.String(),
    kind: Type.Literal('build'),
    status: Type.Optional(Type.String()),
    tasks: Type.Array(Type.Unknown()),
    deps: Type.Array(Type.Unknown()),
    references: Type.Optional(Type.Array(Type.Unknown())),
    reviewPolicy: Type.Optional(Type.String()),
    testRuns: Type.Optional(Type.Array(Type.Unknown())),
    worktree: Type.Optional(Type.Union([WorktreeSchema, Type.Null()])),
    // A build mission reads a base and writes a branch; it never carries the
    // survey fingerprint, a detached survey sandbox, the artifact deliverables
    // or a human acceptance record.
    readCommit: Type.Optional(Type.Never()),
    readDirty: Type.Optional(Type.Never()),
    sandbox: Type.Optional(Type.Never()),
    artifacts: Type.Optional(Type.Never()),
    acceptance: Type.Optional(Type.Never()),
  },
  optional,
)

const SurveyMissionSchema = Type.Object(
  {
    id: Type.String(),
    kind: Type.Literal('survey'),
    status: Type.Optional(Type.String()),
    tasks: Type.Array(Type.Unknown()),
    deps: Type.Array(Type.Unknown()),
    references: Type.Optional(Type.Array(Type.Unknown())),
    reviewPolicy: Type.Optional(Type.String()),
    readCommit: Type.String(),
    readDirty: Type.Optional(Type.Array(Type.String())),
    // #148 W2: an optional path to the disposable detached sandbox. Absent for
    // a shared-checkout survey and for every build.
    sandbox: Type.Optional(Type.String()),
    // A survey reads one commit in the shared checkout: no branch shape.
    worktree: Type.Optional(Type.Never()),
    branch: Type.Optional(Type.Never()),
    baseCommit: Type.Optional(Type.Never()),
    mergedCommit: Type.Optional(Type.Never()),
    mergedAt: Type.Optional(Type.Never()),
    // A survey owns neither the artifact deliverables nor an acceptance record.
    artifacts: Type.Optional(Type.Never()),
    acceptance: Type.Optional(Type.Never()),
  },
  optional,
)

const ArtifactMissionSchema = Type.Object(
  {
    id: Type.String(),
    kind: Type.Literal('artifact'),
    status: Type.Optional(Type.String()),
    tasks: Type.Array(Type.Unknown()),
    deps: Type.Array(Type.Unknown()),
    references: Type.Optional(Type.Array(Type.Unknown())),
    reviewPolicy: Type.Optional(Type.String()),
    testRuns: Type.Optional(Type.Array(Type.Unknown())),
    worktree: Type.Optional(Type.Union([WorktreeSchema, Type.Null()])),
    // #159 D2: the declared deliverables. Every path is concrete, inside the
    // scope, and must be committed at the branch tip before completion.
    artifacts: Type.Array(Type.String()),
    // #159 D3: the human acceptance record that replaces the review. Absent
    // until a human accepts the whole committed tip.
    acceptance: Type.Optional(Type.Object({}, optional)),
    // An artifact writes a branch like a build; it never carries the survey
    // fingerprint or a detached sandbox.
    readCommit: Type.Optional(Type.Never()),
    readDirty: Type.Optional(Type.Never()),
    sandbox: Type.Optional(Type.Never()),
  },
  optional,
)

const MissionSchema = Type.Union([BuildMissionSchema, SurveyMissionSchema, ArtifactMissionSchema])

const RosterEntrySchema = Type.Object(
  {
    name: Type.String(),
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  optional,
)

const ReviewSchema = Type.Object(
  {
    id: Type.String(),
    status: Type.Optional(Type.String()),
    mergeVerdict: Type.Optional(Type.String()),
  },
  optional,
)

const FindingSchema = Type.Object(
  {
    id: Type.String(),
    status: Type.Optional(Type.String()),
  },
  optional,
)

const MessageSchema = Type.Object(
  {
    id: Type.String(),
    to: Type.String(),
    readBy: Type.Array(Type.Unknown()),
  },
  optional,
)

/** Structural contract for one persisted Tower state document. */
export const StateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(SCHEMA_VERSION),
    revision: Type.Optional(Type.Number()),
    base: Type.Optional(Type.String()),
    repoRoot: Type.Optional(Type.String()),
    commonDir: Type.Optional(Type.String()),
    createdAt: Type.Optional(Type.Number()),
    updatedAt: Type.Optional(Type.Number()),
    dirtyBase: Type.Optional(Type.Boolean()),
    // Detected once at tower_init (#90). `null` means "not detected yet": the
    // v2 -> v3 migration backfills it without touching the filesystem.
    caseInsensitive: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    towerAgentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    snapshotCommit: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    snapshotRef: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    missions: Type.Array(MissionSchema),
    roster: Type.Optional(Type.Array(RosterEntrySchema)),
    reviews: Type.Optional(Type.Array(ReviewSchema)),
    findings: Type.Optional(Type.Array(FindingSchema)),
    messages: Type.Optional(Type.Array(MessageSchema)),
    batches: Type.Optional(Type.Array(Type.Unknown())),
    legacySnapshots: Type.Optional(Type.Array(Type.Unknown())),
    legacyMaps: Type.Optional(Type.Array(Type.Unknown())),
    deliveries: Type.Optional(Type.Array(Type.Unknown())),
    mergeIntent: Type.Optional(Type.Union([Type.Object({}, optional), Type.Null()])),
    rebaseIntent: Type.Optional(Type.Union([Type.Object({}, optional), Type.Null()])),
    messageSeq: Type.Optional(NonNegativeInteger),
    reviewSeq: Type.Optional(NonNegativeInteger),
    findingSeq: Type.Optional(NonNegativeInteger),
    batchSeq: Type.Optional(NonNegativeInteger),
    deliverySeq: Type.Optional(NonNegativeInteger),
  },
  optional,
)

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @type {readonly string[]} */
const ARRAY_KEYS = ['batches', 'legacySnapshots', 'legacyMaps', 'deliveries']
/** @type {readonly string[]} */
const SEQUENCE_KEYS = ['messageSeq', 'reviewSeq', 'findingSeq', 'batchSeq', 'deliverySeq']

/**
 * Reproduce the historical `[tower:state-corrupt]` diagnostics for the
 * structural failures the schema rejects. Keeping them in the state vocabulary
 * (rather than exposing TypeBox paths) keeps operator-facing messages stable.
 * @param {Record<string, any>} state
 * @param {string} where
 * @returns {string | null}
 */
function firstShapeMessage(state, where) {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    return `unsupported tower state schemaVersion ${state.schemaVersion}${where}`
  }
  if (!Array.isArray(state.missions)) return `tower state has no missions array${where}`
  for (const mission of state.missions) {
    if (!isPlainObject(mission) || typeof mission.id !== 'string') return `mission entry without id${where}`
    const id = mission.id
    if (!isShapeKind(mission.kind)) {
      return `mission ${id} has unknown kind ${String(mission.kind)}${where}`
    }
    if (!Array.isArray(mission.tasks)) return `mission ${id} has no tasks array${where}`
    if (!Array.isArray(mission.deps)) return `mission ${id} has no deps array${where}`
    if (mission.references !== undefined && !Array.isArray(mission.references)) {
      return `mission ${id} has no references array${where}`
    }
    if (mission.reviewPolicy !== undefined && typeof mission.reviewPolicy !== 'string') {
      return `mission ${id} has unknown reviewPolicy ${mission.reviewPolicy}${where}`
    }
    if (mission.testRuns !== undefined && !Array.isArray(mission.testRuns)) {
      return `mission ${id} has no testRuns array${where}`
    }
    if (isShapeKind(mission.kind)) {
      const shape = shapeFor(mission.kind)
      if (shape.fields.readCommit) {
        if (typeof mission.readCommit !== 'string' || mission.readCommit.length === 0) {
          return `mission ${id} is a survey and needs a readCommit${where}`
        }
        if (mission.readDirty !== undefined && !Array.isArray(mission.readDirty)) {
          return `mission ${id} has an invalid readDirty fingerprint${where}`
        }
        if (mission.sandbox !== undefined && (typeof mission.sandbox !== 'string' || mission.sandbox.length === 0)) {
          return `mission ${id} has an invalid sandbox path${where}`
        }
        if (mission.worktree !== undefined && mission.worktree !== null) {
          return `mission ${id} is a survey and may not have a worktree record${where}`
        }
      } else if (mission.readCommit !== undefined || mission.readDirty !== undefined) {
        return `mission ${id} is a ${String(mission.kind)} and may not have readCommit/readDirty${where}`
      } else if (mission.sandbox !== undefined) {
        return `mission ${id} is a ${String(mission.kind)} and may not have a sandbox${where}`
      }
      if (shape.fields.artifacts) {
        if (!Array.isArray(mission.artifacts) || mission.artifacts.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
          return `mission ${id} is an artifact and needs an artifacts array of non-empty deliverable paths${where}`
        }
      } else if (mission.artifacts !== undefined) {
        return `mission ${id} is a ${String(mission.kind)} and may not declare artifacts${where}`
      }
      if (!shape.fields.acceptance && mission.acceptance !== undefined) {
        return `mission ${id} is a ${String(mission.kind)} and may not carry an acceptance record${where}`
      }
    }
    if (mission.worktree !== undefined && mission.worktree !== null && !isPlainObject(mission.worktree)) {
      return `mission ${id} has an invalid worktree record${where}`
    }
  }
  for (const key of ['base', 'repoRoot', 'commonDir']) {
    if (state[key] !== undefined && typeof state[key] !== 'string') return `tower state ${key} is not a string${where}`
  }
  for (const key of ['createdAt', 'updatedAt']) {
    if (state[key] !== undefined && typeof state[key] !== 'number') {
      return `tower state ${key} is not a number${where}`
    }
  }
  if (state.dirtyBase !== undefined && typeof state.dirtyBase !== 'boolean') {
    return `tower state dirtyBase is not a boolean${where}`
  }
  if (state.caseInsensitive !== undefined && state.caseInsensitive !== null && typeof state.caseInsensitive !== 'boolean') {
    return `tower state caseInsensitive is not a boolean${where}`
  }
  for (const key of ['towerAgentId', 'snapshotCommit', 'snapshotRef']) {
    if (state[key] !== undefined && state[key] !== null && typeof state[key] !== 'string') {
      return `tower state ${key} is not a string or null${where}`
    }
  }
  if (state.revision !== undefined && typeof state.revision !== 'number') {
    return `tower state revision is not a non-negative integer${where}`
  }
  for (const key of ARRAY_KEYS) {
    if (state[key] !== undefined && !Array.isArray(state[key])) return `tower state ${key} is not an array${where}`
  }
  for (const key of SEQUENCE_KEYS) {
    if (state[key] !== undefined && !(Number.isInteger(state[key]) && state[key] >= 0)) {
      return `tower state ${key} is not a non-negative integer${where}`
    }
  }
  if (state.mergeIntent !== undefined && state.mergeIntent !== null && !isPlainObject(state.mergeIntent)) {
    return `tower state mergeIntent is not an object${where}`
  }
  if (state.rebaseIntent !== undefined && state.rebaseIntent !== null && !isPlainObject(state.rebaseIntent)) {
    return `tower state rebaseIntent is not an object${where}`
  }
  if (state.roster !== undefined) {
    if (!Array.isArray(state.roster)) return `tower state roster is not an array${where}`
    for (const entry of state.roster) {
      if (!isPlainObject(entry) || typeof entry.name !== 'string') return `invalid roster entry${where}`
      if (entry.agentId !== undefined && entry.agentId !== null && typeof entry.agentId !== 'string') {
        return `invalid roster entry${where}`
      }
    }
  }
  if (state.messages !== undefined) {
    if (!Array.isArray(state.messages)) return `tower state messages is not an array${where}`
    for (const message of state.messages) {
      if (!isPlainObject(message) || typeof message.id !== 'string' || typeof message.to !== 'string') {
        return `invalid message entry${where}`
      }
      if (!Array.isArray(message.readBy)) return `message ${message.id} has no readBy array${where}`
    }
  }
  if (state.findings !== undefined) {
    if (!Array.isArray(state.findings)) return `tower state findings is not an array${where}`
    for (const finding of state.findings) {
      if (!isPlainObject(finding) || typeof finding.id !== 'string') return `invalid finding entry${where}`
      if (finding.status !== undefined && typeof finding.status !== 'string') {
        return `finding ${finding.id} has unknown status ${finding.status}${where}`
      }
    }
  }
  if (state.reviews !== undefined) {
    if (!Array.isArray(state.reviews)) return `tower state reviews is not an array${where}`
    for (const review of state.reviews) {
      if (!isPlainObject(review) || typeof review.id !== 'string') return `invalid review entry${where}`
      if (review.status !== undefined && typeof review.status !== 'string') {
        return `review ${review.id} has unknown status ${review.status}${where}`
      }
      if (review.mergeVerdict !== undefined && typeof review.mergeVerdict !== 'string') {
        return `review ${review.id} has unknown merge verdict ${review.mergeVerdict}${where}`
      }
    }
  }
  return null
}

/**
 * Pure structural check. Returns the legacy diagnostic, or null when the state
 * satisfies `StateSchema`. `where` is the already-formatted " at <path>" suffix.
 * @param {unknown} state
 * @param {string} [where]
 * @returns {string | null}
 */
export function stateShapeError(state, where = '') {
  if (!isPlainObject(state)) return `tower state is not an object${where}`
  if (Value.Check(StateSchema, state)) return null
  const record = /** @type {Record<string, any>} */ (state)
  return firstShapeMessage(record, where) ?? `tower state does not match the state schema${where}`
}
