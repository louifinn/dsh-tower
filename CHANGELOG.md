# Changelog

> 自 2.0.0 起，每个版本按 **新增 / 变更 / 修复** 三类组织；更早的版本保留原始流水式记录。

## 未发布（Unreleased）

### 变更

- **README 徽章**：中英文 README 增加 “Listed on dsh-plugin.org” 徽章，链接到插件市场条目。
- **#66 all-or-nothing bundle**：`cordis.patch.yml` 改为单个 `tower-bundle` `cordis:group`，Host、
  skills 与 worker/reviewer preset 成为内部 section；子行不再可独立启停，避免 host 关闭后的 orphan。
- **#64 preset 前置校验**：模式进入与 `tower_plan` 前解析 worker/reviewer preset；缺失时以稳定
  `preset-missing` 拒绝并点名 `preset-tower-worker` / `preset-tower-reviewer`，不再先规划后死锁。
- **#65 可选能力开关**：`tools.exposeBatch/exposeImport/exposeLeases/exposeTests/exposeRecovery/exposeDoctor`
  可独立关闭；`gates.requireTests:true` 与 tests/tools 关闭的组合在配置解析时直接拒绝。
- **#67 组件文案**：host locale 增加 `components.{tower-bundle,tower-skills,preset-*}` 的
  title/summary/disables 中英文案；预设仍为内部 section，不再作为独立开关暴露。
- **#52 继续拆分 tools**：review/preflight/merge-rebase-teardown 拆为 per-tool 模块；
  `lib/tools.js` 降至约 503 行。
- **#51 two-phase 试点**：`tower_complete` 改为锁外 prepare + 锁内 revision 复核；`submitReview`
  同样拆为锁外准备（actor/worktree/tip/round）与锁内 revision 复核；新增
  `lock-holds.jsonl` 遥测与 doctor p50/p95 检查（>1s warn）。
- **#51 git 互斥基础**：新增 `withGitLock` / `git.lock`，用与 state lock 相同的 token/PID-dead
  回收协议串行化 git 操作，为把 git 移出 state lock 做准备。
- **#51 merge/rebase/teardown**：三者改为 prepare/act/commit；长 git 操作在 `git.lock` 下进行，
  state lock 只做 revision 复核与写回；rebase 增加可对账的 `rebaseIntent`。
- **#51 init/provision/merge reconcile**：init/provision 同样锁外 prepare + `git.lock` act +
  短 state lock 复核；merge 的 intent/landed 对账改为锁外 git 观察 + revision CAS，任何
  state lock 内不再启动 git。
- **#51 init/provision**：`tower_init` 与 worktree provision 同样改为锁外 prepare + `git.lock`
  下 act + 短 state lock 复核；provision 失败/并发变更时回滚 worktree 与 branch。
- **#68 owner 恢复提示**：`towerAgentId` 缺失时写工具现在返回可操作错误
  “run tower_init to re-claim”，`tower_status` 暴露 `towerAgentId/ownerMissing`，doctor 增加
  `tower-owner` 检查；`tower_init` 重新绑定后恢复写权限。
- **#52 Tower 拆分**：`lib/tower.js` 从约 2.9k 行降到 **535** 行；plan/mission/checkCompletion/
  missionContext/enrichedMissions/board/spawn/recording 拆为 `lib/tower/*.js` use-case 模块，
  `Tower` 方法仅作委托，行为、错误码与锁顺序不变。
- **#45 use-case 类型**：`lib/git.js` 与全部 `lib/tower/*.js` 纳入 checkJs；补齐
  `worktreeOwnership` 的 error code/optional head/common dir 类型，`types:check` 覆盖所有
  use-case 模块。
- **#50 test doubles**：`tests/support/memory-store.js` 与 `scripted-vcs.js` 提供无磁盘/无 git 的
  Store/Vcs 契约；新增完整 scripted lifecycle 与 10 项 adapter contract 测试。
