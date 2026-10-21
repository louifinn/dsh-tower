// Public tool wiring for the DSH Host plugin.
// 
// Registration contract:
// - define(ctx, definition) accepts a TypeBox parameters schema;
// - execute(args) is typed from that schema by Static<>;
// - aliases and requiresMissionId are honored by the registry;
// - operational switches decide whether a tool is registered;
// - errors are classified to stable [tower:code] values;
// - tools must not import node:fs or node:child_process directly.
// 
// Tests import this module for the public surface; they may also
// import lib/tool-registry.js for low-level test hooks.
// 
// Packaging: package.json ships tools/*.js and lib/tool-registry.js.
// The file intentionally stays tiny so handler modules remain the
// only place where a tool is defined.
// Keep this comment and the re-export list in sync when adding tools.
// See docs/reference/tools.generated.md for the generated list.
// Tower tool surface — thin public wiring (#56).
// 
// The registration aggregator, guards, rate limits, spawn backoff,
// repository preparation, discovery helpers, and verb helpers live in
// lib/tool-registry.js. This module only re-exports the public entry
// points consumed by the Host plugin, tests, and docs generators.
// 
// Design rules:
// - one handler module per tool under tools/;
// - tool schemas live in domain/contracts/tool-inputs;
// - vocabulary lives in domain/vocabulary.js;
// - no business logic in this file;
// - keep the surface stable for index.js and tests.
// 
// See docs/architecture/overview.md and lib/tool-registry.js.
// Tower tool surface: thin public wiring (#56 P5).
// Registration and shared machinery live in lib/tool-registry.js; one handler
// module per tool lives under tools/. This file only exposes the public entry
// points consumed by the Host plugin, tests, and documentation generators.
export { registerTowerTools, __testSpawnBackoff } from '../lib/tool-registry.js'
export { workerBriefing, reviewerBriefing } from '../lib/briefing.js'
