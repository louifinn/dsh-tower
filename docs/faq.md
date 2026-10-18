# FAQ

**Why did `tower_preflight` fail with `no-review` right after the worker finished?**
That is expected: a completed mission awaits review. Spawn a reviewer; after a clean review the gate
turns green.

**Do I need to poll the worker?**
No. The worker's final report is delivered to this session; `tower_roster` shows live activity. Polling
wastes turns.

**`/tower` says the mode is on but `tower_control` is missing.**
`mode.allowAgentControl` is off. Set it to `true` in the profile patch and restart DSH.

**The merge hook takes minutes and `tower_merge` failed.**
Retry with a larger `timeoutMs`: `tower_merge({ missionId, timeoutMs: 1800000 })`. The default is 15
minutes and merge output is buffered up to 64 MB. A hook failure returns `merge-hook-failed` and leaves
the repo clean for a retry.

**A merge commit exists but Tower says the mission is not merged.**
Call `tower_merge` again. It detects the landed merge commit (`reconciled`) or recovers a failed call
whose commit exists (`recoveredFromFailure`) and records it.

**`tower_rebase` returned `alreadyMerged` and changed nothing.**
Correct: the branch is already contained in the base. Call `tower_merge` to record the landed merge
instead of rebasing.

**Can a reviewer edit files?**
No. Reviewers use the read-only `tower-reviewer` preset (no write/edit/pwsh); a branch changed after the
reviewer spawned is rejected. Reviewers file `tower_finding` for issues outside the mission.

**Can workers use Tower tools to merge or spawn?**
No. The worker preset contains mission/progress tools only; merge and spawn live in the parent tower.

**Where does Tower store state?**
`<git-common-dir>/dsh-tower/state.json` and `activity.jsonl` in the target repo; mode state in
`$DSH_HOME/tower-mode/modes.json`. Worktrees live next to the checkout in `.dsh-tower-worktrees/`.

**How do I change the review round cap or presets?**
Use `review.maxRoundsPerReviewer` and `spawn.workerPreset`/`spawn.reviewerPreset`; see
[config](reference/config.md). Restart DSH after a profile config change.

**Does Tower send data anywhere?**
No. It has no telemetry and no network service; all state is local.
