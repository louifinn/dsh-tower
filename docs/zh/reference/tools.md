# 工具参考

[English](../../reference/tools.md) | **简体中文**

仓库级工具不再接受 `repoRoot` 参数，只有 `tower_init` 保留该字段（它负责引导仓库）。其他所有
工具都在同一处解析仓库，顺序为：调用会话通过 workspace 锁绑定的仓库 → 会话工作目录 → 显式
`repoRoot` 字段（headless/嵌入式调用仍可使用）。位于 linked worktree 内的会话目录会解析到主
checkout，因此 worker 不会把 Tower 状态或看板写进自己的 mission worktree。
`tower_mode` 与 `tower_reload` 不需要仓库；`tower_reload` 是仓库可选的逃生通道（可在没有
仓库时重载损坏的 profile）。
## 工具集

本构建最多 21 个工具（全开）；默认 profile 注册 **16 个工具**：`tower_init`（`op:"init"`/`"adopt"`）、`tower_plan`、
`tower_spawn`、`tower_mission`、`tower_interrupt`、`tower_merge`、`tower_rebase`、
`tower_teardown`、`tower_send`、`tower_inbox`、`tower_finding`、`tower_inspect`（五个只读视图）、
`tower_complete`、`tower_review`、`tower_mode` 与 `tower_recover`。全部开启的构建面为
**21 个工具**：16 个默认工具加 `tower_batch`（`tower-batch`）、`tower_import`（`tower-import`）、
`tower_resource`（`tower-leases`）、`tower_test`（`tower-tests`）和 `tower_reload`
（`tower-hmr`）。`tower_inspect` 把 status、roster、diff、preflight、doctor 五个只读视图收进
一个工具，用 `view` 选择；`tower_init`、`tower_finding` 和 `tower_import` 把同一资源的动作
收进各自的 `op`。

每个 profile **实际挂载**的工具比构建面更窄。控制塔会话不挂载 `tower_complete` 与
`tower_review`——它们分别属于 worker/survey 与 reviewer 角色会话（#163 Phase 5）。从控制塔
会话强行调用会得到可执行的 `not-authorized` 提示（指出 `tower_spawn({role:"worker"})` 入口），
而不是 unknown tool。实测 profile：tower 14 个工具 / 10,582 B 输入 schema，worker 6 / 6,175 B，
reviewer 5 / 4,371 B；基线记录在 `docs/reference/surface-budget.md`。

## 默认关闭的子系统

下表的五个组件行在随附的 `cordis.patch.yml` 中带 `disabled: true`。关闭一行只会移除它的工具；
`tower_doctor` 会逐行列出工具与开启步骤，`tower_inspect` 的 `doctor` 视图报告
“disabled by component <id>”。开启方法是把该行的 `disabled` 设为 `false`（或删掉该标记）并
重启 DSH。

| 组件行 | 工具 | 开启方式 |
|---|---|---|
| `tower-batch` | `tower_batch` | 删除 `tower-batch` 行的 `disabled: true` 并重启 DSH |
| `tower-import` | `tower_import` | 删除 `tower-import` 行的 `disabled: true` 并重启 DSH |
| `tower-leases` | `tower_resource` | 删除 `tower-leases` 行的 `disabled: true` 并重启 DSH |
| `tower-tests` | `tower_test` | 删除 `tower-tests` 行的 `disabled: true` 并重启 DSH |
| `tower-hmr` | `tower_reload` | 删除 `tower-hmr` 行的 `disabled: true` 并重启 DSH |

工具仍然存在并留在全开 21 个之中：它们是关闭，不是删除。

`tower_mission` 使用 `id`（别名 `missionId`）；其他所有 mission 级工具使用 `missionId`
（别名 `id`）。其他输入别名：`task_done`/`taskDone`、`task_drop`/`taskDrop`、
`task_drop_reason`/`taskDropReason`、`clear_blockers`/`clearBlockers`、
`include_read`/`includeRead`、`dry_run`/`dryRun`、`timeoutMs`/`timeout_ms`、
`tower_finding` 上的 `mission_id`/`missionId`、interrupt 上的
`agent_id`/`agentId`、`tower_inspect` status 视图上的 `include_gate`/`includeGate` 与
`include_archived`/`includeArchived`、`tower_init({op:"adopt"})` 上的
`retire_missing`/`retireMissing`。
别名仍被服务端接受，但不再出现在工具 schema 中（#163 Phase 2），因此不会在每次请求中占用字节。
输出始终使用规范的 camelCase 字段名。

