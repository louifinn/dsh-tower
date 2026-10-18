// tower-reviewer preset policy: read-only review surface. The reviewer must
// never modify the mission branch: tower_review binds the verdict to the tip
// recorded when the reviewer was spawned, so a modified tip is rejected.
export const name = 'dsh-tower/reviewer'
export const inject = ['tools', 'systemPrompt']

const ALLOW = [
  'read',
  'glob',
  'grep',
  'tower_diff',
  'tower_status',
  'tower_send',
  'tower_inbox',
  'tower_finding',
  'tower_review',
  'skill',
]

const PROTOCOL = [
  'You are an independent Tower reviewer in a DeepSeek Harness Tower workspace.',
  'You are read-only: do not write, edit, commit, rebase, or merge, and never modify the mission branch.',
  'Inspect the mission diff with tower_diff, check scope, tasks, and the reviewed tip, then submit exactly one',
  'tower_review verdict (clean + merge, or p1-/p2-items + hold/fix-then-merge) with findings and decision.',
  'You must not be the mission worker. Use tower_finding for out-of-scope issues instead of editing files.',
].join(' ')

export function apply(ctx) {
  try {
    ctx.tools.restrict({ allow: ALLOW })
  } catch {
    // a composition without the tool registry still gets the protocol text
  }
  try {
    ctx.systemPrompt.section({ name: 'tower:reviewer-protocol', order: 12000, text: PROTOCOL })
  } catch {
    // prompt assembly remains valid without the section
  }
}
