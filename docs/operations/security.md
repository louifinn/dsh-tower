# Security model

Tower's guarantees are **coordination guarantees**, not a sandbox. Understand what is enforced where.

## Enforced by the plugin

- **Review binding (when required).** `tower_review` records the branch tip it inspected; with
  `review.mode:required`, the gate rejects a moved tip (`tip-moved`) unless a clean conflict-free
  rebase waived it. A reviewer that modifies the branch after spawning is rejected
  (`reviewer must not modify the mission branch`).
- **Review is optional by default, enforceable by the tri-state policy.** `review.mode` is `off`,
  `optional` (the default) or `required`. Set it to `required` to enforce the independent-review gate.
  Mission-level `reviewPolicy:"none"` + reason is the narrower exemption when the policy is required.
  With `off`, review is intentionally unavailable; with `optional`, separation of duties is not
  enforced by the plugin, so use it only for trusted or human-supervised repositories. The policy is
  one control on the plugin page, not a component row.
- **Role enforcement.** The caller is resolved against the roster. Worker mission updates are limited to
  task/blocker/note; `completed`, `abandoned`, scope widening and blocker clearing are tower-only, and
  completion (with its unread-inbox/commit gates) must go through `tower_complete`. Tower-only tools reject
  roster workers with `[tower:not-authorized]`. One live worker per mission; taking over a stopped worker
  is explicit.
- **Read-only reviewer preset.** The `tower-reviewer` preset removes `write`, `edit`, `pwsh`,
  `tower_mission` and `tower_complete` from the tool surface; reviewers can only read, diff, message,
  file findings, and submit a review.
- **Scope gate.** A mission may only change files matched by its declared scope globs; out-of-scope
  changes block the merge.
- **Mode control is explicit and configurable.** `/tower` is always available. With
  `mode.allowAgentControl:true` (the default), the model may also enter/leave with `tower_control` and
  a mandatory reason; every change records actor/reason. Set it to `false` for human-only mode control.
  The point is an attributable change, not a particular owner.
- **No automatic goal resume.** Entering pauses the active goal; leaving does not resume it.
- **Advisory workspace lock.** `mode.workspaceLock` prevents two Tower sessions from accidentally driving
  one repository; it is a same-user coordination lock, not authentication between users.
- **Test discovery is repository code.** `tower_test`/`tower_complete` can execute `package.json`
  `tower.testDiscovery` commands in the mission worktree with the DSH process's OS permissions.
  `tests.admission` defaults to `off`, so this happens only on an explicit `tower_test`; set
  `tests.allowPackageDiscovery:false` for untrusted repositories. Output/time budgets fail closed but
  are not a sandbox.
- **Review exemption is opt-in.** `reviewPolicy:"none"` requires `gates.allowReviewExemption:true` and a
  non-empty reason. It is off by default because a model-driven tower could otherwise self-exempt; the
  exemption and its reason are recorded in state/events and never granted to workers.
- **Leases are coordination, not quotas.** `tower_resource` prevents accidental co-scheduling via a local
  JSON ledger; it does not cap CPU, memory, or process count. DSH exposes no public Job-object quota API,
  so OS-level isolation remains a deployment concern.
- **Legacy import is read-only.** Imported snapshots live under the canonical state directory and are never
  activated, adopted, or resumed; an operator must explicitly re-plan/migrate work.

## Repository protection

This section is about **this repository**, not about a repository Tower runs on. Server-side branch
protection is not a plugin feature — Tower writes to the local base branch and cannot configure a
remote — but `dsh-tower` enables it for its own `main`, because the code that is the gate is also the
code an attacker would most want to change:

- `main` requires a pull request for every change, **enforced for admins**, so a direct push is
  rejected even for the maintainer.
- Required checks are `test (22)`, `test (24)` and `mount`. The mount job packs the tarball and boots
  it in a throwaway profile, so "the tests pass" cannot land a bundle that fails to appear after
  `dsh plugin add`.
