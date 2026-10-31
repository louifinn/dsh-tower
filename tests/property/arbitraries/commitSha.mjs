// Arbitraries for Git identity values: full/short object ids, branch names and
// the `refs/heads/...` snapshot ref stored in state.json.
//
// fast-check v4 dropped the `hexaString` helper, so the hex digits are spelled
// out here; a 40-character lower-case hex string is the only shape git writes.
import fc from 'fast-check'

const HEX_DIGIT = fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f')

const hexArray = (length) => fc.array(HEX_DIGIT, { minLength: length, maxLength: length })

/** A full SHA-1 object id: 40 lower-case hex characters. */
export const commitShaArb = hexArray(40).map((digits) => digits.join(''))

/** An abbreviated object id, as printed by `git rev-parse --short`. */
export const shortCommitShaArb = fc
  .integer({ min: 7, max: 12 })
  .chain((length) => hexArray(length))
  .map((digits) => digits.join(''))

const slugSegmentArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,15}$/)

/**
 * A `tower/<mission>-<slug>` style branch name. The tower creates
 * `tower/m<n>-<slug>`; reviewers may be pointed at `feat/` or `fix/` too.
 */
export const branchNameArb = fc
  .tuple(fc.constantFrom('tower', 'feat', 'fix', 'review', 'mission'), fc.array(slugSegmentArb, { minLength: 1, maxLength: 3 }))
  .map(([prefix, segments]) => `${prefix}/${segments.join('-')}`)

/** `refs/heads/<branch>`, the form stored in `snapshotRef`. */
export const snapshotRefArb = branchNameArb.map((branch) => `refs/heads/${branch}`)
