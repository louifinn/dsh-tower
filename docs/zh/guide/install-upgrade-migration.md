# 安装、升级与迁移

[English](../../guide/install-upgrade-migration.md) | **简体中文**

## 环境要求

- DSH `0.2.2-rc.5`（rc.1/rc.2 仍通过旧 spawn 契约可用）；每个版本实际验证过的 host 构建见
  [COMPATIBILITY.md](../../../COMPATIBILITY.md)
- Node.js 24.9+
- Git（本地 worktree；不需要网络访问）

## 安装

```bash
dsh plugin --profile web add dsh-tower
```

或在 DSH 内执行：`plugin_manager({ action: "install_bundle", target: "dsh-tower" })`。从本地 checkout 安装：

```bash
dsh plugin --profile web add github:louifinn/dsh-tower
```

Host 插件在 DSH 启动时加载：**安装或更新后需要重启 DSH**。

## 升级

1. 阅读 [CHANGELOG.md](../../../CHANGELOG.md) 了解行为变化。
2. 更新依赖（`dsh plugin --profile web add dsh-tower@latest` 或你固定的版本）。
3. 重启 DSH；用 `tower_mode` 检查 `allowAgentControl` 是否符合预期。
4. 既有 mission state 保持兼容：1.2/1.3 的状态 schema 未变。

## 迁移说明

- **2.9.6 → 2.9.7 —— 修补版，无需迁移**：state schema 仍为 v5，配置表面未变（仍为 16 个 section、
  58 个键），宿主下限仍是 `0.2.2-rc.5`，不需要任何迁移步骤。既有 mission 记录保持有效：新的
  `deferred` 标志在设置前只是不存在。操作者配置的内容都不需要改：
  - **scope 条目必须落在跟踪文件上。** `tower_plan` 现在会在既有的目录展开之后，用 `git ls-files`
    校验每个条目。如果条目的地界内有跟踪文件、但条目本身匹配不到任何跟踪文件，则以
    `invalid-argument` 拒绝；信息会点名第一个失败条目、最近的存在前缀和至多五个候选，
    `details.problems` 逐条列出。`**`、`.`、目录形条目、当前无跟踪文件的整棵未来树以及仓库根下的
    字面量仍然合法。确实要创建新路径时显式传 `allowMissingScope: true`；它只在输入里生效（不会
    持久化），并记录一条 `scope.unverified` 活动。
  - **计划中的 mission 可以改自己的 scope。** `tower_mission({scope})` 对 `planned` mission 会替换
    围栏、把 `scopeGeneration` 加一并保持 `planned`；它不会启动 mission，也不走 widen 重叠检查。
    `active`/`completed` 仍按 widen 语义（扩大并启动）。`allowMissingScope` 逃生口现在在这里和之后
    的 widen 中都可用了，widen 被拒时也会直接指向它，而不是建议只能改计划的绕路。
  - **`deferred` 让 mission 暂时退出排序。** tower-only 的 `deferred: true` 适用于 `planned` 或
    `active` 的 build/artifact mission，把它移出 widen 重叠检查，直到 `deferred: false`；该字段
    持久化在 mission 上，并显示在 `tower_inspect` 的 mission 摘要中。计划中的 mission 还可以携带
    显式的 `pause_cause` 暂停，并在不提供授权引用的情况下回到 `planned`（只有 `→ active` 会查询
    `mode.requireResumeAuthorization`）。
  - **整仓计划会先给出警告，而不是之后才让人意外。** 新建 mission 的 scope 为 `**`，而其它拥有
    路径的 `planned`/`active` 非 deferred mission 仍在途时，plan 返回一条非阻断的 `broad-scope`
    警告，点名这些 mission id，并建议放到最后、标记 `deferred` 或暂停。该码属于稳定的 blocker
    注册表，生成参考会为每个 warning 行渲染自己的段落。
  - **`tower_send` 默认不再打断。** 普通发送只把消息送达运行中的接收者，不结束它的回合；
    `interrupt: true` 仍为 tower-only，并记录 roster interrupt。`wake: true` 用于让已停止的 agent
    启动新回合：消息先持久化，目标无法恢复时返回新的 `agent-not-resumable` 错误并带下一步；activity
    目录读不出来时绝不会被报告成唤醒。每个结果都带
    `{target, pushed, interrupted, woke, reason}`。
  - **没有迁移步骤。** state schema 仍为 v5，配置仍为 16 个 section、58 个键，宿主下限保持
    `0.2.2-rc.5` 不变。更新插件并**重启 DSH**；刷新或重启 DSH 界面以加载客户端 bundle。

