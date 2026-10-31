# Changelog

> 自 2.0.0 起，每个版本按 **新增 / 变更 / 修复** 三类组织；更早的版本保留原始流水式记录。

## 未发布（Unreleased）

## 2.5.0（2026-11-01）

### 新增

- **#133 追踪看板成为可选能力**：新增 `tower-board` 组件行，关闭后不再写 `MISSIONS.md`，
  `tower_status`/`tower_doctor` 说明关闭原因；`docs.boardLocation` 仍是位置调节项。
  旧的 `docs.board` 配置键被删除，写入旧键会收到带迁移说明的 `config-unknown-key`。
- **#135 归档成为可选能力**：新增 `tower-archive` 组件行，关闭后终态任务保持热存储且不自动归档，
  doctor 报告关闭后果；`archive.afterDays`/`archive.maxMissions` 仍是节奏调节项。
  旧的 `archive.enabled` 配置键被删除。
- **#134 `tower-ui` 进入组件源**：`ui-bundle/cordis.patch.yml` 的 UI 行现在被组件源、locale 覆盖与
  基线同时看到；门禁解析所有随包发布的 `cordis.patch.yml`。
- **#137 面向普通用户的双语标签与术语表**：新增 `GLOSSARY.md`（12 组中英术语 + 文案规则），
  重写全部可见组件行的标题、用途与关闭后果；不再出现原始配置键、工具 id、斜杠命令或模块说明符。

### 变更

- **#138 组件门禁改为失败关闭**：键分类、行为开关、行覆盖、随包补丁与双向计数面全部机器校验；
  双向面的每次计数决策必须带日期；`OPERATIONAL_TOOLS` 直接导入真实注册表，不再靠正则猜测。
- **#136 删除 `tests.enabled` 第二开关**：`tower-tests` 组件行是唯一开关；`tower_test` 在行关闭时
  报告 `disabled by component tower-tests` 并给出修复方式，不再误报“未配置”。
- **#132 组行关闭后果可见**：`tower` 组行的“关闭等于卸载 Tower”现在显示在 Plugins 页面的描述里，
  不再只是不可达的 locale 文本。
- **#141 HMR 明确定位为开发工具**：`tower-hmr` 保持默认关闭，文案改为“开发热重载（开发工具）”。
- 配置面 55 → 53 键；可见组件 11 个；新增 `tower-board`/`tower-archive` 行 locale 与打包清单条目。

### 修复

- **#131 租约组合提前拒绝**：`tower-leases` 关闭且 `spawn.requireLease` 非空时，配置/预检阶段直接
  拒绝并说明行与两项修复方式；`lease-busy` 只指向真实注册的工具，`tower_doctor` 交叉检查该组合。
- **#139 能力卸载不留残影**：skills provider 注册与 Tower 模式提示段都通过 `ctx.effect` 释放，
  热卸载后 `componentReport` 与真实挂载状态一致。
- **#140 禁用行原因一致**：`tests-missing` 合并阻塞项点名 `tower-tests` 行；机器输出的英文契约写入文档。
- **#142 `/tower` 预检不再误伤转发输入**：运行前置条件只在进入模式/切换时重新校验，
  转发指令与 `/tower off` 在无关行关闭时继续工作。
- **F16 作用域重叠判定补全**：`scopesOverlap` 在保留文档化近似的同时加入精确 token-NFA 交集，
  修掉 `a/b*` 与 `a/bc*` 被误判为不重叠的问题。
- **F17 配置解析一遍收敛**：`resolveTowerConfig` 现在对空输入也满足严格一遍幂等。
- **F23 术语表随包发布**：`GLOSSARY.md` 进入 `package.json` `files` 与打包清单（293 个文件）。

## 2.4.2（2026-10-24）

### 修复