- **#45 domain 类型**：`lib/domain/*.js` 纳入 checkJs，新增 `tests/type-contracts.ts` 正/负类型
  fixture；types 契约与 domain 签名对齐。
- **packaging**：`package.json files` 补齐 `lib/tower/*.js`，避免发布包遗漏 use-case 模块。
- **#45 错误结构化继续**：纯 domain、review/findings/read/batch/rebase、`lib/tower.js` 与 infra
  （store/config/git/tests）均改为抛出带 code 的 `TowerToolError`；`classifyError` 的 26 条
  prose `RULES` 表已删除，纯文本错误统一落到 `tool-internal`。
- **#54 mode 锁等待**：`mode.lockTimeoutMs`（默认 5000ms）统一 modes.lock 的有界等待与死锁回收语义。
- **#59 兼容性记录**：新增随包发布 `COMPATIBILITY.md`，doctor 增加 `host-version` 检查（verified /
  untested-newer / untested-older / unknown，仅警告）。
- **#61 共存冲突**：README 增加 “Known conflicts”，doctor 增加 `loader-conflicts` 检查。
- **#58 仓库产物排除**：`docs.boardLocation:"repo"` 与仓库内 `worktrees.root` 自动写入
  `.git/info/exclude`（幂等，绝不改 `.gitignore`）；新增 `init.autoExclude`。
- **#44 模式进入审计**：`tower_status` 增加 `mode.lastChange`/`mode.history`；新增
  `mode.requireHumanAckOnFirstEntry` 与 `/tower ack`；安全文档补充模型主动进入的威胁模型。
- **#43 默认值提醒**：doctor 的 `default-reversals` 检查提示仍依赖旧默认值的 profile。
- **#60 提供商冷却**：spawn 在连续可重试失败后进入进程内冷却并收缩预算；
  `tower_status.spawn` 暴露 `{inflight, budget, blockedUntil}`。
- **#48 发布文件守卫**：新增 `scripts/pack-manifest.txt`、`npm run pack:check` 与 CI 步骤。
- **#62 工具面预算**：`tools.exposeOperational:false` 可跳过 batch/resource/import/legacy/recover/test/doctor 工具。
- **#47 live 守卫**：`tests/live` 需要显式 `DSH_LIVE=1` 与隔离的 `DSH_HOME`，不再可能误跑真实 profile。
- **#63**：doctor 不再把正常 live worker 视为 warn。

## 2.0.4（2026-10-21）

### 变更

- **文档索引补齐**：根 README 的“文档”区补上《什么时候用 Tower》链接；`docs/README.md` 新增
  “All pages”完整页面索引（指南 / 参考 / 运维与背景），与中文文档索引对齐。
- **全量文档与产品一致性审查（功能/哲学）**：把 `review.requireReview` 默认 `false`（审查可选）
  同步到快速开始、示例、FAQ、blocker/测试/架构/配置/迁移说明与中英文页面；修正测试门禁描述为
  当前分支 tip（而非“被审查 tip”）；修正单 mission 审查豁免需要
  `gates.allowReviewExemption:true`；补齐 2.0.1–2.0.3 升级说明；README 的“何时使用/工作流对比”
  不再把独立审查写成默认必经步骤。
- **模型可见工具描述同步**：`tower_plan` 的 `reviewPolicy`、`tower_complete` 的完成语义、
  `tower_preflight` 的 review blocker 条件，以及 reviewer 错误文案不再暗示“完成即等待审查”。
- **模式控制默认改为 Agent 可操作**：`mode.allowAgentControl` 默认 `true`，`tower_control` 默认注册，
  模型可带理由进出 Tower 模式；设 `false` 可恢复仅人类控制。同步删除文档中的“human-owned/人类掌握”
  表述，改为“可配置、显式且可归因”；模式提示、工具参考、安全模型与 UI 说明一并更新。

### 修复

