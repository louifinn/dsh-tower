# 0009 — Tool exposure is a role × phase gate on step-time conditions

- Date: 2026-11-12
- Status: Accepted
- Deciders: maintainer
- Supersedes: none

## Context

Issue #164: the host plugin registers all 21 tools into the profile, so a
session with Tower mode **off** still advertises every schema (~22.1 KB ≈ 5.5k
tokens measured on 2.8.0) in every request, for tools that session must not
use. Role contracts are enforced at call time (`guard`, the authorization
kernel) and, since #163, also by a step-time role predicate on the two
role-owned tools; there is no phase distinction at all. #163 decides what
exists (21-tool consolidated surface, `tower_inspect`, op-level enums, role
contracts); this decision is the other half — *what is broadcast right now* —
and lands on top of the surface #163 leaves in the build.

The issue demanded a host-capability spike before any mechanism choice, with
the answers recorded here (§7): can `ctx.tools.restrict({ allow })` be
re-evaluated per request and per agent, and is the advertised order stable?

## Spike answers (DSH 0.2.2-rc.1, `@deepseek-ai/dsh-tools` ToolsService)

1. **`restrict` is per-agent and runtime-callable, but not replaceable and not
   usable from this plugin's entry.** It requires a scoped context
   (`scopeOf(ctx)` — an agent or preset scope); the tower host plugin's
   `apply` runs in the global scope, so a profile-wide restriction would throw
   by design. Restrictions append anonymously and **intersect** across the
   scope chain; the only way to change one is to dispose the returned effect
   and append a new one. It is the right primitive for the spawned presets
   (their `apply` runs in the agent scope, which is exactly how the four role
   presets already use it) and the wrong primitive for a host-session ladder.
2. **`register(definition, { when })` is the per-request, per-agent mechanism.**
   The loop calls `tools.resolve({ agent, modelSelection, signal })` once per
   model step (`preStep`) and evaluates every registration's `when` against
   that context; the admitted set is frozen for the step — the set that built
   request N is the set that validates calls in N. A rejected condition simply
   omits the tool: `executable()` resolves it as absent, so a hidden tool
   called anyway fails as `UNKNOWN_TOOL`, byte-for-byte like a missing tool.
   Hiding is not refusal.
3. **Advertisement order is registration order and stable.** The registry
   keeps tools in insertion-ordered maps; `view()/definitions()/schemas()`
   preserve that order, and `registerCoreTowerTools` registers in a fixed
   sequence (its comment already freezes it as "the shipped tool order"). An
   unchanged admitted set therefore produces a byte-identical prefix; no
   reordering is needed or wanted here.
4. **Role agents are distinguishable.** Spawned children carry their preset in
   session meta, and the `agentPresets` service answers
   `composedPreset(agent.ctx)` with the live preset id (`tower-worker`,
   `tower-reviewer`, `tower-survey`, `tower-survey-sandbox`). A child spawned
   without an explicit preset inherits its parent's composition — so a worker's
   nested child is also exempt from the host ladder.

Open question #4 (does the provider cache the tool block, and from which
byte?) is not measurable in-process; the design answers it by construction —
the admitted set changes at most at the two boundaries below, so cache
behavior can only help the decision, never reverse it.

## Decision

**Exposed = L2 component rows ∩ L1 phase ladder ∩ L0 role contract**, with
each layer already owned by an existing mechanism:

- **L0** stays the preset allow-lists (`restrict` in the four role presets,
  sourced from one table in `domain/exposure.js` and re-exported by
  `host/tool-profiles.js` for the role predicates) and "the mounted surface"
  for the host session. #163's role contracts compose with this layer: a
  role-owned tool carries both conditions, and both must admit.
- **L1** is new: `domain/exposure.js` classifies every tool this build can
  register into the host session's phases — `off`, `idle`, `active` — and
  `host/exposure.js` turns that table into the `when` condition the host entry
  installs before any registration (`define()` attaches it automatically; a
  composition that never installs a gate keeps the unconditional surface, the
  compatibility floor). The gate fails **open**: any probe error (no agent
  identity, unreadable state, a throwing preset lookup) exposes the tool —
  exposure only subtracts, so the worst case is yesterday's surface, never a
  hidden way out. State-existence is probed once per step per agent
  (memoized, reset after every tower tool call), never per mutation.
- **L2** is unchanged: a disabled component row never registers its tools, and
  the table classifies those names anyway, so row-off and phase-hidden compose.

The ladder is deliberately **two rungs**, not three:

- `off → idle` costs nothing extra — entering Tower mode already changes the
  prompt (the reminder section turns on), and `idle` is the entry affordance
  plus `tower_init` only: a mode-off or freshly-entered session pays 0.8–2.2 KB
  instead of 22.1 KB.
