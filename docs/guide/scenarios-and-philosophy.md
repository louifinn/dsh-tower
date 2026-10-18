# When to use Tower, and how it differs from other workflows

[简体中文](../zh/guide/scenarios-and-philosophy.md)

Tower is not a replacement for every multi-agent pattern. It is a **delivery protocol for changes to a
Git repository**: a small number of bounded missions, isolated writers, optional independent review,
evidence, and a merge gate. This page explains the design choices behind it, the situations where it
pays off, and when Agent Teams, Ralph loops, Workflow orchestration, or ordinary parallel subagents are
a better fit.

If you only remember one sentence: **use Tower when the output is an integrated repository change that
must land through a controlled merge; use the other patterns when the output is exploration, repeated
attempts, or programmatic fan-out.** Enable `review.requireReview` when the change also needs an
independent reviewer.

## 1. The design philosophy

Tower makes several deliberate trade-offs. They explain both its strengths and its cost.

### 1.1 The repository is the unit of accountability

A mission is not a chat thread or a task card. It is a contract attached to a branch and a worktree,
with a declared write scope, dependencies, completion evidence, and an optional review record. The
question "what changed, who changed it, and what proved it?" has a durable answer in
`<git-common-dir>/dsh-tower/state.json` and the Git history, not only in a conversation.

### 1.2 One writer per mission

Two agents writing the same branch at the same time produce races that no review can repair. Tower
enforces one live worker per mission, explicit takeover after a stop/interrupt, and a per-repository
worker cap. Parallelism comes from **separate missions**, not from several writers on one mission.

### 1.3 Contract before code

Planning fixes the scope, tasks, dependencies, and review policy before a worker starts. That
front-loading is intentional: it lets the tower detect overlapping scopes, serialize dependent work,
and tell a reviewer exactly what "done" means. It is also why Tower is a poor fit for work whose
requirements are still being discovered.

### 1.4 Integration is a separate, privileged step

Workers never merge. The tower runs preflight; only then does `tower_merge` perform a `--no-ff` merge.
The gate re-checks scope, base freshness, tasks, worktree ownership, worker state, tests, and evidence.
When review is enabled, a reviewer also inspects a specific branch tip and the gate checks the review
binding. Separation of duties is the point when review is on: the agent that wrote the code is not the
agent that approves it, and neither is the agent that merges.

Independent review is optional by default: `review.requireReview:true` enforces it (and then a complete
mission must carry a clean, merge-approved review from a reviewer bound to the branch tip). Set the flag
to `true` for sensitive repositories; `reviewPolicy:"none"` + a reason + `gates.allowReviewExemption:true`
remains available as a per-mission exemption when the global gate is on. Reviews can be submitted and
recorded either way.

### 1.5 Evidence over assertion

"Done" is a claim; a commit, a diff, a passing test receipt, and an independent review are evidence.
Tower records all of them. `tower_doctor` checks the environment, `tower_test` records discovery,
`tower_complete` records checks, `tower_review` binds a verdict to a commit, and `tower_batch` can
close a finite set of missions only when their required evidence exists.

### 1.6 Fail closed, recover explicitly

Tower prefers a visible blocker over a silent repair. A stale worker is marked, not assumed dead; a
dirty base blocks a merge; with the review gate on, a moved review tip blocks a merge; a crash during
merge leaves a persistent intent that the next `tower_merge` reconciles. The cost is occasional manual
cleanup; the benefit is that state never lies about what was integrated.

### 1.7 The human owns the mode

Tower mode changes the session's stance: it narrows the tool surface and injects the mission protocol.
The shipped patch allows the model to toggle it with a stated reason, but the mode exists because a
human asked for delivery discipline. Entering pauses an active goal and clears plan mode; leaving does
not silently resume either. Tower intentionally refuses `goal`, `todo`, Team task-board, Workflow,
Ralph, and ordinary subagent tools while it is active, so two orchestration protocols do not fight over
one session.

### 1.8 Local-first, no hidden service

Tower is a Host plugin. It uses local Git, local files, and the DSH subagent service. It does not push,
does not call a cloud service, and does not send telemetry. The durable state lives in the repository's
Git metadata, so it survives restarts and is visible to a human with ordinary Git tools.

## 2. Situations where Tower is a good fit

The table is the quick version; the subsections below explain each row.

