# Tower mode: denied capabilities and replacements

Tower mode closes the orchestration surface it does not own. Foreign orchestration
tools are removed from the worker and reviewer presets, and a small number of
compatibility capabilities are allowed but warned about. This page is the single
human-readable inventory of that trade: for every capability Tower denies or
warns on, it records the stance, the replacement, how complete that replacement
is, and what the user gives up.

The table is tied to `domain/generated/deny-surface.js` (the deny surface) and
`host/doctor-acceptance.js`. Adding an owner to the deny surface without a row
here fails `npm run docs:check`; changing the recorded inventory build without
regenerating fails `npm run deny:check`. Neither file is meant to be edited by
hand: `domain/deny-owners.js` holds the owner list and exceptions, and both
checks derive from it.

## Stance vocabulary

Stances are the `CAPABILITY_STANCE` values from `domain/vocabulary.js`:

- `deny` — Tower removes the capability from the presets; the tools are not
  registered for the session.
- `warn+allow` — the capability may be mounted, but `tower_inspect` (doctor
  view) warns and the
  limitation is recorded instead of being silently accepted.
- `compatibility` — a deprecated spelling that still loads.
- `deployment-config` — configured outside the session.

Only `deny` and `warn+allow` rows appear below. `coverage` is `full` when the
replacement carries the same work in Tower's protocol, `partial` when a real
part of the capability has no counterpart, and `none` when refusing is the only
behaviour Tower offers.

<!-- tower-deny-table:begin -->
| Capability | Denied tools | Stance | Replacement | Coverage | Cost |
| --- | --- | --- | --- | --- | --- |
| `tool-agent-team` | `interrupt_agent`, `list_agents`, `send_message`, `spawn_teammate`, `team_task_create`, `team_task_get`, `team_task_list`, `team_task_update`, `wait_agent` | deny | `tower_spawn` plus the roster (`tower_inspect`), `tower_send`/`tower_inbox`, `tower_interrupt`, and mission dependencies | full | workers cannot grow a private team; every child is a mission the tower spawned and records |
| `tool-goal` | `create_goal`, `get_goal`, `update_goal` | deny | `tower_mission` tasks, status, paused/blocked and notes | full | goals outside a mission are not trackable; a worker reports progress through its mission |
| `tool-todo` | `todo_write` | deny | `tower_mission` tasks | full | the session todo list is gone; task state lives on the mission and is visible to the tower |
| `tool-subagent` | `subagent` | deny | `tower_spawn` plus `tower_send`/`tower_inbox` and the mission result | full | a worker cannot delegate on its own; only the tower opens children |
| `tool-subagent-fork` | `subagent_fork` | deny | `tower_spawn` with a fresh context | partial | there is no fork of the current conversation; the child starts from a briefing, not from the parent's context |
| `tool-subagent-control` | `interrupt_agent`, `list_agents`, `send_message` | deny | `tower_inspect` roster, `tower_send`/`tower_inbox`, `tower_interrupt` | full | addressing a child is a tower action; a worker escalates and stops |
| `tool-ralph` | `ralph` | deny | none — a Ralph loop is a second orchestrator; the worker must stop and report the need | none | the mission ends with a blocker or a dropped task instead of an autonomous loop |
| `tool-workflow` | `workflow` | deny | none — workflows fan out subagents outside the Tower protocol; `tower_plan` is a static plan, not a runner | none | a static plan can be recorded, but no workflow engine executes it |
| `forge` | — | warn+allow | none — Tower lands changes on its mission branch and merges after review; it has no change-request mode | none | forge loses its change-request and merge-on-request path, and Tower has no record of what it refused |
| `liveshare` | — | warn+allow | none — `tower_mode` takeover transfers ownership instead of sharing a live session | none | a shared session loses viewing and bounded writing, and Tower has no record of the share |
| `plugin-manager` | — | warn+allow | none — install or enable plugins outside a Tower run; `tower_inspect` (doctor) reports the gap | none | the profile cannot install or enable a plugin from a session, and Tower has no record of the change |
| `auto-review` | — | warn+allow | `tower_review` plus the `review.mode` gate: a reviewer reads the branch, but approval of tool calls is not replaced | partial | auto approval is unavailable in a delegated child; a denied call fails closed, and only the review gate judges the result |
<!-- tower-deny-table:end -->

## Safe compatibility versus denial

A capability is denied only when Tower has a protocol replacement and can record
the work; otherwise it is warned and left mountable, or refused outright with the
refusal recorded in the mission result or the inbox. That ordering prevents two
failure modes: silently degrading work by removing a tool with no counterpart,
and claiming compatibility for a tool whose absence changes the outcome.

The per-owner build exceptions follow from the same rule. The inventory is
enumerated from the owner set recorded in `DENY_OWNER_PACKAGE_BUILD` (`0.2.2-rc.1`),
while the supported host pin in `scripts/support.json` is newer (`0.2.2-rc.5`).
The agent-team package was not republished after `0.2.2-rc.1`, so every owner is
held at the complete rc.1 set and the reason is recorded per package in
`DENY_OWNER_BUILD_EXCEPTIONS` in `domain/deny-owners.js`. When that package is
republished, the exceptions are deleted, every owner pin and the inventory build
move together, and `npm run deny:generate` rewrites the surface.

## Decision points

- A new foreign owner: add it to `FOREIGN_ORCHESTRATION_OWNERS`, regenerate, and
  add one row here — `docs:check` fails until the row exists.
- A new tool on an existing owner: regenerate; the tool cell of that owner's row
  must list it, so a stale row fails the same check.
- A capability Tower starts supporting: change the stance row and the check will
  follow the exported vocabulary, not a hand-written string.
- A capability that should no longer be mounted: move the row from `warn+allow`
  to `deny` and add the real replacement, or mark the coverage `none` and record
  the refusal.

## No-ask limitation

A delegated child cannot ask the user. There is no approval prompt and no
mid-run question for a worker or a reviewer; a tool call that needs approval
fails closed. Escalation goes through the mission result, a recorded blocker, or
the tower inbox, and the tower decides. This is why a denied tool is never a
hint to "try another way": the worker either finds the Tower replacement in the
briefing or stops and reports.
