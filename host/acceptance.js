// Human acceptance of an artifact mission's committed tip (#159 D3).
//
// Acceptance is the one mission decision no agent may make. The tower agent
// asks through the DSH userQuestions service — the same human approval channel
// an ownership takeover uses — and only a human selection of the accept option
// reaches the domain as a recorded acceptance. A profile without the channel is
// refused (`approval-unavailable`): a non-interactive session never
// auto-accepts, and there is no tool argument that could record an
// agent-initiated acceptance instead.
import { TowerToolError } from '../domain/errors.js'
import { assertAcceptableMission } from '../domain/missions/lifecycle.js'
import { shapeFor } from '../domain/shapes/index.js'

/** The option label the human must select; anything else records nothing. */
const ACCEPT_OPTION = 'Accept the committed tip'

/**
 * Ask the human to accept one artifact mission's committed tip.
 *
 * @param {any} ctx the Cordis context (owns the userQuestions service)
 * @param {any} exec the tool execution (agent + signal for the question)
 * @param {{ tower: any, missionId: string, note?: string | null }} input
 * @returns {Promise<{ approved: boolean, cancelled?: boolean, tip: string, missionId: string }>}
 *   `approved` is true only when the human selected the accept option; a
 *   cancelled question reports `cancelled` and records nothing.
 */
export async function requestHumanAcceptance(ctx, exec, { tower, missionId, note }) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === missionId)
  if (!mission) {
    throw new TowerToolError('mission-not-found', `unknown mission "${missionId}"`)
  }
  const shape = shapeFor(mission.kind)
  // The same admission the domain records with, asked *before* the human sees
  // a question: a non-acceptance shape or a branchless mission has nothing a
  // human could accept, and the human must not be asked first.
  assertAcceptableMission(mission, shape)
  const tip = await tower.branchTip(mission)
  const artifacts = /** @type {string[]} */ (/** @type {any} */ (mission).artifacts ?? [])
  const questions = ctx?.get?.('userQuestions')
  if (!questions || typeof questions.ask !== 'function') {
    throw new TowerToolError(
      'approval-unavailable',
      'artifact acceptance needs the DSH userQuestions service, which this profile does not expose; an acceptance is never auto-recorded',
    )
  }
  /** @type {any} */
  let answer
  try {
    answer = await questions.ask({
      agent: exec.agent,
      signal: exec.signal,
      questions: [
        {
          id: 'tower-acceptance',
          header: 'Artifact acceptance',
          question: `Accept mission ${mission.id} — ${mission.title} — at tip ${tip.slice(0, 12)}?`,
          detail: acceptanceQuestionDetail({ mission, tip, note }),
          options: [
            {
              label: ACCEPT_OPTION,
              description: 'Record the human acceptance of the whole committed tip; the merge gate then allows the merge.',
            },
            { label: 'Keep unaccepted', description: 'Record nothing; the mission stays completed and unmergeable.' },
          ],
        },
      ],
    })
  } catch (error) {
    const code = error?.cause?.code ?? error?.code
    if (code === 'ASK_CANCELLED') {
      exec.concludeTurn?.()
      return { approved: false, cancelled: true, tip, missionId }
    }
    throw error
  }
  const list = Array.isArray(answer?.answers) ? answer.answers : Array.isArray(answer) ? answer : []
  const choice = list.find((item) => item?.id === 'tower-acceptance')
  const selected = Array.isArray(choice?.selected) ? choice.selected : []
  const approved = selected.length === 1 && selected[0] === ACCEPT_OPTION && !choice?.custom
  return { approved, cancelled: false, tip, missionId }
}

/**
 * The read-only detail shown under the question: what the deliverables are,
 * which tip is being accepted, and that acceptance covers the whole tip, not
 * only the listed artifacts (#159 D3).
 * @param {{ mission: any, tip: string, note?: string | null }} input
 * @returns {string}
 */
export function acceptanceQuestionDetail({ mission, tip, note }) {
  const artifacts = /** @type {string[]} */ (mission.artifacts ?? [])
  const lines = [
    `Accepting commits the merge: the acceptance covers the whole committed tip ${tip.slice(0, 12)}, not only the listed deliverables.`,
    `Declared deliverables: ${artifacts.join(', ') || '(none)'}`,
  ]
  if (typeof note === 'string' && note.trim().length > 0) lines.push(`Note: ${note.trim()}`)
  return lines.join('\n')
}