- **2.9.5 → 2.9.6 —— 修补版，无需迁移**：state schema 仍为 v5，配置表面未变（仍为 16 个 section、
  58 个键），也不需要任何迁移步骤。操作者配置的内容都不需要改：
  - **宿主下限提升到 DSH `0.2.2-rc.5`。** 请先把 DSH 更新到 `0.2.2-rc.5` 或更新版本，再更新 Tower；
    rc.1/rc.2 仍通过旧 spawn 契约可用，但公开下限与实测构建是 rc.5。`npm run support:check` 会让
    package engines、mount pin、live CI 矩阵与最新兼容性行保持一致。
  - **teardown 更不容易被瞬时错误卡住。** 删除 mission 工作树时对 `EPERM`/`EBUSY`/`EACCES` 最多重试
    三次，并在结果里报告实际尝试次数，而不是第一次失败就报错。`tower_teardown` 的 `dry_run` 还会
    预览哪些到期 mission 会被归档；`exclude` 中未匹配任何 mission 的 id 会作为 `keep` 决定返回，
    不再被静默忽略。
  - **等待 teardown 的状态可见了。** doctor 视图会报告还有多少个终态 mission 的工作树在等待
    teardown；它不会自动删除任何东西，也没有新增配置键。
  - **孤立工作树清理是显式可选的。** `tower_teardown({orphans:true})` 会清理由 mission、沙箱或审查
    记录都未引用的干净 checkout；脏 checkout 保留，主检出与所有已记录路径受保护，dry run 只预览。
    普通 teardown 不会碰它们。`create_worktree` 在 Tower 模式中仍然可用，未被记录的外部 checkout
    现在会出现在 doctor 视图里，而不是无声存在。
  - **新增 doctor 建议页与拒绝清单页。** `worktrees-orphans` 与 `foreign-capabilities` 列出 Tower
    看得见但并不拥有的东西，并给出记录在案的立场和处理方式；新的「被拒绝的能力与替代」页面逐条
    记录每个被拒绝或仅警告的能力的代价与替代。没有设置发生变化。
  - **原生界面 chrome。** 工具卡片重新获得原生的文件链接、图片预览、inspect 入口与展开/收起（用
    滚动区取代六行截断）；Tower 浮层改用原生 toast 的位置与 token，composer chip 与原生
    `StatsPills` 共用基座。客户端 bundle 在 DSH 启动时加载，所以更新后请**刷新或重启 DSH** 以加载
    新 bundle。
  - **没有新配置键，也没有新状态字段。** state schema 仍为 v5，配置仍为 16 个 section、58 个键。
    更新插件并**重启 DSH**。

- **2.9.4 → 2.9.5 —— 修补版，无需迁移**：配置表面未变（仍为 16 个 section、58 个键），state schema 仍为
  v5，DSH 下限仍是 `0.2.2-rc.3`。操作者配置的任何内容都不需要迁移：
  - **撕裂的 workspace 锁可以从工具路径修复。** 会话被强行终止时可能留下写了一半的
    `<git-common-dir>/dsh-tower/tower.lock`。这条无法解析的记录此前会让所有 Tower 工具——包括
    `tower_recover`——都以 `[tower:workspace-busy]` 拒绝，会话无法自救。可解析记录的行为保持完全
    不变；`tower_recover` 现在不再被 workspace 门禁挡住，`status` 会报告 `workspaceLock` 记录
    （路径、字节数、mtime、持有者以及撕裂/不可读状态），新增的 `action: "clear-workspace-lock"`
    需要 `confirm: "CLEAR_WORKSPACE_LOCK"`，并把记录改名为 `tower.lock.recovered-<timestamp>`——
    绝不删除。
  - **撕裂记录必须满 30 秒。** 下一次获取只有在空、纯空白或无法解析记录的 mtime 超过 30 秒宽限期后
    才会自动回收，并重试一次独占创建；更新鲜的记录仍然拒绝。
  - **拒绝信息会指出文件。** `workspace-busy` 信息现在包含锁文件路径、字节数与 mtime，便于区分
    陈旧记录与另一个活跃会话。
  - **没有新配置键，也无需迁移。** schema 仍为 v5，配置键仍为 58，确认串属于领域词汇而不是开关。
    更新插件并**重启 DSH**。

