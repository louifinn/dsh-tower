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
而不是 unknown tool。实测 profile：tower 14 个工具 / 16,017 B 输入 schema，worker 6 / 8,646 B，
reviewer 5 / 6,000 B；基线记录在 `docs/reference/surface-budget.md`。

## 默认关闭的子系统

下表的五个组件行在随附的 `cordis.patch.yml` 中带 `disabled: true`。关闭一行只会移除它的工具；
`tower_inspect` 的 `doctor` 视图会逐行列出工具与开启步骤，并报告
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
`task_done`/`task_drop`/`blocker`/`note`；状态变更、scope 编辑与扩大、`deferred`、`clear_blockers` 与 `completed`
仅限控制塔（完成必须走 `tower_complete`）。roster 中的 reviewer 可以读取 finding，但不能修改。
违规会抛出 `[tower:not-authorized]` 或 `[tower:invalid-transition]`。

## 工具

| 工具 | 参数 | 用途 / 说明 |
|---|---|---|
| `tower_init` | `op?`（`init` 默认 / `adopt`）、`repoRoot`、`base?`、`auto_git_init?`、`snapshot_dirty?`、`reanchor?`、`retire_missing?` | `op:"init"` 创建 `<git-common-dir>/dsh-tower/state.json`。唯一声明 `repoRoot` 的工具（引导）；它优先于会话目录，以便显式初始化指定目标。`auto_git_init` 执行 `git init` 并创建空的初始提交；`snapshot_dirty` 记录一个游离快照提交作为 mission 基线；`reanchor` 仅在没有非终态 mission 时修改基线。`op:"adopt"` 把 roster 与持久目录对账：可证明已消失的 agent 会被标记为 retired（默认），或标记为 `missing`（`retire_missing:false`）。两个 op 都仅限控制塔。 |
| `tower_plan` | `missions[]`（`title`——可打印 Unicode，NFC 规范化，≤120 字符、`scope[]`、`tasks[]?`、`deps[]?`、`kind?`——`build`/`survey`/`artifact`、`artifacts[]?` ≤20、`context?`、`references[]?` ≤20、`reviewPolicy?`、`reviewExemptionReason?`、`allowMissingScope?`） | 创建 mission `M1..`；重叠的 build scope 会自动加依赖；拒绝未知依赖与依赖循环。mission id 保持 ASCII（`M1`、`M2`）；不可见字符与超长标题会以 `invalid-argument` 拒绝。`kind:"artifact"` 在 `artifacts[]` 声明具体的交付物路径（不能是 glob，且必须位于 scope 内）；完成前这些路径必须已提交在分支末端，合并还要求人类接受该末端。`reviewPolicy:"none"` 需要非空理由；审查门禁开启时，preflight 还要求 `gates.allowReviewExemption`。`scope` 是相对仓库根目录的文件 glob 列表；目录形态的条目（`docs/guide/`，或规划时已存在的裸 `docs/guide`）会存成显式的子树 glob `docs/guide/**`——见下文“scope 条目”。规划时每个条目都会与 `git ls-files` 对照：落在已跟踪目录内却匹配不到任何已跟踪文件的条目会以 `invalid-argument` 拒绝，并指出最近的已存在前缀与该目录下最多 5 个已跟踪候选。若该路径确实是 mission 将要创建的，在对应 mission 上传 `allowMissingScope:true`；接受行为会记录为一条 `scope.unverified` 活动条目，存储的 scope 不变。在已有 planned/active build 工作时规划 `**` mission 还会返回非阻塞的 `broad-scope` 警告（见下文“planned 编辑、defer 与暂停”），指出它会把哪些 mission 挡在围栏外。 |
| `tower_mission` | `id`（别名 `missionId`）、`status?`、`task_done?`、`task_drop?`+`task_drop_reason?`、`task_add?`、`blocker?`、`clear_blockers?`、`note?`、`scope?`、`allowMissingScope?`、`deferred?`、`pause_cause?`、`authorization?`、`accept?`、`accept_note?` | 更新单个 mission。`task_add` 在任务列表尾部追加 1–20 个非空字符串（每个 ≤200 字符），状态为 `open`，且不会重排既有任务索引；planned、active、paused、blocked 的 mission 都允许，completed、merged、abandoned 会以 `invalid-transition` 拒绝且不改变状态。因此追加的 `open` 任务会一直阻止 `tower_complete`，直到被完成或丢弃。worker 可安全使用的字段是 task/blocker/note；不能在这里设置 `merged`。暂停的 mission 记录 `pause_cause`（user/failure/resource/dependency）；planned mission 暂停时必须显式给出原因，`status:"planned"` 会把暂停的 mission 退回规划（清除原因，无需授权），而恢复到 `active` 仍遵循 `mode.requireResumeAuthorization`。`scope` 编辑 planned mission 的围栏（保持 planned）、扩大 active 或 completed 的围栏（并启动它），遵循与规划相同的“必须匹配已跟踪文件”规则与目录展开。`scope` 搭配 `allowMissingScope:true` 可接受尚不匹配任何已跟踪文件的条目（mission 将要创建的路径），适用于 plan、planned 编辑或扩大；接受行为记录为一条 `scope.unverified` 活动条目，该标志不会写入 mission。`deferred` 让 planned 或 active 的拥有路径（build 或 artifact）mission 退出 widen 排序：为 true 时，其他 mission 的编辑或扩大可以与其 scope 重叠，传 false 重新加入；该标志只在 mission 处于 planned/active 时影响排序决策。`accept:true` 记录人类对 artifact mission 已提交末端的接受：工具会通过 DSH 审批通道询问人类，并把当前分支末端写入记录；没有该通道时以 `approval-unavailable` 拒绝，任何参数都不能让接受变成 agent 自批（worker 调用会以 `acceptance-human-only` 拒绝）。 |
| `tower_inspect` | `view`（`status`/`roster`/`diff`/`preflight`/`doctor`）、`missionId?`（diff/preflight 必填）、`maxBytes?`、`offset?`、`limit?`、`includeGate?`、`includeArchived?`、`format?`、`checks?`、`compact?`、`fields?`、`sinceRevision?`（别名 `since_revision`）、`agent?`、`tail?`、`stat?` | 五个只读视图共用一个工具：`status`（面板、单个 mission 详情、分页与 markdown 看板；`fields` 把每个 mission 精确投影为指定字段；`format:"markdown"` 始终渲染完整看板，`sinceRevision` 只过滤 JSON 输出；`sinceRevision` 只保留在该 state revision 之后被逐行标记的行：`missions` 是过滤后的 mission 列表，`roster` 是过滤后的 roster 行**数**——roster 行本身来自 `roster` 视图（`agent`/`tail`），该视图忽略 `sinceRevision`；只有 spawn、interrupt 与 roster 写路径会给行打标记，而 `tower_plan`、`tower_mission`、`tower_complete`、`tower_test`（test-run 回执）、merge、review 与 worktree 写路径不写标记，正数时会漏掉这些变化（`0` 表示不过滤并返回全部行）；带 `missionId` 的 `status` 返回完整详情并忽略 `sinceRevision`；归档摘录不带标记，因此正数时 `includeArchived` 不会追加任何归档；test-run 回执（`testRuns`）只出现在 `missionId` 详情中，列表行里没有；带 worktree 的非终态 mission 还带 `worktreeDirty` 与 `uncommittedPathCount`，每个 mission 最多做一次有界 `git status` 读取，读不到时值为 null）、`roster`（子代理目录的实时活动、`stale` 标记、`lastObservedAt`（最后一次权威目录观测），以及死 agent 诊断字段 `failureReason`（最近一次激活失败的原因；任何非失败结果都会清除它）与 `previousOutcome`（被替换者退休前的 outcome）；`agent` 按名称或 agent id 选一行，`tail` 只保留最新 N 行）、`diff`（mission 分支的 merge-base diff；`stat:true` 用逐文件 `{path, added, deleted}` 计数替代 `patch`/`truncated`，二进制文件两项的值是 `null`，绝不返回 patch 字节）、`preflight`（合并门禁 blockers/warnings；每个 blocker 带有序的 `resolution`，结果顶层带 `order`——依赖合并按祖先优先，随后是 `rebase`，再是其余步骤——以及 `cycle`：`null`，或一个指出相关 mission id 的 `dependency-cycle` 结论与 `break-dependency-cycle` 步骤；不能合并的依赖（survey）给出的步骤是完成它（`complete-mission`），而不是合并它；这里只做诊断，绝不自动 merge 或 rebase；artifact mission 报 `acceptance-missing`/`acceptance-stale`，而不是 review blockers）、`doctor`（环境与 state/git 锁健康，含 Ralph 姿态；`checks:true` 只返回 `{ok, checks}` 且保留完整检查行，`compact:true` 只返回 `{ok, checks}`，通过的检查收缩为 `{id, status}`，未通过的检查额外保留 `detail`；两者同时给出时 compact 优先）。从不写状态或 git；输出与原来的独立工具一致，并带 `view` 字段。diff/preflight 需要 `missionId`；roster/diff 仅对已知 roster 角色开放。 |
| `tower_spawn` | `missionId`（别名 `id`）、`op?`（`spawn` 默认 / `takeover`）、`role`（`worker`/`reviewer`）、`name?`、`instructions?`、`worktreeRoot?`、`wait?`、`includeDirtyBase?` | 准备或复用 worktree 并启动子代理。worker 使用 `tower-worker`；reviewer 要求 mission 为 `completed`，并使用只读的 `tower-reviewer`；`review.mode:off` 时 reviewer 角色会以 `[tower:review-disabled]` 被拒绝。`op:"takeover"` 替换已不再运行的 worker 条目（ownerGeneration 递增）；旧的 `takeover:true` 字段会以替代路径报错。`wait:true` 等待结果，上限由 `spawn.maxWaitMs`（默认 90000）决定；旧的 `waitMs` 字段会指向该配置路径报错。每个 mission 只能有一个活跃 worker；`spawn.maxLiveWorkers` 限制整个仓库。报告在 `worktree` 里给出放置方式：分支工作树为 `{path, branch, baseCommit}`，读取共享检出或游离 sandbox 的 survey 为 `null`。 |
| `tower_send` | `to`、`subject`、`body`、`scope?`、`interrupt?`、`wake?`、`consentRef?` | 向 roster 名称、`tower` 或 `all` 发送持久消息。运行中的 roster agent 会被 steer 进当前回合；已停止的 agent 会保留消息，等下次运行时读取。`interrupt:true`（仅 tower）先中断运行中的回合并投递。`wake:true` 为已停止的 agent 启动新回合；若该 agent 无法恢复，则抛出 `agent-not-resumable`。无法观测的活动状态（目录报错或返回空列表）绝不会被当成已停止：此时 `wake:true` 返回 `woke:false` 并说明未声称唤醒；显式 `interrupt:true` 仍会尝试并如实回报，而不是被静默跳过。`consentRef` 记录用于审计。受 `send.maxPerMinute` 限速。 |
| `tower_inbox` | `limit?`、`include_read?` | 读取并确认发给调用者的消息；未读消息会阻止 `tower_complete`。 |
| `tower_complete` | `missionId`（别名 `id`）、`report`、`checks?` | worker 报告完成（mission 变为 `completed`，可进入 preflight 与可选审查）。要求当前 owner、无未完成任务/blocker、≥1 个提交、无未读消息；artifact mission 还要求全部声明的交付物都出现在已提交的末端。`report` 受 `gates.maxReportBytes`（默认 32768 UTF-8 字节）硬上限约束：超限会以 `invalid-argument` 拒绝并给出 `nextAction`（把全文写进 mission worktree 的文件），绝不截断；存储时会记录 `reportBytes`。`checks` 记录 `{name, command?, exitCode?, evidence?}` 证据；`gates.requireChecks` 可以强制要求。配置了测试发现时还会自动运行并添加 `tests` 检查；失败会抛出 `[tower:tests-failed]`。 |
| `tower_interrupt` | `to?`（roster 名称）、`agentId?`、`reason?` | 通过 `subagents.interrupt` 中断一个运行中的 roster agent，并记录 `state:"interrupted"`。幂等（未运行 → `interrupted:false`）。 |
| `tower_finding` | `op?`（`report` / `list` 默认 / `update`）、`id?`、`status?`、`note?`、过滤（`type?`、`severity?`、`missionId?`、`open?`、`limit?`）、`title?`、`summary?`、`details?`、`suggested_fix?`、`location?` | 一个 finding 生命周期（#163 Phase 4）。`report` 需要 `type`（bug/improve/vuln/idea）、`title`、`summary`、`details`、`suggested_fix`，新 finding 初始为 `open`；`list` 按 `id` 或过滤条件读取/列出；`update` 需要 `id` 加 `status`/`note`，状态为 `open → triaged → fixed`/`wontfix`，允许重新打开。只有控制塔或 worker 能修改；reviewer 只能列出/读取。 |
| `tower_review` | `missionId`（别名 `id`）、`status`（`clean`/`p1-Nitems`/`p2-Nitems`）、`merge`（`merge`/`fix-then-merge`/`hold`）、`findings`、`decision`、`checks?`、`breakGlassReason?` | 绑定当前 tip 的 reviewer 结论。reviewer 必须是获派的 reviewer（或由控制塔使用 break-glass）。`review.mode:off` 时不注册；仓库层为 `off` 时提交会以 `[tower:review-disabled]` 被拒绝。非 clean 结论使 mission 回到 active 后，其他 route 仍可为同一 reviewed tip 提交结论：追加到同一轮（`appended:true`），不再改变状态；tip 已移动时会被明确拒绝。同一轮内以记录顺序（`seq` 最大）最新的结论为准，merge gate、已落地合并检测、status 与 briefing 使用同一规则：同一轮中较晚的 clean 结论会取代较早的非 clean 结论。 |
| `tower_merge` | `missionId`（别名 `id`）、`timeoutMs?`（别名 `timeout_ms`） | 门禁全绿后合并。若合并提交已落地则记录（`reconciled`）；若命令失败但提交已存在则恢复（`recoveredFromFailure`）；区分 `merge-hook-failed` 与 `merge-conflict`。 |
| `tower_rebase` | `missionId`（别名 `id`） | 在 worktree 内把分支 rebase 到基线。worker 运行中或 worktree 脏时拒绝。分支已包含在基线中时返回 `alreadyMerged` 且保持分支不动。 |
| `tower_teardown` | `force?`、`exclude?`、`orphans?`、`dry_run?`（别名 `dryRun`） | 移除符合条件的 merged/abandoned worktree 与分支；运行中的 agent 始终保留。每次移除对临时锁（EPERM/EBUSY/EACCES）最多重试三次，决策中带有 `attempts`；永久失败会保留 mission 记录并报告最终错误。最后一次归档扫描在 `tower-archive` 组件行挂载时按 `archive` 策略执行，`archived` 列出被归档的 mission id。`dry_run` 不写入任何内容，并返回 `archivePreview`（`{missions: [{missionId, reason}], year}`），它由同一策略输入计算，并按本次运行计划完成的 worktree 移除与 detached sandbox 清理后的状态投影，因此在清理成功的前提下，相同输入的真实运行会归档同一批 id。`orphans: true` 显式启用对配置 root 下、没有任何 mission/sandbox/review 记录引用的 git worktree 的清扫（#185）：每个 git 登记项各得到一条决策，只移除干净的检出（脏检出保留，目录已消失的登记会被 prune），主检出、所有被 state 引用的路径以及 root 之外的路径始终保留。报告为 `orphanWorktrees: {root, decisions, removed, pruned}`，dry run 只预览、不移除也不 prune。不传 `orphans` 的调用从不查看这些检出。未匹配任何 mission 或 roster 行的 `exclude` id 会出现在 `unmatchedExclude` 中，并附带 `keep` 决策（原因为 `exclude did not match any mission`）。不会删除任何数据；`archive.afterDays:0` 会立即归档刚拆除的 mission。 |
| `tower_mode` | `active?`（`true`/`false`/`"takeover"`）、`reason?`、`authorization?` | 不传 `active`：报告模式、最近修改、被暂停的 goal、被拒绝的工具、store 路径、插件版本、HMR 可用性、workspace 锁持有者，以及进入策略所依据的 Ralph 姿态（`ralph: {policy, runs, rounds, liveRounds, detail}`）。传 `active`：`true` 进入、`false` 退出、`"takeover"` 在获得用户明确批准后从已停用的属主转移仓库所有权。写操作需要非空 `reason` 且 `mode.allowAgentControl:true`；`takeover` 还必须提供 `authorization`（记录在活动条目上的审计引用）。进入时如有活跃 Ralph 循环：默认 `mode.ralphPolicy:"stop"` 会释放循环并在结果中报告 `ralphReleased`，设为 `"refuse"` 时以 `[tower:invalid-transition]` 拒绝进入。 |
| `/tower takeover <reason>` | — | 人类专用的所有权转移命令；即使 `mode.allowAgentControl:false` 也可用。 |
| `/tasks`、`/tower tasks` | — | 人类可用的只读实时 roster 面板：每个存活 roster agent 一行（mission、角色、名称、短分支名、状态、距其最近一条记录事件的静默时长、该事件本身），最静默者在前，最多 20 行，页脚给出 `N live, M stale` 计数与 `tower_interrupt` 处置提示。不消耗模型回合，也不做任何写入（不触碰 `state.json`、activity 日志或 modes store）。过期判定与 `tower_inspect` 的 `roster` 视图及合并门禁使用同一条 `spawn.staleMs` 规则。仅当宿主 profile 未定义其他 `tasks` 命令时插件才注册 `/tasks`；`/tower tasks` 是始终可用的别名，当前 profile 实际采用哪个会在命令描述中说明（#160）。 |
| `tower_reload` | — | 仅开发用：请求 DSH HMR 对账 profile 并从磁盘重载 Host 插件。`tower-hmr` 组件行开启时注册（该行随包关闭）；在工具结果返回后调度（默认 50 ms）；没有 HMR 时以 `reload-unavailable` 失败。它在 `host/tool-profiles.js` 中登记为唯一的仓库可选工具，因此可以在没有仓库时修复损坏的 profile；决定这一路径的是工具身份，而不是调用者是否传了 `repoRoot`。 |
| `tower_recover` | `action`（`status`/`clear-stale-lock`/`clear-workspace-lock`）、`confirm?`、`force?` | 恢复诊断，以及针对 state 写锁、短暂存在的 state 提交互斥锁（`state.commit.lock`）和仓库 workspace 锁（`<git-common-dir>/dsh-tower/tower.lock`）的显式 stale 锁修复。当变更报 `state-locked`/`state-commit-busy`，或 `tower_inspect` 的 doctor 报告遗留 `commit-lock` 时，用 `status` 查看 `stateLock` 与 `commitLock`：能解析时返回持有者 `{pid, startedAt, ageMs, heartbeatAgeMs, stale}`，文件存在但无法解析（撕裂写入）时返回 `{unreadable:true, path, error}`（不可读记录是死锁，不是“没有锁”）。`clear-stale-lock` 需要 `confirm:"CLEAR_STALE_LOCK"`，只把 PID 已被证明死亡的记录改名为唯一的数字备份 `.recovered-<timestamp><tick>`（同一毫秒内的两次恢复也不会互相覆盖；输出中的 `backup` 为 state 锁备份，`commitBackup` 为提交互斥锁备份）。`force:true` 还能清理 PID 仍存活但心跳静默（PID 被复用或进程已停止）的记录以及不可读记录；不带 `force` 时不可读记录会以 `state-commit-lock-unreadable`/`state-lock-unreadable` 拒绝并给出可执行的 `nextAction`。被移动的记录始终只改名、绝不 unlink。`status` 还会返回仓库 workspace 锁的 `workspaceLock`：`{path, bytes, mtime, held, self, stale, corrupt, unreadable, torn, aged, reclaimable, pid, sessionId}`。撕裂记录（空、纯空白或不是锁对象）只有在 mtime 超过 30 秒 torn 宽限期后，才会被下一次获取自动回收并改名为 `tower.lock.recovered-<ts>`；新产生的撕裂文件以及所有可解析记录保持原有行为。`clear-workspace-lock` 需要 `confirm:"CLEAR_WORKSPACE_LOCK"`；不带 `force` 时只移动超过宽限期的撕裂记录或 PID 已被证明死亡的记录，活着的持有者、无法证明死亡、新撕裂文件和不可读文件都会被拒绝，并给出路径、字节数、mtime 与可执行的 `nextAction`。`tower_recover` 在 workspace 锁门之前运行（其他仓库工具仍会报 `workspace-busy`，消息现在会带上锁路径、大小与 mtime），但恢复仍绑定 Tower 属主。恢复不会重置状态或 worktree；清理提交互斥锁不替代写者围栏：每次提交仍会校验 state 锁 token 与 `state.json` 的确切字节并对落地修订号分类，因此竞争失败的写者会失败关闭。 |
| `tower_test` | `missionId`（别名 `id`） | 运行 worktree 的 `package.json` 中 `tower.testDiscovery` 配置的发现命令并记录回执；失败时 `ok:false`。自动准入检查请用 `tower_complete`。 |
| `tower_batch` | `action`（`create`/`status`/`close`/`abandon`）、`missionIds?`、`exclusions?`、`requiredChecks?`、`receiptPaths?`、`batchId?`、`checks?`、`treeTip?`、`receiptHashes?`、`reason?` | 有限证据批次。create 冻结成员/检查/回执；close 校验每条必需检查与回执哈希；`merged` 成员也可参与 close；abandon 可退掉过期的 open batch 且不删除 mission。成员关系不可变。 |
| `tower_resource` | `action`（`acquire`/`release`/`status`）、`name?`、`holder?`、`token?`、`ttlMs?`、`force?` | 每个仓库的咨询式租约，位于 `<common>/dsh-tower/leases.json`。没有 OS CPU/内存硬上限；过期的租约需要显式 `force` 与正确 token。 |
| `tower_import` | `op?`（有 `sourcePath` 时推断为 `snapshot`，否则 `map`）、`sourcePath?`、`action?`（`map`/`status`）、`sourceHash?`、`oldId?`、`newMissionId?` | 一个遗留资源工具（#163 Phase 4）。`snapshot`：只读导入 Tower Codex `schemaVersion:1` 或 DSH 旧版 state，完整 payload 存到 `<common>/dsh-tower/legacy/<sha256>.json`，state 中只保存摘要。`map`：仅审计用途的旧 id 映射，映射只追加；`action:"status"` 列出映射。绝不激活/接管/恢复暂停的 mission。除只读 `status` 动作外仅限控制塔。 |