- **安全审计 2026-10-21（#13）**：授权解析改为 fail-closed（未登记/无法解析的调用者不再被视为
  tower）；`tower_merge` 只合并 gate 校验过的 SHA 并在 gate→merge 间重新校验 base/tip；
  已落地对账要求分支 tip 真正包含在 base；reviewer 身份与 spawn tip 缺失均拒绝；完成时拒绝 dirty
  worktree；spawn 先预留 roster 再启动并在失败时回收；provision/teardown 与状态写入增加回滚/归属
  校验；state/tower 锁改为可安全回收死 PID 并避免删除活跃锁；Git 子进程剥离 `GIT_*` 重定向，
  测试发现使用最小环境；lease status 不再回显 token；仓库级配置只能收紧、不能放宽 `mode.*`；
  恢复 skill 删除破坏性 rm 指引。
- **GitHub Issues #14–#42 的回归项**：stale roster 可恢复；dirty completion、adopt 重复观测、
  spawn 失败、配置嵌套未知键、doctor 坏配置、teardown 分支删除失败、batch receipt 文件校验、
  mode/control/reload 事件、Git 超时配置、不可变 SHA merge、测试 receipt 体积上限等。
- **模式状态未知时显式提示**：UI 在无法从已加载历史证明模式时显示 `mode unknown` chip，
  不再静默伪装为关闭；同一 session 还会持久化最近已知模式（7 天过期，仅展示，不单独驱动 denied
  行）；新增未知调用者对 `tower_mission` / `tower_test` / finding 工具的身份拒绝。
- **`tower_recover`**：新增恢复诊断/显式 stale state-lock 清理工具；只移动 PID 已死的锁到备份，
  需要 `confirm:"CLEAR_STALE_LOCK"`，绝不重置 state/worktree。
- **#30 工具层显式错误码**：tools 层的校验/前置条件不再依赖文本 regex，改为直接抛出带稳定 code 的
  `TowerToolError`（invalid-argument / reviewer-prerequisite / spawn-unavailable / preset-missing /
  not-authorized 等）。
- **文档与实现不一致**：`gates.requireTests` 文档原写“reviewed tip”，实现校验当前 mission 分支
  tip；已同步英文/中文配置、测试与 blocker 参考。

## 2.0.3（2026-10-18）

### 新增

- **`review.requireReview` 全局开关**：默认 `false`（审查可选）；设为 `true` 时合并门禁强制独立 clean
  审查（`no-review`/`not-clean`/`review-hold`/`review-not-approved`/`tip-moved`/
  `review-mission-mismatch`）。`tower_review` 始终可提交并记录；全局开启时单 mission 仍可用
  `reviewPolicy:"none"` + 理由做更窄的豁免。

### 变更

- **应用场景文档补充具体举例**：`docs/guide/scenarios-and-philosophy.md` 与中文版新增 Tower 七类
  场景的“具体例子/为什么用 Tower”速查表，以及 Tower、Agent Teams、Ralph 循环、Workflow 编排、
  普通并行子代理和混合阶段各自的具体例子；同时说明独立审查默认可选、可全局强制，并更新 README、
  FAQ、配置/安全参考页与中文对应页。
- **离线套件**：219 项（新增 `review.requireReview:false` 无 reviewer 合并用例）。

## 2.0.2（2026-10-18）

### 新增

- **UI 常驻 Tower 模式指示器（#11）**：`dsh-tower-ui` 0.2.1 在 composer dock 显示
  `Tower · on` chip（历史推导、刷新后仍在），tooltip 包含 `/tower off`、仓库 basename、
  workspace lock 状态与最后变更者；不再只有一次性命令输出。
- **模式感知的 disabled 工具行（#12）**：Tower 模式激活时动态注册 denyTools 的 toolview
  （含 `update_goal` resume），把 guard 拒绝渲染为独立的 `Tower mode · disabled` 行；模式关闭后
  销毁注册，原生 toolview 恢复。所有 `mode.denyTools`（可见时）与默认 12 项均覆盖。

### 变更