- **两个 Agent 预设行在 Plugins 页面无法区分**：此前 `preset-tower-worker` 与 `preset-tower-reviewer`
  共用 `@deepseek-ai/dsh-agent-preset` 模块，页面按模块包取标签，两行都显示「Agent 预设定义」。
  现在两行分别由 Tower 自有的 import-free preset 声明模块承载（`dsh-tower/preset-worker` /
  `dsh-tower/preset-reviewer`），通过注入的 `agentPresets.register(config)` 注册，
  preset 的 id/name/description/order/plugins 保持不变；两个 specifier 各自提供生成的
  `<specifier>/locale/{en,zh}.json`，页面显示「Tower Worker 预设」「Tower Reviewer 预设」
  及各自用途与关闭影响。真实 `smoke:mount` 在 pinned host 上确认 2 个 preset 均挂载且标签不同。
## 2.4.1（2026-10-24）

### 修复

- **可选组件行在 Plugins 页面只显示模块名**：每个可选能力导出现在提供
  `<specifier>/locale/{en,zh}.json`（`meta.title` / `meta.description`），由
  `locale/<lang>.json` 的 `components` 块经 `npm run docs:generate:locale` 生成，并由
  `docs:check:generated:locale` + CI 步骤防漂移；描述同时说明能力用途与关闭后移除的内容，
  开关无需离开页面即可判断。

## 2.4.0（2026-10-24）

### 新增

- **#121 可选能力回到组件**：一个 `tower-bundle` 组拆成强制 `tower` 宿主 + 可独立开关的顶层行
  （`tower-skills`/`tower-batch`/`tower-import`/`tower-leases`/`tower-tests`/`tower-hmr` 默认关/
  `preset-tower-reviewer` 依 `review.requireReview` 条件存在）；新增 `./batch`/`./import`/`./leases`/
  `./tests`/`./hmr` 导出，每个入口只注册自己的能力；8 个可见组件的 title/summary/disables 双语覆盖；
  任一可选行关闭后 Tower 仍可用（模式、规划、状态、其余工具），缺失能力在 status/doctor 中以
  “disabled by component <id>” 呈现。
- **#120 组件面政策载体**：`PRINCIPLES.md` 第 11 条（“optional capabilities are switches; the core is not”）、
  ADR 0005、64 键的组件轴分类（core / optional-component / optional-config / forbidden-to-disable，由
  `scripts/component-surface.json` 单一来源生成）、`check-components`（locale 覆盖、forbidden-to-disable
  denylist、组件计数 baseline）与 `components` 基线；组件面 4→1→8 的变化以带日期的 decision 记录。
- **#115 类型面完整性**：`types:coverage` 从 `package.json files` 与 `tsc --listFiles` 派生检查程序
  （146/146 运行时 .js 全覆盖，旧配置下可复现 19 个漏检）；tsconfig 改为 glob；`types:generate` 从运行时常量
  生成发布词汇（ErrorCode/状态/角色等）并纳入 `--check`，修掉 8 个幽灵码与 4 个缺失码；
  `tsconfig.strict.json`（noImplicitAny）以显式文件清单起步，manifest 禁止清单收缩。
- **#118 surface 计数覆盖完整工具面**：`tower_doctor`/生成参考/`docs:check`/`surface:check` 统一为
  29 个工具面（默认装配 28，tower-hmr 关闭时少 `tower_reload`），直接注册的 `tower_mode`/`tower_control`
  也进入刹车；baseline 以 correction 记录 27→29。

### 变更

- **#122 安全网永不可关**：`tower_doctor`/`tower_recover` 在任何配置下都注册；删除
  `tools.exposeDoctor`/`exposeRecovery`/`exposeOperational` 与整个 `tools` 组、`dev.hotReload`；
  旧配置作为未知键被拒绝并停止挂载（升级指南 en/zh 已记录迁移）。
- 配置面从 64 键/15 节收缩为 56 键/14 节；生成的 config/tools/component-surface 参考同步更新。

### 修复

