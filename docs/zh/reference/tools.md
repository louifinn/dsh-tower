# 工具参考

[English](../../reference/tools.md) | **简体中文**

所有工具都接受 `repoRoot`（目标 Git 仓库内的绝对路径）并返回 JSON。
本构建最多 28 个工具：下列 19 个核心仓库工具（含 `tower_interrupt`）、`tower_mode`、
`mode.allowAgentControl` 开启时注册的 `tower_control`、`dev.hotReload` 开启时注册的
`tower_reload`，以及 2.1 的验证/运维工具 `tower_doctor`、`tower_test`、`tower_batch`、
`tower_resource`、`tower_import_legacy`、`tower_legacy_map`。

`tower_mission` 使用 `id`（别名 `missionId`）；其他所有 mission 级工具使用 `missionId`
（别名 `id`）。其他输入别名：`task_done`/`taskDone`、`task_drop`/`taskDrop`、
`task_drop_reason`/`taskDropReason`、`clear_blockers`/`clearBlockers`、
`include_read`/`includeRead`、`dry_run`/`dryRun`、`timeoutMs`/`timeout_ms`、
`waitMs`/`wait_ms`、finding 上的 `mission_id`/`missionId`、interrupt 上的 `agent_id`/`agentId`、
status 上的 `include_gate`/`includeGate`、adopt 上的 `retire_missing`/`retireMissing`。
输出始终使用规范的 camelCase 字段名。

## 角色

roster 角色由 `exec.agent` 与 roster 共同决定。mission 级工具（`tower_interrupt`、
`tower_init`、`tower_plan`、`tower_spawn`、`tower_merge`、`tower_rebase`、`tower_teardown`、
`tower_adopt`、`tower_reload`）**仅限控制塔**。`tower_batch` 的 create/close、`tower_resource`
的 acquire/release、`tower_import_legacy`、`tower_legacy_map` 的 map 以及 review-exemption 规划
仅限控制塔；它们的只读 status 动作对 roster 角色开放。worker 调用 `tower_mission` 时只能使用
`task_done`/`task_drop`/`blocker`/`note`；状态变更、扩大 scope、`clear_blockers` 与 `completed`
仅限控制塔（完成必须走 `tower_complete`）。roster 中的 reviewer 可以读取 finding，但不能修改。
违规会抛出 `[tower:not-authorized]` 或 `[tower:invalid-transition]`。

## 工具

