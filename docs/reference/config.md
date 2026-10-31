# Config reference

Every key is optional; defaults reproduce the shipped behavior. Unknown top-level keys are rejected.
`section` and `allowAgentControl` are legacy aliases for `mode.promptSection` and
`mode.allowAgentControl`. A legacy alias only fills a gap: when both forms are set, the canonical
`mode.*` key wins.

## Layers and precedence

Lowest precedence first:

1. code defaults (the table below),
2. profile config (the Cordis patch that mounts `dsh-tower` passes it to `apply()`),
3. repository config at `<git-common-dir>/dsh-tower/config.json` (usually `.git/dsh-tower/config.json`),
4. per-call tool arguments such as `worktreeRoot` and `timeoutMs`.

The repository layer is read every time a Tower tool opens a repository, so a repository can tune
review, merge, worktree and spawn policy without editing the profile. It uses the same JSON shape as
the profile config (the same groups and the legacy aliases) and is merged group by group: repo keys
win, profile keys survive when the repo does not set them. `tower_status` reports
`config.path` and `config.repoConfigPresent`.

```json
{
  "review": { "requireReview": true, "maxRoundsPerReviewer": 3 },
  "merge": { "timeoutMs": 1800000 },
  "worktrees": { "root": "D:/tower-worktrees" },
  "spawn": { "reviewerPreset": "tower-reviewer", "maxDepth": 2 }
}
```

The `mode.*` group is session-scoped, not repository-scoped: it is accepted in the repository file
for schema compatibility but only the profile config controls the Tower-mode prompt and the
model-controlled toggle. A malformed file, a non-object value, unknown top-level keys, or a value that
violates the declared schema (for example `merge.timeoutMs` below 1000) fail with the stable
`config-invalid` / `config-unknown-key` tool error codes.

