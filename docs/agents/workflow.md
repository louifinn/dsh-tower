# Execution workflow: Matt Pocock skills × Tower

This repository uses two workflows together. They are not alternatives: the **Matt Pocock skills** own thinking, planning, review discipline and retros; **Tower** owns delivery — isolated worktrees, scope fences, review gates, merges and durable mission state. **GitHub Issues** is the single source of truth for what is planned, in progress, blocked and shipped.

## Who owns what

| Stage | Owner | Artifact |
|---|---|---|
| Intake | Matt Pocock `/triage` for raw external reports; milestones + `P*`/`area/*` labels for self-authored findings | issue with owner-facing state |
| Plan | `/to-spec` → `/to-tickets` (or an existing issue whose acceptance criteria are already ticket-shaped) | spec issue, tickets with native `blocked_by` edges |
| Execute | `/implement-spec` subagents for one-session waves; **Tower missions** for parallel or long-lived work | integration branch + PRs, or mission worktrees + merge gate |
| Build each unit | `/tdd` inside the ticket/mission | failing test first, then green |
| Verify | gates + required CI checks + `/code-review` (Standards + Spec) | green PR with two-axis review |
| Land | protected `main`, four-line PR body, `verified-by:`/`commit:` closure | merged PR, closed issues |
| Release | `release:check`, CHANGELOG, COMPATIBILITY, tag; publish only when planned | tag-only or published release |
| Learn | `/retro`; mechanical findings become checks, judgement becomes standards | CONTRIBUTING/AGENTS/scanner updates |

## The flow

1. **Intake.** Raw external bug reports and feature requests go through `/triage` (they are not ours). Findings we file ourselves (audits, retros) skip triage and get a priority, an area and a milestone; they are already acceptance-criteria-shaped.
2. **Plan.** Multi-session work goes `/to-spec` → `/to-tickets`. Tickets are tracer bullets with native blocking edges; the frontier is whatever has no open blockers. Small work may skip the spec when the issue already states acceptance criteria (e.g. a patch ticket).
3. **Choose the orchestrator.**
   - **One-session wave (≤3 tickets, mostly independent):** `/implement-spec`-style: an integration branch, one implementer subagent per ticket in its own worktree, merger merges to the integration branch, one PR to `main`.
   - **Parallel or long-lived wave (architecture epics, >3 tickets, review needed):** **Tower**. `tower_init` → `tower_plan` with one mission per ticket, `scope` = the ticket's write fence, `deps` = the ticket's blocking edges → `tower_spawn` a worker per mission → optional reviewer (`tower-reviewer`) → `tower_merge` (gate checks scope, branch freshness, review, tasks) → `tower_teardown`. Tower's persistent state makes the wave resumable after a restart.
   - Never run both orchestrators over the same files at once.
4. **Build.** Each unit starts with `/tdd`: one failing test, then the implementation, then the next slice. Commit messages carry `Refs #n`; the completing commit uses `Fixes #n`. Workers do not merge; they hand off a branch.
5. **Verify before landing.** Run `npm test`, `npm run docs:check`, all five `docs:check:generated*` (including the generated type vocabulary), `npm run pack:check`, `npm run architecture:check`, `npm run types:coverage`, `npm run types:check`, `npm run domain:check`. Bundle changes also run `npm run smoke:mount`. CI must be green on the required checks (`test (22)`, `test (24)`, `test (22, windows)`, `mount`). Then `/code-review` runs both axes on the diff (Standards against CONTRIBUTING/architecture docs, Spec against the ticket); every finding is fixed in the same PR or explicitly deferred with a reason.
6. **Land.** PR body follows the four-line contract (failure mode → change → test that fails without it → blast radius). `main` is protected: PR + required checks, admins included, no force-push. A closure comment carries `verified-by: <test file>` and `commit: <sha>`; `npm run audit:issues` flags closures whose evidence is missing.
7. **Release.** `release:check` compares the version, the previous tag and the CHANGELOG; a tag push fails when the version did not move or the tag does not match. Releases are either **tag-only** (version + changelog + compatibility row + annotated tag; no npm publish, no GitHub Release) or **published** (adds the human `npm publish --tag latest` with 2FA, `dist-tags` verification, then the GitHub Release). The mode is recorded in the milestone/plan.
8. **Learn.** After a release (or a wave that went sideways) run `/retro`: mechanical mistakes become deterministic checks (scripts, CI jobs, preflight), judgement calls become written standards. Periodically run `/improve-codebase-architecture` for deepening opportunities and `/domain-modeling` to keep the vocabulary and ADRs (2.3.0) honest.

## Decision table

| Situation | Flow |
|---|---|
| Raw external issue | `/triage` → then plan |
| Design question you cannot settle on paper | `/grill-with-docs`, detour through `/prototype` if it needs a runnable answer |
| Multi-session feature | `/to-spec` → `/to-tickets` → `/implement-spec` |
| Small fix with acceptance criteria | ticket → `/implement` (+ `/tdd`) |
| Architecture epic / parallel missions | Tower plan → missions → review gate → merge |
| Something broken, cause unknown | `/diagnosing-bugs` (tight red loop first) |
| Repeated mistakes | `/retro` → checks/standards |
| Release | release plan: tag-only or publish |

## Invariants

- One ticket per PR series; a branch never touches two tickets.
- Tracked blocking edges, not prose: work only the frontier.
- Tower missions: `scope` is the write fence, a mission that outgrows it is re-scoped, not silently widened; the workspace lock keeps one Tower session per repository.
- Human-only gates: npm publish/2FA, branch-protection changes, anything behind a third-party credential. Stop and hand over rather than inventing a credential path.
- Context hygiene: keep planning in one window until tickets exist; start each implementation unit from the ticket, not from the previous unit's context.
