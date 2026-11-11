// Tower tool registry facade (W5-A).
//
// Per-tool handlers live in tools/*.js; the runtime/dispatch primitive lives in
// `host/tool-runtime.js`, the registration aggregators in
// `host/tool-capabilities.js`, and the cross-cutting observers in
// `host/tool-observers.js`. This module is the stable public name surface the
// Host entry, capability rows, tools/index.js and the tests import; every
// re-export and its registration order is unchanged from the single-file
// module this replaces.
export {
  __testResetToolSurface,
  __testSpawnBackoff,
  authorizeSessionCall,
  definedToolCount,
  definedToolNames,
  OPERATIONAL_TOOLS,
  recordToolRegistration,
} from './tool-runtime.js'
export {
  registerAllCapabilities,
  registerBatchCapability,
  registerCoreTowerTools,
  registerHmrCapability,
  registerImportCapability,
  registerLeasesCapability,
  registerTestsCapability,
  registerTowerTools,
} from './tool-capabilities.js'
