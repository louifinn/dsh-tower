// Shared TypeBox helpers for tool input schemas (#45, #56 P3c).
import { Type } from '@sinclair/typebox'

/**
 * A string enum that serializes to the same JSON Schema shape as the old
 * inline schemas (type/enum) rather than TypeBox's anyOf union form.
 * @template {string} T
 * @param {readonly T[]} values
 * @param {Record<string, unknown>} [options]
 * @returns {import('@sinclair/typebox').TUnsafe<T>}
 */
export function enumOf(values, options = {}) {
  return Type.Unsafe(/** @type {any} */ ({ type: 'string', enum: [...values], ...options }))
}

/**
 * Untyped JSON object entries (checks, receiptHashes) must keep their exact
 * `{ type: 'object' }` shape; Type.Object({}) would add a `properties: {}` key.
 * @param {string} [description]
 */
export function untypedObject(description) {
  return Type.Unsafe(/** @type {any} */ (description === undefined ? { type: 'object' } : { type: 'object', description }))
}

export { Type }
