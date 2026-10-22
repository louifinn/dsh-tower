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

- **2.0.4 → 2.1.0-beta.1**：不需要迁移 state/config。这是发布到 `next` dist-tag 的**预发布**，
  `latest` 仍指向 2.0.4——请用 `dsh plugin --profile web add dsh-tower@next`（或精确版本号）安装。
  运行时行为未变；本版本承载的是交付闸门（CI 中的 mount smoke、`npm run release:check`、证据约定
  与追踪策略），而不是工具变化。
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
