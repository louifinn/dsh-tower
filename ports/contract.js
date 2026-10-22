// Port contract primitives (#69).
//
// A port is a runtime-checkable contract, not only a JSDoc typedef: the
// contract object is importable, and `assertPort` rejects a dependency object
// that does not implement it. That is what makes the seam substitutable at
// runtime instead of merely documented.
export function definePort(name, methods) {
  return Object.freeze({ name, methods: Object.freeze([...methods]) })
}

/**
 * @param {unknown} impl
 * @param {{ name: string, methods: readonly string[] }} contract
 * @param {string} [label]
 */
export function assertPort(impl, contract, label = contract.name) {
  if (!impl || typeof impl !== 'object') {
    throw new TypeError(`${label}: expected an object implementing ${contract.name}`)
  }
  const missing = contract.methods.filter((method) => typeof (/** @type {any} */ (impl))[method] !== 'function')
  if (missing.length > 0) {
    throw new TypeError(`${label} does not implement ${contract.name}; missing: ${missing.join(', ')}`)
  }
  return impl
}

/**
 * @param {unknown} impl
 * @param {{ name: string, methods: readonly string[] }} contract
 */
export function implementsPort(impl, contract) {
  try {
    assertPort(impl, contract)
    return true
  } catch {
    return false
  }
}