### 只读取视图的一部分

只读视图支持可选的投影，调用方可以在不改变任何默认输出的前提下压缩大响应。每行都是一个工具的一种调用：

```json
{"tool":"tower_inspect","arguments":{"view":"doctor","compact":true}}
{"tool":"tower_inspect","arguments":{"view":"doctor","checks":true}}
{"tool":"tower_inspect","arguments":{"view":"status","fields":["id","status","owner"]}}
{"tool":"tower_inspect","arguments":{"view":"status","sinceRevision":41}}
{"tool":"tower_inspect","arguments":{"view":"roster","agent":"worker-m1","tail":5}}
{"tool":"tower_inspect","arguments":{"view":"diff","missionId":"M7","stat":true}}
```

`sinceRevision` 使用逐行的 `revision` 标记。只有 spawn、interrupt 与 roster 写路径会给行打标记（spawn 的 reserve/outcome、interrupt，以及 roster 的观测/退休/watchdog 变更）；`tower_plan`、`tower_mission`、`tower_complete`、`tower_test` 的 test-run 回执、merge、review 与 worktree 写路径（`tower_spawn` 的 worktree 供给、`tower_rebase`、`tower_teardown`）只递增 `state.revision` 而不会给行打标记，因此正数会漏掉这些变化。test-run 回执存放在 `testRuns` 中，只出现在 `missionId` 详情里，列表行中没有。在 JSON 看板中，`missions` 是过滤后的 mission 列表，`roster` 是过滤后的 roster 行**数**；roster 行本身来自 `roster` 视图（`agent`/`tail`），该视图忽略 `sinceRevision`。带 `missionId` 的 `status` 返回完整详情并忽略 `sinceRevision`；归档摘录不带标记，因此正数时 `includeArchived` 不会追加任何归档。传 `0` 读取全部行（不过滤）。该过滤只作用于 JSON 输出：`format:"markdown"` 始终渲染完整看板。`compact` 会保留每个未通过检查及其 `detail`，因此更小的 doctor 报告绝不会隐藏失败。