- **文档变更补记**：2.0.1 已随包发布中英文
  [应用场景与设计哲学指南](docs/guide/scenarios-and-philosophy.md)
  （[中文](docs/zh/guide/scenarios-and-philosophy.md)），并在 README、文档索引与 FAQ 增加入口；
  本条补记避免发布日志遗漏纯文档变更。UI bundle 版本升至 0.2.1（private，不单独发布）。

### 修复

- **#11 Web UI 缺少 Tower 模式/workspace lock 的持久指示**：dock chip 从会话历史推导模式，
  `/tower on|off`、`tower_control`、`tower_mode` 更新后重新渲染；无模式事件时回退到静态提示。
- **#12 Tower 模式拒绝的工具显示为普通失败**：对 `tower mode:` 拒绝使用 warn/neutral 样式与
  `Tower mode · disabled` 标签，保留可操作消息与 `/tower off` 提示；普通错误样式不变。

## 2.0.1（2026-10-18）

### 新增

- **`tower_batch` 的 `abandon` 动作**：可带 `reason` 退掉过期的 open batch，不修改 mission 状态；
  用于"先 merge 后 close"或证据窗口已过的场景。
- **应用场景与设计哲学文档**：新增中英文
  [`docs/guide/scenarios-and-philosophy.md`](docs/guide/scenarios-and-philosophy.md) /
  [`docs/zh/guide/scenarios-and-philosophy.md`](docs/zh/guide/scenarios-and-philosophy.md)，覆盖 Tower
  设计哲学、适用/不适用场景、与 Agent Teams / Ralph 循环 / Workflow 编排 / 普通并行子代理的对比表、
  5 个落地场景、选择路径、成本/反模式与检查清单；根 README、文档索引和 FAQ 增加入口与摘要。

### 修复

- **#3 `allowAgentControl` 被 schema 默认值遮蔽**：移除 `mode.allowAgentControl` 的 schema 默认值，
  在 legacy 别名解析后再应用默认；随包 patch 改用 canonical `mode.allowAgentControl: true`。
  Cordis 校验后的配置现在能正确注册 `tower_control`。
- **#4 `tower_preflight` 未知 mission 产生非 lossless 输出**：`evaluateGate` 的 early return 与工具
  包装补齐 `branchTip/baseTip/changedFiles/review` 的 `null`/`[]` 形状。
- **#5 未知依赖被分类为 `tool-internal`**：`depends on unknown mission` 归入 `invalid-argument`。
- **#6 worker 可 spawn 到 merged/abandoned mission**：spawn 前拒绝终态 mission，不再 provision/
  activation，不再改写已合并 mission 的 owner/generation。
- **#7 live `tests/live/ui-slots.cjs` 在新会话 dock 隐藏时误报**：先提交 host-handled `/tower`
  命令绑定会话，再断言 dock；`DSH_TEST_EXPECT_HINT=1` 才要求 dock 可见。
- **#8 `plan-mode.test.mjs` 写入真实 `$DSH_HOME`**：测试前设置临时 `DSH_HOME` 并在 after 清理；
  清理了历史 `session-plan-test` 残留。
- **#9 `tower_batch` close 拒绝 merged 成员/无法退掉 stale batch**：`merged` 与 completed 一样
  可 close（checks 仍从完成报告/testRuns/close-time checks 解析）；新增 `abandon` 且 batch 状态
  可退，不会永久卡死。
- **#10 `tower_doctor` 在成功 teardown 后误报 worktree missing**：跳过带 `worktreeRemovedAt` 的
  mission，并在检查详情中注明已移除数量。

### 变更

- 离线套件增至 212 项（新增 issue 回归覆盖）；`docs:check` 仍为 28 tools / 32 blockers /
  30 errors / 25 events。

## 2.0.0（2026-10-18）

### 新增

- **仓库级配置层**：`Tower.open()` 读取 `<git-common-dir>/dsh-tower/config.json`，优先级为
  代码默认 < profile 配置 < 仓库配置 < 工具参数；`review`/`merge`/`worktrees`/`spawn` 分组生效。