| Situation | Concrete example | Why Tower |
|---|---|---|
| A feature with independent slices | Add OAuth: `token model` → `callback route` → `UI button` + a migration, four missions with mostly separate scopes | Isolated writers, scope reservation, one final review/merge |
| Ordered refactor/migration | Rename `oldApi` across a monorepo: codemod → import cleanup → snapshots → docs, each depending on the previous merge | `deps`, branch freshness, serialized merges |
| Investigation then change | A survey mission maps every caller of a deprecated crypto API; two build missions migrate and test | Survey cannot mutate; findings feed build missions |
| Sensitive or release-bound change | A payments service change or a public library release needing test evidence and an auditable merge (enable review for an independent verdict) | Checks/runs, optional review binding, human-readable audit |
| Long-running work | A multi-day dependency upgrade interrupted by restarts and context resets | Durable mission/roster/review/worktree state |
| Hard integration boundary | Four services in one monorepo, each with an owner, then one release review | Parallel missions with a single merge gate |
| Checkable definition of done | A task list plus required tests plus an optional independent review verdict | Completion/review evidence is visible to another agent |

### 2.1 A feature that naturally splits into independent slices

Example: add OAuth login, split into "token model", "callback route", "UI button", and "migration +
tests". The slices touch mostly different files, can run in parallel, and need a final integration
review. Tower's scope reservation and automatic dependency for overlapping scopes keep the slices from
colliding.

**Why Tower:** parallel writers are isolated; each slice has an owner and a review; the merge is
gated once, not improvised per slice.

### 2.2 A migration or refactor with ordering constraints

Example: rename a package, update imports, regenerate snapshots, then update documentation. Some work
can proceed in parallel, but later missions depend on earlier merges. Tower records `deps`, refuses to
merge a mission whose dependency is not merged, and lets the tower check `tower_status`/preflight
instead of remembering the graph in chat.

**Why Tower:** the dependency graph and branch freshness are enforced, not advisory.

### 2.3 Work that needs a read-only investigation before a change

Example: "find every caller of this API and write a migration plan" followed by "apply the migration".
A `survey` mission reserves no write scope and is rejected if it changes files; its findings can feed
the build missions. Tower can also keep findings (`tower_finding`) outside a mission's scope without
silently widening it.

**Why Tower:** investigation and mutation have different contracts; the survey cannot accidentally
"fix" something.

### 2.4 A sensitive repository or a release-bound change

Example: a payments service, a library with external users, or a release branch. You want test
evidence and a human-visible audit trail; when review is enabled, you also get an independent reviewer
and a verdict bound to a specific reviewed commit.

**Why Tower:** evidence gates, `MISSIONS.md`, and the activity log give you a defensible record;
when review is enabled, the reviewer is a separate read-only agent, not the author, and the verdict is
bound to the tip.

### 2.5 Long-running work that spans context compaction or restarts

Example: a multi-day refactor interrupted by restarts, new sessions, or a context reset. The mission
state, roster, inbox, reviews, and worktrees are durable; `tower_adopt` reconciles a lost roster;
`tower_doctor` reports what is broken; `tower_merge` reconciles an already-landed merge.

**Why Tower:** the protocol is reconstructable from local state and Git, not from a conversation
window.

### 2.6 Parallel work with a hard integration boundary

Example: four independent services in one monorepo, each with its own owner, all needing a final
release review. Tower gives each mission a branch/worktree and reserves write scopes; the tower can
then audit a finite batch (`tower_batch`) before declaring the release ready.

**Why Tower:** parallelism is real, but integration remains a single, gated step.

### 2.7 When you need a "definition of done" that another agent can check

Example: a task list plus tests plus a required review verdict. Tower's mission contract and
completion/review tools make "done" observable. If your definition of done is "the user likes it in
the chat", Tower is overhead.

## 3. Situations where Tower is a poor fit

| Situation | Better fit | Why |
|---|---|---|
| One-file edit, typo, small hotfix | Ordinary agent in a single session | Worktree and merge overhead (plus review when enabled) dominate. |
| Requirements are still being discovered | Ordinary agent, Plan mode, or Agent Teams | Tower asks for scope/tasks before work; a wrong contract causes re-planning. |
| Open-ended research or brainstorming | Agent Teams, Workflow, or plain subagents | There is no repository change to isolate or merge. |
| Many tiny independent tasks | Workflow or plain parallel subagents | Per-mission merge cost (and review when enabled) is too high. |
| Interactive UI pairing / exploratory debugging | Ordinary agent (or a single worker) | Tight feedback loops and frequent human steering; an enabled review gate adds latency. |
| A one-shot generation with no integration | Plain subagent/Workflow | No branch, no review, no merge decision. |
| Cross-repository product work | Agent Teams + ordinary tools | Tower is scoped to one Git repository. |