| 工具 | 参数 | 用途 / 说明 |
|---|---|---|
| `tower_init` | `base?`、`autoGitInit?`、`snapshotDirty?`、`reanchor?` | 创建 `<git-common-dir>/dsh-tower/state.json`。`autoGitInit` 执行 `git init` 并创建空的初始提交；`snapshotDirty` 记录一个游离快照提交作为 mission 基线；`reanchor` 仅在没有非终态 mission 时修改基线。返回 `dirty`、`snapshotCommit`、`reanchored`。 |
| `tower_plan` | `missions[]`（`title`、`scope[]`、`tasks[]?`、`deps[]?`、`kind?`、`context?`、`references[]?` ≤20、`reviewPolicy?`、`reviewExemptionReason?`） | 创建 mission `M1..`；重叠的 build scope 会自动加依赖；拒绝未知依赖与依赖循环。`reviewPolicy:"none"` 需要理由，并且要求 `gates.allowReviewExemption`。 |
| `tower_mission` | `id`（别名 `missionId`）、`status?`、`task_done?`、`task_drop?`+`task_drop_reason?`、`blocker?`、`clear_blockers?`、`note?`、`scope?`、`pause_cause?`、`authorization?` | 更新单个 mission。worker 可安全使用的字段是 task/blocker/note；不能在这里设置 `merged`。暂停的 mission 记录 `pause_cause`（user/failure/resource/dependency）；恢复用户暂停的 mission 会遵循 `mode.requireResumeAuthorization`。 |
| `tower_status` | `missionId?`、`offset?`、`limit?`、`includeGate?`、`format?` | 默认返回面板。`missionId` 返回完整详情（任务/备注/审查/finding/完成报告）。`offset`/`limit` 对 mission 分页（默认 20，最大 100），`includeGate` 附带门禁摘要，`format:"markdown"` 返回看板。 |
| `tower_spawn` | `missionId`（别名 `id`）、`role`（`worker`/`reviewer`）、`name?`、`instructions?`、`worktreeRoot?`、`wait?`、`waitMs?`、`takeover?`、`includeDirtyBase?` | 准备或复用 worktree 并启动子代理。worker 使用 `tower-worker`；reviewer 要求 mission 为 `completed`，并使用只读的 `tower-reviewer`。`takeover:true` 替换已不再运行的 worker 条目（ownerGeneration 递增）。每个 mission 只能有一个活跃 worker；`spawn.maxLiveWorkers` 限制整个仓库。 |
| `tower_roster` | — | roster 及来自子代理目录的实时活动（`running`/`inactive`/`missing`/`unknown`）与 `stale` 标记。只读。 |
| `tower_adopt` | `retireMissing?` | 把 roster 条目与持久子代理目录对账。可证明已消失的 agent 会被标记为 retired（默认），或标记为 `missing`（`retireMissing:false`）以便检查/接管。 |
| `tower_diff` | `missionId`（别名 `id`）、`maxBytes?` | 只读 merge-base diff：文件、提交、有上限的 patch。供 reviewer 安全使用。 |
| `tower_send` | `to`、`subject`、`body`、`scope?`、`interrupt?`、`consentRef?` | 向 roster 名称、`tower` 或 `all` 发送持久消息；对运行中的 agent 会即时投递。`interrupt:true` 先中断运行中的回合（Kimi 风格）再投递；`consentRef` 记录用于审计。受 `send.maxPerMinute` 限速。 |
| `tower_inbox` | `limit?`、`include_read?` | 读取并确认发给调用者的消息；未读消息会阻止 `tower_complete`。 |
| `tower_complete` | `missionId`（别名 `id`）、`report`、`checks?` | worker 报告完成（mission 变为 `completed`，等待审查）。要求当前 owner、无未完成任务/blocker、≥1 个提交、无未读消息。`checks` 记录 `{name, command?, exitCode?, evidence?}` 证据；`gates.requireChecks` 可以强制要求。配置了测试发现时还会自动运行并添加 `tests` 检查；失败会抛出 `[tower:tests-failed]`。 |
| `tower_interrupt` | `to?`（roster 名称）、`agentId?`、`reason?` | 通过 `subagents.interrupt` 中断一个运行中的 roster agent，并记录 `state:"interrupted"`。幂等（未运行 → `interrupted:false`）。 |
| `tower_finding` | `type`、`title`、`summary`、`details`、`suggested_fix`、`severity?`、`missionId?`、`location?` | 记录 scope 之外的问题；reviewer 用它代替直接改文件。新 finding 初始为 `open`。 |
| `tower_findings` | `id?`、`status?`、`note?`、过滤（`type?`、`severity?`、`missionId?`、`open?`、`limit?`） | 生命周期工具：列出/读取/流转。状态为 `open → triaged → fixed`/`wontfix`，允许重新打开。只有控制塔或 worker 能修改；reviewer 只能列出/读取。 |
| `tower_review` | `missionId`（别名 `id`）、`status`（`clean`/`p1-Nitems`/`p2-Nitems`）、`merge`（`merge`/`fix-then-merge`/`hold`）、`findings`、`decision`、`checks?`、`breakGlassReason?` | 绑定当前 tip 的 reviewer 结论。reviewer 必须是获派的 reviewer（或由控制塔使用 break-glass）。 |
| `tower_preflight` | `missionId`（别名 `id`） | 只读门禁：返回 `{ok, blockers[], branchTip, baseTip, changedFiles, review}`。 |
| `tower_merge` | `missionId`（别名 `id`）、`timeoutMs?`（别名 `timeout_ms`） | 门禁全绿后合并。若合并提交已落地则记录（`reconciled`）；若命令失败但提交已存在则恢复（`recoveredFromFailure`）；区分 `merge-hook-failed` 与 `merge-conflict`。 |
| `tower_rebase` | `missionId`（别名 `id`） | 在 worktree 内把分支 rebase 到基线。worker 运行中或 worktree 脏时拒绝。分支已包含在基线中时返回 `alreadyMerged` 且保持分支不动。 |
| `tower_teardown` | `force?`、`exclude?`、`dry_run?`（别名 `dryRun`） | 移除符合条件的 merged/abandoned worktree 与分支；运行中的 agent 始终保留。 |
| `tower_mode` | — | 报告模式、最近修改、被暂停的 goal、被拒绝的工具、store 路径、插件版本、HMR 可用性、workspace 锁持有者。 |
| `tower_control` | `action`（`enter`/`exit`）、`reason` | 模型主动切换模式；仅当 `mode.allowAgentControl` 为 `true` 时可用；`reason` 必填。 |
| `tower_reload` | `repoRoot?` | 仅开发用：请求 DSH HMR 对账 profile 并从磁盘重载 Host 插件。`dev.hotReload` 开启时注册；在工具结果返回后调度（默认 50 ms）；没有 HMR 时以 `reload-unavailable` 失败。传入 `repoRoot` 时调用者必须是控制塔。 |
| `tower_doctor` | —（需要 `repoRoot`） | 只读健康契约：git、state schema、config、preset/subagents/HMR、workspace 锁、roster、worktree realpath/归属、测试配置、leases。返回 `{ok, checks[{id,status,detail}], environmentContract}`。从不写状态。 |
| `tower_test` | `missionId`（别名 `id`） | 运行 worktree 的 `package.json` 中 `tower.testDiscovery` 配置的发现命令并记录回执；失败时 `ok:false`。自动准入检查请用 `tower_complete`。 |
| `tower_batch` | `action`（`create`/`status`/`close`）、`missionIds?`、`exclusions?`、`requiredChecks?`、`receiptPaths?`、`batchId?`、`checks?`、`treeTip?`、`receiptHashes?` | 有限证据批次。create 冻结成员/检查/回执；close 校验每条必需检查与回执哈希。成员关系不可变；close 从不删除 mission。 |
| `tower_resource` | `action`（`acquire`/`release`/`status`）、`name?`、`holder?`、`token?`、`ttlMs?`、`force?` | 每个仓库的咨询式租约，位于 `<common>/dsh-tower/leases.json`。没有 OS CPU/内存硬上限；过期的租约需要显式 `force` 与正确 token。 |
| `tower_import_legacy` | `sourcePath` | 只读导入 Tower Codex `schemaVersion:1` 或 DSH 旧版 state。完整 payload 存到 `<common>/dsh-tower/legacy/<sha256>.json`；state 中只保存摘要。绝不激活/接管/恢复暂停的 mission。 |
| `tower_legacy_map` | `action`（`map`/`status`）、`sourceHash?`、`oldId?`、`newMissionId?` | 仅审计用途的旧 id 映射；映射只追加，绝不容纳 mission。 |

## workspace 锁

当 `mode.workspaceLock:true` 时（随包 patch 开启），Tower 模式会话的第一次仓库级 Tower 工具调用会
获取 `<git-common-dir>/dsh-tower/tower.lock`；另一个会话会得到 `[tower:workspace-busy]`，直到持有
者执行 `/tower off` 或锁超过 `mode.workspaceStaleMs`。`mode.workspaceLockScope:"mutations"` 会跳过
只读工具的锁。代码默认关闭；随包 patch 开启，以提供与 Kimi 兼容的“单活跃控制塔”行为。

## 失败结果

门禁类工具返回 `{ok:false, blockers:[{code, detail}]}`；code 列表见 [blockers.md](blockers.md)。
抛出的工具错误带稳定的 `[tower:<code>]` 前缀（见 [errors.md](errors.md)）。成功的变更会发出进程内
事件（见 [events.md](events.md)），并且在 `docs.board:true` 时刷新
`<git-common-dir>/dsh-tower/MISSIONS.md`。
