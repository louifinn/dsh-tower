// Stance-owner table (#162, shared with #161).
//
// Tower mode denies *stances*, not spellings: a component that owns an
// orchestration stance ("who owns this repository's writes, and who decides
// when the work is finished") is denied as a whole while Tower mode is active.
// Each row below is the one place that names that owner's registered surface
// (tools and commands); `mode.denyTools` and the command-surface guard both
// derive from this table, so a second implementation or a fallback name is a
// row edit, not a second hand-maintained list (#161 owns the agent-team row's
// drift and must extend this table instead of adding a parallel one).
//
// This module is pure data plus derivations: no fs, no host state.
/**
 * @typedef {object} StanceOwner
 * @property {string} owner The npm package that owns the stance.
 * @property {string} stance The orchestration stance it owns.
 * @property {readonly string[]} tools Tool names it registers (all documented variants).
 * @property {readonly string[]} [commands] Command names it registers (default names).
 * @property {string} [note] Boundary the row cannot express on its own.
 */

/** The components whose orchestration stance conflicts with Tower mode.
 * @type {ReadonlyArray<StanceOwner>} */
export const STANCE_OWNERS = Object.freeze([
  Object.freeze({
    owner: '@deepseek-ai/dsh-tool-goal',
    stance: 'goal',
    tools: Object.freeze(['create_goal']),
  }),
  Object.freeze({
    owner: '@deepseek-ai/dsh-tool-todo',
    stance: 'todo',
    tools: Object.freeze(['todo_write']),
  }),
  // #161 owns correcting this row: the hand-maintained literal it replaces
  // drifted in both directions (a stale name plus four missing team tools).
  // The row — not a second list — is where the corrected surface lands.
  Object.freeze({
    owner: '@deepseek-ai/dsh-experimental-tool-agent-team',
    stance: 'agent-team',
    tools: Object.freeze([
      'team_task_create',
      'team_task_update',
      'team_task_reopen',
      'team_task_list',
      'spawn_teammate',
      'wait_agent',
    ]),
    note: 'the six names carried from the pre-#162 deny literal; #161 reconciles this row with the nine tools the package actually registers',
  }),
  Object.freeze({
    owner: '@deepseek-ai/dsh-tool-workflow',
    stance: 'workflow',
    tools: Object.freeze(['workflow']),
  }),
  // The two Ralph implementations are one stance: a session-level loop that
  // claims the whole repository. Neither consults Tower, so exclusivity is
  // enforced from the Tower side at three layers — this name table, the
  // command-surface guard, and the loop sensor in host/ralph-stance.js.
  Object.freeze({
    owner: '@deepseek-ai/dsh-tool-ralph',
    stance: 'ralph-loop',
    tools: Object.freeze(['ralph']),
    commands: Object.freeze([]),
  }),
  Object.freeze({
    owner: 'dsh-ralph',
    stance: 'ralph-loop',
    tools: Object.freeze(['ralph', 'ralph_prd']),
    commands: Object.freeze(['ralph']),
    note: 'toolName/commandName are configurable; a renamed entry is still a Ralph loop, and the loop sensor (round-agent labels, workflow meta) is what refuses it while Tower mode is active',
  }),
  Object.freeze({
    owner: '@deepseek-ai/dsh-tool-subagent',
    stance: 'subagent',
    tools: Object.freeze(['subagent']),
  }),
  Object.freeze({
    owner: '@deepseek-ai/dsh-subagent-fork-in-process',
    stance: 'subagent',
    tools: Object.freeze(['subagent_fork']),
  }),
])

/**
 * The denied tool set: every tool of every stance owner, in table order,
 * de-duplicated. This derives `mode.denyTools` defaults; a test pins the
 * derivation so a row without a surface or a stale union fails the build.
 * @returns {string[]}
 */
export function stanceDenyTools() {
  return [...new Set(STANCE_OWNERS.flatMap((owner) => owner.tools))]
}

/**
 * The denied command set: every command of every stance owner. The Tower-mode
 * command guard shadows exactly these names for the towered agent.
 * @returns {string[]}
 */
export function stanceDenyCommands() {
  return [...new Set(STANCE_OWNERS.flatMap((owner) => owner.commands ?? []))]
}

/**
 * The owners that registered one denied surface name.
 * @param {string} name
 * @returns {string[]}
 */
export function stanceOwnersOfTool(name) {
  return STANCE_OWNERS.filter((owner) => owner.tools.includes(name)).map((owner) => owner.owner)
}