- Force-push and branch deletion are blocked, so history cannot be rewritten under a published tag.
- There are no mandatory approvals: with one maintainer, a self-approval requirement would be a rubber
  stamp. The evidence instead is the four-line PR body (failure mode, change, test, blast radius) for
  the two-key paths, written in [CONTRIBUTING.md](../../CONTRIBUTING.md#landing-changes).

What this buys: no untested change reaches `main`, a red or missing required check cannot be bypassed
by the owner, and history is append-only. What it does **not** buy: a second reader, protection against
a compromised maintainer token, or any protection for the repositories Tower itself operates on — those
remain deployment concerns. The settings, their rationale and a verification command are recorded in
[SECURITY.md](../../SECURITY.md#repository-protection-on-main).

## Model-initiated mode entry (threat model)

`mode.allowAgentControl:true` means a prompt injection in a repository file, issue text, or fetched
page can ask the model to “enter tower mode and fix this”. Tower does **not** authenticate the human
intent behind that entry. What it does provide:

- the entry is recorded with actor, action, reason, and timestamp; `tower_status.mode.history`
  surfaces the recent transitions without grepping the activity log;
- the model cannot merge without the preflight gate, review policy, scope checks, tests, and
  clean-base checks; writing the plan does not bypass them;
- workers are tool-restricted and instructed to stay in their worktree, but the main-checkout
  protection is enforced by scope/merge checks and the preset, **not** by an OS sandbox;
- `mode.workspaceLock` prevents a second Tower session from driving the same repository.

It does **not** defend against: a model that legitimately passes every gate while acting on malicious
instructions; repository hooks or test commands the repository itself declares; or filesystem/shell
access outside the worktree by a worker that ignores its instructions. For a higher-assurance team,
set `mode.allowAgentControl:false`, keep the review policy at `review.mode:required`, review the
repository before Tower work, and run the host under OS-level isolation.

## Not enforced by the plugin (deployment concerns)

- **Worktree isolation is a protocol convention, not an OS sandbox.** Workers are assigned a dedicated
  worktree and branch and told to stay there, but the `tower-worker` preset still includes `pwsh`,
  `write`, and `edit`; those tools can write absolute paths or run Git in the main checkout. The scope
  gate checks the committed branch diff, not filesystem access. For hard isolation use a container,
  separate OS user, or a restricted host tool policy.
- **Sandboxing.** Host plugins run outside the filesystem sandbox; the reviewer's shell ability is
  removed at the tool-surface level, but the underlying process still has whatever OS permissions DSH
  has. Deployments that need hard isolation must restrict the process/user themselves.
- **Reviewer trust.** A review is an attestation by the reviewer agent/model; the plugin binds it to a
  commit but cannot prove the reviewer actually reasoned correctly. Use independent models/roles for
  high-value branches.
- **Repository hooks.** `git merge` runs the target repository's hooks (`pre-merge-commit` etc.). Tower
  cannot make those safe; review hooks before running Tower on an untrusted repository.
- **Package test commands.** Declared discovery commands have the same trust as repository hooks; a
  malicious `package.json` can run code. Disable `tests.allowPackageDiscovery` and review the file.
- **HMR reload.** With the `tower-hmr` component row on, `/tower reload`/`tower_reload` asks DSH to re-import the plugin
  from disk. Only enable HMR watch roots for checkouts you trust; a reload executes the current files.
- **Prompt injection.** The reviewer reads untrusted branch content (diff/comments). The read-only preset
  limits impact, but no model-side protection is absolute.
- **Base branch protection.** Tower writes to the local base branch; server-side branch protection and
  push rules are not part of the plugin. This repository's own `main` protection is described in
  [Repository protection](#repository-protection); enabling equivalent protection on the repository you
  run Tower on remains a deployment concern.

## Reporting

Do not paste secrets, tokens, or session logs in public issues. See [SECURITY.md](../../SECURITY.md).
