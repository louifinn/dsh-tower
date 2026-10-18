# Config reference

Every key is optional; defaults reproduce the shipped behavior. Unknown top-level keys are rejected.
`section` and `allowAgentControl` are legacy aliases for `mode.promptSection` and
`mode.allowAgentControl`.

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
