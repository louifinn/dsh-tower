// Case-insensitive-filesystem detection (#90).
//
// On Windows and macOS the checkout's filesystem folds case, while Git reports
// the casing stored in the index. Scope matching has to know which world it is
// in, so `tower_init` probes once and records the answer in state.
//
// The probe creates one uniquely-named mixed-case file in the checkout root
// (the filesystem scope matching actually compares) and looks its lower-cased
// name up. It returns:
//   true   the lookup found the file: the filesystem folds case;
//   false  the lookup was ENOENT: the filesystem is case-sensitive;
//   null   the probe could not run (read-only checkout, EPERM, an unexpected
//          stat failure). "Unknown" is deliberately not "case-sensitive": init
//          keeps working and `tower_doctor` reports the safe default.
import path from 'node:path'
import { fsp } from './store-fs.js'

/** Prefix is public so tests and support code can recognise a leaked probe. */
export const CASE_PROBE_PREFIX = '.tower-case-probe-'

/**
 * A name that is guaranteed to differ from its lower-cased form, so the lookup
 * actually distinguishes the two filesystem behaviours.
 * @param {() => number} random
 * @returns {string}
 */
function probeName(random) {
  return `${CASE_PROBE_PREFIX}Z${random().toString(36).slice(2, 10)}`
}

/**
 * @param {string} dir directory on the filesystem under test
 * @param {{ fs?: typeof fsp, name?: string, random?: () => number }} [options]
 *   `fs` is a seam for the failure branches, which cannot be produced portably
 *   by permissions on every OS (Windows does not honour chmod the way POSIX does).
 * @returns {Promise<boolean | null>}
 */
export async function detectCaseSensitivity(dir, options = {}) {
  const fs = options.fs ?? fsp
  const name = options.name ?? probeName(options.random ?? Math.random)
  const probePath = path.join(dir, name)
  const lowerPath = path.join(dir, name.toLowerCase())
  if (lowerPath === probePath) return null

  try {
    await fs.writeFile(probePath, '')
  } catch {
    return null
  }

  try {
    await fs.stat(lowerPath)
    return true
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code
    return code === 'ENOENT' ? false : null
  } finally {
    // Best effort: a leaked probe would dirty `git status` of the state dir and
    // the detection result is already known.
    try {
      await fs.unlink(probePath)
    } catch {
      // the probe file may already be gone (or the failure branch never wrote it)
    }
  }
}
