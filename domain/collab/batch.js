// Pure batch lifecycle decisions and status projection.
//
// `domain/batch.js` owns the admission/close evidence validation; this module
// owns the id assignment, close/abandon record transitions, and status payload
// that app/batch.js used to keep inline. Receipt file reads stay in the tool
// layer.
// @ts-check
import { TowerToolError } from '../errors.js'
import { summarize } from '../batch.js'

/** @typedef {import('../../types/index.js').TowerState} TowerState */

/**
 * @param {string} message
 * @param {string} [code]
 * @returns {never}
 */
function fail(message, code = 'batch-invalid') {
  throw new TowerToolError(code, message)
}

/**
 * Next free `B<n>` id.
 * @param {any[]} batches
 * @returns {string}
 */
export function nextBatchId(batches) {
  const max = batches.reduce((value, batch) => {
    const match = /^B(\d+)$/.exec(String(batch.id ?? ''))
    return match ? Math.max(value, Number(match[1])) : value
  }, 0)
  return `B${max + 1}`
}

/**
 * Project the persisted batch record from normalized create input.
 * @param {string} id
 * @param {any} normalized
 * @param {string} actor
 * @param {number} now
 * @returns {any}
 */
export function createBatchRecord(id, normalized, actor, now) {
  return {
    id,
    status: 'open',
    ...normalized,
    createdBy: actor,
    createdAt: now,
  }
}

/**
 * Mark a validated open batch closed with its evidence snapshot.
 * @param {any} batch
 * @param {{ checks?: unknown, treeTip?: unknown, receiptHashes?: unknown }} options
 * @param {string} actor
 * @param {number} now
 * @returns {any}
 */
export function closeBatchRecord(batch, options, actor, now) {
  batch.status = 'closed'
  batch.closedAt = now
  batch.closedBy = actor
  batch.close = {
    checks: options.checks ?? [],
    treeTip: options.treeTip ?? null,
    receiptHashes: options.receiptHashes ?? {},
    at: now,
  }
  return batch
}

/**
 * A closed batch cannot be abandoned; an already-abandoned one is a no-op.
 * @param {any} batch
 * @param {string} batchId
 * @returns {{ alreadyAbandoned: boolean }}
 */
export function abandonBatchCheck(batch, batchId) {
  if (batch.status === 'closed') fail(`batch ${batchId} is already closed`)
  return { alreadyAbandoned: batch.status === 'abandoned' }
}

/**
 * Apply an abandonment to the draft batch.
 * @param {{ batch: any, actor: string, reason?: unknown, now: number }} params
 * @returns {any}
 */
export function applyBatchAbandon({ batch, actor, reason, now }) {
  batch.status = 'abandoned'
  batch.abandonedAt = now
  batch.abandonedBy = actor
  batch.abandonReason = typeof reason === 'string' && reason.trim() ? reason.trim() : null
  return batch
}

/**
 * Read-only `tower_batch status` payload.
 * @param {TowerState} state
 * @param {string | undefined} batchId
 * @returns {any}
 */
export function batchStatusPayload(state, batchId) {
  const batches = state.batches ?? []
  const batch = batchId ? batches.find((entry) => entry.id === batchId) : null
  if (batchId && !batch) fail(`unknown batch "${batchId}"`)
  return {
    batches: batches.map((entry) => summarize(state, entry)),
    ...(batch ? { batch: summarize(state, batch) } : {}),
  }
}