## scope 条目

`scope` 条目是相对仓库根目录的**文件 glob**，由 `fileInScope` 作为纯 glob 匹配：
`*` 只匹配同一路径段内的字符，`**` 匹配任意深度（包括零层），`?` 匹配一个非分隔符
字符，其余字符都按字面处理。因此 scope 条目命名的是文件，而不是目录：字面条目
`docs/guide` 只匹配名字恰好是 `docs/guide` 的文件，不会匹配该目录下的任何文件。

`tower_plan` 不改变这个匹配器，只在保存新计划时把目录形态的条目规范化；通过
`tower_mission` 编辑 planned mission 的 scope 或扩大 scope 时也做同样处理：

| 写入的条目 | 存储的 scope | 原因 |
|---|---|---|
| `docs/guide/` | `docs/guide/**` | 尾部分隔符明确表示“目录”，即使它尚不存在。 |
| `docs/guide` | `docs/guide/**` | 规划时所在的 checkout 在该路径上确有目录（规划时探测一次）。 |
| `docs/guide`（不存在该目录） | `docs/guide` | 它可能是已有文件，也可能是 mission 将要创建的文件；保持字面。 |
| `docs/guide/**` | `docs/guide/**` | 已经是显式的子树 glob；保持不变。 |
| `docs/*.md` | `docs/*.md` | glob 条目是文件模式；保持不变。 |
| `.` | `**` | 仓库根就是整棵树。 |