A useful heuristic: **if you would not open a pull request for it, Tower is probably too heavy.**

## 4. How Tower differs from other DSH workflow patterns

All of these patterns can use the same subagent runtime. They differ in **what is durable, who owns
integration, and what "done" means.**

| Dimension | Tower | Agent Teams | Ralph loop | Workflow orchestration | Ordinary parallel subagents |
|---|---|---|---|---|---|
| Primary goal | Deliver integrated repository changes (optional independent review) | Collaborate across people/agents on a shared goal | Repeated fresh attempts at one objective | Programmatic fan-out/pipeline of agent work | Explore or implement in parallel |
| Unit of work | Mission (branch + worktree + scope + tasks + review) | Task/teammate on a shared board | Round/attempt | Scripted step/stage | Prompt/task per child |
| Isolation | Git worktree + branch per mission; one writer per mission | Shared workspace; coordination by task ownership | Fresh child per round; no built-in branch/merge contract | Per-step child; no Git isolation | Child sessions; may share workspace |
| Durable state | Git metadata + JSON state + activity + board | Team task board + sessions | Minimal; each round starts fresh | Run record/results; not a merge ledger | Session/subagent records |
| Integration authority | Tower only, after preflight/gate (plus review when enabled) | Humans/teammates merge or edit manually | Usually the parent/worker applies results | Script applies results | Parent applies results |
| Review / gate | Optional independent review (enable `review.requireReview`) + preflight/merge gate | Review is a collaboration convention, not a hard gate | No built-in review gate | No built-in review gate | No built-in review gate |
| Parallelism | Multiple missions, disjoint scopes, serialized merges | Many teammates, shared board | Sequential rounds (or external fan-out) | High fan-out, script-controlled | High fan-out |
| Human role | Owns the mode; can inspect evidence and release | Collaborator/coordinator | Author of the repeated objective | Author of the orchestration script | Delegator |
| Best for | Feature delivery, migrations, release-bound changes | Design, research, cross-cutting collaboration | Iterative search/repair with fresh context | Large audits, batch analysis, deterministic pipelines | Quick exploration or independent subtasks |
| Main cost | Mission/review/merge overhead; merge serialization | Coordination overhead; no isolation guarantee | Repeated work; weak integration contract | Script complexity; no review/merge semantics | No isolation/review; manual integration |

### 4.1 Tower vs ordinary parallel subagents

Ordinary `subagent`/`subagent_fork` calls are cheap and flexible. They are the right tool for "read
these five files in parallel" or "try three approaches". They do not provide a write scope, a
dedicated worktree, a durable mission, independent review, or a merge gate. Tower wraps the same
subagent primitive in those contracts; it also costs more per child. (Review is optional: enable
`review.requireReview` when you need the reviewer role.)

Choose subagents when the work is read-mostly, short-lived, or you will integrate the result
yourself. Choose Tower when the result must land on a branch under a controlled merge; enable review
when it must also survive independent review.

### 4.2 Tower vs Agent Teams

Agent Teams is a **collaboration** pattern: a shared task board, durable teammates, messages, wait
and interrupt, and a human/Lead coordinating work. It is excellent when the work is cross-cutting,
exploratory, or needs several perspectives, and when the integration decision is human.

Tower is a **delivery** pattern: mission contracts, Git isolation, an optional review gate, and a hard
merge gate. It has less flexible peer-to-peer coordination and more structure. Agent Teams can decide
*what* to build and *whether* to proceed; Tower can then execute that decision as missions. They are
sequential or complementary, not concurrent: Tower mode refuses the Team task-board tools so the two
protocols do not compete for the same session.

### 4.3 Tower vs Ralph loop

Ralph runs the **same objective** through fresh agents, round after round, with the workspace as
memory. It is useful for iterative search, flaky repair, or "try again with fresh context". It has no
mission contract, no independent review, and no merge gate.

Tower is incremental: each mission has a bounded deliverable and lands through the merge gate (with
review when enabled). If the problem is "I do not know whether this can be done, and repeated fresh
attempts may find a way", Ralph is often better. If the problem is "I know the slices; build and
integrate them safely", Tower is better.
You can use Ralph outside Tower mode to find an approach, then encode the result as Tower missions.

### 4.4 Tower vs Workflow orchestration

