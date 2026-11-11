# ADR 0008: Spawn backoff and send rate limits are process-local advisory budgets

- Status: accepted
- Date: 2026-11-12
- Ref: #M76 (W5-B, technical-debt plan)

## Context

Two protections in `host/tool-runtime.js` limit how fast a Tower session can
create work:

- `SPAWN_BACKOFF` tracks consecutive spawn failures per repository and inserts a
  delay after the third failure: `min(60000, 5000 * 2 ** min(4, failures - 3))`
  ms. A successful spawn clears it.
- `SEND_RATE` tracks `tower_send` calls in a 60-second bucket per repository and
  throws `TowerToolError('rate-limited')` once `send.maxPerMinute` is reached
  (`0` disables the check).

Both maps are ordinary in-memory `Map`s keyed by repository root. They reset on
process restart, differ between concurrent DSH processes, and are invisible to a
second Tower session on the same repository. The state lock and the repo-scoped
git mutex are the cross-process coordination that actually serialises durable
work; these budgets sit above individual tool calls and are not part of that
protocol.

The risk is a reader treating either limit as a hard quota or a security
boundary. A retry loop in another process, a restarted host, or a directly
invoked app use case can exceed the configured `maxPerMinute`, and a spawn
backoff can disappear with the process. Nothing in the rate check is
authentication or authorization: authorization is the tool/agent contract and
the workspace lock, not this counter.

## Decision

Spawn backoff and send rate limiting are **process-local advisory budgets**.
They exist to protect one running session from runaway retry loops and
accidental message floods, and to make the caller wait instead of failing
immediately. They are explicitly:

- **not a cross-process or cross-repository hard quota** — each process keeps
  its own counters and a restart starts empty;
- **not security controls** — they never replace the workspace lock, the state
  lock, the git mutex, leases, or authorization;
- **not persisted** — no state-schema field, no config file, no new tool, and no
  shared counter store;
- **per repository key, in memory only** — two Tower sessions on one repository
  may each spend the full budget.

The documentation paths that describe send/spawn behavior must name this scope
([`docs/reference/config.md`](../reference/config.md) for the tuning key and
[`docs/operations/security.md`](../operations/security.md) for the security
posture). Tests may assert the process-local behavior; they must not imply a
cross-process guarantee.

## Consequences

- A single session is protected from its own retry storm and message burst.
- Concurrent sessions can collectively exceed `send.maxPerMinute`; operators must
  not size it as a platform quota.
- Restarting DSH clears a spawn backoff. That is intentional: the failure that
  caused it is also process-local state.
- No schema, migration, or platform dependency is introduced. A future hard
  quota would need a separate decision, a cross-process store, and a security
  review; it must not be smuggled into these counters.

## Rejected alternatives

- **Persist counters in `state.json`** — adds a state-schema field and couples a
  best-effort throttle to the durable mission document; a corrupt or locked
  state must not make sending impossible.
- **Use the state lock or a shared file as a token bucket** — turns an advisory
  throttle into a second cross-process lock with its own liveness, stale-lock,
  and contention failure modes.
- **Present the check as a hard quota** — the implementation cannot enforce it,
  and claiming it would make the security docs false.
- **Remove the limits instead of scoping them** — a single session could then
  spawn retry loops or send floods without any local guard.