存储的 scope 始终是显式 glob，而不是目录写法，因此门禁、briefing 和
`tower_inspect` 看到的围栏完全一致。只有**新输入**会被规范化：mission 上已经存储的
scope 永远不会被改写，因此在新规则之前规划、仍保存字面条目的 mission 会继续拒绝该
目录下的文件，直到控制塔显式扩大 scope。目录探测失败时条目保持字面，不会让规划失败。

目录子树推荐写成 `docs/guide/**` 或 `docs/guide/`。避免只写裸 `docs/guide`：它只有在
规划时该目录已经存在才会展开，因此同一段文本可能随仓库状态代表一个文件或整棵子树。

### scope 条目必须指向真实内容

上文的展开只决定条目如何存储；“是否存在”决定它能否被规划。规划会先把原始条目与
`git ls-files` 对照，再规范化，因此拼写错误会在 mission 建立前被发现，而不是在 spawn
之后——那时只能放弃并重新规划（#200）。

以下条目直接通过：`**`、`.`、目录形态条目（尾部分隔符，或规划 checkout 中确实存在的
裸路径），以及至少匹配一个已跟踪文件的条目。若条目的静态前缀（第一个 `*`、`?`、`[`
之前、到最后一个分隔符为止的文本）不在任何已跟踪树内，也通过：规划无法知道 mission
是否会创建该树，因此 README-only 仓库中的 `src/**` 是未来树，不是拼写错误。根级字面
条目（没有目录前缀）同样无法验证，保持合法，这样未知依赖仍保留自己的错误，门禁也
照旧围栏该路径。

