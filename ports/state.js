// State-load port (#69): schema inspection, migration, and the one persisted
// migration result. The implementation is store-agnostic and receives the
// store port, so an in-memory store can drive the same load path.
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} StatePort
 * @property {(input: { store: unknown, paths: unknown, now?: number, persist?: boolean, migrations?: readonly unknown[] }) => Promise<any>} loadStateFile
 */

export const STATE_PORT = definePort('StatePort', ['loadStateFile'])

/** @param {unknown} impl */
export function assertStatePort(impl) {
  return /** @type {StatePort} */ (assertPort(impl, STATE_PORT, 'state'))
}
