# dsh-tower 中文文档

[English docs](../README.md) | **简体中文**

英文文档是权威来源；本页是中文翻译入口。英文文档位于 [docs/](../README.md)，仓库主页见
[README.md](../../README.md)。

## 2.1 能力概览

- **只读健康检查**：[Doctor](reference/doctor.md)（`tower_doctor`）检查 git、state、配置、preset、
  workspace 锁、roster、worktree 归属、测试策略与租约，不写任何状态。
- **测试发现与完成证据**：[测试、发现与证据](reference/testing.md)。仓库可在
  `package.json.tower.testDiscovery` 声明发现命令；回执可自动附加到 `tower_complete`，
  `gates.requireTests` 可要求针对当前 mission 分支 tip 的通过回执（与审查门禁独立）。
- **证据批次、咨询式租约、旧版导入**：[批次、租约与旧版导入](reference/operations.md)
  （`tower_batch`、`tower_resource`、`tower_import_legacy`、`tower_legacy_map`）。
- **workspace 锁与计划模式**：`mode.workspaceLock` 限制每个仓库同时只有一个 Tower 会话，
  `mode.workspaceLockScope:"mutations"` 对只读工具跳过锁；`mode.planModePolicy` 控制进入 Tower
  时如何处理活跃的 plan mode。
- **可观察性**：成功的工具调用发出进程内 [Tower 事件](reference/events.md)；稳定
  [工具错误码](reference/errors.md) 与 [blocker code](reference/blockers.md) 可被程序匹配。
- **工具面**：本构建最多 29 个工具（含可选的 `tower_control` 与 `tower_reload`）；详见
  [工具参考](reference/tools.md)。

## 选择阅读路径

| 你是 | 从这里开始 |
|---|---|
| 新用户 | [什么时候用 Tower](guide/scenarios-and-philosophy.md) → [快速开始](guide/quickstart.md) → [工具参考](reference/tools.md) → [第一个 mission 示例（英文）](../examples/first-mission.md) |
| 正在选择工作流 | [Tower 与 Agent Teams、Ralph、Workflow、普通并行子代理的区别](guide/scenarios-and-philosophy.md) |
| 运维 | [运维 runbook（英文）](../operations/runbook.md) → [blocker 与失败码](reference/blockers.md) → [错误码](reference/errors.md) → [事件](reference/events.md) → [Doctor](reference/doctor.md) → [测试](reference/testing.md) → [批次/租约/旧版](reference/operations.md) → [安全模型](operations/security.md) |
| 维护者 | [架构与状态机（英文）](../architecture/overview.md) → [配置参考](reference/config.md) → [热重载](guide/hot-reload.md) → [发布检查清单（英文）](../guide/release.md) → [看板查询（英文）](../board.md) → [贡献指南](../../CONTRIBUTING.md) |

参考页是当前发行版的权威说明；CI 中的 `npm run docs:check` 会校验文档与实现一致（包括中文页）。

## 全部中文页面

- [快速开始](guide/quickstart.md)
- [什么时候用 Tower，与 Agent Teams / Ralph / Workflow / 并行子代理的区别](guide/scenarios-and-philosophy.md)
- [安装、升级与迁移](guide/install-upgrade-migration.md)
- [热重载（开发）](guide/hot-reload.md)
- [工具参考](reference/tools.md)
- [配置参考](reference/config.md)
- [blocker 与失败码](reference/blockers.md)
- [工具错误码](reference/errors.md)
- [Tower 事件](reference/events.md)
- [测试、发现与证据](reference/testing.md)
- [批次、租约与旧版导入](reference/operations.md)
- [Doctor](reference/doctor.md)
- [FAQ](faq.md)
- [安全模型](operations/security.md)

以下页面目前只有英文版：[架构与状态机](../architecture/overview.md)、
[运维 runbook](../operations/runbook.md)、[示例：第一个 mission](../examples/first-mission.md)、
[发布检查清单](../guide/release.md)、[看板查询](../board.md)。

## 语言 / Language

- [English docs](../README.md)
- **中文文档**（本页）
- [仓库主页 README（中文）](../../README.md) · [English README](../../README.en.md)
