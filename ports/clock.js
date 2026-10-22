// Clock port (#69).
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} ClockPort
 * @property {() => number} now
 */

export const CLOCK_PORT = definePort('ClockPort', ['now'])

/** @param {unknown} impl */
export function assertClockPort(impl) {
  return /** @type {ClockPort} */ (assertPort(impl, CLOCK_PORT, 'clock'))
}
