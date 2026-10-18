# dsh-tower

[![CI](https://github.com/louifinn/dsh-tower/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/louifinn/dsh-tower/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-tower.svg)](https://www.npmjs.com/package/dsh-tower)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[English](README.en.md)

**Tower** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的多代理编排插件。它把一个 agent 会话变成一个小型工程团队：会话本身是*控制塔*，worker agent 在隔离的 Git worktree 里实现任务，任何改动都必须经过独立审查和硬门禁才能合入基线分支。

Tower 模式与 mission/审查工作流的灵感来自 Moonshot AI 的 **Kimi Code** 中实验性的 Tower 模式（[Kimi Code](https://www.kimi.com/code)）。本项目是面向 DSH 的独立实现，与 Moonshot AI 无隶属关系；详见[致谢](#致谢)。

仓库根目录**就是** DSH bundle 包根：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 位于根目录，符合 DSH 插件规范。

## 特性

- **由人类掌握的 Tower 模式。** `/tower` 切换会话级模式：收窄工具面并注入 Tower 协议；`/tower on|off <指令>` 还能把指令作为下一步用户消息转发给模型。
- **任务级隔离。** 每个 mission 使用独立分支和 Git worktree，worker 不会碰到你的主检出。
- **审查门禁合并。** 审查者必须针对当前分支 tip 给出 `clean` / `merge` 结论；合并门禁重新校验 scope、分支新鲜度、任务完成度、审查记录与 worktree 归属，通过后才执行 `--no-ff` 合并。
- **可恢复的协作状态。** roster、inbox、findings、reviews 与 mission 状态持久化在 `.git/dsh-tower/` 下，重启不会丢计划。
- **默认安全。** Tower 模式开启期间拒绝 `create_goal`、`update_goal(resume)`、`todo_write`、Team 任务板与 `spawn_teammate`；被暂停的 goal 不会被自动恢复。
- **可追溯的 finding 生命周期。** `tower_findings` 列表、读取并按 `open → triaged → fixed` / `wontfix` 流转，也可重新打开；只有 tower 或 worker 能改状态，reviewer 只能读。
- **仓库级配置。** 每个仓库可用 `<git-common-dir>/dsh-tower/config.json` 覆盖 review/merge/worktree/spawn 策略，工具参数再覆盖仓库配置；无需为不同仓库改 profile。
- **稳定错误码。** 工具失败统一带 `[tower:<code>]` 前缀（如 `mission-not-found`、`preset-missing`、`config-invalid`），调用方可稳定分支处理。

## 环境要求

- DeepSeek Harness `0.2.1-rc.2`（或兼容的新版本）
- Node.js 22+
- Git（worktree 在本地创建，不需要联网）

## 安装

把已发布的包安装到 DSH profile：

```bash
dsh plugin --profile web add dsh-tower
```

在 DSH 中也可以用插件管理器指定同一目标：

```text
plugin_manager({ action: "install_bundle", target: "dsh-tower" })
```

开发时改为从 GitHub 安装或链接本地 checkout：

```bash
dsh plugin --profile web add github:louifinn/dsh-tower
dsh plugin --profile <profile> add <本仓库的绝对路径>
```

Host 插件在 DSH 进程启动时加载，**安装或更新后需重启 DSH**。卸载使用 `remove_bundle`，包名 `dsh-tower`。

## 快速开始

```text
/tower on

tower_init      repoRoot=D:\work\repo            # 首次初始化，记录 base（默认当前分支）
tower_plan      repoRoot=D:\work\repo missions=[{"title":"Feature A","scope":["src/a/**"],"tasks":["implement","commit"],"kind":"build"}]
tower_spawn     repoRoot=D:\work\repo missionId=M1 role=worker
# worker 在 worktree 内实现并提交，调用 tower_complete；最终报告会返回本会话
tower_spawn     repoRoot=D:\work\repo missionId=M1 role=reviewer
# reviewer 只读审查并调用 tower_review（clean+merge 或 p1-Nitems/p2-Nitems）
tower_preflight repoRoot=D:\work\repo missionId=M1    # 审查前 预期 no-review；审查后应为 ok:true
tower_merge     repoRoot=D:\work\repo missionId=M1
tower_teardown  repoRoot=D:\work\repo

/tower off
```

小改动通常一轮 worker + 一轮 reviewer 即可完成。完整可复制示例见 [docs/examples/first-mission.md](docs/examples/first-mission.md)，逐工具参数见 [docs/reference/tools.md](docs/reference/tools.md)。

## 命令

| 输入 | 行为 |
|---|---|
| `/tower` | 开启 Tower 模式（已开启则保持） |
| `/tower on` | 开启或保持 |
| `/tower on <指令>` | 开启/保持，并把 `<指令>` 作为下一条用户消息转发 |
| `/tower off` | 退出 Tower 模式 |
| `/tower off <指令>` | 退出并转发 `<指令>` |
| `/tower <指令>` | 确保开启，然后转发 `<指令>` |

图片与文件附件会随指令一起作为一条完整的 `UserMessage` 转发。

## 配置

```yaml
- id: tower
  name: 'dsh-tower'
  config:
    section: '（可选，兼容别名）覆盖 Tower 模式系统提示文案'
    allowAgentControl: true   # 兼容别名；等价于 mode.allowAgentControl
    mode:
      allowAgentControl: true
      autoPauseGoal: true
      denyTools: [create_goal, todo_write, team_task_create, team_task_update, team_task_reopen, spawn_teammate]
    review:
      maxRoundsPerReviewer: 5
    merge:
      timeoutMs: 900000
    worktrees:
      root: ''                 # 空 = <主检出父目录>/.dsh-tower-worktrees/<hash>
    spawn:
      workerPreset: tower-worker
      reviewerPreset: tower-reviewer
      maxDepth: 1
```

- 代码中 `mode.allowAgentControl` 默认 `false`；随包 `cordis.patch.yml` 设为 `true`：模型可在用户意图/任务状态明确时自行进出，但必须给出理由；设为 `false` 时只有人类能切换。
- 仓库级配置：在 `<git-common-dir>/dsh-tower/config.json`（通常是 `.git/dsh-tower/config.json`）放入同样的 JSON 结构，可覆盖 `review`/`merge`/`worktrees`/`spawn`；优先级为代码默认 < profile < 仓库配置 < 工具参数。`mode.*` 属于会话级，只在 profile 生效。
- 所有键与默认值见 [docs/reference/config.md](docs/reference/config.md)；未知顶层键会被拒绝（防止拼写错误静默失效），嵌套分组内的未知键会被忽略。工具错误码见 [docs/reference/errors.md](docs/reference/errors.md)。

## 工具（19 个）

`tower_init` · `tower_plan` · `tower_mission` · `tower_status` · `tower_spawn` · `tower_roster` · `tower_adopt` · `tower_diff` · `tower_send` · `tower_inbox` · `tower_complete` · `tower_finding` · `tower_findings` · `tower_review` · `tower_preflight` · `tower_merge` · `tower_rebase` · `tower_teardown` · `tower_mode`

`tower_control` 仅在 `allowAgentControl: true` 时存在（随包 patch 默认开启，因此安装后共 20 个工具）。mission 级工具同时接受 `id` 作为 `missionId` 的别名；`task_done`/`taskDone` 等 snake/camel 写法均可。

## 安全与约束

- **门禁不全绿不合并。** `tower_preflight` 是只读检查，返回稳定的 blocker code；存在 blocker 时 `tower_merge` 拒绝合并。
- **审查绑定提交。** 审查后分支 tip 变化会报 `tip-moved`，必须重新审查；reviewer 使用只读 preset，若在审查期间改动分支，提交审查会被拒绝。
- **scope 强制。** mission 只能修改其 scope glob 匹配的文件，越界会以 `out-of-scope` 阻止合并。
- **worktree 归属。** 脏工作树、运行中的 worker、已关闭 mission 的分支都会阻止合并或 teardown。
- **goal 隔离。** 进入 Tower 模式会暂停活跃 goal 并记录；退出不会自动恢复，需要你自行恢复。

24 个稳定 blocker/failure code（含 gate 守卫与 merge/rebase 操作失败码）——完整清单、触发条件与修复动作见 [docs/reference/blockers.md](docs/reference/blockers.md)。工具本身抛出的错误码见 [docs/reference/errors.md](docs/reference/errors.md)。

## 工作原理

mission 生命周期：`planned → active → completed → merged`（或 `blocked` / `paused` / `abandoned`）。状态位置：

| 路径 | 内容 |
|---|---|
| `.git/dsh-tower/state.json` | missions、roster、reviews、findings、inbox |
| `.git/dsh-tower/activity.jsonl` | 只追加的活动日志 |
| `<主检出父目录>/.dsh-tower-worktrees/<hash>/<missionId>` | 每个 mission 的 worktree |
| `$DSH_HOME/tower-mode/modes.json` | 每个 agent/session 的 Tower 模式状态 |

worker 与 reviewer 是使用内置 `tower-worker` preset 的普通 DSH 子代理；它们的工具被限制在 mission 允许面（文件系统、shell、Tower 协议工具），不包含 merge/spawn。

## 项目结构

| 路径 | 内容 |
|---|---|
| `package.json`、`cordis.patch.yml` | bundle 清单与 loader patch（插入 Host 插件和 `tower-worker` preset） |
| `index.js`、`lib/`、`worker.js` | Host 入口、协议实现、worker preset 策略 |
| `locale/`、`icon.svg` | 本地化与图标 |
| `tests/` | 纯函数、协议 e2e、插件级测试；可选的真实 Web 运行时脚本 |
| `ui-bundle/` | 可选 Client 小挂件（静态 `/tower` 提示），默认不安装 |
| `.github/workflows/test.yml` | CI：Node 22/24 上跑离线套件 |

## 开发与测试

```bash
npm test        # node --test tests/*.test.mjs
```

离线套件不需要 DSH 进程，只在系统临时目录创建一次性 Git 仓库。隔离 Web 运行时检查、模型驱动验收和会话诊断脚本见 `tests/README.md`。

## 文档

- [docs/README.md](docs/README.md) — 文档索引（新用户 / 运维 / 维护者三条阅读路径）
- [中文文档](docs/zh/README.md) · [快速开始](docs/guide/quickstart.md) · [安装、升级与迁移](docs/guide/install-upgrade-migration.md)
- [工具参考](docs/reference/tools.md) · [配置参考](docs/reference/config.md) · [blocker 与失败码](docs/reference/blockers.md) · [错误码](docs/reference/errors.md)
- [架构与状态机](docs/architecture/overview.md) · [运维 runbook](docs/operations/runbook.md) · [安全模型](docs/operations/security.md)
- [FAQ](docs/faq.md) · [示例](docs/examples/first-mission.md)

## 常见问题

- **安装/更新后插件不出现。** Host 插件在 DSH 启动时加载，请重启 DSH；并确认安装目标指向本仓库根目录（含 `package.json` 与 `cordis.patch.yml` 的那一层），而不是子目录。
- **没有 `tower_control`。** 配置 `allowAgentControl` 为 `false`；改为 `true` 并重启。
- **合并被阻止。** 运行 `tower_preflight` 查看 blocker code；`stale-base` 表示先执行 `tower_rebase`。
- **基线前进后分支过期。** `tower_rebase` 在 worktree 内完成 rebase；干净且无冲突的 rebase 可免去上一轮审查的重审。
- **合并提交已经存在，但 `tower_merge` 报了失败。** 重新执行 `tower_merge` 即可：它会检测已落地的合并提交（或分支已包含在 base 中）并记录为 reconciled，不会重复合并。
- **仓库的 `pre-merge-commit` 钩子很慢。** 合并超时默认 15 分钟，可按次通过 `tower_merge({ ..., timeoutMs: 900000 })` 调大；钩子输出缓冲上限 64 MB。钩子失败返回 `merge-hook-failed`（超时带 `timeout: true`），并保持仓库干净以便重试。

## 贡献

欢迎 issue 与 pull request。提交 PR 前请先运行 `npm test`，细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全相关问题请不要在公开 issue 里贴利用细节，先开一个最小化 issue 申请私下渠道。

## 致谢

- **Kimi Code（Moonshot AI）**：Tower 模式的整体概念——由人类开启的模式、每个 mission 独立 Git worktree、审查门禁合并协议——灵感来自 Kimi Code 的实验性 Tower 模式（[官网](https://www.kimi.com/code)、[源码](https://github.com/MoonshotAI/kimi-code)）。本项目在 DeepSeek Harness 的服务之上重新实现这些想法，不包含 Kimi Code 源码，也与 Moonshot AI 无隶属关系。
- **DeepSeek Harness**：本插件构建所依赖的插件、工具、会话与子代理 API。

## License

MIT © Loui Finn

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