- **2.9.3 → 2.9.4 —— 修补版，无需迁移**：配置表面未变（仍为 16 个 section、58 个键），state schema 仍为
  v5。操作者配置的任何内容都不需要迁移：
  - **纯客户端界面变更。** 没有工具 schema、输出或 wire format 改动，也没有新增配置键或状态字段，随包的
    九个 `dsh-tower-ui` chunk 不变。Tower 工具卡片收起时改用宿主自己的进程行，展开时使用宿主通用的
    io-card 表面；Tower 模式拦截行同样是原生行，显示本地化工具名与「Tower 模式中不可用」，解释（原因 /
    下一步）移入展开体，不再手绘卡片。宿主原始的英文拒绝句不再是可见文案。
  - **重启或刷新 DSH 后生效。** Host 插件没有变化，但 Web 客户端持有已加载的 bundle：重启 DSH（或刷新
    页面）以拾取新的客户端 chunk。
  - 无需迁移 state 或配置。更新插件并**重启 DSH**。

- **2.9.2 → 2.9.3 —— 修补版，无需迁移**：配置表面未变（仍为 16 个 section、58 个键），state schema 仍为
  v5。操作者配置的任何内容都不需要迁移：
  - **界面、工具与 wire format 均未变。** 客户端体积预算现在只对客户端**逻辑**求和，中英翻译目录
    单独计量，并由自己的数据守卫约束（en/zh 键集一致、133 键下限与 260 键上限、值不超过 240 字符、
    目录内不出现可执行代码）。随包的九个 chunk 不变，加载器未动，所有工具 schema 与输出也未变；这是
    记入 ADR 0011 的内部预算决定。
  - **Windows 测试不再受负载影响。** 独占创建锁记录只在 1.5 秒预算内重试 `EPERM`/`EBUSY`/`EACCES`
    这三个瞬时共享错误（`EEXIST` 仍然永不重试）；心跳与合并用例改为等待可观察状态，不再押注固定
    墙上时钟。机器再慢，也不会把没碰过的测试文件判红。
  - **开发者多了可选的有界运行入口。** `npm run test:shards` 把 `tests/*.test.mjs` 按 25 个文件一批
    顺序执行（更忙的主机可用 `npm run test:shards -- --size 10`）。这是受限机器上的本地便利，不是
    新要求：CI 仍运行 `npm run check`，其中包含 `npm test`。
  - 无需迁移 state 或配置。更新插件并**重启 DSH**。

