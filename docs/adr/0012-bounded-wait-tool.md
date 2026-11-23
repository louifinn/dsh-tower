# ADR 0012: A bounded blocking wait is its own tool

- Status: accepted
- Date: 2026-11-21
- Ref: #201

## Context

A Tower session had no way to *await* a target. `tower_inspect` answers "what
is true now", and the tower loop could only poll it by calling the read-only
views repeatedly: each call re-enters the tool runtime, advertises the whole
view surface and returns a whole table even when the caller only needs one row.
Polling from the model is also unbounded — nothing stops a worker from asking
for "five minutes" and holding a turn open with a hand-rolled `sleep` loop, and
nothing gives the caller a single, schema-checked conclusion when the target
never appears.

The mission vocabulary already names the two facts a wait needs: roster rows
have a settled state set (`inactive`, `retired`, `failed`, `interrupted`,
`missing` — never `stale`, `reserved` or `active`), and missions have terminal
or paused statuses (`completed`, `merged`, `blocked`, `paused`, `abandoned`).
#210/#211 then widened `tower_inspect` with read projections, including the
`agent`/`tail` pair this record reuses for per-agent progress. Waiting is the
other half of that read story, and folding it into `tower_inspect` would make a
read-only view block for up to ten minutes.

## Decision

Add `tower_wait` as the 22nd build-surface tool, a tower-only blocking reach:

- Input: exactly one of `missionId` or `agent`, plus `until`
  (`settled` | `completed` | `inactive` | `any-change`, default `settled`) and
  `timeoutMs` (integer 1000–600000, default 30000). Out-of-range and
  ambiguous targets are refused with `invalid-argument` naming the boundary.
- Behavior: one bounded poll loop. Each round re-reads `state.json` once, never
  holds the state lock across a wait, never writes state or the activity log,
  and yields between rounds (`sleep(min(500, remaining))`), so a wait cannot
  block the event loop or a concurrent writer.
- Result: exactly one conclusion. `reached` carries the waited-for fact
  (`detail`); `timeout` carries the last bounded observation (`last`); `unknown`
  carries a `reason` when the target is absent or the catalog cannot be read —
  an absent target is never reported as a timeout.
- Exposure: tower-only. It joins the tower profile and `host:active`, never the
  worker, reviewer or survey presets; a worker has no target it may legitimately
  block on, and the role presets keep their smallest surface.

Per-agent progress (#207) stays on `tower_inspect`: with `agent` (and optional
`tail`, default 5, max 50) the `status` and `roster` views return only that
row's bounded activity, never the whole table. `status` without `agent` is the
dashboard and has no bounded tail, so `tail` on `status` requires `agent` and is
otherwise refused with `invalid-argument` instead of being silently ignored;
`roster` without `agent` accepts `tail` as the newest-N-rows bound. With
`compact:true` those views keep only the agent identity (`name`, `role`,
`missionId`, `state`) and, for `status`, the bound mission as `{id, status,
kind}`. The wait tool accepts the same agent identity, so a caller can inspect or
wait on the same target without learning a second vocabulary.

## Consequences

- A caller can wait once instead of writing a polling loop, and the runtime
  bounds the wait. Ten minutes is the ceiling; the default is 30 seconds.
- "Target absent" and "still working" are different answers, so a typo in a
  mission id fails fast as `unknown` instead of burning the timeout.
- The state lock is never held across a wait, so a concurrent spawn/complete
  cannot be blocked by a waiting session; a corrupt or removed catalog fails
  closed at authorization (or as `unknown` when it disappears mid-wait).
- The all-on build surface grows from 21 to 22 tools; the default profile
  mounts 17, the tower profile advertises 15, and `host:active` becomes
  15 tools / 20,229 B of input schema. `host:mode-off` and `host:idle` are
  unchanged because they mount neither the tool nor its schema.
- The wait's 299-character description is inside the 300-character budget; the
  new tool is one more line in `tools.generated.md` and the tools table.
- `tower_wait` is read-only but not repository-optional: like the rest of the
  Tower surface it resolves the caller's catalog from a repository path, and it
  writes nothing while it polls.

## Rejected alternatives

- **A `wait` flag on `tower_inspect`** — a read-only view would become
  blocking, and `tower_inspect` is mounted by every role preset; the wait would
  leak into worker/reviewer surfaces that must stay non-blocking.
- **An unbounded wait or a "wait until done" default** — the caller cannot
  distinguish a hung target from a slow one, and a closed worker turn can be
  pinned for the whole session. The timeout is the contract, not a suggestion.
- **Polling from the caller** — the model cannot prove it yields, cannot
  distinguish `unknown` from `timeout`, and pays the full view projection on
  every round.
- **Reusing the roster row's `stale` state as "settled"** — `stale` is an
  observation-health fact, not a lifecycle state; #210/#211 already fixed the
  vocabulary split and this record keeps it (settled never includes stale).
- **Reporting a missing target as `timeout`** — that is the exact confusion
  #201 reports; `unknown` keeps the three conclusions distinct.

## Surface budget

One tool, no config key, no section, no component:
[`scripts/surface-baseline.json`](../../scripts/surface-baseline.json) tools
21 → 22; profiles: tower 14 → 15 tools and 14,166 → 15,263 B, worker
6/8,304 → 6/8,515 B, reviewer 5/5,398 → 5/5,609 B. `profileBytes`:
`host:active` 14/18,665 → 15/20,113 B, `preset:worker` 6/10,282 → 6/10,493,
`preset:reviewer` 5/7,015 → 5/7,226, `preset:survey` and
`preset:survey-sandbox` 5/9,097 → 5/9,308. `host:mode-off` (846 B) and
`host:idle` (2,185 B) do not move. R185's explicit compact description adds
116 B to every profile that mounts `tower_inspect`: tower 15,379, worker 8,631,
reviewer 5,725, `host:active` 20,229, and the four presets 10,609 / 7,342 /
9,424 / 9,424.
