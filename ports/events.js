// Domain-event port (#75).
//
// The app layer persists a transition and then emits the domain events it
// described through this port. The host binds it to Cordis `ctx.emit`; tests
// bind it to a recorder. `emit` is best effort by contract: a listener (or a
// missing service) must never fail the tool that produced the fact.
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} EventPort
 * @property {(name: string, payload: Record<string, any>) => void} emit
 */

export const EVENT_PORT = definePort('EventPort', ['emit'])

/** @param {unknown} impl */
export function assertEventPort(impl) {
  return /** @type {EventPort} */ (assertPort(impl, EVENT_PORT, 'events'))
}

/** The no-op default: embedders without an event channel still get a Tower. */
export const NOOP_EVENT_PORT = Object.freeze({
  emit() {},
})
