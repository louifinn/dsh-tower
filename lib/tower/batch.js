// Batch use cases.
import { TowerToolError } from '../errors.js'
import { withLock, writeJsonAtomic, appendJsonl } from '../store.js'
import { validateState } from '../domain/state.js'
import { validateCreate as validateBatchCreate, validateClose as validateBatchClose, summarize as summarizeBatch } from '../batch.js'

function fail(message, code = 'batch-invalid') {
  throw new TowerToolError(code, message)
}

export async function createBatch(tower, input = {}, actor = 'tower') {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const normalized = validateBatchCreate(state, input)
      if (!Array.isArray(state.batches)) state.batches = []
      const max = state.batches.reduce((value, batch) => {
        const match = /^B(\d+)$/.exec(String(batch.id ?? ''))
        return match ? Math.max(value, Number(match[1])) : value
      }, 0)
      const batch = {
        id: `B${max + 1}`,
        status: 'open',
        ...normalized,
        createdBy: actor,
        createdAt: Date.now(),
      }
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
      batch.status = 'closed'
      batch.closedAt = Date.now()
      batch.closedBy = actor
      batch.close = {
        checks: options.checks ?? [],
        treeTip: options.treeTip ?? null,
        receiptHashes: options.receiptHashes ?? {},
        at: batch.closedAt,
      }
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
      if (batch.status === 'closed') fail(`batch ${batchId} is already closed`)
      if (batch.status === 'abandoned') return { ok: true, batch, alreadyAbandoned: true }
      batch.status = 'abandoned'
      batch.abandonedAt = Date.now()
      batch.abandonedBy = actor
      batch.abandonReason = typeof reason === 'string' && reason.trim() ? reason.trim() : null
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
    const batch = batchId
      ? (state.batches ?? []).find((entry) => entry.id === batchId)
      : null
    if (batchId && !batch) fail(`unknown batch "${batchId}"`)
    return {
      batches: (state.batches ?? []).map((entry) => summarizeBatch(state, entry)),
      ...(batch ? { batch: summarizeBatch(state, batch) } : {}),
    }
  }

  /** Track repeated absence observations before declaring a roster row gone. */
