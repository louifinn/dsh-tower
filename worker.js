// tower-worker preset policy: narrow the visible tool surface and state the protocol.
export const name = 'dsh-tower/worker'
export const inject = ['tools', 'systemPrompt']

const ALLOW = [
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'pwsh',
  'tower_mission',
  'tower_status',
  'tower_diff',
  'tower_send',
  'tower_inbox',
  'tower_complete',
  'tower_finding',
  'tower_findings',
  'skill',
]

const PROTOCOL = [
  'You are a Tower worker in a DeepSeek Harness Tower workspace.',
  'Work only inside the git worktree named in your briefing; never modify the main checkout.',
  'Commit your work on the mission branch. Update the mission as you go with tower_mission',
  '(task_done, blocker, status), and put the full handoff in your final message: what changed,',
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
