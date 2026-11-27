// State and activity writes for a merge whose Git side already ran (#51, #228).
//
// Shared by `app/merge.js` and `app/merge-record.js`: both phases reach the same
// point, where the merge commit is a Git fact and a refused document write must
// say so instead of reading like the merge itself failed.
// @ts-check
import { TowerToolError } from '../domain/errors.js'

/**
 * Restate a `state-io-failed` as "what happened in Git, and what is only
 * missing". The adapter's own note describes the document, not the merge.
 * @param {any} error
 * @param {string} sentence what the caller can and cannot conclude
 */
export function rethrowStateIo(error, sentence) {
  const body = String(error.message)
    .replace(/^\[tower:[^\]]+\]\s*/, '')
    .replace(/ — next: [\s\S]*$/, '')
  return new TowerToolError(error.code, `${body} — ${sentence}`, {
    cause: error.cause ?? error,
    retryable: false,
    details: error.details,
  })
}

/**
 * Write the state record of a merge that already ran in Git.
 * @param {any} tower
 * @param {any} state
 * @param {any} held
 * @param {string} sentence what happened in Git and what is left to do
 */
export async function writeStateAfterGit(tower, state, held, sentence) {
  try {
    return await tower.writeState(state, held)
  } catch (error) {
    if (error?.code !== 'state-io-failed') throw error
    throw rethrowStateIo(error, sentence)
  }
}

/**
 * Append the activity line of a merge that already landed.
 * @param {any} tower
 * @param {any} entry
 * @param {string} sentence what landed and what is only missing
 */
export async function appendActivityAfterGit(tower, entry, sentence) {
  try {
    return await tower.appendActivity(entry)
  } catch (error) {
    if (error?.code !== 'state-io-failed') throw error
    throw rethrowStateIo(error, sentence)
  }
}

/**
 * #228: the merge commit is already in Git when this runs, so a refused state
 * write must never look like a landed merge.
 * @param {any} tower
 * @param {any} state
 * @param {any} held
 * @param {string} newTip
 */
export async function writeMergeRecord(tower, state, held, newTip) {
  return writeStateAfterGit(
    tower,
    state,
    held,
    `the merge commit ${newTip.slice(0, 12)} exists in Git but Tower could not record it, so this merge did not land in the mission state and must be re-run`,
  )
}