- `idle → active` happens at `tower_init`, early in a session when the prefix
  is small, and is the *only* switch in a tower session's lifetime.
- **running and integrating are merged into `active` (the stable union).**
  Measured on 2.8.0, the integration-only schemas (`tower_merge` 599 B +
  `tower_rebase` 456 B + `tower_finding` 1,892 B) save ≈ 2.9 KB ≈ 0.7k tokens
  per turn, while the switch invalidates the cached prefix at a moment when a
  tower session realistically holds ≥ 30k tokens (it planned, spawned, and
  read at least one worker report). Break-even
  ≈ 30k / 0.7k ≈ **40 further turns after the first completion** — longer
  than the tail of a median tower session, so per the issue's own rule the
  union stays and the bytes are accepted. `recover`, `teardown` and `mode`
  stay exposed across the whole rung for the same reason.

**The mode-off affordance.** Stage 2's target is "non-Tower sessions: 5.5k →
0". We keep exactly one schema instead: `tower_mode` (846 B). Since #163
Phase 4 it carries the read-only "where am I" pointer (principle 5's fallback)
and the enter/leave/takeover writes in one schema, so hiding it would remove
the model's only way to act on "use Tower mode for this" — a dead end the
issue's goal statement forbids ("without ever creating a dead end"); the
user's `/tower` command remains the other entry, and
`mode.allowAgentControl:false` still refuses the writes. The residual is
846 B (−96.2%); the byte baseline below keeps it visible rather than
pretending it is zero.

**Role agents bypass the ladder.** A worker calls `tower_mission` with Tower
mode off (mode is the tower session's stance), so the gate exempts agents
whose `composedPreset` is one of the four Tower presets; their preset's
allow-list remains the authority. Unknown compositions (a custom user preset,
a plain session) get the ladder.

**Gates** (stage 5): `tests/exposure.test.mjs` checks the four properties
exhaustively over the shape registry's own transition tables — subtraction
(every phase ⊆ the registered surface; `off` ⊆ the entry affordance),
liveness (every legal transition's driving tool is exposed in the phase and
profile that owns it, and the transition map has no missing or invented
edges), monotonicity (`off ⊆ idle ⊆ active` per tool; the only shrinks are
mode exit and state teardown) and stability (identical inputs serialize
byte-identically). "No implicit all": every registered name must appear in
the exposure table — a new tool without a phase row fails the suite. And
`surface:check` now measures **per-profile schema bytes** (`profileBytes` in
`scripts/surface-baseline.json`): mode-off 846 B / 1 tool, idle 2,185 B / 2,
active 22,061 B / 21, worker 8,127 B / 6, reviewer 6,000 B / 5, survey and
survey-sandbox 7,067 B / 5 each (2.8.0 post-#163 surface). Any drift requires
a dated decision; growth additionally requires an ADR.

## Consequences

- A mode-off session's requests stop carrying 20 orchestration schemas; a
  mode-on session carries the full union from `tower_init` on, unchanged for
  its lifetime (stable prefix).
- A hidden tool behaves exactly like an unknown one; the store, the guard and
  the authorization kernel remain the authority, so nothing here is
  authorization. Mid-turn mode flips take effect at the next step boundary —
  the same rule the host already applies to every `when` condition.
- Hosts without `when` support ignore the registration option silently and
  keep the unconditional surface (the B3 floor); B1 (profile reload on mode
  change) and B2 (separate profiles per phase) are both unnecessary and B2
  stays rejected as in the issue.
- Adding a tool now means adding an exposure-table row (the suite enforces
  it) and, if it grows a profile's bytes, a baseline decision naming an ADR.

## Rejected alternatives

- **Per-mutation recomputation** (re-derive the set on every state write):
  looks precise, invalidates the prefix constantly, loses money — the issue's
  first anti-pattern; the gate recomputes only at step boundaries.
- **`restrict` for the host ladder**: not callable from the global plugin
  scope and not replaceable per step (spike answer 1); kept for preset L0
  where it fits.
- **A phase machine per preset**: the four role presets have one shape each;
  a machine there is complexity with no return.
- **Three rungs (idle → running → integrating)**: one extra cache
  invalidation whose break-even (~40 turns) exceeds the median integration
  tail; the union wins (§6's own rule).
- **Strict zero at mode off**: hides `tower_mode`, the read pointer and the
  agent-driven entry `allowAgentControl` ships in one schema — a dead end; the
  846 B affordance stays and is gated visibly in the byte baseline.
- **Prompt-text control** ("do not use X while Y"): prose where the design
  asks for structure; not used.