- **稳定工具错误码**：新增 `lib/errors.js`，工具失败统一 `[tower:<code>]` 前缀，覆盖 17 个 code；
  新增 `docs/reference/errors.md` 并由 `npm run docs:check` 校验。
- **finding 生命周期**：新增 `tower_findings`（列表/读取/状态流转/备注），状态为
  `open → triaged → fixed` / `wontfix` 且可重新打开；只有 tower 或 worker 能改状态，reviewer 只读。
- **中文文档**：新增 `docs/zh/`（文档索引、quickstart、工具/配置/blocker/错误码参考），
  与英文参考页保持同一套工具名、blocker 与错误码。
- **测试与门禁**：新增仓库配置、finding 生命周期、工具别名/错误码/输出 schema、spawn mock
  与全流程 schema 校验用例；`docs:check` 同时校验中英文参考页、工具名、blocker 与错误码。
- **协议硬化**：`tower_interrupt`（停止 running agent）、`tower_send(interrupt:true)`；
  `tower_init` 支持 `autoGitInit`/`snapshotDirty`/`reanchor`；worker 不能直接完成/放弃/扩界，
  completed 必须经 `tower_complete`；单 mission 单活 worker + `takeover` 接管 + generation。
- **治理与可观测**：可选 `mode.workspaceLock` 仓库互斥；`spawn.maxLiveWorkers`、`send.maxPerMinute`
  与 roster stale 标记；`tower_status` 分页/单 mission 明细/gate digest/markdown；`MISSIONS.md`
  人类可读门板；`tower/*` 进程内事件；`tower_complete.checks` + `gates.requireChecks`。
- **热重载**：`/tower reload` 与 `tower_reload` 调用 DSH HMR `reconcileProfile`；新增
  `npm run dev:hmr` 脚本把 linked 仓库加入 profile HMR watch root；`docs/guide/hot-reload.md`。
- **2.1 测试准入**：读取 worktree `package.json` 的 `tower.testDiscovery`（TAP/json-array），支持
  `tests.admission:spawn|complete`、16 MiB/60s 预算、minCount/required；`tower_test` 与
  `tower_complete` 自动生成 `tests` check；`gates.requireTests` / `tests-missing` / `tests-failed`。
- **2.1 批次与运营**：`tower_batch`（create/status/close，冻结成员、requiredChecks、receiptPaths）、
  `tower_resource`（advisory lease，token/过期显式 force）、`tower_doctor`（只读健康契约）、
  `tower_import_legacy` / `tower_legacy_map`（只读快照 + 审计映射）。
- **2.1 治理**：per-repo roster watchdog（`spawn.staleMs` 15s 标记 stale 并阻断合并）、
  `spawn.maxWaitMs` 90s、`mode.workspaceLockScope`、plan/tower 互斥（默认清除 plan）、
  `/tower base <branch>`、`docs.boardLocation`、delivery ack、merge intent 持久化。
- **2.1 UI**：ui-bundle 增加 12 个 tower tool 卡片、composer dock 最新摘要与 shell.overlay 瞬时状态条；
  纯会话派生，无 Host RPC/iframe。
- **2.1 文档**：`docs/reference/testing.md`、`operations.md`、`doctor.md` 与中文同步；工具面 28。

### 变更

- **结构化输出 schema**：全部工具声明 output schema（spawn/status/diff/merge/review/preflight
  等核心工具含字段结构），并按 DSH 的输出校验规则保证可空字段可空。
- **命名统一（兼容别名）**：mission 级工具同时接受 `id` 与 `missionId`；`task_done`/`taskDone`、
  `task_drop`/`taskDrop`、`clear_blockers`/`clearBlockers`、`include_read`/`includeRead`、
  `dry_run`/`dryRun`、`timeoutMs`/`timeout_ms`、`waitMs`/`wait_ms` 等写法均可，并在参数 schema
  中显式声明；输出保持既有规范。
- **诊断信息**：`tower_status` 增加 `config.path`、`config.repoConfigPresent` 与
  `findingsByStatus`；worker/reviewer preset 允许 `tower_findings`。