其余情况属于“存在但无匹配”的已知区域：前缀已被跟踪（或 checkout 中存在），但条目
匹配不到任何已跟踪文件时，以 `invalid-argument` 拒绝。只匹配被忽略文件的 glob 也在
此列。错误会指出第一个失败条目、最近的已存在前缀，以及该目录下最多 5 个已跟踪候选；
`details.problems` 逐条给出 `{entry, reason, closestPrefix, candidates}`，
`details.operation` 则标明被拒绝的是规划（`plan`，包括 planned mission 的 scope 编辑）还是扩大（`widen`）：

```text
[tower:invalid-argument] no tracked file matches "tests/teardown*.test.mjs"; nearest
existing prefix "tests"; tracked files there: tests/cleanup.test.mjs — next: use a
tracked path such as "tests/cleanup.test.mjs", or pass allowMissingScope: true to
accept a path a mission will create
```

存在性比对会折叠大小写：仅大小写不一致属于门禁的比较判定（#90），不是路径缺失，且
不会改写任何内容。若条目确实是 mission 将创建的路径，在 `tower_plan` 的对应 mission
上传 `allowMissingScope:true`，或在 `tower_mission` 的 `scope` 中同时传入该标志。调用会
接受这些条目而不做证明，并记录一条 `scope.unverified` 活动条目列出它们。该标志是输入
决策，不会写入 mission，存储的 scope 也不变。`tower_mission` 使用同一规则校验新条目：
planned mission 是编辑围栏并保持 planned 排序，active 或 completed 是扩大围栏并启动它；
`allowMissingScope:true` 在两种情况下都可用。两者只在被拒绝条目的 `details.operation`
（`"plan"` 或 `"widen"`）上不同：两种拒绝都会说明上文的“存在性”规则，且 next action
明确命名 `allowMissingScope:true`，因此确知 mission 会创建该路径的调用者仍可显式选择接受。

