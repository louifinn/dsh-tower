# Security policy

## Scope

`dsh-tower` runs inside a local DeepSeek Harness process. It does not send data to any network service of its own: mission state is written under the target repository's `.git/dsh-tower/`, and Tower-mode state is written under `$DSH_HOME/tower-mode/`.

Areas that matter for security reports:

- The merge gate (`tower_preflight` / `tower_merge`): bypassing scope, review, staleness, or ownership checks.
- The mode guard: reaching a denied tool (`create_goal`, `todo_write`, Team task tools, `spawn_teammate`, `update_goal(resume)`) while Tower mode is active.
- Command forwarding: injecting content into the model history that the user did not send.
- Writes outside the declared scope, the mission worktree, or the DSH home directory.

## Repository protection on `main`

The repository's own landing path is part of the security surface, not separate from it: the merge
gate, state lock, persistence and scope code decide whether a user's repository is modified, so a bad
change there is exploitable for every repository that installs the plugin. `main` is therefore
protected with:

- a pull request required for every change, with **admins enforced** — a direct push is rejected even
  for the maintainer;
- required checks `test (22)`, `test (24)` and `mount` — the packed bundle must mount and register its
  surface before a change can merge, and a red or missing check blocks the merge;
- force-pushes and branch deletion blocked, so a released tag's history cannot be rewritten;
- no mandatory approvals and no CODEOWNERS gate. With one maintainer, self-merge is the workflow;
  what replaces the second approval is the four-line PR body for the two-key paths in
  [CONTRIBUTING.md](CONTRIBUTING.md#landing-changes).

Rationale, the enforcement boundary (server-side protection is not a plugin feature) and the list of
what the setting does **not** buy are in
[docs/operations/security.md](docs/operations/security.md#repository-protection). Verify the setting:

```bash
gh api repos/louifinn/dsh-tower/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts, strict: .required_status_checks.strict,
         admins: .enforce_admins.enabled, force_push: .allow_force_pushes.enabled,
         deletions: .allow_deletions.enabled, reviews: .required_pull_request_reviews}'
```

## Reporting

Please do **not** publish exploit details in a public issue. Open a minimal issue titled `security: request private contact` describing only the impact category (for example “merge gate bypass”), and a maintainer will arrange a private channel. Include the affected version and, if possible, a minimal reproduction in the private follow-up.

## Supported versions

Security fixes target the latest released `2.x` line (currently `2.0.4`). Older pre-release snapshots
are not maintained. Private reports are acknowledged in the minimal public issue and handled through
the maintainer's private channel; do not attach exploit details, tokens, or production logs to a
public issue.