- **配置解析**：兼容别名只用于补缺——同时设置 `section` 与 `mode.promptSection` 时规范键优先；
  仓库配置增加 1 MiB 大小上限与 `__proto__`/`constructor`/`prototype` 等危险键拒绝。
- **配置默认值**：`mode.denyTools` 追加 workflow/ralph/subagent/subagent_fork/wait_agent/team_task_list
  （Tower 模式与其它编排互斥）；新增 `spawn.maxLiveWorkers:4`、`spawn.staleMs:15000`、
  `spawn.maxWaitMs:90000`、`send.maxPerMinute:120`、`gates.requireChecks:false`、
  `gates.requireTests:false`、`docs.board:true`、`leases.ttlMs:900000`、`dev.hotReload:true`；
  随包 patch 打开 `workspaceLock`/`interruptDefault`/`autoGitInit`。
- **briefing**：worker/reviewer 生成历史审查、上一轮 findings/decision、completion checks 与
  related findings，长文本截断；reviewer 必须核对 completion checks。
- **输出/工具面**：`tower_status` 增加 total/offset/nextOffset/detail/markdown，并**默认只返回前 20 个 mission**（旧版返回全部；旧调用需要更多时用 `limit`/`offset`）；`tower_adopt`
  支持 `retireMissing:false`；`tower_mode` 返回 pluginVersion/HMR/workspace lock；`tower_roster`
  增加 `stale`。工具总数最多 28（含 doctor/test/batch/resource/import/legacy_map 与可选的 control/reload）。
- **离线套件**：测试增至 206 项（含 2.1 discovery/batch/leases/legacy/doctor/UI/plan-mode/integration 用例）。
- 除 `tower_status` 默认分页与 `mode.denyTools` 默认扩充外，既有工具参数与输出保持兼容。

### 修复

- **模式工具 schema 与返回值不一致**：`tower_mode`/`tower_control` 的 `lastChange`、`pausedGoal`、
  `goalNote` 在正常路径返回 `null`，原 schema 会触发 DSH 强制输出校验失败；已改为可空并补回归测试。
- **错误码分类补全**：state 校验失败统一归为 `state-corrupt`；`tower_complete` 的未完成任务、
  blocker、无提交、未读消息等前置条件归为 `invalid-transition`，不再落到 `tool-internal`。
- **findings 更新后的计数**：状态流转后返回的 `counts` 之前是旧值，现在按变更后重新统计。
- **findings 只读路径**：列表/读取不再获取写锁，与工具描述一致，长合并或 hook 期间也能读取。
- **mission id 规范化**：`tower_mission` 对首尾空白的 `id` 先 trim 再查找，不再误报
  `mission-not-found`。
- **角色绕过**：worker 之前可经 `tower_mission` 直接 completed/abandoned/扩界或清 blocker，
  绕过 `tower_complete` 的未读/提交证据；现由服务端角色强制。
- **并发与接管**：同一 mission 不再允许出现第二个 live worker；stale/interrupted/failed 的
  worker 可显式 takeover，running worker 必须先中断，否则 `takeover-refused`。

## 1.3.0 — 2026-10-18

- **独立的只读 reviewer preset**：新增 `reviewer.js` / `tower-reviewer`，去掉 `write`/`edit`/`pwsh`/
  `tower_mission`/`tower_complete`，只保留读、`tower_diff`、消息、finding、review；`tower_spawn`
  按 role 映射 preset，reviewer 必须等待 mission `completed`。`tower_review` 会记录 reviewer spawn
  时的 tip，审查期间改动分支将被拒绝（修复自审风险）。
- **新增 `tower_diff`**：只读 merge-base diff（files/commits/patch），供 reviewer 使用。
- **声明 `Config` schema**：`section`/`allowAgentControl` 兼容别名 + `mode`/`review`/`merge`/
  `worktrees`/`spawn` 分组；评审轮数、合并超时/缓冲、worktree 根、spawn preset/model 等可配置；
  `mode.storePath`/`maxEntries`/`autoPauseGoal`/`denyTools`/`sectionAppend` 生效。
