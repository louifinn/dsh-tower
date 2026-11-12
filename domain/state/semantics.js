// State semantics that a structural schema cannot express: uniqueness,
// status vocabularies, review exemption and per-kind mission fields (#149).
// @ts-check
import { FINDING_STATUSES, MERGE_VERDICTS, REVIEW_STATUS_RE } from '../mission.js'
import { BATCH_STATUSES } from '../batch.js'
import { TowerToolError } from '../errors.js'
import { isShapeKind, shapeFor } from '../shapes/index.js'
import { isAcceptanceRecord } from '../shapes/artifact.js'

/** @typedef {import('../../types/index.js').TowerState} TowerState */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new TowerToolError('state-corrupt', message)
}

/**
 * A build mission may carry a worktree/branch/merge projection; a survey may
 * not, and carries the read fingerprint instead. The shape declares which
 * dimensions its document owns, so this module never compares kinds.
 * @param {Record<string, any>} mission
 * @param {string} where
 * @returns {void}
 */
function assertMissionShapeFields(mission, where) {
  if (!isShapeKind(mission.kind)) {
    fail(`mission ${mission.id} has unknown kind ${String(mission.kind)}${where}`)
  }
  const shape = shapeFor(mission.kind)
  if (!shape.fields.worktree) {
    if (mission.worktree !== undefined && mission.worktree !== null) {
      fail(`mission ${mission.id} is a ${shape.kind} and may not have a worktree record${where}`)
    }
    for (const key of ['branch', 'baseCommit', 'mergedCommit', 'mergedAt']) {
      if (mission[key] !== undefined && mission[key] !== null) {
        fail(`mission ${mission.id} is a ${shape.kind} and may not have ${key}${where}`)
      }
    }
  }
  if (shape.fields.worktree) {
    if (mission.sandbox !== undefined) {
      fail(`mission ${mission.id} is a ${shape.kind} and may not have a sandbox${where}`)
    }
  } else if (shape.fields.sandbox) {
    // A detached survey sandbox is a recorded path, never a worktree record: it
    // has no branch, base commit or merge projection.
    if (mission.sandbox !== undefined && (typeof mission.sandbox !== 'string' || mission.sandbox.length === 0)) {
      fail(`mission ${mission.id} has an invalid sandbox path${where}`)
    }
  } else if (mission.sandbox !== undefined) {
    fail(`mission ${mission.id} is a ${shape.kind} and may not have a sandbox${where}`)
  }
  if (shape.fields.readCommit) {
    if (typeof mission.readCommit !== 'string' || mission.readCommit.length === 0) {
      fail(`mission ${mission.id} is a ${shape.kind} and needs a readCommit${where}`)
    }
    if (mission.readDirty !== undefined && (!Array.isArray(mission.readDirty) || mission.readDirty.some((entry) => typeof entry !== 'string'))) {
      fail(`mission ${mission.id} has an invalid readDirty fingerprint${where}`)
    }
  } else if (mission.readCommit !== undefined || mission.readDirty !== undefined) {
    fail(`mission ${mission.id} is a ${shape.kind} and may not have readCommit/readDirty${where}`)
  }
  // #159: the deliverables and the acceptance record are dimensions the shape
  // owns. An artifact needs its declared artifacts and may carry one
  // acceptance record; a build and a survey may carry neither.
  if (shape.fields.artifacts) {
    if (!Array.isArray(mission.artifacts) || mission.artifacts.length === 0 || mission.artifacts.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      fail(`mission ${mission.id} is a ${shape.kind} and needs a non-empty artifacts array${where}`)
    }
  } else if (mission.artifacts !== undefined) {
    fail(`mission ${mission.id} is a ${shape.kind} and may not declare artifacts${where}`)
  }
  if (shape.fields.acceptance) {
    if (mission.acceptance === undefined || mission.acceptance === null) return
    if (!isAcceptanceRecord(mission.acceptance)) {
      fail(`mission ${mission.id} has an invalid acceptance record${where}`)
    }
  } else if (mission.acceptance !== undefined) {
    fail(`mission ${mission.id} is a ${shape.kind} and may not carry an acceptance record${where}`)
  }
}

/**
 * A worktree record may omit legacy fields, but every field it carries must
 * keep its documented type.
 * @param {Record<string, any>} mission
 * @param {string} where
 * @returns {void}
 */
function assertWorktreeRecord(mission, where) {
  const worktree = mission.worktree
  if (worktree === undefined || worktree === null) return
  const invalid = !isPlainObject(worktree) || ['path', 'branch', 'baseCommit', 'realPath'].some(
    (key) => worktree[key] !== undefined && typeof worktree[key] !== 'string',
  ) || (worktree.createdAt !== undefined && typeof worktree.createdAt !== 'number')
  if (invalid) fail(`mission ${mission.id} has an invalid worktree record${where}`)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} state
 * @param {string} where
 * @returns {TowerState}
 */
