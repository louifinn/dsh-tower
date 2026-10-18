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
  "review": { "maxRoundsPerReviewer": 3 },
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
| `allowAgentControl` | `false` (bundled patch: `true`) | Legacy alias: register `tower_control`. |
| `mode.promptSection` | `''` | Replacement prompt text (takes precedence over `section` when both set). |
| `mode.sectionAppend` | `''` | Extra text appended after the reminder (team conventions). |
| `mode.allowAgentControl` | `false` | Register `tower_control`; the model may enter/leave with a reason. |
| `mode.autoPauseGoal` | `true` | Pause an active goal on entry; the goal is never auto-resumed on exit. |
| `mode.denyTools` | six goal/todo/team tools | Tools refused while the mode is active. |
| `mode.storePath` | `$DSH_HOME/tower-mode` | Directory for `modes.json`. |
| `mode.maxEntries` | `200` | Maximum persisted mode entries (1–2000). |
| `review.maxRoundsPerReviewer` | `5` | Review-round cap per reviewer per branch. |
| `merge.timeoutMs` | `900000` (15 min) | Default `tower_merge` timeout, including hooks. A per-call `timeoutMs` wins. |
| `merge.maxBufferBytes` | `67108864` (64 MB) | Merge output buffer. |
| `worktrees.root` | `''` | Default worktree parent; empty derives `<checkout parent>/.dsh-tower-worktrees/<hash>`. |
| `spawn.workerPreset` | `tower-worker` | Preset used for `role=worker`. |
| `spawn.reviewerPreset` | `tower-reviewer` | Preset used for `role=reviewer`. |
| `spawn.maxDepth` | `1` | Subagent depth requested at spawn. |
| `spawn.provider` | `''` | Subagent provider id; empty prefers `spawn`, then the first provider. |
| `spawn.workerModel` | `{}` | Optional `{provider, model, reasoningEffort, maxTokens}` for workers. |
| `spawn.reviewerModel` | `{}` | Optional model route for reviewers; independent review is stronger with a different model. |

## Example

```yaml
- id: tower
  name: 'dsh-tower'
  config:
    mode:
      allowAgentControl: true
      sectionAppend: 'Team conventions: tests are mandatory.'
    review:
      maxRoundsPerReviewer: 3
    merge:
      timeoutMs: 1800000
    spawn:
      reviewerModel:
        provider: deepseek-account
        model: deepseek-flash
```

## Looking up the effective schema

`cordis_inspect_query` with `Config.listConfigs({ name: "dsh-tower" })` returns the projected JSON
Schema once the plugin declares `Config` (this release does).