## 每个仓库只有一个姿态

Tower 模式与 Ralph 循环（`@deepseek-ai/dsh-tool-ralph`、社区版 `dsh-ralph`，或同一姿态的任何其他实现）
在每个仓库上互斥：Tower 模式激活期间 `/ralph` 命令会被遮蔽（命令不是工具，由命令属主表覆盖）、
其工具名由 #161 的属主派生 `mode.denyTools` 默认值拒绝、带活跃循环进入 Tower 模式会停止并记录该循环或拒绝进入
（`mode.ralphPolicy`，默认 `stop`），且仓库处于 Tower 模式期间 round agent 会被拒绝——因此改名的入口
无法在活跃控制塔下重启循环。`tower_inspect` 的 `doctor` 视图把活跃循环报告为环境事实。Tower worker **内部**的
Ralph 循环不是冲突：worker 在自己的隔离 worktree 里拥有一个 mission，并通过 `tower_complete` 汇报。
见 [ADR 0010](../../adr/0010-tower-ralph-mutual-exclusion.md)。

## 角色

roster 角色由 `exec.agent` 与 roster 共同决定。mission 级工具（`tower_interrupt`、
`tower_init`、`tower_plan`、`tower_spawn`、`tower_merge`、`tower_rebase`、`tower_teardown`）
**仅限控制塔**，`tower_init({op:"adopt"})` 与 `tower_mode` 的写操作也一样。`tower_complete` 与 `tower_review` 分别由 worker/survey 与 reviewer 角色会话挂载；控制塔会话不挂载它们，误用会得到 `not-authorized` 提示并给出 `tower_spawn` 角色入口或切换模式的替代路径。`tower_reload`
仅限控制塔，并且是 `host/tool-profiles.js` 中唯一登记为仓库可选的工具：它可以在没有仓库时
运行以重载损坏的 profile；传入 `repoRoot` 不会改变这一行（仍受 `tower-hmr` 组件行控制）。
`tower_batch` 的 create/close/abandon、`tower_resource` 的 acquire/release、`tower_import`
以及 review-exemption 规划仅限控制塔；`tower_import` 的只读 `status` 动作对 roster 角色开放。worker 调用 `tower_mission` 时只能使用
`task_done`/`task_drop`/`blocker`/`note`；状态变更、扩大 scope、`clear_blockers` 与 `completed`
仅限控制塔（完成必须走 `tower_complete`）。roster 中的 reviewer 可以读取 finding，但不能修改。
违规会抛出 `[tower:not-authorized]` 或 `[tower:invalid-transition]`。

## 工具

