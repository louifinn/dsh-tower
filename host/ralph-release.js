// Activity-log record of the Ralph release at Tower entry (#162 D2).
//
// Entering Tower mode with a live Ralph loop stops the loop (the rounds are
// refused from then on); what was released is recorded in the repository's
// activity log so a person can see the loop Tower cut short. The record is
// best-effort: a mode change must never fail because an uninitialized
// repository (or an unreadable state dir) cannot take the entry.
import { openTowerFor } from './mode-state.js'

/**
 * Append the release entry for one reconciled loop. Never throws.
 * @param {object} agent the towered session's live agent (for repo resolution)
 * @param {{ at: number, rounds: number, runs: number } | null} released
 * @returns {Promise<{ recorded: boolean, reason?: string }>}
 */
export async function recordRalphRelease(agent, released) {
  if (!released) return { recorded: false, reason: 'no live loop at entry' }
  try {
    const tower = await openTowerFor(agent)
    await tower.appendActivity({
      at: released.at,
      type: 'mode',
      text: `released a live Ralph loop on Tower entry (${released.rounds} round agent(s) recorded${
        released.runs > 0 ? `, ${released.runs} workflow run(s)` : ''
      }); its rounds are refused while Tower mode is active`,
    })
    return { recorded: true }
  } catch (error) {
    return { recorded: false, reason: String(error?.message ?? error) }
  }
}
