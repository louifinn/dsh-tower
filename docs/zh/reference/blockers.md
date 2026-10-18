# blocker 与失败码

[English](../../reference/blockers.md) | **简体中文**

`tower_preflight` 返回 `{ok:false, blockers:[{code, detail}]}`。`tower_merge` 与 `tower_rebase`
在操作失败时返回相同结构。code 稳定；detail 面向人。

## 门禁 blocker（19 个）

| Code | 含义 / 下一步 |
|---|---|
| `mission-missing` | 未知 mission id。用 `tower_status` 查看。 |
| `mission-not-completed` | mission 不是 `completed`；只有 `completed`（等待审查）的 mission 才能合并。 |
| `tasks-open` | 仍有未完成任务；worker 必须先完成，或带理由 `task_drop`。 |
| `blockers-present` | mission 仍有 blocker；解决后清除。 |
| `branch-missing` | 还没有 worktree/分支：先 spawn worker。 |
| `stale-base` | 分支不包含基线 tip：执行 `tower_rebase`。 |
| `read-only-survey` | survey mission 修改了文件；survey mission 必须只读。 |
| `out-of-scope` | 改动文件超出 mission scope；有意为之就扩大 scope，否则回退。 |
| `base-dirty` | 主检出存在未提交改动，合并会覆盖它们。 |
| `deps-unmerged` | 依赖 mission 尚未 merged/abandoned。 |
| `no-review` | 分支上没有审查：spawn reviewer。 |
| `review-mission-mismatch` | 最新审查属于另一个 mission。 |
| `not-clean` | 最新审查是 `p1-Nitems`/`p2-Nitems`；需要再来一轮。 |
| `review-hold` | 最新审查建议 hold；必须由后续的干净审查取代。 |
| `review-not-approved` | 最新干净审查给出的是 `fix-then-merge` 或 `hold`；只有 `merge` 才算批准。 |
| `tip-moved` | 审查之后分支发生变化；重新审查（或使用干净 rebase 的免审豁免）。 |
| `worker-busy` | 该 mission 的 roster agent 正在运行；等待或让其退役。 |
| `base-wrong-branch` | 主检出不在记录的基线分支上。 |
| `branch-owned-by-closed-missions` | mission 已 merged/abandoned；用新标题重新 plan。 |

## 合并失败（3 个）

| Code | 含义 / 下一步 |
|---|---|
| `merge-conflict` | 真实的 index 冲突；mission 变为 `blocked`。解决后把 mission 恢复为 `active`/`completed`，再重试。 |
| `merge-hook-failed` | 在产生提交之前钩子/进程失败；仓库已恢复，mission 保持 `completed`。重试；`timeout: true` 表示 git 进程超时，慢钩子请调大 `timeoutMs`。 |
| `merge-shape` | Git 产生了意外的合并父提交；检查仓库，不要强推。 |

已经落地的合并不是 blocker：`tower_merge` 会记录它（`reconciled`、`alreadyLanded`），或从失败调用中恢复
（`recoveredFromFailure`、`warnings`）。

## rebase 失败（3 个；`worker-busy` 与门禁共用）

| Code | 含义 / 下一步 |
|---|---|
| `worktree-dirty` | 提交或丢弃 worktree 改动后重试。 |
| `rebase-conflict` | 真实冲突；mission 变为 `blocked`。手工解决后将其恢复为 `active`，再重试。 |
| `worker-busy` | 该 mission 有 agent 正在运行；先等待或让其退役。 |

分支已包含在基线中时，`tower_rebase` 返回 `alreadyMerged: true`；此时调用 `tower_merge` 记录这次
已落地的合并。
