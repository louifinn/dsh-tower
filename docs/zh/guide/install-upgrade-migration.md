# 安装、升级与迁移

[English](../../guide/install-upgrade-migration.md) | **简体中文**

## 环境要求

- DSH `0.2.1-rc.2`；每个版本实际验证过的 host 构建见 [COMPATIBILITY.md](../../../COMPATIBILITY.md)
- Node.js 22+
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

- **state schema v1 → v2（未发布）**：`state.json` 会自动迁移。升级后的第一次**写入**会保留
  `state.json.v1.bak` 备份、`revision` 只 +1，并向 `activity.jsonl` 追加 `state.migrated {from,to}`；
  只读工具仍可读取 v1 文件且不改写它。`tower_doctor` 报告磁盘上的版本与待执行的迁移。由更新插件
  写入的文件会以 `[tower:state-version-unsupported]` 拒绝，绝不会被重写或降级；迁移抛错会报
  `[tower:state-migration-failed]`，原文件保持字节不变。
- **state schema v2 → v3（未发布，#90）**：scope 匹配跟随检出目录所在文件系统的行为。迁移把
  `caseInsensitive` 回填为 `null`（“尚未探测”）；迁移不会读取文件系统，因此升级后的第一次
  `tower_init` 会探测一次并记录 `true`/`false`。在此之前使用安全的 `case-sensitive` 比较，
  `tower_doctor` 会把未知模式报告为 `warn`（`case-mode`）。在大小写不敏感的检出上，
  `src/Api/**` 与 `src/api/**` 从此视为重叠，仅大小写不同的改动不再被 out-of-scope 门禁拒绝。
  存储的 scope 文本永远不会被改写：看板仍显示操作者输入的原样。
- **2.3.0 → 2.4.0（未发布）**：所有能力合一的 `tower-bundle` 组行已移除。`cordis.patch.yml`
  现在随包提供强制的 `tower` host 锚点（Host 插件与 worker preset 是它的内部 section），以及可单独
  开关的顶层行：`tower-skills`、`tower-batch`、`tower-import`、`tower-leases`、`tower-tests`、
  `tower-hmr`（随包关闭）与 `preset-tower-reviewer`（受 `review.requireReview` 条件约束）。
  `tools` 配置组与 `dev.hotReload` 已删除：仍带这些键的 profile 现在会作为未知键被拒绝
  （`config-unknown-key`），在删除它们之前 host 不会挂载，因此不再存在静默无效的开关。请改为在插件页
  使用对应的组件行；`tower-hmr` 随包关闭，因此在为联动开发 profile 开启它之前，`tower_reload` 与
  `/tower reload` 会报告为 “disabled by component tower-hmr”。`tower_doctor` 与 `tower_recover`
  在任何配置下都会注册，无需配置键。仅当 `review.requireReview` 为 false 时 reviewer 行才可关闭；
  该门禁开启时，规划与模式进入会以带解释的错误拒绝该组合。不需要迁移 state。
- **2.0.4 → 2.1.0-beta.1**：不需要迁移 config；state 会按上述说明自动迁移（v1/v2 → v3）。
  这是发布到 `next` dist-tag 的**预发布**，
  `latest` 仍指向 2.0.4——请用 `dsh plugin --profile web add dsh-tower@next`（或精确版本号）安装。
  运行时行为未变；本版本承载的是交付闸门（CI 中的 mount smoke、`npm run release:check`、证据约定
  与追踪策略），而不是工具变化。本文档先于人工发布步骤合入：只有在[发布清单](release.md)执行
  `npm publish --tag next` 之后，`next` 才会解析到 2.1.0-beta.1；`latest` 在稳定版发布前保持 2.0.4。
- **2.0.3 → 2.0.4**：不需要迁移 state/config。本版本是安全加固与完整性修复（授权、merge SHA 绑定、
  dirty worktree 完成拒绝、stale lock 恢复、限制 test/git 进程环境、`tower_recover`、UI 0.2.2）。
  升级后请按威胁模型重新检查 `review.requireReview`、`tests.admission` 与 worker 工具权限。
- **2.0.1 → 2.0.3**：不需要迁移状态。2.0.3 起独立审查**默认可选**（`review.requireReview:false`）；
  若要保留旧的审查门禁行为，请显式设为 `true`。2.0.1 为 `tower_batch` 增加 `abandon`、允许 merged
  成员 close、让 doctor 跳过已 teardown 的 worktree，并修复终态 mission spawn/preflight 边界。
  可选 `ui-bundle` 0.2.1 增加常驻 Tower 模式 chip 与模式感知的 disabled 工具行。
- **1.x → 2.0（已发布）**：不需要迁移状态（`schemaVersion` 保持 1；新字段都是可选的）。需要留意的
  行为变化：Tower 模式激活期间，`mode.denyTools` 现在还会拒绝 `workflow`、`ralph`、`subagent`、
  `subagent_fork`、`wait_agent` 与 `team_task_list`（可用显式列表覆盖）；`spawn.maxLiveWorkers`
  默认为 4；`mode.workspaceLock` 代码默认关闭、随包 patch 开启。worker 不能再直接完成/放弃/扩大
  mission 的 scope——请使用 `tower_complete`。新工具：`tower_interrupt`，以及 HMR 可用时的
  `tower_reload`。升级后重启一次 DSH；见[热重载](hot-reload.md)。
- **1.3 → 1.4**：不需要迁移状态。新增：仓库级配置（`<git-common-dir>/dsh-tower/config.json`）、
  稳定的 `[tower:<code>]` 工具错误、`tower_findings`，以及 `id`/`missionId` 与 snake/camel 输入
  别名。既有调用保持可用；重启 DSH 以加载新工具面（`tower_findings` 与更新的 output schema）。
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
