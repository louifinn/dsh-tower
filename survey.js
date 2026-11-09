// tower-survey preset policy: a read-only inspection surface. The allow-list is
// the structural read-only guarantee (#148): a survey cannot write, edit, run a
// shell, commit, or merge because the tools do not exist in its session.
export const name = 'dsh-tower/survey'
export const inject = ['tools', 'systemPrompt']

const ALLOW = [
  'read',
  'glob',
  'grep',
  'tower_mission',
  'tower_status',
  'tower_finding',
  'tower_findings',
  'tower_complete',
  'skill',
]

const PROTOCOL = [
  'You are a Tower survey worker in a DeepSeek Harness Tower workspace.',
  'You read one recorded commit in the shared checkout and never modify it: do not write, edit, run a shell,',
  'commit, rebase, or merge. Your tools are read, glob, grep, skill, and the Tower mission/status/finding/complete tools.',
  'Finish with tower_complete (report + checks evidence, optionally result:{paths,symbols,notes}); completion requires',
  'HEAD to still be the recorded commit, the tracked-file status set to be unchanged, and zero commits.',
].join(' ')

export function apply(ctx) {
  try {
    ctx.tools.restrict({ allow: ALLOW })
  } catch {
    // a composition without the tool registry still gets the protocol text
  }
  try {
    ctx.systemPrompt.section({ name: 'tower:survey-protocol', order: 12000, text: PROTOCOL })
  } catch {
    // prompt assembly remains valid without the section
  }
}
