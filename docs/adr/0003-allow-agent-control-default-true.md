# 0003 — allowAgentControl defaults to true

- Date: 2026-10-23
- Status: Accepted
- Deciders: maintainer
- Supersedes: none

## Context

Tower's product claim is a human-owned orchestration mode: the user decides when
to enter it, and the merge gate is the final authority. The config key
`mode.allowAgentControl` decides whether the model may call `tower_control` to
enter or leave the mode. Making it `false` by default would sound safer, but it
would also mean the feature does not work until the user discovers and flips a
key, and the model would have no way to leave a mode the user asked it to enter.

## Decision

`mode.allowAgentControl` defaults to `true`, and the legacy top-level
`allowAgentControl` alias keeps the shipped patch behavior. The default is paired
with independent checks rather than with trust: entering records a reason, a
user-paused goal is never auto-resumed without an authorization reference, the
first entry can require a human `/tower ack`, one Tower session per repository can
hold the workspace lock, and `tower_merge` still runs the preflight gate.

## Consequences

- The default profile works: a user can say "use Tower" and the model can comply.
- Human ownership is enforced by refusal paths (ack, authorization, workspace
  lock, preflight) instead of by a disabled-by-default switch that users would
  turn on anyway.
- A deployment that wants human-only mode control pins
  `mode.allowAgentControl:false`; doctor warns when a profile still relies on a
  reversed default instead of pinning it.
- The default is a product decision with a written rationale, so it can be
  revisited on evidence rather than by citing "secure by default".

## Rejected alternatives

- **Default `false`** — the plugin would appear broken on first use, and the
  existing reversal would be dropped only to look conservative.
- **No config key at all** — the model could always toggle the mode, with no way
  for a human-only deployment to refuse it.
- **Require an approval prompt for every entry** — the prompt is an environment
  behavior, not a plugin guarantee; the ack and authorization fields are the
  guarantees this plugin can actually enforce.
- **Let the model resume a paused goal on exit** — exit is not consent; resuming
  stays a human decision.
