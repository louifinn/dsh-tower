// Command surface of foreign orchestration stances (#162).
//
// Tool denial is owned by #161: `mode.denyTools` derives from
// domain/deny-owners.js and the generated inventory, so this module keeps no
// second tool list (that duplication is exactly what #161 removed). Commands
// are a different surface: the tool registry cannot see them, so a slash
// command whose handler starts a competing orchestrator would bypass the
// guard. Today the only such command is the community `dsh-ralph` package's
// `/ralph`, which starts a loop directly; the first-party Ralph tool registers
// no command. A future stance owner with a command adds a row here, not a
// handler-side name check.
//
// This module is pure data plus derivations: no fs, no host state.
/**
 * @typedef {object} CommandOwner
 * @property {string} owner The npm package that owns the stance.
 * @property {string} stance The orchestration stance it owns.
 * @property {readonly string[]} commands Command names it registers (default names).
 * @property {string} [note] Boundary the row cannot express on its own.
 */

/** The components whose command surface conflicts with Tower mode.
 * @type {ReadonlyArray<CommandOwner>} */
export const COMMAND_OWNERS = Object.freeze([
  // A renamed command cannot bypass this: the loop sensor identifies the
  // stance from its observable facts (round-agent labels, workflow meta) and
  // refuses the rounds while Tower mode is active (host/ralph-stance.js).
  Object.freeze({
    owner: 'dsh-ralph',
    stance: 'ralph-loop',
    commands: Object.freeze(['ralph']),
    note: 'commandName is configurable; a renamed entry is still a Ralph loop, and the loop sensor (round-agent labels, workflow meta) is what refuses it while Tower mode is active',
  }),
])

/**
 * The denied command set: every command of every command owner. The Tower-mode
 * command guard shadows exactly these names for the towered agent.
 * @returns {string[]}
 */
export function stanceDenyCommands() {
  return [...new Set(COMMAND_OWNERS.flatMap((owner) => owner.commands))]
}

/**
 * The owners that registered one denied command name.
 * @param {string} name
 * @returns {string[]}
 */
export function stanceOwnersOfCommand(name) {
  return COMMAND_OWNERS.filter((owner) => owner.commands.includes(name)).map((owner) => owner.owner)
}
