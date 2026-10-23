// File-reading wrapper around the pure concept-budget surface (#84).
//
// `domain/surface.js` owns the rules; this module owns the two files they read
// (`scripts/surface-baseline.json` and `docs/reference/surface-budget.md`) and
// the combined check used by the CLI gate and the tests.
import fs from 'node:fs'
import path from 'node:path'
import {
  SURFACE_BASELINE_FILE,
  SURFACE_CLASSIFICATION_FILE,
  parseBaseline,
  validateBaseline,
  validateClassification,
} from '../../domain/surface.js'

/**
 * @param {string} root repository root
 * @returns {ReturnType<typeof parseBaseline>}
 */
export function readBaseline(root) {
  const file = path.join(root, SURFACE_BASELINE_FILE)
  return parseBaseline(fs.readFileSync(file, 'utf8'))
}

/**
 * @param {string} root repository root
 */
export function readClassification(root) {
  return fs.readFileSync(path.join(root, SURFACE_CLASSIFICATION_FILE), 'utf8')
}

/**
 * Run both halves of the concept-budget gate against one repository root.
 * `current` carries the live counts and the live key/tool names.
 *
 * @param {{ root: string, current: { configKeys: number, sections: number, tools: number, liveNames: { configKeys: string[], sections: string[], tools: string[] } } }} options
 */
export function checkSurfaceBudget({ root, current }) {
  let baseline
  try {
    baseline = readBaseline(root)
  } catch (error) {
    return {
      ok: false,
      baseline: null,
      classification: null,
      findings: [
        {
          code: 'baseline-unreadable',
          level: 'error',
          message: `${SURFACE_BASELINE_FILE} is unreadable: ${String(error?.message ?? error)}`,
        },
      ],
    }
  }
  const findings = validateBaseline(baseline, current, {
    exists: (relative) => fs.existsSync(path.join(root, relative)),
  })
  let classificationText
  try {
    classificationText = readClassification(root)
  } catch (error) {
    return {
      ok: false,
      baseline,
      classification: null,
      findings: [
        ...findings,
        {
          code: 'classification-unreadable',
          level: 'error',
          message: `${SURFACE_CLASSIFICATION_FILE} is unreadable: ${String(error?.message ?? error)}`,
        },
      ],
    }
  }
  const classification = validateClassification(classificationText, current.liveNames, {
    baselineDate: baseline.date,
  })
  const all = [...findings, ...classification.findings]
  return {
    ok: all.length === 0,
    baseline,
    classification,
    findings: all,
  }
}
