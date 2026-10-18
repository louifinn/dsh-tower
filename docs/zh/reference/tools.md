# 工具参考

[English](../../reference/tools.md) | **简体中文**

所有工具都接受 `repoRoot`（目标 Git 仓库内的绝对路径）并返回 JSON。
本版本工具总数为 20：17 个 mission 工具、`tower_mode`、`tower_findings`，以及可选的
`tower_control`。`tower_control` 仅在 `mode.allowAgentControl` 为 `true` 时注册（随包 patch 默认开启）。

| 工具 | 参数 | 用途 / 说明 |
|---|---|---|
| `tower_init` | `base?` | 创建 `<git-common-dir>/dsh-tower/state.json`（普通检出即 `.git/dsh-tower/state.json`），记录基线分支（幂等；已有 state 时 `base` 被忽略）。 |
| `tower_plan` | `missions[]`（`title`、`scope[]`、`tasks[]?`、`deps[]?`、`kind?`、`context?`） | 创建 mission `M1..`；重叠的 build scope 会自动加依赖；拒绝未知依赖与依赖循环。 |
| `tower_mission` | `id`、`status?`、`task_done?`、`task_drop?`+`task_drop_reason?`、`blocker?`、`clear_blockers?`、`note?`、`scope?` | 更新单个 mission。不能在这里设置 `merged`；扩大 scope 会让 mission 重新变为 active。 |
| `tower_status` | — | mission 计数、roster、未完成任务、审查、按状态统计的 finding、配置路径、最近活动。 |
| `tower_spawn` | `missionId`、`role`（`worker`/`reviewer`）、`name?`、`instructions?`、`worktreeRoot?`、`wait?`、`waitMs?` | 准备或复用 worktree 并启动子代理。worker 使用 `tower-worker`；reviewer 要求 mission 为 `completed`，并使用只读的 `tower-reviewer`。preset 来自 `spawn.*` 配置（仓库配置优先于 profile）。立即返回 agent id；子代理最终报告会送回本会话。 |
| `tower_roster` | — | roster 及实时活动（`running`/`inactive`/`missing`/`unknown`），来自子代理目录。只读。 |
| `tower_adopt` | — | 重启或新会话后把 roster 与持久子代理目录对账；可证明已消失的 agent 标记为 retired。 |
| `tower_diff` | `missionId`、`maxBytes?` | 只读 merge-base diff：文件、提交、有上限的 patch。供 reviewer 安全使用。 |
| `tower_send` | `to`、`subject`、`body`、`scope?` | 向 roster 名称、`tower` 或 `all` 发送持久消息；对运行中的 agent 会即时投递。 |
| `tower_inbox` | `limit?`、`include_read?` | 读取并确认发给调用者的消息；未读消息会阻止 `tower_complete`。 |
| `tower_complete` | `missionId`、`report` | worker 报告完成（mission 变为 `completed`，等待审查）。调用方 agent 从会话取得；store 会校验任务/blocker/提交/未读消息；完成不等于已合并。 |
| `tower_finding` | `type`、`title`、`summary`、`details`、`suggested_fix`、`severity?`、`missionId?`、`location?` | 记录 scope 之外的问题；reviewer 用它代替直接改文件。新 finding 初始为 `open`。 |
| `tower_findings` | `id?`、`status?`、`note?`、`type?`、`severity?`、`missionId?`、`open?`、`limit?` | 管理 finding 生命周期：列出、读取或更新状态（见下文「finding 生命周期」）。只有控制塔或 worker 能修改；reviewer 只能列出/读取。 |
| `tower_review` | `missionId`、`status`（`clean`/`p1-Nitems`/`p2-Nitems`）、`merge`（`merge`/`fix-then-merge`/`hold`）、`findings`、`decision`、`checks?`、`breakGlassReason?` | 绑定当前 tip 的 reviewer 结论。reviewer 必须是获派的 reviewer（或由 tower 使用 break-glass）。 |
| `tower_preflight` | `missionId` | 只读门禁：返回 `{ok, blockers[], branchTip, baseTip, changedFiles, review}`。 |
| `tower_merge` | `missionId`、`timeoutMs?` | 门禁全绿后合并。若合并提交已落地则记录（`reconciled`）；若命令失败但提交已存在则记录（`recoveredFromFailure`）；钩子失败返回 `merge-hook-failed`，附带 `cleanup` 与可选的 `timeout`。 |
| `tower_rebase` | `missionId` | 在 worktree 内把分支 rebase 到基线。worker 运行中或 worktree 脏时拒绝。分支已包含在基线中时返回 `alreadyMerged` 且保持分支不动。 |
| `tower_teardown` | `force?`、`exclude?`、`dry_run?` | 移除符合条件的 merged/abandoned worktree 与分支；运行中的 agent 始终保留。 |
| `tower_mode` | — | 报告模式、最近修改者、模型是否可切换、被暂停的 goal、被拒绝的工具、store 路径。 |
| `tower_control` | `action`（`enter`/`exit`）、`reason` | 模型主动切换模式；仅当 `mode.allowAgentControl` 为 `true` 时可用；`reason` 必填。 |

## finding 生命周期

`tower_findings` 管理 finding 的状态：

| 当前状态 | 可流转到 |
|---|---|
| `open` | `triaged`、`fixed`、`wontfix` |
| `triaged` | `open`、`fixed`、`wontfix` |
| `fixed` | `open`（重新打开） |
| `wontfix` | `open`（重新打开） |

不传 `id` 时列出 finding（最新在前，默认 50 条；可用 `status`/`type`/`severity`/`missionId`/`open`/`limit`
过滤）；传 `id` 读取单条；传 `id` + `status`（和/或 `note`）记录流转。只有控制塔或 worker 能修改；
reviewer 只能列出/读取。

## 输入别名

参数名支持下划线/驼峰两种写法，含义等价；输出始终使用规范的 camelCase 字段名。

| 支持的写法 | 适用工具 |
|---|---|
| `missionId` / `id` | `tower_spawn`、`tower_diff`、`tower_complete`、`tower_review`、`tower_preflight`、`tower_merge`、`tower_rebase`（规范名 `missionId`） |
| `id` / `missionId` | `tower_mission`（规范名 `id`） |
| `missionId` / `mission_id` | `tower_finding`、`tower_findings` |
| `task_done` / `taskDone` | `tower_mission` |
| `task_drop` / `taskDrop` | `tower_mission` |
| `task_drop_reason` / `taskDropReason` | `tower_mission` |
| `clear_blockers` / `clearBlockers` | `tower_mission` |
| `include_read` / `includeRead` | `tower_inbox` |
| `dry_run` / `dryRun` | `tower_teardown` |
| `timeout_ms` / `timeoutMs` | `tower_merge` |
| `wait_ms` / `waitMs` | `tower_spawn` |

别名只在规范参数缺失时生效；两者同时传入时以规范名为准。

## 失败结果

门禁类工具返回 `{ok:false, blockers:[{code, detail}]}`。code 列表见 [blockers.md](blockers.md)。
`tower_merge` 的失败 blocker 还可能带 `timeout: true`、`cleanup` 与 `warnings`。

输入/配置错误以抛出错误的形式返回，而不是 `{ok:false}`。每个工具错误都带稳定的
`[tower:<code>]` 前缀；错误码目录见 [errors.md](errors.md)。blocker code 与工具错误码是两套不同
的目录。
