// tower-survey-sandbox preset policy (#148 W2): a survey that reads in a
// disposable detached sandbox may write and run commands *inside that sandbox*,
// but it still owns no branch, never commits, and may not merge, rebase, review
// or spawn. The allow-list is the structural guarantee: the denied tools do not
// exist in the session, so a prompt cannot talk the agent into using them.
//
// The shared-checkout survey preset (`dsh-tower/survey`) stays strictly
// read-only; this module is mounted only for a detached sandbox.
// #164: the allow-list lives in domain/exposure.js (see worker.js).
import { PRESET_ALLOWS } from './domain/exposure.js'

export const name = 'dsh-tower/survey-sandbox'
export const inject = ['tools', 'systemPrompt']

const ALLOW = PRESET_ALLOWS['tower-survey-sandbox']

const PROTOCOL = [
  'You are a Tower survey worker reading one recorded commit in a disposable detached sandbox.',
  'Work only inside the sandbox path named in your briefing; never modify the main checkout.',
  'You may write files and run shell commands inside the sandbox, but do not commit: completion requires',
  'the sandbox HEAD to still be the recorded commit and zero new commits. The sandbox is removed when the mission completes.',
  'You cannot spawn, merge, rebase, review or diff. Acknowledge inbox mail with tower_inbox; unread messages block completion.',
  'Finish with tower_complete (report + checks evidence, optionally result:{paths,symbols,plan,notes}); the result is survey evidence only.',
].join(' ')

export function apply(ctx) {
  try {
    ctx.tools.restrict({ allow: ALLOW })
  } catch {
    // a composition without the tool registry still gets the protocol text
  }
  try {
    ctx.systemPrompt.section({ name: 'tower:survey-sandbox-protocol', order: 12000, text: PROTOCOL })
  } catch {
    // prompt assembly remains valid without the section
  }
}