- **F11/F9**：`operationalRegistry` 解析容忍 trailing comma 与 `OPERATIONAL_TOOLS.set` 路由；
  根 README 的工具计数标题修正为 29（20 core + 9 optional）并注明默认装配 28。
- 真实 `smoke:mount` 在 pinned host `0.2.1-rc.2` 上通过（默认 28/28），required `mount` CI 上下文保持绿。
## 2.3.0（2026-10-23）

### 新增

- **#87 live harness 可复现**：`tests/live/package.json` 固定 `playwright`（含独立 lockfile），
  根脚本 `npm run test:live` 解析本地/`NODE_PATH` 并在缺失时打印两条确切安装命令后退出 2（无堆栈）；
  七个 live 脚本统一走该解析器；`--check` 模式无需浏览器即可在 clean clone 上通过；
  `tests/README.md` 以可复现路径为默认、全局安装作为 fallback。
- **#47 live 套件安全门禁 + nightly**：live 入口强制 `DSH_LIVE=1` 且 `DSH_HOME` 必须是 `os.tmpdir()` 的严格子目录，
  拒绝真实 home 及其 `profiles/*`（错误信息指向 `npm run test:live`）；CI 的浏览器 live job 移出 push/PR，
  改为 nightly `schedule`/`workflow_dispatch` 且主机版本固定在 `0.2.1-rc.2`；输出首行打印解析后的
  `DSH_HOME` 与 host 版本。
- **#83 工程哲学**：根目录 `PRINCIPLES.md`（10 条原则，每条带明确的 refusal 与可解析的 enforcement pointer）、
  `docs/adr/` 四份带日期的 ADR（ports-as-data、单一 state.json、allowAgentControl 默认、surface budget，
  均含 rejected alternatives）、`docs/` 非目标审计、PR 模板的 principle 问题；
  `scripts/check-philosophy.mjs` + `npm run docs:check:philosophy` 在 pointer 失效时失败。
- **#84 概念预算**：`tower_doctor` 打印 `config keys: 64 · sections: 15 · tools: 27 (baseline 2026-10-23)`；
  生成的 config/tools 参考头部携带同一计数与日期；`scripts/surface-baseline.json` + `npm run surface:check`
  在 surface 增长而无 ADR/等量删除时失败（fixture 覆盖）；64 个 config key 的 core/tuning/niche 分类
  （含 3 条 niche removal note）与 27 个工具的 core/optional 分类。
- **#85 事故实践**：`docs/operations/incident.md` 六字段模板（Symptom/Introduced in/Blast radius/Root cause/
  Regression test/Released in），从 CONTRIBUTING 与 SECURITY 链接；`regression` label 语义固定为
  “worked in a released version, then stopped”；`scripts/regression-audit.mjs` 离线审计已关闭 regression issue
  的 `Regression test:` 路径；#68 已按模板回填并通过审计。

### 修复

- 发布前 CI flake：lock 心跳测试改为轮询等待一次 tick，避免高负载 Node 24 下固定 60ms 窗口偶发失败。
## 2.2.0（2026-10-23）

### 新增

- **#74 恢复动作到达模型**：`ERROR_CODES` 统一为 35 条目录（description/trigger/retryable/nextAction）；
  `renderErrorMessage()` 在消息尾部追加恰好一个 `— next: …` 片段，retryable 条目附加 `(retryable)`；
  无 nextAction 的条目保持字节不变；`TowerToolError`/`classifyError()` 均从目录解析字段；
  `errors.generated.md` 与 errors.md 的 Code/Retryable/Next action 表由同一目录生成。
- **#75 领域事件**：域转换返回 `{ state, events }`；app 持久化后发出稳定事件
  `tower.mission.planned|completed|reviewed|merged|abandoned`（携带 missionId/revision/at，merged 另有 commit），
  `tower/<tool>` 作为弃用别名保留一个 minor；`ports/events.js` 新增 `EventPort`（no-op 默认，Cordis `ctx.emit` 绑定）；
  `docs/reference/events.md` 由事件表生成并纳入 `--check`。
