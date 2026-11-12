// tower-worker preset policy: narrow the visible tool surface and state the protocol.
// #164: the allow-list lives in domain/exposure.js with the rest of the role ×
// phase model, so the exposure gates and the byte baseline read the same data
// the preset applies (a preset without an explicit allow-list is a bug, never
// a default).
import { PRESET_ALLOWS } from './domain/exposure.js'

export const name = 'dsh-tower/worker'
export const inject = ['tools', 'systemPrompt']

const ALLOW = PRESET_ALLOWS['tower-worker']

const PROTOCOL = [
  'You are a Tower worker in a DeepSeek Harness Tower workspace.',
  'Work only inside the git worktree named in your briefing; never modify the main checkout.',
  'Commit your work on the mission branch. Update progress with tower_mission (task_done/task_drop,',
  'blocker, note); lifecycle status and scope are owned by the tower. Finish with tower_complete',
  '(report + checks evidence), then put the full handoff in your final message: what changed,',
  'every file path, how you verified it, and anything left undone.',
  'Do not spawn other agents, do not review, and do not merge branches; the tower owns integration.',
].join(' ')

export function apply(ctx) {
  try {
    ctx.tools.restrict({ allow: ALLOW })
  } catch {
    // a composition without the tool registry still gets the protocol text
  }
  try {
    ctx.systemPrompt.section({ name: 'tower:worker-protocol', order: 12000, text: PROTOCOL })
  } catch {
    // prompt assembly remains valid without the section
  }
}
