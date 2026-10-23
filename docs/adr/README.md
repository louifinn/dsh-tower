# Architecture decision records

An ADR is a dated record of a decision that is already load-bearing. It is not a
proposal: the status says whether the decision is accepted, and the rejected
alternatives exist so a future reader can see what was actually weighed.

The engineering principles that these records serve are in
[../PRINCIPLES.md](../PRINCIPLES.md). `npm run docs:check:philosophy` requires at
least three numbered ADRs, each with Context, Decision, Consequences, Rejected
alternatives, Date and Status.

| ADR | Decision | Date |
|---|---|---|
| [0001](0001-ports-adapters-as-data.md) | Ports and adapters are data, not a dependency-injection container | 2026-10-23 |
| [0002](0002-single-state-json.md) | One `state.json` is the mission persistence contract | 2026-10-23 |
| [0003](0003-allow-agent-control-default-true.md) | `allowAgentControl` defaults to `true` | 2026-10-23 |
| [0004](0004-surface-budget.md) | The concept surface is frozen by a committed baseline | 2026-10-23 |

## Template

```markdown
# NNNN — Decision title

- Date: YYYY-MM-DD
- Status: Proposed | Accepted | Superseded by NNNN
- Deciders: <who>

## Context

What forced the decision.

## Decision

What was decided, in one paragraph.

## Consequences

What becomes easier, what becomes harder, and what is now refused.

## Rejected alternatives

- **Alternative** — why it was not chosen.
```

## Non-goals

These records do not form an RFC queue, an architecture review board, or a
process for approving ordinary changes.

Unowned. This is a documentation convention, not a gate; nothing in CI blocks a
new ADR or rewards one.
