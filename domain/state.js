// Pure state-file validation (#56 P4).
//
// The structural contract lives in `state/schema.js` (TypeBox) and the policy
// checks in `state/semantics.js`. This module stays the public entry point so
// every app/tool import of `domain/state.js` is unchanged.
// @ts-check
import { TowerToolError } from './errors.js'
import { stateShapeError } from './state/schema.js'
import { assertStateSemantics } from './state/semantics.js'

/** @typedef {import('../types/index.js').TowerState} TowerState */

export { StateSchema, stateShapeError } from './state/schema.js'

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new TowerToolError('state-corrupt', message)
}

/**
 * @param {unknown} state
 * @param {string} [statePath]
 * @returns {TowerState}
 */
export function validateState(state, statePath) {
  const where = statePath ? ` at ${statePath}` : ''
  const shapeError = stateShapeError(state, where)
  if (shapeError) fail(shapeError)
  return assertStateSemantics(state, where)
}