- **#71 ui-bundle 纳入 fitness gate**：`client-no-node`/`client-size`/`client-ambient` 三条阻塞规则；
  `client.js` 从 1,980 行拆为 entry + 9 个按渲染面切分的 chunk（每个 ≤400 行，总行数 +9.95%）；
  `domain:metrics` 打印 ui-bundle 行；`pack:check` 额外要求 ui-bundle/package.json 与 cordis.patch.yml。

### 变更

- **#69 app 依赖 ports 而非 adapters**：9 个运行时 Port 契约 + `assertPorts`；组合根一次性构造 adapter 并注入；
  `app-ports-only`/`composition-root`/`port-shape` 三条 fitness 规则；内存 adapter 全生命周期测试。
- **#70 退役 lib/**：23 个文件 `git mv` 到 adapters/host/app；新增 `no-lib-from-core`、`host-scope` 阻塞规则；
  ambient 豁免降为 2 条 I/O 边界；`lib/` 不再存在。
- **#80 fitness 豁免有据**：硬编码 allow-list 改为 `scripts/architecture-waivers.json` 中带 reason/owner/ref 的豁免；
  新增阻塞 `waiver-contract`，无理由豁免/未知规则/ambient 无 match/domain 豁免一律失败；statement-aware ambient 扫描。

### 修复

- **发布前 hygiene（F2–F5）**：根级 `*.log` 忽略规则；控制流 `)` 后正则的 scanner 加固；
  `tsconfig` 移除已删除 lib 路径；COMPATIBILITY/ui-bundle 文档中的旧 lib 路径更新。
## 2.1.2（2026-10-23）

### 修复

- **#107 survey 依赖满足门禁**：`dependencySatisfied()` 让 `merged`/`abandoned` 继续满足任意类型依赖，
  并额外接受 `kind === 'survey' && status === 'completed'`（survey 的终态成功，没有可合并分支）；
  `dependencyBlockers()` 对活跃 state 与归档索引一视同仁，因此归档的已完成 survey 也满足依赖。
  build→build 仍要求 `merged`，不为 survey 发明新状态。
- **#108 多路 review 同 tip 记录**：`reviewAdmission()` 允许 `active` mission 的后续 route 在同一
  reviewed tip 上追加 verdict，并入同一 round（`appended:true`），不再次翻转状态；tip 已移动时以
  明确说明拒绝。`app/review.js` 与输出 schema 同步。

### 变更

- **Tower 交付流程**：2.1.2 的 #107/#108 由 Tower mission M2 实施（worker → reviewer clean R2 →
  preflight → merge）；review 后按文档化路径扩了 mission scope 以覆盖根文档，`tower_review` 契约
  描述更新为「completed 起新 round / active 可追加同 tip route」。
## 2.1.1（2026-10-23）

### 修复

- **#92 PID 复用导致 state 锁永久不可恢复**：持有 state/git 锁期间，记录中的 `at` 现在按固定间隔
  心跳重写（默认 1000 ms，`unref` 定时器，释放时清除且任何写失败都不会抛给调用方）。回收条件
  从"PID 已死"改为"`ESRCH` 立即回收，或心跳静默超过 3 × 间隔（默认 3 s）且改名后字节校验通过"，
  因此即使 PID 被无关进程复用也能安全回收，且仍在默认 5 s 的 state 锁等待预算内。修复前
  `tower_recover clear-stale-lock` 会拒绝 PID 仍存活的锁；新增 `force: true`（仍需
  `confirm:"CLEAR_STALE_LOCK"`）可清理"PID 存活但心跳静默"的锁，输出
  `{pid, startedAt, ageMs, heartbeatAgeMs}` 并始终改名为 `.recovered-<ts>` 备份、绝不 unlink。
  自动回收一个"PID 存活但心跳过期"的记录时保留 `state.lock.reclaimed-<ts>-<id>` 审计备份；
  `ESRCH` 快速路径行为不变。`tower_doctor` 新增 `stateLock` 报告（`ageMs`、`heartbeatAgeMs`、
  `staleAfterMs`、`stale`），锁记录新增 `since`（记录写入时间；旧记录回退到 `at`）。
  改名 → 校验字节 → 再处置的顺序保持不变，回收中途被替换的记录会被还原而不会丢失。