- **spawn 健壮性**：preset 存在性预检、按 role 选择 preset/model、失败/空闲状态写回 roster。
- **内置 Agent Skills**：`skills/tower-worker-protocol`、`skills/tower-review`、`skills/tower-recovery`，
  通过 `dsh-tower/skills` provider 注册；worker/reviewer preset 允许 `skill`。
- **文档**：新增 `docs/`（quickstart、安装升级迁移、工具/配置/blocker 参考、架构、运维、安全、FAQ、
  示例）；README quick start 修正为“先 reviewer 后 preflight 全绿”，工具数/测试数/blocker 数修正；
  `npm run docs:check` 与 CI 校验文档与代码一致。
- `package.json` 增加 `@deepseek-ai/schemastery` 依赖、`files` 补充 reviewer/skills/docs/贡献与安全文档。
- 测试 26 项（新增 preset/skills/config 四个用例）。

## 1.2.0 — 2026-10-18

- **`tower_merge` 对“提交已落地但调用报错”的恢复**：合并命令失败/超时后检查 `HEAD`，若已是
  `[baseTip, branchTip]` 双父合并提交则视为成功并记录；失败时清理 `MERGE_HEAD` 与陈旧锁文件，
  只回滚与本 mission 相关的路径，避免 index/工作树残留。
- **区分失败类型**：真实内容冲突返回 `merge-conflict`（保留 blocked 语义）；hook/进程失败返回
  `merge-hook-failed`，附带 `timeout: true`（超时）与 `cleanup` 字段，mission 保持 `completed`
  以便重试。
- **合并超时可配置**：`tower_merge` 新增 `timeoutMs` 参数（默认 15 分钟），并把合并输出缓冲提升到
  64 MB，慢速 `pre-merge-commit` 钩子不再被 15 秒默认超时误杀。
- **自动对账已落地合并**：`tower_merge` 检测 branch/reviewed commit 已包含在 base 中时，找到对应
  merge commit（或落地 tip）并直接记录为 merged（`reconciled: true`），无需手工改 Git 历史。
- **`tower_rebase`**：branch 已包含于 base 时返回 `alreadyMerged`/`skipped` 且不再把分支
  fast-forward 到 base tip，保留已审查的 tip 供 `tower_merge` 记录。
- **状态机**：允许 `blocked → completed`；`missionSummary` 暴露 `mergedCommit`/`mergedAt`。
- 测试：22 项（新增 reconcile、rebase skip、hook 失败、hook 超时四个协议用例）。
- 修复 GitHub issues #1 / #2。

## 1.1.2 — 2026-10-18

- README 文件更名：默认 `README.md` 改为中文版，英文版移到 `README.en.md`；两边的语言切换链接、
  `package.json` 的 `files`、`CONTRIBUTING.md` 与 dsh-plugin 提交信息同步更新。
- 无运行时行为变化。

## 1.1.1 — 2026-10-18

- README（英文/中文）与 dsh-plugin 提交信息中注明：Tower 模式的灵感来自 **Kimi Code**
  （Moonshot AI）的实验性 Tower 模式；本项目是面向 DSH 的独立实现，不包含 Kimi Code 源码，
  与 Moonshot AI 无隶属关系。
- 无运行时行为变化。

## 1.1.0 — 2026-10-18

- **包名改为 `dsh-tower`**：Host 插件名、`tower-worker` preset 插件名、`cordis.patch.yml`、
  可选 UI 包（`dsh-tower-ui`）与中英文 README 全部同步改名；移除 `package.json` 的 `private` 字段。
- **`dsh-tower@1.1.0` 已发布到 npm**（首次发布审核已通过）：`dsh plugin --profile web add dsh-tower`
  即可安装并可进入 DSH 插件中心；同时保留 `github:louifinn/dsh-tower` 源码安装与本地 checkout 链接。