- **2.9.1 → 2.9.2 —— 修补版，无需迁移**：配置表面未变（仍为 16 个 section、58 个键），state schema 仍为
  v5。操作者能观察到的变化：
  - **计划 scope 覆盖其子树。** `tower_plan`（以及 `tower_mission` 的 scope 放宽）中的裸目录条目，或带
    尾分隔符的条目，现在展开为子树：`docs/guide/` 存成 `docs/guide/**`，`.` 展开为整棵树（`**`）。
    glob、文件与未知路径保持字面写法；已存在任务线上的 scope 永远不会被重写。
  - **执行代理的停滞判定改为持续证据。** `spawn.staleMs` 默认值现在为 30000，随包补丁也设为同一
    30 秒窗口。看门狗只有在“连续 2 次缺失、跨 2× 窗口”后才记为缺席，空的或无法读取的父 catalog 不构成
    证据。执行代理自己的 `tower_complete` 到达宿主时，会在完成任务的事务内复活自己的行并记为
    `completed (self-report)`；其他终态仍然拒绝。
  - **`tower_init({op: "adopt"})` 不会因空 catalog 而退休。** 只有非空的 `listDescendants` 回答才是缺席
    证据；空回答或失败父会话下的行会进入新的 `unjudged` 列表并附 `parentStatus` 原因，观测计数保持
    不变。`retire_missing` 在权威 catalog 下保持原义。
  - **`tower_recover` 也恢复提交互斥。** `status` 与 `clear-stale-lock` 同时检查 `state.commit.lock` 与
    状态锁，返回 `commitBackup`；记录在读取后变化时拒绝移动；`force` 会先清提交互斥再移动状态锁。
    不可读记录报告为 `{unreadable: true, path, error}` 并重命名到备份，绝不删除。
  - **宿主版本来源有明确的信任顺序。** 先是非空的 `DSH_VERSION`、`DSH_HOST_VERSION` 与
    `npm_config_dsh_version`；然后是 `DSH_INSTALL_DIR` 及其父目录、对应 `app.asar.unpacked` 副本中
    首个可读的 `package.json`；接着是已挂载的服务；最后才是 profile 安装的依赖，作为明确标注的非权威
    提示。父目录的包不再能顶替 `DSH_INSTALL_DIR` 指定的包；profile 命中永远只给警告，不会判 pass。
  - **发布类型面现在被真实检查。** `types:check` 增加 `types:check:declarations`，以
    `skipLibCheck: false` 检查 `types/index.d.ts` 本身。`TowerConfig` 现在解析为真实配置类型而不再是
    `any`，因此使用方可能看到更严格、但正确的类型。
  - 无需迁移 state 或配置。更新插件并**重启 DSH**。

- **2.9.0 → 2.9.1 —— 修补版，无需迁移**：配置表面未变（仍为 16 个 section、58 个键），state schema 仍为
  v5；唯一的状态形状变化是派工预留时名册行上的可选 `reservationId`，2.9.0 读取时会忽略，因此回退是安全
  的。调用工具时能观察到的变化：
  - `tower_spawn` 输出：`worktree` 仍为必填，但现在允许 `null`。survey 派工不建分支工作树，因此报告
    `null`，而不是在 worker 其实已经启动之后被判成输出校验失败；分支工作树仍为
    `{path, branch, baseCommit}`。
  - `tower_teardown` / `tower_inspect` 的 `doctor` 视图：终态任务的工作树若被 Tower 之外删除，不再是一条
    无法清除的记录。`tower_teardown` 会补写 `worktreeRemovedAt` 并返回 `repaired: true`，原因为
    `worktree directory was already gone; the removal was recorded`；doctor 把这类情况在 `worktrees`
    检查里降为 advisory warn（活跃任务的工作树缺失仍 fail、脏工作树仍 warn），并统计已记录的移除数。
  - 宿主版本：桌面构建现在可从 `DSH_INSTALL_DIR`（或其父目录）下的 `package.json` 识别，0.2.2-rc.3 无需
    手工设置版本环境变量即可报告为已验证；所有来源都无答案时，详情会列出探测过的每个来源。
  - Windows 行尾：Git 写类命令带 `core.autocrlf=false` 运行，用户级 `core.autocrlf=true` 不再让 Tower
    自己的检出看起来像越界改动；`status`/`diff` 等读类命令仍沿用环境设置。
  - 派工失败：卡住的 `reserved` 名册行（`agentId: null`）在 60 秒宽限后分两阶段收割；每份预留带自己的
    `reservationId`，陈旧清理不会收走别的派工正在用的行。若一次性 review checkout 无法删除，该行会保留：
    spawn 预检以带路径与处置建议的错误报出，`tower_init({op:"adopt"})` 则在 `unreaped` 列表里给出。
  - 配置键没有变化。更新插件并重启 DSH，其余无需迁移。