- **#93 git mutex 等待按合并超时预算**：持有 git 锁的一方记录 `{kind:'git', phase}`，并让
  `tower_init`/`tower_teardown`/`tower_rebase`/`tower_spawn` 按 `merge.timeoutMs`
  （默认 900000）+ 60 s 边距等待，慢 pre-merge hook 不再让并发操作在 60 s 失败。超时错误携带
  `{holderPid, holderPhase, heldMs, waitedMs}`（消息形如 `held by pid 1234 (merge) for 92 s;
  waited 60 s`），`tower_status`/`tower_doctor` 新增 `gitLock {held,pid,phase,heldMs}` 与
  `git-lock` 检查；state 锁的 5 s 预算与 merge 超时默认值保持不变。

### 变更

- **#106 执行规范**：新增 `docs/agents/workflow.md`，把 Matt Pocock 技能流程（triage → spec →
  tickets → TDD → 两轴 code-review → retro）与 Tower 交付协议（worktree mission、scope 围栏、
  review/merge 门禁）合并为仓库唯一执行规范，`AGENTS.md` 指向它；明确 tag-only 与 published
  两种发布模式以及人工门禁（npm publish/2FA、保护分支变更）。
## 2.1.0（2026-10-23）

### 新增

- **#72 state 迁移**：`state.json` 的 `schemaVersion` 升到 3（v1→v2→v3 有序迁移链），并新增有序、纯函数式的迁移注册表
  （`domain/state/migrations.js`）。旧 state 在持有 state 锁的加载中自动迁移：先写
  `state.json.v<N>.bak` 备份，再原子替换、`revision` 只 +1、并向 activity 追加
  `state.migrated {from,to}`；只读工具只在内存中迁移，不改写文件。由更新插件写入的 state 现在
  以 `[tower:state-version-unsupported]` 拒绝（不再误报 `state-corrupt`），且绝不会被降级重写；
  迁移抛错以 `[tower:state-migration-failed]` 报出，原文件保持字节不变。`tower_doctor` 新增
  `stateSchema {currentVersion,supportedVersion,migrations,status}` 与 `state-schema` 检查。
- **#73 终态任务归档**：`merged`/`abandoned` 且 worktree 已移除的 mission 在达到可配置策略
  （`archive.enabled`/`archive.afterDays`/`archive.maxMissions`）后，于下一次变更边界移入
  `<git-common-dir>/dsh-tower/archive/index.json` 与 `archive/<year>.json`（各自带 `archiveVersion`
  头）。归档保留完整 mission、tasks、reviews、findings 与完成报告，state.json 只保留活跃任务，
  因此每次 mutation 不再重写全部历史；归档按 id 幂等，进程崩溃后可重试。`tower_status` 默认只列
  活跃任务，`includeArchived:true` 在活跃页后追加 `archived:true` 的压缩摘要（不含报告正文），
  `missionId` 详情会从 year 文件加载；归档损坏时降级为 `archive.unreadable` 诊断而不是抛错。
  `tower_doctor` 新增 `archive {missions,archivedMissions,stateBytes,archiveBytes,years,files,
  unreadable,policy}` 与 `archive` 检查。`tower_preflight`/`tower_merge` 对已归档 mission 保持原行为，
  新 mission 的编号也会避开归档 id。

