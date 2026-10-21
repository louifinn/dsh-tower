// Shared TypeBox helpers for tool input schemas (#45).
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

export { Type }
