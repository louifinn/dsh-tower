# ADR 0009: Tower and a Ralph loop are mutually exclusive per repository

- Status: accepted
- Date: 2026-11-12
- Ref: #162

## Context

Tower mode and a Ralph loop (`@deepseek-ai/dsh-tool-ralph`, the community
`dsh-ralph`, or any other implementation of the same stance) are two answers to
"who owns this repository's writes, and who decides when the work is finished".
The documentation said they were exclusive, but the code only separated them at
the weakest layer — a hand-maintained list of tool names:

- `/ralph` is a **command**, and commands are not tools; nothing in Tower saw
  it, so a person could start a loop inside Tower mode by typing its name.
- Every Ralph round is a **fresh agent** with a new id, so the per-agent mode
  keys the guard is keyed on do not exist for a round: a loop started before
  `/tower on` kept iterating while `state.json` still advertised a live tower,
  and its rounds worked in the main checkout that Tower believes it owns.
- A renamed entry point (`dsh-ralph`'s `toolName`/`commandName` are
  configurable) never met the literal deny list at all.

Neither Ralph implementation consults Tower, and Tower cannot reach into
another package to add a check, so the exclusivity has to be enforced from the
Tower side alone.

## Decision

Tower enforces the exclusivity at three layers, all owned by
`domain/config/stance-owners.js` and `host/ralph-stance.js`:

1. **Names, by owner.** The deny set is derived from a stance-owner table: one
   row per component that owns an orchestration stance, naming the tools and
   commands that component registers. `mode.denyTools` defaults to the union of
   the tool rows (the community fallback name `ralph_prd` is included), and
   while Tower mode is active the stance-owner **commands** are shadowed for
   the towered agent by an actionable refusal ("Tower mode is active;
   /tower off first"). #161 extends the same table for Agent Teams instead of
   adding a parallel list.
2. **Entry reconciliation.** Entering Tower mode consults a process-local
   sensor built from observe-only seams (the first-party loop's
   `ralph-loop` workflow meta, and the `ralph #…` / `Ralph round N` labels
   every accepted round appends to its parent's subagent catalog).
   `mode.ralphPolicy:"stop"` (the default) enters anyway and records the
   released loop in the repository activity log; `"refuse"` rejects the entry
   with the reason. One policy key is the whole new config surface.
3. **Rounds.** While any Tower entry is active for a workspace, the round
   agents the sensor recorded have their steps rejected (`agent/pre-step`
   returns `{kind:"reject"}` scoped to that repository). This is what stops a
   loop that was already iterating and what makes a renamed tool or command
   unable to restart one: the loop's fresh agents cannot run, so the loop ends
   on its own failure path. Tower workers are unaffected — they run in
   isolated worktrees, and a Ralph loop inside a Tower worker is not a
   conflict (the worker owns one mission).

`tower_doctor` reports a live loop as an environment fact plus a
`ralph-stance` check, and `tower_mode` exposes the policy and the live counts.

## Consequences

- One stance per repository is now a checked invariant, not prose: the command
  path, the entry path and the running loop are all covered.
- Round refusal is scoped by the parent session's cwd against the towered
  workspace (the repository root when resolvable), the same repository
  identity `mode.workspaceLock` protects; sessions on unrelated checkouts are
  untouched.
- Detection is bounded by what an uncooperative third party exposes. The
  label and the workflow meta name are fixed in both known implementations
  (renaming the tool or command does not change them), but a hypothetical
  implementation that also relabels its rounds would be invisible to the
  sensor; the stance-owner table and doctor's rule statement are the boundary
  of what Tower can promise without upstream cooperation.
- A round recorded at entry is refused minutes after it settles (a five-minute
  liveness window, pruned by agent disposal), so `mode.ralphPolicy:"refuse"`
  can reject an entry for a loop that just finished. The refusal says to wait
  and re-run `/tower on`; `stop` never has this failure mode.
- The persisted mode entry gains `workspace` and `ralphReleased` fields. Old
  stores load unchanged; entries without `workspace` simply cannot scope round
  refusal until the next entry.

## Rejected alternatives

- **Ask Ralph to check Tower's state file** — both implementations are other
  packages; the community one deliberately imports nothing from DSH internals.
  Out of Tower's reach.
- **Cancel the loop from Tower** — the workflow runs are holder-owned and the
  observe-only events never expose them; one-shot round children cannot be
  interrupted by a non-ancestor. Refusing the rounds achieves the stop without
  an authority the platform does not grant a plugin.
- **Deny every foreign agent in the towered workspace** — that is #161's
  workspace-scoped guard question, and it would reject innocent read-only
  sessions. This record refuses only agents the sensor positively identified
  as Ralph rounds.
- **A second deny list for commands** — the same hand-maintained drift the
  issue reports, one layer over. The stance-owner table is the one source for
  both surfaces.

## Surface budget

One config key, `mode.ralphPolicy` (`stop`/`refuse`, default `stop`), recorded
in [`scripts/surface-baseline.json`](../../scripts/surface-baseline.json):
config keys 57 → 58. `mode.denyTools` gains the derived `ralph_prd` default
without a key change; no tool, section or component moves.
