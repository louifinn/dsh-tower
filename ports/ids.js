// Ids port (#69).
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} IdsPort
 * @property {() => string} uuid
 * @property {(text: string) => string} shortHash
 */

export const IDS_PORT = definePort('IdsPort', ['uuid', 'shortHash'])

/** @param {unknown} impl */
export function assertIdsPort(impl) {
  return /** @type {IdsPort} */ (assertPort(impl, IDS_PORT, 'ids'))
}