Workflow is **programmatic orchestration**: a JavaScript script fans work out across many subagents
with phases, pipelines, and structured results. It is excellent for audits, migrations of many
independent items, multi-angle research, and adversarial verification. It does not give each step a
Git worktree, a review verdict, or a merge gate.

Tower is a **repository delivery protocol** with a small number of missions, not a high-fan-out data
plane. Use Workflow for "analyze 200 files in parallel"; use Tower for "make the 6 changes those
analyses justify, with an optional review and a merge gate". Tower mode refuses Workflow so a script
cannot spawn competing writers under the Tower contract.

### 4.5 Tower vs Plan mode

Plan mode is for deciding what to do; Tower is for executing a decided plan against a repository.
Tower entry clears an active plan (or refuses entry under `mode.planModePolicy:"refuse"`), and a
Tower session cannot use the goal/todo/team/workflow tools. Plan first, then execute; do not expect
Tower to discover the plan for you.

### 4.6 Review is optional by default

`review.requireReview:false` is the default, so a completed mission can merge without a reviewer for
low-risk repositories, scratch work, or human-supervised sessions. Set it to `true` to enforce the
independent review gate; the gate then re-checks `no-review`, `not-clean`, `review-hold`,
`review-not-approved`, `tip-moved`, and `review-mission-mismatch`. `tower_review` is always available
and records verdicts even when the gate is off. For one mission only, with the global gate on, set
`reviewPolicy:"none"` + a reason and `gates.allowReviewExemption:true`.

### 4.7 Concrete examples by workflow

**Tower** — output is a repository change that must land through isolation and a merge gate:

- **OAuth login**: four missions (`token model`, `callback route`, `accept/decline API`, `UI`); the API depends on tokens and email.
- **Node 18 → 22 upgrade**: survey breaking API usages, then codemod, test updates, CI config, release notes as separate missions.
- **Deprecated crypto migration**: a read-only survey mission maps call sites; build missions replace them package by package.
- **Release hardening**: three missions for the change, migration guide, and release notes; close a `tower_batch` with required tests before tagging.
- **Monorepo service split**: one mission per package with disjoint scopes; a final review mission checks integration.

**Agent Teams** — output is a decision, design, or cross-cutting collaboration, not a single mergeable branch:

- Architecture review with a backend, frontend, and security teammate, each contributing findings to a shared board.
- Incident postmortem: one teammate reconstructs the timeline, another checks logs, a third drafts actions.
- Product requirements discovery: several perspectives converge on a spec; the human decides what to build.
- Cross-repository investigation where there is no single repo to isolate or merge.

**Ralph loop** — output is a better attempt at the *same* objective, with fresh context:

- A flaky test that needs several independent attempts to reproduce and fix.
- Performance optimization where each round tries a different hypothesis against an eval.
- "Find any working approach" exploration where the parent does not know the path.
- Repeated prompt/skill tuning until an eval threshold is met.

**Workflow orchestration** — output is a large, programmatic fan-out or pipeline:

- Audit 200 files for unsafe API usage and produce a structured report.
- Run a dependency upgrade matrix across many packages/versions in parallel.
- Multi-angle research or adversarial verification of a proposal.
- Generate/translate/test many independent artifacts and aggregate the results.

**Ordinary parallel subagents** — output is quick parallel read-mostly work or independent explorations:

- Read five candidate files in parallel and summarize each.
- Try three implementations of the same function and compare.
- Scan a repo for a risky pattern without changing it.
- Run independent document lookups before the parent writes the answer.

**Mixed phases (recommended)** — analyze with Workflow/Teams, then deliver with Tower:

1. Workflow audits 200 files → structured findings.
2. Agent Teams reviews the findings and decides the top six changes.
3. Tower missions implement those six changes with optional review and a merge gate.
4. Ralph is used after merge only for a stubborn flaky test that does not need a new mission contract.

## 5. Worked scenarios

### Scenario A: four-slice feature

A team wants "organization invitations": token model, email delivery, accept/decline API, and UI.

1. Plan four build missions with scopes `src/tokens/**`, `src/email/**`, `src/api/invites/**`,
   `src/ui/invites/**`; make the API depend on tokens and email.
2. Spawn workers for the independent missions; the API waits for its deps.
3. Each worker commits on its branch, completes with checks.
4. With `review.requireReview:true`, spawn reviewers and require a clean+merge verdict; otherwise
   review is optional.
