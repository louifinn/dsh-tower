// The shipped tool surface, derived from the Host entry (#118).
//
// `scripts/surface-baseline.mjs` and `scripts/generate-tools-reference.mjs` must
// measure the tools the plugin actually registers — including `tower_mode` and
// `tower_control`, which `index.js` registers directly instead of through the
// `define()` path. Loading the real `apply()` with a minimal Cordis context
// means the measurement cannot drift from the shipped surface again.
import os from 'node:os'
import path from 'node:path'
import { apply } from '../../index.js'
import { definedToolNames, registerAllCapabilities, __testResetToolSurface } from '../../host/tool-registry.js'

/**
 * Apply the real Host entry against a recording mock context.
 *
 * @returns {{
 *   names: string[],
 *   definitions: Map<string, any>,
 *   dispose: () => void,
 * }}
 *   `names` is the recorded surface (the same source `tower_doctor` reads);
 *   `definitions` is every tool the default profile actually registered.
 */
export function loadShippedToolSurface() {
  const definitions = new Map()
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    get() {
      return undefined
    },
    provide() {},
    inject(_deps, callback) {
      callback(ctx)
    },
    on() {
      return () => {}
    },
    logger: { warn() {} },
    tools: {
      register(definition) {
        if (definition && typeof definition.name === 'string') definitions.set(definition.name, definition)
        return () => {}
      },
      guard() {
        return () => {}
      },
      restrict() {
        return () => {}
      },
    },
    systemPrompt: { section() {} },
    commands: {
      register() {
        return () => {}
      },
    },
  }
  // Keep the mode store out of the operator's real $DSH_HOME. The path is only
  // read (a missing modes.json is an empty mode set); nothing is written.
  // #121: the host entry registers only the mandatory surface; the shipped
  // profile mounts the optional capability rows. The concept budget measures the
  // *build* surface, so the all-capabilities aggregate is applied on top.
  __testResetToolSurface()
  apply(ctx, { mode: { storePath: path.join(os.tmpdir(), 'dsh-tower-surface-check') } })
  registerAllCapabilities(ctx)
  const names = definedToolNames()
  return {
    names,
    definitions,
    dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // a recorder fixture must still exit when a disposer fails
        }
      }
    },
  }
}
