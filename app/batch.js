// Batch use cases.
import { TowerToolError } from '../domain/errors.js'
import { withLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import { validateCreate as validateBatchCreate, validateClose as validateBatchClose } from '../domain/batch.js'
import {
  nextBatchId,
  createBatchRecord,
  closeBatchRecord,
  abandonBatchCheck,
  applyBatchAbandon,
  batchStatusPayload,
} from '../domain/collab/batch.js'

function fail(message, code = 'batch-invalid') {
  throw new TowerToolError(code, message)
}

export async function createBatch(tower, input = {}, actor = 'tower') {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const normalized = validateBatchCreate(state, input)
      if (!Array.isArray(state.batches)) state.batches = []
      const batch = createBatchRecord(nextBatchId(state.batches), normalized, actor, Date.now())
      state.batches.push(batch)
      state.revision += 1
      state.updatedAt = batch.createdAt
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, {
        at: batch.createdAt,
        type: 'batch',
        text: `created ${batch.id}: ${batch.missionIds.join(', ')}`,
      })
      return batch
    })
  }

  export async function closeBatch(tower, batchId, options = {}, actor = 'tower') {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const batch = (state.batches ?? []).find((entry) => entry.id === batchId)
      if (!batch) fail(`unknown batch "${batchId}"`)
      const result = validateBatchClose(state, batch, { ...options, state })
      const blockers = Array.isArray(result.blockers) ? result.blockers : []
      if (blockers.length > 0) return { ok: false, batch, blockers, checks: result.checks ?? [] }
      closeBatchRecord(batch, options, actor, Date.now())
      state.revision += 1
      state.updatedAt = batch.closedAt
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, { at: batch.closedAt, type: 'batch', text: `closed ${batch.id}` })
      return { ok: true, batch, blockers: [], checks: result.checks ?? [] }
    })
  }

  /** @param {string} batchId @param {string} [actor] @param {string | null} [reason] */
  export async function abandonBatch(tower, batchId, actor = 'tower', reason = null) {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const batch = (state.batches ?? []).find((entry) => entry.id === batchId)
      if (!batch) fail(`unknown batch "${batchId}"`)
      const { alreadyAbandoned } = abandonBatchCheck(batch, batchId)
      if (alreadyAbandoned) return { ok: true, batch, alreadyAbandoned: true }
      const now = Date.now()
      applyBatchAbandon({ batch, actor, reason, now })
      state.revision += 1
      state.updatedAt = batch.abandonedAt
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, { at: batch.abandonedAt, type: 'batch', text: `abandoned ${batch.id}` })
      return { ok: true, batch, alreadyAbandoned: false }
    })
  }

  export async function batchStatus(tower, batchId) {
    const state = await tower.load()
    return batchStatusPayload(state, batchId)
  }
