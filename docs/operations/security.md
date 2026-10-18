# Security model

Tower's guarantees are **coordination guarantees**, not a sandbox. Understand what is enforced where.

## Enforced by the plugin

- **Review binding (when review is enabled).** `tower_review` records the branch tip it inspected;
  with `review.requireReview:true`, the gate rejects a moved tip (`tip-moved`) unless a clean
  conflict-free rebase waived it. A reviewer that modifies the branch after spawning is rejected
  (`reviewer must not modify the mission branch`).
- **Review is optional by default, enforceable by config.** `review.requireReview:false` is the
  default; set it to `true` to enforce the independent-review gate. Mission-level
  `reviewPolicy:"none"` + reason is the narrower exemption when the global gate is on. With the gate
  off, separation of duties is not enforced by the plugin; use it only for trusted or human-supervised
  repositories.
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
- **Worktree isolation.** Workers operate in a dedicated worktree and branch; the main checkout is only
  touched by merge/teardown.
- **Mode control is explicit and configurable.** `/tower` is always available. With
  `mode.allowAgentControl:true` (the default), the model may also enter/leave with `tower_control` and
  a mandatory reason; every change records actor/reason. Set it to `false` for human-only mode control.
  The point is an attributable change, not a particular owner.
- **No automatic goal resume.** Entering pauses the active goal; leaving does not resume it.
- **Advisory workspace lock.** `mode.workspaceLock` prevents two Tower sessions from accidentally driving
  one repository; it is a same-user coordination lock, not authentication between users.
- **Test discovery is repository code.** `tower_test`/`tower_complete` execute `package.json`
  `tower.testDiscovery` commands in the mission worktree with the DSH process's OS permissions. Set
  `tests.allowPackageDiscovery:false` for untrusted repositories; output/time budgets fail closed but are
  not a sandbox.
- **Review exemption is opt-in.** `reviewPolicy:"none"` requires `gates.allowReviewExemption:true` and a
  non-empty reason. It is off by default because a model-driven tower could otherwise self-exempt; the
  exemption and its reason are recorded in state/events and never granted to workers.
- **Leases are coordination, not quotas.** `tower_resource` prevents accidental co-scheduling via a local
  JSON ledger; it does not cap CPU, memory, or process count. DSH exposes no public Job-object quota API,
  so OS-level isolation remains a deployment concern.
- **Legacy import is read-only.** Imported snapshots live under the canonical state directory and are never
  activated, adopted, or resumed; an operator must explicitly re-plan/migrate work.

## Not enforced by the plugin (deployment concerns)

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
- **HMR reload.** With `dev.hotReload`, `/tower reload`/`tower_reload` asks DSH to re-import the plugin
  from disk. Only enable HMR watch roots for checkouts you trust; a reload executes the current files.
- **Prompt injection.** The reviewer reads untrusted branch content (diff/comments). The read-only preset
  limits impact, but no model-side protection is absolute.
- **Base branch protection.** Tower writes to the local base branch; server-side branch protection/push
  rules are not part of the plugin.

## Reporting

Do not paste secrets, tokens, or session logs in public issues. See [SECURITY.md](../../SECURITY.md).
