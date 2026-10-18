# Tools reference

All tools take `repoRoot` (an absolute path inside the target Git repository) and return JSON.
The installable build exposes 19 tools: 18 below plus `tower_control` when
`mode.allowAgentControl` is enabled (the bundled patch enables it).

| Tool | Parameters | Purpose / notes |
|---|---|---|
| `tower_init` | `base?` | Create `.git/dsh-tower/state.json`, record the base branch (idempotent; `base` is ignored on an existing state). |
| `tower_plan` | `missions[]` (`title`, `scope[]`, `tasks[]?`, `deps[]?`, `kind?`, `context?`) | Create missions `M1..`; overlapping build scopes auto-add a dependency; rejects unknown deps and cycles. |
| `tower_mission` | `id`, `status?`, `task_done?`, `task_drop?`+`task_drop_reason?`, `blocker?`, `clear_blockers?`, `note?`, `scope?` | Update one mission. `merged` cannot be set here; widening scope makes the mission active again. |
| `tower_status` | — | Mission counts, roster, open tasks, reviews, findings, recent activity. |
| `tower_spawn` | `missionId`, `role` (`worker`/`reviewer`), `name?`, `instructions?`, `worktreeRoot?`, `wait?`, `waitMs?` | Provision/reuse the worktree and start a subagent. Worker uses `tower-worker`; reviewer requires a `completed` mission and uses the read-only `tower-reviewer`. Returns agent id immediately; the child final report is delivered to this session. |
| `tower_roster` | — | Roster with live activity (`running`/`inactive`/`missing`/`unknown`) from the subagent catalog. Read-only. |
| `tower_adopt` | — | Reconcile roster entries with the durable subagent catalog after restart; provably gone agents are retired. |
| `tower_diff` | `missionId`, `maxBytes?` | Read-only merge-base diff: files, commits, capped patch. Safe for reviewers. |
| `tower_send` | `to`, `subject`, `body`, `scope?` | Durable message to a roster name, `tower`, or `all`; delivers live to a running agent. |
| `tower_inbox` | `page?`, `pageSize?` | Read/ack messages addressed to the caller; unread messages block `tower_complete`. |
| `tower_complete` | `missionId`, `agentId`, `report`, `commit?` | Worker reports completion (mission becomes `completed`, awaiting review). |
| `tower_finding` | `type`, `title`, `summary`, `details`, `suggested_fix`, `severity?`, `missionId?`, `location?` | Record an out-of-scope issue; reviewers use this instead of editing. |
| `tower_review` | `missionId`, `status` (`clean`/`p1-Nitems`/`p2-Nitems`), `merge` (`merge`/`fix-then-merge`/`hold`), `findings`, `decision`, `checks?`, `breakGlassReason?` | Reviewer verdict bound to the current tip. Reviewer must be the assigned reviewer (or tower break-glass). |
| `tower_preflight` | `missionId` | Read-only gate: returns `{ok, blockers[], branchTip, baseTip, changedFiles, review}`. |
| `tower_merge` | `missionId`, `timeoutMs?` | Merge after a green gate. If the merge commit already landed, records it (`reconciled`); if the command failed but the commit exists, records it (`recoveredFromFailure`); hook failures return `merge-hook-failed` with `cleanup` and optional `timeout`. |
| `tower_rebase` | `missionId` | Rebase the branch onto the base in its worktree. Refuses while the worker runs or the worktree is dirty. If the branch is already contained in the base it returns `alreadyMerged` and leaves it untouched. |
| `tower_teardown` | `force?`, `exclude?`, `dry_run?` | Remove eligible merged/abandoned worktrees and branches; running agents are always kept. |
| `tower_mode` | — | Report mode, who changed it, whether the model may toggle it, paused goal, denied tools, store path. |
| `tower_control` | `action` (`enter`/`exit`), `reason` | Model-initiated mode change; only when `mode.allowAgentControl` is true; reason is mandatory. |

## Failure results

Gate tools return `{ok:false, blockers:[{code, detail}]}`. The code list is in
[blockers.md](blockers.md). `tower_merge` failure blockers may also include `timeout: true`, `cleanup`,
and `warnings`.