export function assertStateSemantics(state, where) {
  const record = /** @type {Record<string, any>} */ (state)
  if (record.revision !== undefined && (!Number.isInteger(record.revision) || record.revision < 0)) {
    fail(`tower state revision is not a non-negative integer${where}`)
  }
  const missionIds = new Set()
  for (const mission of record.missions) {
    if (missionIds.has(mission.id)) fail(`duplicate mission id ${mission.id}${where}`)
    missionIds.add(mission.id)
    const shape = shapeFor(mission.kind)
    if (!shape.statuses.includes(mission.status)) {
      fail(`mission ${mission.id} has unknown status ${mission.status} for a ${shape.kind} mission${where}`)
    }
    if (mission.reviewPolicy !== undefined && !['required-clean', 'none'].includes(mission.reviewPolicy)) {
      fail(`mission ${mission.id} has unknown reviewPolicy ${mission.reviewPolicy}${where}`)
    }
    if (mission.reviewPolicy === 'none' && !String(mission.reviewExemptionReason ?? '').trim()) {
      fail(`mission ${mission.id} has reviewPolicy none without a reason${where}`)
    }
    assertMissionShapeFields(mission, where)
    assertWorktreeRecord(mission, where)
    // W3: `blocked` is derived from open blockers, never an independent stop
    // state. A non-terminal mission is blocked exactly when it records a
    // blocker, so the two can never disagree (a paused mission has no blockers;
    // a blocker supersedes a pause). Terminal missions keep blockers as history.
    const blockers = mission.blockers ?? []
    if (!Array.isArray(blockers) || blockers.some((entry) => typeof entry !== 'string')) {
      fail(`mission ${mission.id} has invalid blockers${where}`)
    }
    if (!shape.isTerminal(mission.status)) {
      if (mission.status === 'blocked' && blockers.length === 0) {
        fail(`mission ${mission.id} is blocked but records no blocker; blocked is derived from open blockers${where}`)
      }
      if (mission.status !== 'blocked' && blockers.length > 0) {
        fail(`mission ${mission.id} has open blockers but is ${mission.status}; blocked is derived from open blockers${where}`)
      }
    }
  }
  if (record.roster !== undefined) {
    const names = new Set()
    const agents = new Set()
    for (const entry of record.roster) {
      const reserved = entry?.state === 'reserved'
      if (!entry || typeof entry.name !== 'string' || (!reserved && typeof entry.agentId !== 'string')) {
        fail(`invalid roster entry${where}`)
      }
      if (names.has(entry.name)) fail(`duplicate roster name ${entry.name}${where}`)
      if (typeof entry.agentId === 'string') {
        if (agents.has(entry.agentId)) fail(`duplicate roster agent ${entry.agentId}${where}`)
        agents.add(entry.agentId)
      }
      names.add(entry.name)
    }
  }
  if (record.messages !== undefined) {
    const ids = new Set()
    for (const message of record.messages) {
      if (ids.has(message.id)) fail(`duplicate message id ${message.id}${where}`)
      ids.add(message.id)
    }
  }
  if (record.findings !== undefined) {
    const ids = new Set()
    for (const finding of record.findings) {
      if (ids.has(finding.id)) fail(`duplicate finding id ${finding.id}${where}`)
      ids.add(finding.id)
      if (finding.status !== undefined && !FINDING_STATUSES.includes(finding.status)) {
        fail(`finding ${finding.id} has unknown status ${finding.status}${where}`)
      }
    }
  }
  if (record.reviews !== undefined) {
    const ids = new Set()
    for (const review of record.reviews) {
      if (ids.has(review.id)) fail(`duplicate review id ${review.id}${where}`)
      ids.add(review.id)
      if (!REVIEW_STATUS_RE.test(String(review.status))) {
        fail(`review ${review.id} has unknown status ${review.status}${where}`)
      }
      if (!MERGE_VERDICTS.includes(review.mergeVerdict)) {
        fail(`review ${review.id} has unknown merge verdict ${review.mergeVerdict}${where}`)
      }
      // Round/sequence are the two recency keys the shared review resolver reads
      // (round first, then the submission sequence inside one round). A row that
      // carries a malformed key would silently sort as revision 0.
      if (review.round !== undefined && (!Number.isInteger(review.round) || review.round < 1)) {
        fail(`review ${review.id} has invalid round ${review.round}${where}`)
      }
      if (review.seq !== undefined && (!Number.isInteger(review.seq) || review.seq < 0)) {
        fail(`review ${review.id} has invalid sequence ${review.seq}${where}`)
      }
    }
  }
  // Batches have their own generic lifecycle (#149 W3), not a mission shape. The
  // ledger may only carry canonical statuses; legacy synonyms are normalized by
  // the v5 state migration, never accepted at rest.
  if (record.batches !== undefined) {
    const ids = new Set()
    for (const batch of record.batches) {
      if (!isPlainObject(batch)) fail(`invalid batch record${where}`)
      if (ids.has(batch.id)) fail(`duplicate batch id ${batch.id}${where}`)
      ids.add(batch.id)
      const status = typeof batch.status === 'string' ? batch.status : ''
      if (!BATCH_STATUSES.includes(status)) {
        fail(`batch ${batch.id} has unknown status ${batch.status}${where}`)
      }
    }
  }
  return /** @type {TowerState} */ (record)
}
