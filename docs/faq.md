# FAQ

**When should I use Tower instead of Agent Teams, Ralph, Workflow, or ordinary subagents?**
Use Tower when the output is a reviewed, integrated change to one Git repository. Use ordinary
subagents for read-only exploration or quick independent subtasks, Agent Teams for cross-cutting human
collaboration, Ralph for repeated fresh attempts at one objective, and Workflow for programmatic
high-fan-out analysis. The full decision guide, scenarios, and comparison table are in
[When to use Tower](guide/scenarios-and-philosophy.md).

**Can I combine Tower with Team/Workflow/Ralph?**
Not concurrently in the same session: Tower mode refuses their tools and clears plan mode. Compose by
phase instead—use Workflow/Team to analyze and decide, then start Tower to execute and review the
repository change. See the [full guide](guide/scenarios-and-philosophy.md#4-how-tower-differs-from-other-dsh-workflow-patterns).

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

**Can I require independent review?**
Yes. Set `review.requireReview:true` in the profile or repository config to enable the global review
gate (default is `false`, review optional). When enabled, mission-level `reviewPolicy:"none"` + a
reason is the narrower exemption. `tower_review` works and records verdicts either way.

**Can a reviewer edit files?**
No. Reviewers use the read-only `tower-reviewer` preset (no write/edit/pwsh); a branch changed after the
reviewer spawned is rejected. Reviewers file `tower_finding` for issues outside the mission.

**What is the difference between `tower_finding` and `tower_findings`?**
`tower_finding` creates one finding (`open`). `tower_findings` is the lifecycle tool: list/read, and
transition `open → triaged → fixed`/`wontfix` (reopen allowed). Only the tower or a worker may change the
status; a roster reviewer may list and read.

**How do I set config for one repository only?**
Create `<git-common-dir>/dsh-tower/config.json` (usually `.git/dsh-tower/config.json`) with the same
JSON groups as the profile config (`review`, `merge`, `worktrees`, `spawn`, and legacy aliases). The
repository layer wins over the profile; per-call tool arguments win over both. No restart is required
because the file is read when a Tower tool opens the repository.

**Can workers use Tower tools to merge or spawn?**
No. The worker preset contains mission/progress tools only; merge and spawn live in the parent tower.

**A worker is stuck or runaway. How do I stop it?**
Use `tower_interrupt({to:"worker-m1",reason:"..."})`; it calls the host subagent interrupt and records the
roster entry as `interrupted`. If you already interrupted it and want a new owner, spawn with
`takeover:true`. A still-running worker cannot be taken over (`takeover-refused`).

**Two sessions want to drive the same repository.**
Enable `mode.workspaceLock:true`: the first Tower session to call a repo-scoped tool owns
`<git-common-dir>/dsh-tower/tower.lock`; other sessions get `[tower:workspace-busy]` until the owner
runs `/tower off` or the lock is stale (`mode.workspaceStaleMs`).

**Can I reload the plugin without restarting DSH?**
Yes, in a profile with the DSH HMR service: `/tower reload` or the `tower_reload` tool reconciles the
profile and replaces the changed linked package. Run `npm run dev:hmr` once to add the repository to the
profile's HMR watch roots (then restart DSH once); see [hot reload](guide/hot-reload.md).
`plugin_manager` install/update already applies live.

**How do I make the completion evidence mandatory?**
Workers can pass `checks` to `tower_complete`; set `gates.requireChecks:true` to block merging when a
completed mission has no checks (`no-check-evidence`).

**Where does Tower store state?**
`<git-common-dir>/dsh-tower/state.json`, `activity.jsonl` and the human-readable `MISSIONS.md`; mode state
in `$DSH_HOME/tower-mode/modes.json`. Worktrees live next to the checkout in `.dsh-tower-worktrees/`.

**How do I change the review round cap or presets?**
Use `review.maxRoundsPerReviewer` and `spawn.workerPreset`/`spawn.reviewerPreset`; see
[config](reference/config.md). Restart DSH after a profile config change.

**Does Tower send data anywhere?**
No. It has no telemetry and no network service; all state is local.
