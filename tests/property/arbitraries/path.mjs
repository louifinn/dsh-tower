// Arbitraries for paths and scope globs.
//
// Two families exist on purpose:
//   * `scopeEntryArb` and `scopeArb` build values `normalizeScope` accepts:
//     relative, never absolute, never carrying a `..` segment.
//   * `parentTraversalScopeEntryArb` and `absoluteScopeEntryArb` build the
//     values it must reject, so the rejection half is property-tested too.
//
// Everything is a string; no generator touches the filesystem.
import fc from 'fast-check'

const SEPARATORS = ['/', '\\', 'mixed']

const relativeSegmentArb = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,14}$/)

const fileSegmentArb = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,12}\.(mjs|cjs|js|json|md)$/)

/** A directory segment that also exercises glob syntax. */
const globSegmentArb = fc.oneof(
  { weight: 4, arbitrary: relativeSegmentArb },
  { weight: 1, arbitrary: fc.constant('**') },
  { weight: 1, arbitrary: fc.constant('*') },
  { weight: 1, arbitrary: fc.constant('*.test.mjs') },
  { weight: 1, arbitrary: fc.constant('?.prop.mjs') },
)

/**
 * Join segments with a fixed separator. `mixed` alternates `/` and `\` so the
 * `\` -> `/` normalization of `normalizeScope` is exercised, not assumed.
 * @param {string[]} segments
 * @param {string} separator
 * @returns {string}
 */
function joinSegments(segments, separator) {
  let out = segments[0]
  for (let index = 1; index < segments.length; index += 1) {
    const joiner = separator === 'mixed' ? (index % 2 === 1 ? '\\' : '/') : separator
    out += joiner + segments[index]
  }
  return out
}

/**
 * One relative scope entry. Covers `**`, trailing separators, `./` and `.\\`
 * prefixes, and both separator styles; it never starts with `/` or a drive
 * letter and never contains `..`.
 */
export const scopeEntryArb = fc
  .record({
    prefix: fc.constantFrom('', './', '.\\', 'src/'),
    segments: fc.array(globSegmentArb, { minLength: 1, maxLength: 4 }),
    separator: fc.constantFrom(...SEPARATORS),
    trailingSeparator: fc.boolean(),
  })
  .map(({ prefix, segments, separator, trailingSeparator }) => {
    const trailing = trailingSeparator ? (separator === 'mixed' ? '/' : separator) : ''
    return `${prefix}${joinSegments(segments, separator)}${trailing}`
  })

/** A mission scope array. Empty is legal for `kind:"survey"`. */
export const scopeArb = fc.array(scopeEntryArb, { maxLength: 4 })

/** A relative file path, as a scope matcher sees it. */
export const filePathArb = fc
  .array(relativeSegmentArb, { minLength: 0, maxLength: 3 })
  .chain((directories) => fileSegmentArb.map((file) => [...directories, file].join('/')))

/** An absolute POSIX path (`/tmp/dsh-tower/...`). */
export const posixPathArb = fc
  .array(relativeSegmentArb, { minLength: 2, maxLength: 5 })
  .map((segments) => `/${segments.join('/')}`)

/** An absolute Windows path (`C:\Users\...`). */
export const win32PathArb = fc
  .tuple(fc.constantFrom('C', 'D', 'E'), fc.array(relativeSegmentArb, { minLength: 1, maxLength: 4 }))
  .map(([drive, segments]) => `${drive}:\\${segments.join('\\')}`)

/** A path as stored in a mission worktree record, on either platform. */
export const worktreePathArb = fc.oneof(posixPathArb, win32PathArb)

/**
 * A relative entry that carries a `..` segment. `normalizeScope` must reject
 * these rather than resolve them, so this is the negative generator.
 */
export const parentTraversalScopeEntryArb = fc
  .tuple(fc.array(relativeSegmentArb, { maxLength: 2 }), fc.array(relativeSegmentArb, { maxLength: 2 }))
  .map(([before, after]) => [...before, '..', ...after].join('/'))

/** An absolute entry (`/...` or `X:\...`). `normalizeScope` must reject these too. */
export const absoluteScopeEntryArb = fc.oneof(posixPathArb, win32PathArb)
