// Generate the published type vocabulary from the runtime constants (#115).
//
// `types/index.d.ts` is the shipped type surface (`package.json` `types`). Its
// status/type/role/error unions used to be a hand-copied second declaration of
// constants that live in domain/; this generator makes the runtime the single
// source: the marked block is rewritten from ERROR_CODES, MISSION_STATUSES,
// REVIEW_STATUSES, MERGE_VERDICTS, MISSION_KINDS, REVIEW_POLICIES, FINDING_*,
// ROLES and PAUSE_CAUSES. It is the type-surface sibling of the four
// `docs:generate:*` generators and shares their `--check` contract.
//
// Usage: node scripts/generate-types.mjs [--check]
//
// The block is delimited by `// generated:vocabulary:start` / `:end` in
// types/index.d.ts; the prose around it is hand-written. A missing marker is a
// configuration error, not a silent no-op.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ERROR_CODES } from '../domain/errors.js'
import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_TYPES,
  MERGE_VERDICTS,
  MISSION_STATUSES,
  PAUSE_CAUSES,
  REVIEW_STATUSES,
} from '../domain/mission.js'
import { MISSION_KINDS, REVIEW_POLICIES, ROLES } from '../domain/vocabulary.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(root, 'types', 'index.d.ts')
export const START = '// generated:vocabulary:start'
export const END = '// generated:vocabulary:end'

/** One published alias per runtime constant family, in declaration order. */
const DECLARATIONS = [
  { key: 'missionStatuses', name: 'MissionStatus' },
  { key: 'missionKinds', name: 'MissionKind' },
  { key: 'reviewStatuses', name: 'ReviewStatus', multiline: true },
  { key: 'mergeVerdicts', name: 'MergeVerdict' },
  { key: 'reviewPolicies', name: 'ReviewPolicy' },
  { key: 'findingTypes', name: 'FindingType' },
  { key: 'findingSeverities', name: 'FindingSeverity' },
  { key: 'findingStatuses', name: 'FindingStatus' },
  { key: 'roles', name: 'Role' },
  { key: 'pauseCauses', name: 'PauseCause' },
  { key: 'errorCodes', name: 'ErrorCode', multiline: true },
]

/** The runtime data the block is generated from. `--check` compares this exact input. */
export function vocabularyData() {
  return {
    missionStatuses: [...MISSION_STATUSES],
    missionKinds: [...MISSION_KINDS],
    reviewStatuses: [...REVIEW_STATUSES],
    mergeVerdicts: [...MERGE_VERDICTS],
    reviewPolicies: [...REVIEW_POLICIES],
    findingTypes: [...FINDING_TYPES],
    findingSeverities: [...FINDING_SEVERITIES],
    findingStatuses: [...FINDING_STATUSES],
    roles: [...ROLES],
    pauseCauses: [...PAUSE_CAUSES],
    errorCodes: Object.keys(ERROR_CODES),
  }
}

function renderDeclaration({ name, values, multiline = false }) {
  const quoted = values.map((value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
  const inline = `export type ${name} = ${quoted.join(' | ')}`
  if (!multiline && inline.length <= 120) return inline
  return [`export type ${name} =`, ...quoted.map((value) => `  | ${value}`)].join('\n')
}

/**
 * Render the marked block (markers excluded) for one vocabulary input.
 * @param {Record<string, string[]>} data
 * @returns {string}
 */
export function vocabularyBlock(data) {
  return DECLARATIONS.map((declaration) =>
    renderDeclaration({ ...declaration, values: data[declaration.key] }),
  ).join('\n')
}

/**
 * Replace the marked block in a declaration file. Removing or reordering the
 * markers is a hard error: a generated block that cannot be found would
 * otherwise pass every check while drifting.
 * @param {string} source
 * @param {string} block
 * @returns {string}
 */
export function injectVocabulary(source, block) {
  const start = source.indexOf(START)
  const end = source.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`types/index.d.ts is missing the ${START} / ${END} markers`)
  }
  return `${source.slice(0, start + START.length)}\n${block}\n${source.slice(end)}`
}

function main() {
  const source = fs.readFileSync(TARGET, 'utf8')
  const expected = injectVocabulary(source, vocabularyBlock(vocabularyData()))
  const codes = Object.keys(ERROR_CODES).length
  if (process.argv.includes('--check')) {
    if (source !== expected) {
      console.error('published type vocabulary is stale; run npm run types:generate')
      process.exit(1)
    }
    console.log(`type vocabulary: ${DECLARATIONS.length} aliases (${codes} error codes) in sync`)
  } else {
    fs.writeFileSync(TARGET, expected)
    console.log(`wrote ${path.relative(root, TARGET)} (${DECLARATIONS.length} aliases, ${codes} error codes)`)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main()
  } catch (error) {
    console.error(`type vocabulary: ${String(error?.message ?? error)}`)
    process.exit(1)
  }
}