scope 为 `**` 的 mission 拥有未来所有路径，因此其他在途 mission 之后的规划编辑或扩大都会与
它重叠。于是 `tower_plan` 在已有 planned/active 的拥有路径 mission 时规划新的整仓库
mission，会返回非阻塞的 `broad-scope` 警告：警告列出会被该围栏挡住的 mission，并建议把
release 准备 mission 放到最后规划、标记 deferred，或在其他 mission 扩大前暂停它。规划本身
仍然成功。

### planned 编辑、defer 与暂停

planned mission 尚未开始，因此 `tower_mission` 把它的 `scope` 当作规划编辑：替换围栏、
`scopeGeneration` 递增，mission 保持 `planned`。存在性与目录规则与规划相同，
`allowMissingScope:true` 同样适用于 mission 将要创建的路径。

planned 或 active 的拥有路径（build 或 artifact）mission 可以设置 `deferred:true` 退出
widen 排序：deferred 期间它的 scope 不再阻止其他 mission 的规划编辑或扩大，因此可以把
release 准备放在最后规划，而不必重写围栏。`deferred:false` 重新加入排序；mission 进入终态后该标志不再影响
任何决策。

从 `planned` 暂停必须显式提供 `pause_cause`。`status:"planned"` 会把暂停的 mission
退回规划、清除原因且无需授权；只有 `status:"active"` 遵循
`mode.requireResumeAuthorization`。暂停的 mission 会被 widen 重叠检查跳过，因此暂停也是
解除排序阻塞的一种方式。

当 `git ls-files` 失败或返回空列表时，无法证明存在性，规划会跳过该检查；门禁仍按
原样围栏存储的 scope。

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