5. `tower_preflight` and `tower_merge` each mission; resolve scope/base/review blockers.
6. `tower_teardown`; `MISSIONS.md` is the human-readable record.

**Why not Team/Workflow?** The work is a known set of repository changes that must land in a specific
order under a merge gate (and optional independent review). Team tasks would not isolate writes;
Workflow would analyze but not gate the merge.

### Scenario B: migration with a survey

1. Survey mission: "map all callers of `oldApi`"; scope empty, read-only.
2. Build missions: codemod, test updates, docs; depend on the survey's findings.
3. With review enabled, reviewers check the diff against the survey; the tests gate still validates the
   current branch tip. With the default optional review, skip the reviewer and rely on the same gate/tests.
4. Merge in dependency order.

**Why not plain subagents?** The survey must not accidentally mutate; the codemod must not touch
out-of-scope files; with review enabled, the review must bind to the exact commit.

### Scenario C: incident hotfix

A one-line fix in production. Use an ordinary agent, commit and push through your normal process.
Tower would add a worktree, a merge gate, and (if enabled) a reviewer; for a one-line urgent fix that
is mostly latency. If the "hotfix" is actually several coordinated changes, Tower becomes reasonable.

### Scenario D: broad codebase audit

"Find every use of deprecated crypto and summarize risk." Use Workflow or parallel subagents; there
is no branch to merge and no single reviewed change. If the audit produces a set of fixes, create
Tower missions from those findings.

### Scenario E: sensitive release

A library release with external consumers. Plan missions for the change, migration guide, and
release notes; enable `review.requireReview:true` if the release requires independent review, require
tests, and use `tower_batch` to close the release evidence only when all required checks are present;
merge and tag outside Tower as your release process requires.

## 6. Choosing in practice: a short decision path

1. **Is the output a Git change?** No → use ordinary agents, Agent Teams, Workflow, or Ralph.
2. **Would you open a PR for it?** No → Tower is too heavy; use a normal agent.
3. **Do the slices have stable scopes and a known definition of done?** No → plan/explore first; then
   return to Tower.
4. **Do you need a merge gate?** Repository changes with integration risk → Tower. Enable
   `review.requireReview:true` if you also need independent review. If neither isolation nor evidence
   is needed, plain subagents may be enough.
5. **Do you need many parallel analyses or repeated fresh attempts?** Use Workflow/Ralph for that
   phase; encode the resulting changes as Tower missions.
6. **Do you need cross-cutting human collaboration?** Use Agent Teams to decide; execute the decided
   repository work with Tower.

## 7. Cost, limits, and anti-patterns

- **Per-mission overhead is real**: worktree creation, spawn, completion checks, an optional review
  round, gate, merge. Keep missions meaningful (roughly a PR-sized slice), not one task per function.
- **Merges serialize**: overlapping scopes auto-add dependencies; independent missions still merge
  one at a time onto the base. Do not expect linear speedup for merge-heavy work.
- **Review is not free when enabled**: each mission then needs a reviewer and a clean verdict.
  `review.requireReview:false` (the default) makes review optional; when the gate is on, exemptions
  are opt-in and require a reason.
- **Too-fine missions** increase coordination and merge cost. **Too-coarse missions** lose the benefit
  of parallel review and make scope conflicts likely.
- **Tower is not a sandbox**: it is a coordination protocol. Host permissions, repository hooks, and
  test commands still execute with the DSH user's OS permissions.
- **Do not run two orchestration protocols at once**: Tower mode denies Team/Workflow/Ralph/subagent
  tools and clears plan mode. Sequence the phases instead.
- **Do not use Tower to hide missing requirements**: a wrong mission contract produces a wrong branch
  that then fails review. Explore first.

## 8. Checklist before you start

- [ ] The work produces a repository change that deserves a PR-style review.
- [ ] I can name 2–8 missions with non-overlapping scopes and a rough dependency order.
- [ ] Each mission has a testable definition of done (tasks, checks/tests, optional review).
- [ ] If this change needs independent review, `review.requireReview` is on (default is off).
- [ ] I know which missions can run in parallel and which must wait.
- [ ] I accept the merge-gate overhead (and review overhead if enabled) and will inspect
      `MISSIONS.md`/the branch.
- [ ] I am not currently relying on a Team task board, Workflow script, Ralph loop, or plan mode in
      the same session.
- [ ] I have a recovery path if a worker stalls (interrupt/adopt) or a merge conflicts.

If most boxes are checked, Tower is likely a good fit. If not, use the lighter patterns and come back
when the change is shaped.