- **#88 Unicode mission 标题**：`validateTitle` 改为接受可打印 Unicode（NFC 归一化、120 码点上限），
  显式拒绝 bidi override（U+202A–202E、U+2066–2069）与零宽字符（U+200B–200D、U+FEFF），控制/格式/
  代理码点单独报错；mission id 仍为 ASCII。CJK/西里尔/日韩/emoji 标题可完整往返 `tower_plan` →
  state → `tower_status` → `MISSIONS.md` → briefing，board 表格保持对齐。
### 变更

- **#89 completion report 上限**：`tower_complete.report` 新增 `gates.maxReportBytes`
  （默认 32768，按 **UTF-8 字节**而非字符计）硬上限；超限以 `invalid-argument` 拒绝并给出
  `nextAction`（把全文写进 mission worktree 的文件并引用路径），绝不截断。存储的完成报告新增
  `reportBytes`；`tower_status` 的分页摘要只返回大小，完整正文只在 `missionId` 详情中返回；
  `tower_doctor` 新增 `reports` 检查并报告仓库中最大的报告。旧 state 无需迁移：缺失
  `reportBytes` 时在读取时按 UTF-8 字节推导。

- **#90 scope 大小写**：`tower_init` 在检出目录上做一次性大小写探测并记录 `caseInsensitive`
  （探测失败记录 `null`，比较继续使用安全的 case-sensitive 默认值）；`tower_doctor` 报告
  `caseInsensitive` 与生效的 `comparisonMode`。在大小写不敏感的文件系统上，`fileInScope` 与
  `scopesOverlap` 折叠双方，因此 `src/Api/**` 与 `src/api/**` 视为重叠（plan 自动串行、扩 scope
  被拒绝），仅大小写不同的改动不再被 out-of-scope 门禁拒绝；在大小写敏感的检出上仍拒绝，但 blocker
  detail 会指出折叠大小写后本可匹配的 scope 条目。存储的 scope 文本保持原样。state schema 升到 3，
  v2 → v3 迁移回填 `caseInsensitive: null`。

- **#86 平台矩阵 CI**：`test` job 改为显式 include 矩阵——ubuntu Node 22/24 与 Windows Node 22
  （`test (22)`/`test (24)`/`test (22, windows)`），required context 名称不变；`win32Lower`/`isInside`、
  `shellSpec`、`renameWithRetry`、`unlinkWithRetry`、worktree `compareKey` 均改为可注入 seam，并在任意
  OS 上断言两条分支。Windows leg 已加入 `main` 的 required checks。

- **#91 Windows 测试确定性**：新增 `tests/helpers/cleanup.mjs`（有界重试 + 隔离 rename + `os.tmpdir()`
  守卫），37 个测试文件、106 处直接 `rmSync` 全部迁移；导入时把 Windows CI 的 8.3 短路径 TEMP
  规范化，消除短/长路径比较失败；Windows 全量套件连续 5 次全绿。
## 2.1.0-beta.1（2026-10-22）

**预发布**：本版本发布到 npm 的 `next` dist-tag，`latest` 继续保持 `2.0.4`，直到出现稳定版本。
从 2.0.4 直接跳到 2.1.0-beta.1，是为了让 #94 的交付闸门（mount smoke、发布闸门、证据约定）有一个
可验证的预发布载体；从 2.0.4 升级不需要改动配置。

### 新增

- **#95 mount smoke**：新增 `npm run smoke:mount`——打包本包、把 `scripts/mount-smoke/host.json` 中
  唯一 pin 的 host 装进一次性目录、创建一次性 `DSH_HOME` 与 profile、用真实 loader 启动，并断言
  **加载后的真实 surface**（29 个 `tower_*` 工具 id、3 个 skill、2 个 preset、`/tower` 命令，以及恰好
  一个顶层 `tower-bundle` 行，#66 不变量）；CI 增加 `mount` job（Node 22，5 分钟预算），
  `tests/mount-smoke.test.mjs` 锁定 oracle，并保持 host pin 等于 `COMPATIBILITY.md` 最新行。
