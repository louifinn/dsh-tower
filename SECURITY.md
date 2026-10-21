# Security policy

## Scope

`dsh-tower` runs inside a local DeepSeek Harness process. It does not send data to any network service of its own: mission state is written under the target repository's `.git/dsh-tower/`, and Tower-mode state is written under `$DSH_HOME/tower-mode/`.

Areas that matter for security reports:

- The merge gate (`tower_preflight` / `tower_merge`): bypassing scope, review, staleness, or ownership checks.
- The mode guard: reaching a denied tool (`create_goal`, `todo_write`, Team task tools, `spawn_teammate`, `update_goal(resume)`) while Tower mode is active.
- Command forwarding: injecting content into the model history that the user did not send.
- Writes outside the declared scope, the mission worktree, or the DSH home directory.

## Reporting

Please do **not** publish exploit details in a public issue. Open a minimal issue titled `security: request private contact` describing only the impact category (for example “merge gate bypass”), and a maintainer will arrange a private channel. Include the affected version and, if possible, a minimal reproduction in the private follow-up.

## Supported versions

Security fixes target the latest released `2.x` line (currently `2.0.4`). Older pre-release snapshots
are not maintained. Private reports are acknowledged in the minimal public issue and handled through
the maintainer's private channel; do not attach exploit details, tokens, or production logs to a
public issue.