| Key | Default | Meaning |
|---|---|---|
| `section` | `''` | Legacy alias: replace the whole Tower-mode prompt text. Empty keeps the built-in reminder. |
| `allowAgentControl` | `true` (alias of `mode.allowAgentControl`) | Legacy alias: register `tower_control` so the model may toggle the mode. |
| `init.autoGitInit` | `false` (bundled patch: `true`) | `tower_init` may run `git init` + an empty initial commit when `repoRoot` is an absolute, existing directory that is not a repository. |
| `init.snapshotDirty` | `false` | `tower_init` may snapshot uncommitted **tracked** changes into a dangling commit used as the mission baseline (untracked files are not included; the commit is kept alive under `refs/tower/snapshot/*`). |
| `init.autoExclude` | `true` | Append in-repo artifacts (`MISSIONS.md`, in-repo worktree roots) to `.git/info/exclude`; never touches `.gitignore`. |
| `mode.promptSection` | `''` | Replacement prompt text (takes precedence over `section` when both set). |
| `mode.sectionAppend` | `''` | Extra text appended after the reminder (team conventions). |
| `mode.allowAgentControl` | `true` | Register `tower_control`; the model may enter/leave with a reason. Set `false` for human-only mode control. |
| `mode.autoPauseGoal` | `true` | Pause an active goal on entry; the goal is never auto-resumed on exit. |
| `mode.requireResumeAuthorization` | `false` | Resuming a mission paused with `pauseCause:user` requires an `authorization` reference. |
| `mode.requireHumanAckOnFirstEntry` | `false` | Require a human `/tower ack` before the model may make the first Tower-mode entry in a session. |
| `mode.workspaceLock` | `false` (bundled patch: `true`) | Allow only one Tower session per repository (`tower.lock`); others get `workspace-busy`. |
| `mode.workspaceLockScope` | `all` | `all` locks every repo tool; `mutations` skips the workspace lock for read-only tools. |
| `mode.planModePolicy` | `clear` | Tower entry clears an active plan mode (or `refuse` until the plan is exited); a pre-step also clears a plan activated later. |
| `mode.workspaceStaleMs` | `300000` | A workspace lock older than this can be taken over. |
| `mode.heartbeatMs` | `10000` | Workspace-lock heartbeat interval. |
| `mode.denyTools` | goal/todo/team/workflow/subagent tools | Tools refused while the mode is active (12 defaults). |
| `mode.storePath` | `$DSH_HOME/tower-mode` | Directory for `modes.json`. |
| `mode.maxEntries` | `200` | Maximum persisted mode entries (1–2000). |
| `review.requireReview` | `false` | Enforce an independent clean review before merge. Default `false` (review optional); set `true` to require `no-review`/`not-clean`/`review-hold`/`review-not-approved`/`tip-moved`/`review-mission-mismatch` checks. `tower_review` remains available either way. |
| `review.maxRoundsPerReviewer` | `5` | Review-round cap per reviewer per branch. |
| `merge.timeoutMs` | `900000` (15 min) | Default `tower_merge` timeout, including hooks. A per-call `timeoutMs` wins. |
| `merge.maxBufferBytes` | `67108864` (64 MB) | Merge output buffer. |
| `git.timeoutMs` | `15000` | Default timeout for Git commands other than merge; merge uses `merge.timeoutMs`. |
| `worktrees.root` | `''` | Default worktree parent; empty derives `<checkout parent>/.dsh-tower-worktrees/<hash>`. |
| `spawn.workerPreset` | `tower-worker` | Preset used for `role=worker`. |
| `spawn.reviewerPreset` | `tower-reviewer` | Preset used for `role=reviewer`. |
| `spawn.maxDepth` | `1` | Subagent depth requested at spawn. |
| `spawn.provider` | `''` | Subagent provider id; empty prefers `spawn`, then the first provider. |
| `spawn.workerModel` | `{}` | Optional `{provider, model, reasoningEffort, maxTokens}` for workers. |
| `spawn.reviewerModel` | `{}` | Optional model route for reviewers; independent review is stronger with a different model. |
| `spawn.maxLiveWorkers` | `4` | Maximum live worker entries per repository (idle `inactive`, failed, interrupted, missing, stale and retired entries do not count); exceeding it returns `worker-limit`. |
| `spawn.staleMs` | `15000` | Roster entries without catalog activity after this age are marked `stale` and block merge (`worker-stale`); 0 disables. |
| `spawn.maxWaitMs` | `90000` | Upper bound for `tower_spawn.waitMs` (Kimi-compatible 90s default). |
| `spawn.requireLease` | `''` | Optional lease name that must be held before a worker can spawn. |
| `send.maxPerMinute` | `120` | Per-repository `tower_send` rate limit (0 disables); exceeding it returns `rate-limited`. |
| `send.interruptDefault` | `false` (bundled patch: `true`) | Default for `tower_send.interrupt` (interrupt the running turn before delivering). |
| `tests.admission` | `off` | `spawn` runs discovery before starting a worker, `complete` at `tower_complete`, `off` only on explicit `tower_test` (default; repository code is not executed automatically). |
| `tests.timeoutMs` | `60000` | Per discovery command timeout. |
| `tests.maxBytes` | `16777216` (16 MiB) | Captured stdout cap per command. |
| `tests.autoChecks` | `true` | Attach an automatic `tests` check to the completion report. |
| `tests.allowPackageDiscovery` | `true` | Allow repo-controlled `tower.testDiscovery` commands (executes worktree code; see security). |
| `gates.requireChecks` | `false` | Require at least one `tower_complete.checks` entry before merge (`no-check-evidence`). |
| `gates.requireTests` | `false` | Require a passing discovery receipt for the current mission branch tip (`tests-missing`); independent of the review gate. With the `tower-tests` component row off, planning/mode entry refuse this combination with an explanation. |
| `gates.allowReviewExemption` | `false` | With `review.requireReview:true`, allow `reviewPolicy:"none"` + a non-empty reason to skip review blockers. Off deliberately; irrelevant while the global review gate is off. |
| `gates.maxReportBytes` | `32768` (32 KiB) | Hard cap in UTF-8 bytes for `tower_complete.report`. A larger report is rejected with `invalid-argument` and an actionable `nextAction` (file the full text in the mission worktree and reference its path); it is never truncated. Existing larger reports still load. |
| `docs.board` | `true` | Write `MISSIONS.md` after mutations. |
| `docs.boardLocation` | `common` | `common` = `<git-common-dir>/dsh-tower/MISSIONS.md`; `repo` = `<repoRoot>/MISSIONS.md`. |
| `archive.enabled` | `true` | Move terminal (`merged`/`abandoned`) missions whose worktree is gone into `<git-common-dir>/dsh-tower/archive/` at a mutation boundary. Archived missions keep tasks, reviews, findings and the completion report; they are moved, never deleted. |
| `archive.afterDays` | `30` | Age trigger: a terminal mission untouched for at least this many days is archived on the next mutation (`0` archives immediately). |
| `archive.maxMissions` | `100` | Cap trigger: once more than this many terminal missions are hot, the oldest eligible ones are archived until the cap holds (`0` archives every eligible terminal mission). A mission with a live worktree is never archived. |
| `leases.ttlMs` | `900000` | Default advisory lease lifetime; expiry never auto-releases. |
| `dev.reloadDelayMs` | `50` | Delay before a scheduled reload so the tool result is delivered first. Tuning inside the optional `tower-hmr` component. |
| `dev.reloadRequiredIds` | three Tower loader ids | Entry ids passed to `reconcileProfile` as required by the `tower-hmr` component. Optional component rows are deliberately not required. |

## Example

```yaml
- id: tower-host
  name: 'dsh-tower'
  config:
    mode:
      allowAgentControl: true
      sectionAppend: 'Team conventions: tests are mandatory.'
      workspaceLock: true
    review:
      maxRoundsPerReviewer: 3
    merge:
      timeoutMs: 1800000
    spawn:
      reviewerModel:
        provider: deepseek-account
        model: deepseek-flash
```

The optional capabilities (`tower-skills`, `tower-batch`, `tower-import`,
`tower-leases`, `tower-tests`, `tower-hmr`, `preset-tower-reviewer`) are switched
from the plugin page, not from a config key. The keys that used to switch them
(`tools.expose*`, `dev.hotReload`) were removed in 2.4.0 and are rejected as
unknown keys.

## Looking up the effective schema

`cordis_inspect_query` with `Config.listConfigs({ name: "dsh-tower" })` returns the projected JSON
Schema once the plugin declares `Config` (this release does).