| 工具 | 参数 | 用途 / 说明 |
|---|---|---|
| `tower_init` | `op?`（`init` 默认 / `adopt`）、`repoRoot`、`base?`、`auto_git_init?`、`snapshot_dirty?`、`reanchor?`、`retire_missing?` | `op:"init"` 创建 `<git-common-dir>/dsh-tower/state.json`。唯一声明 `repoRoot` 的工具（引导）；它优先于会话目录，以便显式初始化指定目标。`auto_git_init` 执行 `git init` 并创建空的初始提交；`snapshot_dirty` 记录一个游离快照提交作为 mission 基线；`reanchor` 仅在没有非终态 mission 时修改基线。`op:"adopt"` 把 roster 与持久目录对账：可证明已消失的 agent 会被标记为 retired（默认），或标记为 `missing`（`retire_missing:false`）。两个 op 都仅限控制塔。 |
| `tower_plan` | `missions[]`（`title`——可打印 Unicode，NFC 规范化，≤120 字符、`scope[]`、`tasks[]?`、`deps[]?`、`kind?`、`context?`、`references[]?` ≤20、`reviewPolicy?`、`reviewExemptionReason?`） | 创建 mission `M1..`；重叠的 build scope 会自动加依赖；拒绝未知依赖与依赖循环。mission id 保持 ASCII（`M1`、`M2`）；不可见字符与超长标题会以 `invalid-argument` 拒绝。`reviewPolicy:"none"` 需要非空理由；审查门禁开启时，preflight 还要求 `gates.allowReviewExemption`。 |
| `tower_mission` | `id`（别名 `missionId`）、`status?`、`task_done?`、`task_drop?`+`task_drop_reason?`、`blocker?`、`clear_blockers?`、`note?`、`scope?`、`pause_cause?`、`authorization?` | 更新单个 mission。worker 可安全使用的字段是 task/blocker/note；不能在这里设置 `merged`。暂停的 mission 记录 `pause_cause`（user/failure/resource/dependency）；恢复用户暂停的 mission 会遵循 `mode.requireResumeAuthorization`。 |
| `tower_inspect` | `view`（`status`/`roster`/`diff`/`preflight`/`doctor`）、`missionId?`（diff/preflight 必填）、`maxBytes?`、`offset?`、`limit?`、`includeGate?`、`includeArchived?`、`format?` | 五个只读视图共用一个工具：`status`（面板、单个 mission 详情、分页与 markdown 看板）、`roster`（子代理目录的实时活动）、`diff`（mission 分支的 merge-base diff）、`preflight`（合并门禁 blockers/warnings）、`doctor`（环境与 state/git 锁健康，含 Ralph 姿态）。从不写状态或 git；输出与原来的独立工具一致，并带 `view` 字段。diff/preflight 需要 `missionId`；roster/diff 仅对已知 roster 角色开放。 |
| `tower_spawn` | `missionId`（别名 `id`）、`op?`（`spawn` 默认 / `takeover`）、`role`（`worker`/`reviewer`）、`name?`、`instructions?`、`worktreeRoot?`、`wait?`、`includeDirtyBase?` | 准备或复用 worktree 并启动子代理。worker 使用 `tower-worker`；reviewer 要求 mission 为 `completed`，并使用只读的 `tower-reviewer`；`review.mode:off` 时 reviewer 角色会以 `[tower:review-disabled]` 被拒绝。`op:"takeover"` 替换已不再运行的 worker 条目（ownerGeneration 递增）；旧的 `takeover:true` 字段会以替代路径报错。`wait:true` 等待结果，上限由 `spawn.maxWaitMs`（默认 90000）决定；旧的 `waitMs` 字段会指向该配置路径报错。每个 mission 只能有一个活跃 worker；`spawn.maxLiveWorkers` 限制整个仓库。 |
| `tower_send` | `to`、`subject`、`body`、`scope?`、`interrupt?`、`consentRef?` | 向 roster 名称、`tower` 或 `all` 发送持久消息；对运行中的 agent 会即时投递。`interrupt:true` 先中断运行中的回合（Kimi 风格）再投递；`consentRef` 记录用于审计。受 `send.maxPerMinute` 限速。 |
| `tower_inbox` | `limit?`、`include_read?` | 读取并确认发给调用者的消息；未读消息会阻止 `tower_complete`。 |
| `tower_complete` | `missionId`（别名 `id`）、`report`、`checks?` | worker 报告完成（mission 变为 `completed`，可进入 preflight 与可选审查）。要求当前 owner、无未完成任务/blocker、≥1 个提交、无未读消息。`report` 受 `gates.maxReportBytes`（默认 32768 UTF-8 字节）硬上限约束：超限会以 `invalid-argument` 拒绝并给出 `nextAction`（把全文写进 mission worktree 的文件），绝不截断；存储时会记录 `reportBytes`。`checks` 记录 `{name, command?, exitCode?, evidence?}` 证据；`gates.requireChecks` 可以强制要求。配置了测试发现时还会自动运行并添加 `tests` 检查；失败会抛出 `[tower:tests-failed]`。 |
| `tower_interrupt` | `to?`（roster 名称）、`agentId?`、`reason?` | 通过 `subagents.interrupt` 中断一个运行中的 roster agent，并记录 `state:"interrupted"`。幂等（未运行 → `interrupted:false`）。 |
| `tower_finding` | `op?`（`report` / `list` 默认 / `update`）、`id?`、`status?`、`note?`、过滤（`type?`、`severity?`、`missionId?`、`open?`、`limit?`）、`title?`、`summary?`、`details?`、`suggested_fix?`、`location?` | 一个 finding 生命周期（#163 Phase 4）。`report` 需要 `type`（bug/improve/vuln/idea）、`title`、`summary`、`details`、`suggested_fix`，新 finding 初始为 `open`；`list` 按 `id` 或过滤条件读取/列出；`update` 需要 `id` 加 `status`/`note`，状态为 `open → triaged → fixed`/`wontfix`，允许重新打开。只有控制塔或 worker 能修改；reviewer 只能列出/读取。 |
| `tower_review` | `missionId`（别名 `id`）、`status`（`clean`/`p1-Nitems`/`p2-Nitems`）、`merge`（`merge`/`fix-then-merge`/`hold`）、`findings`、`decision`、`checks?`、`breakGlassReason?` | 绑定当前 tip 的 reviewer 结论。reviewer 必须是获派的 reviewer（或由控制塔使用 break-glass）。`review.mode:off` 时不注册；仓库层为 `off` 时提交会以 `[tower:review-disabled]` 被拒绝。非 clean 结论使 mission 回到 active 后，其他 route 仍可为同一 reviewed tip 提交结论：追加到同一轮（`appended:true`），不再改变状态；tip 已移动时会被明确拒绝。同一轮内以记录顺序（`seq` 最大）最新的结论为准，merge gate、已落地合并检测、status 与 briefing 使用同一规则：同一轮中较晚的 clean 结论会取代较早的非 clean 结论。 |
| `tower_merge` | `missionId`（别名 `id`）、`timeoutMs?`（别名 `timeout_ms`） | 门禁全绿后合并。若合并提交已落地则记录（`reconciled`）；若命令失败但提交已存在则恢复（`recoveredFromFailure`）；区分 `merge-hook-failed` 与 `merge-conflict`。 |
| `tower_rebase` | `missionId`（别名 `id`） | 在 worktree 内把分支 rebase 到基线。worker 运行中或 worktree 脏时拒绝。分支已包含在基线中时返回 `alreadyMerged` 且保持分支不动。 |
| `tower_teardown` | `force?`、`exclude?`、`dry_run?`（别名 `dryRun`） | 移除符合条件的 merged/abandoned worktree 与分支；运行中的 agent 始终保留。 |
| `tower_mode` | `active?`（`true`/`false`/`"takeover"`）、`reason?`、`authorization?` | 不传 `active`：报告模式、最近修改、被暂停的 goal、被拒绝的工具、store 路径、插件版本、HMR 可用性、workspace 锁持有者，以及进入策略所依据的 Ralph 姿态（`ralph: {policy, runs, rounds, liveRounds, detail}`）。传 `active`：`true` 进入、`false` 退出、`"takeover"` 在获得用户明确批准后从已停用的属主转移仓库所有权。写操作需要非空 `reason` 且 `mode.allowAgentControl:true`；`takeover` 还必须提供 `authorization`（记录在活动条目上的审计引用）。进入时如有活跃 Ralph 循环：默认 `mode.ralphPolicy:"stop"` 会释放循环并在结果中报告 `ralphReleased`，设为 `"refuse"` 时以 `[tower:invalid-transition]` 拒绝进入。 |
| `/tower takeover <reason>` | — | 人类专用的所有权转移命令；即使 `mode.allowAgentControl:false` 也可用。 |
| `/tasks`、`/tower tasks` | — | 人类可用的只读实时 roster 面板：每个存活 roster agent 一行（mission、角色、名称、短分支名、状态、距其最近一条记录事件的静默时长、该事件本身），最静默者在前，最多 20 行，页脚给出 `N live, M stale` 计数与 `tower_interrupt` 处置提示。不消耗模型回合，也不做任何写入（不触碰 `state.json`、activity 日志或 modes store）。过期判定与 `tower_inspect` 的 `roster` 视图及合并门禁使用同一条 `spawn.staleMs` 规则。仅当宿主 profile 未定义其他 `tasks` 命令时插件才注册 `/tasks`；`/tower tasks` 是始终可用的别名，当前 profile 实际采用哪个会在命令描述中说明（#160）。 |
| `tower_reload` | — | 仅开发用：请求 DSH HMR 对账 profile 并从磁盘重载 Host 插件。`tower-hmr` 组件行开启时注册（该行随包关闭）；在工具结果返回后调度（默认 50 ms）；没有 HMR 时以 `reload-unavailable` 失败。它在 `host/tool-profiles.js` 中登记为唯一的仓库可选工具，因此可以在没有仓库时修复损坏的 profile；决定这一路径的是工具身份，而不是调用者是否传了 `repoRoot`。 |
| `tower_recover` | `action`（`status`/`clear-stale-lock`）、`confirm?`、`force?` | 恢复诊断与显式 stale state-lock 修复。`clear-stale-lock` 需要 `confirm:"CLEAR_STALE_LOCK"`，只把 PID 已死的锁改名为 `.recovered-<ts>` 备份。`force:true` 还能清理 PID 仍存活但心跳静默（PID 被复用）的锁：输出 `{pid, startedAt, ageMs, heartbeatAgeMs}`，记录仍只改名、绝不 unlink。不会重置状态或 worktree。 |
| `tower_test` | `missionId`（别名 `id`） | 运行 worktree 的 `package.json` 中 `tower.testDiscovery` 配置的发现命令并记录回执；失败时 `ok:false`。自动准入检查请用 `tower_complete`。 |
| `tower_batch` | `action`（`create`/`status`/`close`/`abandon`）、`missionIds?`、`exclusions?`、`requiredChecks?`、`receiptPaths?`、`batchId?`、`checks?`、`treeTip?`、`receiptHashes?`、`reason?` | 有限证据批次。create 冻结成员/检查/回执；close 校验每条必需检查与回执哈希；`merged` 成员也可参与 close；abandon 可退掉过期的 open batch 且不删除 mission。成员关系不可变。 |
| `tower_resource` | `action`（`acquire`/`release`/`status`）、`name?`、`holder?`、`token?`、`ttlMs?`、`force?` | 每个仓库的咨询式租约，位于 `<common>/dsh-tower/leases.json`。没有 OS CPU/内存硬上限；过期的租约需要显式 `force` 与正确 token。 |
| `tower_import` | `op?`（有 `sourcePath` 时推断为 `snapshot`，否则 `map`）、`sourcePath?`、`action?`（`map`/`status`）、`sourceHash?`、`oldId?`、`newMissionId?` | 一个遗留资源工具（#163 Phase 4）。`snapshot`：只读导入 Tower Codex `schemaVersion:1` 或 DSH 旧版 state，完整 payload 存到 `<common>/dsh-tower/legacy/<sha256>.json`，state 中只保存摘要。`map`：仅审计用途的旧 id 映射，映射只追加；`action:"status"` 列出映射。绝不激活/接管/恢复暂停的 mission。除只读 `status` 动作外仅限控制塔。 |

## workspace 锁

当 `mode.workspaceLock:true` 时（随包 patch 开启），Tower 模式会话的第一次仓库级 Tower 工具调用会
获取 `<git-common-dir>/dsh-tower/tower.lock`；另一个会话会得到 `[tower:workspace-busy]`，直到持有
者执行 `/tower off` 或锁超过 `mode.workspaceStaleMs`。`mode.workspaceLockScope:"mutations"` 会跳过
只读工具的锁。代码默认关闭；随包 patch 开启，以提供与 Kimi 兼容的“单活跃控制塔”行为。

## 失败结果

门禁类工具返回 `{ok:false, blockers:[{code, detail}]}`；code 列表见 [blockers.md](blockers.md)。
抛出的工具错误带稳定的 `[tower:<code>]` 前缀（见 [errors.md](errors.md)）。成功的变更会发出进程内
事件（见 [events.md](events.md)），并在挂载 `tower-board` 组件行时刷新
`<git-common-dir>/dsh-tower/MISSIONS.md`。看板位置仍由 `docs.boardLocation` 决定；原先的
`docs.board` 开关现在是组件行（#133）。