- **#95 覆盖率可见化**：CI 每次 push 运行 `npm run test:coverage` 并输出覆盖率表（只接线：无阈值、
  无 baseline、无徽章）；`CONTRIBUTING.md` 写明 CI 能证明什么、不能证明什么。
- **#97 发布闸门**：新增 `npm run release:check`（`scripts/release-check.mjs`）。每次运行都打印上一个
  tag、`git describe`、自该 tag 起的提交数与 Unreleased 是否有内容；PR/分支 push 只警告（exit 0），
  tag push 在版本没有前进、tag 不是 `v<version>`、或 CHANGELOG 没有该版本内容时失败（exit 1）。
  CI 在每次 push 与 tag push 上运行它。
- **#97 发布清单**：`docs/guide/release.md` 把发布收敛为六步（版本 → CHANGELOG → COMPATIBILITY →
  `npm publish --tag next` → 注释 tag → `gh release create`），含里程碑 P0/P1 规则、CHANGELOG 段落的
  bash/PowerShell 提取命令，以及 `--verify-tag`、`--prerelease --latest=false` 与“先发布后打 tag”的
  原因。
- **#96 离线 issue 审计**：新增 `npm run audit:issues`（`scripts/issue-audit.mjs`），读取本地
  `tracker/issues.json` 导出，检查已关闭 P0/P1 的 `verified-by:`/`commit:` 两行契约，全程不访问
  GitHub；`--since` 只看约定日期之后的关闭，`tracker/` 是 gitignored 的本地快照。
- **#97 追踪看板**：新增 `docs/board.md`，把 owner 每周要问的三个问题写成可执行的 `gh` 命令，并记录
  标签/搜索语义（`--label P0,P1` 匹配单个字面标签，`--search 'label:P0,P1'` 才是 OR）。

### 变更

- **#96 受保护 `main` 与证据约定**：`main` 只能经 PR 合入（管理员同样受限），必需检查与“two-key
  路径 + 四行 PR body”写进 `CONTRIBUTING.md`；P0/P1 关闭必须带 `verified-by:` 与 `commit:` 两行。
  “某些路径允许直推”的例外被删除，因为 GitHub 的分支保护无法表达它——留一条服务器不会执行的规则
  比没有规则更糟。
- **#94/#97 追踪策略**：优先级只存在于 `P0`–`P3` 标签、领域在 `area/*`，issue 标题不再带 `[P*]`
  前缀；milestone 仍然只表示发布范围（一个 release 一个 milestone）。
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
- **#50 I/O 边界**：`node:fs` 仅保留在 `lib/adapters/store-fs.js`，`node:child_process` 仅保留在
  `lib/adapters/vcs-git.js`；其余 lib 模块经 adapter 导入，`package.json files` 补齐 adapters；
  新增架构回归锁定该不变量。
- **#50 依赖注入**：新增 `lib/adapters/default.js` 组合根；`Tower` 构造器接受
  `deps.store/vcs/clock/ids`，类内不再直接调用 git/store 模块；回归证明注入 adapter 生效。
- **#56 前置工作**：架构 fitness 规则按实际 `lib/adapters` 边界修正并全部升级为 error
  （domain-pure / child-process / fs / ambient-state / aggregate-size / tools-thin / tools-vocabulary），
  baseline 零违规；`docs/architecture/overview.md` 更新为实际分层、state/modes 契约和剩余差距。
- **#45 路线 A：TypeBox 单一 schema 源**：经调研 Schemastery 的 `toJSON()` 只序列化自身结构、不输出 JSON Schema，因此选用 TypeBox。29 个工具输入 schema 改为 `Type.Object(...)`；`define` 泛型从 schema 推导 `execute(args)` 类型；`tsc` 覆盖全部 tool 模块并加入 required/enum 负向 fixture。运行时注册前 JSON 化，wire schema 与迁移前逐项一致。
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
