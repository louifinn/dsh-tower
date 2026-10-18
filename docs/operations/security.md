# Security model

Tower's guarantees are **coordination guarantees**, not a sandbox. Understand what is enforced where.

## Enforced by the plugin

- **Review binding.** `tower_review` records the branch tip it inspected; the gate rejects a moved tip
  (`tip-moved`) unless a clean conflict-free rebase waived it. A reviewer that modifies the branch after
  spawning is rejected (`reviewer must not modify the mission branch`).
- **Read-only reviewer preset.** The `tower-reviewer` preset removes `write`, `edit`, `pwsh`,
  `tower_mission` and `tower_complete` from the tool surface; reviewers can only read, diff, message,
  file findings, and submit a review.
- **Scope gate.** A mission may only change files matched by its declared scope globs; out-of-scope
  changes block the merge.
- **Worktree isolation.** Workers operate in a dedicated worktree and branch; the main checkout is only
  touched by merge/teardown.
- **Human-owned mode.** `/tower` is user-owned. With `mode.allowAgentControl` the model may toggle it,
  but must state a reason; the shipped patch enables that by default — set it to `false` to make the
  mode human-only.
- **No automatic goal resume.** Entering pauses the active goal; leaving does not resume it.

## Not enforced by the plugin (deployment concerns)

- **Sandboxing.** Host plugins run outside the filesystem sandbox; the reviewer's shell ability is
  removed at the tool-surface level, but the underlying process still has whatever OS permissions DSH
  has. Deployments that need hard isolation must restrict the process/user themselves.
- **Reviewer trust.** A review is an attestation by the reviewer agent/model; the plugin binds it to a
  commit but cannot prove the reviewer actually reasoned correctly. Use independent models/roles for
  high-value branches.
- **Repository hooks.** `git merge` runs the target repository's hooks (`pre-merge-commit` etc.). Tower
  cannot make those safe; review hooks before running Tower on an untrusted repository.
- **Prompt injection.** The reviewer reads untrusted branch content (diff/comments). The read-only preset
  limits impact, but no model-side protection is absolute.
- **Base branch protection.** Tower writes to the local base branch; server-side branch protection/push
  rules are not part of the plugin.

## Reporting

Do not paste secrets, tokens, or session logs in public issues. See [SECURITY.md](../../SECURITY.md).