<!-- tower-retired-names:begin 2.9.0-migration -->
- **2.8.0 → 2.9.0（#163、#176、#160、#164、#162、#159、#161）—— 工具表面收敛**：构建表面从 29 个工具
  降到 21 个（默认 profile 注册 16 个）。五个只读工具（`tower_status`、`tower_roster`、`tower_diff`、
  `tower_preflight`、`tower_doctor`）现在是 `tower_inspect` 的 `status`、`roster`、`diff`、`preflight`
  与 `doctor` 视图；`tower_control`、`tower_adopt`、`tower_findings`、`tower_import_legacy` 与
  `tower_legacy_map` 分别并入 `tower_mode`、`tower_init({op:"adopt"})`、`tower_finding`、
  `tower_import({op:"snapshot"})` 与 `tower_import({op:"map"})`。写入 `mode.denyTools` 的旧名仍会被
  接受并改写为替代项，直接调用则返回可操作的 unknown-tool 错误。塔会话现在按角色与阶段暴露工具
  （模式关闭仅 `tower_mode`；空闲时加上 `tower_init`；活跃时为 14 个默认准入工具），
  worker/reviewer/survey preset 各有 allow-list，`tower_complete`/`tower_review` 不再向塔会话广告。
  `/tasks` 新增只读 roster 面板。Tower 与活跃 Ralph 循环按仓库互斥：Tower 模式期间 `/ralph` 被遮蔽，
  Ralph round agent 被拒绝，`mode.ralphPolicy`（默认 `stop`，或 `refuse`）决定进入时是停止并记录循环
  还是给出原因拒绝。第三种 mission 形状 `artifact` 用人类接受替代审查，并经 DSH 审批通道记录。state
  schema 保持 v5，配置表面从 57 增至 58 个键、16 个 section，错误目录增至 42 个（35 个阻塞码）。
<!-- tower-retired-names:end 2.9.0-migration -->

- **2.8.0 → 2.9.0 —— DSH 0.2.2-rc.3 主机契约**：rc.3 移除了 `subagents.list()` 并把
  `startActivation` 改为扁平字段，2.8.0 在升级后的 host 上无法 spawn（`subagents.list is not a
  function`；旧嵌套 request 还会让 `spec.parent` 为 undefined）。2.9.0 在 `app/host-contract.js`
  运行时探测契约：rc.1/rc.2 保留嵌套 request，rc.3 收到带存活 parent agent、prompt 数组与调用方
  signal 的扁平 spec。provider 解析依次尝试 `spawn.provider`、`getProvider("spawn")`、旧 `list()`，
  否则以点名 `spawn.provider` 的可操作消息失败。无需 state 或配置迁移；更新插件并**重启 DSH**。
  rc.3 为实际验证的构建。
- **2.7.1 → 2.8.0（#M71）—— 支持基线提升到 Node.js 24.9+ 与 DSH 0.2.2-rc.1**：DSH 0.2.2-rc.1
  声明 `engines.node >=24.9.0`，因此 Tower 在 package engines 与 package-lock 根节点发布同一条基线。
  `scripts/support.json` 是唯一的清单：mount-smoke host pin、live CI 矩阵与 COMPATIBILITY 最新行
  必须与它一致，任何不一致都会让 `npm run support:check`（属于 `npm run check`）失败。没有 state
  或配置迁移；安装 2.8.0 前把 Node 升级到 24.9+，升级后重启 DSH。
- **2.7.0 → 2.8.0（#M66）—— 移除 `review.requireReview`**：2.6.0 引入的、保留一个版本的布尔别名已彻底移除。
  `review.mode`（`off`、`optional` 或 `required`）是唯一的审查策略键；仍在 profile 或仓库配置中写入
  `review.requireReview` 的配置会以 `config-unknown-key` 被拒绝，错误带日期注记，点名 `review.mode`
  并给出映射（`true` → `required`，`false` → `optional`）作为升级办法。三种模式的解析与之前完全一致，
  因此不需要迁移 state 或审查策略；配置键数量从 56 降到 55。从插件页保存只写入 `review.mode`；
  doctor 现在报告从未固定 `review.mode` 的 profile，而不再归一化别名。
