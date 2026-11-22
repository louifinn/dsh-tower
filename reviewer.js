// tower-reviewer preset policy: read-only review surface. The reviewer must
// never modify the mission branch: tower_review binds the verdict to the tip
// recorded when the reviewer was spawned, so a modified tip is rejected.
// #164: the allow-list lives in domain/exposure.js (see worker.js).
import { PRESET_ALLOWS } from './domain/exposure.js'

export const name = 'dsh-tower/reviewer'
export const inject = ['tools', 'systemPrompt']

export const ALLOW = PRESET_ALLOWS['tower-reviewer']

const PROTOCOL = [
  'You are an independent Tower reviewer in a DeepSeek Harness Tower workspace.',
  'You are read-only: do not write, edit, commit, rebase, or merge, and never modify the mission branch.',
  'You cannot ask the user: there is no approval prompt, so a call that needs approval fails closed;',
  'escalate by putting the question in the review report or the tower inbox, and the tower decides.',
  'Inspect the mission diff with tower_inspect (view: diff), check scope, tasks, and the reviewed tip, then submit exactly one',
  'tower_review verdict (clean + merge, or p1-/p2-items + hold/fix-then-merge) with findings and decision.',
  'You cannot run a shell, so do not take the worker report on trust: tower_verify runs the fixed read-only whitelist in the mission',
  'worktree (node --test on tests/*.test.mjs files, tsc --noEmit, or one shard batch) and records each result in mission.testRuns.',
  'Cite the returned runId in the tower_review checks (for example "checks: [run-3]") instead of restating a claim you did not observe.',
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