- 已安装 `@local/dsh-tower` 的用户需要 `remove_bundle` 后重新安装 `dsh-tower`；配置项 `id: tower`
  与 config 内容不变，运行行为无变化。

## 1.0.5 — 2026-10-18

- README 增加源码安装命令 `dsh plugin --profile web add github:louifinn/dsh-tower`，满足
  dsh-plugin.org 的收录要求（公开仓库 + `dsh-plugin` topic + README 安装命令 + 根 package.json）。
- 无运行时行为变化。

## 1.0.4 — 2026-10-18

- 版权署名统一为 **Loui Finn**：`LICENSE`、`README.md`、`README.zh.md` 与 `package.json` 的 author。
- 无运行时行为变化。

## 1.0.3 — 2026-10-18

- 开源前整理：README 改为英文主文档（中文版保留在 `README.zh.md`），补充特性、安装、安全约束、
  工作原理、排障与贡献说明；添加 CI/许可证徽章与 “powered by dsh” 徽章。
- `tests/README.md`、`ui-bundle/README.md` 改为英文并去掉与特定会话绑定的表述。
- 新增 `CONTRIBUTING.md`、`SECURITY.md`；`.gitignore` 增加 `.env`/密钥/覆盖率等防泄漏规则。
- `package.json` 补充 repository/homepage/bugs/keywords 元数据。
- 清理提交作者邮箱：历史提交改用 GitHub noreply 地址重新发布。
- 无运行时行为变化。

## 1.0.2 — 2026-10-18

- **仓库布局改为符合 DSH 插件规范**：仓库根目录即 bundle 包根目录，`package.json`（含
  `dsh.bundle.patch`）与 `cordis.patch.yml` 都在根目录；原先的 `bundle/` 子目录已移除。
- `package.json` 合并了插件包声明（name/version/exports/files/dsh）与开发脚本（`npm test`）。
- 测试与文档中的相对路径同步更新（`../bundle/...` → `../...`），README 更新为插件包说明。
- 无运行时行为变化。

## 1.0.1 — 2026-10-18

- **修复：`/tower <指令>` 会把一条没有 `role` 的消息写入会话，导致后续模型请求 422
  `messages[N]: missing field role`（会话表现为“损坏”）。** `agent.steer` 需要完整的
  `UserMessage`（`id` + `role` + `content` + `source`），不是 `{content, source}` 初始化对象；
  转发时改为本地构造完整消息（`randomUUID()` 作为 id），与 `createUserMessage()` 的形状一致。
- 新增回归测试：mock 上下文断言转发消息带 `role:"user"` 与唯一 `id`；
  隔离 Web 运行时用 `/tower 这是一条测试消息` 实测模型正常回复，会话日志中 spliced/user/message
  均带 `role`/`id`。
- 提供 `tests/live/repair-session.cjs`：可修复已被旧版本写坏的会话日志（补 `role`/`id`，
  原子写 + 备份 + 生成验证副本）。

## 1.0.0 — 2026-10-18

- `/tower` 命令支持裸调用、`on`/`off`、以及携带用户指令（`/tower on 继续`、`/tower off 继续`、`/tower 继续`）；指令与附件通过 `agent.steer` 转发。
- 新增 `allowAgentControl` 配置：开启后模型可通过 `tower_control` 自行进出模式，必须给出理由。
- 进入模式时通过 `ctx.goals.pause` 暂停活跃 goal，并在结果中提示用户自行恢复。
- 模式持久化到 `$DSH_HOME/tower-mode/modes.json`（原子写、保留 200 条）。
- 移除 P6 验收用的临时 `tower_mode_dev` 钩子。
- 新增 README、单元测试、协议 e2e 测试与 opt-in UI bundle。
- 版本从 0.1.0 提升到 1.0.0。

## 0.1.0 — 2026-10-17

- 首个可用版本：P1–P6（mission/worktree/spawn/inbox/review/merge/rebase/teardown/mode）。