- **2.5.0 → 2.6.0（#M39/#M40）—— 审查模式取代布尔开关**：审查策略是插件页 `dsh-tower` 配置区里的
  一个三态控件，配置键为 `review.mode`：`off`、`optional`（默认）或 `required`。
  - `off` 是受支持且有文档的模式：不注册 `tower_review`，拒绝 reviewer spawn，合并门禁忽略审查。
  - `optional` 保留 `tower_review`，但从不阻塞合并。
  - `required` 保留合并门禁：已完成 mission 必须有绑定分支 tip 的 clean 审查（原有的单 mission
    豁免仍适用）。
  `review.requireReview` 是已弃用、保留一个版本的别名：`true` 解析为 `required`，`false` 解析为
  `optional`，不设置则为 `optional`。`true` 与非 `required` 的显式 mode 同时出现会以 `config-invalid`
  拒绝；`false` 不会覆盖显式 mode。从插件页保存时总是写入 `review.mode`，并把别名归一化为 `false`。
  该策略不是组件行，也不存在互斥的审查行：`preset-tower-reviewer` 仍是策略可以不使用的可选能力。
  `review.mode` 为 `off` 或 `optional` 时该行可以关闭；当 `review.mode` 为 `required` 且该 reviewer
  行关闭时，规划与模式进入会以带解释的 `preset-missing` 错误拒绝该组合。
  以 `off` 启动的 profile 从未注册 `tower_review`；切换到 `optional` 或 `required` 会立即改变合并门禁，
  但工具本身要等 DSH 重启（或 profile 重载）后才出现，插件页在保存后会说明这一点。
  升级方式：把 `review.requireReview: true|false` 替换为 `review.mode: required|optional`。该别名只保留
  一个版本，已在 2.8.0 中移除（见 2.7.0 → 2.8.0 条目）；继续保留它的配置会被拒绝，而不是被静默解析。
  不需要迁移 state。

- **state schema v1 → v2（未发布）**：`state.json` 会自动迁移。升级后的第一次**写入**会保留
  `state.json.v1.bak` 备份、`revision` 只 +1，并向 `activity.jsonl` 追加 `state.migrated {from,to}`；
  只读工具仍可读取 v1 文件且不改写它。`tower_inspect` 的 `view: "doctor"` 视图 报告磁盘上的版本与待执行的迁移。由更新插件
  写入的文件会以 `[tower:state-version-unsupported]` 拒绝，绝不会被重写或降级；迁移抛错会报
  `[tower:state-migration-failed]`，原文件保持字节不变。
- **state schema v2 → v3（未发布，#90）**：scope 匹配跟随检出目录所在文件系统的行为。迁移把
  `caseInsensitive` 回填为 `null`（“尚未探测”）；迁移不会读取文件系统，因此升级后的第一次
  `tower_init` 会探测一次并记录 `true`/`false`。在此之前使用安全的 `case-sensitive` 比较，
  `tower_inspect` 的 `view: "doctor"` 视图 会把未知模式报告为 `warn`（`case-mode`）。在大小写不敏感的检出上，
  `src/Api/**` 与 `src/api/**` 从此视为重叠，仅大小写不同的改动不再被 out-of-scope 门禁拒绝。
  存储的 scope 文本永远不会被改写：看板仍显示操作者输入的原样。
- **2.3.0 → 2.4.0（未发布）**：所有能力合一的 `tower-bundle` 组行已移除。`cordis.patch.yml`
  现在随包提供强制的 `tower` host 锚点（Host 插件与 worker preset 是它的内部 section），以及可单独
  开关的顶层行：`tower-skills`、`tower-batch`、`tower-import`、`tower-leases`、`tower-tests`、
  `tower-hmr`（随包关闭）与 `preset-tower-reviewer`（受审查策略 `review.mode` 条件约束）。
  `tools` 配置组与 `dev.hotReload` 已删除：仍带这些键的 profile 现在会作为未知键被拒绝
  （`config-unknown-key`），在删除它们之前 host 不会挂载，因此不再存在静默无效的开关。请改为在插件页
  使用对应的组件行；`tower-hmr` 随包关闭，因此在为联动开发 profile 开启它之前，`tower_reload` 与
  `/tower reload` 会报告为 “disabled by component tower-hmr”。`tower_inspect` 的 `view: "doctor"` 视图 与 `tower_recover`
  在任何配置下都会注册，无需配置键。策略为 `off` 或 `optional` 时 reviewer 行可以关闭；策略为
  `review.mode:required` 时，规划与模式进入会以带解释的错误拒绝该组合。不需要迁移 state。
