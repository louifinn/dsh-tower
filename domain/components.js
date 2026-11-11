// Component-surface policy (#120): who may be switched off, recorded as data.
//
// Principle 11 says optional capabilities are switches and the core is not. This
// module is that policy as data plus the pure checks over it: the component rows
// in `cordis.patch.yml`, the four-way classification of every config key, and
// the forbidden-to-disable capabilities (host, health, recovery, merge gates)
// that no group, row or boolean key may gate. The review policy is not one of
// those never-switches: `review.mode` is the one tri-state control, and only the
// gate it turns on in `required` mode (evidence, tip binding, exemption path) is
// non-disableable.
//
// The single source of truth is `scripts/component-surface.json`. The generated
// reference `docs/reference/component-surface.md` is a rendering of it, so
// "should this be a component?" is a table lookup rather than a judgement call.
//
// This module is pure: no fs, no git. `scripts/check-components.mjs` supplies the
// live schema, `cordis.patch.yml`, the locale files and the baseline.
//
// #138: the class/row-override rules live in `component-rules.js` so this module
// stays under the architecture aggregate-size brake; they are re-exported here.
//
// W5-A: the schema/parse helpers live in `component-surface.js`, the parity and
// denylist rules in `component-rules.js`, and the locale/meta checks in
// `component-locale.js`; this file is the stable re-export facade.
export {
  COMPONENT_CLASSES,
  COMPONENT_KINDS,
  COMPONENT_PATCH_FILES,
  COMPONENT_REFERENCE_FILE,
  COMPONENT_SCHEMA_VERSION,
  COMPONENT_SCOPES,
  COMPONENT_SURFACE_FILE,
  LOCALE_FIELDS,
  LOCALE_FILES,
  META_LABEL_PATCHES,
  META_LOCALE_FILES,
  mergeCordisPatches,
  parseComponentSurface,
  parseCordisPatch,
  renderComponentSurface,
} from './component-surface.js'
export {
  checkForbidden,
  checkKeyClassifications,
  checkRowOverrides,
  validateComponentSurface,
} from './component-rules.js'
export {
  checkGroupLabelCoverage,
  checkLocaleCoverage,
  checkMetaLabelCoverage,
} from './component-locale.js'
