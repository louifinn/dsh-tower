// The tool contract map and the live registered surface must not drift (#M62).
//
// `ToolInputs` in domain/contracts/tool-inputs/index.js is the named input
// schema for every define()-registered tool. The host applies
// `JSON.parse(JSON.stringify(parameters))`, so a deep comparison against the
// live registration proves the tool module passed *its* contract, not a copy.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolInputs } from '../domain/contracts/tool-inputs/index.js'
import { loadShippedToolSurface } from '../scripts/lib/tool-surface.mjs'

// index.js registers these two directly with inline schemas (they are session
// tools, not repository tools); the rest must all have a named input contract.
const SESSION_TOOLS = ['tower_mode']

test('every shipped repository tool registers the schema from ToolInputs', () => {
  const surface = loadShippedToolSurface()
  try {
    const registered = [...surface.definitions.keys()]
    assert.deepEqual(
      registered.filter((name) => !SESSION_TOOLS.includes(name)).sort(),
      Object.keys(ToolInputs).sort(),
      'registered repository tools must have exactly one input contract each',
    )
    for (const [name, input] of Object.entries(ToolInputs)) {
      const definition = surface.definitions.get(name)
      assert.ok(definition, `${name} was not registered`)
      assert.deepEqual(definition.parameters, JSON.parse(JSON.stringify(input)), `${name} parameters drifted from ToolInputs`)
    }
    for (const name of SESSION_TOOLS) {
      assert.ok(surface.definitions.get(name), `${name} was not registered`)
      assert.equal(typeof surface.definitions.get(name).parameters, 'object')
    }
  } finally {
    surface.dispose()
  }
})