- **2.0.4 → 2.1.0-beta.1**：不需要迁移 config；state 会按上述说明自动迁移（v1/v2 → v3）。
  这是发布到 `next` dist-tag 的**预发布**，
  `latest` 仍指向 2.0.4——请用 `dsh plugin --profile web add dsh-tower@next`（或精确版本号）安装。
  运行时行为未变；本版本承载的是交付闸门（CI 中的 mount smoke、`npm run release:check`、证据约定
  与追踪策略），而不是工具变化。本文档先于人工发布步骤合入：只有在[发布清单（英文）](../../guide/release.md)执行
  `npm publish --tag next` 之后，`next` 才会解析到 2.1.0-beta.1；`latest` 在稳定版发布前保持 2.0.4。
- **2.0.3 → 2.0.4**：不需要迁移 state/config。本版本是安全加固与完整性修复（授权、merge SHA 绑定、
  dirty worktree 完成拒绝、stale lock 恢复、限制 test/git 进程环境、`tower_recover`、UI 0.2.2）。
  升级后请按威胁模型重新检查审查策略（`review.mode`；已弃用的 `review.requireReview` 别名已在 2.8.0 中移除）、
  `tests.admission` 与 worker 工具权限。
- **2.0.1 → 2.0.3**：不需要迁移状态。2.0.3 起独立审查**默认可选**（即今天的
  `review.mode:optional`）；若要保留旧的审查门禁行为，请显式设为 `review.mode:required`。
  2.0.1 为 `tower_batch` 增加 `abandon`、允许 merged
  成员 close、让 doctor 跳过已 teardown 的 worktree，并修复终态 mission spawn/preflight 边界。
  可选 `ui-bundle` 0.2.1 增加常驻 Tower 模式 chip 与模式感知的 disabled 工具行。
- **1.x → 2.0（已发布）**：不需要迁移状态（`schemaVersion` 保持 1；新字段都是可选的）。需要留意的
  行为变化：Tower 模式激活期间，`mode.denyTools` 现在还会拒绝 `workflow`、`ralph`、`subagent`、
  `subagent_fork`、`wait_agent` 与 `team_task_list`（可用显式列表覆盖）；`spawn.maxLiveWorkers`
  默认为 4；`mode.workspaceLock` 代码默认关闭、随包 patch 开启。worker 不能再直接完成/放弃/扩大
  mission 的 scope——请使用 `tower_complete`。新工具：`tower_interrupt`，以及 HMR 可用时的
  `tower_reload`。升级后重启一次 DSH；见[热重载](hot-reload.md)。
- **1.3 → 1.4**：不需要迁移状态。新增：仓库级配置（`<git-common-dir>/dsh-tower/config.json`）、
  稳定的 `[tower:<code>]` 工具错误、findings 台账（现为 `tower_finding`），以及 `id`/`missionId`
  与 snake/camel 输入别名。既有调用保持可用；重启 DSH 以加载新工具面（findings 台账与更新的
  output schema）。
- **1.2 → 1.3**：reviewer 从共享的 `tower-worker` preset 迁移到新的只读 `tower-reviewer` preset。
  重新安装/重启，确保两个 preset 行都存在。`tower_spawn role=reviewer` 现在要求 mission 为
  `completed`。
- **1.1 → 1.2**：合并失败新增 `merge-hook-failed`、`cleanup` 与对账行为；不需要迁移状态。
- **1.0 → 1.1**：包名从 `@local/dsh-tower` 改为 `dsh-tower`。先移除旧 bundle
  （`remove_bundle` 目标 `@local/dsh-tower`），再安装 `dsh-tower`。

## 卸载

```text
plugin_manager({ action: "remove_bundle", target: "dsh-tower" })
```

重启 DSH。`<git-common-dir>/dsh-tower/` 下的 mission state 与
`<主检出父目录>/.dsh-tower-worktrees/` 下的 worktree 会保留；确认没有活跃 mission 后再手工清理。
